/**
 * ByteStream — duck-typed stream protocol with utilities.
 *
 * Provides a protocol symbol, type checking, pipe utilities, and an in-memory
 * pipe factory built on an internal AsyncBuffer (matching netway's pattern).
 * EOF propagation on error ensures paired endpoints close cleanly.
 *
 * @module byte-stream
 */

import { StreamClosedError } from './errors.mjs';
import { KERNEL_DEFAULTS } from './constants.mjs';

/**
 * Symbol used to tag objects as ByteStream-compliant.
 */
export const BYTE_STREAM = Symbol.for('kernel.ByteStream');

/**
 * Check whether an object conforms to the ByteStream protocol.
 * A ByteStream must have `read`, `write`, and `close` methods.
 *
 * @param {*} obj - The object to check.
 * @returns {boolean}
 */
export function isByteStream(obj) {
  return obj != null &&
    typeof obj.read === 'function' &&
    typeof obj.write === 'function' &&
    typeof obj.close === 'function';
}

/**
 * Tag an object with the ByteStream symbol. Idempotent — already tagged
 * objects are returned as-is.
 *
 * @param {Object} obj - The object to tag (must have read/write/close).
 * @returns {Object} The tagged object.
 */
export function asByteStream(obj) {
  if (obj[BYTE_STREAM]) return obj;
  obj[BYTE_STREAM] = true;
  return obj;
}

/**
 * Simple asynchronous FIFO buffer with blocking pull semantics.
 * Matches netway's AsyncBuffer pattern. EOF propagation on error.
 *
 * @private
 */
class AsyncBuffer {
  #queue = [];
  #waiters = [];
  #writeClosed = false;
  #readClosed = false;
  #paused = false;
  #highWaterMark;

  constructor({ highWaterMark = 0 } = {}) {
    this.#highWaterMark = highWaterMark;
  }

  push(data) {
    if (this.#writeClosed || this.#readClosed) return false;
    if (this.#waiters.length > 0) {
      this.#waiters.shift()(data);
      return true;
    }
    this.#queue.push(data);
    if (this.#highWaterMark > 0 && this.#queue.length >= this.#highWaterMark) {
      this.#paused = true;
      return false;
    }
    return true;
  }

  pull() {
    if (this.#queue.length > 0) {
      const item = this.#queue.shift();
      // Resume writes when queue drains below high-water mark
      if (this.#paused && this.#queue.length < this.#highWaterMark) {
        this.#paused = false;
      }
      return Promise.resolve(item);
    }
    if (this.#writeClosed || this.#readClosed) return Promise.resolve(null);
    return new Promise(resolve => this.#waiters.push(resolve));
  }

  /** @returns {boolean} Whether the buffer is accepting writes */
  get writable() { return !this.#writeClosed && !this.#readClosed && !this.#paused; }

  /** Signal no more writes — existing buffered data can still be drained. */
  closeWrite() {
    this.#writeClosed = true;
    this.#paused = false;
    // Resolve waiters so blocked reads get null after queue is drained
    for (const w of this.#waiters) w(null);
    this.#waiters.length = 0;
  }

  /** Hard close — discard everything. */
  closeRead() {
    this.#readClosed = true;
    this.#writeClosed = true;
    this.#paused = false;
    for (const w of this.#waiters) w(null);
    this.#waiters.length = 0;
    this.#queue.length = 0;
  }

  get isClosed() { return this.#writeClosed && this.#readClosed; }
}

/**
 * Create an in-memory pipe returning `[reader, writer]` ByteStreams.
 * Data written to `writer` can be read from `reader`. Closing either
 * endpoint propagates EOF to the other.
 *
 * @param {Object} [opts={}]
 * @param {number} [opts.highWaterMark=1024] - Maximum queue depth.
 * @returns {[Object, Object]} `[reader, writer]` ByteStream pair.
 */
export function createPipe({ highWaterMark = KERNEL_DEFAULTS.DEFAULT_STREAM_BUFFER_SIZE } = {}) {
  const buffer = new AsyncBuffer({ highWaterMark });
  let readerClosed = false;
  let writerClosed = false;

  const reader = {
    [BYTE_STREAM]: true,
    async read() {
      if (readerClosed) return null;
      return buffer.pull();
    },
    async write() {
      throw new StreamClosedError();
    },
    async close() {
      if (readerClosed) return;
      readerClosed = true;
      buffer.closeRead();
    },
    get closed() { return readerClosed; },
  };

  const writer = {
    [BYTE_STREAM]: true,
    async read() {
      throw new StreamClosedError();
    },
    async write(data) {
      if (writerClosed) throw new StreamClosedError();
      if (!buffer.push(data)) {
        writerClosed = true;
        throw new StreamClosedError();
      }
    },
    async close() {
      if (writerClosed) return;
      writerClosed = true;
      // Signal EOF — existing data can still be drained by reader
      buffer.closeWrite();
    },
    get closed() { return writerClosed; },
  };

  return [reader, writer];
}

/**
 * Pipe all data from a source ByteStream to a destination ByteStream.
 * Reads from src until null (EOF), writes each chunk to dst.
 * On transport error, closes both endpoints for clean EOF propagation.
 *
 * @param {Object} src - Source ByteStream.
 * @param {Object} dst - Destination ByteStream.
 * @returns {Promise<void>}
 */
export async function pipe(src, dst) {
  try {
    let chunk;
    while ((chunk = await src.read()) !== null) {
      await dst.write(chunk);
    }
  } catch (err) {
    // EOF propagation on error — close both endpoints
    await src.close().catch(() => {});
    await dst.close().catch(() => {});
    throw err;
  }
}

/**
 * Create a sink ByteStream that discards all writes and returns null on read.
 *
 * @returns {Object} A ByteStream that acts as `/dev/null`.
 */
export function devNull() {
  return {
    [BYTE_STREAM]: true,
    async read() { return null; },
    async write() {},
    async close() {},
    get closed() { return false; },
  };
}

/**
 * Transform protocol. A transform has a single method:
 *   `transform(chunk: Uint8Array) → Uint8Array | Promise<Uint8Array>`
 *
 * Transforms can be composed onto any ByteStream to create processing
 * pipelines (compression, encryption, tracing, rate-limiting, etc.).
 */

/**
 * Compose one or more transforms onto a ByteStream, returning a new
 * ByteStream that applies the transforms in order on read and in
 * reverse order on write.
 *
 * @param {Object} stream - The underlying ByteStream.
 * @param {...{ transform: function(Uint8Array): Uint8Array|Promise<Uint8Array> }} transforms - Transform objects.
 * @returns {Object} A new ByteStream with transforms applied.
 */
export function compose(stream, ...transforms) {
  if (transforms.length === 0) return stream;

  return {
    [BYTE_STREAM]: true,

    async read() {
      const chunk = await stream.read();
      if (chunk === null) return null;
      let result = chunk;
      for (const t of transforms) {
        result = await t.transform(result);
      }
      return result;
    },

    async write(data) {
      let result = data;
      // Apply inverse transforms in reverse for writes (fall back to transform if no untransform)
      for (let i = transforms.length - 1; i >= 0; i--) {
        const t = transforms[i];
        result = await (t.untransform ? t.untransform(result) : t.transform(result));
      }
      await stream.write(result);
    },

    async close() {
      await stream.close();
    },

    get closed() { return stream.closed; },
  };
}
