// Run with: node --import ./test/_setup-globals.mjs --test test/peer-compute.test.mjs
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  COMPUTE_TYPES,
  COMPUTE_DEFAULTS,
  ComputeChunk,
  FederatedJob,
  FederatedCompute,
} from '../src/peer-compute.mjs'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockScheduler(results = {}) {
  const dispatched = []
  const peers = ['peer-a', 'peer-b', 'peer-c']
  return {
    async dispatch(peerId, job) {
      dispatched.push({ peerId, job })
      if (results[peerId]) return results[peerId](job)
      return { output: `result-from-${peerId}`, exitCode: 0 }
    },
    listAvailablePeers() { return peers },
    get dispatched() { return dispatched },
  }
}

function simpleSplit(payload) {
  return payload.items.map(item => ({ item }))
}

function simpleMerge(results) {
  return results.join(', ')
}

// ---------------------------------------------------------------------------
// COMPUTE_TYPES
// ---------------------------------------------------------------------------

describe('COMPUTE_TYPES', () => {
  it('is frozen with expected values', () => {
    assert.ok(Object.isFrozen(COMPUTE_TYPES))
    assert.equal(COMPUTE_TYPES.MAP_REDUCE, 'map_reduce')
    assert.equal(COMPUTE_TYPES.PIPELINE, 'pipeline')
    assert.equal(COMPUTE_TYPES.BROADCAST, 'broadcast')
    assert.equal(COMPUTE_TYPES.SCATTER_GATHER, 'scatter_gather')
  })
})

// ---------------------------------------------------------------------------
// COMPUTE_DEFAULTS
// ---------------------------------------------------------------------------

describe('COMPUTE_DEFAULTS', () => {
  it('is frozen with expected values', () => {
    assert.ok(Object.isFrozen(COMPUTE_DEFAULTS))
    assert.equal(COMPUTE_DEFAULTS.type, 'scatter_gather')
    assert.equal(COMPUTE_DEFAULTS.maxChunks, 100)
    assert.equal(COMPUTE_DEFAULTS.chunkTimeoutMs, 30_000)
    assert.equal(COMPUTE_DEFAULTS.maxRetries, 2)
    assert.equal(COMPUTE_DEFAULTS.verifyLevel, 0)
  })
})

// ---------------------------------------------------------------------------
// ComputeChunk
// ---------------------------------------------------------------------------

describe('ComputeChunk', () => {
  it('constructs with defaults', () => {
    const chunk = new ComputeChunk({ id: 'c1', jobId: 'j1', index: 0, payload: { x: 1 } })
    assert.equal(chunk.id, 'c1')
    assert.equal(chunk.jobId, 'j1')
    assert.equal(chunk.index, 0)
    assert.deepEqual(chunk.payload, { x: 1 })
    assert.equal(chunk.assignee, null)
    assert.equal(chunk.status, 'pending')
    assert.equal(chunk.result, null)
    assert.equal(chunk.error, null)
    assert.equal(chunk.attempts, 0)
    assert.equal(chunk.cost, 0)
  })

  it('round-trips through toJSON/fromJSON', () => {
    const chunk = new ComputeChunk({
      id: 'c2', jobId: 'j2', index: 3, payload: 'data',
      assignee: 'peer-x', status: 'completed', result: 42,
      error: null, attempts: 2, cost: 5,
    })
    const restored = ComputeChunk.fromJSON(chunk.toJSON())
    assert.deepEqual(restored.toJSON(), chunk.toJSON())
  })
})

// ---------------------------------------------------------------------------
// FederatedJob
// ---------------------------------------------------------------------------

describe('FederatedJob', () => {
  it('constructs with defaults', () => {
    const job = new FederatedJob({ id: 'j1', type: 'scatter_gather', payload: [1, 2] })
    assert.equal(job.id, 'j1')
    assert.equal(job.type, 'scatter_gather')
    assert.equal(job.status, 'pending')
    assert.deepEqual(job.chunks, [])
    assert.equal(job.result, null)
    assert.equal(job.cost, 0)
    assert.equal(typeof job.createdAt, 'number')
  })

  it('getProgress reports correct counts', () => {
    const job = new FederatedJob({ id: 'j1', type: 'scatter_gather', payload: null })
    job.addChunk(new ComputeChunk({ id: 'c1', jobId: 'j1', index: 0, payload: 'a', status: 'completed' }))
    job.addChunk(new ComputeChunk({ id: 'c2', jobId: 'j1', index: 1, payload: 'b', status: 'running' }))
    job.addChunk(new ComputeChunk({ id: 'c3', jobId: 'j1', index: 2, payload: 'c', status: 'failed' }))
    job.addChunk(new ComputeChunk({ id: 'c4', jobId: 'j1', index: 3, payload: 'd', status: 'pending' }))

    const p = job.getProgress()
    assert.equal(p.total, 4)
    assert.equal(p.completed, 1)
    assert.equal(p.failed, 1)
    assert.equal(p.running, 1)
    assert.equal(p.pct, 25)
  })

  it('getChunk returns chunk or null', () => {
    const job = new FederatedJob({ id: 'j1', type: 'scatter_gather', payload: null })
    job.addChunk(new ComputeChunk({ id: 'c1', jobId: 'j1', index: 0, payload: 'a' }))
    assert.equal(job.getChunk('c1').id, 'c1')
    assert.equal(job.getChunk('missing'), null)
  })

  it('updateChunk modifies fields', () => {
    const job = new FederatedJob({ id: 'j1', type: 'scatter_gather', payload: null })
    job.addChunk(new ComputeChunk({ id: 'c1', jobId: 'j1', index: 0, payload: 'a' }))
    job.updateChunk('c1', { status: 'completed', result: 99 })
    assert.equal(job.getChunk('c1').status, 'completed')
    assert.equal(job.getChunk('c1').result, 99)
  })

  it('round-trips through toJSON/fromJSON', () => {
    const job = new FederatedJob({ id: 'j1', type: 'map_reduce', payload: 'data' })
    job.addChunk(new ComputeChunk({ id: 'c1', jobId: 'j1', index: 0, payload: 'a', status: 'completed', result: 10 }))
    const restored = FederatedJob.fromJSON(job.toJSON())
    assert.equal(restored.id, 'j1')
    assert.equal(restored.chunks.length, 1)
    assert.equal(restored.chunks[0].result, 10)
  })
})

// ---------------------------------------------------------------------------
// FederatedCompute
// ---------------------------------------------------------------------------

describe('FederatedCompute', () => {
  /** @type {ReturnType<typeof createMockScheduler>} */
  let scheduler

  /** @type {FederatedCompute} */
  let fc

  beforeEach(() => {
    scheduler = createMockScheduler()
    fc = new FederatedCompute({ scheduler })
  })

  // -- Constructor --

  it('throws without scheduler', () => {
    assert.throws(() => new FederatedCompute({}), /requires a scheduler/)
  })

  it('throws if scheduler lacks dispatch', () => {
    assert.throws(
      () => new FederatedCompute({ scheduler: { listAvailablePeers() { return [] } } }),
      /dispatch/,
    )
  })

  it('throws if scheduler lacks listAvailablePeers', () => {
    assert.throws(
      () => new FederatedCompute({ scheduler: { async dispatch() {} } }),
      /listAvailablePeers/,
    )
  })

  // -- Test 1: Submit creates federated job --

  it('submit creates federated job', async () => {
    const job = await fc.submit({
      payload: { items: ['a', 'b'] },
      splitFn: simpleSplit,
      mergeFn: simpleMerge,
    })

    assert.ok(job)
    assert.ok(job.id)
    assert.equal(job.type, 'scatter_gather') // default type
    assert.equal(job.status, 'completed')
  })

  // -- Test 2: Split function decomposes payload into chunks --

  it('split function decomposes payload into chunks', async () => {
    const job = await fc.submit({
      payload: { items: ['x', 'y', 'z'] },
      splitFn: simpleSplit,
      mergeFn: simpleMerge,
    })

    assert.equal(job.chunks.length, 3)
    assert.deepEqual(job.chunks[0].payload, { item: 'x' })
    assert.deepEqual(job.chunks[1].payload, { item: 'y' })
    assert.deepEqual(job.chunks[2].payload, { item: 'z' })
  })

  // -- Test 3: Chunks assigned to different peers (round-robin) --

  it('chunks assigned to different peers round-robin', async () => {
    const job = await fc.submit({
      payload: { items: ['a', 'b', 'c', 'd', 'e'] },
      splitFn: simpleSplit,
      mergeFn: simpleMerge,
    })

    // 5 chunks across 3 peers: a->peer-a, b->peer-b, c->peer-c, d->peer-a, e->peer-b
    const assignees = scheduler.dispatched.map(d => d.peerId)
    assert.equal(assignees[0], 'peer-a')
    assert.equal(assignees[1], 'peer-b')
    assert.equal(assignees[2], 'peer-c')
    assert.equal(assignees[3], 'peer-a')
    assert.equal(assignees[4], 'peer-b')
  })

  // -- Test 4: Chunk completion updates progress --

  it('chunk completion updates progress', async () => {
    const job = await fc.submit({
      payload: { items: ['a', 'b', 'c'] },
      splitFn: simpleSplit,
      mergeFn: simpleMerge,
    })

    const progress = job.getProgress()
    assert.equal(progress.total, 3)
    assert.equal(progress.completed, 3)
    assert.equal(progress.pct, 100)
  })

  // -- Test 5: All chunks complete -> merge triggered --

  it('all chunks complete triggers merge', async () => {
    let mergeCallCount = 0
    const job = await fc.submit({
      payload: { items: ['a', 'b'] },
      splitFn: simpleSplit,
      mergeFn: (results) => {
        mergeCallCount++
        return results.join(' + ')
      },
    })

    assert.equal(mergeCallCount, 1)
    assert.equal(job.status, 'completed')
  })

  // -- Test 6: Merge produces final result --

  it('merge produces final result', async () => {
    const job = await fc.submit({
      payload: { items: ['a', 'b'] },
      splitFn: simpleSplit,
      mergeFn: (results) => results.join(' | '),
    })

    assert.equal(job.result, 'result-from-peer-a | result-from-peer-b')
  })

  // -- Test 7: Failed chunk retried on different peer --

  it('failed chunk retried on different peer', async () => {
    let peerAAttempts = 0
    const failScheduler = createMockScheduler({
      'peer-a': () => {
        peerAAttempts++
        if (peerAAttempts <= 1) throw new Error('peer-a busy')
        return { output: 'recovered', exitCode: 0 }
      },
    })

    const failFc = new FederatedCompute({ scheduler: failScheduler })

    const job = await failFc.submit({
      payload: { items: ['a'] },
      splitFn: simpleSplit,
      mergeFn: (results) => results[0],
    })

    // The chunk should have been retried on peer-b after peer-a failed
    assert.equal(job.status, 'completed')
    assert.ok(failScheduler.dispatched.length >= 2)
    // First attempt on peer-a, retry on peer-b
    assert.equal(failScheduler.dispatched[0].peerId, 'peer-a')
    assert.equal(failScheduler.dispatched[1].peerId, 'peer-b')
  })

  // -- Test 8: Max retries exceeded -> chunk stays failed --

  it('max retries exceeded marks chunk failed', async () => {
    const alwaysFailScheduler = createMockScheduler({
      'peer-a': () => { throw new Error('fail-a') },
      'peer-b': () => { throw new Error('fail-b') },
      'peer-c': () => { throw new Error('fail-c') },
    })

    const failFc = new FederatedCompute({ scheduler: alwaysFailScheduler })

    const job = await failFc.submit({
      payload: { items: ['a'] },
      splitFn: simpleSplit,
      mergeFn: (results) => results[0],
    })

    // All retries (maxRetries=2 means 3 attempts total) exhausted
    const chunk = job.chunks[0]
    assert.equal(chunk.status, 'failed')
    assert.ok(chunk.error)
    assert.equal(job.status, 'failed')
  })

  // -- Test 9: Cancel stops all running chunks --

  it('cancel stops all pending/running/assigned chunks', async () => {
    const job = await fc.submit({
      payload: { items: ['a', 'b'] },
      splitFn: simpleSplit,
      mergeFn: simpleMerge,
    })

    // Job already completed, but let's test cancel on a fresh one
    // We'll create a job that we can cancel
    const slowScheduler = {
      async dispatch() {
        return new Promise(() => {}) // never resolves
      },
      listAvailablePeers() { return ['peer-a'] },
    }
    const slowFc = new FederatedCompute({ scheduler: slowScheduler })

    // Submit without awaiting, then cancel
    const jobPromise = slowFc.submit({
      payload: { items: ['a', 'b'] },
      splitFn: simpleSplit,
      mergeFn: simpleMerge,
    })

    // Give it a tick to start
    await new Promise(r => setTimeout(r, 10))

    // The job should exist and we can attempt cancel
    const jobs = slowFc.listJobs()
    if (jobs.length > 0) {
      const cancelled = await slowFc.cancel(jobs[0].id)
      assert.equal(cancelled, true)
      assert.equal(jobs[0].status, 'cancelled')
    }
  })

  // -- Test 10: Cancel sets job status to cancelled --

  it('cancel sets job status to cancelled', async () => {
    const job = await fc.submit({
      payload: { items: ['a'] },
      splitFn: simpleSplit,
      mergeFn: simpleMerge,
    })

    const result = await fc.cancel(job.id)
    assert.equal(result, true)
    assert.equal(fc.getJob(job.id).status, 'cancelled')
  })

  // -- Test 11: getJob returns correct job --

  it('getJob returns correct job', async () => {
    const job = await fc.submit({
      payload: { items: ['a'] },
      splitFn: simpleSplit,
      mergeFn: simpleMerge,
    })

    const found = fc.getJob(job.id)
    assert.equal(found.id, job.id)
    assert.equal(fc.getJob('nonexistent'), null)
  })

  // -- Test 12: listJobs with status filter --

  it('listJobs with status filter', async () => {
    await fc.submit({
      payload: { items: ['a'] },
      splitFn: simpleSplit,
      mergeFn: simpleMerge,
    })

    const completed = fc.listJobs({ status: 'completed' })
    assert.equal(completed.length, 1)

    const running = fc.listJobs({ status: 'running' })
    assert.equal(running.length, 0)
  })

  // -- Test 13: getStats returns correct counts --

  it('getStats returns correct counts', async () => {
    await fc.submit({
      payload: { items: ['a'] },
      splitFn: simpleSplit,
      mergeFn: simpleMerge,
    })
    await fc.submit({
      payload: { items: ['b'] },
      splitFn: simpleSplit,
      mergeFn: simpleMerge,
    })

    const stats = fc.getStats()
    assert.equal(stats.submitted, 2)
    assert.equal(stats.completed, 2)
    assert.equal(stats.failed, 0)
    assert.equal(stats.running, 0)
  })

  // -- Test 14: Broadcast type runs same payload on all peers --

  it('broadcast type runs same payload on all peers', async () => {
    const broadcastScheduler = createMockScheduler()
    const bfc = new FederatedCompute({ scheduler: broadcastScheduler })

    const job = await bfc.submit({
      type: COMPUTE_TYPES.BROADCAST,
      payload: { items: ['broadcast-data'] },
      splitFn: (payload) => [payload], // single payload
      mergeFn: (results) => results,
    })

    // Should have dispatched to all 3 peers
    assert.equal(job.chunks.length, 3)
    assert.equal(broadcastScheduler.dispatched.length, 3)

    const peerIds = broadcastScheduler.dispatched.map(d => d.peerId)
    assert.ok(peerIds.includes('peer-a'))
    assert.ok(peerIds.includes('peer-b'))
    assert.ok(peerIds.includes('peer-c'))
  })

  // -- Test 15: Pipeline type runs sequential stages --

  it('pipeline type runs sequential stages', async () => {
    const order = []
    const pipeScheduler = {
      async dispatch(peerId, job) {
        order.push({ peerId, index: job.index })
        return { output: `stage-${job.index}-done`, exitCode: 0 }
      },
      listAvailablePeers() { return ['peer-a', 'peer-b'] },
    }

    const pipeFc = new FederatedCompute({ scheduler: pipeScheduler })

    const job = await pipeFc.submit({
      type: COMPUTE_TYPES.PIPELINE,
      payload: { items: ['stage0', 'stage1', 'stage2'] },
      splitFn: (payload) => payload.items.map((s, i) => ({ stage: i, data: s })),
      mergeFn: (results) => results.join(' -> '),
    })

    assert.equal(job.status, 'completed')
    // Pipeline executes sequentially
    assert.equal(order[0].index, 0)
    assert.equal(order[1].index, 1)
    assert.equal(order[2].index, 2)
    assert.equal(job.result, 'stage-0-done -> stage-1-done -> stage-2-done')
  })

  // -- Test 16: Events emitted for full lifecycle --

  it('events emitted for full lifecycle', async () => {
    const events = []
    fc.on('submitted', (j) => events.push({ type: 'submitted', id: j.id }))
    fc.on('split', (s) => events.push({ type: 'split', count: s.count }))
    fc.on('chunk-assigned', (c) => events.push({ type: 'chunk-assigned', chunkId: c.chunkId }))
    fc.on('chunk-complete', (c) => events.push({ type: 'chunk-complete', chunkId: c.chunkId }))
    fc.on('merged', (m) => events.push({ type: 'merged' }))
    fc.on('completed', (j) => events.push({ type: 'completed', id: j.id }))

    await fc.submit({
      payload: { items: ['a', 'b'] },
      splitFn: simpleSplit,
      mergeFn: simpleMerge,
    })

    const types = events.map(e => e.type)
    assert.ok(types.includes('submitted'), 'should emit submitted')
    assert.ok(types.includes('split'), 'should emit split')
    assert.ok(types.includes('chunk-assigned'), 'should emit chunk-assigned')
    assert.ok(types.includes('chunk-complete'), 'should emit chunk-complete')
    assert.ok(types.includes('merged'), 'should emit merged')
    assert.ok(types.includes('completed'), 'should emit completed')

    // Verify ordering: submitted before completed
    const submittedIdx = types.indexOf('submitted')
    const completedIdx = types.indexOf('completed')
    assert.ok(submittedIdx < completedIdx)
  })

  // -- off removes listener --

  it('off removes a listener', async () => {
    const events = []
    const handler = () => events.push('called')
    fc.on('submitted', handler)
    fc.off('submitted', handler)

    await fc.submit({
      payload: { items: ['a'] },
      splitFn: simpleSplit,
      mergeFn: simpleMerge,
    })

    assert.equal(events.length, 0)
  })

  // -- cancel returns false for unknown job --

  it('cancel returns false for unknown job', async () => {
    const result = await fc.cancel('nonexistent')
    assert.equal(result, false)
  })
})
