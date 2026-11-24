/**
 * restart-policy.mjs -- the pure half of hosted-pod supervision: whether a
 * podspec's `restart` policy wants an exited pod started again, and how long
 * to wait first. `pod-supervisor.mjs` (timers, audit, re-placement) and
 * `pod-placement.mjs` (`createHostPool().handleExit()`) both decide through
 * these functions, so the two cannot drift.
 *
 * No clock, no timers, no I/O: callers pass the numbers in and schedule the
 * delay themselves.
 */

/** Default `restart.maxRestarts` when a podspec did not say. */
export const DEFAULT_MAX_RESTARTS = 3
/** Default `restart.backoffMs` base. */
export const DEFAULT_BACKOFF_MS = 1000
/** Backoff never waits longer than this, regardless of restart count. */
export const MAX_BACKOFF_MS = 60_000

/**
 * Whether `policy` says to restart a pod that exited with `{code, reason}`.
 * An intentional drain (`reason === 'drained'`) is never a restart
 * candidate under any policy: callers check that before consulting this.
 *
 * @param {'never'|'on-failure'|'always'} policy
 * @param {{code?: number, reason?: string}} exit
 * @returns {boolean}
 */
export function policyWantsRestart(policy, { code, reason } = {}) {
  switch (policy) {
    case 'always':
      return true
    case 'on-failure':
      return code !== 0 || reason === 'crashed' || reason === 'host-lost'
    case 'never':
    default:
      return false
  }
}

/**
 * The wait before restart number `restartsSoFar + 1`: the base doubled per
 * restart already made, capped at {@link MAX_BACKOFF_MS}.
 *
 * @param {number} restartsSoFar - Restarts already performed (0 for the first).
 * @param {number} [baseMs]
 * @returns {number}
 */
export function restartDelayMs(restartsSoFar, baseMs = DEFAULT_BACKOFF_MS) {
  return Math.min(baseMs * (2 ** restartsSoFar), MAX_BACKOFF_MS)
}

/**
 * The full decision for one exit.
 *
 * @param {object} input
 * @param {{policy?: string, maxRestarts?: number, backoffMs?: number}} [input.restart] - A podspec's `restart`.
 * @param {{code?: number, reason?: string}} input.exit
 * @param {number} input.restartsSoFar
 * @returns {{restart: boolean, delayMs?: number, why: 'drained'|'policy'|'gave-up'|'restart'}}
 */
export function decideRestart({ restart = {}, exit = {}, restartsSoFar = 0 } = {}) {
  if (exit.reason === 'drained') return { restart: false, why: 'drained' }
  if (!policyWantsRestart(restart.policy ?? 'never', exit)) return { restart: false, why: 'policy' }
  const maxRestarts = restart.maxRestarts ?? DEFAULT_MAX_RESTARTS
  if (restartsSoFar >= maxRestarts) return { restart: false, why: 'gave-up' }
  return { restart: true, delayMs: restartDelayMs(restartsSoFar, restart.backoffMs ?? DEFAULT_BACKOFF_MS), why: 'restart' }
}
