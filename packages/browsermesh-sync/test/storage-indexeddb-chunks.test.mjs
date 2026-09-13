// Run with: node --import ./test/_setup-globals.mjs --test test/storage-indexeddb-chunks.test.mjs
//
// IndexedDB-backed content-addressed chunk storage, tested against a real
// IndexedDB implementation (see storage-indexeddb.test.mjs for the same
// `fake-indexeddb` rationale — this suite follows that precedent exactly).
import 'fake-indexeddb/auto';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkStore } from '../src/files.mjs';
import { IndexedDBChunkStore } from '../src/storage-indexeddb-chunks.mjs';

// Use a fresh DB name per test so tests don't interact through shared state.
let dbCounter = 0;
function freshDbName() {
  dbCounter += 1;
  return `test-mesh-chunks-${dbCounter}`;
}

describe('IndexedDBChunkStore', () => {
  it('constructor sets defaults without opening a connection', () => {
    const store = new IndexedDBChunkStore();
    assert.ok(store instanceof IndexedDBChunkStore);
  });

  it('constructor accepts custom dbName / storeName', () => {
    const store = new IndexedDBChunkStore({ dbName: 'custom-db', storeName: 'custom-store' });
    assert.ok(store instanceof IndexedDBChunkStore);
  });

  it('starts empty', () => {
    const store = new IndexedDBChunkStore({ dbName: freshDbName() });
    assert.equal(store.size, 0);
  });

  it('saves and retrieves chunks', async () => {
    const store = new IndexedDBChunkStore({ dbName: freshDbName() });
    const data = new Uint8Array([1, 2, 3]);
    await store.save('abc', data);
    assert.deepEqual(await store.get('abc'), data);
    assert.equal(store.size, 1);
  });

  it('get returns undefined for a missing chunk', async () => {
    const store = new IndexedDBChunkStore({ dbName: freshDbName() });
    assert.equal(await store.get('nope'), undefined);
  });

  it('has() returns true for existing chunks', async () => {
    const store = new IndexedDBChunkStore({ dbName: freshDbName() });
    await store.save('abc', new Uint8Array([1]));
    assert.ok(await store.has('abc'));
    assert.ok(!(await store.has('def')));
  });

  it('removes chunks', async () => {
    const store = new IndexedDBChunkStore({ dbName: freshDbName() });
    await store.save('abc', new Uint8Array([1]));
    assert.ok(await store.remove('abc'));
    assert.ok(!(await store.has('abc')));
    assert.equal(store.size, 0);
  });

  it('remove returns false for missing chunks', async () => {
    const store = new IndexedDBChunkStore({ dbName: freshDbName() });
    assert.ok(!(await store.remove('nope')));
  });

  it('clears all chunks', async () => {
    const store = new IndexedDBChunkStore({ dbName: freshDbName() });
    await store.save('a', new Uint8Array([1]));
    await store.save('b', new Uint8Array([2]));
    await store.clear();
    assert.equal(store.size, 0);
    assert.equal(await store.get('a'), undefined);
  });

  it('computeCid returns 64-char hex string', async () => {
    const cid = await IndexedDBChunkStore.computeCid(new Uint8Array([1, 2, 3]));
    assert.equal(typeof cid, 'string');
    assert.equal(cid.length, 64);
    assert.match(cid, /^[0-9a-f]{64}$/);
  });

  it('computeCid is byte-for-byte identical to ChunkStore.computeCid (same SHA-256 algorithm)', async () => {
    const data = new Uint8Array([10, 20, 30, 40, 50]);
    const indexedDbCid = await IndexedDBChunkStore.computeCid(data);
    const memoryCid = await ChunkStore.computeCid(data);
    assert.equal(indexedDbCid, memoryCid);
  });

  it('verify returns true for matching data', async () => {
    const store = new IndexedDBChunkStore({ dbName: freshDbName() });
    const data = new Uint8Array([42, 43, 44]);
    const cid = await IndexedDBChunkStore.computeCid(data);
    assert.ok(await store.verify(cid, data));
  });

  it('verify returns false for mismatched data', async () => {
    const store = new IndexedDBChunkStore({ dbName: freshDbName() });
    const data = new Uint8Array([42]);
    const cid = await IndexedDBChunkStore.computeCid(data);
    assert.ok(!(await store.verify(cid, new Uint8Array([99]))));
  });

  it('close() is safe to call without opening', () => {
    const store = new IndexedDBChunkStore();
    store.close(); // should not throw
  });

  it('separate dbName/storeName configs do not collide', async () => {
    const a = new IndexedDBChunkStore({ dbName: freshDbName(), storeName: 'chunks' });
    const b = new IndexedDBChunkStore({ dbName: freshDbName(), storeName: 'chunks' });
    await a.save('x', new Uint8Array([1]));
    await b.save('x', new Uint8Array([2]));
    assert.deepEqual(await a.get('x'), new Uint8Array([1]));
    assert.deepEqual(await b.get('x'), new Uint8Array([2]));
  });

  // ── The actual persistence proof the plan cares about ──────────────────
  //
  // A completely fresh IndexedDBChunkStore instance (no shared in-memory
  // state) pointed at the same dbName/storeName after a simulated "reload"
  // must be able to `get()` data saved by a previous instance. This is the
  // property the in-memory ChunkStore fundamentally cannot have — a Map
  // does not survive a page reload — and is the entire point of this class.
  it('survives a reload: a fresh instance pointed at the same DB sees data saved by a prior instance', async () => {
    const dbName = freshDbName();
    const storeName = 'chunks';
    const data = new Uint8Array([7, 8, 9, 10, 11]);
    const cid = await IndexedDBChunkStore.computeCid(data);

    const before = new IndexedDBChunkStore({ dbName, storeName });
    await before.save(cid, data);
    before.close();

    // Simulate a reload: brand new instance, nothing carried over except
    // the dbName/storeName configuration.
    const after = new IndexedDBChunkStore({ dbName, storeName });
    assert.ok(await after.has(cid));
    assert.deepEqual(await after.get(cid), data);
    assert.ok(await after.verify(cid, await after.get(cid)));
  });

  it('survives a reload across multiple chunks and a removal', async () => {
    const dbName = freshDbName();

    const before = new IndexedDBChunkStore({ dbName });
    const dataA = new Uint8Array([1, 1, 1]);
    const dataB = new Uint8Array([2, 2, 2]);
    const cidA = await IndexedDBChunkStore.computeCid(dataA);
    const cidB = await IndexedDBChunkStore.computeCid(dataB);
    await before.save(cidA, dataA);
    await before.save(cidB, dataB);
    await before.remove(cidA);
    before.close();

    const after = new IndexedDBChunkStore({ dbName });
    assert.equal(await after.has(cidA), false);
    assert.deepEqual(await after.get(cidB), dataB);
    // size is populated lazily from real storage the first time an
    // operation is awaited (see class doc comment) — by this point it has.
    assert.equal(after.size, 1);
  });
});

// ── Drop-in compatibility: both stores satisfy the identical contract ─────
//
// A shared assertion suite run against both ChunkStore (in-memory) and
// IndexedDBChunkStore (IndexedDB-backed) proves the two are interchangeable
// from a caller's point of view, protecting anyone who swaps one for the
// other later (e.g. the mesh-native CloudStorage plan's Phase B).
//
// Every call is `await`ed, which works for both: ChunkStore's methods are
// synchronous (awaiting a non-Promise value just resolves immediately) and
// IndexedDBChunkStore's are necessarily asynchronous (see the class-level
// doc comment in storage-indexeddb-chunks.mjs for why that's unavoidable).
async function runChunkStoreContract(t, makeStore) {
  await t.test('starts empty', async () => {
    const store = makeStore();
    assert.equal(store.size, 0);
  });

  await t.test('save/get round-trips bytes', async () => {
    const store = makeStore();
    const data = new Uint8Array([5, 6, 7]);
    await store.save('cid-1', data);
    assert.deepEqual(await store.get('cid-1'), data);
    assert.equal(store.size, 1);
  });

  await t.test('get returns undefined for a missing key', async () => {
    const store = makeStore();
    assert.equal(await store.get('missing'), undefined);
  });

  await t.test('has() reflects presence', async () => {
    const store = makeStore();
    await store.save('cid-1', new Uint8Array([1]));
    assert.equal(await store.has('cid-1'), true);
    assert.equal(await store.has('cid-2'), false);
  });

  await t.test('remove() deletes and reports prior existence', async () => {
    const store = makeStore();
    await store.save('cid-1', new Uint8Array([1]));
    assert.equal(await store.remove('cid-1'), true);
    assert.equal(await store.has('cid-1'), false);
    assert.equal(await store.remove('cid-1'), false);
  });

  await t.test('verify() checks data against a real CID', async () => {
    const store = makeStore();
    const data = new Uint8Array([9, 9, 9]);
    const cid = await store.constructor.computeCid(data);
    assert.equal(await store.verify(cid, data), true);
    assert.equal(await store.verify(cid, new Uint8Array([1])), false);
  });

  await t.test('clear() empties the store', async () => {
    const store = makeStore();
    await store.save('cid-1', new Uint8Array([1]));
    await store.save('cid-2', new Uint8Array([2]));
    await store.clear();
    assert.equal(store.size, 0);
  });

  await t.test('computeCid is deterministic and content-sensitive', async () => {
    const StoreClass = makeStore().constructor;
    const data = new Uint8Array([1, 2, 3]);
    const cid1 = await StoreClass.computeCid(data);
    const cid2 = await StoreClass.computeCid(data);
    assert.equal(cid1, cid2);
    const cid3 = await StoreClass.computeCid(new Uint8Array([4, 5, 6]));
    assert.notEqual(cid1, cid3);
  });
}

describe('ChunkStore/IndexedDBChunkStore drop-in contract compatibility', () => {
  it('ChunkStore satisfies the shared chunk-store contract', async (t) => {
    await runChunkStoreContract(t, () => new ChunkStore());
  });

  it('IndexedDBChunkStore satisfies the shared chunk-store contract', async (t) => {
    await runChunkStoreContract(t, () => new IndexedDBChunkStore({ dbName: freshDbName() }));
  });
});
