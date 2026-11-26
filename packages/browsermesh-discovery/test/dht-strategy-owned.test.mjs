// Run with: node --import ./test/_setup-globals.mjs --test test/dht-strategy-owned.test.mjs
// `DhtDiscoveryStrategy` and owned stores: the strategy can hold a store policy and sign what it announces (opt-in).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { DhtDiscoveryStrategy, DHT_STORE, signDhtStore } from '../src/index.mjs'

const clock = (start = 1_000_000) => { const c = { t: start, now: () => c.t }; return c }

async function rig(options = {}) {
  const identity = await PodIdentity.generate()
  const sent = []
  const c = clock()
  const strategy = new DhtDiscoveryStrategy({
    localId: identity.podId,
    sendFn: (to, msg) => sent.push([to, msg]),
    bootstrapContacts: [{ podId: 'peer-1' }, { podId: 'peer-2' }],
    now: c.now,
    ...options,
  })
  await strategy.start()
  return { identity, strategy, sent, c, record: { podId: identity.podId, label: 'me' } }
}
const signer = (identity, c) => async (key, record) => signDhtStore({ signer: identity, key, value: record, seq: 1, exp: c.now() + 3_600_000 })

describe('a strategy with no new options is what it was', () => {
  it('announce stores the record unsigned and the node has no store policy', async () => {
    const { strategy, record, sent } = await rig()
    assert.equal(strategy.storePolicy, null)
    await strategy.announce(record)
    assert.deepEqual((await strategy.query({ podId: record.podId })), [record])
    assert.ok(sent.length > 0)
    for (const [, msg] of sent) assert.equal(msg.type, DHT_STORE)
    for (const [, msg] of sent) assert.equal('auth' in msg, false)
  })
})

describe('storePolicy', () => {
  it('is handed to the node: the strategy reports it, and the node applies it', async () => {
    const { strategy } = await rig({ storePolicy: { mode: 'owned' } })
    assert.equal(strategy.storePolicy.mode, 'owned')
    const stranger = await PodIdentity.generate()
    const value = { podId: stranger.podId }
    const unsigned = await strategy.dhtNode.handleMessage('peer-1', { type: DHT_STORE, from: 'peer-1', key: stranger.podId, value, ttl: 0 })
    assert.equal(unsigned.stored, false)
    assert.equal(unsigned.refused, 'unsigned-store')
    const signed = await strategy.dhtNode.handleMessage('peer-1', { type: DHT_STORE, from: 'peer-1', key: stranger.podId, value, ttl: 0, auth: await signDhtStore({ signer: stranger, key: stranger.podId, value, seq: 1, exp: 2_000_000 }) })
    assert.equal(signed.stored, true)
  })

  it('a policy that is not one is refused when the strategy is built', () => {
    assert.throws(() => new DhtDiscoveryStrategy({ localId: 'x', storePolicy: { mode: 'sometimes' } }), /storePolicy/)
  })
})

describe('signStore', () => {
  it('announce stores under the pod\'s key with a proof, owned by the pod, and replicates the proof with the value', async () => {
    const identity = await PodIdentity.generate()
    const c = clock()
    const sent = []
    const strategy = new DhtDiscoveryStrategy({
      localId: identity.podId, sendFn: (to, msg) => sent.push([to, msg]), bootstrapContacts: [{ podId: 'peer-1' }], now: c.now,
      storePolicy: { mode: 'owned' }, signStore: signer(identity, c),
    })
    await strategy.start()
    const record = { podId: identity.podId, label: 'me' }
    await strategy.announce(record)
    assert.deepEqual(await strategy.query({ podId: record.podId }), [record])
    assert.equal(strategy.dhtNode.ownerOf(record.podId), Buffer.from(await identity.rawPublicKey()).toString('base64url'))
    assert.ok(sent.length > 0)
    for (const [, msg] of sent) assert.ok(msg.auth && msg.auth.v === 1, 'the replicated store carries its proof')
  })

  it('under an owned policy an announce with no signer is refused, reported and never thrown', async () => {
    const refusals = []
    const { strategy, record } = await rig({ storePolicy: { mode: 'owned' }, onStoreRefused: (r) => refusals.push(r) })
    await strategy.announce(record)
    assert.deepEqual(await strategy.query({ podId: record.podId }), [])
    assert.deepEqual(refusals, [{ key: record.podId, refused: 'unsigned-store' }])
  })

  it('a signer that fails stores nothing (never an unsigned store in its place) and is reported', async () => {
    const refusals = []
    const { strategy, record } = await rig({ signStore: async () => { throw new Error('no key') }, onStoreRefused: (r) => refusals.push(r) })
    await strategy.announce(record)
    assert.deepEqual(await strategy.query({ podId: record.podId }), [])
    assert.deepEqual(refusals, [{ key: record.podId, refused: 'sign-failed' }])
  })

  it('a signer that returns nothing stores unsigned, as before', async () => {
    const { strategy, record } = await rig({ signStore: async () => undefined })
    await strategy.announce(record)
    assert.deepEqual(await strategy.query({ podId: record.podId }), [record])
  })

  it('a signer that is not a function is refused when the strategy is built', () => {
    assert.throws(() => new DhtDiscoveryStrategy({ localId: 'x', signStore: 'yes' }), /signStore/)
  })

  it('a proof for a key the signer does not own is refused by the node, named, and reported', async () => {
    const refusals = []
    const other = await PodIdentity.generate()
    const { record, c } = await rig()
    const wrong =new DhtDiscoveryStrategy({ localId: record.podId, sendFn: () => {}, now: c.now, storePolicy: { mode: 'owned' }, signStore: signer(other, c), onStoreRefused: (r) => refusals.push(r) })
    await wrong.start()
    await wrong.announce(record)
    assert.deepEqual(await wrong.query({ podId: record.podId }), [])
    assert.equal(refusals.length, 1)
    assert.equal(refusals[0].key, record.podId)
    assert.match(refusals[0].refused, /not-key-owner|bad-auth|unbound-key/)
  })
})
