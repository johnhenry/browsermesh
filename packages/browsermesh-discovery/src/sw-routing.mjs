/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-sw-routing.js -- ServiceWorker mesh:// fetch routing.
 *
 * Intercepts mesh:// protocol requests and *.mesh.local hostnames
 * in the Service Worker fetch handler, delegating to mesh RPC.
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
      const resHeaders = result.headers ?? { 'content-type': 'application/json' }
      const resBody = typeof result.body === 'string' ? result.body : JSON.stringify(result.body)
      return new Response(resBody, { status, headers: resHeaders })
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      })
    }
  }
}
