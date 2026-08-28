/**
 * Clock — monotonic and wall-clock time abstraction.
 *
 * Provides both real and deterministic (fixed) clocks. The fixed clock
 * is useful for testing — scheduled job logic becomes unit-testable
 * without real timers.
 *
 * @module clock
 */

/**
 * Clock providing monotonic and wall-clock time plus async sleep.
 */
export class Clock {
  #monoFn;
  #wallFn;
  #sleepFn;

  /**
   * @param {Object} [opts={}]
   * @param {function(): number} [opts.monoFn] - Monotonic time source (ms).
   * @param {function(): number} [opts.wallFn] - Wall-clock time source (ms since epoch).
   * @param {function(number): Promise<void>} [opts.sleepFn] - Async sleep implementation.
   */
  constructor({ monoFn, wallFn, sleepFn } = {}) {
    this.#monoFn = monoFn || (() => performance.now());
    this.#wallFn = wallFn || (() => Date.now());
    this.#sleepFn = sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /**
   * Get the current monotonic time in milliseconds.
   * Monotonic time only moves forward and is not affected by clock adjustments.
   *
   * @returns {number} Monotonic timestamp in milliseconds.
   */
  nowMonotonic() {
    return this.#monoFn();
  }

  /**
   * Get the current wall-clock time in milliseconds since the Unix epoch.
   *
   * @returns {number} Wall-clock timestamp (ms since epoch).
   */
  nowWall() {
    return this.#wallFn();
  }

  /**
   * Sleep for the given number of milliseconds.
   *
   * @param {number} ms - Duration to sleep.
   * @returns {Promise<void>}
   */
  async sleep(ms) {
    return this.#sleepFn(ms);
  }

  /**
   * Create a fixed (deterministic) clock for testing.
   * The clock always returns the same values unless manually advanced.
   *
   * @param {number} mono - Fixed monotonic time value.
   * @param {number} wall - Fixed wall-clock time value.
   * @returns {Clock}
   */
  static fixed(mono, wall) {
    let currentMono = mono;
    let currentWall = wall;
    return new Clock({
      monoFn: () => currentMono,
      wallFn: () => currentWall,
      sleepFn: async (ms) => {
        currentMono += ms;
        currentWall += ms;
      },
    });
  }
}
