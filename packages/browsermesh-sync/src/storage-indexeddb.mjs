/**
 * storage-indexeddb.mjs — IndexedDB-backed persistence adapter for
 * `MeshSyncEngine`.
 *
 * Implements the same `save(docs)` / `load()` / `clear()` contract as
 * `InMemorySyncStorage` (see `sync.mjs`), but persists documents to a real
 * IndexedDB object store so a workspace's CRDT state survives a page
 * reload.
 *
 * Modeled on `browsermesh-core`'s `IndexedDBIdentityStorage` (same
 * "wrap IndexedDB's callback/event API in promises, one object store,
 * open-or-create on first use" shape) but intentionally self-contained:
 * `browsermesh-sync` does not depend on `browsermesh-core`.
 *
 * Usage:
 *   const storage = new IndexedDBSyncStorage({ dbName: 'my-app-mesh-sync' });
 *   const sync = new MeshSyncEngine({ storage });
 *   await sync.load();   // restore documents persisted in a prior session
 *   ...
 *   await sync.save();   // persist current documents
 */

/**
 * IndexedDB-backed storage adapter for `MeshSyncEngine`.
 *
 * Stores the full serialized document list under a single object store,
 * keyed by each document's `id`. `save()` replaces the entire stored set
 * (matching `InMemorySyncStorage`'s "last write wins, whole-set" semantics)
 * so documents removed locally since the last save do not linger.
 *
 * Falls back gracefully (throws a clear error) when IndexedDB is
 * unavailable, mirroring `IndexedDBIdentityStorage`.
 */
export class IndexedDBSyncStorage {
  /** @type {string} */
  #dbName;

  /** @type {string} */
  #storeName;

  /** @type {IDBDatabase|null} */
  #db = null;

  /**
   * @param {object} [opts]
   * @param {string} [opts.dbName='mesh-sync']      IndexedDB database name.
   *   Configurable so multiple `MeshSyncEngine`s in one page (e.g. distinct
   *   workspaces/tenants) can use separate databases without colliding.
   * @param {string} [opts.storeName='documents']   Object store name within
   *   the database.
   */
  constructor(opts = {}) {
    this.#dbName = opts.dbName || 'mesh-sync';
    this.#storeName = opts.storeName || 'documents';
  }

  /**
   * Open the IndexedDB database, creating the object store on first use.
   * Safe to call multiple times — subsequent calls are no-ops once open.
   * @returns {Promise<void>}
   */
  async open() {
    if (this.#db) return;
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB not available');
    }

    const storeName = this.#storeName;

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.#dbName, 1);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName, { keyPath: 'id' });
        }
      };

      request.onsuccess = (event) => {
        this.#db = event.target.result;
        this.#db.onclose = () => { this.#db = null; };
        resolve();
      };

      request.onerror = () => {
        reject(new Error(`Failed to open IndexedDB "${this.#dbName}": ${request.error?.message}`));
      };
    });
  }

  /**
   * Persist the full set of documents, replacing whatever was previously
   * stored (matches `InMemorySyncStorage.save()`'s whole-set-replace
   * semantics).
   * @param {object[]} docs  Serialized `SyncDocument`s (each with an `id`).
   * @returns {Promise<void>}
   */
  async save(docs) {
    if (!this.#db) await this.open();
    // Deep-clone through JSON to decouple from live objects, and to
    // guarantee only structured-cloneable data reaches IndexedDB.
    const records = JSON.parse(JSON.stringify(docs));

    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(this.#storeName, 'readwrite');
      const store = tx.objectStore(this.#storeName);
      store.clear();
      for (const record of records) {
        store.put(record);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(`Failed to save sync documents to "${this.#dbName}": ${tx.error?.message}`));
      tx.onabort = () => reject(new Error(`Save transaction aborted for "${this.#dbName}": ${tx.error?.message}`));
    });
  }

  /**
   * Load all persisted documents.
   * @returns {Promise<object[]|null>} The stored documents, or `null` when
   *   nothing has been saved (mirrors `InMemorySyncStorage.load()`).
   */
  async load() {
    if (!this.#db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(this.#storeName, 'readonly');
      const store = tx.objectStore(this.#storeName);
      const req = store.getAll();
      req.onsuccess = () => {
        const result = req.result;
        resolve(result && result.length > 0 ? result : null);
      };
      req.onerror = () => reject(new Error(`Failed to load sync documents from "${this.#dbName}": ${req.error?.message}`));
    });
  }

  /**
   * Empty the object store.
   * @returns {Promise<void>}
   */
  async clear() {
    if (!this.#db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(this.#storeName, 'readwrite');
      const store = tx.objectStore(this.#storeName);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`Failed to clear sync documents in "${this.#dbName}": ${req.error?.message}`));
    });
  }

  /** Close the database connection, if open. */
  close() {
    if (this.#db) {
      this.#db.close();
      this.#db = null;
    }
  }
}
