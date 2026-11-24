/**
 * Two pods linked over wsh: a mesh link that is key-authenticated in both
 * directions and sealed end to end, through a relay that can read nothing and
 * forge nothing.
 *
 * What a plain relayed link lacks and a wsh link has:
 *   - the pod id a peer claims is the hash of the key wsh authenticated, and the
 *     dialler pins the host key to the pod id it meant to reach;
 *   - the listening pod decides who may link (an `authorize` callback, default
 *     deny) before any mesh frame;
 *   - after login the whole session is sealed: the relay copies ciphertext, and a
 *     byte it flips ends the link instead of reaching the pod.
 *
 * The relay here is wsh's real pipe relay (`@johnhenry/wsh/pipe-relay`) running in
 * this process (`createInProcessPipeRelay`), so the example needs no network, but
 * the handshake, the key login and the sealed session are the real thing (the
relay is imported from `@johnhenry/browsermesh-transport/wsh-in-process`, a
subpath kept out of the main entry). Needs
 * the optional peer `@johnhenry/wsh`, which this monorepo installs for its tests.
 *
 * See docs/design/wsh-peer-link.md.
 */

import assert from 'node:assert/strict'
import { Pod } from '@johnhenry/browsermesh-pod'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { WshPodTransport } from '@johnhenry/browsermesh-transport'
import { createInProcessPipeRelay } from '@johnhenry/browsermesh-transport/wsh-in-process'

const RELAY = 'wss://relay.example' // never dialled: the in-process relay answers
const relay = await createInProcessPipeRelay()

async function until(fn, what, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

// ── Three pods. Alice and Bob trust each other; Mallory is nobody's friend. ──

const [alice, bob, mallory] = await Promise.all([PodIdentity.generate(), PodIdentity.generate(), PodIdentity.generate()])
const links = (identity, trusted, extra = {}) => new WshPodTransport({
  identity,
  relays: [RELAY],
  WebSocket: relay.WebSocket,
  authorize: (peer) => trusted.includes(peer.podId), // who may link to this pod; default is nobody
  ...extra,
})

const aliceTransport = links(alice, [bob.podId])
const bobTransport = links(bob, [alice.podId], { peers: [alice.podId], awaitPeers: true })

const podA = new Pod()
const podB = new Pod()
const inbox = { a: [], b: [] }
podA.on('message', (m) => inbox.a.push(m))
podB.on('message', (m) => inbox.b.push(m))

// Alice boots first and waits at her rendezvous id; Bob dials her, then they say hello.
await podA.boot({ identity: alice, transport: aliceTransport, discoveryTimeout: 50 })
await podB.boot({ identity: bob, transport: bobTransport, discoveryTimeout: 50 })
await until(() => podA.peers.has(bob.podId) && podB.peers.has(alice.podId), 'the pods to discover each other')
console.log('alice and bob linked over wsh and discovered each other ✓')

// ── Messages both ways. The sender is the key the session authenticated. ──

const MARKER = `secret-${crypto.randomUUID()}`
podA.send(bob.podId, { note: MARKER })
podB.send(alice.podId, { note: 'got it' })
await until(() => inbox.b.length === 1 && inbox.a.length === 1, 'both messages')
assert.equal(inbox.b[0].from, alice.podId)
assert.equal(inbox.b[0].payload.note, MARKER)
assert.equal(inbox.a[0].from, bob.podId)
console.log('messages delivered both ways, `from` = the authenticated key ✓')

// ── The relay carried every byte and read none of it. ──

const wire = Buffer.concat(relay.recorded.map((r) => Buffer.from(r.bytes)))
assert.ok(wire.length > 0)
assert.equal(wire.includes(Buffer.from(MARKER)), false)
console.log(`the relay copied ${wire.length} bytes and none of them contain the message ✓`)

// ── A pod that is not trusted is turned away before any mesh frame. ──

const malloryTransport = links(mallory, [], { reconnect: { maxAttempts: 0 } })
await malloryTransport.open()
await assert.rejects(malloryTransport.links.connect(bob.podId), (e) => e.code === 'WSH_REFUSED')
assert.equal(inbox.b.length, 1, 'bob heard nothing from mallory')
console.log('mallory (not authorized) refused: WSH_REFUSED ✓')

// ── A relay that tampers cannot get anything past the seal. ──

let flipped = false
relay.tap = ({ to, bytes }) => {
  if (to !== 'host' || flipped) return undefined
  flipped = true
  const copy = bytes.slice()
  copy[copy.length >> 1] ^= 1 // one bit, inside the sealed frame
  return copy
}
const aliceSaw = []
aliceTransport.on('peer-down', (e) => aliceSaw.push(e.reason))
podB.send(alice.podId, { note: 'forged?' })
await until(() => aliceSaw.length > 0, 'the link to end')
assert.equal(aliceSaw[0], 'seal-failed')
assert.equal(inbox.a.length, 1, 'the tampered message never reached alice')
console.log('a relay that flipped one bit ended the link; nothing forged was delivered ✓')

await malloryTransport.close()
await podB.shutdown({ silent: true })
await podA.shutdown({ silent: true })
await relay.close()
console.log('ok: a mesh link over wsh is authenticated both ways and sealed against the relay')
