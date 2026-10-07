/**
 * peer-ipfs.mjs -- Mesh-local content-addressed storage (issue #123, split
 * from #84: originally, incorrectly, claimed to depend on `PeerSession` --
 * confirmed self-contained, no `PeerSession` import at all).
 *
 * `IPFSStore` is a plain, dependency-light class (its only real dependency
 * is `ChunkStore.computeCid()` from `@johnhenry/browsermesh-sync`, for the
 * same SHA-256-hex content-addressing `ChunkStore`/`CloudStorage` already
 * use) -- see `createIpfsService()` below (Phase C, `mesh-service.mjs`) for
 * the `MeshService` wrapper.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CLASS IS (and is not):
 *
 * `IPFSStore` is a MESH-LOCAL CONTENT-ADDRESSED STORE. The "CID" it produces
 * is a raw SHA-256 hex digest (`ChunkStore.computeCid()`), the same format
 * `ChunkStore`/`CloudStorage` use elsewhere in this repo. It is NOT an IPFS
 * CID (no multihash/multibase, no `Qm...`/`bafy...`), and nothing here speaks
 * to the public IPFS network: there is no Helia, libp2p, or bitswap code in
 * this package, and `helia`/`@helia/*` is not a dependency of any package in
 * this monorepo. The `IPFSStore` name and the `ipfs_store`/`ipfs_retrieve`
 * agent tools predate this clarification and are kept for compatibility;
 * `MeshLocalCidStore` is exported as an alias that says what the class is.
 *
 * Earlier revisions carried a hook in `ensureLoaded()` that tried to
 * `import()` a Helia bundle from a CDN when `{ enabled: true }`. It could
 * never activate (the bundle is an IIFE so `globalThis.Helia` was never set,
 * the namespace exports `createHelia` rather than `create`, and the
 * `typeof === 'function'` guard failed for a namespace), and even a loaded
 * node was never used by `add()`/`get()`/`pin()`. It was removed (#197); a
 * library should not fetch a 900 KB third-party bundle on its host's behalf.
 * `enabled` is therefore accepted and reported but has no effect, and
 * `available` is always `false`; both remain so existing callers keep
 * working. A consumer who wants real IPFS should run their own Helia and
 * keep it separate from this class.
 *
 * WHAT THIS ACTUALLY OFFERS OVER `CloudStorage` (`cloud-storage.mjs`), given
 * the above: `CloudStorage` is encrypted, `PeerRegistry`-gated, and
 * automatically replicated across the mesh via `chunk-replication.mjs` --
 * "put once, every authorized peer can eventually fetch it". `IPFSStore` is
 * the opposite on every one of those axes: unencrypted, ungated, and
 * strictly single-node -- content `add()`ed on one peer's `IPFSStore` is
 * NOT visible to, replicated to, or fetchable by any other peer's
 * `IPFSStore` (there is no wire protocol here at all; each `IPFSStore`
 * instance is a private, local cache, and `createIpfsService()` below does
 * not add one -- see its own "NO WIRE PROTOCOL" note). Its genuinely
 * distinct value is a lightweight, dependency-light local scratch cache
 * with pin/unpin/storage-cap bookkeeping and an `ensureLoaded()`/`close()`
 * lifecycle -- not an IPFS-network-interop story.
 *
 * ---------------------------------------------------------------------------
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./test/_setup-globals.mjs --test test/peer-ipfs.test.mjs
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
 * Mesh-local content-addressed store. CIDs are SHA-256 hex digests (the
 * `ChunkStore` format), not IPFS CIDs, and nothing here talks to the public
 * IPFS network -- see the module doc comment. Also exported as
 * `MeshLocalCidStore`.
 */
export class IPFSStore {
  /** @type {boolean} */
  #loaded = false

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
   * @param {boolean} [opts.enabled=false] - Accepted and reported by
   *   `enabled`/`toJSON()` for compatibility; it has no effect on behaviour
   *   (there is no IPFS backend to enable).
   * @param {number} [opts.maxStorageMb=100] - Maximum storage in MB
   * @param {Function} [opts.onLog] - Logging callback
   */
  constructor(opts = {}) {
    this.#enabled = opts.enabled ?? IPFS_DEFAULTS.enabled
    this.#maxStorageMb = opts.maxStorageMb ?? IPFS_DEFAULTS.maxStorageMb
    this.#onLog = opts.onLog || (() => {})
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Mark the store as loaded. Kept for lifecycle compatibility; there is
   * nothing to load (the CDN Helia hook was removed, see the module doc
   * comment). Idempotent.
   */
  async ensureLoaded() {
    this.#loaded = true
  }

  // ── Properties ───────────────────────────────────────────────────────

  /** Whether ensureLoaded() has been called. */
  get loaded() {
    return this.#loaded
  }

  /**
   * Always `false`: there is no IPFS/Helia backend. Retained so callers that
   * checked it keep working.
   * @deprecated
   */
  get available() {
    return false
  }

  /** The `enabled` option as passed in (informational only; see constructor). */
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
   * Close the store. Clears all stored data and listeners.
   */
  async close() {
    this.#storedCids.clear()
    this.#listeners.clear()
    this.#loaded = false
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
      available: false,
      maxStorageMb: this.#maxStorageMb,
      stats: this.getStats(),
      cids: this.listCids().map(c => ({ cid: c.cid, size: c.size, pinned: c.pinned })),
    }
  }
}

/** Accurate name for `IPFSStore`: a mesh-local content-addressed store. */
export { IPFSStore as MeshLocalCidStore }

// ---------------------------------------------------------------------------
// createIpfsService -- MeshService wiring (Phase 6 consumer, issue #123)
// ---------------------------------------------------------------------------

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) that wires
 * an `IPFSStore` onto a real `PeerNode`. One `IPFSStore` instance is
 * constructed per `attach()` call, exactly like `createMeshRoutingService()`
 * (`peer-routing.mjs`) constructs one `MeshRouter` per `attach()` -- the
 * closest existing precedent for wrapping an already-standalone,
 * `on`/`off`-based class as a `MeshService` with no rewrite of its internals.
 *
 * ---------------------------------------------------------------------------
 * NO WIRE PROTOCOL -- unlike `createMeshRoutingService()`, this descriptor
 * does NOT call `ctx.onIncomingData()` or `ctx.sendTo()` anywhere.
 * `IPFSStore` has no `forwardFn`/`fetchFn`-shaped dependency to wire onto the
 * network in the first place -- every one of its methods
 * (`add`/`get`/`pin`/`unpin`/`remove`/`listCids`/`getStats`) is a purely
 * local operation on its own in-memory `#storedCids` map (see this file's
 * "WHAT THIS CLASS IS" header comment). Attaching this service to two
 * different `PeerNode`s therefore produces two entirely independent stores:
 * content `add()`ed through peer A's `api.add()` is never visible via peer
 * B's `api.get()`, with no `ctx.sendTo()` call anywhere in this file able to
 * change that. This is the concrete, mechanical reason this class is
 * "mesh-local" rather than "mesh-wide" -- see the module doc comment's
 * "WHAT THIS ACTUALLY OFFERS OVER CloudStorage" section for the fuller
 * comparison.
 *
 * ---------------------------------------------------------------------------
 * EVENTS (`ctx.emit()`, see `mesh-service.mjs`'s "Observability events"
 * section for the full convention) -- `IPFSStore`'s own pre-existing
 * `on`/`off` surface (`'add'`/`'remove'`/`'pin'`/`'unpin'`) is bridged
 * through verbatim, prefixed `peer-ipfs:`:
 *
 *   - `peer-ipfs:add`    -- `{cid, size}`, whenever `api.add()` stores new
 *     (or re-stores identical, deduped) content (`IPFSStore`'s own `'add'`
 *     payload, unchanged).
 *   - `peer-ipfs:remove` -- `{cid}` (`IPFSStore`'s own `'remove'` payload).
 *   - `peer-ipfs:pin`    -- `{cid}` (`IPFSStore`'s own `'pin'` payload).
 *   - `peer-ipfs:unpin`  -- `{cid}` (`IPFSStore`'s own `'unpin'` payload).
 *
 * `IPFSStore`'s own `onLog(level, message)` callback (a NUMBER level --
 * `0` error, `1` warn, `2` info -- unlike this family's usual
 * `onLog(event, data)` shape) is bridged into the caller-supplied `onLog`
 * as `onLog('peer-ipfs:log', {level, message})`, so a caller only ever
 * implements one `onLog` shape regardless of which mesh service it's
 * listening to.
 *
 * `teardown()` calls `store.close()` -- clearing all locally-stored content
 * -- since the
 * store is entirely owned by this `attach()` call (a fresh `IPFSStore` is
 * constructed every time `createIpfsService()`'s descriptor is attached; see
 * `mesh-service.mjs`'s own "teardown() only reverses what attach() itself
 * did" contract).
 *
 * No browser-only imports at module level.
 */

/**
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] - Forwarded to `new IPFSStore()` (default
 *   `false` -- see `IPFS_DEFAULTS`). Informational only: it does not enable
 *   any IPFS behaviour (see the module doc comment).
 * @param {number} [opts.maxStorageMb] - Forwarded to `new IPFSStore()`
 *   (default 100).
 * @param {Function} [opts.onLog] - `(event: string, data: object) => void`,
 *   this family's usual shape. Receives `IPFSStore`'s own `(level, message)`
 *   log lines wrapped as `onLog('peer-ipfs:log', {level, message})` -- see
 *   module doc comment's "EVENTS" section.
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createIpfsService(opts = {}) {
  const { enabled, maxStorageMb, onLog } = opts
  const log = onLog || (() => {})

  return {
    name: 'peer-ipfs',

    attach(peerNode, ctx) {
      const store = new IPFSStore({
        enabled,
        maxStorageMb,
        onLog: (level, message) => log('peer-ipfs:log', { level, message }),
      })

      // Bridge IPFSStore's own pre-existing on()/off() events through
      // ctx.emit() -- see module doc comment's "EVENTS" section.
      const onAdd = (data) => ctx.emit('peer-ipfs:add', data)
      const onRemove = (data) => ctx.emit('peer-ipfs:remove', data)
      const onPin = (data) => ctx.emit('peer-ipfs:pin', data)
      const onUnpin = (data) => ctx.emit('peer-ipfs:unpin', data)
      store.on('add', onAdd)
      store.on('remove', onRemove)
      store.on('pin', onPin)
      store.on('unpin', onUnpin)

      const api = {
        ensureLoaded: () => store.ensureLoaded(),
        add: (data) => store.add(data),
        get: (cid) => store.get(cid),
        pin: (cid) => store.pin(cid),
        unpin: (cid) => store.unpin(cid),
        listCids: () => store.listCids(),
        remove: (cid) => store.remove(cid),
        getStats: () => store.getStats(),
        close: () => store.close(),
        toJSON: () => store.toJSON(),
        isEnabled: () => store.enabled,
        isLoaded: () => store.loaded,
        isAvailable: () => store.available,
      }

      return {
        api,
        async teardown() {
          store.off('add', onAdd)
          store.off('remove', onRemove)
          store.off('pin', onPin)
          store.off('unpin', onUnpin)
          await store.close()
        },
      }
    },
  }
}
