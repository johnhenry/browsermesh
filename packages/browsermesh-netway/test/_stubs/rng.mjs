/**
 * RNG stub — copied from browsermesh-kernel for standalone testing.
 */
export class RNG {
  #getFn;

  constructor({ getFn } = {}) {
    this.#getFn = getFn || ((n) => {
      const buf = new Uint8Array(n);
      crypto.getRandomValues(buf);
      return buf;
    });
  }

  get(n) { return this.#getFn(n); }

  static seeded(seed) {
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
