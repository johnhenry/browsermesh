import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Clock } from '../src/clock.mjs';

describe('Clock', () => {
  it('nowMonotonic returns a number', () => {
    const clock = new Clock();
    assert.equal(typeof clock.nowMonotonic(), 'number');
  });

  it('nowWall returns a number', () => {
    const clock = new Clock();
    assert.equal(typeof clock.nowWall(), 'number');
  });

  it('sleep resolves after delay', async () => {
    const clock = new Clock();
    const before = clock.nowMonotonic();
    await clock.sleep(10);
    const after = clock.nowMonotonic();
    assert.ok(after >= before);
  });

  it('fixed clock returns deterministic values', () => {
    const clock = Clock.fixed(1000, 2000);
    assert.equal(clock.nowMonotonic(), 1000);
    assert.equal(clock.nowWall(), 2000);
  });

  it('fixed clock advances on sleep', async () => {
    const clock = Clock.fixed(1000, 2000);
    await clock.sleep(500);
    assert.equal(clock.nowMonotonic(), 1500);
    assert.equal(clock.nowWall(), 2500);
  });

  it('custom functions are used', () => {
    let calls = 0;
    const clock = new Clock({ monoFn: () => ++calls, wallFn: () => 42 });
    assert.equal(clock.nowMonotonic(), 1);
    assert.equal(clock.nowMonotonic(), 2);
    assert.equal(clock.nowWall(), 42);
  });
});
