/**
 * protocol-channel: named, authorised protocol channels over a mesh-channel
 * link, and a tiny layered protocol (a remote counter) that is written against
 * only the interface and run over the mesh, over a bare in-memory core duplex
 * and over a hand-written duplex with no mesh code at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { network } from './helpers/rpc-network.mjs'
import { fakeClock } from './helpers/fake-clock.mjs'
import { makeCounter, serveCounter, counterClient, runCounterScenario, memoryChannelPair } from './helpers/counter-protocol.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { createChannelCore, ChannelErrorCode } from '../src/mesh-channel.mjs'
import {
  createMeshProtocolService, createProtocolHost, assertProtocolChannel, protocolScope,
  PROTOCOL_OPEN_METHOD,
} from '../src/protocol-channel.mjs'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }

function registryFor(node) {
  const registry = new PeerRegistry({ localPodId: node.podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: node.podId }) })
  node.registry = registry
  return registry
}

async function meshPair(options = {}) {
  const [alice, bob, eve] = await network()
  const regA = registryFor(alice), regB = registryFor(bob)
  const a = attachService(alice, undefined, createMeshProtocolService(options.a))
  const b = attachService(bob, undefined, createMeshProtocolService(options.b))
  return { alice, bob, eve, regA, regB, a, b, teardown() { a.teardown(); b.teardown() } }
}

// ---------------------------------------------------------------- the seam

test('the counter protocol runs over the mesh with per-protocol authorisation', async () => {
  const { alice, bob, regB, a, b, teardown } = await meshPair()
  try {
    const counter = makeCounter(), seen = []
    b.api.serveProtocol('counter', ch => serveCounter(ch, counter, { seen }))
    regB.grantCapabilities(alice.podId, [protocolScope('counter')])
    const client = await a.api.openProtocol(bob.podId, 'counter')
    assertProtocolChannel(client)
    assert.equal(client.peer, bob.podId)
    await runCounterScenario({ client, counter, settle: flush, assert, seen, clientPeer: alice.podId })
  } finally { teardown() }
})

test('the same counter protocol runs over a bare in-memory duplex (no mesh service, no registry)', async () => {
  const fromTo = {}
  const make = (name, other) => {
    const core = createChannelCore({ peer: other, sendFrame: f => { queueMicrotask(() => fromTo[other].core.receive(structuredClone(f))) } })
    const host = createProtocolHost({ authorize: () => true })
    fromTo[name] = { core, host }
    host.attach(core.link)
    return fromTo[name]
  }
  const A = make('alice', 'bob'), B = make('bob', 'alice')
  const counter = makeCounter(), seen = []
  B.host.serveProtocol('counter', ch => serveCounter(ch, counter, { seen }))
  await Promise.all([A.core.open(), B.core.open()])
  const client = await A.host.openProtocol(A.core.link, 'counter')
  assertProtocolChannel(client)
  await runCounterScenario({ client, counter, settle: flush, assert, seen, clientPeer: 'alice' })
})

test('the same counter protocol runs over a hand-written duplex that imports nothing from the mesh', async () => {
  const { a, b } = memoryChannelPair('client-id', 'server-id')
  assertProtocolChannel(a); assertProtocolChannel(b)
  const counter = makeCounter(), seen = []
  serveCounter(b, counter, { seen })
  await runCounterScenario({ client: a, counter, settle: flush, assert, seen, clientPeer: 'client-id' })
})

test('assertProtocolChannel rejects objects that are not channels', () => {
  assert.throws(() => assertProtocolChannel(null), TypeError)
  assert.throws(() => assertProtocolChannel({ peer: 'x', maxMessageBytes: 1 }), /missing/)
  const { a } = memoryChannelPair()
  assert.throws(() => assertProtocolChannel({ ...a, peer: '' }), /peer/)
  assert.throws(() => assertProtocolChannel({ ...a, maxMessageBytes: 0 }), /maxMessageBytes/)
})

// ------------------------------------------------------------ authorisation

test('default deny: with no grant a peer can neither open nor discover a protocol', async () => {
  const { bob, a, b, teardown } = await meshPair()
  try {
    let served = 0
    b.api.serveProtocol('counter', () => { served++ })
    await assert.rejects(a.api.openProtocol(bob.podId, 'counter'), { code: ChannelErrorCode.UNAUTHORIZED })
    assert.deepEqual(await a.api.listProtocols(bob.podId), [])
    await assert.rejects(a.api.openProtocol(bob.podId, 'nothing-here'), { code: ChannelErrorCode.UNAUTHORIZED }) // does not reveal what is served
    assert.equal(served, 0)
  } finally { teardown() }
})

test('scopes are per protocol and use the registry wildcards', async () => {
  const { alice, bob, regB, a, b, teardown } = await meshPair()
  try {
    for (const name of ['counter', 'files']) b.api.serveProtocol(name, () => {}, { versions: [1, 2] })
    regB.grantCapabilities(alice.podId, ['protocol:counter:open'])
    assert.equal((await a.api.openProtocol(bob.podId, 'counter')).name, 'counter')
    await assert.rejects(a.api.openProtocol(bob.podId, 'files'), { code: ChannelErrorCode.UNAUTHORIZED })
    assert.deepEqual((await a.api.listProtocols(bob.podId)).map(p => p.name), ['counter'])
    regB.grantCapabilities(alice.podId, ['protocol:*:open'])
    assert.equal((await a.api.openProtocol(bob.podId, 'files')).name, 'files')
    assert.deepEqual((await a.api.listProtocols(bob.podId)).map(p => p.name).sort(), ['counter', 'files'])
  } finally { teardown() }
})

test('the open scope is `protocol:<name>:open`, and names cannot smuggle scope syntax', async () => {
  assert.equal(protocolScope('counter'), 'protocol:counter:open')
  for (const bad of ['a:b', '*', '', 'A', 'x'.repeat(65), 'a/b', 'has space']) assert.throws(() => protocolScope(bad), TypeError)
  const { bob, a, b, teardown } = await meshPair()
  try {
    assert.throws(() => b.api.serveProtocol('a:b', () => {}), TypeError)
    await assert.rejects(a.api.openProtocol(bob.podId, '*'), TypeError)
  } finally { teardown() }
})

test('revoking the scope closes an open channel (and it cannot be used afterwards)', async () => {
  const { alice, bob, regB, a, b, teardown } = await meshPair()
  try {
    const counter = makeCounter(), served = deferred()
    b.api.serveProtocol('counter', ch => { serveCounter(ch, counter); served.resolve(ch) })
    regB.grantCapabilities(alice.podId, ['protocol:counter:open'])
    const client = await a.api.openProtocol(bob.podId, 'counter')
    const c = counterClient(client)
    assert.equal(await c.get('value'), 0)
    const server = await served.promise
    const closed = deferred(); server.onClose(() => closed.resolve())
    regB.revokeCapabilities(alice.podId, ['protocol:counter:open'])
    await assert.rejects(c.get('value'))
    await closed.promise
    assert.deepEqual(b.api.openProtocols(alice.podId), [])
    await assert.rejects(a.api.openProtocol(bob.podId, 'counter'), { code: ChannelErrorCode.UNAUTHORIZED })
  } finally { teardown() }
})

test('an idle open channel is closed the moment its scope is revoked or expires, not on its next use', async () => {
  const clock = fakeClock()
  const [alice, bob, eve] = await network()
  const regB = new PeerRegistry({ localPodId: bob.podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: bob.podId }), clock })
  bob.registry = regB
  registryFor(alice)
  const a = attachService(alice, undefined, createMeshProtocolService())
  const b = attachService(bob, undefined, createMeshProtocolService())
  try {
    const served = []
    b.api.serveProtocol('counter', ch => { serveCounter(ch, makeCounter()); served.push(ch) })
    regB.grantCapabilities(alice.podId, ['protocol:counter:open'])
    regB.grantCapabilities(eve.podId, ['protocol:counter:open'])
    await a.api.openProtocol(bob.podId, 'counter')
    await flush()
    assert.equal(served.length, 1)
    assert.deepEqual(b.api.openProtocols(alice.podId), ['counter'])

    // Somebody else's grant ending does not touch alice's channel.
    regB.revokeCapabilities(eve.podId, ['protocol:counter:open'])
    await flush()
    assert.deepEqual(b.api.openProtocols(alice.podId), ['counter'])

    // Alice's own revocation closes it without alice sending anything.
    regB.revokeCapabilities(alice.podId, ['protocol:counter:open'])
    await flush()
    assert.deepEqual(b.api.openProtocols(alice.podId), [])
    assert.equal(served[0].closed, true)

    // And so does expiry.
    regB.grantCapabilities(alice.podId, ['protocol:counter:open'], { expiresAt: clock.now() + 1000 })
    await a.api.openProtocol(bob.podId, 'counter')
    await flush()
    assert.deepEqual(b.api.openProtocols(alice.podId), ['counter'])
    clock.advance(1000)
    await flush()
    assert.deepEqual(b.api.openProtocols(alice.podId), [])
  } finally { a.teardown(); b.teardown() }
})

test('a registry-less node authorises nothing, and an authorize hook can replace the registry', async () => {
  const [alice, bob] = await network()
  const a = attachService(alice, undefined, createMeshProtocolService())
  const b = attachService(bob, undefined, createMeshProtocolService()) // no registry on the node
  const c = attachService(bob, undefined, { name: 'x', attach: () => () => {} })
  try {
    b.api.serveProtocol('counter', () => {})
    await assert.rejects(a.api.openProtocol(bob.podId, 'counter'), { code: ChannelErrorCode.UNAUTHORIZED })
  } finally { a.teardown(); b.teardown(); c.teardown() }
  const [alice2, bob2] = await network()
  const calls = []
  const a2 = attachService(alice2, undefined, createMeshProtocolService())
  const b2 = attachService(bob2, undefined, createMeshProtocolService({ authorize: (peer, name, action) => { calls.push([peer, name, action]); return peer === alice2.podId } }))
  try {
    b2.api.serveProtocol('counter', () => {})
    assert.equal((await a2.api.openProtocol(bob2.podId, 'counter')).name, 'counter')
    assert.deepEqual(calls[0], [alice2.podId, 'counter', 'open'])
  } finally { a2.teardown(); b2.teardown() }
})

// --------------------------------------------------- protocol channel basics

test('protocols are isolated: methods of one are unreachable through another or before opening', async () => {
  const { alice, bob, regB, a, b, teardown } = await meshPair()
  try {
    const counter = makeCounter()
    b.api.serveProtocol('counter', ch => serveCounter(ch, counter))
    b.api.serveProtocol('other', ch => ch.onRequest('ping', () => 'pong'))
    regB.grantCapabilities(alice.podId, ['protocol:*:open'])
    const link = await a.api.channel.open(bob.podId)
    await assert.rejects(link.request('counter/get', { path: 'value' }), { code: ChannelErrorCode.METHOD_NOT_FOUND }) // not opened yet
    const other = await a.api.openProtocol(bob.podId, 'other')
    assert.equal(await other.request('ping'), 'pong')
    await assert.rejects(other.request('get', { path: 'value' }), { code: ChannelErrorCode.METHOD_NOT_FOUND })
    await assert.rejects(link.request('counter/get', { path: 'value' }), { code: ChannelErrorCode.METHOD_NOT_FOUND })
  } finally { teardown() }
})

test('discovery lists served protocols with versions; the opener and server agree on the highest common version', async () => {
  const { alice, bob, regB, a, b, teardown } = await meshPair()
  try {
    const versions = []
    b.api.serveProtocol('counter', (ch, { version }) => versions.push(version), { versions: [1, 2, 3] })
    regB.grantCapabilities(alice.podId, ['protocol:counter:open'])
    assert.deepEqual(await a.api.listProtocols(bob.podId), [{ name: 'counter', versions: [1, 2, 3] }])
    const c = await a.api.openProtocol(bob.podId, 'counter', { versions: [2, 9] })
    assert.equal(c.version, 2)
    const c2 = await a.api.openProtocol(bob.podId, 'counter', { versions: [1] }).catch(e => e)
    assert.equal(c2.reason, 'already-open') // one channel per name per link
    c.close()
    await flush()
    await assert.rejects(a.api.openProtocol(bob.podId, 'counter', { versions: [7] }), { code: ChannelErrorCode.UNSUPPORTED })
    assert.deepEqual(versions, [2])
  } finally { teardown() }
})

test('an authorised open of a protocol that is not served is -32601', async () => {
  const { alice, bob, regB, a, teardown } = await meshPair()
  try {
    regB.grantCapabilities(alice.podId, ['protocol:ghost:open'])
    await assert.rejects(a.api.openProtocol(bob.podId, 'ghost'), { code: ChannelErrorCode.METHOD_NOT_FOUND, reason: 'unknown-protocol' })
  } finally { teardown() }
})

test('both sides can request and notify over one named channel; the server may speak first when the opener uses setup()', async () => {
  const { alice, bob, regB, a, b, teardown } = await meshPair()
  try {
    b.api.serveProtocol('chat', async ch => {
      // Speaks first: the opener registered its handler in setup().
      assert.equal(await ch.request('welcome', { to: ch.peer }), 'hi bob')
      await ch.notify('tick', new Uint8Array([9]))
      ch.onRequest('echo', p => p)
    })
    regB.grantCapabilities(alice.podId, ['protocol:chat:open'])
    const ticks = []
    const ch = await a.api.openProtocol(bob.podId, 'chat', {
      setup(c) { c.onRequest('welcome', ({ to }) => { assert.equal(to, alice.podId); return 'hi bob' }); c.onNotification('tick', p => ticks.push(p)) },
    })
    await flush()
    assert.deepEqual(ticks, [new Uint8Array([9])])
    assert.deepEqual(await ch.request('echo', { bytes: new Uint8Array([1, 2]) }), { bytes: new Uint8Array([1, 2]) })
  } finally { teardown() }
})

test('raw messages are demultiplexed by protocol and carry the verified peer', async () => {
  const { alice, bob, regB, a, b, teardown } = await meshPair()
  try {
    const got = { one: [], two: [] }
    for (const name of ['one', 'two']) b.api.serveProtocol(name, ch => ch.onMessage((m, ctx) => { got[name].push([m, ctx.peer]) }))
    regB.grantCapabilities(alice.podId, ['protocol:*:open'])
    const one = await a.api.openProtocol(bob.podId, 'one'), two = await a.api.openProtocol(bob.podId, 'two')
    await one.send({ n: 1, b: new Uint8Array([1]) }); await two.send('x'); await one.send(2)
    await flush()
    assert.deepEqual(got.one.map(r => r[1]), [alice.podId, alice.podId])
    assert.deepEqual(got.two, [['x', alice.podId]])
    assert.ok(one.maxMessageBytes > 0 && one.maxMessageBytes < 1 << 20)
  } finally { teardown() }
})

test('closing a channel closes the other end; closing the link closes every channel', async () => {
  const { alice, bob, regB, a, b, teardown } = await meshPair()
  try {
    const servers = []
    for (const name of ['one', 'two']) b.api.serveProtocol(name, ch => { servers.push(ch) })
    regB.grantCapabilities(alice.podId, ['protocol:*:open'])
    const one = await a.api.openProtocol(bob.podId, 'one'), two = await a.api.openProtocol(bob.podId, 'two')
    await flush()
    const closedOne = deferred(), closedTwo = deferred()
    servers[0].onClose(() => closedOne.resolve()); two.onClose(() => closedTwo.resolve())
    one.close()
    await closedOne.promise
    await assert.rejects(one.request('x'), { reason: 'channel-closed' })
    a.api.channel.link(bob.podId).close()
    await closedTwo.promise
    assert.equal(two.closed, true)
  } finally { teardown() }
})

test('a peer that does not support protocols answers the open with an error, and a peer without the channel is refused cleanly', async () => {
  const [alice, bob, oldPeer] = await network()
  registryFor(alice); registryFor(bob)
  const a = attachService(alice, undefined, createMeshProtocolService({ handshakeTimeoutMs: 25 }))
  const { createMeshChannelService } = await import('../src/mesh-channel.mjs')
  const plain = attachService(bob, undefined, createMeshChannelService()) // channel only: no protocol host
  try {
    await assert.rejects(a.api.openProtocol(bob.podId, 'counter'), { code: ChannelErrorCode.METHOD_NOT_FOUND })
    await assert.rejects(a.api.openProtocol(oldPeer.podId, 'counter'), { reason: 'unsupported' })
  } finally { a.teardown(); plain.teardown() }
})

test('the open method name is part of the documented wire', () => {
  assert.equal(PROTOCOL_OPEN_METHOD, 'mesh.protocol.open')
})
