/**
 * request-target.mjs -- shared rules for proxying a request on behalf of a
 * remote peer to a locally configured origin.
 *
 * Everything a peer supplies (path, method, headers, body) is untrusted. The
 * target of the upstream request is built from parsed parts: the configured
 * origin is the base, and the peer contributes a path and query only. After
 * resolution the origin of the result must equal the configured origin
 * exactly, or the request is refused before anything is sent.
 *
 * No browser-only imports at module level.
 */

/** Defaults for the limits applied to proxied requests. All can be overridden per `ServerSharing`. */
export const PROXY_LIMITS_DEFAULTS = Object.freeze({
  maxPathLength: 2048,
  maxRequestBodyBytes: 1024 * 1024,
  maxResponseBytes: 8 * 1024 * 1024,
  maxHeaderCount: 32,
  maxHeaderBytes: 8 * 1024,
  requestTimeoutMs: 30_000,
})

/** Methods a peer may use unless the sharer narrows the list. */
export const DEFAULT_ALLOWED_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/** Request headers a peer may set unless the sharer widens the list. */
export const DEFAULT_ALLOWED_REQUEST_HEADERS = Object.freeze([
  'accept',
  'accept-language',
  'cache-control',
  'content-type',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'range',
])

/** Request headers that are never taken from a peer, whatever the allow-list says. */
const NEVER_FROM_PEER = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'expect',
  'cookie', 'authorization', 'forwarded',
])

/** Response headers that are not passed back to the peer. */
const DROP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-encoding', 'content-length', 'set-cookie', 'set-cookie2',
])

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
// eslint-disable-next-line no-control-regex
const BAD_HEADER_VALUE = /[\u0000-\u0008\u000a-\u001f\u007f]/
// eslint-disable-next-line no-control-regex
const BAD_PATH_CHARS = /[\u0000- \u007f-\u009f\\]/

const encoder = new TextEncoder()

/** @param {string} s @returns {number} UTF-8 byte length */
function byteLength(s) {
  return encoder.encode(s).byteLength
}

/**
 * Normalise the configured parts of a share into an origin string, throwing
 * if they do not form a plain `scheme://host:port`.
 *
 * @param {string} protocol
 * @param {string} hostname
 * @param {number} port
 * @returns {string} the URL origin
 */
export function configuredOrigin(protocol, hostname, port) {
  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error('protocol must be http or https')
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('port must be an integer from 1 to 65535')
  }
  if (typeof hostname !== 'string' || hostname === '' || /[\s/\\@?#[\]]/.test(hostname.replace(/^\[.*\]$/, 'ipv6'))) {
    throw new Error('hostname must be a plain host name or address')
  }
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname
  let url
  try {
    url = new URL(`${protocol}://${host}:${port}`)
  } catch {
    throw new Error('hostname must be a plain host name or address')
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.hostname) {
    throw new Error('hostname must be a plain host name or address')
  }
  return url.origin
}

/**
 * Build the target URL of a proxied request from a path a peer supplied.
 *
 * Accepted: a string that begins with a single `/` and contains no scheme,
 * authority, backslash, whitespace, control character or fragment. After
 * resolution against `origin` the result must have exactly that origin.
 *
 * @param {string} origin - an origin as returned by `configuredOrigin()`
 * @param {*} rawPath - undefined, null or '' mean '/'
 * @param {{ maxPathLength?: number }} [opts]
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
export function resolveTarget(origin, rawPath, { maxPathLength = PROXY_LIMITS_DEFAULTS.maxPathLength } = {}) {
  const path = rawPath === undefined || rawPath === null || rawPath === '' ? '/' : rawPath
  if (typeof path !== 'string') return { ok: false, reason: 'path must be a string' }
  if (path.length > maxPathLength) return { ok: false, reason: 'path too long' }
  if (BAD_PATH_CHARS.test(path)) return { ok: false, reason: 'path contains a forbidden character' }
  if (path[0] !== '/') return { ok: false, reason: 'path must begin with /' }
  if (path[1] === '/') return { ok: false, reason: 'path must not begin with //' }
  if (path.includes('#')) return { ok: false, reason: 'path must not contain a fragment' }
  let url
  try {
    url = new URL(path, origin)
  } catch {
    return { ok: false, reason: 'path is not a valid request target' }
  }
  if (url.origin !== origin || url.username || url.password) {
    return { ok: false, reason: 'target is not on the configured origin' }
  }
  return { ok: true, url }
}

/**
 * Validate a header map's shape: string names that are HTTP tokens, string
 * values without line breaks or control characters, bounded count and size.
 *
 * @param {*} headers
 * @param {{ maxHeaderCount: number, maxHeaderBytes: number }} limits
 * @returns {{ ok: true, entries: Array<[string, string]> } | { ok: false, reason: string }}
 */
export function checkHeaderShape(headers, { maxHeaderCount, maxHeaderBytes }) {
  if (headers === undefined || headers === null) return { ok: true, entries: [] }
  if (typeof headers !== 'object' || Array.isArray(headers)) return { ok: false, reason: 'headers must be an object' }
  const entries = Object.entries(headers)
  if (entries.length > maxHeaderCount) return { ok: false, reason: 'too many headers' }
  let size = 0
  for (const [name, value] of entries) {
    if (!TOKEN.test(name)) return { ok: false, reason: 'invalid header name' }
    if (typeof value !== 'string' || BAD_HEADER_VALUE.test(value)) return { ok: false, reason: 'invalid header value' }
    size += byteLength(name) + byteLength(value)
    if (size > maxHeaderBytes) return { ok: false, reason: 'headers too large' }
  }
  return { ok: true, entries }
}

/**
 * Select the request headers to forward: only allow-listed names, never a
 * name in the never-from-peer set; then the headers the sharer configured
 * are applied on top and cannot be overridden by the peer.
 *
 * @param {Array<[string, string]>} entries - already shape-checked
 * @param {Set<string>} allowed - lower-case names
 * @param {Record<string, string>} configured - headers set by the sharer
 * @returns {Record<string, string>}
 */
export function selectRequestHeaders(entries, allowed, configured = {}) {
  const out = {}
  for (const [name, value] of entries) {
    const lower = name.toLowerCase()
    if (NEVER_FROM_PEER.has(lower) || lower.startsWith('x-forwarded-') || lower.startsWith('proxy-')) continue
    if (!allowed.has(lower)) continue
    out[lower] = value
  }
  for (const [name, value] of Object.entries(configured)) out[name.toLowerCase()] = value
  return out
}

/**
 * Check and normalise a request body. Accepts a string or a Uint8Array no
 * larger than `maxBytes`.
 *
 * @param {*} body
 * @param {number} maxBytes
 * @returns {{ ok: true, body: string|Uint8Array|undefined } | { ok: false, status: number, reason: string }}
 */
export function checkRequestBody(body, maxBytes) {
  if (body === undefined || body === null) return { ok: true, body: undefined }
  if (typeof body === 'string') {
    // Every UTF-16 code unit takes at least one UTF-8 byte, so a string
    // longer than the limit is too large without encoding it.
    if (body.length > maxBytes || byteLength(body) > maxBytes) {
      return { ok: false, status: 413, reason: 'request body too large' }
    }
    return { ok: true, body }
  }
  if (body instanceof Uint8Array) {
    if (body.byteLength > maxBytes) return { ok: false, status: 413, reason: 'request body too large' }
    return { ok: true, body }
  }
  return { ok: false, status: 400, reason: 'request body must be a string or bytes' }
}

/**
 * Copy response headers for the peer, leaving out hop-by-hop headers,
 * cookies and encodings that no longer describe the body.
 *
 * @param {*} headers - a Headers, Map or anything with forEach
 * @returns {Record<string, string>}
 */
export function copyResponseHeaders(headers) {
  const out = {}
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      const lower = String(key).toLowerCase()
      if (DROP_RESPONSE_HEADERS.has(lower) || lower.startsWith('proxy-')) return
      out[key] = value
    })
  }
  return out
}

/**
 * Read a response body as text, never holding more than `maxBytes`.
 * A body that exceeds the bound is cancelled and reported, never truncated.
 *
 * @param {*} response
 * @param {number} maxBytes
 * @returns {Promise<{ ok: true, body: * } | { ok: false }>}
 */
export async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await response.body?.cancel?.() } catch { /* already closed */ }
    return { ok: false }
  }
  const stream = response.body
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let total = 0
    let text = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        try { await reader.cancel() } catch { /* already closed */ }
        return { ok: false }
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    return { ok: true, body: text }
  }
  if (typeof response.text === 'function') {
    const text = await response.text()
    if (typeof text === 'string' && byteLength(text) > maxBytes) return { ok: false }
    return { ok: true, body: text }
  }
  const body = response.body
  if (typeof body === 'string' && byteLength(body) > maxBytes) return { ok: false }
  return { ok: true, body }
}

/**
 * Whether a response came from somewhere other than `origin` (a fetch that
 * followed a redirect, for example).
 *
 * @param {*} response
 * @param {string} origin
 * @returns {boolean}
 */
export function responseLeftOrigin(response, origin) {
  if (response.redirected === true) return true
  if (typeof response.url === 'string' && response.url !== '') {
    try {
      return new URL(response.url).origin !== origin
    } catch {
      return true
    }
  }
  return false
}
