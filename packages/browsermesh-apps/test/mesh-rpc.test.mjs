/**
 * Unit-level tests for mesh-rpc.mjs (Phase 1 of the BrowserMeshFetch/
 * BrowserMeshWebSocket plan -- see that file's own module doc comment for
 * the full wire-protocol/authorization writeup).
 *
 * Matches this family's established pattern for this kind of test
 * (chunk-replication.test.mjs / manifest-sync.test.mjs are the direct
 * precedents): real `PeerRegistry`s wired to real `MeshACL`
 * (`@johnhenry/browsermesh-core`), real Ed25519 `IdentityWallet`/
 * `MeshIdentityManager` identities, connected via a minimal duck-typed
 * in-memory bus (not real WebRTC -- that's a later phase's job).
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-rpc.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshRpcService } from '../src/mesh-rpc.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

// ---------------------------------------------------------------------------
// Test fixtures (mirrors chunk-replication.test.mjs's / manifest-sync.test.mjs's own)
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
 * A minimal duck-typed `PeerNode` pair, matching chunk-replication.test.mjs's/
 * manifest-sync.test.mjs's own `wireNodes()` exactly: `podId`/`wallet`/
 * `registry` plus an async `sendTo()`/`onIncomingData()` bus.
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

/**
 * A minimal duck-typed multi-peer bus: every peer in `peers` gets a node
 * that can `sendTo()` any other peer's podId and dispatches to that peer's
 * own `onIncomingData()` listeners. Used where more than two parties need
 * to be wired together (pairwise `wireNodes()` only shares one bus between
 * exactly two peers).
 * @param {Array<{podId: string, wallet?: object, registry: object}>} peers
 * @returns {Record<string, any>} keyed by each peer's `podId`
 */
function wireMesh(peers) {
  const listenersByPodId = new Map(peers.map((p) => [p.podId, new Set()]))
  const nodesByPodId = {}
  for (const peer of peers) {
    nodesByPodId[peer.podId] = {
      podId: peer.podId,
      wallet: peer.wallet,
      registry: peer.registry,
      onIncomingData(cb) {
        const set = listenersByPodId.get(peer.podId)
        set.add(cb)
        return () => set.delete(cb)
      },
      async sendTo(pubKey, data) {
        const set = listenersByPodId.get(pubKey)
        if (!set) return
        queueMicrotask(() => {
          for (const cb of set) cb(peer.podId, data)
        })
      },
    }
  }
  return nodesByPodId
}

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs = 1000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

// ---------------------------------------------------------------------------
// Basic request/response round trip
// ---------------------------------------------------------------------------

describe('mesh-rpc: basic request/response round trip', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodeA
  /** @type {any} */ let nodeB

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    ;({ nodeA, nodeB } = wireNodes(alice, bob))
  })

  it("a request from A reaches B's onRequest handler with the correct fields, and B's response comes back correctly shaped", async () => {
    const seen = []
    const { api: bobApi } = attachService(nodeB, undefined, createMeshRpcService({
      async onRequest({ fromPubKey, method, path, headers, body }) {
        seen.push({ fromPubKey, method, path, headers, body })
        return { status: 200, headers: { 'content-type': 'application/json' }, body: { echoed: body, from: 'bob' } }
      },
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))
    void bobApi

    const res = await aliceApi.request(bob.podId, { method: 'POST', path: '/greet', headers: { 'x-test': '1' }, body: { name: 'alice' } })

    assert.equal(seen.length, 1)
    assert.equal(seen[0].fromPubKey, alice.podId)
    assert.equal(seen[0].method, 'POST')
    assert.equal(seen[0].path, '/greet')
    assert.deepEqual(seen[0].headers, { 'x-test': '1' })
    assert.deepEqual(seen[0].body, { name: 'alice' })

    assert.equal(res.status, 200)
    assert.deepEqual(res.headers, { 'content-type': 'application/json' })
    assert.deepEqual(res.body, { echoed: { name: 'alice' }, from: 'bob' })
  })

  it('defaults method/path/headers/body sensibly when omitted', async () => {
    const seen = []
    attachService(nodeB, undefined, createMeshRpcService({
      async onRequest(req) {
        seen.push(req)
        return { status: 204 }
      },
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))

    const res = await aliceApi.request(bob.podId)
    assert.equal(seen[0].method, 'GET')
    assert.equal(seen[0].path, '/')
    assert.deepEqual(seen[0].headers, {})
    assert.equal(res.status, 204)
    assert.deepEqual(res.headers, {})
  })
})

// ---------------------------------------------------------------------------
// Concurrency: multiple in-flight requests must not cross-correlate
// ---------------------------------------------------------------------------

describe('mesh-rpc: concurrent requests do not cross-correlate', () => {
  it('multiple concurrent requests from the same caller to the same peer each get their own matching response', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshRpcService({
      async onRequest({ path, body }) {
        // Deliberately vary response latency so responses can arrive
        // out of order relative to request order.
        const delay = path === '/slow' ? 40 : 5
        await new Promise((r) => setTimeout(r, delay))
        return { status: 200, body: { path, body } }
      },
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))

    const [slow, fastA, fastB] = await Promise.all([
      aliceApi.request(bob.podId, { path: '/slow', body: 1 }),
      aliceApi.request(bob.podId, { path: '/fast', body: 2 }),
      aliceApi.request(bob.podId, { path: '/fast', body: 3 }),
    ])

    assert.deepEqual(slow.body, { path: '/slow', body: 1 })
    assert.deepEqual(fastA.body, { path: '/fast', body: 2 })
    assert.deepEqual(fastB.body, { path: '/fast', body: 3 })
  })

  it('concurrent requests from multiple different calling peers to the same responder are correlated independently', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const carol = await createPeer('carol')
    const mesh = wireMesh([alice, bob, carol])
    const { [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC } = mesh

    attachService(nodeB, undefined, createMeshRpcService({
      async onRequest({ fromPubKey, body }) {
        return { status: 200, body: { from: fromPubKey, echo: body } }
      },
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))
    const { api: carolApi } = attachService(nodeC, undefined, createMeshRpcService({}))

    const [aliceRes, carolRes] = await Promise.all([
      aliceApi.request(bob.podId, { body: 'from-alice' }),
      carolApi.request(bob.podId, { body: 'from-carol' }),
    ])

    assert.equal(aliceRes.body.from, alice.podId)
    assert.equal(aliceRes.body.echo, 'from-alice')
    assert.equal(carolRes.body.from, carol.podId)
    assert.equal(carolRes.body.echo, 'from-carol')
  })
})

// ---------------------------------------------------------------------------
// No handler registered -> 501, not a hang
// ---------------------------------------------------------------------------

describe('mesh-rpc: no onRequest handler registered', () => {
  it('a request to a pod with mesh-rpc attached but no onRequest gets a 501 response, not a hang', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshRpcService({})) // no onRequest supplied
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))

    const start = Date.now()
    const res = await aliceApi.request(bob.podId, { method: 'GET', path: '/anything' })
    const elapsed = Date.now() - start

    assert.equal(res.status, 501)
    assert.deepEqual(res.body, { error: 'no RPC handler registered' })
    assert.ok(elapsed < 500, `expected a prompt 501, not a wait (took ${elapsed}ms)`)
  })
})

// ---------------------------------------------------------------------------
// Timeout: a pod that never responds at all
// ---------------------------------------------------------------------------

describe('mesh-rpc: timeout when the target never responds', () => {
  it('times out cleanly within requestTimeoutMs and rejects with a clear error when no service is attached on the other side at all', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA } = wireNodes(alice, bob) // nodeB is never given a mesh-rpc service

    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({ requestTimeoutMs: 100 }))

    const start = Date.now()
    await assert.rejects(
      () => aliceApi.request(bob.podId, { path: '/never-answered' }),
      /timed out after 100ms/,
    )
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 90 && elapsed < 1000, `expected a timeout around 100ms, took ${elapsed}ms`)
  })

  it('times out cleanly when onRequest is attached but never resolves', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshRpcService({
      onRequest: () => new Promise(() => {}), // never resolves
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({ requestTimeoutMs: 100 }))

    const start = Date.now()
    await assert.rejects(
      () => aliceApi.request(bob.podId, { path: '/hangs' }),
      /timed out after 100ms/,
    )
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 90 && elapsed < 1000, `expected a timeout around 100ms, took ${elapsed}ms`)
  })
})

// ---------------------------------------------------------------------------
// onRequest throwing -> clean error response, not a crash
// ---------------------------------------------------------------------------

describe('mesh-rpc: onRequest throwing', () => {
  it('a synchronous throw inside onRequest produces a clean 500 error response back to the caller', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshRpcService({
      onRequest() {
        throw new Error('boom')
      },
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))

    const res = await aliceApi.request(bob.podId, { path: '/explode' })
    assert.equal(res.status, 500)
    assert.deepEqual(res.body, { error: 'boom' })
  })

  it('an async rejection inside onRequest also produces a clean 500 error response', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshRpcService({
      async onRequest() {
        await new Promise((r) => setTimeout(r, 5))
        throw new Error('async boom')
      },
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))

    const res = await aliceApi.request(bob.podId, { path: '/explode-async' })
    assert.equal(res.status, 500)
    assert.deepEqual(res.body, { error: 'async boom' })
  })

  it('the dispatch loop keeps working for subsequent requests after a handler throw', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    let calls = 0
    attachService(nodeB, undefined, createMeshRpcService({
      onRequest() {
        calls += 1
        if (calls === 1) throw new Error('first call blows up')
        return { status: 200, body: { ok: true } }
      },
    }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRpcService({}))

    const first = await aliceApi.request(bob.podId, { path: '/one' })
    assert.equal(first.status, 500)

    const second = await aliceApi.request(bob.podId, { path: '/two' })
    assert.equal(second.status, 200)
    assert.deepEqual(second.body, { ok: true })
  })
})

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

describe('mesh-rpc: teardown', () => {
  it('unsubscribes from incoming data and rejects any still-in-flight requests', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshRpcService({
      onRequest: () => new Promise(() => {}), // never resolves
    }))
    const { api: aliceApi, teardown } = attachService(nodeA, undefined, createMeshRpcService({ requestTimeoutMs: 5000 }))

    const pending = aliceApi.request(bob.podId, { path: '/torn-down-mid-flight' })
    await new Promise((r) => setTimeout(r, 10))
    await teardown()

    await assert.rejects(() => pending, /torn down/)
  })
})
