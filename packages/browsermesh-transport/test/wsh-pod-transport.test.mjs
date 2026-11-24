// Run with: node --import ./test/_setup-globals.mjs --test test/wsh-pod-transport.test.mjs
//
// 1. The shared TransportAdapter conformance suite that every pod transport
//    runs (`browsermesh-pod/test/helpers/transport-conformance.mjs`), run
//    against WshPodTransport and, for parity, against EventEmitterTransport.
// 2. Two real `Pod`s linked over wsh through an in-process pipe relay.
import { describe, it, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

import { Pod, EventEmitterTransport, POD_MESSAGE, POD_RPC_REQUEST, POD_RPC_RESPONSE, createRpcRequest, createRpcResponse } from '@johnhenry/browsermesh-pod';
import { PodIdentity } from '@johnhenry/browsermesh-primitives';
import { runTransportConformance } from '../../browsermesh-pod/test/helpers/transport-conformance.mjs';
import { WshPodTransport } from '../src/index.mjs';
import { waitFor, settle } from './_wait.mjs';
import { RELAY, makeEnv, makeIdentities } from './helpers/wsh-rig.mjs';

// ---------------------------------------------------------------------------
// 1. Conformance
// ---------------------------------------------------------------------------

const envs = [];
after(async () => { await Promise.allSettled(envs.map((e) => e.close())); });
function transportFor(env, identity, allowed, peers = []) {
  return new WshPodTransport({
    identity,
    relays: [RELAY],
    WebSocket: env.WebSocket,
    authorize: (p) => allowed.includes(p.podId),
    peers,
    awaitPeers: true,
    connectTimeoutMs: 4000,
    reconnect: { baseMs: 5, maxMs: 25 },
  });
}

runTransportConformance(
  'WshPodTransport',
  () => {
    // Created synchronously by the suite; identity and env arrive lazily through a deferred inner transport.
    return deferred(async () => {
      const env = await makeEnv();
      envs.push(env);
      const [id] = await makeIdentities(1);
      return transportFor(env, id, []);
    });
  },
  {
    // Each pair gets its own relay and its own keys. b dials a; c dials a and b, in the order the suite opens them.
    makePair: () => {
      const state = deferredPair();
      return state;
    },
    deliveryWaitMs: 400,
    // The adapter stamps `from` with the key the session authenticated, so the suite names that id.
    senderId: (t) => t._real.links.podId,
  },
);

runTransportConformance(
  'EventEmitterTransport (parity reference)',
  () => new EventEmitterTransport(),
  {
    makePair: () => {
      const bus = EventEmitterTransport.createBus();
      return { a: new EventEmitterTransport(bus), b: new EventEmitterTransport(bus), c: new EventEmitterTransport(bus) };
    },
  },
);

/**
 * The suite's factories are synchronous but identities and the relay are made
 * asynchronously, so each transport the suite sees is a thin shell whose first
 * `open()` builds the real one. Everything the contract observes (`ready`,
 * `onMessage`, `send`, `open`, `close`) is forwarded.
 */
function deferred(build) {
  let real = null;
  let building = null;
  let handler = null;
  let closed = false;
  const ensure = () => (building ??= build().then((t) => { real = t; if (handler) t.onMessage(handler); return t; }));
  return {
    get ready() { return real?.ready ?? false; },
    onMessage(h) { handler = h; real?.onMessage(h); },
    async open() { if (closed) return; const t = await ensure(); await t.open(); },
    send(msg) { real?.send(msg); },
    async close() { closed = true; if (building) await (await building).close(); },
    get _real() { return real; },
  };
}

function deferredPair() {
  let env;
  let ids;
  const ready = (async () => {
    env = await makeEnv();
    envs.push(env);
    ids = await makeIdentities(3);
  })();
  const names = ['a', 'b', 'c'];
  const shells = names.map((name, i) => deferred(async () => {
    await ready;
    const others = ids.filter((_, j) => j !== i).map((x) => x.podId);
    // b dials a; c dials a and b. (The suite opens a, then b, then c.)
    const peers = i === 0 ? [] : ids.slice(0, i).map((x) => x.podId);
    return transportFor(env, ids[i], others, peers);
  }));
  return {
    a: shells[0], b: shells[1], c: shells[2],
    cleanup: async () => { await Promise.allSettled(shells.map((s) => s.close())); await env?.close(); },
  };
}

// ---------------------------------------------------------------------------
// 2. Two real pods
// ---------------------------------------------------------------------------

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) { try { await cleanups.pop()(); } catch { /* best effort */ } }
});

async function twoPods(extra = {}) {
  const env = await makeEnv();
  cleanups.push(() => env.close());
  const [ia, ib] = await Promise.all([PodIdentity.generate(), PodIdentity.generate()]);
  const ta = new WshPodTransport({ identity: ia, relays: [RELAY], WebSocket: env.WebSocket, authorize: (p) => p.podId === ib.podId, awaitPeers: true, ...extra.a });
  const tb = new WshPodTransport({ identity: ib, relays: [RELAY], WebSocket: env.WebSocket, authorize: (p) => p.podId === ia.podId, peers: [ia.podId], awaitPeers: true, ...extra.b });
  const a = new Pod();
  const b = new Pod();
  const got = { a: [], b: [] };
  a.on('message', (m) => got.a.push(m));
  b.on('message', (m) => got.b.push(m));
  // a boots first and listens; b boots, dials a, and says hello over the link.
  await a.boot({ identity: ia, transport: ta, discoveryTimeout: 30 });
  await b.boot({ identity: ib, transport: tb, discoveryTimeout: 30 });
  cleanups.push(() => b.shutdown({ silent: true }), () => a.shutdown({ silent: true }));
  return { env, a, b, ia, ib, ta, tb, got };
}

describe('two pods over a wsh link', () => {
  it('discover each other through the real hello handshake', async () => {
    const { a, b, ia, ib } = await twoPods();
    await waitFor(() => a.peers.has(ib.podId) && b.peers.has(ia.podId), { label: 'both pods know each other' });
  });

  it('exchange messages both ways, with the sender being the authenticated key', async () => {
    const { a, b, ia, ib, got } = await twoPods();
    await waitFor(() => a.peers.has(ib.podId) && b.peers.has(ia.podId));
    a.send(ib.podId, { n: 1 });
    b.send(ia.podId, { n: 2 });
    await waitFor(() => got.b.length === 1 && got.a.length === 1);
    assert.equal(got.b[0].type, POD_MESSAGE);
    assert.equal(got.b[0].from, ia.podId);
    assert.equal(got.b[0].authenticated, true);
    assert.deepEqual(got.b[0].payload, { n: 1 });
    assert.equal(got.a[0].from, ib.podId);
    assert.deepEqual(got.a[0].payload, { n: 2 });
  });

  it('carries rpc requests and responses and broadcasts', async () => {
    const { a, b, ia, ib, ta, tb, got } = await twoPods();
    await waitFor(() => a.peers.has(ib.podId) && b.peers.has(ia.podId));
    ta.send(createRpcRequest({ from: ia.podId, to: ib.podId, method: 'echo', params: { x: 1 }, requestId: 'r1' }));
    await waitFor(() => got.b.some((m) => m.type === POD_RPC_REQUEST));
    tb.send(createRpcResponse({ from: ib.podId, to: ia.podId, requestId: 'r1', result: { x: 1 } }));
    await waitFor(() => got.a.some((m) => m.type === POD_RPC_RESPONSE));
    a.broadcast('everyone');
    await waitFor(() => got.b.some((m) => m.payload === 'everyone'));
    assert.equal(got.b.find((m) => m.payload === 'everyone').to, '*');
  });

  it('drops a message that names a different sender, and delivers nothing of it', async () => {
    const { a, b, ia, ib, ta, got } = await twoPods();
    await waitFor(() => a.peers.has(ib.podId) && b.peers.has(ia.podId));
    const dropped = [];
    const tb = b.transport;
    tb.on('dropped', (d) => dropped.push(d));
    // `a` writes a message claiming to be from the third pod, and a hello claiming another pod id.
    ta.send({ type: POD_MESSAGE, from: 'a-third-pod', to: ib.podId, payload: 'spoof' });
    ta.send({ type: 'pod:hello', podId: 'a-third-pod', kind: 'tab' });
    ta.send({ type: POD_MESSAGE, from: ia.podId, to: ib.podId, payload: 'honest' });
    await waitFor(() => got.b.some((m) => m.payload === 'honest'));
    assert.equal(got.b.some((m) => m.payload === 'spoof'), false);
    assert.equal(b.peers.has('a-third-pod'), false);
    assert.equal(dropped.length, 2);
    assert.ok(dropped.every((d) => d.reason === 'foreign-sender'));
  });

  it('hands the pod the link-authenticated sender, so unsigned messages over the link are accepted as that peer and nothing else is', async () => {
    const { a, b, ia, ib, ta, got } = await twoPods();
    await waitFor(() => a.peers.has(ib.podId) && b.peers.has(ia.podId));
    // Raw frames, as a pod without signing would send them.
    ta.send({ type: POD_MESSAGE, from: ia.podId, to: ib.podId, payload: 'unsigned' });
    ta.send(createRpcRequest({ from: ia.podId, to: ib.podId, method: 'echo', requestId: 'u1' }));
    await waitFor(() => got.b.some((m) => m.payload === 'unsigned') && got.b.some((m) => m.type === POD_RPC_REQUEST));
    const plain = got.b.find((m) => m.payload === 'unsigned');
    assert.equal(plain.from, ia.podId);
    assert.equal(plain.authenticated, true, 'the link, not a signature, authenticated it');
    assert.equal(b.dropped.unsigned, 0);
    assert.equal(b.dropped['unsigned-rpc'], 0);
  });

  it('pods that sign (the default) interoperate over the link', async () => {
    const { a, b, ia, ib, got } = await twoPods();
    await waitFor(() => a.peers.has(ib.podId) && b.peers.has(ia.podId));
    await a.send(ib.podId, 'signed');
    await waitFor(() => got.b.some((m) => m.payload === 'signed'));
    assert.equal(got.b.find((m) => m.payload === 'signed').authenticated, true);
    assert.equal(b.dropped['bad-signature'], 0);
  });

  it('a pod whose link goes away is removed from its peer (goodbye is synthesized)', async () => {
    const { a, b, ia, ib } = await twoPods();
    await waitFor(() => a.peers.has(ib.podId) && b.peers.has(ia.podId));
    await b.transport.close();
    await waitFor(() => !a.peers.has(ib.podId), { label: 'a forgot b' });
  });

  it('does not deliver anything from a peer the registry does not allow', async () => {
    const env = await makeEnv();
    cleanups.push(() => env.close());
    const [ia, ib] = await makeIdentities(2);
    const ta = new WshPodTransport({ identity: ia, relays: [RELAY], WebSocket: env.WebSocket, authorize: () => false });
    const tb = new WshPodTransport({ identity: ib, relays: [RELAY], WebSocket: env.WebSocket, authorize: () => true, peers: [ia.podId], awaitPeers: true, reconnect: { maxAttempts: 0 } });
    cleanups.push(() => ta.close(), () => tb.close());
    const seen = [];
    ta.onMessage((m) => seen.push(m));
    await ta.open();
    await tb.open();
    tb.send({ type: POD_MESSAGE, to: ia.podId, payload: 'knock' });
    await settle(() => seen.length, { quietFor: 100 });
    assert.deepEqual(seen, []);
  });
});
