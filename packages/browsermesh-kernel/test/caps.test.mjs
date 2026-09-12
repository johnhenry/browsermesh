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

describe('buildCaps MESH capability wiring (Phase 4)', () => {
  it('caps.mesh is the pre-Phase-4 bare boolean marker when the kernel has no meshFor()', () => {
    // mockKernel() (above) has no meshFor — same shape as a plain `new Kernel()`
    // constructed without a `mesh` provider, and the same shape existing mocks in
    // other packages' tests already use.
    const caps = buildCaps(mockKernel(), [KERNEL_CAP.MESH]);
    assert.equal(caps.mesh, true);
  });

  it('caps.mesh is the real scoped view, and tenantId is threaded through, when kernel.meshFor() returns one', () => {
    const meshView = Object.freeze({ send: () => {}, onReceive: () => {} });
    const kernel = {
      ...mockKernel(),
      meshFor(tenantId) {
        assert.equal(tenantId, 'tenant_42');
        return meshView;
      },
    };
    const caps = buildCaps(kernel, [KERNEL_CAP.MESH], 'tenant_42');
    assert.equal(caps.mesh, meshView);
  });

  it('caps.mesh falls back to the bare boolean marker when kernel.meshFor() itself returns null (no provider injected)', () => {
    const kernel = { ...mockKernel(), meshFor: () => null };
    const caps = buildCaps(kernel, [KERNEL_CAP.MESH], 'tenant_1');
    assert.equal(caps.mesh, true);
  });

  it('caps.mesh is absent (not granted) when MESH is not in grantedCaps, even with a real provider wired', () => {
    const kernel = { ...mockKernel(), meshFor: () => Object.freeze({ send: () => {}, onReceive: () => {} }) };
    const caps = buildCaps(kernel, [KERNEL_CAP.CLOCK], 'tenant_1');
    assert.equal(caps.mesh, undefined);
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

  it('throws CapabilityDeniedError for MESH specifically when the tenant was not granted it — denial throws, it does not silently no-op', () => {
    // Even with a real mesh provider wired into the kernel, a tenant that was never
    // granted KERNEL_CAP.MESH gets no `caps.mesh` at all (not a no-op / empty view).
    const meshView = Object.freeze({ send: () => {}, onReceive: () => {} });
    const kernel = { ...mockKernel(), meshFor: () => meshView };
    const caps = buildCaps(kernel, [KERNEL_CAP.CLOCK], 'tenant_1'); // no MESH grant
    assert.equal(caps.mesh, undefined);
    assert.throws(() => requireCap(caps, KERNEL_CAP.MESH), { name: 'CapabilityDeniedError' });
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
