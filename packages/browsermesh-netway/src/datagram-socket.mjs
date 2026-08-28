/**
 * DatagramSocket — unreliable, message-oriented socket (UDP-like semantics).
 *
 * Unlike {@link StreamSocket}, datagrams are independent messages with no ordering
 * or delivery guarantee. Each socket is bound to a local port and can send
 * datagrams to arbitrary `"host:port"` addresses. Inbound datagrams are delivered
 * via the {@link DatagramSocket#onMessage} callback.
 *
 * Obtain an instance through {@link Backend#bindDatagram} or
 * {@link VirtualNetwork#bindDatagram}.
 *
 * @module datagram-socket
 */

import { SocketClosedError } from './errors.mjs';

/**
 * An unreliable, message-oriented datagram socket.
 *
 * Sending on a closed socket throws {@link SocketClosedError}. Inbound
 * datagrams arriving after close are silently dropped.
 */
export class DatagramSocket {
  #sendFn;
  #onMessage = null;
  #closed = false;
  #localPort;
  #onClose = null;

  /**
   * Create a DatagramSocket. Callers typically should not construct this directly;
   * use {@link Backend#bindDatagram} instead.
   *
   * @param {Object} opts
   * @param {function(string, Uint8Array): Promise<void>} opts.sendFn - Backend-provided function
   *   that transmits a datagram to the given `"host:port"` address.
   * @param {number} opts.localPort - The local port this socket is bound to.
   */
  constructor({ sendFn, localPort }) {
    this.#sendFn = sendFn;
    this.#localPort = localPort;
  }

  /** The local port number this socket is bound to. */
  get localPort() { return this.#localPort; }

  /** Whether this socket has been closed. */
  get closed() { return this.#closed; }

  /**
   * Send a datagram to the specified address.
   *
   * @param {string} address - Target address in `"host:port"` format.
   * @param {Uint8Array} data - The datagram payload.
   * @returns {Promise<void>}
   * @throws {SocketClosedError} If the socket has already been closed.
   */
  async send(address, data) {
    if (this.#closed) throw new SocketClosedError();
    await this.#sendFn(address, data);
  }

  /**
   * Register a callback to receive inbound datagrams.
   *
   * @param {function(string, Uint8Array): void} cb - Called with `(fromAddress, data)` for
   *   each inbound datagram. `fromAddress` is in `"host:port"` format.
   */
  onMessage(cb) {
    this.#onMessage = cb;
  }

  /**
   * Deliver an inbound datagram to this socket. Called internally by the backend.
   * Silently ignored if the socket is closed or no message handler is registered.
   *
   * @param {string} fromAddress - Sender address in `"host:port"` format.
   * @param {Uint8Array} data - The datagram payload.
   * @private
   */
  _deliver(fromAddress, data) {
    if (this.#closed) return;
    this.#onMessage?.(fromAddress, data);
  }

  /**
   * Set a cleanup callback invoked when the socket closes. Used internally by
   * backends to deregister the socket from port maps.
   *
   * @param {function(): void} fn - Cleanup callback.
   * @private
   */
  _setOnClose(fn) { this.#onClose = fn; }

  /**
   * Close the socket. Clears the message handler, invokes the onClose cleanup
   * callback, and prevents further sends. Calling close on an already-closed
   * socket is a no-op.
   */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#onMessage = null;
    this.#onClose?.();
    this.#onClose = null;
  }
}
