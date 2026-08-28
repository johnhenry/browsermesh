// Run with: node --import ./test/_setup-globals.mjs --test test/peer.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  PeerState,
  MeshPeerManager,
  PEER_STATUSES,
} from '../src/peer.mjs';

// ── PEER_STATUSES ───────────────────────────────────────────────

describe('PEER_STATUSES', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(PEER_STATUSES));
  });

  it('contains exactly four statuses', () => {
    assert.equal(PEER_STATUSES.length, 4);
  });

  it('contains the expected lifecycle statuses in order', () => {
    assert.deepEqual(PEER_STATUSES, [
      'disconnected',
      'connecting',
      'connected',
      'authenticated',
    ]);
  });

  it('cannot be modified', () => {
    assert.throws(() => { PEER_STATUSES.push('extra'); }, TypeError);
  });
});

// ── PeerState ───────────────────────────────────────────────────

describe('PeerState', () => {
  it('constructor sets all provided fields', () => {
    const peer = new PeerState({
      fingerprint: 'abc123',
      label: 'Alice',
      status: 'connected',
      transport: 'webrtc',
      endpoint: 'wss://example.com',
      latency: 42,
      lastSeen: 1000,
      capabilities: ['chat', 'fs'],
      trustLevel: 3,
    });
    assert.equal(peer.fingerprint, 'abc123');
    assert.equal(peer.label, 'Alice');
    assert.equal(peer.status, 'connected');
    assert.equal(peer.transport, 'webrtc');
    assert.equal(peer.endpoint, 'wss://example.com');
    assert.equal(peer.latency, 42);
    assert.equal(peer.lastSeen, 1000);
    assert.deepEqual(peer.capabilities, ['chat', 'fs']);
    assert.equal(peer.trustLevel, 3);
  });

  it('applies default values when not provided', () => {
    const peer = new PeerState({ fingerprint: 'xyz' });
    assert.equal(peer.fingerprint, 'xyz');
    assert.equal(peer.label, null);
    assert.equal(peer.status, 'disconnected');
    assert.equal(peer.transport, null);
    assert.equal(peer.endpoint, null);
    assert.equal(peer.latency, null);
    assert.equal(typeof peer.lastSeen, 'number');
    assert.deepEqual(peer.capabilities, []);
    assert.equal(peer.trustLevel, 0);
  });

  it('throws when fingerprint is missing', () => {
    assert.throws(() => new PeerState({}), /fingerprint is required/);
  });

  it('throws when fingerprint is not a string', () => {
    assert.throws(() => new PeerState({ fingerprint: 123 }), /fingerprint is required/);
  });

  it('throws when fingerprint is an empty string', () => {
    assert.throws(() => new PeerState({ fingerprint: '' }), /fingerprint is required/);
  });

  it('copies capabilities array (mutations do not leak)', () => {
    const caps = ['a', 'b'];
    const peer = new PeerState({ fingerprint: 'fp', capabilities: caps });
    caps.push('c');
    assert.deepEqual(peer.capabilities, ['a', 'b']);
  });

  it('toJSON returns a plain object copy', () => {
    const peer = new PeerState({
      fingerprint: 'fp1',
      label: 'Bob',
      capabilities: ['tools'],
    });
    const json = peer.toJSON();
    assert.equal(json.fingerprint, 'fp1');
    assert.equal(json.label, 'Bob');
    assert.deepEqual(json.capabilities, ['tools']);
    // Capabilities array is a copy
    json.capabilities.push('extra');
    assert.deepEqual(peer.capabilities, ['tools']);
  });

  it('toJSON includes all fields', () => {
    const peer = new PeerState({
      fingerprint: 'fp-full',
      label: 'Full',
      status: 'authenticated',
      transport: 'wsh-ws',
      endpoint: 'ws://relay',
      latency: 10,
      lastSeen: 5000,
      capabilities: ['x'],
      trustLevel: 7,
    });
    const json = peer.toJSON();
    assert.deepEqual(Object.keys(json).sort(), [
      'capabilities', 'endpoint', 'fingerprint', 'label',
      'lastSeen', 'latency', 'status', 'transport', 'trustLevel',
    ]);
  });

  it('fromJSON round-trips correctly', () => {
    const original = new PeerState({
      fingerprint: 'fp2',
      label: 'Carol',
      status: 'authenticated',
      transport: 'wsh-ws',
      endpoint: 'ws://relay.example',
      latency: 15,
      lastSeen: 9999,
      capabilities: ['agent'],
      trustLevel: 5,
    });
    const restored = PeerState.fromJSON(original.toJSON());
    assert.deepEqual(restored.toJSON(), original.toJSON());
  });

  it('fromJSON produces a PeerState instance', () => {
    const restored = PeerState.fromJSON({ fingerprint: 'from-json' });
    assert.ok(restored instanceof PeerState);
  });
});

// ── MeshPeerManager ─────────────────────────────────────────────

describe('MeshPeerManager', () => {
  /** @type {MeshPeerManager} */
  let mgr;

  beforeEach(() => {
    mgr = new MeshPeerManager();
  });

  // -- addPeer / getPeer --------------------------------------------------

  it('addPeer creates a new peer with defaults', () => {
    const peer = mgr.addPeer('fp1', { label: 'Alice' });
    assert.equal(peer.fingerprint, 'fp1');
    assert.equal(peer.label, 'Alice');
    assert.equal(peer.status, 'disconnected');
    assert.equal(mgr.size, 1);
  });

  it('addPeer updates an existing peer instead of duplicating', () => {
    mgr.addPeer('fp1', { label: 'Alice' });
    const updated = mgr.addPeer('fp1', { label: 'Alice-v2', trustLevel: 2 });
    assert.equal(updated.label, 'Alice-v2');
    assert.equal(updated.trustLevel, 2);
    assert.equal(mgr.size, 1);
  });

  it('addPeer with no info uses defaults', () => {
    const peer = mgr.addPeer('fp-bare');
    assert.equal(peer.fingerprint, 'fp-bare');
    assert.equal(peer.status, 'disconnected');
    assert.equal(peer.trustLevel, 0);
  });

  // -- updatePeer ---------------------------------------------------------

  it('updatePeer merges updates into existing peer', () => {
    mgr.addPeer('fp1', { label: 'Before' });
    mgr.updatePeer('fp1', { label: 'After', trustLevel: 5 });
    const peer = mgr.getPeer('fp1');
    assert.equal(peer.label, 'After');
    assert.equal(peer.trustLevel, 5);
  });

  it('updatePeer returns null for unknown peer', () => {
    assert.equal(mgr.updatePeer('nope', {}), null);
  });

  it('updatePeer refreshes lastSeen', () => {
    mgr.addPeer('fp1');
    const before = mgr.getPeer('fp1').lastSeen;
    mgr.updatePeer('fp1', { label: 'updated' });
    assert.ok(mgr.getPeer('fp1').lastSeen >= before);
  });

  it('updatePeer fires connect callback on disconnected -> connected', () => {
    const events = [];
    mgr.onPeerConnect(peer => events.push(peer.fingerprint));
    mgr.addPeer('fp1');
    mgr.updatePeer('fp1', { status: 'connected' });
    assert.deepEqual(events, ['fp1']);
  });

  it('updatePeer fires disconnect callback on connected -> disconnected', () => {
    const events = [];
    mgr.onPeerDisconnect(peer => events.push(peer.fingerprint));
    mgr.connect('fp1');
    mgr.updatePeer('fp1', { status: 'disconnected' });
    assert.deepEqual(events, ['fp1']);
  });

  it('updatePeer fires connect callback on disconnected -> authenticated', () => {
    const events = [];
    mgr.onPeerConnect(peer => events.push(peer.fingerprint));
    mgr.addPeer('fp1');
    mgr.updatePeer('fp1', { status: 'authenticated' });
    assert.deepEqual(events, ['fp1']);
  });

  // -- connect / disconnect -----------------------------------------------

  it('connect sets status and transport', () => {
    mgr.addPeer('fp1');
    mgr.connect('fp1', { transport: 'webrtc', endpoint: 'wss://peer' });
    const peer = mgr.getPeer('fp1');
    assert.equal(peer.status, 'connected');
    assert.equal(peer.transport, 'webrtc');
    assert.equal(peer.endpoint, 'wss://peer');
  });

  it('connect creates peer if not already known', () => {
    mgr.connect('fp_new', { transport: 'wsh-ws' });
    const peer = mgr.getPeer('fp_new');
    assert.ok(peer);
    assert.equal(peer.status, 'connected');
    assert.equal(peer.transport, 'wsh-ws');
  });

  it('connect defaults transport and endpoint to null when not given', () => {
    mgr.connect('fp1');
    const peer = mgr.getPeer('fp1');
    assert.equal(peer.status, 'connected');
    assert.equal(peer.transport, null);
    assert.equal(peer.endpoint, null);
  });

  it('disconnect sets status to disconnected and clears transport', () => {
    mgr.connect('fp1', { transport: 'webrtc' });
    mgr.disconnect('fp1');
    const peer = mgr.getPeer('fp1');
    assert.equal(peer.status, 'disconnected');
    assert.equal(peer.transport, null);
  });

  it('disconnect is a no-op for unknown peer', () => {
    // Should not throw
    mgr.disconnect('nonexistent');
  });

  // -- disconnectAll ------------------------------------------------------

  it('disconnectAll disconnects every peer', () => {
    mgr.connect('fp1', { transport: 'webrtc' });
    mgr.connect('fp2', { transport: 'wsh-ws' });
    mgr.connect('fp3', { transport: 'wsh-wt' });
    mgr.disconnectAll();
    for (const peer of mgr.listPeers()) {
      assert.equal(peer.status, 'disconnected');
      assert.equal(peer.transport, null);
    }
  });

  it('disconnectAll fires disconnect callback for each peer', () => {
    const events = [];
    mgr.onPeerDisconnect(peer => events.push(peer.fingerprint));
    mgr.connect('fp1');
    mgr.connect('fp2');
    mgr.disconnectAll();
    assert.equal(events.length, 2);
    assert.ok(events.includes('fp1'));
    assert.ok(events.includes('fp2'));
  });

  it('disconnectAll is safe when no peers exist', () => {
    mgr.disconnectAll(); // should not throw
    assert.equal(mgr.size, 0);
  });

  // -- removePeer ---------------------------------------------------------

  it('removePeer deletes peer entirely', () => {
    mgr.addPeer('fp1');
    assert.equal(mgr.removePeer('fp1'), true);
    assert.equal(mgr.getPeer('fp1'), null);
    assert.equal(mgr.size, 0);
  });

  it('removePeer returns false for unknown peer', () => {
    assert.equal(mgr.removePeer('nope'), false);
  });

  // -- listPeers ----------------------------------------------------------

  it('listPeers returns all peers when no filter given', () => {
    mgr.addPeer('fp1', { label: 'A' });
    mgr.addPeer('fp2', { label: 'B' });
    mgr.addPeer('fp3', { label: 'C' });
    const list = mgr.listPeers();
    assert.equal(list.length, 3);
  });

  it('listPeers filters by status', () => {
    mgr.addPeer('fp1');
    mgr.connect('fp2');
    mgr.connect('fp3');
    const connected = mgr.listPeers({ status: 'connected' });
    assert.equal(connected.length, 2);
    const disconnected = mgr.listPeers({ status: 'disconnected' });
    assert.equal(disconnected.length, 1);
  });

  it('listPeers filters by minTrust', () => {
    mgr.addPeer('fp1', { trustLevel: 1 });
    mgr.addPeer('fp2', { trustLevel: 5 });
    mgr.addPeer('fp3', { trustLevel: 3 });
    const trusted = mgr.listPeers({ minTrust: 3 });
    assert.equal(trusted.length, 2);
    assert.ok(trusted.every(p => p.trustLevel >= 3));
  });

  it('listPeers with minTrust of 0 returns all peers', () => {
    mgr.addPeer('fp1', { trustLevel: 0 });
    mgr.addPeer('fp2', { trustLevel: 1 });
    const all = mgr.listPeers({ minTrust: 0 });
    assert.equal(all.length, 2);
  });

  it('listPeers combines status and minTrust filters', () => {
    mgr.addPeer('fp1', { trustLevel: 5 }); // disconnected, trust 5
    mgr.connect('fp2');                      // connected, trust 0
    mgr.addPeer('fp3', { trustLevel: 5 });
    mgr.connect('fp3');                      // connected, trust 5
    const result = mgr.listPeers({ status: 'connected', minTrust: 3 });
    assert.equal(result.length, 1);
    assert.equal(result[0].fingerprint, 'fp3');
  });

  // -- getPeer ------------------------------------------------------------

  it('getPeer returns null for unknown fingerprint', () => {
    assert.equal(mgr.getPeer('nonexistent'), null);
  });

  it('getPeer returns the correct peer', () => {
    mgr.addPeer('fp1', { label: 'Alice' });
    mgr.addPeer('fp2', { label: 'Bob' });
    assert.equal(mgr.getPeer('fp2').label, 'Bob');
  });

  // -- Lifecycle callbacks ------------------------------------------------

  it('onPeerConnect fires when peer becomes connected', () => {
    const events = [];
    mgr.onPeerConnect(peer => events.push(peer.fingerprint));
    mgr.addPeer('fp1');
    mgr.connect('fp1');
    assert.deepEqual(events, ['fp1']);
  });

  it('onPeerConnect does not fire when already connected', () => {
    const events = [];
    mgr.onPeerConnect(peer => events.push(peer.fingerprint));
    mgr.connect('fp1');
    // Re-update to connected (no transition)
    mgr.updatePeer('fp1', { status: 'connected' });
    assert.equal(events.length, 1);
  });

  it('onPeerDisconnect fires on disconnection', () => {
    const events = [];
    mgr.onPeerDisconnect(peer => events.push(peer.fingerprint));
    mgr.connect('fp1');
    mgr.disconnect('fp1');
    assert.deepEqual(events, ['fp1']);
  });

  it('onPeerDisconnect does not fire if peer was already disconnected', () => {
    const events = [];
    mgr.onPeerDisconnect(peer => events.push(peer.fingerprint));
    mgr.addPeer('fp1'); // starts disconnected
    mgr.updatePeer('fp1', { status: 'disconnected' });
    assert.equal(events.length, 0);
  });

  it('onPeerDiscovered fires for each discovered peer', () => {
    const events = [];
    mgr.onPeerDiscovered(peer => events.push(peer.fingerprint));
    mgr.discovered([
      { fingerprint: 'fp1', label: 'Alice' },
      { fingerprint: 'fp2', label: 'Bob' },
    ]);
    assert.deepEqual(events, ['fp1', 'fp2']);
    assert.equal(mgr.size, 2);
  });

  it('callback errors do not propagate', () => {
    mgr.onPeerConnect(() => { throw new Error('boom'); });
    // Should not throw
    mgr.connect('fp1');
    assert.equal(mgr.getPeer('fp1').status, 'connected');
  });

  it('multiple callbacks all fire for same event', () => {
    const results = [];
    mgr.onPeerConnect(() => results.push('a'));
    mgr.onPeerConnect(() => results.push('b'));
    mgr.connect('fp1');
    assert.deepEqual(results, ['a', 'b']);
  });

  // -- discovered ---------------------------------------------------------

  it('discovered adds peers to the registry', () => {
    mgr.discovered([
      { fingerprint: 'fp_a' },
      { fingerprint: 'fp_b', label: 'Bravo' },
    ]);
    assert.equal(mgr.size, 2);
    assert.equal(mgr.getPeer('fp_b').label, 'Bravo');
  });

  it('discovered with empty array is a no-op', () => {
    mgr.discovered([]);
    assert.equal(mgr.size, 0);
  });

  // -- advertise / getAdvertisedCapabilities ------------------------------

  it('advertise stores own capabilities', () => {
    mgr.advertise(['chat', 'tools', 'fs']);
    assert.deepEqual(mgr.getAdvertisedCapabilities(), ['chat', 'tools', 'fs']);
  });

  it('getAdvertisedCapabilities returns a copy', () => {
    mgr.advertise(['a']);
    const caps = mgr.getAdvertisedCapabilities();
    caps.push('b');
    assert.deepEqual(mgr.getAdvertisedCapabilities(), ['a']);
  });

  it('advertise replaces previous capabilities', () => {
    mgr.advertise(['old']);
    mgr.advertise(['new1', 'new2']);
    assert.deepEqual(mgr.getAdvertisedCapabilities(), ['new1', 'new2']);
  });

  it('advertise copies the input array', () => {
    const input = ['x', 'y'];
    mgr.advertise(input);
    input.push('z');
    assert.deepEqual(mgr.getAdvertisedCapabilities(), ['x', 'y']);
  });

  // -- getStats -----------------------------------------------------------

  it('getStats returns correct counts', () => {
    mgr.addPeer('fp1');                                // disconnected
    mgr.addPeer('fp2', { status: 'connecting' });     // connecting
    mgr.connect('fp3');                                // connected
    mgr.addPeer('fp4');
    mgr.updatePeer('fp4', { status: 'authenticated' }); // authenticated
    const stats = mgr.getStats();
    assert.equal(stats.total, 4);
    assert.equal(stats.connected, 2); // fp3 (connected) + fp4 (authenticated)
    assert.equal(stats.disconnected, 1); // fp1
    assert.equal(stats.connecting, 1); // fp2
  });

  it('getStats returns zeros for empty manager', () => {
    const stats = mgr.getStats();
    assert.deepEqual(stats, { total: 0, connected: 0, disconnected: 0, connecting: 0 });
  });

  // -- size ---------------------------------------------------------------

  it('size reflects peer count through add/remove lifecycle', () => {
    assert.equal(mgr.size, 0);
    mgr.addPeer('fp1');
    mgr.addPeer('fp2');
    assert.equal(mgr.size, 2);
    mgr.removePeer('fp1');
    assert.equal(mgr.size, 1);
  });

  // -- toJSON / fromJSON --------------------------------------------------

  it('toJSON/fromJSON round-trips all peers', () => {
    mgr.addPeer('fp1', { label: 'Alice', trustLevel: 3 });
    mgr.connect('fp2', { transport: 'webrtc' });
    const json = mgr.toJSON();
    const restored = MeshPeerManager.fromJSON(json);
    assert.equal(restored.size, 2);
    assert.equal(restored.getPeer('fp1').label, 'Alice');
    assert.equal(restored.getPeer('fp1').trustLevel, 3);
    assert.equal(restored.getPeer('fp2').status, 'connected');
    assert.equal(restored.getPeer('fp2').transport, 'webrtc');
  });

  it('fromJSON with empty array creates empty manager', () => {
    const restored = MeshPeerManager.fromJSON([]);
    assert.equal(restored.size, 0);
  });

  it('toJSON returns an array of plain objects', () => {
    mgr.addPeer('fp1');
    const json = mgr.toJSON();
    assert.ok(Array.isArray(json));
    assert.equal(json.length, 1);
    assert.equal(json[0].fingerprint, 'fp1');
  });

  // -- onLog callback -----------------------------------------------------

  it('onLog callback fires when peers are added', () => {
    const logs = [];
    const m = new MeshPeerManager({ onLog: (level, msg) => logs.push({ level, msg }) });
    m.addPeer('fp1');
    assert.ok(logs.length > 0);
    assert.ok(logs.some(l => l.msg.includes('fp1')));
  });
});
