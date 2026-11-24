/**
 * headers.mjs -- every header rule of the ingress, in one place, as pure functions.
 *
 * Nothing here touches the network. Lists are plain arrays of `[name, value]` pairs (the wire form) or web
 * `Headers` objects (the HTTP side).
 */
import { IngressError } from './errors.mjs'

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
// eslint-disable-next-line no-control-regex
const BAD_VALUE = /[\u0000-\u0008\u000a-\u001f\u007f]/
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/
const IPV6_HOST_RE = /^\[[0-9a-f:.]{2,45}\](?::\d{1,5})?$/

/** Request headers a client may pass to the provider unless the operator widens the list. */
export const DEFAULT_FORWARD_REQUEST_HEADERS = Object.freeze([
  'accept', 'accept-language', 'content-type', 'if-match', 'if-modified-since', 'if-none-match', 'if-unmodified-since', 'range',
])

/** Request headers that are never taken from a client and never sent to a provider, whatever the operator allows. */
export const NEVER_FORWARD_REQUEST = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'content-length', 'expect', 'forwarded', 'x-real-ip', 'via', 'x-forwarded-for',
  'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-forwarded-server', 'x-original-url', 'x-rewrite-url',
])
const isNeverForward = (name) => NEVER_FORWARD_REQUEST.has(name) || name.startsWith('proxy-') || name.startsWith('x-forwarded-')

/** Response headers a provider may set. Everything else is dropped. */
export const DEFAULT_PASS_RESPONSE_HEADERS = Object.freeze([
  'content-type', 'content-length', 'content-language', 'content-disposition', 'content-range', 'accept-ranges',
  'etag', 'last-modified', 'location', 'vary', 'retry-after', 'allow',
])

export const DEFAULT_CSP = "default-src 'none'; sandbox"

/** Statuses that carry no body. */
export const NO_BODY_STATUS = new Set([204, 205, 304])

export const isToken = (s) => typeof s === 'string' && s.length > 0 && s.length <= 128 && TOKEN.test(s)
export const isValue = (s) => typeof s === 'string' && s.length <= 8192 && !BAD_VALUE.test(s)

const utf8 = new TextEncoder()
export const byteLength = (s) => utf8.encode(s).byteLength

/** Does this look like a pod id a mapping may name? (no scope syntax, no whitespace, bounded). */
export const isPodId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(s)

/**
 * The Host a client used, validated: a lower-case hostname (or bracketed IPv6) with an optional port; no userinfo,
 * path or whitespace.
 * @returns {string} normalised, or throws IngressError 400 `bad-host`
 */
export function checkHost(host) {
  const h = typeof host === 'string' ? host.trim().toLowerCase() : ''
  if (!h || h.length > 261 || !(HOST_RE.test(h) || IPV6_HOST_RE.test(h))) throw new IngressError(400, 'bad-host', 'The Host is not a plain hostname with an optional port.')
  return h
}

/** Only the hostname of a validated host (no port). */
export function hostName(host) {
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1)
  const i = host.lastIndexOf(':')
  return i === -1 ? host : host.slice(0, i)
}

/**
 * The target of a request (path and query) in origin form: starts with one `/`, no backslash, no control or
 * whitespace character, bounded. A peer or a client never supplies more than this.
 * @returns {string}
 */
export function checkTarget(target, maxLength = 2048) {
  if (typeof target !== 'string' || !target.startsWith('/') || target.startsWith('//')) throw new IngressError(400, 'bad-target', 'The request target must be a path.')
  if (target.length > maxLength) throw new IngressError(414, 'target-too-long', `The request target is longer than ${maxLength} characters.`)
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f\\]/.test(target)) throw new IngressError(400, 'bad-target', 'The request target contains a character that is not allowed.')
  return target
}

/** Path of a mapping (`resolve`'s `path`): origin form, no query, no dot segments. */
export function checkMappedPath(path) {
  try { checkTarget(path) } catch { throw new IngressError(500, 'bad-mapping', 'A mapping named an invalid path.') }
  if (path.includes('?') || path.includes('#') || path.split('/').some((s) => s === '.' || s === '..')) throw new IngressError(500, 'bad-mapping', 'A mapping named an invalid path.')
  return path
}

/**
 * Shape rules for a header list in either direction: counted, bounded, tokens for names, no control characters.
 * @param {Array<[string, string]>} list
 */
export function checkHeaderList(list, { maxCount, maxBytes, status = 400, reason = 'bad-headers' }) {
  if (!Array.isArray(list) || list.length > maxCount) throw new IngressError(status, reason, 'Too many headers.')
  let bytes = 0
  for (const pair of list) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isToken(pair[0]) || !isValue(pair[1])) throw new IngressError(status, reason, 'A header is malformed.')
    bytes += byteLength(pair[0]) + byteLength(pair[1]) + 4
    if (bytes > maxBytes) throw new IngressError(status, reason, 'The headers are too large.')
  }
  return list
}

/** @param {Headers} headers @returns {Array<[string,string]>} */
export function listOf(headers) {
  const out = []
  for (const [name, value] of headers) out.push([name, value])
  return out
}

/**
 * Client headers -> what the provider is sent. Only allow-listed names; never a name on the never-list; the
 * operator's own headers (`extra`, from `resolve`) are added last and may not be on the never-list either.
 * @param {Headers} headers
 * @param {{ forward?: string[], extra?: Record<string,string> }} opts
 * @returns {Array<[string,string]>}
 */
export function requestHeadersForProvider(headers, { forward = [], extra } = {}) {
  const allowed = new Set([...DEFAULT_FORWARD_REQUEST_HEADERS, ...forward.map((n) => String(n).toLowerCase())].filter((n) => !isNeverForward(n)))
  const out = []
  for (const [name, value] of headers) if (allowed.has(name) && isValue(value)) out.push([name, value])
  for (const [rawName, value] of Object.entries(extra ?? {})) {
    const name = String(rawName).toLowerCase()
    if (!isToken(name) || isNeverForward(name) || !isValue(String(value))) throw new IngressError(500, 'bad-mapping', 'A mapping named a header that may not be sent.')
    for (let i = out.length - 1; i >= 0; i--) if (out[i][0] === name) out.splice(i, 1)
    out.push([name, String(value)])
  }
  return out
}

/** Names the ingress will list in `Vary`: the request headers it forwards (they change what the provider answers). */
export function varyNames(forward = []) {
  return [...new Set([...DEFAULT_FORWARD_REQUEST_HEADERS, ...forward.map((n) => String(n).toLowerCase())].filter((n) => !isNeverForward(n) && !['content-type'].includes(n)))]
}

/**
 * A client's request, checked for the shapes request smuggling and header abuse use. Throws `IngressError`.
 * @param {Headers} headers
 * @param {string} method
 */
export function checkClientRequestShape(headers, method, { maxCount, maxBytes }) {
  let count = 0
  let bytes = 0
  for (const [name, value] of headers) {
    count += 1
    bytes += byteLength(name) + byteLength(value) + 4
    if (count > maxCount || bytes > maxBytes) throw new IngressError(431, 'headers-too-large', 'The request headers are too large.')
    if (!isValue(value)) throw new IngressError(400, 'bad-header-value', 'A request header has a character that is not allowed.')
  }
  const te = headers.get('transfer-encoding')
  const cl = headers.get('content-length')
  if (te !== null && cl !== null) throw new IngressError(400, 'bad-framing', 'Transfer-Encoding and Content-Length together are refused.')
  if (te !== null && !/^\s*chunked\s*$/i.test(te)) throw new IngressError(400, 'bad-framing', 'Only the chunked transfer coding is accepted.')
  if (cl !== null && (!/^\d{1,15}$/.test(cl.trim()))) throw new IngressError(400, 'bad-framing', 'Content-Length must be one number.')
  if ((method === 'GET' || method === 'HEAD') && ((cl !== null && Number(cl) > 0) || te !== null)) throw new IngressError(400, 'body-on-get', 'A GET or HEAD request may not carry a body.')
  return { contentLength: cl === null ? null : Number(cl.trim()), chunked: te !== null }
}

/** Is this a Location the ingress may pass on? Only an absolute path on the same origin; never another origin or scheme. */
export function safeLocation(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !/[\\\u0000-\u001f\u007f]/.test(value)
}

/**
 * A provider's response head -> the headers the HTTP client gets.
 * @param {Array<[string,string]>} list - already shape-checked
 * @param {{ response?: object, forward?: string[], expose?: string[] }} opts
 * @returns {Headers}
 */
export function responseHeadersForClient(list, { response = {}, forward = [], expose = [] } = {}) {
  const pass = new Set([...DEFAULT_PASS_RESPONSE_HEADERS, ...expose.map((n) => String(n).toLowerCase())])
  if (response.allowSetCookie === true) pass.add('set-cookie')
  const out = new Headers()
  const vary = new Set(varyNames(forward))
  for (const [name, value] of list) {
    const lower = name.toLowerCase()
    if (lower === 'content-encoding') {
      if (value.trim().toLowerCase() !== 'identity') throw new IngressError(502, 'bad-content-encoding', 'The provider sent a content coding the ingress did not negotiate.')
      continue
    }
    if (lower === 'location' && !safeLocation(value)) throw new IngressError(502, 'provider-redirect-refused', 'The provider redirected somewhere other than a path on this origin; redirects are never followed.')
    if (lower === 'vary') { for (const v of value.split(',')) if (v.trim()) vary.add(v.trim().toLowerCase()); continue }
    if (!pass.has(lower)) continue
    if (lower === 'set-cookie') out.append(name, value)
    else if (out.has(lower) && lower !== 'allow') continue // one value for a singleton
    else out.set(lower, value)
  }
  if (vary.has('*')) out.set('vary', '*')
  else if (vary.size) out.set('vary', [...vary].join(', '))
  applyForcedHeaders(out, response)
  return out
}

/** Headers every response the ingress sends carries, unless a mapping opted out. */
export function applyForcedHeaders(headers, response = {}) {
  const csp = response.contentSecurityPolicy
  if (csp === false) headers.delete('content-security-policy')
  else headers.set('content-security-policy', typeof csp === 'string' && csp ? csp : DEFAULT_CSP)
  headers.set('x-content-type-options', 'nosniff')
  const cache = response.cacheControl
  if (cache === false) headers.delete('cache-control')
  else headers.set('cache-control', typeof cache === 'string' && cache ? cache : 'no-store')
  return headers
}
