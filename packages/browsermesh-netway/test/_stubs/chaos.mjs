/**
 * ChaosEngine stub — copied from browsermesh-kernel for standalone testing.
 */
export class ChaosEngine {
  #enabled = false;
  #globalConfig = { latencyMs: 0, dropRate: 0, disconnectRate: 0, partitionTargets: [] };
  #scopeConfigs = new Map();
  #rng;
  #clock;

  constructor({ rng, clock } = {}) {
    this.#rng = rng || null;
    this.#clock = clock || null;
  }

  enable() { this.#enabled = true; }
  disable() { this.#enabled = false; }
  get enabled() { return this.#enabled; }

  configure(config) {
    this.#globalConfig = { ...this.#globalConfig, ...config };
  }

  configureScope(scopeId, config) {
    this.#scopeConfigs.set(scopeId, { ...config });
  }

  removeScopeConfig(scopeId) {
    this.#scopeConfigs.delete(scopeId);
  }

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

  shouldDrop(scopeId) {
    if (!this.#enabled) return false;
    const config = this.#getConfig(scopeId);
    if (config.dropRate <= 0) return false;
    return this.#random() < config.dropRate;
  }

  shouldDisconnect(scopeId) {
    if (!this.#enabled) return false;
    const config = this.#getConfig(scopeId);
    if (config.disconnectRate <= 0) return false;
    return this.#random() < config.disconnectRate;
  }

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
