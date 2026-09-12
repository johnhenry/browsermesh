import { silentCatch } from './silent-catch.mjs'
import { matchScope } from '@johnhenry/browsermesh-primitives'
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
// Capability tokens (Phase 5 -- real granting/revocation, layered under the
// existing ACL template mechanism, not replacing it)
// ---------------------------------------------------------------------------

/**
 * Duck-typed default token, used only when no `tokenFactory` is injected.
 * Shaped to satisfy both this module's own default `CapabilityValidator`
 * fallback below AND the real `@johnhenry/browsermesh-core` `CapabilityValidator`
 * (whose `register()`/`revokeTree()`/`validate()` only ever touch `.id`,
 * `.revoked`, `.parentId`, `.resource`, `.permissions`, `.constraints`,
 * `.isExpired()`, `.hasPermission()`, `.revoke()` -- nothing constructor-specific)
 * -- so real callers (see `mesh-bootstrap.mjs`) can inject the real
 * `CapabilityToken` class as `tokenFactory` for the genuine, tested class,
 * while this file itself stays decoupled from `-core` at the module level,
 * matching the existing peerManager/trustGraph/acl DI pattern in this class.
 */
let _localCapTokenSeq = 0
class _DefaultCapabilityToken {
  constructor({ issuer, holder, resource, permissions, constraints = {}, parentId = null, createdAt, expiresAt = null }) {
    this.id = `peercap_${Date.now()}_${++_localCapTokenSeq}`
    this.issuer = issuer
    this.holder = holder
    this.resource = resource
    this.permissions = [...permissions]
    this.constraints = { ...constraints }
    this.parentId = parentId
    this.createdAt = createdAt || Date.now()
    this.expiresAt = expiresAt
    this.revoked = false
  }

  isExpired(now = Date.now()) {
    return this.expiresAt !== null && this.expiresAt !== undefined && now >= this.expiresAt
  }

  hasPermission(perm) {
    return this.permissions.includes(perm)
  }

  revoke() {
    this.revoked = true
  }
}

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
   * Real capability tokens issued through `grantCapabilities()`, tracked so
   * `revokeCapabilities()` can find and revoke the matching token(s) later,
   * and so `checkAccess()` can consult live revocation status. Keyed by
   * peer pubKey -> (exact granted scope string -> token). Only scopes
   * granted via `grantCapabilities()` get an entry here; peers configured
   * purely via `updatePermissions()`/`addEntry()`/default templates have no
   * tracked tokens and are therefore governed by the ACL alone, unaffected
   * by this mechanism (see checkAccess()).
   *
   * @type {Map<string, Map<string, object>>}
   */
  #capabilityTokens = new Map()

  /** Validates/revokes tokens -- real `CapabilityValidator` when injected, a
   * duck-typed equivalent otherwise. @type {{ register: Function, revokeTree: Function }} */
  #capabilityValidator

  /** Constructs a token object for grantCapabilities() -- real `CapabilityToken`
   * when injected, `_DefaultCapabilityToken` otherwise. @type {Function} */
  #tokenFactory

  /**
   * @param {object} opts
   * @param {string} opts.localPodId - Owner identity used for ACL and trust edges
   * @param {import('@johnhenry/browsermesh-core').MeshPeerManager} [opts.peerManager]
   * @param {import('@johnhenry/browsermesh-core').TrustGraph} [opts.trustGraph]
   * @param {import('@johnhenry/browsermesh-core').MeshACL} [opts.acl]
   * @param {import('@johnhenry/browsermesh-core').CapabilityValidator} [opts.capabilityValidator]
   *   Backs the real granting/revocation path for `grantCapabilities()`/
   *   `revokeCapabilities()` (Phase 5). Defaults to a lightweight in-package
   *   equivalent when omitted, so this class stays usable without `-core`
   *   installed -- inject the real class (see `mesh-bootstrap.mjs`) for the
   *   genuine, tested implementation.
   * @param {Function} [opts.tokenFactory] - `(opts) => token`, used to construct
   *   the token registered with `capabilityValidator` on each grant. Defaults to
   *   a small duck-typed equivalent of `@johnhenry/browsermesh-core`'s
   *   `CapabilityToken`; pass `(opts) => new CapabilityToken(opts)` to use the
   *   real class.
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   */
  constructor({ localPodId, peerManager, trustGraph, acl, capabilityValidator, tokenFactory, onLog }) {
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
    this.#capabilityValidator = capabilityValidator ?? this.#createDefaultCapabilityValidator()
    this.#tokenFactory = tokenFactory ?? ((tokenOpts) => new _DefaultCapabilityToken(tokenOpts))
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

    // Revoke any live capability tokens issued to this peer and stop
    // tracking them -- a removed peer must not retain live tokens that a
    // later re-add under the same pubKey could otherwise inherit.
    const peerTokens = this.#capabilityTokens.get(pubKey)
    if (peerTokens) {
      for (const token of peerTokens.values()) {
        if (!token.revoked) this.#capabilityValidator.revokeTree(token.id)
      }
      this.#capabilityTokens.delete(pubKey)
    }

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
   * Grant additional capability scopes to a peer via a dynamic ACL template,
   * AND issue a real capability token per scope through the injected (or
   * default) `CapabilityValidator` (Phase 5). The ACL template remains the
   * mechanism `checkAccess()` primarily checks -- fully backward compatible
   * with any caller that only cares about the pre-Phase-5 ACL behavior --
   * while the token gives `revokeCapabilities()` a live revocation target
   * that `checkAccess()` additionally consults, independent of whether/when
   * the ACL template itself gets re-read.
   *
   * @param {string} pubKey
   * @param {string[]} scopes - Scopes to add (e.g. ['files:read', 'chat:write'])
   * @param {object} [opts]
   * @param {number|null} [opts.expiresAt] - Optional expiry (ms epoch) applied
   *   to newly-issued tokens for this call. Omit for no expiry.
   */
  grantCapabilities(pubKey, scopes, opts = {}) {
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

    // Issue a real capability token per scope so revocation has a live
    // target beyond the ACL template. Skip scopes that already have a live
    // (non-revoked, non-expired) token -- re-granting an already-granted
    // scope is a no-op at the token layer, matching the ACL's own
    // dedup/additive behavior above. A scope whose prior token was revoked
    // gets a fresh token (tokens are one-way revocable, never un-revoked).
    let peerTokens = this.#capabilityTokens.get(pubKey)
    if (!peerTokens) {
      peerTokens = new Map()
      this.#capabilityTokens.set(pubKey, peerTokens)
    }
    for (const scope of scopes) {
      const current = peerTokens.get(scope)
      const currentLive = current && !current.revoked &&
        !(typeof current.isExpired === 'function' && current.isExpired())
      if (currentLive) continue

      const token = this.#tokenFactory({
        issuer: this.#localPodId,
        holder: pubKey,
        resource: scope,
        permissions: ['use'],
        expiresAt: opts.expiresAt ?? null,
      })
      this.#capabilityValidator.register(token)
      peerTokens.set(scope, token)
    }

    this.#onLog(3, `PeerRegistry: granted ${scopes.join(', ')} to ${pubKey}`)
  }

  /**
   * Revoke specific capability scopes from a peer: removes them from the ACL
   * template (if no scopes remain, removes the per-peer template and roster
   * entry -- unchanged from pre-Phase-5 behavior) AND revokes the matching
   * capability token(s) issued by `grantCapabilities()` through the
   * `CapabilityValidator`, so `checkAccess()`'s live check denies immediately
   * regardless of ACL template state.
   *
   * @param {string} pubKey
   * @param {string[]} scopes - Scopes to remove
   */
  revokeCapabilities(pubKey, scopes) {
    const templateName = `_peer_${pubKey}`
    const existing = this.#acl.getTemplate(templateName)

    if (existing) {
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
    }

    // Revoke the matching token(s), if any were issued via grantCapabilities().
    // Scoped precisely: only the exact scopes named here are touched, so a
    // different, still-granted scope for the same peer is unaffected.
    const peerTokens = this.#capabilityTokens.get(pubKey)
    if (peerTokens) {
      for (const scope of scopes) {
        const token = peerTokens.get(scope)
        if (token && !token.revoked) {
          this.#capabilityValidator.revokeTree(token.id)
        }
      }
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
   * First checks the ACL template (unchanged, pre-Phase-5 behavior -- owner
   * bypass, roster/template scope matching). If the ACL allows it, ALSO
   * consults live revocation status for any capability token issued via
   * `grantCapabilities()` whose scope covers this resource/action (Phase 5):
   * a token that was granted then revoked denies access on this check, even
   * if the ACL template itself hasn't been re-read or doesn't (e.g. a
   * broader wildcard scope that revokeCapabilities()'s exact-match ACL
   * removal didn't touch). Peers/scopes never routed through
   * `grantCapabilities()` (e.g. `updatePermissions()`/`addEntry()` callers,
   * default templates) have no tracked token and are therefore governed by
   * the ACL alone, exactly as before.
   *
   * @param {string} pubKey
   * @param {string} resource
   * @param {string} action
   * @returns {{ allowed: boolean, reason?: string }}
   */
  checkAccess(pubKey, resource, action) {
    const aclResult = this.#acl.check(pubKey, resource, action)
    if (!aclResult.allowed) return aclResult

    const scope = `${resource}:${action}`
    const peerTokens = this.#capabilityTokens.get(pubKey)
    if (peerTokens) {
      for (const [grantedScope, token] of peerTokens) {
        if (!matchScope(grantedScope, scope)) continue
        if (token.revoked || (typeof token.isExpired === 'function' && token.isExpired())) {
          return { allowed: false, reason: 'capability_revoked' }
        }
      }
    }

    return aclResult
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

  /**
   * Create a minimal duck-typed CapabilityValidator when none is injected.
   * Mirrors the subset of `@johnhenry/browsermesh-core`'s real
   * `CapabilityValidator` that `grantCapabilities()`/`revokeCapabilities()`/
   * `checkAccess()` actually use: `register()`, `revokeTree()` (revokes a
   * token and, transitively, any tracked token whose `parentId` chains up to
   * it -- unused by this class today since tokens here are always
   * root/flat, but kept for parity with the real class and any future
   * attenuation use), and `validate()` for completeness/introspection.
   * @returns {object}
   */
  #createDefaultCapabilityValidator() {
    const tokens = new Map()
    const revokedIds = new Set()

    const validator = {
      register(token) {
        tokens.set(token.id, token)
        if (token.revoked) revokedIds.add(token.id)
      },
      revokeTree(tokenId) {
        revokedIds.add(tokenId)
        const token = tokens.get(tokenId)
        if (token) token.revoke()
        for (const [id, t] of tokens) {
          if (t.parentId === tokenId && !revokedIds.has(id)) {
            validator.revokeTree(id)
          }
        }
      },
      validate(tokenId, resource, permission) {
        const token = tokens.get(tokenId)
        if (!token) return { allowed: false, reason: 'Token not found' }
        if (revokedIds.has(tokenId)) return { allowed: false, reason: 'Token revoked' }
        if (token.isExpired()) return { allowed: false, reason: 'Token expired' }
        if (!token.hasPermission(permission)) {
          return { allowed: false, reason: `Permission "${permission}" not granted` }
        }
        const pattern = token.resource
        const matches = pattern === resource || pattern === '*' ||
          (pattern.endsWith('*') && resource.startsWith(pattern.slice(0, -1)))
        if (!matches) {
          return { allowed: false, reason: `Resource "${resource}" not covered by "${pattern}"` }
        }
        return { allowed: true }
      },
      get size() { return tokens.size },
      listTokens() { return [...tokens.values()] },
    }
    return validator
  }
}
