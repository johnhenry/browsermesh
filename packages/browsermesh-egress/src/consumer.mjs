/**
 * consumer.mjs -- `connectEgress`: open TCP connections and look up names through ONE provider pod.
 *
 *   const link = await connectEgress(service, providerPodId)
 *   const socket = await link.connect('registry.example', 443)   // a netway StreamSocket: read(), write(), end() (half-close), close()
 *   const addresses = await link.lookup('registry.example')      // IPv4 strings; rejects `name-not-found` for a name that does not exist
 *   net.addBackend('tcp', link.asBackend())                      // route a netway VirtualNetwork through it
 *
 * Browser-safe: web-standard globals only, no `node:` import. The provider is pinned: a channel bound to any other pod is
 * refused. A pod id is never a destination (a provider dials a network, never another egress).
 *
 * Backpressure is the socket's: `read()` is the consumer's pause (a socket nobody reads stops the provider's origin after
 * about two windows), `write()` resolves when the bytes have been taken, `end()` is the half-close in both directions.
 */
import { StreamSocket } from '@johnhenry/browsermesh-netway'
import { createStreamLayer } from '@johnhenry/browsermesh-apps/protocol-stream'
import { checkHost, checkPort, looksLikePodId } from './destination.mjs'
import { END_REASONS, EgressError, errorFromAnswer } from './errors.mjs'
import {
  CONNECT_METHOD, EGRESS_CONSUMER, EGRESS_PROTOCOL, EGRESS_VERSIONS, END_METHOD, KIND_DOWN, KIND_UP, RESOLVE_METHOD, randomHex,
  signedRequestBytes, validateAddresses, validateStreamMeta,
} from './wire.mjs'
import { EgressBackend } from './backend.mjs'

export const CONSUMER_LIMIT_DEFAULTS = Object.freeze({
  /** Time to open the channel to the provider, ms. */
  openTimeoutMs: 10_000,
  /** Time the provider has to answer a connect or a lookup, ms. */
  requestTimeoutMs: 30_000,
  /** Connections open on this link at once. */
  maxConnections: 32,
  /** Bytes of one stream held unread: with the socket's own window, what a stalled reader can make this side hold, per direction. */
  streamWindowBytes: 256 * 1024,
  /** The receive window of the socket `connect` returns, bytes. */
  socketWindowBytes: 256 * 1024,
  /** Stream rules the provider may break before this side cuts the link. */
  maxViolations: 8,
})

const unref = (t) => { t?.unref?.(); return t }

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function within(promise, ms, make) {
  let timer
  const guard = new Promise((_, reject) => { timer = unref(setTimeout(() => reject(make()), ms)) })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

function resolveLimits(given = {}) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw new TypeError('connectEgress: limits must be an object')
  for (const name of Object.keys(given)) if (!Object.hasOwn(CONSUMER_LIMIT_DEFAULTS, name)) throw new TypeError(`connectEgress: limits.${name} is not a limit (known: ${Object.keys(CONSUMER_LIMIT_DEFAULTS).join(', ')})`)
  const out = { ...CONSUMER_LIMIT_DEFAULTS, ...given }
  for (const [k, v] of Object.entries(out)) if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`connectEgress: limits.${k} must be a positive integer`)
  return out
}

/** What a failed channel open means, as an error. */
function openFailure(e) {
  if (e instanceof EgressError) return e
  const reason = e?.reason
  if (reason === 'not-authorized' || e?.code === -32003) return new EgressError('provider-not-authorized')
  if (reason === 'unknown-protocol' || reason === 'unsupported' || e?.code === -32601) return new EgressError('provider-no-egress')
  if (reason === 'unsupported-version') return new EgressError('provider-version')
  if (reason === 'timeout') return new EgressError('provider-timeout')
  if (e?.name === 'AbortError' || reason === 'cancelled') return new EgressError('aborted')
  return new EgressError('provider-unreachable')
}

/** What a failed request means, as an error. */
function requestFailure(e) {
  if (e instanceof EgressError) return e
  const reason = e?.reason
  if (reason === 'timeout') return new EgressError('provider-timeout')
  if (reason === 'not-authorized') return new EgressError('provider-not-authorized')
  if (reason === 'channel-closed' || reason === 'stream-abuse') return new EgressError('provider-closed')
  if (e?.name === 'AbortError' || reason === 'cancelled') return new EgressError('aborted')
  return new EgressError('unknown')
}

/**
 * @param {object} service - a mesh service with the protocol channel (`attachService(node, undefined, createMeshProtocolService())`, or its `.api`)
 * @param {string} provider - the pod id of the provider. The channel is pinned to it.
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] - aborts opening the link
 * @param {object} [opts.limits] - see `CONSUMER_LIMIT_DEFAULTS`
 * @param {(bytes: Uint8Array, info: { peer: string }) => (string|Promise<string>)} [opts.signRequest]
 *   Sign each connect and lookup for the provider's `verifyRequest`. The package picks no cryptography.
 * @param {string} [opts.protocol='egress']
 * @returns {Promise<{ peer: string, closed: boolean, connect: Function, lookup: Function, asBackend: Function, stats: Function, close: Function }>}
 */
export async function connectEgress(service, provider, { signal, limits: limitOptions, signRequest, protocol = EGRESS_PROTOCOL, onLog } = {}) {
  const api = service && typeof service === 'object' ? (service.api ?? service) : null
  if (typeof api?.openProtocol !== 'function') throw new TypeError('connectEgress: the first argument is a mesh service with openProtocol (createMeshProtocolService)')
  if (typeof provider !== 'string' || !provider) throw new TypeError('connectEgress: the provider\'s pod id is required: the link is pinned to it')
  if (signRequest !== undefined && typeof signRequest !== 'function') throw new TypeError('connectEgress: signRequest must be a function')
  const limits = resolveLimits(limitOptions)

  const pending = new Map() // cid -> entry, from the request until the socket exists
  const active = new Map() // cid -> entry, while the socket lives
  const entries = () => [...pending.values(), ...active.values()]
  let streams
  let channel
  let closed = false
  let nextCid = 1
  const counters = { connections: 0, refused: 0, lookups: 0, bytesUp: 0, bytesDown: 0 }

  try {
    channel = await api.openProtocol(provider, protocol, {
      versions: [...EGRESS_VERSIONS],
      timeoutMs: limits.openTimeoutMs,
      signal,
      setup(ch) {
        streams = createStreamLayer(ch, {
          maxStreams: limits.maxConnections * 2,
          window: limits.streamWindowBytes,
          // The provider's own accounting ends a connection that has moved too much, and says why; this layer's cap must not get there first.
          maxStreamBytes: Number.MAX_SAFE_INTEGER,
          maxViolations: limits.maxViolations,
          onAbuse: () => { try { ch.close('the provider broke stream rules') } catch { /* gone */ } },
          onLog,
        })
        // The only streams a provider may open are the answer streams of a connection this side asked for, once each.
        let strikes = 0
        streams.onStream((reader, { meta }) => {
          try {
            validateStreamMeta(meta, KIND_DOWN)
            const entry = pending.get(meta.cid)
            if (!entry || entry.reader) throw new EgressError('bad-request', 'No such connection.')
            entry.reader = reader
            entry.ready.resolve(reader)
          } catch (e) {
            // A provider that keeps opening streams nobody asked for is cut off, as one that breaks the stream rules is.
            strikes += 1
            if (strikes > limits.maxViolations) { try { ch.close('the provider opened streams nobody asked for') } catch { /* gone */ } }
            throw e
          }
        })
        ch.onNotification(END_METHOD, (params) => {
          const entry = pending.get(params?.cid) ?? active.get(params?.cid)
          if (entry && typeof params.reason === 'string' && Object.hasOwn(END_REASONS, params.reason)) entry.endReason = params.reason
        })
      },
    })
  } catch (e) {
    try { streams?.close() } catch { /* gone */ }
    throw openFailure(e)
  }
  if (channel.peer !== provider) {
    try { channel.close('provider pin mismatch') } catch { /* gone */ }
    streams.close()
    throw new EgressError('provider-pin-mismatch', 'The channel is bound to a different pod than the one named; refused.')
  }
  if (!EGRESS_VERSIONS.includes(channel.version)) {
    try { channel.close('unsupported version') } catch { /* gone */ }
    streams.close()
    throw new EgressError('provider-version')
  }
  channel.onClose(() => {
    closed = true
    for (const e of entries()) e.fail?.(new EgressError(e.endReason ? 'connection-ended' : 'provider-closed', undefined, { reason: e.endReason }))
    streams.close()
  })

  const destinationOf = (host, port) => {
    if (typeof host !== 'string') throw new EgressError('bad-destination', 'The host is not a string.')
    // A pod id is an address on the mesh, never a destination on a network: this is how a chain through a second egress is named.
    if (looksLikePodId(host) || host === provider) throw new EgressError('chaining-refused', 'A mesh pod is not a destination: a provider dials a network, never another egress.')
    const { host: h, kind } = checkHost(host.toLowerCase())
    return { host: h, kind, port: port === undefined ? undefined : checkPort(port) }
  }

  const sign = async (form, fields) => {
    if (!signRequest) return {}
    const nonce = randomHex(16)
    let sig
    try { sig = await signRequest(signedRequestBytes({ form, nonce, ...fields }), { peer: provider }) } catch { sig = undefined }
    if (typeof sig !== 'string' || !sig || sig.length > 2048) throw new EgressError('bad-request', 'The request could not be signed.')
    return { nonce, sig }
  }

  const live = () => { if (closed || channel.closed) throw new EgressError('link-closed') }

  /** Cancel what a failed connect left behind. */
  const abandon = (entry, why) => { pending.delete(entry.cid); entry.reader?.cancel(why).catch(() => {}); entry.ready.promise.then((r) => r.cancel(why).catch(() => {}), () => {}) }

  async function connect(host, port, { signal: callSignal } = {}) {
    live()
    const dest = destinationOf(host, port)
    if (pending.size + active.size >= limits.maxConnections) throw new EgressError('too-many-connections')
    const cid = nextCid++
    const entry = { cid, reader: null, ready: deferred(), endReason: undefined, fail: null }
    pending.set(cid, entry)
    const ac = new AbortController()
    const onAbort = () => ac.abort(callSignal.reason)
    if (callSignal?.aborted) { pending.delete(cid); throw new EgressError('aborted') }
    callSignal?.addEventListener('abort', onAbort, { once: true })
    entry.fail = (e) => ac.abort(e)
    let answer
    try {
      answer = await channel.request(CONNECT_METHOD, { cid, host: dest.host, port: dest.port, hops: 0, ...(await sign('connect', { cid, host: dest.host, port: dest.port })) }, { signal: ac.signal, timeoutMs: limits.requestTimeoutMs })
    } catch (e) {
      callSignal?.removeEventListener('abort', onAbort)
      abandon(entry, 'request failed')
      if (ac.signal.aborted && ac.signal.reason instanceof EgressError) throw ac.signal.reason
      throw requestFailure(e)
    }
    if (!answer || typeof answer !== 'object' || typeof answer.ok !== 'boolean') {
      callSignal?.removeEventListener('abort', onAbort)
      abandon(entry, 'unreadable answer')
      throw new EgressError('bad-answer')
    }
    if (!answer.ok) {
      callSignal?.removeEventListener('abort', onAbort)
      abandon(entry, 'refused')
      counters.refused += 1
      throw errorFromAnswer(answer)
    }

    let down
    let up
    try {
      down = await within(entry.ready.promise, limits.requestTimeoutMs, () => new EgressError('provider-timeout', 'The provider announced a connection and did not open its stream.'))
      up = await streams.open({ cid, kind: KIND_UP }, { signal: ac.signal, timeoutMs: limits.openTimeoutMs })
    } catch (e) {
      callSignal?.removeEventListener('abort', onAbort)
      abandon(entry, 'no stream')
      throw requestFailure(e)
    }
    pending.delete(cid)
    active.set(cid, entry)
    const [user, relay] = StreamSocket.createPair({ windowBytes: limits.socketWindowBytes })
    counters.connections += 1
    let over = false
    let aDone = false
    let bDone = false
    const settle = () => { if (aDone && bDone) { active.delete(cid); callSignal?.removeEventListener('abort', onAbort) } }
    const fail = (e) => {
      if (over) return
      over = true
      const err = e instanceof EgressError ? e : new EgressError(closed ? 'link-closed' : channel.closed ? 'provider-closed' : 'connection-ended', undefined, { reason: entry.endReason })
      relay.destroy(err)
      down.cancel('failed').catch(() => {})
      up.abort('failed')
      aDone = bDone = true
      settle()
    }
    entry.fail = fail
    ac.signal.addEventListener('abort', () => { if (callSignal?.aborted) fail(new EgressError('aborted')) }, { once: true })

    // The caller's sends, to the provider: one chunk at a time, paced by the provider's credit; EOF is the half-close.
    ;(async () => {
      try {
        for (;;) {
          const chunk = await relay.read()
          if (chunk === null) break
          await up.write(chunk)
          counters.bytesUp += chunk.byteLength
        }
        await up.end()
        aDone = true
        settle()
      } catch (e) { fail(entry.endReason ? undefined : e?.reason === 'stream-cancelled' ? undefined : e) }
    })()
    // The provider's sends, to the caller: the next chunk is read only when the socket has room, so the caller's pause is the origin's.
    ;(async () => {
      try {
        for (;;) {
          const { done, value } = await down.read()
          if (done) break
          await relay.write(value)
          counters.bytesDown += value.byteLength
        }
        await relay.end()
        bDone = true
        settle()
      } catch (e) {
        // The socket was closed by its owner: stop the provider's side too. Anything else is the provider ending the connection.
        if (over) return
        if (e?.name === 'SocketClosedError' && !entry.endReason) { over = true; down.cancel('closed').catch(() => {}); up.end().catch(() => {}); aDone = bDone = true; settle(); return }
        fail(undefined)
      }
    })()
    return user
  }

  async function lookup(name, { signal: callSignal } = {}) {
    live()
    if (typeof name !== 'string') throw new EgressError('bad-destination', 'The name is not a string.')
    if (looksLikePodId(name) || name === provider) throw new EgressError('chaining-refused', 'A mesh pod is not a name: a provider looks names up on a network, never through another egress.')
    const { host, kind } = checkHost(name.toLowerCase())
    if (kind !== 'name') throw new EgressError('bad-destination', 'An address is not looked up: only a name.')
    counters.lookups += 1
    let answer
    try {
      answer = await channel.request(RESOLVE_METHOD, { name: host, type: 'A', hops: 0, ...(await sign('resolve', { host })) }, { signal: callSignal, timeoutMs: limits.requestTimeoutMs })
    } catch (e) { throw requestFailure(e) }
    if (!answer || typeof answer !== 'object' || typeof answer.ok !== 'boolean') throw new EgressError('bad-answer')
    if (!answer.ok) { counters.refused += 1; throw errorFromAnswer(answer) }
    return validateAddresses(answer)
  }

  connect[EGRESS_CONSUMER] = true
  lookup[EGRESS_CONSUMER] = true
  const link = {
    /** The provider's pod id (the channel's verified peer). */
    peer: provider,
    get closed() { return closed || channel.closed },
    connect,
    lookup,
    /** A netway `Backend` (connect and resolve) to register on a `VirtualNetwork`: `net.addBackend('tcp', link.asBackend())`. */
    asBackend() { return new EgressBackend(link) },
    stats: () => ({ ...counters, open: active.size + pending.size }),
    /** End every connection and close the channel. */
    async close() {
      if (closed) return
      closed = true
      for (const e of entries()) e.fail?.(new EgressError('link-closed'))
      try { streams.close(); channel.close('link closed') } catch { /* gone */ }
    },
  }
  link[EGRESS_CONSUMER] = true
  return link
}
