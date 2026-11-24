/**
 * wsh-frames.mjs -- message boundaries for a mesh link carried on a wsh
 * named endpoint.
 *
 * A wsh endpoint is a duplex byte stream with credit based flow control and
 * no message boundaries. A mesh frame on it is
 *
 *     u32 big-endian length | u8 kind | payload
 *
 * where `length` counts the kind byte and the payload. Kind 0 is binary and
 * kind 1 is UTF-8 text. Strings and binary go out unchanged and any other
 * value as its JSON text, the rule every adapter in this package follows
 * (`encodeWireData`).
 *
 * The limit is checked on the HEADER, before any payload is buffered, so a
 * peer cannot make a reader allocate by announcing a large frame.
 *
 * Pure and browser-safe: no imports beyond a sibling helper.
 */

import { encodeWireData } from './wire-data.mjs';

export const FRAME_KIND_BINARY = 0;
export const FRAME_KIND_TEXT = 1;

/** Default largest frame (kind byte included): 1 MiB. */
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

/** Hard ceiling for `maxFrameBytes`: the length field is a u32. */
const MAX_POSSIBLE = 0xffffffff;

export class WshFrameError extends Error {
  /**
   * @param {'WSH_FRAME_TOO_LARGE'|'WSH_BAD_FRAME'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'WshFrameError';
    this.code = code;
  }
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

/** @param {unknown} v */
function checkLimit(v) {
  if (!Number.isSafeInteger(v) || v < 2 || v > MAX_POSSIBLE) {
    throw new TypeError('maxFrameBytes must be an integer between 2 and 4294967295');
  }
  return v;
}

/**
 * Frame one outgoing value.
 *
 * @param {*} data - string, ArrayBuffer, typed array, or anything JSON can carry
 * @param {{ maxFrameBytes?: number }} [opts]
 * @returns {Uint8Array}
 * @throws {WshFrameError} `WSH_FRAME_TOO_LARGE` when the frame would exceed the limit
 * @throws {TypeError} for values that have no wire form (`undefined`, functions)
 */
export function encodeFrame(data, { maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
  checkLimit(maxFrameBytes);
  const wire = encodeWireData(data);
  let kind;
  let payload;
  if (typeof wire === 'string') {
    kind = FRAME_KIND_TEXT;
    payload = textEncoder.encode(wire);
  } else if (wire instanceof ArrayBuffer) {
    kind = FRAME_KIND_BINARY;
    payload = new Uint8Array(wire);
  } else if (ArrayBuffer.isView(wire)) {
    kind = FRAME_KIND_BINARY;
    payload = new Uint8Array(wire.buffer, wire.byteOffset, wire.byteLength);
  } else {
    throw new TypeError('a wsh link carries strings, binary and JSON values, not Blobs');
  }
  const length = payload.length + 1;
  if (length > maxFrameBytes) {
    throw new WshFrameError('WSH_FRAME_TOO_LARGE', `frame of ${length} bytes exceeds the limit of ${maxFrameBytes}`);
  }
  const out = new Uint8Array(4 + length);
  new DataView(out.buffer).setUint32(0, length);
  out[4] = kind;
  out.set(payload, 5);
  return out;
}

/**
 * Incremental reader: feed it the chunks of the endpoint's readable side, get
 * whole frames back. After it throws it is dead (a link that framed badly is
 * closed by the caller; it must not resynchronise).
 */
export class FrameDecoder {
  #max;
  #chunks = [];
  #buffered = 0;
  #want = -1; // length of the frame being assembled, -1 while the header is incomplete
  #dead = false;

  /** @param {{ maxFrameBytes?: number }} [opts] */
  constructor({ maxFrameBytes = DEFAULT_MAX_FRAME_BYTES } = {}) {
    this.#max = checkLimit(maxFrameBytes);
  }

  /** Bytes held for a frame that is not complete yet. */
  get bufferedBytes() { return this.#buffered; }

  #fail(code, message) {
    this.#dead = true;
    this.#chunks = [];
    this.#buffered = 0;
    throw new WshFrameError(code, message);
  }

  #take(n) {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const head = this.#chunks[0];
      const need = n - o;
      if (head.length <= need) {
        out.set(head, o);
        o += head.length;
        this.#chunks.shift();
      } else {
        out.set(head.subarray(0, need), o);
        this.#chunks[0] = head.subarray(need);
        o += need;
      }
    }
    this.#buffered -= n;
    return out;
  }

  /**
   * @param {Uint8Array} chunk
   * @returns {Array<string|Uint8Array>} the frames completed by this chunk, in order
   */
  push(chunk) {
    if (this.#dead) throw new WshFrameError('WSH_BAD_FRAME', 'the stream is not usable after a framing error');
    if (chunk.length) {
      this.#chunks.push(chunk);
      this.#buffered += chunk.length;
    }
    const frames = [];
    for (;;) {
      if (this.#want < 0) {
        if (this.#buffered < 4) break;
        const len = new DataView(this.#take(4).buffer).getUint32(0);
        if (len > this.#max) this.#fail('WSH_FRAME_TOO_LARGE', `peer announced a frame of ${len} bytes; the limit is ${this.#max}`);
        if (len < 1) this.#fail('WSH_BAD_FRAME', 'empty frame (no kind byte)');
        this.#want = len;
      }
      if (this.#buffered < this.#want) break;
      const body = this.#take(this.#want);
      this.#want = -1;
      const kind = body[0];
      const payload = body.subarray(1);
      if (kind === FRAME_KIND_TEXT) {
        try { frames.push(textDecoder.decode(payload)); } catch { this.#fail('WSH_BAD_FRAME', 'text frame is not valid UTF-8'); }
      } else if (kind === FRAME_KIND_BINARY) {
        frames.push(payload.slice());
      } else {
        this.#fail('WSH_BAD_FRAME', `unknown frame kind ${kind}`);
      }
    }
    return frames;
  }

  /** The stream ended: it must not end inside a frame. */
  end() {
    if (this.#want >= 0 || this.#buffered > 0) {
      this.#fail('WSH_BAD_FRAME', 'the stream ended inside a frame');
    }
  }
}
