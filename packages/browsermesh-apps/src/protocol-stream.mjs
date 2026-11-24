/**
 * protocol-stream.mjs -- bodies larger than one message, over a protocol channel.
 *
 * A protocol channel (`protocol-channel.mjs`) carries messages of at most
 * `channel.maxMessageBytes`. A layered protocol that moves a file, a snapshot
 * or a long result needs more than that without giving up what the message
 * layer already guarantees: bounded memory, a slow reader slowing the sender,
 * and cancel. This is that: a stream of byte chunks, written by one end and
 * read by the other, written against ONLY the protocol-channel interface
 * (`request`, `notify`, `onRequest`, `onNotification`, `onClose`), so it runs
 * over the mesh channel, over an in-memory duplex and over anything else that
 * satisfies `assertProtocolChannel`.
 *
 *   const streams = createStreamLayer(channel, { window, chunkBytes, maxStreams, maxStreamBytes })
 *
 *   // sending
 *   const w = await streams.open(meta, { signal })   // the receiver may refuse (throws its reason)
 *   await w.write(bytes)      // resolves when every byte of it has been sent; waits for credit
 *   await w.end()
 *   w.abort(reason)           // the reader fails with 'stream-aborted'
 *   await streams.sendBody(bytes | iterable | async iterable | ReadableStream, meta)
 *
 *   // receiving
 *   streams.onStream((reader, { meta, peer }) => { ... })  // throw to refuse
 *   for await (const chunk of reader) ...     // Uint8Array chunks; each read hands credit back
 *   await reader.bytes({ maxBytes })          // collect, bounded
 *   await reader.cancel(reason)               // the writer's pending and later writes reject 'stream-cancelled'
 *
 * Flow control. The receiver grants the writer a byte `window` per stream when
 * the stream opens. A write consumes credit; the reader returns credit as it
 * CONSUMES chunks (not when they arrive), so a reader that stops reading stops
 * the writer at one window, and the receiver never holds more than `window`
 * bytes of a stream. This is the same credit scheme the mesh channel uses for
 * its link (a sender may have at most the receiver's window unconsumed in
 * flight), one level up and per stream: the link's own credit is returned the
 * moment a notification is dispatched, so a stalled stream holds neither the
 * link nor the other requests on the channel. A sender that ignores its credit,
 * sends out of sequence, or goes past `maxStreamBytes` is cut off (the reader
 * fails with `stream-violation` / `stream-too-large` and the writer is told).
 *
 * Wire (all on the channel's own methods; nothing changes the link):
 *   request  stream.open    { id, meta }            -> { window, chunkBytes, maxBytes }
 *   notify   stream.data    { id, s, d }            opener -> receiver; `s` counts from 0, `d` is a Uint8Array
 *   notify   stream.end     { id }                  opener -> receiver
 *   notify   stream.abort   { id, reason }          opener -> receiver
 *   notify   stream.credit  { id, n }               receiver -> opener
 *   notify   stream.cancel  { id, reason }          receiver -> opener
 * Ids are chosen by the end that opens the stream, so each direction has its own.
 * A peer that does not run the layer answers `stream.open` with -32601 (method
 * not found) or does not answer at all; nothing else is sent to it.
 *
 * Authorisation is the caller's. Pass `authorize(meta, { peer })` (sync or async;
 * `peer` is the channel's verified identity, never a field of a message) and it
 * runs before the open is answered, before anything about this end is revealed:
 * throw, or return `false`, to refuse. The `onStream` handler may also refuse by
 * throwing synchronously. See `createRootAuthorizer` in `protocol-roots.mjs` for
 * per-root checks (`authorize: (meta, { peer }) => roots.assert(peer, meta.root, 'write')`).
 *
 * No browser-only imports.
 */
import { ChannelErrorCode, MeshChannelError } from './mesh-channel.mjs'

export const STREAM_DEFAULT_WINDOW_BYTES = 256 * 1024
export const STREAM_DEFAULT_CHUNK_BYTES = 32 * 1024
export const STREAM_DEFAULT_MAX_STREAMS = 16
export const STREAM_DEFAULT_MAX_STREAM_BYTES = 1024 * 1024 * 1024
/** Room left in a message for the stream frame around a chunk. */
export const STREAM_FRAMING_RESERVE_BYTES = 256
export const STREAM_METHODS = Object.freeze({
  open: 'stream.open', data: 'stream.data', end: 'stream.end', abort: 'stream.abort', credit: 'stream.credit', cancel: 'stream.cancel',
})
const MAX_REMOTE_WINDOW = 2 ** 30

const err = (code, reason, message) => new MeshChannelError(code, reason, message)
const isPosInt = n => Number.isSafeInteger(n) && n > 0
const reasonText = r => (r instanceof Error ? r.message : typeof r === 'string' ? r : r === undefined ? 'no reason given' : String(r)).slice(0, 200)
const isThenable = v => v && typeof v.then === 'function'

function toBytes(value) {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError('stream data must be a Uint8Array or another ArrayBuffer view')
}

/**
 * @param {object} channel - a protocol channel (see `assertProtocolChannel`)
 * @param {object} [opts]
 * @param {number} [opts.window=262144] - bytes of one stream this end will hold unread; also what it grants a writer
 * @param {number} [opts.chunkBytes=32768] - largest chunk this end sends or accepts (also bounded by the channel's message size)
 * @param {number} [opts.maxStreams=16] - concurrent streams per direction
 * @param {number} [opts.maxStreamBytes=1073741824] - the most one stream may carry
 * @param {Function} [opts.onLog]
 */
export function createStreamLayer(channel, {
  window: windowBytes = STREAM_DEFAULT_WINDOW_BYTES,
  chunkBytes: chunkOption,
  maxStreams = STREAM_DEFAULT_MAX_STREAMS,
  maxStreamBytes = STREAM_DEFAULT_MAX_STREAM_BYTES,
  authorize,
  onLog,
} = {}) {
  if (authorize !== undefined && typeof authorize !== 'function') throw new TypeError('createStreamLayer: authorize must be a function')
  for (const m of ['request', 'notify', 'onRequest', 'onNotification', 'onClose']) {
    if (!channel || typeof channel[m] !== 'function') throw new TypeError(`createStreamLayer: channel is missing ${m}()`)
  }
  const chunkBytes = chunkOption === undefined ? Math.min(STREAM_DEFAULT_CHUNK_BYTES, windowBytes) : chunkOption
  for (const [name, value] of Object.entries({ window: windowBytes, chunkBytes, maxStreams, maxStreamBytes })) {
    if (!isPosInt(value)) throw new TypeError(`createStreamLayer: ${name} must be a positive integer`)
  }
  if (windowBytes > MAX_REMOTE_WINDOW) throw new TypeError('createStreamLayer: window is too large')
  if (chunkBytes > windowBytes) throw new TypeError('createStreamLayer: chunkBytes cannot exceed window')
  const log = onLog || (() => {})

  const outgoing = new Map() // id -> writer state
  const incoming = new Map() // id -> reader state
  let nextId = 1
  let acceptor = null
  let layerClosed = false
  const offs = []

  /** Largest chunk this end may put in one message of the channel. */
  const chunkLimit = () => Math.max(1, Math.min(chunkBytes, (Number.isSafeInteger(channel.maxMessageBytes) ? channel.maxMessageBytes : chunkBytes + STREAM_FRAMING_RESERVE_BYTES) - STREAM_FRAMING_RESERVE_BYTES))
  const tell = (method, params) => { try { Promise.resolve(channel.notify(method, params)).catch(() => {}) } catch { /* channel gone */ } }

  // ------------------------------------------------------------------ reader
  function makeReader(id, meta, peer) {
    const st = {
      id, meta, peer, queue: [], buffered: 0, owed: 0, total: 0, nextSeq: 0,
      ended: false, cancelled: false, error: null, waiters: [], released: false,
    }
    const release = () => { if (!st.released) { st.released = true; incoming.delete(id) } }
    const wake = () => { for (const w of st.waiters.splice(0)) w() }
    const returnCredit = (force) => {
      if (st.owed <= 0 || st.ended || st.cancelled || st.error) return
      if (!force && st.owed < windowBytes / 2 && st.queue.length) return
      const n = st.owed
      st.owed = 0
      tell(STREAM_METHODS.credit, { id, n })
    }
    // `keepQueue`: chunks already delivered stay readable, and the error comes after them.
    st.fail = (e, { notify, keepQueue } = {}) => {
      if (st.error || st.cancelled) return
      st.error = e
      if (!keepQueue) {
        st.queue.length = 0
        st.buffered = 0
      }
      release()
      if (notify) tell(STREAM_METHODS.cancel, { id, reason: e.reason })
      wake()
    }
    st.pushed = (bytes) => {
      st.queue.push(bytes)
      st.buffered += bytes.byteLength
      st.total += bytes.byteLength
      wake()
    }
    st.finish = () => { st.ended = true; if (!st.queue.length) release(); wake() }

    const reader = {
      id,
      meta,
      peer,
      get bufferedBytes() { return st.buffered },
      get bytesRead() { return st.total - st.buffered },
      get closed() { return st.cancelled || !!st.error || (st.ended && !st.queue.length) },
      /** Next chunk, `{ done: true }` at the end (or after a local cancel), or a throw if the stream failed. */
      async read() {
        for (;;) {
          if (st.queue.length) {
            const value = st.queue.shift()
            st.buffered -= value.byteLength
            st.owed += value.byteLength
            if (st.ended && !st.queue.length) release()
            returnCredit(false)
            return { done: false, value }
          }
          if (st.error) throw st.error
          if (st.cancelled || st.ended) { release(); return { done: true, value: undefined } }
          returnCredit(true)
          await new Promise(resolve => st.waiters.push(resolve))
        }
      },
      /** Stop reading. The writer's pending and later writes reject with `stream-cancelled`. */
      async cancel(reason) {
        if (st.cancelled || st.error || (st.ended && !st.queue.length)) return
        st.cancelled = true
        st.queue.length = 0
        st.buffered = 0
        release()
        tell(STREAM_METHODS.cancel, { id, reason: reasonText(reason) })
        wake()
      },
      /** Collect the rest of the stream, failing with TOO_LARGE past `maxBytes`. */
      async bytes({ maxBytes = Infinity } = {}) {
        const parts = []
        let n = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          n += value.byteLength
          if (n > maxBytes) {
            await reader.cancel('body too large')
            throw err(ChannelErrorCode.TOO_LARGE, 'stream-too-large', `stream is larger than ${maxBytes} bytes`)
          }
          parts.push(value)
        }
        const out = new Uint8Array(n)
        let at = 0
        for (const p of parts) { out.set(p, at); at += p.byteLength }
        return out
      },
      [Symbol.asyncIterator]() {
        return {
          next: () => reader.read(),
          return: async () => { await reader.cancel('iteration stopped'); return { done: true, value: undefined } },
        }
      },
      /** A web `ReadableStream` that pulls one chunk at a time (no read-ahead beyond the window). */
      toReadableStream() {
        return new ReadableStream({
          async pull(controller) {
            try {
              const { done, value } = await reader.read()
              if (done) controller.close()
              else controller.enqueue(value)
            } catch (e) { controller.error(e) }
          },
          cancel: reason => reader.cancel(reason),
        }, { highWaterMark: 0 })
      },
    }
    st.reader = reader
    return st
  }

  // ------------------------------------------------------------------ writer
  function makeWriter(id, meta) {
    const controller = new AbortController()
    const st = {
      id, window: 0, chunkBytes: 0, maxBytes: Infinity, credit: 0, sent: 0, seq: 0,
      state: 'opening', error: null, waiters: [], tail: Promise.resolve(), controller,
    }
    const wake = () => { for (const w of st.waiters.splice(0)) w() }
    st.stop = (state, e) => {
      if (st.state === 'ended' || st.state === 'cancelled' || st.state === 'aborted' || st.state === 'failed') return
      st.state = state
      st.error = e
      outgoing.delete(id)
      try { controller.abort(e) } catch { /* ignore */ }
      wake()
    }
    st.granted = (n) => { st.credit = Math.min(st.credit + n, st.window); wake() }
    const waitForCredit = (signal) => new Promise((resolve, reject) => {
      const onAbort = () => reject(err(ChannelErrorCode.CANCELLED, 'cancelled', 'write aborted'))
      if (signal?.aborted) return onAbort()
      const done = () => { signal?.removeEventListener('abort', onAbort); resolve() }
      st.waiters.push(done)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    const live = () => {
      if (st.error) throw st.error
      if (st.state === 'ended') throw err(ChannelErrorCode.CANCELLED, 'stream-closed', 'the stream has ended')
    }

    async function writeNow(bytes, signal) {
      live()
      if (st.sent + bytes.byteLength > st.maxBytes) {
        throw err(ChannelErrorCode.TOO_LARGE, 'stream-too-large', `the stream would exceed ${st.maxBytes} bytes`)
      }
      let offset = 0
      while (offset < bytes.byteLength) {
        live()
        if (st.credit <= 0) { await waitForCredit(signal); continue }
        const size = Math.min(bytes.byteLength - offset, st.chunkBytes, st.credit, chunkLimit())
        st.credit -= size
        st.sent += size
        const d = bytes.slice(offset, offset + size)
        offset += size
        await channel.notify(STREAM_METHODS.data, { id, s: st.seq++, d })
      }
    }

    const writer = {
      id,
      meta,
      get window() { return st.window },
      get chunkBytes() { return st.chunkBytes },
      get maxBytes() { return st.maxBytes },
      get bytesWritten() { return st.sent },
      /** Aborted when the reader cancels, the stream is aborted, or the channel closes. */
      signal: controller.signal,
      write(data, { signal } = {}) {
        let bytes
        try { bytes = toBytes(data) } catch (e) { return Promise.reject(e) }
        const run = st.tail.then(() => writeNow(bytes, signal))
        st.tail = run.catch(() => {})
        return run.catch((e) => {
          // An aborted write leaves the stream with a hole in it: the whole stream is abandoned.
          if (e?.reason === 'cancelled' && st.state === 'open') writer.abort(e)
          throw e
        })
      },
      /** Finish the stream: the reader sees the end after the last chunk. */
      end() {
        const run = st.tail.then(async () => {
          live()
          st.state = 'ended'
          outgoing.delete(id)
          wake()
          await channel.notify(STREAM_METHODS.end, { id })
        })
        st.tail = run.catch(() => {})
        return run
      },
      /** Abandon the stream: the reader fails with `stream-aborted` after the chunks already delivered. */
      abort(reason) {
        if (st.error || st.state === 'ended') return
        const e = err(ChannelErrorCode.CANCELLED, 'stream-aborted', `stream aborted: ${reasonText(reason)}`)
        st.stop('aborted', e)
        tell(STREAM_METHODS.abort, { id, reason: reasonText(reason) })
      },
      /** A web `WritableStream` that writes each chunk, ends on close and aborts on abort. */
      toWritableStream() {
        return new WritableStream({
          write: chunk => writer.write(chunk),
          close: () => writer.end(),
          abort: reason => writer.abort(reason),
        })
      },
    }
    st.writer = writer
    return st
  }

  // -------------------------------------------------------------- receiving
  offs.push(channel.onRequest(STREAM_METHODS.open, async (params, ctx) => {
    if (layerClosed) throw err(ChannelErrorCode.CANCELLED, 'channel-closed', 'stream layer closed')
    const id = params?.id
    if (!isPosInt(id) || incoming.has(id)) throw err(ChannelErrorCode.INVALID, 'bad-stream-id', 'invalid stream id')
    const peer = ctx?.peer ?? channel.peer
    if (authorize) {
      // Before anything about this end is revealed (whether it accepts streams, how many are open).
      const verdict = await authorize(params.meta, { peer })
      if (verdict === false || verdict?.allowed === false) throw err(ChannelErrorCode.UNAUTHORIZED, 'not-authorized', 'not authorised to open that stream')
      if (layerClosed) throw err(ChannelErrorCode.CANCELLED, 'channel-closed', 'stream layer closed')
      if (incoming.has(id)) throw err(ChannelErrorCode.INVALID, 'bad-stream-id', 'invalid stream id')
    }
    if (!acceptor) throw err(ChannelErrorCode.METHOD_NOT_FOUND, 'no-stream-handler', 'this end does not accept streams')
    if (incoming.size >= maxStreams) throw err(ChannelErrorCode.BUSY, 'too-many-streams', 'too many streams open')
    const st = makeReader(id, params.meta, peer)
    incoming.set(id, st)
    try {
      const result = acceptor(st.reader, { meta: params.meta, peer })
      if (isThenable(result)) {
        result.then(undefined, (e) => {
          log('protocol-stream:handler-threw', { id, error: e?.message })
          st.reader.cancel(e).catch(() => {})
        })
      }
    } catch (e) {
      incoming.delete(id)
      throw e
    }
    return { window: windowBytes, chunkBytes: chunkLimit(), maxBytes: maxStreamBytes }
  }))

  const violation = (st, message) => st.fail(err(ChannelErrorCode.INVALID, 'stream-violation', message), { notify: true, keepQueue: true })

  offs.push(channel.onNotification(STREAM_METHODS.data, (params) => {
    const st = incoming.get(params?.id)
    if (!st || st.ended || st.cancelled || st.error) return
    let bytes
    try { bytes = toBytes(params.d) } catch { return violation(st, 'data frame without bytes') }
    if (params.s !== st.nextSeq) return violation(st, 'data frame out of sequence')
    if (bytes.byteLength > chunkLimit()) return violation(st, 'chunk exceeds the advertised chunk size')
    if (st.buffered + bytes.byteLength > windowBytes) return violation(st, 'writer exceeded the credit it was granted')
    if (st.total + bytes.byteLength > maxStreamBytes) {
      return st.fail(err(ChannelErrorCode.TOO_LARGE, 'stream-too-large', `stream is larger than ${maxStreamBytes} bytes`), { notify: true, keepQueue: true })
    }
    st.nextSeq++
    st.pushed(bytes)
  }))
  offs.push(channel.onNotification(STREAM_METHODS.end, (params) => {
    const st = incoming.get(params?.id)
    if (st && !st.cancelled && !st.error) st.finish()
  }))
  offs.push(channel.onNotification(STREAM_METHODS.abort, (params) => {
    const st = incoming.get(params?.id)
    st?.fail(err(ChannelErrorCode.CANCELLED, 'stream-aborted', `the writer aborted the stream: ${reasonText(params?.reason)}`), { keepQueue: true })
  }))
  offs.push(channel.onNotification(STREAM_METHODS.credit, (params) => {
    const st = outgoing.get(params?.id)
    if (st && isPosInt(params.n)) st.granted(params.n)
  }))
  offs.push(channel.onNotification(STREAM_METHODS.cancel, (params) => {
    const st = outgoing.get(params?.id)
    st?.stop('cancelled', err(ChannelErrorCode.CANCELLED, 'stream-cancelled', `the reader cancelled the stream: ${reasonText(params?.reason)}`))
  }))

  function failAll(why) {
    for (const st of [...outgoing.values()]) st.stop('failed', why)
    for (const st of [...incoming.values()]) st.fail(why)
  }
  offs.push(channel.onClose(() => {
    layerClosed = true
    failAll(err(ChannelErrorCode.CANCELLED, 'channel-closed', 'channel closed'))
  }))

  // ----------------------------------------------------------------- opening
  async function open(meta = {}, { signal, timeoutMs } = {}) {
    if (layerClosed) throw err(ChannelErrorCode.CANCELLED, 'channel-closed', 'stream layer closed')
    if (signal?.aborted) throw err(ChannelErrorCode.CANCELLED, 'cancelled', 'open aborted')
    if (outgoing.size >= maxStreams) throw err(ChannelErrorCode.BUSY, 'too-many-streams', 'too many streams open')
    const id = nextId++
    const st = makeWriter(id, meta)
    outgoing.set(id, st)
    let res
    try {
      res = await channel.request(STREAM_METHODS.open, { id, meta }, { signal, timeoutMs })
      if (st.error) throw st.error // cancelled or the channel closed before the answer
      if (!res || !isPosInt(res.window) || !isPosInt(res.chunkBytes) || res.window > MAX_REMOTE_WINDOW || !isPosInt(res.maxBytes)) {
        throw err(ChannelErrorCode.INVALID, 'bad-stream-open', 'the receiver answered with unusable stream limits')
      }
    } catch (e) {
      if (!st.error) tell(STREAM_METHODS.abort, { id, reason: 'open failed' })
      st.stop('failed', e)
      throw e
    }
    st.window = res.window
    st.credit = res.window
    st.chunkBytes = Math.min(res.chunkBytes, chunkLimit())
    st.maxBytes = Math.min(res.maxBytes, maxStreamBytes)
    st.state = 'open'
    return st.writer
  }

  return {
    open,
    /**
     * Accept streams the other end opens. `handler(reader, { meta, peer })` runs
     * before the open is answered: throw (or throw a `MeshChannelError`) to refuse;
     * start consuming and return. A rejected promise it returns cancels the stream.
     */
    onStream(handler) {
      if (typeof handler !== 'function') throw new TypeError('onStream needs a function')
      acceptor = handler
      return () => { if (acceptor === handler) acceptor = null }
    },
    /**
     * Send a whole body: bytes, an (async) iterable of bytes, or a `ReadableStream`.
     * Aborts the stream if the source fails; `signal` abandons it.
     * @returns {Promise<{ bytes: number }>}
     */
    async sendBody(source, meta, { signal, timeoutMs } = {}) {
      const w = await open(meta, { signal, timeoutMs })
      try {
        if (source && typeof source.getReader === 'function') {
          const r = source.getReader()
          try {
            for (;;) { const { done, value } = await r.read(); if (done) break; await w.write(value, { signal }) }
          } finally { r.releaseLock() }
        } else if (source && (typeof source[Symbol.asyncIterator] === 'function' || (typeof source[Symbol.iterator] === 'function' && !ArrayBuffer.isView(source)))) {
          for await (const part of source) await w.write(part, { signal })
        } else {
          await w.write(source, { signal })
        }
        const bytes = w.bytesWritten
        await w.end()
        return { bytes }
      } catch (e) {
        w.abort(e)
        throw e
      }
    },
    /** Streams currently open: `{ outgoing, incoming }`. */
    stats() { return { outgoing: outgoing.size, incoming: incoming.size } },
    /** Detach from the channel and fail every open stream. */
    close() {
      layerClosed = true
      for (const off of offs.splice(0)) { try { off() } catch { /* already gone */ } }
      failAll(err(ChannelErrorCode.CANCELLED, 'channel-closed', 'stream layer closed'))
    },
  }
}
