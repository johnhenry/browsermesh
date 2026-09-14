// Run with: node --import ./test/_setup-globals.mjs --test test/mesh-swarm.test.mjs
//
// SwimMembership/SwarmCoordinator/LeaderElection/TaskDistributor's own
// internal algorithms (ping/ack/ping-req state machine, deterministic
// election, distribution strategies) are already covered by
// browsermesh-discovery's own swarm.test.mjs against direct constructor
// calls. This file covers the MeshService WRAPPER issue #88 adds: the real
// SWIM sendFn/handleMessage wire bridge, the leader-election heartbeat pump
// (genuinely new logic -- nothing in swarm.mjs broadcasts a heartbeat or
// triggers re-election on its own), the SWARM_JOIN/SWARM_LEAVE
// admission-control + courtesy-leave wire protocol, the SWARM_TASK_ASSIGN
// notification, checkAccess()-gated authorization, ctx.emit() event
// bridging, teardown/no-leaked-timers, and createMeshNode({ enableSwarm })
// opt-in wiring.
//
// Every test below tears down every service handle it created in a
// `finally` block -- each createSwarmService() attach() starts REAL timers
// (SWIM's own ping loop plus this file's heartbeat pump) immediately, so an
// assertion failure that skipped teardown would leak an interval and hang
// the test process, exactly the bug class issue #110's keepalive teardown
// fix was about.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createSwarmService } from '../src/mesh-swarm.mjs';
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
// connected via a duck-typed in-memory sendTo()/onIncomingData() bus.
//
// NOTE: podIds are real Ed25519 public keys, NOT derived from the `label`
// passed to createSwarmTestPeer() -- a label like 'alice' has no bearing on
// where that peer's podId sorts lexicographically. Tests that care about
// the deterministic lowest-podId leader compute it from the REAL generated
// podIds, never from label ordering.

async function createSwarmTestPeer(label) {
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

/** A fully-connected duck-typed multi-peer bus (every peer directly reaches every other peer). */
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
    };
  }
  return nodesByPodId;
}

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs = 2000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
}

/** Tear down every handle, even ones created after an earlier one might (in principle) throw. */
function teardownAll(handles) {
  for (const h of handles) {
    try { h.teardown(); } catch { /* best-effort cleanup */ }
  }
}

/** Fast SWIM tuning shared by most tests below, so suspect/dead detection completes in well under a second. */
const FAST_SWIM = { pingIntervalMs: 20, pingTimeoutMs: 15, suspectTimeoutMs: 60, indirectPingCount: 2 };

// -----------------------------------------------------------------------
// SWIM membership: real ping/ack convergence, and real suspect -> dead
// detection for a peer that goes silent.
// -----------------------------------------------------------------------

describe('createSwarmService: real SWIM membership over real wire ping/ack', () => {
  it('three real peers converge on each other as alive, and stay alive while responsive', async () => {
    const alice = await createSwarmTestPeer('alice');
    const bob = await createSwarmTestPeer('bob');
    const carol = await createSwarmTestPeer('carol');
    const mesh = wireFullMesh([alice, bob, carol]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC } = mesh;

    const handles = [nodeA, nodeB, nodeC].map((node) => attachService(node, undefined, createSwarmService({
      swimOptions: FAST_SWIM,
      heartbeatMs: 10_000, // keep the leader-election pump out of the way for this test
    })));
    try {
      const [{ api: apiA }, { api: apiB }, { api: apiC }] = handles;

      // Local admin join -- each peer learns about the other two.
      apiA.join(bob.podId); apiA.join(carol.podId);
      apiB.join(alice.podId); apiB.join(carol.podId);
      apiC.join(alice.podId); apiC.join(bob.podId);

      // Let several real SWIM ping/ack rounds happen.
      await new Promise((r) => setTimeout(r, 200));

      assert.equal(apiA.getMemberState(bob.podId), 'alive');
      assert.equal(apiA.getMemberState(carol.podId), 'alive');
      assert.equal(apiB.getMemberState(alice.podId), 'alive');
      assert.equal(apiC.getMemberState(alice.podId), 'alive');
    } finally {
      teardownAll(handles);
    }
  });

  it('a peer that goes silent is discovered as suspect, then removed, by the remaining peers', async () => {
    const alice = await createSwarmTestPeer('alice');
    const bob = await createSwarmTestPeer('bob');
    const carol = await createSwarmTestPeer('carol');
    const mesh = wireFullMesh([alice, bob, carol]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC } = mesh;

    const handleA = attachService(nodeA, undefined, createSwarmService({ swimOptions: FAST_SWIM, heartbeatMs: 10_000 }));
    const handleB = attachService(nodeB, undefined, createSwarmService({ swimOptions: FAST_SWIM, heartbeatMs: 10_000 }));
    const handleC = attachService(nodeC, undefined, createSwarmService({ swimOptions: FAST_SWIM, heartbeatMs: 10_000 }));
    try {
      const { api: apiA } = handleA;
      const { api: apiB } = handleB;
      const { api: apiC } = handleC;

      apiA.join(bob.podId); apiA.join(carol.podId);
      apiB.join(alice.podId); apiB.join(carol.podId);
      apiC.join(alice.podId); apiC.join(bob.podId);

      const aliceEvents = [];
      handleA.onEvent((event, data) => aliceEvents.push({ event, data }));

      await waitFor(() => apiA.getMemberState(bob.podId) === 'alive', 500, 'bob alive from alice\'s view');

      // bob goes silent: tear its own service down so it no longer answers
      // pings/ping-reqs -- a realistic "went dark" simulation over this
      // duck-typed bus (its onIncomingData subscription is removed).
      handleB.teardown();

      await waitFor(
        () => apiA.getMemberState(bob.podId) === 'suspect' || apiA.getMemberState(bob.podId) === 'dead' || apiA.getMemberState(bob.podId) === 'left',
        1000,
        'alice suspects bob after he stops responding',
      );
      // SwarmCoordinator's own (pre-existing, unmodified) leave() cascades
      // swim.removeMember() on top of the 'dead' transition, which
      // unconditionally overwrites state to 'left' -- see mesh-swarm.mjs's
      // own module doc comment ("SINGLE-SLOT CALLBACK COMPOSITION"). The
      // durable, observable end state is therefore 'left', not 'dead'.
      await waitFor(() => apiA.getMemberState(bob.podId) === 'left', 1500, 'alice settles on bob being left (post-dead cascade)');
      await waitFor(() => !apiA.listMembers().includes(bob.podId), 1000, 'coordinator.leave() removed bob from the member list');

      // 'swarm:member-left' is the ONE event guaranteed to fire on alice's
      // view no matter which path got her there: either (a) her own local
      // suspect -> dead detection (which also fires member-suspect and
      // member-dead first), or (b) carol's gossip about bob delivering an
      // ALREADY-'left' update to alice first, which can skip 'suspect'/
      // 'dead' entirely on alice's OWN view (SwimMembership's
      // #fireStateCallbacks only fires the callback matching the actual
      // NEW state it just applied -- see mesh-swarm.mjs's own module doc
      // comment). Both paths are real, correct SWIM behavior; which one
      // wins is a race this test must not assume the outcome of.
      assert.ok(aliceEvents.some((e) => e.event === 'swarm:member-left' && e.data.podId === bob.podId));
    } finally {
      teardownAll([handleA, handleC]); // handleB already torn down above
    }
  });
});

// -----------------------------------------------------------------------
// Leader election: heartbeats keep a leader alive; the leader going silent
// triggers a real new election among survivors.
// -----------------------------------------------------------------------

describe('createSwarmService: leader election heartbeat pump', () => {
  it('converges all peers on the same (lowest-lexicographic) leader via real heartbeats', async () => {
    const alice = await createSwarmTestPeer('alice');
    const bob = await createSwarmTestPeer('bob');
    const carol = await createSwarmTestPeer('carol');
    const mesh = wireFullMesh([alice, bob, carol]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC } = mesh;

    const opts = { swimOptions: FAST_SWIM, heartbeatMs: 20, electionTimeoutMs: 200 };
    const handleA = attachService(nodeA, undefined, createSwarmService(opts));
    const handleB = attachService(nodeB, undefined, createSwarmService(opts));
    const handleC = attachService(nodeC, undefined, createSwarmService(opts));
    try {
      const { api: apiA } = handleA;
      const { api: apiB } = handleB;
      const { api: apiC } = handleC;

      apiA.join(bob.podId); apiA.join(carol.podId);
      apiB.join(alice.podId); apiB.join(carol.podId);
      apiC.join(alice.podId); apiC.join(bob.podId);

      const expectedLeader = [alice.podId, bob.podId, carol.podId].sort()[0];

      await waitFor(() => apiA.getLeader() === expectedLeader, 1000, 'alice converges on the lowest podId leader');
      await waitFor(() => apiB.getLeader() === expectedLeader, 1000, 'bob converges on the same leader');
      await waitFor(() => apiC.getLeader() === expectedLeader, 1000, 'carol converges on the same leader');
    } finally {
      teardownAll([handleA, handleB, handleC]);
    }
  });

  it('a new election is triggered when the leader goes silent', async () => {
    const alice = await createSwarmTestPeer('alice');
    const bob = await createSwarmTestPeer('bob');
    const carol = await createSwarmTestPeer('carol');
    const mesh = wireFullMesh([alice, bob, carol]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC } = mesh;

    // podIds are real pubkeys -- determine the initial leader (lowest) and
    // which peer that actually is dynamically, rather than assuming a
    // fixed peer is lowest based on its label.
    const initialLeader = [alice.podId, bob.podId, carol.podId].sort()[0];
    const survivorPodIds = [alice.podId, bob.podId, carol.podId].filter((id) => id !== initialLeader);

    const opts = { swimOptions: FAST_SWIM, heartbeatMs: 20, electionTimeoutMs: 150 };
    const handleA = attachService(nodeA, undefined, createSwarmService(opts));
    const handleB = attachService(nodeB, undefined, createSwarmService(opts));
    const handleC = attachService(nodeC, undefined, createSwarmService(opts));
    const handlesByPodId = { [alice.podId]: handleA, [bob.podId]: handleB, [carol.podId]: handleC };
    try {
      const { api: apiA } = handleA;
      const { api: apiB } = handleB;
      const { api: apiC } = handleC;
      const apisByPodId = { [alice.podId]: apiA, [bob.podId]: apiB, [carol.podId]: apiC };

      apiA.join(bob.podId); apiA.join(carol.podId);
      apiB.join(alice.podId); apiB.join(carol.podId);
      apiC.join(alice.podId); apiC.join(bob.podId);

      const survivorApis = survivorPodIds.map((id) => apisByPodId[id]);

      for (const api of survivorApis) {
        await waitFor(() => api.getLeader() === initialLeader, 1000, 'survivor sees the initial leader');
      }

      const [survivorHandle] = survivorPodIds.map((id) => handlesByPodId[id]);
      const leaderElectedEvents = [];
      survivorHandle.on('swarm:leader-elected', (data) => leaderElectedEvents.push(data));

      // The leader goes silent.
      handlesByPodId[initialLeader].teardown();

      const newExpectedLeader = [...survivorPodIds].sort()[0];
      for (const api of survivorApis) {
        await waitFor(() => api.getLeader() === newExpectedLeader, 2500, 'survivor elects a new leader once the old one stops heartbeating');
      }
      await waitFor(() => leaderElectedEvents.some((e) => e.leader === newExpectedLeader), 500, 'swarm:leader-elected fired with the new leader');
    } finally {
      teardownAll(survivorPodIds.map((id) => handlesByPodId[id])); // the (silent) leader's handle already torn down above
    }
  });
});

// -----------------------------------------------------------------------
// Task submission -> distribution -> real SWARM_TASK_ASSIGN notification.
// -----------------------------------------------------------------------

describe('createSwarmService: task submission and real assignment notification', () => {
  it('submitTask() distributes to a real remote member and notifies it over the wire', async () => {
    const alice = await createSwarmTestPeer('alice'); // submitter
    const bob = await createSwarmTestPeer('bob');
    const carol = await createSwarmTestPeer('carol');
    const mesh = wireFullMesh([alice, bob, carol]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC } = mesh;

    const opts = { swimOptions: FAST_SWIM, heartbeatMs: 10_000 };
    const handleA = attachService(nodeA, undefined, createSwarmService(opts));
    const handleB = attachService(nodeB, undefined, createSwarmService(opts));
    const handleC = attachService(nodeC, undefined, createSwarmService(opts));
    try {
      const { api: apiA } = handleA;
      const { api: apiB } = handleB;
      const { api: apiC } = handleC;

      apiA.join(bob.podId); apiA.join(carol.podId);

      const aliceEvents = [];
      handleA.on('swarm:task-assigned', (data) => aliceEvents.push(data));

      // TaskDistributor's 'round-robin' picks members in INSERTION order:
      // [alice (self, always seeded first), bob, carol]. The first
      // submission (index 0) therefore assigns to alice HERSELF -- real,
      // expected TaskDistributor behavior, not a bug -- and
      // notifyAssignees() correctly sends no wire notification for a
      // self-assignment. The SECOND submission (index 1) is what
      // deterministically lands on a real remote member (bob), which is
      // what this test actually exercises.
      const warmup = apiA.submitTask('warm up round-robin', 'round-robin', null);
      assert.equal(warmup.assignedTo[0], alice.podId);

      const task = apiA.submitTask('do the thing', 'round-robin', { n: 1 });
      assert.equal(task.status, 'assigned');
      assert.equal(task.assignedTo.length, 1);
      assert.equal(task.assignedTo[0], bob.podId, 'round-robin\'s second call lands on the second-inserted member');

      await waitFor(() => apiB.getAssignedTask(task.taskId) !== null, 500, 'bob actually received the task notification');
      const received = apiB.getAssignedTask(task.taskId);
      assert.equal(received.description, 'do the thing');
      assert.deepEqual(received.input, { n: 1 });
      assert.equal(received.assignedBy, alice.podId);
      assert.equal(apiC.getAssignedTask(task.taskId), null, 'carol was not assigned and got no notification');

      assert.equal(aliceEvents.length, 1, 'exactly one wire notification sent (only for the real, non-self assignment)');
      assert.equal(aliceEvents[0].podId, bob.podId);
    } finally {
      teardownAll([handleA, handleB, handleC]);
    }
  });

  it('redundant strategy notifies every remote assigned member', async () => {
    const alice = await createSwarmTestPeer('alice');
    const bob = await createSwarmTestPeer('bob');
    const carol = await createSwarmTestPeer('carol');
    const mesh = wireFullMesh([alice, bob, carol]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC } = mesh;

    const opts = { swimOptions: FAST_SWIM, heartbeatMs: 10_000 };
    const handleA = attachService(nodeA, undefined, createSwarmService(opts));
    const handleB = attachService(nodeB, undefined, createSwarmService(opts));
    const handleC = attachService(nodeC, undefined, createSwarmService(opts));
    try {
      const { api: apiA } = handleA;
      const { api: apiB } = handleB;
      const { api: apiC } = handleC;

      apiA.join(bob.podId); apiA.join(carol.podId);

      const task = apiA.submitTask('replicate this', 'redundant', { payload: 7 });
      // 'redundant' assigns to ALL members of the 'local' swarm, including
      // alice herself (the coordinator always seeds itself as a member) --
      // notifyAssignees() skips the local pod, so only bob+carol get a wire
      // notification.
      assert.ok(task.assignedTo.includes(alice.podId));
      assert.ok(task.assignedTo.includes(bob.podId));
      assert.ok(task.assignedTo.includes(carol.podId));

      await waitFor(() => apiB.getAssignedTask(task.taskId) !== null, 500, 'bob notified');
      await waitFor(() => apiC.getAssignedTask(task.taskId) !== null, 500, 'carol notified');
    } finally {
      teardownAll([handleA, handleB, handleC]);
    }
  });
});

// -----------------------------------------------------------------------
// Authorization: checkAccess() gates peer-initiated join-request and
// submit-task requests.
// -----------------------------------------------------------------------

describe('createSwarmService: checkAccess()-gated peer-initiated join / submit-task', () => {
  it('rejects an unauthorized join-request, then accepts once granted', async () => {
    const alice = await createSwarmTestPeer('alice'); // requester
    const bob = await createSwarmTestPeer('bob'); // gatekeeper
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    const opts = { swimOptions: FAST_SWIM, heartbeatMs: 10_000 };
    const handleA = attachService(nodeA, undefined, createSwarmService(opts));
    const handleB = attachService(nodeB, undefined, createSwarmService(opts));
    try {
      const { api: apiA } = handleA;
      const { api: apiB } = handleB;

      const deniedEvents = [];
      handleB.on('swarm:join-request-denied', (data) => deniedEvents.push(data));

      // No grantCapabilities() yet -- alice is not in bob's roster at all.
      const denied = await apiA.requestJoin(bob.podId, 500);
      assert.equal(denied.ok, false);
      assert.equal(denied.reason, 'access_denied');
      assert.equal(deniedEvents.length, 1);
      assert.equal(deniedEvents[0].reason, 'access_denied');
      assert.ok(!apiB.listMembers().includes(alice.podId), 'bob did not admit alice');

      nodeB.registry.grantCapabilities(alice.podId, ['swarm:join']);

      const grantedEvents = [];
      handleB.on('swarm:join-request-granted', (data) => grantedEvents.push(data));

      const granted = await apiA.requestJoin(bob.podId, 500);
      assert.equal(granted.ok, true);
      assert.equal(grantedEvents.length, 1);
      await waitFor(() => apiB.listMembers().includes(alice.podId), 500, 'bob admitted alice into his swarm after granting swarm:join');
    } finally {
      teardownAll([handleA, handleB]);
    }
  });

  it('rejects an unauthorized submit-task request, then accepts once granted', async () => {
    const alice = await createSwarmTestPeer('alice'); // requester
    const bob = await createSwarmTestPeer('bob'); // swarm owner
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    const opts = { swimOptions: FAST_SWIM, heartbeatMs: 10_000 };
    const handleA = attachService(nodeA, undefined, createSwarmService(opts));
    const handleB = attachService(nodeB, undefined, createSwarmService(opts));
    try {
      const { api: apiA } = handleA;

      const deniedEvents = [];
      handleB.on('swarm:submit-task-denied', (data) => deniedEvents.push(data));

      await assert.rejects(
        () => apiA.requestSubmitTask(bob.podId, { description: 'sneaky', timeoutMs: 500 }),
        /access denied/,
      );
      assert.equal(deniedEvents.length, 1);
      assert.equal(deniedEvents[0].reason, 'access_denied');

      nodeB.registry.grantCapabilities(alice.podId, ['swarm:submit-task']);

      const task = await apiA.requestSubmitTask(bob.podId, { description: 'do it for real', strategy: 'leader-follower', input: { x: 1 } });
      assert.equal(task.description, 'do it for real');
      assert.equal(task.status, 'assigned');
    } finally {
      teardownAll([handleA, handleB]);
    }
  });
});

// -----------------------------------------------------------------------
// Courtesy leave (SWARM_LEAVE) -- distinct from SWIM's own dead-via-timeout.
// -----------------------------------------------------------------------

describe('createSwarmService: announceLeave()', () => {
  it('a peer announcing its own departure is removed immediately, without waiting for the suspect/dead cascade', async () => {
    const alice = await createSwarmTestPeer('alice');
    const bob = await createSwarmTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    // Deliberately slow SWIM tuning -- if announceLeave() didn't work, the
    // suspect/dead cascade alone would take far longer than this test's
    // waitFor() budget, proving the courtesy-leave path is what did it.
    const opts = { swimOptions: { pingIntervalMs: 5000, pingTimeoutMs: 2000, suspectTimeoutMs: 20000 }, heartbeatMs: 10_000 };
    const handleA = attachService(nodeA, undefined, createSwarmService(opts));
    const handleB = attachService(nodeB, undefined, createSwarmService(opts));
    try {
      const { api: apiA } = handleA;
      const { api: apiB } = handleB;

      // Mutual join -- alice must know bob is a member for announceLeave()
      // to have anyone to notify.
      apiA.join(bob.podId);
      apiB.join(alice.podId);
      assert.ok(apiB.listMembers().includes(alice.podId));

      const leftEvents = [];
      handleB.on('swarm:member-left', (data) => leftEvents.push(data));

      apiA.announceLeave();

      await waitFor(() => !apiB.listMembers().includes(alice.podId), 300, 'bob removed alice immediately on her leave announcement');
      assert.equal(leftEvents.length, 1);
      assert.equal(leftEvents[0].podId, alice.podId);
    } finally {
      teardownAll([handleA, handleB]);
    }
  });
});

// -----------------------------------------------------------------------
// teardown() actually stops every timer -- SWIM's internal ping loop AND
// this file's own heartbeat pump. No leaked timers (mirrors issue #110's
// keepalive teardown verification: prove it by counting real outbound
// traffic before/after, not by reaching into private state).
// -----------------------------------------------------------------------

describe('createSwarmService: teardown stops all timers', () => {
  it('stops SWIM ping traffic and heartbeat traffic once torn down', async () => {
    const alice = await createSwarmTestPeer('alice');
    const bob = await createSwarmTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    let sentTypes = [];
    const originalSendTo = nodeA.sendTo.bind(nodeA);
    nodeA.sendTo = async (pubKey, data) => {
      if (data && typeof data.type === 'string') sentTypes.push(data.type);
      return originalSendTo(pubKey, data);
    };

    const opts = { swimOptions: { pingIntervalMs: 15, pingTimeoutMs: 10, suspectTimeoutMs: 60 }, heartbeatMs: 15 };
    const handleA = attachService(nodeA, undefined, createSwarmService(opts));
    const handleB = attachService(nodeB, undefined, createSwarmService(opts));
    try {
      const { api: apiA } = handleA;
      apiA.join(bob.podId);

      await waitFor(() => sentTypes.includes('swarm-swim') && sentTypes.includes('swarm-heartbeat'), 500, 'both SWIM and heartbeat traffic observed while active');
    } finally {
      teardownAll([handleA, handleB]);
    }

    sentTypes = [];
    await new Promise((r) => setTimeout(r, 150)); // several would-be interval cycles

    assert.equal(sentTypes.length, 0, 'no further SWIM ping or heartbeat traffic was sent after teardown -- both timers were actually cleared');
  });
});

// -----------------------------------------------------------------------
// createMeshNode({ enableSwarm: true }) -- opt-in surface (issue #88)
// -----------------------------------------------------------------------

function createStubSignalingTransport() {
  return { send() {}, onMessage() {} };
}

describe('createMeshNode({ enableSwarm: true })', () => {
  it('leaves node.swarm unset and node.services empty of "swarm" when enableSwarm is omitted', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
    });

    assert.equal(node.swarm, undefined);
    assert.equal(node.services.has('swarm'), false);
  });

  it('attaches node.swarm (== node.services.get("swarm")) with a full api surface when enableSwarm is set', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableSwarm: true,
      skipBoot: true,
    });

    try {
      assert.ok(node.swarm, 'node.swarm is attached');
      assert.equal(node.swarm, node.services.get('swarm'));
      assert.equal(typeof node.swarm.api.submitTask, 'function');
      assert.equal(typeof node.swarm.api.join, 'function');
      assert.equal(typeof node.swarm.api.requestJoin, 'function');
      assert.equal(typeof node.swarm.api.requestSubmitTask, 'function');
      assert.equal(typeof node.swarm.api.isLeader, 'function');
      assert.equal(typeof node.swarm.api.listAssignedTasks, 'function');
    } finally {
      // The service starts real timers (swim.start() + the heartbeat pump)
      // immediately on attach -- must tear down or this test process leaks
      // an active interval.
      await node.swarm.teardown();
    }
  });
});
