/**
 * clawser-peer-escrow.js — Hold credits in escrow until consensus confirms delivery.
 *
 * Enables trustless compute marketplace, dispute resolution, and
 * guaranteed payment for services.
 *
 * `EscrowManager` itself is plain and dependency-injected (`{creditLedger,
 * onLog}`), with no `PeerNode`/mesh-transport awareness of its own -- see
 * `createEscrowService()` below (issue #117, `mesh-service.mjs`'s `MeshService`
 * convention) for the wrapper that wires it onto a real `PeerNode`'s
 * `ctx.sendTo()`/`ctx.onIncomingData()`/`ctx.registry.checkAccess()`.
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

    // Debit payer — throws on insufficient balance. CreditLedger's real
    // signature is debit(amount, toPodId, memo) -- no charge() method
    // exists; amount comes first, not the podId.
    this.#creditLedger.debit(amount, payerPodId, `escrow: ${description || 'contract'}`)

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

    // Credit payee. CreditLedger's real signature is credit(amount,
    // fromPodId, memo) -- amount first, not the podId.
    this.#creditLedger.credit(contract.amount, contract.payee, `escrow release: ${contractId}`)
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

    // Credit payer. Same real signature as release() above: amount first.
    this.#creditLedger.credit(contract.amount, contract.payer, `escrow refund: ${reason || contractId}`)
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
        // Auto-refund expired contracts. Same real signature as release()/
        // refund() above: credit(amount, fromPodId, memo), amount first.
        this.#creditLedger.credit(
          contract.amount,
          contract.payer,
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

// ---------------------------------------------------------------------------
// createEscrowService -- MeshService wiring (issue #117)
// ---------------------------------------------------------------------------

/** Default `envelope.type` used to route escrow request/response envelopes. */
const DEFAULT_ESCROW_ENVELOPE_TYPE = 'escrow'
/** How long `requestCreate()`/`requestRelease()`/`requestRefund()`/`requestDispute()` wait for a response. Mirrors `mesh-rpc.mjs`'s/`peer-routing.mjs`'s own default. */
const DEFAULT_ESCROW_REQUEST_TIMEOUT_MS = 10000

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`) that wires
 * `EscrowManager` onto a real `PeerNode`, so a peer can ask ANOTHER peer's
 * node (the one holding `creditLedger`, e.g. a compute-marketplace hub) to
 * create, release, refund, or dispute an escrow contract.
 *
 * ---------------------------------------------------------------------------
 * AUTHORIZATION MODEL -- read before changing this function. This wraps
 * real credit/payment semantics (`EscrowManager.create()` immediately debits
 * `creditLedger`, `release()`/`refund()`/`expire` immediately credit it) --
 * `EscrowManager` itself has NO caller-identity awareness at all (any code
 * that can call `.release(contractId)` succeeds, full stop), so every
 * security boundary here is added by this wrapper, not inherited.
 *
 * Two entirely separate op classes:
 *
 * 1. LOCAL/ADMIN ops -- `getContract`, `listContracts`, `getStats`,
 *    `checkExpired` -- are NEVER exposed over the wire at all: no
 *    `ctx.onIncomingData()` dispatch branch answers them, and no
 *    `requestX()` client method exists for them either. These are read-only
 *    (or, for `checkExpired`, a maintenance sweep an operator/scheduler runs
 *    locally) and leak contract/ledger details a remote peer has no
 *    inherent right to see (e.g. every contract another peer is party to).
 *    Only reachable via `api.getContract()`/`api.listContracts()`/
 *    `api.getStats()`/`api.checkExpired()`, i.e. in-process code on the node
 *    that owns this service.
 *
 * 2. PEER-INITIATED ops -- `create`, `release`, `refund`, `dispute` -- DO
 *    arrive over the wire (`ctx.onIncomingData(envelopeType, ...)`) and are
 *    real value-transfer/state-transition operations, each individually
 *    authorized:
 *
 *    - `create`: gated by `ctx.registry.checkAccess(fromPubKey, 'escrow', 'create')`
 *      -- a coarse, admin-granted scope (`registry.grantCapabilities(peerPubKey,
 *      ['escrow:create'])`) deciding "is this peer allowed to open escrow
 *      contracts against MY credit ledger at all". `PeerRegistry`/`MeshACL`
 *      default-deny any non-owner peer with no roster entry (see
 *      `MeshACL.check()`), so a peer gets NOTHING here until the node
 *      operator explicitly opts them in -- this is a deliberate, real gate,
 *      not a formality. On top of that ACL gate, the payer identity itself
 *      is NEVER taken from the wire payload: the host always uses
 *      `payerPodId = fromPubKey` (the cryptographically-authenticated sender
 *      of the envelope), so a remote peer can only ever fund a contract with
 *      THEIR OWN balance, never spoof another pod as the payer and drain
 *      someone else's credits. Only `payeePodId`/`amount`/`description`/
 *      `conditions`/`timeoutMs` are taken from the payload.
 *
 *    - `release`/`refund`/`dispute`: gated by
 *      `ctx.registry.checkAccess(fromPubKey, 'escrow:<contractId>', '<op>')`
 *      -- the SAME 3-segment `namespace:resource:action` scope grammar
 *      `mesh-relay-host.mjs` already established
 *      (`mesh-relay:<service>:connect`), specialized per-CONTRACT rather
 *      than per-service. These scopes are never manually granted by an
 *      operator (a contract id doesn't exist until `create()` runs, so
 *      there is nothing to pre-grant) -- instead, `create()` ITSELF
 *      auto-grants `escrow:<contractId>:release`, `escrow:<contractId>:refund`,
 *      and `escrow:<contractId>:dispute` to BOTH `contract.payer` and
 *      `contract.payee` the moment the contract is created (mirrors
 *      `cloud-storage.mjs`'s own "grant() also drives visibility, not just
 *      the raw mutation" precedent -- see that file's design-decision #4).
 *      Nobody else -- a peer who is neither this contract's payer nor payee
 *      -- ever receives this scope, so `checkAccess()`'s existing
 *      default-deny does the real work: an unrelated peer's `release`/
 *      `refund`/`dispute` request against a contract THEY don't own is
 *      denied by the exact same mechanism `mesh-relay-host.mjs` uses for
 *      "who can relay to this service", not a bespoke ownership `if` this
 *      file invents separately. This auto-grant runs for EVERY `create()`
 *      call, wire-triggered or local/admin (`api.create()`), so a
 *      locally-created contract's real payer/payee can still act on it
 *      remotely later.
 *
 * `api.create`/`api.release`/`api.refund`/`api.dispute` (the LOCAL, in-process
 * surface) are intentionally UNRESTRICTED -- exactly like
 * `mesh-relay-host.mjs`'s `exposeService()`/`hideService()` have no ACL
 * check of their own (only the inbound wire path does): local code already
 * running inside this node's own process is trusted the same way any other
 * direct method call on an in-process object is. The wire protocol is what
 * adds a security boundary for a REMOTE, cryptographically-distinct caller;
 * it does not additionally restrict local callers.
 *
 * ---------------------------------------------------------------------------
 * WIRE PROTOCOL -- one `envelope.type` (`escrow` by default) carries both
 * directions, correlated by `requestId` (modeled directly on
 * `peer-routing.mjs`'s `requestProxy`/`mesh-rpc.mjs`'s request/response
 * pattern):
 *
 *   Request  (client -> host): `{ type, kind: 'request',  requestId, op, payload }`
 *   Response (host -> client): `{ type, kind: 'response', requestId, ok, result }`
 *                            or `{ type, kind: 'response', requestId, ok: false, error }`
 *
 * `op` is one of `'create' | 'release' | 'refund' | 'dispute'`. `payload`
 * shapes:
 *   - `create`:  `{ payeePodId, amount, description?, conditions?, timeoutMs? }`
 *     (NOT `payerPodId` -- see AUTHORIZATION MODEL above, always `fromPubKey`).
 *   - `release`: `{ contractId, proof? }`
 *   - `refund`:  `{ contractId, reason? }`
 *   - `dispute`: `{ contractId, evidence? }`
 *
 * Any node can act as BOTH host (answering inbound requests against its own
 * `creditLedger`) and client (`requestCreate`/`requestRelease`/
 * `requestRefund`/`requestDispute`, sending requests to another peer's
 * escrow service) -- there is no separate "client-only" descriptor, mirroring
 * `peer-routing.mjs`'s single combined `createMeshRoutingService()`.
 *
 * ---------------------------------------------------------------------------
 * EVENTS (`ctx.emit()`, see `mesh-service.mjs`'s "Observability events"
 * section) -- `EscrowManager`'s own pre-existing `on`/`off` surface
 * (`'created' | 'released' | 'refunded' | 'disputed' | 'expired'`) is bridged
 * through verbatim, prefixed `escrow:`, payload always the plain-object
 * `EscrowContract.toJSON()` (or, for `disputed`, `{ contract, disputeId,
 * evidence }` with `contract` also serialized) -- never the live class
 * instance, so a subscriber can never mutate manager-internal state via the
 * event payload:
 *
 *   - `escrow:created`   -- a new contract was funded (`create()`, either origin).
 *   - `escrow:released`  -- funds released to the payee.
 *   - `escrow:refunded`  -- funds refunded to the payer.
 *   - `escrow:disputed`  -- `{ contract, disputeId, evidence }`.
 *   - `escrow:expired`   -- a contract auto-refunded by `checkExpired()`.
 *
 * These fire for EVERY `EscrowManager` mutation regardless of whether it was
 * triggered locally (`api.create()`/etc.) or over the wire -- `EscrowManager`
 * itself has no notion of "origin", and this wrapper doesn't add one to the
 * event payload either, matching every other bridged-event service in this
 * family (e.g. `peer-routing.mjs`'s `mesh-routing:*` events).
 *
 * No browser-only imports at module level.
 */

/**
 * @param {object} opts
 * @param {object} opts.creditLedger - Must have charge(), credit(), getBalance() -- forwarded to `new EscrowManager()`.
 * @param {Function} [opts.onLog] - Logging callback (level, msg) -- forwarded to `EscrowManager`'s own `onLog`, PLUS this wrapper's own wire-level logging (send/handling failures, denied requests).
 * @param {string} [opts.envelopeType='escrow'] - `envelope.type` used for request/response traffic.
 * @param {number} [opts.requestTimeoutMs=10000] - How long `requestCreate()`/`requestRelease()`/`requestRefund()`/`requestDispute()` wait for a response.
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createEscrowService(opts = {}) {
  const {
    creditLedger,
    onLog,
    envelopeType = DEFAULT_ESCROW_ENVELOPE_TYPE,
    requestTimeoutMs = DEFAULT_ESCROW_REQUEST_TIMEOUT_MS,
  } = opts
  const log = onLog || (() => {})

  return {
    name: 'escrow',

    attach(peerNode, ctx) {
      const manager = new EscrowManager({
        creditLedger,
        onLog: (level, msg) => log('escrow:manager-log', { level, message: msg }),
      })

      // -- Bridge EscrowManager's own on()/off() events through ctx.emit() --
      // See module doc comment's "EVENTS" section. Contract payloads are
      // always serialized via toJSON() -- never the live class instance.
      const serializeContract = (contract) => (contract && typeof contract.toJSON === 'function' ? contract.toJSON() : contract)
      const onCreated = (contract) => ctx.emit('escrow:created', serializeContract(contract))
      const onReleased = (contract) => ctx.emit('escrow:released', serializeContract(contract))
      const onRefunded = (contract) => ctx.emit('escrow:refunded', serializeContract(contract))
      const onDisputed = ({ contract, disputeId, evidence }) => ctx.emit('escrow:disputed', { contract: serializeContract(contract), disputeId, evidence })
      const onExpired = (contract) => ctx.emit('escrow:expired', serializeContract(contract))
      manager.on('created', onCreated)
      manager.on('released', onReleased)
      manager.on('refunded', onRefunded)
      manager.on('disputed', onDisputed)
      manager.on('expired', onExpired)

      // -- Auto-grant per-contract release/refund/dispute scopes to the
      // contract's real payer/payee -- see module doc comment's
      // AUTHORIZATION MODEL section (point 2). Runs for every create(),
      // regardless of origin.
      function grantContractAccess(contract) {
        if (!ctx.registry || typeof ctx.registry.grantCapabilities !== 'function') return
        const scopes = [
          `escrow:${contract.id}:release`,
          `escrow:${contract.id}:refund`,
          `escrow:${contract.id}:dispute`,
        ]
        ctx.registry.grantCapabilities(contract.payer, scopes)
        if (contract.payee !== contract.payer) {
          ctx.registry.grantCapabilities(contract.payee, scopes)
        }
      }

      function doCreate(createOpts) {
        const contract = manager.create(createOpts)
        grantContractAccess(contract)
        return contract
      }

      // -- Local/admin api surface -- unrestricted, see module doc comment. --
      const api = {
        create: (createOpts) => doCreate(createOpts),
        release: (contractId, proof) => manager.release(contractId, proof),
        refund: (contractId, reason) => manager.refund(contractId, reason),
        dispute: (contractId, evidence) => manager.dispute(contractId, evidence),
        checkExpired: (now) => manager.checkExpired(now),
        getContract: (id) => manager.getContract(id),
        listContracts: (filter) => manager.listContracts(filter),
        getStats: () => manager.getStats(),
      }

      // -----------------------------------------------------------------
      // Host side -- answer inbound peer requests. See module doc comment's
      // AUTHORIZATION MODEL / WIRE PROTOCOL sections.
      // -----------------------------------------------------------------
      async function handleRequest(fromPubKey, msg) {
        const { requestId, op, payload } = msg
        let result
        let error
        try {
          if (op === 'create') {
            const { allowed } = ctx.registry.checkAccess(fromPubKey, 'escrow', 'create')
            if (!allowed) throw new Error('access denied')
            const contract = doCreate({
              payerPodId: fromPubKey,
              payeePodId: payload?.payeePodId,
              amount: payload?.amount,
              description: payload?.description,
              conditions: payload?.conditions,
              timeoutMs: payload?.timeoutMs,
            })
            result = contract.toJSON()
          } else if (op === 'release' || op === 'refund' || op === 'dispute') {
            const contractId = payload?.contractId
            if (!contractId || typeof contractId !== 'string') {
              throw new Error('contractId is required')
            }
            const { allowed } = ctx.registry.checkAccess(fromPubKey, `escrow:${contractId}`, op)
            if (!allowed) throw new Error('access denied')
            if (op === 'release') result = manager.release(contractId, payload?.proof)
            else if (op === 'refund') result = manager.refund(contractId, payload?.reason)
            else result = manager.dispute(contractId, payload?.evidence)
          } else {
            throw new Error(`unknown op: ${op}`)
          }
        } catch (err) {
          error = err?.message || String(err)
        }

        if (error === 'access denied') {
          log('escrow:request-denied', { fromPubKey, op, requestId })
        }

        try {
          await ctx.sendTo(fromPubKey, envelopeType, {
            kind: 'response', requestId, ok: !error, result, error,
          })
        } catch (err) {
          log('escrow:response-send-failed', { to: fromPubKey, requestId, error: err?.message || String(err) })
        }
      }

      // -----------------------------------------------------------------
      // Client side -- send requests to another peer's escrow service.
      // -----------------------------------------------------------------
      /** @type {Map<string, {resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>}>} */
      const pendingRequests = new Map()
      let reqSeq = 0
      const nextRequestId = () => `${peerNode.podId}:${Date.now()}:${++reqSeq}`

      async function sendRequest(targetPubKey, op, payload) {
        const requestId = nextRequestId()
        const promise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(requestId)
            reject(new Error(`escrow: ${op} request to ${targetPubKey} timed out after ${requestTimeoutMs}ms`))
          }, requestTimeoutMs)
          pendingRequests.set(requestId, { resolve, reject, timer })
        })

        try {
          await ctx.sendTo(targetPubKey, envelopeType, { kind: 'request', requestId, op, payload })
        } catch (err) {
          const pending = pendingRequests.get(requestId)
          if (pending) {
            clearTimeout(pending.timer)
            pendingRequests.delete(requestId)
          }
          throw err
        }

        return promise
      }

      api.requestCreate = (targetPubKey, { payeePodId, amount, description, conditions, timeoutMs } = {}) =>
        sendRequest(targetPubKey, 'create', { payeePodId, amount, description, conditions, timeoutMs })
      api.requestRelease = (targetPubKey, contractId, proof) =>
        sendRequest(targetPubKey, 'release', { contractId, proof })
      api.requestRefund = (targetPubKey, contractId, reason) =>
        sendRequest(targetPubKey, 'refund', { contractId, reason })
      api.requestDispute = (targetPubKey, contractId, evidence) =>
        sendRequest(targetPubKey, 'dispute', { contractId, evidence })

      const unsubscribe = ctx.onIncomingData(envelopeType, (fromPubKey, msg) => {
        if (!msg || typeof msg.kind !== 'string') return
        if (msg.kind === 'request') {
          handleRequest(fromPubKey, msg).catch((err) => {
            log('escrow:request-handling-failed', { from: fromPubKey, requestId: msg.requestId, error: err?.message || String(err) })
          })
        } else if (msg.kind === 'response') {
          const pending = pendingRequests.get(msg.requestId)
          if (!pending) return // no longer waiting (already timed out, or not ours) -- ignore
          pendingRequests.delete(msg.requestId)
          clearTimeout(pending.timer)
          if (msg.ok) pending.resolve(msg.result)
          else pending.reject(new Error(msg.error || 'escrow request failed'))
        }
      })

      return {
        api,
        teardown() {
          manager.off('created', onCreated)
          manager.off('released', onReleased)
          manager.off('refunded', onRefunded)
          manager.off('disputed', onDisputed)
          manager.off('expired', onExpired)
          unsubscribe()
          for (const pending of pendingRequests.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error('escrow: service torn down while a request was still in flight'))
          }
          pendingRequests.clear()
        },
      }
    },
  }
}

export { DEFAULT_ESCROW_ENVELOPE_TYPE, DEFAULT_ESCROW_REQUEST_TIMEOUT_MS }
