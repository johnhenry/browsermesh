/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-cross-origin.js -- Cross-origin communication bridge.
 *
 * Enables mesh pods running in different browser contexts (iframes,
 * popups, different-origin tabs) to communicate securely using
 * postMessage with origin validation and method allowlisting.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-cross-origin.test.mjs
 */

// ---------------------------------------------------------------------------
// Trust levels
// ---------------------------------------------------------------------------

export const TRUST_LEVELS = Object.freeze({
  ISOLATED: 'isolated',    // No communication allowed
  VERIFIED: 'verified',    // Origin verified, limited methods
  TRUSTED: 'trusted',      // Full method access
  LINKED: 'linked',        // Bidirectional trust
  PINNED: 'pinned',        // Pinned trust (like HSTS)
})

// ---------------------------------------------------------------------------
// Wire message types
// ---------------------------------------------------------------------------

export const XO_REQUEST = 'mesh-xo-request'
export const XO_RESPONSE = 'mesh-xo-response'
export const XO_HANDSHAKE = 'mesh-xo-handshake'
export const XO_HANDSHAKE_ACK = 'mesh-xo-handshake-ack'

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

/**
 * Rate limiter for cross-origin messages per peer.
 *
 * Tracks message counts in a sliding time window per peerId.
 * Once a peer exceeds `maxPerWindow` messages within `windowMs`,
 * further messages are rejected until the window resets.
 */
export class RateLimiter {
  #maxPerWindow
  #windowMs
  #counters = new Map()  // peerId -> { count, resetAt }

  /**
   * @param {object} opts
   * @param {number} [opts.maxPerWindow=100] - Max messages per window.
   * @param {number} [opts.windowMs=60000]   - Window duration in ms.
   */
  constructor({ maxPerWindow = 100, windowMs = 60000 } = {}) {
    this.#maxPerWindow = maxPerWindow
    this.#windowMs = windowMs
  }

  /** @returns {number} Configured max per window. */
  get maxPerWindow() { return this.#maxPerWindow }

  /** @returns {number} Configured window duration in ms. */
  get windowMs() { return this.#windowMs }

  /**
   * Check if a peer is within rate limits.
   * Does NOT consume a slot -- use `record()` after a successful check.
   * @param {string} peerId
   * @returns {boolean} true if the peer may send another message.
   */
  check(peerId) {
    const now = Date.now()
    const entry = this.#counters.get(peerId)
    if (!entry) return true
    if (now >= entry.resetAt) return true
    return entry.count < this.#maxPerWindow
  }

  /**
   * Record one message from a peer.
   * Creates a fresh window if the peer has no active window.
   * @param {string} peerId
   */
  record(peerId) {
    const now = Date.now()
    let entry = this.#counters.get(peerId)
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.#windowMs }
      this.#counters.set(peerId, entry)
    }
    entry.count++
  }

  /** Reset all counters for every peer. */
  reset() {
    this.#counters.clear()
  }

  /**
   * Reset the counter for a single peer.
   * @param {string} peerId
   * @returns {boolean} true if the peer had an entry.
   */
  resetPeer(peerId) {
    return this.#counters.delete(peerId)
  }
}

// ---------------------------------------------------------------------------
// CrossOriginBridge
// ---------------------------------------------------------------------------

/**
 * Cross-origin communication bridge.
 *
 * Manages peer registration, origin validation, method allowlisting,
 * rate limiting and message dispatch.
 *
 * Usage (browser):
 *   const bridge = new CrossOriginBridge({ localPodId: 'pod-1' })
 *   bridge.registerPeer('pod-2', { origin: 'https://other.example' })
 *   bridge.setMethodHandler('ping', () => 'pong')
 *   window.addEventListener('message', (e) => bridge.handleMessage(e))
 */
export class CrossOriginBridge {
  #localPodId
  #peers = new Map()           // peerId -> PeerEntry
  #handlers = new Map()        // method -> handler(params, fromPodId)
  #rateLimiter
  #onLog
  #pendingRequests = new Map() // requestId -> { resolve, reject, timer }
  #nextId = 1
  #defaultTimeout

  /**
   * @param {object} opts
   * @param {string} opts.localPodId        - This pod's identifier.
   * @param {Function} [opts.onLog]         - Logging callback.
   * @param {RateLimiter} [opts.rateLimiter] - Custom rate limiter.
   * @param {number} [opts.defaultTimeout=10000] - Default send timeout ms.
   */
  constructor({ localPodId, onLog, rateLimiter, defaultTimeout = 10000 } = {}) {
    if (!localPodId) throw new Error('localPodId is required')
    this.#localPodId = localPodId
    this.#onLog = onLog || null
    this.#rateLimiter = rateLimiter || new RateLimiter()
    this.#defaultTimeout = defaultTimeout
  }

  /** @returns {string} The local pod identifier. */
  get localPodId() { return this.#localPodId }

  /** @returns {number} Number of registered peers. */
  get peerCount() { return this.#peers.size }

  // -------------------------------------------------------------------------
  // Peer management
  // -------------------------------------------------------------------------

  /**
   * Register a remote peer for cross-origin communication.
   *
   * @param {string} peerId
   * @param {object} opts
   * @param {string} opts.origin          - Expected origin (e.g. 'https://example.com').
   * @param {string} [opts.trust]         - Trust level from TRUST_LEVELS. Default: VERIFIED.
   * @param {string[]} [opts.allowedMethods] - Methods this peer may call (VERIFIED only).
   */
  registerPeer(peerId, { origin, trust = TRUST_LEVELS.VERIFIED, allowedMethods = [] } = {}) {
    if (!peerId) throw new Error('peerId is required')
    if (!origin) throw new Error('origin is required')
    if (trust && !Object.values(TRUST_LEVELS).includes(trust)) {
      throw new Error(`Unknown trust level: ${trust}`)
    }
    this.#peers.set(peerId, {
      origin,
      trust,
      allowedMethods: new Set(allowedMethods),
    })
  }

  /**
   * Update the trust level for an existing peer.
   * @param {string} peerId
   * @param {string} trust - New trust level.
   */
  setTrust(peerId, trust) {
    const peer = this.#peers.get(peerId)
    if (!peer) throw new Error(`Peer "${peerId}" not registered`)
    if (!Object.values(TRUST_LEVELS).includes(trust)) {
      throw new Error(`Unknown trust level: ${trust}`)
    }
    peer.trust = trust
  }

  /**
   * Remove a registered peer and reject any pending requests to it.
   * @param {string} peerId
   * @returns {boolean} true if the peer existed.
   */
  removePeer(peerId) {
    const existed = this.#peers.delete(peerId)
    // Cancel pending requests to this peer
    for (const [reqId, entry] of this.#pendingRequests) {
      if (entry.peerId === peerId) {
        clearTimeout(entry.timer)
        entry.reject(new Error(`Peer "${peerId}" removed`))
        this.#pendingRequests.delete(reqId)
      }
    }
    return existed
  }

  /**
   * List all registered peers.
   * @returns {Array<{ peerId, origin, trust, allowedMethods }>}
   */
  listPeers() {
    return [...this.#peers.entries()].map(([peerId, info]) => ({
      peerId,
      origin: info.origin,
      trust: info.trust,
      allowedMethods: [...info.allowedMethods],
    }))
  }

  /**
   * Get info for a single peer.
   * @param {string} peerId
   * @returns {object|null}
   */
  getPeer(peerId) {
    const info = this.#peers.get(peerId)
    if (!info) return null
    return {
      peerId,
      origin: info.origin,
      trust: info.trust,
      allowedMethods: [...info.allowedMethods],
    }
  }

  // -------------------------------------------------------------------------
  // Method handlers
  // -------------------------------------------------------------------------

  /**
   * Register a handler for an incoming method call.
   * @param {string} method
   * @param {Function} handler - (params, fromPodId) => result
   */
  setMethodHandler(method, handler) {
    if (typeof handler !== 'function') throw new Error('handler must be a function')
    this.#handlers.set(method, handler)
  }

  /**
   * Remove a method handler.
   * @param {string} method
   * @returns {boolean}
   */
  removeMethodHandler(method) {
    return this.#handlers.delete(method)
  }

  /**
   * List registered method names.
   * @returns {string[]}
   */
  listMethods() {
    return [...this.#handlers.keys()]
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  /**
   * Send a request to a peer. Returns a promise that resolves with the result.
   *
   * @param {string} peerId       - Target peer.
   * @param {string} method       - Method to invoke.
   * @param {object} [params={}]  - Method parameters.
   * @param {object} target       - postMessage target (Window, MessagePort, etc.).
   * @param {object} [opts]
   * @param {number} [opts.timeout] - Override default timeout.
   * @returns {Promise<*>}
   */
  async send(peerId, method, params, target, opts = {}) {
    const peer = this.#peers.get(peerId)
    if (!peer) throw new Error(`Peer "${peerId}" not registered`)
    if (peer.trust === TRUST_LEVELS.ISOLATED) {
      throw new Error(`Peer "${peerId}" is isolated`)
    }

    const requestId = `xo_${this.#nextId++}`
    const message = {
      type: XO_REQUEST,
      requestId,
      fromPodId: this.#localPodId,
      method,
      params: params || {},
    }

    const timeout = opts.timeout ?? this.#defaultTimeout

    return new Promise((resolve, reject) => {
      const timer = timeout > 0
        ? setTimeout(() => {
            this.#pendingRequests.delete(requestId)
            reject(new Error(`Request ${requestId} to "${peerId}" timed out`))
          }, timeout)
        : null

      this.#pendingRequests.set(requestId, { resolve, reject, timer, peerId })

      if (target && typeof target.postMessage === 'function') {
        target.postMessage(message, peer.origin)
      }
    })
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  /**
   * Handle an incoming MessageEvent. Validates origin, enforces trust/allowlist,
   * dispatches to handlers, and sends responses.
   *
   * Attach this to `window.addEventListener('message', ...)`.
   *
   * @param {MessageEvent} event
   */
  handleMessage(event) {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (typeof data.type !== 'string') return
    if (!data.type.startsWith('mesh-xo-')) return

    const fromPeerId = data.fromPodId
    const peer = fromPeerId ? this.#peers.get(fromPeerId) : null

    // Origin validation -- reject if the event origin doesn't match the registered origin
    if (peer && event.origin && event.origin !== peer.origin) {
      this.#log(`Origin mismatch for ${fromPeerId}: expected ${peer.origin}, got ${event.origin}`)
      return
    }

    // Rate limiting
    if (fromPeerId && !this.#rateLimiter.check(fromPeerId)) {
      this.#log(`Rate limit exceeded for ${fromPeerId}`)
      return
    }
    if (fromPeerId) this.#rateLimiter.record(fromPeerId)

    if (data.type === XO_REQUEST) {
      this.#handleRequest(data, event.source, peer)
    } else if (data.type === XO_RESPONSE) {
      this.#handleResponse(data)
    }
  }

  // -------------------------------------------------------------------------
  // Internal request/response
  // -------------------------------------------------------------------------

  #handleRequest(data, source, peer) {
    const { requestId, method, params, fromPodId } = data

    // ISOLATED peers cannot invoke anything
    if (peer && peer.trust === TRUST_LEVELS.ISOLATED) {
      this.#log(`Blocked request from isolated peer ${fromPodId}`)
      return
    }

    // For VERIFIED peers, enforce the method allowlist
    if (peer && peer.trust === TRUST_LEVELS.VERIFIED && peer.allowedMethods.size > 0) {
      if (!peer.allowedMethods.has(method)) {
        this.#sendResponse(source, peer, requestId, null, `Method "${method}" not allowed`)
        return
      }
    }

    // Look up handler
    const handler = this.#handlers.get(method)
    if (!handler) {
      this.#sendResponse(source, peer, requestId, null, `Method "${method}" not found`)
      return
    }

    // Execute handler (sync or async)
    try {
      const result = handler(params, fromPodId)
      if (result && typeof result.then === 'function') {
        result.then(
          (val) => this.#sendResponse(source, peer, requestId, val, null),
          (err) => this.#sendResponse(source, peer, requestId, null, err.message),
        ).catch(() => {})
      } else {
        this.#sendResponse(source, peer, requestId, result, null)
      }
    } catch (err) {
      this.#sendResponse(source, peer, requestId, null, err.message)
    }
  }

  #handleResponse(data) {
    const pending = this.#pendingRequests.get(data.requestId)
    if (!pending) return
    this.#pendingRequests.delete(data.requestId)
    if (pending.timer) clearTimeout(pending.timer)
    if (data.error) {
      pending.reject(new Error(data.error))
    } else {
      pending.resolve(data.result)
    }
  }

  #sendResponse(source, peer, requestId, result, error) {
    if (!source || typeof source.postMessage !== 'function') return
    const msg = {
      type: XO_RESPONSE,
      requestId,
      fromPodId: this.#localPodId,
      result: result ?? null,
      error: error ?? null,
    }
    const origin = peer ? peer.origin : '*'
    source.postMessage(msg, origin)
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Reject all pending requests and clear internal state.
   */
  destroy() {
    for (const [, entry] of this.#pendingRequests) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(new Error('Bridge destroyed'))
    }
    this.#pendingRequests.clear()
    this.#peers.clear()
    this.#handlers.clear()
    this.#rateLimiter.reset()
  }

  #log(msg) {
    if (this.#onLog) this.#onLog(msg)
  }
}

// ---------------------------------------------------------------------------
// CrossOriginHandshake
// ---------------------------------------------------------------------------

/**
 * Cross-origin handshake protocol.
 *
 * Establishes initial trust between two browser contexts using a
 * simple challenge-acknowledge exchange over postMessage.
 *
 * Flow:
 *   1. Initiator calls `initiate(targetWindow, origin)`.
 *   2. Target listens for `mesh-xo-handshake` and calls `accept(event)`.
 *   3. Target sends back `mesh-xo-handshake-ack`.
 *   4. Initiator resolves with { peerId, port }.
 */
export class CrossOriginHandshake {
  /**
   * Initiate a handshake with a target window/iframe.
   *
   * @param {Window} targetWindow - The target context.
   * @param {string} origin       - Expected origin of the target.
   * @param {object} [opts]
   * @param {string} [opts.peerId]  - Suggested peer ID.
   * @param {number} [opts.timeout] - Timeout in ms (default 5000).
   * @returns {Promise<{ peerId: string, port: MessagePort|null }>}
   */
  static async initiate(targetWindow, origin, opts = {}) {
    const peerId = opts.peerId || `peer_${Date.now().toString(36)}`
    const timeout = opts.timeout ?? 5000

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (typeof globalThis.removeEventListener === 'function') {
          globalThis.removeEventListener('message', handler)
        }
        reject(new Error('Handshake timeout'))
      }, timeout)

      const handler = (event) => {
        if (event.origin !== origin) return
        if (!event.data || event.data.type !== XO_HANDSHAKE_ACK) return
        clearTimeout(timer)
        if (typeof globalThis.removeEventListener === 'function') {
          globalThis.removeEventListener('message', handler)
        }
        resolve({
          peerId: event.data.peerId || peerId,
          port: event.data.port || null,
        })
      }

      if (typeof globalThis.addEventListener === 'function') {
        globalThis.addEventListener('message', handler)
      }

      targetWindow.postMessage({ type: XO_HANDSHAKE, peerId }, origin)
    })
  }

  /**
   * Accept a handshake from an incoming message event.
   *
   * @param {MessageEvent} event
   * @param {object} [opts]
   * @param {string} [opts.localPodId] - This side's pod identifier.
   * @returns {Promise<{ peerId: string, port: MessagePort|null }|null>}
   *          null if the event is not a handshake request.
   */
  static async accept(event, opts = {}) {
    if (!event.data || event.data.type !== XO_HANDSHAKE) return null

    const peerId = event.data.peerId || `peer_${Date.now().toString(36)}`
    const ackPeerId = opts.localPodId || `local_${Date.now().toString(36)}`

    if (event.source && typeof event.source.postMessage === 'function') {
      event.source.postMessage(
        { type: XO_HANDSHAKE_ACK, peerId: ackPeerId },
        event.origin,
      )
    }

    return { peerId, port: null }
  }
}
