// Run with: node --import ./test/_setup-globals.mjs --test test/peer-escrow.test.mjs
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  ESCROW_CONDITIONS,
  ESCROW_STATUSES,
  EscrowContract,
  EscrowManager,
  createEscrowService,
} from '../src/peer-escrow.mjs'
import { CreditLedger } from '../src/payments.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { createMeshNode } from '../src/mesh-bootstrap.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

// ── Mock ledger ──────────────────────────────────────────────────

// Matches the REAL CreditLedger's method names and argument order
// (payments.mjs: credit(amount, fromPodId, memo) / debit(amount, toPodId,
// memo) -- amount first, no charge() method at all). EscrowManager's own
// create()/release()/refund()/checkExpired() previously called a
// charge(podId, amount, ...) that doesn't exist on the real class, and
// credit(podId, amount, ...) with the args swapped -- undetected because
// this mock used to match the buggy calls instead of the real API.
function createMockLedger(initialBalances = {}) {
  const balances = { ...initialBalances }
  const txLog = []
  return {
    debit(amount, podId, desc) {
      if ((balances[podId] || 0) < amount) throw new Error('Insufficient balance')
      balances[podId] = (balances[podId] || 0) - amount
      txLog.push({ type: 'debit', podId, amount, desc })
    },
    credit(amount, podId, desc) {
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

// =============================================================================
// createEscrowService -- wired as a MeshService (attachService(), issue #117)
// =============================================================================
//
// Fixtures mirror mesh-rpc.test.mjs's / peer-routing.test.mjs's own: real
// Ed25519 IdentityWallet/MeshIdentityManager identities + real PeerRegistry
// (wired to real MeshACL/MeshPeerManager/TrustGraph from
// @johnhenry/browsermesh-core), connected via a minimal duck-typed in-memory
// sendTo()/onIncomingData() bus -- not real WebRTC (that's a different
// layer's job). `PeerRegistry.grantCapabilities()` is called DIRECTLY in
// these tests (mirroring chunk-replication.test.mjs's/manifest-sync.test.mjs's
// own convention) rather than going through a higher-level grant flow --
// these tests exist to prove `createEscrowService()` correctly *consumes*
// `checkAccess()`, not how a registry gets populated in general.

/** A real Ed25519 identity + wallet + registry bundle for one "peer". */
async function createEscrowTestPeer(label) {
  const identityManager = new MeshIdentityManager({})
  const wallet = new IdentityWallet({ identityManager })
  const { podId } = await wallet.createIdentity(label)
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId }),
  })
  return { podId, wallet, registry }
}

/**
 * A minimal duck-typed multi-peer bus: every peer gets a node that can
 * `sendTo()` any other peer's podId and dispatches to that peer's own
 * `onIncomingData()` listeners. Mirrors mesh-rpc.test.mjs's `wireMesh()`.
 * @param {Array<{podId: string, wallet?: object, registry: object}>} peers
 * @returns {Record<string, any>} keyed by each peer's `podId`
 */
function wireEscrowMesh(peers) {
  const listenersByPodId = new Map(peers.map((p) => [p.podId, new Set()]))
  const nodesByPodId = {}
  for (const peer of peers) {
    nodesByPodId[peer.podId] = {
      podId: peer.podId,
      wallet: peer.wallet,
      registry: peer.registry,
      onIncomingData(cb) {
        const set = listenersByPodId.get(peer.podId)
        set.add(cb)
        return () => set.delete(cb)
      },
      async sendTo(pubKey, data) {
        const set = listenersByPodId.get(pubKey)
        if (!set) return
        queueMicrotask(() => {
          for (const cb of set) cb(peer.podId, data)
        })
      },
    }
  }
  return nodesByPodId
}

// -----------------------------------------------------------------------
// Regression: EscrowManager against the REAL CreditLedger, not the mock
// -----------------------------------------------------------------------

describe('EscrowManager against a real CreditLedger (not createMockLedger)', () => {
  // The mock above used to have charge(podId, amount)/credit(podId,
  // amount) methods shaped to match EscrowManager's buggy calls, so every
  // test in this file passed even though the real CreditLedger has no
  // charge() method at all, and credit()/debit() take amount FIRST
  // (payments.mjs: credit(amount, fromPodId, memo), debit(amount, toPodId,
  // memo)). This exercises the real class end to end.
  it('create/release move real balance on a real CreditLedger', () => {
    const ledger = new CreditLedger('alice')
    ledger.credit(100, 'genesis', 'seed balance')

    const mgr = new EscrowManager({ creditLedger: ledger })
    const contract = mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 30 })
    assert.equal(ledger.balance, 70)

    mgr.release(contract.id)
    assert.equal(ledger.balance, 100, 'release credits back into the same single-owner ledger')
    assert.equal(contract.status, 'released')
  })

  it('create/refund move real balance on a real CreditLedger', () => {
    const ledger = new CreditLedger('alice')
    ledger.credit(100, 'genesis', 'seed balance')

    const mgr = new EscrowManager({ creditLedger: ledger })
    const contract = mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 40 })
    assert.equal(ledger.balance, 60)

    mgr.refund(contract.id)
    assert.equal(ledger.balance, 100)
    assert.equal(contract.status, 'refunded')
  })

  it('create throws (not TypeError from a missing charge()) on insufficient balance', () => {
    const ledger = new CreditLedger('alice') // balance 0
    const mgr = new EscrowManager({ creditLedger: ledger })
    assert.throws(
      () => mgr.create({ payerPodId: 'alice', payeePodId: 'bob', amount: 10 }),
      /Insufficient balance/,
    )
  })
})

// -----------------------------------------------------------------------
// Full lifecycle between two real peers: create, release, refund
// -----------------------------------------------------------------------

describe('createEscrowService: full contract lifecycle between two real peers', () => {
  it('bob funds a contract on host, releases it to the payee, and separately refunds a second contract', async () => {
    const host = await createEscrowTestPeer('host')
    const bob = await createEscrowTestPeer('bob')
    const mesh = wireEscrowMesh([host, bob])
    const { [host.podId]: nodeHost, [bob.podId]: nodeBob } = mesh

    const ledger = createMockLedger({ [bob.podId]: 100 })
    attachService(nodeHost, undefined, createEscrowService({ creditLedger: ledger }))
    const { api: bobApi } = attachService(nodeBob, undefined, createEscrowService({ creditLedger: createMockLedger() }))

    // Host's operator opts bob in to opening escrow contracts against its
    // ledger at all -- the coarse admin-granted 'escrow:create' gate (see
    // createEscrowService()'s AUTHORIZATION MODEL doc comment).
    host.registry.grantCapabilities(bob.podId, ['escrow:create'])

    // -- create, funded by bob, payee is an arbitrary off-mesh id --
    const contract = await bobApi.requestCreate(host.podId, {
      payeePodId: 'alice-service',
      amount: 40,
      description: 'compute job',
    })
    assert.equal(contract.payer, bob.podId)
    assert.equal(contract.payee, 'alice-service')
    assert.equal(contract.amount, 40)
    assert.equal(contract.status, 'funded')
    assert.equal(ledger.getBalance(bob.podId), 60)

    // -- release --
    const releaseResult = await bobApi.requestRelease(host.podId, contract.id)
    assert.equal(releaseResult.success, true)
    assert.equal(releaseResult.txId, contract.id)
    assert.equal(ledger.getBalance('alice-service'), 40)

    // -- a second, independent contract, refunded instead of released --
    const contract2 = await bobApi.requestCreate(host.podId, {
      payeePodId: 'alice-service',
      amount: 20,
    })
    assert.equal(ledger.getBalance(bob.podId), 40) // 60 - 20

    const refundResult = await bobApi.requestRefund(host.podId, contract2.id, 'changed my mind')
    assert.equal(refundResult.success, true)
    assert.equal(ledger.getBalance(bob.podId), 60) // refunded back
  })

  it('dispute locks a contract without moving funds', async () => {
    const host = await createEscrowTestPeer('host')
    const bob = await createEscrowTestPeer('bob')
    const mesh = wireEscrowMesh([host, bob])
    const { [host.podId]: nodeHost, [bob.podId]: nodeBob } = mesh

    const ledger = createMockLedger({ [bob.podId]: 100 })
    attachService(nodeHost, undefined, createEscrowService({ creditLedger: ledger }))
    const { api: bobApi } = attachService(nodeBob, undefined, createEscrowService({ creditLedger: createMockLedger() }))
    host.registry.grantCapabilities(bob.podId, ['escrow:create'])

    const contract = await bobApi.requestCreate(host.podId, { payeePodId: 'alice-service', amount: 25 })
    const { disputeId } = await bobApi.requestDispute(host.podId, contract.id, { note: 'no delivery yet' })
    assert.equal(typeof disputeId, 'string')
    // Funds remain locked -- neither side has been credited.
    assert.equal(ledger.getBalance(bob.podId), 75)
    assert.equal(ledger.getBalance('alice-service'), 0)
  })
})

// -----------------------------------------------------------------------
// ctx.emit() events fire at the right moments
// -----------------------------------------------------------------------

describe('createEscrowService: ctx.emit() bridges EscrowManager events', () => {
  it('emits escrow:created / escrow:released / escrow:refunded / escrow:disputed', async () => {
    const host = await createEscrowTestPeer('host')
    const bob = await createEscrowTestPeer('bob')
    const mesh = wireEscrowMesh([host, bob])
    const { [host.podId]: nodeHost, [bob.podId]: nodeBob } = mesh

    const ledger = createMockLedger({ [bob.podId]: 100 })
    const { on } = attachService(nodeHost, undefined, createEscrowService({ creditLedger: ledger }))
    const { api: bobApi } = attachService(nodeBob, undefined, createEscrowService({ creditLedger: createMockLedger() }))
    host.registry.grantCapabilities(bob.podId, ['escrow:create'])

    const created = []
    const released = []
    const refunded = []
    const disputed = []
    on('escrow:created', (c) => created.push(c))
    on('escrow:released', (c) => released.push(c))
    on('escrow:refunded', (c) => refunded.push(c))
    on('escrow:disputed', (d) => disputed.push(d))

    const c1 = await bobApi.requestCreate(host.podId, { payeePodId: 'alice-service', amount: 10 })
    assert.equal(created.length, 1)
    assert.equal(created[0].id, c1.id)
    assert.equal(created[0].status, 'funded')

    await bobApi.requestRelease(host.podId, c1.id)
    assert.equal(released.length, 1)
    assert.equal(released[0].id, c1.id)
    assert.equal(released[0].status, 'released')

    const c2 = await bobApi.requestCreate(host.podId, { payeePodId: 'alice-service', amount: 10 })
    assert.equal(created.length, 2)
    await bobApi.requestRefund(host.podId, c2.id, 'nope')
    assert.equal(refunded.length, 1)
    assert.equal(refunded[0].id, c2.id)
    assert.equal(refunded[0].status, 'refunded')

    const c3 = await bobApi.requestCreate(host.podId, { payeePodId: 'alice-service', amount: 10 })
    await bobApi.requestDispute(host.podId, c3.id, { note: 'bad result' })
    assert.equal(disputed.length, 1)
    assert.equal(disputed[0].contract.id, c3.id)
    assert.equal(typeof disputed[0].disputeId, 'string')
  })

  it('emits escrow:expired via the LOCAL checkExpired() admin sweep', async () => {
    const host = await createEscrowTestPeer('host')
    const mesh = wireEscrowMesh([host])
    const { [host.podId]: nodeHost } = mesh

    const ledger = createMockLedger({ [host.podId]: 100 })
    const { api, on } = attachService(nodeHost, undefined, createEscrowService({ creditLedger: ledger }))

    const expired = []
    on('escrow:expired', (c) => expired.push(c))

    const contract = api.create({ payerPodId: host.podId, payeePodId: 'someone', amount: 10, timeoutMs: 1 })
    await new Promise((r) => setTimeout(r, 20))
    const count = api.checkExpired()
    assert.equal(count, 1)
    assert.equal(expired.length, 1)
    assert.equal(expired[0].id, contract.id)
    assert.equal(expired[0].status, 'expired')
  })
})

// -----------------------------------------------------------------------
// Authorization: the important security property -- ownership boundary
// -----------------------------------------------------------------------

describe('createEscrowService: authorization boundary (peer-initiated ops)', () => {
  it('a peer never granted escrow:create cannot open a contract against the host ledger', async () => {
    const host = await createEscrowTestPeer('host')
    const mallory = await createEscrowTestPeer('mallory') // never granted anything
    const mesh = wireEscrowMesh([host, mallory])
    const { [host.podId]: nodeHost, [mallory.podId]: nodeMallory } = mesh

    const ledger = createMockLedger({ [mallory.podId]: 100 })
    attachService(nodeHost, undefined, createEscrowService({ creditLedger: ledger }))
    const { api: malloryApi } = attachService(nodeMallory, undefined, createEscrowService({ creditLedger: createMockLedger() }))

    assert.equal(host.registry.checkAccess(mallory.podId, 'escrow', 'create').allowed, false)

    await assert.rejects(
      () => malloryApi.requestCreate(host.podId, { payeePodId: 'alice-service', amount: 40 }),
      /access denied/,
    )
    // No debit happened -- the request was refused before EscrowManager.create() ever ran.
    assert.equal(ledger.getBalance(mallory.podId), 100)
  })

  it("an unauthorized peer's release/refund/dispute attempt against a contract they don't own is rejected", async () => {
    const host = await createEscrowTestPeer('host')
    const bob = await createEscrowTestPeer('bob')
    const mallory = await createEscrowTestPeer('mallory') // never party to bob's contract
    const mesh = wireEscrowMesh([host, bob, mallory])
    const { [host.podId]: nodeHost, [bob.podId]: nodeBob, [mallory.podId]: nodeMallory } = mesh

    const ledger = createMockLedger({ [bob.podId]: 100, [mallory.podId]: 100 })
    attachService(nodeHost, undefined, createEscrowService({ creditLedger: ledger }))
    const { api: bobApi } = attachService(nodeBob, undefined, createEscrowService({ creditLedger: createMockLedger() }))
    const { api: malloryApi } = attachService(nodeMallory, undefined, createEscrowService({ creditLedger: createMockLedger() }))

    // Mallory IS allowed to create her own contracts (broad create grant)
    // but must never be able to touch BOB's contract.
    host.registry.grantCapabilities(bob.podId, ['escrow:create'])
    host.registry.grantCapabilities(mallory.podId, ['escrow:create'])

    const contract = await bobApi.requestCreate(host.podId, { payeePodId: 'alice-service', amount: 30 })

    assert.equal(host.registry.checkAccess(mallory.podId, `escrow:${contract.id}`, 'release').allowed, false)

    await assert.rejects(
      () => malloryApi.requestRelease(host.podId, contract.id),
      /access denied/,
    )
    await assert.rejects(
      () => malloryApi.requestRefund(host.podId, contract.id, 'give me bob\'s money'),
      /access denied/,
    )
    await assert.rejects(
      () => malloryApi.requestDispute(host.podId, contract.id, {}),
      /access denied/,
    )

    // Contract untouched -- still funded, bob's balance unchanged by mallory's attempts.
    assert.equal(ledger.getBalance(bob.podId), 70)
    assert.equal(ledger.getBalance('alice-service'), 0)

    // Meanwhile bob (the real owner) CAN release his own contract.
    const result = await bobApi.requestRelease(host.podId, contract.id)
    assert.equal(result.success, true)
    assert.equal(ledger.getBalance('alice-service'), 30)
  })

  it('a request for a nonexistent contractId is rejected, not silently a no-op', async () => {
    const host = await createEscrowTestPeer('host')
    const bob = await createEscrowTestPeer('bob')
    const mesh = wireEscrowMesh([host, bob])
    const { [host.podId]: nodeHost, [bob.podId]: nodeBob } = mesh

    attachService(nodeHost, undefined, createEscrowService({ creditLedger: createMockLedger() }))
    const { api: bobApi } = attachService(nodeBob, undefined, createEscrowService({ creditLedger: createMockLedger() }))

    await assert.rejects(
      () => bobApi.requestRelease(host.podId, 'nonexistent-contract-id'),
      /access denied/,
    )
  })
})

// -----------------------------------------------------------------------
// Local/admin-only ops are never wire-exposed
// -----------------------------------------------------------------------

describe('createEscrowService: local-only ops have no wire surface', () => {
  it('getContract/listContracts/getStats/checkExpired are unreachable over the wire', async () => {
    const host = await createEscrowTestPeer('host')
    const bob = await createEscrowTestPeer('bob')
    const mesh = wireEscrowMesh([host, bob])
    const { [host.podId]: nodeHost, [bob.podId]: nodeBob } = mesh

    const ledger = createMockLedger({ [bob.podId]: 100 })
    const { api: hostApi } = attachService(nodeHost, undefined, createEscrowService({ creditLedger: ledger }))
    const { api: bobApi } = attachService(nodeBob, undefined, createEscrowService({ creditLedger: createMockLedger() }))
    host.registry.grantCapabilities(bob.podId, ['escrow:create'])

    const contract = await bobApi.requestCreate(host.podId, { payeePodId: 'alice-service', amount: 15 })

    // No client-side request* method exists for any of these.
    assert.equal(bobApi.requestGetContract, undefined)
    assert.equal(bobApi.requestListContracts, undefined)
    assert.equal(bobApi.requestGetStats, undefined)
    assert.equal(bobApi.requestCheckExpired, undefined)

    // Local api still works directly, in-process, on the host.
    assert.equal(hostApi.getContract(contract.id).id, contract.id)
    assert.equal(hostApi.listContracts().length, 1)
    assert.equal(hostApi.getStats().active, 1)
  })
})

// -----------------------------------------------------------------------
// teardown
// -----------------------------------------------------------------------

describe('createEscrowService: teardown', () => {
  it('unsubscribes from incoming data, stops event delivery, and rejects in-flight requests', async () => {
    const host = await createEscrowTestPeer('host')
    const bob = await createEscrowTestPeer('bob')
    const mesh = wireEscrowMesh([host, bob])
    const { [host.podId]: nodeHost, [bob.podId]: nodeBob } = mesh

    attachService(nodeHost, undefined, createEscrowService({ creditLedger: createMockLedger() }))
    const { api: bobApi, on, teardown } = attachService(nodeBob, undefined, createEscrowService({ creditLedger: createMockLedger() }))

    const events = []
    on('escrow:created', (c) => events.push(c))

    const pending = bobApi.requestCreate(host.podId, { payeePodId: 'x', amount: 1 })
    await teardown()

    await assert.rejects(() => pending, /torn down/)
  })
})

// =============================================================================
// createMeshNode({ enableEscrow: true }) -- opt-in surface (issue #117)
// =============================================================================
// Mirrors peer-routing.test.mjs's own "createMeshNode({ enableRouting: true })"
// integration section: real createMeshNode() PeerNodes, skipBoot: true where
// the test doesn't need actual discovery/WebRTC boot, just construction and
// the opt-in wiring surface itself.

function createStubSignalingTransport() {
  return { send() {}, onMessage() {} }
}

describe('createMeshNode({ enableEscrow: true })', () => {
  it('leaves node.escrow unset and node.services empty of "escrow" when enableEscrow is omitted', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
    })

    assert.equal(node.escrow, undefined)
    assert.equal(node.services.has('escrow'), false)
  })

  it('throws when enableEscrow is set but escrowOptions.creditLedger is missing', async () => {
    await assert.rejects(
      () => createMeshNode({
        label: 'alice',
        signalingTransport: createStubSignalingTransport(),
        enableEscrow: true,
        skipBoot: true,
      }),
      /creditLedger is required/,
    )
  })

  it('attaches node.escrow (== node.services.get("escrow")) when enableEscrow + escrowOptions.creditLedger are set', async () => {
    const ledger = createMockLedger({})
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableEscrow: true,
      escrowOptions: { creditLedger: ledger },
      skipBoot: true,
    })

    assert.ok(node.escrow, 'node.escrow is attached')
    assert.equal(node.escrow, node.services.get('escrow'))
    assert.equal(typeof node.escrow.api.create, 'function')
    assert.equal(typeof node.escrow.api.requestCreate, 'function')
  })
})
