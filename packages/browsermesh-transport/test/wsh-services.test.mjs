// Run with: node --import ./test/_setup-globals.mjs --test test/wsh-services.test.mjs
//
// wsh services on a pod (docs/design/wsh-services-on-a-pod.md): a STOCK wsh client (the real `WshClient`) uses a
// pod's objects and MCP tools through an in-process pipe relay, with the real key login and the real sealed session.
// Permission is the pod's registry grants for the key's pod id, nothing else; off by default; objects and MCP only.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PodIdentity } from '@johnhenry/browsermesh-primitives';

import {
  WshServices, servicesRendezvousId, podIdToFingerprint, podIdFromRawKey, WshPeerLinks,
} from '../src/index.mjs';
import { waitFor, settle } from './_wait.mjs';
import { RELAY, makeEnv } from './helpers/wsh-rig.mjs';
import { fakeRegistry } from './helpers/fake-registry.mjs';

const { WshClient, WebSocketTransport, generateKeyPair } = await import('@johnhenry/wsh');
const { openObjects, get, set } = await import('@johnhenry/wsh/objects');

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) { try { await cleanups.pop()(); } catch { /* best effort */ } }
});

const OPEN = 'wsh-services:open';

/** A pod with its services started on an in-process pipe relay, and helpers to dial it as a stock client. */
async function world({ mcp = true, objects = true, registry = fakeRegistry(), start = true, extra = {} } = {}) {
  const env = await makeEnv();
  cleanups.push(() => env.close());
  const identity = await PodIdentity.generate();
  const asked = [];
  const ran = [];
  const audit = [];
  const app = {
    title: 'inbox',
    secret: 'not for the wire',
    counter: { value: 3, inc(n = 1) { app.counter.value += n; return app.counter.value; } },
  };
  const tool = (name, annotations, execute) => ({ name, description: `the ${name} tool`, inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations, execute });
  const services = new WshServices({
    identity,
    relays: [RELAY],
    WebSocket: env.WebSocket,
    registry,
    unattended: true,
    ...(mcp ? {
      mcp: {
        allow: ['echo', 'buy'],
        tools: [
          tool('echo', { readOnlyHint: true }, async (input) => { ran.push(['echo', input]); return `echo: ${input.text ?? ''}`; }),
          tool('buy', {}, async (input) => { ran.push(['buy', input]); return `bought ${input.text ?? ''}`; }),
          tool('hidden', { readOnlyHint: true }, async () => 'never offered'),
        ],
        prompt: async (call, who) => { asked.push({ name: call.name, who: who.fingerprint }); return true; },
      },
    } : {}),
    ...(objects ? {
      objects: {
        roots: { app },
        allow: { get: ['app.title', 'app.counter.**'], call: ['app.counter.inc'], set: ['app.counter.value'] },
      },
    } : {}),
    onAudit: (e) => audit.push(e),
    reconnect: { baseMs: 5, maxMs: 25 },
    ...extra,
  });
  cleanups.push(() => services.stop());
  if (start) await services.start();
  const rid = await servicesRendezvousId(identity.podId);

  /** A stock wsh client with a fresh key: its pod id is the hash of the key. Dials the pod's services rendezvous. */
  async function stock({ username = 'alice', pin = identity.podId, keyPair, connect = true } = {}) {
    const kp = keyPair ?? await generateKeyPair();
    const podId = await podIdFromRawKey(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
    const client = new WshClient({
      transportFactories: {
        ws: () => new WebSocketTransport({ WebSocket: env.WebSocket }),
        wt: () => { throw new Error('no WebTransport'); },
      },
    });
    cleanups.push(() => client.disconnect().catch(() => {}));
    const login = () => client.connect(`${RELAY}/r/${rid}`, {
      username, keyPair: kp, transport: 'ws', expectHostKey: podIdToFingerprint(pin), sealSession: true, requireChannelBinding: true, timeout: 4000,
    });
    if (connect) await login();
    return { client, podId, keyPair: kp, login };
  }
  return { env, identity, registry, services, asked, ran, audit, app, stock, rid };
}

const refused = (promise) => assert.rejects(promise);

describe('wsh services: off by default', () => {
  it('constructing the services dials nothing; only start() does', async () => {
    const w = await world({ start: false });
    assert.equal(w.env.stats().waiting ?? 0, 0);
    await settle(() => w.env.stats().waiting ?? 0, { quietFor: 20 });
    assert.equal(w.env.stats().waiting ?? 0, 0);
    await w.services.start();
    await waitFor(() => (w.env.stats().waiting ?? 0) > 0, { label: 'host halves waiting' });
  });

  it('a pod that links over wsh (WshPeerLinks) offers no services rendezvous', async () => {
    const env = await makeEnv();
    cleanups.push(() => env.close());
    const identity = await PodIdentity.generate();
    const hub = new WshPeerLinks({ identity, relays: [RELAY], WebSocket: env.WebSocket, authorize: () => true });
    cleanups.push(() => hub.close());
    await hub.listen();
    const rid = await servicesRendezvousId(identity.podId);
    const seen = [];
    const original = env.relay.accept.bind(env.relay);
    env.relay.accept = (socket, info) => { seen.push(info.id); return original(socket, info); };
    // a client dialling the services id finds no host there
    const client = new WshClient({ transportFactories: { ws: () => new WebSocketTransport({ WebSocket: env.WebSocket }), wt: () => { throw new Error('no'); } } });
    cleanups.push(() => client.disconnect().catch(() => {}));
    await refused(client.connect(`${RELAY}/r/${rid}`, { username: 'alice', keyPair: await generateKeyPair(), transport: 'ws', timeout: 300 }));
  });

  it('start() refuses to run with nobody watching: it needs an indicator or unattended: true', async () => {
    const w = await world({ start: false, extra: { unattended: false } });
    await assert.rejects(() => w.services.start(), /indicator|unattended/);
  });

  it('needs at least one service', async () => {
    const identity = await PodIdentity.generate();
    assert.throws(() => new WshServices({ identity, relays: [RELAY], registry: fakeRegistry(), unattended: true }), /mcp|objects/);
  });

  it('without a registry there is nothing to permit with', async () => {
    const identity = await PodIdentity.generate();
    assert.throws(() => new WshServices({ identity, relays: [RELAY], mcp: { tools: [], allow: [] }, unattended: true }), /registry/);
  });
});

describe('wsh services: who may log in', () => {
  it('an unknown key is refused before any channel is opened, and it is audited', async () => {
    const w = await world();
    const { login } = await w.stock({ connect: false });
    await refused(login());
    await waitFor(() => w.audit.some((e) => e.event === 'refused'), { label: 'refusal audited' });
    const e = w.audit.find((x) => x.event === 'refused');
    assert.ok(e.podId, 'the pod id of the key is named');
    assert.equal(w.services.sessions.length, 0);
    assert.deepEqual(w.ran, []);
  });

  it('a key whose pod id holds wsh-services:open logs in, under any user name; the name is only a label', async () => {
    const w = await world();
    const probe = await w.stock({ connect: false, username: 'mallory' });
    w.registry.grant(probe.podId, [OPEN]);
    await probe.login();
    await waitFor(() => w.services.sessions.length === 1, { label: 'session' });
    assert.equal(w.services.sessions[0].podId, probe.podId);
    assert.equal(w.services.sessions[0].username, 'mallory');
    assert.ok(w.audit.some((e) => e.event === 'session-open' && e.podId === probe.podId));
  });

  it('the grant of ANOTHER pod does not admit this key', async () => {
    const w = await world();
    const other = await w.stock({ connect: false });
    w.registry.grant(other.podId, [OPEN, 'protocol:mcp:open', 'mcp:*:call', 'mcp:*:list']);
    const me = await w.stock({ connect: false });
    await refused(me.login());
  });

  it('a mesh peer is not a services key: mesh:link:connect alone opens nothing here', async () => {
    const w = await world();
    const probe = await w.stock({ connect: false });
    w.registry.grant(probe.podId, ['mesh:link:connect']);
    await refused(probe.login());
  });

  it('the dialler pins the host: a client that expects another pod refuses this host', async () => {
    const w = await world();
    const stranger = await PodIdentity.generate();
    const probe = await w.stock({ connect: false, pin: stranger.podId });
    w.registry.grant(probe.podId, [OPEN]);
    await refused(probe.login());
  });

  it('a plain (unsealed) client is served nothing, whatever it was granted', async () => {
    const w = await world();
    const probe = await w.stock({ connect: false });
    w.registry.grant(probe.podId, [OPEN, 'protocol:mcp:open', 'protocol:objects:open', 'mcp:*:call', 'mcp:*:list', 'objects:*:get']);
    const client = new WshClient({ transportFactories: { ws: () => new WebSocketTransport({ WebSocket: w.env.WebSocket }), wt: () => { throw new Error('no'); } } });
    cleanups.push(() => client.disconnect().catch(() => {}));
    try {
      await client.connect(`${RELAY}/r/${w.rid}`, { username: 'alice', keyPair: probe.keyPair, transport: 'ws', expectHostKey: podIdToFingerprint(w.identity.podId), sealSession: false, timeout: 1500 });
    } catch { return; /* refused at login: also fine */ }
    assert.equal(client.sessionSealed, false);
    await refused(client.openRpc('mcp'));
    await refused(openObjects(client));
    assert.deepEqual(w.ran, []);
  });

  it('maxSessions bounds the sessions: the next login is refused', async () => {
    const w = await world({ extra: { maxSessions: 1 } });
    const a = await w.stock({ connect: false });
    const b = await w.stock({ connect: false });
    w.registry.grant(a.podId, [OPEN]);
    w.registry.grant(b.podId, [OPEN]);
    await a.login();
    await waitFor(() => w.services.sessions.length === 1);
    await refused(b.login());
    assert.equal(w.services.sessions.length, 1);
  });
});

describe('wsh services: MCP', () => {
  it('a key with the open grant and nothing else cannot open the channel', async () => {
    const w = await world();
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN]);
    await s.login();
    await refused(s.client.openRpc('mcp'));
  });

  it('lists and calls exactly what the grants name, and results are labelled untrusted', async () => {
    const w = await world();
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN, 'protocol:mcp:open', 'mcp:echo:list', 'mcp:echo:call']);
    await s.login();
    const ch = await s.client.openRpc('mcp');
    const init = await ch.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.deepEqual(Object.keys(init.capabilities), ['tools']);
    const list = await ch.request('tools/list', {});
    assert.deepEqual(list.tools.map((t) => t.name), ['echo'], 'the one tool this key may list; "buy" and "hidden" are not shown');
    const result = await ch.request('tools/call', { name: 'echo', arguments: { text: 'hi' } });
    assert.equal(result.content[0].text, 'echo: hi');
    assert.equal(result._meta['browsermesh/untrusted'], true);
    await assert.rejects(ch.request('tools/call', { name: 'buy', arguments: {} }), /unknown tool/);
    await assert.rejects(ch.request('tools/call', { name: 'hidden', arguments: {} }), /unknown tool/);
    assert.deepEqual(w.ran, [['echo', { text: 'hi' }]]);
  });

  it('a list grant lets a key see a tool, not call it; a call grant lets it call a tool it was not shown', async () => {
    const w = await world();
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN, 'protocol:mcp:open', 'mcp:echo:list', 'mcp:buy:call']);
    await s.login();
    const ch = await s.client.openRpc('mcp');
    assert.deepEqual((await ch.request('tools/list', {})).tools.map((t) => t.name), ['echo']);
    await assert.rejects(ch.request('tools/call', { name: 'echo', arguments: {} }), /unknown tool/);
    assert.equal((await ch.request('tools/call', { name: 'buy', arguments: { text: 'x' } })).content[0].text, 'bought x');
    assert.deepEqual(w.ran, [['buy', { text: 'x' }]]);
  });

  it('revoking the channel grant mid-session closes the channel; the next request is refused', async () => {
    const w = await world();
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN, 'protocol:mcp:open', 'mcp:echo:call']);
    await s.login();
    const ch = await s.client.openRpc('mcp');
    await ch.request('tools/call', { name: 'echo', arguments: { text: '1' } });
    w.registry.revoke(s.podId, ['protocol:mcp:open']);
    await assert.rejects(ch.request('tools/call', { name: 'echo', arguments: { text: '2' } }));
    assert.equal(w.ran.length, 1);
  });

  it('a consequential tool asks the page (the pod), with the key\'s pod id, never the wsh client', async () => {
    const w = await world();
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN, 'protocol:mcp:open', 'mcp:buy:call']);
    await s.login();
    const ch = await s.client.openRpc('mcp');
    const r = await ch.request('tools/call', { name: 'buy', arguments: { text: 'bike' } });
    assert.equal(r.content[0].text, 'bought bike');
    // wsh's own form of the key's identity (the hex fingerprint) is what the page's prompt is shown
    assert.deepEqual(w.asked, [{ name: 'buy', who: podIdToFingerprint(s.podId) }]);
  });

  it('a denial by the page refuses the call', async () => {
    const w = await world({ extra: { mcp: { allow: ['buy'], tools: [{ name: 'buy', description: 'x', annotations: {}, execute: async () => 'done' }], prompt: async () => false } } });
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN, 'protocol:mcp:open', 'mcp:buy:call']);
    await s.login();
    const ch = await s.client.openRpc('mcp');
    await assert.rejects(ch.request('tools/call', { name: 'buy', arguments: {} }), /denied/);
  });

  it('revocation mid-session: the very next call is refused', async () => {
    const w = await world();
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN, 'protocol:mcp:open', 'mcp:echo:call']);
    await s.login();
    const ch = await s.client.openRpc('mcp');
    await ch.request('tools/call', { name: 'echo', arguments: { text: '1' } });
    w.registry.revoke(s.podId, ['mcp:echo:call']);
    await assert.rejects(ch.request('tools/call', { name: 'echo', arguments: { text: '2' } }), /unknown tool/);
    assert.equal(w.ran.length, 1);
  });
});

describe('wsh services: objects', () => {
  it('a grant limited to one root and one operation: get yes, call and set no', async () => {
    const w = await world();
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN, 'protocol:objects:open', 'objects:app:get']);
    await s.login();
    const { app } = await openObjects(s.client);
    assert.equal(await app.title, 'inbox');
    await assert.rejects(async () => app.counter.inc(1), /refused|authori/i);
    await assert.rejects(async () => set(app.counter, 'value', 99), /refused|authori/i);
    assert.equal(w.app.counter.value, 3);
    await assert.rejects(async () => get(app, 'secret'), /refused|allow|authori/i, 'a path the page does not allow never reaches the registry');
  });

  it('call and set work with their own grants, and only those', async () => {
    const w = await world();
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN, 'protocol:objects:open', 'objects:app:get', 'objects:app:call']);
    await s.login();
    const { app } = await openObjects(s.client);
    assert.equal(await app.counter.inc(4), 7);
    await assert.rejects(async () => set(app.counter, 'value', 1), /refused|authori/i);
    w.registry.grant(s.podId, ['objects:app:set']);
    await set(app.counter, 'value', 1);
    assert.equal(w.app.counter.value, 1);
  });

  it('another root is another grant', async () => {
    const w = await world();
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN, 'protocol:objects:open', 'objects:other:get']);
    await s.login();
    const { app } = await openObjects(s.client);
    await assert.rejects(async () => get(app, 'title'), /refused|authori/i);
  });

  it('without protocol:objects:open the channel does not open', async () => {
    const w = await world();
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN, 'objects:app:get']);
    await s.login();
    await refused(openObjects(s.client));
  });

  it('revocation mid-session: the very next operation is refused', async () => {
    const w = await world();
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN, 'protocol:objects:open', 'objects:app:get']);
    await s.login();
    const { app } = await openObjects(s.client);
    assert.equal(await app.title, 'inbox');
    w.registry.revoke(s.podId, ['objects:app:get']);
    await assert.rejects(async () => get(app, 'title'), /refused|authori/i);
  });
});

describe('wsh services: revocation closes the session', () => {
  it('revoking wsh-services:open ends the session, tells the client why and audits it', async () => {
    const w = await world();
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN, 'protocol:mcp:open', 'mcp:*:call']);
    await s.login();
    const ch = await s.client.openRpc('mcp');
    await ch.request('tools/call', { name: 'echo', arguments: { text: 'x' } });
    let closed = false;
    ch.onClose = () => { closed = true; };
    w.registry.revoke(s.podId, [OPEN]);
    await waitFor(() => closed || ch.closed, { label: 'channel closed' });
    await waitFor(() => w.services.sessions.length === 0, { label: 'session gone' });
    assert.ok(w.audit.some((e) => e.event === 'session-close' && e.podId === s.podId && e.reason === 'revoked'));
    // and the key cannot come back
    const again = await w.stock({ connect: false, keyPair: s.keyPair });
    await refused(again.login());
  });

  it('revoking another pod\'s grant leaves this session alone', async () => {
    const w = await world();
    const a = await w.stock({ connect: false });
    const b = await w.stock({ connect: false });
    w.registry.grant(a.podId, [OPEN]);
    w.registry.grant(b.podId, [OPEN]);
    await a.login();
    await b.login();
    await waitFor(() => w.services.sessions.length === 2);
    w.registry.revoke(b.podId, [OPEN]);
    await waitFor(() => w.services.sessions.length === 1);
    assert.equal(w.services.sessions[0].podId, a.podId);
  });
});

describe('wsh services: nothing but objects and MCP', () => {
  async function granted(extra = {}) {
    const w = await world(extra);
    const s = await w.stock({ connect: false });
    // every grant the registry could give: still nothing else exists on this host
    w.registry.grant(s.podId, ['*:*', '*:*:*', OPEN, 'protocol:mcp:open', 'protocol:objects:open', 'mcp:*:list', 'mcp:*:call', 'objects:*:get', 'objects:*:call', 'objects:*:set']);
    await s.login();
    return { w, s };
  }

  it('exec, a pty, files, the gateway, the mesh endpoint, other rpc protocols and targets are all refused', async () => {
    const { s } = await granted();
    const c = s.client;
    await refused(c.openSession({ type: 'exec', command: 'true' }));
    await refused(c.openSession({ type: 'pty' }));
    // a file operation is answered with a failed result (or refused outright), never with a listing
    const files = await c.fileOperation('list', '/', {}, 1500).catch((e) => ({ success: false, error: String(e) }));
    assert.ok(files.success === false || files.error || files.ok === false, `no file access: ${JSON.stringify(files)}`);
    assert.ok(!files.entries?.length, 'no listing');
    await refused(c.openEndpoint('mesh'));
    await refused(c.openTcp('127.0.0.1', 80));
    await refused(c.openUdp('127.0.0.1', 53));
    await refused(c.openUnix('/tmp/x'));
    await refused(c.openRpc('wsh-host'));
    await refused(c.openRpc('wsh-fs'));
    await refused(c.openRpc('anything-else'));
    await refused(c.listTargets(1500));
    await refused(c.listenTcp(0));
  });

  it('the host advertises only what it serves', async () => {
    const { s } = await granted();
    const features = s.client.serverFeatures;
    assert.ok(features.length > 0, 'the host states its features');
    // The whole list, by pattern: sealing, the host key and its binding, rpc, and the two protocols. Nothing else.
    const offered = /^(e2e-session|e2e-session-required|rpc-virtual|rpc-protocol:(mcp|wsh-objects)|rpc-max-message:\d+|host-key:[0-9a-f]+|host-key-sig:[0-9a-f]+|channel-binding:host|channel-binding-required)$/;
    for (const f of features) assert.match(f, offered, `feature ${f} must not be offered`);
    assert.ok(features.includes('rpc-protocol:mcp') && features.includes('rpc-protocol:wsh-objects'));
  });

  it('with only MCP enabled, the objects channel does not exist; with only objects, MCP does not', async () => {
    const onlyMcp = await granted({ objects: false });
    await refused(openObjects(onlyMcp.s.client));
    const onlyObjects = await granted({ mcp: false });
    await refused(onlyObjects.s.client.openRpc('mcp'));
  });
});

describe('wsh services: indicator, audit, stop', () => {
  it('an indicator is told of each session, and its stop() ends that session and refuses the key until restart', async () => {
    const shown = [];
    const controls = [];
    const w = await world({
      extra: {
        unattended: false,
        indicator: { connected: (who, control) => { shown.push(['connected', who]); controls.push(control); }, disconnected: (who) => shown.push(['disconnected', who]) },
      },
    });
    const s = await w.stock({ connect: false, username: 'carol' });
    w.registry.grant(s.podId, [OPEN]);
    await s.login();
    await waitFor(() => shown.length === 1, { label: 'indicator told' });
    assert.equal(shown[0][1].fingerprint, podIdToFingerprint(s.podId));
    assert.equal(shown[0][1].username, 'carol');
    assert.equal(await controls[0].stop(), true);
    await waitFor(() => shown.some(([k]) => k === 'disconnected'), { label: 'indicator told of the end' });
    assert.ok(w.audit.some((e) => e.event === 'session-close' && e.reason === 'stopped'));
    const again = await w.stock({ connect: false, keyPair: s.keyPair });
    await refused(again.login());
  });

  it('stop() ends every session and stops listening', async () => {
    const w = await world();
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN]);
    await s.login();
    await waitFor(() => w.services.sessions.length === 1);
    await w.services.stop();
    await waitFor(() => w.services.sessions.length === 0);
    const late = await w.stock({ connect: false });
    w.registry.grant(late.podId, [OPEN]);
    await refused(late.login());
  });

  it('every session audits once on the way in and once on the way out, naming the pod id', async () => {
    const w = await world();
    const s = await w.stock({ connect: false });
    w.registry.grant(s.podId, [OPEN]);
    await s.login();
    await waitFor(() => w.services.sessions.length === 1);
    await s.client.disconnect();
    await waitFor(() => w.audit.some((e) => e.event === 'session-close'));
    const mine = w.audit.filter((e) => e.podId === s.podId);
    assert.deepEqual(mine.map((e) => e.event), ['session-open', 'session-close']);
  });
});
