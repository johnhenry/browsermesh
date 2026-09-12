/**
 * The full browsermesh story, end to end, in one script: two peers discover
 * each other, connect, converge on shared CRDT state, run kernel-gated
 * application code over that connection, and one of them relays through to
 * a service the other exposes — all riding the SAME connection at once,
 * not four separate connect/disconnect cycles.
 *
 * This is the narrative counterpart to
 * `packages/browsermesh-apps/test/real-peer/full-pipeline.test.mjs`, which
 * proves the identical composition — discovery, connect, CRDT sync, a
 * kernel-gated mesh capability, and mesh relay, all wired onto one live
 * `PeerNode` pair at once — over a REAL WebRTC connection (real
 * `RTCPeerConnection`s via `node-datachannel`). This example simulates the
 * connection itself in-process (the same convention `02-two-pods-discover-
 * and-message.mjs` and `06-mesh-relay.mjs` already use — a shared
 * `sendTo`/`onIncomingData` bus standing in for a real DataChannel) so it
 * runs headless with no native dependencies. Everything layered *on top of*
 * that connection below — `DiscoveryManager`, `MeshSyncEngine`, `Kernel`'s
 * mesh capability, `MeshRelayHost`/`MeshRelayBackend` — is the real,
 * unmodified production code; only the transport is a stand-in.
 *
 * Individually, each piece here already has its own dedicated proof
 * elsewhere (`test/real-peer/mesh-bootstrap.test.mjs` for discovery+connect,
 * `mesh-sync.test.mjs` for CRDT sync + durable persistence,
 * `kernel-mesh.test.mjs` for the kernel capability + revocation,
 * `mesh-relay.test.mjs` for the relay). What this example (and its real-
 * WebRTC counterpart test) adds is proof — and a readable story — that all
 * four compose on one connection without stepping on each other.
 */

import assert from 'node:assert/strict'
import { DiscoveryManager, ManualStrategy, DiscoveryRecord } from '@johnhenry/browsermesh-discovery'
import { MeshPeerManager, TrustGraph, MeshACL, CapabilityValidator, CapabilityToken } from '@johnhenry/browsermesh-core'
import { InMemorySyncStorage } from '@johnhenry/browsermesh-sync'
import { KERNEL_CAP } from '@johnhenry/browsermesh-kernel'
import { VirtualNetwork } from '@johnhenry/browsermesh-netway'
import {
  PeerRegistry,
  createMeshSync,
  createMeshKernel,
  MeshRelayHost,
  MeshRelayBackend,
} from '@johnhenry/browsermesh-apps'

const ALICE = 'pod-alice'
const BOB = 'pod-bob'

// ── Step 1: discovery ───────────────────────────────────────────────────
// Real `DiscoveryManager` + `ManualStrategy` — the Node-safe, explicit-peer
// strategy this family ships for non-browser environments (see
// `mesh-bootstrap.mjs`'s own doc comment). `BroadcastChannelStrategy`/PEX/DHT
// strategies plug into this exact same `DiscoveryManager` API in a browser.

const discoveryA = new ManualStrategy()
const discoveryB = new ManualStrategy()
const managerA = new DiscoveryManager({
  strategies: [discoveryA],
  localRecord: new DiscoveryRecord({ podId: ALICE, label: 'alice', transport: 'webrtc' }),
})
const managerB = new DiscoveryManager({
  strategies: [discoveryB],
  localRecord: new DiscoveryRecord({ podId: BOB, label: 'bob', transport: 'webrtc' }),
})

discoveryA.addPeer(new DiscoveryRecord({ podId: BOB, label: 'bob', transport: 'webrtc' }))
discoveryB.addPeer(new DiscoveryRecord({ podId: ALICE, label: 'alice', transport: 'webrtc' }))

const foundByAlice = await managerA.discover()
const foundByBob = await managerB.discover()
assert.ok(foundByAlice.some((r) => r.podId === BOB), 'alice discovers bob')
assert.ok(foundByBob.some((r) => r.podId === ALICE), 'bob discovers alice')
console.log('1. discovery: alice and bob found each other ✓')
await managerA.stop()
await managerB.stop()

// ── Step 2: connect ─────────────────────────────────────────────────────
// A simulated bidirectional bus stands in for the real WebRTC DataChannel
// `createMeshNode()`/`MeshTransportNegotiator` would establish (see
// `06-mesh-relay.mjs` for the identical convention). Every subsystem below
// dispatches over this one pair of `sendTo`/`onIncomingData` functions —
// there is only ever ONE connection in this example.

function createNodePair(podIdA, podIdB) {
  const listenersA = new Set()
  const listenersB = new Set()
  return [
    { // alice's side
      podId: podIdA,
      onIncomingData(cb) { listenersA.add(cb); return () => listenersA.delete(cb) },
      async sendTo(_pubKey, data) { for (const cb of listenersB) cb(podIdA, data) },
    },
    { // bob's side
      podId: podIdB,
      onIncomingData(cb) { listenersB.add(cb); return () => listenersB.delete(cb) },
      async sendTo(_pubKey, data) { for (const cb of listenersA) cb(podIdB, data) },
    },
  ]
}

const [aliceNode, bobNode] = createNodePair(ALICE, BOB)
console.log('2. connected: alice <-> bob (one shared connection, everything below rides it) ✓')

// Real `PeerRegistry`, wired to a real `MeshACL` + `CapabilityValidator` —
// exactly `mesh-bootstrap.mjs`'s own wiring — so the kernel-mesh grant/deny
// and mesh-relay authorization below are backed by genuine ACL scopes and
// genuine capability tokens, not stubs.
const registry = new PeerRegistry({
  localPodId: ALICE,
  peerManager: new MeshPeerManager({}),
  trustGraph: new TrustGraph(),
  acl: new MeshACL({ owner: ALICE }),
  capabilityValidator: new CapabilityValidator(),
  tokenFactory: (opts) => new CapabilityToken(opts),
})
// `Kernel#meshFor()` expects its mesh provider to expose `.registry.checkAccess()`
// directly (the same duck-typed shape a real `PeerNode` satisfies) --
// attach it to alice's side of the simulated connection.
aliceNode.registry = registry

// ── Step 3: CRDT sync, riding the connection ────────────────────────────
// Real `MeshSyncEngine`s on both sides, wired to `onIncomingData()`/
// `sendTo()` via `createMeshSync()` — the same Phase 3 composition
// `createMeshNode({ enableSync: true })` uses internally. `InMemorySyncStorage`
// here (vs. the durable `IndexedDBSyncStorage` default) keeps this example
// dependency-free; `mesh-sync.test.mjs`'s real-peer suite is the durable-
// persistence-survives-a-reload proof.
const aliceSync = createMeshSync({ node: aliceNode, storage: new InMemorySyncStorage() })
const bobSync = createMeshSync({ node: bobNode, storage: new InMemorySyncStorage() })

aliceSync.engine.create('trip-plan', 'lww-map')
aliceSync.engine.update('trip-plan', (m) => m.set('destination', 'Kyoto', Date.now(), ALICE))
await aliceSync.syncDocWithPeer(BOB, 'trip-plan')

bobSync.engine.update('trip-plan', (m) => m.set('dates', 'April 2027', Date.now(), BOB))
await bobSync.syncDocWithPeer(ALICE, 'trip-plan')

const expected = { destination: 'Kyoto', dates: 'April 2027' }
assert.deepEqual(aliceSync.engine.getState('trip-plan'), expected)
assert.deepEqual(bobSync.engine.getState('trip-plan'), expected)
console.log('3. CRDT sync: both sides converged on', aliceSync.engine.getState('trip-plan'), '✓')

// ── Step 4: kernel-gated application code, over the SAME connection ────
// A real `Kernel`, wired to alice's connected node via `createMeshKernel()`
// (Phase 4). A tenant granted `KERNEL_CAP.MESH` gets a scoped `{ send,
// onReceive }` view — every delivery gated by `registry.checkAccess()` —
// not the raw `PeerNode` API. `registry.grantCapabilities()` here issues a
// real `CapabilityToken` (Phase 5), so this grant could be live-revoked
// mid-session exactly like `kernel-mesh.test.mjs` proves; this example
// keeps the grant standing to focus on the composition story.
const kernel = createMeshKernel({ peerNode: aliceNode })
const tenant = kernel.createTenant({ capabilities: [KERNEL_CAP.MESH] })

registry.grantCapabilities(BOB, ['mesh:send', 'mesh:receive', 'mesh-relay:trip-notes:connect'])

const rawAtBob = []
bobNode.onIncomingData((_pubKey, data) => rawAtBob.push(data))

await tenant.caps.mesh.send(BOB, { kind: 'itinerary-ready', text: 'Kyoto trip plan is finalized' })
assert.ok(rawAtBob.some((d) => d?.kind === 'itinerary-ready'), 'bob received the kernel-gated payload')
// The sync engine on bob's side saw the same payload on the shared bus too
// (it subscribes to the same onIncomingData()) and correctly ignored it —
// it isn't a 'mesh-sync'-typed envelope — instead of misreading it as a
// document delta.
assert.equal(bobSync.engine.size, 1, "bob's sync engine still has exactly the one document")
console.log('4. kernel-gated send: bob received', rawAtBob.find((d) => d?.kind === 'itinerary-ready'), '✓ (and sync was unaffected)')

// ── Step 5: mesh relay, through alice, while sync + kernel state stays live
// Alice shares a small local service with specifically-authorized peers
// (Phase 8) — here, an in-memory `mem://` note-taking service on her own
// `VirtualNetwork` (`06-mesh-relay.mjs`'s real-local-service pattern).
// Bob, already authorized above (`mesh-relay:trip-notes:connect`), relays
// through alice via `MeshRelayBackend`, over the exact same connection the
// CRDT sync and kernel-mesh traffic above already used.
const aliceNetwork = new VirtualNetwork()
const notesListener = await aliceNetwork.listen('mem://localhost:9200')
;(async () => {
  const sock = await notesListener.accept()
  const req = await sock.read()
  console.log('   [alice\'s local service] received:', new TextDecoder().decode(req))
  await sock.write(new TextEncoder().encode('saved: ' + new TextDecoder().decode(req)))
})()

const relayHost = new MeshRelayHost({ node: aliceNode, network: aliceNetwork, registry })
relayHost.exposeService('trip-notes', 'mem://localhost:9200')

const relayBackend = new MeshRelayBackend({ node: bobNode, relayPeerPubKey: ALICE })
const bobNetwork = new VirtualNetwork()
bobNetwork.addBackend('via-alice', relayBackend)

const relaySocket = await bobNetwork.connect('via-alice://trip-notes')
await relaySocket.write(new TextEncoder().encode('pack sunscreen'))
const ack = await relaySocket.read()
assert.equal(new TextDecoder().decode(ack), 'saved: pack sunscreen')
console.log('5. mesh relay: bob ->', new TextDecoder().decode(ack), '✓ (through alice, same connection)')
await relaySocket.close()

// ── Step 6: the connection is still healthy after all of the above ─────
// One more sync round, after kernel-mesh and relay traffic interleaved with
// it, proves nothing about those two corrupted CRDT sync's dispatch state.
aliceSync.engine.update('trip-plan', (m) => m.set('status', 'packed', Date.now(), ALICE))
await aliceSync.syncDocWithPeer(BOB, 'trip-plan')
assert.equal(bobSync.engine.getState('trip-plan').status, 'packed')
console.log('6. CRDT sync still healthy after interleaved kernel + relay traffic ✓')

await relayBackend.close()
await relayHost.detach()
await bobNetwork.close()
await aliceNetwork.close()
aliceSync.engine.destroy()
bobSync.engine.destroy()
kernel.close()

console.log('\nok: discovery, connect, CRDT sync, a kernel-gated mesh capability, and mesh relay all composed on one connection without interfering with each other')
