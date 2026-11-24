/**
 * signaling-double.mjs — an in-process double of the browsermesh-servers
 * signalling server, in both of its modes, for client unit tests.
 *
 * It follows `browsermesh-servers/signaling/index.mjs` and `auth.mjs` message
 * for message:
 *
 *   open            register { podId } -> registered { podId, mode:'open', verified:false }
 *                   then peers { peers, verified:false }; forwarded messages carry
 *                   source and sourceVerified:false
 *   authenticated   on connect: challenge { protocol:2, purpose:'register', origin, nonce, ttlMs }
 *                   register { protocol:2, podId, pubKey, nonce, signature }
 *                   accepted only when the nonce is the one issued on this connection
 *                   (single use, unexpired), podId === base64url(SHA-256(pubKey)) and the
 *                   signature verifies over registrationMessage(purpose, origin, podId, nonce)
 *                   with the server's OWN origin. Anything else: error { code, message }
 *                   and a close. A register without protocol 2 gets `protocol-unsupported`.
 *                   One verified pod may hold up to MAX_CONNECTIONS_PER_POD (default 2)
 *                   connections; a message for it goes to its NEWEST; a connection past the
 *                   limit displaces the oldest, which is sent
 *                   { type:'error', code:'replaced', reconnect:false, message } and closed
 *                   4409 'replaced'. (Open mode: a second connection for an id is refused with
 *                   { type:'error', message:'podId already registered' }, closed 4409
 *                   'podId already registered', no `code`.)
 *
 * The double verifies for real (WebCrypto Ed25519); it does not accept
 * anything it cannot verify. `tests/real-peer`-style suites run the same
 * exchanges against the real server to keep the double honest.
 */

import { createHash, randomBytes, webcrypto } from 'node:crypto'

const OPEN = 1
const CLOSED = 3

export const SIGNED_PREFIX = 'browsermesh-signaling/2'

export function registrationMessage({ purpose, origin, podId, nonce }) {
  return `${SIGNED_PREFIX}\npurpose:${purpose}\norigin:${origin}\npodId:${podId}\nnonce:${nonce}`
}

function decodeExact(s, length) {
  if (typeof s !== 'string' || s.length > 4 * length) return null
  let buf
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(s)) buf = Buffer.from(s, 'base64')
  else if (/^[A-Za-z0-9_-]+$/.test(s)) buf = Buffer.from(s, 'base64url')
  else return null
  return buf.length === length ? new Uint8Array(buf) : null
}

async function verify({ podId, pubKey, signature, nonce, origin }) {
  if (typeof podId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(podId)) return { code: 'bad-pod-id' }
  const raw = decodeExact(pubKey, 32)
  if (!raw) return { code: 'bad-key' }
  const sig = decodeExact(signature, 64)
  if (!sig) return { code: 'bad-signature' }
  if (createHash('sha256').update(raw).digest('base64url') !== podId) return { code: 'pod-id-mismatch' }
  try {
    const key = await webcrypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify'])
    const data = new TextEncoder().encode(registrationMessage({ purpose: 'register', origin, podId, nonce }))
    if (!(await webcrypto.subtle.verify('Ed25519', key, sig, data))) return { code: 'bad-signature' }
  } catch {
    return { code: 'bad-key' }
  }
  return null
}

export class SignalingDouble {
  #peers = new Map()
  /** every frame a client sent, in order: { podId|null, data } */
  received = []
  connectionCount = 0
  /** @type {Array<{ code: string }>} refusals the server issued */
  refusals = []

  /**
   * @param {object} [o]
   * @param {'open'|'authenticated'} [o.mode='open']
   * @param {string} [o.publicOrigin] — what the server expects clients to sign
   * @param {() => number} [o.now]
   * @param {number} [o.nonceTtlMs=30000]
   * @param {boolean} [o.challenge=true] — authenticated mode only: false never sends the challenge (a stripped one)
   * @param {number} [o.maxConnectionsPerPod=2] — authenticated mode: MAX_CONNECTIONS_PER_POD
   */
  constructor({ mode = 'open', publicOrigin = 'ws://signal.test', now = Date.now, nonceTtlMs = 30_000, challenge = true, maxConnectionsPerPod = 2 } = {}) {
    this.maxConnectionsPerPod = maxConnectionsPerPod
    this.mode = mode
    this.publicOrigin = publicOrigin
    this.now = now
    this.nonceTtlMs = nonceTtlMs
    this.sendChallenge = challenge
  }

  get authenticated() { return this.mode === 'authenticated' }
  get size() { return this.#peers.size }

  connect(ws) {
    this.connectionCount++
    ws._challenge = null
    if (this.authenticated && this.sendChallenge) {
      ws._challenge = { nonce: randomBytes(16).toString('base64url'), issuedAt: this.now(), used: false }
      ws._serverSend({
        type: 'challenge', protocol: 2, purpose: 'register',
        origin: this.publicOrigin, nonce: ws._challenge.nonce, ttlMs: this.nonceTtlMs,
      })
    } else if (this.authenticated) {
      // A challenge that never arrives still has to exist server-side.
      ws._challenge = { nonce: randomBytes(16).toString('base64url'), issuedAt: this.now(), used: false }
    }
  }

  disconnect(ws) {
    // A connection that was replaced is already gone from the list; the pod is
    // released (and announced as gone) only when its last connection is.
    const conns = ws.podId ? this.#peers.get(ws.podId) : null
    const i = conns ? conns.indexOf(ws) : -1
    if (i < 0) return
    conns.splice(i, 1)
    if (conns.length === 0) {
      this.#peers.delete(ws.podId)
      for (const list of this.#peers.values()) for (const p of list) p._serverSend({ type: 'peer-left', podId: ws.podId })
    }
  }

  #refuse(ws, code, message, extra = {}) {
    this.refusals.push({ code })
    ws._serverSend({ type: 'error', code, message, ...extra })
    ws._serverClose()
  }

  /** The pod ids of every registered pod (one entry per pod, however many connections it holds). */
  listPeers() { return [...this.#peers.keys()] }

  /** How many connections `podId` holds. */
  connectionsOf(podId) { return this.#peers.get(podId)?.length ?? 0 }

  async receive(ws, data) {
    this.received.push({ podId: ws.podId, data })
    if (!ws.podId && !ws._registering) {
      if (data.type !== 'register' || typeof data.podId !== 'string' || !data.podId) {
        ws._serverSend({ type: 'error', message: 'first message must be { type: "register", podId: string }' })
        return
      }
      ws._registering = true
      if (this.authenticated) {
        if (data.protocol !== 2) {
          return this.#refuse(ws, 'protocol-unsupported', 'this server requires protocol 2', { required: 2 })
        }
        const ch = ws._challenge
        if (ch.used) return this.#refuse(ws, 'bad-nonce', 'challenge already used')
        ch.used = true
        if (data.nonce !== ch.nonce) return this.#refuse(ws, 'bad-nonce', 'nonce does not match the challenge issued on this connection')
        if (this.now() - ch.issuedAt > this.nonceTtlMs) return this.#refuse(ws, 'challenge-expired', 'challenge expired')
        const bad = await verify({ ...data, nonce: ch.nonce, origin: this.publicOrigin })
        if (bad) return this.#refuse(ws, bad.code, 'registration refused')
      }
      const existing = this.#peers.get(data.podId)
      if (existing) {
        if (!this.authenticated) {
          // Open mode: a second connection for an id is refused, with no `code`.
          ws._serverSend({ type: 'error', message: 'podId already registered' })
          ws._serverClose(4409, 'podId already registered')
          return
        }
        // Authenticated: the id is the hash of a key this client just proved it holds, so this is the
        // same pod. Up to `maxConnectionsPerPod` are kept; past that the oldest is replaced, and told so.
        while (existing.length >= this.maxConnectionsPerPod) {
          const old = existing.shift()
          old._serverSend({
            type: 'error', code: 'replaced', reconnect: false,
            message: 'replaced by a newer connection of the same pod; do not reconnect automatically',
          })
          old._serverClose(4409, 'replaced')
        }
      }
      ws.podId = data.podId
      if (existing) existing.push(ws)
      else this.#peers.set(ws.podId, [ws])
      const verified = this.authenticated
      ws._serverSend({ type: 'registered', podId: ws.podId, mode: this.mode, verified })
      ws._serverSend({ type: 'peers', peers: [...this.#peers.keys()], verified })
      if (!existing) {
        for (const list of this.#peers.values()) for (const p of list) if (p !== ws) p._serverSend({ type: 'peer-joined', podId: ws.podId, verified })
      }
      return
    }
    if (!ws.podId) return

    if (['offer', 'answer', 'ice-candidate', 'signal'].includes(data.type)) {
      const { target, ...payload } = data
      // Delivered once, to the pod's newest connection.
      const conns = this.#peers.get(target)
      const to = conns?.[conns.length - 1]
      if (typeof target !== 'string' || !to) {
        ws._serverSend({ type: 'error', message: 'peer not found', target })
        return
      }
      const forwarded = { ...payload, source: ws.podId, sourceVerified: this.authenticated }
      if (Object.hasOwn(payload, 'from')) forwarded.from = ws.podId
      to._serverSend(forwarded)
      return
    }
    if (data.type === 'ping') ws._serverSend({ type: 'pong', timestamp: this.now() })
  }

  /** Push an arbitrary frame to a registered client. */
  pushTo(podId, data) { const c = this.#peers.get(podId); c?.[c.length - 1]._serverSend(data) }
}

class Target {
  #listeners = new Map()
  addEventListener(type, fn) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set())
    this.#listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) { this.#listeners.get(type)?.delete(fn) }
  _dispatch(type, detail) {
    for (const fn of this.#listeners.get(type) ?? []) {
      try { fn(detail) } catch { /* listener errors do not crash the double */ }
    }
  }
}

/** A WebSocket constructor wired to doubles by exact URL. */
export function createDoubleNetwork() {
  const registry = new Map()
  const sockets = []

  class DoubleWebSocket extends Target {
    constructor(url) {
      super()
      this.url = url
      this.readyState = 0
      this.podId = null
      this._server = registry.get(url)
      if (!this._server) throw new Error(`no double registered for ${url}`)
      sockets.push(this)
      queueMicrotask(() => {
        if (this.readyState !== 0) return
        this.readyState = OPEN
        this._server.connect(this)
        this._dispatch('open', {})
      })
    }

    send(raw) {
      if (this.readyState !== OPEN) return
      const data = JSON.parse(raw)
      queueMicrotask(() => { if (this.readyState === OPEN) this._server.receive(this, data) })
    }

    _serverSend(data) {
      if (this.readyState !== OPEN) return
      queueMicrotask(() => { if (this.readyState === OPEN) this._dispatch('message', { data: JSON.stringify(data) }) })
    }

    _serverClose(code = 1005, reason = '') { queueMicrotask(() => this.close(code, reason)) }

    close(code = 1005, reason = '') {
      if (this.readyState === CLOSED) return
      this.readyState = CLOSED
      this._server.disconnect(this)
      this._dispatch('close', { code, reason })
    }
  }

  return {
    WebSocket: DoubleWebSocket,
    sockets,
    add(url, server) { registry.set(url, server); return server },
  }
}
