// Run with: node --import ./test/_setup-globals.mjs --test test/wsh-admission.test.mjs
//
// The restricted verdict of WshPeerLinks' `authorize`: a peer that is let in to talk to an admission seam and to nothing else.
// The seam here is a recording fake; the real one (and its cap and deadline) is tested in browsermesh-apps.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { waitFor, settle } from './_wait.mjs';
import { makeEnv, makeIdentities, makeHub } from './helpers/wsh-rig.mjs';

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) { try { await cleanups.pop()(); } catch { /* best effort */ } }
});

/** A seam double: records each admit() and keeps the channel so a test can drive it. */
function fakeAdmission({ refuse } = {}) {
  const seam = {
    calls: [],
    channels: [],
    frames: [],
    closed: [],
    async admit(info) {
      seam.calls.push({ peerKey: info.peerKey, transport: info.transport, proven: info.proven });
      seam.channels.push(info.channel);
      info.channel.onFrame((f) => { seam.frames.push(f); });
      info.channel.onClose((reason) => { seam.closed.push(reason); });
      if (refuse) { info.channel.close(refuse); return { state: 'refused', reason: refuse }; }
      return { state: 'restricted' };
    },
  };
  return seam;
}

async function rig({ verdict, admission, hostOpts = {} }) {
  const env = await makeEnv();
  cleanups.push(() => env.close());
  const ids = await makeIdentities(2);
  const [host, stranger] = [
    makeHub(env, ids[0], { allow: typeof verdict === 'function' ? verdict : () => verdict, ...(admission ? { admission } : {}), ...hostOpts }),
    makeHub(env, ids[1], { allow: [] }),
  ];
  cleanups.push(() => host.close(), () => stranger.close());
  await host.listen();
  return { env, ids, host, stranger };
}

describe('wsh authorize: the restricted verdict', () => {
  it('carries only the admission exchange: no peer-up, no message events, frames both ways go through the seam', async () => {
    const admission = fakeAdmission();
    const { ids, host, stranger } = await rig({ verdict: { restricted: true }, admission });
    await stranger.connect(ids[0].podId);
    await waitFor(() => admission.calls.length === 1, { label: 'admit called' });
    assert.deepEqual(admission.calls[0], { peerKey: ids[1].podId, transport: 'wsh', proven: true });

    stranger.send(ids[0].podId, 'hello from the stranger');
    await waitFor(() => admission.frames.length === 1, { label: 'frame reaches the seam' });
    assert.equal(admission.frames[0], 'hello from the stranger');

    await admission.channels[0].send({ type: 'x:hello', n: 1 });
    await waitFor(() => stranger.of('message').length === 1, { label: 'frame reaches the stranger' });
    assert.deepEqual(JSON.parse(stranger.of('message')[0].data), { type: 'x:hello', n: 1 });

    await settle(() => host.events.length);
    assert.equal(host.of('peer-up').length, 0, 'a restricted link is not a peer');
    assert.equal(host.of('message').length, 0, 'a normal-handler frame never arrives before promote');
    assert.deepEqual(host.peers(), []);
    assert.equal(host.isConnected(ids[1].podId), false);
    assert.equal(await host.send(ids[1].podId, 'nope').then(() => 'sent', (e) => e.code), 'WSH_CLOSED', 'the hub cannot send on it');
  });

  it('promote() makes it a normal link: peer-up, messages both ways, nothing sent before is replayed', async () => {
    const admission = fakeAdmission();
    const { ids, host, stranger } = await rig({ verdict: { restricted: true }, admission });
    await stranger.connect(ids[0].podId);
    await waitFor(() => admission.channels.length === 1);
    stranger.send(ids[0].podId, 'during');
    await waitFor(() => admission.frames.length === 1);

    admission.channels[0].adopt();
    await waitFor(() => host.of('peer-up').length === 1, { label: 'peer-up after promote' });
    assert.equal(host.of('peer-up')[0].podId, ids[1].podId);
    assert.equal(host.of('peer-up')[0].initiator, 'remote');
    assert.equal(host.isConnected(ids[1].podId), true);

    stranger.send(ids[0].podId, 'after');
    await waitFor(() => host.of('message').length === 1);
    assert.equal(host.of('message')[0].data, 'after');
    assert.equal(host.of('message')[0].from, ids[1].podId);
    assert.deepEqual(admission.frames, ['during'], 'the seam sees nothing after promote');
    await host.send(ids[1].podId, 'to you');
    await waitFor(() => stranger.of('message').some((m) => m.data === 'to you'));
  });

  it('close() ends the link and the peer sees it go; the seam is told when the peer goes first', async () => {
    const admission = fakeAdmission();
    const { ids, host, stranger } = await rig({ verdict: { restricted: true }, admission });
    await stranger.connect(ids[0].podId);
    await waitFor(() => admission.channels.length === 1);
    admission.channels[0].close('deadline');
    await waitFor(() => stranger.of('peer-down').length === 1, { label: 'stranger sees the close' });
    assert.equal(host.of('peer-down').length, 0, 'a restricted link never announced itself');

    await stranger.connect(ids[0].podId, { keep: false });
    await waitFor(() => admission.channels.length === 2);
    await stranger.disconnect(ids[0].podId);
    await waitFor(() => admission.closed.length >= 1, { label: 'seam told the peer left' });
  });

  it('a restricted verdict with no admission configured is a refusal', async () => {
    const { ids, host, stranger } = await rig({ verdict: { restricted: true } });
    await assert.rejects(() => stranger.connect(ids[0].podId, { keep: false }), (e) => e.code === 'WSH_REFUSED');
    assert.equal(host.of('peer-up').length, 0);
  });

  it('a seam that refuses the link (cap) closes it before any frame', async () => {
    const admission = fakeAdmission({ refuse: 'restricted-full' });
    const { ids, host, stranger } = await rig({ verdict: { restricted: true }, admission });
    await stranger.connect(ids[0].podId, { keep: false }).catch(() => {});
    await waitFor(() => admission.calls.length === 1);
    await waitFor(() => !stranger.isConnected(ids[0].podId), { label: 'stranger link closed' });
    assert.equal(host.of('peer-up').length, 0);
  });

  it('does not hold a listening slot: an honest peer links while a stranger is held, with listenSlots 1', async () => {
    const admission = fakeAdmission();
    const env = await makeEnv();
    cleanups.push(() => env.close());
    const [hostId, strangerId, friendId] = await makeIdentities(3);
    const host = makeHub(env, hostId, { allow: (p) => (p.podId === friendId.podId ? true : { restricted: true }), admission, listenSlots: 1 });
    const stranger = makeHub(env, strangerId, { allow: [] });
    const friend = makeHub(env, friendId, { allow: [] });
    cleanups.push(() => host.close(), () => stranger.close(), () => friend.close());
    await host.listen();
    await stranger.connect(hostId.podId, { keep: false });
    await waitFor(() => admission.channels.length === 1);
    await friend.connect(hostId.podId, { keep: false });
    await waitFor(() => host.of('peer-up').length === 1, { label: 'friend linked' });
    assert.equal(host.of('peer-up')[0].podId, friendId.podId);
    assert.equal(admission.channels.length, 1, 'the friend was never restricted');
  });
});

describe('wsh authorize: the other verdicts are unchanged', () => {
  for (const [name, verdict, ok] of [
    ['true', true, true],
    ['{ expires }', { expires: new Date(Date.now() + 60_000) }, true],
    ['false', false, false],
  ]) {
    it(`${name} admits ${ok ? 'a normal link' : 'nobody'}, with or without an admission seam`, async () => {
      for (const admission of [undefined, fakeAdmission()]) {
        const { ids, host, stranger } = await rig({ verdict, admission });
        if (ok) {
          await stranger.connect(ids[0].podId, { keep: false });
          await waitFor(() => host.of('peer-up').length === 1);
          if (admission) assert.equal(admission.calls.length, 0);
        } else {
          await assert.rejects(() => stranger.connect(ids[0].podId, { keep: false }), (e) => e.code === 'WSH_REFUSED');
          if (admission) assert.equal(admission.calls.length, 0);
        }
        await host.close();
        await stranger.close();
      }
    });
  }

  it('the default (no authorize at all) is still nobody', async () => {
    const env = await makeEnv();
    cleanups.push(() => env.close());
    const ids = await makeIdentities(2);
    const { WshPeerLinks } = await import('../src/wsh.mjs');
    const { RELAY } = await import('./helpers/wsh-rig.mjs');
    const host = new WshPeerLinks({ identity: ids[0], relays: [RELAY], WebSocket: env.WebSocket, admission: fakeAdmission() });
    const stranger = makeHub(env, ids[1], { allow: [] });
    cleanups.push(() => host.close(), () => stranger.close());
    await host.listen();
    await assert.rejects(() => stranger.connect(ids[0].podId, { keep: false }), (e) => e.code === 'WSH_REFUSED');
  });
});

describe('wsh authorize: the restricted capability is advertised', () => {
  it('WshPeerLinks.supportsRestrictedAdmission is true', async () => {
    const { WshPeerLinks } = await import('../src/wsh.mjs');
    assert.equal(WshPeerLinks.supportsRestrictedAdmission, true);
  });

  it('authorize gets (peer, { restricted: true }), and an authorizer that ignores the second argument still works', async () => {
    const seen = [];
    const admission = fakeAdmission();
    const { ids, stranger } = await rig({ verdict: (peer, ctx) => { seen.push(ctx); return { restricted: true }; }, admission });
    await stranger.connect(ids[0].podId);
    await waitFor(() => admission.calls.length === 1, { label: 'admit called' });
    assert.deepEqual(seen, [{ restricted: true }]);
  });
});
