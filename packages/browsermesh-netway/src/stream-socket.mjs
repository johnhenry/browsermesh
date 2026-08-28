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
 * @module stream-socket
 */

import { SocketClosedError } from './errors.mjs';

/**
 * Simple asynchronous FIFO buffer with blocking pull semantics.
 *
 * Data pushed into the buffer is either delivered immediately to a waiting
 * consumer or queued until a consumer calls {@link AsyncBuffer#pull}. Once
 * closed, all pending and future pulls resolve with `null`.
 *
 * @private
 */
class AsyncBuffer {
  #queue = [];
  #waiters = [];
  #closed = false;
  #highWaterMark;

  /**
   * Create an AsyncBuffer.
   *
   * @param {Object} [opts={}]
   * @param {number} [opts.highWaterMark=0] - Maximum queue depth before the
   *   buffer is closed to prevent unbounded memory growth. `0` means unlimited.
   */
  constructor({ highWaterMark = 0 } = {}) {
    this.#highWaterMark = highWaterMark;
  }

  /**
   * Push data into the buffer. If a consumer is waiting, the data is delivered
   * immediately; otherwise it is enqueued. Pushes on a closed buffer are silently
   * ignored. If the queue exceeds `highWaterMark`, the buffer is closed.
   *
   * @param {Uint8Array} data - The data chunk to enqueue.
   * @returns {boolean} `true` if the data was accepted, `false` if the buffer
   *   was closed (either already closed or due to overflow).
   */
  push(data) {
    if (this.#closed) return false;
    if (this.#waiters.length > 0) {
      this.#waiters.shift()(data);
      return true;
    }
    this.#queue.push(data);
    // Check high-water mark — stop accepting new pushes but keep queue
    // intact so existing data can still be drained by pull().
    if (this.#highWaterMark > 0 && this.#queue.length >= this.#highWaterMark) {
      this.#closed = true;
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
    if (this.#queue.length > 0) return Promise.resolve(this.#queue.shift());
    if (this.#closed) return Promise.resolve(null);
    return new Promise(resolve => this.#waiters.push(resolve));
  }

  /**
   * Close the buffer. All currently waiting consumers receive `null`. Any
   * remaining queued data is discarded. Further pushes are silently ignored.
   */
  close() {
    this.#closed = true;
    for (const w of this.#waiters) w(null);
    this.#waiters.length = 0;
    this.#queue.length = 0;
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
   * inbound buffer.
   *
   * @param {Uint8Array} data - The data to send.
   * @throws {SocketClosedError} If the socket has already been closed.
   */
  async write(data) {
    if (this.#closed) throw new SocketClosedError();
    if (!this.#outbound.push(data)) {
      throw new SocketClosedError();
    }
  }

  /**
   * Close the socket, shutting down both directions. Subsequent reads return
   * `null`; subsequent writes throw {@link SocketClosedError}. Calling close on
   * an already-closed socket is a no-op.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#inbound.close();
    this.#outbound.close();
  }

  /** Whether this socket has been closed. */
  get closed() { return this.#closed; }

  /**
   * Create a connected pair of StreamSockets suitable for in-memory (loopback)
   * communication. Data written to one socket can be read from the other, and
   * vice versa.
   *
   * @param {Object} [opts={}]
   * @param {number} [opts.highWaterMark=1024] - Maximum queue depth per buffer
   *   before the socket is closed to prevent unbounded memory growth. Set to
   *   `0` for unlimited (not recommended for production use).
   * @returns {[StreamSocket, StreamSocket]} A two-element array `[socketA, socketB]`
   *   where writing to `socketA` delivers to `socketB.read()`, and vice versa.
   */
  static createPair({ highWaterMark = 1024 } = {}) {
    const bufA = new AsyncBuffer({ highWaterMark });
    const bufB = new AsyncBuffer({ highWaterMark });
    const socketA = new StreamSocket({ inbound: bufB, outbound: bufA });
    const socketB = new StreamSocket({ inbound: bufA, outbound: bufB });
    return [socketA, socketB];
  }
}
