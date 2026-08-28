// Run with: node --import ./test/_setup-globals.mjs --test test/gpu.test.mjs
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  GPU_PROBE,
  GPU_SHARD_ASSIGN,
  GPU_GRADIENT_PUSH,
  GPU_TRAIN_CONTROL,
  GpuCapability,
  GpuProbe,
  TrainingSpec,
  TrainingShard,
  GradientAggregator,
  TrainingOrchestrator,
} from '../src/gpu.mjs'

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('GPU_PROBE is 0xD4', () => {
    assert.equal(GPU_PROBE, 0xD4)
  })

  it('GPU_SHARD_ASSIGN is 0xD5', () => {
    assert.equal(GPU_SHARD_ASSIGN, 0xD5)
  })

  it('GPU_GRADIENT_PUSH is 0xD6', () => {
    assert.equal(GPU_GRADIENT_PUSH, 0xD6)
  })

  it('GPU_TRAIN_CONTROL is 0xD7', () => {
    assert.equal(GPU_TRAIN_CONTROL, 0xD7)
  })
})

// ---------------------------------------------------------------------------
// GpuCapability
// ---------------------------------------------------------------------------

describe('GpuCapability', () => {
  it('constructor sets all fields', () => {
    const cap = new GpuCapability({
      podId: 'pod-1',
      hasWebGPU: true,
      hasWsh: true,
      maxBufferSize: 1024,
      adapterInfo: { vendor: 'nvidia', architecture: 'ampere', device: 'rtx3090', description: 'test' },
      limits: { maxBufferSize: 1024 },
    })
    assert.equal(cap.podId, 'pod-1')
    assert.equal(cap.hasWebGPU, true)
    assert.equal(cap.hasWsh, true)
    assert.equal(cap.maxBufferSize, 1024)
    assert.deepEqual(cap.adapterInfo, { vendor: 'nvidia', architecture: 'ampere', device: 'rtx3090', description: 'test' })
    assert.deepEqual(cap.limits, { maxBufferSize: 1024 })
  })

  it('defaults hasWebGPU=false, hasWsh=false, maxBufferSize=0', () => {
    const cap = new GpuCapability({ podId: 'pod-2' })
    assert.equal(cap.hasWebGPU, false)
    assert.equal(cap.hasWsh, false)
    assert.equal(cap.maxBufferSize, 0)
    assert.equal(cap.adapterInfo, null)
    assert.equal(cap.limits, null)
  })

  it('canTrain returns true when hasWebGPU and sufficient buffer', () => {
    const cap = new GpuCapability({ podId: 'pod-1', hasWebGPU: true, maxBufferSize: 2048 })
    const spec = new TrainingSpec({
      jobId: 'j1',
      modelConfig: { minBufferSize: 1024 },
      datasetRef: 'ds1',
    })
    assert.equal(cap.canTrain(spec), true)
  })

  it('canTrain returns false when no GPU and no wsh', () => {
    const cap = new GpuCapability({ podId: 'pod-1', hasWebGPU: false, hasWsh: false })
    assert.equal(cap.canTrain(), false)
  })

  it('toJSON/fromJSON roundtrip', () => {
    const cap = new GpuCapability({
      podId: 'pod-1',
      hasWebGPU: true,
      hasWsh: false,
      maxBufferSize: 512,
      adapterInfo: { vendor: 'amd' },
      limits: { maxTexture: 4096 },
    })
    const json = cap.toJSON()
    const restored = GpuCapability.fromJSON(json)
    assert.equal(restored.podId, 'pod-1')
    assert.equal(restored.hasWebGPU, true)
    assert.equal(restored.hasWsh, false)
    assert.equal(restored.maxBufferSize, 512)
    assert.deepEqual(restored.adapterInfo, { vendor: 'amd' })
    assert.deepEqual(restored.limits, { maxTexture: 4096 })
  })
})

// ---------------------------------------------------------------------------
// GpuProbe
// ---------------------------------------------------------------------------

describe('GpuProbe', () => {
  it('probe returns capability with hasWebGPU=false when navigator.gpu unavailable', async () => {
    // navigator.gpu is not set in test env
    const cap = await GpuProbe.probe('pod-test')
    assert.equal(cap.podId, 'pod-test')
    assert.equal(cap.hasWebGPU, false)
    assert.equal(cap.maxBufferSize, 0)
  })

  it('probe detects wsh connections when getWshConnections available', async () => {
    globalThis.getWshConnections = () => ['conn1', 'conn2']
    try {
      const cap = await GpuProbe.probe('pod-wsh')
      assert.equal(cap.hasWsh, true)
    } finally {
      delete globalThis.getWshConnections
    }
  })

  it('probe with mock navigator.gpu adapter', async () => {
    const origGpu = navigator.gpu
    try {
      Object.defineProperty(navigator, 'gpu', {
        value: {
          requestAdapter: async () => ({
            info: { vendor: 'test-vendor', architecture: 'test-arch', device: 'test-dev', description: 'test gpu' },
            limits: { maxBufferSize: 65536, maxStorageBufferBindingSize: 32768 },
          }),
        },
        configurable: true,
      })

      const cap = await GpuProbe.probe('pod-gpu')
      assert.equal(cap.hasWebGPU, true)
      assert.equal(cap.adapterInfo.vendor, 'test-vendor')
      assert.equal(cap.maxBufferSize, 65536)
    } finally {
      if (origGpu === undefined) {
        delete navigator.gpu
      } else {
        Object.defineProperty(navigator, 'gpu', { value: origGpu, configurable: true })
      }
    }
  })
})

// ---------------------------------------------------------------------------
// TrainingSpec
// ---------------------------------------------------------------------------

describe('TrainingSpec', () => {
  it('constructor sets all fields', () => {
    const spec = new TrainingSpec({
      jobId: 'j1',
      modelConfig: { layers: 3 },
      datasetRef: 'ds-abc',
      epochs: 5,
      batchSize: 64,
      learningRate: 0.01,
      strategy: 'federated_avg',
      shardCount: 4,
    })
    assert.equal(spec.jobId, 'j1')
    assert.deepEqual(spec.modelConfig, { layers: 3 })
    assert.equal(spec.datasetRef, 'ds-abc')
    assert.equal(spec.epochs, 5)
    assert.equal(spec.batchSize, 64)
    assert.equal(spec.learningRate, 0.01)
    assert.equal(spec.strategy, 'federated_avg')
    assert.equal(spec.shardCount, 4)
  })

  it('defaults (epochs=1, batchSize=32, etc.)', () => {
    const spec = new TrainingSpec({
      jobId: 'j2',
      modelConfig: {},
      datasetRef: 'ds-1',
    })
    assert.equal(spec.epochs, 1)
    assert.equal(spec.batchSize, 32)
    assert.equal(spec.learningRate, 0.001)
    assert.equal(spec.strategy, 'sync_allreduce')
    assert.equal(spec.shardCount, 1)
  })

  it('validate() passes with valid spec', () => {
    const spec = new TrainingSpec({ jobId: 'j3', modelConfig: { x: 1 }, datasetRef: 'ds' })
    assert.doesNotThrow(() => spec.validate())
  })

  it('validate() throws on missing jobId', () => {
    const spec = new TrainingSpec({ jobId: '', modelConfig: {}, datasetRef: 'ds' })
    assert.throws(() => spec.validate(), /jobId/)
  })

  it('validate() throws on invalid strategy', () => {
    const spec = new TrainingSpec({
      jobId: 'j4',
      modelConfig: {},
      datasetRef: 'ds',
      strategy: 'bad_strategy',
    })
    assert.throws(() => spec.validate(), /strategy/)
  })

  it('toJSON/fromJSON roundtrip', () => {
    const spec = new TrainingSpec({
      jobId: 'j5',
      modelConfig: { arch: 'transformer' },
      datasetRef: 'ds-5',
      epochs: 10,
      batchSize: 128,
      learningRate: 0.0005,
      strategy: 'async_parameter_server',
      shardCount: 8,
    })
    const json = spec.toJSON()
    const restored = TrainingSpec.fromJSON(json)
    assert.equal(restored.jobId, 'j5')
    assert.equal(restored.epochs, 10)
    assert.equal(restored.batchSize, 128)
    assert.equal(restored.strategy, 'async_parameter_server')
    assert.equal(restored.shardCount, 8)
  })
})

// ---------------------------------------------------------------------------
// TrainingShard
// ---------------------------------------------------------------------------

describe('TrainingShard', () => {
  it('constructor sets fields and defaults', () => {
    const shard = new TrainingShard({ shardId: 's1', jobId: 'j1' })
    assert.equal(shard.shardId, 's1')
    assert.equal(shard.jobId, 'j1')
    assert.equal(shard.podId, null)
    assert.equal(shard.dataRange, null)
    assert.equal(shard.parameters, null)
    assert.equal(shard.status, 'pending')
  })

  it('setResult stores gradients and metrics, sets status to completed', () => {
    const shard = new TrainingShard({ shardId: 's2', jobId: 'j1' })
    shard.setResult([0.1, 0.2], { loss: 0.5 })
    assert.equal(shard.status, 'completed')
    const result = shard.getResult()
    assert.deepEqual(result.gradients, [0.1, 0.2])
    assert.deepEqual(result.metrics, { loss: 0.5 })
  })

  it('getResult returns null initially', () => {
    const shard = new TrainingShard({ shardId: 's3', jobId: 'j1' })
    assert.equal(shard.getResult(), null)
  })

  it('getResult returns result after setResult', () => {
    const shard = new TrainingShard({ shardId: 's4', jobId: 'j1' })
    shard.setResult([1, 2, 3], { epoch: 1 })
    const result = shard.getResult()
    assert.ok(result !== null)
    assert.deepEqual(result.gradients, [1, 2, 3])
    assert.deepEqual(result.metrics, { epoch: 1 })
  })

  it('toJSON/fromJSON roundtrip', () => {
    const shard = new TrainingShard({
      shardId: 's5',
      jobId: 'j2',
      podId: 'pod-a',
      dataRange: { start: 0, end: 500 },
      parameters: { weights: [1, 2] },
      status: 'running',
    })
    const json = shard.toJSON()
    const restored = TrainingShard.fromJSON(json)
    assert.equal(restored.shardId, 's5')
    assert.equal(restored.jobId, 'j2')
    assert.equal(restored.podId, 'pod-a')
    assert.deepEqual(restored.dataRange, { start: 0, end: 500 })
    assert.equal(restored.status, 'running')
  })
})

// ---------------------------------------------------------------------------
// GradientAggregator
// ---------------------------------------------------------------------------

describe('GradientAggregator', () => {
  it('constructor creates instance', () => {
    const agg = new GradientAggregator({ strategy: 'sync_allreduce', parameterCount: 3 })
    assert.equal(agg.strategy, 'sync_allreduce')
    assert.equal(agg.parameterCount, 3)
  })

  it('submit stores gradient', () => {
    const agg = new GradientAggregator({ strategy: 'sync_allreduce', parameterCount: 2 })
    agg.submit('s1', [0.1, 0.2])
    assert.equal(agg.isReady(1), true)
  })

  it('isReady returns false when insufficient, true when enough', () => {
    const agg = new GradientAggregator({ strategy: 'sync_allreduce', parameterCount: 2 })
    assert.equal(agg.isReady(1), false)
    agg.submit('s1', [0.1, 0.2])
    assert.equal(agg.isReady(1), true)
    assert.equal(agg.isReady(2), false)
    agg.submit('s2', [0.3, 0.4])
    assert.equal(agg.isReady(2), true)
  })

  it('aggregate with sync_allreduce averages gradients', () => {
    const agg = new GradientAggregator({ strategy: 'sync_allreduce', parameterCount: 3 })
    agg.submit('s1', [2, 4, 6])
    agg.submit('s2', [4, 6, 8])
    const result = agg.aggregate()
    assert.deepEqual(result, [3, 5, 7])
  })

  it('aggregate with federated_avg does weighted average', () => {
    const agg = new GradientAggregator({ strategy: 'federated_avg', parameterCount: 2 })
    // s1 has weight 1, s2 has weight 3 → total weight 4
    // result[0] = (10*1 + 20*3) / 4 = 70/4 = 17.5
    // result[1] = (20*1 + 40*3) / 4 = 140/4 = 35
    agg.submit('s1', [10, 20], 1)
    agg.submit('s2', [20, 40], 3)
    const result = agg.aggregate()
    assert.equal(result[0], 17.5)
    assert.equal(result[1], 35)
  })

  it('reset clears all data', () => {
    const agg = new GradientAggregator({ strategy: 'sync_allreduce', parameterCount: 2 })
    agg.submit('s1', [1, 2])
    assert.equal(agg.isReady(1), true)
    agg.reset()
    assert.equal(agg.isReady(1), false)
  })

  it('aggregate with single gradient returns that gradient', () => {
    const agg = new GradientAggregator({ strategy: 'sync_allreduce', parameterCount: 3 })
    agg.submit('s1', [5, 10, 15])
    const result = agg.aggregate()
    assert.deepEqual(result, [5, 10, 15])
  })
})

// ---------------------------------------------------------------------------
// TrainingOrchestrator
// ---------------------------------------------------------------------------

describe('TrainingOrchestrator', () => {
  let sent
  let sendFn
  let orchestrator

  beforeEach(() => {
    sent = []
    sendFn = (targetId, msg) => sent.push({ targetId, msg })
    orchestrator = new TrainingOrchestrator({ sendFn })
  })

  it('constructor creates instance', () => {
    assert.ok(orchestrator)
  })

  it('registerPeer/removePeer', () => {
    const cap = new GpuCapability({ podId: 'p1', hasWebGPU: true })
    orchestrator.registerPeer('p1', cap)
    // After register, peer can be used; after remove, startJob should fail
    orchestrator.removePeer('p1')
    const spec = new TrainingSpec({ jobId: 'j-fail', modelConfig: {}, datasetRef: 'ds' })
    assert.throws(() => orchestrator.startJob(spec), /No capable peers/)
  })

  it('startJob assigns shards to capable peers', () => {
    const cap1 = new GpuCapability({ podId: 'p1', hasWebGPU: true })
    const cap2 = new GpuCapability({ podId: 'p2', hasWsh: true })
    orchestrator.registerPeer('p1', cap1)
    orchestrator.registerPeer('p2', cap2)

    const spec = new TrainingSpec({
      jobId: 'j-assign',
      modelConfig: { dataSize: 100 },
      datasetRef: 'ds',
      shardCount: 2,
    })
    orchestrator.startJob(spec)

    // Should have sent shard assignments to both peers
    const assigns = sent.filter(s => s.msg.type === GPU_SHARD_ASSIGN)
    assert.equal(assigns.length, 2)
  })

  it('startJob returns jobId', () => {
    const cap = new GpuCapability({ podId: 'p1', hasWebGPU: true })
    orchestrator.registerPeer('p1', cap)

    const spec = new TrainingSpec({
      jobId: 'j-ret',
      modelConfig: {},
      datasetRef: 'ds',
    })
    const jobId = orchestrator.startJob(spec)
    assert.equal(jobId, 'j-ret')
  })

  it('startJob throws if no capable peers', () => {
    const spec = new TrainingSpec({ jobId: 'j-none', modelConfig: {}, datasetRef: 'ds' })
    assert.throws(() => orchestrator.startJob(spec), /No capable peers/)
  })

  it('handleGradientPush aggregates correctly', () => {
    const cap = new GpuCapability({ podId: 'p1', hasWebGPU: true })
    orchestrator.registerPeer('p1', cap)

    const spec = new TrainingSpec({
      jobId: 'j-grad',
      modelConfig: { parameterCount: 2, dataSize: 100 },
      datasetRef: 'ds',
      shardCount: 1,
    })
    orchestrator.startJob(spec)

    // Find the shard ID from the sent message
    const assign = sent.find(s => s.msg.type === GPU_SHARD_ASSIGN)
    const shardId = assign.msg.shard.shardId

    orchestrator.handleGradientPush('p1', shardId, [0.5, 1.0])

    const status = orchestrator.getJobStatus('j-grad')
    assert.equal(status.completedShards, 1)
    assert.equal(status.aggregated, true)
  })

  it('getJobStatus returns correct status', () => {
    const cap = new GpuCapability({ podId: 'p1', hasWebGPU: true })
    orchestrator.registerPeer('p1', cap)

    const spec = new TrainingSpec({
      jobId: 'j-status',
      modelConfig: { dataSize: 100 },
      datasetRef: 'ds',
      shardCount: 2,
    })
    orchestrator.startJob(spec)

    const status = orchestrator.getJobStatus('j-status')
    assert.equal(status.jobId, 'j-status')
    assert.equal(status.status, 'running')
    assert.equal(status.shardCount, 2)
    assert.equal(status.completedShards, 0)
    assert.equal(status.aggregated, false)
  })

  it('getJobStatus returns not_found for unknown job', () => {
    const status = orchestrator.getJobStatus('nonexistent')
    assert.equal(status.status, 'not_found')
  })

  it('cancelJob sends cancel messages', () => {
    const cap = new GpuCapability({ podId: 'p1', hasWebGPU: true })
    orchestrator.registerPeer('p1', cap)

    const spec = new TrainingSpec({
      jobId: 'j-cancel',
      modelConfig: { dataSize: 100 },
      datasetRef: 'ds',
      shardCount: 1,
    })
    orchestrator.startJob(spec)
    sent.length = 0 // Clear assignment messages

    orchestrator.cancelJob('j-cancel')

    const cancels = sent.filter(s => s.msg.type === GPU_TRAIN_CONTROL && s.msg.action === 'cancel')
    assert.equal(cancels.length, 1)
    assert.equal(cancels[0].msg.jobId, 'j-cancel')

    const status = orchestrator.getJobStatus('j-cancel')
    assert.equal(status.status, 'cancelled')
  })

  it('probeAllPeers broadcasts GPU_PROBE', () => {
    orchestrator.probeAllPeers(['p1', 'p2', 'p3'])
    assert.equal(sent.length, 3)
    for (const s of sent) {
      assert.equal(s.msg.type, GPU_PROBE)
    }
    assert.equal(sent[0].targetId, 'p1')
    assert.equal(sent[1].targetId, 'p2')
    assert.equal(sent[2].targetId, 'p3')
  })

  it('handleMessage dispatches correctly', () => {
    // Set up local capability so handleMessage can respond to probes
    const localCap = new GpuCapability({ podId: 'local', hasWebGPU: true })
    const orch = new TrainingOrchestrator({ sendFn, localCapability: localCap })

    orch.handleMessage('remote-1', { type: GPU_PROBE })
    const probeResponses = sent.filter(s => s.msg.type === GPU_PROBE && s.msg.response === true)
    assert.equal(probeResponses.length, 1)
    assert.equal(probeResponses[0].targetId, 'remote-1')
  })

  it('handleProbeResponse registers peer', () => {
    const capJson = { podId: 'p-new', hasWebGPU: true, hasWsh: false, maxBufferSize: 1024 }
    orchestrator.handleProbeResponse('p-new', capJson)

    // Verify peer was registered by starting a job that requires it
    const spec = new TrainingSpec({
      jobId: 'j-probe-reg',
      modelConfig: { dataSize: 50 },
      datasetRef: 'ds',
    })
    const jobId = orchestrator.startJob(spec)
    assert.equal(jobId, 'j-probe-reg')
  })
})
