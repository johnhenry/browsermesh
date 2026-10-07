/**
 * Issue #185 control-surface item 3: an HTTP-shaped view of the pod-host
 * service, driven two ways.
 *
 * Part 1 -- "control from within": bob is a mesh peer. He drives a pod
 * hosted on alice via `podHostFetch()` (`pod-host-routes.mjs`), which is
 * built on `browserMeshFetch('mesh://<host>/pods...')` -- the real
 * `fetch()`-shaped mesh transport from `examples/08-mesh-fetch-websocket.mjs`
 * -- rather than hand-building `pod-host:request` envelopes the way
 * `examples/13-pod-host-service.mjs`'s `createPodHostClient()` does. Alice
 * mounts `createPodHostRouter()` under `createMeshRpcService({onRequest})`
 * via `createPodHostMeshRpcHandler()` -- see `pod-host-routes.mjs`'s module
 * doc comment for why that `onRequest` slot, not `MeshFetchRouter`, is the
 * real host-side mount point.
 *
 * Part 2 -- "control from outside": the SAME eight-verb control surface,
 * driven over real HTTP by something that isn't a mesh peer at all. A
 * `createPodHostGatewayHandler()` sits on its own mesh identity (granted
 * access by alice, same as bob), served over real `node:http` by
 * `serveNodeGateway()`. An external caller authenticates with a bearer
 * token and talks plain HTTP/JSON to `/hosts/alice/pods...` -- the gateway
 * translates that into real, gated `pod-host:request` calls against alice
 * using ITS OWN identity (see `pod-host-gateway.mjs`'s "IDENTITY CAVEAT").
 *
 * Both parts drive the identical lifecycle -- spawn, status, exec,
 * snapshot, restore, drain -- against the same `InMemoryPodHostDriver`
 * pod host alice runs, so this example reads as "same control surface, two
 * transports" rather than two different demos.
 */

import assert from 'node:assert/strict'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'
import { InMemoryPodHostDriver, POD_LANE, POD_LIFECYCLE } from '@johnhenry/browsermesh-pod'
import {
  PeerNode,
  PeerRegistry,
  attachService,
  createMeshRpcService,
  createBrowserMeshFetch,
  createPodHostService,
  createPodHostClient,
  DEFAULT_POD_HOST_RESOURCE,
  createPodHostRouter,
  createPodHostMeshRpcHandler,
  podHostFetch,
  createPodHostGatewayHandler,
  serveNodeGateway,
} from '@johnhenry/browsermesh-apps'

const RESOURCE = DEFAULT_POD_HOST_RESOURCE
const ALL_VERBS = ['spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list']

// ── Step 1: real Ed25519 identities (same pattern as example 13) ──────────
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

const alice = await createPeer('alice') // the pod host
const bob = await createPeer('bob') // mesh peer, drives pods via podHostFetch
const carol = await createPeer('carol') // stranger, granted nothing
const gatewayOperator = await createPeer('gateway') // the HTTP gateway's own mesh identity

console.log('1. four real Ed25519 identities created: alice (host), bob (mesh peer), carol (stranger), gateway (HTTP gateway identity) ✓')

const nodeAlice = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
const nodeBob = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
const nodeCarol = new PeerNode({ wallet: carol.wallet, registry: carol.registry })
const nodeGateway = new PeerNode({ wallet: gatewayOperator.wallet, registry: gatewayOperator.registry })
await nodeAlice.boot()
await nodeBob.boot()
await nodeCarol.boot()
await nodeGateway.boot()
await linkRealNodes(nodeAlice, nodeBob)
await linkRealNodes(nodeAlice, nodeCarol)
await linkRealNodes(nodeAlice, nodeGateway)

console.log('2. four real PeerNodes booted and linked (alice–bob, alice–carol, alice–gateway) ✓')

// ── Step 2: alice hosts, over BOTH the envelope protocol (for the gateway,
// via createPodHostClient) and the HTTP route table (for podHostFetch, via
// createMeshRpcService's onRequest) -- same driver underneath either way.
const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
const hostHandle = attachService(nodeAlice, undefined, createPodHostService({ driver, hostLabel: 'alice-laptop' }))
const router = createPodHostRouter({ api: hostHandle.api, registry: alice.registry })
const hostRpcHandle = attachService(nodeAlice, undefined, createMeshRpcService({
  onRequest: createPodHostMeshRpcHandler(router),
}))

alice.registry.grantCapabilities(bob.podId, ALL_VERBS.map((verb) => `${RESOURCE}:${verb}`))
alice.registry.grantCapabilities(gatewayOperator.podId, ALL_VERBS.map((verb) => `${RESOURCE}:${verb}`))
console.log(`3. alice is hosting (lane='${driver.lane}') and granted both bob and the gateway identity all ${ALL_VERBS.length} verbs ✓`)

// ── Part 1: bob drives a pod on alice via podHostFetch over mesh:// ───────
const bobRpc = attachService(nodeBob, undefined, createMeshRpcService({}))
const browserMeshFetch = createBrowserMeshFetch(bobRpc.api)
const meshClient = podHostFetch(alice.podId, { fetch: browserMeshFetch })

console.log('\n-- Part 1: control from within (podHostFetch over mesh://) --')

const spawned = await meshClient.spawn({
  name: 'transcoder',
  lane: POD_LANE.NODE,
  run: { kind: 'command', ref: '/usr/bin/ffmpeg' },
  limits: { vcpus: 2, memMib: 512 },
  restart: { policy: 'on-failure', maxRestarts: 3 },
})
assert.equal(spawned.state, POD_LIFECYCLE.REGISTERED)
console.log(`4. POST mesh://${alice.podId}/pods -> spawned '${spawned.name}', state='${spawned.state}' ✓`)

const status = await meshClient.status('transcoder')
assert.equal(status.state, POD_LIFECYCLE.REGISTERED)
console.log(`5. GET  mesh://${alice.podId}/pods/transcoder -> state='${status.state}' ✓`)

const execResult = await meshClient.exec('transcoder', ['ffmpeg', '-version'])
assert.equal(execResult.code, 0)
console.log(`6. POST mesh://${alice.podId}/pods/transcoder/exec -> exit=${execResult.code}, stdout='${execResult.stdout}' ✓`)

const snapshotted = await meshClient.snapshot('transcoder')
assert.equal(snapshotted.state, POD_LIFECYCLE.SNAPSHOTTED)
const restored = await meshClient.restore('transcoder')
assert.equal(restored.state, POD_LIFECYCLE.REGISTERED)
console.log('7. POST .../snapshot -> state=\'snapshotted\', POST .../restore -> state=\'registered\' ✓')

await meshClient.drain('transcoder', { cascade: true })
const afterDrain = await meshClient.status('transcoder')
assert.equal(afterDrain.state, POD_LIFECYCLE.GONE)
console.log('8. DELETE .../transcoder?cascade=true -> drained; status now \'gone\' ✓')

// Carol was never granted anything -- her spawn is refused with a real
// HTTP 403, printed from the raw Response (not podHostFetch, which only
// surfaces {code, message}) to show the actual status.
const carolRpc = attachService(nodeCarol, undefined, createMeshRpcService({}))
const carolFetch = createBrowserMeshFetch(carolRpc.api)
const strangerRes = await carolFetch(`mesh://${alice.podId}/pods`, {
  method: 'POST',
  body: { name: 'sneaky', lane: POD_LANE.NODE, run: { kind: 'command', ref: '/bin/sh' } },
})
assert.equal(strangerRes.status, 403)
console.log(`9. carol (ungranted) POST mesh://${alice.podId}/pods -> HTTP ${strangerRes.status} (EACCES) ✓`)
await carolRpc.teardown()

// ── Part 2: the SAME lifecycle, driven from outside the mesh over the
// Node HTTP gateway, authenticated with a bearer token the gateway's own
// auth() callback checks -- the operator's responsibility, not this
// package's (see pod-host-gateway.mjs's "IDENTITY CAVEAT").
console.log('\n-- Part 2: control from outside (the Node HTTP gateway) --')

const BEARER_TOKEN = 'demo-operator-token'
const gatewayClient = createPodHostClient({ peerNode: nodeGateway, timeoutMs: 5000 })
const gatewayHandler = createPodHostGatewayHandler({
  client: gatewayClient,
  resolveHost: { alice: alice.podId },
  auth: (req) => {
    const header = req.headers.get('authorization') || ''
    return { ok: header === `Bearer ${BEARER_TOKEN}` }
  },
})
const gateway = await serveNodeGateway({ handler: gatewayHandler, port: 0, host: '127.0.0.1' })
console.log(`10. Node HTTP gateway listening on ${gateway.url} (its own mesh identity: ${gatewayOperator.podId.slice(0, 12)}...) ✓`)

function authedFetch(path, init) {
  return fetch(`${gateway.url}${path}`, {
    ...init,
    headers: { ...(init?.headers || {}), authorization: `Bearer ${BEARER_TOKEN}` },
  })
}

const unauthedRes = await fetch(`${gateway.url}/hosts/alice/pods`)
assert.equal(unauthedRes.status, 401)
console.log(`11. GET  /hosts/alice/pods with no token -> HTTP ${unauthedRes.status} ✓`)

const spawnRes = await authedFetch('/hosts/alice/pods', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'transcoder2',
    lane: POD_LANE.NODE,
    run: { kind: 'command', ref: '/usr/bin/ffmpeg' },
  }),
})
assert.equal(spawnRes.status, 201)
const spawnedViaGateway = (await spawnRes.json()).result
console.log(`12. POST /hosts/alice/pods -> HTTP ${spawnRes.status}, spawned '${spawnedViaGateway.name}' ✓`)

const statusRes = await authedFetch('/hosts/alice/pods/transcoder2')
assert.equal(statusRes.status, 200)
console.log(`13. GET  /hosts/alice/pods/transcoder2 -> HTTP ${statusRes.status}, state='${(await statusRes.json()).result.state}' ✓`)

const execRes = await authedFetch('/hosts/alice/pods/transcoder2/exec', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ command: ['ffmpeg', '-version'] }),
})
assert.equal(execRes.status, 200)
console.log(`14. POST /hosts/alice/pods/transcoder2/exec -> HTTP ${execRes.status}, exit=${(await execRes.json()).result.code} ✓`)

const drainRes = await authedFetch('/hosts/alice/pods/transcoder2?cascade=true', { method: 'DELETE' })
assert.equal(drainRes.status, 204)
console.log(`15. DELETE /hosts/alice/pods/transcoder2?cascade=true -> HTTP ${drainRes.status} (no body) ✓`)

const unknownHostRes = await authedFetch('/hosts/nobody/pods')
assert.equal(unknownHostRes.status, 404)
console.log(`16. GET  /hosts/nobody/pods (unresolvable host) -> HTTP ${unknownHostRes.status} ✓`)

const hostsRes = await fetch(`${gateway.url}/hosts`)
const hostsBody = await hostsRes.json()
assert.deepEqual(hostsBody.result, ['alice'])
console.log(`17. GET  /hosts -> HTTP ${hostsRes.status}, ${JSON.stringify(hostsBody.result)} ✓`)

// ── Cleanup ─────────────────────────────────────────────────────────────
await gateway.close()
gatewayClient.close()
await hostRpcHandle.teardown()
await bobRpc.teardown()
await hostHandle.teardown()
await nodeAlice.shutdown()
await nodeBob.shutdown()
await nodeCarol.shutdown()
await nodeGateway.shutdown()

console.log('\nDone. One eight-verb control surface, three transports: pod-host:*')
console.log('envelopes directly (example 13), fetch()-shaped mesh:// routes')
console.log('(podHostFetch, Part 1), and plain HTTP from outside the mesh')
console.log('entirely (the Node gateway, Part 2) -- same gate, same driver.')
