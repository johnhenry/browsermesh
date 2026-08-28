/**
 * Clock stub — copied from browsermesh-kernel for standalone testing.
 */
export class Clock {
  #monoFn;
  #wallFn;
  #sleepFn;

  constructor({ monoFn, wallFn, sleepFn } = {}) {
    this.#monoFn = monoFn || (() => performance.now());
    this.#wallFn = wallFn || (() => Date.now());
    this.#sleepFn = sleepFn || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  nowMonotonic() { return this.#monoFn(); }
  nowWall() { return this.#wallFn(); }
  async sleep(ms) { return this.#sleepFn(ms); }

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
