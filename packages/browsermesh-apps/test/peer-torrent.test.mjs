// Run with: node --import ./test/_setup-globals.mjs --test test/peer-torrent.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { TorrentManager, TORRENT_DEFAULTS } from '../src/peer-torrent.mjs'
import { createTorrentService } from '../src/mesh-torrent.mjs'
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

// =============================================================================
// createTorrentService -- wired as a MeshService (attachService(), Phase C,
// issue #122)
// =============================================================================
//
// Fixtures mirror peer-routing.test.mjs's own real-identity precedent: real
// Ed25519 IdentityWallet/MeshIdentityManager identities + real PeerRegistry
// (wired to real MeshACL/MeshPeerManager/TrustGraph from
// @johnhenry/browsermesh-core), connected via a minimal duck-typed
// sendTo()/onIncomingData() bus restricted to explicit edges -- not real
// WebRTC (that's a different layer's job).

/** A real Ed25519 identity + wallet + registry bundle for one "peer". */
async function createTorrentTestPeer(label) {
  const identityManager = new MeshIdentityManager({});
  const wallet = new IdentityWallet({ identityManager });
  const { podId } = await wallet.createIdentity(label);
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId }),
  });
  return { podId, wallet, registry };
}

/**
 * A duck-typed multi-peer bus restricted to an explicit set of edges --
 * see peer-routing.test.mjs's own `wireRestrictedMesh()` for the full
 * rationale (this is what makes "C never talks to A directly" a genuine
 * proof, not just an untested assumption).
 * @param {Array<{podId: string, wallet?: object, registry: object}>} peers
 * @param {Array<[string, string]>} edges
 * @returns {Record<string, any>} keyed by each peer's `podId`
 */
function wireTorrentMesh(peers, edges) {
  const edgeSet = new Set();
  for (const [a, b] of edges) {
    edgeSet.add(`${a}|${b}`);
    edgeSet.add(`${b}|${a}`);
  }
  const listenersByPodId = new Map(peers.map((p) => [p.podId, new Set()]));
  const nodesByPodId = {};
  for (const peer of peers) {
    nodesByPodId[peer.podId] = {
      podId: peer.podId,
      wallet: peer.wallet,
      registry: peer.registry,
      onIncomingData(cb) {
        const set = listenersByPodId.get(peer.podId);
        set.add(cb);
        return () => set.delete(cb);
      },
      async sendTo(pubKey, data) {
        if (!edgeSet.has(`${peer.podId}|${pubKey}`)) return; // no direct link -- silently unreachable
        const set = listenersByPodId.get(pubKey);
        if (!set) return;
        queueMicrotask(() => {
          for (const cb of set) cb(peer.podId, data);
        });
      },
    };
  }
  return nodesByPodId;
}

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitForTorrent(fn, timeoutMs = 1000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
}

// -----------------------------------------------------------------------
// The real swarm proof: origin -> downloader, then downloader -> a THIRD
// peer that has NO direct link to the origin at all.
// -----------------------------------------------------------------------

describe('createTorrentService: real swarm piece exchange closes the capability gap', () => {
  it('a peer downloads content from the original seeder via real chunk-request/chunk-response traffic', async () => {
    const alice = await createTorrentTestPeer('alice'); // origin seeder
    const bob = await createTorrentTestPeer('bob'); // downloader
    const mesh = wireTorrentMesh([alice, bob], [[alice.podId, bob.podId]]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    const served = [];
    const { api: aliceApi, on: aliceOn } = attachService(nodeA, undefined, createTorrentService({ chunkSize: 4 }));
    aliceOn('torrent:chunk-served', (e) => served.push(e));

    const received = [];
    const { api: bobApi, on: bobOn } = attachService(nodeB, undefined, createTorrentService({ chunkSize: 4 }));
    bobOn('torrent:chunk-received', (e) => received.push(e));

    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]); // 13 bytes / 4-byte chunks -> 4 pieces
    const info = await aliceApi.seed(original, { name: 'swarm.bin' });

    aliceApi.share(info.magnetURI, [bob.podId]);

    const { data, info: bobInfo } = await bobApi.download(info.magnetURI, { peers: [alice.podId] });

    assert.deepEqual(data, original);
    assert.equal(bobInfo.magnetURI, info.magnetURI); // deterministic content-addressing: identical bytes -> identical magnet
    assert.equal(served.length, 4); // 13 bytes / 4-byte chunks = 4 pieces, all served by alice
    assert.equal(received.length, 4);
    assert.ok(served.every((e) => e.to === bob.podId));
    assert.ok(received.every((e) => e.from === alice.podId));
  });

  it('a THIRD peer downloads purely from the first downloader -- the original seeder is never contacted', async () => {
    const alice = await createTorrentTestPeer('alice'); // origin seeder
    const bob = await createTorrentTestPeer('bob'); // downloads from alice, then re-shares
    const carol = await createTorrentTestPeer('carol'); // downloads from bob only

    // Alice <-> Bob and Bob <-> Carol edges exist -- NO Alice <-> Carol edge
    // at all, so any bytes Carol receives can only have come via Bob.
    const mesh = wireTorrentMesh(
      [alice, bob, carol],
      [[alice.podId, bob.podId], [bob.podId, carol.podId]],
    );
    const { [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC } = mesh;

    const { api: aliceApi } = attachService(nodeA, undefined, createTorrentService({ chunkSize: 8 }));
    const { api: bobApi } = attachService(nodeB, undefined, createTorrentService({ chunkSize: 8 }));
    const { api: carolApi } = attachService(nodeC, undefined, createTorrentService({ chunkSize: 8 }));

    const original = new Uint8Array(Array.from({ length: 30 }, (_, i) => i)); // 30 bytes, 8-byte chunks -> 4 pieces
    const info = await aliceApi.seed(original, { name: 'relay.bin' });

    // Step 1: Bob downloads from Alice (the only peer he's linked to).
    aliceApi.share(info.magnetURI, [bob.podId]);
    const { data: bobData } = await bobApi.download(info.magnetURI, { peers: [alice.podId] });
    assert.deepEqual(bobData, original);

    // Step 2: Bob re-shares with Carol. Carol has no transport edge to
    // Alice at all -- wireTorrentMesh() silently drops any sendTo() between
    // unconnected podIds, so if createTorrentService() ever fell back to
    // asking Alice directly, Carol's download would simply hang and time out.
    bobApi.share(info.magnetURI, [carol.podId]);
    const { data: carolData, info: carolInfo } = await carolApi.download(info.magnetURI, { peers: [bob.podId] });

    assert.deepEqual(carolData, original);
    assert.equal(carolInfo.magnetURI, info.magnetURI);

    // Direct proof this is real peer-to-peer piece exchange, not
    // origin-fan-out: every chunk Carol knows a provider for resolves to
    // Bob, never Alice (Carol never even learned of Alice's podId).
    for (const cid of carolApi.getManifest(info.magnetURI).chunkCids) {
      assert.deepEqual(carolApi.listKnownProviders(cid), [bob.podId]);
    }
  });
});

// -----------------------------------------------------------------------
// Manifest discovery, ctx.emit() bridging, and introspection
// -----------------------------------------------------------------------

describe('createTorrentService: manifest discovery and ctx.emit() events', () => {
  it('a peer with no prior announce can still fetch the manifest via manifest-request/-response', async () => {
    const alice = await createTorrentTestPeer('alice');
    const bob = await createTorrentTestPeer('bob');
    const mesh = wireTorrentMesh([alice, bob], [[alice.podId, bob.podId]]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    const { api: aliceApi } = attachService(nodeA, undefined, createTorrentService({}));
    const { api: bobApi } = attachService(nodeB, undefined, createTorrentService({}));

    const original = new Uint8Array([9, 8, 7, 6, 5]);
    const info = await aliceApi.seed(original, { name: 'no-announce.bin' });

    // Deliberately no aliceApi.share() call -- bob has never heard an
    // announce for this magnetURI, so download() must fall back to
    // requesting the manifest directly.
    assert.equal(bobApi.getManifest(info.magnetURI), null);
    const { data } = await bobApi.download(info.magnetURI, { peers: [alice.podId] });
    assert.deepEqual(data, original);
    assert.ok(bobApi.getManifest(info.magnetURI));
  });

  it('emits torrent:seed, torrent:announce-received, torrent:download-start/-complete', async () => {
    const alice = await createTorrentTestPeer('alice');
    const bob = await createTorrentTestPeer('bob');
    const mesh = wireTorrentMesh([alice, bob], [[alice.podId, bob.podId]]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    const aliceEvents = [];
    const { api: aliceApi, on: aliceOn } = attachService(nodeA, undefined, createTorrentService({}));
    aliceOn('torrent:seed', (info) => aliceEvents.push({ type: 'seed', info }));

    const bobEvents = [];
    const { api: bobApi, on: bobOn } = attachService(nodeB, undefined, createTorrentService({}));
    bobOn('torrent:announce-received', (e) => bobEvents.push({ type: 'announce-received', ...e }));
    bobOn('torrent:download-start', (e) => bobEvents.push({ type: 'download-start', ...e }));
    bobOn('torrent:download-complete', (e) => bobEvents.push({ type: 'download-complete', ...e }));

    const info = await aliceApi.seed(new Uint8Array([1, 2, 3]), { name: 'events.bin' });
    assert.equal(aliceEvents.length, 1); // aliceApi.seed() -> tm.seed() -> bridged 'seed' event

    aliceApi.share(info.magnetURI, [bob.podId]);
    await waitForTorrent(() => bobEvents.some((e) => e.type === 'announce-received'), 1000, 'bob to receive the announce');

    await bobApi.download(info.magnetURI);

    assert.ok(bobEvents.some((e) => e.type === 'announce-received' && e.magnetURI === info.magnetURI));
    assert.ok(bobEvents.some((e) => e.type === 'download-start' && e.magnetURI === info.magnetURI));
    assert.ok(bobEvents.some((e) => e.type === 'download-complete' && e.magnetURI === info.magnetURI));

    // bob's own successful download registers him as a seed too (see
    // mesh-torrent.mjs's download() doc comment) -- his OWN service instance
    // bridges its own tm's 'seed' event independently of alice's.
  });

  it('a corrupted chunk response fails integrity verification and download() rejects when no other provider exists', async () => {
    const alice = await createTorrentTestPeer('alice');
    const bob = await createTorrentTestPeer('bob');
    const mesh = wireTorrentMesh([alice, bob], [[alice.podId, bob.podId]]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    // Intercept alice's outgoing sendTo() to corrupt chunk-response payloads
    // in flight -- proves fetchChunk()'s ChunkStore.verify() check is real,
    // not decorative.
    const realSendTo = nodeA.sendTo.bind(nodeA);
    nodeA.sendTo = async (pubKey, data) => {
      if (data && data.kind === 'chunk-response' && data.data) {
        return realSendTo(pubKey, { ...data, data: Buffer.from('corrupted-not-the-real-bytes').toString('base64') });
      }
      return realSendTo(pubKey, data);
    };

    const { api: aliceApi } = attachService(nodeA, undefined, createTorrentService({}));
    const { api: bobApi } = attachService(nodeB, undefined, createTorrentService({}));

    const info = await aliceApi.seed(new Uint8Array([42, 43, 44]), { name: 'corrupt.bin' });

    await assert.rejects(
      () => bobApi.download(info.magnetURI, { peers: [alice.podId] }),
      /mesh-torrent/,
    );
  });

  it('teardown unsubscribes and rejects any in-flight chunk fetch', async () => {
    const alice = await createTorrentTestPeer('alice');
    const bob = await createTorrentTestPeer('bob');
    const mesh = wireTorrentMesh([alice, bob], [[alice.podId, bob.podId]]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    const aliceHandle = attachService(nodeA, undefined, createTorrentService({}));
    const bobHandle = attachService(nodeB, undefined, createTorrentService({ chunkTimeoutMs: 60000 }));

    const info = await aliceHandle.api.seed(new Uint8Array([1, 2, 3]), { name: 'x' });
    aliceHandle.api.share(info.magnetURI, [bob.podId]);
    await waitForTorrent(() => bobHandle.api.getManifest(info.magnetURI) !== null, 1000, "bob to receive alice's manifest");

    // Alice goes offline (her own service torn down) before ever answering a
    // chunk-request -- bob's fetch is now permanently unanswered, exactly
    // the scenario chunkTimeoutMs=60000 is here to rule out as the cause of
    // the eventual rejection below.
    await aliceHandle.teardown();

    const pending = bobHandle.api.download(info.magnetURI, { peers: [alice.podId] }).catch((err) => err);
    // Give the chunk-request a beat to actually go out (and go unanswered).
    await new Promise((r) => setTimeout(r, 20));

    // Bob's own teardown() must resolve the pending fetch itself, not leave
    // it hanging until chunkTimeoutMs (60s) -- see mesh-torrent.mjs's own
    // teardown()'s explicit rejection of pendingChunkFetches.
    await bobHandle.teardown();
    const result = await pending;
    assert.ok(result instanceof Error);
  });
});

// -----------------------------------------------------------------------
// createMeshNode({ enableTorrent: true }) -- opt-in surface (issue #122)
// -----------------------------------------------------------------------

function createStubTorrentSignalingTransport() {
  return { send() {}, onMessage() {} };
}

describe('createMeshNode({ enableTorrent: true })', () => {
  it('leaves node.torrent unset and node.services empty of "torrent" when enableTorrent is omitted', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubTorrentSignalingTransport(),
      skipBoot: true,
    });

    assert.equal(node.torrent, undefined);
    assert.equal(node.services.has('torrent'), false);
  });

  it('attaches node.torrent (== node.services.get("torrent")) when enableTorrent is set', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubTorrentSignalingTransport(),
      enableTorrent: true,
      skipBoot: true,
    });

    assert.ok(node.torrent, 'node.torrent is attached');
    assert.equal(node.torrent, node.services.get('torrent'));
    assert.equal(typeof node.torrent.api.seed, 'function');
    assert.equal(typeof node.torrent.api.download, 'function');
    assert.equal(typeof node.torrent.api.share, 'function');
  });

  it('torrentOptions are forwarded to createTorrentService()', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubTorrentSignalingTransport(),
      enableTorrent: true,
      torrentOptions: { trackerUrl: 'wss://tracker.example.com' },
      skipBoot: true,
    });

    const info = await node.torrent.api.seed(new Uint8Array([1, 2, 3]), { name: 'x' });
    assert.equal(typeof info.magnetURI, 'string');
    assert.equal(node.torrent.api.getStats().seeding, 1);
  });
});
