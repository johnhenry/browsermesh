/**
 * ws-transport.mjs — WebSocket TransportAdapter for @johnhenry/browsermesh-pod.
 *
 * TEMPORARY: replace with `import { WebSocketTransport } from '@johnhenry/browsermesh-pod'`
 * once WP1 (#185) lands. This is a minimal, independently-written copy that
 * implements the same contract described in issue #185 §4.1/§8 WP1, built
 * only so the WP2 isolate-pod-host spike has something to boot a `Pod` on.
 * It is NOT the package's transport and should not be treated as the
 * reference implementation — the real one lives in
 * `packages/browsermesh-pod/src/ws-transport.mjs` once WP1 merges.
 *
 * Contract (matches the sibling WP1 adapter):
 *   new WebSocketTransport({
 *     url,                 // relay server WebSocket URL, e.g. ws://localhost:8788
 *     podId,                // this pod's id, used for relay/signaling registration
 *     WebSocket,            // injectable WebSocket constructor (browser-shaped: ctor(url),
 *                           //   addEventListener/send/close/readyState) — defaults to
 *                           //   globalThis.WebSocket
 *     protocol = 'relay',   // only 'relay' is implemented by this spike copy
 *     signalingUrl,         // optional signaling server WebSocket URL, used ONLY to learn
 *                           //   the peer set (never to exchange Pod messages)
 *     peersFromSignaling = false, // when true + signalingUrl given, connect to signaling
 *                           //   too and use its peers/peer-joined/peer-left frames to
 *                           //   drive point-to-point fan-out of broadcast Pod messages
 *     reconnect,            // { baseMs=250, maxMs=5000 } backoff for both sockets
 *     onLog,                // (msg: string) => void, optional debug sink
 *   })
 *
 * Implements TransportAdapter: send(msg) / onMessage(handler) / open() / close() / ready.
 *
 * Wire protocol — matches `browsermesh-servers/relay/index.mjs` and
 * `browsermesh-servers/signaling/index.mjs` on `main` exactly (field names
 * are `target`/`source`, not the `to`/`from` shorthand used in the issue
 * prose):
 *   relay:      client → server  { type: 'register', podId }
 *               server → client  { type: 'registered', podId }
 *               client → server  { type: 'relay', target, envelope }
 *               server → client  { type: 'relayed', source, envelope }
 *   signaling:  client → server  { type: 'register', podId }
 *               server → client  { type: 'registered', podId }
 *               server → client  { type: 'peers', peers: [podId, ...] }
 *               server → client  { type: 'peer-joined', podId }
 *               server → client  { type: 'peer-left', podId }
 *
 * The relay has no broadcast/room concept — it only forwards point-to-point.
 * `Pod`'s discovery protocol (pod:hello / pod:hello-ack / pod:goodbye) wants
 * a broadcast, so this adapter fans those out point-to-point to the peer set
 * it learns from the signaling server (issue #185 §4.1, option (b): "discovery
 * seeded from the signaling server's peers list... requires no server change
 * and is the spike path"). It also remembers the last hello it broadcast and
 * replays it directly to any peer that joins signaling *after* that initial
 * broadcast, since Pod only sends one hello during its discovery window and
 * would otherwise never be seen by late-joining peers.
 */

import {
  POD_HELLO, POD_HELLO_ACK, POD_GOODBYE,
  POD_MESSAGE, POD_RPC_REQUEST, POD_RPC_RESPONSE,
} from '@johnhenry/browsermesh-pod'

const BROADCAST_TYPES = new Set([POD_HELLO, POD_GOODBYE])
const DIRECTED_TYPES = new Set([POD_MESSAGE, POD_RPC_REQUEST, POD_RPC_RESPONSE])

export class WebSocketTransport {
  #url
  #podId
  #WS
  #protocol
  #signalingUrl
  #peersFromSignaling
  #reconnect
  #onLog

  #relayWs = null
  #signalingWs = null
  #relayRegistered = false
  #signalingRegistered = false
  #handler = null
  #peers = new Set()
  #closing = false
  #lastBroadcast = null
  #relayAttempt = 0
  #signalingAttempt = 0
  #relayReconnectTimer = null
  #signalingReconnectTimer = null

  /**
   * @param {object} opts
   * @param {string} opts.url
   * @param {string} opts.podId
   * @param {Function} [opts.WebSocket]
   * @param {'relay'} [opts.protocol]
   * @param {string} [opts.signalingUrl]
   * @param {boolean} [opts.peersFromSignaling]
   * @param {{baseMs?: number, maxMs?: number}} [opts.reconnect]
   * @param {(msg: string) => void} [opts.onLog]
   */
  constructor({
    url, podId, WebSocket: WS, protocol = 'relay',
    signalingUrl = null, peersFromSignaling = false,
    reconnect, onLog,
  } = {}) {
    if (!url) throw new Error('WebSocketTransport requires { url }')
    if (!podId) throw new Error('WebSocketTransport requires { podId }')
    this.#url = url
    this.#podId = podId
    this.#WS = WS || globalThis.WebSocket
    if (!this.#WS) {
      throw new Error(
        'WebSocketTransport requires a WebSocket constructor — pass { WebSocket } ' +
        'or run in an environment with a global WebSocket.'
      )
    }
    if (protocol !== 'relay') {
      throw new Error(`WebSocketTransport (spike copy): only protocol 'relay' is implemented, got '${protocol}'`)
    }
    this.#protocol = protocol
    this.#signalingUrl = signalingUrl
    this.#peersFromSignaling = !!(peersFromSignaling && signalingUrl)
    this.#reconnect = { baseMs: 250, maxMs: 5000, ...reconnect }
    this.#onLog = onLog || (() => {})
  }

  /** @returns {boolean} */
  get ready() {
    return this.#relayRegistered && (!this.#peersFromSignaling || this.#signalingRegistered)
  }

  /** @returns {ReadonlySet<string>} peer ids currently known via signaling (debug/tests only) */
  get knownPeers() { return new Set(this.#peers) }

  /** @param {(msg: object) => void} handler */
  onMessage(handler) {
    this.#handler = handler
  }

  async open() {
    this.#closing = false
    const tasks = [this.#connectRelay()]
    if (this.#peersFromSignaling) tasks.push(this.#connectSignaling())
    await Promise.all(tasks)
  }

  /** @param {object} msg */
  send(msg) {
    if (!this.#relayWs || this.#relayWs.readyState !== 1 /* OPEN */) {
      this.#onLog(`[ws-transport] send dropped (relay not open): ${msg && msg.type}`)
      return
    }

    if (BROADCAST_TYPES.has(msg && msg.type)) {
      if (msg.type === POD_HELLO) this.#lastBroadcast = msg
      if (msg.type === POD_GOODBYE) this.#lastBroadcast = null
      this.#fanOut(msg)
      return
    }

    if (msg && msg.type === POD_HELLO_ACK) {
      this.#relayTo(msg.targetPodId, msg)
      return
    }

    if (DIRECTED_TYPES.has(msg && msg.type)) {
      if (msg.to === '*') {
        this.#fanOut(msg)
      } else {
        this.#relayTo(msg.to, msg)
      }
      return
    }

    // Unknown shape — best effort broadcast fan-out.
    this.#fanOut(msg)
  }

  async close() {
    this.#closing = true
    clearTimeout(this.#relayReconnectTimer)
    clearTimeout(this.#signalingReconnectTimer)
    this.#relayRegistered = false
    this.#signalingRegistered = false
    this.#lastBroadcast = null
    this.#peers.clear()
    if (this.#relayWs) {
      try { this.#relayWs.close() } catch { /* ignore */ }
      this.#relayWs = null
    }
    if (this.#signalingWs) {
      try { this.#signalingWs.close() } catch { /* ignore */ }
      this.#signalingWs = null
    }
  }

  // ── internals ──────────────────────────────────────────────────

  #relayTo(target, envelope) {
    if (!target || target === this.#podId) return
    this.#relayWs.send(JSON.stringify({ type: 'relay', target, envelope }))
  }

  #fanOut(envelope) {
    if (this.#peers.size === 0) {
      this.#onLog(`[ws-transport] broadcast of ${envelope && envelope.type} dropped: no known peers yet`)
      return
    }
    for (const peerId of this.#peers) {
      this.#relayTo(peerId, envelope)
    }
  }

  // Both #connectRelay and #connectSignaling resolve their returned promise
  // exactly once, on the FIRST successful registration — the `attempt`
  // closure below recurses in place (via #scheduleReconnect's callback) on
  // failure/close, rather than spawning a disconnected new promise chain, so
  // a slow first connection still resolves open() once it eventually lands.

  #connectRelay() {
    return new Promise((resolve) => {
      let resolved = false
      const succeed = () => {
        if (resolved) return
        resolved = true
        resolve()
      }
      const attempt = () => {
        let ws
        try {
          ws = new this.#WS(this.#url)
        } catch (err) {
          this.#onLog(`[ws-transport] relay connect threw: ${err.message}`)
          this.#scheduleReconnect('relay', attempt)
          return
        }
        this.#relayWs = ws

        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({ type: 'register', podId: this.#podId }))
        })
        ws.addEventListener('message', (event) => {
          const data = this.#parse(event)
          if (!data) return
          if (data.type === 'registered') {
            this.#relayRegistered = true
            this.#relayAttempt = 0
            this.#onLog(`[ws-transport] relay registered: ${this.#podId}`)
            succeed()
            return
          }
          if (data.type === 'relayed') {
            if (this.#handler) this.#handler(data.envelope)
            return
          }
          if (data.type === 'error') {
            this.#onLog(`[ws-transport] relay error: ${data.message}`)
          }
        })
        ws.addEventListener('close', (event) => {
          this.#relayRegistered = false
          this.#onLog(`[ws-transport] relay closed: code=${event && event.code} reason=${event && event.reason}`)
          if (!this.#closing) this.#scheduleReconnect('relay', attempt)
        })
        ws.addEventListener('error', () => { /* 'close' follows and reconnects */ })
      }
      attempt()
    })
  }

  #connectSignaling() {
    return new Promise((resolve) => {
      let resolved = false
      let gotRegistered = false
      let gotPeers = false
      const maybeResolve = () => {
        if (gotRegistered && gotPeers) {
          this.#signalingRegistered = true
          this.#signalingAttempt = 0
          if (!resolved) {
            resolved = true
            resolve()
          }
        }
      }
      const attempt = () => {
        let ws
        try {
          ws = new this.#WS(this.#signalingUrl)
        } catch (err) {
          this.#onLog(`[ws-transport] signaling connect threw: ${err.message}`)
          this.#scheduleReconnect('signaling', attempt)
          return
        }
        this.#signalingWs = ws

        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({ type: 'register', podId: this.#podId }))
        })
        ws.addEventListener('message', (event) => {
          const data = this.#parse(event)
          if (!data) return
          if (data.type === 'registered') {
            gotRegistered = true
            this.#onLog(`[ws-transport] signaling registered: ${this.#podId}`)
            maybeResolve()
            return
          }
          if (data.type === 'peers') {
            for (const id of data.peers || []) {
              if (id !== this.#podId) this.#peers.add(id)
            }
            gotPeers = true
            maybeResolve()
            return
          }
          if (data.type === 'peer-joined') {
            if (data.podId && data.podId !== this.#podId) {
              const isNew = !this.#peers.has(data.podId)
              this.#peers.add(data.podId)
              // Replay the last discovery broadcast directly to late joiners —
              // Pod only broadcasts hello once, during its discovery window.
              if (isNew && this.#lastBroadcast && this.#relayWs && this.#relayWs.readyState === 1) {
                this.#relayTo(data.podId, this.#lastBroadcast)
              }
            }
            return
          }
          if (data.type === 'peer-left') {
            if (data.podId) this.#peers.delete(data.podId)
            return
          }
        })
        ws.addEventListener('close', (event) => {
          this.#signalingRegistered = false
          this.#onLog(`[ws-transport] signaling closed: code=${event && event.code} reason=${event && event.reason}`)
          gotRegistered = false
          gotPeers = false
          if (!this.#closing) this.#scheduleReconnect('signaling', attempt)
        })
        ws.addEventListener('error', () => { /* 'close' follows and reconnects */ })
      }
      attempt()
    })
  }

  #parse(event) {
    try {
      const raw = typeof event.data === 'string' ? event.data : event.data.toString()
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  /**
   * @param {'relay'|'signaling'} kind
   * @param {() => void} retry - re-invoked in place after the backoff delay
   */
  #scheduleReconnect(kind, retry) {
    const n = kind === 'relay' ? ++this.#relayAttempt : ++this.#signalingAttempt
    const { baseMs, maxMs } = this.#reconnect
    const delay = Math.min(maxMs, baseMs * 2 ** (n - 1)) * (0.5 + Math.random() * 0.5)
    this.#onLog(`[ws-transport] ${kind} reconnecting in ${Math.round(delay)}ms (attempt ${n})`)
    const timer = setTimeout(() => {
      if (this.#closing) return
      retry()
    }, delay)
    if (kind === 'relay') this.#relayReconnectTimer = timer
    else this.#signalingReconnectTimer = timer
  }
}
