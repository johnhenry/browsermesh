/**
 * OperationQueue — bounded FIFO queue for buffering operations while a backend
 * is offline, then draining them sequentially once connectivity is restored.
 *
 * Used by {@link GatewayBackend} to queue connect/listen/resolve operations
 * when the wsh client is not yet authenticated. Each enqueued operation returns
 * a promise that settles when the operation is eventually executed (or times out
 * / is cleared).
 *
 * @module queue
 */

import { QueueFullError } from './errors.mjs';
import { DEFAULTS } from './constants.mjs';

/**
 * A bounded, FIFO operation queue with deferred execution.
 */
export class OperationQueue {
  #queue = [];
  #maxSize;
  #drainTimeoutMs;

  /**
   * Create an OperationQueue.
   *
   * @param {Object} [opts={}]
   * @param {number} [opts.maxSize=DEFAULTS.MAX_QUEUE_SIZE] - Maximum number of
   *   operations the queue will hold. Defaults to {@link DEFAULTS.MAX_QUEUE_SIZE} (256).
   *   Attempts to enqueue beyond this limit throw {@link QueueFullError}.
   * @param {number} [opts.drainTimeoutMs=DEFAULTS.DRAIN_TIMEOUT_MS] - Maximum time
   *   in milliseconds to wait for a single operation to complete during
   *   {@link OperationQueue#drain}. Defaults to {@link DEFAULTS.DRAIN_TIMEOUT_MS}
   *   (10 000 ms). If exceeded, the operation's promise rejects with a timeout error.
   */
  constructor({ maxSize = DEFAULTS.MAX_QUEUE_SIZE, drainTimeoutMs = DEFAULTS.DRAIN_TIMEOUT_MS } = {}) {
    this.#maxSize = maxSize;
    this.#drainTimeoutMs = drainTimeoutMs;
  }

  /** The current number of operations in the queue. */
  get size() { return this.#queue.length; }

  /** The maximum number of operations this queue can hold. */
  get maxSize() { return this.#maxSize; }

  /**
   * Add an operation to the queue. Returns a promise that resolves with the
   * result of executing the operation during a future {@link OperationQueue#drain}
   * call, or rejects if the operation fails, times out, or the queue is cleared.
   *
   * @param {*} operation - Arbitrary operation descriptor (passed through to the
   *   `executeFn` during drain).
   * @returns {Promise<*>} Resolves with the `executeFn` result when drained.
   * @throws {QueueFullError} If the queue has reached its maximum capacity.
   */
  enqueue(operation) {
    if (this.#queue.length >= this.#maxSize) {
      throw new QueueFullError();
    }
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.#queue.push({ operation, resolve, reject });
    return promise;
  }

  /**
   * Drain all queued operations by executing them sequentially (FIFO) through
   * the provided callback. Each operation is raced against a per-operation
   * timeout of {@link OperationQueue#drainTimeoutMs}. The promise returned by
   * {@link OperationQueue#enqueue} settles with the callback's result or the
   * timeout/execution error.
   *
   * @param {function(*): Promise<*>} executeFn - Async callback that receives each
   *   queued operation descriptor and returns a result.
   * @returns {Promise<void>} Resolves when all queued operations have been processed.
   */
  async drain(executeFn) {
    const items = this.#queue.splice(0);
    for (const { operation, resolve, reject } of items) {
      let timerId;
      try {
        const timeoutPromise = new Promise((_, rej) => {
          timerId = setTimeout(() => rej(new Error('Drain timeout')), this.#drainTimeoutMs);
        });
        const result = await Promise.race([executeFn(operation), timeoutPromise]);
        clearTimeout(timerId);
        resolve(result);
      } catch (err) {
        clearTimeout(timerId);
        reject(err);
      }
    }
  }

  /**
   * Discard all queued operations. Each pending operation's promise is rejected
   * with a `'Queue cleared'` error.
   */
  clear() {
    for (const { reject } of this.#queue) {
      reject(new Error('Queue cleared'));
    }
    this.#queue.length = 0;
  }
}
