/**
 * serverless-peer-select.mjs -- Phase 5 of the BrowserMesh Serverless plan
 * (`/Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md`):
 * a small, pure "pick a peer for this request" function, extracted from
 * `scheduler.mjs`'s own inlined policy switch (`MeshScheduler#schedule()`,
 * around the `first-fit`/`round-robin`/`load-balanced`/`best-fit` cases).
 *
 * `scheduler.mjs`'s scoring logic is real and correct, but it's inlined
 * inside a private method tightly coupled to that class's async job/
 * queue/retry lifecycle (`ScheduledTask`, `assign()`/`complete()`/
 * `fail()`) -- there's no "just give me a peer for this constraint set"
 * entry point without going through the whole task-submission machinery,
 * which doesn't fit answering an inbound HTTP-shaped request synchronously.
 * This file is that missing standalone entry point, for exactly this
 * narrower need.
 *
 * `best-fit` is deliberately NOT reproduced here: it's about matching a
 * compute job's resource requirements (memory/CPU) against candidate
 * nodes, and has no equivalent concept for "which peer should answer this
 * HTTP GET" -- there is no resource-constraint input to score against.
 *
 * @module serverless-peer-select
 */

/**
 * @typedef {'first-fit'|'round-robin'|'load-balanced'} PeerSelectPolicy
 */

/**
 * @typedef {object} SelectPeerCandidate
 * @property {string} podId
 * @property {number} [load] - lower is preferred under `'load-balanced'`. Treated as `0` when omitted.
 */

/**
 * @param {SelectPeerCandidate[]} candidates - non-empty to get a real pick; an empty array returns `null`.
 * @param {PeerSelectPolicy} [policy='round-robin']
 * @param {{rrIndex?: number}} [state={}] - caller-owned, mutated in place for `'round-robin'`'s cursor. Pass the SAME object back in on every call for a given site to get real round-robin behavior across calls; a fresh `{}` every call degenerates to always picking `candidates[0]`.
 * @returns {string|null} the selected `podId`, or `null` if `candidates` is empty.
 */
export function selectPeer(candidates, policy = 'round-robin', state = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null

  switch (policy) {
    case 'first-fit':
      return candidates[0].podId

    case 'load-balanced': {
      let minLoad = Infinity
      let minPod = candidates[0].podId
      for (const c of candidates) {
        const load = c.load ?? 0
        if (load < minLoad) {
          minLoad = load
          minPod = c.podId
        }
      }
      return minPod
    }

    case 'round-robin':
    default: {
      const index = state.rrIndex ?? 0
      const selected = candidates[index % candidates.length].podId
      state.rrIndex = index + 1
      return selected
    }
  }
}
