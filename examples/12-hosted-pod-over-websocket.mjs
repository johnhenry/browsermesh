/**
 * Two Pods discover each other and exchange a message over
 * `WebSocketTransport` — the adapter that lets a `Pod` run outside a
 * browser tab (a V8 isolate, a microVM, a plain Node process) and still
 * join the mesh, by speaking the `browsermesh-servers` relay/signaling
 * wire protocol instead of relying on same-origin `BroadcastChannel`.
 *
 * See issue #185 ("Hosted pods") work package 1. The real relay/signaling
 * servers live in the sibling `browsermesh-servers` repo
 * (`relay/index.mjs`, `signaling/index.mjs`); this example simulates both
 * in-process — same convention as `02-two-pods-discover-and-message.mjs`'s
 * `EventEmitterTransport` bus — so it runs headless with no network and no
 * dependencies, but the register/relay/relayed/peers/peer-joined framing
 * exercised is exactly the real wire protocol those servers speak.
 *
 * The relay server has no broadcast primitive: it only forwards
 * `{type:'relay', target, envelope}` point-to-point to one registered
 * peer. `WebSocketTransport` works around that by fanning a `to`-less send
 * (like discovery's `hello`/`goodbye`) out point-to-point to every peer id
 * it currently knows about. To seed that peer list *before* either Pod's
 * first `hello` goes out, both pods also open a second connection to a
 * signaling-style server and consume its `peers`/`peer-joined` messages
 * (`peersFromSignaling: true`) — the "spike path" the issue calls out as
 * requiring no server change.
 */

import assert from 'node:assert/strict'
import { Pod, WebSocketTransport } from '@johnhenry/browsermesh-pod'

// ── A minimal in-process relay + signaling pair, and a WebSocket-shaped
//    client that talks to them, standing in for the real network. ──────────

const OPEN = 1
const CLOSED = 3

class FakeEventTarget {
  #listeners = new Map()
  addEventListener(type, fn) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set())
    this.#listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) { this.#listeners.get(type)?.delete(fn) }
  _dispatch(type, detail) {
    for (const fn of this.#listeners.get(type) ?? []) fn(detail)
  }
}

class FakeRelayServer {
  #clients = new Map()
  connect() {}
  disconnect(ws) { if (ws.podId) this.#clients.delete(ws.podId) }
  receive(ws, data) {
    if (!ws.podId) {
      if (data.type !== 'register' || !data.podId) return
      ws.podId = data.podId
      this.#clients.set(data.podId, ws)
      ws._serverSend({ type: 'registered', podId: data.podId })
      return
    }
    if (data.type === 'relay') {
      const target = this.#clients.get(data.target)
      if (!target) return ws._serverSend({ type: 'error', message: `peer "${data.target}" not found` })
      target._serverSend({ type: 'relayed', source: ws.podId, envelope: data.envelope })
    }
  }
}

class FakeSignalingServer {
  #clients = new Map()
  connect() {}
  disconnect(ws) {
    if (ws.podId) {
      this.#clients.delete(ws.podId)
      for (const peer of this.#clients.values()) peer._serverSend({ type: 'peer-left', podId: ws.podId })
    }
  }
  receive(ws, data) {
    if (!ws.podId) {
      if (data.type !== 'register' || !data.podId) return
      ws.podId = data.podId
      this.#clients.set(data.podId, ws)
      ws._serverSend({ type: 'registered', podId: data.podId })
      ws._serverSend({ type: 'peers', peers: [...this.#clients.keys()] })
      for (const peer of this.#clients.values()) {
        if (peer !== ws) peer._serverSend({ type: 'peer-joined', podId: data.podId })
      }
    }
  }
}

function createFakeNetwork() {
  const registry = new Map()
  class FakeWebSocket extends FakeEventTarget {
    constructor(url) {
      super()
      this.url = url
      this.readyState = 0
      this.podId = null
      this._server = registry.get(url)
      queueMicrotask(() => {
        this.readyState = OPEN
        this._server.connect(this)
        this._dispatch('open', {})
      })
    }
    send(raw) {
      if (this.readyState !== OPEN) return
      const data = JSON.parse(raw)
      queueMicrotask(() => this.readyState === OPEN && this._server.receive(this, data))
    }
    _serverSend(data) {
      if (this.readyState !== OPEN) return
      queueMicrotask(() => this.readyState === OPEN && this._dispatch('message', { data: JSON.stringify(data) }))
    }
    close() {
      if (this.readyState === CLOSED) return
      this.readyState = CLOSED
      this._server.disconnect(this)
      this._dispatch('close', {})
    }
  }
  return { FakeWebSocket, registerServer: (url, server) => registry.set(url, server) }
}

// ── Wire up the fake relay + signaling servers ──────────────────────────

const net = createFakeNetwork()
net.registerServer('ws://relay.local/', new FakeRelayServer())
net.registerServer('ws://signaling.local/', new FakeSignalingServer())

function makeTransport(podId) {
  return new WebSocketTransport({
    url: 'ws://relay.local/',
    podId,
    WebSocket: net.FakeWebSocket,
    peersFromSignaling: true,
    signalingUrl: 'ws://signaling.local/',
  })
}

// ── Two independent Pods, each on its own WebSocketTransport ───────────

const alice = new Pod()
const bob = new Pod()

// Pod generates its own Ed25519 identity during boot(); WebSocketTransport
// needs to register with that same podId, so boot() is given the transport
// up front and discovery runs for real over it (same convention as
// example 02, just over a WebSocket-shaped adapter instead of
// EventEmitterTransport). We can't know the podId before boot() generates
// it, so we hand the transport a late-bound podId by generating identities
// first — mirroring how a real deployment would load/create one per pod.
const { PodIdentity } = await import('@johnhenry/browsermesh-primitives')
const aliceIdentity = await PodIdentity.generate()
const bobIdentity = await PodIdentity.generate()

const aliceTransport = makeTransport(aliceIdentity.podId)
const bobTransport = makeTransport(bobIdentity.podId)

// Sequential boot: alice fully registers (relay + signaling) first, so
// bob's signaling "peers" snapshot already includes her — bob's hello
// reaches alice point-to-point on the first try, exactly the way the
// issue's "spike path" is meant to work.
await alice.boot({ identity: aliceIdentity, transport: aliceTransport, discoveryTimeout: 150 })
await bob.boot({ identity: bobIdentity, transport: bobTransport, discoveryTimeout: 150 })

console.log('alice podId:', alice.podId, '| role:', alice.role)
console.log('bob podId:  ', bob.podId, '| role:', bob.role)

assert.ok(alice.peers.has(bob.podId), 'alice should have discovered bob over WebSocketTransport')
assert.ok(bob.peers.has(alice.podId), 'bob should have discovered alice over WebSocketTransport')
console.log('mutual discovery via WebSocketTransport + fake relay/signaling: ✓')

// ── Exchange one real message through the fake relay ────────────────────

const received = new Promise((resolve) => bob.on('message', resolve))
alice.send(bob.podId, { kind: 'greeting', text: 'hello from a hosted pod' })

const msg = await received
assert.equal(msg.from, alice.podId)
assert.equal(msg.to, bob.podId)
assert.deepEqual(msg.payload, { kind: 'greeting', text: 'hello from a hosted pod' })
console.log('bob received over the relay:', msg.payload)

await alice.shutdown()
await bob.shutdown()

console.log('ok: two Pods on WebSocketTransport discovered each other and exchanged a real message through a simulated relay')
