/**
 * Unit-level tests for mesh-fetch.mjs (Phase 2 of the
 * BrowserMeshFetch/BrowserMeshWebSocket plan -- see that file's own module
 * doc comment for the full API-shape/error-vs-reject writeup).
 *
 * Matches this family's established pattern for this kind of test
 * (mesh-rpc.test.mjs is the direct precedent, itself modeled on
 * chunk-replication.test.mjs / manifest-sync.test.mjs): real `PeerRegistry`s
 * wired to real `MeshACL` (`@johnhenry/browsermesh-core`), real Ed25519
 * `IdentityWallet`/`MeshIdentityManager` identities, connected via a minimal
 * duck-typed in-memory bus (not real WebRTC -- that's a later phase's job),
 * with Phase 1's real `createMeshRpcService()` attached on both sides.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-fetch.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshRpcService } from '../src/mesh-rpc.mjs'
import { createBrowserMeshFetch } from '../src/mesh-fetch.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

// ---------------------------------------------------------------------------
// Test fixtures (mirrors mesh-rpc.test.mjs's own exactly)
// ---------------------------------------------------------------------------

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

/**
 * A minimal duck-typed `PeerNode` pair, matching mesh-rpc.test.mjs's own
 * `wireNodes()` exactly: `podId`/`wallet`/`registry` plus an async
 * `sendTo()`/`onIncomingData()` bus.
 */
function wireNodes(peerA, peerB) {
  const listenersA = new Set()
  const listenersB = new Set()

  const nodeA = {
    podId: peerA.podId,
    wallet: peerA.wallet,
    registry: peerA.registry,
    onIncomingData(cb) {
      listenersA.add(cb)
      return () => listenersA.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersB) cb(peerA.podId, data)
      })
    },
  }
  const nodeB = {
    podId: peerB.podId,
    wallet: peerB.wallet,
    registry: peerB.registry,
    onIncomingData(cb) {
      listenersB.add(cb)
      return () => listenersB.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersA) cb(peerB.podId, data)
      })
    },
  }
  return { nodeA, nodeB }
}

// ---------------------------------------------------------------------------
// createBrowserMeshFetch() construction
// ---------------------------------------------------------------------------

describe('createBrowserMeshFetch: construction', () => {
  it('throws if not given a mesh-rpc api with a request() method', () => {
    assert.throws(() => createBrowserMeshFetch(undefined), /mesh-rpc api/)
    assert.throws(() => createBrowserMeshFetch({}), /mesh-rpc api/)
    assert.throws(() => createBrowserMeshFetch({ request: 'nope' }), /mesh-rpc api/)
  })
})

// ---------------------------------------------------------------------------
// GET round trip
// ---------------------------------------------------------------------------

describe('browserMeshFetch: GET round trip', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodeA
  /** @type {any} */ let nodeB

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    ;({ nodeA, nodeB } = wireNodes(alice, bob))
  })

  it('a GET request round-trips to a real Response with correct status/headers/json() body', async () => {
    attachService(nodeB, undefined, createMeshRpcService({
      async onRequest({ method, path }) {
        assert.equal(method, 'GET')
        assert.equal(path, '/api/greet')
        return { status: 200, headers: { 'content-type': 'application/json', 'x-served-by': 'bob' }, body: { hello: 'alice' } }
      },
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))
    const browserMeshFetch = createBrowserMeshFetch(aliceApi)

    const res = await browserMeshFetch(`mesh://${bob.podId}/api/greet`)

    assert.ok(res instanceof Response)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('x-served-by'), 'bob')
    const data = await res.json()
    assert.deepEqual(data, { hello: 'alice' })
  })

  it('a GET request with a text/plain response is text()-decodable', async () => {
    attachService(nodeB, undefined, createMeshRpcService({
      async onRequest() {
        return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'hello world' }
      },
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))
    const browserMeshFetch = createBrowserMeshFetch(aliceApi)

    const res = await browserMeshFetch(`mesh://${bob.podId}/text`)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'hello world')
  })

  it('supports the https://podId.mesh.local/path address form too', async () => {
    attachService(nodeB, undefined, createMeshRpcService({
      async onRequest({ path }) {
        return { status: 200, body: { path } }
      },
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))
    const browserMeshFetch = createBrowserMeshFetch(aliceApi)

    const res = await browserMeshFetch(`https://${bob.podId}.mesh.local/via-local`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { path: '/via-local' })
  })
})

// ---------------------------------------------------------------------------
// Non-GET request with a body
// ---------------------------------------------------------------------------

describe('browserMeshFetch: non-GET request with a body', () => {
  it('a POST request delivers method/headers/body correctly to the handler', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    const seen = []
    attachService(nodeB, undefined, createMeshRpcService({
      async onRequest({ method, path, headers, body }) {
        seen.push({ method, path, headers, body })
        return { status: 201, body: { created: true } }
      },
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))
    const browserMeshFetch = createBrowserMeshFetch(aliceApi)

    const res = await browserMeshFetch(`mesh://${bob.podId}/items`, {
      method: 'POST',
      headers: { 'X-Test': '1', 'Content-Type': 'application/json' },
      body: { name: 'widget' },
    })

    assert.equal(seen.length, 1)
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].path, '/items')
    assert.equal(seen[0].headers['x-test'], '1')
    assert.deepEqual(seen[0].body, { name: 'widget' })
    assert.equal(res.status, 201)
    assert.deepEqual(await res.json(), { created: true })
  })

  it('a JSON-string body is parsed before delivery, matching MeshFetchRouter.route() convention', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    const seen = []
    attachService(nodeB, undefined, createMeshRpcService({
      async onRequest({ body }) {
        seen.push(body)
        return { status: 200 }
      },
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))
    const browserMeshFetch = createBrowserMeshFetch(aliceApi)

    await browserMeshFetch(`mesh://${bob.podId}/echo`, { method: 'PUT', body: JSON.stringify({ x: 1 }) })
    assert.deepEqual(seen[0], { x: 1 })
  })
})

// ---------------------------------------------------------------------------
// Non-2xx status -> resolved Response, not a rejection
// ---------------------------------------------------------------------------

describe('browserMeshFetch: non-2xx handler response', () => {
  it('a handler returning 404 produces a resolved Response with status 404, not a rejection', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshRpcService({
      async onRequest() {
        return { status: 404, body: { error: 'not found' } }
      },
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))
    const browserMeshFetch = createBrowserMeshFetch(aliceApi)

    const res = await browserMeshFetch(`mesh://${bob.podId}/missing`)
    assert.equal(res.status, 404)
    assert.deepEqual(await res.json(), { error: 'not found' })
  })

  it('a handler that throws produces a resolved 500 Response (mesh-rpc already shapes this), not a rejection', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshRpcService({
      onRequest() {
        throw new Error('boom')
      },
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))
    const browserMeshFetch = createBrowserMeshFetch(aliceApi)

    const res = await browserMeshFetch(`mesh://${bob.podId}/explode`)
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'boom' })
  })
})

// ---------------------------------------------------------------------------
// Unreachable / non-responding pod -> REJECTS, does not resolve
// ---------------------------------------------------------------------------

describe('browserMeshFetch: unreachable pod', () => {
  it('a request to an unreachable/non-responding pod rejects the promise rather than resolving with an error Response', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA } = wireNodes(alice, bob) // nodeB never gets a mesh-rpc service attached

    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({ requestTimeoutMs: 100 }))
    const browserMeshFetch = createBrowserMeshFetch(aliceApi)

    await assert.rejects(
      () => browserMeshFetch(`mesh://${bob.podId}/never-answered`),
      /timed out after 100ms/,
    )
  })
})

// ---------------------------------------------------------------------------
// Invalid URL -> throws clearly, matching real fetch()'s malformed-URL behavior
// ---------------------------------------------------------------------------

describe('browserMeshFetch: invalid URL', () => {
  it('throws a TypeError synchronously for a non-mesh:// URL, not returning a Promise at all', async () => {
    const alice = await createPeer('alice')
    const registry = alice.registry
    void registry
    const { api: aliceApi } = attachService(
      { podId: alice.podId, wallet: alice.wallet, registry: alice.registry, onIncomingData: () => () => {}, sendTo: async () => {} },
      undefined,
      createMeshRpcService({}),
    )
    const browserMeshFetch = createBrowserMeshFetch(aliceApi)

    let threw = null
    let returnedPromise
    try {
      returnedPromise = browserMeshFetch('https://example.com/not-a-mesh-url')
    } catch (err) {
      threw = err
    }

    assert.ok(threw instanceof TypeError, 'expected a synchronous TypeError')
    assert.equal(returnedPromise, undefined)

    // Also rejects cleanly when awaited from inside an async context, so a
    // caller doing `await browserMeshFetch(bad)` in a try/catch still works.
    async function callIt() {
      return browserMeshFetch('not-a-mesh-url-at-all')
    }
    await assert.rejects(() => callIt(), TypeError)
  })
})
