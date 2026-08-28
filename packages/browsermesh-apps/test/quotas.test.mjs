// Run with: node --import ./test/_setup-globals.mjs --test test/quotas.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  QuotaRule,
  UsageRecord,
  QuotaManager,
  QuotaEnforcer,
  DEFAULT_LIMITS,
  QUOTA_UPDATE,
  QUOTA_VIOLATION,
  USAGE_REPORT,
} from '../src/quotas.mjs';

// ---------------------------------------------------------------------------
// QuotaRule
// ---------------------------------------------------------------------------

describe('QuotaRule', () => {
  it('constructs with required fields', () => {
    const rule = new QuotaRule({ podId: 'pod1', limits: { cpuMs: 30000 } });
    assert.equal(rule.podId, 'pod1');
    assert.deepEqual(rule.limits, { cpuMs: 30000 });
    assert.equal(rule.overagePolicy, 'block');
    assert.equal(rule.expiresAt, null);
    assert.ok(typeof rule.createdAt === 'number');
  });

  it('throws on missing podId', () => {
    assert.throws(() => new QuotaRule({ podId: '', limits: {} }), Error);
  });

  it('accepts custom overagePolicy and expiresAt', () => {
    const rule = new QuotaRule({
      podId: 'pod2',
      limits: { memoryMb: 256 },
      overagePolicy: 'throttle',
      expiresAt: 9999999999999,
    });
    assert.equal(rule.overagePolicy, 'throttle');
    assert.equal(rule.expiresAt, 9999999999999);
  });

  it('isExpired returns false when no expiresAt', () => {
    const rule = new QuotaRule({ podId: 'p', limits: {} });
    assert.ok(!rule.isExpired());
  });

  it('isExpired returns true when expired', () => {
    const rule = new QuotaRule({ podId: 'p', limits: {}, expiresAt: 1 });
    assert.ok(rule.isExpired());
  });

  it('isExpired returns false when in the future', () => {
    const rule = new QuotaRule({ podId: 'p', limits: {}, expiresAt: Date.now() + 60000 });
    assert.ok(!rule.isExpired());
  });

  it('round-trips via JSON', () => {
    const rule = new QuotaRule({
      podId: 'pod1',
      limits: { cpuMs: 5000, storageMb: 50 },
      overagePolicy: 'charge',
      expiresAt: 9999999999999,
    });
    const rule2 = QuotaRule.fromJSON(rule.toJSON());
    assert.equal(rule2.podId, 'pod1');
    assert.deepEqual(rule2.limits, { cpuMs: 5000, storageMb: 50 });
    assert.equal(rule2.overagePolicy, 'charge');
    assert.equal(rule2.expiresAt, 9999999999999);
    assert.equal(rule2.createdAt, rule.createdAt);
  });
});

// ---------------------------------------------------------------------------
// UsageRecord
// ---------------------------------------------------------------------------

describe('UsageRecord', () => {
  it('constructs with defaults', () => {
    const rec = new UsageRecord({ podId: 'pod1', period: '2026-03-02T06' });
    assert.equal(rec.podId, 'pod1');
    assert.equal(rec.period, '2026-03-02T06');
    assert.equal(rec.usage.cpuMs, 0);
    assert.equal(rec.usage.memoryMb, 0);
    assert.equal(rec.usage.storageMb, 0);
    assert.equal(rec.usage.bandwidthMb, 0);
    assert.equal(rec.usage.jobCount, 0);
    assert.equal(rec.usage.concurrentJobs, 0);
  });

  it('accepts initial usage values', () => {
    const rec = new UsageRecord({
      podId: 'pod1',
      period: '2026-03-02T07',
      usage: { cpuMs: 100, jobCount: 3 },
    });
    assert.equal(rec.usage.cpuMs, 100);
    assert.equal(rec.usage.jobCount, 3);
    assert.equal(rec.usage.memoryMb, 0);
  });

  it('currentPeriod returns hourly key', () => {
    const period = UsageRecord.currentPeriod(new Date('2026-03-02T06:45:12.345Z'));
    assert.equal(period, '2026-03-02T06');
  });

  it('currentPeriod defaults to now', () => {
    const period = UsageRecord.currentPeriod();
    // Should match ISO format truncated to hour
    assert.match(period, /^\d{4}-\d{2}-\d{2}T\d{2}$/);
  });

  it('round-trips via JSON', () => {
    const rec = new UsageRecord({
      podId: 'pod1',
      period: '2026-03-02T06',
      usage: { cpuMs: 500, bandwidthMb: 42 },
    });
    const rec2 = UsageRecord.fromJSON(rec.toJSON());
    assert.equal(rec2.podId, 'pod1');
    assert.equal(rec2.period, '2026-03-02T06');
    assert.equal(rec2.usage.cpuMs, 500);
    assert.equal(rec2.usage.bandwidthMb, 42);
    assert.equal(rec2.updatedAt, rec.updatedAt);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_LIMITS
// ---------------------------------------------------------------------------

describe('DEFAULT_LIMITS', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(DEFAULT_LIMITS));
  });

  it('has expected keys and values', () => {
    assert.equal(DEFAULT_LIMITS.cpuMs, 60_000);
    assert.equal(DEFAULT_LIMITS.memoryMb, 512);
    assert.equal(DEFAULT_LIMITS.storageMb, 100);
    assert.equal(DEFAULT_LIMITS.bandwidthMb, 1000);
    assert.equal(DEFAULT_LIMITS.jobsPerHour, 100);
    assert.equal(DEFAULT_LIMITS.maxConcurrentJobs, 5);
  });
});

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('QUOTA_UPDATE is 0xCD', () => {
    assert.equal(QUOTA_UPDATE, 0xCD);
  });

  it('QUOTA_VIOLATION is 0xCE', () => {
    assert.equal(QUOTA_VIOLATION, 0xCE);
  });

  it('USAGE_REPORT is 0xCF', () => {
    assert.equal(USAGE_REPORT, 0xCF);
  });

  it('wire constants are distinct', () => {
    const vals = [QUOTA_UPDATE, QUOTA_VIOLATION, USAGE_REPORT];
    assert.equal(new Set(vals).size, vals.length);
  });
});

// ---------------------------------------------------------------------------
// QuotaManager
// ---------------------------------------------------------------------------

describe('QuotaManager', () => {
  let mgr;
  beforeEach(() => {
    mgr = new QuotaManager();
  });

  it('starts empty', () => {
    assert.equal(mgr.size, 0);
    assert.deepEqual(mgr.listQuotas(), []);
  });

  it('enforcementEnabled defaults to true', () => {
    assert.equal(mgr.enforcementEnabled, true);
  });

  it('enforcementEnabled can be disabled', () => {
    const m = new QuotaManager({ enforcementEnabled: false });
    assert.equal(m.enforcementEnabled, false);
  });

  it('defaultLimits returns DEFAULT_LIMITS by default', () => {
    const dl = mgr.defaultLimits;
    assert.deepEqual(dl, { ...DEFAULT_LIMITS });
  });

  it('defaultLimits can be overridden', () => {
    const m = new QuotaManager({ defaultLimits: { cpuMs: 120_000 } });
    assert.equal(m.defaultLimits.cpuMs, 120_000);
    // Others still have defaults
    assert.equal(m.defaultLimits.memoryMb, 512);
  });

  it('setQuota creates a rule', () => {
    const rule = mgr.setQuota('pod1', { cpuMs: 30000 });
    assert.equal(rule.podId, 'pod1');
    assert.equal(rule.limits.cpuMs, 30000);
    // Other limits filled from defaults
    assert.equal(rule.limits.memoryMb, 512);
    assert.equal(mgr.size, 1);
  });

  it('setQuota overwrites existing rule', () => {
    mgr.setQuota('pod1', { cpuMs: 10000 });
    mgr.setQuota('pod1', { cpuMs: 20000 });
    assert.equal(mgr.size, 1);
    assert.equal(mgr.getQuota('pod1').limits.cpuMs, 20000);
  });

  it('setQuota accepts overagePolicy', () => {
    const rule = mgr.setQuota('pod1', {}, 'throttle');
    assert.equal(rule.overagePolicy, 'throttle');
  });

  it('setQuota accepts expiresAt', () => {
    const rule = mgr.setQuota('pod1', {}, 'block', { expiresAt: 9999999999999 });
    assert.equal(rule.expiresAt, 9999999999999);
  });

  it('getQuota returns null for missing', () => {
    assert.equal(mgr.getQuota('nobody'), null);
  });

  it('getQuota returns existing rule', () => {
    mgr.setQuota('pod1', { cpuMs: 5000 });
    const rule = mgr.getQuota('pod1');
    assert.ok(rule);
    assert.equal(rule.podId, 'pod1');
  });

  it('removeQuota removes a rule', () => {
    mgr.setQuota('pod1', {});
    assert.ok(mgr.removeQuota('pod1'));
    assert.equal(mgr.getQuota('pod1'), null);
    assert.equal(mgr.size, 0);
  });

  it('removeQuota returns false for missing', () => {
    assert.ok(!mgr.removeQuota('nobody'));
  });

  it('listQuotas returns all rules', () => {
    mgr.setQuota('pod1', {});
    mgr.setQuota('pod2', {});
    const list = mgr.listQuotas();
    assert.equal(list.length, 2);
    const ids = list.map(r => r.podId);
    assert.ok(ids.includes('pod1'));
    assert.ok(ids.includes('pod2'));
  });

  it('resolveEffective returns explicit rule when present', () => {
    mgr.setQuota('pod1', { cpuMs: 9999 }, 'charge');
    const eff = mgr.resolveEffective('pod1');
    assert.equal(eff.source, 'explicit');
    assert.equal(eff.limits.cpuMs, 9999);
    assert.equal(eff.overagePolicy, 'charge');
  });

  it('resolveEffective falls back to defaults', () => {
    const eff = mgr.resolveEffective('unknown');
    assert.equal(eff.source, 'default');
    assert.equal(eff.limits.cpuMs, DEFAULT_LIMITS.cpuMs);
    assert.equal(eff.overagePolicy, 'block');
  });

  it('resolveEffective ignores expired rule', () => {
    mgr.setQuota('pod1', { cpuMs: 1 }, 'charge', { expiresAt: 1 });
    const eff = mgr.resolveEffective('pod1');
    assert.equal(eff.source, 'default');
  });

  it('round-trips via JSON', () => {
    mgr.setQuota('pod1', { cpuMs: 7777 }, 'throttle');
    mgr.setQuota('pod2', { storageMb: 50 });
    const mgr2 = QuotaManager.fromJSON(mgr.toJSON());
    assert.equal(mgr2.size, 2);
    assert.equal(mgr2.getQuota('pod1').limits.cpuMs, 7777);
    assert.equal(mgr2.getQuota('pod2').limits.storageMb, 50);
    assert.equal(mgr2.enforcementEnabled, true);
  });
});

// ---------------------------------------------------------------------------
// QuotaEnforcer
// ---------------------------------------------------------------------------

describe('QuotaEnforcer', () => {
  let mgr;
  let enforcer;

  beforeEach(() => {
    mgr = new QuotaManager();
    enforcer = new QuotaEnforcer(mgr);
  });

  // -- recordUsage ----------------------------------------------------------

  describe('recordUsage', () => {
    it('creates a usage record on first call', () => {
      enforcer.recordUsage('pod1', 'cpuMs', 100);
      const rec = enforcer.getUsage('pod1');
      assert.ok(rec);
      assert.equal(rec.usage.cpuMs, 100);
    });

    it('accumulates additive resources', () => {
      enforcer.recordUsage('pod1', 'cpuMs', 100);
      enforcer.recordUsage('pod1', 'cpuMs', 200);
      const rec = enforcer.getUsage('pod1');
      assert.equal(rec.usage.cpuMs, 300);
    });

    it('uses high-water mark for concurrentJobs', () => {
      enforcer.recordUsage('pod1', 'maxConcurrentJobs', 3);
      enforcer.recordUsage('pod1', 'maxConcurrentJobs', 2);
      enforcer.recordUsage('pod1', 'maxConcurrentJobs', 5);
      const rec = enforcer.getUsage('pod1');
      assert.equal(rec.usage.concurrentJobs, 5);
    });

    it('throws for unknown resource', () => {
      assert.throws(() => enforcer.recordUsage('pod1', 'unknown', 1), /Unknown resource/);
    });

    it('tracks separate pods independently', () => {
      enforcer.recordUsage('pod1', 'cpuMs', 100);
      enforcer.recordUsage('pod2', 'cpuMs', 200);
      assert.equal(enforcer.getUsage('pod1').usage.cpuMs, 100);
      assert.equal(enforcer.getUsage('pod2').usage.cpuMs, 200);
    });
  });

  // -- checkQuota -----------------------------------------------------------

  describe('checkQuota', () => {
    it('allows when within limits', () => {
      mgr.setQuota('pod1', { cpuMs: 1000 });
      enforcer.recordUsage('pod1', 'cpuMs', 500);
      const result = enforcer.checkQuota('pod1', 'cpuMs', 200);
      assert.ok(result.allowed);
      assert.equal(result.remaining, 500);
    });

    it('allows when exactly at limit', () => {
      mgr.setQuota('pod1', { cpuMs: 1000 });
      enforcer.recordUsage('pod1', 'cpuMs', 500);
      const result = enforcer.checkQuota('pod1', 'cpuMs', 500);
      assert.ok(result.allowed);
    });

    it('blocks when exceeding limit with block policy', () => {
      mgr.setQuota('pod1', { cpuMs: 1000 }, 'block');
      enforcer.recordUsage('pod1', 'cpuMs', 900);
      const result = enforcer.checkQuota('pod1', 'cpuMs', 200);
      assert.ok(!result.allowed);
      assert.equal(result.policy, 'block');
      assert.equal(result.overage, 100);
      assert.equal(result.remaining, 100);
    });

    it('allows but signals overage with throttle policy', () => {
      mgr.setQuota('pod1', { cpuMs: 1000 }, 'throttle');
      enforcer.recordUsage('pod1', 'cpuMs', 900);
      const result = enforcer.checkQuota('pod1', 'cpuMs', 200);
      assert.ok(result.allowed);
      assert.equal(result.policy, 'throttle');
      assert.equal(result.overage, 100);
      assert.equal(result.remaining, 0);
    });

    it('allows but signals overage with charge policy', () => {
      mgr.setQuota('pod1', { cpuMs: 1000 }, 'charge');
      enforcer.recordUsage('pod1', 'cpuMs', 900);
      const result = enforcer.checkQuota('pod1', 'cpuMs', 200);
      assert.ok(result.allowed);
      assert.equal(result.policy, 'charge');
      assert.equal(result.overage, 100);
    });

    it('allows everything when enforcement is disabled', () => {
      const m = new QuotaManager({ enforcementEnabled: false });
      m.setQuota('pod1', { cpuMs: 10 }, 'block');
      const e = new QuotaEnforcer(m);
      e.recordUsage('pod1', 'cpuMs', 999);
      const result = e.checkQuota('pod1', 'cpuMs', 999);
      assert.ok(result.allowed);
    });

    it('uses default limits for pod without explicit rule', () => {
      // No explicit quota for pod1 -- defaults apply
      enforcer.recordUsage('pod1', 'cpuMs', DEFAULT_LIMITS.cpuMs - 10);
      const result = enforcer.checkQuota('pod1', 'cpuMs', 20);
      assert.ok(!result.allowed);
      assert.equal(result.policy, 'block');
    });

    it('allows when no limit defined for resource', () => {
      // setQuota only sets cpuMs explicitly, rest from defaults
      mgr.setQuota('pod1', {});
      const result = enforcer.checkQuota('pod1', 'cpuMs', 1);
      assert.ok(result.allowed);
    });

    it('returns allowed for unknown resource field', () => {
      const result = enforcer.checkQuota('pod1', 'unknownResource', 999);
      assert.ok(result.allowed);
    });
  });

  // -- Violations -----------------------------------------------------------

  describe('violations', () => {
    it('records violation when usage exceeds limit', () => {
      mgr.setQuota('pod1', { cpuMs: 100 }, 'block');
      enforcer.recordUsage('pod1', 'cpuMs', 150);
      const violations = enforcer.listViolations('pod1');
      assert.equal(violations.length, 1);
      assert.equal(violations[0].resource, 'cpuMs');
      assert.equal(violations[0].limit, 100);
      assert.equal(violations[0].actual, 150);
      assert.equal(violations[0].policy, 'block');
    });

    it('fires onViolation callback', () => {
      let captured = null;
      const e = new QuotaEnforcer(mgr, { onViolation: (v) => { captured = v; } });
      mgr.setQuota('pod1', { cpuMs: 50 });
      e.recordUsage('pod1', 'cpuMs', 100);
      assert.ok(captured);
      assert.equal(captured.podId, 'pod1');
      assert.equal(captured.resource, 'cpuMs');
    });

    it('swallows onViolation callback errors', () => {
      const e = new QuotaEnforcer(mgr, { onViolation: () => { throw new Error('boom'); } });
      mgr.setQuota('pod1', { cpuMs: 10 });
      // Should not throw
      e.recordUsage('pod1', 'cpuMs', 100);
      assert.equal(e.listViolations().length, 1);
    });

    it('listViolations returns all when no podId filter', () => {
      mgr.setQuota('pod1', { cpuMs: 10 });
      mgr.setQuota('pod2', { cpuMs: 10 });
      enforcer.recordUsage('pod1', 'cpuMs', 20);
      enforcer.recordUsage('pod2', 'cpuMs', 30);
      assert.equal(enforcer.listViolations().length, 2);
    });

    it('listViolations filters by podId', () => {
      mgr.setQuota('pod1', { cpuMs: 10 });
      mgr.setQuota('pod2', { cpuMs: 10 });
      enforcer.recordUsage('pod1', 'cpuMs', 20);
      enforcer.recordUsage('pod2', 'cpuMs', 30);
      assert.equal(enforcer.listViolations('pod1').length, 1);
      assert.equal(enforcer.listViolations('pod1')[0].podId, 'pod1');
    });

    it('no violation when within limits', () => {
      mgr.setQuota('pod1', { cpuMs: 1000 });
      enforcer.recordUsage('pod1', 'cpuMs', 500);
      assert.equal(enforcer.listViolations().length, 0);
    });
  });

  // -- resetUsage -----------------------------------------------------------

  describe('resetUsage', () => {
    it('clears usage for pod in current period', () => {
      enforcer.recordUsage('pod1', 'cpuMs', 100);
      assert.ok(enforcer.getUsage('pod1'));
      enforcer.resetUsage('pod1');
      assert.equal(enforcer.getUsage('pod1'), null);
    });

    it('clears usage for specific period', () => {
      enforcer.recordUsage('pod1', 'cpuMs', 100);
      const period = UsageRecord.currentPeriod();
      enforcer.resetUsage('pod1', period);
      assert.equal(enforcer.getUsage('pod1', period), null);
    });

    it('does not affect other pods', () => {
      enforcer.recordUsage('pod1', 'cpuMs', 100);
      enforcer.recordUsage('pod2', 'cpuMs', 200);
      enforcer.resetUsage('pod1');
      assert.equal(enforcer.getUsage('pod1'), null);
      assert.ok(enforcer.getUsage('pod2'));
    });
  });

  // -- pruneOldUsage --------------------------------------------------------

  describe('pruneOldUsage', () => {
    it('removes old records beyond maxAge', () => {
      enforcer.recordUsage('pod1', 'cpuMs', 100);
      // Use -1 so cutoff = Date.now() + 1, which is strictly after updatedAt
      const pruned = enforcer.pruneOldUsage(-1);
      assert.equal(pruned, 1);
      assert.equal(enforcer.usageCount, 0);
    });

    it('keeps recent records', () => {
      enforcer.recordUsage('pod1', 'cpuMs', 100);
      const pruned = enforcer.pruneOldUsage(60_000);
      assert.equal(pruned, 0);
      assert.equal(enforcer.usageCount, 1);
    });

    it('defaults to 24 hours', () => {
      enforcer.recordUsage('pod1', 'cpuMs', 100);
      // Recent record should not be pruned with default 24h
      const pruned = enforcer.pruneOldUsage();
      assert.equal(pruned, 0);
    });
  });

  // -- getUsage -------------------------------------------------------------

  describe('getUsage', () => {
    it('returns null for no usage', () => {
      assert.equal(enforcer.getUsage('pod1'), null);
    });

    it('returns record for current period', () => {
      enforcer.recordUsage('pod1', 'bandwidthMb', 50);
      const rec = enforcer.getUsage('pod1');
      assert.ok(rec);
      assert.equal(rec.usage.bandwidthMb, 50);
    });

    it('returns null for different period', () => {
      enforcer.recordUsage('pod1', 'cpuMs', 100);
      assert.equal(enforcer.getUsage('pod1', '2020-01-01T00'), null);
    });
  });

  // -- Serialization --------------------------------------------------------

  describe('serialization', () => {
    it('round-trips via JSON', () => {
      mgr.setQuota('pod1', { cpuMs: 100 });
      enforcer.recordUsage('pod1', 'cpuMs', 50);
      enforcer.recordUsage('pod1', 'cpuMs', 80);

      const data = enforcer.toJSON();
      const enforcer2 = QuotaEnforcer.fromJSON(data, mgr);

      const rec = enforcer2.getUsage('pod1');
      assert.ok(rec);
      assert.equal(rec.usage.cpuMs, 130);
      // Violations should be preserved
      assert.equal(enforcer2.listViolations().length, enforcer.listViolations().length);
    });
  });
});
