/**
 * provider.mjs -- the pod that answers: `serveHttpOnMesh(service, handler, { allowFrom, limits })`.
 *
 * A `(Request) => Response` handler (or `{ fetch }`) is served over protocol `http` v1 to the ingress pods named in
 * `allowFrom`. Two gates, both default deny: `protocol:http:open` in the provider's registry (the protocol host's own
 * authorisation) and `allowFrom` (this function's). The caller is the channel's verified peer, never a field of a message.
 */
import { createStreamLayer } from '@johnhenry/browsermesh-apps/protocol-stream'
import { ChannelErrorCode, MeshChannelError } from '@johnhenry/browsermesh-apps/mesh-channel'
import { IngressError } from './errors.mjs'
import { NO_BODY_STATUS, isPodId } from './headers.mjs'
import {
  FETCH_METHOD, HTTP_PROTOCOL, HTTP_VERSIONS, KIND_REQUEST, KIND_RESPONSE, sha256Hex, signedBytes, validateRequestHead, validateStreamMeta,
} from './wire.mjs'

export const PROVIDER_LIMIT_DEFAULTS = Object.freeze({
  maxInflight: 16,
  maxRequestBodyBytes: 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  handlerTimeoutMs: 30_000,
  bodyWaitMs: 10_000,
  maxHeaderCount: 64,
  maxHeaderBytes: 16 * 1024,
  maxTargetLength: 2048,
})

const unref = (t) => { t?.unref?.(); return t }
const asChannelError = (e) => (e instanceof MeshChannelError ? e
  : e instanceof IngressError ? new MeshChannelError(e.status === 405 ? ChannelErrorCode.UNSUPPORTED : ChannelErrorCode.INVALID, e.reason, e.message)
    : new MeshChannelError(ChannelErrorCode.INTERNAL, 'handler-failed', 'the handler failed'))

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/**
 * @param {object} service - a mesh service with the protocol channel (`attachService(node, undefined, createMeshProtocolService())`, or its `.api`)
 * @param {Function|{ fetch: Function }} handler - `(request, { peer, signal, client }) => Response | Promise<Response>`
 * @param {object} opts
 * @param {string[]|((peer: string) => boolean)} opts.allowFrom - the ingress pods served; required, nothing is served to any other
 * @param {object} [opts.limits] - see `PROVIDER_LIMIT_DEFAULTS`
 * @param {(bytes: Uint8Array, info: { peer: string }) => (string|Promise<string>)} [opts.sign] - sign the response: the provider buffers it so the signature covers the body
 * @param {string} [opts.protocol='http']
 * @returns {{ stop(): void, stats(): object }}
 */
export function serveHttpOnMesh(service, handler, { allowFrom, limits: limitOptions, sign, protocol = HTTP_PROTOCOL, onLog } = {}) {
  const api = service && typeof service === 'object' ? (service.api ?? service) : null
  if (typeof api?.serveProtocol !== 'function') throw new TypeError('serveHttpOnMesh: the first argument is a mesh service with serveProtocol (createMeshProtocolService)')
  const fn = typeof handler === 'function' ? handler : typeof handler?.fetch === 'function' ? (req, ctx) => handler.fetch(req, ctx) : null
  if (!fn) throw new TypeError('serveHttpOnMesh: handler must be a function or { fetch }')
  if (sign !== undefined && typeof sign !== 'function') throw new TypeError('serveHttpOnMesh: sign must be a function')
  let allowed
  if (Array.isArray(allowFrom) && allowFrom.length && allowFrom.every(isPodId)) { const set = new Set(allowFrom); allowed = (p) => set.has(p) }
  else if (typeof allowFrom === 'function') allowed = (p) => { try { return allowFrom(p) === true } catch { return false } }
  else throw new TypeError('serveHttpOnMesh: allowFrom (a non-empty list of ingress pod ids, or a function) is required: nothing is served to a pod that is not named')
  const limits = { ...PROVIDER_LIMIT_DEFAULTS, ...limitOptions }
  for (const [k, v] of Object.entries(limits)) if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`serveHttpOnMesh: limits.${k} must be a positive integer`)
  const log = onLog || (() => {})

  const channels = new Set()
  const counters = { channels: 0, requests: 0, refused: 0, errors: 0, requestBytes: 0, responseBytes: 0, inflight: 0 }

  function accept(channel, { peer }) {
    if (!allowed(peer)) { counters.refused += 1; channel.close('not an ingress this pod serves'); return }
    counters.channels += 1
    channels.add(channel)
    // One cap per layer, for both directions: the larger of the two. The request body's own cap is enforced where it is read.
    const streams = createStreamLayer(channel, { maxStreams: limits.maxInflight * 2, maxStreamBytes: Math.max(limits.maxRequestBodyBytes, limits.maxResponseBytes) })
    const bodies = new Map() // rid -> { reader } | { waiter }
    let inflight = 0

    streams.onStream((reader, { meta }) => {
      if (!allowed(peer)) throw new IngressError(403, 'forbidden', 'not served')
      validateStreamMeta(meta, KIND_REQUEST)
      if (bodies.size >= limits.maxInflight * 2) throw new IngressError(503, 'busy', 'too many bodies waiting')
      const have = bodies.get(meta.rid)
      if (have?.reader) throw new IngressError(400, 'bad-stream', 'a body for that request is already open')
      if (have?.waiter) { have.waiter.resolve(reader); bodies.set(meta.rid, { reader }); return }
      // A body that arrives before its request is held for a bounded time, then dropped.
      const entry = { reader }
      entry.timer = unref(setTimeout(() => { if (bodies.get(meta.rid) === entry) { bodies.delete(meta.rid); reader.cancel('no request claimed this body').catch(() => {}) } }, limits.bodyWaitMs))
      bodies.set(meta.rid, entry)
    })

    const claimBody = async (rid, signal) => {
      const have = bodies.get(rid)
      if (have?.reader) { clearTimeout(have.timer); return have.reader }
      const waiter = deferred()
      bodies.set(rid, { waiter })
      const timer = unref(setTimeout(() => waiter.reject(new IngressError(408, 'body-timeout', 'the request body did not arrive')), limits.bodyWaitMs))
      const onAbort = () => waiter.reject(signal.reason ?? new Error('aborted'))
      signal.addEventListener('abort', onAbort, { once: true })
      try { return await waiter.promise } finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
    }

    channel.onRequest(FETCH_METHOD, async (params, ctx) => {
      if (!allowed(peer)) { counters.refused += 1; throw new MeshChannelError(ChannelErrorCode.UNAUTHORIZED, 'not-authorized', 'not served') }
      if (inflight >= limits.maxInflight) throw new MeshChannelError(ChannelErrorCode.BUSY, 'busy', 'too many requests in flight')
      let head
      try { head = validateRequestHead(params, limits) } catch (e) { counters.errors += 1; throw asChannelError(e) }
      inflight += 1
      counters.requests += 1
      counters.inflight += 1
      const ac = new AbortController()
      const onCancel = () => ac.abort(ctx.signal.reason)
      ctx.signal?.addEventListener('abort', onCancel, { once: true })
      const timer = unref(setTimeout(() => ac.abort(new Error('handler deadline exceeded')), limits.handlerTimeoutMs))
      let handedOff = false
      const finish = () => {
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onCancel)
        const had = bodies.get(head.rid)
        if (had) { clearTimeout(had.timer); bodies.delete(head.rid) }
        inflight -= 1
        counters.inflight -= 1
      }
      try {
        const request = await buildRequest(head, ac, claimBody, limits.maxRequestBodyBytes, counters)
        const response = await fn(request, { peer, signal: ac.signal, client: head.client })
        if (!response || typeof response !== 'object' || !Number.isInteger(response.status) || !response.headers || typeof response.headers.entries !== 'function') {
          throw new MeshChannelError(ChannelErrorCode.INTERNAL, 'bad-handler-result', 'the handler did not return a Response')
        }
        if (response.status < 200 || response.status > 599) throw new MeshChannelError(ChannelErrorCode.INTERNAL, 'bad-handler-status', 'the handler returned a status outside 200-599')
        const headers = [...response.headers.entries()]
        const hasBody = !!response.body && head.method !== 'HEAD' && !NO_BODY_STATUS.has(response.status)
        if (!hasBody && response.body) response.body.cancel?.().catch?.(() => {})

        if (sign) {
          const bytes = hasBody ? await collect(response.body, limits.maxResponseBytes, ac.signal) : new Uint8Array(0)
          counters.responseBytes += bytes.byteLength
          const lengthed = headers.filter(([n]) => n !== 'content-length')
          if (hasBody) lengthed.push(['content-length', String(bytes.byteLength)])
          const sig = await sign(signedBytes({ rid: head.rid, nonce: head.nonce, host: head.host, method: head.method, target: head.target, status: response.status, headers: lengthed, digest: await sha256Hex(bytes) }), { peer })
          let writer = null
          if (hasBody) writer = await streams.open({ rid: head.rid, kind: KIND_RESPONSE })
          handedOff = true
          if (writer) pump(writer, new ReadableStream({ start(c) { c.enqueue(bytes); c.close() } }), { limits, counters, ac, done: finish })
          else finish()
          return { status: response.status, headers: lengthed, body: hasBody, sig }
        }
        let writer = null
        if (hasBody) writer = await streams.open({ rid: head.rid, kind: KIND_RESPONSE })
        handedOff = true
        if (writer) pump(writer, response.body, { limits, counters, ac, done: finish })
        else finish()
        return { status: response.status, headers, body: hasBody }
      } catch (e) {
        counters.errors += 1
        log('http:handler-failed', { peer, error: e?.message })
        throw asChannelError(e)
      } finally {
        if (!handedOff) finish()
      }
    })

    channel.onClose(() => { streams.close(); channels.delete(channel); for (const b of bodies.values()) clearTimeout(b.timer) })
  }

  const unserve = api.serveProtocol(protocol, accept, { versions: [...HTTP_VERSIONS] })
  return {
    stop() {
      unserve()
      for (const channel of [...channels]) { try { channel.close('stopped') } catch { /* gone */ } }
      channels.clear()
    },
    stats: () => ({ ...counters, open: channels.size }),
  }
}

async function buildRequest(head, ac, claimBody, maxBytes, counters) {
  const headers = new Headers()
  for (const [name, value] of head.headers) headers.append(name, value)
  if (head.client) headers.set('x-forwarded-for', head.client)
  let body
  if (head.body) {
    if (head.method === 'GET' || head.method === 'HEAD') throw new IngressError(400, 'body-on-get', 'a body on a method that has none')
    const reader = await claimBody(head.rid, ac.signal)
    // Read whole, bounded: a handler gets an ordinary Request body. (A ReadableStream as a Request body is not
    // supported by every browser, and a page is the usual provider.) One that outgrows the cap stops the sender.
    try { body = await reader.bytes({ maxBytes }) } catch (e) {
      if (e?.reason === 'stream-too-large') throw new IngressError(413, 'body-too-large', 'the request body is larger than this provider takes')
      throw e
    }
    counters.requestBytes += body.byteLength
  }
  return new Request(`http://${head.host}${head.target}`, { method: head.method, headers, body, signal: ac.signal, redirect: 'manual' })
}

async function collect(stream, max, signal) {
  const reader = stream.getReader()
  const parts = []
  let n = 0
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason
      const { done, value } = await reader.read()
      if (done) break
      n += value.byteLength
      if (n > max) throw new MeshChannelError(ChannelErrorCode.TOO_LARGE, 'response-too-large', 'the response is larger than the limit')
      parts.push(value)
    }
  } catch (e) { reader.cancel(e).catch(() => {}); throw e }
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}

/** Copy a response body into the stream the ingress holds: credit-paced, cancelled from the other end, bounded. */
async function pump(writer, body, { limits, counters, ac, done }) {
  const reader = body.getReader()
  let sent = 0
  const stop = () => { reader.cancel('stream cancelled').catch(() => {}) }
  writer.signal.addEventListener('abort', stop, { once: true })
  ac.signal.addEventListener('abort', () => { writer.abort(ac.signal.reason ?? 'deadline'); stop() }, { once: true })
  try {
    for (;;) {
      const { done: end, value } = await reader.read()
      if (end) break
      if (!(value instanceof Uint8Array)) throw new TypeError('the response body must be bytes')
      sent += value.byteLength
      if (sent > limits.maxResponseBytes) throw new MeshChannelError(ChannelErrorCode.TOO_LARGE, 'response-too-large', 'the response is larger than the limit')
      await writer.write(value)
      counters.responseBytes += value.byteLength
    }
    await writer.end()
  } catch (e) {
    writer.abort(e)
    stop()
  } finally {
    writer.signal.removeEventListener('abort', stop)
    done()
  }
}

/**
 * Wrap a serverless site handler (`createSiteRequestHandler(siteConfig)` from `@johnhenry/browsermesh-apps`) as a
 * `(Request) => Response` handler, so a site that already exists can be served over `http`.
 * @param {(req: { fromPubKey?: string, method: string, path: string, headers: object, body?: * }) => Promise<{ status: number, headers: object, body: * }>} onRequest
 */
export function fromSiteHandler(onRequest) {
  if (typeof onRequest !== 'function') throw new TypeError('fromSiteHandler: a site request handler is required')
  return async (request, { peer } = {}) => {
    const url = new URL(request.url)
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
    const result = await onRequest({ fromPubKey: peer, method: request.method, path: url.pathname + url.search, headers: Object.fromEntries(request.headers), body })
    const { decodeWireResponse } = await import('@johnhenry/browsermesh-apps')
    const wire = decodeWireResponse(result)
    const bytes = wire.body instanceof Uint8Array ? wire.body : wire.body === undefined || wire.body === null ? null
      : new TextEncoder().encode(typeof wire.body === 'string' ? wire.body : JSON.stringify(wire.body))
    const headers = new Headers(wire.headers ?? {})
    headers.delete('content-length')
    if (bytes && typeof wire.body === 'object' && !(wire.body instanceof Uint8Array) && !headers.has('content-type')) headers.set('content-type', 'application/json')
    const noBody = request.method === 'HEAD' || NO_BODY_STATUS.has(wire.status ?? 200)
    return new Response(noBody ? null : bytes, { status: wire.status ?? 200, headers })
  }
}
