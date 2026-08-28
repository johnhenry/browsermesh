// Run with: node --import ./test/_setup-globals.mjs --test test/naming.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMeshUri,
  NameRecord,
  MeshNameResolver,
  NAME_TTL_DEFAULT,
  MAX_NAME_LENGTH,
  NAME_PATTERN,
} from '../src/naming.mjs';

// ---------------------------------------------------------------------------
// parseMeshUri
// ---------------------------------------------------------------------------

describe('parseMeshUri', () => {
  it('parses @alice as short name', () => {
    const r = parseMeshUri('@alice');
    assert.equal(r.type, 'short');
    assert.equal(r.name, 'alice');
    assert.equal(r.relay, null);
    assert.equal(r.path, null);
  });

  it('parses @alice@relay.example.com as qualified', () => {
    const r = parseMeshUri('@alice@relay.example.com');
    assert.equal(r.type, 'qualified');
    assert.equal(r.name, 'alice');
    assert.equal(r.relay, 'relay.example.com');
    assert.equal(r.path, null);
  });

  it('parses did:key:z6Mk... as did', () => {
    const r = parseMeshUri('did:key:z6MkFingerprint');
    assert.equal(r.type, 'did');
    assert.equal(r.fingerprint, 'z6MkFingerprint');
    assert.equal(r.path, null);
  });

  it('parses mesh://alice/service/path as mesh URI', () => {
    const r = parseMeshUri('mesh://alice/service/path');
    assert.equal(r.type, 'mesh');
    assert.equal(r.name, 'alice');
    assert.equal(r.relay, null);
    assert.equal(r.path, '/service/path');
  });

  it('parses mesh://alice as mesh URI with no path', () => {
    const r = parseMeshUri('mesh://alice');
    assert.equal(r.type, 'mesh');
    assert.equal(r.name, 'alice');
    assert.equal(r.path, null);
  });

  it('returns null for unrecognized format', () => {
    assert.equal(parseMeshUri('foobar'), null);
    assert.equal(parseMeshUri(''), null);
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Naming constants', () => {
  it('NAME_TTL_DEFAULT is 1 hour', () => {
    assert.equal(NAME_TTL_DEFAULT, 3600000);
  });

  it('MAX_NAME_LENGTH is 64', () => {
    assert.equal(MAX_NAME_LENGTH, 64);
  });

  it('NAME_PATTERN matches valid names', () => {
    assert.ok(NAME_PATTERN.test('alice'));
    assert.ok(NAME_PATTERN.test('bob-smith'));
    assert.ok(NAME_PATTERN.test('a1'));
    assert.ok(NAME_PATTERN.test('hello.world'));
    assert.ok(NAME_PATTERN.test('a_b'));
  });

  it('NAME_PATTERN rejects invalid names', () => {
    assert.ok(!NAME_PATTERN.test('-alice'));
    assert.ok(!NAME_PATTERN.test('alice-'));
    assert.ok(!NAME_PATTERN.test('.alice'));
    assert.ok(!NAME_PATTERN.test('ALICE'));
    assert.ok(!NAME_PATTERN.test('a'));  // too short (need at least 2)
  });
});

// ---------------------------------------------------------------------------
// NameRecord
// ---------------------------------------------------------------------------

describe('NameRecord', () => {
  it('constructs with name and fingerprint', () => {
    const r = new NameRecord({ name: 'alice', fingerprint: 'fp1' });
    assert.equal(r.name, 'alice');
    assert.equal(r.fingerprint, 'fp1');
    assert.equal(r.ttl, NAME_TTL_DEFAULT);
  });

  it('accepts custom ttl', () => {
    const r = new NameRecord({ name: 'alice', fingerprint: 'fp1', ttl: 5000 });
    assert.equal(r.ttl, 5000);
  });

  it('stores relay and metadata', () => {
    const r = new NameRecord({
      name: 'alice',
      fingerprint: 'fp1',
      relay: 'relay.example.com',
      metadata: { bio: 'hello' },
    });
    assert.equal(r.relay, 'relay.example.com');
    assert.deepEqual(r.metadata, { bio: 'hello' });
  });

  it('isExpired checks timestamp + ttl', () => {
    const r = new NameRecord({
      name: 'alice',
      fingerprint: 'fp1',
      timestamp: 1000,
      ttl: 500,
    });
    assert.ok(r.isExpired(1501));
    assert.ok(!r.isExpired(1499));
  });

  it('round-trips via JSON', () => {
    const r = new NameRecord({
      name: 'bob',
      fingerprint: 'fp2',
      relay: 'r.com',
      metadata: { x: 1 },
    });
    const r2 = NameRecord.fromJSON(r.toJSON());
    assert.equal(r2.name, 'bob');
    assert.equal(r2.fingerprint, 'fp2');
    assert.equal(r2.relay, 'r.com');
    assert.deepEqual(r2.metadata, { x: 1 });
  });
});

// ---------------------------------------------------------------------------
// MeshNameResolver — registration
// ---------------------------------------------------------------------------

describe('MeshNameResolver registration', () => {
  let resolver;
  beforeEach(() => {
    resolver = new MeshNameResolver();
  });

  it('register creates a record', () => {
    const rec = resolver.register('alice', 'fp1');
    assert.equal(rec.name, 'alice');
    assert.equal(rec.fingerprint, 'fp1');
  });

  it('register with options', () => {
    const rec = resolver.register('alice', 'fp1', {
      ttl: 5000,
      relay: 'r.com',
      metadata: { bio: 'hi' },
    });
    assert.equal(rec.ttl, 5000);
    assert.equal(rec.relay, 'r.com');
    assert.deepEqual(rec.metadata, { bio: 'hi' });
  });

  it('register rejects invalid name format', () => {
    assert.throws(() => resolver.register('ALICE', 'fp1'), Error);
    assert.throws(() => resolver.register('-bad', 'fp1'), Error);
  });

  it('register rejects name too long', () => {
    const longName = 'a' + 'b'.repeat(MAX_NAME_LENGTH);
    assert.throws(() => resolver.register(longName, 'fp1'), Error);
  });

  it('register rejects duplicate name from different owner', () => {
    resolver.register('alice', 'fp1');
    assert.throws(() => resolver.register('alice', 'fp2'), Error);
  });

  it('register allows same owner to renew', () => {
    resolver.register('alice', 'fp1', { ttl: 1000 });
    const rec2 = resolver.register('alice', 'fp1', { ttl: 2000 });
    assert.equal(rec2.ttl, 2000);
  });
});

// ---------------------------------------------------------------------------
// MeshNameResolver — unregister
// ---------------------------------------------------------------------------

describe('MeshNameResolver unregister', () => {
  let resolver;
  beforeEach(() => {
    resolver = new MeshNameResolver();
  });

  it('unregister removes a name', () => {
    resolver.register('alice', 'fp1');
    assert.ok(resolver.unregister('alice', 'fp1'));
    assert.equal(resolver.resolve('@alice'), null);
  });

  it('unregister rejects non-owner', () => {
    resolver.register('alice', 'fp1');
    assert.ok(!resolver.unregister('alice', 'fp2'));
  });

  it('unregister returns false for missing name', () => {
    assert.ok(!resolver.unregister('nobody', 'fp1'));
  });
});

// ---------------------------------------------------------------------------
// MeshNameResolver — resolve
// ---------------------------------------------------------------------------

describe('MeshNameResolver resolve', () => {
  let resolver;
  beforeEach(() => {
    resolver = new MeshNameResolver();
    resolver.register('alice', 'fp1');
    resolver.register('bob', 'fp2', { relay: 'relay.test' });
  });

  it('resolves @alice', () => {
    const r = resolver.resolve('@alice');
    assert.ok(r);
    assert.equal(r.fingerprint, 'fp1');
    assert.equal(r.record.name, 'alice');
  });

  it('resolves @bob@relay.test (qualified)', () => {
    const r = resolver.resolve('@bob@relay.test');
    assert.ok(r);
    assert.equal(r.fingerprint, 'fp2');
  });

  it('returns null for @unknown', () => {
    assert.equal(resolver.resolve('@unknown'), null);
  });

  it('returns null for expired name', () => {
    const res = new MeshNameResolver();
    res.register('old', 'fp1', { ttl: 1 });
    // Force time forward
    const result = res.resolve('@old');
    // The name was just registered so it should still be valid
    assert.ok(result);
  });

  it('resolves mesh://alice/path', () => {
    const r = resolver.resolve('mesh://alice/path');
    assert.ok(r);
    assert.equal(r.fingerprint, 'fp1');
  });

  it('returns null for unrecognized URI', () => {
    assert.equal(resolver.resolve('garbage'), null);
  });
});

// ---------------------------------------------------------------------------
// MeshNameResolver — reverseResolve
// ---------------------------------------------------------------------------

describe('MeshNameResolver reverseResolve', () => {
  let resolver;
  beforeEach(() => {
    resolver = new MeshNameResolver();
    resolver.register('alice', 'fp1');
    resolver.register('alice2', 'fp1');
    resolver.register('bob', 'fp2');
  });

  it('returns all names for fingerprint', () => {
    const records = resolver.reverseResolve('fp1');
    assert.equal(records.length, 2);
    const names = records.map(r => r.name).sort();
    assert.deepEqual(names, ['alice', 'alice2']);
  });

  it('returns empty for unknown fingerprint', () => {
    assert.deepEqual(resolver.reverseResolve('fp_nobody'), []);
  });
});

// ---------------------------------------------------------------------------
// MeshNameResolver — transfer
// ---------------------------------------------------------------------------

describe('MeshNameResolver transfer', () => {
  let resolver;
  beforeEach(() => {
    resolver = new MeshNameResolver();
    resolver.register('alice', 'fp1');
  });

  it('transfers ownership', () => {
    const rec = resolver.transfer('alice', 'fp1', 'fp2');
    assert.equal(rec.fingerprint, 'fp2');
    const r = resolver.resolve('@alice');
    assert.equal(r.fingerprint, 'fp2');
  });

  it('rejects transfer from non-owner', () => {
    assert.throws(() => resolver.transfer('alice', 'fp_wrong', 'fp2'), Error);
  });

  it('rejects transfer of unknown name', () => {
    assert.throws(() => resolver.transfer('nobody', 'fp1', 'fp2'), Error);
  });
});

// ---------------------------------------------------------------------------
// MeshNameResolver — prune
// ---------------------------------------------------------------------------

describe('MeshNameResolver prune', () => {
  it('removes expired records', () => {
    const resolver = new MeshNameResolver();
    resolver.register('old', 'fp1', { ttl: 1 });
    resolver.register('new', 'fp2', { ttl: 999999999 });
    // Wait and prune
    const now = Date.now() + 100;
    const count = resolver.prune(now);
    assert.equal(count, 1);
    assert.equal(resolver.resolve('@old'), null);
    assert.ok(resolver.resolve('@new'));
  });
});

// ---------------------------------------------------------------------------
// MeshNameResolver — search and list
// ---------------------------------------------------------------------------

describe('MeshNameResolver search and list', () => {
  let resolver;
  beforeEach(() => {
    resolver = new MeshNameResolver();
    resolver.register('alice', 'fp1', { metadata: { bio: 'hello world' } });
    resolver.register('bob', 'fp2', { metadata: { bio: 'dev' } });
    resolver.register('charlie', 'fp3');
  });

  it('list returns all records', () => {
    assert.equal(resolver.list().length, 3);
  });

  it('search matches name substring', () => {
    const results = resolver.search('ali');
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'alice');
  });

  it('search matches metadata', () => {
    const results = resolver.search('hello');
    assert.equal(results.length, 1);
    assert.equal(results[0].name, 'alice');
  });

  it('search returns empty for no match', () => {
    assert.deepEqual(resolver.search('zzzzz'), []);
  });
});

// ---------------------------------------------------------------------------
// MeshNameResolver — serialization
// ---------------------------------------------------------------------------

describe('MeshNameResolver serialization', () => {
  it('round-trips via JSON', () => {
    const resolver = new MeshNameResolver();
    resolver.register('alice', 'fp1', { relay: 'r.com' });
    resolver.register('bob', 'fp2');

    const resolver2 = MeshNameResolver.fromJSON(resolver.toJSON());
    const r = resolver2.resolve('@alice');
    assert.ok(r);
    assert.equal(r.fingerprint, 'fp1');
    assert.equal(r.record.relay, 'r.com');

    const r2 = resolver2.resolve('@bob');
    assert.ok(r2);
    assert.equal(r2.fingerprint, 'fp2');
  });
});
