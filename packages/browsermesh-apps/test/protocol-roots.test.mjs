/**
 * protocol-roots: per-root authorisation for layered protocols. A protocol
 * that exposes several named roots (`objects:<root>:get|call|set`) asks the
 * registry about the root a request names, for the peer the channel is bound
 * to, on every request.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { network } from './helpers/rpc-network.mjs'
import { fakeClock } from './helpers/fake-clock.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { ChannelErrorCode, MeshChannelError } from '../src/mesh-channel.mjs'
import { createMeshProtocolService, protocolScope } from '../src/protocol-channel.mjs'
import { createRootAuthorizer, rootScope } from '../src/protocol-roots.mjs'
import { createStreamLayer } from '../src/protocol-stream.mjs'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }

function registryFor(node, clock) {
  const registry = new PeerRegistry({ localPodId: node.podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: node.podId }), ...(clock ? { clock } : {}) })
  node.registry = registry
  return registry
}

test('scope names: `<protocol>:<root>:<action>`, and no name can carry scope syntax', () => {
  assert.equal(rootScope('objects', 'docs', 'get'), 'objects:docs:get')
  for (const bad of ['', 'a:b', '*', 'a b', 'a/b', 'x'.repeat(129)]) assert.throws(() => rootScope('objects', bad, 'get'), TypeError, `root ${JSON.stringify(bad)}`)
  for (const bad of ['', 'a:b', '*', 'Get', 'x'.repeat(33)]) assert.throws(() => rootScope('objects', 'docs', bad), TypeError, `action ${JSON.stringify(bad)}`)
  assert.throws(() => rootScope('Not:Valid', 'docs', 'get'), TypeError)
})

test('default deny: no check function, or a check that throws, allows nothing', () => {
  assert.equal(createRootAuthorizer({ protocol: 'objects' }).can('p', 'docs', 'get'), false)
  assert.equal(createRootAuthorizer({ protocol: 'objects', check: () => { throw new Error('boom') } }).can('p', 'docs', 'get'), false)
  assert.equal(createRootAuthorizer({ protocol: 'objects', check: () => ({ allowed: false }) }).can('p', 'docs', 'get'), false)
  assert.equal(createRootAuthorizer({ protocol: 'objects', check: () => 'yes' }).can('p', 'docs', 'get'), false, 'only true or { allowed: true }')
})

test('the check is asked about resource `<protocol>:<root>` and the action, for the peer', () => {
  const calls = []
  const auth = createRootAuthorizer({ protocol: 'objects', check: (peer, resource, action) => { calls.push([peer, resource, action]); return { allowed: true } } })
  assert.equal(auth.can('alice', 'docs', 'get'), true)
  assert.deepEqual(calls, [['alice', 'objects:docs', 'get']])
  assert.throws(() => auth.can('alice', 'a:b', 'get'), TypeError)
  assert.equal(calls.length, 1, 'a malformed root is never sent to the check')
})

test('per root and per action against the registry, with its wildcards', async () => {
  const [alice, bob] = await network()
  const reg = registryFor(bob)
  const auth = createRootAuthorizer({ protocol: 'objects', check: (p, r, a) => reg.checkAccess(p, r, a) })
  assert.equal(auth.can(alice.podId, 'docs', 'get'), false)
  reg.grantCapabilities(alice.podId, auth.scopes('docs', ['get']))
  assert.equal(auth.can(alice.podId, 'docs', 'get'), true)
  assert.equal(auth.can(alice.podId, 'docs', 'set'), false, 'other action')
  assert.equal(auth.can(alice.podId, 'secrets', 'get'), false, 'other root')
  reg.grantCapabilities(alice.podId, ['objects:*:call'])
  assert.equal(auth.can(alice.podId, 'anything', 'call'), true)
  assert.equal(auth.can(alice.podId, 'anything', 'get'), false)
  reg.grantCapabilities(alice.podId, ['objects:media:*'])
  assert.equal(auth.can(alice.podId, 'media', 'set'), true)
  assert.equal(auth.can(alice.podId, 'docs', 'set'), false)
  // A grant for another protocol's root never counts.
  reg.grantCapabilities(alice.podId, ['files:docs:set'])
  assert.equal(auth.can(alice.podId, 'docs', 'set'), false)
})

test('scopes() is exactly what grantCapabilities needs, and defaults to the authorizer\'s actions', () => {
  const auth = createRootAuthorizer({ protocol: 'objects', actions: ['get', 'call', 'set'] })
  assert.deepEqual(auth.scopes('docs'), ['objects:docs:get', 'objects:docs:call', 'objects:docs:set'])
  assert.deepEqual(auth.scopes('docs', ['get']), ['objects:docs:get'])
  assert.throws(() => auth.scopes('docs', ['get', 'a:b']), TypeError)
})

test('assert throws the channel\'s unauthorized error and reveals nothing about other roots', () => {
  const auth = createRootAuthorizer({ protocol: 'objects', check: (p, r) => r === 'objects:docs' })
  auth.assert('alice', 'docs', 'get')
  try { auth.assert('alice', 'secrets', 'get'); assert.fail('should throw') } catch (e) {
    assert.ok(e instanceof MeshChannelError)
    assert.equal(e.code, ChannelErrorCode.UNAUTHORIZED)
    assert.equal(e.reason, 'not-authorized')
    assert.ok(!/secrets/.test(e.message), 'the message does not echo the root')
  }
})

test('allowed() filters a list to what the peer may use; guard() wraps a handler with the verified peer', async () => {
  const granted = new Set(['objects:docs:get', 'objects:logs:get'])
  const auth = createRootAuthorizer({ protocol: 'objects', check: (p, r, a) => p === 'alice' && granted.has(`${r}:${a}`) })
  assert.deepEqual(auth.allowed('alice', ['docs', 'secrets', 'logs'], 'get'), ['docs', 'logs'])
  assert.deepEqual(auth.allowed('mallory', ['docs'], 'get'), [])

  const seen = []
  const get = auth.guard(({ root, path }, ctx) => { seen.push([root, path, ctx.peer]); return 'ok' }, { action: 'get', root: params => params.root })
  assert.equal(await get({ root: 'docs', path: 'a' }, { peer: 'alice' }), 'ok')
  await assert.rejects(get({ root: 'secrets', path: 'a' }, { peer: 'alice' }), { code: ChannelErrorCode.UNAUTHORIZED })
  await assert.rejects(get({ root: 'docs', path: 'a' }, { peer: 'mallory' }), { code: ChannelErrorCode.UNAUTHORIZED })
  await assert.rejects(get({ root: { toString: () => 'docs' } }, { peer: 'alice' }), { code: ChannelErrorCode.INVALID }, 'a root that is not a string')
  await assert.rejects(get(null, { peer: 'alice' }), { code: ChannelErrorCode.INVALID })
  await assert.rejects(get({ root: 'a:b' }, { peer: 'alice' }), { code: ChannelErrorCode.INVALID })
  assert.deepEqual(seen, [['docs', 'a', 'alice']])
})

test('the peer is the channel\'s verified one, never a field of the message', async () => {
  const auth = createRootAuthorizer({ protocol: 'objects', check: (p) => p === 'alice' })
  const get = auth.guard(() => 'ok', { action: 'get', root: params => params.root })
  // The message claims to be alice; the channel says mallory.
  await assert.rejects(get({ root: 'docs', peer: 'alice', from: 'alice' }, { peer: 'mallory' }), { code: ChannelErrorCode.UNAUTHORIZED })
  await assert.rejects(get({ root: 'docs' }, {}), { code: ChannelErrorCode.UNAUTHORIZED }, 'no verified peer, no access')
})

test('over the mesh: a protocol served with per-root checks, revocation applies to the next request', async () => {
  const clock = fakeClock()
  const [alice, bob] = await network()
  registryFor(alice)
  const regB = registryFor(bob, clock)
  const a = attachService(alice, undefined, createMeshProtocolService())
  const b = attachService(bob, undefined, createMeshProtocolService())
  try {
    const auth = b.api.rootAuthorizer('objects', { actions: ['get', 'call'] })
    assert.equal(auth.protocol, 'objects')
    const store = { docs: { title: 'hi' }, secrets: { key: 'k' } }
    b.api.serveProtocol('objects', channel => {
      channel.onRequest('get', auth.guard(({ root, path }) => store[root][path], { action: 'get', root: p => p.root }))
    })
    regB.grantCapabilities(alice.podId, [protocolScope('objects'), ...auth.scopes('docs', ['get'])])
    const ch = await a.api.openProtocol(bob.podId, 'objects')
    assert.equal(await ch.request('get', { root: 'docs', path: 'title' }), 'hi')
    await assert.rejects(ch.request('get', { root: 'secrets', path: 'key' }), { code: ChannelErrorCode.UNAUTHORIZED })
    regB.revokeCapabilities(alice.podId, auth.scopes('docs', ['get']))
    await assert.rejects(ch.request('get', { root: 'docs', path: 'title' }), { code: ChannelErrorCode.UNAUTHORIZED })
    // The protocol scope is still there: the channel stays open.
    assert.deepEqual(b.api.openProtocols(alice.podId), ['objects'])
    // Expiry of a root grant applies the same way.
    regB.grantCapabilities(alice.podId, auth.scopes('docs', ['get']), { expiresAt: clock.now() + 1000 })
    assert.equal(await ch.request('get', { root: 'docs', path: 'title' }), 'hi')
    clock.advance(1000)
    await flush()
    await assert.rejects(ch.request('get', { root: 'docs', path: 'title' }), { code: ChannelErrorCode.UNAUTHORIZED })
  } finally { a.teardown(); b.teardown() }
})

test('a registry-less node authorises no root', async () => {
  const [, bob] = await network()
  const b = attachService(bob, undefined, createMeshProtocolService())
  try {
    assert.equal(b.api.rootAuthorizer('objects').can('anyone', 'docs', 'get'), false)
  } finally { b.teardown() }
})

test('streams: the root a stream names is authorised before the stream opens', async () => {
  const [alice, bob] = await network()
  registryFor(alice)
  const regB = registryFor(bob)
  const a = attachService(alice, undefined, createMeshProtocolService())
  const b = attachService(bob, undefined, createMeshProtocolService())
  try {
    const auth = b.api.rootAuthorizer('files', { actions: ['write'] })
    const got = []
    b.api.serveProtocol('files', channel => {
      createStreamLayer(channel, { authorize: (meta, { peer }) => auth.assert(peer, meta.root, 'write') }) // refuses before the open is answered
        .onStream(async (reader, { meta }) => { got.push([meta.root, (await reader.bytes()).byteLength]) })
    })
    regB.grantCapabilities(alice.podId, [protocolScope('files'), ...auth.scopes('inbox', ['write'])])
    const layer = createStreamLayer(await a.api.openProtocol(bob.podId, 'files'))
    await assert.rejects(layer.open({ root: 'etc' }), { code: ChannelErrorCode.UNAUTHORIZED })
    const w = await layer.open({ root: 'inbox' })
    await w.write(new Uint8Array(50_000))
    await w.end()
    await flush()
    assert.deepEqual(got, [['inbox', 50_000]])
  } finally { a.teardown(); b.teardown() }
})
