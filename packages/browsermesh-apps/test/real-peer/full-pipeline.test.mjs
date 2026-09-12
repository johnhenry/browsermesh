// Two real PeerNodes, one Node process, no server: proves Phase 7 (issue #61)
// -- the one thing no existing real-peer suite proves, because each of them
// deliberately proves exactly one phase in isolation (connect-do-one-thing-
// disconnect). This suite builds ONE `createMeshNode()` pair with CRDT sync
// (Phase 3), a kernel-gated mesh capability (Phase 4/5), and a mesh-relay
// host (Phase 8) ALL wired onto the SAME live WebRTC connection at the same
// time, and interleaves real traffic on all three so any envelope-type
// collision, dispatch-ordering bug, or resource-contention issue between
// them would show up here, not in production.
//
// Mirrors mesh-bootstrap.test.mjs / mesh-sync.test.mjs / kernel-mesh.test.mjs
// / mesh-relay.test.mjs's real-peer setup exactly (same optional
// `node-datachannel` devDependency guard, same hermetic `iceServers: []`
// loopback setup). Deliberately does NOT re-prove what those suites already
// prove in depth (full reload-simulation persistence, exhaustive grant/deny/
// revoke matrices, real TCP via a wsh double) -- one pass of each, focused
// on whether the pieces compose without stepping on each other.
//
// What's real here: everything the other real-peer suites prove real
// (identity, discovery, WebRTC signaling/connection, PeerNode.sendTo() /
// onIncomingData() over a real DataChannel) PLUS all three composition
// layers active simultaneously: `node.sync` (MeshSyncBinding, envelope.type
// 'mesh-sync'), `node.relayHost` (MeshRelayHost, envelope.type
// 'mesh-relay') + a real `MeshRelayBackend` client, and a real `Kernel`
// tenant's `caps.mesh` view (untyped raw payloads, no envelope wrapper at
// all) -- all three dispatching through the exact same
// `PeerNode.onIncomingData()` bus over the exact same DataChannel.
//
// A property worth calling out explicitly (not a bug, but easy to get
// wrong): `Kernel#meshFor()`'s `onReceive` is NOT filtered by
// `envelope.type` -- unlike `MeshSyncBinding`/`MeshRelayHost`, which both
// check `data.type` before acting. A kernel tenant's `caps.mesh.onReceive`
// therefore sees every inbound payload on the connection, including
// `mesh-sync`- and `mesh-relay`-typed envelopes not meant for it. This
// suite asserts that this is harmless (the tenant callback never throws,
// and typed envelopes are visibly labeled `.type` for tenant code that
// wants to filter them out itself) rather than silently assuming it.

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
  describe('full pipeline against real WebRTC peers', () => {
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

/** Shared in-process pub/sub bus standing in for a real signaling transport
 * (see mesh-bootstrap.test.mjs for the full rationale). */
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

describeIfReal('full pipeline: sync + kernel-gated mesh + relay all wired onto one live WebRTC connection', () => {
  /** @type {any} */ let createMeshNode
  /** @type {any} */ let createMeshKernel
  /** @type {any} */ let ManualStrategy
  /** @type {any} */ let DiscoveryRecord
  /** @type {any} */ let KERNEL_CAP
  /** @type {any} */ let VirtualNetwork
  /** @type {any} */ let MeshRelayBackend

  before(async () => {
    // webrtc.mjs reads RTCPeerConnection off the global at call time, so
    // the globals must be in place before any WebRTCPeerConnection is
    // constructed (not necessarily before it's imported).
    Object.assign(globalThis, {
      RTCPeerConnection: ndc.RTCPeerConnection,
      RTCIceCandidate: ndc.RTCIceCandidate,
      RTCSessionDescription: ndc.RTCSessionDescription,
    })
    ;({ createMeshNode } = await import('../../src/mesh-bootstrap.mjs'))
    ;({ createMeshKernel } = await import('../../src/kernel-mesh.mjs'))
    ;({ MeshRelayBackend } = await import('../../src/mesh-relay-backend.mjs'))
    ;({ ManualStrategy, DiscoveryRecord } = await import('@johnhenry/browsermesh-discovery'))
    ;({ KERNEL_CAP } = await import('@johnhenry/browsermesh-kernel'))
    ;({ VirtualNetwork } = await import('@johnhenry/browsermesh-netway'))
  })

  after(() => {
    // libdatachannel holds a worker pool that would keep the process alive.
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('discovers, connects once over real WebRTC, then runs CRDT sync, kernel-gated send/receive, and mesh relay concurrently on that one connection without any of the three interfering with the others', async () => {
    const signalingBus = createSharedSignalingBus()
    const discoveryA = new ManualStrategy()
    const discoveryB = new ManualStrategy()

    // Alice hosts a real in-memory echo service on her own VirtualNetwork
    // (LoopbackBackend, the default -- deliberately not the heavier real-TCP
    // double mesh-relay.test.mjs uses, since this suite's job is proving
    // composition, not re-proving the TCP data plane a dedicated suite
    // already covers).
    const aliceNetwork = new VirtualNetwork()
    const echoListener = await aliceNetwork.listen('mem://localhost:9100')
    ;(async () => {
      while (true) {
        const sock = await echoListener.accept()
        if (!sock) break
        ;(async () => {
          try {
            while (true) {
              const chunk = await sock.read()
              if (chunk === null) break
              await sock.write(chunk)
            }
          } catch { /* socket closed mid-read/write */ }
        })()
      }
    })()

    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`

    const nodeA = await createMeshNode({
      label: 'alice',
      discoveryStrategies: [discoveryA],
      signalingTransport: createBusTransport(signalingBus),
      iceServers: [], // host candidates only: hermetic, no STUN/TURN/network dependency
      enableSync: true,
      syncDbName: `full-pipeline-alice-${runId}`,
      enableRelayHost: true,
      relayHostNetwork: aliceNetwork,
      relayHostServices: { 'pipeline-echo': 'mem://localhost:9100' },
    })
    const nodeB = await createMeshNode({
      label: 'bob',
      discoveryStrategies: [discoveryB],
      signalingTransport: createBusTransport(signalingBus),
      iceServers: [],
      enableSync: true,
      syncDbName: `full-pipeline-bob-${runId}`,
    })

    try {
      // -- All three composition layers wired onto the same node pair --------
      assert.ok(nodeA.sync, 'alice has a sync binding')
      assert.ok(nodeB.sync, 'bob has a sync binding')
      assert.ok(nodeA.relayHost, 'alice has a relay host')
      assert.deepEqual(nodeA.relayHost.listServices(), ['pipeline-echo'])

      // -- Real discovery + a SINGLE real WebRTC connection --------------------
      // Only one connection is established for this whole test: sync, kernel-
      // mesh, and relay traffic all ride the same DataChannel from here on.
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

      // -- Kernel wired to alice's connected PeerNode, over the same session --
      const kernel = createMeshKernel({ peerNode: nodeA })
      const tenant = kernel.createTenant({ capabilities: [KERNEL_CAP.MESH] })

      // Authorize bob for both the kernel-mesh view and the relay service.
      // Sync itself needs no grant -- PeerNode.sendTo() carries it unchecked,
      // exactly as mesh-sync.test.mjs already proves; only the kernel and
      // relay layers consult the registry.
      nodeA.registry.grantCapabilities(nodeB.podId, ['mesh:send', 'mesh:receive', 'mesh-relay:pipeline-echo:connect'])

      // A raw collector on bob's side: every payload that ever reaches
      // PeerNode.onIncomingData(), unfiltered, so the test can see exactly
      // what arrives regardless of which subsystem (or none) claims it.
      const rawAtBob = []
      nodeB.onIncomingData((pubKey, data) => rawAtBob.push(data))

      // A raw collector on alice's kernel tenant view: exercises the "not
      // envelope-scoped" property documented above -- everything sent to
      // alice over this connection passes through here too, typed or not.
      const atAliceViaKernel = []
      const unsubKernel = tenant.caps.mesh.onReceive((peerId, data) => atAliceViaKernel.push({ peerId, data }))

      // == 1. CRDT sync, live on the shared connection =========================
      nodeA.sync.engine.create('pipeline-notes', 'lww-map')
      nodeA.sync.engine.update('pipeline-notes', (m) => m.set('stage', 'sync-started', Date.now(), nodeA.podId))
      await nodeA.sync.syncDocWithPeer(nodeB.podId, 'pipeline-notes')
      await waitFor(
        () => nodeB.sync.engine.getState('pipeline-notes')?.stage === 'sync-started',
        5_000,
        "bob's engine to observe alice's sync delta over the shared connection",
      )

      // == 2. Kernel-gated send, interleaved with the sync channel above =======
      // Nothing about the sync traffic above should have been mistaken for
      // kernel-mesh traffic (it's a typed 'mesh-sync' envelope; kernel-mesh
      // sends are raw, untyped payloads) or vice versa.
      await tenant.caps.mesh.send(nodeB.podId, { kind: 'kernel-data', text: 'hello from a kernel tenant, mid-pipeline' })
      await waitFor(() => rawAtBob.some((d) => d?.kind === 'kernel-data'), 5_000, 'bob to receive the kernel-gated payload')
      const kernelPayloadAtBob = rawAtBob.find((d) => d?.kind === 'kernel-data')
      assert.deepEqual(kernelPayloadAtBob, { kind: 'kernel-data', text: 'hello from a kernel tenant, mid-pipeline' })

      // Bob's own sync binding also saw that same payload on the shared bus
      // (it subscribes to the same onIncomingData()) but correctly ignored
      // it (no `type: 'mesh-sync'`) rather than crashing or misinterpreting
      // it as a document delta.
      assert.equal(nodeB.sync.engine.size, 1, "bob's sync engine still has exactly the one document -- the kernel payload wasn't mistaken for a sync delta")

      // Bob replies with a plain PeerNode-level send (no kernel on bob's
      // side -- proving the kernel view's receive path works for arbitrary
      // peer traffic, not just other kernel tenants).
      await nodeB.sendTo(nodeA.podId, { kind: 'kernel-reply', text: 'received, mid-pipeline' })
      await waitFor(
        () => atAliceViaKernel.some((m) => m.data?.kind === 'kernel-reply'),
        5_000,
        "alice's kernel tenant to observe bob's reply via caps.mesh.onReceive",
      )

      // == 3. Mesh relay, through alice, while sync + kernel channels stay live =
      const bobNetwork = new VirtualNetwork()
      const relayBackend = new MeshRelayBackend({ node: nodeB, relayPeerPubKey: nodeA.podId })
      bobNetwork.addBackend('via-alice', relayBackend)

      const relaySocket = await bobNetwork.connect('via-alice://pipeline-echo')
      await relaySocket.write(enc.encode('ping-through-the-shared-connection'))
      const echoed = await relaySocket.read()
      assert.equal(dec.decode(echoed), 'ping-through-the-shared-connection', 'the relay round trip completed over the same connection the other two channels are using')
      await relaySocket.close()
      await relayBackend.close()

      // The kernel tenant's unfiltered onReceive() also saw the mesh-relay
      // envelope traffic addressed to alice (the host side) during the relay
      // exchange -- documenting, not hiding, that `caps.mesh` is a raw view
      // of the connection rather than scoped to one envelope type.
      assert.ok(
        atAliceViaKernel.some((m) => m.data?.type === 'mesh-relay'),
        "alice's kernel tenant view also observed mesh-relay envelope traffic on the shared connection (expected: caps.mesh.onReceive is not envelope-scoped)",
      )

      // == 4. One more sync round after the interleaved kernel + relay traffic =
      // Proves the sync channel is still healthy -- nothing about the kernel
      // or relay traffic corrupted MeshSyncBinding's dispatch state.
      nodeB.sync.engine.update('pipeline-notes', (m) => m.set('stage', 'relay-and-kernel-done', Date.now(), nodeB.podId))
      await nodeB.sync.syncDocWithPeer(nodeA.podId, 'pipeline-notes')
      await waitFor(
        () => nodeA.sync.engine.getState('pipeline-notes')?.stage === 'relay-and-kernel-done',
        5_000,
        "alice's engine to observe bob's final sync delta after interleaved kernel + relay traffic",
      )
      assert.deepEqual(nodeA.sync.engine.getState('pipeline-notes'), nodeB.sync.engine.getState('pipeline-notes'), 'both sides converged on the identical final state')

      unsubKernel()
      kernel.close()
      await aliceNetwork.close()
    } finally {
      nodeA.meshManager.closeAll()
      nodeB.meshManager.closeAll()
      await nodeA.shutdown()
      await nodeB.shutdown()
      await nodeA.signaling.close()
      await nodeB.signaling.close()
    }
  })
})
