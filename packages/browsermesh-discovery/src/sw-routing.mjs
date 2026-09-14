/**
 * clawser-mesh-sw-routing.js -- ServiceWorker mesh:// fetch routing.
 *
 * Intercepts mesh:// protocol requests and *.mesh.local hostnames
 * in the Service Worker fetch handler, delegating to mesh RPC.
 *
 * STATUS: `parseMeshRequest()` is wired to a real transport as of
 * `browsermesh-apps`' `mesh-fetch.mjs` (Phase 2 of the
 * `browsermesh-fetch-websocket.md` plan), which uses it directly to power
 * `createBrowserMeshFetch()` -- a directly-callable `fetch(url, init)`-shaped
 * function bound to a live `mesh-rpc` service (`mesh-rpc.mjs`, Phase 1).
 * `MeshFetchRouter` in THIS file remained the separate Service-Worker
 * `fetch`-event-interceptor shape (`Request` in, `Response|null` out), not
 * itself used by `mesh-fetch.mjs` (its `Request`-in shape doesn't fit a
 * direct `browserMeshFetch(url, init)` call) -- it had no wired caller of
 * its own until `browsermesh-apps`' `serverless-fetch.mjs` (Phase 2 of
 * `/Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md`),
 * which resolves the `podId` token to a site name (falling back to a
 * literal podId) before delegating to a `mesh-rpc` request. That phase also
 * fixed `route()`'s Response-building below to pass a binary
 * (`Uint8Array`/`ArrayBuffer`) `result.body` straight to `new Response()`
 * instead of `JSON.stringify`-ing it -- a bug this file's lack of any real
 * caller had left latent.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-sw-routing.test.mjs
 */

const MESH_PROTOCOL = 'mesh://'
const MESH_LOCAL_SUFFIX = '.mesh.local'

/**
 * Parse a mesh URL into { podId, path } or null.
 * Supports:
 *   - mesh://podId/path
 *   - https://podId.mesh.local/path
 *   - http://podId.mesh.local/path
 *
 * @param {string} urlStr
 * @returns {{ podId: string, path: string } | null}
 */
export function parseMeshRequest(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null

  // --- mesh:// protocol ---
  if (urlStr.startsWith(MESH_PROTOCOL)) {
    const rest = urlStr.slice(MESH_PROTOCOL.length)
    if (!rest) return null

    const slashIdx = rest.indexOf('/')
    let podId, path
    if (slashIdx === -1) {
      podId = rest
      path = '/'
    } else {
      podId = rest.slice(0, slashIdx)
      path = rest.slice(slashIdx) || '/'
    }

    if (!podId) return null
    return { podId, path }
  }

  // --- https://podId.mesh.local/path  or  http://podId.mesh.local/path ---
  // Extract hostname from the raw string to preserve case (URL() lowercases hostnames).
  const httpMatch = urlStr.match(/^https?:\/\/([^/?#]+)(\/[^?#]*)?/)
  if (!httpMatch) return null

  const rawHost = httpMatch[1]  // preserves original case
  const lowerHost = rawHost.toLowerCase()
  if (!lowerHost.endsWith(MESH_LOCAL_SUFFIX)) return null

  const podId = rawHost.slice(0, -MESH_LOCAL_SUFFIX.length)
  if (!podId) return null

  const path = httpMatch[2] || '/'
  return { podId, path }
}

/**
 * Routes mesh:// and *.mesh.local fetch requests to a mesh RPC handler.
 */
export class MeshFetchRouter {
  #onRpc

  /**
   * @param {object} opts
   * @param {function({ podId: string, method: string, path: string, headers: object, body: * }): Promise<{ status?: number, headers?: object, body: * }>} opts.onRpc
   */
  constructor({ onRpc }) {
    if (typeof onRpc !== 'function') throw new Error('onRpc callback is required')
    this.#onRpc = onRpc
  }

  /**
   * Attempt to route a Request object. Returns Response if matched, null if not a mesh request.
   * @param {Request} request
   * @returns {Promise<Response|null>}
   */
  async route(request) {
    const parsed = parseMeshRequest(request.url)
    if (!parsed) return null

    const { podId, path } = parsed
    const method = request.method || 'GET'

    // Read body for non-GET methods
    let body = null
    if (method !== 'GET' && method !== 'HEAD') {
      try {
        body = await request.text()
        // Try parsing as JSON
        try { body = JSON.parse(body) } catch { /* keep as string */ }
      } catch { /* no body */ }
    }

    // Extract headers
    const headers = {}
    if (request.headers) {
      // Support both Map-like and plain objects
      if (typeof request.headers.forEach === 'function') {
        request.headers.forEach((v, k) => { headers[k] = v })
      } else if (typeof request.headers.entries === 'function') {
        for (const [k, v] of request.headers.entries()) headers[k] = v
      }
    }

    try {
      const result = await this.#onRpc({ podId, method, path, headers, body })
      const status = result.status ?? 200
      let resHeaders = result.headers
      let resBody
      if (result.body instanceof Uint8Array || result.body instanceof ArrayBuffer) {
        // Binary body (e.g. a static asset's raw bytes, from the
        // BrowserMesh Serverless plan's serverless-fetch.mjs) -- Response
        // accepts BufferSource directly; JSON.stringify-ing it here would
        // silently mangle it into `{"0":.., "1":..}` instead of real bytes.
        resBody = result.body
        resHeaders = resHeaders ?? {}
      } else if (typeof result.body === 'string') {
        resBody = result.body
        resHeaders = resHeaders ?? { 'content-type': 'application/json' }
      } else {
        resBody = JSON.stringify(result.body)
        resHeaders = resHeaders ?? { 'content-type': 'application/json' }
      }
      return new Response(resBody, { status, headers: resHeaders })
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      })
    }
  }
}
