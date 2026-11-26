/**
 * Owned DHT stores through the apps wrapper (`createMeshDht`, and `createMeshNode({ enableDht, dhtSignStores, dhtStorePolicy })`):
 * the records a node stores are signed with the pod's own key, and the node can apply a store policy. Both are opt-in; with neither
 * the wrapper is what it was. Real `DhtNode`s over an in-process bus; the discovery package's own tests cover the rules.
 *
 * Run: node --import ./test/_setup-globals.mjs --test test/mesh-dht-signed.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { DHT_STORE } from '@johnhenry/browsermesh-discovery'
import { createMeshDht } from '../src/mesh-dht.mjs'
import { createMeshNode } from '../src/mesh-bootstrap.mjs'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

const createBus = () => new Set()
function busTransport(bus) {
  let handler = null
  const receiver = (msg) => { if (handler) handler(msg) }
  bus.add(receiver)
  return { send(msg) { for (const fn of bus) if (fn !== receiver) fn(msg) }, onMessage(cb) { handler = cb } }
}

async function waitFor(fn, what, ms = 5000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** A DHT on the bus under a fresh identity; `seen` records every STORE it puts on the wire. */
async function dhtOn(bus, options = {}) {
  const identity = await PodIdentity.generate()
  const wire = []
  const base = busTransport(bus)
  const transport = { send: (m) => { if (m?.payload?.type === DHT_STORE) wire.push(m.payload); base.send(m) }, onMessage: (cb) => base.onMessage(cb) }
  const dht = createMeshDht({ localPodId: identity.podId, transport, ...options(identity) })
  await dht.strategy.start()
  return { identity, wire, ...dht, record: { podId: identity.podId, label: 'me' } }
}

describe('with no new option the wrapper is what it was', () => {
  it('stores the record unsigned, on a node with no policy', async () => {
    const bus = createBus()
    const a = await dhtOn(bus, () => ({}))
    const b = await dhtOn(bus, () => ({ bootstrapPeers: [a.identity.podId] }))
    assert.equal(a.strategy.storePolicy, null)
    await b.strategy.announce(b.record)
    assert.ok(b.wire.length > 0)
    for (const m of b.wire) assert.equal('auth' in m, false)
    await waitFor(async () => (await a.strategy.query({ podId: b.identity.podId })).length === 1, 'a to hold b\'s record')
  })
})

describe('signStores', () => {
  it('stores under the pod\'s key with a proof, and a node that checks stores accepts it', async () => {
    const bus = createBus()
    const a = await dhtOn(bus, () => ({ storePolicy: { mode: 'owned' } }))
    const b = await dhtOn(bus, (identity) => ({ bootstrapPeers: [a.identity.podId], identity, signStores: true }))
    await b.strategy.announce(b.record)
    assert.ok(b.wire.length > 0)
    for (const m of b.wire) assert.equal(m.auth?.v, 1)
    await waitFor(async () => (await a.strategy.query({ podId: b.identity.podId })).length === 1, 'a (owned) to hold b\'s signed record')
    assert.equal(a.dhtNode.ownerOf(b.identity.podId), Buffer.from(await b.identity.rawPublicKey()).toString('base64url'))
    assert.equal(a.dhtNode.storeStats.accepted, 1)
  })

  it('a node that checks stores refuses a record that was not signed, and counts why; the unsigned writer notices nothing', async () => {
    const bus = createBus()
    const a = await dhtOn(bus, () => ({ storePolicy: { mode: 'owned' } }))
    const old = await dhtOn(bus, () => ({ bootstrapPeers: [a.identity.podId] })) // announces as it always did
    await old.strategy.announce(old.record)
    await waitFor(() => a.dhtNode.storeStats.refused['unsigned-store'] === 1, 'a to refuse the unsigned store')
    assert.deepEqual(await a.strategy.query({ podId: old.identity.podId }), [])
    assert.deepEqual(await old.strategy.query({ podId: old.identity.podId }), [old.record]) // it still holds its own
  })

  it('a node with the open policy still takes unsigned stores, as before', async () => {
    const bus = createBus()
    const a = await dhtOn(bus, () => ({ storePolicy: { mode: 'open' } }))
    const old = await dhtOn(bus, () => ({ bootstrapPeers: [a.identity.podId] }))
    await old.strategy.announce(old.record)
    await waitFor(async () => (await a.strategy.query({ podId: old.identity.podId })).length === 1, 'a (open) to hold the unsigned record')
  })

  it('every re-announce carries a higher seq, so a changed record replaces the last one', async () => {
    const bus = createBus()
    const a = await dhtOn(bus, () => ({ storePolicy: { mode: 'owned' } }))
    const b = await dhtOn(bus, (identity) => ({ bootstrapPeers: [a.identity.podId], identity, signStores: true }))
    await b.strategy.announce(b.record)
    await b.strategy.announce({ ...b.record, label: 'renamed' })
    await b.strategy.announce({ ...b.record, label: 'renamed again' })
    const seqs = b.wire.map((m) => m.auth.seq)
    assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y))
    assert.equal(new Set(seqs).size, seqs.length)
    await waitFor(async () => (await a.strategy.query({ podId: b.identity.podId }))[0]?.label === 'renamed again', 'a to hold the last record')
  })

  it('seq rises even when the clock does not (three announces in one millisecond), and the proof expires storeLifetimeMs after the clock', async () => {
    const bus = createBus()
    const b = await dhtOn(bus, (identity) => ({ bootstrapPeers: ['someone'], identity, signStores: true, now: () => 5_000_000, storeLifetimeMs: 60_000 }))
    for (const label of ['one', 'two', 'three']) await b.strategy.announce({ ...b.record, label })
    const seqs = b.wire.filter((m) => m.value.label !== undefined).map((m) => m.auth.seq)
    assert.ok(seqs.length >= 3)
    assert.deepEqual(seqs, [...new Set(seqs)].sort((x, y) => x - y))
    assert.equal(b.wire[0].auth.exp, 5_060_000)
  })

  it('a refusal on this node\'s own store is logged, not thrown', async () => {
    const bus = createBus()
    const logs = []
    const impostor = await PodIdentity.generate()
    const b = await dhtOn(bus, (identity) => ({ identity: impostor, signStores: true, storePolicy: { mode: 'owned' }, onLog: (name, data) => logs.push([name, data]), localPodId: identity.podId }))
    await b.strategy.announce(b.record)
    assert.deepEqual(await b.strategy.query({ podId: b.identity.podId }), [])
    assert.ok(logs.some(([name, data]) => name === 'mesh-dht:store-refused' && typeof data.refused === 'string'))
  })
})

describe('what the options need', () => {
  const base = (extra) => ({ localPodId: 'pod-x', transport: { send() {}, onMessage() {} }, ...extra })
  it('signStores needs an identity that signs', async () => {
    const id = await PodIdentity.generate()
    assert.throws(() => createMeshDht(base({ signStores: true })), /identity/)
    assert.throws(() => createMeshDht(base({ signStores: true, identity: {} })), /identity/)
    assert.ok(createMeshDht(base({ signStores: true, identity: id })))
  })

  it('an owned policy without signStores is allowed (a node that only holds records), and its own announce is refused and reported', async () => {
    const logs = []
    const { strategy } = createMeshDht(base({ storePolicy: 'owned', onLog: (n, d) => logs.push([n, d]) }))
    await strategy.start()
    await strategy.announce({ podId: 'pod-x' })
    assert.ok(logs.some(([n, d]) => n === 'mesh-dht:store-refused' && d.refused === 'unsigned-store'))
    assert.ok(createMeshDht(base({ storePolicy: 'open' })))
  })

  it('a policy, a lifetime and signStores are checked', async () => {
    const id = await PodIdentity.generate()
    assert.throws(() => createMeshDht(base({ storePolicy: 'sometimes' })), /storePolicy/)
    assert.throws(() => createMeshDht(base({ storePolicy: 5 })), /storePolicy/)
    for (const bad of [0, -1, 1.5, 'x']) assert.throws(() => createMeshDht(base({ signStores: true, identity: id, storeLifetimeMs: bad })), /storeLifetimeMs/)
    assert.throws(() => createMeshDht(base({ signStores: 'yes', identity: id })), /signStores/)
  })
})

describe('createMeshNode({ enableDht, dhtSignStores, dhtStorePolicy })', () => {
  it('a node that checks stores holds the records of nodes that sign, and discovers them', async () => {
    const bus = createBus()
    const a = await createMeshNode({ label: 'alice', signalingTransport: busTransport(bus), enableDht: true, dhtSignStores: true, dhtStorePolicy: 'owned' })
    const b = await createMeshNode({ label: 'bob', signalingTransport: busTransport(bus), enableDht: true, dhtSignStores: true, dhtBootstrapPeers: [a.podId] })
    try {
      await waitFor(async () => (await a.discover({ podId: b.podId })).some((r) => r.podId === b.podId), 'alice (owned) to discover bob (signed)')
      assert.equal(a.dht.storePolicy.mode, 'owned')
      assert.equal(b.dht.storePolicy, null)
      assert.equal(a.dht.dhtNode.storeStats.accepted >= 1, true)
    } finally {
      await a.shutdown()
      await b.shutdown()
    }
  })

  it('an owned node does not hold a record from a node that does not sign', async () => {
    const bus = createBus()
    const a = await createMeshNode({ label: 'alice', signalingTransport: busTransport(bus), enableDht: true, dhtSignStores: true, dhtStorePolicy: 'owned' })
    const old = await createMeshNode({ label: 'old', signalingTransport: busTransport(bus), enableDht: true, dhtBootstrapPeers: [a.podId] })
    try {
      await waitFor(() => a.dht.dhtNode.storeStats.refused['unsigned-store'] >= 1, 'alice to refuse the unsigned record')
      assert.equal((await a.discover({ podId: old.podId })).some((r) => r.podId === old.podId), false)
    } finally {
      await a.shutdown()
      await old.shutdown()
    }
  })

  it('without the new options nothing changes: no policy, no signing', async () => {
    const bus = createBus()
    const a = await createMeshNode({ label: 'alice', signalingTransport: busTransport(bus), enableDht: true })
    try {
      assert.equal(a.dht.storePolicy, null)
    } finally {
      await a.shutdown()
    }
  })

  it('an owned policy needs dhtSignStores, since the node announces itself and its own policy would refuse it', async () => {
    const bus = createBus()
    await assert.rejects(createMeshNode({ label: 'x', signalingTransport: busTransport(bus), enableDht: true, dhtStorePolicy: 'owned', skipBoot: true }), /dhtSignStores/)
    await assert.rejects(createMeshNode({ label: 'x', signalingTransport: busTransport(bus), enableDht: true, dhtStorePolicy: { mode: 'owned' }, skipBoot: true }), /dhtSignStores/)
  })

  it('the options are refused without enableDht, rather than ignored', async () => {
    const bus = createBus()
    await assert.rejects(createMeshNode({ label: 'x', signalingTransport: busTransport(bus), dhtSignStores: true, skipBoot: true }), /enableDht/)
    await assert.rejects(createMeshNode({ label: 'x', signalingTransport: busTransport(bus), dhtStorePolicy: 'open', skipBoot: true }), /enableDht/)
  })
})
