// Run with: node --import ./test/_setup-globals.mjs --test test/peer-torrent.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { TorrentManager, TORRENT_DEFAULTS } from '../src/peer-torrent.mjs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('TORRENT_DEFAULTS', () => {
  it('has expected defaults', () => {
    assert.equal(TORRENT_DEFAULTS.chunkSize, 65536)
    assert.equal(TORRENT_DEFAULTS.maxPeers, 10)
    assert.equal(TORRENT_DEFAULTS.announceIntervalMs, 30000)
    assert.equal(TORRENT_DEFAULTS.trackerUrl, null)
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(TORRENT_DEFAULTS))
  })
})

// ---------------------------------------------------------------------------
// TorrentManager — construction
// ---------------------------------------------------------------------------

describe('TorrentManager construction', () => {
  it('constructs with defaults', () => {
    const tm = new TorrentManager()
    assert.equal(tm.loaded, false)
    assert.equal(tm.available, false)
  })

  it('accepts trackerUrl option', () => {
    const tm = new TorrentManager({ trackerUrl: 'wss://tracker.example.com' })
    assert.equal(tm.loaded, false)
  })

  it('accepts onLog callback', () => {
    const logs = []
    const tm = new TorrentManager({ onLog: (level, msg) => logs.push({ level, msg }) })
    assert.equal(tm.loaded, false)
  })
})

// ---------------------------------------------------------------------------
// TorrentManager — ensureLoaded (no WebTorrent in Node)
// ---------------------------------------------------------------------------

describe('TorrentManager ensureLoaded', () => {
  it('marks as loaded after ensureLoaded', async () => {
    const tm = new TorrentManager()
    await tm.ensureLoaded()
    assert.equal(tm.loaded, true)
  })

  it('available is false without WebTorrent', async () => {
    const tm = new TorrentManager()
    await tm.ensureLoaded()
    assert.equal(tm.available, false)
  })

  it('ensureLoaded is idempotent', async () => {
    const tm = new TorrentManager()
    await tm.ensureLoaded()
    await tm.ensureLoaded()
    assert.equal(tm.loaded, true)
  })
})

// ---------------------------------------------------------------------------
// TorrentManager — seed (fallback)
// ---------------------------------------------------------------------------

describe('TorrentManager seed (fallback)', () => {
  let tm

  beforeEach(async () => {
    tm = new TorrentManager()
    await tm.ensureLoaded()
  })

  it('seeds data and returns TorrentInfo', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    const info = await tm.seed(data, { name: 'test.bin' })

    assert.equal(typeof info.magnetURI, 'string')
    assert.ok(info.magnetURI.startsWith('magnet:?xt=urn:btih:'))
    assert.equal(typeof info.infoHash, 'string')
    assert.equal(info.name, 'test.bin')
    assert.equal(info.size, 5)
    assert.equal(info.progress, 1)
    assert.equal(info.state, 'seeding')
  })

  it('generates default name when not provided', async () => {
    const data = new Uint8Array([10, 20])
    const info = await tm.seed(data)
    assert.ok(info.name.startsWith('file_'))
  })

  it('seeding adds to active torrents', async () => {
    const data = new Uint8Array([1, 2, 3])
    const info = await tm.seed(data, { name: 'a.bin' })
    const list = tm.listTorrents()
    assert.equal(list.length, 1)
    assert.equal(list[0].magnetURI, info.magnetURI)
  })

  it('emits seed event', async () => {
    const events = []
    tm.on('seed', (info) => events.push(info))

    await tm.seed(new Uint8Array([42]), { name: 'x' })
    assert.equal(events.length, 1)
    assert.equal(events[0].name, 'x')
  })

  it('updates totalUp in stats', async () => {
    await tm.seed(new Uint8Array(100), { name: 'big' })
    const stats = tm.getStats()
    assert.equal(stats.totalUp, 100)
  })

  it('auto-loads on first seed if not loaded', async () => {
    const fresh = new TorrentManager()
    assert.equal(fresh.loaded, false)
    await fresh.seed(new Uint8Array([1]))
    assert.equal(fresh.loaded, true)
  })
})

// ---------------------------------------------------------------------------
// TorrentManager — download (fallback)
// ---------------------------------------------------------------------------

describe('TorrentManager download (fallback)', () => {
  let tm

  beforeEach(async () => {
    tm = new TorrentManager()
    await tm.ensureLoaded()
  })

  it('downloads previously seeded data', async () => {
    const original = new Uint8Array([10, 20, 30, 40, 50])
    const seeded = await tm.seed(original, { name: 'dl.bin' })

    const { data, info } = await tm.download(seeded.magnetURI)
    assert.deepEqual(data, original)
    assert.equal(info.name, 'dl.bin')
    assert.equal(info.size, 5)
  })

  it('throws for unknown magnet URI', async () => {
    await assert.rejects(
      () => tm.download('magnet:?xt=urn:btih:nonexistent'),
      /Content not found/,
    )
  })

  it('throws for invalid magnet URI', async () => {
    await assert.rejects(
      () => tm.download('not-a-magnet'),
      /Invalid magnet URI/,
    )
  })

  it('calls onProgress callback', async () => {
    const progress = []
    const data = new Uint8Array([1, 2, 3])
    const seeded = await tm.seed(data)

    await tm.download(seeded.magnetURI, {
      onProgress: (p) => progress.push(p),
    })

    assert.equal(progress.length, 1)
    assert.equal(progress[0], 1)
  })

  it('emits download:start and download:complete events', async () => {
    const events = []
    tm.on('download:start', (d) => events.push({ type: 'start', ...d }))
    tm.on('download:complete', (d) => events.push({ type: 'complete', ...d }))

    const seeded = await tm.seed(new Uint8Array([7, 8, 9]))
    await tm.download(seeded.magnetURI)

    assert.equal(events.filter(e => e.type === 'start').length, 1)
    assert.equal(events.filter(e => e.type === 'complete').length, 1)
  })

  it('updates totalDown in stats', async () => {
    const data = new Uint8Array(50)
    const seeded = await tm.seed(data)
    await tm.download(seeded.magnetURI)
    const stats = tm.getStats()
    assert.equal(stats.totalDown, 50)
  })

  it('auto-loads on first download if not loaded', async () => {
    // Seed on one manager, try download on a fresh one (will fail because
    // the fallback store is per-instance, but it should at least auto-load)
    const fresh = new TorrentManager()
    assert.equal(fresh.loaded, false)
    await assert.rejects(
      () => fresh.download('magnet:?xt=urn:btih:abc123'),
      /Content not found/,
    )
    assert.equal(fresh.loaded, true)
  })
})

// ---------------------------------------------------------------------------
// TorrentManager — shareWithPeers
// ---------------------------------------------------------------------------

describe('TorrentManager shareWithPeers', () => {
  let tm

  beforeEach(async () => {
    tm = new TorrentManager()
    await tm.ensureLoaded()
  })

  it('calls sendFn for each peer', async () => {
    const seeded = await tm.seed(new Uint8Array([1, 2, 3]), { name: 'shared.bin' })
    const calls = []

    tm.shareWithPeers(seeded.magnetURI, ['peer-a', 'peer-b', 'peer-c'], (peerId, msg) => {
      calls.push({ peerId, msg })
    })

    assert.equal(calls.length, 3)
    assert.equal(calls[0].peerId, 'peer-a')
    assert.equal(calls[0].msg.type, 'torrent:share')
    assert.equal(calls[0].msg.magnetURI, seeded.magnetURI)
    assert.equal(calls[0].msg.info.name, 'shared.bin')
    assert.equal(calls[1].peerId, 'peer-b')
    assert.equal(calls[2].peerId, 'peer-c')
  })

  it('sends null info for unknown magnet', () => {
    const calls = []
    tm.shareWithPeers('magnet:?xt=urn:btih:unknown', ['peer-x'], (peerId, msg) => {
      calls.push({ peerId, msg })
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].msg.info, null)
  })

  it('throws if magnetURI is missing', () => {
    assert.throws(() => tm.shareWithPeers('', [], () => {}), /magnetURI is required/)
  })

  it('throws if peerIds is not an array', () => {
    assert.throws(() => tm.shareWithPeers('magnet:?xt=urn:btih:x', 'bad', () => {}), /peerIds must be an array/)
  })

  it('throws if sendFn is not a function', () => {
    assert.throws(() => tm.shareWithPeers('magnet:?xt=urn:btih:x', [], null), /sendFn must be a function/)
  })

  it('handles empty peerIds array', () => {
    const calls = []
    tm.shareWithPeers('magnet:?xt=urn:btih:x', [], (peerId, msg) => calls.push({ peerId, msg }))
    assert.equal(calls.length, 0)
  })
})

// ---------------------------------------------------------------------------
// TorrentManager — listTorrents / getTorrent / removeTorrent
// ---------------------------------------------------------------------------

describe('TorrentManager listTorrents', () => {
  let tm

  beforeEach(async () => {
    tm = new TorrentManager()
    await tm.ensureLoaded()
  })

  it('returns empty array when no torrents', () => {
    assert.deepEqual(tm.listTorrents(), [])
  })

  it('lists all seeded torrents', async () => {
    await tm.seed(new Uint8Array([1]), { name: 'a' })
    await tm.seed(new Uint8Array([2]), { name: 'b' })
    const list = tm.listTorrents()
    assert.equal(list.length, 2)
    const names = list.map(t => t.name).sort()
    assert.deepEqual(names, ['a', 'b'])
  })
})

describe('TorrentManager getTorrent', () => {
  it('returns torrent info by magnetURI', async () => {
    const tm = new TorrentManager()
    await tm.ensureLoaded()
    const seeded = await tm.seed(new Uint8Array([5, 6, 7]), { name: 'found' })
    const info = tm.getTorrent(seeded.magnetURI)
    assert.ok(info)
    assert.equal(info.name, 'found')
  })

  it('returns null for unknown magnetURI', async () => {
    const tm = new TorrentManager()
    await tm.ensureLoaded()
    assert.equal(tm.getTorrent('magnet:?xt=urn:btih:nope'), null)
  })
})

describe('TorrentManager removeTorrent', () => {
  let tm

  beforeEach(async () => {
    tm = new TorrentManager()
    await tm.ensureLoaded()
  })

  it('removes an active torrent', async () => {
    const seeded = await tm.seed(new Uint8Array([1, 2, 3]), { name: 'remove-me' })
    assert.equal(tm.listTorrents().length, 1)

    const removed = tm.removeTorrent(seeded.magnetURI)
    assert.ok(removed)
    assert.equal(tm.listTorrents().length, 0)
  })

  it('returns false for non-existent torrent', () => {
    assert.equal(tm.removeTorrent('magnet:?xt=urn:btih:nope'), false)
  })

  it('removed torrent cannot be downloaded', async () => {
    const seeded = await tm.seed(new Uint8Array([1, 2, 3]))
    tm.removeTorrent(seeded.magnetURI)
    await assert.rejects(
      () => tm.download(seeded.magnetURI),
      /Content not found/,
    )
  })
})

// ---------------------------------------------------------------------------
// TorrentManager — getStats
// ---------------------------------------------------------------------------

describe('TorrentManager getStats', () => {
  it('returns zero stats initially', async () => {
    const tm = new TorrentManager()
    await tm.ensureLoaded()
    const stats = tm.getStats()
    assert.equal(stats.downloading, 0)
    assert.equal(stats.seeding, 0)
    assert.equal(stats.totalDown, 0)
    assert.equal(stats.totalUp, 0)
  })

  it('counts seeding torrents', async () => {
    const tm = new TorrentManager()
    await tm.ensureLoaded()
    await tm.seed(new Uint8Array([1, 2, 3]))
    await tm.seed(new Uint8Array([4, 5, 6]))
    const stats = tm.getStats()
    assert.equal(stats.seeding, 2)
    assert.equal(stats.totalUp, 6)
  })

  it('accumulates download bytes', async () => {
    const tm = new TorrentManager()
    await tm.ensureLoaded()
    const data = new Uint8Array(200)
    const seeded = await tm.seed(data)
    await tm.download(seeded.magnetURI)
    const stats = tm.getStats()
    assert.equal(stats.totalDown, 200)
  })
})

// ---------------------------------------------------------------------------
// TorrentManager — events
// ---------------------------------------------------------------------------

describe('TorrentManager events', () => {
  it('on/off registers and removes listeners', async () => {
    const tm = new TorrentManager()
    await tm.ensureLoaded()

    const events = []
    const handler = (info) => events.push(info)

    tm.on('seed', handler)
    await tm.seed(new Uint8Array([1]))
    assert.equal(events.length, 1)

    tm.off('seed', handler)
    await tm.seed(new Uint8Array([2]))
    assert.equal(events.length, 1) // no new event
  })

  it('listener errors do not propagate', async () => {
    const logs = []
    const tm = new TorrentManager({ onLog: (level, msg) => logs.push({ level, msg }) })
    await tm.ensureLoaded()

    tm.on('seed', () => { throw new Error('boom') })
    // Should not throw
    await tm.seed(new Uint8Array([1]))
    assert.ok(logs.some(l => l.msg.includes('boom')))
  })
})

// ---------------------------------------------------------------------------
// TorrentManager — destroy
// ---------------------------------------------------------------------------

describe('TorrentManager destroy', () => {
  it('clears all state', async () => {
    const tm = new TorrentManager()
    await tm.ensureLoaded()
    await tm.seed(new Uint8Array([1, 2, 3]), { name: 'x' })
    assert.equal(tm.listTorrents().length, 1)

    await tm.destroy()
    assert.equal(tm.loaded, false)
    assert.equal(tm.available, false)
    assert.equal(tm.listTorrents().length, 0)
    assert.equal(tm.getStats().totalUp, 0)
    assert.equal(tm.getStats().totalDown, 0)
  })

  it('can be reloaded after destroy', async () => {
    const tm = new TorrentManager()
    await tm.ensureLoaded()
    await tm.destroy()
    assert.equal(tm.loaded, false)

    await tm.ensureLoaded()
    assert.equal(tm.loaded, true)
  })
})

// ---------------------------------------------------------------------------
// TorrentManager — toJSON
// ---------------------------------------------------------------------------

describe('TorrentManager toJSON', () => {
  it('serializes current state', async () => {
    const tm = new TorrentManager({ trackerUrl: 'wss://t.example.com' })
    await tm.ensureLoaded()
    await tm.seed(new Uint8Array([1, 2, 3]), { name: 'test' })

    const json = tm.toJSON()
    assert.equal(json.loaded, true)
    assert.equal(json.available, false)
    assert.equal(json.trackerUrl, 'wss://t.example.com')
    assert.equal(json.activeTorrents.length, 1)
    assert.equal(json.activeTorrents[0].name, 'test')
    assert.ok(json.stats)
    assert.equal(json.stats.seeding, 1)
  })

  it('serializes empty manager', async () => {
    const tm = new TorrentManager()
    const json = tm.toJSON()
    assert.equal(json.loaded, false)
    assert.deepEqual(json.activeTorrents, [])
  })
})
