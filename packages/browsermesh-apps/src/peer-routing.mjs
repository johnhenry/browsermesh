/**
 * peer-routing.mjs -- Multi-hop message routing and server sharing (issue
 * #121, split from #84: originally, incorrectly, claimed to depend on
 * `PeerSession` -- confirmed self-contained, no `PeerSession` import at all).
 *
 * Routes messages across the mesh via intermediary peers when direct
 * connections are unavailable. Also enables HTTP server sharing via mesh.
 *
 * `MeshRouter` manages a route table and forwards messages through multi-hop
 * paths with TTL enforcement.
 * `ServerSharing` exposes local HTTP servers to the mesh and proxies incoming
 * requests from peers.
 *
 * Both classes are plain, dependency-injected (`forwardFn`/`fetchFn`) and
 * have no `PeerNode`/mesh-transport awareness of their own -- see
 * `createMeshRoutingService()` below (Phase C, `mesh-service.mjs`) for the
 * `MeshService` wrapper that wires them onto a real `PeerNode`'s
 * `ctx.sendTo()`/`ctx.onIncomingData()` dispatch bus. This closes a real
 * capability gap: multi-hop message forwarding between peers that aren't
 * directly connected -- nothing else in this repo does this.
 *
 * No browser-only imports at module level. All dependencies injected.
 *
 * Run tests:
 *   node --import ./test/_setup-globals.mjs --test test/peer-routing.test.mjs
 */

import { MessageSigner, ReplayGuard, createMessage, verifyMessage } from '@johnhenry/browsermesh-pod'
import { randomRequestId } from './internal/secure-id.mjs'
import { SealingKeys } from './internal/routed-seal.mjs'
import {
  PROXY_LIMITS_DEFAULTS,
  DEFAULT_ALLOWED_METHODS,
  DEFAULT_ALLOWED_REQUEST_HEADERS,
  configuredOrigin,
  resolveTarget,
  checkHeaderShape,
  selectRequestHeaders,
  checkRequestBody,
  copyResponseHeaders,
  readBoundedBody,
  responseLeftOrigin,
} from './internal/request-target.mjs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default configuration for the mesh router.
 */
export const ROUTING_DEFAULTS = Object.freeze({
  maxTTL: 8,
  routeCacheMs: 60_000,       // 1 minute
  maxRouteEntries: 1000,
})

/**
 * What the originator signs in a routed envelope: a `pod:message` (the pod
 * message signature, see `@johnhenry/browsermesh-pod`) from the originator to
 * the final recipient whose payload is `{ kind, id, message }`. The signature
 * therefore covers the originator, the final recipient, the message id, the
 * content, and the signer's session id and counter (which the recipient uses
 * to refuse a copy it already accepted). `ttl`, `path` and the top-level
 * `from`/`message` copies are NOT signed: a hop sets them, nobody relies on them.
 */
export const ROUTED_KIND = 'mesh-routed/v1'

/**
 * A SEALED routed message keeps `kind: ROUTED_KIND` and carries `sealed` (a box from
 * `@johnhenry/browsermesh-primitives`' `sealToStatement()`) in the signed payload in place of `message`
 * (which is `null`): `{ kind, id, message: null, sealed: { v, kid, epk, iv, ct } }`. The whole payload is
 * signed, so a hop that verifies origin cannot change the box; it cannot open it either, and an older hop
 * that knows nothing about `sealed` verifies and forwards it exactly like any other envelope.
 */

/** Thrown by `route()` when a message must be sealed (`requireSealed`) and there is no way to seal it. */
export class SealedUnavailableError extends Error {
  constructor(target) {
    super(`cannot seal a message to ${target}: no valid key statement for it`)
    this.name = 'SealedUnavailableError'
    this.code = 'E_SEALED_UNAVAILABLE'
    this.target = target
  }
}

/** A sealed box has the shape `openSealed()` expects, within bounds a hop can check without opening it. */
function plausibleBox(box, maxBytes) {
  return box && typeof box === 'object' && box.v === 1
    && typeof box.kid === 'string' && box.kid.length <= 64
    && typeof box.epk === 'string' && box.epk.length <= 64
    && typeof box.iv === 'string' && box.iv.length <= 32
    && typeof box.ct === 'string' && box.ct.length <= Math.ceil(((maxBytes + 16) * 4) / 3) + 4
}

/** The longest `path` a delivered or forwarded envelope keeps (a diagnostic hint, bounded). */
const MAX_PATH_ENTRIES = 32

/** Random message id from the platform CSPRNG. */
function routedMessageId() {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------
// RouteEntry (plain object factory)
// ---------------------------------------------------------------------------

/**
 * Create a RouteEntry describing a path to a target pod.
 *
 * @param {object} opts
 * @param {string} opts.target      - Target pod ID
 * @param {string} opts.nextHop     - Next hop pod ID to reach target
 * @param {number} [opts.hops]      - Number of hops along the route
 * @param {number} [opts.addedAt]
 * @param {number} [opts.expiresAt]
 * @returns {object}
 */
function createRouteEntry({ target, nextHop, hops = 1, addedAt, expiresAt }) {
  const now = Date.now()
  return {
    target,
    nextHop,
    hops,
    addedAt: addedAt ?? now,
    expiresAt: expiresAt ?? (now + ROUTING_DEFAULTS.routeCacheMs),
  }
}

// ---------------------------------------------------------------------------
// MeshRouter
// ---------------------------------------------------------------------------

/**
 * Multi-hop message router for the mesh network.
 *
 * Maintains a route table mapping target pod IDs to next-hop peers,
 * forwards messages with TTL enforcement, and emits events for
 * delivered and forwarded messages.
 */
export class MeshRouter {
  /** @type {string} */
  #localPodId

  /** @type {Map<string, object>} targetPodId -> RouteEntry */
  #routeTable = new Map()

  /** @type {Set<string>} directly connected peer pod IDs */
  #directPeers = new Set()

  /** @type {Function|null} (nextHop, envelope) => void */
  #forwardFn

  /** @type {number} */
  #maxTTL

  /** @type {number} */
  #routeCacheMs

  /** @type {Function} */
  #onLog

  /** @type {Map<string, Function[]>} */
  #listeners = new Map()

  /** @type {{ sign: Function }|null} signs this pod's own envelopes */
  #signer

  /** @type {boolean} accept envelopes that carry no signature */
  #allowUnsigned

  /** @type {((peerId: string) => boolean)|null} */
  #isLinked

  /** @type {ReplayGuard} refuses a signed envelope this pod already accepted */
  #guard

  /** @type {import('./internal/routed-seal.mjs').SealingKeys|null} */
  #sealing

  /** @type {boolean} */
  #requireSealed

  /** @type {((podId: string) => void)|null} */
  #onKeyWanted

  /**
   * @param {object} opts
   * @param {string} opts.localPodId    - This pod's identifier
   * @param {Function} [opts.forwardFn] - (nextHop, envelope) => void
   * @param {number} [opts.maxTTL]      - Maximum time-to-live for routed messages
   * @param {number} [opts.routeCacheMs] - How long routes remain valid
   * @param {Function} [opts.onLog]     - Logging callback
   * @param {{ sign: Function }} [opts.signer] - A `MessageSigner` for this pod's identity. With one, every
   *   envelope this router originates carries the originator's signature (see `ROUTED_KIND`), `route()`
   *   hands it to `forwardFn` after signing (asynchronously), and unsigned incoming envelopes are refused
   *   unless `allowUnsigned` says otherwise. Without one the router behaves as it always did.
   * @param {boolean} [opts.allowUnsigned] - Accept (and deliver, marked `authenticated: false`) envelopes
   *   with no signature, as older peers send them. Default: `false` with a `signer`, `true` without.
   *   A signature that is present must verify whatever this is.
   * @param {(peerId: string) => boolean} [opts.isLinked] - Whether this pod has a live link with a peer.
   *   A forwarded envelope is dropped (`no-link`) when the peer it arrived from fails this check.
   * @param {{ maxSenders?: number, maxSessionsPerSender?: number }} [opts.replay] - Bounds of the replay window state.
   * @param {import('./internal/routed-seal.mjs').SealingKeys} [opts.sealing] - This pod's agreement keys and the
   *   statements it has learned. With one (and a `signer`), a message to a pod whose key statement is known and
   *   current is sealed to it: only that pod can read it. Without a statement for the destination, the message
   *   goes signed but readable, as before. Incoming sealed messages for this pod are opened with it.
   * @param {boolean} [opts.requireSealed=false] - Refuse to send what cannot be sealed (`SealedUnavailableError`, a
   *   `drop` with reason `sealed-unavailable`), and refuse to accept, as its destination, what arrives readable
   *   (`unsealed`). A hop still forwards what is not for it. `route()` can ask for the sending half per call.
   * @param {(podId: string) => void} [opts.onKeyWanted] - Called when a message goes out readable for want of the
   *   destination's key statement, so the caller can fetch it for next time.
   */
  constructor({ localPodId, forwardFn, maxTTL, routeCacheMs, onLog, signer, allowUnsigned, isLinked, replay, sealing, requireSealed, onKeyWanted }) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string')
    }
    this.#localPodId = localPodId
    this.#forwardFn = forwardFn ?? null
    this.#maxTTL = maxTTL ?? ROUTING_DEFAULTS.maxTTL
    this.#routeCacheMs = routeCacheMs ?? ROUTING_DEFAULTS.routeCacheMs
    this.#onLog = onLog ?? (() => {})
    this.#signer = signer ?? null
    this.#allowUnsigned = allowUnsigned ?? !signer
    this.#isLinked = typeof isLinked === 'function' ? isLinked : null
    this.#guard = new ReplayGuard(replay)
    this.#sealing = signer && sealing ? sealing : null
    this.#requireSealed = requireSealed === true
    this.#onKeyWanted = typeof onKeyWanted === 'function' ? onKeyWanted : null
  }

  // ── Routing ───────────────────────────────────────────────────────

  /**
   * Route a message to a target pod.
   *
   * 1. If targetPodId is a direct peer, send directly (via forwardFn).
   * 2. If a known route exists, forward to the next hop.
   * 3. Otherwise, return { success: false }.
   *
   * @param {string} targetPodId
   * @param {*} message
   * @param {{ requireSealed?: boolean }} [opts] - `requireSealed`: send only if the message can be sealed to the
   *   destination; otherwise throw `SealedUnavailableError` (and emit `drop`, reason `sealed-unavailable`).
   * @returns {{ success: boolean, hops?: number, path?: string[] }}
   */
  route(targetPodId, message, { requireSealed } = {}) {
    const mustSeal = requireSealed ?? this.#requireSealed
    const hasKey = !!this.#sealing?.lookup(targetPodId)
    if (mustSeal && !hasKey) {
      this.#drop('sealed-unavailable', { from: this.#localPodId, to: targetPodId })
      this.#onKeyWanted?.(targetPodId)
      throw new SealedUnavailableError(targetPodId)
    }
    if (!hasKey && this.#sealing) this.#onKeyWanted?.(targetPodId)
    // Build envelope with TTL
    const envelope = {
      from: this.#localPodId,
      to: targetPodId,
      ttl: this.#maxTTL,
      message,
      path: [this.#localPodId],
    }

    // 1. Direct peer?
    if (this.#directPeers.has(targetPodId)) {
      this.#originate(targetPodId, envelope, false)
      return { success: true, hops: 1, path: [this.#localPodId, targetPodId] }
    }

    // 2. Known route? (check expiry)
    const route = this.#routeTable.get(targetPodId)
    if (route && route.expiresAt > Date.now()) {
      this.#originate(route.nextHop, envelope, true)
      return { success: true, hops: route.hops, path: [this.#localPodId, route.nextHop] }
    }
    // Clean up expired route
    if (route && route.expiresAt <= Date.now()) {
      this.#routeTable.delete(targetPodId)
    }

    // 3. No route
    return { success: false }
  }

  /**
   * Hand a freshly built envelope to `forwardFn`, signed first when this router has a signer. Signing is
   * asynchronous, so `route()` has already returned by then; a message that cannot be signed (its content
   * is not JSON) is reported as a `drop` with reason `sign-failed`.
   */
  #originate(nextHop, envelope, announce) {
    const send = (out) => {
      if (this.#forwardFn) this.#forwardFn(nextHop, out)
      if (announce) this.#emit('forward', out)
    }
    if (!this.#signer) return send(envelope)
    const id = routedMessageId()
    const build = async () => {
      let payload = { kind: ROUTED_KIND, id, message: envelope.message }
      let out = envelope
      if (this.#sealing?.lookup(envelope.to)) {
        let sealed
        try {
          sealed = await this.#sealing.seal(envelope.to, { from: this.#localPodId, to: envelope.to, id, message: envelope.message })
        } catch (err) {
          // Too large to seal, or the statement ran out meanwhile: say so; never send readable what was meant sealed.
          return this.#drop(err?.code === 'too-large' ? 'sealed-too-large' : 'sealed-unavailable', envelope, err?.message)
        }
        payload = { kind: ROUTED_KIND, id, message: null, sealed }
        out = { ...envelope, message: null }
      }
      const signed = await this.#signer.sign(createMessage({ from: this.#localPodId, to: envelope.to, payload }))
      send({ ...out, id, signed })
    }
    build().catch((err) => this.#drop('sign-failed', envelope, err?.message))
  }

  // ── Route Table Management ────────────────────────────────────────

  /**
   * Add or update a route to a target pod.
   *
   * @param {string} targetPodId
   * @param {string} nextHop
   * @param {number} [hops=1]
   * @param {number} [ttl] - Override route TTL (ms)
   */
  addRoute(targetPodId, nextHop, hops, ttl) {
    if (this.#routeTable.size >= ROUTING_DEFAULTS.maxRouteEntries && !this.#routeTable.has(targetPodId)) {
      // Evict oldest entry
      const oldestKey = this.#routeTable.keys().next().value
      this.#routeTable.delete(oldestKey)
    }
    const now = Date.now()
    const entry = createRouteEntry({
      target: targetPodId,
      nextHop,
      hops: hops ?? 1,
      addedAt: now,
      expiresAt: now + (ttl ?? this.#routeCacheMs),
    })
    this.#routeTable.set(targetPodId, entry)
    this.#emit('route:add', entry)
  }

  /**
   * Remove a route to a target pod.
   * @param {string} targetPodId
   * @returns {boolean}
   */
  removeRoute(targetPodId) {
    const existed = this.#routeTable.delete(targetPodId)
    if (existed) {
      this.#emit('route:remove', targetPodId)
    }
    return existed
  }

  /**
   * Get the route entry for a target pod.
   * @param {string} targetPodId
   * @returns {object|null} RouteEntry or null
   */
  getRoute(targetPodId) {
    return this.#routeTable.get(targetPodId) ?? null
  }

  // ── Incoming Routed Messages ──────────────────────────────────────

  /**
   * Handle an incoming routed message (envelope).
   *
   * If the message is addressed to this pod, emit 'message'.
   * Otherwise, decrement TTL and forward to the next hop.
   *
   * A signed envelope (`signed`, see `ROUTED_KIND`) is verified first, here, whether this pod is the final
   * recipient or only a hop: the originator, final recipient, id and content are the signed ones, never the
   * top-level `from`/`message` a hop wrote, and one that does not verify is dropped (event `drop`) rather
   * than delivered or forwarded. The final recipient also refuses a copy it already accepted. `path` and
   * `ttl` are set by hops: `path` is kept (bounded) as a diagnostic hint and decides nothing, `ttl` is
   * clamped to this router's `maxTTL`. For an envelope that is neither delivered nor forwarded, the result
   * is `undefined` when it was handled synchronously (an unsigned one) and a promise otherwise.
   *
   * @param {object} envelope - { from, to, ttl, message, path, id?, signed? }
   * @param {{ via?: string }} [meta] - `via`: the peer whose link the envelope arrived on (never a field
   *   of the envelope). When given and `isLinked` is configured, a forwarded envelope from a peer this pod
   *   has no link with is dropped (`no-link`).
   * @returns {Promise<void>|void}
   */
  handleRoutedMessage(envelope, meta = {}) {
    if (!envelope || typeof envelope !== 'object') return

    if (envelope.signed === undefined) {
      if (!this.#allowUnsigned) return this.#drop('unsigned', envelope)
      return this.#accept(envelope, envelope, meta.via, false)
    }
    return this.#verifyThenAccept(envelope, meta.via)
  }

  async #verifyThenAccept(envelope, via) {
    const signed = envelope.signed
    const payload = signed && typeof signed === 'object' ? signed.payload : null
    if (!payload || typeof payload !== 'object' || payload.kind !== ROUTED_KIND || typeof payload.id !== 'string') {
      return this.#drop('malformed', envelope)
    }
    // The top-level `to` is what hops route on; it has to be the signed one.
    if (envelope.to !== signed.to) return this.#drop('wrong-recipient', envelope)
    const forMe = signed.to === this.#localPodId
    let verdict
    try {
      verdict = await verifyMessage(signed, { guard: forMe ? this.#guard : undefined })
    } catch {
      return this.#drop('malformed', envelope)
    }
    if (!verdict.ok) return this.#drop(verdict.reason, envelope)
    const m = verdict.message
    let message = m.payload.message
    let sealed = false
    const box = m.payload.sealed
    if (box !== undefined) {
      const maxBytes = this.#sealing?.maxBytes ?? 64 * 1024
      if (!plausibleBox(box, maxBytes)) return this.#drop('malformed', envelope)
      sealed = true
      if (forMe) {
        if (!this.#sealing) return this.#drop('sealed-unsupported', envelope)
        try {
          message = await this.#sealing.open({ from: m.from, to: m.to, id: m.payload.id, sealed: box })
        } catch {
          return this.#drop('bad-seal', envelope)
        }
      } else {
        message = null // a hop forwards the box; it holds no key for it
      }
    } else if (forMe && this.#requireSealed) {
      return this.#drop('unsealed', envelope)
    }
    return this.#accept(envelope, {
      from: m.from,
      to: m.to,
      message,
      id: m.payload.id,
      sealed,
    }, via, true)
  }

  /**
   * Deliver or forward an envelope whose fields (`v`) are as verified as they are going to be.
   * @param {object} envelope - as received (only `ttl` and `path` are read from it, as hints)
   * @param {{ from: string, to: string, message: *, id?: string }} v
   * @param {string|undefined} via
   * @param {boolean} authenticated
   */
  #accept(envelope, v, via, authenticated) {
    const path = Array.isArray(envelope.path)
      ? envelope.path.filter((p) => typeof p === 'string').slice(0, MAX_PATH_ENTRIES)
      : []

    // Message is for us
    if (v.to === this.#localPodId) {
      this.#emit('message', authenticated
        ? { from: v.from, to: v.to, ttl: envelope.ttl, message: v.message, path, id: v.id, authenticated: true, sealed: v.sealed === true }
        : { ...envelope, authenticated: false, sealed: false })
      return
    }

    // A hop forwards only for a peer it has a link with.
    if (via !== undefined && this.#isLinked && !this.#isLinked(via)) {
      return this.#drop('no-link', envelope)
    }

    // TTL enforcement (a hop cannot raise it above this router's own bound)
    const incoming = Number.isFinite(envelope.ttl) ? Math.min(envelope.ttl, this.#maxTTL) : 0
    const newTTL = incoming - 1
    if (newTTL <= 0) {
      this.#drop('ttl-expired', envelope, `${v.from} to ${v.to}`)
      return
    }

    // Build forwarded envelope. A signed one is rebuilt from the verified fields (plus the signature that
    // proves them) so that what an older recipient reads from the top level is the signed content.
    const forwarded = authenticated
      ? {
          from: v.from,
          to: v.to,
          ttl: newTTL,
          message: v.message,
          path: [...path, this.#localPodId].slice(-MAX_PATH_ENTRIES),
          id: v.id,
          signed: envelope.signed,
        }
      : {
          ...envelope,
          ttl: newTTL,
          path: [...(envelope.path || []), this.#localPodId],
        }

    // Try to forward
    const targetPodId = v.to

    // Direct peer?
    if (this.#directPeers.has(targetPodId)) {
      if (this.#forwardFn) {
        this.#forwardFn(targetPodId, forwarded)
      }
      this.#emit('forward', forwarded)
      return
    }

    // Known route? (check expiry)
    const route = this.#routeTable.get(targetPodId)
    if (route && route.expiresAt > Date.now() && this.#forwardFn) {
      this.#forwardFn(route.nextHop, forwarded)
      this.#emit('forward', forwarded)
    }
  }

  /**
   * An envelope that is neither delivered nor forwarded because of what it is (not because of its TTL).
   * The `claimed*` fields are what the envelope said, which is all they are.
   */
  #drop(reason, envelope, detail) {
    this.#onLog(`Dropping routed message (${reason}) claiming to be from ${envelope?.from} to ${envelope?.to}${detail ? `: ${detail}` : ''}`)
    this.#emit('drop', { reason, claimedFrom: envelope?.from ?? null, claimedTo: envelope?.to ?? null })
  }

  // ── Direct Peer Management ────────────────────────────────────────

  /**
   * Register a directly connected peer.
   * @param {string} podId
   */
  addDirectPeer(podId) {
    this.#directPeers.add(podId)
  }

  /**
   * Remove a directly connected peer.
   * @param {string} podId
   */
  removeDirectPeer(podId) {
    this.#directPeers.delete(podId)
  }

  /**
   * List all directly connected peers.
   * @returns {string[]}
   */
  listDirectPeers() {
    return [...this.#directPeers]
  }

  // ── Route Discovery ───────────────────────────────────────────────

  /**
   * List all route entries.
   * @returns {object[]} Array of RouteEntry
   */
  listRoutes() {
    return [...this.#routeTable.values()]
  }

  /**
   * Remove expired route entries.
   * @param {number} [now=Date.now()]
   * @returns {number} Number of routes pruned
   */
  pruneExpired(now = Date.now()) {
    let count = 0
    for (const [target, entry] of this.#routeTable) {
      if (now >= entry.expiresAt) {
        this.#routeTable.delete(target)
        this.#emit('route:remove', target)
        count++
      }
    }
    return count
  }

  // ── Events ────────────────────────────────────────────────────────

  /**
   * Subscribe to an event.
   * @param {string} event - 'message' | 'forward' | 'drop' | 'route:add' | 'route:remove'
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, [])
    }
    this.#listeners.get(event).push(cb)
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const cbs = this.#listeners.get(event)
    if (!cbs) return
    const idx = cbs.indexOf(cb)
    if (idx !== -1) cbs.splice(idx, 1)
  }

  /**
   * Emit an event to all listeners.
   * @param {string} event
   * @param  {...any} args
   */
  #emit(event, ...args) {
    const cbs = this.#listeners.get(event)
    if (!cbs) return
    for (const cb of [...cbs]) {
      try { cb(...args) } catch { /* listener errors do not propagate */ }
    }
  }

  // ── Serialization ─────────────────────────────────────────────────

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      localPodId: this.#localPodId,
      maxTTL: this.#maxTTL,
      routeCacheMs: this.#routeCacheMs,
      directPeers: [...this.#directPeers],
      routes: [...this.#routeTable.values()],
    }
  }
}

// ---------------------------------------------------------------------------
// ServerSharing
// ---------------------------------------------------------------------------

/**
 * Exposes local HTTP servers to the mesh network and handles incoming
 * proxy requests from remote peers.
 */
export class ServerSharing {
  /** @type {string} */
  #localPodId

  /** @type {Map<string, object>} name -> ServerConfig */
  #exposedServers = new Map()

  /** @type {Function} */
  #fetchFn

  /** @type {Function} */
  #onLog

  /** @type {{ checkAccess: Function }|null} */
  #registry

  /** @type {Map<string, { origin: string, headers: Record<string, string>, allowedMethods: Set<string>|null }>} name -> private share state */
  #shareState = new Map()

  /** @type {Set<string>} */
  #allowedMethods

  /** @type {Set<string>} */
  #allowedHeaders

  /** @type {typeof PROXY_LIMITS_DEFAULTS} */
  #limits

  /**
   * @param {object} opts
   * @param {string} opts.localPodId  - This pod's identifier
   * @param {Function} [opts.fetchFn] - (url, init?) => Response, defaults to globalThis.fetch
   * @param {Function} [opts.onLog]   - Logging callback
   * @param {{ checkAccess: Function }} [opts.registry] - `PeerRegistry`-shaped. Every request that
   *   names a calling peer (see `handleRequest()`) must pass
   *   `registry.checkAccess(peerKey, 'server-share:<name>', 'request')`; without a registry such
   *   requests are refused.
   * @param {string[]} [opts.allowedMethods] - Methods a peer may use (default: GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS)
   * @param {string[]} [opts.allowedRequestHeaders] - Extra request header names a peer may set, added to the defaults
   * @param {number} [opts.maxPathLength=2048]
   * @param {number} [opts.maxRequestBodyBytes=1048576]
   * @param {number} [opts.maxResponseBytes=8388608]
   * @param {number} [opts.maxHeaderCount=32]
   * @param {number} [opts.maxHeaderBytes=8192]
   * @param {number} [opts.requestTimeoutMs=30000]
   */
  constructor(opts) {
    const { localPodId, fetchFn, onLog } = opts
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string')
    }
    this.#localPodId = localPodId
    this.#fetchFn = 'fetchFn' in opts
      ? fetchFn
      : (typeof globalThis.fetch === 'function' ? globalThis.fetch : null)
    this.#onLog = onLog ?? (() => {})
    this.#registry = opts.registry ?? null
    this.#allowedMethods = new Set((opts.allowedMethods ?? DEFAULT_ALLOWED_METHODS).map((m) => String(m).toUpperCase()))
    this.#allowedHeaders = new Set([
      ...DEFAULT_ALLOWED_REQUEST_HEADERS,
      ...(opts.allowedRequestHeaders ?? []).map((h) => String(h).toLowerCase()),
    ])
    const limits = { ...PROXY_LIMITS_DEFAULTS }
    for (const key of Object.keys(limits)) {
      if (opts[key] !== undefined) {
        if (!Number.isFinite(opts[key]) || opts[key] <= 0) throw new Error(`${key} must be a positive number`)
        limits[key] = opts[key]
      }
    }
    this.#limits = Object.freeze(limits)
  }

  // ── Expose / Unexpose ─────────────────────────────────────────────

  /**
   * Expose a local HTTP server on the mesh.
   *
   * @param {number} port          - Local port number
   * @param {string} name          - Service name for the exposed server
   * @param {object} [opts]
   * @param {string} [opts.hostname='localhost'] - Local hostname
   * @param {string} [opts.protocol='http']      - Protocol (http or https)
   * @param {Record<string, string>} [opts.headers] - Headers sent with every request to this
   *   server (for example a credential the sharer chooses to attach). A peer cannot override them.
   * @returns {object} ServerConfig
   */
  expose(port, name, opts = {}) {
    if (typeof port !== 'number' || port <= 0) {
      throw new Error('port must be a positive number')
    }
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a non-empty string')
    }
    if (/[:*]/.test(name)) {
      throw new Error('name must not contain ":" or "*"')
    }

    const hostname = opts.hostname ?? 'localhost'
    const protocol = opts.protocol ?? 'http'
    const origin = configuredOrigin(protocol, hostname, port)
    const headerCheck = checkHeaderShape(opts.headers, { maxHeaderCount: this.#limits.maxHeaderCount, maxHeaderBytes: this.#limits.maxHeaderBytes })
    if (!headerCheck.ok) throw new Error(`headers: ${headerCheck.reason}`)
    const configured = {}
    for (const [k, v] of headerCheck.entries) configured[k.toLowerCase()] = v
    const address = `mesh://${this.#localPodId}/http/${name}`

    const config = {
      name,
      port,
      hostname,
      protocol,
      address,
      exposedAt: Date.now(),
    }

    this.#exposedServers.set(name, config)
    this.#shareState.set(name, { origin, headers: configured })
    this.#onLog(`Exposed server "${name}" at port ${port} → ${address}`)

    return config
  }

  /**
   * Remove an exposed server.
   * @param {string} name
   * @returns {boolean} true if the server existed
   */
  unexpose(name) {
    const existed = this.#exposedServers.delete(name)
    this.#shareState.delete(name)
    if (existed) {
      this.#onLog(`Unexposed server "${name}"`)
    }
    return existed
  }

  // ── Proxy Handling ────────────────────────────────────────────────

  /**
   * Handle an incoming HTTP proxy request from a remote peer.
   *
   * @param {object} request
   * @param {string} request.name     - Name of the exposed server
   * @param {string} request.method   - HTTP method
   * @param {string} request.path     - Request path
   * @param {object} [request.headers] - Request headers
   * @param {*} [request.body]        - Request body (string or bytes)
   * @param {object} [caller]
   * @param {string} [caller.fromPubKey] - The key of the peer that sent the request, taken
   *   from the session it arrived on and never from the message. When `caller` is given the
   *   request must pass `registry.checkAccess(fromPubKey, 'server-share:<name>', 'request')`.
   *   Omit `caller` only for a call made by this process itself.
   * @returns {Promise<{ status: number, headers: object, body: * }>}
   */
  async handleRequest(request, caller) {
    if (!request || typeof request !== 'object') {
      return { status: 400, headers: {}, body: 'Invalid request' }
    }

    if (caller !== undefined) {
      const key = caller?.fromPubKey
      const nameOk = typeof request.name === 'string' && request.name !== '' && !/[:*]/.test(request.name)
      const allowed = nameOk
        && typeof key === 'string' && key !== ''
        && this.#registry !== null
        && this.#registry.checkAccess(key, `server-share:${request.name}`, 'request')?.allowed === true
      if (!allowed) {
        this.#onLog(`Refused request from ${typeof key === 'string' ? key : '(no key)'} for share "${String(request.name).slice(0, 64)}"`)
        return { status: 403, headers: {}, body: 'Access denied' }
      }
    }

    const config = this.#exposedServers.get(request.name)
    const state = this.#shareState.get(request.name)
    if (!config || !state) {
      return { status: 404, headers: {}, body: `Server "${request.name}" not found` }
    }

    const method = request.method === undefined || request.method === null || request.method === ''
      ? 'GET'
      : (typeof request.method === 'string' ? request.method.toUpperCase() : null)
    if (method === null || !this.#allowedMethods.has(method)) {
      return { status: 405, headers: {}, body: 'Method not allowed' }
    }

    const target = resolveTarget(state.origin, request.path, { maxPathLength: this.#limits.maxPathLength })
    if (!target.ok) {
      return { status: 400, headers: {}, body: `Invalid request target: ${target.reason}` }
    }

    const headerCheck = checkHeaderShape(request.headers, this.#limits)
    if (!headerCheck.ok) {
      return { status: 400, headers: {}, body: `Invalid headers: ${headerCheck.reason}` }
    }

    const bodyCheck = checkRequestBody(request.body, this.#limits.maxRequestBodyBytes)
    if (!bodyCheck.ok) {
      return { status: bodyCheck.status, headers: {}, body: bodyCheck.reason }
    }
    if (bodyCheck.body !== undefined && (method === 'GET' || method === 'HEAD')) {
      return { status: 400, headers: {}, body: `A ${method} request cannot carry a body` }
    }

    if (!this.#fetchFn) {
      return { status: 503, headers: {}, body: 'Fetch not available' }
    }

    try {
      const init = {
        method,
        headers: selectRequestHeaders(headerCheck.entries, this.#allowedHeaders, state.headers),
        // A redirect is returned to the peer as it is; it is never followed,
        // so the request cannot leave the configured origin.
        redirect: 'manual',
        signal: AbortSignal.timeout(this.#limits.requestTimeoutMs),
      }
      if (bodyCheck.body !== undefined) init.body = bodyCheck.body
      const response = await this.#fetchFn(target.url.href, init)

      if (responseLeftOrigin(response, state.origin)) {
        try { await response.body?.cancel?.() } catch { /* already closed */ }
        return { status: 502, headers: {}, body: 'Proxy error: response did not come from the configured origin' }
      }

      const read = await readBoundedBody(response, this.#limits.maxResponseBytes)
      if (!read.ok) {
        return { status: 502, headers: {}, body: 'Proxy error: response too large' }
      }

      return {
        status: response.status,
        headers: copyResponseHeaders(response.headers),
        body: read.body,
      }
    } catch (err) {
      return {
        status: 502,
        headers: {},
        body: `Proxy error: ${err.message || err}`,
      }
    }
  }

  // ── Queries ───────────────────────────────────────────────────────

  /**
   * List all exposed servers.
   * @returns {object[]} Array of ServerConfig
   */
  listExposed() {
    return [...this.#exposedServers.values()]
  }

  /**
   * Get a specific exposed server by name.
   * @param {string} name
   * @returns {object|null} ServerConfig or null
   */
  getExposed(name) {
    return this.#exposedServers.get(name) ?? null
  }

  // ── Serialization ─────────────────────────────────────────────────

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      localPodId: this.#localPodId,
      servers: [...this.#exposedServers.values()],
    }
  }
}

// ---------------------------------------------------------------------------
// createMeshRoutingService -- MeshService wiring (Phase C consumer, issue #121)
// ---------------------------------------------------------------------------

/** Default `envelope.type` used to route `MeshRouter` envelopes on the shared `onIncomingData()` bus. */
const DEFAULT_ROUTING_ENVELOPE_TYPE = 'mesh-routing'
/** Default `envelope.type` used to route `ServerSharing` proxy request/response envelopes. */
const DEFAULT_SERVER_SHARE_ENVELOPE_TYPE = 'mesh-server-share'
/** How long `requestProxy()` waits for a matching proxy response before giving up. Mirrors `mesh-rpc.mjs`'s own default. */
const DEFAULT_PROXY_TIMEOUT_MS = 10000

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) that wires
 * `MeshRouter` -- and, if `fetchFn` is supplied, `ServerSharing` too -- onto
 * a real `PeerNode`. Single combined descriptor rather than two, because
 * both classes come from this one file and share the same `localPodId`
 * concept; `ServerSharing`'s wiring is entirely independent internally
 * (different envelope type, own inbound dispatch) so splitting it out later
 * would be a non-breaking change if ever needed.
 *
 * ---------------------------------------------------------------------------
 * MULTI-HOP ROUTING DESIGN -- `forwardFn` -> `ctx.sendTo()`:
 *
 * `MeshRouter`'s only side effect on the network is calling
 * `forwardFn(nextHop, envelope)` (see `route()`/`handleRoutedMessage()`
 * above), where `envelope` is `{ from, to, ttl, message, path }` and
 * `nextHop` is either the ultimate target (if it's a registered direct peer)
 * or an intermediate pod from the route table. This file's `forwardFn` is
 * simply:
 *
 *   (nextHop, envelope) => ctx.sendTo(nextHop, envelopeType, envelope)
 *
 * `ctx.sendTo()` sends `{ type: envelopeType, ...envelope }` to `nextHop` --
 * the envelope's own `to`/`ttl`/`message`/`path` fields pass through
 * unchanged, so the receiving peer's `ctx.onIncomingData()` callback gets
 * the exact same shape `handleRoutedMessage()` expects, plus the `type` tag
 * (which `handleRoutedMessage()` ignores). `MeshRouter` calls `forwardFn`
 * SYNCHRONOUSLY and does not await or check its return value (see
 * `route()`/`handleRoutedMessage()`'s own bodies) -- `ctx.sendTo()` is
 * async, so this wrapper fires it and attaches a `.catch()` for logging
 * rather than letting a failed send become an unhandled rejection.
 *
 * The actual multi-hop mechanics -- genuinely different from a plain
 * `ctx.sendTo()` request/response, per this phase's own brief -- happen
 * entirely inside `MeshRouter.handleRoutedMessage()`, unmodified: an
 * intermediate pod (say B, relaying from A to C) receives the envelope via
 * this file's `ctx.onIncomingData()` subscription, calls
 * `router.handleRoutedMessage(envelope)`, which sees `envelope.to !== B's
 * own podId`, decrements `ttl`, appends B to `path`, and re-invokes
 * `forwardFn` (this same wrapper) to send the decremented envelope onward
 * to C -- recursing through as many pods as `maxTTL` allows. Each hop is an
 * independent `ctx.sendTo()` call; there is no single long-lived connection
 * or stream spanning the whole path. The topology itself (who is a "direct
 * peer" vs. reachable only "via route") is intentionally NOT auto-discovered
 * from `PeerNode`'s own connection events here -- `addDirectPeer()`/
 * `addRoute()`/`removeRoute()` are exposed on `api` exactly as `MeshRouter`
 * already defines them, so a caller (or a later phase) decides how routing
 * topology gets populated, mirroring how `MeshRouter`'s own class never
 * assumed a topology source either.
 *
 * ---------------------------------------------------------------------------
 * SERVER SHARING DESIGN (opt-in via `fetchFn`) -- `ServerSharing` itself has
 * no wire protocol or `PeerNode` awareness at all: `expose()`/`unexpose()`
 * are purely local bookkeeping, and `handleRequest()` is a plain async
 * function `{name, method, path, headers, body} -> {status, headers, body}`
 * that proxies via the injected `fetchFn`. To let a REMOTE peer actually
 * trigger that proxying (the whole point of "server sharing"), this file
 * adds a small request/response wire protocol over a second envelope type
 * (`serverShareEnvelopeType`, default `'mesh-server-share'`), modeled
 * directly on `mesh-rpc.mjs`'s `requestId`-correlated request/response
 * pattern (same reasoning: multiple concurrent `requestProxy()` calls must
 * not cross-correlate):
 *
 *   Proxy request  (caller -> host): `{ type, kind: 'proxy-request', requestId, name, method, path, headers, body }`
 *   Proxy response (host -> caller): `{ type, kind: 'proxy-response', requestId, status, headers, body }`
 *
 * The HOST side (the peer with `expose()`d servers) answers a proxy request
 * by calling its own `serverSharing.handleRequest()` directly -- no
 * caller-supplied handler, unlike `mesh-rpc.mjs`'s `onRequest`, since
 * `ServerSharing`'s whole job already IS "answer this proxy request". A
 * `ServerSharing` attached with no `fetchFn` (or `fetchFn: null`, honoring
 * that class's own `'fetchFn' in opts` distinction -- see its constructor)
 * still answers proxy requests, just with `ServerSharing`'s own `503`
 * ("Fetch not available") for every one, exactly like calling
 * `handleRequest()` directly would.
 *
 * This half is entirely OPT-IN: `createMeshRoutingService()` only
 * constructs a `ServerSharing` instance, attaches its proxy dispatch, and
 * adds `expose`/`unexpose`/`handleRequest`/`listExposed`/`getExposed`/
 * `requestProxy` to `api` when the caller's options object has an OWN
 * `fetchFn` key at all (checked via `'fetchFn' in opts`, matching
 * `ServerSharing`'s own constructor distinction between "omitted" and
 * "explicitly null") -- a caller that only wants multi-hop routing and
 * never mentions `fetchFn` gets no `ServerSharing` instance, no second
 * `ctx.onIncomingData()` subscription, and no server-sharing methods on
 * `api` at all.
 *
 * ---------------------------------------------------------------------------
 * EVENTS (`ctx.emit()`, see `mesh-service.mjs`'s "Observability events"
 * section for the full convention) -- `MeshRouter`'s own pre-existing
 * `on`/`off` surface (`'message'`/`'forward'`/`'route:add'`/`'route:remove'`)
 * is bridged through verbatim, prefixed `mesh-routing:`:
 *
 *   - `mesh-routing:message`      -- the routed envelope, whenever `envelope.to`
 *     was this pod (`MeshRouter`'s own `'message'` event payload, unchanged).
 *   - `mesh-routing:forward`      -- the (possibly TTL-decremented) envelope
 *     this pod just forwarded onward (`MeshRouter`'s own `'forward'` payload).
 *   - `mesh-routing:route-add`    -- the new/updated `RouteEntry` (`MeshRouter`'s
 *     own `'route:add'` payload).
 *   - `mesh-routing:route-remove` -- `{ target }`, wrapping `MeshRouter`'s own
 *     `'route:remove'` payload (a bare targetPodId string) in an object, to
 *     match this file's other events and the family's general "emit an
 *     object" convention.
 *
 * Plus this file's own, for the `ServerSharing` half:
 *
 *   - `mesh-routing:server-share-served`  `{from, name, status}` -- a proxy
 *     request was answered (whatever the status).
 *   - `mesh-routing:server-share-timeout` `{to, name, method, path}` -- the
 *     CALLING side's `requestProxy()` gave up waiting.
 *
 * ---------------------------------------------------------------------------
 * `ServerSharing` HAS NO `on`/`off` OF ITS OWN (confirmed by reading the
 * class above -- unlike `MeshRouter`, it has no `#listeners`/`#emit()` at
 * all). This is treated as intentional, not a gap to backfill here:
 * `expose()`/`unexpose()`/`handleRequest()` are synchronous-ish local
 * bookkeeping and request/response calls respectively, each with an
 * immediately-observable return value at the call site -- there is no
 * asynchronous background state transition (unlike `MeshRouter`'s routing
 * table expiring, or `TransportHealthCheck`'s liveness state machine) that
 * a caller could otherwise only learn about via an event. This file's own
 * `mesh-routing:server-share-served`/`-timeout` events above already cover
 * the one genuinely async, fire-and-forget-shaped thing `ServerSharing`
 * gains once it's wired to the network (a remote proxy request being
 * answered, or timing out).
 *
 * No browser-only imports at module level.
 */

/**
 * A pod-message signer for the node's default identity, or null when the node has
 * no wallet that can sign (a duck-typed node in a test, say).
 */
function walletIdentity(peerNode) {
  const wallet = peerNode?.wallet
  const podId = peerNode?.podId
  if (!wallet || !podId || typeof wallet.sign !== 'function' || typeof wallet.getPublicKeyBytes !== 'function') return null
  return {
    podId,
    sign: (data) => wallet.sign(podId, data),
    rawPublicKey: () => wallet.getPublicKeyBytes(podId),
  }
}

function walletSigner(peerNode) {
  const identity = walletIdentity(peerNode)
  return identity ? new MessageSigner(identity) : null
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.allowUnsigned] - Accept routed envelopes with no originator signature, as pods on
 *   earlier releases send them (delivered with `authenticated: false`; their `from` is then only a claim).
 *   Default: `false` when the node can sign, `true` when it cannot. A signature that is present must verify.
 * @param {number} [opts.maxTTL] - Forwarded to `MeshRouter` (default 8, see `ROUTING_DEFAULTS`).
 * @param {number} [opts.routeCacheMs] - Forwarded to `MeshRouter` (default 60000, see `ROUTING_DEFAULTS`).
 * @param {string} [opts.envelopeType='mesh-routing'] - `envelope.type` used for `MeshRouter` traffic.
 * @param {Function} [opts.fetchFn] - If this key is present at all (even
 *   `null`), a `ServerSharing` instance is also constructed and wired --
 *   see module doc comment's "SERVER SHARING DESIGN" section. Passed
 *   straight through to `new ServerSharing({ fetchFn })`.
 * @param {string} [opts.serverShareEnvelopeType='mesh-server-share'] -
 *   `envelope.type` used for `ServerSharing` proxy request/response traffic.
 *   Only relevant when `fetchFn` is supplied.
 * @param {number} [opts.proxyTimeoutMs=10000] - How long `requestProxy()`
 *   waits for a matching proxy response. Only relevant when `fetchFn` is supplied.
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createMeshRoutingService(opts = {}) {
  const {
    maxTTL,
    routeCacheMs,
    envelopeType = DEFAULT_ROUTING_ENVELOPE_TYPE,
    fetchFn,
    serverShareEnvelopeType = DEFAULT_SERVER_SHARE_ENVELOPE_TYPE,
    proxyTimeoutMs = DEFAULT_PROXY_TIMEOUT_MS,
    registry,
    allowedMethods,
    allowedRequestHeaders,
    maxPathLength,
    maxRequestBodyBytes,
    maxResponseBytes,
    maxHeaderCount,
    maxHeaderBytes,
    requestTimeoutMs,
    allowUnsigned,
    sealing: sealingOption = true,
    sealingOptions = {},
    requireSealed,
    onLog,
  } = opts
  const wireServerSharing = 'fetchFn' in opts
  const log = onLog || (() => {})

  return {
    name: 'mesh-routing',

    attach(peerNode, ctx) {
      const localPodId = peerNode.podId

      // The node's own identity signs what this pod originates (a node with no
      // signing identity routes unsigned, as it always did).
      const signer = walletSigner(peerNode)

      // -----------------------------------------------------------------
      // END-TO-END SEALING. This pod's agreement key and key statement (signed by its identity key), the
      // statements it has learned from other pods, and the seal/open operations. Off with `sealing: false`;
      // a node that cannot sign or has no X25519 neither seals nor publishes a statement.
      // -----------------------------------------------------------------
      const keyEnvelopeType = `${envelopeType}-keys`
      /** @type {Set<string>} */
      const directForKeys = new Set()
      const announce = (podId, reply) => {
        keys?.statement().then((statement) => {
          if (statement) ctx.sendTo(podId, keyEnvelopeType, { kind: 'statement', statement, reply }).catch(() => {})
        }).catch(() => {})
      }
      const identity = sealingOption !== false ? walletIdentity(peerNode) : null
      const keys = identity
        ? new SealingKeys({ identity, ...sealingOptions, onRotate: (statement) => { for (const p of directForKeys) ctx.sendTo(p, keyEnvelopeType, { kind: 'statement', statement, reply: false }).catch(() => {}) } })
        : null
      /** podId -> waiters for a statement of that pod */
      const keyWaiters = new Map()
      const lastAsked = new Map()
      const clockNow = sealingOptions.now ?? Date.now
      const learnStatement = async (statement) => {
        const learned = await keys.learn(statement)
        ctx.emit('mesh-routing:key-learned', learned)
        for (const w of keyWaiters.get(learned.podId) ?? []) w.resolve(keys.lookup(learned.podId))
        keyWaiters.delete(learned.podId)
        return learned
      }

      // -----------------------------------------------------------------
      // MeshRouter -- see module doc comment's "MULTI-HOP ROUTING DESIGN".
      // -----------------------------------------------------------------
      const router = new MeshRouter({
        localPodId,
        signer,
        allowUnsigned,
        sealing: keys,
        requireSealed,
        // A message went out readable for want of the destination's statement: ask for it, once a minute at most.
        onKeyWanted: (podId) => {
          const t = clockNow()
          if (!keys || (lastAsked.get(podId) ?? -Infinity) + 60_000 > t) return
          lastAsked.set(podId, t)
          api.ensureKey(podId, { timeoutMs: 10_000 }).catch(() => {})
        },
        // An envelope arrives over some peer's session; a hop forwards only for a peer it still has one with.
        isLinked: typeof peerNode.hasActiveSession === 'function' ? (id) => peerNode.hasActiveSession(id) : undefined,
        forwardFn: (nextHop, envelope) => {
          ctx.sendTo(nextHop, envelopeType, envelope).catch((err) => {
            log('mesh-routing:forward-send-failed', {
              nextHop,
              to: envelope?.to,
              error: err?.message || String(err),
            })
          })
        },
        maxTTL,
        routeCacheMs,
        onLog: (msg) => log('mesh-routing:router-log', { message: msg }),
      })

      // Bridge MeshRouter's own pre-existing on()/off() events through
      // ctx.emit() -- see module doc comment's "EVENTS" section.
      const onRouterMessage = (envelope) => {
        // Key requests and answers ride in ordinary (signed) routed messages; they are for this service, not the application.
        const control = envelope?.message && typeof envelope.message === 'object' ? envelope.message.$mesh : undefined
        if (typeof control === 'string' && control.startsWith('key-')) {
          if (!keys) return
          if (control === 'key-request') {
            keys.statement().then((statement) => {
              if (statement) router.route(envelope.from, { $mesh: 'key-statement', statement }, { requireSealed: false })
            }).catch(() => {})
          } else if (control === 'key-statement') {
            learnStatement(envelope.message.statement).catch((err) => {
              log('mesh-routing:key-statement-refused', { from: envelope.from, error: err?.message || String(err) })
            })
          }
          return
        }
        ctx.emit('mesh-routing:message', envelope)
      }
      const onRouterForward = (envelope) => ctx.emit('mesh-routing:forward', envelope)
      const onRouterRouteAdd = (entry) => ctx.emit('mesh-routing:route-add', entry)
      const onRouterRouteRemove = (target) => ctx.emit('mesh-routing:route-remove', { target })
      const onRouterDrop = (drop) => ctx.emit('mesh-routing:drop', drop)
      router.on('message', onRouterMessage)
      router.on('forward', onRouterForward)
      router.on('drop', onRouterDrop)
      router.on('route:add', onRouterRouteAdd)
      router.on('route:remove', onRouterRouteRemove)

      const unsubscribeRouting = ctx.onIncomingData(envelopeType, (fromPubKey, envelope) => {
        // `fromPubKey` is the session the envelope arrived on: the direct peer, never a field of the envelope.
        return router.handleRoutedMessage(envelope, { via: fromPubKey })
      })

      // Statements handed over on a direct link (and answered in kind once).
      const unsubscribeKeys = keys
        ? ctx.onIncomingData(keyEnvelopeType, (fromPubKey, msg) => {
          if (!msg || msg.kind !== 'statement') return
          learnStatement(msg.statement).catch((err) => {
            log('mesh-routing:key-statement-refused', { from: fromPubKey, error: err?.message || String(err) })
          })
          if (msg.reply === true) announce(fromPubKey, false)
        })
        : () => {}

      const api = {
        /** `opts.requireSealed`: send only if it can be sealed to the destination; throws `SealedUnavailableError` otherwise. */
        route: (targetPodId, message, routeOpts) => router.route(targetPodId, message, routeOpts),
        /** This pod's current key statement (signed by its identity key; rotated), or null when it does not seal. */
        keyStatement: async () => (keys ? keys.statement() : null),
        /** Verify and remember another pod's key statement (from a hello, a direct link or out of band). */
        learnKeyStatement: (statement) => {
          if (!keys) return Promise.reject(new Error('sealing is off'))
          return learnStatement(statement)
        },
        /** The statement this pod would seal to for `podId`, or null (none, expired). */
        getKeyStatement: (podId) => (keys ? keys.lookup(podId) : null),
        /** The statement for `podId`: the cached one, or one fetched with a routed request. */
        ensureKey: (podId, { timeoutMs = 10_000 } = {}) => {
          const known = keys?.lookup(podId)
          if (known) return Promise.resolve(known)
          if (!keys) return Promise.reject(new Error('sealing is off'))
          return new Promise((resolve, reject) => {
            const waiter = { resolve: (s) => { clearTimeout(timer); resolve(s) } }
            const timer = setTimeout(() => {
              keyWaiters.set(podId, (keyWaiters.get(podId) ?? []).filter((w) => w !== waiter))
              reject(new Error(`no key statement from ${podId} within ${timeoutMs}ms`))
            }, timeoutMs)
            timer.unref?.()
            keyWaiters.set(podId, [...(keyWaiters.get(podId) ?? []), waiter])
            try {
              const sent = router.route(podId, { $mesh: 'key-request' }, { requireSealed: false })
              if (!sent.success) { clearTimeout(timer); keyWaiters.delete(podId); reject(new Error(`no route to ${podId}`)) }
            } catch (err) { clearTimeout(timer); reject(err) }
          })
        },
        addRoute: (targetPodId, nextHop, hops, ttl) => router.addRoute(targetPodId, nextHop, hops, ttl),
        removeRoute: (targetPodId) => router.removeRoute(targetPodId),
        getRoute: (targetPodId) => router.getRoute(targetPodId),
        addDirectPeer: (podId) => {
          router.addDirectPeer(podId)
          if (keys) { directForKeys.add(podId); announce(podId, true) }
        },
        removeDirectPeer: (podId) => { directForKeys.delete(podId); router.removeDirectPeer(podId) },
        listDirectPeers: () => router.listDirectPeers(),
        listRoutes: () => router.listRoutes(),
        pruneExpired: (now) => router.pruneExpired(now),
        toJSON: () => router.toJSON(),
      }

      // -----------------------------------------------------------------
      // ServerSharing (opt-in) -- see module doc comment's "SERVER SHARING
      // DESIGN" section.
      // -----------------------------------------------------------------
      let serverSharing = null
      let unsubscribeServerShare = null
      /** @type {Map<string, {resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>}>} */
      const pendingProxyRequests = new Map()

      if (wireServerSharing) {
        serverSharing = new ServerSharing({
          localPodId,
          fetchFn,
          registry: registry ?? peerNode.registry ?? null,
          allowedMethods,
          allowedRequestHeaders,
          maxPathLength,
          maxRequestBodyBytes,
          maxResponseBytes,
          maxHeaderCount,
          maxHeaderBytes,
          requestTimeoutMs,
          onLog: (msg) => log('mesh-routing:server-share-log', { message: msg }),
        })

        const nextProxyRequestId = randomRequestId

        async function handleProxyRequest(fromPubKey, msg) {
          const { requestId } = msg
          let result
          try {
            // The caller is the key of the session the message arrived on;
            // nothing in `msg` can name a different one.
            result = await serverSharing.handleRequest({
              name: msg.name,
              method: msg.method,
              path: msg.path,
              headers: msg.headers,
              body: msg.body,
            }, { fromPubKey })
          } catch (err) {
            // handleRequest() already catches its own fetchFn errors (see
            // ServerSharing.handleRequest()'s 502 path) -- reaching here
            // would mean something else entirely went wrong; still never
            // let it become an unhandled rejection or crash the shared
            // dispatch loop.
            result = { status: 500, headers: {}, body: `Proxy handling error: ${err?.message || err}` }
          }
          const status = typeof result?.status === 'number' ? result.status : 200
          const headers = result?.headers && typeof result.headers === 'object' ? result.headers : {}
          const body = result && 'body' in result ? result.body : undefined
          try {
            await ctx.sendTo(fromPubKey, serverShareEnvelopeType, {
              kind: 'proxy-response', requestId, status, headers, body,
            })
            ctx.emit('mesh-routing:server-share-served', { from: fromPubKey, name: msg.name, status })
          } catch (err) {
            log('mesh-routing:server-share-response-send-failed', { to: fromPubKey, requestId, error: err?.message || String(err) })
          }
        }

        function handleProxyResponse(fromPubKey, msg) {
          const pending = pendingProxyRequests.get(msg.requestId)
          if (!pending) return // no longer waiting (already timed out, or not ours) -- ignore
          // Only the peer the request was sent to can answer it.
          if (pending.podId !== fromPubKey) return
          pendingProxyRequests.delete(msg.requestId)
          clearTimeout(pending.timer)
          pending.resolve({ status: msg.status, headers: msg.headers || {}, body: msg.body })
        }

        unsubscribeServerShare = ctx.onIncomingData(serverShareEnvelopeType, (fromPubKey, msg) => {
          if (!msg || typeof msg.kind !== 'string') return
          if (msg.kind === 'proxy-request') {
            handleProxyRequest(fromPubKey, msg).catch((err) => {
              log('mesh-routing:server-share-request-handling-failed', { from: fromPubKey, requestId: msg.requestId, error: err?.message || String(err) })
            })
          } else if (msg.kind === 'proxy-response') {
            handleProxyResponse(fromPubKey, msg)
          }
        })

        /**
         * Ask `podId` (a peer that has `expose()`d `name`) to proxy an HTTP
         * request to its locally exposed server, and await the response.
         * @param {string} podId
         * @param {{name: string, method?: string, path?: string, headers?: object, body?: *}} req
         * @returns {Promise<{status: number, headers: object, body: *}>}
         */
        async function requestProxy(podId, { name, method = 'GET', path = '/', headers = {}, body } = {}) {
          const requestId = nextProxyRequestId()

          const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              pendingProxyRequests.delete(requestId)
              ctx.emit('mesh-routing:server-share-timeout', { to: podId, name, method, path })
              reject(new Error(`mesh-routing: proxy request ${method} ${path} (server "${name}") to ${podId} timed out after ${proxyTimeoutMs}ms`))
            }, proxyTimeoutMs)
            pendingProxyRequests.set(requestId, { resolve, reject, timer, podId })
          })

          try {
            await ctx.sendTo(podId, serverShareEnvelopeType, { kind: 'proxy-request', requestId, name, method, path, headers, body })
          } catch (err) {
            const pending = pendingProxyRequests.get(requestId)
            if (pending) {
              clearTimeout(pending.timer)
              pendingProxyRequests.delete(requestId)
            }
            throw err
          }

          return promise
        }

        api.expose = (port, name, exposeOpts) => serverSharing.expose(port, name, exposeOpts)
        api.unexpose = (name) => serverSharing.unexpose(name)
        api.handleRequest = (request) => serverSharing.handleRequest(request)
        api.listExposed = () => serverSharing.listExposed()
        api.getExposed = (name) => serverSharing.getExposed(name)
        api.requestProxy = requestProxy
      }

      return {
        api,
        teardown() {
          router.off('message', onRouterMessage)
          router.off('forward', onRouterForward)
          router.off('drop', onRouterDrop)
          router.off('route:add', onRouterRouteAdd)
          router.off('route:remove', onRouterRouteRemove)
          unsubscribeRouting()
          unsubscribeKeys()
          if (unsubscribeServerShare) unsubscribeServerShare()
          for (const pending of pendingProxyRequests.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error('mesh-routing: service torn down while a proxy request was still in flight'))
          }
          pendingProxyRequests.clear()
        },
      }
    },
  }
}

export { DEFAULT_ROUTING_ENVELOPE_TYPE, DEFAULT_SERVER_SHARE_ENVELOPE_TYPE, DEFAULT_PROXY_TIMEOUT_MS }
