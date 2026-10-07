// The hosted-pods control surface (issue #185) over a real RTCPeerConnection
// pair: createPodHostService() on one PeerNode, createPodHostClient() on the
// other.
//
// Every in-process pod-host test passes envelope OBJECTS between nodes, which
// a real RTCDataChannel never does (browsermesh#208): the request and the
// response both cross the wire as JSON text and must be parsed on the way in,
// on the host (ctx.onIncomingData) AND on the client (a raw
// PeerNode.onIncomingData subscriber). Same optional `node-datachannel` guard
// and `REQUIRE_REAL_PEER` hard-fail as every other real-peer suite here.

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
  describe('pod host over real WebRTC peers', () => {
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

let access = () => ({ allowed: true })

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
    // The pod host gates every verb through registry.checkAccess(pubKey, resource, verb).
    checkAccess(pubKey, resource, verb) { return access(pubKey, resource, verb) },
    getStats() { return {} },
    get size() { return peers.size },
    toJSON() { return [] },
  }
}

describeIfReal('pod host over real WebRTC peers (#185, #208)', () => {
  /** @type {any} */ let PeerNode
  /** @type {any} */ let attachService
  /** @type {any} */ let WebRTCTransportClass
  /** @type {any} */ let createPodHostService
  /** @type {any} */ let createPodHostClient
  /** @type {any} */ let InMemoryPodHostDriver
  /** @type {any} */ let POD_HOST_ERROR
  /** @type {any} */ let POD_LANE
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let transportA
  /** @type {any} */ let transportB
  /** @type {any} */ let client

  before(async () => {
    Object.assign(globalThis, {
      RTCPeerConnection: ndc.RTCPeerConnection,
      RTCIceCandidate: ndc.RTCIceCandidate,
      RTCSessionDescription: ndc.RTCSessionDescription,
    })
    ;({ PeerNode, attachService, createPodHostService, createPodHostClient } = await import('../../src/index.mjs'))
    ;({ InMemoryPodHostDriver, POD_HOST_ERROR, POD_LANE } = await import('@johnhenry/browsermesh-pod'))
    const { WebRTCTransport } = await import('@johnhenry/browsermesh-transport')
    WebRTCTransportClass = WebRTCTransport

    const handlers = { alice: {}, bob: {} }
    const signalerFor = (me, peer) => ({
      async sendOffer(_to, offer) { queueMicrotask(() => handlers[peer].offer?.({ from: me, type: 'offer', offer }, me)) },
      async sendAnswer(_to, answer) { queueMicrotask(() => handlers[peer].answer?.({ from: me, type: 'answer', answer }, me)) },
      async sendIceCandidate(_to, candidate) { queueMicrotask(() => handlers[peer].ice?.({ from: me, type: 'ice-candidate', candidate }, me)) },
      onOffer(cb) { handlers[me].offer = cb },
      onAnswer(cb) { handlers[me].answer = cb },
      onIceCandidate(cb) { handlers[me].ice = cb },
    })
    transportA = new WebRTCTransportClass({ localPodId: 'alice', remotePodId: 'bob', signaler: signalerFor('alice', 'bob'), config: { iceServers: [] } })
    transportB = new WebRTCTransportClass({ localPodId: 'bob', remotePodId: 'alice', signaler: signalerFor('bob', 'alice'), config: { iceServers: [] } })
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

    attachService(alice, undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.NODE }),
      hostLabel: 'alice-real-peer',
    }))
    client = createPodHostClient({ peerNode: bob, timeoutMs: 10_000 })
  })

  after(async () => {
    access = () => ({ allowed: true })
    try { client?.close?.() } catch { /* already closed */ }
    try { await transportA.close() } catch { /* already closed */ }
    try { await transportB.close() } catch { /* already closed */ }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('describe, spawn, status and exec round-trip over the real data channel', async () => {
    const description = await client.describe('alice')
    assert.equal(description.lane, POD_LANE.NODE)

    const spawned = await client.spawn('alice', {
      name: 'rp-1', lane: POD_LANE.NODE, run: { kind: 'command', ref: '/bin/echo' },
    })
    assert.equal(spawned.name, 'rp-1')
    assert.equal(spawned.state, 'registered')

    const status = await client.status('alice', 'rp-1')
    assert.equal(status.name, 'rp-1')

    const result = await client.exec('alice', 'rp-1', ['echo', 'hi'])
    assert.equal(result.code, 0)
  })

  it('lifecycle events stream back to the client as parsed objects', async () => {
    const seen = []
    const off = client.onEvent((_host, event) => { if (event.kind === 'lifecycle') seen.push(`${event.data.from}>${event.data.to}`) })
    await client.spawn('alice', { name: 'rp-2', lane: POD_LANE.NODE, run: { kind: 'command', ref: '/bin/true' } })
    await waitFor(() => seen.includes('booting>registered'), 10_000, 'the lifecycle events from the host')
    off?.()
    assert.ok(seen.includes('cold>booting'), `events: ${seen.join(', ')}`)
  })

  it('a denied verb comes back as EACCES, and list/drain still work once allowed again', async () => {
    access = () => ({ allowed: false, reason: 'no grant' })
    await assert.rejects(
      client.spawn('alice', { name: 'rp-3', lane: POD_LANE.NODE, run: { kind: 'command', ref: '/bin/true' } }),
      (err) => err.code === POD_HOST_ERROR.EACCES,
    )
    access = () => ({ allowed: true })
    const names = (await client.list('alice')).map((p) => p.name).sort()
    assert.deepEqual(names, ['rp-1', 'rp-2'])
    assert.equal((await client.drain('alice', 'rp-1')).state, 'gone')
  })
})
