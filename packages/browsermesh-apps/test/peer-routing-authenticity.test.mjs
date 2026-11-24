// Run with: node --import ./test/_setup-globals.mjs --test test/peer-routing-authenticity.test.mjs
//
// A routed envelope carries its ORIGINATOR's signature. The final recipient
// and each forwarding hop verify it; what a hop can change (ttl, path) is not
// authority, and what it cannot (origin, recipient, content, id) is signed.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MeshRouter, createMeshRoutingService } from '../src/peer-routing.mjs';
import { attachService } from '../src/mesh-service.mjs';
import { PeerRegistry } from '../src/peer-registry.mjs';
import {
  IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL,
} from '@johnhenry/browsermesh-core';
import { MessageSigner, createMessage } from '@johnhenry/browsermesh-pod';

async function peerOf(label) {
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

/** A pod-message signer over a wallet identity (what the service builds for itself). */
const signerOf = (peer) => new MessageSigner({
  podId: peer.podId,
  sign: (data) => peer.wallet.sign(peer.podId, data),
  rawPublicKey: () => peer.wallet.getPublicKeyBytes(peer.podId),
})

/**
 * A duck-typed bus restricted to explicit edges. A node reports an active
 * session only with the peers it shares an edge with (and not with `refuse`d ones).
 */
function wire(peers, edges) {
  const edgeSet = new Set();
  for (const [a, b] of edges) { edgeSet.add(`${a}|${b}`); edgeSet.add(`${b}|${a}`); }
  const listeners = new Map(peers.map((p) => [p.podId, new Set()]));
  const nodes = {};
  for (const peer of peers) {
    nodes[peer.podId] = {
      podId: peer.podId,
      wallet: peer.wallet,
      registry: peer.registry,
      refuse: new Set(),
      inbox: [],
      onIncomingData(cb) { listeners.get(peer.podId).add(cb); return () => listeners.get(peer.podId).delete(cb); },
      hasActiveSession(id) { return edgeSet.has(`${peer.podId}|${id}`) && !this.refuse.has(id); },
      async sendTo(to, data) {
        if (!edgeSet.has(`${peer.podId}|${to}`)) return;
        const set = listeners.get(to);
        queueMicrotask(() => { for (const cb of set) cb(peer.podId, structuredClone(data)); });
      },
      /** Deliver `data` to `to` as though this node sent it: a hop writing its own bytes. */
      inject(to, data) {
        queueMicrotask(() => { for (const cb of listeners.get(to)) cb(peer.podId, structuredClone(data)); });
      },
    };
    nodes[peer.podId].onIncomingData((from, data) => nodes[peer.podId].inbox.push({ from, data }));
  }
  return nodes;
}

/** Resolves with the next payload of `event` (driven by the service's events, not by the clock). */
function next(on, event) {
  return new Promise((resolve) => { on(event, resolve); });
}
/** Collect the `reason` of every drop. */
function dropsOf(on) {
  const reasons = [];
  const waiting = [];
  on('mesh-routing:drop', (d) => {
    reasons.push(d.reason);
    for (const w of waiting.filter((x) => reasons.length >= x.n)) w.resolve();
  });
  /** Resolves once `n` drops were announced (verification is asynchronous crypto: a count of turns would not do). */
  Object.defineProperty(reasons, 'waitFor', {
    enumerable: false,
    value: (n) => (reasons.length >= n ? Promise.resolve() : new Promise((resolve) => waiting.push({ n, resolve }))),
  });
  return reasons;
}
/** Let queued microtasks and I/O callbacks run: proof that something did NOT happen, not a wait for it. */
async function settle() { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); }

/** alice -> (bob) -> carol; alice has a route to carol via bob. Bob is a bare node unless `bobService`. */
async function setup({ bobService = false, alice: aliceOpts = {}, carol: carolOpts = {}, bobOpts = {} } = {}) {
  const alice = await peerOf('alice');
  const bob = await peerOf('bob');
  const carol = await peerOf('carol');
  const mesh = wire([alice, bob, carol], [[alice.podId, bob.podId], [bob.podId, carol.podId]]);
  const nodeA = mesh[alice.podId];
  const nodeB = mesh[bob.podId];
  const nodeC = mesh[carol.podId];
  // This file is about the signed, readable envelope: end-to-end sealing (and the key requests it makes) is
  // off here and has its own file, peer-routing-sealed.test.mjs.
  const a = attachService(nodeA, undefined, createMeshRoutingService({ sealing: false, ...aliceOpts }));
  const c = attachService(nodeC, undefined, createMeshRoutingService({ sealing: false, ...carolOpts }));
  const b = bobService ? attachService(nodeB, undefined, createMeshRoutingService({ sealing: false, ...bobOpts })) : null;
  b?.api.addDirectPeer(carol.podId);
  a.api.addRoute(carol.podId, bob.podId, 2);
  return { alice, bob, carol, nodeA, nodeB, nodeC, a, b, c };
}

/** The envelope alice sent towards carol, as bob received it. */
async function captureAtBob(world, message = { hello: 'world' }) {
  const arrived = new Promise((resolve) => world.nodeB.onIncomingData((from, data) => { if (data?.type === 'mesh-routing') resolve(data); }));
  world.a.api.route(world.carol.podId, message);
  return arrived;
}

describe('routed envelopes are signed by the originator', () => {
  it('a message through an honest hop arrives with the originator proven', async () => {
    const w = await setup({ bobService: true });
    const got = next(w.c.on, 'mesh-routing:message');
    w.a.api.route(w.carol.podId, { hello: 'world' });
    const msg = await got;
    assert.equal(msg.from, w.alice.podId);
    assert.equal(msg.to, w.carol.podId);
    assert.deepEqual(msg.message, { hello: 'world' });
    assert.equal(msg.authenticated, true);
    assert.equal(typeof msg.id, 'string');
    assert.deepEqual(msg.path, [w.alice.podId, w.bob.podId], 'the path is passed on as a diagnostic hint');
  });

  it('a hop that writes a message "from" someone else is not believed', async () => {
    const w = await setup();
    const delivered = [];
    w.c.on('mesh-routing:message', (m) => delivered.push(m));
    const reasons = dropsOf(w.c.on);
    // Unsigned, claiming to be alice.
    w.nodeB.inject(w.carol.podId, { type: 'mesh-routing', from: w.alice.podId, to: w.carol.podId, ttl: 5, message: 'forged', path: [w.alice.podId] });
    // Signed by bob's own key, claiming to be alice.
    const signed = await signerOf(w.bob).sign(createMessage({
      from: w.alice.podId, to: w.carol.podId, payload: { kind: 'mesh-routed/v1', id: 'x', message: 'forged' },
    }));
    w.nodeB.inject(w.carol.podId, { type: 'mesh-routing', from: w.alice.podId, to: w.carol.podId, ttl: 5, message: 'forged', path: [w.alice.podId], id: 'x', signed });
    await reasons.waitFor(2);
    assert.deepEqual(delivered, []);
    assert.deepEqual(reasons.sort(), ['sender-mismatch', 'unsigned']);
  });

  it('a hop cannot change the content, the origin or the recipient of what the originator signed', async () => {
    const w = await setup();
    const delivered = [];
    w.c.on('mesh-routing:message', (m) => delivered.push(m));
    const reasons = dropsOf(w.c.on);
    const env = await captureAtBob(w);

    // New content inside the signed part.
    const content = structuredClone(env)
    content.signed.payload.message = { hello: 'tampered' }
    w.nodeB.inject(w.carol.podId, content);
    // A different recipient than the one that was signed.
    const readdressed = { ...structuredClone(env), to: w.alice.podId }
    w.nodeB.inject(w.carol.podId, readdressed);
    // A different originator.
    const reorigin = structuredClone(env)
    reorigin.signed.from = w.bob.podId
    w.nodeB.inject(w.carol.podId, reorigin);
    await reasons.waitFor(3);
    assert.deepEqual(delivered, []);
    assert.deepEqual(reasons.sort(), ['bad-signature', 'sender-mismatch', 'wrong-recipient']);

    // What the hop CAN change (the unsigned `message`, `from`, `path`, `ttl`) changes nothing that is delivered.
    const cosmetic = { ...structuredClone(env), message: 'something else', from: w.bob.podId, path: ['x', 'y', 'z'], ttl: 3 }
    const got = next(w.c.on, 'mesh-routing:message');
    w.nodeB.inject(w.carol.podId, cosmetic);
    const msg = await got;
    assert.equal(msg.from, w.alice.podId);
    assert.deepEqual(msg.message, { hello: 'world' });
    assert.equal(msg.authenticated, true);
  });

  it('a hop that replays an envelope gets it delivered once', async () => {
    const w = await setup();
    const delivered = [];
    w.c.on('mesh-routing:message', (m) => delivered.push(m));
    const reasons = dropsOf(w.c.on);
    const env = await captureAtBob(w);
    w.nodeB.inject(w.carol.podId, env);
    w.nodeB.inject(w.carol.podId, env);
    w.nodeB.inject(w.carol.podId, env);
    await reasons.waitFor(2);
    assert.equal(delivered.length, 1);
    assert.deepEqual(reasons, ['replay', 'replay']);
  });

  it('a forwarding hop drops what does not verify instead of passing it on', async () => {
    const w = await setup({ bobService: true });
    const forwarded = [];
    w.b.on('mesh-routing:forward', (e) => forwarded.push(e));
    const reasons = dropsOf(w.b.on);
    const delivered = [];
    w.c.on('mesh-routing:message', (m) => delivered.push(m));
    // Alice's own envelope, captured on its way to bob, then altered before bob sees it.
    const good = next(w.b.on, 'mesh-routing:forward');
    const arrived = next(w.c.on, 'mesh-routing:message');
    w.a.api.route(w.carol.podId, { n: 1 });
    await good;
    await arrived; // carol verifies asynchronously: wait for the event, not for a number of turns
    assert.equal(delivered.length, 1);

    const sent = [];
    const tamper = (mutate) => {
      const env = { type: 'mesh-routing', from: w.alice.podId, to: w.carol.podId, ttl: 5, message: { n: 2 }, path: [w.alice.podId] };
      return mutate(env);
    };
    sent.push(tamper((e) => e)); // unsigned
    w.nodeA.inject(w.bob.podId, sent[0]);
    await reasons.waitFor(1);
    assert.equal(forwarded.length, 1, 'only the genuine one was forwarded');
    assert.deepEqual(reasons, ['unsigned']);
    assert.equal(delivered.length, 1);
  });

  it('a hop only forwards what arrived over a link it has', async () => {
    const w = await setup({ bobService: true });
    const reasons = dropsOf(w.b.on);
    const delivered = [];
    w.c.on('mesh-routing:message', (m) => delivered.push(m));
    // The session with alice is gone by the time the data is handled.
    w.nodeB.refuse.add(w.alice.podId);
    w.a.api.route(w.carol.podId, { n: 1 });
    await reasons.waitFor(1);
    await settle();
    assert.deepEqual(reasons, ['no-link']);
    assert.deepEqual(delivered, []);
  });

  it('TTL still ends a message that has gone far enough', async () => {
    const w = await setup({ bobService: true, alice: { maxTTL: 1 } });
    const delivered = [];
    w.c.on('mesh-routing:message', (m) => delivered.push(m));
    const reasons = dropsOf(w.b.on);
    w.a.api.route(w.carol.podId, { n: 1 });
    await reasons.waitFor(1); // bob verifies, decrements the ttl to 0 and says so
    await settle();
    assert.deepEqual(reasons, ['ttl-expired']);
    assert.deepEqual(delivered, []);
  });

  it('the path a hop reports is bounded and never used to decide anything', async () => {
    const w = await setup();
    const env = await captureAtBob(w);
    const got = next(w.c.on, 'mesh-routing:message');
    w.nodeB.inject(w.carol.podId, { ...env, path: Array.from({ length: 500 }, (_, i) => `hop-${i}`) });
    const msg = await got;
    assert.ok(msg.path.length <= 33, `path length ${msg.path.length}`);
    assert.equal(msg.from, w.alice.podId);
  });
});

describe('older peers and unsigned envelopes', () => {
  it('unsigned envelopes are refused by default and delivered, marked, when allowUnsigned is set', async () => {
    const strict = await setup();
    const lax = await setup({ carol: { allowUnsigned: true } });
    for (const w of [strict, lax]) {
      w.delivered = [];
      w.c.on('mesh-routing:message', (m) => w.delivered.push(m));
      w.nodeB.inject(w.carol.podId, { type: 'mesh-routing', from: w.alice.podId, to: w.carol.podId, ttl: 5, message: 'old style', path: [w.alice.podId] });
    }
    const reasons = dropsOf(strict.c.on);
    await reasons.waitFor(1);
    assert.deepEqual(reasons, ['unsigned']);
    assert.deepEqual(strict.delivered, []);
    assert.deepEqual(lax.delivered.map((m) => [m.message, m.authenticated]), [['old style', false]]);
    void reasons;
  });

  it('a signed envelope still reaches an older recipient and passes an older hop: the signature rides in an extra field', async () => {
    // An older router (no signer, no verification) reads from/to/ttl/message/path and passes the rest on.
    const w = await setup();
    const env = await captureAtBob(w);
    assert.equal(env.from, w.alice.podId);
    assert.equal(env.to, w.carol.podId);
    assert.deepEqual(env.message, { hello: 'world' });
    // What an older hop does with an envelope (the code this release replaces): decrement ttl, append itself, spread the rest.
    const passedOn = { ...env, ttl: env.ttl - 1, path: [...env.path, w.bob.podId] };
    const got = next(w.c.on, 'mesh-routing:message');
    w.nodeB.inject(w.carol.podId, passedOn);
    const msg = await got;
    assert.equal(msg.from, w.alice.podId);
    assert.equal(msg.authenticated, true);
  });

  it('a hop that has no signer of its own still verifies and forwards a signed envelope, rebuilt from the signed fields', async () => {
    const w = await setup();
    const env = await captureAtBob(w);
    const forwards = [];
    const hop = new MeshRouter({ localPodId: w.bob.podId, forwardFn: (to, e) => forwards.push({ to, e }) });
    hop.addDirectPeer(w.carol.podId);
    await hop.handleRoutedMessage({ ...env, from: 'someone-else', message: 'swapped' });
    assert.equal(forwards.length, 1);
    assert.equal(forwards[0].e.from, w.alice.podId, 'the top-level copies are rewritten from the signed ones');
    assert.deepEqual(forwards[0].e.message, { hello: 'world' });
    assert.ok(forwards[0].e.signed);
  });

  it('a bare MeshRouter (no signer) behaves as before', () => {
    const forwards = [];
    const router = new MeshRouter({ localPodId: 'a', forwardFn: (hop, e) => forwards.push({ hop, e }) });
    router.addDirectPeer('b');
    router.route('b', { x: 1 });
    assert.equal(forwards.length, 1);
    assert.equal(forwards[0].e.signed, undefined);
    const got = [];
    router.on('message', (m) => got.push(m));
    router.handleRoutedMessage({ from: 'b', to: 'a', ttl: 3, message: 'hi', path: ['b'] });
    assert.equal(got.length, 1);
    assert.equal(got[0].authenticated, false);
  });
});
