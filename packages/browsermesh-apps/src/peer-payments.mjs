/**
 * clawser-peer-payments.js -- Payment mechanisms for resource sharing.
 *
 * Provides a PaymentProvider abstraction with two implementations:
 * 1. CreditLedger — internal credit system (no real money)
 * 2. WebLNProvider — Lightning Network payments (optional, requires browser extension)
 *
 * CreditLedger manages multi-peer balances and transaction history with
 * resource-based cost calculation. WebLNProvider wraps the WebLN browser API
 * for optional real-money Lightning payments.
 *
 * No browser-only imports at module level. All dependencies injected.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-payments.test.mjs
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default payment configuration for resource sharing.
 * All costs are in internal credits (not real money).
 */
export const PAYMENT_DEFAULTS = Object.freeze({
  initialCredits: 100,
  creditCostPerToken: 0.001,           // 0.001 credits per LLM token
  creditCostPerMbStorage: 0.1,         // 0.1 credits per MB stored
  creditCostPerMinuteCompute: 1,       // 1 credit per minute compute
  creditEarnPerMbServed: 0.05,         // earn for serving files
  creditEarnPerTokenServed: 0.0005,    // earn for serving LLM responses
})

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _txSeq = 0

function generateTxId() {
  return `tx_${Date.now().toString(36)}_${(++_txSeq).toString(36)}`
}

// ---------------------------------------------------------------------------
// CreditLedger
// ---------------------------------------------------------------------------

/**
 * Multi-peer credit ledger for resource sharing.
 *
 * Tracks per-pod balances with automatic initialization at a configurable
 * credit amount. Maintains a transaction log with optional capping.
 */
export class CreditLedger {
  /** @type {Map<string, number>} podId -> balance */
  #balances = new Map()

  /** @type {Array<object>} Transaction[] */
  #transactions = []

  /** @type {number} */
  #initialCredits

  /** @type {number} */
  #maxTransactions

  /** @type {Function} */
  #onLog

  /** @type {Map<string, Function[]>} */
  #listeners = new Map()

  /**
   * @param {object} [opts]
   * @param {number} [opts.initialCredits] - Starting credits for new peers
   * @param {number} [opts.maxTransactions] - Cap on stored transaction history
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor(opts = {}) {
    this.#initialCredits = opts.initialCredits ?? PAYMENT_DEFAULTS.initialCredits
    this.#maxTransactions = opts.maxTransactions ?? 10000
    this.#onLog = opts.onLog ?? (() => {})
  }

  // ── Balance ──────────────────────────────────────────────────────

  /**
   * Get balance for a peer. Returns initialCredits for unknown peers
   * (auto-initializes on first access).
   *
   * @param {string} podId
   * @returns {number}
   */
  getBalance(podId) {
    if (!this.#balances.has(podId)) {
      this.#balances.set(podId, this.#initialCredits)
    }
    return this.#balances.get(podId)
  }

  // ── Charge ───────────────────────────────────────────────────────

  /**
   * Charge credits (spending). Deducts from the peer's balance.
   *
   * @param {string} podId
   * @param {number} amount - Must be positive
   * @param {string} [memo]
   * @returns {{ success: boolean, txId: string|null, balance: number }}
   */
  charge(podId, amount, memo) {
    if (typeof amount !== 'number' || amount <= 0) {
      throw new RangeError(`Charge amount must be positive, got ${amount}`)
    }

    const balance = this.getBalance(podId)

    if (balance < amount) {
      this.#onLog(`Insufficient balance for ${podId}: need ${amount}, have ${balance}`)
      this.#emit('insufficient', { podId, amount, balance })
      return { success: false, txId: null, balance }
    }

    const newBalance = balance - amount
    this.#balances.set(podId, newBalance)

    const tx = this.#recordTransaction({
      type: 'charge',
      podId,
      amount,
      memo: memo || null,
      balance: newBalance,
    })

    this.#onLog(`Charged ${amount} from ${podId}: balance ${newBalance}`)
    this.#emit('charge', tx)

    return { success: true, txId: tx.txId, balance: newBalance }
  }

  // ── Credit ───────────────────────────────────────────────────────

  /**
   * Credit (earning). Adds to the peer's balance.
   *
   * @param {string} podId
   * @param {number} amount - Must be positive
   * @param {string} [memo]
   * @returns {{ success: boolean, txId: string, balance: number }}
   */
  credit(podId, amount, memo) {
    if (typeof amount !== 'number' || amount <= 0) {
      throw new RangeError(`Credit amount must be positive, got ${amount}`)
    }

    const balance = this.getBalance(podId)
    const newBalance = balance + amount
    this.#balances.set(podId, newBalance)

    const tx = this.#recordTransaction({
      type: 'credit',
      podId,
      amount,
      memo: memo || null,
      balance: newBalance,
    })

    this.#onLog(`Credited ${amount} to ${podId}: balance ${newBalance}`)
    this.#emit('credit', tx)

    return { success: true, txId: tx.txId, balance: newBalance }
  }

  // ── Transfer ─────────────────────────────────────────────────────

  /**
   * Transfer credits between two peers. Debits the sender and credits
   * the receiver atomically (both succeed or neither does).
   *
   * @param {string} fromPodId
   * @param {string} toPodId
   * @param {number} amount - Must be positive
   * @param {string} [memo]
   * @returns {{ success: boolean, txId: string|null }}
   */
  transfer(fromPodId, toPodId, amount, memo) {
    if (typeof amount !== 'number' || amount <= 0) {
      throw new RangeError(`Transfer amount must be positive, got ${amount}`)
    }

    const fromBalance = this.getBalance(fromPodId)

    if (fromBalance < amount) {
      this.#onLog(`Transfer failed: ${fromPodId} has ${fromBalance}, needs ${amount}`)
      this.#emit('insufficient', { podId: fromPodId, amount, balance: fromBalance })
      return { success: false, txId: null }
    }

    // Debit sender
    const newFromBalance = fromBalance - amount
    this.#balances.set(fromPodId, newFromBalance)

    // Credit receiver
    const toBalance = this.getBalance(toPodId)
    const newToBalance = toBalance + amount
    this.#balances.set(toPodId, newToBalance)

    const transferMemo = memo || `transfer ${fromPodId} -> ${toPodId}`

    const tx = this.#recordTransaction({
      type: 'transfer',
      podId: fromPodId,
      toPodId,
      amount,
      memo: transferMemo,
      balance: newFromBalance,
    })

    this.#onLog(`Transfer ${amount} from ${fromPodId} to ${toPodId}`)
    this.#emit('transfer', tx)

    return { success: true, txId: tx.txId }
  }

  // ── Transaction history ──────────────────────────────────────────

  /**
   * Get transaction history, optionally filtered by pod ID.
   *
   * @param {string} [podId] - If provided, only transactions involving this pod
   * @param {number} [limit] - Max results to return
   * @returns {object[]} Transaction[]
   */
  getTransactions(podId, limit) {
    let result = this.#transactions

    if (podId) {
      result = result.filter(
        (tx) => tx.podId === podId || tx.toPodId === podId
      )
    }

    if (typeof limit === 'number' && limit > 0) {
      result = result.slice(-limit)
    }

    return [...result]
  }

  /**
   * Look up a single transaction by ID.
   *
   * @param {string} txId
   * @returns {object|null}
   */
  getTransactionById(txId) {
    return this.#transactions.find((tx) => tx.txId === txId) ?? null
  }

  // ── Resource cost calculation ────────────────────────────────────

  /**
   * Calculate the credit cost for a given resource type and quantity.
   *
   * @param {'tokens'|'storage_mb'|'compute_minutes'} resourceType
   * @param {number} quantity
   * @returns {number}
   */
  calculateCost(resourceType, quantity) {
    if (typeof quantity !== 'number' || quantity < 0) {
      throw new RangeError(`Quantity must be non-negative, got ${quantity}`)
    }

    switch (resourceType) {
      case 'tokens':
        return quantity * PAYMENT_DEFAULTS.creditCostPerToken
      case 'storage_mb':
        return quantity * PAYMENT_DEFAULTS.creditCostPerMbStorage
      case 'compute_minutes':
        return quantity * PAYMENT_DEFAULTS.creditCostPerMinuteCompute
      default:
        throw new Error(`Unknown resource type: ${resourceType}`)
    }
  }

  // ── Summary ──────────────────────────────────────────────────────

  /**
   * Get a summary of a peer's financial activity.
   *
   * @param {string} podId
   * @returns {{ balance: number, totalEarned: number, totalSpent: number, transactionCount: number }}
   */
  getSummary(podId) {
    const balance = this.getBalance(podId)
    let totalEarned = 0
    let totalSpent = 0
    let transactionCount = 0

    for (const tx of this.#transactions) {
      if (tx.podId === podId) {
        transactionCount++
        if (tx.type === 'credit') {
          totalEarned += tx.amount
        } else if (tx.type === 'charge') {
          totalSpent += tx.amount
        } else if (tx.type === 'transfer') {
          totalSpent += tx.amount
        }
      }
      if (tx.toPodId === podId) {
        transactionCount++
        if (tx.type === 'transfer') {
          totalEarned += tx.amount
        }
      }
    }

    return { balance, totalEarned, totalSpent, transactionCount }
  }

  // ── Serialization ────────────────────────────────────────────────

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      initialCredits: this.#initialCredits,
      maxTransactions: this.#maxTransactions,
      balances: Object.fromEntries(this.#balances),
      transactions: this.#transactions.map((tx) => ({ ...tx })),
    }
  }

  /**
   * Restore a CreditLedger from serialized data.
   * @param {object} data
   * @returns {CreditLedger}
   */
  static fromJSON(data) {
    const ledger = new CreditLedger({
      initialCredits: data.initialCredits,
      maxTransactions: data.maxTransactions,
    })
    for (const [podId, balance] of Object.entries(data.balances)) {
      ledger.#balances.set(podId, balance)
    }
    ledger.#transactions = data.transactions.map((tx) => ({ ...tx }))
    return ledger
  }

  // ── Events ───────────────────────────────────────────────────────

  /**
   * Subscribe to an event.
   * @param {string} event - 'charge' | 'credit' | 'transfer' | 'insufficient'
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

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Emit an event to all listeners.
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
   * Record a transaction and enforce the maxTransactions cap.
   * @param {object} fields
   * @returns {object} The recorded transaction
   */
  #recordTransaction(fields) {
    const tx = {
      txId: generateTxId(),
      timestamp: Date.now(),
      ...fields,
    }

    this.#transactions.push(tx)

    // Enforce cap: drop oldest transactions when over limit
    if (this.#transactions.length > this.#maxTransactions) {
      this.#transactions = this.#transactions.slice(-this.#maxTransactions)
    }

    return tx
  }
}

// ---------------------------------------------------------------------------
// WebLNProvider
// ---------------------------------------------------------------------------

/**
 * Wrapper around the WebLN browser API for optional Lightning Network payments.
 *
 * WebLN is a browser extension API (e.g., Alby) that enables Lightning
 * Network payments directly from the browser. This class provides a safe
 * abstraction that degrades gracefully when WebLN is not available.
 *
 * @see https://www.webln.guide/
 */
export class WebLNProvider {
  /** @type {boolean} */
  #available

  /** @type {boolean} */
  #connected = false

  /** @type {Function} */
  #onLog

  /** @type {object|null} — reference to the webln global, injectable for testing */
  #weblnRef

  /**
   * @param {object} [opts]
   * @param {Function} [opts.onLog] - Logging callback
   * @param {object} [opts.webln] - Injected webln reference (for testing)
   */
  constructor(opts = {}) {
    this.#onLog = opts.onLog ?? (() => {})
    this.#weblnRef = opts.webln ?? (typeof globalThis !== 'undefined' ? globalThis.webln : undefined) ?? null
    this.#available = this.#weblnRef != null
  }

  // ── Status ───────────────────────────────────────────────────────

  /**
   * Whether the WebLN API is available in the current environment.
   * @returns {boolean}
   */
  get available() {
    return this.#available
  }

  /**
   * Whether we have an active connection to the user's Lightning wallet.
   * @returns {boolean}
   */
  get connected() {
    return this.#connected
  }

  // ── Connect ──────────────────────────────────────────────────────

  /**
   * Connect to the user's Lightning wallet via WebLN.
   * Calls window.webln.enable().
   *
   * @returns {Promise<boolean>} true if connected successfully
   */
  async connect() {
    if (!this.#available) {
      this.#onLog('WebLN not available')
      return false
    }

    try {
      await this.#weblnRef.enable()
      this.#connected = true
      this.#onLog('WebLN connected')
      return true
    } catch (err) {
      this.#onLog(`WebLN connect failed: ${err.message}`)
      this.#connected = false
      return false
    }
  }

  // ── Balance ──────────────────────────────────────────────────────

  /**
   * Get the wallet balance in sats.
   * Requires an active connection.
   *
   * @returns {Promise<number|null>} Balance in sats, or null on failure
   */
  async getBalance() {
    if (!this.#connected) {
      this.#onLog('WebLN not connected')
      return null
    }

    try {
      const result = await this.#weblnRef.getBalance()
      return typeof result === 'number' ? result : (result?.balance ?? null)
    } catch (err) {
      this.#onLog(`WebLN getBalance failed: ${err.message}`)
      return null
    }
  }

  // ── Invoices ─────────────────────────────────────────────────────

  /**
   * Create a Lightning invoice for receiving payment.
   *
   * @param {number} amount - Amount in sats
   * @param {string} [memo] - Invoice description
   * @returns {Promise<{ paymentRequest: string, rHash: string }|null>}
   */
  async createInvoice(amount, memo) {
    if (!this.#connected) {
      this.#onLog('WebLN not connected')
      return null
    }

    try {
      const invoice = await this.#weblnRef.makeInvoice({
        amount,
        defaultMemo: memo || '',
      })
      return {
        paymentRequest: invoice.paymentRequest,
        rHash: invoice.rHash || invoice.paymentHash || '',
      }
    } catch (err) {
      this.#onLog(`WebLN makeInvoice failed: ${err.message}`)
      return null
    }
  }

  // ── Pay ──────────────────────────────────────────────────────────

  /**
   * Pay a Lightning invoice.
   *
   * @param {string} paymentRequest - BOLT11 invoice string
   * @returns {Promise<{ preimage: string, success: boolean }|null>}
   */
  async payInvoice(paymentRequest) {
    if (!this.#connected) {
      this.#onLog('WebLN not connected')
      return null
    }

    try {
      const result = await this.#weblnRef.sendPayment(paymentRequest)
      return {
        preimage: result.preimage || '',
        success: true,
      }
    } catch (err) {
      this.#onLog(`WebLN sendPayment failed: ${err.message}`)
      return null
    }
  }

  // ── Info ──────────────────────────────────────────────────────────

  /**
   * Get wallet/node info.
   *
   * @returns {Promise<object|null>}
   */
  async getInfo() {
    if (!this.#connected) {
      this.#onLog('WebLN not connected')
      return null
    }

    try {
      return await this.#weblnRef.getInfo()
    } catch (err) {
      this.#onLog(`WebLN getInfo failed: ${err.message}`)
      return null
    }
  }

  // ── Serialization ────────────────────────────────────────────────

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      available: this.#available,
      connected: this.#connected,
      type: 'webln',
    }
  }
}
