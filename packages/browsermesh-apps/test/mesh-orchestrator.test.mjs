// Run with: node --import ./test/_setup-globals.mjs --test test/mesh-orchestrator.test.mjs
//
// MeshOrchestrator's own local bookkeeping (PodInfo/PodStatus/
// PodResourceInfo construction, ResourceScorer-driven compute target
// selection, the eight Meshctl*Tool BrowserTool subclasses) is already
// covered by orchestrator.test.mjs against a hand-rolled peerNode mock. This
// file covers the MeshService WRAPPER Phase 3 of the agent-runtime plan
// (issue #92) adds: constructing a real MeshOrchestrator against a real
// PeerNode-shaped node, the real 'orchestrator-request'/'orchestrator-response'
// wire protocol for execOnPod/deploySkill/drainPod, checkAccess()-gated
// authorization for those three, the local-target shortcut (no network
// round-trip when the target is the caller's own pod), listPods/getPodStatus/
// topPods staying local-only and ungated, the raw MeshOrchestrator instance
// exposed via api.orchestrator, and createMeshNode({ enableOrchestrator: true })
// opt-in wiring (including router auto-wiring from enableRouting).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createOrchestratorService } from '../src/mesh-orchestrator.mjs';
import { MeshOrchestrator } from '../src/orchestrator.mjs';
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
// Mirrors mesh-agent-swarm.test.mjs's/mesh-compute.test.mjs's own: real
// Ed25519 IdentityWallet/MeshIdentityManager identities + real PeerRegistry
// (wired to real MeshACL/MeshPeerManager/TrustGraph from
// @johnhenry/browsermesh-core), connected via a duck-typed in-memory
// sendTo()/onIncomingData()/listPeers() bus.

async function createOrchestratorTestPeer(label) {
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
 * every other peer), matching mesh-agent-swarm.test.mjs's own wireFullMesh.
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

// -----------------------------------------------------------------------
// listPods()/getPodStatus()/topPods() against a real multi-peer mesh --
// local-only aggregation, no wire protocol, no gate.
// -----------------------------------------------------------------------

describe('createOrchestratorService: local-only queries against a real multi-peer mesh', () => {
  it('listPods()/getPodStatus()/topPods() reflect peers registered via addPeer() on 3 real nodes', async () => {
    const alice = await createOrchestratorTestPeer('alice');
    const bob = await createOrchestratorTestPeer('bob');
    const carol = await createOrchestratorTestPeer('carol');
    const mesh = wireFullMesh([alice, bob, carol]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC } = mesh;

    const { api: aliceApi } = attachService(nodeA, undefined, createOrchestratorService());
    attachService(nodeB, undefined, createOrchestratorService());
    attachService(nodeC, undefined, createOrchestratorService());

    // MeshOrchestrator has no automatic peer-discovery from mesh connections
    // (see orchestrator.mjs's own "Peer management (used by the mesh layer
    // to keep state in sync)" section) -- a real caller keeps it in sync via
    // addPeer()/removePeer() as connections come and go. Exercised directly
    // against the raw instance via api.orchestrator, exactly how a later
    // phase's mesh-connection-event wiring would call it.
    aliceApi.orchestrator.addPeer(bob.podId, { label: 'bob', status: 'online', services: ['web'], connections: 1 });
    aliceApi.orchestrator.addPeer(carol.podId, { label: 'carol', status: 'online', resources: { cpu: 4, memory: 2048, storage: 4096 } });

    const pods = await aliceApi.listPods();
    assert.equal(pods.length, 3);
    const byId = Object.fromEntries(pods.map((p) => [p.podId, p]));
    assert.equal(byId[alice.podId].isLocal, true);
    assert.equal(byId[bob.podId].isLocal, false);
    assert.equal(byId[bob.podId].label, 'bob');
    assert.deepEqual(byId[bob.podId].services, ['web']);
    assert.equal(byId[carol.podId].isLocal, false);

    const bobStatus = await aliceApi.getPodStatus(bob.podId);
    assert.equal(bobStatus.podId, bob.podId);
    assert.equal(bobStatus.status, 'online');

    const missingStatus = await aliceApi.getPodStatus('nonexistent-pod');
    assert.equal(missingStatus, null);

    const { pods: topPods } = await aliceApi.topPods();
    assert.equal(topPods.length, 3);
    const carolTop = topPods.find((p) => p.podId === carol.podId);
    assert.equal(carolTop.cpu, 4);
    assert.equal(carolTop.memory, 2048);

    // Never touched the wire for any of this -- purely local aggregation.
    void nodeB;
    void nodeC;
  });
});

// -----------------------------------------------------------------------
// Real execOnPod()/deploySkill()/drainPod() request/response round-trip to
// a specific remote peer over the real wire protocol.
// -----------------------------------------------------------------------

describe('createOrchestratorService: real wire round-trip to a specific remote peer', () => {
  it('execOnPod() dispatches to a real remote peer and runs peerNode.exec() there', async () => {
    const alice = await createOrchestratorTestPeer('alice');
    const bob = await createOrchestratorTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    bob.registry.grantCapabilities(alice.podId, ['orchestrator:exec']);

    // bob's own peerNode-level exec() -- what execOnPod() calls locally once
    // it resolves podId === its own localPodId.
    const execCalls = [];
    nodeB.exec = async (command) => {
      execCalls.push(command);
      return { output: `ran: ${command}`, exitCode: 0 };
    };
    attachService(nodeB, undefined, createOrchestratorService());

    const { api: aliceApi } = attachService(nodeA, undefined, createOrchestratorService());

    const result = await aliceApi.execOnPod(bob.podId, 'echo hello');
    assert.deepEqual(execCalls, ['echo hello']);
    assert.equal(result.output, 'ran: echo hello');
    assert.equal(result.exitCode, 0);
  });

  it('drainPod() dispatches to a real remote peer and drains it there', async () => {
    const alice = await createOrchestratorTestPeer('alice');
    const bob = await createOrchestratorTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    bob.registry.grantCapabilities(alice.podId, ['orchestrator:drain']);

    const { api: bobApi } = attachService(nodeB, undefined, createOrchestratorService());
    const { api: aliceApi } = attachService(nodeA, undefined, createOrchestratorService());

    const result = await aliceApi.drainPod(bob.podId);
    assert.equal(result.success, true);
    assert.equal(result.migrated, 0);

    // bob's own orchestrator instance really transitioned into draining --
    // observable via its own (local, ungated) listPods().
    const bobPods = await bobApi.listPods();
    assert.equal(bobPods.find((p) => p.podId === bob.podId).status, 'draining');
  });

  it('deploySkill() dispatches to a real remote peer, which serves it via its own registered peer callback', async () => {
    const alice = await createOrchestratorTestPeer('alice');
    const carol = await createOrchestratorTestPeer('carol');
    const mesh = wireFullMesh([alice, carol]);
    const { [alice.podId]: nodeA, [carol.podId]: nodeC } = mesh;

    carol.registry.grantCapabilities(alice.podId, ['orchestrator:deploy']);

    // MeshOrchestrator.deploySkill() (orchestrator.mjs, reused as-is) has no
    // "deploy to myself" branch -- it only ever resolves a target via
    // #knownPeers/runtimeRegistry+remoteSessionBroker, exactly like a
    // coordinator dispatching to a peer it already has a channel to. This is
    // a genuine, pre-existing property of the dormant class, not something
    // introduced by this wire protocol -- see mesh-orchestrator.mjs's own
    // doc comment. So carol, upon receiving the authorized deploy request
    // for herself, must already have herself registered as a "known peer"
    // with a real deploySkill callback for MeshOrchestrator's own logic to
    // find and invoke -- exactly the same shape a real deployment (with
    // remoteSessionBroker/runtimeRegistry wired for local pods too) would
    // ultimately resolve through.
    const deployed = [];
    const { api: carolApi } = attachService(nodeC, undefined, createOrchestratorService());
    carolApi.orchestrator.addPeer(carol.podId, {
      deploySkill: async (content) => {
        deployed.push(content);
        return { success: true };
      },
    });

    const { api: aliceApi } = attachService(nodeA, undefined, createOrchestratorService());

    const result = await aliceApi.deploySkill(carol.podId, '# My Skill\nname: test');
    assert.equal(result.success, true);
    assert.deepEqual(deployed, ['# My Skill\nname: test']);
  });

  it('a self-targeted execOnPod()/drainPod() call stays local, with no network round-trip', async () => {
    const alice = await createOrchestratorTestPeer('alice');
    const bob = await createOrchestratorTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    nodeA.sendTo = async () => {
      throw new Error('sendTo() must never be called for a self-targeted orchestrator action');
    };
    nodeA.exec = async (command) => ({ output: `local: ${command}`, exitCode: 0 });

    const { api: aliceApi } = attachService(nodeA, undefined, createOrchestratorService());

    const execResult = await aliceApi.execOnPod(alice.podId, 'whoami');
    assert.equal(execResult.output, 'local: whoami');

    const drainResult = await aliceApi.drainPod(alice.podId);
    assert.equal(drainResult.success, true);

    void nodeB;
  });
});

// -----------------------------------------------------------------------
// Authorization: checkAccess() gates who may trigger a risky, peer-initiated
// 'orchestrator-request' before the underlying MeshOrchestrator method ever
// runs.
// -----------------------------------------------------------------------

describe('createOrchestratorService: inbound orchestrator-request authorization', () => {
  it('rejects an unauthorized peer\'s execOnPod request without ever calling peerNode.exec()', async () => {
    const alice = await createOrchestratorTestPeer('alice');
    const bob = await createOrchestratorTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    // Deliberately NOT granting bob.registry.grantCapabilities(alice.podId, ...).

    const execCalls = [];
    nodeB.exec = async (command) => {
      execCalls.push(command);
      return { output: 'should never run', exitCode: 0 };
    };
    const deniedEvents = [];
    const { on: bobOn } = attachService(nodeB, undefined, createOrchestratorService());
    bobOn('orchestrator:request-denied', (data) => deniedEvents.push(data));

    const { api: aliceApi } = attachService(nodeA, undefined, createOrchestratorService({ dispatchTimeoutMs: 500 }));

    await assert.rejects(() => aliceApi.execOnPod(bob.podId, 'echo hello'), /access denied/);
    assert.equal(execCalls.length, 0, 'peerNode.exec() must never run for an unauthorized requester');
    await waitFor(() => deniedEvents.length > 0, 1000, 'request-denied to fire on the responder side');
    assert.equal(deniedEvents[0].reason, 'access_denied');
    assert.equal(deniedEvents[0].action, 'exec');
    assert.equal(deniedEvents[0].from, alice.podId);
  });

  it('a served, authorized request emits request-served with ok:true', async () => {
    const alice = await createOrchestratorTestPeer('alice');
    const bob = await createOrchestratorTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    bob.registry.grantCapabilities(alice.podId, ['orchestrator:exec']);
    nodeB.exec = async (command) => ({ output: `ran: ${command}`, exitCode: 0 });

    const servedEvents = [];
    const { on: bobOn } = attachService(nodeB, undefined, createOrchestratorService());
    bobOn('orchestrator:request-served', (data) => servedEvents.push(data));

    const { api: aliceApi } = attachService(nodeA, undefined, createOrchestratorService());

    await aliceApi.execOnPod(bob.podId, 'echo hi');
    await waitFor(() => servedEvents.length > 0, 1000, 'request-served to fire');
    assert.equal(servedEvents[0].ok, true);
    assert.equal(servedEvents[0].action, 'exec');
    assert.equal(servedEvents[0].from, alice.podId);
  });

  it('rejects an unsupported action name even from an otherwise-unrestricted sender', async () => {
    const alice = await createOrchestratorTestPeer('alice');
    const bob = await createOrchestratorTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    const deniedEvents = [];
    const { on: bobOn } = attachService(nodeB, undefined, createOrchestratorService());
    bobOn('orchestrator:request-denied', (data) => deniedEvents.push(data));

    await nodeA.sendTo(bob.podId, {
      type: 'mesh-orchestrator',
      kind: 'orchestrator-request',
      requestId: 'req-1',
      action: 'listPods',
      args: {},
    });

    await waitFor(() => deniedEvents.length > 0, 1000, 'request-denied to fire for an unsupported action');
    assert.equal(deniedEvents[0].reason, 'unsupported_action');
  });
});

// -----------------------------------------------------------------------
// api.orchestrator -- the raw MeshOrchestrator instance
// -----------------------------------------------------------------------

describe('createOrchestratorService: api.orchestrator exposes the raw MeshOrchestrator instance', () => {
  it('is a real MeshOrchestrator, usable directly (e.g. by a later phase\'s Meshctl*Tool construction)', async () => {
    const alice = await createOrchestratorTestPeer('alice');
    const mesh = wireFullMesh([alice]);
    const { [alice.podId]: nodeA } = mesh;

    const { api } = attachService(nodeA, undefined, createOrchestratorService());
    assert.ok(api.orchestrator instanceof MeshOrchestrator);
    assert.equal(api.orchestrator.localPodId, alice.podId);
    assert.equal(api.orchestrator.peerNode, nodeA);
  });
});

// -----------------------------------------------------------------------
// teardown()
// -----------------------------------------------------------------------

describe('createOrchestratorService: teardown', () => {
  it('rejects any still-in-flight remote dispatches and stops further event delivery', async () => {
    const alice = await createOrchestratorTestPeer('alice');
    const bob = await createOrchestratorTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    bob.registry.grantCapabilities(alice.podId, ['orchestrator:exec']);
    // bob's exec() never resolves -- alice's dispatch stays pending.
    nodeB.exec = () => new Promise(() => {});
    attachService(nodeB, undefined, createOrchestratorService());

    const events = [];
    const { api: aliceApi, on: aliceOn, teardown } = attachService(nodeA, undefined, createOrchestratorService({ dispatchTimeoutMs: 5000 }));
    aliceOn('orchestrator:request-served', (data) => events.push(data));

    const pending = aliceApi.execOnPod(bob.podId, 'sleep 100');
    await new Promise((r) => setTimeout(r, 20));
    await teardown();

    await assert.rejects(() => pending, /torn down while a dispatch was still in flight/);
    assert.equal(events.length, 0);
  });
});

// -----------------------------------------------------------------------
// createMeshNode({ enableOrchestrator: true }) -- opt-in surface (issue #92)
// -----------------------------------------------------------------------

function createStubSignalingTransport() {
  return { send() {}, onMessage() {} };
}

describe('createMeshNode({ enableOrchestrator: true })', () => {
  it('leaves node.orchestrator unset and node.services empty of "orchestrator" when enableOrchestrator is omitted', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
    });

    assert.equal(node.orchestrator, undefined);
    assert.equal(node.services.has('orchestrator'), false);
  });

  it('attaches node.orchestrator (== node.services.get("orchestrator")) exposing both the wire protocol and the raw MeshOrchestrator instance', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableOrchestrator: true,
      skipBoot: true,
    });

    assert.ok(node.orchestrator, 'node.orchestrator is attached');
    assert.equal(node.orchestrator, node.services.get('orchestrator'));
    assert.equal(typeof node.orchestrator.api.execOnPod, 'function');
    assert.equal(typeof node.orchestrator.api.deploySkill, 'function');
    assert.equal(typeof node.orchestrator.api.drainPod, 'function');
    assert.equal(typeof node.orchestrator.api.listPods, 'function');
    assert.equal(typeof node.orchestrator.api.getPodStatus, 'function');
    assert.equal(typeof node.orchestrator.api.topPods, 'function');
    assert.ok(node.orchestrator.api.orchestrator instanceof MeshOrchestrator);

    // Works with zero collaborators wired -- MeshOrchestrator has no
    // required, bring-your-own dependency, unlike enableCompute/
    // enableTerminal/enableAgentSwarm.
    const pods = await node.orchestrator.api.listPods();
    assert.equal(pods.length, 1);
    assert.equal(pods[0].isLocal, true);
  });

  it('wires router: node.router.api (from enableRouting) straight through to MeshOrchestrator, observable via routeService()->addRoute()', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableRouting: true,
      enableOrchestrator: true,
      skipBoot: true,
    });

    assert.ok(node.router, 'node.router is attached (enableRouting)');
    const result = await node.orchestrator.api.orchestrator.routeService('my-service', 'target-pod');
    assert.equal(result.success, true);

    const routes = node.router.api.listRoutes();
    assert.ok(routes.some((r) => r.target === 'target-pod'), 'MeshOrchestrator.routeService() really called router.addRoute()');
  });
});
