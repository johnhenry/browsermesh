// Two real PeerNodes, one Node process, no server: the capstone (Phase K)
// real-WebRTC proof for the CloudStorage plan
// (/Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md).
//
// Every one of Phase H's own tests (../cloud-storage.test.mjs) proves the
// full B-G stack composes correctly -- grant, put, get, durability, revoke
// -- but over a duck-typed in-memory bus (a `queueMicrotask`-based
// `sendTo`/`onIncomingData` pair), never a real DataChannel. This file is
// the counterweight, mirroring mesh-sync.test.mjs's / full-pipeline.test.mjs's
// own real-peer convention exactly (same optional `node-datachannel`
// devDependency guard, same hermetic `iceServers: []` loopback setup, same
// `REQUIRE_REAL_PEER` hard-fail-on-absence so CI can't silently report a
// decorative skip as success): real SDP/ICE/DTLS/SCTP, real bytes over a
// real DataChannel, with `CloudStorage` instances on both sides talking
// only through their public `put`/`get`/`delete`/`list`/`grant`/`revoke`/
// `designateReplica` surface -- never reaching into `GrantLog`/
// `key-distribution.mjs`/`manifest-sync.mjs`/`chunk-replication.mjs`
// directly, exactly like a real caller of `new CloudStorage({bucket, node})`
// would (see cloud-storage.mjs's own module doc comment).
//
// One WebRTC connection is established once (in `before()`) and reused
// across every `it()` below, each of which creates its own uniquely-named
// bucket (and therefore its own independent GrantLog/manifest/chunk-store
// state) so the suites stay isolated from each other without paying for a
// fresh SDP/ICE/DTLS handshake per test.
//
// What this file does NOT re-prove: Phase H's own exhaustive grant/deny
// matrix, the full durability-flag state machine, or the "unauthorized
// third peer" case -- ../cloud-storage.test.mjs already covers all of that
// in depth, cheaply, over the duck-typed bus. This file's job is narrower
// and more expensive: prove the same composition survives an ACTUAL WebRTC
// connection, plus the specific Phase K proofs the plan calls for that
// benefit from (or require) that reality -- revoke-denies-next-read,
// read-repair-after-reconnect, and concurrent-same-key-write LWW
// resolution. "Revoke denies next WRITE" is proven separately, over the
// cheap in-memory bus in ../cloud-storage.test.mjs -- see that file's
// "CloudStorage: revoke also denies a revoked peer's writes from ever
// reaching the shared bucket" suite for why that half of the proof doesn't
// need a real connection to be honest.

import 'fake-indexeddb/auto'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

/** @type {any} */ let ndc = null
/** @type {any} */ let ndcMain = null
try {
  ndc = await import('node-datachannel/polyfill')
  ndcMain = await import('node-datachannel')
} catch {
  // Optional dependency absent -- the suite below skips.
}

if (!ndc && process.env.REQUIRE_REAL_PEER) {
  throw new Error(
    'REQUIRE_REAL_PEER is set but `node-datachannel` did not load, so the ' +
    'real-peer suite would have skipped and reported success. Install the ' +
    'devDependency, or unset REQUIRE_REAL_PEER to allow the skip.'
  )
}

if (!ndc) {
  describe('CloudStorage against real WebRTC peers', () => {
    it('skipped: optional devDependency `node-datachannel` is not installed', () => {})
  })
}

const describeIfReal = ndc ? describe : describe.skip

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

/** Shared in-process pub/sub bus standing in for a real signaling transport (see mesh-bootstrap.test.mjs). */
function createSharedSignalingBus() {
  return new Set()
}

function createBusTransport(sharedBus) {
  let handler = null
  const receiver = (msg) => { if (handler) handler(msg) }
  sharedBus.add(receiver)
  return {
    send(msg) {
      for (const fn of sharedBus) {
        if (fn !== receiver) fn(msg)
      }
    },
    onMessage(cb) { handler = cb },
  }
}

const enc = new TextEncoder()
const dec = new TextDecoder()

let dbCounter = 0
/** A fresh per-peer dbName -- see ../cloud-storage.test.mjs's identical helper for why this must differ per PEER even for the same shared bucket id. */
function freshDbName(label) {
  dbCounter += 1
  return `cloud-storage-real-peer-${dbCounter}-${label}`
}

let bucketCounter = 0
/** A fresh bucket id per test, so each `it()` gets its own independent GrantLog/manifest/chunk-store state without paying for a new WebRTC connection. */
function freshBucket(label) {
  bucketCounter += 1
  return `rp-bucket-${bucketCounter}-${label}`
}

describeIfReal('CloudStorage: real WebRTC peers (Phase K capstone)', () => {
  /** @type {any} */ let createMeshNode
  /** @type {any} */ let ManualStrategy
  /** @type {any} */ let DiscoveryRecord
  /** @type {any} */ let CloudStorage
  /** @type {any} */ let CloudStorageNotFoundError

  /** @type {any} */ let nodeA // alice
  /** @type {any} */ let nodeB // bob

  before(async () => {
    // webrtc.mjs reads RTCPeerConnection off the global at call time, so
    // the globals must be in place before any WebRTCPeerConnection is
    // constructed (not necessarily before it's imported) -- same
    // requirement documented by every other real-peer suite in this family.
    Object.assign(globalThis, {
      RTCPeerConnection: ndc.RTCPeerConnection,
      RTCIceCandidate: ndc.RTCIceCandidate,
      RTCSessionDescription: ndc.RTCSessionDescription,
    })
    ;({ createMeshNode } = await import('../../src/mesh-bootstrap.mjs'))
    ;({ CloudStorage, CloudStorageNotFoundError } = await import('../../src/cloud-storage.mjs'))
    ;({ ManualStrategy, DiscoveryRecord } = await import('@johnhenry/browsermesh-discovery'))

    const signalingBus = createSharedSignalingBus()
    const discoveryA = new ManualStrategy()
    const discoveryB = new ManualStrategy()
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`

    nodeA = await createMeshNode({
      label: 'alice',
      discoveryStrategies: [discoveryA],
      signalingTransport: createBusTransport(signalingBus),
      iceServers: [], // host candidates only: hermetic, no STUN/TURN/network dependency
      syncDbName: `cloud-storage-rp-sync-alice-${runId}`,
    })
    nodeB = await createMeshNode({
      label: 'bob',
      discoveryStrategies: [discoveryB],
      signalingTransport: createBusTransport(signalingBus),
      iceServers: [],
      syncDbName: `cloud-storage-rp-sync-bob-${runId}`,
    })

    discoveryA.addPeer(new DiscoveryRecord({ podId: nodeB.podId, transport: 'webrtc', label: 'bob' }))
    discoveryB.addPeer(new DiscoveryRecord({ podId: nodeA.podId, transport: 'webrtc', label: 'alice' }))
    await nodeA.discover()
    await nodeB.discover()

    await nodeA.connectToPeer(
      nodeB.podId,
      { webrtc: nodeB.podId },
      { answerTimeoutMs: 15_000, openTimeoutMs: 15_000 },
    )
    await waitFor(
      () => nodeB.meshManager.getConnection(nodeA.podId)?.isOpen,
      15_000,
      "bob's side of the DataChannel to open",
    )
    assert.ok(nodeA.hasActiveSession(nodeB.podId))
    assert.ok(nodeB.hasActiveSession(nodeA.podId))
    // Both sides' PeerRegistry already marked each other 'connected' as a
    // side effect of the real handshake above (connectToPeer() on alice's
    // side, adoptIncomingSession() on bob's -- see peer-node.mjs) -- no
    // manual registry bookkeeping needed to establish the baseline.
  })

  after(async () => {
    nodeA.meshManager.closeAll()
    nodeB.meshManager.closeAll()
    await nodeA.shutdown()
    await nodeB.shutdown()
    await nodeA.signaling.close()
    await nodeB.signaling.close()
    // libdatachannel holds a worker pool that would keep the process alive.
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  // ---------------------------------------------------------------------
  // 1. THE single most important proof of this phase: grant -> put on A ->
  //    get on B, returning identical bytes, over an ACTUAL WebRTC
  //    connection -- Phase H proved the logic composes; this proves it
  //    composes over a real connection.
  // ---------------------------------------------------------------------
  it('grant -> put on alice -> get on bob returns identical bytes, over a real DataChannel', async () => {
    const bucket = freshBucket('roundtrip')
    const storeA = new CloudStorage({ bucket, node: nodeA, dbName: freshDbName('alice-roundtrip'), manifestWaitMs: 1000 })
    const storeB = new CloudStorage({ bucket, node: nodeB, dbName: freshDbName('bob-roundtrip'), manifestWaitMs: 5000 })

    try {
      await storeA.becomeAdmin()
      assert.deepEqual(storeA.effectiveGrants().admins, [nodeA.podId])

      await storeA.grant(nodeB.podId, ['read', 'write', 'list', 'delete'])

      const plaintext = 'this traveled over a REAL WebRTC DataChannel, not the in-memory duck-typed bus'
      const putRes = await storeA.put('greeting.txt', plaintext, { contentType: 'text/plain' })
      assert.equal(putRes.stored, true)
      assert.equal(putRes.size, enc.encode(plaintext).length)
      assert.ok(['local-only', 'replicated'].includes(putRes.durability))

      const bytes = await storeB.get('greeting.txt')
      assert.equal(dec.decode(bytes), plaintext, "bob's get() over real WebRTC must return the exact bytes alice put()")

      const listed = await storeB.list()
      assert.ok(listed.some((e) => e.key === 'greeting.txt'))
    } finally {
      await storeA.close()
      await storeB.close()
    }
  })

  // ---------------------------------------------------------------------
  // 2. Revoke denies bob's NEXT read: a key alice writes AFTER revoking bob
  //    never reaches bob (grant()'s watch()/unwatch() bookkeeping, proven
  //    over the real connection). See this file's header comment for why
  //    the "denies next WRITE" half of this proof lives in
  //    ../cloud-storage.test.mjs instead.
  // ---------------------------------------------------------------------
  it('revoke denies the next read: a key written after revocation never reaches the revoked peer', async () => {
    const bucket = freshBucket('revoke-read')
    const storeA = new CloudStorage({ bucket, node: nodeA, dbName: freshDbName('alice-revoke-read'), manifestWaitMs: 1000 })
    const storeB = new CloudStorage({ bucket, node: nodeB, dbName: freshDbName('bob-revoke-read'), manifestWaitMs: 400 })

    try {
      await storeA.becomeAdmin()
      await storeA.grant(nodeB.podId, ['read', 'write', 'list'])

      // Sanity: access really does work before revocation.
      await storeA.put('before-revoke.txt', 'bob can read this')
      assert.equal(dec.decode(await storeB.get('before-revoke.txt')), 'bob can read this')

      await storeA.revoke(nodeB.podId, ['read', 'write', 'list'])

      // A key written AFTER the revoke: alice's grant()-driven watch(bob)
      // was cancelled by revoke()'s unwatch(bob), so this manifest entry is
      // never broadcast to bob -- his get() must fail cleanly rather than
      // ever seeing it.
      await storeA.put('after-revoke.txt', 'bob must never see this')

      await assert.rejects(
        () => storeB.get('after-revoke.txt', { manifestWaitMs: 500 }),
        (err) => err instanceof CloudStorageNotFoundError && err.reason === 'not-found',
        "the revoked peer's next read must be denied (never receives the post-revoke manifest entry)",
      )
    } finally {
      await storeA.close()
      await storeB.close()
    }
  })

  // ---------------------------------------------------------------------
  // 3. Read-repair after reconnect: a designated replica that was offline
  //    during a put() (durability 'local-only', per Phase G's contract)
  //    later "reconnects" and catches up via chunk-replication's lazy-pull
  //    mechanism.
  //
  //    IMPORTANT FINDING, stated explicitly rather than assumed: catch-up
  //    is NOT automatic on reconnect. Nothing in chunk-replication.mjs,
  //    manifest-sync.mjs, or mesh-bootstrap.mjs subscribes to
  //    `PeerRegistry.onPeerConnect()` (a real, existing hook -- see
  //    peer-registry.mjs) to trigger `syncMissingChunks()` when a
  //    previously-disconnected peer comes back. `syncMissingChunks()`
  //    itself exists (chunk-replication.mjs) but is not even exposed on
  //    `CloudStorage`'s public surface. The mechanism that DOES fire
  //    automatically through the public API is `get()`'s own per-key lazy
  //    pull (see cloud-storage.mjs's `get()`: for every chunk a manifest
  //    entry references that isn't held locally, it calls
  //    `chunkReplicationApi.fetchChunk()` before returning) -- so a
  //    reconnected replica "catches up" the moment it (or its application)
  //    performs its next READ of the affected key, not merely by being
  //    connected again. This test proves exactly that: catch-up is
  //    lazy-and-read-triggered, not connection-triggered.
  //
  //    "Offline" is simulated the same way ../cloud-storage.test.mjs's own
  //    "put() durability flag" suite already does (`alice.registry.
  //    disconnect(bob.podId)`), now applied on top of a REAL, still-open
  //    WebRTC DataChannel: `PeerRegistry` connect/disconnect is pure ACL/
  //    replication-target bookkeeping (see peer-registry.mjs), entirely
  //    separate from `WebRTCMeshManager`'s live transport session -- toggling
  //    it does not tear down or re-negotiate the real connection, it only
  //    changes which peers `chunk-replication.mjs`'s eager push selects as
  //    targets. This is a deliberate, documented choice (see this file's
  //    header comment): it lets the test control replication-target
  //    eligibility precisely, on a real transport, without paying for a
  //    second real WebRTC handshake mid-test.
  // ---------------------------------------------------------------------
  it('a designated replica that was offline during put() (durability local-only) catches up via lazy pull on its next get(), after "reconnecting"', async () => {
    const bucket = freshBucket('read-repair')
    const storeA = new CloudStorage({ bucket, node: nodeA, dbName: freshDbName('alice-read-repair'), manifestWaitMs: 1000 })
    const storeB = new CloudStorage({ bucket, node: nodeB, dbName: freshDbName('bob-read-repair'), manifestWaitMs: 5000 })

    try {
      await storeA.becomeAdmin()
      await storeA.grant(nodeB.podId, ['read', 'write', 'list'])
      await storeA.designateReplica(nodeB.podId)

      // Bob "goes offline": alice's own registry (the one chunk-replication
      // consults to pick eager-push targets) stops considering him connected.
      // The real DataChannel itself stays open the whole time -- see the
      // doc comment above for why this is the chosen simulation.
      nodeA.registry.disconnect(nodeB.podId)

      const plaintext = 'bob was offline (per alice\'s registry) when this was written'
      const putRes = await storeA.put('while-offline.txt', plaintext)
      assert.equal(putRes.durability, 'local-only', 'no eligible eager-push target while bob is registry-disconnected')
      assert.deepEqual(putRes.replicatedTo, [])

      // Bob's manifest-sync watch (set up by grant() above) is untouched by
      // the registry disconnect -- sendTo() over the real, still-open
      // DataChannel still succeeds, so bob's LOCAL manifest snapshot picks
      // up the new key's pointer even while "offline" for replication
      // purposes. Confirm that pointer really did arrive, and that bob does
      // NOT yet hold the chunk bytes it references (the actual gap
      // read-repair exists to close).
      await waitFor(async () => {
        const keys = (await storeB.list()).map((e) => e.key)
        return keys.includes('while-offline.txt')
      }, 5000, "bob's manifest to observe the pointer for the key written while he was replication-offline")

      // "Reconnect": alice's registry marks bob connected again.
      nodeA.registry.connect(nodeB.podId)

      // Bob's own next get() is the read-repair trigger (see this test's
      // doc comment: lazy, read-triggered, not automatic-on-reconnect).
      // Give it a generous manifestWaitMs -- the entry is already local, so
      // this call's real cost is the chunk-replication query/fetch round
      // trip over the live DataChannel, not manifest propagation.
      const bytes = await storeB.get('while-offline.txt', { manifestWaitMs: 5000 })
      assert.equal(dec.decode(bytes), plaintext, "bob's get() must successfully read-repair the missing chunk from alice over the real connection")
    } finally {
      await storeA.close()
      await storeB.close()
    }
  })

  // ---------------------------------------------------------------------
  // 4. Concurrent same-key writes resolve to ONE silent winner (LWWMap's
  //    documented, caller-timestamp-based conflict resolution -- see
  //    manifest-sync.mjs's module doc comment's "DOCUMENTED KNOWN
  //    LIMITATION" section, and cloud-storage.mjs's own point 4). This is
  //    NOT asserting a "correct" resolution -- there isn't one -- only that
  //    the documented behavior (one deterministic winner, both peers
  //    converge on it, no corruption/merge of the two writes) actually
  //    holds over a real connection.
  //
  //    Structural note (why both peers are made co-admins here rather than
  //    the usual one-admin-grants-a-reader shape the other tests use):
  //    `CloudStorage`'s public `grant()` only makes the GRANTING peer watch
  //    (broadcast future manifest changes to) the grantee -- a plain
  //    granted, non-admin peer's own writes are never automatically
  //    broadcast anywhere (see manifest-sync.mjs: a peer's `watchTargets`
  //    set is only ever populated by that SAME peer's own `grant()` calls,
  //    which `GrantLog.grant()` only allows an authorized admin to make).
  //    So for BOTH peers' concurrent writes to actually reach each other
  //    through the public API (rather than reaching into manifest-sync.mjs
  //    directly, which this suite deliberately avoids -- see header
  //    comment), alice grants bob the `admin` scope too, and bob then
  //    calls his own `grant()` on alice -- a legitimate multi-admin bucket
  //    setup, not a test-only shortcut.
  // ---------------------------------------------------------------------
  it('two peers writing the same key at "the same time" converge on ONE silent winner, never a merge of both', async () => {
    const bucket = freshBucket('lww-race')
    const storeA = new CloudStorage({ bucket, node: nodeA, dbName: freshDbName('alice-lww'), manifestWaitMs: 3000 })
    const storeB = new CloudStorage({ bucket, node: nodeB, dbName: freshDbName('bob-lww'), manifestWaitMs: 3000 })

    try {
      await storeA.becomeAdmin()
      // Promote bob to a co-admin (see doc comment above) and have him
      // grant alice in turn, so BOTH sides broadcast their own writes to
      // the other -- a real bidirectional multi-admin bucket, entirely via
      // the public API.
      await storeA.grant(nodeB.podId, ['read', 'write', 'list', 'admin'])
      await storeB.grant(nodeA.podId, ['read', 'write', 'list'])

      // Fire both writes to the SAME key without awaiting one before the
      // other -- as concurrent as this SDK's public API allows.
      const [putA, putB] = await Promise.all([
        storeA.put('contested.txt', 'alice-version'),
        storeB.put('contested.txt', 'bob-version'),
      ])
      assert.equal(putA.stored, true)
      assert.equal(putB.stored, true)

      // Wait for both sides to converge on a SINGLE, IDENTICAL value --
      // never each peer stubbornly keeping its own local write, and never
      // a corrupted/merged blend of the two.
      let finalA = null
      let finalB = null
      await waitFor(async () => {
        try {
          finalA = dec.decode(await storeA.get('contested.txt', { manifestWaitMs: 200 }))
          finalB = dec.decode(await storeB.get('contested.txt', { manifestWaitMs: 200 }))
        } catch {
          return false
        }
        return finalA === finalB
      }, 8000, 'both peers to converge on one identical winning value for the contested key')

      assert.equal(finalA, finalB, 'both peers must agree on the exact same winner')
      assert.ok(
        finalA === 'alice-version' || finalA === 'bob-version',
        'the winner must be exactly one of the two written values, never a blend -- documented LWW behavior, not a "correct" resolution',
      )
      // Deliberately not asserting WHICH one wins -- see this test's doc
      // comment: there is no "correct" answer, only a deterministic one.
    } finally {
      await storeA.close()
      await storeB.close()
    }
  })
})
