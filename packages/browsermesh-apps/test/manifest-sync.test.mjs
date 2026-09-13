/**
 * Unit-level tests for manifest-sync.mjs (Phase F of the mesh-native-
 * services plan -- see /packages/browsermesh-apps/src/manifest-sync.mjs's
 * module doc comment for the full design rationale).
 *
 * Matches this family's established pattern for this kind of test
 * (test/grant-log.test.mjs / test/mesh-relay.test.mjs are the cited
 * precedents): real `PeerRegistry`s wired to real `MeshACL`
 * (`@johnhenry/browsermesh-core`), real Ed25519 `IdentityWallet`/
 * `MeshIdentityManager` identities, real `CloudStorageBackend` instances
 * (`fake-indexeddb`-backed, matching `cloud-storage-backend.test.mjs`'s own
 * convention), connected via a minimal duck-typed in-memory bus (not real
 * WebRTC -- that's Phase G's/K's job, gated behind `REQUIRE_REAL_PEER`).
 *
 * `PeerRegistry.grantCapabilities()` is called DIRECTLY in these tests
 * (rather than routed through a real `GrantLog`) -- Phase D's own signed-
 * propagation machinery is already covered by grant-log.test.mjs; this
 * phase's ACL gate only needs *some* real, populated `PeerRegistry` to
 * check against, exactly the way mesh-sync.mjs/mesh-relay-host.mjs already
 * consume `checkAccess()` without caring how the registry got populated.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/manifest-sync.test.mjs
 */

import 'fake-indexeddb/auto'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createManifestSyncService } from '../src/manifest-sync.mjs'
import { CloudStorageBackend } from '../src/cloud-storage-backend.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

const BUCKET = 'test-bucket'
const RESOURCE = `s3:${BUCKET}`

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

let bucketCounter = 0
/** A fresh, fake-indexeddb-backed CloudStorageBackend, attributed to `peer`'s own identity. */
function createBackendFor(peer, bucketSuffix = '') {
  bucketCounter += 1
  return new CloudStorageBackend({
    bucket: `${BUCKET}-${bucketCounter}${bucketSuffix}`,
    nodeId: peer.podId,
  })
}

/**
 * A minimal duck-typed `PeerNode` pair, matching grant-log.test.mjs's
 * `wireNodes()` exactly: `podId`/`wallet`/`registry` plus an async
 * `sendTo()`/`onIncomingData()` bus.
 */
function wireNodes(peerA, peerB) {
  const listenersA = new Set()
  const listenersB = new Set()

  const nodeA = {
    podId: peerA.podId,
    wallet: peerA.wallet,
    registry: peerA.registry,
    onIncomingData(cb) {
      listenersA.add(cb)
      return () => listenersA.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersB) cb(peerA.podId, data)
      })
    },
  }
  const nodeB = {
    podId: peerB.podId,
    wallet: peerB.wallet,
    registry: peerB.registry,
    onIncomingData(cb) {
      listenersB.add(cb)
      return () => listenersB.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersA) cb(peerB.podId, data)
      })
    },
  }
  return { nodeA, nodeB }
}

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs = 1000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

/** Send one JSON command over a connected socket and read back the one JSON response. */
async function send(socket, cmd) {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  await socket.write(encoder.encode(JSON.stringify(cmd)))
  const chunk = await socket.read()
  assert.ok(chunk !== null, 'socket closed before a response arrived')
  return JSON.parse(decoder.decode(chunk))
}

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

// ---------------------------------------------------------------------------
// Authorized write propagation (also the "basic round-trip" proof)
// ---------------------------------------------------------------------------

describe('manifest-sync: authorized write propagation', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodeA
  /** @type {any} */ let nodeB
  /** @type {any} */ let backendA
  /** @type {any} */ let backendB

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    ;({ nodeA, nodeB } = wireNodes(alice, bob))
    backendA = createBackendFor(alice)
    backendB = createBackendFor(bob)
  })

  it("an authorized peer's put() becomes visible on a second peer's own CloudStorageBackend after merge", async () => {
    // Bob's own registry must already know Alice may write this bucket --
    // manifest-sync's ACL gate on the RECEIVING side (Bob) is what's under
    // test, so it's Bob's registry that needs the grant.
    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])

    const { api: aliceApi } = attachService(nodeA, undefined, createManifestSyncService({ bucketId: BUCKET, cloudStorageBackend: backendA }))
    attachService(nodeB, undefined, createManifestSyncService({ bucketId: BUCKET, cloudStorageBackend: backendB }))

    aliceApi.watch(bob.podId)

    const socketA = await backendA.connect()
    const plaintext = new TextEncoder().encode('hello from alice')
    const putRes = await send(socketA, { op: 'put', key: 'greeting.txt', data: toBase64(plaintext), contentType: 'text/plain' })
    assert.equal(putRes.stored, true)

    // Visible on Bob's OWN CloudStorageBackend instance, via its normal
    // JSON-command 'head' op -- proves the merge reached the actual
    // persisted manifest, not just manifest-sync's internal engine copy.
    //
    // Deliberately 'head', not 'get': Phase F only replicates the manifest
    // CRDT (the {chunks: [{cid, iv}], size, contentType, ...} pointer this
    // phase's own module doc comment describes). Bob has no way to fetch
    // Alice's actual ciphertext chunk bytes (Phase G, chunk replication --
    // not built yet) or decrypt them even if he did (Phase E, bucket-key
    // distribution -- also not built yet, and independent of this phase per
    // the plan's own dependency graph). A 'get' here would correctly fail
    // with "missing chunk", which would be testing the ABSENCE of two other
    // phases' functionality, not this phase's own correctness.
    const socketB = await backendB.connect()
    await waitFor(async () => {
      const res = await send(socketB, { op: 'head', key: 'greeting.txt' })
      return res.error === undefined
    }, 1000, "bob's backend sees alice's put after merge")

    const headRes = await send(socketB, { op: 'head', key: 'greeting.txt' })
    assert.equal(headRes.contentType, 'text/plain')
    assert.equal(headRes.size, plaintext.length)
  })

  it('a delete (tombstone) also propagates to an authorized peer', async () => {
    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])

    const { api: aliceApi } = attachService(nodeA, undefined, createManifestSyncService({ bucketId: BUCKET, cloudStorageBackend: backendA }))
    attachService(nodeB, undefined, createManifestSyncService({ bucketId: BUCKET, cloudStorageBackend: backendB }))
    aliceApi.watch(bob.podId)

    const socketA = await backendA.connect()
    await send(socketA, { op: 'put', key: 'k', data: toBase64(new Uint8Array([1])) })

    const socketB = await backendB.connect()
    await waitFor(async () => (await send(socketB, { op: 'head', key: 'k' })).error === undefined, 1000, 'put reaches bob')

    await send(socketA, { op: 'delete', key: 'k' })

    await waitFor(async () => (await send(socketB, { op: 'head', key: 'k' })).error === 'not found', 1000, 'delete reaches bob')
  })
})

// ---------------------------------------------------------------------------
// ctx.emit() observability events (Phase 1 of the mesh-KV-and-observability
// plan -- see manifest-sync.mjs's own module doc comment's "Observability
// events" section for the documented vocabulary this proves out).
// ---------------------------------------------------------------------------

describe('manifest-sync: ctx.emit() observability events', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodeA
  /** @type {any} */ let nodeB
  /** @type {any} */ let backendA
  /** @type {any} */ let backendB

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    ;({ nodeA, nodeB } = wireNodes(alice, bob))
    backendA = createBackendFor(alice)
    backendB = createBackendFor(bob)
  })

  it('emits manifest-sync:watching/unwatching on watch()/unwatch(), and manifest-sync:entry-merged on a successful authorized merge', async () => {
    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])

    const aliceHandle = attachService(nodeA, undefined, createManifestSyncService({ bucketId: BUCKET, cloudStorageBackend: backendA }))
    const bobHandle = attachService(nodeB, undefined, createManifestSyncService({ bucketId: BUCKET, cloudStorageBackend: backendB }))

    const watching = []
    const unwatching = []
    const merged = []
    aliceHandle.on('manifest-sync:watching', (data) => watching.push(data))
    aliceHandle.on('manifest-sync:unwatching', (data) => unwatching.push(data))
    bobHandle.on('manifest-sync:entry-merged', (data) => merged.push(data))

    aliceHandle.api.watch(bob.podId)
    assert.deepEqual(watching, [{ bucketId: BUCKET, pubKey: bob.podId }])

    const socketA = await backendA.connect()
    await send(socketA, { op: 'put', key: 'greeting.txt', data: toBase64(new TextEncoder().encode('hi')) })

    await waitFor(() => merged.length > 0, 1000, "bob's manifest-sync emits entry-merged after the authorized merge")
    assert.equal(merged[0].bucketId, BUCKET)
    assert.equal(merged[0].from, alice.podId)
    assert.deepEqual(merged[0].keys, ['greeting.txt'])

    aliceHandle.api.unwatch(bob.podId)
    assert.deepEqual(unwatching, [{ bucketId: BUCKET, pubKey: bob.podId }])
  })

  it('emits manifest-sync:write-rejected (reason: unauthorized) when the receiving peer has not granted write access', async () => {
    // Deliberately NOT granting alice write access on bob's registry.
    const aliceHandle = attachService(nodeA, undefined, createManifestSyncService({ bucketId: BUCKET, cloudStorageBackend: backendA }))
    const bobHandle = attachService(nodeB, undefined, createManifestSyncService({ bucketId: BUCKET, cloudStorageBackend: backendB }))

    const rejected = []
    bobHandle.on('manifest-sync:write-rejected', (data) => rejected.push(data))

    aliceHandle.api.watch(bob.podId)

    const socketA = await backendA.connect()
    await send(socketA, { op: 'put', key: 'k', data: toBase64(new Uint8Array([1])) })

    await waitFor(() => rejected.length > 0, 1000, "bob's manifest-sync emits write-rejected for alice's unauthorized write")
    assert.equal(rejected[0].bucketId, BUCKET)
    assert.equal(rejected[0].from, alice.podId)
    assert.equal(rejected[0].key, 'k')
    assert.equal(rejected[0].reason, 'unauthorized')
  })
})

// ---------------------------------------------------------------------------
// THE critical test: an unauthorized peer's write must never reach the
// local merged state.
// ---------------------------------------------------------------------------

describe('manifest-sync: unauthorized writes are rejected before merge', () => {
  it("a peer WITHOUT write access has its manifest changes discarded, never merged into the receiving peer's state", async () => {
    const alice = await createPeer('alice') // never granted write access to bob's registry
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)
    const backendA = createBackendFor(alice)
    const backendB = createBackendFor(bob)

    // Deliberately NOT calling bob.registry.grantCapabilities(alice.podId, ...).
    assert.equal(bob.registry.checkAccess(alice.podId, RESOURCE, 'write').allowed, false)

    const { api: aliceApi } = attachService(nodeA, undefined, createManifestSyncService({ bucketId: BUCKET, cloudStorageBackend: backendA }))
    attachService(nodeB, undefined, createManifestSyncService({ bucketId: BUCKET, cloudStorageBackend: backendB }))
    aliceApi.watch(bob.podId)

    const socketA = await backendA.connect()
    const putRes = await send(socketA, { op: 'put', key: 'secret.txt', data: toBase64(new TextEncoder().encode('should never arrive')) })
    assert.equal(putRes.stored, true, "alice's own local write always succeeds -- ACL is enforced on the RECEIVING peer, not the writer")

    // Give the (rejected) broadcast every chance to have arrived and been
    // processed before asserting it never took effect.
    await new Promise((r) => setTimeout(r, 50))

    // 'head' (not 'get'): asserting the MANIFEST has no entry at all, not
    // merely that content can't be fetched/decrypted -- 'get' would also
    // report an error for an authorized-but-not-yet-chunk-replicated entry
    // (Phase G isn't built yet), which would be a much weaker assertion.
    const socketB = await backendB.connect()
    const headRes = await send(socketB, { op: 'head', key: 'secret.txt' })
    assert.equal(headRes.error, 'not found', "bob's merged manifest must never contain alice's unauthorized write")

    const listRes = await send(socketB, { op: 'list' })
    assert.deepEqual(listRes.keys, [])
  })

  it('an authorized peer cannot smuggle in a write falsely attributed to someone else', async () => {
    // Alice has write access; Carol does not. If Alice's outbound envelope
    // (or a relay in between) claimed a write was authored by Carol, the
    // attribution-mismatch check must reject it independent of the ACL
    // check succeeding or failing for either identity.
    const alice = await createPeer('alice')
    const carol = await createPeer('carol')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)
    const backendA = createBackendFor(alice)
    const backendB = createBackendFor(bob)

    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])
    bob.registry.grantCapabilities(carol.podId, [`${RESOURCE}:write`])

    attachService(nodeB, undefined, createManifestSyncService({ bucketId: BUCKET, cloudStorageBackend: backendB }))

    // Hand-craft an envelope as Alice's session would send it, but with the
    // manifest entry's nodeId claiming Carol as the writer.
    await nodeA.sendTo(bob.podId, {
      type: 'manifest-sync',
      docId: `manifest:${BUCKET}`,
      payload: {
        id: `manifest:${BUCKET}`,
        type: 'lww-map',
        crdt: {
          entries: {
            'forged.txt': { value: { chunks: [], size: 0, contentType: null, metadata: {}, version: 1, updatedAt: Date.now() }, timestamp: Date.now(), nodeId: carol.podId, tombstone: false },
          },
        },
        version: {},
      },
    })

    await new Promise((r) => setTimeout(r, 50))

    const socketB = await backendB.connect()
    const headRes = await send(socketB, { op: 'head', key: 'forged.txt' })
    assert.equal(headRes.error, 'not found', 'attribution mismatch (nodeId !== sender) must be rejected regardless of either identity\'s ACL status')
  })
})

// ---------------------------------------------------------------------------
// Documented known limitation: LWW resolves concurrent same-key writes to
// one silent, deterministic winner -- not a "correct" resolution, just the
// documented one (highest timestamp, tie broken by greater nodeId string).
// ---------------------------------------------------------------------------

describe('manifest-sync: documented LWW tie-break limitation', () => {
  /**
   * Deliver two hand-crafted same-timestamp, different-writer entries for
   * the SAME key to a fresh observer peer, in `order`, and return the
   * observer's resulting `head` response for that key. Each call gets its
   * own fresh peer/backend/service so the two delivery orders are compared
   * on an otherwise-identical clean slate, not "does a later write clobber
   * an earlier one" (a different, already-covered property).
   * @param {{podId: string}} writerLo
   * @param {{podId: string}} writerHi
   * @param {number} sharedTimestamp
   * @param {[{podId: string}, {podId: string}]} order
   */
  async function deliverTieInOrder(writerLo, writerHi, sharedTimestamp, order) {
    const observer = await createPeer(`observer-${Math.random().toString(36).slice(2)}`)
    const backend = createBackendFor(observer)
    observer.registry.grantCapabilities(writerLo.podId, [`${RESOURCE}:write`])
    observer.registry.grantCapabilities(writerHi.podId, [`${RESOURCE}:write`])

    const listeners = new Set()
    const node = {
      podId: observer.podId,
      registry: observer.registry,
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo() {},
    }
    attachService(node, undefined, createManifestSyncService({ bucketId: BUCKET, cloudStorageBackend: backend }))

    const entryFrom = (nodeId, sizeMarker) => ({
      value: { chunks: [], size: sizeMarker, contentType: 'text/plain', metadata: {}, version: 1, updatedAt: sharedTimestamp },
      timestamp: sharedTimestamp,
      nodeId,
      tombstone: false,
    })
    const envelopeFrom = (peer, sizeMarker) => ({
      type: 'manifest-sync',
      docId: `manifest:${BUCKET}`,
      payload: {
        id: `manifest:${BUCKET}`,
        type: 'lww-map',
        crdt: { entries: { 'contested-key': entryFrom(peer.podId, sizeMarker) } },
        version: {},
      },
    })

    // writerLo's write is tagged size 1, writerHi's is tagged size 2, purely
    // so the winning write is identifiable via `head`'s reported size.
    const sizeMarkers = new Map([[writerLo.podId, 1], [writerHi.podId, 2]])
    for (const peer of order) {
      const envelope = envelopeFrom(peer, sizeMarkers.get(peer.podId))
      for (const cb of listeners) cb(peer.podId, envelope)
    }
    await new Promise((r) => setTimeout(r, 20))

    const socket = await backend.connect()
    return send(socket, { op: 'head', key: 'contested-key' })
  }

  it('two authorized peers writing the same key at the identical timestamp resolve deterministically by nodeId, regardless of arrival order', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')

    // Whichever of alice.podId / bob.podId sorts greater lexicographically
    // is the documented winner (LWWRegister.merge(): on an exact timestamp
    // tie, the register whose nodeId string sorts greater wins) -- assert
    // against that rule directly rather than assuming which peer that is.
    const [loId, hiId] = [alice.podId, bob.podId].sort()
    const writerLo = alice.podId === loId ? alice : bob
    const writerHi = alice.podId === hiId ? alice : bob
    const expectedWinningSize = 2 // writerHi's marker, per deliverTieInOrder()

    const sharedTimestamp = Date.now()

    const resultOrderLoFirst = await deliverTieInOrder(writerLo, writerHi, sharedTimestamp, [writerLo, writerHi])
    assert.equal(resultOrderLoFirst.error, undefined)
    assert.equal(resultOrderLoFirst.size, expectedWinningSize, 'the higher-nodeId writer wins regardless of it arriving first or second')

    const resultOrderHiFirst = await deliverTieInOrder(writerLo, writerHi, sharedTimestamp, [writerHi, writerLo])
    assert.equal(resultOrderHiFirst.error, undefined)
    assert.equal(resultOrderHiFirst.size, expectedWinningSize, 'both delivery orders converge on the SAME documented tie-break winner')

    // Not "whichever arrived last" -- both orders above produced the exact
    // same winner, which is the point: the outcome is a deterministic
    // function of (timestamp, nodeId), never receipt order.
    assert.equal(resultOrderLoFirst.size, resultOrderHiFirst.size)
  })
})
