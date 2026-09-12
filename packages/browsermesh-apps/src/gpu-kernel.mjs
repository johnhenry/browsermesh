/**
 * gpu-kernel.mjs -- WGSL compute shader for gradient aggregation.
 *
 * One thread per output parameter index; each thread loops serially over
 * the shard axis inside itself (parameter count is expected to vastly
 * outnumber shard count in real training jobs, so a per-parameter thread
 * with a short serial shard loop needs no cross-thread synchronization and
 * no reduction pass). A single shader/pipeline covers both of
 * `GradientAggregator.aggregate()`'s branches via a uniform `useWeights`
 * flag:
 *
 *   - federated_avg: weighted elementwise mean (per-shard weights,
 *     normalized by their sum inside the shader — mirrors the JS branch in
 *     gpu.mjs exactly).
 *   - sync_allreduce / async_parameter_server: unweighted elementwise mean.
 *
 * The compiled GPUShaderModule/GPUComputePipeline pair is cached per
 * GPUDevice in a WeakMap, so repeated calls against the same device never
 * recompile, and distinct devices (e.g. one per test) never share or leak
 * cached state -- when a device is garbage collected its cache entry goes
 * with it.
 */

const WORKGROUP_SIZE = 64

const SHADER_SOURCE = `
struct Params {
  vectorLength: u32,
  numShards: u32,
  useWeights: u32,
  totalWeight: f32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> gradients: array<f32>;
@group(0) @binding(2) var<storage, read> weights: array<f32>;
@group(0) @binding(3) var<storage, read_write> output: array<f32>;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= params.vectorLength) {
    return;
  }

  var sum: f32 = 0.0;

  if (params.useWeights == 1u) {
    // federated_avg: weighted elementwise mean, weights normalized by their
    // sum (mirrors GradientAggregator.aggregate()'s JS branch).
    for (var s: u32 = 0u; s < params.numShards; s = s + 1u) {
      let w = weights[s] / params.totalWeight;
      sum = sum + gradients[s * params.vectorLength + i] * w;
    }
  } else {
    // sync_allreduce / async_parameter_server: unweighted elementwise mean.
    for (var s: u32 = 0u; s < params.numShards; s = s + 1u) {
      sum = sum + gradients[s * params.vectorLength + i];
    }
    if (params.numShards > 0u) {
      sum = sum / f32(params.numShards);
    }
  }

  output[i] = sum;
}
`

/** @type {WeakMap<object, { module: object, pipeline: object }>} */
const pipelineCache = new WeakMap()

/**
 * Get (or lazily create) the compiled shader module + compute pipeline for
 * `device`, caching the result so repeated dispatches on the same device
 * skip recompilation.
 * @param {object} device GPUDevice
 * @returns {{ module: object, pipeline: object }}
 */
function getOrCreatePipeline(device) {
  const cached = pipelineCache.get(device)
  if (cached) return cached

  const module = device.createShaderModule({
    code: SHADER_SOURCE,
    label: 'browsermesh-gradient-aggregate-shader',
  })
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
    label: 'browsermesh-gradient-aggregate-pipeline',
  })

  const entry = { module, pipeline }
  pipelineCache.set(device, entry)
  return entry
}

/**
 * Run the gradient-aggregation compute kernel on `device`.
 *
 * @param {object} device GPUDevice
 * @param {object} opts
 * @param {number[]} opts.gradients Flat, shard-major gradient values:
 *   `gradients[shard * vectorLength + i]` is shard `shard`'s value for
 *   parameter `i`. Length must equal `weights.length * vectorLength`.
 * @param {number[]} opts.weights One weight per shard (length = numShards).
 *   Only consulted when `useWeights` is true; pass `[1, 1, ...]` (or
 *   anything of the right length) when it is false.
 * @param {boolean} opts.useWeights `true` for federated_avg's weighted
 *   mean, `false` for sync_allreduce/async_parameter_server's unweighted
 *   mean.
 * @returns {Promise<number[]>} The aggregated vector (plain Array, length
 *   = vectorLength) -- matches `GradientAggregator.aggregate()`'s return
 *   shape so callers never need to special-case typed vs. plain arrays.
 */
export async function runAggregateKernel(device, { gradients, weights, useWeights }) {
  const numShards = weights.length
  const vectorLength = numShards > 0 ? gradients.length / numShards : 0

  if (!Number.isInteger(vectorLength)) {
    throw new Error(
      `runAggregateKernel: gradients.length (${gradients.length}) is not evenly ` +
      `divisible by weights.length (${numShards})`
    )
  }

  const { pipeline } = getOrCreatePipeline(device)

  const totalWeight = useWeights ? weights.reduce((a, b) => a + b, 0) : numShards

  const paramsData = new ArrayBuffer(16)
  const paramsView = new DataView(paramsData)
  paramsView.setUint32(0, vectorLength, true)
  paramsView.setUint32(4, numShards, true)
  paramsView.setUint32(8, useWeights ? 1 : 0, true)
  paramsView.setFloat32(12, totalWeight, true)

  const paramsBuffer = device.createBuffer({
    size: paramsData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: 'browsermesh-gradient-aggregate-params',
  })
  device.queue.writeBuffer(paramsBuffer, 0, paramsData)

  const gradientsArray = Float32Array.from(gradients)
  const gradientsBuffer = device.createBuffer({
    size: Math.max(gradientsArray.byteLength, 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: 'browsermesh-gradient-aggregate-gradients',
  })
  device.queue.writeBuffer(gradientsBuffer, 0, gradientsArray)

  const weightsArray = Float32Array.from(weights.length > 0 ? weights : [0])
  const weightsBuffer = device.createBuffer({
    size: Math.max(weightsArray.byteLength, 4),
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    label: 'browsermesh-gradient-aggregate-weights',
  })
  device.queue.writeBuffer(weightsBuffer, 0, weightsArray)

  const outputByteLength = Math.max(vectorLength * 4, 4)
  const outputBuffer = device.createBuffer({
    size: outputByteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    label: 'browsermesh-gradient-aggregate-output',
  })

  const readbackBuffer = device.createBuffer({
    size: outputByteLength,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    label: 'browsermesh-gradient-aggregate-readback',
  })

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramsBuffer } },
      { binding: 1, resource: { buffer: gradientsBuffer } },
      { binding: 2, resource: { buffer: weightsBuffer } },
      { binding: 3, resource: { buffer: outputBuffer } },
    ],
    label: 'browsermesh-gradient-aggregate-bindgroup',
  })

  const encoder = device.createCommandEncoder({ label: 'browsermesh-gradient-aggregate-encoder' })
  const pass = encoder.beginComputePass({ label: 'browsermesh-gradient-aggregate-pass' })
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bindGroup)
  const workgroupCount = Math.max(1, Math.ceil(vectorLength / WORKGROUP_SIZE))
  pass.dispatchWorkgroups(workgroupCount)
  pass.end()
  encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, outputByteLength)
  device.queue.submit([encoder.finish()])

  await readbackBuffer.mapAsync(GPUMapMode.READ)
  const mapped = readbackBuffer.getMappedRange()
  const resultFloats = new Float32Array(mapped.slice(0, vectorLength * 4))
  readbackBuffer.unmap()

  paramsBuffer.destroy?.()
  gradientsBuffer.destroy?.()
  weightsBuffer.destroy?.()
  outputBuffer.destroy?.()
  readbackBuffer.destroy?.()

  return Array.from(resultFloats)
}
