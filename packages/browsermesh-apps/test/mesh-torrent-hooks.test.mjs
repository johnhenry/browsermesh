// Run with: node --import ./test/_setup-globals.mjs --test test/mesh-torrent-hooks.test.mjs
//
// Torrent service hooks (#199: injectable chunk/manifest stores, authorize,
// serve caps) and the string-seeding fix (#195), plus the agent tools that sit
// on top of TorrentManager / IPFSStore (#195, #196).
//
// Fixtures mirror peer-torrent.test.mjs: real Ed25519 identities and a
// duck-typed sendTo()/onIncomingData() bus restricted to explicit edges.
import 'fake-indexeddb/auto'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createMeshNode } from '../src/mesh-bootstrap.mjs'
import { TorrentManager } from '../src/peer-torrent.mjs'
import { createTorrentService } from '../src/mesh-torrent.mjs'
import { IPFSStore } from '../src/peer-ipfs.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
  TorrentSeedTool,
  IpfsStoreTool,
  IpfsRetrieveTool,
  peerToolsContext,
} from '@johnhenry/browsermesh-core'
import { ChunkStore, IndexedDBChunkStore } from '@johnhenry/browsermesh-sync'

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4' // first 40 hex chars of sha256('')

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

async function waitFor(fn, timeoutMs = 1000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

/** Two peers, alice <-> bob, alice running `aliceOpts`. */
async function pair(aliceOpts = {}, bobOpts = {}) {
  const alice = await createPeer('alice')
  const bob = await createPeer('bob')
  const mesh = wireMesh([alice, bob], [[alice.podId, bob.podId]])
  const nodeA = mesh[alice.podId]
  const nodeB = mesh[bob.podId]
  const aliceHandle = attachService(nodeA, undefined, createTorrentService({ chunkSize: 4, ...aliceOpts }))
  const bobHandle = attachService(nodeB, undefined, createTorrentService({ chunkSize: 4, ...bobOpts }))
  return { alice, bob, nodeA, nodeB, aliceHandle, bobHandle }
}

/** Collect every raw message `node` receives, with its sender. */
function recordInbox(node) {
  const inbox = []
  node.onIncomingData((from, msg) => inbox.push({ from, msg }))
  return inbox
}

let rawSeq = 0
/** Send a raw wire request from `node` to `to` and return the reply (waits for it). */
async function rawRequest(node, inbox, to, payload) {
  const requestId = `raw-${++rawSeq}`
  await node.sendTo(to, { type: 'mesh-torrent', requestId, ...payload })
  await waitFor(() => inbox.some((e) => e.msg.requestId === requestId), 1000, `reply to ${payload.kind}`)
  return inbox.find((e) => e.msg.requestId === requestId).msg
}

const strip = ({ requestId, ...rest }) => rest

/** A durable-shaped manifest store: a Map the test keeps alive across "restarts". */
function persistentManifestStore(backing = new Map()) {
  return {
    backing,
    async get(k) { return backing.get(k) },
    async set(k, v) { backing.set(k, structuredClone(v)) },
    async delete(k) { backing.delete(k) },
    async entries() { return [...backing.entries()] },
  }
}

/** Wrap a store so calls to the named methods are counted (all other members pass through). */
function spyOn(store, methods) {
  const calls = Object.fromEntries(methods.map((m) => [m, 0]))
  const proxy = new Proxy(store, {
    get(target, prop) {
      if (prop === 'calls') return calls
      const value = Reflect.get(target, prop, target)
      if (typeof value !== 'function') return value
      return (...args) => {
        if (prop in calls) calls[prop]++
        return value.apply(target, args)
      }
    },
  })
  return proxy
}

// ===========================================================================
// #195 -- string input, and the torrent_seed tool
// ===========================================================================

describe('TorrentManager.seed() input normalisation (#195)', () => {
  it('seeds a string as UTF-8 bytes: the infoHash is not the empty-content hash and the bytes round-trip', async () => {
    const tm = new TorrentManager()
    const info = await tm.seed('hello', { name: 'greeting' })

    assert.notEqual(info.infoHash, EMPTY_SHA256)
    assert.equal(info.infoHash, sha256Hex(Buffer.from('hello')).slice(0, 40))
    assert.equal(info.size, 5)

    const { data } = await tm.download(info.magnetURI)
    assert.equal(new TextDecoder().decode(data), 'hello')
  })

  it('counts multi-byte text in bytes, not characters', async () => {
    const tm = new TorrentManager()
    const info = await tm.seed('héllo ✓', { name: 'utf8' })
    assert.equal(info.size, Buffer.byteLength('héllo ✓'))
    const { data } = await tm.download(info.magnetURI)
    assert.equal(new TextDecoder().decode(data), 'héllo ✓')
  })

  it('accepts Blob, ArrayBuffer and other typed-array views, all yielding the same torrent as the equivalent Uint8Array', async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
    const reference = await new TorrentManager().seed(bytes, { name: 'ref' })

    const inputs = {
      blob: new Blob([bytes]),
      arrayBuffer: bytes.slice().buffer,
      dataView: new DataView(bytes.slice().buffer),
      int8: new Int8Array(bytes.slice().buffer),
      subarray: new Uint8Array([9, 9, ...bytes, 9]).subarray(2, 10),
    }
    for (const [label, input] of Object.entries(inputs)) {
      const info = await new TorrentManager().seed(input, { name: label })
      assert.equal(info.infoHash, reference.infoHash, label)
      assert.equal(info.size, 8, label)
    }
  })

  it('throws a TypeError for anything else instead of seeding empty content', async () => {
    const tm = new TorrentManager()
    for (const bad of [42, null, undefined, {}, [1, 2, 3], true, () => {}]) {
      await assert.rejects(() => tm.seed(bad, { name: 'bad' }), TypeError, String(bad))
    }
    assert.equal(tm.listTorrents().length, 0)
  })

  it('createTorrentService().api.seed() accepts a string too', async () => {
    const { aliceHandle, bobHandle, alice, bob } = await pair()
    const info = await aliceHandle.api.seed('hello world', { name: 'text' })
    assert.notEqual(info.infoHash, EMPTY_SHA256)
    aliceHandle.api.share(info.magnetURI, [bob.podId])
    const { data } = await bobHandle.api.download(info.magnetURI, { peers: [alice.podId] })
    assert.equal(new TextDecoder().decode(data), 'hello world')
  })
})

describe('torrent_seed tool against a real TorrentManager (#195)', () => {
  it('text input is actually seeded: non-empty infoHash, content downloadable', async () => {
    const tm = new TorrentManager()
    peerToolsContext.setTorrentManager(tm)
    try {
      const result = await new TorrentSeedTool().execute({ name: 'hi', data: 'hello' })
      assert.equal(result.success, true)
      const [info] = tm.listTorrents()
      assert.notEqual(info.infoHash, EMPTY_SHA256)
      assert.equal(info.size, 5)
      assert.ok(result.output.includes(info.magnetURI), result.output)
      const { data } = await tm.download(info.magnetURI)
      assert.equal(new TextDecoder().decode(data), 'hello')
    } finally {
      peerToolsContext.setTorrentManager(null)
    }
  })

  it('base64 input round-trips to the original bytes', async () => {
    const tm = new TorrentManager()
    peerToolsContext.setTorrentManager(tm)
    try {
      const original = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256)
      const result = await new TorrentSeedTool().execute({
        name: 'bin', data: Buffer.from(original).toString('base64'), encoding: 'base64',
      })
      assert.equal(result.success, true)
      const { data } = await tm.download(tm.listTorrents()[0].magnetURI)
      assert.deepEqual(data, original)
      assert.equal(tm.listTorrents()[0].infoHash, sha256Hex(original).slice(0, 40))
    } finally {
      peerToolsContext.setTorrentManager(null)
    }
  })
})

// ===========================================================================
// #196 -- ipfs_store / ipfs_retrieve against a real IPFSStore
// ===========================================================================

describe('ipfs_store / ipfs_retrieve against a real IPFSStore (#196)', () => {
  it('stores text and prints the CID, then reads the same text back', async () => {
    const store = new IPFSStore()
    peerToolsContext.setIpfsStore(store)
    try {
      const stored = await new IpfsStoreTool().execute({ data: 'hi there' })
      const cid = sha256Hex(Buffer.from('hi there'))
      assert.equal(stored.output, `Stored with CID: ${cid} (8 bytes)`)
      assert.ok(!stored.output.includes('[object Object]'))

      const got = await new IpfsRetrieveTool().execute({ cid })
      assert.equal(got.output, 'hi there')
    } finally {
      peerToolsContext.setIpfsStore(null)
    }
  })

  it('binary content round-trips through base64 in both directions', async () => {
    const store = new IPFSStore()
    peerToolsContext.setIpfsStore(store)
    try {
      const raw = Uint8Array.from([0xff, 0xfe, 0x00, 0x01, 0x80])
      const b64 = Buffer.from(raw).toString('base64')
      const stored = await new IpfsStoreTool().execute({ data: b64, encoding: 'base64' })
      const cid = sha256Hex(raw)
      assert.equal(stored.output, `Stored with CID: ${cid} (5 bytes)`)
      assert.deepEqual(await store.get(cid), raw)

      const got = await new IpfsRetrieveTool().execute({ cid })
      assert.equal(got.encoding, 'base64')
      assert.ok(got.output.endsWith(b64))
      assert.ok(!got.output.includes('"0"'))
    } finally {
      peerToolsContext.setIpfsStore(null)
    }
  })
})

// ===========================================================================
// #199 -- TorrentManager with injected stores
// ===========================================================================

describe('TorrentManager with chunkStore/manifestStore (#199)', () => {
  it('stores pieces and a manifest in the injected stores, not in a private blob map', async () => {
    const chunkStore = spyOn(new ChunkStore(), ['save', 'get'])
    const manifestStore = spyOn(persistentManifestStore(), ['set'])
    const tm = new TorrentManager({ chunkStore, manifestStore, chunkSize: 4 })

    const info = await tm.seed(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]), { name: 'x' })

    assert.equal(chunkStore.calls.save, 3) // 9 bytes / 4-byte pieces
    assert.equal(manifestStore.calls.set, 1)
    const manifest = await tm.getManifest(info.magnetURI)
    assert.equal(manifest.chunkCids.length, 3)
    assert.equal(manifest.size, 9)

    const { data } = await tm.download(info.magnetURI)
    assert.deepEqual(data, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]))
    assert.ok(chunkStore.calls.get >= 3)
  })

  it('a new manager over the same stores lists and serves what the old one seeded', async () => {
    const chunkStore = new ChunkStore()
    const manifestStore = persistentManifestStore()
    const first = new TorrentManager({ chunkStore, manifestStore, chunkSize: 4 })
    const info = await first.seed('persist me', { name: 'p' })
    await first.destroy()

    const second = new TorrentManager({ chunkStore, manifestStore, chunkSize: 4 })
    assert.equal(second.listTorrents().length, 0) // nothing until it loads
    await second.ensureLoaded()
    assert.deepEqual(second.listTorrents().map((t) => [t.magnetURI, t.name, t.size]), [[info.magnetURI, 'p', 10]])

    const { data } = await second.download(info.magnetURI)
    assert.equal(new TextDecoder().decode(data), 'persist me')
  })

  it('destroy() leaves injected stores intact', async () => {
    const chunkStore = new ChunkStore()
    const manifestStore = persistentManifestStore()
    const tm = new TorrentManager({ chunkStore, manifestStore, chunkSize: 4 })
    await tm.seed('keep', { name: 'k' })
    await tm.destroy()
    assert.ok(chunkStore.size > 0)
    assert.equal(manifestStore.backing.size, 1)
  })

  it('removeTorrent() releases pieces no other torrent uses and keeps shared ones', async () => {
    const chunkStore = new ChunkStore()
    const manifestStore = persistentManifestStore()
    const tm = new TorrentManager({ chunkStore, manifestStore, chunkSize: 4 })
    // Both torrents start with the piece "AAAA"; only the second part differs.
    const a = await tm.seed('AAAABBBB', { name: 'a' })
    const b = await tm.seed('AAAACCCC', { name: 'b' })
    assert.equal(chunkStore.size, 3)

    assert.equal(tm.removeTorrent(a.magnetURI), true)
    await tm.destroy() // waits for the background cleanup
    assert.equal(chunkStore.size, 2) // BBBB gone, AAAA kept for b
    assert.equal(manifestStore.backing.has(a.magnetURI), false)
    assert.equal(manifestStore.backing.has(b.magnetURI), true)
  })

  it('download() reports a missing piece instead of returning short content', async () => {
    const chunkStore = new ChunkStore()
    const tm = new TorrentManager({ chunkStore, chunkSize: 4 })
    const info = await tm.seed('12345678', { name: 'm' })
    const [firstCid] = (await tm.getManifest(info.magnetURI)).chunkCids
    chunkStore.remove(firstCid)
    await assert.rejects(() => tm.download(info.magnetURI), /missing from the chunk store/)
  })

  it('without injected stores nothing changes: getManifest() is null and contents stay private', async () => {
    const tm = new TorrentManager()
    const info = await tm.seed('plain', { name: 'p' })
    assert.equal(await tm.getManifest(info.magnetURI), null)
  })
})

// ===========================================================================
// #199 -- createTorrentService: injected stores
// ===========================================================================

describe('createTorrentService: injected chunkStore / manifestStore', () => {
  it('uses the injected stores (spy) for seeding, serving and downloading', async () => {
    const aliceChunks = spyOn(new ChunkStore(), ['save', 'get', 'has'])
    const aliceManifests = spyOn(persistentManifestStore(), ['set', 'entries'])
    const bobChunks = spyOn(new ChunkStore(), ['save', 'get'])
    const { aliceHandle, bobHandle, alice, bob } = await pair(
      { chunkStore: aliceChunks, manifestStore: aliceManifests },
      { chunkStore: bobChunks },
    )

    const original = Uint8Array.from({ length: 10 }, (_, i) => i + 1)
    const info = await aliceHandle.api.seed(original, { name: 'o' })
    assert.equal(aliceChunks.calls.save, 3)
    assert.ok(aliceManifests.calls.set >= 1)
    assert.ok(aliceManifests.calls.entries >= 1, 'manifests are loaded from the store on attach')

    aliceHandle.api.share(info.magnetURI, [bob.podId])
    const { data } = await bobHandle.api.download(info.magnetURI, { peers: [alice.podId] })
    assert.deepEqual(data, original)
    assert.ok(aliceChunks.calls.get >= 3, 'alice served pieces out of her injected store')
    assert.equal(bobChunks.calls.save >= 3, true, 'bob stored fetched pieces in his injected store')
  })

  it('a seeder restarted over the same stores keeps serving', async () => {
    const chunkStore = new ChunkStore()
    const manifestStore = persistentManifestStore()
    const bob = await createPeer('bob')

    const alice1 = await createPeer('alice')
    const mesh1 = wireMesh([alice1, bob], [[alice1.podId, bob.podId]])
    const first = attachService(mesh1[alice1.podId], undefined, createTorrentService({ chunkSize: 4, chunkStore, manifestStore }))
    const info = await first.api.seed('still here after reload', { name: 'r' })
    await first.api.flush()
    await first.teardown()

    // "Reload": a fresh node and service, same stores. Nothing is re-seeded.
    const alice2 = await createPeer('alice-again')
    const mesh2 = wireMesh([alice2, bob], [[alice2.podId, bob.podId]])
    const second = attachService(mesh2[alice2.podId], undefined, createTorrentService({ chunkSize: 4, chunkStore, manifestStore }))
    const bobService = attachService(mesh2[bob.podId], undefined, createTorrentService({ chunkSize: 4 }))

    await second.api.ensureLoaded()
    assert.deepEqual(second.api.listTorrents().map((t) => t.magnetURI), [info.magnetURI])

    const { data } = await bobService.api.download(info.magnetURI, { peers: [alice2.podId] })
    assert.equal(new TextDecoder().decode(data), 'still here after reload')
  })

  it('without a manifestStore a restarted seeder serves nothing, even if the chunkStore survived (the manifest is the index)', async () => {
    const chunkStore = new ChunkStore()
    const alice1 = await createPeer('alice')
    const bob = await createPeer('bob')
    const mesh1 = wireMesh([alice1, bob], [[alice1.podId, bob.podId]])
    const first = attachService(mesh1[alice1.podId], undefined, createTorrentService({ chunkSize: 4, chunkStore }))
    const info = await first.api.seed('indexed', { name: 'i' })
    const cids = first.api.getManifest(info.magnetURI).chunkCids
    await first.teardown()

    const alice2 = await createPeer('alice2')
    const mesh2 = wireMesh([alice2, bob], [[alice2.podId, bob.podId]])
    attachService(mesh2[alice2.podId], undefined, createTorrentService({ chunkSize: 4, chunkStore }))
    const inbox = recordInbox(mesh2[bob.podId])
    const reply = await rawRequest(mesh2[bob.podId], inbox, alice2.podId, { kind: 'chunk-request', cid: cids[0] })
    assert.equal(reply.error, 'not-found')
  })

  it('destroy() clears a store the service created, but never one that was injected', async () => {
    const injected = new ChunkStore()
    const injectedManifests = persistentManifestStore()
    const kept = await pair({ chunkStore: injected, manifestStore: injectedManifests })
    await kept.aliceHandle.api.seed('abcdefgh', { name: 'k' })
    await kept.aliceHandle.api.destroy()
    assert.ok(injected.size > 0)
    assert.equal(injectedManifests.backing.size, 1)

    const own = await pair()
    const info = await own.aliceHandle.api.seed('abcdefgh', { name: 'o' })
    await own.aliceHandle.api.destroy()
    assert.equal(own.aliceHandle.api.getManifest(info.magnetURI), null)
  })

  it('only serves pieces a held manifest lists: unrelated chunks in a shared store are unreachable', async () => {
    const chunkStore = new ChunkStore()
    const stray = new TextEncoder().encode('secret')
    const strayCid = await ChunkStore.computeCid(stray)
    chunkStore.save(strayCid, stray)

    const { nodeB, alice } = await pair({ chunkStore })
    const inbox = recordInbox(nodeB)
    const reply = await rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid: strayCid })
    assert.equal(reply.error, 'not-found')
    assert.equal(reply.data, undefined)
  })

  it('removeTorrent() stops serving immediately and releases unshared pieces', async () => {
    const chunkStore = new ChunkStore()
    const manifestStore = persistentManifestStore()
    const { aliceHandle, nodeB, alice } = await pair({ chunkStore, manifestStore })
    const info = await aliceHandle.api.seed('12345678', { name: 'gone' })
    const cids = aliceHandle.api.getManifest(info.magnetURI).chunkCids

    assert.equal(aliceHandle.api.removeTorrent(info.magnetURI), true)
    const inbox = recordInbox(nodeB)
    const reply = await rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid: cids[0] })
    assert.equal(reply.error, 'not-found')

    await aliceHandle.api.flush()
    assert.equal(chunkStore.size, 0)
    assert.equal(manifestStore.backing.size, 0)
  })
})

describe('createTorrentService + IndexedDBChunkStore (browsermesh-sync) as the durable store', () => {
  it('runs a full swarm download with IndexedDBChunkStore on both sides', async () => {
    const { aliceHandle, bobHandle, alice, bob } = await pair(
      { chunkStore: new IndexedDBChunkStore({ dbName: 'torrent-fit-alice' }), manifestStore: persistentManifestStore() },
      { chunkStore: new IndexedDBChunkStore({ dbName: 'torrent-fit-bob' }), manifestStore: persistentManifestStore() },
    )
    const original = Uint8Array.from({ length: 23 }, (_, i) => (i * 11) % 256)
    const info = await aliceHandle.api.seed(original, { name: 'idb.bin' })
    aliceHandle.api.share(info.magnetURI, [bob.podId])
    const { data } = await bobHandle.api.download(info.magnetURI, { peers: [alice.podId] })
    assert.deepEqual(data, original)
  })

  it('a reopened IndexedDBChunkStore (new instance, same database) still serves after a restart', async () => {
    const dbName = 'torrent-fit-restart'
    const manifestStore = persistentManifestStore()
    const bob = await createPeer('bob')

    const alice1 = await createPeer('alice')
    const mesh1 = wireMesh([alice1, bob], [[alice1.podId, bob.podId]])
    const store1 = new IndexedDBChunkStore({ dbName })
    const first = attachService(mesh1[alice1.podId], undefined, createTorrentService({ chunkSize: 4, chunkStore: store1, manifestStore }))
    const info = await first.api.seed('durable bytes', { name: 'd' })
    await first.api.flush()
    await first.teardown()
    store1.close()

    const alice2 = await createPeer('alice2')
    const mesh2 = wireMesh([alice2, bob], [[alice2.podId, bob.podId]])
    const store2 = new IndexedDBChunkStore({ dbName })
    attachService(mesh2[alice2.podId], undefined, createTorrentService({ chunkSize: 4, chunkStore: store2, manifestStore }))
    const bobService = attachService(mesh2[bob.podId], undefined, createTorrentService({ chunkSize: 4 }))

    const { data } = await bobService.api.download(info.magnetURI, { peers: [alice2.podId] })
    assert.equal(new TextDecoder().decode(data), 'durable bytes')
  })

  it('rejects objects that do not implement the chunk store contract', () => {
    assert.throws(() => createTorrentService({ chunkStore: { get() {} } }), /chunkStore must implement save/)
    assert.throws(() => createTorrentService({ manifestStore: { get() {} } }), /manifestStore must implement set/)
  })
})

// ===========================================================================
// #199 -- authorize
// ===========================================================================

describe('createTorrentService: authorize', () => {
  async function seeded(authorize) {
    const ctxs = await pair({ authorize })
    const content = new TextEncoder().encode('0123456789ab') // three 4-byte pieces
    const info = await ctxs.aliceHandle.api.seed(content, { name: 'secret.txt' })
    const manifest = ctxs.aliceHandle.api.getManifest(info.magnetURI)
    return { ...ctxs, info, manifest, content, inbox: recordInbox(ctxs.nodeB) }
  }

  it('a denied chunk-request is answered exactly like a request for unknown content', async () => {
    const { nodeB, alice, manifest, inbox } = await seeded(() => false)
    const unknownCid = sha256Hex(Buffer.from('never seeded'))

    const denied = await rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid: manifest.chunkCids[0] })
    const unknown = await rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid: unknownCid })

    assert.deepEqual(strip(denied), { type: 'mesh-torrent', kind: 'chunk-response', cid: manifest.chunkCids[0], error: 'not-found' })
    assert.deepEqual(strip(unknown), { type: 'mesh-torrent', kind: 'chunk-response', cid: unknownCid, error: 'not-found' })
    assert.deepEqual(Object.keys(denied).sort(), Object.keys(unknown).sort())
  })

  it('a denied manifest-request is answered exactly like one for an unknown magnet', async () => {
    const { nodeB, alice, info, inbox } = await seeded(() => false)
    const unknownMagnet = 'magnet:?xt=urn:btih:' + '0'.repeat(40)

    const denied = await rawRequest(nodeB, inbox, alice.podId, { kind: 'manifest-request', magnetURI: info.magnetURI })
    const unknown = await rawRequest(nodeB, inbox, alice.podId, { kind: 'manifest-request', magnetURI: unknownMagnet })

    assert.equal(denied.manifest, null)
    assert.deepEqual(strip(denied), { type: 'mesh-torrent', kind: 'manifest-response', magnetURI: info.magnetURI, manifest: null })
    assert.deepEqual(strip({ ...unknown, magnetURI: info.magnetURI }), strip(denied))
  })

  it('a download fails when authorize denies, and nothing about the content leaks into the error', async () => {
    const { bobHandle, alice, info } = await seeded(() => false)
    await assert.rejects(
      () => bobHandle.api.download(info.magnetURI, { peers: [alice.podId] }),
      (err) => !/secret\.txt/.test(err.message),
    )
  })

  it('serves manifests and pieces when authorize allows, passing the requester and the content identity', async () => {
    const seen = []
    const { bobHandle, alice, bob, info, content } = await seeded((from, req) => { seen.push({ from, req }); return true })
    const { data } = await bobHandle.api.download(info.magnetURI, { peers: [alice.podId] })
    assert.deepEqual(data, content)

    const manifestCall = seen.find((s) => s.req.kind === 'manifest')
    assert.equal(manifestCall.from, bob.podId)
    assert.equal(manifestCall.req.magnetURI, info.magnetURI)
    assert.equal(manifestCall.req.infoHash, info.infoHash)
    assert.equal(manifestCall.req.cid, sha256Hex(content))

    const chunkCalls = seen.filter((s) => s.req.kind === 'chunk')
    assert.equal(chunkCalls.length, 3)
    assert.ok(chunkCalls.every((c) => c.req.magnetURI === info.magnetURI && c.req.cid === sha256Hex(content)))
    assert.deepEqual(chunkCalls.map((c) => c.req.chunkCid).sort(), [...bobHandle.api.getManifest(info.magnetURI).chunkCids].sort())
  })

  it('supports an async authorize, and can gate per requester', async () => {
    let allowedRequester = null
    const { aliceHandle, bobHandle, alice, bob } = await pair({
      authorize: async (from) => { await new Promise((r) => setTimeout(r, 2)); return from === allowedRequester },
    })
    const info = await aliceHandle.api.seed('abcdefgh', { name: 'a' })

    await assert.rejects(() => bobHandle.api.download(info.magnetURI, { peers: [alice.podId] }))
    allowedRequester = bob.podId
    const { data } = await bobHandle.api.download(info.magnetURI, { peers: [alice.podId] })
    assert.equal(new TextDecoder().decode(data), 'abcdefgh')
  })

  it('treats a throwing or non-boolean authorize as a denial', async () => {
    for (const authorize of [() => { throw new Error('boom') }, async () => { throw new Error('boom') }, () => 'yes', () => 1, () => undefined]) {
      const { nodeB, alice, manifest, inbox } = await seeded(authorize)
      const reply = await rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid: manifest.chunkCids[0] })
      assert.equal(reply.error, 'not-found', String(authorize))
    }
  })

  it('a piece shared by two torrents is served if any of them allows it', async () => {
    const allowedMagnets = new Set()
    const { aliceHandle, nodeB, alice } = await pair({ authorize: (_from, req) => allowedMagnets.has(req.magnetURI) })
    const a = await aliceHandle.api.seed('AAAABBBB', { name: 'a' })
    const b = await aliceHandle.api.seed('AAAACCCC', { name: 'b' })
    const sharedCid = aliceHandle.api.getManifest(a.magnetURI).chunkCids[0]
    assert.equal(sharedCid, aliceHandle.api.getManifest(b.magnetURI).chunkCids[0])
    const inbox = recordInbox(nodeB)

    assert.equal((await rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid: sharedCid })).error, 'not-found')
    allowedMagnets.add(b.magnetURI)
    assert.equal(typeof (await rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid: sharedCid })).data, 'string')
  })

  it('emits torrent:request-denied locally when it refuses content it holds, but not for unknown content', async () => {
    const { aliceHandle, nodeB, alice, manifest, inbox } = await seeded(() => false)
    const denials = []
    aliceHandle.on('torrent:request-denied', (e) => denials.push(e))
    await rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid: manifest.chunkCids[0] })
    await rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid: sha256Hex(Buffer.from('nope')) })
    assert.equal(denials.length, 1)
    assert.equal(denials[0].kind, 'chunk')
  })

  it('rejects a non-function authorize at construction', () => {
    assert.throws(() => createTorrentService({ authorize: true }), TypeError)
  })

  it('without authorize it stays open (previous behaviour)', async () => {
    const { bobHandle, alice, info, content } = await seeded(undefined)
    const { data } = await bobHandle.api.download(info.magnetURI, { peers: [alice.podId] })
    assert.deepEqual(data, content)
  })
})

describe('createTorrentService: manifest lookup across several peers', () => {
  it('keeps waiting past a peer that answers "don\'t have it" until one holder answers', async () => {
    const alice = await createPeer('alice') // holds the content
    const bob = await createPeer('bob') // downloader
    const carol = await createPeer('carol') // knows nothing
    const mesh = wireMesh([alice, bob, carol], [[alice.podId, bob.podId], [bob.podId, carol.podId]])
    const aliceSvc = attachService(mesh[alice.podId], undefined, createTorrentService({ chunkSize: 4 }))
    const bobSvc = attachService(mesh[bob.podId], undefined, createTorrentService({ chunkSize: 4 }))
    attachService(mesh[carol.podId], undefined, createTorrentService({ chunkSize: 4 }))

    const info = await aliceSvc.api.seed('find me quickly', { name: 'f' })
    // carol is asked first and replies null at once; alice's manifest must still win.
    const { data } = await bobSvc.api.download(info.magnetURI, { peers: [carol.podId, alice.podId] })
    assert.equal(new TextDecoder().decode(data), 'find me quickly')
  })

  it('gives up promptly when every asked peer says no, rather than waiting out manifestTimeoutMs', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const mesh = wireMesh([alice, bob], [[alice.podId, bob.podId]])
    attachService(mesh[alice.podId], undefined, createTorrentService())
    const bobSvc = attachService(mesh[bob.podId], undefined, createTorrentService({ manifestTimeoutMs: 30000 }))

    const started = Date.now()
    await assert.rejects(
      () => bobSvc.api.download('magnet:?xt=urn:btih:' + 'a'.repeat(40), { peers: [alice.podId] }),
      /no manifest known/,
    )
    assert.ok(Date.now() - started < 2000)
  })
})

// ===========================================================================
// #199 -- serve caps
// ===========================================================================

/** A chunk store whose get() can be held open, to keep serves "in flight". */
function gatedChunkStore() {
  const inner = new ChunkStore()
  const waiting = []
  let gated = false
  return {
    inner,
    hold() { gated = true },
    release() { gated = false; for (const r of waiting.splice(0)) r() },
    get inFlight() { return waiting.length },
    save: (c, b) => inner.save(c, b),
    has: (c) => inner.has(c),
    remove: (c) => inner.remove(c),
    get size() { return inner.size },
    async get(cid) {
      if (gated) await new Promise((r) => waiting.push(r))
      return inner.get(cid)
    },
  }
}

describe('createTorrentService: serve caps', () => {
  it('maxConcurrentServesPerPeer: a peer over its cap is told "busy" for any piece, known or not', async () => {
    const store = gatedChunkStore()
    const { aliceHandle, nodeB, alice } = await pair({ chunkStore: store, maxConcurrentServesPerPeer: 1 })
    const info = await aliceHandle.api.seed('0123456789ab', { name: 'c' })
    const [c0, c1] = aliceHandle.api.getManifest(info.magnetURI).chunkCids
    const inbox = recordInbox(nodeB)

    store.hold()
    const first = rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid: c0 })
    await waitFor(() => store.inFlight === 1, 1000, 'first serve to be in flight')

    const known = await rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid: c1 })
    const unknown = await rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid: sha256Hex(Buffer.from('zzz')) })
    assert.equal(known.error, 'busy')
    assert.equal(unknown.error, 'busy') // the cap says nothing about what exists

    store.release()
    assert.equal(typeof (await first).data, 'string')
    // capacity is back
    assert.equal(typeof (await rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid: c1 })).data, 'string')
  })

  it('maxConcurrentServes caps across peers', async () => {
    const store = gatedChunkStore()
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const carol = await createPeer('carol')
    const mesh = wireMesh([alice, bob, carol], [[alice.podId, bob.podId], [alice.podId, carol.podId]])
    const aliceSvc = attachService(mesh[alice.podId], undefined, createTorrentService({ chunkSize: 4, chunkStore: store, maxConcurrentServes: 1, maxConcurrentServesPerPeer: 4 }))
    const info = await aliceSvc.api.seed('0123456789ab', { name: 'c' })
    const [c0, c1] = aliceSvc.api.getManifest(info.magnetURI).chunkCids
    const bobInbox = recordInbox(mesh[bob.podId])
    const carolInbox = recordInbox(mesh[carol.podId])

    store.hold()
    const first = rawRequest(mesh[bob.podId], bobInbox, alice.podId, { kind: 'chunk-request', cid: c0 })
    await waitFor(() => store.inFlight === 1, 1000, 'first serve to be in flight')
    const second = await rawRequest(mesh[carol.podId], carolInbox, alice.podId, { kind: 'chunk-request', cid: c1 })
    assert.equal(second.error, 'busy')
    store.release()
    assert.equal(typeof (await first).data, 'string')
  })

  it('a downloader retries a busy provider after backing off, and the download completes', async () => {
    const store = gatedChunkStore()
    const sleeps = []
    const { aliceHandle, bobHandle, nodeB, alice, bob } = await pair(
      { chunkStore: store, maxConcurrentServesPerPeer: 1 },
      { busyBackoffMs: 7, sleep: async (ms) => { sleeps.push(ms); store.release(); await new Promise((r) => setTimeout(r, 25)) } },
    )
    const info = await aliceHandle.api.seed('abcd', { name: 'one-piece' })
    const [cid] = aliceHandle.api.getManifest(info.magnetURI).chunkCids
    aliceHandle.api.share(info.magnetURI, [bob.podId])
    await waitFor(() => bobHandle.api.getManifest(info.magnetURI) !== null, 1000, 'announce')

    // Occupy bob's single slot with a raw request that is held open.
    store.hold()
    const inbox = recordInbox(nodeB)
    const occupying = rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid })
    await waitFor(() => store.inFlight === 1, 1000, 'slot to be occupied')

    const { data } = await bobHandle.api.download(info.magnetURI, { peers: [alice.podId] })
    await occupying
    assert.equal(new TextDecoder().decode(data), 'abcd')
    assert.deepEqual(sleeps, [7]) // exactly one backoff, then success
  })

  it('maxBytesPerPeerPerSec makes serves wait for budget (injected clock)', async () => {
    let t = 1000
    const sleeps = []
    const { aliceHandle, nodeB, alice } = await pair({
      maxBytesPerPeerPerSec: 4,
      now: () => t,
      sleep: async (ms) => { sleeps.push(ms); t += ms },
    })
    const info = await aliceHandle.api.seed('0123456789ab', { name: 'slow' }) // 3 x 4-byte pieces
    const cids = aliceHandle.api.getManifest(info.magnetURI).chunkCids
    const inbox = recordInbox(nodeB)

    for (const cid of cids) {
      assert.equal(typeof (await rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid })).data, 'string')
    }
    // The first piece spends the one-second burst; each later piece waits one second for budget.
    assert.deepEqual(sleeps, [1000, 1000])
  })

  it('maxAnnouncesPerPeerPerMinute drops announces past the cap and recovers after a minute', async () => {
    let t = 0
    const { aliceHandle, nodeB, alice } = await pair({ maxAnnouncesPerPeerPerMinute: 2, now: () => t })
    const announced = []
    aliceHandle.on('torrent:announce-received', (e) => announced.push(e.magnetURI))
    const announce = async (n) => {
      await nodeB.sendTo(alice.podId, { type: 'mesh-torrent', kind: 'announce', magnetURI: `magnet:?xt=urn:btih:${n}` })
      await new Promise((r) => setTimeout(r, 5))
    }

    await announce('a'); await announce('b'); await announce('c')
    assert.deepEqual(announced, ['magnet:?xt=urn:btih:a', 'magnet:?xt=urn:btih:b'])

    t += 61_000
    await announce('d')
    assert.equal(announced.length, 3)
  })

  it('rejects nonsense limits and treats 0 as unlimited', async () => {
    assert.throws(() => createTorrentService({ maxConcurrentServes: -1 }), /maxConcurrentServes/)
    assert.throws(() => createTorrentService({ maxBytesPerPeerPerSec: 'fast' }), /maxBytesPerPeerPerSec/)

    const { aliceHandle, nodeB, alice } = await pair({ maxConcurrentServes: 0, maxConcurrentServesPerPeer: 0, maxAnnouncesPerPeerPerMinute: 0 })
    const info = await aliceHandle.api.seed('abcdefgh', { name: 'u' })
    const cid = aliceHandle.api.getManifest(info.magnetURI).chunkCids[0]
    const inbox = recordInbox(nodeB)
    const replies = await Promise.all([1, 2, 3, 4, 5, 6].map(() => rawRequest(nodeB, inbox, alice.podId, { kind: 'chunk-request', cid })))
    assert.ok(replies.every((r) => typeof r.data === 'string'))
  })
})

describe('createTorrentService: events', () => {
  it('still emits torrent:chunk-served and torrent:chunk-received with the existing payloads', async () => {
    const { aliceHandle, bobHandle, alice, bob } = await pair()
    const served = []
    const received = []
    aliceHandle.on('torrent:chunk-served', (e) => served.push(e))
    bobHandle.on('torrent:chunk-received', (e) => received.push(e))
    const info = await aliceHandle.api.seed('12345678', { name: 'e' })
    aliceHandle.api.share(info.magnetURI, [bob.podId])
    await bobHandle.api.download(info.magnetURI, { peers: [alice.podId] })
    assert.equal(served.length, 2)
    assert.equal(received.length, 2)
    assert.deepEqual(Object.keys(served[0]).sort(), ['cid', 'size', 'to'])
    assert.deepEqual(Object.keys(received[0]).sort(), ['cid', 'from', 'size'])
  })
})

describe('createMeshNode({ enableTorrent: true, torrentOptions }) forwards the hooks', () => {
  it('passes chunkStore and manifestStore through to createTorrentService()', async () => {
    const chunkStore = spyOn(new ChunkStore(), ['save'])
    const manifestStore = spyOn(persistentManifestStore(), ['set'])
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: { send() {}, onMessage() {} },
      enableTorrent: true,
      torrentOptions: { chunkStore, manifestStore, chunkSize: 4 },
      skipBoot: true,
    })
    await node.torrent.api.seed('12345678', { name: 'x' })
    assert.equal(chunkStore.calls.save, 2)
    assert.ok(manifestStore.calls.set >= 1)
  })
})
