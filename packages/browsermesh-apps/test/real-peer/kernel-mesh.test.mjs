// Two real PeerNodes, one real Kernel tenant, no server: proves Phase 4 --
// browsermesh-kernel's MESH capability wired to a real, capability-scoped
// send/receive view of a connected PeerNode, gated by PeerRegistry's real
// checkAccess() -- against a real RTCPeerConnection, not a mock.
//
// Mirrors mesh-bootstrap.test.mjs's real-peer setup exactly (same optional
// `node-datachannel` devDependency guard, same hermetic `iceServers: []`
// loopback setup) and layers the kernel-mesh composition
// (`src/kernel-mesh.mjs`'s `createMeshKernel()`) on top of it.
//
// What's real here: everything mesh-bootstrap.test.mjs already proves real
// (identity, discovery, WebRTC signaling/connection, PeerNode.sendTo() /
// onIncomingData() over a real DataChannel) PLUS a real `Kernel` instance,
// a real tenant with `KERNEL_CAP.MESH` granted, and real bytes sent over the
// real connection through `tenant.caps.mesh.send()` -- not a mock kernel,
// not a mock PeerNode.

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
  describe('kernel mesh capability against real WebRTC peers', () => {
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

describeIfReal('kernel mesh capability: a real Kernel tenant sends/receives over a real WebRTC PeerNode connection', () => {
  /** @type {any} */ let createMeshNode
  /** @type {any} */ let createMeshKernel
  /** @type {any} */ let ManualStrategy
  /** @type {any} */ let DiscoveryRecord
  /** @type {any} */ let KERNEL_CAP
  /** @type {any} */ let requireCap
  /** @type {any} */ let CapabilityDeniedError
  /** @type {any} */ let MeshAccessDeniedError

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
    ;({ ManualStrategy, DiscoveryRecord } = await import('@johnhenry/browsermesh-discovery'))
    ;({ KERNEL_CAP, requireCap, CapabilityDeniedError, MeshAccessDeniedError } =
      await import('@johnhenry/browsermesh-kernel'))
  })

  after(() => {
    // libdatachannel holds a worker pool that would keep the process alive.
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('gates send/receive by real PeerRegistry.checkAccess(), moves real bytes once granted, and denies un-granted tenants entirely', async () => {
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
      // -- Real discovery + real WebRTC connection (same as mesh-bootstrap.test.mjs) --
      discoveryA.addPeer(new DiscoveryRecord({ podId: nodeB.podId, transport: 'webrtc', label: 'bob' }))
      discoveryB.addPeer(new DiscoveryRecord({ podId: nodeA.podId, transport: 'webrtc', label: 'alice' }))
      await nodeA.discover()
      await nodeB.discover()

      const session = await nodeA.connectToPeer(
        nodeB.podId,
        { webrtc: nodeB.podId },
        { answerTimeoutMs: 10_000, openTimeoutMs: 10_000 },
      )
      assert.equal(session.transport, 'webrtc')

      await waitFor(
        () => nodeB.meshManager.getConnection(nodeA.podId)?.isOpen,
        10_000,
        "bob's side of the DataChannel to open",
      )
      const bobsConnToAlice = nodeB.meshManager.getConnection(nodeA.podId)
      assert.ok(nodeA.meshManager.getConnection(nodeB.podId).isOpen)
      assert.ok(bobsConnToAlice.isOpen)

      // -- Kernel wired to alice's real, connected PeerNode -------------------
      const kernel = createMeshKernel({ peerNode: nodeA })

      // == Negative path 1: capability never granted -> throws, no silent no-op ==
      const untrustedTenant = kernel.createTenant({ capabilities: [] }) // no KERNEL_CAP.MESH
      assert.equal(untrustedTenant.caps.mesh, undefined, 'ungranted tenant gets no mesh view at all')
      assert.throws(
        () => requireCap(untrustedTenant.caps, KERNEL_CAP.MESH),
        { name: 'CapabilityDeniedError' },
      )
      assert.ok(CapabilityDeniedError) // sanity: the class import itself resolved

      // == Negative path 2: capability granted, but the target peer is not ==
      // == authorized by the real PeerRegistry ACL -> real deny, no bytes sent ==
      const trustedTenant = kernel.createTenant({ capabilities: [KERNEL_CAP.MESH] })
      assert.notEqual(trustedTenant.caps.mesh, true, 'a real mesh provider is wired, so this must be the real scoped view, not the bare marker')
      assert.equal(typeof trustedTenant.caps.mesh.send, 'function')
      assert.equal(typeof trustedTenant.caps.mesh.onReceive, 'function')

      const atBobBeforeGrant = []
      bobsConnToAlice.onMessage((data) => atBobBeforeGrant.push(data))

      await assert.rejects(
        () => trustedTenant.caps.mesh.send(nodeB.podId, { should: 'never arrive' }),
        { name: 'MeshAccessDeniedError' },
      )
      assert.ok(MeshAccessDeniedError)
      // Give any (incorrect) send a moment to have arrived, then confirm it didn't.
      await new Promise((r) => setTimeout(r, 100))
      assert.deepEqual(atBobBeforeGrant, [], 'nothing was sent -- the deny must be real, not a warning-only check')

      // == Positive path: grant the peer real ACL scopes, then real bytes move ==
      nodeA.registry.grantCapabilities(nodeB.podId, ['mesh:send', 'mesh:receive'])

      const atBob = []
      bobsConnToAlice.onMessage((data) => atBob.push(data))
      await trustedTenant.caps.mesh.send(nodeB.podId, { kind: 'kernel-mesh', text: 'hello from a kernel tenant' })
      await waitFor(() => atBob.length === 1, 5_000, 'bob to receive real bytes sent through the kernel mesh capability')
      assert.deepEqual(atBob[0], { kind: 'kernel-mesh', text: 'hello from a kernel tenant' })

      // == onReceive: real inbound data reaches the tenant's scoped view too ==
      const receivedByTenant = []
      const unsubscribe = trustedTenant.caps.mesh.onReceive((peerId, data) => receivedByTenant.push({ peerId, data }))
      bobsConnToAlice.send('plain string from bob, via kernel onReceive')
      await waitFor(() => receivedByTenant.length === 1, 5_000, 'the kernel tenant to receive real data via caps.mesh.onReceive')
      assert.equal(receivedByTenant[0].peerId, nodeB.podId)
      assert.equal(receivedByTenant[0].data, 'plain string from bob, via kernel onReceive')
      unsubscribe()

      kernel.close()
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
