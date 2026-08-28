/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-peer-routing.js -- Multi-hop message routing and server sharing.
 *
 * Routes messages across the mesh via intermediary peers when direct
 * connections are unavailable. Also enables HTTP server sharing via mesh.
 *
 * MeshRouter manages a route table and forwards messages through multi-hop
 * paths with TTL enforcement.
 * ServerSharing exposes local HTTP servers to the mesh and proxies incoming
 * requests from peers.
 *
 * No browser-only imports at module level. All dependencies injected.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-routing.test.mjs
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
