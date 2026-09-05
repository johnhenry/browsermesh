/**
 * clawser-mesh-identity.js -- Mesh identity management.
 *
 * Manages multiple Ed25519 cryptographic identities with vault-encrypted
 * storage. Imports primitives from mesh-primitives; adds persistence,
 * vault encryption, and DID support.
 *
 * Browser/Node dual: crypto.subtle calls are gated behind async methods.
 * Storage adapter pattern allows OPFS in browser, in-memory in tests.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-identity.test.mjs
 */

import { silentCatch } from './silent-catch.mjs'
import {
  PodIdentity,
  derivePodId,
  encodeBase64url,
  decodeBase64url,
} from '@johnhenry/browsermesh-primitives';

// Re-export primitives used by consumers
export { PodIdentity, derivePodId, encodeBase64url, decodeBase64url };

// ---------------------------------------------------------------------------
// PBKDF2 / AES-GCM constants (shared with VaultIdentityStorage)
// ---------------------------------------------------------------------------

const VAULT_PBKDF2_ITERATIONS = 310_000;
const VAULT_SALT_BYTES = 16;
const VAULT_IV_BYTES = 12;
const VAULT_KDF = 'PBKDF2-SHA256';

/**
 * Reject a passphrase that would not actually protect anything.
 *
 * PBKDF2 happily accepts an empty key, and `TextEncoder` turns `undefined`
 * into the five bytes `undefined`, so a missing passphrase produces a
 * well-formed ciphertext that anyone can derive the key for. Both cases have
 * to be refused rather than encrypted.
 *
 * @param {*} passphrase
 * @param {string} source - Where the passphrase came from, for the message
 * @returns {string}
 * @throws {TypeError}
 */
function requirePassphrase(passphrase, source) {
  if (typeof passphrase !== 'string' || passphrase.length === 0) {
    throw new TypeError(
      `${source} must return a non-empty string passphrase, got ` +
      `${passphrase === null ? 'null' : typeof passphrase}` +
      `${typeof passphrase === 'string' ? ' of length 0' : ''}`
    );
  }
  return passphrase;
}

/**
 * PBKDF2(SHA-256) → AES-256-GCM over a UTF-8 string.
 *
 * The KDF name and iteration count travel with the ciphertext so a future
 * change of parameters does not orphan envelopes written under the old ones.
 *
 * @param {string} plaintext
 * @param {string} passphrase
 * @returns {Promise<{ kdf: string, iterations: number, salt: string, iv: string, ciphertext: string }>}
 */
async function encryptWithPassphrase(plaintext, passphrase) {
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(VAULT_SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(VAULT_IV_BYTES));

  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const aesKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: VAULT_PBKDF2_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, enc.encode(plaintext))
  );

  return {
    kdf: VAULT_KDF,
    iterations: VAULT_PBKDF2_ITERATIONS,
    salt: encodeBase64url(salt),
    iv: encodeBase64url(iv),
    ciphertext: encodeBase64url(ciphertext),
  };
}

/**
 * Inverse of {@link encryptWithPassphrase}.
 *
 * `iterations` is read from the envelope so blobs written before the count
 * was recorded (and before it was raised to match the documented 310k) still
 * open.
 *
 * @param {{ kdf?: string, iterations?: number, salt: string, iv: string, ciphertext: string }} envelope
 * @param {string} passphrase
 * @returns {Promise<string>}
 */
async function decryptWithPassphrase(envelope, passphrase) {
  const { kdf, iterations, salt, iv, ciphertext } = envelope;
  if (kdf !== undefined && kdf !== VAULT_KDF) {
    throw new Error(`Unsupported key derivation function: ${kdf}`);
  }

  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: decodeBase64url(salt),
      iterations: iterations ?? VAULT_PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decodeBase64url(iv) },
    aesKey,
    decodeBase64url(ciphertext)
  );

  return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------
// base58btc encoding (Bitcoin alphabet) — used for W3C did:key
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * Encode bytes as base58btc (Bitcoin alphabet) without checksum.
 * Used for W3C did:key URIs (RFC 5234, Multibase 'z' prefix).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const base58btcEncode = (bytes) => {
  if (bytes.length === 0) return '';
  // Count leading zeros
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;

  // Convert to base 58 via repeated division
  const input = Array.from(bytes);
  const out = [];
  let start = zeros;
  while (start < input.length) {
    let remainder = 0;
    let i = start;
    for (; i < input.length; i++) {
      const acc = remainder * 256 + input[i];
      input[i] = Math.floor(acc / 58);
      remainder = acc % 58;
    }
    out.push(BASE58_ALPHABET[remainder]);
    while (start < input.length && input[start] === 0) start++;
  }

  // Each leading zero byte → '1' (alphabet[0])
  let prefix = '';
  for (let i = 0; i < zeros; i++) prefix += BASE58_ALPHABET[0];

  return prefix + out.reverse().join('');
};

// ---------------------------------------------------------------------------
// In-memory storage adapter (for tests and standalone use)
// ---------------------------------------------------------------------------

/**
 * In-memory identity storage adapter.
 * Implements the same async interface as OPFS/vault-backed stores.
 */
export class InMemoryIdentityStorage {
  /** @type {Map<string, *>} */
  #data = new Map();

  /**
   * @param {string} podId
   * @param {*} data
   */
  async save(podId, data) {
    this.#data.set(podId, structuredClone(data));
  }

  /**
   * @param {string} podId
   * @returns {Promise<*|null>}
   */
  async load(podId) {
    const val = this.#data.get(podId);
    return val !== undefined ? structuredClone(val) : null;
  }

  /**
   * @param {string} podId
   * @returns {Promise<boolean>}
   */
  async delete(podId) {
    return this.#data.delete(podId);
  }

  /** @returns {Promise<string[]>} */
  async list() {
    return [...this.#data.keys()];
  }

  async clear() {
    this.#data.clear();
  }
}

// ---------------------------------------------------------------------------
// MeshIdentityManager
// ---------------------------------------------------------------------------

/**
 * @typedef {object} IdentityEntry
 * @property {PodIdentity} identity - The Ed25519 PodIdentity
 * @property {string} label - Human-readable label
 * @property {object} metadata - Arbitrary metadata
 * @property {number} created - Unix timestamp (ms)
 */

/**
 * @typedef {object} IdentitySummary
 * @property {string} podId
 * @property {string} label
 * @property {string} did
 * @property {number} created
 * @property {object} metadata
 */

/**
 * Multi-identity manager with pluggable storage.
 *
 * Wraps `PodIdentity` from mesh-primitives with:
 * - Named identity management (create, import, delete, list)
 * - DID:key generation
 * - Sign/verify helpers
 * - Persistence via storage adapter
 */
export class MeshIdentityManager {
  /** @type {Map<string, IdentityEntry>} */
  #identities = new Map();

  /** @type {string|null} */
  #defaultId = null;

  /** @type {InMemoryIdentityStorage} */
  #storage;

  /** @type {Function} */
  #onLog;

  /**
   * @param {object} [opts]
   * @param {InMemoryIdentityStorage} [opts.storage]
   * @param {Function} [opts.onLog]
   */
  constructor(opts = {}) {
    this.#storage = opts.storage || new InMemoryIdentityStorage();
    this.#onLog = opts.onLog || (() => {});
  }

  // -- Creation & Import --------------------------------------------------

  /**
   * Generate a fresh Ed25519 identity.
   *
   * @param {string} label - Human-readable name
   * @param {object} [opts]
   * @param {object} [opts.metadata] - Arbitrary metadata to attach
   * @returns {Promise<IdentitySummary>}
   */
  async create(label, opts = {}) {
    if (!label || typeof label !== 'string') {
      throw new Error('Label is required and must be a non-empty string');
    }
    const identity = await PodIdentity.generate();
    const created = Date.now();
    const metadata = opts.metadata || {};

    // Cache raw public key bytes for proper W3C did:key encoding.
    let rawPubKey = null;
    try {
      const raw = await crypto.subtle.exportKey('raw', identity.keyPair.publicKey);
      rawPubKey = new Uint8Array(raw);
    } catch { /* exportable: false — fall back to legacy DID form */ }

    this.#identities.set(identity.podId, { identity, label, metadata, created, rawPubKey });
    this.#onLog('identity:create', { podId: identity.podId, label });

    // Auto-set default if this is the first identity
    if (this.#identities.size === 1) {
      this.#defaultId = identity.podId;
    }

    return {
      podId: identity.podId,
      label,
      did: this.toDID(identity.podId),
      created,
      metadata,
    };
  }

  /**
   * Import an identity from a JWK private key.
   *
   * @param {object} privateKeyJwk - Ed25519 private key in JWK format
   * @param {string} label - Human-readable name
   * @param {object} [opts]
   * @param {object} [opts.metadata]
   * @returns {Promise<IdentitySummary>}
   */
  async import(privateKeyJwk, label, opts = {}) {
    if (!label || typeof label !== 'string') {
      throw new Error('Label is required and must be a non-empty string');
    }
    if (!privateKeyJwk || typeof privateKeyJwk !== 'object') {
      throw new Error('privateKeyJwk must be a valid JWK object');
    }

    // Import the private key
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      privateKeyJwk,
      { name: 'Ed25519' },
      true,
      ['sign']
    );

    // Derive the public key by exporting and re-importing
    const jwkPub = { ...privateKeyJwk };
    delete jwkPub.d; // remove private component
    jwkPub.key_ops = ['verify'];
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      jwkPub,
      { name: 'Ed25519' },
      true,
      ['verify']
    );

    const keyPair = { publicKey, privateKey };
    const podId = await derivePodId(publicKey);
    const identity = new PodIdentity({ keyPair, podId });
    const created = Date.now();
    const metadata = opts?.metadata || {};

    let rawPubKey = null;
    try {
      const raw = await crypto.subtle.exportKey('raw', publicKey);
      rawPubKey = new Uint8Array(raw);
    } catch { /* exportable: false — fall back to legacy DID form */ }

    this.#identities.set(podId, { identity, label, metadata, created, rawPubKey });
    this.#onLog('identity:import', { podId, label });

    if (this.#identities.size === 1) {
      this.#defaultId = podId;
    }

    return {
      podId,
      label,
      did: this.toDID(podId),
      created,
      metadata,
    };
  }

  // -- Export -------------------------------------------------------------

  /**
   * Export an identity as a JWK.
   *
   * Called with no passphrase, this returns the **raw private key** — that
   * is the documented plaintext-export path, and the caller is responsible
   * for what happens to it next.
   *
   * Called with a passphrase, it returns an encrypted envelope
   * (`{ encrypted: true, kdf, iterations, salt, iv, ciphertext }`) or it
   * throws. It never quietly hands back the plaintext key instead: a caller
   * who asked for encryption and got an unlabelled JWK would have no way to
   * tell, and would go on to write, paste or QR-encode a private key it
   * believed was protected.
   *
   * @param {string} podId
   * @param {string} [passphrase] - Encryption passphrase; must be a non-empty
   *   string when given. Omit it to export in the clear.
   * @returns {Promise<object>} The raw JWK, or an encrypted envelope
   * @throws {TypeError} If `passphrase` is given but is not a non-empty string
   * @throws {Error} If encryption was requested and could not be performed
   */
  async export(podId, passphrase) {
    const entry = this.#identities.get(podId);
    if (!entry) throw new Error(`Unknown identity: ${podId}`);

    if (passphrase !== undefined && passphrase !== null) {
      if (typeof passphrase !== 'string' || passphrase.length === 0) {
        throw new TypeError(
          'passphrase must be a non-empty string; omit it to export the key in the clear'
        );
      }
    }

    const jwk = await crypto.subtle.exportKey('jwk', entry.identity.keyPair.privateKey);

    if (passphrase === undefined || passphrase === null) return jwk;

    let envelope;
    try {
      envelope = await encryptWithPassphrase(JSON.stringify(jwk), passphrase);
    } catch (err) {
      // Deliberately not falling back to the plaintext JWK. Encryption was
      // asked for; if it cannot be done, the caller has to know.
      throw new Error(
        `Encrypted export failed for ${podId}: ${err?.message || err}. ` +
        'The private key was not exported.',
        { cause: err }
      );
    }

    return { encrypted: true, ...envelope };
  }

  // -- Lookup & Enumeration -----------------------------------------------

  /**
   * List all identities (no private keys).
   *
   * @returns {IdentitySummary[]}
   */
  list() {
    const out = [];
    for (const [podId, entry] of this.#identities) {
      out.push({
        podId,
        label: entry.label,
        did: this.toDID(podId),
        created: entry.created,
        metadata: { ...entry.metadata },
      });
    }
    return out;
  }

  /**
   * Get a single identity summary (no private key).
   *
   * @param {string} podId
   * @returns {IdentitySummary|null}
   */
  get(podId) {
    const entry = this.#identities.get(podId);
    if (!entry) return null;
    return {
      podId,
      label: entry.label,
      did: this.toDID(podId),
      created: entry.created,
      metadata: { ...entry.metadata },
    };
  }

  /**
   * Check whether an identity exists.
   *
   * @param {string} podId
   * @returns {boolean}
   */
  has(podId) {
    return this.#identities.has(podId);
  }

  /**
   * Delete an identity.
   *
   * @param {string} podId
   * @returns {boolean} true if it existed
   */
  delete(podId) {
    const existed = this.#identities.delete(podId);
    if (existed) {
      this.#onLog('identity:delete', { podId });
      if (this.#defaultId === podId) {
        const first = this.#identities.keys().next();
        this.#defaultId = first.done ? null : first.value;
      }
    }
    return existed;
  }

  // -- Default identity ---------------------------------------------------

  /**
   * Set the default identity.
   *
   * @param {string} podId
   */
  setDefault(podId) {
    if (!this.#identities.has(podId)) {
      throw new Error(`Unknown identity: ${podId}`);
    }
    this.#defaultId = podId;
  }

  /**
   * Get the default identity summary.
   *
   * @returns {IdentitySummary|null}
   */
  getDefault() {
    if (this.#defaultId && this.#identities.has(this.#defaultId)) {
      return this.get(this.#defaultId);
    }
    const first = this.#identities.keys().next();
    return first.done ? null : this.get(first.value);
  }

  // -- Cryptographic operations -------------------------------------------

  /**
   * Sign data with a specific identity.
   *
   * @param {string} podId
   * @param {BufferSource} data
   * @returns {Promise<Uint8Array>} Ed25519 signature
   */
  async sign(podId, data) {
    const entry = this.#identities.get(podId);
    if (!entry) throw new Error(`Unknown identity: ${podId}`);
    return entry.identity.sign(data);
  }

  /**
   * Verify a signature against a public key (raw bytes).
   *
   * @param {Uint8Array} publicKeyBytes - Raw Ed25519 public key (32 bytes)
   * @param {BufferSource} data
   * @param {BufferSource} signature
   * @returns {Promise<boolean>}
   */
  async verify(publicKeyBytes, data, signature) {
    const publicKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    return PodIdentity.verify(publicKey, data, signature);
  }

  /**
   * Get the raw public key bytes for an identity.
   *
   * @param {string} podId
   * @returns {Promise<Uint8Array>}
   */
  async getPublicKeyBytes(podId) {
    const entry = this.#identities.get(podId);
    if (!entry) throw new Error(`Unknown identity: ${podId}`);
    const raw = await crypto.subtle.exportKey('raw', entry.identity.keyPair.publicKey);
    return new Uint8Array(raw);
  }

  // -- DID support --------------------------------------------------------

  /**
   * Convert an identity's public key to a W3C did:key URI.
   *
   * Returns the proper W3C format `did:key:z<base58btc(0xed 0x01 + rawPubKey)>`
   * when the raw Ed25519 public key was cached at create/import time. Falls
   * back to the legacy `did:key:z<podId>` form if no raw key is cached
   * (older in-memory identities loaded before this upgrade).
   *
   * @param {string} podId
   * @returns {string}
   */
  toDID(podId) {
    const entry = this.#identities.get(podId);
    if (!entry) throw new Error(`Unknown identity: ${podId}`);
    if (entry.rawPubKey) {
      const prefixed = new Uint8Array(2 + entry.rawPubKey.length);
      prefixed[0] = 0xed;
      prefixed[1] = 0x01;
      prefixed.set(entry.rawPubKey, 2);
      return `did:key:z${base58btcEncode(prefixed)}`;
    }
    // Backward-compatibility: legacy form for entries without cached raw bytes
    return `did:key:z${podId}`;
  }

  /**
   * Legacy DID form, retained as a stable identifier alias.
   *
   * @param {string} podId
   * @returns {string}
   */
  toLegacyDID(podId) {
    if (!this.#identities.has(podId)) throw new Error(`Unknown identity: ${podId}`);
    return `did:key:z${podId}`;
  }

  // -- Size ---------------------------------------------------------------

  /** @returns {number} */
  get size() {
    return this.#identities.size;
  }

  // -- Persistence --------------------------------------------------------

  /**
   * Persist all identities to the storage adapter.
   */
  async save() {
    for (const [podId, entry] of this.#identities) {
      const jwk = await crypto.subtle.exportKey('jwk', entry.identity.keyPair.privateKey);
      await this.#storage.save(podId, {
        podId,
        label: entry.label,
        metadata: entry.metadata,
        created: entry.created,
        privateKeyJwk: jwk,
      });
    }
    // Also persist the default and the list of ids
    await this.#storage.save('__meta__', {
      defaultId: this.#defaultId,
      ids: [...this.#identities.keys()],
    });
    this.#onLog('identity:save', { count: this.#identities.size });
  }

  /**
   * Load all identities from the storage adapter.
   */
  async load() {
    const meta = await this.#storage.load('__meta__');
    if (!meta || !Array.isArray(meta.ids)) return;

    for (const podId of meta.ids) {
      const data = await this.#storage.load(podId);
      if (!data || !data.privateKeyJwk) continue;

      try {
        const privateKey = await crypto.subtle.importKey(
          'jwk',
          data.privateKeyJwk,
          { name: 'Ed25519' },
          true,
          ['sign']
        );

        const jwkPub = { ...data.privateKeyJwk };
        delete jwkPub.d;
        jwkPub.key_ops = ['verify'];
        const publicKey = await crypto.subtle.importKey(
          'jwk',
          jwkPub,
          { name: 'Ed25519' },
          true,
          ['verify']
        );

        const keyPair = { publicKey, privateKey };
        const identity = new PodIdentity({ keyPair, podId: data.podId });

        this.#identities.set(data.podId, {
          identity,
          label: data.label,
          metadata: data.metadata || {},
          created: data.created,
        });
      } catch (err) {
        this.#onLog('identity:load:error', { podId, error: err.message });
      }
    }

    if (meta.defaultId && this.#identities.has(meta.defaultId)) {
      this.#defaultId = meta.defaultId;
    }
    this.#onLog('identity:load', { count: this.#identities.size });
  }

  // -- Serialization (public-only) ----------------------------------------

  /**
   * Serialize all identities for JSON (no private keys).
   *
   * @returns {object}
   */
  toJSON() {
    return {
      defaultId: this.#defaultId,
      identities: this.list(),
    };
  }

  /**
   * Get the internal PodIdentity object (for signing/bridge operations).
   * @param {string} podId
   * @returns {PodIdentity|null}
   */
  getIdentity(podId) {
    const entry = this.#identities.get(podId);
    return entry ? entry.identity : null;
  }
}

// ---------------------------------------------------------------------------
// IndexedDBIdentityStorage
// ---------------------------------------------------------------------------

/**
 * IndexedDB-backed identity storage adapter.
 * Stores identity data in an "mesh-identities" object store with keyPath: podId.
 * Falls back gracefully when IndexedDB is unavailable (test environments).
 */
export class IndexedDBIdentityStorage {
  /** @type {string} */
  #dbName;

  /** @type {IDBDatabase|null} */
  #db = null;

  /** @type {string} */
  #storeName = 'identities';

  /**
   * @param {object} [opts]
   * @param {string} [opts.dbName='mesh-identities'] - IndexedDB database name
   */
  constructor(opts = {}) {
    this.#dbName = opts.dbName || 'mesh-identities';
  }

  /**
   * Open the IndexedDB database.
   * @returns {Promise<void>}
   */
  async open() {
    if (this.#db) return;
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB not available');
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.#dbName, 1);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.#storeName)) {
          db.createObjectStore(this.#storeName, { keyPath: 'podId' });
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
   * @param {string} podId
   * @param {*} data - Must include podId field
   * @returns {Promise<void>}
   */
  async save(podId, data) {
    if (!this.#db) await this.open();
    const record = { ...data, podId };
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(this.#storeName, 'readwrite');
      const store = tx.objectStore(this.#storeName);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`Failed to save identity "${podId}": ${req.error?.message}`));
    });
  }

  /**
   * @param {string} podId
   * @returns {Promise<*|null>}
   */
  async load(podId) {
    if (!this.#db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(this.#storeName, 'readonly');
      const store = tx.objectStore(this.#storeName);
      const req = store.get(podId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(new Error(`Failed to load identity "${podId}": ${req.error?.message}`));
    });
  }

  /**
   * @param {string} podId
   * @returns {Promise<boolean>}
   */
  async delete(podId) {
    if (!this.#db) await this.open();
    const existing = await this.load(podId);
    if (!existing) return false;
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(this.#storeName, 'readwrite');
      const store = tx.objectStore(this.#storeName);
      const req = store.delete(podId);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(new Error(`Failed to delete identity "${podId}": ${req.error?.message}`));
    });
  }

  /**
   * @returns {Promise<string[]>} List of podIds
   */
  async list() {
    if (!this.#db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(this.#storeName, 'readonly');
      const store = tx.objectStore(this.#storeName);
      const req = store.getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(new Error(`Failed to list identities: ${req.error?.message}`));
    });
  }

  /** @returns {Promise<void>} */
  async clear() {
    if (!this.#db) await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.#db.transaction(this.#storeName, 'readwrite');
      const store = tx.objectStore(this.#storeName);
      const req = store.clear();
      req.onsuccess = () => resolve();
      req.onerror = () => reject(new Error(`Failed to clear identities: ${req.error?.message}`));
    });
  }

  /** Close the database connection. */
  close() {
    if (this.#db) {
      this.#db.close();
      this.#db = null;
    }
  }
}

// ---------------------------------------------------------------------------
// VaultIdentityStorage
// ---------------------------------------------------------------------------

/**
 * Wraps another identity storage with passphrase-based encryption.
 * Only the privateKey field is encrypted; publicKey + metadata stored cleartext.
 * Uses PBKDF2(310k, SHA-256) → AES-256-GCM.
 *
 * `getPassphrase` must resolve to a non-empty string. An empty string or a
 * missing value is refused rather than used: PBKDF2 accepts an empty key and
 * `TextEncoder` renders `undefined` as the bytes `undefined`, either of which
 * would write a record that looks encrypted and is trivially readable.
 */
export class VaultIdentityStorage {
  /** @type {InMemoryIdentityStorage|IndexedDBIdentityStorage} */
  #inner;

  /** @type {Function} */
  #getPassphrase;

  /**
   * @param {InMemoryIdentityStorage|IndexedDBIdentityStorage} inner - Inner storage adapter
   * @param {object} opts
   * @param {Function} opts.getPassphrase - Async function that returns the vault passphrase
   */
  constructor(inner, { getPassphrase }) {
    if (!inner) throw new Error('inner storage is required');
    if (typeof getPassphrase !== 'function') throw new Error('getPassphrase must be a function');
    this.#inner = inner;
    this.#getPassphrase = getPassphrase;
  }

  /**
   * Save identity data, encrypting the privateKeyJwk field.
   * @param {string} podId
   * @param {*} data
   * @returns {Promise<void>}
   */
  async save(podId, data) {
    // Skip encryption for meta records
    if (podId === '__meta__') {
      return this.#inner.save(podId, data);
    }

    const record = { ...data };

    if (record.privateKeyJwk) {
      const passphrase = requirePassphrase(await this.#getPassphrase(), 'getPassphrase');
      record.encryptedPrivateKey = await encryptWithPassphrase(
        JSON.stringify(record.privateKeyJwk),
        passphrase
      );
      record.privateKeyJwk = null;
    }

    return this.#inner.save(podId, record);
  }

  /**
   * Load identity data, decrypting the privateKeyJwk field.
   * @param {string} podId
   * @returns {Promise<*|null>}
   */
  async load(podId) {
    const record = await this.#inner.load(podId);
    if (!record) return null;

    // Skip decryption for meta records
    if (podId === '__meta__') return record;

    if (record.encryptedPrivateKey) {
      const passphrase = requirePassphrase(await this.#getPassphrase(), 'getPassphrase');
      record.privateKeyJwk = JSON.parse(
        await decryptWithPassphrase(record.encryptedPrivateKey, passphrase)
      );
      delete record.encryptedPrivateKey;
    }

    return record;
  }

  /** @param {string} podId */
  async delete(podId) {
    return this.#inner.delete(podId);
  }

  /** @returns {Promise<string[]>} */
  async list() {
    return this.#inner.list();
  }

  /** @returns {Promise<void>} */
  async clear() {
    return this.#inner.clear();
  }
}

// ---------------------------------------------------------------------------
// IdentitySyncCoordinator
// ---------------------------------------------------------------------------

/**
 * Cross-tab identity coordination using BroadcastChannel.
 * Prevents race conditions when multiple tabs create identities simultaneously.
 */
export class IdentitySyncCoordinator {
  /** @type {BroadcastChannel} */
  #channel;

  /** @type {Map<string, string>} podId -> our local tiebreaker token */
  #pendingCreates = new Map();

  /** @type {Function[]} */
  #changeListeners = [];

  /**
   * @param {BroadcastChannel} [channel]
   */
  constructor(channel) {
    this.#channel = channel || new BroadcastChannel('mesh-identity-sync');
    this.#channel.onmessage = (event) => this.#handleMessage(event.data);
  }

  /**
   * Attempt to acquire a "create lock" for a pod ID.
   *
   * Broadcasts intent and waits briefly for conflicts. Includes a
   * tiebreaker token so two tabs racing to create the same podId
   * resolve deterministically (lower token wins) — without it, both
   * tabs would yield to the other and neither would acquire.
   *
   * @param {string} podId
   * @returns {Promise<boolean>} true if lock acquired
   */
  async acquireCreateLock(podId) {
    // Random token bound to this attempt. Lexicographic compare → lower wins.
    const myToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.#pendingCreates.set(podId, myToken);
    this.#channel.postMessage({ type: 'create-intent', podId, token: myToken });

    // Wait 100ms for conflict signals
    await new Promise(r => setTimeout(r, 100));

    if (this.#pendingCreates.has(podId)) {
      this.#pendingCreates.delete(podId);
      return true;
    }
    return false;
  }

  /**
   * Broadcast that an identity was created.
   * @param {string} podId
   */
  broadcastCreated(podId) {
    this.#channel.postMessage({ type: 'created', podId });
  }

  /**
   * Broadcast that an identity was deleted.
   * @param {string} podId
   */
  broadcastDeleted(podId) {
    this.#channel.postMessage({ type: 'deleted', podId });
  }

  /**
   * Register a callback for remote changes.
   * @param {Function} cb - Receives { type, podId }
   */
  onRemoteChange(cb) {
    this.#changeListeners.push(cb);
  }

  /** Close the broadcast channel. */
  close() {
    this.#channel.close();
  }

  /**
   * Handle incoming broadcast messages.
   * @param {object} msg
   */
  #handleMessage(msg) {
    if (!msg || !msg.type) return;

    if (msg.type === 'create-intent') {
      // Two tabs racing for the same podId both broadcast intent. The
      // tab whose intent arrives FIRST at the other has its handler
      // fire when the other's pendingCreates is empty (no-op). Without
      // a response, the first tab never sees the second's intent.
      //
      // Resolution: when we see a conflicting intent, ALWAYS reply with
      // our own intent — this way both tabs eventually see each other,
      // and the deterministic token comparison resolves it identically
      // on both sides. Lower token wins.
      const myToken = this.#pendingCreates.get(msg.podId);
      if (myToken) {
        const theirToken = typeof msg.token === 'string' ? msg.token : '';
        if (theirToken && theirToken < myToken) {
          // We lose — yield.
          this.#pendingCreates.delete(msg.podId);
        } else if (msg._isResponse !== true) {
          // We win (or peer is on old code without a token). Respond
          // with our own intent so the peer can compare and yield.
          // The `_isResponse` flag prevents infinite ping-pong.
          this.#channel.postMessage({
            type: 'create-intent',
            podId: msg.podId,
            token: myToken,
            _isResponse: true,
          });
        }
      }
    }

    if (msg.type === 'created' || msg.type === 'deleted') {
      for (const cb of this.#changeListeners) {
        try { cb(msg); } catch (e) { silentCatch('clawser-mesh-identity', 'swallow', e) }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AutoIdentityManager
// ---------------------------------------------------------------------------

/**
 * Automatic identity lifecycle manager.
 * Boots from storage, ensures a default identity exists, and provides
 * identity switching with listener notifications.
 */
export class AutoIdentityManager {
  /** @type {MeshIdentityManager} */
  #identityManager;

  /** @type {InMemoryIdentityStorage|IndexedDBIdentityStorage|VaultIdentityStorage} */
  #storage;

  /** @type {IdentitySyncCoordinator|null} */
  #syncCoordinator;

  /** @type {string|null} */
  #activeId = null;

  /** @type {Function[]} */
  #switchListeners = [];

  /** @type {boolean} */
  #booted = false;

  /**
   * @param {MeshIdentityManager} identityManager
   * @param {*} storage
   * @param {IdentitySyncCoordinator|null} [syncCoordinator]
   */
  constructor(identityManager, storage, syncCoordinator = null) {
    this.#identityManager = identityManager;
    this.#storage = storage;
    this.#syncCoordinator = syncCoordinator;
  }

  /**
   * Boot the identity system for a workspace.
   * Loads from storage, creates a default if none exist.
   * @param {string} workspaceId
   * @returns {Promise<void>}
   */
  async boot(workspaceId) {
    // Load existing identities from storage
    await this.#identityManager.load();

    // Create a default identity if none exist
    if (this.#identityManager.size === 0) {
      const summary = await this.#identityManager.create('default', {
        metadata: { workspaceId, autoCreated: true },
      });
      await this.#identityManager.save();

      if (this.#syncCoordinator) {
        this.#syncCoordinator.broadcastCreated(summary.podId);
      }
    }

    // Set active to the default identity
    const def = this.#identityManager.getDefault();
    if (def) {
      this.#activeId = def.podId;
    }

    this.#booted = true;
  }

  /**
   * Ensure an identity is available, creating one if needed.
   * @returns {Promise<PodIdentity|null>}
   */
  async ensureIdentity() {
    if (this.#activeId && this.#identityManager.has(this.#activeId)) {
      return this.#identityManager.getIdentity(this.#activeId);
    }

    if (this.#identityManager.size === 0) {
      const summary = await this.#identityManager.create('default');
      await this.#identityManager.save();
      this.#activeId = summary.podId;
    }

    const def = this.#identityManager.getDefault();
    if (def) {
      this.#activeId = def.podId;
      return this.#identityManager.getIdentity(def.podId);
    }
    return null;
  }

  /**
   * Switch the active identity.
   * @param {string} podId
   */
  async switchIdentity(podId) {
    if (!this.#identityManager.has(podId)) {
      throw new Error(`Unknown identity: ${podId}`);
    }
    const oldId = this.#activeId;
    this.#activeId = podId;
    this.#identityManager.setDefault(podId);

    for (const cb of this.#switchListeners) {
      try { cb({ oldId, newId: podId }); } catch (e) { silentCatch('clawser-mesh-identity', 'swallow', e) }
    }
  }

  /**
   * Get the active identity summary (no private keys).
   * @returns {import('./identity.mjs').IdentitySummary|null}
   */
  getActive() {
    if (this.#activeId) {
      return this.#identityManager.get(this.#activeId);
    }
    return this.#identityManager.getDefault();
  }

  /**
   * Get the active PodIdentity object (with keys).
   * @returns {PodIdentity|null}
   */
  getActiveIdentity() {
    if (this.#activeId) {
      return this.#identityManager.getIdentity(this.#activeId);
    }
    return null;
  }

  /**
   * List all identities with active status.
   * @returns {Array<{podId: string, label: string, isActive: boolean}>}
   */
  listIdentities() {
    return this.#identityManager.list().map(s => ({
      podId: s.podId,
      label: s.label,
      isActive: s.podId === this.#activeId,
    }));
  }

  /**
   * Register a listener for identity switches.
   * @param {Function} cb - Receives { oldId, newId }
   */
  onSwitch(cb) {
    this.#switchListeners.push(cb);
  }

  /** @returns {boolean} */
  get booted() {
    return this.#booted;
  }

  /** @returns {MeshIdentityManager} */
  get identityManager() {
    return this.#identityManager;
  }

  /**
   * Serialize auto-manager state.
   * @returns {object}
   */
  toJSON() {
    return {
      activeId: this.#activeId,
      booted: this.#booted,
    };
  }

  /**
   * Restore auto-manager state from serialized data.
   * @param {object} data
   */
  fromJSON(data) {
    if (data?.activeId) this.#activeId = data.activeId;
    if (data?.booted !== undefined) this.#booted = data.booted;
  }
}

// ---------------------------------------------------------------------------
// IdentitySelector
// ---------------------------------------------------------------------------

/**
 * Per-peer/per-scope identity selection.
 * Resolves which identity to use when connecting to a specific peer.
 */
export class IdentitySelector {
  /** @type {AutoIdentityManager} */
  #autoIdMgr;

  /** @type {Map<string, string>} peerId -> podId */
  #peerRules = new Map();

  /** @type {Map<string, string>} scope -> podId */
  #scopeRules = new Map();

  /**
   * @param {AutoIdentityManager} autoIdentityManager
   */
  constructor(autoIdentityManager) {
    this.#autoIdMgr = autoIdentityManager;
  }

  /**
   * Set a rule: use identity podId when connecting to peerId.
   * @param {string} peerId
   * @param {string} podId
   */
  setRule(peerId, podId) {
    this.#peerRules.set(peerId, podId);
  }

  /**
   * Set a default rule for a scope.
   * @param {string} scope
   * @param {string} podId
   */
  setDefaultRule(scope, podId) {
    this.#scopeRules.set(scope, podId);
  }

  /**
   * Remove a peer-specific rule.
   * @param {string} peerId
   * @returns {boolean}
   */
  removeRule(peerId) {
    return this.#peerRules.delete(peerId);
  }

  /**
   * Resolve which identity to use for a given peer and scope.
   * Priority: peer rule > scope rule > active identity.
   * @param {string} peerId
   * @param {string} [scope]
   * @returns {PodIdentity|null}
   */
  resolve(peerId, scope) {
    // Check peer-specific rule
    const peerPodId = this.#peerRules.get(peerId);
    if (peerPodId) {
      const identity = this.#autoIdMgr.identityManager.getIdentity(peerPodId);
      if (identity) return identity;
    }

    // Check scope rule
    if (scope) {
      const scopePodId = this.#scopeRules.get(scope);
      if (scopePodId) {
        const identity = this.#autoIdMgr.identityManager.getIdentity(scopePodId);
        if (identity) return identity;
      }
    }

    // Fallback to active identity
    return this.#autoIdMgr.getActiveIdentity();
  }

  /**
   * List all configured rules.
   * @returns {Array<{peerId?: string, scope?: string, podId: string}>}
   */
  listRules() {
    const rules = [];
    for (const [peerId, podId] of this.#peerRules) {
      rules.push({ peerId, podId });
    }
    for (const [scope, podId] of this.#scopeRules) {
      rules.push({ scope, podId });
    }
    return rules;
  }

  /**
   * Serialize rules.
   * @returns {object}
   */
  toJSON() {
    return {
      peerRules: Object.fromEntries(this.#peerRules),
      scopeRules: Object.fromEntries(this.#scopeRules),
    };
  }

  /**
   * Restore rules from serialized data.
   * @param {object} data
   */
  fromJSON(data) {
    if (data?.peerRules) {
      this.#peerRules = new Map(Object.entries(data.peerRules));
    }
    if (data?.scopeRules) {
      this.#scopeRules = new Map(Object.entries(data.scopeRules));
    }
  }
}
