import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  VectorClock,
  LWWRegister,
  GCounter,
  PNCounter,
  ORSet,
  RGA,
  LWWMap,
} from '../src/crdt.mjs';

// ── VectorClock ─────────────────────────────────────────────────────────────

describe('VectorClock', () => {
  it('starts empty with get returning 0', () => {
    const vc = new VectorClock();
    assert.equal(vc.get('A'), 0);
    assert.equal(vc.get('B'), 0);
  });

  it('increment increases counter for a node', () => {
    const vc = new VectorClock();
    vc.increment('A');
    assert.equal(vc.get('A'), 1);
    vc.increment('A');
    assert.equal(vc.get('A'), 2);
  });

  it('increment returns this for chaining', () => {
    const vc = new VectorClock();
    const result = vc.increment('A');
    assert.equal(result, vc);
  });

  it('tracks multiple nodes independently', () => {
    const vc = new VectorClock();
    vc.increment('A').increment('A').increment('B');
    assert.equal(vc.get('A'), 2);
    assert.equal(vc.get('B'), 1);
    assert.equal(vc.get('C'), 0);
  });

  it('merge takes max of each entry', () => {
    const a = new VectorClock();
    a.increment('A').increment('A').increment('B');
    const b = new VectorClock();
    b.increment('A').increment('B').increment('B').increment('C');

    const merged = a.merge(b);
    assert.equal(merged.get('A'), 2); // max(2,1)
    assert.equal(merged.get('B'), 2); // max(1,2)
    assert.equal(merged.get('C'), 1); // max(0,1)
  });

  it('merge returns a new VectorClock', () => {
    const a = new VectorClock();
    const b = new VectorClock();
    const merged = a.merge(b);
    assert.notEqual(merged, a);
    assert.notEqual(merged, b);
  });

  it('compare returns equal for identical clocks', () => {
    const a = new VectorClock();
    a.increment('A');
    const b = new VectorClock();
    b.increment('A');
    assert.equal(a.compare(b), 'equal');
  });

  it('compare returns equal for two empty clocks', () => {
    assert.equal(new VectorClock().compare(new VectorClock()), 'equal');
  });

  it('compare returns before when all <= and at least one <', () => {
    const a = new VectorClock();
    a.increment('A');
    const b = new VectorClock();
    b.increment('A').increment('A').increment('B');
    assert.equal(a.compare(b), 'before');
  });

  it('compare returns after when all >= and at least one >', () => {
    const a = new VectorClock();
    a.increment('A').increment('A').increment('B');
    const b = new VectorClock();
    b.increment('A');
    assert.equal(a.compare(b), 'after');
  });

  it('compare returns concurrent when some less and some greater', () => {
    const a = new VectorClock();
    a.increment('A').increment('A');
    const b = new VectorClock();
    b.increment('B').increment('B');
    assert.equal(a.compare(b), 'concurrent');
  });

  it('toJSON and fromJSON round-trip', () => {
    const vc = new VectorClock();
    vc.increment('A').increment('A').increment('B');
    const json = vc.toJSON();
    assert.deepEqual(json, { A: 2, B: 1 });

    const restored = VectorClock.fromJSON(json);
    assert.equal(restored.get('A'), 2);
    assert.equal(restored.get('B'), 1);
    assert.equal(restored.compare(vc), 'equal');
  });
});

// ── LWWRegister ─────────────────────────────────────────────────────────────

describe('LWWRegister', () => {
  it('has null initial value by default', () => {
    const reg = new LWWRegister();
    assert.equal(reg.value, null);
  });

  it('stores initial value from constructor', () => {
    const reg = new LWWRegister('hello', 1, 'A');
    assert.equal(reg.value, 'hello');
  });

  it('set updates value with newer timestamp', () => {
    const reg = new LWWRegister('old', 1, 'A');
    reg.set('new', 2, 'A');
    assert.equal(reg.value, 'new');
  });

  it('set ignores value with older timestamp', () => {
    const reg = new LWWRegister('current', 5, 'A');
    reg.set('old', 3, 'A');
    assert.equal(reg.value, 'current');
  });

  it('set uses nodeId tiebreak on same timestamp (higher nodeId wins)', () => {
    const reg = new LWWRegister('fromA', 5, 'A');
    reg.set('fromB', 5, 'B');
    assert.equal(reg.value, 'fromB'); // 'B' > 'A'
  });

  it('set ignores lower nodeId on same timestamp', () => {
    const reg = new LWWRegister('fromZ', 5, 'Z');
    reg.set('fromA', 5, 'A');
    assert.equal(reg.value, 'fromZ'); // 'A' < 'Z'
  });

  it('merge keeps the latest value', () => {
    const a = new LWWRegister('a-val', 3, 'A');
    const b = new LWWRegister('b-val', 5, 'B');
    const merged = a.merge(b);
    assert.equal(merged.value, 'b-val');
  });

  it('merge uses nodeId tiebreak when timestamps match', () => {
    const a = new LWWRegister('a-val', 5, 'A');
    const b = new LWWRegister('b-val', 5, 'B');
    const merged = a.merge(b);
    assert.equal(merged.value, 'b-val');
  });

  it('state returns value, timestamp, and nodeId', () => {
    const reg = new LWWRegister('val', 42, 'node1');
    const s = reg.state();
    assert.deepEqual(s, { value: 'val', timestamp: 42, nodeId: 'node1' });
  });

  it('toJSON and fromJSON round-trip', () => {
    const reg = new LWWRegister({ nested: true }, 100, 'X');
    const json = reg.toJSON();
    const restored = LWWRegister.fromJSON(json);
    assert.deepEqual(restored.value, { nested: true });
    assert.deepEqual(restored.state(), reg.state());
  });
});

// ── GCounter ────────────────────────────────────────────────────────────────

describe('GCounter', () => {
  it('starts at value 0', () => {
    const c = new GCounter();
    assert.equal(c.value, 0);
  });

  it('increment increases value by 1 by default', () => {
    const c = new GCounter();
    c.increment('A');
    assert.equal(c.value, 1);
  });

  it('increment increases value by specified amount', () => {
    const c = new GCounter();
    c.increment('A', 5);
    assert.equal(c.value, 5);
  });

  it('tracks multiple nodes independently', () => {
    const c = new GCounter();
    c.increment('A', 3);
    c.increment('B', 7);
    assert.equal(c.value, 10);
  });

  it('increment is additive for the same node', () => {
    const c = new GCounter();
    c.increment('A', 3);
    c.increment('A', 2);
    assert.equal(c.value, 5);
  });

  it('rejects negative increments', () => {
    const c = new GCounter();
    assert.throws(() => c.increment('A', -1), RangeError);
  });

  it('merge takes max per node', () => {
    const a = new GCounter();
    a.increment('A', 5);
    a.increment('B', 3);

    const b = new GCounter();
    b.increment('A', 2);
    b.increment('B', 7);
    b.increment('C', 4);

    const merged = a.merge(b);
    assert.equal(merged.value, 16); // max(5,2) + max(3,7) + max(0,4) = 5+7+4
  });

  it('merge returns a new GCounter', () => {
    const a = new GCounter();
    const b = new GCounter();
    const merged = a.merge(b);
    assert.notEqual(merged, a);
    assert.notEqual(merged, b);
  });

  it('state returns a Map copy', () => {
    const c = new GCounter();
    c.increment('A', 3);
    const s = c.state();
    assert.ok(s instanceof Map);
    assert.equal(s.get('A'), 3);
    // Mutating returned state should not affect original
    s.set('A', 999);
    assert.equal(c.value, 3);
  });

  it('toJSON and fromJSON round-trip', () => {
    const c = new GCounter();
    c.increment('A', 5);
    c.increment('B', 3);
    const json = c.toJSON();
    assert.deepEqual(json, { A: 5, B: 3 });
    const restored = GCounter.fromJSON(json);
    assert.equal(restored.value, 8);
  });
});

// ── PNCounter ───────────────────────────────────────────────────────────────

describe('PNCounter', () => {
  it('starts at value 0', () => {
    const c = new PNCounter();
    assert.equal(c.value, 0);
  });

  it('increment increases value', () => {
    const c = new PNCounter();
    c.increment('A', 5);
    assert.equal(c.value, 5);
  });

  it('decrement decreases value', () => {
    const c = new PNCounter();
    c.increment('A', 10);
    c.decrement('A', 3);
    assert.equal(c.value, 7);
  });

  it('allows negative result', () => {
    const c = new PNCounter();
    c.increment('A', 2);
    c.decrement('A', 5);
    assert.equal(c.value, -3);
  });

  it('tracks multiple nodes', () => {
    const c = new PNCounter();
    c.increment('A', 10);
    c.increment('B', 5);
    c.decrement('A', 3);
    c.decrement('B', 2);
    assert.equal(c.value, 10); // (10+5) - (3+2)
  });

  it('merge combines pos and neg counters', () => {
    const a = new PNCounter();
    a.increment('A', 10);
    a.decrement('A', 2);

    const b = new PNCounter();
    b.increment('A', 6);
    b.increment('B', 4);
    b.decrement('B', 1);

    const merged = a.merge(b);
    // pos: max(10,6) + max(0,4) = 10+4 = 14
    // neg: max(2,0) + max(0,1) = 2+1 = 3
    assert.equal(merged.value, 11);
  });

  it('merge returns a new PNCounter', () => {
    const a = new PNCounter();
    const b = new PNCounter();
    const merged = a.merge(b);
    assert.notEqual(merged, a);
    assert.notEqual(merged, b);
  });

  it('state returns pos and neg GCounters', () => {
    const c = new PNCounter();
    c.increment('A', 5);
    c.decrement('B', 3);
    const s = c.state();
    assert.ok(s.pos instanceof GCounter);
    assert.ok(s.neg instanceof GCounter);
  });

  it('toJSON and fromJSON round-trip', () => {
    const c = new PNCounter();
    c.increment('A', 10);
    c.decrement('B', 3);
    const json = c.toJSON();
    assert.deepEqual(json, { pos: { A: 10 }, neg: { B: 3 } });
    const restored = PNCounter.fromJSON(json);
    assert.equal(restored.value, 7);
  });

  it('default increment/decrement amounts are 1', () => {
    const c = new PNCounter();
    c.increment('A');
    c.decrement('B');
    assert.equal(c.value, 0);
  });
});

// ── ORSet ───────────────────────────────────────────────────────────────────

describe('ORSet', () => {
  it('starts empty', () => {
    const s = new ORSet();
    assert.equal(s.value.size, 0);
  });

  it('add makes element present', () => {
    const s = new ORSet();
    s.add('x', 'A');
    assert.ok(s.has('x'));
    assert.equal(s.value.size, 1);
  });

  it('add multiple elements', () => {
    const s = new ORSet();
    s.add('x', 'A');
    s.add('y', 'A');
    s.add('z', 'B');
    assert.equal(s.value.size, 3);
    assert.ok(s.has('x'));
    assert.ok(s.has('y'));
    assert.ok(s.has('z'));
  });

  it('add same element twice from same node still has it once', () => {
    const s = new ORSet();
    s.add('x', 'A');
    s.add('x', 'A');
    const vals = s.value;
    assert.equal(vals.size, 1);
    assert.ok(vals.has('x'));
  });

  it('remove makes element absent', () => {
    const s = new ORSet();
    s.add('x', 'A');
    assert.ok(s.has('x'));
    s.remove('x');
    assert.ok(!s.has('x'));
    assert.equal(s.value.size, 0);
  });

  it('remove then add (add wins within same replica)', () => {
    const s = new ORSet();
    s.add('x', 'A');
    s.remove('x');
    assert.ok(!s.has('x'));
    s.add('x', 'A');
    assert.ok(s.has('x'));
  });

  it('has returns false for absent element', () => {
    const s = new ORSet();
    assert.ok(!s.has('missing'));
  });

  it('merge combines elements from two sets', () => {
    const a = new ORSet();
    a.add('x', 'A');
    a.add('y', 'A');

    const b = new ORSet();
    b.add('y', 'B');
    b.add('z', 'B');

    const merged = a.merge(b);
    assert.ok(merged.has('x'));
    assert.ok(merged.has('y'));
    assert.ok(merged.has('z'));
    assert.equal(merged.value.size, 3);
  });

  it('merge: concurrent add and remove results in element present (add wins)', () => {
    // Replica A adds 'x'
    const a = new ORSet();
    a.add('x', 'A');

    // Replica B independently adds 'x' then removes it
    const b = new ORSet();
    b.add('x', 'B');
    b.remove('x');

    // After merge, A's add tag survives (not tombstoned by B)
    const merged = a.merge(b);
    assert.ok(merged.has('x'));
  });

  it('merge: element removed on both sides stays removed', () => {
    const a = new ORSet();
    a.add('x', 'A');
    const b = a.merge(new ORSet()); // share state

    // Both remove 'x' (a's tag is tombstoned on both sides)
    a.remove('x');
    // b already has same tag, remove it
    const bState = b.state();
    // Simulate: b also removes x
    const b2 = new ORSet();
    b2._setInternal(bState.elements, bState.tombstones);
    b2.remove('x');

    const merged = a.merge(b2);
    assert.ok(!merged.has('x'));
  });

  it('merge with concurrent adds of same element preserves it', () => {
    const a = new ORSet();
    a.add('x', 'A');

    const b = new ORSet();
    b.add('x', 'B');

    const merged = a.merge(b);
    assert.ok(merged.has('x'));
  });

  it('merge returns a new ORSet', () => {
    const a = new ORSet();
    const b = new ORSet();
    const merged = a.merge(b);
    assert.notEqual(merged, a);
    assert.notEqual(merged, b);
  });

  it('remove of non-existent element is a no-op', () => {
    const s = new ORSet();
    s.remove('missing');
    assert.equal(s.value.size, 0);
  });

  it('value returns a fresh Set', () => {
    const s = new ORSet();
    s.add('x', 'A');
    const v1 = s.value;
    const v2 = s.value;
    assert.notEqual(v1, v2);
    assert.deepEqual(v1, v2);
  });

  it('toJSON and fromJSON round-trip', () => {
    const s = new ORSet();
    s.add('x', 'A');
    s.add('y', 'B');
    s.remove('x');

    const json = s.toJSON();
    const restored = ORSet.fromJSON(json);
    assert.ok(!restored.has('x'));
    assert.ok(restored.has('y'));
  });

  it('fromJSON preserves counter for further adds', () => {
    const s = new ORSet();
    s.add('a', 'A');
    s.add('b', 'A');
    const json = s.toJSON();
    const restored = ORSet.fromJSON(json);
    // Adding more should not collide with existing tags
    restored.add('c', 'A');
    assert.ok(restored.has('a'));
    assert.ok(restored.has('b'));
    assert.ok(restored.has('c'));
    assert.equal(restored.value.size, 3);
  });
});

// ── RGA ─────────────────────────────────────────────────────────────────────

describe('RGA', () => {
  it('starts empty', () => {
    const r = new RGA();
    assert.deepEqual(r.value, []);
    assert.equal(r.length, 0);
  });

  it('insertAt beginning', () => {
    const r = new RGA();
    r.insertAt(0, 'a', 'A');
    assert.deepEqual(r.value, ['a']);
  });

  it('insertAt end', () => {
    const r = new RGA();
    r.insertAt(0, 'a', 'A');
    r.insertAt(1, 'b', 'A');
    assert.deepEqual(r.value, ['a', 'b']);
  });

  it('insertAt middle', () => {
    const r = new RGA();
    r.insertAt(0, 'a', 'A');
    r.insertAt(1, 'c', 'A');
    r.insertAt(1, 'b', 'A');
    assert.deepEqual(r.value, ['a', 'b', 'c']);
  });

  it('insertAt with multiple elements', () => {
    const r = new RGA();
    r.insertAt(0, 'a', 'A');
    r.insertAt(1, 'b', 'A');
    r.insertAt(2, 'c', 'A');
    r.insertAt(3, 'd', 'A');
    assert.deepEqual(r.value, ['a', 'b', 'c', 'd']);
    assert.equal(r.length, 4);
  });

  it('deleteAt removes element', () => {
    const r = new RGA();
    r.insertAt(0, 'a', 'A');
    r.insertAt(1, 'b', 'A');
    r.insertAt(2, 'c', 'A');
    r.deleteAt(1);
    assert.deepEqual(r.value, ['a', 'c']);
    assert.equal(r.length, 2);
  });

  it('deleteAt first element', () => {
    const r = new RGA();
    r.insertAt(0, 'a', 'A');
    r.insertAt(1, 'b', 'A');
    r.deleteAt(0);
    assert.deepEqual(r.value, ['b']);
  });

  it('deleteAt last element', () => {
    const r = new RGA();
    r.insertAt(0, 'a', 'A');
    r.insertAt(1, 'b', 'A');
    r.deleteAt(1);
    assert.deepEqual(r.value, ['a']);
  });

  it('deleteAt throws on out-of-bounds', () => {
    const r = new RGA();
    r.insertAt(0, 'a', 'A');
    assert.throws(() => r.deleteAt(5), RangeError);
  });

  it('value excludes deleted elements', () => {
    const r = new RGA();
    r.insertAt(0, 'a', 'A');
    r.insertAt(1, 'b', 'A');
    r.insertAt(2, 'c', 'A');
    r.deleteAt(0);
    r.deleteAt(0); // now 'b' is at index 0
    assert.deepEqual(r.value, ['c']);
    assert.equal(r.length, 1);
  });

  it('length reflects non-deleted count', () => {
    const r = new RGA();
    r.insertAt(0, 'a', 'A');
    r.insertAt(1, 'b', 'A');
    assert.equal(r.length, 2);
    r.deleteAt(0);
    assert.equal(r.length, 1);
  });

  it('merge two independent RGAs', () => {
    const a = new RGA();
    a.insertAt(0, 'a1', 'A');
    a.insertAt(1, 'a2', 'A');

    const b = new RGA();
    b.insertAt(0, 'b1', 'B');
    b.insertAt(1, 'b2', 'B');

    const merged = a.merge(b);
    // All 4 elements should be present
    assert.equal(merged.length, 4);
    const vals = merged.value;
    assert.ok(vals.includes('a1'));
    assert.ok(vals.includes('a2'));
    assert.ok(vals.includes('b1'));
    assert.ok(vals.includes('b2'));
  });

  it('merge is deterministic (same result regardless of order)', () => {
    const a = new RGA();
    a.insertAt(0, 'x', 'A');

    const b = new RGA();
    b.insertAt(0, 'y', 'B');

    const mergedAB = a.merge(b);
    const mergedBA = b.merge(a);
    assert.deepEqual(mergedAB.value, mergedBA.value);
  });

  it('merge preserves deletions', () => {
    const a = new RGA();
    a.insertAt(0, 'a', 'A');
    a.insertAt(1, 'b', 'A');

    // b gets a copy of a's state via merge, then deletes 'a'
    const b = a.merge(new RGA());
    b.deleteAt(0);

    const merged = a.merge(b);
    // 'a' was deleted by b, 'b' remains
    assert.ok(!merged.value.includes('a'));
    assert.ok(merged.value.includes('b'));
  });

  it('merge with shared history and concurrent inserts', () => {
    // Both start from the same base
    const base = new RGA();
    base.insertAt(0, 'x', 'X');

    // A inserts at position 1
    const a = base.merge(new RGA());
    a.insertAt(1, 'a', 'A');

    // B inserts at position 1
    const b = base.merge(new RGA());
    b.insertAt(1, 'b', 'B');

    const merged = a.merge(b);
    assert.equal(merged.length, 3);
    assert.ok(merged.value.includes('x'));
    assert.ok(merged.value.includes('a'));
    assert.ok(merged.value.includes('b'));
  });

  it('toJSON and fromJSON round-trip', () => {
    const r = new RGA();
    r.insertAt(0, 'a', 'A');
    r.insertAt(1, 'b', 'A');
    r.deleteAt(0);

    const json = r.toJSON();
    const restored = RGA.fromJSON(json);
    assert.deepEqual(restored.value, ['b']);
    assert.equal(restored.length, 1);
  });

  it('fromJSON preserves vclock for further operations', () => {
    const r = new RGA();
    r.insertAt(0, 'a', 'A');
    const json = r.toJSON();
    const restored = RGA.fromJSON(json);
    restored.insertAt(1, 'b', 'A');
    assert.deepEqual(restored.value, ['a', 'b']);
  });
});

// ── LWWMap ──────────────────────────────────────────────────────────────────

describe('LWWMap', () => {
  it('starts empty', () => {
    const m = new LWWMap();
    assert.deepEqual(m.value, {});
    assert.equal(m.size, 0);
  });

  it('set and get a key', () => {
    const m = new LWWMap();
    m.set('name', 'Alice', 1, 'A');
    assert.equal(m.get('name'), 'Alice');
  });

  it('set updates value with newer timestamp', () => {
    const m = new LWWMap();
    m.set('name', 'Alice', 1, 'A');
    m.set('name', 'Bob', 2, 'A');
    assert.equal(m.get('name'), 'Bob');
  });

  it('set ignores older timestamp', () => {
    const m = new LWWMap();
    m.set('name', 'Alice', 5, 'A');
    m.set('name', 'Bob', 3, 'A');
    assert.equal(m.get('name'), 'Alice');
  });

  it('has returns true for existing key', () => {
    const m = new LWWMap();
    m.set('x', 42, 1, 'A');
    assert.ok(m.has('x'));
  });

  it('has returns false for missing key', () => {
    const m = new LWWMap();
    assert.ok(!m.has('x'));
  });

  it('delete makes key absent', () => {
    const m = new LWWMap();
    m.set('x', 42, 1, 'A');
    m.delete('x', 2, 'A');
    assert.ok(!m.has('x'));
    assert.equal(m.get('x'), undefined);
    assert.equal(m.size, 0);
  });

  it('delete is ignored if older than set', () => {
    const m = new LWWMap();
    m.set('x', 42, 5, 'A');
    m.delete('x', 3, 'A');
    assert.ok(m.has('x'));
    assert.equal(m.get('x'), 42);
  });

  it('value excludes tombstoned keys', () => {
    const m = new LWWMap();
    m.set('a', 1, 1, 'A');
    m.set('b', 2, 1, 'A');
    m.delete('a', 2, 'A');
    assert.deepEqual(m.value, { b: 2 });
  });

  it('size counts only live entries', () => {
    const m = new LWWMap();
    m.set('a', 1, 1, 'A');
    m.set('b', 2, 1, 'A');
    m.set('c', 3, 1, 'A');
    assert.equal(m.size, 3);
    m.delete('b', 2, 'A');
    assert.equal(m.size, 2);
  });

  it('keys yields live keys', () => {
    const m = new LWWMap();
    m.set('a', 1, 1, 'A');
    m.set('b', 2, 1, 'A');
    m.delete('a', 2, 'A');
    assert.deepEqual([...m.keys()], ['b']);
  });

  it('values yields live values', () => {
    const m = new LWWMap();
    m.set('a', 1, 1, 'A');
    m.set('b', 2, 1, 'A');
    m.delete('a', 2, 'A');
    assert.deepEqual([...m.values()], [2]);
  });

  it('entries yields live entries', () => {
    const m = new LWWMap();
    m.set('a', 1, 1, 'A');
    m.set('b', 2, 1, 'A');
    m.delete('a', 2, 'A');
    assert.deepEqual([...m.entries()], [['b', 2]]);
  });

  it('merge combines keys from both maps', () => {
    const a = new LWWMap();
    a.set('x', 1, 1, 'A');

    const b = new LWWMap();
    b.set('y', 2, 1, 'B');

    const merged = a.merge(b);
    assert.equal(merged.get('x'), 1);
    assert.equal(merged.get('y'), 2);
    assert.equal(merged.size, 2);
  });

  it('merge resolves conflict by timestamp', () => {
    const a = new LWWMap();
    a.set('x', 'a-val', 3, 'A');

    const b = new LWWMap();
    b.set('x', 'b-val', 5, 'B');

    const merged = a.merge(b);
    assert.equal(merged.get('x'), 'b-val');
  });

  it('merge respects tombstones', () => {
    const a = new LWWMap();
    a.set('x', 42, 1, 'A');

    const b = new LWWMap();
    b.set('x', 42, 1, 'A');
    b.delete('x', 2, 'B');

    const merged = a.merge(b);
    assert.ok(!merged.has('x'));
  });

  it('merge returns a new LWWMap', () => {
    const a = new LWWMap();
    const b = new LWWMap();
    const merged = a.merge(b);
    assert.notEqual(merged, a);
    assert.notEqual(merged, b);
  });

  it('toJSON and fromJSON round-trip', () => {
    const m = new LWWMap();
    m.set('a', 1, 10, 'A');
    m.set('b', 2, 20, 'B');
    m.delete('a', 15, 'B');

    const json = m.toJSON();
    const restored = LWWMap.fromJSON(json);
    assert.ok(!restored.has('a'));
    assert.equal(restored.get('b'), 2);
    assert.equal(restored.size, 1);
  });

  it('toJSON represents tombstones with flag', () => {
    const m = new LWWMap();
    m.set('x', 42, 1, 'A');
    m.delete('x', 2, 'A');
    const json = m.toJSON();
    assert.equal(json.entries.x.tombstone, true);
    assert.equal(json.entries.x.value, null);
  });

  it('fromJSON round-trip preserves tombstones correctly', () => {
    const m = new LWWMap();
    m.set('alive', 'yes', 1, 'A');
    m.set('dead', 'no', 1, 'A');
    m.delete('dead', 2, 'A');

    const json = m.toJSON();
    const restored = LWWMap.fromJSON(json);

    // Set dead again with newer timestamp should work
    restored.set('dead', 'resurrected', 3, 'B');
    assert.equal(restored.get('dead'), 'resurrected');
    assert.ok(restored.has('dead'));
  });
});
