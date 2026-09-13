/**
 * Tests for mesh-kv.mjs (Phase 3 of the mesh-KV-and-observability plan --
 * see /packages/browsermesh-apps/src/mesh-kv.mjs's module doc comment for
 * the full design rationale).
 *
 * Matches this family's established pattern for this kind of test
 * (grant-log.test.mjs / manifest-sync.test.mjs / cloud-storage.test.mjs are
 * the cited precedents): real `PeerRegistry`s wired to real `MeshACL`
 * (`@johnhenry/browsermesh-core`), real Ed25519 `IdentityWallet`/
 * `MeshIdentityManager` identities (Phase D's GrantLog signature
 * verification is genuine, not mocked), connected via a minimal duck-typed
 * in-memory bus (not real WebRTC), matching grant-log.test.mjs's/
 * manifest-sync.test.mjs's own `wireNodes()` exactly.
 *
 * Unlike cloud-storage.test.mjs, no `fake-indexeddb` import is needed --
 * mesh-kv.mjs has no separate durable backend to mirror (see that file's
 * module doc comment: the `MeshSyncEngine`'s own in-memory `LWWMap` IS the
 * store's authoritative state).
 *
 * Two layers of tests, mirroring the file under test's own two-layer
 * structure:
 *   - `createMeshKvService` (low-level `MeshService` descriptor), tested
 *     directly -- mirrors manifest-sync.test.mjs's own structure exactly,
 *     since the ACL-gate logic under test here is a close adaptation of
 *     that file's.
 *   - `MeshKv` (the ergonomic wrapper class), tested via its public
 *     `get`/`set`/`delete`/`keys`/`becomeAdmin`/`grant`/`revoke` surface
 *     only -- mirrors cloud-storage.test.mjs's own "deliberately exercises
 *     ONLY the public surface" convention.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-kv.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshKvService, MeshKv } from '../src/mesh-kv.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

const STORE = 'test-store'
const RESOURCE = `kv:${STORE}`

// ---------------------------------------------------------------------------
// Test fixtures
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
 * A minimal duck-typed `PeerNode` pair, matching grant-log.test.mjs's/
 * manifest-sync.test.mjs's `wireNodes()` exactly: `podId`/`wallet`/
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
// createMeshKvService: authorized write propagation
// ---------------------------------------------------------------------------

describe('createMeshKvService: authorized write propagation', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodeA
  /** @type {any} */ let nodeB

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    ;({ nodeA, nodeB } = wireNodes(alice, bob))
  })

  it("an authorized peer's set() becomes visible on a second peer's own get() after merge", async () => {
    // Bob's own registry must already know Alice may write this store --
    // the ACL gate on the RECEIVING side (Bob) is what's under test.
    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])

    const aliceHandle = attachService(nodeA, undefined, createMeshKvService({ storeId: STORE }))
    const bobHandle = attachService(nodeB, undefined, createMeshKvService({ storeId: STORE }))

    aliceHandle.api.watch(bob.podId)
    aliceHandle.api.set('greeting', 'hello from alice')

    await waitFor(() => bobHandle.api.get('greeting') === 'hello from alice', 1000, "bob's kv sees alice's set after merge")
  })

  it('a delete (tombstone) also propagates to an authorized peer', async () => {
    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])

    const aliceHandle = attachService(nodeA, undefined, createMeshKvService({ storeId: STORE }))
    const bobHandle = attachService(nodeB, undefined, createMeshKvService({ storeId: STORE }))
    aliceHandle.api.watch(bob.podId)

    aliceHandle.api.set('k', 1)
    await waitFor(() => bobHandle.api.get('k') === 1, 1000, 'set reaches bob')

    aliceHandle.api.delete('k')
    await waitFor(() => bobHandle.api.get('k') === undefined, 1000, 'delete reaches bob')
    assert.deepEqual(bobHandle.api.keys(), [])
  })

  it('keys() reflects only live (non-tombstoned) keys, optionally filtered by prefix', async () => {
    const handle = attachService(nodeA, undefined, createMeshKvService({ storeId: STORE }))
    handle.api.set('a/1', 'x')
    handle.api.set('a/2', 'y')
    handle.api.set('b/1', 'z')
    handle.api.delete('a/1')

    assert.deepEqual(handle.api.keys().sort(), ['a/2', 'b/1'])
    assert.deepEqual(handle.api.keys('a/'), ['a/2'])
  })
})

// ---------------------------------------------------------------------------
// createMeshKvService: ctx.emit() observability events
// ---------------------------------------------------------------------------

describe('createMeshKvService: ctx.emit() observability events', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodeA
  /** @type {any} */ let nodeB

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    ;({ nodeA, nodeB } = wireNodes(alice, bob))
  })

  it('emits mesh-kv:entry-set on a local set() and on a successful authorized remote merge', async () => {
    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])

    const aliceHandle = attachService(nodeA, undefined, createMeshKvService({ storeId: STORE }))
    const bobHandle = attachService(nodeB, undefined, createMeshKvService({ storeId: STORE }))

    const aliceSets = []
    const bobSets = []
    aliceHandle.on('mesh-kv:entry-set', (data) => aliceSets.push(data))
    bobHandle.on('mesh-kv:entry-set', (data) => bobSets.push(data))

    aliceHandle.api.watch(bob.podId)
    aliceHandle.api.set('greeting', 'hi')

    assert.deepEqual(aliceSets, [{ storeId: STORE, from: alice.podId, key: 'greeting' }])
    await waitFor(() => bobSets.length > 0, 1000, "bob's mesh-kv emits entry-set after the authorized merge")
    assert.equal(bobSets[0].storeId, STORE)
    assert.equal(bobSets[0].from, alice.podId)
    assert.equal(bobSets[0].key, 'greeting')
  })

  it('emits mesh-kv:entry-deleted on a local delete() and on a successful authorized remote merge', async () => {
    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])

    const aliceHandle = attachService(nodeA, undefined, createMeshKvService({ storeId: STORE }))
    const bobHandle = attachService(nodeB, undefined, createMeshKvService({ storeId: STORE }))
    aliceHandle.api.watch(bob.podId)
    aliceHandle.api.set('k', 1)
    await waitFor(() => bobHandle.api.get('k') === 1, 1000, 'set reaches bob')

    const bobDeletes = []
    bobHandle.on('mesh-kv:entry-deleted', (data) => bobDeletes.push(data))

    aliceHandle.api.delete('k')
    await waitFor(() => bobDeletes.length > 0, 1000, "bob's mesh-kv emits entry-deleted after the authorized merge")
    assert.equal(bobDeletes[0].storeId, STORE)
    assert.equal(bobDeletes[0].from, alice.podId)
    assert.equal(bobDeletes[0].key, 'k')
  })

  it('emits mesh-kv:write-rejected (reason: unauthorized) when the receiving peer has not granted write access', async () => {
    // Deliberately NOT granting alice write access on bob's registry.
    const aliceHandle = attachService(nodeA, undefined, createMeshKvService({ storeId: STORE }))
    const bobHandle = attachService(nodeB, undefined, createMeshKvService({ storeId: STORE }))

    const rejected = []
    bobHandle.on('mesh-kv:write-rejected', (data) => rejected.push(data))

    aliceHandle.api.watch(bob.podId)
    aliceHandle.api.set('k', 1)

    await waitFor(() => rejected.length > 0, 1000, "bob's mesh-kv emits write-rejected for alice's unauthorized write")
    assert.equal(rejected[0].storeId, STORE)
    assert.equal(rejected[0].from, alice.podId)
    assert.equal(rejected[0].key, 'k')
    assert.equal(rejected[0].reason, 'unauthorized')
  })

  it('emits mesh-kv:watching/unwatching on watch()/unwatch()', async () => {
    const aliceHandle = attachService(nodeA, undefined, createMeshKvService({ storeId: STORE }))

    const watching = []
    const unwatching = []
    aliceHandle.on('mesh-kv:watching', (data) => watching.push(data))
    aliceHandle.on('mesh-kv:unwatching', (data) => unwatching.push(data))

    aliceHandle.api.watch(bob.podId)
    assert.deepEqual(watching, [{ storeId: STORE, pubKey: bob.podId }])

    aliceHandle.api.unwatch(bob.podId)
    assert.deepEqual(unwatching, [{ storeId: STORE, pubKey: bob.podId }])
  })
})

// ---------------------------------------------------------------------------
// THE critical test: an unauthorized peer's write must never reach the
// local merged state.
// ---------------------------------------------------------------------------

describe('createMeshKvService: unauthorized writes are rejected before merge', () => {
  it("a peer WITHOUT write access has its store changes discarded, never merged into the receiving peer's state", async () => {
    const alice = await createPeer('alice') // never granted write access to bob's registry
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    assert.equal(bob.registry.checkAccess(alice.podId, RESOURCE, 'write').allowed, false)

    const aliceHandle = attachService(nodeA, undefined, createMeshKvService({ storeId: STORE }))
    const bobHandle = attachService(nodeB, undefined, createMeshKvService({ storeId: STORE }))
    aliceHandle.api.watch(bob.podId)

    aliceHandle.api.set('secret', 'should never arrive')
    // Give the (rejected) broadcast every chance to have arrived and been
    // processed before asserting it never took effect.
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(bobHandle.api.get('secret'), undefined, "bob's merged store must never contain alice's unauthorized write")
    assert.deepEqual(bobHandle.api.keys(), [])
    // Alice's own local write always succeeds -- ACL is enforced on the
    // RECEIVING peer, not the writer.
    assert.equal(aliceHandle.api.get('secret'), 'should never arrive')
  })

  it('an authorized peer cannot smuggle in a write falsely attributed to someone else', async () => {
    const alice = await createPeer('alice')
    const carol = await createPeer('carol')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    bob.registry.grantCapabilities(alice.podId, [`${RESOURCE}:write`])
    bob.registry.grantCapabilities(carol.podId, [`${RESOURCE}:write`])

    const bobHandle = attachService(nodeB, undefined, createMeshKvService({ storeId: STORE }))

    // Hand-craft an envelope as Alice's session would send it, but with the
    // entry's nodeId claiming Carol as the writer.
    await nodeA.sendTo(bob.podId, {
      type: 'mesh-kv',
      docId: `kv:${STORE}`,
      payload: {
        id: `kv:${STORE}`,
        type: 'lww-map',
        crdt: { entries: { forged: { value: 'evil', timestamp: Date.now(), nodeId: carol.podId, tombstone: false } } },
        version: {},
      },
    })

    await new Promise((r) => setTimeout(r, 50))
    assert.equal(bobHandle.api.get('forged'), undefined, 'attribution mismatch (nodeId !== sender) must be rejected regardless of either identity\'s ACL status')
  })
})

// ---------------------------------------------------------------------------
// MeshKv: the ergonomic wrapper class, exercised only through its public
// surface (get/set/delete/keys/becomeAdmin/grant/revoke) -- mirrors
// cloud-storage.test.mjs's own convention.
// ---------------------------------------------------------------------------

describe('MeshKv: end-to-end via the public wrapper surface', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodeA
  /** @type {any} */ let nodeB
  /** @type {MeshKv} */ let kvA
  /** @type {MeshKv} */ let kvB

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    ;({ nodeA, nodeB } = wireNodes(alice, bob))
    kvA = new MeshKv({ store: STORE, node: nodeA })
    kvB = new MeshKv({ store: STORE, node: nodeB })
  })

  it("granting a second peer access makes the admin's set() visible via that peer's own get()", async () => {
    await kvA.becomeAdmin()
    await kvA.grant(bob.podId, ['read', 'write'])

    await kvA.set('greeting', 'hello from alice')

    await waitFor(async () => (await kvB.get('greeting')) === 'hello from alice', 2000, "bob's MeshKv sees alice's set after grant")
  })

  it('delete propagates to a granted peer', async () => {
    await kvA.becomeAdmin()
    await kvA.grant(bob.podId, ['read', 'write'])
    await kvA.set('k', 1)
    await waitFor(async () => (await kvB.get('k')) === 1, 2000, 'set reaches bob')

    await kvA.delete('k')
    await waitFor(async () => (await kvB.get('k')) === undefined, 2000, 'delete reaches bob')
    assert.deepEqual(await kvB.keys(), [])
  })

  it("an ungranted peer's write is rejected and never reaches the admin's own state", async () => {
    await kvA.becomeAdmin()
    // Deliberately never granting Bob access on Alice's side, and Bob is
    // never told about Alice's admin grant either -- Bob's own registry
    // has no reason to trust Alice's writes, but this test checks the
    // OTHER direction: Bob writing to his own local MeshKv instance (which
    // trivially succeeds, matching CloudStorage's own documented "local
    // write can never fail" limitation) can never poison Alice's state,
    // because Alice never watches Bob and Alice's own merge gate would
    // reject Bob's writes even if it somehow arrived.
    await kvB.set('secret', 'should never arrive at alice')

    await new Promise((r) => setTimeout(r, 50))
    assert.equal(await kvA.get('secret'), undefined, "alice's state must never contain bob's unwatched/unauthorized write")
  })

  it('emits mesh-kv:entry-set on set() and on a granted peer receiving the merge', async () => {
    await kvA.becomeAdmin()

    const aSets = []
    const bSets = []
    // MeshKv forwards createMeshKvService()'s own `mesh-kv:*` vocabulary
    // unchanged onto its own on()/onEvent() -- see module doc comment.
    kvA.on('mesh-kv:entry-set', (data) => aSets.push(data))
    kvB.on('mesh-kv:entry-set', (data) => bSets.push(data))

    await kvA.grant(bob.podId, ['read', 'write'])
    await kvA.set('x', 1)

    assert.ok(aSets.some((e) => e.key === 'x' && e.from === alice.podId), "alice's own MeshKv emits entry-set for her local set()")
    await waitFor(() => bSets.some((e) => e.key === 'x' && e.from === alice.podId), 2000, "bob's MeshKv emits entry-set after the authorized merge")
  })

  it('emits mesh-kv:write-rejected when an ungranted peer sends a write bob has no reason to trust', async () => {
    await kvA.becomeAdmin()
    // Deliberately never calling kvA.grant(bob.podId, ...) -- bob's own
    // registry never learns alice holds write access on this resource, so
    // a write attributed to alice arriving at bob must be rejected.
    const rejected = []
    kvB.on('mesh-kv:write-rejected', (data) => rejected.push(data))

    await nodeA.sendTo(bob.podId, {
      type: 'mesh-kv',
      docId: `kv:${STORE}`,
      payload: {
        id: `kv:${STORE}`,
        type: 'lww-map',
        crdt: { entries: { y: { value: 2, timestamp: Date.now(), nodeId: alice.podId, tombstone: false } } },
        version: {},
      },
    })

    await waitFor(() => rejected.length > 0, 1000, "bob's MeshKv emits write-rejected for alice's unauthorized write")
    assert.equal(rejected[0].reason, 'unauthorized')
    assert.equal(await kvB.get('y'), undefined)
  })
})
