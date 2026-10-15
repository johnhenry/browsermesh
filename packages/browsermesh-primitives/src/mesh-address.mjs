// Shared browser-safe mesh address parsing. Pod IDs are case sensitive.
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

    const fragment = rest.indexOf('#')
    const address = fragment < 0 ? rest : rest.slice(0, fragment)
    const slashIdx = address.search(/[/?]/)
    let podId, path
    if (slashIdx === -1) {
      podId = address
      path = '/'
    } else {
      podId = address.slice(0, slashIdx)
      path = address.slice(slashIdx) || '/'
      if (path.startsWith('?')) path = '/' + path
    }

    if (!podId) return null
    return { podId, path }
  }

  // --- https://podId.mesh.local/path  or  http://podId.mesh.local/path ---
  // Extract hostname from the raw string to preserve case (URL() lowercases hostnames).
  const httpMatch = urlStr.match(/^https?:\/\/([^/?#]+)([^#]*)/)
  if (!httpMatch) return null

  const rawHost = httpMatch[1]  // preserves original case
  const lowerHost = rawHost.toLowerCase()
  if (!lowerHost.endsWith(MESH_LOCAL_SUFFIX)) return null

  const podId = rawHost.slice(0, -MESH_LOCAL_SUFFIX.length)
  if (!podId) return null

  const suffix = httpMatch[2] || '/'
  const path = suffix.startsWith('?') ? '/' + suffix : suffix
  return { podId, path }
}

