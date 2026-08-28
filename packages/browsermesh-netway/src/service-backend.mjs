/**
 * ServiceBackend — svc:// scheme backend using kernel ServiceRegistry.
 *
 * Routes connections to named services by looking them up in the kernel's
 * ServiceRegistry. When a client connects to `svc://name`, the backend
 * creates a StreamSocket pair and enqueues the server-side socket into
 * the service's listener accept queue.
 *
 * @module service-backend
 */

import { Backend } from './backend.mjs';
import { StreamSocket } from './stream-socket.mjs';
import { ConnectionRefusedError } from './errors.mjs';

/**
 * Backend that routes connections to kernel services via ServiceRegistry.
 */
export class ServiceBackend extends Backend {
  #registry;

  /**
   * @param {import('../../kernel/src/service-registry.mjs').ServiceRegistry} registry
   */
  constructor(registry) {
    super();
    this.#registry = registry;
  }

  /**
   * Connect to a named service. The `host` parameter is the service name.
   * Port is ignored for service connections.
   *
   * @param {string} host - Service name (e.g. `'echo'` for `svc://echo`).
   * @param {number} [port] - Ignored.
   * @returns {Promise<StreamSocket>} The client-side socket.
   * @throws {ConnectionRefusedError} If the service is not registered or has no listener.
   */
  async connect(host, port) {
    let entry;
    try {
      entry = await this.#registry.lookup(host);
    } catch {
      throw new ConnectionRefusedError(`svc://${host}`);
    }

    if (!entry.listener) {
      throw new ConnectionRefusedError(`svc://${host}`);
    }

    const [clientSocket, serverSocket] = StreamSocket.createPair();

    // If the listener has an accept queue (Listener interface), enqueue
    if (typeof entry.listener.enqueue === 'function') {
      entry.listener.enqueue(serverSocket);
    } else if (typeof entry.listener.handleConnection === 'function') {
      // Alternative: callback-based service handler
      entry.listener.handleConnection(serverSocket);
    }

    return clientSocket;
  }
}
