// Real WebGPU device, real shader, real dispatch/readback -- cross-checked
// against the trusted CPU `GradientAggregator.aggregate()` implementation
// for identical inputs.
//
// Every other GPU test in this repo (test/gpu.test.mjs) exercises only
// `aggregateGPU()`'s *fallback* branch, deliberately never touching a real
// GPUDevice -- that is what keeps this package's normal `npm test` green on
// a bare checkout with no GPU binding installed. This file is the
// counterweight: it runs `gpu-kernel.mjs`'s actual WGSL compute shader
// through an actual WebGPU implementation, so the shader logic itself is
// under test, not just the JS around it.
//
// Requires the optional devDependency `webgpu` (a Dawn/dawn.node binding
// published by the Dawn/WebGPU team, ~95 MB installed across bundled
// per-platform native binaries). When it is absent, these tests skip
// rather than fail, so `npm test` still works on a bare checkout.
//
// Separately from "is the package installed," a real adapter/device may
// still be unavailable in a given environment (e.g. a headless CI runner
// with no GPU hardware and no software Vulkan/D3D12 implementation
// configured) -- see this package's README for what was actually found
// when this was investigated for headless CI. That case is handled inside
// `before()` below: individual tests report a skip with a reason, rather
// than the whole file reporting green with nothing actually exercised.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { GradientAggregator } from '../../src/gpu.mjs'

/** @type {any} */ let webgpu = null
try {
  webgpu = await import('webgpu')
} catch {
  // Optional dependency absent -- the suite below skips.
}

// A skipped suite reports success. That is right for a contributor who has
// not installed the (large, native-binary-bundling) optional devDependency,
// and wrong for CI, where a silently-absent dependency would turn this
// whole file into decoration while the run stays green. REQUIRE_WEBGPU=1
// makes the absence fatal.
if (!webgpu && process.env.REQUIRE_WEBGPU) {
  throw new Error(
    'REQUIRE_WEBGPU is set but the `webgpu` package did not load, so the ' +
    'real-webgpu suite would have skipped and reported success. Install the ' +
    'devDependency, or unset REQUIRE_WEBGPU to allow the skip.'
  )
}

if (!webgpu) {
  // Make the skip visible in the run output rather than silently absent.
  describe('GPU kernel against real WebGPU', () => {
    it('skipped: optional devDependency `webgpu` is not installed', () => {})
  })
}

const describeIfReal = webgpu ? describe : describe.skip

describeIfReal('GPU kernel against real WebGPU', () => {
  /** @type {any} */ let device = null

  before(async () => {
    Object.assign(globalThis, webgpu.globals)
    const gpu = webgpu.create([])
    const adapter = await gpu.requestAdapter()

    if (!adapter) {
      if (process.env.REQUIRE_WEBGPU) {
        throw new Error(
          'REQUIRE_WEBGPU is set but requestAdapter() returned null -- no ' +
          'usable GPU adapter (physical or software) is available in this ' +
          'environment.'
        )
      }
      // No adapter available. Leave `device` null; individual tests below
      // report an explicit, visible skip rather than silently passing.
      return
    }

    device = await adapter.requestDevice()
  })

  after(() => {
    device?.destroy?.()
  })

  it('matches aggregate() for sync_allreduce (unweighted elementwise mean)', async (t) => {
    if (!device) { t.skip('no GPU adapter/device available in this environment'); return }

    const agg = new GradientAggregator({ strategy: 'sync_allreduce', parameterCount: 5 })
    agg.submit('s1', [1, 2, 3, 4, 5])
    agg.submit('s2', [3, 4, 5, 6, 7])
    agg.submit('s3', [10, 10, 10, 10, 10])

    const expected = agg.aggregate() // the trusted CPU path
    const result = await agg.aggregateGPU(device)

    assert.equal(result.length, expected.length)
    // The shader computes in f32; aggregate() computes in f64 -- compare
    // with a small tolerance instead of exact equality (e.g. 5.333333333
    // vs. 5.333333492 is the same answer, not a bug).
    for (let i = 0; i < expected.length; i++) {
      assert.ok(
        Math.abs(result[i] - expected[i]) < 1e-4,
        `index ${i}: gpu=${result[i]} cpu=${expected[i]}`
      )
    }
  })

  it('matches aggregate() for federated_avg (weighted elementwise mean)', async (t) => {
    if (!device) { t.skip('no GPU adapter/device available in this environment'); return }

    const agg = new GradientAggregator({ strategy: 'federated_avg', parameterCount: 3 })
    agg.submit('s1', [10, 20, 30], 1)
    agg.submit('s2', [20, 40, 60], 3)
    agg.submit('s3', [5, 5, 5], 2)

    const expected = agg.aggregate() // the trusted CPU path
    const result = await agg.aggregateGPU(device)

    assert.equal(result.length, expected.length)
    // f32 GPU arithmetic vs f64 JS arithmetic can differ in the last bit(s)
    // -- compare with a small tolerance instead of exact equality.
    for (let i = 0; i < expected.length; i++) {
      assert.ok(
        Math.abs(result[i] - expected[i]) < 1e-4,
        `index ${i}: gpu=${result[i]} cpu=${expected[i]}`
      )
    }
  })

  it('reuses the cached pipeline across repeated calls on the same device', async (t) => {
    if (!device) { t.skip('no GPU adapter/device available in this environment'); return }

    const agg = new GradientAggregator({ strategy: 'sync_allreduce', parameterCount: 2 })
    agg.submit('a', [1, 1])
    agg.submit('b', [3, 3])

    const first = await agg.aggregateGPU(device)
    const second = await agg.aggregateGPU(device)

    assert.deepEqual(first, [2, 2])
    assert.deepEqual(second, [2, 2])
  })
})
