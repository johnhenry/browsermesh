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

  /**
   * @param {object} opts
   * @param {string} opts.localPodId    - This pod's identifier
   * @param {Function} [opts.forwardFn] - (nextHop, envelope) => void
   * @param {number} [opts.maxTTL]      - Maximum time-to-live for routed messages
   * @param {number} [opts.routeCacheMs] - How long routes remain valid
   * @param {Function} [opts.onLog]     - Logging callback
   */
  constructor({ localPodId, forwardFn, maxTTL, routeCacheMs, onLog }) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string')
    }
    this.#localPodId = localPodId
    this.#forwardFn = forwardFn ?? null
    this.#maxTTL = maxTTL ?? ROUTING_DEFAULTS.maxTTL
    this.#routeCacheMs = routeCacheMs ?? ROUTING_DEFAULTS.routeCacheMs
    this.#onLog = onLog ?? (() => {})
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
   * @returns {{ success: boolean, hops?: number, path?: string[] }}
   */
  route(targetPodId, message) {
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
      if (this.#forwardFn) {
        this.#forwardFn(targetPodId, envelope)
      }
      return { success: true, hops: 1, path: [this.#localPodId, targetPodId] }
    }

    // 2. Known route? (check expiry)
    const route = this.#routeTable.get(targetPodId)
    if (route && route.expiresAt > Date.now()) {
      if (this.#forwardFn) {
        this.#forwardFn(route.nextHop, envelope)
      }
      this.#emit('forward', envelope)
      return { success: true, hops: route.hops, path: [this.#localPodId, route.nextHop] }
    }
    // Clean up expired route
    if (route && route.expiresAt <= Date.now()) {
      this.#routeTable.delete(targetPodId)
    }

    // 3. No route
    return { success: false }
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
   * @param {object} envelope - { from, to, ttl, message, path }
   */
  handleRoutedMessage(envelope) {
    if (!envelope || typeof envelope !== 'object') return

    // Message is for us
    if (envelope.to === this.#localPodId) {
      this.#emit('message', envelope)
      return
    }

    // TTL enforcement
    const newTTL = (envelope.ttl ?? 0) - 1
    if (newTTL <= 0) {
      this.#onLog(`Dropping message from ${envelope.from} to ${envelope.to}: TTL expired`)
      return
    }

    // Build forwarded envelope
    const forwarded = {
      ...envelope,
      ttl: newTTL,
      path: [...(envelope.path || []), this.#localPodId],
    }

    // Try to forward
    const targetPodId = envelope.to

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
   * @param {string} event - 'message' | 'forward' | 'route:add' | 'route:remove'
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

  /**
   * @param {object} opts
   * @param {string} opts.localPodId  - This pod's identifier
   * @param {Function} [opts.fetchFn] - (url, init?) => Response, defaults to globalThis.fetch
   * @param {Function} [opts.onLog]   - Logging callback
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
   * @returns {object} ServerConfig
   */
  expose(port, name, opts = {}) {
    if (typeof port !== 'number' || port <= 0) {
      throw new Error('port must be a positive number')
    }
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a non-empty string')
    }

    const hostname = opts.hostname ?? 'localhost'
    const protocol = opts.protocol ?? 'http'
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
   * @param {*} [request.body]        - Request body
   * @returns {Promise<{ status: number, headers: object, body: * }>}
   */
  async handleRequest(request) {
    if (!request || typeof request !== 'object') {
      return { status: 400, headers: {}, body: 'Invalid request' }
    }

    const config = this.#exposedServers.get(request.name)
    if (!config) {
      return { status: 404, headers: {}, body: `Server "${request.name}" not found` }
    }

    const url = `${config.protocol}://${config.hostname}:${config.port}${request.path || '/'}`

    if (!this.#fetchFn) {
      return { status: 503, headers: {}, body: 'Fetch not available' }
    }

    try {
      const response = await this.#fetchFn(url, {
        method: request.method || 'GET',
        headers: request.headers || {},
        body: request.body,
      })

      const responseHeaders = {}
      if (response.headers && typeof response.headers.forEach === 'function') {
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value
        })
      }

      const body = await (typeof response.text === 'function' ? response.text() : response.body)

      return {
        status: response.status,
        headers: responseHeaders,
        body,
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
 * @param {object} [opts]
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
    onLog,
  } = opts
  const wireServerSharing = 'fetchFn' in opts
  const log = onLog || (() => {})

  return {
    name: 'mesh-routing',

    attach(peerNode, ctx) {
      const localPodId = peerNode.podId

      // -----------------------------------------------------------------
      // MeshRouter -- see module doc comment's "MULTI-HOP ROUTING DESIGN".
      // -----------------------------------------------------------------
      const router = new MeshRouter({
        localPodId,
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
      const onRouterMessage = (envelope) => ctx.emit('mesh-routing:message', envelope)
      const onRouterForward = (envelope) => ctx.emit('mesh-routing:forward', envelope)
      const onRouterRouteAdd = (entry) => ctx.emit('mesh-routing:route-add', entry)
      const onRouterRouteRemove = (target) => ctx.emit('mesh-routing:route-remove', { target })
      router.on('message', onRouterMessage)
      router.on('forward', onRouterForward)
      router.on('route:add', onRouterRouteAdd)
      router.on('route:remove', onRouterRouteRemove)

      const unsubscribeRouting = ctx.onIncomingData(envelopeType, (fromPubKey, envelope) => {
        router.handleRoutedMessage(envelope)
      })

      const api = {
        route: (targetPodId, message) => router.route(targetPodId, message),
        addRoute: (targetPodId, nextHop, hops, ttl) => router.addRoute(targetPodId, nextHop, hops, ttl),
        removeRoute: (targetPodId) => router.removeRoute(targetPodId),
        getRoute: (targetPodId) => router.getRoute(targetPodId),
        addDirectPeer: (podId) => router.addDirectPeer(podId),
        removeDirectPeer: (podId) => router.removeDirectPeer(podId),
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
          onLog: (msg) => log('mesh-routing:server-share-log', { message: msg }),
        })

        let proxyReqSeq = 0
        const nextProxyRequestId = () => `${localPodId}:${Date.now()}:${++proxyReqSeq}`

        async function handleProxyRequest(fromPubKey, msg) {
          const { requestId } = msg
          let result
          try {
            result = await serverSharing.handleRequest({
              name: msg.name,
              method: msg.method,
              path: msg.path,
              headers: msg.headers,
              body: msg.body,
            })
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

        function handleProxyResponse(msg) {
          const pending = pendingProxyRequests.get(msg.requestId)
          if (!pending) return // no longer waiting (already timed out, or not ours) -- ignore
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
            handleProxyResponse(msg)
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
            pendingProxyRequests.set(requestId, { resolve, reject, timer })
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
          router.off('route:add', onRouterRouteAdd)
          router.off('route:remove', onRouterRouteRemove)
          unsubscribeRouting()
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
