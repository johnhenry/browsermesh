/**
// STATUS: EXPERIMENTAL — complete implementation, not yet integrated into main application
 * clawser-peer-chat.js -- P2P chat over peer sessions.
 *
 * Provides direct chat between two peers on top of PeerSession, with
 * message signing/verification and optional agent auto-response.
 *
 * Dependencies are injected (PeerSession, signing functions).
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-chat.test.mjs
 */

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _chatMsgSeq = 0

function generateChatMessageId() {
  return `cmsg_${Date.now().toString(36)}_${(++_chatMsgSeq).toString(36)}`
}

// ---------------------------------------------------------------------------
// Signature helpers
// ---------------------------------------------------------------------------

/**
 * Encode a Uint8Array to a base64 string.
 * Falls back to manual encoding when btoa is unavailable (Node tests).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  if (typeof btoa === 'function') {
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  }
  // Node.js fallback
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  throw new Error('No base64 encoder available')
}

/**
 * Decode a base64 string to a Uint8Array.
 *
 * @param {string} b64
 * @returns {Uint8Array}
 */
function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'))
  }
  throw new Error('No base64 decoder available')
}

// ---------------------------------------------------------------------------
// PeerChat
// ---------------------------------------------------------------------------

/**
 * P2P chat over a single PeerSession.
 *
 * Sends and receives chat messages on the 'chat' service type, with
 * optional cryptographic signing/verification and an auto-responder
 * hook for agent-driven replies.
 */
export class PeerChat {
  /** @type {object} PeerSession */
  #session

  /** @type {((data: Uint8Array) => Promise<Uint8Array>)|null} */
  #signFn

  /** @type {((pubKey: Uint8Array, data: Uint8Array, sig: Uint8Array) => Promise<boolean>)|null} */
  #verifyFn

  /** @type {Uint8Array|null} */
  #remotePubKey

  /** @type {Array<object>} ChatMessage objects */
  #messageHistory = []

  /** @type {number} */
  #maxHistory

  /** @type {((message: object) => Promise<string|null>)|null} */
  #autoResponder

  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map()

  /** @type {Function} */
  #onLog

  /**
   * @param {object} opts
   * @param {object} opts.session - PeerSession instance
   * @param {Function} [opts.signFn] - async (data: Uint8Array) => Uint8Array
   * @param {Function} [opts.verifyFn] - async (pubKey, data, sig) => boolean
   * @param {Uint8Array} [opts.remotePubKey] - Remote peer's public key
   * @param {number} [opts.maxHistory=1000] - Maximum messages to retain
   * @param {Function} [opts.autoResponder] - async (message) => string|null
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor({ session, signFn, verifyFn, remotePubKey, maxHistory, autoResponder, onLog }) {
    if (!session) {
      throw new Error('session is required')
    }

    this.#session = session
    this.#signFn = signFn || null
    this.#verifyFn = verifyFn || null
    this.#remotePubKey = remotePubKey || null
    this.#maxHistory = maxHistory ?? 1000
    this.#autoResponder = autoResponder || null
    this.#onLog = onLog || (() => {})

    // Register handler on session for 'chat' service type
    this.#session.registerHandler('chat', (envelope) => this.#handleIncoming(envelope))
  }

  // -- Sending --------------------------------------------------------------

  /**
   * Send a text message to the remote peer.
   *
   * Creates a ChatMessage envelope, optionally signs it, transmits via
   * the session, records in history, and emits 'message:sent'.
   *
   * @param {string} text - Message text
   * @param {object} [opts] - Options
   * @param {boolean} [opts.isAutoResponse] - Mark as auto-response to prevent loops
   * @returns {Promise<object>} The sent ChatMessage
   */
  async sendMessage(text, opts) {
    const message = {
      id: generateChatMessageId(),
      from: this.#session.localPodId,
      to: this.#session.remotePodId,
      text,
      timestamp: Date.now(),
    }
    if (opts?.isAutoResponse) {
      message.isAutoResponse = true
    }

    // Sign if signing function is available
    if (this.#signFn) {
      try {
        const data = new TextEncoder().encode(JSON.stringify({
          id: message.id,
          from: message.from,
          to: message.to,
          text: message.text,
          timestamp: message.timestamp,
        }))
        const sigBytes = await this.#signFn(data)
        message.signature = bytesToBase64(sigBytes)
      } catch (err) {
        this.#onLog(1, `Failed to sign message: ${err.message}`)
      }
    }

    // Send over session
    this.#session.send('chat', message)

    // Add to history
    this.#addToHistory(message)

    // Emit event
    this.#emit('message:sent', message)

    return message
  }

  // -- Typing indicators ----------------------------------------------------

  /**
   * Send a typing indicator to the remote peer.
   */
  sendTyping() {
    this.#session.send('chat', {
      type: 'typing',
      from: this.#session.localPodId,
    })
  }

  // -- Incoming handler (private) -------------------------------------------

  /**
   * Handle an incoming chat message from the session transport.
   *
   * Verifies signature if verification is available, adds to history,
   * emits the appropriate event, and triggers auto-response if configured.
   *
   * @param {object} envelope - Session envelope with payload
   */
  async #handleIncoming(envelope) {
    const payload = envelope.payload || envelope

    // Handle typing indicators
    if (payload.type === 'typing') {
      this.#emit('typing', { from: payload.from })
      return
    }

    // Validate required fields
    if (!payload.text || typeof payload.text !== 'string') {
      this.#onLog(1, 'Dropping incoming chat message with missing/invalid text')
      return
    }

    // Build chat message from payload
    const message = {
      id: payload.id || generateChatMessageId(),
      from: payload.from || 'unknown',
      to: payload.to || this.#session.localPodId,
      text: payload.text,
      timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
      signature: payload.signature || undefined,
    }

    // Verify signature if verify function and remote public key are available
    if (this.#verifyFn && this.#remotePubKey && message.signature) {
      try {
        const data = new TextEncoder().encode(JSON.stringify({
          id: message.id,
          from: message.from,
          to: message.to,
          text: message.text,
          timestamp: message.timestamp,
        }))
        const sigBytes = base64ToBytes(message.signature)
        message.verified = await this.#verifyFn(this.#remotePubKey, data, sigBytes)
      } catch (err) {
        this.#onLog(1, `Signature verification failed: ${err.message}`)
        message.verified = false
      }
    } else if (this.#verifyFn && this.#remotePubKey && !message.signature) {
      // Expected a signature but none was provided
      message.verified = false
    }

    // Add to history
    this.#addToHistory(message)

    // Emit event
    this.#emit('message:received', message)

    // Auto-respond if configured, but never auto-respond to auto-responses
    if (this.#autoResponder && !payload.isAutoResponse) {
      try {
        const reply = await this.#autoResponder(message)
        if (reply && typeof reply === 'string') {
          await this.sendMessage(reply, { isAutoResponse: true })
        }
      } catch (err) {
        this.#onLog(0, `Auto-responder error: ${err.message}`)
      }
    }
  }

  // -- History --------------------------------------------------------------

  /**
   * Get the full message history.
   *
   * @returns {object[]} Array of ChatMessage objects (copy)
   */
  getHistory() {
    return [...this.#messageHistory]
  }

  /**
   * Clear the message history.
   */
  clearHistory() {
    this.#messageHistory = []
  }

  /**
   * Add a message to history, enforcing the max history limit.
   *
   * @param {object} message - ChatMessage to add
   */
  #addToHistory(message) {
    this.#messageHistory.push(message)
    if (this.#messageHistory.length > this.#maxHistory) {
      this.#messageHistory = this.#messageHistory.slice(-this.#maxHistory)
    }
  }

  // -- Events ---------------------------------------------------------------

  /**
   * Register a listener for a chat event.
   * Events: 'message:sent', 'message:received', 'typing'
   *
   * @param {string} event - Event name
   * @param {Function} cb - Callback function
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set())
    }
    this.#listeners.get(event).add(cb)
  }

  /**
   * Remove a listener for a chat event.
   *
   * @param {string} event - Event name
   * @param {Function} cb - Callback function
   */
  off(event, cb) {
    const set = this.#listeners.get(event)
    if (set) set.delete(cb)
  }

  /**
   * Emit an event to all registered listeners.
   *
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  #emit(event, data) {
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

  // -- Cleanup --------------------------------------------------------------

  /**
   * Close the peer chat. Removes the handler from the session.
   */
  close() {
    this.#session.removeHandler('chat')
    this.#listeners.clear()
  }

  // -- Serialization --------------------------------------------------------

  /**
   * Serialize to a JSON-safe object.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      sessionId: this.#session.sessionId,
      localPodId: this.#session.localPodId,
      remotePodId: this.#session.remotePodId,
      messageCount: this.#messageHistory.length,
      maxHistory: this.#maxHistory,
      hasSignFn: !!this.#signFn,
      hasVerifyFn: !!this.#verifyFn,
      hasRemotePubKey: !!this.#remotePubKey,
      hasAutoResponder: !!this.#autoResponder,
      messages: this.#messageHistory.map(m => ({ ...m })),
    }
  }
}
