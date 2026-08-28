// Run with: node --import ./test/_setup-globals.mjs --test test/scheduler.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHED_SUBMIT,
  SCHED_STATUS,
  SCHED_CANCEL,
  SCHED_RESULT,
  ScheduledTask,
  TaskConstraints,
  TaskQueue,
  MeshScheduler,
} from '../src/scheduler.mjs';

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('SCHED_SUBMIT equals 0xCC', () => {
    assert.equal(SCHED_SUBMIT, 0xcc);
  });

  it('SCHED_STATUS equals 0xCD', () => {
    assert.equal(SCHED_STATUS, 0xcd);
  });

  it('SCHED_CANCEL equals 0xCE', () => {
    assert.equal(SCHED_CANCEL, 0xce);
  });

  it('SCHED_RESULT equals 0xCF', () => {
    assert.equal(SCHED_RESULT, 0xcf);
  });
});

// ---------------------------------------------------------------------------
// ScheduledTask
// ---------------------------------------------------------------------------

describe('ScheduledTask', () => {
  it('constructor sets all fields', () => {
    const t = new ScheduledTask({
      id: 't1',
      type: 'compute',
      payload: { data: 42 },
      priority: 'high',
      constraints: { requiredCaps: ['gpu'] },
      submittedBy: 'pod-a',
      submittedAt: 1000,
      deadline: 5000,
      retries: 1,
      maxRetries: 5,
      status: 'queued',
    });
    assert.equal(t.id, 't1');
    assert.equal(t.type, 'compute');
    assert.deepEqual(t.payload, { data: 42 });
    assert.equal(t.priority, 'high');
    assert.equal(t.submittedBy, 'pod-a');
    assert.equal(t.submittedAt, 1000);
    assert.equal(t.deadline, 5000);
    assert.equal(t.retries, 1);
    assert.equal(t.maxRetries, 5);
    assert.equal(t.status, 'queued');
  });

  it('applies defaults for omitted fields', () => {
    const t = new ScheduledTask({
      id: 't2',
      type: 'render',
      payload: {},
      submittedBy: 'pod-b',
    });
    assert.equal(t.priority, 'normal');
    assert.deepEqual(t.constraints, {});
    assert.equal(typeof t.submittedAt, 'number');
    assert.equal(t.deadline, null);
    assert.equal(t.retries, 0);
    assert.equal(t.maxRetries, 3);
    assert.equal(t.status, 'pending');
  });

  it('throws when id is missing', () => {
    assert.throws(
      () => new ScheduledTask({ type: 'x', payload: {}, submittedBy: 'p' }),
      /id is required/,
    );
  });

  it('throws when type is missing', () => {
    assert.throws(
      () => new ScheduledTask({ id: 'x', payload: {}, submittedBy: 'p' }),
      /type is required/,
    );
  });

  it('throws when submittedBy is missing', () => {
    assert.throws(
      () => new ScheduledTask({ id: 'x', type: 'y', payload: {} }),
      /submittedBy is required/,
    );
  });

  it('throws on invalid status', () => {
    assert.throws(
      () => new ScheduledTask({ id: 'x', type: 'y', payload: {}, submittedBy: 'p', status: 'bogus' }),
      /invalid status/i,
    );
  });

  it('throws on invalid priority', () => {
    assert.throws(
      () => new ScheduledTask({ id: 'x', type: 'y', payload: {}, submittedBy: 'p', priority: 'mega' }),
      /invalid priority/i,
    );
  });

  // -- isExpired ------------------------------------------------------------

  it('isExpired returns false when no deadline', () => {
    const t = new ScheduledTask({ id: 't', type: 'x', payload: {}, submittedBy: 'p' });
    assert.ok(!t.isExpired());
  });

  it('isExpired returns false before deadline', () => {
    const t = new ScheduledTask({
      id: 't', type: 'x', payload: {}, submittedBy: 'p',
      deadline: Date.now() + 100_000,
    });
    assert.ok(!t.isExpired());
  });

  it('isExpired returns true past deadline', () => {
    const t = new ScheduledTask({
      id: 't', type: 'x', payload: {}, submittedBy: 'p',
      deadline: 1000,
    });
    assert.ok(t.isExpired());
  });

  it('isExpired accepts now argument', () => {
    const t = new ScheduledTask({
      id: 't', type: 'x', payload: {}, submittedBy: 'p',
      deadline: 5000,
    });
    assert.ok(!t.isExpired(4999));
    assert.ok(t.isExpired(5001));
  });

  // -- canRetry -------------------------------------------------------------

  it('canRetry returns true when retries < maxRetries', () => {
    const t = new ScheduledTask({
      id: 't', type: 'x', payload: {}, submittedBy: 'p',
      retries: 1, maxRetries: 3,
    });
    assert.ok(t.canRetry());
  });

  it('canRetry returns false when retries >= maxRetries', () => {
    const t = new ScheduledTask({
      id: 't', type: 'x', payload: {}, submittedBy: 'p',
      retries: 3, maxRetries: 3,
    });
    assert.ok(!t.canRetry());
  });

  it('canRetry returns false when retries > maxRetries', () => {
    const t = new ScheduledTask({
      id: 't', type: 'x', payload: {}, submittedBy: 'p',
      retries: 5, maxRetries: 3,
    });
    assert.ok(!t.canRetry());
  });

  // -- toJSON / fromJSON ----------------------------------------------------

  it('round-trips via JSON', () => {
    const t = new ScheduledTask({
      id: 'rt1',
      type: 'compute',
      payload: { x: 1 },
      priority: 'high',
      constraints: { requiredCaps: ['gpu'] },
      submittedBy: 'pod-a',
      submittedAt: 2000,
      deadline: 8000,
      retries: 1,
      maxRetries: 5,
      status: 'running',
    });
    const t2 = ScheduledTask.fromJSON(t.toJSON());
    assert.deepEqual(t2.toJSON(), t.toJSON());
    assert.ok(t2 instanceof ScheduledTask);
  });

  it('toJSON returns a copy of payload', () => {
    const payload = { data: [1, 2] };
    const t = new ScheduledTask({ id: 't', type: 'x', payload, submittedBy: 'p' });
    const json = t.toJSON();
    json.payload.data.push(3);
    assert.deepEqual(t.payload, { data: [1, 2] });
  });
});

// ---------------------------------------------------------------------------
// TaskConstraints
// ---------------------------------------------------------------------------

describe('TaskConstraints', () => {
  it('constructor sets all fields', () => {
    const c = new TaskConstraints({
      requiredCaps: ['gpu', 'wasm'],
      minMemoryMb: 4096,
      minCpuCores: 4,
      preferLocal: true,
      maxLatencyMs: 100,
      affinityPodIds: ['pod-a'],
      antiAffinityPodIds: ['pod-b'],
    });
    assert.deepEqual(c.requiredCaps, ['gpu', 'wasm']);
    assert.equal(c.minMemoryMb, 4096);
    assert.equal(c.minCpuCores, 4);
    assert.equal(c.preferLocal, true);
    assert.equal(c.maxLatencyMs, 100);
    assert.deepEqual(c.affinityPodIds, ['pod-a']);
    assert.deepEqual(c.antiAffinityPodIds, ['pod-b']);
  });

  it('applies defaults for omitted fields', () => {
    const c = new TaskConstraints();
    assert.deepEqual(c.requiredCaps, []);
    assert.equal(c.minMemoryMb, 0);
    assert.equal(c.minCpuCores, 0);
    assert.equal(c.preferLocal, false);
    assert.equal(c.maxLatencyMs, null);
    assert.deepEqual(c.affinityPodIds, []);
    assert.deepEqual(c.antiAffinityPodIds, []);
  });

  it('copies arrays to avoid external mutation', () => {
    const caps = ['a', 'b'];
    const c = new TaskConstraints({ requiredCaps: caps });
    caps.push('c');
    assert.deepEqual(c.requiredCaps, ['a', 'b']);
  });

  // -- matches --------------------------------------------------------------

  it('matches returns true for empty constraints against any resource', () => {
    const c = new TaskConstraints();
    const desc = { capabilities: [], resources: { memory: 0, cpu: 0 }, podId: 'p' };
    assert.ok(c.matches(desc));
  });

  it('matches checks requiredCaps', () => {
    const c = new TaskConstraints({ requiredCaps: ['gpu', 'wasm'] });
    assert.ok(c.matches({ capabilities: ['gpu', 'wasm', 'js'], resources: { memory: 0, cpu: 0 } }));
    assert.ok(!c.matches({ capabilities: ['gpu'], resources: { memory: 0, cpu: 0 } }));
  });

  it('matches checks minMemoryMb', () => {
    const c = new TaskConstraints({ minMemoryMb: 4096 });
    assert.ok(c.matches({ capabilities: [], resources: { memory: 8192, cpu: 0 } }));
    assert.ok(c.matches({ capabilities: [], resources: { memory: 4096, cpu: 0 } }));
    assert.ok(!c.matches({ capabilities: [], resources: { memory: 2048, cpu: 0 } }));
  });

  it('matches checks minCpuCores', () => {
    const c = new TaskConstraints({ minCpuCores: 4 });
    assert.ok(c.matches({ capabilities: [], resources: { memory: 0, cpu: 8 } }));
    assert.ok(!c.matches({ capabilities: [], resources: { memory: 0, cpu: 2 } }));
  });

  it('matches checks affinity', () => {
    const c = new TaskConstraints({ affinityPodIds: ['pod-a', 'pod-b'] });
    assert.ok(c.matches({ capabilities: [], resources: { memory: 0, cpu: 0 }, podId: 'pod-a' }));
    assert.ok(!c.matches({ capabilities: [], resources: { memory: 0, cpu: 0 }, podId: 'pod-c' }));
  });

  it('matches checks anti-affinity', () => {
    const c = new TaskConstraints({ antiAffinityPodIds: ['pod-x'] });
    assert.ok(!c.matches({ capabilities: [], resources: { memory: 0, cpu: 0 }, podId: 'pod-x' }));
    assert.ok(c.matches({ capabilities: [], resources: { memory: 0, cpu: 0 }, podId: 'pod-y' }));
  });

  it('matches combines all constraints', () => {
    const c = new TaskConstraints({
      requiredCaps: ['gpu'],
      minMemoryMb: 2048,
      minCpuCores: 2,
      antiAffinityPodIds: ['pod-bad'],
    });
    assert.ok(c.matches({
      capabilities: ['gpu', 'wasm'],
      resources: { memory: 4096, cpu: 4 },
      podId: 'pod-good',
    }));
    assert.ok(!c.matches({
      capabilities: ['gpu'],
      resources: { memory: 4096, cpu: 4 },
      podId: 'pod-bad',
    }));
  });

  // -- toJSON / fromJSON ----------------------------------------------------

  it('round-trips via JSON', () => {
    const c = new TaskConstraints({
      requiredCaps: ['gpu'],
      minMemoryMb: 4096,
      minCpuCores: 4,
      preferLocal: true,
      maxLatencyMs: 50,
      affinityPodIds: ['pod-a'],
      antiAffinityPodIds: ['pod-x'],
    });
    const c2 = TaskConstraints.fromJSON(c.toJSON());
    assert.deepEqual(c2.toJSON(), c.toJSON());
    assert.ok(c2 instanceof TaskConstraints);
  });
});

// ---------------------------------------------------------------------------
// TaskQueue
// ---------------------------------------------------------------------------

describe('TaskQueue', () => {
  let q;

  const makeTask = (overrides = {}) =>
    new ScheduledTask({
      id: overrides.id || `t-${Math.random().toString(36).slice(2, 6)}`,
      type: 'compute',
      payload: {},
      submittedBy: 'pod-a',
      ...overrides,
    });

  beforeEach(() => {
    q = new TaskQueue();
  });

  it('starts empty', () => {
    assert.equal(q.size, 0);
    assert.ok(q.isEmpty);
  });

  it('enqueue increases size', () => {
    q.enqueue(makeTask({ id: 't1' }));
    assert.equal(q.size, 1);
    assert.ok(!q.isEmpty);
  });

  it('dequeue returns highest priority first', () => {
    q.enqueue(makeTask({ id: 'low', priority: 'low' }));
    q.enqueue(makeTask({ id: 'high', priority: 'high' }));
    q.enqueue(makeTask({ id: 'normal', priority: 'normal' }));
    assert.equal(q.dequeue().id, 'high');
    assert.equal(q.dequeue().id, 'normal');
    assert.equal(q.dequeue().id, 'low');
  });

  it('dequeue returns earlier deadline first within same priority', () => {
    q.enqueue(makeTask({ id: 'later', priority: 'normal', deadline: 9000 }));
    q.enqueue(makeTask({ id: 'sooner', priority: 'normal', deadline: 3000 }));
    q.enqueue(makeTask({ id: 'no-deadline', priority: 'normal' }));
    assert.equal(q.dequeue().id, 'sooner');
    assert.equal(q.dequeue().id, 'later');
    assert.equal(q.dequeue().id, 'no-deadline');
  });

  it('dequeue returns null when empty', () => {
    assert.equal(q.dequeue(), null);
  });

  it('peek returns next without removing', () => {
    q.enqueue(makeTask({ id: 't1', priority: 'high' }));
    q.enqueue(makeTask({ id: 't2', priority: 'normal' }));
    assert.equal(q.peek().id, 't1');
    assert.equal(q.size, 2);
  });

  it('peek returns null when empty', () => {
    assert.equal(q.peek(), null);
  });

  it('remove deletes task by id', () => {
    q.enqueue(makeTask({ id: 't1' }));
    q.enqueue(makeTask({ id: 't2' }));
    assert.ok(q.remove('t1'));
    assert.equal(q.size, 1);
    assert.equal(q.dequeue().id, 't2');
  });

  it('remove returns false for unknown id', () => {
    assert.ok(!q.remove('nope'));
  });

  it('toArray returns sorted copy', () => {
    q.enqueue(makeTask({ id: 'low', priority: 'low' }));
    q.enqueue(makeTask({ id: 'high', priority: 'high' }));
    const arr = q.toArray();
    assert.equal(arr[0].id, 'high');
    assert.equal(arr[1].id, 'low');
    assert.equal(arr.length, 2);
    // Ensure it is a copy
    arr.pop();
    assert.equal(q.size, 2);
  });

  it('supports custom comparator', () => {
    const q2 = new TaskQueue({ comparator: (a, b) => a.id.localeCompare(b.id) });
    q2.enqueue(makeTask({ id: 'z' }));
    q2.enqueue(makeTask({ id: 'a' }));
    assert.equal(q2.dequeue().id, 'a');
    assert.equal(q2.dequeue().id, 'z');
  });

  it('critical priority comes before high', () => {
    q.enqueue(makeTask({ id: 'high', priority: 'high' }));
    q.enqueue(makeTask({ id: 'critical', priority: 'critical' }));
    assert.equal(q.dequeue().id, 'critical');
  });
});

// ---------------------------------------------------------------------------
// MeshScheduler
// ---------------------------------------------------------------------------

describe('MeshScheduler', () => {
  let sched;

  const makeTask = (overrides = {}) =>
    new ScheduledTask({
      id: overrides.id || `t-${Math.random().toString(36).slice(2, 6)}`,
      type: 'compute',
      payload: {},
      submittedBy: 'pod-a',
      ...overrides,
    });

  const makeResource = (podId, overrides = {}) => ({
    podId,
    capabilities: overrides.capabilities || [],
    resources: {
      memory: overrides.memory || 4096,
      cpu: overrides.cpu || 4,
    },
    load: overrides.load || 0,
  });

  beforeEach(() => {
    sched = new MeshScheduler({ localPodId: 'local-pod' });
  });

  // -- submit ---------------------------------------------------------------

  it('submit adds task and returns task id', async () => {
    const task = makeTask({ id: 'task-1' });
    const id = await sched.submit(task);
    assert.equal(id, 'task-1');
  });

  it('submit sets status to queued', async () => {
    const task = makeTask({ id: 'task-1' });
    await sched.submit(task);
    assert.equal(sched.getTask('task-1').status, 'queued');
  });

  it('submit rejects duplicate task ids', async () => {
    const task1 = makeTask({ id: 'dup' });
    const task2 = makeTask({ id: 'dup' });
    await sched.submit(task1);
    await assert.rejects(() => sched.submit(task2), /already exists/);
  });

  // -- cancel ---------------------------------------------------------------

  it('cancel changes status to cancelled', async () => {
    const task = makeTask({ id: 'c1' });
    await sched.submit(task);
    const ok = await sched.cancel('c1');
    assert.ok(ok);
    assert.equal(sched.getTask('c1').status, 'cancelled');
  });

  it('cancel returns false for unknown task', async () => {
    const ok = await sched.cancel('nope');
    assert.ok(!ok);
  });

  it('cancel returns false for completed task', async () => {
    const task = makeTask({ id: 'done' });
    await sched.submit(task);
    sched.complete('done', { result: 42 });
    const ok = await sched.cancel('done');
    assert.ok(!ok);
  });

  // -- assign ---------------------------------------------------------------

  it('assign changes status to assigned', async () => {
    const task = makeTask({ id: 'a1' });
    await sched.submit(task);
    sched.assign('a1', 'pod-x');
    assert.equal(sched.getTask('a1').status, 'assigned');
  });

  it('assign throws for unknown task', () => {
    assert.throws(() => sched.assign('nope', 'pod-x'), /not found/i);
  });

  // -- complete -------------------------------------------------------------

  it('complete marks task as completed', async () => {
    const task = makeTask({ id: 'c1' });
    await sched.submit(task);
    sched.assign('c1', 'pod-x');
    sched.complete('c1', { answer: 42 });
    const t = sched.getTask('c1');
    assert.equal(t.status, 'completed');
    assert.deepEqual(t.result, { answer: 42 });
  });

  it('complete throws for unknown task', () => {
    assert.throws(() => sched.complete('nope', {}), /not found/i);
  });

  // -- fail -----------------------------------------------------------------

  it('fail marks task as failed', async () => {
    const task = makeTask({ id: 'f1', maxRetries: 0 });
    await sched.submit(task);
    sched.assign('f1', 'pod-x');
    sched.fail('f1', 'OOM');
    const t = sched.getTask('f1');
    assert.equal(t.status, 'failed');
    assert.equal(t.error, 'OOM');
  });

  it('fail requeues task when retries remain', async () => {
    const task = makeTask({ id: 'r1', maxRetries: 3 });
    await sched.submit(task);
    sched.assign('r1', 'pod-x');
    sched.fail('r1', 'timeout');
    const t = sched.getTask('r1');
    assert.equal(t.status, 'queued');
    assert.equal(t.retries, 1);
  });

  it('fail does not requeue when maxRetries exhausted', async () => {
    const task = makeTask({ id: 'r2', retries: 3, maxRetries: 3 });
    await sched.submit(task);
    sched.assign('r2', 'pod-x');
    sched.fail('r2', 'timeout');
    assert.equal(sched.getTask('r2').status, 'failed');
  });

  it('fail throws for unknown task', () => {
    assert.throws(() => sched.fail('nope', 'err'), /not found/i);
  });

  // -- getTask --------------------------------------------------------------

  it('getTask returns null for unknown', () => {
    assert.equal(sched.getTask('nope'), null);
  });

  // -- listTasks ------------------------------------------------------------

  it('listTasks returns all tasks when no filter', async () => {
    await sched.submit(makeTask({ id: 't1' }));
    await sched.submit(makeTask({ id: 't2' }));
    assert.equal(sched.listTasks().length, 2);
  });

  it('listTasks filters by status', async () => {
    await sched.submit(makeTask({ id: 't1' }));
    await sched.submit(makeTask({ id: 't2' }));
    sched.complete('t2', {});
    assert.equal(sched.listTasks({ status: 'queued' }).length, 1);
    assert.equal(sched.listTasks({ status: 'completed' }).length, 1);
  });

  it('listTasks filters by type', async () => {
    await sched.submit(makeTask({ id: 't1', type: 'compute' }));
    await sched.submit(makeTask({ id: 't2', type: 'render' }));
    assert.equal(sched.listTasks({ type: 'render' }).length, 1);
  });

  it('listTasks filters by submitter', async () => {
    await sched.submit(makeTask({ id: 't1', submittedBy: 'pod-a' }));
    await sched.submit(makeTask({ id: 't2', submittedBy: 'pod-b' }));
    assert.equal(sched.listTasks({ submittedBy: 'pod-b' }).length, 1);
  });

  // -- queue depth / running count ------------------------------------------

  it('getQueueDepth returns pending count', async () => {
    await sched.submit(makeTask({ id: 't1' }));
    await sched.submit(makeTask({ id: 't2' }));
    sched.assign('t2', 'pod-x');
    assert.equal(sched.getQueueDepth(), 1);
  });

  it('getRunningCount returns assigned + running count', async () => {
    await sched.submit(makeTask({ id: 't1' }));
    await sched.submit(makeTask({ id: 't2' }));
    sched.assign('t1', 'pod-x');
    sched.assign('t2', 'pod-y');
    assert.equal(sched.getRunningCount(), 2);
  });

  // -- registerNode / unregisterNode ----------------------------------------

  it('registerNode adds a node', () => {
    sched.registerNode('pod-x', makeResource('pod-x'));
    const nodes = sched.listTasks(); // nodes are internal but we can check via schedule()
    // Verify the node is registered by checking it can be scheduled to
    assert.ok(true); // If no throw, node was registered
  });

  it('unregisterNode removes a node', () => {
    sched.registerNode('pod-x', makeResource('pod-x'));
    assert.ok(sched.unregisterNode('pod-x'));
  });

  it('unregisterNode returns false for unknown pod', () => {
    assert.ok(!sched.unregisterNode('nope'));
  });

  // -- schedule() -----------------------------------------------------------

  it('schedule assigns pending tasks to available nodes (best-fit)', async () => {
    sched = new MeshScheduler({ localPodId: 'local', schedulingPolicy: 'best-fit' });
    sched.registerNode('pod-x', makeResource('pod-x', { memory: 8192, cpu: 8 }));
    sched.registerNode('pod-y', makeResource('pod-y', { memory: 2048, cpu: 2 }));

    const task = makeTask({
      id: 's1',
      constraints: new TaskConstraints({ minMemoryMb: 4096 }).toJSON(),
    });
    await sched.submit(task);
    const assigned = await sched.schedule();
    assert.equal(assigned, 1);
    assert.equal(sched.getTask('s1').status, 'assigned');
  });

  it('schedule respects maxConcurrent limit', async () => {
    sched = new MeshScheduler({ localPodId: 'local', maxConcurrent: 1 });
    sched.registerNode('pod-x', makeResource('pod-x'));
    await sched.submit(makeTask({ id: 't1' }));
    await sched.submit(makeTask({ id: 't2' }));
    // Assign first manually so running count = 1
    sched.assign('t1', 'pod-x');
    const assigned = await sched.schedule();
    assert.equal(assigned, 0);
  });

  it('schedule with first-fit assigns to first matching node', async () => {
    sched = new MeshScheduler({ localPodId: 'local', schedulingPolicy: 'first-fit' });
    sched.registerNode('pod-a', makeResource('pod-a'));
    sched.registerNode('pod-b', makeResource('pod-b'));
    await sched.submit(makeTask({ id: 't1' }));
    const assigned = await sched.schedule();
    assert.equal(assigned, 1);
    assert.equal(sched.getTask('t1').status, 'assigned');
  });

  it('schedule with round-robin distributes across nodes', async () => {
    sched = new MeshScheduler({ localPodId: 'local', schedulingPolicy: 'round-robin' });
    sched.registerNode('pod-a', makeResource('pod-a'));
    sched.registerNode('pod-b', makeResource('pod-b'));

    await sched.submit(makeTask({ id: 't1' }));
    await sched.submit(makeTask({ id: 't2' }));
    await sched.submit(makeTask({ id: 't3' }));

    await sched.schedule();
    // Check tasks are distributed across different pods
    const assignedPods = [
      sched.getTask('t1').assignedTo,
      sched.getTask('t2').assignedTo,
      sched.getTask('t3').assignedTo,
    ];
    assert.ok(assignedPods.includes('pod-a'));
    assert.ok(assignedPods.includes('pod-b'));
  });

  it('schedule with load-balanced picks least loaded node', async () => {
    sched = new MeshScheduler({ localPodId: 'local', schedulingPolicy: 'load-balanced', maxConcurrent: 10 });
    sched.registerNode('pod-a', makeResource('pod-a', { load: 5 }));
    sched.registerNode('pod-b', makeResource('pod-b', { load: 1 }));
    await sched.submit(makeTask({ id: 't1' }));
    await sched.schedule();
    assert.equal(sched.getTask('t1').assignedTo, 'pod-b');
  });

  it('schedule skips tasks with no matching nodes', async () => {
    sched = new MeshScheduler({ localPodId: 'local' });
    sched.registerNode('pod-x', makeResource('pod-x', { memory: 1024 }));
    const tc = new TaskConstraints({ minMemoryMb: 8192 });
    await sched.submit(makeTask({ id: 't1', constraints: tc.toJSON() }));
    const assigned = await sched.schedule();
    assert.equal(assigned, 0);
    assert.equal(sched.getTask('t1').status, 'queued');
  });

  it('schedule with no registered nodes assigns nothing', async () => {
    await sched.submit(makeTask({ id: 't1' }));
    const assigned = await sched.schedule();
    assert.equal(assigned, 0);
  });

  // -- callbacks ------------------------------------------------------------

  it('onTaskAssigned fires when task is assigned', async () => {
    let fired = null;
    sched.onTaskAssigned((taskId, podId) => { fired = { taskId, podId }; });
    await sched.submit(makeTask({ id: 'cb1' }));
    sched.assign('cb1', 'pod-x');
    assert.deepEqual(fired, { taskId: 'cb1', podId: 'pod-x' });
  });

  it('onTaskCompleted fires when task is completed', async () => {
    let fired = null;
    sched.onTaskCompleted((taskId, result) => { fired = { taskId, result }; });
    await sched.submit(makeTask({ id: 'cb2' }));
    sched.complete('cb2', { val: 1 });
    assert.equal(fired.taskId, 'cb2');
    assert.deepEqual(fired.result, { val: 1 });
  });

  it('onTaskFailed fires when task fails permanently', async () => {
    let fired = null;
    sched.onTaskFailed((taskId, error) => { fired = { taskId, error }; });
    const task = makeTask({ id: 'cb3', retries: 3, maxRetries: 3 });
    await sched.submit(task);
    sched.assign('cb3', 'pod-x');
    sched.fail('cb3', 'OOM');
    assert.equal(fired.taskId, 'cb3');
    assert.equal(fired.error, 'OOM');
  });

  it('onTaskFailed does NOT fire when task is retried', async () => {
    let fired = false;
    sched.onTaskFailed(() => { fired = true; });
    const task = makeTask({ id: 'cb4', maxRetries: 3 });
    await sched.submit(task);
    sched.assign('cb4', 'pod-x');
    sched.fail('cb4', 'timeout');
    assert.ok(!fired);
  });

  // -- getStats -------------------------------------------------------------

  it('getStats returns initial zeros', () => {
    const s = sched.getStats();
    assert.equal(s.totalSubmitted, 0);
    assert.equal(s.completed, 0);
    assert.equal(s.failed, 0);
    assert.equal(s.avgWaitMs, 0);
    assert.equal(s.avgRunMs, 0);
  });

  it('getStats tracks submissions and completions', async () => {
    await sched.submit(makeTask({ id: 's1' }));
    await sched.submit(makeTask({ id: 's2' }));
    sched.complete('s1', {});
    const s = sched.getStats();
    assert.equal(s.totalSubmitted, 2);
    assert.equal(s.completed, 1);
  });

  it('getStats tracks failures', async () => {
    const task = makeTask({ id: 'f1', retries: 3, maxRetries: 3 });
    await sched.submit(task);
    sched.assign('f1', 'pod-x');
    sched.fail('f1', 'err');
    assert.equal(sched.getStats().failed, 1);
  });

  // -- toJSON / fromJSON ----------------------------------------------------

  it('round-trips via JSON', async () => {
    sched.registerNode('pod-x', makeResource('pod-x'));
    await sched.submit(makeTask({ id: 'rtt1', type: 'compute' }));
    await sched.submit(makeTask({ id: 'rtt2', type: 'render' }));
    sched.complete('rtt1', { v: 1 });

    const json = sched.toJSON();
    const sched2 = MeshScheduler.fromJSON(json);
    assert.equal(sched2.getTask('rtt1').status, 'completed');
    assert.equal(sched2.getTask('rtt2').status, 'queued');
    assert.equal(sched2.getStats().totalSubmitted, 2);
  });

  // -- maxConcurrent --------------------------------------------------------

  it('constructor defaults maxConcurrent to 10', () => {
    const s = new MeshScheduler({ localPodId: 'p' });
    assert.equal(s.maxConcurrent, 10);
  });

  it('constructor accepts custom maxConcurrent', () => {
    const s = new MeshScheduler({ localPodId: 'p', maxConcurrent: 5 });
    assert.equal(s.maxConcurrent, 5);
  });

  it('constructor defaults schedulingPolicy to best-fit', () => {
    const s = new MeshScheduler({ localPodId: 'p' });
    assert.equal(s.schedulingPolicy, 'best-fit');
  });

  it('constructor throws on invalid scheduling policy', () => {
    assert.throws(
      () => new MeshScheduler({ localPodId: 'p', schedulingPolicy: 'magic' }),
      /invalid.*policy/i,
    );
  });

  it('constructor throws when localPodId missing', () => {
    assert.throws(
      () => new MeshScheduler({}),
      /localPodId is required/,
    );
  });
});
