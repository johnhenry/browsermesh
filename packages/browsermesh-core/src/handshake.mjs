import { silentCatch } from './silent-catch.mjs'
/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-handshake.js -- Connection Handshake Protocol.
 *
 * Coordinates signaling, direct input exchange (QR + clipboard), and
 * session establishment between two mesh peers.
 *
 * SignalingClient bridges a WebSocket (or MeshRelayClient) into the
 * signaler interface that WebRTCTransport expects (sendOffer, sendAnswer,
 * sendIceCandidate, onOffer, onAnswer, onIceCandidate).
 *
 * DirectInputHandshake handles manual key exchange for direct pairing
 * without a signaling server -- via clipboard paste or QR code.
 *
 * HandshakeCoordinator orchestrates the full connection flow:
 * discovery -> transport selection -> handshake -> session.
 *
 * No browser-only imports at module level. All dependencies injected
 * via constructor.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-handshake.test.mjs
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Uint8Array to a base64url string (no padding).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64Url(bytes) {
  const bin = String.fromCharCode(...bytes)
  const b64 = btoa(bin)
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Decode a base64url string back to a Uint8Array.
 * @param {string} str
 * @returns {Uint8Array}
 */
function fromBase64Url(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  while (b64.length % 4 !== 0) b64 += '='
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * Generate a random hex nonce.
 * @param {number} [byteLen=16]
 * @returns {string}
 */
function randomHex(byteLen = 16) {
  const bytes = new Uint8Array(byteLen)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Token TTL in milliseconds (5 minutes). */
const TOKEN_TTL_MS = 5 * 60 * 1000

/** Default connection timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// SignalingClient
// ---------------------------------------------------------------------------

/**
 * Bridges a WebSocket connection (or MeshRelayClient) into the signaler
 * interface that WebRTCTransport expects.
 *
 * Provides sendOffer, sendAnswer, sendIceCandidate plus event callbacks
 * onOffer, onAnswer, onIceCandidate for signaling exchange.
 */
export class SignalingClient {
  /** @type {object|null} WebSocket instance */
  #ws = null

  /** @type {string} */
  #localPodId

  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map()

  /** @type {Function} */
  #onLog

  /** @type {string|null} */
  #url

  /** @type {Function|null} */
  #WebSocketCtor

  /**
   * @param {object} opts
   * @param {string} [opts.url] - WebSocket signaling server URL
   * @param {string} opts.localPodId - Local pod identifier
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   * @param {Function} [opts._WebSocket] - Injectable WebSocket constructor
   */
  constructor({ url = null, localPodId, onLog, _WebSocket } = {}) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string')
    }
    this.#url = url
    this.#localPodId = localPodId
    this.#onLog = onLog || (() => {})
    this.#WebSocketCtor = _WebSocket || globalThis.WebSocket || null
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Open WebSocket to signaling server and register.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.#ws) return

    if (!this.#url) {
      throw new Error('No signaling URL configured')
    }
    if (!this.#WebSocketCtor) {
      throw new Error('WebSocket not available')
    }

    return new Promise((resolve, reject) => {
      const ws = new this.#WebSocketCtor(this.#url)

      const onOpen = () => {
        cleanup()
        this.#ws = ws
        ws.addEventListener('message', this.#handleMessage)
        ws.addEventListener('close', this.#handleClose)
        // Register with the signaling server
        this.send(null, 'register', { podId: this.#localPodId })
        this.#onLog(2, `SignalingClient connected to ${this.#url}`)
        resolve()
      }

      const onError = (err) => {
        cleanup()
        reject(err instanceof Error ? err : new Error('WebSocket connection failed'))
      }

      const cleanup = () => {
        ws.removeEventListener('open', onOpen)
        ws.removeEventListener('error', onError)
      }

      ws.addEventListener('open', onOpen)
      ws.addEventListener('error', onError)
    })
  }

  /**
   * Disconnect from the signaling server.
   */
  disconnect() {
    if (!this.#ws) return
    try {
      this.#ws.removeEventListener('message', this.#handleMessage)
      this.#ws.removeEventListener('close', this.#handleClose)
      this.#ws.close()
    } catch (e) { silentCatch('clawser-mesh-handshake', 'ignore-close-errors', e) }
    this.#ws = null
    this.#onLog(2, 'SignalingClient disconnected')
  }

  /** True when WebSocket is open. */
  get connected() {
    return this.#ws !== null
  }

  // -- Signaler interface for WebRTCTransport --------------------------------

  /**
   * Send an SDP offer to a remote peer.
   * @param {string} remotePodId
   * @param {object} offer
   */
  sendOffer(remotePodId, offer) {
    this.send(remotePodId, 'offer', { offer })
  }

  /**
   * Send an SDP answer to a remote peer.
   * @param {string} remotePodId
   * @param {object} answer
   */
  sendAnswer(remotePodId, answer) {
    this.send(remotePodId, 'answer', { answer })
  }

  /**
   * Send an ICE candidate to a remote peer.
   * @param {string} remotePodId
   * @param {object} candidate
   */
  sendIceCandidate(remotePodId, candidate) {
    this.send(remotePodId, 'ice-candidate', { candidate })
  }

  /**
   * Register callback for incoming SDP offers.
   * @param {Function} cb - Receives (offer, fromPodId)
   */
  onOffer(cb) {
    this.on('offer', cb)
  }

  /**
   * Register callback for incoming SDP answers.
   * @param {Function} cb - Receives (answer, fromPodId)
   */
  onAnswer(cb) {
    this.on('answer', cb)
  }

  /**
   * Register callback for incoming ICE candidates.
   * @param {Function} cb - Receives (candidate, fromPodId)
   */
  onIceCandidate(cb) {
    this.on('ice-candidate', cb)
  }

  // -- Generic send / event system ------------------------------------------

  /**
   * Send a typed message to a remote peer via the signaling server.
   *
   * @param {string|null} remotePodId - Target peer (null for server-only messages)
   * @param {string} type - Message type
   * @param {object} payload - Message payload
   */
  send(remotePodId, type, payload) {
    if (!this.#ws) {
      throw new Error('SignalingClient not connected')
    }
    const msg = JSON.stringify({
      from: this.#localPodId,
      to: remotePodId,
      type,
      ...payload,
    })
    this.#ws.send(msg)
  }

  /**
   * Register a listener for a given event type.
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
   * Remove a listener for a given event type.
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const set = this.#listeners.get(event)
    if (set) set.delete(cb)
  }

  // -- Internal event handlers (arrow fns for stable `this`) ----------------

  /** @type {(ev: { data: * }) => void} */
  #handleMessage = (ev) => {
    try {
      const data = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data
      if (!data || !data.type) return
      this.#fire(data.type, data)
    } catch (e) { silentCatch('clawser-mesh-handshake', 'ignore-malformed-messages', e) }
  }

  /** @type {() => void} */
  #handleClose = () => {
    this.#ws = null
    this.#onLog(2, 'SignalingClient WebSocket closed')
  }

  /**
   * Fire all listeners for a given event type.
   * @param {string} event
   * @param {*} data
   */
  #fire(event, data) {
    const set = this.#listeners.get(event)
    if (!set) return
    for (const cb of set) {
      try { cb(data, data.from) } catch (e) { silentCatch('clawser-mesh-handshake', 'swallow-listener-errors', e) }
    }
  }
}

// ---------------------------------------------------------------------------
// DirectInputHandshake
// ---------------------------------------------------------------------------

/**
 * Manual key exchange for direct pairing without a signaling server.
 *
 * Generates a connection token containing the local pod's identity
 * and connection parameters. The token can be shared via clipboard
 * paste or QR code. The receiving peer decodes and validates the
 * token to establish a connection.
 */
export class DirectInputHandshake {
  /** @type {string} */
  #localPodId

  /** @type {Function} async () => Uint8Array */
  #getPublicKeyBytes

  /** @type {string|null} */
  #signalingUrl

  /** @type {object[]|null} */
  #iceServers

  /** @type {Function} */
  #onLog

  /**
   * @param {object} opts
   * @param {string} opts.localPodId - Local pod identifier
   * @param {Function} opts.getPublicKeyBytes - async () => Uint8Array, returns public key bytes
   * @param {string} [opts.signalingUrl] - Optional signaling server URL to include in token
   * @param {object[]} [opts.iceServers] - Optional ICE server configs to include in token
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   */
  constructor({ localPodId, getPublicKeyBytes, signalingUrl, iceServers, onLog } = {}) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string')
    }
    if (!getPublicKeyBytes || typeof getPublicKeyBytes !== 'function') {
      throw new Error('getPublicKeyBytes is required and must be a function')
    }
    this.#localPodId = localPodId
    this.#getPublicKeyBytes = getPublicKeyBytes
    this.#signalingUrl = signalingUrl || null
    this.#iceServers = iceServers || null
    this.#onLog = onLog || (() => {})
  }

  /**
   * Generate a connection token containing this peer's identity and
   * connection parameters.
   *
   * @returns {Promise<ConnectionToken>}
   */
  async generateToken() {
    const pubKeyBytes = await this.#getPublicKeyBytes()
    const publicKey = toBase64Url(pubKeyBytes)
    const nonce = randomHex(16)

    /** @type {ConnectionToken} */
    const token = {
      podId: this.#localPodId,
      publicKey,
      nonce,
      timestamp: Date.now(),
    }

    if (this.#signalingUrl) token.signalingUrl = this.#signalingUrl
    if (this.#iceServers) token.iceServers = this.#iceServers

    this.#onLog(2, `Generated connection token for pod ${this.#localPodId}`)
    return token
  }

  /**
   * Encode a connection token as a base64url JSON string for clipboard sharing.
   *
   * @param {ConnectionToken} token
   * @returns {string}
   */
  encodeToken(token) {
    const json = JSON.stringify(token)
    const bytes = new TextEncoder().encode(json)
    return toBase64Url(bytes)
  }

  /**
   * Decode a base64url-encoded token string back into a ConnectionToken.
   *
   * @param {string} encoded - base64url-encoded JSON string
   * @returns {ConnectionToken}
   */
  static decodeToken(encoded) {
    const bytes = fromBase64Url(encoded)
    const json = new TextDecoder().decode(bytes)
    return JSON.parse(json)
  }

  /**
   * Validate a received connection token.
   *
   * Checks: has podId, has publicKey, has nonce, not self, not expired (5min TTL).
   *
   * @param {ConnectionToken} token
   * @returns {{ valid: boolean, error?: string }}
   */
  validateToken(token) {
    if (!token || typeof token !== 'object') {
      return { valid: false, error: 'Token is not an object' }
    }
    if (!token.podId || typeof token.podId !== 'string') {
      return { valid: false, error: 'Token missing podId' }
    }
    if (!token.publicKey || typeof token.publicKey !== 'string') {
      return { valid: false, error: 'Token missing publicKey' }
    }
    if (!token.nonce || typeof token.nonce !== 'string') {
      return { valid: false, error: 'Token missing nonce' }
    }
    if (token.podId === this.#localPodId) {
      return { valid: false, error: 'Cannot connect to self' }
    }
    if (typeof token.timestamp !== 'number') {
      return { valid: false, error: 'Token missing timestamp' }
    }
    const age = Date.now() - token.timestamp
    if (age > TOKEN_TTL_MS) {
      return { valid: false, error: 'Token expired' }
    }
    // Reject tokens with future timestamps (clock skew tolerance: 30s)
    if (age < -30_000) {
      return { valid: false, error: 'Token timestamp is in the future' }
    }
    return { valid: true }
  }

  /**
   * Generate a QR code data URL for a connection token.
   *
   * Returns the encoded token string suitable for an external QR library,
   * or null if generation is not available in the current environment.
   *
   * @param {ConnectionToken} token
   * @returns {Promise<string|null>}
   */
  async generateQRDataURL(token) {
    const encoded = this.encodeToken(token)
    // QR generation requires a canvas or external library.
    // Return the encoded string for use with an external QR renderer.
    // In a browser with a QR library loaded, this could be extended
    // to produce an actual data:image/png;base64,... URL.
    this.#onLog(2, 'QR generation requires external library; returning encoded token')
    return encoded
  }
}

/**
 * @typedef {object} ConnectionToken
 * @property {string} podId - Peer's pod identifier
 * @property {string} publicKey - base64url-encoded public key
 * @property {string} [signalingUrl] - Optional signaling server URL
 * @property {object[]} [iceServers] - Optional ICE server configs
 * @property {string} nonce - Random hex nonce
 * @property {number} timestamp - Unix timestamp in ms
 */

// ---------------------------------------------------------------------------
// HandshakeCoordinator
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full connection flow: discovery -> transport selection ->
 * handshake -> session establishment.
 *
 * Brings together SignalingClient and TransportFactory to connect two peers,
 * whether via a signaling server or via a direct-input connection token.
 */
export class HandshakeCoordinator {
  /** @type {SignalingClient|null} */
  #signalingClient

  /** @type {object|null} TransportFactory */
  #transportFactory

  /** @type {string} */
  #localPodId

  /** @type {Function} */
  #onLog

  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map()

  /**
   * @param {object} opts
   * @param {string} opts.localPodId - Local pod identifier
   * @param {SignalingClient} [opts.signalingClient] - Signaling client instance
   * @param {object} [opts.transportFactory] - TransportFactory instance
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   */
  constructor({ localPodId, signalingClient, transportFactory, onLog } = {}) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string')
    }
    this.#localPodId = localPodId
    this.#signalingClient = signalingClient || null
    this.#transportFactory = transportFactory || null
    this.#onLog = onLog || (() => {})

    // Wire incoming offer events from signaling client
    if (this.#signalingClient) {
      this.#signalingClient.onOffer((data, fromPodId) => {
        this.#fire('incoming', { remotePodId: fromPodId, offer: data.offer })
      })
    }
  }

  /**
   * Initiate a connection to a remote peer via the signaling server.
   *
   * Uses the transport factory to negotiate the best transport, passing
   * the signaling client as the signaler bridge.
   *
   * @param {string} remotePodId - Target peer identifier
   * @param {object} [opts]
   * @param {object} [opts.endpoints] - Map of transport type -> constructor opts
   * @param {object[]} [opts.iceServers] - ICE server configs
   * @param {number} [opts.timeout] - Connection timeout in ms
   * @returns {Promise<{ transport: object, sessionInfo: object }>}
   */
  async connectToPeer(remotePodId, opts = {}) {
    if (!this.#transportFactory) {
      throw new Error('TransportFactory is required for connectToPeer')
    }
    if (!this.#signalingClient) {
      throw new Error('SignalingClient is required for connectToPeer')
    }

    const timeout = opts.timeout || DEFAULT_TIMEOUT_MS
    this.#onLog(2, `Initiating connection to ${remotePodId}`)

    const endpointOpts = opts.endpoints || {
      webrtc: { config: { iceServers: opts.iceServers || [] } },
    }

    let timeoutHandle
    const transport = await Promise.race([
      this.#transportFactory.negotiate(
        this.#localPodId,
        remotePodId,
        this.#signalingClient,
        endpointOpts,
      ),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error('Connection timeout')), timeout)
      }),
    ])
    clearTimeout(timeoutHandle)

    const sessionInfo = {
      localPodId: this.#localPodId,
      remotePodId,
      transportType: transport.type,
      establishedAt: Date.now(),
    }

    this.#onLog(2, `Connected to ${remotePodId} via ${transport.type}`)
    this.#fire('connected', { remotePodId, transport, sessionInfo })
    return { transport, sessionInfo }
  }

  /**
   * Accept an incoming connection from a remote peer.
   *
   * Handles an incoming WebRTC offer by creating a transport via the
   * factory and invoking its handleOffer method.
   *
   * @param {string} remotePodId - Initiating peer identifier
   * @param {object} offer - SDP offer
   * @returns {Promise<{ transport: object, sessionInfo: object }>}
   */
  async acceptConnection(remotePodId, offer) {
    if (!this.#transportFactory) {
      throw new Error('TransportFactory is required for acceptConnection')
    }
    if (!this.#signalingClient) {
      throw new Error('SignalingClient is required for acceptConnection')
    }

    this.#onLog(2, `Accepting connection from ${remotePodId}`)

    const transport = await this.#transportFactory.create('webrtc', {
      localPodId: this.#localPodId,
      remotePodId,
      signaler: this.#signalingClient,
    })

    if (typeof transport.handleOffer === 'function') {
      await transport.handleOffer(offer)
    }

    const sessionInfo = {
      localPodId: this.#localPodId,
      remotePodId,
      transportType: transport.type,
      establishedAt: Date.now(),
    }

    this.#onLog(2, `Accepted connection from ${remotePodId}`)
    this.#fire('connected', { remotePodId, transport, sessionInfo })
    return { transport, sessionInfo }
  }

  /**
   * Connect to a peer using a DirectInputHandshake connection token.
   *
   * Parses the token, optionally creates a signaling client from the
   * token's signalingUrl, and negotiates a transport.
   *
   * @param {ConnectionToken} token - Decoded connection token
   * @param {object} [transportFactory] - Override transport factory
   * @returns {Promise<{ transport: object, sessionInfo: object }>}
   */
  async connectViaToken(token, transportFactory) {
    const factory = transportFactory || this.#transportFactory
    if (!factory) {
      throw new Error('TransportFactory is required for connectViaToken')
    }

    const remotePodId = token.podId
    this.#onLog(2, `Connecting via token to ${remotePodId}`)

    // Build a signaler — use existing client or create one from token's URL
    let signaler = this.#signalingClient
    let createdSignaler = false

    if (!signaler && token.signalingUrl) {
      signaler = new SignalingClient({
        url: token.signalingUrl,
        localPodId: this.#localPodId,
        onLog: this.#onLog,
      })
      await signaler.connect()
      createdSignaler = true
    }

    if (!signaler) {
      throw new Error('No signaling channel available (provide signalingClient or token.signalingUrl)')
    }

    const iceServers = token.iceServers || []
    const endpointOpts = {
      webrtc: { config: { iceServers } },
    }

    try {
      const transport = await factory.negotiate(
        this.#localPodId,
        remotePodId,
        signaler,
        endpointOpts,
      )

      const sessionInfo = {
        localPodId: this.#localPodId,
        remotePodId,
        transportType: transport.type,
        establishedAt: Date.now(),
        viaToken: true,
      }

      this.#onLog(2, `Connected via token to ${remotePodId}`)
      // Clean up signaler we created — transport is now established
      if (createdSignaler && signaler) {
        signaler.disconnect()
      }
      this.#fire('connected', { remotePodId, transport, sessionInfo })
      return { transport, sessionInfo }
    } catch (err) {
      // Clean up signaler we created on failure
      if (createdSignaler && signaler) {
        signaler.disconnect()
      }
      this.#fire('failed', { remotePodId, error: err.message })
      throw err
    }
  }

  /**
   * Register a callback for incoming connection requests.
   *
   * The callback receives ({ remotePodId, offer }) when another peer
   * initiates a connection via the signaling server.
   *
   * @param {Function} cb
   */
  onIncomingConnection(cb) {
    this.on('incoming', cb)
  }

  // -- Event system ---------------------------------------------------------

  /**
   * Register a listener for a given event.
   * Events: 'connected', 'failed', 'incoming'
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
   * Remove a listener for a given event.
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const set = this.#listeners.get(event)
    if (set) set.delete(cb)
  }

  /** True when the signaling client is connected. */
  get connected() {
    return this.#signalingClient ? this.#signalingClient.connected : false
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
    for (const cb of set) {
      try { cb(data) } catch (e) { silentCatch('clawser-mesh-handshake', 'swallow-listener-errors', e) }
    }
  }
}

export { TOKEN_TTL_MS, DEFAULT_TIMEOUT_MS, toBase64Url, fromBase64Url }
