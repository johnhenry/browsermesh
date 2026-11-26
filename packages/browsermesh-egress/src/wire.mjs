/**
 * wire.mjs -- protocol `egress` v1: names, request validation, and the bytes a request signature covers.
 *
 * No framing of its own: a request is one channel request with an answer, bodies are protocol streams.
 *
 *   request  connect  { cid, host, port, hops: 0, nonce?, sig? }  -> { ok: true } | { ok: false, code, ... }
 *   stream   meta { cid, kind: 'down' }  provider -> consumer, opened BEFORE the answer
 *   stream   meta { cid, kind: 'up' }    consumer -> provider, opened after the answer
 *   request  resolve  { name, type: 'A', hops: 0, nonce?, sig? }  -> { ok: true, addresses: [string] } | { ok: false, code, ... }
 *   request  fetch    { cid, url, method, headers: [[name, value]], body, redirect, hops: 0, nonce?, sig? }
 *                     -> { ok: true, status, statusText, headers: [[name, value]], url, redirected } | { ok: false, code, ... }
 *                     the `down` stream of the cid (the response body) is opened BEFORE the answer; when `body` is true the consumer opens
 *                     the `up` stream (the request body) right after sending the request, not after the answer
 *   request  udp      { cid, host, port, hops: 0, nonce?, sig? }  -> { ok: true, maxDatagramBytes } | { ok: false, code, ... }
 *                     one flow to one destination; `down` is opened BEFORE the answer, `up` after it; each stream carries
 *                     datagrams as frames: a 2-byte big-endian length, then that many bytes
 *   notify   end      { cid, reason }    provider -> consumer, before it aborts the streams of a connection it ended
 */
import { EgressError } from './errors.mjs'
import { checkHost, checkName, checkPort } from './destination.mjs'
import { MAX_HEADERS, MAX_URL_LENGTH, RESPONSE_HEADERS, checkHeaderPairs, isHeader, parseTarget } from './http-policy.mjs'

export const EGRESS_PROTOCOL = 'egress'
export const EGRESS_VERSIONS = Object.freeze([1])
export const CONNECT_METHOD = 'connect'
export const RESOLVE_METHOD = 'resolve'
export const FETCH_METHOD = 'fetch'
export const UDP_METHOD = 'udp'
export const END_METHOD = 'end'
export const KIND_UP = 'up'
export const KIND_DOWN = 'down'

/**
 * Marks a function or object as an egress CONSUMER (a link's `connect`/`lookup`, a backend). A provider refuses to be
 * built on one: its `dial` and `resolve` must reach a network, not another egress.
 */
export const EGRESS_CONSUMER = Symbol.for('browsermesh.egress.consumer')

const NONCE = /^[0-9a-f]{16,64}$/
const MAX_ADDRESSES = 16

function checkSigFields(params) {
  if (params.nonce !== undefined && (typeof params.nonce !== 'string' || !NONCE.test(params.nonce))) throw new EgressError('bad-request', 'The nonce is not 16 to 64 hex characters.')
  if (params.sig !== undefined && (typeof params.sig !== 'string' || params.sig.length > 2048)) throw new EgressError('bad-request', 'The signature is not a short string.')
}

/** @returns {{ cid: number, host: string, kind: 'name'|'ipv4', port: number, hops: number, nonce?: string, sig?: string }} or throws EgressError */
export function validateConnect(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new EgressError('bad-request', 'The request is not an object.')
  const { cid, hops } = params
  if (!Number.isSafeInteger(cid) || cid <= 0) throw new EgressError('bad-request', 'The connection id is not a positive integer.')
  if (!Number.isSafeInteger(hops) || hops < 0) throw new EgressError('bad-request', 'The hop count is not a whole number.')
  checkSigFields(params)
  if (hops !== 0) return { cid, hops, host: '', kind: 'name', port: 0 } // the caller refuses it as chaining before looking further
  const { host, kind } = checkHost(params.host)
  return { cid, hops, host, kind, port: checkPort(params.port), nonce: params.nonce, sig: params.sig }
}

/** @returns {{ name: string, type: 'A', hops: number, nonce?: string, sig?: string }} or throws EgressError */
export function validateResolve(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new EgressError('bad-request', 'The request is not an object.')
  const { hops } = params
  if (!Number.isSafeInteger(hops) || hops < 0) throw new EgressError('bad-request', 'The hop count is not a whole number.')
  if (params.type !== 'A') throw new EgressError('bad-request', 'Only the A record type is served.')
  checkSigFields(params)
  if (hops !== 0) return { name: '', type: 'A', hops }
  return { name: checkName(params.name), type: 'A', hops, nonce: params.nonce, sig: params.sig }
}

/** Stream meta each end accepts, and nothing else. */
export function validateStreamMeta(meta, kind) {
  if (!meta || typeof meta !== 'object' || meta.kind !== kind || !Number.isSafeInteger(meta.cid) || meta.cid <= 0) {
    throw new EgressError('bad-request', 'The stream is not one this end expects.')
  }
  return meta
}

/**
 * The fetch form's request: `{ cid, url, method, headers: [[name, value]], body: boolean, redirect: 'follow'|'manual', hops, nonce?, sig? }`.
 * The URL is parsed here (`bad-url`, `bad-destination`); the method is only checked for shape (the provider's list decides).
 * @returns {{ cid: number, hops: number, method: string, headers: Array<[string,string]>, body: boolean, redirect: string, target: object, nonce?: string, sig?: string }}
 */
export function validateFetch(params, { maxHeaderBytes } = {}) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) throw new EgressError('bad-request', 'The request is not an object.')
  const { cid, hops } = params
  if (!Number.isSafeInteger(cid) || cid <= 0) throw new EgressError('bad-request', 'The connection id is not a positive integer.')
  if (!Number.isSafeInteger(hops) || hops < 0) throw new EgressError('bad-request', 'The hop count is not a whole number.')
  checkSigFields(params)
  if (hops !== 0) return { cid, hops, method: 'GET', headers: [], body: false, redirect: 'follow', target: null }
  if (typeof params.url !== 'string') throw new EgressError('bad-request', 'The URL is not a string.')
  if (typeof params.method !== 'string' || !/^[A-Z]{3,7}$/.test(params.method)) throw new EgressError('bad-request', 'The method is not an upper-case word.')
  if (typeof params.body !== 'boolean') throw new EgressError('bad-request', 'body is true or false.')
  if (params.redirect !== 'follow' && params.redirect !== 'manual') throw new EgressError('bad-request', 'redirect is follow or manual.')
  if (params.body && (params.method === 'GET' || params.method === 'HEAD')) throw new EgressError('bad-request', 'A GET or HEAD request has no body.')
  const headers = checkHeaderPairs(params.headers, { maxBytes: maxHeaderBytes })
  return { cid, hops, method: params.method, headers, body: params.body, redirect: params.redirect, target: parseTarget(params.url), nonce: params.nonce, sig: params.sig }
}

/** A provider's answer to `fetch`, from a pod this side does not control. Throws EgressError('bad-answer'). */
export function validateFetchAnswer(answer) {
  const bad = (why) => new EgressError('bad-answer', `The provider's fetch answer is not readable: ${why}.`)
  const { status, headers, url, statusText } = answer ?? {}
  if (!Number.isSafeInteger(status) || status < 200 || status > 599) throw bad('status')
  if (!Array.isArray(headers) || headers.length > 4 * MAX_HEADERS) throw bad('headers')
  const pairs = []
  for (const pair of headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') throw bad('a header')
    // What this side will not put in a Response, it drops: a cookie, a hop-by-hop header, a name or value that is not plain.
    const name = pair[0].toLowerCase()
    if (pairs.length < MAX_HEADERS && RESPONSE_HEADERS.includes(name) && isHeader(name, pair[1])) pairs.push([name, pair[1]])
  }
  let final
  if (url !== undefined) {
    if (typeof url !== 'string' || url.length > MAX_URL_LENGTH) throw bad('url')
    try { final = new URL(url) } catch { throw bad('url') }
    if (final.protocol !== 'http:' && final.protocol !== 'https:') throw bad('url')
  }
  const text = typeof statusText === 'string' && statusText.length <= 64 && /^[\t\x20-\x7e]*$/.test(statusText) ? statusText : ''
  return { status, statusText: text, headers: pairs, url: final?.href, redirected: answer.redirected === true }
}

/** A provider's answer to `resolve`, from a pod this side does not control. Throws EgressError('bad-answer'). */
export function validateAddresses(answer) {
  const list = answer?.addresses
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_ADDRESSES) throw new EgressError('bad-answer', 'The provider\'s addresses are not a short, non-empty list.')
  for (const a of list) {
    if (typeof a !== 'string' || !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(a) || a.split('.').some((o) => Number(o) > 255)) throw new EgressError('bad-answer', 'The provider answered with something that is not an IPv4 address.')
  }
  return list
}

export const MAX_ANSWER_ADDRESSES = MAX_ADDRESSES

/**
 * What a request signature covers (`signRequest` on the consumer, `verifyRequest` on the provider): the form, the request's
 * id and a fresh nonce (so a signature cannot be replayed for another request), and the destination.
 * @returns {Uint8Array}
 */
export function signedRequestBytes({ form, cid, nonce, host, port }) {
  return new TextEncoder().encode(JSON.stringify({ v: 1, dir: 'request', form, cid: cid ?? null, nonce, host, port: port ?? null }))
}

export const randomHex = (n) => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('')
