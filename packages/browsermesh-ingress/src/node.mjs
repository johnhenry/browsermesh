/**
 * node.mjs -- a Node HTTP/1.1 listener for a `createMeshIngress` handler. The only entry of this package that
 * imports `node:` modules.
 *
 * Plain HTTP only: terminate TLS in front (a reverse proxy or a platform). Binds to loopback unless `public: true`.
 */
import http from 'node:http'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { IngressError, REASON_HEADER } from './errors.mjs'
import { applyForcedHeaders, checkHost } from './headers.mjs'

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

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
 * @returns {Promise<{ port: number, host: string, close(): Promise<void>, server: http.Server }>}
 */
export async function listenNode(ingress, { port = 0, host = '127.0.0.1', public: isPublic = false, trustProxy = false, maxConnections = 256, maxHeaderBytes = 16 * 1024, headersTimeoutMs = 10_000, requestTimeoutMs = 60_000 } = {}) {
  if (!ingress || typeof ingress.handle !== 'function') throw new TypeError('listenNode: an ingress with handle() is required')
  if (!isLoopbackHost(host) && isPublic !== true) throw new Error(`listenNode: ${host} is not a loopback address; pass public: true once TLS is terminated in front of this listener`)
  const server = http.createServer({ maxHeaderSize: maxHeaderBytes, insecureHTTPParser: false, requestTimeout: requestTimeoutMs, headersTimeout: headersTimeoutMs, keepAliveTimeout: 5000, connectionsCheckingInterval: Math.min(5000, headersTimeoutMs) }, (req, res) => {
    serve(ingress, req, res, trustProxy).catch(() => { if (!res.headersSent) fail(res, new IngressError(500, 'internal-error', 'The ingress failed.')); else res.destroy() })
  })
  server.maxConnections = maxConnections
  server.on('clientError', (err, socket) => {
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
  res.writeHead(e.status, { ...Object.fromEntries(headers), 'content-length': Buffer.byteLength(body), connection: 'close' })
  res.end(body)
}

async function serve(ingress, req, res, trustProxy) {
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
  const hasBody = BODY_METHODS.has(method) && (headers.has('content-length') ? headers.get('content-length') !== '0' : headers.has('transfer-encoding'))
  let request
  try {
    request = new Request(url, { method, headers, signal: ac.signal, ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {}) })
  } catch { return fail(res, new IngressError(400, 'bad-request', 'The request is not valid.')) }

  const clientAddress = clientAddressOf(req.socket.remoteAddress, headers.get('x-forwarded-for') ?? undefined, trustProxy)
  const response = await ingress.handle(request, { clientAddress })
  const out = {}
  for (const [name, value] of response.headers) if (name !== 'set-cookie') out[name] = value
  const cookies = response.headers.getSetCookie?.() ?? []
  if (cookies.length) out['set-cookie'] = cookies
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
