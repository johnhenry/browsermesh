/**
 * Tests for PeerNode — top-level P2P mesh orchestrator.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/peer-node.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Provide crypto.randomUUID if not available
if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

import { PeerNode, PEER_NODE_STATES } from '../src/peer-node.mjs'

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function createMockWallet() {
  const identities = []
  let defaultId = null
  return {
    async createIdentity(label) {
      const podId = `pod-${identities.length}`
      const summary = { podId, label }
      identities.push(summary)
      if (!defaultId) defaultId = podId
      return summary
    },
    listIdentities() { return [...identities] },
    getDefault() { return defaultId ? identities.find(i => i.podId === defaultId) || null : null },
    setDefault(podId) { defaultId = podId },
    async sign(podId, data) { return new Uint8Array([1]) },
    toJSON() { return { identities, defaultId } },
  }
}

function createMockRegistry() {
  const peers = new Map()
  const connectCbs = []
  const disconnectCbs = []
  return {
    addPeer(pubKey, label, caps) {
      const peer = { fingerprint: pubKey, label, status: 'disconnected', caps }
      peers.set(pubKey, peer)
      return peer
    },
    removePeer(pubKey) { return peers.delete(pubKey) },
    getPeer(pubKey) { return peers.get(pubKey) || null },
    listPeers(filter) { return [...peers.values()] },
    connect(pubKey, opts) {
      let peer = peers.get(pubKey)
      if (!peer) { peer = { fingerprint: pubKey, status: 'disconnected' }; peers.set(pubKey, peer) }
      peer.status = 'connected'
      if (opts?.transport) peer.transport = opts.transport
      connectCbs.forEach(cb => cb(peer))
      return peer
    },
    disconnect(pubKey) {
      const peer = peers.get(pubKey)
      if (peer) { peer.status = 'disconnected'; disconnectCbs.forEach(cb => cb(peer)) }
    },
    disconnectAll() { for (const pubKey of peers.keys()) this.disconnect(pubKey) },
    onPeerConnect(cb) { connectCbs.push(cb) },
    onPeerDisconnect(cb) { disconnectCbs.push(cb) },
    getStats() { return { total: peers.size, connected: 0, disconnected: peers.size, connecting: 0 } },
    get size() { return peers.size },
    toJSON() { return [...peers.values()] },
  }
}

function createMockAuditChain() {
  const log = []
  return {
    async append(podId, operation, data, signFn) {
      const sig = signFn ? await signFn(JSON.stringify(data)) : null
      log.push({ podId, operation, data, sig, ts: Date.now() })
    },
    entries() { return [...log] },
    toJSON() { return log },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PeerNode', () => {
  let wallet, registry, node

  beforeEach(() => {
    wallet = createMockWallet()
    registry = createMockRegistry()
    node = new PeerNode({ wallet, registry })
  })

  // -- 1 Constructor validation --------------------------------------------
  describe('constructor', () => {
    it('throws when wallet is missing', () => {
      assert.throws(() => new PeerNode({ registry }), /wallet is required/)
    })

    it('throws when registry is missing', () => {
      assert.throws(() => new PeerNode({ wallet }), /registry is required/)
    })

    it('creates a node in stopped state', () => {
      assert.equal(node.state, 'stopped')
    })
  })

  // -- 2 PEER_NODE_STATES export -------------------------------------------
  describe('PEER_NODE_STATES', () => {
    it('exports the four lifecycle states', () => {
      assert.deepEqual(PEER_NODE_STATES, ['stopped', 'booting', 'running', 'shutting_down'])
    })

    it('is frozen', () => {
      assert.ok(Object.isFrozen(PEER_NODE_STATES))
    })
  })

  // -- 3 Boot lifecycle ----------------------------------------------------
  describe('boot', () => {
    it('transitions from stopped to running', async () => {
      assert.equal(node.state, 'stopped')
      await node.boot()
      assert.equal(node.state, 'running')
    })

    it('auto-creates a default identity when wallet is empty', async () => {
      assert.equal(wallet.listIdentities().length, 0)
      await node.boot()
      assert.equal(wallet.listIdentities().length, 1)
      assert.equal(wallet.listIdentities()[0].label, 'default')
    })

    it('uses custom label for auto-created identity', async () => {
      await node.boot({ label: 'my-node' })
      assert.equal(wallet.listIdentities()[0].label, 'my-node')
    })

    it('does not create identity when wallet already has one', async () => {
      await wallet.createIdentity('existing')
      await node.boot()
      assert.equal(wallet.listIdentities().length, 1)
    })

    it('emits boot event', async () => {
      let received = null
      node.on('boot', (data) => { received = data })
      await node.boot()
      assert.ok(received)
      assert.equal(received.podId, node.podId)
    })

    it('sets podId after boot', async () => {
      assert.equal(node.podId, null)
      await node.boot()
      assert.ok(node.podId)
    })
  })

  // -- 4 Shutdown lifecycle ------------------------------------------------
  describe('shutdown', () => {
    it('transitions from running to stopped', async () => {
      await node.boot()
      assert.equal(node.state, 'running')
      await node.shutdown()
      assert.equal(node.state, 'stopped')
    })

    it('emits shutdown event', async () => {
      await node.boot()
      let received = null
      node.on('shutdown', (data) => { received = data })
      await node.shutdown()
      assert.ok(received)
    })

    it('is idempotent when already stopped', async () => {
      assert.equal(node.state, 'stopped')
      await node.shutdown() // should not throw
      assert.equal(node.state, 'stopped')
    })

    it('clears sessions on shutdown', async () => {
      await node.boot()
      await node.connectToPeer('pk-1')
      assert.equal(node.listSessions().length, 1)
      await node.shutdown()
      assert.equal(node.listSessions().length, 0)
    })
  })

  // -- 5 Double-boot throws ------------------------------------------------
  describe('double boot', () => {
    it('throws when already running', async () => {
      await node.boot()
      await assert.rejects(() => node.boot(), /already running/)
    })
  })

  // -- 6 Guards: methods throw when not running ----------------------------
  describe('guards when not running', () => {
    it('addPeer throws', () => {
      assert.throws(() => node.addPeer('pk-1', 'Alice'), /must be running/)
    })

    it('removePeer throws', () => {
      assert.throws(() => node.removePeer('pk-1'), /must be running/)
    })

    it('connectToPeer throws', async () => {
      await assert.rejects(() => node.connectToPeer('pk-1'), /must be running/)
    })

    it('announce throws', async () => {
      await assert.rejects(() => node.announce(), /must be running/)
    })

    it('discover throws', async () => {
      await assert.rejects(() => node.discover(), /must be running/)
    })
  })

  // -- 7 Peer CRUD --------------------------------------------------------
  describe('peer CRUD', () => {
    beforeEach(async () => { await node.boot() })

    it('addPeer delegates to registry', () => {
      const peer = node.addPeer('pk-1', 'Alice', ['read'])
      assert.equal(peer.fingerprint, 'pk-1')
      assert.equal(peer.label, 'Alice')
      assert.deepEqual(peer.caps, ['read'])
    })

    it('removePeer delegates to registry', () => {
      node.addPeer('pk-1', 'Alice')
      assert.ok(node.removePeer('pk-1'))
      assert.equal(node.listPeers().length, 0)
    })

    it('removePeer returns false for unknown peer', () => {
      assert.equal(node.removePeer('unknown'), false)
    })

    it('listPeers returns all peers', () => {
      node.addPeer('pk-1', 'Alice')
      node.addPeer('pk-2', 'Bob')
      assert.equal(node.listPeers().length, 2)
    })
  })

  // -- 8 connectToPeer -----------------------------------------------------
  describe('connectToPeer', () => {
    beforeEach(async () => { await node.boot() })

    it('creates a session and returns session info', async () => {
      const info = await node.connectToPeer('pk-1')
      assert.ok(info.sessionId)
      assert.equal(info.pubKey, 'pk-1')
      assert.equal(info.state, 'active')
    })

    it('returned session has no transportInstance', async () => {
      const info = await node.connectToPeer('pk-1')
      assert.equal(info.transportInstance, undefined)
    })

    it('registers peer in the registry as connected', async () => {
      await node.connectToPeer('pk-1')
      const peer = registry.getPeer('pk-1')
      assert.equal(peer.status, 'connected')
    })
  })

  // -- 9 disconnectPeer ----------------------------------------------------
  describe('disconnectPeer', () => {
    beforeEach(async () => { await node.boot() })

    it('removes sessions for the disconnected peer', async () => {
      const s1 = await node.connectToPeer('pk-1')
      await node.connectToPeer('pk-2')
      assert.equal(node.listSessions().length, 2)
      node.disconnectPeer('pk-1')
      assert.equal(node.listSessions().length, 1)
      assert.equal(node.getSession(s1.sessionId), null)
    })
  })

  // -- 10 Session tracking -------------------------------------------------
  describe('session tracking', () => {
    beforeEach(async () => { await node.boot() })

    it('getSession returns session by id', async () => {
      const info = await node.connectToPeer('pk-1')
      const session = node.getSession(info.sessionId)
      assert.ok(session)
      assert.equal(session.sessionId, info.sessionId)
    })

    it('getSession returns null for unknown id', () => {
      assert.equal(node.getSession('no-such-id'), null)
    })

    it('listSessions returns all active sessions', async () => {
      await node.connectToPeer('pk-1')
      await node.connectToPeer('pk-2')
      assert.equal(node.listSessions().length, 2)
    })
  })

  // -- 11 Discovery no-ops -------------------------------------------------
  describe('discovery without manager', () => {
    beforeEach(async () => { await node.boot() })

    it('announce is a no-op', async () => {
      await node.announce() // should not throw
    })

    it('discover returns empty array', async () => {
      const results = await node.discover()
      assert.deepEqual(results, [])
    })
  })

  // -- 12 Audit chain ------------------------------------------------------
  describe('audit', () => {
    let audit

    beforeEach(async () => {
      audit = createMockAuditChain()
      node = new PeerNode({ wallet, registry, auditChain: audit })
      await node.boot()
    })

    it('boot logs to audit chain', () => {
      const entries = audit.entries()
      assert.ok(entries.some(e => e.operation === 'peer-node:boot'))
    })

    it('logAction appends to audit chain', async () => {
      await node.logAction('custom-op', { foo: 1 })
      const entries = audit.entries()
      assert.ok(entries.some(e => e.operation === 'custom-op'))
    })

    it('getAuditEntries returns all entries', async () => {
      await node.logAction('op-a', {})
      const entries = node.getAuditEntries()
      assert.ok(entries.length >= 2) // boot + op-a
    })

    it('getAuditEntries returns empty without audit chain', async () => {
      const plain = new PeerNode({ wallet, registry })
      assert.deepEqual(plain.getAuditEntries(), [])
    })
  })

  // -- 13 Events -----------------------------------------------------------
  describe('events', () => {
    it('on/off subscribe and unsubscribe', async () => {
      let count = 0
      const cb = () => { count++ }
      node.on('boot', cb)
      await node.boot()
      assert.equal(count, 1)
      node.off('boot', cb)
    })

    it('peer:connect fires through registry bridge', async () => {
      await node.boot()
      let received = null
      node.on('peer:connect', (data) => { received = data })
      await node.connectToPeer('pk-1')
      assert.ok(received)
      assert.equal(received.fingerprint, 'pk-1')
    })

    it('on rejects non-function callbacks', () => {
      assert.throws(() => node.on('boot', 'not-a-fn'), /function/)
    })
  })

  // -- 14 toJSON / fromJSON round-trip ------------------------------------
  describe('toJSON / fromJSON', () => {
    it('serializes and restores running state', async () => {
      await node.boot()
      node.addPeer('pk-1', 'Alice')
      await node.connectToPeer('pk-1')

      const json = node.toJSON()
      assert.equal(json.state, 'running')
      assert.ok(json.sessions.length >= 1)

      const restored = PeerNode.fromJSON(json, { wallet, registry })
      // Restored nodes always start as 'stopped' — must call boot()
      // to re-wire event listeners and discovery
      assert.equal(restored.state, 'stopped')
      assert.equal(restored.listSessions().length, json.sessions.length)
    })

    it('sessions lose transportInstance after round-trip', async () => {
      await node.boot()
      await node.connectToPeer('pk-1')
      const json = node.toJSON()
      const restored = PeerNode.fromJSON(json, { wallet, registry })
      const session = restored.listSessions()[0]
      assert.equal(session.transportInstance, undefined)
    })

    it('fromJSON requires wallet and registry in deps', () => {
      assert.throws(() => PeerNode.fromJSON({}, {}), /wallet.*registry/)
    })
  })

  // -- 15 fromJSON transient state reset -----------------------------------
  describe('fromJSON transient states', () => {
    it('resets booting to stopped', () => {
      const restored = PeerNode.fromJSON({ state: 'booting' }, { wallet, registry })
      assert.equal(restored.state, 'stopped')
    })

    it('resets shutting_down to stopped', () => {
      const restored = PeerNode.fromJSON({ state: 'shutting_down' }, { wallet, registry })
      assert.equal(restored.state, 'stopped')
    })

    it('restores as stopped (must call boot to re-wire events)', () => {
      const restored = PeerNode.fromJSON({ state: 'running' }, { wallet, registry })
      assert.equal(restored.state, 'stopped')
    })
  })

  // -- Accessors -----------------------------------------------------------
  describe('accessors', () => {
    it('wallet getter returns injected wallet', () => {
      assert.equal(node.wallet, wallet)
    })

    it('registry getter returns injected registry', () => {
      assert.equal(node.registry, registry)
    })
  })

  // -- removePeer clears sessions ------------------------------------------
  describe('removePeer clears sessions', () => {
    it('removes sessions for the removed peer', async () => {
      await node.boot()
      const s = await node.connectToPeer('pk-1')
      assert.equal(node.listSessions().length, 1)
      node.removePeer('pk-1')
      assert.equal(node.getSession(s.sessionId), null)
    })
  })
})
