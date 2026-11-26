/**
 * http-policy.mjs -- what the fetch form lets through: which URLs, which methods, which headers in each direction, and how a
 * redirect is read. Pure: web-standard globals only, no `node:` import.
 *
 * Both header lists are ALLOW-lists. A header that is not on one is not forwarded, whatever it is called: that is how a
 * cookie, a proxy header, a forwarding header, a hop-by-hop header or a header nobody thought of stays off the wire in both
 * directions, instead of a deny-list that has to name each of them.
 */
import { EgressError } from './errors.mjs'
import { checkHost } from './destination.mjs'

/** The longest URL a request may carry, in characters. */
export const MAX_URL_LENGTH = 8192
/** Methods an operator may allow for the fetch form. CONNECT and TRACE are never among them. */
export const KNOWN_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
export const DEFAULT_FETCH_METHODS = Object.freeze(['GET', 'HEAD'])
/** Headers a provider's own client sends, whatever the consumer said. */
export const FETCH_USER_AGENT = 'browsermesh-egress'
/** The header an operator may switch on to tell the destination which pod asked. */
export const CONSUMER_HEADER = 'x-browsermesh-consumer'

/** Request headers a consumer may send on: content, conditions, ranges and the credential it chose to put there. */
export const REQUEST_HEADERS = Object.freeze(['accept', 'accept-language', 'authorization', 'cache-control', 'content-length', 'content-type',
  'if-match', 'if-modified-since', 'if-none-match', 'if-range', 'if-unmodified-since', 'pragma', 'range'])
/**
 * Response headers passed to the consumer: what describes the body and its caching, what a registry or an ordinary API needs to
 * be used (the challenge to authenticate, the digest, the next page, the rate limit); never a cookie, a hop-by-hop or a proxy
 * header. A header that carries a URL the consumer may act on (`location`, `link`, the realm in `www-authenticate`) is the
 * provider's word about where to go next: the consumer's request to that URL still needs its own grant.
 */
export const RESPONSE_HEADERS = Object.freeze(['accept-ranges', 'age', 'cache-control', 'content-disposition', 'content-encoding', 'content-language',
  'content-length', 'content-range', 'content-type', 'date', 'etag', 'expires', 'last-modified', 'location', 'retry-after', 'vary',
  'www-authenticate', 'link', 'docker-distribution-api-version', 'docker-content-digest',
  'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'])
const REQUEST_ALLOWED = new Set(REQUEST_HEADERS)
const RESPONSE_ALLOWED = new Set(RESPONSE_HEADERS)

export const MAX_HEADERS = 100
export const REDIRECT_STATUSES = Object.freeze([301, 302, 303, 307, 308])
/** Statuses that carry no body. */
export const NO_BODY_STATUSES = Object.freeze([101, 204, 205, 304])

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/
const VALUE = /^[\t\x20-\x7e\x80-\xff]*$/

/** Is this a well-formed header name and value (no control characters, no line breaks)? */
export const isHeader = (name, value) => typeof name === 'string' && typeof value === 'string' && TOKEN.test(name) && value.length <= 8192 && VALUE.test(value)

/** The bytes a header block takes on the wire (name, value, `: ` and a line end each). */
export const headerBytes = (pairs) => pairs.reduce((n, [k, v]) => n + k.length + v.length + 4, 0)

/**
 * A request's headers as the wire carries them: a list of `[name, value]` strings. Malformed ones (a name that is not a token,
 * a control character in a value) refuse the whole request; the size is bounded here and by the provider's own limit.
 * @returns {Array<[string, string]>} lower-cased names
 */
export function checkHeaderPairs(list, { maxBytes, maxCount = MAX_HEADERS } = {}) {
  if (!Array.isArray(list) || list.length > maxCount) throw new EgressError('bad-request', 'The headers are not a short list of pairs.')
  const out = []
  for (const pair of list) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isHeader(pair[0], pair[1])) throw new EgressError('bad-request', 'A header is not a name and a value of plain characters.')
    out.push([pair[0].toLowerCase(), pair[1]])
  }
  if (maxBytes !== undefined && headerBytes(out) > maxBytes) throw new EgressError('bad-request', 'The headers are larger than the provider takes.')
  return out
}

/**
 * The headers of a request to send to the destination: only the allow-listed ones, each once (a repeated one is joined by a
 * comma, as HTTP defines for the lists on the allow-list), `content-length` only as plain digits. `authorization` goes only
 * to the origin the consumer sent it for (`keepAuthorization`).
 */
export function requestHeaders(pairs, { keepAuthorization = true } = {}) {
  const out = new Map()
  for (const [name, value] of pairs) {
    if (!REQUEST_ALLOWED.has(name)) continue
    if (name === 'authorization' && !keepAuthorization) continue
    if (name === 'content-length' && !/^\d{1,15}$/.test(value)) continue
    out.set(name, out.has(name) && name !== 'authorization' && name !== 'content-length' ? `${out.get(name)}, ${value}` : value)
  }
  return [...out]
}

/** A response's headers as the consumer gets them: allow-listed, bounded in count and size, well formed. */
export function responseHeaders(pairs, { maxBytes } = {}) {
  const out = []
  for (const [rawName, value] of pairs) {
    const name = String(rawName).toLowerCase()
    if (!RESPONSE_ALLOWED.has(name) || !isHeader(name, String(value))) continue
    out.push([name, String(value)])
    if (out.length >= MAX_HEADERS) break
  }
  if (maxBytes !== undefined && headerBytes(out) > maxBytes) throw new EgressError('bad-response')
  return out
}

/**
 * A URL as a destination: `http:` or `https:`, no credentials, a host that is a lowercase DNS name or a canonical IPv4 address
 * (the URL parser has already lower-cased it and written every spelling of an IPv4 address as four decimal numbers), an
 * explicit port (the scheme's default when none), and its path length. The fragment is dropped.
 * @param {string|URL} input
 * @param {string|URL} [base] for a redirect's Location
 * @throws {EgressError} `bad-url` (what it is), `bad-destination` (its host or port)
 */
export function parseTarget(input, base) {
  if (typeof input === 'string' && input.length > MAX_URL_LENGTH) throw new EgressError('bad-url', 'The URL is too long.')
  let url
  try { url = new URL(input, base) } catch { throw new EgressError('bad-url', 'The URL does not parse.') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new EgressError('bad-url', 'Only http: and https: URLs are served.')
  if (url.username || url.password) throw new EgressError('bad-url', 'A URL with credentials in it is not served.')
  url.hash = ''
  if (url.href.length > MAX_URL_LENGTH) throw new EgressError('bad-url', 'The URL is too long.')
  const secure = url.protocol === 'https:'
  const { host, kind } = checkHost(url.hostname)
  const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port)
  return { url, href: url.href, secure, host, kind, port, pathLength: url.pathname.length + url.search.length }
}

/** `scheme://host:port`: what a credential is bound to. */
export const originOf = (t) => `${t.secure ? 'https' : 'http'}://${t.host}:${t.port}`
