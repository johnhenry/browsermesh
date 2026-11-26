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
import { LINK_KEY_REFUSALS, LinkKeyRefusal, nodeLinkIdentity, resolvePeer, unverifiedPeer } from './peer-identity.mjs'
import {
  FETCH_METHOD, HTTP_PROTOCOL, HTTP_VERSIONS, KIND_REQUEST, KIND_RESPONSE, SERVICES_METHOD, SERVICE_NAME_RE, sha256Hex, signedBytes, signedRequestBytes,
  validateRequestHead, validateStreamMeta,
} from './wire.mjs'

const MAX_SERVICES = 32
const asHandler = (h) => (typeof h === 'function' ? h : typeof h?.fetch === 'function' ? (req, ctx) => h.fetch(req, ctx) : null)

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

/** How long `stop()` waits for the close notices to leave the pod: a link that cannot send them does not hold the stop up. */
const CLOSE_FLUSH_MS = 2_000
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
 * @param {string[]|((podId: string, context: { peer: string, protocol: string, version: number }, peer: PeerIdentity) => (boolean|Promise<boolean>))} opts.allowFrom
 *   The ingress pods served; required, nothing is served to any other. A list names pod ids. A function is asked with the
 *   channel's pod id, a context and (a third argument, new) what is verified about the link: the `peer` object, see
 *   `PeerIdentity`; on open and again for every request; only `true` serves (anything else, a throw or a rejection refuses).
 *   With a function the provider's own check carries the weight (for an ingress whose pod id is new each session: verify a
 *   signed request with `verifyRequest`, and bind its signer to the link with `requireLinkKey`).
 * @param {(request: Request, context: { peer: string, sig: string|undefined, bytes: Uint8Array, rid: number, nonce: string }, peer: PeerIdentity) => (boolean|Promise<boolean>)} [opts.verifyRequest]
 *   Runs before the handler, on a clone of the request (its body is still the handler's to read). Only `true` lets the request
 *   through; `false`, anything else or a throw refuses it and the handler never runs. `sig` is what the ingress's `signRequest`
 *   made (absent when it signed nothing) and `bytes` is exactly what it signed, rebuilt from what arrived. The third argument
 *   (new) says what is verified about the link the request came over; `context` is unchanged (its `peer` is still the pod id
 *   string). `requireLinkKey(verifySigner)` makes a hook that also requires the signer to be the link's key.
 * @param {object} [opts.node] - a mesh node (`createMeshNode`'s result): what the peer object says about a link is read from the node's sessions (`nodeLinkIdentity`). Without `node` or `linkIdentity` it is always `verified: 'none'`.
 * @param {(podId: string) => ({ verified: 'bound'|'wsh'|'key', publicKey?: Uint8Array }|undefined|Promise<object|undefined>)} [opts.linkIdentity]
 *   A custom source for the peer object, in place of `node`: say what is verified about the link to `podId`, or nothing. It can
 *   only narrow (anything it does not say clearly, a throw, a public key that does not hash to the pod id: `'none'`).
 * @param {object} [opts.limits] - see `PROVIDER_LIMIT_DEFAULTS`
 * @param {(bytes: Uint8Array, info: { peer: string }) => (string|Promise<string>)} [opts.sign] - sign the response: the provider buffers it so the signature covers the body
 * @param {Record<string, Function|{ fetch: Function }>} [opts.services]
 *   Named services this pod serves besides (or instead of) the one handler: each a `(request, context) => Response` or `{ fetch }`.
 *   A route that names a service reaches that handler, which finds the name in `context.service`; a pod that declares nothing is
 *   never sent a service name. With `services`, `handler` may be `null` (no default: a route with no service is refused). Up to 32,
 *   names of the form `[a-z0-9][a-z0-9._-]{0,63}`.
 * @param {string} [opts.protocol='http']
 * @returns {{ stop(): void, stats(): object }}
 */
export function serveHttpOnMesh(service, handler, { allowFrom, limits: limitOptions, sign, verifyRequest, node, linkIdentity, protocol = HTTP_PROTOCOL, onLog, services } = {}) {
  const api = service && typeof service === 'object' ? (service.api ?? service) : null
  if (typeof api?.serveProtocol !== 'function') throw new TypeError('serveHttpOnMesh: the first argument is a mesh service with serveProtocol (createMeshProtocolService)')
  let named = null // name -> handler; null when this pod declares no services
  if (services !== undefined) {
    if (!services || typeof services !== 'object' || Array.isArray(services)) throw new TypeError('serveHttpOnMesh: services must be an object of name to handler')
    const entries = Object.entries(services)
    if (!entries.length || entries.length > MAX_SERVICES) throw new TypeError(`serveHttpOnMesh: services must name 1 to ${MAX_SERVICES} services`)
    named = new Map()
    for (const [name, h] of entries) {
      if (!SERVICE_NAME_RE.test(name)) throw new TypeError(`serveHttpOnMesh: "${name}" is not a service name (lowercase letters, digits, . _ -)`)
      const f = asHandler(h)
      if (!f) throw new TypeError(`serveHttpOnMesh: the service ${name} needs a function or { fetch }`)
      named.set(name, f)
    }
  }
  const fn = handler === null && named ? null : asHandler(handler)
  if (!fn && !(handler === null && named)) throw new TypeError('serveHttpOnMesh: handler must be a function or { fetch }')
  if (sign !== undefined && typeof sign !== 'function') throw new TypeError('serveHttpOnMesh: sign must be a function')
  if (verifyRequest !== undefined && typeof verifyRequest !== 'function') throw new TypeError('serveHttpOnMesh: verifyRequest must be a function')
  if (linkIdentity !== undefined && typeof linkIdentity !== 'function') throw new TypeError('serveHttpOnMesh: linkIdentity must be a function')
  // Where "what is verified about the link" comes from. Nothing configured: nothing is verified (`'none'`), never a guess.
  const linkSource = linkIdentity ?? (node !== undefined ? nodeLinkIdentity(node) : null)
  /** @type {(peer: string, context: object) => (boolean|Promise<boolean>)} Never throws; true or false, or a promise of one. */
  let decide
  if (Array.isArray(allowFrom) && allowFrom.length && allowFrom.every(isPodId)) { const set = new Set(allowFrom); decide = (p) => set.has(p) }
  else if (typeof allowFrom === 'function') {
    const ask = (p, context, peer) => {
      let verdict
      try { verdict = allowFrom(p, context, peer) } catch { return false }
      return verdict && typeof verdict.then === 'function' ? Promise.resolve(verdict).then((v) => v === true, () => false) : verdict === true
    }
    decide = (p, context) => (linkSource ? resolvePeer(linkSource, p).then((peer) => ask(p, context, peer)) : ask(p, context, unverifiedPeer(p)))
  } else throw new TypeError('serveHttpOnMesh: allowFrom (a non-empty list of ingress pod ids, or a function) is required: nothing is served to a pod that is not named')
  const limits = { ...PROVIDER_LIMIT_DEFAULTS, ...limitOptions }
  for (const [k, v] of Object.entries(limits)) if (!Number.isSafeInteger(v) || v <= 0) throw new TypeError(`serveHttpOnMesh: limits.${k} must be a positive integer`)
  const log = onLog || (() => {})

  const channels = new Set()
  let stopping = false // set by `stop()`: no request is begun any more (a pod that is stopping answers `stopping`)
  const idleListeners = new Set() // called whenever a request in flight ends
  const counters = { channels: 0, requests: 0, refused: 0, declined: 0, errors: 0, requestBytes: 0, responseBytes: 0, inflight: 0 }
  // Why `verifyRequest` refused, by named reason: `request-unverified` for a hook that said no, or one of `requireLinkKey`'s.
  const refusals = {}
  const KNOWN_REFUSALS = new Set(Object.values(LINK_KEY_REFUSALS))

  function accept(channel, { peer, version }) {
    const context = { peer, protocol, version }
    // `open` is the verdict at the open: true, false, or null while an async `allowFrom` is still deciding. Nothing is
    // served on a channel whose verdict is not true: every request asks again (below) and a body that arrives meanwhile
    // is only held, bounded, until a request claims it.
    const first = decide(peer, context)
    let open = typeof first === 'boolean' ? first : null
    const refuse = () => { open = false; counters.refused += 1; channels.delete(channel); channel.close('not an ingress this pod serves') }
    if (open === false) { counters.refused += 1; channel.close('not an ingress this pod serves'); return }
    counters.channels += 1
    channels.add(channel)
    if (open === null) first.then((ok) => { if (ok) open = true; else refuse() })
    // One cap per layer, for both directions: the larger of the two. The request body's own cap is enforced where it is read.
    const streams = createStreamLayer(channel, { maxStreams: limits.maxInflight * 2, maxStreamBytes: Math.max(limits.maxRequestBodyBytes, limits.maxResponseBytes) })
    const bodies = new Map() // rid -> { reader } | { waiter }
    let inflight = 0

    streams.onStream((reader, { meta }) => {
      if (open === false) throw new IngressError(403, 'forbidden', 'not served')
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

    // Only a pod that declares services answers this: any other pod (an older release included) answers "unknown method", which
    // the ingress reads as "no named services".
    if (named) {
      channel.onRequest(SERVICES_METHOD, async () => {
        if (open === false || (await decide(peer, context)) !== true) { counters.refused += 1; throw new MeshChannelError(ChannelErrorCode.UNAUTHORIZED, 'not-authorized', 'not served') }
        return { services: [...named.keys()].sort(), default: fn !== null }
      })
    }

    channel.onRequest(FETCH_METHOD, async (params, ctx) => {
      if (open === false) { counters.refused += 1; throw new MeshChannelError(ChannelErrorCode.UNAUTHORIZED, 'not-authorized', 'not served') }
      // Told before anything is read or run: the ingress answers the visitor 503 `provider-stopping` and the handler never sees it.
      if (stopping) { counters.refused += 1; throw new MeshChannelError(ChannelErrorCode.BUSY, 'stopping', 'this pod is stopping') }
      // Asked again for every request, so a function that stops saying yes stops the next request, and a decision still
      // pending at the open is settled before any work (a list is a plain lookup).
      if ((await decide(peer, context)) !== true) {
        if (open !== false) refuse()
        else counters.refused += 1
        throw new MeshChannelError(ChannelErrorCode.UNAUTHORIZED, 'not-authorized', 'not served')
      }
      if (inflight >= limits.maxInflight) throw new MeshChannelError(ChannelErrorCode.BUSY, 'busy', 'too many requests in flight')
      let head
      try { head = validateRequestHead(params, limits) } catch (e) { counters.errors += 1; throw asChannelError(e) }
      // A service the pod did not declare is never served, whatever the ingress says; with none named, the default handler.
      const target = head.service === undefined ? fn : named?.get(head.service)
      if (!target) { counters.refused += 1; throw new MeshChannelError(ChannelErrorCode.INVALID, 'unknown-service', 'this pod serves no such service') }
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
        for (const listener of [...idleListeners]) listener()
      }
      try {
        const { request, body: bodyBytes } = await buildRequest(head, ac, claimBody, limits.maxRequestBodyBytes, counters)
        if (verifyRequest) {
          const bytes = signedRequestBytes({
            rid: head.rid, nonce: head.nonce, host: head.host, method: head.method, target: head.target, headers: head.headers, client: head.client,
            digest: await sha256Hex(bodyBytes ?? new Uint8Array(0)), service: head.service,
          })
          let ok = false
          let why = 'request-unverified'
          const link = await resolvePeer(linkSource, peer)
          try { ok = (await verifyRequest(request.clone(), { peer, sig: head.sig, bytes, rid: head.rid, nonce: head.nonce }, link)) === true } catch (e) {
            ok = false
            if (e instanceof LinkKeyRefusal && KNOWN_REFUSALS.has(e.reason)) why = e.reason
          }
          if (!ok) {
            refusals[why] = (refusals[why] ?? 0) + 1
            log('http:request-refused', { peer, reason: why })
            counters.refused += 1
            throw new MeshChannelError(ChannelErrorCode.UNAUTHORIZED, 'request-unverified', 'the request was not accepted')
          }
        }
        const response = await target(request, { peer, signal: ac.signal, client: head.client, ...(head.service === undefined ? {} : { service: head.service }) })
        if (response && typeof response === 'object' && DECLINED.has(response)) {
          // "Not me, try another": nothing of the response is sent, and no body was produced.
          counters.declined += 1
          return { status: 421, headers: [], body: false, declined: true }
        }
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
  /** Resolves when no request is in flight, or after `ms`. */
  const drained = (ms) => new Promise((resolve) => {
    let timer
    const check = () => { if (counters.inflight === 0) done() }
    const done = () => { clearTimeout(timer); idleListeners.delete(check); resolve() }
    timer = unref(setTimeout(done, ms))
    idleListeners.add(check)
    check()
  })
  let stopped = null
  return {
    /**
     * Stop serving: no new link is accepted, and the channels close. Returns a promise that resolves once the channels' close
     * notices have left this pod (at most `CLOSE_FLUSH_MS`), so `await served.stop()` before closing the node is what makes
     * the ingress hear that its requests are over. `graceMs` (default 0: end everything at once, as before) lets the requests
     * being answered finish first, for at most that long; a request that arrives meanwhile is refused (the ingress answers
     * the visitor 503 `provider-stopping`). A second call is the same stop.
     */
    stop({ graceMs = 0 } = {}) {
      if (!Number.isSafeInteger(graceMs) || graceMs < 0) throw new TypeError('serveHttpOnMesh: stop({ graceMs }) must be a non-negative integer of milliseconds')
      if (stopped) return stopped
      stopping = true
      unserve()
      stopped = (async () => {
        if (graceMs > 0 && counters.inflight > 0) await drained(graceMs)
        const notices = [...channels].map((channel) => { try { return channel.close('stopped') } catch { return undefined } })
        channels.clear()
        // (a channel of an older apps closes without a promise: there is nothing to wait for)
        await new Promise((resolve) => {
          const timer = unref(setTimeout(resolve, CLOSE_FLUSH_MS))
          Promise.allSettled(notices).then(() => { clearTimeout(timer); resolve() })
        })
      })()
      return stopped
    },
    stats: () => ({ ...counters, open: channels.size, refusals: { ...refusals } }),
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
  return { request: new Request(`http://${head.host}${head.target}`, { method: head.method, headers, body, signal: ac.signal, redirect: 'manual' }), body }
}

const DECLINED = new WeakSet()

/**
 * A handler's way to say "not me, try another": return this instead of a response when this pod cannot answer the
 * request and has done no work for it. The ingress surfaces it as the named failure `provider-declined` (never as this
 * pod's own response) and, if it was given a `retry` option, resolves the request again with this pod's id in `tried`.
 * Only the object this returns declines: a response that merely has status 421 is an ordinary answer.
 * @returns {Response}
 */
export function declineRequest() {
  const response = new Response(null, { status: 421 })
  DECLINED.add(response)
  return response
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
  return async (request, { peer, service } = {}) => {
    const url = new URL(request.url)
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
    const result = await onRequest({ fromPubKey: peer, method: request.method, path: url.pathname + url.search, headers: Object.fromEntries(request.headers), body, ...(service === undefined ? {} : { service }) })
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
