/**
 * RNG — cryptographic and deterministic random number generation.
 *
 * Provides crypto-quality randomness by default, with a seeded mode using
 * xorshift128+ for deterministic replay in tests and chaos engineering.
 *
 * @module rng
 */

/**
 * Random number generator with crypto and seeded modes.
 */
export class RNG {
  #getFn;

  /**
   * @param {Object} [opts={}]
   * @param {function(number): Uint8Array} [opts.getFn] - Custom byte source.
   */
  constructor({ getFn } = {}) {
    this.#getFn = getFn || ((n) => {
      const buf = new Uint8Array(n);
      crypto.getRandomValues(buf);
      return buf;
    });
  }

  /**
   * Get `n` random bytes.
   *
   * @param {number} n - Number of bytes to generate.
   * @returns {Uint8Array} Random bytes.
   */
  get(n) {
    return this.#getFn(n);
  }

  /**
   * Create a deterministic seeded RNG using xorshift128+.
   * The same seed always produces the same sequence of bytes.
   *
   * @param {number} seed - The seed value (integer).
   * @returns {RNG}
   */
  static seeded(seed) {
    // xorshift128+ state
    let s0 = seed >>> 0 || 1;
    let s1 = (seed * 2654435761) >>> 0 || 1;

    function next() {
      let x = s0;
      const y = s1;
      s0 = y;
      x ^= (x << 23) >>> 0;
      x ^= x >>> 17;
      x ^= y;
      x ^= y >>> 26;
      s1 = x >>> 0;
      return (s0 + s1) >>> 0;
    }

    return new RNG({
      getFn(n) {
        const buf = new Uint8Array(n);
        for (let i = 0; i < n; i += 4) {
          const val = next();
          buf[i] = val & 0xff;
          if (i + 1 < n) buf[i + 1] = (val >>> 8) & 0xff;
          if (i + 2 < n) buf[i + 2] = (val >>> 16) & 0xff;
          if (i + 3 < n) buf[i + 3] = (val >>> 24) & 0xff;
        }
        return buf;
      },
    });
  }
}
