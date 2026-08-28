/**
 * Two Pods boot, discover each other over a shared transport, and exchange
 * a direct message.
 *
 * `Pod` is the base execution-context class from browsermesh-pod: identity,
 * discovery, and peer messaging in one 6-phase boot sequence. In a browser
 * it auto-detects BroadcastChannel; here, in Node, we hand it an explicit
 * `EventEmitterTransport` (an in-process pub/sub bus) so the example runs
 * with no network and no browser globals. Passing only `transport` (no
 * `discovery`) still exercises the real discovery protocol — `boot()`
 * builds a `TransportDiscovery` over it automatically and runs the actual
 * HELLO / HELLO_ACK handshake, not a stub.
 */

import assert from 'node:assert/strict'
import { Pod, EventEmitterTransport } from '@johnhenry/browsermesh-pod'

// A shared in-process bus stands in for a real transport (WebSocket relay,
// BroadcastChannel, etc.) — each pod gets its own transport instance bound
// to the same bus, exactly like two browser tabs would each get their own
// BroadcastChannel handle to the same channel name.
const bus = EventEmitterTransport.createBus()

const alice = new Pod()
const bob = new Pod()

await alice.boot({ transport: new EventEmitterTransport(bus), discoveryTimeout: 200 })
await bob.boot({ transport: new EventEmitterTransport(bus), discoveryTimeout: 200 })

console.log('alice podId:', alice.podId, '| role:', alice.role)
console.log('bob podId:  ', bob.podId, '| role:', bob.role)

// Real discovery, not a fixture — each pod's peer map was populated by the
// HELLO/HELLO_ACK exchange that ran during boot().
assert.ok(alice.peers.has(bob.podId), 'alice should have discovered bob')
assert.ok(bob.peers.has(alice.podId), 'bob should have discovered alice')
console.log('mutual discovery via HELLO/HELLO_ACK: ✓')

// ── Direct messaging ─────────────────────────────────────────────────

const received = new Promise((resolve) => {
  bob.on('message', (msg) => resolve(msg))
})

alice.send(bob.podId, { kind: 'greeting', text: 'hello from alice' })

const msg = await received
assert.equal(msg.from, alice.podId)
assert.equal(msg.to, bob.podId)
assert.deepEqual(msg.payload, { kind: 'greeting', text: 'hello from alice' })
console.log('bob received:', msg.payload)

await alice.shutdown()
await bob.shutdown()

console.log('ok: two independently-booted Pods discovered each other and exchanged a real message')
