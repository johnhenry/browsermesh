/**
 * Tests for pod-host-routes.mjs -- issue #185 control-surface item 3's
 * HTTP-shaped view of the pod-host service over `mesh://` URLs.
 *
 * Layers:
 *   - `matchPodHostRoute()` / `POD_HOST_ROUTES`: pure route matching, every
 *     entry, bad names, unknown paths.
 *   - `statusForError()` / `successStatusForVerb()`: the whole status map.
 *   - `createPodHostRouter()` + `createPodHostMeshRpcHandler()` mounted on a
 *     real host `PeerNode` under `createMeshRpcService({onRequest})`, driven
 *     by `podHostFetch()` over a real `browserMeshFetch()` from a second
 *     real `PeerNode` -- the full spawn -> status -> exec -> snapshot ->
 *     restore -> drain lifecycle, an access-denied 403, and an isolate-lane
 *     405 with an `Allow` header.
 *
 * Setup follows `pod-host-service.test.mjs`'s own pattern: real Ed25519
 * identities via `IdentityWallet`/`MeshIdentityManager`, real `PeerRegistry`s
 * over real `MeshACL`, wired with a minimal duck-typed `sendTo`/
 * `onIncomingData` bus -- real enough that `checkAccess()` is genuinely
 * enforced, without needing WebRTC.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/pod-host-routes.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'
import { InMemoryPodHostDriver, POD_HOST_ERROR, POD_LANE, POD_LIFECYCLE } from '@johnhenry/browsermesh-pod'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshRpcService } from '../src/mesh-rpc.mjs'
import { createBrowserMeshFetch } from '../src/mesh-fetch.mjs'
import { createPodHostService, DEFAULT_POD_HOST_RESOURCE } from '../src/pod-host-service.mjs'
import {
  POD_HOST_ROUTES,
  MESH_FROM_HEADER,
  matchPodHostRoute,
  statusForError,
  successStatusForVerb,
  createPodHostRouter,
  createPodHostMeshRpcHandler,
  podHostFetch,
} from '../src/pod-host-routes.mjs'

const RESOURCE = DEFAULT_POD_HOST_RESOURCE
const ALL_SCOPES = ['spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list']
  .map((verb) => `${RESOURCE}:${verb}`)

/** A real Ed25519 identity + wallet + registry bundle for one "peer". */
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

/** Same minimal duck-typed mesh bus `pod-host-service.test.mjs` uses. */
function wireMesh(peers) {
  const listeners = new Map()
  const nodes = new Map()
  for (const peer of peers) {
    listeners.set(peer.podId, new Set())
    nodes.set(peer.podId, {
      podId: peer.podId,
      wallet: peer.wallet,
      registry: peer.registry,
      onIncomingData(cb) {
        listeners.get(peer.podId).add(cb)
        return () => listeners.get(peer.podId).delete(cb)
      },
      async sendTo(pubKey, data) {
        const target = listeners.get(pubKey)
        if (!target) throw new Error(`no such peer: ${pubKey}`)
        queueMicrotask(() => {
          for (const cb of [...target]) cb(peer.podId, data)
        })
      },
    })
  }
  return nodes
}

function minimalSpec(overrides = {}) {
  return { name: 'alpha', lane: POD_LANE.NODE, run: { kind: 'command', ref: '/bin/echo' }, ...overrides }
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

describe('POD_HOST_ROUTES / matchPodHostRoute', () => {
  it('is frozen, and so is every entry', () => {
    assert.ok(Object.isFrozen(POD_HOST_ROUTES))
    for (const route of POD_HOST_ROUTES) assert.ok(Object.isFrozen(route))
  })

  it('matches every route table entry', () => {
    assert.deepEqual(matchPodHostRoute('GET', '/pods'), { verb: 'list', params: {} })
    assert.deepEqual(matchPodHostRoute('POST', '/pods'), { verb: 'spawn', params: {} })
    assert.deepEqual(matchPodHostRoute('GET', '/pods/alpha'), { verb: 'status', params: { name: 'alpha' } })
    assert.deepEqual(matchPodHostRoute('POST', '/pods/alpha/send'), { verb: 'send', params: { name: 'alpha' } })
    assert.deepEqual(matchPodHostRoute('POST', '/pods/alpha/exec'), { verb: 'exec', params: { name: 'alpha' } })
    assert.deepEqual(matchPodHostRoute('POST', '/pods/alpha/snapshot'), { verb: 'snapshot', params: { name: 'alpha' } })
    assert.deepEqual(matchPodHostRoute('POST', '/pods/alpha/restore'), { verb: 'restore', params: { name: 'alpha' } })
    assert.deepEqual(matchPodHostRoute('DELETE', '/pods/alpha'), { verb: 'drain', params: { name: 'alpha' } })
    assert.deepEqual(matchPodHostRoute('GET', '/host'), { verb: 'describe', params: {} })
  })

  it('is case-insensitive on method', () => {
    assert.deepEqual(matchPodHostRoute('get', '/pods'), { verb: 'list', params: {} })
  })

  it('rejects a :name segment that fails the name grammar', () => {
    assert.equal(matchPodHostRoute('GET', '/pods/bad name!'), null)
    assert.equal(matchPodHostRoute('GET', '/pods/%20'), null) // decodes to a lone space
    assert.equal(matchPodHostRoute('DELETE', '/pods/a%2Fb'), null) // decodes to 'a/b', not NAME_PATTERN-safe
  })

  it('collapses a trailing slash the same way a leading one is ignored (/pods/ still matches GET /pods)', () => {
    assert.deepEqual(matchPodHostRoute('GET', '/pods/'), { verb: 'list', params: {} })
  })

  it('returns null for an unknown method on a known path', () => {
    assert.equal(matchPodHostRoute('PATCH', '/pods'), null)
    assert.equal(matchPodHostRoute('PUT', '/pods/alpha'), null)
  })

  it('returns null for an unknown path', () => {
    assert.equal(matchPodHostRoute('GET', '/nope'), null)
    assert.equal(matchPodHostRoute('GET', '/pods/alpha/bogus'), null)
    assert.equal(matchPodHostRoute('GET', '/pods/alpha/send'), null) // send is POST-only
  })

  it('returns null for non-string inputs', () => {
    assert.equal(matchPodHostRoute(undefined, '/pods'), null)
    assert.equal(matchPodHostRoute('GET', undefined), null)
  })
})

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

describe('statusForError / successStatusForVerb', () => {
  it('maps every POD_HOST_ERROR code', () => {
    assert.equal(statusForError(POD_HOST_ERROR.EINVAL), 400)
    assert.equal(statusForError(POD_HOST_ERROR.EACCES), 403)
    assert.equal(statusForError(POD_HOST_ERROR.ENOENT), 404)
    assert.equal(statusForError(POD_HOST_ERROR.EEXIST), 409)
    assert.equal(statusForError(POD_HOST_ERROR.ELANE), 405)
    assert.equal(statusForError(POD_HOST_ERROR.ENOTSUP), 501)
    assert.equal(statusForError(POD_HOST_ERROR.ETIMEDOUT), 504)
    assert.equal(statusForError(POD_HOST_ERROR.EBUSY), 409)
  })

  it('maps an unknown code to 500', () => {
    assert.equal(statusForError('EWHATEVER'), 500)
    assert.equal(statusForError(undefined), 500)
  })

  it('maps success status per verb: 201 spawn, 204 drain, 200 everything else', () => {
    assert.equal(successStatusForVerb('spawn'), 201)
    assert.equal(successStatusForVerb('drain'), 204)
    for (const verb of ['status', 'send', 'exec', 'snapshot', 'restore', 'list', 'describe']) {
      assert.equal(successStatusForVerb(verb), 200)
    }
  })
})

// ---------------------------------------------------------------------------
// createPodHostRouter: argument validation
// ---------------------------------------------------------------------------

describe('createPodHostRouter: argument validation', () => {
  it('requires a driver (or api.driver)', () => {
    assert.throws(() => createPodHostRouter({ registry: { checkAccess: () => ({ allowed: true }) } }), /driver/)
  })

  it('requires a registry', () => {
    assert.throws(
      () => createPodHostRouter({ driver: new InMemoryPodHostDriver({ lane: POD_LANE.NODE }) }),
      /registry/,
    )
  })
})

describe('createPodHostRouter: route() is a Request -> Promise<Response|null> function, standalone', () => {
  it('returns null for a non-mesh-host path (same "not mine" contract as MeshFetchRouter.route())', async () => {
    const alice = await createPeer('alice')
    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    const router = createPodHostRouter({ driver, registry: alice.registry })
    const res = await router.route(new Request('http://pod-host.internal/totally/unrelated'))
    assert.equal(res, null)
  })

  it('answers GET /host without requiring the MESH_FROM_HEADER identity header', async () => {
    const alice = await createPeer('alice')
    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    const router = createPodHostRouter({ driver, registry: alice.registry })
    const res = await router.route(new Request('http://pod-host.internal/host'))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.result.lane, POD_LANE.NODE)
  })

  it('answers a gated route with 400 EINVAL when the identity header is missing', async () => {
    const alice = await createPeer('alice')
    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    const router = createPodHostRouter({ driver, registry: alice.registry })
    const res = await router.route(new Request('http://pod-host.internal/pods'))
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error.code, POD_HOST_ERROR.EINVAL)
  })

  it('answers a gated, authorized route when MESH_FROM_HEADER is set directly on the Request', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    const router = createPodHostRouter({ driver, registry: alice.registry })
    const res = await router.route(new Request('http://pod-host.internal/pods', {
      headers: { [MESH_FROM_HEADER]: bob.podId },
    }))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body.result, [])
  })
})

// ---------------------------------------------------------------------------
// End to end over a real mesh
// ---------------------------------------------------------------------------

describe('pod host over mesh://: router + podHostFetch, full lifecycle', () => {
  it('spawn -> status -> exec -> snapshot -> restore -> drain, all over browserMeshFetch', async () => {
    const alice = await createPeer('alice') // host
    const bob = await createPeer('bob') // operator
    const nodes = wireMesh([alice, bob])
    const nodeAlice = nodes.get(alice.podId)
    const nodeBob = nodes.get(bob.podId)

    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    const router = createPodHostRouter({ driver, registry: alice.registry })
    const hostRpc = attachService(nodeAlice, undefined, createMeshRpcService({
      onRequest: createPodHostMeshRpcHandler(router),
    }))
    const bobRpc = attachService(nodeBob, undefined, createMeshRpcService({}))
    const browserMeshFetch = createBrowserMeshFetch(bobRpc.api)
    const client = podHostFetch(alice.podId, { fetch: browserMeshFetch })

    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)

    const spawned = await client.spawn(minimalSpec())
    assert.equal(spawned.state, POD_LIFECYCLE.REGISTERED)
    assert.equal(spawned.name, 'alpha')

    const status = await client.status('alpha')
    assert.equal(status.state, POD_LIFECYCLE.REGISTERED)

    const execResult = await client.exec('alpha', ['echo', 'hi'])
    assert.equal(execResult.code, 0)
    assert.equal(execResult.stdout, 'echo hi')

    const sent = await client.send('alpha', { msg: 'hello' })
    assert.equal(sent.delivered, true)

    const snapshotted = await client.snapshot('alpha')
    assert.equal(snapshotted.state, POD_LIFECYCLE.SNAPSHOTTED)

    const restored = await client.restore('alpha')
    assert.equal(restored.state, POD_LIFECYCLE.REGISTERED)

    const listed = await client.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].name, 'alpha')

    const description = await client.describe()
    assert.equal(description.lane, POD_LANE.NODE)
    assert.ok(description.verbs.includes('exec'))

    await client.drain('alpha', { cascade: true })
    const afterDrain = await client.status('alpha')
    assert.equal(afterDrain.state, POD_LIFECYCLE.GONE)

    await hostRpc.teardown()
    await bobRpc.teardown()
  })

  it('access denied -> 403 EACCES', async () => {
    const alice = await createPeer('alice')
    const carol = await createPeer('carol') // ungranted stranger
    const nodes = wireMesh([alice, carol])
    const nodeAlice = nodes.get(alice.podId)
    const nodeCarol = nodes.get(carol.podId)

    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    const router = createPodHostRouter({ driver, registry: alice.registry })
    const hostRpc = attachService(nodeAlice, undefined, createMeshRpcService({
      onRequest: createPodHostMeshRpcHandler(router),
    }))
    const carolRpc = attachService(nodeCarol, undefined, createMeshRpcService({}))
    const browserMeshFetch = createBrowserMeshFetch(carolRpc.api)
    const client = podHostFetch(alice.podId, { fetch: browserMeshFetch })

    let caught = null
    try {
      await client.spawn(minimalSpec({ name: 'sneaky' }))
    } catch (err) {
      caught = err
    }
    assert.ok(caught, 'carol must not be able to spawn on alice')
    assert.equal(caught.code, POD_HOST_ERROR.EACCES)

    // describe() is ungated, same as the envelope client -- carol can still see it.
    const description = await client.describe()
    assert.equal(description.lane, POD_LANE.NODE)

    await hostRpc.teardown()
    await carolRpc.teardown()
  })

  it('isolate-lane driver: exec -> 405 with an Allow header listing supported verbs', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodes = wireMesh([alice, bob])
    const nodeAlice = nodes.get(alice.podId)
    const nodeBob = nodes.get(bob.podId)

    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.ISOLATE })
    const router = createPodHostRouter({ driver, registry: alice.registry })
    const hostRpc = attachService(nodeAlice, undefined, createMeshRpcService({
      onRequest: createPodHostMeshRpcHandler(router),
    }))
    const bobRpc = attachService(nodeBob, undefined, createMeshRpcService({}))
    const browserMeshFetch = createBrowserMeshFetch(bobRpc.api)
    const client = podHostFetch(alice.podId, { fetch: browserMeshFetch })

    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    await client.spawn(minimalSpec({ name: 'iso', lane: POD_LANE.ISOLATE }))

    // Drive the HTTP layer directly (not through podHostFetch, which only
    // surfaces {code, message}) to inspect the raw Response's status/headers.
    const res = await browserMeshFetch(`mesh://${alice.podId}/pods/iso/exec`, {
      method: 'POST',
      body: { command: ['sh', '-c', 'echo hi'] },
    })
    assert.equal(res.status, 405)
    assert.equal(res.headers.get('allow'), 'spawn, status, send, drain, list')
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.error.code, POD_HOST_ERROR.ELANE)

    await hostRpc.teardown()
    await bobRpc.teardown()
  })

  it('unknown route under the mesh mount answers 404 via the onRequest fallback', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodes = wireMesh([alice, bob])
    const nodeAlice = nodes.get(alice.podId)
    const nodeBob = nodes.get(bob.podId)

    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    const router = createPodHostRouter({ driver, registry: alice.registry })
    const hostRpc = attachService(nodeAlice, undefined, createMeshRpcService({
      onRequest: createPodHostMeshRpcHandler(router),
    }))
    const bobRpc = attachService(nodeBob, undefined, createMeshRpcService({}))
    const browserMeshFetch = createBrowserMeshFetch(bobRpc.api)

    const res = await browserMeshFetch(`mesh://${alice.podId}/nope`)
    assert.equal(res.status, 404)

    await hostRpc.teardown()
    await bobRpc.teardown()
  })

  it('works when built from an attached createPodHostService()\'s api (driver/resource/describe reused)', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodes = wireMesh([alice, bob])
    const nodeAlice = nodes.get(alice.podId)
    const nodeBob = nodes.get(bob.podId)

    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    const serviceHandle = attachService(nodeAlice, undefined, createPodHostService({ driver, hostLabel: 'alice-laptop' }))
    const router = createPodHostRouter({ api: serviceHandle.api, registry: alice.registry })
    const hostRpc = attachService(nodeAlice, undefined, createMeshRpcService({
      onRequest: createPodHostMeshRpcHandler(router),
    }))
    const bobRpc = attachService(nodeBob, undefined, createMeshRpcService({}))
    const browserMeshFetch = createBrowserMeshFetch(bobRpc.api)
    const client = podHostFetch(alice.podId, { fetch: browserMeshFetch })

    const description = await client.describe()
    assert.equal(description.hostLabel, 'alice-laptop')
    assert.equal(description.podId, alice.podId)

    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const spawned = await client.spawn(minimalSpec({ name: 'viaapi' }))
    assert.equal(spawned.state, POD_LIFECYCLE.REGISTERED)

    await serviceHandle.teardown()
    await hostRpc.teardown()
    await bobRpc.teardown()
  })
})
