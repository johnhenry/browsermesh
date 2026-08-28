import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ChaosEngine } from '../src/chaos.mjs';
import { RNG } from '../src/rng.mjs';
import { Clock } from '../src/clock.mjs';

describe('ChaosEngine', () => {
  it('disabled by default', () => {
    const chaos = new ChaosEngine();
    assert.equal(chaos.enabled, false);
  });

  it('enable/disable', () => {
    const chaos = new ChaosEngine();
    chaos.enable();
    assert.equal(chaos.enabled, true);
    chaos.disable();
    assert.equal(chaos.enabled, false);
  });

  it('shouldDrop returns false when disabled', () => {
    const chaos = new ChaosEngine();
    chaos.configure({ dropRate: 1.0 });
    assert.equal(chaos.shouldDrop(), false);
  });

  it('shouldDrop with rate 1.0 always drops', () => {
    const chaos = new ChaosEngine();
    chaos.enable();
    chaos.configure({ dropRate: 1.0 });
    // With rate 1.0 and random() < 1.0, should always be true
    // But Math.random() returns [0, 1), so < 1.0 is always true
    assert.equal(chaos.shouldDrop(), true);
  });

  it('shouldDrop with rate 0 never drops', () => {
    const chaos = new ChaosEngine();
    chaos.enable();
    chaos.configure({ dropRate: 0 });
    assert.equal(chaos.shouldDrop(), false);
  });

  it('shouldDisconnect with rate 1.0', () => {
    const chaos = new ChaosEngine();
    chaos.enable();
    chaos.configure({ disconnectRate: 1.0 });
    assert.equal(chaos.shouldDisconnect(), true);
  });

  it('isPartitioned checks target list', () => {
    const chaos = new ChaosEngine();
    chaos.enable();
    chaos.configure({ partitionTargets: ['10.0.0.1', '10.0.0.2'] });
    assert.equal(chaos.isPartitioned('10.0.0.1'), true);
    assert.equal(chaos.isPartitioned('10.0.0.3'), false);
  });

  it('isPartitioned returns false when disabled', () => {
    const chaos = new ChaosEngine();
    chaos.configure({ partitionTargets: ['10.0.0.1'] });
    assert.equal(chaos.isPartitioned('10.0.0.1'), false);
  });

  it('per-scope config overrides global', () => {
    const chaos = new ChaosEngine();
    chaos.enable();
    chaos.configure({ dropRate: 0 });
    chaos.configureScope('scope_1', { dropRate: 1.0 });
    assert.equal(chaos.shouldDrop(), false);
    assert.equal(chaos.shouldDrop('scope_1'), true);
  });

  it('removeScopeConfig falls back to global', () => {
    const chaos = new ChaosEngine();
    chaos.enable();
    chaos.configure({ dropRate: 0 });
    chaos.configureScope('scope_1', { dropRate: 1.0 });
    chaos.removeScopeConfig('scope_1');
    assert.equal(chaos.shouldDrop('scope_1'), false);
  });

  it('maybeDelay with fixed clock', async () => {
    const clock = Clock.fixed(0, 0);
    const chaos = new ChaosEngine({ clock });
    chaos.enable();
    chaos.configure({ latencyMs: 100 });
    await chaos.maybeDelay();
    assert.equal(clock.nowMonotonic(), 100);
  });

  it('maybeDelay is no-op when disabled', async () => {
    const clock = Clock.fixed(0, 0);
    const chaos = new ChaosEngine({ clock });
    chaos.configure({ latencyMs: 100 });
    await chaos.maybeDelay();
    assert.equal(clock.nowMonotonic(), 0);
  });

  it('deterministic with seeded RNG', () => {
    const rng = RNG.seeded(42);
    const chaos = new ChaosEngine({ rng });
    chaos.enable();
    chaos.configure({ dropRate: 0.5 });

    // Collect results
    const results = [];
    for (let i = 0; i < 10; i++) results.push(chaos.shouldDrop());

    // Replay with same seed
    const rng2 = RNG.seeded(42);
    const chaos2 = new ChaosEngine({ rng: rng2 });
    chaos2.enable();
    chaos2.configure({ dropRate: 0.5 });

    const results2 = [];
    for (let i = 0; i < 10; i++) results2.push(chaos2.shouldDrop());

    assert.deepEqual(results, results2);
  });
});
