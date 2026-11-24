// TorrentManager against the REAL WebTorrent 2.x client, no network.
//
// Two WebTorrent clients in one process: one seeds, the other is handed to a
// TorrentManager, which downloads from the first over loopback TCP. DHT,
// trackers, LSD and uTP are off, and the seeder's loopback address is carried
// in the magnet URI (`x.pe=`), so nothing leaves the machine.
//
// This is the test that would have caught #247: the injected fakes in
// ../mesh-torrent-download.test.mjs never implement File, so a removed File
// method went unnoticed.
//
// Opt-in, like test:real-peer / test:real-gpu:
//   npm run test:real-torrent -w @johnhenry/browsermesh-apps
// Skips when `webtorrent` is not installed; REQUIRE_REAL_TORRENT=1 makes that
// a failure instead.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { TorrentManager } from '../../src/peer-torrent.mjs'

let WebTorrent = null
try {
  WebTorrent = (await import('webtorrent')).default
} catch (err) {
  if (process.env.REQUIRE_REAL_TORRENT) {
    throw new Error(`REQUIRE_REAL_TORRENT is set but \`webtorrent\` did not load: ${err.message}`)
  }
}

const quiet = { dht: false, tracker: false, lsd: false, utp: false, natUpnp: false, natPmp: false, webSeeds: false }

if (!WebTorrent) {
  describe('TorrentManager (real WebTorrent)', () => {
    it('skipped: devDependency `webtorrent` is not installed', () => {})
  })
} else {
  describe('TorrentManager (real WebTorrent)', () => {
    let seeder
    let leecher

    before(async () => {
      seeder = new WebTorrent({ ...quiet, torrentPort: 0 })
      leecher = new WebTorrent({ ...quiet, torrentPort: 0 })
      await Promise.all([
        new Promise((r) => (seeder.torrentPort ? r() : seeder.once('listening', r))),
        new Promise((r) => (leecher.torrentPort ? r() : leecher.once('listening', r))),
      ])
    })

    after(async () => {
      await new Promise((r) => seeder.destroy(r))
      await new Promise((r) => leecher.destroy(r))
    })

    async function seedBytes(bytes, name) {
      const torrent = await new Promise((resolve) => seeder.seed(Buffer.from(bytes), { name }, resolve))
      return `${torrent.magnetURI}&x.pe=127.0.0.1:${seeder.torrentPort}`
    }

    it('downloads a real torrent and returns its exact bytes', async () => {
      const bytes = new Uint8Array(200_000)
      for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff
      const magnet = await seedBytes(bytes, 'real.bin')

      const tm = new TorrentManager({ webtorrent: leecher })
      const { data, info } = await tm.download(magnet, { timeout: 20_000 })
      assert.equal(data.length, bytes.length)
      assert.ok(Buffer.from(data).equals(Buffer.from(bytes)), 'bytes differ')
      assert.equal(info.name, 'real.bin')
      assert.equal(info.size, bytes.length)
    })

    it('refuses a file larger than maxBytes instead of buffering it, and removes the torrent', async () => {
      const magnet = await seedBytes(new Uint8Array(50_000).fill(3), 'big.bin')
      const tm = new TorrentManager({ webtorrent: leecher })
      await assert.rejects(
        tm.download(magnet, { timeout: 20_000, maxBytes: 10_000 }),
        /exceeds maxBytes/,
      )
      assert.equal(await leecher.get(magnet), null, 'a failed download must not stay in the client')
    })
  })
}
