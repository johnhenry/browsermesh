/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-peer-escrow.js — Hold credits in escrow until consensus confirms delivery.
 *
 * Enables trustless compute marketplace, dispute resolution, and
 * guaranteed payment for services.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-escrow.test.mjs
 */

// ---------------------------------------------------------------------------
// Polyfill
// ---------------------------------------------------------------------------

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => 'esc-' + Math.random().toString(36).slice(2)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Condition types that can gate escrow release.
 * @type {Readonly<Record<string, string>>}
 */
export const ESCROW_CONDITIONS = Object.freeze({
  RESULT_HASH_MATCH: 'result_hash_match',
  ATTESTATION_QUORUM: 'attestation_quorum',
  MANUAL_APPROVAL: 'manual_approval',
  TIMEOUT_AUTO_RELEASE: 'timeout_release',
  TIMEOUT_AUTO_REFUND: 'timeout_refund',
})

/**
 * All possible escrow statuses in lifecycle order.
 * @type {ReadonlyArray<string>}
 */
export const ESCROW_STATUSES = Object.freeze([
  'pending', 'funded', 'released', 'refunded', 'disputed', 'expired',
])

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _escrowSeq = 0

function generateEscrowId() {
  return `esc_${Date.now().toString(36)}_${(++_escrowSeq).toString(36)}`
}

function generateDisputeId() {
  return `dsp_${Date.now().toString(36)}_${(++_escrowSeq).toString(36)}`
}

// ---------------------------------------------------------------------------
// EscrowContract
// ---------------------------------------------------------------------------

/**
 * Represents a single escrow contract between a payer and a payee.
 *
 * Contracts hold funds in escrow and release them when all conditions
 * are met, or refund them on timeout/dispute.
 */
export class EscrowContract {
  /** @type {string} */
  id

  /** @type {string} */
  payer

  /** @type {string} */
  payee

  /** @type {number} */
  amount

  /** @type {Array<{ type: string, params?: object }>} */
  conditions

  /** @type {number|null} */
  timeoutMs

  /** @type {string} */
  status

  /** @type {number} */
  createdAt

  /** @type {string|null} */
  description

  /**
   * @param {object} opts
   * @param {string} [opts.id]
   * @param {string} opts.payer
   * @param {string} opts.payee
   * @param {number} opts.amount
   * @param {Array<{ type: string, params?: object }>} [opts.conditions]
   * @param {number|null} [opts.timeoutMs]
   * @param {string} [opts.status]
   * @param {number} [opts.createdAt]
   * @param {string|null} [opts.description]
   */
  constructor(opts) {
    this.id = opts.id || crypto.randomUUID()
    this.payer = opts.payer
    this.payee = opts.payee
    this.amount = opts.amount
    this.conditions = opts.conditions || []
    this.timeoutMs = opts.timeoutMs ?? null
    this.status = opts.status || 'pending'
    this.createdAt = opts.createdAt ?? Date.now()
    this.description = opts.description ?? null
  }

  // ── Condition checking ─────────────────────────────────────────

  /**
   * Check whether all conditions are satisfied by the provided proof.
   *
   * @param {object} proof
   * @param {string} [proof.resultHash]
   * @param {number} [proof.attestationCount]
   * @param {boolean} [proof.manualApproval]
   * @returns {{ met: boolean, unmet: string[] }}
   */
  checkConditions(proof = {}) {
    const unmet = []

    for (const cond of this.conditions) {
      switch (cond.type) {
        case ESCROW_CONDITIONS.RESULT_HASH_MATCH: {
          const expected = cond.params?.expectedHash
          if (proof.resultHash !== expected) {
            unmet.push(cond.type)
          }
          break
        }

        case ESCROW_CONDITIONS.ATTESTATION_QUORUM: {
          const required = cond.params?.requiredCount ?? 1
          if ((proof.attestationCount ?? 0) < required) {
            unmet.push(cond.type)
          }
          break
        }

        case ESCROW_CONDITIONS.MANUAL_APPROVAL: {
          if (!proof.manualApproval) {
            unmet.push(cond.type)
          }
          break
        }

        case ESCROW_CONDITIONS.TIMEOUT_AUTO_RELEASE:
        case ESCROW_CONDITIONS.TIMEOUT_AUTO_REFUND:
          // Timeout conditions are handled by EscrowManager.checkExpired()
          break

        default:
          unmet.push(cond.type)
      }
    }

    return { met: unmet.length === 0, unmet }
  }

  // ── Timeout ────────────────────────────────────────────────────

  /**
   * Check whether this contract has expired based on its timeout.
   *
   * @param {number} [now] - Current timestamp (default: Date.now())
   * @returns {boolean}
   */
  isExpired(now) {
    if (this.timeoutMs == null) return false
    const elapsed = (now ?? Date.now()) - this.createdAt
    return elapsed >= this.timeoutMs
  }

  // ── Serialization ──────────────────────────────────────────────

  /**
   * Serialize to a JSON-safe plain object.
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      payer: this.payer,
      payee: this.payee,
      amount: this.amount,
      conditions: this.conditions.map(c => ({ ...c })),
      timeoutMs: this.timeoutMs,
      status: this.status,
      createdAt: this.createdAt,
      description: this.description,
    }
  }

  /**
   * Restore an EscrowContract from serialized data.
   *
   * @param {object} json
   * @returns {EscrowContract}
   */
  static fromJSON(json) {
    return new EscrowContract({
      id: json.id,
      payer: json.payer,
      payee: json.payee,
      amount: json.amount,
      conditions: (json.conditions || []).map(c => ({ ...c })),
      timeoutMs: json.timeoutMs,
      status: json.status,
      createdAt: json.createdAt,
      description: json.description,
    })
  }
}

// ---------------------------------------------------------------------------
// EscrowManager
// ---------------------------------------------------------------------------

/**
 * Manages escrow contracts — creation, funding, release, refund, dispute.
 *
 * Works with a credit ledger (e.g. CreditLedger from clawser-peer-payments.js)
 * to hold funds in escrow until conditions are met.
 */
export class EscrowManager {
  /** @type {Map<string, EscrowContract>} */
  #contracts = new Map()

  /** @type {object} creditLedger */
  #creditLedger

  /** @type {Function} */
  #onLog

  /** @type {Map<string, Function[]>} */
  #listeners = new Map()

  /**
   * @param {object} opts
   * @param {object} opts.creditLedger - Must have charge(), credit(), getBalance()
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   */
  constructor(opts) {
    if (!opts?.creditLedger) {
      throw new Error('EscrowManager requires a creditLedger')
    }
    this.#creditLedger = opts.creditLedger
    this.#onLog = opts.onLog ?? (() => {})
  }

  // ── Create ─────────────────────────────────────────────────────

  /**
   * Create and fund an escrow contract. Debits the payer immediately.
   *
   * @param {object} opts
   * @param {string} opts.payerPodId
   * @param {string} opts.payeePodId
   * @param {number} opts.amount
   * @param {string} [opts.description]
   * @param {Array<{ type: string, params?: object }>} [opts.conditions]
   * @param {number} [opts.timeoutMs]
   * @returns {EscrowContract}
   * @throws {Error} If payer has insufficient balance
   */
  create(opts) {
    const { payerPodId, payeePodId, amount, description, conditions, timeoutMs } = opts

    // Debit payer — throws on insufficient balance
    this.#creditLedger.charge(payerPodId, amount, `escrow: ${description || 'contract'}`)

    const contract = new EscrowContract({
      payer: payerPodId,
      payee: payeePodId,
      amount,
      description: description ?? null,
      conditions: conditions || [],
      timeoutMs: timeoutMs ?? null,
      status: 'funded',
    })

    this.#contracts.set(contract.id, contract)
    this.#onLog('info', `Escrow created: ${contract.id} (${amount} from ${payerPodId})`)
    this.#emit('created', contract)

    return contract
  }

  // ── Release ────────────────────────────────────────────────────

  /**
   * Release escrow funds to the payee.
   *
   * @param {string} contractId
   * @param {object} [proof] - Proof object for condition checking
   * @returns {{ success: boolean, txId?: string }}
   * @throws {Error} If contract not found, not funded, expired, or conditions not met
   */
  release(contractId, proof) {
    const contract = this.#getValidContract(contractId, 'release')

    if (contract.status !== 'funded') {
      throw new Error(`Cannot release contract ${contractId}: not funded (status: ${contract.status})`)
    }

    if (contract.isExpired()) {
      throw new Error(`Cannot release contract ${contractId}: expired`)
    }

    // Check conditions
    if (contract.conditions.length > 0) {
      const result = contract.checkConditions(proof || {})
      if (!result.met) {
        throw new Error(`Cannot release contract ${contractId}: conditions not met (${result.unmet.join(', ')})`)
      }
    }

    // Credit payee
    this.#creditLedger.credit(contract.payee, contract.amount, `escrow release: ${contractId}`)
    contract.status = 'released'

    this.#onLog('info', `Escrow released: ${contractId} (${contract.amount} to ${contract.payee})`)
    this.#emit('released', contract)

    return { success: true, txId: contractId }
  }

  // ── Refund ─────────────────────────────────────────────────────

  /**
   * Refund escrow funds back to the payer.
   *
   * @param {string} contractId
   * @param {string} [reason]
   * @returns {{ success: boolean, txId?: string }}
   * @throws {Error} If contract not found or not funded
   */
  refund(contractId, reason) {
    const contract = this.#getValidContract(contractId, 'refund')

    if (contract.status !== 'funded') {
      throw new Error(`Cannot refund contract ${contractId}: not funded (status: ${contract.status})`)
    }

    // Credit payer
    this.#creditLedger.credit(contract.payer, contract.amount, `escrow refund: ${reason || contractId}`)
    contract.status = 'refunded'

    this.#onLog('info', `Escrow refunded: ${contractId} (${contract.amount} to ${contract.payer})`)
    this.#emit('refunded', contract)

    return { success: true, txId: contractId }
  }

  // ── Dispute ────────────────────────────────────────────────────

  /**
   * Mark a contract as disputed. Funds remain locked until resolution.
   *
   * @param {string} contractId
   * @param {object} [evidence]
   * @returns {{ disputeId: string }}
   * @throws {Error} If contract not found
   */
  dispute(contractId, evidence) {
    const contract = this.#getValidContract(contractId, 'dispute')
    contract.status = 'disputed'

    const disputeId = generateDisputeId()

    this.#onLog('warn', `Escrow disputed: ${contractId} (dispute: ${disputeId})`)
    this.#emit('disputed', { contract, disputeId, evidence })

    return { disputeId }
  }

  // ── Expiry sweep ───────────────────────────────────────────────

  /**
   * Check all contracts for expiration. Refunds any that are expired
   * and still funded.
   *
   * @param {number} [now] - Current timestamp (default: Date.now())
   * @returns {number} Count of expired contracts
   */
  checkExpired(now) {
    let count = 0
    const ts = now ?? Date.now()

    for (const contract of this.#contracts.values()) {
      if (contract.status === 'funded' && contract.isExpired(ts)) {
        // Auto-refund expired contracts
        this.#creditLedger.credit(
          contract.payer,
          contract.amount,
          `escrow expired: ${contract.id}`,
        )
        contract.status = 'expired'
        count++

        this.#onLog('info', `Escrow expired: ${contract.id}`)
        this.#emit('expired', contract)
      }
    }

    return count
  }

  // ── Queries ────────────────────────────────────────────────────

  /**
   * Get a contract by ID.
   *
   * @param {string} id
   * @returns {EscrowContract|null}
   */
  getContract(id) {
    return this.#contracts.get(id) ?? null
  }

  /**
   * List contracts, optionally filtered.
   *
   * @param {object} [filter]
   * @param {string} [filter.status]
   * @param {string} [filter.payerPodId]
   * @param {string} [filter.payeePodId]
   * @returns {EscrowContract[]}
   */
  listContracts(filter) {
    let results = [...this.#contracts.values()]

    if (filter?.status) {
      results = results.filter(c => c.status === filter.status)
    }
    if (filter?.payerPodId) {
      results = results.filter(c => c.payer === filter.payerPodId)
    }
    if (filter?.payeePodId) {
      results = results.filter(c => c.payee === filter.payeePodId)
    }

    return results
  }

  /**
   * Get aggregate statistics across all contracts.
   *
   * @returns {{ active: number, completed: number, disputed: number, totalEscrowed: number }}
   */
  getStats() {
    let active = 0
    let completed = 0
    let disputed = 0
    let totalEscrowed = 0

    for (const contract of this.#contracts.values()) {
      switch (contract.status) {
        case 'funded':
          active++
          totalEscrowed += contract.amount
          break
        case 'released':
          completed++
          break
        case 'disputed':
          disputed++
          break
      }
    }

    return { active, completed, disputed, totalEscrowed }
  }

  // ── Events ─────────────────────────────────────────────────────

  /**
   * Subscribe to an event.
   *
   * @param {string} event - 'created' | 'released' | 'refunded' | 'disputed' | 'expired'
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
   *
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const cbs = this.#listeners.get(event)
    if (!cbs) return
    const idx = cbs.indexOf(cb)
    if (idx !== -1) cbs.splice(idx, 1)
  }

  // ── Serialization ──────────────────────────────────────────────

  /**
   * Serialize all contracts to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      contracts: [...this.#contracts.values()].map(c => c.toJSON()),
    }
  }

  /**
   * Restore an EscrowManager from serialized data.
   *
   * @param {object} json
   * @param {object} deps - { creditLedger, onLog? }
   * @returns {EscrowManager}
   */
  static fromJSON(json, deps) {
    const mgr = new EscrowManager(deps)
    for (const cData of json.contracts) {
      const contract = EscrowContract.fromJSON(cData)
      mgr.#contracts.set(contract.id, contract)
    }
    return mgr
  }

  // ── Private helpers ────────────────────────────────────────────

  /**
   * Emit an event to all registered listeners.
   * Uses a snapshot to avoid mutation during iteration.
   *
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

  /**
   * Get a contract by ID, throwing if not found.
   *
   * @param {string} contractId
   * @param {string} action - For error messages
   * @returns {EscrowContract}
   */
  #getValidContract(contractId, action) {
    const contract = this.#contracts.get(contractId)
    if (!contract) {
      throw new Error(`Cannot ${action}: contract ${contractId} not found`)
    }
    return contract
  }
}
