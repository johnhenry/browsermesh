// Run with: node --import ./test/_setup-globals.mjs --test test/handshake.test.mjs
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Polyfill crypto if needed (Node has it, but ensure getRandomValues + randomUUID)
if (typeof globalThis.crypto === 'undefined') {
  const { webcrypto } = await import('node:crypto')
  globalThis.crypto = webcrypto
}
if (typeof globalThis.crypto.getRandomValues !== 'function') {
  const { webcrypto } = await import('node:crypto')
  globalThis.crypto.getRandomValues = (arr) => webcrypto.getRandomValues(arr)
}
if (typeof globalThis.crypto.randomUUID !== 'function') {
  const { webcrypto } = await import('node:crypto')
  globalThis.crypto.randomUUID = () => webcrypto.randomUUID()
}

// Polyfill btoa/atob for Node if needed
if (typeof globalThis.btoa !== 'function') {
  globalThis.btoa = (str) => Buffer.from(str, 'binary').toString('base64')
}
if (typeof globalThis.atob !== 'function') {
  globalThis.atob = (b64) => Buffer.from(b64, 'base64').toString('binary')
}

import {
  SignalingClient,
  DirectInputHandshake,
  HandshakeCoordinator,
  toBase64Url,
  fromBase64Url,
  TOKEN_TTL_MS,
  DEFAULT_TIMEOUT_MS,
} from '../src/handshake.mjs'

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

class MockWebSocket {
  constructor(url) {
    this.url = url
    this.readyState = 0 // CONNECTING
    this.sent = []
    this._listeners = {}
    // Auto-open after microtask
    Promise.resolve().then(() => {
      this.readyState = 1 // OPEN
      this._fire('open', {})
    })
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3; this._fire('close', {}) }
  addEventListener(ev, cb) { (this._listeners[ev] ??= []).push(cb) }
  removeEventListener(ev, cb) { this._listeners[ev] = (this._listeners[ev] || []).filter(c => c !== cb) }
  _fire(ev, data) { for (const cb of this._listeners[ev] || []) cb(data) }
  _receive(data) { this._fire('message', { data: JSON.stringify(data) }) }
}
MockWebSocket.OPEN = 1
MockWebSocket.CLOSED = 3

// ---------------------------------------------------------------------------
// Mock TransportFactory
// ---------------------------------------------------------------------------

function createMockTransportFactory(overrides = {}) {
  return {
    async negotiate(localPodId, remotePodId, signaler, endpointOpts) {
      return overrides.transport || { type: 'webrtc', connected: true }
    },
    async create(type, opts) {
      const transport = overrides.transport || { type, connected: true }
      if (overrides.handleOffer) transport.handleOffer = overrides.handleOffer
      return transport
    },
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('TOKEN_TTL_MS', () => {
  it('equals 300000 (5 minutes)', () => {
    assert.equal(TOKEN_TTL_MS, 300000)
  })
})

describe('DEFAULT_TIMEOUT_MS', () => {
  it('equals 30000 (30 seconds)', () => {
    assert.equal(DEFAULT_TIMEOUT_MS, 30000)
  })
})

// ---------------------------------------------------------------------------
// toBase64Url / fromBase64Url
// ---------------------------------------------------------------------------

describe('toBase64Url / fromBase64Url', () => {
  it('round-trips arbitrary bytes', () => {
    const input = new Uint8Array([0, 1, 127, 128, 255, 42, 99])
    const encoded = toBase64Url(input)
    const decoded = fromBase64Url(encoded)
    assert.deepEqual(decoded, input)
  })

  it('round-trips empty array', () => {
    const input = new Uint8Array(0)
    const encoded = toBase64Url(input)
    const decoded = fromBase64Url(encoded)
    assert.deepEqual(decoded, input)
  })

  it('produces known values without padding or + or /', () => {
    // btoa of [251, 239] = "+/8" in standard base64 -> "-_8" in base64url
    const input = new Uint8Array([251, 239, 255])
    const encoded = toBase64Url(input)
    assert.ok(!encoded.includes('+'), 'should not contain +')
    assert.ok(!encoded.includes('/'), 'should not contain /')
    assert.ok(!encoded.includes('='), 'should not contain =')
    const decoded = fromBase64Url(encoded)
    assert.deepEqual(decoded, input)
  })
})

// ---------------------------------------------------------------------------
// SignalingClient
// ---------------------------------------------------------------------------

describe('SignalingClient', () => {
  /** @type {SignalingClient} */
  let client
  /** @type {MockWebSocket|null} */
  let lastWs

  beforeEach(() => {
    lastWs = null
    const WsCtor = function (url) {
      const ws = new MockWebSocket(url)
      lastWs = ws
      return ws
    }
    client = new SignalingClient({
      url: 'wss://signal.example.com',
      localPodId: 'pod-local',
      _WebSocket: WsCtor,
    })
  })

  it('throws if localPodId is missing', () => {
    assert.throws(
      () => new SignalingClient({ url: 'wss://x' }),
      /localPodId is required/,
    )
  })

  it('connect sends a register message', async () => {
    await client.connect()
    assert.ok(lastWs)
    assert.equal(lastWs.sent.length, 1)
    const reg = lastWs.sent[0]
    assert.equal(reg.type, 'register')
    assert.equal(reg.podId, 'pod-local')
    assert.equal(reg.from, 'pod-local')
    assert.equal(reg.to, null)
  })

  it('connected returns true after connect', async () => {
    assert.equal(client.connected, false)
    await client.connect()
    assert.equal(client.connected, true)
  })

  it('sendOffer sends correct JSON', async () => {
    await client.connect()
    client.sendOffer('pod-remote', { sdp: 'offer-sdp' })
    const msg = lastWs.sent.find(m => m.type === 'offer')
    assert.ok(msg)
    assert.equal(msg.from, 'pod-local')
    assert.equal(msg.to, 'pod-remote')
    assert.deepEqual(msg.offer, { sdp: 'offer-sdp' })
  })

  it('sendAnswer sends correct JSON', async () => {
    await client.connect()
    client.sendAnswer('pod-remote', { sdp: 'answer-sdp' })
    const msg = lastWs.sent.find(m => m.type === 'answer')
    assert.ok(msg)
    assert.equal(msg.to, 'pod-remote')
    assert.deepEqual(msg.answer, { sdp: 'answer-sdp' })
  })

  it('sendIceCandidate sends correct JSON', async () => {
    await client.connect()
    client.sendIceCandidate('pod-remote', { candidate: 'c1' })
    const msg = lastWs.sent.find(m => m.type === 'ice-candidate')
    assert.ok(msg)
    assert.equal(msg.to, 'pod-remote')
    assert.deepEqual(msg.candidate, { candidate: 'c1' })
  })

  it('onOffer fires when offer message received', async () => {
    await client.connect()
    const received = []
    client.onOffer((data, fromPodId) => received.push({ data, fromPodId }))
    lastWs._receive({ type: 'offer', from: 'pod-A', offer: { sdp: 'o1' } })
    assert.equal(received.length, 1)
    assert.equal(received[0].fromPodId, 'pod-A')
    assert.deepEqual(received[0].data.offer, { sdp: 'o1' })
  })

  it('onAnswer fires when answer message received', async () => {
    await client.connect()
    const received = []
    client.onAnswer((data, fromPodId) => received.push({ data, fromPodId }))
    lastWs._receive({ type: 'answer', from: 'pod-B', answer: { sdp: 'a1' } })
    assert.equal(received.length, 1)
    assert.equal(received[0].fromPodId, 'pod-B')
  })

  it('onIceCandidate fires when ice-candidate message received', async () => {
    await client.connect()
    const received = []
    client.onIceCandidate((data, fromPodId) => received.push({ data, fromPodId }))
    lastWs._receive({ type: 'ice-candidate', from: 'pod-C', candidate: { c: 1 } })
    assert.equal(received.length, 1)
    assert.equal(received[0].fromPodId, 'pod-C')
  })

  it('disconnect closes WS and sets connected to false', async () => {
    await client.connect()
    assert.equal(client.connected, true)
    client.disconnect()
    assert.equal(client.connected, false)
    assert.equal(lastWs.readyState, 3) // CLOSED
  })

  it('send throws when not connected', () => {
    assert.throws(
      () => client.send('pod-x', 'test', {}),
      /not connected/,
    )
  })

  it('on/off manages event listeners', async () => {
    await client.connect()
    const calls = []
    const cb = (data) => calls.push(data)
    client.on('custom', cb)
    lastWs._receive({ type: 'custom', from: 'pod-X', value: 1 })
    assert.equal(calls.length, 1)

    client.off('custom', cb)
    lastWs._receive({ type: 'custom', from: 'pod-X', value: 2 })
    assert.equal(calls.length, 1) // no new call
  })

  it('connect throws when no URL configured', async () => {
    const noUrl = new SignalingClient({
      localPodId: 'pod-local',
      _WebSocket: MockWebSocket,
    })
    await assert.rejects(() => noUrl.connect(), /No signaling URL/)
  })
})

// ---------------------------------------------------------------------------
// DirectInputHandshake
// ---------------------------------------------------------------------------

describe('DirectInputHandshake', () => {
  const fakePublicKey = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
  let handshake

  beforeEach(() => {
    handshake = new DirectInputHandshake({
      localPodId: 'pod-local',
      getPublicKeyBytes: async () => fakePublicKey,
      signalingUrl: 'wss://signal.example.com',
      iceServers: [{ urls: 'stun:stun.example.com' }],
    })
  })

  it('throws if localPodId is missing', () => {
    assert.throws(
      () => new DirectInputHandshake({ getPublicKeyBytes: async () => new Uint8Array(0) }),
      /localPodId is required/,
    )
  })

  it('throws if getPublicKeyBytes is missing', () => {
    assert.throws(
      () => new DirectInputHandshake({ localPodId: 'pod-1' }),
      /getPublicKeyBytes is required/,
    )
  })

  it('generateToken produces valid structure', async () => {
    const token = await handshake.generateToken()
    assert.equal(token.podId, 'pod-local')
    assert.equal(typeof token.publicKey, 'string')
    assert.ok(token.publicKey.length > 0)
    assert.equal(typeof token.nonce, 'string')
    assert.ok(token.nonce.length > 0)
    assert.equal(typeof token.timestamp, 'number')
    assert.ok(token.timestamp <= Date.now())
    assert.equal(token.signalingUrl, 'wss://signal.example.com')
    assert.deepEqual(token.iceServers, [{ urls: 'stun:stun.example.com' }])
  })

  it('generateToken public key round-trips through base64url', async () => {
    const token = await handshake.generateToken()
    const decoded = fromBase64Url(token.publicKey)
    assert.deepEqual(decoded, fakePublicKey)
  })

  it('encodeToken / decodeToken round-trip', async () => {
    const token = await handshake.generateToken()
    const encoded = handshake.encodeToken(token)
    assert.equal(typeof encoded, 'string')
    assert.ok(encoded.length > 0)
    const decoded = DirectInputHandshake.decodeToken(encoded)
    assert.deepEqual(decoded, token)
  })

  it('validateToken accepts a valid token', async () => {
    const token = await handshake.generateToken()
    // Change podId so it's not self
    token.podId = 'pod-remote'
    const result = handshake.validateToken(token)
    assert.deepEqual(result, { valid: true })
  })

  it('validateToken rejects missing podId', () => {
    const result = handshake.validateToken({ publicKey: 'abc', nonce: 'def', timestamp: Date.now() })
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('podId'))
  })

  it('validateToken rejects missing publicKey', () => {
    const result = handshake.validateToken({ podId: 'pod-remote', nonce: 'def', timestamp: Date.now() })
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('publicKey'))
  })

  it('validateToken rejects expired token', () => {
    const token = {
      podId: 'pod-remote',
      publicKey: 'abc',
      nonce: 'def',
      timestamp: Date.now() - TOKEN_TTL_MS - 1000,
    }
    const result = handshake.validateToken(token)
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('expired'))
  })

  it('validateToken rejects missing timestamp', () => {
    const result = handshake.validateToken({ podId: 'pod-remote', publicKey: 'abc', nonce: 'def' })
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('timestamp'))
  })

  it('validateToken rejects future timestamp', () => {
    const token = {
      podId: 'pod-remote',
      publicKey: 'abc',
      nonce: 'def',
      timestamp: Date.now() + 60_000, // 60s in future, beyond 30s tolerance
    }
    const result = handshake.validateToken(token)
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('future'))
  })

  it('validateToken accepts slight clock skew', () => {
    const token = {
      podId: 'pod-remote',
      publicKey: 'abc',
      nonce: 'def',
      timestamp: Date.now() + 10_000, // 10s in future, within 30s tolerance
    }
    const result = handshake.validateToken(token)
    assert.deepEqual(result, { valid: true })
  })

  it('validateToken rejects self-connection', async () => {
    const token = await handshake.generateToken()
    // token.podId === 'pod-local' which matches localPodId
    const result = handshake.validateToken(token)
    assert.equal(result.valid, false)
    assert.ok(result.error.includes('self'))
  })

  it('generateQRDataURL returns encoded string', async () => {
    const token = await handshake.generateToken()
    const qr = await handshake.generateQRDataURL(token)
    assert.equal(typeof qr, 'string')
    assert.ok(qr.length > 0)
    // Should be the same as encodeToken
    const expected = handshake.encodeToken(token)
    assert.equal(qr, expected)
  })

  it('omits signalingUrl and iceServers when not provided', async () => {
    const minimal = new DirectInputHandshake({
      localPodId: 'pod-minimal',
      getPublicKeyBytes: async () => new Uint8Array([9, 10]),
    })
    const token = await minimal.generateToken()
    assert.equal(token.signalingUrl, undefined)
    assert.equal(token.iceServers, undefined)
  })
})

// ---------------------------------------------------------------------------
// HandshakeCoordinator
// ---------------------------------------------------------------------------

describe('HandshakeCoordinator', () => {
  it('throws if localPodId is missing', () => {
    assert.throws(
      () => new HandshakeCoordinator({}),
      /localPodId is required/,
    )
  })

  it('constructs with minimal args', () => {
    const coord = new HandshakeCoordinator({ localPodId: 'pod-local' })
    assert.equal(coord.connected, false)
  })

  it('connected delegates to signaling client', async () => {
    let lastWs
    const WsCtor = function (url) {
      const ws = new MockWebSocket(url)
      lastWs = ws
      return ws
    }
    const signaler = new SignalingClient({
      url: 'wss://signal.test',
      localPodId: 'pod-local',
      _WebSocket: WsCtor,
    })
    const coord = new HandshakeCoordinator({
      localPodId: 'pod-local',
      signalingClient: signaler,
    })
    assert.equal(coord.connected, false)
    await signaler.connect()
    assert.equal(coord.connected, true)
    signaler.disconnect()
    assert.equal(coord.connected, false)
  })

  it('connectToPeer with mock transport factory', async () => {
    let lastWs
    const WsCtor = function (url) {
      const ws = new MockWebSocket(url)
      lastWs = ws
      return ws
    }
    const signaler = new SignalingClient({
      url: 'wss://signal.test',
      localPodId: 'pod-local',
      _WebSocket: WsCtor,
    })
    await signaler.connect()

    const mockTransport = { type: 'webrtc', connected: true }
    const factory = createMockTransportFactory({ transport: mockTransport })

    const coord = new HandshakeCoordinator({
      localPodId: 'pod-local',
      signalingClient: signaler,
      transportFactory: factory,
    })

    const result = await coord.connectToPeer('pod-remote')
    assert.equal(result.transport, mockTransport)
    assert.equal(result.sessionInfo.localPodId, 'pod-local')
    assert.equal(result.sessionInfo.remotePodId, 'pod-remote')
    assert.equal(result.sessionInfo.transportType, 'webrtc')
    assert.equal(typeof result.sessionInfo.establishedAt, 'number')
    signaler.disconnect()
  })

  it('acceptConnection with mock transport', async () => {
    let lastWs
    const WsCtor = function (url) {
      const ws = new MockWebSocket(url)
      lastWs = ws
      return ws
    }
    const signaler = new SignalingClient({
      url: 'wss://signal.test',
      localPodId: 'pod-local',
      _WebSocket: WsCtor,
    })
    await signaler.connect()

    let handleOfferCalled = false
    const mockTransport = { type: 'webrtc', connected: true }
    const factory = createMockTransportFactory({
      transport: mockTransport,
      handleOffer: async (offer) => { handleOfferCalled = true },
    })

    const coord = new HandshakeCoordinator({
      localPodId: 'pod-local',
      signalingClient: signaler,
      transportFactory: factory,
    })

    const result = await coord.acceptConnection('pod-remote', { sdp: 'offer-sdp' })
    assert.equal(result.transport.type, 'webrtc')
    assert.equal(result.sessionInfo.remotePodId, 'pod-remote')
    assert.ok(handleOfferCalled)
    signaler.disconnect()
  })

  it('onIncomingConnection callback fires on signaling offer', async () => {
    let lastWs
    const WsCtor = function (url) {
      const ws = new MockWebSocket(url)
      lastWs = ws
      return ws
    }
    const signaler = new SignalingClient({
      url: 'wss://signal.test',
      localPodId: 'pod-local',
      _WebSocket: WsCtor,
    })
    await signaler.connect()

    const coord = new HandshakeCoordinator({
      localPodId: 'pod-local',
      signalingClient: signaler,
    })

    const incoming = []
    coord.onIncomingConnection((data) => incoming.push(data))

    // Simulate an incoming offer via the signaling WebSocket
    lastWs._receive({ type: 'offer', from: 'pod-initiator', offer: { sdp: 'remote-offer' } })

    assert.equal(incoming.length, 1)
    assert.equal(incoming[0].remotePodId, 'pod-initiator')
    assert.deepEqual(incoming[0].offer, { sdp: 'remote-offer' })
    signaler.disconnect()
  })

  it('connectViaToken uses existing signaling client', async () => {
    let lastWs
    const WsCtor = function (url) {
      const ws = new MockWebSocket(url)
      lastWs = ws
      return ws
    }
    const signaler = new SignalingClient({
      url: 'wss://signal.test',
      localPodId: 'pod-local',
      _WebSocket: WsCtor,
    })
    await signaler.connect()

    const mockTransport = { type: 'webrtc', connected: true }
    const factory = createMockTransportFactory({ transport: mockTransport })

    const coord = new HandshakeCoordinator({
      localPodId: 'pod-local',
      signalingClient: signaler,
      transportFactory: factory,
    })

    const token = {
      podId: 'pod-remote',
      publicKey: 'abc123',
      nonce: 'deadbeef',
      timestamp: Date.now(),
      iceServers: [{ urls: 'stun:stun.example.com' }],
    }

    const result = await coord.connectViaToken(token)
    assert.equal(result.transport, mockTransport)
    assert.equal(result.sessionInfo.remotePodId, 'pod-remote')
    assert.equal(result.sessionInfo.viaToken, true)
    assert.equal(result.sessionInfo.transportType, 'webrtc')
    signaler.disconnect()
  })

  it('connectToPeer throws without transport factory', async () => {
    const coord = new HandshakeCoordinator({ localPodId: 'pod-local' })
    await assert.rejects(
      () => coord.connectToPeer('pod-remote'),
      /TransportFactory is required/,
    )
  })

  it('connectToPeer throws without signaling client', () => {
    const factory = createMockTransportFactory()
    const coord = new HandshakeCoordinator({
      localPodId: 'pod-local',
      transportFactory: factory,
    })
    assert.rejects(
      () => coord.connectToPeer('pod-remote'),
      /SignalingClient is required/,
    )
  })

  it('connectViaToken throws without transport factory', async () => {
    const coord = new HandshakeCoordinator({ localPodId: 'pod-local' })
    const token = { podId: 'pod-remote', publicKey: 'x', nonce: 'y', timestamp: Date.now() }
    await assert.rejects(
      () => coord.connectViaToken(token),
      /TransportFactory is required/,
    )
  })

  it('on/off manages event listeners', async () => {
    let lastWs
    const WsCtor = function (url) {
      const ws = new MockWebSocket(url)
      lastWs = ws
      return ws
    }
    const signaler = new SignalingClient({
      url: 'wss://signal.test',
      localPodId: 'pod-local',
      _WebSocket: WsCtor,
    })
    await signaler.connect()

    const mockTransport = { type: 'webrtc', connected: true }
    const factory = createMockTransportFactory({ transport: mockTransport })

    const coord = new HandshakeCoordinator({
      localPodId: 'pod-local',
      signalingClient: signaler,
      transportFactory: factory,
    })

    const events = []
    const cb = (data) => events.push(data)
    coord.on('connected', cb)

    await coord.connectToPeer('pod-remote')
    assert.equal(events.length, 1)
    assert.equal(events[0].remotePodId, 'pod-remote')

    coord.off('connected', cb)
    await coord.connectToPeer('pod-remote-2')
    assert.equal(events.length, 1) // no new event

    signaler.disconnect()
  })
})
