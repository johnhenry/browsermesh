/**
 * mesh-fetch.mjs -- Phase 2 of the BrowserMeshFetch/BrowserMeshWebSocket plan
 * (`browsermesh-fetch-websocket.md`): `browserMeshFetch(url, init)`, a
 * standard-`fetch()`-shaped way to reach a mesh-addressable pod directly
 * from application code, using Phase 1's `mesh-rpc.mjs` `request()` as the
 * actual transport underneath.
 *
 * ---------------------------------------------------------------------------
 * API SHAPE DECISION -- factory function, not a class, not a bare function.
 *
 * The user's original sketch (`new BrowserMeshFetch(credentials)`) and the
 * plan's own wording both leave the exact shape open ("decide during
 * implementation which fits better"). Three options were on the table:
 *
 *   1. A bare function that takes a bound RPC client as a 3rd argument on
 *      every call (`browserMeshFetch(url, init, meshRpcApi)`) -- rejected:
 *      it makes every call site thread the client through, unlike real
 *      `fetch()`, and doesn't match "a live mesh-rpc service's `api.request()`"
 *      being a long-lived binding, not a per-call parameter.
 *   2. A class (`new BrowserMeshFetch(meshRpcApi)`, called as
 *      `instance.fetch(url, init)` or `instance(url, init)`) -- rejected:
 *      a class instance is not directly callable as `instance(url, init)`
 *      without `Function.prototype.bind`/`Proxy` tricks, so it can't match
 *      "the standard `fetch(url, init)` calling convention as closely as
 *      reasonably possible" as well as a plain function can. Calling it
 *      `instance.fetch(url, init)` is workable but reads as its own bespoke
 *      method, not really "shaped like `fetch()`".
 *   3. `createBrowserMeshFetch(meshRpcApi) -> (url, init) => Promise<Response>`
 *      -- CHOSEN. The factory binds once to a live `mesh-rpc` service's
 *      `api` (the object `attachService(peerNode, network,
 *      createMeshRpcService(...))` returns as `.api`, i.e. `{ request }`),
 *      and returns a plain function whose call signature is *exactly*
 *      `fetch(url, init)` -- so existing code that expects "a fetch-shaped
 *      function" (e.g. passing it as a `fetch` option to some other library)
 *      can use it as a drop-in without any adapter. This also matches this
 *      package's own established convention of factories over classes for
 *      things that bind to a live service (`createMeshRpcService()` itself,
 *      `createMeshNode()`, etc.) -- `mesh-rpc.mjs`/`mesh-service.mjs` never
 *      introduce a class for a "callable bound to a live connection" shape.
 *
 * Usage:
 *   const { api } = attachService(peerNode, network, createMeshRpcService({ onRequest }))
 *   const browserMeshFetch = createBrowserMeshFetch(api)
 *   const res = await browserMeshFetch('mesh://somePod/api/v1', { method: 'POST', body: { x: 1 } })
 *   const data = await res.json()
 *
 * ---------------------------------------------------------------------------
 * URL PARSING -- reuses `parseMeshRequest()` from
 * `@johnhenry/browsermesh-discovery`'s `sw-routing.mjs` as-is (not
 * reimplemented). `MeshFetchRouter` itself is NOT reused as the transport
 * here: its `route()` method is shaped `Request -> Promise<Response|null>`,
 * a Service-Worker-`fetch`-event-interceptor shape (return `null` for "not
 * mine", a `Request` object as input) that doesn't fit a directly-callable
 * `browserMeshFetch(url, init)` API -- callers here have a URL string and an
 * options bag, not an already-constructed `Request`, and a non-mesh URL
 * should throw (see below), not resolve `null`. Its body/header
 * normalization and response-shaping conventions ARE mirrored below (see
 * `extractBody()`/`buildResponse()`), since those parts fit regardless of
 * the input/output shape wrapped around them.
 *
 * ---------------------------------------------------------------------------
 * ERROR-VS-REJECT SEMANTICS -- deliberately follows real `fetch()`, not
 * `MeshFetchRouter.route()`'s own convention (which turns an `onRpc` error
 * into a resolved `502 Response` -- appropriate for a Service Worker
 * interceptor, which must always produce SOME `Response` for the page it's
 * intercepting on behalf of, but wrong for a directly-callable `fetch()`
 * clone):
 *
 *   - `parseMeshRequest(url)` returning `null` (not a `mesh://`/`*.mesh.local`
 *     URL) throws a `TypeError` SYNCHRONOUSLY, before any `Promise` is even
 *     created -- matching real `fetch()`'s own behavior for a malformed URL
 *     (`new Request(url)` throws synchronously inside `fetch()`'s body,
 *     which is not declared `async`, so the exception propagates immediately
 *     rather than becoming a rejected promise). This is why
 *     `browserMeshFetch` below is written as a plain (non-`async`) function
 *     that validates the URL up front and only THEN delegates to an inner
 *     `async` helper for the actual RPC round trip -- an `async function`
 *     can never throw synchronously (any throw inside one is always wrapped
 *     into a rejected `Promise`), so getting a genuine synchronous throw
 *     requires the outer function not be `async`.
 *   - A failure from Phase 1's `request()` (timeout, or `ctx.sendTo()`
 *     failing because the peer is unreachable) REJECTS the returned promise
 *     with that same error, unmodified -- it does NOT resolve with a
 *     5xx-shaped `Response`. This matches web-standard `fetch()`: it only
 *     ever resolves with an error-status `Response` for an HTTP-level error
 *     from a server that actually responded (which here means the
 *     responding pod's `onRequest` ran and returned/threw -- `mesh-rpc.mjs`
 *     already turns THAT case into a `500`-shaped response that arrives as a
 *     normal, resolved RPC response, so it correctly becomes a resolved
 *     `Response` here too); it rejects for network-level failures where no
 *     server ever answered, which is exactly what a `mesh-rpc` timeout or
 *     send failure represents.
 *
 * No browser-only imports at module level.
 */

import { parseMeshRequest } from '@johnhenry/browsermesh-discovery'

/**
 * @typedef {object} MeshRpcApi
 * @property {(podId: string, req: {method?: string, path?: string, headers?: object, body?: *}) => Promise<{status: number, headers: object, body: *}>} request
 *   The `api.request()` method `attachService()` returns for a
 *   `createMeshRpcService()` descriptor (Phase 1, `mesh-rpc.mjs`).
 */

/**
 * Bind a `browserMeshFetch(url, init)` function to a live `mesh-rpc`
 * service's `api`. See this file's module doc comment for the full
 * "API SHAPE DECISION" writeup on why this is a factory rather than a class
 * or a bare function.
 *
 * @param {MeshRpcApi} meshRpcApi - The `.api` returned by
 *   `attachService(peerNode, network, createMeshRpcService(...))`.
 * @returns {(url: string, init?: {method?: string, headers?: object|Headers|[string,string][], body?: *}) => Promise<Response>}
 */
export function createBrowserMeshFetch(meshRpcApi) {
  if (!meshRpcApi || typeof meshRpcApi.request !== 'function') {
    throw new Error(
      'createBrowserMeshFetch: a mesh-rpc api with a request(podId, {...}) method is required ' +
      '(pass the .api returned by attachService(peerNode, network, createMeshRpcService(...)))',
    )
  }

  /**
   * `browserMeshFetch()` itself -- deliberately NOT an `async function` (see
   * the module doc comment's "ERROR-VS-REJECT SEMANTICS" section for why: a
   * malformed URL must throw synchronously, matching real `fetch()`, which
   * an `async function` body can never do).
   *
   * @param {string} url
   * @param {{method?: string, headers?: object|Headers|[string,string][], body?: *}} [init]
   * @returns {Promise<Response>}
   */
  return function browserMeshFetch(url, init = {}) {
    const urlStr = typeof url === 'string' ? url : String(url)
    const parsed = parseMeshRequest(urlStr)
    if (!parsed) {
      throw new TypeError(
        `browserMeshFetch: '${urlStr}' is not a valid mesh:// or *.mesh.local URL`,
      )
    }
    return performMeshFetch(meshRpcApi, parsed, init || {})
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * The actual async RPC round trip, once the URL is known to be valid. Any
 * rejection from `meshRpcApi.request()` (timeout, unreachable peer) is
 * intentionally left to propagate unmodified -- see module doc comment.
 *
 * @param {MeshRpcApi} meshRpcApi
 * @param {{podId: string, path: string}} parsed
 * @param {{method?: string, headers?: object|Headers|[string,string][], body?: *}} init
 * @returns {Promise<Response>}
 */
async function performMeshFetch(meshRpcApi, { podId, path }, init) {
  const method = (init.method || 'GET').toUpperCase()
  const headers = normalizeHeaders(init.headers)
  const body = extractBody(init.body, method)

  const result = await meshRpcApi.request(podId, { method, path, headers, body })
  return buildResponse(result)
}

/**
 * Normalize `init.headers` (a `Headers` instance, a plain object, or an
 * array of `[key, value]` pairs -- the three shapes real `fetch()` accepts)
 * into a plain `{lowercaseKey: value}` object, the shape `mesh-rpc.mjs`'s
 * wire envelope expects. Mirrors `MeshFetchRouter.route()`'s own
 * `Headers`-or-plain-object handling.
 *
 * @param {object|Headers|[string,string][]|undefined} headersInit
 * @returns {object}
 */
function normalizeHeaders(headersInit) {
  const headers = {}
  if (!headersInit) return headers

  if (typeof headersInit.forEach === 'function') {
    // Real `Headers` instance (or anything Headers-shaped).
    headersInit.forEach((v, k) => { headers[k.toLowerCase()] = v })
  } else if (Array.isArray(headersInit)) {
    for (const [k, v] of headersInit) headers[String(k).toLowerCase()] = v
  } else if (typeof headersInit === 'object') {
    for (const [k, v] of Object.entries(headersInit)) headers[k.toLowerCase()] = v
  }
  return headers
}

/**
 * Extract/normalize `init.body` the way `MeshFetchRouter.route()` extracts a
 * body from a real `Request` (read as text, then try `JSON.parse` so a
 * JSON-string body arrives at the responder's `onRequest` handler already
 * parsed into a structured value) -- except here the body starts out as
 * whatever `init.body` already is, not raw `Request` bytes, so a
 * non-string body (already a plain object/array/etc, the common case for
 * application code calling `browserMeshFetch(url, { body: {...} })`) is
 * passed through unchanged.
 *
 * GET/HEAD requests never carry a body, matching real `fetch()` (which
 * throws if you pass a `body` with `method: 'GET'`) -- here it's simply
 * dropped rather than throwing, since a mesh-RPC request's `body` field is
 * optional/advisory rather than spec-enforced.
 *
 * @param {*} rawBody
 * @param {string} method
 * @returns {*}
 */
function extractBody(rawBody, method) {
  if (rawBody === undefined || rawBody === null) return undefined
  if (method === 'GET' || method === 'HEAD') return undefined

  if (typeof rawBody === 'string') {
    try {
      return JSON.parse(rawBody)
    } catch {
      return rawBody // keep as plain string, matching MeshFetchRouter.route()
    }
  }
  return rawBody
}

/**
 * Shape a `mesh-rpc` response (`{status, headers, body}`) into a real
 * `Response`, mirroring `MeshFetchRouter.route()`'s own conventions:
 * default status `200`, default `content-type: application/json` when no
 * headers were supplied, and JSON-stringify a non-string body.
 *
 * @param {{status?: number, headers?: object, body?: *}} result
 * @returns {Response}
 */
function buildResponse(result) {
  const status = typeof result?.status === 'number' ? result.status : 200
  const headers = result?.headers && typeof result.headers === 'object' && Object.keys(result.headers).length > 0
    ? result.headers
    : { 'content-type': 'application/json' }
  const body = result && 'body' in result ? result.body : undefined
  const resBody = body === undefined
    ? null
    : typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(resBody, { status, headers })
}
