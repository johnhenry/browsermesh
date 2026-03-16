import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchResourcePattern,
  Permission,
  AccessGrant,
  ACLEngine,
  generateGrantId,
} from '../src/acl.mjs';

// ─── matchResourcePattern ────────────────────────────────────────────

describe('matchResourcePattern', () => {
  it('exact match', () => {
    assert.ok(matchResourcePattern('tool:fetch', 'tool:fetch'));
  });

  it('exact mismatch', () => {
    assert.ok(!matchResourcePattern('tool:fetch', 'tool:read'));
  });

  it('universal wildcard * matches everything', () => {
    assert.ok(matchResourcePattern('*', 'svc://model/llama3'));
    assert.ok(matchResourcePattern('*', 'tool:fetch'));
    assert.ok(matchResourcePattern('*', ''));
  });

  it('single-segment wildcard svc://model/* matches one level', () => {
    assert.ok(matchResourcePattern('svc://model/*', 'svc://model/llama3'));
    assert.ok(matchResourcePattern('svc://model/*', 'svc://model/gpt'));
  });

  it('single-segment wildcard does NOT match nested paths', () => {
    assert.ok(!matchResourcePattern('svc://model/*', 'svc://model/gpt/4o'));
  });

  it('double wildcard svc://model/** matches nested paths', () => {
    assert.ok(matchResourcePattern('svc://model/**', 'svc://model/llama3'));
    assert.ok(matchResourcePattern('svc://model/**', 'svc://model/gpt/4o'));
    assert.ok(matchResourcePattern('svc://model/**', 'svc://model/a/b/c'));
  });

  it('fs:///documents/** matches recursive paths', () => {
    assert.ok(matchResourcePattern('fs:///documents/**', 'fs:///documents/readme.txt'));
    assert.ok(matchResourcePattern('fs:///documents/**', 'fs:///documents/sub/dir/file.js'));
  });

  it('fs:///documents/** does not match outside documents', () => {
    assert.ok(!matchResourcePattern('fs:///documents/**', 'fs:///other/file.txt'));
  });

  it('tool:* matches any single-segment tool name', () => {
    assert.ok(matchResourcePattern('tool:*', 'tool:fetch'));
    assert.ok(matchResourcePattern('tool:*', 'tool:read'));
    assert.ok(matchResourcePattern('tool:*', 'tool:screenshot'));
  });

  it('tool:* does not match nested tool paths', () => {
    assert.ok(!matchResourcePattern('tool:*', 'tool:a/b'));
  });

  it('chat:room-* matches prefixed names', () => {
    assert.ok(matchResourcePattern('chat:room-*', 'chat:room-general'));
    assert.ok(matchResourcePattern('chat:room-*', 'chat:room-123'));
  });

  it('chat:room-* does not match non-prefixed', () => {
    assert.ok(!matchResourcePattern('chat:room-*', 'chat:lobby'));
  });

  it('? matches single character', () => {
    assert.ok(matchResourcePattern('svc://a?b', 'svc://axb'));
    assert.ok(!matchResourcePattern('svc://a?b', 'svc://axxb'));
  });

  it('? does not match slash', () => {
    assert.ok(!matchResourcePattern('svc://a?b', 'svc://a/b'));
  });

  it('escapes regex special chars in pattern', () => {
    // Dots, brackets, etc. should be literal
    assert.ok(matchResourcePattern('svc://api.v1[beta]', 'svc://api.v1[beta]'));
    assert.ok(!matchResourcePattern('svc://api.v1[beta]', 'svc://apixv1xbetax'));
  });

  it('empty pattern only matches empty string', () => {
    assert.ok(matchResourcePattern('', ''));
    assert.ok(!matchResourcePattern('', 'anything'));
  });
});

// ─── Permission ──────────────────────────────────────────────────────

describe('Permission', () => {
  it('matches exact resource and action', () => {
    const p = new Permission({ resource: 'tool:fetch', actions: ['read'] });
    assert.ok(p.matches('tool:fetch', 'read'));
  });

  it('does not match wrong action', () => {
    const p = new Permission({ resource: 'tool:fetch', actions: ['read'] });
    assert.ok(!p.matches('tool:fetch', 'write'));
  });

  it('does not match wrong resource', () => {
    const p = new Permission({ resource: 'tool:fetch', actions: ['read'] });
    assert.ok(!p.matches('tool:read', 'read'));
  });

  it('matches with wildcard resource pattern', () => {
    const p = new Permission({ resource: 'svc://model/*', actions: ['execute'] });
    assert.ok(p.matches('svc://model/llama3', 'execute'));
    assert.ok(!p.matches('svc://model/gpt/4o', 'execute'));
  });

  it('admin action matches any action', () => {
    const p = new Permission({ resource: 'tool:fetch', actions: ['admin'] });
    assert.ok(p.matches('tool:fetch', 'read'));
    assert.ok(p.matches('tool:fetch', 'write'));
    assert.ok(p.matches('tool:fetch', 'delete'));
  });

  it('wildcard * action matches any action', () => {
    const p = new Permission({ resource: 'tool:fetch', actions: ['*'] });
    assert.ok(p.matches('tool:fetch', 'read'));
    assert.ok(p.matches('tool:fetch', 'execute'));
  });

  it('multiple actions work correctly', () => {
    const p = new Permission({ resource: 'svc://db', actions: ['read', 'write'] });
    assert.ok(p.matches('svc://db', 'read'));
    assert.ok(p.matches('svc://db', 'write'));
    assert.ok(!p.matches('svc://db', 'delete'));
  });

  it('quotas are stored correctly', () => {
    const p = new Permission({
      resource: 'svc://model/*',
      actions: ['execute'],
      quotas: { maxCalls: 100, maxTokens: 5000 },
    });
    assert.deepEqual(p.quotas, { maxCalls: 100, maxTokens: 5000 });
  });

  it('quotas default to null', () => {
    const p = new Permission({ resource: 'tool:fetch', actions: ['read'] });
    assert.equal(p.quotas, null);
  });

  it('toJSON/fromJSON round-trip', () => {
    const p = new Permission({
      resource: 'svc://model/**',
      actions: ['read', 'execute'],
      quotas: { maxCalls: 50 },
    });
    const json = p.toJSON();
    const p2 = Permission.fromJSON(json);
    assert.equal(p2.resource, p.resource);
    assert.deepEqual(p2.actions, p.actions);
    assert.deepEqual(p2.quotas, p.quotas);
  });
});

// ─── AccessGrant ─────────────────────────────────────────────────────

describe('AccessGrant', () => {
  function makeGrant(overrides = {}) {
    return new AccessGrant({
      id: 'grant_1',
      grantee: 'pod_alice',
      grantor: 'pod_bob',
      permissions: [
        { resource: 'svc://model/*', actions: ['read', 'execute'] },
      ],
      ...overrides,
    });
  }

  it('constructs with correct fields', () => {
    const g = makeGrant();
    assert.equal(g.id, 'grant_1');
    assert.equal(g.grantee, 'pod_alice');
    assert.equal(g.grantor, 'pod_bob');
    assert.equal(g.permissions.length, 1);
    assert.ok(g.permissions[0] instanceof Permission);
    assert.equal(g.revoked, null);
    assert.equal(g.usageCount, 0);
  });

  it('isExpired returns false when not expired', () => {
    const g = makeGrant({ conditions: { expires: Date.now() + 60000 } });
    assert.ok(!g.isExpired());
  });

  it('isExpired returns true when past expiry', () => {
    const g = makeGrant({ conditions: { expires: Date.now() - 1000 } });
    assert.ok(g.isExpired());
  });

  it('isExpired returns true when maxUses reached', () => {
    const g = makeGrant({ conditions: { maxUses: 3 }, usageCount: 3 });
    assert.ok(g.isExpired());
  });

  it('isExpired returns false when under maxUses', () => {
    const g = makeGrant({ conditions: { maxUses: 3 }, usageCount: 2 });
    assert.ok(!g.isExpired());
  });

  it('isExpired returns true when revoked', () => {
    const g = makeGrant();
    g.revoke();
    assert.ok(g.isExpired());
  });

  it('isWithinTimeWindow returns true when no windows configured', () => {
    const g = makeGrant();
    assert.ok(g.isWithinTimeWindow());
  });

  it('isWithinTimeWindow returns true inside window', () => {
    const g = makeGrant({
      conditions: { timeWindows: [{ start: '00:00', end: '23:59' }] },
    });
    assert.ok(g.isWithinTimeWindow(new Date()));
  });

  it('isWithinTimeWindow returns false outside window', () => {
    // Create a time window that definitely excludes the test time
    const g = makeGrant({
      conditions: { timeWindows: [{ start: '03:00', end: '03:01' }] },
    });
    // Use a date at 12:00 which is outside 03:00-03:01
    const noon = new Date(2025, 0, 1, 12, 0, 0);
    assert.ok(!g.isWithinTimeWindow(noon));
  });

  it('isWithinTimeWindow supports multiple windows', () => {
    const g = makeGrant({
      conditions: {
        timeWindows: [
          { start: '08:00', end: '12:00' },
          { start: '14:00', end: '18:00' },
        ],
      },
    });
    const morning = new Date(2025, 0, 1, 10, 0, 0);
    const lunch = new Date(2025, 0, 1, 13, 0, 0);
    const afternoon = new Date(2025, 0, 1, 15, 0, 0);
    assert.ok(g.isWithinTimeWindow(morning));
    assert.ok(!g.isWithinTimeWindow(lunch));
    assert.ok(g.isWithinTimeWindow(afternoon));
  });

  it('check returns allowed for valid grant', () => {
    const g = makeGrant();
    const result = g.check('svc://model/llama3', 'read');
    assert.ok(result.allowed);
    assert.equal(result.grant, g);
  });

  it('check returns not allowed for expired grant', () => {
    const g = makeGrant({ conditions: { expires: Date.now() - 1000 } });
    const result = g.check('svc://model/llama3', 'read');
    assert.ok(!result.allowed);
    assert.equal(result.reason, 'grant_expired');
  });

  it('check returns not allowed for wrong resource', () => {
    const g = makeGrant();
    const result = g.check('svc://db/users', 'read');
    assert.ok(!result.allowed);
    assert.equal(result.reason, 'no_matching_permission');
  });

  it('check returns not allowed for wrong action', () => {
    const g = makeGrant();
    const result = g.check('svc://model/llama3', 'delete');
    assert.ok(!result.allowed);
    assert.equal(result.reason, 'no_matching_permission');
  });

  it('check returns not allowed outside time window', () => {
    const g = makeGrant({
      conditions: { timeWindows: [{ start: '03:00', end: '03:01' }] },
    });
    // Force check at noon
    const noon = new Date(2025, 0, 1, 12, 0, 0);
    const result = g.check('svc://model/llama3', 'read', noon.getTime());
    assert.ok(!result.allowed);
    assert.equal(result.reason, 'outside_time_window');
  });

  it('consumeUse increments counter', () => {
    const g = makeGrant();
    assert.equal(g.usageCount, 0);
    g.consumeUse();
    assert.equal(g.usageCount, 1);
    g.consumeUse();
    assert.equal(g.usageCount, 2);
  });

  it('revoke sets timestamp', () => {
    const g = makeGrant();
    assert.equal(g.revoked, null);
    const ts = 1700000000000;
    g.revoke(ts);
    assert.equal(g.revoked, ts);
  });

  it('toJSON/fromJSON round-trip', () => {
    const g = makeGrant({
      conditions: { expires: 1800000000000, maxUses: 10 },
      usageCount: 3,
    });
    g.revoke(1700000000000);

    const json = g.toJSON();
    const g2 = AccessGrant.fromJSON(json);

    assert.equal(g2.id, g.id);
    assert.equal(g2.grantee, g.grantee);
    assert.equal(g2.grantor, g.grantor);
    assert.equal(g2.permissions.length, g.permissions.length);
    assert.equal(g2.permissions[0].resource, g.permissions[0].resource);
    assert.deepEqual(g2.permissions[0].actions, g.permissions[0].actions);
    assert.equal(g2.conditions.expires, g.conditions.expires);
    assert.equal(g2.conditions.maxUses, g.conditions.maxUses);
    assert.equal(g2.created, g.created);
    assert.equal(g2.revoked, g.revoked);
    assert.equal(g2.usageCount, g.usageCount);
  });

  it('fromJSON reconstructed grant check still works', () => {
    const g = makeGrant();
    const g2 = AccessGrant.fromJSON(g.toJSON());
    const result = g2.check('svc://model/llama3', 'read');
    assert.ok(result.allowed);
  });
});

// ─── ACLEngine ───────────────────────────────────────────────────────

describe('ACLEngine', () => {
  function makeEngine() {
    const engine = new ACLEngine();
    engine.addGrant(new AccessGrant({
      id: 'g1',
      grantee: 'pod_alice',
      grantor: 'pod_admin',
      permissions: [
        { resource: 'svc://model/*', actions: ['read', 'execute'] },
      ],
    }));
    engine.addGrant(new AccessGrant({
      id: 'g2',
      grantee: 'pod_alice',
      grantor: 'pod_admin',
      permissions: [
        { resource: 'tool:fetch', actions: ['execute'] },
      ],
    }));
    engine.addGrant(new AccessGrant({
      id: 'g3',
      grantee: 'pod_charlie',
      grantor: 'pod_admin',
      permissions: [
        { resource: 'fs:///public/**', actions: ['read'] },
      ],
    }));
    return engine;
  }

  it('addGrant and check succeeds', () => {
    const engine = makeEngine();
    const result = engine.check('pod_alice', 'svc://model/llama3', 'read');
    assert.ok(result.allowed);
  });

  it('check fails for unknown grantee', () => {
    const engine = makeEngine();
    const result = engine.check('pod_unknown', 'svc://model/llama3', 'read');
    assert.ok(!result.allowed);
    assert.equal(result.reason, 'no_grants');
  });

  it('check fails for wrong resource', () => {
    const engine = makeEngine();
    const result = engine.check('pod_alice', 'svc://db/users', 'read');
    assert.ok(!result.allowed);
  });

  it('check fails for wrong action', () => {
    const engine = makeEngine();
    const result = engine.check('pod_alice', 'svc://model/llama3', 'delete');
    assert.ok(!result.allowed);
  });

  it('removeGrant makes check fail', () => {
    const engine = makeEngine();
    assert.ok(engine.check('pod_alice', 'tool:fetch', 'execute').allowed);
    engine.removeGrant('g2');
    assert.ok(!engine.check('pod_alice', 'tool:fetch', 'execute').allowed);
  });

  it('removeGrant returns false for nonexistent ID', () => {
    const engine = makeEngine();
    assert.ok(!engine.removeGrant('nonexistent'));
  });

  it('revokeGrant makes check fail', () => {
    const engine = makeEngine();
    assert.ok(engine.check('pod_alice', 'tool:fetch', 'execute').allowed);
    engine.revokeGrant('g2');
    const result = engine.check('pod_alice', 'tool:fetch', 'execute');
    assert.ok(!result.allowed);
    assert.equal(result.reason, 'grant_expired');
  });

  it('revokeGrant returns false for nonexistent ID', () => {
    const engine = makeEngine();
    assert.ok(!engine.revokeGrant('nonexistent'));
  });

  it('revokeAll for specific grantee', () => {
    const engine = makeEngine();
    const count = engine.revokeAll('pod_alice');
    assert.equal(count, 2);
    assert.ok(!engine.check('pod_alice', 'svc://model/llama3', 'read').allowed);
    assert.ok(!engine.check('pod_alice', 'tool:fetch', 'execute').allowed);
    // Charlie's grant should still work
    assert.ok(engine.check('pod_charlie', 'fs:///public/readme.txt', 'read').allowed);
  });

  it('check with multiple grants returns first match', () => {
    const engine = new ACLEngine();
    engine.addGrant(new AccessGrant({
      id: 'first',
      grantee: 'pod_alice',
      grantor: 'pod_admin',
      permissions: [{ resource: 'tool:*', actions: ['execute'] }],
    }));
    engine.addGrant(new AccessGrant({
      id: 'second',
      grantee: 'pod_alice',
      grantor: 'pod_admin',
      permissions: [{ resource: 'tool:fetch', actions: ['execute'] }],
    }));
    const result = engine.check('pod_alice', 'tool:fetch', 'execute');
    assert.ok(result.allowed);
    assert.equal(result.grant.id, 'first');
  });

  it('listGrants returns all grants', () => {
    const engine = makeEngine();
    const all = engine.listGrants();
    assert.equal(all.length, 3);
  });

  it('listGrants with filter returns matching grants', () => {
    const engine = makeEngine();
    const alice = engine.listGrants('pod_alice');
    assert.equal(alice.length, 2);
    const charlie = engine.listGrants('pod_charlie');
    assert.equal(charlie.length, 1);
  });

  it('listGrants with unknown grantee returns empty', () => {
    const engine = makeEngine();
    assert.equal(engine.listGrants('pod_unknown').length, 0);
  });

  it('listGrantees returns grantees with counts', () => {
    const engine = makeEngine();
    const grantees = engine.listGrantees();
    assert.equal(grantees.length, 2);
    const alice = grantees.find(g => g.grantee === 'pod_alice');
    assert.equal(alice.count, 2);
    const charlie = grantees.find(g => g.grantee === 'pod_charlie');
    assert.equal(charlie.count, 1);
  });

  it('getEffectivePermissions merges from multiple grants', () => {
    const engine = makeEngine();
    const perms = engine.getEffectivePermissions('pod_alice');
    assert.equal(perms.length, 2); // one from g1, one from g2
    const resources = perms.map(p => p.resource).sort();
    assert.deepEqual(resources, ['svc://model/*', 'tool:fetch']);
  });

  it('getEffectivePermissions excludes expired grants', () => {
    const engine = new ACLEngine();
    engine.addGrant(new AccessGrant({
      id: 'active',
      grantee: 'pod_alice',
      grantor: 'pod_admin',
      permissions: [{ resource: 'tool:fetch', actions: ['execute'] }],
    }));
    engine.addGrant(new AccessGrant({
      id: 'expired',
      grantee: 'pod_alice',
      grantor: 'pod_admin',
      permissions: [{ resource: 'svc://model/*', actions: ['read'] }],
      conditions: { expires: Date.now() - 1000 },
    }));
    const perms = engine.getEffectivePermissions('pod_alice');
    assert.equal(perms.length, 1);
    assert.equal(perms[0].resource, 'tool:fetch');
  });

  it('getEffectivePermissions deduplicates identical permissions', () => {
    const engine = new ACLEngine();
    engine.addGrant(new AccessGrant({
      id: 'dup1',
      grantee: 'pod_alice',
      grantor: 'pod_admin',
      permissions: [{ resource: 'tool:fetch', actions: ['read', 'execute'] }],
    }));
    engine.addGrant(new AccessGrant({
      id: 'dup2',
      grantee: 'pod_alice',
      grantor: 'pod_other',
      permissions: [{ resource: 'tool:fetch', actions: ['execute', 'read'] }],
    }));
    const perms = engine.getEffectivePermissions('pod_alice');
    assert.equal(perms.length, 1);
  });

  it('pruneExpired removes old grants', () => {
    const engine = new ACLEngine();
    engine.addGrant(new AccessGrant({
      id: 'keep',
      grantee: 'pod_alice',
      grantor: 'pod_admin',
      permissions: [{ resource: 'tool:fetch', actions: ['execute'] }],
      conditions: { expires: Date.now() + 60000 },
    }));
    engine.addGrant(new AccessGrant({
      id: 'prune1',
      grantee: 'pod_alice',
      grantor: 'pod_admin',
      permissions: [{ resource: 'svc://x', actions: ['read'] }],
      conditions: { expires: Date.now() - 1000 },
    }));
    engine.addGrant(new AccessGrant({
      id: 'prune2',
      grantee: 'pod_alice',
      grantor: 'pod_admin',
      permissions: [{ resource: 'svc://y', actions: ['read'] }],
    }));
    engine.revokeGrant('prune2');

    const pruned = engine.pruneExpired();
    assert.equal(pruned, 2);
    assert.equal(engine.size, 1);
    assert.ok(engine.check('pod_alice', 'tool:fetch', 'execute').allowed);
  });

  it('size returns total grant count', () => {
    const engine = makeEngine();
    assert.equal(engine.size, 3);
    engine.removeGrant('g1');
    assert.equal(engine.size, 2);
  });

  it('toJSON/fromJSON round-trip', () => {
    const engine = makeEngine();
    engine.revokeGrant('g2');
    const json = engine.toJSON();
    const engine2 = ACLEngine.fromJSON(json);

    assert.equal(engine2.size, 3);
    assert.ok(engine2.check('pod_alice', 'svc://model/llama3', 'read').allowed);
    assert.ok(!engine2.check('pod_alice', 'tool:fetch', 'execute').allowed); // revoked
    assert.ok(engine2.check('pod_charlie', 'fs:///public/readme.txt', 'read').allowed);
  });

  it('addGrant replaces grant with same ID', () => {
    const engine = new ACLEngine();
    engine.addGrant(new AccessGrant({
      id: 'g1',
      grantee: 'pod_alice',
      grantor: 'pod_admin',
      permissions: [{ resource: 'tool:fetch', actions: ['read'] }],
    }));
    assert.ok(!engine.check('pod_alice', 'tool:fetch', 'execute').allowed);

    engine.addGrant(new AccessGrant({
      id: 'g1',
      grantee: 'pod_alice',
      grantor: 'pod_admin',
      permissions: [{ resource: 'tool:fetch', actions: ['execute'] }],
    }));
    assert.ok(engine.check('pod_alice', 'tool:fetch', 'execute').allowed);
    assert.equal(engine.size, 1);
  });
});

// ─── generateGrantId ─────────────────────────────────────────────────

describe('generateGrantId', () => {
  it('returns a string starting with grant_', () => {
    const id = generateGrantId();
    assert.ok(typeof id === 'string');
    assert.ok(id.startsWith('grant_'));
  });

  it('generates unique IDs on consecutive calls', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      ids.add(generateGrantId());
    }
    assert.equal(ids.size, 100);
  });

  it('has expected format with two segments after prefix', () => {
    const id = generateGrantId();
    const parts = id.split('_');
    assert.equal(parts.length, 3); // grant, timestamp, sequence
    assert.equal(parts[0], 'grant');
  });
});
