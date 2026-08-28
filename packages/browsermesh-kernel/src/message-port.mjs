/**
 * KernelMessagePort — structured IPC with FIFO ordering.
 *
 * Provides in-memory message passing between kernel components. Messages are
 * dispatched asynchronously via queueMicrotask for same-realm FIFO delivery.
 *
 * @module message-port
 */

import { StreamClosedError } from './errors.mjs';

/**
 * A message endpoint. Part of a channel pair created by {@link createChannel}.
 * Posting to one port delivers to the peer's listeners in FIFO order.
 */
export class KernelMessagePort {
  #listeners = [];
  #closed = false;
  #peer = null;

  /**
   * @param {KernelMessagePort} [peer] - The peer port (set internally by createChannel).
   * @private
   */
  _setPeer(peer) {
    this.#peer = peer;
  }

  /**
   * Post a structured message. Delivered to the **peer** port's listeners.
   *
   * @param {*} msg - The message payload.
   * @param {Array} [transfers] - Optional transferable objects.
   * @throws {StreamClosedError} If this port has been closed.
   */
  post(msg, transfers) {
    if (this.#closed) throw new StreamClosedError();
    if (!this.#peer || this.#peer.closed) return;
    this.#peer._deliver(msg, transfers);
  }

  /**
   * Deliver a message to this port's listeners (called by peer).
   * @private
   */
  _deliver(msg, transfers) {
    const snapshot = [...this.#listeners];
    queueMicrotask(() => {
      for (const cb of snapshot) {
        try { cb(msg, transfers); } catch (_) {}
      }
    });
  }

  /**
   * Register a callback to receive messages.
   *
   * @param {function(*, Array=): void} cb - Message handler.
   * @returns {function(): void} Unsubscribe function.
   */
  onMessage(cb) {
    this.#listeners.push(cb);
    return () => {
      const idx = this.#listeners.indexOf(cb);
      if (idx >= 0) this.#listeners.splice(idx, 1);
    };
  }

  /**
   * Close the port. Subsequent `post` calls throw StreamClosedError.
   */
  close() {
    this.#closed = true;
    this.#listeners.length = 0;
  }

  /** Whether this port has been closed. */
  get closed() { return this.#closed; }
}

/**
 * Create a connected pair of KernelMessagePorts.
 * Posting to portA delivers to portB's listeners, and vice versa.
 *
 * @returns {[KernelMessagePort, KernelMessagePort]}
 */
export function createChannel() {
  const portA = new KernelMessagePort();
  const portB = new KernelMessagePort();
  portA._setPeer(portB);
  portB._setPeer(portA);
  return [portA, portB];
}
