/**
 * clawser-mesh-sync.js — CRDT State Replication Engine.
 * Manages CRDT documents with storage persistence and delta-based peer sync.
 *
 * Usage:
 *   const sync = new MeshSyncEngine({ storage: new InMemorySyncStorage() });
 *   const doc = sync.create('config', 'lww-map');
 *   sync.update(doc.id, (crdt) => crdt.set('theme', 'dark', Date.now(), 'node1'));
 *   const state = sync.getState(doc.id);
 */

import {
  VectorClock, LWWRegister, GCounter, PNCounter, ORSet, RGA, LWWMap,
} from '@johnhenry/browsermesh-primitives';

/** @type {readonly string[]} Supported CRDT type identifiers. */
const CRDT_TYPES = Object.freeze([
  'lww-register', 'g-counter', 'pn-counter', 'or-set', 'rga', 'lww-map',
]);

/**
 * Map each type name to its constructor.
 * @type {Record<string, Function>}
 */
const CRDT_CONSTRUCTORS = {
  'lww-register': LWWRegister,
  'g-counter':    GCounter,
  'pn-counter':   PNCounter,
  'or-set':       ORSet,
  'rga':          RGA,
  'lww-map':      LWWMap,
};

// ── SyncDocument ─────────────────────────────────────────────────────────────

/**
 * A managed CRDT document with metadata for synchronization.
 */
export class SyncDocument {
  /**
   * @param {object} opts
   * @param {string} opts.id           Unique document identifier.
   * @param {string} opts.type         One of CRDT_TYPES.
   * @param {string} opts.owner        Owning pod / node ID.
   * @param {object} opts.crdt         Live CRDT instance.
   * @param {VectorClock} [opts.version]  Causality clock for sync.
   * @param {number}      [opts.created]
   * @param {number}      [opts.lastModified]
   * @param {string[]}    [opts.acl]   Pod IDs with write access.
   */
  constructor({ id, type, owner, crdt, version, created, lastModified, acl }) {
    this.id           = id;
    this.type         = type;
    this.owner        = owner;
    this.crdt         = crdt;
    this.version      = version || new VectorClock();
    this.created      = created || Date.now();
    this.lastModified = lastModified || this.created;
    this.acl          = acl || [];
  }

  /** Serialize the document to a plain JSON-compatible object. */
  toJSON() {
    return {
      id:           this.id,
      type:         this.type,
      owner:        this.owner,
      crdt:         this.crdt.toJSON(),
      version:      this.version.toJSON(),
      created:      this.created,
      lastModified: this.lastModified,
      acl:          [...this.acl],
    };
  }

  /**
   * Reconstruct a SyncDocument from a serialized plain object.
   * @param {object} data
   * @returns {SyncDocument}
   */
  static fromJSON(data) {
    const Ctor = CRDT_CONSTRUCTORS[data.type];
    if (!Ctor) throw new Error(`Unknown CRDT type: ${data.type}`);
    return new SyncDocument({
      id:           data.id,
      type:         data.type,
      owner:        data.owner,
      crdt:         Ctor.fromJSON(data.crdt),
      version:      VectorClock.fromJSON(data.version),
      created:      data.created,
      lastModified: data.lastModified,
      acl:          data.acl || [],
    });
  }
}

// ── MeshSyncEngine ───────────────────────────────────────────────────────────

/**
 * Manages a set of CRDT documents with create / read / update / merge
 * operations, subscriber notifications, persistence, and auto-sync.
 */
export class MeshSyncEngine {
  /** @type {Map<string, SyncDocument>} */
  #documents = new Map();
  /** @type {Map<string, Set<Function>>} */
  #subscriptions = new Map();
  /** @type {string} */
  #nodeId;
  /** @type {InMemorySyncStorage|object} */
  #storage;
  /** @type {Map<string, number>} docId -> intervalId */
  #autoSyncIntervals = new Map();
  /** @type {Function} */
  #onLog;

  /**
   * @param {object} [opts]
   * @param {string}  [opts.nodeId]   Identity for this engine (used in vector clocks).
   * @param {object}  [opts.storage]  Persistence adapter (save/load/clear).
   * @param {Function} [opts.onLog]   Logging callback (level, msg).
   */
  constructor(opts = {}) {
    this.#nodeId  = opts.nodeId || `node_${Date.now().toString(36)}`;
    this.#storage = opts.storage || new InMemorySyncStorage();
    this.#onLog   = opts.onLog || (() => {});
  }

  /** The engine's node identity string. */
  get nodeId() { return this.#nodeId; }

  /** Number of documents currently managed. */
  get size() { return this.#documents.size; }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  /**
   * Create a new CRDT document and register it with the engine.
   * @param {string} id     Document identifier (must be unique).
   * @param {string} type   One of CRDT_TYPES.
   * @param {object} [opts]
   * @param {string}   [opts.owner]
   * @param {string[]} [opts.acl]
   * @returns {SyncDocument}
   */
  create(id, type, opts = {}) {
    if (!CRDT_TYPES.includes(type)) {
      throw new Error(`Unknown CRDT type: ${type}. Valid types: ${CRDT_TYPES.join(', ')}`);
    }
    if (this.#documents.has(id)) {
      throw new Error(`Document already exists: ${id}`);
    }
    const Ctor = CRDT_CONSTRUCTORS[type];
    const doc = new SyncDocument({
      id,
      type,
      owner: opts.owner || this.#nodeId,
      crdt:  new Ctor(),
      acl:   opts.acl || [],
    });
    this.#documents.set(id, doc);
    return doc;
  }

  /**
   * Retrieve a document by ID, or null if not found.
   * @param {string} docId
   * @returns {SyncDocument|null}
   */
  get(docId) {
    return this.#documents.get(docId) || null;
  }

  /**
   * Return the user-facing value of a document's CRDT.
   * For CRDTs that expose a `.value` getter, that is returned.
   * For CRDTs with only a `.state()` method, `.state()` is used.
   * @param {string} docId
   * @returns {*} CRDT value, or null when the document does not exist.
   */
  getState(docId) {
    const doc = this.#documents.get(docId);
    if (!doc) return null;
    // All current mesh-primitives CRDTs define a `.value` getter.
    // LWWRegister.value can legitimately be null, so we check `undefined`.
    return doc.crdt.value !== undefined ? doc.crdt.value : doc.crdt.state();
  }

  /**
   * Apply a mutation to a document via callback.
   *
   * The callback receives the live CRDT instance and may call any mutating
   * method on it.  After the callback returns the document's vector clock is
   * incremented and all subscribers are notified.
   *
   * @param {string}   docId
   * @param {Function} updateFn  Receives the CRDT instance.
   */
  update(docId, updateFn) {
    const doc = this.#documents.get(docId);
    if (!doc) throw new Error(`Document not found: ${docId}`);
    updateFn(doc.crdt);
    doc.version = doc.version.increment(this.#nodeId);
    doc.lastModified = Date.now();
    this.#notifySubscribers(docId, doc);
  }

  /**
   * Merge a remote sync payload into a local document.
   *
   * The remote payload is typically obtained via `prepareSyncPayload()` on
   * a peer engine.  CRDT merge is always conflict-free by design.
   *
   * @param {string} docId
   * @param {object} remoteData  Must contain `crdt` and `version` fields.
   * @returns {{ conflicts: number }}  Always `{ conflicts: 0 }`.
   */
  merge(docId, remoteData) {
    const doc = this.#documents.get(docId);
    if (!doc) throw new Error(`Document not found: ${docId}`);

    const Ctor = CRDT_CONSTRUCTORS[doc.type];
    const remoteCrdt    = Ctor.fromJSON(remoteData.crdt);
    const remoteVersion = VectorClock.fromJSON(remoteData.version);

    // CRDT merge returns a new instance.
    doc.crdt    = doc.crdt.merge(remoteCrdt);
    doc.version = doc.version.merge(remoteVersion);
    doc.lastModified = Date.now();

    this.#notifySubscribers(docId, doc);
    return { conflicts: 0 };
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  /**
   * Subscribe to state changes on a document.
   * @param {string}   docId
   * @param {Function} callback  Called with (currentValue, document).
   * @returns {Function} Unsubscribe function.
   */
  subscribe(docId, callback) {
    if (!this.#subscriptions.has(docId)) {
      this.#subscriptions.set(docId, new Set());
    }
    this.#subscriptions.get(docId).add(callback);
    return () => {
      const subs = this.#subscriptions.get(docId);
      if (subs) subs.delete(callback);
    };
  }

  /** @param {string} docId @param {SyncDocument} doc */
  #notifySubscribers(docId, doc) {
    const subs = this.#subscriptions.get(docId);
    if (!subs || subs.size === 0) return;
    const val = doc.crdt.value !== undefined ? doc.crdt.value : doc.crdt.state();
    for (const cb of subs) {
      try { cb(val, doc); } catch { /* subscriber errors do not propagate */ }
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Delete a document and tear down its subscriptions and auto-sync.
   * @param {string} docId
   * @returns {boolean} True if the document existed.
   */
  delete(docId) {
    const existed = this.#documents.delete(docId);
    this.#subscriptions.delete(docId);
    this.stopAutoSync(docId);
    return existed;
  }

  /**
   * Return summary metadata for all managed documents.
   * @returns {Array<{id: string, type: string, owner: string, lastModified: number}>}
   */
  listDocuments() {
    return [...this.#documents.values()].map(d => ({
      id:           d.id,
      type:         d.type,
      owner:        d.owner,
      lastModified: d.lastModified,
    }));
  }

  // ── Sync payloads ──────────────────────────────────────────────────────────

  /**
   * Build a serializable sync payload for a peer.
   * @param {string} docId
   * @returns {object|null} Payload or null if document not found.
   */
  prepareSyncPayload(docId) {
    const doc = this.#documents.get(docId);
    if (!doc) return null;
    return {
      id:      doc.id,
      type:    doc.type,
      crdt:    doc.crdt.toJSON(),
      version: doc.version.toJSON(),
    };
  }

  // ── Auto-sync ──────────────────────────────────────────────────────────────

  /**
   * Periodically call `syncFn` with the sync payload for a document.
   * The caller is responsible for actually transmitting the payload.
   *
   * @param {string}   docId
   * @param {Function} syncFn      Called with the sync payload object.
   * @param {number}   [intervalMs=5000]
   * @returns {Function} Stopper — call to cancel auto-sync for this doc.
   */
  startAutoSync(docId, syncFn, intervalMs = 5000) {
    this.stopAutoSync(docId);
    const id = setInterval(() => {
      const payload = this.prepareSyncPayload(docId);
      if (payload) syncFn(payload);
    }, intervalMs);
    this.#autoSyncIntervals.set(docId, id);
    return () => this.stopAutoSync(docId);
  }

  /**
   * Stop auto-sync for a single document.
   * @param {string} docId
   */
  stopAutoSync(docId) {
    const id = this.#autoSyncIntervals.get(docId);
    if (id !== undefined) {
      clearInterval(id);
      this.#autoSyncIntervals.delete(docId);
    }
  }

  /** Stop all running auto-sync intervals. */
  stopAllAutoSync() {
    for (const [, id] of this.#autoSyncIntervals) {
      clearInterval(id);
    }
    this.#autoSyncIntervals.clear();
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  /**
   * Persist all documents through the configured storage adapter.
   */
  async save() {
    const docs = [];
    for (const doc of this.#documents.values()) {
      docs.push(doc.toJSON());
    }
    await this.#storage.save(docs);
  }

  /**
   * Restore documents from the configured storage adapter.
   * Existing in-memory documents are **not** cleared first — loaded documents
   * are added (or overwrite by ID).
   */
  async load() {
    const data = await this.#storage.load();
    if (!data) return;
    for (const item of data) {
      try {
        const doc = SyncDocument.fromJSON(item);
        this.#documents.set(doc.id, doc);
      } catch (e) {
        this.#onLog(3, `Failed to load document ${item.id}: ${e.message}`);
      }
    }
  }

  // ── Teardown ───────────────────────────────────────────────────────────────

  /**
   * Destroy the engine — stops all auto-sync intervals and clears
   * subscriptions.  Does **not** delete persisted data.
   */
  destroy() {
    this.stopAllAutoSync();
    this.#subscriptions.clear();
  }
}

// ── InMemorySyncStorage ──────────────────────────────────────────────────────

/**
 * Trivial in-memory storage adapter for sync documents.
 * Suitable for tests and ephemeral sessions.
 */
export class InMemorySyncStorage {
  /** @type {object[]|null} */
  #data = null;

  /** @param {object[]} docs */
  async save(docs) {
    // Deep-clone through JSON to decouple from live objects.
    this.#data = JSON.parse(JSON.stringify(docs));
  }

  /** @returns {Promise<object[]|null>} */
  async load() {
    return this.#data;
  }

  async clear() {
    this.#data = null;
  }
}

export { CRDT_TYPES };
