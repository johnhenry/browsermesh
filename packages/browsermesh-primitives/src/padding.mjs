/**
 * Size-bucket padding for relay-blind envelopes.
 *
 * A relay that only ever sees ciphertext still learns exact payload sizes,
 * and for short agent messages (tool calls, chat turns, presence) size alone
 * distinguishes message types. `padTo()` rounds a payload up to one of a few
 * bucket sizes so every message in a bucket looks the same length; `unpad()`
 * strips it again.
 *
 * Wire layout of a padded payload (total length is always the bucket size):
 *
 *     [ payload (n bytes) ][ random fill ][ n as uint32 big-endian ]
 *
 * The trailer is plaintext, so pad BEFORE sealing (encrypt the padded bytes)
 * and unpad AFTER opening. Padding applied to already-encrypted bytes leaves
 * the length trailer readable and hides nothing from whoever reads those
 * bytes. Padding hides size, not timing; there is no cover traffic.
 *
 * Pure module: no I/O. Uses `crypto.getRandomValues` for the fill.
 */

/** Default bucket sizes in bytes. */
export const DEFAULT_PAD_BUCKETS = Object.freeze([256, 1024, 4096, 16384]);

/** Bytes the length trailer occupies; a payload needs `length + 4` bytes of bucket. */
export const PAD_TRAILER_BYTES = 4;

/** `crypto.getRandomValues` accepts at most 65536 bytes per call. */
const RANDOM_CHUNK = 65536;

/**
 * @param {number[]|undefined} buckets
 * @returns {number[]} ascending, de-duplicated copy
 */
function normalizeBuckets(buckets) {
  const list = buckets === undefined ? DEFAULT_PAD_BUCKETS : buckets;
  if (!Array.isArray(list) || list.length === 0) {
    throw new TypeError('buckets must be a non-empty array of positive integers');
  }
  for (const b of list) {
    if (!Number.isSafeInteger(b) || b <= PAD_TRAILER_BYTES) {
      throw new TypeError(`bucket sizes must be integers greater than ${PAD_TRAILER_BYTES}, got ${b}`);
    }
  }
  return [...new Set(list)].sort((a, b) => a - b);
}

/**
 * The padded length a payload of `length` bytes will have.
 *
 * The smallest bucket that fits `length + 4`; a payload larger than the
 * largest bucket pads up to the next multiple of the largest bucket.
 *
 * @param {number} length - Payload length in bytes
 * @param {{ buckets?: number[] }} [opts]
 * @returns {number}
 */
export function paddedLength(length, { buckets } = {}) {
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new TypeError('length must be a non-negative integer');
  }
  const sorted = normalizeBuckets(buckets);
  const needed = length + PAD_TRAILER_BYTES;
  for (const b of sorted) {
    if (needed <= b) return b;
  }
  const largest = sorted[sorted.length - 1];
  return Math.ceil(needed / largest) * largest;
}

/**
 * Pad `bytes` up to a size bucket.
 *
 * @param {Uint8Array} bytes
 * @param {object} [opts]
 * @param {number[]} [opts.buckets=DEFAULT_PAD_BUCKETS] - Bucket sizes in bytes
 * @returns {Uint8Array} A new array whose length is a bucket size
 */
export function padTo(bytes, { buckets } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('padTo: bytes must be a Uint8Array');
  if (bytes.length > 0xffffffff) throw new RangeError('padTo: payload too large');
  const total = paddedLength(bytes.length, { buckets });
  const out = new Uint8Array(total);
  out.set(bytes, 0);
  const fillEnd = total - PAD_TRAILER_BYTES;
  for (let off = bytes.length; off < fillEnd; off += RANDOM_CHUNK) {
    crypto.getRandomValues(out.subarray(off, Math.min(off + RANDOM_CHUNK, fillEnd)));
  }
  new DataView(out.buffer).setUint32(fillEnd, bytes.length, false);
  return out;
}

/**
 * Strip the padding added by {@link padTo}.
 *
 * @param {Uint8Array} padded
 * @returns {Uint8Array} The original payload (a view into `padded`)
 * @throws {RangeError} If `padded` is too short or its trailer is inconsistent
 */
export function unpad(padded) {
  if (!(padded instanceof Uint8Array)) throw new TypeError('unpad: padded must be a Uint8Array');
  if (padded.length < PAD_TRAILER_BYTES) throw new RangeError('unpad: input shorter than the length trailer');
  const fillEnd = padded.length - PAD_TRAILER_BYTES;
  const length = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(fillEnd, false);
  if (length > fillEnd) throw new RangeError('unpad: length trailer exceeds the padded size');
  return padded.subarray(0, length);
}
