/**
 * wire.mjs -- protocol `egress` v1: names, request validation, and the bytes a request signature covers.
 *
 * No framing of its own: a request is one channel request with an answer, bodies are protocol streams.
 *
 *   request  connect  { cid, host, port, hops: 0, nonce?, sig? }  -> { ok: true } | { ok: false, code, ... }
 *   stream   meta { cid, kind: 'down' }  provider -> consumer, opened BEFORE the answer
 *   stream   meta { cid, kind: 'up' }    consumer -> provider, opened after the answer
 *   request  resolve  { name, type: 'A', hops: 0, nonce?, sig? }  -> { ok: true, addresses: [string] } | { ok: false, code, ... }
 *   notify   end      { cid, reason }    provider -> consumer, before it aborts the streams of a connection it ended
 */
import { EgressError } from './errors.mjs'
import { checkHost, checkName, checkPort } from './destination.mjs'

export const EGRESS_PROTOCOL = 'egress'
export const EGRESS_VERSIONS = Object.freeze([1])
export const CONNECT_METHOD = 'connect'
export const RESOLVE_METHOD = 'resolve'
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
