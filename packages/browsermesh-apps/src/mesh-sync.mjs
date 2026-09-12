/**
 * mesh-sync.mjs -- wires a `MeshSyncEngine` (`@johnhenry/browsermesh-sync`)
 * to a `PeerNode`'s (this package) existing message-dispatch bus, so CRDT
 * sync deltas travel over the real connection `PeerNode` already manages
 * instead of a parallel message-passing path.
 *
 * Reuses `PeerNode`'s own envelope-routing convention rather than inventing
 * a new one: outbound via `sendTo()` (accepts plain objects -- the
 * underlying transport JSON-serializes them, see `WebRTCPeerConnection.send`),
 * inbound via `onIncomingData()`, filtering by `envelope.type` (default
 * `'mesh-sync'`) exactly the way `peer-node.mjs`'s own doc comments describe
 * `ClawserPod.onMessage` routing "by `envelope.type`" -- multiple independent
 * consumers of `onIncomingData()` can coexist on the same bus this way, each
 * ignoring envelopes that aren't theirs.
 *
 * Persistence: `createMeshSync()` defaults to a real, durable
 * `IndexedDBSyncStorage` (from `@johnhenry/browsermesh-sync`, Phase 1) --
 * not the in-memory adapter -- because the whole point of that adapter
 * existing is for a workspace's CRDT state to survive a reload. Pass
 * `storage` explicitly to override (e.g. `InMemorySyncStorage` for a test
 * that doesn't care about persistence).
 *
 * No browser-only imports at module level. (`IndexedDBSyncStorage` itself
 * only touches the global `indexedDB` lazily, inside `open()`/`save()`/
 * `load()`, not at construction time -- see storage-indexeddb.mjs.)
 */

import { MeshSyncEngine, IndexedDBSyncStorage } from '@johnhenry/browsermesh-sync'

/** Default `envelope.type` used to route sync payloads on the shared `onIncomingData()` bus. */
const DEFAULT_ENVELOPE_TYPE = 'mesh-sync'

// ---------------------------------------------------------------------------
// MeshSyncBinding
// ---------------------------------------------------------------------------

/**
 * Binds a `MeshSyncEngine` to a `PeerNode`'s dispatch bus.
 *
 * Construction wires an `onIncomingData()` subscriber immediately (matching
 * `MeshSignalingChannel`'s "subscribe in the constructor" convention).
 * Outbound sends are explicit (`syncDocWithPeer()`) or driven by `watch()`.
 */
export class MeshSyncBinding {
  /** @type {import('./peer-node.mjs').PeerNode} */
  #node

  /** @type {import('@johnhenry/browsermesh-sync').MeshSyncEngine} */
  #engine

  /** @type {string} */
  #envelopeType

  /** @type {Function} */
  #onLog

  /** @type {(() => void)|null} */
  #unsubscribeIncoming = null

  /** @type {Map<string, () => void>} docId -> unsubscribe from engine.subscribe() */
  #watchers = new Map()

  /**
   * @param {object} opts
   * @param {import('./peer-node.mjs').PeerNode} opts.node
   * @param {import('@johnhenry/browsermesh-sync').MeshSyncEngine} opts.engine
   * @param {string} [opts.envelopeType='mesh-sync']
   * @param {Function} [opts.onLog]
   */
  constructor({ node, engine, envelopeType, onLog } = {}) {
    if (!node) throw new Error('node is required')
    if (!engine) throw new Error('engine is required')

    this.#node = node
    this.#engine = engine
    this.#envelopeType = envelopeType || DEFAULT_ENVELOPE_TYPE
    this.#onLog = onLog || (() => {})

    this.#unsubscribeIncoming = this.#node.onIncomingData((pubKey, data) => {
      this.#handleIncoming(pubKey, data)
    })
  }

  /** The underlying `MeshSyncEngine`. */
  get engine() {
    return this.#engine
  }

  /** The `envelope.type` this binding sends/routes on the shared dispatch bus. */
  get envelopeType() {
    return this.#envelopeType
  }

  // -----------------------------------------------------------------------
  // Outbound
  // -----------------------------------------------------------------------

  /**
   * Send a document's current full CRDT state to one peer. The remote side
   * merges it in (creating the document locally first if it doesn't have it
   * yet) -- safe to call repeatedly; CRDT merge is idempotent/commutative.
   *
   * @param {string} pubKey - Remote peer's fingerprint / public key hash
   * @param {string} docId
   * @returns {Promise<void>} Resolves once `node.sendTo()` accepts the send.
   */
  async syncDocWithPeer(pubKey, docId) {
    const doc = this.#engine.get(docId)
    if (!doc) {
      throw new Error(`MeshSyncBinding.syncDocWithPeer: unknown document '${docId}'`)
    }
    const payload = this.#engine.prepareSyncPayload(docId)
    await this.#node.sendTo(pubKey, {
      type: this.#envelopeType,
      docId,
      docType: doc.type,
      payload,
    })
    this.#onLog('mesh-sync:sent', { to: pubKey, docId })
  }

  /**
   * Start auto-broadcasting a document's state to one or more peers
   * whenever it changes locally (`engine.update()` or `engine.merge()`
   * both notify subscribers). Overwrites any existing watch for the same
   * `docId`.
   *
   * @param {string} docId
   * @param {string|string[]} pubKeys - One peer, or several.
   * @returns {() => void} Stops watching this document.
   */
  watch(docId, pubKeys) {
    this.unwatch(docId)
    const targets = Array.isArray(pubKeys) ? pubKeys : [pubKeys]

    const unsubscribe = this.#engine.subscribe(docId, () => {
      for (const pubKey of targets) {
        this.syncDocWithPeer(pubKey, docId).catch((err) => {
          this.#onLog('mesh-sync:broadcast-failed', {
            to: pubKey,
            docId,
            error: err?.message || String(err),
          })
        })
      }
    })
    this.#watchers.set(docId, unsubscribe)
    return () => this.unwatch(docId)
  }

  /**
   * Stop auto-broadcasting a document previously passed to `watch()`.
   * @param {string} docId
   */
  unwatch(docId) {
    const unsubscribe = this.#watchers.get(docId)
    if (unsubscribe) {
      unsubscribe()
      this.#watchers.delete(docId)
    }
  }

  // -----------------------------------------------------------------------
  // Inbound
  // -----------------------------------------------------------------------

  /**
   * @param {string} pubKey
   * @param {*} data
   */
  #handleIncoming(pubKey, data) {
    if (!data || typeof data !== 'object' || data.type !== this.#envelopeType) return
    const { docId, docType, payload } = data
    if (!docId || !payload) return

    try {
      if (!this.#engine.get(docId)) {
        this.#engine.create(docId, docType, { owner: pubKey })
      }
      this.#engine.merge(docId, payload)
      this.#onLog('mesh-sync:merged', { from: pubKey, docId })
    } catch (err) {
      this.#onLog('mesh-sync:merge-failed', { from: pubKey, docId, error: err?.message || String(err) })
    }
  }

  // -----------------------------------------------------------------------
  // Persistence passthrough
  // -----------------------------------------------------------------------

  /** Persist all documents through the engine's configured storage adapter. */
  async save() {
    await this.#engine.save()
  }

  /** Restore documents from the engine's configured storage adapter. */
  async load() {
    await this.#engine.load()
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  /**
   * Detach from the `PeerNode` dispatch bus and stop all `watch()`es. Does
   * not destroy the engine or its persisted data -- call `engine.destroy()`
   * separately if desired.
   */
  detach() {
    for (const docId of [...this.#watchers.keys()]) this.unwatch(docId)
    if (this.#unsubscribeIncoming) {
      this.#unsubscribeIncoming()
      this.#unsubscribeIncoming = null
    }
  }
}

// ---------------------------------------------------------------------------
// createMeshSync
// ---------------------------------------------------------------------------

/**
 * Convenience factory: build a `MeshSyncEngine` -- defaulting to durable
 * `IndexedDBSyncStorage`, not the in-memory adapter -- and wire it to
 * `node` via `MeshSyncBinding`.
 *
 * @param {object} opts
 * @param {import('./peer-node.mjs').PeerNode} opts.node
 * @param {object} [opts.storage] - Storage adapter (`save`/`load`/`clear`).
 *   Defaults to `new IndexedDBSyncStorage({ dbName })`.
 * @param {string} [opts.nodeId] - CRDT node identity for vector clocks.
 *   Defaults to `node.podId`.
 * @param {string} [opts.dbName] - Passed to the default `IndexedDBSyncStorage`.
 *   Defaults to `mesh-sync-${node.podId}` so multiple mesh nodes in one
 *   process/browser don't collide. Ignored if `storage` is supplied.
 * @param {string} [opts.envelopeType='mesh-sync']
 * @param {Function} [opts.onLog]
 * @returns {MeshSyncBinding}
 */
export function createMeshSync({ node, storage, nodeId, dbName, envelopeType, onLog } = {}) {
  if (!node) throw new Error('node is required')

  const engine = new MeshSyncEngine({
    nodeId: nodeId || node.podId,
    storage: storage || new IndexedDBSyncStorage({ dbName: dbName || `mesh-sync-${node.podId}` }),
    onLog,
  })

  return new MeshSyncBinding({ node, engine, envelopeType, onLog })
}

export { DEFAULT_ENVELOPE_TYPE }
