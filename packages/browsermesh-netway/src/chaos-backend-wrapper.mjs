/**
 * ChaosBackendWrapper — wraps any Backend with ChaosEngine fault injection.
 *
 * Interposes on connect() and sendDatagram() to inject configurable
 * latency, drops, disconnects, and partitions via the kernel ChaosEngine.
 *
 * @module chaos-backend-wrapper
 */

import { Backend } from './backend.mjs';
import { ConnectionRefusedError } from './errors.mjs';

/**
 * Wraps an inner Backend with chaos fault injection.
 */
export class ChaosBackendWrapper extends Backend {
  #inner;
  #chaos;
  #scopeId;

  /**
   * @param {Backend} inner - The wrapped backend.
   * @param {import('../../kernel/src/chaos.mjs').ChaosEngine} chaos - ChaosEngine instance.
   * @param {string} [scopeId] - Optional scope ID for per-scope chaos config.
   */
  constructor(inner, chaos, scopeId) {
    super();
    this.#inner = inner;
    this.#chaos = chaos;
    this.#scopeId = scopeId;
  }

  /**
   * Connect with fault injection: partition check → delay → drop check → inner connect.
   *
   * @param {string} host
   * @param {number} port
   * @returns {Promise<import('./stream-socket.mjs').StreamSocket>}
   */
  async connect(host, port) {
    const addr = `${host}:${port}`;

    // Check partition
    if (this.#chaos.isPartitioned(addr, this.#scopeId)) {
      throw new ConnectionRefusedError(addr);
    }

    // Maybe delay
    await this.#chaos.maybeDelay(this.#scopeId);

    // Check drop
    if (this.#chaos.shouldDrop(this.#scopeId)) {
      throw new ConnectionRefusedError(addr);
    }

    return this.#inner.connect(host, port);
  }

  /**
   * Listen — delegates directly to inner (no fault injection on listen).
   */
  async listen(port) {
    return this.#inner.listen(port);
  }

  /**
   * Send datagram with fault injection: drop check → delay → inner send.
   *
   * @param {string} host
   * @param {number} port
   * @param {Uint8Array} data
   */
  async sendDatagram(host, port, data) {
    if (this.#chaos.shouldDrop(this.#scopeId)) return;
    await this.#chaos.maybeDelay(this.#scopeId);
    return this.#inner.sendDatagram(host, port, data);
  }

  /**
   * Bind datagram — delegates directly to inner.
   */
  async bindDatagram(port) {
    return this.#inner.bindDatagram(port);
  }

  /**
   * Resolve — delegates directly to inner.
   */
  async resolve(name, type) {
    return this.#inner.resolve(name, type);
  }

  /**
   * Close — delegates to inner.
   */
  async close() {
    return this.#inner.close();
  }
}
