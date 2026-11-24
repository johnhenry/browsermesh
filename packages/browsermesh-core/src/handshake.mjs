import { silentCatch } from './silent-catch.mjs'
/**
// STATUS: INTEGRATED — wired into Pod (@johnhenry/browsermesh-pod) lifecycle, proven via E2E testing
 * handshake.mjs -- Connection Handshake Protocol.
 *
 * Coordinates signaling, direct input exchange (QR + clipboard), and
 * session establishment between two mesh peers.
 *
 * SignalingClient bridges a WebSocket (or MeshRelayClient) into the
 * signaler interface that WebRTCTransport expects (sendOffer, sendAnswer,
 * sendIceCandidate, onOffer, onAnswer, onIceCandidate).
 *
 * DirectInputHandshake handles manual exchange of a peer's identity and
 * connection parameters -- via clipboard paste or QR code -- without a
 * server. Note that this covers the KEY exchange only: the token carries
 * no SDP, so establishing the connection still needs a signaling channel.
 *
 * HandshakeCoordinator orchestrates the full connection flow:
 * discovery -> transport selection -> handshake -> session.
 *
 * No browser-only imports at module level. All dependencies injected
 * via constructor.
 *
 * Run tests:
 *   cd packages/browsermesh-core && node --import ./test/_setup-globals.mjs --test test/handshake.test.mjs
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Largest number of bytes handed to `String.fromCharCode` at a time.
 *
 * The spread form -- `String.fromCharCode(...bytes)` -- turns every byte into
 * a separate argument, and V8 caps an argument list at roughly 124k entries,
 * so it throws `RangeError: Maximum call stack size exceeded` on inputs above
 * that. The exact ceiling moves with the stack depth of the caller, which is
 * worse than a fixed limit: the same input can encode from one call site and
 * throw from another. Chunking removes the ceiling entirely.
 */
const FROM_CHAR_CODE_CHUNK = 0x8000

/**
 * Convert a Uint8Array to a base64url string (no padding).
 *
 * Handles inputs of any length. See FROM_CHAR_CODE_CHUNK for why this is a
 * chunked loop rather than the shorter spread form.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64Url(bytes) {
  // subarray() is zero-copy but TypedArray-only; callers outside this module
  // may hand us a plain array of byte values, which the old spread accepted.
  const view = ArrayBuffer.isView(bytes) ? bytes : Uint8Array.from(bytes)
  let bin = ''
  for (let i = 0; i < view.length; i += FROM_CHAR_CODE_CHUNK) {
    bin += String.fromCharCode.apply(
      null,
      view.subarray(i, i + FROM_CHAR_CODE_CHUNK),
    )
  }
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

/**
 * Thrown by `DirectInputHandshake.decodeToken()` for any malformed token.
 *
 * One error type for the whole decode path, so a caller wiring up a QR
 * scanner catches this instead of guessing which of `DOMException`,
 * `SyntaxError` or `TypeError` the platform will produce. The originating
 * platform error, when there is one, is kept as `cause`.
 */
export class TokenDecodeError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {unknown} [opts.cause]
   */
  constructor(message, opts) {
    super(message, opts)
    this.name = 'TokenDecodeError'
  }
}

/**
 * Longest encoded token `decodeToken()` will look at, in characters.
 *
 * A ConnectionToken is a few hundred bytes; the densest QR code holds 2,953
 * bytes, so anything a camera can actually read is two orders of magnitude
 * below this. The cap exists only to bound what a hostile string can make the
 * process allocate -- it is deliberately generous rather than tight.
 *
 * Note the asymmetry: `encodeToken()` is uncapped, because a caller encoding
 * their own token is not the untrusted side. A token built from a very large
 * `iceServers` list can therefore encode to more than this and fail to decode.
 * Pass `{ maxLength }` if that is genuinely your case.
 */
export const MAX_ENCODED_TOKEN_LENGTH = 128 * 1024

/** Token TTL in milliseconds (5 minutes). */
const TOKEN_TTL_MS = 5 * 60 * 1000

/**
 * Default cap on the number of consumed nonces a DirectInputHandshake will
 * remember. Entries normally age out with the token TTL well before this
 * matters; the cap exists so that a peer flooding distinct tokens cannot
 * grow the set without bound.
 */
const DEFAULT_MAX_CONSUMED_NONCES = 10_000

/** Default connection timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Signalling protocol 2 (authenticated registration) and the ICE-server fetch
// ---------------------------------------------------------------------------

/** The registration protocol this client speaks when a server offers it. */
export const SIGNALING_PROTOCOL = 2
const SIGNALING_SIGNED_PREFIX = 'browsermesh-signaling/2'
export const DEFAULT_CHALLENGE_WAIT_MS = 2000

/**
 * A registration the signalling server refused, or one this client could not
 * complete. `code` is the server's own code where it sent one
 * (`protocol-unsupported`, `bad-nonce`, `challenge-expired`, `bad-pod-id`,
 * `bad-key`, `bad-signature`, `pod-id-mismatch`) or one of this client's
 * (`no-challenge`, `auth-required`).
 */
export class SignalingAuthError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SignalingAuthError'
    this.code = code
  }
}

/**
 * The server requires protocol 2 (a signed registration) and this client has no
 * identity to sign with (or was told not to).
 */
export class SignalingAuthRequiredError extends SignalingAuthError {
  constructor(message = 'the signalling server requires authenticated registration (protocol 2): pass { identity } (a PodIdentity) to SignalingClient') {
    super('auth-required', message)
    this.name = 'SignalingAuthRequiredError'
  }
}

/** The ws:// / wss:// origin a registration is signed for, from the URL the client was configured with. */
function signalingOrigin(url) {
  const u = new URL(String(url))
  if (u.protocol === 'http:') u.protocol = 'ws:'
  else if (u.protocol === 'https:') u.protocol = 'wss:'
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new TypeError(`signalling URL must be ws:// or wss:// (got ${u.protocol})`)
  return u.origin
}

function registrationMessage({ origin, podId, nonce }) {
  for (const [k, v] of Object.entries({ origin, podId, nonce })) {
    if (typeof v !== 'string' || !v || /[\r\n]/.test(v)) throw new TypeError(`${k} must be a non-empty string without line breaks`)
  }
  return `${SIGNALING_SIGNED_PREFIX}\npurpose:register\norigin:${origin}\npodId:${podId}\nnonce:${nonce}`
}

/**
 * Fetch time-limited ICE (STUN/TURN) servers from the signalling server's
 * `GET /ice-servers`. The server answers only a caller that sends
 * `Authorization: Bearer <token>` or that is the same origin as the server.
 *
 * @param {object} opts
 * @param {string} [opts.url] - the endpoint, absolute or (same-origin pages) relative
 * @param {string} [opts.signalingUrl] - or the signalling URL (`wss://host`); the endpoint is derived from it
 * @param {string} [opts.token] - the server's ICE API token; sent as a Bearer header, never in the URL
 * @param {Function} [opts.fetch] - injectable fetch (default `globalThis.fetch`)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<object[]>} RTCIceServer list, ready for `iceServers`
 */
export async function fetchIceServers({ url, signalingUrl, token, fetch: fetchImpl, signal } = {}) {
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('fetchIceServers: no fetch available')
  let target = url
  if (!target) {
    if (!signalingUrl) throw new TypeError('fetchIceServers: pass { url } or { signalingUrl }')
    const u = new URL(String(signalingUrl))
    u.protocol = u.protocol === 'wss:' ? 'https:' : u.protocol === 'ws:' ? 'http:' : u.protocol
    u.pathname = '/ice-servers'
    u.search = ''
    u.hash = ''
    target = u.href
  }
  const headers = { Accept: 'application/json' }
  if (token) {
    // A bearer token must not cross the network in the clear.
    let parsed = null
    try { parsed = new URL(String(target)) } catch { /* relative URL: same origin as the page */ }
    if (parsed && parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
      const e = new Error('fetchIceServers: refusing to send the ICE token over plain http to a non-loopback host')
      e.code = 'ice-insecure-token'
      throw e
    }
    headers.Authorization = `Bearer ${token}`
  }
  // redirect: 'error' so the token is never replayed to another host.
  const res = await doFetch(target, { headers, redirect: 'error', cache: 'no-store', signal })
  if (!res.ok) {
    const e = new Error(`fetchIceServers: server answered ${res.status}`)
    e.status = res.status
    e.code = res.status === 401 || res.status === 403 ? 'ice-unauthorized' : res.status === 429 ? 'ice-rate-limited' : 'ice-failed'
    throw e
  }
  const body = await res.json()
  if (!Array.isArray(body) || !body.every((s) => s && typeof s === 'object' && (typeof s.urls === 'string' || Array.isArray(s.urls)))) {
    const e = new Error('fetchIceServers: response is not a list of ICE servers')
    e.code = 'ice-bad-response'
    throw e
  }
  return body
}

// ---------------------------------------------------------------------------
// SignalingClient
// ---------------------------------------------------------------------------

/**
 * Bridges a WebSocket connection (or MeshRelayClient) into the signaler
 * interface that WebRTCTransport expects.
 *
 * Provides sendOffer, sendAnswer, sendIceCandidate plus event callbacks
 * onOffer, onAnswer, onIceCandidate for signaling exchange.
 *
 * Against a signalling server in authenticated mode (protocol 2) it answers
 * the server's challenge with a signature from `identity`, so the server can
 * tie the pod id to the key that proves it. Against an open-mode or older
 * server it registers as before.
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

  #identity
  #authentication
  #origin
  #challengeWaitMs
  #waitForRegistration

  /** @type {{ mode: string, verified: boolean }|null} */
  #registration = null

  /** @type {Error|null} */
  #lastAuthError = null

  /** @type {boolean} */
  #replaced = false

  /** In-flight registration: settles connect() when `waitForRegistration`. */
  #reg = null

  /**
   * @param {object} opts
   * @param {string} [opts.url] - WebSocket signaling server URL
   * @param {string} opts.localPodId - Local pod identifier
   * @param {object} [opts.identity] - A `PodIdentity` (or anything with `podId`, `rawPublicKey()` and `sign(bytes)`). Lets the client answer an authenticated server's challenge; its `podId` must equal `localPodId`.
   * @param {'auto'|'required'|'off'} [opts.authentication='auto'] - `auto`: use protocol 2 when the server offers it, otherwise register as before. `required`: never fall back to the open flow (needs `identity`). `off`: never sign.
   * @param {string} [opts.origin] - The server origin to sign, when it differs from `url` (a server reached through a proxy or an internal name). Defaults to the origin of `url`.
   * @param {number} [opts.challengeWaitMs=2000] - With an identity in `auto` mode: how long to wait for the server's challenge before registering the open way (an open-mode or older server sends none).
   * @param {boolean} [opts.waitForRegistration] - `connect()` resolves on `registered` and rejects with the refusal. Default: true when an `identity` is given, false otherwise (then it resolves on open, as before, and a refusal is announced as an `auth-error` event).
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   * @param {Function} [opts._WebSocket] - Injectable WebSocket constructor
   */
  constructor({ url = null, localPodId, identity = null, authentication = 'auto', origin, challengeWaitMs = DEFAULT_CHALLENGE_WAIT_MS, waitForRegistration, onLog, _WebSocket } = {}) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string')
    }
    if (authentication !== 'auto' && authentication !== 'required' && authentication !== 'off') {
      throw new TypeError("authentication must be 'auto', 'required' or 'off'")
    }
    if (identity) {
      if (typeof identity.sign !== 'function' || typeof identity.rawPublicKey !== 'function') {
        throw new TypeError('identity must provide podId, rawPublicKey() and sign(bytes) (a PodIdentity)')
      }
      if (identity.podId !== localPodId) {
        throw new TypeError('identity.podId must equal localPodId: the server binds the pod id to the key')
      }
    }
    if (authentication === 'required' && !identity) throw new SignalingAuthRequiredError()
    this.#url = url
    this.#localPodId = localPodId
    this.#identity = identity || null
    this.#authentication = authentication
    this.#origin = origin ?? null
    this.#challengeWaitMs = challengeWaitMs
    this.#waitForRegistration = waitForRegistration ?? !!identity
    this.#onLog = onLog || (() => {})
    this.#WebSocketCtor = _WebSocket || globalThis.WebSocket || null
  }

  /**
   * What the server said when it accepted the registration:
   * `{ mode: 'open'|'authenticated', verified }`. `verified` is true only when
   * the server proved the pod id against a key. An older server that sends
   * neither reads as `{ mode: 'open', verified: false }`. Null until registered.
   */
  get registration() { return this.#registration }

  /** The last authentication refusal, if any (also fired as an `auth-error` event). */
  get lastAuthError() { return this.#lastAuthError }

  /**
   * True once the server displaced this connection for a newer one of the same pod
   * (announced as a `replaced` event: `client.on('replaced', (notice) => ...)`, where the notice is
   * the server's `{ code: 'replaced', reconnect: false, message }`). This client never reconnects
   * by itself; calling `connect()` again is the application's decision, and it displaces
   * another of the pod's connections if the server's limit is reached. Cleared by `connect()`.
   */
  get replaced() { return this.#replaced }

  #markReplaced(notice) {
    if (this.#replaced) return
    this.#replaced = true
    this.#onLog(2, 'SignalingClient connection replaced by a newer connection of this pod; not reconnecting')
    this.#fire('replaced', notice)
  }

  /**
   * Whether the server vouched for the sender of a forwarded message: true only
   * for `sourceVerified: true` set by the server (it overwrites whatever the
   * sender put there). Open-mode and older servers read as false. This is the
   * server's statement about the link, not proof the peer will not lie in the
   * payload; check peer signatures where it matters.
   * @param {object} data - a message as delivered to a listener
   * @returns {boolean}
   */
  isSourceVerified(data) {
    return !!data && data.sourceVerified === true
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Open WebSocket to signaling server and register.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.#ws) return
    this.#replaced = false

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
        this.#onLog(2, `SignalingClient connected to ${this.#url}`)
        this.#beginRegistration(resolve, reject)
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

  // -- Registration (open flow and protocol 2) ------------------------------

  #canSign() {
    return !!this.#identity && this.#authentication !== 'off'
  }

  #beginRegistration(resolve, reject) {
    const reg = { resolve, reject, done: false, openSent: false, signed: false, timer: null, waits: this.#waitForRegistration }
    this.#reg = reg
    this.#registration = null
    // Without waiting, connect() resolves on open, exactly as before.
    if (!reg.waits) resolve()
    if (!this.#canSign()) {
      // No identity: register the open way at once. An authenticated server
      // answers with its challenge / `protocol-unsupported`, which is reported by name.
      this.#sendOpenRegister(reg)
      return
    }
    // With an identity: an authenticated server sends its challenge on connect;
    // an open-mode or older server sends nothing, so wait a bounded time for it.
    reg.timer = setTimeout(() => {
      reg.timer = null
      if (reg.done || reg.openSent || reg.signed) return
      if (this.#authentication === 'required') {
        this.#failRegistration(reg, new SignalingAuthError('no-challenge', 'the server sent no authentication challenge and authentication is required'))
        return
      }
      this.#sendOpenRegister(reg)
    }, this.#challengeWaitMs)
  }

  #sendOpenRegister(reg) {
    reg.openSent = true
    this.send(null, 'register', { podId: this.#localPodId })
  }

  #failRegistration(reg, err) {
    if (reg.done) return
    reg.done = true
    clearTimeout(reg.timer)
    if (this.#reg === reg) this.#reg = null
    if (err instanceof SignalingAuthError) {
      this.#lastAuthError = err
      this.#fire('auth-error', err)
    }
    this.disconnect()
    if (reg.waits) reg.reject(err)
  }

  #observeRegistration(data) {
    const reg = this.#reg
    if (!reg || reg.done) return
    if (data.type === 'registered') {
      reg.done = true
      clearTimeout(reg.timer)
      this.#reg = null
      this.#registration = { mode: data.mode === 'authenticated' ? 'authenticated' : 'open', verified: data.verified === true }
      if (reg.waits) reg.resolve()
    } else if (data.type === 'challenge') {
      this.#answerChallenge(reg, data)
    } else if (data.type === 'error') {
      const message = typeof data.message === 'string' ? data.message : 'registration refused'
      if (typeof data.code === 'string') {
        // `protocol-unsupported` from a client that could not have signed is the
        // "needs an identity" case; with an identity it is a real mismatch.
        const err = data.code === 'protocol-unsupported' && !this.#canSign()
          ? new SignalingAuthRequiredError()
          : new SignalingAuthError(data.code, message)
        this.#failRegistration(reg, err)
      } else if (reg.waits) {
        this.#failRegistration(reg, new Error(message))
      }
    }
  }

  #answerChallenge(reg, data) {
    if (reg.openSent || reg.signed) return // late or repeated: the server spends one per connection
    if (!this.#canSign()) {
      this.#failRegistration(reg, new SignalingAuthRequiredError())
      return
    }
    if (data.protocol !== SIGNALING_PROTOCOL || data.purpose !== 'register' || typeof data.nonce !== 'string') {
      this.#failRegistration(reg, new SignalingAuthError(
        'protocol-unsupported',
        `the server offered signalling protocol ${String(data.protocol)}; this client speaks ${SIGNALING_PROTOCOL}`,
      ))
      return
    }
    reg.signed = true
    clearTimeout(reg.timer)
    ;(async () => {
      // The origin is the one this client was configured with: never the
      // challenge's own `origin`, so a proof relayed to another server fails there.
      const origin = this.#origin ?? signalingOrigin(this.#url)
      const text = registrationMessage({ origin, podId: this.#localPodId, nonce: data.nonce })
      const pubKey = await this.#identity.rawPublicKey()
      const signature = await this.#identity.sign(new TextEncoder().encode(text))
      if (reg.done || !this.#ws) return
      this.#ws.send(JSON.stringify({
        type: 'register',
        protocol: SIGNALING_PROTOCOL,
        podId: this.#localPodId,
        pubKey: toBase64Url(pubKey),
        nonce: data.nonce,
        signature: toBase64Url(signature),
      }))
    })().catch((e) => {
      this.#failRegistration(reg, new SignalingAuthError('sign-failed', `could not sign the registration: ${e?.message ?? e}`))
    })
  }

  /**
   * Disconnect from the signaling server.
   */
  disconnect() {
    this.#abandonRegistration('SignalingClient disconnected before registration')
    if (!this.#ws) return
    try {
      this.#ws.removeEventListener('message', this.#handleMessage)
      this.#ws.removeEventListener('close', this.#handleClose)
      this.#ws.close()
    } catch (e) { silentCatch('handshake', 'ignore-close-errors', e) }
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
   * @returns {() => void} Unsubscribe
   */
  onOffer(cb) {
    return this.on('offer', cb)
  }

  /**
   * Register callback for incoming SDP answers.
   * @param {Function} cb - Receives (answer, fromPodId)
   * @returns {() => void} Unsubscribe
   */
  onAnswer(cb) {
    return this.on('answer', cb)
  }

  /**
   * Register callback for incoming ICE candidates.
   * @param {Function} cb - Receives (candidate, fromPodId)
   * @returns {() => void} Unsubscribe
   */
  onIceCandidate(cb) {
    return this.on('ice-candidate', cb)
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
    // The real deployed signaling server (browsermesh-servers/signaling)
    // forwards offer/answer/ice-candidate/signal messages by their
    // "target" field, not "to" -- confirmed directly against that
    // server's own source (`const {target, ...payload} = msg`). A `to`
    // field is simply ignored server-side, so every forwarded message
    // was rejected with "forwarded messages require a target field"
    // before this fix. `from` is sent for backward-compatible local
    // debugging/logging only -- the server doesn't read or forward it
    // as-is; see #fire()'s own comment for why the receiving side no
    // longer trusts it.
    const msg = JSON.stringify({
      from: this.#localPodId,
      target: remotePodId,
      type,
      ...payload,
    })
    this.#ws.send(msg)
  }

  /**
   * Register a listener for a given event type.
   * @param {string} event
   * @param {Function} cb
   * @returns {() => void} Unsubscribe (same as `off(event, cb)`)
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set())
    }
    this.#listeners.get(event).add(cb)
    return () => this.off(event, cb)
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
      this.#observeRegistration(data)
      // The server displaced this connection for a newer one of the same pod, and says not to reconnect.
      if (data.type === 'error' && data.code === 'replaced' && data.reconnect === false) this.#markReplaced(data)
      this.#fire(data.type, data)
    } catch (e) { silentCatch('handshake', 'ignore-malformed-messages', e) }
  }

  /** Stop a registration that is still in flight (the socket went away). */
  #abandonRegistration(reason) {
    const reg = this.#reg
    if (!reg) return
    clearTimeout(reg.timer)
    this.#reg = null
    if (reg.done) return
    reg.done = true
    if (reg.waits) reg.reject(new Error(reason))
  }

  /** @type {() => void} */
  #handleClose = (ev) => {
    if (ev?.code === 4409 && ev?.reason === 'replaced') {
      this.#markReplaced({ type: 'error', code: 'replaced', reconnect: false, message: 'replaced by a newer connection of the same pod' })
    }
    this.#abandonRegistration('SignalingClient WebSocket closed before registration')
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
    // The real signaling server stamps forwarded peer-to-peer messages
    // with its own "source" field, based on which authenticated
    // WebSocket connection the message actually arrived on -- that's
    // the trustworthy value. `from` is whatever the ORIGINAL sender
    // self-declared in their own outgoing payload and the server never
    // validates it before forwarding, so preferring it here would mean
    // trusting an arbitrary, spoofable claim over the server's own
    // attribution. Falls back to `from` only for non-forwarded,
    // direct server messages (e.g. `registered`) that have no `source`.
    const fromPodId = data.source ?? data.from
    for (const cb of set) {
      try { cb(data, fromPodId) } catch (e) { silentCatch('handshake', 'swallow-listener-errors', e) }
    }
  }
}

// ---------------------------------------------------------------------------
// DirectInputHandshake
// ---------------------------------------------------------------------------

/**
 * Out-of-band exchange of a peer's identity and connection parameters.
 *
 * Generates a connection token containing the local pod's identity and
 * connection parameters, shareable via clipboard paste or QR code. The
 * receiving peer decodes and validates the token, then uses it to reach
 * the issuer.
 *
 * **What this does and does not do.** The *key exchange* needs no server:
 * the token travels over whatever out-of-band channel you like. The
 * *connection* still does. A ConnectionToken carries podId, publicKey,
 * nonce, timestamp and optionally signalingUrl/iceServers -- it carries no
 * SDP offer. `HandshakeCoordinator.connectViaToken()` therefore requires
 * either an existing signalingClient or a `token.signalingUrl`, and throws
 * 'No signaling channel available' without one.
 *
 * Earlier revisions of this docstring said "direct pairing without a
 * signaling server", which read as a promise of serverless pairing. It was
 * never that. Putting an SDP offer with pre-gathered ICE candidates into
 * the token would make it that -- see issue #5 -- and is the one design
 * that needs no rendezvous, no STUN and no certificate for two peers on a
 * LAN. It is not implemented here.
 *
 * Tokens are single use: see `validateToken()`.
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
   * Nonces of tokens this instance has already accepted, mapped to the
   * timestamp at which they may be forgotten. Enforces single use.
   * @type {Map<string, number>}
   */
  #consumedNonces = new Map()

  /** @type {number} */
  #maxConsumedNonces

  /**
   * @param {object} opts
   * @param {string} opts.localPodId - Local pod identifier
   * @param {Function} opts.getPublicKeyBytes - async () => Uint8Array, returns public key bytes
   * @param {string} [opts.signalingUrl] - Optional signaling server URL to include in token
   * @param {object[]} [opts.iceServers] - Optional ICE server configs to include in token
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   * @param {number} [opts.maxConsumedNonces=10000] - Cap on the replay set. Entries
   *   normally age out with the token TTL; this cap bounds memory if a peer floods
   *   distinct tokens faster than they expire.
   */
  constructor({ localPodId, getPublicKeyBytes, signalingUrl, iceServers, onLog, maxConsumedNonces = DEFAULT_MAX_CONSUMED_NONCES } = {}) {
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
    this.#maxConsumedNonces = Number.isInteger(maxConsumedNonces) && maxConsumedNonces > 0
      ? maxConsumedNonces
      : DEFAULT_MAX_CONSUMED_NONCES
  }

  /**
   * Number of tokens currently held in the replay set. Entries age out
   * once they are past the token TTL. Exposed for observability and tests.
   * @returns {number}
   */
  get consumedTokenCount() {
    this.#pruneConsumedNonces()
    return this.#consumedNonces.size
  }

  /**
   * Forget every consumed nonce, so previously used tokens validate again.
   *
   * Only for tests and for deliberately resetting a pairing session. Calling
   * this in production re-opens the replay window for any token still inside
   * its TTL.
   */
  forgetConsumedTokens() {
    this.#consumedNonces.clear()
  }

  /**
   * Drop replay-set entries that are past their expiry, and enforce the cap.
   * @param {number} [now]
   */
  #pruneConsumedNonces(now = Date.now()) {
    for (const [key, expiresAt] of this.#consumedNonces) {
      if (expiresAt <= now) this.#consumedNonces.delete(key)
    }
    // Map iterates in insertion order, so the front is the oldest.
    while (this.#consumedNonces.size > this.#maxConsumedNonces) {
      const oldest = this.#consumedNonces.keys().next()
      if (oldest.done) break
      this.#consumedNonces.delete(oldest.value)
    }
  }

  /**
   * Replay-set key for a token. A nonce is only meaningful relative to the
   * pod that issued it, so both are part of the key.
   * @param {ConnectionToken} token
   * @returns {string}
   */
  #nonceKey(token) {
    return `${token.podId}\u0000${token.nonce}`
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
   * This is the first thing in the library that touches a scanned QR code or
   * a pasted clipboard string -- the least trustworthy input it handles -- so
   * it reports failure in one way instead of leaking whatever the platform
   * happened to throw. Previously a malformed string surfaced a raw
   * `DOMException` from `atob` or a `SyntaxError` from `JSON.parse`, neither
   * of which the signature mentioned and neither of which says anything
   * useful to the person holding the phone.
   *
   * Every failure is now a {@link TokenDecodeError} whose `cause` is the
   * original platform error, and input longer than `maxLength` is refused
   * before any allocation, so a hostile QR cannot ask for arbitrary memory.
   *
   * @param {string} encoded - base64url-encoded JSON string
   * @param {object} [opts]
   * @param {number} [opts.maxLength=MAX_ENCODED_TOKEN_LENGTH] - Reject input
   *   longer than this many characters without decoding it.
   * @returns {ConnectionToken}
   * @throws {TokenDecodeError} On non-string, oversized, non-base64url,
   *   non-JSON, or non-object input.
   */
  static decodeToken(encoded, { maxLength = MAX_ENCODED_TOKEN_LENGTH } = {}) {
    if (typeof encoded !== 'string') {
      throw new TokenDecodeError(`Token must be a string, got ${typeof encoded}`)
    }
    if (encoded.length === 0) {
      throw new TokenDecodeError('Token is empty')
    }
    if (encoded.length > maxLength) {
      throw new TokenDecodeError(
        `Token is too long: ${encoded.length} characters, limit is ${maxLength}`,
      )
    }

    let bytes
    try {
      bytes = fromBase64Url(encoded)
    } catch (cause) {
      throw new TokenDecodeError('Token is not valid base64url', { cause })
    }

    let parsed
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes))
    } catch (cause) {
      throw new TokenDecodeError('Token is not valid JSON', { cause })
    }

    // JSON.parse happily returns 123, null or "str". The declared return type
    // is an object, and validateToken() would only reject those later with a
    // vaguer message, so reject here.
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new TokenDecodeError(
        `Token JSON is not an object (got ${Array.isArray(parsed) ? 'array' : parsed === null ? 'null' : typeof parsed})`,
      )
    }
    return parsed
  }

  /**
   * Validate a received connection token.
   *
   * Checks: has podId, has publicKey, has nonce, not self, not expired
   * (5min TTL), not more than 30s in the future, and **not previously used**.
   *
   * Tokens are single use. On success the token's nonce is recorded, and any
   * later token carrying the same podId+nonce is rejected with
   * `'Token already used'`. This is what makes a token shared over an
   * observable channel — a QR code on a screen, a clipboard, a screenshot —
   * safe to show: capturing it buys one pairing at most, not five minutes of
   * unlimited pairings.
   *
   * Pass `{ consume: false }` to check a token without spending it (e.g. to
   * show the user what they scanned before they confirm). The token is then
   * still redeemable, so a consuming call must follow before it is acted on.
   *
   * @param {ConnectionToken} token
   * @param {object} [opts]
   * @param {boolean} [opts.consume=true] - Record the nonce on success
   * @returns {{ valid: boolean, error?: string }}
   */
  validateToken(token, { consume = true } = {}) {
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
    const now = Date.now()
    const age = now - token.timestamp
    if (age > TOKEN_TTL_MS) {
      return { valid: false, error: 'Token expired' }
    }
    // Reject tokens with future timestamps (clock skew tolerance: 30s)
    if (age < -30_000) {
      return { valid: false, error: 'Token timestamp is in the future' }
    }

    // Single use. Age out entries first so the set stays bounded by the TTL.
    this.#pruneConsumedNonces(now)
    const key = this.#nonceKey(token)
    if (this.#consumedNonces.has(key)) {
      this.#onLog(1, `Rejected replayed connection token from pod ${token.podId}`)
      return { valid: false, error: 'Token already used' }
    }
    if (consume) {
      // Remember it for as long as it could still be presented.
      this.#consumedNonces.set(key, token.timestamp + TOKEN_TTL_MS)
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
   * Tracks, per remote pod, the Promise for this coordinator's one and only
   * negotiation with that peer -- whichever of connectToPeer()'s own offer
   * or acceptConnection()'s handling of an incoming offer actually runs.
   * Both methods consult and populate this map so that "glare" -- two pods
   * each calling connectToPeer() on the other at close to the same time --
   * always settles on exactly one negotiation instead of each side racing
   * its own offerer AND answerer RTCPeerConnection for the same remote pod
   * (four connections total for one pair instead of one each). See #202.
   * @type {Map<string, Promise<{transport: object, sessionInfo: object}>>}
   */
  #peerConnections = new Map()

  /**
   * Deferred resolvers for connectToPeer() calls that lost the glare
   * tie-break (see #isDesignatedOfferer) and are waiting for
   * acceptConnection() to finish handling the designated offerer's
   * incoming offer for the same remotePodId, instead of sending a second,
   * competing offer of their own.
   * @type {Map<string, Array<{ resolve: Function, reject: Function }>>}
   */
  #glareWaiters = new Map()

  /** @type {object[]|null} Default ICE servers for every WebRTC transport */
  #iceServers

  /** @type {'all'|'relay'|undefined} Default iceTransportPolicy */
  #iceTransportPolicy

  /**
   * @param {object} opts
   * @param {string} opts.localPodId - Local pod identifier
   * @param {SignalingClient} [opts.signalingClient] - Signaling client instance
   * @param {object} [opts.transportFactory] - TransportFactory instance
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   * @param {object[]} [opts.iceServers] - Default STUN/TURN servers for every
   *   WebRTC transport this coordinator creates (offer side, answer side and
   *   connectViaToken). A per-call `iceServers` overrides it.
   * @param {'all'|'relay'} [opts.iceTransportPolicy] - Default
   *   `iceTransportPolicy` for those transports ('relay' = TURN-only, which
   *   needs a `turn:`/`turns:` entry in `iceServers`). A per-call value
   *   overrides it.
   */
  constructor({ localPodId, signalingClient, transportFactory, onLog, iceServers, iceTransportPolicy } = {}) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string')
    }
    this.#localPodId = localPodId
    this.#signalingClient = signalingClient || null
    this.#transportFactory = transportFactory || null
    this.#onLog = onLog || (() => {})
    this.#iceServers = iceServers || null
    this.#iceTransportPolicy = iceTransportPolicy

    // Wire incoming offer events from signaling client
    if (this.#signalingClient) {
      this.#signalingClient.onOffer((data, fromPodId) => {
        this.#fire('incoming', { remotePodId: fromPodId, offer: data.offer })
      })
    }
  }

  /**
   * Resolve the WebRTC transport options carrying ICE configuration.
   * Precedence: per-call value > `fallbackIceServers` (e.g. a token's) >
   * coordinator default. Keys are only present when a value exists, so a
   * coordinator with no ICE config leaves the transport's own defaults
   * (STUN list, 'all' policy) untouched. `config.iceServers` is kept for
   * factories/proxies that read the legacy shape.
   *
   * @param {{ iceServers?: object[], iceTransportPolicy?: string }} [perCall]
   * @param {object[]} [fallbackIceServers]
   * @returns {object}
   */
  #iceOpts(perCall = {}, fallbackIceServers) {
    const iceServers = perCall.iceServers ?? fallbackIceServers ?? this.#iceServers
    const iceTransportPolicy = perCall.iceTransportPolicy ?? this.#iceTransportPolicy
    const out = { config: { iceServers: iceServers || [] } }
    if (iceServers) out.iceServers = iceServers
    if (iceTransportPolicy) out.iceTransportPolicy = iceTransportPolicy
    return out
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
   * @param {object[]} [opts.iceServers] - ICE server configs (overrides the constructor default)
   * @param {'all'|'relay'} [opts.iceTransportPolicy] - Overrides the constructor default
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

    // Glare handling (#202): reuse whatever negotiation with this
    // remotePodId is already in flight or established, rather than
    // starting a second, competing one.
    const existing = this.#peerConnections.get(remotePodId)
    if (existing) {
      this.#onLog(2, `Reusing existing connection/negotiation with ${remotePodId}`)
      return existing
    }

    if (!this.#isDesignatedOfferer(remotePodId)) {
      // Both sides discover each other independently and both call
      // connectToPeer() on each other at close to the same time -- classic
      // WebRTC "glare". Resolve it with a deterministic tie-breaker both
      // sides can compute alone, with no further coordination: the pod
      // whose ID sorts lower is always the designated offerer. We are not
      // it, so don't race our own offer -- wait for remotePodId's offer to
      // arrive over signaling and be handled by acceptConnection(), and
      // adopt that session instead.
      this.#onLog(2, `Deferring to ${remotePodId} as designated offerer (glare tie-break)`)
      return this.#waitForPeerConnection(remotePodId, timeout)
    }

    this.#onLog(2, `Initiating connection to ${remotePodId}`)

    const endpointOpts = opts.endpoints || { webrtc: this.#iceOpts(opts) }

    const promise = (async () => {
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

      // TransportFactory.negotiate() returns a transport that has been
      // created but not yet connected (see its docstring) -- no offer,
      // answer or ICE candidate has crossed the wire yet. Mirror
      // acceptConnection()'s `await transport.handleOffer(offer)` on the
      // answerer side by actually driving the handshake here before this
      // session is adopted as 'connected'.
      if (typeof transport.connect === 'function') {
        await transport.connect()
      }

      const sessionInfo = {
        localPodId: this.#localPodId,
        remotePodId,
        transportType: transport.type,
        establishedAt: Date.now(),
      }

      this.#onLog(2, `Connected to ${remotePodId} via ${transport.type}`)
      const result = { transport, sessionInfo }
      this.#forgetPeerConnectionOnClose(remotePodId, transport)
      this.#fire('connected', { remotePodId, transport, sessionInfo })
      return result
    })()

    this.#settlePeerConnection(remotePodId, promise)
    return promise
  }

  /**
   * Accept an incoming connection from a remote peer.
   *
   * Handles an incoming WebRTC offer by creating a transport via the
   * factory and invoking its handleOffer method.
   *
   * @param {string} remotePodId - Initiating peer identifier
   * @param {object} offer - SDP offer
   * @param {object} [opts]
   * @param {object[]} [opts.iceServers] - Overrides the constructor default
   * @param {'all'|'relay'} [opts.iceTransportPolicy] - Overrides the constructor default
   * @returns {Promise<{ transport: object, sessionInfo: object }>}
   */
  async acceptConnection(remotePodId, offer, opts = {}) {
    if (!this.#transportFactory) {
      throw new Error('TransportFactory is required for acceptConnection')
    }
    if (!this.#signalingClient) {
      throw new Error('SignalingClient is required for acceptConnection')
    }

    // Glare handling (#202): mirror connectToPeer()'s dedup.
    const existing = this.#peerConnections.get(remotePodId)
    if (existing) {
      if (this.#isDesignatedOfferer(remotePodId)) {
        // We are the designated offerer for this pair and already have our
        // own negotiation with remotePodId in flight or established. This
        // incoming offer is a late/duplicate glare offer from the side
        // that should have deferred to ours -- ignore it instead of
        // starting a second, competing negotiation.
        this.#onLog(1, `Ignoring incoming offer from ${remotePodId}: already the designated offerer (glare tie-break)`)
        return existing
      }
      // Not the designated offerer, and already negotiating/negotiated
      // with remotePodId (a duplicate/retried offer for the same pair,
      // or this accept is already underway) -- reuse it.
      this.#onLog(2, `Reusing existing negotiation with ${remotePodId}`)
      return existing
    }

    this.#onLog(2, `Accepting connection from ${remotePodId}`)

    const promise = (async () => {
      const transport = await this.#transportFactory.create('webrtc', {
        localPodId: this.#localPodId,
        remotePodId,
        signaler: this.#signalingClient,
        ...this.#iceOpts(opts),
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
      const result = { transport, sessionInfo }
      this.#forgetPeerConnectionOnClose(remotePodId, transport)
      this.#fire('connected', { remotePodId, transport, sessionInfo })
      return result
    })()

    this.#settlePeerConnection(remotePodId, promise)
    return promise
  }

  /**
   * Connect to a peer using a DirectInputHandshake connection token.
   *
   * Parses the token, optionally creates a signaling client from the
   * token's signalingUrl, and negotiates a transport.
   *
   * Note on lifetimes: `TransportFactory.negotiate()` returns a transport that
   * has been *created but not yet connected* — no offer, answer or ICE
   * candidate has crossed the wire when it resolves. A signaler this method
   * created is therefore kept open past negotiate() and torn down on the
   * transport's `close` event instead. When the transport exposes no
   * `onClose()`, ownership passes to the caller via the returned `signaler`.
   *
   * @param {ConnectionToken} token - Decoded connection token
   * @param {object} [transportFactory] - Override transport factory
   * @param {object} [opts]
   * @param {object[]} [opts.iceServers] - Overrides token.iceServers and the constructor default
   * @param {'all'|'relay'} [opts.iceTransportPolicy] - Overrides the constructor default
   * @returns {Promise<{ transport: object, sessionInfo: object, signaler: SignalingClient|null }>}
   *   `signaler` is the client this call created and still owns, or null when
   *   the coordinator's own signaling client was used.
   */
  async connectViaToken(token, transportFactory, opts = {}) {
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

    const endpointOpts = {
      webrtc: this.#iceOpts(opts, token.iceServers),
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

      // Do NOT disconnect here. negotiate() returns a created-but-unconnected
      // transport; the signaling channel is about to carry the offer, the
      // answer and every ICE candidate. Tear it down when the transport does.
      if (createdSignaler && signaler) {
        if (typeof transport.onClose === 'function') {
          transport.onClose(() => signaler.disconnect())
        } else {
          this.#onLog(
            1,
            'Transport exposes no onClose(); returning the signaling client for the caller to disconnect',
          )
        }
      }

      this.#fire('connected', { remotePodId, transport, sessionInfo })
      return { transport, sessionInfo, signaler: createdSignaler ? signaler : null }
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
   * Deterministic glare tie-break (#202): exactly one side of any pod pair
   * is the designated offerer, decided purely from both pods' own IDs so
   * both sides agree without any further coordination -- neither needs to
   * know what the other is doing, only its ID. The lower podId is always
   * the designated offerer; the higher podId always defers to the
   * incoming offer instead of sending its own.
   * @param {string} remotePodId
   * @returns {boolean} true when the local pod is the designated offerer.
   */
  #isDesignatedOfferer(remotePodId) {
    return this.#localPodId < remotePodId
  }

  /**
   * Wait for acceptConnection() to settle a negotiation for remotePodId
   * that this coordinator lost the glare tie-break for, instead of racing
   * a second offer of its own. Resolves/rejects exactly like the
   * negotiation itself; rejects on timeout, matching connectToPeer()'s own
   * "Connection timeout" behavior for the offerer path.
   * @param {string} remotePodId
   * @param {number} timeoutMs
   * @returns {Promise<{transport: object, sessionInfo: object}>}
   */
  #waitForPeerConnection(remotePodId, timeoutMs) {
    // Re-check: acceptConnection() may have already settled this between
    // connectToPeer()'s own check and this call.
    const existing = this.#peerConnections.get(remotePodId)
    if (existing) return existing

    return new Promise((resolve, reject) => {
      const entry = {}
      const timeoutHandle = setTimeout(() => {
        const list = this.#glareWaiters.get(remotePodId)
        if (list) {
          const idx = list.indexOf(entry)
          if (idx !== -1) list.splice(idx, 1)
          if (list.length === 0) this.#glareWaiters.delete(remotePodId)
        }
        reject(new Error(`Timed out waiting for ${remotePodId}'s offer (lost glare tie-break)`))
      }, timeoutMs)
      entry.resolve = (value) => { clearTimeout(timeoutHandle); resolve(value) }
      entry.reject = (err) => { clearTimeout(timeoutHandle); reject(err) }

      if (!this.#glareWaiters.has(remotePodId)) this.#glareWaiters.set(remotePodId, [])
      this.#glareWaiters.get(remotePodId).push(entry)
    })
  }

  /**
   * Record `promise` as this coordinator's one negotiation with
   * remotePodId, and wake any connectToPeer() calls that deferred to it
   * (see #waitForPeerConnection) once it settles. On rejection, forgets
   * the entry so a later, genuine reconnection attempt isn't permanently
   * blocked by a failed one.
   * @param {string} remotePodId
   * @param {Promise<{transport: object, sessionInfo: object}>} promise
   */
  #settlePeerConnection(remotePodId, promise) {
    this.#peerConnections.set(remotePodId, promise)
    promise.then(
      (value) => {
        const waiters = this.#glareWaiters.get(remotePodId)
        if (!waiters) return
        this.#glareWaiters.delete(remotePodId)
        for (const w of waiters) w.resolve(value)
      },
      (err) => {
        if (this.#peerConnections.get(remotePodId) === promise) {
          this.#peerConnections.delete(remotePodId)
        }
        const waiters = this.#glareWaiters.get(remotePodId)
        if (!waiters) return
        this.#glareWaiters.delete(remotePodId)
        for (const w of waiters) w.reject(err)
      },
    )
  }

  /**
   * Once an established session's transport actually closes, forget it so
   * a genuine future reconnection to remotePodId isn't permanently blocked
   * by #peerConnections/#isDesignatedOfferer dedup (#202). No-op when the
   * transport exposes no onClose (mirrors connectViaToken()'s own handling
   * of that case).
   * @param {string} remotePodId
   * @param {object} transport
   */
  #forgetPeerConnectionOnClose(remotePodId, transport) {
    if (typeof transport.onClose !== 'function') return
    transport.onClose(() => {
      // Only delete if this transport's own entry is still the current
      // one -- a newer negotiation for the same remotePodId may already
      // have replaced it by the time this fires.
      const current = this.#peerConnections.get(remotePodId)
      if (!current) return
      current.then((v) => {
        if (v && v.transport === transport) this.#peerConnections.delete(remotePodId)
      }, () => {})
    })
  }

  /**
   * Fire all listeners for a given event, swallowing listener errors.
   * @param {string} event
   * @param {*} data
   */
  #fire(event, data) {
    const set = this.#listeners.get(event)
    if (!set) return
    for (const cb of set) {
      try { cb(data) } catch (e) { silentCatch('handshake', 'swallow-listener-errors', e) }
    }
  }
}

export { TOKEN_TTL_MS, DEFAULT_TIMEOUT_MS, toBase64Url, fromBase64Url }
