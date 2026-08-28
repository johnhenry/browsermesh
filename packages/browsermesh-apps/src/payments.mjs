/**
 * clawser-mesh-payments.js -- Payment channels for BrowserMesh.
 *
 * Double-entry credit ledger, bidirectional micropayment channels,
 * escrow management, and a payment router that ties them together.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-payments.test.mjs
 */

import { MESH_TYPE } from '@johnhenry/browsermesh-primitives';
import { silentCatch } from './silent-catch.mjs'

// ---------------------------------------------------------------------------
// Wire constants — imported from canonical registry
// ---------------------------------------------------------------------------

export const PAYMENT_OPEN = MESH_TYPE.PAYMENT_OPEN;
export const PAYMENT_UPDATE = MESH_TYPE.PAYMENT_UPDATE;
export const PAYMENT_CLOSE = MESH_TYPE.PAYMENT_CLOSE;
export const ESCROW_CREATE = MESH_TYPE.ESCROW_CREATE;

// ---------------------------------------------------------------------------
// Channel states
// ---------------------------------------------------------------------------

export const CHANNEL_STATES = Object.freeze([
  'idle', 'opening', 'open', 'closing', 'closed',
]);

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

let _entrySeq = 0;

function generateEntryId() {
  return `le_${Date.now().toString(36)}_${(++_entrySeq).toString(36)}`;
}

let _channelSeq = 0;

function generateChannelId(localPodId, remotePodId) {
  const pair = [localPodId, remotePodId].sort().join(':');
  return `ch_${pair}_${Date.now().toString(36)}_${(++_channelSeq).toString(36)}`;
}

let _escrowSeq = 0;

function generateEscrowId() {
  return `esc_${Date.now().toString(36)}_${(++_escrowSeq).toString(36)}`;
}

// ---------------------------------------------------------------------------
// LedgerEntry typedef
// ---------------------------------------------------------------------------

/**
 * @typedef {object} LedgerEntry
 * @property {string} id
 * @property {'credit'|'debit'} type
 * @property {number} amount
 * @property {string} counterparty - Pod ID of the other party
 * @property {string} [memo]
 * @property {number} timestamp
 * @property {number} balance - Running balance after this entry
 */

// ---------------------------------------------------------------------------
// CreditLedger
// ---------------------------------------------------------------------------

/**
 * Double-entry accounting ledger for a single pod.
 *
 * Every mutation produces an immutable LedgerEntry recording amount,
 * counterparty, running balance, and optional memo.
 */
export class CreditLedger {
  /** @type {string} */
  #ownerId;

  /** @type {number} */
  #balance = 0;

  /** @type {LedgerEntry[]} */
  #entries = [];

  /**
   * @param {string} ownerId - Pod ID that owns this ledger
   */
  constructor(ownerId) {
    if (!ownerId || typeof ownerId !== 'string') {
      throw new Error('ownerId must be a non-empty string');
    }
    this.#ownerId = ownerId;
  }

  /** Pod ID that owns this ledger. */
  get ownerId() {
    return this.#ownerId;
  }

  /** Current balance. */
  get balance() {
    return this.#balance;
  }

  /** Total number of ledger entries. */
  get entryCount() {
    return this.#entries.length;
  }

  /**
   * Record an incoming credit.
   *
   * @param {number} amount - Positive amount to credit
   * @param {string} fromPodId - Source pod ID
   * @param {string} [memo]
   * @returns {LedgerEntry}
   */
  credit(amount, fromPodId, memo) {
    if (typeof amount !== 'number' || amount <= 0) {
      throw new RangeError(`Credit amount must be positive, got ${amount}`);
    }
    this.#balance += amount;
    const entry = Object.freeze({
      id: generateEntryId(),
      type: 'credit',
      amount,
      counterparty: fromPodId,
      memo: memo || null,
      timestamp: Date.now(),
      balance: this.#balance,
    });
    this.#entries.push(entry);
    return entry;
  }

  /**
   * Record an outgoing debit.
   *
   * @param {number} amount - Positive amount to debit
   * @param {string} toPodId - Destination pod ID
   * @param {string} [memo]
   * @returns {LedgerEntry}
   * @throws {Error} If insufficient balance
   */
  debit(amount, toPodId, memo) {
    if (typeof amount !== 'number' || amount <= 0) {
      throw new RangeError(`Debit amount must be positive, got ${amount}`);
    }
    if (this.#balance < amount) {
      throw new Error(
        `Insufficient balance: need ${amount}, have ${this.#balance}`
      );
    }
    this.#balance -= amount;
    const entry = Object.freeze({
      id: generateEntryId(),
      type: 'debit',
      amount,
      counterparty: toPodId,
      memo: memo || null,
      timestamp: Date.now(),
      balance: this.#balance,
    });
    this.#entries.push(entry);
    return entry;
  }

  /**
   * Transfer amount from this ledger to a peer ledger.
   * Creates a debit here and a credit on the peer.
   *
   * @param {CreditLedger} peerLedger - The receiving ledger
   * @param {number} amount
   * @param {string} [memo]
   * @returns {{ debit: LedgerEntry, credit: LedgerEntry }}
   */
  transfer(peerLedger, amount, memo) {
    const debitEntry = this.debit(amount, peerLedger.ownerId, memo);
    const creditEntry = peerLedger.credit(amount, this.#ownerId, memo);
    return { debit: debitEntry, credit: creditEntry };
  }

  /**
   * Query ledger entries with optional filtering.
   *
   * @param {object} [opts]
   * @param {number} [opts.since] - Only entries at or after this timestamp
   * @param {number} [opts.limit] - Max entries to return
   * @returns {LedgerEntry[]}
   */
  getEntries(opts = {}) {
    let result = this.#entries;
    if (opts.since != null) {
      result = result.filter((e) => e.timestamp >= opts.since);
    }
    if (opts.limit != null && opts.limit > 0) {
      result = result.slice(0, opts.limit);
    }
    return [...result];
  }

  /**
   * Serialize to JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      ownerId: this.#ownerId,
      balance: this.#balance,
      entries: this.#entries.map((e) => ({ ...e })),
    };
  }

  /**
   * Restore a CreditLedger from serialized data.
   * @param {object} data
   * @returns {CreditLedger}
   */
  static fromJSON(data) {
    const ledger = new CreditLedger(data.ownerId);
    ledger.#balance = data.balance;
    ledger.#entries = data.entries.map((e) => Object.freeze({ ...e }));
    return ledger;
  }
}

// ---------------------------------------------------------------------------
// PaymentUpdate typedef
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PaymentUpdate
 * @property {string} channelId
 * @property {number} sequence
 * @property {number} amount
 * @property {number} localBalance
 * @property {number} remoteBalance
 * @property {number} timestamp
 * @property {string|null} signature
 */

// ---------------------------------------------------------------------------
// ChannelSettlement typedef
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ChannelSettlement
 * @property {string} channelId
 * @property {number} finalLocalBalance
 * @property {number} finalRemoteBalance
 * @property {number} entryCount
 * @property {number} closedAt
 */

// ---------------------------------------------------------------------------
// PaymentChannel
// ---------------------------------------------------------------------------

/** Default channel capacity (credits). */
const DEFAULT_CAPACITY = 1000;

/** Default TTL: 1 hour. */
const DEFAULT_TTL_MS = 3600000;

/**
 * Bidirectional micropayment channel between two pods.
 *
 * Tracks local and remote balances, enforces capacity, and
 * produces PaymentUpdate records for each payment.
 */
export class PaymentChannel {
  /** @type {string} */
  #localPodId;

  /** @type {string} */
  #remotePodId;

  /** @type {string} */
  #channelId;

  /** @type {number} */
  #capacity;

  /** @type {number} */
  #ttlMs;

  /** @type {number} */
  #createdAt;

  /** @type {string} */
  #state = 'idle';

  /** @type {number} */
  #localBalance = 0;

  /** @type {number} */
  #remoteBalance = 0;

  /** @type {number} */
  #sequence = 0;

  /**
   * @param {string} localPodId
   * @param {string} remotePodId
   * @param {object} [opts]
   * @param {number} [opts.capacity]
   * @param {number} [opts.ttlMs]
   */
  constructor(localPodId, remotePodId, opts = {}) {
    if (!localPodId || !remotePodId) {
      throw new Error('localPodId and remotePodId are required');
    }
    this.#localPodId = localPodId;
    this.#remotePodId = remotePodId;
    this.#channelId = generateChannelId(localPodId, remotePodId);
    this.#capacity = opts.capacity || DEFAULT_CAPACITY;
    this.#ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
    this.#createdAt = Date.now();
  }

  /** Channel identifier. */
  get channelId() {
    return this.#channelId;
  }

  /** Current state. */
  get state() {
    return this.#state;
  }

  /** Local pod balance. */
  get localBalance() {
    return this.#localBalance;
  }

  /** Remote pod balance. */
  get remoteBalance() {
    return this.#remoteBalance;
  }

  /** Channel capacity. */
  get capacity() {
    return this.#capacity;
  }

  /** Current sequence number. */
  get sequence() {
    return this.#sequence;
  }

  /**
   * Open the channel with an initial deposit.
   *
   * @param {number} initialDeposit - Amount to deposit into local balance
   */
  open(initialDeposit) {
    if (this.#state !== 'idle') {
      throw new Error(`Cannot open channel in state: ${this.#state}`);
    }
    if (typeof initialDeposit !== 'number' || initialDeposit <= 0) {
      throw new RangeError('Initial deposit must be positive');
    }
    if (initialDeposit > this.#capacity) {
      throw new RangeError(
        `Deposit ${initialDeposit} exceeds capacity ${this.#capacity}`
      );
    }
    this.#state = 'opening';
    this.#localBalance = initialDeposit;
    this.#state = 'open';
  }

  /**
   * Send a payment to the remote pod.
   *
   * @param {number} amount
   * @returns {PaymentUpdate}
   */
  pay(amount) {
    if (this.#state !== 'open') {
      throw new Error(`Cannot pay in state: ${this.#state}`);
    }
    if (typeof amount !== 'number' || amount <= 0) {
      throw new RangeError('Payment amount must be positive');
    }
    if (amount > this.#localBalance) {
      throw new Error(
        `Insufficient channel balance: need ${amount}, have ${this.#localBalance}`
      );
    }
    this.#localBalance -= amount;
    this.#remoteBalance += amount;
    this.#sequence += 1;
    return Object.freeze({
      channelId: this.#channelId,
      sequence: this.#sequence,
      amount,
      localBalance: this.#localBalance,
      remoteBalance: this.#remoteBalance,
      timestamp: Date.now(),
      signature: null,
    });
  }

  /**
   * Receive a payment update from the remote pod.
   *
   * @param {PaymentUpdate} update
   */
  receive(update) {
    if (this.#state !== 'open') {
      throw new Error(`Cannot receive in state: ${this.#state}`);
    }
    if (update.channelId !== this.#channelId) {
      throw new Error('Channel ID mismatch');
    }
    if (update.sequence <= this.#sequence) {
      throw new Error(
        `Stale sequence: got ${update.sequence}, expected > ${this.#sequence}`
      );
    }
    // From our perspective: remote sent to us, so our local goes up
    this.#localBalance += update.amount;
    this.#remoteBalance -= update.amount;
    this.#sequence = update.sequence;
  }

  /**
   * Close the channel and produce a settlement.
   *
   * @returns {ChannelSettlement}
   */
  close() {
    if (this.#state !== 'open') {
      throw new Error(`Cannot close channel in state: ${this.#state}`);
    }
    this.#state = 'closing';
    const settlement = Object.freeze({
      channelId: this.#channelId,
      finalLocalBalance: this.#localBalance,
      finalRemoteBalance: this.#remoteBalance,
      entryCount: this.#sequence,
      closedAt: Date.now(),
    });
    this.#state = 'closed';
    return settlement;
  }

  /**
   * Check whether this channel has expired.
   *
   * @returns {boolean}
   */
  isExpired() {
    return Date.now() - this.#createdAt > this.#ttlMs;
  }

  /**
   * Serialize to JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      localPodId: this.#localPodId,
      remotePodId: this.#remotePodId,
      channelId: this.#channelId,
      capacity: this.#capacity,
      ttlMs: this.#ttlMs,
      createdAt: this.#createdAt,
      state: this.#state,
      localBalance: this.#localBalance,
      remoteBalance: this.#remoteBalance,
      sequence: this.#sequence,
    };
  }

  /**
   * Restore a PaymentChannel from serialized data.
   * @param {object} data
   * @returns {PaymentChannel}
   */
  static fromJSON(data) {
    const ch = new PaymentChannel(data.localPodId, data.remotePodId, {
      capacity: data.capacity,
      ttlMs: data.ttlMs,
    });
    ch.#channelId = data.channelId;
    ch.#createdAt = data.createdAt;
    ch.#state = data.state;
    ch.#localBalance = data.localBalance;
    ch.#remoteBalance = data.remoteBalance;
    ch.#sequence = data.sequence;
    return ch;
  }
}

// ---------------------------------------------------------------------------
// Escrow typedef
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Escrow
 * @property {string} escrowId
 * @property {string} payerPodId
 * @property {string} payeePodId
 * @property {number} amount
 * @property {'held'|'released'|'refunded'|'expired'} status
 * @property {object} conditions
 * @property {number} createdAt
 * @property {number|null} resolvedAt
 */

// ---------------------------------------------------------------------------
// EscrowManager
// ---------------------------------------------------------------------------

/**
 * Manages escrow holds between pods. Funds are locked until
 * explicitly released, refunded, or expired.
 */
export class EscrowManager {
  /** @type {Map<string, object>} escrowId -> Escrow */
  #escrows = new Map();

  constructor() {}

  /** Number of active escrows. */
  get size() {
    return this.#escrows.size;
  }

  /**
   * Create a new escrow hold.
   *
   * @param {string} payerPodId
   * @param {string} payeePodId
   * @param {number} amount
   * @param {object} [conditions]
   * @param {number} [conditions.timeout] - Auto-expire after this many ms
   * @param {string} [conditions.description]
   * @returns {object} Escrow record
   */
  create(payerPodId, payeePodId, amount, conditions = {}) {
    if (typeof amount !== 'number' || amount <= 0) {
      throw new RangeError('Escrow amount must be positive');
    }
    const escrow = {
      escrowId: generateEscrowId(),
      payerPodId,
      payeePodId,
      amount,
      status: 'held',
      conditions: {
        timeout: conditions.timeout || null,
        description: conditions.description || null,
      },
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.#escrows.set(escrow.escrowId, escrow);
    return { ...escrow };
  }

  /**
   * Look up an escrow by ID.
   *
   * @param {string} escrowId
   * @returns {object|null}
   */
  get(escrowId) {
    const e = this.#escrows.get(escrowId);
    return e ? { ...e } : null;
  }

  /**
   * Release escrow to payee (pay out).
   *
   * @param {string} escrowId
   * @returns {boolean} true if released, false if not found or already resolved
   */
  release(escrowId) {
    const e = this.#escrows.get(escrowId);
    if (!e || e.status !== 'held') return false;
    e.status = 'released';
    e.resolvedAt = Date.now();
    return true;
  }

  /**
   * Refund escrow to payer.
   *
   * @param {string} escrowId
   * @returns {boolean} true if refunded, false if not found or already resolved
   */
  refund(escrowId) {
    const e = this.#escrows.get(escrowId);
    if (!e || e.status !== 'held') return false;
    e.status = 'refunded';
    e.resolvedAt = Date.now();
    return true;
  }

  /**
   * Expire escrow (auto-refund on timeout).
   *
   * @param {string} escrowId
   * @returns {boolean} true if expired, false if not found or already resolved
   */
  expire(escrowId) {
    const e = this.#escrows.get(escrowId);
    if (!e || e.status !== 'held') return false;
    e.status = 'expired';
    e.resolvedAt = Date.now();
    return true;
  }

  /**
   * List all escrows involving a pod (as payer or payee).
   *
   * @param {string} podId
   * @returns {object[]}
   */
  listByParty(podId) {
    const result = [];
    for (const e of this.#escrows.values()) {
      if (e.payerPodId === podId || e.payeePodId === podId) {
        result.push({ ...e });
      }
    }
    return result;
  }

  /**
   * Prune all escrows that have timed out. Sets status to 'expired'.
   *
   * @param {number} [now=Date.now()]
   * @returns {number} Number of escrows expired
   */
  pruneExpired(now = Date.now()) {
    return this.pruneExpiredDetailed(now).length;
  }

  /**
   * Same as `pruneExpired`, but returns the expired escrow records
   * (copies) instead of just a count — used by callers that need to
   * notify the counterparty which escrows just timed out.
   *
   * @param {number} [now=Date.now()]
   * @returns {object[]} Copies of the escrows that were just expired
   */
  pruneExpiredDetailed(now = Date.now()) {
    const expired = [];
    for (const e of this.#escrows.values()) {
      if (e.status !== 'held') continue;
      if (e.conditions.timeout == null) continue;
      if (now - e.createdAt >= e.conditions.timeout) {
        e.status = 'expired';
        e.resolvedAt = now;
        expired.push({ ...e });
      }
    }
    return expired;
  }
}

// ---------------------------------------------------------------------------
// PaymentRouter
// ---------------------------------------------------------------------------

/**
 * High-level payment manager for a single pod.
 * Ties together a credit ledger, payment channels, and escrow.
 */
export class PaymentRouter {
  /** @type {string} */
  #localPodId;

  /** @type {CreditLedger} */
  #ledger;

  /** @type {Map<string, PaymentChannel>} remotePodId -> channel */
  #channels = new Map();

  /** @type {EscrowManager} */
  #escrow;

  /** @type {function|null} */
  #broadcastFn = null;

  /** @type {ReturnType<typeof setInterval>|null} */
  #escrowSweeperTimer = null;

  /**
   * @param {string} localPodId
   */
  constructor(localPodId) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId must be a non-empty string');
    }
    this.#localPodId = localPodId;
    this.#ledger = new CreditLedger(localPodId);
    this.#escrow = new EscrowManager();
  }

  /**
   * Get the local credit ledger.
   * @returns {CreditLedger}
   */
  getLedger() {
    return this.#ledger;
  }

  /**
   * Open a payment channel to a remote pod.
   *
   * @param {string} remotePodId
   * @param {number} [capacity]
   * @returns {PaymentChannel}
   */
  openChannel(remotePodId, capacity) {
    if (this.#channels.has(remotePodId)) {
      throw new Error(`Channel to ${remotePodId} already exists`);
    }
    const opts = capacity != null ? { capacity } : {};
    const ch = new PaymentChannel(this.#localPodId, remotePodId, opts);
    this.#channels.set(remotePodId, ch);
    return ch;
  }

  /**
   * Look up a channel by remote pod ID.
   *
   * @param {string} remotePodId
   * @returns {PaymentChannel|null}
   */
  getChannel(remotePodId) {
    return this.#channels.get(remotePodId) || null;
  }

  /**
   * Close a channel and return the settlement.
   *
   * @param {string} remotePodId
   * @returns {ChannelSettlement|null}
   */
  closeChannel(remotePodId) {
    const ch = this.#channels.get(remotePodId);
    if (!ch) return null;
    const settlement = ch.close();
    this.#channels.delete(remotePodId);
    return settlement;
  }

  /**
   * List all open channels.
   *
   * @returns {PaymentChannel[]}
   */
  listChannels() {
    return [...this.#channels.values()];
  }

  /**
   * Get the escrow manager.
   *
   * @returns {EscrowManager}
   */
  getEscrow() {
    return this.#escrow;
  }

  /**
   * Start periodic escrow-timeout enforcement. Without this,
   * `EscrowManager.pruneExpired()` exists but nothing ever calls it, so
   * timed-out escrows sit in `held` status forever.
   *
   * There is no dedicated wire message for escrow expiry in the mesh
   * wire format (`browsermesh-primitives`) today — adding one is an
   * upstream package change, tracked separately. Until then, expiry is
   * enforced locally per-pod and surfaced via `onExpired`; each party
   * to an escrow independently expires it once its own clock passes
   * the timeout, so both sides converge without needing a message.
   *
   * @param {number} [intervalMs=30000]
   * @param {(expired: object[]) => void} [onExpired] - Called with the escrows that just expired (may be empty)
   */
  startEscrowSweeper(intervalMs = 30000, onExpired = null) {
    this.stopEscrowSweeper();
    this.#escrowSweeperTimer = setInterval(() => {
      const expired = this.#escrow.pruneExpiredDetailed();
      if (expired.length > 0 && onExpired) {
        try { onExpired(expired); } catch (e) { silentCatch('clawser-mesh-payments', 'onExpired', e) }
      }
    }, intervalMs);
  }

  /** Stop escrow-timeout enforcement. Call on pod teardown. */
  stopEscrowSweeper() {
    if (this.#escrowSweeperTimer) {
      clearInterval(this.#escrowSweeperTimer);
      this.#escrowSweeperTimer = null;
    }
  }

  /**
   * Wire the PaymentRouter to a mesh transport layer.
   *
   * Outbound: channel open/update/close and escrow messages sent via
   * `broadcastFn(type, payload)`.
   *
   * Inbound: messages received via `subscribeFn(type, handler)`.
   *
   * @param {function} broadcastFn - `(wireType: number, payload: object) => void`
   * @param {function} subscribeFn - `(wireType: number, handler: (payload, fromPodId) => void) => void`
   */
  wireTransport(broadcastFn, subscribeFn) {
    if (typeof broadcastFn !== 'function' || typeof subscribeFn !== 'function') {
      throw new Error('broadcastFn and subscribeFn must be functions');
    }

    this.#broadcastFn = broadcastFn;

    // Inbound: channel open request
    subscribeFn(PAYMENT_OPEN, (payload, fromPodId) => {
      try {
        const { remotePodId, capacity } = payload;
        if (remotePodId === this.#localPodId) {
          // Remote peer wants to open a channel with us
          this.openChannel(fromPodId, capacity);
        }
      } catch (e) { silentCatch('clawser-mesh-payments', 'ignore-duplicate-or-invalid-opens', e) }
    });

    // Inbound: channel payment update
    subscribeFn(PAYMENT_UPDATE, (payload, fromPodId) => {
      try {
        const ch = this.#channels.get(fromPodId);
        if (ch) {
          ch.receive(payload);
        }
      } catch (e) { silentCatch('clawser-mesh-payments', 'ignore-invalid-updates', e) }
    });

    // Inbound: channel close
    subscribeFn(PAYMENT_CLOSE, (payload, fromPodId) => {
      try { this.closeChannel(fromPodId); } catch (e) { silentCatch('clawser-mesh-payments', 'this.closeChannel', e) }
    });

    // Inbound: escrow creation
    subscribeFn(ESCROW_CREATE, (payload, fromPodId) => {
      try {
        const { payeePodId, amount, conditions } = payload;
        this.#escrow.create(fromPodId, payeePodId, amount, conditions);
      } catch (e) { silentCatch('clawser-mesh-payments', 'ignore-invalid-escrow', e) }
    });
  }

  /**
   * Broadcast a channel open over the transport.
   *
   * @param {string} remotePodId
   * @param {number} [capacity]
   */
  broadcastOpen(remotePodId, capacity) {
    if (this.#broadcastFn) {
      this.#broadcastFn(PAYMENT_OPEN, { remotePodId, capacity });
    }
  }

  /**
   * Broadcast a payment update over the transport.
   *
   * @param {PaymentUpdate} update
   */
  broadcastUpdate(update) {
    if (this.#broadcastFn) {
      this.#broadcastFn(PAYMENT_UPDATE, update);
    }
  }

  /**
   * Broadcast a channel close over the transport.
   *
   * @param {string} remotePodId
   * @param {ChannelSettlement} settlement
   */
  broadcastClose(remotePodId, settlement) {
    if (this.#broadcastFn) {
      this.#broadcastFn(PAYMENT_CLOSE, { remotePodId, ...settlement });
    }
  }

  /**
   * Broadcast an escrow creation over the transport.
   *
   * @param {object} escrow
   */
  broadcastEscrow(escrow) {
    if (this.#broadcastFn) {
      this.#broadcastFn(ESCROW_CREATE, escrow);
    }
  }
}
