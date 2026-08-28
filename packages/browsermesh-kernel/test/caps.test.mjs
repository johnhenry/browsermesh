import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCaps, requireCap, CapsBuilder } from '../src/caps.mjs';
import { KERNEL_CAP } from '../src/constants.mjs';

// Mock kernel with subsystem accessors
function mockKernel() {
  return {
    clock: { nowMonotonic: () => 0 },
    rng: { get: (n) => new Uint8Array(n) },
    services: { lookup: () => {} },
    tracer: { emit: () => {} },
    chaos: { enable: () => {} },
  };
}

describe('buildCaps', () => {
  it('grants specific capabilities', () => {
    const caps = buildCaps(mockKernel(), [KERNEL_CAP.CLOCK, KERNEL_CAP.RNG]);
    assert.ok(caps.clock);
    assert.ok(caps.rng);
    assert.equal(caps.ipc, undefined);
    assert.equal(caps.trace, undefined);
  });

  it('ALL grants everything', () => {
    const caps = buildCaps(mockKernel(), [KERNEL_CAP.ALL]);
    assert.ok(caps.clock);
    assert.ok(caps.rng);
    assert.ok(caps.ipc);
    assert.ok(caps.trace);
    assert.ok(caps.chaos);
    assert.equal(caps.net, true);
    assert.equal(caps.fs, true);
  });

  it('result is frozen', () => {
    const caps = buildCaps(mockKernel(), [KERNEL_CAP.CLOCK]);
    assert.ok(Object.isFrozen(caps));
  });

  it('_granted contains the granted tags', () => {
    const caps = buildCaps(mockKernel(), [KERNEL_CAP.CLOCK, KERNEL_CAP.RNG]);
    assert.ok(caps._granted.includes(KERNEL_CAP.CLOCK));
    assert.ok(caps._granted.includes(KERNEL_CAP.RNG));
  });
});

describe('requireCap', () => {
  it('does not throw for granted cap', () => {
    const caps = buildCaps(mockKernel(), [KERNEL_CAP.CLOCK]);
    requireCap(caps, KERNEL_CAP.CLOCK); // no throw
  });

  it('throws CapabilityDeniedError for missing cap', () => {
    const caps = buildCaps(mockKernel(), [KERNEL_CAP.CLOCK]);
    assert.throws(() => requireCap(caps, KERNEL_CAP.NET), { name: 'CapabilityDeniedError' });
  });

  it('ALL bypasses all checks', () => {
    const caps = buildCaps(mockKernel(), [KERNEL_CAP.ALL]);
    requireCap(caps, KERNEL_CAP.NET); // no throw
    requireCap(caps, KERNEL_CAP.FS); // no throw
    requireCap(caps, KERNEL_CAP.CHAOS); // no throw
  });

  it('throws for null caps', () => {
    assert.throws(() => requireCap(null, KERNEL_CAP.NET), { name: 'CapabilityDeniedError' });
  });
});

describe('CapsBuilder', () => {
  it('build delegates to buildCaps', () => {
    const builder = new CapsBuilder();
    const caps = builder.build(mockKernel(), [KERNEL_CAP.CLOCK]);
    assert.ok(caps.clock);
    assert.ok(Object.isFrozen(caps));
  });
});
