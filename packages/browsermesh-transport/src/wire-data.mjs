/**
 * wire-data.mjs -- the one canonical encoding for what a mesh transport
 * hands to a real wire.
 *
 * `RTCDataChannel.send()` and `WebSocket.send()` accept only a string or
 * binary data (`ArrayBuffer`, a typed-array view, a `Blob`). Anything else
 * is coerced with `String(value)`, so a plain object arrives as the
 * literal text `"[object Object]"` -- no error, no warning. PeerNode and
 * every MeshService above it send envelope *objects* (`{ type, ...payload }`),
 * so a transport that forwards its argument untouched silently destroys
 * every message.
 *
 * Rule: strings and binary pass through byte-for-byte; every other value is
 * sent as its JSON text. The receiving side's counterpart (parse a JSON
 * object/array string back into an object) lives with the consumer that
 * wants objects -- see `@johnhenry/browsermesh-apps`'s `ctx.onIncomingData()`.
 */

/**
 * Whether `data` is something a data channel / WebSocket accepts verbatim.
 * @param {*} data
 * @returns {boolean}
 */
export function isWireNative(data) {
  if (typeof data === 'string') return true;
  if (data instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(data)) return true;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return true;
  return false;
}

/**
 * Encode a value for `RTCDataChannel.send()` / `WebSocket.send()`.
 *
 * @param {*} data
 * @returns {string|ArrayBuffer|ArrayBufferView|Blob} `data` itself when it is
 *   already a string or binary; otherwise its JSON text.
 * @throws {TypeError} When `data` is `undefined` or a function/symbol (no JSON
 *   representation) -- failing loudly beats sending the text "undefined".
 */
export function encodeWireData(data) {
  if (isWireNative(data)) return data;
  const json = JSON.stringify(data);
  if (typeof json !== 'string') {
    throw new TypeError(`Cannot send a ${typeof data} over a transport (no JSON representation)`);
  }
  return json;
}
