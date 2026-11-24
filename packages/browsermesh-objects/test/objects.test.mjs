import { test } from 'node:test'
import assert from 'node:assert/strict'
import { on, off, set, snapshot, use, release } from '@johnhenry/wsh/objects'
import { protocolScope, ChannelErrorCode, attachService, createMeshChannelService, createRootAuthorizer } from '@johnhenry/browsermesh-apps'
import { exposeObjectsOnMesh, openObjectsOnMesh, ObjectsOnMeshError, actionFor, OBJECT_ACTIONS, whoFor, podIdOf } from '../src/index.mjs'
import { threePods, makeApp, allow, until, holdable, fakeClock, createNodes } from './helpers/mesh.mjs'

const UNAUTHORIZED = ChannelErrorCode.UNAUTHORIZED
const refused = (code = UNAUTHORIZED) => (e) => e.code === code

/** Bob hosts `app`; `grants` are what alice is granted. */
async function setup({ grants = [], expose = {}, channelOptions, clock, watch = false } = {}) {
  const pods = await threePods({ channelOptions, clock })
  const app = makeApp()
  const objects = exposeObjectsOnMesh(pods.b, {
    roots: { app },
    allow,
    handles: { app: {} },
    ...(watch ? { watch: pods.bob.registry.onAccessChange.bind(pods.bob.registry) } : {}),
    ...expose,
  })
  if (grants.length) pods.bob.registry.grantCapabilities(pods.alice.podId, [protocolScope('objects'), ...grants])
  const open = (opts) => openObjectsOnMesh(pods.a, pods.bob.podId, opts)
  return { ...pods, app, objects, open, teardown() { objects.stop(); pods.teardown() } }
}

// ── the action table ────────────────────────────────────────────────────────

test('each operation maps to its own action; an unknown kind maps to nothing', () => {
  assert.deepEqual(OBJECT_ACTIONS, ['get', 'call', 'set', 'on'])
  const table = { get: 'get', describe: 'get', snapshot: 'get', call: 'call', construct: 'call', set: 'set', on: 'on' }
  for (const [kind, action] of Object.entries(table)) assert.equal(actionFor({ kind }), action, kind)
  for (const kind of ['subscribe', 'release', 'delete', '__proto__', 'toString', '', undefined, null, 7]) assert.equal(actionFor({ kind }), null, String(kind))
  assert.equal(actionFor(undefined), null)
})

test("the caller identity is wsh's own: the verified pod id, and the fingerprint of the same key derived from it", async () => {
  const { podIdToFingerprint, normalizeIdentity } = await import('@johnhenry/wsh/identity')
  const { PodIdentity } = await import('@johnhenry/browsermesh-primitives')
  const { podId } = await PodIdentity.generate()
  const who = whoFor(podId)
  assert.deepEqual({ ...who }, { username: null, fingerprint: podIdToFingerprint(podId), podId })
  assert.deepEqual({ ...who }, { ...normalizeIdentity({ podId }) }, 'one definition of who, wsh\'s')
  assert.equal(podIdOf(who), podId)
  assert.equal(podIdOf({ fingerprint: podIdToFingerprint(podId) }), null, 'a fingerprint is never read as a pod id')
  assert.throws(() => whoFor(''), TypeError)
  assert.throws(() => whoFor('pod-abc'), TypeError, 'not the name of a key: refused, not passed on')
  assert.throws(() => whoFor(`${podId.slice(0, 42)}B`), TypeError, 'a spelling of a key that is not canonical is refused too')
})

// ── values ──────────────────────────────────────────────────────────────────

test('values: read, call, set, bytes across several chunks, bounded snapshot', async () => {
  const { alice, app, open, teardown } = await setup({ grants: ['objects:app:get', 'objects:app:call', 'objects:app:set'] })
  try {
    const { roots } = await open()
    assert.equal(await roots.app.title, 'inbox')
    assert.equal(await roots.app.counter.inc(4), 7)
    await set(roots.app.counter, 'value', 20)
    assert.equal(app.counter.value, 20)
    const bytes = await roots.app.bytes()
    assert.ok(bytes instanceof Uint8Array)
    assert.equal(bytes.length, 150_000)
    assert.equal(bytes[1000], 1000 % 251)
    assert.deepEqual(await snapshot(roots.app.counter, { depth: 2 }), { value: 20 })
    void alice
  } finally { teardown() }
})

test('the host judges every operation for the channel\'s verified peer and nobody else', async () => {
  const calls = []
  const probe = (real) => ({ ...real, can: (peer, root, action) => { calls.push({ peer, root, action }); return real.can(peer, root, action) } })
  const pods = await threePods()
  const real = pods.b.api.rootAuthorizer('objects', { actions: [...OBJECT_ACTIONS] })
  const objects = exposeObjectsOnMesh(pods.b, { roots: { app: makeApp() }, allow, authorizer: probe(real) })
  try {
    pods.bob.registry.grantCapabilities(pods.alice.podId, [protocolScope('objects'), 'objects:app:get'])
    const { roots } = await openObjectsOnMesh(pods.a, pods.bob.podId)
    calls.length = 0
    assert.equal(await roots.app.title, 'inbox')
    assert.deepEqual(calls, [{ peer: pods.alice.podId, root: 'app', action: 'get' }])
    // Not even the allow-list lets this through, so the registry is not asked.
    calls.length = 0
    await assert.rejects(async () => roots.app.secret, (e) => e.code === UNAUTHORIZED && e.reason === 'not-allowed')
    assert.deepEqual(calls, [])
  } finally { objects.stop(); pods.teardown() }
})

// ── per-action authorisation ────────────────────────────────────────────────

const OPERATIONS = {
  get: (app) => app.title,
  call: (app) => app.counter.inc(0),
  set: (app) => set(app.counter, 'value', 3),
  on: (app) => on(app.bus, 'ping', () => {}),
}

for (const granted of OBJECT_ACTIONS) {
  test(`a peer granted only objects:app:${granted} may do ${granted} and nothing else`, async () => {
    const { open, teardown } = await setup({ grants: [`objects:app:${granted}`] })
    try {
      const { roots } = await open()
      for (const action of OBJECT_ACTIONS) {
        const attempt = Promise.resolve().then(() => OPERATIONS[action](roots.app))
        if (action === granted) await attempt
        else await assert.rejects(attempt, refused(), `${action} must need objects:app:${action}`)
      }
    } finally { teardown() }
  })
}

test('a subscription needs objects:ROOT:on: a peer granted only get is refused (the defect of an on-to-get mapping)', async () => {
  const { app, open, teardown } = await setup({ grants: ['objects:app:get'] })
  try {
    const { roots } = await open()
    await assert.rejects(on(roots.app.bus, 'ping', () => {}), refused())
    assert.equal(app.listenerCount('ping'), 0, 'nothing was attached to the host\'s source')
  } finally { teardown() }
})

test('default deny: with no grant the protocol cannot be opened; with the protocol grant alone no root is listed and nothing runs', async () => {
  const { alice, bob, e, open, teardown } = await setup()
  try {
    await assert.rejects(e.api.openProtocol(bob.podId, 'objects'), { code: UNAUTHORIZED })
    bob.registry.grantCapabilities(alice.podId, [protocolScope('objects')])
    const { roots } = await open()
    assert.equal(roots.app, undefined, 'a peer is told of the roots it can use on some action, no others')
  } finally { teardown() }
})

test('both authorisations apply: a path the allow-list does not name is refused whatever the grant', async () => {
  const { open, teardown } = await setup({ grants: ['objects:*:get', 'objects:*:call', 'objects:*:set', 'objects:*:on'] })
  try {
    const { roots } = await open()
    await assert.rejects(async () => roots.app.secret, (e) => e.reason === 'not-allowed')
    await assert.rejects(on(roots.app.bus, 'unlisted', () => {}), (e) => e.reason === 'not-allowed')
  } finally { teardown() }
})

// ── events ──────────────────────────────────────────────────────────────────

test('events: delivered as plain data, in order, until the subscriber unsubscribes', async () => {
  const { app, open, teardown } = await setup({ grants: ['objects:app:on'] })
  try {
    const { roots } = await open()
    const seen = []
    const stop = await on(roots.app.bus, 'ping', (data, info) => seen.push({ args: data.args, seq: info.seq, type: info.type }))
    assert.equal(app.listenerCount('ping'), 1)
    app.emit('ping', { n: 1 })
    app.emit('ping', { n: 2 }, 'extra')
    await until(() => seen.length === 2)
    assert.deepEqual(seen, [{ args: [{ n: 1 }], seq: 1, type: 'ping' }, { args: [{ n: 2 }, 'extra'], seq: 2, type: 'ping' }])
    await off(stop)
    assert.equal(app.listenerCount('ping'), 0, 'the listener left the host\'s source')
  } finally { teardown() }
})

test('events: a bounded number of subscriptions per channel, refused by name', async () => {
  const { open, teardown } = await setup({ grants: ['objects:app:on'], expose: { limits: { maxSubscriptions: 1 } } })
  try {
    const { roots } = await open()
    await on(roots.app.bus, 'ping', () => {})
    await assert.rejects(on(roots.app.bus, 'tick', () => {}), (e) => e.reason === 'limit' && e.data.limit === 'maxSubscriptions')
  } finally { teardown() }
})

test('events: ending the session takes the listener out of the host\'s source', async () => {
  const { app, objects, open, teardown } = await setup({ grants: ['objects:app:on'] })
  try {
    const { roots, close } = await open()
    await on(roots.app.bus, 'ping', () => {})
    assert.equal(app.listenerCount('ping'), 1)
    close()
    await until(() => objects.sessions() === 0)
    assert.equal(app.listenerCount('ping'), 0)
  } finally { teardown() }
})

test('events: a reader that stops reading makes the host drop events, and every drop is counted', async () => {
  const channelOptions = { window: 16384, maxMessageBytes: 16384, chunkBytes: 4096 }
  const { app, a, bob, objects, teardown } = await setup({
    grants: ['objects:app:on'], channelOptions, expose: { limits: { maxQueuedEvents: 5, maxEventsPerSecond: 100_000, maxEventBytes: 8192 } },
  })
  try {
    const held = holdable(await a.api.openProtocol(bob.podId, 'objects'))
    const { roots } = await openObjectsOnMesh(held.channel)
    let received = 0
    let dropped = 0
    let last = 0
    await on(roots.app.bus, 'ping', (data, info) => { received += 1; dropped += info.dropped; last = data.args[0].n })
    held.hold()
    const total = 60
    // One event per turn of the event loop, so that the host could send each before the next, if the channel let it.
    for (let n = 1; n <= total; n++) {
      app.emit('ping', { n, pad: 'x'.repeat(3000) })
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.ok(objects.stats().pendingSends <= 1, 'the layer waits for the channel: at most one write is outstanding, the rest wait in its bounded queue')
    held.release()
    // The next event delivered tells how many were lost before it; keep offering until one is.
    let emitted = total
    while (last <= total) {
      emitted += 1
      app.emit('ping', { n: emitted })
      await new Promise((resolve) => setImmediate(resolve))
    }
    // `n` numbers the events as emitted, so at any instant: arrived + counted as dropped = the newest arrived.
    assert.ok(dropped > 0, 'something was dropped')
    assert.ok(received < last, 'not everything arrived')
    assert.equal(received + dropped, last, 'what arrived plus what was counted as dropped is everything emitted up to it')
  } finally { teardown() }
})

// ── handles ─────────────────────────────────────────────────────────────────

test('handles: path-bound rules hold over the mesh (a handle never widens what a path grants)', async () => {
  const { open, teardown } = await setup({ grants: ['objects:app:get', 'objects:app:call'] })
  try {
    const { roots } = await open()
    const cart = await roots.app.makeCart()
    assert.equal(cart.constructor.name, 'RemoteHandle')
    assert.equal(await use(cart).items.length, 3)
    assert.equal(await use(cart).add(9), 4)
    // `app.makeCart().note` is on no list: the handle does not make it reachable.
    await assert.rejects(async () => use(cart).note, (e) => e.reason === 'not-allowed')
    // Nothing of the handle is enumerable on this side, and it is not thenable.
    assert.deepEqual(Object.keys(cart), [])
    assert.equal(typeof cart.then, 'undefined')
  } finally { teardown() }
})

test('handles: an operation through a handle needs the action of the operation (get may read through it, not call)', async () => {
  const { open, teardown } = await setup({ grants: ['objects:app:get'] })
  try {
    const { roots } = await open()
    const cart = await roots.app.cart // a get: a handle on app.cart
    assert.equal(await use(cart).items.length, 3)
    await assert.rejects(async () => use(cart).add(1), refused())
  } finally { teardown() }
})

test('handles: release gives the place back, the table is bounded, and the end of the session drops them all', async () => {
  const { open, teardown } = await setup({ grants: ['objects:app:get', 'objects:app:call'], expose: { limits: { maxHandles: 2 } } })
  try {
    const { roots, close } = await open()
    const one = await roots.app.makeCart()
    const two = await roots.app.makeCart()
    await assert.rejects(async () => roots.app.makeCart(), (e) => e.reason === 'limit' && e.data.limit === 'maxHandles')
    await release(one)
    await assert.rejects(async () => use(one).items.length, (e) => /no such handle|released/i.test(e.message) || e.reason === 'gone')
    const three = await roots.app.makeCart() // the freed place is usable again; nothing was evicted
    assert.equal(await use(two).items.length, 3)
    assert.equal(await use(three).items.length, 3)
    close()
    await assert.rejects(async () => use(two).items.length)
  } finally { teardown() }
})

// ── callbacks ───────────────────────────────────────────────────────────────

test('callbacks: one-way, run on the far side, and need objects:ROOT:call (they are arguments of a call)', async () => {
  const { app, open, teardown } = await setup({ grants: ['objects:app:call'] })
  try {
    const { roots } = await open()
    const got = []
    await roots.app.subscribe((...args) => got.push(args))
    const returned = app.fire('x', { n: 1 })
    assert.deepEqual(returned, [undefined], 'the host\'s call returns at once with nothing: it cannot be made to wait for the far side')
    await until(() => got.length === 1)
    assert.deepEqual(got, [['x', { n: 1 }]])
  } finally { teardown() }
})

test('callbacks: a peer without objects:ROOT:call cannot pass one', async () => {
  const { app, open, teardown } = await setup({ grants: ['objects:app:get', 'objects:app:on'] })
  try {
    const { roots } = await open()
    await assert.rejects(async () => roots.app.subscribe(() => {}), refused())
    assert.equal(app.stubCount(), 0)
  } finally { teardown() }
})

test('callbacks: bounded in number and in bytes, drops counted, dead after release and after the session', async () => {
  const { app, objects, open, teardown } = await setup({
    grants: ['objects:app:call'], expose: { limits: { maxCallbacks: 1, maxCallbackBytes: 200 } },
  })
  try {
    const { roots, close } = await open({ onCallbackDropped: (info) => dropped.push(info.dropped) })
    const dropped = []
    const got = []
    const fn = (...args) => got.push(args)
    await roots.app.subscribe(fn)
    await assert.rejects(async () => roots.app.subscribe(() => {}), (e) => e.reason === 'limit' && e.data.limit === 'maxCallbacks')
    app.fire('big', 'x'.repeat(2000)) // over the byte bound: dropped, counted
    app.fire('ok')
    await until(() => got.length === 1)
    assert.deepEqual(got, [['ok']])
    assert.deepEqual(dropped, [1], 'the next call delivered says how many were lost before it')
    await release(fn)
    app.fire('after release')
    close()
    await until(() => objects.sessions() === 0)
    app.fire('after close')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(got, [['ok']], 'a dead stub does nothing')
  } finally { teardown() }
})

// ── revocation and expiry mid-session ───────────────────────────────────────

test('revoking a grant refuses the very next request; the channel and the other grants stay', async () => {
  const { alice, bob, objects, open, teardown } = await setup({ grants: ['objects:app:get', 'objects:app:call'] })
  try {
    const { roots } = await open()
    assert.equal(await roots.app.title, 'inbox')
    bob.registry.revokeCapabilities(alice.podId, ['objects:app:get'])
    await assert.rejects(async () => roots.app.title, refused())
    assert.equal(await roots.app.counter.inc(1), 4, 'call is still granted')
    assert.equal(objects.sessions(), 1)
  } finally { teardown() }
})

test('revoking objects:ROOT:on closes the session at once and takes the listener out (with watch)', async () => {
  const { alice, bob, app, objects, open, teardown } = await setup({ grants: ['objects:app:on', 'objects:app:get'], watch: true })
  try {
    const { roots } = await open()
    await on(roots.app.bus, 'ping', () => {})
    bob.registry.revokeCapabilities(alice.podId, ['objects:app:on'])
    await until(() => objects.sessions() === 0)
    assert.equal(app.listenerCount('ping'), 0)
    assert.equal(objects.stats().revoked, 1)
    await assert.rejects(async () => roots.app.title, (e) => e instanceof Error)
  } finally { teardown() }
})

test('revoking objects:ROOT:on without watch is noticed at the next event, which is not delivered', async () => {
  const { alice, bob, app, objects, open, teardown } = await setup({ grants: ['objects:app:on'] })
  try {
    const { roots } = await open()
    const seen = []
    await on(roots.app.bus, 'ping', (data) => seen.push(data))
    bob.registry.revokeCapabilities(alice.podId, ['objects:app:on'])
    assert.equal(objects.sessions(), 1, 'nothing has happened yet')
    app.emit('ping', 'secret news')
    await until(() => objects.sessions() === 0)
    assert.deepEqual(seen, [])
    assert.equal(app.listenerCount('ping'), 0)
  } finally { teardown() }
})

test('a grant that expires ends the subscription it allowed', async () => {
  const clock = fakeClock()
  const { alice, bob, app, objects, open, teardown } = await setup({ clock, watch: true })
  try {
    bob.registry.grantCapabilities(alice.podId, [protocolScope('objects')])
    bob.registry.grantCapabilities(alice.podId, ['objects:app:on'], { expiresAt: clock.now() + 1000 })
    const { roots } = await open()
    await on(roots.app.bus, 'tick', () => {})
    assert.equal(objects.sessions(), 1)
    clock.advance(1001)
    await until(() => objects.sessions() === 0)
    assert.equal(app.listenerCount('tick'), 0)
  } finally { teardown() }
})

test('revoking objects:ROOT:call ends the callbacks it allowed (with watch); a callback is never delivered after', async () => {
  const { alice, bob, app, objects, open, teardown } = await setup({ grants: ['objects:app:call'], watch: true })
  try {
    const { roots } = await open()
    const got = []
    await roots.app.subscribe((...args) => got.push(args))
    bob.registry.revokeCapabilities(alice.podId, ['objects:app:call'])
    await until(() => objects.sessions() === 0)
    app.fire('late')
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(got, [])
  } finally { teardown() }
})

test('revoking objects:ROOT:call without watch: the next callback is not delivered and the session ends', async () => {
  const { alice, bob, app, objects, open, teardown } = await setup({ grants: ['objects:app:call'] })
  try {
    const { roots } = await open()
    const got = []
    await roots.app.subscribe((...args) => got.push(args))
    bob.registry.revokeCapabilities(alice.podId, ['objects:app:call'])
    app.fire('after the revoke')
    await until(() => objects.sessions() === 0)
    assert.deepEqual(got, [])
  } finally { teardown() }
})

test('revoking the protocol scope closes the session through the protocol host', async () => {
  const { alice, bob, a, app, objects, open, teardown } = await setup({ grants: ['objects:app:on'] })
  try {
    const { roots } = await open()
    await on(roots.app.bus, 'ping', () => {})
    bob.registry.revokeCapabilities(alice.podId, [protocolScope('objects')])
    await until(() => objects.sessions() === 0)
    assert.equal(app.listenerCount('ping'), 0)
    await until(() => a.api.openProtocols(bob.podId).length === 0) // the opener hears of the close
    await assert.rejects(open(), refused())
  } finally { teardown() }
})

// ── bounds ──────────────────────────────────────────────────────────────────

test('a peer that keeps asking and does not read is cut off, counted, and its session ends', async () => {
  const channelOptions = { window: 8192, maxMessageBytes: 8192, chunkBytes: 2048 }
  const { a, bob, objects, teardown } = await setup({
    grants: ['objects:app:get'], channelOptions, expose: { maxPendingSends: 3, limits: { maxRequestsPerSecond: 100_000 } },
  })
  try {
    const held = holdable(await a.api.openProtocol(bob.podId, 'objects'))
    const { roots } = await openObjectsOnMesh(held.channel)
    held.hold()
    // Each answer is a few KB: a handful fill the credit the held reader returns, and more are waiting.
    const flood = Array.from({ length: 24 }, async () => { try { return await roots.app.text } catch { return null } })
    await until(() => objects.sessions() === 0)
    assert.equal(objects.stats().closedSlow, 1)
    held.release()
    await Promise.all(flood)
  } finally { teardown() }
})

test('a result over the channel\'s message size is refused, not sent', async () => {
  const channelOptions = { window: 16384, maxMessageBytes: 16384, chunkBytes: 4096 }
  const { open, teardown } = await setup({ grants: ['objects:app:call'], channelOptions })
  try {
    const { roots } = await open()
    await assert.rejects(async () => roots.app.bytes(), (e) => e.reason === 'limit' || /too large|exceeds|limit/i.test(e.message))
  } finally { teardown() }
})

// ── an older peer, stopping, argument checks ───────────────────────────────

test('a peer that has the channel but no protocol support: a named error, nothing else', async () => {
  const [alice, old] = await createNodes(2)
  const a = attachService(alice, undefined, (await import('@johnhenry/browsermesh-apps')).createMeshProtocolService())
  const o = attachService(old, undefined, createMeshChannelService())
  try {
    await assert.rejects(openObjectsOnMesh(a, old.podId), (e) => e instanceof ObjectsOnMeshError && e.reason === 'not-served' && e.code === ChannelErrorCode.METHOD_NOT_FOUND)
  } finally { a.teardown(); o.teardown() }
})

test('a peer that serves protocols but not objects looks like the protocol is not served', async () => {
  const { alice, bob, a, teardown } = await setup()
  try {
    bob.registry.grantCapabilities(alice.podId, [protocolScope('other')])
    await assert.rejects(openObjectsOnMesh(a, bob.podId, { protocol: 'other' }), (e) => e instanceof ObjectsOnMeshError && e.reason === 'not-served')
  } finally { teardown() }
})

test('stop() ends every session and the protocol is no longer served', async () => {
  const { alice, bob, objects, open, teardown } = await setup({ grants: ['objects:app:get'] })
  try {
    const { roots } = await open()
    assert.equal(await roots.app.title, 'inbox')
    objects.stop()
    await until(() => objects.sessions() === 0)
    await assert.rejects(async () => roots.app.title)
    bob.registry.grantCapabilities(alice.podId, [protocolScope('objects')])
    await assert.rejects(open(), (e) => e instanceof ObjectsOnMeshError && e.reason === 'not-served')
  } finally { teardown() }
})

test('arguments: nothing is served without roots, a service or an authorizer; a root name cannot carry scope syntax', async () => {
  const pods = await threePods()
  try {
    assert.throws(() => exposeObjectsOnMesh(pods.b, {}), /roots/)
    assert.throws(() => exposeObjectsOnMesh({}, { roots: { app: {} } }), /mesh service/)
    assert.throws(() => exposeObjectsOnMesh(() => {}, { roots: { app: {} } }), /authorizer is required/)
    assert.throws(() => exposeObjectsOnMesh(pods.b, { roots: { 'a:b': {} }, allow }), TypeError)
    assert.throws(() => exposeObjectsOnMesh(pods.b, { roots: { '*': {} }, allow }), TypeError)
    await assert.rejects(openObjectsOnMesh(pods.a), TypeError)
    await assert.rejects(openObjectsOnMesh(pods.a, ''), TypeError)
  } finally { pods.teardown() }
})

test('a channel factory serves any protocol host: here a bare in-memory duplex with no mesh service at all', async () => {
  const { memoryChannelPair } = await import('./helpers/memory-channel.mjs')
  const { PodIdentity } = await import('@johnhenry/browsermesh-primitives')
  const clientId = (await PodIdentity.generate()).podId
  const serverId = (await PodIdentity.generate()).podId
  const { a: client, b: server } = memoryChannelPair(clientId, serverId)
  const app = makeApp()
  const authorizer = createRootAuthorizer({ protocol: 'objects', check: (peer, resource, action) => peer === clientId && resource === 'objects:app' && action === 'get' })
  const objects = exposeObjectsOnMesh((accept) => { accept(server); return () => {} }, { roots: { app }, allow, authorizer })
  const { roots } = await openObjectsOnMesh(client)
  assert.equal(await roots.app.title, 'inbox')
  await assert.rejects(async () => roots.app.counter.inc(), refused())
  objects.stop()
})
