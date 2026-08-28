/**
 * Signal — cancellation and shutdown via AbortController.
 *
 * Provides named signals (TERM, INT, HUP) with AbortSignal integration
 * for cooperative cancellation of long-running operations.
 *
 * @module signal
 */

/**
 * Signal name constants.
 */
export const SIGNAL = Object.freeze({
  TERM: 'TERM',
  INT: 'INT',
  HUP: 'HUP',
});

/**
 * Signal controller providing named signal dispatch and AbortSignal integration.
 */
export class SignalController {
  #controllers = new Map();
  #listeners = new Map();
  #fired = new Set();

  /**
   * Fire a named signal. All registered callbacks and AbortSignals for
   * this signal name are triggered.
   *
   * @param {string} name - Signal name (e.g. SIGNAL.TERM).
   */
  signal(name) {
    this.#fired.add(name);

    // Fire listeners
    const cbs = this.#listeners.get(name);
    if (cbs) {
      for (const cb of [...cbs]) {
        try { cb(); } catch (_) {}
      }
    }

    // Abort the associated controller
    const ctrl = this.#controllers.get(name);
    if (ctrl && !ctrl.signal.aborted) {
      ctrl.abort();
    }
  }

  /**
   * Register a callback for a named signal.
   *
   * @param {string} name - Signal name.
   * @param {function(): void} cb - Callback.
   * @returns {function(): void} Unsubscribe function.
   */
  onSignal(name, cb) {
    if (!this.#listeners.has(name)) {
      this.#listeners.set(name, []);
    }
    this.#listeners.get(name).push(cb);
    return () => {
      const arr = this.#listeners.get(name);
      if (!arr) return;
      const idx = arr.indexOf(cb);
      if (idx >= 0) arr.splice(idx, 1);
    };
  }

  /**
   * Get an AbortSignal that aborts when the named signal fires.
   *
   * @param {string} name - Signal name.
   * @returns {AbortSignal}
   */
  abortSignal(name) {
    if (!this.#controllers.has(name)) {
      this.#controllers.set(name, new AbortController());
    }
    const ctrl = this.#controllers.get(name);
    // If already fired, abort immediately
    if (this.#fired.has(name) && !ctrl.signal.aborted) {
      ctrl.abort();
    }
    return ctrl.signal;
  }

  /**
   * Check whether a signal has been fired.
   *
   * @param {string} name - Signal name.
   * @returns {boolean}
   */
  hasFired(name) {
    return this.#fired.has(name);
  }

  /**
   * Reset a signal so it can be fired again.
   *
   * @param {string} name - Signal name.
   */
  reset(name) {
    this.#fired.delete(name);
    // Replace the AbortController so a fresh signal can be obtained
    this.#controllers.delete(name);
  }

  /**
   * Get a composite AbortSignal that aborts on either TERM or INT.
   * Useful for graceful shutdown scenarios.
   *
   * @returns {AbortSignal}
   */
  get shutdownSignal() {
    return AbortSignal.any([
      this.abortSignal(SIGNAL.TERM),
      this.abortSignal(SIGNAL.INT),
    ]);
  }
}
