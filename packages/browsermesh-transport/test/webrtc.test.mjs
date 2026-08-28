// Run with: node --import ./test/_setup-globals.mjs --test test/webrtc.test.mjs
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// Mock RTCPeerConnection & RTCDataChannel before importing the module
// ---------------------------------------------------------------------------

class MockRTCDataChannel {
  readyState = 'open'
  onopen = null
  onmessage = null
  onclose = null
  onerror = null
  _lastSent = null

  send(data) {
    this._lastSent = data
  }

  close() {
    this.readyState = 'closed'
    if (this.onclose) this.onclose()
  }
}

/** Tracks the most recently constructed mock PC/DC so tests can drive
 * their event callbacks without the real class exposing private fields. */
let _lastMockPC = null
let _lastMockDC = null

class MockRTCPeerConnection {
  #localDesc = null
  #remoteDesc = null
  onicecandidate = null
  ondatachannel = null
  onconnectionstatechange = null
  connectionState = 'new'
  _lastCandidate = null

  constructor(config) {
    this.config = config
    _lastMockPC = this
  }

  createDataChannel(label, opts) {
    const dc = new MockRTCDataChannel()
    dc.label = label
    _lastMockDC = dc
    return dc
  }

  lastCreateOfferOpts = null

  async createOffer(opts) {
    this.lastCreateOfferOpts = opts || null
    return { type: 'offer', sdp: opts?.iceRestart ? 'mock-restart-offer-sdp' : 'mock-offer-sdp' }
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'mock-answer-sdp' }
  }

  async setLocalDescription(desc) {
    this.#localDesc = desc
  }

  async setRemoteDescription(desc) {
    this.#remoteDesc = desc
  }

  addIceCandidate(c) {
    this._lastCandidate = c
  }

  /** Test hook: set to an array of stat objects to control getStats() output. */
  _mockStatsEntries = [
    { type: 'data-channel', bytesSent: 1000, bytesReceived: 2000, messagesSent: 10, messagesReceived: 20 },
    { type: 'candidate-pair', nominated: true, currentRoundTripTime: 0.05, requestsSent: 10, responsesReceived: 9 },
  ]

  async getStats() {
    return new Map(this._mockStatsEntries.map((entry, i) => [`stat-${i}`, entry]))
  }

  close() {}
}

globalThis.RTCPeerConnection = MockRTCPeerConnection

// ---------------------------------------------------------------------------
// Import module under test (after globals are set up)
// ---------------------------------------------------------------------------

import {
  supportsWebRTC,
  WebRTCPeerConnection,
  WebRTCMeshManager,
  WebRTCTransportAdapter,
  WebRTCAdapterFactory,
  mergeIceServers,
} from '../src/webrtc.mjs'

// ── supportsWebRTC ─────────────────────────────────────────────────────

describe('supportsWebRTC', () => {
  it('returns true when RTCPeerConnection is defined', () => {
    assert.equal(supportsWebRTC(), true)
  })
})

// ── WebRTCPeerConnection ───────────────────────────────────────────────

describe('WebRTCPeerConnection', () => {
  it('constructor requires localPodId', () => {
    assert.throws(
      () => new WebRTCPeerConnection({ remotePodId: 'b' }),
      /localPodId is required/,
    )
  })

  it('constructor requires remotePodId', () => {
    assert.throws(
      () => new WebRTCPeerConnection({ localPodId: 'a' }),
      /remotePodId is required/,
    )
  })

  it('starts in new state', () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    assert.equal(conn.state, 'new')
  })

  it('exposes localPodId and remotePodId', () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    assert.equal(conn.localPodId, 'a')
    assert.equal(conn.remotePodId, 'b')
  })

  it('stats starts at zero', () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    assert.equal(conn.stats.bytesSent, 0)
    assert.equal(conn.stats.bytesReceived, 0)
  })

  it('stats returns a copy', () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    const s = conn.stats
    s.bytesSent = 9999
    assert.equal(conn.stats.bytesSent, 0)
  })

  it('createOffer returns offer with sdp', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    const offer = await conn.createOffer()
    assert.equal(offer.type, 'offer')
    assert.equal(typeof offer.sdp, 'string')
    assert.ok(offer.sdp.length > 0)
    assert.equal(conn.state, 'connecting')
  })

  it('handleOffer returns answer with sdp', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    const answer = await conn.handleOffer({ type: 'offer', sdp: 'remote-offer-sdp' })
    assert.equal(answer.type, 'answer')
    assert.equal(typeof answer.sdp, 'string')
    assert.ok(answer.sdp.length > 0)
    assert.equal(conn.state, 'connecting')
  })

  it('handleOffer rejects missing sdp', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await assert.rejects(
      () => conn.handleOffer({}),
      /Invalid offer: missing sdp/,
    )
  })

  it('handleAnswer throws without prior createOffer', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await assert.rejects(
      () => conn.handleAnswer({ type: 'answer', sdp: 'x' }),
      /No peer connection/,
    )
  })

  it('handleAnswer applies remote description after createOffer', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await conn.createOffer()
    // should not throw
    await conn.handleAnswer({ type: 'answer', sdp: 'remote-answer-sdp' })
  })

  it('addIceCandidate throws without peer connection', () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    assert.throws(
      () => conn.addIceCandidate({ candidate: 'c' }),
      /No peer connection/,
    )
  })

  it('send throws when no data channel exists', () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    assert.throws(
      () => conn.send('hello'),
      /No data channel/,
    )
  })

  it('send works after createOffer sets up data channel', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await conn.createOffer()
    // DataChannel is created with readyState 'open' (mock)
    conn.send('test-message')
    assert.equal(conn.stats.bytesSent, 'test-message'.length)
  })

  it('send JSON-serializes objects', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await conn.createOffer()
    conn.send({ type: 'ping' })
    assert.ok(conn.stats.bytesSent > 0)
  })

  it('close sets state to closed', () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    conn.close()
    assert.equal(conn.state, 'closed')
  })

  it('close is idempotent', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await conn.createOffer()
    conn.close()
    conn.close() // should not throw
    assert.equal(conn.state, 'closed')
  })

  it('close fires close callbacks', () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    let fired = false
    conn.onClose(() => { fired = true })
    conn.close()
    assert.equal(fired, true)
  })

  it('createOffer throws after close', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    conn.close()
    await assert.rejects(
      () => conn.createOffer(),
      /Connection is closed/,
    )
  })

  it('onIceCandidate fires when ICE candidate is gathered', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    const candidates = []
    conn.onIceCandidate((c) => candidates.push(c))
    await conn.createOffer()
    // No real ICE gathering in mock, just verifying registration works
    assert.equal(candidates.length, 0)
  })

  it('onLog callback is invoked', async () => {
    const logs = []
    const conn = new WebRTCPeerConnection({
      localPodId: 'a',
      remotePodId: 'b',
      onLog: (msg) => logs.push(msg),
    })
    await conn.createOffer()
    assert.ok(logs.length > 0)
    assert.ok(logs.some(l => l.includes('offer')))
  })
})

// ── WebRTCMeshManager ──────────────────────────────────────────────────

describe('WebRTCMeshManager', () => {
  it('constructor requires localPodId', () => {
    assert.throws(
      () => new WebRTCMeshManager({}),
      /localPodId is required/,
    )
  })

  it('exposes localPodId', () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    assert.equal(mgr.localPodId, 'node-1')
  })

  it('starts with zero connections', () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    assert.equal(mgr.connectionCount, 0)
    assert.deepEqual(mgr.listConnections(), [])
  })

  it('connectToPeer creates a new connection', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    const conn = await mgr.connectToPeer('node-2')
    assert.ok(conn instanceof WebRTCPeerConnection)
    assert.equal(conn.remotePodId, 'node-2')
    assert.equal(mgr.connectionCount, 1)
  })

  it('connectToPeer returns same connection for duplicate remotePodId', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    const conn1 = await mgr.connectToPeer('node-2')
    const conn2 = await mgr.connectToPeer('node-2')
    assert.equal(conn1, conn2)
    assert.equal(mgr.connectionCount, 1)
  })

  it('getConnection returns null for unknown pod', () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    assert.equal(mgr.getConnection('unknown'), null)
  })

  it('getConnection returns the connection for a known pod', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    const conn = await mgr.connectToPeer('node-2')
    assert.equal(mgr.getConnection('node-2'), conn)
  })

  it('hasConnection returns false then true', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    assert.equal(mgr.hasConnection('node-2'), false)
    await mgr.connectToPeer('node-2')
    assert.equal(mgr.hasConnection('node-2'), true)
  })

  it('listConnections returns connection info', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    await mgr.connectToPeer('node-2')
    await mgr.connectToPeer('node-3')
    const list = mgr.listConnections()
    assert.equal(list.length, 2)
    const ids = list.map(c => c.remotePodId).sort()
    assert.deepEqual(ids, ['node-2', 'node-3'])
    assert.ok(list.every(c => typeof c.state === 'string'))
  })

  it('closePeer removes a specific connection', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    await mgr.connectToPeer('node-2')
    await mgr.connectToPeer('node-3')
    assert.equal(mgr.closePeer('node-2'), true)
    assert.equal(mgr.connectionCount, 1)
    assert.equal(mgr.getConnection('node-2'), null)
  })

  it('closePeer returns false for unknown pod', () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    assert.equal(mgr.closePeer('unknown'), false)
  })

  it('closeAll clears all connections', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    await mgr.connectToPeer('node-2')
    await mgr.connectToPeer('node-3')
    await mgr.connectToPeer('node-4')
    mgr.closeAll()
    assert.equal(mgr.connectionCount, 0)
    assert.deepEqual(mgr.listConnections(), [])
  })
})

// ── mergeIceServers ──────────────────────────────────────────────────

describe('mergeIceServers', () => {
  it('appends valid user servers to the defaults', () => {
    const merged = mergeIceServers(
      [{ urls: 'turn:relay.example.com', username: 'u', credential: 'p' }],
      [{ urls: 'stun:stun.example.com' }],
    )
    assert.deepEqual(merged, [
      { urls: 'stun:stun.example.com' },
      { urls: 'turn:relay.example.com', username: 'u', credential: 'p' },
    ])
  })

  it('filters out malformed entries silently', () => {
    const merged = mergeIceServers([
      { urls: 'turn:ok.example.com' },
      { username: 'no-urls-field' },
      null,
      'not-an-object',
      { urls: '' },
    ], [])
    assert.deepEqual(merged, [{ urls: 'turn:ok.example.com' }])
  })

  it('returns just the defaults when no user servers are given', () => {
    assert.deepEqual(mergeIceServers(undefined, [{ urls: 'stun:x' }]), [{ urls: 'stun:x' }])
    assert.deepEqual(mergeIceServers(null, [{ urls: 'stun:x' }]), [{ urls: 'stun:x' }])
  })
})

// ── WebRTCPeerConnection.reconnect / onStateChange ─────────────────────

describe('WebRTCPeerConnection reconnect', () => {
  it('reconnect() requests an ICE restart and returns a fresh offer', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await conn.createOffer()
    const offer = await conn.reconnect()
    assert.equal(offer.type, 'offer')
    assert.equal(offer.sdp, 'mock-restart-offer-sdp')
    assert.equal(conn.state, 'connecting')
  })

  it('reconnect() throws when no underlying connection exists yet', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await assert.rejects(() => conn.reconnect(), /call createOffer/)
  })

  it('reconnect() throws on a closed connection', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await conn.createOffer()
    conn.close()
    await assert.rejects(() => conn.reconnect(), /closed/)
  })

  it('onStateChange fires connecting, then connected on data-channel open, then closed', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    const transitions = []
    conn.onStateChange((s) => transitions.push(s))

    await conn.createOffer()
    assert.deepEqual(transitions, ['connecting'])

    _lastMockDC.onopen() // simulate the data channel opening
    assert.deepEqual(transitions, ['connecting', 'connected'])

    conn.close()
    assert.deepEqual(transitions, ['connecting', 'connected', 'closed'])
  })

  it('onStateChange does not fire duplicate entries for a repeated state', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    const transitions = []
    conn.onStateChange((s) => transitions.push(s))
    await conn.createOffer()
    conn.close()
    conn.close() // second call is a no-op guarded before #setState — no duplicate 'closed'
    assert.deepEqual(transitions, ['connecting', 'closed'])
  })
})

// ── getConnectionStats / getAllConnectionStats (mesh health metrics) ──

describe('WebRTCPeerConnection.getConnectionStats', () => {
  it('throws when there is no underlying connection yet', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await assert.rejects(() => conn.getConnectionStats(), /no peer connection/)
  })

  it('aggregates data-channel byte/message counters from getStats()', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await conn.createOffer()
    const stats = await conn.getConnectionStats()
    assert.equal(stats.remotePodId, 'b')
    assert.equal(stats.state, 'connecting')
    assert.equal(stats.bytesSent, 1000)
    assert.equal(stats.bytesReceived, 2000)
    assert.equal(stats.messagesSent, 10)
    assert.equal(stats.messagesReceived, 20)
  })

  it('derives roundTripTime from the nominated candidate pair', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await conn.createOffer()
    const stats = await conn.getConnectionStats()
    assert.equal(stats.roundTripTime, 0.05)
  })

  it('derives packetLossRatio from the STUN request/response ratio', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await conn.createOffer()
    const stats = await conn.getConnectionStats()
    assert.ok(Math.abs(stats.packetLossRatio - 0.1) < 1e-9) // 1 - 9/10
  })

  it('reports zero loss and null RTT when no candidate-pair stat is present', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await conn.createOffer()
    _lastMockPC._mockStatsEntries = [
      { type: 'data-channel', bytesSent: 5, bytesReceived: 5, messagesSent: 1, messagesReceived: 1 },
    ]
    const stats = await conn.getConnectionStats()
    assert.equal(stats.roundTripTime, null)
    assert.equal(stats.packetLossRatio, 0)
  })

  it('ignores a non-nominated candidate pair', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    await conn.createOffer()
    _lastMockPC._mockStatsEntries = [
      { type: 'candidate-pair', nominated: false, currentRoundTripTime: 0.9, requestsSent: 100, responsesReceived: 1 },
    ]
    const stats = await conn.getConnectionStats()
    assert.equal(stats.roundTripTime, null)
    assert.equal(stats.packetLossRatio, 0)
  })
})

describe('WebRTCMeshManager.getAllConnectionStats', () => {
  it('returns an empty array with no connections', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    assert.deepEqual(await mgr.getAllConnectionStats(), [])
  })

  it('collects stats for every tracked connection', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    const connA = await mgr.connectToPeer('node-2')
    await connA.createOffer()
    const connB = await mgr.connectToPeer('node-3')
    await connB.createOffer()

    const stats = await mgr.getAllConnectionStats()
    assert.equal(stats.length, 2)
    const podIds = stats.map(s => s.remotePodId).sort()
    assert.deepEqual(podIds, ['node-2', 'node-3'])
  })

  it('caches the result on lastStats', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    assert.deepEqual(mgr.lastStats, [])
    const conn = await mgr.connectToPeer('node-2')
    await conn.createOffer()
    const stats = await mgr.getAllConnectionStats()
    assert.deepEqual(mgr.lastStats, stats)
  })

  it('records an error entry instead of throwing when one connection fails', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    await mgr.connectToPeer('node-2') // never calls createOffer() — getConnectionStats() will throw

    const stats = await mgr.getAllConnectionStats()
    assert.equal(stats.length, 1)
    assert.equal(stats[0].remotePodId, 'node-2')
    assert.match(stats[0].error, /no peer connection/)
  })
})

// ── WebRTCMeshManager reconnect-with-backoff ───────────────────────────

describe('WebRTCMeshManager auto-reconnect', () => {
  it('reconnectPeer() manually triggers an ICE restart and notifies onReconnectOffer', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    const conn = await mgr.connectToPeer('node-2')
    await conn.createOffer()

    const offers = []
    mgr.onReconnectOffer((offer, remotePodId) => offers.push({ offer, remotePodId }))

    const offer = await mgr.reconnectPeer('node-2')
    assert.equal(offer.sdp, 'mock-restart-offer-sdp')
    assert.equal(offers.length, 1)
    assert.equal(offers[0].remotePodId, 'node-2')
  })

  it('reconnectPeer() returns null for an unknown pod', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1' })
    assert.equal(await mgr.reconnectPeer('nope'), null)
  })

  it('auto-schedules a reconnect (with an ICE-restart offer) after a connection error', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1', reconnectBaseDelayMs: 5 })
    const conn = await mgr.connectToPeer('node-2')
    await conn.createOffer()
    const pc = _lastMockPC

    const offers = []
    mgr.onReconnectOffer((offer, remotePodId) => offers.push({ offer, remotePodId }))

    // Simulate a connection failure at the RTCPeerConnection level
    pc.connectionState = 'failed'
    pc.onconnectionstatechange()

    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.ok(offers.length >= 1, 'expected at least one auto-reconnect offer')
    assert.equal(offers[0].remotePodId, 'node-2')
    assert.equal(offers[0].offer.sdp, 'mock-restart-offer-sdp')
  })

  it('gives up after maxReconnectAttempts and logs', async () => {
    const logs = []
    const mgr = new WebRTCMeshManager({
      localPodId: 'node-1', reconnectBaseDelayMs: 2, maxReconnectAttempts: 2,
      onLog: (m) => logs.push(m),
    })
    const conn = await mgr.connectToPeer('node-2')
    await conn.createOffer()
    const pc = _lastMockPC

    // Fire repeated errors faster than backoff can clear, forcing exhaustion
    for (let i = 0; i < 5; i++) {
      pc.connectionState = 'failed'
      pc.onconnectionstatechange()
      await new Promise((resolve) => setTimeout(resolve, 15))
    }

    assert.ok(logs.some(l => l.includes('Giving up reconnecting')))
  })

  it('does not schedule a second reconnect while one is already pending', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1', reconnectBaseDelayMs: 50 })
    const conn = await mgr.connectToPeer('node-2')
    await conn.createOffer()
    const pc = _lastMockPC

    const offers = []
    mgr.onReconnectOffer((offer) => offers.push(offer))

    pc.connectionState = 'failed'
    pc.onconnectionstatechange() // schedules attempt #1
    pc.onconnectionstatechange() // must be a no-op — one is already pending
    pc.onconnectionstatechange()

    await new Promise((resolve) => setTimeout(resolve, 80))
    assert.equal(offers.length, 1)
  })

  it('clears reconnect state when the peer connection closes', async () => {
    const mgr = new WebRTCMeshManager({ localPodId: 'node-1', reconnectBaseDelayMs: 5 })
    const conn = await mgr.connectToPeer('node-2')
    await conn.createOffer()
    const pc = _lastMockPC

    pc.connectionState = 'failed'
    pc.onconnectionstatechange() // schedules a reconnect

    const offers = []
    mgr.onReconnectOffer((offer) => offers.push(offer))
    conn.close() // must cancel the pending timer — no reconnect fires afterward

    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(offers.length, 0)
  })
})

// ── WebRTCAdapterFactory ───────────────────────────────────────────────

describe('WebRTCAdapterFactory', () => {
  it('canCreate returns true for webrtc', () => {
    const factory = new WebRTCAdapterFactory()
    assert.equal(factory.canCreate('webrtc'), true)
  })

  it('canCreate returns false for wsh-ws', () => {
    const factory = new WebRTCAdapterFactory()
    assert.equal(factory.canCreate('wsh-ws'), false)
  })

  it('canCreate returns false for wsh-wt', () => {
    const factory = new WebRTCAdapterFactory()
    assert.equal(factory.canCreate('wsh-wt'), false)
  })

  it('create throws without opts.connection', () => {
    const factory = new WebRTCAdapterFactory()
    assert.throws(
      () => factory.create('node-2', {}),
      /requires opts\.connection/,
    )
  })

  it('create returns a WebRTCTransportAdapter', () => {
    const factory = new WebRTCAdapterFactory()
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    const adapter = factory.create('b', { connection: conn })
    assert.ok(adapter instanceof WebRTCTransportAdapter)
  })
})

// ── WebRTCTransportAdapter ─────────────────────────────────────────────

describe('WebRTCTransportAdapter', () => {
  it('constructor sets type to webrtc', () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    const adapter = new WebRTCTransportAdapter(conn)
    assert.equal(adapter.type, 'webrtc')
  })

  it('constructor throws without connection', () => {
    assert.throws(
      () => new WebRTCTransportAdapter(null),
      /connection is required/,
    )
  })

  it('starts in disconnected state', () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    const adapter = new WebRTCTransportAdapter(conn)
    assert.equal(adapter.state, 'disconnected')
  })

  it('connect transitions to connected state', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    const adapter = new WebRTCTransportAdapter(conn)
    await adapter.connect()
    assert.equal(adapter.state, 'connected')
    assert.equal(adapter.connected, true)
  })

  it('peerConnection exposes the underlying connection', () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    const adapter = new WebRTCTransportAdapter(conn)
    assert.equal(adapter.peerConnection, conn)
  })

  it('close sets state to closed', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    const adapter = new WebRTCTransportAdapter(conn)
    await adapter.connect()
    adapter.close()
    assert.equal(adapter.state, 'closed')
  })

  it('close fires onClose callback', async () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    const adapter = new WebRTCTransportAdapter(conn)
    let closed = false
    adapter.onClose(() => { closed = true })
    adapter.close()
    assert.equal(closed, true)
  })

  it('toJSON returns transport metadata', () => {
    const conn = new WebRTCPeerConnection({ localPodId: 'a', remotePodId: 'b' })
    const adapter = new WebRTCTransportAdapter(conn)
    const json = adapter.toJSON()
    assert.equal(json.type, 'webrtc')
    assert.equal(json.state, 'disconnected')
    assert.equal(json.latency, 0)
  })
})
