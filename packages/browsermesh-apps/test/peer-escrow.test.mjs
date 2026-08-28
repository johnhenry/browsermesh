// Run with: node --import ./test/_setup-globals.mjs --test test/peer-escrow.test.mjs
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  ESCROW_CONDITIONS,
  ESCROW_STATUSES,
  EscrowContract,
  EscrowManager,
} from '../src/peer-escrow.mjs'

// ── Mock ledger ──────────────────────────────────────────────────

function createMockLedger(initialBalances = {}) {
  const balances = { ...initialBalances }
  const txLog = []
  return {
    charge(podId, amount, desc) {
      if ((balances[podId] || 0) < amount) throw new Error('Insufficient balance')
      balances[podId] = (balances[podId] || 0) - amount
      txLog.push({ type: 'charge', podId, amount, desc })
    },
    credit(podId, amount, desc) {
      balances[podId] = (balances[podId] || 0) + amount
      txLog.push({ type: 'credit', podId, amount, desc })
    },
    getBalance(podId) { return balances[podId] || 0 },
    get txLog() { return txLog },
  }
}

// ── Constants ────────────────────────────────────────────────────

describe('ESCROW_CONDITIONS', () => {
  it('is frozen and has all expected keys', () => {
    assert.ok(Object.isFrozen(ESCROW_CONDITIONS))
    assert.equal(ESCROW_CONDITIONS.RESULT_HASH_MATCH, 'result_hash_match')
    assert.equal(ESCROW_CONDITIONS.ATTESTATION_QUORUM, 'attestation_quorum')
    assert.equal(ESCROW_CONDITIONS.MANUAL_APPROVAL, 'manual_approval')
    assert.equal(ESCROW_CONDITIONS.TIMEOUT_AUTO_RELEASE, 'timeout_release')
    assert.equal(ESCROW_CONDITIONS.TIMEOUT_AUTO_REFUND, 'timeout_refund')
  })
})

describe('ESCROW_STATUSES', () => {
  it('is frozen and contains all statuses', () => {
    assert.ok(Object.isFrozen(ESCROW_STATUSES))
    assert.deepEqual(ESCROW_STATUSES, ['pending', 'funded', 'released', 'refunded', 'disputed', 'expired'])
  })
})

// ── EscrowContract ───────────────────────────────────────────────

describe('EscrowContract', () => {
  it('auto-generates id when not provided', () => {
    const c = new EscrowContract({ payer: 'a', payee: 'b', amount: 10 })
    assert.ok(c.id)
    assert.equal(typeof c.id, 'string')
  })

  it('defaults status to pending', () => {
    const c = new EscrowContract({ payer: 'a', payee: 'b', amount: 10 })
    assert.equal(c.status, 'pending')
  })

  it('checkConditions returns met:true when no conditions', () => {
    const c = new EscrowContract({ payer: 'a', payee: 'b', amount: 10, conditions: [] })
    const result = c.checkConditions({})
    assert.equal(result.met, true)
    assert.equal(result.unmet.length, 0)
  })

  it('checkConditions validates RESULT_HASH_MATCH', () => {
    const c = new EscrowContract({
      payer: 'a', payee: 'b', amount: 10,
      conditions: [{ type: ESCROW_CONDITIONS.RESULT_HASH_MATCH, params: { expectedHash: 'abc123' } }],
    })
    assert.equal(c.checkConditions({ resultHash: 'abc123' }).met, true)
    assert.equal(c.checkConditions({ resultHash: 'wrong' }).met, false)
    assert.deepEqual(c.checkConditions({ resultHash: 'wrong' }).unmet, ['result_hash_match'])
  })

  it('isExpired detects timeout', () => {
    const past = Date.now() - 10000
    const c = new EscrowContract({ payer: 'a', payee: 'b', amount: 10, timeoutMs: 5000, createdAt: past })
    assert.equal(c.isExpired(), true)
  })

  it('isExpired returns false when no timeout', () => {
    const c = new EscrowContract({ payer: 'a', payee: 'b', amount: 10 })
    assert.equal(c.isExpired(), false)
  })

  it('toJSON/fromJSON round-trips', () => {
    const c = new EscrowContract({
      id: 'test-1', payer: 'alice', payee: 'bob', amount: 50,
      conditions: [{ type: ESCROW_CONDITIONS.MANUAL_APPROVAL }],
      timeoutMs: 60000, status: 'funded', description: 'compute job',
    })
    const json = c.toJSON()
    const restored = EscrowContract.fromJSON(json)
    assert.equal(restored.id, 'test-1')
    assert.equal(restored.payer, 'alice')
    assert.equal(restored.payee, 'bob')
    assert.equal(restored.amount, 50)
    assert.equal(restored.status, 'funded')
    assert.equal(restored.description, 'compute job')
    assert.equal(restored.timeoutMs, 60000)
    assert.equal(restored.conditions.length, 1)
  })
})

// ── EscrowManager ────────────────────────────────────────────────

describe('EscrowManager', () => {
  /** @type {ReturnType<typeof createMockLedger>} */
  let ledger
  /** @type {EscrowManager} */
  let mgr

  beforeEach(() => {
    ledger = createMockLedger({ alice: 100, bob: 50 })
    mgr = new EscrowManager({ creditLedger: ledger })
  })

  // 1. Create escrow debits payer
  it('create debits payer and stores funded contract', () => {
    const contract = mgr.create({
      payerPodId: 'alice',
      payeePodId: 'bob',
      amount: 30,
      description: 'compute job',
    })
    assert.equal(contract.status, 'funded')
    assert.equal(contract.amount, 30)
    assert.equal(contract.payer, 'alice')
    assert.equal(contract.payee, 'bob')
    assert.equal(ledger.getBalance('alice'), 70)
    assert.ok(mgr.getContract(contract.id))
  })

  // 2. Release credits payee
  it('release credits payee', () => {
    const contract = mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 20 })
    const result = mgr.release(contract.id)
    assert.equal(result.success, true)
    assert.equal(ledger.getBalance('bob'), 70) // 50 + 20
    assert.equal(mgr.getContract(contract.id).status, 'released')
  })

  // 3. Refund returns credits to payer
  it('refund returns credits to payer', () => {
    const contract = mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 25 })
    assert.equal(ledger.getBalance('alice'), 75)
    const result = mgr.refund(contract.id, 'service not delivered')
    assert.equal(result.success, true)
    assert.equal(ledger.getBalance('alice'), 100) // restored
    assert.equal(mgr.getContract(contract.id).status, 'refunded')
  })

  // 4. Double-release prevented
  it('double-release is prevented', () => {
    const contract = mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 20 })
    mgr.release(contract.id)
    assert.throws(() => mgr.release(contract.id), /not funded/)
  })

  // 5. Expired contract auto-refunds via checkExpired()
  it('expired contract auto-refunds via checkExpired()', () => {
    const contract = mgr.create({
      payerPodId: 'alice', payeePodId: 'bob', amount: 15,
      timeoutMs: 1, // 1ms timeout — will expire immediately
    })
    // Force time to pass
    const count = mgr.checkExpired(Date.now() + 100)
    assert.equal(count, 1)
    assert.equal(mgr.getContract(contract.id).status, 'expired')
    assert.equal(ledger.getBalance('alice'), 100) // 100 - 15 + 15
  })

  // 6. Dispute updates status
  it('dispute updates status to disputed', () => {
    const contract = mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 10 })
    const result = mgr.dispute(contract.id, { reason: 'wrong result' })
    assert.ok(result.disputeId)
    assert.equal(mgr.getContract(contract.id).status, 'disputed')
  })

  // 7. Release with RESULT_HASH_MATCH — met
  it('release with RESULT_HASH_MATCH condition met succeeds', () => {
    const contract = mgr.create({
      payerPodId: 'alice', payeePodId: 'bob', amount: 10,
      conditions: [{ type: ESCROW_CONDITIONS.RESULT_HASH_MATCH, params: { expectedHash: 'h1' } }],
    })
    const result = mgr.release(contract.id, { resultHash: 'h1' })
    assert.equal(result.success, true)
    assert.equal(mgr.getContract(contract.id).status, 'released')
  })

  // 8. Release with RESULT_HASH_MATCH — not met
  it('release with RESULT_HASH_MATCH condition not met fails', () => {
    const contract = mgr.create({
      payerPodId: 'alice', payeePodId: 'bob', amount: 10,
      conditions: [{ type: ESCROW_CONDITIONS.RESULT_HASH_MATCH, params: { expectedHash: 'h1' } }],
    })
    assert.throws(() => mgr.release(contract.id, { resultHash: 'wrong' }), /conditions not met/)
  })

  // 9. Release with ATTESTATION_QUORUM condition
  it('release with ATTESTATION_QUORUM condition', () => {
    const contract = mgr.create({
      payerPodId: 'alice', payeePodId: 'bob', amount: 10,
      conditions: [{ type: ESCROW_CONDITIONS.ATTESTATION_QUORUM, params: { requiredCount: 3 } }],
    })
    // Not enough attestations
    assert.throws(() => mgr.release(contract.id, { attestationCount: 2 }), /conditions not met/)
    // Enough attestations
    const result = mgr.release(contract.id, { attestationCount: 3 })
    assert.equal(result.success, true)
  })

  // 10. MANUAL_APPROVAL condition
  it('release with MANUAL_APPROVAL condition', () => {
    const contract = mgr.create({
      payerPodId: 'alice', payeePodId: 'bob', amount: 10,
      conditions: [{ type: ESCROW_CONDITIONS.MANUAL_APPROVAL }],
    })
    // Without approval
    assert.throws(() => mgr.release(contract.id, {}), /conditions not met/)
    // With approval
    const result = mgr.release(contract.id, { manualApproval: true })
    assert.equal(result.success, true)
  })

  // 11. listContracts with status filter
  it('listContracts with status filter', () => {
    mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 5 })
    const c2 = mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 5 })
    mgr.release(c2.id)

    const funded = mgr.listContracts({ status: 'funded' })
    assert.equal(funded.length, 1)
    const released = mgr.listContracts({ status: 'released' })
    assert.equal(released.length, 1)
    const all = mgr.listContracts()
    assert.equal(all.length, 2)

    // Filter by payerPodId
    const byPayer = mgr.listContracts({ payerPodId: 'alice' })
    assert.equal(byPayer.length, 2)
    const byPayee = mgr.listContracts({ payeePodId: 'bob' })
    assert.equal(byPayee.length, 2)
  })

  // 12. getStats returns correct counts
  it('getStats returns correct counts', () => {
    mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 10 })
    const c2 = mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 15 })
    mgr.release(c2.id)
    const c3 = mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 5 })
    mgr.dispute(c3.id)

    const stats = mgr.getStats()
    assert.equal(stats.active, 1)       // 1 funded
    assert.equal(stats.completed, 1)    // 1 released
    assert.equal(stats.disputed, 1)
    assert.equal(stats.totalEscrowed, 10) // only 'funded' counts
  })

  // 13. toJSON/fromJSON round-trip
  it('toJSON/fromJSON round-trip preserves contracts', () => {
    mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 20, description: 'job-1' })
    const c2 = mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 10 })
    mgr.release(c2.id)

    const json = mgr.toJSON()
    const restored = EscrowManager.fromJSON(json, { creditLedger: ledger })
    const all = restored.listContracts()
    assert.equal(all.length, 2)
    assert.equal(restored.getStats().active, 1)
    assert.equal(restored.getStats().completed, 1)
  })

  // 14. Insufficient balance throws on create
  it('insufficient balance throws on create', () => {
    assert.throws(
      () => mgr.create({ payerPodId: 'bob', payeePodId: 'alice', amount: 999 }),
      /Insufficient balance/,
    )
    // Balance unchanged
    assert.equal(ledger.getBalance('bob'), 50)
  })
})
