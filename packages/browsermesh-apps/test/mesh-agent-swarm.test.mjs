// Run with: node --import ./test/_setup-globals.mjs --test test/mesh-agent-swarm.test.mjs
//
// AgentSwarmCoordinator's own local bookkeeping (createSwarm/decompose/
// assign strategies, collectResults merging) is already covered by
// peer-agent-swarm.test.mjs against a mock agentProxy that always resolves
// locally. This file covers the MeshService WRAPPER issue #124 adds: the
// real 'agent-swarm-request'/'agent-swarm-response' wire protocol that gives
// executeSubTask() an actual cross-peer dispatch path when `assignee` is a
// REMOTE peer, local-only execution (no network round-trip) when `assignee`
// is this node itself, checkAccess()-gated inbound authorization, the
// required agentProxy, ctx.emit() event bridging, and
// createMeshNode({ enableAgentSwarm: true }) opt-in wiring.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createAgentSwarmService } from '../src/mesh-agent-swarm.mjs';
import { attachService } from '../src/mesh-service.mjs';
import { PeerRegistry } from '../src/peer-registry.mjs';
import { createMeshNode } from '../src/mesh-bootstrap.mjs';
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core';

// ── Fixtures ─────────────────────────────────────────────────────────
// Mirrors mesh-compute.test.mjs's own: real Ed25519 IdentityWallet/
// MeshIdentityManager identities + real PeerRegistry (wired to real
// MeshACL/MeshPeerManager/TrustGraph from @johnhenry/browsermesh-core),
// connected via a duck-typed in-memory sendTo()/onIncomingData()/listPeers()
// bus.

async function createAgentSwarmTestPeer(label) {
  const identityManager = new MeshIdentityManager({});
  const wallet = new IdentityWallet({ identityManager });
  const { podId } = await wallet.createIdentity(label);
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId }),
  });
  return { podId, wallet, registry };
}

/**
 * A fully-connected duck-typed multi-peer bus (every peer directly reaches
 * every other peer), matching mesh-compute.test.mjs's own wireFullMesh.
 */
function wireFullMesh(peers) {
  const listenersByPodId = new Map(peers.map((p) => [p.podId, new Set()]));
  const nodesByPodId = {};
  for (const peer of peers) {
    nodesByPodId[peer.podId] = {
      podId: peer.podId,
      wallet: peer.wallet,
      registry: peer.registry,
      onIncomingData(cb) {
        const set = listenersByPodId.get(peer.podId);
        set.add(cb);
        return () => set.delete(cb);
      },
      async sendTo(pubKey, data) {
        const set = listenersByPodId.get(pubKey);
        if (!set) return;
        queueMicrotask(() => {
          for (const cb of set) cb(peer.podId, data);
        });
      },
      listPeers(filter) {
        return peers
          .filter((p) => p.podId !== peer.podId)
          .filter((p) => !filter?.status || filter.status === 'connected')
          .map((p) => ({ fingerprint: p.podId, status: 'connected' }));
      },
    };
  }
  return nodesByPodId;
}

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs = 1000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
}

/** A minimal agentProxy that records every chat() call and echoes a result. */
function createMockAgentProxy(who) {
  const calls = [];
  return {
    calls,
    async chat(podId, message) {
      calls.push({ podId, message });
      return `${who}: ${message}`;
    },
  };
}

// -----------------------------------------------------------------------
// Real cross-peer dispatch: a swarm created and decomposed on one node,
// subtasks assigned across THREE real peers (proving genuine distribution,
// not a 2-peer degenerate case), executeSubTask() actually reaching each
// remote peer and getting a real result back.
// -----------------------------------------------------------------------

describe('createAgentSwarmService: a real swarm over real wire request/response', () => {
  it('decomposes a goal, assigns subtasks round-robin across 3 real peers, and executeSubTask() gets a real remote result for each', async () => {
    const alice = await createAgentSwarmTestPeer('alice'); // coordinator/leader
    const bob = await createAgentSwarmTestPeer('bob'); // worker
    const carol = await createAgentSwarmTestPeer('carol'); // worker
    const dave = await createAgentSwarmTestPeer('dave'); // worker
    const mesh = wireFullMesh([alice, bob, carol, dave]);
    const {
      [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC, [dave.podId]: nodeD,
    } = mesh;

    // Each worker authorizes alice to dispatch agent-swarm work to it.
    for (const workerNode of [nodeB, nodeC, nodeD]) {
      workerNode.registry.grantCapabilities(alice.podId, ['agent-swarm:execute']);
    }

    const bobProxy = createMockAgentProxy('bob');
    const carolProxy = createMockAgentProxy('carol');
    const daveProxy = createMockAgentProxy('dave');
    attachService(nodeB, undefined, createAgentSwarmService({ agentProxy: bobProxy }));
    attachService(nodeC, undefined, createAgentSwarmService({ agentProxy: carolProxy }));
    attachService(nodeD, undefined, createAgentSwarmService({ agentProxy: daveProxy }));

    const aliceProxy = createMockAgentProxy('alice');
    const events = [];
    const { api: aliceApi, on: aliceOn } = attachService(nodeA, undefined, createAgentSwarmService({ agentProxy: aliceProxy }));
    for (const event of ['created', 'task-assigned', 'subtask-complete', 'completed']) {
      aliceOn(`agent-swarm:${event}`, (data) => events.push({ type: event, data }));
    }

    const swarm = await aliceApi.createSwarm('build a widget', {
      members: [bob.podId, carol.podId, dave.podId],
      strategy: 'round_robin',
    });
    assert.equal(events.filter((e) => e.type === 'created').length, 1);

    await aliceApi.decompose(swarm.id, async (goal) => [
      `${goal} — part 1`,
      `${goal} — part 2`,
      `${goal} — part 3`,
    ]);
    const assignments = await aliceApi.assign(swarm.id);
    assert.equal(assignments.length, 3);
    assert.deepEqual(new Set(assignments.map((a) => a.assignee)), new Set([bob.podId, carol.podId, dave.podId]));
    assert.equal(events.filter((e) => e.type === 'task-assigned').length, 3);

    const results = [];
    for (const { subtaskId, assignee } of assignments) {
      const outcome = await aliceApi.executeSubTask(swarm.id, subtaskId, assignee);
      results.push(outcome);
    }

    // Real execution happened on all 3 remote workers, not a stub.
    assert.equal(bobProxy.calls.length, 1);
    assert.equal(carolProxy.calls.length, 1);
    assert.equal(daveProxy.calls.length, 1);
    assert.equal(aliceProxy.calls.length, 0, 'alice never ran her own local agentProxy — every subtask was remote');
    for (const outcome of results) {
      assert.equal(outcome.success, true);
      assert.equal(typeof outcome.result, 'string');
    }
    // Each remote worker's real agentProxy.chat() was called with its OWN
    // podId (the receiving node's own identity), matching the local-
    // self-assignment convention exactly.
    assert.equal(bobProxy.calls[0].podId, bob.podId);
    assert.equal(carolProxy.calls[0].podId, carol.podId);
    assert.equal(daveProxy.calls[0].podId, dave.podId);

    await aliceApi.collectResults(swarm.id, (individual) => individual.join(' | '));
    assert.equal(events.filter((e) => e.type === 'completed').length, 1);
    assert.equal(events.filter((e) => e.type === 'subtask-complete').length, 3);
  });

  it('a self-assigned subtask executes locally, with no network round-trip', async () => {
    const alice = await createAgentSwarmTestPeer('alice');
    const bob = await createAgentSwarmTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    // No capability granted from alice to herself, and no sendTo() call
    // should ever be needed for a self-assigned subtask -- prove it by
    // making nodeA.sendTo() throw if it's ever invoked.
    nodeA.sendTo = async () => {
      throw new Error('sendTo() must never be called for a self-assigned subtask');
    };

    const aliceProxy = createMockAgentProxy('alice');
    const { api: aliceApi } = attachService(nodeA, undefined, createAgentSwarmService({ agentProxy: aliceProxy }));

    const swarm = await aliceApi.createSwarm('self-serve goal', {
      members: [alice.podId],
      strategy: 'round_robin',
    });
    await aliceApi.decompose(swarm.id, async () => ['do it myself']);
    const [assignment] = await aliceApi.assign(swarm.id);
    assert.equal(assignment.assignee, alice.podId);

    const outcome = await aliceApi.executeSubTask(swarm.id, assignment.subtaskId, assignment.assignee);
    assert.equal(outcome.success, true);
    assert.equal(aliceProxy.calls.length, 1);
    assert.equal(aliceProxy.calls[0].podId, alice.podId);
    assert.equal(aliceProxy.calls[0].message, 'do it myself');

    // bob was never involved at all.
    void nodeB;
  });
});

// -----------------------------------------------------------------------
// Authorization: checkAccess() gates who may act as a peer-initiated
// 'agent-swarm-request' before agentProxy.chat() ever runs
// -----------------------------------------------------------------------

describe('createAgentSwarmService: inbound agent-swarm-request authorization', () => {
  it('rejects an unauthorized dispatcher without ever calling agentProxy.chat()', async () => {
    const alice = await createAgentSwarmTestPeer('alice');
    const bob = await createAgentSwarmTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    // Deliberately NOT granting bob.registry.grantCapabilities(alice.podId, ...).

    const bobProxy = createMockAgentProxy('bob');
    const deniedEvents = [];
    const { on: bobOn } = attachService(nodeB, undefined, createAgentSwarmService({ agentProxy: bobProxy }));
    bobOn('agent-swarm:execute-request-denied', (data) => deniedEvents.push(data));

    const aliceProxy = createMockAgentProxy('alice');
    const { api: aliceApi } = attachService(nodeA, undefined, createAgentSwarmService({
      agentProxy: aliceProxy,
      dispatchTimeoutMs: 500,
    }));

    const swarm = await aliceApi.createSwarm('goal', { members: [bob.podId] });
    await aliceApi.decompose(swarm.id, async () => ['task 1']);
    const [assignment] = await aliceApi.assign(swarm.id);

    const outcome = await aliceApi.executeSubTask(swarm.id, assignment.subtaskId, assignment.assignee);
    assert.equal(outcome.success, false, 'an unauthorized dispatcher never gets a real result');
    assert.equal(bobProxy.calls.length, 0, 'agentProxy.chat() must never run for an unauthorized dispatcher');
    await waitFor(() => deniedEvents.length > 0, 1000, 'execute-request-denied to fire on the responder side');
    assert.equal(deniedEvents[0].reason, 'access_denied');
    assert.equal(deniedEvents[0].from, alice.podId);
  });

  it('a served, authorized request emits execute-served with ok:true', async () => {
    const alice = await createAgentSwarmTestPeer('alice');
    const bob = await createAgentSwarmTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    nodeB.registry.grantCapabilities(alice.podId, ['agent-swarm:execute']);

    const bobProxy = createMockAgentProxy('bob');
    const servedEvents = [];
    const { on: bobOn } = attachService(nodeB, undefined, createAgentSwarmService({ agentProxy: bobProxy }));
    bobOn('agent-swarm:execute-served', (data) => servedEvents.push(data));

    const aliceProxy = createMockAgentProxy('alice');
    const { api: aliceApi } = attachService(nodeA, undefined, createAgentSwarmService({ agentProxy: aliceProxy }));

    const swarm = await aliceApi.createSwarm('goal', { members: [bob.podId] });
    await aliceApi.decompose(swarm.id, async () => ['task 1']);
    const [assignment] = await aliceApi.assign(swarm.id);

    const outcome = await aliceApi.executeSubTask(swarm.id, assignment.subtaskId, assignment.assignee);
    assert.equal(outcome.success, true);

    await waitFor(() => servedEvents.length > 0, 1000, 'execute-served to fire');
    assert.equal(servedEvents[0].ok, true);
    assert.equal(servedEvents[0].from, alice.podId);
  });
});

// -----------------------------------------------------------------------
// createAgentSwarmService() construction — agentProxy is unconditionally
// required
// -----------------------------------------------------------------------

describe('createAgentSwarmService: required agentProxy', () => {
  it('throws immediately when constructed without agentProxy', () => {
    assert.throws(() => createAgentSwarmService({}), /agentProxy is required/);
    assert.throws(() => createAgentSwarmService(), /agentProxy is required/);
  });
});

// -----------------------------------------------------------------------
// teardown()
// -----------------------------------------------------------------------

describe('createAgentSwarmService: teardown', () => {
  it('rejects any still-in-flight remote dispatches and stops further event delivery', async () => {
    const alice = await createAgentSwarmTestPeer('alice');
    const bob = await createAgentSwarmTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    nodeB.registry.grantCapabilities(alice.podId, ['agent-swarm:execute']);

    // bob's agentProxy never resolves -- alice's dispatch stays pending.
    attachService(nodeB, undefined, createAgentSwarmService({ agentProxy: { chat: () => new Promise(() => {}) } }));

    const events = [];
    const {
      api: aliceApi, on: aliceOn, teardown,
    } = attachService(nodeA, undefined, createAgentSwarmService({
      agentProxy: createMockAgentProxy('alice'),
      dispatchTimeoutMs: 50,
    }));
    aliceOn('agent-swarm:subtask-complete', (data) => events.push(data));

    const swarm = await aliceApi.createSwarm('goal', { members: [bob.podId] });
    await aliceApi.decompose(swarm.id, async () => ['task 1']);
    const [assignment] = await aliceApi.assign(swarm.id);

    const pending = aliceApi.executeSubTask(swarm.id, assignment.subtaskId, assignment.assignee);
    await new Promise((r) => setTimeout(r, 5));
    await teardown();

    const outcome = await pending;
    assert.equal(outcome.success, false, 'executeSubTask() resolves to a failed outcome once its only in-flight dispatch is torn down');

    // Event bus closed by teardown() -- nothing further reaches on().
    assert.equal(events.length, 0);
  });
});

// -----------------------------------------------------------------------
// createMeshNode({ enableAgentSwarm: true }) -- opt-in surface (issue #124)
// -----------------------------------------------------------------------

function createStubSignalingTransport() {
  return { send() {}, onMessage() {} };
}

describe('createMeshNode({ enableAgentSwarm: true })', () => {
  it('leaves node.agentSwarm unset and node.services empty of "agent-swarm" when enableAgentSwarm is omitted', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
    });

    assert.equal(node.agentSwarm, undefined);
    assert.equal(node.services.has('agent-swarm'), false);
  });

  it('throws clearly when enableAgentSwarm is set without agentSwarmOptions.agentProxy', async () => {
    await assert.rejects(
      () => createMeshNode({
        label: 'alice',
        signalingTransport: createStubSignalingTransport(),
        enableAgentSwarm: true,
        skipBoot: true,
      }),
      /agentSwarmOptions\.agentProxy is required/,
    );
  });

  it('attaches node.agentSwarm (== node.services.get("agent-swarm")) when enableAgentSwarm is set with agentProxy', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableAgentSwarm: true,
      agentSwarmOptions: {
        agentProxy: createMockAgentProxy('alice'),
      },
      skipBoot: true,
    });

    assert.ok(node.agentSwarm, 'node.agentSwarm is attached');
    assert.equal(node.agentSwarm, node.services.get('agent-swarm'));
    assert.equal(typeof node.agentSwarm.api.createSwarm, 'function');
    assert.equal(typeof node.agentSwarm.api.decompose, 'function');
    assert.equal(typeof node.agentSwarm.api.assign, 'function');
    assert.equal(typeof node.agentSwarm.api.executeSubTask, 'function');
    assert.equal(typeof node.agentSwarm.api.collectResults, 'function');
    assert.equal(typeof node.agentSwarm.api.getSwarm, 'function');
    assert.equal(typeof node.agentSwarm.api.listSwarms, 'function');
    assert.equal(typeof node.agentSwarm.api.disbandSwarm, 'function');
  });
});
