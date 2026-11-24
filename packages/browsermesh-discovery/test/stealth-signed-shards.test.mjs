// Run with: node --import ./test/_setup-globals.mjs --test test/stealth-signed-shards.test.mjs
// #230: shards signed by the agent's identity and verified on read; DHT keys that do not name the agent.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { DhtNode, StealthAgent, StealthError, deriveStealthKey, deriveStealthLookupNonce } from '../src/index.mjs'

const STATE = JSON.stringify({ memory: ['the launch code is 0000'], n: 42 })
const NONCE = 'AAECAwQFBgcICQoLDA0ODw' // 16 bytes, base64url

function setup(extra = {}) {
  const dhtNode = extra.dhtNode ?? new DhtNode({ localId: 'n', sendFn: () => {} })
  const make = (o = {}) => new StealthAgent({ agentId: 'agent-007', dhtNode, threshold: 3, totalShards: 5, ...extra, ...o })
  return { dhtNode, make }
}
const legacyKey = (i) => `stealth:agent-007:shard:${i}`

describe('signed shards', () => {
  it('round-trips, and every stored shard carries a signature', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = setup({ identity })
    const agent = make()
    const manifest = await agent.hideSigned(STATE)
    assert.equal(manifest.signed, true)
    for (let i = 0; i < 5; i++) assert.equal(typeof dhtNode.get(legacyKey(i)).sig, 'string')
    assert.equal(await agent.reconstituteSigned(), STATE)
    assert.deepEqual(await agent.tryReconstituteSigned(), { ok: true, state: STATE })
  })

  it('a shard whose data was changed is refused and counted; parity still recovers one lost shard', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = setup({ identity })
    const agent = make()
    await agent.hideSigned(STATE)
    dhtNode.store(legacyKey(0), { ...dhtNode.get(legacyKey(0)), data: 'tampered!' })
    assert.equal(await agent.reconstituteSigned(), STATE)
    assert.equal(agent.stats.shardBadSignature, 1)
  })

  it('with too few valid shards left it says unavailable, and counts what it refused', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = setup({ identity })
    const agent = make()
    await agent.hideSigned(STATE)
    for (const i of [0, 1, 2]) dhtNode.store(legacyKey(i), { ...dhtNode.get(legacyKey(i)), data: 'x'.repeat(8) })
    assert.deepEqual(await agent.tryReconstituteSigned(), { ok: false, reason: 'unavailable' })
    assert.equal(agent.stats.shardBadSignature, 3)
    await assert.rejects(agent.reconstituteSigned(), (e) => e instanceof StealthError && e.code === 'unavailable')
  })

  it('shards signed by someone else are refused (and trustedKeys admits a chosen other)', async () => {
    const mine = await PodIdentity.generate()
    const theirs = await PodIdentity.generate()
    const { dhtNode, make } = setup()
    await make({ identity: theirs }).hideSigned(STATE)
    const reader = make({ identity: mine })
    assert.deepEqual(await reader.tryReconstituteSigned(), { ok: false, reason: 'unavailable' })
    assert.equal(reader.stats.shardBadSignature, 5)
    const trusting = make({ identity: mine, trustedKeys: [await theirs.rawPublicKey()] })
    assert.equal(await trusting.reconstituteSigned(), STATE)
    void dhtNode
  })

  it('a valid shard moved to another key is refused: the signature binds the key and the index', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = setup({ identity })
    const agent = make()
    await agent.hideSigned(STATE)
    const real = dhtNode.get(legacyKey(1))
    dhtNode.store(legacyKey(0), real) // shard 1's record where shard 0 belongs
    assert.equal(await agent.reconstituteSigned(), STATE) // recovered from the rest
    assert.equal(agent.stats.shardBadSignature, 1)
  })

  it('an unsigned shard (an older writer) is refused by default, and accepted only with allowUnsigned', async () => {
    const dhtNode = new DhtNode({ localId: 'n', sendFn: () => {} })
    new StealthAgent({ agentId: 'agent-007', dhtNode, threshold: 3, totalShards: 5 }).hide(STATE) // the old, unsigned write
    const identity = await PodIdentity.generate()
    const strict = new StealthAgent({ agentId: 'agent-007', dhtNode, threshold: 3, totalShards: 5, identity })
    assert.deepEqual(await strict.tryReconstituteSigned(), { ok: false, reason: 'unavailable' })
    assert.equal(strict.stats.shardUnsigned, 5)
    const lax = new StealthAgent({ agentId: 'agent-007', dhtNode, threshold: 3, totalShards: 5, identity, allowUnsigned: true })
    assert.equal(await lax.reconstituteSigned(), STATE)
    assert.equal(lax.stats.shardUnsignedAccepted, 5)
  })

  it('an older write restored over a newer one is not mixed in: the newest complete set wins', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = setup({ identity })
    const agent = make()
    await agent.hideSigned('first state')
    const old0 = dhtNode.get(legacyKey(0))
    await agent.hideSigned('second state, longer than the first one')
    dhtNode.store(legacyKey(0), old0)
    assert.equal(await agent.reconstituteSigned(), 'second state, longer than the first one')
    assert.equal(agent.stats.shardStale, 1)
  })

  it('an agent with an identity never writes or reads shards unsigned by accident', async () => {
    const identity = await PodIdentity.generate()
    const { make } = setup({ identity })
    const agent = make()
    assert.throws(() => agent.hide(STATE), (e) => e.code === 'async-required')
    assert.throws(() => agent.reconstitute(), (e) => e.code === 'async-required')
    assert.throws(() => agent.isViable(), (e) => e.code === 'async-required')
    await assert.rejects(setup().make().hideSigned(STATE), (e) => e.code === 'no-identity')
  })

  it('hideEncrypted / reconstituteEncrypted sign and verify too, and the DHT holds no plaintext', async () => {
    const identity = await PodIdentity.generate()
    const key = await deriveStealthKey(new Uint8Array(32).fill(9), 'group-a')
    const { dhtNode, make } = setup({ identity, key })
    const agent = make()
    await agent.hideEncrypted(STATE)
    assert.ok(!JSON.stringify([0, 1, 2, 3, 4].map((i) => dhtNode.get(legacyKey(i)))).includes('launch'))
    for (let i = 0; i < 5; i++) assert.equal(typeof dhtNode.get(legacyKey(i)).sig, 'string')
    assert.equal(await agent.reconstituteEncrypted(), STATE)
    dhtNode.store(legacyKey(4), { ...dhtNode.get(legacyKey(4)), data: 'forged' })
    assert.deepEqual(await agent.tryReconstituteEncrypted(), { ok: true, state: STATE })
    assert.equal(agent.stats.shardBadSignature, 1)
  })

  it('agents without an identity are unchanged: the plain and encrypted paths behave as before', async () => {
    const key = await deriveStealthKey(new Uint8Array(32).fill(9), 'group-a')
    const { dhtNode, make } = setup({ key })
    const agent = make()
    agent.hide(STATE)
    assert.equal(agent.reconstitute(), STATE)
    assert.equal(agent.isViable(), true)
    assert.equal(dhtNode.get(legacyKey(0)).sig, undefined)
    await agent.hideEncrypted(STATE)
    assert.equal(await agent.reconstituteEncrypted(), STATE)
  })
})

describe('agent-anonymous DHT keys', () => {
  async function anon(extra = {}) {
    const identity = await PodIdentity.generate()
    const s = setup({ identity, lookupNonce: NONCE, ...extra })
    return { identity, ...s }
  }

  it('keys are SHA-256 of the agent id, a secret nonce and the index: no agent id, no index, no prefix', async () => {
    const { dhtNode, make, identity } = await anon()
    const agent = make()
    const manifest = await agent.hideSigned(STATE)
    assert.equal(manifest.anonymous, true)
    assert.equal(manifest.shardKeys.length, 5)
    assert.equal(new Set(manifest.shardKeys).size, 5)
    for (const k of manifest.shardKeys) {
      assert.match(k, /^[0-9a-f]{64}$/)
      assert.ok(!k.includes('agent-007') && !k.includes('stealth'))
    }
    const expected = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`browsermesh-stealth/lookup/1\0agent-007\0${NONCE}\0${0}`))
    assert.equal(manifest.shardKeys[0], Buffer.from(expected).toString('hex'))
    assert.equal(dhtNode.get(legacyKey(0)), undefined, 'nothing under the old, agent-naming keys')
    assert.equal(await agent.reconstituteSigned(), STATE)
    void identity
  })

  it('what an observer of the DHT reads names neither the agent nor its identity', async () => {
    const { dhtNode, make, identity } = await anon()
    const agent = make()
    const manifest = await agent.hideSigned(STATE)
    const everything = JSON.stringify(manifest.shardKeys.map((k) => [k, dhtNode.get(k)]))
    assert.ok(!everything.includes('agent-007'))
    assert.ok(!everything.includes(identity.podId))
    assert.ok(!everything.includes('shard:'))
    const rawPub = Buffer.from(await identity.rawPublicKey())
    assert.ok(!everything.includes(rawPub.toString('base64')) && !everything.includes(rawPub.toString('base64url')))
  })

  it('without the nonce the shards cannot be found, and another nonce finds other keys', async () => {
    const { identity, dhtNode, make } = await anon()
    await make().hideSigned(STATE)
    const wrong = make({ lookupNonce: 'ZZECAwQFBgcICQoLDA0ODw' })
    assert.deepEqual(await wrong.tryReconstituteSigned(), { ok: false, reason: 'unavailable' })
    const legacy = new StealthAgent({ agentId: 'agent-007', dhtNode, threshold: 3, totalShards: 5, identity })
    assert.deepEqual(await legacy.tryReconstituteSigned(), { ok: false, reason: 'unavailable' }, 'the old, guessable keys hold nothing')
  })

  it('two agents with the same nonce but different ids, and one agent with two nonces, never share keys', async () => {
    const identity = await PodIdentity.generate()
    const { make } = setup({ identity, lookupNonce: NONCE })
    const a = await make().hideSigned('a')
    const b = await make({ agentId: 'agent-008' }).hideSigned('b')
    const c = await make({ lookupNonce: 'BBECAwQFBgcICQoLDA0ODw' }).hideSigned('c')
    const all = [...a.shardKeys, ...b.shardKeys, ...c.shardKeys]
    assert.equal(new Set(all).size, 15)
  })

  it('a shard copied from another nonce\'s key set is refused', async () => {
    const { dhtNode, make } = await anon()
    const a = make()
    const b = make({ lookupNonce: 'BBECAwQFBgcICQoLDA0ODw' })
    const ka = (await a.hideSigned('state a')).shardKeys
    const kb = (await b.hideSigned('state b')).shardKeys
    dhtNode.store(ka[0], dhtNode.get(kb[0]))
    assert.equal(await a.reconstituteSigned(), 'state a')
    assert.equal(a.stats.shardBadSignature, 1)
  })

  it('deriveStealthLookupNonce: the same group, agent and epoch give the same nonce; any change gives another', async () => {
    const secret = new Uint8Array(32).fill(5)
    const n = await deriveStealthLookupNonce(secret, 'agent-007', 0)
    assert.match(n, /^[A-Za-z0-9_-]{22,}$/)
    assert.equal(await deriveStealthLookupNonce(secret, 'agent-007', 0), n)
    assert.notEqual(await deriveStealthLookupNonce(secret, 'agent-007', 1), n)
    assert.notEqual(await deriveStealthLookupNonce(secret, 'agent-008', 0), n)
    assert.notEqual(await deriveStealthLookupNonce(new Uint8Array(32).fill(6), 'agent-007', 0), n)
    await assert.rejects(deriveStealthLookupNonce(new Uint8Array(4), 'a'), /at least 16 bytes/)
  })

  it('a short or malformed lookup nonce is refused', () => {
    const dhtNode = new DhtNode({ localId: 'n', sendFn: () => {} })
    for (const bad of ['short', 'has space and is long enough!!', 5]) {
      assert.throws(() => new StealthAgent({ agentId: 'a', dhtNode, lookupNonce: bad }), (e) => e.code === 'bad-argument')
    }
  })
})
