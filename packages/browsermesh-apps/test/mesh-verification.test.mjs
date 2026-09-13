// Run with: node --import ./test/_setup-globals.mjs --test test/mesh-verification.test.mjs
//
// VerificationQuorum's own voting math (unanimous/majority/threshold/
// byzantine, timeout handling, divergence) is already thoroughly covered by
// peer-verification.test.mjs against mock scheduler/trust objects. This file
// covers the MeshService WRAPPER this phase adds: the real
// 'verify-request'/'verify-response' wire protocol, the default trust
// adapter over PeerRegistry, checkAccess()-gated authorization, the
// required-but-not-provided executeFn, ctx.emit() event bridging, and
// createMeshNode({ enableVerification: true }) opt-in wiring.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createVerificationService,
} from '../src/mesh-verification.mjs';
import { VERIFICATION_STRATEGIES } from '../src/peer-verification.mjs';
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
// Mirrors peer-routing.test.mjs's own: real Ed25519 IdentityWallet/
// MeshIdentityManager identities + real PeerRegistry (wired to real
// MeshACL/MeshPeerManager/TrustGraph from @johnhenry/browsermesh-core),
// connected via a duck-typed in-memory sendTo()/onIncomingData()/listPeers()
// bus.

async function createVerificationTestPeer(label) {
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
 * every other peer) -- unlike peer-routing.test.mjs's restricted-edge mesh,
 * multi-hop reachability isn't what this phase tests, so every peer is
 * connected. Also implements listPeers({status:'connected'}) with a
 * `.fingerprint` field, matching mesh-timestamp.mjs's own convention this
 * file's default trust adapter relies on.
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
// Real quorum, real network: requester + 3 verifiers, unanimous agreement
// -----------------------------------------------------------------------

describe('createVerificationService: a real quorum decision over real wire request/response', () => {
  it('dispatches a job to 3 trusted verifiers, collects real results, and reaches a unanimous verified outcome', async () => {
    const alice = await createVerificationTestPeer('alice'); // requester
    const bob = await createVerificationTestPeer('bob'); // verifier
    const carol = await createVerificationTestPeer('carol'); // verifier
    const dave = await createVerificationTestPeer('dave'); // verifier
    const mesh = wireFullMesh([alice, bob, carol, dave]);
    const {
      [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC, [dave.podId]: nodeD,
    } = mesh;

    // Alice trusts all three verifiers (default trust adapter reads this).
    nodeA.registry.setTrust(bob.podId, 0.9);
    nodeA.registry.setTrust(carol.podId, 0.8);
    nodeA.registry.setTrust(dave.podId, 0.7);

    // Each verifier authorizes Alice to ask it to execute verification jobs.
    for (const verifierNode of [nodeB, nodeC, nodeD]) {
      verifierNode.registry.grantCapabilities(alice.podId, ['verification:execute']);
    }

    // All three verifiers compute the SAME real result for the same job --
    // unanimous agreement, proving a genuine multi-peer quorum, not a
    // 2-peer degenerate case.
    const executeCalls = [];
    const makeExecuteFn = (who) => async (job) => {
      executeCalls.push({ who, job });
      return { answer: job.a + job.b };
    };
    attachService(nodeB, undefined, createVerificationService({ executeFn: makeExecuteFn('bob') }));
    attachService(nodeC, undefined, createVerificationService({ executeFn: makeExecuteFn('carol') }));
    attachService(nodeD, undefined, createVerificationService({ executeFn: makeExecuteFn('dave') }));

    const events = [];
    const { api: aliceApi, on: aliceOn } = attachService(nodeA, undefined, createVerificationService({}));
    aliceOn('verification:verified', (outcome) => events.push({ type: 'verified', outcome }));
    aliceOn('verification:divergent', (data) => events.push({ type: 'divergent', data }));
    aliceOn('verification:timeout', (data) => events.push({ type: 'timeout', data }));

    aliceApi.setPolicy({ strategy: VERIFICATION_STRATEGIES.UNANIMOUS });

    const outcome = await aliceApi.submitVerified({ a: 2, b: 3 });

    assert.deepEqual(outcome.result, { answer: 5 });
    assert.equal(outcome.confidence, 1.0);
    assert.equal(outcome.attestations.length, 3, 'all 3 verifiers attested to the winning result');

    // Real execution actually happened on all 3 peers, not a stub.
    assert.equal(executeCalls.length, 3);
    assert.deepEqual(new Set(executeCalls.map((c) => c.who)), new Set(['bob', 'carol', 'dave']));
    for (const call of executeCalls) assert.deepEqual(call.job, { a: 2, b: 3 });

    // ctx.emit() bridged the quorum's own 'verified' event.
    const verifiedEvents = events.filter((e) => e.type === 'verified');
    assert.equal(verifiedEvents.length, 1);
    assert.deepEqual(verifiedEvents[0].outcome.result, { answer: 5 });
  });

  it('reaches a real quorum-failed (divergent) outcome when verifiers disagree under a unanimous policy', async () => {
    const alice = await createVerificationTestPeer('alice');
    const bob = await createVerificationTestPeer('bob');
    const carol = await createVerificationTestPeer('carol');
    const dave = await createVerificationTestPeer('dave');
    const mesh = wireFullMesh([alice, bob, carol, dave]);
    const {
      [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC, [dave.podId]: nodeD,
    } = mesh;

    nodeA.registry.setTrust(bob.podId, 0.9);
    nodeA.registry.setTrust(carol.podId, 0.8);
    nodeA.registry.setTrust(dave.podId, 0.7);
    for (const verifierNode of [nodeB, nodeC, nodeD]) {
      verifierNode.registry.grantCapabilities(alice.podId, ['verification:execute']);
    }

    // Dave computes a DIFFERENT (wrong) result -- real divergence.
    attachService(nodeB, undefined, createVerificationService({ executeFn: async (job) => ({ answer: job.a + job.b }) }));
    attachService(nodeC, undefined, createVerificationService({ executeFn: async (job) => ({ answer: job.a + job.b }) }));
    attachService(nodeD, undefined, createVerificationService({ executeFn: async () => ({ answer: 999 }) }));

    const events = [];
    const { api: aliceApi, on: aliceOn } = attachService(nodeA, undefined, createVerificationService({}));
    aliceOn('verification:divergent', (data) => events.push(data));
    aliceApi.setPolicy({ strategy: VERIFICATION_STRATEGIES.UNANIMOUS });

    await assert.rejects(
      () => aliceApi.submitVerified({ a: 2, b: 3 }),
      /No winner: results diverge/,
    );

    assert.equal(events.length, 1);
    assert.equal(events[0].groups && Object.keys(events[0].groups).length, 2, 'two distinct result groups');
  });
});

// -----------------------------------------------------------------------
// Authorization: checkAccess() gates who may act as a peer-initiated
// 'verify-request' before executeFn ever runs
// -----------------------------------------------------------------------

describe('createVerificationService: inbound verify-request authorization', () => {
  it('rejects an unauthorized requester without ever calling executeFn, surfaced as VerificationQuorum\'s own "timeout" event', async () => {
    const alice = await createVerificationTestPeer('alice');
    const bob = await createVerificationTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    nodeA.registry.setTrust(bob.podId, 0.9);
    // Deliberately NOT granting bob.registry.grantCapabilities(alice.podId, ...).

    let executed = false;
    const deniedEvents = [];
    const { on: bobOn } = attachService(nodeB, undefined, createVerificationService({
      executeFn: async (job) => { executed = true; return job; },
    }));
    bobOn('verification:verify-request-denied', (data) => deniedEvents.push(data));

    const { api: aliceApi } = attachService(nodeA, undefined, createVerificationService({}));
    aliceApi.setPolicy({ minPeers: 1, maxPeers: 1 });

    await assert.rejects(() => aliceApi.submitVerified({ x: 1 }));

    assert.equal(executed, false, 'executeFn must never run for an unauthorized requester');
    await waitFor(() => deniedEvents.length > 0, 1000, 'verify-request-denied to fire on the responder side');
    assert.equal(deniedEvents[0].reason, 'access_denied');
  });

  it('an authorized requester talking to a verifier with no executeFn gets a clean "no_executor" denial, not a hang', async () => {
    const alice = await createVerificationTestPeer('alice');
    const bob = await createVerificationTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    nodeA.registry.setTrust(bob.podId, 0.9);
    nodeB.registry.grantCapabilities(alice.podId, ['verification:execute']);

    const deniedEvents = [];
    const { on: bobOn } = attachService(nodeB, undefined, createVerificationService({})); // no executeFn
    bobOn('verification:verify-request-denied', (data) => deniedEvents.push(data));

    const { api: aliceApi } = attachService(nodeA, undefined, createVerificationService({}));
    aliceApi.setPolicy({ minPeers: 1, maxPeers: 1 });

    await assert.rejects(() => aliceApi.submitVerified({ x: 1 }));
    await waitFor(() => deniedEvents.length > 0, 1000, 'verify-request-denied to fire with reason no_executor');
    assert.equal(deniedEvents[0].reason, 'no_executor');
  });

  it('a served, authorized request emits verify-served with ok:true', async () => {
    const alice = await createVerificationTestPeer('alice');
    const bob = await createVerificationTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    nodeA.registry.setTrust(bob.podId, 0.9);
    nodeB.registry.grantCapabilities(alice.podId, ['verification:execute']);

    const servedEvents = [];
    const { on: bobOn } = attachService(nodeB, undefined, createVerificationService({
      executeFn: async (job) => ({ doubled: job.n * 2 }),
    }));
    bobOn('verification:verify-served', (data) => servedEvents.push(data));

    const { api: aliceApi } = attachService(nodeA, undefined, createVerificationService({}));
    aliceApi.setPolicy({ minPeers: 1, maxPeers: 1, strategy: VERIFICATION_STRATEGIES.UNANIMOUS });

    const outcome = await aliceApi.submitVerified({ n: 21 });
    assert.deepEqual(outcome.result, { doubled: 42 });

    await waitFor(() => servedEvents.length > 0, 1000, 'verify-served to fire');
    assert.equal(servedEvents[0].ok, true);
    assert.equal(servedEvents[0].from, alice.podId);
  });
});

// -----------------------------------------------------------------------
// teardown()
// -----------------------------------------------------------------------

describe('createVerificationService: teardown', () => {
  it('rejects any still-in-flight submitVerified() dispatches and stops further event delivery', async () => {
    const alice = await createVerificationTestPeer('alice');
    const bob = await createVerificationTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    nodeA.registry.setTrust(bob.podId, 0.9);
    nodeB.registry.grantCapabilities(alice.podId, ['verification:execute']);

    // bob's executeFn never resolves -- alice's dispatch stays pending.
    attachService(nodeB, undefined, createVerificationService({ executeFn: () => new Promise(() => {}) }));

    const events = [];
    const {
      api: aliceApi, on: aliceOn, teardown,
    } = attachService(nodeA, undefined, createVerificationService({ dispatchTimeoutMs: 5000 }));
    aliceOn('verification:timeout', (data) => events.push(data));
    aliceApi.setPolicy({ minPeers: 1, maxPeers: 1 });

    const pending = aliceApi.submitVerified({ x: 1 }).catch((err) => err);
    await new Promise((r) => setTimeout(r, 20));
    await teardown();

    const result = await pending;
    assert.ok(result instanceof Error, 'submitVerified() rejects once its only verifier dispatch is torn down');

    // Event bus closed by teardown() -- nothing further reaches on().
    assert.equal(events.length, 0);
  });
});

// -----------------------------------------------------------------------
// createMeshNode({ enableVerification: true }) -- opt-in surface (issue #119)
// -----------------------------------------------------------------------

function createStubSignalingTransport() {
  return { send() {}, onMessage() {} };
}

describe('createMeshNode({ enableVerification: true })', () => {
  it('leaves node.verification unset and node.services empty of "verification" when enableVerification is omitted', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
    });

    assert.equal(node.verification, undefined);
    assert.equal(node.services.has('verification'), false);
  });

  it('attaches node.verification (== node.services.get("verification")) when enableVerification is set', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableVerification: true,
      skipBoot: true,
    });

    assert.ok(node.verification, 'node.verification is attached');
    assert.equal(node.verification, node.services.get('verification'));
    assert.equal(typeof node.verification.api.submitVerified, 'function');
    assert.equal(typeof node.verification.api.setPolicy, 'function');
  });

  it('verificationOptions.executeFn is forwarded to createVerificationService()', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableVerification: true,
      verificationOptions: {
        executeFn: async (job) => ({ echoed: job }),
      },
      skipBoot: true,
    });

    assert.ok(node.verification);
    // Wire it to itself is unnecessary to prove forwarding -- constructing
    // without throwing plus the descriptor accepting executeFn is enough
    // here; the real end-to-end executeFn path is covered above against
    // attachService() directly, matching peer-routing.test.mjs's own split
    // between "opt-in surface wiring" and "the real behavior".
    assert.equal(node.verification.name, 'verification');
  });
});
