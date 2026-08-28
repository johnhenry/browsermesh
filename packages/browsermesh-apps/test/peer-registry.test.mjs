import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { PeerRegistry } from '../src/peer-registry.mjs'

const LOCAL = 'pod-local-abc'
const PEER_A = 'pk-alice'
const PEER_B = 'pk-bob'

describe('PeerRegistry', () => {
  let reg

  beforeEach(() => {
    reg = new PeerRegistry({ localPodId: LOCAL })
  })

  // ── Constructor ──────────────────────────────────────────────────

  describe('constructor', () => {
    it('throws when localPodId is missing', () => {
      assert.throws(() => new PeerRegistry({}), /localPodId is required/)
    })

    it('throws when localPodId is empty string', () => {
      assert.throws(() => new PeerRegistry({ localPodId: '' }), /localPodId is required/)
    })

    it('throws when localPodId is not a string', () => {
      assert.throws(() => new PeerRegistry({ localPodId: 42 }), /localPodId is required/)
    })

    it('constructs with only localPodId (duck-typed defaults)', () => {
      const r = new PeerRegistry({ localPodId: 'pod-1' })
      assert.equal(r.size, 0)
    })
  })

  // ── Peer CRUD ────────────────────────────────────────────────────

  describe('peer CRUD', () => {
    it('addPeer returns a PeerState with fingerprint', () => {
      const peer = reg.addPeer(PEER_A, 'Alice')
      assert.equal(peer.fingerprint, PEER_A)
      assert.equal(peer.label, 'Alice')
    })

    it('getPeer returns the added peer', () => {
      reg.addPeer(PEER_A, 'Alice')
      const peer = reg.getPeer(PEER_A)
      assert.equal(peer.fingerprint, PEER_A)
    })

    it('getPeer returns null for unknown key', () => {
      assert.equal(reg.getPeer('unknown'), null)
    })

    it('listPeers returns all peers', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.addPeer(PEER_B, 'Bob')
      assert.equal(reg.listPeers().length, 2)
    })

    it('listPeers filters by status', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.addPeer(PEER_B, 'Bob')
      reg.connect(PEER_A)
      const connected = reg.listPeers({ status: 'connected' })
      assert.equal(connected.length, 1)
      assert.equal(connected[0].fingerprint, PEER_A)
    })

    it('removePeer returns true for existing peer', () => {
      reg.addPeer(PEER_A, 'Alice')
      assert.equal(reg.removePeer(PEER_A), true)
    })

    it('removePeer returns false for unknown peer', () => {
      assert.equal(reg.removePeer('unknown'), false)
    })

    it('removePeer makes getPeer return null', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.removePeer(PEER_A)
      assert.equal(reg.getPeer(PEER_A), null)
    })

    it('addPeer with grantedCaps sets initial capabilities', () => {
      reg.addPeer(PEER_A, 'Alice', ['files:read', 'chat:write'])
      const caps = reg.getPeerCapabilities(PEER_A)
      assert.deepEqual(caps.scopes.sort(), ['chat:write', 'files:read'])
    })
  })

  // ── Permission management ────────────────────────────────────────

  describe('permissions', () => {
    it('updatePermissions assigns a template', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.updatePermissions(PEER_A, 'guest')
      const caps = reg.getPeerCapabilities(PEER_A)
      assert.equal(caps.template, 'guest')
      assert.ok(caps.scopes.includes('chat:read'))
    })

    it('updatePermissions replaces previous template', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.updatePermissions(PEER_A, 'guest')
      reg.updatePermissions(PEER_A, 'collaborator')
      const caps = reg.getPeerCapabilities(PEER_A)
      assert.equal(caps.template, 'collaborator')
      assert.ok(caps.scopes.includes('files:write'))
    })

    it('grantCapabilities is additive', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.grantCapabilities(PEER_A, ['files:read'])
      reg.grantCapabilities(PEER_A, ['chat:write'])
      const caps = reg.getPeerCapabilities(PEER_A)
      assert.deepEqual(caps.scopes.sort(), ['chat:write', 'files:read'])
    })

    it('grantCapabilities deduplicates scopes', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.grantCapabilities(PEER_A, ['files:read', 'files:read'])
      reg.grantCapabilities(PEER_A, ['files:read'])
      const caps = reg.getPeerCapabilities(PEER_A)
      assert.deepEqual(caps.scopes, ['files:read'])
    })

    it('revokeCapabilities removes specific scopes', () => {
      reg.addPeer(PEER_A, 'Alice', ['files:read', 'chat:write'])
      reg.revokeCapabilities(PEER_A, ['files:read'])
      const caps = reg.getPeerCapabilities(PEER_A)
      assert.deepEqual(caps.scopes, ['chat:write'])
    })

    it('revokeCapabilities removes template when no scopes remain', () => {
      reg.addPeer(PEER_A, 'Alice', ['files:read'])
      reg.revokeCapabilities(PEER_A, ['files:read'])
      const caps = reg.getPeerCapabilities(PEER_A)
      assert.equal(caps.template, null)
      assert.deepEqual(caps.scopes, [])
    })

    it('getPeerCapabilities returns empty for unknown peer', () => {
      const caps = reg.getPeerCapabilities('no-one')
      assert.equal(caps.template, null)
      assert.deepEqual(caps.scopes, [])
    })
  })

  // ── Access checking ──────────────────────────────────────────────

  describe('checkAccess', () => {
    it('owner is always allowed', () => {
      const result = reg.checkAccess(LOCAL, 'files', 'write')
      assert.equal(result.allowed, true)
      assert.equal(result.reason, 'owner')
    })

    it('unregistered peer is denied', () => {
      const result = reg.checkAccess('stranger', 'files', 'read')
      assert.equal(result.allowed, false)
      assert.equal(result.reason, 'not_in_roster')
    })

    it('peer with matching scope is allowed', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.updatePermissions(PEER_A, 'guest')
      const result = reg.checkAccess(PEER_A, 'chat', 'read')
      assert.equal(result.allowed, true)
    })

    it('peer without matching scope is denied', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.updatePermissions(PEER_A, 'guest')
      const result = reg.checkAccess(PEER_A, 'compute', 'submit')
      assert.equal(result.allowed, false)
      assert.equal(result.reason, 'scope_denied')
    })

    it('admin template grants all access', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.updatePermissions(PEER_A, 'admin')
      const result = reg.checkAccess(PEER_A, 'anything', 'whatever')
      assert.equal(result.allowed, true)
    })
  })

  // ── Trust management ─────────────────────────────────────────────

  describe('trust', () => {
    it('getTrust returns 0 for unknown peer', () => {
      assert.equal(reg.getTrust('unknown'), 0)
    })

    it('setTrust / getTrust round-trips', () => {
      reg.setTrust(PEER_A, 0.8)
      assert.equal(reg.getTrust(PEER_A), 0.8)
    })

    it('setTrust overwrites previous value', () => {
      reg.setTrust(PEER_A, 0.5)
      reg.setTrust(PEER_A, 0.9)
      assert.equal(reg.getTrust(PEER_A), 0.9)
    })

    it('isTrusted returns false below threshold', () => {
      reg.setTrust(PEER_A, 0.1)
      assert.equal(reg.isTrusted(PEER_A), false) // default minLevel 0.25
    })

    it('isTrusted returns true above threshold', () => {
      reg.setTrust(PEER_A, 0.5)
      assert.equal(reg.isTrusted(PEER_A), true)
    })

    it('isTrusted respects custom minLevel', () => {
      reg.setTrust(PEER_A, 0.5)
      assert.equal(reg.isTrusted(PEER_A, null, 0.8), false)
      assert.equal(reg.isTrusted(PEER_A, null, 0.3), true)
    })

    it('isTrusted checks scope when present', () => {
      reg.setTrust(PEER_A, 0.7, ['files'])
      assert.equal(reg.isTrusted(PEER_A, 'files'), true)
      assert.equal(reg.isTrusted(PEER_A, 'compute'), false)
    })
  })

  // ── Connection lifecycle ─────────────────────────────────────────

  describe('connection lifecycle', () => {
    it('connect sets status to connected', () => {
      reg.addPeer(PEER_A, 'Alice')
      const peer = reg.connect(PEER_A)
      assert.equal(peer.status, 'connected')
    })

    it('connect auto-adds unknown peer', () => {
      const peer = reg.connect(PEER_B)
      assert.equal(peer.status, 'connected')
      assert.equal(reg.size, 1)
    })

    it('disconnect sets status to disconnected', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.connect(PEER_A)
      reg.disconnect(PEER_A)
      assert.equal(reg.getPeer(PEER_A).status, 'disconnected')
    })

    it('disconnectAll disconnects every peer', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.addPeer(PEER_B, 'Bob')
      reg.connect(PEER_A)
      reg.connect(PEER_B)
      reg.disconnectAll()
      const stats = reg.getStats()
      assert.equal(stats.connected, 0)
      assert.equal(stats.disconnected, 2)
    })
  })

  // ── Events ───────────────────────────────────────────────────────

  describe('events', () => {
    it('onPeerConnect fires on connection', () => {
      const events = []
      reg.onPeerConnect(p => events.push(p.fingerprint))
      reg.addPeer(PEER_A, 'Alice')
      reg.connect(PEER_A)
      assert.deepEqual(events, [PEER_A])
    })

    it('onPeerDisconnect fires on disconnection', () => {
      const events = []
      reg.onPeerDisconnect(p => events.push(p.fingerprint))
      reg.addPeer(PEER_A, 'Alice')
      reg.connect(PEER_A)
      reg.disconnect(PEER_A)
      assert.deepEqual(events, [PEER_A])
    })

    it('connect does not fire if already connected', () => {
      const events = []
      reg.onPeerConnect(p => events.push(p.fingerprint))
      reg.addPeer(PEER_A, 'Alice')
      reg.connect(PEER_A)
      reg.connect(PEER_A) // second connect — already connected
      assert.equal(events.length, 1)
    })
  })

  // ── Stats and size ───────────────────────────────────────────────

  describe('stats and size', () => {
    it('size reflects number of peers', () => {
      assert.equal(reg.size, 0)
      reg.addPeer(PEER_A, 'Alice')
      assert.equal(reg.size, 1)
      reg.addPeer(PEER_B, 'Bob')
      assert.equal(reg.size, 2)
    })

    it('getStats reports correct counts', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.addPeer(PEER_B, 'Bob')
      reg.connect(PEER_A)
      const stats = reg.getStats()
      assert.equal(stats.total, 2)
      assert.equal(stats.connected, 1)
      assert.equal(stats.disconnected, 1)
      assert.equal(stats.connecting, 0)
    })
  })

  // ── Cleanup on remove ────────────────────────────────────────────

  describe('removePeer cleanup', () => {
    it('clears trust edges when peer is removed', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.setTrust(PEER_A, 0.9)
      reg.removePeer(PEER_A)
      assert.equal(reg.getTrust(PEER_A), 0)
    })

    it('clears ACL entry when peer is removed', () => {
      reg.addPeer(PEER_A, 'Alice', ['files:read'])
      reg.removePeer(PEER_A)
      const caps = reg.getPeerCapabilities(PEER_A)
      assert.equal(caps.template, null)
      assert.deepEqual(caps.scopes, [])
    })
  })

  // ── toJSON / fromJSON ────────────────────────────────────────────

  describe('serialization', () => {
    it('toJSON includes all sections', () => {
      reg.addPeer(PEER_A, 'Alice')
      reg.setTrust(PEER_A, 0.7)
      const json = reg.toJSON()
      assert.equal(json.localPodId, LOCAL)
      assert.ok(Array.isArray(json.peers))
      assert.ok(Array.isArray(json.trust))
      assert.ok(json.acl != null)
    })

    it('fromJSON without factories creates a new registry with defaults', () => {
      reg.addPeer(PEER_A, 'Alice')
      const json = reg.toJSON()
      const restored = PeerRegistry.fromJSON(json)
      // The restored registry has the same localPodId but fresh defaults
      assert.equal(restored.size, 0) // no factory → defaults, peers not restored
      const restoredJson = restored.toJSON()
      assert.equal(restoredJson.localPodId, LOCAL)
    })
  })

  // ── onLog callback ───────────────────────────────────────────────

  describe('onLog', () => {
    it('fires log callback on addPeer', () => {
      const logs = []
      const r = new PeerRegistry({ localPodId: LOCAL, onLog: (l, m) => logs.push({ l, m }) })
      r.addPeer(PEER_A, 'Alice')
      assert.ok(logs.length > 0)
      assert.ok(logs[0].m.includes(PEER_A))
    })
  })
})
