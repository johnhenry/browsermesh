// Run with: node --import ./test/_setup-globals.mjs --test test/relay.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MeshRelayClient,
  MockRelayServer,
  RELAY_STATES,
} from '../src/relay.mjs';

// ── RELAY_STATES ────────────────────────────────────────────────

describe('RELAY_STATES', () => {
  it('contains expected lifecycle states', () => {
    assert.deepEqual(RELAY_STATES, [
      'disconnected',
      'connecting',
      'connected',
    ]);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(RELAY_STATES));
  });
});

// ── MockRelayServer ─────────────────────────────────────────────

describe('MockRelayServer', () => {
  /** @type {MockRelayServer} */
  let server;

  beforeEach(() => {
    server = new MockRelayServer();
  });

  it('starts with zero clients', () => {
    assert.equal(server.size, 0);
    assert.deepEqual(server.getConnectedPeers(), []);
  });

  it('registerClient adds a client', async () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    server.registerClient(client);
    assert.equal(server.size, 1);
  });

  it('removeClient removes a client by fingerprint', async () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    server.registerClient(client);
    assert.equal(server.removeClient('fp-alice'), true);
    assert.equal(server.size, 0);
  });

  it('removeClient returns false for unknown fingerprint', () => {
    assert.equal(server.removeClient('nonexistent'), false);
  });

  it('getConnectedPeers returns descriptors of all clients', async () => {
    const alice = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    const bob = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-bob' },
    });
    server.registerClient(alice);
    server.registerClient(bob);

    const peers = server.getConnectedPeers();
    assert.equal(peers.length, 2);
    const fps = peers.map(p => p.fingerprint).sort();
    assert.deepEqual(fps, ['fp-alice', 'fp-bob']);
  });

  it('findPeers returns all peers when no query', async () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    await client.connect(server);
    client.announcePresence(['chat']);

    const peers = server.findPeers();
    assert.equal(peers.length, 1);
    assert.equal(peers[0].fingerprint, 'fp-alice');
  });

  it('findPeers filters by capability', async () => {
    const alice = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    const bob = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-bob' },
    });
    await alice.connect(server);
    await bob.connect(server);
    alice.announcePresence(['chat', 'tools']);
    bob.announcePresence(['chat']);

    const toolPeers = server.findPeers({ capability: 'tools' });
    assert.equal(toolPeers.length, 1);
    assert.equal(toolPeers[0].fingerprint, 'fp-alice');
  });

  it('forwardSignal delivers to target client', async () => {
    const alice = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    const bob = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-bob' },
    });
    await alice.connect(server);
    await bob.connect(server);

    const received = [];
    bob.onSignal((from, signal) => received.push({ from, signal }));

    const ok = server.forwardSignal('fp-alice', 'fp-bob', { sdp: 'offer' });
    assert.equal(ok, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].from, 'fp-alice');
    assert.deepEqual(received[0].signal, { sdp: 'offer' });
  });

  it('forwardSignal returns false for unknown target', () => {
    assert.equal(
      server.forwardSignal('fp-alice', 'fp-nobody', { sdp: 'x' }),
      false,
    );
  });

  it('broadcastPresence notifies all other clients', async () => {
    const alice = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    const bob = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-bob' },
    });
    const carol = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-carol' },
    });
    await alice.connect(server);
    await bob.connect(server);
    await carol.connect(server);

    const bobAnnouncements = [];
    const carolAnnouncements = [];
    bob.onPeerAnnounce(info => bobAnnouncements.push(info));
    carol.onPeerAnnounce(info => carolAnnouncements.push(info));

    server.broadcastPresence('fp-alice', ['chat']);

    assert.equal(bobAnnouncements.length, 1);
    assert.equal(bobAnnouncements[0].fingerprint, 'fp-alice');
    assert.deepEqual(bobAnnouncements[0].capabilities, ['chat']);
    assert.equal(carolAnnouncements.length, 1);
    assert.equal(carolAnnouncements[0].fingerprint, 'fp-alice');
  });
});

// ── MeshRelayClient ─────────────────────────────────────────────

describe('MeshRelayClient', () => {
  /** @type {MockRelayServer} */
  let server;

  beforeEach(() => {
    server = new MockRelayServer();
  });

  // -- Constructor --------------------------------------------------------

  it('constructor sets relayUrl and fingerprint', () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    assert.equal(client.relayUrl, 'wss://relay.test');
    assert.equal(client.fingerprint, 'fp-1');
  });

  it('constructor defaults to disconnected state', () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    assert.equal(client.state, 'disconnected');
    assert.equal(client.connected, false);
  });

  it('constructor throws without relayUrl', () => {
    assert.throws(
      () => new MeshRelayClient({ identity: { fingerprint: 'fp-1' } }),
      /relayUrl is required/,
    );
  });

  it('constructor throws without identity', () => {
    assert.throws(
      () => new MeshRelayClient({ relayUrl: 'wss://relay.test' }),
      /identity with fingerprint is required/,
    );
  });

  // -- connect / disconnect -----------------------------------------------

  it('connect transitions to connected', async () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    await client.connect(server);
    assert.equal(client.state, 'connected');
    assert.equal(client.connected, true);
    assert.equal(server.size, 1);
  });

  it('connect fires onConnect callback', async () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    const events = [];
    client.onConnect(() => events.push('connected'));
    await client.connect(server);
    assert.deepEqual(events, ['connected']);
  });

  it('connect is idempotent when already connected', async () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    await client.connect(server);
    // Second call should be a no-op
    await client.connect(server);
    assert.equal(client.connected, true);
  });

  it('disconnect transitions to disconnected', async () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    await client.connect(server);
    client.disconnect();
    assert.equal(client.state, 'disconnected');
    assert.equal(client.connected, false);
    assert.equal(server.size, 0);
  });

  it('disconnect fires onDisconnect callback', async () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    const events = [];
    client.onDisconnect(() => events.push('disconnected'));
    await client.connect(server);
    client.disconnect();
    assert.deepEqual(events, ['disconnected']);
  });

  it('disconnect is safe when already disconnected', () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    // Should not throw
    client.disconnect();
    assert.equal(client.state, 'disconnected');
  });

  it('disconnect clears capabilities', async () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    await client.connect(server);
    client.announcePresence(['chat', 'tools']);
    client.disconnect();
    const json = client.toJSON();
    assert.deepEqual(json.capabilities, []);
  });

  // -- announcePresence ---------------------------------------------------

  it('announcePresence stores capabilities', async () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    await client.connect(server);
    client.announcePresence(['chat', 'tools', 'fs']);
    const json = client.toJSON();
    assert.deepEqual(json.capabilities, ['chat', 'tools', 'fs']);
  });

  it('announcePresence throws when not connected', () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    assert.throws(
      () => client.announcePresence(['chat']),
      /Not connected to relay/,
    );
  });

  it('announcePresence broadcasts to other clients', async () => {
    const alice = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    const bob = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-bob' },
    });
    await alice.connect(server);
    await bob.connect(server);

    const announcements = [];
    bob.onPeerAnnounce(info => announcements.push(info));
    alice.announcePresence(['chat']);

    assert.equal(announcements.length, 1);
    assert.equal(announcements[0].fingerprint, 'fp-alice');
    assert.deepEqual(announcements[0].capabilities, ['chat']);
  });

  // -- findPeers ----------------------------------------------------------

  it('findPeers returns other connected peers', async () => {
    const alice = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    const bob = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-bob' },
    });
    await alice.connect(server);
    await bob.connect(server);
    bob.announcePresence(['chat']);

    const peers = await alice.findPeers();
    assert.equal(peers.length, 1);
    assert.equal(peers[0].fingerprint, 'fp-bob');
  });

  it('findPeers excludes self from results', async () => {
    const alice = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    await alice.connect(server);
    alice.announcePresence(['chat']);

    const peers = await alice.findPeers();
    assert.equal(peers.length, 0);
  });

  it('findPeers filters by capability', async () => {
    const alice = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    const bob = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-bob' },
    });
    const carol = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-carol' },
    });
    await alice.connect(server);
    await bob.connect(server);
    await carol.connect(server);
    bob.announcePresence(['chat', 'tools']);
    carol.announcePresence(['chat']);

    const toolPeers = await alice.findPeers({ capability: 'tools' });
    assert.equal(toolPeers.length, 1);
    assert.equal(toolPeers[0].fingerprint, 'fp-bob');
  });

  it('findPeers throws when not connected', async () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    await assert.rejects(
      () => client.findPeers(),
      /Not connected to relay/,
    );
  });

  // -- forwardSignal / onSignal -------------------------------------------

  it('forwardSignal delivers signal to target peer', async () => {
    const alice = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    const bob = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-bob' },
    });
    await alice.connect(server);
    await bob.connect(server);

    const received = [];
    bob.onSignal((from, signal) => received.push({ from, signal }));

    const ok = alice.forwardSignal('fp-bob', { sdp: 'offer-123' });
    assert.equal(ok, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].from, 'fp-alice');
    assert.deepEqual(received[0].signal, { sdp: 'offer-123' });
  });

  it('forwardSignal returns false for unknown target', async () => {
    const alice = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    await alice.connect(server);

    const ok = alice.forwardSignal('fp-nobody', { sdp: 'offer' });
    assert.equal(ok, false);
  });

  it('forwardSignal throws when not connected', () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    assert.throws(
      () => client.forwardSignal('fp-target', {}),
      /Not connected to relay/,
    );
  });

  // -- onPeerAnnounce -----------------------------------------------------

  it('onPeerAnnounce receives announcements from other peers', async () => {
    const alice = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    const bob = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-bob' },
    });
    await alice.connect(server);
    await bob.connect(server);

    const announcements = [];
    alice.onPeerAnnounce(info => announcements.push(info));
    bob.announcePresence(['agent', 'tools']);

    assert.equal(announcements.length, 1);
    assert.equal(announcements[0].fingerprint, 'fp-bob');
    assert.deepEqual(announcements[0].capabilities, ['agent', 'tools']);
  });

  // -- toJSON -------------------------------------------------------------

  it('toJSON returns serializable state when disconnected', () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    const json = client.toJSON();
    assert.equal(json.relayUrl, 'wss://relay.test');
    assert.equal(json.fingerprint, 'fp-1');
    assert.equal(json.connected, false);
    assert.equal(json.state, 'disconnected');
    assert.deepEqual(json.capabilities, []);
    assert.equal(json.knownPeerCount, 0);
  });

  it('toJSON reflects connected state and capabilities', async () => {
    const alice = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    const bob = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-bob' },
    });
    await alice.connect(server);
    await bob.connect(server);
    alice.announcePresence(['chat', 'tools']);
    await alice.findPeers();

    const json = alice.toJSON();
    assert.equal(json.connected, true);
    assert.equal(json.state, 'connected');
    assert.deepEqual(json.capabilities, ['chat', 'tools']);
    assert.equal(json.knownPeerCount, 1);
  });

  // -- Callback error isolation -------------------------------------------

  it('onConnect callback errors do not propagate', async () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    client.onConnect(() => { throw new Error('listener crash'); });
    // Should not throw
    await client.connect(server);
    assert.equal(client.connected, true);
  });

  it('onSignal callback errors do not propagate', async () => {
    const client = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-1' },
    });
    await client.connect(server);
    client.onSignal(() => { throw new Error('listener crash'); });
    // Should not throw
    client._deliverSignal('fp-other', { sdp: 'x' });
  });

  // -- End-to-end signal exchange -----------------------------------------

  it('two clients exchange signals through mock relay', async () => {
    const alice = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-alice' },
    });
    const bob = new MeshRelayClient({
      relayUrl: 'wss://relay.test',
      identity: { fingerprint: 'fp-bob' },
    });
    await alice.connect(server);
    await bob.connect(server);

    const aliceReceived = [];
    const bobReceived = [];
    alice.onSignal((from, sig) => aliceReceived.push({ from, sig }));
    bob.onSignal((from, sig) => bobReceived.push({ from, sig }));

    // Alice sends offer to Bob
    alice.forwardSignal('fp-bob', { type: 'offer', sdp: 'alice-sdp' });
    assert.equal(bobReceived.length, 1);
    assert.equal(bobReceived[0].from, 'fp-alice');
    assert.deepEqual(bobReceived[0].sig, { type: 'offer', sdp: 'alice-sdp' });

    // Bob sends answer back to Alice
    bob.forwardSignal('fp-alice', { type: 'answer', sdp: 'bob-sdp' });
    assert.equal(aliceReceived.length, 1);
    assert.equal(aliceReceived[0].from, 'fp-bob');
    assert.deepEqual(aliceReceived[0].sig, { type: 'answer', sdp: 'bob-sdp' });

    // Alice sends ICE candidate to Bob
    alice.forwardSignal('fp-bob', { type: 'ice', candidate: 'c1' });
    assert.equal(bobReceived.length, 2);
    assert.deepEqual(bobReceived[1].sig, { type: 'ice', candidate: 'c1' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// MeshRelayClient — REAL WebSocket path (paired-WS fixture)
// ─────────────────────────────────────────────────────────────────────

/**
 * In-test relay server fixture. Implements the wire protocol the real
 * `MeshRelayClient` speaks, mirroring `MockRelayServer`'s in-memory
 * semantics. Used to drive the WS-mode tests below — does NOT use
 * a real network.
 */
class FakeRelayServer {
  constructor() { this.clients = new Map(); }
  createConnection(fp) {
    const server = this;
    const fromClient = [];
    const fromServer = [];
    const closeListeners = [];
    let closed = false;
    const fakeWs = {
      readyState: 1,
      addEventListener(type, fn) {
        if (type === 'message') fromServer.push(fn);
        else if (type === 'open') queueMicrotask(fn);
        else if (type === 'close') closeListeners.push(fn);
      },
      removeEventListener() {},
      send(data) {
        if (closed) return;
        for (const h of fromClient) h(data);
      },
      close() {
        if (closed) return;
        closed = true;
        server.clients.delete(fp);
        for (const fn of closeListeners) fn({});
      },
      _injectMessage(msg) {
        if (closed) return;
        for (const fn of fromServer) fn({ data: JSON.stringify(msg) });
      },
    };
    fromClient.push((raw) => server._handleClientMessage(fp, fakeWs, JSON.parse(raw)));
    server.clients.set(fp, fakeWs);
    return fakeWs;
  }
  _handleClientMessage(fp, ws, msg) {
    if (msg.type === 'register') return;
    if (msg.type === 'announce') {
      ws._caps = msg.capabilities || [];
      for (const [otherFp, other] of this.clients) {
        if (otherFp === fp) continue;
        other._injectMessage({ type: 'peer_announce', fingerprint: fp, capabilities: ws._caps });
      }
    } else if (msg.type === 'find') {
      const peers = [...this.clients.entries()]
        .filter(([f]) => f !== fp)
        .map(([f, w]) => ({ fingerprint: f, capabilities: w._caps || [], endpoint: null }));
      ws._injectMessage({ type: 'find_response', requestId: msg.requestId, peers });
    } else if (msg.type === 'signal') {
      const target = this.clients.get(msg.to);
      if (target) target._injectMessage({ type: 'signal', from: msg.from, signal: msg.signal });
      else ws._injectMessage({ type: 'error', message: `target ${msg.to} not connected` });
    } else if (msg.type === 'unregister') {
      this.clients.delete(fp);
    }
  }
}

describe('MeshRelayClient — real WebSocket path', () => {
  it('connect + announce + find + signal end-to-end', async () => {
    const server = new FakeRelayServer();
    const makeWs = (fp) => function () { return server.createConnection(fp); };
    const alice = new MeshRelayClient({
      relayUrl: 'wss://t', identity: { fingerprint: 'alice' },
      WebSocket: makeWs('alice'), autoReconnect: false,
    });
    const bob = new MeshRelayClient({
      relayUrl: 'wss://t', identity: { fingerprint: 'bob' },
      WebSocket: makeWs('bob'), autoReconnect: false,
    });
    await alice.connect();
    await bob.connect();
    assert.equal(alice.connected, true);
    assert.equal(bob.connected, true);

    const aliceAnnouncements = [];
    alice.onPeerAnnounce((info) => aliceAnnouncements.push(info));
    bob.announcePresence(['signal', 'pubsub']);
    assert.equal(aliceAnnouncements.length, 1);
    assert.equal(aliceAnnouncements[0].fingerprint, 'bob');
    assert.deepEqual(aliceAnnouncements[0].capabilities, ['signal', 'pubsub']);

    const peers = await alice.findPeers();
    assert.equal(peers.length, 1);
    assert.equal(peers[0].fingerprint, 'bob');

    const bobSignals = [];
    bob.onSignal((from, sig) => bobSignals.push({ from, sig }));
    alice.forwardSignal('bob', { type: 'offer', sdp: 'a-sdp' });
    assert.equal(bobSignals.length, 1);
    assert.equal(bobSignals[0].from, 'alice');
    assert.deepEqual(bobSignals[0].sig, { type: 'offer', sdp: 'a-sdp' });

    alice.disconnect();
    bob.disconnect();
  });

  it('connect rejects when WS constructor throws', async () => {
    const ThrowingWs = function () { throw new Error('ws build failed'); };
    const c = new MeshRelayClient({
      relayUrl: 'wss://nope', identity: { fingerprint: 'x' },
      WebSocket: ThrowingWs, autoReconnect: false,
    });
    await assert.rejects(() => c.connect(), /ws build failed/);
    assert.equal(c.state, 'disconnected');
  });

  it('connect rejects when WS closes before open', async () => {
    const CloseWs = function () {
      const handlers = { close: [] };
      queueMicrotask(() => { for (const fn of handlers.close) fn({}); });
      return {
        readyState: 1,
        addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
        removeEventListener() {}, send() {}, close() {},
      };
    };
    const c = new MeshRelayClient({
      relayUrl: 'wss://nope', identity: { fingerprint: 'x' },
      WebSocket: CloseWs, autoReconnect: false,
    });
    await assert.rejects(() => c.connect(), /closed before open/);
  });

  it('disconnect closes the WS and rejects pending finds', async () => {
    // Build a fake WS that never responds to `find` so the request hangs.
    const HangingWs = function () {
      const handlers = { open: [], message: [], close: [] };
      let closed = false;
      queueMicrotask(() => { for (const fn of handlers.open) fn({}); });
      return {
        readyState: 1,
        addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
        removeEventListener() {},
        send() { /* swallow find */ },
        close() {
          if (closed) return;
          closed = true;
          for (const fn of handlers.close) fn({});
        },
      };
    };
    const c = new MeshRelayClient({
      relayUrl: 'wss://t', identity: { fingerprint: 'c' },
      WebSocket: HangingWs, autoReconnect: false,
    });
    await c.connect();
    const findP = c.findPeers();
    // Disconnect should reject the in-flight find.
    c.disconnect();
    await assert.rejects(() => findP, /relay disconnected/);
  });

  it('signaling unavailability — error event fires + connect rejects', async () => {
    const ErrWs = function () {
      const handlers = { error: [] };
      queueMicrotask(() => {
        for (const fn of handlers.error) fn({ error: new Error('ECONNREFUSED') });
      });
      return {
        readyState: 1,
        addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
        removeEventListener() {}, send() {}, close() {},
      };
    };
    const errs = [];
    const c = new MeshRelayClient({
      relayUrl: 'wss://x', identity: { fingerprint: 'x' },
      WebSocket: ErrWs, autoReconnect: false,
    });
    c.onError((e) => errs.push(e));
    await assert.rejects(() => c.connect(), /ECONNREFUSED/);
    assert.equal(errs.length, 1);
  });

  it('auto-reconnect fires error after exhausting attempts', async () => {
    const FailWs = function () {
      const handlers = { error: [], close: [] };
      queueMicrotask(() => {
        for (const fn of handlers.error) fn({ error: new Error('refused') });
        for (const fn of handlers.close) fn({});
      });
      return {
        readyState: 1,
        addEventListener(t, fn) { (handlers[t] = handlers[t] || []).push(fn); },
        removeEventListener() {}, send() {}, close() {},
      };
    };
    const errs = [];
    const c = new MeshRelayClient({
      relayUrl: 'wss://fail', identity: { fingerprint: 'x' },
      WebSocket: FailWs, maxReconnectAttempts: 2, reconnectDelayMs: 5,
      autoReconnect: true,
    });
    c.onError((e) => errs.push(e));
    await assert.rejects(() => c.connect(), /refused/);
    // Allow reconnect attempts (5ms + 10ms backoff) to exhaust.
    await new Promise(r => setTimeout(r, 100));
    assert.ok(
      errs.some(e => /reconnect failed after 2 attempts/.test(e.message)),
      `expected exhaustion error among: ${errs.map(e => e.message).join(' / ')}`,
    );
  });
});
