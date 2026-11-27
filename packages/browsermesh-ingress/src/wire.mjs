/**
 * wire.mjs -- protocol `http` v1: names, head validation, and the bytes a signature covers.
 * No framing of its own: heads are the params and result of one channel request, bodies are protocol streams.
 */
import { IngressError } from './errors.mjs'
import { checkHeaderList, checkHost, checkTarget, isToken } from './headers.mjs'

export const HTTP_PROTOCOL = 'http'
/**
 * Version 1 carries the seven standard methods and a request body the provider reads whole (bounded). Version 2 carries any
 * method token and a request body streamed end to end, and adds the `capabilities` request (what the provider accepts). An
 * ingress offers `[2, 1]`; a provider that speaks only 1 is answered 1 and is never sent anything version 2 adds.
 */
export const HTTP_VERSIONS = Object.freeze([1, 2])
export const STREAMING_VERSION = 2
export const FETCH_METHOD = 'fetch'
export const CAPABILITIES_METHOD = 'capabilities'
export const KIND_REQUEST = 'request'
export const KIND_RESPONSE = 'response'

/** Methods version 1 builds a Request for. */
export const WIRE_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
/** Methods that are never carried: a web `Request` cannot be built for them, and a proxy has no business tunnelling or echoing. */
export const FORBIDDEN_METHODS = new Set(['CONNECT', 'TRACE', 'TRACK'])
const MAX_METHOD_LENGTH = 32

/** Is `m` an RFC 9110 method token (a `token`, at most 32 characters) that this package may carry? */
export const isMethodToken = (m) => typeof m === 'string' && m.length <= MAX_METHOD_LENGTH && isToken(m) && !FORBIDDEN_METHODS.has(m.toUpperCase())
/** The standard methods are upper case on the wire; an extension token is carried as it was sent (methods are case-sensitive). */
export const normalizeMethod = (m) => (WIRE_METHODS.has(String(m).toUpperCase()) ? String(m).toUpperCase() : String(m))

/** The methods a policy names: `'*'` (every token) or a list of tokens; anything else is a TypeError. @returns {{ all: boolean, list: string[] }} */
export function parseMethodPolicy(methods, who) {
  if (methods === '*') return { all: true, list: [] }
  if (!Array.isArray(methods) || !methods.length) throw new TypeError(`${who}: methods must be '*' or a non-empty list of method names`)
  const list = []
  for (const raw of methods) {
    const m = normalizeMethod(raw)
    if (!isMethodToken(m)) throw new TypeError(`${who}: method ${JSON.stringify(String(raw))} is never served (CONNECT, TRACE and TRACK are refused; a method is an RFC 9110 token)`)
    if (!list.includes(m)) list.push(m)
  }
  return { all: false, list }
}

/** The methods that are always reported in `Allow` when a policy is `'*'`. */
export const STANDARD_ALLOW = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])

/** What a pod accepts, as it says so over the wire (`capabilities`): methods and body cap per service, and its upload cap. */
export function validateCapabilities(result) {
  const bad = () => new IngressError(502, 'provider-failed', 'The provider failed to answer.')
  const policy = (p) => {
    if (!p || typeof p !== 'object') throw bad()
    const methods = p.methods === '*' ? '*' : p.methods
    if (methods !== '*' && (!Array.isArray(methods) || methods.length > 64 || !methods.every(isMethodToken))) throw bad()
    if (p.maxBodyBytes !== null && !(Number.isSafeInteger(p.maxBodyBytes) && p.maxBodyBytes >= 0)) throw bad()
    return { methods, maxBodyBytes: p.maxBodyBytes === null ? Infinity : p.maxBodyBytes }
  }
  if (!result || typeof result !== 'object') throw bad()
  const out = { default: result.default === null || result.default === undefined ? null : policy(result.default), services: new Map(), maxUploads: Infinity }
  if (result.services !== undefined) {
    if (!result.services || typeof result.services !== 'object' || Array.isArray(result.services)) throw bad()
    const entries = Object.entries(result.services)
    if (entries.length > 32) throw bad()
    for (const [name, p] of entries) { if (!SERVICE_NAME_RE.test(name)) throw bad(); out.services.set(name, policy(p)) }
  }
  if (result.maxUploads !== undefined) { if (!Number.isSafeInteger(result.maxUploads) || result.maxUploads < 1) throw bad(); out.maxUploads = result.maxUploads }
  return out
}

/** @param {object} head the params of `fetch` @returns {object} validated, or throws IngressError 400 */
export function validateRequestHead(head, { maxHeaderCount, maxHeaderBytes, maxTargetLength }, { version = 1 } = {}) {
  if (!head || typeof head !== 'object') throw new IngressError(400, 'bad-request-head', 'The request head is not an object.')
  const { rid, method, target, host, headers, body } = head
  if (!Number.isSafeInteger(rid) || rid <= 0) throw new IngressError(400, 'bad-request-head', 'The request id is not a positive integer.')
  if (typeof method !== 'string' || !(version >= STREAMING_VERSION ? isMethodToken(method) : WIRE_METHODS.has(method))) throw new IngressError(405, 'method-not-allowed', 'The method is not served.')
  if (head.length !== undefined && (version < STREAMING_VERSION || !Number.isSafeInteger(head.length) || head.length < 0)) throw new IngressError(400, 'bad-request-head', 'The body length is not a whole number.')
  checkTarget(target, maxTargetLength)
  checkHost(host)
  checkHeaderList(headers, { maxCount: maxHeaderCount, maxBytes: maxHeaderBytes, reason: 'bad-request-head' })
  for (const [name] of headers) {
    const n = name.toLowerCase()
    if (['host', 'connection', 'upgrade', 'transfer-encoding', 'content-length', 'te', 'trailer', 'expect', 'forwarded', 'proxy-authorization'].includes(n)) {
      throw new IngressError(400, 'bad-request-head', 'A header that frames the request was sent in the head.')
    }
  }
  if (typeof body !== 'boolean') throw new IngressError(400, 'bad-request-head', 'The body flag is not a boolean.')
  if (head.client !== undefined && (typeof head.client !== 'string' || head.client.length > 64)) throw new IngressError(400, 'bad-request-head', 'The client field is not a short string.')
  if (typeof head.nonce !== 'string' || !/^[0-9a-f]{16,64}$/.test(head.nonce)) throw new IngressError(400, 'bad-request-head', 'The nonce is not 16 to 64 hex characters.')
  if (head.sig !== undefined && (typeof head.sig !== 'string' || head.sig.length > 2048)) throw new IngressError(400, 'bad-request-head', 'The signature is not a short string.')
  if (head.service !== undefined && (typeof head.service !== 'string' || !SERVICE_NAME_RE.test(head.service))) throw new IngressError(400, 'bad-request-head', 'The service is not a short plain name.')
  return head
}

/** A service a pod serves under a name: short, lowercase, plain. */
export const SERVICE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
/** The channel request a provider that serves named services answers: `services {} -> { services: string[], default: boolean }`. */
export const SERVICES_METHOD = 'services'

/** @param {object} head the result of `fetch`, from a pod this side does not control */
export function validateResponseHead(head, { maxHeaderCount, maxHeaderBytes }) {
  if (!head || typeof head !== 'object') throw new IngressError(502, 'bad-response-head', 'The provider answered with something that is not a response head.')
  const { status, headers, body } = head
  if (!Number.isInteger(status) || status < 200 || status > 599) throw new IngressError(502, 'bad-response-status', 'The provider sent a status outside 200-599.')
  checkHeaderList(headers, { maxCount: maxHeaderCount, maxBytes: maxHeaderBytes, status: 502, reason: 'bad-response-head' })
  if (typeof body !== 'boolean') throw new IngressError(502, 'bad-response-head', 'The body flag is not a boolean.')
  if (head.sig !== undefined && (typeof head.sig !== 'string' || head.sig.length > 2048)) throw new IngressError(502, 'bad-response-head', 'The signature is not a short string.')
  // A provider that declines ("not me, try another") says so with `declined: true` and nothing else: status 421, no headers, no body.
  if (head.declined !== undefined && typeof head.declined !== 'boolean') throw new IngressError(502, 'bad-response-head', 'The declined flag is not a boolean.')
  if (head.declined === true && (status !== 421 || head.headers.length || body || head.sig !== undefined)) throw new IngressError(502, 'bad-response-head', 'A declined answer carries no headers, body or signature.')
  return head
}

/** Stream meta both ends accept, and nothing else. */
export function validateStreamMeta(meta, kind) {
  if (!meta || typeof meta !== 'object' || meta.kind !== kind || !Number.isSafeInteger(meta.rid) || meta.rid <= 0) {
    throw new IngressError(400, 'bad-stream', 'The stream is not one this end expects.')
  }
  return meta
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
export async function sha256Hex(bytes) {
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)))
}

/**
 * What a response signature covers: the request it answers (its id and a fresh nonce, so an answer cannot be replayed for another request),
 * the status, the header list as the provider sent it, and the SHA-256 of the body.
 * @returns {Uint8Array}
 */
export function signedBytes({ rid, nonce, host, method, target, status, headers, digest }) {
  for (const [name] of headers) if (!isToken(name)) throw new TypeError('bad header name')
  return new TextEncoder().encode(JSON.stringify({ v: 1, rid, nonce, host, method, target, status, headers, digest }))
}

/**
 * What a request signature covers (`signRequest` on the ingress, `verifyRequest` on the provider): the request's id and a
 * fresh nonce (so a signature cannot be replayed for another request), the host, method and target, the header list as sent,
 * and the SHA-256 of the body. `dir: 'request'` keeps it apart from a response's bytes.
 * @returns {Uint8Array}
 */
export function signedRequestBytes({ rid, nonce, host, method, target, headers, client, digest, service }) {
  for (const [name] of headers) if (!isToken(name)) throw new TypeError('bad header name')
  // `service` is covered only when the request names one: a request without it signs the bytes it always did.
  return new TextEncoder().encode(JSON.stringify({ v: 1, dir: 'request', rid, nonce, host, method, target, headers, client, digest, ...(service === undefined ? {} : { service }) }))
}
