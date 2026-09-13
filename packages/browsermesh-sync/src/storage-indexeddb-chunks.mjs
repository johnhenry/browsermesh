/**
 * storage-indexeddb-chunks.mjs — IndexedDB-backed content-addressed chunk
 * store for `MeshFileTransfer`.
 *
 * Implements the same `save(cid, data)` / `get(cid)` / `has(cid)` /
 * `verify(cid, data)` / `remove(cid)` / `size` / `clear()` contract as the
 * in-memory `ChunkStore` (see `files.mjs`), but persists chunk bytes to a
 * real IndexedDB object store so content survives a page reload — a `Map`
 * can't do that, which is the entire point of this adapter.
 *
 * Modeled directly on this package's own `storage-indexeddb.mjs`
 * (`IndexedDBSyncStorage`): same "wrap IndexedDB's callback/event API in
 * promises, one object store, open-or-create on first use" shape, same
 * error-handling conventions, same lazy-`open()`-on-first-use pattern.
 *
 * Deliberately, completely unaware of encryption: it stores and serves
 * whatever opaque `Uint8Array` bytes it is handed, keyed by CID string. A
 * later layer (a future `CloudStorageBackend`, per the mesh-native-services
 * plan) is responsible for encrypting data before `save()` and decrypting
 * after `get()` — this class has no encryption-related parameters or logic,
 * by design.
 *
 * Interface note (unavoidable, not an oversight): `ChunkStore`'s `save`/
 * `get`/`has`/`remove`/`clear` are synchronous (a `Map` allows that);
 * IndexedDB is inherently asynchronous, so the equivalent methods here
 * return Promises instead. Every existing caller of `ChunkStore.verify()`
 * (already async, since it hashes via `crypto.subtle`) already awaits it,
 * so callers that consistently `await` chunk-store calls can swap one
 * implementation for the other. `size` remains a synchronous getter (same
 * signature as `ChunkStore`) but is necessarily a best-effort cache of
 * known keys — populated from the real object store the first time `open()`
 * resolves (i.e. the first time any other method is awaited), then kept in
 * sync locally by `save()`/`remove()`/`clear()`. It will read `0` for a
 * freshly-constructed instance whose `open()` hasn't resolved yet, and
 * won't reflect chunks written concurrently by another instance/tab
 * pointed at the same database — exactly the kind of caveat you'd expect
 * from making a synchronous view onto async storage.
 *
 * Usage:
 *   const store = new IndexedDBChunkStore({ dbName: 'my-app-chunks' });
 *   const cid = await IndexedDBChunkStore.computeCid(data);
 *   await store.save(cid, data);
 *   ...
 *   const bytes = await store.get(cid); // survives a reload
 */

import { ChunkStore } from './files.mjs';

/**
 * IndexedDB-backed, content-addressed storage for file chunks. CIDs are
 * SHA-256 hex strings, computed identically to `ChunkStore` (this class
 * reuses `ChunkStore.computeCid` directly rather than reimplementing
 * hashing, so CIDs are byte-for-byte interchangeable between the two
 * stores).
 */
export class IndexedDBChunkStore {
  /** @type {string} */
  #dbName;

  /** @type {string} */
  #storeName;

  /** @type {IDBDatabase|null} */
  #db = null;

  /** @type {Promise<void>|null} in-flight open(), so concurrent callers share it */
  #opening = null;

  /** Local cache of known keys, backing the synchronous `size` getter. */
  #keys = new Set();

  /**
   * @param {object} [opts]
   * @param {string} [opts.dbName='mesh-chunks']   IndexedDB database name.
   *   Configurable so multiple chunk stores in one page (distinct
   *   workspaces/buckets/tenants) can use separate databases without
   *   colliding.
   * @param {string} [opts.storeName='chunks']     Object store name within
   *   the database.
   */
  constructor(opts = {}) {
    this.#dbName = opts.dbName || 'mesh-chunks';
    this.#storeName = opts.storeName || 'chunks';
  }

  /**
   * Compute a content ID (SHA-256 hex) for data. Delegates directly to
   * `ChunkStore.computeCid` so both stores are guaranteed to produce
   * identical CIDs for identical bytes.
   * @param {Uint8Array} data
   * @returns {Promise<string>}
   */
  static computeCid(data) {
    return ChunkStore.computeCid(data);
  }

  /**
   * Open the IndexedDB database, creating the object store on first use,
   * and prime the local key cache from what's already persisted. Safe to
   * call multiple times, and safe to call concurrently — subsequent/
   * concurrent calls share the same in-flight open.
   * @returns {Promise<void>}
   */
  async open() {
    if (this.#db) return;
    if (this.#opening) return this.#opening;
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB not available');
    }

    const storeName = this.#storeName;

    this.#opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.#dbName, 1);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(storeName)) {
          // Out-of-line keys: the CID is passed explicitly to put()/get(),
          // not derived from a keyPath on the stored value. Chunk values
          // are raw Uint8Array bytes (IndexedDB structured-clones typed
          // arrays natively), not JSON-serializable records.
          db.createObjectStore(storeName);
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
    }).then(() => this.#primeKeyCache());

    try {
      await this.#opening;
    } finally {
      this.#opening = null;
    }
  }

  /** Populate `#keys` from whatever is already in the object store. */
  async #primeKeyCache() {
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(this.#storeName, 'readonly');
      const store = tx.objectStore(this.#storeName);
      const req = store.getAllKeys();
      req.onsuccess = () => {
        this.#keys = new Set(req.result);
        resolve();
      };
      req.onerror = () => reject(new Error(`Failed to read keys from "${this.#dbName}": ${req.error?.message}`));
    });
  }

  /**
   * Store a chunk by its CID.
   * @param {string} cid
   * @param {Uint8Array} data
   * @returns {Promise<void>}
   */
  async save(cid, data) {
    if (!this.#db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(this.#storeName, 'readwrite');
      const store = tx.objectStore(this.#storeName);
      store.put(data, cid);
      tx.oncomplete = () => {
        this.#keys.add(cid);
        resolve();
      };
      tx.onerror = () => reject(new Error(`Failed to save chunk "${cid}" to "${this.#dbName}": ${tx.error?.message}`));
      tx.onabort = () => reject(new Error(`Save transaction aborted for chunk "${cid}" in "${this.#dbName}": ${tx.error?.message}`));
    });
  }

  /**
   * Retrieve a chunk by CID.
   * @param {string} cid
   * @returns {Promise<Uint8Array|undefined>}
   */
  async get(cid) {
    if (!this.#db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(this.#storeName, 'readonly');
      const store = tx.objectStore(this.#storeName);
      const req = store.get(cid);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error(`Failed to get chunk "${cid}" from "${this.#dbName}": ${req.error?.message}`));
    });
  }

  /**
   * Check if a chunk exists.
   * @param {string} cid
   * @returns {Promise<boolean>}
   */
  async has(cid) {
    if (!this.#db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(this.#storeName, 'readonly');
      const store = tx.objectStore(this.#storeName);
      const req = store.getKey(cid);
      req.onsuccess = () => resolve(req.result !== undefined);
      req.onerror = () => reject(new Error(`Failed to check chunk "${cid}" in "${this.#dbName}": ${req.error?.message}`));
    });
  }

  /**
   * Verify that data matches the expected CID.
   * @param {string} cid
   * @param {Uint8Array} data
   * @returns {Promise<boolean>}
   */
  async verify(cid, data) {
    const computed = await IndexedDBChunkStore.computeCid(data);
    return computed === cid;
  }

  /**
   * Remove a chunk by CID.
   * @param {string} cid
   * @returns {Promise<boolean>} whether a chunk with that CID existed
   */
  async remove(cid) {
    if (!this.#db) await this.open();
    const existed = this.#keys.has(cid);
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(this.#storeName, 'readwrite');
      const store = tx.objectStore(this.#storeName);
      store.delete(cid);
      tx.oncomplete = () => {
        this.#keys.delete(cid);
        resolve(existed);
      };
      tx.onerror = () => reject(new Error(`Failed to remove chunk "${cid}" from "${this.#dbName}": ${tx.error?.message}`));
      tx.onabort = () => reject(new Error(`Remove transaction aborted for chunk "${cid}" in "${this.#dbName}": ${tx.error?.message}`));
    });
  }

  /**
   * Number of stored chunks, per the local key cache (see the class-level
   * doc comment for the caveats of a synchronous view onto async storage).
   */
  get size() { return this.#keys.size; }

  /**
   * Clear all chunks.
   * @returns {Promise<void>}
   */
  async clear() {
    if (!this.#db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(this.#storeName, 'readwrite');
      const store = tx.objectStore(this.#storeName);
      const req = store.clear();
      req.onsuccess = () => {
        this.#keys.clear();
        resolve();
      };
      req.onerror = () => reject(new Error(`Failed to clear chunks in "${this.#dbName}": ${req.error?.message}`));
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
