/**
 * wsh's remote-object layer (`@johnhenry/wsh/objects`, johnhenry/wsh#190) run
 * over a browsermesh protocol channel (#272).
 *
 * `wsh-objects` reaches an object graph by path (`app.cart.items`, `app.greet()`)
 * with an allow-list per operation, and knows nothing about wsh sessions: its
 * core needs only a duplex of structured messages. A protocol channel is
 * exactly that, so the layer rides it unchanged:
 *
 *   bob serves the protocol `objects` (opening it needs `protocol:objects:open`),
 *   and exposes one root, `app`, to peers granted `objects:app:<action>`;
 *   alice opens it and reads, calls and snapshots; her `set` is refused because
 *   she was not granted it; a path the allow-list does not name is refused by
 *   the layer itself; eve, who was granted nothing, cannot open the protocol;
 *   and revoking alice's grant refuses her very next request.
 *
 * Who is asking is the channel's verified peer (the key the session is bound
 * to), handed to the layer as `who.fingerprint`; it is never read from a
 * message. wsh is an example-only dependency here: nothing in a published
 * package imports it.
 *
 * As in the other examples the link is a simulated in-process bus.
 */
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import {
  attachService, createMeshProtocolService, PeerRegistry, protocolScope, ChannelErrorCode,
} from '@johnhenry/browsermesh-apps'
import { createObjectsServer, createObjectsClient, createDuplexPeer } from '@johnhenry/wsh/objects'

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

// ── the glue: a protocol channel as the layer's duplex ──────────────────────
// `send` / `onMessage` / `onClose` / `maxMessageBytes` are the whole interface.
function objectsPeerOver(channel) {
  const peer = createDuplexPeer({
    send: (message) => { channel.send(message).catch(() => peer.close('send failed')) },
    maxMessageBytes: channel.maxMessageBytes,
  })
  channel.onMessage((message) => peer.receive(message))
  channel.onClose(() => peer.close('channel closed'))
  return peer
}

// ── bob: the objects he exposes, and who may do what ────────────────────────
const app = {
  title: 'inbox',
  secret: 'not for the wire',
  counter: { value: 3, inc(n = 1) { app.counter.value += n; return app.counter.value } },
  greet: (name) => `hello ${name}`,
  blob: () => new Uint8Array(200_000).fill(7), // larger than one message of the link
}
const seen = []
// Per-root scopes `objects:<root>:<action>`, backed by bob's registry.
const roots = bob.api.rootAuthorizer('objects', { actions: ['get', 'call', 'set'] })
const objects = createObjectsServer({
  roots: { app },
  mode: 'values',
  allow: { get: ['app.title', 'app.counter.**', 'app.blob'], call: ['app.counter.inc', 'app.greet', 'app.blob'], set: ['app.counter.value'] },
  // Asked for every operation the allow-list let through: the per-root scope of the verified peer.
  authorize(who, op) {
    const action = op.kind === 'set' ? 'set' : op.kind === 'call' || op.kind === 'construct' ? 'call' : 'get'
    const allowed = roots.can(who.fingerprint, op.root, action)
    seen.push(`${op.kind} ${op.text} by ${who.fingerprint === aliceNode.podId ? 'alice' : 'someone'}: ${allowed ? 'ok' : 'refused'}`)
    return allowed
  },
})
bob.api.serveProtocol('objects', (channel) => {
  // `who` is the channel's verified peer, not a field of any message.
  objects.attach(objectsPeerOver(channel), { who: { username: null, fingerprint: channel.peer } })
})
bobNode.registry.grantCapabilities(aliceNode.podId, [protocolScope('objects'), ...roots.scopes('app', ['get', 'call'])])

// ── alice ────────────────────────────────────────────────────────────────────
const channel = await alice.api.openProtocol(bobNode.podId, 'objects')
const { app: remote } = await createObjectsClient(objectsPeerOver(channel))

assert.equal(await remote.title, 'inbox')
assert.equal(await remote.counter.inc(4), 7)
assert.equal(await remote.greet('bob'), 'hello bob')
console.log('alice read app.title, called app.counter.inc(4) -> 7 and app.greet(): allowed by her objects:app:get / call grants')

const blob = await remote.blob()
assert.ok(blob instanceof Uint8Array && blob.length === 200_000)
console.log('alice received a 200000-byte result: the link carried it in chunks, the layer never saw them')

// She has no `set` grant, so the layer's authorize hook refuses it ...
const { set, snapshot } = await import('@johnhenry/wsh/objects')
await assert.rejects(set(remote.counter, 'value', 99), /refused|authori/i)
assert.equal(app.counter.value, 7)
console.log('alice tried to set app.counter.value: refused (no objects:app:set)')
// ... and a path the allow-list does not name never reaches the hook.
await assert.rejects(async () => remote.secret, /not allowed|refused/i)
assert.ok(!seen.some((line) => line.includes('app.secret')))
console.log('alice tried app.secret: refused by the allow-list, the hook was not even asked')
console.log('a bounded snapshot:', JSON.stringify(await snapshot(remote.counter, { depth: 2 })))

// ── eve was granted nothing: she cannot even open the protocol ──────────────
await assert.rejects(eve.api.openProtocol(bobNode.podId, 'objects'), { code: ChannelErrorCode.UNAUTHORIZED })
console.log('eve could not open the protocol (default deny)')

// ── revocation applies to the next request ──────────────────────────────────
bobNode.registry.revokeCapabilities(aliceNode.podId, roots.scopes('app', ['get', 'call']))
await assert.rejects(async () => remote.title, /refused|authori/i)
console.log('bob revoked her grants: her next request was refused')

channel.close()
alice.teardown(); bob.teardown(); eve.teardown()
console.log('ok: wsh-objects ran over a browsermesh protocol channel, authorised per root for the verified peer')
