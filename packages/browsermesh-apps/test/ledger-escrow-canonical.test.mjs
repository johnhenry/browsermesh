// Run with: node --import ./test/_setup-globals.mjs --test test/ledger-escrow-canonical.test.mjs
//
// #194: one implementation per public name. `CreditLedger` is the single-owner
// ledger (payments.mjs), `EscrowManager` the conditional escrow that moves
// funds (peer-escrow.mjs). The other two models keep their own names:
// `MultiPartyCreditLedger` (peer-payments.mjs) and `SimpleEscrowBook`
// (payments.mjs, what PaymentRouter keeps).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as pkg from '../src/index.mjs'
import * as paymentsModule from '../src/payments.mjs'
import * as peerPaymentsModule from '../src/peer-payments.mjs'
import * as peerEscrowModule from '../src/peer-escrow.mjs'

const { CreditLedger, EscrowManager, MultiPartyCreditLedger, SimpleEscrowBook, PaymentRouter } = pkg

describe('one implementation per public name (#194)', () => {
  it('index.mjs resolves CreditLedger to the single-owner ledger and EscrowManager to the conditional manager', () => {
    assert.equal(pkg.CreditLedger, paymentsModule.CreditLedger)
    assert.equal(pkg.EscrowManager, peerEscrowModule.EscrowManager)
    const ledger = new CreditLedger('alice')
    assert.equal(ledger.ownerId, 'alice')
    assert.equal(typeof ledger.debit, 'function')
    assert.equal(typeof ledger.charge, 'undefined')
  })

  it('the other two models are exported under their own names, not as aliases of the canonical ones', () => {
    assert.equal(pkg.MultiPartyCreditLedger, peerPaymentsModule.MultiPartyCreditLedger)
    assert.equal(pkg.SimpleEscrowBook, paymentsModule.SimpleEscrowBook)
    assert.notEqual(MultiPartyCreditLedger, CreditLedger)
    assert.notEqual(SimpleEscrowBook, EscrowManager)
    const multi = new MultiPartyCreditLedger()
    assert.equal(typeof multi.charge, 'function')
    assert.equal(typeof multi.transfer, 'function')
  })

  it('no module defines a second class under a canonical name', () => {
    assert.equal('CreditLedger' in peerPaymentsModule, false)
    assert.equal('EscrowManager' in paymentsModule, false)
  })

  it('PaymentRouter keeps a SimpleEscrowBook, which is not the conditional manager', () => {
    const router = new PaymentRouter('alice')
    assert.ok(router.getEscrow() instanceof SimpleEscrowBook)
    assert.ok(!(router.getEscrow() instanceof EscrowManager))
    assert.ok(router.getLedger() instanceof CreditLedger)
  })

  it('SimpleEscrowBook only records holds: no balance moves, no conditions', () => {
    const book = new SimpleEscrowBook()
    const e = book.create('alice', 'bob', 10)
    assert.equal(e.status, 'held')
    assert.equal(book.release(e.escrowId), true)
    assert.equal(book.get(e.escrowId).status, 'released')
    assert.equal(typeof book.dispute, 'undefined')
  })
})

describe('EscrowManager (canonical) against both ledger models', () => {
  it('single-owner CreditLedger: create debits it, release/refund credit it', async () => {
    const ledger = new CreditLedger('alice')
    ledger.credit(100, 'mint', 'seed')
    const mgr = new EscrowManager({ creditLedger: ledger })
    const c = await mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 30, description: 'job' })
    assert.equal(ledger.balance, 70)
    await mgr.refund(c.id, 'changed my mind')
    assert.equal(ledger.balance, 100)
    assert.equal(mgr.getContract(c.id).status, 'refunded')
  })

  it('MultiPartyCreditLedger: payer and payee each move their own balance', async () => {
    const ledger = new MultiPartyCreditLedger({ initialCredits: 100 })
    const mgr = new EscrowManager({ creditLedger: ledger })
    const c = await mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 30 })
    assert.equal(ledger.getBalance('alice'), 70)
    assert.equal(ledger.getBalance('bob'), 100, 'nothing reaches the payee before release')
    await mgr.release(c.id)
    assert.equal(ledger.getBalance('alice'), 70)
    assert.equal(ledger.getBalance('bob'), 130)
  })

  it('MultiPartyCreditLedger: refund returns the funds to the payer', async () => {
    const ledger = new MultiPartyCreditLedger({ initialCredits: 100 })
    const mgr = new EscrowManager({ creditLedger: ledger })
    const c = await mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 40 })
    await mgr.refund(c.id)
    assert.equal(ledger.getBalance('alice'), 100)
    assert.equal(ledger.getBalance('bob'), 100)
  })

  it('MultiPartyCreditLedger: insufficient balance throws and creates no contract', async () => {
    const ledger = new MultiPartyCreditLedger({ initialCredits: 10 })
    const mgr = new EscrowManager({ creditLedger: ledger })
    await assert.rejects(
      () => mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 50 }),
      /Insufficient balance/,
    )
    assert.equal(ledger.getBalance('alice'), 10)
    assert.deepEqual(mgr.listContracts(), [])
  })

  it('conditions still gate release, on either ledger', async () => {
    const ledger = new MultiPartyCreditLedger({ initialCredits: 100 })
    const mgr = new EscrowManager({ creditLedger: ledger })
    const c = await mgr.create({
      payerPodId: 'alice', payeePodId: 'bob', amount: 20,
      conditions: [{ type: 'manual_approval' }],
    })
    await assert.rejects(() => mgr.release(c.id), /conditions not met/)
    assert.equal(ledger.getBalance('bob'), 100)
    await mgr.release(c.id, { manualApproval: true })
    assert.equal(ledger.getBalance('bob'), 120)
  })

  it('mutateLedger still takes precedence over the built-in adapters', async () => {
    const calls = []
    const mgr = new EscrowManager({
      creditLedger: new MultiPartyCreditLedger(),
      mutateLedger: async (op, amount, podId) => { calls.push([op, amount, podId]) },
    })
    await mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 5 })
    assert.deepEqual(calls, [['debit', 5, 'alice']])
  })

  it('a ledger of neither shape is rejected up front unless mutateLedger is supplied', () => {
    assert.throws(() => new EscrowManager({ creditLedger: { getBalance() {} } }), /must implement debit\(\)\/credit\(\)/)
    assert.doesNotThrow(() => new EscrowManager({ creditLedger: {}, mutateLedger() {} }))
  })
})
