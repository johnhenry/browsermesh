/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-naming.js -- Decentralized name resolution for BrowserMesh.
 *
 * Human-friendly names (@alice, mesh://alice/path) mapped to identity
 * fingerprints. First-come-first-served registration, TTL-based expiry,
 * ownership transfer, and reverse lookup.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-naming.test.mjs
 */

import { MESH_TYPE } from '@johnhenry/browsermesh-primitives';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TTL in milliseconds (1 hour) */
export const NAME_TTL_DEFAULT = 3600000;

/** Maximum length for a name */
export const MAX_NAME_LENGTH = 64;

/**
 * Valid name pattern: lowercase alphanumeric, dots, hyphens, underscores.
 * Must start and end with alphanumeric. Minimum 2 characters.
 */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/;

// ---------------------------------------------------------------------------
// parseMeshUri
// ---------------------------------------------------------------------------

/**
 * Parse various mesh name formats into a structured object.
 *
 * Supported formats:
 * - `@alice` → short name
 * - `@alice@relay.example.com` → qualified name
 * - `did:key:z6Mk...` → DID key reference
 * - `mesh://alice/service/path` → mesh URI
 *
 * @param {string} uri
 * @returns {{ type: string, name?: string, relay?: string|null, fingerprint?: string, path?: string|null }|null}
 */
export function parseMeshUri(uri) {
  if (!uri || typeof uri !== 'string') return null;

  // mesh://name/path
  const meshMatch = uri.match(/^mesh:\/\/([^/]+)(\/.*)?$/);
  if (meshMatch) {
    return {
      type: 'mesh',
      name: meshMatch[1],
      relay: null,
      path: meshMatch[2] || null,
    };
  }

  // did:key:fingerprint
  const didMatch = uri.match(/^did:key:(.+)$/);
  if (didMatch) {
    return {
      type: 'did',
      fingerprint: didMatch[1],
      path: null,
    };
  }

  // @name@relay or @name
  const atMatch = uri.match(/^@([^@]+)(?:@(.+))?$/);
  if (atMatch) {
    if (atMatch[2]) {
      return {
        type: 'qualified',
        name: atMatch[1],
        relay: atMatch[2],
        path: null,
      };
    }
    return {
      type: 'short',
      name: atMatch[1],
      relay: null,
      path: null,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// NameRecord
// ---------------------------------------------------------------------------

/**
 * A name registration record.
 */
export class NameRecord {
  /**
   * @param {object} opts
   * @param {string} opts.name
   * @param {string} opts.fingerprint - Owner's identity fingerprint
   * @param {number} [opts.timestamp]
   * @param {number} [opts.ttl]
   * @param {string} [opts.relay]
   * @param {object} [opts.metadata]
   */
  constructor({ name, fingerprint, timestamp, ttl, relay, metadata }) {
    this.name = name;
    this.fingerprint = fingerprint;
    this.timestamp = timestamp ?? Date.now();
    this.ttl = ttl ?? NAME_TTL_DEFAULT;
    this.relay = relay ?? null;
    this.metadata = metadata ? { ...metadata } : null;
  }

  /**
   * @param {number} [now]
   * @returns {boolean}
   */
  isExpired(now = Date.now()) {
    return now > this.timestamp + this.ttl;
  }

  toJSON() {
    return {
      name: this.name,
      fingerprint: this.fingerprint,
      timestamp: this.timestamp,
      ttl: this.ttl,
      relay: this.relay,
      metadata: this.metadata ? { ...this.metadata } : null,
    };
  }

  static fromJSON(data) {
    return new NameRecord({
      name: data.name,
      fingerprint: data.fingerprint,
      timestamp: data.timestamp,
      ttl: data.ttl,
      relay: data.relay,
      metadata: data.metadata,
    });
  }
}

// ---------------------------------------------------------------------------
// MeshNameResolver
// ---------------------------------------------------------------------------

/**
 * Decentralized name registry.
 *
 * First-come-first-served: only the original owner (same fingerprint)
 * can renew or update a registration. Names expire after TTL.
 */
export class MeshNameResolver {
  /**
   * @param {object} [opts]
   * @param {function} [opts.onLog]
   */
  constructor(opts = {}) {
    this._onLog = opts.onLog || (() => {});
    /** @type {Map<string, NameRecord>} name → record */
    this._records = new Map();
  }

  // ── Registration ───────────────────────────────────────────────────

  /**
   * Register or renew a name.
   *
   * @param {string} name
   * @param {string} fingerprint
   * @param {object} [opts]
   * @param {number} [opts.ttl]
   * @param {string} [opts.relay]
   * @param {object} [opts.metadata]
   * @returns {NameRecord}
   */
  register(name, fingerprint, opts = {}) {
    this._validateName(name);

    const existing = this._records.get(name);
    if (existing && !existing.isExpired() && existing.fingerprint !== fingerprint) {
      throw new Error(`Name "${name}" is already taken`);
    }

    const record = new NameRecord({
      name,
      fingerprint,
      ttl: opts.ttl,
      relay: opts.relay,
      metadata: opts.metadata,
    });
    this._records.set(name, record);
    return record;
  }

  /**
   * Unregister a name. Only the current owner can unregister.
   *
   * @param {string} name
   * @param {string} fingerprint
   * @returns {boolean}
   */
  unregister(name, fingerprint) {
    const existing = this._records.get(name);
    if (!existing) return false;
    if (existing.fingerprint !== fingerprint) return false;
    this._records.delete(name);
    return true;
  }

  // ── Resolution ─────────────────────────────────────────────────────

  /**
   * Resolve a URI to a fingerprint and record.
   *
   * @param {string} uri
   * @returns {{ fingerprint: string, record: NameRecord }|null}
   */
  resolve(uri) {
    const parsed = parseMeshUri(uri);
    if (!parsed) return null;

    if (parsed.type === 'did') {
      // DID resolves directly to its fingerprint — look up any names
      // that match, or return a synthetic result
      const records = this.reverseResolve(parsed.fingerprint);
      if (records.length > 0) {
        return { fingerprint: parsed.fingerprint, record: records[0] };
      }
      return null;
    }

    // For short, qualified, and mesh URIs, look up by name
    const name = parsed.name;
    if (!name) return null;

    const record = this._records.get(name);
    if (!record) return null;
    if (record.isExpired()) return null;

    // For qualified URIs, optionally verify relay matches
    if (parsed.type === 'qualified' && record.relay && parsed.relay !== record.relay) {
      return null;
    }

    return { fingerprint: record.fingerprint, record };
  }

  /**
   * Reverse-resolve: find all names registered to a fingerprint.
   *
   * @param {string} fingerprint
   * @returns {NameRecord[]}
   */
  reverseResolve(fingerprint) {
    const results = [];
    for (const record of this._records.values()) {
      if (record.fingerprint === fingerprint && !record.isExpired()) {
        results.push(record);
      }
    }
    return results;
  }

  // ── Transfer ───────────────────────────────────────────────────────

  /**
   * Transfer name ownership from one fingerprint to another.
   *
   * @param {string} name
   * @param {string} fromFingerprint
   * @param {string} toFingerprint
   * @returns {NameRecord}
   */
  transfer(name, fromFingerprint, toFingerprint) {
    const existing = this._records.get(name);
    if (!existing) {
      throw new Error(`Name "${name}" not found`);
    }
    if (existing.fingerprint !== fromFingerprint) {
      throw new Error(`Not the owner of "${name}"`);
    }

    const record = new NameRecord({
      name,
      fingerprint: toFingerprint,
      ttl: existing.ttl,
      relay: existing.relay,
      metadata: existing.metadata,
    });
    this._records.set(name, record);
    return record;
  }

  // ── Maintenance ────────────────────────────────────────────────────

  /**
   * Remove expired records.
   * @param {number} [now]
   * @returns {number} Number of records pruned
   */
  prune(now = Date.now()) {
    let count = 0;
    for (const [name, record] of this._records) {
      if (record.isExpired(now)) {
        this._records.delete(name);
        count++;
      }
    }
    return count;
  }

  // ── Query ──────────────────────────────────────────────────────────

  /**
   * Search for names matching a query string (substring match on name or metadata).
   *
   * @param {string} query
   * @returns {NameRecord[]}
   */
  search(query) {
    const q = query.toLowerCase();
    const results = [];
    for (const record of this._records.values()) {
      if (record.isExpired()) continue;
      if (record.name.includes(q)) {
        results.push(record);
        continue;
      }
      if (record.metadata) {
        const metaStr = JSON.stringify(record.metadata).toLowerCase();
        if (metaStr.includes(q)) {
          results.push(record);
        }
      }
    }
    return results;
  }

  /**
   * List all non-expired records.
   * @returns {NameRecord[]}
   */
  list() {
    const results = [];
    for (const record of this._records.values()) {
      if (!record.isExpired()) results.push(record);
    }
    return results;
  }

  // ── Serialization ──────────────────────────────────────────────────

  toJSON() {
    return {
      records: [...this._records.values()].map(r => r.toJSON()),
    };
  }

  static fromJSON(data) {
    const resolver = new MeshNameResolver();
    if (data.records) {
      for (const rd of data.records) {
        const record = NameRecord.fromJSON(rd);
        resolver._records.set(record.name, record);
      }
    }
    return resolver;
  }

  // ── Internal ───────────────────────────────────────────────────────

  _validateName(name) {
    if (typeof name !== 'string') {
      throw new Error('Name must be a string');
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new Error(`Name exceeds maximum length of ${MAX_NAME_LENGTH}`);
    }
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`Invalid name format: "${name}"`);
    }
  }
}
