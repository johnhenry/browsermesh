/**
 * clawser-mesh-quotas.js -- Per-identity resource quotas with enforcement.
 *
 * Provides QuotaRule definitions, usage tracking (UsageRecord), a
 * QuotaManager for CRUD on per-pod quota rules, and a QuotaEnforcer
 * for recording usage, checking limits, and tracking violations.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-quotas.test.mjs
 */

import { MESH_TYPE } from '@johnhenry/browsermesh-primitives';
import { silentCatch } from './silent-catch.mjs'

// ---------------------------------------------------------------------------
// Wire constants — imported from canonical registry
// ---------------------------------------------------------------------------

/** Wire code sent when a quota rule is created or updated. */
export const QUOTA_UPDATE = MESH_TYPE.QUOTA_UPDATE;

/** Wire code sent when a quota violation is detected. */
export const QUOTA_VIOLATION = MESH_TYPE.QUOTA_VIOLATION;

/** Wire code for periodic usage reports. */
export const USAGE_REPORT = MESH_TYPE.USAGE_REPORT;

// ---------------------------------------------------------------------------
// Default limits
// ---------------------------------------------------------------------------

/**
 * Sensible default resource limits applied when no explicit quota exists.
 */
export const DEFAULT_LIMITS = Object.freeze({
  cpuMs: 60_000,
  memoryMb: 512,
  storageMb: 100,
  bandwidthMb: 1000,
  jobsPerHour: 100,
  maxConcurrentJobs: 5,
});

// ---------------------------------------------------------------------------
// QuotaRule
// ---------------------------------------------------------------------------

/**
 * A quota rule describes the resource limits for a specific pod (identity).
 */
export class QuotaRule {
  /**
   * @param {object} opts
   * @param {string} opts.podId            - Identity fingerprint
   * @param {object} opts.limits           - Resource limits (partial, merged with defaults)
   * @param {number} [opts.limits.cpuMs]
   * @param {number} [opts.limits.memoryMb]
   * @param {number} [opts.limits.storageMb]
   * @param {number} [opts.limits.bandwidthMb]
   * @param {number} [opts.limits.jobsPerHour]
   * @param {number} [opts.limits.maxConcurrentJobs]
   * @param {'block'|'throttle'|'charge'} [opts.overagePolicy='block']
   * @param {number} [opts.createdAt]
   * @param {number|null} [opts.expiresAt]
   */
  constructor({ podId, limits, overagePolicy = 'block', createdAt, expiresAt = null }) {
    if (!podId || typeof podId !== 'string') {
      throw new Error('podId is required and must be a non-empty string');
    }
    this.podId = podId;
    this.limits = { ...limits };
    this.overagePolicy = overagePolicy;
    this.createdAt = createdAt ?? Date.now();
    this.expiresAt = expiresAt;
  }

  /**
   * Check if this rule has expired.
   * @param {number} [now]
   * @returns {boolean}
   */
  isExpired(now = Date.now()) {
    if (this.expiresAt == null) return false;
    return now >= this.expiresAt;
  }

  /**
   * Serialize to a plain JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      podId: this.podId,
      limits: { ...this.limits },
      overagePolicy: this.overagePolicy,
      createdAt: this.createdAt,
      expiresAt: this.expiresAt,
    };
  }

  /**
   * Re-hydrate from a plain object.
   * @param {object} data
   * @returns {QuotaRule}
   */
  static fromJSON(data) {
    return new QuotaRule({
      podId: data.podId,
      limits: data.limits,
      overagePolicy: data.overagePolicy,
      createdAt: data.createdAt,
      expiresAt: data.expiresAt,
    });
  }
}

// ---------------------------------------------------------------------------
// UsageRecord
// ---------------------------------------------------------------------------

/**
 * Tracks resource consumption for a single pod during a specific time period.
 * Periods are hourly by default (ISO 8601 truncated to the hour).
 */
export class UsageRecord {
  /**
   * @param {object} opts
   * @param {string} opts.podId
   * @param {string} opts.period   - Hourly period key, e.g. '2026-03-02T06'
   * @param {object} [opts.usage]
   * @param {number} [opts.usage.cpuMs]
   * @param {number} [opts.usage.memoryMb]
   * @param {number} [opts.usage.storageMb]
   * @param {number} [opts.usage.bandwidthMb]
   * @param {number} [opts.usage.jobCount]
   * @param {number} [opts.usage.concurrentJobs]
   * @param {number} [opts.updatedAt]
   */
  constructor({ podId, period, usage, updatedAt }) {
    this.podId = podId;
    this.period = period;
    this.usage = {
      cpuMs: 0,
      memoryMb: 0,
      storageMb: 0,
      bandwidthMb: 0,
      jobCount: 0,
      concurrentJobs: 0,
      ...(usage || {}),
    };
    this.updatedAt = updatedAt ?? Date.now();
  }

  /**
   * Generate the current hourly period key.
   * @param {Date} [date]
   * @returns {string} e.g. '2026-03-02T06'
   */
  static currentPeriod(date = new Date()) {
    const iso = date.toISOString();         // '2026-03-02T06:45:12.345Z'
    return iso.slice(0, 13);                // '2026-03-02T06'
  }

  /**
   * Serialize to a plain JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      podId: this.podId,
      period: this.period,
      usage: { ...this.usage },
      updatedAt: this.updatedAt,
    };
  }

  /**
   * Re-hydrate from a plain object.
   * @param {object} data
   * @returns {UsageRecord}
   */
  static fromJSON(data) {
    return new UsageRecord({
      podId: data.podId,
      period: data.period,
      usage: data.usage,
      updatedAt: data.updatedAt,
    });
  }
}

// ---------------------------------------------------------------------------
// Resource-to-usage field mapping
// ---------------------------------------------------------------------------

/** @type {Record<string, string>} */
const RESOURCE_FIELD_MAP = Object.freeze({
  cpuMs: 'cpuMs',
  memoryMb: 'memoryMb',
  storageMb: 'storageMb',
  bandwidthMb: 'bandwidthMb',
  jobsPerHour: 'jobCount',
  maxConcurrentJobs: 'concurrentJobs',
});

/** @type {Record<string, string>} inverse: usage field -> limit field */
const USAGE_TO_LIMIT_MAP = Object.freeze({
  cpuMs: 'cpuMs',
  memoryMb: 'memoryMb',
  storageMb: 'storageMb',
  bandwidthMb: 'bandwidthMb',
  jobCount: 'jobsPerHour',
  concurrentJobs: 'maxConcurrentJobs',
});

// ---------------------------------------------------------------------------
// QuotaManager
// ---------------------------------------------------------------------------

/**
 * CRUD manager for per-pod quota rules.
 */
export class QuotaManager {
  /** @type {Map<string, QuotaRule>} podId -> QuotaRule */
  #rules = new Map();

  /** @type {object} */
  #defaultLimits;

  /** @type {boolean} */
  #enforcementEnabled;

  /**
   * @param {object} [opts]
   * @param {object} [opts.defaultLimits]  - Override DEFAULT_LIMITS
   * @param {boolean} [opts.enforcementEnabled=true]
   */
  constructor(opts = {}) {
    this.#defaultLimits = opts.defaultLimits
      ? { ...DEFAULT_LIMITS, ...opts.defaultLimits }
      : { ...DEFAULT_LIMITS };
    this.#enforcementEnabled = opts.enforcementEnabled !== false;
  }

  /**
   * Get the default limits used for pods without explicit quotas.
   * @returns {object}
   */
  get defaultLimits() {
    return { ...this.#defaultLimits };
  }

  /**
   * Whether enforcement is enabled.
   * @returns {boolean}
   */
  get enforcementEnabled() {
    return this.#enforcementEnabled;
  }

  /**
   * Number of quota rules stored.
   * @returns {number}
   */
  get size() {
    return this.#rules.size;
  }

  /**
   * Create or update a quota rule for a pod.
   *
   * @param {string} podId
   * @param {object} limits - Partial limits; missing keys default from defaultLimits
   * @param {'block'|'throttle'|'charge'} [overagePolicy='block']
   * @param {object} [opts]
   * @param {number|null} [opts.expiresAt]
   * @returns {QuotaRule}
   */
  setQuota(podId, limits, overagePolicy = 'block', opts = {}) {
    const merged = { ...this.#defaultLimits, ...limits };
    const rule = new QuotaRule({
      podId,
      limits: merged,
      overagePolicy,
      expiresAt: opts.expiresAt ?? null,
    });
    this.#rules.set(podId, rule);
    return rule;
  }

  /**
   * Get the quota rule for a pod.
   * @param {string} podId
   * @returns {QuotaRule|null}
   */
  getQuota(podId) {
    return this.#rules.get(podId) ?? null;
  }

  /**
   * Remove the quota rule for a pod.
   * @param {string} podId
   * @returns {boolean}
   */
  removeQuota(podId) {
    return this.#rules.delete(podId);
  }

  /**
   * List all quota rules.
   * @returns {QuotaRule[]}
   */
  listQuotas() {
    return [...this.#rules.values()];
  }

  /**
   * Resolve effective limits for a pod.
   * If the pod has an explicit (non-expired) rule, use it; otherwise fall back to defaults.
   *
   * @param {string} podId
   * @returns {{ limits: object, overagePolicy: string, source: 'explicit'|'default' }}
   */
  resolveEffective(podId) {
    const rule = this.#rules.get(podId);
    if (rule && !rule.isExpired()) {
      return { limits: { ...rule.limits }, overagePolicy: rule.overagePolicy, source: 'explicit' };
    }
    return { limits: { ...this.#defaultLimits }, overagePolicy: 'block', source: 'default' };
  }

  /**
   * Serialize to JSON.
   * @returns {object}
   */
  toJSON() {
    return {
      defaultLimits: { ...this.#defaultLimits },
      enforcementEnabled: this.#enforcementEnabled,
      rules: [...this.#rules.values()].map(r => r.toJSON()),
    };
  }

  /**
   * Re-hydrate from JSON.
   * @param {object} data
   * @returns {QuotaManager}
   */
  static fromJSON(data) {
    const mgr = new QuotaManager({
      defaultLimits: data.defaultLimits,
      enforcementEnabled: data.enforcementEnabled,
    });
    if (data.rules) {
      for (const rd of data.rules) {
        const rule = QuotaRule.fromJSON(rd);
        mgr.#rules.set(rule.podId, rule);
      }
    }
    return mgr;
  }
}

// ---------------------------------------------------------------------------
// QuotaEnforcer
// ---------------------------------------------------------------------------

/**
 * Tracks real-time resource consumption and enforces quota limits.
 *
 * Usage records are keyed by (podId, period). The enforcer compares
 * recorded usage against the effective limits from a QuotaManager.
 */
export class QuotaEnforcer {
  /** @type {QuotaManager} */
  #manager;

  /** @type {Map<string, UsageRecord>} compositeKey -> UsageRecord */
  #usage = new Map();

  /** @type {Array<{podId: string, resource: string, limit: number, actual: number, policy: string, timestamp: number}>} */
  #violations = [];

  /** @type {Function|null} */
  #onViolation;

  /**
   * @param {QuotaManager} quotaManager
   * @param {object} [opts]
   * @param {Function} [opts.onViolation] - Called with violation info on limit breach
   */
  constructor(quotaManager, opts = {}) {
    this.#manager = quotaManager;
    this.#onViolation = opts.onViolation || null;
  }

  // -- Usage key helpers ----------------------------------------------------

  /**
   * Build a composite key for the usage map.
   * @param {string} podId
   * @param {string} period
   * @returns {string}
   */
  static _key(podId, period) {
    return `${podId}::${period}`;
  }

  // -- Recording usage ------------------------------------------------------

  /**
   * Record resource consumption for a pod in the current period.
   *
   * @param {string} podId
   * @param {string} resource - One of: cpuMs, memoryMb, storageMb, bandwidthMb, jobsPerHour, maxConcurrentJobs
   * @param {number} amount   - Amount consumed (additive for most; set for concurrentJobs)
   */
  recordUsage(podId, resource, amount) {
    const period = UsageRecord.currentPeriod();
    const key = QuotaEnforcer._key(podId, period);

    let record = this.#usage.get(key);
    if (!record) {
      record = new UsageRecord({ podId, period });
      this.#usage.set(key, record);
    }

    const usageField = RESOURCE_FIELD_MAP[resource];
    if (!usageField) {
      throw new Error(`Unknown resource: ${resource}`);
    }

    // concurrentJobs is set (high-water mark), others are additive
    if (resource === 'maxConcurrentJobs') {
      record.usage[usageField] = Math.max(record.usage[usageField], amount);
    } else {
      record.usage[usageField] += amount;
    }
    record.updatedAt = Date.now();

    // Check for violation after recording
    const { limits, overagePolicy } = this.#manager.resolveEffective(podId);
    const limitValue = limits[resource];
    const actual = record.usage[usageField];

    if (limitValue != null && actual > limitValue) {
      const violation = {
        podId,
        resource,
        limit: limitValue,
        actual,
        policy: overagePolicy,
        timestamp: Date.now(),
      };
      this.#violations.push(violation);
      if (this.#onViolation) {
        try { this.#onViolation(violation); } catch (e) { silentCatch('clawser-mesh-quotas', 'swallow-listener-errors', e) }
      }
    }
  }

  // -- Querying usage -------------------------------------------------------

  /**
   * Get the usage record for a pod in a given period (defaults to current).
   *
   * @param {string} podId
   * @param {string} [period]
   * @returns {UsageRecord|null}
   */
  getUsage(podId, period) {
    const p = period ?? UsageRecord.currentPeriod();
    const key = QuotaEnforcer._key(podId, p);
    return this.#usage.get(key) ?? null;
  }

  // -- Quota checking -------------------------------------------------------

  /**
   * Check if a requested resource amount would exceed the pod's quota.
   *
   * @param {string} podId
   * @param {string} resource
   * @param {number} requestedAmount
   * @returns {{ allowed: boolean, remaining?: number, overage?: number, policy?: string }}
   */
  checkQuota(podId, resource, requestedAmount) {
    if (!this.#manager.enforcementEnabled) {
      return { allowed: true };
    }

    const { limits, overagePolicy } = this.#manager.resolveEffective(podId);
    const limitValue = limits[resource];

    // No limit defined for this resource
    if (limitValue == null) {
      return { allowed: true };
    }

    const usageField = RESOURCE_FIELD_MAP[resource];
    if (!usageField) {
      return { allowed: true };
    }

    const period = UsageRecord.currentPeriod();
    const key = QuotaEnforcer._key(podId, period);
    const record = this.#usage.get(key);
    const currentUsage = record ? record.usage[usageField] : 0;

    const projectedUsage = currentUsage + requestedAmount;
    const remaining = Math.max(0, limitValue - currentUsage);

    if (projectedUsage <= limitValue) {
      return { allowed: true, remaining };
    }

    const overage = projectedUsage - limitValue;

    // Throttle policy allows usage but signals the overage
    if (overagePolicy === 'throttle' || overagePolicy === 'charge') {
      return { allowed: true, remaining: 0, overage, policy: overagePolicy };
    }

    // Block policy denies the request
    return { allowed: false, remaining, overage, policy: overagePolicy };
  }

  // -- Reset ----------------------------------------------------------------

  /**
   * Reset usage for a pod in a given period (defaults to current).
   *
   * @param {string} podId
   * @param {string} [period]
   */
  resetUsage(podId, period) {
    const p = period ?? UsageRecord.currentPeriod();
    const key = QuotaEnforcer._key(podId, p);
    this.#usage.delete(key);
  }

  // -- Violations -----------------------------------------------------------

  /**
   * List recorded violations, optionally filtered by podId.
   *
   * @param {string} [podId] - If omitted, returns all violations
   * @returns {Array<{podId: string, resource: string, limit: number, actual: number, policy: string, timestamp: number}>}
   */
  listViolations(podId) {
    if (podId) {
      return this.#violations.filter(v => v.podId === podId);
    }
    return [...this.#violations];
  }

  // -- Maintenance ----------------------------------------------------------

  /**
   * Remove usage records older than maxAgeMs (defaults to 24 hours).
   *
   * @param {number} [maxAgeMs=86400000]
   * @returns {number} Number of pruned records
   */
  pruneOldUsage(maxAgeMs = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    let count = 0;
    for (const [key, record] of this.#usage) {
      if (record.updatedAt < cutoff) {
        this.#usage.delete(key);
        count++;
      }
    }
    return count;
  }

  /**
   * Get the total number of usage records currently stored.
   * @returns {number}
   */
  get usageCount() {
    return this.#usage.size;
  }

  // -- Serialization --------------------------------------------------------

  /**
   * Serialize to JSON.
   * @returns {object}
   */
  toJSON() {
    return {
      usage: [...this.#usage.values()].map(r => r.toJSON()),
      violations: [...this.#violations],
    };
  }

  /**
   * Re-hydrate from JSON (requires an existing QuotaManager).
   * @param {object} data
   * @param {QuotaManager} quotaManager
   * @param {object} [opts]
   * @returns {QuotaEnforcer}
   */
  static fromJSON(data, quotaManager, opts = {}) {
    const enforcer = new QuotaEnforcer(quotaManager, opts);
    if (data.usage) {
      for (const ud of data.usage) {
        const record = UsageRecord.fromJSON(ud);
        const key = QuotaEnforcer._key(record.podId, record.period);
        enforcer.#usage.set(key, record);
      }
    }
    if (data.violations) {
      enforcer.#violations.push(...data.violations);
    }
    return enforcer;
  }
}
