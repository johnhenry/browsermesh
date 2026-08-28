/**
 * ChaosEngine — fault injection for testing and chaos engineering.
 *
 * Injects configurable latency, packet drops, disconnects, and network
 * partitions. Supports global defaults and per-scope overrides. Uses RNG
 * for deterministic fault patterns in replay mode.
 *
 * @module chaos
 */

/**
 * Fault injection engine with global and per-scope configuration.
 */
export class ChaosEngine {
  #enabled = false;
  #globalConfig = { latencyMs: 0, dropRate: 0, disconnectRate: 0, partitionTargets: [] };
  #scopeConfigs = new Map();
  #rng;
  #clock;

  /**
   * @param {Object} [opts={}]
   * @param {Object} [opts.rng] - RNG instance for deterministic fault patterns.
   * @param {Object} [opts.clock] - Clock instance for delay implementation.
   */
  constructor({ rng, clock } = {}) {
    this.#rng = rng || null;
    this.#clock = clock || null;
  }

  /**
   * Enable the chaos engine. When disabled, all injection points are no-ops.
   */
  enable() {
    this.#enabled = true;
  }

  /**
   * Disable the chaos engine.
   */
  disable() {
    this.#enabled = false;
  }

  /** Whether the engine is enabled. */
  get enabled() { return this.#enabled; }

  /**
   * Configure global fault injection defaults.
   *
   * @param {Object} config
   * @param {number} [config.latencyMs=0] - Added latency in ms.
   * @param {number} [config.dropRate=0] - Drop probability (0-1).
   * @param {number} [config.disconnectRate=0] - Disconnect probability (0-1).
   * @param {string[]} [config.partitionTargets=[]] - Addresses to partition.
   */
  configure(config) {
    this.#globalConfig = { ...this.#globalConfig, ...config };
  }

  /**
   * Configure fault injection for a specific scope (overrides global).
   *
   * @param {string} scopeId - Scope identifier.
   * @param {Object} config - Scope-specific configuration.
   */
  configureScope(scopeId, config) {
    this.#scopeConfigs.set(scopeId, { ...config });
  }

  /**
   * Remove scope-specific configuration, falling back to global defaults.
   *
   * @param {string} scopeId - Scope identifier.
   */
  removeScopeConfig(scopeId) {
    this.#scopeConfigs.delete(scopeId);
  }

  /**
   * Maybe inject latency delay.
   *
   * @param {string} [scopeId] - Optional scope for override lookup.
   * @returns {Promise<void>}
   */
  async maybeDelay(scopeId) {
    if (!this.#enabled) return;
    const config = this.#getConfig(scopeId);
    if (config.latencyMs <= 0) return;
    if (this.#clock) {
      await this.#clock.sleep(config.latencyMs);
    } else {
      await new Promise(resolve => setTimeout(resolve, config.latencyMs));
    }
  }

  /**
   * Check whether a packet/message should be dropped.
   *
   * @param {string} [scopeId] - Optional scope for override lookup.
   * @returns {boolean}
   */
  shouldDrop(scopeId) {
    if (!this.#enabled) return false;
    const config = this.#getConfig(scopeId);
    if (config.dropRate <= 0) return false;
    return this.#random() < config.dropRate;
  }

  /**
   * Check whether a connection should be forcibly disconnected.
   *
   * @param {string} [scopeId] - Optional scope for override lookup.
   * @returns {boolean}
   */
  shouldDisconnect(scopeId) {
    if (!this.#enabled) return false;
    const config = this.#getConfig(scopeId);
    if (config.disconnectRate <= 0) return false;
    return this.#random() < config.disconnectRate;
  }

  /**
   * Check whether an address is partitioned (unreachable).
   *
   * @param {string} addr - Target address.
   * @param {string} [scopeId] - Optional scope for override lookup.
   * @returns {boolean}
   */
  isPartitioned(addr, scopeId) {
    if (!this.#enabled) return false;
    const config = this.#getConfig(scopeId);
    return (config.partitionTargets || []).includes(addr);
  }

  #getConfig(scopeId) {
    if (scopeId && this.#scopeConfigs.has(scopeId)) {
      return this.#scopeConfigs.get(scopeId);
    }
    return this.#globalConfig;
  }

  #random() {
    if (this.#rng) {
      const bytes = this.#rng.get(4);
      const val = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
      return val / 0x100000000;
    }
    return Math.random();
  }
}
