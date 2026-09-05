/**
 * Wait for a condition, not for a duration.
 *
 * Every timing assertion in this suite used to sleep a guessed number of
 * milliseconds and then assert. That is flaky by construction: the guess is a
 * bet that a timer chain finishes faster than the sleep, and a loaded CI runner
 * takes that bet. `relay.test.mjs`'s "auto-reconnect fires error after
 * exhausting attempts" lost it — the chain is a 5 ms timer, a 10 ms timer and
 * three connect attempts, comfortably inside its 100 ms sleep on a developer
 * machine and not inside it on CI, where the assertion saw two errors instead
 * of four and reported `expected exhaustion error among: refused / refused`.
 *
 * Polling to a deadline is strictly better in both directions: it returns as
 * soon as the condition holds, so the fast path is faster than any sleep, and
 * it tolerates a slow machine instead of failing on one.
 */

/**
 * Resolve once `predicate()` is truthy. Throws with `label` on timeout.
 *
 * @param {() => unknown} predicate
 * @param {{ timeout?: number, interval?: number, label?: string }} [opts]
 */
export async function waitFor(predicate, { timeout = 2000, interval = 2, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let value;
    try { value = predicate(); } catch { value = false; }
    if (value) return value;
    if (Date.now() >= deadline) {
      // A label may be a thunk so it can report the state at failure time --
      // "among: refused / refused" is the diagnostic; "among: <the array as it
      // was when the test started>" is not.
      const what = typeof label === 'function' ? label() : label;
      throw new Error(`waitFor timed out after ${timeout}ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

/**
 * Wait until a counter stops moving, for asserting that something did NOT keep
 * happening. An upper-bound assertion needs the opposite of `waitFor`: time for
 * the system to misbehave, then a check that it did not. Quiescence is the
 * honest version of "sleep and hope it was long enough" — it still bounds the
 * wait, but it ends early when nothing more is in flight.
 *
 * @param {() => number} sample
 * @param {{ quietFor?: number, timeout?: number }} [opts]
 */
export async function settle(sample, { quietFor = 60, timeout = 2000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = sample();
  let stableSince = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 5));
    const now = sample();
    if (now !== last) { last = now; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= quietFor) return last;
    if (Date.now() >= deadline) return last;
  }
}
