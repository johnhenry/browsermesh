import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CapabilityToken,
  CapabilityChain,
  CapabilityValidator,
  WasmSandboxPolicy,
  WasmSandbox,
  SandboxRegistry,
  CAP_GRANT,
  CAP_REVOKE,
  CAP_DELEGATE,
  WASM_SANDBOX_CTRL,
} from '../src/capabilities.mjs';

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('has correct hex values', () => {
    assert.equal(CAP_GRANT, 0xDC);
    assert.equal(CAP_REVOKE, 0xDD);
    assert.equal(CAP_DELEGATE, 0xDE);
    assert.equal(WASM_SANDBOX_CTRL, 0xDF);
  });
});

// ---------------------------------------------------------------------------
// CapabilityToken
// ---------------------------------------------------------------------------

describe('CapabilityToken', () => {
  let root;

  beforeEach(() => {
    root = new CapabilityToken({
      issuer: 'podA',
      holder: 'podB',
      resource: 'fs:/data/*',
      permissions: ['read', 'write', 'delete'],
      maxDepth: 3,
      expiresAt: Date.now() + 60_000,
    });
  });

  it('requires issuer', () => {
    assert.throws(() => new CapabilityToken({ holder: 'b', resource: 'r', permissions: ['x'] }), /issuer/);
  });

  it('requires holder', () => {
    assert.throws(() => new CapabilityToken({ issuer: 'a', resource: 'r', permissions: ['x'] }), /holder/);
  });

  it('requires resource', () => {
    assert.throws(() => new CapabilityToken({ issuer: 'a', holder: 'b', permissions: ['x'] }), /resource/);
  });

  it('requires non-empty permissions', () => {
    assert.throws(() => new CapabilityToken({ issuer: 'a', holder: 'b', resource: 'r', permissions: [] }), /permissions/);
  });

  it('sets defaults', () => {
    assert.equal(root.parentId, null);
    assert.equal(root.revoked, false);
    assert.equal(root.depth, 0);
    assert.ok(root.id.startsWith('cap_'));
  });

  it('isExpired() returns false when within TTL', () => {
    assert.equal(root.isExpired(), false);
  });

  it('isExpired() returns true when past expiry', () => {
    assert.equal(root.isExpired(Date.now() + 100_000), true);
  });

  it('isValid() checks both revoked and expired', () => {
    assert.equal(root.isValid(), true);
    root.revoke();
    assert.equal(root.isValid(), false);
  });

  it('hasPermission() checks permissions', () => {
    assert.equal(root.hasPermission('read'), true);
    assert.equal(root.hasPermission('execute'), false);
  });

  it('canDelegate() respects maxDepth', () => {
    assert.equal(root.canDelegate(), true);
    const deep = new CapabilityToken({
      issuer: 'a', holder: 'b', resource: 'r', permissions: ['x'],
      depth: 3, maxDepth: 3,
    });
    assert.equal(deep.canDelegate(), false);
  });

  it('canDelegate() allows unlimited when maxDepth=null', () => {
    const tok = new CapabilityToken({
      issuer: 'a', holder: 'b', resource: 'r', permissions: ['x'],
      depth: 100, maxDepth: null,
    });
    assert.equal(tok.canDelegate(), true);
  });

  describe('attenuate()', () => {
    it('creates a child token with subset of permissions', () => {
      const child = root.attenuate({ holder: 'podC', permissions: ['read'] });
      assert.equal(child.holder, 'podC');
      assert.equal(child.issuer, 'podB');
      assert.deepEqual([...child.permissions], ['read']);
      assert.equal(child.parentId, root.id);
      assert.equal(child.depth, 1);
    });

    it('inherits parent permissions when none specified', () => {
      const child = root.attenuate({ holder: 'podC' });
      assert.deepEqual([...child.permissions], ['read', 'write', 'delete']);
    });

    it('rejects permission amplification', () => {
      assert.throws(() => root.attenuate({ holder: 'podC', permissions: ['execute'] }), /Cannot grant/);
    });

    it('rejects attenuating invalid token', () => {
      root.revoke();
      assert.throws(() => root.attenuate({ holder: 'podC' }), /invalid token/);
    });

    it('rejects depth limit exceeded', () => {
      const tok = new CapabilityToken({
        issuer: 'a', holder: 'b', resource: 'r', permissions: ['x'],
        depth: 3, maxDepth: 3,
      });
      assert.throws(() => tok.attenuate({ holder: 'c' }), /depth limit/);
    });

    it('rejects extending expiry beyond parent', () => {
      assert.throws(() => root.attenuate({
        holder: 'podC',
        expiresAt: Date.now() + 999_999,
      }), /Cannot extend expiry/);
    });

    it('inherits parent expiry when not specified', () => {
      const child = root.attenuate({ holder: 'podC' });
      assert.equal(child.expiresAt, root.expiresAt);
    });

    it('merges constraints', () => {
      const r = new CapabilityToken({
        issuer: 'a', holder: 'b', resource: 'r', permissions: ['x'],
        constraints: { rateLimit: 100 },
      });
      const c = r.attenuate({ holder: 'c', constraints: { maxCalls: 10 } });
      assert.equal(c.constraints.rateLimit, 100);
      assert.equal(c.constraints.maxCalls, 10);
    });
  });

  describe('toJSON / fromJSON', () => {
    it('round-trips', () => {
      const json = root.toJSON();
      const restored = CapabilityToken.fromJSON(json);
      assert.equal(restored.id, root.id);
      assert.equal(restored.issuer, root.issuer);
      assert.equal(restored.holder, root.holder);
      assert.equal(restored.resource, root.resource);
      assert.deepEqual([...restored.permissions], [...root.permissions]);
    });
  });
});

// ---------------------------------------------------------------------------
// CapabilityChain
// ---------------------------------------------------------------------------

describe('CapabilityChain', () => {
  let root, child, chain;

  beforeEach(() => {
    root = new CapabilityToken({
      id: 'root1',
      issuer: 'podA',
      holder: 'podB',
      resource: 'fs:/data/*',
      permissions: ['read', 'write'],
    });
    child = root.attenuate({ holder: 'podC', permissions: ['read'] });
    chain = new CapabilityChain([root, child]);
  });

  it('tracks length', () => {
    assert.equal(chain.length, 2);
  });

  it('provides root and leaf', () => {
    assert.equal(chain.root.id, 'root1');
    assert.equal(chain.leaf.holder, 'podC');
  });

  it('at() returns token by index', () => {
    assert.equal(chain.at(0).id, root.id);
    assert.equal(chain.at(1).id, child.id);
    assert.equal(chain.at(5), null);
  });

  it('append() requires parent link', () => {
    const grandchild = child.attenuate({ holder: 'podD' });
    chain.append(grandchild);
    assert.equal(chain.length, 3);
  });

  it('append() rejects broken parent link', () => {
    const unrelated = new CapabilityToken({
      issuer: 'x', holder: 'y', resource: 'r', permissions: ['z'],
      parentId: 'nonexistent',
    });
    assert.throws(() => chain.append(unrelated), /parentId must match/);
  });

  describe('verify()', () => {
    it('valid chain returns { valid: true }', () => {
      assert.deepEqual(chain.verify(false), { valid: true });
    });

    it('empty chain is invalid', () => {
      const empty = new CapabilityChain();
      const result = empty.verify();
      assert.equal(result.valid, false);
      assert.ok(result.error.includes('empty'));
    });

    it('detects permission amplification', () => {
      // Manually construct a chain with amplification
      const bad = new CapabilityToken({
        id: 'bad1',
        issuer: 'podB',
        holder: 'podC',
        resource: 'fs:/data/*',
        permissions: ['read', 'write', 'execute'], // execute not in parent
        parentId: root.id,
        depth: 1,
      });
      const badChain = new CapabilityChain([root, bad]);
      const result = badChain.verify(false);
      assert.equal(result.valid, false);
      assert.ok(result.error.includes('amplification'));
    });

    it('detects broken parent link', () => {
      const broken = new CapabilityToken({
        id: 'broken1',
        issuer: 'podB', holder: 'podC',
        resource: 'r', permissions: ['read'],
        parentId: 'wrong_id',
        depth: 1,
      });
      const badChain = new CapabilityChain([root, broken]);
      const result = badChain.verify(false);
      assert.equal(result.valid, false);
      assert.equal(result.brokenAt, 1);
    });

    it('detects invalid (revoked) tokens when checkValidity=true', () => {
      child.revoke();
      const result = chain.verify(true);
      assert.equal(result.valid, false);
      assert.equal(result.brokenAt, 1);
    });
  });

  describe('toJSON / fromJSON', () => {
    it('round-trips', () => {
      const restored = CapabilityChain.fromJSON(chain.toJSON());
      assert.equal(restored.length, 2);
      assert.equal(restored.root.id, root.id);
    });
  });
});

// ---------------------------------------------------------------------------
// CapabilityValidator
// ---------------------------------------------------------------------------

describe('CapabilityValidator', () => {
  let validator, rootToken;

  beforeEach(() => {
    validator = new CapabilityValidator();
    rootToken = new CapabilityToken({
      id: 'tok1',
      issuer: 'podA',
      holder: 'podB',
      resource: 'fs:/data/*',
      permissions: ['read', 'write'],
      expiresAt: Date.now() + 60_000,
    });
    validator.register(rootToken);
  });

  it('validates allowed access', () => {
    const result = validator.validate('tok1', 'fs:/data/file.txt', 'read');
    assert.equal(result.allowed, true);
  });

  it('rejects unknown token', () => {
    const result = validator.validate('nonexistent', 'r', 'read');
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('not found'));
  });

  it('rejects missing permission', () => {
    const result = validator.validate('tok1', 'fs:/data/file.txt', 'execute');
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('execute'));
  });

  it('rejects resource mismatch', () => {
    const result = validator.validate('tok1', 'net:tcp:80', 'read');
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('Resource'));
  });

  it('rejects expired token', () => {
    const expired = new CapabilityToken({
      id: 'tok2',
      issuer: 'a', holder: 'b', resource: '*', permissions: ['x'],
      expiresAt: Date.now() - 1000,
    });
    validator.register(expired);
    const result = validator.validate('tok2', 'any', 'x');
    assert.equal(result.allowed, false);
    assert.ok(result.reason.includes('expired'));
  });

  it('revokeTree() revokes token and descendants', () => {
    const child = rootToken.attenuate({ holder: 'podC', permissions: ['read'] });
    validator.register(child);

    validator.revokeTree('tok1');
    assert.equal(validator.validate('tok1', 'fs:/data/x', 'read').allowed, false);
    assert.equal(validator.validate(child.id, 'fs:/data/x', 'read').allowed, false);
  });

  it('listTokens() returns all tokens', () => {
    assert.equal(validator.listTokens().length, 1);
    assert.equal(validator.size, 1);
  });

  it('wildcard resource matches everything', () => {
    const wild = new CapabilityToken({
      id: 'wild',
      issuer: 'a', holder: 'b', resource: '*', permissions: ['read'],
    });
    validator.register(wild);
    assert.equal(validator.validate('wild', 'anything', 'read').allowed, true);
  });

  describe('toJSON / fromJSON', () => {
    it('round-trips', () => {
      const json = validator.toJSON();
      assert.equal(json.tokens.length, 1);
      assert.deepEqual(json.revokedIds, []);
    });
  });
});

// ---------------------------------------------------------------------------
// WasmSandboxPolicy
// ---------------------------------------------------------------------------

describe('WasmSandboxPolicy', () => {
  it('requires name', () => {
    assert.throws(() => new WasmSandboxPolicy({}), /name/);
  });

  it('sets defaults', () => {
    const p = new WasmSandboxPolicy({ name: 'default' });
    assert.equal(p.maxMemoryMb, 64);
    assert.equal(p.maxCpuMs, 5000);
    assert.equal(p.maxInstances, 4);
    assert.equal(p.networkAccess, false);
    assert.equal(p.fsAccess, false);
  });

  it('allows() checks permissions', () => {
    const p = new WasmSandboxPolicy({ name: 'test', permissions: ['memory', 'time'] });
    assert.equal(p.allows('memory'), true);
    assert.equal(p.allows('net'), false);
  });

  it('allowsImport() checks namespace', () => {
    const p = new WasmSandboxPolicy({ name: 'test', allowedImports: ['wasi_snapshot'] });
    assert.equal(p.allowsImport('wasi_snapshot'), true);
    assert.equal(p.allowsImport('env'), false);
  });

  it('allowsImport() with wildcard', () => {
    const p = new WasmSandboxPolicy({ name: 'test', allowedImports: ['*'] });
    assert.equal(p.allowsImport('anything'), true);
  });

  it('checkLimits() detects violations', () => {
    const p = new WasmSandboxPolicy({ name: 'test', maxMemoryMb: 32, maxCpuMs: 1000 });
    assert.equal(p.checkLimits({ memoryMb: 16 }).withinLimits, true);
    const result = p.checkLimits({ memoryMb: 64 });
    assert.equal(result.withinLimits, false);
    assert.ok(result.violations[0].includes('memory'));
  });

  it('toJSON / fromJSON round-trips', () => {
    const p = new WasmSandboxPolicy({ name: 'test', maxMemoryMb: 128 });
    const restored = WasmSandboxPolicy.fromJSON(p.toJSON());
    assert.equal(restored.name, 'test');
    assert.equal(restored.maxMemoryMb, 128);
  });
});

// ---------------------------------------------------------------------------
// WasmSandbox
// ---------------------------------------------------------------------------

describe('WasmSandbox', () => {
  let policy, sandbox;

  beforeEach(() => {
    policy = new WasmSandboxPolicy({ name: 'test', maxMemoryMb: 32 });
    sandbox = new WasmSandbox({ ownerPodId: 'podA', policy });
  });

  it('requires ownerPodId', () => {
    assert.throws(() => new WasmSandbox({ policy }), /ownerPodId/);
  });

  it('requires WasmSandboxPolicy', () => {
    assert.throws(() => new WasmSandbox({ ownerPodId: 'a', policy: {} }), /WasmSandboxPolicy/);
  });

  it('starts in idle state', () => {
    assert.equal(sandbox.state, 'idle');
  });

  it('load() transitions idle→loading→ready', async () => {
    const states = [];
    sandbox.onStateChange(s => states.push(s));
    await sandbox.load('abc123');
    assert.deepEqual(states, ['loading', 'ready']);
    assert.equal(sandbox.moduleHash, 'abc123');
  });

  it('load() rejects if not idle', async () => {
    await sandbox.load('abc');
    await assert.rejects(() => sandbox.load('def'), /Cannot load/);
  });

  it('execute() requires ready/running state', async () => {
    await assert.rejects(() => sandbox.execute('fn'), /Cannot execute/);
  });

  it('execute() tracks usage', async () => {
    await sandbox.load('mod1');
    await sandbox.execute('compute', [1, 2, 3]);
    assert.ok(sandbox.usage.cpuMs > 0);
  });

  it('pause() and resume()', async () => {
    await sandbox.load('mod1');
    sandbox.pause();
    assert.equal(sandbox.state, 'paused');
    sandbox.resume();
    assert.equal(sandbox.state, 'ready');
  });

  it('pause() rejects invalid state', () => {
    assert.throws(() => sandbox.pause(), /Cannot pause/);
  });

  it('resume() rejects if not paused', async () => {
    await sandbox.load('mod1');
    assert.throws(() => sandbox.resume(), /Cannot resume/);
  });

  it('terminate() changes state to terminated', () => {
    sandbox.terminate();
    assert.equal(sandbox.state, 'terminated');
  });

  it('allocateMemory() tracks and enforces limits', async () => {
    await sandbox.load('mod1');
    sandbox.allocateMemory(16);
    assert.equal(sandbox.usage.memoryMb, 16);
    assert.throws(() => sandbox.allocateMemory(32), /denied/);
  });

  it('logs() records operations', async () => {
    await sandbox.load('mod1');
    assert.ok(sandbox.logs.length > 0);
    assert.ok(sandbox.logs[0].includes('Module loaded'));
  });

  it('toJSON() serializes state', () => {
    const json = sandbox.toJSON();
    assert.equal(json.ownerPodId, 'podA');
    assert.equal(json.state, 'idle');
    assert.equal(json.policy.name, 'test');
  });
});

// ---------------------------------------------------------------------------
// SandboxRegistry
// ---------------------------------------------------------------------------

describe('SandboxRegistry', () => {
  let registry, policy;

  beforeEach(() => {
    registry = new SandboxRegistry();
    policy = new WasmSandboxPolicy({ name: 'test', maxInstances: 2 });
  });

  it('creates sandbox and tracks it', () => {
    const sb = registry.create({ ownerPodId: 'podA', policy });
    assert.equal(registry.size, 1);
    assert.equal(registry.get(sb.id).ownerPodId, 'podA');
  });

  it('enforces per-pod instance limit', () => {
    registry.create({ ownerPodId: 'podA', policy });
    registry.create({ ownerPodId: 'podA', policy });
    assert.throws(() => registry.create({ ownerPodId: 'podA', policy }), /Instance limit/);
  });

  it('different pods have independent limits', () => {
    registry.create({ ownerPodId: 'podA', policy });
    registry.create({ ownerPodId: 'podA', policy });
    const sb = registry.create({ ownerPodId: 'podB', policy }); // OK: different pod
    assert.equal(registry.size, 3);
    assert.ok(sb);
  });

  it('terminate() removes sandbox', () => {
    const sb = registry.create({ ownerPodId: 'podA', policy });
    registry.terminate(sb.id);
    assert.equal(registry.size, 0);
    assert.equal(registry.get(sb.id), null);
  });

  it('terminate() throws for unknown sandbox', () => {
    assert.throws(() => registry.terminate('nonexistent'), /not found/);
  });

  it('listByPod() returns sandboxes for a pod', () => {
    registry.create({ ownerPodId: 'podA', policy });
    registry.create({ ownerPodId: 'podB', policy });
    assert.equal(registry.listByPod('podA').length, 1);
    assert.equal(registry.listByPod('podC').length, 0);
  });

  it('listAll() returns all sandboxes', () => {
    registry.create({ ownerPodId: 'podA', policy });
    registry.create({ ownerPodId: 'podB', policy });
    assert.equal(registry.listAll().length, 2);
  });

  it('fires onCreate and onTerminate callbacks', () => {
    const created = [];
    const terminated = [];
    registry.onCreate(sb => created.push(sb.id));
    registry.onTerminate(sb => terminated.push(sb.id));

    const sb = registry.create({ ownerPodId: 'podA', policy });
    assert.equal(created.length, 1);
    registry.terminate(sb.id);
    assert.equal(terminated.length, 1);
  });

  it('getStats() provides summary', () => {
    registry.create({ ownerPodId: 'podA', policy });
    registry.create({ ownerPodId: 'podB', policy });
    const stats = registry.getStats();
    assert.equal(stats.totalSandboxes, 2);
    assert.equal(stats.podCount, 2);
  });

  it('toJSON() serializes', () => {
    registry.create({ ownerPodId: 'podA', policy });
    const json = registry.toJSON();
    assert.equal(json.sandboxes.length, 1);
  });
});
