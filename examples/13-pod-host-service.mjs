/**
 * Hosted pods, end to end over a real mesh: alice HOSTS pods, bob DRIVES
 * them, carol is turned away.
 *
 * This is the control surface from issue #185 (`docs/hosted-pods.md`,
 * "Control surface") doing real work. One lane-agnostic verb set --
 * `spawn, status, send, exec, snapshot, restore, drain, list` -- defined as
 * plain data in `@johnhenry/browsermesh-pod`'s `host-protocol.mjs`, served
 * over a `PeerNode` by `createPodHostService()` in
 * `@johnhenry/browsermesh-apps`, and called from another `PeerNode` by
 * `createPodHostClient()`.
 *
 * The cast matches `09-cloud-storage.mjs`/`10-mesh-kv-and-observability.mjs`
 * for the same reason those two share it: "operator / authorized peer /
 * stranger" is exactly the shape an access-gated service needs to tell its
 * story.
 *
 *   - alice: the HOST. Attaches the pod host service over an
 *     `InMemoryPodHostDriver` on the `'node'` lane, so every verb works
 *     with no workerd process and no KVM box behind it.
 *   - bob:   granted all eight verbs. Spawns a pod, execs in it, snapshots
 *     it, restores it, drains it -- and watches the lifecycle events stream
 *     back as it happens.
 *   - carol: granted nothing. Her spawn is refused with `EACCES`, loudly
 *     and with an audit record, not silently dropped.
 *
 * Why the in-memory driver rather than a real lane? Because `npm run
 * examples` must stay dependency-free and runnable on a laptop. The two
 * real drivers (`spikes/vm-pod-host/src/driver.mjs` for Firecracker,
 * `spikes/isolate-pod-host/src/driver.mjs` for workerd Durable Objects)
 * implement the SAME `PodHostDriver` interface this one does -- swapping
 * them in changes nothing below this comment except which verbs answer
 * `ELANE`.
 */

import assert from 'node:assert/strict'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'
import {
  InMemoryPodHostDriver,
  POD_HOST_ERROR,
  POD_LANE,
  POD_LIFECYCLE,
} from '@johnhenry/browsermesh-pod'
import {
  PeerNode,
  PeerRegistry,
  attachService,
  createPodHostService,
  createPodHostClient,
  DEFAULT_POD_HOST_RESOURCE,
} from '@johnhenry/browsermesh-apps'

const RESOURCE = DEFAULT_POD_HOST_RESOURCE
const ALL_VERBS = ['spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list']

// ── Step 1: three real Ed25519 identities ─────────────────────────────────
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
const bob = await createPeer('bob') // authorized operator
const carol = await createPeer('carol') // stranger

console.log('1. three real Ed25519 identities created: alice (host), bob (operator), carol (stranger) ✓')

// ── Step 2: real PeerNodes, linked over a minimal in-memory duplex
// transport -- same `linkRealNodes()` helper 10-mesh-kv-and-observability.mjs
// uses, for the same reason: real `PeerNode` sessions, no WebRTC needed.
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
const nodeCarol = new PeerNode({ wallet: carol.wallet, registry: carol.registry })
await nodeAlice.boot()
await nodeBob.boot()
await nodeCarol.boot()
await linkRealNodes(nodeAlice, nodeBob)
await linkRealNodes(nodeAlice, nodeCarol)

console.log('2. three real PeerNodes booted and linked (alice–bob, alice–carol) ✓')

// ── Step 3: alice becomes a pod host ──────────────────────────────────────
const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
const hostHandle = attachService(nodeAlice, undefined, createPodHostService({
  driver,
  hostLabel: 'alice-laptop',
}))

const denials = []
hostHandle.on('pod-host:denied', (data) => denials.push(data))

const description = hostHandle.api.describe()
console.log(
  `3. alice is hosting: lane='${description.lane}', verbs=[${description.verbs.join(', ')}], ` +
  `shellBackend='${description.shellBackend}', canDeploy=${description.deploymentSupport.canDeploy} ✓`,
)

// ── Step 4: alice grants bob the whole verb set, and nothing to carol ─────
alice.registry.grantCapabilities(bob.podId, ALL_VERBS.map((verb) => `${RESOURCE}:${verb}`))
console.log(`4. alice granted bob ${ALL_VERBS.length} scopes under '${RESOURCE}'; carol got nothing ✓`)

// ── Step 5: bob watches the pod lifecycle before he causes any of it ──────
const bobClient = createPodHostClient({ peerNode: nodeBob, timeoutMs: 5000 })
const lifecycle = []
bobClient.onEvent((hostPubKey, event) => {
  if (event.kind === 'lifecycle') lifecycle.push(`${event.data.from}→${event.data.to}`)
})
console.log('5. bob subscribed to alice\'s pod lifecycle events ✓')

// ── Step 6: bob spawns a pod on alice's host ──────────────────────────────
const spawned = await bobClient.spawn(alice.podId, {
  name: 'transcoder',
  lane: POD_LANE.NODE,
  run: { kind: 'command', ref: '/usr/bin/ffmpeg', entry: 'transcode.sh' },
  limits: { vcpus: 2, memMib: 512, timeoutMs: 30_000 },
  caps: ['net', 'fs'],
  env: { LOG_LEVEL: 'info' },
  budget: { credits: 25, currency: 'bmc' },
  restart: { policy: 'on-failure', maxRestarts: 3, backoffMs: 500 },
  labels: { team: 'media' },
})
assert.equal(spawned.state, POD_LIFECYCLE.REGISTERED)
assert.equal(spawned.spec.restart.policy, 'on-failure')
console.log(`6. bob spawned '${spawned.name}' on alice: state='${spawned.state}', lane='${spawned.lane}' ✓`)

// ── Step 7: bob execs inside it ───────────────────────────────────────────
const execResult = await bobClient.exec(alice.podId, 'transcoder', ['ffmpeg', '-version'])
assert.equal(execResult.code, 0)
console.log(`7. bob ran 'ffmpeg -version' in the pod: exit=${execResult.code}, stdout='${execResult.stdout}' ✓`)

// ── Step 8: snapshot and restore -- the §5.3 lifecycle, over the mesh ─────
assert.equal((await bobClient.snapshot(alice.podId, 'transcoder')).state, POD_LIFECYCLE.SNAPSHOTTED)
assert.equal((await bobClient.restore(alice.podId, 'transcoder')).state, POD_LIFECYCLE.REGISTERED)
console.log('8. bob snapshotted the pod and restored it -- registered → paused → snapshotted → restoring → registered ✓')

// ── Step 9: carol is refused ──────────────────────────────────────────────
const carolClient = createPodHostClient({ peerNode: nodeCarol, timeoutMs: 5000 })
let carolError = null
try {
  await carolClient.spawn(alice.podId, { name: 'sneaky', lane: POD_LANE.NODE, run: { kind: 'command', ref: '/bin/sh' } })
} catch (err) {
  carolError = err
}
assert.ok(carolError, 'carol must not be able to spawn on alice')
assert.equal(carolError.code, POD_HOST_ERROR.EACCES)
assert.equal(denials.length, 1)
assert.equal(denials[0].from, carol.podId)
console.log(`9. carol's spawn was refused: code=${carolError.code} ("${carolError.message}"), and alice emitted pod-host:denied ✓`)

// ...but carol CAN still ask what alice offers: describe() is deliberately
// ungated, because a peer has to be able to discover a host exists before
// it can ask to be granted anything on it.
const carolView = await carolClient.describe(alice.podId)
assert.equal(carolView.lane, POD_LANE.NODE)
console.log(`10. carol can still discover the host (describe() is ungated): lane='${carolView.lane}' ✓`)

// ── Step 11: bob drains the pod ───────────────────────────────────────────
assert.equal((await bobClient.drain(alice.podId, 'transcoder', { cascade: true })).state, POD_LIFECYCLE.GONE)
const listed = await bobClient.list(alice.podId)
assert.deepEqual(listed.map((pod) => [pod.name, pod.state]), [['transcoder', 'gone']])
console.log('11. bob drained the pod; list() reports it as gone ✓')

// ── Step 12: the lifecycle bob watched, start to finish ───────────────────
await new Promise((resolve) => setTimeout(resolve, 20))
assert.deepEqual(lifecycle, [
  'cold→booting', 'booting→registered',
  'registered→serving', 'serving→registered',
  'registered→paused', 'paused→snapshotted',
  'snapshotted→restoring', 'restoring→registered',
  'registered→draining', 'draining→gone',
])
console.log(`12. bob observed the whole lifecycle live: ${lifecycle.join(' ')} ✓`)

// ── Cleanup ───────────────────────────────────────────────────────────────
bobClient.close()
carolClient.close()
await hostHandle.teardown()
await nodeAlice.shutdown()
await nodeBob.shutdown()
await nodeCarol.shutdown()

console.log('\nDone. One verb set, one gate, one audit trail -- and the same')
console.log('service would be driving a Firecracker microVM or a Cloudflare')
console.log('Durable Object if the driver underneath were swapped.')
