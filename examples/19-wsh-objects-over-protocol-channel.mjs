/**
 * wsh's remote-object layer (`@johnhenry/wsh/objects`, johnhenry/wsh#190) run
 * over a browsermesh protocol channel (#272) with `@johnhenry/browsermesh-objects`.
 *
 * `wsh-objects` reaches an object graph by path (`app.cart.items`, `app.greet()`)
 * with an allow-list per operation, and knows nothing about wsh sessions: its
 * core needs only a duplex of structured messages. A protocol channel is
 * exactly that, and the adapter package does the rest:
 *
 *   bob serves the protocol `objects` (opening it needs `protocol:objects:open`)
 *   and exposes one root, `app`, to peers granted `objects:app:<action>`, each
 *   operation by its OWN action: get, call, set and on (a subscription);
 *   alice opens it and reads, calls and snapshots; her `set` is refused because
 *   she was not granted it, and so is a subscription (`on` is not `get`);
 *   a path the allow-list does not name is refused by the layer itself;
 *   eve, who was granted nothing, cannot open the protocol; and revoking
 *   alice's grant refuses her very next request.
 *
 * Who is asking is the channel's verified peer (the key the session is bound
 * to); it is never read from a message. wsh is a peer dependency of the
 * adapter package and a development dependency of this repository.
 *
 * As in the other examples the link is a simulated in-process bus.
 */
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import {
  attachService, createMeshProtocolService, PeerRegistry, protocolScope, ChannelErrorCode,
} from '@johnhenry/browsermesh-apps'
import { exposeObjectsOnMesh, openObjectsOnMesh } from '@johnhenry/browsermesh-objects'
import { set, snapshot, on } from '@johnhenry/wsh/objects'

// ── a simulated bus of three peers ──────────────────────────────────────────
async function createNodes(count) {
  const nodes = new Map()
  for (let i = 0; i < count; i++) {
    const { podId } = await PodIdentity.generate()
    const listeners = new Set()
    const node = {
      podId,
      listeners,
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo(to, data) {
        const target = nodes.get(to)
        if (!target) throw new Error('unreachable peer')
        const text = JSON.stringify(data) // a real transport carries JSON text
        queueMicrotask(() => { for (const cb of target.listeners) cb(podId, text) })
      },
    }
    nodes.set(podId, node)
  }
  return [...nodes.values()]
}
const [aliceNode, bobNode, eveNode] = await createNodes(3)
for (const node of [aliceNode, bobNode, eveNode]) {
  node.registry = new PeerRegistry({ localPodId: node.podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: node.podId }) })
}
const alice = attachService(aliceNode, undefined, createMeshProtocolService())
const bob = attachService(bobNode, undefined, createMeshProtocolService())
const eve = attachService(eveNode, undefined, createMeshProtocolService())

// ── bob: the objects he exposes, and who may do what ────────────────────────
const handlers = new Set()
const app = {
  title: 'inbox',
  secret: 'not for the wire',
  counter: { value: 3, inc(n = 1) { app.counter.value += n; return app.counter.value } },
  greet: (name) => `hello ${name}`,
  blob: () => new Uint8Array(200_000).fill(7), // larger than one message of the link
  bus: { on: (type, fn) => handlers.add(fn), off: (type, fn) => handlers.delete(fn) }, // an event source
}
// Two authorisations apply to every operation: these allow-lists (what bob offers, by path), then the
// registry grant of the channel's verified peer, `objects:<root>:<action>` for that operation's own action.
const objects = exposeObjectsOnMesh(bob, {
  roots: { app },
  allow: {
    get: ['app.title', 'app.counter.**', 'app.blob'],
    call: ['app.counter.inc', 'app.greet', 'app.blob'],
    set: ['app.counter.value'],
    on: ['app.bus@news'],
  },
  // A grant that is revoked or expires ends what it allowed, at once.
  watch: bobNode.registry.onAccessChange.bind(bobNode.registry),
})
bobNode.registry.grantCapabilities(aliceNode.podId, [protocolScope('objects'), ...objects.authorizer.scopes('app', ['get', 'call'])])

// ── alice ────────────────────────────────────────────────────────────────────
const { roots, channel } = await openObjectsOnMesh(alice, bobNode.podId)
const remote = roots.app

assert.equal(await remote.title, 'inbox')
assert.equal(await remote.counter.inc(4), 7)
assert.equal(await remote.greet('bob'), 'hello bob')
console.log('alice read app.title, called app.counter.inc(4) -> 7 and app.greet(): allowed by her objects:app:get / call grants')

const blob = await remote.blob()
assert.ok(blob instanceof Uint8Array && blob.length === 200_000)
console.log('alice received a 200000-byte result: the link carried it in chunks, the layer never saw them')

// She has no `set` grant, so the host refuses it ...
await assert.rejects(set(remote.counter, 'value', 99), /refused|authori/i)
assert.equal(app.counter.value, 7)
console.log('alice tried to set app.counter.value: refused (no objects:app:set)')
// ... and a subscription is its own action: `get` does not buy `on`.
await assert.rejects(on(remote.bus, 'news', () => {}), /refused|authori/i)
assert.equal(handlers.size, 0)
console.log('alice tried to subscribe to app.bus news: refused (objects:app:get is not objects:app:on)')
// ... and a path the allow-list does not name is refused by the layer itself.
await assert.rejects(async () => remote.secret, /not allowed|refused/i)
console.log('alice tried app.secret: refused by the allow-list')
console.log('a bounded snapshot:', JSON.stringify(await snapshot(remote.counter, { depth: 2 })))

// ── with an `on` grant she may subscribe, and revoking it ends the subscription ──
bobNode.registry.grantCapabilities(aliceNode.podId, objects.authorizer.scopes('app', ['on']))
const heard = []
await on(remote.bus, 'news', (data) => heard.push(data.args[0]))
for (const fn of [...handlers]) fn('first')
while (heard.length < 1) await new Promise((resolve) => setImmediate(resolve))
console.log('alice, granted objects:app:on, heard the event:', heard[0])
bobNode.registry.revokeCapabilities(aliceNode.podId, objects.authorizer.scopes('app', ['on']))
while (objects.sessions() > 0) await new Promise((resolve) => setImmediate(resolve))
assert.equal(handlers.size, 0)
console.log('bob revoked objects:app:on: the session ended at once and the listener left his event source')

// ── eve was granted nothing: she cannot even open the protocol ──────────────
await assert.rejects(eve.api.openProtocol(bobNode.podId, 'objects'), { code: ChannelErrorCode.UNAUTHORIZED })
console.log('eve could not open the protocol (default deny)')

channel.close()
objects.stop()
alice.teardown(); bob.teardown(); eve.teardown()
console.log('ok: wsh-objects ran over a browsermesh protocol channel, authorised per root and per action for the verified peer')
