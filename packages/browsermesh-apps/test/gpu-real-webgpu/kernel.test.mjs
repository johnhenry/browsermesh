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

// Temporary diagnostic instrumentation (browsermesh#63): a real CI run
// against a headless software-Vulkan device failed with no JS-catchable
// error and no TAP subtest output at all (0 suites reported) -- consistent
// with the native Dawn/Vulkan process dying outright rather than a normal
// JS throw. These markers are flushed to stderr immediately around each
// native call, gated behind GPU_KERNEL_DEBUG, so a silent process death
// still leaves a trail of exactly how far it got.
const debug = process.env.GPU_KERNEL_DEBUG
  ? (stage) => { console.error(`[kernel.test] ${stage}`) }
  : () => {}

describeIfReal('GPU kernel against real WebGPU', () => {
  /** @type {any} */ let device = null

  before(async () => {
    debug('before: Object.assign(globalThis, webgpu.globals)')
    Object.assign(globalThis, webgpu.globals)
    debug('before: webgpu.create([])')
    const gpu = webgpu.create([])
    debug('before: gpu.requestAdapter(): start')
    const adapter = await gpu.requestAdapter()
    debug(`before: gpu.requestAdapter(): done, adapter=${adapter ? 'obtained' : 'null'}`)

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

    debug('before: adapter.requestDevice(): start')
    device = await adapter.requestDevice()
    debug(`before: adapter.requestDevice(): done, device=${device ? 'obtained' : 'null'}`)
  })

  after(() => {
    debug('after: device?.destroy()')
    device?.destroy?.()
    debug('after: done')
  })

  it('matches aggregate() for sync_allreduce (unweighted elementwise mean)', async (t) => {
    debug('test 1: entered')
    if (!device) { t.skip('no GPU adapter/device available in this environment'); return }

    const agg = new GradientAggregator({ strategy: 'sync_allreduce', parameterCount: 5 })
    agg.submit('s1', [1, 2, 3, 4, 5])
    agg.submit('s2', [3, 4, 5, 6, 7])
    agg.submit('s3', [10, 10, 10, 10, 10])

    const expected = agg.aggregate() // the trusted CPU path
    debug('test 1: aggregateGPU(): start')
    let result
    try {
      result = await agg.aggregateGPU(device)
    } catch (err) {
      console.error('[kernel.test] test 1: aggregateGPU() threw:', err && err.stack ? err.stack : err)
      throw err
    }
    debug('test 1: aggregateGPU(): done')

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
    debug('test 2: entered')
    if (!device) { t.skip('no GPU adapter/device available in this environment'); return }

    const agg = new GradientAggregator({ strategy: 'federated_avg', parameterCount: 3 })
    agg.submit('s1', [10, 20, 30], 1)
    agg.submit('s2', [20, 40, 60], 3)
    agg.submit('s3', [5, 5, 5], 2)

    const expected = agg.aggregate() // the trusted CPU path
    debug('test 2: aggregateGPU(): start')
    let result
    try {
      result = await agg.aggregateGPU(device)
    } catch (err) {
      console.error('[kernel.test] test 2: aggregateGPU() threw:', err && err.stack ? err.stack : err)
      throw err
    }
    debug('test 2: aggregateGPU(): done')

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
    debug('test 3: entered')
    if (!device) { t.skip('no GPU adapter/device available in this environment'); return }

    const agg = new GradientAggregator({ strategy: 'sync_allreduce', parameterCount: 2 })
    agg.submit('a', [1, 1])
    agg.submit('b', [3, 3])

    debug('test 3: aggregateGPU() #1: start')
    let first, second
    try {
      first = await agg.aggregateGPU(device)
      debug('test 3: aggregateGPU() #1: done, starting #2')
      second = await agg.aggregateGPU(device)
      debug('test 3: aggregateGPU() #2: done')
    } catch (err) {
      console.error('[kernel.test] test 3: aggregateGPU() threw:', err && err.stack ? err.stack : err)
      throw err
    }

    assert.deepEqual(first, [2, 2])
    assert.deepEqual(second, [2, 2])
  })
})
