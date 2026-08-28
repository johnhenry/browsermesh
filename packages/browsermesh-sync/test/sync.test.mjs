// Run with: node --import ./test/_setup-globals.mjs --test test/sync.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SyncDocument, MeshSyncEngine, InMemorySyncStorage, CRDT_TYPES } from '../src/sync.mjs';

import {
  VectorClock, LWWRegister, GCounter, PNCounter, ORSet, RGA, LWWMap,
} from '@johnhenry/browsermesh-primitives';

// ── 1. CRDT_TYPES ────────────────────────────────────────────────────────────

describe('CRDT_TYPES', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(CRDT_TYPES));
  });

  it('has exactly 6 expected entries', () => {
    assert.equal(CRDT_TYPES.length, 6);
    for (const t of ['lww-register', 'g-counter', 'pn-counter', 'or-set', 'rga', 'lww-map']) {
      assert.ok(CRDT_TYPES.includes(t), `missing: ${t}`);
    }
  });
});

// ── 2. InMemorySyncStorage ───────────────────────────────────────────────────

describe('InMemorySyncStorage', () => {
  let storage;
  beforeEach(() => { storage = new InMemorySyncStorage(); });

  it('save/load round-trip preserves data', async () => {
    const data = [{ id: 'a', val: 1 }, { id: 'b', val: 2 }];
    await storage.save(data);
    assert.deepEqual(await storage.load(), data);
  });

  it('load returns null initially', async () => {
    assert.equal(await storage.load(), null);
  });

  it('clear resets to null', async () => {
    await storage.save([{ x: 1 }]);
    await storage.clear();
    assert.equal(await storage.load(), null);
  });

  it('save deep-clones so mutations do not leak', async () => {
    const original = [{ nested: { x: 1 } }];
    await storage.save(original);
    original[0].nested.x = 999;
    assert.equal((await storage.load())[0].nested.x, 1);
  });
});

// ── 3. SyncDocument ──────────────────────────────────────────────────────────

describe('SyncDocument', () => {
  it('constructor sets all provided fields', () => {
    const crdt = new LWWMap();
    const version = new VectorClock();
    const now = Date.now();
    const doc = new SyncDocument({
      id: 'doc1', type: 'lww-map', owner: 'nodeA', crdt,
      version, created: now, lastModified: now, acl: ['nodeB'],
    });
    assert.equal(doc.id, 'doc1');
    assert.equal(doc.type, 'lww-map');
    assert.equal(doc.owner, 'nodeA');
    assert.equal(doc.crdt, crdt);
    assert.equal(doc.version, version);
    assert.deepEqual(doc.acl, ['nodeB']);
  });

  it('constructor defaults optional fields', () => {
    const doc = new SyncDocument({ id: 'd', type: 'g-counter', owner: 'n', crdt: new GCounter() });
    assert.ok(doc.version instanceof VectorClock);
    assert.equal(typeof doc.created, 'number');
    assert.equal(doc.lastModified, doc.created);
    assert.deepEqual(doc.acl, []);
  });

  it('toJSON returns a JSON-serializable plain object', () => {
    const crdt = new GCounter();
    crdt.increment('n1', 5);
    const doc = new SyncDocument({ id: 'g1', type: 'g-counter', owner: 'n1', crdt });
    const json = doc.toJSON();
    assert.equal(json.id, 'g1');
    assert.deepEqual(json.crdt, { n1: 5 });
    assert.doesNotThrow(() => JSON.stringify(json));
  });

  it('fromJSON round-trips LWWRegister, GCounter, PNCounter', () => {
    // LWWRegister
    const r = new SyncDocument({ id: 'r1', type: 'lww-register', owner: 'n1', crdt: new LWWRegister('hi', 100, 'n1') });
    assert.equal(SyncDocument.fromJSON(r.toJSON()).crdt.value, 'hi');

    // GCounter
    const gc = new GCounter(); gc.increment('n1', 7);
    assert.equal(SyncDocument.fromJSON(new SyncDocument({ id: 'gc', type: 'g-counter', owner: 'n1', crdt: gc }).toJSON()).crdt.value, 7);

    // PNCounter
    const pn = new PNCounter(); pn.increment('n1', 10); pn.decrement('n1', 3);
    assert.equal(SyncDocument.fromJSON(new SyncDocument({ id: 'pn', type: 'pn-counter', owner: 'n1', crdt: pn }).toJSON()).crdt.value, 7);
  });

  it('fromJSON round-trips ORSet, RGA, LWWMap', () => {
    // ORSet
    const os = new ORSet(); os.add('a', 'n1'); os.add('b', 'n1');
    const restoredOs = SyncDocument.fromJSON(new SyncDocument({ id: 'os', type: 'or-set', owner: 'n1', crdt: os }).toJSON());
    assert.ok(restoredOs.crdt.has('a'));
    assert.ok(restoredOs.crdt.has('b'));

    // RGA
    const rga = new RGA(); rga.insertAt(0, 'x', 'n1'); rga.insertAt(1, 'y', 'n1');
    assert.deepEqual(SyncDocument.fromJSON(new SyncDocument({ id: 'rg', type: 'rga', owner: 'n1', crdt: rga }).toJSON()).crdt.value, ['x', 'y']);

    // LWWMap
    const lm = new LWWMap(); lm.set('k', 'v', 100, 'n1');
    assert.equal(SyncDocument.fromJSON(new SyncDocument({ id: 'lm', type: 'lww-map', owner: 'n1', crdt: lm }).toJSON()).crdt.get('k'), 'v');
  });

  it('fromJSON throws on unknown type', () => {
    assert.throws(() => SyncDocument.fromJSON({
      id: 'bad', type: 'quantum-set', owner: 'n1',
      crdt: {}, version: {}, created: 1, lastModified: 1, acl: [],
    }), /Unknown CRDT type/);
  });
});

// ── MeshSyncEngine ───────────────────────────────────────────────────────────

describe('MeshSyncEngine', () => {
  /** @type {MeshSyncEngine} */
  let engine;

  beforeEach(() => {
    engine = new MeshSyncEngine({ nodeId: 'test_node', storage: new InMemorySyncStorage() });
  });

  // ── 4. create() ──────────────────────────────────────────────────────────

  describe('create()', () => {
    it('creates a doc for each CRDT type', () => {
      for (const type of CRDT_TYPES) {
        const doc = engine.create(`doc-${type}`, type);
        assert.equal(doc.type, type);
        assert.equal(doc.owner, 'test_node');
      }
    });

    it('rejects unknown type', () => {
      assert.throws(() => engine.create('bad', 'fizz-buzz'), /Unknown CRDT type/);
    });

    it('rejects duplicate id', () => {
      engine.create('dup', 'g-counter');
      assert.throws(() => engine.create('dup', 'g-counter'), /already exists/);
    });

    it('accepts owner and acl options', () => {
      const doc = engine.create('o1', 'g-counter', { owner: 'custom', acl: ['peer'] });
      assert.equal(doc.owner, 'custom');
      assert.deepEqual(doc.acl, ['peer']);
    });
  });

  // ── 5. get() ─────────────────────────────────────────────────────────────

  describe('get()', () => {
    it('returns the created document', () => {
      const created = engine.create('g1', 'g-counter');
      assert.equal(engine.get('g1'), created);
    });

    it('returns null for unknown id', () => {
      assert.equal(engine.get('nope'), null);
    });
  });

  // ── 6. getState() ────────────────────────────────────────────────────────

  describe('getState()', () => {
    it('returns scalar values for register/counter types', () => {
      engine.create('gc', 'g-counter');
      engine.update('gc', (c) => c.increment('test_node', 42));
      assert.equal(engine.getState('gc'), 42);

      engine.create('pn', 'pn-counter');
      engine.update('pn', (c) => { c.increment('test_node', 10); c.decrement('test_node', 3); });
      assert.equal(engine.getState('pn'), 7);

      engine.create('reg', 'lww-register');
      engine.update('reg', (c) => c.set('hello', Date.now(), 'test_node'));
      assert.equal(engine.getState('reg'), 'hello');
    });

    it('returns ORSet as a Set, RGA as an array, LWWMap as an object', () => {
      engine.create('os', 'or-set');
      engine.update('os', (c) => { c.add('a', 'n'); c.add('b', 'n'); });
      assert.ok(engine.getState('os') instanceof Set);
      assert.equal(engine.getState('os').size, 2);

      engine.create('rga', 'rga');
      engine.update('rga', (c) => { c.insertAt(0, 'x', 'n'); c.insertAt(1, 'y', 'n'); });
      assert.deepEqual(engine.getState('rga'), ['x', 'y']);

      engine.create('lm', 'lww-map');
      engine.update('lm', (c) => c.set('k', 'v', Date.now(), 'n'));
      assert.deepEqual(engine.getState('lm'), { k: 'v' });
    });

    it('returns null for unknown doc', () => {
      assert.equal(engine.getState('ghost'), null);
    });
  });

  // ── 7. update() ──────────────────────────────────────────────────────────

  describe('update()', () => {
    it('applies mutation to CRDT state', () => {
      engine.create('gc', 'g-counter');
      engine.update('gc', (c) => c.increment('test_node', 5));
      assert.equal(engine.getState('gc'), 5);
    });

    it('increments version clock', () => {
      engine.create('gc', 'g-counter');
      const doc = engine.get('gc');
      const before = doc.version.get('test_node');
      engine.update('gc', (c) => c.increment('test_node', 1));
      assert.equal(doc.version.get('test_node'), before + 1);
    });

    it('notifies subscribers with current value', () => {
      engine.create('gc', 'g-counter');
      let received = null;
      engine.subscribe('gc', (val) => { received = val; });
      engine.update('gc', (c) => c.increment('test_node', 3));
      assert.equal(received, 3);
    });

    it('throws for unknown doc', () => {
      assert.throws(() => engine.update('nope', () => {}), /not found/);
    });

    it('updates lastModified timestamp', () => {
      engine.create('gc', 'g-counter');
      const before = engine.get('gc').lastModified;
      engine.update('gc', (c) => c.increment('test_node', 1));
      assert.ok(engine.get('gc').lastModified >= before);
    });
  });

  // ── 8. merge() ───────────────────────────────────────────────────────────

  describe('merge()', () => {
    it('merges remote GCounter and returns {conflicts: 0}', () => {
      engine.create('gc', 'g-counter');
      engine.update('gc', (c) => c.increment('test_node', 5));
      const remote = new GCounter();
      remote.increment('remote_node', 10);
      const result = engine.merge('gc', {
        crdt: remote.toJSON(),
        version: new VectorClock().increment('remote_node').toJSON(),
      });
      assert.deepEqual(result, { conflicts: 0 });
      assert.equal(engine.getState('gc'), 15);
    });

    it('merges version clocks and notifies subscribers', () => {
      engine.create('gc', 'g-counter');
      engine.update('gc', (c) => c.increment('test_node', 1));
      let notified = false;
      engine.subscribe('gc', () => { notified = true; });

      const rv = new VectorClock();
      rv.increment('remote'); rv.increment('remote');
      engine.merge('gc', { crdt: new GCounter().toJSON(), version: rv.toJSON() });

      const doc = engine.get('gc');
      assert.equal(doc.version.get('test_node'), 1);
      assert.equal(doc.version.get('remote'), 2);
      assert.ok(notified);
    });

    it('throws for unknown doc', () => {
      assert.throws(() => engine.merge('nope', { crdt: {}, version: {} }), /not found/);
    });
  });

  // ── 9. subscribe() ──────────────────────────────────────────────────────

  describe('subscribe()', () => {
    it('callback fires on each update with current value', () => {
      engine.create('gc', 'g-counter');
      const values = [];
      engine.subscribe('gc', (v) => values.push(v));
      engine.update('gc', (c) => c.increment('test_node', 1));
      engine.update('gc', (c) => c.increment('test_node', 2));
      assert.deepEqual(values, [1, 3]);
    });

    it('returns an unsubscribe function', () => {
      engine.create('gc', 'g-counter');
      let count = 0;
      const unsub = engine.subscribe('gc', () => { count++; });
      engine.update('gc', (c) => c.increment('test_node', 1));
      assert.equal(count, 1);
      unsub();
      engine.update('gc', (c) => c.increment('test_node', 1));
      assert.equal(count, 1);
    });

    it('subscriber errors do not propagate', () => {
      engine.create('gc', 'g-counter');
      let secondCalled = false;
      engine.subscribe('gc', () => { throw new Error('boom'); });
      engine.subscribe('gc', () => { secondCalled = true; });
      assert.doesNotThrow(() => engine.update('gc', (c) => c.increment('test_node', 1)));
      assert.ok(secondCalled);
    });
  });

  // ── 10. delete() ─────────────────────────────────────────────────────────

  describe('delete()', () => {
    it('removes doc, returns true, and nullifies get()', () => {
      engine.create('gc', 'g-counter');
      assert.equal(engine.delete('gc'), true);
      assert.equal(engine.get('gc'), null);
      assert.equal(engine.size, 0);
    });

    it('returns false for unknown doc', () => {
      assert.equal(engine.delete('nope'), false);
    });

    it('clears subscriptions so old callbacks do not fire on re-create', () => {
      engine.create('gc', 'g-counter');
      let called = false;
      engine.subscribe('gc', () => { called = true; });
      engine.delete('gc');
      engine.create('gc', 'g-counter');
      engine.update('gc', (c) => c.increment('test_node', 1));
      assert.equal(called, false);
    });
  });

  // ── 11. listDocuments() ──────────────────────────────────────────────────

  describe('listDocuments()', () => {
    it('returns metadata array for all docs', () => {
      engine.create('a', 'g-counter');
      engine.create('b', 'lww-map');
      const list = engine.listDocuments();
      assert.equal(list.length, 2);
      assert.deepEqual(list.map(d => d.id).sort(), ['a', 'b']);
      const m = list.find(d => d.id === 'b');
      assert.equal(m.type, 'lww-map');
      assert.equal(m.owner, 'test_node');
      assert.equal(typeof m.lastModified, 'number');
    });

    it('returns empty array when no docs exist', () => {
      assert.deepEqual(engine.listDocuments(), []);
    });
  });

  // ── 12. prepareSyncPayload() ─────────────────────────────────────────────

  describe('prepareSyncPayload()', () => {
    it('returns serializable payload with id, type, crdt, version', () => {
      engine.create('gc', 'g-counter');
      engine.update('gc', (c) => c.increment('test_node', 7));
      const payload = engine.prepareSyncPayload('gc');
      assert.equal(payload.id, 'gc');
      assert.equal(payload.type, 'g-counter');
      assert.deepEqual(payload.crdt, { test_node: 7 });
      assert.ok(payload.version);
      assert.doesNotThrow(() => JSON.stringify(payload));
    });

    it('returns null for unknown doc', () => {
      assert.equal(engine.prepareSyncPayload('nope'), null);
    });
  });

  // ── 13. save() / load() ──────────────────────────────────────────────────

  describe('save() / load()', () => {
    it('persists and restores documents across engine instances', async () => {
      const shared = new InMemorySyncStorage();
      const eA = new MeshSyncEngine({ nodeId: 'n1', storage: shared });
      eA.create('counter', 'g-counter');
      eA.update('counter', (c) => c.increment('n1', 10));
      eA.create('map', 'lww-map');
      eA.update('map', (c) => c.set('color', 'blue', 1, 'n1'));
      await eA.save();

      const eB = new MeshSyncEngine({ nodeId: 'n2', storage: shared });
      await eB.load();
      assert.equal(eB.size, 2);
      assert.equal(eB.getState('counter'), 10);
      assert.deepEqual(eB.getState('map'), { color: 'blue' });

      eA.destroy();
      eB.destroy();
    });

    it('load is a no-op when storage is empty', async () => {
      const eng = new MeshSyncEngine({ nodeId: 'n1', storage: new InMemorySyncStorage() });
      await eng.load();
      assert.equal(eng.size, 0);
      eng.destroy();
    });

    it('load skips corrupt entries and logs errors', async () => {
      const storage = new InMemorySyncStorage();
      await storage.save([
        { id: 'good', type: 'g-counter', owner: 'n1', crdt: { n1: 5 }, version: {}, created: 1, lastModified: 1, acl: [] },
        { id: 'bad', type: 'nonexistent-type', owner: 'n1', crdt: {}, version: {}, created: 1, lastModified: 1, acl: [] },
      ]);
      const logs = [];
      const eng = new MeshSyncEngine({ nodeId: 'n1', storage, onLog: (_l, m) => logs.push(m) });
      await eng.load();
      assert.equal(eng.size, 1);
      assert.equal(eng.getState('good'), 5);
      assert.ok(logs.some(m => m.includes('bad')));
      eng.destroy();
    });
  });

  // ── 14. startAutoSync / stopAutoSync / stopAllAutoSync ───────────────────

  describe('autoSync', () => {
    it('startAutoSync calls syncFn periodically', async () => {
      engine.create('gc', 'g-counter');
      engine.update('gc', (c) => c.increment('test_node', 1));
      const payloads = [];
      engine.startAutoSync('gc', (p) => payloads.push(p), 50);
      await new Promise(r => setTimeout(r, 250));
      engine.stopAutoSync('gc');
      assert.ok(payloads.length >= 2, `expected >=2, got ${payloads.length}`);
      assert.equal(payloads[0].id, 'gc');
    });

    it('startAutoSync returns a stopper function', async () => {
      engine.create('gc', 'g-counter');
      const payloads = [];
      const stop = engine.startAutoSync('gc', (p) => payloads.push(p), 30);
      assert.equal(typeof stop, 'function');
      stop();
      await new Promise(r => setTimeout(r, 80));
      assert.equal(payloads.length, 0);
    });

    it('stopAutoSync is safe when no sync is running', () => {
      assert.doesNotThrow(() => engine.stopAutoSync('nonexistent'));
    });

    it('stopAllAutoSync stops all intervals', async () => {
      engine.create('a', 'g-counter');
      engine.create('b', 'g-counter');
      const pA = [], pB = [];
      engine.startAutoSync('a', (p) => pA.push(p), 30);
      engine.startAutoSync('b', (p) => pB.push(p), 30);
      engine.stopAllAutoSync();
      await new Promise(r => setTimeout(r, 80));
      assert.equal(pA.length, 0);
      assert.equal(pB.length, 0);
    });
  });

  // ── 15. destroy() ────────────────────────────────────────────────────────

  describe('destroy()', () => {
    it('stops auto-sync intervals and clears subscriptions', async () => {
      engine.create('gc', 'g-counter');
      const payloads = [];
      engine.startAutoSync('gc', (p) => payloads.push(p), 30);
      engine.destroy();
      await new Promise(r => setTimeout(r, 80));
      assert.equal(payloads.length, 0);
    });
  });

  // ── 16. Two-engine sync ──────────────────────────────────────────────────

  describe('two-engine sync', () => {
    it('syncs a GCounter between two engines via payloads', () => {
      const eA = new MeshSyncEngine({ nodeId: 'A' });
      const eB = new MeshSyncEngine({ nodeId: 'B' });

      eA.create('counter', 'g-counter');
      eB.create('counter', 'g-counter');

      eA.update('counter', (c) => c.increment('A', 5));
      eB.update('counter', (c) => c.increment('B', 3));

      eB.merge('counter', eA.prepareSyncPayload('counter'));
      eA.merge('counter', eB.prepareSyncPayload('counter'));

      assert.equal(eA.getState('counter'), 8);
      assert.equal(eB.getState('counter'), 8);

      eA.destroy();
      eB.destroy();
    });

    it('syncs an LWWMap and PNCounter between two engines', () => {
      const eA = new MeshSyncEngine({ nodeId: 'A' });
      const eB = new MeshSyncEngine({ nodeId: 'B' });

      // LWWMap
      eA.create('config', 'lww-map');
      eB.create('config', 'lww-map');
      eA.update('config', (c) => c.set('theme', 'dark', 100, 'A'));
      eB.update('config', (c) => c.set('lang', 'en', 200, 'B'));
      eB.merge('config', eA.prepareSyncPayload('config'));
      eA.merge('config', eB.prepareSyncPayload('config'));
      assert.deepEqual(eA.getState('config'), { theme: 'dark', lang: 'en' });
      assert.deepEqual(eB.getState('config'), { theme: 'dark', lang: 'en' });

      // PNCounter
      eA.create('votes', 'pn-counter');
      eB.create('votes', 'pn-counter');
      eA.update('votes', (c) => c.increment('A', 10));
      eB.update('votes', (c) => c.decrement('B', 4));
      eB.merge('votes', eA.prepareSyncPayload('votes'));
      eA.merge('votes', eB.prepareSyncPayload('votes'));
      assert.equal(eA.getState('votes'), 6);
      assert.equal(eB.getState('votes'), 6);

      eA.destroy();
      eB.destroy();
    });
  });

  // ── Misc ─────────────────────────────────────────────────────────────────

  describe('nodeId / size', () => {
    it('nodeId is set from option or defaults to generated string', () => {
      assert.equal(engine.nodeId, 'test_node');
      const e = new MeshSyncEngine();
      assert.ok(e.nodeId.startsWith('node_'));
      e.destroy();
    });

    it('size tracks document count', () => {
      assert.equal(engine.size, 0);
      engine.create('a', 'g-counter');
      assert.equal(engine.size, 1);
      engine.delete('a');
      assert.equal(engine.size, 0);
    });
  });
});
