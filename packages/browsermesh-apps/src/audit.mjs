/**
 * clawser-mesh-audit.js -- Cryptographic audit trail for BrowserMesh.
 *
 * Provides a tamper-evident, hash-chained log of operations with
 * Ed25519 signatures, Merkle proof generation/verification, and
 * fork detection.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-audit.test.mjs
 */

import { encodeBase64url, decodeBase64url } from '@johnhenry/browsermesh-primitives';
import { MESH_TYPE } from '@johnhenry/browsermesh-primitives';

// Re-export for consumers
export { encodeBase64url, decodeBase64url };

// ---------------------------------------------------------------------------
// Wire constants — imported from canonical registry
// ---------------------------------------------------------------------------

/** Wire type for a single audit entry. */
export const AUDIT_ENTRY = MESH_TYPE.AUDIT_ENTRY;

/** Wire type for querying an audit chain. */
export const AUDIT_CHAIN_QUERY = MESH_TYPE.AUDIT_CHAIN_QUERY;

/** Wire type for responding with audit chain data. */
export const AUDIT_CHAIN_RESPONSE = MESH_TYPE.AUDIT_CHAIN_RESPONSE;

// ---------------------------------------------------------------------------
// Genesis
// ---------------------------------------------------------------------------

/** The initial previous-hash for the first entry in every chain (32 zero bytes). */
export const GENESIS_HASH = new Uint8Array(32);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Produce canonical JSON for an object: keys sorted recursively,
 * Uint8Array values encoded as base64url strings.
 *
 * @param {object} obj
 * @returns {string}
 */
function canonicalJSON(obj) {
  return JSON.stringify(obj, (_key, value) => {
    if (value instanceof Uint8Array) {
      return encodeBase64url(value);
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted = {};
      for (const k of Object.keys(value).sort()) {
        sorted[k] = value[k];
      }
      return sorted;
    }
    return value;
  });
}

/**
 * SHA-256 hash of a UTF-8 string.
 *
 * @param {string} str
 * @returns {Promise<Uint8Array>}
 */
async function sha256(str) {
  const data = new TextEncoder().encode(str);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/**
 * SHA-256 hash of raw bytes.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function sha256Bytes(bytes) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * Concatenate two Uint8Arrays.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {Uint8Array}
 */
function concat(a, b) {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}

/**
 * Compare two Uint8Arrays for equality.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {boolean}
 */
function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// AuditEntry
// ---------------------------------------------------------------------------

/**
 * A single entry in a hash-chained audit log.
 *
 * @class
 */
export class AuditEntry {
  /**
   * @param {object} opts
   * @param {number} opts.sequence - Zero-based position in the chain
   * @param {string} opts.authorPodId - Pod ID of the author
   * @param {string} opts.operation - Operation name
   * @param {*} opts.data - Arbitrary operation payload
   * @param {Uint8Array} opts.previousHash - SHA-256 hash of the previous entry (or GENESIS_HASH)
   * @param {number} opts.timestamp - Creation timestamp (ms)
   * @param {Uint8Array|null} [opts.signature] - Ed25519 signature over all fields except signature
   */
  constructor({ sequence, authorPodId, operation, data, previousHash, timestamp, signature }) {
    /** @type {number} */
    this.sequence = sequence;
    /** @type {string} */
    this.authorPodId = authorPodId;
    /** @type {string} */
    this.operation = operation;
    /** @type {*} */
    this.data = data;
    /** @type {Uint8Array} */
    this.previousHash = previousHash;
    /** @type {number} */
    this.timestamp = timestamp;
    /** @type {Uint8Array|null} */
    this.signature = signature || null;
  }

  /**
   * Get the canonical bytes that are signed (all fields except signature).
   *
   * @returns {string} Canonical JSON string
   */
  get signedPayload() {
    return canonicalJSON({
      sequence: this.sequence,
      authorPodId: this.authorPodId,
      operation: this.operation,
      data: this.data,
      previousHash: this.previousHash,
      timestamp: this.timestamp,
    });
  }

  /**
   * Compute the SHA-256 hash of this entry's signed payload.
   *
   * @returns {Promise<Uint8Array>}
   */
  async hash() {
    return sha256(this.signedPayload);
  }

  /**
   * Serialize to a plain object (binary fields as base64url).
   *
   * @returns {object}
   */
  toJSON() {
    return {
      sequence: this.sequence,
      authorPodId: this.authorPodId,
      operation: this.operation,
      data: this.data,
      previousHash: encodeBase64url(this.previousHash),
      timestamp: this.timestamp,
      signature: this.signature ? encodeBase64url(this.signature) : null,
    };
  }

  /**
   * Deserialize from a plain object.
   *
   * @param {object} json
   * @returns {AuditEntry}
   */
  static fromJSON(json) {
    return new AuditEntry({
      sequence: json.sequence,
      authorPodId: json.authorPodId,
      operation: json.operation,
      data: json.data,
      previousHash: decodeBase64url(json.previousHash),
      timestamp: json.timestamp,
      signature: json.signature ? decodeBase64url(json.signature) : null,
    });
  }
}

// ---------------------------------------------------------------------------
// AuditChain
// ---------------------------------------------------------------------------

/**
 * A linear hash chain of AuditEntry objects.
 *
 * @class
 */
export class AuditChain {
  /** @type {string} */
  #chainId;

  /** @type {AuditEntry[]} */
  #entries = [];

  /**
   * @param {string} chainId - Unique identifier for this chain
   */
  constructor(chainId) {
    if (!chainId || typeof chainId !== 'string') {
      throw new Error('chainId must be a non-empty string');
    }
    this.#chainId = chainId;
  }

  /** @returns {string} */
  get chainId() {
    return this.#chainId;
  }

  /** @returns {number} */
  get length() {
    return this.#entries.length;
  }

  /**
   * Append a new signed entry to the chain.
   *
   * @param {string} authorPodId - Pod ID of the author
   * @param {string} operation - Operation name
   * @param {*} data - Arbitrary payload
   * @param {function(Uint8Array): Promise<Uint8Array>} signFn - Signing function
   * @returns {Promise<AuditEntry>}
   */
  async append(authorPodId, operation, data, signFn) {
    const sequence = this.#entries.length;
    const previousHash = sequence === 0
      ? GENESIS_HASH
      : await this.#entries[sequence - 1].hash();

    const entry = new AuditEntry({
      sequence,
      authorPodId,
      operation,
      data,
      previousHash,
      timestamp: Date.now(),
    });

    const payload = new TextEncoder().encode(entry.signedPayload);
    entry.signature = await signFn(payload);

    this.#entries.push(entry);
    return entry;
  }

  /**
   * Verify the entire chain: hash linkage and signatures.
   *
   * @param {function(string): Promise<Uint8Array|CryptoKey>} getPublicKey
   *   Resolves a podId to its Ed25519 public key (raw bytes or CryptoKey)
   * @returns {Promise<{ valid: boolean, error?: string, failedAt?: number }>}
   */
  async verify(getPublicKey) {
    for (let i = 0; i < this.#entries.length; i++) {
      const entry = this.#entries[i];

      // Check sequence
      if (entry.sequence !== i) {
        return { valid: false, error: 'sequence mismatch', failedAt: i };
      }

      // Check hash linkage
      const expectedPrev = i === 0
        ? GENESIS_HASH
        : await this.#entries[i - 1].hash();

      if (!bytesEqual(entry.previousHash, expectedPrev)) {
        return { valid: false, error: 'hash chain broken', failedAt: i };
      }

      // Verify signature
      if (!entry.signature) {
        return { valid: false, error: 'missing signature', failedAt: i };
      }

      const publicKey = await getPublicKey(entry.authorPodId);
      const payload = new TextEncoder().encode(entry.signedPayload);

      let valid;
      if (publicKey instanceof Uint8Array) {
        // Import raw bytes as CryptoKey
        const key = await crypto.subtle.importKey(
          'raw', publicKey, { name: 'Ed25519' }, false, ['verify']
        );
        valid = await crypto.subtle.verify('Ed25519', key, entry.signature, payload);
      } else {
        // Already a CryptoKey
        valid = await crypto.subtle.verify('Ed25519', publicKey, entry.signature, payload);
      }

      if (!valid) {
        return { valid: false, error: 'invalid signature', failedAt: i };
      }
    }

    return { valid: true };
  }

  /**
   * Get an entry by sequence number.
   *
   * @param {number} sequence
   * @returns {AuditEntry|null}
   */
  get(sequence) {
    return this.#entries[sequence] || null;
  }

  /**
   * Iterate over all entries.
   *
   * @returns {IterableIterator<AuditEntry>}
   */
  *entries() {
    for (const entry of this.#entries) {
      yield entry;
    }
  }

  /**
   * Return a slice of entries.
   *
   * @param {number} [start=0]
   * @param {number} [end]
   * @returns {AuditEntry[]}
   */
  slice(start = 0, end) {
    return this.#entries.slice(start, end);
  }

  /**
   * Serialize the chain.
   *
   * @returns {object}
   */
  toJSON() {
    return {
      chainId: this.#chainId,
      entries: this.#entries.map((e) => e.toJSON()),
    };
  }

  /**
   * Deserialize from JSON.
   *
   * @param {object} json
   * @returns {AuditChain}
   */
  static fromJSON(json) {
    const chain = new AuditChain(json.chainId);
    for (const entryData of json.entries) {
      chain.#entries.push(AuditEntry.fromJSON(entryData));
    }
    return chain;
  }
}

// ---------------------------------------------------------------------------
// AuditStore
// ---------------------------------------------------------------------------

/**
 * Manages multiple named AuditChains.
 *
 * @class
 */
export class AuditStore {
  /** @type {Map<string, AuditChain>} */
  #chains = new Map();

  /**
   * Create a new chain. Throws if it already exists.
   *
   * @param {string} chainId
   * @returns {AuditChain}
   */
  createChain(chainId) {
    if (this.#chains.has(chainId)) {
      throw new Error(`Chain already exists: ${chainId}`);
    }
    const chain = new AuditChain(chainId);
    this.#chains.set(chainId, chain);
    return chain;
  }

  /**
   * Get a chain by ID (or null).
   *
   * @param {string} chainId
   * @returns {AuditChain|null}
   */
  getChain(chainId) {
    return this.#chains.get(chainId) || null;
  }

  /**
   * Check whether a chain exists.
   *
   * @param {string} chainId
   * @returns {boolean}
   */
  hasChain(chainId) {
    return this.#chains.has(chainId);
  }

  /**
   * Delete a chain. Returns true if it was deleted.
   *
   * @param {string} chainId
   * @returns {boolean}
   */
  deleteChain(chainId) {
    return this.#chains.delete(chainId);
  }

  /**
   * List all chain IDs.
   *
   * @returns {string[]}
   */
  listChains() {
    return [...this.#chains.keys()];
  }

  /** @returns {number} */
  get size() {
    return this.#chains.size;
  }
}

// ---------------------------------------------------------------------------
// Fork detection
// ---------------------------------------------------------------------------

/**
 * Detect a fork among a set of entries that share the same chain.
 *
 * Entries are grouped by sequence number. If any sequence has two or
 * more entries with different hashes, a fork exists. Returns the
 * common ancestor (last non-forked entry) and the divergent branches.
 *
 * @param {AuditEntry[]} entries
 * @returns {Promise<{ ancestor: number, branches: AuditEntry[][] }|null>}
 */
export async function detectFork(entries) {
  if (entries.length === 0) return null;

  // Group by sequence
  const bySeq = new Map();
  for (const entry of entries) {
    if (!bySeq.has(entry.sequence)) {
      bySeq.set(entry.sequence, []);
    }
    bySeq.get(entry.sequence).push(entry);
  }

  // Find the first sequence with divergent entries
  const seqs = [...bySeq.keys()].sort((a, b) => a - b);

  for (const seq of seqs) {
    const group = bySeq.get(seq);
    if (group.length < 2) continue;

    // Check if all entries at this sequence are identical
    const hashes = await Promise.all(group.map((e) => e.hash()));
    const hashStrings = hashes.map((h) => encodeBase64url(h));
    const unique = new Set(hashStrings);

    if (unique.size > 1) {
      // Fork detected — group branches by hash
      const branchMap = new Map();
      for (let i = 0; i < group.length; i++) {
        const hs = hashStrings[i];
        if (!branchMap.has(hs)) branchMap.set(hs, []);
        branchMap.get(hs).push(group[i]);
      }

      return {
        ancestor: seq - 1,
        branches: [...branchMap.values()],
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Merkle proof helpers
// ---------------------------------------------------------------------------

/**
 * Build a Merkle root from a list of audit entries.
 *
 * Leaves are the SHA-256 hashes of each entry's signed payload.
 * The tree is built bottom-up; odd layers duplicate the last node.
 *
 * @param {AuditEntry[]} entries
 * @returns {Promise<Uint8Array>} The Merkle root hash
 */
export async function buildMerkleRoot(entries) {
  if (entries.length === 0) {
    return new Uint8Array(32); // empty root
  }

  let layer = await Promise.all(entries.map((e) => e.hash()));

  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i]; // duplicate last
      next.push(await sha256Bytes(concat(left, right)));
    }
    layer = next;
  }

  return layer[0];
}

/**
 * Build a Merkle inclusion proof for the entry at `index`.
 *
 * @param {AuditEntry[]} entries
 * @param {number} index - Index of the entry to prove
 * @returns {Promise<{ root: Uint8Array, proof: Array<{ hash: Uint8Array, position: 'left'|'right' }>, index: number }>}
 */
export async function buildMerkleProof(entries, index) {
  if (index < 0 || index >= entries.length) {
    throw new RangeError(`Index ${index} out of range [0, ${entries.length})`);
  }

  let layer = await Promise.all(entries.map((e) => e.hash()));
  const proof = [];
  let currentIndex = index;

  while (layer.length > 1) {
    const next = [];
    for (let i = 0; i < layer.length; i += 2) {
      const left = layer[i];
      const right = i + 1 < layer.length ? layer[i + 1] : layer[i];

      if (i === currentIndex || i + 1 === currentIndex) {
        if (currentIndex % 2 === 0) {
          // Current is the left child, sibling is right
          const sibling = i + 1 < layer.length ? layer[i + 1] : layer[i];
          proof.push({ hash: sibling, position: 'right' });
        } else {
          // Current is the right child, sibling is left
          proof.push({ hash: layer[i], position: 'left' });
        }
      }

      next.push(await sha256Bytes(concat(left, right)));
    }
    currentIndex = Math.floor(currentIndex / 2);
    layer = next;
  }

  return { root: layer[0], proof, index };
}

/**
 * Verify a Merkle inclusion proof.
 *
 * @param {Uint8Array} entryHash - SHA-256 hash of the entry
 * @param {Array<{ hash: Uint8Array, position: 'left'|'right' }>} proof - Sibling hashes
 * @param {number} index - Original index of the entry
 * @param {Uint8Array} root - Expected Merkle root
 * @returns {Promise<boolean>}
 */
export async function verifyMerkleProof(entryHash, proof, index, root) {
  let current = entryHash;
  let idx = index;

  for (const step of proof) {
    if (step.position === 'right') {
      current = await sha256Bytes(concat(current, step.hash));
    } else {
      current = await sha256Bytes(concat(step.hash, current));
    }
    idx = Math.floor(idx / 2);
  }

  return bytesEqual(current, root);
}
