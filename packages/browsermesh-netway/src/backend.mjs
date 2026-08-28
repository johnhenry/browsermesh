/**
 * Backend — abstract base class for network backends.
 *
 * Subclasses implement the five core networking primitives: stream connect,
 * stream listen, datagram send, datagram bind, and DNS resolve. The
 * {@link Router} dispatches operations to the appropriate backend based on the
 * address scheme.
 *
 * Concrete implementations include {@link LoopbackBackend} (in-memory) and
 * {@link GatewayBackend} (proxied through a wsh server).
 *
 * @abstract
 * @module backend
 */

export class Backend {
  /**
   * Open a stream (TCP-like) connection to the given host and port.
   *
   * @abstract
   * @param {string} host - The target hostname or IP address.
   * @param {number} port - The target port number.
   * @returns {Promise<import('./stream-socket.mjs').StreamSocket>} A connected stream socket.
   * @throws {ConnectionRefusedError} If the connection is refused by the target.
   * @throws {Error} If the backend does not implement this method.
   */
  async connect(host, port) {
    throw new Error('Backend.connect() not implemented');
  }

  /**
   * Start listening for incoming stream connections on the given port.
   *
   * @abstract
   * @param {number} port - The port to listen on. Pass `0` for auto-assignment
   *   from the ephemeral port range.
   * @returns {Promise<import('./listener.mjs').Listener>} A listener that accepts
   *   incoming connections.
   * @throws {AddressInUseError} If the requested port is already bound.
   * @throws {Error} If the backend does not implement this method.
   */
  async listen(port) {
    throw new Error('Backend.listen() not implemented');
  }

  /**
   * Send a single datagram (UDP-like) to the given host and port.
   *
   * @abstract
   * @param {string} host - The target hostname or IP address.
   * @param {number} port - The target port number.
   * @param {Uint8Array} data - The datagram payload.
   * @returns {Promise<void>}
   * @throws {Error} If the backend does not implement this method.
   */
  async sendDatagram(host, port, data) {
    throw new Error('Backend.sendDatagram() not implemented');
  }

  /**
   * Bind a datagram socket to receive incoming datagrams on the given port.
   *
   * @abstract
   * @param {number} port - The port to bind. Pass `0` for auto-assignment
   *   from the ephemeral port range.
   * @returns {Promise<import('./datagram-socket.mjs').DatagramSocket>} A bound
   *   datagram socket.
   * @throws {AddressInUseError} If the requested port is already bound.
   * @throws {Error} If the backend does not implement this method.
   */
  async bindDatagram(port) {
    throw new Error('Backend.bindDatagram() not implemented');
  }

  /**
   * Resolve a hostname to one or more addresses.
   *
   * @abstract
   * @param {string} name - The hostname to resolve.
   * @param {string} type - DNS record type (e.g. `'A'`, `'AAAA'`).
   * @returns {Promise<string[]>} An array of resolved address strings.
   * @throws {Error} If the backend does not implement this method.
   */
  async resolve(name, type) {
    throw new Error('Backend.resolve() not implemented');
  }

  /**
   * Gracefully shut down the backend, closing all active sockets, listeners,
   * and releasing resources. The default implementation is a no-op.
   *
   * @returns {Promise<void>}
   */
  async close() {}
}
