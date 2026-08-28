// Run with: node --import ./test/_setup-globals.mjs --test test/peer-ipfs.test.mjs
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { IPFSStore, IPFS_DEFAULTS } from '../src/peer-ipfs.mjs'

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
