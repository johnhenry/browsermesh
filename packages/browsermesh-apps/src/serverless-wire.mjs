/**
 * serverless-wire.mjs -- shared binary-body encoding for the
 * BrowserMesh Serverless plan's `mesh-rpc` hop
 * (`/Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md`,
 * Phase 2).
 *
 * `mesh-rpc.mjs`'s wire protocol treats a response's `body` as a plain
 * JSON-shaped envelope field (see that file's module doc comment: "typical
 * callers stringify a JSON envelope first" is `peer-node.mjs`'s own
 * guidance for `sendTo()`'s payload). A raw `Uint8Array`/`ArrayBuffer` body
 * -- e.g. `serverless-static.mjs`'s file bytes -- is not safe to hand to
 * that layer as-is, for the same reason `cloud-storage-backend.mjs` already
 * base64-encodes chunk bytes before putting them in a command envelope:
 * whatever the underlying transport does to serialize an envelope object,
 * a raw byte array embedded in it cannot be assumed to survive intact.
 *
 * `encodeWireResponse()`/`decodeWireResponse()` are the matched pair used
 * on either side of that hop -- `serverless-router.mjs` (server side, right
 * before handing a response to `createMeshRpcService({onRequest})`) and
 * `serverless-fetch.mjs` (client side, right after `meshRpcApi.request()`
 * returns, before handing the result to `MeshFetchRouter`, which itself
 * needs a real `Uint8Array`/`ArrayBuffer`/string body to build a correct
 * `Response` -- see `sw-routing.mjs`'s `MeshFetchRouter.route()` fix in
 * this same phase for the other half of this).
 *
 * @module serverless-wire
 */

/** Internal header carrying the wire-encoding marker. Stripped before the final Response's headers reach a caller. */
const WIRE_ENCODING_HEADER = 'x-mesh-serverless-body-encoding'

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

/** @param {string} str @returns {Uint8Array} */
function fromBase64(str) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'))
  const bin = atob(str)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * Server side: if `res.body` is binary, base64-encode it and mark the
 * encoding via `WIRE_ENCODING_HEADER` so `decodeWireResponse()` on the
 * other end knows to reverse it. String/plain-object bodies pass through
 * unchanged -- `mesh-rpc.mjs` already handles those natively.
 *
 * @param {{status?: number, headers?: object, body?: *}} res
 * @returns {{status: number, headers: object, body: *}}
 */
export function encodeWireResponse(res = {}) {
  const status = res.status ?? 200
  const headers = res.headers || {}
  const body = res.body
  if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : body
    return { status, headers: { ...headers, [WIRE_ENCODING_HEADER]: 'base64' }, body: toBase64(bytes) }
  }
  return { status, headers, body }
}

/**
 * Client side: reverses `encodeWireResponse()`. Always strips
 * `WIRE_ENCODING_HEADER` from the returned headers, whether or not this
 * particular response was binary-encoded, so it never leaks into a real
 * `Response`'s headers.
 *
 * @param {{status?: number, headers?: object, body?: *}} res
 * @returns {{status: number, headers: object, body: *}}
 */
export function decodeWireResponse(res = {}) {
  const status = res.status ?? 200
  const headers = { ...(res.headers || {}) }
  const isBase64 = headers[WIRE_ENCODING_HEADER] === 'base64'
  delete headers[WIRE_ENCODING_HEADER]
  const body = isBase64 && typeof res.body === 'string' ? fromBase64(res.body) : res.body
  return { status, headers, body }
}

export { WIRE_ENCODING_HEADER }
