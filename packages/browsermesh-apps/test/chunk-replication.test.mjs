/**
 * Unit-level tests for chunk-replication.mjs (Phase G of the mesh-native-
 * services plan -- see that file's own module doc comment for the full
 * protocol/authorization/durability writeup).
 *
 * Matches this family's established pattern for this kind of test
 * (manifest-sync.test.mjs / key-distribution.test.mjs / grant-log.test.mjs
 * are the direct precedents): real `PeerRegistry`s wired to real `MeshACL`
 * (`@johnhenry/browsermesh-core`), real Ed25519 `IdentityWallet`/
 * `MeshIdentityManager` identities, real `CloudStorageBackend` instances
 * (`fake-indexeddb`-backed, each peer given its OWN separate chunk-store
 * database so a successful transfer is only observable if this phase's own
 * code actually moved the bytes), connected via a minimal duck-typed
 * in-memory bus (not real WebRTC -- that's Phase K's job, gated behind
 * `REQUIRE_REAL_PEER`).
 *
 * `PeerRegistry.grantCapabilities()` is called DIRECTLY in these tests
 * (rather than routed through a real `GrantLog`) -- Phase D's own signed-
 * propagation machinery is already covered by grant-log.test.mjs; this
 * phase's ACL gates only need *some* real, populated `PeerRegistry` to
 * check against, exactly the way manifest-sync.mjs/key-distribution.mjs's
 * own tests already do.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/chunk-replication.test.mjs
 */

import 'fake-indexeddb/auto'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createChunkReplicationService } from '../src/chunk-replication.mjs'
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
// Test fixtures (mirrors manifest-sync.test.mjs's / key-distribution.test.mjs's own)
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
/** A fresh, fake-indexeddb-backed CloudStorageBackend with its OWN chunk/manifest/key databases, attributed to `peer`'s own identity. */
function createBackendFor(peer) {
  bucketCounter += 1
  return new CloudStorageBackend({
    bucket: `${BUCKET}-${bucketCounter}`,
    dbName: `chunk-repl-test-${bucketCounter}`,
    nodeId: peer.podId,
  })
}

/**
 * A minimal duck-typed `PeerNode` pair, matching manifest-sync.test.mjs's/
 * key-distribution.test.mjs's own `wireNodes()` exactly: `podId`/`wallet`/
 * `registry` plus an async `sendTo()`/`onIncomingData()` bus.
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

/** Mark `remote.podId` as a known, connected peer in `local.registry` (`connectedPeers()` in chunk-replication.mjs reads this). */
function markConnected(local, remote) {
  local.registry.addPeer(remote.podId)
  local.registry.connect(remote.podId)
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

/** Extract the sole chunk's `cid` from a `head`-shaped fetch of the raw manifest snapshot. */
async function firstCidFor(backend, key) {
  const snapshot = await backend.getManifestSnapshot()
  const reg = snapshot.entries[key]
  assert.ok(reg && !reg.tombstone, `expected a manifest entry for '${key}'`)
  return reg.value.chunks[0].cid
}

// ---------------------------------------------------------------------------
// Eager push: put() replicates to a connected, authorized replica peer
// ---------------------------------------------------------------------------

describe('chunk-replication: eager push on put()', () => {
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

  it("a replica peer that is connected and authorized actually ends up holding the pushed ciphertext chunk bytes", async () => {
    // Alice (the writer) must consider Bob a connected, 'replica'-scoped peer.
    markConnected(alice, bob)
    alice.registry.grantCapabilities(bob.podId, [`${RESOURCE}:replica`])
    // Bob (the receiver) must consider Alice an authorized writer before accepting a push.
    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])

    attachService(nodeA, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendA }))
    attachService(nodeB, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendB }))

    const socketA = await backendA.connect()
    const plaintext = new TextEncoder().encode('hello from alice, replicated to bob')
    const putRes = await send(socketA, { op: 'put', key: 'greeting.txt', data: toBase64(plaintext) })
    assert.equal(putRes.stored, true)

    assert.equal(putRes.durability, 'replicated', 'a connected, authorized replica must be reflected in the durability flag')
    assert.deepEqual(putRes.replicatedTo, [bob.podId])

    const cid = await firstCidFor(backendA, 'greeting.txt')
    const aliceBytes = await backendA.getChunkRaw(cid)
    await waitFor(async () => (await backendB.hasChunkRaw(cid)) === true, 1000, "bob's chunk store receives the pushed chunk")
    const bobBytes = await backendB.getChunkRaw(cid)

    assert.ok(aliceBytes && bobBytes, 'both sides must actually hold the chunk bytes')
    assert.deepEqual(new Uint8Array(bobBytes), new Uint8Array(aliceBytes), 'the replicated ciphertext must be byte-identical')
  })

  it('a replica peer that is NOT connected results in local-only durability and no bytes transferred', async () => {
    // Bob is granted the 'replica' scope but Alice's registry never marks him connected.
    alice.registry.grantCapabilities(bob.podId, [`${RESOURCE}:replica`])
    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])

    attachService(nodeA, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendA }))
    attachService(nodeB, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendB }))

    const socketA = await backendA.connect()
    const putRes = await send(socketA, { op: 'put', key: 'offline.txt', data: toBase64(new Uint8Array([1, 2, 3])) })
    assert.equal(putRes.stored, true)
    assert.equal(putRes.durability, 'local-only')
    assert.deepEqual(putRes.replicatedTo, [])

    const cid = await firstCidFor(backendA, 'offline.txt')
    assert.equal(await backendB.hasChunkRaw(cid), false, "an offline replica must never receive the chunk")
  })

  it('put() resolves promptly (bounded by the replication timeout) rather than hanging when a replica never acks', async () => {
    // Bob is "connected" per Alice's registry, but Bob never attaches the
    // chunk-replication service at all -- his side never answers a
    // chunk-push, simulating an unresponsive/vanished peer.
    markConnected(alice, bob)
    alice.registry.grantCapabilities(bob.podId, [`${RESOURCE}:replica`])

    attachService(nodeA, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendA, replicationTimeoutMs: 150 }))

    const socketA = await backendA.connect()
    const start = Date.now()
    const putRes = await send(socketA, { op: 'put', key: 'unresponsive.txt', data: toBase64(new Uint8Array([9])) })
    const elapsed = Date.now() - start

    assert.equal(putRes.stored, true)
    assert.equal(putRes.durability, 'local-only')
    assert.deepEqual(putRes.replicatedTo, [])
    assert.ok(elapsed < 1000, `put() must not hang waiting for an unresponsive replica (took ${elapsed}ms)`)
  })

  it("put() response is unchanged (no durability/replicatedTo fields) when no chunk-replication service is attached at all", async () => {
    // No attachService() call for backendA at all -- Phase B/D/E/F's own
    // behavior (no replication hook installed) must be completely
    // unaffected by this phase existing.
    const socketA = await backendA.connect()
    const putRes = await send(socketA, { op: 'put', key: 'plain.txt', data: toBase64(new Uint8Array([1])) })
    assert.equal(putRes.stored, true)
    assert.equal('durability' in putRes, false)
    assert.equal('replicatedTo' in putRes, false)
  })
})

// ---------------------------------------------------------------------------
// ctx.emit() observability events (Phase 1 of the mesh-KV-and-observability
// plan -- see chunk-replication.mjs's own module doc comment's
// "Observability events" section for the documented vocabulary this proves
// out).
// ---------------------------------------------------------------------------

describe('chunk-replication: ctx.emit() observability events', () => {
  it('emits chunk-replication:chunk-replicated when a connected, authorized replica fully acknowledges a push', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)
    const backendA = createBackendFor(alice)
    const backendB = createBackendFor(bob)

    markConnected(alice, bob)
    alice.registry.grantCapabilities(bob.podId, [`${RESOURCE}:replica`])
    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])

    const aliceHandle = attachService(nodeA, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendA }))
    attachService(nodeB, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendB }))

    const replicated = []
    aliceHandle.on('chunk-replication:chunk-replicated', (data) => replicated.push(data))

    const socketA = await backendA.connect()
    const putRes = await send(socketA, { op: 'put', key: 'greeting.txt', data: toBase64(new TextEncoder().encode('hi bob')) })
    assert.equal(putRes.durability, 'replicated')

    assert.equal(replicated.length, 1)
    assert.equal(replicated[0].bucketId, BUCKET)
    assert.deepEqual(replicated[0].replicatedTo, [bob.podId])
    assert.equal(replicated[0].cids.length, 1)
  })

  it('emits chunk-replication:push-rejected when an unauthorized sender attempts a chunk-push', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)
    const backendA = createBackendFor(alice)
    const backendB = createBackendFor(bob)

    // Bob does NOT grant alice write access -- his chunk-replication service
    // must reject the inbound push and emit accordingly.
    attachService(nodeA, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendA }))
    const bobHandle = attachService(nodeB, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendB }))

    const rejected = []
    bobHandle.on('chunk-replication:push-rejected', (data) => rejected.push(data))

    // Directly inject a chunk-push envelope as if alice's replicatePut() had
    // fired one, without needing a real 'replica' grant on alice's side.
    await nodeA.sendTo(bob.podId, {
      type: 'chunk-replication',
      bucketId: BUCKET,
      kind: 'chunk-push',
      requestId: 'req-1',
      cid: 'sha256-fake',
      data: toBase64(new Uint8Array([1, 2, 3])),
    })

    await new Promise((r) => setTimeout(r, 30))
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].bucketId, BUCKET)
    assert.equal(rejected[0].from, alice.podId)
    assert.equal(rejected[0].cid, 'sha256-fake')
    assert.equal(await backendB.hasChunkRaw('sha256-fake'), false, 'the unauthorized push must never be stored')
  })

  it('emits chunk-replication:read-repair when fetchChunk() successfully pulls a missing chunk from a peer', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)
    const backendA = createBackendFor(alice)
    const backendB = createBackendFor(bob)

    alice.registry.grantCapabilities(bob.podId, [`${RESOURCE}:read`])
    markConnected(bob, alice)

    attachService(nodeA, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendA }))
    const bobHandle = attachService(nodeB, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendB }))

    const repaired = []
    bobHandle.on('chunk-replication:read-repair', (data) => repaired.push(data))

    const socketA = await backendA.connect()
    await send(socketA, { op: 'put', key: 'shared.txt', data: toBase64(new TextEncoder().encode('content bob needs')) })
    const cid = await firstCidFor(backendA, 'shared.txt')

    await bobHandle.api.fetchChunk(cid)

    assert.equal(repaired.length, 1)
    assert.deepEqual(repaired[0], { bucketId: BUCKET, cid, from: alice.podId })
  })
})

// ---------------------------------------------------------------------------
// Authorization: an unauthorized peer must never be served chunk bytes
// ---------------------------------------------------------------------------

describe('chunk-replication: authorization on inbound chunk-fetch-request', () => {
  it("a peer without read access is refused, even if it knows a valid cid", async () => {
    const alice = await createPeer('alice')
    const carol = await createPeer('carol') // never granted anything
    const { nodeA, nodeB: nodeC } = wireNodes(alice, carol)
    const backendA = createBackendFor(alice)

    attachService(nodeA, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendA }))

    const socketA = await backendA.connect()
    await send(socketA, { op: 'put', key: 'secret.txt', data: toBase64(new TextEncoder().encode('for authorized eyes only')) })
    const cid = await firstCidFor(backendA, 'secret.txt')

    // Deliberately not calling alice.registry.grantCapabilities(carol.podId, ...).
    assert.equal(alice.registry.checkAccess(carol.podId, RESOURCE, 'read').allowed, false)

    const responses = []
    nodeC.onIncomingData((fromPubKey, data) => {
      if (data?.type === 'chunk-replication' && data.kind === 'chunk-fetch-response') responses.push(data)
    })

    await nodeC.sendTo(alice.podId, {
      type: 'chunk-replication',
      bucketId: BUCKET,
      kind: 'chunk-fetch-request',
      requestId: 'carol-req-1',
      cid,
    })

    await waitFor(() => responses.length > 0, 1000, "carol's unauthorized fetch request gets a response")
    assert.equal(responses[0].error, 'unauthorized')
    assert.equal(responses[0].data, undefined, 'no chunk bytes must ever be included in a rejection response')
  })

  it('an unauthorized chunk-push (sender lacks write access) is never stored', async () => {
    const alice = await createPeer('alice')
    const mallory = await createPeer('mallory') // never granted write access
    const { nodeA, nodeB: nodeM } = wireNodes(alice, mallory)
    const backendA = createBackendFor(alice)

    attachService(nodeA, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendA }))

    assert.equal(alice.registry.checkAccess(mallory.podId, RESOURCE, 'write').allowed, false)

    const fakeBytes = new TextEncoder().encode('poisoned content')
    const { IndexedDBChunkStore } = await import('@johnhenry/browsermesh-sync')
    const fakeCid = await IndexedDBChunkStore.computeCid(fakeBytes)

    await nodeM.sendTo(alice.podId, {
      type: 'chunk-replication',
      bucketId: BUCKET,
      kind: 'chunk-push',
      requestId: 'mallory-req-1',
      cid: fakeCid,
      data: toBase64(fakeBytes),
    })

    await new Promise((r) => setTimeout(r, 50))
    assert.equal(await backendA.hasChunkRaw(fakeCid), false, "alice's chunk store must never accept a push from an unauthorized peer")
  })
})

// ---------------------------------------------------------------------------
// Lazy pull / read-repair
// ---------------------------------------------------------------------------

describe('chunk-replication: lazy pull / read-repair', () => {
  it('a peer with no local copy of a chunk successfully fetches it from a peer that has it', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)
    const backendA = createBackendFor(alice)
    const backendB = createBackendFor(bob)

    // Alice must authorize Bob to read before she'll answer his have-query/fetch-request.
    alice.registry.grantCapabilities(bob.podId, [`${RESOURCE}:read`])
    // Bob must know Alice is a connected candidate to query.
    markConnected(bob, alice)

    attachService(nodeA, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendA }))
    const { api: bobApi } = attachService(nodeB, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendB }))

    const socketA = await backendA.connect()
    const plaintext = new TextEncoder().encode('content bob needs to read-repair')
    await send(socketA, { op: 'put', key: 'shared.txt', data: toBase64(plaintext) })
    const cid = await firstCidFor(backendA, 'shared.txt')

    assert.equal(await backendB.hasChunkRaw(cid), false, "bob must not have this chunk yet (no eager push attached in this test)")

    const fetched = await bobApi.fetchChunk(cid)
    const aliceBytes = await backendA.getChunkRaw(cid)
    assert.deepEqual(new Uint8Array(fetched), new Uint8Array(aliceBytes))

    // Persisted locally, not just returned -- a subsequent local read must not need the network again.
    assert.equal(await backendB.hasChunkRaw(cid), true)
    assert.deepEqual(new Uint8Array(await backendB.getChunkRaw(cid)), new Uint8Array(aliceBytes))
  })

  it('syncMissingChunks() catches up every missing chunk referenced by the current manifest', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)
    const backendA = createBackendFor(alice)
    const backendB = createBackendFor(bob)

    alice.registry.grantCapabilities(bob.podId, [`${RESOURCE}:read`, `${RESOURCE}:write`])
    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])
    markConnected(bob, alice)

    attachService(nodeA, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendA }))
    const { api: bobApi } = attachService(nodeB, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendB }))

    const socketA = await backendA.connect()
    await send(socketA, { op: 'put', key: 'a.txt', data: toBase64(new Uint8Array([1, 1])) })
    await send(socketA, { op: 'put', key: 'b.txt', data: toBase64(new Uint8Array([2, 2])) })

    // Simulate Bob having received the manifest (Phase F) by directly
    // merging Alice's manifest snapshot into Bob's backend -- this phase's
    // own job is only the chunk BYTES, not the manifest CRDT merge itself
    // (that's Phase F's job, already tested in manifest-sync.test.mjs).
    const snapshot = await backendA.getManifestSnapshot()
    await backendB.mergeManifestEntries(snapshot)

    assert.equal(await backendB.hasChunkRaw(await firstCidFor(backendA, 'a.txt')), false)
    assert.equal(await backendB.hasChunkRaw(await firstCidFor(backendA, 'b.txt')), false)

    const result = await bobApi.syncMissingChunks()
    assert.equal(result.fetched, 2)
    assert.equal(result.failed, 0)

    assert.equal(await backendB.hasChunkRaw(await firstCidFor(backendA, 'a.txt')), true)
    assert.equal(await backendB.hasChunkRaw(await firstCidFor(backendA, 'b.txt')), true)
  })

  it('cleanly fails (does not hang) when no connected peer has the requested chunk', async () => {
    const alice = await createPeer('alice')
    const backendA = createBackendFor(alice)
    const listeners = new Set()
    const nodeA = {
      podId: alice.podId,
      registry: alice.registry,
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo() {},
    }

    const { api } = attachService(nodeA, undefined, createChunkReplicationService({
      bucketId: BUCKET,
      cloudStorageBackend: backendA,
      haveQueryTimeoutMs: 100,
      fetchTimeoutMs: 100,
    }))

    const start = Date.now()
    await assert.rejects(() => api.fetchChunk('sha256-does-not-exist'), /no connected peer has chunk/)
    const elapsed = Date.now() - start
    assert.ok(elapsed < 1000, `fetchChunk() must fail promptly, not hang (took ${elapsed}ms)`)
  })

  it('cleanly fails when a peer claims to have a chunk but never actually delivers it', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob') // will falsely claim "have" but never answer the fetch request
    const { nodeA, nodeB } = wireNodes(alice, bob)
    const backendA = createBackendFor(alice)

    markConnected(alice, bob)
    alice.registry.grantCapabilities(bob.podId, [`${RESOURCE}:read`])

    // Bob answers "have" to every query but ignores fetch requests entirely -- a hand-rolled misbehaving peer, not the real service.
    nodeB.onIncomingData((fromPubKey, data) => {
      if (data?.type === 'chunk-replication' && data.kind === 'chunk-have-query') {
        nodeB.sendTo(fromPubKey, { type: 'chunk-replication', bucketId: BUCKET, kind: 'chunk-have-response', queryId: data.queryId, cid: data.cid, has: true })
      }
    })

    const { api } = attachService(nodeA, undefined, createChunkReplicationService({
      bucketId: BUCKET,
      cloudStorageBackend: backendA,
      haveQueryTimeoutMs: 100,
      fetchTimeoutMs: 100,
    }))

    const start = Date.now()
    await assert.rejects(() => api.fetchChunk('sha256-nonexistent-either-way'), /timed out|failed/)
    const elapsed = Date.now() - start
    assert.ok(elapsed < 1000, `fetchChunk() must fail promptly even when a responder ghosts the actual fetch (took ${elapsed}ms)`)
  })
})
