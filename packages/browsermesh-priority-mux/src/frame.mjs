/**
 * frame.mjs -- wire framing for chunked, prioritized messages.
 *
 * Mirrors the framing style already used in this monorepo (see
 * `@johnhenry/browsermesh-transport`'s `wisp-client.mjs` `encodeFrame`/
 * `decodeFrame`: a fixed-size binary header via DataView, little-endian,
 * followed by a raw payload) rather than inventing a new convention or
 * throwing an object at JSON.stringify.
 *
 * Frame layout (little-endian):
 *   [version:u8][priority:u8][msgId:u32][seq:u32][total:u32][payload:...]
 *    byte 0       byte 1       bytes 2-5   bytes 6-9  bytes 10-13  bytes 14+
 *
 * One frame is one discrete adapter `send()` call -- the underlying
 * transport (WebSocket, WebRTC data channel, etc.) is expected to preserve
 * message boundaries on its own (as WebSocket and RTCDataChannel both do),
 * so no additional length-prefixing of the transport stream itself is
 * needed here.
 */

export const FRAME_VERSION = 1;

/** Priority tier -> wire code. Order here has no bearing on scheduling order. */
export const PRIORITY_CODES = Object.freeze({ high: 0, normal: 1, low: 2 });
/** Wire code -> priority tier name. */
export const PRIORITY_NAMES = Object.freeze(['high', 'normal', 'low']);

const HEADER_BYTES = 14;

/**
 * Encode one chunk frame.
 * @param {object} chunk
 * @param {'high'|'normal'|'low'} chunk.priority
 * @param {number} chunk.msgId - u32
 * @param {number} chunk.seq - u32, 0-based index of this chunk
 * @param {number} chunk.total - u32, total chunk count for this message
 * @param {Uint8Array} chunk.payload
 * @returns {Uint8Array}
 */
export function encodeChunkFrame({ priority, msgId, seq, total, payload }) {
  const priorityCode = PRIORITY_CODES[priority];
  if (priorityCode === undefined) {
    throw new Error(`priority-mux: unknown priority tier "${priority}"`);
  }
  const payloadBytes = payload || new Uint8Array(0);
  const buf = new Uint8Array(HEADER_BYTES + payloadBytes.byteLength);
  const view = new DataView(buf.buffer);
  view.setUint8(0, FRAME_VERSION);
  view.setUint8(1, priorityCode);
  view.setUint32(2, msgId >>> 0, true);
  view.setUint32(6, seq >>> 0, true);
  view.setUint32(10, total >>> 0, true);
  buf.set(payloadBytes, HEADER_BYTES);
  return buf;
}

/**
 * Decode one chunk frame.
 * @param {ArrayBuffer|Uint8Array} data
 * @returns {{ priority: 'high'|'normal'|'low', msgId: number, seq: number, total: number, payload: Uint8Array }}
 */
export function decodeChunkFrame(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < HEADER_BYTES) {
    throw new Error('priority-mux: frame too short');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== FRAME_VERSION) {
    throw new Error(`priority-mux: unsupported frame version ${version}`);
  }
  const priority = PRIORITY_NAMES[view.getUint8(1)];
  if (!priority) {
    throw new Error(`priority-mux: unknown priority code ${view.getUint8(1)}`);
  }
  const msgId = view.getUint32(2, true);
  const seq = view.getUint32(6, true);
  const total = view.getUint32(10, true);
  const payload = bytes.subarray(HEADER_BYTES);
  return { priority, msgId, seq, total, payload };
}

/**
 * Split an envelope's bytes into an ordered array of chunk descriptors
 * (without `priority`/`msgId`, which the caller attaches).
 * @param {Uint8Array} bytes
 * @param {number} chunkSize
 * @returns {{ seq: number, total: number, payload: Uint8Array }[]}
 */
export function splitIntoChunks(bytes, chunkSize) {
  const total = Math.max(1, Math.ceil(bytes.byteLength / chunkSize));
  const chunks = new Array(total);
  for (let seq = 0; seq < total; seq++) {
    const start = seq * chunkSize;
    chunks[seq] = { seq, total, payload: bytes.subarray(start, start + chunkSize) };
  }
  return chunks;
}
