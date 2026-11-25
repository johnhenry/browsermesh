// Run with: node --import ./test/_setup-globals.mjs --test test/wsh-links.test.mjs
//
// Two pods linked over wsh through an in-process pipe relay: no network, no
// sockets, the real wsh handshake, key login and sealed session end to end.
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { WshLinkError, rendezvousId, usernameForPodId } from '../src/wsh.mjs';
import { waitFor, settle } from './_wait.mjs';
import { RELAY, makeEnv, makeIdentities, makeHub, bytesContain, concatRecorded } from './helpers/wsh-rig.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) { try { await cleanups.pop()(); } catch { /* best effort */ } }
});
async function rig(n = 2, hubOpts = {}) {
  const env = await makeEnv();
  cleanups.push(() => env.close());
  const ids = await makeIdentities(n);
  const hubs = ids.map((id, i) => {
    const others = ids.filter((_, j) => j !== i).map((o) => o.podId);
    const opts = typeof hubOpts === 'function' ? hubOpts(i, ids) : hubOpts;
    const h = makeHub(env, id, { allow: others, ...opts });
    cleanups.push(() => h.close());
    return h;
  });
  return { env, ids, hubs };
}

describe('wsh link: two pods, both ways', () => {
  it('links through a pipe relay and exchanges text, binary and objects both ways', async () => {
    const { ids, hubs: [A, B] } = await rig();
    await A.listen();
    await B.listen();
    await A.connect(ids[1].podId);
    await waitFor(() => B.isConnected(ids[0].podId), { label: 'B sees A' });

    A.send(ids[1].podId, 'hello from A');
    B.send(ids[0].podId, { n: 1, text: 'from B' });
    A.send(ids[1].podId, new Uint8Array([1, 2, 3, 250]));
    await waitFor(() => B.of('message').length === 2 && A.of('message').length === 1, { label: 'delivered' });

    const atB = B.of('message');
    assert.equal(atB[0].from, ids[0].podId);
    assert.equal(atB[0].data, 'hello from A');
    assert.deepEqual([...atB[1].data], [1, 2, 3, 250]);
    const atA = A.of('message');
    assert.equal(atA[0].from, ids[1].podId);
    assert.deepEqual(JSON.parse(atA[0].data), { n: 1, text: 'from B' });
  });

  it('reports peer-up once per side, with who dialled', async () => {
    const { ids, hubs: [A, B] } = await rig();
    await A.listen();
    await B.listen();
    await A.connect(ids[1].podId);
    await waitFor(() => B.of('peer-up').length === 1);
    assert.equal(A.of('peer-up').length, 1);
    assert.equal(A.of('peer-up')[0].podId, ids[1].podId);
    assert.equal(A.of('peer-up')[0].initiator, 'local');
    assert.equal(B.of('peer-up')[0].podId, ids[0].podId);
    assert.equal(B.of('peer-up')[0].initiator, 'remote');
    assert.deepEqual(A.peers(), [ids[1].podId]);
  });

  it('refuses to dial itself', async () => {
    const { ids, hubs: [A] } = await rig(1);
    await A.listen();
    await assert.rejects(() => A.connect(ids[0].podId), /itself/);
  });

  it('is closed by close(): peers see it go and nothing is left registered at the relay', async () => {
    const { env, ids, hubs: [A, B] } = await rig();
    await A.listen();
    await B.listen();
    await A.connect(ids[1].podId);
    await waitFor(() => B.isConnected(ids[0].podId));
    await A.close();
    await waitFor(() => B.of('peer-down').length === 1, { label: 'B sees A leave' });
    assert.equal(B.isConnected(ids[0].podId), false);
    await B.close();
    await waitFor(() => env.stats().waiting === 0, { label: 'relay empty' });
  });
});

describe('wsh link: a waiting host half', () => {
  // wsh 0.54 ends a connection that has not logged in `loginTimeoutMs` (default 60 s) after the host accepted it. A host half is
  // accepted when it reaches the relay, long before an operator pairs with it, so it must not carry that deadline.
  it('is not closed by wsh\'s login deadline while nobody has paired with it', async () => {
    // A socket that stands in for the relay's: it never receives anything, and says when the host wrote to it (the host speaks first,
    // as soon as it has accepted the socket) and when it was closed.
    const sockets = [];
    const socketFactory = () => {
      const s = new EventTarget();
      Object.assign(s, { readyState: 1, binaryType: 'arraybuffer', sent: 0, closed: false, send() { s.sent++; }, close() { s.closed = true; s.readyState = 3; s.dispatchEvent(new Event('close')); } });
      sockets.push(s);
      return s;
    };
    const { hubs: [A] } = await rig(1, { socketFactory });
    let waiting = 0;
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      await A.listen();
      for (let i = 0; sockets.length === 0 || sockets.some((s) => s.sent === 0); i++) {
        if (i > 10_000) throw new Error('the host never accepted the waiting half');
        await new Promise((r) => setImmediate(r));
      }
      waiting = sockets.length;
      mock.timers.tick(61_000);
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
      mock.timers.tick(1_000);
      for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    } finally {
      mock.timers.reset();
    }
    assert.deepEqual(A.of('refused'), [], 'no login-timeout refusal was reported');
    assert.equal(sockets.filter((s) => s.closed).length, 0, 'the host halves are still waiting');
    assert.equal(sockets.length, waiting, 'and none was replaced');
  });
});

describe('wsh link: identity', () => {
  it('refuses a peer whose authenticated key does not hash to the pod id it claims', async () => {
    const { env, ids, hubs: [A, B] } = await rig(2);
    const [liar] = await makeIdentities(1);
    await B.listen();

    // `liar` holds its own key but logs in claiming to be A.
    const wsh = await import('@johnhenry/wsh');
    const { pipeUrl } = await import('@johnhenry/wsh/pipe-relay');
    const client = new wsh.WshClient({ transportFactories: { ws: () => new wsh.WebSocketTransport({ WebSocket: env.WebSocket }), wt: () => { throw new Error('no wt'); } } });
    const rid = await rendezvousId(ids[1].podId);
    await assert.rejects(
      client.connect(pipeUrl(RELAY, rid), {
        username: usernameForPodId(ids[0].podId), keyPair: liar.keyPair, transport: 'ws',
        expectHostKey: wsh.podIdToFingerprint(ids[1].podId), sealSession: true, requireChannelBinding: true,
      }),
    );
    await waitFor(() => B.of('refused').length >= 1, { label: 'B reported the refusal' });
    assert.equal(B.of('refused')[0].reason, 'identity-mismatch');
    assert.equal(B.of('peer-up').length, 0, 'no link');
    assert.equal(B.of('message').length, 0, 'no frame');
    assert.deepEqual(B.authorizeCalls, [], 'refused before the registry was asked');
    void A;
  });

  it('refuses a key the registry does not allow, before any mesh frame', async () => {
    const { ids, hubs: [A, B] } = await rig(2, (i) => (i === 1 ? { allow: [] } : {}));
    await A.listen();
    await B.listen();
    await assert.rejects(A.connect(ids[1].podId), (e) => e instanceof WshLinkError && e.code === 'WSH_REFUSED' && e.reason === 'unauthorized');
    assert.deepEqual(B.authorizeCalls, [ids[0].podId], 'the registry was asked exactly once');
    assert.equal(B.of('refused').length, 1);
    assert.equal(B.of('refused')[0].reason, 'unauthorized');
    assert.equal(B.of('peer-up').length, 0);
    assert.equal(B.of('message').length, 0);
    assert.equal(A.isConnected(ids[1].podId), false);
  });

  it('refuses everyone by default (no authorize callback)', async () => {
    const env = await makeEnv();
    cleanups.push(() => env.close());
    const [ia, ib] = await makeIdentities(2);
    const { WshPeerLinks } = await import('../src/wsh.mjs');
    const A = new WshPeerLinks({ identity: ia, relays: [RELAY], WebSocket: env.WebSocket, authorize: () => true });
    const B = new WshPeerLinks({ identity: ib, relays: [RELAY], WebSocket: env.WebSocket });
    cleanups.push(() => A.close(), () => B.close());
    await B.listen();
    await assert.rejects(A.connect(ib.podId), (e) => e.code === 'WSH_REFUSED');
  });

  it('refuses an expired key', async () => {
    const { ids, hubs: [A, B] } = await rig(2, (i) => (i === 1 ? { allow: () => ({ expires: new Date(Date.now() - 60_000).toISOString().replace(/\.\d+Z$/, 'Z') }) } : {}));
    await B.listen();
    await assert.rejects(A.connect(ids[1].podId), (e) => e.code === 'WSH_REFUSED');
    assert.equal(B.of('peer-up').length, 0);
  });

  it('pins the host: a relay that substitutes another host is refused, and no credential was sent', async () => {
    const env = await makeEnv();
    cleanups.push(() => env.close());
    const [ia, ib, im] = await makeIdentities(3);
    const A = makeHub(env, ia, { allow: [ib.podId, im.podId] });
    // M is not B, but the relay hands its host half to anyone dialling B's id.
    const ridB = await rendezvousId(ib.podId);
    const M = makeHub(env, im, {
      allow: [ia.podId],
      socketFactory: (url, { id }) => new env.WebSocket(url.replace(id, ridB)),
    });
    cleanups.push(() => A.close(), () => M.close());
    await M.listen();
    await assert.rejects(A.connect(ib.podId), (e) => e instanceof WshLinkError && e.code === 'WSH_HOSTKEY_MISMATCH');
    assert.deepEqual(M.authorizeCalls, [], 'the substitute never saw a login');
    assert.equal(M.of('refused').length, 0);
    assert.equal(M.of('peer-up').length, 0);
    assert.equal(A.isConnected(ib.podId), false);
    assert.equal(A.of('peer-up').length, 0);
  });

  it('the sender of every message is the session key, whatever the dialler writes', async () => {
    const { ids, hubs: [A, B] } = await rig(2);
    await A.listen();
    await B.listen();
    await A.connect(ids[1].podId);
    await waitFor(() => B.isConnected(ids[0].podId));
    A.send(ids[1].podId, JSON.stringify({ from: 'someone-else', payload: 1 }));
    await waitFor(() => B.of('message').length === 1);
    // The hub delivers raw data with the authenticated sender next to it; a field inside the data is just data.
    assert.equal(B.of('message')[0].from, ids[0].podId);
  });
});

describe('wsh link: the relay sees nothing and can forge nothing', () => {
  async function linked() {
    const r = await rig(2);
    await r.hubs[0].listen();
    await r.hubs[1].listen();
    await r.hubs[0].connect(r.ids[1].podId);
    await waitFor(() => r.hubs[1].isConnected(r.ids[0].podId));
    return r;
  }

  it('a recording relay sees none of the payload, in either direction', async () => {
    const { env, ids, hubs: [A, B] } = await linked();
    const m1 = `MARKER-A-${crypto.randomUUID()}`;
    const m2 = `MARKER-B-${crypto.randomUUID()}`;
    A.send(ids[1].podId, m1);
    B.send(ids[0].podId, m2);
    A.send(ids[1].podId, enc.encode(m1 + '-bin'));
    await waitFor(() => B.of('message').length === 2 && A.of('message').length === 1);
    const all = concatRecorded(env);
    assert.ok(all.length > 0);
    assert.equal(bytesContain(all, enc.encode('MARKER-')), false, 'no marker bytes on the wire');
    // control: the recorder does see the pre-login handshake, so an empty search is meaningful
    assert.equal(bytesContain(all, enc.encode(ids[0].podId)), true, 'the recorder can read cleartext it is given');
    assert.equal(A.of('message')[0].data, m2);
    assert.equal(B.of('message')[0].data, m1);
  });

  for (const [dir, label] of [['host', 'dialler to listener'], ['operator', 'listener to dialler']]) {
    // `dir` names who the relay is writing to: the listening (host) half or the dialling (operator) half.
    const pick = (ids, [A, B]) => (dir === 'host'
      ? { sender: A, receiver: B, toPod: ids[1].podId }
      : { sender: B, receiver: A, toPod: ids[0].podId });

    it(`a flipped byte (${label}) ends the link and delivers nothing forged`, async () => {
      const { env, ids, hubs } = await linked();
      const { sender, receiver, toPod } = pick(ids, hubs);
      const before = receiver.of('message').length;
      let flipped = 0;
      env.tap = ({ to, bytes }) => {
        if (to !== dir || flipped) return undefined;
        flipped++;
        const copy = bytes.slice();
        copy[copy.length >> 1] ^= 0x01; // inside the sealed frame
        return copy;
      };
      sender.send(toPod, 'FORGED-OR-LOST').catch(() => {});
      await waitFor(() => receiver.of('peer-down').length === 1, { label: 'the receiver ends the link' });
      assert.equal(receiver.of('peer-down')[0].reason, 'seal-failed');
      assert.ok(receiver.of('error').some((e) => e.error.code === 'WSH_SEAL_FAILED'), 'surfaced as the mesh error');
      assert.equal(receiver.of('peer-down')[0].error.code, 'WSH_SEAL_FAILED');
      assert.equal(receiver.of('message').length, before, 'nothing was delivered');
      assert.equal(receiver.of('message').some((m) => m.data === 'FORGED-OR-LOST'), false);
    });

    it(`a replayed record (${label}) never delivers a message twice`, async () => {
      const { env, ids, hubs } = await linked();
      const { sender, receiver, toPod } = pick(ids, hubs);
      let done = false;
      env.tap = ({ to, bytes }) => {
        if (to !== dir || done) return undefined;
        done = true;
        return [bytes, bytes.slice()];
      };
      sender.send(toPod, 'ONCE');
      await settle(() => receiver.of('message').length + receiver.of('peer-down').length + receiver.of('error').length, { quietFor: 100 });
      assert.ok(receiver.of('message').filter((m) => m.data === 'ONCE').length <= 1, 'the replay was not delivered');
    });
  }

  it('a byte flipped ANYWHERE in a record never delivers altered data (it ends the link or the frame is dropped)', async () => {
    const probe = await linked();
    const size = (() => {
      let s = 0;
      probe.env.tap = ({ to, bytes }) => { if (to === 'host' && !s) s = bytes.length; return undefined; };
      probe.hubs[0].send(probe.ids[1].podId, 'FLIP-TARGET');
      return () => s;
    })();
    await waitFor(() => size() > 0);
    const length = size();
    for (let pos = 0; pos < length; pos += 9) {
      const { env, ids, hubs: [A, B] } = await linked();
      let done = false;
      env.tap = ({ to, bytes }) => {
        if (to !== 'host' || done) return undefined;
        done = true;
        const copy = bytes.slice();
        copy[Math.min(pos, copy.length - 1)] ^= 0x01;
        return copy;
      };
      A.send(ids[1].podId, 'FLIP-TARGET');
      await settle(() => B.of('message').length + B.of('peer-down').length + B.of('error').length, { quietFor: 40 });
      for (const m of B.of('message')) assert.equal(m.data, 'FLIP-TARGET', `flip at ${pos} delivered something else`);
    }
  });

  it('a plaintext or garbage frame injected by the relay delivers nothing', async () => {
    const { env, ids, hubs: [A, B] } = await linked();
    const first = env.recorded.find((r) => r.to === 'host');
    assert.ok(first, 'captured an early plaintext record');
    let injected = 0;
    env.tap = ({ to, bytes }) => {
      if (to !== 'host' || injected) return undefined;
      injected++;
      const garbage = new Uint8Array(64).fill(0x41);
      return [first.bytes.slice(), garbage, bytes];
    };
    const base = B.of('message').length;
    A.send(ids[1].podId, 'LEGIT').catch(() => {});
    await settle(() => B.of('message').length + B.of('peer-down').length + B.of('error').length, { quietFor: 80 });
    const fresh = B.of('message').slice(base);
    assert.ok(fresh.every((m) => m.data === 'LEGIT'), 'only what the dialler sent');
    assert.ok(!fresh.some((m) => typeof m.data === 'string' && m.data.includes('AAAA')));
  });
});

describe('wsh link: simultaneous dial', () => {
  it('yields exactly one link, the one the lower pod id initiated', async () => {
    const env = await makeEnv();
    cleanups.push(() => env.close());
    const ids = await makeIdentities(2);
    // A barrier so neither side has a link when it decides to dial: both dial for real.
    let arrived = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const beforeDial = async () => { if (++arrived === 2) release(); await gate; };
    const [A, B] = ids.map((id, i) => {
      const h = makeHub(env, id, { allow: [ids[1 - i].podId], beforeDial });
      cleanups.push(() => h.close());
      return h;
    });
    await A.listen();
    await B.listen();
    await Promise.all([A.connect(ids[1].podId), B.connect(ids[0].podId)]);
    await waitFor(() => A.getStats().linksEstablished === 2 && B.getStats().linksEstablished === 2, { label: 'both links were built' });
    await waitFor(() => A.linkCount(ids[1].podId) === 1 && B.linkCount(ids[0].podId) === 1, { label: 'one survives' });

    const lower = ids[0].podId < ids[1].podId ? ids[0].podId : ids[1].podId;
    assert.equal(A.linkInfo(ids[1].podId).initiatorPodId, lower);
    assert.equal(B.linkInfo(ids[0].podId).initiatorPodId, lower);
    for (const h of [A, B]) {
      assert.equal(h.of('peer-up').length, 1, 'peer-up once');
      assert.equal(h.of('peer-down').length, 0, 'the loser is never reported as the peer leaving');
      assert.equal(h.getStats().superseded, 1);
    }
    A.send(ids[1].podId, 'a->b');
    B.send(ids[0].podId, 'b->a');
    await waitFor(() => B.of('message').some((m) => m.data === 'a->b') && A.of('message').some((m) => m.data === 'b->a'));
  });
});

describe('wsh link: framing limits', () => {
  it('refuses to send a frame over the local limit and stays usable', async () => {
    const { ids, hubs: [A, B] } = await rig(2, (i) => (i === 0 ? { maxFrameBytes: 4096 } : {}));
    await A.listen();
    await B.listen();
    await A.connect(ids[1].podId);
    await assert.rejects(A.send(ids[1].podId, new Uint8Array(5000)), (e) => e.code === 'WSH_FRAME_TOO_LARGE');
    A.send(ids[1].podId, 'still fine');
    await waitFor(() => B.of('message').length === 1);
  });

  it('a peer that sends over our limit ends the link, and nothing of it is delivered', async () => {
    const { ids, hubs: [A, B] } = await rig(2, (i) => (i === 1 ? { maxFrameBytes: 1024 } : {}));
    await A.listen();
    await B.listen();
    await A.connect(ids[1].podId);
    await waitFor(() => B.isConnected(ids[0].podId));
    A.send(ids[1].podId, new Uint8Array(8192));
    await waitFor(() => B.of('peer-down').length === 1, { label: 'B ends the link' });
    assert.equal(B.of('peer-down')[0].reason, 'frame-too-large');
    assert.equal(B.of('message').length, 0);
    assert.ok(B.of('error').some((e) => e.error.code === 'WSH_FRAME_TOO_LARGE'));
  });
});

describe('wsh link: backpressure', () => {
  it('a slow reader bounds the sender: credit stops, the queue fills, sends are refused', async () => {
    const { ids, hubs: [A, B] } = await rig(2, (i) => (i === 0 ? { maxQueuedBytes: 256 * 1024 } : {}));
    await A.listen();
    await B.listen();
    // B's handler does not return until released: the reader stops pulling.
    let release;
    const gate = new Promise((r) => { release = r; });
    const seen = [];
    B.on('message', ({ data }) => { seen.push(data.length); return gate; });
    await A.connect(ids[1].podId);
    await waitFor(() => B.isConnected(ids[0].podId));

    const chunk = new Uint8Array(64 * 1024);
    let accepted = 0;
    let refused = 0;
    const N = 300; // 18.75 MiB if nothing bounded it
    const pending = [];
    for (let i = 0; i < N; i++) {
      pending.push(A.send(ids[1].podId, chunk).then(() => { accepted++; }, (e) => { assert.equal(e.code, 'WSH_BACKPRESSURE'); refused++; }));
    }
    await settle(() => accepted + refused, { quietFor: 120 });
    assert.ok(refused > 0, 'the sender was refused');
    assert.ok(accepted * chunk.length < 8 * 1024 * 1024, `accepted ${accepted * chunk.length} bytes with the reader stalled`);
    assert.equal(seen.length, 1, 'the reader took one frame and is holding it');

    release();
    await settle(() => seen.length, { quietFor: 150, timeout: 8000 });
    await Promise.allSettled(pending);
    assert.equal(seen.length, accepted, 'everything accepted is delivered, in order, and nothing refused is');
  });

  it('pause() and resume() stop and restart reading', async () => {
    const { ids, hubs: [A, B] } = await rig(2);
    await A.listen();
    await B.listen();
    await A.connect(ids[1].podId);
    await waitFor(() => B.isConnected(ids[0].podId));
    B.pause(ids[0].podId);
    A.send(ids[1].podId, 'one');
    await settle(() => B.of('message').length, { quietFor: 80 });
    assert.equal(B.of('message').length, 0);
    B.resume(ids[0].podId);
    await waitFor(() => B.of('message').length === 1);
  });
});

describe('wsh link: reconnect', () => {
  it('redials a kept peer after the relay drops everything, and the listener registers again', async () => {
    const { env, ids, hubs: [A, B] } = await rig(2);
    await A.listen();
    await B.listen();
    await A.connect(ids[1].podId);
    await waitFor(() => B.isConnected(ids[0].podId));

    env.dropAll();
    await waitFor(() => A.of('peer-down').length === 1 && B.of('peer-down').length === 1, { label: 'both see it drop' });
    assert.equal(A.of('peer-down')[0].reason, 'transport');
    await waitFor(() => A.of('peer-up').length === 2 && B.of('peer-up').length === 2, { label: 'link is back', timeout: 8000 });
    A.send(ids[1].podId, 'after');
    await waitFor(() => B.of('message').some((m) => m.data === 'after'));
  });

  it('does not redial after disconnect()', async () => {
    const { ids, hubs: [A, B] } = await rig(2);
    await A.listen();
    await B.listen();
    await A.connect(ids[1].podId);
    await waitFor(() => B.isConnected(ids[0].podId));
    A.disconnect(ids[1].podId);
    await waitFor(() => B.of('peer-down').length === 1);
    await settle(() => A.getStats().linksEstablished + B.getStats().linksEstablished, { quietFor: 200 });
    assert.equal(A.of('peer-up').length, 1);
    assert.equal(A.isConnected(ids[1].podId), false);
  });

  it('does not keep redialling a peer that refused it', async () => {
    const { ids, hubs: [A, B] } = await rig(2, (i) => (i === 1 ? { allow: [] } : {}));
    await B.listen();
    await assert.rejects(A.connect(ids[1].podId));
    await settle(() => B.authorizeCalls.length, { quietFor: 200 });
    assert.equal(B.authorizeCalls.length, 1);
  });

  it('keeps trying while the peer is unreachable, then connects when it appears', async () => {
    const { ids, hubs: [A, B] } = await rig(2, { connectTimeoutMs: 150 });
    await A.listen();
    const p = A.connect(ids[1].podId);
    await assert.rejects(p, (e) => e.code === 'WSH_UNREACHABLE');
    await B.listen();
    await waitFor(() => A.isConnected(ids[1].podId), { label: 'redial found B', timeout: 8000 });
  });
});
