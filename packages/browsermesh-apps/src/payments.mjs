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
// Signature helpers
// ---------------------------------------------------------------------------
//
// PaymentChannel accepts an injected signFn/verifyFn pair rather than
// hardcoding a crypto mechanism, so callers can wire a real
// MeshIdentityManager (see @johnhenry/browsermesh-core's identity.mjs)
// in without this published, general-purpose package taking a hard
// dependency on it. Shape matches peer-chat.mjs's convention:
//   signFn:   async (data: Uint8Array) => Uint8Array
//   verifyFn: async (pubKey: Uint8Array, data: Uint8Array, sig: Uint8Array) => boolean

/**
 * Encode a Uint8Array to a base64 string.
 * Falls back to manual encoding when btoa is unavailable (Node tests).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToBase64(bytes) {
  if (typeof btoa === 'function') {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  throw new Error('No base64 encoder available');
}

/**
 * Decode a base64 string to a Uint8Array.
 *
 * @param {string} b64
 * @returns {Uint8Array}
 */
function base64ToBytes(b64) {
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  throw new Error('No base64 decoder available');
}

/**
 * Canonical bytes for a plain fields object, used as the signing/verification
 * payload for both PaymentUpdate and close claims/acks.
 *
 * @param {object} fields
 * @returns {Uint8Array}
 */
function canonicalBytes(fields) {
  return new TextEncoder().encode(JSON.stringify(fields));
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
// CloseClaim / CloseAck typedefs (two-phase mutual close)
// ---------------------------------------------------------------------------

/**
 * Signed claim produced by the initiator of a mutual close. Sent to the
 * counterparty, which must verify it and cross-check its own ledger state
 * before co-signing an ack (see PaymentChannel#handleCloseMessage).
 *
 * @typedef {object} CloseClaim
 * @property {string} channelId
 * @property {number} finalLocalBalance - Initiator's claimed final balance
 * @property {number} finalRemoteBalance - Counterparty's claimed final balance
 * @property {number} entryCount
 * @property {number} closedAt
 * @property {string} signature - base64-encoded signature over the fields above
 */

/**
 * Signed acknowledgement of a CloseClaim, produced by the counterparty once
 * it has verified the claim and confirmed it matches its own local ledger.
 * Echoes the claim's fields (co-signed) so the initiator can finalize.
 *
 * @typedef {object} CloseAck
 * @property {string} channelId
 * @property {number} finalLocalBalance
 * @property {number} finalRemoteBalance
 * @property {number} entryCount
 * @property {number} closedAt
 * @property {string} signature - base64-encoded signature, by the counterparty
 */

/**
 * Raised when a close claim or ack fails signature verification, or its
 * balances don't match the receiving side's own local ledger state --
 * i.e. the counterparty is claiming a settlement this side doesn't agree to.
 *
 * @typedef {object} PaymentDispute
 * @property {string} channelId
 * @property {'invalid-signature'|'balance-mismatch'|'invalid-ack-signature'|'ack-mismatch'} reason
 * @property {object} evidence - The claim or ack that triggered the dispute
 * @property {number} localBalance - This side's local balance at dispute time
 * @property {number} remoteBalance - This side's remote balance at dispute time
 * @property {number} raisedAt
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

  /** @type {((data: Uint8Array) => Promise<Uint8Array>)|null} */
  #signFn;

  /** @type {((pubKey: Uint8Array, data: Uint8Array, sig: Uint8Array) => Promise<boolean>)|null} */
  #verifyFn;

  /** @type {Uint8Array|null} */
  #remotePublicKey;

  /** @type {PaymentDispute[]} */
  #disputes = [];

  /** @type {Map<string, Set<Function>>} */
  #listeners = new Map();

  /**
   * @param {string} localPodId
   * @param {string} remotePodId
   * @param {object} [opts]
   * @param {number} [opts.capacity]
   * @param {number} [opts.ttlMs]
   * @param {Function} [opts.signFn] - async (data: Uint8Array) => Uint8Array.
   *   When omitted, PaymentUpdate/close signatures stay `null` and close()
   *   stays unilateral -- fully backward compatible.
   * @param {Function} [opts.verifyFn] - async (pubKey, data, sig) => boolean
   * @param {Uint8Array} [opts.remotePublicKey] - Remote pod's raw public key,
   *   required alongside verifyFn to verify incoming updates/claims.
   * @param {string} [opts.channelId] - Use this exact channel ID instead of
   *   generating a new one. Lets both sides of a channel agree on the same
   *   ID (e.g. echoed back from a PAYMENT_OPEN handshake) so signed
   *   updates/close messages -- which are keyed by channelId -- validate
   *   against each other. Defaults to auto-generated, as before.
   */
  constructor(localPodId, remotePodId, opts = {}) {
    if (!localPodId || !remotePodId) {
      throw new Error('localPodId and remotePodId are required');
    }
    this.#localPodId = localPodId;
    this.#remotePodId = remotePodId;
    this.#channelId = opts.channelId || generateChannelId(localPodId, remotePodId);
    this.#capacity = opts.capacity || DEFAULT_CAPACITY;
    this.#ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
    this.#createdAt = Date.now();
    this.#signFn = opts.signFn || null;
    this.#verifyFn = opts.verifyFn || null;
    this.#remotePublicKey = opts.remotePublicKey || null;
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
   * `remoteDeposit` is what the *counterparty* funded the channel with, as
   * reported by their PAYMENT_OPEN message. It exists because a channel has
   * two sides and only one of them runs this method with first-hand
   * knowledge: without it, the receiving side of an open handshake starts at
   * `remoteBalance = 0` while the initiator sits at `localBalance = deposit`,
   * and the two views can never converge -- every subsequent update is
   * computed from a starting point they disagree about. See
   * `PaymentRouter.broadcastOpen()` for the wire side of this.
   *
   * One-sided funding stays the default: `open(100)` behaves exactly as
   * before, including throwing on a non-positive amount. A pure counterparty
   * mirror is `open(0, 100)` -- zero of your own credits, 100 of theirs --
   * which is why the positivity check is on the *total*, not on the local
   * side alone.
   *
   * @param {number} initialDeposit - Amount to deposit into local balance
   * @param {number} [remoteDeposit=0] - Amount the counterparty deposited,
   *   credited to `remoteBalance`
   */
  open(initialDeposit, remoteDeposit = 0) {
    if (this.#state !== 'idle') {
      throw new Error(`Cannot open channel in state: ${this.#state}`);
    }
    if (typeof initialDeposit !== 'number' || Number.isNaN(initialDeposit) || initialDeposit < 0) {
      throw new RangeError('Initial deposit must be positive');
    }
    if (typeof remoteDeposit !== 'number' || Number.isNaN(remoteDeposit) || remoteDeposit < 0) {
      throw new RangeError('Remote deposit must not be negative');
    }
    if (initialDeposit + remoteDeposit <= 0) {
      // Preserves the pre-existing message for the one-argument form, which
      // is the only way this is reachable without an explicit remoteDeposit.
      throw new RangeError('Initial deposit must be positive');
    }
    if (initialDeposit + remoteDeposit > this.#capacity) {
      throw new RangeError(
        `Deposit ${initialDeposit + remoteDeposit} exceeds capacity ${this.#capacity}`
      );
    }
    this.#state = 'opening';
    this.#localBalance = initialDeposit;
    this.#remoteBalance = remoteDeposit;
    this.#state = 'open';
  }

  /**
   * Send a payment to the remote pod.
   *
   * When a signFn was injected at construction, the returned PaymentUpdate
   * is signed and this method returns a Promise (awaited by the caller).
   * Without a signFn, behavior is unchanged: synchronous return, signature
   * stays `null`.
   *
   * @param {number} amount
   * @returns {PaymentUpdate|Promise<PaymentUpdate>}
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
    const base = {
      channelId: this.#channelId,
      sequence: this.#sequence,
      amount,
      localBalance: this.#localBalance,
      remoteBalance: this.#remoteBalance,
      timestamp: Date.now(),
    };
    if (!this.#signFn) {
      return Object.freeze({ ...base, signature: null });
    }
    return this.#signUpdate(base);
  }

  /**
   * Sign a PaymentUpdate's fields and return the frozen, signed update.
   * @param {object} base - Unsigned update fields
   * @returns {Promise<PaymentUpdate>}
   */
  async #signUpdate(base) {
    const sigBytes = await this.#signFn(canonicalBytes(base));
    return Object.freeze({ ...base, signature: bytesToBase64(sigBytes) });
  }

  /**
   * Receive a payment update from the remote pod.
   *
   * When a verifyFn (+ remotePublicKey) was injected at construction, the
   * update's signature is verified before it's applied; unsigned or invalid
   * updates are rejected (this method returns a rejected Promise). Without
   * a verifyFn, behavior is unchanged: synchronous, unconditional apply.
   *
   * @param {PaymentUpdate} update
   * @returns {void|Promise<void>}
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
    if (!this.#verifyFn) {
      this.#applyReceive(update);
      return;
    }
    return this.#verifyAndApplyReceive(update);
  }

  /**
   * Verify an incoming update's signature and, if valid, apply it.
   * Throws if the signature is missing or invalid.
   * @param {PaymentUpdate} update
   */
  async #verifyAndApplyReceive(update) {
    const fields = {
      channelId: update.channelId,
      sequence: update.sequence,
      amount: update.amount,
      localBalance: update.localBalance,
      remoteBalance: update.remoteBalance,
      timestamp: update.timestamp,
    };
    const valid = await this.#verifySigned(fields, update.signature);
    if (!valid) {
      throw new Error(
        `Rejected payment update seq ${update.sequence}: missing or invalid signature`
      );
    }
    this.#applyReceive(update);
  }

  /** Apply a verified (or verification-not-required) update's balance delta. */
  #applyReceive(update) {
    // From our perspective: remote sent to us, so our local goes up
    this.#localBalance += update.amount;
    this.#remoteBalance -= update.amount;
    this.#sequence = update.sequence;
  }

  /**
   * Verify a signature over a canonical fields object using the injected
   * verifyFn + remotePublicKey. Never throws -- returns false on any
   * failure (missing config, missing signature, decode error, mismatch).
   *
   * @param {object} fields
   * @param {string|null|undefined} signatureB64
   * @returns {Promise<boolean>}
   */
  async #verifySigned(fields, signatureB64) {
    if (!this.#verifyFn || !this.#remotePublicKey) return false;
    if (!signatureB64) return false;
    try {
      const data = canonicalBytes(fields);
      const sigBytes = base64ToBytes(signatureB64);
      return await this.#verifyFn(this.#remotePublicKey, data, sigBytes);
    } catch {
      return false;
    }
  }

  /**
   * Close the channel and produce a settlement.
   *
   * Without a signFn, this is unchanged: unilateral and synchronous -- the
   * channel closes immediately with whatever local balances it holds.
   *
   * With a signFn, closing becomes a two-phase mutual protocol: this method
   * signs a CloseClaim of the current local view and moves to the `closing`
   * state, returning a Promise<CloseClaim> to send to the counterparty. The
   * counterparty verifies it via handleCloseMessage(); once its ack comes
   * back, call finalizeClose(ack) to actually reach `closed`.
   *
   * @returns {ChannelSettlement|Promise<CloseClaim>}
   */
  close() {
    if (this.#state !== 'open') {
      throw new Error(`Cannot close channel in state: ${this.#state}`);
    }
    if (!this.#signFn) {
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
    return this.#initiateSignedClose();
  }

  /**
   * Initiator side of a signed mutual close: sign a claim of the current
   * local view and move to `closing` (not yet `closed`).
   * @returns {Promise<CloseClaim>}
   */
  async #initiateSignedClose() {
    this.#state = 'closing';
    const claimFields = {
      channelId: this.#channelId,
      finalLocalBalance: this.#localBalance,
      finalRemoteBalance: this.#remoteBalance,
      entryCount: this.#sequence,
      closedAt: Date.now(),
    };
    const sigBytes = await this.#signFn(canonicalBytes(claimFields));
    return Object.freeze({ ...claimFields, signature: bytesToBase64(sigBytes) });
  }

  /**
   * Counterparty side of a signed mutual close. Verifies the initiator's
   * claim and cross-checks it against this side's own local ledger state
   * before agreeing. Requires both verifyFn (to check the claim) and
   * signFn (to co-sign the ack) to be configured.
   *
   * On agreement, this channel transitions straight to `closed` (the
   * counterparty doesn't need a further round trip -- it already holds the
   * balances it's attesting to). On mismatch or invalid signature, a
   * PaymentDispute is raised and the channel is left as-is (`open`) so it
   * can be inspected/retried rather than silently accepting the claim.
   *
   * @param {CloseClaim} claim
   * @returns {Promise<{ ok: true, ack: CloseAck }|{ ok: false, dispute: PaymentDispute }>}
   */
  async handleCloseMessage(claim) {
    if (this.#state !== 'open') {
      throw new Error(`Cannot handle close message in state: ${this.#state}`);
    }
    if (!claim || claim.channelId !== this.#channelId) {
      throw new Error('Channel ID mismatch');
    }
    const claimFields = {
      channelId: claim.channelId,
      finalLocalBalance: claim.finalLocalBalance,
      finalRemoteBalance: claim.finalRemoteBalance,
      entryCount: claim.entryCount,
      closedAt: claim.closedAt,
    };
    const valid = await this.#verifySigned(claimFields, claim.signature);
    // From the initiator's perspective, finalLocalBalance is *their*
    // balance and finalRemoteBalance is *ours* -- so it must mirror what
    // we independently hold.
    const matches = valid
      && claim.finalRemoteBalance === this.#localBalance
      && claim.finalLocalBalance === this.#remoteBalance;

    if (!matches) {
      const dispute = this.#raiseDispute(
        valid ? 'balance-mismatch' : 'invalid-signature',
        claim
      );
      return { ok: false, dispute };
    }

    if (!this.#signFn) {
      const dispute = this.#raiseDispute('invalid-signature', claim);
      return { ok: false, dispute };
    }

    const sigBytes = await this.#signFn(canonicalBytes(claimFields));
    const ack = Object.freeze({ ...claimFields, signature: bytesToBase64(sigBytes) });
    this.#state = 'closed';
    return { ok: true, ack };
  }

  /**
   * Initiator side: finalize a close after receiving the counterparty's
   * ack. Verifies the ack and cross-checks it against the claim this side
   * already sent. On agreement, moves to `closed` and returns the
   * settlement. On mismatch or invalid signature, raises a PaymentDispute
   * instead of trusting the wire message.
   *
   * @param {CloseAck} ack
   * @returns {Promise<{ ok: true, settlement: ChannelSettlement }|{ ok: false, dispute: PaymentDispute }>}
   */
  async finalizeClose(ack) {
    if (this.#state !== 'closing') {
      throw new Error(`Cannot finalize close in state: ${this.#state}`);
    }
    if (!ack || ack.channelId !== this.#channelId) {
      throw new Error('Channel ID mismatch');
    }
    const ackFields = {
      channelId: ack.channelId,
      finalLocalBalance: ack.finalLocalBalance,
      finalRemoteBalance: ack.finalRemoteBalance,
      entryCount: ack.entryCount,
      closedAt: ack.closedAt,
    };
    const valid = await this.#verifySigned(ackFields, ack.signature);
    const matches = valid
      && ack.finalLocalBalance === this.#localBalance
      && ack.finalRemoteBalance === this.#remoteBalance;

    if (!matches) {
      const dispute = this.#raiseDispute(
        valid ? 'ack-mismatch' : 'invalid-ack-signature',
        ack
      );
      return { ok: false, dispute };
    }

    const settlement = Object.freeze({
      channelId: this.#channelId,
      finalLocalBalance: this.#localBalance,
      finalRemoteBalance: this.#remoteBalance,
      entryCount: this.#sequence,
      closedAt: ack.closedAt,
    });
    this.#state = 'closed';
    return { ok: true, settlement };
  }

  /**
   * Record a PaymentDispute, emit it to listeners, and return it.
   * @param {PaymentDispute['reason']} reason
   * @param {object} evidence - The claim/ack that triggered the dispute
   * @returns {PaymentDispute}
   */
  #raiseDispute(reason, evidence) {
    const dispute = Object.freeze({
      channelId: this.#channelId,
      reason,
      evidence,
      localBalance: this.#localBalance,
      remoteBalance: this.#remoteBalance,
      raisedAt: Date.now(),
    });
    this.#disputes.push(dispute);
    this.#emit('dispute', dispute);
    return dispute;
  }

  /**
   * List all PaymentDisputes raised on this channel.
   * @returns {PaymentDispute[]}
   */
  listDisputes() {
    return [...this.#disputes];
  }

  /**
   * Register a listener for 'dispute' events. Convenience wrapper over on().
   * @param {(dispute: PaymentDispute) => void} cb
   */
  onPaymentDispute(cb) {
    this.on('dispute', cb);
  }

  /**
   * Register a listener for a channel event ('dispute' today).
   * @param {string} event
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set());
    }
    this.#listeners.get(event).add(cb);
  }

  /**
   * Remove a listener registered via on()/onPaymentDispute().
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const set = this.#listeners.get(event);
    if (set) set.delete(cb);
  }

  /** @param {string} event @param {*} data */
  #emit(event, data) {
    const set = this.#listeners.get(event);
    if (!set) return;
    for (const cb of set) {
      try { cb(data); } catch (e) { silentCatch('clawser-mesh-payments', 'channel-listener', e) }
    }
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
   * @param {object} [extraOpts] - Additional constructor opts not covered by
   *   `data` (signFn/verifyFn/remotePublicKey aren't serializable, so they
   *   aren't part of toJSON()'s output -- pass them here to restore a
   *   signing-capable channel).
   * @returns {PaymentChannel}
   */
  static fromJSON(data, extraOpts = {}) {
    const ch = new PaymentChannel(data.localPodId, data.remotePodId, {
      capacity: data.capacity,
      ttlMs: data.ttlMs,
      ...extraOpts,
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

  /** @type {PaymentDispute[]} */
  #disputes = [];

  /** @type {Set<Function>} */
  #disputeListeners = new Set();

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
   * @param {object} [signingOpts] - Forwarded to PaymentChannel. Enables
   *   signed updates and mutual close, and carries `channelId` when both
   *   sides must agree on one (see broadcastOpen()). Omit for unchanged,
   *   unsigned behavior with a locally-generated id.
   * @param {Function} [signingOpts.signFn]
   * @param {Function} [signingOpts.verifyFn]
   * @param {Uint8Array} [signingOpts.remotePublicKey]
   * @param {string} [signingOpts.channelId]
   * @returns {PaymentChannel}
   */
  openChannel(remotePodId, capacity, signingOpts) {
    if (this.#channels.has(remotePodId)) {
      throw new Error(`Channel to ${remotePodId} already exists`);
    }
    const opts = { ...(signingOpts || {}) };
    if (capacity != null) opts.capacity = capacity;
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
   * When the channel has signing configured, this only *initiates* the
   * two-phase close: it broadcasts a signed CloseClaim and returns a
   * Promise that resolves once the claim is sent (not once the
   * counterparty has acked). The channel itself stays in the router's
   * map until wireTransport's PAYMENT_CLOSE handler receives the ack and
   * removes it -- see wireTransport() below.
   *
   * @param {string} remotePodId
   * @returns {ChannelSettlement|Promise<{ pending: true, claim: CloseClaim }>|null}
   */
  closeChannel(remotePodId) {
    const ch = this.#channels.get(remotePodId);
    if (!ch) return null;
    const result = ch.close();
    if (result && typeof result.then === 'function') {
      // Signed two-phase close: `result` resolves to a CloseClaim. Leave
      // the channel in the map (state 'closing') until the counterparty's
      // ack arrives over the wire and finalizes it.
      return result.then((claim) => {
        this.broadcastClose(remotePodId, { claim });
        return { pending: true, claim };
      });
    }
    this.#channels.delete(remotePodId);
    return result;
  }

  /**
   * List all PaymentDisputes raised across every channel handled by this
   * router (signed close mismatches or invalid signatures).
   * @returns {PaymentDispute[]}
   */
  listDisputes() {
    return [...this.#disputes];
  }

  /**
   * Register a listener called whenever a PaymentDispute is raised on any
   * channel wired through this router.
   * @param {(dispute: PaymentDispute) => void} cb
   */
  onPaymentDispute(cb) {
    this.#disputeListeners.add(cb);
  }

  /**
   * Record a dispute and notify onPaymentDispute() listeners.
   * @param {PaymentDispute} dispute
   */
  #recordDispute(dispute) {
    this.#disputes.push(dispute);
    for (const cb of this.#disputeListeners) {
      try { cb(dispute); } catch (e) { silentCatch('clawser-mesh-payments', 'onPaymentDispute-callback', e) }
    }
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
        const { remotePodId, capacity, channelId, deposit } = payload;
        if (remotePodId !== this.#localPodId) return;

        // Adopt the initiator's channelId when they sent one. Signed updates
        // and close claims are keyed by channelId, so a locally-generated one
        // would make every message from the initiator fail the
        // 'Channel ID mismatch' check in receive().
        const ch = this.openChannel(
          fromPodId,
          capacity,
          typeof channelId === 'string' && channelId ? { channelId } : undefined,
        );

        // Adopt the initiator's deposit as our view of *their* balance, so
        // both sides start from the same numbers. Senders that predate this
        // field send no deposit; the channel is then left idle exactly as
        // before, which is the old (non-converging) behaviour rather than a
        // new failure.
        if (typeof deposit === 'number' && Number.isFinite(deposit) && deposit > 0) {
          ch.open(0, deposit);
        }
      } catch (e) { silentCatch('clawser-mesh-payments', 'ignore-duplicate-or-invalid-opens', e) }
    });

    // Inbound: channel payment update
    subscribeFn(PAYMENT_UPDATE, (payload, fromPodId) => {
      try {
        const ch = this.#channels.get(fromPodId);
        if (ch) {
          // ch.receive() is synchronous when the channel has no verifyFn
          // (unchanged legacy behavior) or returns a Promise that rejects
          // on an unsigned/invalid update when verification is active.
          const result = ch.receive(payload);
          if (result && typeof result.then === 'function') {
            result.catch((e) => silentCatch('clawser-mesh-payments', 'ignore-invalid-signed-update', e));
          }
        }
      } catch (e) { silentCatch('clawser-mesh-payments', 'ignore-invalid-updates', e) }
    });

    // Inbound: channel close
    subscribeFn(PAYMENT_CLOSE, (payload, fromPodId) => {
      try {
        const ch = this.#channels.get(fromPodId);

        if (ch && payload && payload.claim) {
          // Two-phase signed close: this is the initiator's signed claim.
          // Verify + cross-check against our own ledger, then either
          // co-sign an ack or raise a dispute -- never accept the wire
          // message's numbers unconditionally.
          Promise.resolve(ch.handleCloseMessage(payload.claim))
            .then((result) => {
              if (result.ok) {
                this.#channels.delete(fromPodId);
                this.broadcastClose(fromPodId, { ack: result.ack });
              } else {
                this.#recordDispute(result.dispute);
              }
            })
            .catch((e) => silentCatch('clawser-mesh-payments', 'handleCloseMessage', e));
          return;
        }

        if (ch && payload && payload.ack) {
          // Two-phase signed close: this is the counterparty's ack of our
          // claim. Verify + cross-check before finalizing.
          Promise.resolve(ch.finalizeClose(payload.ack))
            .then((result) => {
              if (result.ok) {
                this.#channels.delete(fromPodId);
              } else {
                this.#recordDispute(result.dispute);
              }
            })
            .catch((e) => silentCatch('clawser-mesh-payments', 'finalizeClose', e));
          return;
        }

        // Legacy unilateral close (no signing configured on this channel).
        this.closeChannel(fromPodId);
      } catch (e) { silentCatch('clawser-mesh-payments', 'this.closeChannel', e) }
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
   * The message carries the channel's id and this side's deposit as well as
   * its capacity. Both are what let the counterparty build a mirror that
   * agrees with ours: the id because signed updates and close claims are
   * keyed by it, the deposit because otherwise the receiver's `remoteBalance`
   * starts at 0 while ours starts at the deposit, and no later message ever
   * reconciles the difference.
   *
   * Defaults are read from the local channel to `remotePodId` when one
   * exists, so the normal sequence -- `openChannel()`, `open(deposit)`,
   * `broadcastOpen()` -- needs no extra arguments. Call this *after*
   * `open()`, or the deposit on the wire is 0.
   *
   * Wire compatibility: `channelId` and `deposit` are additional fields. A
   * peer running the older code ignores them and behaves as it did before;
   * this side ignores their absence in an incoming message the same way. Only
   * when both ends send them do the two views actually converge.
   *
   * @param {string} remotePodId
   * @param {number} [capacity] - Defaults to the local channel's capacity
   * @param {object} [opts]
   * @param {string} [opts.channelId] - Defaults to the local channel's id
   * @param {number} [opts.deposit] - Defaults to the local channel's current
   *   localBalance
   */
  broadcastOpen(remotePodId, capacity, opts = {}) {
    if (!this.#broadcastFn) return;
    const ch = this.#channels.get(remotePodId);
    const payload = {
      remotePodId,
      capacity: capacity != null ? capacity : ch?.capacity,
    };
    const channelId = opts.channelId != null ? opts.channelId : ch?.channelId;
    if (channelId != null) payload.channelId = channelId;
    const deposit = opts.deposit != null ? opts.deposit : ch?.localBalance;
    if (deposit != null) payload.deposit = deposit;
    this.#broadcastFn(PAYMENT_OPEN, payload);
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
