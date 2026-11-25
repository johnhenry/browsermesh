// Run with: node --import ./test/_setup-globals.mjs --test test/stealth-threshold.test.mjs
// #328: threshold sharing of the group secret: dealer model, share holders, epochs. Design: docs/design/stealth-threshold.md
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { combine } from 'shamir-secret-sharing'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import {
  DhtNode, StealthAgent, StealthError, StealthKeyring,
  dealStealthShares, verifyStealthShare, reconstructStealthSecret, thresholdEpochKeys, stealthEpochKeyId, stealthShareSigningBytes,
} from '../src/index.mjs'

const AGENT = 'agent-007'
const GROUP = 'ops'
const HOLDERS = ['m1', 'm2', 'm3', 'm4', 'm5']
const STATE = JSON.stringify({ memory: ['the launch code is 0000'], n: 42 })

const b64u = (bytes) => Buffer.from(bytes).toString('base64url')
const fromB64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'))

async function deal(extra = {}) {
  const dealer = extra.identity ?? await PodIdentity.generate()
  const dealt = await dealStealthShares({ identity: dealer, agentId: AGENT, groupId: GROUP, holders: HOLDERS, threshold: 3, ...extra })
  const trusted = [new Uint8Array(await dealer.rawPublicKey())]
  const opts = { trustedDealers: trusted, agentId: AGENT, groupId: GROUP }
  return { dealer, dealt, trusted, opts, shares: dealt.shares.map((s) => s.share) }
}

/** Every k-element subset of `list`. */
function subsets(list, k) {
  if (k === 0) return [[]]
  if (list.length < k) return []
  const [head, ...rest] = list
  return [...subsets(rest, k - 1).map((s) => [head, ...s]), ...subsets(rest, k)]
}

// A small independent multiplier in GF(2^8) (reduction polynomial 0x11b), used only here to build the vectors.
function gmul(a, b) {
  let p = 0
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a
    const carry = a & 0x80
    a = (a << 1) & 0xff
    if (carry) a ^= 0x1b
    b >>= 1
  }
  return p
}

describe('the field and the vectors', () => {
  it('the test multiplier is the field of the design note (0x57 * 0x83 = 0xc1)', () => {
    assert.equal(gmul(0x57, 0x83), 0xc1)
    assert.equal(gmul(0x53, 0xca), 0x01)
  })

  it('shares of fixed polynomials (degree 1 and 2) recombine to the secret: the library is in this field', async () => {
    const secret = Uint8Array.from([0x00, 0x01, 0x7f, 0x80, 0xff, 0xa5, 0x5a, 0x10])
    const c1 = Uint8Array.from([0x13, 0x00, 0xfe, 0x01, 0x57, 0xc3, 0x99, 0xe7])
    const c2 = Uint8Array.from([0x91, 0x2b, 0x00, 0x83, 0x44, 0x08, 0xd0, 0x6e])
    const at = (x, withSquare) => Uint8Array.from([...secret].map((s, i) => s ^ gmul(c1[i], x) ^ (withSquare ? gmul(c2[i], gmul(x, x)) : 0)))
    const share = (x, withSquare) => Uint8Array.from([...at(x, withSquare), x])
    assert.deepEqual([...await combine([share(1, false), share(2, false)])], [...secret])
    assert.deepEqual([...await combine([share(7, false), share(200, false)])], [...secret])
    assert.deepEqual([...await combine([share(2, true), share(5, true), share(9, true)])], [...secret])
    assert.notDeepEqual([...await combine([share(2, true), share(5, true)])], [...secret], 'one share short of the degree')
  })
})

describe('dealing', () => {
  it('deals n signed shares of a fresh 32-byte secret, t of n, bound to agent, group, epoch, index and holder', async () => {
    const { dealt, shares } = await deal()
    assert.equal(dealt.secret.length, 32)
    assert.equal(dealt.shares.length, 5)
    assert.deepEqual(dealt.shares.map((s) => s.holder), HOLDERS)
    assert.equal(dealt.threshold, 3)
    assert.equal(dealt.total, 5)
    assert.equal(dealt.epoch, 0)
    assert.equal(new Set(shares.map((s) => s.index)).size, 5, 'distinct indices')
    for (const [i, s] of shares.entries()) {
      assert.equal(s.v, 1)
      assert.equal(s.agentId, AGENT)
      assert.equal(s.groupId, GROUP)
      assert.equal(s.epoch, 0)
      assert.equal(s.threshold, 3)
      assert.equal(s.total, 5)
      assert.equal(s.holder, HOLDERS[i])
      const bytes = fromB64u(s.share)
      assert.equal(bytes.length, 33)
      assert.equal(bytes[32], s.index, 'the index is the x coordinate of the share')
      assert.ok(s.index >= 1 && s.index <= 255)
    }
  })

  it('the secret is fresh each time, and the shares do not contain it', async () => {
    const a = await deal()
    const b = await deal()
    assert.notDeepEqual([...a.dealt.secret], [...b.dealt.secret])
    for (const s of a.shares) assert.notDeepEqual([...fromB64u(s.share).slice(0, 32)], [...a.dealt.secret])
  })

  it('a share is plain JSON: it survives JSON.stringify and parse and still verifies', async () => {
    const { shares, opts } = await deal()
    const again = JSON.parse(JSON.stringify(shares[0]))
    assert.deepEqual(await verifyStealthShare(again, opts), { ok: true })
  })

  it('the default threshold is a majority; the threshold, holders and epoch are checked', async () => {
    for (const [n, t] of [[2, 2], [3, 2], [4, 3], [5, 3], [6, 4]]) {
      const { dealt } = await deal({ holders: HOLDERS.concat(['m6']).slice(0, n), threshold: undefined })
      assert.equal(dealt.threshold, t, `${n} holders`)
    }
    const identity = await PodIdentity.generate()
    const bad = (extra) => assert.rejects(dealStealthShares({ identity, agentId: AGENT, groupId: GROUP, holders: HOLDERS, ...extra }), (e) => e instanceof StealthError && e.code === 'bad-argument')
    await bad({ threshold: 1 })
    await bad({ threshold: 6 })
    await bad({ threshold: 2.5 })
    await bad({ holders: ['a'] })
    await bad({ holders: ['a', 'a'] })
    await bad({ holders: ['a', ''] })
    await bad({ holders: ['a', 'b\nc'] })
    await bad({ holders: Array.from({ length: 256 }, (_, i) => `h${i}`), threshold: 2 })
    await bad({ epoch: -1 })
    await bad({ epoch: 1.5 })
    await bad({ agentId: '' })
    await bad({ groupId: '' })
    await assert.rejects(dealStealthShares({ agentId: AGENT, groupId: GROUP, holders: HOLDERS }), (e) => e.code === 'bad-argument', 'an identity is required')
  })
})

describe('recombination', () => {
  it('every t-subset of a (3,5) split recovers the secret', async () => {
    const { dealt, shares, opts } = await deal()
    const all = subsets(shares, 3)
    assert.equal(all.length, 10)
    for (const subset of all) {
      const got = await reconstructStealthSecret(subset, opts)
      assert.deepEqual([...got.secret], [...dealt.secret])
      assert.equal(got.epoch, 0)
      assert.deepEqual(got.refused, [])
    }
    const bigger = await reconstructStealthSecret(shares, opts)
    assert.deepEqual([...bigger.secret], [...dealt.secret], 'more than t shares are fine')
    assert.equal(bigger.used.length, 3, 'exactly t are used')
  })

  it('every (t-1)-subset is refused by name and returns nothing; the bare combination is not the secret', async () => {
    const { dealt, shares, opts } = await deal()
    for (const subset of [...subsets(shares, 2), ...subsets(shares, 1), []]) {
      await assert.rejects(reconstructStealthSecret(subset, opts), (e) => e instanceof StealthError && e.code === 'below-threshold')
    }
    for (const subset of subsets(shares, 2)) {
      const guess = await combine(subset.map((s) => fromB64u(s.share)))
      assert.notDeepEqual([...guess], [...dealt.secret], 'two of three shares reveal nothing about the secret')
    }
  })

  it('a (2,2) split needs both shares', async () => {
    const { shares, opts } = await deal({ holders: ['a', 'b'], threshold: 2 })
    await assert.rejects(reconstructStealthSecret([shares[0]], opts), (e) => e.code === 'below-threshold')
    await reconstructStealthSecret(shares, opts)
  })

  it('duplicates of one share count once', async () => {
    const { shares, opts } = await deal()
    await assert.rejects(reconstructStealthSecret([shares[0], shares[0], shares[0], shares[1], shares[1]], opts), (e) => e.code === 'below-threshold')
    const got = await reconstructStealthSecret([shares[0], shares[0], shares[1], shares[2]], opts)
    assert.deepEqual(got.refused.map((r) => r.reason), ['duplicate'])
  })

  it('a tampered share is refused and counted, and the rest still recombine when enough remain', async () => {
    const { dealt, shares, opts } = await deal()
    const bytes = fromB64u(shares[0].share)
    bytes[3] ^= 1
    const tampered = { ...shares[0], share: b64u(bytes) }
    assert.deepEqual(await verifyStealthShare(tampered, opts), { ok: false, reason: 'bad-signature' })
    const got = await reconstructStealthSecret([tampered, ...shares.slice(1)], opts)
    assert.deepEqual([...got.secret], [...dealt.secret])
    assert.deepEqual(got.refused, [{ index: shares[0].index, reason: 'bad-signature' }])
    await assert.rejects(reconstructStealthSecret([tampered, shares[1], shares[2]], opts), (e) => e.code === 'below-threshold' && /refused/.test(e.message))
  })

  it('every signed field is covered: changing any of them is refused', async () => {
    const { shares, opts } = await deal()
    const s = shares[0]
    const changes = {
      agentId: 'agent-008', groupId: 'other', epoch: 7, threshold: 2, total: 4, index: s.index === 9 ? 10 : 9,
      holder: 'mallory', keyCheck: '00'.repeat(32), share: b64u(new Uint8Array(33).fill(1)),
    }
    for (const [field, value] of Object.entries(changes)) {
      const result = await verifyStealthShare({ ...s, [field]: value }, { ...opts, agentId: field === 'agentId' ? 'agent-008' : AGENT, groupId: field === 'groupId' ? 'other' : GROUP })
      assert.equal(result.ok, false, field)
      assert.ok(['bad-signature', 'bad-index'].includes(result.reason), `${field}: ${result.reason}`)
    }
  })

  it('a share for another agent or group is refused for this one, whatever its signature says', async () => {
    const { shares, opts } = await deal()
    assert.deepEqual(await verifyStealthShare(shares[0], { ...opts, agentId: 'agent-008' }), { ok: false, reason: 'wrong-agent' })
    assert.deepEqual(await verifyStealthShare(shares[0], { ...opts, groupId: 'other' }), { ok: false, reason: 'wrong-group' })
    const stranger = await deal({ agentId: 'agent-008' })
    const mixed = [...stranger.shares.slice(0, 2), shares[2]]
    await assert.rejects(reconstructStealthSecret(mixed, { ...opts, trustedDealers: [...opts.trustedDealers, ...stranger.trusted] }), (e) => e.code === 'below-threshold')
  })

  it('a share from a dealer the reader does not trust is refused, even with a valid signature; the dealer named in the share is only a claim', async () => {
    const { shares, opts } = await deal()
    const impostor = await deal()
    assert.deepEqual(await verifyStealthShare(impostor.shares[0], opts), { ok: false, reason: 'untrusted-dealer' })
    const claimed = { ...impostor.shares[0], dealer: shares[0].dealer }
    assert.deepEqual(await verifyStealthShare(claimed, opts), { ok: false, reason: 'bad-signature' })
    await assert.rejects(reconstructStealthSecret(impostor.shares, opts), (e) => e.code === 'below-threshold')
    const both = await reconstructStealthSecret(impostor.shares, { ...opts, trustedDealers: [...opts.trustedDealers, ...impostor.trusted] })
    assert.equal(both.secret.length, 32, 'trusted by choice')
  })

  it('malformed shares are refused by name and never throw', async () => {
    const { shares, opts } = await deal()
    for (const bad of [null, undefined, 7, 'x', [], {}, { ...shares[0], v: 2 }, { ...shares[0], sig: 5 }, { ...shares[0], share: '***' }, { ...shares[0], dealer: 'AA' }, { ...shares[0], epoch: -1 }, { ...shares[0], index: 0 }]) {
      const r = await verifyStealthShare(bad, opts)
      assert.equal(r.ok, false)
      assert.equal(r.reason, 'malformed', JSON.stringify(bad))
    }
  })

  it('a dealer that signs shares of different secrets is caught by the key check, not silently accepted', async () => {
    const { dealer, shares, opts } = await deal()
    const other = await deal({ identity: dealer })
    // The dealer (the test, with its key) signs a share of another secret under this share set's fields.
    const forged = { ...other.shares[0], keyCheck: shares[0].keyCheck }
    forged.sig = b64u(new Uint8Array(await dealer.sign(stealthShareSigningBytes(forged))))
    assert.deepEqual(await verifyStealthShare(forged, opts), { ok: true }, 'the signature is the dealer\'s own')
    await assert.rejects(reconstructStealthSecret([forged, shares[1], shares[2]], opts), (e) => e instanceof StealthError && e.code === 'key-check-failed')
  })

  it('epochs are never mixed; the newest epoch with enough valid shares is used; minEpoch refuses older shares', async () => {
    const dealer = await PodIdentity.generate()
    const e0 = await deal({ identity: dealer, epoch: 0 })
    const e1 = await deal({ identity: dealer, epoch: 1, holders: ['m1', 'm2', 'm3', 'm4'], threshold: 3 })
    const opts = e0.opts
    // Two of epoch 1 and one of epoch 0 is not three of anything.
    await assert.rejects(reconstructStealthSecret([e1.shares[0], e1.shares[1], e0.shares[2]], opts), (e) => e.code === 'below-threshold')
    const newest = await reconstructStealthSecret([...e0.shares, ...e1.shares], opts)
    assert.equal(newest.epoch, 1)
    assert.deepEqual([...newest.secret], [...e1.dealt.secret])
    const oldOnly = await reconstructStealthSecret(e0.shares, opts)
    assert.equal(oldOnly.epoch, 0)
    await assert.rejects(reconstructStealthSecret(e0.shares, { ...opts, minEpoch: 1 }), (e) => e.code === 'below-threshold')
    assert.deepEqual(await verifyStealthShare(e0.shares[0], { ...opts, minEpoch: 1 }), { ok: false, reason: 'stale-epoch' })
    const refused = await reconstructStealthSecret([...e0.shares, ...e1.shares], { ...opts, minEpoch: 1 })
    assert.equal(refused.epoch, 1)
    assert.ok(refused.refused.every((r) => r.reason === 'stale-epoch'))
  })

  it('holders: a share dealt to someone no longer a member is refused even in the same epoch', async () => {
    const { dealt, shares, opts } = await deal()
    const members = HOLDERS.filter((h) => h !== 'm1')
    assert.deepEqual(await verifyStealthShare(shares[0], { ...opts, holders: members }), { ok: false, reason: 'unknown-holder' })
    const got = await reconstructStealthSecret(shares, { ...opts, holders: members })
    assert.deepEqual([...got.secret], [...dealt.secret])
    assert.deepEqual(got.refused, [{ index: shares[0].index, reason: 'unknown-holder' }])
  })

  it('arguments are checked', async () => {
    const { shares, opts } = await deal()
    await assert.rejects(reconstructStealthSecret('x', opts), (e) => e.code === 'bad-argument')
    await assert.rejects(reconstructStealthSecret(shares, { ...opts, trustedDealers: [] }), (e) => e.code === 'bad-argument')
    await assert.rejects(reconstructStealthSecret(shares, { ...opts, trustedDealers: [new Uint8Array(5)] }), (e) => e.code === 'bad-argument')
    await assert.rejects(reconstructStealthSecret(shares, { ...opts, agentId: '' }), (e) => e.code === 'bad-argument')
    await assert.rejects(reconstructStealthSecret(shares, { ...opts, minEpoch: -1 }), (e) => e.code === 'bad-argument')
  })
})

describe('the secret in use: keyring, lookup nonce, and an epoch for a leaving member', () => {
  const newAgent = (dhtNode, keyring, lookupNonce, identity) => new StealthAgent({ agentId: AGENT, dhtNode, threshold: 3, totalShards: 5, keyring, lookupNonce, identity })

  it('a recombined secret opens what another member sealed with the same secret, under keys that do not name the agent', async () => {
    const { dealt, shares, opts } = await deal()
    const dhtNode = new DhtNode({ localId: 'n', sendFn: () => {} })
    const writerRing = new StealthKeyring({ groupId: GROUP })
    const writerKeys = await thresholdEpochKeys(dealt.secret, { agentId: AGENT, groupId: GROUP, epoch: 0, keyring: writerRing })
    assert.equal(writerKeys.keyId, stealthEpochKeyId(0))
    assert.equal(writerRing.currentId, 'e0')
    const identity = await PodIdentity.generate()
    await newAgent(dhtNode, writerRing, writerKeys.lookupNonce, identity).hideEncrypted(STATE)

    const recovered = await reconstructStealthSecret(shares.slice(1, 4), opts)
    const readerRing = new StealthKeyring({ groupId: GROUP })
    const readerKeys = await thresholdEpochKeys(recovered.secret, { agentId: AGENT, groupId: GROUP, epoch: recovered.epoch, keyring: readerRing })
    assert.equal(readerKeys.lookupNonce, writerKeys.lookupNonce)
    assert.equal(await newAgent(dhtNode, readerRing, readerKeys.lookupNonce, identity).reconstituteEncrypted(), STATE)
  })

  it('a member who leaves: the next epoch has a new secret, new keys in the DHT, and the old secret opens none of the new state', async () => {
    const dealer = await PodIdentity.generate()
    const identity = await PodIdentity.generate()
    const dhtNode = new DhtNode({ localId: 'n', sendFn: () => {} })
    const e0 = await deal({ identity: dealer, epoch: 0 })
    const ring0 = new StealthKeyring({ groupId: GROUP })
    const keys0 = await thresholdEpochKeys(e0.dealt.secret, { agentId: AGENT, groupId: GROUP, epoch: 0, keyring: ring0 })
    await newAgent(dhtNode, ring0, keys0.lookupNonce, identity).hideEncrypted(STATE)

    // m5 leaves: the dealer deals epoch 1 to the four who remain, and the latest state is re-sealed under it.
    const remaining = HOLDERS.slice(0, 4)
    const e1 = await deal({ identity: dealer, epoch: 1, holders: remaining, threshold: 3 })
    const got = await reconstructStealthSecret(e1.shares.slice(0, 3), { ...e1.opts, minEpoch: 1, holders: remaining })
    const ring1 = new StealthKeyring({ groupId: GROUP })
    const keys1 = await thresholdEpochKeys(got.secret, { agentId: AGENT, groupId: GROUP, epoch: 1, keyring: ring1 })
    assert.notEqual(keys1.lookupNonce, keys0.lookupNonce, 'the shards move to new DHT keys')
    assert.notDeepEqual([...e1.dealt.secret], [...e0.dealt.secret])
    const next = newAgent(dhtNode, ring1, keys1.lookupNonce, identity)
    await next.hideEncrypted(STATE + ' (after the leave)')
    assert.equal(await next.reconstituteEncrypted(), STATE + ' (after the leave)')

    // The leaver still holds epoch 0: it opens nothing of epoch 1 (other keys, other nonce), and its own shares are refused.
    const leaver = newAgent(dhtNode, ring0, keys0.lookupNonce, identity)
    assert.equal(await leaver.reconstituteEncrypted(), STATE, 'what it already could read, it can still read: the old shards are where they were')
    const mixed = newAgent(dhtNode, ring0, keys1.lookupNonce, identity)
    assert.deepEqual(await mixed.tryReconstituteEncrypted(), { ok: false, reason: 'unknown-key' }, 'the old key does not open the new state')
    await assert.rejects(reconstructStealthSecret(e0.shares, { ...e0.opts, minEpoch: 1 }), (e) => e.code === 'below-threshold')
    assert.deepEqual(await verifyStealthShare(e0.shares[4], { ...e0.opts, minEpoch: 1, holders: remaining }), { ok: false, reason: 'stale-epoch' })
  })

  it('thresholdEpochKeys checks its arguments and makes the new epoch current without dropping the old key', async () => {
    const { dealt } = await deal()
    const ring = new StealthKeyring({ groupId: GROUP })
    await thresholdEpochKeys(dealt.secret, { agentId: AGENT, groupId: GROUP, epoch: 0, keyring: ring })
    const next = await deal({ epoch: 1 })
    await thresholdEpochKeys(next.dealt.secret, { agentId: AGENT, groupId: GROUP, epoch: 1, keyring: ring })
    assert.deepEqual(ring.ids, ['e0', 'e1'])
    assert.equal(ring.currentId, 'e1')
    ring.remove('e0')
    await assert.rejects(thresholdEpochKeys(new Uint8Array(8), { agentId: AGENT, groupId: GROUP, epoch: 2, keyring: ring }), (e) => e.code === 'bad-argument')
    await assert.rejects(thresholdEpochKeys(dealt.secret, { agentId: AGENT, groupId: GROUP, epoch: -1, keyring: ring }), (e) => e.code === 'bad-argument')
    await assert.rejects(thresholdEpochKeys(dealt.secret, { agentId: AGENT, groupId: GROUP, epoch: 3, keyring: {} }), (e) => e.code === 'bad-argument')
  })
})

describe('off by default and additive', () => {
  it('StealthAgent works exactly as before with no threshold sharing in sight', async () => {
    const dhtNode = new DhtNode({ localId: 'n', sendFn: () => {} })
    const agent = new StealthAgent({ agentId: AGENT, dhtNode, threshold: 3, totalShards: 5 })
    await agent.hide(STATE)
    assert.equal(agent.reconstitute(), STATE)
    assert.ok(dhtNode.get(`stealth:${AGENT}:shard:0`), 'the legacy key and record are what they were')
  })
})
