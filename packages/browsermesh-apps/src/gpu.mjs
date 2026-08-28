/**
 * clawser-mesh-gpu.js -- WebGPU Training Orchestration.
 *
 * Distributed training across mesh peers using WebGPU and wsh backends:
 *
 * - GpuCapability: describes a peer's GPU resources.
 * - GpuProbe: detect local GPU capabilities.
 * - TrainingSpec: defines a distributed training job.
 * - TrainingShard: one peer's portion of training work.
 * - GradientAggregator: combine gradients from shards.
 * - TrainingOrchestrator: manages distributed training lifecycle.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-gpu.test.mjs
 */

import { MESH_TYPE } from '@johnhenry/browsermesh-primitives'

// ---------------------------------------------------------------------------
// Wire Constants — imported from canonical registry
// ---------------------------------------------------------------------------

/** Wire type for GPU capability probe. */
export const GPU_PROBE = MESH_TYPE.GPU_PROBE

/** Wire type for shard assignment message. */
export const GPU_SHARD_ASSIGN = MESH_TYPE.GPU_SHARD_ASSIGN

/** Wire type for gradient push from a shard peer. */
export const GPU_GRADIENT_PUSH = MESH_TYPE.GPU_GRADIENT_PUSH

/** Wire type for training control messages (start/cancel/status). */
export const GPU_TRAIN_CONTROL = MESH_TYPE.GPU_TRAIN_CONTROL

// ---------------------------------------------------------------------------
// GpuCapability
// ---------------------------------------------------------------------------

/**
 * Describes a peer's GPU resources.
 */
export class GpuCapability {
  /**
   * @param {object} opts
   * @param {string} opts.podId           Peer pod ID
   * @param {boolean} [opts.hasWebGPU]    Whether WebGPU is available
   * @param {boolean} [opts.hasWsh]       Whether wsh connections are available
   * @param {number} [opts.maxBufferSize] Maximum buffer size in bytes
   * @param {object} [opts.adapterInfo]   WebGPU adapter info
   * @param {object} [opts.limits]        WebGPU limit info
   */
  constructor({ podId, hasWebGPU = false, hasWsh = false, maxBufferSize = 0, adapterInfo, limits }) {
    if (!podId || typeof podId !== 'string') {
      throw new Error('podId is required and must be a non-empty string')
    }
    this.podId = podId
    this.hasWebGPU = hasWebGPU
    this.hasWsh = hasWsh
    this.maxBufferSize = maxBufferSize
    this.adapterInfo = adapterInfo || null
    this.limits = limits || null
  }

  /**
   * Check whether this peer can participate in training for the given spec.
   * Requires WebGPU or wsh, and sufficient buffer size if spec defines one.
   * @param {TrainingSpec} [spec]
   * @returns {boolean}
   */
  canTrain(spec) {
    if (!this.hasWebGPU && !this.hasWsh) return false
    if (spec && spec.modelConfig && typeof spec.modelConfig.minBufferSize === 'number') {
      if (this.maxBufferSize < spec.modelConfig.minBufferSize) return false
    }
    return true
  }

  toJSON() {
    return {
      podId: this.podId,
      hasWebGPU: this.hasWebGPU,
      hasWsh: this.hasWsh,
      maxBufferSize: this.maxBufferSize,
      adapterInfo: this.adapterInfo,
      limits: this.limits,
    }
  }

  static fromJSON(json) {
    return new GpuCapability(json)
  }
}

// ---------------------------------------------------------------------------
// GpuProbe
// ---------------------------------------------------------------------------

/**
 * Detects local GPU capabilities by probing navigator.gpu and wsh.
 */
export class GpuProbe {
  /**
   * Probe the local environment for GPU capabilities.
   * @param {string} podId - This peer's pod ID
   * @returns {Promise<GpuCapability>}
   */
  static async probe(podId) {
    let hasWebGPU = false
    let maxBufferSize = 0
    let adapterInfo = null
    let limits = null

    // Try WebGPU
    try {
      const gpu = typeof navigator !== 'undefined' ? navigator.gpu : undefined
      if (gpu) {
        const adapter = await gpu.requestAdapter()
        if (adapter) {
          hasWebGPU = true
          // Extract adapter info
          if (adapter.info) {
            const info = adapter.info
            adapterInfo = {
              vendor: info.vendor || '',
              architecture: info.architecture || '',
              device: info.device || '',
              description: info.description || '',
            }
          }
          // Extract limits
          if (adapter.limits) {
            const lim = adapter.limits
            limits = {}
            // Copy enumerable limit properties
            for (const key of Object.keys(lim)) {
              limits[key] = lim[key]
            }
            if (typeof lim.maxBufferSize === 'number') {
              maxBufferSize = lim.maxBufferSize
            } else if (typeof lim.maxStorageBufferBindingSize === 'number') {
              maxBufferSize = lim.maxStorageBufferBindingSize
            }
          }
        }
      }
    } catch {
      // WebGPU not available — continue
    }

    // Check for wsh connections
    let hasWsh = false
    try {
      if (typeof globalThis.getWshConnections === 'function') {
        const connections = globalThis.getWshConnections()
        if (connections && (Array.isArray(connections) ? connections.length > 0 : Object.keys(connections).length > 0)) {
          hasWsh = true
        }
      }
    } catch {
      // wsh not available
    }

    return new GpuCapability({ podId, hasWebGPU, hasWsh, maxBufferSize, adapterInfo, limits })
  }
}

// ---------------------------------------------------------------------------
// TrainingSpec
// ---------------------------------------------------------------------------

const VALID_STRATEGIES = ['sync_allreduce', 'async_parameter_server', 'federated_avg']

/**
 * Defines a distributed training job.
 */
export class TrainingSpec {
  /**
   * @param {object} opts
   * @param {string} opts.jobId           Unique job ID
   * @param {object} opts.modelConfig     Model architecture description
   * @param {string} opts.datasetRef      Reference to dataset
   * @param {number} [opts.epochs]        Number of epochs (default 1)
   * @param {number} [opts.batchSize]     Batch size (default 32)
   * @param {number} [opts.learningRate]  Learning rate (default 0.001)
   * @param {string} [opts.strategy]      Distribution strategy
   * @param {number} [opts.shardCount]    Number of shards (default 1)
   */
  constructor({
    jobId,
    modelConfig,
    datasetRef,
    epochs = 1,
    batchSize = 32,
    learningRate = 0.001,
    strategy = 'sync_allreduce',
    shardCount = 1,
  }) {
    this.jobId = jobId
    this.modelConfig = modelConfig
    this.datasetRef = datasetRef
    this.epochs = epochs
    this.batchSize = batchSize
    this.learningRate = learningRate
    this.strategy = strategy
    this.shardCount = shardCount
  }

  /**
   * Validate the spec. Throws on invalid configuration.
   */
  validate() {
    if (!this.jobId || typeof this.jobId !== 'string') {
      throw new Error('jobId is required and must be a non-empty string')
    }
    if (!this.modelConfig || typeof this.modelConfig !== 'object') {
      throw new Error('modelConfig is required and must be an object')
    }
    if (!this.datasetRef || typeof this.datasetRef !== 'string') {
      throw new Error('datasetRef is required and must be a non-empty string')
    }
    if (!VALID_STRATEGIES.includes(this.strategy)) {
      throw new Error(`strategy must be one of: ${VALID_STRATEGIES.join(', ')}`)
    }
  }

  toJSON() {
    return {
      jobId: this.jobId,
      modelConfig: this.modelConfig,
      datasetRef: this.datasetRef,
      epochs: this.epochs,
      batchSize: this.batchSize,
      learningRate: this.learningRate,
      strategy: this.strategy,
      shardCount: this.shardCount,
    }
  }

  static fromJSON(json) {
    return new TrainingSpec(json)
  }
}

// ---------------------------------------------------------------------------
// TrainingShard
// ---------------------------------------------------------------------------

/**
 * One peer's portion of training work.
 */
export class TrainingShard {
  /** @type {{ gradients: number[], metrics: object } | null} */
  #result = null

  /**
   * @param {object} opts
   * @param {string} opts.shardId    Unique shard ID
   * @param {string} opts.jobId      Parent job ID
   * @param {string} [opts.podId]    Assigned peer pod ID
   * @param {object} [opts.dataRange] Data range {start, end}
   * @param {object} [opts.parameters] Model parameters for this shard
   * @param {string} [opts.status]   Shard status
   */
  constructor({
    shardId,
    jobId,
    podId = null,
    dataRange = null,
    parameters = null,
    status = 'pending',
  }) {
    if (!shardId || typeof shardId !== 'string') {
      throw new Error('shardId is required and must be a non-empty string')
    }
    if (!jobId || typeof jobId !== 'string') {
      throw new Error('jobId is required and must be a non-empty string')
    }
    this.shardId = shardId
    this.jobId = jobId
    this.podId = podId
    this.dataRange = dataRange
    this.parameters = parameters
    this.status = status
  }

  /**
   * Store training result and mark shard as completed.
   * @param {number[]} gradients  Gradient vector
   * @param {object} metrics      Training metrics
   */
  setResult(gradients, metrics) {
    this.#result = { gradients, metrics }
    this.status = 'completed'
  }

  /**
   * Get stored result or null if not yet completed.
   * @returns {{ gradients: number[], metrics: object } | null}
   */
  getResult() {
    return this.#result
  }

  toJSON() {
    return {
      shardId: this.shardId,
      jobId: this.jobId,
      podId: this.podId,
      dataRange: this.dataRange,
      parameters: this.parameters,
      status: this.status,
      result: this.#result,
    }
  }

  static fromJSON(json) {
    const shard = new TrainingShard({
      shardId: json.shardId,
      jobId: json.jobId,
      podId: json.podId,
      dataRange: json.dataRange,
      parameters: json.parameters,
      status: json.status,
    })
    if (json.result) {
      shard.setResult(json.result.gradients, json.result.metrics)
      // Restore original status if it was set before result (e.g. 'completed')
      shard.status = json.status || 'completed'
    }
    return shard
  }
}

// ---------------------------------------------------------------------------
// GradientAggregator
// ---------------------------------------------------------------------------

/**
 * Combines gradients from multiple shards using the configured strategy.
 */
export class GradientAggregator {
  /** @type {Map<string, number[]>} shardId → gradient array */
  #gradients = new Map()

  /** @type {Map<string, number>} shardId → weight (for federated_avg) */
  #weights = new Map()

  /**
   * @param {object} opts
   * @param {string} opts.strategy       Aggregation strategy
   * @param {number} opts.parameterCount Expected gradient vector length
   */
  constructor({ strategy, parameterCount }) {
    if (!VALID_STRATEGIES.includes(strategy)) {
      throw new Error(`strategy must be one of: ${VALID_STRATEGIES.join(', ')}`)
    }
    this.strategy = strategy
    this.parameterCount = parameterCount
  }

  /**
   * Submit a gradient vector from a shard.
   * @param {string} shardId     Shard ID
   * @param {number[]} gradients Gradient vector
   * @param {number} [weight=1]  Weight for federated averaging
   */
  submit(shardId, gradients, weight = 1) {
    this.#gradients.set(shardId, gradients)
    this.#weights.set(shardId, weight)
  }

  /**
   * Check if enough gradients have been submitted.
   * @param {number} expectedCount Number of shards expected
   * @returns {boolean}
   */
  isReady(expectedCount) {
    return this.#gradients.size >= expectedCount
  }

  /**
   * Aggregate submitted gradients based on the strategy.
   * @returns {number[]} Aggregated gradient vector
   */
  aggregate() {
    const entries = [...this.#gradients.entries()]
    if (entries.length === 0) {
      return new Array(this.parameterCount).fill(0)
    }

    const vectorLength = entries[0][1].length

    if (this.strategy === 'federated_avg') {
      // Weighted average
      let totalWeight = 0
      for (const [shardId] of entries) {
        totalWeight += this.#weights.get(shardId) || 1
      }
      const result = new Array(vectorLength).fill(0)
      for (const [shardId, grads] of entries) {
        const w = (this.#weights.get(shardId) || 1) / totalWeight
        for (let i = 0; i < vectorLength; i++) {
          result[i] += grads[i] * w
        }
      }
      return result
    }

    // sync_allreduce and async_parameter_server: element-wise average
    const result = new Array(vectorLength).fill(0)
    for (const [, grads] of entries) {
      for (let i = 0; i < vectorLength; i++) {
        result[i] += grads[i]
      }
    }
    for (let i = 0; i < vectorLength; i++) {
      result[i] /= entries.length
    }
    return result
  }

  /**
   * Clear all stored gradients and weights.
   */
  reset() {
    this.#gradients.clear()
    this.#weights.clear()
  }
}

// ---------------------------------------------------------------------------
// TrainingOrchestrator
// ---------------------------------------------------------------------------

let _jobSeq = 0
let _shardSeq = 0

/**
 * Manages the distributed training lifecycle across mesh peers.
 */
export class TrainingOrchestrator {
  /** @type {Function} (targetId, msg) => void */
  #sendFn

  /** @type {GpuCapability|null} */
  #localCapability

  /** @type {Map<string, { spec: TrainingSpec, shards: Map<string, TrainingShard>, aggregator: GradientAggregator, status: string }>} */
  #jobs = new Map()

  /** @type {Map<string, GpuCapability>} podId → capability */
  #peerCapabilities = new Map()

  /**
   * @param {object} opts
   * @param {Function} opts.sendFn         Send function: (targetId, msg) => {}
   * @param {GpuCapability} [opts.localCapability] Local GPU capability
   */
  constructor({ sendFn, localCapability }) {
    if (typeof sendFn !== 'function') {
      throw new Error('sendFn is required and must be a function')
    }
    this.#sendFn = sendFn
    this.#localCapability = localCapability || null
  }

  /**
   * Register a peer's GPU capability.
   * @param {string} podId
   * @param {GpuCapability} capability
   */
  registerPeer(podId, capability) {
    this.#peerCapabilities.set(podId, capability)
  }

  /**
   * Remove a peer from the capabilities map.
   * @param {string} podId
   */
  removePeer(podId) {
    this.#peerCapabilities.delete(podId)
  }

  /**
   * Start a distributed training job.
   * @param {TrainingSpec} spec
   * @returns {string} The job ID
   */
  startJob(spec) {
    spec.validate()

    // Find capable peers
    const capablePeers = []
    for (const [podId, cap] of this.#peerCapabilities) {
      if (cap.canTrain(spec)) {
        capablePeers.push(podId)
      }
    }
    // Include local peer if capable
    if (this.#localCapability && this.#localCapability.canTrain(spec)) {
      capablePeers.push(this.#localCapability.podId)
    }

    if (capablePeers.length === 0) {
      throw new Error('No capable peers available for training')
    }

    const shards = this.#assignShards(spec, capablePeers)
    const shardMap = new Map()
    for (const shard of shards) {
      shardMap.set(shard.shardId, shard)
    }

    const aggregator = new GradientAggregator({
      strategy: spec.strategy,
      parameterCount: spec.modelConfig.parameterCount || 0,
    })

    this.#jobs.set(spec.jobId, {
      spec,
      shards: shardMap,
      aggregator,
      status: 'running',
    })

    // Send shard assignments to peers
    for (const shard of shards) {
      if (shard.podId && shard.podId !== (this.#localCapability?.podId)) {
        this.#sendFn(shard.podId, {
          type: GPU_SHARD_ASSIGN,
          jobId: spec.jobId,
          shard: shard.toJSON(),
          spec: spec.toJSON(),
        })
      }
    }

    return spec.jobId
  }

  /**
   * Distribute data ranges across capable peers (round-robin).
   * @param {TrainingSpec} spec
   * @param {string[]} peers
   * @returns {TrainingShard[]}
   */
  #assignShards(spec, peers) {
    const count = spec.shardCount
    const shards = []
    const totalDataSize = spec.modelConfig.dataSize || 1000

    for (let i = 0; i < count; i++) {
      const rangeSize = Math.ceil(totalDataSize / count)
      const start = i * rangeSize
      const end = Math.min(start + rangeSize, totalDataSize)
      const podId = peers[i % peers.length]

      shards.push(new TrainingShard({
        shardId: `shard_${spec.jobId}_${++_shardSeq}`,
        jobId: spec.jobId,
        podId,
        dataRange: { start, end },
        parameters: spec.modelConfig,
        status: 'running',
      }))
    }

    return shards
  }

  /**
   * Handle a probe response from a peer.
   * @param {string} fromId
   * @param {GpuCapability|object} capability
   */
  handleProbeResponse(fromId, capability) {
    const cap = capability instanceof GpuCapability
      ? capability
      : GpuCapability.fromJSON(capability)
    this.registerPeer(fromId, cap)
  }

  /**
   * Handle a gradient push from a shard peer.
   * @param {string} fromId
   * @param {string} shardId
   * @param {number[]} gradients
   */
  handleGradientPush(fromId, shardId, gradients) {
    // Find the job that contains this shard
    for (const [jobId, job] of this.#jobs) {
      if (job.shards.has(shardId)) {
        const shard = job.shards.get(shardId)
        shard.setResult(gradients, { fromId })
        job.aggregator.submit(shardId, gradients)

        if (job.aggregator.isReady(job.shards.size)) {
          job.status = 'aggregated'
        }
        return
      }
    }
  }

  /**
   * Handle a training control message.
   * @param {string} fromId
   * @param {object} msg
   */
  handleTrainControl(fromId, msg) {
    switch (msg.action) {
      case 'start': {
        if (msg.spec) {
          const spec = TrainingSpec.fromJSON(msg.spec)
          this.startJob(spec)
        }
        break
      }
      case 'cancel': {
        if (msg.jobId) {
          this.cancelJob(msg.jobId)
        }
        break
      }
      case 'status': {
        if (msg.jobId) {
          const status = this.getJobStatus(msg.jobId)
          this.#sendFn(fromId, {
            type: GPU_TRAIN_CONTROL,
            action: 'status_response',
            ...status,
          })
        }
        break
      }
    }
  }

  /**
   * Get the status of a training job.
   * @param {string} jobId
   * @returns {object}
   */
  getJobStatus(jobId) {
    const job = this.#jobs.get(jobId)
    if (!job) {
      return { jobId, status: 'not_found', shardCount: 0, completedShards: 0, aggregated: false }
    }

    let completedShards = 0
    for (const [, shard] of job.shards) {
      if (shard.status === 'completed') completedShards++
    }

    return {
      jobId,
      status: job.status,
      shardCount: job.shards.size,
      completedShards,
      aggregated: job.status === 'aggregated',
    }
  }

  /**
   * Cancel a training job.
   * @param {string} jobId
   */
  cancelJob(jobId) {
    const job = this.#jobs.get(jobId)
    if (!job) return

    job.status = 'cancelled'

    // Send cancel to all shard peers
    for (const [, shard] of job.shards) {
      if (shard.podId && shard.podId !== (this.#localCapability?.podId)) {
        this.#sendFn(shard.podId, {
          type: GPU_TRAIN_CONTROL,
          action: 'cancel',
          jobId,
        })
      }
    }
  }

  /**
   * Broadcast GPU_PROBE to a list of peers.
   * @param {string[]} peerIds
   */
  probeAllPeers(peerIds) {
    for (const peerId of peerIds) {
      this.#sendFn(peerId, {
        type: GPU_PROBE,
        podId: this.#localCapability?.podId || null,
      })
    }
  }

  /**
   * Main message handler — dispatches based on msg.type.
   * @param {string} fromId
   * @param {object} msg
   */
  handleMessage(fromId, msg) {
    switch (msg.type) {
      case GPU_PROBE:
        // Respond with local capability
        if (this.#localCapability) {
          this.#sendFn(fromId, {
            type: GPU_PROBE,
            capability: this.#localCapability.toJSON(),
            response: true,
          })
        }
        break

      case GPU_SHARD_ASSIGN:
        // Received a shard assignment — acknowledge
        break

      case GPU_GRADIENT_PUSH:
        this.handleGradientPush(fromId, msg.shardId, msg.gradients)
        break

      case GPU_TRAIN_CONTROL:
        this.handleTrainControl(fromId, msg)
        break
    }
  }
}
