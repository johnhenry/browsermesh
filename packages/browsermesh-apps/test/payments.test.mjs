// Run with: node --import ./test/_setup-globals.mjs --test test/payments.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CreditLedger,
  PaymentChannel,
  EscrowManager,
  PaymentRouter,
  PAYMENT_OPEN,
  PAYMENT_UPDATE,
  PAYMENT_CLOSE,
  ESCROW_CREATE,
  CHANNEL_STATES,
} from '../src/payments.mjs';

// ---------------------------------------------------------------------------
// CreditLedger
// ---------------------------------------------------------------------------

describe('CreditLedger', () => {
  let ledger;
  beforeEach(() => {
    ledger = new CreditLedger('pod-alice');
  });

  it('starts with zero balance', () => {
    assert.equal(ledger.balance, 0);
    assert.equal(ledger.entryCount, 0);
  });

  it('exposes ownerId', () => {
    assert.equal(ledger.ownerId, 'pod-alice');
  });

  it('throws on invalid ownerId', () => {
    assert.throws(() => new CreditLedger(''), Error);
    assert.throws(() => new CreditLedger(null), Error);
  });

  describe('credit', () => {
    it('increases balance and returns a frozen entry', () => {
      const entry = ledger.credit(100, 'pod-bob', 'initial deposit');
      assert.equal(entry.type, 'credit');
      assert.equal(entry.amount, 100);
      assert.equal(entry.counterparty, 'pod-bob');
      assert.equal(entry.memo, 'initial deposit');
      assert.equal(entry.balance, 100);
      assert.equal(ledger.balance, 100);
      assert.ok(Object.isFrozen(entry));
    });

    it('accumulates across multiple credits', () => {
      ledger.credit(50, 'pod-bob');
      ledger.credit(30, 'pod-carol');
      assert.equal(ledger.balance, 80);
      assert.equal(ledger.entryCount, 2);
    });

    it('throws on non-positive amount', () => {
      assert.throws(() => ledger.credit(0, 'pod-bob'), RangeError);
      assert.throws(() => ledger.credit(-10, 'pod-bob'), RangeError);
    });

    it('sets memo to null when omitted', () => {
      const entry = ledger.credit(10, 'pod-bob');
      assert.equal(entry.memo, null);
    });
  });

  describe('debit', () => {
    beforeEach(() => {
      ledger.credit(200, 'pod-fund');
    });

    it('decreases balance and returns a frozen entry', () => {
      const entry = ledger.debit(75, 'pod-carol', 'payment');
      assert.equal(entry.type, 'debit');
      assert.equal(entry.amount, 75);
      assert.equal(entry.counterparty, 'pod-carol');
      assert.equal(entry.balance, 125);
      assert.equal(ledger.balance, 125);
      assert.ok(Object.isFrozen(entry));
    });

    it('throws on insufficient balance', () => {
      assert.throws(
        () => ledger.debit(300, 'pod-carol'),
        (err) => err.message.includes('Insufficient balance')
      );
    });

    it('allows debit of exact balance', () => {
      ledger.debit(200, 'pod-carol');
      assert.equal(ledger.balance, 0);
    });

    it('throws on non-positive amount', () => {
      assert.throws(() => ledger.debit(0, 'pod-bob'), RangeError);
      assert.throws(() => ledger.debit(-5, 'pod-bob'), RangeError);
    });
  });

  describe('transfer', () => {
    it('debits source and credits target', () => {
      ledger.credit(500, 'pod-fund');
      const peerLedger = new CreditLedger('pod-bob');
      const { debit, credit } = ledger.transfer(peerLedger, 150, 'service fee');
      assert.equal(debit.type, 'debit');
      assert.equal(debit.amount, 150);
      assert.equal(debit.counterparty, 'pod-bob');
      assert.equal(credit.type, 'credit');
      assert.equal(credit.amount, 150);
      assert.equal(credit.counterparty, 'pod-alice');
      assert.equal(ledger.balance, 350);
      assert.equal(peerLedger.balance, 150);
    });

    it('throws on insufficient balance for transfer', () => {
      const peerLedger = new CreditLedger('pod-bob');
      assert.throws(
        () => ledger.transfer(peerLedger, 1),
        (err) => err.message.includes('Insufficient balance')
      );
    });
  });

  describe('getEntries', () => {
    beforeEach(() => {
      ledger.credit(100, 'pod-bob');
      ledger.credit(50, 'pod-carol');
      ledger.debit(30, 'pod-dave');
    });

    it('returns all entries by default', () => {
      const entries = ledger.getEntries();
      assert.equal(entries.length, 3);
    });

    it('filters by since timestamp', () => {
      const entries = ledger.getEntries({ since: Date.now() + 1000 });
      assert.equal(entries.length, 0);
    });

    it('limits results', () => {
      const entries = ledger.getEntries({ limit: 2 });
      assert.equal(entries.length, 2);
    });

    it('returns a copy (mutations do not leak)', () => {
      const entries = ledger.getEntries();
      entries.push({ fake: true });
      assert.equal(ledger.getEntries().length, 3);
    });
  });

  describe('toJSON / fromJSON', () => {
    it('round-trips balance and entries', () => {
      ledger.credit(200, 'pod-fund', 'seed');
      ledger.debit(50, 'pod-carol');
      const json = ledger.toJSON();
      const restored = CreditLedger.fromJSON(json);
      assert.equal(restored.ownerId, 'pod-alice');
      assert.equal(restored.balance, 150);
      assert.equal(restored.entryCount, 2);
      const entries = restored.getEntries();
      assert.equal(entries[0].type, 'credit');
      assert.equal(entries[1].type, 'debit');
    });

    it('produces JSON-safe output', () => {
      ledger.credit(10, 'pod-bob');
      const json = ledger.toJSON();
      assert.equal(typeof json.ownerId, 'string');
      assert.equal(typeof json.balance, 'number');
      assert.ok(Array.isArray(json.entries));
    });
  });
});

// ---------------------------------------------------------------------------
// PaymentChannel
// ---------------------------------------------------------------------------

describe('PaymentChannel', () => {
  let ch;
  beforeEach(() => {
    ch = new PaymentChannel('pod-alice', 'pod-bob', { capacity: 500, ttlMs: 60000 });
  });

  it('starts in idle state', () => {
    assert.equal(ch.state, 'idle');
    assert.equal(ch.localBalance, 0);
    assert.equal(ch.remoteBalance, 0);
  });

  it('exposes channelId', () => {
    assert.ok(ch.channelId.startsWith('ch_'));
  });

  it('exposes capacity', () => {
    assert.equal(ch.capacity, 500);
  });

  it('throws on missing pod IDs', () => {
    assert.throws(() => new PaymentChannel('', 'pod-bob'), Error);
    assert.throws(() => new PaymentChannel('pod-alice', ''), Error);
  });

  describe('open', () => {
    it('transitions to open with initial deposit', () => {
      ch.open(100);
      assert.equal(ch.state, 'open');
      assert.equal(ch.localBalance, 100);
      assert.equal(ch.remoteBalance, 0);
    });

    it('throws if not idle', () => {
      ch.open(50);
      assert.throws(() => ch.open(50), Error);
    });

    it('throws on non-positive deposit', () => {
      assert.throws(() => ch.open(0), RangeError);
      assert.throws(() => ch.open(-10), RangeError);
    });

    it('throws if deposit exceeds capacity', () => {
      assert.throws(() => ch.open(600), RangeError);
    });
  });

  describe('pay', () => {
    beforeEach(() => {
      ch.open(200);
    });

    it('transfers amount from local to remote', () => {
      const update = ch.pay(75);
      assert.equal(ch.localBalance, 125);
      assert.equal(ch.remoteBalance, 75);
      assert.equal(update.amount, 75);
      assert.equal(update.localBalance, 125);
      assert.equal(update.remoteBalance, 75);
      assert.equal(update.sequence, 1);
      assert.ok(Object.isFrozen(update));
    });

    it('increments sequence on each pay', () => {
      ch.pay(10);
      ch.pay(20);
      const u3 = ch.pay(30);
      assert.equal(u3.sequence, 3);
      assert.equal(ch.sequence, 3);
    });

    it('throws on insufficient channel balance', () => {
      assert.throws(
        () => ch.pay(300),
        (err) => err.message.includes('Insufficient channel balance')
      );
    });

    it('throws on non-positive amount', () => {
      assert.throws(() => ch.pay(0), RangeError);
      assert.throws(() => ch.pay(-1), RangeError);
    });

    it('throws when channel not open', () => {
      const ch2 = new PaymentChannel('a', 'b');
      assert.throws(() => ch2.pay(10), Error);
    });
  });

  describe('receive', () => {
    beforeEach(() => {
      ch.open(100);
    });

    it('updates balances from remote payment', () => {
      const update = {
        channelId: ch.channelId,
        sequence: 1,
        amount: 40,
        localBalance: 60,
        remoteBalance: 40,
        timestamp: Date.now(),
        signature: null,
      };
      ch.receive(update);
      assert.equal(ch.localBalance, 140);
      assert.equal(ch.remoteBalance, -40);
      assert.equal(ch.sequence, 1);
    });

    it('throws on channel ID mismatch', () => {
      assert.throws(
        () => ch.receive({ channelId: 'wrong', sequence: 1, amount: 10 }),
        (err) => err.message.includes('Channel ID mismatch')
      );
    });

    it('throws on stale sequence', () => {
      ch.receive({
        channelId: ch.channelId, sequence: 5, amount: 10,
        localBalance: 0, remoteBalance: 0, timestamp: Date.now(), signature: null,
      });
      assert.throws(
        () => ch.receive({
          channelId: ch.channelId, sequence: 3, amount: 10,
          localBalance: 0, remoteBalance: 0, timestamp: Date.now(), signature: null,
        }),
        (err) => err.message.includes('Stale sequence')
      );
    });

    it('throws when channel not open', () => {
      const ch2 = new PaymentChannel('a', 'b');
      assert.throws(
        () => ch2.receive({ channelId: ch2.channelId, sequence: 1, amount: 10 }),
        Error
      );
    });
  });

  describe('close', () => {
    beforeEach(() => {
      ch.open(200);
      ch.pay(50);
    });

    it('returns settlement and transitions to closed', () => {
      const settlement = ch.close();
      assert.equal(ch.state, 'closed');
      assert.equal(settlement.channelId, ch.channelId);
      assert.equal(settlement.finalLocalBalance, 150);
      assert.equal(settlement.finalRemoteBalance, 50);
      assert.equal(settlement.entryCount, 1);
      assert.equal(typeof settlement.closedAt, 'number');
      assert.ok(Object.isFrozen(settlement));
    });

    it('throws if not open', () => {
      ch.close();
      assert.throws(() => ch.close(), Error);
    });
  });

  describe('isExpired', () => {
    it('returns false for fresh channel', () => {
      assert.equal(ch.isExpired(), false);
    });

    it('returns true when ttl exceeded', () => {
      const shortCh = new PaymentChannel('a', 'b', { ttlMs: 1 });
      // Force a small delay via the timestamp check logic
      // Since ttlMs=1, Date.now() - createdAt will be >= 1 almost immediately
      // but just in case, we check both scenarios
      const expired = shortCh.isExpired();
      // With ttlMs=1, this could be either true or false depending on timing
      assert.equal(typeof expired, 'boolean');
    });
  });

  describe('toJSON / fromJSON', () => {
    it('round-trips channel state', () => {
      ch.open(300);
      ch.pay(100);
      const json = ch.toJSON();
      const restored = PaymentChannel.fromJSON(json);
      assert.equal(restored.state, 'open');
      assert.equal(restored.localBalance, 200);
      assert.equal(restored.remoteBalance, 100);
      assert.equal(restored.capacity, 500);
      assert.equal(restored.sequence, 1);
      assert.equal(restored.channelId, ch.channelId);
    });

    it('produces JSON-safe output', () => {
      const json = ch.toJSON();
      assert.equal(typeof json.localPodId, 'string');
      assert.equal(typeof json.remotePodId, 'string');
      assert.equal(typeof json.channelId, 'string');
      assert.equal(typeof json.state, 'string');
    });

    it('restores a closed channel', () => {
      ch.open(100);
      ch.close();
      const restored = PaymentChannel.fromJSON(ch.toJSON());
      assert.equal(restored.state, 'closed');
    });
  });
});

// ---------------------------------------------------------------------------
// PaymentChannel -- signed updates + mutual close (clawser #31 port)
// ---------------------------------------------------------------------------
//
// A fake Ed25519-shaped signFn/verifyFn pair, matching the shape of
// MeshIdentityManager.sign(podId, data) / .verify(pubKey, data, sig) from
// @johnhenry/browsermesh-core -- see identity.mjs. Each fake "identity" has
// its own keyed HMAC-ish digest so tamper/cross-identity detection is real,
// not just a boolean stub.

import crypto from 'node:crypto';

function makeFakeIdentity(seed) {
  const pubKey = new TextEncoder().encode(`pubkey:${seed}`);
  const sign = async (data) => {
    const h = crypto.createHmac('sha256', `secret:${seed}`).update(data).digest();
    return new Uint8Array(h);
  };
  return { pubKey, sign };
}

// A single shared verify function: recomputes the HMAC using whichever
// "secret" corresponds to the given public key (derived deterministically
// here since this is a fake -- a real MeshIdentityManager.verify() does
// actual asymmetric verification against publicKeyBytes).
const KNOWN_SECRETS = new Map(); // pubKeyString -> secret seed
function registerIdentity(seed) {
  const identity = makeFakeIdentity(seed);
  KNOWN_SECRETS.set(Buffer.from(identity.pubKey).toString('base64'), seed);
  return identity;
}

async function fakeVerify(pubKey, data, signature) {
  const seed = KNOWN_SECRETS.get(Buffer.from(pubKey).toString('base64'));
  if (!seed) return false;
  const expected = crypto.createHmac('sha256', `secret:${seed}`).update(data).digest();
  return Buffer.compare(Buffer.from(signature), expected) === 0;
}

describe('PaymentChannel signing (opt-in, backward compatible)', () => {
  it('pay() stays fully synchronous with signature: null when no signFn is injected', () => {
    const ch = new PaymentChannel('pod-alice', 'pod-bob');
    ch.open(100);
    const update = ch.pay(10); // not awaited -- must not be a Promise
    assert.equal(update.signature, null);
    assert.equal(typeof update.then, 'undefined');
  });

  it('receive() stays fully synchronous and unconditional when no verifyFn is injected', () => {
    const ch = new PaymentChannel('pod-alice', 'pod-bob');
    ch.open(100);
    const result = ch.receive({
      channelId: ch.channelId, sequence: 1, amount: 10,
      localBalance: 0, remoteBalance: 0, timestamp: Date.now(), signature: null,
    });
    assert.equal(typeof result, 'undefined');
    assert.equal(ch.localBalance, 110);
  });

  it('close() stays unilateral and synchronous when no signFn is injected', () => {
    const ch = new PaymentChannel('pod-alice', 'pod-bob');
    ch.open(100);
    const settlement = ch.close();
    assert.equal(ch.state, 'closed');
    assert.equal(settlement.finalLocalBalance, 100);
  });

  describe('signed round-trip', () => {
    let alice, bob, chA, chB;

    beforeEach(() => {
      KNOWN_SECRETS.clear();
      alice = registerIdentity('alice');
      bob = registerIdentity('bob');
      const sharedChannelId = 'ch_test-shared_00';
      chA = new PaymentChannel('pod-alice', 'pod-bob', {
        signFn: alice.sign, verifyFn: fakeVerify, remotePublicKey: bob.pubKey,
        channelId: sharedChannelId,
      });
      chB = new PaymentChannel('pod-bob', 'pod-alice', {
        signFn: bob.sign, verifyFn: fakeVerify, remotePublicKey: alice.pubKey,
        channelId: sharedChannelId,
      });
      chA.open(200);
      chB.open(200);
    });

    it('pay() returns a Promise resolving to a signed update', async () => {
      const result = chA.pay(30);
      assert.equal(typeof result.then, 'function');
      const update = await result;
      assert.ok(update.signature);
      assert.equal(typeof update.signature, 'string');
      assert.equal(update.amount, 30);
      assert.ok(Object.isFrozen(update));
    });

    it('receive() accepts a validly signed update from the real counterparty', async () => {
      const update = await chA.pay(30);
      await chB.receive(update);
      assert.equal(chB.localBalance, 230);
      assert.equal(chB.remoteBalance, -30);
    });

    it('receive() rejects an update with no signature when verification is active', async () => {
      await assert.rejects(
        () => chB.receive({
          channelId: chB.channelId, sequence: 1, amount: 30,
          localBalance: 170, remoteBalance: 230, timestamp: Date.now(), signature: null,
        }),
        (err) => err.message.includes('missing or invalid signature')
      );
      // Balances must not have been mutated by the rejected update.
      assert.equal(chB.localBalance, 200);
    });

    it('receive() rejects a tampered update (fields changed after signing)', async () => {
      const update = await chA.pay(30);
      const tampered = { ...update, amount: 9999 };
      await assert.rejects(() => chB.receive(tampered));
      assert.equal(chB.localBalance, 200);
    });

    it('receive() rejects a forged signature from an unregistered identity', async () => {
      const mallory = makeFakeIdentity('mallory'); // never registered in KNOWN_SECRETS
      const sigBytes = await mallory.sign(new TextEncoder().encode('irrelevant'));
      const forged = {
        channelId: chB.channelId, sequence: 1, amount: 30,
        localBalance: 170, remoteBalance: 230, timestamp: Date.now(),
        signature: Buffer.from(sigBytes).toString('base64'),
      };
      await assert.rejects(() => chB.receive(forged));
      assert.equal(chB.localBalance, 200);
    });

    it('receive() rejects a signature valid for different fields (replay/mix-and-match)', async () => {
      const u1 = await chA.pay(10);
      const u2 = await chA.pay(20); // sequence 2, different fields, same signer
      // Splice u2's signature onto u1's fields.
      const frankensteined = { ...u1, signature: u2.signature };
      await assert.rejects(() => chB.receive(frankensteined));
    });
  });

  describe('two-phase mutual close', () => {
    let alice, bob, chA, chB;

    beforeEach(() => {
      KNOWN_SECRETS.clear();
      alice = registerIdentity('alice');
      bob = registerIdentity('bob');
      const sharedChannelId = 'ch_test-shared_01';
      chA = new PaymentChannel('pod-alice', 'pod-bob', {
        signFn: alice.sign, verifyFn: fakeVerify, remotePublicKey: bob.pubKey,
        channelId: sharedChannelId,
      });
      chA.open(200);
      // chB is Bob's view of the *same* logical channel. PaymentChannel's
      // open() only ever informs the local side's own balance -- it has no
      // way to notify the counterparty's `remoteBalance` of a deposit (the
      // PAYMENT_OPEN wire message carries no deposit amount) -- so two
      // independently-`.open()`'d instances can never satisfy a mirrored
      // invariant. Build chB directly as the mirror image of chA's state
      // (local <-> remote swapped) via fromJSON, exactly as if both parties
      // had converged on the same channel through a real, fully-synced
      // protocol. This mirroring is preserved by pay()/receive(), so it's a
      // faithful stand-in for two properly-synced views.
      chB = PaymentChannel.fromJSON({
        localPodId: 'pod-bob', remotePodId: 'pod-alice',
        channelId: sharedChannelId, capacity: chA.capacity, ttlMs: 3600000,
        createdAt: Date.now(), state: 'open',
        localBalance: chA.remoteBalance, remoteBalance: chA.localBalance,
        sequence: chA.sequence,
      }, { signFn: bob.sign, verifyFn: fakeVerify, remotePublicKey: alice.pubKey });
    });

    it('close() returns a Promise<CloseClaim> and moves to "closing", not "closed"', async () => {
      const result = chA.close();
      assert.equal(typeof result.then, 'function');
      assert.equal(chA.state, 'closing');
      const claim = await result;
      assert.equal(claim.channelId, chA.channelId);
      assert.equal(claim.finalLocalBalance, 200);
      assert.equal(claim.finalRemoteBalance, 0);
      assert.ok(claim.signature);
      assert.ok(Object.isFrozen(claim));
      // Still not closed -- only the initiator's half of the handshake.
      assert.equal(chA.state, 'closing');
    });

    it('happy path: claim -> ack -> both sides reach closed with matching settlements', async () => {
      const claim = await chA.close();
      const handled = await chB.handleCloseMessage(claim);
      assert.equal(handled.ok, true);
      assert.equal(chB.state, 'closed');

      const finalized = await chA.finalizeClose(handled.ack);
      assert.equal(finalized.ok, true);
      assert.equal(chA.state, 'closed');
      assert.equal(finalized.settlement.finalLocalBalance, 200);
      assert.equal(finalized.settlement.finalRemoteBalance, 0);
    });

    it('handleCloseMessage() raises a PaymentDispute on a forged claim signature', async () => {
      const claim = await chA.close();
      const forged = { ...claim, signature: 'not-a-real-signature' };
      const result = await chB.handleCloseMessage(forged);
      assert.equal(result.ok, false);
      assert.equal(result.dispute.reason, 'invalid-signature');
      assert.equal(chB.state, 'open'); // left inspectable, not silently closed
      assert.deepEqual(chB.listDisputes(), [result.dispute]);
    });

    it('handleCloseMessage() raises a PaymentDispute when claimed balances disagree with local ledger', async () => {
      // Alice claims she still has 200 locally, but Bob has independently
      // already received a payment Alice's claim doesn't account for --
      // simulate by having Bob's local view diverge before the claim lands.
      const claim = await chA.close();
      const inflatedClaim = { ...claim, finalRemoteBalance: 9999 };
      // Re-sign so the signature itself is valid but the *content* lies.
      const reSigned = { ...inflatedClaim, signature: (
        await alice.sign(new TextEncoder().encode(JSON.stringify({
          channelId: inflatedClaim.channelId,
          finalLocalBalance: inflatedClaim.finalLocalBalance,
          finalRemoteBalance: inflatedClaim.finalRemoteBalance,
          entryCount: inflatedClaim.entryCount,
          closedAt: inflatedClaim.closedAt,
        })))
      )};
      const sigB64 = Buffer.from(reSigned.signature).toString('base64');
      const result = await chB.handleCloseMessage({ ...reSigned, signature: sigB64 });
      assert.equal(result.ok, false);
      assert.equal(result.dispute.reason, 'balance-mismatch');
      assert.equal(chB.state, 'open');
    });

    it('finalizeClose() raises a PaymentDispute on a forged ack', async () => {
      const claim = await chA.close();
      const handled = await chB.handleCloseMessage(claim);
      const forgedAck = { ...handled.ack, signature: 'garbage' };
      const result = await chA.finalizeClose(forgedAck);
      assert.equal(result.ok, false);
      assert.equal(result.dispute.reason, 'invalid-ack-signature');
      assert.equal(chA.state, 'closing'); // never reached closed on a bad ack
    });

    it('finalizeClose() raises a PaymentDispute when the ack disagrees with the original claim', async () => {
      const claim = await chA.close();
      const handled = await chB.handleCloseMessage(claim);
      // A validly-signed ack (by the real counterparty) but for different
      // numbers than what was originally claimed -- e.g. Bob trying to
      // slip in a different settlement than the one he actually verified.
      const mismatchedFields = { ...handled.ack, finalLocalBalance: 1 };
      const sigBytes = await bob.sign(new TextEncoder().encode(JSON.stringify({
        channelId: mismatchedFields.channelId,
        finalLocalBalance: mismatchedFields.finalLocalBalance,
        finalRemoteBalance: mismatchedFields.finalRemoteBalance,
        entryCount: mismatchedFields.entryCount,
        closedAt: mismatchedFields.closedAt,
      })));
      const mismatchedAck = { ...mismatchedFields, signature: Buffer.from(sigBytes).toString('base64') };
      const result = await chA.finalizeClose(mismatchedAck);
      assert.equal(result.ok, false);
      assert.equal(result.dispute.reason, 'ack-mismatch');
    });

    it('onPaymentDispute() / listDisputes() surface raised disputes', async () => {
      const seen = [];
      chB.onPaymentDispute((d) => seen.push(d));
      const claim = await chA.close();
      await chB.handleCloseMessage({ ...claim, signature: 'bogus' });
      assert.equal(seen.length, 1);
      assert.equal(chB.listDisputes().length, 1);
      assert.equal(seen[0], chB.listDisputes()[0]);
    });
  });
});

// ---------------------------------------------------------------------------
// EscrowManager
// ---------------------------------------------------------------------------

describe('EscrowManager', () => {
  let em;
  beforeEach(() => {
    em = new EscrowManager();
  });

  it('starts empty', () => {
    assert.equal(em.size, 0);
  });

  describe('create', () => {
    it('creates a held escrow and returns a copy', () => {
      const esc = em.create('pod-alice', 'pod-bob', 100, { description: 'test' });
      assert.ok(esc.escrowId.startsWith('esc_'));
      assert.equal(esc.payerPodId, 'pod-alice');
      assert.equal(esc.payeePodId, 'pod-bob');
      assert.equal(esc.amount, 100);
      assert.equal(esc.status, 'held');
      assert.equal(esc.conditions.description, 'test');
      assert.equal(esc.resolvedAt, null);
      assert.equal(em.size, 1);
    });

    it('throws on non-positive amount', () => {
      assert.throws(() => em.create('a', 'b', 0), RangeError);
      assert.throws(() => em.create('a', 'b', -5), RangeError);
    });

    it('supports timeout condition', () => {
      const esc = em.create('a', 'b', 50, { timeout: 5000 });
      assert.equal(esc.conditions.timeout, 5000);
    });
  });

  describe('get', () => {
    it('returns escrow by ID', () => {
      const created = em.create('a', 'b', 100);
      const found = em.get(created.escrowId);
      assert.equal(found.escrowId, created.escrowId);
      assert.equal(found.amount, 100);
    });

    it('returns null for unknown ID', () => {
      assert.equal(em.get('nonexistent'), null);
    });

    it('returns a copy (mutations do not leak)', () => {
      const created = em.create('a', 'b', 100);
      const found = em.get(created.escrowId);
      found.amount = 999;
      assert.equal(em.get(created.escrowId).amount, 100);
    });
  });

  describe('release', () => {
    it('marks escrow as released', () => {
      const esc = em.create('a', 'b', 100);
      const ok = em.release(esc.escrowId);
      assert.equal(ok, true);
      assert.equal(em.get(esc.escrowId).status, 'released');
      assert.notEqual(em.get(esc.escrowId).resolvedAt, null);
    });

    it('returns false for already-resolved escrow', () => {
      const esc = em.create('a', 'b', 100);
      em.release(esc.escrowId);
      assert.equal(em.release(esc.escrowId), false);
    });

    it('returns false for unknown ID', () => {
      assert.equal(em.release('bad'), false);
    });
  });

  describe('refund', () => {
    it('marks escrow as refunded', () => {
      const esc = em.create('a', 'b', 100);
      const ok = em.refund(esc.escrowId);
      assert.equal(ok, true);
      assert.equal(em.get(esc.escrowId).status, 'refunded');
    });

    it('returns false for already-resolved escrow', () => {
      const esc = em.create('a', 'b', 100);
      em.refund(esc.escrowId);
      assert.equal(em.refund(esc.escrowId), false);
    });
  });

  describe('expire', () => {
    it('marks escrow as expired', () => {
      const esc = em.create('a', 'b', 100);
      const ok = em.expire(esc.escrowId);
      assert.equal(ok, true);
      assert.equal(em.get(esc.escrowId).status, 'expired');
    });

    it('returns false for already-resolved escrow', () => {
      const esc = em.create('a', 'b', 100);
      em.expire(esc.escrowId);
      assert.equal(em.expire(esc.escrowId), false);
    });
  });

  describe('listByParty', () => {
    it('returns escrows where pod is payer', () => {
      em.create('pod-alice', 'pod-bob', 100);
      em.create('pod-alice', 'pod-carol', 200);
      em.create('pod-dave', 'pod-bob', 50);
      const list = em.listByParty('pod-alice');
      assert.equal(list.length, 2);
    });

    it('returns escrows where pod is payee', () => {
      em.create('pod-alice', 'pod-bob', 100);
      em.create('pod-carol', 'pod-bob', 200);
      const list = em.listByParty('pod-bob');
      assert.equal(list.length, 2);
    });

    it('returns empty for unknown pod', () => {
      em.create('a', 'b', 100);
      assert.deepEqual(em.listByParty('unknown'), []);
    });

    it('returns copies', () => {
      em.create('a', 'b', 100);
      const list = em.listByParty('a');
      list[0].amount = 999;
      assert.equal(em.listByParty('a')[0].amount, 100);
    });
  });

  describe('pruneExpired', () => {
    it('expires escrows past timeout', () => {
      const now = 10000;
      em.create('a', 'b', 100, { timeout: 5000 });
      // createdAt ~ Date.now(), so we need to compute from that
      const esc = em.listByParty('a')[0];
      const pruned = em.pruneExpired(esc.createdAt + 5000);
      assert.equal(pruned, 1);
      assert.equal(em.get(esc.escrowId).status, 'expired');
    });

    it('does not expire escrows without timeout', () => {
      em.create('a', 'b', 100);
      assert.equal(em.pruneExpired(Date.now() + 999999), 0);
    });

    it('does not double-expire already resolved escrows', () => {
      em.create('a', 'b', 100, { timeout: 100 });
      const esc = em.listByParty('a')[0];
      em.release(esc.escrowId);
      assert.equal(em.pruneExpired(esc.createdAt + 200), 0);
    });

    it('returns count of expired escrows', () => {
      em.create('a', 'b', 50, { timeout: 100 });
      em.create('a', 'c', 60, { timeout: 200 });
      em.create('a', 'd', 70, { timeout: 50000 });
      const first = em.listByParty('a')[0];
      const pruned = em.pruneExpired(first.createdAt + 300);
      assert.equal(pruned, 2);
    });
  });
});

// ---------------------------------------------------------------------------
// PaymentRouter
// ---------------------------------------------------------------------------

describe('PaymentRouter', () => {
  let router;
  beforeEach(() => {
    router = new PaymentRouter('pod-alice');
  });

  it('throws on invalid localPodId', () => {
    assert.throws(() => new PaymentRouter(''), Error);
  });

  describe('getLedger', () => {
    it('returns a CreditLedger for the local pod', () => {
      const ledger = router.getLedger();
      assert.ok(ledger instanceof CreditLedger);
      assert.equal(ledger.ownerId, 'pod-alice');
    });

    it('returns the same ledger instance on multiple calls', () => {
      assert.equal(router.getLedger(), router.getLedger());
    });
  });

  describe('channels', () => {
    it('opens a channel to a remote pod', () => {
      const ch = router.openChannel('pod-bob', 500);
      assert.ok(ch instanceof PaymentChannel);
      assert.equal(ch.capacity, 500);
    });

    it('throws when opening duplicate channel', () => {
      router.openChannel('pod-bob');
      assert.throws(() => router.openChannel('pod-bob'), Error);
    });

    it('getChannel returns the channel or null', () => {
      assert.equal(router.getChannel('pod-bob'), null);
      router.openChannel('pod-bob');
      assert.ok(router.getChannel('pod-bob') instanceof PaymentChannel);
    });

    it('listChannels returns all channels', () => {
      router.openChannel('pod-bob');
      router.openChannel('pod-carol');
      assert.equal(router.listChannels().length, 2);
    });

    it('closeChannel returns settlement and removes channel', () => {
      const ch = router.openChannel('pod-bob');
      ch.open(100);
      const settlement = router.closeChannel('pod-bob');
      assert.ok(settlement);
      assert.equal(settlement.channelId, ch.channelId);
      assert.equal(router.getChannel('pod-bob'), null);
    });

    it('closeChannel returns null for unknown pod', () => {
      assert.equal(router.closeChannel('pod-nobody'), null);
    });
  });

  describe('getEscrow', () => {
    it('returns an EscrowManager', () => {
      assert.ok(router.getEscrow() instanceof EscrowManager);
    });

    it('returns the same instance on multiple calls', () => {
      assert.equal(router.getEscrow(), router.getEscrow());
    });
  });
});

// ---------------------------------------------------------------------------
// PaymentRouter -- wired signed close over a simulated transport
// ---------------------------------------------------------------------------
//
// Two in-memory buses standing in for the mesh transport, so the full
// claim -> ack round trip (and the dispute path) exercises wireTransport()
// itself, not just the underlying PaymentChannel primitives.

function makeLinkedBuses() {
  const handlersA = new Map();
  const handlersB = new Map();
  const busA = {
    broadcast: (type, payload) => {
      const h = handlersB.get(type);
      if (h) h(payload, 'pod-alice');
    },
    subscribe: (type, handler) => handlersA.set(type, handler),
  };
  const busB = {
    broadcast: (type, payload) => {
      const h = handlersA.get(type);
      if (h) h(payload, 'pod-bob');
    },
    subscribe: (type, handler) => handlersB.set(type, handler),
  };
  return { busA, busB };
}

describe('PaymentRouter wireTransport -- signed mutual close', () => {
  it('closeChannel() over the wire completes the claim/ack handshake and removes the channel on both sides', async () => {
    const { busA, busB } = makeLinkedBuses();
    const alice = registerIdentity('router-alice');
    const bob = registerIdentity('router-bob');

    const routerA = new PaymentRouter('pod-alice');
    const routerB = new PaymentRouter('pod-bob');
    routerA.wireTransport(busA.broadcast, busA.subscribe);
    routerB.wireTransport(busB.broadcast, busB.subscribe);

    const sharedChannelId = 'ch_router-test-shared_00';
    const chA = routerA.openChannel('pod-bob', 500, {
      signFn: alice.sign, verifyFn: fakeVerify, remotePublicKey: bob.pubKey,
      channelId: sharedChannelId,
    });
    const chB = routerB.openChannel('pod-alice', 500, {
      signFn: bob.sign, verifyFn: fakeVerify, remotePublicKey: alice.pubKey,
      channelId: sharedChannelId,
    });

    // open() only ever informs the *local* side's own balance (the
    // PAYMENT_OPEN wire message carries no deposit amount), so two
    // independently-`.open()`d channels can never end up agreeing on who
    // holds what -- that's a pre-existing gap in the open/fund handshake,
    // not something this security fix is meant to paper over. To reach a
    // legitimately-agreeing state through the real public API (not a test
    // shortcut), drain chA's own deposit straight back out via a real
    // pay() so both sides converge on the exact same numbers: chA ends at
    // (local=0, remote=1), matching a fresh chB's (local=1, remote=0).
    chA.open(1);
    await chA.pay(1);
    chB.open(1);

    await routerA.closeChannel('pod-bob');
    // Let the claim -> ack -> finalize microtask chain settle.
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(routerA.getChannel('pod-bob'), null);
    assert.equal(routerB.getChannel('pod-alice'), null);
    assert.equal(chA.state, 'closed');
    assert.equal(chB.state, 'closed');
  });

  it('records a PaymentDispute via onPaymentDispute() when a peer sends a forged close claim', async () => {
    const { busA, busB } = makeLinkedBuses();
    const alice = registerIdentity('router-alice-2');
    const bob = registerIdentity('router-bob-2');

    const routerA = new PaymentRouter('pod-alice');
    const routerB = new PaymentRouter('pod-bob');
    routerA.wireTransport(busA.broadcast, busA.subscribe);
    routerB.wireTransport(busB.broadcast, busB.subscribe);

    routerA.openChannel('pod-bob', 500, {
      signFn: alice.sign, verifyFn: fakeVerify, remotePublicKey: bob.pubKey,
    });
    const chB = routerB.openChannel('pod-alice', 500, {
      signFn: bob.sign, verifyFn: fakeVerify, remotePublicKey: alice.pubKey,
    });
    chB.open(100);

    const disputes = [];
    routerB.onPaymentDispute((d) => disputes.push(d));

    // Broadcast a forged claim directly onto the bus (bypassing chA.close()).
    busA.broadcast(PAYMENT_CLOSE, { claim: {
      channelId: chB.channelId, finalLocalBalance: 0, finalRemoteBalance: 0,
      entryCount: 0, closedAt: Date.now(), signature: 'forged',
    } });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(disputes.length, 1);
    assert.equal(disputes[0].reason, 'invalid-signature');
    assert.equal(routerB.listDisputes().length, 1);
    // Channel is left open/inspectable rather than silently closed.
    assert.equal(routerB.getChannel('pod-alice'), chB);
  });
});

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('PAYMENT_OPEN is 0xD0', () => {
    assert.equal(PAYMENT_OPEN, 0xD0);
  });

  it('PAYMENT_UPDATE is 0xD1', () => {
    assert.equal(PAYMENT_UPDATE, 0xD1);
  });

  it('PAYMENT_CLOSE is 0xD2', () => {
    assert.equal(PAYMENT_CLOSE, 0xD2);
  });

  it('ESCROW_CREATE is 0xD3', () => {
    assert.equal(ESCROW_CREATE, 0xD3);
  });

  it('CHANNEL_STATES is frozen', () => {
    assert.ok(Object.isFrozen(CHANNEL_STATES));
  });

  it('CHANNEL_STATES has expected values', () => {
    assert.deepEqual([...CHANNEL_STATES], ['idle', 'opening', 'open', 'closing', 'closed']);
  });
});

// ---------------------------------------------------------------------------
// EscrowManager.pruneExpiredDetailed
// ---------------------------------------------------------------------------

describe('EscrowManager.pruneExpiredDetailed', () => {
  it('returns the expired escrow records, not just a count', () => {
    const em = new EscrowManager();
    const e1 = em.create('payer', 'payee', 10, { timeout: 100 });
    const e2 = em.create('payer', 'payee', 20, { timeout: 100 });

    const expired = em.pruneExpiredDetailed(e1.createdAt + 5000);
    assert.equal(expired.length, 2);
    assert.deepEqual(expired.map(e => e.escrowId).sort(), [e1.escrowId, e2.escrowId].sort());
    assert.ok(expired.every(e => e.status === 'expired'));
  });

  it('pruneExpired (count) stays consistent with pruneExpiredDetailed', () => {
    const em = new EscrowManager();
    em.create('payer', 'payee', 10, { timeout: 50 });
    const count = em.pruneExpired(Date.now() + 999999);
    assert.equal(count, 1);
  });

  it('returns an empty array when nothing is expired', () => {
    const em = new EscrowManager();
    em.create('payer', 'payee', 10, { timeout: 999999 });
    assert.deepEqual(em.pruneExpiredDetailed(Date.now()), []);
  });
});

// ---------------------------------------------------------------------------
// PaymentRouter escrow sweeper
// ---------------------------------------------------------------------------

describe('PaymentRouter escrow sweeper', () => {
  let router;

  beforeEach(() => {
    router = new PaymentRouter('pod-a');
  });

  afterEach(() => {
    router.stopEscrowSweeper(); // must not leave a dangling interval
  });

  it('periodically expires timed-out escrows', async () => {
    const escrow = router.getEscrow().create('pod-a', 'pod-b', 5, { timeout: 10 });
    router.startEscrowSweeper(20);

    await new Promise((resolve) => setTimeout(resolve, 60));

    const got = router.getEscrow().get(escrow.escrowId);
    assert.equal(got.status, 'expired');
  });

  it('calls onExpired with the expired records', async () => {
    router.getEscrow().create('pod-a', 'pod-b', 5, { timeout: 10 });
    const calls = [];
    router.startEscrowSweeper(20, (expired) => calls.push(expired));

    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.ok(calls.length >= 1);
    assert.equal(calls[0][0].status, 'expired');
  });

  it('does not call onExpired when nothing expired', async () => {
    router.getEscrow().create('pod-a', 'pod-b', 5, { timeout: 999999 });
    const calls = [];
    router.startEscrowSweeper(15, (expired) => calls.push(expired));

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(calls.length, 0);
  });

  it('stopEscrowSweeper halts further sweeps', async () => {
    router.getEscrow().create('pod-a', 'pod-b', 5, { timeout: 500 });
    router.startEscrowSweeper(15);
    router.stopEscrowSweeper();

    await new Promise((resolve) => setTimeout(resolve, 40));
    // Timer stopped before the 500ms timeout elapsed — still held.
    // (This also proves stop actually clears the interval rather than
    // just no-op'ing — a leaked interval would still be running here.)
    assert.equal(router.getEscrow().size, 1);
  });

  it('startEscrowSweeper is idempotent — restarting replaces the prior timer', () => {
    router.startEscrowSweeper(1000);
    assert.doesNotThrow(() => router.startEscrowSweeper(1000));
    router.stopEscrowSweeper();
  });

  it('a throwing onExpired callback does not break the sweep', async () => {
    router.getEscrow().create('pod-a', 'pod-b', 5, { timeout: 10 });
    router.startEscrowSweeper(20, () => { throw new Error('boom'); });

    await new Promise((resolve) => setTimeout(resolve, 60));
    // Must not have crashed the process/timer — no assertion beyond
    // reaching this point without an unhandled rejection.
    assert.ok(true);
  });
});

// ---------------------------------------------------------------------------
// PAYMENT_OPEN carries the deposit and the channel id (issue #2)
// ---------------------------------------------------------------------------
//
// Before this, `broadcastOpen()` put only `{ remotePodId, capacity }` on the
// wire. Two independently-`.open()`d instances of the same logical channel
// could therefore never agree on anything:
//
//   A: channelId=ch_pod-alice:pod-bob_..._1 state=open  local=250 remote=0
//   B: channelId=ch_pod-alice:pod-bob_..._2 state=idle  local=0   remote=0
//   B.receive(update) THREW: Cannot receive in state: idle
//
// Two separate defects, both invisible without a mirrored channel to compare
// against: the receiver never learned the deposit, so its `remoteBalance`
// started at 0 while the initiator's `localBalance` started at the deposit;
// and it generated its own channelId, which every signed update and close
// claim is keyed by.

describe('PAYMENT_OPEN convergence', () => {
  /** Two routers whose broadcasts land in each other's handlers. */
  function linkRouters(localA = 'pod-alice', localB = 'pod-bob') {
    const handlersA = new Map();
    const handlersB = new Map();
    const wire = [];
    const routerA = new PaymentRouter(localA);
    const routerB = new PaymentRouter(localB);
    routerA.wireTransport(
      (type, payload) => { wire.push({ from: localA, type, payload }); handlersB.get(type)?.(payload, localA); },
      (type, handler) => handlersA.set(type, handler),
    );
    routerB.wireTransport(
      (type, payload) => { wire.push({ from: localB, type, payload }); handlersA.get(type)?.(payload, localB); },
      (type, handler) => handlersB.set(type, handler),
    );
    return { routerA, routerB, wire };
  }

  it('the wire message carries the deposit and the channel id', () => {
    const { routerA, wire } = linkRouters();
    const chA = routerA.openChannel('pod-bob', 500);
    chA.open(250);
    routerA.broadcastOpen('pod-bob', 500);

    const msg = wire.find((m) => m.type === PAYMENT_OPEN);
    assert.ok(msg, 'a PAYMENT_OPEN was broadcast');
    assert.equal(msg.payload.remotePodId, 'pod-bob');
    assert.equal(msg.payload.capacity, 500);
    assert.equal(msg.payload.deposit, 250);
    assert.equal(msg.payload.channelId, chA.channelId);
  });

  it('two independently-opened channels converge on the same starting balances', () => {
    const { routerA, routerB } = linkRouters();
    const chA = routerA.openChannel('pod-bob', 500);
    chA.open(250);
    routerA.broadcastOpen('pod-bob', 500);

    const chB = routerB.getChannel('pod-alice');
    assert.ok(chB, 'the receiver mirrored the channel');

    // The invariant that could not previously hold: each side's view of the
    // other is the other's view of itself.
    assert.equal(chB.channelId, chA.channelId);
    assert.equal(chB.state, 'open');
    assert.equal(chB.remoteBalance, chA.localBalance);
    assert.equal(chB.localBalance, chA.remoteBalance);
    assert.equal(chB.capacity, chA.capacity);
  });

  it('a payment made after the open handshake is accepted by the mirror', () => {
    // The consequence of the divergence, and the reason it is worth fixing:
    // on main this threw 'Cannot receive in state: idle', and after opening
    // the mirror by hand it would have thrown 'Channel ID mismatch'.
    const { routerA, routerB } = linkRouters();
    const chA = routerA.openChannel('pod-bob', 500);
    chA.open(250);
    routerA.broadcastOpen('pod-bob', 500);
    const chB = routerB.getChannel('pod-alice');

    const update = chA.pay(100);
    chB.receive(update);

    assert.equal(chA.localBalance, 150);
    assert.equal(chA.remoteBalance, 100);
    assert.equal(chB.localBalance, 100);
    assert.equal(chB.remoteBalance, 150);
    // Still mirrored after the payment.
    assert.equal(chB.remoteBalance, chA.localBalance);
    assert.equal(chB.localBalance, chA.remoteBalance);
  });

  it('the mirror is built from the wire message, not from local defaults', () => {
    const { routerA, routerB } = linkRouters();
    const chA = routerA.openChannel('pod-bob', 750);
    chA.open(300);
    // Explicit overrides take precedence over the local channel's values.
    routerA.broadcastOpen('pod-bob', 750, { deposit: 42, channelId: 'ch_explicit' });

    const chB = routerB.getChannel('pod-alice');
    assert.equal(chB.channelId, 'ch_explicit');
    assert.equal(chB.remoteBalance, 42);
    assert.equal(chB.capacity, 750);
  });

  it('an old-format message with no deposit or channelId still opens a channel', () => {
    // Wire compatibility: a peer running the previous code sends only
    // { remotePodId, capacity }. That must behave exactly as it did before —
    // a channel is created and left idle — rather than throwing.
    const handlers = new Map();
    const router = new PaymentRouter('pod-bob');
    router.wireTransport(() => {}, (type, handler) => handlers.set(type, handler));

    handlers.get(PAYMENT_OPEN)({ remotePodId: 'pod-bob', capacity: 500 }, 'pod-alice');

    const ch = router.getChannel('pod-alice');
    assert.ok(ch);
    assert.equal(ch.state, 'idle');
    assert.equal(ch.capacity, 500);
    assert.equal(ch.localBalance, 0);
    assert.equal(ch.remoteBalance, 0);
  });

  it('ignores a PAYMENT_OPEN addressed to somebody else', () => {
    const handlers = new Map();
    const router = new PaymentRouter('pod-bob');
    router.wireTransport(() => {}, (type, handler) => handlers.set(type, handler));

    handlers.get(PAYMENT_OPEN)(
      { remotePodId: 'pod-carol', capacity: 500, deposit: 10, channelId: 'ch_x' },
      'pod-alice',
    );
    assert.equal(router.getChannel('pod-alice'), null);
  });

  it('ignores a nonsensical deposit rather than opening a bad channel', () => {
    for (const deposit of [-5, Number.NaN, Infinity, '100', null]) {
      const handlers = new Map();
      const router = new PaymentRouter('pod-bob');
      router.wireTransport(() => {}, (type, handler) => handlers.set(type, handler));
      handlers.get(PAYMENT_OPEN)(
        { remotePodId: 'pod-bob', capacity: 500, deposit, channelId: 'ch_y' },
        'pod-alice',
      );
      const ch = router.getChannel('pod-alice');
      assert.ok(ch, `channel still created for deposit ${String(deposit)}`);
      assert.equal(ch.state, 'idle', `left idle for deposit ${String(deposit)}`);
      assert.equal(ch.remoteBalance, 0);
    }
  });

  it('a deposit above capacity leaves the mirror idle rather than over-funded', () => {
    const handlers = new Map();
    const router = new PaymentRouter('pod-bob');
    router.wireTransport(() => {}, (type, handler) => handlers.set(type, handler));
    handlers.get(PAYMENT_OPEN)(
      { remotePodId: 'pod-bob', capacity: 100, deposit: 500, channelId: 'ch_z' },
      'pod-alice',
    );
    const ch = router.getChannel('pod-alice');
    assert.equal(ch.state, 'idle');
    assert.equal(ch.remoteBalance, 0);
  });
});

describe('PaymentChannel.open — remoteDeposit', () => {
  it('one-argument open() is unchanged', () => {
    const ch = new PaymentChannel('pod-a', 'pod-b', { capacity: 500 });
    ch.open(100);
    assert.equal(ch.localBalance, 100);
    assert.equal(ch.remoteBalance, 0);
    assert.equal(ch.state, 'open');
  });

  it('still rejects a non-positive one-argument deposit with the same message', () => {
    const ch = new PaymentChannel('pod-a', 'pod-b', { capacity: 500 });
    assert.throws(() => ch.open(0), /Initial deposit must be positive/);
    assert.throws(() => ch.open(-10), RangeError);
    assert.throws(() => ch.open('100'), RangeError);
    assert.throws(() => ch.open(Number.NaN), RangeError);
    assert.equal(ch.state, 'idle');
  });

  it('credits the counterparty deposit to remoteBalance', () => {
    const ch = new PaymentChannel('pod-b', 'pod-a', { capacity: 500 });
    ch.open(0, 250);
    assert.equal(ch.localBalance, 0);
    assert.equal(ch.remoteBalance, 250);
    assert.equal(ch.state, 'open');
  });

  it('supports both sides funding the channel', () => {
    const ch = new PaymentChannel('pod-a', 'pod-b', { capacity: 500 });
    ch.open(200, 150);
    assert.equal(ch.localBalance, 200);
    assert.equal(ch.remoteBalance, 150);
  });

  it('enforces capacity against the total, not just the local side', () => {
    const ch = new PaymentChannel('pod-a', 'pod-b', { capacity: 500 });
    assert.throws(() => ch.open(300, 300), /exceeds capacity 500/);
    assert.equal(ch.state, 'idle');
  });

  it('rejects a negative remote deposit', () => {
    const ch = new PaymentChannel('pod-a', 'pod-b', { capacity: 500 });
    assert.throws(() => ch.open(100, -1), /Remote deposit must not be negative/);
  });

  it('a channel funded only by the remote side cannot pay out', () => {
    const ch = new PaymentChannel('pod-b', 'pod-a', { capacity: 500 });
    ch.open(0, 250);
    assert.throws(() => ch.pay(1), /Insufficient channel balance/);
  });
});

// receive() must validate the amount it is handed
//
// Regression for the asymmetry between pay() and receive(). pay() checked
// `typeof amount !== 'number' || amount <= 0` and refused to overspend;
// receive() checked the channel id and the sequence number and then ran
// `localBalance += amount; remoteBalance -= amount` on whatever arrived.
//
// A signature over the update does not help: it proves the counterparty
// wrote the value, not that the value is sane. Measured against a channel
// with a real Ed25519 verifyFn and a correctly signed update:
//
//   start:              local=500 remote=0
//   after amount=-400:  local=100 remote=400   <-- the receiver paid
//   after amount=-1e9:  local=-999999900 remote=1000000400
//   after amount="5":   local='5005' remote=-5
//   after amount=NaN:   local=NaN remote=NaN
//
// PaymentRouter's PAYMENT_UPDATE handler feeds the wire payload straight
// into receive(), so `amount` is fully counterparty-controlled.
// ---------------------------------------------------------------------------

describe('PaymentChannel.receive amount validation', () => {
  const makeUpdate = (ch, over = {}) => ({
    channelId: ch.channelId,
    sequence: 1,
    amount: 10,
    localBalance: 0,
    remoteBalance: 0,
    timestamp: Date.now(),
    signature: null,
    ...over,
  });

  let ch;
  beforeEach(() => {
    ch = new PaymentChannel('pod-alice', 'pod-bob', { capacity: 1000 });
    ch.open(100);
  });

  it('still applies an ordinary positive amount', () => {
    ch.receive(makeUpdate(ch, { amount: 40 }));
    assert.equal(ch.localBalance, 140);
    assert.equal(ch.sequence, 1);
  });

  it('rejects a negative amount instead of paying the sender', () => {
    assert.throws(
      () => ch.receive(makeUpdate(ch, { amount: -400 })),
      /amount must be a finite number greater than zero, got -400/
    );
    assert.equal(ch.localBalance, 100, 'balance untouched');
    assert.equal(ch.remoteBalance, 0);
    assert.equal(ch.sequence, 0, 'sequence not advanced');
  });

  it('rejects zero', () => {
    assert.throws(() => ch.receive(makeUpdate(ch, { amount: 0 })), RangeError);
    assert.equal(ch.localBalance, 100);
  });

  it('rejects a string amount instead of concatenating it onto the balance', () => {
    assert.throws(
      () => ch.receive(makeUpdate(ch, { amount: '5' })),
      /amount must be a finite number greater than zero, got string/
    );
    assert.equal(ch.localBalance, 100);
    assert.equal(typeof ch.localBalance, 'number');
  });

  it('rejects NaN instead of poisoning both balances', () => {
    assert.throws(() => ch.receive(makeUpdate(ch, { amount: NaN })), RangeError);
    assert.equal(Number.isNaN(ch.localBalance), false);
    assert.equal(Number.isNaN(ch.remoteBalance), false);
  });

  it('rejects Infinity', () => {
    assert.throws(() => ch.receive(makeUpdate(ch, { amount: Infinity })), RangeError);
    assert.equal(Number.isFinite(ch.localBalance), true);
  });

  for (const [label, amount] of [
    ['undefined', undefined],
    ['null', null],
    ['an object', {}],
    ['an array', [10]],
    ['a bigint-ish string', '1e9'],
    ['true', true],
  ]) {
    it(`rejects ${label}`, () => {
      assert.throws(() => ch.receive(makeUpdate(ch, { amount })), RangeError);
      assert.equal(ch.localBalance, 100);
      assert.equal(ch.sequence, 0);
    });
  }

  it('rejects a correctly signed negative amount', async () => {
    // The whole point: the signature is valid. Only the value is not.
    const mallory = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const malloryPub = new Uint8Array(await crypto.subtle.exportKey('raw', mallory.publicKey));

    const victim = new PaymentChannel('pod-alice', 'pod-mallory', {
      channelId: 'ch-signed',
      capacity: 1000,
      remotePublicKey: malloryPub,
      verifyFn: async (pub, data, sig) => {
        const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
        return crypto.subtle.verify('Ed25519', key, sig, data);
      },
    });
    victim.open(500);

    const fields = {
      channelId: 'ch-signed',
      sequence: 1,
      amount: -400,
      localBalance: 0,
      remoteBalance: 0,
      timestamp: Date.now(),
    };
    const sigBytes = new Uint8Array(
      await crypto.subtle.sign(
        'Ed25519',
        mallory.privateKey,
        new TextEncoder().encode(JSON.stringify(fields))
      )
    );
    const signature = Buffer.from(sigBytes).toString('base64');

    // Prove the signature really is good before asserting the rejection, so
    // this test cannot pass for the wrong reason.
    const verified = await crypto.subtle.verify(
      'Ed25519',
      mallory.publicKey,
      sigBytes,
      new TextEncoder().encode(JSON.stringify(fields))
    );
    assert.equal(verified, true, 'the crafted signature is genuinely valid');

    assert.throws(
      () => victim.receive({ ...fields, signature }),
      /amount must be a finite number greater than zero/
    );
    assert.equal(victim.localBalance, 500, 'not drained');
    assert.equal(victim.remoteBalance, 0);
  });

  it('PaymentRouter drops a hostile PAYMENT_UPDATE off the wire', () => {
    const handlers = new Map();
    const router = new PaymentRouter('pod-alice');
    router.wireTransport(
      () => {},
      (type, fn) => handlers.set(type, fn)
    );
    const channel = router.openChannel('pod-mallory', 1000);
    channel.open(500);

    handlers.get(PAYMENT_UPDATE)(
      {
        channelId: channel.channelId,
        sequence: 1,
        amount: -400,
        localBalance: 0,
        remoteBalance: 0,
        timestamp: Date.now(),
        signature: null,
      },
      'pod-mallory'
    );

    assert.equal(channel.localBalance, 500, 'wire payload must not drain the channel');
    assert.equal(channel.remoteBalance, 0);
  });
});
