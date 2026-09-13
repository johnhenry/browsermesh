/**
 * End-to-end tests for cloud-storage.mjs (Phase H of the mesh-native-
 * services plan -- see that file's own module doc comment for the full
 * design rationale, and
 * /Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md's
 * "Phase H" section for the plan text this implements).
 *
 * Deliberately exercises ONLY the public `CloudStorage` surface (`put`/
 * `get`/`delete`/`list`/`grant`/`revoke`/`designateReplica`/`becomeAdmin`),
 * matching exactly what a real caller of `new CloudStorage({bucket, node})`
 * would do -- never reaching into the underlying `GrantLog`/
 * `key-distribution`/`manifest-sync`/`chunk-replication` services this
 * class internally composes (those are each already covered in depth by
 * their own dedicated test files: grant-log.test.mjs, key-distribution.test.mjs,
 * manifest-sync.test.mjs, chunk-replication.test.mjs).
 *
 * Matches this family's established pattern for this kind of test (the
 * direct precedents are chunk-replication.test.mjs / manifest-sync.test.mjs
 * / key-distribution.test.mjs / grant-log.test.mjs, all citing
 * mesh-relay.test.mjs): real `PeerRegistry`s wired to real `MeshACL`
 * (`@johnhenry/browsermesh-core`), real Ed25519 `IdentityWallet`/
 * `MeshIdentityManager` identities, real `CloudStorageBackend` instances
 * (`fake-indexeddb`-backed, each peer given its OWN separate database so a
 * successful round trip is only observable if real bytes actually moved
 * over the bus), connected via a minimal duck-typed in-memory bus routed by
 * destination pubKey (not real WebRTC -- that's Phase K's job, gated behind
 * `REQUIRE_REAL_PEER`; see this class's own module doc comment, point 7,
 * for why a duck-typed `{podId, wallet, registry, sendTo, onIncomingData}`
 * object is exactly what a real, booted `PeerNode` also satisfies).
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/cloud-storage.test.mjs
 */

import 'fake-indexeddb/auto'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { CloudStorage, CloudStorageNotFoundError } from '../src/cloud-storage.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

const BUCKET = 'photos'

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
 * A shared in-memory bus for an arbitrary number of duck-typed `PeerNode`s,
 * routed by destination pubKey (unlike the sibling phase tests' pairwise
 * `wireNodes()`, this supports 3+ peers on one bus without every message
 * being blindly broadcast to every other peer) -- needed for this suite's
 * "unauthorized third peer" test. Each node exposes exactly the surface
 * `mesh-service.mjs`'s `createServiceContext()` (and therefore this class)
 * needs: `podId`, `wallet`, `registry`, `sendTo()`, `onIncomingData()`.
 */
function createBus() {
  const listenersByPod = new Map()

  return {
    nodeFor(peer) {
      const { podId, wallet, registry } = peer
      if (!listenersByPod.has(podId)) listenersByPod.set(podId, new Set())
      return {
        podId,
        wallet,
        registry,
        onIncomingData(cb) {
          const set = listenersByPod.get(podId)
          set.add(cb)
          return () => set.delete(cb)
        },
        async sendTo(pubKey, data) {
          const set = listenersByPod.get(pubKey)
          if (!set) return
          queueMicrotask(() => {
            for (const cb of set) cb(podId, data)
          })
        },
      }
    },
  }
}

/** Mark `remote.podId` as a known, connected peer in `local.registry` (chunk-replication's `connectedPeers()` reads this). */
function markConnected(local, remote) {
  local.registry.addPeer(remote.podId)
  local.registry.connect(remote.podId)
}

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs = 2000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

let dbCounter = 0
/** A fresh per-peer dbName -- see cloud-storage.mjs's module doc comment / this file's own header comment for why this must differ per PEER even when `bucket` (the shared ACL/sync resource) is identical: each peer has its own physically separate local storage in a real deployment; only this in-one-process test needs to force that separation against the shared fake-indexeddb polyfill. */
function freshDbName(label) {
  dbCounter += 1
  return `cloud-storage-test-${dbCounter}-${label}`
}

const enc = new TextEncoder()
const dec = new TextDecoder()

// ---------------------------------------------------------------------------
// THE full round trip: grant -> put -> get, across two peers, exercising
// manifest sync AND chunk replication/fetch together.
// ---------------------------------------------------------------------------

describe('CloudStorage: end-to-end put/get across a granted peer', () => {
  it("peer B's get() eventually returns the exact bytes peer A put(), after being granted access", async () => {
    const bus = createBus()
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')

    const storeA = new CloudStorage({ bucket: BUCKET, node: bus.nodeFor(alice), dbName: freshDbName('alice'), manifestWaitMs: 500 })
    const storeB = new CloudStorage({ bucket: BUCKET, node: bus.nodeFor(bob), dbName: freshDbName('bob'), manifestWaitMs: 1500 })

    try {
      await storeA.becomeAdmin()
      assert.deepEqual(storeA.effectiveGrants().admins, [alice.podId])

      // Bob needs to know Alice is a connected candidate to query for chunks
      // (chunk-replication's lazy-pull `queryHave()` broadcasts to Bob's own
      // registry's connected peers) -- ordinary mesh connection bookkeeping
      // a real PeerNode/PeerRegistry pairing would maintain automatically.
      markConnected(bob, alice)

      await storeA.grant(bob.podId, ['read', 'write', 'list', 'delete'])

      const plaintext = 'hello bob, this traveled through the whole mesh-native-services stack'
      const putRes = await storeA.put('greeting.txt', plaintext, { contentType: 'text/plain' })
      assert.equal(putRes.stored, true)
      assert.equal(putRes.size, enc.encode(plaintext).length)
      assert.ok(['local-only', 'replicated'].includes(putRes.durability))

      const bytes = await storeB.get('greeting.txt')
      assert.equal(dec.decode(bytes), plaintext, "bob's get() must return the exact bytes alice put()")

      // list() on bob's own side must also reflect the synced manifest.
      const listed = await storeB.list()
      assert.ok(listed.some((e) => e.key === 'greeting.txt'))
    } finally {
      await storeA.close()
      await storeB.close()
    }
  })

  it('a delete on peer A propagates to peer B: get() throws CloudStorageNotFoundError with reason "deleted"', async () => {
    const bus = createBus()
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')

    const storeA = new CloudStorage({ bucket: BUCKET, node: bus.nodeFor(alice), dbName: freshDbName('alice'), manifestWaitMs: 500 })
    const storeB = new CloudStorage({ bucket: BUCKET, node: bus.nodeFor(bob), dbName: freshDbName('bob'), manifestWaitMs: 1500 })

    try {
      await storeA.becomeAdmin()
      markConnected(bob, alice)
      await storeA.grant(bob.podId, ['read', 'write', 'list', 'delete'])

      await storeA.put('temp.txt', 'will be deleted')
      const first = await storeB.get('temp.txt')
      assert.equal(dec.decode(first), 'will be deleted')

      await storeA.delete('temp.txt')

      await waitFor(async () => {
        try {
          await storeB.get('temp.txt', { manifestWaitMs: 50 })
          return false
        } catch (err) {
          return err instanceof CloudStorageNotFoundError && err.reason === 'deleted'
        }
      }, 2000, "bob's get() to observe the tombstone after alice's delete")
    } finally {
      await storeA.close()
      await storeB.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Authorization: an unauthorized third peer must never be able to read the
// real bucket, and its own writes must never reach it either.
// ---------------------------------------------------------------------------

describe('CloudStorage: unauthorized peer', () => {
  it("get() fails cleanly (CloudStorageNotFoundError) for a key it was never granted access to, and put() never leaks into the real bucket", async () => {
    const bus = createBus()
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const carol = await createPeer('carol') // never granted anything

    const storeA = new CloudStorage({ bucket: BUCKET, node: bus.nodeFor(alice), dbName: freshDbName('alice'), manifestWaitMs: 500 })
    const storeB = new CloudStorage({ bucket: BUCKET, node: bus.nodeFor(bob), dbName: freshDbName('bob'), manifestWaitMs: 1500 })
    const storeC = new CloudStorage({ bucket: BUCKET, node: bus.nodeFor(carol), dbName: freshDbName('carol'), manifestWaitMs: 150 })

    try {
      await storeA.becomeAdmin()
      markConnected(bob, alice)
      await storeA.grant(bob.podId, ['read', 'write', 'list'])

      await storeA.put('shared.txt', 'for alice and bob only')
      // Sanity: the authorized peer really does see it (otherwise the
      // "carol can't" half of this test would be vacuous).
      assert.equal(dec.decode(await storeB.get('shared.txt')), 'for alice and bob only')

      // Carol was never granted anything, and nobody's manifest-sync ever
      // watch()es her -- her own local manifest never receives this key.
      await assert.rejects(
        () => storeC.get('shared.txt'),
        (err) => err instanceof CloudStorageNotFoundError && err.reason === 'not-found',
      )

      // Carol's own put() always succeeds locally (Phase G's durability
      // contract: a local write can never fail) -- but it must never reach
      // the real, shared bucket. See cloud-storage.mjs's module doc
      // comment's "KNOWN LIMITATION" section for why this is the
      // architecturally correct notion of "fails cleanly" here.
      const carolPut = await storeC.put('mallory-planted-key.txt', 'should never be visible to alice or bob')
      assert.equal(carolPut.stored, true)
      assert.equal(carolPut.durability, 'local-only')

      // Give any (non-existent, but let's be sure) propagation a moment,
      // then confirm neither authorized peer ever saw Carol's key.
      await new Promise((r) => setTimeout(r, 100))
      const aliceKeys = (await storeA.list()).map((e) => e.key)
      const bobKeys = (await storeB.list()).map((e) => e.key)
      assert.ok(!aliceKeys.includes('mallory-planted-key.txt'))
      assert.ok(!bobKeys.includes('mallory-planted-key.txt'))
    } finally {
      await storeA.close()
      await storeB.close()
      await storeC.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Phase K: revoke denies a FORMERLY-authorized peer's next write -- the
// write-side counterpart to test/real-peer/cloud-storage.test.mjs's
// "revoke denies the next read" proof (which runs over a real WebRTC
// connection). This half is deliberately kept here, over the cheap
// in-memory bus, rather than duplicated into the real-peer suite -- see
// that file's own header comment for the full rationale. Short version:
// this is an ACL/architecture property (does manifest-sync's "gate before
// merge" check the CURRENT, post-revoke registry state, or something
// stale/cached), not a transport property -- proving it needs a peer whose
// write attempt genuinely reaches another peer and gets rejected, not a
// real DataChannel underneath that attempt.
//
// Structural note (same one test 4 of the real-peer suite documents):
// `CloudStorage.grant()` only makes the GRANTING peer watch (broadcast
// future manifest changes to) the grantee -- a plain granted peer's own
// writes are never broadcast anywhere on their own. So for bob's write to
// ever have a chance of reaching alice at all (authorized or not), bob must
// also be a co-admin who calls his OWN `grant()` on alice (a legitimate
// multi-admin bucket setup, not a test-only shortcut) -- otherwise this
// test would trivially "pass" for the wrong reason (bob's write was never
// going anywhere in the first place, authorized or not), the same trap the
// module doc comment for the real-peer suite calls out explicitly.
// ---------------------------------------------------------------------------

describe('CloudStorage: revoke also denies a revoked peer\'s writes from ever reaching the shared bucket', () => {
  it("a key bob writes AFTER being revoked never becomes visible to alice, even though bob's own write attempt genuinely reaches her", async () => {
    const bus = createBus()
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')

    const storeA = new CloudStorage({ bucket: BUCKET, node: bus.nodeFor(alice), dbName: freshDbName('alice'), manifestWaitMs: 500 })
    const storeB = new CloudStorage({ bucket: BUCKET, node: bus.nodeFor(bob), dbName: freshDbName('bob'), manifestWaitMs: 1500 })

    try {
      await storeA.becomeAdmin()
      markConnected(bob, alice)
      markConnected(alice, bob)

      // Promote bob to a co-admin and have HIM grant alice in turn, so
      // bob's own writes are actually broadcast toward alice (see the
      // describe block's doc comment for why this step is load-bearing,
      // not incidental).
      await storeA.grant(bob.podId, ['read', 'write', 'list', 'admin'])
      await storeB.grant(alice.podId, ['read', 'write', 'list'])

      // Sanity: while bob is still authorized, his write really does reach
      // alice -- otherwise the "after revoke" half below would be vacuous.
      await storeB.put('before-revoke.txt', 'bob wrote this while authorized')
      await waitFor(async () => {
        const keys = (await storeA.list()).map((e) => e.key)
        return keys.includes('before-revoke.txt')
      }, 2000, "alice to observe bob's pre-revoke write")
      assert.equal(dec.decode(await storeA.get('before-revoke.txt')), 'bob wrote this while authorized')

      await storeA.revoke(bob.podId, ['read', 'write', 'list', 'admin'])

      // Bob's own manifest-sync watchTarget for alice is untouched by
      // alice's revoke() (that only clears ALICE's own watch of BOB) -- so
      // this write is still actually SENT to alice, and must be rejected by
      // HER OWN manifest-sync ACL gate re-checking bob's now-revoked access,
      // not merely never attempted.
      const putRes = await storeB.put('after-revoke.txt', 'bob must never see this land in the real bucket')
      assert.equal(putRes.stored, true, "bob's own local write never fails -- see cloud-storage.mjs's KNOWN LIMITATION section")
      assert.equal(putRes.durability, 'local-only')

      // Give the (rejected) propagation attempt a real chance to land, then
      // confirm alice's manifest never accepted it.
      await new Promise((r) => setTimeout(r, 300))
      const aliceKeys = (await storeA.list()).map((e) => e.key)
      assert.ok(!aliceKeys.includes('after-revoke.txt'), "the revoked peer's post-revoke write must never become visible in the shared bucket")
      assert.ok(aliceKeys.includes('before-revoke.txt'), 'the pre-revoke write remains visible -- revoke is not retroactive')
    } finally {
      await storeA.close()
      await storeB.close()
    }
  })
})

// ---------------------------------------------------------------------------
// put()'s durability flag, through the public API -- mirrors
// chunk-replication.test.mjs's own "eager push on put()" suite, but proven
// end-to-end through CloudStorage rather than the raw service.
// ---------------------------------------------------------------------------

describe('CloudStorage: put() durability flag reflects real replica connectivity', () => {
  it('is "replicated" when a designated replica is connected, and "local-only" once that replica goes offline', async () => {
    const bus = createBus()
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')

    const storeA = new CloudStorage({ bucket: BUCKET, node: bus.nodeFor(alice), dbName: freshDbName('alice'), manifestWaitMs: 500 })
    const storeB = new CloudStorage({ bucket: BUCKET, node: bus.nodeFor(bob), dbName: freshDbName('bob'), manifestWaitMs: 1500 })

    try {
      await storeA.becomeAdmin()
      // Alice (the writer) needs Bob marked connected in HER OWN registry
      // for chunk-replication's eager push to select him as a target.
      markConnected(alice, bob)
      // Bob must also accept Alice's pushed chunks (write access) -- and
      // designating him a replica is itself a grant.
      await storeA.grant(bob.podId, ['read', 'write'])
      await storeA.designateReplica(bob.podId)
      assert.deepEqual(new Set(storeA.effectiveGrants().grants[bob.podId]), new Set([
        `${storeA.resource}:read`, `${storeA.resource}:write`, `${storeA.resource}:replica`,
      ]))

      const putRes1 = await storeA.put('online.txt', 'replicated while bob is connected')
      assert.equal(putRes1.durability, 'replicated')
      assert.deepEqual(putRes1.replicatedTo, [bob.podId])

      // Bob goes offline (per alice's own registry bookkeeping).
      alice.registry.disconnect(bob.podId)

      const putRes2 = await storeA.put('offline.txt', 'local-only once bob is offline')
      assert.equal(putRes2.durability, 'local-only')
      assert.deepEqual(putRes2.replicatedTo, [])
    } finally {
      await storeA.close()
      await storeB.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe('CloudStorage: constructor validation', () => {
  it('throws when bucket or node is missing/malformed', async () => {
    const alice = await createPeer('alice')
    const bus = createBus()
    assert.throws(() => new CloudStorage({ node: bus.nodeFor(alice) }), /bucket is required/)
    assert.throws(() => new CloudStorage({ bucket: BUCKET }), /node is required/)
    assert.throws(() => new CloudStorage({ bucket: BUCKET, node: { podId: 'x' } }), /wallet is required/)
    assert.throws(() => new CloudStorage({ bucket: BUCKET, node: { podId: 'x', wallet: alice.wallet } }), /registry is required/)
  })

  it('network is optional: composing D/E/F/G never requires one, since none of those services declare createBackend', async () => {
    const alice = await createPeer('alice')
    // Minimal single-peer duck-typed node -- no bus needed for this assertion.
    const soloNode = {
      podId: alice.podId,
      wallet: alice.wallet,
      registry: alice.registry,
      onIncomingData() { return () => {} },
      async sendTo() {},
    }
    const store = new CloudStorage({ bucket: BUCKET, node: soloNode })
    await store.close()
  })
})
