// Run with: node --import ./test/_setup-globals.mjs --test test/webrtc-binding-wiring.test.mjs
//
// createMeshNode() wires the node's identity into its WebRTC connections, so each side proves
// possession of its pod key over the DTLS fingerprints of the descriptions it applied. A peer that
// does not (transport older than 0.6.0) is closed after the binding timeout, and the reason reaches
// the application.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createMeshNode } from '../src/mesh-bootstrap.mjs'
import { createWebRTCTransportFactory } from '../src/webrtc-negotiator.mjs'
import { PeerNode } from '../src/peer-node.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { ManualStrategy } from '@johnhenry/browsermesh-discovery'
import {
  IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL,
} from '@johnhenry/browsermesh-core'

const silentSignaling = { send() {}, onMessage() {} }

async function meshNode(extra = {}) {
  const node = await createMeshNode({
    label: 'binding',
    signalingTransport: silentSignaling,
    discoveryStrategies: [new ManualStrategy()],
    skipBoot: true,
    ...extra,
  })
  return node
}

describe('createMeshNode wires the node identity into WebRTC', () => {
  it('by default the identity is used and a peer must prove itself (10 s)', async () => {
    const node = await meshNode()
    try {
      assert.deepEqual(node.meshManager.bindingPolicy, { enabled: true, requirePeerBinding: true, timeoutMs: 10_000 })
    } finally { await node.signaling.close() }
  })

  it('webrtcBindingTimeoutMs sets the timeout', async () => {
    const node = await meshNode({ webrtcBindingTimeoutMs: 1234 })
    try {
      assert.equal(node.meshManager.bindingPolicy.timeoutMs, 1234)
    } finally { await node.signaling.close() }
  })

  it('webrtcAllowUnboundPeers keeps proving this node but accepts a peer that never proves itself', async () => {
    const node = await meshNode({ webrtcAllowUnboundPeers: true })
    try {
      assert.deepEqual(node.meshManager.bindingPolicy, { enabled: true, requirePeerBinding: false, timeoutMs: 10_000 })
    } finally { await node.signaling.close() }
  })

  it('webrtcIdentityBinding: false turns it off (no proof is sent or required)', async () => {
    const node = await meshNode({ webrtcIdentityBinding: false })
    try {
      assert.equal(node.meshManager.bindingPolicy.enabled, false)
    } finally { await node.signaling.close() }
  })
})

// ---------------------------------------------------------------------------
// The reason a connection was refused reaches the caller and the application
// ---------------------------------------------------------------------------

/** Just enough of a WebRTCPeerConnection and of the signalling channel. */
function fakeConnection() {
  const stateCbs = []
  const conn = {
    isOpen: false,
    state: 'connecting',
    bindingFailure: null,
    onIceCandidate() {},
    onClose() {},
    onError() {},
    onStateChange(cb) { stateCbs.push(cb) },
    async createOffer() { return { type: 'offer', sdp: 'o' } },
    async handleAnswer() {},
    async handleOffer() { return { type: 'answer', sdp: 'a' } },
    /** The connection is closed: by the binding timer, say. */
    closeWith(reason) { conn.bindingFailure = reason; conn.state = 'closed'; for (const cb of stateCbs) cb('closed') },
  }
  return conn
}
function fakeSignaling() {
  const handlers = { offer: [], answer: [], ice: [] }
  return {
    handlers,
    send() {},
    onOffer(cb) { handlers.offer.push(cb) },
    onAnswer(cb) { handlers.answer.push(cb); return () => { handlers.answer.splice(handlers.answer.indexOf(cb), 1) } },
    onIce(cb) { handlers.ice.push(cb) },
  }
}

describe('a connection closed because the peer did not prove its identity says why', () => {
  it('the caller\'s connect() rejects with the reason, at once, instead of waiting out the open timeout', async () => {
    const conn = fakeConnection()
    const signaling = fakeSignaling()
    const failures = []
    const factory = createWebRTCTransportFactory({
      localPodId: 'local',
      meshManager: { async connectToPeer() { return conn }, getConnection() { return conn } },
      signaling,
      onBindingFailure: (f) => failures.push(f),
    })
    const attempt = factory('remote', { openTimeoutMs: 60_000 })
    await new Promise((r) => setImmediate(r))
    for (const cb of signaling.handlers.answer) cb('remote', { type: 'answer', sdp: 'a' }, 'default')
    await new Promise((r) => setImmediate(r))
    conn.closeWith('timeout')
    await assert.rejects(attempt, /identity binding failed: timeout/)
    assert.deepEqual(failures, [{ remotePodId: 'remote', connectionId: 'default', reason: 'timeout' }])
  })

  it('a connection that closes for another reason is not reported as a binding failure', async () => {
    const conn = fakeConnection()
    const signaling = fakeSignaling()
    const failures = []
    const factory = createWebRTCTransportFactory({
      localPodId: 'local',
      meshManager: { async connectToPeer() { return conn }, getConnection() { return conn } },
      signaling,
      onBindingFailure: (f) => failures.push(f),
    })
    const attempt = factory('remote', { openTimeoutMs: 60_000 })
    await new Promise((r) => setImmediate(r))
    for (const cb of signaling.handlers.answer) cb('remote', { type: 'answer', sdp: 'a' }, 'default')
    await new Promise((r) => setImmediate(r))
    conn.closeWith(null)
    await assert.rejects(attempt, /closed before it opened/)
    assert.deepEqual(failures, [])
  })

  it('the callee side reports it too', async () => {
    const conn = fakeConnection()
    const signaling = fakeSignaling()
    const failures = []
    createWebRTCTransportFactory({
      localPodId: 'local',
      meshManager: { async connectToPeer() { return conn }, getConnection() { return conn } },
      signaling,
      onIncomingConnection() {},
      onBindingFailure: (f) => failures.push(f),
    })
    // An offer comes in; the answer goes out; the connection never gets bound and is closed.
    const answered = signaling.handlers.offer[0]('remote', { type: 'offer', sdp: 'o' }, 'conn-1')
    await new Promise((r) => setImmediate(r))
    conn.closeWith('timeout')
    await answered
    assert.deepEqual(failures, [{ remotePodId: 'remote', connectionId: 'conn-1', reason: 'timeout' }])
  })
})

describe('PeerNode.reportBindingFailure', () => {
  it('announces the failure as a node event the application can listen to', async () => {
    const wallet = new IdentityWallet({ identityManager: new MeshIdentityManager({}) })
    const { podId } = await wallet.createIdentity('n')
    const node = new PeerNode({
      wallet,
      registry: new PeerRegistry({ localPodId: podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: podId }) }),
      discovery: { start() {}, stop() {}, announce() {} },
      transportNegotiator: { registerAdapter() {}, async negotiate() { return null } },
    })
    const seen = []
    node.on('peer:binding-failed', (e) => seen.push(e))
    node.reportBindingFailure('remote-pod', { transport: 'webrtc', connectionId: 'c', reason: 'timeout' })
    assert.deepEqual(seen, [{ pubKey: 'remote-pod', transport: 'webrtc', connectionId: 'c', reason: 'timeout' }])
  })
})
