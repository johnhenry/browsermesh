/**
 * StreamSocket — reliable, ordered byte stream built on an internal async buffer.
 *
 * Provides a TCP-like abstraction where two endpoints exchange `Uint8Array` chunks
 * in order. Uses {@link AsyncBuffer} internally instead of `TransformStream` so that
 * both ends can be closed cleanly without dangling readers or writers.
 *
 * Typical usage: call {@link StreamSocket.createPair} to get two connected sockets,
 * or receive one from {@link Listener#accept} / {@link Backend#connect}.
 *
 * Flow control: each direction counts the bytes queued and not yet read.
 * `write()` waits (it does not return) while that count is at or above
 * `highWaterBytes`, and continues once the reader has brought it to
 * `lowWaterBytes` or below, so a fast writer cannot outrun a slow reader.
 * Nothing is dropped. If the count would pass `maxBufferedBytes`, or the
 * queue passes `highWaterMark` chunks, the socket closes and records why
 * (`closeReason`).
 *
 * @module stream-socket
 */

import { SocketClosedError } from './errors.mjs';

/**
 * Defaults for the byte limits of a stream, per direction.
 *
 * - `highWaterBytes`: a write waits while this many bytes are queued unread.
 * - `lowWaterBytes`: waiting writes continue once the queue is at or below this.
 * - `maxBufferedBytes`: hard cap; exceeding it closes the socket with a reason.
 *   A single chunk is always accepted when nothing is queued, whatever its size.
 *
 * A value of `0` disables the corresponding limit.
 */
export const STREAM_DEFAULTS = Object.freeze({
  highWaterBytes: 1024 * 1024,
  lowWaterBytes: 256 * 1024,
  maxBufferedBytes: 4 * 1024 * 1024,
});

/**
 * Asynchronous FIFO buffer with blocking pull semantics and byte accounting.
 *
 * Data offered to the buffer is either delivered immediately to a waiting
 * consumer or queued until a consumer calls {@link AsyncBuffer#pull}. Once
 * closed, all pending and future pulls resolve with `null`.
 *
 * @private
 */
class AsyncBuffer {
  #queue = [];
  #waiters = [];
  #pendingWrites = [];
  #closed = false;
  #closeReason = null;
  #blocked = false;
  #bytes = 0;
  #highWaterMark;
  #highWaterBytes;
  #lowWaterBytes;
  #maxBufferedBytes;

  /**
   * @param {Object} [opts={}]
   * @param {number} [opts.highWaterMark=0] - Maximum queue depth in chunks before the
   *   buffer is closed to prevent unbounded memory growth. `0` means unlimited.
   * @param {number} [opts.highWaterBytes=0] - Queued bytes at which `offer()` starts waiting. `0`: never.
   * @param {number} [opts.lowWaterBytes=0] - Queued bytes at or below which waiting offers continue.
   * @param {number} [opts.maxBufferedBytes=0] - Queued bytes above which the buffer closes. `0`: never.
   */
  constructor({ highWaterMark = 0, highWaterBytes = 0, lowWaterBytes = 0, maxBufferedBytes = 0 } = {}) {
    this.#highWaterMark = highWaterMark;
    this.#highWaterBytes = highWaterBytes;
    this.#lowWaterBytes = lowWaterBytes;
    this.#maxBufferedBytes = maxBufferedBytes;
  }

  /** Bytes queued and not yet pulled. */
  get bytes() { return this.#bytes; }

  /** Why the buffer was closed, or `null`. */
  get closeReason() { return this.#closeReason; }

  /**
   * Hand a chunk to the buffer. Resolves when the chunk has been accepted:
   * at once while the queued bytes are under the high-water mark, otherwise
   * after the reader has drained the queue to the low-water mark. Chunks keep
   * their order. Rejects if the buffer is, or becomes, closed.
   *
   * @param {Uint8Array} data
   * @returns {Promise<void>}
   */
  offer(data) {
    if (this.#closed) return Promise.reject(new SocketClosedError(this.#closeReason));
    if (this.#blocked || this.#atHighWater()) {
      this.#blocked = true;
      return new Promise((resolve, reject) => this.#pendingWrites.push({ data, resolve, reject }));
    }
    return this.#accept(data) ? Promise.resolve() : Promise.reject(new SocketClosedError(this.#closeReason));
  }

  #atHighWater() {
    return this.#highWaterBytes > 0 && this.#bytes >= this.#highWaterBytes;
  }

  /**
   * Deliver or enqueue a chunk now. A chunk that goes straight to a waiting
   * reader is not counted. If the queue exceeds a limit the buffer closes.
   *
   * @param {Uint8Array} data
   * @returns {boolean} `true` if accepted, `false` if the buffer is closed.
   */
  #accept(data) {
    if (this.#closed) return false;
    if (this.#waiters.length > 0) {
      this.#waiters.shift()(data);
      return true;
    }
    if (this.#maxBufferedBytes > 0 && this.#bytes > 0 && this.#bytes + data.length > this.#maxBufferedBytes) {
      this.close('buffer limit exceeded');
      return false;
    }
    this.#queue.push(data);
    this.#bytes += data.length;
    // Check the chunk limit — stop accepting new data but keep the queue
    // intact so existing data can still be drained by pull().
    if (this.#highWaterMark > 0 && this.#queue.length >= this.#highWaterMark) {
      this.#closed = true;
      this.#closeReason ??= 'queue limit exceeded';
      this.#rejectPending();
      return false;
    }
    return true;
  }

  /**
   * Pull the next data chunk from the buffer. If data is already queued, resolves
   * immediately. If the buffer is empty and open, blocks until data arrives. If the
   * buffer is closed (or closes while waiting), resolves with `null`.
   *
   * @returns {Promise<Uint8Array|null>} The next chunk, or `null` if the buffer is closed.
   */
  pull() {
    if (this.#queue.length > 0) {
      const chunk = this.#queue.shift();
      this.#bytes -= chunk.length;
      if (this.#blocked && this.#bytes <= this.#lowWaterBytes) this.#releaseWrites();
      return Promise.resolve(chunk);
    }
    if (this.#closed) return Promise.resolve(null);
    return new Promise(resolve => this.#waiters.push(resolve));
  }

  /** Let waiting writes continue, in order, until the high-water mark is reached again. */
  #releaseWrites() {
    this.#blocked = false;
    while (this.#pendingWrites.length > 0) {
      if (this.#atHighWater()) {
        this.#blocked = true;
        return;
      }
      const { data, resolve, reject } = this.#pendingWrites.shift();
      if (this.#accept(data)) resolve();
      else reject(new SocketClosedError(this.#closeReason));
      if (this.#closed) return;
    }
  }

  #rejectPending() {
    const pending = this.#pendingWrites.splice(0);
    for (const { reject } of pending) reject(new SocketClosedError(this.#closeReason));
  }

  /**
   * Close the buffer. All currently waiting consumers receive `null`, waiting
   * writers are rejected. Any remaining queued data is discarded. Further
   * offers are rejected.
   *
   * @param {string} [reason] - Why it was closed; the first reason given is kept.
   */
  close(reason) {
    this.#closed = true;
    if (reason) this.#closeReason ??= reason;
    for (const w of this.#waiters) w(null);
    this.#waiters.length = 0;
    this.#queue.length = 0;
    this.#bytes = 0;
    this.#rejectPending();
  }

  /** Whether this buffer has been closed. */
  get isClosed() { return this.#closed; }
}

/**
 * A reliable, ordered, bidirectional byte stream socket.
 *
 * Each socket holds references to two {@link AsyncBuffer}s: one for inbound data
 * (data arriving *to* this socket) and one for outbound data (data leaving *from*
 * this socket, which is the peer's inbound buffer).
 *
 * Closing a socket closes both buffers, which signals EOF to both endpoints.
 */
export class StreamSocket {
  #inbound;   // AsyncBuffer — data coming TO this socket
  #outbound;  // AsyncBuffer — data going FROM this socket (peer's inbound)
  #closed = false;

  /**
   * Create a StreamSocket with pre-wired inbound and outbound buffers.
   * Callers typically should not construct this directly; use
   * {@link StreamSocket.createPair} or receive a socket from a backend.
   *
   * @param {Object} buffers
   * @param {AsyncBuffer} buffers.inbound - Buffer for data arriving to this socket.
   * @param {AsyncBuffer} buffers.outbound - Buffer for data sent from this socket (the peer's inbound).
   */
  constructor({ inbound, outbound }) {
    this.#inbound = inbound;
    this.#outbound = outbound;
  }

  /**
   * Read the next chunk of data from the stream. Blocks until data is available.
   * Returns `null` when the socket (or its inbound buffer) is closed, signaling EOF.
   *
   * @returns {Promise<Uint8Array|null>} The next data chunk, or `null` on EOF.
   */
  async read() {
    if (this.#closed) return null;
    return this.#inbound.pull();
  }

  /**
   * Write a chunk of data to the stream. The data is pushed to the peer's
   * inbound buffer. While the peer has not read the bytes already queued up to
   * the high-water mark, the returned promise stays pending; it settles once
   * the chunk has been accepted.
   *
   * @param {Uint8Array} data - The data to send.
   * @throws {SocketClosedError} If the socket has been closed (the error carries `reason`).
   */
  async write(data) {
    if (this.#closed) throw new SocketClosedError(this.closeReason);
    await this.#outbound.offer(data);
  }

  /**
   * Close the socket, shutting down both directions. Subsequent reads return
   * `null`; subsequent writes throw {@link SocketClosedError}. Calling close on
   * an already-closed socket is a no-op.
   *
   * @param {string} [reason] - Recorded as `closeReason` on both endpoints.
   * @returns {Promise<void>}
   */
  async close(reason) {
    if (this.#closed) return;
    this.#closed = true;
    this.#inbound.close(reason);
    this.#outbound.close(reason);
  }

  /** Whether this socket has been closed. */
  get closed() { return this.#closed; }

  /** Why the socket was closed (by either side, or by a limit), or `null`. */
  get closeReason() { return this.#inbound.closeReason ?? this.#outbound.closeReason; }

  /** Bytes queued for this socket to read. */
  get bufferedInbound() { return this.#inbound.bytes; }

  /** Bytes this socket has written that the peer has not read yet. */
  get bufferedOutbound() { return this.#outbound.bytes; }

  /**
   * Create a connected pair of StreamSockets suitable for in-memory (loopback)
   * communication. Data written to one socket can be read from the other, and
   * vice versa.
   *
   * @param {Object} [opts={}]
   * @param {number} [opts.highWaterMark=1024] - Maximum queue depth (chunks) per buffer
   *   before the socket is closed to prevent unbounded memory growth. Set to
   *   `0` for unlimited (not recommended for production use).
   * @param {number} [opts.highWaterBytes=1048576] - A write waits while this many bytes are queued unread (per direction). `0`: never wait.
   * @param {number} [opts.lowWaterBytes=highWaterBytes/4] - Waiting writes continue at or below this. Must be below `highWaterBytes`.
   * @param {number} [opts.maxBufferedBytes=4194304] - Hard cap; exceeding it closes the socket with a reason. `0`: none.
   * @returns {[StreamSocket, StreamSocket]} A two-element array `[socketA, socketB]`
   *   where writing to `socketA` delivers to `socketB.read()`, and vice versa.
   */
  static createPair({
    highWaterMark = 1024,
    highWaterBytes = STREAM_DEFAULTS.highWaterBytes,
    lowWaterBytes = Math.floor(highWaterBytes / 4),
    maxBufferedBytes = Math.max(STREAM_DEFAULTS.maxBufferedBytes, highWaterBytes * 4),
  } = {}) {
    if (highWaterBytes > 0 && lowWaterBytes >= highWaterBytes) {
      throw new RangeError('lowWaterBytes must be below highWaterBytes');
    }
    const limits = { highWaterMark, highWaterBytes, lowWaterBytes, maxBufferedBytes };
    const bufA = new AsyncBuffer(limits);
    const bufB = new AsyncBuffer(limits);
    const socketA = new StreamSocket({ inbound: bufB, outbound: bufA });
    const socketB = new StreamSocket({ inbound: bufA, outbound: bufB });
    return [socketA, socketB];
  }
}
