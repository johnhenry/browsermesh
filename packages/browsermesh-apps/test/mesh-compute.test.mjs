// Run with: node --import ./test/_setup-globals.mjs --test test/mesh-compute.test.mjs
//
// FederatedCompute's own split/dispatch/retry/merge state machine (chunk
// assignment strategies, retry-on-failure, pipeline vs. parallel dispatch)
// is already covered by peer-compute.test.mjs against a mock scheduler. This
// file covers the MeshService WRAPPER this phase (issue #118) adds: the real
// 'compute-request'/'compute-response' wire protocol, the default
// listAvailablePeers adapter over PeerNode.listPeers(), checkAccess()-gated
// authorization, the required-but-not-provided executeFn, ctx.emit() event
// bridging, and createMeshNode({ enableCompute: true }) opt-in wiring.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createComputeService, DEFAULT_COMPUTE_DISPATCH_TIMEOUT_MS } from '../src/mesh-compute.mjs';
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
// Mirrors mesh-verification.test.mjs's own: real Ed25519 IdentityWallet/
// MeshIdentityManager identities + real PeerRegistry (wired to real
// MeshACL/MeshPeerManager/TrustGraph from @johnhenry/browsermesh-core),
// connected via a duck-typed in-memory sendTo()/onIncomingData()/listPeers()
// bus.

async function createComputeTestPeer(label) {
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
 * every other peer), matching mesh-verification.test.mjs's own wireFullMesh.
 * Implements listPeers({status:'connected'}) with a `.fingerprint` field,
 * matching this file's default listAvailablePeers adapter's expectations.
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
// Real split -> dispatch -> remote execution -> merge round-trip, across a
// real 4-peer mesh (a requester + 3 workers), proving genuine distribution
// of work rather than a 2-peer degenerate case.
// -----------------------------------------------------------------------

describe('createComputeService: a real federated compute job over real wire request/response', () => {
  it('splits a job into 3 chunks, dispatches each to a different real peer, executes remotely, and merges the real results', async () => {
    const alice = await createComputeTestPeer('alice'); // requester
    const bob = await createComputeTestPeer('bob'); // worker
    const carol = await createComputeTestPeer('carol'); // worker
    const dave = await createComputeTestPeer('dave'); // worker
    const mesh = wireFullMesh([alice, bob, carol, dave]);
    const {
      [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC, [dave.podId]: nodeD,
    } = mesh;

    // Each worker authorizes alice to dispatch compute chunks to it.
    for (const workerNode of [nodeB, nodeC, nodeD]) {
      workerNode.registry.grantCapabilities(alice.podId, ['compute:execute']);
    }

    const executeCalls = [];
    const makeExecuteFn = (who) => async (job) => {
      executeCalls.push({ who, job });
      return { doubled: job.payload * 2 };
    };
    attachService(nodeB, undefined, createComputeService({ executeFn: makeExecuteFn('bob') }));
    attachService(nodeC, undefined, createComputeService({ executeFn: makeExecuteFn('carol') }));
    attachService(nodeD, undefined, createComputeService({ executeFn: makeExecuteFn('dave') }));

    const events = [];
    const { api: aliceApi, on: aliceOn } = attachService(nodeA, undefined, createComputeService({}));
    for (const event of ['submitted', 'split', 'chunk-assigned', 'chunk-complete', 'merged', 'completed', 'failed']) {
      aliceOn(`compute:${event}`, (data) => events.push({ type: event, data }));
    }

    const job = await aliceApi.submit({
      payload: [1, 2, 3],
      splitFn: (payload) => payload,
      mergeFn: (results) => results.reduce((sum, r) => sum + r.doubled, 0),
    });

    assert.equal(job.status, 'completed');
    assert.equal(job.result, 12); // (1+2+3)*2

    // Real execution actually happened on all 3 peers, not a stub.
    assert.equal(executeCalls.length, 3);
    assert.deepEqual(new Set(executeCalls.map((c) => c.who)), new Set(['bob', 'carol', 'dave']));
    // Each dispatched job carries the FederatedCompute-native shape.
    for (const call of executeCalls) {
      assert.equal(call.job.jobId, job.id);
      assert.equal(typeof call.job.chunkId, 'string');
      assert.equal(typeof call.job.index, 'number');
    }

    // ctx.emit() bridged FederatedCompute's own lifecycle events.
    assert.equal(events.filter((e) => e.type === 'submitted').length, 1);
    assert.equal(events.filter((e) => e.type === 'split').length, 1);
    assert.equal(events.filter((e) => e.type === 'chunk-assigned').length, 3);
    assert.equal(events.filter((e) => e.type === 'chunk-complete').length, 3);
    assert.equal(events.filter((e) => e.type === 'merged').length, 1);
    assert.equal(events.filter((e) => e.type === 'completed').length, 1);
    assert.equal(events.filter((e) => e.type === 'failed').length, 0);
  });

  it('uses constructor-level splitFn/mergeFn defaults when a submitted jobSpec omits them', async () => {
    const alice = await createComputeTestPeer('alice');
    const bob = await createComputeTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    nodeB.registry.grantCapabilities(alice.podId, ['compute:execute']);
    attachService(nodeB, undefined, createComputeService({ executeFn: async (job) => job.payload + 1 }));

    const { api: aliceApi } = attachService(nodeA, undefined, createComputeService({
      splitFn: (payload) => [payload],
      mergeFn: (results) => results[0],
    }));

    const job = await aliceApi.submit({ payload: 41 });
    assert.equal(job.status, 'completed');
    assert.equal(job.result, 42);
  });
});

// -----------------------------------------------------------------------
// Authorization: checkAccess() gates who may act as a peer-initiated
// 'compute-request' before executeFn ever runs
// -----------------------------------------------------------------------

describe('createComputeService: inbound compute-request authorization', () => {
  it('rejects an unauthorized dispatcher without ever calling executeFn', async () => {
    const alice = await createComputeTestPeer('alice');
    const bob = await createComputeTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    // Deliberately NOT granting bob.registry.grantCapabilities(alice.podId, ...).

    let executed = false;
    const deniedEvents = [];
    const { on: bobOn } = attachService(nodeB, undefined, createComputeService({
      executeFn: async (job) => { executed = true; return job; },
    }));
    bobOn('compute:chunk-request-denied', (data) => deniedEvents.push(data));

    const { api: aliceApi } = attachService(nodeA, undefined, createComputeService({
      splitFn: (payload) => [payload],
      mergeFn: (results) => results[0],
      dispatchTimeoutMs: 500,
    }));

    const job = await aliceApi.submit({ payload: 1, peers: [bob.podId] });

    assert.equal(job.status, 'failed', 'no chunk completed -- unauthorized dispatcher never gets a real result');
    assert.equal(executed, false, 'executeFn must never run for an unauthorized dispatcher');
    await waitFor(() => deniedEvents.length > 0, 1000, 'chunk-request-denied to fire on the responder side');
    assert.equal(deniedEvents[0].reason, 'access_denied');
  });

  it('an authorized dispatcher talking to a worker with no executeFn gets a clean "no_executor" denial, not a hang', async () => {
    const alice = await createComputeTestPeer('alice');
    const bob = await createComputeTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    nodeB.registry.grantCapabilities(alice.podId, ['compute:execute']);

    const deniedEvents = [];
    const { on: bobOn } = attachService(nodeB, undefined, createComputeService({})); // no executeFn
    bobOn('compute:chunk-request-denied', (data) => deniedEvents.push(data));

    const { api: aliceApi } = attachService(nodeA, undefined, createComputeService({
      splitFn: (payload) => [payload],
      mergeFn: (results) => results[0],
      dispatchTimeoutMs: 500,
    }));

    const job = await aliceApi.submit({ payload: 1, peers: [bob.podId] });
    assert.equal(job.status, 'failed');
    await waitFor(() => deniedEvents.length > 0, 1000, 'chunk-request-denied to fire with reason no_executor');
    assert.equal(deniedEvents[0].reason, 'no_executor');
  });

  it('a served, authorized request emits chunk-served with ok:true', async () => {
    const alice = await createComputeTestPeer('alice');
    const bob = await createComputeTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    nodeB.registry.grantCapabilities(alice.podId, ['compute:execute']);

    const servedEvents = [];
    const { on: bobOn } = attachService(nodeB, undefined, createComputeService({
      executeFn: async (job) => job.payload * 10,
    }));
    bobOn('compute:chunk-served', (data) => servedEvents.push(data));

    const { api: aliceApi } = attachService(nodeA, undefined, createComputeService({
      splitFn: (payload) => [payload],
      mergeFn: (results) => results[0],
    }));

    const job = await aliceApi.submit({ payload: 4, peers: [bob.podId] });
    assert.equal(job.status, 'completed');
    assert.equal(job.result, 40);

    await waitFor(() => servedEvents.length > 0, 1000, 'chunk-served to fire');
    assert.equal(servedEvents[0].ok, true);
    assert.equal(servedEvents[0].from, alice.podId);
  });
});

// -----------------------------------------------------------------------
// teardown()
// -----------------------------------------------------------------------

describe('createComputeService: teardown', () => {
  it('rejects any still-in-flight dispatches and stops further event delivery', async () => {
    const alice = await createComputeTestPeer('alice');
    const bob = await createComputeTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    nodeB.registry.grantCapabilities(alice.podId, ['compute:execute']);

    // bob's executeFn never resolves -- alice's dispatch stays pending.
    attachService(nodeB, undefined, createComputeService({ executeFn: () => new Promise(() => {}) }));

    // issue #136 fix: a realistic dispatchTimeoutMs (the actual default,
    // not an artificially tiny one) is safe to use here now. Before the
    // fix, FederatedCompute's own #dispatchChunk() retry loop
    // (COMPUTE_DEFAULTS.maxRetries) was NOT cancelled by this service's
    // teardown() -- only the ALREADY in-flight pending dispatch was
    // rejected, and the retry issued right after that created a brand-new,
    // uncancellable setTimeout() that had to actually elapse, forcing this
    // test to shrink dispatchTimeoutMs to 50ms just to stay fast.
    // compute.destroy() (called first inside teardown()) now stops that
    // retry loop from ever issuing another dispatch() once torn down --
    // see the dedicated "genuinely cancels" test below, which proves this
    // directly with a large dispatchTimeoutMs and a sendTo spy.
    const events = [];
    const {
      api: aliceApi, on: aliceOn, teardown,
    } = attachService(nodeA, undefined, createComputeService({
      splitFn: (payload) => [payload],
      mergeFn: (results) => results[0],
      dispatchTimeoutMs: DEFAULT_COMPUTE_DISPATCH_TIMEOUT_MS,
    }));
    aliceOn('compute:failed', (data) => events.push(data));

    const pending = aliceApi.submit({ payload: 1, peers: [bob.podId] });
    await new Promise((r) => setTimeout(r, 5));
    await teardown();

    const job = await pending;
    assert.equal(job.status, 'failed', 'submit() resolves to a failed job once its only worker dispatch is torn down');

    // Event bus closed by teardown() -- nothing further reaches on().
    assert.equal(events.length, 0);
  });

  it('genuinely cancels FederatedCompute\'s retry loop -- no new dispatch attempt is issued after teardown, and the in-flight submit() settles promptly despite a large dispatchTimeoutMs', async () => {
    const alice = await createComputeTestPeer('alice');
    const bob = await createComputeTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    nodeB.registry.grantCapabilities(alice.podId, ['compute:execute']);

    // bob's executeFn never resolves -- bob never sends back a
    // 'compute-response', so alice's default scheduler.dispatch() stays
    // pending until either its own timeout fires or teardown() forces it.
    attachService(nodeB, undefined, createComputeService({ executeFn: () => new Promise(() => {}) }));

    // Spy on nodeA.sendTo to count outbound 'compute-request' envelopes --
    // proves (rather than just asserts) that FederatedCompute's
    // #dispatchChunk() retry loop really stops issuing new dispatch
    // attempts once teardown() runs, mirroring mesh-keepalive.test.mjs's
    // own "no leaked timers" precedent (spy on sendTo, wait past several
    // would-be cycles, assert the count stays put).
    const originalSendTo = nodeA.sendTo.bind(nodeA);
    let requestsSent = 0;
    nodeA.sendTo = async (pubKey, data) => {
      if (data && data.kind === 'compute-request') requestsSent += 1;
      return originalSendTo(pubKey, data);
    };

    const {
      api: aliceApi, teardown,
    } = attachService(nodeA, undefined, createComputeService({
      splitFn: (payload) => [payload],
      mergeFn: (results) => results[0],
      // A large, realistic timeout on purpose: before the fix this alone
      // would have made a leaked post-teardown retry take up to this long
      // (times COMPUTE_DEFAULTS.maxRetries) to finally settle.
      dispatchTimeoutMs: DEFAULT_COMPUTE_DISPATCH_TIMEOUT_MS,
    }));

    const pending = aliceApi.submit({ payload: 1, peers: [bob.podId] });
    await waitFor(() => requestsSent >= 1, 1000, 'first compute-request to be sent');

    const requestsAtTeardown = requestsSent;
    const teardownStart = Date.now();
    await teardown();

    // The in-flight submit() resolves promptly -- NOT after waiting out
    // dispatchTimeoutMs, let alone maxRetries * dispatchTimeoutMs, which is
    // exactly the leak issue #136 describes.
    const job = await pending;
    const elapsed = Date.now() - teardownStart;
    assert.ok(elapsed < 2000, `submit() should resolve promptly after teardown(), took ${elapsed}ms`);
    assert.equal(job.status, 'failed');

    // No further 'compute-request' was sent after teardown, even after
    // waiting well past what would have been a retry cycle -- proof the
    // retry loop's timer/dispatch activity genuinely stopped, not just
    // that this one promise happened to settle.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(requestsSent, requestsAtTeardown, 'no new dispatch attempt was issued after teardown()');
  });
});

// -----------------------------------------------------------------------
// createMeshNode({ enableCompute: true }) -- opt-in surface (issue #118)
// -----------------------------------------------------------------------

function createStubSignalingTransport() {
  return { send() {}, onMessage() {} };
}

describe('createMeshNode({ enableCompute: true })', () => {
  it('leaves node.compute unset and node.services empty of "compute" when enableCompute is omitted', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
    });

    assert.equal(node.compute, undefined);
    assert.equal(node.services.has('compute'), false);
  });

  it('throws clearly when enableCompute is set without computeOptions.executeFn', async () => {
    await assert.rejects(
      () => createMeshNode({
        label: 'alice',
        signalingTransport: createStubSignalingTransport(),
        enableCompute: true,
        skipBoot: true,
      }),
      /computeOptions\.executeFn is required/,
    );
  });

  it('attaches node.compute (== node.services.get("compute")) when enableCompute is set with executeFn', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableCompute: true,
      computeOptions: {
        executeFn: async (job) => job,
      },
      skipBoot: true,
    });

    assert.ok(node.compute, 'node.compute is attached');
    assert.equal(node.compute, node.services.get('compute'));
    assert.equal(typeof node.compute.api.submit, 'function');
    assert.equal(typeof node.compute.api.cancel, 'function');
    assert.equal(typeof node.compute.api.getJob, 'function');
    assert.equal(typeof node.compute.api.listJobs, 'function');
    assert.equal(typeof node.compute.api.getStats, 'function');
  });
});
