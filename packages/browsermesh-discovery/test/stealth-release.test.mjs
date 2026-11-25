// Run with: node --import ./test/_setup-globals.mjs --test test/stealth-release.test.mjs
// The on-demand share release round (docs/design/discovery-records.md, item 4).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import {
  dealStealthShares, reconstructStealthSecret, StealthError,
  createShareHolder, createReleaseRequest, createReleaseResponse, requestShareRelease, stealthReleaseChannel, stealthReleaseTag, RELEASE_REFUSALS,
} from '../src/index.mjs'

const AGENT = 'agent-007'
const GROUP = 'ops'
const b64u = (bytes) => Buffer.from(bytes).toString('base64url')
const raw = async (identity) => new Uint8Array(await identity.rawPublicKey())

/** Three member pods; the dealer deals 2-of-3 to them; each holder pod holds its own share. */
async function world({ threshold = 2, holderOpts = {}, members: memberCount = 3, now } = {}) {
  const dealer = await PodIdentity.generate()
  const pods = []
  for (let i = 0; i < memberCount; i++) pods.push(await PodIdentity.generate())
  const names = pods.map((p) => p.podId)
  const dealt = await dealStealthShares({ identity: dealer, agentId: AGENT, groupId: GROUP, holders: names, threshold })
  const trustedDealers = [await raw(dealer)]
  const memberKeys = await Promise.all(pods.map(raw))
  const holders = []
  for (let i = 0; i < pods.length; i++) {
    const holder = createShareHolder({ name: names[i], identity: pods[i], members: memberKeys, trustedDealers, ...(now ? { now } : {}), ...holderOpts })
    assert.deepEqual(await holder.addShare(dealt.shares[i].share), { ok: true })
    holders.push(holder)
  }
  const opts = { trustedDealers, agentId: AGENT, groupId: GROUP, holders: names }
  const peers = (asPod, mapSend = (s) => s) => pods.map((p, i) => ({
    holder: names[i], publicKey: memberKeys[i],
    send: mapSend((request) => holders[i].handle(asPod.podId, structuredClone(request)), i),
  }))
  return { dealer, pods, names, dealt, trustedDealers, memberKeys, holders, opts, peers }
}

describe('a member asks the holders for their shares', () => {
  it('collects t signed shares, recombines the secret, and reports who answered', async () => {
    const w = await world()
    const out = await requestShareRelease({ identity: w.pods[2], agentId: AGENT, groupId: GROUP, peers: w.peers(w.pods[2]), ...w.opts })
    assert.deepEqual(out.secret, w.dealt.secret)
    assert.equal(out.epoch, 0)
    assert.ok(out.released >= 2)
    assert.deepEqual(out.unreachable, [])
  })

  it('names the reserved channel, and the request carries neither the agent nor the group in the clear', async () => {
    assert.equal(stealthReleaseChannel(AGENT), 'stealth:agent-007:share:release')
    const w = await world()
    const { request } = await createReleaseRequest({ identity: w.pods[0], holder: w.names[1], agentId: AGENT, groupId: GROUP })
    const json = JSON.stringify(request)
    assert.equal(json.includes(AGENT), false)
    assert.equal(json.includes(GROUP), false)
    assert.equal(request.tag, await stealthReleaseTag({ groupId: GROUP, agentId: AGENT }))
    // the tag is the documented hash, computed independently
    const u32 = (n) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
    const part = (x) => { const b = Buffer.from(x); return Buffer.concat([u32(b.length), b]) }
    assert.equal(request.tag, createHash('sha256').update(Buffer.concat([part('browsermesh-stealth-release/tag/1'), part(GROUP), part(AGENT)])).digest('hex'))
  })

  it('the share travels sealed to the requester: a response is not readable without the request\'s key', async () => {
    const w = await world()
    const a = await createReleaseRequest({ identity: w.pods[0], holder: w.names[1], holderKey: w.memberKeys[1], agentId: AGENT, groupId: GROUP })
    const b = await createReleaseRequest({ identity: w.pods[0], holder: w.names[1], holderKey: w.memberKeys[1], agentId: AGENT, groupId: GROUP })
    const response = await w.holders[1].handle(w.names[0], a.request)
    assert.equal(response.type, 'released')
    const share = w.dealt.shares[1].share
    assert.equal(JSON.stringify(response).includes(share.share), false, 'the share bytes are not in the clear')
    assert.deepEqual(await b.open(response), { ok: false, reason: 'bad-response' }, 'another request\'s key does not open it')
    const opened = await a.open(response)
    assert.equal(opened.ok, true)
    assert.deepEqual(opened.share, share)
  })
})

describe('what a holder checks, and the refusals it names', () => {
  const ask = async (w, from, over = {}, holderIndex = 1) => {
    const identity = over.identity ?? w.pods[0]
    const { request } = await createReleaseRequest({ identity, holder: w.names[holderIndex], agentId: AGENT, groupId: GROUP, ...(over.make ?? {}) })
    return w.holders[holderIndex].handle(from ?? identity.podId, over.mutate ? over.mutate(request) : request)
  }
  const reason = (r) => (r.type === 'refused' ? r.reason : r.type)

  it('refuses a requester who is not a member, before it looks at which agent is asked about', async () => {
    const w = await world()
    const stranger = await PodIdentity.generate()
    const known = await ask(w, undefined, { identity: stranger })
    const { request } = await createReleaseRequest({ identity: stranger, holder: w.names[1], agentId: 'an-agent-nobody-holds', groupId: 'nowhere' })
    const unknown = await w.holders[1].handle(stranger.podId, request)
    assert.equal(reason(known), 'not-a-member')
    assert.deepEqual(unknown, known, 'the same refusal whether or not the holder holds that agent: nothing is revealed')
  })

  it('a member asking about an agent the holder does not hold gets no-share', async () => {
    const w = await world()
    const { request } = await createReleaseRequest({ identity: w.pods[0], holder: w.names[1], agentId: 'another-agent', groupId: GROUP })
    assert.equal(reason(await w.holders[1].handle(w.names[0], request)), 'no-share')
  })

  it('refuses a request sent again (a replay), and one made for another holder', async () => {
    const w = await world()
    const { request } = await createReleaseRequest({ identity: w.pods[0], holder: w.names[1], agentId: AGENT, groupId: GROUP })
    assert.equal(reason(await w.holders[1].handle(w.names[0], request)), 'released')
    assert.equal(reason(await w.holders[1].handle(w.names[0], request)), 'replayed')
    const other = (await createReleaseRequest({ identity: w.pods[0], holder: w.names[1], agentId: AGENT, groupId: GROUP })).request
    assert.equal(reason(await w.holders[2].handle(w.names[0], other)), 'wrong-holder')
    assert.equal(reason(await w.holders[2].handle(w.names[0], { ...other, holder: w.names[2] })), 'bad-signature', 'relabelling it for this holder breaks the signature')
  })

  it('refuses a stale or future request, and a request whose fields were changed', async () => {
    const c = { t: 1_000_000 }
    const w = await world({ now: () => c.t })
    const at = (t) => createReleaseRequest({ identity: w.pods[0], holder: w.names[1], agentId: AGENT, groupId: GROUP, now: () => t })
    assert.equal(reason(await w.holders[1].handle(w.names[0], (await at(c.t - 61_000)).request)), 'stale-request')
    assert.equal(reason(await w.holders[1].handle(w.names[0], (await at(c.t + 61_000)).request)), 'stale-request')
    assert.equal(reason(await w.holders[1].handle(w.names[0], (await at(c.t - 59_000)).request)), 'released')
    const { request } = await at(c.t)
    assert.equal(reason(await w.holders[1].handle(w.names[0], { ...request, minEpoch: 5 })), 'bad-signature')
    assert.equal(reason(await w.holders[1].handle(w.names[0], { ...request, tag: 'f'.repeat(64) })), 'bad-signature')
  })

  it('refuses malformed, oversized and unknown-version requests by name', async () => {
    const w = await world()
    for (const bad of [null, 'x', [], {}, { v: 1 }, { v: 1, type: 'release' }]) assert.equal(reason(await w.holders[1].handle(w.names[0], bad)), 'malformed', JSON.stringify(bad))
    const { request } = await createReleaseRequest({ identity: w.pods[0], holder: w.names[1], agentId: AGENT, groupId: GROUP })
    assert.equal(reason(await w.holders[1].handle(w.names[0], { ...request, padding: 'x'.repeat(5000) })), 'too-large')
    const v2 = await w.holders[1].handle(w.names[0], { ...request, v: 2 })
    assert.deepEqual(v2, { v: 1, type: 'refused', holder: w.names[1], reason: 'unsupported-version', maxV: 1 })
  })

  it('rate-limits a requester before it spends a signature check, and does not limit the others', async () => {
    const w = await world({ holderOpts: { rate: { max: 3, windowMs: 60_000 } } })
    const outcomes = []
    for (let i = 0; i < 5; i++) outcomes.push(reason(await ask(w, undefined, {})))
    assert.deepEqual(outcomes, ['released', 'released', 'released', 'rate-limited', 'rate-limited'])
    assert.equal(reason(await ask(w, undefined, { identity: w.pods[2] })), 'released')
  })

  it('the epoch rules of #357 carry through: a retired epoch is not released, and a request can demand a minimum', async () => {
    const w = await world()
    assert.equal(reason(await ask(w, undefined, { make: { minEpoch: 1 } })), 'stale-epoch')
    w.holders[1].retire({ agentId: AGENT, groupId: GROUP, belowEpoch: 1 })
    assert.equal(reason(await ask(w, undefined, {})), 'no-share', 'the retired share is gone')
    const next = await dealStealthShares({ identity: w.dealer, agentId: AGENT, groupId: GROUP, epoch: 1, holders: w.names, threshold: 2 })
    assert.deepEqual(await w.holders[1].addShare(next.shares[1].share), { ok: true })
    assert.equal(reason(await ask(w, undefined, { make: { minEpoch: 1 } })), 'released')
    assert.deepEqual(await w.holders[1].addShare(w.dealt.shares[1].share), { ok: false, reason: 'stale-epoch' }, 'an old share is not taken back after retirement')
  })

  it('a member who left (removed from the roster) can no longer ask', async () => {
    const w = await world()
    assert.equal(reason(await ask(w, undefined, {})), 'released')
    w.holders[1].setMembers(w.memberKeys.slice(1)) // pods[0] leaves
    assert.equal(reason(await ask(w, undefined, {})), 'not-a-member')
  })

  it('an approval hook can say no; the log hook sees outcomes without the share, the key or the whole tag', async () => {
    const lines = []
    let allow = false
    const w = await world({ holderOpts: { approve: async () => allow, log: (l) => lines.push(l) } })
    assert.equal(reason(await ask(w, undefined, {})), 'not-approved')
    allow = true
    assert.equal(reason(await ask(w, undefined, {})), 'released')
    assert.deepEqual(lines.map((l) => l.outcome), ['refused', 'released'])
    assert.equal(lines[0].reason, 'not-approved')
    const text = JSON.stringify(lines)
    assert.equal(text.includes(w.dealt.shares[1].share.share), false)
    assert.equal(text.includes(await stealthReleaseTag({ groupId: GROUP, agentId: AGENT })), false)
    assert.equal(lines[1].tag.length, 8)
    assert.equal(lines[1].requester, w.names[0])
  })

  it('accepts only shares of a dealer it trusts, dealt to itself, and counts what it refuses', async () => {
    const w = await world()
    const fake = await dealStealthShares({ identity: await PodIdentity.generate(), agentId: AGENT, groupId: GROUP, holders: w.names, threshold: 2 })
    assert.deepEqual(await w.holders[0].addShare(fake.shares[0].share), { ok: false, reason: 'untrusted-dealer' })
    assert.deepEqual(await w.holders[0].addShare(w.dealt.shares[1].share), { ok: false, reason: 'unknown-holder' }, 'a share dealt to another holder')
    const bent = { ...w.dealt.shares[0].share, index: 77 }
    assert.deepEqual(await w.holders[0].addShare(bent), { ok: false, reason: 'bad-signature' })
  })
})

describe('the reader', () => {
  it('survives an offline holder and a holder that never ran the channel (an older peer), and says who', async () => {
    const w = await world()
    const peers = w.peers(w.pods[0], (send, i) => (i === 1 ? async () => { throw new Error('no such channel: stealth:agent-007:share:release') } : send))
    const out = await requestShareRelease({ identity: w.pods[0], agentId: AGENT, groupId: GROUP, peers,...w.opts })
    assert.deepEqual(out.secret, w.dealt.secret)
    assert.deepEqual(out.unreachable, [w.names[1]])
  })

  it('below the threshold it returns nothing and reports counts: offline does not lower t', async () => {
    const w = await world()
    const peers = w.peers(w.pods[0], (send, i) => (i === 0 ? send : () => new Promise(() => {})))
    await assert.rejects(
      requestShareRelease({ identity: w.pods[0], agentId: AGENT, groupId: GROUP, peers,timeoutMs: 50, ...w.opts }),
      (e) => e instanceof StealthError && e.code === 'below-threshold' && e.details.released === 1 && e.details.unreachable.length === 2,
    )
  })

  it('collects refusals by reason without failing the whole round', async () => {
    const w = await world()
    w.holders[2].setMembers([]) // this holder knows no members
    const out = await requestShareRelease({ identity: w.pods[0], agentId: AGENT, groupId: GROUP, peers: w.peers(w.pods[0]), ...w.opts })
    assert.deepEqual(out.secret, w.dealt.secret)
    assert.ok(out.refused.every((r) => r.reason === 'not-a-member'))
  })

  it('a tampered response is refused: a flipped byte, a signature from another key, a share changed by a hostile holder', async () => {
    const w = await world({ threshold: 3 })
    const flip = (send) => async (request) => { const r = await send(request); return r.type === 'released' ? { ...r, ct: `${r.ct[0] === 'A' ? 'B' : 'A'}${r.ct.slice(1)}` } : r }
    const wrongKeyPeers = w.peers(w.pods[0]).map((p, i) => (i === 1 ? { ...p, publicKey: w.memberKeys[0] } : p))
    const outFlip = requestShareRelease({ identity: w.pods[0], agentId: AGENT, groupId: GROUP, peers: w.peers(w.pods[0], (s, i) => (i === 2 ? flip(s) : s)), ...w.opts })
    await assert.rejects(outFlip, (e) => e.code === 'below-threshold' && e.details.refused.some((r) => r.reason === 'bad-response'))
    await assert.rejects(
      requestShareRelease({ identity: w.pods[0], agentId: AGENT, groupId: GROUP, peers: wrongKeyPeers,...w.opts }),
      (e) => e.code === 'below-threshold' && e.details.refused.some((r) => r.reason === 'bad-response'),
    )
    // a hostile holder returns a properly sealed share whose index it changed: the dealer's signature catches it
    const hostile = w.peers(w.pods[0], (send, i) => (i === 0
      ? async (request) => createReleaseResponse({ request, share: { ...w.dealt.shares[0].share, index: 99 }, identity: w.pods[0], holder: w.names[0] })
      : send))
    await assert.rejects(
      requestShareRelease({ identity: w.pods[0], agentId: AGENT, groupId: GROUP, peers: hostile,...w.opts }),
      (e) => e instanceof StealthError && e.code === 'below-threshold' && e.details.refused.some((r) => r.reason === 'bad-signature' || r.reason === 'bad-index'),
    )
  })

  it('a share of an older epoch, or dealt to someone who has left, is refused as in #357', async () => {
    const w = await world()
    const out1 = requestShareRelease({ identity: w.pods[0], agentId: AGENT, groupId: GROUP, peers: w.peers(w.pods[0]), ...w.opts, minEpoch: 1 })
    await assert.rejects(out1, (e) => e.code === 'below-threshold')
    // pods[0] has left: the current holders are the other two, and the share dealt to pods[0] is refused whatever answers with it
    const out2 = await requestShareRelease({ identity: w.pods[1], agentId: AGENT, groupId: GROUP, peers: w.peers(w.pods[1]), ...w.opts, holders: w.names.slice(1), timeoutMs: 1000 })
    assert.deepEqual(out2.secret, w.dealt.secret)
    assert.ok(out2.refused.every((r) => r.holder === w.names[0] && r.reason === 'unknown-holder'))
  })

  it('stops asking once the threshold is met', async () => {
    const w = await world({ members: 5, threshold: 2 })
    let asked = 0
    const peers = w.peers(w.pods[0], (send) => (r) => { asked++; return send(r) })
    const out = await requestShareRelease({ identity: w.pods[0], agentId: AGENT, groupId: GROUP, peers,...w.opts })
    assert.deepEqual(out.secret, w.dealt.secret)
    assert.equal(RELEASE_REFUSALS.includes('rate-limited'), true)
    assert.ok(asked <= 5)
  })
})

describe('mixed swarm: the release round next to shares dealt up front', () => {
  it('shares released on demand recombine with shares held from the original dealing, and shares themselves are unchanged (v: 1)', async () => {
    const w = await world()
    const share = w.dealt.shares[0].share
    assert.equal(share.v, 1)
    const { request, open } = await createReleaseRequest({ identity: w.pods[2], holder: w.names[1], holderKey: w.memberKeys[1], agentId: AGENT, groupId: GROUP })
    const released = (await open(await w.holders[1].handle(w.names[2], request))).share
    assert.deepEqual(released, w.dealt.shares[1].share)
    const { secret } = await reconstructStealthSecret([share, released], w.opts)
    assert.deepEqual(secret, w.dealt.secret)
  })
})
