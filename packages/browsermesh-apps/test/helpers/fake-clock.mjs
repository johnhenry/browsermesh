/**
 * A clock whose timers fire only when a test advances it: no wall-clock time
 * is involved in anything a test asserts. Pass it as `PeerRegistry`'s `clock`.
 */
export function fakeClock(start = 1_000_000) {
  let t = start
  let seq = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + ms, ms }); return id },
    clearTimeout(id) { timers.delete(id) },
    /** Number of timers armed. */
    get pending() { return timers.size },
    /** Delay (ms) each armed timer was set with. */
    get delays() { return [...timers.values()].map((x) => x.ms) },
    /** Move time forward, firing the timers that fall due, in order. */
    advance(ms) {
      const target = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        t = due[1].at
        timers.delete(due[0])
        due[1].fn()
      }
      t = target
    },
  }
}
