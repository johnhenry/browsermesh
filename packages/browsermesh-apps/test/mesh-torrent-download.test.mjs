// Run with: node --import ./test/_setup-globals.mjs --test test/mesh-torrent-download.test.mjs
//
// createTorrentService().api.download() (#216): the onManifest quota gate,
// onProgress, bounded piece concurrency, cleanup of a failed download, bounds on
// remembered remote manifests; and TorrentManager's injectable WebTorrent with
// no CDN import anywhere in the package (#217).
//
// Fixtures mirror mesh-torrent-hooks.test.mjs: real Ed25519 identities and a
// duck-typed sendTo()/onIncomingData() bus restricted to explicit edges.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { TorrentManager } from '../src/peer-torrent.mjs'
import { createTorrentService } from '../src/mesh-torrent.mjs'
import { createMeshNode } from '../src/mesh-bootstrap.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'
import { ChunkStore } from '@johnhenry/browsermesh-sync'

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')

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

function wireMesh(peers, edges) {
  const edgeSet = new Set()
  for (const [a, b] of edges) {
    edgeSet.add(`${a}|${b}`)
    edgeSet.add(`${b}|${a}`)
  }
  const listeners = new Map(peers.map((p) => [p.podId, new Set()]))
  const nodes = {}
  for (const peer of peers) {
    nodes[peer.podId] = {
      podId: peer.podId,
      wallet: peer.wallet,
      registry: peer.registry,
      onIncomingData(cb) {
        const set = listeners.get(peer.podId)
        set.add(cb)
        return () => set.delete(cb)
      },
      async sendTo(pubKey, data) {
        if (!edgeSet.has(`${peer.podId}|${pubKey}`)) return
        const set = listeners.get(pubKey)
        if (!set) return
        queueMicrotask(() => { for (const cb of set) cb(peer.podId, data) })
      },
    }
  }
  return nodes
}

async function waitFor(fn, timeoutMs = 2000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A ChunkStore whose get() takes `delayMs` and records how many gets overlap, and in what order cids were asked for. */
function instrumentedStore(delayMs = 0) {
  const store = new ChunkStore()
  const stats = { inFlight: 0, maxInFlight: 0, order: [] }
  const get = store.get.bind(store)
  store.get = async (cid) => {
    stats.order.push(cid)
    stats.inFlight++
    stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight)
    try {
      if (delayMs) await sleep(delayMs)
      return await get(cid)
    } finally {
      stats.inFlight--
    }
  }
  return { store, stats }
}

/** alice <-> bob, alice seeding through `aliceStore`. */
async function pair(aliceOpts = {}, bobOpts = {}) {
  const alice = await createPeer('alice')
  const bob = await createPeer('bob')
  const mesh = wireMesh([alice, bob], [[alice.podId, bob.podId]])
  const aliceHandle = attachService(mesh[alice.podId], undefined, createTorrentService({ chunkSize: 4, ...aliceOpts }))
  const bobHandle = attachService(mesh[bob.podId], undefined, createTorrentService({ chunkSize: 4, ...bobOpts }))
  return { alice, bob, nodeA: mesh[alice.podId], nodeB: mesh[bob.podId], aliceHandle, bobHandle }
}

/** 40 bytes, 4-byte pieces: ten distinct pieces. */
const forty = Uint8Array.from({ length: 40 }, (_, i) => i + 1)

// ===========================================================================
// #216 -- onManifest
// ===========================================================================

describe('createTorrentService download(): onManifest gate (#216)', () => {
  it('is called once with a copy of the manifest, before any piece is requested', async () => {
    const aliceChunks = instrumentedStore()
    const { aliceHandle, bobHandle, alice } = await pair({ chunkStore: aliceChunks.store })
    const info = await aliceHandle.api.seed(forty, { name: 'forty' })

    const calls = []
    const { data } = await bobHandle.api.download(info.magnetURI, {
      peers: [alice.podId],
      onManifest: (manifest) => {
        calls.push({ manifest, aliceServedSoFar: aliceChunks.stats.order.length })
        manifest.chunkCids.length = 0 // mutating the copy must change nothing
      },
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].aliceServedSoFar, 0, 'no piece was requested before the hook ran')
    assert.equal(calls[0].manifest.size, 40)
    assert.equal(calls[0].manifest.name, 'forty')
    assert.equal(calls[0].manifest.magnetURI, info.magnetURI)
    assert.equal(calls[0].manifest.chunkSize, 4)
    assert.deepEqual(data, forty)
  })

  it('returning false aborts with code manifest-rejected and requests and stores no piece', async () => {
    const aliceChunks = instrumentedStore()
    const bobChunks = new ChunkStore()
    const { aliceHandle, bobHandle, alice } = await pair({ chunkStore: aliceChunks.store }, { chunkStore: bobChunks })
    const info = await aliceHandle.api.seed(forty, { name: 'forty' })
    const served = aliceChunks.stats.order.length // seeding may have read nothing; baseline anyway

    await assert.rejects(
      () => bobHandle.api.download(info.magnetURI, { peers: [alice.podId], onManifest: (m) => m.size <= 10 }),
      (err) => err.code === 'manifest-rejected',
    )
    assert.equal(aliceChunks.stats.order.length, served, 'alice was never asked for a piece')
    assert.equal(bobChunks.size, 0, 'bob stored nothing')
    assert.equal(bobHandle.api.getManifest(info.magnetURI) !== null, true, 'the manifest is still known (remote), just not held')
    assert.equal(bobHandle.api.listTorrents().length, 0, 'and bob did not become a seeder')
  })

  it('a throw (or rejection) aborts and propagates unchanged', async () => {
    const aliceChunks = instrumentedStore()
    const { aliceHandle, bobHandle, alice } = await pair({ chunkStore: aliceChunks.store })
    const info = await aliceHandle.api.seed(forty, { name: 'forty' })
    const quota = new Error('quota exceeded')
    await assert.rejects(
      () => bobHandle.api.download(info.magnetURI, { peers: [alice.podId], onManifest: async () => { throw quota } }),
      (err) => err === quota,
    )
    assert.equal(aliceChunks.stats.order.length, 0)
  })

  it('is awaited: no piece is requested until an async hook resolves', async () => {
    const aliceChunks = instrumentedStore()
    const { aliceHandle, bobHandle, alice } = await pair({ chunkStore: aliceChunks.store })
    const info = await aliceHandle.api.seed(forty, { name: 'forty' })

    let release
    const gate = new Promise((r) => { release = r })
    const pending = bobHandle.api.download(info.magnetURI, { peers: [alice.podId], onManifest: () => gate })
    await sleep(60)
    assert.equal(aliceChunks.stats.order.length, 0, 'still waiting on the hook')
    release(true)
    const { data } = await pending
    assert.deepEqual(data, forty)
  })

  it('rejects a non-function onManifest / onProgress up front', async () => {
    const { bobHandle } = await pair()
    await assert.rejects(() => bobHandle.api.download('magnet:?xt=urn:btih:x', { onManifest: 1 }), /onManifest must be a function/)
    await assert.rejects(() => bobHandle.api.download('magnet:?xt=urn:btih:x', { onProgress: 'x' }), /onProgress must be a function/)
  })
})

// ===========================================================================
// #216 -- onProgress
// ===========================================================================

describe('createTorrentService download(): onProgress (#216)', () => {
  it('reports every piece with received/total/bytes/size/from', async () => {
    const { aliceHandle, bobHandle, alice } = await pair()
    const info = await aliceHandle.api.seed(forty, { name: 'forty' })
    const events = []
    await bobHandle.api.download(info.magnetURI, { peers: [alice.podId], concurrency: 1, onProgress: (p) => events.push(p) })

    assert.equal(events.length, 10)
    assert.deepEqual(events.map((e) => e.received), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    assert.deepEqual(events.map((e) => e.bytes), [4, 8, 12, 16, 20, 24, 28, 32, 36, 40])
    for (const e of events) {
      assert.equal(e.total, 10)
      assert.equal(e.size, 40)
      assert.equal(e.from, alice.podId)
      assert.match(e.cid, /^[0-9a-f]{64}$/)
    }
  })

  it('counts pieces already in the local store (from: null) and survives a throwing callback', async () => {
    const bobChunks = new ChunkStore()
    const { aliceHandle, bobHandle, alice } = await pair({}, { chunkStore: bobChunks })
    const info = await aliceHandle.api.seed(forty, { name: 'forty' })
    const firstCid = aliceHandle.api.getManifest(info.magnetURI).chunkCids[0]
    await bobChunks.save(firstCid, forty.slice(0, 4))

    const events = []
    const { data } = await bobHandle.api.download(info.magnetURI, {
      peers: [alice.podId],
      concurrency: 1,
      onProgress: (p) => { events.push(p); throw new Error('UI blew up') },
    })
    assert.deepEqual(data, forty)
    assert.equal(events[0].from, null)
    assert.equal(events.at(-1).received, 10)
  })
})

// ===========================================================================
// #216 -- piece concurrency
// ===========================================================================

describe('createTorrentService download(): piece concurrency (#216)', () => {
  async function maxInFlight(downloadOpts, serviceOpts = {}) {
    const aliceChunks = instrumentedStore(15)
    const { aliceHandle, bobHandle, alice } = await pair(
      { chunkStore: aliceChunks.store, maxConcurrentServesPerPeer: 0, maxConcurrentServes: 0 },
      serviceOpts,
    )
    const info = await aliceHandle.api.seed(forty, { name: 'forty' })
    aliceChunks.stats.maxInFlight = 0
    aliceChunks.stats.order.length = 0
    const { data } = await bobHandle.api.download(info.magnetURI, { peers: [alice.podId], ...downloadOpts })
    assert.deepEqual(data, forty)
    return aliceChunks.stats
  }

  it('defaults to 4 pieces in flight', async () => {
    assert.equal((await maxInFlight({})).maxInFlight, 4)
  })

  it('concurrency: 1 is strictly sequential and fetches in manifest order', async () => {
    const aliceChunks = instrumentedStore(10)
    const { aliceHandle, bobHandle, alice } = await pair({ chunkStore: aliceChunks.store })
    const info = await aliceHandle.api.seed(forty, { name: 'forty' })
    const expected = aliceHandle.api.getManifest(info.magnetURI).chunkCids
    aliceChunks.stats.order.length = 0
    aliceChunks.stats.maxInFlight = 0

    const received = []
    await bobHandle.api.download(info.magnetURI, {
      peers: [alice.podId], concurrency: 1, onProgress: (p) => received.push(p.cid),
    })
    assert.equal(aliceChunks.stats.maxInFlight, 1)
    assert.deepEqual(aliceChunks.stats.order, expected)
    assert.deepEqual(received, expected)
  })

  it('a per-call concurrency and the service-level downloadConcurrency are honoured', async () => {
    assert.equal((await maxInFlight({ concurrency: 2 })).maxInFlight, 2)
    assert.equal((await maxInFlight({}, { downloadConcurrency: 3 })).maxInFlight, 3)
    assert.equal((await maxInFlight({ concurrency: 8 })).maxInFlight, 8)
  })

  it('is bounded: out-of-range or non-integer values are rejected', async () => {
    const { bobHandle } = await pair()
    for (const bad of [0, -1, 1.5, 33, NaN, '4']) {
      await assert.rejects(() => bobHandle.api.download('magnet:?xt=urn:btih:x', { concurrency: bad }), TypeError, String(bad))
      assert.throws(() => createTorrentService({ downloadConcurrency: bad }), TypeError, String(bad))
    }
  })

  it('a provider that answers busy is retried rather than failing the download', async () => {
    // alice allows 1 concurrent serve per peer; bob asks for 4 at once.
    const { aliceHandle, bobHandle, alice } = await pair(
      { maxConcurrentServesPerPeer: 1 },
      { busyBackoffMs: 5, busyRetries: 50 },
    )
    const info = await aliceHandle.api.seed(forty, { name: 'forty' })
    const { data } = await bobHandle.api.download(info.magnetURI, { peers: [alice.podId], concurrency: 4 })
    assert.deepEqual(data, forty)
  })
})

// ===========================================================================
// #216 -- cleanup of a failed download
// ===========================================================================

describe('createTorrentService download(): failure cleanup (#216)', () => {
  /** alice seeds `forty`, but cannot produce piece `failIndex` (her store reports it missing). */
  async function failingPair(failIndex, bobChunks) {
    const aliceChunks = new ChunkStore()
    const realGet = aliceChunks.get.bind(aliceChunks)
    const ctl = { failCid: null }
    aliceChunks.get = async (cid) => (cid === ctl.failCid ? undefined : realGet(cid))
    const p = await pair({ chunkStore: aliceChunks }, { chunkStore: bobChunks })
    const info = await p.aliceHandle.api.seed(forty, { name: 'forty' })
    const cids = p.aliceHandle.api.getManifest(info.magnetURI).chunkCids
    ctl.failCid = cids[failIndex]
    return { ...p, info, cids }
  }

  for (const concurrency of [1, 4]) {
    it(`removes the pieces a failed download wrote but keeps ones a held torrent lists (concurrency ${concurrency})`, async () => {
      const bobChunks = new ChunkStore()
      const { bobHandle, alice, info, cids } = await failingPair(7, bobChunks)

      // Bob already holds a torrent that shares piece 0.
      const mine = await bobHandle.api.seed(forty.slice(0, 4), { name: 'prefix' })
      assert.equal(bobHandle.api.getManifest(mine.magnetURI).chunkCids[0], cids[0])
      const before = bobChunks.size

      const arrived = []
      await assert.rejects(() => bobHandle.api.download(info.magnetURI, {
        peers: [alice.podId], concurrency, onProgress: (p) => arrived.push(p.cid),
      }))
      assert.ok(arrived.length >= 1, 'some pieces had been written before the failure')
      assert.equal(bobChunks.size, before, 'everything the failed run wrote is gone again')
      assert.equal(await bobChunks.has(cids[0]), true, 'a piece a held torrent lists stays')
      assert.equal(bobHandle.api.listTorrents().some((t) => t.magnetURI === info.magnetURI), false)
    })
  }

  it('does not delete pieces that were already in the store before the download started', async () => {
    const bobChunks = new ChunkStore()
    const { bobHandle, alice, info, cids } = await failingPair(7, bobChunks)
    await bobChunks.save(cids[2], forty.slice(8, 12)) // e.g. written by something else sharing the store
    await assert.rejects(() => bobHandle.api.download(info.magnetURI, { peers: [alice.podId], concurrency: 1 }))
    assert.equal(bobChunks.size, 1)
    assert.equal(await bobChunks.has(cids[2]), true)
  })

})

// ===========================================================================
// #216 -- bounds on remembered remote manifests
// ===========================================================================

describe('createTorrentService: bounds on remote manifests (#216)', () => {
  const hex = (n) => n.toString(16).padStart(64, '0')
  const manifestOf = (n, extra = {}) => ({
    infoHash: `h${n}`, name: `n${n}`, size: 8, chunkSize: 4, chunkCids: [hex(2 * n), hex(2 * n + 1)], ...extra,
  })

  async function announcer(bobOpts = {}) {
    const { nodeA, nodeB, alice, bob, bobHandle } = await pair({}, bobOpts)
    const announce = async (magnetURI, manifest) => {
      await nodeA.sendTo(bob.podId, { type: 'mesh-torrent', kind: 'announce', magnetURI, manifest })
      await sleep(5)
    }
    return { announce, bobHandle, alice, bob, nodeB }
  }

  it('accepts a well-formed manifest and records its provider', async () => {
    const { announce, bobHandle, alice } = await announcer()
    const m = manifestOf(1)
    await announce('magnet:?xt=urn:btih:one', m)
    assert.deepEqual(bobHandle.api.getManifest('magnet:?xt=urn:btih:one').chunkCids, m.chunkCids)
    assert.deepEqual(bobHandle.api.listKnownProviders(m.chunkCids[0]), [alice.podId])
  })

  it('maxManifestChunks: longer chunkCids lists are ignored', async () => {
    const { announce, bobHandle } = await announcer({ maxManifestChunks: 2 })
    await announce('magnet:?xt=urn:btih:ok', manifestOf(1))
    const long = { infoHash: 'x', name: 'x', size: 12, chunkSize: 4, chunkCids: [hex(10), hex(11), hex(12)] }
    await announce('magnet:?xt=urn:btih:long', long)
    assert.notEqual(bobHandle.api.getManifest('magnet:?xt=urn:btih:ok'), null)
    assert.equal(bobHandle.api.getManifest('magnet:?xt=urn:btih:long'), null)
    assert.deepEqual(bobHandle.api.listKnownProviders(hex(10)), [], 'no provider recorded for a refused manifest')
  })

  it('maxManifestSize: an oversize declared size is ignored', async () => {
    const { announce, bobHandle } = await announcer({ maxManifestSize: 100 })
    await announce('magnet:?xt=urn:btih:big', manifestOf(1, { size: 4000, chunkSize: 2000 }))
    assert.equal(bobHandle.api.getManifest('magnet:?xt=urn:btih:big'), null)
  })

  it('requires 64-hex piece CIDs', async () => {
    const { announce, bobHandle } = await announcer()
    await announce('magnet:?xt=urn:btih:a', manifestOf(1, { chunkCids: ['not-a-cid', hex(1)] }))
    await announce('magnet:?xt=urn:btih:b', manifestOf(2, { chunkCids: [hex(10).toUpperCase(), hex(5)] }))
    assert.equal(bobHandle.api.getManifest('magnet:?xt=urn:btih:a'), null)
    assert.equal(bobHandle.api.getManifest('magnet:?xt=urn:btih:b'), null)
  })

  it('requires ceil(size / chunkSize) === chunkCids.length', async () => {
    const { announce, bobHandle } = await announcer()
    await announce('magnet:?xt=urn:btih:few', manifestOf(1, { size: 100 }))      // 25 pieces claimed, 2 listed
    await announce('magnet:?xt=urn:btih:many', manifestOf(2, { size: 1 }))       // 1 piece expected, 2 listed
    await announce('magnet:?xt=urn:btih:empty', manifestOf(3, { size: 0 }))      // 0 pieces expected, 2 listed
    await announce('magnet:?xt=urn:btih:odd', manifestOf(4, { size: 5 }))        // ceil(5/4) = 2: fine
    assert.equal(bobHandle.api.getManifest('magnet:?xt=urn:btih:few'), null)
    assert.equal(bobHandle.api.getManifest('magnet:?xt=urn:btih:many'), null)
    assert.equal(bobHandle.api.getManifest('magnet:?xt=urn:btih:empty'), null)
    assert.notEqual(bobHandle.api.getManifest('magnet:?xt=urn:btih:odd'), null)
  })

  it('without a declared chunkSize the count must still be plausible for the size', async () => {
    const { announce, bobHandle } = await announcer()
    const noSize = (n, extra) => { const m = manifestOf(n, extra); delete m.chunkSize; return m }
    await announce('magnet:?xt=urn:btih:ok', noSize(1))
    await announce('magnet:?xt=urn:btih:absurd', noSize(2, { size: 1 })) // 2 pieces cannot fit in 1 byte
    assert.notEqual(bobHandle.api.getManifest('magnet:?xt=urn:btih:ok'), null)
    assert.equal(bobHandle.api.getManifest('magnet:?xt=urn:btih:absurd'), null)
  })

  it('maxRemoteManifests: least recently used is forgotten, with providers only it had', async () => {
    const { announce, bobHandle } = await announcer({ maxRemoteManifests: 2 })
    await announce('magnet:?xt=urn:btih:m1', manifestOf(1))
    await announce('magnet:?xt=urn:btih:m2', manifestOf(2))
    assert.notEqual(bobHandle.api.getManifest('magnet:?xt=urn:btih:m1'), null) // touch m1: m2 is now the oldest
    await announce('magnet:?xt=urn:btih:m3', manifestOf(3))
    assert.notEqual(bobHandle.api.getManifest('magnet:?xt=urn:btih:m1'), null)
    assert.equal(bobHandle.api.getManifest('magnet:?xt=urn:btih:m2'), null, 'm2 was evicted')
    assert.notEqual(bobHandle.api.getManifest('magnet:?xt=urn:btih:m3'), null)
    assert.deepEqual(bobHandle.api.listKnownProviders(hex(4)), [], 'm2\'s provider entries are gone')
    assert.equal(bobHandle.api.listKnownProviders(hex(2)).length, 1, 'm1\'s are kept')
  })

  it('a piece shared by two remembered manifests keeps its provider until both are gone', async () => {
    const { announce, bobHandle } = await announcer({ maxRemoteManifests: 2 })
    const shared = hex(99)
    await announce('magnet:?xt=urn:btih:s1', manifestOf(1, { chunkCids: [shared, hex(2)] }))
    await announce('magnet:?xt=urn:btih:s2', manifestOf(2, { chunkCids: [shared, hex(5)] }))
    await announce('magnet:?xt=urn:btih:s3', manifestOf(3))      // evicts s1
    assert.equal(bobHandle.api.getManifest('magnet:?xt=urn:btih:s1'), null)
    assert.equal(bobHandle.api.listKnownProviders(shared).length, 1, 's2 still lists the shared piece')
  })

  it('a download in progress is not evicted by later announces', async () => {
    const aliceChunks = instrumentedStore(20)
    const { aliceHandle, bobHandle, alice, nodeA, bob } = await pair(
      { chunkStore: aliceChunks.store, maxConcurrentServesPerPeer: 0 },
      { maxRemoteManifests: 1 },
    )
    const info = await aliceHandle.api.seed(forty, { name: 'forty' })
    aliceChunks.stats.order.length = 0
    const pending = bobHandle.api.download(info.magnetURI, { peers: [alice.podId], concurrency: 1 })
    await waitFor(() => aliceChunks.stats.order.length >= 2, 2000, 'the download to start')
    for (let i = 0; i < 3; i++) {
      await nodeA.sendTo(bob.podId, { type: 'mesh-torrent', kind: 'announce', magnetURI: `magnet:?xt=urn:btih:other${i}`, manifest: manifestOf(20 + i) })
    }
    const { data } = await pending
    assert.deepEqual(data, forty)
  })

  it('manifest responses are held to the same bounds', async () => {
    const { aliceHandle, bobHandle, alice } = await pair({}, { maxManifestChunks: 3, manifestTimeoutMs: 300 })
    const info = await aliceHandle.api.seed(forty, { name: 'forty' }) // 10 pieces > 3
    await assert.rejects(
      () => bobHandle.api.download(info.magnetURI, { peers: [alice.podId] }),
      /no manifest known/,
    )
  })

  it('validates the new limit options', () => {
    for (const name of ['maxManifestChunks', 'maxManifestSize', 'maxRemoteManifests']) {
      assert.throws(() => createTorrentService({ [name]: -1 }), TypeError, name)
      assert.throws(() => createTorrentService({ [name]: 'x' }), TypeError, name)
    }
  })

  it('createMeshNode({ torrentOptions }) passes the new options through', async () => {
    const base = { label: 'solo', signalingTransport: { send() {}, onMessage() {} }, enableTorrent: true, skipBoot: true }
    // Out-of-range values reach createTorrentService()'s validation, so they were forwarded.
    for (const bad of [{ downloadConcurrency: 99 }, { maxManifestChunks: -1 }, { maxManifestSize: -1 }, { maxRemoteManifests: -1 }]) {
      await assert.rejects(() => createMeshNode({ ...base, torrentOptions: bad }), /must be/, JSON.stringify(bad))
    }
    // And an injected WebTorrent reaches the TorrentManager.
    class FakeWebTorrent { destroy(cb) { cb() } }
    const node = await createMeshNode({ ...base, torrentOptions: { webtorrent: FakeWebTorrent } })
    await node.torrent.api.ensureLoaded()
    assert.equal(node.torrent.api.available, true)
    await node.torrent.api.destroy()
  })
})

// ===========================================================================
// #217 -- injectable WebTorrent, no CDN import
// ===========================================================================

describe('TorrentManager: injectable WebTorrent, no CDN import (#217)', () => {
  /** Minimal WebTorrent stand-in: seed() calls back with a torrent. */
  function fakeWebTorrentClass(log) {
    return class FakeWebTorrent {
      constructor() { log.push('new') }
      seed(file, opts, cb) {
        log.push(['seed', file.name, file.size])
        const torrent = { magnetURI: `magnet:?xt=urn:btih:fake${file.size}`, infoHash: `fake${file.size}`, on() {} }
        queueMicrotask(() => cb(torrent))
        return torrent
      }
      remove(m) { log.push(['remove', m]) }
      destroy(cb) { log.push('destroy'); cb() }
    }
  }

  it('uses an injected WebTorrent constructor, and destroys the client it built', async () => {
    const log = []
    const tm = new TorrentManager({ webtorrent: fakeWebTorrentClass(log) })
    await tm.ensureLoaded()
    assert.equal(tm.available, true)
    const info = await tm.seed(new Uint8Array([1, 2, 3]), { name: 'f.bin' })
    assert.equal(info.magnetURI, 'magnet:?xt=urn:btih:fake3')
    assert.deepEqual(log, ['new', ['seed', 'f.bin', 3]])
    await tm.destroy()
    assert.ok(log.includes('destroy'))
  })

  it('uses an injected client instance as is, and leaves it running on destroy()', async () => {
    const log = []
    const Fake = fakeWebTorrentClass(log)
    const client = new Fake()
    log.length = 0
    const tm = new TorrentManager({ webtorrent: client })
    await tm.ensureLoaded()
    assert.equal(tm.available, true)
    await tm.seed(new Uint8Array([9]), { name: 'g' })
    await tm.destroy()
    assert.equal(log.includes('new'), false, 'no second client was built')
    assert.equal(log.includes('destroy'), false, 'the caller\'s client was not destroyed')
  })

  it('createTorrentService({ webtorrent }) hands it to its TorrentManager', async () => {
    const log = []
    const { aliceHandle } = await pair({ webtorrent: fakeWebTorrentClass(log) })
    await aliceHandle.api.ensureLoaded()
    assert.equal(aliceHandle.api.available, true)
    assert.deepEqual(log, ['new'])
  })

  it('without one it never reaches for the network: available stays false', async () => {
    const realFetch = globalThis.fetch
    let fetched = false
    globalThis.fetch = () => { fetched = true; throw new Error('network use') }
    try {
      const tm = new TorrentManager()
      await tm.ensureLoaded()
      assert.equal(tm.available, false)
      assert.equal(fetched, false)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('rejects something that is neither a constructor nor a client object', () => {
    for (const bad of [42, 'webtorrent', true]) {
      assert.throws(() => new TorrentManager({ webtorrent: bad }), /webtorrent must be/, String(bad))
    }
  })

  it('no source file in the package imports from a CDN or any URL', () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : [])
    const offenders = []
    for (const file of walk(srcDir)) {
      const text = readFileSync(file, 'utf8')
      if (/\bimport\s*\(\s*[`'"]https?:/.test(text)) offenders.push(`${file}: dynamic import of a URL`)
      if (/from\s+[`'"]https?:/.test(text)) offenders.push(`${file}: static import of a URL`)
      if (/esm\.sh|cdn\.jsdelivr|unpkg\.com|cdn\.skypack|esm\.run/.test(text)) offenders.push(`${file}: mentions a CDN host`)
    }
    assert.deepEqual(offenders, [])
  })
})
