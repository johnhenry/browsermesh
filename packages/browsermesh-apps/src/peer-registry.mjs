import { silentCatch } from './silent-catch.mjs'
/**
 * clawser-peer-registry.js -- Unified peer registry with permission management.
 *
 * Wraps MeshPeerManager, TrustGraph, and MeshACL into a single facade that
 * coordinates peer lifecycle, trust, and access control. All three subsystems
 * are accepted via dependency injection — the registry creates defaults when
 * they are not provided.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-registry.test.mjs
 */

// ---------------------------------------------------------------------------
// PeerRegistry
// ---------------------------------------------------------------------------

/**
 * Unified peer registry combining peer management, trust, and ACL.
 *
 * Every peer operation coordinates across all three subsystems so callers
 * never need to manually keep them in sync.
 */
export class PeerRegistry {
  /** @type {import('@johnhenry/browsermesh-core').MeshPeerManager} */
  #peerManager

  /** @type {import('@johnhenry/browsermesh-core').TrustGraph} */
  #trustGraph

  /** @type {import('@johnhenry/browsermesh-core').MeshACL} */
  #acl

  /** @type {string} */
  #localPodId

  /** @type {Function} */
  #onLog
  /** @type {Map<string, number>} */
  #observedTrust = new Map()

  /**
   * @param {object} opts
   * @param {string} opts.localPodId - Owner identity used for ACL and trust edges
   * @param {import('@johnhenry/browsermesh-core').MeshPeerManager} [opts.peerManager]
   * @param {import('@johnhenry/browsermesh-core').TrustGraph} [opts.trustGraph]
   * @param {import('@johnhenry/browsermesh-core').MeshACL} [opts.acl]
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   */
  constructor({ localPodId, peerManager, trustGraph, acl, onLog }) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string')
    }

    this.#localPodId = localPodId
    this.#onLog = onLog || (() => {})

    // Accept injected instances or create bare defaults.
    // Callers importing from the actual modules can pass real instances;
    // for testing, lightweight duck-typed stubs work just as well.
    this.#peerManager = peerManager ?? this.#createDefaultPeerManager()
    this.#trustGraph = trustGraph ?? this.#createDefaultTrustGraph()
    this.#acl = acl ?? this.#createDefaultACL()
  }

  // ── Peer CRUD ───────────────────────────────────────────────────────

  /**
   * Add a peer and optionally grant initial capabilities.
   *
   * @param {string} pubKey - Peer fingerprint / public key hash
   * @param {string} [label] - Human-readable name
   * @param {string[]} [grantedCaps] - Initial capability scopes
   * @returns {import('@johnhenry/browsermesh-core').PeerState}
   */
  addPeer(pubKey, label, grantedCaps) {
    const info = {}
    if (label) info.label = label

    const peer = this.#peerManager.addPeer(pubKey, info)

    if (grantedCaps && grantedCaps.length > 0) {
      this.grantCapabilities(pubKey, grantedCaps)
    }

    this.#onLog(2, `PeerRegistry: added ${pubKey}`)
    return peer
  }

  /**
   * Remove a peer and clean up its trust edges and ACL entries.
   *
   * @param {string} pubKey
   * @returns {boolean} true if the peer existed
   */
  removePeer(pubKey) {
    const existed = this.#peerManager.removePeer(pubKey)

    // Remove trust edges originating from us to this peer
    this.#trustGraph.removeEdge(this.#localPodId, pubKey)

    // Remove ACL roster entry
    this.#acl.revokeAll(pubKey)

    if (existed) {
      this.#onLog(2, `PeerRegistry: removed ${pubKey}`)
    }
    return existed
  }

  /**
   * Get a single peer by public key.
   *
   * @param {string} pubKey
   * @returns {import('@johnhenry/browsermesh-core').PeerState|null}
   */
  getPeer(pubKey) {
    return this.#peerManager.getPeer(pubKey)
  }

  /**
   * List peers, optionally filtered by status or trust level.
   *
   * @param {object} [filter]
   * @param {string} [filter.status]
   * @param {number} [filter.minTrust]
   * @returns {import('@johnhenry/browsermesh-core').PeerState[]}
   */
  listPeers(filter) {
    return this.#peerManager.listPeers(filter)
  }

  // ── Permission management ───────────────────────────────────────────

  /**
   * Assign an ACL template to a peer, replacing any previous entry.
   *
   * @param {string} pubKey
   * @param {string} templateName
   */
  updatePermissions(pubKey, templateName) {
    // Remove old entry if present, then add new one
    this.#acl.removeEntry(pubKey)
    this.#acl.addEntry(pubKey, templateName)
    this.#onLog(3, `PeerRegistry: set template '${templateName}' for ${pubKey}`)
  }

  /**
   * Grant additional capability scopes to a peer via a dynamic ACL template.
   * Creates a per-peer template named `_peer_{pubKey}` that merges with
   * any existing scopes.
   *
   * @param {string} pubKey
   * @param {string[]} scopes - Scopes to add (e.g. ['files:read', 'chat:write'])
   */
  grantCapabilities(pubKey, scopes) {
    const templateName = `_peer_${pubKey}`
    const existing = this.#acl.getTemplate(templateName)
    const merged = existing
      ? [...new Set([...existing.scopes, ...scopes])]
      : [...scopes]

    this.#acl.addTemplate(templateName, merged, `Auto-generated for ${pubKey}`)

    // Ensure roster entry points to the per-peer template
    const entry = this.#acl.getEntry(pubKey)
    if (!entry || entry.templateName !== templateName) {
      this.#acl.removeEntry(pubKey)
      this.#acl.addEntry(pubKey, templateName)
    }

    this.#onLog(3, `PeerRegistry: granted ${scopes.join(', ')} to ${pubKey}`)
  }

  /**
   * Revoke specific capability scopes from a peer.
   * If no scopes remain, removes the per-peer template and roster entry.
   *
   * @param {string} pubKey
   * @param {string[]} scopes - Scopes to remove
   */
  revokeCapabilities(pubKey, scopes) {
    const templateName = `_peer_${pubKey}`
    const existing = this.#acl.getTemplate(templateName)
    if (!existing) return

    const remaining = existing.scopes.filter(s => !scopes.includes(s))

    if (remaining.length === 0) {
      this.#acl.removeEntry(pubKey)
      this.#acl.removeTemplate(templateName)
    } else {
      this.#acl.addTemplate(templateName, remaining, `Auto-generated for ${pubKey}`)
      // Re-sync the roster entry
      this.#acl.removeEntry(pubKey)
      this.#acl.addEntry(pubKey, templateName)
    }

    this.#onLog(3, `PeerRegistry: revoked ${scopes.join(', ')} from ${pubKey}`)
  }

  /**
   * Get the current capabilities for a peer.
   *
   * @param {string} pubKey
   * @returns {{ template: string|null, scopes: string[] }}
   */
  getPeerCapabilities(pubKey) {
    const entry = this.#acl.getEntry(pubKey)
    if (!entry) return { template: null, scopes: [] }

    const tpl = this.#acl.getTemplate(entry.templateName)
    return {
      template: entry.templateName,
      scopes: tpl ? [...tpl.scopes] : [],
    }
  }

  /**
   * Check if a peer is allowed to perform an action on a resource.
   *
   * @param {string} pubKey
   * @param {string} resource
   * @param {string} action
   * @returns {{ allowed: boolean, reason?: string }}
   */
  checkAccess(pubKey, resource, action) {
    return this.#acl.check(pubKey, resource, action)
  }

  // ── Trust management ────────────────────────────────────────────────

  /**
   * Set the trust level for a peer (from the local pod's perspective).
   *
   * @param {string} pubKey
   * @param {number} level - Trust in [0.0, 1.0]
   * @param {string[]} [scopes] - Scope tags for the trust relationship
   */
  setTrust(pubKey, level, scopes) {
    this.#trustGraph.addEdge(this.#localPodId, pubKey, level, scopes)
    this.#onLog(3, `PeerRegistry: set trust ${level} for ${pubKey}`)
  }

  /**
   * Get the trust level we have for a peer (direct or transitive).
   *
   * @param {string} pubKey
   * @returns {number} Trust in [0.0, 1.0]
   */
  getTrust(pubKey) {
    return this.#trustGraph.getTrustLevel(this.#localPodId, pubKey)
  }

  /**
   * Record a runtime-observed trust/reputation signal without overwriting
   * the operator's explicit trust graph input.
   *
   * @param {string} pubKey
   * @param {number} level
   * @returns {number}
   */
  recordObservedTrust(pubKey, level) {
    const clamped = Math.max(0, Math.min(1, Number(level) || 0))
    this.#observedTrust.set(pubKey, clamped)
    this.#onLog(3, `PeerRegistry: observed trust ${clamped} for ${pubKey}`)
    return clamped
  }

  /**
   * @param {string} pubKey
   * @returns {number}
   */
  getObservedTrust(pubKey) {
    return this.#observedTrust.get(pubKey) ?? 0
  }

  /**
   * Combined reputation score used for route ranking. Explicit trust remains
   * authoritative, with observed runtime quality blended in as a secondary
   * signal.
   *
   * @param {string} pubKey
   * @returns {number}
   */
  getReputation(pubKey) {
    const explicit = this.getTrust(pubKey)
    const observed = this.getObservedTrust(pubKey)
    return explicit > 0
      ? Math.max(0, Math.min(1, explicit * 0.7 + observed * 0.3))
      : observed
  }

  /**
   * Check whether a peer is trusted, optionally within a scope.
   *
   * @param {string} pubKey
   * @param {string|null} [scope]
   * @param {number} [minLevel=0.25]
   * @returns {boolean}
   */
  isTrusted(pubKey, scope, minLevel) {
    return this.#trustGraph.isTrusted(this.#localPodId, pubKey, scope, minLevel)
  }

  // ── Connection lifecycle ────────────────────────────────────────────

  /**
   * Connect to a peer (delegates to MeshPeerManager).
   *
   * @param {string} pubKey
   * @param {object} [opts]
   * @param {string} [opts.transport]
   * @param {string} [opts.endpoint]
   * @returns {import('@johnhenry/browsermesh-core').PeerState}
   */
  connect(pubKey, opts) {
    return this.#peerManager.connect(pubKey, opts)
  }

  /**
   * Disconnect a peer.
   *
   * @param {string} pubKey
   */
  disconnect(pubKey) {
    this.#peerManager.disconnect(pubKey)
  }

  /**
   * Disconnect all peers.
   */
  disconnectAll() {
    this.#peerManager.disconnectAll()
  }

  // ── Events ──────────────────────────────────────────────────────────

  /**
   * Register a callback for peer connection events.
   * @param {Function} cb
   */
  onPeerConnect(cb) {
    this.#peerManager.onPeerConnect(cb)
  }

  /**
   * Register a callback for peer disconnection events.
   * @param {Function} cb
   */
  onPeerDisconnect(cb) {
    this.#peerManager.onPeerDisconnect(cb)
  }

  // ── Stats ───────────────────────────────────────────────────────────

  /**
   * Get aggregate connection statistics.
   *
   * @returns {{ total: number, connected: number, disconnected: number, connecting: number }}
   */
  getStats() {
    return this.#peerManager.getStats()
  }

  /** @returns {number} */
  get size() {
    return this.#peerManager.size
  }

  // ── Persistence ─────────────────────────────────────────────────────

  /**
   * Serialize the full registry state.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      localPodId: this.#localPodId,
      peers: this.#peerManager.toJSON(),
      trust: this.#trustGraph.toJSON(),
      observedTrust: Object.fromEntries(this.#observedTrust),
      acl: this.#acl.toJSON(),
    }
  }

  /**
   * Restore a PeerRegistry from serialized data.
   * Requires the same subsystem constructors to be available; accepts
   * factory functions for creating typed instances from JSON.
   *
   * @param {object} data
   * @param {object} [factories] - Optional constructors for subsystems
   * @param {Function} [factories.PeerManager] - MeshPeerManager class
   * @param {Function} [factories.TrustGraph] - TrustGraph class
   * @param {Function} [factories.ACL] - MeshACL class
   * @returns {PeerRegistry}
   */
  static fromJSON(data, factories = {}) {
    const PeerManager = factories.PeerManager
    const Trust = factories.TrustGraph
    const ACL = factories.ACL

    const peerManager = PeerManager ? PeerManager.fromJSON(data.peers) : undefined
    const trustGraph = Trust ? Trust.fromJSON(data.trust) : undefined
    const acl = ACL ? ACL.fromJSON(data.acl) : undefined

    const registry = new PeerRegistry({
      localPodId: data.localPodId,
      peerManager,
      trustGraph,
      acl,
    })
    for (const [pubKey, level] of Object.entries(data.observedTrust || {})) {
      registry.#observedTrust.set(pubKey, level)
    }
    return registry
  }

  // ── Internal helpers ────────────────────────────────────────────────

  /**
   * Create a minimal duck-typed MeshPeerManager when none is injected.
   * @returns {object}
   */
  #createDefaultPeerManager() {
    const peers = new Map()
    const callbacks = { connect: [], disconnect: [] }

    const fire = (event, data) => {
      for (const cb of [...(callbacks[event] || [])]) {
        try { cb(data) } catch (e) { silentCatch('clawser-peer-registry', 'swallow', e) }
      }
    }

    return {
      addPeer(fingerprint, info = {}) {
        const existing = peers.get(fingerprint)
        if (existing) {
          Object.assign(existing, info)
          return existing
        }
        const peer = { fingerprint, status: 'disconnected', ...info }
        peers.set(fingerprint, peer)
        return peer
      },
      removePeer(fingerprint) { return peers.delete(fingerprint) },
      getPeer(fingerprint) { return peers.get(fingerprint) || null },
      listPeers(filter = {}) {
        let list = [...peers.values()]
        if (filter.status) list = list.filter(p => p.status === filter.status)
        if (filter.minTrust !== undefined) list = list.filter(p => (p.trustLevel || 0) >= filter.minTrust)
        return list
      },
      connect(fingerprint, opts = {}) {
        if (!peers.has(fingerprint)) this.addPeer(fingerprint, opts)
        const peer = peers.get(fingerprint)
        const oldStatus = peer.status
        peer.status = 'connected'
        peer.transport = opts.transport || null
        peer.endpoint = opts.endpoint || null
        if (oldStatus !== 'connected' && oldStatus !== 'authenticated') fire('connect', peer)
        return peer
      },
      disconnect(fingerprint) {
        const peer = peers.get(fingerprint)
        if (!peer) return
        const old = peer.status
        peer.status = 'disconnected'
        peer.transport = null
        if (old !== 'disconnected') fire('disconnect', peer)
      },
      disconnectAll() { for (const fp of peers.keys()) this.disconnect(fp) },
      onPeerConnect(cb) { callbacks.connect.push(cb) },
      onPeerDisconnect(cb) { callbacks.disconnect.push(cb) },
      offPeerConnect(cb) {
        const idx = callbacks.connect.indexOf(cb)
        if (idx >= 0) callbacks.connect.splice(idx, 1)
      },
      offPeerDisconnect(cb) {
        const idx = callbacks.disconnect.indexOf(cb)
        if (idx >= 0) callbacks.disconnect.splice(idx, 1)
      },
      clearListeners() { callbacks.connect.length = 0; callbacks.disconnect.length = 0 },
      getStats() {
        const all = [...peers.values()]
        return {
          total: all.length,
          connected: all.filter(p => p.status === 'connected' || p.status === 'authenticated').length,
          disconnected: all.filter(p => p.status === 'disconnected').length,
          connecting: all.filter(p => p.status === 'connecting').length,
        }
      },
      get size() { return peers.size },
      toJSON() { return [...peers.values()] },
    }
  }

  /**
   * Create a minimal duck-typed TrustGraph when none is injected.
   * @returns {object}
   */
  #createDefaultTrustGraph() {
    const edges = []

    return {
      addEdge(fromId, toId, level, scopes = []) {
        const idx = edges.findIndex(e => e.from === fromId && e.to === toId)
        if (idx >= 0) edges.splice(idx, 1)
        edges.push({ from: fromId, to: toId, value: level, scopes: [...scopes] })
      },
      removeEdge(fromId, toId) {
        const idx = edges.findIndex(e => e.from === fromId && e.to === toId)
        if (idx >= 0) { edges.splice(idx, 1); return true }
        return false
      },
      getTrustLevel(fromId, toId) {
        const e = edges.find(e => e.from === fromId && e.to === toId)
        return e ? e.value : 0
      },
      isTrusted(fromId, toId, scope, minLevel = 0.25) {
        const e = edges.find(e => e.from === fromId && e.to === toId)
        if (!e || e.value < minLevel) return false
        if (scope && e.scopes.length > 0 && !e.scopes.includes(scope)) return false
        return true
      },
      toJSON() { return edges.map(e => ({ ...e, scopes: [...e.scopes] })) },
    }
  }

  /**
   * Create a minimal duck-typed MeshACL when none is injected.
   * @returns {object}
   */
  #createDefaultACL() {
    const owner = this.#localPodId
    const templates = new Map()
    const roster = new Map()

    // Seed default templates
    templates.set('guest', { name: 'guest', scopes: ['chat:read', 'files:read'] })
    templates.set('collaborator', { name: 'collaborator', scopes: ['chat:*', 'files:read', 'files:write', 'compute:submit'] })
    templates.set('admin', { name: 'admin', scopes: ['*:*'] })

    const matchScope = (pattern, scope) => {
      if (pattern === '*:*') return true
      const [pRes, pAct] = pattern.split(':')
      const [sRes, sAct] = scope.split(':')
      return (pRes === '*' || pRes === sRes) && (pAct === '*' || pAct === sAct)
    }

    return {
      addTemplate(name, scopes, description) {
        const t = { name, scopes: [...scopes], description }
        templates.set(name, t)
        return t
      },
      removeTemplate(name) { return templates.delete(name) },
      getTemplate(name) { return templates.get(name) || null },
      addEntry(identity, templateName, opts = {}) {
        if (!templates.has(templateName)) throw new Error(`Unknown template: ${templateName}`)
        const entry = { identity, templateName, ...opts }
        roster.set(identity, entry)
        return entry
      },
      removeEntry(identity) { return roster.delete(identity) },
      getEntry(identity) { return roster.get(identity) || null },
      check(identity, resource, action) {
        if (identity === owner) return { allowed: true, reason: 'owner' }
        const entry = roster.get(identity)
        if (!entry) return { allowed: false, reason: 'not_in_roster' }
        const tpl = templates.get(entry.templateName)
        if (!tpl) return { allowed: false, reason: 'template_missing' }
        const scope = `${resource}:${action}`
        if (tpl.scopes.some(s => matchScope(s, scope))) return { allowed: true }
        return { allowed: false, reason: 'scope_denied' }
      },
      revokeAll(identity) {
        const had = roster.has(identity)
        roster.delete(identity)
        return had ? 1 : 0
      },
      toJSON() {
        return {
          owner,
          templates: [...templates.values()].filter(t => !['guest', 'collaborator', 'admin'].includes(t.name)),
          roster: [...roster.values()],
        }
      },
    }
  }
}
