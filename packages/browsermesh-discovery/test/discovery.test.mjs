// Run with: node --import ./test/_setup-globals.mjs --test test/discovery.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  DISCOVERY_ANNOUNCE,
  DISCOVERY_QUERY,
  DISCOVERY_RESPONSE,
  DISCOVERY_GOODBYE,
  SVC_REGISTER,
  SVC_LOOKUP,
  RELAY_REGISTER,
  RELAY_QUERY,
  DiscoveryRecord,
  DiscoveryStrategy,
  BroadcastChannelStrategy,
  RelayStrategy,
  ManualStrategy,
  SharedWorkerRelayStrategy,
  DiscoveryManager,
  ServiceEndpoint,
  ServiceDirectory,
} from '../src/discovery.mjs';

// ---------------------------------------------------------------------------
// Wire Constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('DISCOVERY_ANNOUNCE equals 0xC0', () => {
    assert.equal(DISCOVERY_ANNOUNCE, 0xC0);
  });

  it('DISCOVERY_QUERY equals 0xC1', () => {
    assert.equal(DISCOVERY_QUERY, 0xC1);
  });

  it('DISCOVERY_RESPONSE equals 0xC2', () => {
    assert.equal(DISCOVERY_RESPONSE, 0xC2);
  });

  it('DISCOVERY_GOODBYE equals 0xC3', () => {
    assert.equal(DISCOVERY_GOODBYE, 0xC3);
  });

  it('SVC_REGISTER equals 0xC4', () => {
    assert.equal(SVC_REGISTER, 0xC4);
  });

  it('SVC_LOOKUP equals 0xC5', () => {
    assert.equal(SVC_LOOKUP, 0xC5);
  });
});

// ---------------------------------------------------------------------------
// DiscoveryRecord
// ---------------------------------------------------------------------------

describe('DiscoveryRecord', () => {
  it('constructor sets all fields', () => {
    const r = new DiscoveryRecord({
      podId: 'pod-1',
      label: 'My Node',
      endpoint: 'ws://localhost:9000',
      transport: 'websocket',
      capabilities: ['relay', 'storage'],
      metadata: { version: '1.0' },
      ttl: 60000,
      discoveredAt: 5000,
      source: 'broadcast',
    });
    assert.equal(r.podId, 'pod-1');
    assert.equal(r.label, 'My Node');
    assert.equal(r.endpoint, 'ws://localhost:9000');
    assert.equal(r.transport, 'websocket');
    assert.deepEqual(r.capabilities, ['relay', 'storage']);
    assert.deepEqual(r.metadata, { version: '1.0' });
    assert.equal(r.ttl, 60000);
    assert.equal(r.discoveredAt, 5000);
    assert.equal(r.source, 'broadcast');
  });

  it('constructor applies defaults', () => {
    const r = new DiscoveryRecord({ podId: 'pod-2' });
    assert.equal(r.podId, 'pod-2');
    assert.equal(r.label, null);
    assert.equal(r.endpoint, null);
    assert.equal(r.transport, null);
    assert.deepEqual(r.capabilities, []);
    assert.deepEqual(r.metadata, {});
    assert.equal(r.ttl, 30000);
    assert.equal(typeof r.discoveredAt, 'number');
    assert.equal(r.source, null);
  });

  it('constructor throws without podId', () => {
    assert.throws(() => new DiscoveryRecord({}), /podId is required/);
  });

  it('constructor throws for empty podId', () => {
    assert.throws(() => new DiscoveryRecord({ podId: '' }), /podId is required/);
  });

  it('constructor throws for non-string podId', () => {
    assert.throws(() => new DiscoveryRecord({ podId: 123 }), /podId is required/);
  });

  it('copies capabilities array', () => {
    const caps = ['a', 'b'];
    const r = new DiscoveryRecord({ podId: 'p', capabilities: caps });
    caps.push('c');
    assert.deepEqual(r.capabilities, ['a', 'b']);
  });

  it('copies metadata object', () => {
    const meta = { key: 'val' };
    const r = new DiscoveryRecord({ podId: 'p', metadata: meta });
    meta.key = 'changed';
    assert.deepEqual(r.metadata, { key: 'val' });
  });

  // -- isExpired --

  it('isExpired returns false when record is fresh', () => {
    const r = new DiscoveryRecord({ podId: 'p', ttl: 30000 });
    assert.equal(r.isExpired(), false);
  });

  it('isExpired returns true after TTL elapsed', () => {
    const r = new DiscoveryRecord({ podId: 'p', discoveredAt: 1000, ttl: 500 });
    assert.equal(r.isExpired(1500), true);
    assert.equal(r.isExpired(1499), false);
  });

  // -- toJSON / fromJSON --

  it('toJSON returns a plain object', () => {
    const r = new DiscoveryRecord({
      podId: 'pod-1',
      label: 'Node',
      endpoint: 'ws://x',
      transport: 'ws',
      capabilities: ['relay'],
      metadata: { v: 1 },
      ttl: 10000,
      discoveredAt: 2000,
      source: 'manual',
    });
    const json = r.toJSON();
    assert.deepEqual(json, {
      podId: 'pod-1',
      label: 'Node',
      endpoint: 'ws://x',
      transport: 'ws',
      capabilities: ['relay'],
      metadata: { v: 1 },
      ttl: 10000,
      discoveredAt: 2000,
      source: 'manual',
      peerType: 'unknown',
    });
  });

  it('fromJSON round-trips correctly', () => {
    const original = new DiscoveryRecord({
      podId: 'pod-rt',
      label: 'RT',
      endpoint: 'ws://y',
      transport: 'ws',
      capabilities: ['a', 'b'],
      metadata: { x: 2 },
      ttl: 15000,
      discoveredAt: 3000,
      source: 'relay',
    });
    const restored = DiscoveryRecord.fromJSON(original.toJSON());
    assert.deepEqual(restored.toJSON(), original.toJSON());
  });

  // -- peerType taxonomy --

  it('defaults peerType to "unknown" for backward compat', () => {
    const r = new DiscoveryRecord({ podId: 'pod-x' });
    assert.equal(r.peerType, 'unknown');
  });

  it('accepts canonical peer types', async () => {
    const { PEER_TYPE } = await import('../src/discovery.mjs');
    for (const value of Object.values(PEER_TYPE)) {
      const r = new DiscoveryRecord({ podId: 'p', peerType: value });
      assert.equal(r.peerType, value);
    }
  });

  it('normalises unknown peerType values to "unknown"', () => {
    const r = new DiscoveryRecord({ podId: 'pod-x', peerType: 'pirate-ship' });
    assert.equal(r.peerType, 'unknown');
  });

  it('matchesFilter filters by peerType (single value)', () => {
    const r = new DiscoveryRecord({ podId: 'p', peerType: 'runtime' });
    assert.equal(r.matchesFilter({ peerType: 'runtime' }), true);
    assert.equal(r.matchesFilter({ peerType: 'chat' }), false);
  });

  it('matchesFilter filters by peerType (array of allowed values)', () => {
    const r = new DiscoveryRecord({ podId: 'p', peerType: 'vm-compute' });
    assert.equal(r.matchesFilter({ peerType: ['vm-compute', 'host-shell'] }), true);
    assert.equal(r.matchesFilter({ peerType: ['chat'] }), false);
  });

  it('peerType is round-tripped through toJSON/fromJSON', () => {
    const r = new DiscoveryRecord({ podId: 'p', peerType: 'host-shell' });
    const restored = DiscoveryRecord.fromJSON(r.toJSON());
    assert.equal(restored.peerType, 'host-shell');
  });
});

// ---------------------------------------------------------------------------
// DiscoveryStrategy (abstract base)
// ---------------------------------------------------------------------------

describe('DiscoveryStrategy', () => {
  it('constructor sets type', () => {
    const s = new DiscoveryStrategy({ type: 'broadcast' });
    assert.equal(s.type, 'broadcast');
  });

  it('constructor throws without type', () => {
    assert.throws(() => new DiscoveryStrategy({}), /type is required/);
  });

  it('constructor throws for empty type', () => {
    assert.throws(() => new DiscoveryStrategy({ type: '' }), /type is required/);
  });

  it('starts inactive', () => {
    const s = new DiscoveryStrategy({ type: 'test' });
    assert.equal(s.active, false);
  });

  it('start/stop throw as abstract', async () => {
    const s = new DiscoveryStrategy({ type: 'test' });
    await assert.rejects(() => s.start(), /must be implemented by subclass/);
    await assert.rejects(() => s.stop(), /must be implemented by subclass/);
  });

  it('announce/query throw as abstract', async () => {
    const s = new DiscoveryStrategy({ type: 'test' });
    await assert.rejects(() => s.announce({}), /must be implemented by subclass/);
    await assert.rejects(() => s.query(), /must be implemented by subclass/);
  });

  it('onDiscovered registers callback', () => {
    const s = new DiscoveryStrategy({ type: 'test' });
    let called = false;
    s.onDiscovered(() => { called = true; });
    // Callback is registered but we cannot trigger it from base class directly
    assert.equal(called, false);
  });
});

// ---------------------------------------------------------------------------
// BroadcastChannelStrategy
// ---------------------------------------------------------------------------

describe('BroadcastChannelStrategy', () => {
  it('constructor defaults channelName', () => {
    const s = new BroadcastChannelStrategy({});
    assert.equal(s.type, 'broadcast');
  });

  it('constructor accepts custom channelName', () => {
    const s = new BroadcastChannelStrategy({ channelName: 'my-channel' });
    assert.equal(s.type, 'broadcast');
  });

  it('start activates the strategy', async () => {
    const s = new BroadcastChannelStrategy({});
    await s.start();
    assert.equal(s.active, true);
  });

  it('stop deactivates the strategy', async () => {
    const s = new BroadcastChannelStrategy({});
    await s.start();
    await s.stop();
    assert.equal(s.active, false);
  });

  it('stop is idempotent when not started', async () => {
    const s = new BroadcastChannelStrategy({});
    await s.stop();
    assert.equal(s.active, false);
  });

  it('announce posts message to channel', async () => {
    const s = new BroadcastChannelStrategy({});
    await s.start();
    const record = new DiscoveryRecord({ podId: 'pod-1' });
    // Should not throw (BroadcastChannel is a no-op polyfill in tests)
    await s.announce(record);
    await s.stop();
  });

  it('query returns empty array when no responses', async () => {
    const s = new BroadcastChannelStrategy({});
    await s.start();
    const results = await s.query();
    assert.ok(Array.isArray(results));
    await s.stop();
  });
});

// ---------------------------------------------------------------------------
// RelayStrategy
// ---------------------------------------------------------------------------

// Mock WebSocket helper for RelayStrategy tests
let __mockWs = null;
const __originalWS = globalThis.WebSocket;
function __installMockWS() {
  __mockWs = null;
  globalThis.WebSocket = class MockWebSocket {
    constructor() {
      this.readyState = 1;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onclose = null;
      this.onerror = null;
      __mockWs = this;
      const self = this;
      const poll = () => { if (self.onopen) self.onopen(); else setTimeout(poll, 1); };
      setTimeout(poll, 1);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close() { this.readyState = 3; if (this.onclose) this.onclose(); }
    _receive(data) { if (this.onmessage) this.onmessage({ data: JSON.stringify(data) }); }
  };
}
function __restoreMockWS() { globalThis.WebSocket = __originalWS; __mockWs = null; }

describe('RelayStrategy', () => {
  beforeEach(() => { __installMockWS(); });
  afterEach(() => { __restoreMockWS(); });

  it('constructor sets type to relay', () => {
    const s = new RelayStrategy({ relayUrl: 'ws://relay.example.com', podId: 'pod-1' });
    assert.equal(s.type, 'relay');
  });

  it('constructor throws without relayUrl', () => {
    assert.throws(
      () => new RelayStrategy({ podId: 'pod-1' }),
      /relayUrl is required/,
    );
  });

  it('constructor throws without podId', () => {
    assert.throws(
      () => new RelayStrategy({ relayUrl: 'ws://x' }),
      /podId is required/,
    );
  });

  it('start opens WebSocket and registers', async () => {
    const s = new RelayStrategy({ relayUrl: 'ws://x', podId: 'pod-test' });
    await s.start();
    assert.equal(s.active, true);
    assert.ok(__mockWs);
    assert.equal(__mockWs.sent.length, 1);
    assert.equal(__mockWs.sent[0].type, 'register');
    assert.equal(__mockWs.sent[0].podId, 'pod-test');
    await s.stop();
  });

  it('stop closes WebSocket and clears peers', async () => {
    const s = new RelayStrategy({ relayUrl: 'ws://x', podId: 'p' });
    await s.start();
    // Inject a peer
    __mockWs._receive({ type: 'peer-joined', podId: 'pod-remote' });
    const before = await s.query();
    assert.equal(before.length, 1);

    await s.stop();
    assert.equal(s.active, false);
    const after = await s.query();
    assert.equal(after.length, 0);
  });

  it('fires discovered callback on peers message', async () => {
    const s = new RelayStrategy({ relayUrl: 'ws://x', podId: 'pod-local' });
    const discovered = [];
    s.onDiscovered((record) => discovered.push(record));

    await s.start();
    __mockWs._receive({ type: 'peers', peers: ['pod-local', 'pod-a', 'pod-b'] });

    assert.equal(discovered.length, 2); // excludes self
    assert.ok(discovered.some(r => r.podId === 'pod-a'));
    assert.ok(discovered.some(r => r.podId === 'pod-b'));
    await s.stop();
  });

  it('fires discovered callback on peer-joined', async () => {
    const s = new RelayStrategy({ relayUrl: 'ws://x', podId: 'pod-local' });
    const discovered = [];
    s.onDiscovered((record) => discovered.push(record));

    await s.start();
    __mockWs._receive({ type: 'peer-joined', podId: 'pod-new' });

    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].podId, 'pod-new');
    assert.equal(discovered[0].source, 'relay');
    await s.stop();
  });

  it('removes peer on peer-left', async () => {
    const s = new RelayStrategy({ relayUrl: 'ws://x', podId: 'pod-local' });
    await s.start();

    __mockWs._receive({ type: 'peer-joined', podId: 'pod-gone' });
    assert.equal((await s.query()).length, 1);

    __mockWs._receive({ type: 'peer-left', podId: 'pod-gone' });
    assert.equal((await s.query()).length, 0);
    await s.stop();
  });

  it('does not discover self', async () => {
    const s = new RelayStrategy({ relayUrl: 'ws://x', podId: 'pod-me' });
    const discovered = [];
    s.onDiscovered((record) => discovered.push(record));

    await s.start();
    __mockWs._receive({ type: 'peer-joined', podId: 'pod-me' });

    assert.equal(discovered.length, 0);
    await s.stop();
  });

  it('announce sends over WebSocket', async () => {
    const s = new RelayStrategy({ relayUrl: 'ws://x', podId: 'p' });
    await s.start();
    const record = new DiscoveryRecord({ podId: 'p' });
    await s.announce(record);
    assert.equal(__mockWs.sent.length, 2); // register + announce
    assert.equal(__mockWs.sent[1].type, 'signal');
    await s.stop();
  });

  it('query returns cached peers', async () => {
    const s = new RelayStrategy({ relayUrl: 'ws://x', podId: 'pod-local' });
    await s.start();
    __mockWs._receive({ type: 'peers', peers: ['pod-local', 'pod-a'] });

    const results = await s.query();
    assert.equal(results.length, 1);
    assert.equal(results[0].podId, 'pod-a');
    await s.stop();
  });
});

// ---------------------------------------------------------------------------
// ManualStrategy
// ---------------------------------------------------------------------------

describe('ManualStrategy', () => {
  /** @type {ManualStrategy} */
  let manual;

  beforeEach(() => {
    manual = new ManualStrategy({});
  });

  it('constructor sets type to manual', () => {
    assert.equal(manual.type, 'manual');
  });

  it('start activates', async () => {
    await manual.start();
    assert.equal(manual.active, true);
  });

  it('stop deactivates', async () => {
    await manual.start();
    await manual.stop();
    assert.equal(manual.active, false);
  });

  it('addPeer adds a record', () => {
    const r = new DiscoveryRecord({ podId: 'pod-1' });
    manual.addPeer(r);
    assert.equal(manual.query().length, 1);
  });

  it('addPeer fires discovered callback', () => {
    let discovered = null;
    manual.onDiscovered((rec) => { discovered = rec; });
    const r = new DiscoveryRecord({ podId: 'pod-1' });
    manual.addPeer(r);
    assert.equal(discovered.podId, 'pod-1');
  });

  it('addPeer replaces existing peer with same podId', () => {
    manual.addPeer(new DiscoveryRecord({ podId: 'pod-1', label: 'A' }));
    manual.addPeer(new DiscoveryRecord({ podId: 'pod-1', label: 'B' }));
    const results = manual.query();
    assert.equal(results.length, 1);
    assert.equal(results[0].label, 'B');
  });

  it('removePeer removes a record', () => {
    manual.addPeer(new DiscoveryRecord({ podId: 'pod-1' }));
    assert.equal(manual.removePeer('pod-1'), true);
    assert.equal(manual.query().length, 0);
  });

  it('removePeer returns false for unknown podId', () => {
    assert.equal(manual.removePeer('nope'), false);
  });

  it('query returns all manually added peers', () => {
    manual.addPeer(new DiscoveryRecord({ podId: 'a' }));
    manual.addPeer(new DiscoveryRecord({ podId: 'b' }));
    manual.addPeer(new DiscoveryRecord({ podId: 'c' }));
    const results = manual.query();
    assert.equal(results.length, 3);
  });

  it('query with filter returns matching peers', () => {
    manual.addPeer(new DiscoveryRecord({ podId: 'a', capabilities: ['relay'] }));
    manual.addPeer(new DiscoveryRecord({ podId: 'b', capabilities: ['storage'] }));
    const results = manual.query({ capabilities: ['relay'] });
    assert.equal(results.length, 1);
    assert.equal(results[0].podId, 'a');
  });
});

// ---------------------------------------------------------------------------
// DiscoveryManager
// ---------------------------------------------------------------------------

describe('DiscoveryManager', () => {
  /** @type {DiscoveryManager} */
  let mgr;
  /** @type {ManualStrategy} */
  let manualStrategy;
  /** @type {DiscoveryRecord} */
  let localRecord;

  beforeEach(() => {
    manualStrategy = new ManualStrategy({});
    localRecord = new DiscoveryRecord({ podId: 'local-pod', label: 'Local' });
    mgr = new DiscoveryManager({
      strategies: [manualStrategy],
      localRecord,
      announceInterval: 15000,
    });
  });

  it('constructor throws without localRecord', () => {
    assert.throws(
      () => new DiscoveryManager({ strategies: [] }),
      /localRecord is required/,
    );
  });

  it('constructor defaults announceInterval', () => {
    const m = new DiscoveryManager({ localRecord });
    assert.ok(m);
  });

  it('start activates all strategies', async () => {
    await mgr.start();
    assert.equal(manualStrategy.active, true);
    await mgr.stop();
  });

  it('stop deactivates all strategies', async () => {
    await mgr.start();
    await mgr.stop();
    assert.equal(manualStrategy.active, false);
  });

  it('getPeers returns empty map initially', () => {
    const peers = mgr.getPeers();
    assert.equal(peers.size, 0);
  });

  it('getPeer returns null for unknown podId', () => {
    assert.equal(mgr.getPeer('unknown'), null);
  });

  it('discover merges results from all strategies', async () => {
    manualStrategy.addPeer(new DiscoveryRecord({ podId: 'a' }));
    manualStrategy.addPeer(new DiscoveryRecord({ podId: 'b' }));
    await mgr.start();
    const results = await mgr.discover();
    assert.equal(results.length, 2);
    await mgr.stop();
  });

  it('discover deduplicates by podId', async () => {
    const manual2 = new ManualStrategy({});
    mgr.addStrategy(manual2);
    manualStrategy.addPeer(new DiscoveryRecord({ podId: 'a', label: 'first' }));
    manual2.addPeer(new DiscoveryRecord({ podId: 'a', label: 'second' }));
    await mgr.start();
    const results = await mgr.discover();
    assert.equal(results.length, 1);
    await mgr.stop();
  });

  it('discover applies filter', async () => {
    manualStrategy.addPeer(new DiscoveryRecord({ podId: 'a', capabilities: ['relay'] }));
    manualStrategy.addPeer(new DiscoveryRecord({ podId: 'b', capabilities: ['storage'] }));
    await mgr.start();
    const results = await mgr.discover({ capabilities: ['relay'] });
    assert.equal(results.length, 1);
    assert.equal(results[0].podId, 'a');
    await mgr.stop();
  });

  it('onPeerDiscovered fires for new peers', async () => {
    const discovered = [];
    mgr.onPeerDiscovered((rec) => discovered.push(rec));
    await mgr.start();
    manualStrategy.addPeer(new DiscoveryRecord({ podId: 'new-peer' }));
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].podId, 'new-peer');
    await mgr.stop();
  });

  it('onPeerLost fires when peer is pruned', async () => {
    const lost = [];
    mgr.onPeerLost((rec) => lost.push(rec));
    await mgr.start();
    manualStrategy.addPeer(new DiscoveryRecord({ podId: 'old', ttl: 1, discoveredAt: 1 }));
    // Force prune
    mgr._pruneExpired();
    assert.equal(lost.length, 1);
    assert.equal(lost[0].podId, 'old');
    await mgr.stop();
  });

  it('addStrategy adds a new strategy', () => {
    const newStrategy = new ManualStrategy({});
    mgr.addStrategy(newStrategy);
    // Verify it works by adding a peer through it
    newStrategy.addPeer(new DiscoveryRecord({ podId: 'from-new' }));
    assert.equal(newStrategy.query().length, 1);
  });

  it('removeStrategy removes by type', () => {
    const removed = mgr.removeStrategy('manual');
    assert.equal(removed, true);
  });

  it('removeStrategy returns false for unknown type', () => {
    assert.equal(mgr.removeStrategy('nonexistent'), false);
  });

  it('_pruneExpired removes expired records from peers map', async () => {
    await mgr.start();
    manualStrategy.addPeer(new DiscoveryRecord({ podId: 'expired', ttl: 1, discoveredAt: 1 }));
    manualStrategy.addPeer(new DiscoveryRecord({ podId: 'fresh', ttl: 999999 }));
    mgr._pruneExpired();
    assert.equal(mgr.getPeer('expired'), null);
    assert.notEqual(mgr.getPeer('fresh'), null);
    await mgr.stop();
  });

  it('announce does not throw', async () => {
    await mgr.start();
    await mgr.announce();
    await mgr.stop();
  });

  it('toJSON serializes peers and strategies', async () => {
    await mgr.start();
    manualStrategy.addPeer(new DiscoveryRecord({ podId: 'a' }));
    const json = mgr.toJSON();
    assert.equal(json.localRecord.podId, 'local-pod');
    assert.ok(Array.isArray(json.strategies));
    assert.ok(Array.isArray(json.peers));
    await mgr.stop();
  });

  it('fromJSON restores manager state', () => {
    manualStrategy.addPeer(new DiscoveryRecord({ podId: 'a', discoveredAt: 5000, ttl: 99999 }));
    const json = mgr.toJSON();
    const restored = DiscoveryManager.fromJSON(json);
    assert.equal(restored.getPeers().size, 1);
  });
});

// ---------------------------------------------------------------------------
// ServiceEndpoint
// ---------------------------------------------------------------------------

describe('ServiceEndpoint', () => {
  it('constructor sets all fields', () => {
    const ep = new ServiceEndpoint({
      name: 'chat',
      podId: 'pod-1',
      protocol: 'svc',
      version: '2.0',
      metadata: { maxConn: 10 },
      ttl: 120000,
      registeredAt: 8000,
    });
    assert.equal(ep.name, 'chat');
    assert.equal(ep.podId, 'pod-1');
    assert.equal(ep.protocol, 'svc');
    assert.equal(ep.version, '2.0');
    assert.deepEqual(ep.metadata, { maxConn: 10 });
    assert.equal(ep.ttl, 120000);
    assert.equal(ep.registeredAt, 8000);
  });

  it('constructor applies defaults', () => {
    const ep = new ServiceEndpoint({ name: 'fs', podId: 'pod-2' });
    assert.equal(ep.protocol, 'svc');
    assert.equal(ep.version, '1.0');
    assert.deepEqual(ep.metadata, {});
    assert.equal(ep.ttl, 60000);
    assert.equal(typeof ep.registeredAt, 'number');
  });

  it('constructor throws without name', () => {
    assert.throws(() => new ServiceEndpoint({ podId: 'p' }), /name is required/);
  });

  it('constructor throws for empty name', () => {
    assert.throws(() => new ServiceEndpoint({ name: '', podId: 'p' }), /name is required/);
  });

  it('constructor throws without podId', () => {
    assert.throws(() => new ServiceEndpoint({ name: 'chat' }), /podId is required/);
  });

  it('constructor throws for empty podId', () => {
    assert.throws(() => new ServiceEndpoint({ name: 'chat', podId: '' }), /podId is required/);
  });

  it('uri returns svc://podId/name format', () => {
    const ep = new ServiceEndpoint({ name: 'chat', podId: 'pod-1' });
    assert.equal(ep.uri, 'svc://pod-1/chat');
  });

  it('isExpired returns false when fresh', () => {
    const ep = new ServiceEndpoint({ name: 'chat', podId: 'pod-1', ttl: 60000 });
    assert.equal(ep.isExpired(), false);
  });

  it('isExpired returns true after TTL', () => {
    const ep = new ServiceEndpoint({ name: 'chat', podId: 'pod-1', ttl: 500, registeredAt: 1000 });
    assert.equal(ep.isExpired(1500), true);
    assert.equal(ep.isExpired(1499), false);
  });

  it('toJSON returns a plain object', () => {
    const ep = new ServiceEndpoint({
      name: 'chat',
      podId: 'pod-1',
      version: '2.0',
      metadata: { x: 1 },
      ttl: 30000,
      registeredAt: 4000,
    });
    const json = ep.toJSON();
    assert.equal(json.name, 'chat');
    assert.equal(json.podId, 'pod-1');
    assert.equal(json.protocol, 'svc');
    assert.equal(json.version, '2.0');
    assert.deepEqual(json.metadata, { x: 1 });
    assert.equal(json.ttl, 30000);
    assert.equal(json.registeredAt, 4000);
  });

  it('fromJSON round-trips correctly', () => {
    const original = new ServiceEndpoint({
      name: 'store',
      podId: 'pod-3',
      version: '1.5',
      metadata: { region: 'us' },
      ttl: 45000,
      registeredAt: 6000,
    });
    const restored = ServiceEndpoint.fromJSON(original.toJSON());
    assert.deepEqual(restored.toJSON(), original.toJSON());
    assert.equal(restored.uri, 'svc://pod-3/store');
  });
});

// ---------------------------------------------------------------------------
// ServiceDirectory
// ---------------------------------------------------------------------------

describe('ServiceDirectory', () => {
  /** @type {ServiceDirectory} */
  let dir;

  beforeEach(() => {
    dir = new ServiceDirectory({ localPodId: 'local-pod' });
  });

  it('constructor throws without localPodId', () => {
    assert.throws(() => new ServiceDirectory({}), /localPodId is required/);
  });

  it('constructor throws for empty localPodId', () => {
    assert.throws(() => new ServiceDirectory({ localPodId: '' }), /localPodId is required/);
  });

  it('starts with no services', () => {
    assert.deepEqual(dir.listLocal(), []);
    assert.deepEqual(dir.listRemote(), []);
    assert.deepEqual(dir.listAll(), []);
  });

  // -- register --

  it('register creates a local service and returns endpoint', () => {
    const handler = () => {};
    const ep = dir.register('chat', handler);
    assert.ok(ep instanceof ServiceEndpoint);
    assert.equal(ep.name, 'chat');
    assert.equal(ep.podId, 'local-pod');
    assert.equal(ep.uri, 'svc://local-pod/chat');
  });

  it('register with opts passes metadata and ttl', () => {
    const ep = dir.register('chat', () => {}, { metadata: { v: 1 }, ttl: 90000 });
    assert.deepEqual(ep.metadata, { v: 1 });
    assert.equal(ep.ttl, 90000);
  });

  it('register fires onRegister callback', () => {
    let registered = null;
    dir.onRegister((ep) => { registered = ep; });
    dir.register('chat', () => {});
    assert.equal(registered.name, 'chat');
  });

  it('register throws for duplicate service name', () => {
    dir.register('chat', () => {});
    assert.throws(() => dir.register('chat', () => {}), /already registered/);
  });

  it('register throws without name', () => {
    assert.throws(() => dir.register('', () => {}), /name is required/);
  });

  it('register throws without handler', () => {
    assert.throws(() => dir.register('chat'), /handler is required/);
  });

  // -- unregister --

  it('unregister removes a local service', () => {
    dir.register('chat', () => {});
    assert.equal(dir.unregister('chat'), true);
    assert.deepEqual(dir.listLocal(), []);
  });

  it('unregister fires onUnregister callback', () => {
    let unregistered = null;
    dir.onUnregister((name) => { unregistered = name; });
    dir.register('chat', () => {});
    dir.unregister('chat');
    assert.equal(unregistered, 'chat');
  });

  it('unregister returns false for unknown service', () => {
    assert.equal(dir.unregister('nope'), false);
  });

  // -- lookup --

  it('lookup resolves local service by URI', () => {
    dir.register('chat', () => {});
    const result = dir.lookup('svc://local-pod/chat');
    assert.ok(result);
    assert.equal(result.endpoint.name, 'chat');
    assert.equal(result.isLocal, true);
  });

  it('lookup resolves remote service by URI', () => {
    const ep = new ServiceEndpoint({ name: 'chat', podId: 'remote-pod' });
    dir.addRemote(ep);
    const result = dir.lookup('svc://remote-pod/chat');
    assert.ok(result);
    assert.equal(result.endpoint.name, 'chat');
    assert.equal(result.isLocal, false);
  });

  it('lookup returns null for unknown URI', () => {
    assert.equal(dir.lookup('svc://unknown/service'), null);
  });

  it('lookup returns null for malformed URI', () => {
    assert.equal(dir.lookup('http://invalid'), null);
  });

  // -- lookupByName --

  it('lookupByName finds all endpoints with given name', () => {
    dir.register('chat', () => {});
    dir.addRemote(new ServiceEndpoint({ name: 'chat', podId: 'remote-1' }));
    dir.addRemote(new ServiceEndpoint({ name: 'chat', podId: 'remote-2' }));
    const results = dir.lookupByName('chat');
    assert.equal(results.length, 3);
  });

  it('lookupByName returns empty for unknown name', () => {
    assert.deepEqual(dir.lookupByName('nope'), []);
  });

  // -- addRemote / removeRemote --

  it('addRemote adds a remote service endpoint', () => {
    const ep = new ServiceEndpoint({ name: 'store', podId: 'remote-pod' });
    dir.addRemote(ep);
    assert.equal(dir.listRemote().length, 1);
  });

  it('addRemote replaces existing remote with same URI', () => {
    dir.addRemote(new ServiceEndpoint({ name: 'store', podId: 'remote', version: '1.0' }));
    dir.addRemote(new ServiceEndpoint({ name: 'store', podId: 'remote', version: '2.0' }));
    const remotes = dir.listRemote();
    assert.equal(remotes.length, 1);
    assert.equal(remotes[0].version, '2.0');
  });

  it('removeRemote removes by URI', () => {
    const ep = new ServiceEndpoint({ name: 'store', podId: 'remote' });
    dir.addRemote(ep);
    assert.equal(dir.removeRemote('svc://remote/store'), true);
    assert.equal(dir.listRemote().length, 0);
  });

  it('removeRemote returns false for unknown URI', () => {
    assert.equal(dir.removeRemote('svc://unknown/svc'), false);
  });

  // -- listLocal / listRemote / listAll --

  it('listLocal returns only local endpoints', () => {
    dir.register('chat', () => {});
    dir.addRemote(new ServiceEndpoint({ name: 'store', podId: 'remote' }));
    const locals = dir.listLocal();
    assert.equal(locals.length, 1);
    assert.equal(locals[0].name, 'chat');
  });

  it('listRemote returns only remote endpoints', () => {
    dir.register('chat', () => {});
    dir.addRemote(new ServiceEndpoint({ name: 'store', podId: 'remote' }));
    const remotes = dir.listRemote();
    assert.equal(remotes.length, 1);
    assert.equal(remotes[0].name, 'store');
  });

  it('listAll returns both local and remote endpoints', () => {
    dir.register('chat', () => {});
    dir.addRemote(new ServiceEndpoint({ name: 'store', podId: 'remote' }));
    const all = dir.listAll();
    assert.equal(all.length, 2);
  });

  // -- callbacks --

  it('onRegister supports multiple callbacks', () => {
    const calls = [];
    dir.onRegister((ep) => calls.push('a:' + ep.name));
    dir.onRegister((ep) => calls.push('b:' + ep.name));
    dir.register('chat', () => {});
    assert.deepEqual(calls, ['a:chat', 'b:chat']);
  });

  it('onUnregister supports multiple callbacks', () => {
    const calls = [];
    dir.onUnregister((name) => calls.push('a:' + name));
    dir.onUnregister((name) => calls.push('b:' + name));
    dir.register('chat', () => {});
    dir.unregister('chat');
    assert.deepEqual(calls, ['a:chat', 'b:chat']);
  });
});

// ---------------------------------------------------------------------------
// SharedWorkerRelayStrategy
// ---------------------------------------------------------------------------

function createMockSharedWorker() {
  const port = {
    messages: [],
    onmessage: null,
    postMessage(data) { this.messages.push(data); },
    start() {},
    close() {},
  };
  return { port };
}

describe('SharedWorkerRelayStrategy', () => {
  /** @type {SharedWorkerRelayStrategy} */
  let strategy;
  /** @type {ReturnType<typeof createMockSharedWorker>} */
  let mockWorker;

  beforeEach(() => {
    mockWorker = createMockSharedWorker();
    strategy = new SharedWorkerRelayStrategy({
      createWorkerFn: () => mockWorker,
    });
  });

  it('constructor sets type to shared-worker', () => {
    assert.equal(strategy.type, 'shared-worker');
  });

  it('start activates the strategy', async () => {
    await strategy.start();
    assert.equal(strategy.active, true);
  });

  it('stop deactivates the strategy', async () => {
    await strategy.start();
    await strategy.stop();
    assert.equal(strategy.active, false);
  });

  it('announce sends register message via port', async () => {
    await strategy.start();
    const record = new DiscoveryRecord({ podId: 'pod-1', label: 'Test' });
    await strategy.announce(record);
    assert.equal(mockWorker.port.messages.length, 1);
    const msg = mockWorker.port.messages[0];
    assert.equal(msg.type, 'register');
    assert.equal(msg.podId, 'pod-1');
    assert.equal(msg.profile.podId, 'pod-1');
    assert.equal(msg.profile.label, 'Test');
  });

  it('query returns cached peers', async () => {
    await strategy.start();
    // Simulate a peers response from the worker
    const peerProfile = new DiscoveryRecord({ podId: 'peer-1', capabilities: ['relay'] }).toJSON();
    mockWorker.port.onmessage({ data: { type: 'peers', peers: [peerProfile] } });
    const results = await strategy.query();
    assert.equal(results.length, 1);
    assert.equal(results[0].podId, 'peer-1');
  });

  it('handles peers response from worker', async () => {
    await strategy.start();
    const peerA = new DiscoveryRecord({ podId: 'a' }).toJSON();
    const peerB = new DiscoveryRecord({ podId: 'b' }).toJSON();
    mockWorker.port.onmessage({ data: { type: 'peers', peers: [peerA, peerB] } });
    const results = await strategy.query();
    assert.equal(results.length, 2);
  });

  it('handles announce from worker and fires onDiscovered', async () => {
    await strategy.start();
    const discovered = [];
    strategy.onDiscovered((rec) => discovered.push(rec));
    const peerProfile = new DiscoveryRecord({ podId: 'new-peer', label: 'New' }).toJSON();
    mockWorker.port.onmessage({ data: { type: 'announce', record: peerProfile } });
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].podId, 'new-peer');
    assert.equal(discovered[0].source, 'shared-worker');
  });

  it('handles relay messages', async () => {
    await strategy.start();
    const discovered = [];
    strategy.onDiscovered((rec) => discovered.push(rec));
    const payload = new DiscoveryRecord({ podId: 'relayed-peer' }).toJSON();
    mockWorker.port.onmessage({ data: { type: 'relay', from: 'sender', payload } });
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].podId, 'relayed-peer');
    assert.equal(discovered[0].source, 'shared-worker');
  });

  it('stop sends unregister message', async () => {
    await strategy.start();
    mockWorker.port.messages = []; // clear any previous messages
    await strategy.stop();
    assert.equal(mockWorker.port.messages.length, 1);
    assert.equal(mockWorker.port.messages[0].type, 'unregister');
  });

  it('multiple start calls are idempotent', async () => {
    await strategy.start();
    const firstPort = mockWorker.port;
    await strategy.start(); // second call should be a no-op
    assert.equal(strategy.active, true);
    // Port should still be the same mock (factory not called twice)
    assert.equal(firstPort, mockWorker.port);
  });

  it('query filters by capabilities', async () => {
    await strategy.start();
    const peerA = new DiscoveryRecord({ podId: 'a', capabilities: ['relay'] }).toJSON();
    const peerB = new DiscoveryRecord({ podId: 'b', capabilities: ['storage'] }).toJSON();
    mockWorker.port.onmessage({ data: { type: 'peers', peers: [peerA, peerB] } });
    const results = await strategy.query({ capabilities: ['relay'] });
    assert.equal(results.length, 1);
    assert.equal(results[0].podId, 'a');
  });

  it('RELAY_REGISTER and RELAY_QUERY constants exist', () => {
    assert.equal(RELAY_REGISTER, 0x96);
    assert.equal(RELAY_QUERY, 0x97);
  });
});
