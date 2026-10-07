/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-peer-torrent.js -- WebTorrent integration for P2P file distribution.
 *
 * CDN-loads webtorrent browser bundle for swarm-based file sharing.
 * Falls back to direct chunked transfer when WebTorrent unavailable.
 *
 * DURABILITY (fallback path only): by default the fallback keeps whole blobs
 * in a private in-memory map. Pass `chunkStore` and/or `manifestStore`
 * (the same objects you give `createTorrentService()` in mesh-torrent.mjs)
 * and the fallback instead stores content as SHA-256-addressed pieces in
 * `chunkStore` plus one manifest per torrent in `manifestStore`, and
 * `ensureLoaded()` restores `listTorrents()` from the manifests -- so seeded
 * content survives a reload when those stores are durable (for example
 * `IndexedDBChunkStore` from browsermesh-sync). Injected stores belong to the
 * caller: `destroy()` never clears them. The real-WebTorrent path keeps its
 * own storage and ignores both.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-torrent.test.mjs
 */

import { ChunkStore } from '@johnhenry/browsermesh-sync'
import {
  MemoryManifestStore,
  toSeedBytes,
  releaseChunks,
  splitIntoChunks,
  saveChunks,
} from './internal/torrent-store.mjs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TORRENT_DEFAULTS = Object.freeze({
  chunkSize: 65536,           // 64KB chunks
  maxPeers: 10,
  announceIntervalMs: 30000,
  trackerUrl: null,           // Use signaling server as tracker if set
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _torrentIdCounter = 0

function generateInfoHash() {
  return `hash_${Date.now().toString(36)}_${(++_torrentIdCounter).toString(36)}`
}

function generateMagnetURI(infoHash) {
  return `magnet:?xt=urn:btih:${infoHash}`
}

function infoHashFromMagnet(magnetURI) {
  const match = magnetURI.match(/btih:([^&]+)/)
  return match ? match[1] : null
}

// ---------------------------------------------------------------------------
// TorrentInfo
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TorrentInfo
 * @property {string} magnetURI
 * @property {string} infoHash
 * @property {string} name
 * @property {number} size
 * @property {number} peers
 * @property {number} progress  - 0-1
 * @property {number} speed     - bytes/sec
 * @property {'seeding'|'downloading'|'paused'} state
 */

// ---------------------------------------------------------------------------
// FallbackStore — used when WebTorrent is not available
// ---------------------------------------------------------------------------

/**
 * Simple in-memory store keyed by infoHash. Provides seed/download
 * semantics without actual BitTorrent protocol.
 */
class FallbackStore {
  #data = new Map()   // infoHash -> { data: Uint8Array, name, size }

  set(infoHash, entry) {
    this.#data.set(infoHash, entry)
  }

  get(infoHash) {
    return this.#data.get(infoHash) || null
  }

  has(infoHash) {
    return this.#data.has(infoHash)
  }

  delete(infoHash) {
    return this.#data.delete(infoHash)
  }

  values() {
    return [...this.#data.values()]
  }

  get size() {
    return this.#data.size
  }

  clear() {
    this.#data.clear()
  }
}

// ---------------------------------------------------------------------------
// TorrentManager
// ---------------------------------------------------------------------------

/**
 * Manages WebTorrent-based file sharing across the mesh.
 *
 * When WebTorrent is available (browser with CDN access), uses real
 * BitTorrent swarming. When unavailable (Node.js tests, offline), falls
 * back to an in-memory store that mimics the seed/download API.
 */
export class TorrentManager {
  /** @type {object|null} WebTorrent client instance (lazy-loaded) */
  #client = null

  /** @type {Map<string, TorrentInfo>} magnetURI -> TorrentInfo */
  #activeTorrents = new Map()

  /** @type {string|null} */
  #trackerUrl

  /** @type {boolean} */
  #loaded = false

  /** @type {boolean} */
  #wtAvailable = false

  /** @type {FallbackStore} */
  #fallback = new FallbackStore()

  /** Injected (or defaulted, when only one was injected) piece store; null = legacy in-memory blob map. */
  #chunkStore = null

  /** @type {object|null} manifest store paired with #chunkStore */
  #manifestStore = null

  /** @type {number} piece size used when writing to #chunkStore */
  #chunkSize

  /** @type {Set<Promise<void>>} in-flight best-effort store cleanups */
  #cleanups = new Set()

  /** @type {Function} */
  #onLog

  /** @type {Map<string, Set<Function>>} event -> callbacks */
  #listeners = new Map()

  /** @type {number} */
  #totalDown = 0

  /** @type {number} */
  #totalUp = 0

  /**
   * @param {object} [opts]
   * @param {string} [opts.trackerUrl] - Custom tracker URL
   * @param {Function} [opts.onLog] - Logging callback
   * @param {object} [opts.chunkStore] - Piece store with the `ChunkStore`
   *   contract (`save/get/has/remove`, sync or async), e.g. browsermesh-sync's
   *   `IndexedDBChunkStore`. Fallback path only; see the module comment.
   * @param {object} [opts.manifestStore] - `{ get, set, delete, entries }`
   *   keyed by magnet URI (sync or async). Defaults to in-memory when only
   *   `chunkStore` is given.
   * @param {number} [opts.chunkSize=65536] - Piece size when `chunkStore` is used.
   */
  constructor(opts = {}) {
    this.#trackerUrl = opts.trackerUrl ?? TORRENT_DEFAULTS.trackerUrl
    this.#onLog = opts.onLog || (() => {})
    this.#chunkSize = opts.chunkSize ?? TORRENT_DEFAULTS.chunkSize
    if (opts.chunkStore || opts.manifestStore) {
      this.#chunkStore = opts.chunkStore || new ChunkStore()
      this.#manifestStore = opts.manifestStore || new MemoryManifestStore()
    }
  }

  // ── CDN Loading ──────────────────────────────────────────────────────

  /**
   * Lazy-load WebTorrent from CDN.
   * Sets #wtAvailable based on whether the load succeeded.
   */
  async ensureLoaded() {
    if (this.#loaded) return

    try {
      // Only attempt in browser-like environments with dynamic import support
      if (typeof window !== 'undefined' && typeof window.WebTorrent === 'function') {
        this.#client = new window.WebTorrent()
        this.#wtAvailable = true
        this.#onLog(2, 'WebTorrent client initialized from window.WebTorrent')
      } else if (typeof globalThis.WebTorrent === 'function') {
        this.#client = new globalThis.WebTorrent()
        this.#wtAvailable = true
        this.#onLog(2, 'WebTorrent client initialized from globalThis.WebTorrent')
      } else {
        // Try CDN load via esm.sh — this will fail in Node.js test env
        try {
          const mod = await import('https://esm.sh/webtorrent@2.8.5')
          const WT = mod.default || mod.WebTorrent
          if (typeof WT === 'function') {
            globalThis.WebTorrent = WT
            this.#client = new WT()
            this.#wtAvailable = true
            this.#onLog(2, 'WebTorrent loaded from CDN (esm.sh)')
          }
        } catch {
          this.#wtAvailable = false
          this.#onLog(1, 'WebTorrent CDN load failed — using fallback store')
        }
      }
    } catch (err) {
      this.#wtAvailable = false
      this.#onLog(1, `WebTorrent initialization failed: ${err.message}`)
    }

    this.#loaded = true

    if (!this.#wtAvailable && this.#manifestStore) {
      try {
        await this.#restoreFromStores()
      } catch (err) {
        this.#onLog(1, `Restoring torrents from manifestStore failed: ${err.message}`)
      }
    }
  }

  /** Rebuild #activeTorrents from persisted manifests (fallback path only). */
  async #restoreFromStores() {
    for (const [magnetURI, m] of await this.#manifestStore.entries()) {
      if (!m || this.#activeTorrents.has(magnetURI)) continue
      this.#activeTorrents.set(magnetURI, {
        magnetURI,
        infoHash: m.infoHash,
        name: m.name,
        size: m.size,
        peers: 0,
        progress: 1,
        speed: 0,
        state: 'seeding',
      })
    }
  }

  /** Whether ensureLoaded() has been called. */
  get loaded() {
    return this.#loaded
  }

  /** Whether WebTorrent is usable (true only after successful load). */
  get available() {
    return this.#wtAvailable
  }

  // ── Seed ─────────────────────────────────────────────────────────────

  /**
   * Seed a file — make it available for download.
   *
   * @param {string|Uint8Array|ArrayBufferView|Blob|ArrayBuffer} data - File
   *   content. A string is encoded as UTF-8; anything that is not one of the
   *   listed types throws a `TypeError` (it is never seeded as empty content).
   * @param {object} [opts]
   * @param {string} [opts.name] - File name
   * @param {string[]} [opts.announce] - Tracker URLs
   * @param {number} [opts.chunkSize] - Piece size for this torrent when
   *   `chunkStore` is injected (default: the constructor's `chunkSize`).
   * @returns {Promise<TorrentInfo>}
   */
  async seed(data, opts = {}) {
    if (!this.#loaded) await this.ensureLoaded()

    const rawData = await toSeedBytes(data)

    const name = opts.name || `file_${Date.now()}`
    const size = rawData.byteLength

    // Real WebTorrent path
    if (this.#wtAvailable && this.#client) {
      return this.#seedReal(rawData, name, size, opts)
    }

    // Fallback: generate pseudo-torrent info
    return this.#seedFallback(rawData, name, size, opts)
  }

  /**
   * Seed via real WebTorrent client.
   * @returns {Promise<TorrentInfo>}
   */
  #seedReal(data, name, size, opts) {
    return new Promise((resolve, reject) => {
      const seedOpts = {}
      if (opts.announce || this.#trackerUrl) {
        seedOpts.announce = opts.announce || [this.#trackerUrl]
      }

      const file = new File([data], name)
      try {
        const torrent = this.#client.seed(file, seedOpts, (torrent) => {
          const info = {
            magnetURI: torrent.magnetURI,
            infoHash: torrent.infoHash,
            name,
            size,
            peers: 0,
            progress: 1,
            speed: 0,
            state: 'seeding',
          }
          this.#activeTorrents.set(info.magnetURI, info)
          this.#totalUp += size
          this.#emit('seed', info)
          resolve(info)
        })
        if (torrent && torrent.on) {
          torrent.on('error', (err) => reject(err))
        }
      } catch (err) {
        reject(err)
      }
    })
  }

  /**
   * Seed via fallback in-memory store.
   * @returns {Promise<TorrentInfo>}
   */
  async #seedFallback(data, name, size, opts = {}) {
    const bytes = data
    const cid = await ChunkStore.computeCid(bytes)
    const infoHash = cid.slice(0, 40) // Use first 40 hex chars as pseudo info hash
    const magnetURI = generateMagnetURI(infoHash)

    if (this.#chunkStore) {
      const chunkSize = opts.chunkSize ?? this.#chunkSize
      const chunkCids = await saveChunks(this.#chunkStore, splitIntoChunks(bytes, chunkSize), (p) => ChunkStore.computeCid(p))
      await this.#manifestStore.set(magnetURI, { infoHash, name, size, chunkSize, chunkCids, cid })
    } else {
      this.#fallback.set(infoHash, { data: bytes, name, size })
    }

    const info = {
      magnetURI,
      infoHash,
      name,
      size,
      peers: 0,
      progress: 1,
      speed: 0,
      state: 'seeding',
    }
    this.#activeTorrents.set(magnetURI, info)
    this.#totalUp += size
    this.#emit('seed', info)
    return info
  }

  // ── Download ─────────────────────────────────────────────────────────

  /**
   * Download a file by magnet URI.
   *
   * @param {string} magnetURI
   * @param {object} [opts]
   * @param {number} [opts.timeout] - Download timeout in ms
   * @param {Function} [opts.onProgress] - Progress callback (0-1)
   * @returns {Promise<{ data: Uint8Array, info: TorrentInfo }>}
   */
  async download(magnetURI, opts = {}) {
    if (!this.#loaded) await this.ensureLoaded()

    // Real WebTorrent path
    if (this.#wtAvailable && this.#client) {
      return this.#downloadReal(magnetURI, opts)
    }

    // Fallback: look up in memory store
    return this.#downloadFallback(magnetURI, opts)
  }

  /**
   * Download via real WebTorrent client.
   * @returns {Promise<{ data: Uint8Array, info: TorrentInfo }>}
   */
  #downloadReal(magnetURI, opts) {
    return new Promise((resolve, reject) => {
      const timeout = opts.timeout || 60000
      const timer = setTimeout(() => {
        reject(new Error(`Download timed out after ${timeout}ms`))
      }, timeout)

      this.#emit('download:start', { magnetURI })

      try {
        const torrent = this.#client.add(magnetURI, (torrent) => {
          torrent.on('download', () => {
            if (opts.onProgress) {
              opts.onProgress(torrent.progress)
            }
          })

          torrent.on('done', () => {
            clearTimeout(timer)
            const file = torrent.files[0]
            if (!file) {
              reject(new Error('Torrent has no files'))
              return
            }
            file.getBuffer((err, buffer) => {
              if (err) {
                reject(err)
                return
              }
              const data = new Uint8Array(buffer)
              const info = {
                magnetURI,
                infoHash: torrent.infoHash,
                name: file.name,
                size: file.length,
                peers: torrent.numPeers,
                progress: 1,
                speed: 0,
                state: 'seeding',
              }
              this.#activeTorrents.set(magnetURI, info)
              this.#totalDown += data.length
              this.#emit('download:complete', info)
              resolve({ data, info })
            })
          })
        })
        if (torrent && torrent.on) {
          torrent.on('error', (err) => {
            clearTimeout(timer)
            reject(err)
          })
        }
      } catch (err) {
        clearTimeout(timer)
        reject(err)
      }
    })
  }

  /**
   * Download via fallback in-memory store.
   * @returns {Promise<{ data: Uint8Array, info: TorrentInfo }>}
   */
  async #downloadFallback(magnetURI, opts) {
    const infoHash = infoHashFromMagnet(magnetURI)
    if (!infoHash) {
      throw new Error(`Invalid magnet URI: ${magnetURI}`)
    }

    this.#emit('download:start', { magnetURI })

    const entry = this.#chunkStore
      ? await this.#readFromStores(infoHash, magnetURI)
      : this.#fallback.get(infoHash)
    if (!entry) {
      throw new Error(`Content not found for magnet: ${magnetURI}`)
    }

    if (opts.onProgress) {
      opts.onProgress(1)
    }

    const info = {
      magnetURI,
      infoHash,
      name: entry.name,
      size: entry.size,
      peers: 0,
      progress: 1,
      speed: 0,
      state: 'seeding',
    }
    this.#activeTorrents.set(magnetURI, info)
    this.#totalDown += entry.size
    this.#emit('download:complete', info)
    return { data: entry.data, info }
  }

  /**
   * The stored manifest for a torrent seeded through the injected stores:
   * `{ infoHash, name, size, chunkSize, chunkCids, cid }`, or `null` when no
   * stores were injected, the torrent is unknown, or the real-WebTorrent path
   * is in use (which keeps its own storage).
   *
   * @param {string} magnetURI
   * @returns {Promise<object|null>}
   */
  async getManifest(magnetURI) {
    if (!this.#manifestStore) return null
    return (await this.#manifestStore.get(magnetURI)) ?? null
  }

  /**
   * Reassemble a torrent's bytes from the injected stores.
   * @returns {Promise<{ data: Uint8Array, name: string, size: number }|null>} null when no manifest is held
   */
  async #readFromStores(infoHash, magnetURI) {
    const manifest = await this.#manifestStore.get(generateMagnetURI(infoHash))
      ?? await this.#manifestStore.get(magnetURI)
    if (!manifest) return null
    const data = new Uint8Array(manifest.size)
    let offset = 0
    for (const cid of manifest.chunkCids) {
      const piece = await this.#chunkStore.get(cid)
      if (!piece) throw new Error(`Content incomplete for magnet ${magnetURI}: piece ${cid} is missing from the chunk store`)
      if (!(await ChunkStore.computeCid(piece) === cid)) {
        throw new Error(`Content corrupt for magnet ${magnetURI}: piece ${cid} failed integrity verification`)
      }
      data.set(piece, offset)
      offset += piece.length
    }
    if (offset !== manifest.size) {
      throw new Error(`Content incomplete for magnet ${magnetURI}: ${offset} of ${manifest.size} bytes present`)
    }
    return { data, name: manifest.name, size: manifest.size }
  }

  // ── Mesh sharing ─────────────────────────────────────────────────────

  /**
   * Share a magnet URI with specific peers via the mesh.
   *
   * @param {string} magnetURI - The magnet URI to share
   * @param {string[]} peerIds - Peer IDs to notify
   * @param {Function} sendFn - (peerId, message) => void
   */
  shareWithPeers(magnetURI, peerIds, sendFn) {
    if (!magnetURI || typeof magnetURI !== 'string') {
      throw new Error('magnetURI is required')
    }
    if (!Array.isArray(peerIds)) {
      throw new Error('peerIds must be an array')
    }
    if (typeof sendFn !== 'function') {
      throw new Error('sendFn must be a function')
    }

    const info = this.#activeTorrents.get(magnetURI) || null
    const message = {
      type: 'torrent:share',
      magnetURI,
      info: info ? { name: info.name, size: info.size } : null,
    }

    for (const peerId of peerIds) {
      sendFn(peerId, message)
    }

    this.#onLog(2, `Shared magnet with ${peerIds.length} peers: ${magnetURI}`)
  }

  // ── Query ────────────────────────────────────────────────────────────

  /**
   * List all active torrents.
   * @returns {TorrentInfo[]}
   */
  listTorrents() {
    return [...this.#activeTorrents.values()]
  }

  /**
   * Get a specific torrent by magnet URI.
   * @param {string} magnetURI
   * @returns {TorrentInfo|null}
   */
  getTorrent(magnetURI) {
    return this.#activeTorrents.get(magnetURI) || null
  }

  /**
   * Remove a torrent.
   *
   * @param {string} magnetURI
   * @returns {boolean}
   */
  removeTorrent(magnetURI) {
    const info = this.#activeTorrents.get(magnetURI)
    if (!info) return false

    // Remove from real client if available
    if (this.#wtAvailable && this.#client) {
      try {
        this.#client.remove(magnetURI)
      } catch {
        // may already be removed
      }
    }

    // Remove from fallback store
    const infoHash = infoHashFromMagnet(magnetURI)
    if (infoHash) {
      this.#fallback.delete(infoHash)
    }

    // Injected stores: drop the manifest, then any pieces no other torrent
    // still lists. Best-effort and asynchronous (the return value stays sync).
    if (this.#chunkStore) {
      const cleanup = (async () => {
        const manifest = await this.#manifestStore.get(magnetURI)
        if (!manifest) return
        await this.#manifestStore.delete(magnetURI)
        await releaseChunks(this.#chunkStore, this.#manifestStore, manifest, magnetURI)
      })().catch((err) => this.#onLog(1, `Store cleanup failed for ${magnetURI}: ${err.message}`))
        .finally(() => this.#cleanups.delete(cleanup))
      this.#cleanups.add(cleanup)
    }

    this.#activeTorrents.delete(magnetURI)
    return true
  }

  // ── Stats ────────────────────────────────────────────────────────────

  /**
   * Get aggregated download/upload stats.
   *
   * @returns {{ downloading: number, seeding: number, totalDown: number, totalUp: number }}
   */
  getStats() {
    let downloading = 0
    let seeding = 0

    for (const info of this.#activeTorrents.values()) {
      if (info.state === 'downloading') downloading++
      if (info.state === 'seeding') seeding++
    }

    return {
      downloading,
      seeding,
      totalDown: this.#totalDown,
      totalUp: this.#totalUp,
    }
  }

  // ── Events ───────────────────────────────────────────────────────────

  /**
   * Register an event listener.
   * Events: 'seed', 'download:start', 'download:complete', 'error'
   *
   * @param {string} event
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set())
    }
    this.#listeners.get(event).add(cb)
  }

  /**
   * Remove an event listener.
   *
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const set = this.#listeners.get(event)
    if (set) set.delete(cb)
  }

  /**
   * Emit an event to all registered listeners.
   * @param {string} event
   * @param {*} data
   */
  #emit(event, data) {
    const set = this.#listeners.get(event)
    if (set) {
      for (const cb of [...set]) {
        try {
          cb(data)
        } catch (err) {
          this.#onLog(0, `Event listener error (${event}): ${err.message}`)
        }
      }
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Destroy the manager: forget all torrents in memory, close the client.
   * Content in injected `chunkStore`/`manifestStore` is left intact.
   */
  async destroy() {
    // Let any in-flight removeTorrent() store cleanup finish first. Injected
    // stores themselves are never cleared: they belong to the caller.
    await Promise.all([...this.#cleanups])

    // Clear active torrents
    this.#activeTorrents.clear()
    this.#fallback.clear()
    this.#listeners.clear()

    // Destroy real client if present
    if (this.#client) {
      try {
        await new Promise((resolve, reject) => {
          this.#client.destroy((err) => {
            if (err) reject(err)
            else resolve()
          })
        })
      } catch {
        // best effort
      }
      this.#client = null
    }

    this.#loaded = false
    this.#wtAvailable = false
    this.#totalDown = 0
    this.#totalUp = 0
  }

  // ── Serialization ────────────────────────────────────────────────────

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      loaded: this.#loaded,
      available: this.#wtAvailable,
      trackerUrl: this.#trackerUrl,
      activeTorrents: [...this.#activeTorrents.entries()].map(([uri, info]) => ({
        magnetURI: uri,
        ...info,
      })),
      stats: this.getStats(),
    }
  }
}
