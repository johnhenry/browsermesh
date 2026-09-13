/**
 * The developer-facing story the whole mesh-native-services plan
 * (/Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md) was
 * building toward, end to end, in one script:
 *
 *   import { CloudStorage as s3 } from '@johnhenry/browsermesh-apps'
 *   const store = new s3({ bucket: 'my-bucket', node: peerNode })
 *   await store.put('key', data)
 *
 * An S3-like object store with NO server anywhere: every byte lives in each
 * participating peer's own local storage (`IndexedDBChunkStore`/
 * `IndexedDBSyncStorage`, real durable persistence in a browser, backed
 * here by `fake-indexeddb`'s real-in-Node IndexedDB polyfill so this
 * example runs headless), encrypted at rest (AES-256-GCM, Phase B), synced
 * peer-to-peer via a signed, replicated `GrantLog` (Phase D), bucket-key
 * distribution (Phase E), CRDT manifest sync (Phase F), and chunk
 * replication (Phase G) — all composed behind the single ergonomic
 * `CloudStorage` class (Phase H) this example exercises exclusively through
 * its public surface: `put`/`get`/`delete`/`list`, `becomeAdmin`/`grant`/
 * `revoke`/`designateReplica`, `effectiveGrants`, `close`. Nothing below
 * reaches into `GrantLog`/`key-distribution.mjs`/`manifest-sync.mjs`/
 * `chunk-replication.mjs` directly — exactly how a real caller would use it.
 *
 * Like `07-full-mesh-pipeline.mjs`, the connection itself is simulated
 * in-process (a shared `sendTo`/`onIncomingData` bus standing in for a real
 * DataChannel) so this runs headless with no native dependencies. Everything
 * layered on top of that connection is the real, unmodified production
 * code. The identical composition, over an ACTUAL WebRTC connection, is
 * proven by `packages/browsermesh-apps/test/real-peer/cloud-storage.test.mjs`
 * (gated behind the optional `node-datachannel` native devDependency).
 *
 * See `packages/browsermesh-apps/docs/building-mesh-services.md` for the
 * reusable "how to build a mesh-native service" guide this whole plan's
 * capstone phase (K) also produced — CloudStorage is that guide's worked
 * example.
 */

import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'
import { CloudStorage, PeerRegistry } from '@johnhenry/browsermesh-apps'

const enc = new TextEncoder()
const dec = new TextDecoder()

// ── Step 1: two real peer identities, each with a real PeerRegistry ────────
// A real Ed25519 identity + wallet (`IdentityWallet`) and a real
// `PeerRegistry` (backed by `MeshACL`) per peer -- the exact same
// `mesh-bootstrap.mjs`/`createMeshNode()` composition a production peer
// uses, just assembled by hand here (no discovery/WebRTC needed for the
// story this example tells; see the real-peer test cited above for that).

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

const alice = await createPeer('alice') // the bucket's admin/owner
const bob = await createPeer('bob') // granted read/write/list + designated replica
const carol = await createPeer('carol') // never granted anything

console.log('1. three real Ed25519 identities created: alice (admin), bob (authorized + replica), carol (stranger) ✓')

// ── Step 2: a shared connection, standing in for real WebRTC ───────────────
// Same simulated-bus convention as 07-full-mesh-pipeline.mjs: a raw
// `{podId, wallet, registry, sendTo, onIncomingData}` object per peer,
// routed by destination pubKey on one shared in-process bus. `CloudStorage`
// only ever needs this exact surface (see cloud-storage.mjs's own module
// doc comment, point 7) -- a real, WebRTC-connected `PeerNode` from
// `createMeshNode()` satisfies it identically; this example doesn't care
// which.

function createBus() {
  const listenersByPod = new Map()
  return {
    nodeFor({ podId, wallet, registry }) {
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
          queueMicrotask(() => { for (const cb of set) cb(podId, data) })
        },
      }
    },
  }
}

const bus = createBus()
console.log('2. simulated shared connection ready (see the real-peer test for the identical story over actual WebRTC) ✓')

// ── Step 3: bootstrap the bucket ────────────────────────────────────────────
// `new CloudStorage({bucket, node})` is the entire setup — no manual
// GrantLog/manifest-sync/chunk-replication wiring; the constructor composes
// all of it (attachService(), Phase C) internally. `network` is entirely
// optional (see cloud-storage.mjs's module doc comment, point 1) and
// omitted here.

const BUCKET = 'family-photos'
const storeAlice = new CloudStorage({ bucket: BUCKET, node: bus.nodeFor(alice), dbName: 'example-09-alice' })
const storeBob = new CloudStorage({ bucket: BUCKET, node: bus.nodeFor(bob), dbName: 'example-09-bob' })
const storeCarol = new CloudStorage({ bucket: BUCKET, node: bus.nodeFor(carol), dbName: 'example-09-carol' })

await storeAlice.becomeAdmin()
assert.deepEqual(storeAlice.effectiveGrants().admins, [alice.podId])
console.log(`3. alice bootstrapped bucket '${BUCKET}' and is its sole admin ✓`)

// ── Step 4: grant bob access and designate him a replica ───────────────────
// `grant()` mutates the signed, replicated GrantLog (Phase D), delivers the
// bucket's AES-256-GCM key to bob (Phase E, encrypted point-to-point to his
// identity pubkey), and starts syncing the manifest CRDT to him (Phase F).
// `designateReplica()` is `grant(pubKey, 'replica')` -- an ordinary
// action-scope, not a separate mechanism (see cloud-storage.mjs, point 5).
// Bob needs to be a known, connected candidate in alice's own registry for
// chunk-replication's eager push to consider him a target -- ordinary mesh
// connection bookkeeping a real PeerNode/PeerRegistry pairing maintains
// automatically; done by hand here since this bus has no real connection
// lifecycle to hook into.
alice.registry.addPeer(bob.podId)
alice.registry.connect(bob.podId)

await storeAlice.grant(bob.podId, ['read', 'write', 'list', 'delete'])
await storeAlice.designateReplica(bob.podId)
console.log('4. alice granted bob read/write/list/delete and designated him a replica ✓')

// ── Step 5: put() from alice, get() from bob — the whole B-G stack, live ───
const photo = 'not actually a JPEG, but real encrypted-at-rest bytes nonetheless'
const putResult = await storeAlice.put('vacation/day1.jpg', photo, { contentType: 'image/jpeg' })
console.log(`5. alice put('vacation/day1.jpg'): ${putResult.size} bytes, durability='${putResult.durability}', replicatedTo=[${putResult.replicatedTo.join(', ')}]`)
assert.equal(putResult.stored, true)
// Bob was connected and designated a replica when this was written, so the
// eager push (Phase G) reached him before put() resolved.
assert.equal(putResult.durability, 'replicated')
assert.deepEqual(putResult.replicatedTo, [bob.podId])

const fetched = await storeBob.get('vacation/day1.jpg')
assert.equal(dec.decode(fetched), photo)
console.log("   bob's get() returned the exact same bytes alice put() — manifest sync + key distribution + chunk replication, composed ✓")

// ── Step 6: list() reflects each peer's own local, eventually-consistent view
const bobListing = await storeBob.list('vacation/')
console.log('6. bob\'s list("vacation/"):', bobListing.map((e) => e.key))
assert.ok(bobListing.some((e) => e.key === 'vacation/day1.jpg'))

// ── Step 7: carol was never granted anything ────────────────────────────────
// Her get() fails cleanly (never hangs) -- CloudStorageNotFoundError, after
// the bounded manifest wait (cloud-storage.mjs, point 2) -- and her own
// put() attempt always succeeds LOCALLY (Phase G: a local write can never
// fail) but never leaks into the real, shared bucket (see cloud-storage.mjs's
// "KNOWN LIMITATION" section for exactly why "fails cleanly" means this,
// not "the promise rejects").
try {
  await storeCarol.get('vacation/day1.jpg', { manifestWaitMs: 150 })
  throw new Error('expected carol\'s get() to fail — she was never granted access')
} catch (err) {
  assert.equal(err.name, 'CloudStorageNotFoundError')
  assert.equal(err.reason, 'not-found')
  console.log('7. carol (never granted) get() ->', err.name, `(reason: ${err.reason}) ✓`)
}

const carolPut = await storeCarol.put('mallory-planted-key.txt', 'should never be visible to alice or bob')
assert.equal(carolPut.stored, true) // her own local write always succeeds...
assert.equal(carolPut.durability, 'local-only')
const aliceKeysAfterCarol = (await storeAlice.list()).map((e) => e.key)
assert.ok(!aliceKeysAfterCarol.includes('mallory-planted-key.txt')) // ...but it never reaches the real bucket
console.log("   carol's own put() resolves locally but never becomes visible to alice or bob ✓")

// ── Step 8: revoke bob — his next read for new content is denied ───────────
await storeAlice.revoke(bob.podId, ['read', 'write', 'list', 'delete'])
await storeAlice.put('vacation/day2.jpg', 'bob must never see this one')

try {
  await storeBob.get('vacation/day2.jpg', { manifestWaitMs: 150 })
  throw new Error('expected bob\'s get() to fail after revocation')
} catch (err) {
  assert.equal(err.name, 'CloudStorageNotFoundError')
  console.log(`8. alice revoked bob's access; his next get() for new content -> ${err.name} ✓`)
}
// Revocation is a real, but PERMANENT, limitation (documented, not a bug):
// it stops FUTURE key distribution/replication, but cannot retroactively
// erase the bucket key or plaintext already delivered to bob before the
// revoke -- he can still decrypt 'vacation/day1.jpg' from what he already
// synced. See cloud-storage.mjs's `revoke()` doc comment.
const stillReadable = await storeBob.get('vacation/day1.jpg')
assert.equal(dec.decode(stillReadable), photo)
console.log('   (documented, permanent limitation: bob can still read content he already synced before revocation) ✓')

// ── Cleanup ──────────────────────────────────────────────────────────────
await storeAlice.close()
await storeBob.close()
await storeCarol.close()

console.log('\nok: an S3-like object store with no server anywhere -- encrypted-at-rest content, a signed replicated ACL, and CRDT manifest sync + chunk replication, all behind put()/get()/delete()/list()')
