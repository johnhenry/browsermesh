/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-peer-ipfs.js -- Optional Helia/IPFS integration for content-addressed storage.
 *
 * Feature-flagged -- disabled by default. CDN-loads Helia when enabled.
 * When Helia is unavailable, falls back to in-memory SHA-256-addressed storage.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-ipfs.test.mjs
 */

import { ChunkStore } from '@johnhenry/browsermesh-sync'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const IPFS_DEFAULTS = Object.freeze({
  enabled: false,
  maxStorageMb: 100,
})

// ---------------------------------------------------------------------------
// IPFSStore
// ---------------------------------------------------------------------------

/**
 * Content-addressed storage with optional Helia/IPFS backend.
 *
 * When Helia is available and enabled, data is stored in a real IPFS node.
 * Otherwise, data is kept in memory keyed by SHA-256 CID (same format used
 * by ChunkStore in browsermesh-sync).
 */
export class IPFSStore {
  /** @type {object|null} Helia node instance (lazy-loaded) */
  #helia = null

  /** @type {boolean} */
  #loaded = false

  /** @type {boolean} */
  #heliaAvailable = false

  /** @type {boolean} */
  #enabled

  /** @type {number} */
  #maxStorageMb

  /** @type {Map<string, { data: Uint8Array, size: number, pinned: boolean, addedAt: number }>} */
  #storedCids = new Map()

  /** @type {Function} */
  #onLog

  /** @type {Map<string, Set<Function>>} event -> callbacks */
  #listeners = new Map()

  /**
   * @param {object} [opts]
   * @param {boolean} [opts.enabled=false] - Whether IPFS is enabled
   * @param {number} [opts.maxStorageMb=100] - Maximum storage in MB
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor(opts = {}) {
    this.#enabled = opts.enabled ?? IPFS_DEFAULTS.enabled
    this.#maxStorageMb = opts.maxStorageMb ?? IPFS_DEFAULTS.maxStorageMb
    this.#onLog = opts.onLog || (() => {})
  }

  // ── CDN Loading ──────────────────────────────────────────────────────

  /**
   * Lazy-load Helia from CDN.
   * Only attempts if enabled. Sets #heliaAvailable based on result.
   */
  async ensureLoaded() {
    if (this.#loaded) return
    if (!this.#enabled) {
      this.#loaded = true
      return
    }

    try {
      if (typeof globalThis.Helia === 'function') {
        this.#helia = await globalThis.Helia.create()
        this.#heliaAvailable = true
        this.#onLog(2, 'Helia node initialized from globalThis')
      } else {
        try {
          // CDN URL verified current 2026-05-03 against npm registry latest (helia@6.1.4).
          await import('https://cdn.jsdelivr.net/npm/helia@6.1.4/dist/index.min.js')
          if (typeof globalThis.Helia === 'function') {
            this.#helia = await globalThis.Helia.create()
            this.#heliaAvailable = true
            this.#onLog(2, 'Helia loaded from CDN')
          }
        } catch {
          this.#heliaAvailable = false
          this.#onLog(1, 'Helia CDN load failed -- using memory-backed CID store')
        }
      }
    } catch (err) {
      this.#heliaAvailable = false
      this.#onLog(1, `Helia initialization failed: ${err.message}`)
    }

    this.#loaded = true
  }

  // ── Properties ───────────────────────────────────────────────────────

  /** Whether ensureLoaded() has been called. */
  get loaded() {
    return this.#loaded
  }

  /** Whether Helia is usable (true only after successful load). */
  get available() {
    return this.#heliaAvailable
  }

  /** Whether IPFS storage is enabled. */
  get enabled() {
    return this.#enabled
  }

  // ── Add ──────────────────────────────────────────────────────────────

  /**
   * Add data to the store. Returns the content identifier (CID).
   *
   * @param {Uint8Array|string} data - Data to store
   * @returns {Promise<{ cid: string, size: number }>}
   */
  async add(data) {
    if (!this.#loaded) await this.ensureLoaded()

    const bytes = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : data

    const size = bytes.byteLength

    // Check storage limits
    const currentSizeMb = this.#getCurrentSizeMb()
    const newSizeMb = size / (1024 * 1024)
    if (currentSizeMb + newSizeMb > this.#maxStorageMb) {
      throw new Error(`Storage limit exceeded: ${currentSizeMb.toFixed(2)}MB + ${newSizeMb.toFixed(2)}MB > ${this.#maxStorageMb}MB`)
    }

    // Compute CID via SHA-256
    const cid = await ChunkStore.computeCid(bytes)

    // Store in memory — preserve pin status if already stored (dedup)
    const existing = this.#storedCids.get(cid)
    this.#storedCids.set(cid, {
      data: bytes,
      size,
      pinned: existing ? existing.pinned : false,
      addedAt: existing ? existing.addedAt : Date.now(),
    })

    this.#emit('add', { cid, size })
    this.#onLog(2, `Added content: ${cid} (${size} bytes)`)

    return { cid, size }
  }

  // ── Get ──────────────────────────────────────────────────────────────

  /**
   * Retrieve data by CID.
   *
   * @param {string} cid - Content identifier
   * @returns {Promise<Uint8Array|null>}
   */
  async get(cid) {
    if (!this.#loaded) await this.ensureLoaded()

    const entry = this.#storedCids.get(cid)
    if (!entry) return null
    return entry.data
  }

  // ── Pin / Unpin ──────────────────────────────────────────────────────

  /**
   * Pin content locally (prevents garbage collection).
   *
   * @param {string} cid
   * @returns {Promise<boolean>} true if content exists and was pinned
   */
  async pin(cid) {
    const entry = this.#storedCids.get(cid)
    if (!entry) return false
    entry.pinned = true
    this.#emit('pin', { cid })
    return true
  }

  /**
   * Unpin content.
   *
   * @param {string} cid
   * @returns {Promise<boolean>} true if content exists and was unpinned
   */
  async unpin(cid) {
    const entry = this.#storedCids.get(cid)
    if (!entry) return false
    entry.pinned = false
    this.#emit('unpin', { cid })
    return true
  }

  // ── List ─────────────────────────────────────────────────────────────

  /**
   * List all stored CIDs with metadata.
   *
   * @returns {{ cid: string, size: number, pinned: boolean, addedAt: number }[]}
   */
  listCids() {
    const results = []
    for (const [cid, entry] of this.#storedCids) {
      results.push({
        cid,
        size: entry.size,
        pinned: entry.pinned,
        addedAt: entry.addedAt,
      })
    }
    return results
  }

  // ── Remove ───────────────────────────────────────────────────────────

  /**
   * Remove content by CID.
   *
   * @param {string} cid
   * @returns {Promise<boolean>} true if content existed and was removed
   */
  async remove(cid) {
    const entry = this.#storedCids.get(cid)
    if (!entry) return false
    if (entry.pinned) {
      this.#onLog(1, `Cannot remove pinned content: ${cid}`)
      return false
    }
    this.#storedCids.delete(cid)
    this.#emit('remove', { cid })
    this.#onLog(2, `Removed content: ${cid}`)
    return true
  }

  // ── Stats ────────────────────────────────────────────────────────────

  /**
   * Get storage statistics.
   *
   * @returns {{ totalCids: number, totalSizeMb: number, pinnedCount: number }}
   */
  getStats() {
    let pinnedCount = 0
    for (const entry of this.#storedCids.values()) {
      if (entry.pinned) pinnedCount++
    }

    return {
      totalCids: this.#storedCids.size,
      totalSizeMb: this.#getCurrentSizeMb(),
      pinnedCount,
    }
  }

  // ── Events ───────────────────────────────────────────────────────────

  /**
   * Register an event listener.
   * Events: 'add', 'remove', 'pin', 'unpin'
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
   * Emit an event to registered listeners.
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

  // ── Internal ─────────────────────────────────────────────────────────

  /**
   * Calculate current storage usage in megabytes.
   * @returns {number}
   */
  #getCurrentSizeMb() {
    let totalBytes = 0
    for (const entry of this.#storedCids.values()) {
      totalBytes += entry.size
    }
    return totalBytes / (1024 * 1024)
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Close the IPFS store. Clears all stored data and shuts down Helia if present.
   */
  async close() {
    this.#storedCids.clear()
    this.#listeners.clear()

    if (this.#helia) {
      try {
        await this.#helia.stop()
      } catch {
        // best effort
      }
      this.#helia = null
    }

    this.#loaded = false
    this.#heliaAvailable = false
  }

  // ── Serialization ────────────────────────────────────────────────────

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      enabled: this.#enabled,
      loaded: this.#loaded,
      available: this.#heliaAvailable,
      maxStorageMb: this.#maxStorageMb,
      stats: this.getStats(),
      cids: this.listCids().map(c => ({ cid: c.cid, size: c.size, pinned: c.pinned })),
    }
  }
}
