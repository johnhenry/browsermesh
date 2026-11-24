// Two real mesh nodes (real identities, a real WebRTC data channel between
// them, loopback host candidates only) and wsh's remote-object layer over a
// protocol channel on it: values, events, a handle, a callback, and a
// revocation that ends the session. Bob hosts, alice consumes; the identity the
// host judges is the pod id the data channel is bound to.
//
// Same optional `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as
// every other real-peer suite in this repository.

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
  describe('objects over a mesh channel against real WebRTC peers', () => {
    it('skipped: optional devDependency `node-datachannel` is not installed', () => {})
  })
}

const describeIfReal = ndc ? describe : describe.skip

/** Poll until `fn()` is truthy; the deadline only ends a hang, no assertion depends on it. */
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

function createSharedSignalingBus() { return new Set() }
function createBusTransport(sharedBus) {
  let handler = null
  const receiver = (msg) => { if (handler) handler(msg) }
  sharedBus.add(receiver)
  return {
    send(msg) { for (const fn of sharedBus) if (fn !== receiver) fn(msg) },
    onMessage(cb) { handler = cb },
  }
}

class Cart {
  constructor() { this.items = [1, 2, 3] }
  add(n) { this.items.push(n); return this.items.length }
}

describeIfReal('objects over a mesh channel on a real WebRTC data channel', () => {
  /** @type {any} */ let wsh
  /** @type {any} */ let apps
  /** @type {any} */ let objectsPkg
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let aliceSvc
  /** @type {any} */ let bobSvc
  /** @type {any} */ let hosted

  const listeners = new Set()
  const stubs = new Set()
  const app = {
    title: 'inbox',
    counter: { value: 3, inc(n = 1) { app.counter.value += n; return app.counter.value } },
    bus: { on(type, fn) { listeners.add(fn) }, off(type, fn) { listeners.delete(fn) } },
    cart: new Cart(),
    subscribe(fn) { stubs.add(fn); return stubs.size },
  }
  const allow = {
    get: ['app.title', 'app.counter.**', 'app.cart', 'app.cart.items.length'],
    call: ['app.counter.inc', 'app.cart.add', 'app.subscribe(callback)'],
    on: ['app.bus@ping'],
  }

  before(async () => {
    Object.assign(globalThis, {
      RTCPeerConnection: ndc.RTCPeerConnection,
      RTCIceCandidate: ndc.RTCIceCandidate,
      RTCSessionDescription: ndc.RTCSessionDescription,
    })
    wsh = await import('@johnhenry/wsh/objects')
    apps = await import('@johnhenry/browsermesh-apps')
    objectsPkg = await import('../../src/index.mjs')
    const { createMeshNode } = apps
    const { ManualStrategy, DiscoveryRecord } = await import('@johnhenry/browsermesh-discovery')

    const bus = createSharedSignalingBus()
    const discoveryA = new ManualStrategy()
    const discoveryB = new ManualStrategy()
    alice = await createMeshNode({ label: 'alice', discoveryStrategies: [discoveryA], signalingTransport: createBusTransport(bus), iceServers: [] })
    bob = await createMeshNode({ label: 'bob', discoveryStrategies: [discoveryB], signalingTransport: createBusTransport(bus), iceServers: [] })
    discoveryA.addPeer(new DiscoveryRecord({ podId: bob.podId, transport: 'webrtc', label: 'bob' }))
    discoveryB.addPeer(new DiscoveryRecord({ podId: alice.podId, transport: 'webrtc', label: 'alice' }))
    await alice.discover()
    await bob.discover()
    const WEBRTC_TIMEOUT_MS = 30_000
    await alice.connectToPeer(bob.podId, { webrtc: bob.podId }, { answerTimeoutMs: WEBRTC_TIMEOUT_MS, openTimeoutMs: WEBRTC_TIMEOUT_MS })
    await waitFor(() => bob.meshManager.getConnection(alice.podId)?.isOpen, WEBRTC_TIMEOUT_MS, "bob's side of the data channel to open")

    aliceSvc = apps.attachService(alice, undefined, apps.createMeshProtocolService())
    bobSvc = apps.attachService(bob, undefined, apps.createMeshProtocolService())
    hosted = objectsPkg.exposeObjectsOnMesh(bobSvc, {
      roots: { app },
      allow,
      handles: { app: {} },
      watch: bob.registry.onAccessChange.bind(bob.registry),
    })
  })

  after(() => {
    try { hosted?.stop() } catch { /* already stopped */ }
    try { aliceSvc?.teardown() } catch { /* already gone */ }
    try { bobSvc?.teardown() } catch { /* already gone */ }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('a peer with no grant is refused; with grants it reads, calls, holds a handle, subscribes and passes a callback', async () => {
    await assert.rejects(objectsPkg.openObjectsOnMesh(aliceSvc, bob.podId), { code: apps.ChannelErrorCode.UNAUTHORIZED })

    bob.registry.grantCapabilities(alice.podId, [apps.protocolScope('objects'), 'objects:app:get', 'objects:app:call', 'objects:app:on'])
    const { roots, channel } = await objectsPkg.openObjectsOnMesh(aliceSvc, bob.podId)
    assert.equal(channel.peer, bob.podId)

    assert.equal(await roots.app.title, 'inbox')
    assert.equal(await roots.app.counter.inc(4), 7)

    // A handle, judged by the path that produced it.
    const cart = await roots.app.cart
    assert.equal(await wsh.use(cart).items.length, 3)
    assert.equal(await wsh.use(cart).add(9), 4)
    await wsh.release(cart)

    // An event.
    const seen = []
    await wsh.on(roots.app.bus, 'ping', (data) => seen.push(data.args[0]))
    for (const fn of [...listeners]) fn({ n: 1 })
    await waitFor(() => seen.length === 1, 15_000, 'the event to cross the data channel')
    assert.deepEqual(seen, [{ n: 1 }])

    // A one-way callback.
    const got = []
    await roots.app.subscribe((...args) => got.push(args))
    for (const stub of stubs) stub('hello', 2)
    await waitFor(() => got.length === 1, 15_000, 'the callback to cross the data channel')
    assert.deepEqual(got, [['hello', 2]])
  })

  it('revoking the grant of a subscription ends the session at once and detaches the host\'s listener', async () => {
    assert.equal(listeners.size, 1, 'the earlier test left its subscription open')
    bob.registry.revokeCapabilities(alice.podId, ['objects:app:on'])
    await waitFor(() => hosted.sessions() === 0, 15_000, 'the host to end the session')
    assert.equal(listeners.size, 0)
    assert.equal(hosted.stats().revoked, 1)
  })
})
