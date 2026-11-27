/**
 * node.mjs -- a Node HTTP/1.1 listener for a `createMeshIngress` handler. The only entry of this package that
 * imports `node:` modules.
 *
 * Plain HTTP only: terminate TLS in front (a reverse proxy or a platform). Binds to loopback unless `public: true`.
 */
import http from 'node:http'
import { isIP } from 'node:net'
import { IngressError, REASON_HEADER } from './errors.mjs'
import { applyForcedHeaders, checkHost } from './headers.mjs'
import { STANDARD_ALLOW, isMethodToken } from './wire.mjs'

/** After an answer that left the upload unfinished, the listener reads and discards what the client is still sending, up to this much and this long, then hangs up. */
const LINGER_BYTES = 1024 * 1024
const LINGER_MS = 2000
const EXPECTING = Symbol('expect-100-continue')
const CLOSING = Symbol('closing-after-an-early-answer')

export function isLoopbackHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/**
 * The client address: the socket's, unless `trustProxy` says exactly how many trusted proxies are in front
 * (`true` is one): then the entry that many places from the right of `X-Forwarded-For`, which is the one the
 * outermost trusted proxy appended. Entries to its left are the client's own claim and are never used.
 * An entry that is not an IP address is ignored in favour of the socket's.
 */
export function clientAddressOf(socketAddress, xForwardedFor, trustProxy) {
  const hops = trustProxy === true ? 1 : Number.isInteger(trustProxy) && trustProxy > 0 ? trustProxy : 0
  if (!hops || typeof xForwardedFor !== 'string') return socketAddress ?? 'unknown'
  const entries = xForwardedFor.split(',').map((s) => s.trim()).filter(Boolean)
  const candidate = entries[entries.length - hops]
  return candidate && isIP(candidate) ? candidate : (socketAddress ?? 'unknown')
}

/**
 * @param {{ handle(request: Request, info?: object): Promise<Response> }} ingress
 * @param {object} [opts]
 * @param {number} [opts.port=0]
 * @param {string} [opts.host='127.0.0.1']
 * @param {boolean} [opts.public=false] - required to bind anything but loopback: the caller states it has put TLS in front
 * @param {boolean|number} [opts.trustProxy=false]
 * @param {number} [opts.maxConnections=256]
 * @param {boolean} [opts.halfClosedClients=false] - a client's end of file after its whole request is a half-close, not a hang-up: the answer is still sent (see the comment in the code for the cost)
 * @returns {Promise<{ port: number, host: string, close(): Promise<void>, server: http.Server }>}
 */
export async function listenNode(ingress, { port = 0, host = '127.0.0.1', public: isPublic = false, trustProxy = false, maxConnections = 256, maxHeaderBytes = 16 * 1024, headersTimeoutMs = 10_000, requestTimeoutMs = Math.max(300_000, ingress?.limits?.uploadTimeoutMs ?? 0), readyPath, halfClosedClients = false } = {}) {
  if (!ingress || typeof ingress.handle !== 'function') throw new TypeError('listenNode: an ingress with handle() is required')
  if (!isLoopbackHost(host) && isPublic !== true) throw new Error(`listenNode: ${host} is not a loopback address; pass public: true once TLS is terminated in front of this listener`)
  if (readyPath !== undefined) {
    if (typeof readyPath !== 'string' || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(readyPath) || readyPath.startsWith('//')) throw new TypeError('listenNode: readyPath must be a plain absolute path such as /_ready')
    if (typeof ingress.readiness !== 'function') throw new TypeError('listenNode: readyPath needs an ingress with readiness()')
  }
  const onRequest = (req, res) => {
    // A connection that was answered early with `Connection: close` serves nothing more: bytes pipelined behind the upload are not a request.
    if (req.socket?.[CLOSING]) { req.socket.destroy(); return }
    // The one path this listener answers itself, when asked to: whether the pods the ingress was told to expect are linked. It
    // names no pod, takes no query and shadows that exact path for every host, so choose one no pod serves.
    if (readyPath !== undefined && req.url === readyPath && (req.method === 'GET' || req.method === 'HEAD')) {
      const state = ingress.readiness()
      const body = JSON.stringify(state)
      res.writeHead(state.ready ? 200 : 503, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }
    serve(ingress, req, res, trustProxy, allowOf(ingress)).catch(() => { if (!res.headersSent) fail(res, new IngressError(500, 'internal-error', 'The ingress failed.')); else res.destroy() })
  }
  const server = http.createServer({ maxHeaderSize: maxHeaderBytes, insecureHTTPParser: false, requestTimeout: requestTimeoutMs, headersTimeout: headersTimeoutMs, keepAliveTimeout: 5000, connectionsCheckingInterval: Math.min(5000, headersTimeoutMs) }, onRequest)
  // `Expect: 100-continue`: Node would answer "100 Continue" the moment the head arrives. This listener holds it until the ingress
  // reads the first byte of the body (after the method, mapping, limits and the provider have all said yes), so a client that is
  // going to be refused is told so with no body sent. A client that does not wait sends the body anyway, which is bounded as any is.
  server.on('checkContinue', (req, res) => { req[EXPECTING] = true; onRequest(req, res) })
  server.maxConnections = maxConnections
  // A client's end of file is ambiguous: `nc -N` / `shutdown(SHUT_WR)` mean "I have sent my request and am waiting", and a browser's
  // aborted fetch (Firefox, WebKit) is also only a FIN. Node's default treats it as a hang-up: the page's handler is aborted and an
  // answer that is not ready is lost. `halfClosedClients: true` treats it as a half-close: the connection stays open for the answer and
  // ends after the response, bounded by the ingress's request timeout. Off by default, because it also means a hang-up that is only a
  // FIN no longer aborts the handler until that timeout.
  server.httpAllowHalfOpen = halfClosedClients === true
  server.on('clientError', (err, socket) => {
    // A method Node's HTTP parser does not know (it parses `http.METHODS`) is "not implemented" (RFC 9110 15.6.2), not a bad request.
    // The answer says which methods this listener carries and that the programmatic handler carries any token.
    if (err?.code === 'HPE_INVALID_METHOD') {
      const e = new IngressError(501, 'method-not-implemented', `This listener carries the methods Node's HTTP parser knows (http.METHODS: ${http.METHODS.join(', ')}), and not this one. The programmatic handle() carries any RFC 9110 method token.`)
      const body = e.message
      if (socket.writable) socket.end(`HTTP/1.1 501 Not Implemented\r\nContent-Type: text/plain; charset=utf-8\r\n${REASON_HEADER}: ${e.reason}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
      else socket.destroy()
      return
    }
    const line = err?.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : err?.code === 'ERR_HTTP_REQUEST_TIMEOUT' ? '408 Request Timeout' : '400 Bad Request'
    if (socket.writable) socket.end(`HTTP/1.1 ${line}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    else socket.destroy()
  })
  // An Upgrade is answered by the handler (426); a CONNECT is not served at all.
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => { server.off('error', reject); resolve() }) })
  const address = server.address()
  return {
    port: address.port,
    host,
    server,
    close() {
      return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections() })
    },
  }
}

function fail(res, e) {
  const headers = new Headers({ 'content-type': 'text/plain; charset=utf-8', [REASON_HEADER]: e.reason })
  applyForcedHeaders(headers)
  const body = `${e.message}\n`
  for (const [k, v] of Object.entries(e.headers ?? {})) headers.set(k, v)
  lingerAfter(res)
  res.writeHead(e.status, { ...Object.fromEntries(headers), 'content-length': Buffer.byteLength(body), connection: 'close' })
  res.end(body)
}

/**
 * The request body as a web stream that reads the socket only when the ingress asks for a chunk (a slow origin or a slow link to
 * the pod slows the client through TCP), sends `100 Continue` at the first ask when the client expected it, and does NOT destroy
 * the connection when it is cancelled: the answer may still be on its way out, so what is left of the upload is dealt with after
 * the response is written (`linger`).
 */
function bodyStream(req, res) {
  let started = false
  let cancelled = false
  return new ReadableStream({
    start(controller) {
      req.pause()
      req.on('data', (chunk) => {
        if (cancelled) return
        req.pause()
        try { controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)) } catch { /* the stream is gone */ }
      })
      req.on('end', () => { try { controller.close() } catch { /* cancelled */ } })
      req.on('error', (e) => { try { controller.error(e) } catch { /* cancelled */ } })
      req.on('close', () => { if (!req.complete) { try { controller.error(new Error('the client went away before the body ended')) } catch { /* cancelled */ } } })
    },
    pull() {
      if (!started) {
        started = true
        if (req[EXPECTING] && !res.headersSent) res.writeContinue()
      }
      if (!cancelled) req.resume()
    },
    cancel() { cancelled = true; req.pause() },
  }, { highWaterMark: 0 })
}

/**
 * An answer is about to be written while the client is still sending (or has not started). The answer says `Connection: close`
 * (the client must not send another request down this connection), but Node would drop the connection the moment the answer is
 * written, and a client still sending would be reset before it had read it. So the socket is only half-closed when the answer
 * is out (a FIN), and `linger` reads and throws away what the client still sends, for a bounded while, before it hangs up
 * (RFC 9112 section 9.6, a lingering close).
 */
function lingerAfter(res) {
  const req = res.req
  const socket = req?.socket
  if (!req || !socket || req.complete || socket.destroyed) return false
  socket[CLOSING] = true // no further request on this connection is served (see `onRequest`)
  socket.destroySoon = function destroySoon() { this.end() }
  res.once('finish', () => linger(req, socket))
  return true
}

/**
 * The answer is out on a connection whose client has not finished sending: read and throw away a bounded amount (1 MiB, 2 s), then
 * hang up. The connection ends as soon as the client has sent the end of its body (whatever else it sends is not read), and
 * never waits for a client that has gone quiet.
 */
function linger(req, socket) {
  let timer
  const hangUp = () => { clearTimeout(timer); socket.destroy() }
  if (req.complete || req.destroyed) return hangUp()
  let seen = 0
  timer = setTimeout(hangUp, LINGER_MS)
  timer.unref?.()
  req.removeAllListeners('data') // the body stream's own listener stops the flow after every chunk
  req.on('data', (chunk) => { seen += chunk.length; if (seen > LINGER_BYTES) hangUp() })
  req.on('end', hangUp)
  req.on('close', () => clearTimeout(timer))
  req.resume()
}

/** What `Allow` says when the listener itself refuses a method: what the ingress carries (the standard methods for one that does not say). */
const allowOf = (ingress) => (typeof ingress.allowHeader === 'function' ? ingress.allowHeader() : STANDARD_ALLOW.join(', '))

async function serve(ingress, req, res, trustProxy, allow) {
  // The Host header is checked as sent: a URL parser would read `a@b` as host b.
  const hostHeaders = []
  const raw = req.rawHeaders
  for (let i = 0; i < raw.length; i += 2) if (raw[i].toLowerCase() === 'host') hostHeaders.push(raw[i + 1])
  if (hostHeaders.length !== 1) return fail(res, new IngressError(400, 'bad-host', 'Exactly one Host header is required.'))
  let host
  try { host = checkHost(hostHeaders[0]) } catch (e) { return fail(res, e) }
  const target = req.url ?? ''
  // Origin-form only: an absolute-form target (`GET http://elsewhere/`) names a URL the client chose, and is refused.
  if (!target.startsWith('/') || target.startsWith('//')) return fail(res, new IngressError(400, 'bad-target', 'The request target must be a path.'))
  let url
  try { url = new URL(`http://${host}${target}`) } catch { return fail(res, new IngressError(400, 'bad-target', 'The request target is not valid.')) }
  if (url.host !== host.replace(/:80$/, '')) return fail(res, new IngressError(400, 'bad-target', 'The request target is not valid.'))

  const headers = new Headers()
  try {
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i].toLowerCase()
      if (name === 'host') continue
      headers.append(name, raw[i + 1])
    }
  } catch { return fail(res, new IngressError(400, 'bad-headers', 'A header is not valid.')) }

  const ac = new AbortController()
  res.on('close', () => { if (!res.writableFinished) ac.abort() })
  const method = req.method ?? 'GET'
  // CONNECT (its own event), TRACE and TRACK are never carried: a web Request cannot be built for them either.
  if (!isMethodToken(method)) return fail(res, new IngressError(405, 'method-not-allowed', `${method.slice(0, 40)} is not served here.`, { headers: { allow } }))
  // A body is whatever the framing says it is, for any method but GET and HEAD (which the ingress refuses a body on: `body-on-get`).
  const declaresBody = headers.has('content-length') ? headers.get('content-length').trim() !== '0' : headers.has('transfer-encoding')
  const hasBody = method !== 'GET' && method !== 'HEAD' && declaresBody
  let request
  try {
    request = new Request(url, { method, headers, signal: ac.signal, ...(hasBody ? { body: bodyStream(req, res), duplex: 'half' } : {}) })
  } catch { return fail(res, new IngressError(400, 'bad-request', 'The request is not valid.')) }
  // Request trailers are dropped: a web Request has none, and nothing downstream is told they existed.

  const clientAddress = clientAddressOf(req.socket.remoteAddress, headers.get('x-forwarded-for') ?? undefined, trustProxy)
  const response = await ingress.handle(request, { clientAddress })
  const out = {}
  for (const [name, value] of response.headers) if (name !== 'set-cookie') out[name] = value
  const cookies = response.headers.getSetCookie?.() ?? []
  if (cookies.length) out['set-cookie'] = cookies
  // An answer that comes while the client is still sending is delivered; what is left of the upload is read off, bounded, and the connection ends.
  if (declaresBody && lingerAfter(res)) out.connection = 'close' // (a GET that declared a body too: the ingress refused it, and it is not read for ever)
  res.writeHead(response.status, out)
  if (method === 'HEAD' || !response.body) return res.end()
  const reader = response.body.getReader()
  res.on('close', () => { reader.cancel().catch(() => {}) })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (res.destroyed) break
      if (!res.write(value)) {
        await new Promise((resolve) => {
          const done = () => { res.off('drain', done); res.off('close', done); resolve() }
          res.on('drain', done)
          res.on('close', done)
        })
      }
    }
    res.end()
  } catch {
    // The provider failed after the head went out: the only honest signal left is to drop the connection.
    res.destroy()
  }
}
