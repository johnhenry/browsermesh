// Two real PeerNodes, one Node process, no server: proves Phase 2's
// composition layer (mesh-bootstrap.mjs + signaling.mjs + webrtc-negotiator.mjs)
// against a real RTCPeerConnection rather than a mock.
//
// Mirrors packages/browsermesh-transport/test/real-peer/webrtc.test.mjs:
// same optional `node-datachannel` devDependency guard (skip when absent,
// hard-fail when REQUIRE_REAL_PEER=1 so CI can't silently report a
// decorative skip as success), same "iceServers: []" hermetic loopback
// setup (host candidates only -- no STUN/TURN/network dependency).
//
// What's real here: real Ed25519 identities (IdentityWallet /
// MeshIdentityManager), real discovery via DiscoveryManager + ManualStrategy
// (the existing, real, Node-safe DiscoveryStrategy -- BroadcastChannelStrategy
// is browser-only), a real WebRTCMeshManager/WebRTCPeerConnection pair
// exchanging real SDP/ICE over an in-process signaling bus
// (MeshSignalingChannel), and real bytes moving over the resulting
// DataChannel via PeerNode.sendTo()/onIncomingData().
//
// What's a Node-safe substitute, not the real thing: the signaling bus
// itself (an in-process pub/sub Set, shaped exactly like
// browsermesh-pod's EventEmitterTransport, standing in for a real
// BroadcastChannel/WebSocket relay in a browser) and discovery
// (ManualStrategy, standing in for BroadcastChannelStrategy). A full
// cross-package integration suite exercising the *browser* discovery/
// signaling paths together is Phase 7's job, not this phase's.

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
  describe('mesh-bootstrap against real WebRTC peers', () => {
    it('skipped: optional devDependency `node-datachannel` is not installed', () => {})
  })
}

const describeIfReal = ndc ? describe : describe.skip

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

/**
 * A shared in-process pub/sub bus standing in for a real signaling
 * transport (BroadcastChannel in a browser, a WebSocket relay, etc). Same
 * shape as browsermesh-pod's EventEmitterTransport (a shared `Set` of
 * receiver functions, self-filtered on send) but written locally rather
 * than imported, since browsermesh-apps has no dependency on
 * browsermesh-pod.
 */
function createSharedSignalingBus() {
  return new Set()
}

/** One endpoint on a createSharedSignalingBus() bus. Matches the
 * `{send(msg), onMessage(cb)}` shape MeshSignalingChannel requires. */
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

describeIfReal('mesh-bootstrap: two real PeerNodes over real WebRTC', () => {
  /** @type {any} */ let createMeshNode
  /** @type {any} */ let ManualStrategy
  /** @type {any} */ let DiscoveryRecord

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
    ;({ ManualStrategy, DiscoveryRecord } = await import('@johnhenry/browsermesh-discovery'))
  })

  after(() => {
    // libdatachannel holds a worker pool that would keep the process alive.
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('discovers each other, negotiates a real WebRTC connection, and moves real bytes both ways', async () => {
    const signalingBus = createSharedSignalingBus()
    const discoveryA = new ManualStrategy()
    const discoveryB = new ManualStrategy()

    const nodeA = await createMeshNode({
      label: 'alice',
      discoveryStrategies: [discoveryA],
      signalingTransport: createBusTransport(signalingBus),
      iceServers: [], // host candidates only: hermetic, no STUN/TURN/network dependency
    })
    const nodeB = await createMeshNode({
      label: 'bob',
      discoveryStrategies: [discoveryB],
      signalingTransport: createBusTransport(signalingBus),
      iceServers: [],
    })

    try {
      assert.equal(nodeA.state, 'running')
      assert.equal(nodeB.state, 'running')
      assert.ok(nodeA.podId, 'alice has a real identity')
      assert.ok(nodeB.podId, 'bob has a real identity')
      assert.notEqual(nodeA.podId, nodeB.podId)

      // -- Real discovery (DiscoveryManager + ManualStrategy) ---------------
      // BroadcastChannelStrategy is browser-only; ManualStrategy is the
      // existing real, Node-safe DiscoveryStrategy this repo ships.
      discoveryA.addPeer(new DiscoveryRecord({ podId: nodeB.podId, transport: 'webrtc', label: 'bob' }))
      discoveryB.addPeer(new DiscoveryRecord({ podId: nodeA.podId, transport: 'webrtc', label: 'alice' }))

      const foundByA = await nodeA.discover()
      const foundByB = await nodeB.discover()
      assert.ok(foundByA.some((r) => r.podId === nodeB.podId), 'alice discovers bob')
      assert.ok(foundByB.some((r) => r.podId === nodeA.podId), 'bob discovers alice')

      // -- Real WebRTC signaling + connection --------------------------------
      // Alice is the caller: her PeerNode negotiates 'webrtc' via
      // MeshTransportNegotiator -> webrtc-negotiator.mjs's factory, which
      // creates a real SDP offer, relays it over the shared signaling bus,
      // and waits for the real DataChannel to open. Bob never calls
      // connectToPeer() himself -- his side of the connection comes up
      // via the standing signaling.onOffer() auto-answer wired into his
      // own webrtc-negotiator instance, exactly as a passive mesh peer
      // would in production.
      const session = await nodeA.connectToPeer(
        nodeB.podId,
        { webrtc: nodeB.podId },
        { answerTimeoutMs: 10_000, openTimeoutMs: 10_000 },
      )
      assert.equal(session.transport, 'webrtc')
      assert.ok(nodeA.hasActiveSession(nodeB.podId))

      // Bob's side of the same connection comes up reactively; wait for it.
      await waitFor(
        () => nodeB.meshManager.getConnection(nodeA.podId)?.isOpen,
        10_000,
        "bob's side of the DataChannel to open",
      )
      const bobsConnToAlice = nodeB.meshManager.getConnection(nodeA.podId)
      const alicesConnToBob = nodeA.meshManager.getConnection(nodeB.podId)
      assert.ok(alicesConnToBob.isOpen, "alice's WebRTCPeerConnection reports open")
      assert.ok(bobsConnToAlice.isOpen, "bob's WebRTCPeerConnection reports open")

      // -- Real bytes, both directions ---------------------------------------
      // Alice -> Bob via PeerNode's own public API (sendTo / onIncomingData),
      // proving the composition root -- not just the raw WebRTCMeshManager --
      // is what carries real application data.
      const atBob = []
      bobsConnToAlice.onMessage((data) => atBob.push(data))
      await nodeA.sendTo(nodeB.podId, { kind: 'greeting', text: 'hello from alice' })
      await waitFor(() => atBob.length === 1, 5_000, 'bob to receive a real DataChannel message')
      assert.deepEqual(atBob[0], { kind: 'greeting', text: 'hello from alice' })

      // Bob -> Alice. Bob's PeerNode never called connectToPeer() (he only
      // answered), so he has no PeerNode-level session to send through --
      // that symmetric bookkeeping is Phase 3's concern (CRDT sync formalizes
      // the message-routing pattern for both sides of a connection). Bob
      // sends over his real, already-open WebRTCPeerConnection directly,
      // and Alice receives it through PeerNode.onIncomingData(), which
      // Phase 2 already wires up for any session PeerNode itself created.
      const atAlice = []
      const unsubAlice = nodeA.onIncomingData((pubKey, data) => atAlice.push({ pubKey, data }))
      bobsConnToAlice.send('plain string from bob')
      await waitFor(() => atAlice.length === 1, 5_000, 'alice to receive real data via onIncomingData')
      assert.equal(atAlice[0].pubKey, nodeB.podId)
      assert.equal(atAlice[0].data, 'plain string from bob')

      unsubAlice()
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
