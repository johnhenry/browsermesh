/**
 * ws-transport.mjs — WebSocket-backed TransportAdapter for hosted pods.
 *
 * Speaks the `browsermesh-servers` relay/signaling wire protocol so a Pod
 * can run anywhere a WebSocket client is available (Node.js, a browser,
 * or a V8 isolate / workerd) and still reach the same mesh a
 * BroadcastChannel-based Pod reaches in a browser tab.
 *
 * Wire protocol (verified against `browsermesh-servers/relay/index.mjs`
 * and `browsermesh-servers/signaling/index.mjs`):
 *   - register:  { type: 'register', podId }
 *   - registered: { type: 'registered', podId }
 *   - relay (client -> relay server): { type: 'relay', target, envelope }
 *   - relayed (relay server -> client): { type: 'relayed', source, envelope }
 *   - signal (client -> signaling server): { type: 'signal', target, envelope }
 *     forwarded by the signaling server as: { type: 'signal', source, envelope }
 *     (the signaling server spreads the forwarded payload and injects `source`,
 *     so any extra keys like `envelope` survive the hop unchanged)
 *   - peers: { type: 'peers', peers: string[] } (signaling only, sent once on registration,
 *     in a frame AFTER `registered`: `open()` can resolve before it is handled)
 *   - peer-joined / peer-left: { type: 'peer-joined'|'peer-left', podId } (signaling only)
 *   - ping / pong: { type: 'ping' } / { type: 'pong' }
 *   - error: { type: 'error', message }
 *
 * NOTE: the relay server's wire protocol uses `target`/`source`, not
 * `to`/`from` as the WP1 design sketch in issue #185 describes — this
 * adapter speaks the server's real field names and remaps to the Pod
 * message shape (`from`) on the way in.
 *
 * The relay server only forwards point-to-point (`relay{target, envelope}`
 * -> `relayed{source, envelope}`); it has no broadcast/room concept. So a
 * broadcast send (`msg.to` absent or `'*'`, e.g. discovery `hello`/`goodbye`)
 * is fanned out point-to-point.
 *
 * The server's list of who is connected (`peers`, `peer-joined`, `peer-left`)
 * and the `source` it stamps on a relayed frame are written by the server, so
 * they are HINTS of whom to greet, never membership. The transport keeps the
 * two apart: a hinted peer is sent a `pod:hello` (that is what a hint is for),
 * and only a peer that discovery has confirmed (`confirmPeer`, called once the
 * peer's signed hello or ack verified) is sent any other broadcast. A relay
 * that names a pod therefore does not make it a recipient of broadcasts.
 */

const DEFAULT_RECONNECT = { baseMs: 250, maxMs: 10000, maxAttempts: Infinity }

/** The registration protocol this transport speaks when a signalling server offers it. */
export const SIGNALING_PROTOCOL = 2
export const DEFAULT_CHALLENGE_WAIT_MS = 2000

/**
 * A registration the signalling server refused, or one this transport could
 * not complete. `code` is the server's own where it sent one
 * (`protocol-unsupported`, `bad-nonce`, `challenge-expired`, `bad-pod-id`,
 * `bad-key`, `bad-signature`, `pod-id-mismatch`) or this transport's
 * (`no-challenge`, `auth-required`, `sign-failed`).
 */
export class SignalingAuthError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'SignalingAuthError'
    this.code = code
  }
}

/** The server requires protocol 2 (a signed registration) and this transport has no identity to sign with. */
export class SignalingAuthRequiredError extends SignalingAuthError {
  constructor(message = 'the signalling server requires authenticated registration (protocol 2): pass { identity } (a PodIdentity) to WebSocketTransport') {
    super('auth-required', message)
    this.name = 'SignalingAuthRequiredError'
  }
}

/** The ws:// / wss:// origin a registration is signed for, from the URL this transport was configured with. */
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
  return `browsermesh-signaling/2\npurpose:register\norigin:${origin}\npodId:${podId}\nnonce:${nonce}`
}

function toBase64Url(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Refusals that retrying the same way cannot fix: the transport stops reconnecting on them. */
const PERMANENT_AUTH_CODES = new Set(['auth-required', 'protocol-unsupported', 'no-challenge', 'bad-pod-id', 'bad-key', 'bad-signature', 'pod-id-mismatch', 'sign-failed'])

/**
 * TransportAdapter backed by a WebSocket connection to a browsermesh relay
 * (or signaling) server. Implements the same `send/onMessage/open/close/ready`
 * contract as BroadcastChannelTransport and EventEmitterTransport.
 */
export class WebSocketTransport {
  #url
  #podId
  #WS
  #protocol
  #signalingUrl
  #peersFromSignaling
  #reconnect
  #onLog

  #ws = null
  #sigWs = null
  #handler = null
  #ready = false
  #closed = true
  #hintedPeers = new Set()
  #verifiedPeers = new Set()
  #peerJoinedHandlers = new Set()
  /** pod ids the signalling server itself stamped `verified` (a statement by the server, not a peer's signature) */
  #serverVerifiedPeers = new Set()

  #identity
  #authentication
  #origin
  #challengeWaitMs
  #registration = null

  #primaryReconnect = { attempts: 0, timer: null, halted: false }
  #sigReconnect = { attempts: 0, timer: null, halted: false }

  /**
   * @param {object} opts
   * @param {string} opts.url - WebSocket URL of the relay (or signaling) server
   * @param {string} opts.podId - this pod's id, sent on `register`
   * @param {Function|null} [opts.WebSocket] - injectable WebSocket constructor (default: globalThis.WebSocket; pass `null` explicitly to force "unavailable" for testing)
   * @param {'relay'|'signaling'} [opts.protocol='relay'] - wire dialect for `url`
   * @param {string} [opts.signalingUrl] - signaling server URL, used when `peersFromSignaling` is true
   * @param {boolean} [opts.peersFromSignaling=false] - open a second connection to `signalingUrl` to seed `knownPeers` from `peers`/`peer-joined`/`peer-left`
   * @param {{baseMs?: number, maxMs?: number, maxAttempts?: number}} [opts.reconnect] - exponential backoff config
   * @param {(msg: string) => void} [opts.onLog] - diagnostic log sink
   * @param {object} [opts.identity] - a `PodIdentity` (or anything with `podId`, `rawPublicKey()` and `sign(bytes)`). Lets the transport answer a signalling server's authenticated-registration challenge (protocol 2); its `podId` must equal `podId`. Used only for the signalling dialect (`protocol: 'signaling'` and the `signalingUrl` connection); the relay dialect is unchanged.
   * @param {'auto'|'required'|'off'} [opts.authentication='auto'] - `auto`: protocol 2 when the server offers it, else register as before. `required`: never fall back to the open flow (needs `identity`). `off`: never sign.
   * @param {string} [opts.origin] - the server origin to sign when it differs from the URL's (a server reached through a proxy or internal name). Defaults to the origin of the URL being connected to.
   * @param {number} [opts.challengeWaitMs=2000] - with an identity in `auto` mode: how long to wait for the challenge before registering the open way (an open-mode or older server sends none)
   */
  constructor({
    url,
    podId,
    WebSocket: WS,
    protocol = 'relay',
    signalingUrl,
    peersFromSignaling = false,
    reconnect = {},
    onLog,
    identity = null,
    authentication = 'auto',
    origin,
    challengeWaitMs = DEFAULT_CHALLENGE_WAIT_MS,
  } = {}) {
    if (!url) throw new Error('WebSocketTransport requires { url }')
    if (!podId) throw new Error('WebSocketTransport requires { podId }')
    if (authentication !== 'auto' && authentication !== 'required' && authentication !== 'off') {
      throw new TypeError("authentication must be 'auto', 'required' or 'off'")
    }
    if (identity) {
      if (typeof identity.sign !== 'function' || typeof identity.rawPublicKey !== 'function') {
        throw new TypeError('identity must provide podId, rawPublicKey() and sign(bytes) (a PodIdentity)')
      }
      if (identity.podId !== podId) {
        throw new TypeError('identity.podId must equal podId: the server binds the pod id to the key')
      }
    }
    if (authentication === 'required' && !identity) throw new SignalingAuthRequiredError()
    this.#identity = identity || null
    this.#authentication = authentication
    this.#origin = origin ?? null
    this.#challengeWaitMs = challengeWaitMs
    this.#url = url
    this.#podId = podId
    this.#WS = WS !== undefined ? WS : globalThis.WebSocket
    this.#protocol = protocol === 'signaling' ? 'signaling' : 'relay'
    this.#signalingUrl = signalingUrl || null
    this.#peersFromSignaling = !!peersFromSignaling
    this.#reconnect = { ...DEFAULT_RECONNECT, ...reconnect }
    this.#onLog = onLog || (() => {})
  }

  /**
   * The relay stamps `source` and can rewrite or inject envelopes, so nothing
   * about a message is authenticated by this link. A pod requires signed
   * messages over it unless told otherwise (`allowUnsigned`).
   */
  get trust() { return 'untrusted' }

  /** @returns {boolean} true once the primary connection is registered */
  get ready() { return this.#ready }

  /**
   * Pod ids the server (or a relayed frame's `source`) has named, plus the confirmed ones.
   * These are hints: do not treat membership of this set as proof that a peer exists.
   * @returns {Set<string>}
   */
  get knownPeers() { return new Set([...this.#hintedPeers, ...this.#verifiedPeers]) }

  /** @returns {Set<string>} pod ids confirmed by discovery (their signed hello or ack verified): the recipients of broadcasts */
  get verifiedPeers() { return new Set(this.#verifiedPeers) }

  /**
   * Pod ids the signalling server itself stamped verified (it checked that the
   * id is the hash of a key the pod proved it holds). This is the server's word
   * about a link: it is still a hint, it does not make a pod a broadcast
   * recipient (`verifiedPeers` does that, on the pod's own signature), and it is
   * empty against an open-mode or older server.
   * @returns {Set<string>}
   */
  get serverVerifiedPeers() { return new Set(this.#serverVerifiedPeers) }

  /**
   * What the signalling server said when it accepted the registration:
   * `{ mode: 'open'|'authenticated', verified }`; an older server that says
   * neither reads as open and unverified. Null until registered (and for the
   * relay dialect).
   * @returns {{ mode: string, verified: boolean }|null}
   */
  get registration() { return this.#registration }

  /**
   * Record that discovery verified this peer. From now on a broadcast reaches it.
   * @param {string} podId
   */
  confirmPeer(podId) {
    if (typeof podId === 'string' && podId && podId !== this.#podId) this.#verifiedPeers.add(podId)
  }

  /**
   * Forget a peer (it said goodbye): it stops receiving broadcasts, and a later
   * announcement of it by the server is greeted again.
   * @param {string} podId
   */
  forgetPeer(podId) {
    this.#verifiedPeers.delete(podId)
    this.#hintedPeers.delete(podId)
    this.#serverVerifiedPeers.delete(podId)
  }

  /**
   * @param {(msg: object) => void} handler
   */
  onMessage(handler) {
    this.#handler = handler
  }

  /**
   * Be told about each peer id the server announces (`peers`, `peer-joined`)
   * that this transport did not know yet. `peers` follows `registered` in a
   * later frame, and pods can join at any time, so discovery must react to
   * these rather than assume the list is complete when `open()` resolves.
   * @param {(podId: string) => void} handler
   * @returns {() => void} unsubscribe
   */
  onPeerJoined(handler) {
    this.#peerJoinedHandlers.add(handler)
    return () => this.#peerJoinedHandlers.delete(handler)
  }

  /**
   * Connect to the relay server (and, if configured, the signaling server)
   * and complete registration. Resolves once `registered` arrives on the
   * primary connection; rejects if the connection errors or closes first.
   */
  async open() {
    if (!this.#WS) {
      throw new Error(
        'WebSocketTransport: no WebSocket constructor available — pass { WebSocket } ' +
        'or run in an environment with a global WebSocket (browser, Node >=22, workerd)'
      )
    }
    if (this.#ready) return
    this.#closed = false
    this.#primaryReconnect.halted = false
    this.#sigReconnect.halted = false

    const tasks = [this.#connectAndRegister('primary')]
    if (this.#peersFromSignaling && this.#signalingUrl) {
      tasks.push(this.#connectAndRegister('signaling'))
    }
    await Promise.all(tasks)
  }

  /**
   * Send a message. Point-to-point if `msg.to` names a specific peer;
   * otherwise (no `to`, or `to === '*'` — discovery hello/goodbye) fan
   * out point-to-point to every known peer, since the relay/signaling
   * servers have no broadcast primitive.
   * @param {object} msg
   */
  send(msg) {
    if (!this.#ws || !this.#ready || !msg) return
    const to = msg.to
    if (to && to !== '*') {
      this.#sendEnvelope(to, msg)
      return
    }
    // A hello goes to everyone the server named (that is how peers are found);
    // anything else only to peers that proved themselves.
    const recipients = msg.type === 'pod:hello'
      ? new Set([...this.#hintedPeers, ...this.#verifiedPeers])
      : this.#verifiedPeers
    for (const peerId of recipients) {
      this.#sendEnvelope(peerId, msg)
    }
  }

  /** Close both connections and clear any pending reconnect timers. */
  async close() {
    this.#closed = true
    this.#clearTimer(this.#primaryReconnect)
    this.#clearTimer(this.#sigReconnect)
    this.#ready = false
    if (this.#ws) {
      try { this.#ws.close() } catch { /* already closed */ }
      this.#ws = null
    }
    if (this.#sigWs) {
      try { this.#sigWs.close() } catch { /* already closed */ }
      this.#sigWs = null
    }
  }

  // ── Private: outbound ────────────────────────────────────────────

  #sendEnvelope(target, envelope) {
    const frame = this.#protocol === 'signaling'
      ? { type: 'signal', target, envelope }
      : { type: 'relay', target, envelope }
    this.#send(this.#ws, frame)
  }

  #send(ws, data) {
    if (!ws) return
    try {
      if (ws.readyState === undefined || ws.readyState === 1 /* OPEN */) {
        ws.send(JSON.stringify(data))
      }
    } catch { /* socket may be mid-teardown; reconnect loop recovers */ }
  }

  // ── Private: connection lifecycle ────────────────────────────────

  /**
   * Open one WebSocket connection (`kind` is 'primary' or 'signaling'),
   * register, and wire message/close handling. Resolves on `registered`,
   * rejects on `error` or on close-before-registered. Always schedules a
   * reconnect on close (unless `close()` has been called).
   * @param {'primary'|'signaling'} kind
   */
  #connectAndRegister(kind) {
    const isPrimary = kind === 'primary'
    const url = isPrimary ? this.#url : this.#signalingUrl

    return new Promise((resolve, reject) => {
      let settled = false
      let ws

      try {
        ws = new this.#WS(url)
      } catch (err) {
        this.#scheduleReconnect(kind)
        reject(err)
        return
      }

      if (isPrimary) this.#ws = ws
      else this.#sigWs = ws

      const finishResolve = () => {
        if (settled) return
        settled = true
        if (isPrimary) {
          this.#ready = true
          this.#primaryReconnect.attempts = 0
        } else {
          this.#sigReconnect.attempts = 0
        }
        resolve()
      }
      const finishReject = (err) => {
        if (settled) return
        settled = true
        clearTimeout(challengeTimer)
        reject(err)
      }

      // Registration against a signalling server may be authenticated
      // (protocol 2); the relay dialect never is.
      const speaksSignaling = !isPrimary || this.#protocol === 'signaling'
      const canSign = speaksSignaling && !!this.#identity && this.#authentication !== 'off'
      const state = isPrimary ? this.#primaryReconnect : this.#sigReconnect
      let challengeTimer = null
      let openSent = false
      let signed = false

      /** A refusal that is final for this connection: say so by name, stop, and do not retry what cannot change. */
      const refuse = (err) => {
        if (err instanceof SignalingAuthError && PERMANENT_AUTH_CODES.has(err.code)) state.halted = true
        this.#onLog(`[ws-transport] ${kind} registration refused: ${err.code ?? err.message}`)
        finishReject(err)
        try { ws.close() } catch { /* already closed */ }
      }

      const sendOpenRegister = () => {
        openSent = true
        this.#send(ws, { type: 'register', podId: this.#podId })
      }

      const answerChallenge = (data) => {
        if (openSent || signed || settled) return
        if (!canSign) {
          refuse(new SignalingAuthRequiredError())
          return
        }
        if (data.protocol !== SIGNALING_PROTOCOL || data.purpose !== 'register' || typeof data.nonce !== 'string') {
          refuse(new SignalingAuthError('protocol-unsupported', `the server offered signalling protocol ${String(data.protocol)}; this transport speaks ${SIGNALING_PROTOCOL}`))
          return
        }
        signed = true
        clearTimeout(challengeTimer)
        ;(async () => {
          // The origin is the one this transport was configured with, never the
          // challenge's own `origin`: a proof relayed to another server fails there.
          const origin = this.#origin ?? signalingOrigin(url)
          const text = registrationMessage({ origin, podId: this.#podId, nonce: data.nonce })
          const pubKey = await this.#identity.rawPublicKey()
          const signature = await this.#identity.sign(new TextEncoder().encode(text))
          if (settled) return
          this.#send(ws, {
            type: 'register',
            protocol: SIGNALING_PROTOCOL,
            podId: this.#podId,
            pubKey: toBase64Url(pubKey),
            nonce: data.nonce,
            signature: toBase64Url(signature),
          })
        })().catch((e) => refuse(new SignalingAuthError('sign-failed', `could not sign the registration: ${e?.message ?? e}`)))
      }

      const onOpen = () => {
        if (!speaksSignaling || !canSign) {
          // The relay dialect, or no identity: register as before. An
          // authenticated server answers a signalling client without one with
          // its challenge / `protocol-unsupported`, reported by name below.
          sendOpenRegister()
          return
        }
        // With an identity: an authenticated server sends its challenge on
        // connect; an open-mode or older server sends none, so wait a bounded time.
        challengeTimer = setTimeout(() => {
          challengeTimer = null
          if (settled || openSent || signed) return
          if (this.#authentication === 'required') {
            refuse(new SignalingAuthError('no-challenge', 'the server sent no authentication challenge and authentication is required'))
            return
          }
          sendOpenRegister()
        }, this.#challengeWaitMs)
      }
      const handle = (data) => {
        if (!data) return
        if (speaksSignaling && !settled && data.type === 'challenge') {
          answerChallenge(data)
          return
        }
        if (isPrimary) this.#handlePrimaryMessage(data)
        else this.#handleSignalingMessage(data)

        if (data.type === 'registered') {
          if (speaksSignaling) {
            this.#registration = { mode: data.mode === 'authenticated' ? 'authenticated' : 'open', verified: data.verified === true }
          }
          finishResolve()
        } else if (data.type === 'error') {
          if (speaksSignaling && !settled && typeof data.code === 'string') {
            // `protocol-unsupported` to a transport that could not have signed is the "needs an identity" case.
            refuse(data.code === 'protocol-unsupported' && !canSign
              ? new SignalingAuthRequiredError()
              : new SignalingAuthError(data.code, data.message || 'registration refused'))
          } else {
            finishReject(new Error(data.message || `WebSocketTransport: ${kind} registration error`))
          }
        }
      }
      // A Blob frame can only be read asynchronously. Once one is in flight,
      // every later frame on this socket queues behind it so frames are still
      // handled in arrival order; with no Blob in flight nothing changes and
      // frames are handled synchronously.
      let blobQueue = null
      const onMessage = (event) => {
        if (typeof Blob !== 'undefined' && event.data instanceof Blob) {
          const prior = blobQueue ?? Promise.resolve()
          const mine = prior
            .then(() => event.data.arrayBuffer())
            .then((buf) => handle(this.#parse({ data: buf })), () => {})
          blobQueue = mine
          mine.then(() => { if (blobQueue === mine) blobQueue = null })
          return
        }
        if (blobQueue) {
          const mine = blobQueue.then(() => handle(this.#parse(event)))
          blobQueue = mine
          mine.then(() => { if (blobQueue === mine) blobQueue = null })
          return
        }
        handle(this.#parse(event))
      }
      const onClose = () => {
        if (isPrimary) { this.#ready = false; this.#ws = null }
        else { this.#sigWs = null }
        finishReject(new Error(`WebSocketTransport: ${kind} connection closed`))
        this.#scheduleReconnect(kind)
      }
      const onError = (err) => {
        this.#onLog(`[ws-transport] ${kind} socket error: ${err?.message ?? err}`)
      }

      ws.addEventListener('open', onOpen)
      ws.addEventListener('message', onMessage)
      ws.addEventListener('close', onClose)
      ws.addEventListener('error', onError)
    })
  }

  #parse(event) {
    try {
      // Wire contract (same rule as @johnhenry/browsermesh-transport's
      // encodeWireData): strings pass through untouched, binary is read as
      // UTF-8 text, and the only JSON step is this one parse of the frame.
      // Outbound, #send stringifies each control frame exactly once; the
      // pod message rides inside it as a nested object, never as a
      // pre-encoded string, so nothing is double-encoded.
      const d = event.data
      let raw
      if (typeof d === 'string') raw = d
      else if (d instanceof ArrayBuffer) raw = new TextDecoder().decode(d)
      else if (ArrayBuffer.isView(d)) raw = new TextDecoder().decode(d)
      else return null // anything else (Blobs are read by the caller first): not a frame we can read
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  #scheduleReconnect(kind) {
    if (this.#closed) return
    const state = kind === 'primary' ? this.#primaryReconnect : this.#sigReconnect
    if (state.halted) {
      this.#onLog(`[ws-transport] not reconnecting ${kind}: the server refused the registration`)
      return
    }
    if (state.attempts >=this.#reconnect.maxAttempts) {
      this.#onLog(`[ws-transport] giving up reconnect for ${kind} after ${state.attempts} attempts`)
      return
    }
    const delay = Math.min(this.#reconnect.baseMs * 2 ** state.attempts, this.#reconnect.maxMs)
    state.attempts++
    state.timer = setTimeout(() => {
      state.timer = null
      this.#connectAndRegister(kind).catch((err) => {
        this.#onLog(`[ws-transport] reconnect attempt failed (${kind}): ${err.message}`)
      })
    }, delay)
  }

  #clearTimer(state) {
    if (state.timer) {
      clearTimeout(state.timer)
      state.timer = null
    }
  }

  // ── Private: inbound ──────────────────────────────────────────────

  #handlePrimaryMessage(data) {
    // A signaling server used as the primary connection announces peers on it.
    if (this.#protocol === 'signaling' && this.#handlePeerFrame(data)) return
    switch (data.type) {
      case 'relayed':
      case 'signal': {
        if (data.source) {
          this.#hintedPeers.add(data.source)
          // Only the server's own stamp counts, and only a literal true.
          if (data.sourceVerified === true) this.#serverVerifiedPeers.add(data.source)
          else this.#serverVerifiedPeers.delete(data.source)
        }
        this.#deliver(data.source, data.envelope, data.sourceVerified === true)
        return
      }
      case 'ping':
        this.#send(this.#ws, { type: 'pong' })
        return
      case 'error':
        this.#onLog(`[ws-transport] relay error: ${data.message}`)
        return
      default:
        return
    }
  }

  /**
   * Apply a `peers` / `peer-joined` / `peer-left` frame to `knownPeers`.
   * Newly learned peers are announced to `onPeerJoined` handlers.
   * @returns {boolean} true if the frame was one of those three
   */
  #handlePeerFrame(data) {
    switch (data.type) {
      case 'peers': {
        for (const id of data.peers || []) {
          this.#stampPeer(id, data.verified === true)
          this.#learnPeer(id)
        }
        return true
      }
      case 'peer-joined': {
        this.#stampPeer(data.podId, data.verified === true)
        this.#learnPeer(data.podId)
        return true
      }
      case 'peer-left': {
        // Only the hint goes: whether a pod has left is for its own goodbye to say.
        if (data.podId) {
          this.#hintedPeers.delete(data.podId)
          this.#serverVerifiedPeers.delete(data.podId)
        }
        return true
      }
      default:
        return false
    }
  }

  /** Record the server's own `verified` stamp for a peer it announced (a literal true only). */
  #stampPeer(id, verified) {
    if (typeof id !== 'string' || !id || id === this.#podId) return
    if (verified) this.#serverVerifiedPeers.add(id)
    else this.#serverVerifiedPeers.delete(id)
  }

  #learnPeer(id) {
    if (!id || id === this.#podId || this.#hintedPeers.has(id)) return
    this.#hintedPeers.add(id)
    for (const handler of this.#peerJoinedHandlers) {
      try { handler(id) } catch { /* a handler error must not break frame handling */ }
    }
  }

  #handleSignalingMessage(data) {
    if (this.#handlePeerFrame(data)) return
    switch (data.type) {
      case 'ping':
        this.#send(this.#sigWs, { type: 'pong' })
        return
      case 'error':
        this.#onLog(`[ws-transport] signaling error: ${data.message}`)
        return
      default:
        return
    }
  }

  #deliver(source, envelope, sourceVerified = false) {
    if (!this.#handler || !envelope || typeof envelope !== 'object') return
    // `source` is written by the relay. It is passed on as `relaySource` for
    // diagnostics and is never used as the sender's identity: the envelope's
    // own `from` is a claim too, and a pod checks it against a signature.
    // `relaySourceVerified` is the signalling server's own stamp on `source`
    // (it checked the pod id against a key); both are set after the envelope
    // is spread, so nothing the sender wrote can stand in for them.
    const msg = { ...envelope, relaySource: source, relaySourceVerified: sourceVerified === true }
    this.#handler(msg)
  }
}
