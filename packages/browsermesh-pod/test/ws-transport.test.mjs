import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { WebSocketTransport } from '../src/ws-transport.mjs'
import { Pod } from '../src/pod.mjs'
import { createFakeWebSocketNetwork } from './helpers/fake-websocket.mjs'

const transportsToClose = []

afterEach(async () => {
  for (const t of transportsToClose) {
    try { await t.close() } catch { /* ignore */ }
  }
  transportsToClose.length = 0
})

function track(t) {
  transportsToClose.push(t)
  return t
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Register handshake
// ---------------------------------------------------------------------------

describe('WebSocketTransport — register handshake', () => {
  it('constructor requires url and podId', () => {
    assert.throws(() => new WebSocketTransport({ podId: 'a' }), /requires \{ url \}/)
    assert.throws(() => new WebSocketTransport({ url: 'ws://relay.test' }), /requires \{ podId \}/)
  })

  it('throws in open() when no WebSocket constructor is available', async () => {
    const t = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'p1', WebSocket: null }))
    await assert.rejects(() => t.open(), /no WebSocket constructor available/)
  })

  it('is not ready before open()', () => {
    const net = createFakeWebSocketNetwork()
    const t = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'p1', WebSocket: net.FakeWebSocket }))
    assert.equal(t.ready, false)
  })

  it('registers and becomes ready on open()', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    net.registerServer('ws://relay.test', relay)

    const t = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'p1', WebSocket: net.FakeWebSocket }))
    await t.open()

    assert.equal(t.ready, true)
    assert.equal(relay.size, 1)
  })

  it('rejects open() when the server reports an error before registering', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    net.registerServer('ws://relay.test', relay)

    // Pre-register the podId so the second connection gets an "already registered" error.
    const first = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'dup', WebSocket: net.FakeWebSocket }))
    await first.open()

    const second = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'dup', WebSocket: net.FakeWebSocket, reconnect: { maxAttempts: 0 } }))
    await assert.rejects(() => second.open())
  })
})

// ---------------------------------------------------------------------------
// Wire encoding (matches browsermesh-transport's encodeWireData contract)
// ---------------------------------------------------------------------------

describe('WebSocketTransport — wire encoding', () => {
  function spyNetwork() {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    net.registerServer('ws://relay.test', relay)
    const sent = []
    const sockets = []
    class SpyWebSocket extends net.FakeWebSocket {
      constructor(url) { super(url); sockets.push(this) }
      send(raw) { sent.push(raw); super.send(raw) }
    }
    return { net, relay, sent, sockets, SpyWebSocket }
  }

  it('hands the socket exactly one JSON text per frame, with the pod message as a nested object', async () => {
    const { sent, SpyWebSocket } = spyNetwork()
    const alice = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'alice', WebSocket: SpyWebSocket }))
    await alice.open()
    sent.length = 0

    const msg = { type: 'pod:message', to: 'bob', payload: { text: 'hi' } }
    // bob is unknown to the relay (error reply), the frame is still what we assert on
    alice.send(msg)

    assert.equal(sent.length, 1)
    assert.equal(typeof sent[0], 'string')
    const frame = JSON.parse(sent[0])
    assert.equal(frame.type, 'relay')
    assert.equal(frame.target, 'bob')
    assert.equal(typeof frame.envelope, 'object', 'envelope must not be a pre-encoded string (double encoding)')
    assert.deepEqual(frame.envelope, msg)
  })

  it('reads binary (ArrayBuffer / typed array / Blob) frames as UTF-8 JSON, in order', async () => {
    const { sockets, SpyWebSocket } = spyNetwork()
    const bob = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'bob', WebSocket: SpyWebSocket }))
    await bob.open()
    const received = []
    bob.onMessage((m) => received.push(m))

    const enc = (o) => new TextEncoder().encode(JSON.stringify(o))
    const ws = sockets[0]
    ws._dispatch('message', { data: enc({ type: 'relayed', source: 'alice', envelope: { type: 'pod:message', payload: 1 } }).buffer })
    ws._dispatch('message', { data: enc({ type: 'relayed', source: 'alice', envelope: { type: 'pod:message', payload: 2 } }) })
    // #221: a Blob is read asynchronously, and frames behind it keep their order
    ws._dispatch('message', { data: new Blob(['{"type":"relayed","source":"alice","envelope":{"payload":3}}']) })
    ws._dispatch('message', { data: JSON.stringify({ type: 'relayed', source: 'alice', envelope: { type: 'pod:message', payload: 4 } }) })
    ws._dispatch('message', { data: new Blob(['not json']) })
    ws._dispatch('message', { data: JSON.stringify({ type: 'relayed', source: 'alice', envelope: { type: 'pod:message', payload: 5 } }) })
    await wait(30)

    assert.deepEqual(received.map((m) => m.payload), [1, 2, 3, 4, 5])
  })
})

// ---------------------------------------------------------------------------
// Point-to-point relay
// ---------------------------------------------------------------------------

describe('WebSocketTransport — point-to-point relay', () => {
  it('delivers a targeted message via relay/relayed, attaching "from" when absent', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    net.registerServer('ws://relay.test', relay)

    const alice = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'alice', WebSocket: net.FakeWebSocket }))
    const bob = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'bob', WebSocket: net.FakeWebSocket }))
    await alice.open()
    await bob.open()

    const received = []
    bob.onMessage((msg) => received.push(msg))

    alice.send({ type: 'pod:message', to: 'bob', payload: { text: 'hi' } })
    await wait(20)

    assert.equal(received.length, 1)
    assert.equal(received[0].to, 'bob')
    assert.equal(received[0].from, 'alice') // injected because the envelope had no "from"
    assert.deepEqual(received[0].payload, { text: 'hi' })
  })

  it('preserves an existing "from" field on the envelope', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    net.registerServer('ws://relay.test', relay)

    const alice = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'alice', WebSocket: net.FakeWebSocket }))
    const bob = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'bob', WebSocket: net.FakeWebSocket }))
    await alice.open()
    await bob.open()

    const received = []
    bob.onMessage((msg) => received.push(msg))

    alice.send({ type: 'pod:message', from: 'alice', to: 'bob', payload: 1 })
    await wait(20)

    assert.equal(received[0].from, 'alice')
  })

  it('adds the relayed sender to knownPeers', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    net.registerServer('ws://relay.test', relay)

    const alice = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'alice', WebSocket: net.FakeWebSocket }))
    const bob = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'bob', WebSocket: net.FakeWebSocket }))
    await alice.open()
    await bob.open()

    bob.onMessage(() => {})
    alice.send({ type: 'pod:message', to: 'bob', payload: 1 })
    await wait(20)

    assert.ok(bob.knownPeers.has('alice'))
  })
})

// ---------------------------------------------------------------------------
// Broadcast fan-out
// ---------------------------------------------------------------------------

describe('WebSocketTransport — broadcast fan-out', () => {
  it('fans a "to"-less message out to every known peer, point-to-point', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    net.registerServer('ws://relay.test', relay)

    const alice = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'alice', WebSocket: net.FakeWebSocket }))
    const bob = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'bob', WebSocket: net.FakeWebSocket }))
    const carol = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'carol', WebSocket: net.FakeWebSocket }))
    await alice.open()
    await bob.open()
    await carol.open()

    // Seed alice's knownPeers the same way discovery would: bob and carol
    // each say hello to alice first (point-to-point), so alice learns of them.
    const aliceReceived = []
    alice.onMessage((msg) => aliceReceived.push(msg))
    bob.send({ type: 'pod:hello', podId: 'bob', to: 'alice' })
    carol.send({ type: 'pod:hello', podId: 'carol', to: 'alice' })
    await wait(20)
    assert.equal(aliceReceived.length, 2)
    assert.ok(alice.knownPeers.has('bob') && alice.knownPeers.has('carol'))

    const bobReceived = []
    const carolReceived = []
    bob.onMessage((msg) => bobReceived.push(msg))
    carol.onMessage((msg) => carolReceived.push(msg))

    // No "to" field — should fan out point-to-point to bob AND carol.
    alice.send({ type: 'pod:goodbye', podId: 'alice' })
    await wait(20)

    assert.equal(bobReceived.length, 1)
    assert.equal(carolReceived.length, 1)
    assert.equal(bobReceived[0].type, 'pod:goodbye')
    assert.equal(carolReceived[0].type, 'pod:goodbye')
  })

  it('treats to: "*" the same as an absent "to" (broadcast)', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    net.registerServer('ws://relay.test', relay)

    const alice = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'alice', WebSocket: net.FakeWebSocket }))
    const bob = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'bob', WebSocket: net.FakeWebSocket }))
    await alice.open()
    await bob.open()

    alice.onMessage(() => {})
    bob.send({ type: 'pod:hello', podId: 'bob', to: 'alice' })
    await wait(20)

    const received = []
    bob.onMessage((msg) => received.push(msg))
    alice.send({ type: 'pod:message', to: '*', payload: 'everyone' })
    await wait(20)

    assert.equal(received.length, 1)
    assert.equal(received[0].payload, 'everyone')
  })
})

// ---------------------------------------------------------------------------
// Peers from signaling
// ---------------------------------------------------------------------------

describe('WebSocketTransport — peersFromSignaling', () => {
  it('seeds knownPeers from the signaling peers list on registration', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    const signaling = net.createSignalingServer()
    net.registerServer('ws://relay.test', relay)
    net.registerServer('ws://signaling.test', signaling)

    const alice = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'alice', WebSocket: net.FakeWebSocket, peersFromSignaling: true, signalingUrl: 'ws://signaling.test' }))
    await alice.open()

    const bob = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'bob', WebSocket: net.FakeWebSocket, peersFromSignaling: true, signalingUrl: 'ws://signaling.test' }))
    await bob.open()
    await wait(20)

    // bob registered after alice, so bob's initial "peers" frame includes alice.
    assert.ok(bob.knownPeers.has('alice'))
    // alice should have learned about bob via "peer-joined".
    assert.ok(alice.knownPeers.has('bob'))
  })

  it('can send a "to"-less message using only signaling-derived peers (no relay traffic seen yet)', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    const signaling = net.createSignalingServer()
    net.registerServer('ws://relay.test', relay)
    net.registerServer('ws://signaling.test', signaling)

    const alice = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'alice', WebSocket: net.FakeWebSocket, peersFromSignaling: true, signalingUrl: 'ws://signaling.test' }))
    await alice.open()
    const bob = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'bob', WebSocket: net.FakeWebSocket, peersFromSignaling: true, signalingUrl: 'ws://signaling.test' }))
    await bob.open()
    await wait(20)

    const received = []
    bob.onMessage((msg) => received.push(msg))

    // Alice has never received anything from bob over the relay — her
    // knownPeers came entirely from the signaling connection.
    alice.send({ type: 'pod:hello', podId: 'alice' })
    await wait(20)

    assert.equal(received.length, 1)
    assert.equal(received[0].podId, 'alice')
  })

  it('removes a peer on peer-left', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    const signaling = net.createSignalingServer()
    net.registerServer('ws://relay.test', relay)
    net.registerServer('ws://signaling.test', signaling)

    const alice = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'alice', WebSocket: net.FakeWebSocket, peersFromSignaling: true, signalingUrl: 'ws://signaling.test' }))
    await alice.open()
    const bob = new WebSocketTransport({ url: 'ws://relay.test', podId: 'bob', WebSocket: net.FakeWebSocket, peersFromSignaling: true, signalingUrl: 'ws://signaling.test' })
    await bob.open()
    await wait(20)
    assert.ok(alice.knownPeers.has('bob'))

    await bob.close()
    await wait(20)

    assert.ok(!alice.knownPeers.has('bob'))
  })
})

// ---------------------------------------------------------------------------
// Reconnect
// ---------------------------------------------------------------------------

describe('WebSocketTransport — reconnect', () => {
  it('reconnects and re-registers with exponential backoff after an unexpected close', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    net.registerServer('ws://relay.test', relay)

    const t = track(new WebSocketTransport({
      url: 'ws://relay.test',
      podId: 'alice',
      WebSocket: net.FakeWebSocket,
      reconnect: { baseMs: 10, maxMs: 50, maxAttempts: Infinity },
    }))
    await t.open()
    assert.equal(t.ready, true)
    assert.equal(relay.connectionCount, 1)

    relay.kill('alice')
    await wait(5)
    assert.equal(t.ready, false)

    // Wait past the backoff delay for the reconnect to happen.
    await wait(60)
    assert.equal(t.ready, true)
    assert.equal(relay.connectionCount, 2)
  })

  it('ready is false while disconnected and sends are dropped', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    net.registerServer('ws://relay.test', relay)

    const t = track(new WebSocketTransport({
      url: 'ws://relay.test',
      podId: 'alice',
      WebSocket: net.FakeWebSocket,
      reconnect: { baseMs: 1000, maxMs: 1000 },
    }))
    await t.open()
    relay.kill('alice')
    await wait(5)

    assert.equal(t.ready, false)
    // Should not throw even though disconnected.
    t.send({ type: 'pod:message', to: 'bob', payload: 1 })
  })
})

// ---------------------------------------------------------------------------
// Ping / pong
// ---------------------------------------------------------------------------

describe('WebSocketTransport — ping/pong', () => {
  it('responds to an incoming ping with pong on the primary connection', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    net.registerServer('ws://relay.test', relay)

    const t = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'alice', WebSocket: net.FakeWebSocket }))
    await t.open()

    relay.pushTo('alice', { type: 'ping' })
    await wait(20)

    const pongs = relay.log.filter((e) => e.podId === 'alice' && e.data.type === 'pong')
    assert.equal(pongs.length, 1)
  })

  it('responds to an incoming ping on the signaling connection', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    const signaling = net.createSignalingServer()
    net.registerServer('ws://relay.test', relay)
    net.registerServer('ws://signaling.test', signaling)

    const t = track(new WebSocketTransport({ url: 'ws://relay.test', podId: 'alice', WebSocket: net.FakeWebSocket, peersFromSignaling: true, signalingUrl: 'ws://signaling.test' }))
    await t.open()

    signaling.pushTo('alice', { type: 'ping' })
    await wait(20)

    const pongs = signaling.log.filter((e) => e.podId === 'alice' && e.data.type === 'pong')
    assert.equal(pongs.length, 1)
  })
})

// ---------------------------------------------------------------------------
// Close clears timers
// ---------------------------------------------------------------------------

describe('WebSocketTransport — close()', () => {
  it('clears pending reconnect timers and prevents further reconnection', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    net.registerServer('ws://relay.test', relay)

    const t = new WebSocketTransport({
      url: 'ws://relay.test',
      podId: 'alice',
      WebSocket: net.FakeWebSocket,
      reconnect: { baseMs: 15, maxMs: 15 },
    })
    await t.open()
    assert.equal(relay.connectionCount, 1)

    relay.kill('alice')
    await wait(5) // reconnect timer is now pending

    await t.close()
    await wait(60) // longer than the backoff delay

    assert.equal(relay.connectionCount, 1, 'no reconnection should have happened after close()')
    assert.equal(t.ready, false)
  })

  it('is idempotent and safe to call when never opened', async () => {
    const net = createFakeWebSocketNetwork()
    const t = new WebSocketTransport({ url: 'ws://relay.test', podId: 'alice', WebSocket: net.FakeWebSocket })
    await t.close()
    await t.close()
  })
})

// ---------------------------------------------------------------------------
// Integration: two real Pods discover each other over the fake relay
// ---------------------------------------------------------------------------

describe('WebSocketTransport — Pod integration', () => {
  it('two Pods using WebSocketTransport + TransportDiscovery discover each other over the fake relay', async () => {
    const net = createFakeWebSocketNetwork()
    const relay = net.createRelayServer()
    const signaling = net.createSignalingServer()
    net.registerServer('ws://relay.test', relay)
    net.registerServer('ws://signaling.test', signaling)

    // Pod generates its own identity during boot() unless one is supplied.
    // We pre-generate identities so the WebSocketTransport's `podId` (used
    // for relay/signaling registration) matches the Pod's own podId.
    const aliceIdentity = await PodIdentity.generate()
    const bobIdentity = await PodIdentity.generate()

    const alice = new Pod()
    const bob = new Pod()

    const aliceTransport = new WebSocketTransport({
      url: 'ws://relay.test',
      podId: aliceIdentity.podId,
      WebSocket: net.FakeWebSocket,
      peersFromSignaling: true,
      signalingUrl: 'ws://signaling.test',
    })
    const bobTransport = new WebSocketTransport({
      url: 'ws://relay.test',
      podId: bobIdentity.podId,
      WebSocket: net.FakeWebSocket,
      peersFromSignaling: true,
      signalingUrl: 'ws://signaling.test',
    })

    // Sequential boot: alice fully registers (relay + signaling) before bob
    // starts, so bob's signaling "peers" snapshot already includes alice —
    // bob's hello can reach alice point-to-point on the first try.
    await alice.boot({ identity: aliceIdentity, transport: aliceTransport, discoveryTimeout: 150 })
    await bob.boot({ identity: bobIdentity, transport: bobTransport, discoveryTimeout: 150 })

    assert.ok(alice.peers.has(bob.podId), 'alice should have discovered bob')
    assert.ok(bob.peers.has(alice.podId), 'bob should have discovered alice')

    // And a real message still flows end-to-end through the fake relay.
    const received = new Promise((resolve) => bob.on('message', resolve))
    alice.send(bob.podId, { text: 'hello over the fake relay' })
    const msg = await received
    assert.equal(msg.from, alice.podId)
    assert.deepEqual(msg.payload, { text: 'hello over the fake relay' })

    await alice.shutdown()
    await bob.shutdown()
  })
})
