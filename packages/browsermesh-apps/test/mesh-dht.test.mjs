/**
 * Tests for mesh-dht.mjs (Phase D, issue #87: wiring dht.mjs's
 * `DhtDiscoveryStrategy` into `createMeshNode()`).
 *
 * Deliberately NOT mocked at the layer that matters: real
 * `DhtDiscoveryStrategy`/`DhtNode` instances (`@johnhenry/browsermesh-discovery`)
 * exchanging real DHT wire messages (PING/STORE/FIND_VALUE) over a shared
 * in-process bus, and real `createMeshNode()` PeerNodes with `enableDht: true`
 * discovering each other's `DiscoveryRecord`s via that DHT -- not stubbed.
 * The only test double is the message bus itself (a `Set` of receiver
 * functions), standing in for a real `BroadcastChannel`/relay, matching
 * `test/real-peer/mesh-bootstrap.test.mjs`'s established convention.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-dht.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createMeshDht, shareTransport } from '../src/mesh-dht.mjs'
import { createMeshNode } from '../src/mesh-bootstrap.mjs'
import { DHT_PING } from '@johnhenry/browsermesh-discovery'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

// ---------------------------------------------------------------------------
// Shared in-process bus -- same shape as test/real-peer/mesh-bootstrap.test.mjs's
// createSharedSignalingBus()/createBusTransport(), standing in for a real
// BroadcastChannel/relay.
// ---------------------------------------------------------------------------

function createSharedBus() {
  return new Set()
}

/** One endpoint on a createSharedBus() bus: `{send(msg), onMessage(cb)}`. */
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

// ---------------------------------------------------------------------------
// shareTransport()
// ---------------------------------------------------------------------------

describe('shareTransport', () => {
  it('supports multiple independent onMessage subscribers on a single-handler raw transport', () => {
    // Mirrors signaling.mjs's createBroadcastChannelSignalingTransport():
    // onMessage(cb) OVERWRITES the single handler rather than adding one.
    let rawHandler = null
    const raw = {
      send() {},
      onMessage(cb) { rawHandler = cb },
    }
    const shared = shareTransport(raw)
    const receivedA = []
    const receivedB = []
    shared.onMessage((m) => receivedA.push(m))
    shared.onMessage((m) => receivedB.push(m))

    rawHandler({ hello: 1 })

    assert.deepEqual(receivedA, [{ hello: 1 }])
    assert.deepEqual(receivedB, [{ hello: 1 }])
  })

  it('send() forwards to the raw transport', () => {
    const sent = []
    const raw = { send: (m) => sent.push(m), onMessage() {} }
    const shared = shareTransport(raw)
    shared.send({ a: 1 })
    assert.deepEqual(sent, [{ a: 1 }])
  })

  it('onMessage() returns an unsubscribe function', () => {
    let rawHandler = null
    const raw = { send() {}, onMessage(cb) { rawHandler = cb } }
    const shared = shareTransport(raw)
    const received = []
    const unsub = shared.onMessage((m) => received.push(m))
    unsub()
    rawHandler({ x: 1 })
    assert.deepEqual(received, [])
  })

  it('only subscribes to the raw transport once, regardless of subscriber count', () => {
    let subscribeCount = 0
    const raw = { send() {}, onMessage() { subscribeCount++ } }
    const shared = shareTransport(raw)
    shared.onMessage(() => {})
    shared.onMessage(() => {})
    shared.onMessage(() => {})
    assert.equal(subscribeCount, 1)
  })
})

// ---------------------------------------------------------------------------
// createMeshDht() -- construction and validation
// ---------------------------------------------------------------------------

describe('createMeshDht', () => {
  it('throws without localPodId', () => {
    assert.throws(
      () => createMeshDht({ transport: { send() {}, onMessage() {} } }),
      /localPodId is required/,
    )
  })

  it('throws without a valid transport', () => {
    assert.throws(() => createMeshDht({ localPodId: 'node-a' }), /transport is required/)
    assert.throws(
      () => createMeshDht({ localPodId: 'node-a', transport: { send() {} } }),
      /transport is required/,
    )
  })

  it('sendFn routes DHT wire messages over the transport with a type/from/to envelope', () => {
    const sent = []
    const transport = { send: (m) => sent.push(m), onMessage() {} }
    const { dhtNode } = createMeshDht({ localPodId: 'node-a', transport })

    dhtNode.ping('node-b')

    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'dht-relay')
    assert.equal(sent[0].from, 'node-a')
    assert.equal(sent[0].to, 'node-b')
    assert.equal(sent[0].payload.type, DHT_PING)
  })

  it('a custom messageType is honoured', () => {
    const sent = []
    const transport = { send: (m) => sent.push(m), onMessage() {} }
    const { dhtNode } = createMeshDht({ localPodId: 'node-a', transport, messageType: 'custom-dht' })
    dhtNode.ping('node-b')
    assert.equal(sent[0].type, 'custom-dht')
  })

  it('incoming messages addressed to this node route into dhtNode.handleMessage', () => {
    let handler = null
    const transport = { send() {}, onMessage: (cb) => { handler = cb } }
    const { dhtNode } = createMeshDht({ localPodId: 'node-a', transport })

    handler({ type: 'dht-relay', from: 'node-b', to: 'node-a', payload: { type: DHT_PING } })

    assert.equal(dhtNode.routingTable.size, 1, 'handleMessage() adds the sender to the routing table')
    assert.ok(dhtNode.routingTable.findClosest('node-b', 1).some((c) => c.podId === 'node-b'))
  })

  it('ignores messages not addressed to this node', () => {
    let handler = null
    const transport = { send() {}, onMessage: (cb) => { handler = cb } }
    const { dhtNode } = createMeshDht({ localPodId: 'node-a', transport })

    handler({ type: 'dht-relay', from: 'node-b', to: 'someone-else', payload: { type: DHT_PING } })

    assert.equal(dhtNode.routingTable.size, 0)
  })

  it('ignores its own broadcast echo', () => {
    let handler = null
    const transport = { send() {}, onMessage: (cb) => { handler = cb } }
    const { dhtNode } = createMeshDht({ localPodId: 'node-a', transport })

    handler({ type: 'dht-relay', from: 'node-a', to: 'node-a', payload: { type: DHT_PING } })

    assert.equal(dhtNode.routingTable.size, 0)
  })

  it('ignores unrelated message types sharing the same transport', () => {
    let handler = null
    const transport = { send() {}, onMessage: (cb) => { handler = cb } }
    const { dhtNode } = createMeshDht({ localPodId: 'node-a', transport })

    handler({ type: 'webrtc-offer', from: 'node-b', to: 'node-a', payload: {} })

    assert.equal(dhtNode.routingTable.size, 0)
  })

  it('bootstrapPeers accepts bare podId strings', async () => {
    const transport = { send() {}, onMessage() {} }
    const { strategy, dhtNode } = createMeshDht({
      localPodId: 'node-a',
      transport,
      bootstrapPeers: ['seed-1', 'seed-2'],
    })
    await strategy.start()
    assert.equal(dhtNode.routingTable.size, 2)
  })
})

// ---------------------------------------------------------------------------
// Real DHT discovery across multiple nodes sharing a transport bus
// ---------------------------------------------------------------------------

describe('DHT discovery across real DhtDiscoveryStrategy instances', () => {
  it('three nodes bootstrapped with each other discover each other via real DHT STORE replication', async () => {
    const bus = createSharedBus()

    const a = createMeshDht({ localPodId: 'pod-a', transport: createBusTransport(bus), bootstrapPeers: ['pod-b', 'pod-c'] })
    const b = createMeshDht({ localPodId: 'pod-b', transport: createBusTransport(bus), bootstrapPeers: ['pod-a', 'pod-c'] })
    const c = createMeshDht({ localPodId: 'pod-c', transport: createBusTransport(bus), bootstrapPeers: ['pod-a', 'pod-b'] })

    await a.strategy.start()
    await b.strategy.start()
    await c.strategy.start()

    assert.equal(a.dhtNode.routingTable.size, 2, 'alice bootstrapped with bob+carol')
    assert.equal(b.dhtNode.routingTable.size, 2, 'bob bootstrapped with alice+carol')
    assert.equal(c.dhtNode.routingTable.size, 2, 'carol bootstrapped with alice+bob')

    // Alice announces her own record -- since bob and carol are already her
    // bootstrapped (closest) contacts, DhtNode.store() replicates to both
    // over the real shared bus, not just locally.
    await a.strategy.announce({ podId: 'pod-a', label: 'Alice' })

    const foundByBob = await b.strategy.query({ podId: 'pod-a' })
    const foundByCarol = await c.strategy.query({ podId: 'pod-a' })
    assert.equal(foundByBob.length, 1)
    assert.equal(foundByBob[0].podId, 'pod-a')
    assert.equal(foundByCarol.length, 1)
    assert.equal(foundByCarol[0].podId, 'pod-a')

    a.teardown()
    b.teardown()
    c.teardown()
  })

  it('a node with no shared bootstrap contact cannot discover peers via DHT alone (documents the cold-start gap)', async () => {
    const bus = createSharedBus()

    const a = createMeshDht({ localPodId: 'pod-a', transport: createBusTransport(bus), bootstrapPeers: [] })
    const lonely = createMeshDht({ localPodId: 'pod-lonely', transport: createBusTransport(bus), bootstrapPeers: [] })

    await a.strategy.start()
    await lonely.strategy.start()

    await a.strategy.announce({ podId: 'pod-a', label: 'Alice' })

    // Neither node has ever heard of the other -- no bootstrap contact, no
    // rendezvous mechanism, so the announce replicates to nobody and the
    // lonely node's query comes back empty. This is the honest limitation
    // documented in mesh-dht.mjs's header.
    const found = await lonely.strategy.query({ podId: 'pod-a' })
    assert.deepEqual(found, [])

    a.teardown()
    lonely.teardown()
  })
})

// ---------------------------------------------------------------------------
// createMeshNode({ enableDht: true }) -- full integration
// ---------------------------------------------------------------------------

function createStubSignalingTransport() {
  return { send() {}, onMessage() {} }
}

describe('createMeshNode({ enableDht: true })', () => {
  it('mechanically accepts a pre-built DhtDiscoveryStrategy via discoveryStrategies today (no enableDht needed)', async () => {
    const { DhtDiscoveryStrategy } = await import('@johnhenry/browsermesh-discovery')
    const dhtStrategy = new DhtDiscoveryStrategy({ localId: 'placeholder', sendFn: () => {} })

    const node = await createMeshNode({
      label: 'manual-dht',
      signalingTransport: createStubSignalingTransport(),
      discoveryStrategies: [dhtStrategy],
      skipBoot: true,
    })

    assert.ok(node, 'createMeshNode does not reject a caller-supplied DhtDiscoveryStrategy')
  })

  it('attaches node.dht and adds the strategy to discovery when enableDht is set', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableDht: true,
      skipBoot: true,
    })

    assert.ok(node.dht, 'node.dht is attached')
    assert.equal(node.dht.type, 'dht')
  })

  it('enableDht works in a Node-like environment with no BroadcastChannel and no explicit discoveryStrategies', async () => {
    // createMeshNode() would normally throw here (no BroadcastChannel, no
    // discoveryStrategies) -- enableDht: true must be a valid escape hatch.
    const originalBroadcastChannel = globalThis.BroadcastChannel
    delete globalThis.BroadcastChannel
    try {
      const node = await createMeshNode({
        label: 'alice',
        signalingTransport: createStubSignalingTransport(),
        enableDht: true,
        skipBoot: true,
      })
      assert.ok(node.dht)
    } finally {
      if (originalBroadcastChannel) globalThis.BroadcastChannel = originalBroadcastChannel
    }
  })

  it('two real PeerNodes discover each other via DHT, and WebRTC signaling keeps working on the shared transport', async () => {
    const bus = createSharedBus()

    const nodeA = await createMeshNode({
      label: 'alice',
      signalingTransport: createBusTransport(bus),
      enableDht: true,
    })
    const nodeB = await createMeshNode({
      label: 'bob',
      signalingTransport: createBusTransport(bus),
      enableDht: true,
      dhtBootstrapPeers: [nodeA.podId],
    })

    try {
      assert.notEqual(nodeA.podId, nodeB.podId)

      // Bob's boot-time initial announce (DiscoveryManager.start() always
      // announces once) replicates his record to alice, since alice is
      // already his bootstrapped (closest) DHT contact.
      const foundByAlice = await nodeA.discover({ podId: nodeB.podId })
      assert.ok(
        foundByAlice.some((r) => r.podId === nodeB.podId),
        'alice discovers bob via real DHT replication, with zero manual peer exchange',
      )

      // Bob does not yet have alice's record (alice's own boot-time announce
      // happened before bob existed as a routing contact). Alice re-announcing
      // now that bob is a known contact (learned automatically via
      // handleMessage() when his STORE arrived) closes the loop.
      await nodeA.announce()
      const foundByBob = await nodeB.discover({ podId: nodeA.podId })
      assert.ok(
        foundByBob.some((r) => r.podId === nodeA.podId),
        'bob discovers alice via real DHT replication after alice re-announces',
      )

      // -- Regression: shareTransport() must not break WebRTC signaling ------
      // Both nodes' MeshSignalingChannel and DhtDiscoveryStrategy share the
      // same underlying signalingTransport via shareTransport(); prove a
      // plain signaling message still gets delivered correctly.
      const offers = []
      const unsubOffer = nodeB.signaling.onOffer((from, payload) => offers.push({ from, payload }))
      nodeA.signaling.send('webrtc-offer', nodeB.podId, { sdp: 'fake-offer-sdp' })
      assert.equal(offers.length, 1)
      assert.equal(offers[0].from, nodeA.podId)
      assert.deepEqual(offers[0].payload, { sdp: 'fake-offer-sdp' })
      unsubOffer()
    } finally {
      await nodeA.shutdown()
      await nodeB.shutdown()
    }
  })

  it('three real PeerNodes bootstrapped with each other all discover each other via DHT', async () => {
    const bus = createSharedBus()

    const nodeA = await createMeshNode({
      label: 'alice',
      signalingTransport: createBusTransport(bus),
      enableDht: true,
    })
    const nodeB = await createMeshNode({
      label: 'bob',
      signalingTransport: createBusTransport(bus),
      enableDht: true,
      dhtBootstrapPeers: [nodeA.podId],
    })
    const nodeC = await createMeshNode({
      label: 'carol',
      signalingTransport: createBusTransport(bus),
      enableDht: true,
      dhtBootstrapPeers: [nodeA.podId, nodeB.podId],
    })

    try {
      // Close the loop: alice and bob re-announce now that carol (and each
      // other, for alice/bob) are known DHT contacts, so every node ends up
      // with every other node's record -- real, multi-hop DHT propagation,
      // not just direct bootstrap edges.
      await nodeA.announce()
      await nodeB.announce()

      // Note: DhtDiscoveryStrategy.query() only supports point lookups by
      // podId/key (see dht.mjs) -- unlike BroadcastChannelStrategy/
      // RelayStrategy/ManualStrategy, calling it with no filter always
      // returns [] rather than "everything known". discover(filter) per
      // target podId is the correct way to use it, not a bare discover().
      const foundBobToAlice = await nodeA.discover({ podId: nodeB.podId })
      const foundCarolToAlice = await nodeA.discover({ podId: nodeC.podId })
      const foundAliceToBob = await nodeB.discover({ podId: nodeA.podId })
      const foundCarolToBob = await nodeB.discover({ podId: nodeC.podId })
      const foundAliceToCarol = await nodeC.discover({ podId: nodeA.podId })
      const foundBobToCarol = await nodeC.discover({ podId: nodeB.podId })

      assert.ok(foundBobToAlice.some((r) => r.podId === nodeB.podId), 'alice discovers bob')
      assert.ok(foundCarolToAlice.some((r) => r.podId === nodeC.podId), 'alice discovers carol')
      assert.ok(foundAliceToBob.some((r) => r.podId === nodeA.podId), 'bob discovers alice')
      assert.ok(foundCarolToBob.some((r) => r.podId === nodeC.podId), 'bob discovers carol')
      assert.ok(foundAliceToCarol.some((r) => r.podId === nodeA.podId), 'carol discovers alice')
      assert.ok(foundBobToCarol.some((r) => r.podId === nodeB.podId), 'carol discovers bob')
    } finally {
      await nodeA.shutdown()
      await nodeB.shutdown()
      await nodeC.shutdown()
    }
  })
})
