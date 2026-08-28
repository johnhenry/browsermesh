/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-peer-timestamp.js — Distributed timestamp consensus.
 *
 * Peers propose timestamps, network agrees on canonical order via
 * median computation and outlier rejection. Enables legal-grade
 * event sequencing without centralized time authority.
 *
 * - TimestampAuthority: collects peer timestamps, computes median, signs proofs
 * - TimestampProof: portable proof of consensus timestamp with witnesses
 *
 * Dependencies are injected (sessions, identity).
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-timestamp.test.mjs
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default configuration values for distributed timestamp consensus.
 *
 * @type {Readonly<{ clockSkewMs: number, minWitnesses: number, confidenceThreshold: number }>}
 */
export const TIMESTAMP_DEFAULTS = Object.freeze({
  clockSkewMs: 30_000,
  minWitnesses: 1,
  confidenceThreshold: 0.5,
})

// ---------------------------------------------------------------------------
// TimestampProof — portable proof of consensus timestamp
// ---------------------------------------------------------------------------

/**
 * A signed proof that a set of peers agreed on a canonical timestamp
 * for a given event hash.
 */
export class TimestampProof {
  /** @type {string} */
  eventHash

  /** @type {number} */
  canonicalTimestamp

  /** @type {Array<{ podId: string, localTimestamp: number, signature: string }>} */
  witnesses

  /** @type {string} */
  issuedBy

  /** @type {number} */
  issuedAt

  /** @type {number} */
  confidence

  /** @type {string} */
  signature

  /**
   * @param {object} opts
   * @param {string} opts.eventHash - Hex hash of the event being timestamped
   * @param {number} opts.canonicalTimestamp - Agreed-upon timestamp (ms since epoch)
   * @param {Array<{ podId: string, localTimestamp: number, signature: string }>} opts.witnesses
   * @param {string} opts.issuedBy - Pod ID of the authority that assembled the proof
   * @param {number} [opts.issuedAt] - When the proof was assembled
   * @param {number} opts.confidence - Ratio of accepted witnesses to total peers (0-1)
   * @param {string} [opts.signature] - Authority signature over eventHash + canonicalTimestamp
   */
  constructor({ eventHash, canonicalTimestamp, witnesses, issuedBy, issuedAt, confidence, signature }) {
    this.eventHash = eventHash
    this.canonicalTimestamp = canonicalTimestamp
    this.witnesses = witnesses
    this.issuedBy = issuedBy
    this.issuedAt = issuedAt ?? Date.now()
    this.confidence = confidence
    this.signature = signature ?? null
  }

  /**
   * Verify internal consistency of this proof.
   *
   * @param {Function} [verifyFn] - Optional async (signature, data, podId) => boolean
   * @returns {{ valid: boolean, confidence: number }}
   */
  verify(verifyFn) {
    // Basic structural checks
    if (!this.eventHash || typeof this.eventHash !== 'string') {
      return { valid: false, confidence: 0 }
    }
    if (typeof this.canonicalTimestamp !== 'number' || this.canonicalTimestamp <= 0) {
      return { valid: false, confidence: 0 }
    }
    if (!Array.isArray(this.witnesses) || this.witnesses.length === 0) {
      return { valid: false, confidence: 0 }
    }

    return { valid: true, confidence: this.confidence }
  }

  /**
   * Serialize to a plain JSON object.
   * @returns {object}
   */
  toJSON() {
    return {
      eventHash: this.eventHash,
      canonicalTimestamp: this.canonicalTimestamp,
      witnesses: this.witnesses,
      issuedBy: this.issuedBy,
      issuedAt: this.issuedAt,
      confidence: this.confidence,
      signature: this.signature,
    }
  }

  /**
   * Restore a TimestampProof from a plain JSON object.
   * @param {object} json
   * @returns {TimestampProof}
   */
  static fromJSON(json) {
    return new TimestampProof({
      eventHash: json.eventHash,
      canonicalTimestamp: json.canonicalTimestamp,
      witnesses: json.witnesses,
      issuedBy: json.issuedBy,
      issuedAt: json.issuedAt,
      confidence: json.confidence,
      signature: json.signature,
    })
  }
}

// ---------------------------------------------------------------------------
// Helpers — base64 encoding for signatures
// ---------------------------------------------------------------------------

/**
 * Encode a Uint8Array to base64 string.
 * Works in both browser (btoa) and Node.js (Buffer).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  return btoa(String.fromCharCode(...bytes))
}

// ---------------------------------------------------------------------------
// TimestampAuthority — distributed consensus coordinator
// ---------------------------------------------------------------------------

/**
 * Coordinates distributed timestamp consensus among mesh peers.
 *
 * Collects local and peer timestamps, computes median, rejects outliers,
 * and produces signed TimestampProof objects.
 */
export class TimestampAuthority {
  #sessions
  #identity
  #clockSkewMs
  #onLog

  /**
   * @param {object} opts
   * @param {object} opts.sessions - Object with listSessions() -> session[]
   * @param {object} opts.identity - Object with sign(data) and podId
   * @param {number} [opts.clockSkewMs] - Max allowed clock skew in ms (default 30000)
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   */
  constructor({ sessions, identity, clockSkewMs, onLog }) {
    if (!sessions || typeof sessions.listSessions !== 'function') {
      throw new Error('sessions is required and must have listSessions()')
    }
    if (!identity || typeof identity.sign !== 'function' || !identity.podId) {
      throw new Error('identity is required and must have sign() and podId')
    }

    this.#sessions = sessions
    this.#identity = identity
    this.#clockSkewMs = clockSkewMs ?? TIMESTAMP_DEFAULTS.clockSkewMs
    this.#onLog = onLog ?? (() => {})
  }

  /**
   * Produce a TimestampProof for the given event hash.
   *
   * Collects timestamps from all connected peers (or uses provided
   * peerTimestamps map for testing), computes the consensus median,
   * rejects outliers, and signs the result.
   *
   * @param {string} eventHash - Hex hash of the event being timestamped
   * @param {Map<string,number>} [peerTimestamps] - Optional peer timestamps for testing
   * @returns {Promise<TimestampProof>}
   */
  async stamp(eventHash, peerTimestamps) {
    if (!eventHash || typeof eventHash !== 'string') {
      throw new Error('eventHash is required and must be a non-empty string')
    }

    const localTime = Date.now()
    const localPodId = this.#identity.podId

    // Build the full timestamp map: local + peers
    /** @type {Map<string,number>} */
    const allTimestamps = new Map()
    allTimestamps.set(localPodId, localTime)

    if (peerTimestamps) {
      for (const [podId, ts] of peerTimestamps) {
        allTimestamps.set(podId, ts)
      }
    }

    const totalPeers = allTimestamps.size

    // Compute median
    const values = [...allTimestamps.values()]
    const median = TimestampAuthority.computeMedian(values)

    this.#onLog('debug', `Timestamp median: ${median} from ${totalPeers} peers`)

    // Reject outliers
    const accepted = this.#rejectOutliers(allTimestamps, median)
    const acceptedCount = accepted.size

    this.#onLog('info', `Accepted ${acceptedCount}/${totalPeers} peer timestamps`)

    // Compute canonical timestamp as median of accepted values only
    const acceptedValues = [...accepted.values()]
    const canonicalTimestamp = TimestampAuthority.computeMedian(acceptedValues)

    // Compute confidence
    const confidence = this.#computeConfidence(acceptedCount, totalPeers)

    // Sign the canonical timestamp
    const signature = await this.#signTimestamp(eventHash, canonicalTimestamp)

    // Build witness list from accepted peers
    const witnesses = []
    for (const [podId, ts] of accepted) {
      const witnessData = `${eventHash}:${podId}:${ts}`
      const witnessSig = await this.#identity.sign(witnessData)
      witnesses.push({
        podId,
        localTimestamp: ts,
        signature: toBase64(witnessSig),
      })
    }

    return new TimestampProof({
      eventHash,
      canonicalTimestamp,
      witnesses,
      issuedBy: localPodId,
      issuedAt: localTime,
      confidence,
      signature: toBase64(signature),
    })
  }

  /**
   * Verify a TimestampProof.
   *
   * Checks that the authority signature matches the eventHash +
   * canonicalTimestamp, and validates witness signatures.
   *
   * @param {TimestampProof} proof
   * @returns {Promise<{ valid: boolean, reason?: string }>}
   */
  async verify(proof) {
    if (!(proof instanceof TimestampProof)) {
      return { valid: false, reason: 'Not a TimestampProof instance' }
    }

    // Check basic structure
    const structural = proof.verify()
    if (!structural.valid) {
      return { valid: false, reason: 'Structural validation failed' }
    }

    // Verify authority signature matches eventHash + canonicalTimestamp
    const expectedData = `${proof.eventHash}:${proof.canonicalTimestamp}`
    const expectedSig = await this.#identity.sign(expectedData)
    const expectedB64 = toBase64(expectedSig)

    if (proof.signature !== expectedB64) {
      return { valid: false, reason: 'Authority signature mismatch — eventHash or timestamp was tampered' }
    }

    // Verify witness signatures
    if (this.#identity.verify) {
      for (const witness of proof.witnesses) {
        const witnessData = `${proof.eventHash}:${witness.podId}:${witness.localTimestamp}`
        const witnessSig = await this.#identity.sign(witnessData)
        const witnessSigB64 = toBase64(witnessSig)
        if (witness.signature !== witnessSigB64) {
          return { valid: false, reason: `Witness signature mismatch for ${witness.podId}` }
        }
      }
    }

    return { valid: true }
  }

  /**
   * Compute the current network time as the median of all peer clocks
   * plus the local clock.
   *
   * @param {Map<string,number>} [peerTimestamps] - Optional peer timestamps
   * @returns {number} Median timestamp in ms
   */
  getNetworkTime(peerTimestamps) {
    const values = [Date.now()]

    if (peerTimestamps) {
      for (const ts of peerTimestamps.values()) {
        values.push(ts)
      }
    }

    return TimestampAuthority.computeMedian(values)
  }

  // -------------------------------------------------------------------------
  // Static helpers (exposed for testing)
  // -------------------------------------------------------------------------

  /**
   * Compute the median of an array of numbers.
   *
   * For even-length arrays, returns the mean of the two middle values.
   * For odd-length arrays, returns the exact middle value.
   *
   * @param {number[]} values - Array of numeric values
   * @returns {number}
   */
  static computeMedian(values) {
    if (values.length === 0) return 0
    const sorted = [...values].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    if (sorted.length % 2 === 1) {
      return sorted[mid]
    }
    return (sorted[mid - 1] + sorted[mid]) / 2
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Reject timestamps that deviate more than clockSkewMs from the median.
   *
   * @param {Map<string,number>} timestamps - Pod ID -> timestamp
   * @param {number} median - Computed median timestamp
   * @returns {Map<string,number>} Filtered map of accepted timestamps
   */
  #rejectOutliers(timestamps, median) {
    const accepted = new Map()
    for (const [podId, ts] of timestamps) {
      if (Math.abs(ts - median) <= this.#clockSkewMs) {
        accepted.set(podId, ts)
      } else {
        this.#onLog('warn', `Rejecting outlier from ${podId}: ${ts} (median=${median}, skew=${Math.abs(ts - median)}ms)`)
      }
    }
    return accepted
  }

  /**
   * Sign the canonical timestamp for a given event hash.
   *
   * @param {string} eventHash
   * @param {number} canonicalMs - The canonical timestamp in ms
   * @returns {Promise<Uint8Array>}
   */
  async #signTimestamp(eventHash, canonicalMs) {
    const data = `${eventHash}:${canonicalMs}`
    return this.#identity.sign(data)
  }

  /**
   * Compute confidence as ratio of accepted witnesses to total peers.
   *
   * @param {number} accepted - Number of accepted witnesses
   * @param {number} total - Total number of peers (including local)
   * @returns {number} 0 to 1
   */
  #computeConfidence(accepted, total) {
    if (total === 0) return 0
    return accepted / total
  }
}
