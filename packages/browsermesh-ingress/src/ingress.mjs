/**
 * ingress.mjs -- `createMeshIngress`: a web-standard `(Request) => Promise<Response>` that forwards each request to
 * the one mesh pod a mapping names, over protocol `http` v1 (see docs/design/http-ingress.md).
 *
 * Web-standard globals only (Request, Response, Headers, ReadableStream, AbortController, crypto.subtle): no `node:`
 * import, so it runs in Node, Deno, Bun and Workers. The Node listener is a separate entry (`./node`).
 */
import { createStreamLayer } from '@johnhenry/browsermesh-apps/protocol-stream'
import { attachService } from '@johnhenry/browsermesh-apps/mesh-service'
import { createMeshProtocolService } from '@johnhenry/browsermesh-apps/protocol-channel'
import { IngressError, REASON_HEADER } from './errors.mjs'
import {
  NO_BODY_STATUS, applyForcedHeaders, checkAddHeaders, checkClientRequestShape, checkHost, checkMappedPath, checkTarget, isPodId,
  requestHeadersForProvider, responseHeadersForClient,
} from './headers.mjs'
import { createInflight, createRateLimiter, resolveLimits } from './limits.mjs'
import { nodeLinkIdentity, resolvePeer } from './peer-identity.mjs'
import {
  FETCH_METHOD, HTTP_PROTOCOL, HTTP_VERSIONS, KIND_RESPONSE, KIND_REQUEST, WIRE_METHODS, signedBytes, signedRequestBytes, sha256Hex, validateResponseHead,
  validateStreamMeta,
} from './wire.mjs'

const unref = (t) => { t?.unref?.(); return t }
const randomHex = (n) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('')

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

/** Reject with `make()` if `promise` has not settled within `ms`. */
function within(promise, ms, make) {
  let timer
  const guard = new Promise((_, reject) => { timer = unref(setTimeout(() => reject(make()), ms)) })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

const reasonOf = (e) => (e instanceof IngressError ? e.reason : e?.name === 'AbortError' ? 'client-aborted' : 'error')

/** The failures in which the provider did no work, so a retry cannot repeat anything it did. Nothing else is ever retried. */
export const RETRYABLE_REASONS = Object.freeze(['provider-unreachable', 'provider-pin-mismatch', 'provider-declined'])
const MAX_RETRY_ATTEMPTS = 5
const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE'])

function resolveRetry(retry) {
  if (retry === undefined) return null
  if (!retry || typeof retry !== 'object' || Array.isArray(retry)) throw new TypeError('createMeshIngress: retry must be { attempts, on?, nonIdempotent? }')
  const { attempts, on = RETRYABLE_REASONS, nonIdempotent = false } = retry
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_RETRY_ATTEMPTS) throw new TypeError(`createMeshIngress: retry.attempts must be an integer from 1 to ${MAX_RETRY_ATTEMPTS}`)
  if (!Array.isArray(on) || !on.length || !on.every((r) => RETRYABLE_REASONS.includes(r))) throw new TypeError(`createMeshIngress: retry.on must be a non-empty list of ${RETRYABLE_REASONS.join(', ')}`)
  if (typeof nonIdempotent !== 'boolean') throw new TypeError('createMeshIngress: retry.nonIdempotent must be a boolean')
  return { attempts, on: new Set(on), nonIdempotent }
}

/**
 * @param {object} opts
 * @param {object} [opts.service] - a mesh service with the protocol channel: `attachService(node, undefined, createMeshProtocolService())`, or its `.api`
 * @param {object} [opts.node] - alternatively a mesh node: this attaches a protocol service to it (do not also attach one yourself) and `close()` detaches it
 * @param {(request: Request, attempt: { attempt: number, tried: string[] }) => Promise<{ peer: string, path?: string, headers?: Record<string,string>, response?: object }|null>} opts.resolve
 *   Which pod answers. `null` is a 404. `peer` is the pod id the answer is pinned to; `path` replaces the request's path;
 *   `headers` are added to what the provider is sent; `response` is `{ contentSecurityPolicy, cacheControl, allowSetCookie,
 *   addHeaders }` to opt this mapping out of the response policy, or to add headers the operator authors (`addHeaders`: at
 *   most 16 names to values; no line breaks, hop-by-hop or framing headers; the forced headers only where their own opt-out is set).
 *   The second argument is `{ attempt: 0, tried: [] }` the first time; with `retry` it is asked again with the pod ids already tried.
 * @param {{ attempts: number, on?: string[], nonIdempotent?: boolean }} [opts.retry]
 *   Off by default. After a failure in which the provider did no work (`on`: any of `provider-unreachable`,
 *   `provider-pin-mismatch`, `provider-declined`; all three by default), `resolve` is called again, up to `attempts` (1 to 5) more
 *   times, with the pods already tried; each attempt is authorised and audited on its own. Never after a provider started answering;
 *   POST and PATCH only with `nonIdempotent: true`.
 * @param {(bytes: Uint8Array, info: { peer: string }, link: PeerIdentity) => (string|Promise<string>)} [opts.signRequest]
 *   Sign each request for the provider's `verifyRequest` (the request counterpart of `verifyResponse`). The package picks no
 *   cryptography. The third argument (new) says what is verified about the link to the provider (`PeerIdentity`).
 * @param {(podId: string) => (object|undefined|Promise<object|undefined>)} [opts.linkIdentity]
 *   What is verified about the link to a provider (`{ verified: 'bound'|'wsh'|'key', publicKey? }`, or nothing). Without it, a
 *   `node` that is a mesh node (has `sessionsFor`) is read with `nodeLinkIdentity`; otherwise the answer is always `'none'`.
 * @param {(request: Request, target: object) => (boolean|Promise<boolean>)} [opts.authorize] - falsy: 403
 * @param {(request: Request) => (Response|boolean|null|Promise<Response|boolean|null>)} [opts.deny] - a Response is sent as it is; `true` is a 451
 * @param {object} [opts.limits] - see `INGRESS_LIMIT_DEFAULTS`
 * @param {string[]} [opts.methods=['GET','HEAD']]
 * @param {string[]} [opts.forwardHeaders] - request headers (beyond the default list) a client may pass to the provider
 * @param {string[]} [opts.exposeHeaders] - response headers (beyond the default list) a provider may set
 * @param {boolean} [opts.forwardClientAddress=false] - tell the provider the client's address (`client` in the head)
 * @param {(info: { peer: string, bytes: Uint8Array, sig: string, request: object }, link: PeerIdentity) => (boolean|Promise<boolean>)} [opts.verifyResponse]
 *   Signed responses: when given, a response is accepted only if it carries a signature this accepts. The response is buffered.
 *   The second argument (new) says what is verified about the link the answer came over; `requireLinkKey(verifySigner)` makes a
 *   hook that also requires the signer to be the provider link's key.
 * @param {{ request: Function }} [opts.rpc] - a mesh-rpc api: the opt-in buffered fallback for a provider that does not serve `http`
 * @param {(record: object) => void} [opts.onAudit]
 * @param {{ now: () => number }} [opts.clock] - the rate limiters' clock (tests advance one)
 */
export function createMeshIngress({
  service, node, resolve, authorize, deny, limits: limitOptions, methods = ['GET', 'HEAD'], forwardHeaders = [], exposeHeaders = [],
  forwardClientAddress = false, verifyResponse, signRequest, retry, rpc, onAudit, clock, protocol = HTTP_PROTOCOL, linkIdentity,
} = {}) {
  if (typeof resolve !== 'function') throw new TypeError('createMeshIngress: resolve(request) is required: nothing is served without a mapping')
  if (!service && !node) throw new TypeError('createMeshIngress: a mesh service (or a node to attach one to) is required')
  for (const [name, fn] of Object.entries({ authorize, deny, verifyResponse, signRequest, onAudit })) if (fn !== undefined && typeof fn !== 'function') throw new TypeError(`createMeshIngress: ${name} must be a function`)
  if (linkIdentity !== undefined && typeof linkIdentity !== 'function') throw new TypeError('createMeshIngress: linkIdentity must be a function')
  // What is verified about the link to a provider (the `peer` object `signRequest` and `verifyResponse` get as an extra
  // trailing argument). From `linkIdentity`, else read from `node` when it is a mesh node; otherwise nothing is verified.
  const linkSource = linkIdentity ?? (typeof node?.sessionsFor === 'function' ? nodeLinkIdentity(node) : null)
  const retrying = resolveRetry(retry)
  if (rpc !== undefined && typeof rpc?.request !== 'function') throw new TypeError('createMeshIngress: rpc must be a mesh-rpc api with request()')
  const allowedMethods = new Set(methods.map((m) => String(m).toUpperCase()))
  for (const m of allowedMethods) if (!WIRE_METHODS.has(m)) throw new TypeError(`createMeshIngress: method ${m} is never served (allowed: ${[...WIRE_METHODS].join(', ')})`)
  if (!allowedMethods.size) throw new TypeError('createMeshIngress: methods is empty')
  const limits = resolveLimits(limitOptions)
  const now = clock?.now ?? Date.now

  const attached = service ? null : attachService(node, undefined, createMeshProtocolService())
  const api = (service ?? attached).api ?? (service ?? attached)
  if (typeof api.openProtocol !== 'function') throw new TypeError('createMeshIngress: service has no openProtocol(); attach createMeshProtocolService()')

  const clientRate = createRateLimiter(limits.clientRate, { now, maxTracked: limits.maxTracked })
  const providerRate = createRateLimiter(limits.providerRate, { now, maxTracked: limits.maxTracked })
  const inflight = createInflight({ maxTracked: limits.maxTracked })
  const providers = new Map() // peer -> state
  const opening = new Map() // peer -> Promise<state>
  const legacy = new Map() // peer -> until: providers found not to serve `http`, asked through `rpc` meanwhile
  const LEGACY_MEMORY_MS = 60_000
  const active = new Set() // abort controllers of requests in flight
  let closed = false
  const counters = { requests: 0, served: 0, refused: 0, failed: 0, requestBytes: 0, responseBytes: 0, fallbacks: 0, retries: 0, reasons: {} }
  const count = (reason) => { counters.reasons[reason] = (counters.reasons[reason] ?? 0) + 1 }

  // ------------------------------------------------------------ HTTP responses the ingress makes itself
  function refusal(e) {
    const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', [REASON_HEADER]: e.reason })
    for (const [k, v] of Object.entries(e.headers ?? {})) headers.set(k, v)
    applyForcedHeaders(headers)
    return new Response(`${e.message}\n`, { status: e.status, headers })
  }

  // ------------------------------------------------------------ providers
  async function providerState(peer) {
    const have = providers.get(peer)
    if (have && !have.channel.closed) return have
    let p = opening.get(peer)
    if (!p) {
      p = openProvider(peer).finally(() => opening.delete(peer))
      opening.set(peer, p)
      p.catch(() => {})
    }
    return p
  }

  async function openProvider(peer) {
    let state
    let channel
    try {
      channel = await api.openProtocol(peer, protocol, {
        versions: [...HTTP_VERSIONS],
        timeoutMs: limits.openTimeoutMs,
        setup(ch) {
          const streams = createStreamLayer(ch, { maxStreams: limits.maxInflightPerProvider * 2, maxStreamBytes: Math.max(limits.maxResponseBytes, limits.maxRequestBodyBytes) })
          state = { peer, channel: ch, streams, pending: new Map(), nextRid: 1 }
          // The only streams a provider may open are response bodies for a request this end made on this channel.
          streams.onStream((reader, { meta }) => {
            validateStreamMeta(meta, KIND_RESPONSE)
            const entry = state.pending.get(meta.rid)
            if (!entry || entry.reader) throw new IngressError(400, 'bad-stream', 'No such request.')
            entry.reader = reader
            entry.readerReady.resolve(reader)
          })
        },
      })
    } catch (e) {
      state?.streams.close()
      throw openFailure(e)
    }
    if (channel.peer !== peer) {
      channel.close('provider pin mismatch')
      state.streams.close()
      throw new IngressError(502, 'provider-pin-mismatch', 'The channel is bound to a different pod than the one the mapping names; refused.')
    }
    if (!HTTP_VERSIONS.includes(channel.version)) {
      channel.close('unsupported version')
      throw new IngressError(502, 'provider-version', 'The provider speaks no version of the http protocol this ingress does.')
    }
    channel.onClose(() => {
      if (providers.get(peer) === state) providers.delete(peer)
      for (const entry of [...state.pending.values()]) {
        const e = new IngressError(502, 'provider-closed', 'The channel to the provider closed.')
        entry.readerReady.reject(e)
        entry.fail?.(e)
      }
      state.streams.close()
    })
    providers.set(peer, state)
    return state
  }

  function openFailure(e) {
    if (e instanceof IngressError) return e
    const reason = e?.reason
    if (reason === 'not-authorized' || e?.code === -32003) return new IngressError(502, 'provider-not-authorized', 'The provider has not granted this ingress the http protocol.')
    // `unsupported`: the pod never answered the channel handshake (it runs no protocol channel at all).
    if (reason === 'unknown-protocol' || reason === 'unsupported' || e?.code === -32601) return Object.assign(new IngressError(502, 'provider-no-http', 'The provider does not serve the http protocol.'), { fallbackable: true })
    if (reason === 'unsupported-version') return new IngressError(502, 'provider-version', 'The provider speaks no version of the http protocol this ingress does.')
    if (reason === 'timeout') return Object.assign(new IngressError(504, 'provider-timeout', 'The provider did not answer in time.'), { fallbackable: true })
    return new IngressError(502, 'provider-unreachable', 'The provider is not reachable over a direct link; routed delivery is not supported.')
  }

  // ------------------------------------------------------------ the request
  async function readBody(request, declared, cap) {
    if (!request.body) return new Uint8Array(0)
    if (declared !== null && declared > cap) throw new IngressError(413, 'body-too-large', `The request body is larger than ${cap} bytes.`)
    const reader = request.body.getReader()
    const parts = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await within(reader.read(), limits.bodyIdleMs, () => new IngressError(408, 'body-timeout', 'The request body was too slow.'))
        if (done) break
        size += value.byteLength
        if (size > cap) throw new IngressError(413, 'body-too-large', `The request body is larger than ${cap} bytes.`)
        parts.push(value)
      }
    } catch (e) {
      reader.cancel(e).catch(() => {})
      throw e
    }
    if (declared !== null && declared !== size) throw new IngressError(400, 'bad-framing', 'The body is not the length Content-Length declared.')
    const out = new Uint8Array(size)
    let at = 0
    for (const p of parts) { out.set(p, at); at += p.byteLength }
    return out
  }

  async function handle(request, info = {}) {
    const startedAt = now()
    const record = { peer: null, host: null, method: request?.method ?? null, status: 0, reason: undefined, requestBytes: 0, responseBytes: 0, durationMs: 0, attempt: 0 }
    let audited = false
    // An attempt that was handed on (see `retry`): audited as it happened, then the request goes on.
    const auditAttempt = (rec, e) => {
      counters.retries += 1
      count(e.reason)
      if (onAudit) { try { onAudit({ ...rec, status: e.status, reason: e.reason, retried: true, durationMs: Math.max(0, now() - startedAt) }) } catch { /* an audit sink never breaks a request */ } }
    }
    const audit = (status, reason) => {
      if (audited) return
      audited = true
      record.status = status
      record.reason = reason
      record.durationMs = Math.max(0, now() - startedAt)
      counters.requestBytes += record.requestBytes
      counters.responseBytes += record.responseBytes
      if (status >= 200 && status < 400) counters.served += 1
      else if (status >= 400 && status < 500) counters.refused += 1
      else counters.failed += 1
      if (reason) count(reason)
      if (onAudit) { try { onAudit({ ...record }) } catch { /* an audit sink never breaks a request */ } }
    }
    counters.requests += 1
    const releases = []
    const release = () => { for (const r of releases.splice(0)) r() }
    const ac = new AbortController()
    active.add(ac)
    const done = () => { active.delete(ac); release() }
    let deadline
    try {
      if (closed) throw new IngressError(503, 'closing', 'The ingress is shutting down.')
      if (!(request instanceof Request)) throw new TypeError('handle() takes a web-standard Request')
      const client = typeof info.clientAddress === 'string' && info.clientAddress ? info.clientAddress : 'unknown'
      const url = new URL(request.url)
      if (url.username || url.password) throw new IngressError(400, 'bad-host', 'A request URL with credentials is refused.')
      const host = checkHost(url.host)
      record.host = host
      const method = request.method.toUpperCase()

      if (request.headers.has('upgrade') || /\bupgrade\b/i.test(request.headers.get('connection') ?? '')) {
        throw new IngressError(426, 'upgrade-unsupported', 'WebSocket and other protocol upgrades are not supported by this ingress (v1).')
      }
      if (!allowedMethods.has(method)) throw new IngressError(405, 'method-not-allowed', `${method} is not served here.`, { headers: { allow: [...allowedMethods].join(', ') } })
      const shape = checkClientRequestShape(request.headers, method, { maxCount: limits.maxHeaderCount, maxBytes: limits.maxHeaderBytes })
      const target = checkTarget(url.pathname + url.search, limits.maxTargetLength)

      // Limits that need no mapping come first: they protect `resolve` itself.
      const global = inflight.enter('*', limits.maxInflight)
      if (!global) throw new IngressError(503, 'overloaded', 'Too many requests are being served.', { headers: { 'retry-after': '1' } })
      releases.push(global)
      const taken = clientRate.take(client)
      if (!taken.ok) throw new IngressError(429, 'client-rate', 'Too many requests from this client.', { headers: { 'retry-after': String(Math.ceil(taken.retryAfterMs / 1000)) } })
      const mine = inflight.enter(`c:${client}`, limits.maxInflightPerClient)
      if (!mine) throw new IngressError(429, 'client-inflight', 'Too many requests from this client are in flight.', { headers: { 'retry-after': '1' } })
      releases.push(mine)

      if (deny) {
        let verdict
        try { verdict = await deny(request) } catch { throw new IngressError(500, 'deny-error', 'The deny hook failed.') }
        if (verdict instanceof Response) { audit(verdict.status, 'denied'); done(); return verdict }
        if (verdict) throw new IngressError(451, 'denied', 'Unavailable for legal reasons.')
      }

      // One attempt per pass. Without `retry` there is exactly one. With it, a failure in which the provider did no work
      // (it was unreachable, it was the wrong pod, it declined) asks `resolve` again, with the pods already tried; every
      // attempt is mapped, authorised, rate-limited and audited on its own, and all of them share the one deadline.
      const tried = []
      let attempt = 0
      let lastFailure = null
      let bodyBytes = null
      let theirs = null
      for (;;) {
        let mapping
        try { mapping = await resolve(request, { attempt, tried: [...tried] }) } catch { throw new IngressError(500, 'resolve-error', 'The mapping failed.') }
        if (!mapping) throw lastFailure ?? new IngressError(404, 'no-mapping', 'Nothing is served at this address.')
        if (!isPodId(mapping.peer)) throw new IngressError(500, 'bad-mapping', 'A mapping named something that is not a pod id.')
        const peer = mapping.peer
        if (tried.includes(peer)) throw lastFailure // a pod already tried is not asked twice
        record.peer = peer
        record.attempt = attempt
        const path = mapping.path === undefined ? undefined : checkMappedPath(mapping.path)
        const outTarget = path === undefined ? target : checkTarget(path + url.search, limits.maxTargetLength)
        const outHeaders = requestHeadersForProvider(request.headers, { forward: forwardHeaders, extra: mapping.headers })
        const policy = mapping.response && typeof mapping.response === 'object' ? mapping.response : {}
        checkAddHeaders(policy) // a bad operator header is a bad mapping, found before any provider is asked

        if (authorize) {
          let ok = false
          try { ok = (await authorize(request, mapping)) === true } catch { ok = false }
          if (!ok) throw new IngressError(403, 'forbidden', 'This request is not authorised.')
        }
        const pr = providerRate.take(peer)
        if (!pr.ok) throw new IngressError(503, 'provider-rate', 'This provider is receiving too many requests.', { headers: { 'retry-after': String(Math.ceil(pr.retryAfterMs / 1000)) } })
        theirs?.() // the pod this attempt replaces
        theirs = inflight.enter(`p:${peer}`, limits.maxInflightPerProvider)
        if (!theirs) throw new IngressError(503, 'provider-inflight', 'This provider is busy.', { headers: { 'retry-after': '1' } })
        releases.push(theirs)

        if (attempt === 0) {
          // The whole request is bounded from here: the client's body, the provider's head and its body.
          deadline = unref(setTimeout(() => ac.abort(new IngressError(504, 'provider-timeout', 'The provider did not answer in time.')), limits.timeoutMs))
          request.signal?.addEventListener('abort', () => ac.abort(new IngressError(499, 'client-aborted', 'The client went away.')), { once: true })
          bodyBytes = await readBody(request, shape.contentLength, limits.maxRequestBodyBytes)
          record.requestBytes = bodyBytes.byteLength
        }
        const forward = { method, target: outTarget, host, headers: outHeaders, body: bodyBytes, client: forwardClientAddress ? client.slice(0, 64) : undefined, peer }
        try {
          // A streamed response keeps the deadline and the slots until its body ends; a buffered one is finished here.
          const response = await forwardToProvider(forward, policy, ac, record, (status, reason) => { clearTimeout(deadline); audit(status, reason); done() })
          if (response.finished) { clearTimeout(deadline); audit(response.status, undefined); done() }
          return response.response
        } catch (e) {
          const retryable = retrying && e instanceof IngressError && retrying.on.has(e.reason) && attempt < retrying.attempts && !ac.signal.aborted
            && (retrying.nonIdempotent || IDEMPOTENT.has(method))
          if (!retryable) throw e
          auditAttempt(record, e)
          lastFailure = e
          tried.push(peer)
          attempt += 1
        }
      }
    } catch (e) {
      clearTimeout(deadline)
      if (process.env.DEBUG_INGRESS && !(e instanceof IngressError && e.status < 500)) console.error('DEBUG-INGRESS', e)
      const err = e instanceof IngressError ? e : new IngressError(500, 'internal-error', 'The ingress failed.')
      audit(err.status, err.reason)
      done()
      return refusal(err)
    }
  }

  /**
   * One request to the pod `forward.peer`. Resolves with `{ response, finished, status }`: `finished` is true when
   * nothing is left running (a buffered response); a streamed one calls `finish(status, reason)` when its body ends.
   */
  async function forwardToProvider(forward, policy, ac, record, finish) {
    const { peer } = forward
    let state
    // A provider found not to serve `http` (it said so, or never answered the open: a pod that runs only the older
    // site service) is asked through mesh-rpc for a while, if the operator opted in with `rpc`.
    if (rpc && (legacy.get(peer) ?? 0) > now()) return fallbackViaRpc(forward, policy, ac, record)
    try {
      state = await within(providerState(peer), limits.openTimeoutMs + 1000, () => new IngressError(504, 'provider-timeout', 'The provider did not answer in time.'))
    } catch (e) {
      const err = e instanceof IngressError ? e : openFailure(e)
      if (err.fallbackable && rpc) { legacy.set(peer, now() + LEGACY_MEMORY_MS); return fallbackViaRpc(forward, policy, ac, record) }
      throw err
    }
    if (ac.signal.aborted) throw ac.signal.reason
    const rid = state.nextRid++
    const nonce = randomHex(16)
    const hasBody = forward.body.byteLength > 0
    // A signed request: the provider's `verifyRequest` is given exactly these bytes, rebuilt from what arrives.
    let sig
    if (signRequest) {
      try {
        const bytes = signedRequestBytes({ rid, nonce, host: forward.host, method: forward.method, target: forward.target, headers: forward.headers, client: forward.client, digest: await sha256Hex(forward.body) })
        sig = await signRequest(bytes, { peer }, await resolvePeer(linkSource, peer))
      } catch { sig = undefined }
      if (typeof sig !== 'string' || !sig || sig.length > 2048) throw new IngressError(500, 'sign-error', 'The ingress could not sign the request.')
    }
    const entry = { reader: null, readerReady: deferred(), fail: (e) => ac.abort(e) }
    state.pending.set(rid, entry)
    const cleanup = () => state.pending.delete(rid)
    const cancelReader = (why) => { entry.reader?.cancel(why).catch(() => {}); entry.readerReady.promise.then((r) => r.cancel(why).catch(() => {}), () => {}) }
    const onAbort = () => cancelReader('request ended')
    ac.signal.addEventListener('abort', onAbort, { once: true })

    let head
    try {
      const fetchP = state.channel.request(FETCH_METHOD, {
        rid, nonce, method: forward.method, target: forward.target, host: forward.host,
        headers: forward.headers, body: hasBody, ...(forward.client ? { client: forward.client } : {}), ...(sig ? { sig } : {}),
      }, { signal: ac.signal, timeoutMs: limits.timeoutMs })
      // The body travels as a stream. A provider may answer before it has read all of it: the head decides.
      if (hasBody) state.streams.sendBody(forward.body, { rid, kind: KIND_REQUEST }, { signal: ac.signal, timeoutMs: limits.openTimeoutMs }).catch(() => {})
      head = validateResponseHead(await fetchP, limits)
      // "Not me, try another": never the provider's own answer, and nothing of it reaches the client.
      if (head.declined === true) throw new IngressError(502, 'provider-declined', 'The provider declined this request.')
    } catch (e) {
      cleanup()
      ac.signal.removeEventListener('abort', onAbort)
      cancelReader('request failed')
      if (ac.signal.aborted && ac.signal.reason instanceof IngressError) throw ac.signal.reason
      if (e instanceof IngressError) throw e
      if (e?.reason === 'timeout') throw new IngressError(504, 'provider-timeout', 'The provider did not answer in time.')
      if (e?.reason === 'not-authorized') throw new IngressError(502, 'provider-not-authorized', 'The provider no longer accepts this ingress.')
      if (e?.reason === 'request-unverified') throw new IngressError(502, 'provider-refused-request', 'The provider did not accept the request\'s signature.')
      if (e?.reason === 'too-large' || e?.reason === 'stream-too-large') throw new IngressError(502, 'provider-refused-body', 'The provider would not take the request body.')
      throw new IngressError(502, e?.code === -32603 ? 'provider-error' : 'provider-failed', 'The provider failed to answer.')
    }

    const lateFail = (e) => { cleanup(); ac.signal.removeEventListener('abort', onAbort); cancelReader('refused'); throw e }
    let headers
    try {
      headers = responseHeadersForClient(head.headers, { response: policy, forward: forwardHeaders, expose: exposeHeaders })
      const lengthText = headers.get('content-length')
      if (lengthText !== null && (!/^\d{1,15}$/.test(lengthText) || Number(lengthText) > limits.maxResponseBytes)) {
        throw new IngressError(502, 'response-too-large', `The provider's response is larger than ${limits.maxResponseBytes} bytes.`)
      }
      if (verifyResponse && typeof head.sig !== 'string') throw new IngressError(502, 'response-unsigned', 'The provider did not sign its response.')
    } catch (e) { return lateFail(e) }
    const declared = headers.get('content-length') === null ? null : Number(headers.get('content-length'))
    const noBody = forward.method === 'HEAD' || NO_BODY_STATUS.has(head.status)

    // A provider that opened a stream for a bodiless answer, or none for a body: both are refused.
    let reader = null
    if (head.body && !noBody) {
      try {
        reader = await within(entry.readerReady.promise, limits.responseIdleMs, () => new IngressError(504, 'provider-idle', 'The provider announced a body and did not send it.'))
      } catch (e) { return lateFail(e) }
    } else if (entry.reader && !head.body) {
      return lateFail(new IngressError(502, 'bad-response-head', 'The provider sent a body it did not announce.'))
    } else if (head.body) {
      cancelReader('no body wanted') // announced for a response that has none (HEAD, 204, 304)
    }
    cleanup()

    if (verifyResponse) {
      try {
        const bytes = reader ? await within(reader.bytes({ maxBytes: limits.maxResponseBytes }), limits.timeoutMs, () => new IngressError(504, 'provider-timeout', 'The provider did not answer in time.')) : new Uint8Array(0)
        if (declared !== null && !noBody && bytes.byteLength !== declared) throw new IngressError(502, 'bad-response-length', 'The body is not the length the provider declared.')
        const signedFor = { rid, nonce, host: forward.host, method: forward.method, target: forward.target, status: head.status, headers: head.headers, digest: await sha256Hex(bytes) }
        let ok = false
        try {
          const link = await resolvePeer(linkSource, peer)
          ok = (await verifyResponse({ peer, bytes: signedBytes(signedFor), sig: head.sig, request: { rid, method: forward.method, target: forward.target, host: forward.host } }, link)) === true
        } catch { ok = false }
        if (!ok) throw new IngressError(502, 'response-signature-invalid', 'The provider\'s signature was not accepted.')
        ac.signal.removeEventListener('abort', onAbort)
        record.responseBytes = bytes.byteLength
        return { finished: true, status: head.status, response: new Response(noBody ? null : bytes, { status: head.status, headers }) }
      } catch (e) {
        ac.signal.removeEventListener('abort', onAbort)
        reader?.cancel('refused').catch(() => {})
        throw e instanceof IngressError ? e : new IngressError(502, e?.reason === 'stream-too-large' ? 'response-too-large' : 'provider-failed', 'The provider failed to answer.')
      }
    }
    if (!reader) {
      ac.signal.removeEventListener('abort', onAbort)
      return { finished: true, status: head.status, response: new Response(null, { status: head.status, headers }) }
    }

    // Streamed: bytes are counted as they pass; the idle and total bounds apply to every read.
    let count = 0
    let ended = false
    const end = (status, reason) => {
      if (ended) return
      ended = true
      ac.signal.removeEventListener('abort', onAbort)
      record.responseBytes = count
      finish(status, reason)
    }
    const body = new ReadableStream({
      start(controller) {
        ac.signal.addEventListener('abort', () => {
          if (ended) return
          const reason = ac.signal.reason
          reader.cancel('request ended').catch(() => {})
          try { controller.error(reason) } catch { /* already closed */ }
          end(head.status, reasonOf(reason))
        }, { once: true })
      },
      async pull(controller) {
        if (ended) return
        try {
          const { done, value } = await within(reader.read(), limits.responseIdleMs, () => new IngressError(504, 'provider-idle', 'The provider stalled.'))
          if (ended) return
          if (done) {
            if (declared !== null && count !== declared) throw new IngressError(502, 'bad-response-length', 'The body is not the length the provider declared.')
            controller.close()
            end(head.status, undefined)
            return
          }
          count += value.byteLength
          if (count > limits.maxResponseBytes || (declared !== null && count > declared)) throw new IngressError(502, count > limits.maxResponseBytes ? 'response-too-large' : 'bad-response-length', 'The provider sent more than it may.')
          controller.enqueue(value)
        } catch (e) {
          reader.cancel('refused').catch(() => {})
          if (!ended) { try { controller.error(e) } catch { /* closed */ } }
          end(head.status, e instanceof IngressError ? e.reason : e?.reason === 'stream-too-large' ? 'response-too-large' : 'provider-failed')
        }
      },
      cancel() {
        reader.cancel('client went away').catch(() => {})
        end(head.status, 'client-aborted')
      },
    }, { highWaterMark: 0 })
    return { finished: false, status: head.status, response: new Response(body, { status: head.status, headers }) }
  }

  /** The buffered fallback: one mesh-rpc request to a provider that does not serve `http` (opt-in, see the design doc). */
  async function fallbackViaRpc(forward, policy, ac, record) {
    counters.fallbacks += 1
    let result
    try {
      const body = forward.body.byteLength ? forward.body : undefined
      result = await rpc.request(forward.peer, { method: forward.method, path: forward.target, headers: Object.fromEntries(forward.headers), body }, { signal: ac.signal, timeoutMs: limits.timeoutMs })
    } catch {
      if (ac.signal.aborted && ac.signal.reason instanceof IngressError) throw ac.signal.reason
      throw new IngressError(502, 'provider-failed', 'The provider failed to answer.')
    }
    const { decodeWireResponse } = await import('@johnhenry/browsermesh-apps')
    const wire = decodeWireResponse(result)
    const status = wire.status
    if (!Number.isInteger(status) || status < 200 || status > 599) throw new IngressError(502, 'bad-response-status', 'The provider sent a status outside 200-599.')
    const bytes = wire.body instanceof Uint8Array ? wire.body : wire.body === undefined || wire.body === null ? new Uint8Array(0)
      : new TextEncoder().encode(typeof wire.body === 'string' ? wire.body : JSON.stringify(wire.body))
    if (bytes.byteLength > limits.maxResponseBytes) throw new IngressError(502, 'response-too-large', `The provider's response is larger than ${limits.maxResponseBytes} bytes.`)
    const list = Object.entries(wire.headers ?? {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]).filter(([k]) => k !== 'content-length')
    if (!list.some(([k]) => k === 'content-type') && wire.body !== undefined && typeof wire.body === 'object' && !(wire.body instanceof Uint8Array)) list.push(['content-type', 'application/json'])
    const headers = responseHeadersForClient(list, { response: policy, forward: forwardHeaders, expose: exposeHeaders })
    headers.set('content-length', String(bytes.byteLength))
    record.responseBytes = bytes.byteLength
    return { finished: true, status, response: new Response(forward.method === 'HEAD' || NO_BODY_STATUS.has(status) ? null : bytes, { status, headers }) }
  }

  return {
    handle,
    stats() {
      return { ...counters, reasons: { ...counters.reasons }, inflight: inflight.count('*'), providers: providers.size }
    },
    async close() {
      if (closed) return
      closed = true
      for (const ac of [...active]) ac.abort(new IngressError(503, 'closing', 'The ingress is shutting down.'))
      for (const state of [...providers.values()]) { try { state.streams.close(); state.channel.close('ingress closed') } catch { /* gone */ } }
      providers.clear()
      await attached?.teardown?.()
    },
  }
}
