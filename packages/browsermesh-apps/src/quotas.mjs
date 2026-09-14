/**
 * quotas.mjs -- Per-identity resource quotas with enforcement.
 *
 * Provides QuotaRule definitions, usage tracking (UsageRecord), a
 * QuotaManager for CRUD on per-pod quota rules, and a QuotaEnforcer
 * for recording usage, checking limits, and tracking violations.
 *
 * ---------------------------------------------------------------------------
 * `QuotaEnforcer` predated this package's `MeshService` convention
 * (`mesh-service.mjs`) and, until now, stayed purely local: no
 * `sendTo`/`onIncomingData`/`attachService()` anywhere, used by nothing
 * else in this package. Its observability surface was a single
 * constructor-injected `opts.onViolation` callback (one listener only,
 * manually wrapped in `try/catch` + `silentCatch()` to swallow a throwing
 * listener). Modernized to use `mesh-service.mjs`'s `createEventBus()`
 * instead: `on(event, cb)`/`onEvent(cb)` support real multi-listener
 * fan-out and get the bus's own swallow-on-throw guarantee for free,
 * making the old manual `silentCatch()` call dead code (removed).
 * `opts.onViolation` is kept as constructor sugar -- it subscribes the
 * given function to the bus as listener #1, unchanged in payload shape --
 * since existing callers already construct enforcers this way and it's
 * genuinely additive, not a compatibility shim for anything removed.
 *
 * The `QUOTA_*`/`USAGE_REPORT` constants below are `browsermesh-primitives`
 * wire-registry codes, re-exported but never used as an `envelope.type` --
 * `MeshService`'s `ctx.onIncomingData()` filters on a plain string, which
 * this numeric registry is structurally incompatible with.
 * `createQuotaReportingService()` mints its own string envelope type
 * (`'quota-reporting'`) instead of repurposing them, matching
 * `mesh-swarm.mjs`'s identical precedent for the same situation. They stay
 * exactly as they are: unused as routing.
 *
 * ---------------------------------------------------------------------------
 * `createQuotaReportingService()` establishes a host/authority model: any
 * peer running it accepts `USAGE_REPORT`s from other peers and enforces
 * quotas on their behalf, replying `QUOTA_VIOLATION` when a report trips
 * one. Built directly on `ctx.sendTo()`/`ctx.onIncomingData()`, NOT
 * wrapped around `mesh-rpc.mjs` -- unlike `marketplace.mjs`'s network
 * search (genuinely request/response-shaped), a usage report has no
 * synchronous reply worth awaiting (a violation reply is async-maybe-
 * never), so this is a push, matching `mesh-kv.mjs`'s broadcast shape,
 * not `mesh-rpc.mjs`'s request/response shape.
 *
 * **Security-relevant, non-negotiable**: the wire shape for a usage report
 * carries no `podId` field. The authority attributes usage to the
 * connection-authenticated `fromPubKey` unconditionally, never to a self-
 * declared identity in a payload -- without this, a peer could frame
 * another peer (drive its usage over quota) or evade its own quota
 * (attribute its usage to someone else). Same class of gap `mesh-kv.mjs`'s
 * `attribution-mismatch` check and `chunk-replication.mjs`'s write-access
 * gate already close elsewhere in this family; treated as baseline
 * hygiene here too, not optional ACL.
 *
 * **No ACL on who may act as, or report to, a quota authority.** A peer
 * decides who to trust as its authority (whose `QUOTA_VIOLATION`/
 * `QUOTA_UPDATE` it listens to) entirely by its own wiring choices outside
 * this service, mirroring `mesh-rpc.mjs`/`mesh-websocket.mjs`'s own
 * explicit "authorization is the handler's job, not the transport's"
 * stance. An authority accepts `USAGE_REPORT`s from any peer that can
 * reach it; unknown senders fall back to `QuotaManager`'s existing
 * `DEFAULT_LIMITS`, not to unlimited enforcement.
 *
 * **`quota-update` never self-applies to a receiving peer's own local
 * `QuotaManager`.** Delivered as a notification event only
 * (`quota:rule-update-received`); a caller that wants to actually trust a
 * given authority's pushed rule changes must opt in explicitly at the
 * call site (e.g. `meshQuotaEnforcer.on('quota:rule-update-received', rule
 * => { if (trusted(rule)) manager.setQuota(...) })`). This is the one
 * place a remote peer could otherwise silently mutate local enforcement
 * state, and it stays closed by design, not by a forgettable check.
 *
 * `MeshQuotaEnforcer` is the ergonomic wrapper -- the same two-layer split
 * `mesh-kv.mjs`/`marketplace.mjs`'s `MeshMarketplace` already established.
 * `QuotaEnforcer`/`QuotaManager` never gain a `PeerNode` reference; only
 * `MeshQuotaEnforcer` does.
 *
 * No browser-only imports at module level.
 */

import { MESH_TYPE } from '@johnhenry/browsermesh-primitives';
import { createEventBus, attachService } from './mesh-service.mjs';

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

  /** @type {import('./mesh-service.mjs').EventBus} */
  #events = createEventBus();

  /**
   * @param {QuotaManager} quotaManager
   * @param {object} [opts]
   * @param {Function} [opts.onViolation] - Sugar for `on('quota:violation-detected', onViolation)`; called with violation info on limit breach.
   */
  constructor(quotaManager, opts = {}) {
    this.#manager = quotaManager;
    if (typeof opts.onViolation === 'function') {
      this.#events.on('quota:violation-detected', opts.onViolation);
    }
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
      this.#events.emit('quota:violation-detected', violation);
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

  // -- Observability ----------------------------------------------------------

  /**
   * Subscribe to exactly one event name -- currently only
   * `'quota:violation-detected'` (data: `{podId, resource, limit, actual,
   * policy, timestamp}`, the same shape the old constructor-only
   * `onViolation` callback received).
   * @param {string} event
   * @param {(data: object, event: string) => void} cb
   * @returns {() => void} unsubscribe
   */
  on(event, cb) {
    return this.#events.on(event, cb);
  }

  /**
   * Subscribe to every `quota:*` event this enforcer emits, regardless of name.
   * @param {(event: string, data: object) => void} cb
   * @returns {() => void} unsubscribe
   */
  onEvent(cb) {
    return this.#events.onEvent(cb);
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

// ---------------------------------------------------------------------------
// Quota network reporting
// ---------------------------------------------------------------------------

/** Default `envelope.type` for a quota authority's mesh attach -- see module doc comment. */
export const DEFAULT_QUOTA_ENVELOPE_TYPE = 'quota-reporting';

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`) implementing the
 * host/authority side of cross-peer usage reporting -- see module doc
 * comment for the full wire-protocol/security writeup (attribution via
 * `fromPubKey`, no ACL on who may report, `quota-update` never self-
 * applying).
 *
 * @param {object} opts
 * @param {QuotaEnforcer} opts.enforcer
 * @param {string} [opts.envelopeType='quota-reporting']
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createQuotaReportingService({ enforcer, envelopeType = DEFAULT_QUOTA_ENVELOPE_TYPE, onLog } = {}) {
  if (!enforcer || typeof enforcer.recordUsage !== 'function') {
    throw new Error('createQuotaReportingService: opts.enforcer (a QuotaEnforcer instance) is required');
  }
  const log = onLog || (() => {});

  return {
    name: 'quota-reporting',

    attach(peerNode, ctx) {
      /** @param {string} fromPubKey @param {{resource: string, amount: number}} msg */
      async function handleUsageReport(fromPubKey, msg) {
        const { resource, amount } = msg;

        // recordUsage() emits 'quota:violation-detected' synchronously
        // (before returning) if -- and only if -- THIS call trips a
        // violation, so a temporary listener scoped tightly around the
        // call captures exactly that outcome, deterministically, with no
        // timestamp heuristics or races against concurrent reports.
        let triggeredViolation = null;
        const unsubscribeOnce = enforcer.on('quota:violation-detected', (v) => {
          triggeredViolation = v;
        });
        try {
          // Attribution: always the connection-authenticated sender, never
          // a self-declared identity in the payload -- see module doc
          // comment's "Security-relevant, non-negotiable" section.
          enforcer.recordUsage(fromPubKey, resource, amount);
        } finally {
          unsubscribeOnce();
        }

        ctx.emit('quota:usage-report-received', { from: fromPubKey, resource, amount });

        if (triggeredViolation) {
          try {
            await ctx.sendTo(fromPubKey, envelopeType, { kind: 'quota-violation', violation: triggeredViolation });
          } catch (err) {
            log('quota-reporting:violation-send-failed', { to: fromPubKey, error: err?.message || String(err) });
          }
        }
      }

      const unsubscribe = ctx.onIncomingData(envelopeType, (fromPubKey, msg) => {
        if (!msg || typeof msg.kind !== 'string') return;
        if (msg.kind === 'usage-report') {
          handleUsageReport(fromPubKey, msg).catch((err) => {
            log('quota-reporting:usage-report-handling-failed', { from: fromPubKey, error: err?.message || String(err) });
          });
        } else if (msg.kind === 'quota-violation') {
          ctx.emit('quota:violation-notified', { from: fromPubKey, violation: msg.violation });
        } else if (msg.kind === 'quota-update') {
          // Informational only -- never self-applies to this peer's own
          // QuotaManager. See module doc comment.
          ctx.emit('quota:rule-update-received', { from: fromPubKey, rule: msg.rule });
        }
      });

      /**
       * Report this peer's own usage to a remote quota authority.
       * Fire-and-forget: does not await a reply, since the only possible
       * reply (a `quota-violation`) is async-maybe-never, not a
       * synchronous ack -- see module doc comment.
       * @param {string} authorityPodId
       * @param {string} resource
       * @param {number} amount
       */
      async function reportUsage(authorityPodId, resource, amount) {
        await ctx.sendTo(authorityPodId, envelopeType, { kind: 'usage-report', resource, amount });
      }

      /**
       * Push a `QuotaRule` change to a specific peer as a notification --
       * the receiving side never self-applies it (see module doc comment).
       * @param {string} peerId
       * @param {QuotaRule} rule
       */
      async function pushQuotaUpdate(peerId, rule) {
        await ctx.sendTo(peerId, envelopeType, { kind: 'quota-update', rule: rule.toJSON ? rule.toJSON() : rule });
      }

      return {
        api: { reportUsage, pushQuotaUpdate },
        teardown() {
          unsubscribe();
        },
      };
    },
  };
}

/**
 * Ergonomic wrapper composing a `QuotaEnforcer` with
 * `createQuotaReportingService()` -- the same two-layer split `mesh-kv.mjs`/
 * `marketplace.mjs`'s `MeshMarketplace` already established:
 * `QuotaEnforcer`/`QuotaManager` never gain a `PeerNode` reference, only
 * `MeshQuotaEnforcer` does.
 */
export class MeshQuotaEnforcer {
  /** @type {QuotaManager} */
  #manager;
  /** @type {QuotaEnforcer} */
  #enforcer;
  /** @type {ReturnType<import('./mesh-service.mjs').attachService>} */
  #handle;
  /** @type {import('./mesh-service.mjs').EventBus} */
  #events = createEventBus();
  /** @type {() => void} */
  #unsubscribeEnforcerEvents;
  /** @type {() => void} */
  #unsubscribeServiceEvents;

  /**
   * @param {object} opts
   * @param {import('./peer-node.mjs').PeerNode} opts.node - duck-typed: needs `podId`.
   * @param {import('@johnhenry/browsermesh-netway').VirtualNetwork} [opts.network] - unused today, accepted for forward compatibility with `attachService()`'s own signature.
   * @param {QuotaManager} [opts.manager] - defaults to a fresh `new QuotaManager()`.
   * @param {QuotaEnforcer} [opts.enforcer] - defaults to a fresh `new QuotaEnforcer(manager)`.
   * @param {string} [opts.envelopeType]
   * @param {Function} [opts.onLog]
   */
  constructor({ node, network, manager, enforcer, envelopeType, onLog } = {}) {
    if (!node || typeof node.podId !== 'string') {
      throw new Error('MeshQuotaEnforcer: opts.node (a PeerNode-like object with a podId) is required');
    }
    this.#manager = manager ?? new QuotaManager();
    this.#enforcer = enforcer ?? new QuotaEnforcer(this.#manager);
    this.#handle = attachService(node, network, createQuotaReportingService({
      enforcer: this.#enforcer,
      envelopeType,
      onLog,
    }));
    // Two independent sources forward onto this class's own bus: the
    // enforcer's own local 'quota:violation-detected' (fired by
    // recordUsage() itself, whether called locally or via an inbound
    // usage-report), and the network service's own ctx.emit()'d events
    // ('quota:usage-report-received'/'quota:violation-notified'/
    // 'quota:rule-update-received') -- same forwarding convention
    // MeshMarketplace/MeshKv use, just two emitters instead of one since
    // this phase's own service has events the composed local class does not.
    this.#unsubscribeEnforcerEvents = this.#enforcer.onEvent((event, data) => this.#events.emit(event, data));
    this.#unsubscribeServiceEvents = this.#handle.onEvent((event, data) => this.#events.emit(event, data));
  }

  /** @returns {QuotaManager} */
  get manager() { return this.#manager; }

  /** @returns {QuotaEnforcer} */
  get enforcer() { return this.#enforcer; }

  // -- Local pass-throughs (delegate to the composed QuotaEnforcer) --------

  recordUsage(podId, resource, amount) { return this.#enforcer.recordUsage(podId, resource, amount); }
  checkQuota(podId, resource, requestedAmount) { return this.#enforcer.checkQuota(podId, resource, requestedAmount); }
  listViolations(podId) { return this.#enforcer.listViolations(podId); }

  /**
   * @param {string} authorityPodId
   * @param {string} resource
   * @param {number} amount
   */
  async reportUsage(authorityPodId, resource, amount) {
    return this.#handle.api.reportUsage(authorityPodId, resource, amount);
  }

  /**
   * Push a `QuotaRule` change to a specific peer as a notification -- the
   * receiving side never self-applies it. See module doc comment.
   * @param {string} peerId
   * @param {QuotaRule} rule
   */
  async pushQuotaUpdate(peerId, rule) {
    return this.#handle.api.pushQuotaUpdate(peerId, rule);
  }

  // -- Observability (forwards the enforcer's events, plus this phase's own) --

  on(event, cb) { return this.#events.on(event, cb); }
  onEvent(cb) { return this.#events.onEvent(cb); }

  /** Tears down the composed network service and stops event forwarding. */
  async close() {
    this.#unsubscribeEnforcerEvents();
    this.#unsubscribeServiceEvents();
    await this.#handle.teardown();
    this.#events.closeAll();
  }
}
