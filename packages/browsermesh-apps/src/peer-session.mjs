import { silentCatch } from './silent-catch.mjs'
/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-peer-session.js -- Authenticated peer session management.
 *
 * Manages authenticated sessions between mesh peers, providing message
 * routing to service handlers, heartbeat detection, rate limiting, and
 * audit logging.
 *
 * - PeerSession: single authenticated connection to a remote peer
 * - SessionManager: lifecycle management for all active sessions
 * - SessionProtocol: constants and envelope helpers
 *
 * Dependencies are injected (MeshACL, AuditChain, transport).
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-session.test.mjs
 */

// ---------------------------------------------------------------------------
// SessionProtocol — constants and envelope helpers
// ---------------------------------------------------------------------------

/** Standard message types for peer sessions. */
export const SESSION_MSG_TYPES = Object.freeze({
  CHAT: 'chat',
  TERMINAL: 'terminal',
  FILES: 'files',
  AGENT: 'agent',
  PING: 'ping',
  PONG: 'pong',
  ERROR: 'error',
})

/**
 * Create a message envelope for sending over a session transport.
 *
 * @param {string} type - One of SESSION_MSG_TYPES or custom service type
 * @param {*} payload - Message payload
 * @param {string} sessionId - Session identifier
 * @param {string} fromPodId - Sender pod ID
 * @returns {{ type: string, payload: *, sessionId: string, from: string, timestamp: number }}
 */
export function createEnvelope(type, payload, sessionId, fromPodId) {
  return {
    type,
    payload,
    sessionId,
    from: fromPodId,
    timestamp: Date.now(),
  }
}

/**
 * Parse and validate an incoming message envelope.
 *
 * @param {*} data - Raw data from transport (object or JSON string)
 * @returns {{ type: string, payload: *, sessionId: string, from: string, timestamp: number }|null}
 */
export function parseEnvelope(data) {
  try {
    const envelope = typeof data === 'string' ? JSON.parse(data) : data
    if (
      !envelope ||
      typeof envelope !== 'object' ||
      typeof envelope.type !== 'string' ||
      typeof envelope.sessionId !== 'string' ||
      typeof envelope.from !== 'string' ||
      typeof envelope.timestamp !== 'number'
    ) {
      return null
    }
    return {
      type: envelope.type,
      payload: envelope.payload,
      sessionId: envelope.sessionId,
      from: envelope.from,
      timestamp: envelope.timestamp,
    }
  } catch {
    return null
  }
}

/**
 * Create an error envelope for reporting errors to a remote peer.
 *
 * @param {string} sessionId - Session identifier
 * @param {string} fromPodId - Sender pod ID
 * @param {string} error - Error message
 * @param {string} [code='UNKNOWN'] - Error code
 * @returns {object}
 */
export function createErrorEnvelope(sessionId, fromPodId, error, code = 'UNKNOWN') {
  return createEnvelope(SESSION_MSG_TYPES.ERROR, { error, code }, sessionId, fromPodId)
}

// ---------------------------------------------------------------------------
// Session ID generator
// ---------------------------------------------------------------------------

let _sessionSeq = 0

/**
 * Generate a unique session identifier.
 * @returns {string}
 */
function generateSessionId() {
  return `sess_${Date.now().toString(36)}_${(++_sessionSeq).toString(36)}`
}

// ---------------------------------------------------------------------------
// PeerSession
// ---------------------------------------------------------------------------

/**
 * Represents an authenticated connection to a single remote peer.
 *
 * Provides message routing to registered service handlers, heartbeat
 * keep-alive, capability checking, and per-session statistics.
 */
export class PeerSession {
  /** @type {string} */
  #sessionId

  /** @type {{ podId: string }} */
  #localIdentity

  /** @type {{ podId: string, publicKey?: string }} */
  #remoteIdentity

  /** @type {string[]} */
  #capabilities

  /** @type {object} transport with send(data) and onMessage(cb) */
  #transport

  /** @type {Map<string, Function>} service type -> async handler(message, session) */
  #handlers = new Map()

  /** @type {'active'|'suspended'|'closed'} */
  #state = 'active'

  /** @type {number} */
  #createdAt

  /** @type {number} */
  #lastActivity

  /** @type {*} timer ID */
  #heartbeatInterval = null

  /** @type {number} ms before declaring peer dead */
  #heartbeatTimeoutMs

  /** @type {*} timer ID for heartbeat timeout */
  #heartbeatTimer = null

  /** @type {Function} */
  #onLog

  /** @type {{ messagesSent: number, messagesReceived: number, errors: number }} */
  #stats = { messagesSent: 0, messagesReceived: 0, errors: 0 }

  /** @type {Function} bound message handler reference for cleanup */
  #boundMessageHandler

  /**
   * @param {object} opts
   * @param {string} opts.sessionId - Unique session identifier
   * @param {{ podId: string }} opts.localIdentity - Local identity
   * @param {{ podId: string, publicKey?: string }} opts.remoteIdentity - Remote identity
   * @param {string[]} opts.capabilities - What the remote peer is allowed to do
   * @param {object} opts.transport - Transport with send(data) and onMessage(cb)
   * @param {number} [opts.heartbeatTimeoutMs=60000] - Heartbeat timeout
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor({
    sessionId,
    localIdentity,
    remoteIdentity,
    capabilities,
    transport,
    heartbeatTimeoutMs = 60000,
    onLog,
  }) {
    if (!sessionId || typeof sessionId !== 'string') {
      throw new Error('sessionId is required and must be a non-empty string')
    }
    if (!localIdentity || !localIdentity.podId) {
      throw new Error('localIdentity with podId is required')
    }
    if (!remoteIdentity || !remoteIdentity.podId) {
      throw new Error('remoteIdentity with podId is required')
    }
    if (!transport || typeof transport.send !== 'function') {
      throw new Error('transport with send() method is required')
    }

    this.#sessionId = sessionId
    this.#localIdentity = localIdentity
    this.#remoteIdentity = remoteIdentity
    this.#capabilities = Array.isArray(capabilities) ? [...capabilities] : []
    this.#transport = transport
    this.#heartbeatTimeoutMs = heartbeatTimeoutMs
    this.#onLog = onLog || (() => {})
    this.#createdAt = Date.now()
    this.#lastActivity = Date.now()

    // Wire up transport message handler
    this.#boundMessageHandler = (data) => this.#handleMessage(data)
    if (typeof transport.onMessage === 'function') {
      transport.onMessage(this.#boundMessageHandler)
    }
  }

  // -- Properties -----------------------------------------------------------

  /** @returns {string} */
  get sessionId() { return this.#sessionId }

  /** @returns {string} */
  get localPodId() { return this.#localIdentity.podId }

  /** @returns {string} */
  get remotePodId() { return this.#remoteIdentity.podId }

  /** @returns {string[]} Copy of capabilities array. */
  get capabilities() { return [...this.#capabilities] }

  /** @returns {'active'|'suspended'|'closed'} */
  get state() { return this.#state }

  /** @returns {number} */
  get createdAt() { return this.#createdAt }

  /** @returns {number} */
  get lastActivity() { return this.#lastActivity }

  /** @returns {{ messagesSent: number, messagesReceived: number, errors: number }} */
  get stats() { return { ...this.#stats } }

  // -- Capability checking --------------------------------------------------

  /**
   * Check whether the remote peer has a given capability scope.
   *
   * @param {string} scope - Capability scope string
   * @returns {boolean}
   */
  hasCapability(scope) {
    return this.#capabilities.includes(scope) || this.#capabilities.includes('*')
  }

  /**
   * Require a capability, throwing if the remote peer does not have it.
   *
   * @param {string} scope - Capability scope string
   * @throws {Error} If capability is not granted
   */
  requireCapability(scope) {
    if (!this.hasCapability(scope)) {
      throw new Error(`Capability "${scope}" not granted for session ${this.#sessionId}`)
    }
  }

  // -- Message handling -----------------------------------------------------

  /**
   * Register a handler for a service type.
   * Handler signature: async (message, session) => response
   *
   * @param {string} serviceType - Service type string
   * @param {Function} handler - Async handler function
   */
  registerHandler(serviceType, handler) {
    if (typeof handler !== 'function') {
      throw new Error('handler must be a function')
    }
    this.#handlers.set(serviceType, handler)
  }

  /**
   * Remove a handler for a service type.
   *
   * @param {string} serviceType - Service type string
   */
  removeHandler(serviceType) {
    this.#handlers.delete(serviceType)
  }

  /**
   * Send a message to the remote peer.
   * Wraps the payload in a session envelope and transmits via transport.
   *
   * @param {string} serviceType - Message type / service type
   * @param {*} payload - Message payload
   */
  send(serviceType, payload) {
    if (this.#state === 'closed') {
      throw new Error('Cannot send on a closed session')
    }
    if (this.#state === 'suspended') {
      throw new Error('Cannot send on a suspended session')
    }

    const envelope = createEnvelope(
      serviceType,
      payload,
      this.#sessionId,
      this.#localIdentity.podId,
    )

    this.#transport.send(envelope)
    this.#stats.messagesSent++
    this.#lastActivity = Date.now()
  }

  /**
   * Handle an incoming message from the transport.
   * Validates the envelope, routes to the appropriate handler, and
   * tracks statistics.
   *
   * @param {*} data - Raw message data
   */
  #handleMessage(data) {
    if (this.#state === 'closed') return

    const envelope = parseEnvelope(data)
    if (!envelope) {
      this.#stats.errors++
      this.#onLog(1, `Invalid envelope on session ${this.#sessionId}`)
      return
    }

    // Validate session ID matches
    if (envelope.sessionId !== this.#sessionId) {
      this.#stats.errors++
      return
    }

    // Validate sender matches expected remote identity
    if (envelope.from && this.#remoteIdentity?.podId &&
        envelope.from !== this.#remoteIdentity.podId) {
      this.#stats.errors++
      this.#onLog(1, `Sender mismatch on session ${this.#sessionId}: expected ${this.#remoteIdentity.podId}, got ${envelope.from}`)
      return
    }

    this.#lastActivity = Date.now()
    this.#stats.messagesReceived++

    // Handle built-in ping/pong
    if (envelope.type === SESSION_MSG_TYPES.PING) {
      this.#handlePing(envelope)
      return
    }
    if (envelope.type === SESSION_MSG_TYPES.PONG) {
      this.#handlePong()
      return
    }

    // Route to registered handler
    const handler = this.#handlers.get(envelope.type)
    if (!handler) {
      this.#onLog(1, `No handler for type "${envelope.type}" on session ${this.#sessionId}`)
      return
    }

    try {
      const result = handler(envelope, this)
      // If handler returns a promise, catch rejections
      if (result && typeof result.catch === 'function') {
        result.catch((err) => {
          this.#stats.errors++
          this.#onLog(0, `Handler error for "${envelope.type}": ${err.message}`)
        })
      }
    } catch (err) {
      this.#stats.errors++
      this.#onLog(0, `Handler error for "${envelope.type}": ${err.message}`)
    }
  }

  /**
   * Respond to a ping with a pong.
   * @param {object} envelope - Incoming ping envelope
   */
  #handlePing(envelope) {
    if (this.#state !== 'active') return
    const pong = createEnvelope(
      SESSION_MSG_TYPES.PONG,
      { replyTo: envelope.timestamp },
      this.#sessionId,
      this.#localIdentity.podId,
    )
    try {
      this.#transport.send(pong)
    } catch (e) { silentCatch('clawser-peer-session', 'swallow-send-errors-on-pong', e) }
  }

  /**
   * Handle an incoming pong — reset the heartbeat timeout timer.
   */
  #handlePong() {
    // Reset heartbeat timeout since we got a response
    if (this.#heartbeatTimer) {
      clearTimeout(this.#heartbeatTimer)
      this.#heartbeatTimer = null
    }
  }

  // -- Heartbeat ------------------------------------------------------------

  /**
   * Start sending periodic heartbeat pings.
   * If no pong is received within heartbeatTimeoutMs, the session is suspended.
   *
   * @param {number} [intervalMs=15000] - Interval between pings
   */
  startHeartbeat(intervalMs = 15000) {
    this.stopHeartbeat()
    if (this.#state !== 'active') return

    this.#heartbeatInterval = setInterval(() => {
      if (this.#state !== 'active') {
        this.stopHeartbeat()
        return
      }

      // Send ping
      const ping = createEnvelope(
        SESSION_MSG_TYPES.PING,
        null,
        this.#sessionId,
        this.#localIdentity.podId,
      )
      try {
        this.#transport.send(ping)
      } catch {
        this.suspend()
        return
      }

      // Set timeout for pong response
      if (this.#heartbeatTimer) clearTimeout(this.#heartbeatTimer)
      this.#heartbeatTimer = setTimeout(() => {
        if (this.#state === 'active') {
          this.#onLog(1, `Heartbeat timeout for session ${this.#sessionId}, suspending`)
          this.suspend()
        }
      }, this.#heartbeatTimeoutMs)
    }, intervalMs)
  }

  /**
   * Stop heartbeat pinging and clear timers.
   */
  stopHeartbeat() {
    if (this.#heartbeatInterval) {
      clearInterval(this.#heartbeatInterval)
      this.#heartbeatInterval = null
    }
    if (this.#heartbeatTimer) {
      clearTimeout(this.#heartbeatTimer)
      this.#heartbeatTimer = null
    }
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Suspend the session. Can be resumed later.
   */
  suspend() {
    if (this.#state === 'closed') return
    this.#state = 'suspended'
    this.stopHeartbeat()
    this.#onLog(2, `Session ${this.#sessionId} suspended`)
  }

  /**
   * Resume a suspended session.
   */
  resume() {
    if (this.#state !== 'suspended') {
      throw new Error(`Cannot resume session in state "${this.#state}"`)
    }
    this.#state = 'active'
    this.#lastActivity = Date.now()
    this.#onLog(2, `Session ${this.#sessionId} resumed`)
  }

  /**
   * Close the session permanently. Stops heartbeat and cleans up.
   */
  close() {
    if (this.#state === 'closed') return
    this.stopHeartbeat()
    this.#state = 'closed'
    this.#handlers.clear()
    this.#onLog(2, `Session ${this.#sessionId} closed`)
  }

  // -- Serialization --------------------------------------------------------

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      sessionId: this.#sessionId,
      localPodId: this.#localIdentity.podId,
      remotePodId: this.#remoteIdentity.podId,
      remotePublicKey: this.#remoteIdentity.publicKey || null,
      capabilities: [...this.#capabilities],
      state: this.#state,
      createdAt: this.#createdAt,
      lastActivity: this.#lastActivity,
      stats: { ...this.#stats },
    }
  }
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

/**
 * Manages lifecycle for all active peer sessions.
 *
 * Provides session creation with rate limiting, access control via ACL,
 * audit logging, and periodic pruning of inactive sessions.
 */
export class SessionManager {
  /** @type {Map<string, PeerSession>} sessionId -> PeerSession */
  #sessions = new Map()

  /** @type {Map<string, Set<string>>} remotePodId -> Set<sessionId> */
  #peerSessions = new Map()

  /** @type {object|null} MeshACL or duck-typed */
  #acl

  /** @type {object|null} AuditChain or duck-typed */
  #auditLog

  /** @type {string} */
  #localPodId

  /** @type {{ maxSessionsPerPeer: number, maxMessagesPerMinute: number }} */
  #rateLimits

  /** @type {Map<string, { count: number, resetAt: number }>} sessionId -> counter */
  #messageCounters = new Map()

  /** @type {Function} */
  #onLog

  /** @type {Map<string, Set<Function>>} event -> listeners */
  #listeners = new Map()

  /**
   * @param {object} opts
   * @param {string} opts.localPodId - Local pod identifier
   * @param {object} [opts.acl] - MeshACL instance or duck-typed { check(identity, resource, action) }
   * @param {object} [opts.auditLog] - AuditChain instance or duck-typed { append(author, op, data, signFn) }
   * @param {{ maxSessionsPerPeer?: number, maxMessagesPerMinute?: number }} [opts.rateLimits]
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor({ localPodId, acl, auditLog, rateLimits, onLog }) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string')
    }
    this.#localPodId = localPodId
    this.#acl = acl || null
    this.#auditLog = auditLog || null
    this.#rateLimits = {
      maxSessionsPerPeer: rateLimits?.maxSessionsPerPeer ?? 5,
      maxMessagesPerMinute: rateLimits?.maxMessagesPerMinute ?? 120,
    }
    this.#onLog = onLog || (() => {})
  }

  // -- Session lifecycle ----------------------------------------------------

  /**
   * Create a new session with a remote peer.
   *
   * Checks per-peer session limits, creates a PeerSession, starts
   * heartbeat, logs to audit, and emits 'session:create'.
   *
   * @param {string} peerId - Remote peer pod ID
   * @param {object} transport - Transport with send(data) and onMessage(cb)
   * @param {string[]} capabilities - Capabilities granted to the remote peer
   * @returns {PeerSession}
   */
  createSession(peerId, transport, capabilities) {
    // Check per-peer session limit
    const existing = this.#peerSessions.get(peerId)
    const currentCount = existing ? existing.size : 0
    if (currentCount >= this.#rateLimits.maxSessionsPerPeer) {
      throw new Error(
        `Session limit reached for peer ${peerId}: ${currentCount}/${this.#rateLimits.maxSessionsPerPeer}`,
      )
    }

    const sessionId = generateSessionId()
    const session = new PeerSession({
      sessionId,
      localIdentity: { podId: this.#localPodId },
      remoteIdentity: { podId: peerId },
      capabilities,
      transport,
      onLog: this.#onLog,
    })

    // Register in maps
    this.#sessions.set(sessionId, session)
    if (!this.#peerSessions.has(peerId)) {
      this.#peerSessions.set(peerId, new Set())
    }
    this.#peerSessions.get(peerId).add(sessionId)

    // Initialize rate limit counter
    this.#messageCounters.set(sessionId, {
      count: 0,
      resetAt: Date.now() + 60000,
    })

    // Start heartbeat
    session.startHeartbeat()

    // Audit log
    this.logSessionAction(sessionId, 'session:create', {
      peerId,
      capabilities,
    })

    // Emit event
    this.#fire('session:create', session)

    this.#onLog(2, `Session ${sessionId} created with peer ${peerId}`)
    return session
  }

  /**
   * End a session by ID. Closes the PeerSession, removes from all maps,
   * logs to audit, and emits 'session:end'.
   *
   * @param {string} sessionId - Session to end
   */
  endSession(sessionId) {
    const session = this.#sessions.get(sessionId)
    if (!session) return

    const peerId = session.remotePodId
    session.close()

    // Remove from maps
    this.#sessions.delete(sessionId)
    const peerSet = this.#peerSessions.get(peerId)
    if (peerSet) {
      peerSet.delete(sessionId)
      if (peerSet.size === 0) this.#peerSessions.delete(peerId)
    }
    this.#messageCounters.delete(sessionId)

    // Audit log
    this.logSessionAction(sessionId, 'session:end', { peerId })

    // Emit event
    this.#fire('session:end', session)

    this.#onLog(2, `Session ${sessionId} ended with peer ${peerId}`)
  }

  // -- Session queries ------------------------------------------------------

  /**
   * Get a session by its ID.
   *
   * @param {string} sessionId
   * @returns {PeerSession|null}
   */
  getSession(sessionId) {
    return this.#sessions.get(sessionId) || null
  }

  /**
   * Get all sessions for a given remote peer.
   *
   * @param {string} remotePodId
   * @returns {PeerSession[]}
   */
  getSessionsForPeer(remotePodId) {
    const ids = this.#peerSessions.get(remotePodId)
    if (!ids) return []
    return [...ids]
      .map((id) => this.#sessions.get(id))
      .filter(Boolean)
  }

  /**
   * List all active sessions.
   *
   * @returns {PeerSession[]}
   */
  listSessions() {
    return [...this.#sessions.values()]
  }

  /**
   * Number of active sessions.
   * @returns {number}
   */
  get size() {
    return this.#sessions.size
  }

  // -- Access control -------------------------------------------------------

  /**
   * Check whether a remote peer is allowed to perform an action on a resource.
   * Delegates to the ACL if available; otherwise allows all.
   *
   * @param {string} remotePodId - Remote peer pod ID
   * @param {string} resource - Resource identifier
   * @param {string} action - Action to check
   * @returns {{ allowed: boolean, reason?: string }}
   */
  checkAccess(remotePodId, resource, action) {
    if (!this.#acl) {
      return { allowed: true }
    }
    return this.#acl.check(remotePodId, resource, action)
  }

  // -- Rate limiting --------------------------------------------------------

  /**
   * Check whether a session is within its message rate limit.
   *
   * @param {string} sessionId
   * @returns {{ allowed: boolean, remaining: number }}
   */
  checkRateLimit(sessionId) {
    const counter = this.#messageCounters.get(sessionId)
    if (!counter) {
      return { allowed: false, remaining: 0 }
    }

    const now = Date.now()
    // Reset window if expired
    if (now >= counter.resetAt) {
      counter.count = 0
      counter.resetAt = now + 60000
    }

    const remaining = this.#rateLimits.maxMessagesPerMinute - counter.count
    return {
      allowed: remaining > 0,
      remaining: Math.max(0, remaining),
    }
  }

  /**
   * Record a message sent/received on a session for rate limiting.
   *
   * @param {string} sessionId
   */
  recordMessage(sessionId) {
    const counter = this.#messageCounters.get(sessionId)
    if (!counter) return

    const now = Date.now()
    // Reset window if expired
    if (now >= counter.resetAt) {
      counter.count = 0
      counter.resetAt = now + 60000
    }

    counter.count++
  }

  // -- Events ---------------------------------------------------------------

  /**
   * Register a listener for session events.
   * Events: 'session:create', 'session:end', 'session:error'
   *
   * @param {string} event
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set())
    }
    this.#listeners.get(event).add(cb)
  }

  /**
   * Remove a listener for a session event.
   *
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const set = this.#listeners.get(event)
    if (set) set.delete(cb)
  }

  // -- Audit ----------------------------------------------------------------

  /**
   * Log a session action to the audit chain (if available).
   * Silently no-ops if no audit log is configured.
   *
   * @param {string} sessionId - Session identifier
   * @param {string} action - Action name
   * @param {object} [details] - Additional details
   * @param {*} [result] - Action result
   */
  async logSessionAction(sessionId, action, details, result) {
    if (!this.#auditLog) return

    const data = {
      sessionId,
      action,
      details: details || {},
      result: result || null,
      timestamp: Date.now(),
    }

    try {
      // AuditChain.append(authorPodId, operation, data, signFn)
      // Use a no-op sign function if audit log is duck-typed
      await this.#auditLog.append(
        this.#localPodId,
        action,
        data,
        async (bytes) => bytes, // placeholder signFn
      )
    } catch (err) {
      this.#onLog(0, `Audit log error: ${err.message}`)
    }
  }

  // -- Cleanup --------------------------------------------------------------

  /**
   * Close all active sessions.
   */
  closeAll() {
    for (const sessionId of [...this.#sessions.keys()]) {
      this.endSession(sessionId)
    }
  }

  /**
   * Prune sessions that have been idle longer than the threshold.
   *
   * @param {number} [maxIdleMs=300000] - Maximum idle time in ms (default 5 min)
   * @returns {number} Number of sessions pruned
   */
  pruneInactive(maxIdleMs = 300000) {
    const now = Date.now()
    let pruned = 0

    for (const [sessionId, session] of this.#sessions) {
      if (now - session.lastActivity >= maxIdleMs) {
        this.endSession(sessionId)
        pruned++
      }
    }

    if (pruned > 0) {
      this.#onLog(2, `Pruned ${pruned} inactive session(s)`)
    }
    return pruned
  }

  // -- Serialization --------------------------------------------------------

  /**
   * Serialize the session manager state.
   * @returns {object}
   */
  toJSON() {
    return {
      localPodId: this.#localPodId,
      sessions: [...this.#sessions.values()].map((s) => s.toJSON()),
      rateLimits: { ...this.#rateLimits },
    }
  }

  // -- Internal -------------------------------------------------------------

  /**
   * Fire all listeners for a given event, swallowing listener errors.
   * @param {string} event
   * @param {*} data
   */
  #fire(event, data) {
    const set = this.#listeners.get(event)
    if (!set) return
    for (const cb of [...set]) {
      try {
        cb(data)
      } catch {
        /* listener errors do not propagate */
      }
    }
  }
}
