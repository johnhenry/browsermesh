/**
 * serverless-proxy.mjs -- Phase 4 of the BrowserMesh Serverless plan
 * (`/Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md`):
 * a reverse-proxy-to-external-URL handler, modeled directly on
 * `actually-serverless`'s `createProxyHandler.mjs` (plain `fetch()` to the
 * target, SPA index.html fallback on 404).
 *
 * Deliberately NOT built on `browsermesh-netway`'s `GatewayBackend` -- that
 * class proxies raw TCP/UDP/DNS bytes through a wsh gateway daemon, an
 * entirely different (transport, not HTTP) layer. This handler needs real
 * ambient `fetch()`, exactly like `actually-serverless`'s own version did;
 * it runs at the responding peer's own top-level trust level (whatever JS
 * context attaches the site's `mesh-rpc` service), not inside any future
 * `Kernel`-sandboxed tenant execution context -- `Kernel#networkFor()`
 * exposes raw socket capability tags (`tcp:connect`, `loopback`, ...), not
 * an HTTP `fetch()` primitive, so this does not compose for free if
 * function execution later moves fully inside Kernel-gated tenants (a
 * Phase 7/8 concern, not this one).
 *
 * Always the LAST handler in a site's chain (`serverless-router.mjs`'s
 * static -> functions -> proxy precedence): unlike `createStaticHandler()`,
 * this handler never returns `null` -- it always attempts to proxy and
 * always returns a real response (success or a clean 502/504 on failure),
 * matching `actually-serverless`'s own catch-all proxy semantics.
 *
 * @module serverless-proxy
 */

/** Request headers unsafe/meaningless to forward to the proxy target as-is -- `fetch()` recomputes these itself. */
const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  'host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding',
  'upgrade', 'te', 'trailer', 'proxy-authenticate', 'proxy-authorization',
])

/**
 * Response headers unsafe to forward verbatim: `fetch()` already
 * transparently decompresses the body before `res.arrayBuffer()` reads it,
 * so forwarding a stale `content-encoding`/`content-length` would make a
 * downstream consumer try to re-decode/mis-size already-decoded bytes.
 * `set-cookie` is dropped too -- a Service-Worker-synthesized `Response`
 * doesn't set real cookies for a fetch(), so forwarding it is misleading
 * rather than unsafe, but there's no reason to carry it through either.
 */
const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'set-cookie',
])

/**
 * @param {object} headers
 * @param {Set<string>} drop - lowercased header names to omit.
 * @returns {object}
 */
function filterHeaders(headers, drop) {
  const out = {}
  for (const [k, v] of Object.entries(headers || {})) {
    if (!drop.has(k.toLowerCase())) out[k] = v
  }
  return out
}

/**
 * @param {Headers} headers
 * @returns {object}
 */
function responseHeadersToObject(headers) {
  const out = {}
  for (const [k, v] of headers.entries()) {
    if (!HOP_BY_HOP_RESPONSE_HEADERS.has(k.toLowerCase())) out[k] = v
  }
  return out
}

/**
 * @param {*} body
 * @param {string} method
 * @returns {string|Uint8Array|undefined}
 */
function bodyForFetch(body, method) {
  if (method === 'GET' || method === 'HEAD' || body === undefined || body === null) return undefined
  if (typeof body === 'string' || body instanceof Uint8Array) return body
  return JSON.stringify(body)
}

/**
 * @param {object} opts
 * @param {string} opts.targetOrigin - e.g. `'https://api.example.com'`. `path` is resolved against this via `new URL(path, targetOrigin)`.
 * @param {boolean} [opts.spaFallback=false] - on a 404 from the target, retry `/index.html` under `targetOrigin` and serve that instead (client-side-routed SPA convention, matching `actually-serverless`'s own proxy handler).
 * @returns {(req: {path: string, method?: string, headers?: object, body?: *}) => Promise<{status: number, headers: object, body: Uint8Array|string}>}
 *   Never returns `null` -- see module doc comment.
 */
export function createProxyHandler({ targetOrigin, spaFallback = false } = {}) {
  if (!targetOrigin || typeof targetOrigin !== 'string') {
    throw new Error('createProxyHandler: opts.targetOrigin is required and must be a string')
  }
  const origin = new URL(targetOrigin) // throws synchronously on an invalid URL -- fail at construction, not on first request

  return async function handleProxy({ path = '/', method = 'GET', headers = {}, body } = {}) {
    const target = new URL(path, origin)
    const init = { method, headers: filterHeaders(headers, HOP_BY_HOP_REQUEST_HEADERS) }
    const fetchBody = bodyForFetch(body, method)
    if (fetchBody !== undefined) init.body = fetchBody

    let res
    try {
      res = await fetch(target, init)
    } catch (err) {
      return { status: 502, headers: { 'content-type': 'text/plain' }, body: `Bad Gateway: ${err?.message || String(err)}` }
    }

    if (res.status === 404 && spaFallback) {
      const fallbackTarget = new URL('/index.html', origin)
      let fallbackRes
      try {
        fallbackRes = await fetch(fallbackTarget)
      } catch {
        fallbackRes = null
      }
      if (fallbackRes && fallbackRes.ok) {
        const bytes = new Uint8Array(await fallbackRes.arrayBuffer())
        return { status: 200, headers: { 'content-type': fallbackRes.headers.get('content-type') || 'text/html' }, body: bytes }
      }
    }

    const bytes = new Uint8Array(await res.arrayBuffer())
    return { status: res.status, headers: responseHeadersToObject(res.headers), body: bytes }
  }
}
