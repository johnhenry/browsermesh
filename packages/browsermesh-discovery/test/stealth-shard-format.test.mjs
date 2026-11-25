// Run with: node --import ./test/_setup-globals.mjs --test test/stealth-shard-format.test.mjs
// Shard format 3: a real checksum and Reed-Solomon parity, negotiated by key namespace
// (docs/design/discovery-records.md, items 1 and 2).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { DhtNode, StealthAgent, StealthError, StateShard, stealthShardChecksum } from '../src/index.mjs'
import { LegacyStealthPeer } from './support/legacy-stealth-peer.mjs'

const STATE = JSON.stringify({ memory: ['the launch code is 0000', 'snowman ☃ and a face \u{1F600}'], n: 42 })
const NONCE = 'AAECAwQFBgcICQoLDA0ODw'
const AGENT = 'agent-007'
const sha256Hex = (t) => createHash('sha256').update(t, 'utf8').digest('hex')
const key2 = (i) => `stealth:${AGENT}:shard:${i}`
const key3 = (i) => `stealth:${AGENT}:shard3:${i}`
const anon2 = (i) => sha256Hex(`browsermesh-stealth/lookup/1\0${AGENT}\0${NONCE}\0${i}`)
const anon3 = (i) => sha256Hex(`browsermesh-stealth/lookup/3\0${AGENT}\0${NONCE}\0${i}`)

function world(extra = {}) {
  const dhtNode = extra.dhtNode ?? new DhtNode({ localId: 'n', sendFn: () => {} })
  const make = (o = {}) => new StealthAgent({ agentId: AGENT, dhtNode, threshold: 3, totalShards: 5, ...extra, ...o })
  return { dhtNode, make }
}
const drop = (dht, keys) => { for (const k of keys) dht.store(k, { garbage: true }) }

// An independent checksum: node:crypto, hand-framed, over exactly the bytes the design note names.
function refChecksum({ index, threshold, total, code, len, bytes }) {
  const u32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
  const part = (x) => { const b = Buffer.from(x); return Buffer.concat([u32(b.length), b]) }
  const h = createHash('sha256').update(Buffer.concat([
    part('browsermesh-stealth/shard-checksum/3'), part(String(index)), part(String(threshold)), part(String(total)), part(code), part(String(len)), part(bytes),
  ]))
  return `s256.${h.digest('base64url')}`
}

describe('the checksum', () => {
  it('is the whole SHA-256 over the framed bytes: a fixed vector and an independent implementation agree', async () => {
    const args = { index: 2, threshold: 3, total: 5, code: 'rs', len: 11, bytes: new TextEncoder().encode('hello world') }
    assert.equal(await stealthShardChecksum(args), 's256.uyBM4JaLI-IO1hnQkD8BoEiGstZM9qHSM8WMVcpBj8I')
    assert.equal(await stealthShardChecksum(args), refChecksum(args))
    for (const change of [{ index: 3 }, { threshold: 2 }, { total: 6 }, { code: 'xor' }, { len: 12 }, { bytes: new TextEncoder().encode('hello worle') }]) {
      assert.notEqual(await stealthShardChecksum({ ...args, ...change }), await stealthShardChecksum(args), `covers ${Object.keys(change)}`)
    }
  })

  it('does not depend on the agent id, so an anonymous record cannot be tested against a guessed agent', async () => {
    const { dhtNode, make } = world({ identity: await PodIdentity.generate(), lookupNonce: NONCE, shardFormat: 3 })
    await make().hideSigned(STATE)
    const rec = dhtNode.get(anon3(0))
    assert.equal(rec.v, 3)
    assert.deepEqual(Object.keys(rec).sort(), ['checksum', 'code', 'data', 'i', 'len', 'seq', 'sig', 'v'])
    assert.equal(JSON.stringify(rec).includes(AGENT), false)
    const { dhtNode: other, make: make2 } = world({ identity: await PodIdentity.generate(), lookupNonce: NONCE, shardFormat: 3, agentId: 'someone-else' })
    await make2({ agentId: 'someone-else' }).hideSigned(STATE)
    const key = sha256Hex(`browsermesh-stealth/lookup/3\0someone-else\0${NONCE}\0${0}`)
    assert.equal(other.get(key).checksum, rec.checksum)
  })

  it('on the unsigned path it catches damage the old character-code sum cannot', async () => {
    // Swapping two characters keeps the sum: the format-2 collector accepts the damaged shard.
    const dht2 = new DhtNode({ localId: 'n', sendFn: () => {} })
    const old = new StealthAgent({ agentId: AGENT, dhtNode: dht2 })
    old.hide(STATE)
    const rec = dht2.get(key2(0))
    const swapped = rec.data.slice(0, 1) + rec.data[2] + rec.data[1] + rec.data.slice(3)
    dht2.store(key2(0), { ...rec, data: swapped })
    assert.notEqual(old.reconstitute(), STATE, 'format 2: the damage went unnoticed')

    const { dhtNode, make } = world({ shardFormat: 3 })
    const agent = make()
    await agent.hideAsync(STATE)
    const r3 = dhtNode.get(key3(0))
    const raw = Buffer.from(r3.data, 'base64url')
    const t = raw[1]; raw[1] = raw[2]; raw[2] = t
    dhtNode.store(key3(0), { ...r3, data: raw.toString('base64url') })
    assert.equal(await agent.reconstituteAsync(), STATE, 'format 3: the damaged shard is dropped, parity rebuilds it')
    assert.equal(agent.stats.shardCorrupt, 1)
  })

  it('on the signed path damage and forgery are counted apart, and damage is found before a signature is checked', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = world({ identity, shardFormat: 3 })
    const agent = make()
    await agent.hideSigned(STATE)
    const bad = dhtNode.get(key3(0))
    dhtNode.store(key3(0), { ...bad, data: Buffer.from('x'.repeat(Buffer.from(bad.data, 'base64url').length)).toString('base64url') }) // changed bytes, old checksum
    // a record someone else signed correctly over valid bytes
    const stranger = world({ identity: await PodIdentity.generate(), shardFormat: 3 })
    await stranger.make().hideSigned(STATE)
    dhtNode.store(key3(1), stranger.dhtNode.get(key3(1)))
    assert.equal(await agent.reconstituteSigned(), STATE)
    assert.equal(agent.stats.shardCorrupt, 1)
    assert.equal(agent.stats.shardBadSignature, 1)
  })
})

describe('parity', () => {
  it('Reed-Solomon rebuilds the state after ANY two shards are lost, data shards included (signed, anonymous)', async () => {
    const identity = await PodIdentity.generate()
    for (const lost of [[0, 1], [0, 4], [2, 3], [3, 4], [1, 2]]) {
      const { dhtNode, make } = world({ identity, lookupNonce: NONCE, shardFormat: 3 })
      const agent = make()
      await agent.hideSigned(STATE)
      drop(dhtNode, lost.map(anon3))
      assert.equal(await agent.reconstituteSigned(), STATE, `lost ${lost}`)
    }
  })

  it('three lost of five is unavailable (and says so), where the old XOR could not even take two', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = world({ identity, shardFormat: 3 })
    const agent = make()
    await agent.hideSigned(STATE)
    drop(dhtNode, [0, 1, 2].map(key3))
    assert.deepEqual(await agent.tryReconstituteSigned(), { ok: false, reason: 'unavailable' })
  })

  it('parity: "xor" in format 3 is the old one-loss parity under the new checksum', async () => {
    const identity = await PodIdentity.generate()
    const one = world({ identity, shardFormat: 3, parity: 'xor' })
    const a = one.make()
    await a.hideSigned(STATE)
    assert.equal(one.dhtNode.get(key3(0)).code, 'xor')
    drop(one.dhtNode, [key3(1)])
    assert.equal(await a.reconstituteSigned(), STATE)
    drop(one.dhtNode, [key3(2)])
    assert.deepEqual(await a.tryReconstituteSigned(), { ok: false, reason: 'unavailable' })
  })

  it('the unsigned path round-trips, loses two shards, and keeps unicode and a trailing NUL', async () => {
    const { dhtNode, make } = world({ shardFormat: 3 })
    const agent = make()
    const state = `${STATE}\0\0`
    await agent.hideAsync(state)
    drop(dhtNode, [key3(0), key3(3)])
    assert.equal(await agent.reconstituteAsync(), state)
  })

  it('refuses what format 3 cannot carry: a lone surrogate, too many shards, an oversized state', async () => {
    const { make } = world({ shardFormat: 3 })
    await assert.rejects(make().hideAsync('broken \ud800 text'), (e) => e instanceof StealthError && e.code === 'not-well-formed')
    await assert.rejects(make({ totalShards: 70 }).hideAsync(STATE), (e) => e instanceof StealthError && e.code === 'too-many-shards')
    await assert.rejects(make().hideAsync('x'.repeat(8 * 1024 * 1024 + 1)), (e) => e instanceof StealthError && e.code === 'state-too-large')
  })

  it('the parity code and the state length are signed (through the checksum): relabelling a record is refused, with or without a recomputed checksum', async () => {
    const identity = await PodIdentity.generate()
    // a different len with the same shard size, so only the declared length changes
    const nearLen = (len) => (len % 3 === 1 ? len + 1 : len - 1)
    for (const patch of [(r) => ({ code: 'xor' }), (r) => ({ len: nearLen(r.len) })]) {
      const { dhtNode, make } = world({ identity, shardFormat: 3 })
      const agent = make()
      await agent.hideSigned(STATE)
      for (let i = 0; i < 5; i++) dhtNode.store(key3(i), { ...dhtNode.get(key3(i)), ...patch(dhtNode.get(key3(i))) })
      assert.deepEqual(await agent.tryReconstituteSigned(), { ok: false, reason: 'unavailable' }, JSON.stringify(patch))
      assert.equal(agent.stats.shardCorrupt, 5, 'the stale checksum no longer matches: damage, found before any signature')
      // someone who recomputes the (public, unkeyed) checksum gets past that check and meets the signature
      const forger = make()
      for (let i = 0; i < 5; i++) {
        const rec = dhtNode.get(key3(i))
        dhtNode.store(key3(i), { ...rec, checksum: await stealthShardChecksum({ index: i, threshold: 3, total: 5, code: rec.code, len: rec.len, bytes: Buffer.from(rec.data, 'base64url') }) })
      }
      assert.deepEqual(await forger.tryReconstituteSigned(), { ok: false, reason: 'unavailable' })
      assert.equal(forger.stats.shardBadSignature, 5, 'the signature covers the checksum')
    }
  })

  it('a record whose declared length does not fit its data, or is absurd, is malformed and never decoded', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = world({ identity, shardFormat: 3 })
    const agent = make()
    await agent.hideSigned(STATE)
    for (let i = 0; i < 5; i++) dhtNode.store(key3(i), { ...dhtNode.get(key3(i)), len: 2 ** 40 })
    assert.deepEqual(await agent.tryReconstituteSigned(), { ok: false, reason: 'unavailable' })
    assert.equal(agent.stats.shardMalformed, 5)
  })

  it('a record with more data than any state may need is refused before it is decoded or hashed', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = world({ identity, shardFormat: 3 })
    const agent = make()
    await agent.hideSigned(STATE)
    const huge = 'A'.repeat(12 * 1024 * 1024)
    for (let i = 0; i < 5; i++) dhtNode.store(key3(i), { ...dhtNode.get(key3(i)), data: huge })
    assert.deepEqual(await agent.tryReconstituteSigned(), { ok: false, reason: 'unavailable' })
    assert.equal(agent.stats.shardMalformed, 5)
    assert.equal(agent.stats.shardCorrupt, 0, 'never hashed')
  })
})

describe('negotiation by key namespace: old peers, new peers, mixed swarms', () => {
  it('the double and the current module agree on format 2, both ways', async () => {
    const identity = await PodIdentity.generate()
    for (const lookupNonce of [null, NONCE]) {
      const { dhtNode, make } = world({ identity })
      const legacy = new LegacyStealthPeer({ agentId: AGENT, dhtNode, identity, lookupNonce })
      await make({ lookupNonce }).hideSigned(STATE)
      assert.equal(await legacy.reconstituteSigned(), STATE, 'the double reads what the module writes by default')
      const w2 = world({ identity })
      await new LegacyStealthPeer({ agentId: AGENT, dhtNode: w2.dhtNode, identity, lookupNonce }).hideSigned(STATE)
      assert.equal(await w2.make({ lookupNonce }).reconstituteSigned(), STATE, 'the module reads what the double writes')
    }
  })

  it('by default a writer is exactly what it was: format-2 keys and records, nothing in the new namespaces', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = world({ identity, lookupNonce: NONCE })
    const m = await make().hideSigned(STATE)
    assert.deepEqual(m.shardKeys, [0, 1, 2, 3, 4].map(anon2))
    for (let i = 0; i < 5; i++) {
      assert.equal(dhtNode.get(anon3(i)), undefined)
      assert.equal(dhtNode.get(anon2(i)).v, 2)
      assert.equal(typeof dhtNode.get(anon2(i)).checksum, 'number')
    }
    const plain = new DhtNode({ localId: 'p', sendFn: () => {} })
    new StealthAgent({ agentId: AGENT, dhtNode: plain }).hide(STATE)
    assert.deepEqual(Object.keys(plain.get(key2(0))).sort(), ['agentId', 'checksum', 'data', 'shardId', 'threshold', 'total'])
    assert.equal(plain.get(key3(0)), undefined)
  })

  it('new compat writer ([2, 3]) -> old reader: the old reader finds a valid format-2 set', async () => {
    const identity = await PodIdentity.generate()
    for (const lookupNonce of [null, NONCE]) {
      const { dhtNode, make } = world({ identity, lookupNonce })
      await make({ shardFormat: [2, 3] }).hideSigned(STATE)
      const old = new LegacyStealthPeer({ agentId: AGENT, dhtNode, identity, lookupNonce })
      assert.equal(await old.reconstituteSigned(), STATE)
      assert.deepEqual({ ...old.stats }, { shardUnsigned: 0, shardBadSignature: 0, shardStale: 0, shardMalformed: 0 })
    }
  })

  it('new writer, format 3 only -> old reader: it finds nothing and mis-verifies nothing; the new reader reads it', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = world({ identity })
    await make({ shardFormat: 3 }).hideSigned(STATE)
    const old = new LegacyStealthPeer({ agentId: AGENT, dhtNode, identity })
    await assert.rejects(old.reconstituteSigned(), /unavailable/)
    assert.deepEqual({ ...old.stats }, { shardUnsigned: 0, shardBadSignature: 0, shardStale: 0, shardMalformed: 0 })
    assert.equal(await make().reconstituteSigned(), STATE)
  })

  it('old writer -> new reader: read under the old rules, with the old counters', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = world({ identity })
    await new LegacyStealthPeer({ agentId: AGENT, dhtNode, identity }).hideSigned(STATE)
    const reader = make()
    assert.equal(await reader.reconstituteSigned(), STATE)
    assert.equal(reader.stats.shardCorrupt, 0)
    // and a format-3-only reader refuses to look at format 2
    assert.deepEqual(await make({ readFormats: [3] }).tryReconstituteSigned(), { ok: false, reason: 'unavailable' })
  })

  it('mixed swarm: the newest complete write wins across namespaces, and neither side is confused by the other', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = world({ identity })
    const old = new LegacyStealthPeer({ agentId: AGENT, dhtNode, identity })
    await old.hideSigned('first state')
    const modern = make({ shardFormat: 3 })
    await modern.hideSigned('second state, newer')
    assert.equal(await make().reconstituteSigned(), 'second state, newer')
    assert.equal(await old.reconstituteSigned(), 'first state', 'the old peer keeps seeing its own world')
    // an old writer writes again, later: the new reader follows the newer write
    await old.hideSigned('third state, newest')
    assert.equal(await make().reconstituteSigned(), 'third state, newest')
  })

  it('rollback, documented: if the newer format-3 set is destroyed a default reader falls back to an older complete set; readFormats [3] does not', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = world({ identity })
    await new LegacyStealthPeer({ agentId: AGENT, dhtNode, identity }).hideSigned('older state')
    const modern = make({ shardFormat: 3 })
    await modern.hideSigned('newer state')
    drop(dhtNode, [0, 1, 2].map(key3))
    assert.equal(await make().reconstituteSigned(), 'older state', 'default readers fall back')
    assert.deepEqual(await make({ readFormats: [3] }).tryReconstituteSigned(), { ok: false, reason: 'unavailable' })
  })

  it('compat writes of one state agree: the format-3 set wins a tie, either set alone is enough', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = world({ identity })
    await make({ shardFormat: [2, 3] }).hideSigned(STATE)
    drop(dhtNode, [0, 1, 2].map(key3))
    assert.equal(await make().reconstituteSigned(), STATE)
    drop(dhtNode, [0, 1, 2].map(key2))
    await make({ shardFormat: [2, 3] }).hideSigned(STATE)
    drop(dhtNode, [0, 1, 2].map(key2))
    assert.equal(await make().reconstituteSigned(), STATE)
  })

  it('hostile: a record at a format-3 key that is really a format-2 record, or has an unknown version, is refused', async () => {
    const identity = await PodIdentity.generate()
    const { dhtNode, make } = world({ identity })
    await make().hideSigned(STATE) // format 2 only
    for (let i = 0; i < 5; i++) dhtNode.store(key3(i), dhtNode.get(key2(i)))
    const reader = make({ readFormats: [3] })
    assert.deepEqual(await reader.tryReconstituteSigned(), { ok: false, reason: 'unavailable' })
    for (let i = 0; i < 5; i++) dhtNode.store(key3(i), { ...dhtNode.get(key3(i)), v: 4 })
    assert.deepEqual(await make({ readFormats: [3] }).tryReconstituteSigned(), { ok: false, reason: 'unavailable' })
  })

  it('options are validated by name', () => {
    const { make } = world()
    for (const o of [{ shardFormat: 4 }, { shardFormat: [] }, { shardFormat: [2, 5] }, { readFormats: [] }, { readFormats: ['2'] }, { parity: 'raid' }]) {
      assert.throws(() => make(o), (e) => e instanceof StealthError && e.code === 'bad-argument', JSON.stringify(o))
    }
  })

  it('the synchronous API stays format 2: it refuses to write format 3 rather than quietly write something else', () => {
    const { make } = world({ shardFormat: 3 })
    assert.throws(() => make().hide(STATE), (e) => e instanceof StealthError && e.code === 'async-required')
    assert.equal(new StateShard({ shardId: 'a:shard:0', agentId: 'a', data: 'x', threshold: 1, total: 1, checksum: 120 }).verify(), true, 'the old shard class still verifies its sum')
  })
})
