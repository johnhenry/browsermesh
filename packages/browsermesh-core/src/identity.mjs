/**
 * identity.mjs -- Mesh identity management.
 *
 * Manages multiple Ed25519 cryptographic identities with vault-encrypted
 * storage. Imports primitives from mesh-primitives; adds persistence,
 * vault encryption, and DID support.
 *
 * Browser/Node dual: crypto.subtle calls are gated behind async methods.
 * Storage adapter pattern allows OPFS in browser, in-memory in tests.
 *
 * Run tests:
 *   cd packages/browsermesh-core && node --import ./test/_setup-globals.mjs --test test/identity.test.mjs
 */

import { silentCatch } from './silent-catch.mjs'
import { seal, open as openRecord, needsUpgrade, VaultError } from '@johnhenry/keyvault';
import {
  PodIdentity,
  derivePodId,
  encodeBase64url,
  decodeBase64url,
} from '@johnhenry/browsermesh-primitives';

// Re-export primitives used by consumers
export { PodIdentity, derivePodId, encodeBase64url, decodeBase64url };

// ---------------------------------------------------------------------------
// Passphrase encryption (via @johnhenry/keyvault)
// ---------------------------------------------------------------------------

/** Record type of an encrypted private key stored by VaultIdentityStorage. */
const VAULT_TYPE = 'browsermesh-vault';
/** Record type of an encrypted identity export (`export(podId, passphrase)`). */
const EXPORT_TYPE = 'browsermesh-identity-export';
/**
 * The only KDF name the pre-keyvault envelope (`kdf` was a string) could carry.
 * Kept to refuse any other string with the message callers have always seen.
 */
const LEGACY_VAULT_KDF = 'PBKDF2-SHA256';

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

// ---------------------------------------------------------------------------
// Realm seed (docs/design/realms.md, 5.10)
// ---------------------------------------------------------------------------

/** Domain string of the per-realm identity derivation (HKDF `info` prefix). */
export const REALM_DERIVATION_DOMAIN = 'browsermesh/realm/v1';
/** Record type of an exported realm seed. */
export const REALM_SEED_TYPE = 'browsermesh-realm-seed';
/** Format number of the readable, authenticated header of a seed export. */
const REALM_SEED_FORMAT = 1;
const SEED_BYTES = 32;
/** Fixed 16-byte PKCS#8 header of an Ed25519 private key; the 32 key bytes follow. */
const ED25519_PKCS8_HEADER = Uint8Array.of(
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20
);

/**
 * A realm seed could not be exported or imported. `code` is the keyvault
 * `VaultError` code (`bad_passphrase`, `wrong_type`, `corrupt`, `unsupported`)
 * or `bad_seed` for a record that opened but did not hold a 32-byte seed;
 * `cause` is the original error.
 */
export class RealmSeedError extends Error {
  /** @param {string} code @param {string} message @param {Error} [cause] */
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = 'RealmSeedError';
    this.code = code;
  }
}

/**
 * @param {*} realmId
 * @returns {string}
 * @throws {TypeError} Unless a non-empty string without a NUL character
 */
function requireRealmId(realmId) {
  if (typeof realmId !== 'string' || realmId.length === 0 || realmId.includes('\0')) {
    throw new TypeError('realmId must be a non-empty string without a NUL character');
  }
  return realmId;
}

/**
 * Encrypt a UTF-8 string under a passphrase with keyvault (PBKDF2-SHA256 at
 * keyvault's current default, AES-256-GCM, KDF parameters and `header`
 * authenticated and stored in the record).
 *
 * @param {string} plaintext
 * @param {string} passphrase
 * @param {string} type - Record type
 * @param {object} [header] - Extra readable, authenticated fields
 * @returns {Promise<object>} A keyvault record (plain JSON object)
 */
async function encryptWithPassphrase(plaintext, passphrase, type, header) {
  return JSON.parse(await seal(plaintext, passphrase, { type, header }));
}

/**
 * Inverse of {@link encryptWithPassphrase}. Also opens envelopes written by
 * browsermesh-core <= 0.8.0 (`{ kdf?, iterations?, salt, iv, ciphertext }`,
 * 310k iterations when `iterations` is absent, passphrase used as typed).
 *
 * Errors keep the shapes this API has always had: a wrong passphrase (or a
 * modified record) rejects with a DOMException named `OperationError`, an
 * unknown string `kdf` with `Unsupported key derivation function: <kdf>`.
 * Anything else keyvault reports is rethrown as its `VaultError`.
 *
 * @param {object} envelope
 * @param {string} passphrase
 * @param {string[]} types - Accepted record types
 * @returns {Promise<{ plaintext: string, upgrade: boolean }>}
 */
async function decryptWithPassphrase(envelope, passphrase, types) {
  if (typeof envelope?.kdf === 'string' && envelope.kdf !== LEGACY_VAULT_KDF) {
    throw new Error(`Unsupported key derivation function: ${envelope.kdf}`);
  }
  try {
    const r = await openRecord(envelope, passphrase);
    if (!types.includes(r.type)) {
      throw new VaultError('wrong_type', `unexpected record type ${JSON.stringify(String(r.type).slice(0, 60))}`);
    }
    return {
      plaintext: new TextDecoder().decode(r.payload),
      upgrade: needsUpgrade(envelope),
    };
  } catch (err) {
    if (err instanceof VaultError && err.code === 'bad_passphrase') {
      const e = new DOMException('The operation failed for an operation-specific reason', 'OperationError');
      e.cause = err;
      throw e;
    }
    throw err;
  }
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

  /** @type {Uint8Array|null} Realm seed; extractable by design (see exportSeed). */
  #seed = null;

  /** @type {{ label: string, createdAt: number }|null} */
  #seedInfo = null;

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
   * Import an identity from a JWK private key, or from an encrypted export.
   *
   * Accepts either shape {@link MeshIdentityManager#export} produces: a raw
   * JWK, or the `{ encrypted: true, ... }` envelope. Before this took the
   * envelope, an encrypted export was write-only -- the safe thing to do with
   * a backup produced a backup this library could not restore.
   *
   * The passphrase travels in `opts` rather than as a fourth positional,
   * because `opts` is already the third parameter and `import(jwk, label,
   * undefined, pw)` is not a signature anyone should have to write.
   *
   * @param {object} keyData - An Ed25519 private key JWK, or an encrypted
   *   envelope from `export(podId, passphrase)`
   * @param {string} label - Human-readable name
   * @param {object} [opts]
   * @param {string} [opts.passphrase] - Required when `keyData` is encrypted
   * @param {object} [opts.metadata]
   * @returns {Promise<IdentitySummary>}
   * @throws {TypeError} If an encrypted envelope is given without a passphrase
   * @throws {Error} If the passphrase is wrong or the envelope is damaged
   */
  async import(keyData, label, opts = {}) {
    if (!label || typeof label !== 'string') {
      throw new Error('Label is required and must be a non-empty string');
    }
    if (!keyData || typeof keyData !== 'object') {
      throw new Error('privateKeyJwk must be a valid JWK object');
    }

    let privateKeyJwk = keyData;
    if (keyData.encrypted) {
      const passphrase = requirePassphrase(opts?.passphrase, 'opts.passphrase');
      // One message for a wrong passphrase and for a damaged envelope alike.
      // AES-GCM cannot tell them apart anyway, and reporting "decrypted but
      // the contents were not a key" would confirm to someone guessing that
      // a passphrase was correct.
      const unreadable = (err) => new Error(
        'Could not read the encrypted identity export: the passphrase is ' +
        'wrong, or the export is damaged.',
        { cause: err }
      );
      let plaintext;
      try {
        ({ plaintext } = await decryptWithPassphrase(keyData, passphrase, [VAULT_TYPE, EXPORT_TYPE]));
      } catch (err) {
        throw unreadable(err);
      }
      try {
        privateKeyJwk = JSON.parse(plaintext);
      } catch (err) {
        throw unreadable(err);
      }
      if (!privateKeyJwk || typeof privateKeyJwk !== 'object') {
        throw unreadable(new Error('decrypted payload was not a JWK object'));
      }
    } else if (opts?.passphrase !== undefined && opts?.passphrase !== null) {
      // A caller who supplied a passphrase believes this blob is encrypted.
      // Importing it quietly would hand them an identity restored from a
      // plaintext private key while they believed it had been protected --
      // the same confusion #18 was about, arriving from the other direction.
      throw new Error(
        'A passphrase was supplied but this export is not encrypted. ' +
        'Import it without a passphrase, or check you have the right file.'
      );
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

  // -- Realm seed and per-realm identities ----------------------------------
  //
  // One random 32-byte seed; each realm gets its own Ed25519 identity,
  // HKDF-derived from it. See docs/design/realms.md 5.10.
  //
  // Trade-offs, by decision: the seed is EXTRACTABLE (so one backup recovers
  // every realm identity), which means any script running in the page can read
  // it while it is loaded. The derived identity keys are not extractable.
  // Per-realm keys unlink keys across realms; they do not hide an IP address
  // or what a relay can see.

  /** @returns {boolean} Whether a realm seed is held */
  get hasSeed() {
    return this.#seed !== null;
  }

  /**
   * Generate a fresh random 32-byte realm seed and hold it. Replaces any seed
   * already held (identities derived from the old one stay registered).
   *
   * @param {object} [opts]
   * @param {string} [opts.label] - Label written into exports
   */
  createSeed(opts = {}) {
    this.setSeed(crypto.getRandomValues(new Uint8Array(SEED_BYTES)), opts);
  }

  /**
   * Hold a given 32-byte seed (copied). Use {@link MeshIdentityManager#importSeed}
   * to restore from a backup.
   *
   * @param {Uint8Array} seed
   * @param {object} [opts]
   * @param {string} [opts.label]
   * @param {number} [opts.createdAt]
   * @throws {TypeError} Unless `seed` is a 32-byte Uint8Array
   */
  setSeed(seed, opts = {}) {
    if (!(seed instanceof Uint8Array) || seed.length !== SEED_BYTES) {
      throw new TypeError(`seed must be a ${SEED_BYTES}-byte Uint8Array`);
    }
    this.#seed = new Uint8Array(seed);
    this.#seedInfo = {
      label: typeof opts.label === 'string' ? opts.label : 'realm seed',
      createdAt: Number.isFinite(opts.createdAt) ? opts.createdAt : Date.now(),
    };
    this.#onLog('identity:seed:set', {});
  }

  #requireSeed() {
    if (!this.#seed) {
      throw new Error('No realm seed: call createSeed(), setSeed() or importSeed() first');
    }
    return this.#seed;
  }

  /**
   * The 32 bytes HKDF-SHA-256 derives for a realm: empty salt,
   * `info = UTF-8("browsermesh/realm/v1 identity " + realmId)`. They are the
   * Ed25519 private-key seed of that realm's identity, so treat them as secret.
   *
   * @param {string} realmId
   * @returns {Promise<Uint8Array>}
   */
  async deriveRealmKeyBytes(realmId) {
    requireRealmId(realmId);
    const seed = this.#requireSeed();
    const base = await crypto.subtle.importKey('raw', seed, 'HKDF', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(`${REALM_DERIVATION_DOMAIN} identity ${realmId}`),
      },
      base,
      SEED_BYTES * 8
    );
    return new Uint8Array(bits);
  }

  /**
   * Derive (or return, if already registered) the identity of a realm from the
   * seed. The same seed and realm id always give the same key; different realm
   * ids give unrelated keys. The private key is NON-extractable. Existing
   * random identities cannot be derived, and `save()` skips derived identities
   * (they come back from the seed).
   *
   * @param {string} realmId
   * @param {object} [opts]
   * @param {string} [opts.label] - Default `realm:<realmId>`
   * @param {object} [opts.metadata] - Merged under `{ realm, derived: true }`
   * @returns {Promise<IdentitySummary>}
   * @throws {TypeError} For an invalid realm id
   * @throws {Error} If no seed is held
   */
  async deriveRealmIdentity(realmId, opts = {}) {
    requireRealmId(realmId);
    const bytes = await this.deriveRealmKeyBytes(realmId);
    const pkcs8 = new Uint8Array(ED25519_PKCS8_HEADER.length + SEED_BYTES);
    pkcs8.set(ED25519_PKCS8_HEADER);
    pkcs8.set(bytes, ED25519_PKCS8_HEADER.length);
    let identity;
    try {
      // A non-extractable Ed25519 key cannot give up its public key, so read it
      // from an extractable probe import first, then keep only the other one.
      const probe = await PodIdentity.fromPkcs8(pkcs8, { extractable: true });
      identity = await PodIdentity.fromPkcs8(pkcs8, { extractable: false, publicKey: probe.keyPair.publicKey });
    } finally {
      pkcs8.fill(0);
      bytes.fill(0);
    }
    if (this.#identities.has(identity.podId)) return this.get(identity.podId);
    return this.#register(identity, opts.label ?? `realm:${realmId}`, {
      ...(opts.metadata || {}),
      realm: realmId,
      derived: true,
    }, true);
  }

  /**
   * Create the identity of a realm.
   *
   * With `derive: true` (the default) this is {@link MeshIdentityManager#deriveRealmIdentity}.
   *
   * With `derive: false` it makes an INDEPENDENT RANDOM key labelled for the
   * realm: the documented fallback for a browser that cannot derive. That key
   * is NOT recoverable from the seed; it needs its own backup
   * (`export(podId, passphrase)`), one per realm, and each call makes a new
   * key.
   *
   * @param {string} realmId
   * @param {object} [opts]
   * @param {boolean} [opts.derive=true]
   * @param {string} [opts.label]
   * @param {object} [opts.metadata]
   * @returns {Promise<IdentitySummary>}
   */
  async createRealmIdentity(realmId, opts = {}) {
    requireRealmId(realmId);
    if (opts.derive !== false) return this.deriveRealmIdentity(realmId, opts);
    const identity = await PodIdentity.generate();
    return this.#register(identity, opts.label ?? `realm:${realmId}`, {
      ...(opts.metadata || {}),
      realm: realmId,
      derived: false,
    }, false);
  }

  async #register(identity, label, metadata, derived) {
    const created = Date.now();
    let rawPubKey = null;
    try {
      rawPubKey = new Uint8Array(await crypto.subtle.exportKey('raw', identity.keyPair.publicKey));
    } catch { /* fall back to legacy DID form */ }
    this.#identities.set(identity.podId, { identity, label, metadata, created, rawPubKey, derived });
    this.#onLog('identity:realm', { podId: identity.podId, label, derived });
    if (this.#identities.size === 1) this.#defaultId = identity.podId;
    return { podId: identity.podId, label, did: this.toDID(identity.podId), created, metadata };
  }

  /**
   * Back the seed up as a passphrase-encrypted keyvault record (type
   * `browsermesh-realm-seed`). One backup recovers every derived realm
   * identity; it does not recover fallback (`derive: false`) identities.
   * The readable, authenticated header is `{ fmt: 1, label, createdAt }`.
   *
   * @param {string} passphrase - Non-empty string
   * @param {object} [opts]
   * @param {string} [opts.label]
   * @returns {Promise<string>} Record text (JSON)
   * @throws {TypeError} For an empty or missing passphrase
   * @throws {Error} If no seed is held
   */
  async exportSeed(passphrase, opts = {}) {
    requirePassphrase(passphrase, 'passphrase');
    const seed = this.#requireSeed();
    return seal(seed, passphrase, {
      type: REALM_SEED_TYPE,
      header: {
        fmt: REALM_SEED_FORMAT,
        label: typeof opts.label === 'string' ? opts.label : this.#seedInfo.label,
        createdAt: this.#seedInfo.createdAt,
      },
    });
  }

  /**
   * Restore the seed from {@link MeshIdentityManager#exportSeed} output and
   * hold it (replacing any seed held).
   *
   * @param {string|object} text - The record text (or parsed record)
   * @param {string} passphrase
   * @returns {Promise<{ label: string, createdAt: number }>}
   * @throws {TypeError} For an empty or missing passphrase
   * @throws {RealmSeedError} `code` is `bad_passphrase` (wrong passphrase or
   *   modified record or header), `wrong_type`, `corrupt`, `unsupported` or `bad_seed`
   */
  async importSeed(text, passphrase) {
    requirePassphrase(passphrase, 'passphrase');
    let r;
    try {
      r = await openRecord(text, passphrase, { type: REALM_SEED_TYPE });
    } catch (err) {
      if (err instanceof VaultError) {
        const why = {
          bad_passphrase: 'the passphrase is wrong, or the seed backup was modified',
          wrong_type: 'this is not a realm seed backup',
          corrupt: 'the seed backup is damaged or not a backup at all',
          unsupported: 'the seed backup uses a format or key derivation this version does not support',
        }[err.code] ?? err.message;
        throw new RealmSeedError(err.code, `Could not import the realm seed: ${why}.`, err);
      }
      throw err;
    }
    if (!(r.payload instanceof Uint8Array) || r.payload.length !== SEED_BYTES || r.header?.fmt !== REALM_SEED_FORMAT) {
      throw new RealmSeedError('bad_seed', 'Could not import the realm seed: the record does not hold a version-1 32-byte seed.');
    }
    const info = {
      label: typeof r.header.label === 'string' ? r.header.label : 'realm seed',
      createdAt: Number.isFinite(r.header.createdAt) ? r.header.createdAt : Date.now(),
    };
    this.setSeed(r.payload, info);
    r.payload.fill(0);
    return info;
  }

  // -- Export -------------------------------------------------------------

  /**
   * Export an identity as a JWK.
   *
   * Called with no passphrase, this returns the **raw private key** — that
   * is the documented plaintext-export path, and the caller is responsible
   * for what happens to it next.
   *
   * Called with a passphrase, it returns an encrypted envelope, a
   * `@johnhenry/keyvault` record
   * (`{ v, t, encrypted: true, kdf: { name, iterations, salt }, iv, ct }`;
   * browsermesh-core <= 0.8.0 wrote `{ encrypted: true, kdf, iterations,
   * salt, iv, ciphertext }`, which `import()` still reads) or it
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
      envelope = await encryptWithPassphrase(JSON.stringify(jwk), passphrase, EXPORT_TYPE, { encrypted: true });
    } catch (err) {
      // Deliberately not falling back to the plaintext JWK. Encryption was
      // asked for; if it cannot be done, the caller has to know.
      throw new Error(
        `Encrypted export failed for ${podId}: ${err?.message || err}. ` +
        'The private key was not exported.',
        { cause: err }
      );
    }

    return envelope;
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
   * Argument order is `(publicKey, signature, data)`, the same as
   * `crypto.subtle.verify`. BREAKING in core 0.5.0: previously
   * `(publicKey, data, signature)`. Throws a TypeError when the old order is
   * detected (64-byte data with a non-64-byte signature).
   *
   * @param {Uint8Array} publicKeyBytes - Raw Ed25519 public key (32 bytes)
   * @param {BufferSource} signature - Ed25519 signature (64 bytes)
   * @param {BufferSource} data
   * @returns {Promise<boolean>}
   */
  async verify(publicKeyBytes, signature, data) {
    const publicKey = await crypto.subtle.importKey(
      'raw',
      publicKeyBytes,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    return PodIdentity.verify(publicKey, signature, data);
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
    const saved = [];
    for (const [podId, entry] of this.#identities) {
      // Derived realm identities are non-extractable and come back from the seed.
      if (entry.derived) continue;
      saved.push(podId);
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
      ids: saved,
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
 * Uses @johnhenry/keyvault (PBKDF2-SHA256 → AES-256-GCM). Records written by
 * browsermesh-core <= 0.8.0 (310k iterations) still open and are re-encrypted
 * with keyvault's current defaults on the first successful load.
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
        passphrase,
        VAULT_TYPE
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
      const stored = record.encryptedPrivateKey;
      const { plaintext, upgrade } = await decryptWithPassphrase(stored, passphrase, [VAULT_TYPE]);
      record.privateKeyJwk = JSON.parse(plaintext);
      delete record.encryptedPrivateKey;

      // Re-encrypt records written under older parameters (310k iterations,
      // no kdf recorded, the pre-keyvault envelope) with the current defaults.
      // Best effort: the unlock has succeeded either way, and the old record
      // stays valid if the write-back fails.
      if (upgrade) {
        try {
          await this.#inner.save(podId, {
            ...record,
            privateKeyJwk: null,
            encryptedPrivateKey: await encryptWithPassphrase(plaintext, passphrase, VAULT_TYPE),
          });
        } catch (err) {
          silentCatch('identity', 'vault-upgrade', err);
        }
      }
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
        try { cb(msg); } catch (e) { silentCatch('identity', 'swallow', e) }
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
      try { cb({ oldId, newId: podId }); } catch (e) { silentCatch('identity', 'swallow', e) }
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
