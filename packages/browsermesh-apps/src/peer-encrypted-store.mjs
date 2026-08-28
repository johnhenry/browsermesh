/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-peer-encrypted-store.js -- Encrypt blobs before uploading to peers.
 *
 * Peers store opaque ciphertext — they cannot read content. Enables
 * "borrow storage from friends" scenario.
 *
 * Uses AES-256-GCM via Node.js crypto (for testing) or Web Crypto API
 * (in browser). The 16-byte GCM auth tag is appended to the ciphertext.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-encrypted-store.test.mjs
 */

// ---------------------------------------------------------------------------
// Crypto helpers — Node.js-first for testability
// ---------------------------------------------------------------------------

let _crypto = null

/**
 * Lazily resolve the crypto module.
 *
 * @returns {Promise<object>}
 */
async function getCrypto() {
  if (_crypto) return _crypto
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues) {
    _crypto = globalThis.crypto
  } else {
    const mod = await import('node:crypto')
    _crypto = mod.default || mod
  }
  return _crypto
}

/**
 * Generate a random 256-bit AES key.
 *
 * @returns {Promise<Uint8Array>}
 */
async function generateKey() {
  const c = await getCrypto()
  const key = new Uint8Array(32)
  c.getRandomValues(key)
  return key
}

/**
 * Generate a random 96-bit IV for GCM.
 *
 * @returns {Promise<Uint8Array>}
 */
async function generateIV() {
  const c = await getCrypto()
  const iv = new Uint8Array(12)
  c.getRandomValues(iv)
  return iv
}

// ---------------------------------------------------------------------------
// AES-256-GCM encrypt / decrypt — Node.js native
// ---------------------------------------------------------------------------

/**
 * Encrypt data with AES-256-GCM.
 *
 * Returns the ciphertext with the 16-byte auth tag appended.
 *
 * @param {Uint8Array} data - Plaintext bytes
 * @param {Uint8Array} key - 32-byte AES key
 * @param {Uint8Array} iv - 12-byte IV
 * @returns {Promise<Uint8Array>} ciphertext || authTag
 */
async function aesEncrypt(data, key, iv) {
  // Try Node.js crypto first (always available in test env)
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
    // Fallback to Web Crypto
    const subtle = globalThis.crypto?.subtle
    if (!subtle) throw new Error('No crypto implementation available')

    const cryptoKey = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt'])
    const encrypted = await subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, data)
    return new Uint8Array(encrypted)
  }
}

/**
 * Decrypt AES-256-GCM ciphertext.
 *
 * Expects the 16-byte auth tag appended to the ciphertext.
 *
 * @param {Uint8Array} ciphertext - ciphertext || authTag
 * @param {Uint8Array} key - 32-byte AES key
 * @param {Uint8Array} iv - 12-byte IV
 * @returns {Promise<Uint8Array>} plaintext
 */
async function aesDecrypt(ciphertext, key, iv) {
  // Try Node.js crypto first
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
    // If the error is from auth tag mismatch, re-throw it
    if (err.message?.includes('Unsupported state') || err.code === 'ERR_OSSL_BAD_DECRYPT') {
      throw new Error('Decryption failed: authentication tag mismatch')
    }

    // Fallback to Web Crypto
    const subtle = globalThis.crypto?.subtle
    if (!subtle) throw err

    const cryptoKey = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt'])
    const decrypted = await subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext)
    return new Uint8Array(decrypted)
  }
}

// ---------------------------------------------------------------------------
// SHA-256 CID computation
// ---------------------------------------------------------------------------

/**
 * Compute a content ID (CID) as the hex-encoded SHA-256 of data.
 *
 * @param {Uint8Array} data
 * @returns {Promise<string>} hex-encoded SHA-256
 */
export async function computeCid(data) {
  try {
    const nodeCrypto = await import('node:crypto')
    const hash = nodeCrypto.createHash('sha256').update(data).digest()
    return Buffer.from(hash).toString('hex')
  } catch {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data)
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
  }
}

// ---------------------------------------------------------------------------
// Base64 helpers
// ---------------------------------------------------------------------------

/**
 * Encode bytes to standard base64.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Decode standard base64 to bytes.
 *
 * @param {string} str
 * @returns {Uint8Array}
 */
function fromBase64(str) {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(str, 'base64'))
  }
  const bin = atob(str)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// ---------------------------------------------------------------------------
// Exported helper functions
// ---------------------------------------------------------------------------

/**
 * Encrypt a blob of data with a fresh random key and IV.
 *
 * @param {Uint8Array|string} data - Plaintext
 * @returns {Promise<{ ciphertext: Uint8Array, key: Uint8Array, iv: Uint8Array }>}
 */
export async function encryptBlob(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const key = await generateKey()
  const iv = await generateIV()
  const ciphertext = await aesEncrypt(bytes, key, iv)
  return { ciphertext, key, iv }
}

/**
 * Decrypt a blob using the provided key and IV.
 *
 * @param {Uint8Array} ciphertext
 * @param {Uint8Array} key - 32-byte AES key
 * @param {Uint8Array} iv - 12-byte IV
 * @returns {Promise<Uint8Array>} plaintext
 */
export async function decryptBlob(ciphertext, key, iv) {
  return aesDecrypt(ciphertext, key, iv)
}

// ---------------------------------------------------------------------------
// ManifestEntry
// ---------------------------------------------------------------------------

/**
 * A single entry in the encrypted blob manifest tracking what was stored where.
 */
export class ManifestEntry {
  /**
   * @param {object} opts
   * @param {string} opts.cid - Content ID (hex SHA-256 of ciphertext)
   * @param {string} opts.peerId - Peer the blob is stored on
   * @param {string} opts.key - AES key (base64-encoded)
   * @param {string} opts.iv - IV (base64-encoded)
   * @param {number} opts.size - Size of the original plaintext in bytes
   * @param {object} [opts.metadata] - Optional user metadata
   * @param {number} [opts.storedAt] - Timestamp when stored
   */
  constructor({ cid, peerId, key, iv, size, metadata, storedAt }) {
    /** @type {string} */
    this.cid = cid
    /** @type {string} */
    this.peerId = peerId
    /** @type {string} */
    this.key = key
    /** @type {string} */
    this.iv = iv
    /** @type {number} */
    this.size = size
    /** @type {object} */
    this.metadata = metadata || {}
    /** @type {number} */
    this.storedAt = storedAt || Date.now()
  }

  /**
   * Serialize to JSON-safe object.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      cid: this.cid,
      peerId: this.peerId,
      key: this.key,
      iv: this.iv,
      size: this.size,
      metadata: this.metadata,
      storedAt: this.storedAt,
    }
  }

  /**
   * Deserialize from a plain object.
   *
   * @param {object} json
   * @returns {ManifestEntry}
   */
  static fromJSON(json) {
    return new ManifestEntry({
      cid: json.cid,
      peerId: json.peerId,
      key: json.key,
      iv: json.iv,
      size: json.size,
      metadata: json.metadata,
      storedAt: json.storedAt,
    })
  }
}

// ---------------------------------------------------------------------------
// EncryptedBlobStore
// ---------------------------------------------------------------------------

/**
 * Encrypt blobs before uploading to peers.
 *
 * Peers store opaque ciphertext — they cannot read content. The local
 * manifest tracks CIDs, keys, and IVs needed to retrieve and decrypt.
 */
export class EncryptedBlobStore {
  /** @type {object} FileClient instance */
  #fileClient

  /** @type {Function} */
  #onLog

  /** @type {Map<string, ManifestEntry>} cid -> ManifestEntry */
  #manifest = new Map()

  /**
   * @param {object} opts
   * @param {object} opts.fileClient - PeerFiles FileClient instance
   * @param {Function} [opts.onLog] - Logging callback (level, message)
   */
  constructor({ fileClient, onLog }) {
    if (!fileClient) {
      throw new Error('fileClient is required')
    }
    this.#fileClient = fileClient
    this.#onLog = onLog || (() => {})
  }

  /**
   * Encrypt and store a blob on a remote peer.
   *
   * @param {string} peerId - Target peer ID
   * @param {Uint8Array|string} data - Plaintext data to encrypt and store
   * @param {object} [opts] - Options
   * @param {object} [opts.metadata] - Optional metadata to attach
   * @returns {Promise<{ cid: string, key: string, iv: string, size: number }>}
   */
  async store(peerId, data, opts = {}) {
    if (!peerId || typeof peerId !== 'string') {
      throw new Error('peerId must be a non-empty string')
    }

    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
    const size = bytes.length

    this.#onLog(2, `Encrypting blob (${size} bytes) for peer ${peerId}`)

    // Generate key + IV and encrypt
    const key = await generateKey()
    const iv = await generateIV()
    const ciphertext = await aesEncrypt(bytes, key, iv)

    // Compute CID from ciphertext
    const cid = await computeCid(ciphertext)

    // Upload ciphertext to peer
    const path = `.encrypted-blobs/${cid}`
    await this.#fileClient.writeFile(path, ciphertext)

    this.#onLog(2, `Uploaded encrypted blob ${cid} to peer ${peerId}`)

    // Encode key/iv as base64 for storage
    const keyB64 = toBase64(key)
    const ivB64 = toBase64(iv)

    // Store in local manifest
    const entry = new ManifestEntry({
      cid,
      peerId,
      key: keyB64,
      iv: ivB64,
      size,
      metadata: opts.metadata || {},
    })
    this.#manifest.set(cid, entry)

    return { cid, key: keyB64, iv: ivB64, size }
  }

  /**
   * Download and decrypt a blob from a remote peer.
   *
   * @param {string} peerId - Peer to download from
   * @param {string} cid - Content ID of the blob
   * @param {string} key - Base64-encoded AES key
   * @param {string} iv - Base64-encoded IV
   * @returns {Promise<Uint8Array>} decrypted plaintext
   */
  async retrieve(peerId, cid, key, iv) {
    if (!peerId || typeof peerId !== 'string') {
      throw new Error('peerId must be a non-empty string')
    }
    if (!cid || typeof cid !== 'string') {
      throw new Error('cid must be a non-empty string')
    }

    this.#onLog(2, `Retrieving blob ${cid} from peer ${peerId}`)

    // Download ciphertext from peer
    const path = `.encrypted-blobs/${cid}`
    const result = await this.#fileClient.readFile(path)
    const ciphertext = result.data instanceof Uint8Array
      ? result.data
      : new TextEncoder().encode(result.data)

    // Verify CID matches
    const actualCid = await computeCid(ciphertext)
    if (actualCid !== cid) {
      throw new Error(`CID mismatch: expected ${cid}, got ${actualCid}`)
    }

    // Decrypt
    const keyBytes = fromBase64(key)
    const ivBytes = fromBase64(iv)
    const plaintext = await aesDecrypt(ciphertext, keyBytes, ivBytes)

    this.#onLog(2, `Decrypted blob ${cid} (${plaintext.length} bytes)`)
    return plaintext
  }

  /**
   * Delete an encrypted blob from a remote peer.
   *
   * @param {string} peerId - Peer to delete from
   * @param {string} cid - Content ID to delete
   * @returns {Promise<boolean>}
   */
  async delete(peerId, cid) {
    if (!cid || typeof cid !== 'string') {
      throw new Error('cid must be a non-empty string')
    }

    this.#onLog(2, `Deleting blob ${cid} from peer ${peerId}`)

    const path = `.encrypted-blobs/${cid}`
    await this.#fileClient.deleteFile(path)

    // Remove from manifest
    const deleted = this.#manifest.delete(cid)
    return deleted
  }

  /**
   * List all entries in the local manifest.
   *
   * @returns {ManifestEntry[]}
   */
  listManifest() {
    return [...this.#manifest.values()]
  }

  /**
   * Verify that a blob on a remote peer matches its CID, without decrypting.
   *
   * @param {string} peerId - Peer to verify on
   * @param {string} cid - Expected content ID
   * @returns {Promise<{ valid: boolean, size: number }>}
   */
  async verify(peerId, cid) {
    if (!cid || typeof cid !== 'string') {
      throw new Error('cid must be a non-empty string')
    }

    this.#onLog(2, `Verifying blob ${cid} on peer ${peerId}`)

    const path = `.encrypted-blobs/${cid}`
    const result = await this.#fileClient.readFile(path)
    const ciphertext = result.data instanceof Uint8Array
      ? result.data
      : new TextEncoder().encode(result.data)

    const actualCid = await computeCid(ciphertext)
    const valid = actualCid === cid

    this.#onLog(2, `Verification of ${cid}: ${valid ? 'passed' : 'FAILED'}`)
    return { valid, size: ciphertext.length }
  }

  /**
   * Serialize the store state (manifest) to JSON.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      manifest: [...this.#manifest.entries()].map(([cid, entry]) => entry.toJSON()),
    }
  }

  /**
   * Restore an EncryptedBlobStore from serialized JSON.
   *
   * @param {object} json
   * @param {object} deps - Dependencies to inject
   * @param {object} deps.fileClient - FileClient instance
   * @param {Function} [deps.onLog] - Logging callback
   * @returns {EncryptedBlobStore}
   */
  static fromJSON(json, deps) {
    const store = new EncryptedBlobStore(deps)
    for (const entryJson of json.manifest || []) {
      const entry = ManifestEntry.fromJSON(entryJson)
      store.#manifest.set(entry.cid, entry)
    }
    return store
  }
}
