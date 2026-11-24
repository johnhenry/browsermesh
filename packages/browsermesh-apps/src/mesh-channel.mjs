/**
 * mesh-channel.mjs -- a message-oriented duplex channel between two mesh
 * peers, for protocols that need more than `mesh-rpc`'s HTTP-shaped
 * request/response.
 *
 * It sits beside `mesh-rpc` (which is untouched) on its own envelope type,
 * `mesh-channel`. A link between two peers gives each side:
 *
 *   - requests in BOTH directions, with ids unique per direction,
 *   - notifications (`notify` / `onNotification`),
 *   - progress per request (`ctx.progress(value)` -> `onProgress`),
 *   - cancel per request (the callee's handler gets an AbortSignal; the
 *     caller's late results are dropped),
 *   - native binary values (`Uint8Array` anywhere in a message),
 *   - a negotiated maximum message size, enforced from the first chunk's
 *     announced length, before a message is assembled,
 *   - byte-based credit flow control, so a slow reader bounds a sender's
 *     memory (the sender may have at most `window` unconsumed bytes in
 *     flight to that peer),
 *   - bounded in-flight requests per peer, and
 *   - a `close()` that rejects every pending request.
 *
 * Identity. A handler is handed `peer`, the public key the SESSION is bound
 * to (the `pubKey` `PeerNode` reports for the transport the frame arrived
 * on). Nothing inside a message is ever used to say who sent it. As with
 * `mesh-rpc`, this layer does not authorise anything: each handler owns its
 * own access check (`ctx.registry.checkAccess(peer, ...)`).
 *
 * Wire. Envelope `{ type: 'mesh-channel', k, ... }`, JSON-safe because real
 * transports carry envelopes as JSON text. Frame kinds `k`:
 *   hello / hello-ack  version + limits handshake (sent first; nothing else
 *                      is sent to a peer until it has answered)
 *   d                  one chunk of an encoded message (`m` message id, `i`
 *                      chunk index, `n` total encoded bytes on the first
 *                      chunk, `f` base64 chunk bytes)
 *   c                  credit grant, `n` bytes
 *   a                  receiver refuses message `m` (over the size limit)
 *   x                  cancel request `id` (control frame, not credit-gated)
 *   close              orderly close
 * Messages are encoded with `internal/channel-codec.mjs` (a small
 * self-contained binary-safe value codec) and split into chunks of at most
 * `chunkBytes`; base64 is only the JSON-envelope carrier of those chunks and
 * never appears in the API. Frames of one link must arrive in order (the
 * default `control` data channel is ordered).
 *
 * Old peers. A peer that does not run this service ignores the envelope
 * type; `open()` therefore sends exactly one small `hello` and nothing else,
 * and rejects with `MeshChannelError` (code -32000, reason `unsupported`)
 * if no `hello-ack` arrives within `handshakeTimeoutMs`. A peer that knows
 * the channel but not the version answers with an error ack. Pass
 * `peerSupports(peer)` to refuse without sending anything at all when the
 * caller already knows (for example from a capability advertisement).
 *
 * Memory model. The receiver never holds more than `window` bytes it has not
 * yet handed back as credit, and `maxMessageBytes` (<= `window`) bounds the
 * single message under assembly. Credit for a request, response, progress
 * or notification is returned as soon as it has been dispatched; credit for a
 * raw `send()` message is returned when every `onMessage` callback has
 * settled, so an `onMessage` callback that awaits slow work slows the sender
 * down (and one that never settles stops it). Raw callbacks run one at a time
 * in arrival order. Do not make a raw callback wait for a response from the
 * same peer: that response may be queued behind the credit it holds.
 *
 * Error codes (JSON-RPC style): -32000 unsupported, -32001 cancelled /
 * timed out / channel closed, -32002 too many requests in flight, -32003
 * unauthorized (for handlers to throw), -32004 message too large, -32601
 * unknown method, -32603 handler failed, -32600 invalid request.
 *
 * No browser-only imports.
 */
import { encodeValue, decodeValue, toBase64, fromBase64 } from './internal/channel-codec.mjs'

export const CHANNEL_ENVELOPE_TYPE = 'mesh-channel'
export const CHANNEL_VERSION = 1
export const CHANNEL_MIN_VERSION = 1
export const CHANNEL_DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024
export const CHANNEL_DEFAULT_WINDOW_BYTES = 4 * 1024 * 1024
export const CHANNEL_DEFAULT_CHUNK_BYTES = 16 * 1024
export const CHANNEL_DEFAULT_MAX_INFLIGHT = 64
export const CHANNEL_DEFAULT_REQUEST_TIMEOUT_MS = 30000
export const CHANNEL_DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000
export const CHANNEL_DEFAULT_MAX_PEERS = 64

export const ChannelErrorCode = Object.freeze({
  UNSUPPORTED: -32000,
  CANCELLED: -32001,
  BUSY: -32002,
  UNAUTHORIZED: -32003,
  TOO_LARGE: -32004,
  INVALID: -32600,
  METHOD_NOT_FOUND: -32601,
  INTERNAL: -32603,
})

export class MeshChannelError extends Error {
  /**
   * @param {number} code
   * @param {string} reason - short machine-readable reason (`cancelled`, `timeout`, `channel-closed`, ...)
   * @param {string} [message]
   * @param {*} [data]
   */
  constructor(code, reason, message, data) {
    super(message || reason)
    this.name = 'MeshChannelError'
    this.code = code
    this.reason = reason
    if (data !== undefined) this.data = data
  }
}

const err = (code, reason, message, data) => new MeshChannelError(code, reason, message, data)
const isPosInt = n => Number.isSafeInteger(n) && n > 0
const MAX_METHOD_LENGTH = 256
const MAX_REMOTE_WINDOW = 2 ** 31

function encodeError(e) {
  if (e instanceof MeshChannelError) return { c: e.code, r: e.reason, m: e.message, d: e.data }
  return { c: ChannelErrorCode.INTERNAL, r: 'handler-failed', m: e?.message || String(e) }
}
function decodeError(w) {
  const c = Number.isSafeInteger(w?.c) ? w.c : ChannelErrorCode.INTERNAL
  return err(c, typeof w?.r === 'string' ? w.r : 'error', typeof w?.m === 'string' ? w.m : 'remote error', w?.d)
}
/** Exact decoded length of base64 text, without decoding it. */
function base64Length(text) {
  if (typeof text !== 'string' || text.length % 4) return -1
  const pad = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0
  return (text.length / 4) * 3 - pad
}

/**
 * Transport-neutral core of one link. It talks to the outside world through
 * `sendFrame(frame) -> Promise` and `receive(frame)`, so it runs unchanged
 * over a mesh session (see `createMeshChannelService`) or over any
 * in-memory duplex.
 *
 * @param {object} opts
 * @param {string} opts.peer - the verified identity of the other end
 * @param {(frame: object) => (void|Promise<void>)} opts.sendFrame
 * @param {(link: object) => void} [opts.onReady] - called synchronously the moment the other end's parameters are known
 * @returns {object} `{ link, receive, open, close, remoteSid }`
 */
export function createChannelCore({
  peer,
  sendFrame,
  maxMessageBytes = CHANNEL_DEFAULT_MAX_MESSAGE_BYTES,
  window: windowBytes = CHANNEL_DEFAULT_WINDOW_BYTES,
  maxInflight = CHANNEL_DEFAULT_MAX_INFLIGHT,
  chunkBytes = CHANNEL_DEFAULT_CHUNK_BYTES,
  requestTimeoutMs = CHANNEL_DEFAULT_REQUEST_TIMEOUT_MS,
  handshakeTimeoutMs = CHANNEL_DEFAULT_HANDSHAKE_TIMEOUT_MS,
  features = [],
  onReady,
  onLog,
} = {}) {
  if (typeof peer !== 'string' || !peer) throw new TypeError('mesh-channel: peer must be a non-empty string')
  if (typeof sendFrame !== 'function') throw new TypeError('mesh-channel: sendFrame must be a function')
  for (const [name, value] of Object.entries({ maxMessageBytes, window: windowBytes, maxInflight, chunkBytes, requestTimeoutMs, handshakeTimeoutMs })) {
    if (!isPosInt(value)) throw new TypeError(`mesh-channel: ${name} must be a positive integer`)
  }
  if (maxMessageBytes > windowBytes) throw new TypeError('mesh-channel: maxMessageBytes cannot exceed window (a message must fit in the receive window)')
  if (chunkBytes > windowBytes) throw new TypeError('mesh-channel: chunkBytes cannot exceed window')
  const log = onLog || (() => {})
  const sid = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')
  const local = { maxMessageBytes, window: windowBytes, maxInflight, chunkBytes }

  let remote = null           // set by hello / hello-ack
  let remoteSid = null
  let version = CHANNEL_VERSION
  let negotiatedFeatures = []
  let closed = false
  let closeError = null
  let helloSent = false
  let ready, rejectReady
  let readySettled = false
  const readyPromise = new Promise((res, rej) => { ready = res; rejectReady = rej })
  readyPromise.catch(() => {})

  // ---- sending side ----
  let credit = 0
  let nextMsg = 1
  const sendQueue = []        // { m, bytes, offset, resolve, reject, signal, onAbort }
  let pumping = false

  // ---- receiving side ----
  let held = 0                // bytes received and not yet handed back as credit
  let asm = null              // message under assembly
  let refusing = null         // message id being refused (over the size limit)
  const rawQueue = []
  let rawRunning = false

  // ---- requests ----
  let nextId = 1
  const pending = new Map()   // our requests awaiting a response
  const incoming = new Map()  // requests we are serving
  const requestHandlers = new Map()
  const notificationHandlers = new Map()
  const messageListeners = new Set()
  const closeListeners = new Set()

  const effectiveMax = () => remote ? Math.min(local.maxMessageBytes, remote.maxMessageBytes) : local.maxMessageBytes
  const frame = (k, rest) => ({ k, ...rest })
  function transmit(f) {
    return Promise.resolve().then(() => sendFrame(f))
  }

  // ------------------------------------------------------------------ close
  function close(reason, { notifyRemote = true } = {}) {
    if (closed) return
    closed = true
    const why = reason instanceof Error ? reason : err(ChannelErrorCode.CANCELLED, 'channel-closed', typeof reason === 'string' ? reason : 'channel closed')
    closeError = why
    if (notifyRemote && readySettled) transmit(frame('close', { c: why.code, r: why.reason })).catch(() => {})
    if (!readySettled) { readySettled = true; rejectReady(why) }
    for (const [id, p] of [...pending]) {
      pending.delete(id)
      clearTimeout(p.timer)
      p.signal?.removeEventListener('abort', p.onAbort)
      p.reject(err(ChannelErrorCode.CANCELLED, 'channel-closed', 'channel closed while the request was pending'))
    }
    for (const a of incoming.values()) a.controller.abort(err(ChannelErrorCode.CANCELLED, 'channel-closed', 'channel closed'))
    incoming.clear()
    for (const item of sendQueue.splice(0)) {
      item.signal?.removeEventListener('abort', item.onAbort)
      item.reject(err(ChannelErrorCode.CANCELLED, 'channel-closed', 'channel closed before the message was sent'))
    }
    rawQueue.length = 0
    asm = null
    for (const cb of [...closeListeners]) { try { cb(why) } catch (e) { log('mesh-channel:close-listener-threw', { error: e?.message }) } }
    closeListeners.clear()
  }
  const violation = message => {
    log('mesh-channel:protocol-violation', { peer, message })
    close(err(ChannelErrorCode.INVALID, 'protocol-violation', message))
  }

  // ------------------------------------------------------------ flow control
  function returnCredit(n) {
    if (closed || n <= 0) return
    transmit(frame('c', { n })).catch(e => close(e))
  }
  function grant(n) {
    held -= n
    returnCredit(n)
  }

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (!closed && sendQueue.length) {
        const item = sendQueue[0]
        while (!closed && item.offset < item.bytes.byteLength) {
          if (credit <= 0) return // resumed when a credit frame arrives
          const size = Math.min(item.bytes.byteLength - item.offset, Math.min(local.chunkBytes, remote.chunkBytes), credit)
          const chunk = item.bytes.subarray(item.offset, item.offset + size)
          const f = frame('d', { m: item.m, i: item.index, f: toBase64(chunk) })
          if (item.index === 0) f.n = item.bytes.byteLength
          credit -= size
          item.offset += size
          item.index += 1
          item.started = true
          await transmit(f)
          if (sendQueue[0] !== item) break // refused by the receiver while we were sending
        }
        if (sendQueue[0] === item) {
          sendQueue.shift()
          item.signal?.removeEventListener('abort', item.onAbort)
          item.resolve()
        }
      }
    } catch (e) {
      close(e)
    } finally {
      pumping = false
      if (!closed && sendQueue.length && credit > 0) pump()
    }
  }

  function enqueue(value, { signal } = {}) {
    if (closed) return Promise.reject(closeError)
    if (!remote) return Promise.reject(err(ChannelErrorCode.UNSUPPORTED, 'not-ready', 'channel is not open yet'))
    if (signal?.aborted) return Promise.reject(err(ChannelErrorCode.CANCELLED, 'cancelled', 'send aborted'))
    let bytes
    try { bytes = encodeValue(value) } catch (e) { return Promise.reject(e) }
    // Refused here, before a single byte of it reaches the wire.
    if (bytes.byteLength > effectiveMax()) {
      return Promise.reject(err(ChannelErrorCode.TOO_LARGE, 'message-too-large', `message of ${bytes.byteLength} bytes exceeds the negotiated maximum of ${effectiveMax()}`))
    }
    return new Promise((resolve, reject) => {
      const item = { m: nextMsg++, bytes, offset: 0, index: 0, started: false, resolve, reject, signal }
      item.onAbort = () => {
        if (item.started) return // part of it is already out; it completes
        const at = sendQueue.indexOf(item)
        if (at >= 0) sendQueue.splice(at, 1)
        reject(err(ChannelErrorCode.CANCELLED, 'cancelled', 'send aborted'))
      }
      signal?.addEventListener('abort', item.onAbort, { once: true })
      sendQueue.push(item)
      pump()
    })
  }

  // --------------------------------------------------------------- receiving
  function onData(fr) {
    if (!remote) return
    const { m, i, f } = fr
    if (!Number.isSafeInteger(m) || !Number.isSafeInteger(i) || i < 0) return violation('malformed data frame')
    const len = base64Length(f)
    if (len < 0) return violation('malformed data frame')
    if (len > local.chunkBytes) return violation('chunk exceeds the advertised chunk size')
    if (held + len > local.window) return violation('sender exceeded the credit it was granted')
    if (i === 0) {
      if (asm) return violation('a new message began before the previous one finished')
      refusing = null
      const n = fr.n
      if (!isPosInt(n)) return violation('first chunk must announce a positive message length')
      if (n > local.maxMessageBytes) {
        // Refused from the announced length alone: nothing is allocated for it.
        refusing = m
        transmit(frame('a', { m, c: ChannelErrorCode.TOO_LARGE })).catch(() => {})
        return returnCredit(len)
      }
      asm = { m, n, parts: [], got: 0, next: 0 }
    } else if (m === refusing) {
      return returnCredit(len) // the tail of a message we refused: dropped unbuffered
    }
    if (!asm || asm.m !== m || i !== asm.next) return violation('out-of-order data frame')
    if (asm.got + len > asm.n) return violation('chunk overruns the announced message length')
    let bytes
    try { bytes = fromBase64(f, local.chunkBytes) } catch { return violation('invalid chunk encoding') }
    held += bytes.byteLength
    asm.parts.push(bytes)
    asm.got += bytes.byteLength
    asm.next += 1
    if (asm.got < asm.n) return
    const whole = new Uint8Array(asm.n)
    let at = 0
    for (const part of asm.parts) { whole.set(part, at); at += part.byteLength }
    const size = asm.n
    asm = null
    let value
    try { value = decodeValue(whole) } catch { return violation('undecodable message') }
    dispatch(value, size)
  }

  function dispatch(msg, size) {
    let credited = false
    const giveBack = () => { if (!credited) { credited = true; grant(size) } }
    try {
      if (!msg || typeof msg !== 'object') return giveBack()
      switch (msg.t) {
        case 'q': handleRequest(msg); return giveBack()
        case 'r': handleResponse(msg); return giveBack()
        case 'g': pending.get(msg.id)?.onProgress?.(msg.v); return giveBack()
        case 'n': handleNotification(msg); return giveBack()
        case 'm':
          rawQueue.push({ value: msg.b, giveBack })
          return drainRaw()
        default: return giveBack()
      }
    } catch (e) {
      log('mesh-channel:dispatch-threw', { peer, error: e?.message })
      giveBack()
    }
  }

  async function drainRaw() {
    if (rawRunning) return
    rawRunning = true
    try {
      while (rawQueue.length && !closed) {
        const { value, giveBack } = rawQueue.shift()
        try { await Promise.all([...messageListeners].map(cb => cb(value, { peer }))) }
        catch (e) { log('mesh-channel:message-listener-threw', { peer, error: e?.message }) }
        giveBack()
      }
    } finally { rawRunning = false }
  }

  function handleNotification(msg) {
    if (typeof msg.m !== 'string') return
    for (const cb of [...(notificationHandlers.get(msg.m) || [])]) {
      Promise.resolve().then(() => cb(msg.p, { peer, method: msg.m })).catch(e => log('mesh-channel:notification-handler-threw', { peer, method: msg.m, error: e?.message }))
    }
  }

  function respond(id, body) {
    if (closed) return
    enqueue({ t: 'r', id, ...body }).catch(e => {
      if (closed) return
      // A result that cannot be sent (too large, not encodable) becomes an error the caller can read.
      if (body.e) return
      enqueue({ t: 'r', id, e: encodeError(e instanceof MeshChannelError ? e : err(ChannelErrorCode.INTERNAL, 'unsendable-result', e?.message)) }).catch(() => {})
    })
  }

  function handleRequest(msg) {
    const { id, m: method } = msg
    if (!isPosInt(id) || typeof method !== 'string' || !method || method.length > MAX_METHOD_LENGTH) return
    if (incoming.has(id)) return
    if (incoming.size >= local.maxInflight) return respond(id, { e: encodeError(err(ChannelErrorCode.BUSY, 'too-many-requests', 'too many requests in flight')) })
    const handler = requestHandlers.get(method)
    if (!handler) return respond(id, { e: encodeError(err(ChannelErrorCode.METHOD_NOT_FOUND, 'method-not-found', `no handler for ${method}`)) })
    const controller = new AbortController()
    incoming.set(id, { controller })
    const progress = value => {
      if (closed || controller.signal.aborted) return Promise.resolve()
      return enqueue({ t: 'g', id, v: value }).catch(() => {})
    }
    Promise.resolve().then(() => handler(msg.p, { peer, id, method, signal: controller.signal, progress })).then(
      result => { if (incoming.get(id)?.controller === controller) { incoming.delete(id); if (!controller.signal.aborted) respond(id, { v: result }) } },
      error => {
        if (incoming.get(id)?.controller !== controller) return
        incoming.delete(id)
        if (controller.signal.aborted) return
        log('mesh-channel:handler-threw', { peer, method, error: error?.message })
        respond(id, { e: encodeError(error) })
      },
    )
  }

  function handleResponse(msg) {
    const p = pending.get(msg.id)
    if (!p) return // late result for a cancelled / unknown request: dropped
    pending.delete(msg.id)
    clearTimeout(p.timer)
    p.signal?.removeEventListener('abort', p.onAbort)
    if (msg.e) p.reject(decodeError(msg.e))
    else p.resolve(msg.v)
  }

  function onCancel(fr) {
    const a = incoming.get(fr.id)
    if (!a) return
    incoming.delete(fr.id)
    a.controller.abort(err(ChannelErrorCode.CANCELLED, 'cancelled', 'cancelled by the caller'))
  }

  // --------------------------------------------------------------- handshake
  function params() {
    return { sid, v: CHANNEL_VERSION, min: CHANNEL_MIN_VERSION, maxMessageBytes: local.maxMessageBytes, window: local.window, maxInflight: local.maxInflight, chunkBytes: local.chunkBytes, features }
  }
  function adoptRemote(fr) {
    const okInts = [fr.maxMessageBytes, fr.window, fr.maxInflight, fr.chunkBytes].every(isPosInt)
    if (!okInts || !Number.isSafeInteger(fr.v) || fr.window > MAX_REMOTE_WINDOW || fr.maxMessageBytes > fr.window || fr.chunkBytes > fr.window) {
      throw err(ChannelErrorCode.INVALID, 'bad-handshake', 'malformed handshake')
    }
    const min = Number.isSafeInteger(fr.min) ? fr.min : fr.v
    if (fr.v < CHANNEL_MIN_VERSION || min > CHANNEL_VERSION) throw err(ChannelErrorCode.UNSUPPORTED, 'unsupported-version', `no common version (remote ${min}..${fr.v}, local ${CHANNEL_MIN_VERSION}..${CHANNEL_VERSION})`)
    remote = { maxMessageBytes: fr.maxMessageBytes, window: fr.window, maxInflight: fr.maxInflight, chunkBytes: fr.chunkBytes }
    remoteSid = typeof fr.sid === 'string' ? fr.sid : null
    version = Math.min(fr.v, CHANNEL_VERSION)
    negotiatedFeatures = Array.isArray(fr.features) ? fr.features.filter(f => typeof f === 'string' && features.includes(f)) : []
    credit = remote.window
    if (!readySettled) {
      readySettled = true
      ready()
      // Synchronous, before any further frame is processed: handlers registered here cannot miss a request.
      try { onReady?.(link) } catch (e) { log('mesh-channel:on-ready-threw', { peer, error: e?.message }) }
    }
  }

  function onHello(fr) {
    try { if (!remote) adoptRemote(fr) }
    catch (e) {
      transmit(frame('hello-ack', { sid, error: { c: e.code, r: e.reason, m: e.message } })).catch(() => {})
      return close(e, { notifyRemote: false })
    }
    transmit(frame('hello-ack', params())).catch(e => close(e))
  }
  function onHelloAck(fr) {
    if (fr.error) return close(decodeError(fr.error), { notifyRemote: false })
    if (remote) return
    try { adoptRemote(fr) } catch (e) { close(e) }
  }

  function receive(fr) {
    if (closed || !fr || typeof fr !== 'object') return
    switch (fr.k) {
      case 'hello': return onHello(fr)
      case 'hello-ack': return onHelloAck(fr)
      case 'd': return onData(fr)
      case 'c': {
        if (!remote || !isPosInt(fr.n)) return
        credit = Math.min(credit + fr.n, remote.window)
        return void pump()
      }
      case 'a': {
        const head = sendQueue[0]
        if (head && head.m === fr.m) {
          sendQueue.shift()
          head.signal?.removeEventListener('abort', head.onAbort)
          head.reject(err(Number.isSafeInteger(fr.c) ? fr.c : ChannelErrorCode.TOO_LARGE, 'message-refused', 'the receiver refused the message'))
        }
        return
      }
      case 'x': return onCancel(fr)
      case 'close': return close(err(Number.isSafeInteger(fr.c) ? fr.c : ChannelErrorCode.CANCELLED, typeof fr.r === 'string' ? fr.r : 'channel-closed', 'closed by the peer'), { notifyRemote: false })
      default: return
    }
  }

  /** Send our hello (once) and resolve when the other end's parameters are known. */
  function open({ timeoutMs = handshakeTimeoutMs } = {}) {
    if (closed) return Promise.reject(closeError)
    if (!helloSent) {
      helloSent = true
      transmit(frame('hello', params())).catch(e => close(e))
    }
    if (readySettled) return readyPromise
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const e = err(ChannelErrorCode.UNSUPPORTED, 'unsupported', 'the peer did not answer the channel handshake (it may not support mesh-channel)')
        close(e, { notifyRemote: false })
        reject(e)
      }, timeoutMs)
      // Not unref'd: a caller awaiting open() must hear back even if nothing else keeps the process alive.
      readyPromise.then(resolve, reject).finally(() => clearTimeout(timer))
    })
  }

  // -------------------------------------------------------------- public link
  function request(method, params, { signal, onProgress, timeoutMs = requestTimeoutMs } = {}) {
    if (closed) return Promise.reject(closeError)
    if (typeof method !== 'string' || !method || method.length > MAX_METHOD_LENGTH) return Promise.reject(new TypeError('mesh-channel: method must be a non-empty string'))
    if (!isPosInt(timeoutMs)) return Promise.reject(new TypeError('mesh-channel: timeoutMs must be a positive integer'))
    if (signal?.aborted) return Promise.reject(err(ChannelErrorCode.CANCELLED, 'cancelled', 'request aborted'))
    if (!remote) return Promise.reject(err(ChannelErrorCode.UNSUPPORTED, 'not-ready', 'channel is not open yet'))
    if (pending.size >= Math.min(local.maxInflight, remote.maxInflight)) return Promise.reject(err(ChannelErrorCode.BUSY, 'too-many-requests', 'too many requests in flight'))
    const id = nextId++
    return new Promise((resolve, reject) => {
      const fail = (e) => {
        const p = pending.get(id)
        if (!p) return
        pending.delete(id)
        clearTimeout(p.timer)
        signal?.removeEventListener('abort', p.onAbort)
        reject(e)
        // The callee is told; a late result it sends anyway is dropped (unknown id).
        transmit(frame('x', { id })).catch(() => {})
      }
      const onAbort = () => fail(err(ChannelErrorCode.CANCELLED, 'cancelled', 'request aborted'))
      const timer = setTimeout(() => fail(err(ChannelErrorCode.CANCELLED, 'timeout', `request ${method} timed out after ${timeoutMs}ms`)), timeoutMs)
      timer.unref?.()
      pending.set(id, { resolve, reject, onProgress, timer, signal, onAbort })
      signal?.addEventListener('abort', onAbort, { once: true })
      enqueue({ t: 'q', id, m: method, p: params }).catch(e => {
        const p = pending.get(id)
        if (!p) return
        pending.delete(id)
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(e)
      })
    })
  }

  const addTo = (map, key, cb) => {
    let set = map.get(key)
    if (!set) map.set(key, set = new Set())
    set.add(cb)
    return () => { set.delete(cb); if (!set.size) map.delete(key) }
  }

  const link = {
    peer,
    get maxMessageBytes() { return effectiveMax() },
    get version() { return version },
    get features() { return [...negotiatedFeatures] },
    get closed() { return closed },
    ready: readyPromise,
    send(value, opts) { return enqueue({ t: 'm', b: value }, opts) },
    onMessage(cb) {
      if (typeof cb !== 'function') throw new TypeError('mesh-channel: onMessage needs a function')
      messageListeners.add(cb)
      return () => messageListeners.delete(cb)
    },
    request,
    notify(method, params) {
      if (typeof method !== 'string' || !method || method.length > MAX_METHOD_LENGTH) return Promise.reject(new TypeError('mesh-channel: method must be a non-empty string'))
      return enqueue({ t: 'n', m: method, p: params })
    },
    onRequest(method, handler) {
      if (typeof method !== 'string' || !method || typeof handler !== 'function') throw new TypeError('mesh-channel: onRequest(method, handler)')
      if (requestHandlers.has(method)) throw new Error(`mesh-channel: a handler for ${method} is already registered`)
      requestHandlers.set(method, handler)
      return () => { if (requestHandlers.get(method) === handler) requestHandlers.delete(method) }
    },
    onNotification(method, handler) {
      if (typeof method !== 'string' || !method || typeof handler !== 'function') throw new TypeError('mesh-channel: onNotification(method, handler)')
      return addTo(notificationHandlers, method, handler)
    },
    onClose(cb) {
      if (typeof cb !== 'function') throw new TypeError('mesh-channel: onClose needs a function')
      if (closed) { queueMicrotask(() => cb(closeError)); return () => {} }
      closeListeners.add(cb)
      return () => closeListeners.delete(cb)
    },
    close(reason) { close(reason) },
    /** Introspection for tests and dashboards. */
    stats() {
      return { creditBytes: credit, heldBytes: held, queuedMessages: sendQueue.length, queuedBytes: sendQueue.reduce((n, q) => n + q.bytes.byteLength - q.offset, 0), pendingRequests: pending.size, activeRequests: incoming.size }
    },
  }

  return { link, receive, open, close, get remoteSid() { return remoteSid }, get helloSent() { return helloSent } }
}

/**
 * MeshService descriptor: one channel link per peer over `ctx.sendTo` /
 * `ctx.onIncomingData`.
 *
 * @param {object} [opts]
 * @param {string} [opts.envelopeType='mesh-channel']
 * @param {(peer: string) => (boolean|undefined)} [opts.peerSupports] - return false to refuse to open (nothing is sent)
 * @param {(peer: string) => boolean} [opts.acceptPeer] - return false to refuse an inbound hello (default: accept)
 * @param {number} [opts.maxPeers=64] - links held at once; a hello beyond it is refused
 * @param {(link: object) => void} [opts.onLink] - called synchronously for each link, inbound or outbound, the moment it is ready:
 *   register `onRequest` / `onNotification` / `onMessage` handlers here, so no request can arrive before them
 * Link limits (`maxMessageBytes`, `window`, `maxInflight`, `chunkBytes`,
 * `requestTimeoutMs`, `handshakeTimeoutMs`, `features`) are passed to every link.
 */
export function createMeshChannelService({
  envelopeType = CHANNEL_ENVELOPE_TYPE,
  peerSupports,
  acceptPeer,
  maxPeers = CHANNEL_DEFAULT_MAX_PEERS,
  onLink,
  onLog,
  ...limits
} = {}) {
  if (!isPosInt(maxPeers)) throw new TypeError('createMeshChannelService: maxPeers must be a positive integer')
  // Fail on a bad limit at construction rather than at the first hello.
  createChannelCore({ peer: 'validate', sendFrame() {}, ...limits })
  const log = onLog || (() => {})
  return {
    name: 'mesh-channel',
    attach(peerNode, ctx) {
      let closed = false
      const cores = new Map() // peer -> core
      const linkListeners = new Set()
      if (onLink) linkListeners.add(onLink)

      function makeCore(peer) {
        const core = createChannelCore({
          peer,
          sendFrame: f => ctx.sendTo(peer, envelopeType, f),
          onLog: (event, data) => log(event, data),
          onReady: link => {
            for (const cb of [...linkListeners]) { try { cb(link) } catch (e) { log('mesh-channel:on-link-threw', { peer, error: e?.message }) } }
            ctx.emit('mesh-channel:link-open', { peer })
          },
          ...limits,
        })
        cores.set(peer, core)
        core.link.onClose(() => { if (cores.get(peer) === core) cores.delete(peer) })
        return core
      }

      const unsubscribe = ctx.onIncomingData(envelopeType, (from, msg) => {
        if (closed || typeof from !== 'string' || !from) return
        // `from` is the session's verified key; msg only ever carries frame fields.
        let core = cores.get(from)
        if (msg.k === 'hello') {
          if (core && core.remoteSid && core.remoteSid !== msg.sid) {
            // The peer restarted: the old link can never continue.
            core.close(err(ChannelErrorCode.CANCELLED, 'channel-reset', 'the peer opened a new channel'), { notifyRemote: false })
            core = undefined
          }
          if (!core) {
            if (cores.size >= maxPeers || (acceptPeer && acceptPeer(from) === false)) {
              ctx.sendTo(from, envelopeType, { k: 'hello-ack', error: { c: ChannelErrorCode.BUSY, r: 'refused', m: 'channel refused' } }).catch(() => {})
              return
            }
            core = makeCore(from)
          }
        }
        core?.receive(msg)
      })

      async function open(peer, { timeoutMs } = {}) {
        if (closed) throw new Error('mesh-channel: service torn down')
        if (typeof peer !== 'string' || !peer || peer.length > 512) throw new TypeError('mesh-channel: peer must identify one peer')
        if (peerSupports && peerSupports(peer) === false) {
          throw err(ChannelErrorCode.UNSUPPORTED, 'unsupported', 'the peer is known not to support mesh-channel; nothing was sent')
        }
        let core = cores.get(peer)
        if (!core) {
          if (cores.size >= maxPeers) throw err(ChannelErrorCode.BUSY, 'too-many-peers', 'too many channel links')
          core = makeCore(peer)
        }
        await core.open(timeoutMs === undefined ? undefined : { timeoutMs })
        return core.link
      }

      return {
        api: {
          open,
          /** The ready link for a peer, if one exists. */
          link: peer => { const c = cores.get(peer); return c && !c.link.closed ? c.link : undefined },
          /** Subscribe to every link that becomes ready (inbound or outbound). */
          onLink(cb) { linkListeners.add(cb); return () => linkListeners.delete(cb) },
          get peers() { return [...cores.keys()] },
        },
        teardown() {
          if (closed) return
          closed = true
          unsubscribe()
          for (const core of [...cores.values()]) core.close(err(ChannelErrorCode.CANCELLED, 'channel-closed', 'service torn down'))
          cores.clear()
        },
      }
    },
  }
}
