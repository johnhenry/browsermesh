/**
 * Sharing one peer's `VirtualNetwork` access with specific, authorized mesh
 * peers — no direct connection of their own to the underlying service.
 *
 * The real-world scenario: Alice runs a local service (e.g. an S3-compatible
 * emulator) her own `VirtualNetwork` already reaches. `MeshRelayHost`
 * (Alice's side) lets her share that specific service with specific mesh
 * peers over the mesh connection they already have — gated per-peer,
 * per-service, per-action via `PeerRegistry`'s existing
 * `grantCapabilities()`/`revokeCapabilities()`/`checkAccess()` (zero new
 * API). `MeshRelayBackend` (Bob's side) is a `browsermesh-netway` `Backend`,
 * so Bob's application code addresses the shared service through the same
 * `VirtualNetwork.connect()` API it would use for anything else.
 *
 * This example simulates the mesh connection itself in-process (a pair of
 * `sendTo`/`onIncomingData` functions wired directly together) — see
 * `examples/02-two-pods-discover-and-message.mjs` for the same convention —
 * so it runs headless with no real WebRTC/network, but the relay framing,
 * authorization, and multiplexing exercised are exactly what runs over a
 * real `PeerNode` connection in production (see
 * `packages/browsermesh-apps/test/real-peer/mesh-relay.test.mjs` for that
 * real-WebRTC, real-TCP proof).
 */

import assert from 'node:assert/strict'
import { VirtualNetwork } from '@johnhenry/browsermesh-netway'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import {
  PeerRegistry,
  MeshRelayHost,
  MeshRelayBackend,
} from '@johnhenry/browsermesh-apps'

const ALICE = 'pod-alice'
const BOB = 'pod-bob'

// ── A simulated mesh connection between Alice and Bob (see 02's own
//    EventEmitterTransport convention for the same "no real network" idea) ──

function createNodePair(podIdA, podIdB) {
  const listenersA = new Set()
  const listenersB = new Set()
  return [
    { // Alice's side
      podId: podIdA,
      onIncomingData(cb) { listenersA.add(cb); return () => listenersA.delete(cb) },
      async sendTo(_pubKey, data) { for (const cb of listenersB) cb(podIdA, data) },
    },
    { // Bob's side
      podId: podIdB,
      onIncomingData(cb) { listenersB.add(cb); return () => listenersB.delete(cb) },
      async sendTo(_pubKey, data) { for (const cb of listenersA) cb(podIdB, data) },
    },
  ]
}

const [aliceNode, bobNode] = createNodePair(ALICE, BOB)

// ── Alice's own VirtualNetwork, with a real local "S3-emulator-style"
//    service reachable over the loopback backend (stands in for a real
//    GatewayBackend-tunneled TCP service — see the real-peer test for that) ──

const aliceNetwork = new VirtualNetwork()
const s3Listener = await aliceNetwork.listen('mem://localhost:9000')
;(async () => {
  const sock = await s3Listener.accept()
  const req = await sock.read()
  console.log('  [local service] received:', new TextDecoder().decode(req))
  await sock.write(new TextEncoder().encode('200 OK: object stored'))
})()

// ── Alice's registry: real PeerRegistry + real MeshACL, exactly like
//    mesh-bootstrap.mjs's createMeshNode() wiring ──

const registry = new PeerRegistry({
  localPodId: ALICE,
  peerManager: new MeshPeerManager({}),
  trustGraph: new TrustGraph(),
  acl: new MeshACL({ owner: ALICE }),
})

// ── Alice exposes the service to the mesh (not yet to any specific peer) ──

const relayHost = new MeshRelayHost({ node: aliceNode, network: aliceNetwork, registry })
relayHost.exposeService('s3-local', 'mem://localhost:9000')
console.log('alice exposes services:', relayHost.listServices())

// ── Bob tries to reach it before being granted access — refused, not a
//    silent no-op ──

const bobBackend = new MeshRelayBackend({ node: bobNode, relayPeerPubKey: ALICE })
const bobNetwork = new VirtualNetwork()
bobNetwork.addBackend('via-alice', bobBackend)

await assert.rejects(
  () => bobNetwork.connect('via-alice://s3-local'),
  { name: 'ConnectionRefusedError' },
)
console.log('bob (ungranted): refused ✓')

// ── Alice grants Bob access to exactly this service and action — the same
//    PeerRegistry.grantCapabilities() every other peer-permission story in
//    this family uses, composing a `mesh-relay:s3-local:connect` scope ──

registry.grantCapabilities(BOB, ['mesh-relay:s3-local:connect'])

const socket = await bobNetwork.connect('via-alice://s3-local')
await socket.write(new TextEncoder().encode('PUT /bucket/object.json'))
const response = await socket.read()
assert.equal(new TextDecoder().decode(response), '200 OK: object stored')
console.log('bob (granted):   relayed real bytes through alice ✓ ->', new TextDecoder().decode(response))
await socket.close()

// ── Revoking access denies the *next* connect attempt (an already-open
//    session is left alone — this call happens after the one above closed) ──

registry.revokeCapabilities(BOB, ['mesh-relay:s3-local:connect'])

await assert.rejects(
  () => bobNetwork.connect('via-alice://s3-local'),
  { name: 'ConnectionRefusedError' },
)
console.log('bob (revoked):   refused again ✓')

await bobBackend.close()
await relayHost.detach()
await bobNetwork.close()
await aliceNetwork.close()

console.log('ok: a peer can share specific VirtualNetwork access with specific authorized mesh peers, gated by real ACL scopes')
