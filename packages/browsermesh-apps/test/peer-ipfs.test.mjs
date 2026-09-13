// Run with: node --import ./test/_setup-globals.mjs --test test/peer-ipfs.test.mjs
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { IPFSStore, IPFS_DEFAULTS, createIpfsService } from '../src/peer-ipfs.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { createMeshNode } from '../src/mesh-bootstrap.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('IPFS_DEFAULTS', () => {
  it('has expected defaults', () => {
    assert.equal(IPFS_DEFAULTS.enabled, false)
    assert.equal(IPFS_DEFAULTS.maxStorageMb, 100)
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(IPFS_DEFAULTS))
  })
})

// ---------------------------------------------------------------------------
// IPFSStore — construction
// ---------------------------------------------------------------------------

describe('IPFSStore construction', () => {
  it('constructs with defaults', () => {
    const store = new IPFSStore()
    assert.equal(store.enabled, false)
    assert.equal(store.loaded, false)
    assert.equal(store.available, false)
  })

  it('respects enabled option', () => {
    const store = new IPFSStore({ enabled: true })
    assert.equal(store.enabled, true)
  })

  it('respects maxStorageMb option', () => {
    const store = new IPFSStore({ maxStorageMb: 50 })
    // maxStorageMb is internal, verify via stats behavior in later tests
    assert.equal(store.enabled, false)
  })

  it('disabled by default', () => {
    const store = new IPFSStore()
    assert.equal(store.enabled, false)
  })
})

// ---------------------------------------------------------------------------
// IPFSStore — ensureLoaded
// ---------------------------------------------------------------------------

describe('IPFSStore ensureLoaded', () => {
  it('marks as loaded after ensureLoaded', async () => {
    const store = new IPFSStore()
    await store.ensureLoaded()
    assert.equal(store.loaded, true)
  })

  it('available is false without Helia', async () => {
    const store = new IPFSStore()
    await store.ensureLoaded()
    assert.equal(store.available, false)
  })

  it('ensureLoaded is idempotent', async () => {
    const store = new IPFSStore()
    await store.ensureLoaded()
    await store.ensureLoaded()
    assert.equal(store.loaded, true)
  })

  it('skips Helia loading when disabled', async () => {
    const store = new IPFSStore({ enabled: false })
    await store.ensureLoaded()
    assert.equal(store.loaded, true)
    assert.equal(store.available, false)
  })
})

// ---------------------------------------------------------------------------
// IPFSStore — add
// ---------------------------------------------------------------------------

describe('IPFSStore add', () => {
  let store

  beforeEach(async () => {
    store = new IPFSStore()
    await store.ensureLoaded()
  })

  it('adds Uint8Array and returns CID', async () => {
    const { cid, size } = await store.add(new Uint8Array([1, 2, 3]))
    assert.equal(typeof cid, 'string')
    assert.equal(cid.length, 64) // SHA-256 hex
    assert.equal(size, 3)
  })

  it('adds string data (auto-encoded)', async () => {
    const { cid, size } = await store.add('hello world')
    assert.equal(typeof cid, 'string')
    assert.equal(size, 11)
  })

  it('same data produces same CID', async () => {
    const data = new Uint8Array([10, 20, 30])
    const r1 = await store.add(data)
    const r2 = await store.add(data)
    assert.equal(r1.cid, r2.cid)
  })

  it('different data produces different CIDs', async () => {
    const r1 = await store.add(new Uint8Array([1]))
    const r2 = await store.add(new Uint8Array([2]))
    assert.notEqual(r1.cid, r2.cid)
  })

  it('auto-loads if not loaded', async () => {
    const fresh = new IPFSStore()
    assert.equal(fresh.loaded, false)
    await fresh.add(new Uint8Array([1]))
    assert.equal(fresh.loaded, true)
  })

  it('emits add event', async () => {
    const events = []
    store.on('add', (d) => events.push(d))
    await store.add(new Uint8Array([7, 8, 9]))
    assert.equal(events.length, 1)
    assert.equal(events[0].size, 3)
    assert.equal(typeof events[0].cid, 'string')
  })

  it('rejects when storage limit exceeded', async () => {
    const small = new IPFSStore({ maxStorageMb: 0.0001 }) // ~100 bytes
    await small.ensureLoaded()
    // Add 200 bytes should exceed limit
    await assert.rejects(
      () => small.add(new Uint8Array(200)),
      /Storage limit exceeded/,
    )
  })
})

// ---------------------------------------------------------------------------
// IPFSStore — get
// ---------------------------------------------------------------------------

describe('IPFSStore get', () => {
  let store

  beforeEach(async () => {
    store = new IPFSStore()
    await store.ensureLoaded()
  })

  it('retrieves stored data by CID', async () => {
    const data = new Uint8Array([42, 43, 44])
    const { cid } = await store.add(data)
    const result = await store.get(cid)
    assert.deepEqual(result, data)
  })

  it('returns null for unknown CID', async () => {
    const result = await store.get('0000000000000000000000000000000000000000000000000000000000000000')
    assert.equal(result, null)
  })

  it('auto-loads if not loaded', async () => {
    const fresh = new IPFSStore()
    const result = await fresh.get('abc')
    assert.equal(result, null)
    assert.equal(fresh.loaded, true)
  })
})

// ---------------------------------------------------------------------------
// IPFSStore — pin / unpin
// ---------------------------------------------------------------------------

describe('IPFSStore pin/unpin', () => {
  let store

  beforeEach(async () => {
    store = new IPFSStore()
    await store.ensureLoaded()
  })

  it('pins existing content', async () => {
    const { cid } = await store.add(new Uint8Array([1, 2, 3]))
    const pinned = await store.pin(cid)
    assert.ok(pinned)
  })

  it('pin returns false for unknown CID', async () => {
    const pinned = await store.pin('nonexistent')
    assert.equal(pinned, false)
  })

  it('unpins pinned content', async () => {
    const { cid } = await store.add(new Uint8Array([1, 2, 3]))
    await store.pin(cid)
    const unpinned = await store.unpin(cid)
    assert.ok(unpinned)
  })

  it('unpin returns false for unknown CID', async () => {
    const unpinned = await store.unpin('nonexistent')
    assert.equal(unpinned, false)
  })

  it('pin state is reflected in listCids', async () => {
    const { cid } = await store.add(new Uint8Array([1]))
    assert.equal(store.listCids()[0].pinned, false)

    await store.pin(cid)
    assert.equal(store.listCids()[0].pinned, true)

    await store.unpin(cid)
    assert.equal(store.listCids()[0].pinned, false)
  })

  it('emits pin/unpin events', async () => {
    const events = []
    store.on('pin', (d) => events.push({ type: 'pin', ...d }))
    store.on('unpin', (d) => events.push({ type: 'unpin', ...d }))

    const { cid } = await store.add(new Uint8Array([1]))
    await store.pin(cid)
    await store.unpin(cid)

    assert.equal(events.length, 2)
    assert.equal(events[0].type, 'pin')
    assert.equal(events[1].type, 'unpin')
  })
})

// ---------------------------------------------------------------------------
// IPFSStore — listCids
// ---------------------------------------------------------------------------

describe('IPFSStore listCids', () => {
  let store

  beforeEach(async () => {
    store = new IPFSStore()
    await store.ensureLoaded()
  })

  it('returns empty array when no content', () => {
    assert.deepEqual(store.listCids(), [])
  })

  it('returns entries with correct shape', async () => {
    await store.add(new Uint8Array([1, 2, 3]))
    const list = store.listCids()
    assert.equal(list.length, 1)
    assert.equal(typeof list[0].cid, 'string')
    assert.equal(list[0].size, 3)
    assert.equal(list[0].pinned, false)
    assert.equal(typeof list[0].addedAt, 'number')
  })

  it('lists multiple entries', async () => {
    await store.add(new Uint8Array([1]))
    await store.add(new Uint8Array([2]))
    await store.add(new Uint8Array([3]))
    const list = store.listCids()
    assert.equal(list.length, 3)
  })

  it('deduplicates same content', async () => {
    const data = new Uint8Array([10, 20])
    await store.add(data)
    await store.add(data)
    const list = store.listCids()
    assert.equal(list.length, 1)
  })
})

// ---------------------------------------------------------------------------
// IPFSStore — remove
// ---------------------------------------------------------------------------

describe('IPFSStore remove', () => {
  let store

  beforeEach(async () => {
    store = new IPFSStore()
    await store.ensureLoaded()
  })

  it('removes existing content', async () => {
    const { cid } = await store.add(new Uint8Array([1, 2, 3]))
    const removed = await store.remove(cid)
    assert.ok(removed)
    assert.equal(store.listCids().length, 0)
  })

  it('returns false for unknown CID', async () => {
    const removed = await store.remove('nonexistent')
    assert.equal(removed, false)
  })

  it('removed content cannot be retrieved', async () => {
    const { cid } = await store.add(new Uint8Array([1, 2]))
    await store.remove(cid)
    const result = await store.get(cid)
    assert.equal(result, null)
  })

  it('emits remove event', async () => {
    const events = []
    store.on('remove', (d) => events.push(d))

    const { cid } = await store.add(new Uint8Array([1]))
    await store.remove(cid)

    assert.equal(events.length, 1)
    assert.equal(events[0].cid, cid)
  })
})

// ---------------------------------------------------------------------------
// IPFSStore — getStats
// ---------------------------------------------------------------------------

describe('IPFSStore getStats', () => {
  let store

  beforeEach(async () => {
    store = new IPFSStore()
    await store.ensureLoaded()
  })

  it('returns zeros when empty', () => {
    const stats = store.getStats()
    assert.equal(stats.totalCids, 0)
    assert.equal(stats.totalSizeMb, 0)
    assert.equal(stats.pinnedCount, 0)
  })

  it('reports correct totalCids', async () => {
    await store.add(new Uint8Array([1]))
    await store.add(new Uint8Array([2]))
    const stats = store.getStats()
    assert.equal(stats.totalCids, 2)
  })

  it('reports correct totalSizeMb', async () => {
    await store.add(new Uint8Array(1024)) // 1KB
    const stats = store.getStats()
    assert.ok(Math.abs(stats.totalSizeMb - (1024 / (1024 * 1024))) < 0.001)
  })

  it('reports correct pinnedCount', async () => {
    const { cid: cid1 } = await store.add(new Uint8Array([1]))
    await store.add(new Uint8Array([2]))
    await store.pin(cid1)

    const stats = store.getStats()
    assert.equal(stats.pinnedCount, 1)
  })

  it('updates after removals', async () => {
    const { cid } = await store.add(new Uint8Array([1, 2, 3]))
    assert.equal(store.getStats().totalCids, 1)
    await store.remove(cid)
    assert.equal(store.getStats().totalCids, 0)
  })
})

// ---------------------------------------------------------------------------
// IPFSStore — close
// ---------------------------------------------------------------------------

describe('IPFSStore close', () => {
  it('clears all state', async () => {
    const store = new IPFSStore()
    await store.ensureLoaded()
    await store.add(new Uint8Array([1, 2, 3]))
    assert.equal(store.listCids().length, 1)

    await store.close()
    assert.equal(store.loaded, false)
    assert.equal(store.available, false)
    assert.equal(store.listCids().length, 0)
  })

  it('can be reloaded after close', async () => {
    const store = new IPFSStore()
    await store.ensureLoaded()
    await store.close()
    assert.equal(store.loaded, false)

    await store.ensureLoaded()
    assert.equal(store.loaded, true)
  })
})

// ---------------------------------------------------------------------------
// IPFSStore — events
// ---------------------------------------------------------------------------

describe('IPFSStore events', () => {
  it('on/off registers and removes listeners', async () => {
    const store = new IPFSStore()
    await store.ensureLoaded()

    const events = []
    const handler = (d) => events.push(d)

    store.on('add', handler)
    await store.add(new Uint8Array([1]))
    assert.equal(events.length, 1)

    store.off('add', handler)
    await store.add(new Uint8Array([2]))
    assert.equal(events.length, 1) // no new event
  })

  it('listener errors do not propagate', async () => {
    const logs = []
    const store = new IPFSStore({ onLog: (level, msg) => logs.push({ level, msg }) })
    await store.ensureLoaded()

    store.on('add', () => { throw new Error('kaboom') })
    await store.add(new Uint8Array([1])) // should not throw
    assert.ok(logs.some(l => l.msg.includes('kaboom')))
  })
})

// ---------------------------------------------------------------------------
// IPFSStore — toJSON
// ---------------------------------------------------------------------------

describe('IPFSStore toJSON', () => {
  it('serializes current state', async () => {
    const store = new IPFSStore({ enabled: false, maxStorageMb: 50 })
    await store.ensureLoaded()
    const { cid } = await store.add(new Uint8Array([1, 2, 3]))
    await store.pin(cid)

    const json = store.toJSON()
    assert.equal(json.enabled, false)
    assert.equal(json.loaded, true)
    assert.equal(json.available, false)
    assert.equal(json.maxStorageMb, 50)
    assert.equal(json.stats.totalCids, 1)
    assert.equal(json.stats.pinnedCount, 1)
    assert.equal(json.cids.length, 1)
    assert.equal(json.cids[0].cid, cid)
    assert.equal(json.cids[0].pinned, true)
  })

  it('serializes empty store', () => {
    const store = new IPFSStore()
    const json = store.toJSON()
    assert.equal(json.enabled, false)
    assert.equal(json.loaded, false)
    assert.deepEqual(json.cids, [])
  })
})

// =============================================================================
// createIpfsService -- wired as a MeshService (attachService(), Phase 6, #123)
// =============================================================================
//
// Fixtures mirror peer-routing.test.mjs's own: real Ed25519 IdentityWallet/
// MeshIdentityManager identities + real PeerRegistry (wired to real
// MeshACL/MeshPeerManager/TrustGraph from @johnhenry/browsermesh-core).
// Unlike peer-routing.test.mjs, no in-memory sendTo()/onIncomingData() bus is
// needed -- createIpfsService() never calls either (see peer-ipfs.mjs's own
// "NO WIRE PROTOCOL" note), so these "peers" never exchange a single
// message. That absence is itself part of what's under test: it's the
// concrete, structural proof that content stored via one peer's service is
// never visible to another's.

/** A real Ed25519 identity + wallet + registry bundle for one "peer". */
async function createIpfsTestPeer(label) {
  const identityManager = new MeshIdentityManager({})
  const wallet = new IdentityWallet({ identityManager })
  const { podId } = await wallet.createIdentity(label)
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId }),
  })
  // Minimal duck-typed PeerNode: createIpfsService() only ever reads
  // ctx.registry/ctx.peerNode (via mesh-service.mjs's createServiceContext())
  // -- it never calls onIncomingData()/sendTo() -- so those two fields are
  // all a "real PeerNode" stand-in needs to provide here.
  return { podId, wallet, registry }
}

describe('createIpfsService: real add -> get round-trip through the service', () => {
  it('stores and retrieves data via api.add()/api.get()', async () => {
    const alice = await createIpfsTestPeer('alice')
    const { api } = attachService(alice, undefined, createIpfsService({}))

    const data = new Uint8Array([1, 2, 3, 4, 5])
    const { cid, size } = await api.add(data)
    assert.equal(typeof cid, 'string')
    assert.equal(size, 5)

    const retrieved = await api.get(cid)
    assert.deepEqual(retrieved, data)
  })

  it('unknown CID returns null', async () => {
    const alice = await createIpfsTestPeer('alice')
    const { api } = attachService(alice, undefined, createIpfsService({}))
    const result = await api.get('0'.repeat(64))
    assert.equal(result, null)
  })
})

describe('createIpfsService: content-addressing (same content -> same CID, tampering detected)', () => {
  it('identical content added twice produces the same CID', async () => {
    const alice = await createIpfsTestPeer('alice')
    const { api } = attachService(alice, undefined, createIpfsService({}))

    const data = new Uint8Array([9, 9, 9])
    const r1 = await api.add(data)
    const r2 = await api.add(data)
    assert.equal(r1.cid, r2.cid)
    assert.equal(api.listCids().length, 1, 'dedup: still one stored entry')
  })

  it('different (tampered) content produces a different CID, so fetching by the ORIGINAL CID never returns tampered bytes', async () => {
    const alice = await createIpfsTestPeer('alice')
    const { api } = attachService(alice, undefined, createIpfsService({}))

    const original = new Uint8Array([1, 2, 3])
    const tampered = new Uint8Array([1, 2, 99]) // one byte flipped

    const { cid: originalCid } = await api.add(original)
    const { cid: tamperedCid } = await api.add(tampered)

    assert.notEqual(originalCid, tamperedCid, 'tampering changes the CID')

    // Fetching by the ORIGINAL CID always returns the original bytes --
    // there is no way to make tampered content resolve under the original
    // CID, which is the actual integrity guarantee content-addressing gives.
    assert.deepEqual(await api.get(originalCid), original)
    assert.deepEqual(await api.get(tamperedCid), tampered)
  })
})

describe('createIpfsService: pin/unpin/remove lifecycle', () => {
  it('pin prevents removal; unpin allows it again', async () => {
    const alice = await createIpfsTestPeer('alice')
    const { api } = attachService(alice, undefined, createIpfsService({}))

    const { cid } = await api.add(new Uint8Array([1, 2, 3]))

    assert.equal(await api.pin(cid), true)
    assert.equal(await api.remove(cid), false, 'pinned content cannot be removed')
    assert.deepEqual(await api.get(cid), new Uint8Array([1, 2, 3]), 'still retrievable after failed remove')

    assert.equal(await api.unpin(cid), true)
    assert.equal(await api.remove(cid), true, 'unpinned content can now be removed')
    assert.equal(await api.get(cid), null)
  })

  it('pin/unpin/remove on an unknown CID all return false', async () => {
    const alice = await createIpfsTestPeer('alice')
    const { api } = attachService(alice, undefined, createIpfsService({}))
    const unknown = '0'.repeat(64)
    assert.equal(await api.pin(unknown), false)
    assert.equal(await api.unpin(unknown), false)
    assert.equal(await api.remove(unknown), false)
  })

  it('listCids/getStats reflect the lifecycle', async () => {
    const alice = await createIpfsTestPeer('alice')
    const { api } = attachService(alice, undefined, createIpfsService({}))

    await api.add(new Uint8Array([1]))
    const { cid: cid2 } = await api.add(new Uint8Array([2, 2]))
    await api.pin(cid2)

    assert.equal(api.listCids().length, 2)
    const stats = api.getStats()
    assert.equal(stats.totalCids, 2)
    assert.equal(stats.pinnedCount, 1)

    await api.remove(cid2).catch(() => {}) // pinned -- expected to fail
    assert.equal(api.getStats().totalCids, 2, 'pinned entry survives a remove attempt')
  })
})

describe('createIpfsService: ctx.emit() events', () => {
  it('bridges add/remove/pin/unpin through ctx.emit(), prefixed peer-ipfs:', async () => {
    const alice = await createIpfsTestPeer('alice')
    const { api, on } = attachService(alice, undefined, createIpfsService({}))

    const events = []
    on('peer-ipfs:add', (d) => events.push({ type: 'add', ...d }))
    on('peer-ipfs:pin', (d) => events.push({ type: 'pin', ...d }))
    on('peer-ipfs:unpin', (d) => events.push({ type: 'unpin', ...d }))
    on('peer-ipfs:remove', (d) => events.push({ type: 'remove', ...d }))

    const { cid } = await api.add(new Uint8Array([7, 7, 7]))
    await api.pin(cid)
    await api.unpin(cid)
    await api.remove(cid)

    assert.deepEqual(events.map((e) => e.type), ['add', 'pin', 'unpin', 'remove'])
    assert.equal(events[0].cid, cid)
    assert.equal(events[0].size, 3)
  })

  it('onEvent() firehose sees every event this service emits', async () => {
    const alice = await createIpfsTestPeer('alice')
    const { api, onEvent } = attachService(alice, undefined, createIpfsService({}))

    const seen = []
    onEvent((event, data) => seen.push({ event, data }))

    await api.add(new Uint8Array([1]))
    assert.ok(seen.some((e) => e.event === 'peer-ipfs:add'))
  })

  it('bridges IPFSStore\'s (level, message) onLog into (event, data) shape as peer-ipfs:log', async () => {
    const alice = await createIpfsTestPeer('alice')
    const logs = []
    const { api } = attachService(
      alice,
      undefined,
      createIpfsService({ onLog: (event, data) => logs.push({ event, data }) }),
    )

    // remove() on a pinned CID hits IPFSStore's onLog(1, 'Cannot remove pinned content: ...').
    const { cid } = await api.add(new Uint8Array([1]))
    await api.pin(cid)
    await api.remove(cid)

    assert.ok(logs.some((l) => l.event === 'peer-ipfs:log' && l.data.level === 1))
  })
})

describe('createIpfsService: teardown', () => {
  it('teardown() closes the store (clears content, resets loaded/available)', async () => {
    const alice = await createIpfsTestPeer('alice')
    const { api, teardown } = attachService(alice, undefined, createIpfsService({}))

    await api.add(new Uint8Array([1, 2, 3]))
    assert.equal(api.listCids().length, 1)

    await teardown()

    assert.equal(api.isLoaded(), false)
    assert.equal(api.listCids().length, 0)
  })
})

describe('createIpfsService: mesh-local, not mesh-wide -- structural proof', () => {
  it('content added via one peer\'s service is never visible via another\'s (no wire protocol at all)', async () => {
    const alice = await createIpfsTestPeer('alice')
    const bob = await createIpfsTestPeer('bob')

    const { api: aliceApi } = attachService(alice, undefined, createIpfsService({}))
    const { api: bobApi } = attachService(bob, undefined, createIpfsService({}))

    const { cid } = await aliceApi.add(new Uint8Array([42, 42, 42]))

    // Same content-addressing scheme, so the CID alone is enough to ask --
    // but bob's store never received anything from alice's, at all.
    assert.equal(await bobApi.get(cid), null)
    assert.equal(bobApi.listCids().length, 0)
    assert.equal(aliceApi.listCids().length, 1)
  })
})

// -----------------------------------------------------------------------
// createMeshNode({ enableIpfs: true }) -- opt-in surface (issue #123)
// -----------------------------------------------------------------------
// Mirrors peer-routing.test.mjs's own "createMeshNode({ enableRouting: true })"
// integration section: real createMeshNode() PeerNodes, skipBoot: true where
// the test doesn't need actual discovery/WebRTC boot, just construction and
// the opt-in wiring surface itself.

function createStubSignalingTransport() {
  return { send() {}, onMessage() {} }
}

describe('createMeshNode({ enableIpfs: true })', () => {
  it('leaves node.ipfs unset and node.services empty of "peer-ipfs" when enableIpfs is omitted', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
    })

    assert.equal(node.ipfs, undefined)
    assert.equal(node.services.has('peer-ipfs'), false)
  })

  it('attaches node.ipfs (== node.services.get("peer-ipfs")) when enableIpfs is set', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableIpfs: true,
      skipBoot: true,
    })

    assert.ok(node.ipfs, 'node.ipfs is attached')
    assert.equal(node.ipfs, node.services.get('peer-ipfs'))
    assert.equal(typeof node.ipfs.api.add, 'function')

    const { cid } = await node.ipfs.api.add(new Uint8Array([1, 2, 3]))
    assert.deepEqual(await node.ipfs.api.get(cid), new Uint8Array([1, 2, 3]))
  })

  it('ipfsOptions are forwarded to createIpfsService()', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableIpfs: true,
      ipfsOptions: { maxStorageMb: 0.0001 },
      skipBoot: true,
    })

    await assert.rejects(
      () => node.ipfs.api.add(new Uint8Array(200)),
      /Storage limit exceeded/,
    )
  })
})
