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
 *   - peers: { type: 'peers', peers: string[] } (signaling only, sent once on registration)
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
 * is fanned out point-to-point to every peer id this transport currently
 * knows about (see `knownPeers`).
 */

const DEFAULT_RECONNECT = { baseMs: 250, maxMs: 10000, maxAttempts: Infinity }

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
  #knownPeers = new Set()

  #primaryReconnect = { attempts: 0, timer: null }
  #sigReconnect = { attempts: 0, timer: null }

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
  } = {}) {
    if (!url) throw new Error('WebSocketTransport requires { url }')
    if (!podId) throw new Error('WebSocketTransport requires { podId }')
    this.#url = url
    this.#podId = podId
    this.#WS = WS !== undefined ? WS : globalThis.WebSocket
    this.#protocol = protocol === 'signaling' ? 'signaling' : 'relay'
    this.#signalingUrl = signalingUrl || null
    this.#peersFromSignaling = !!peersFromSignaling
    this.#reconnect = { ...DEFAULT_RECONNECT, ...reconnect }
    this.#onLog = onLog || (() => {})
  }

  /** @returns {boolean} true once the primary connection is registered */
  get ready() { return this.#ready }

  /** @returns {Set<string>} podIds this transport has seen (via relay/signal senders or signaling peers) */
  get knownPeers() { return new Set(this.#knownPeers) }

  /**
   * @param {(msg: object) => void} handler
   */
  onMessage(handler) {
    this.#handler = handler
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
    for (const peerId of this.#knownPeers) {
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
        reject(err)
      }

      const onOpen = () => {
        this.#send(ws, { type: 'register', podId: this.#podId })
      }
      const handle = (data) => {
        if (!data) return
        if (isPrimary) this.#handlePrimaryMessage(data)
        else this.#handleSignalingMessage(data)

        if (data.type === 'registered') {
          finishResolve()
        } else if (data.type === 'error') {
          finishReject(new Error(data.message || `WebSocketTransport: ${kind} registration error`))
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
    if (state.attempts >= this.#reconnect.maxAttempts) {
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
    switch (data.type) {
      case 'relayed':
      case 'signal': {
        if (data.source) this.#knownPeers.add(data.source)
        this.#deliver(data.source, data.envelope)
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

  #handleSignalingMessage(data) {
    switch (data.type) {
      case 'peers': {
        for (const id of data.peers || []) {
          if (id !== this.#podId) this.#knownPeers.add(id)
        }
        return
      }
      case 'peer-joined': {
        if (data.podId && data.podId !== this.#podId) this.#knownPeers.add(data.podId)
        return
      }
      case 'peer-left': {
        if (data.podId) this.#knownPeers.delete(data.podId)
        return
      }
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

  #deliver(source, envelope) {
    if (!this.#handler || !envelope || typeof envelope !== 'object') return
    const msg = ('from' in envelope) ? envelope : { ...envelope, from: source }
    this.#handler(msg)
  }
}
