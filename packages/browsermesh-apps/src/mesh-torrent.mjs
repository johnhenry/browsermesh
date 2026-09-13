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
 * (content-addressed, SHA-256 CIDs -- see "CHUNKSTORE DURABILITY DECISION"
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
 *       -- `manifest` is `{ infoHash, name, size, chunkCids }` (undefined if
 *          the announcer doesn't actually hold the content -- see `share()`).
 *          The RECEIVER records the sender as a known provider for every
 *          `chunkCids` entry -- this is how `chunkOwners` bootstraps without
 *          a separate discovery round trip.
 *
 *   Manifest request/response (only needed if a downloader never received an
 *   `announce` for this magnetURI -- e.g. it learned the magnetURI out of
 *   band):
 *     `{ type, kind: 'manifest-request', requestId, magnetURI }`
 *     `{ type, kind: 'manifest-response', requestId, magnetURI, manifest }`
 *       -- a peer with no manifest for that magnetURI stays silent (matches
 *          `chunk-replication.mjs`'s established "don't have it" = silence
 *          convention); the requester's `requestManifest()` is timeout-bounded.
 *
 *   Chunk request/response (the actual piece exchange):
 *     `{ type, kind: 'chunk-request', requestId, cid }`
 *     `{ type, kind: 'chunk-response', requestId, cid, data }` (`data` base64)
 *       or `{ ..., error: 'not-found' }`.
 *
 * DELIBERATELY NO AUTHORIZATION GATE on any of the above (the one explicit
 * divergence from `chunk-replication.mjs`'s otherwise-identical shape, which
 * gates every chunk transfer on `registry.checkAccess()`): issue #122's own
 * framing is "swarm-distribute one large payload to many anonymous/
 * unauthorized downloaders at once" -- an admin-designated-replica-style ACL
 * gate would contradict the entire reason this module exists alongside
 * CloudStorage rather than being redundant with it. A caller that DOES want
 * access control on top of swarm distribution can still gate WHO gets handed
 * a magnetURI in the first place (outside this file, e.g. via `api.share()`'s
 * explicit `peerIds` list) -- once a peer legitimately has a magnetURI, this
 * protocol does not additionally gate serving its pieces.
 *
 * Every fetched chunk is verified against its own CID (`ChunkStore.verify()`)
 * before being trusted/stored/re-served -- content-addressing's integrity
 * property holds regardless of which swarm peer relayed a piece, exactly
 * `chunk-replication.mjs`'s own reasoning for why its wire messages need no
 * signature.
 *
 * ---------------------------------------------------------------------------
 * CHUNKSTORE DURABILITY DECISION (explicitly flagged as open by the
 * migration plan's Phase 5 section -- resolved here, not left arbitrary):
 *
 * This file's own piece store uses the in-memory `ChunkStore`
 * (`@johnhenry/browsermesh-sync`'s `files.mjs`), NOT the durable
 * `IndexedDBChunkStore` (`storage-indexeddb-chunks.mjs`) CloudStorage uses.
 * Reasoning, concretely:
 *
 *   - Torrent-style swarm participation is inherently ephemeral BY DESIGN,
 *     not by accident: a peer seeds or downloads while it's online and
 *     interested; once it closes the tab, there is no expectation -- in
 *     real BitTorrent OR here -- that its pieces "belong" to it across a
 *     reload the way a CloudStorage object durably belongs to a bucket.
 *     Nothing reads this file's `ChunkStore` as a source of truth the way
 *     `CloudStorageBackend` treats its manifest+chunks; losing it on reload
 *     just means this peer re-fetches pieces from the swarm next time it's
 *     relevant, exactly the self-healing property a swarm is supposed to
 *     have.
 *   - The counter-argument is real and was weighed: a peer mid-download
 *     that reloads loses partial progress, and a long-lived seeder loses
 *     its ability to serve after a reload without re-seeding. Both are
 *     genuine costs, not nothing.
 *   - But `TorrentManager` ITSELF already made this exact call for its own
 *     `FallbackStore` (`peer-torrent.mjs`, unmodified by this phase) -- it's
 *     a private in-memory `Map`, same non-durable shape, same module. Making
 *     ONLY this file's piece store durable while the class it wraps stays
 *     resolutely in-memory would produce a torrent service that's durable
 *     exactly until `tm.seed()`'s own bookkeeping (magnetURI/infoHash
 *     generation, `listTorrents()`, `getStats()`) resets on reload anyway --
 *     inconsistent durability that doesn't actually deliver "survives a
 *     reload" for the feature as a whole, only for raw chunk bytes with no
 *     index pointing at them.
 *   - Per the plan's own explicit guidance for this exact decision ("if
 *     unsure, default to keeping in-memory `ChunkStore` as the lower-risk,
 *     smaller change"): this is the call made here. A future revision that
 *     wants "resume a partial download/reseed after reload" as a real,
 *     deliberate feature should swap BOTH this file's chunk store AND
 *     `TorrentManager`'s own `FallbackStore`/`#activeTorrents` together, as
 *     one coherent durability upgrade -- not something to back into
 *     one-sidedly here.
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
 *
 * No browser-only imports at module level.
 */

import { TorrentManager } from './peer-torrent.mjs'
import { ChunkStore } from '@johnhenry/browsermesh-sync'

/** Default `envelope.type` used to route all mesh-torrent wire traffic. */
const DEFAULT_ENVELOPE_TYPE = 'mesh-torrent'

/** Default piece size for this file's own chunking (independent of `TorrentManager`'s own, unused-in-fallback, `TORRENT_DEFAULTS.chunkSize` constant -- same numeric default, 64KB). */
const DEFAULT_CHUNK_SIZE = 65536

/** How long `requestManifest()` waits for the first `manifest-response` before giving up. */
const DEFAULT_MANIFEST_TIMEOUT_MS = 5000

/** How long a single `fetchChunkFrom()` call waits for its `chunk-response` before treating that peer as unreachable for this attempt. */
const DEFAULT_CHUNK_TIMEOUT_MS = 5000

// ---------------------------------------------------------------------------
// Base64 helpers -- deliberately duplicated rather than shared, matching
// this family's established convention (see chunk-replication.mjs's /
// cloud-storage-backend.mjs's own identical duplication).
// ---------------------------------------------------------------------------

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
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
 * Normalize seed() input to a Uint8Array for chunking/hashing. Unlike
 * `TorrentManager.seed()` itself (which also tolerates a `Blob`, for its
 * real-WebTorrent browser path), this file's own manifest/piece-exchange
 * logic needs synchronous byte access, so a `Blob` is not supported here.
 * @param {Uint8Array|ArrayBuffer} data
 * @returns {Uint8Array}
 */
function normalizeToUint8Array(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  throw new Error(
    'mesh-torrent: seed() requires Uint8Array or ArrayBuffer data for this service\'s own ' +
    'chunking/manifest logic (a Blob is only usable via TorrentManager\'s own real-WebTorrent path directly).',
  )
}

/**
 * @param {Uint8Array} bytes
 * @param {number} chunkSize
 * @returns {Uint8Array[]}
 */
function splitIntoChunks(bytes, chunkSize) {
  const pieces = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    pieces.push(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  }
  return pieces
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
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createTorrentService({
  trackerUrl,
  chunkSize = DEFAULT_CHUNK_SIZE,
  envelopeType = DEFAULT_ENVELOPE_TYPE,
  manifestTimeoutMs = DEFAULT_MANIFEST_TIMEOUT_MS,
  chunkTimeoutMs = DEFAULT_CHUNK_TIMEOUT_MS,
  onLog,
} = {}) {
  const log = onLog || (() => {})

  return {
    name: 'torrent',

    attach(peerNode, ctx) {
      const tm = new TorrentManager({
        trackerUrl,
        onLog: (level, msg) => log('mesh-torrent:internal', { level, msg }),
      })

      /** This file's own piece store -- see module doc comment's "CHUNKSTORE DURABILITY DECISION". */
      const chunkStore = new ChunkStore()

      /** @type {Map<string, {infoHash: string, name: string, size: number, chunkCids: string[]}>} magnetURI -> manifest */
      const manifests = new Map()

      /** @type {Map<string, Set<string>>} cid -> pubKeys known to currently hold that piece */
      const chunkOwners = new Map()

      let reqSeq = 0
      const nextRequestId = () => `${peerNode.podId}:${Date.now()}:${++reqSeq}`

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
      // In-flight request tracking
      // -----------------------------------------------------------------

      /** @type {Map<string, {resolve: (manifest: object|null) => void, timer: ReturnType<typeof setTimeout>, magnetURI: string}>} */
      const pendingManifestRequests = new Map()

      /** @type {Map<string, {resolve: (bytes: Uint8Array) => void, reject: (err: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
      const pendingChunkFetches = new Map()

      // -----------------------------------------------------------------
      // Inbound dispatch
      // -----------------------------------------------------------------

      function handleAnnounce(fromPubKey, msg) {
        if (typeof msg.magnetURI !== 'string') return
        if (msg.manifest && Array.isArray(msg.manifest.chunkCids)) {
          manifests.set(msg.magnetURI, msg.manifest)
          recordOwner(fromPubKey, msg.manifest.chunkCids)
        }
        ctx.emit('torrent:announce-received', {
          from: fromPubKey,
          magnetURI: msg.magnetURI,
          name: msg.manifest?.name ?? msg.info?.name,
        })
      }

      function handleManifestRequest(fromPubKey, msg) {
        if (typeof msg.magnetURI !== 'string' || typeof msg.requestId !== 'string') return
        const manifest = manifests.get(msg.magnetURI)
        if (!manifest) return // silent "don't have it" -- matches chunk-replication.mjs's own convention
        ctx.sendTo(fromPubKey, envelopeType, {
          kind: 'manifest-response', requestId: msg.requestId, magnetURI: msg.magnetURI, manifest,
        }).catch((err) => {
          log('mesh-torrent:manifest-response-send-failed', { to: fromPubKey, magnetURI: msg.magnetURI, error: err?.message || String(err) })
        })
      }

      function handleManifestResponse(fromPubKey, msg) {
        const pending = pendingManifestRequests.get(msg.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingManifestRequests.delete(msg.requestId)
        if (msg.manifest && Array.isArray(msg.manifest.chunkCids)) {
          manifests.set(pending.magnetURI, msg.manifest)
          recordOwner(fromPubKey, msg.manifest.chunkCids)
        }
        pending.resolve(msg.manifest || null)
      }

      async function handleChunkRequest(fromPubKey, msg) {
        if (typeof msg.cid !== 'string' || typeof msg.requestId !== 'string') return
        const bytes = chunkStore.get(msg.cid)
        if (!bytes) {
          await ctx.sendTo(fromPubKey, envelopeType, {
            kind: 'chunk-response', requestId: msg.requestId, cid: msg.cid, error: 'not-found',
          }).catch(() => {})
          return
        }
        await ctx.sendTo(fromPubKey, envelopeType, {
          kind: 'chunk-response', requestId: msg.requestId, cid: msg.cid, data: toBase64(bytes),
        }).catch((err) => {
          log('mesh-torrent:chunk-response-send-failed', { to: fromPubKey, cid: msg.cid, error: err?.message || String(err) })
        })
        ctx.emit('torrent:chunk-served', { to: fromPubKey, cid: msg.cid, size: bytes.length })
      }

      function handleChunkResponse(fromPubKey, msg) {
        const pending = pendingChunkFetches.get(msg.requestId)
        if (!pending) return
        clearTimeout(pending.timer)
        pendingChunkFetches.delete(msg.requestId)
        if (msg.error) {
          pending.reject(new Error(`mesh-torrent: chunk ${msg.cid} fetch from ${fromPubKey} failed: ${msg.error}`))
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
        const known = manifests.get(magnetURI)
        if (known) return known
        const targets = candidatePeers && candidatePeers.length ? candidatePeers : []
        if (targets.length === 0) return null

        const requestId = nextRequestId()
        const promise = new Promise((resolve) => {
          const timer = setTimeout(() => {
            pendingManifestRequests.delete(requestId)
            resolve(null)
          }, manifestTimeoutMs)
          pendingManifestRequests.set(requestId, { resolve, timer, magnetURI })
        })

        await Promise.all(targets.map((pubKey) =>
          ctx.sendTo(pubKey, envelopeType, { kind: 'manifest-request', requestId, magnetURI }).catch((err) => {
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
          pendingChunkFetches.set(requestId, { resolve, reject, timer })
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
        const already = chunkStore.get(cid)
        if (already) return already

        const owners = new Set([...(chunkOwners.get(cid) || []), ...(candidatePeers || [])])
        if (owners.size === 0) {
          throw new Error(`mesh-torrent: no known provider for chunk ${cid} (supply opts.peers)`)
        }

        let lastErr = null
        for (const pubKey of owners) {
          try {
            const bytes = await fetchChunkFrom(pubKey, cid)
            const valid = await chunkStore.verify(cid, bytes)
            if (!valid) {
              lastErr = new Error(`mesh-torrent: chunk ${cid} from ${pubKey} failed integrity verification`)
              log('mesh-torrent:chunk-integrity-failed', { cid, from: pubKey })
              continue
            }
            chunkStore.save(cid, bytes)
            recordOwner(pubKey, [cid])
            ctx.emit('torrent:chunk-received', { from: pubKey, cid, size: bytes.length })
            return bytes
          } catch (err) {
            lastErr = err
            log('mesh-torrent:fetch-attempt-failed', { cid, from: pubKey, error: err?.message || String(err) })
          }
        }
        throw lastErr || new Error(`mesh-torrent: failed to fetch chunk ${cid} from any known provider`)
      }

      // -----------------------------------------------------------------
      // api.seed / api.share / api.download
      // -----------------------------------------------------------------

      /**
       * Seed content: reuses `TorrentManager.seed()` verbatim for real
       * magnet/infoHash generation and its own bookkeeping, then chunks the
       * data into this file's own content-addressed piece store and records
       * a manifest, so this peer can answer `chunk-request`s for it.
       * @param {Uint8Array|ArrayBuffer} data
       * @param {object} [opts] - Forwarded to `TorrentManager.seed()`.
       * @returns {Promise<import('./peer-torrent.mjs').TorrentInfo>}
       */
      async function seed(data, opts = {}) {
        const bytes = normalizeToUint8Array(data)
        const info = await tm.seed(data, opts)

        const chunkCids = []
        for (const piece of splitIntoChunks(bytes, chunkSize)) {
          const cid = await ChunkStore.computeCid(piece)
          chunkStore.save(cid, piece)
          chunkCids.push(cid)
        }

        manifests.set(info.magnetURI, { infoHash: info.infoHash, name: info.name, size: info.size, chunkCids })
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
        const manifest = manifests.get(magnetURI)
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
        ctx.emit('torrent:download-start', { magnetURI })

        const manifest = manifests.get(magnetURI) || await requestManifest(magnetURI, opts.peers)
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

        // Register this peer as a full holder via TorrentManager's own
        // seed() -- genuinely correct, not a hack: a peer with every piece
        // of a torrent IS, in real BitTorrent terms, now a seed for it, and
        // content-addressing makes this self-consistent -- tm.seed() on
        // these identical bytes deterministically reproduces the SAME
        // magnetURI/infoHash (same hash, same truncation), so this doesn't
        // create a second, different torrent identity for the same content.
        const info = await tm.seed(data, { name: manifest.name })
        if (info.magnetURI !== magnetURI) {
          log('mesh-torrent:magnet-mismatch-after-reassembly', { expected: magnetURI, got: info.magnetURI })
        }

        ctx.emit('torrent:download-complete', { magnetURI, name: manifest.name, size: data.length })
        return { data, info }
      }

      async function destroy() {
        await tm.destroy()
        chunkStore.clear()
        manifests.clear()
        chunkOwners.clear()
      }

      const api = {
        ensureLoaded: () => tm.ensureLoaded(),
        get loaded() { return tm.loaded },
        get available() { return tm.available },
        seed,
        share,
        download,
        listTorrents: () => tm.listTorrents(),
        getTorrent: (magnetURI) => tm.getTorrent(magnetURI),
        removeTorrent: (magnetURI) => {
          const removed = tm.removeTorrent(magnetURI)
          manifests.delete(magnetURI)
          return removed
        },
        getStats: () => tm.getStats(),
        getManifest: (magnetURI) => manifests.get(magnetURI) ?? null,
        /** @param {string} cid @returns {string[]} pubKeys this peer currently believes hold `cid`, for introspection/tests. */
        listKnownProviders: (cid) => [...(chunkOwners.get(cid) || [])],
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
}
