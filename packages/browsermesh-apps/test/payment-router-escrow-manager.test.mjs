// Run with: node --import ./test/_setup-globals.mjs --test test/payment-router-escrow-manager.test.mjs
//
// #229: PaymentRouter's flat SimpleEscrowBook (a wire-level mirror) and the
// conditional EscrowManager (which moves funds) used to be two books that never
// saw each other. A router can now be given the manager; both show up in one
// view, and the sweeper expires manager contracts too.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PaymentRouter, CreditLedger, EscrowManager, MultiPartyCreditLedger, ESCROW_CREATE } from '../src/index.mjs'

function wired(router) {
  const handlers = new Map()
  router.wireTransport(() => {}, (type, fn) => handlers.set(type, fn))
  return handlers
}

async function managerFor(router, seed = 100) {
  const ledger = router.getLedger()
  ledger.credit(seed, 'mint', 'seed')
  return new EscrowManager({ creditLedger: ledger })
}

describe('PaymentRouter + EscrowManager (#229)', () => {
  it('without a manager, listEscrows() shows only the wire book', () => {
    const router = new PaymentRouter('alice')
    const h = wired(router)
    h.get(ESCROW_CREATE)({ payeePodId: 'alice', amount: 5 }, 'bob')
    const all = router.listEscrows('alice')
    assert.equal(all.length, 1)
    assert.equal(all[0].source, 'wire')
    assert.equal(all[0].status, 'held')
  })

  it('a wire ESCROW_CREATE and a local EscrowManager.create() both appear in one view', async () => {
    const router = new PaymentRouter('alice')
    const mgr = await managerFor(router)
    router.attachEscrowManager(mgr)
    const h = wired(router)

    h.get(ESCROW_CREATE)({ payeePodId: 'alice', amount: 5 }, 'bob')
    const c = await mgr.create({ payerPodId: 'alice', payeePodId: 'carol', amount: 30 })

    const all = router.listEscrows('alice')
    assert.equal(all.length, 2)
    const wire = all.find((e) => e.source === 'wire')
    const local = all.find((e) => e.source === 'manager')
    assert.deepEqual([wire.payerPodId, wire.payeePodId, wire.amount, wire.status], ['bob', 'alice', 5, 'held'])
    assert.deepEqual([local.escrowId, local.payerPodId, local.payeePodId, local.amount, local.status], [c.id, 'alice', 'carol', 30, 'funded'])
    // the manager's debit is visible on the router's own ledger; the wire mirror moves nothing
    assert.equal(router.getLedger().balance, 70)
  })

  it('getEscrowById() finds either kind, and tracks manager status changes', async () => {
    const router = new PaymentRouter('alice')
    const mgr = await managerFor(router)
    router.attachEscrowManager(mgr)
    const c = await mgr.create({ payerPodId: 'alice', payeePodId: 'carol', amount: 10 })
    assert.equal(router.getEscrowById(c.id).status, 'funded')
    await mgr.refund(c.id, 'no')
    assert.equal(router.getEscrowById(c.id).status, 'refunded')
    assert.equal(router.getEscrowById('missing'), null)
  })

  it('listEscrows(podId) filters by party', async () => {
    const router = new PaymentRouter('alice')
    const mgr = await managerFor(router)
    router.attachEscrowManager(mgr)
    await mgr.create({ payerPodId: 'alice', payeePodId: 'carol', amount: 10 })
    assert.equal(router.listEscrows('carol').length, 1)
    assert.equal(router.listEscrows('dave').length, 0)
    assert.equal(router.listEscrows().length, 1)
  })

  it('the escrow sweeper also expires manager contracts and reports them', async () => {
    const router = new PaymentRouter('alice')
    const mgr = await managerFor(router)
    router.attachEscrowManager(mgr)
    const c = await mgr.create({ payerPodId: 'alice', payeePodId: 'carol', amount: 40, timeoutMs: 1 })
    assert.equal(router.getLedger().balance, 60)
    await new Promise((r) => setTimeout(r, 5))
    const reported = await new Promise((resolve) => {
      router.startEscrowSweeper(5, (expired) => { if (expired.length) resolve(expired) })
    })
    router.stopEscrowSweeper()
    assert.equal(reported[0].escrowId, c.id)
    assert.equal(reported[0].source, 'manager')
    assert.equal(mgr.getContract(c.id).status, 'expired')
    assert.equal(router.getLedger().balance, 100)
  })

  it('attachEscrowManager() rejects a non-manager', () => {
    const router = new PaymentRouter('alice')
    assert.throws(() => router.attachEscrowManager({}), /EscrowManager/)
    assert.throws(() => router.attachEscrowManager(null), /EscrowManager/)
  })

  it('getEscrow() still returns the wire book (back-compat)', () => {
    const router = new PaymentRouter('alice')
    assert.equal(typeof router.getEscrow().pruneExpired, 'function')
  })
})

// #239: opt-in delegation of the wire ESCROW_CREATE into the manager.
describe('PaymentRouter delegates wire ESCROW_CREATE to the EscrowManager (#239)', () => {
  function setup({ delegate = true, funds = 100 } = {}) {
    const router = new PaymentRouter('alice')
    const ledger = new MultiPartyCreditLedger({ initialCredits: 0 })
    if (funds) ledger.credit('bob', funds, 'seed')
    const mgr = new EscrowManager({ creditLedger: ledger })
    router.attachEscrowManager(mgr, delegate ? { delegateWire: true } : undefined)
    const h = wired(router)
    return { router, ledger, mgr, send: h.get(ESCROW_CREATE) }
  }

  it('by default (no delegateWire) a wire ESCROW_CREATE stays a book-only mirror and moves nothing', async () => {
    const { router, ledger, mgr, send } = setup({ delegate: false })
    await send({ payeePodId: 'alice', amount: 30 }, 'bob')
    assert.equal(mgr.listContracts().length, 0)
    assert.equal(ledger.getBalance('bob'), 100)
    assert.equal(router.listEscrows('alice')[0].source, 'wire')
  })

  it('with delegateWire, the payer is the sending pod and its balance funds the contract', async () => {
    const { router, ledger, mgr, send } = setup()
    await send({ payeePodId: 'alice', amount: 30, conditions: { description: 'job', timeout: 60000 } }, 'bob')
    const [c] = mgr.listContracts()
    assert.deepEqual([c.payer, c.payee, c.amount, c.status, c.description], ['bob', 'alice', 30, 'funded', 'job'])
    assert.equal(ledger.getBalance('bob'), 70)
    const all = router.listEscrows('alice')
    assert.equal(all.length, 1, 'one view, one record: not mirrored into the wire book as well')
    assert.equal(all[0].source, 'manager')
    assert.equal(all[0].escrowId, c.id)
  })

  it('a payer without the funds creates nothing, and nothing is mirrored', async () => {
    const { router, ledger, mgr, send } = setup({ funds: 10 })
    await send({ payeePodId: 'alice', amount: 30 }, 'bob')
    assert.equal(mgr.listContracts().length, 0)
    assert.equal(ledger.getBalance('bob'), 10)
    assert.equal(router.listEscrows().length, 0)
  })

  it('malformed payloads create nothing and do not throw', async () => {
    const { router, ledger, mgr, send } = setup()
    for (const bad of [null, {}, { payeePodId: 'alice' }, { payeePodId: 'alice', amount: -5 },
      { payeePodId: 'alice', amount: NaN }, { payeePodId: '', amount: 5 }, { payeePodId: 7, amount: 5 }]) {
      await send(bad, 'bob')
    }
    await send({ payeePodId: 'alice', amount: 5 }, undefined)
    assert.equal(mgr.listContracts().length, 0)
    assert.equal(ledger.getBalance('bob'), 100)
    assert.equal(router.listEscrows().length, 0)
  })

  it('attachEscrowManager(manager, { delegateWire }) rejects a non-boolean flag', () => {
    const router = new PaymentRouter('alice')
    const mgr = new EscrowManager({ creditLedger: new MultiPartyCreditLedger() })
    assert.throws(() => router.attachEscrowManager(mgr, { delegateWire: 'yes' }), /delegateWire/)
  })
})
