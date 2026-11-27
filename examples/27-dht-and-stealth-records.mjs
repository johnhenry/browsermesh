/**
 * browsermesh-discovery beyond a handshake: a DHT, owned stores, parity-
 * protected shards, and swarm membership, all in one process.
 *
 * Packages: browsermesh-discovery (DhtNode, signDhtStore, StealthAgent,
 * SwarmCoordinator, SwimMembership), browsermesh-primitives (PodIdentity).
 * No apps package is needed.
 *
 *   1. A ring of DHT nodes; one peer stores a value and a peer that is not
 *      one of its neighbours looks it up by walking the network.
 *   2. Owned stores (`storePolicy: { mode: 'owned' }`): a store signed by the
 *      key that owns the entry is accepted; a forged store (signed by someone
 *      else) is refused with the stable reason `not-key-owner`.
 *   3. Shard format 3 (`shardFormat: 3`, unsigned path): a StealthAgent's
 *      state is cut into 5 shards, any 3 of which rebuild it (SHA-256
 *      checksum + Reed-Solomon parity). Each shard lives on its own holder;
 *      lose two holders and the state is rebuilt, lose a third and recovery
 *      fails with `StealthError` `unavailable` rather than returning junk.
 *   4. Swarm membership: four pods, seeded as a chain (each knows only the
 *      next), run `SwimMembership` over an in-process wire and feed a
 *      `SwarmCoordinator`. SWIM spreads every update along the chain, so all
 *      see the same members; a pod that is let go (`leave`) and a pod that
 *      goes silent both drop out of every other coordinator.
 *
 * Not shown: signed shards (`identity`) and `ownedStores: true` on the
 * agent, on-demand share release and threshold (Shamir) key shares. They
 * are built (see docs/design/discovery-records.md) but need more setup than
 * an example: a roster of keys, a protocol channel per holder, a dealer.
 * Also not shown: a StealthAgent reading its shards across the network. The
 * agent reads its own node's store (`dhtNode.get`), so step 3 fetches each
 * shard from its holder with a plain DHT_FIND_VALUE and stores it locally.
 * `SwarmCoordinator` has no wire of its own (README: its `SWARM_*` types are
 * unused), so step 4 gets membership from SWIM and passes it in as `swim`.
 */

import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import {
  DhtNode, DHT_FIND_VALUE, DHT_STORE, StealthAgent, StealthError, SwarmCoordinator, SwimMembership, signDhtStore,
} from '@johnhenry/browsermesh-discovery'

// ── 1. A small DHT ───────────────────────────────────────────────────
// Eight nodes in a ring; each knows only its three successors, so a store
// reaches three neighbours and a stranger has to walk the network to find it.
// `owned` nodes accept unsigned stores for keys nobody owns (`openPrefixes`).
const ids = await Promise.all(Array.from({ length: 8 }, () => PodIdentity.generate()))
const nodes = new Map()
const inflight = []
// The wire: delivery is in-process and asynchronous; `settle()` drains it.
const sendFrom = (from) => (to, msg) => {
  inflight.push(Promise.resolve(nodes.get(to).handleMessage(from, msg)))
}
const settle = async () => { while (inflight.length) await inflight.shift() }
for (const { podId } of ids) {
  nodes.set(podId, new DhtNode({ localId: podId, sendFn: sendFrom(podId), storePolicy: { mode: 'owned', openPrefixes: ['note:'] } }))
}
ids.forEach(({ podId }, i) => {
  nodes.get(podId).bootstrap([1, 2, 3].map((d) => ({ podId: ids[(i + d) % ids.length].podId })))
})
const [alice, , , , bob, , mallory] = ids

// Walk outward from `start` (FIND_VALUE, following `closest`) until a node has the key.
async function lookup(start, key) {
  const seen = new Set([start.localId])
  const queue = [start.localId]
  while (queue.length) {
    const asked = nodes.get(queue.shift())
    const r = asked.findValue(key)
    if (r.found) return r.value
    for (const c of r.closest) if (!seen.has(c.podId)) { seen.add(c.podId); queue.push(c.podId) }
  }
  return undefined
}

await nodes.get(alice.podId).store('note:greeting', { text: 'hello from alice' })
await settle()
assert.equal(nodes.get(bob.podId).findValue('note:greeting').found, false, 'bob is not one of the three replicas')
const found = await lookup(nodes.get(bob.podId), 'note:greeting')
assert.deepEqual(found, { text: 'hello from alice' })
console.log('1. ✓ bob looked up alice\'s value by walking the ring:', found.text)

// ── 2. Owned stores ──────────────────────────────────────────────────
// A pod-id key can only be stored by that pod: the proof's writer key must hash to the key.
const record = { podId: alice.podId, label: 'alice' }
const exp = Date.now() + 3_600_000
const auth = await signDhtStore({ signer: alice, key: alice.podId, value: record, seq: 1, exp })
const owner = nodes.get(alice.podId)
let r = await owner.store(alice.podId, record, 0, { auth })
assert.equal(r.stored, true)
console.log('2. ALLOWED  signed store by the key owner')
await settle()
assert.deepEqual(await lookup(nodes.get(bob.podId), alice.podId), record)

// Mallory signs a perfectly valid proof, but with her own key, for alice's entry,
// and sends it to a node that holds alice's record (a ring neighbour of alice).
const holder = nodes.get(ids[1].podId)
assert.equal(holder.ownerOf(alice.podId) !== null, true, 'the replica knows its owner')
const forgedValue = { podId: alice.podId, label: 'alice (really mallory)' }
const forged = await signDhtStore({ signer: mallory, key: alice.podId, value: forgedValue, seq: 2, exp })
r = await holder.handleMessage(mallory.podId, { type: DHT_STORE, from: mallory.podId, key: alice.podId, value: forgedValue, ttl: 0, auth: forged })
assert.deepEqual(r.refused, 'not-key-owner')
console.log(`   REFUSED  forged store: ${r.refused}`)
// An unsigned store for the same, already-owned key is refused too.
r = await holder.handleMessage(mallory.podId, { type: DHT_STORE, from: mallory.podId, key: alice.podId, value: forgedValue, ttl: 0 })
console.log(`   REFUSED  unsigned store: ${r.refused}`)
assert.equal(r.refused, 'owned-key')
assert.deepEqual(holder.get(alice.podId), record, 'alice\'s record is untouched')
console.log('   refusals are counted:', JSON.stringify(holder.storeStats.refused))

// ── 3. Shard format 3: any 3 of 5 shards rebuild the state ───────────
// Five holders, one shard each. The writer's node replicates every shard to
// every holder, so we place each shard by key (the app's placement choice).
const state = JSON.stringify({ memory: ['the launch code is 0000'], mood: 'curious ☃' })
const holders = Array.from({ length: 5 }, (_, i) => new DhtNode({ localId: `holder-${i}` }))
const writerNode = new DhtNode({ localId: 'writer', sendFn: (to, msg) => {
  const i = Number(to.slice('holder-'.length))
  if (msg.key.endsWith(`:${i}`)) holders[i].handleMessage('writer', msg)
} })
writerNode.bootstrap(holders.map((h) => ({ podId: h.localId })))
const shape = { agentId: 'agent-007', threshold: 3, totalShards: 5, shardFormat: 3 }
const manifest = await new StealthAgent({ ...shape, dhtNode: writerNode }).hideAsync(state)
console.log(`3. ✓ state split into ${manifest.totalShards} shards, any ${manifest.threshold} rebuild it (parity: ${manifest.parity})`)

// A reader with an empty node collects shards from whichever holders answer.
async function recover(down) {
  const readerNode = new DhtNode({ localId: 'reader' })
  manifest.shardKeys.forEach((key, i) => {
    if (down.has(i)) return // this holder is gone
    const res = holders[i].handleMessage('reader', { type: DHT_FIND_VALUE, key })
    if (res.found) readerNode.store(key, res.value)
  })
  return new StealthAgent({ ...shape, dhtNode: readerNode, readFormats: [3] }).reconstituteAsync()
}
assert.equal(await recover(new Set()), state)
// Lose holders 0 and 1: two of the three data shards. Parity rebuilds them.
assert.equal(await recover(new Set([0, 1])), state)
console.log('   ALLOWED  recovered with 2 of 5 holders lost (both were data shards)')
// A third loss leaves 2 < threshold: a named error, never a partial state.
const err = await recover(new Set([0, 1, 4])).catch((e) => e)
assert.ok(err instanceof StealthError)
assert.equal(err.code, 'unavailable')
console.log(`   REFUSED  recovery with 3 of 5 holders lost: ${err.code}`)

// ── 4. Swarm membership ──────────────────────────────────────────────
// Each pod runs SWIM (failure-detecting membership) and a coordinator fed by
// it: SWIM's `alive` joins the coordinator, `left` and `dead` drop the member.
// The seeds are a chain (a knows b, b knows c, c knows d); SWIM spreads each
// update along it, so every pod ends up with every other.
const wire = new Map()
const names = ['pod-a', 'pod-b', 'pod-c', 'pod-d']
for (const name of names) {
  const swim = new SwimMembership({
    localId: name, pingIntervalMs: 10, pingTimeoutMs: 30, suspectTimeoutMs: 30,
    sendFn: (to, msg) => queueMicrotask(() => wire.get(to)?.swim.handleMessage(name, structuredClone(msg))),
  })
  wire.set(name, { swim, swarm: new SwarmCoordinator(name, { swim }) })
}
names.slice(0, -1).forEach((name, i) => wire.get(name).swarm.join(names[i + 1]))
for (const { swim } of wire.values()) swim.start()
const until = async (what, ok) => {
  const deadline = Date.now() + 2000
  while (!ok() && Date.now() < deadline) await new Promise((res) => setTimeout(res, 10))
  assert.ok(ok(), `timed out: ${what}`)
}
const membersOf = (name) => wire.get(name).swarm.listMembers().sort().join(', ')
await until('everyone sees all four', () => names.every((n) => wire.get(n).swarm.listMembers().length === 4))
console.log(`4. ✓ a chain of seeds still gives every pod the full view: pod-a [${membersOf('pod-a')}]`)

// A pod that leaves: pod-a lets pod-d go. SWIM gossips `left`, so pod-b and
// pod-c drop pod-d too, though neither was told directly.
wire.get('pod-a').swarm.leave('pod-d')
await until('pod-d dropped everywhere', () => ['pod-a', 'pod-b', 'pod-c'].every((n) => !wire.get(n).swarm.listMembers().includes('pod-d')))
console.log(`   ✓ pod-a let pod-d leave; pod-b's view follows: [${membersOf('pod-b')}]`)

// A pod that goes silent: pod-c stops answering. The others suspect it, then
// declare it dead, and drop it from their coordinators.
wire.get('pod-c').swim.stop()
wire.delete('pod-c')
await until('pod-c dropped', () => ['pod-a', 'pod-b'].every((n) => !wire.get(n).swarm.listMembers().includes('pod-c')))
console.log(`   ✓ pod-c went silent and was dropped: pod-a [${membersOf('pod-a')}], pod-b [${membersOf('pod-b')}]`)
const leader = wire.get('pod-b').swarm.election.elect()
console.log(`   the survivors elect the lowest id: ${leader}`)
assert.equal(leader, 'pod-a')

for (const { swim, swarm } of wire.values()) { swim.stop(); swarm.stop() }

console.log('ok: DHT lookups, owned stores, parity-protected shards and swarm membership behaved as designed')
