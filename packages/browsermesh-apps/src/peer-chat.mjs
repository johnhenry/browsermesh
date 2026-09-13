/**
 * peer-chat.mjs -- P2P chat as a `MeshService` (Phase 9 of the
 * browsermesh-app-layer-migration plan, issue #84).
 *
 * `PeerChat` used to require a live `PeerSession` instance
 * (`opts.session`), registering itself on that session's `'chat'` service
 * type (`session.registerHandler('chat', ...)`) and sending via
 * `session.send('chat', payload)`. Nothing in this repo ever constructs a
 * `PeerSession` (`SessionManager` is never instantiated outside its own
 * tests -- see issue #84's ground-truth grep), so `PeerChat` had no real
 * caller. This migration removes that dependency entirely: `PeerChat` now
 * talks over a caller-supplied `send(toPubKey, payload)` function and an
 * externally-driven `receiveEnvelope(fromPubKey, envelope)` method, and
 * `createChatService()` (below) wires those onto `ctx.sendTo()`/
 * `ctx.onIncomingData()` (`mesh-service.mjs`, Phase C's `attach()`/`ctx`
 * convention) -- the same "thin `MeshService` wrapper, not a rewrite of the
 * internal logic" pattern `mesh-timestamp.mjs`/`mesh-health.mjs` (Phase 1)
 * and `peer-routing.mjs` (Phase 2) already established.
 *
 * `PeerChat`'s actual chat logic -- message signing/verification, history
 * tracking, typing-indicator handling, the auto-responder hook -- is
 * UNCHANGED by this migration. Two necessary, transport-driven adaptations,
 * both documented here rather than left implicit:
 *
 *   1. **One `PeerChat` no longer means one fixed remote peer.** A
 *      `PeerSession` was inherently one-to-one (`session.localPodId`/
 *      `session.remotePodId` fixed at session-creation time), so the old
 *      `sendMessage(text, opts)`/`sendTyping()` needed no target argument.
 *      A `MeshService` is attached ONCE per node and can talk to every
 *      connected peer, so `sendMessage()`/`sendTyping()` now take an
 *      explicit `toPubKey` first argument, and history is one flat,
 *      service-wide log (each message's own `from`/`to` fields -- already
 *      part of the message shape -- distinguish which conversation a given
 *      entry belongs to; a caller wanting a single thread filters
 *      client-side). This is the multi-peer generalization of the old
 *      one-remote-per-session model, not a redesign of what a `ChatMessage`
 *      looks like or how history accumulates.
 *
 *   2. **Signature verification now keys off the actual sender's pubKey,
 *      not one fixed constructor-time `remotePubKey`.** The old
 *      constructor accepted a separate, fixed `opts.remotePubKey` (raw
 *      Ed25519 public key bytes) used only by `verifyFn`. With no single
 *      bound remote peer left, `receiveEnvelope()` instead passes the
 *      message's real, per-message `fromPubKey` (the routing fingerprint
 *      `ctx.onIncomingData()` hands every subscriber, matching every other
 *      `MeshService` in this family) as `verifyFn`'s first argument.
 *      `verifyFn` is an entirely caller-injected, duck-typed dependency --
 *      it always was -- so this only changes WHAT gets passed as its first
 *      argument, not whether verification happens or how. Resolving a
 *      routing fingerprint to raw public key bytes (if a caller's
 *      `verifyFn` needs that distinction) is left to the caller, exactly
 *      the same "podId -> pubkey directory is a real, separate piece of
 *      design, out of scope for a thin wrapper" stance `mesh-timestamp.mjs`
 *      already takes for its own `identity.verify()`.
 *
 *   3. **The typing-indicator discriminator moved from `payload.type` to
 *      `payload.kind`.** The old wire shape reused the session envelope's
 *      OWN `type` field (`'chat'`) for routing and a SEPARATE, unrelated
 *      `payload.type: 'typing'` field nested one level deeper
 *      (`session.send('chat', {type: 'typing', ...})` wrapped that payload
 *      inside `{type: 'chat', payload: {...}, ...}` -- no collision).
 *      `ctx.sendTo(pubKey, type, payload)` instead merges flat:
 *      `{type, ...payload}` (`mesh-service.mjs`) -- if `payload` also had a
 *      `type` field, spreading it would silently overwrite the outer
 *      `'chat'` envelope type with `'typing'`, breaking
 *      `ctx.onIncomingData('chat', ...)`'s own filtering. `kind` is this
 *      family's established name for exactly this "sub-message discriminator
 *      distinct from the envelope's own routing `type`" concept (see
 *      `mesh-websocket.mjs`'s `kind: 'ws-open'|'ws-message'|...` and
 *      `mesh-rpc.mjs`'s `kind: 'rpc-request'|'rpc-response'`), so this file
 *      adopts it too rather than inventing a third name for the same idea.
 *
 * Everything else -- message id generation, base64 signature encoding,
 * `#addToHistory()`'s cap-at-`maxHistory` behavior, the auto-responder's
 * "never reply to an auto-response" guard, `on`/`off`'s listener-error
 * isolation -- is copied over unchanged.
 *
 * `createChatService()`'s own contribution is intentionally small: it
 * constructs ONE `PeerChat` per `attach()` call, wires its `send` onto
 * `ctx.sendTo(toPubKey, 'chat', payload)`, routes every inbound `'chat'`-typed
 * envelope (`ctx.onIncomingData('chat', ...)`) to `chat.receiveEnvelope()`,
 * and bridges `PeerChat`'s own `on('message:sent'|'message:received'|
 * 'typing', ...)` events through `ctx.emit()` under the
 * `chat:message-sent`/`chat:message-received`/`chat:typing` names (this
 * family's `<service>:<kebab-description>` observability convention -- see
 * `mesh-service.mjs`'s module doc comment). `PeerChat`'s own `on`/`off`
 * stay fully functional too (nothing here removes them) -- `ctx.emit()` is
 * an ADDITIONAL, curated broadcast of the same moments, not a replacement.
 *
 * Run tests:
 *   node --test packages/browsermesh-apps/test/peer-chat.test.mjs
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
 * P2P chat, transport-agnostic beyond a caller-supplied `send()` function.
 *
 * Sends and receives chat messages, with optional cryptographic
 * signing/verification and an auto-responder hook for agent-driven replies.
 * See this file's module doc comment for the full design writeup, including
 * why `sendMessage()`/`sendTyping()` take an explicit target pubKey and why
 * `verifyFn` is called with each message's actual sender rather than one
 * fixed constructor-time key.
 */
export class PeerChat {
  /** @type {string} This node's own routing pubKey/podId. */
  #localPubKey

  /** @type {(toPubKey: string, payload: object) => Promise<void>} */
  #send

  /** @type {((data: Uint8Array) => Promise<Uint8Array>)|null} */
  #signFn

  /** @type {((fromPubKey: string, data: Uint8Array, sig: Uint8Array) => Promise<boolean>)|null} */
  #verifyFn

  /** @type {Array<object>} ChatMessage objects, flat across every conversation this instance has seen. */
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
   * @param {string} opts.localPubKey - This node's own routing pubKey/podId, used as `message.from`.
   * @param {(toPubKey: string, payload: object) => (void|Promise<void>)} opts.send -
   *   Transport hook, replacing the old `session.send('chat', payload)`.
   *   Called with the message/typing-indicator payload (NOT pre-wrapped in
   *   an envelope -- the caller, typically `createChatService()`, adds
   *   whatever envelope shape its own transport needs).
   * @param {Function} [opts.signFn] - async (data: Uint8Array) => Uint8Array
   * @param {Function} [opts.verifyFn] - async (fromPubKey, data, sig) => boolean
   * @param {number} [opts.maxHistory=1000] - Maximum messages to retain
   * @param {Function} [opts.autoResponder] - async (message) => string|null
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor({ localPubKey, send, signFn, verifyFn, maxHistory, autoResponder, onLog }) {
    if (!localPubKey || typeof localPubKey !== 'string') {
      throw new Error('localPubKey is required and must be a non-empty string')
    }
    if (typeof send !== 'function') {
      throw new Error('send is required and must be a function')
    }

    this.#localPubKey = localPubKey
    this.#send = send
    this.#signFn = signFn || null
    this.#verifyFn = verifyFn || null
    this.#maxHistory = maxHistory ?? 1000
    this.#autoResponder = autoResponder || null
    this.#onLog = onLog || (() => {})
  }

  /** @returns {string} */
  get localPubKey() { return this.#localPubKey }

  // -- Sending --------------------------------------------------------------

  /**
   * Send a text message to a remote peer.
   *
   * Creates a ChatMessage envelope, optionally signs it, transmits via
   * `send()`, records in history, and emits 'message:sent'.
   *
   * @param {string} toPubKey - Recipient's routing pubKey/podId
   * @param {string} text - Message text
   * @param {object} [opts] - Options
   * @param {boolean} [opts.isAutoResponse] - Mark as auto-response to prevent loops
   * @returns {Promise<object>} The sent ChatMessage
   */
  async sendMessage(toPubKey, text, opts) {
    if (!toPubKey || typeof toPubKey !== 'string') {
      throw new Error('sendMessage: toPubKey is required and must be a non-empty string')
    }

    const message = {
      id: generateChatMessageId(),
      from: this.#localPubKey,
      to: toPubKey,
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

    // Send over the injected transport
    await this.#send(toPubKey, message)

    // Add to history
    this.#addToHistory(message)

    // Emit event
    this.#emit('message:sent', message)

    return message
  }

  // -- Typing indicators ----------------------------------------------------

  /**
   * Send a typing indicator to a remote peer.
   *
   * @param {string} toPubKey - Recipient's routing pubKey/podId
   */
  async sendTyping(toPubKey) {
    if (!toPubKey || typeof toPubKey !== 'string') {
      throw new Error('sendTyping: toPubKey is required and must be a non-empty string')
    }
    await this.#send(toPubKey, {
      kind: 'typing',
      from: this.#localPubKey,
    })
  }

  // -- Incoming handler -------------------------------------------------------

  /**
   * Handle an incoming chat envelope from the transport.
   *
   * Verifies signature if verification is available, adds to history,
   * emits the appropriate event, and triggers auto-response if configured.
   * Replaces the old private, session-driven `#handleIncoming(envelope)` --
   * public now because routing is external (`createChatService()`'s
   * `ctx.onIncomingData()` subscription calls this directly, there is no
   * more `session.registerHandler()` to do it implicitly).
   *
   * @param {string} fromPubKey - Sender's routing pubKey/podId
   * @param {object} envelope - Chat payload (message or typing indicator)
   */
  async receiveEnvelope(fromPubKey, envelope) {
    const payload = envelope || {}

    // Handle typing indicators
    if (payload.kind === 'typing') {
      this.#emit('typing', { from: payload.from || fromPubKey })
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
      from: payload.from || fromPubKey,
      to: payload.to || this.#localPubKey,
      text: payload.text,
      timestamp: typeof payload.timestamp === 'number' ? payload.timestamp : Date.now(),
      signature: payload.signature || undefined,
    }

    // Verify signature if verify function is available. Keyed off the
    // ACTUAL sender (fromPubKey), not a fixed constructor-time key -- see
    // module doc comment's point 2.
    if (this.#verifyFn && message.signature) {
      try {
        const data = new TextEncoder().encode(JSON.stringify({
          id: message.id,
          from: message.from,
          to: message.to,
          text: message.text,
          timestamp: message.timestamp,
        }))
        const sigBytes = base64ToBytes(message.signature)
        message.verified = await this.#verifyFn(fromPubKey, data, sigBytes)
      } catch (err) {
        this.#onLog(1, `Signature verification failed: ${err.message}`)
        message.verified = false
      }
    } else if (this.#verifyFn && !message.signature) {
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
          await this.sendMessage(fromPubKey, reply, { isAutoResponse: true })
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
   * Close the peer chat. Clears listeners. Unlike the old `PeerSession`-bound
   * version, there is no handler to remove from a session -- routing
   * ownership (subscribing/unsubscribing from `ctx.onIncomingData()`) lives
   * in `createChatService()`, which calls this from its own `teardown()`.
   */
  close() {
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
      localPubKey: this.#localPubKey,
      messageCount: this.#messageHistory.length,
      maxHistory: this.#maxHistory,
      hasSignFn: !!this.#signFn,
      hasVerifyFn: !!this.#verifyFn,
      hasAutoResponder: !!this.#autoResponder,
      messages: this.#messageHistory.map(m => ({ ...m })),
    }
  }
}

// ---------------------------------------------------------------------------
// createChatService -- the MeshService wrapper
// ---------------------------------------------------------------------------

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) wrapping
 * `PeerChat`. See this file's module doc comment for the full design
 * writeup (multi-peer generalization, per-message sender-keyed
 * verification, the `type`/`kind` collision this avoids).
 *
 * @param {object} [opts]
 * @param {Function} [opts.signFn] - async (data: Uint8Array) => Uint8Array.
 *   Passed straight through to `PeerChat`; omit to send unsigned messages.
 * @param {Function} [opts.verifyFn] - async (fromPubKey, data, sig) => boolean.
 *   Passed straight through to `PeerChat`; called with each message's real
 *   sender, not a fixed key -- see module doc comment's point 2.
 * @param {number} [opts.maxHistory=1000]
 * @param {Function} [opts.autoResponder] - async (message) => string|null
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createChatService({ signFn, verifyFn, maxHistory, autoResponder, onLog } = {}) {
  return {
    name: 'chat',

    attach(peerNode, ctx) {
      const chat = new PeerChat({
        localPubKey: peerNode.podId,
        send: (toPubKey, payload) => ctx.sendTo(toPubKey, 'chat', payload),
        signFn,
        verifyFn,
        maxHistory,
        autoResponder,
        onLog,
      })

      // Bridge PeerChat's own on/off events through ctx.emit() -- additive,
      // not a replacement: chat.on()/chat.off() still work for anyone
      // holding the PeerChat instance directly (e.g. a test).
      chat.on('message:sent', (message) => ctx.emit('chat:message-sent', message))
      chat.on('message:received', (message) => ctx.emit('chat:message-received', message))
      chat.on('typing', (data) => ctx.emit('chat:typing', data))

      const unsubscribe = ctx.onIncomingData('chat', (fromPubKey, envelope) =>
        chat.receiveEnvelope(fromPubKey, envelope))

      const api = {
        sendMessage: (toPubKey, text, sendOpts) => chat.sendMessage(toPubKey, text, sendOpts),
        sendTyping: (toPubKey) => chat.sendTyping(toPubKey),
        getHistory: () => chat.getHistory(),
        clearHistory: () => chat.clearHistory(),
      }

      return {
        api,
        teardown() {
          unsubscribe()
          chat.close()
        },
      }
    },
  }
}
