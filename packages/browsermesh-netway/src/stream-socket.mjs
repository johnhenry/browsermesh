/**
 * StreamSocket — reliable, ordered byte stream with byte-level backpressure.
 *
 * Provides a TCP-like abstraction where two endpoints exchange `Uint8Array` chunks
 * in order. Uses {@link AsyncBuffer} internally instead of `TransformStream` so that
 * both ends can be closed cleanly without dangling readers or writers.
 *
 * ## Backpressure
 *
 * Each direction is one {@link AsyncBuffer}. The RECEIVING end advertises a
 * window (`windowBytes`) on it; the sending end's `write()` resolves only once
 * every byte has been taken into that window, so a reader that does not read
 * stops its writer, and the data held on each side is bounded: at most
 * `windowBytes` unread bytes at the receiver (`readableLength`), and at most
 * the not-yet-accepted remainder of the writes still in flight at the sender
 * (`writableLength`). Reading returns credit and wakes the writer. A chunk
 * larger than the window is delivered in window-sized pieces (views, no copy).
 *
 * ## Compatibility
 *
 * A buffer with no window (`windowBytes: 0`, or a buffer object from before
 * windows existed, which has no `windowBytes` property) is served exactly as
 * before: `write()` returns as soon as the chunk is queued and the buffer
 * closes after `highWaterMark` queued chunks. A sender never waits for credit
 * from a receiver that did not advertise a window, and a windowed receiver
 * tolerates a sender that ignores credit (it just falls back to the chunk cap).
 *
 * Typical usage: call {@link StreamSocket.createPair} to get two connected sockets,
 * or receive one from {@link Listener#accept} / {@link Backend#connect}.
 *
 * @module stream-socket
 */

import { SocketClosedError } from './errors.mjs';

/** Default per-direction receive window, in bytes. */
export const DEFAULT_WINDOW_BYTES = 256 * 1024;

/**
 * Asynchronous FIFO buffer with blocking pull semantics and an optional byte
 * window. One buffer carries one direction of a socket pair.
 *
 * Writer side: {@link AsyncBuffer#put} (credit-aware) or the legacy
 * {@link AsyncBuffer#push}; {@link AsyncBuffer#end} signals EOF after the
 * queued data. Reader side: {@link AsyncBuffer#pull}; {@link AsyncBuffer#cancel}
 * says no more data is wanted. {@link AsyncBuffer#destroy} aborts both with an
 * error.
 *
 * @private
 */
export class AsyncBuffer {
  #queue = [];
  #bytes = 0;
  #readers = [];
  #spaceWaiters = [];
  #ended = false;
  #cancelled = false;
  #error = null;
  #highWaterMark;
  #windowBytes;

  /**
   * @param {Object} [opts={}]
   * @param {number} [opts.highWaterMark=0] - Maximum queued chunks. Unwindowed:
   *   the buffer closes when reached (legacy). Windowed: writers wait instead.
   *   `0` means unlimited.
   * @param {number} [opts.windowBytes=0] - Receive window in bytes; `0` means
   *   no window (legacy behavior).
   */
  constructor({ highWaterMark = 0, windowBytes = 0 } = {}) {
    this.#highWaterMark = highWaterMark;
    this.#windowBytes = windowBytes > 0 ? windowBytes : 0;
  }

  /** Receive window advertised to the writer (0 = none). */
  get windowBytes() { return this.#windowBytes; }

  /** Unread bytes currently queued. */
  get bufferedBytes() { return this.#bytes; }

  /** Whether no more data will be accepted (ended, cancelled or destroyed). */
  get isClosed() { return this.#ended || this.#cancelled || this.#error !== null; }

  #wake(list, value) {
    const waiting = list.splice(0);
    for (const w of waiting) w(value);
  }

  /**
   * Legacy push: queue (or hand to a waiting reader) without waiting for
   * credit. Closes the buffer when `highWaterMark` chunks are queued.
   *
   * @param {Uint8Array} data
   * @returns {boolean} `true` if accepted, `false` if closed (or overflowed).
   */
  push(data) {
    if (this.isClosed) return false;
    if (this.#readers.length > 0) {
      this.#readers.shift()({ value: data });
      return true;
    }
    this.#queue.push(data);
    this.#bytes += data.length;
    if (this.#highWaterMark > 0 && this.#queue.length >= this.#highWaterMark) {
      // Stop accepting new pushes but keep the queue so it can still be drained.
      this.#ended = true;
      return false;
    }
    return true;
  }

  /**
   * Credit-aware put: resolves once every byte of `data` is inside the window.
   *
   * @param {Uint8Array} data
   * @param {(n: number) => void} [onAccepted] - Called with the size of each
   *   piece as it is accepted (for the writer's pending-bytes counter).
   * @param {() => boolean} [aborted] - Polled after each wait; true aborts.
   * @returns {Promise<void>}
   * @throws {SocketClosedError} If the buffer closes before all bytes fit.
   */
  async put(data, onAccepted, aborted) {
    let off = 0;
    while (off < data.length) {
      if (this.isClosed || (aborted && aborted())) throw new SocketClosedError();
      const remaining = data.length - off;
      if (this.#readers.length > 0) {
        const n = Math.min(remaining, this.#windowBytes || remaining);
        this.#readers.shift()({ value: data.subarray(off, off + n) });
        off += n;
        onAccepted?.(n);
        continue;
      }
      const room = this.#windowBytes - this.#bytes;
      const chunkRoom = this.#highWaterMark > 0 ? this.#highWaterMark - this.#queue.length : Infinity;
      if (room <= 0 || chunkRoom <= 0) {
        await new Promise((resolve) => this.#spaceWaiters.push(resolve));
        continue;
      }
      const n = Math.min(remaining, room);
      this.#queue.push(n === data.length ? data : data.subarray(off, off + n));
      this.#bytes += n;
      off += n;
      onAccepted?.(n);
    }
  }

  /**
   * Pull the next chunk. Resolves `null` at EOF (after the queue drains), and
   * rejects if the buffer was destroyed with an error.
   *
   * @returns {Promise<Uint8Array|null>}
   */
  pull() {
    if (this.#error) return Promise.reject(this.#error);
    if (this.#queue.length > 0) {
      const item = this.#queue.shift();
      this.#bytes -= item.length;
      this.#wake(this.#spaceWaiters); // credit returned to the writer
      return Promise.resolve(item);
    }
    if (this.isClosed) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.#readers.push((r) => (r.error ? reject(r.error) : resolve(r.value ?? null)));
    });
  }

  /** Writer is done: readers get what is queued, then EOF. */
  end() {
    this.#ended = true;
    this.#wake(this.#readers, { value: null });
    this.#wake(this.#spaceWaiters);
  }

  /** Reader wants no more data: queued data is dropped, writers fail. */
  cancel() {
    this.#cancelled = true;
    this.#queue.length = 0;
    this.#bytes = 0;
    this.#wake(this.#readers, { value: null });
    this.#wake(this.#spaceWaiters);
  }

  /** Abort with an error: queued data is dropped, readers reject with `err`. */
  destroy(err) {
    this.#error = err ?? new SocketClosedError();
    this.#queue.length = 0;
    this.#bytes = 0;
    this.#wake(this.#readers, { error: this.#error });
    this.#wake(this.#spaceWaiters);
  }

  /** Legacy close: both ends of this direction are done; queued data is dropped. */
  close() {
    this.cancel();
  }
}

/**
 * A reliable, ordered, bidirectional byte stream socket.
 *
 * Each socket holds references to two buffers: one for inbound data (data
 * arriving *to* this socket) and one for outbound data (data leaving *from*
 * this socket, which is the peer's inbound buffer).
 *
 * `close()` stops writing (the peer still reads what was already accepted,
 * then sees EOF) and discards this side's unread input. `end()` is the
 * half-close: only the write direction stops. `destroy(err)` aborts both
 * directions and makes the peer's pending and next reads reject with `err`.
 */
export class StreamSocket {
  #inbound;   // data coming TO this socket
  #outbound;  // data going FROM this socket (peer's inbound)
  #closed = false;
  #writeEnded = false;
  #writeTail = Promise.resolve();
  #pendingWriteBytes = 0;
  #readable = null;
  #writable = null;

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
   * Returns `null` at EOF (the peer closed or ended and everything it sent has
   * been read, or this socket is closed). Rejects if the peer destroyed the
   * socket with an error.
   *
   * @returns {Promise<Uint8Array|null>} The next data chunk, or `null` on EOF.
   */
  async read() {
    if (this.#closed) return null;
    return this.#inbound.pull();
  }

  /**
   * Write a chunk of data to the stream. With a windowed peer the promise
   * resolves only once the peer's window has taken every byte (so a peer that
   * does not read eventually stalls its writer); concurrent writes are
   * delivered in call order. Against a peer with no window it resolves as soon
   * as the chunk is queued, as before.
   *
   * @param {Uint8Array} data - The data to send.
   * @throws {SocketClosedError} If the socket is closed or write-ended, or the
   *   peer closes before the bytes are accepted.
   */
  write(data) {
    if (this.#closed || this.#writeEnded) return Promise.reject(new SocketClosedError());
    const out = this.#outbound;
    if (!(out.windowBytes > 0) || typeof out.put !== 'function') {
      // Peer advertised no window: served as before.
      if (!out.push(data)) return Promise.reject(new SocketClosedError());
      return Promise.resolve();
    }
    if (data.length === 0) return Promise.resolve();
    this.#pendingWriteBytes += data.length;
    let accepted = 0;
    const run = async () => {
      try {
        await out.put(data, (n) => { accepted += n; this.#pendingWriteBytes -= n; }, () => this.#closed);
      } finally {
        this.#pendingWriteBytes -= data.length - accepted; // unsent remainder on failure
        accepted = data.length;
      }
    };
    const result = this.#writeTail.then(run);
    this.#writeTail = result.catch(() => {});
    return result;
  }

  /**
   * Half-close: no more writes. Waits for writes already made to be accepted,
   * then the peer reads what was sent and sees EOF. This socket can still read.
   *
   * @returns {Promise<void>}
   */
  async end() {
    if (this.#writeEnded) return;
    this.#writeEnded = true;
    await this.#writeTail;
    this.#endOutbound();
  }

  #endOutbound() {
    if (typeof this.#outbound.end === 'function') this.#outbound.end();
    else this.#outbound.close(); // pre-window buffer: only close() exists
  }

  /**
   * Close the socket. Writes stop (a write still waiting for the peer rejects
   * with {@link SocketClosedError}); what the peer was already given stays
   * readable for it, followed by EOF. This side's unread input is discarded and
   * its reads return `null`. Calling close on a closed socket is a no-op.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#writeEnded = true;
    this.#cancelInbound();
    // Ending the outbound buffer also wakes a writer stuck on credit, which
    // then sees the buffer closed and rejects.
    this.#endOutbound();
  }

  #cancelInbound() {
    if (typeof this.#inbound.cancel === 'function') this.#inbound.cancel();
    else this.#inbound.close();
  }

  /**
   * Abort both directions. This side's reads return `null`; the peer's pending
   * and later reads reject with `err`, and its writes fail with
   * {@link SocketClosedError}.
   *
   * @param {Error} [err]
   */
  destroy(err) {
    if (this.#closed) return;
    this.#closed = true;
    this.#writeEnded = true;
    this.#cancelInbound();
    if (typeof this.#outbound.destroy === 'function') this.#outbound.destroy(err);
    else this.#outbound.close();
  }

  /** Whether this socket has been closed. */
  get closed() { return this.#closed; }

  /** The receive window this socket advertises to its writer, in bytes (0 = none). */
  get windowBytes() { return this.#inbound.windowBytes ?? 0; }

  /** The window the peer advertises to this socket's writes, in bytes (0 = none). */
  get peerWindowBytes() { return this.#outbound.windowBytes ?? 0; }

  /** Unread bytes buffered for this socket's reader. Never exceeds `windowBytes` when a window is set. */
  get readableLength() { return this.#inbound.bufferedBytes ?? 0; }

  /** Bytes from `write()` calls that the peer has not yet taken into its window. */
  get writableLength() { return this.#pendingWriteBytes; }

  /** A Web `ReadableStream` view (pulled one chunk at a time, so it honours backpressure). */
  get readable() {
    return this.#readable ??= new ReadableStream({
      pull: async (controller) => {
        const chunk = await this.read();
        if (chunk === null) controller.close();
        else controller.enqueue(chunk);
      },
      cancel: () => this.close(),
    }, { highWaterMark: 0 });
  }

  /** A Web `WritableStream` view; `close()` is a half-close and `abort(err)` destroys. */
  get writable() {
    return this.#writable ??= new WritableStream({
      write: (chunk) => this.write(chunk),
      close: () => this.end(),
      abort: (err) => this.destroy(err instanceof Error ? err : undefined),
    });
  }

  /**
   * Create a connected pair of StreamSockets suitable for in-memory (loopback)
   * communication. Data written to one socket can be read from the other, and
   * vice versa.
   *
   * @param {Object} [opts={}]
   * @param {number} [opts.highWaterMark=1024] - Maximum queued chunks per
   *   direction. Windowed directions make the writer wait at this depth; an
   *   unwindowed direction closes instead (as before). `0` is unlimited.
   * @param {number|[number, number]} [opts.windowBytes=DEFAULT_WINDOW_BYTES] -
   *   The receive window of `[socketA, socketB]` (a single number applies to
   *   both). `0` gives that socket no window, which is how a peer that cannot
   *   send credit back (for example one fed from a wire with no flow control)
   *   is served exactly as before.
   * @returns {[StreamSocket, StreamSocket]} A two-element array `[socketA, socketB]`
   *   where writing to `socketA` delivers to `socketB.read()`, and vice versa.
   */
  static createPair({ highWaterMark = 1024, windowBytes = DEFAULT_WINDOW_BYTES } = {}) {
    const [winA, winB] = Array.isArray(windowBytes) ? windowBytes : [windowBytes, windowBytes];
    const bufA = new AsyncBuffer({ highWaterMark, windowBytes: winB }); // A -> B, B's window
    const bufB = new AsyncBuffer({ highWaterMark, windowBytes: winA }); // B -> A, A's window
    const socketA = new StreamSocket({ inbound: bufB, outbound: bufA });
    const socketB = new StreamSocket({ inbound: bufA, outbound: bufB });
    return [socketA, socketB];
  }
}
