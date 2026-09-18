/**
 * envelope.mjs -- transparent message envelope encoding.
 *
 * PriorityMux chunks and reassembles arbitrary messages. So that reassembly
 * hands callers back the *same shape* they sent (string in -> string out,
 * plain object in -> plain object out, bytes in -> bytes out) rather than
 * always producing raw bytes, every message is wrapped in a 1-byte tag
 * before chunking, and unwrapped again after reassembly.
 *
 * Wire layout: [tag:u8][body:...]
 */

/** @type {0} raw bytes (Uint8Array/ArrayBuffer), passed through untouched */
export const ENVELOPE_BYTES = 0;
/** @type {1} UTF-8 string */
export const ENVELOPE_STRING = 1;
/** @type {2} JSON-serializable value */
export const ENVELOPE_JSON = 2;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Encode an arbitrary message into a tagged byte envelope.
 * @param {Uint8Array|ArrayBuffer|string|*} data
 * @returns {Uint8Array}
 */
export function encodeEnvelope(data) {
  let tag;
  let body;

  if (data instanceof Uint8Array) {
    tag = ENVELOPE_BYTES;
    body = data;
  } else if (data instanceof ArrayBuffer) {
    tag = ENVELOPE_BYTES;
    body = new Uint8Array(data);
  } else if (typeof data === 'string') {
    tag = ENVELOPE_STRING;
    body = textEncoder.encode(data);
  } else {
    tag = ENVELOPE_JSON;
    body = textEncoder.encode(JSON.stringify(data));
  }

  const out = new Uint8Array(1 + body.byteLength);
  out[0] = tag;
  out.set(body, 1);
  return out;
}

/**
 * Decode a tagged byte envelope back into its original shape.
 * @param {Uint8Array} bytes
 * @returns {Uint8Array|string|*}
 */
export function decodeEnvelope(bytes) {
  if (bytes.byteLength < 1) throw new Error('priority-mux: envelope too short');
  const tag = bytes[0];
  const body = bytes.subarray(1);

  switch (tag) {
    case ENVELOPE_BYTES:
      return body;
    case ENVELOPE_STRING:
      return textDecoder.decode(body);
    case ENVELOPE_JSON:
      return JSON.parse(textDecoder.decode(body));
    default:
      throw new Error(`priority-mux: unknown envelope tag ${tag}`);
  }
}
