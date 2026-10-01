/**
 * Supervised hosted pods: issue #185 item 6, the last row of
 * `docs/hosted-pods.md` §8a's control-surface table -- `restart` policy +
 * `status`/`spawn`/`drain` in a loop.
 *
 * The precedent is OTP: **links** (parent/child pods that cascade on
 * drain), **monitors** (be told when a pod you care about dies), and
 * **supervisors** (a `restart` policy that re-issues `spawn`). The one
 * rule that matters throughout: **a restart is a NEW spawn request the
 * host may refuse** -- this example never calls the driver directly, only
 * `createPodSupervisor()`'s own `supervise()`/`drain()`, which always go
 * through the same gated `PodHostClient` round trip `13-pod-host-service
 * .mjs` exercises directly.
 *
 * Cast:
 *   - alice: the HOST, exactly as in `13-pod-host-service.mjs`
 *     (`createPodHostService()` over an `InMemoryPodHostDriver`, lane
 *     `node`).
 *   - bob:   the OPERATOR. Builds a `PodSupervisor` over his own
 *     `PeerNode`, supervises a parent pod with `restart: 'on-failure'`
 *     and a linked child, crashes the parent twice via the driver's
 *     test-only `crash()` (`host-protocol.mjs`) to watch two restarts with
 *     doubling backoff happen for real, then drains the parent with
 *     cascade and watches the child go with it.
 *
 * Fake timers are not needed here: `backoffMs` is set low (50ms) so the
 * whole script finishes in well under a second under `npm run examples`.
 */

import assert from 'node:assert/strict'
import {
  IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL,
} from '@johnhenry/browsermesh-core'
import { InMemoryPodHostDriver, POD_LANE } from '@johnhenry/browsermesh-pod'
import {
  PeerNode, PeerRegistry, attachService, createPodHostService, createPodHostClient,
  createPodSupervisor, DEFAULT_POD_HOST_RESOURCE,
} from '@johnhenry/browsermesh-apps'

const RESOURCE = DEFAULT_POD_HOST_RESOURCE
const ALL_VERBS = ['spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list']

// ── Step 1: two real Ed25519 identities (mirrors 13-pod-host-service.mjs) ──
async function createPeer(label) {
  const identityManager = new MeshIdentityManager({})
  const wallet = new IdentityWallet({ identityManager })
  const { podId } = await wallet.createIdentity(label)
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId }),
  })
  return { podId, wallet, registry }
}

const alice = await createPeer('alice') // the pod host
const bob = await createPeer('bob') // the operator, running the supervisor

console.log('1. two real Ed25519 identities created: alice (host), bob (operator) ✓')

async function linkRealNodes(nodeA, nodeB) {
  let aOnMessage = null
  let bOnMessage = null
  const transportForA = {
    send(data) { queueMicrotask(() => { if (bOnMessage) bOnMessage(data) }) },
    onMessage(cb) { aOnMessage = cb },
  }
  const transportForB = {
    send(data) { queueMicrotask(() => { if (aOnMessage) aOnMessage(data) }) },
    onMessage(cb) { bOnMessage = cb },
  }
  await nodeA.adoptIncomingSession(nodeB.podId, transportForA, 'inmemory')
  await nodeB.adoptIncomingSession(nodeA.podId, transportForB, 'inmemory')
}

const nodeAlice = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
const nodeBob = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
await nodeAlice.boot()
await nodeBob.boot()
await linkRealNodes(nodeAlice, nodeBob)

console.log('2. two real PeerNodes booted and linked (alice-bob) ✓')

// ── Step 3: alice hosts pods; bob gets every verb ─────────────────────────
const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
const hostHandle = attachService(nodeAlice, undefined, createPodHostService({
  driver, hostLabel: 'alice-host',
}))
alice.registry.grantCapabilities(bob.podId, ALL_VERBS.map((verb) => `${RESOURCE}:${verb}`))
console.log('3. alice is hosting (lane=\'node\'); bob granted all eight verbs ✓')

// ── Step 4: bob builds a PodSupervisor over his own client ────────────────
const client = createPodHostClient({ peerNode: nodeBob, timeoutMs: 5000 })
/** @type {object[]} */
const eventLog = []
const supervisor = createPodSupervisor({ client, peerNode: nodeBob, onLog: () => {} })
for (const event of [
  'supervisor:restart-scheduled', 'supervisor:restarted', 'supervisor:gave-up', 'supervisor:cascade',
]) {
  supervisor.on(event, (data) => eventLog.push({ event, ...data }))
}
console.log('4. bob built a PodSupervisor over his own PodHostClient ✓')

// ── Step 5: supervise a parent (on-failure) ────────────────────────────────
// The linked child comes LATER (step 9), deliberately: a parent exit --
// even one the restart policy is about to repair -- cascades to its
// children immediately (see `pod-supervisor.mjs`'s own `#onExit()`: the
// cascade and the exiting pod's OWN restart decision are independent). A
// child present for these first two crashes would be drained on the FIRST
// one, leaving nothing for step 10's explicit `drain({cascade: true})` to
// show.
const parent = await supervisor.supervise(alice.podId, {
  name: 'render-worker',
  lane: POD_LANE.NODE,
  run: { kind: 'command', ref: '/usr/bin/ffmpeg' },
  restart: { policy: 'on-failure', maxRestarts: 3, backoffMs: 50 },
})
assert.equal(parent.status.state, 'registered')
console.log(`5. supervising '${parent.ref.name}' (restart: on-failure, backoffMs: 50) ✓`)
supervisor.monitor(parent.ref, ({ event }) => eventLog.push({ event: 'monitor', kind: event.kind, data: event.data }))

// ── Step 6: crash the parent TWICE -- two restarts with doubling backoff ──
await driver.crash('render-worker', { code: 1 })
await new Promise((resolve) => setTimeout(resolve, 200)) // first restart lands (50ms backoff)
let entries = supervisor.list()
let worker = entries.find((p) => p.ref.name === 'render-worker')
assert.equal(worker.restarts, 1)
assert.equal(worker.state, 'running')
console.log(`6. crashed '${worker.ref.name}' once -- restarted (restarts=${worker.restarts}, state=${worker.state}) ✓`)

await driver.crash('render-worker', { code: 1 })
await new Promise((resolve) => setTimeout(resolve, 300)) // second backoff is longer (doubled)
entries = supervisor.list()
worker = entries.find((p) => p.ref.name === 'render-worker')
assert.equal(worker.restarts, 2)
assert.equal(worker.state, 'running')
console.log(`7. crashed '${worker.ref.name}' again -- restarted a second time (restarts=${worker.restarts}, state=${worker.state}) ✓`)

const scheduled = eventLog.filter((e) => e.event === 'supervisor:restart-scheduled')
assert.equal(scheduled.length, 2)
assert.ok(scheduled[1].delayMs > scheduled[0].delayMs, 'backoff must grow between attempts')
console.log(`8. backoff doubled across attempts: ${scheduled.map((e) => e.delayMs).join('ms -> ')}ms ✓`)

// ── Step 9: NOW link a child -- after the crash storm has settled ─────────
const child = await supervisor.supervise(alice.podId, {
  name: 'render-logger',
  lane: POD_LANE.NODE,
  run: { kind: 'command', ref: '/bin/tail' },
  restart: { policy: 'never' },
  links: { parent: 'render-worker' },
})
assert.equal(child.status.state, 'registered')
console.log(`9. linked a child '${child.ref.name}' to '${parent.ref.name}' (links.parent) ✓`)

// ── Step 10: drain the parent with cascade -- child goes first ────────────
const { order } = await supervisor.drain(parent.ref, { cascade: true })
assert.deepEqual(order.map((r) => r.name), ['render-logger', 'render-worker'])
assert.equal((await driver.status('render-logger')).state, 'gone')
assert.equal((await driver.status('render-worker')).state, 'gone')
console.log(`10. drained '${parent.ref.name}' with cascade=true -- order: ${order.map((r) => r.name).join(' -> ')} ✓`)

// ── Step 11: the full event log this run produced ──────────────────────────
console.log('\n11. full supervisor event log:')
for (const entry of eventLog) {
  console.log(`   ${entry.event}: ${JSON.stringify(entry).slice(0, 160)}`)
}

// ── Cleanup ─────────────────────────────────────────────────────────────
supervisor.stop()
client.close()
await hostHandle.teardown()
await nodeAlice.shutdown()
await nodeBob.shutdown()

console.log('\nDone. A restart is a new spawn request the host may refuse -- this one')
console.log('never bypassed the gate, twice, and the cascade reached the linked child')
console.log('from a plain drain() call -- OTP\'s links/monitors/supervisors, over the')
console.log('exact same eight-verb control surface every other example in this')
console.log('directory drives.')
