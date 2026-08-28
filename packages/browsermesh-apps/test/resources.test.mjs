// Run with: node --import ./test/_setup-globals.mjs --test test/resources.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  RESOURCE_ADVERTISE,
  RESOURCE_DISCOVER,
  RESOURCE_DISCOVER_RESPONSE,
  COMPUTE_REQUEST,
  COMPUTE_RESULT,
  COMPUTE_PROGRESS,
  ResourceDescriptor,
  ResourceRegistry,
  ComputeRequest,
  ComputeResult,
  ResourceScorer,
  JobQueue,
} from '../src/resources.mjs';

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('RESOURCE_ADVERTISE equals 0xC7', () => {
    assert.equal(RESOURCE_ADVERTISE, 0xc7);
  });

  it('RESOURCE_DISCOVER equals 0xC8', () => {
    assert.equal(RESOURCE_DISCOVER, 0xc8);
  });

  it('RESOURCE_DISCOVER_RESPONSE equals 0xC9', () => {
    assert.equal(RESOURCE_DISCOVER_RESPONSE, 0xc9);
  });

  it('COMPUTE_REQUEST equals 0xCA', () => {
    assert.equal(COMPUTE_REQUEST, 0xca);
  });

  it('COMPUTE_RESULT equals 0xCB', () => {
    assert.equal(COMPUTE_RESULT, 0xcb);
  });

  it('COMPUTE_PROGRESS equals 0xCC', () => {
    assert.equal(COMPUTE_PROGRESS, 0xcc);
  });
});

// ---------------------------------------------------------------------------
// ResourceDescriptor
// ---------------------------------------------------------------------------

describe('ResourceDescriptor', () => {
  it('constructor sets all fields', () => {
    const d = new ResourceDescriptor({
      podId: 'pod-1',
      resources: { cpu: 4, gpu: 1, memory: 8192, storage: 50000, bandwidth: 100 },
      capabilities: ['wasm', 'gpu-compute'],
      availability: 'busy',
      updatedAt: 1000,
      ttl: 30000,
    });
    assert.equal(d.podId, 'pod-1');
    assert.equal(d.resources.cpu, 4);
    assert.equal(d.resources.gpu, 1);
    assert.equal(d.resources.memory, 8192);
    assert.equal(d.resources.storage, 50000);
    assert.equal(d.resources.bandwidth, 100);
    assert.deepEqual(d.capabilities, ['wasm', 'gpu-compute']);
    assert.equal(d.availability, 'busy');
    assert.equal(d.updatedAt, 1000);
    assert.equal(d.ttl, 30000);
  });

  it('applies defaults for omitted fields', () => {
    const d = new ResourceDescriptor({ podId: 'pod-2' });
    assert.equal(d.resources.cpu, 0);
    assert.equal(d.resources.gpu, 0);
    assert.equal(d.resources.memory, 0);
    assert.equal(d.resources.storage, 0);
    assert.equal(d.resources.bandwidth, 0);
    assert.deepEqual(d.capabilities, []);
    assert.equal(d.availability, 'online');
    assert.equal(d.ttl, 60_000);
    assert.equal(typeof d.updatedAt, 'number');
  });

  it('throws when podId is missing', () => {
    assert.throws(() => new ResourceDescriptor({}), /podId is required/);
  });

  it('throws when podId is empty string', () => {
    assert.throws(() => new ResourceDescriptor({ podId: '' }), /podId is required/);
  });

  it('copies capabilities array', () => {
    const caps = ['a', 'b'];
    const d = new ResourceDescriptor({ podId: 'p', capabilities: caps });
    caps.push('c');
    assert.deepEqual(d.capabilities, ['a', 'b']);
  });

  // -- matches --------------------------------------------------------------

  it('matches returns true with no constraints', () => {
    const d = new ResourceDescriptor({ podId: 'p' });
    assert.ok(d.matches());
    assert.ok(d.matches(null));
    assert.ok(d.matches(undefined));
  });

  it('matches checks availability', () => {
    const d = new ResourceDescriptor({ podId: 'p', availability: 'busy' });
    assert.ok(!d.matches({ availability: 'online' }));
    assert.ok(d.matches({ availability: 'busy' }));
  });

  it('matches checks resource minimums', () => {
    const d = new ResourceDescriptor({
      podId: 'p',
      resources: { cpu: 4, memory: 8192 },
    });
    assert.ok(d.matches({ cpu: 2 }));
    assert.ok(d.matches({ cpu: 4 }));
    assert.ok(!d.matches({ cpu: 8 }));
    assert.ok(d.matches({ memory: 4096 }));
    assert.ok(!d.matches({ memory: 16384 }));
  });

  it('matches checks required capabilities', () => {
    const d = new ResourceDescriptor({
      podId: 'p',
      capabilities: ['wasm', 'js'],
    });
    assert.ok(d.matches({ capabilities: ['wasm'] }));
    assert.ok(d.matches({ capabilities: ['wasm', 'js'] }));
    assert.ok(!d.matches({ capabilities: ['wasm', 'gpu'] }));
  });

  it('matches combines constraints', () => {
    const d = new ResourceDescriptor({
      podId: 'p',
      resources: { cpu: 4, gpu: 1 },
      capabilities: ['wasm'],
      availability: 'online',
    });
    assert.ok(d.matches({ cpu: 2, capabilities: ['wasm'], availability: 'online' }));
    assert.ok(!d.matches({ cpu: 2, capabilities: ['wasm'], availability: 'busy' }));
  });

  // -- isExpired ------------------------------------------------------------

  it('isExpired returns false before TTL', () => {
    const d = new ResourceDescriptor({ podId: 'p', updatedAt: 1000, ttl: 500 });
    assert.ok(!d.isExpired(1499));
  });

  it('isExpired returns true after TTL', () => {
    const d = new ResourceDescriptor({ podId: 'p', updatedAt: 1000, ttl: 500 });
    assert.ok(d.isExpired(1501));
  });

  // -- toJSON / fromJSON ----------------------------------------------------

  it('round-trips via JSON', () => {
    const d = new ResourceDescriptor({
      podId: 'pod-rt',
      resources: { cpu: 8, gpu: 2, memory: 16384, storage: 100000, bandwidth: 200 },
      capabilities: ['wasm', 'gpu-compute'],
      availability: 'online',
      updatedAt: 5000,
      ttl: 45000,
    });
    const d2 = ResourceDescriptor.fromJSON(d.toJSON());
    assert.deepEqual(d2.toJSON(), d.toJSON());
    assert.ok(d2 instanceof ResourceDescriptor);
  });

  it('toJSON returns capabilities copy', () => {
    const d = new ResourceDescriptor({ podId: 'p', capabilities: ['x'] });
    const json = d.toJSON();
    json.capabilities.push('y');
    assert.deepEqual(d.capabilities, ['x']);
  });
});

// ---------------------------------------------------------------------------
// ResourceRegistry
// ---------------------------------------------------------------------------

describe('ResourceRegistry', () => {
  /** @type {ResourceRegistry} */
  let reg;

  beforeEach(() => {
    reg = new ResourceRegistry();
  });

  it('advertise adds a descriptor', () => {
    const d = new ResourceDescriptor({ podId: 'p1', resources: { cpu: 4 } });
    reg.advertise(d);
    assert.equal(reg.size, 1);
    assert.equal(reg.get('p1').podId, 'p1');
  });

  it('advertise upserts by podId', () => {
    const d1 = new ResourceDescriptor({ podId: 'p1', resources: { cpu: 2 } });
    const d2 = new ResourceDescriptor({ podId: 'p1', resources: { cpu: 8 } });
    reg.advertise(d1);
    reg.advertise(d2);
    assert.equal(reg.size, 1);
    assert.equal(reg.get('p1').resources.cpu, 8);
  });

  it('advertise refreshes updatedAt', () => {
    const d = new ResourceDescriptor({ podId: 'p1', updatedAt: 1 });
    reg.advertise(d);
    assert.ok(d.updatedAt > 1);
  });

  it('advertise throws when full', () => {
    const r = new ResourceRegistry({ maxEntries: 2 });
    r.advertise(new ResourceDescriptor({ podId: 'a' }));
    r.advertise(new ResourceDescriptor({ podId: 'b' }));
    assert.throws(
      () => r.advertise(new ResourceDescriptor({ podId: 'c' })),
      /full/,
    );
  });

  it('withdraw removes a descriptor', () => {
    reg.advertise(new ResourceDescriptor({ podId: 'p1' }));
    assert.ok(reg.withdraw('p1'));
    assert.equal(reg.size, 0);
    assert.equal(reg.get('p1'), null);
  });

  it('withdraw returns false for unknown podId', () => {
    assert.ok(!reg.withdraw('nope'));
  });

  it('get returns null for unknown podId', () => {
    assert.equal(reg.get('nope'), null);
  });

  // -- discover -------------------------------------------------------------

  it('discover returns all non-expired entries with no constraints', () => {
    reg.advertise(new ResourceDescriptor({ podId: 'a' }));
    reg.advertise(new ResourceDescriptor({ podId: 'b' }));
    assert.equal(reg.discover().length, 2);
  });

  it('discover filters by constraints', () => {
    reg.advertise(new ResourceDescriptor({ podId: 'a', resources: { cpu: 2 } }));
    reg.advertise(new ResourceDescriptor({ podId: 'b', resources: { cpu: 8 } }));
    const found = reg.discover({ cpu: 4 });
    assert.equal(found.length, 1);
    assert.equal(found[0].podId, 'b');
  });

  it('discover skips expired entries', () => {
    const d = new ResourceDescriptor({ podId: 'old', ttl: 1, updatedAt: 1 });
    reg.advertise(d);
    // Force the updatedAt back to make it expired
    d.updatedAt = 1;
    assert.equal(reg.discover().length, 0);
  });

  // -- pruneExpired ---------------------------------------------------------

  it('pruneExpired removes expired entries', () => {
    const d1 = new ResourceDescriptor({ podId: 'old', ttl: 1 });
    const d2 = new ResourceDescriptor({ podId: 'fresh', ttl: 999_999_999 });
    reg.advertise(d1);
    reg.advertise(d2);
    // Force old to be expired
    d1.updatedAt = 1;
    const count = reg.pruneExpired();
    assert.equal(count, 1);
    assert.equal(reg.size, 1);
    assert.equal(reg.get('old'), null);
    assert.ok(reg.get('fresh'));
  });

  it('pruneExpired returns 0 when nothing to prune', () => {
    reg.advertise(new ResourceDescriptor({ podId: 'a' }));
    assert.equal(reg.pruneExpired(), 0);
  });

  // -- listAll --------------------------------------------------------------

  it('listAll returns all entries including expired', () => {
    const d = new ResourceDescriptor({ podId: 'old', ttl: 1 });
    reg.advertise(d);
    d.updatedAt = 1;
    reg.advertise(new ResourceDescriptor({ podId: 'new' }));
    assert.equal(reg.listAll().length, 2);
  });

  // -- toJSON / fromJSON ----------------------------------------------------

  it('round-trips via JSON', () => {
    reg.advertise(new ResourceDescriptor({ podId: 'a', resources: { cpu: 4 } }));
    reg.advertise(new ResourceDescriptor({ podId: 'b', capabilities: ['wasm'] }));
    const reg2 = ResourceRegistry.fromJSON(reg.toJSON());
    assert.equal(reg2.size, 2);
    assert.equal(reg2.get('a').resources.cpu, 4);
    assert.deepEqual(reg2.get('b').capabilities, ['wasm']);
  });
});

// ---------------------------------------------------------------------------
// ComputeRequest
// ---------------------------------------------------------------------------

describe('ComputeRequest', () => {
  it('constructor sets all fields', () => {
    const r = new ComputeRequest({
      jobId: 'j1',
      moduleType: 'wasm',
      moduleCid: 'bafy123',
      entry: 'main',
      input: { x: 1 },
      constraints: { prefer: 'gpu', timeoutMs: 5000, maxMemoryMb: 512, priority: 3 },
      requesterId: 'pod-a',
      timestamp: 9000,
    });
    assert.equal(r.jobId, 'j1');
    assert.equal(r.moduleType, 'wasm');
    assert.equal(r.moduleCid, 'bafy123');
    assert.equal(r.entry, 'main');
    assert.deepEqual(r.input, { x: 1 });
    assert.equal(r.constraints.prefer, 'gpu');
    assert.equal(r.constraints.timeoutMs, 5000);
    assert.equal(r.constraints.maxMemoryMb, 512);
    assert.equal(r.constraints.priority, 3);
    assert.equal(r.requesterId, 'pod-a');
    assert.equal(r.timestamp, 9000);
  });

  it('generates jobId when not provided', () => {
    const r = new ComputeRequest({
      moduleType: 'js',
      moduleCid: 'cid',
      entry: 'run',
      requesterId: 'me',
    });
    assert.ok(r.jobId.startsWith('job_'));
  });

  it('applies default constraints', () => {
    const r = new ComputeRequest({
      moduleType: 'js',
      moduleCid: 'cid',
      entry: 'run',
      requesterId: 'me',
    });
    assert.equal(r.constraints.prefer, 'any');
    assert.equal(r.constraints.timeoutMs, 30_000);
    assert.equal(r.constraints.maxMemoryMb, null);
    assert.equal(r.constraints.priority, 0);
  });

  it('round-trips via JSON', () => {
    const r = new ComputeRequest({
      jobId: 'j-rt',
      moduleType: 'wasm',
      moduleCid: 'cid',
      entry: 'process',
      input: [1, 2, 3],
      constraints: { prefer: 'cpu', timeoutMs: 10000 },
      requesterId: 'pod-b',
      timestamp: 7000,
    });
    const r2 = ComputeRequest.fromJSON(r.toJSON());
    assert.deepEqual(r2.toJSON(), r.toJSON());
    assert.ok(r2 instanceof ComputeRequest);
  });
});

// ---------------------------------------------------------------------------
// ComputeResult
// ---------------------------------------------------------------------------

describe('ComputeResult', () => {
  it('constructor sets all fields', () => {
    const r = new ComputeResult({
      jobId: 'j1',
      status: 'success',
      result: { answer: 42 },
      metrics: {
        executorId: 'pod-x',
        startTime: 1000,
        endTime: 2000,
        cpuTimeMs: 800,
        memoryPeakMb: 128,
      },
    });
    assert.equal(r.jobId, 'j1');
    assert.equal(r.status, 'success');
    assert.deepEqual(r.result, { answer: 42 });
    assert.equal(r.error, null);
    assert.equal(r.metrics.executorId, 'pod-x');
    assert.equal(r.metrics.startTime, 1000);
    assert.equal(r.metrics.endTime, 2000);
    assert.equal(r.metrics.cpuTimeMs, 800);
    assert.equal(r.metrics.memoryPeakMb, 128);
  });

  it('durationMs computes endTime - startTime', () => {
    const r = new ComputeResult({
      jobId: 'j1',
      status: 'success',
      metrics: { startTime: 1000, endTime: 3500 },
    });
    assert.equal(r.durationMs, 2500);
  });

  it('durationMs returns 0 when timestamps are missing', () => {
    const r = new ComputeResult({ jobId: 'j1', status: 'error' });
    assert.equal(r.durationMs, 0);
  });

  it('stores error for failure results', () => {
    const r = new ComputeResult({
      jobId: 'j1',
      status: 'error',
      error: 'OOM',
    });
    assert.equal(r.status, 'error');
    assert.equal(r.error, 'OOM');
    assert.equal(r.result, null);
  });

  it('round-trips via JSON', () => {
    const r = new ComputeResult({
      jobId: 'j-rt',
      status: 'timeout',
      error: 'Exceeded 30s',
      metrics: { executorId: 'pod-z', startTime: 100, endTime: 30100, cpuTimeMs: 29000, memoryPeakMb: 256 },
    });
    const r2 = ComputeResult.fromJSON(r.toJSON());
    assert.deepEqual(r2.toJSON(), r.toJSON());
    assert.ok(r2 instanceof ComputeResult);
    assert.equal(r2.durationMs, 30000);
  });
});

// ---------------------------------------------------------------------------
// ResourceScorer
// ---------------------------------------------------------------------------

describe('ResourceScorer', () => {
  const makeRequest = (overrides = {}) =>
    new ComputeRequest({
      moduleType: 'wasm',
      moduleCid: 'cid',
      entry: 'main',
      requesterId: 'me',
      ...overrides,
    });

  it('offline descriptors score zero', () => {
    const req = makeRequest();
    const desc = new ResourceDescriptor({ podId: 'p', availability: 'offline' });
    assert.equal(ResourceScorer.score(req, desc), 0);
  });

  it('online scores higher than busy', () => {
    const req = makeRequest();
    const online = new ResourceDescriptor({ podId: 'a', availability: 'online', resources: { cpu: 4 } });
    const busy = new ResourceDescriptor({ podId: 'b', availability: 'busy', resources: { cpu: 4 } });
    assert.ok(ResourceScorer.score(req, online) > ResourceScorer.score(req, busy));
  });

  it('gpu preference boosts gpu-capable nodes', () => {
    const req = makeRequest({ constraints: { prefer: 'gpu' } });
    const withGpu = new ResourceDescriptor({ podId: 'a', resources: { gpu: 1, cpu: 4 } });
    const noGpu = new ResourceDescriptor({ podId: 'b', resources: { gpu: 0, cpu: 4 } });
    assert.ok(ResourceScorer.score(req, withGpu) > ResourceScorer.score(req, noGpu));
  });

  it('cpu preference boosts cpu-rich nodes', () => {
    const req = makeRequest({ constraints: { prefer: 'cpu' } });
    const rich = new ResourceDescriptor({ podId: 'a', resources: { cpu: 8 } });
    const poor = new ResourceDescriptor({ podId: 'b', resources: { cpu: 0 } });
    assert.ok(ResourceScorer.score(req, rich) > ResourceScorer.score(req, poor));
  });

  it('memory headroom contributes to score', () => {
    const req = makeRequest({ constraints: { maxMemoryMb: 1024 } });
    const big = new ResourceDescriptor({ podId: 'a', resources: { memory: 8192 } });
    const small = new ResourceDescriptor({ podId: 'b', resources: { memory: 1024 } });
    assert.ok(ResourceScorer.score(req, big) > ResourceScorer.score(req, small));
  });

  // -- selectBest -----------------------------------------------------------

  it('selectBest returns the highest-scoring descriptor', () => {
    const req = makeRequest({ constraints: { prefer: 'gpu' } });
    const descs = [
      new ResourceDescriptor({ podId: 'a', resources: { cpu: 2 } }),
      new ResourceDescriptor({ podId: 'b', resources: { cpu: 4, gpu: 2, memory: 8192 } }),
      new ResourceDescriptor({ podId: 'c', resources: { cpu: 4 } }),
    ];
    const best = ResourceScorer.selectBest(req, descs);
    assert.equal(best.podId, 'b');
  });

  it('selectBest returns null for empty array', () => {
    const req = makeRequest();
    assert.equal(ResourceScorer.selectBest(req, []), null);
  });

  it('selectBest returns null for null input', () => {
    const req = makeRequest();
    assert.equal(ResourceScorer.selectBest(req, null), null);
  });
});

// ---------------------------------------------------------------------------
// JobQueue
// ---------------------------------------------------------------------------

describe('JobQueue', () => {
  /** @type {JobQueue} */
  let q;

  const makeReq = (overrides = {}) =>
    new ComputeRequest({
      moduleType: 'js',
      moduleCid: 'cid',
      entry: 'run',
      requesterId: 'me',
      ...overrides,
    });

  beforeEach(() => {
    q = new JobQueue();
  });

  it('submit adds a job and returns jobId', () => {
    const req = makeReq({ jobId: 'j1' });
    const id = q.submit(req);
    assert.equal(id, 'j1');
    assert.equal(q.size, 1);
  });

  it('submit throws when full', () => {
    const small = new JobQueue({ maxJobs: 1 });
    small.submit(makeReq({ jobId: 'j1' }));
    assert.throws(() => small.submit(makeReq({ jobId: 'j2' })), /full/);
  });

  it('get returns job record', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    const job = q.get('j1');
    assert.ok(job);
    assert.equal(job.status, 'pending');
    assert.equal(job.request.jobId, 'j1');
    assert.equal(job.assignedTo, null);
    assert.equal(job.result, null);
    assert.ok(job.submittedAt);
  });

  it('get returns null for unknown jobId', () => {
    assert.equal(q.get('nope'), null);
  });

  it('get returns a copy (mutations do not leak)', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    const job = q.get('j1');
    job.status = 'hacked';
    assert.equal(q.get('j1').status, 'pending');
  });

  // -- assign ---------------------------------------------------------------

  it('assign sets status to assigned and records executor', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    assert.ok(q.assign('j1', 'executor-pod'));
    const job = q.get('j1');
    assert.equal(job.status, 'assigned');
    assert.equal(job.assignedTo, 'executor-pod');
    assert.ok(job.startedAt);
  });

  it('assign returns false for non-pending job', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    q.assign('j1', 'exec');
    assert.ok(!q.assign('j1', 'exec2'));
  });

  it('assign returns false for unknown jobId', () => {
    assert.ok(!q.assign('nope', 'exec'));
  });

  // -- complete -------------------------------------------------------------

  it('complete marks job as completed', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    q.assign('j1', 'exec');
    const result = new ComputeResult({
      jobId: 'j1',
      status: 'success',
      result: 42,
      metrics: { executorId: 'exec', startTime: 1, endTime: 2 },
    });
    assert.ok(q.complete('j1', result));
    const job = q.get('j1');
    assert.equal(job.status, 'completed');
    assert.equal(job.result.result, 42);
    assert.ok(job.completedAt);
  });

  it('complete with error sets error status', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    const result = new ComputeResult({ jobId: 'j1', status: 'error', error: 'OOM' });
    assert.ok(q.complete('j1', result));
    assert.equal(q.get('j1').status, 'error');
  });

  it('complete returns false for already completed job', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    q.complete('j1', new ComputeResult({ jobId: 'j1', status: 'success' }));
    assert.ok(!q.complete('j1', new ComputeResult({ jobId: 'j1', status: 'success' })));
  });

  it('complete returns false for unknown jobId', () => {
    assert.ok(!q.complete('nope', new ComputeResult({ jobId: 'nope', status: 'success' })));
  });

  // -- cancel ---------------------------------------------------------------

  it('cancel marks pending job as cancelled', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    assert.ok(q.cancel('j1', 'user abort'));
    const job = q.get('j1');
    assert.equal(job.status, 'cancelled');
    assert.equal(job.result.error, 'user abort');
    assert.ok(job.completedAt);
  });

  it('cancel marks assigned job as cancelled', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    q.assign('j1', 'exec');
    assert.ok(q.cancel('j1'));
    assert.equal(q.get('j1').status, 'cancelled');
  });

  it('cancel returns false for completed job', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    q.complete('j1', new ComputeResult({ jobId: 'j1', status: 'success' }));
    assert.ok(!q.cancel('j1'));
  });

  it('cancel returns false for unknown jobId', () => {
    assert.ok(!q.cancel('nope'));
  });

  it('cancel uses default reason when none given', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    q.cancel('j1');
    assert.ok(q.get('j1').result.error.includes('Cancelled'));
  });

  // -- listPending ----------------------------------------------------------

  it('listPending returns only pending requests', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    q.submit(makeReq({ jobId: 'j2' }));
    q.assign('j2', 'exec');
    const pending = q.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].jobId, 'j1');
  });

  // -- listByStatus ---------------------------------------------------------

  it('listByStatus filters correctly', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    q.submit(makeReq({ jobId: 'j2' }));
    q.submit(makeReq({ jobId: 'j3' }));
    q.assign('j2', 'exec');
    q.complete('j3', new ComputeResult({ jobId: 'j3', status: 'success' }));

    assert.equal(q.listByStatus('pending').length, 1);
    assert.equal(q.listByStatus('assigned').length, 1);
    assert.equal(q.listByStatus('completed').length, 1);
    assert.equal(q.listByStatus('cancelled').length, 0);
  });

  // -- pruneCompleted -------------------------------------------------------

  it('pruneCompleted removes old completed jobs', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    q.complete('j1', new ComputeResult({ jobId: 'j1', status: 'success' }));
    // Hack completedAt to the past
    const job = q.get('j1');
    // Need to access internal - complete set completedAt, prune uses maxAgeMs=0
    const pruned = q.pruneCompleted(0);
    assert.equal(pruned, 1);
    assert.equal(q.size, 0);
  });

  it('pruneCompleted keeps recent completed jobs', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    q.complete('j1', new ComputeResult({ jobId: 'j1', status: 'success' }));
    const pruned = q.pruneCompleted(999_999_999);
    assert.equal(pruned, 0);
    assert.equal(q.size, 1);
  });

  it('pruneCompleted does not remove pending jobs', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    const pruned = q.pruneCompleted(0);
    assert.equal(pruned, 0);
    assert.equal(q.size, 1);
  });

  it('pruneCompleted removes cancelled jobs', () => {
    q.submit(makeReq({ jobId: 'j1' }));
    q.cancel('j1');
    const pruned = q.pruneCompleted(0);
    assert.equal(pruned, 1);
    assert.equal(q.size, 0);
  });
});
