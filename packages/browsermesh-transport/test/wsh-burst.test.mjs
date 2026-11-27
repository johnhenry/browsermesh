// Run with: node --import ./test/_setup-globals.mjs --test test/wsh-burst.test.mjs
//
// A burst of dialers against one host (issue #431), over wsh's REAL pipe relay on loopback (the in-process double queues extra
// operators, the real relay closes them at once, and that is the behaviour under test). The host keeps `listenSlots` halves
// waiting at ONE rendezvous id; a dialler that arrives while every half is taken is closed by the relay ("no partner"). Dialling
// must (1) retry that inside its own `connectTimeoutMs`, with jittered backoff, so a burst is served as the host refills halves,
// and (2) never run past `connectTimeoutMs` when no host half ever comes.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createPipeRelay } from '@johnhenry/wsh/pipe-relay';

import { makeIdentities } from './helpers/wsh-rig.mjs';
import { WshPeerLinks } from '../src/wsh.mjs';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) { try { await cleanups.pop()(); } catch { /* best effort */ } }
});

async function relayUrl() {
  const relay = createPipeRelay();
  const listener = await relay.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => relay.close());
  cleanups.push(() => listener.close());
  return `ws://127.0.0.1:${listener.port}`;
}

const hub = (identity, relay, opts) => {
  const h = new WshPeerLinks({ identity, relays: [relay], authorize: () => true, reconnect: { baseMs: 5, maxMs: 25 }, ...opts });
  cleanups.push(() => h.close());
  return h;
};

describe('wsh dialling: a burst of dialers against one host', () => {
  it('serves 6 simultaneous dialers from a host with a single waiting half, each within connectTimeoutMs', async () => {
    const relay = await relayUrl();
    const ids = await makeIdentities(7);
    const host = hub(ids[0], relay, { listenSlots: 1, connectTimeoutMs: 8000 });
    await host.listen();
    const dialers = ids.slice(1).map((id) => hub(id, relay, { connectTimeoutMs: 8000 }));
    const t0 = Date.now();
    const results = await Promise.allSettled(dialers.map((d) => d.connect(ids[0].podId, { keep: false })));
    const failed = results.filter((r) => r.status === 'rejected').map((r) => r.reason?.code ?? String(r.reason));
    assert.deepEqual(failed, [], 'every dialler of the burst is served');
    assert.ok(Date.now() - t0 < 8000 + 1000, 'within connectTimeoutMs plus a small margin');
    for (const id of ids.slice(1)) assert.ok(host.isConnected(id.podId), 'the host holds the link');
  });

  it('dialers with no host half ever waiting all fail with WSH_UNREACHABLE within connectTimeoutMs, however often they retry', async () => {
    const relay = await relayUrl();
    const ids = await makeIdentities(4);
    const dialers = ids.slice(1).map((id) => hub(id, relay, { connectTimeoutMs: 700 }));
    const t0 = Date.now();
    const results = await Promise.allSettled(dialers.map((d) => d.connect(ids[0].podId, { keep: false })));
    assert.deepEqual(results.map((r) => r.reason?.code), ['WSH_UNREACHABLE', 'WSH_UNREACHABLE', 'WSH_UNREACHABLE']);
    assert.ok(Date.now() - t0 < 700 + 500, `gave up in ${Date.now() - t0} ms`);
  });
});
