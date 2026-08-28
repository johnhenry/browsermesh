/**
 * Logger — structured per-module logging with optional Tracer integration.
 *
 * Provides leveled logging (DEBUG, INFO, WARN, ERROR) with module tagging.
 * Optionally pipes entries to a Tracer for unified event streaming.
 *
 * @module logger
 */

import { KERNEL_DEFAULTS } from './constants.mjs';

/**
 * Log level constants.
 */
export const LOG_LEVEL = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
});

/**
 * Structured logger with per-module tagging and async iteration.
 */
export class Logger {
  #entries = [];
  #capacity;
  #tracer;
  #waiters = [];

  /**
   * @param {Object} [opts={}]
   * @param {number} [opts.capacity=1024] - Maximum log entries in buffer.
   * @param {Object} [opts.tracer] - Optional Tracer to pipe log entries to.
   */
  constructor({ capacity = KERNEL_DEFAULTS.DEFAULT_LOGGER_CAPACITY, tracer } = {}) {
    this.#capacity = capacity;
    this.#tracer = tracer || null;
  }

  /**
   * Log a debug message.
   * @param {string} module - Module name.
   * @param {string} message - Log message.
   * @param {Object} [data] - Additional data.
   */
  debug(module, message, data) {
    this.#log(LOG_LEVEL.DEBUG, module, message, data);
  }

  /**
   * Log an info message.
   * @param {string} module - Module name.
   * @param {string} message - Log message.
   * @param {Object} [data] - Additional data.
   */
  info(module, message, data) {
    this.#log(LOG_LEVEL.INFO, module, message, data);
  }

  /**
   * Log a warning message.
   * @param {string} module - Module name.
   * @param {string} message - Log message.
   * @param {Object} [data] - Additional data.
   */
  warn(module, message, data) {
    this.#log(LOG_LEVEL.WARN, module, message, data);
  }

  /**
   * Log an error message.
   * @param {string} module - Module name.
   * @param {string} message - Log message.
   * @param {Object} [data] - Additional data.
   */
  error(module, message, data) {
    this.#log(LOG_LEVEL.ERROR, module, message, data);
  }

  /**
   * Create a scoped logger for a specific module.
   *
   * @param {string} name - Module name.
   * @returns {{ debug, info, warn, error: function(string, Object=): void }}
   */
  forModule(name) {
    return {
      debug: (message, data) => this.debug(name, message, data),
      info: (message, data) => this.info(name, message, data),
      warn: (message, data) => this.warn(name, message, data),
      error: (message, data) => this.error(name, message, data),
    };
  }

  /**
   * Get an AsyncIterable of log entries, optionally filtered.
   *
   * @param {Object} [opts={}]
   * @param {string} [opts.module] - Filter by module name.
   * @param {number} [opts.minLevel] - Minimum log level (LOG_LEVEL constant).
   * @returns {AsyncIterable<Object>}
   */
  entries({ module, minLevel } = {}) {
    const self = this;
    let done = false;

    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (done) return Promise.resolve({ value: undefined, done: true });
            return new Promise(resolve => {
              self.#waiters.push({
                module,
                minLevel,
                resolve: (entry) => resolve({ value: entry, done: false }),
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
   * Get a snapshot of all currently buffered entries.
   *
   * @param {Object} [opts={}]
   * @param {string} [opts.module] - Filter by module.
   * @param {number} [opts.minLevel] - Minimum level.
   * @returns {Object[]}
   */
  snapshot({ module, minLevel } = {}) {
    return this.#entries.filter(e => {
      if (module && e.module !== module) return false;
      if (minLevel != null && e.level < minLevel) return false;
      return true;
    });
  }

  #log(level, module, message, data) {
    const entry = {
      level,
      module,
      message,
      data: data || null,
      timestamp: Date.now(),
    };

    this.#entries.push(entry);

    // Evict-half strategy
    if (this.#entries.length > this.#capacity) {
      const half = Math.floor(this.#capacity / 2);
      this.#entries = this.#entries.slice(-half);
    }

    // Pipe to tracer if available
    if (this.#tracer) {
      this.#tracer.emit({ type: 'log', ...entry });
    }

    // Notify filtered waiters
    const matched = [];
    const remaining = [];
    for (const w of this.#waiters) {
      if (w.module && w.module !== module) { remaining.push(w); continue; }
      if (w.minLevel != null && level < w.minLevel) { remaining.push(w); continue; }
      matched.push(w);
    }
    this.#waiters.length = 0;
    this.#waiters.push(...remaining);
    for (const w of matched) {
      w.resolve(entry);
    }
  }
}
