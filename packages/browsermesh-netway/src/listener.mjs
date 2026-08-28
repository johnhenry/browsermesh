/**
 * Listener — accepts incoming stream connections from a bounded accept queue.
 *
 * Behaves like a TCP server socket: the backend pushes newly established
 * connections via {@link Listener#_enqueue}, and consumer code pulls them with
 * {@link Listener#accept}. If the queue reaches its maximum size, additional
 * connections are silently dropped (TCP backlog semantics).
 *
 * Obtain an instance through {@link Backend#listen} or
 * {@link VirtualNetwork#listen}.
 *
 * @module listener
 */

import { DEFAULTS } from './constants.mjs';

/**
 * A server-side listener that accepts incoming {@link StreamSocket} connections.
 */
export class Listener {
  #queue = [];
  #waiters = [];
  #closed = false;
  #localPort;
  #maxQueueSize;
  #onClose = null;

  /**
   * Create a Listener. Callers typically should not construct this directly;
   * use {@link Backend#listen} instead.
   *
   * @param {Object} opts
   * @param {number} opts.localPort - The port this listener is bound to. May be
   *   updated later via {@link Listener#_setLocalPort} if the backend auto-assigns.
   * @param {number} [opts.maxQueueSize=DEFAULTS.ACCEPT_QUEUE_SIZE] - Maximum number of
   *   pending connections to buffer before dropping new arrivals. Defaults to
   *   {@link DEFAULTS.ACCEPT_QUEUE_SIZE} (128).
   */
  constructor({ localPort, maxQueueSize = DEFAULTS.ACCEPT_QUEUE_SIZE }) {
    this.#localPort = localPort;
    this.#maxQueueSize = maxQueueSize;
  }

  /**
   * Set a cleanup callback invoked when the listener closes. Used internally by
   * backends to deregister the listener from port maps.
   *
   * @param {function(): void} fn - Cleanup callback.
   * @private
   */
  _setOnClose(fn) { this.#onClose = fn; }

  /** The local port number this listener is bound to. */
  get localPort() { return this.#localPort; }

  /** Whether this listener has been closed. */
  get closed() { return this.#closed; }

  /**
   * Wait for and return the next incoming connection. If a connection is already
   * queued, resolves immediately. If the listener is closed (or closes while
   * waiting), resolves with `null`.
   *
   * @returns {Promise<import('./stream-socket.mjs').StreamSocket|null>} The server-side
   *   socket for the accepted connection, or `null` if the listener is closed.
   */
  accept() {
    if (this.#closed) return Promise.resolve(null);
    if (this.#queue.length > 0) {
      return Promise.resolve(this.#queue.shift());
    }
    return new Promise(resolve => {
      this.#waiters.push(resolve);
    });
  }

  /**
   * Update the local port after the server assigns one (e.g. when port 0 was
   * requested and the backend auto-assigned an ephemeral port).
   *
   * @param {number} port - The actual assigned port number.
   * @private
   */
  _setLocalPort(port) { this.#localPort = port; }

  /**
   * Enqueue a newly established connection into the accept queue. If a consumer
   * is already waiting in {@link Listener#accept}, the socket is delivered
   * immediately. If the queue is at capacity, the socket is silently dropped
   * (TCP backlog semantics).
   *
   * @param {import('./stream-socket.mjs').StreamSocket} socket - The server-side
   *   socket for the new connection.
   * @private
   */
  _enqueue(socket) {
    if (this.#closed) return;
    if (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      waiter(socket);
    } else if (this.#queue.length < this.#maxQueueSize) {
      this.#queue.push(socket);
    }
    // Drop if accept queue is full (TCP backlog semantics)
  }

  /**
   * Close the listener. All pending {@link Listener#accept} calls resolve with
   * `null`. The accept queue is cleared and the onClose cleanup callback is
   * invoked to notify the backend. Calling close on an already-closed listener
   * is a no-op.
   */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    // Resolve all pending accept() calls with null
    for (const waiter of this.#waiters) {
      waiter(null);
    }
    this.#waiters.length = 0;
    this.#queue.length = 0;
    // Notify backend for cleanup (e.g. port deregistration)
    this.#onClose?.();
    this.#onClose = null;
  }
}
