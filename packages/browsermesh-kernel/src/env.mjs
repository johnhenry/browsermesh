/**
 * Environment — per-tenant immutable key-value environment.
 *
 * Once constructed, the environment is frozen and cannot be modified.
 * Provides a read-only interface similar to process.env.
 *
 * @module env
 */

/**
 * Immutable environment variable store.
 */
export class Environment {
  #vars;

  /**
   * @param {Record<string, string>} [vars={}] - Initial environment variables.
   */
  constructor(vars = {}) {
    this.#vars = Object.freeze({ ...vars });
  }

  /**
   * Get an environment variable by key.
   *
   * @param {string} key - Variable name.
   * @returns {string|undefined} The value, or undefined if not set.
   */
  get(key) {
    return this.#vars[key];
  }

  /**
   * Check whether an environment variable exists.
   *
   * @param {string} key - Variable name.
   * @returns {boolean}
   */
  has(key) {
    return key in this.#vars;
  }

  /**
   * Get a frozen copy of all environment variables.
   *
   * @returns {Readonly<Record<string, string>>}
   */
  all() {
    return this.#vars;
  }

  /** Number of environment variables. */
  get size() {
    return Object.keys(this.#vars).length;
  }
}
