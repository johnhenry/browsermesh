// Run with: node --import ./test/_setup-globals.mjs --test test/storage-indexeddb.test.mjs
//
// IndexedDB-backed persistence for MeshSyncEngine, tested against a real
// IndexedDB implementation.
//
// `browsermesh-core`'s own `IndexedDBIdentityStorage` tests never actually
// exercise real IndexedDB behavior in Node — that package has no IndexedDB
// polyfill, so its suite only asserts the "throws when unavailable"
// fallback path (see `packages/browsermesh-core/test/identity.test.mjs`,
// `describe('IndexedDBIdentityStorage')`). There is no existing in-repo
// precedent to reuse for a *real* round-trip test. `fake-indexeddb` is a
// widely-used, spec-compliant in-memory IndexedDB implementation for
// Node — it's added here as a new devDependency scoped to this package
// only (not the workspace root, not browsermesh-core) specifically so this
// suite can prove actual persistence, which is the point of this adapter.
import 'fake-indexeddb/auto';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MeshSyncEngine } from '../src/sync.mjs';
import { IndexedDBSyncStorage } from '../src/storage-indexeddb.mjs';

// Use a fresh DB name per test so tests don't interact through shared state.
let dbCounter = 0;
function freshDbName() {
  dbCounter += 1;
  return `test-mesh-sync-${dbCounter}`;
}

describe('IndexedDBSyncStorage', () => {
  it('constructor sets defaults without opening a connection', () => {
    const storage = new IndexedDBSyncStorage();
    assert.ok(storage instanceof IndexedDBSyncStorage);
  });

  it('constructor accepts custom dbName / storeName', () => {
    const storage = new IndexedDBSyncStorage({ dbName: 'custom-db', storeName: 'custom-store' });
    assert.ok(storage instanceof IndexedDBSyncStorage);
  });

  it('load returns null before anything has been saved', async () => {
    const storage = new IndexedDBSyncStorage({ dbName: freshDbName() });
    assert.equal(await storage.load(), null);
  });

  it('save/load round-trips real data through IndexedDB', async () => {
    const dbName = freshDbName();
    const storage = new IndexedDBSyncStorage({ dbName });
    const docs = [
      { id: 'a', type: 'lww-map', owner: 'node1', crdt: { entries: {} }, version: { clock: {} }, created: 1, lastModified: 1, acl: [] },
      { id: 'b', type: 'g-counter', owner: 'node1', crdt: { counts: {} }, version: { clock: {} }, created: 2, lastModified: 2, acl: [] },
    ];
    await storage.save(docs);
    const loaded = await storage.load();
    assert.deepEqual(loaded, docs);
  });

  it('save replaces the entire stored set (documents removed locally do not linger)', async () => {
    const storage = new IndexedDBSyncStorage({ dbName: freshDbName() });
    await storage.save([{ id: 'a', val: 1 }, { id: 'b', val: 2 }]);
    await storage.save([{ id: 'a', val: 99 }]);
    const loaded = await storage.load();
    assert.deepEqual(loaded, [{ id: 'a', val: 99 }]);
  });

  it('save deep-clones so later mutations of the input do not leak', async () => {
    const storage = new IndexedDBSyncStorage({ dbName: freshDbName() });
    const original = [{ id: 'a', nested: { x: 1 } }];
    await storage.save(original);
    original[0].nested.x = 999;
    const loaded = await storage.load();
    assert.equal(loaded[0].nested.x, 1);
  });

  it('clear() actually empties the store', async () => {
    const storage = new IndexedDBSyncStorage({ dbName: freshDbName() });
    await storage.save([{ id: 'a' }, { id: 'b' }]);
    assert.ok(await storage.load());
    await storage.clear();
    assert.equal(await storage.load(), null);
  });

  it('close() is safe to call without opening', () => {
    const storage = new IndexedDBSyncStorage();
    storage.close(); // should not throw
  });

  it('separate dbName/storeName configs do not collide', async () => {
    const a = new IndexedDBSyncStorage({ dbName: freshDbName(), storeName: 'documents' });
    const b = new IndexedDBSyncStorage({ dbName: freshDbName(), storeName: 'documents' });
    await a.save([{ id: 'x', from: 'a' }]);
    await b.save([{ id: 'x', from: 'b' }]);
    assert.deepEqual(await a.load(), [{ id: 'x', from: 'a' }]);
    assert.deepEqual(await b.load(), [{ id: 'x', from: 'b' }]);
  });

  // ── The actual persistence proof the plan cares about ──────────────────
  //
  // A fresh IndexedDBSyncStorage instance (no shared in-memory state)
  // pointed at the same dbName/storeName after a simulated "reload" must
  // see data saved by a previous instance.
  it('a fresh instance pointed at the same DB/store sees previously-saved data after a simulated reload', async () => {
    const dbName = freshDbName();
    const storeName = 'documents';

    const before = new IndexedDBSyncStorage({ dbName, storeName });
    await before.save([
      { id: 'doc-1', type: 'lww-register', owner: 'node1', crdt: { value: 'hello' }, version: { clock: { node1: 1 } }, created: 100, lastModified: 100, acl: [] },
    ]);
    before.close();

    // Simulate a reload: brand new instance, nothing carried over except
    // the dbName/storeName configuration.
    const after = new IndexedDBSyncStorage({ dbName, storeName });
    const loaded = await after.load();
    assert.deepEqual(loaded, [
      { id: 'doc-1', type: 'lww-register', owner: 'node1', crdt: { value: 'hello' }, version: { clock: { node1: 1 } }, created: 100, lastModified: 100, acl: [] },
    ]);
  });
});

// ── End-to-end with MeshSyncEngine ─────────────────────────────────────────

describe('MeshSyncEngine + IndexedDBSyncStorage', () => {
  let dbName;
  beforeEach(() => { dbName = freshDbName(); });

  it('a workspace survives a reload: engine.save() then a fresh engine + fresh storage instance sees it after engine.load()', async () => {
    const engine1 = new MeshSyncEngine({ nodeId: 'node1', storage: new IndexedDBSyncStorage({ dbName }) });
    const doc = engine1.create('config', 'lww-map');
    engine1.update('config', (crdt) => crdt.set('theme', 'dark', Date.now(), 'node1'));
    await engine1.save();

    // Simulate reload: new engine, new storage instance, same dbName.
    const engine2 = new MeshSyncEngine({ nodeId: 'node1', storage: new IndexedDBSyncStorage({ dbName }) });
    await engine2.load();

    assert.equal(engine2.size, 1);
    assert.deepEqual(engine2.getState('config'), { theme: 'dark' });
    assert.equal(engine2.get('config').id, doc.id);
  });

  it('clear() on the storage empties what a reloaded engine would see', async () => {
    const storage = new IndexedDBSyncStorage({ dbName });
    const engine1 = new MeshSyncEngine({ nodeId: 'node1', storage });
    engine1.create('counter', 'g-counter');
    engine1.update('counter', (crdt) => crdt.increment('node1', 5));
    await engine1.save();
    await storage.clear();

    const engine2 = new MeshSyncEngine({ nodeId: 'node1', storage: new IndexedDBSyncStorage({ dbName }) });
    await engine2.load();
    assert.equal(engine2.size, 0);
  });
});
