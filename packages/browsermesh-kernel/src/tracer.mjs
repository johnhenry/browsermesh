/**
 * Tracer — structured event tracing with ring buffer and async iteration.
 *
 * Events are auto-stamped with ID and timestamp. A ring buffer with
 * evict-half strategy provides smooth degradation when capacity is exceeded.
 * Multiple consumers each get independent AsyncIterables.
 *
 * @module tracer
 */

import { KERNEL_DEFAULTS } from './constants.mjs';

/**
 * Structured event tracer with ring buffer storage and async iteration.
 */
export class Tracer {
  #events = [];
  #counter = 0;
  #capacity;
  #clock;
  #waiters = [];
  #enabled = true;

  /**
   * @param {Object} [opts={}]
   * @param {number} [opts.capacity=1024] - Maximum events in the ring buffer.
   * @param {Object} [opts.clock] - Clock instance with `nowMonotonic()`. Falls back to performance.now().
   */
  constructor({ capacity = KERNEL_DEFAULTS.DEFAULT_TRACER_CAPACITY, clock } = {}) {
    this.#capacity = capacity;
    this.#clock = clock || null;
  }

  /** Whether emit() records events. Toggled via enable()/disable() (e.g. /sys/kernel/trace). */
  get enabled() { return this.#enabled; }

  /** Resume recording trace events. */
  enable() { this.#enabled = true; }

  /** Stop recording trace events. Buffered events remain readable. */
  disable() { this.#enabled = false; }

  /**
   * Emit a trace event. The event is auto-stamped with `id` and `timestamp`.
   * No-op while the tracer is disabled.
   *
   * @param {Object} event - Event data (must include `type` string).
   */
  emit(event) {
    if (!this.#enabled) return;
    const stamped = {
      id: ++this.#counter,
      timestamp: this.#clock ? this.#clock.nowMonotonic() : performance.now(),
      ...event,
    };

    this.#events.push(stamped);

    // Evict-half strategy when at capacity
    if (this.#events.length > this.#capacity) {
      const half = Math.floor(this.#capacity / 2);
      this.#events = this.#events.slice(-half);
    }

    // Notify waiting consumers
    for (const w of this.#waiters) {
      w.resolve(stamped);
    }
    this.#waiters.length = 0;
  }

  /**
   * Get an AsyncIterable of trace events. Each consumer gets an independent
   * iterator that yields events as they are emitted. Does not replay past events.
   *
   * @returns {AsyncIterable<Object>}
   */
  events() {
    const self = this;
    let done = false;

    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise(resolve => {
              self.#waiters.push({
                resolve: (event) => resolve({ value: event, done: false }),
              });
            });
          },
          return() {
            done = true;
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }

  /**
   * Get a snapshot of all currently buffered events.
   *
   * @returns {Object[]} Array of trace events.
   */
  snapshot() {
    return [...this.#events];
  }

  /**
   * Clear all buffered events.
   */
  clear() {
    this.#events.length = 0;
  }
}
