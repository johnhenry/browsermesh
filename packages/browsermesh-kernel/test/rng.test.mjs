import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RNG } from '../src/rng.mjs';

describe('RNG', () => {
  it('get returns Uint8Array of requested length', () => {
    const rng = new RNG();
    const bytes = rng.get(16);
    assert.ok(bytes instanceof Uint8Array);
    assert.equal(bytes.length, 16);
  });

  it('get returns different values each call', () => {
    const rng = new RNG();
    const a = rng.get(16);
    const b = rng.get(16);
    // Extremely unlikely to be equal
    assert.ok(!buffersEqual(a, b));
  });

  it('seeded RNG is deterministic', () => {
    const r1 = RNG.seeded(12345);
    const r2 = RNG.seeded(12345);
    const a = r1.get(32);
    const b = r2.get(32);
    assert.deepEqual(a, b);
  });

  it('different seeds produce different output', () => {
    const r1 = RNG.seeded(111);
    const r2 = RNG.seeded(222);
    assert.ok(!buffersEqual(r1.get(32), r2.get(32)));
  });

  it('seeded RNG produces non-zero output', () => {
    const rng = RNG.seeded(42);
    const bytes = rng.get(64);
    assert.ok(bytes.some(b => b !== 0));
  });

  it('get handles odd byte counts', () => {
    const rng = RNG.seeded(1);
    assert.equal(rng.get(1).length, 1);
    assert.equal(rng.get(3).length, 3);
    assert.equal(rng.get(7).length, 7);
  });
});

function buffersEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
