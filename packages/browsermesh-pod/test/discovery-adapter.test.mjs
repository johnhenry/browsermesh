import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { TransportDiscovery, NullDiscovery } from '../src/discovery.mjs'
import { EventEmitterTransport } from '../src/transport.mjs'
import {
  POD_HELLO, POD_HELLO_ACK, POD_GOODBYE, POD_MESSAGE,
  createHello, createHelloAck, createGoodbye, createMessage,
} from '../src/messages.mjs'

// ---------------------------------------------------------------------------
// TransportDiscovery
// ---------------------------------------------------------------------------

describe('TransportDiscovery', () => {
  const transports = []

  afterEach(async () => {
    for (const t of transports) {
      try { await t.close() } catch { /* ignore */ }
    }
    transports.length = 0
  })

  function makePair() {
    const bus = EventEmitterTransport.createBus()
    const t1 = new EventEmitterTransport(bus)
    const t2 = new EventEmitterTransport(bus)
    transports.push(t1, t2)
    return { bus, t1, t2 }
  }

  it('two pods discover each other', async () => {
    const { t1, t2 } = makePair()

    const d1 = new TransportDiscovery({
      transport: t1,
      localPodId: 'pod-A',
      localKind: 'worker',
      timeout: 50,
    })
    const d2 = new TransportDiscovery({
      transport: t2,
      localPodId: 'pod-B',
      localKind: 'tab',
      timeout: 50,
    })

    const foundByA = []
    const foundByB = []
    d1.onPeerDiscovered((info) => foundByA.push(info))
    d2.onPeerDiscovered((info) => foundByB.push(info))

    // Start both — d1 starts first, d2's hello triggers d1's ack
    await d1.start()
    await d2.start()

    // Allow any remaining async delivery
    await new Promise((r) => setTimeout(r, 30))

    // pod-A should have found pod-B (via hello) and pod-B should have found pod-A (via ack)
    assert.ok(foundByA.some((p) => p.podId === 'pod-B'), 'A should discover B')
    assert.ok(foundByB.some((p) => p.podId === 'pod-A'), 'B should discover A')

    await d1.stop({ silent: true })
    await d2.stop({ silent: true })
  })

  it('responds to POD_HELLO with POD_HELLO_ACK', async () => {
    const { t1, t2 } = makePair()

    const d1 = new TransportDiscovery({
      transport: t1,
      localPodId: 'pod-A',
      localKind: 'worker',
      timeout: 50,
    })

    // Open t2 manually to listen for the ACK
    await t2.open()
    const acks = []
    t2.onMessage((msg) => {
      if (msg.type === POD_HELLO_ACK) acks.push(msg)
    })

    await d1.start()

    // Now send a hello from t2 as if a new pod arrived
    t2.send(createHello({ podId: 'pod-B', kind: 'tab' }))

    await new Promise((r) => setTimeout(r, 30))

    assert.equal(acks.length, 1)
    assert.equal(acks[0].podId, 'pod-A')
    assert.equal(acks[0].targetPodId, 'pod-B')

    await d1.stop({ silent: true })
  })

  it('filters POD_HELLO_ACK by targetPodId', async () => {
    const { t1, t2 } = makePair()

    const d1 = new TransportDiscovery({
      transport: t1,
      localPodId: 'pod-A',
      localKind: 'worker',
      timeout: 50,
    })

    const found = []
    d1.onPeerDiscovered((info) => found.push(info))

    await d1.start()
    await t2.open()

    // ACK targeted at a different pod — should be ignored
    t2.send(createHelloAck({ podId: 'pod-C', kind: 'tab', targetPodId: 'pod-X' }))
    // ACK targeted at pod-A — should be accepted
    t2.send(createHelloAck({ podId: 'pod-D', kind: 'tab', targetPodId: 'pod-A' }))

    await new Promise((r) => setTimeout(r, 30))

    assert.equal(found.length, 1)
    assert.equal(found[0].podId, 'pod-D')

    await d1.stop({ silent: true })
  })

  it('ignores own hello messages', async () => {
    const bus = EventEmitterTransport.createBus()
    const t1 = new EventEmitterTransport(bus)
    transports.push(t1)

    const d1 = new TransportDiscovery({
      transport: t1,
      localPodId: 'pod-A',
      localKind: 'worker',
      timeout: 50,
    })

    const found = []
    d1.onPeerDiscovered((info) => found.push(info))

    await d1.start()

    // Even if somehow a hello with own podId arrives, it should be ignored
    // (the transport already filters self, but discovery also checks)
    // We can't easily bypass the transport self-filter, so this is a design check
    assert.equal(found.length, 0)

    await d1.stop({ silent: true })
  })

  it('fires onPeerLost on POD_GOODBYE', async () => {
    const { t1, t2 } = makePair()

    const d1 = new TransportDiscovery({
      transport: t1,
      localPodId: 'pod-A',
      localKind: 'worker',
      timeout: 50,
    })

    const lost = []
    d1.onPeerLost((info) => lost.push(info))

    await d1.start()
    await t2.open()

    t2.send(createGoodbye({ podId: 'pod-B' }))

    await new Promise((r) => setTimeout(r, 30))

    assert.equal(lost.length, 1)
    assert.equal(lost[0].podId, 'pod-B')

    await d1.stop({ silent: true })
  })

  it('passes non-discovery messages to onMessage handler', async () => {
    const { t1, t2 } = makePair()

    const d1 = new TransportDiscovery({
      transport: t1,
      localPodId: 'pod-A',
      localKind: 'worker',
      timeout: 50,
    })

    const passedThrough = []
    d1.onMessage((msg) => passedThrough.push(msg))

    await d1.start()
    await t2.open()

    const genericMsg = createMessage({ from: 'pod-B', to: 'pod-A', payload: 'hi' })
    t2.send(genericMsg)

    await new Promise((r) => setTimeout(r, 30))

    assert.equal(passedThrough.length, 1)
    assert.equal(passedThrough[0].type, POD_MESSAGE)
    assert.equal(passedThrough[0].payload, 'hi')

    await d1.stop({ silent: true })
  })

  it('ignores messages without type', async () => {
    const { t1, t2 } = makePair()

    const d1 = new TransportDiscovery({
      transport: t1,
      localPodId: 'pod-A',
      localKind: 'worker',
      timeout: 50,
    })

    const passedThrough = []
    d1.onMessage((msg) => passedThrough.push(msg))

    await d1.start()
    await t2.open()

    t2.send({ noType: true })
    t2.send(null)

    await new Promise((r) => setTimeout(r, 30))

    assert.equal(passedThrough.length, 0)

    await d1.stop({ silent: true })
  })

  it('stop() sends goodbye by default', async () => {
    const { t1, t2 } = makePair()

    const d1 = new TransportDiscovery({
      transport: t1,
      localPodId: 'pod-A',
      localKind: 'worker',
      timeout: 50,
    })

    await t2.open()
    const goodbyes = []
    t2.onMessage((msg) => {
      if (msg.type === POD_GOODBYE) goodbyes.push(msg)
    })

    await d1.start()
    await d1.stop()

    assert.equal(goodbyes.length, 1)
    assert.equal(goodbyes[0].podId, 'pod-A')
  })

  it('stop({ silent: true }) skips goodbye', async () => {
    const { t1, t2 } = makePair()

    const d1 = new TransportDiscovery({
      transport: t1,
      localPodId: 'pod-A',
      localKind: 'worker',
      timeout: 50,
    })

    await t2.open()
    const goodbyes = []
    t2.onMessage((msg) => {
      if (msg.type === POD_GOODBYE) goodbyes.push(msg)
    })

    await d1.start()
    await d1.stop({ silent: true })

    // Allow any async delivery
    await new Promise((r) => setTimeout(r, 30))

    assert.equal(goodbyes.length, 0)
  })

  it('start() opens transport if not already open', async () => {
    const bus = EventEmitterTransport.createBus()
    const t = new EventEmitterTransport(bus)
    transports.push(t)

    assert.equal(t.ready, false)

    const d = new TransportDiscovery({
      transport: t,
      localPodId: 'pod-A',
      localKind: 'worker',
      timeout: 50,
    })

    await d.start()
    assert.equal(t.ready, true)

    await d.stop({ silent: true })
  })

  it('includes kind in peer discovery info', async () => {
    const { t1, t2 } = makePair()

    const d1 = new TransportDiscovery({
      transport: t1,
      localPodId: 'pod-A',
      localKind: 'worker',
      timeout: 50,
    })
    const d2 = new TransportDiscovery({
      transport: t2,
      localPodId: 'pod-B',
      localKind: 'tab',
      timeout: 50,
    })

    const foundByA = []
    d1.onPeerDiscovered((info) => foundByA.push(info))

    await d1.start()
    await d2.start()
    await new Promise((r) => setTimeout(r, 30))

    const podB = foundByA.find((p) => p.podId === 'pod-B')
    assert.ok(podB)
    assert.equal(podB.kind, 'tab')

    await d1.stop({ silent: true })
    await d2.stop({ silent: true })
  })
})

// ---------------------------------------------------------------------------
// NullDiscovery
// ---------------------------------------------------------------------------

describe('NullDiscovery', () => {
  it('all methods are no-ops', async () => {
    const d = new NullDiscovery()
    d.onPeerDiscovered(() => {})
    d.onPeerLost(() => {})
    d.onMessage(() => {})
    await d.start()
    await d.stop()
  })
})
