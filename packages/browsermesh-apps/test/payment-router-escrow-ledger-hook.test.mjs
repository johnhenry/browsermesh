// Run with: node --import ./test/_setup-globals.mjs --test test/payment-router-escrow-ledger-hook.test.mjs
//
// #239: an inbound ESCROW_CREATE reaches the conditional EscrowManager through a
// ledger hook the deployment supplies (`router.attachEscrowLedger(mutateLedger)`).
// Nothing is on by default; with no hook the SimpleEscrowBook mirror is unchanged.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PaymentRouter, MultiPartyCreditLedger, ESCROW_CREATE, EscrowWireError, createMultiPartyLedgerHook,
} from '../src/index.mjs'

function wired(router) {
  const handlers = new Map()
  router.wireTransport(() => {}, (type, fn) => handlers.set(type, fn))
  return handlers.get(ESCROW_CREATE)
}

/** A per-pod ledger behind a recording hook, the documented default shape. */
function setup({ funds = 100, ...opts } = {}) {
  const router = new PaymentRouter('alice')
  const ledger = new MultiPartyCreditLedger({ initialCredits: 0 })
  if (funds) ledger.credit('bob', funds, 'seed')
  const calls = []
  const inner = createMultiPartyLedgerHook(ledger)
  const audit = []
  const manager = router.attachEscrowLedger((...args) => { calls.push(args); return inner(...args) }, { onAudit: (e) => audit.push(e), ...opts })
  return { router, ledger, calls, audit, manager, send: wired(router) }
}
const req = (over = {}) => ({ escrowId: 'esc_req_0001', payeePodId: 'alice', amount: 30, conditions: { description: 'job' }, ...over })

describe('with no hook attached, the wire book is exactly what it was', () => {
  it('an inbound ESCROW_CREATE is only mirrored; no ledger is touched and no manager exists', () => {
    const router = new PaymentRouter('alice')
    const send = wired(router)
    send({ payeePodId: 'alice', amount: 5, payerPodId: 'someone-else' }, 'bob')
    assert.equal(router.getEscrowManager(), null)
    const all = router.listEscrows('alice')
    assert.equal(all.length, 1)
    assert.equal(all[0].source, 'wire')
    assert.equal(router.getEscrow().size, 1)
  })
})

describe('attachEscrowLedger', () => {
  it('creates a funded contract: the authenticated sender is the payer, the hook debits it', async () => {
    const { router, ledger, calls, manager, send } = setup()
    const r = await send(req(), 'bob')
    assert.equal(r.ok, true)
    const [c] = manager.listContracts()
    assert.deepEqual([c.payer, c.payee, c.amount, c.status, c.description], ['bob', 'alice', 30, 'funded', 'job'])
    assert.deepEqual(calls.map(([op, amount, podId]) => [op, amount, podId]), [['debit', 30, 'bob']])
    assert.equal(ledger.getBalance('bob'), 70)
    assert.equal(router.listEscrows('alice').length, 1)
    assert.equal(router.listEscrows('alice')[0].source, 'manager')
  })

  it('a payer field that is not the authenticated sender is refused, by name, with no ledger call', async () => {
    const { calls, manager, audit, send } = setup()
    const r = await send(req({ payerPodId: 'carol' }), 'bob')
    assert.deepEqual([r.ok, r.code], [false, 'payer-mismatch'])
    assert.equal(calls.length, 0)
    assert.equal(manager.listContracts().length, 0)
    assert.equal(audit.at(-1).reason, 'payer-mismatch')
  })

  it('handleEscrowCreate throws the named error for direct callers', async () => {
    const { router } = setup()
    await assert.rejects(router.handleEscrowCreate(req({ payerPodId: 'carol' }), 'bob'), (e) => e instanceof EscrowWireError && e.code === 'payer-mismatch')
    await assert.rejects(router.handleEscrowCreate(req(), ''), (e) => e.code === 'no-authenticated-sender')
  })

  it('an escrow that is not addressed to this pod is refused unless acceptPayee says otherwise', async () => {
    const a = setup()
    const r = await a.send(req({ payeePodId: 'dave' }), 'bob')
    assert.equal(r.code, 'not-for-this-pod')
    assert.equal(a.calls.length, 0)
    const b = setup({ acceptPayee: () => true })
    assert.equal((await b.send(req({ payeePodId: 'dave' }), 'bob')).ok, true)
  })

  it('insufficient balance reported by the hook fails cleanly: nothing held, nothing mirrored, a retry is allowed', async () => {
    const { router, ledger, manager, audit, send } = setup({ funds: 10 })
    const r = await send(req(), 'bob')
    assert.deepEqual([r.ok, r.code], [false, 'ledger-refused'])
    assert.equal(manager.listContracts().length, 0)
    assert.equal(ledger.getBalance('bob'), 10)
    assert.equal(router.listEscrows().length, 0)
    assert.equal(audit.at(-1).reason, 'ledger-refused')
    ledger.credit('bob', 100, 'top up')
    assert.equal((await send(req(), 'bob')).ok, true, 'a failed attempt is not remembered as done')
  })

  it('a repeated create (same sender, same escrow id) does not charge twice, even while the first is in flight', async () => {
    const { ledger, calls, manager, audit, send } = setup()
    const [a, b] = await Promise.all([send(req(), 'bob'), send(req(), 'bob')])
    const c = await send(req(), 'bob')
    assert.equal(calls.filter(([op]) => op === 'debit').length, 1)
    assert.equal(ledger.getBalance('bob'), 70)
    assert.equal(manager.listContracts().length, 1)
    assert.ok([a, b, c].every((r) => r.ok && r.escrowId === a.escrowId))
    assert.ok(audit.some((e) => e.reason === 'duplicate'))
  })

  it('the same id from another sender is a different request', async () => {
    const { ledger, calls, send } = setup()
    ledger.credit('erin', 100, 'seed')
    await send(req(), 'bob')
    await send(req(), 'erin')
    assert.equal(calls.filter(([op]) => op === 'debit').length, 2)
  })

  it('bounds: amount, memo, ids, timeout, payee', async () => {
    const { calls, send } = setup({ maxAmount: 50, maxMemoBytes: 8 })
    const cases = [
      [req({ escrowId: 'esc_a_0001', amount: 51 }), 'amount-too-large'],
      [req({ escrowId: 'esc_a_0002', amount: 0 }), 'bad-amount'],
      [req({ escrowId: 'esc_a_0003', amount: -1 }), 'bad-amount'],
      [req({ escrowId: 'esc_a_0004', amount: NaN }), 'bad-amount'],
      [req({ escrowId: 'esc_a_0005', amount: '5' }), 'bad-amount'],
      [req({ escrowId: 'esc_a_0006', conditions: { description: 'x'.repeat(9) } }), 'memo-too-large'],
      [req({ escrowId: 'esc_a_0007', conditions: { description: 5 } }), 'bad-memo'],
      [req({ escrowId: 'esc_a_0008', conditions: { timeout: -5 } }), 'bad-timeout'],
      [req({ escrowId: undefined }), 'bad-escrow-id'],
      [req({ escrowId: 'x'.repeat(200) }), 'bad-escrow-id'],
      [req({ escrowId: 'esc a 0009' }), 'bad-escrow-id'],
      [req({ escrowId: 'esc_a_0010', payeePodId: 'bob' }), 'bad-payee'],
      [null, 'bad-request'],
    ]
    for (const [payload, code] of cases) assert.equal((await send(payload, 'bob')).code, code, code)
    assert.equal(calls.length, 0)
  })

  it('every refusal is audited with the reason, the sender and the id, and never with an amount', async () => {
    const { audit, send } = setup({ funds: 5, maxAmount: 1000 })
    await send(req({ amount: 777 }), 'bob') // insufficient
    await send(req({ escrowId: 'esc_b_0001', payerPodId: 'carol', amount: 999 }), 'bob')
    await send(req({ escrowId: 'esc_b_0002', amount: 5000 }), 'bob')
    assert.equal(audit.length, 3)
    for (const e of audit) {
      assert.equal(e.type, 'escrow-create-refused')
      assert.equal(e.peer, 'bob')
      assert.ok(e.escrowId)
      assert.equal(JSON.stringify(e).match(/777|999|5000/), null, 'no amount in an audit event')
    }
  })

  it('the idempotency memory is bounded', async () => {
    const { ledger, calls, send } = setup({ funds: 0, maxRemembered: 3 })
    ledger.credit('bob', 1000, 'seed')
    for (let i = 1; i <= 5; i++) await send(req({ escrowId: `esc_c_${String(i).padStart(4, '0')}`, amount: 1 }), 'bob')
    assert.equal(calls.length, 5)
    await send(req({ escrowId: 'esc_c_0005', amount: 1 }), 'bob') // still remembered
    assert.equal(calls.length, 5)
  })

  it('the default shape end to end: release pays the payee, refund returns to the payer (MultiPartyCreditLedger)', async () => {
    const { ledger, manager, send } = setup()
    const a = await send(req({ escrowId: 'esc_d_0001', amount: 40 }), 'bob')
    const b = await send(req({ escrowId: 'esc_d_0002', amount: 10 }), 'bob')
    assert.equal(ledger.getBalance('bob'), 50)
    await manager.release(a.escrowId)
    assert.equal(ledger.getBalance('alice'), 40)
    await manager.refund(b.escrowId, 'changed mind')
    assert.equal(ledger.getBalance('bob'), 60)
  })

  it('validates what it is given', () => {
    const router = new PaymentRouter('alice')
    assert.throws(() => router.attachEscrowLedger('nope'), TypeError)
    assert.throws(() => router.attachEscrowLedger(() => {}, { maxAmount: 0 }), TypeError)
    assert.throws(() => router.attachEscrowLedger(() => {}, { acceptPayee: 5 }), TypeError)
  })
})
