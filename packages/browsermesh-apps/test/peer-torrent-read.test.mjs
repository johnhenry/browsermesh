// TorrentManager#downloadReal: how the finished file is read (#247).
// Fake clients only; the real-client proof is test/real-torrent/.

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TorrentManager, TORRENT_DEFAULTS } from '../src/peer-torrent.mjs'

const BYTES = Uint8Array.from({ length: 1000 }, (_, i) => i & 0xff)

/** A client whose add() completes immediately with one file shaped by `file`. */
function clientWith(file, removed = []) {
  return {
    add(magnet, cb) {
      const handlers = {}
      const torrent = {
        infoHash: 'abc', numPeers: 1, progress: 1, done: true,
        files: file ? [{ name: 'f.bin', length: BYTES.length, ...file }] : [],
        on(ev, fn) { handlers[ev] = fn },
      }
      queueMicrotask(() => cb(torrent))
      return torrent
    },
    remove(magnet) { removed.push(magnet) },
    destroy(cb) { cb?.() },
  }
}

function streamOf(bytes, chunk = 100) {
  return () => new ReadableStream({
    start(c) {
      for (let i = 0; i < bytes.length; i += chunk) c.enqueue(bytes.slice(i, i + chunk))
      c.close()
    },
  })
}

describe('TorrentManager#downloadReal reads the file with the supported API (#247)', () => {
  it('streams a WebTorrent 2.x/3.x file (no getBuffer)', async () => {
    const tm = new TorrentManager({ webtorrent: clientWith({ stream: streamOf(BYTES) }) })
    const { data } = await tm.download('magnet:?xt=urn:btih:abc')
    assert.deepEqual(data, BYTES)
  })

  it('falls back to arrayBuffer() when there is no stream()', async () => {
    const tm = new TorrentManager({ webtorrent: clientWith({ arrayBuffer: async () => BYTES.buffer.slice(0) }) })
    const { data } = await tm.download('magnet:?xt=urn:btih:abc')
    assert.deepEqual(data, BYTES)
  })

  it('keeps the callback getBuffer() branch for a 1.x client', async () => {
    const tm = new TorrentManager({ webtorrent: clientWith({ getBuffer: (cb) => cb(null, Buffer.from(BYTES)) }) })
    const { data } = await tm.download('magnet:?xt=urn:btih:abc')
    assert.deepEqual(data, BYTES)
  })

  it('rejects, rather than throwing from the event handler, when the file cannot be read', async () => {
    const removed = []
    const tm = new TorrentManager({ webtorrent: clientWith({}, removed) })
    await assert.rejects(tm.download('magnet:?xt=urn:btih:abc'), /Unsupported WebTorrent File/)
    assert.deepEqual(removed, ['magnet:?xt=urn:btih:abc'], 'and the torrent is removed from the client')
  })
})

describe('TorrentManager#downloadReal bounds memory (#247)', () => {
  it('refuses a file larger than maxBytes before reading it', async () => {
    let read = false
    const tm = new TorrentManager({ webtorrent: clientWith({ stream: () => { read = true; return streamOf(BYTES)() } }) })
    await assert.rejects(tm.download('magnet:?xt=urn:btih:abc', { maxBytes: 999 }), /exceeds maxBytes/)
    assert.equal(read, false)
  })

  it('stops reading a stream that delivers more than the file claimed', async () => {
    const lying = new Uint8Array(5000)
    const tm = new TorrentManager({ webtorrent: clientWith({ stream: streamOf(lying) }) })
    await assert.rejects(tm.download('magnet:?xt=urn:btih:abc', { maxBytes: 1000 }), /exceeds maxBytes/)
  })

  it('has a finite default cap, and maxBytes: Infinity lifts it', async () => {
    assert.ok(Number.isFinite(TORRENT_DEFAULTS.maxDownloadBytes))
    const tm = new TorrentManager({ webtorrent: clientWith({ length: TORRENT_DEFAULTS.maxDownloadBytes + 1, stream: streamOf(BYTES) }) })
    await assert.rejects(tm.download('magnet:?xt=urn:btih:abc'), /exceeds maxBytes/)
    await assert.doesNotReject(tm.download('magnet:?xt=urn:btih:abc', { maxBytes: Infinity }))
  })
})
