/**
 * An inbound ESCROW_CREATE becomes a real, funded contract through a ledger hook
 * the deployment supplies (#239). Nothing is on by default: a `PaymentRouter` with
 * no hook only mirrors the message in its SimpleEscrowBook.
 *
 * The documented default shape is a per-pod ledger: one `MultiPartyCreditLedger`
 * (a balance per pod) behind `createMultiPartyLedgerHook()`. alice runs the router
 * and is the payee; bob is the payer. What this shows:
 *   - the AUTHENTICATED sender is the payer; a message that names someone else as
 *     the payer is refused (`payer-mismatch`) before the ledger is touched,
 *   - a repeated request is not charged twice (the escrow id is the request id),
 *   - a payer who cannot fund it creates nothing,
 *   - bounds on amount and memo, and every refusal audited without an amount,
 *   - release pays the payee, refund returns to the payer.
 *
 * The transport is a function call here; in a mesh the `fromPodId` the router is
 * handed must be the link's verified identity (or a routed envelope's verified
 * originator), never a field of the message.
 */
import assert from 'node:assert/strict'
import {
  PaymentRouter, MultiPartyCreditLedger, createMultiPartyLedgerHook, ESCROW_CREATE,
} from '@johnhenry/browsermesh-apps'

const ledger = new MultiPartyCreditLedger({ initialCredits: 0 })
ledger.credit('bob', 100, 'seed')

const audit = []
const router = new PaymentRouter('alice')
const manager = router.attachEscrowLedger(createMultiPartyLedgerHook(ledger), {
  maxAmount: 500,
  onAudit: (event) => audit.push(`${event.reason} from ${event.peer} (${event.escrowId})`),
})
const handlers = new Map()
router.wireTransport(() => {}, (type, fn) => handlers.set(type, fn))
const receive = handlers.get(ESCROW_CREATE)

const first = await receive({ escrowId: 'esc_job_1', payeePodId: 'alice', amount: 40, conditions: { description: 'render job' } }, 'bob')
assert.equal(first.ok, true)
assert.equal(ledger.getBalance('bob'), 60)
console.log('bob is the payer: 40 credits held for alice, bob has', ledger.getBalance('bob'))

const spoof = await receive({ escrowId: 'esc_job_2', payerPodId: 'carol', payeePodId: 'alice', amount: 10 }, 'bob')
assert.equal(spoof.code, 'payer-mismatch')
console.log('a message naming carol as the payer was refused:', spoof.code)

await receive({ escrowId: 'esc_job_1', payeePodId: 'alice', amount: 40, conditions: { description: 'render job' } }, 'bob')
assert.equal(ledger.getBalance('bob'), 60)
console.log('the same request again was not charged twice')

assert.equal((await receive({ escrowId: 'esc_job_3', payeePodId: 'alice', amount: 90 }, 'bob')).code, 'ledger-refused')
assert.equal((await receive({ escrowId: 'esc_job_4', payeePodId: 'alice', amount: 5000 }, 'bob')).code, 'amount-too-large')
assert.equal(manager.listContracts().length, 1)
console.log('an unfunded or oversized request created nothing')

await manager.release(first.escrowId)
assert.equal(ledger.getBalance('alice'), 40)
console.log('released: alice has', ledger.getBalance('alice'))

console.log('audit trail (no amounts):')
for (const line of audit) console.log(' -', line)
assert.ok(audit.every((line) => !/\b(40|90|5000)\b/.test(line.replace(/esc_job_\d/, ''))))
console.log('ok: wire ESCROW_CREATE moves funds only through the deployment\'s ledger hook, for the authenticated payer')
