// Two real PeerNodes over a real RTCPeerConnection pair: the wire-envelope
// contract (browsermesh#208), the bulk lane (#198) and broadcast (#193) on an
// actual data channel.
//
// Every other MeshService test passes envelope OBJECTS between in-process
// nodes, which a real RTCDataChannel never does -- it carries strings and
// binary, and coerces anything else to "[object Object]". This drives the
// real thing end to end: PeerNode.sendTo(object) -> transport -> real SCTP
// data channel -> transport -> PeerNode -> ctx.onIncomingData(parsed object).
//
// The transport is `WebRTCTransport` from
// `@johnhenry/browsermesh-transport`'s websocket.mjs: the class that handed
// objects to `RTCDataChannel.send()` unencoded. Same optional
// `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as every other
// real-peer suite here.

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
  describe('wire envelope against real WebRTC peers', () => {
    it('skipped: optional devDependency `node-datachannel` is not installed', () => {})
  })
}

const describeIfReal = ndc ? describe : describe.skip

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

function makeWallet(podId) {
  return {
    async createIdentity(label) { return { podId, label } },
    listIdentities() { return [{ podId }] },
    getDefault() { return { podId } },
    setDefault() {},
    async sign() { return new Uint8Array([1]) },
    toJSON() { return {} },
  }
}

function makeRegistry() {
  const peers = new Map()
  return {
    addPeer(pubKey) { const p = { fingerprint: pubKey, status: 'disconnected' }; peers.set(pubKey, p); return p },
    removePeer(pubKey) { return peers.delete(pubKey) },
    getPeer(pubKey) { return peers.get(pubKey) || null },
    listPeers() { return [...peers.values()] },
    connect(pubKey) { const p = peers.get(pubKey) || this.addPeer(pubKey); p.status = 'connected'; return p },
    disconnect(pubKey) { const p = peers.get(pubKey); if (p) p.status = 'disconnected' },
    disconnectAll() {},
    onPeerConnect() {},
    onPeerDisconnect() {},
    getStats() { return {} },
    get size() { return peers.size },
    toJSON() { return [] },
  }
}

describeIfReal('wire envelope against real WebRTC peers (#208, #198, #193)', () => {
  /** @type {any} */ let PeerNode
  /** @type {any} */ let attachService
  /** @type {any} */ let WebRTCTransport
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let transportA
  /** @type {any} */ let transportB
  /** Labels of the real data channels alice actually sent on, in order. */
  const aliceSentOn = []

  before(async () => {
    Object.assign(globalThis, {
      RTCPeerConnection: ndc.RTCPeerConnection,
      RTCIceCandidate: ndc.RTCIceCandidate,
      RTCSessionDescription: ndc.RTCSessionDescription,
    })
    ;({ PeerNode } = await import('../../src/peer-node.mjs'))
    ;({ attachService } = await import('../../src/mesh-service.mjs'))
    ;({ WebRTCTransport } = await import('@johnhenry/browsermesh-transport'))

    // In-process signaling: each side's signaler hands the other side the
    // wrapped envelope shape a real SignalingClient delivers.
    const handlers = { alice: {}, bob: {} }
    const signalerFor = (me, peer) => ({
      async sendOffer(_to, offer) { queueMicrotask(() => handlers[peer].offer?.({ from: me, type: 'offer', offer }, me)) },
      async sendAnswer(_to, answer) { queueMicrotask(() => handlers[peer].answer?.({ from: me, type: 'answer', answer }, me)) },
      async sendIceCandidate(_to, candidate) { queueMicrotask(() => handlers[peer].ice?.({ from: me, type: 'ice-candidate', candidate }, me)) },
      onOffer(cb) { handlers[me].offer = cb },
      onAnswer(cb) { handlers[me].answer = cb },
      onIceCandidate(cb) { handlers[me].ice = cb },
    })

    // Wrap alice's real data channels so the test can see which one each
    // message really left on.
    class SpyPC extends ndc.RTCPeerConnection {
      createDataChannel(label, opts) {
        const dc = super.createDataChannel(label, opts)
        const send = dc.send.bind(dc)
        dc.send = (data) => { aliceSentOn.push(label); return send(data) }
        return dc
      }
    }

    transportA = new WebRTCTransport({
      localPodId: 'alice', remotePodId: 'bob', signaler: signalerFor('alice', 'bob'),
      config: { iceServers: [] }, _RTCPeerConnection: SpyPC,
    })
    transportB = new WebRTCTransport({
      localPodId: 'bob', remotePodId: 'alice', signaler: signalerFor('bob', 'alice'),
      config: { iceServers: [] },
    })
    // The answerer starts from the offer alice's signaler delivers.
    handlers.bob.offer = (env) => { transportB.handleOffer(env.offer) }

    const connected = Promise.all([
      transportA.connect(),
      new Promise((resolve) => transportB.on('open', resolve)),
    ])
    let timer
    try {
      await Promise.race([
        connected,
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('WebRTC handshake timed out')), 20_000) }),
      ])
    } finally {
      clearTimeout(timer)
    }
    await waitFor(() => transportB.connected, 10_000, "bob's data channel to open")

    // PeerNode wants onMessage(); the websocket.mjs transport exposes on('message').
    const asSession = (t) => ({
      send: (data, opts) => t.send(data, opts),
      onMessage: (cb) => t.on('message', cb),
    })
    alice = new PeerNode({ wallet: makeWallet('alice'), registry: makeRegistry() })
    bob = new PeerNode({ wallet: makeWallet('bob'), registry: makeRegistry() })
    await alice.boot()
    await bob.boot()
    await alice.adoptIncomingSession('bob', asSession(transportA), 'webrtc')
    await bob.adoptIncomingSession('alice', asSession(transportB), 'webrtc')
  })

  after(async () => {
    try { await transportA.close() } catch { /* already closed */ }
    try { await transportB.close() } catch { /* already closed */ }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('PeerNode.sendTo(pk, object) arrives as the same object through ctx.onIncomingData()', async () => {
    const seen = []
    attachService(bob, undefined, {
      name: 'zz',
      attach(_n, ctx) { return ctx.onIncomingData('zz', (from, msg) => seen.push({ from, msg })) },
    })
    await alice.sendTo('bob', { type: 'zz', a: 1, nested: { list: [1, 2, 3] } })
    await waitFor(() => seen.length === 1, 10_000, 'the envelope to arrive over the real data channel')
    assert.deepEqual(seen[0], { from: 'alice', msg: { type: 'zz', a: 1, nested: { list: [1, 2, 3] } } })
  })

  it('a MeshService round trip: request over ctx.sendTo, reply parsed on the other side', async () => {
    let aliceCtx
    const replies = []
    attachService(alice, undefined, {
      name: 'ask',
      attach(_n, ctx) { aliceCtx = ctx; return ctx.onIncomingData('pong', (_f, msg) => replies.push(msg)) },
    })
    attachService(bob, undefined, {
      name: 'answer',
      attach(_n, ctx) {
        return ctx.onIncomingData('ping', (from, msg) => ctx.sendTo(from, 'pong', { n: msg.n + 1 }))
      },
    })
    await aliceCtx.sendTo('bob', 'ping', { n: 41 })
    await waitFor(() => replies.length === 1, 10_000, 'the pong reply')
    assert.deepEqual(replies[0], { type: 'pong', n: 42 })
  })

  it("{ channel: 'bulk' } leaves on the real mesh-bulk data channel and still arrives parsed", async () => {
    const seen = []
    attachService(bob, undefined, {
      name: 'bulk-sink',
      attach(_n, ctx) { return ctx.onIncomingData('chunk', (_f, msg) => seen.push(msg)) },
    })
    aliceSentOn.length = 0
    await alice.sendTo('bob', { type: 'chunk', data: 'AAAA' }, { channel: 'bulk' })
    await alice.sendTo('bob', { type: 'chunk', data: 'BBBB' })
    await waitFor(() => seen.length === 2, 10_000, 'both chunk envelopes')
    assert.deepEqual(aliceSentOn, ['mesh-bulk', 'mesh'], 'first send on the bulk channel, second on the control channel')
    assert.deepEqual(seen.map((m) => m.data).sort(), ['AAAA', 'BBBB'])
  })

  // #221: the raw PeerNode.onIncomingData() subscribers (not ctx.onIncomingData())
  // read `data.type` straight off whatever the transport delivers, which on a
  // real data channel is JSON text. They must parse it first.
  it('MeshSyncBinding (a raw-bus subscriber) merges a document that crossed the real data channel as text (#221)', async () => {
    const { MeshSyncBinding } = await import('../../src/mesh-sync.mjs')
    const { MeshSyncEngine } = await import('@johnhenry/browsermesh-sync')
    const engineA = new MeshSyncEngine({ nodeId: 'alice' })
    const engineB = new MeshSyncEngine({ nodeId: 'bob' })
    const bindingA = new MeshSyncBinding({ node: alice, engine: engineA, envelopeType: 'rp-sync' })
    const bindingB = new MeshSyncBinding({ node: bob, engine: engineB, envelopeType: 'rp-sync' })
    try {
      engineA.create('notes', 'lww-map')
      engineA.update('notes', (m) => m.set('title', 'over a real data channel', 1, 'alice'))
      await bindingA.syncDocWithPeer('bob', 'notes')
      await waitFor(() => engineB.get('notes') && engineB.getState('notes')?.title === 'over a real data channel', 10_000, 'bob to merge the document')
    } finally {
      bindingA.detach()
      bindingB.detach()
    }
  })

  it('MeshRelayHost + MeshRelayBackend (raw-bus subscribers) relay bytes over the real data channel (#221)', async () => {
    const { MeshRelayHost } = await import('../../src/mesh-relay-host.mjs')
    const { createMeshRelayBackend } = await import('../../src/mesh-relay-backend.mjs')
    const { PeerRegistry } = await import('../../src/peer-registry.mjs')
    const { MeshPeerManager, TrustGraph, MeshACL } = await import('@johnhenry/browsermesh-core')
    const { VirtualNetwork } = await import('@johnhenry/browsermesh-netway')

    const network = new VirtualNetwork()
    const listener = await network.listen('mem://localhost:9200')
    ;(async () => {
      for (;;) {
        const sock = await listener.accept()
        if (!sock) return
        ;(async () => {
          try { for (;;) { const c = await sock.read(); if (c === null) return; await sock.write(c) } } catch { /* closed */ }
        })()
      }
    })()
    const registry = new PeerRegistry({
      localPodId: 'alice', peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: 'alice' }),
    })
    registry.grantCapabilities('bob', ['mesh-relay:echo:connect'])
    const host = new MeshRelayHost({ node: alice, network, registry, envelopeType: 'rp-relay' })
    host.exposeService('echo', 'mem://localhost:9200')
    const backend = createMeshRelayBackend({ node: bob, relayPeerPubKey: 'alice', envelopeType: 'rp-relay', connectTimeoutMs: 10_000 })
    try {
      const socket = await backend.connect('echo')
      await socket.write(new TextEncoder().encode('relayed over real SCTP'))
      const echoed = await socket.read()
      assert.equal(new TextDecoder().decode(echoed), 'relayed over real SCTP')
      await socket.close()
    } finally {
      await backend.close()
      await host.detach()
      await network.close()
    }
  })

  it('broadcast() reaches the real peer', async () => {
    const seen = []
    attachService(bob, undefined, {
      name: 'bcast-sink',
      attach(_n, ctx) { return ctx.onIncomingData('bcast', (_f, msg) => seen.push(msg)) },
    })
    const res = await alice.broadcast({ type: 'bcast', hello: 'all' })
    assert.deepEqual(res, { sent: ['bob'], failed: [] })
    await waitFor(() => seen.length === 1, 10_000, 'the broadcast envelope')
    assert.deepEqual(seen[0], { type: 'bcast', hello: 'all' })
  })
})
