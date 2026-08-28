/**
 * LoopbackBackend — fully in-memory networking backend for `mem://` and `loop://` schemes.
 *
 * All connections, datagrams, and DNS lookups are resolved locally without any
 * I/O. Stream connections are established via {@link StreamSocket.createPair},
 * and datagrams are delivered synchronously to bound sockets. DNS resolution
 * always returns `['127.0.0.1']`.
 *
 * Registered by default in {@link VirtualNetwork} for the `mem` and `loop` schemes.
 *
 * @module loopback-backend
 */

import { Backend } from './backend.mjs';
import { StreamSocket } from './stream-socket.mjs';
import { DatagramSocket } from './datagram-socket.mjs';
import { Listener } from './listener.mjs';
import { ConnectionRefusedError, AddressInUseError } from './errors.mjs';
import { DEFAULTS } from './constants.mjs';

/**
 * In-memory loopback backend. All traffic stays within the same JS runtime.
 *
 * @extends Backend
 */
export class LoopbackBackend extends Backend {
  #listeners = new Map();       // port → Listener
  #datagramSockets = new Map(); // port → DatagramSocket
  #nextEphemeral = DEFAULTS.EPHEMERAL_PORT_START;

  /**
   * Allocate a port from the given registry. When `port` is 0, auto-assigns
   * from the ephemeral range ({@link DEFAULTS.EPHEMERAL_PORT_START} to
   * {@link DEFAULTS.EPHEMERAL_PORT_END}). Wraps around when the range is
   * exhausted.
   *
   * @param {number} port - Requested port, or `0` for auto-assignment.
   * @param {Map} registry - The port registry to check for conflicts.
   * @returns {number} The allocated port number.
   * @throws {AddressInUseError} If the requested port (or all ephemeral ports)
   *   are already in use.
   * @private
   */
  #allocatePort(port, registry) {
    if (port === 0) {
      // Auto-assign from ephemeral range
      const start = this.#nextEphemeral;
      while (registry.has(this.#nextEphemeral)) {
        this.#nextEphemeral++;
        if (this.#nextEphemeral > DEFAULTS.EPHEMERAL_PORT_END) {
          this.#nextEphemeral = DEFAULTS.EPHEMERAL_PORT_START;
        }
        if (this.#nextEphemeral === start) throw new AddressInUseError(0);
      }
      const assigned = this.#nextEphemeral;
      this.#nextEphemeral++;
      if (this.#nextEphemeral > DEFAULTS.EPHEMERAL_PORT_END) {
        this.#nextEphemeral = DEFAULTS.EPHEMERAL_PORT_START;
      }
      return assigned;
    }
    if (registry.has(port)) throw new AddressInUseError(port);
    return port;
  }

  /**
   * Open a stream connection to a local listener. Creates a
   * {@link StreamSocket.createPair|socket pair} and enqueues the server-side
   * socket into the listener's accept queue.
   *
   * @param {string} host - Ignored in loopback (all hosts are local).
   * @param {number} port - The port of the target listener.
   * @returns {Promise<import('./stream-socket.mjs').StreamSocket>} The client-side socket.
   * @throws {ConnectionRefusedError} If no listener is bound on the given port,
   *   or the listener is closed.
   */
  async connect(host, port) {
    const listener = this.#listeners.get(port);
    if (!listener || listener.closed) {
      throw new ConnectionRefusedError(`loop://${host}:${port}`);
    }
    const [clientSocket, serverSocket] = StreamSocket.createPair();
    listener._enqueue(serverSocket);
    return clientSocket;
  }

  /**
   * Start listening for incoming stream connections on a local port.
   *
   * @param {number} port - The port to listen on. Pass `0` for auto-assignment.
   * @returns {Promise<import('./listener.mjs').Listener>} A listener bound to the
   *   actual (possibly auto-assigned) port.
   * @throws {AddressInUseError} If the requested port is already occupied by
   *   another listener.
   */
  async listen(port) {
    const actualPort = this.#allocatePort(port, this.#listeners);
    const listener = new Listener({ localPort: actualPort });
    this.#listeners.set(actualPort, listener);
    listener._setOnClose(() => this._removeListener(actualPort));
    return listener;
  }

  /**
   * Send a datagram to a locally bound datagram socket. If no socket is bound
   * on the target port (or it is closed), the datagram is silently dropped
   * (UDP semantics).
   *
   * The `fromAddress` delivered to the receiver is `"loopback:0"` because the
   * sender port is not tracked in this code path.
   *
   * @param {string} host - Ignored in loopback (all hosts are local).
   * @param {number} port - The target port of the bound datagram socket.
   * @param {Uint8Array} data - The datagram payload.
   * @returns {Promise<void>}
   */
  async sendDatagram(host, port, data) {
    const socket = this.#datagramSockets.get(port);
    if (socket && !socket.closed) {
      // fromAddress is "loopback:0" since the sender port is unknown in this path;
      // for bound sockets sending via bindDatagram→sendFn, the sender address is
      // tracked at a higher level.
      socket._deliver('loopback:0', data);
    }
    // Silently drop if no receiver (UDP semantics)
  }

  /**
   * Bind a datagram socket to a local port to receive incoming datagrams.
   * The returned socket's {@link DatagramSocket#send} method routes datagrams
   * back through this backend's {@link LoopbackBackend#sendDatagram}.
   *
   * @param {number} port - The port to bind. Pass `0` for auto-assignment.
   * @returns {Promise<import('./datagram-socket.mjs').DatagramSocket>} A bound
   *   datagram socket.
   * @throws {AddressInUseError} If the requested port is already occupied by
   *   another datagram socket.
   */
  async bindDatagram(port) {
    const actualPort = this.#allocatePort(port, this.#datagramSockets);
    const socket = new DatagramSocket({
      sendFn: async (address, data) => {
        // Parse target address and route locally
        const [targetHost, targetPortStr] = address.split(':');
        const targetPort = parseInt(targetPortStr, 10);
        await this.sendDatagram(targetHost, targetPort, data);
      },
      localPort: actualPort,
    });
    this.#datagramSockets.set(actualPort, socket);
    socket._setOnClose(() => this._removeDatagramSocket(actualPort));
    return socket;
  }

  /**
   * Resolve a hostname. In the loopback backend, all names resolve to
   * `['127.0.0.1']` regardless of the requested record type.
   *
   * @param {string} name - The hostname (ignored).
   * @param {string} type - The DNS record type (ignored).
   * @returns {Promise<string[]>} Always `['127.0.0.1']`.
   */
  async resolve(name, type) {
    return ['127.0.0.1'];
  }

  /**
   * Close all listeners and datagram sockets, releasing all ports.
   *
   * @returns {Promise<void>}
   */
  async close() {
    for (const listener of this.#listeners.values()) listener.close();
    for (const socket of this.#datagramSockets.values()) socket.close();
    this.#listeners.clear();
    this.#datagramSockets.clear();
  }

  /**
   * Remove a listener from the port registry. Called automatically by the
   * listener's onClose callback when {@link Listener#close} is invoked.
   *
   * @param {number} port - The port to deregister.
   * @private
   */
  _removeListener(port) {
    this.#listeners.delete(port);
  }

  /**
   * Remove a datagram socket from the port registry. Called automatically by
   * the socket's onClose callback when {@link DatagramSocket#close} is invoked.
   *
   * @param {number} port - The port to deregister.
   * @private
   */
  _removeDatagramSocket(port) {
    this.#datagramSockets.delete(port);
  }
}
