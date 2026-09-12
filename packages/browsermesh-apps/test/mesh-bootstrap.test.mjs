/**
 * Unit-level test for mesh-bootstrap.mjs's TURN/ICE server plumbing
 * (Phase 6, issue #60).
 *
 * This does NOT need a real WebRTC stack (`node-datachannel`, see
 * test/real-peer/mesh-bootstrap.test.mjs for that suite) -- per the plan's
 * own verification note, "a unit-level assertion is sufficient; real
 * TURN-required connectivity is out of scope to test in CI." What's
 * asserted here is config plumbing: ICE servers passed into
 * `createMeshNode(options)` reach the `RTCPeerConnection` constructor
 * `WebRTCMeshManager`/`WebRTCPeerConnection` eventually build, since
 * neither class exposes its effective ICE server list through a public
 * getter. A mock `RTCPeerConnection` that records its constructor config is
 * the same technique browsermesh-transport/test/webrtc.test.mjs already
 * uses for the same reason.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-bootstrap.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

// ---------------------------------------------------------------------------
// Mock RTCPeerConnection -- webrtc.mjs reads RTCPeerConnection off the
// global at call time (inside createOffer()/handleOffer()), not at import
// time, so this only needs to be in place before createOffer() runs.
// ---------------------------------------------------------------------------

/** @type {any} */ let lastConfig = null

class MockRTCDataChannel {
  readyState = 'open'
  onopen = null
  onmessage = null
  onclose = null
  onerror = null
  close() {}
}

class MockRTCPeerConnection {
  onicecandidate = null
  ondatachannel = null
  onconnectionstatechange = null
  connectionState = 'new'
  signalingState = 'stable'

  constructor(config) {
    this.config = config
    lastConfig = config
  }

  createDataChannel() { return new MockRTCDataChannel() }
  async createOffer() { return { type: 'offer', sdp: 'mock-offer-sdp' } }
  async setLocalDescription() {}
  close() {}
}

globalThis.RTCPeerConnection = MockRTCPeerConnection

const { createMeshNode } = await import('../src/mesh-bootstrap.mjs')

// ---------------------------------------------------------------------------
// Stub signaling transport -- MeshSignalingChannel only requires
// send(msg)/onMessage(cb); see signaling.mjs.
// ---------------------------------------------------------------------------

function createStubSignalingTransport() {
  return { send() {}, onMessage() {} }
}

describe('createMeshNode: TURN/ICE server plumbing (Phase 6)', () => {
  it('passes caller-supplied TURN servers through to the constructed WebRTCMeshManager', async () => {
    const turnServer = { urls: 'turn:turn.example.com:3478', username: 'alice', credential: 's3cr3t' }

    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      iceServers: [turnServer],
      skipBoot: true, // constructing the manager doesn't require a full boot
    })

    assert.ok(node.meshManager, 'createMeshNode attaches meshManager for inspection')

    lastConfig = null
    const conn = await node.meshManager.connectToPeer('remote-pod-id')
    await conn.createOffer() // triggers `new RTCPeerConnection({ iceServers })`

    assert.ok(lastConfig, 'RTCPeerConnection was constructed')
    assert.deepEqual(
      lastConfig.iceServers,
      [turnServer],
      'the TURN server supplied to createMeshNode() reached the effective ICE server list',
    )
  })

  it('merges TURN servers alongside defaults via mergeIceServers, rather than replacing them', async () => {
    // DEFAULT_ICE_SERVERS is empty (see webrtc.mjs), so the "merged" result
    // for a caller who only supplies TURN servers is just those servers --
    // this asserts the plumbing goes through mergeIceServers's validation
    // (which silently drops malformed entries) rather than being handed to
    // WebRTCMeshManager raw.
    const turnServer = { urls: 'turn:turn.example.com:3478', username: 'bob', credential: 'hunter2' }
    const malformed = { username: 'no-urls-field' }

    const node = await createMeshNode({
      label: 'bob',
      signalingTransport: createStubSignalingTransport(),
      iceServers: [turnServer, malformed],
      skipBoot: true,
    })

    lastConfig = null
    const conn = await node.meshManager.connectToPeer('remote-pod-id')
    await conn.createOffer()

    assert.deepEqual(
      lastConfig.iceServers,
      [turnServer],
      'malformed entries are dropped and valid TURN servers are kept, via mergeIceServers',
    )
  })

  it('an explicit empty iceServers array is honoured as "no ICE servers" (default/hermetic behaviour unchanged)', async () => {
    const node = await createMeshNode({
      label: 'carol',
      signalingTransport: createStubSignalingTransport(),
      iceServers: [],
      skipBoot: true,
    })

    lastConfig = null
    const conn = await node.meshManager.connectToPeer('remote-pod-id')
    await conn.createOffer()

    assert.deepEqual(
      lastConfig.iceServers,
      [],
      'iceServers: [] must still mean "no ICE servers at all" -- this is exactly what ' +
      'test/real-peer/mesh-bootstrap.test.mjs relies on for a hermetic connection',
    )
  })

  it('omitting iceServers preserves today\'s default (no ICE servers) behaviour', async () => {
    const node = await createMeshNode({
      label: 'dave',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
    })

    lastConfig = null
    const conn = await node.meshManager.connectToPeer('remote-pod-id')
    await conn.createOffer()

    assert.deepEqual(
      lastConfig.iceServers,
      [],
      'default behaviour (no TURN/STUN supplied) must be unchanged by Phase 6',
    )
  })
})
