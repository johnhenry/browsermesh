/**
 * Tests for mesh-timestamp.mjs (Phase 1 of the browsermesh-app-layer-migration
 * plan, issue #120): the `MeshService` wrapper around `peer-timestamp.mjs`'s
 * `TimestampAuthority`/`TimestampProof`.
 *
 * Mirrors `mesh-keepalive.test.mjs`'s own reasoning for why REAL `PeerNode`
 * instances are needed rather than the minimal duck-typed
 * `{podId, wallet, registry, onIncomingData, sendTo}` node pair
 * `mesh-rpc.test.mjs`/`grant-log.test.mjs` use: this service requires a real
 * `PeerNode.listSessions()` (the constructor-guard duck-type check) and
 * `PeerNode.listPeers({status: 'connected'})` (to discover real witness
 * targets) -- neither exists on the minimal duck-typed pair. Two real
 * `PeerNode`s are linked via `adoptIncomingSession()` fed a minimal in-memory
 * duplex transport, `mesh-keepalive.test.mjs`'s own `linkRealNodes()` pattern.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-timestamp.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { PeerNode } from '../src/peer-node.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createTimestampService } from '../src/mesh-timestamp.mjs'
import { TimestampAuthority } from '../src/peer-timestamp.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A real Ed25519 identity + wallet + registry bundle for one "peer". */
async function createPeer(label) {
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
 * Build a minimal in-memory duplex transport pair and adopt each side onto a
 * real, already-booted `PeerNode` via `adoptIncomingSession()`. Mirrors
 * `mesh-keepalive.test.mjs`'s own `linkRealNodes()`.
 * @param {PeerNode} nodeA @param {PeerNode} nodeB
 */
async function linkRealNodes(nodeA, nodeB) {
  let aOnMessage = null, bOnMessage = null
  const transportForA = { send(data) { queueMicrotask(() => { if (bOnMessage) bOnMessage(data) }) }, onMessage(cb) { aOnMessage = cb } }
  const transportForB = { send(data) { queueMicrotask(() => { if (aOnMessage) aOnMessage(data) }) }, onMessage(cb) { bOnMessage = cb } }
  await nodeA.adoptIncomingSession(nodeB.podId, transportForA, 'inmemory')
  await nodeB.adoptIncomingSession(nodeA.podId, transportForB, 'inmemory')
}

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs = 2000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

/** Collects (event, data) pairs fired on an attachService() handle. */
function recordEvents(handle) {
  const events = []
  handle.onEvent((event, data) => events.push({ event, data }))
  return events
}

// ---------------------------------------------------------------------------
// Real stamp() / verify() round-trip
// ---------------------------------------------------------------------------

describe('mesh-timestamp: real stamp()/verify() round-trip', () => {
  it("collects a real connected peer's local clock as a witness and produces a valid, self-verifiable proof", async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    await linkRealNodes(nodeA, nodeB)

    const handleA = attachService(nodeA, undefined, createTimestampService({ witnessTimeoutMs: 500 }))
    const handleB = attachService(nodeB, undefined, createTimestampService({ witnessTimeoutMs: 500 }))
    const events = recordEvents(handleA)

    const proof = await handleA.api.stamp('deadbeef')

    assert.equal(proof.witnesses.length, 2, 'local + one real connected peer witness')
    assert.ok(proof.witnesses.some((w) => w.podId === bob.podId), "bob's real local clock made it in as a witness")
    assert.equal(proof.confidence, 1, 'both local and the one real peer were within clockSkewMs')
    assert.equal(proof.issuedBy, alice.podId)
    assert.ok(proof.signature, 'the proof carries a real signature')

    const result = await handleA.api.verify(proof)
    assert.equal(result.valid, true, 'a proof this authority issued verifies against itself')
    assert.equal(result.checked, 'self')

    const stampedEvents = events.filter((e) => e.event === 'timestamp:stamped')
    const verifiedEvents = events.filter((e) => e.event === 'timestamp:verified')
    assert.equal(stampedEvents.length, 1)
    assert.equal(stampedEvents[0].data.eventHash, 'deadbeef')
    assert.equal(stampedEvents[0].data.witnessCount, 2)
    assert.equal(verifiedEvents.length, 1)
    assert.equal(verifiedEvents[0].data.valid, true)

    handleA.teardown()
    handleB.teardown()
  })

  it('resolves with a witness-timeout event when the connected peer never responds (no service attached on that side)', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    await linkRealNodes(nodeA, nodeB)
    // No timestamp service attached on nodeB -- it never answers the
    // time-request, so nodeA's witness collection must time out gracefully.

    const handleA = attachService(nodeA, undefined, createTimestampService({ witnessTimeoutMs: 100 }))
    const events = recordEvents(handleA)

    const proof = await handleA.api.stamp('cafef00d')

    assert.equal(proof.witnesses.length, 1, 'only the local clock -- bob never answered')
    assert.equal(proof.witnesses[0].podId, alice.podId)

    const timeoutEvents = events.filter((e) => e.event === 'timestamp:witness-timeout')
    assert.equal(timeoutEvents.length, 1)
    assert.equal(timeoutEvents[0].data.expected, 1)
    assert.equal(timeoutEvents[0].data.received, 0)

    handleA.teardown()
  })

  it('stamp() with no connected peers produces a single-witness (local-only) proof, no hang', async () => {
    const alice = await createPeer('alice')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    await nodeA.boot()

    const handleA = attachService(nodeA, undefined, createTimestampService())
    const proof = await handleA.api.stamp('solo')

    assert.equal(proof.witnesses.length, 1)
    assert.equal(proof.confidence, 1)

    handleA.teardown()
  })
})

// ---------------------------------------------------------------------------
// getNetworkTime() / computeMedian() passthroughs
// ---------------------------------------------------------------------------

describe('mesh-timestamp: getNetworkTime()/computeMedian() passthroughs', () => {
  it('getNetworkTime() returns a value close to Date.now() with no peer timestamps', async () => {
    const alice = await createPeer('alice')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    await nodeA.boot()
    const handleA = attachService(nodeA, undefined, createTimestampService())

    const before = Date.now()
    const networkTime = handleA.api.getNetworkTime()
    const after = Date.now()
    assert.ok(networkTime >= before && networkTime <= after, 'network time falls within the call window')

    handleA.teardown()
  })

  it('computeMedian() matches TimestampAuthority.computeMedian() exactly (same static function)', async () => {
    const alice = await createPeer('alice')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    await nodeA.boot()
    const handleA = attachService(nodeA, undefined, createTimestampService())

    assert.equal(handleA.api.computeMedian([1, 2, 3]), TimestampAuthority.computeMedian([1, 2, 3]))
    assert.equal(handleA.api.computeMedian([1, 2, 3, 4]), 2.5)

    handleA.teardown()
  })
})

// ---------------------------------------------------------------------------
// Custom identity override
// ---------------------------------------------------------------------------

describe('mesh-timestamp: custom identity override', () => {
  it('uses a caller-supplied identity instead of the default peerNode.wallet adapter', async () => {
    const alice = await createPeer('alice')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    await nodeA.boot()

    let signCalls = 0
    const customIdentity = {
      podId: 'custom-pod-id',
      async sign(data) {
        signCalls++
        return new TextEncoder().encode(`fake-sig:${data}`)
      },
    }
    const handleA = attachService(nodeA, undefined, createTimestampService({ identity: customIdentity }))

    const proof = await handleA.api.stamp('custom')
    assert.equal(proof.issuedBy, 'custom-pod-id', 'the custom identity, not peerNode.podId, issued the proof')
    assert.ok(signCalls > 0, 'the custom sign() was actually invoked')

    handleA.teardown()
  })
})

// ---------------------------------------------------------------------------
// Guard: requires a real PeerNode
// ---------------------------------------------------------------------------

describe('mesh-timestamp: real-PeerNode guard', () => {
  it('throws a clear error when attached to a duck-typed node with no listSessions()', () => {
    const fakeNode = { podId: 'fake', onIncomingData() { return () => {} }, sendTo: async () => {} }
    assert.throws(
      () => attachService(fakeNode, undefined, createTimestampService()),
      /must be a real PeerNode providing listSessions\(\)/,
    )
  })
})
