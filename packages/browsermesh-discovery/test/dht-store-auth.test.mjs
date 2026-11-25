// Run with: node --import ./test/_setup-globals.mjs --test test/dht-store-auth.test.mjs
// Who may store under which key (docs/design/discovery-records.md, item 3).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import {
  DhtNode, DHT_STORE, DHT_PING, DHT_FIND_VALUE, StealthAgent, StealthError,
  canonicalJson, dhtStoreSigningBytes, signDhtStore, verifyDhtStore, deriveWriteSigner, classifyStoreKey, DHT_STORE_REFUSALS,
} from '../src/index.mjs'
import { LegacyDhtNode } from './support/legacy-dht-node.mjs'

const b64u = (b) => Buffer.from(b).toString('base64url')
const pubOf = async (identity) => b64u(await identity.rawPublicKey())
const clock = (start = 1_000_000) => { const c = { t: start, now: () => c.t }; return c }
const ANON = (n = 0) => createHash('sha256').update(`some secret ${n}`).digest('hex')

/** A store message as a peer would put it on the wire. */
async function storeMsg(signer, key, value, { seq = 1, exp, ttl = 0, from = 'peer' } = {}) {
  const msg = { type: DHT_STORE, from, key, value, ttl }
  if (signer) msg.auth = await signDhtStore({ signer, key, value, seq, exp })
  return msg
}
const refused = (name) => (r) => r.stored === false && r.refused === name

describe('canonical JSON and the signed bytes', () => {
  it('is independent of key order and rejects what JSON cannot carry', () => {
    assert.equal(canonicalJson({ b: 1, a: [true, null, 'x', { z: 1, y: 2 }] }), canonicalJson({ a: [true, null, 'x', { y: 2, z: 1 }], b: 1 }))
    assert.equal(canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}')
    for (const bad of [undefined, () => 1, NaN, Infinity, 10n, Symbol('s'), { a: undefined }]) assert.throws(() => canonicalJson(bad), /canonical/, String(bad))
    const loop = {}; loop.self = loop
    assert.throws(() => canonicalJson(loop), /canonical/)
  })

  it('the signed bytes are the framed domain, key, SHA-256 of the canonical value, seq and exp: an independent implementation agrees', async () => {
    const key = 'some-key'; const value = { b: 1, a: 'x' }
    const u32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
    const part = (x) => { const b = Buffer.from(x); return Buffer.concat([u32(b.length), b]) }
    const digest = createHash('sha256').update('{"a":"x","b":1}').digest()
    const expected = Buffer.concat([part('browsermesh-dht-store/1'), part(key), part(digest), part('7'), part('5000')])
    assert.deepEqual(Buffer.from(await dhtStoreSigningBytes({ key, value, seq: 7, exp: 5000 })), expected)
  })

  it('a proof verifies, and any change of key, value, seq, exp or signer fails it', async () => {
    const id = await PodIdentity.generate()
    const auth = await signDhtStore({ signer: id, key: 'k', value: { n: 1 }, seq: 3, exp: 9000 })
    assert.equal(await verifyDhtStore({ key: 'k', value: { n: 1 }, auth }), true)
    assert.equal(await verifyDhtStore({ key: 'k2', value: { n: 1 }, auth }), false)
    assert.equal(await verifyDhtStore({ key: 'k', value: { n: 2 }, auth }), false)
    assert.equal(await verifyDhtStore({ key: 'k', value: { n: 1 }, auth: { ...auth, seq: 4 } }), false)
    assert.equal(await verifyDhtStore({ key: 'k', value: { n: 1 }, auth: { ...auth, exp: 9001 } }), false)
    const other = await PodIdentity.generate()
    assert.equal(await verifyDhtStore({ key: 'k', value: { n: 1 }, auth: { ...auth, w: await pubOf(other) } }), false)
    for (const bad of [null, {}, { ...auth, v: 2 }, { ...auth, sig: 'x' }, { ...auth, seq: -1 }, { ...auth, w: 'short' }]) assert.equal(await verifyDhtStore({ key: 'k', value: { n: 1 }, auth: bad }), false)
  })

  it('classifies keys by what they look like', () => {
    assert.equal(classifyStoreKey(b64u(createHash('sha256').update('p').digest())), 'pod')
    assert.equal(classifyStoreKey(ANON()), 'anon')
    assert.equal(classifyStoreKey('stealth:agent-1:shard3:2'), 'stealth-plain')
    assert.equal(classifyStoreKey('stealth:agent-1:shard:2'), 'other')
    assert.equal(classifyStoreKey('some app key'), 'other')
  })
})

describe('a node without a policy is exactly the old node', () => {
  it('behaves like the independent old-node double on a script of messages, and says nothing new in a ping', async () => {
    const c = clock()
    const a = new DhtNode({ localId: 'n', now: c.now })
    const b = new LegacyDhtNode({ localId: 'n', now: c.now })
    const id = await PodIdentity.generate()
    const script = [
      { type: DHT_PING },
      { type: DHT_STORE, key: 'k1', value: { x: 1 }, ttl: 0 },
      { type: DHT_STORE, key: 'k1', value: { x: 2 }, ttl: 50 },
      { type: DHT_STORE, key: id.podId, value: { y: 1 }, ttl: 0, auth: await signDhtStore({ signer: id, key: id.podId, value: { y: 1 }, seq: 1, exp: c.t + 1000 }) },
      { type: DHT_STORE, key: id.podId, value: { y: 2 }, ttl: 0 },
      { type: DHT_FIND_VALUE, key: 'k1' },
      { type: DHT_FIND_VALUE, key: id.podId },
    ]
    for (const m of script) {
      const ra = a.handleMessage('p', m); const rb = b.handleMessage('p', m)
      const strip = (r) => (r && 'closest' in r ? { ...r, closest: undefined } : r)
      assert.deepEqual(strip(ra), strip(rb), JSON.stringify(m.type))
      assert.ok(!(ra instanceof Promise))
    }
    c.t += 100
    assert.equal(a.get('k1'), undefined)
    assert.deepEqual(a.get(id.podId), { y: 2 })
    assert.equal(a.ownerOf(id.podId), null)
  })
})

describe('open policy: nothing old changes, owned keys are protected', () => {
  it('accepts an unsigned store as always, and a signed one without taking ownership of an unowned legacy key', async () => {
    const c = clock()
    const node = new DhtNode({ localId: 'n', now: c.now, storePolicy: { mode: 'open' } })
    const id = await PodIdentity.generate()
    assert.deepEqual(await node.handleMessage('p', await storeMsg(null, 'legacy-key', { a: 1 })), { type: DHT_STORE, from: 'n', stored: true })
    const signed = await storeMsg(id, 'legacy-key', { a: 2 }, { exp: c.t + 1000 })
    assert.equal((await node.handleMessage('p', signed)).stored, true)
    assert.equal(node.ownerOf('legacy-key'), null, 'a legacy key is never pinned in open mode: no first-writer lock-out of an old writer')
    assert.equal((await node.handleMessage('p', await storeMsg(null, 'legacy-key', { a: 3 }))).stored, true)
  })

  it('a pod key is owned by the pod it names: only that key may store there, with a rising seq', async () => {
    const c = clock()
    const node = new DhtNode({ localId: 'n', now: c.now, storePolicy: { mode: 'open' } })
    const owner = await PodIdentity.generate()
    const other = await PodIdentity.generate()
    const key = owner.podId
    assert.equal((await node.handleMessage('p', await storeMsg(owner, key, { v: 1 }, { seq: 1, exp: c.t + 1000 }))).stored, true)
    assert.equal(node.ownerOf(key), await pubOf(owner))
    // someone else's store under that key, signed or not
    assert.ok(refused('not-key-owner')(await node.handleMessage('x', await storeMsg(other, key, { v: 'evil' }, { seq: 99, exp: c.t + 1000 }))), 'a pod key names its owner: another pod\'s proof does not match it')
    assert.ok(refused('owned-key')(await node.handleMessage('x', await storeMsg(null, key, { v: 'evil' }))))
    assert.deepEqual(node.get(key), { v: 1 })
    // the owner: higher seq replaces, the same or a lower one is a replay
    assert.ok(refused('stale-seq')(await node.handleMessage('p', await storeMsg(owner, key, { v: 0 }, { seq: 1, exp: c.t + 1000 }))))
    assert.equal((await node.handleMessage('p', await storeMsg(owner, key, { v: 2 }, { seq: 2, exp: c.t + 1000 }))).stored, true)
    assert.deepEqual(node.get(key), { v: 2 })
  })

  it('a signed store for a pod key by a pod that is not that pod is refused as not the owner', async () => {
    const node = new DhtNode({ localId: 'n', storePolicy: { mode: 'open' } })
    const victim = await PodIdentity.generate()
    const attacker = await PodIdentity.generate()
    const r = await node.handleMessage('x', await storeMsg(attacker, victim.podId, { v: 'evil' }, { exp: Date.now() + 1000 }))
    assert.ok(refused('not-key-owner')(r))
    assert.equal(node.get(victim.podId), undefined)
  })

  it('a bad proof is refused by name, whatever the key', async () => {
    const node = new DhtNode({ localId: 'n', storePolicy: { mode: 'open' } })
    const id = await PodIdentity.generate()
    const m = await storeMsg(id, 'k', { a: 1 }, { exp: Date.now() + 1000 })
    assert.ok(refused('bad-auth')(await node.handleMessage('p', { ...m, value: { a: 2 } })))
    assert.ok(refused('bad-auth')(await node.handleMessage('p', { ...m, key: 'k2' })))
    assert.ok(refused('bad-auth')(await node.handleMessage('p', { ...m, auth: { ...m.auth, sig: 'AAAA' } })))
    assert.ok(refused('bad-auth')(await node.handleMessage('p', { ...m, auth: 'nope' })))
    assert.equal(node.get('k'), undefined)
  })

  it('a proof cannot be replayed: not after a newer write, and not after it expires', async () => {
    const c = clock()
    const node = new DhtNode({ localId: 'n', now: c.now, storePolicy: { mode: 'open' } })
    const owner = await PodIdentity.generate()
    const m1 = await storeMsg(owner, owner.podId, { v: 1 }, { seq: 1, exp: c.t + 1000 })
    const m2 = await storeMsg(owner, owner.podId, { v: 2 }, { seq: 2, exp: c.t + 1000 })
    await node.handleMessage('p', m1); await node.handleMessage('p', m2)
    assert.ok(refused('stale-seq')(await node.handleMessage('x', m1)), 'the captured first write does not undo the second')
    c.t += 2000
    assert.ok(refused('expired')(await node.handleMessage('x', m2)), 'nor does a captured message revive an expired record')
    assert.equal(node.get(owner.podId), undefined, 'the entry itself stops at exp')
  })

  it('an entry never outlives its signed expiry, even with no ttl', async () => {
    const c = clock()
    const node = new DhtNode({ localId: 'n', now: c.now, storePolicy: { mode: 'open' } })
    const owner = await PodIdentity.generate()
    await node.handleMessage('p', await storeMsg(owner, owner.podId, { v: 1 }, { exp: c.t + 500 }))
    assert.deepEqual(node.get(owner.podId), { v: 1 })
    assert.equal(node.findValue(owner.podId).found, true)
    c.t += 501
    assert.equal(node.get(owner.podId), undefined)
    assert.equal(node.findValue(owner.podId).found, false)
  })

  it('a ping reply advertises the policy; a policy-less node advertises nothing', async () => {
    const withPolicy = new DhtNode({ localId: 'n', storePolicy: { mode: 'owned' } })
    assert.deepEqual((await withPolicy.handleMessage('p', { type: DHT_PING })).caps, { store: 1, policy: 'owned' })
    assert.equal('caps' in new DhtNode({ localId: 'n' }).handleMessage('p', { type: DHT_PING }), false)
  })
})

describe('owned policy: every store carries a proof, with bounds', () => {
  const owned = (extra = {}, c = clock()) => ({ c, node: new DhtNode({ localId: 'n', now: c.now, storePolicy: { mode: 'owned', ...extra } }) })

  it('refuses a store with no proof, and one for a key the proof does not own', async () => {
    const { c, node } = owned()
    const id = await PodIdentity.generate()
    assert.ok(refused('unsigned-store')(await node.handleMessage('p', await storeMsg(null, 'k', { a: 1 }))))
    assert.ok(refused('not-key-owner')(await node.handleMessage('p', await storeMsg(id, ANON().slice(0, 43), { a: 1 }, { exp: c.t + 1000 }))), 'a key shaped like a pod id must be that pod')
    assert.ok(refused('not-key-owner')(await node.handleMessage('p', await storeMsg(id, `stealth:${(await PodIdentity.generate()).podId}:shard3:0`, { a: 1 }, { exp: c.t + 1000 }))))
    assert.equal((await node.handleMessage('p', await storeMsg(id, `stealth:${id.podId}:shard3:0`, { a: 1 }, { exp: c.t + 1000 }))).stored, true)
  })

  it('pins any other key to its first valid signer: a store under someone else\'s key is refused', async () => {
    const { c, node } = owned()
    const first = await PodIdentity.generate(); const second = await PodIdentity.generate()
    const key = ANON(1)
    assert.equal((await node.handleMessage('p', await storeMsg(first, key, { a: 1 }, { seq: 1, exp: c.t + 1000 }))).stored, true)
    assert.ok(refused('owned-key')(await node.handleMessage('q', await storeMsg(second, key, { a: 'evil' }, { seq: 50, exp: c.t + 1000 }))))
    assert.ok(refused('owned-key')(await node.handleMessage('q', await storeMsg(null, key, { a: 'evil' }))))
    assert.deepEqual(node.get(key), { a: 1 })
    c.t += 2000 // after the entry lapses the key is free again
    assert.equal((await node.handleMessage('q', await storeMsg(second, key, { a: 'mine' }, { seq: 1, exp: c.t + 1000 }))).stored, true)
  })

  it('openPrefixes keep named keys open (unsigned stores accepted there), nothing else', async () => {
    const { node } = owned({ openPrefixes: ['app/'] })
    assert.equal((await node.handleMessage('p', await storeMsg(null, 'app/note', { a: 1 }))).stored, true)
    assert.ok(refused('unsigned-store')(await node.handleMessage('p', await storeMsg(null, 'other/note', { a: 1 }))))
  })

  it('bounds the size of a value, the lifetime of a record and an expiry already past', async () => {
    const { c, node } = owned({ maxValueBytes: 64, maxLifetimeMs: 10_000 })
    const id = await PodIdentity.generate()
    const key = ANON(2)
    assert.ok(refused('value-too-large')(await node.handleMessage('p', await storeMsg(id, key, { blob: 'x'.repeat(100) }, { exp: c.t + 1000 }))))
    assert.ok(refused('lifetime-too-long')(await node.handleMessage('p', await storeMsg(id, key, { a: 1 }, { exp: c.t + 10_001 }))))
    assert.ok(refused('expired')(await node.handleMessage('p', await storeMsg(id, key, { a: 1 }, { exp: c.t }))))
    assert.ok(refused('bad-auth')(await node.handleMessage('p', { ...(await storeMsg(id, key, { a: 1 }, { exp: c.t + 100 })), auth: { ...(await signDhtStore({ signer: id, key, value: { a: 1 }, seq: 1, exp: c.t + 100 })), exp: 'soon' } })))
    assert.equal((await node.handleMessage('p', await storeMsg(id, key, { a: 1 }, { exp: c.t + 10_000 }))).stored, true)
    assert.equal(node.get(ANON(3)), undefined)
  })

  it('a flood is bounded: per sending peer by rate, per writer by quota, per node by size, and the rest are untouched', async () => {
    const { c, node } = owned({ rate: { max: 3, windowMs: 1000 }, maxEntries: 5, maxEntriesPerWriter: 4 })
    const flooder = await PodIdentity.generate(); const honest = await PodIdentity.generate()
    const results = []
    for (let i = 0; i < 6; i++) results.push(await node.handleMessage('flooder', await storeMsg(flooder, ANON(10 + i), { i }, { exp: c.t + 5000 })))
    assert.deepEqual(results.map((r) => r.refused ?? 'ok'), ['ok', 'ok', 'ok', 'rate-limited', 'rate-limited', 'rate-limited'])
    c.t += 1001 // the window passes
    assert.equal((await node.handleMessage('flooder', await storeMsg(flooder, ANON(20), { i: 20 }, { exp: c.t + 5000 }))).stored, true)
    // writer quota: this writer now holds 4 entries; a different peer sending for the same writer is refused too
    assert.ok(refused('writer-quota')(await node.handleMessage('other-peer', await storeMsg(flooder, ANON(22), { i: 22 }, { exp: c.t + 5000 }))))
    // an honest writer from another peer is not affected by the flooder, until the node itself is full
    assert.equal((await node.handleMessage('honest-peer', await storeMsg(honest, ANON(30), { ok: true }, { exp: c.t + 5000 }))).stored, true)
    assert.ok(refused('store-full')(await node.handleMessage('honest-peer', await storeMsg(honest, ANON(31), { ok: true }, { exp: c.t + 5000 }))))
    c.t += 6000 // everything expires, so there is room again
    assert.equal((await node.handleMessage('honest-peer', await storeMsg(honest, ANON(32), { ok: true }, { exp: c.t + 5000 }))).stored, true)
  })

  it('every refusal is counted by name, and the log hook gets the name and a short key hash, never the value', async () => {
    const lines = []
    const c = clock()
    const node = new DhtNode({ localId: 'n', now: c.now, storePolicy: { mode: 'owned', onRefuse: (l) => lines.push(l) } })
    await node.handleMessage('mallory', await storeMsg(null, 'secret-key', { token: 'hunter2' }))
    assert.deepEqual(node.storeStats.refused, { 'unsigned-store': 1 })
    assert.equal(node.storeStats.accepted, 0)
    assert.equal(lines.length, 1)
    assert.equal(lines[0].reason, 'unsigned-store')
    assert.equal(lines[0].from, 'mallory')
    assert.equal(lines[0].keyHash, createHash('sha256').update('secret-key').digest('hex').slice(0, 8))
    assert.equal(JSON.stringify(lines).includes('hunter2'), false)
    assert.equal(JSON.stringify(lines).includes('secret-key'), false)
    for (const name of Object.keys(node.storeStats.refused)) assert.ok(DHT_STORE_REFUSALS.includes(name))
  })

  it('a malformed message is a named refusal, never an exception', async () => {
    const { node } = owned()
    assert.ok(refused('malformed')(await node.handleMessage('p', { type: DHT_STORE, key: 5, value: { a: 1 } })))
    assert.ok(refused('malformed')(await node.handleMessage('p', { type: DHT_STORE, value: { a: 1 } })))
    assert.ok(refused('malformed')(await node.handleMessage('p', { type: DHT_STORE, key: 'k', value: undefined })))
  })
})

describe('mixed swarm: old and new nodes in one in-process network', () => {
  function network() {
    const nodes = new Map(); const pending = []
    const wire = (id) => (to, msg) => {
      const t = nodes.get(to)
      if (t) pending.push(Promise.resolve().then(() => t.handleMessage(id, structuredClone(msg))))
    }
    const add = (id, node) => { nodes.set(id, node); return node }
    return {
      old: (id) => add(id, new LegacyDhtNode({ localId: id, sendFn: wire(id) })),
      fresh: (id, storePolicy) => add(id, new DhtNode({ localId: id, sendFn: wire(id), ...(storePolicy ? { storePolicy } : {}) })),
      link: (...ids) => { for (const a of ids) nodes.get(a).bootstrap(ids.filter((b) => b !== a).map((podId) => ({ podId }))) },
      settle: async () => { while (pending.length) await pending.shift() },
      nodes,
    }
  }

  it('a new signed writer: old nodes store the value as before, new nodes verify it, readers of either see the same value', async () => {
    const net = network()
    const oldNode = net.old('old'); const open = net.fresh('open', { mode: 'open' }); const strict = net.fresh('strict', { mode: 'owned' }); const writer = net.fresh('writer', { mode: 'open' })
    net.link('old', 'open', 'strict', 'writer')
    const id = await PodIdentity.generate()
    const value = { podId: id.podId, addr: 'x' }
    const auth = await signDhtStore({ signer: id, key: id.podId, value, seq: 1, exp: Date.now() + 60_000 })
    await writer.store(id.podId, value, 0, { auth })
    await net.settle()
    for (const n of [oldNode, open, strict]) assert.deepEqual(n.get(id.podId), value)
    assert.equal(open.ownerOf(id.podId), await pubOf(id))
    assert.equal(strict.ownerOf(id.podId), await pubOf(id))
    assert.equal(oldNode.get(id.podId) === value, false)
  })

  it('an old unsigned writer: accepted by old and open nodes, refused by an owned node, and an owned entry survives it', async () => {
    const net = network()
    const oldWriter = net.old('oldwriter'); const open = net.fresh('open', { mode: 'open' }); const strict = net.fresh('strict', { mode: 'owned' })
    net.link('oldwriter', 'open', 'strict')
    oldWriter.store('plain-key', { from: 'old' })
    await net.settle()
    assert.deepEqual(open.get('plain-key'), { from: 'old' })
    assert.equal(strict.get('plain-key'), undefined)
    assert.deepEqual(strict.storeStats.refused, { 'unsigned-store': 1 })
    // an owned entry is not overwritten by an old writer on a node that enforces
    const id = await PodIdentity.generate()
    await open.store(id.podId, { real: true }, 0, { auth: await signDhtStore({ signer: id, key: id.podId, value: { real: true }, seq: 1, exp: Date.now() + 60_000 }) })
    await net.settle()
    oldWriter.store(id.podId, { real: false })
    await net.settle()
    assert.deepEqual(open.get(id.podId), { real: true })
    assert.deepEqual(oldWriter.get(id.podId), { real: false }, 'the old node, of course, took it: protection holds only where it is enforced')
  })

  it('the local store reports a refusal instead of throwing, and an owned node refuses its own unsigned write', async () => {
    const owned = new DhtNode({ localId: 'n', storePolicy: { mode: 'owned' } })
    assert.deepEqual(await owned.store('k', { a: 1 }), { stored: false, refused: 'unsigned-store' })
    assert.deepEqual(new DhtNode({ localId: 'n' }).store('k', { a: 1 }), { stored: true })
  })
})

describe('StealthAgent writes owned stores under the agent-anonymous keys', () => {
  const NONCE = 'AAECAwQFBgcICQoLDA0ODw'
  const STATE = JSON.stringify({ memory: ['m'], n: 1 })

  async function setup(extra = {}) {
    const identity = await PodIdentity.generate()
    const dhtNode = new DhtNode({ localId: 'n', storePolicy: { mode: 'owned' } })
    const make = (o = {}) => new StealthAgent({ agentId: 'agent-007', dhtNode, identity, lookupNonce: NONCE, shardFormat: 3, ownedStores: true, ...extra, ...o })
    return { identity, dhtNode, make }
  }

  it('the agent stores and reads as before; each shard key is pinned to its own derived writer key', async () => {
    const { identity, dhtNode, make } = await setup()
    const agent = make()
    const manifest = await agent.hideSigned(STATE)
    assert.equal(await agent.reconstituteSigned(), STATE)
    const owners = manifest.shardKeys.map((k) => dhtNode.ownerOf(k))
    assert.ok(owners.every((o) => typeof o === 'string'))
    assert.equal(new Set(owners).size, owners.length, 'a different writer key per shard: shards of one agent are not linked by it')
    assert.ok(!owners.includes(await pubOf(identity)), 'and none is the agent identity key')
  })

  it('the keys are exactly those of an agent that does not use owned stores, so anonymity and readers are unchanged', async () => {
    const { make } = await setup()
    const plain = new StealthAgent({ agentId: 'agent-007', dhtNode: new DhtNode({ localId: 'n2' }), identity: await PodIdentity.generate(), lookupNonce: NONCE, shardFormat: 3 })
    assert.deepEqual((await make().hideSigned(STATE)).shardKeys, (await plain.hideSigned(STATE)).shardKeys)
  })

  it('a group member who holds the nonce can read, but cannot store under the agent\'s keys', async () => {
    const { identity, dhtNode, make } = await setup()
    await make().hideSigned(STATE)
    const member = make({ identity: await PodIdentity.generate(), trustedKeys: [await identity.rawPublicKey()] })
    assert.equal(await member.reconstituteSigned(), STATE)
    await assert.rejects(member.hideSigned('the member overwrites'), (e) => e instanceof StealthError && e.code === 'store-refused' && /owned-key/.test(e.message))
    assert.equal(await make().reconstituteSigned(), STATE)
    void dhtNode
  })

  it('the agent can republish a newer state under the same keys (a higher seq), and a replayed older write is refused', async () => {
    const { dhtNode, make } = await setup()
    const agent = make()
    await agent.hideSigned('state one')
    const key0 = (await agent.hideSigned('state two')).shardKeys[0]
    assert.equal(await agent.reconstituteSigned(), 'state two')
    const entry = dhtNode.get(key0)
    assert.ok(entry.seq > 0)
  })

  it('owned stores need an identity and format 3, and refuse a signer that is not deterministic', async () => {
    const dhtNode = new DhtNode({ localId: 'n' })
    assert.throws(() => new StealthAgent({ agentId: 'a', dhtNode, ownedStores: true }), (e) => e instanceof StealthError && e.code === 'bad-argument')
    const real = await PodIdentity.generate()
    const flaky = { podId: real.podId, rawPublicKey: () => real.rawPublicKey(), sign: async (b) => { const s = new Uint8Array(await real.sign(b)); s[0] ^= Math.floor(Math.random() * 255) + 1; return s } }
    await assert.rejects(deriveWriteSigner({ identity: flaky, lookupNonce: NONCE, index: 0 }), (e) => e.code === 'identity-not-deterministic')
  })
})
