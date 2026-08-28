/**
 * ACL (Access Control List) module for mesh-primitives.
 *
 * Provides glob-style resource pattern matching, permission grants,
 * and an engine for managing access control across pods.
 *
 * Pure module — no I/O, no browser APIs, no crypto.
 */

// ─── Glob-style resource pattern matching ────────────────────────────

/**
 * Match a resource string against a glob-style pattern.
 *
 * Supported wildcards:
 * - `*`   matches any characters except `/` (single segment)
 * - `**`  matches any characters including `/` (recursive)
 * - `?`   matches any single character except `/`
 * - Exact strings match literally
 *
 * @param {string} pattern - Glob pattern (e.g. `"svc://model/*"`, `"fs:///docs/**"`)
 * @param {string} resource - Resource identifier to test
 * @returns {boolean} True if the resource matches the pattern
 */
export function matchResourcePattern(pattern, resource) {
  if (pattern === '*') return true;
  if (pattern === resource) return true;

  // Convert glob pattern to regex
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')   // escape regex specials (not * and ?)
    .replace(/\*\*/g, '{{GLOBSTAR}}')        // temp placeholder for **
    .replace(/\*/g, '[^/]*')                 // * matches any non-slash sequence
    .replace(/\?/g, '[^/]')                  // ? matches single non-slash char
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');     // ** matches everything incl. /

  return new RegExp(`^${regexStr}$`).test(resource);
}

// ─── Permission ──────────────────────────────────────────────────────

/**
 * A single permission entry: a resource pattern + allowed actions + optional quotas.
 *
 * @class
 */
export class Permission {
  /**
   * @param {object} opts
   * @param {string} opts.resource - Glob pattern for the resource
   * @param {string[]} opts.actions - Allowed actions (e.g. `["read","write"]`, `["*"]`, `["admin"]`)
   * @param {{ maxCalls?: number, maxBytes?: number, maxTokens?: number, maxConcurrent?: number }|null} [opts.quotas=null]
   */
  constructor({ resource, actions, quotas = null }) {
    /** @type {string} */
    this.resource = resource;
    /** @type {string[]} */
    this.actions = [...actions];
    /** @type {{ maxCalls?: number, maxBytes?: number, maxTokens?: number, maxConcurrent?: number }|null} */
    this.quotas = quotas ? { ...quotas } : null;
  }

  /**
   * Check if this permission covers the given resource + action pair.
   *
   * @param {string} resource - The concrete resource identifier
   * @param {string} action - The action being attempted
   * @returns {boolean}
   */
  matches(resource, action) {
    if (!matchResourcePattern(this.resource, resource)) return false;
    if (this.actions.includes('*') || this.actions.includes('admin')) return true;
    return this.actions.includes(action);
  }

  /**
   * Serialize to a plain JSON-compatible object.
   * @returns {object}
   */
  toJSON() {
    return {
      resource: this.resource,
      actions: [...this.actions],
      quotas: this.quotas ? { ...this.quotas } : null,
    };
  }

  /**
   * Reconstruct a Permission from a plain object.
   * @param {object} data
   * @returns {Permission}
   */
  static fromJSON(data) {
    return new Permission({
      resource: data.resource,
      actions: data.actions,
      quotas: data.quotas ?? null,
    });
  }
}

// ─── AccessGrant ─────────────────────────────────────────────────────

/**
 * Represents a grant of permissions from one pod (grantor) to another (grantee).
 *
 * @class
 */
export class AccessGrant {
  /**
   * @param {object} opts
   * @param {string} opts.id - Unique grant identifier
   * @param {string} opts.grantee - Recipient pod ID
   * @param {string} opts.grantor - Issuer pod ID
   * @param {Array<Permission|object>} opts.permissions - Permission entries
   * @param {{ expires?: number, maxUses?: number, timeWindows?: Array<{ start: string, end: string }> }} [opts.conditions={}]
   * @param {number} [opts.created=Date.now()]
   * @param {number} [opts.usageCount=0]
   */
  constructor({
    id,
    grantee,
    grantor,
    permissions,
    conditions = {},
    created = Date.now(),
    usageCount = 0,
  }) {
    /** @type {string} */
    this.id = id;
    /** @type {string} */
    this.grantee = grantee;
    /** @type {string} */
    this.grantor = grantor;
    /** @type {Permission[]} */
    this.permissions = permissions.map(
      p => (p instanceof Permission ? p : new Permission(p))
    );
    /** @type {{ expires?: number, maxUses?: number, timeWindows?: Array<{ start: string, end: string }> }} */
    this.conditions = { ...conditions };
    /** @type {number} */
    this.created = created;
    /** @type {number|null} */
    this.revoked = null;
    /** @type {number} */
    this.usageCount = usageCount;
  }

  /**
   * Check whether this grant has expired.
   *
   * A grant is expired if:
   * - It has been revoked
   * - The `expires` timestamp has passed
   * - The `maxUses` limit has been reached
   *
   * @param {number} [now=Date.now()] - Current time in milliseconds
   * @returns {boolean}
   */
  isExpired(now = Date.now()) {
    if (this.revoked) return true;
    if (this.conditions.expires && now >= this.conditions.expires) return true;
    if (this.conditions.maxUses && this.usageCount >= this.conditions.maxUses) return true;
    return false;
  }

  /**
   * Check whether the current time falls within any allowed time window.
   *
   * Time windows use `"HH:MM"` format for start/end.
   * If no time windows are configured, returns true (always allowed).
   *
   * @param {Date} [now=new Date()] - Current date/time
   * @returns {boolean}
   */
  isWithinTimeWindow(now = new Date()) {
    if (!this.conditions.timeWindows || this.conditions.timeWindows.length === 0) {
      return true;
    }
    const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return this.conditions.timeWindows.some(w => timeStr >= w.start && timeStr <= w.end);
  }

  /**
   * Check if this grant allows a specific resource + action.
   *
   * @param {string} resource - Resource identifier
   * @param {string} action - Action being attempted
   * @param {number} [now=Date.now()] - Current time in milliseconds
   * @returns {{ allowed: boolean, grant?: AccessGrant, reason?: string }}
   */
  check(resource, action, now = Date.now()) {
    if (this.isExpired(now)) {
      return { allowed: false, reason: 'grant_expired' };
    }
    if (!this.isWithinTimeWindow(new Date(now))) {
      return { allowed: false, reason: 'outside_time_window' };
    }
    for (const perm of this.permissions) {
      if (perm.matches(resource, action)) {
        return { allowed: true, grant: this };
      }
    }
    return { allowed: false, reason: 'no_matching_permission' };
  }

  /**
   * Increment the usage counter by one.
   */
  consumeUse() {
    this.usageCount++;
  }

  /**
   * Mark this grant as revoked.
   *
   * @param {number} [timestamp=Date.now()] - Revocation timestamp
   */
  revoke(timestamp = Date.now()) {
    this.revoked = timestamp;
  }

  /**
   * Serialize to a plain JSON-compatible object.
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      grantee: this.grantee,
      grantor: this.grantor,
      permissions: this.permissions.map(p => p.toJSON()),
      conditions: { ...this.conditions },
      created: this.created,
      revoked: this.revoked,
      usageCount: this.usageCount,
    };
  }

  /**
   * Reconstruct an AccessGrant from a plain object.
   *
   * @param {object} data
   * @returns {AccessGrant}
   */
  static fromJSON(data) {
    const grant = new AccessGrant({
      id: data.id,
      grantee: data.grantee,
      grantor: data.grantor,
      permissions: data.permissions.map(p => Permission.fromJSON(p)),
      conditions: data.conditions ?? {},
      created: data.created,
      usageCount: data.usageCount ?? 0,
    });
    grant.revoked = data.revoked ?? null;
    return grant;
  }
}

// ─── ACLEngine ───────────────────────────────────────────────────────

/**
 * Manages multiple access grants and evaluates access control decisions.
 *
 * @class
 */
export class ACLEngine {
  /** @type {Map<string, AccessGrant>} */
  #grants;

  constructor() {
    this.#grants = new Map();
  }

  /**
   * Add or replace a grant.
   *
   * @param {AccessGrant} grant
   */
  addGrant(grant) {
    this.#grants.set(grant.id, grant);
  }

  /**
   * Remove a grant by ID.
   *
   * @param {string} grantId
   * @returns {boolean} True if the grant existed and was removed
   */
  removeGrant(grantId) {
    return this.#grants.delete(grantId);
  }

  /**
   * Mark a grant as revoked (keeps it in the map but expired).
   *
   * @param {string} grantId
   * @param {number} [timestamp=Date.now()]
   * @returns {boolean} True if the grant existed
   */
  revokeGrant(grantId, timestamp = Date.now()) {
    const grant = this.#grants.get(grantId);
    if (!grant) return false;
    grant.revoke(timestamp);
    return true;
  }

  /**
   * Revoke all grants for a specific grantee.
   *
   * @param {string} grantee - Pod ID of the grantee
   * @param {number} [timestamp=Date.now()]
   * @returns {number} Number of grants revoked
   */
  revokeAll(grantee, timestamp = Date.now()) {
    let count = 0;
    for (const grant of this.#grants.values()) {
      if (grant.grantee === grantee && !grant.revoked) {
        grant.revoke(timestamp);
        count++;
      }
    }
    return count;
  }

  /**
   * Check whether a grantee is allowed to perform an action on a resource.
   *
   * Iterates all grants for the grantee and returns on the first match.
   *
   * @param {string} grantee - Pod ID of the requester
   * @param {string} resource - Resource identifier
   * @param {string} action - Action being attempted
   * @param {number} [now=Date.now()] - Current time in milliseconds
   * @returns {{ allowed: boolean, grant?: AccessGrant, reason?: string }}
   */
  check(grantee, resource, action, now = Date.now()) {
    let lastReason = 'no_grants';
    for (const grant of this.#grants.values()) {
      if (grant.grantee !== grantee) continue;
      const result = grant.check(resource, action, now);
      if (result.allowed) {
        return result;
      }
      lastReason = result.reason;
    }
    return { allowed: false, reason: lastReason };
  }

  /**
   * List grants, optionally filtered by grantee.
   *
   * @param {string} [grantee] - If provided, only return grants for this grantee
   * @returns {AccessGrant[]}
   */
  listGrants(grantee) {
    const results = [];
    for (const grant of this.#grants.values()) {
      if (grantee === undefined || grant.grantee === grantee) {
        results.push(grant);
      }
    }
    return results;
  }

  /**
   * List unique grantee IDs with their grant counts.
   *
   * @returns {Array<{ grantee: string, count: number }>}
   */
  listGrantees() {
    const counts = new Map();
    for (const grant of this.#grants.values()) {
      counts.set(grant.grantee, (counts.get(grant.grantee) || 0) + 1);
    }
    return Array.from(counts.entries()).map(([grantee, count]) => ({ grantee, count }));
  }

  /**
   * Merge all permissions from all active (non-expired) grants for a grantee.
   *
   * Deduplicates by resource+actions key so identical permissions are not repeated.
   *
   * @param {string} grantee - Pod ID
   * @param {number} [now=Date.now()]
   * @returns {Permission[]}
   */
  getEffectivePermissions(grantee, now = Date.now()) {
    const seen = new Set();
    const result = [];
    for (const grant of this.#grants.values()) {
      if (grant.grantee !== grantee) continue;
      if (grant.isExpired(now)) continue;
      for (const perm of grant.permissions) {
        // Deduplicate by resource + sorted actions
        const key = `${perm.resource}|${[...perm.actions].sort().join(',')}`;
        if (!seen.has(key)) {
          seen.add(key);
          result.push(perm);
        }
      }
    }
    return result;
  }

  /**
   * Remove all expired grants from the engine.
   *
   * @param {number} [now=Date.now()]
   * @returns {number} Number of grants pruned
   */
  pruneExpired(now = Date.now()) {
    let count = 0;
    for (const [id, grant] of this.#grants) {
      if (grant.isExpired(now)) {
        this.#grants.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Serialize the engine state to a plain JSON-compatible object.
   * @returns {object}
   */
  toJSON() {
    return {
      grants: Array.from(this.#grants.values()).map(g => g.toJSON()),
    };
  }

  /**
   * Reconstruct an ACLEngine from a plain object.
   *
   * @param {object} data
   * @returns {ACLEngine}
   */
  static fromJSON(data) {
    const engine = new ACLEngine();
    for (const grantData of data.grants) {
      engine.addGrant(AccessGrant.fromJSON(grantData));
    }
    return engine;
  }

  /**
   * Total number of grants in the engine.
   * @returns {number}
   */
  get size() {
    return this.#grants.size;
  }
}

// ─── ID generator ────────────────────────────────────────────────────

/** @type {number} */
let _grantSeq = 0;

/**
 * Generate a unique grant ID.
 *
 * Format: `grant_<timestamp-base36>_<sequence-base36>`
 *
 * @returns {string}
 */
export function generateGrantId() {
  return `grant_${Date.now().toString(36)}_${(++_grantSeq).toString(36)}`;
}
