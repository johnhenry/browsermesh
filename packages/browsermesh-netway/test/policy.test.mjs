import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PolicyEngine } from '../src/policy.mjs';
import { CAPABILITY } from '../src/constants.mjs';

describe('PolicyEngine', () => {
  it('no capabilities → deny', async () => {
    const engine = new PolicyEngine();
    const scopeId = engine.createScope({ capabilities: [] });
    const result = await engine.check(scopeId, { capability: CAPABILITY.TCP_CONNECT, address: 'tcp://example.com:80' });
    assert.equal(result, 'deny');
  });

  it('matching capability → allow', async () => {
    const engine = new PolicyEngine();
    const scopeId = engine.createScope({ capabilities: [CAPABILITY.TCP_CONNECT] });
    const result = await engine.check(scopeId, { capability: CAPABILITY.TCP_CONNECT, address: 'tcp://example.com:80' });
    assert.equal(result, 'allow');
  });

  it('non-matching capability → deny', async () => {
    const engine = new PolicyEngine();
    const scopeId = engine.createScope({ capabilities: [CAPABILITY.TCP_CONNECT] });
    const result = await engine.check(scopeId, { capability: CAPABILITY.TCP_LISTEN, address: 'tcp://0.0.0.0:8080' });
    assert.equal(result, 'deny');
  });

  it('wildcard capability → allow all', async () => {
    const engine = new PolicyEngine();
    const scopeId = engine.createScope({ capabilities: [CAPABILITY.ALL] });
    const r1 = await engine.check(scopeId, { capability: CAPABILITY.TCP_CONNECT });
    const r2 = await engine.check(scopeId, { capability: CAPABILITY.DNS_RESOLVE });
    assert.equal(r1, 'allow');
    assert.equal(r2, 'allow');
  });

  it('callback override allows', async () => {
    const engine = new PolicyEngine();
    const scopeId = engine.createScope({
      capabilities: [],
      policy: (request, tags) => {
        // Allow everything regardless of tags
        return 'allow';
      },
    });
    const result = await engine.check(scopeId, { capability: CAPABILITY.TCP_CONNECT });
    assert.equal(result, 'allow');
  });

  it('callback override denies even with matching cap', async () => {
    const engine = new PolicyEngine();
    const scopeId = engine.createScope({
      capabilities: [CAPABILITY.TCP_CONNECT],
      policy: (request, tags) => 'deny',
    });
    const result = await engine.check(scopeId, { capability: CAPABILITY.TCP_CONNECT });
    assert.equal(result, 'deny');
  });

  it('async callback', async () => {
    const engine = new PolicyEngine();
    const scopeId = engine.createScope({
      capabilities: [],
      policy: async (request, tags) => {
        await new Promise(r => setTimeout(r, 5));
        return tags.has(request.capability) ? 'allow' : 'deny';
      },
    });
    const result = await engine.check(scopeId, { capability: CAPABILITY.TCP_CONNECT });
    assert.equal(result, 'deny');
  });

  it('unknown scope → deny', async () => {
    const engine = new PolicyEngine();
    const result = await engine.check('nonexistent', { capability: CAPABILITY.TCP_CONNECT });
    assert.equal(result, 'deny');
  });

  it('removeScope', async () => {
    const engine = new PolicyEngine();
    const scopeId = engine.createScope({ capabilities: [CAPABILITY.ALL] });
    assert.equal(await engine.check(scopeId, { capability: CAPABILITY.TCP_CONNECT }), 'allow');
    engine.removeScope(scopeId);
    assert.equal(await engine.check(scopeId, { capability: CAPABILITY.TCP_CONNECT }), 'deny');
  });

  it('multiple scopes are independent', async () => {
    const engine = new PolicyEngine();
    const s1 = engine.createScope({ capabilities: [CAPABILITY.TCP_CONNECT] });
    const s2 = engine.createScope({ capabilities: [CAPABILITY.DNS_RESOLVE] });
    assert.equal(await engine.check(s1, { capability: CAPABILITY.TCP_CONNECT }), 'allow');
    assert.equal(await engine.check(s1, { capability: CAPABILITY.DNS_RESOLVE }), 'deny');
    assert.equal(await engine.check(s2, { capability: CAPABILITY.DNS_RESOLVE }), 'allow');
    assert.equal(await engine.check(s2, { capability: CAPABILITY.TCP_CONNECT }), 'deny');
  });
});
