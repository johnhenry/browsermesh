// Run with: node --import ./test/_setup-globals.mjs --test test/wsh-negotiator.test.mjs
//
// Selection: wsh is off by default, an explicit option turns it on, and a
// `require` setting never falls back to anything unsealed.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  TRANSPORT_TYPES,
  MeshTransportNegotiator,
  MockMeshTransport,
  TransportFactory,
  createWshTransportFactory,
  WshLink,
  WshLinkError,
} from '../src/index.mjs';
import { waitFor } from './_wait.mjs';
import { makeEnv, makeIdentities, makeHub } from './helpers/wsh-rig.mjs';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) { try { await cleanups.pop()(); } catch { /* best effort */ } }
});

describe('wsh selection', () => {
  it("adds 'wsh' as a type without putting it in the default preference order", () => {
    assert.ok(TRANSPORT_TYPES.includes('wsh'));
    assert.deepEqual(new MeshTransportNegotiator().preferenceOrder, ['webrtc', 'wsh-wt', 'wsh-ws']);
    assert.deepEqual(new TransportFactory().preferredOrder, ['webrtc', 'wsh-wt', 'wsh-ws']);
  });

  it('a default negotiator never reaches the wsh adapter', async () => {
    const n = new MeshTransportNegotiator();
    let wshCalls = 0;
    n.registerAdapter('wsh', async () => { wshCalls++; return new MockMeshTransport('wsh'); });
    n.registerAdapter('wsh-ws', async () => new MockMeshTransport('wsh-ws'));
    const t = await n.negotiate({ wsh: 'pod-x', 'wsh-ws': 'ws://x' });
    assert.equal(t.type, 'wsh-ws');
    assert.equal(wshCalls, 0);
  });
});

describe('wsh `require` never falls back', () => {
  function negotiator(opts) {
    const calls = [];
    const n = new MeshTransportNegotiator(opts);
    n.registerAdapter('wsh', async () => { calls.push('wsh'); throw new WshLinkError('WSH_REFUSED', 'no'); });
    n.registerAdapter('webrtc', async () => { calls.push('webrtc'); return new MockMeshTransport('webrtc'); });
    n.registerAdapter('wsh-ws', async () => { calls.push('wsh-ws'); return new MockMeshTransport('wsh-ws'); });
    return { n, calls };
  }
  const endpoints = { wsh: 'pod-x', webrtc: 'pod-x', 'wsh-ws': 'ws://x' };

  it('constructor option: only wsh is tried, and its failure is the failure', async () => {
    const { n, calls } = negotiator({ require: 'wsh' });
    await assert.rejects(n.negotiate(endpoints), (e) => e instanceof WshLinkError && e.code === 'WSH_REFUSED');
    assert.deepEqual(calls, ['wsh']);
  });

  it('per call: the third argument', async () => {
    const { n, calls } = negotiator();
    await assert.rejects(n.negotiate(endpoints, undefined, { require: 'wsh' }), (e) => e.code === 'WSH_REFUSED');
    assert.deepEqual(calls, ['wsh']);
  });

  it('fails closed when wsh is required but no wsh adapter or endpoint exists', async () => {
    const n = new MeshTransportNegotiator({ require: 'wsh' });
    n.registerAdapter('webrtc', async () => new MockMeshTransport('webrtc'));
    await assert.rejects(n.negotiate({ webrtc: 'pod-x' }), /wsh/);
    n.registerAdapter('wsh', async () => new MockMeshTransport('wsh'));
    await assert.rejects(n.negotiate({ webrtc: 'pod-x' }), /wsh/, 'no wsh endpoint given');
  });

  it('without `require`, a preference order that lists wsh first falls through (the caller listed the others)', async () => {
    const { n, calls } = negotiator({ preferenceOrder: ['wsh', 'webrtc'] });
    const t = await n.negotiate(endpoints);
    assert.equal(t.type, 'webrtc');
    assert.deepEqual(calls, ['wsh', 'webrtc']);
  });

  it('rejects a `require` that names an unknown type', () => {
    assert.throws(() => new MeshTransportNegotiator({ require: 'telnet' }), /Unknown transport type/);
  });
});

describe('an older peer with no wsh transport', () => {
  it('is unaffected; a negotiator that allows it links over the existing transport, one that requires wsh does not', async () => {
    const env = await makeEnv();
    cleanups.push(() => env.close());
    const [ia, iold] = await makeIdentities(2);
    const A = makeHub(env, ia, { allow: [iold.podId], connectTimeoutMs: 120, reconnect: { maxAttempts: 0 } });
    cleanups.push(() => A.close());
    await A.listen();

    const build = (opts) => {
      const n = new MeshTransportNegotiator(opts);
      n.registerAdapter('wsh', createWshTransportFactory(A));
      n.registerAdapter('wsh-ws', async () => new MockMeshTransport('wsh-ws'));
      return n;
    };
    const endpoints = { wsh: iold.podId, 'wsh-ws': 'ws://old.example' };

    const fallback = await build({ preferenceOrder: ['wsh', 'wsh-ws'] }).negotiate(endpoints);
    assert.equal(fallback.type, 'wsh-ws', 'nobody answered the wsh dial; the existing transport is used');

    await assert.rejects(build({ require: 'wsh' }).negotiate(endpoints), (e) => e.code === 'WSH_UNREACHABLE');
  });
});

describe('the wsh transport object', () => {
  async function pair() {
    const env = await makeEnv();
    cleanups.push(() => env.close());
    const ids = await makeIdentities(2);
    const [A, B] = ids.map((id, i) => {
      const h = makeHub(env, id, { allow: [ids[1 - i].podId] });
      cleanups.push(() => h.close());
      return h;
    });
    await A.listen();
    await B.listen();
    return { ids, A, B };
  }

  it('the negotiator factory connects, reports the authenticated peer, and carries data', async () => {
    const { ids, A, B } = await pair();
    const n = new MeshTransportNegotiator({ require: 'wsh' });
    n.registerAdapter('wsh', createWshTransportFactory(A));
    const t = await n.negotiate({ wsh: ids[1].podId });
    assert.ok(t instanceof WshLink);
    assert.equal(t.type, 'wsh');
    assert.equal(t.peerPodId, ids[1].podId);
    assert.equal(t.sealed, true);
    assert.equal(t.connected, true);
    assert.equal(t.state, 'connected');

    const got = [];
    B.on('message', (m) => got.push(m));
    await t.send('x');
    await waitFor(() => got.length === 1);
    assert.equal(got[0].from, ids[0].podId);

    const back = [];
    t.onMessage((d) => back.push(d));
    B.send(ids[0].podId, 'reply');
    await waitFor(() => back.length === 1);
    assert.equal(back[0], 'reply');

    let closed = 0;
    t.onClose(() => closed++);
    await t.close();
    assert.equal(t.state, 'closed');
    assert.equal(closed, 1);
    await assert.rejects(Promise.resolve().then(() => t.send('late')), (e) => e.code === 'WSH_CLOSED');
  });

  it('TransportFactory.create("wsh") returns an unconnected link that dials on connect()', async () => {
    const { ids, A, B } = await pair();
    const f = new TransportFactory();
    const t = await f.create('wsh', { links: A, peerPodId: ids[1].podId });
    assert.equal(t.type, 'wsh');
    assert.equal(t.connected, false);
    await t.connect();
    assert.equal(t.connected, true);
    await waitFor(() => B.isConnected(ids[0].podId));
    assert.equal(f.getSupportedTypes().includes('wsh'), false, 'not offered unless asked for');
  });

  it('surfaces a peer going away as onClose and a failure as onError', async () => {
    const { ids, A, B } = await pair();
    const t = new WshLink(A, ids[1].podId);
    await t.connect();
    const events = [];
    t.on('close', (e) => events.push(['close', e?.reason]));
    t.on('error', (e) => events.push(['error', e?.code]));
    await waitFor(() => B.isConnected(ids[0].podId));
    await B.close();
    await waitFor(() => events.some(([k]) => k === 'close'));
    assert.equal(t.connected, false);
  });
});
