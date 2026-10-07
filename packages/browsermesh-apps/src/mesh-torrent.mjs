/**
 * mesh-torrent.mjs -- Phase 5 of the browsermesh-app-layer-migration plan
 * (issue #122): wraps `peer-torrent.mjs`'s `TorrentManager` as a `MeshService`
 * (`mesh-service.mjs`, Phase C's `attach()`/`ctx` convention).
 *
 * ---------------------------------------------------------------------------
 * WHAT `TorrentManager` ALREADY DOES, AND WHAT IT DOESN'T (read this first --
 * this determined this file's whole design):
 *
 * `TorrentManager` is real, tested, and NOT touched by this file beyond
 * calling its existing public methods -- its real-WebTorrent path
 * (`#seedReal`/`#downloadReal`, used only when `window.WebTorrent`/a CDN load
 * succeeds, i.e. only in a browser) is a genuine, unmodified BitTorrent
 * client integration. But its Node/offline FALLBACK path (`FallbackStore`,
 * `#seedFallback`/`#downloadFallback`) -- the ONLY path that ever runs in
 * this repo's tests, and the one every `MeshService` in this family runs
 * under (no browser, no CDN) -- is a private, single-process, in-memory
 * `Map` keyed by infoHash. It has NO awareness of other peers at all:
 * `seed()` stores the whole blob locally; `download()` only ever looks in
 * THIS SAME instance's own private store. Two separate `TorrentManager`
 * instances (i.e. two separate peers) never exchange a single byte through
 * `seed()`/`download()` alone.
 *
 * `shareWithPeers(magnetURI, peerIds, sendFn)` -- the one method that looks
 * network-shaped -- was checked carefully (per this phase's own brief) and
 * confirmed to be A NOTIFICATION HOOK, NOT A TRANSFER: it calls
 * `sendFn(peerId, { type: 'torrent:share', magnetURI, info })` once per
 * peer and returns. No chunk, and no byte of the underlying content, is
 * ever part of that message -- `info` is just `{name, size}`. Nothing in
 * `peer-torrent.mjs` moves piece bytes between peers. So unlike
 * `peer-routing.mjs`'s `MeshRouter` (Phase 2 precedent for this file, whose
 * ENTIRE multi-hop mechanic already lived inside the wrapped class -- this
 * file only had to plug `forwardFn` into `ctx.sendTo()`), a mechanical
 * `sendFn -> ctx.sendTo()` swap here would produce peers that politely tell
 * each other "I have this" and then have no way to actually get it.
 *
 * Issue #122's whole stated value proposition -- "swarm-style distribution
 * to many peers... a genuinely different topology" from CloudStorage -- is
 * exactly the piece `TorrentManager` itself doesn't implement in this
 * environment. Closing that gap for real (not just wiring an existing
 * mechanic onto `ctx`) is this file's actual job. `TorrentManager`'s own
 * internal logic (ID/magnet generation, its own local store, its `on`/`off`
 * events, `getStats()`/`listTorrents()`/`toJSON()`/`destroy()`) is reused
 * completely as-is, unmodified, exactly per this plan's "thin wrapper, not a
 * rewrite" rule -- this file adds a NEW piece-exchange wire protocol
 * alongside it, the same shape of addition `mesh-timestamp.mjs` made for
 * witness collection and `chunk-replication.mjs` made for CloudStorage's own
 * chunk transport (this file's closest in-repo precedent for the actual
 * wire protocol below -- request/response chunk fetch over `ctx.sendTo()`/
 * `ctx.onIncomingData()`, base64-in-JSON, content-hash-verified on receipt).
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS A REAL SWARM, NOT JUST ORIGIN-TO-MANY FAN-OUT:
 *
 * Content is split into `chunkSize`-byte pieces (default `TORRENT_DEFAULTS
 * .chunkSize`, 64KB) and stored by this file in its OWN `ChunkStore`
 * (content-addressed, SHA-256 CIDs -- see "DURABILITY"
 * below), separate from `TorrentManager`'s own opaque whole-blob store. A
 * peer that finishes downloading calls `tm.seed()` on the reassembled bytes
 * (see `download()`'s own comment for why this is exactly correct, not a
 * hack) and can immediately answer `chunk-request`s for any piece it holds
 * -- there is no "origin" role encoded anywhere in the wire protocol, only
 * "whoever currently has piece X". `api.download()`'s per-chunk provider
 * selection (`fetchChunk()`) tries every peer this node currently believes
 * holds a given CID (`chunkOwners`, populated by `announce`s AND by
 * successful fetches), in no particular preference order -- a downloader
 * that finished can be, and in this file's own tests IS, the source another
 * peer downloads from with the ORIGINAL seeder never involved in that
 * transfer at all.
 *
 * ---------------------------------------------------------------------------
 * WIRE PROTOCOL -- one envelope `type` (default `'mesh-torrent'`), five
 * `kind`s:
 *
 *   Announce (fire-and-forget, from `api.share()`, bridging `shareWithPeers`):
 *     `{ type, kind: 'announce', magnetURI, manifest, info }`
 *       -- `manifest` is `{ infoHash, name, size, chunkCids, chunkSize?, cid? }`
 *          (`cid` = SHA-256 hex of the whole content), or undefined if the
 *          announcer doesn't actually hold the content -- see `share()`.
 *          The RECEIVER records the sender as a known provider for every
 *          `chunkCids` entry -- this is how `chunkOwners` bootstraps without
 *          a separate discovery round trip.
 *
 *   Manifest request/response (only needed if a downloader never received an
 *   `announce` for this magnetURI -- e.g. it learned the magnetURI out of
 *   band):
 *     `{ type, kind: 'manifest-request', requestId, magnetURI }`
 *     `{ type, kind: 'manifest-response', requestId, magnetURI, manifest }`
 *       -- `manifest` is `null` when the responder does not hold that magnetURI
 *          OR will not serve it to this requester (see AUTHORIZATION below):
 *          the two cases are indistinguishable. A requester that asked several
 *          peers keeps waiting until one sends a manifest or every one has
 *          said `null`. (Older nodes stayed silent instead of sending `null`;
 *          a requester treats that as "no answer" and falls back to its
 *          `manifestTimeoutMs`.)
 *
 *   Chunk request/response (the actual piece exchange):
 *     `{ type, kind: 'chunk-request', requestId, cid }`
 *     `{ type, kind: 'chunk-response', requestId, cid, data }` (`data` base64)
 *       or `{ ..., error: 'not-found' }` (unknown piece, or one this peer
 *       will not serve to the requester -- indistinguishable)
 *       or `{ ..., error: 'busy' }` (a serve cap is full; says nothing about
 *       the piece, and downloaders retry after a short backoff).
 *
 * AUTHORIZATION (opt-in): with no `authorize` option anyone on the mesh who
 * knows a magnet URI can fetch its manifest and pieces, as before -- issue
 * #122's framing is swarm distribution to many unvetted downloaders, so the
 * default stays open (unlike `chunk-replication.mjs`, which always gates on
 * `registry.checkAccess()`). A host that wants a gate passes
 * `authorize(fromPubKey, { kind, magnetURI, infoHash, cid, chunkCid? })`;
 * it is consulted before every manifest and every piece is served, a piece
 * held by several torrents is served if ANY of them allows, and a throw or a
 * non-`true` result denies. A denied request is answered with exactly what an
 * unknown one gets (`manifest: null` / `error: 'not-found'`), so a peer cannot
 * probe which content exists. (Timing is not equalised.) `announce` stays
 * unauthenticated -- it only tells this node who might hold a piece -- but is
 * rate limited per peer. A node only ever serves pieces listed by a manifest
 * it holds, so a shared chunk store's unrelated contents are not reachable.
 *
 * SERVE LIMITS: `maxConcurrentServes` (all peers), `maxConcurrentServesPerPeer`
 * and `maxBytesPerPeerPerSec` bound what one node spends on serving. They apply
 * to every chunk-request regardless of content, before any lookup.
 *
 * Every fetched chunk is verified against its own CID (SHA-256)
 * before being trusted/stored/re-served -- content-addressing's integrity
 * property holds regardless of which swarm peer relayed a piece, exactly
 * `chunk-replication.mjs`'s own reasoning for why its wire messages need no
 * signature.
 *
 * ---------------------------------------------------------------------------
 * DURABILITY (the "CHUNKSTORE DURABILITY DECISION" the migration plan left
 * open, resolved as an injection point rather than a hard-coded choice):
 *
 * By default this service keeps pieces in an in-memory `ChunkStore` and
 * manifests in an in-memory map, so everything is gone on reload -- exactly
 * the old behaviour. Pass `chunkStore` and `manifestStore` and both survive:
 * pieces go to `chunkStore`, one JSON-safe record per held torrent goes to
 * `manifestStore` (the index of what to serve), and on attach the service
 * reloads that index, so a seeder that comes back with the same stores keeps
 * serving (`api.ensureLoaded()` additionally restores `listTorrents()`).
 * `IndexedDBChunkStore` from `@johnhenry/browsermesh-sync` is the intended
 * durable `chunkStore`; its `save/get/has/remove` return Promises and the
 * service awaits every store call, so sync and async stores are both fine.
 * The stores are handed to the internal `TorrentManager` too, so both halves
 * stay consistent. A store you inject is never cleared by `destroy()`.
 * Only content this node holds in full is persisted; manifests learned from
 * other peers' announces live in memory.
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`, see `mesh-service.mjs`'s module doc
 * comment for the full convention):
 *
 *   - `torrent:seed` -- `TorrentManager`'s own `'seed'` event, bridged
 *     verbatim (fires both when this peer originates content via `api.seed()`
 *     AND when `api.download()` registers this peer as a new full holder --
 *     see `download()`'s own comment).
 *   - `torrent:announce-received` `{from, magnetURI, name}` -- an `announce`
 *     arrived (whether or not it carried a usable manifest).
 *   - `torrent:download-start` / `torrent:download-complete`
 *     `{magnetURI, name?, size?}` -- this peer's own `api.download()` call.
 *   - `torrent:chunk-received` `{from, cid, size}` -- one piece fetched and
 *     verified during a download.
 *   - `torrent:chunk-served` `{to, cid, size}` -- this peer answered another
 *     peer's `chunk-request` from its own local piece store -- the direct,
 *     observable proof of peer-to-peer (not origin-only) exchange.
 *   - `torrent:request-denied` `{from, kind: 'manifest'|'chunk', magnetURI?, cid?}`
 *     -- `authorize` refused a request that named content this node holds
 *     (local observability only; the requester is told nothing).
 *   - `torrent:serve-busy` `{from, cid}` -- a serve cap was full.
 *
 * No browser-only imports at module level.
 */

import { TorrentManager, TORRENT_DEFAULTS } from './peer-torrent.mjs'
import { ChunkStore } from '@johnhenry/browsermesh-sync'
import {
  MemoryManifestStore,
  toSeedBytes,
  releaseChunks,
  splitIntoChunks,
  saveChunks,
  createByteBucket,
} from './internal/torrent-store.mjs'

/** Default `envelope.type` used to route all mesh-torrent wire traffic. */
const DEFAULT_ENVELOPE_TYPE = 'mesh-torrent'

/** Default piece size for this file's own chunking (independent of `TorrentManager`'s own, unused-in-fallback, `TORRENT_DEFAULTS.chunkSize` constant -- same numeric default, 64KB). */
const DEFAULT_CHUNK_SIZE = 65536

/** How long `requestManifest()` waits for the first `manifest-response` before giving up. */
const DEFAULT_MANIFEST_TIMEOUT_MS = 5000

/** How long a single `fetchChunkFrom()` call waits for its `chunk-response` before treating that peer as unreachable for this attempt. */
const DEFAULT_CHUNK_TIMEOUT_MS = 5000

/** Chunk-responses a node will have in flight across all peers (`maxConcurrentServes`). */
const DEFAULT_MAX_CONCURRENT_SERVES = 16

/** Chunk-responses in flight for any one peer (`maxConcurrentServesPerPeer`). */
const DEFAULT_MAX_CONCURRENT_SERVES_PER_PEER = 4

/** Served bytes per second per peer (`maxBytesPerPeerPerSec`); `0` = unlimited. */
const DEFAULT_MAX_BYTES_PER_PEER_PER_SEC = 0

/** `announce` messages accepted per peer per minute (`maxAnnouncesPerPeerPerMinute`). */
const DEFAULT_MAX_ANNOUNCES_PER_PEER_PER_MINUTE = 30

/** Extra attempts a downloader makes on one provider after a `busy` answer. */
const DEFAULT_BUSY_RETRIES = 3

/** Backoff before the first `busy` retry; grows linearly per attempt. */
const DEFAULT_BUSY_BACKOFF_MS = 250

// ---------------------------------------------------------------------------
// Base64 helpers -- deliberately duplicated rather than shared, matching
// this family's established convention (see chunk-replication.mjs's /
// cloud-storage-backend.mjs's own identical duplication).
// ---------------------------------------------------------------------------

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let bin = ''
  const STEP = 0x8000
  for (let i = 0; i < bytes.length; i += STEP) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP))
  return btoa(bin)
}

/** @param {string} str @returns {Uint8Array} */
function fromBase64(str) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'))
  const bin = atob(str)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/**
 * @param {Uint8Array[]} pieces
 * @returns {Uint8Array}
 */
function concatChunks(pieces) {
  const total = pieces.reduce((sum, p) => sum + p.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const p of pieces) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** A manifest a peer sent us: only the fields we rely on, checked for shape. */
function isUsableManifest(m) {
  return !!m && typeof m === 'object'
    && Array.isArray(m.chunkCids) && m.chunkCids.every((c) => typeof c === 'string')
    && Number.isSafeInteger(m.size) && m.size >= 0
}

function checkLimit(name, value) {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 0) {
    throw new TypeError(`createTorrentService: ${name} must be a non-negative number (0 or Infinity = unlimited), got ${String(value)}`)
  }
}

/** Treat 0 as "no limit" for every cap option. */
const orUnlimited = (n) => (n === 0 ? Infinity : n)

// ---------------------------------------------------------------------------
// createTorrentService
// ---------------------------------------------------------------------------

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) wrapping
 * `TorrentManager` with a real, mesh-native swarm piece-exchange protocol.
 * See this file's module doc comment for the full design writeup.
 *
 * @param {object} [opts]
 * @param {string} [opts.trackerUrl] - Forwarded to `new TorrentManager()`.
 * @param {number} [opts.chunkSize=65536] - Piece size for this file's own
 *   chunking (independent of `TorrentManager`'s own internals).
 * @param {string} [opts.envelopeType='mesh-torrent']
 * @param {number} [opts.manifestTimeoutMs=5000]
 * @param {number} [opts.chunkTimeoutMs=5000]
 * @param {Function} [opts.onLog]
 * @param {object} [opts.chunkStore] - Piece store, default a fresh in-memory
 *   `ChunkStore`. Any object with `save(cid, bytes)`, `get(cid)`, `has(cid)`
 *   and `remove(cid)` (each sync or async) -- browsermesh-sync's
 *   `IndexedDBChunkStore` is the durable fit. Shared with the internal
 *   `TorrentManager`. Never cleared by this service: it belongs to the caller.
 * @param {object} [opts.manifestStore] - `{ get(magnetURI), set(magnetURI,
 *   manifest), delete(magnetURI), entries() }` (each sync or async), holding
 *   one JSON-safe record per torrent this node holds. Default in-memory. It is
 *   the index of what `chunkStore` contains: a node only serves pieces that a
 *   manifest in this store lists, so persist both or neither.
 * @param {(fromPubKey: string, req: { kind: 'manifest'|'chunk', magnetURI: string,
 *   infoHash: string, cid?: string, chunkCid?: string }) => boolean|Promise<boolean>} [opts.authorize]
 *   Called before serving a manifest or a piece. `cid` is the SHA-256 hex CID
 *   of the whole content (when known); `chunkCid` is set for `kind: 'chunk'`.
 *   Only a strict `true` allows; `false`, anything else, or a throw denies.
 *   A denied request gets exactly the reply an unknown one gets. Omitted =
 *   serve everyone (the previous behaviour).
 * @param {number} [opts.maxConcurrentServes=16] - Chunk-responses in flight
 *   across all peers. Over the cap the requester is told `busy`. `0` = unlimited.
 * @param {number} [opts.maxConcurrentServesPerPeer=4] - Same, per requesting peer.
 * @param {number} [opts.maxBytesPerPeerPerSec=0] - Served-bytes budget per
 *   peer (token bucket, one-second burst); excess serves wait. `0` = unlimited.
 * @param {number} [opts.maxAnnouncesPerPeerPerMinute=30] - Inbound
 *   `announce`s accepted per peer per rolling minute; extras are dropped. `0` = unlimited.
 * @param {number} [opts.busyRetries=3] - Downloader: retries on one provider after `busy`.
 * @param {number} [opts.busyBackoffMs=250] - Downloader: first backoff after `busy` (grows linearly).
 * @param {() => number} [opts.now] - Clock for rate limits (tests).
 * @param {(ms: number) => Promise<void>} [opts.sleep] - Sleep for rate limits/backoff (tests).
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createTorrentService({
  trackerUrl,
  chunkSize = DEFAULT_CHUNK_SIZE,
  envelopeType = DEFAULT_ENVELOPE_TYPE,
  manifestTimeoutMs = DEFAULT_MANIFEST_TIMEOUT_MS,
  chunkTimeoutMs = DEFAULT_CHUNK_TIMEOUT_MS,
  onLog,
  chunkStore: injectedChunkStore,
  manifestStore: injectedManifestStore,
  authorize,
  maxConcurrentServes = DEFAULT_MAX_CONCURRENT_SERVES,
  maxConcurrentServesPerPeer = DEFAULT_MAX_CONCURRENT_SERVES_PER_PEER,
  maxBytesPerPeerPerSec = DEFAULT_MAX_BYTES_PER_PEER_PER_SEC,
  maxAnnouncesPerPeerPerMinute = DEFAULT_MAX_ANNOUNCES_PER_PEER_PER_MINUTE,
  busyRetries = DEFAULT_BUSY_RETRIES,
  busyBackoffMs = DEFAULT_BUSY_BACKOFF_MS,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const log = onLog || (() => {})

  if (authorize !== undefined && typeof authorize !== 'function') {
    throw new TypeError('createTorrentService: authorize must be a function (fromPubKey, request) => boolean|Promise<boolean>')
  }
  for (const [n, v] of Object.entries({ maxConcurrentServes, maxConcurrentServesPerPeer, maxBytesPerPeerPerSec, maxAnnouncesPerPeerPerMinute })) {
    checkLimit(n, v)
  }
  for (const [n, o] of [['chunkStore', injectedChunkStore], ['manifestStore', injectedManifestStore]]) {
    if (o !== undefined && (o === null || typeof o !== 'object')) {
      throw new TypeError(`createTorrentService: ${n} must be an object`)
    }
  }
  for (const m of ['save', 'get', 'has', 'remove']) {
    if (injectedChunkStore && typeof injectedChunkStore[m] !== 'function') {
      throw new TypeError(`createTorrentService: chunkStore must implement ${m}()`)
    }
  }
  for (const m of ['get', 'set', 'delete', 'entries']) {
    if (injectedManifestStore && typeof injectedManifestStore[m] !== 'function') {
      throw new TypeError(`createTorrentService: manifestStore must implement ${m}()`)
    }
  }
  const globalServeCap = orUnlimited(maxConcurrentServes)
  const perPeerServeCap = orUnlimited(maxConcurrentServesPerPeer)
  const announceCap = orUnlimited(maxAnnouncesPerPeerPerMinute)

  return {
    name: 'torrent',

    attach(peerNode, ctx) {
      /** This service's piece store: the caller's, or a private in-memory one -- see module doc comment's "DURABILITY". */
      const chunkStore = injectedChunkStore ?? new ChunkStore()
      const manifestStore = injectedManifestStore ?? new MemoryManifestStore()

      const tm = new TorrentManager({
        trackerUrl,
        chunkSize,
        chunkStore,
        manifestStore,
        onLog: (level, msg) => log('mesh-torrent:internal', { level, msg }),
      })

      /**
       * magnetURI -> manifest, for content this node HOLDS in full (persisted
       * through `manifestStore`; reloaded into this map by `ready`).
       * @type {Map<string, {infoHash: string, name: string, size: number, chunkSize?: number, chunkCids: string[], cid?: string}>}
       */
      const held = new Map()

      /** magnetURI -> manifest a peer announced or answered with, for content we do NOT hold. Memory only. */
      const remoteManifests = new Map()

      /** piece cid -> magnetURIs (in `held`) that list it: what a chunk-request may be served from. */
      const chunkIndex = new Map()

      /** @type {Map<string, Set<string>>} cid -> pubKeys known to currently hold that piece */
      const chunkOwners = new Map()

      const manifestFor = (magnetURI) => held.get(magnetURI) ?? remoteManifests.get(magnetURI)

      function indexHeld(magnetURI, manifest) {
        for (const cid of manifest.chunkCids) {
          let set = chunkIndex.get(cid)
          if (!set) chunkIndex.set(cid, (set = new Set()))
          set.add(magnetURI)
        }
      }

      function unindexHeld(magnetURI, manifest) {
        for (const cid of manifest.chunkCids) {
          const set = chunkIndex.get(cid)
          if (!set) continue
          set.delete(magnetURI)
          if (set.size === 0) chunkIndex.delete(cid)
        }
      }

      /** Writes and cleanups still running; awaited by `api.flush()`. */
      const pendingWrites = new Set()
      const track = (promise) => {
        const p = promise.catch((err) => log('mesh-torrent:store-error', { error: err?.message || String(err) }))
          .finally(() => pendingWrites.delete(p))
        pendingWrites.add(p)
        return p
      }

      /** Reload what a previous run persisted: this is what lets a seeder keep serving after a reload. */
      const ready = (async () => {
        for (const [magnetURI, manifest] of await manifestStore.entries()) {
          if (!isUsableManifest(manifest) || held.has(magnetURI)) continue
          held.set(magnetURI, manifest)
          indexHeld(magnetURI, manifest)
        }
      })().catch((err) => {
        log('mesh-torrent:manifest-restore-failed', { error: err?.message || String(err) })
      })

      let reqSeq = 0
      const nextRequestId = () => `${peerNode.podId}:${now()}:${++reqSeq}`

      /** @param {string} pubKey @param {string[]} cids */
      function recordOwner(pubKey, cids) {
        for (const cid of cids) {
          let set = chunkOwners.get(cid)
          if (!set) {
            set = new Set()
            chunkOwners.set(cid, set)
          }
          set.add(pubKey)
        }
      }

      // Bridge TorrentManager's own 'seed' event -- the only tm event this
      // wrapper's own api can actually trigger (api.download() never calls
      // tm.download(), see module doc comment -- so tm's 'download:start'/
      // 'download:complete' events never fire through this service, and
      // bridging them would be misleading).
      const onTmSeed = (info) => ctx.emit('torrent:seed', info)
      tm.on('seed', onTmSeed)

      // -----------------------------------------------------------------
      // Serving limits and authorization
      // -----------------------------------------------------------------

      /** pubKey -> chunk-responses in flight */
      const inFlight = new Map()
      let totalInFlight = 0
      /** pubKey -> byte bucket */
      const buckets = new Map()
      /** pubKey -> timestamps of recent announces */
      const announceTimes = new Map()

      function announceAllowed(pubKey) {
        if (announceCap === Infinity) return true
        const t = now()
        const recent = (announceTimes.get(pubKey) ?? []).filter((x) => t - x < 60_000)
        const ok = recent.length < announceCap
        if (ok) recent.push(t)
        announceTimes.set(pubKey, recent)
        return ok
      }

      /** Strict `true` allows; a throw, a rejection or any other value denies (fail closed). */
      async function mayServe(fromPubKey, request) {
        if (!authorize) return true
        try {
          return (await authorize(fromPubKey, request)) === true
        } catch (err) {
          log('mesh-torrent:authorize-error', { from: fromPubKey, kind: request.kind, error: err?.message || String(err) })
          return false
        }
      }

      const requestFor = (kind, magnetURI, manifest, chunkCid) => ({
        kind,
        magnetURI,
        infoHash: manifest.infoHash,
        cid: manifest.cid,
        ...(chunkCid !== undefined ? { chunkCid } : {}),
      })

      // -----------------------------------------------------------------
      // In-flight request tracking
      // -----------------------------------------------------------------

      /** @type {Map<string, {resolve: (manifest: object|null) => void, timer: ReturnType<typeof setTimeout>, magnetURI: string, targets: Set<string>, expected: number}>} */
      const pendingManifestRequests = new Map()

      /** @type {Map<string, {resolve: (bytes: Uint8Array) => void, reject: (err: Error) => void, timer: ReturnType<typeof setTimeout>, peer: string}>} */
      const pendingChunkFetches = new Map()

      // -----------------------------------------------------------------
      // Inbound dispatch
      // -----------------------------------------------------------------

      function handleAnnounce(fromPubKey, msg) {
        if (typeof msg.magnetURI !== 'string' || msg.magnetURI.length > 512) return
        if (!announceAllowed(fromPubKey)) {
          log('mesh-torrent:announce-rate-limited', { from: fromPubKey })
          return
        }
        if (isUsableManifest(msg.manifest)) {
          if (!held.has(msg.magnetURI)) remoteManifests.set(msg.magnetURI, msg.manifest)
          recordOwner(fromPubKey, msg.manifest.chunkCids)
        }
        ctx.emit('torrent:announce-received', {
          from: fromPubKey,
          magnetURI: msg.magnetURI,
          name: msg.manifest?.name ?? msg.info?.name,
        })
      }

      async function handleManifestRequest(fromPubKey, msg) {
        if (typeof msg.magnetURI !== 'string' || typeof msg.requestId !== 'string') return
        await ready
        let manifest = manifestFor(msg.magnetURI) ?? null
        if (manifest && !(await mayServe(fromPubKey, requestFor('manifest', msg.magnetURI, manifest)))) {
          ctx.emit('torrent:request-denied', { from: fromPubKey, kind: 'manifest', magnetURI: msg.magnetURI })
          manifest = null
        }
        // Unknown and refused answer identically (`manifest: null`): a requester learns nothing about what exists.
        await ctx.sendTo(fromPubKey, envelopeType, {
          kind: 'manifest-response', requestId: msg.requestId, magnetURI: msg.magnetURI, manifest,
        }).catch((err) => {
          log('mesh-torrent:manifest-response-send-failed', { to: fromPubKey, magnetURI: msg.magnetURI, error: err?.message || String(err) })
        })
      }

      function handleManifestResponse(fromPubKey, msg) {
        const pending = pendingManifestRequests.get(msg.requestId)
        if (!pending || !pending.targets.has(fromPubKey)) return
        pending.targets.delete(fromPubKey)
        if (isUsableManifest(msg.manifest)) {
          clearTimeout(pending.timer)
          pendingManifestRequests.delete(msg.requestId)
          if (!held.has(pending.magnetURI)) remoteManifests.set(pending.magnetURI, msg.manifest)
          recordOwner(fromPubKey, msg.manifest.chunkCids)
          pending.resolve(msg.manifest)
          return
        }
        // A "don't have it / won't tell you" answer: only give up once every asked peer has said so.
        if (--pending.expected <= 0) {
          clearTimeout(pending.timer)
          pendingManifestRequests.delete(msg.requestId)
          pending.resolve(null)
        }
      }

      async function handleChunkRequest(fromPubKey, msg) {
        if (typeof msg.cid !== 'string' || typeof msg.requestId !== 'string') return
        const respond = (payload, sendOpts) => ctx.sendTo(fromPubKey, envelopeType, {
          kind: 'chunk-response', requestId: msg.requestId, cid: msg.cid, ...payload,
        }, sendOpts)
        const notFound = () => respond({ error: 'not-found' }).catch(() => {})

        // Load limits apply to every request from a peer, whatever it asks
        // for, so `busy` says nothing about which content exists.
        const mine = inFlight.get(fromPubKey) ?? 0
        if (mine >= perPeerServeCap || totalInFlight >= globalServeCap) {
          ctx.emit('torrent:serve-busy', { from: fromPubKey, cid: msg.cid })
          await respond({ error: 'busy' }).catch(() => {})
          return
        }
        inFlight.set(fromPubKey, mine + 1)
        totalInFlight++
        try {
          await ready
          // Only pieces listed by a manifest this node holds are ever served,
          // so a shared/durable chunkStore's other contents stay unreachable.
          let allowed = false
          let allowedBy = null
          for (const magnetURI of chunkIndex.get(msg.cid) ?? []) {
            const manifest = held.get(magnetURI)
            if (manifest && await mayServe(fromPubKey, requestFor('chunk', magnetURI, manifest, msg.cid))) {
              allowed = true
              allowedBy = magnetURI
              break
            }
          }
          if (!allowed) {
            if (chunkIndex.has(msg.cid)) ctx.emit('torrent:request-denied', { from: fromPubKey, kind: 'chunk', cid: msg.cid })
            return await notFound()
          }

          const bytes = await chunkStore.get(msg.cid)
          if (!bytes) {
            log('mesh-torrent:held-chunk-missing', { cid: msg.cid, magnetURI: allowedBy })
            return await notFound()
          }

          let bucket = buckets.get(fromPubKey)
          if (!bucket) buckets.set(fromPubKey, (bucket = createByteBucket({ rate: maxBytesPerPeerPerSec, now, sleep })))
          await bucket.take(bytes.length)

          let sent = true
          // Piece data rides the bulk lane so it cannot starve control traffic
          // (`ctx.sendTo(..., { channel: 'bulk' })`, #198). A transport with no bulk
          // lane ignores the option.
          await respond({ data: toBase64(bytes) }, { channel: 'bulk' }).catch((err) => {
            sent = false
            log('mesh-torrent:chunk-response-send-failed', { to: fromPubKey, cid: msg.cid, error: err?.message || String(err) })
          })
          if (sent) ctx.emit('torrent:chunk-served', { to: fromPubKey, cid: msg.cid, size: bytes.length })
        } finally {
          const left = (inFlight.get(fromPubKey) ?? 1) - 1
          if (left > 0) inFlight.set(fromPubKey, left)
          else inFlight.delete(fromPubKey)
          totalInFlight--
        }
      }

      function handleChunkResponse(fromPubKey, msg) {
        const pending = pendingChunkFetches.get(msg.requestId)
        if (!pending || pending.peer !== fromPubKey) return // a response only counts from the peer we asked
        clearTimeout(pending.timer)
        pendingChunkFetches.delete(msg.requestId)
        if (msg.error) {
          const err = new Error(`mesh-torrent: chunk ${msg.cid} fetch from ${fromPubKey} failed: ${msg.error}`)
          err.code = msg.error
          pending.reject(err)
          return
        }
        if (typeof msg.data !== 'string') {
          pending.reject(new Error(`mesh-torrent: malformed chunk response from ${fromPubKey}`))
          return
        }
        pending.resolve(fromBase64(msg.data))
      }

      const handlers = {
        'announce': handleAnnounce,
        'manifest-request': handleManifestRequest,
        'manifest-response': handleManifestResponse,
        'chunk-request': handleChunkRequest,
        'chunk-response': handleChunkResponse,
      }

      const unsubscribe = ctx.onIncomingData(envelopeType, (fromPubKey, msg) => {
        if (!msg || typeof msg.kind !== 'string') return
        const handler = handlers[msg.kind]
        if (!handler) return
        Promise.resolve(handler(fromPubKey, msg)).catch((err) => {
          log('mesh-torrent:handler-error', { kind: msg.kind, from: fromPubKey, error: err?.message || String(err) })
        })
      })

      // -----------------------------------------------------------------
      // Manifest / chunk fetch (the actual swarm mechanics)
      // -----------------------------------------------------------------

      /**
       * @param {string} magnetURI
       * @param {string[]} [candidatePeers]
       * @returns {Promise<object|null>}
       */
      async function requestManifest(magnetURI, candidatePeers) {
        const known = manifestFor(magnetURI)
        if (known) return known
        const targets = candidatePeers && candidatePeers.length ? [...new Set(candidatePeers)] : []
        if (targets.length === 0) return null

        const requestId = nextRequestId()
        const promise = new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingManifestRequests.delete(requestId)
            resolve(null)
          }, manifestTimeoutMs)
          pendingManifestRequests.set(requestId, { resolve, timer, magnetURI, targets: new Set(targets), expected: targets.length })
        })

        await Promise.all(targets.map((pubKey) =>
          ctx.sendTo(pubKey, envelopeType, { kind: 'manifest-request', requestId, magnetURI }).catch((err) => {
            // A peer we could not even ask will never answer: stop waiting for it.
            const p = pendingManifestRequests.get(requestId)
            if (p && p.targets.delete(pubKey) && --p.expected <= 0) {
              clearTimeout(p.timer)
              pendingManifestRequests.delete(requestId)
              p.resolve(null)
            }
            log('mesh-torrent:manifest-request-send-failed', { to: pubKey, magnetURI, error: err?.message || String(err) })
          }),
        ))

        return promise
      }

      /**
       * @param {string} pubKey
       * @param {string} cid
       * @returns {Promise<Uint8Array>}
       */
      async function fetchChunkFrom(pubKey, cid) {
        const requestId = nextRequestId()
        const promise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingChunkFetches.delete(requestId)
            reject(new Error(`mesh-torrent: chunk ${cid} fetch from ${pubKey} timed out after ${chunkTimeoutMs}ms`))
          }, chunkTimeoutMs)
          pendingChunkFetches.set(requestId, { resolve, reject, timer, peer: pubKey })
        })

        try {
          await ctx.sendTo(pubKey, envelopeType, { kind: 'chunk-request', requestId, cid })
        } catch (err) {
          const pending = pendingChunkFetches.get(requestId)
          if (pending) {
            clearTimeout(pending.timer)
            pendingChunkFetches.delete(requestId)
          }
          throw err
        }

        return promise
      }

      /**
       * Fetch (and locally cache, content-hash-verified) one piece from
       * whichever known/candidate provider actually delivers it.
       * @param {string} cid
       * @param {string[]} [candidatePeers]
       * @returns {Promise<Uint8Array>}
       */
      async function fetchChunk(cid, candidatePeers) {
        const already = await chunkStore.get(cid)
        if (already) return already

        const owners = new Set([...(chunkOwners.get(cid) || []), ...(candidatePeers || [])])
        owners.delete(peerNode.podId)
        if (owners.size === 0) {
          throw new Error(`mesh-torrent: no known provider for chunk ${cid} (supply opts.peers)`)
        }

        let lastErr = null
        for (const pubKey of owners) {
          for (let attempt = 0; attempt <= busyRetries; attempt++) {
            try {
              const bytes = await fetchChunkFrom(pubKey, cid)
              if ((await ChunkStore.computeCid(bytes)) !== cid) {
                lastErr = new Error(`mesh-torrent: chunk ${cid} from ${pubKey} failed integrity verification`)
                log('mesh-torrent:chunk-integrity-failed', { cid, from: pubKey })
                break
              }
              await chunkStore.save(cid, bytes)
              recordOwner(pubKey, [cid])
              ctx.emit('torrent:chunk-received', { from: pubKey, cid, size: bytes.length })
              return bytes
            } catch (err) {
              lastErr = err
              if (err?.code === 'busy' && attempt < busyRetries) {
                await sleep(busyBackoffMs * (attempt + 1))
                continue
              }
              log('mesh-torrent:fetch-attempt-failed', { cid, from: pubKey, error: err?.message || String(err) })
              break
            }
          }
        }
        throw lastErr || new Error(`mesh-torrent: failed to fetch chunk ${cid} from any known provider`)
      }

      // -----------------------------------------------------------------
      // api.seed / api.share / api.download
      // -----------------------------------------------------------------

      /**
       * Record `manifest` as held: memory, index, and `manifestStore`.
       * @returns {Promise<void>}
       */
      async function holdManifest(magnetURI, manifest) {
        const prior = held.get(magnetURI)
        if (prior) unindexHeld(magnetURI, prior)
        held.set(magnetURI, manifest)
        remoteManifests.delete(magnetURI)
        indexHeld(magnetURI, manifest)
        await manifestStore.set(magnetURI, manifest)
      }

      /**
       * Seed content: reuses `TorrentManager.seed()` verbatim for real
       * magnet/infoHash generation and its own bookkeeping, then chunks the
       * data into this service's content-addressed piece store and records
       * a manifest, so this peer can answer `chunk-request`s for it.
       * @param {string|Uint8Array|ArrayBufferView|ArrayBuffer|Blob} data - a string is UTF-8 encoded
       * @param {object} [opts] - Forwarded to `TorrentManager.seed()`.
       * @returns {Promise<import('./peer-torrent.mjs').TorrentInfo>}
       */
      async function seed(data, opts = {}) {
        await ready
        const bytes = await toSeedBytes(data)
        const info = await tm.seed(bytes, { ...opts, chunkSize })

        // In the fallback path tm has already written the pieces and manifest
        // into the shared stores; reuse them instead of hashing twice. In the
        // real-WebTorrent path it writes nothing, so build them here.
        let manifest = await tm.getManifest(info.magnetURI)
        if (!manifest) {
          const chunkCids = await saveChunks(chunkStore, splitIntoChunks(bytes, chunkSize), (p) => ChunkStore.computeCid(p))
          manifest = {
            infoHash: info.infoHash, name: info.name, size: info.size, chunkSize, chunkCids,
            cid: await ChunkStore.computeCid(bytes),
          }
        }
        await holdManifest(info.magnetURI, manifest)
        return info
      }

      /**
       * Announce a magnetURI to specific peers, embedding this peer's
       * manifest (if it holds one) so the receiver can immediately start
       * fetching pieces -- see module doc comment's "WIRE PROTOCOL" section.
       * Delegates argument validation to `TorrentManager.shareWithPeers()`
       * itself (throws its own errors for bad `magnetURI`/`peerIds`).
       * @param {string} magnetURI
       * @param {string[]} peerIds
       */
      function share(magnetURI, peerIds) {
        const manifest = manifestFor(magnetURI)
        tm.shareWithPeers(magnetURI, peerIds, (peerId, message) => {
          ctx.sendTo(peerId, envelopeType, {
            kind: 'announce', magnetURI, manifest, info: message.info,
          }).catch((err) => {
            log('mesh-torrent:announce-send-failed', { to: peerId, magnetURI, error: err?.message || String(err) })
          })
        })
      }

      /**
       * Download content from the swarm: piece-by-piece, from whichever
       * peer(s) are known (via a prior `announce`, or `opts.peers`) to hold
       * each piece -- not necessarily the original seeder. See module doc
       * comment's "WHAT MAKES THIS A REAL SWARM" section.
       * @param {string} magnetURI
       * @param {object} [opts]
       * @param {string[]} [opts.peers] - Candidate peers to ask for the
       *   manifest (if not already known) and/or any piece with no other
       *   known provider.
       * @returns {Promise<{data: Uint8Array, info: import('./peer-torrent.mjs').TorrentInfo}>}
       */
      async function download(magnetURI, opts = {}) {
        await ready
        ctx.emit('torrent:download-start', { magnetURI })

        const manifest = manifestFor(magnetURI) || await requestManifest(magnetURI, opts.peers)
        if (!manifest) {
          throw new Error(
            `mesh-torrent: no manifest known for ${magnetURI} (no prior announce, and no peer responded -- supply opts.peers)`,
          )
        }

        const pieces = []
        for (const cid of manifest.chunkCids) {
          pieces.push(await fetchChunk(cid, opts.peers))
        }
        const data = concatChunks(pieces)
        if (data.length !== manifest.size) {
          throw new Error(
            `mesh-torrent: reassembled ${data.length} bytes but manifest for ${magnetURI} declares size ${manifest.size}`,
          )
        }
        const contentCid = await ChunkStore.computeCid(data)
        if (typeof manifest.cid === 'string' && manifest.cid !== contentCid) {
          throw new Error(`mesh-torrent: reassembled content for ${magnetURI} does not match the manifest's cid`)
        }

        // Register this peer as a full holder via TorrentManager's own
        // seed() -- genuinely correct, not a hack: a peer with every piece
        // of a torrent IS, in real BitTorrent terms, now a seed for it, and
        // content-addressing makes this self-consistent -- tm.seed() on
        // these identical bytes deterministically reproduces the SAME
        // magnetURI/infoHash (same hash, same truncation), so this doesn't
        // create a second, different torrent identity for the same content.
        // The pieces are re-cut at the size the manifest used (inferred from
        // its first piece when the announcing peer did not say), so they are
        // the ones already in the store and nothing is stored twice.
        const pieceSize = manifest.chunkSize
          ?? (pieces.length > 1 ? pieces[0].length : Math.max(data.length, 1))
        const info = await tm.seed(data, { name: manifest.name, chunkSize: pieceSize })
        if (info.magnetURI !== magnetURI) {
          log('mesh-torrent:magnet-mismatch-after-reassembly', { expected: magnetURI, got: info.magnetURI })
        }
        const stored = await tm.getManifest(info.magnetURI)
        await holdManifest(info.magnetURI, stored ?? {
          infoHash: info.infoHash, name: manifest.name, size: data.length, chunkSize: pieceSize,
          chunkCids: manifest.chunkCids, cid: contentCid,
        })
        if (info.magnetURI !== magnetURI) remoteManifests.delete(magnetURI)

        ctx.emit('torrent:download-complete', { magnetURI, name: manifest.name, size: data.length })
        return { data, info }
      }

      /** Stop serving a torrent now; its stored manifest and unshared pieces are released in the background (`flush()` waits for that). */
      function removeTorrent(magnetURI) {
        const removedByTm = tm.removeTorrent(magnetURI)
        remoteManifests.delete(magnetURI)
        const manifest = held.get(magnetURI)
        if (!manifest) return removedByTm
        held.delete(magnetURI)
        unindexHeld(magnetURI, manifest)
        track((async () => {
          await manifestStore.delete(magnetURI)
          await releaseChunks(chunkStore, manifestStore, manifest, magnetURI)
        })())
        return true
      }

      async function destroy() {
        await tm.destroy()
        await flush()
        // A store the caller injected is theirs and may be durable: leave its contents alone.
        if (!injectedChunkStore && typeof chunkStore.clear === 'function') await chunkStore.clear()
        if (!injectedManifestStore && typeof manifestStore.clear === 'function') await manifestStore.clear()
        held.clear()
        remoteManifests.clear()
        chunkIndex.clear()
        chunkOwners.clear()
      }

      async function flush() {
        await ready
        while (pendingWrites.size) await Promise.all([...pendingWrites])
      }

      const api = {
        /** Resolves once manifests persisted by an earlier run are loaded (serving and downloads wait for it internally). */
        ready,
        /** Load the underlying TorrentManager; after a reload this also restores `listTorrents()` from `manifestStore`. */
        ensureLoaded: async () => { await ready; await tm.ensureLoaded() },
        get loaded() { return tm.loaded },
        get available() { return tm.available },
        seed,
        share,
        download,
        listTorrents: () => tm.listTorrents(),
        getTorrent: (magnetURI) => tm.getTorrent(magnetURI),
        removeTorrent,
        getStats: () => tm.getStats(),
        getManifest: (magnetURI) => manifestFor(magnetURI) ?? null,
        /** @param {string} cid @returns {string[]} pubKeys this peer currently believes hold `cid`, for introspection/tests. */
        listKnownProviders: (cid) => [...(chunkOwners.get(cid) || [])],
        /** Resolves when background store writes/cleanups started by this service have finished. */
        flush,
        toJSON: () => tm.toJSON(),
        destroy,
      }

      return {
        api,
        teardown() {
          unsubscribe()
          tm.off('seed', onTmSeed)
          for (const pending of pendingManifestRequests.values()) {
            clearTimeout(pending.timer)
            pending.resolve(null)
          }
          pendingManifestRequests.clear()
          for (const pending of pendingChunkFetches.values()) {
            clearTimeout(pending.timer)
            pending.reject(new Error('mesh-torrent: service torn down while a chunk fetch was still in flight'))
          }
          pendingChunkFetches.clear()
        },
      }
    },
  }
}

export {
  DEFAULT_ENVELOPE_TYPE,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_MANIFEST_TIMEOUT_MS,
  DEFAULT_CHUNK_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_SERVES,
  DEFAULT_MAX_CONCURRENT_SERVES_PER_PEER,
  DEFAULT_MAX_BYTES_PER_PEER_PER_SEC,
  DEFAULT_MAX_ANNOUNCES_PER_PEER_PER_MINUTE,
}
