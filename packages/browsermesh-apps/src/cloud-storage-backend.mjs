/**
 * cloud-storage-backend.mjs -- Phase B of the mesh-native-services plan
 * ("CloudStorage: S3-like object storage"): a `browsermesh-netway` `Backend`
 * that provides a durable, encrypted-at-rest, single-peer object store.
 *
 * No mesh dependency yet -- this phase is explicitly local-only, single-peer
 * (see the plan's Phase B section). Cross-peer replication (chunk transfer),
 * authorization (the signed GrantLog), and cross-peer manifest sync are all
 * later phases (D/F/G) layered on top of what this file builds.
 *
 * The one other file in this package that imports *from* `browsermesh-netway`
 * besides `mesh-relay-backend.mjs` -- same rationale: `browsermesh-netway`
 * is deliberately dependency-free, so all mesh/storage awareness lives here
 * in `-apps`, which already depends on both `browsermesh-netway` and
 * `browsermesh-sync` (verified against the real `package.json`
 * `peerDependencies` before writing this file -- see the plan's Phase B
 * parenthetical for the full reasoning).
 *
 * Protocol: JSON-command-over-socket, modeled directly on
 * `fs-service-backend.mjs` -- the client writes a UTF-8 JSON command object
 * to the socket returned by `connect()`, the server writes back a single
 * UTF-8 JSON response object per command. Binary payloads are base64.
 * Errors come back as `{ error: message }` without closing the socket
 * (exact same convention as `fs-service-backend.mjs`).
 *
 * Ops (S3-like semantics):
 *   - put    { key, data (base64), contentType?, metadata? } -> { stored: true, key, size }
 *   - get    { key }                                          -> { data (base64), size, contentType, metadata } | { error: 'not found' }
 *   - delete { key }                                          -> { deleted: true }
 *   - list   { prefix? }                                      -> { keys: [{ key, size, updatedAt }] }
 *   - head   { key }                                          -> { size, contentType, metadata, updatedAt, version } | { error: 'not found' }
 *
 * Encryption (per the plan's "Design decisions" section -- this is the core
 * design constraint of this phase, not an incidental detail):
 *   - Encryption is a `CloudStorageBackend`-level concern, not a chunk-store
 *     concern. `IndexedDBChunkStore` stays completely unaware of encryption:
 *     it stores/serves whatever opaque bytes it is handed.
 *   - On first use, this backend generates a random AES-256-GCM key for the
 *     bucket and persists it to its own small, local-only key store (a
 *     dedicated `IndexedDBSyncStorage` instance, pointed at a database
 *     distinct from the manifest's). This key never goes through the
 *     CRDT-synced manifest path -- a later phase (E) handles cross-peer key
 *     distribution separately, over a dedicated point-to-point channel, and
 *     deliberately does not reuse the manifest sync channel for the key
 *     itself.
 *   - `put()` encrypts the plaintext BEFORE chunking, reusing
 *     `files.mjs`'s `MeshFileTransfer` 256KB chunking convention
 *     (`TRANSFER_DEFAULTS.chunkSize`, imported directly so the two stay in
 *     sync rather than duplicating the literal). `MeshFileTransfer` itself is
 *     transfer-session-oriented (offers/accepts/progress), not a generic
 *     "slice this buffer" utility, so the slicing loop is replicated inline
 *     here rather than reused.
 *   - The CID (`IndexedDBChunkStore.computeCid`, which delegates to
 *     `ChunkStore.computeCid` -- byte-identical) is computed over each
 *     CIPHERTEXT chunk, not the plaintext, and each ciphertext chunk is
 *     stored via `IndexedDBChunkStore.save(cid, ciphertextChunk)`.
 *   - Every chunk gets a fresh random IV (AES-GCM requires a unique IV per
 *     encryption under the same key). The IV is not secret and is stored
 *     alongside the CID in the manifest entry.
 *   - `peekKeyRaw()`/`exportKeyRaw()`/`importKeyRaw()` (added for Phase E,
 *     `key-distribution.mjs`) let a caller read this backend's raw 32-byte
 *     bucket key (to hand to a newly-granted peer over Phase E's dedicated
 *     encrypted channel) and let a *different* `CloudStorageBackend` instance
 *     (a newly-granted peer's own local instance for the same bucket) adopt
 *     received key material instead of generating its own. See each method's
 *     own doc comment for exactly how they avoid the auto-create-on-first-use
 *     behavior below stepping on a receive-only instance.
 *
 *     PERMANENT LIMITATION (Phase E's own documented constraint, restated
 *     here since this is the file whose data a leaked/undeleted key actually
 *     protects): revoking a peer's grant (the replicated `GrantLog`, Phase D)
 *     stops FUTURE key distribution and future chunk replication (Phase G) to
 *     that peer, but cannot retroactively erase a key -- or any plaintext
 *     already decrypted with it -- already delivered to that peer before the
 *     revoke. This bucket's AES key is never rotated on revoke in this plan;
 *     a since-revoked peer that retained the key (or any chunk ciphertext
 *     plus the key) can still decrypt it offline forever. This is a
 *     fundamental property of any such scheme (the same is true of, say, a
 *     downloaded-then-access-revoked S3 object), not a bug to fix later.
 *
 * Manifest: an `LWWMap` (`@johnhenry/browsermesh-primitives`) persisted via
 * `IndexedDBSyncStorage`'s `save(docs)`/`load()` for local durability of this
 * single peer's state. Manifest value shape:
 *   { chunks: [{ cid, iv }], size, contentType, metadata, version, updatedAt }
 * Deletes are tombstoned via `LWWMap.delete()`, never a chunk-store removal
 * (another key might reference the same content-addressed chunk; garbage
 * collection of orphaned chunks is out of scope for the whole plan).
 *
 * Phase F (`manifest-sync.mjs`) wires this manifest into `MeshSyncEngine` for
 * cross-peer replication. This file's contribution to that phase is a small,
 * deliberately narrow surface -- `getManifestSnapshot()`,
 * `mergeManifestEntries()`, `onManifestChange()` -- that hands the *raw*
 * `LWWMap` wire shape (`{entries: {key: {value, timestamp, nodeId,
 * tombstone}}}`) up to the caller and accepts already-vetted entries back
 * down. This file performs NO authorization itself: `manifest-sync.mjs` is
 * responsible for filtering out any remote entry whose implied writer
 * (`entry.nodeId`) fails `PeerRegistry.checkAccess()` BEFORE ever calling
 * `mergeManifestEntries()` -- by the time an entry reaches this file's merge
 * path, trusting it is assumed to already be correct. See that file's module
 * doc comment for the full ACL-gate design and the reasoning for why the
 * gate lives one layer up, not here.
 *
 * IMPORTANT for cross-peer use: local writes are attributed to this
 * instance's `#nodeId` (the LWWMap tiebreak/attribution field for that
 * write). For a bucket's manifest to be meaningfully ACL-checked by other
 * peers, `nodeId` MUST be constructed as the local peer's own identity
 * (`peerNode.podId`), not the random-UUID default this class falls back to
 * when unset -- a receiving peer's `checkAccess(nodeId, ...)` call is
 * meaningless against a random UUID that matches no real identity. Single-
 * peer (Phase B) callers are unaffected either way since nothing ever reads
 * that attribution back out locally.
 *
 * Crypto conventions match `peer-encrypted-store.mjs`'s established
 * AES-256-GCM usage exactly (small, self-contained per-file helpers,
 * `crypto.getRandomValues` for key/IV generation, Node's `node:crypto`
 * `aes-256-gcm` cipher first with the 16-byte auth tag appended to the
 * ciphertext, falling back to WebCrypto `crypto.subtle` when `node:crypto`
 * isn't available) so a later phase relying on the same bucket-key byte
 * format (Phase E's key distribution) can interoperate without translation.
 *
 * Phase G (`chunk-replication.mjs`) additions, kept narrow and additive
 * exactly like Phase E's/F's own surfaces above:
 *   - `hasChunkRaw()`/`getChunkRaw()`/`putChunkRaw()` -- opaque ciphertext
 *     chunk read/write access (bypassing encryption/decryption and the
 *     manifest entirely), so a replica peer can serve/store/verify chunk
 *     bytes it may not even hold the bucket key for yet. `putChunkRaw()`
 *     verifies the supplied bytes actually hash to the claimed CID before
 *     ever writing them, exactly like `#encryptAndChunk()`'s own
 *     content-addressing -- a chunk-replication peer must never persist a
 *     wire-supplied (cid, bytes) pair without that check.
 *   - `setReplicationHook()` -- a post-construction setter (not a
 *     constructor option, since a backend is always constructed standalone
 *     and mesh concerns wire themselves in afterward, matching how
 *     `manifest-sync.mjs`/`key-distribution.mjs` both already compose on
 *     top of an already-constructed instance) that lets `#opPut()` await a
 *     real replication attempt before responding, populating `put()`'s
 *     JSON-command response with `{durability: 'local-only'|'replicated',
 *     replicatedTo: string[]}` per the plan's durability contract. When no
 *     hook is installed (every earlier phase's tests), `put()`'s response
 *     is byte-for-byte identical to before this phase existed.
 *
 * No browser-only imports at module level.
 */

import { Backend, StreamSocket } from '@johnhenry/browsermesh-netway'
import { IndexedDBChunkStore, IndexedDBSyncStorage, TRANSFER_DEFAULTS } from '@johnhenry/browsermesh-sync'
import { LWWMap } from '@johnhenry/browsermesh-primitives'

/** 256KB, matching `MeshFileTransfer`'s existing chunking convention exactly (imported, not duplicated as a literal). */
const CHUNK_SIZE = TRANSFER_DEFAULTS.chunkSize

/** Fixed document id for the single manifest record persisted via `IndexedDBSyncStorage`. */
const MANIFEST_DOC_ID = 'manifest'

/** Fixed document id for the single bucket-key record persisted via its own local-only `IndexedDBSyncStorage`. */
const KEY_DOC_ID = 'bucket-key'

// ---------------------------------------------------------------------------
// Crypto helpers -- same conventions as peer-encrypted-store.mjs (Node.js
// `node:crypto` first for testability, WebCrypto `crypto.subtle` fallback),
// duplicated locally rather than shared, matching this family's existing
// convention of small self-contained per-file crypto helpers.
// ---------------------------------------------------------------------------

/**
 * Generate a random 256-bit AES key.
 * @returns {Uint8Array}
 */
function generateKey() {
  const key = new Uint8Array(32)
  crypto.getRandomValues(key)
  return key
}

/**
 * Generate a random 96-bit IV for GCM.
 * @returns {Uint8Array}
 */
function generateIV() {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  return iv
}

/**
 * Encrypt data with AES-256-GCM. Returns ciphertext with the 16-byte auth
 * tag appended (matching `peer-encrypted-store.mjs`'s `aesEncrypt`).
 * @param {Uint8Array} data - Plaintext bytes
 * @param {Uint8Array} key - 32-byte AES key
 * @param {Uint8Array} iv - 12-byte IV
 * @returns {Promise<Uint8Array>} ciphertext || authTag
 */
async function aesEncrypt(data, key, iv) {
  try {
    const nodeCrypto = await import('node:crypto')
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv)
    const encrypted = cipher.update(data)
    const final = cipher.final()
    const authTag = cipher.getAuthTag()

    const result = new Uint8Array(encrypted.length + final.length + authTag.length)
    result.set(new Uint8Array(encrypted.buffer, encrypted.byteOffset, encrypted.length), 0)
    if (final.length > 0) {
      result.set(new Uint8Array(final.buffer, final.byteOffset, final.length), encrypted.length)
    }
    result.set(new Uint8Array(authTag.buffer, authTag.byteOffset, authTag.length), encrypted.length + final.length)
    return result
  } catch {
    const subtle = globalThis.crypto?.subtle
    if (!subtle) throw new Error('No crypto implementation available')
    const cryptoKey = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt'])
    const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, data)
    return new Uint8Array(encrypted)
  }
}

/**
 * Decrypt AES-256-GCM ciphertext with a 16-byte auth tag appended.
 * @param {Uint8Array} ciphertext - ciphertext || authTag
 * @param {Uint8Array} key - 32-byte AES key
 * @param {Uint8Array} iv - 12-byte IV
 * @returns {Promise<Uint8Array>} plaintext
 */
async function aesDecrypt(ciphertext, key, iv) {
  try {
    const nodeCrypto = await import('node:crypto')
    const authTag = ciphertext.slice(ciphertext.length - 16)
    const data = ciphertext.slice(0, ciphertext.length - 16)

    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(authTag)
    const decrypted = decipher.update(data)
    const final = decipher.final()

    const result = new Uint8Array(decrypted.length + final.length)
    result.set(new Uint8Array(decrypted.buffer, decrypted.byteOffset, decrypted.length), 0)
    if (final.length > 0) {
      result.set(new Uint8Array(final.buffer, final.byteOffset, final.length), decrypted.length)
    }
    return result
  } catch (err) {
    if (err.message?.includes('Unsupported state') || err.code === 'ERR_OSSL_BAD_DECRYPT') {
      throw new Error('Decryption failed: authentication tag mismatch')
    }
    const subtle = globalThis.crypto?.subtle
    if (!subtle) throw err
    const cryptoKey = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt'])
    const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext)
    return new Uint8Array(decrypted)
  }
}

// ---------------------------------------------------------------------------
// Base64 helpers (same rationale/duplication as mesh-relay-backend.mjs / peer-encrypted-store.mjs)
// ---------------------------------------------------------------------------

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  return btoa(String.fromCharCode(...bytes))
}

/** @param {string} str @returns {Uint8Array} */
function fromBase64(str) {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(str, 'base64'))
  }
  const bin = atob(str)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** Constant-time-ish byte equality (length-checked first; not a security-critical comparison, just correctness). @param {Uint8Array} a @param {Uint8Array} b @returns {boolean} */
function bytesEqual(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// CloudStorageBackend
// ---------------------------------------------------------------------------

/**
 * A `Backend` exposing a durable, encrypted-at-rest, single-peer S3-like
 * object store over a JSON-command-over-socket protocol.
 *
 * @extends Backend
 */
export class CloudStorageBackend extends Backend {
  /** @type {string} */
  #bucket

  /** @type {import('@johnhenry/browsermesh-sync').IndexedDBChunkStore} */
  #chunkStore

  /** @type {import('@johnhenry/browsermesh-sync').IndexedDBSyncStorage} */
  #manifestStorage

  /** @type {import('@johnhenry/browsermesh-sync').IndexedDBSyncStorage} local-only, never CRDT-synced */
  #keyStorage

  /** @type {import('@johnhenry/browsermesh-primitives').LWWMap} */
  #manifest = new LWWMap()

  /** @type {Uint8Array|null} 32-byte AES-256-GCM bucket key */
  #bucketKey = null

  /** @type {Promise<void>|null} in-flight readiness bootstrap, shared by concurrent callers */
  #ready = null

  /** @type {string} node id used as the LWWMap tiebreak/attribution for local writes */
  #nodeId

  /** @type {number} monotonic clock backing manifest write timestamps (see #nextTimestamp) */
  #clock = 0

  /** @type {Set<Function>} subscribers to local/merged manifest changes -- see onManifestChange() */
  #manifestChangeListeners = new Set()

  /**
   * @type {((info: {key: string, entry: object}) => Promise<{durability: string, replicatedTo: string[]}>)|null}
   * Phase G (`chunk-replication.mjs`) replication hook -- see
   * `setReplicationHook()`'s doc comment.
   */
  #replicationHook = null

  /** @type {Function} */
  #onLog

  /**
   * @param {object} opts
   * @param {string} opts.bucket - Bucket name. Used to derive default
   *   database names for the chunk store / manifest storage / key storage
   *   (each gets its own IndexedDB database, so the bucket key is never
   *   colocated with the CRDT-synced manifest storage).
   * @param {string} [opts.dbName] - Override the derived database name
   *   prefix (defaults to `cloud-storage-${bucket}`).
   * @param {import('@johnhenry/browsermesh-sync').IndexedDBChunkStore} [opts.chunkStore]
   * @param {import('@johnhenry/browsermesh-sync').IndexedDBSyncStorage} [opts.manifestStorage]
   * @param {import('@johnhenry/browsermesh-sync').IndexedDBSyncStorage} [opts.keyStorage]
   * @param {string} [opts.nodeId] - Defaults to a random UUID.
   * @param {Function} [opts.onLog]
   */
  constructor({ bucket, dbName, chunkStore, manifestStorage, keyStorage, nodeId, onLog } = {}) {
    super()
    if (!bucket || typeof bucket !== 'string') {
      throw new Error('CloudStorageBackend: bucket is required')
    }
    this.#bucket = bucket
    const prefix = dbName || `cloud-storage-${bucket}`

    this.#chunkStore = chunkStore || new IndexedDBChunkStore({ dbName: `${prefix}-chunks` })
    this.#manifestStorage = manifestStorage || new IndexedDBSyncStorage({ dbName: `${prefix}-manifest` })
    // Deliberately a separate IndexedDB database from the manifest's, so the
    // bucket key is never colocated with (or accidentally swept up by) the
    // CRDT-synced manifest storage once Phase F wires that into
    // MeshSyncEngine.
    this.#keyStorage = keyStorage || new IndexedDBSyncStorage({ dbName: `${prefix}-keys` })

    this.#nodeId = nodeId || (crypto.randomUUID ? crypto.randomUUID() : `node-${Math.random().toString(36).slice(2)}`)
    this.#onLog = onLog || (() => {})
  }

  /** The bucket name this backend serves. */
  get bucket() { return this.#bucket }

  // -----------------------------------------------------------------------
  // Backend API
  // -----------------------------------------------------------------------

  /**
   * Connect to the bucket's command service. `host`/`port` are accepted for
   * `Backend` interface compatibility but ignored -- one `CloudStorageBackend`
   * instance always serves its one bound bucket (same precedent as
   * `FsServiceBackend.connect()`).
   *
   * @param {string} [host]
   * @param {number} [port]
   * @returns {Promise<import('@johnhenry/browsermesh-netway').StreamSocket>}
   */
  async connect(host, port) {
    const [clientSocket, serverSocket] = StreamSocket.createPair()

    this.#handleConnection(serverSocket).catch((err) => {
      this.#onLog('cloud-storage-backend:connection-error', { error: err?.message || String(err) })
      serverSocket.close().catch(() => {})
    })

    return clientSocket
  }

  /** @param {import('@johnhenry/browsermesh-netway').StreamSocket} socket */
  async #handleConnection(socket) {
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()

    while (true) {
      const chunk = await socket.read()
      if (chunk === null) break

      let cmd
      try {
        cmd = JSON.parse(decoder.decode(chunk))
      } catch {
        await socket.write(encoder.encode(JSON.stringify({ error: 'Invalid JSON' })))
        continue
      }

      let result
      try {
        result = await this.#handleOp(cmd)
      } catch (err) {
        result = { error: err?.message || String(err) }
      }
      await socket.write(encoder.encode(JSON.stringify(result)))
    }
  }

  /**
   * @param {object} cmd
   * @returns {Promise<object>}
   */
  async #handleOp(cmd) {
    if (!cmd || typeof cmd !== 'object') return { error: 'Invalid command' }

    switch (cmd.op) {
      case 'put':
        return this.#opPut(cmd)
      case 'get':
        return this.#opGet(cmd)
      case 'delete':
        return this.#opDelete(cmd)
      case 'list':
        return this.#opList(cmd)
      case 'head':
        return this.#opHead(cmd)
      default:
        return { error: `Unknown op: ${cmd.op}` }
    }
  }

  // -----------------------------------------------------------------------
  // Ops
  // -----------------------------------------------------------------------

  async #opPut(cmd) {
    if (!cmd.key || typeof cmd.key !== 'string') return { error: 'key is required' }
    if (typeof cmd.data !== 'string') return { error: 'data (base64) is required' }

    await this.#ensureReady()

    const plaintext = fromBase64(cmd.data)
    const chunks = await this.#encryptAndChunk(plaintext)

    const previous = this.#manifest.get(cmd.key)
    const entry = {
      chunks,
      size: plaintext.length,
      contentType: cmd.contentType ?? null,
      metadata: cmd.metadata ?? {},
      version: (previous?.version || 0) + 1,
      updatedAt: Date.now(),
    }

    this.#manifest.set(cmd.key, entry, this.#nextTimestamp(), this.#nodeId)
    await this.#saveManifest()
    this.#fireManifestChange()

    const response = { stored: true, key: cmd.key, size: entry.size }

    // Phase G durability contract: the local write above is ALREADY durable
    // by this point -- everything from here on is a best-effort attempt to
    // also report replication status, and must never delay this response
    // indefinitely or turn a successful local write into a thrown error.
    if (this.#replicationHook) {
      try {
        const result = await this.#replicationHook({ key: cmd.key, entry })
        response.durability = result?.durability === 'replicated' ? 'replicated' : 'local-only'
        response.replicatedTo = Array.isArray(result?.replicatedTo) ? result.replicatedTo : []
      } catch (err) {
        this.#onLog('cloud-storage-backend:replication-hook-error', { key: cmd.key, error: err?.message || String(err) })
        response.durability = 'local-only'
        response.replicatedTo = []
      }
    }

    return response
  }

  async #opGet(cmd) {
    if (!cmd.key || typeof cmd.key !== 'string') return { error: 'key is required' }
    await this.#ensureReady()

    const entry = this.#manifest.get(cmd.key)
    if (!entry) return { error: 'not found' }

    const plaintext = await this.#fetchAndDecrypt(entry)
    return {
      data: toBase64(plaintext),
      size: entry.size,
      contentType: entry.contentType,
      metadata: entry.metadata,
    }
  }

  async #opDelete(cmd) {
    if (!cmd.key || typeof cmd.key !== 'string') return { error: 'key is required' }
    await this.#ensureReady()

    this.#manifest.delete(cmd.key, this.#nextTimestamp(), this.#nodeId)
    await this.#saveManifest()
    this.#fireManifestChange()

    return { deleted: true }
  }

  async #opList(cmd) {
    await this.#ensureReady()
    const prefix = cmd.prefix || ''
    const keys = []
    for (const [key, entry] of this.#manifest.entries()) {
      if (prefix && !key.startsWith(prefix)) continue
      keys.push({ key, size: entry.size, updatedAt: entry.updatedAt })
    }
    return { keys }
  }

  async #opHead(cmd) {
    if (!cmd.key || typeof cmd.key !== 'string') return { error: 'key is required' }
    await this.#ensureReady()

    const entry = this.#manifest.get(cmd.key)
    if (!entry) return { error: 'not found' }

    return {
      size: entry.size,
      contentType: entry.contentType,
      metadata: entry.metadata,
      updatedAt: entry.updatedAt,
      version: entry.version,
    }
  }

  // -----------------------------------------------------------------------
  // Encryption / chunking
  // -----------------------------------------------------------------------

  /**
   * Encrypt plaintext before chunking (per the plan's Design Decisions),
   * slicing into `CHUNK_SIZE` pieces (`MeshFileTransfer`'s existing 256KB
   * convention). CIDs are computed over ciphertext, not plaintext. A
   * zero-length input still produces exactly one (empty-plaintext) chunk,
   * matching S3's support for zero-byte objects.
   *
   * @param {Uint8Array} plaintext
   * @returns {Promise<Array<{cid: string, iv: string}>>}
   */
  async #encryptAndChunk(plaintext) {
    const chunks = []
    let offset = 0
    do {
      const slice = plaintext.subarray(offset, Math.min(offset + CHUNK_SIZE, plaintext.length))
      const iv = generateIV()
      const ciphertext = await aesEncrypt(slice, this.#bucketKey, iv)
      const cid = await IndexedDBChunkStore.computeCid(ciphertext)
      await this.#chunkStore.save(cid, ciphertext)
      chunks.push({ cid, iv: toBase64(iv) })
      offset += CHUNK_SIZE
    } while (offset < plaintext.length)
    return chunks
  }

  /**
   * Fetch each chunk in order, decrypt, and concatenate.
   * @param {{chunks: Array<{cid: string, iv: string}>}} entry
   * @returns {Promise<Uint8Array>}
   */
  async #fetchAndDecrypt(entry) {
    const parts = []
    let total = 0
    for (const { cid, iv } of entry.chunks) {
      const ciphertext = await this.#chunkStore.get(cid)
      if (!ciphertext) throw new Error(`missing chunk ${cid}`)
      const plaintext = await aesDecrypt(ciphertext, this.#bucketKey, fromBase64(iv))
      parts.push(plaintext)
      total += plaintext.length
    }
    const result = new Uint8Array(total)
    let pos = 0
    for (const part of parts) {
      result.set(part, pos)
      pos += part.length
    }
    return result
  }

  // -----------------------------------------------------------------------
  // Readiness: load manifest + load-or-create bucket key
  // -----------------------------------------------------------------------

  /**
   * Load the persisted manifest and bucket key on first use. Concurrent
   * callers share the same in-flight bootstrap.
   * @returns {Promise<void>}
   */
  async #ensureReady() {
    if (!this.#ready) {
      this.#ready = Promise.all([this.#loadManifest(), this.#loadOrCreateKey()]).then(() => {})
    }
    return this.#ready
  }

  async #loadManifest() {
    const docs = await this.#manifestStorage.load()
    if (docs && docs.length > 0) {
      const doc = docs.find((d) => d.id === MANIFEST_DOC_ID) || docs[0]
      this.#manifest = LWWMap.fromJSON(doc)
    }
  }

  async #saveManifest() {
    const json = this.#manifest.toJSON()
    await this.#manifestStorage.save([{ id: MANIFEST_DOC_ID, ...json }])
  }

  async #loadOrCreateKey() {
    // Idempotent guard: if `importKeyRaw()` (Phase E) already populated
    // `#bucketKey` directly -- deliberately bypassing this method entirely,
    // see that method's own doc comment -- never overwrite it with a freshly
    // generated key just because `#ensureReady()` also happened to run.
    if (this.#bucketKey) return
    const docs = await this.#keyStorage.load()
    if (docs && docs.length > 0) {
      const doc = docs.find((d) => d.id === KEY_DOC_ID) || docs[0]
      this.#bucketKey = fromBase64(doc.key)
      return
    }
    this.#bucketKey = generateKey()
    await this.#keyStorage.save([{ id: KEY_DOC_ID, key: toBase64(this.#bucketKey) }])
  }

  // -----------------------------------------------------------------------
  // Key export/import (Phase E: cross-peer bucket-key distribution)
  // -----------------------------------------------------------------------

  /**
   * Read the currently-persisted bucket key WITHOUT the auto-create side
   * effect `#ensureReady()`/`#loadOrCreateKey()` has on first use. Returns
   * `null` if this backend has never created or received a key yet.
   *
   * This exists specifically so Phase E's key-distribution service can ask
   * "do I already hold this bucket's key" (to decide whether it can help
   * relay it onward to a newly-granted peer) without accidentally
   * *originating* a brand-new key as a side effect on a peer that was only
   * ever meant to *receive* one -- calling `exportKeyRaw()` (below) for that
   * same question would silently mint and persist a fresh, never-to-be-
   * reconciled key on any peer that hasn't been granted access yet, which is
   * exactly the bug this method avoids.
   *
   * @returns {Promise<Uint8Array|null>}
   */
  async peekKeyRaw() {
    if (this.#bucketKey) return this.#bucketKey.slice()
    const docs = await this.#keyStorage.load()
    const doc = docs && docs.length > 0 ? (docs.find((d) => d.id === KEY_DOC_ID) || docs[0]) : null
    return doc ? fromBase64(doc.key) : null
  }

  /**
   * Export this backend's raw 32-byte AES-256-GCM bucket key, generating one
   * first via the normal `#ensureReady()` path if this backend has never
   * been used yet (i.e. the same auto-create semantics every other op has).
   * Intended for a peer that legitimately already owns/administers this
   * bucket to hand its key to Phase E's key-distribution service for sending
   * to a newly-granted peer -- NOT for a receive-only instance to call before
   * it has ever received anything (use `peekKeyRaw()` for that question
   * instead, so as to not auto-create a key that would then need reconciling
   * with whatever arrives later).
   *
   * @returns {Promise<Uint8Array>}
   */
  async exportKeyRaw() {
    await this.#ensureReady()
    return this.#bucketKey.slice()
  }

  /**
   * Adopt received raw key material (32 bytes), e.g. from Phase E's
   * key-distribution service after it decrypts a delivered bucket key --
   * WITHOUT going through `#ensureReady()`/`#loadOrCreateKey()`'s
   * auto-generate path, so a fresh `CloudStorageBackend` instance
   * constructed purely to receive a key never races its own local
   * key-of-nothing generation against the key actually arriving. Persists
   * the imported key to this backend's own local key storage exactly like a
   * self-generated key, so it survives reload identically (see
   * `#loadOrCreateKey`'s "reload" test coverage).
   *
   * Idempotent: importing the same key bytes that are already stored is a
   * silent no-op. By default, importing DIFFERENT key bytes than whatever is
   * already stored throws rather than silently clobbering local state that
   * may already have encrypted chunks written under the existing key -- pass
   * `{ overwrite: true }` to force replacement (there is no supported way to
   * re-encrypt already-written chunks under the new key; this is an escape
   * hatch for callers who know what they're doing, e.g. tests).
   *
   * @param {Uint8Array} rawKeyBytes - Exactly 32 bytes.
   * @param {object} [opts]
   * @param {boolean} [opts.overwrite=false]
   * @returns {Promise<void>}
   */
  async importKeyRaw(rawKeyBytes, { overwrite = false } = {}) {
    if (!(rawKeyBytes instanceof Uint8Array) || rawKeyBytes.length !== 32) {
      throw new Error('CloudStorageBackend.importKeyRaw: rawKeyBytes must be a 32-byte Uint8Array')
    }

    const existing = await this.peekKeyRaw()
    if (existing && !overwrite) {
      if (!bytesEqual(existing, rawKeyBytes)) {
        throw new Error(
          'CloudStorageBackend.importKeyRaw: a different bucket key is already stored locally ' +
          '-- pass { overwrite: true } to replace it (existing encrypted chunks will not be re-encrypted)',
        )
      }
      this.#bucketKey = existing
      return
    }

    this.#bucketKey = rawKeyBytes.slice()
    await this.#keyStorage.save([{ id: KEY_DOC_ID, key: toBase64(this.#bucketKey) }])
  }

  // -----------------------------------------------------------------------
  // Raw chunk access (Phase G: chunk-replication.mjs)
  //
  // Opaque ciphertext chunk read/write access, bypassing encryption/
  // decryption and the manifest entirely -- a replica peer stores/serves
  // ciphertext bytes it may not even hold the bucket key for yet (Phase E's
  // key delivery and Phase G's chunk replication are independent and can
  // complete in either order), and content-addressing (the CID is computed
  // over ciphertext, per this file's Design Decisions) lets any peer verify
  // a chunk's integrity without ever decrypting it.
  // -----------------------------------------------------------------------

  /**
   * Whether this backend's chunk store already holds ciphertext for `cid`,
   * without touching the manifest or bucket key. Used by chunk-replication
   * to answer "who has X" queries and to skip re-pushing chunks a replica
   * already has.
   * @param {string} cid
   * @returns {Promise<boolean>}
   */
  async hasChunkRaw(cid) {
    return this.#chunkStore.has(cid)
  }

  /**
   * Read a chunk's raw ciphertext bytes by CID, or `null` if not held
   * locally. Never decrypts -- callers (chunk-replication, serving a
   * `chunk-fetch-request`, or eagerly pushing after a local `put()`) deal
   * exclusively in opaque ciphertext bytes, exactly like `IndexedDBChunkStore`
   * itself.
   * @param {string} cid
   * @returns {Promise<Uint8Array|null>}
   */
  async getChunkRaw(cid) {
    const bytes = await this.#chunkStore.get(cid)
    return bytes ?? null
  }

  /**
   * Store received ciphertext bytes under `cid`, having first verified the
   * bytes actually hash to the claimed CID (`IndexedDBChunkStore.computeCid`,
   * the same content-addressing `#encryptAndChunk()` uses) -- a
   * chunk-replication peer must never trust a wire-supplied (cid, bytes)
   * pair blindly, or a malicious/buggy sender could poison this peer's
   * chunk store with bytes that don't match the CID a manifest entry
   * elsewhere points to. Idempotent: writing already-identical bytes for a
   * CID this store already holds is a harmless no-op write.
   * @param {string} cid
   * @param {Uint8Array} bytes
   * @returns {Promise<void>}
   * @throws {Error} if `bytes` does not hash to `cid`, or the arguments are malformed.
   */
  async putChunkRaw(cid, bytes) {
    if (typeof cid !== 'string' || !cid) {
      throw new Error('CloudStorageBackend.putChunkRaw: cid is required')
    }
    if (!(bytes instanceof Uint8Array)) {
      throw new Error('CloudStorageBackend.putChunkRaw: bytes must be a Uint8Array')
    }
    const computed = await IndexedDBChunkStore.computeCid(bytes)
    if (computed !== cid) {
      throw new Error(`CloudStorageBackend.putChunkRaw: bytes do not hash to claimed cid (expected ${cid}, computed ${computed})`)
    }
    await this.#chunkStore.save(cid, bytes)
  }

  // -----------------------------------------------------------------------
  // Replication hook (Phase G: chunk-replication.mjs)
  // -----------------------------------------------------------------------

  /**
   * Install (or clear, passing `null`/omitting) a hook that `put()`'s
   * JSON-command response awaits before replying to the client, so `put()`'s
   * returned `{durability, replicatedTo}` reflects a REAL attempt to push
   * the just-written chunks to connected, admin-designated replica peers --
   * not just "the local write succeeded". See `#opPut()`'s call site for the
   * exact contract: the hook receives `{key, entry}` (the just-written
   * manifest entry) and must resolve to `{durability:
   * 'local-only'|'replicated', replicatedTo: string[]}`. The hook itself
   * should never throw or hang indefinitely, but `#opPut()` also
   * defensively catches a misbehaving hook and falls back to
   * `{durability: 'local-only', replicatedTo: []}` regardless, so a
   * replication-layer bug can never turn an already-durable local write
   * into a thrown error or an indefinite hang.
   *
   * Deliberately a post-construction setter, not a constructor option: a
   * `CloudStorageBackend` is constructed standalone (Phase B) and
   * `chunk-replication.mjs`'s `MeshService.attach()` (Phase G) wires itself
   * in afterward, exactly like every other cross-cutting mesh concern in
   * this plan (manifest sync, key distribution) composes on top of an
   * already-constructed backend instance, never inside it.
   *
   * @param {((info: {key: string, entry: object}) => Promise<{durability: string, replicatedTo: string[]}>)|null} [hook]
   */
  setReplicationHook(hook) {
    this.#replicationHook = typeof hook === 'function' ? hook : null
  }

  /**
   * A monotonic millisecond-ish clock for manifest write timestamps. Plain
   * `Date.now()` can return the same value for two writes issued in the
   * same millisecond (very possible under `node --test`'s synchronous test
   * bodies); `LWWRegister.set()` only accepts a same-timestamp write when
   * the new writer's nodeId sorts strictly higher than the current one, so
   * two same-millisecond writes from THIS SAME node/instance would silently
   * be dropped without this. Not a substitute for the plan's documented
   * caller-timestamp limitation (still a real limitation across peers) --
   * only ensures a single backend instance's own sequential writes are
   * always strictly ordered.
   * @returns {number}
   */
  #nextTimestamp() {
    const now = Date.now()
    this.#clock = now > this.#clock ? now : this.#clock + 1
    return this.#clock
  }

  // -----------------------------------------------------------------------
  // Manifest sync surface (Phase F, `manifest-sync.mjs`)
  //
  // Deliberately narrow: this class hands out/accepts raw LWWMap wire JSON
  // and never itself decides whether a remote entry is authorized -- see
  // this file's module doc comment and `manifest-sync.mjs`'s module doc
  // comment for the full design.
  // -----------------------------------------------------------------------

  /**
   * The current manifest CRDT state, in the exact shape `LWWMap.toJSON()`/
   * `LWWMap.fromJSON()` use (`{entries: {key: {value, timestamp, nodeId,
   * tombstone}}}`), including tombstoned keys (needed so a peer merging this
   * snapshot can correctly resolve a delete that raced a concurrent put on
   * another peer).
   * @returns {Promise<object>}
   */
  async getManifestSnapshot() {
    await this.#ensureReady()
    return this.#manifest.toJSON()
  }

  /**
   * Merge externally-vetted manifest entries into the local manifest and
   * persist the result. `sanitizedCrdtJSON` must already have had any
   * unauthorized entries filtered out by the caller (`manifest-sync.mjs`) --
   * this method performs the LWWMap merge and nothing else, exactly the same
   * per-key last-write-wins resolution `LWWMap.merge()` always uses (see the
   * module doc comment's "known limitation" note). Fires the same
   * `onManifestChange()` notification a local `put`/`delete` does, so an
   * accepted remote change is eligible to be re-broadcast onward (multi-hop
   * propagation) exactly like a local write.
   * @param {{entries: Record<string, {value: *, timestamp: number, nodeId: string, tombstone?: boolean}>}} sanitizedCrdtJSON
   * @returns {Promise<void>}
   */
  async mergeManifestEntries(sanitizedCrdtJSON) {
    await this.#ensureReady()
    const remote = LWWMap.fromJSON(sanitizedCrdtJSON)
    this.#manifest = this.#manifest.merge(remote)
    await this.#saveManifest()
    this.#fireManifestChange()
  }

  /**
   * Subscribe to manifest changes -- fired after every local `put`/`delete`
   * AND after `mergeManifestEntries()`. `manifest-sync.mjs` uses this to
   * know when to refresh its `MeshSyncEngine` copy and broadcast the
   * bucket's current state to watching peers.
   * @param {() => void} cb
   * @returns {() => void} Unsubscribe.
   */
  onManifestChange(cb) {
    this.#manifestChangeListeners.add(cb)
    return () => this.#manifestChangeListeners.delete(cb)
  }

  /** Notify all `onManifestChange()` subscribers. Never throws -- a subscriber's own error is swallowed. */
  #fireManifestChange() {
    for (const cb of this.#manifestChangeListeners) {
      try { cb() } catch { /* subscriber errors do not propagate */ }
    }
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  /**
   * Close the underlying IndexedDB connections. Safe to call even if
   * `connect()` was never called.
   * @returns {Promise<void>}
   */
  async close() {
    this.#chunkStore.close?.()
    this.#manifestStorage.close?.()
    this.#keyStorage.close?.()
  }
}
