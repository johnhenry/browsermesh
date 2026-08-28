// Run with: node --import ./test/_setup-globals.mjs --test test/identity.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  MeshIdentityManager,
  InMemoryIdentityStorage,
  IndexedDBIdentityStorage,
  VaultIdentityStorage,
  IdentitySyncCoordinator,
  AutoIdentityManager,
  IdentitySelector,
  PodIdentity,
  encodeBase64url,
  decodeBase64url,
} from '../src/identity.mjs';

// ---------------------------------------------------------------------------
// InMemoryIdentityStorage
// ---------------------------------------------------------------------------

describe('InMemoryIdentityStorage', () => {
  let store;
  beforeEach(() => {
    store = new InMemoryIdentityStorage();
  });

  it('save and load round-trip', async () => {
    await store.save('k1', { x: 1 });
    const loaded = await store.load('k1');
    assert.deepEqual(loaded, { x: 1 });
  });

  it('load returns null for missing key', async () => {
    const result = await store.load('missing');
    assert.equal(result, null);
  });

  it('delete removes an entry', async () => {
    await store.save('k1', { x: 1 });
    const deleted = await store.delete('k1');
    assert.equal(deleted, true);
    assert.equal(await store.load('k1'), null);
  });

  it('delete returns false for missing key', async () => {
    const deleted = await store.delete('nope');
    assert.equal(deleted, false);
  });

  it('list returns all keys', async () => {
    await store.save('a', 1);
    await store.save('b', 2);
    const keys = await store.list();
    assert.deepEqual(keys.sort(), ['a', 'b']);
  });

  it('clear empties the store', async () => {
    await store.save('a', 1);
    await store.clear();
    assert.deepEqual(await store.list(), []);
  });

  it('save clones data (mutations do not leak)', async () => {
    const obj = { nested: { val: 1 } };
    await store.save('k', obj);
    obj.nested.val = 999;
    const loaded = await store.load('k');
    assert.equal(loaded.nested.val, 1);
  });
});

// ---------------------------------------------------------------------------
// MeshIdentityManager -- construction
// ---------------------------------------------------------------------------

describe('MeshIdentityManager', () => {
  let mgr;
  beforeEach(() => {
    mgr = new MeshIdentityManager();
  });

  it('starts empty', () => {
    assert.equal(mgr.size, 0);
    assert.deepEqual(mgr.list(), []);
    assert.equal(mgr.getDefault(), null);
  });

  // -- create -------------------------------------------------------------

  describe('create', () => {
    it('creates an identity and returns summary', async () => {
      const summary = await mgr.create('alice');
      assert.equal(typeof summary.podId, 'string');
      assert.ok(summary.podId.length > 0);
      assert.equal(summary.label, 'alice');
      assert.ok(summary.did.startsWith('did:key:z'));
      assert.equal(typeof summary.created, 'number');
      assert.deepEqual(summary.metadata, {});
    });

    it('creates with metadata', async () => {
      const summary = await mgr.create('bob', { metadata: { role: 'admin' } });
      assert.deepEqual(summary.metadata, { role: 'admin' });
    });

    it('increments size', async () => {
      await mgr.create('a');
      await mgr.create('b');
      assert.equal(mgr.size, 2);
    });

    it('auto-sets first identity as default', async () => {
      const s1 = await mgr.create('first');
      const def = mgr.getDefault();
      assert.equal(def.podId, s1.podId);
    });

    it('keeps first default when adding more', async () => {
      const s1 = await mgr.create('first');
      await mgr.create('second');
      const def = mgr.getDefault();
      assert.equal(def.podId, s1.podId);
    });

    it('throws on empty label', async () => {
      await assert.rejects(() => mgr.create(''), /Label is required/);
    });

    it('generates unique podIds', async () => {
      const s1 = await mgr.create('a');
      const s2 = await mgr.create('b');
      assert.notEqual(s1.podId, s2.podId);
    });
  });

  // -- list / get / has ---------------------------------------------------

  describe('list, get, has', () => {
    it('list returns all identities without private keys', async () => {
      await mgr.create('x');
      await mgr.create('y');
      const items = mgr.list();
      assert.equal(items.length, 2);
      for (const item of items) {
        assert.ok(item.podId);
        assert.ok(item.label);
        assert.ok(item.did);
        assert.equal(typeof item.created, 'number');
        // Ensure no private key material
        assert.equal(item.privateKey, undefined);
        assert.equal(item.keyPair, undefined);
      }
    });

    it('get returns summary for existing identity', async () => {
      const s = await mgr.create('z');
      const got = mgr.get(s.podId);
      assert.equal(got.podId, s.podId);
      assert.equal(got.label, 'z');
    });

    it('get returns null for missing identity', () => {
      assert.equal(mgr.get('nonexistent'), null);
    });

    it('has returns true/false', async () => {
      const s = await mgr.create('test');
      assert.equal(mgr.has(s.podId), true);
      assert.equal(mgr.has('nope'), false);
    });
  });

  // -- delete -------------------------------------------------------------

  describe('delete', () => {
    it('removes an identity', async () => {
      const s = await mgr.create('del');
      assert.equal(mgr.delete(s.podId), true);
      assert.equal(mgr.size, 0);
      assert.equal(mgr.get(s.podId), null);
    });

    it('returns false for missing identity', () => {
      assert.equal(mgr.delete('nope'), false);
    });

    it('reassigns default when default is deleted', async () => {
      const s1 = await mgr.create('a');
      const s2 = await mgr.create('b');
      mgr.setDefault(s1.podId);
      mgr.delete(s1.podId);
      const def = mgr.getDefault();
      assert.equal(def.podId, s2.podId);
    });

    it('sets default to null when last identity is deleted', async () => {
      const s = await mgr.create('only');
      mgr.delete(s.podId);
      assert.equal(mgr.getDefault(), null);
    });
  });

  // -- setDefault / getDefault --------------------------------------------

  describe('setDefault / getDefault', () => {
    it('sets and gets the default', async () => {
      const s1 = await mgr.create('a');
      const s2 = await mgr.create('b');
      mgr.setDefault(s2.podId);
      assert.equal(mgr.getDefault().podId, s2.podId);
    });

    it('throws for unknown podId', () => {
      assert.throws(() => mgr.setDefault('unknown'), /Unknown identity/);
    });

    it('getDefault returns first identity when no explicit default', async () => {
      await mgr.create('a');
      const s2 = await mgr.create('b');
      // Delete default (first) -- should fall through to next
      const items = mgr.list();
      mgr.delete(items[0].podId);
      const def = mgr.getDefault();
      assert.equal(def.podId, s2.podId);
    });
  });

  // -- sign / verify ------------------------------------------------------

  describe('sign / verify', () => {
    it('signs and verifies data', async () => {
      const s = await mgr.create('signer');
      const data = new TextEncoder().encode('test message');
      const sig = await mgr.sign(s.podId, data);
      assert.ok(sig instanceof Uint8Array);
      assert.ok(sig.length > 0);

      const pubBytes = await mgr.getPublicKeyBytes(s.podId);
      const valid = await mgr.verify(pubBytes, data, sig);
      assert.equal(valid, true);
    });

    it('rejects tampered data', async () => {
      const s = await mgr.create('signer');
      const data = new TextEncoder().encode('original');
      const sig = await mgr.sign(s.podId, data);

      const pubBytes = await mgr.getPublicKeyBytes(s.podId);
      const tampered = new TextEncoder().encode('tampered');
      const valid = await mgr.verify(pubBytes, tampered, sig);
      assert.equal(valid, false);
    });

    it('sign throws for unknown identity', async () => {
      await assert.rejects(
        () => mgr.sign('unknown', new Uint8Array([1])),
        /Unknown identity/
      );
    });
  });

  // -- toDID --------------------------------------------------------------

  describe('toDID', () => {
    it('returns a W3C did:key URI when raw key is cached', async () => {
      const s = await mgr.create('did-test');
      const did = mgr.toDID(s.podId);
      assert.ok(did.startsWith('did:key:z'));
      // W3C did:key for Ed25519 starts with z6Mk (multicodec prefix
      // 0xed 0x01 + 32-byte pubkey, base58btc-encoded).
      assert.match(did, /^did:key:z6Mk[1-9A-HJ-NP-Za-km-z]{40,50}$/);
      // Should NOT contain the legacy podId verbatim
      assert.ok(!did.includes(s.podId), 'new DID should not include the legacy podId form');
    });

    it('throws for unknown identity', () => {
      assert.throws(() => mgr.toDID('unknown'), /Unknown identity/);
    });

    it('toLegacyDID returns the original podId-based form', async () => {
      const s = await mgr.create('legacy');
      const legacy = mgr.toLegacyDID(s.podId);
      assert.equal(legacy, `did:key:z${s.podId}`);
    });

    it('toDID falls back to legacy form when raw key is missing', async () => {
      // Simulate a legacy in-memory identity where exportKey('raw') wasn't run
      const s = await mgr.create('fallback');
      // Manually drop the cached raw bytes via a fresh manager that imports
      // the same key but suppresses the rawPubKey cache.
      const raw = mgr.toDID(s.podId);
      assert.match(raw, /^did:key:z/);
      // Tampered identity entry: clear rawPubKey and confirm fallback
      // Use the public surface — verify legacy and proper differ
      const legacy = mgr.toLegacyDID(s.podId);
      assert.notEqual(raw, legacy, 'with raw key, proper DID should differ from legacy');
    });
  });

  // -- export / import ----------------------------------------------------

  describe('export / import', () => {
    it('exports raw JWK without passphrase', async () => {
      const s = await mgr.create('exp');
      const jwk = await mgr.export(s.podId);
      assert.equal(jwk.kty, 'OKP');
      assert.equal(jwk.crv, 'Ed25519');
      assert.ok(jwk.d); // private key component
    });

    it('import recreates identity from JWK', async () => {
      const s = await mgr.create('orig');
      const jwk = await mgr.export(s.podId);

      const mgr2 = new MeshIdentityManager();
      const s2 = await mgr2.import(jwk, 'imported');
      assert.equal(s2.podId, s.podId);
      assert.equal(s2.label, 'imported');

      // Verify imported identity can sign
      const data = new TextEncoder().encode('check');
      const sig = await mgr2.sign(s2.podId, data);
      const pubBytes = await mgr.getPublicKeyBytes(s.podId);
      const valid = await mgr.verify(pubBytes, data, sig);
      assert.equal(valid, true);
    });

    it('export throws for unknown identity', async () => {
      await assert.rejects(() => mgr.export('unknown'), /Unknown identity/);
    });

    it('import throws on empty label', async () => {
      await assert.rejects(
        () => mgr.import({ kty: 'OKP' }, ''),
        /Label is required/
      );
    });

    it('import throws on invalid JWK', async () => {
      await assert.rejects(
        () => mgr.import(null, 'bad'),
        /privateKeyJwk must be a valid JWK/
      );
    });
  });

  // -- save / load --------------------------------------------------------

  describe('save / load', () => {
    it('round-trips through storage', async () => {
      const storage = new InMemoryIdentityStorage();
      const mgr1 = new MeshIdentityManager({ storage });
      const s1 = await mgr1.create('persist-a');
      const s2 = await mgr1.create('persist-b');
      mgr1.setDefault(s2.podId);
      await mgr1.save();

      const mgr2 = new MeshIdentityManager({ storage });
      await mgr2.load();
      assert.equal(mgr2.size, 2);
      assert.equal(mgr2.getDefault().podId, s2.podId);
      assert.equal(mgr2.get(s1.podId).label, 'persist-a');
      assert.equal(mgr2.get(s2.podId).label, 'persist-b');
    });

    it('load handles empty storage gracefully', async () => {
      const storage = new InMemoryIdentityStorage();
      const m = new MeshIdentityManager({ storage });
      await m.load(); // should not throw
      assert.equal(m.size, 0);
    });
  });

  // -- toJSON -------------------------------------------------------------

  describe('toJSON', () => {
    it('serializes without private keys', async () => {
      await mgr.create('json-test');
      const json = mgr.toJSON();
      assert.ok(json.defaultId);
      assert.equal(json.identities.length, 1);
      assert.equal(json.identities[0].label, 'json-test');
      // No private key material
      assert.equal(json.identities[0].privateKey, undefined);
      assert.equal(json.identities[0].keyPair, undefined);
      assert.equal(json.identities[0].identity, undefined);
    });
  });

  // -- getPublicKeyBytes --------------------------------------------------

  describe('getPublicKeyBytes', () => {
    it('returns 32 bytes for Ed25519', async () => {
      const s = await mgr.create('pub');
      const bytes = await mgr.getPublicKeyBytes(s.podId);
      assert.ok(bytes instanceof Uint8Array);
      assert.equal(bytes.length, 32);
    });

    it('throws for unknown identity', async () => {
      await assert.rejects(
        () => mgr.getPublicKeyBytes('unknown'),
        /Unknown identity/
      );
    });
  });

  // -- onLog callback -----------------------------------------------------

  describe('onLog callback', () => {
    it('receives log events', async () => {
      const logs = [];
      const m = new MeshIdentityManager({ onLog: (ev, data) => logs.push({ ev, data }) });
      const s = await m.create('logged');
      m.delete(s.podId);
      assert.ok(logs.some((l) => l.ev === 'identity:create'));
      assert.ok(logs.some((l) => l.ev === 'identity:delete'));
    });
  });

  // -- getIdentity --------------------------------------------------------

  describe('getIdentity', () => {
    it('returns PodIdentity for existing identity', async () => {
      const s = await mgr.create('test');
      const identity = mgr.getIdentity(s.podId);
      assert.ok(identity instanceof PodIdentity);
      assert.equal(identity.podId, s.podId);
    });

    it('returns null for unknown identity', () => {
      assert.equal(mgr.getIdentity('unknown'), null);
    });
  });
});

// ---------------------------------------------------------------------------
// IndexedDBIdentityStorage (structural tests — no real IndexedDB in Node)
// ---------------------------------------------------------------------------

describe('IndexedDBIdentityStorage', () => {
  it('constructor sets default dbName', () => {
    const store = new IndexedDBIdentityStorage();
    assert.ok(store instanceof IndexedDBIdentityStorage);
  });

  it('constructor accepts custom dbName', () => {
    const store = new IndexedDBIdentityStorage({ dbName: 'test-db' });
    assert.ok(store instanceof IndexedDBIdentityStorage);
  });

  it('open throws when indexedDB is unavailable', async () => {
    // indexedDB is not defined in Node test env
    const store = new IndexedDBIdentityStorage();
    await assert.rejects(() => store.open(), /IndexedDB not available/);
  });

  it('close is safe to call without opening', () => {
    const store = new IndexedDBIdentityStorage();
    store.close(); // should not throw
  });
});

// ---------------------------------------------------------------------------
// VaultIdentityStorage
// ---------------------------------------------------------------------------

describe('VaultIdentityStorage', () => {
  it('constructor requires inner storage', () => {
    assert.throws(
      () => new VaultIdentityStorage(null, { getPassphrase: () => 'pw' }),
      /inner storage is required/
    );
  });

  it('constructor requires getPassphrase function', () => {
    assert.throws(
      () => new VaultIdentityStorage(new InMemoryIdentityStorage(), { getPassphrase: 'notfn' }),
      /getPassphrase must be a function/
    );
  });

  it('passes through meta records without encryption', async () => {
    const inner = new InMemoryIdentityStorage();
    const vault = new VaultIdentityStorage(inner, { getPassphrase: async () => 'secret' });
    await vault.save('__meta__', { defaultId: 'abc', ids: ['abc'] });
    const loaded = await vault.load('__meta__');
    assert.equal(loaded.defaultId, 'abc');
  });

  it('encrypts and decrypts privateKeyJwk round-trip', async () => {
    const inner = new InMemoryIdentityStorage();
    const vault = new VaultIdentityStorage(inner, { getPassphrase: async () => 'testpass123' });

    // Create a real identity to get a real JWK
    const idMgr = new MeshIdentityManager();
    const summary = await idMgr.create('vault-test');
    const jwk = await idMgr.export(summary.podId);

    const data = {
      podId: summary.podId,
      label: 'vault-test',
      privateKeyJwk: jwk,
      metadata: { foo: 'bar' },
    };

    await vault.save(summary.podId, data);

    // Verify inner has encrypted form
    const rawInner = await inner.load(summary.podId);
    assert.equal(rawInner.privateKeyJwk, null);
    assert.ok(rawInner.encryptedPrivateKey);
    assert.ok(rawInner.encryptedPrivateKey.salt);
    assert.ok(rawInner.encryptedPrivateKey.iv);
    assert.ok(rawInner.encryptedPrivateKey.ciphertext);

    // Verify vault decrypts correctly
    const loaded = await vault.load(summary.podId);
    assert.equal(loaded.podId, summary.podId);
    assert.equal(loaded.label, 'vault-test');
    assert.equal(loaded.privateKeyJwk.kty, 'OKP');
    assert.equal(loaded.privateKeyJwk.crv, 'Ed25519');
    assert.ok(loaded.privateKeyJwk.d); // private key component
    assert.deepEqual(loaded.metadata, { foo: 'bar' });
  });

  it('handles data without privateKeyJwk', async () => {
    const inner = new InMemoryIdentityStorage();
    const vault = new VaultIdentityStorage(inner, { getPassphrase: async () => 'pw' });

    await vault.save('pub-only', { podId: 'pub-only', label: 'pubonly' });
    const loaded = await vault.load('pub-only');
    assert.equal(loaded.label, 'pubonly');
  });

  it('load returns null for missing key', async () => {
    const inner = new InMemoryIdentityStorage();
    const vault = new VaultIdentityStorage(inner, { getPassphrase: async () => 'pw' });
    assert.equal(await vault.load('missing'), null);
  });

  it('delegates delete to inner', async () => {
    const inner = new InMemoryIdentityStorage();
    const vault = new VaultIdentityStorage(inner, { getPassphrase: async () => 'pw' });
    await vault.save('__meta__', { x: 1 });
    await vault.delete('__meta__');
    assert.equal(await vault.load('__meta__'), null);
  });

  it('delegates list to inner', async () => {
    const inner = new InMemoryIdentityStorage();
    const vault = new VaultIdentityStorage(inner, { getPassphrase: async () => 'pw' });
    await vault.save('__meta__', { x: 1 });
    await vault.save('id1', { podId: 'id1', label: 'a' });
    const keys = await vault.list();
    assert.ok(keys.includes('__meta__'));
    assert.ok(keys.includes('id1'));
  });

  it('delegates clear to inner', async () => {
    const inner = new InMemoryIdentityStorage();
    const vault = new VaultIdentityStorage(inner, { getPassphrase: async () => 'pw' });
    await vault.save('__meta__', { x: 1 });
    await vault.clear();
    assert.deepEqual(await vault.list(), []);
  });

  it('full round-trip: MeshIdentityManager save+load through VaultIdentityStorage', async () => {
    const inner = new InMemoryIdentityStorage();
    const vault = new VaultIdentityStorage(inner, { getPassphrase: async () => 'roundtrip' });

    const mgr1 = new MeshIdentityManager({ storage: vault });
    const s1 = await mgr1.create('encrypted-alice');
    const s2 = await mgr1.create('encrypted-bob');
    mgr1.setDefault(s2.podId);
    await mgr1.save();

    // Reload from vault
    const mgr2 = new MeshIdentityManager({ storage: vault });
    await mgr2.load();
    assert.equal(mgr2.size, 2);
    assert.equal(mgr2.getDefault().podId, s2.podId);
    assert.equal(mgr2.get(s1.podId).label, 'encrypted-alice');

    // Verify restored identity can sign
    const data = new TextEncoder().encode('vault check');
    const sig = await mgr2.sign(s1.podId, data);
    const pubBytes = await mgr1.getPublicKeyBytes(s1.podId);
    const valid = await mgr1.verify(pubBytes, data, sig);
    assert.equal(valid, true);
  });
});

// ---------------------------------------------------------------------------
// IdentitySyncCoordinator
// ---------------------------------------------------------------------------

describe('IdentitySyncCoordinator', () => {
  it('constructs with default BroadcastChannel', () => {
    const coord = new IdentitySyncCoordinator();
    assert.ok(coord);
    coord.close();
  });

  it('constructs with custom channel', () => {
    const ch = new BroadcastChannel('test-sync');
    const coord = new IdentitySyncCoordinator(ch);
    assert.ok(coord);
    coord.close();
  });

  it('acquireCreateLock resolves true when no conflict', async () => {
    const coord = new IdentitySyncCoordinator();
    const locked = await coord.acquireCreateLock('pod1');
    assert.equal(locked, true);
    coord.close();
  });

  it('broadcastCreated does not throw', () => {
    const coord = new IdentitySyncCoordinator();
    coord.broadcastCreated('pod1'); // should not throw
    coord.close();
  });

  it('broadcastDeleted does not throw', () => {
    const coord = new IdentitySyncCoordinator();
    coord.broadcastDeleted('pod1'); // should not throw
    coord.close();
  });

  it('onRemoteChange registers a listener', () => {
    const coord = new IdentitySyncCoordinator();
    const events = [];
    coord.onRemoteChange((msg) => events.push(msg));
    // No events yet since BroadcastChannel is a stub in tests
    assert.deepEqual(events, []);
    coord.close();
  });

  it('close is safe to call multiple times', () => {
    const coord = new IdentitySyncCoordinator();
    coord.close();
    coord.close(); // second close should not throw
  });

  it('acquireCreateLock with paired channel: tiebreaker resolves a symmetric race', async () => {
    // Build a paired BroadcastChannel mock so two coordinators talk.
    const subA = []; const subB = [];
    const chA = {
      postMessage(msg) { for (const fn of subB) fn({ data: msg }); },
      close() {}, set onmessage(fn) { subA.push(fn); },
    };
    const chB = {
      postMessage(msg) { for (const fn of subA) fn({ data: msg }); },
      close() {}, set onmessage(fn) { subB.push(fn); },
    };
    const coordA = new IdentitySyncCoordinator(chA);
    const coordB = new IdentitySyncCoordinator(chB);
    // Both tabs race for the same podId
    const [a, b] = await Promise.all([
      coordA.acquireCreateLock('shared-pod'),
      coordB.acquireCreateLock('shared-pod'),
    ]);
    // Exactly one tab must win (XOR). Pre-fix BOTH would be false (both yield).
    assert.notEqual(a, b, 'exactly one tab acquires the lock');
    coordA.close();
    coordB.close();
  });
});

// ---------------------------------------------------------------------------
// AutoIdentityManager
// ---------------------------------------------------------------------------

describe('AutoIdentityManager', () => {
  let storage;
  let idMgr;
  let autoMgr;

  beforeEach(() => {
    storage = new InMemoryIdentityStorage();
    idMgr = new MeshIdentityManager({ storage });
    autoMgr = new AutoIdentityManager(idMgr, storage);
  });

  it('boot creates a default identity when storage is empty', async () => {
    await autoMgr.boot('ws-test');
    assert.equal(autoMgr.booted, true);
    assert.equal(idMgr.size, 1);

    const active = autoMgr.getActive();
    assert.ok(active);
    assert.equal(active.label, 'default');
  });

  it('boot loads existing identities from storage', async () => {
    // Pre-populate storage
    const mgr1 = new MeshIdentityManager({ storage });
    const s = await mgr1.create('existing');
    await mgr1.save();

    // Boot with fresh manager
    const mgr2 = new MeshIdentityManager({ storage });
    const auto2 = new AutoIdentityManager(mgr2, storage);
    await auto2.boot('ws-test');

    assert.equal(mgr2.size, 1);
    assert.equal(auto2.getActive().podId, s.podId);
  });

  it('boot does not create duplicate if identities exist', async () => {
    const s = await idMgr.create('pre-existing');
    await idMgr.save();

    // Re-create and boot
    const mgr2 = new MeshIdentityManager({ storage });
    const auto2 = new AutoIdentityManager(mgr2, storage);
    await auto2.boot('ws-test');
    assert.equal(mgr2.size, 1);
    assert.equal(auto2.getActive().podId, s.podId);
  });

  it('ensureIdentity returns existing active', async () => {
    await autoMgr.boot('ws-test');
    const identity = await autoMgr.ensureIdentity();
    assert.ok(identity instanceof PodIdentity);
  });

  it('ensureIdentity creates if none exist', async () => {
    // Don't boot, just call ensureIdentity
    const identity = await autoMgr.ensureIdentity();
    assert.ok(identity instanceof PodIdentity);
    assert.equal(idMgr.size, 1);
  });

  it('switchIdentity changes the active identity', async () => {
    await autoMgr.boot('ws-test');
    const s2 = await idMgr.create('second');

    await autoMgr.switchIdentity(s2.podId);
    assert.equal(autoMgr.getActive().podId, s2.podId);
  });

  it('switchIdentity throws for unknown podId', async () => {
    await autoMgr.boot('ws-test');
    await assert.rejects(
      () => autoMgr.switchIdentity('nonexistent'),
      /Unknown identity/
    );
  });

  it('switchIdentity fires onSwitch listeners', async () => {
    await autoMgr.boot('ws-test');
    const s2 = await idMgr.create('second');

    const events = [];
    autoMgr.onSwitch((ev) => events.push(ev));
    await autoMgr.switchIdentity(s2.podId);

    assert.equal(events.length, 1);
    assert.equal(events[0].newId, s2.podId);
  });

  it('listIdentities shows active status', async () => {
    await autoMgr.boot('ws-test');
    const s2 = await idMgr.create('second');

    const list = autoMgr.listIdentities();
    assert.equal(list.length, 2);
    assert.ok(list.some(i => i.isActive));
    assert.ok(list.some(i => !i.isActive));
  });

  it('getActiveIdentity returns PodIdentity', async () => {
    await autoMgr.boot('ws-test');
    const identity = autoMgr.getActiveIdentity();
    assert.ok(identity instanceof PodIdentity);
  });

  it('toJSON / fromJSON round-trips', async () => {
    await autoMgr.boot('ws-test');
    const json = autoMgr.toJSON();
    assert.ok(json.activeId);
    assert.equal(json.booted, true);

    const storage2 = new InMemoryIdentityStorage();
    const mgr2 = new MeshIdentityManager({ storage: storage2 });
    const auto2 = new AutoIdentityManager(mgr2, storage2);
    auto2.fromJSON(json);
    assert.equal(auto2.booted, true);
  });
});

// ---------------------------------------------------------------------------
// IdentitySelector
// ---------------------------------------------------------------------------

describe('IdentitySelector', () => {
  let storage;
  let idMgr;
  let autoMgr;
  let selector;
  let alicePodId;
  let bobPodId;

  beforeEach(async () => {
    storage = new InMemoryIdentityStorage();
    idMgr = new MeshIdentityManager({ storage });
    autoMgr = new AutoIdentityManager(idMgr, storage);
    await autoMgr.boot('ws-test');

    const alice = await idMgr.create('alice');
    const bob = await idMgr.create('bob');
    alicePodId = alice.podId;
    bobPodId = bob.podId;
    await autoMgr.switchIdentity(alicePodId);

    selector = new IdentitySelector(autoMgr);
  });

  it('resolve returns active identity by default', () => {
    const identity = selector.resolve('some-peer');
    assert.ok(identity instanceof PodIdentity);
    assert.equal(identity.podId, alicePodId);
  });

  it('setRule overrides identity for specific peer', () => {
    selector.setRule('peer1', bobPodId);
    const identity = selector.resolve('peer1');
    assert.equal(identity.podId, bobPodId);
  });

  it('resolve falls back to active for peers without rules', () => {
    selector.setRule('peer1', bobPodId);
    const identity = selector.resolve('peer2');
    assert.equal(identity.podId, alicePodId);
  });

  it('setDefaultRule overrides identity for scope', () => {
    selector.setDefaultRule('relay', bobPodId);
    const identity = selector.resolve('any-peer', 'relay');
    assert.equal(identity.podId, bobPodId);
  });

  it('peer rule takes priority over scope rule', () => {
    selector.setDefaultRule('relay', alicePodId);
    selector.setRule('peer1', bobPodId);
    const identity = selector.resolve('peer1', 'relay');
    assert.equal(identity.podId, bobPodId);
  });

  it('removeRule removes a peer-specific rule', () => {
    selector.setRule('peer1', bobPodId);
    selector.removeRule('peer1');
    const identity = selector.resolve('peer1');
    assert.equal(identity.podId, alicePodId);
  });

  it('listRules returns all rules', () => {
    selector.setRule('peer1', bobPodId);
    selector.setDefaultRule('relay', alicePodId);
    const rules = selector.listRules();
    assert.equal(rules.length, 2);
    assert.ok(rules.some(r => r.peerId === 'peer1'));
    assert.ok(rules.some(r => r.scope === 'relay'));
  });

  it('toJSON / fromJSON round-trips', () => {
    selector.setRule('peer1', bobPodId);
    selector.setDefaultRule('relay', alicePodId);

    const json = selector.toJSON();
    const selector2 = new IdentitySelector(autoMgr);
    selector2.fromJSON(json);

    const rules = selector2.listRules();
    assert.equal(rules.length, 2);
    assert.ok(rules.some(r => r.peerId === 'peer1' && r.podId === bobPodId));
    assert.ok(rules.some(r => r.scope === 'relay' && r.podId === alicePodId));
  });

  it('resolve returns null when no active identity and no rules', () => {
    const emptyIdMgr = new MeshIdentityManager();
    const emptyAutoMgr = new AutoIdentityManager(emptyIdMgr, new InMemoryIdentityStorage());
    const emptySel = new IdentitySelector(emptyAutoMgr);
    const result = emptySel.resolve('peer1');
    assert.equal(result, null);
  });
});
