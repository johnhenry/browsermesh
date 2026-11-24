/**
 * wsh's remote-object layer (`@johnhenry/wsh/objects`) run over a protocol
 * channel (#272): the layer needs only a duplex of structured messages, a
 * channel is one. wsh is a dev/examples-only dependency of this repository and
 * is not imported by any published package; where it is not installed these
 * tests skip, saying why.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { network } from './helpers/rpc-network.mjs'
import { memoryChannelPair } from './helpers/counter-protocol.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { ChannelErrorCode } from '../src/mesh-channel.mjs'
import { createMeshProtocolService, protocolScope } from '../src/protocol-channel.mjs'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'

let wsh = null
try { wsh = await import('@johnhenry/wsh/objects') } catch { /* not installed: skipped below */ }
const skip = wsh ? false : 'the optional dev dependency @johnhenry/wsh (>= 0.46.0, exports ./objects) is not installed'
if (!wsh && process.env.REQUIRE_WSH_OBJECTS) throw new Error(`REQUIRE_WSH_OBJECTS is set but ${skip}`)

/** The whole glue: a protocol channel is the layer's duplex. */
function objectsPeerOver(channel) {
  const peer = wsh.createDuplexPeer({
    send: (message) => { channel.send(message).catch(() => peer.close('send failed')) },
    maxMessageBytes: channel.maxMessageBytes,
  })
  channel.onMessage((message) => peer.receive(message))
  channel.onClose(() => peer.close('channel closed'))
  return peer
}

function makeApp() {
  const app = {
    title: 'inbox',
    secret: 'nope',
    counter: { value: 3, inc(n = 1) { app.counter.value += n; return app.counter.value } },
    bytes: () => new Uint8Array(150_000).map((_, i) => i % 251),
  }
  return app
}
const allow = { get: ['app.title', 'app.counter.**'], call: ['app.counter.inc', 'app.bytes'], set: ['app.counter.value'] }

const actionOf = (kind) => (kind === 'set' ? 'set' : kind === 'call' || kind === 'construct' ? 'call' : 'get')

async function meshObjects({ authorizeLog } = {}) {
  const [alice, bob, eve] = await network()
  for (const node of [alice, bob, eve]) {
    node.registry = new PeerRegistry({ localPodId: node.podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: node.podId }) })
  }
  const a = attachService(alice, undefined, createMeshProtocolService())
  const b = attachService(bob, undefined, createMeshProtocolService())
  const e = attachService(eve, undefined, createMeshProtocolService())
  const app = makeApp()
  const roots = b.api.rootAuthorizer('objects', { actions: ['get', 'call', 'set'] })
  const server = wsh.createObjectsServer({
    roots: { app },
    mode: 'values',
    allow,
    authorize(who, op) {
      const allowed = roots.can(who.fingerprint, op.root, actionOf(op.kind))
      authorizeLog?.push({ who: who.fingerprint, kind: op.kind, text: op.text, allowed })
      return allowed
    },
  })
  b.api.serveProtocol('objects', (channel) => {
    server.attach(objectsPeerOver(channel), { who: { username: null, fingerprint: channel.peer } })
  })
  return { alice, bob, eve, a, b, e, app, teardown() { a.teardown(); b.teardown(); e.teardown() } }
}

test('wsh-objects over the mesh channel: read, call, bytes across several chunks, bounded snapshot', { skip }, async () => {
  const log = []
  const { alice, bob, a, app, teardown } = await meshObjects({ authorizeLog: log })
  try {
    bob.registry.grantCapabilities(alice.podId, [protocolScope('objects'), 'objects:app:get', 'objects:app:call'])
    const channel = await a.api.openProtocol(bob.podId, 'objects')
    const { app: remote } = await wsh.createObjectsClient(objectsPeerOver(channel))
    assert.equal(await remote.title, 'inbox')
    assert.equal(await remote.counter.inc(4), 7)
    assert.equal(app.counter.value, 7)
    const bytes = await remote.bytes()
    assert.ok(bytes instanceof Uint8Array)
    assert.equal(bytes.length, 150_000)
    assert.equal(bytes[1000], 1000 % 251)
    assert.deepEqual(await wsh.snapshot(remote.counter, { depth: 2 }), { value: 7 })
    // The layer was told who asked by the channel, never by a message.
    assert.ok(log.length >= 3 && log.every((entry) => entry.who === alice.podId))
  } finally { teardown() }
})

test('per-root scope: no set grant means no set, and the allow-list is checked before the hook', { skip }, async () => {
  const log = []
  const { alice, bob, a, app, teardown } = await meshObjects({ authorizeLog: log })
  try {
    bob.registry.grantCapabilities(alice.podId, [protocolScope('objects'), 'objects:app:get'])
    const channel = await a.api.openProtocol(bob.podId, 'objects')
    const { app: remote } = await wsh.createObjectsClient(objectsPeerOver(channel))
    assert.equal(await remote.title, 'inbox')
    await assert.rejects(async () => remote.counter.inc(), (e) => e.code === -32003) // objects:app:call not granted
    await assert.rejects(wsh.set(remote.counter, 'value', 99), (e) => e.code === -32003)
    assert.equal(app.counter.value, 3, 'nothing was changed')
    log.length = 0
    await assert.rejects(async () => remote.secret, (e) => e.code === -32003 && e.reason === 'not-allowed')
    assert.equal(log.length, 0, 'a path the allow-list does not name never reaches the authorize hook')
  } finally { teardown() }
})

test('revoking a root grant refuses the very next request; the protocol grant keeps the channel open', { skip }, async () => {
  const { alice, bob, a, b, teardown } = await meshObjects()
  try {
    bob.registry.grantCapabilities(alice.podId, [protocolScope('objects'), 'objects:app:get'])
    const channel = await a.api.openProtocol(bob.podId, 'objects')
    const { app: remote } = await wsh.createObjectsClient(objectsPeerOver(channel))
    assert.equal(await remote.title, 'inbox')
    bob.registry.revokeCapabilities(alice.podId, ['objects:app:get'])
    await assert.rejects(async () => remote.title, (e) => e.code === -32003)
    assert.deepEqual(b.api.openProtocols(alice.podId), ['objects'])
  } finally { teardown() }
})

test('a peer with no grant cannot open the protocol, and a peer with the protocol grant only sees nothing', { skip }, async () => {
  const { alice, bob, eve, a, e, teardown } = await meshObjects()
  try {
    await assert.rejects(e.api.openProtocol(bob.podId, 'objects'), { code: ChannelErrorCode.UNAUTHORIZED })
    bob.registry.grantCapabilities(alice.podId, [protocolScope('objects')])
    const channel = await a.api.openProtocol(bob.podId, 'objects')
    const { app: remote } = await wsh.createObjectsClient(objectsPeerOver(channel))
    await assert.rejects(async () => remote.title, (err) => err.code === -32003)
    void eve
  } finally { teardown() }
})

test('closing the channel fails the layer\'s pending requests', { skip }, async () => {
  const { alice, bob, a, teardown } = await meshObjects()
  try {
    bob.registry.grantCapabilities(alice.podId, [protocolScope('objects'), 'objects:app:get'])
    const channel = await a.api.openProtocol(bob.podId, 'objects')
    const { app: remote } = await wsh.createObjectsClient(objectsPeerOver(channel))
    assert.equal(await remote.title, 'inbox')
    channel.close()
    await assert.rejects(async () => remote.title)
  } finally { teardown() }
})

test('the same layer runs over a hand-written in-memory duplex that imports nothing from the mesh', { skip }, async () => {
  const { a, b } = memoryChannelPair('client-id', 'server-id')
  const app = makeApp()
  const seen = []
  const server = wsh.createObjectsServer({ roots: { app }, mode: 'values', allow, authorize: (who) => { seen.push(who.fingerprint); return true } })
  server.attach(objectsPeerOver(b), { who: { username: null, fingerprint: b.peer } })
  const { app: remote } = await wsh.createObjectsClient(objectsPeerOver(a))
  assert.equal(await remote.title, 'inbox')
  assert.equal(await remote.counter.inc(2), 5)
  assert.deepEqual(seen, ['client-id', 'client-id'])
})
