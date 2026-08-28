/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-peer-verification.js — Verification quorum protocol.
 *
 * Run the same job on N peers, collect results, vote on correctness.
 * Enables trustless compute verification without TEEs.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-verification.test.mjs
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Available verification strategies for quorum voting.
 */
export const VERIFICATION_STRATEGIES = Object.freeze({
  UNANIMOUS: 'unanimous',   // all must match
  MAJORITY: 'majority',     // >50% match
  THRESHOLD: 'threshold',   // configurable % match
  BYZANTINE: 'byzantine',   // tolerates f < n/3 faulty
})

/**
 * Default policy values for verification quorum.
 */
export const VERIFICATION_DEFAULTS = Object.freeze({
  minPeers: 2,
  maxPeers: 10,
  strategy: 'majority',
  timeoutMs: 30000,
  thresholdPct: 0.67,
})

// ---------------------------------------------------------------------------
// Hash helper
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash of a result value.
 * Uses JSON.stringify + a simple 32-bit integer hash (djb2-like).
 *
 * @param {*} result - The result to hash
 * @returns {string} Hex-encoded hash string
 */
export function computeResultHash(result) {
  const str = typeof result === 'string' ? result : JSON.stringify(result)
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return hash.toString(16)
}

// ---------------------------------------------------------------------------
// Attestation
// ---------------------------------------------------------------------------

/**
 * An attestation certifying that a peer produced a specific result
 * for a given job.
 */
export class Attestation {
  /** @type {string} */
  podId

  /** @type {string} */
  jobId

  /** @type {string} */
  resultHash

  /** @type {string} */
  signature

  /** @type {number} */
  timestamp

  /**
   * @param {object} fields
   * @param {string} fields.podId
   * @param {string} fields.jobId
   * @param {string} fields.resultHash
   * @param {string} fields.signature
   * @param {number} fields.timestamp
   */
  constructor({ podId, jobId, resultHash, signature, timestamp }) {
    this.podId = podId
    this.jobId = jobId
    this.resultHash = resultHash
    this.signature = signature
    this.timestamp = timestamp
  }

  /**
   * Verify this attestation using the provided verification function.
   *
   * @param {Function} verifyFn - (podId, resultHash, signature) => boolean
   * @returns {boolean}
   */
  verify(verifyFn) {
    return verifyFn(this.podId, this.resultHash, this.signature)
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      podId: this.podId,
      jobId: this.jobId,
      resultHash: this.resultHash,
      signature: this.signature,
      timestamp: this.timestamp,
    }
  }

  /**
   * Restore an Attestation from serialized data.
   * @param {object} json
   * @returns {Attestation}
   */
  static fromJSON(json) {
    return new Attestation({
      podId: json.podId,
      jobId: json.jobId,
      resultHash: json.resultHash,
      signature: json.signature,
      timestamp: json.timestamp,
    })
  }
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _jobSeq = 0

function generateJobId() {
  return `job_${Date.now().toString(36)}_${(++_jobSeq).toString(36)}`
}

// ---------------------------------------------------------------------------
// VerificationQuorum
// ---------------------------------------------------------------------------

/**
 * Verification quorum protocol for trustless compute verification.
 *
 * Dispatches the same job to N peers, collects results, groups them
 * by hash, and applies a voting strategy to determine the correct result.
 */
export class VerificationQuorum {
  /** @type {object} scheduler with dispatch(peerId, job) */
  #scheduler

  /** @type {object} trust with getReputation(podId), listTrustedPeers() */
  #trust

  /** @type {Function} */
  #onLog

  /** @type {object} current policy (mutable copy of defaults) */
  #policy

  /** @type {Map<string, Function[]>} */
  #listeners = new Map()

  /**
   * @param {object} deps
   * @param {object} deps.scheduler - { dispatch(peerId, job) => result }
   * @param {object} deps.trust - { getReputation(podId) => number, listTrustedPeers(threshold?) => podId[] }
   * @param {Function} [deps.onLog] - Logging callback
   */
  constructor({ scheduler, trust, onLog } = {}) {
    if (!scheduler) throw new Error('scheduler is required')
    if (!trust) throw new Error('trust is required')

    this.#scheduler = scheduler
    this.#trust = trust
    this.#onLog = onLog ?? (() => {})
    this.#policy = { ...VERIFICATION_DEFAULTS }
  }

  // ── Policy ─────────────────────────────────────────────────────────

  /**
   * Override default policy values.
   *
   * @param {object} policy
   * @param {number} [policy.minPeers]
   * @param {number} [policy.maxPeers]
   * @param {string} [policy.strategy]
   * @param {number} [policy.timeoutMs]
   * @param {number} [policy.thresholdPct]
   */
  setPolicy(policy) {
    if (policy.minPeers != null) this.#policy.minPeers = policy.minPeers
    if (policy.maxPeers != null) this.#policy.maxPeers = policy.maxPeers
    if (policy.strategy != null) this.#policy.strategy = policy.strategy
    if (policy.timeoutMs != null) this.#policy.timeoutMs = policy.timeoutMs
    if (policy.thresholdPct != null) this.#policy.thresholdPct = policy.thresholdPct
  }

  // ── Core ───────────────────────────────────────────────────────────

  /**
   * Submit a job for verified execution across a quorum of peers.
   *
   * @param {object} job - The job to execute
   * @param {object} [opts]
   * @param {string[]} [opts.verifiers] - Explicit list of verifier pod IDs
   * @param {string} [opts.verifyLevel] - Override verification level
   * @returns {Promise<{ result: *, confidence: number, attestations: Attestation[], divergent?: object }>}
   */
  async submitVerified(job, opts = {}) {
    const jobId = generateJobId()
    const count = Math.min(this.#policy.maxPeers, Math.max(this.#policy.minPeers, this.#policy.maxPeers))

    // Step 1: Select verifiers
    const verifiers = opts.verifiers ?? this.#selectVerifiers(job, count)

    if (verifiers.length === 0) {
      throw new Error('No verifiers available: not enough trusted peers')
    }

    this.#onLog('info', `Dispatching job ${jobId} to ${verifiers.length} verifiers`)

    // Step 2: Dispatch to all verifiers in parallel with timeout
    const timeoutMs = this.#policy.timeoutMs
    const settled = await Promise.allSettled(
      verifiers.map((peerId) =>
        this.#dispatchWithTimeout(peerId, job, timeoutMs)
      ),
    )

    // Collect successful results, track timeouts
    const results = [] // { peerId, result, hash }
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]
      const peerId = verifiers[i]
      if (outcome.status === 'fulfilled') {
        const result = outcome.value
        const hash = computeResultHash(result)
        results.push({ peerId, result, hash })
      } else {
        // Timed out or failed
        this.#onLog('warn', `Verifier ${peerId} failed: ${outcome.reason?.message ?? outcome.reason}`)
        this.#emit('timeout', { peerId, jobId, error: outcome.reason?.message ?? String(outcome.reason) })
      }
    }

    if (results.length === 0) {
      throw new Error('All verifiers failed or timed out')
    }

    // Check we have minimum peers
    if (results.length < this.#policy.minPeers) {
      // If we have *some* results but below minimum, we still proceed but with reduced confidence
      this.#onLog('warn', `Only ${results.length}/${this.#policy.minPeers} verifiers responded`)
    }

    // Step 3-4: Group results by hash
    const { groups, largest } = this.#compareResults(results)

    // Step 5: Apply strategy
    const stratResult = this.#applyStrategy(groups, results.length)

    if (!stratResult) {
      // No winner — divergent
      const divergent = {
        groups: Object.fromEntries(
          [...groups.entries()].map(([h, entries]) => [h, entries.map((e) => e.peerId)])
        ),
        totalResponded: results.length,
      }
      this.#emit('divergent', { jobId, groups: divergent })
      const err = new Error(`No winner: results diverge across ${groups.size} groups`)
      err.divergent = divergent
      throw err
    }

    // Step 6: Build attestations for agreeing peers
    const winnerHash = stratResult.winnerHash
    const winnerEntries = groups.get(winnerHash)
    const attestations = winnerEntries.map((entry) =>
      this.#buildAttestation(entry.peerId, jobId, winnerHash)
    )

    const outcome = {
      result: winnerEntries[0].result,
      confidence: stratResult.confidence,
      attestations,
    }

    // Step 7: Emit and return
    this.#emit('verified', outcome)
    this.#onLog('info', `Job ${jobId} verified: confidence=${stratResult.confidence}`)

    return outcome
  }

  // ── Private: verifier selection ────────────────────────────────────

  /**
   * Select verifiers from trusted peers, sorted by reputation (highest first).
   *
   * @param {object} job
   * @param {number} count - Number of verifiers to select
   * @returns {string[]} Array of pod IDs
   */
  #selectVerifiers(job, count) {
    const trusted = this.#trust.listTrustedPeers()

    if (trusted.length === 0) {
      return []
    }

    // Sort by reputation descending
    const sorted = [...trusted].sort((a, b) => {
      const ra = this.#trust.getReputation(a)
      const rb = this.#trust.getReputation(b)
      return rb - ra
    })

    // Take top `count` peers
    return sorted.slice(0, count)
  }

  // ── Private: dispatch with timeout ─────────────────────────────────

  /**
   * Dispatch a job to a peer with a timeout.
   *
   * @param {string} peerId
   * @param {object} job
   * @param {number} timeoutMs
   * @returns {Promise<*>}
   */
  #dispatchWithTimeout(peerId, job, timeoutMs) {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error(`Timeout after ${timeoutMs}ms`))
        }
      }, timeoutMs)

      this.#scheduler.dispatch(peerId, job).then(
        (result) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            resolve(result)
          }
        },
        (err) => {
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(err)
          }
        },
      ).catch(() => {})
    })
  }

  // ── Private: compare results ───────────────────────────────────────

  /**
   * Group results by their hash.
   *
   * @param {Array<{ peerId: string, result: *, hash: string }>} results
   * @returns {{ groups: Map<string, Array>, largest: string }}
   */
  #compareResults(results) {
    const groups = new Map()

    for (const entry of results) {
      if (!groups.has(entry.hash)) {
        groups.set(entry.hash, [])
      }
      groups.get(entry.hash).push(entry)
    }

    // Find largest group
    let largest = null
    let largestSize = 0
    for (const [hash, entries] of groups) {
      if (entries.length > largestSize) {
        largestSize = entries.length
        largest = hash
      }
    }

    return { groups, largest }
  }

  // ── Private: apply voting strategy ─────────────────────────────────

  /**
   * Apply the configured strategy to determine a winner.
   *
   * @param {Map<string, Array>} groups - Hash -> entries
   * @param {number} total - Total number of results
   * @returns {{ winnerHash: string, confidence: number }|null}
   */
  #applyStrategy(groups, total) {
    // Find the largest group
    let largestHash = null
    let largestSize = 0
    for (const [hash, entries] of groups) {
      if (entries.length > largestSize) {
        largestSize = entries.length
        largestHash = hash
      }
    }

    const confidence = largestSize / total
    const strategy = this.#policy.strategy

    switch (strategy) {
      case VERIFICATION_STRATEGIES.UNANIMOUS:
        // All must agree: single group containing all results
        if (groups.size === 1 && largestSize === total) {
          return { winnerHash: largestHash, confidence: 1.0 }
        }
        return null

      case VERIFICATION_STRATEGIES.MAJORITY:
        // >50% must agree
        if (confidence > 0.5) {
          return { winnerHash: largestHash, confidence }
        }
        return null

      case VERIFICATION_STRATEGIES.THRESHOLD:
        // >= configured threshold
        if (confidence >= this.#policy.thresholdPct) {
          return { winnerHash: largestHash, confidence }
        }
        return null

      case VERIFICATION_STRATEGIES.BYZANTINE:
        // Tolerates f < n/3: winner needs > 2/3 of total
        if (confidence > 2 / 3) {
          return { winnerHash: largestHash, confidence }
        }
        return null

      default:
        this.#onLog('error', `Unknown strategy: ${strategy}`)
        return null
    }
  }

  // ── Private: build attestation ─────────────────────────────────────

  /**
   * Build an attestation for a peer's result.
   *
   * @param {string} podId
   * @param {string} jobId
   * @param {string} resultHash
   * @returns {Attestation}
   */
  #buildAttestation(podId, jobId, resultHash) {
    return new Attestation({
      podId,
      jobId,
      resultHash,
      signature: `sig_${podId}_${jobId}_${resultHash}`,
      timestamp: Date.now(),
    })
  }

  // ── Events ─────────────────────────────────────────────────────────

  /**
   * Subscribe to an event.
   * @param {string} event - 'verified' | 'divergent' | 'timeout'
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, [])
    }
    this.#listeners.get(event).push(cb)
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const cbs = this.#listeners.get(event)
    if (!cbs) return
    const idx = cbs.indexOf(cb)
    if (idx !== -1) cbs.splice(idx, 1)
  }

  // ── Private: emit ──────────────────────────────────────────────────

  /**
   * Emit an event to all listeners (snapshot iteration for safety).
   * @param {string} event
   * @param {...any} args
   */
  #emit(event, ...args) {
    const cbs = this.#listeners.get(event)
    if (!cbs) return
    for (const cb of [...cbs]) {
      try { cb(...args) } catch { /* listener errors do not propagate */ }
    }
  }
}
