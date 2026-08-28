import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseScope, matchScope, CapabilityToken } from '../src/capability.mjs';

describe('parseScope', () => {
  it('parses fully qualified scope', () => {
    const result = parseScope('mesh:crdt:write');
    assert.deepEqual(result, {
      namespace: 'mesh',
      resource: 'crdt',
      action: 'write',
    });
  });

  it('parses scope with wildcard action', () => {
    const result = parseScope('mesh:transport:*');
    assert.deepEqual(result, {
      namespace: 'mesh',
      resource: 'transport',
      action: '*',
    });
  });

  it('defaults missing parts to wildcard', () => {
    assert.deepEqual(parseScope('mesh:crdt'), {
      namespace: 'mesh',
      resource: 'crdt',
      action: '*',
    });

    assert.deepEqual(parseScope('mesh'), {
      namespace: 'mesh',
      resource: '*',
      action: '*',
    });
  });

  it('parses all-wildcard scope', () => {
    assert.deepEqual(parseScope('*:*:*'), {
      namespace: '*',
      resource: '*',
      action: '*',
    });
  });

  it('handles empty string parts as wildcard', () => {
    assert.deepEqual(parseScope('::'), {
      namespace: '*',
      resource: '*',
      action: '*',
    });
  });
});

describe('matchScope', () => {
  it('matches exact scopes', () => {
    assert.equal(matchScope('mesh:crdt:write', 'mesh:crdt:write'), true);
  });

  it('does not match different scopes', () => {
    assert.equal(matchScope('mesh:crdt:read', 'mesh:crdt:write'), false);
  });

  it('wildcard namespace matches any namespace', () => {
    assert.equal(matchScope('*:crdt:write', 'mesh:crdt:write'), true);
    assert.equal(matchScope('*:crdt:write', 'other:crdt:write'), true);
  });

  it('wildcard resource matches any resource', () => {
    assert.equal(matchScope('mesh:*:write', 'mesh:crdt:write'), true);
    assert.equal(matchScope('mesh:*:write', 'mesh:transport:write'), true);
  });

  it('wildcard action matches any action', () => {
    assert.equal(matchScope('mesh:crdt:*', 'mesh:crdt:write'), true);
    assert.equal(matchScope('mesh:crdt:*', 'mesh:crdt:read'), true);
  });

  it('full wildcard matches everything', () => {
    assert.equal(matchScope('*:*:*', 'mesh:crdt:write'), true);
    assert.equal(matchScope('*:*:*', 'any:thing:here'), true);
  });

  it('granted without wildcard does not match different values', () => {
    assert.equal(matchScope('mesh:crdt:write', 'mesh:crdt:read'), false);
    assert.equal(matchScope('mesh:crdt:write', 'other:crdt:write'), false);
    assert.equal(matchScope('mesh:crdt:write', 'mesh:transport:write'), false);
  });

  it('required wildcard is not matched by specific granted', () => {
    // granted "mesh" does not cover required "*" (required wants anything)
    assert.equal(matchScope('mesh:crdt:write', '*:crdt:write'), false);
  });

  it('short scope strings default missing parts to wildcard', () => {
    assert.equal(matchScope('mesh', 'mesh:crdt:write'), true);
    assert.equal(matchScope('mesh:crdt', 'mesh:crdt:write'), true);
  });
});

describe('CapabilityToken', () => {
  describe('constructor', () => {
    it('stores all fields', () => {
      const sig = new Uint8Array([1, 2, 3]);
      const token = new CapabilityToken({
        issuer: 'pod-a',
        subject: 'pod-b',
        scopes: ['mesh:crdt:write'],
        expiresAt: 9999999999,
        signature: sig,
      });
      assert.equal(token.issuer, 'pod-a');
      assert.equal(token.subject, 'pod-b');
      assert.deepEqual(token.scopes, ['mesh:crdt:write']);
      assert.equal(token.expiresAt, 9999999999);
      assert.deepEqual(token.signature, sig);
    });

    it('signature is optional', () => {
      const token = new CapabilityToken({
        issuer: 'a',
        subject: 'b',
        scopes: ['*:*:*'],
        expiresAt: 0,
      });
      assert.equal(token.signature, undefined);
    });
  });

  describe('isExpired', () => {
    it('returns false when expiresAt is 0 (no expiry)', () => {
      const token = new CapabilityToken({
        issuer: 'a',
        subject: 'b',
        scopes: [],
        expiresAt: 0,
      });
      assert.equal(token.isExpired(), false);
    });

    it('returns false when token has not expired yet', () => {
      const futureTime = Date.now() / 1000 + 3600;
      const token = new CapabilityToken({
        issuer: 'a',
        subject: 'b',
        scopes: [],
        expiresAt: futureTime,
      });
      assert.equal(token.isExpired(), false);
    });

    it('returns true when token has expired', () => {
      const pastTime = Date.now() / 1000 - 3600;
      const token = new CapabilityToken({
        issuer: 'a',
        subject: 'b',
        scopes: [],
        expiresAt: pastTime,
      });
      assert.equal(token.isExpired(), true);
    });

    it('accepts custom now parameter', () => {
      const token = new CapabilityToken({
        issuer: 'a',
        subject: 'b',
        scopes: [],
        expiresAt: 1000,
      });
      assert.equal(token.isExpired(999), false);
      assert.equal(token.isExpired(1000), true);
      assert.equal(token.isExpired(1001), true);
    });
  });

  describe('covers', () => {
    it('returns true when a scope matches', () => {
      const token = new CapabilityToken({
        issuer: 'a',
        subject: 'b',
        scopes: ['mesh:crdt:write', 'mesh:transport:read'],
        expiresAt: 0,
      });
      assert.equal(token.covers('mesh:crdt:write'), true);
      assert.equal(token.covers('mesh:transport:read'), true);
    });

    it('returns false when no scope matches', () => {
      const token = new CapabilityToken({
        issuer: 'a',
        subject: 'b',
        scopes: ['mesh:crdt:write'],
        expiresAt: 0,
      });
      assert.equal(token.covers('mesh:crdt:read'), false);
    });

    it('wildcard scope covers anything', () => {
      const token = new CapabilityToken({
        issuer: 'a',
        subject: 'b',
        scopes: ['*:*:*'],
        expiresAt: 0,
      });
      assert.equal(token.covers('mesh:crdt:write'), true);
      assert.equal(token.covers('anything:here:now'), true);
    });

    it('returns false with empty scopes', () => {
      const token = new CapabilityToken({
        issuer: 'a',
        subject: 'b',
        scopes: [],
        expiresAt: 0,
      });
      assert.equal(token.covers('mesh:crdt:write'), false);
    });
  });

  describe('toJSON', () => {
    it('serializes without signature', () => {
      const token = new CapabilityToken({
        issuer: 'pod-a',
        subject: 'pod-b',
        scopes: ['mesh:crdt:write'],
        expiresAt: 123456,
        signature: new Uint8Array([1, 2, 3]),
      });
      const json = token.toJSON();
      assert.deepEqual(json, {
        issuer: 'pod-a',
        subject: 'pod-b',
        scopes: ['mesh:crdt:write'],
        expiresAt: 123456,
      });
      assert.equal(json.signature, undefined);
    });

    it('produces valid JSON', () => {
      const token = new CapabilityToken({
        issuer: 'a',
        subject: 'b',
        scopes: ['*:*:*'],
        expiresAt: 0,
      });
      const str = JSON.stringify(token);
      const parsed = JSON.parse(str);
      assert.equal(parsed.issuer, 'a');
      assert.equal(parsed.subject, 'b');
      assert.deepEqual(parsed.scopes, ['*:*:*']);
      assert.equal(parsed.expiresAt, 0);
    });
  });
});
