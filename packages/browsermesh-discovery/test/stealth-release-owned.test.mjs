// Run with: node --import ./test/_setup-globals.mjs --test test/stealth-release-owned.test.mjs
// The share release round (item 4) and owned stores (item 3) together: a member that obtains the group
// secret through the release round can find and read an agent's owned shards, and still cannot store under them.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import {
  DhtNode, StealthAgent, StealthError, dealStealthShares, createShareHolder, requestShareRelease,
  deriveStealthKey, deriveStealthLookupNonce,
} from '../src/index.mjs'

const AGENT = 'agent-007'
const GROUP = 'ops'
const STATE = JSON.stringify({ memory: ['m'], n: 1 })
const raw = async (identity) => new Uint8Array(await identity.rawPublicKey())

async function setup() {
  const dealer = await PodIdentity.generate()
  const pods = []
  for (let i = 0; i < 3; i++) pods.push(await PodIdentity.generate())
  const names = pods.map((p) => p.podId)
  const dealt = await dealStealthShares({ identity: dealer, agentId: AGENT, groupId: GROUP, holders: names, threshold: 2 })
  const trustedDealers = [await raw(dealer)]
  const memberKeys = await Promise.all(pods.map(raw))
  const holders = []
  for (let i = 0; i < pods.length; i++) {
    const holder = createShareHolder({ name: names[i], identity: pods[i], members: memberKeys, trustedDealers })
    await holder.addShare(dealt.shares[i].share)
    holders.push(holder)
  }
  const release = (asPod) => requestShareRelease({
    identity: asPod, agentId: AGENT, groupId: GROUP, trustedDealers, holders: names,
    peers: pods.map((p, i) => ({ holder: names[i], publicKey: memberKeys[i], send: (request) => holders[i].handle(asPod.podId, structuredClone(request)) })),
  })
  return { dealt, pods, release }
}

describe('a group secret obtained through the release round opens an agent\'s owned stores', () => {
  it('a member releases the secret, derives the lookup nonce and key, reads the shards, and cannot store under them', async () => {
    const { dealt, pods, release } = await setup()
    const agentIdentity = await PodIdentity.generate()
    const dhtNode = new DhtNode({ localId: 'n', storePolicy: { mode: 'owned' } })

    // the agent writes with the nonce and key derived from the dealt secret
    const nonce = await deriveStealthLookupNonce(dealt.secret, AGENT)
    const key = await deriveStealthKey(dealt.secret, GROUP)
    const make = (identity, extra = {}) => new StealthAgent({ agentId: AGENT, dhtNode, identity, lookupNonce: nonce, key, shardFormat: 3, ownedStores: true, ...extra })
    const manifest = await make(agentIdentity).hideEncrypted(STATE)
    assert.ok(manifest.shardKeys.every((k) => dhtNode.ownerOf(k)), 'every shard key is owned')

    // a member knows nothing but the release round
    const out = await release(pods[2])
    assert.deepEqual(out.secret, dealt.secret)
    const memberNonce = await deriveStealthLookupNonce(out.secret, AGENT)
    assert.equal(memberNonce, nonce, 'the released secret yields the same anonymous keys')
    const member = make(pods[2], { key: await deriveStealthKey(out.secret, GROUP), lookupNonce: memberNonce, trustedKeys: [await raw(agentIdentity)] })
    assert.equal(await member.reconstituteEncrypted(), STATE)

    // reading is all the secret grants: the writer keys stay with the agent's identity
    await assert.rejects(member.hideEncrypted('the member overwrites'), (e) => e instanceof StealthError && e.code === 'store-refused')
    assert.equal(await make(agentIdentity).reconstituteEncrypted(), STATE)
  })

  it('a pod that is not in the holders\' roster gets no share, so it cannot find the keys at all', async () => {
    const { dealt, pods, release } = await setup()
    const outsider = await PodIdentity.generate()
    const dhtNode = new DhtNode({ localId: 'n', storePolicy: { mode: 'owned' } })
    const agent = new StealthAgent({ agentId: AGENT, dhtNode, identity: await PodIdentity.generate(), lookupNonce: await deriveStealthLookupNonce(dealt.secret, AGENT), shardFormat: 3, ownedStores: true })
    await agent.hideSigned(STATE)
    await assert.rejects(release(outsider), (e) => e.code === 'below-threshold')
    void pods
  })
})
