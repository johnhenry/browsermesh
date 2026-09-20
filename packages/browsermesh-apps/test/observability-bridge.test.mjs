/**
 * Integration tests for observability-bridge.mjs (Phase 2 of the
 * mesh-KV-and-observability plan -- see that file's own module doc comment
 * for the full design rationale, and `mesh-kv-and-observability.md`'s
 * "Design decisions" section for why this phase exists at all: giving
 * `visualizations.mjs`'s dormant, already-tested classes a genuine data
 * source for the first time).
 *
 * Unlike this family's other `MeshService` unit tests (grant-log.test.mjs,
 * chunk-replication.test.mjs, etc.), which wire a minimal duck-typed
 * `{podId, wallet, registry, onIncomingData, sendTo}` node pair, THIS file
 * constructs real `PeerNode` instances (`peer-node.mjs`) -- because Part 1
 * of this bridge's job is subscribing to `PeerNode`'s OWN `'peer:connect'`/
 * `'peer:disconnect'` events, which only a real `PeerNode` (not a duck-typed
 * stand-in) exposes. A real `PeerNode`'s public surface (`.podId`, `.wallet`,
 * `.registry`, `.onIncomingData(cb)`, `.sendTo(pubKey, data)`) is exactly
 * the duck type `attachService()`/`GrantLog`/`ChunkReplication` already
 * expect, so the same booted `PeerNode` instances are passed directly to
 * `attachService()` too -- no separate node object needed for the
 * MeshService layer.
 *
 * Two real `PeerNode`s are connected via `adoptIncomingSession()` (the
 * callee-side session-bookkeeping method `webrtc-negotiator.mjs`'s real
 * adapters use) fed a minimal in-memory duplex transport -- this is the
 * smallest way to get a real, working `sendTo()`/`onIncomingData()` bus
 * AND real `PeerRegistry.connect()`-driven `'peer:connect'` events on BOTH
 * sides, without a real WebRTC/transport-negotiator stack (reserved for
 * `test/real-peer/*`, gated behind `REQUIRE_REAL_PEER`, per this family's
 * existing convention).
 *
 * This is the proof the whole plan is FOR: real grant/chunk-replication
 * events, from real services attached to a real `PeerNode`, land in
 * `VisualizationExporter`'s JSON output via nothing but this bridge.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/observability-bridge.test.mjs
 */

import 'fake-indexeddb/auto'
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PeerNode } from '../src/peer-node.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createGrantLogService } from '../src/grant-log.mjs'
import { createChunkReplicationService } from '../src/chunk-replication.mjs'
import { createMeshKvService } from '../src/mesh-kv.mjs'
import { createCloudStorageBackend } from '../src/cloud-storage-backend.mjs'
import { createObservabilityBridge } from '../src/observability-bridge.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

const BUCKET = 'obs-bridge-test-bucket'
const RESOURCE = `s3:${BUCKET}`

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A real Ed25519 identity + wallet + registry bundle for one "peer" -- mirrors grant-log.test.mjs's / chunk-replication.test.mjs's own `createPeer()`. */
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
/** A fresh, fake-indexeddb-backed CloudStorageBackend with its OWN chunk/manifest/key databases, attributed to `peer`'s own identity -- mirrors chunk-replication.test.mjs's own `createBackendFor()`. */
function createBackendFor(peer) {
  bucketCounter += 1
  return createCloudStorageBackend({
    bucket: `${BUCKET}-${bucketCounter}`,
    dbName: `obs-bridge-test-${bucketCounter}`,
    nodeId: peer.podId,
  })
}

/**
 * Build a minimal in-memory duplex transport pair and adopt each side onto
 * a real, already-booted `PeerNode` via `adoptIncomingSession()` -- the
 * same callee-side session-bookkeeping method real transport-negotiator
 * adapters use. This makes `nodeA.sendTo(bobPodId, ...)`/`onIncomingData()`
 * genuinely work end-to-end, AND fires real `PeerRegistry.connect()` (and
 * therefore real `PeerNode` `'peer:connect'`) events on BOTH sides -- the
 * exact signal Part 1 of the bridge subscribes to.
 *
 * @param {PeerNode} nodeA
 * @param {PeerNode} nodeB
 */
async function linkRealNodes(nodeA, nodeB) {
  let aOnMessage = null
  let bOnMessage = null
  const transportForA = {
    send(data) { queueMicrotask(() => { if (bOnMessage) bOnMessage(data) }) },
    onMessage(cb) { aOnMessage = cb },
  }
  const transportForB = {
    send(data) { queueMicrotask(() => { if (aOnMessage) aOnMessage(data) }) },
    onMessage(cb) { bOnMessage = cb },
  }
  await nodeA.adoptIncomingSession(nodeB.podId, transportForA, 'inmemory')
  await nodeB.adoptIncomingSession(nodeA.podId, transportForB, 'inmemory')
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

/** Send one JSON command over a connected CloudStorageBackend socket and read back the one JSON response -- mirrors chunk-replication.test.mjs's own `send()`. */
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
// Peer connect/disconnect -> TopologySnapshot (no MeshService involved)
// ---------------------------------------------------------------------------

describe('createObservabilityBridge: real PeerNode connect/disconnect -> TopologySnapshot', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {PeerNode} */ let nodeA
  /** @type {PeerNode} */ let nodeB

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
  })

  it('a real connect adds a peer node + edge; a real disconnect removes the edge and marks the node disconnected', async () => {
    const bridge = createObservabilityBridge({ peerNode: nodeA })

    // The local node itself is present from construction.
    assert.ok(bridge.snapshot.getNode(alice.podId))
    assert.equal(bridge.snapshot.getNode(alice.podId).type, 'self')

    await linkRealNodes(nodeA, nodeB)

    const bobNode = bridge.snapshot.getNode(bob.podId)
    assert.ok(bobNode, 'a real peer:connect event added bob as a topology node')
    assert.equal(bobNode.status, 'connected')
    const edge = bridge.snapshot.links.find((l) => l.from === alice.podId && l.to === bob.podId)
    assert.ok(edge, 'a real peer:connect event added an edge from alice to bob')
    assert.equal(edge.status, 'connected')

    nodeA.disconnectPeer(bob.podId)

    const bobAfter = bridge.snapshot.getNode(bob.podId)
    assert.equal(bobAfter.status, 'disconnected', 'the node is kept, marked disconnected -- see module doc comment for why the node is not deleted')
    const edgeAfter = bridge.snapshot.links.find((l) => l.from === alice.podId && l.to === bob.podId)
    assert.equal(edgeAfter, undefined, 'the edge is removed on disconnect (it genuinely no longer exists)')

    bridge.teardown()
  })

  it('teardown() stops further updates from PeerNode events', async () => {
    const bridge = createObservabilityBridge({ peerNode: nodeA })
    bridge.teardown()

    await linkRealNodes(nodeA, nodeB)
    assert.equal(bridge.snapshot.getNode(bob.podId), null, 'no update reaches the snapshot after teardown()')
  })
})

// ---------------------------------------------------------------------------
// Full pipeline: real grant-log + chunk-replication services, attached to
// real PeerNodes, observed by the bridge, exported via VisualizationExporter.
// ---------------------------------------------------------------------------

describe('createObservabilityBridge: grant-log + chunk-replication events -> TrustHeatmap / TopologySnapshot -> VisualizationExporter', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {PeerNode} */ let nodeA
  /** @type {PeerNode} */ let nodeB
  /** @type {any} */ let backendA
  /** @type {any} */ let backendB

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    await linkRealNodes(nodeA, nodeB)
    backendA = createBackendFor(alice)
    backendB = createBackendFor(bob)
  })

  it('a real grant bumps TrustHeatmap, and a real replicated chunk-push updates a TopologySnapshot edge -- both visible in VisualizationExporter output', async () => {
    // --- Attach real Phase-1-instrumented services to alice's real PeerNode.
    let aliceGrantApi
    const grantHandle = attachService(nodeA, undefined, createGrantLogService({ resource: RESOURCE, onReady: (api) => { aliceGrantApi = api } }))
    const chunkHandle = attachService(nodeA, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendA }))
    // Bob's own side needs the chunk-replication service attached too, to
    // actually receive and ack a push -- mirrors chunk-replication.test.mjs's
    // eager-push test exactly.
    attachService(nodeB, undefined, createChunkReplicationService({ bucketId: BUCKET, cloudStorageBackend: backendB }))

    // --- Wire the bridge to observe BOTH of alice's attached services.
    const bridge = createObservabilityBridge({ peerNode: nodeA })
    bridge.observe(grantHandle)
    bridge.observe(chunkHandle)

    // --- Trigger a real grant: alice (the resource's admin) grants bob
    // read+write on RESOURCE via the real, signed GrantLog -- this is a
    // completely real ctx.emit('grant-log:grant-applied', ...) firing from
    // grant-log.mjs's own attach(), not a simulated event.
    await aliceGrantApi.bootstrapAdmin()
    await aliceGrantApi.grant(bob.podId, ['read', 'write'])

    assert.ok(bridge.heatmap.getTrust(alice.podId, bob.podId) > 0, 'a real grant-applied event raised bob\'s trust value in the heatmap')
    const trustAfterGrant = bridge.heatmap.getTrust(alice.podId, bob.podId)

    await aliceGrantApi.revoke(bob.podId, ['read'])
    assert.ok(bridge.heatmap.getTrust(alice.podId, bob.podId) < trustAfterGrant, 'a real revoke-applied event lowered bob\'s trust value again')

    // --- Authorize and trigger a real chunk replication (mirrors
    // chunk-replication.test.mjs's own eager-push authorization setup --
    // separate capability grants from the GrantLog-driven trust demo above,
    // exactly like that file's own precedent).
    alice.registry.grantCapabilities(bob.podId, [`${RESOURCE}:replica`])
    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])

    const socketA = await backendA.connect()
    const plaintext = new TextEncoder().encode('hello from alice, replicated to bob, observed by the bridge')
    const putRes = await send(socketA, { op: 'put', key: 'greeting.txt', data: toBase64(plaintext) })
    assert.equal(putRes.stored, true)
    assert.equal(putRes.durability, 'replicated', 'a connected, authorized replica must actually receive the push for this test to prove anything')
    assert.deepEqual(putRes.replicatedTo, [bob.podId])

    await waitFor(
      () => bridge.snapshot.links.some((l) => l.from === alice.podId && l.to === bob.podId && l.activity >= 1),
      1000,
      'a real chunk-replication:chunk-replicated event updated the topology edge\'s activity counter',
    )

    // --- The proof: VisualizationExporter's own, unmodified JSON export
    // reflects both real events, end to end.
    const topologyExport = bridge.exportTopology()
    assert.equal(topologyExport.type, 'topology')
    const exportedEdge = topologyExport.links.find((l) => l.from === alice.podId && l.to === bob.podId)
    assert.ok(exportedEdge, 'the replicated-to edge is present in the exported topology')
    assert.ok(exportedEdge.activity >= 1, 'the edge\'s activity counter is present in the exported topology')
    assert.deepEqual(exportedEdge.lastReplicatedCids, [(await backendA.getManifestSnapshot()).entries['greeting.txt'].value.chunks[0].cid])

    const heatmapExport = bridge.exportHeatmap()
    assert.equal(heatmapExport.type, 'trust-heatmap')
    assert.ok(heatmapExport.podIds.includes(alice.podId) && heatmapExport.podIds.includes(bob.podId))
    const aliceRow = heatmapExport.matrix[heatmapExport.podIds.indexOf(alice.podId)]
    const bobCol = heatmapExport.podIds.indexOf(bob.podId)
    assert.ok(aliceRow[bobCol] > 0, 'the trust value survives the round trip through VisualizationExporter#exportHeatmap()')

    bridge.teardown()
  })

  it('observe() accepts a handle for an unrecognized service name without throwing, and wires nothing for it', async () => {
    const bridge = createObservabilityBridge({ peerNode: nodeA })
    const seen = []
    const fakeHandle = { name: 'some-future-service:x', on: () => (() => {}) }
    assert.doesNotThrow(() => bridge.observe(fakeHandle))
    assert.deepEqual(seen, [])
    bridge.teardown()
  })

  it('observe() throws for a malformed handle (missing name/on)', () => {
    const bridge = createObservabilityBridge({ peerNode: nodeA })
    assert.throws(() => bridge.observe({}), /requires an attachService\(\) handle/)
    assert.throws(() => bridge.observe(null), /requires an attachService\(\) handle/)
    bridge.teardown()
  })
})

// ---------------------------------------------------------------------------
// mesh-kv: watching/unwatching + entry-set/entry-deleted -> TopologySnapshot
// edges (Phase 4 addition to this bridge -- mesh-kv.mjs shipped after this
// file's original Phase 2 pass, see observability-bridge.mjs's module doc
// comment's "mesh-kv:" section for the full curation rationale).
// ---------------------------------------------------------------------------

describe('createObservabilityBridge: mesh-kv events -> TopologySnapshot edges', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {PeerNode} */ let nodeA
  /** @type {PeerNode} */ let nodeB

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    await linkRealNodes(nodeA, nodeB)
  })

  it('watch()/unwatch() add and remove an edge, and an authorized remote write bumps the edge activity counter', async () => {
    const STORE = 'obs-bridge-kv-store'
    const RESOURCE = `kv:${STORE}`
    // Bob's own registry must trust alice's writes for bob's merge gate to
    // accept them -- mirrors mesh-kv.test.mjs's own authorization setup.
    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])

    const aliceKvHandle = attachService(nodeA, undefined, createMeshKvService({ storeId: STORE }))
    const bobKvHandle = attachService(nodeB, undefined, createMeshKvService({ storeId: STORE }))

    const bridge = createObservabilityBridge({ peerNode: nodeB })
    bridge.observe(bobKvHandle)

    aliceKvHandle.api.watch(bob.podId)
    aliceKvHandle.api.set('greeting', 'hi from alice')

    await waitFor(
      () => bridge.snapshot.links.some((l) => l.from === alice.podId && l.to === bob.podId && l.activity >= 1),
      1000,
      "a real mesh-kv:entry-set event (from alice's accepted remote merge) bumped bob's topology edge activity",
    )

    const exported = bridge.exportTopology()
    const edge = exported.links.find((l) => l.from === alice.podId && l.to === bob.podId)
    assert.ok(edge, 'the alice -> bob edge is present in the exported topology')
    assert.equal(edge.activity, 1)
    assert.equal(edge.storeId, STORE)
    assert.equal(edge.lastKey, 'greeting')

    bobKvHandle.api.watch(alice.podId)
    const watchEdge = bridge.snapshot.links.find((l) => l.from === bob.podId && l.to === alice.podId)
    assert.ok(watchEdge, "bob's own mesh-kv:watching event added an outbound edge to alice")
    assert.equal(watchEdge.status, 'watching')

    bobKvHandle.api.unwatch(alice.podId)
    assert.equal(
      bridge.snapshot.links.find((l) => l.from === bob.podId && l.to === alice.podId),
      undefined,
      "bob's own mesh-kv:unwatching event removed that outbound edge",
    )

    bridge.teardown()
  })

  it("a local set()/delete() (from === the observed peer's own podId) does not create or update any edge", async () => {
    const STORE = 'obs-bridge-kv-local-store'
    const bobKvHandle = attachService(nodeB, undefined, createMeshKvService({ storeId: STORE }))

    const bridge = createObservabilityBridge({ peerNode: nodeB })
    bridge.observe(bobKvHandle)

    bobKvHandle.api.set('local-only', 1)
    bobKvHandle.api.delete('local-only')

    assert.deepEqual(bridge.snapshot.links, [], 'a purely local write/delete has no counterpart peer, so no edge is created')

    bridge.teardown()
  })
})

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe('createObservabilityBridge: constructor validation', () => {
  it('throws without a real peerNode (on()/off() required)', () => {
    assert.throws(() => createObservabilityBridge({}), /peerNode is required/)
    assert.throws(() => createObservabilityBridge({ peerNode: { podId: 'x' } }), /peerNode is required/)
  })
})
