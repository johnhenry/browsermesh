// Run with: node --import ./test/_setup-globals.mjs --test test/swarm.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  SWARM_JOIN,
  SWARM_LEAVE,
  SWARM_HEARTBEAT,
  SWARM_TASK_ASSIGN,
  SwarmRole,
  TaskStrategy,
  TASK_STATUSES,
  SwarmMember,
  SwarmTask,
  LeaderElection,
  TaskDistributor,
  SwarmCoordinator,
} from '../src/swarm.mjs';

// ── Wire Constants ──────────────────────────────────────────────

describe('Wire constants', () => {
  it('SWARM_JOIN equals 0xC0', () => {
    assert.equal(SWARM_JOIN, 0xC0);
  });

  it('SWARM_LEAVE equals 0xC1', () => {
    assert.equal(SWARM_LEAVE, 0xC1);
  });

  it('SWARM_HEARTBEAT equals 0xC2', () => {
    assert.equal(SWARM_HEARTBEAT, 0xC2);
  });

  it('SWARM_TASK_ASSIGN equals 0xC3', () => {
    assert.equal(SWARM_TASK_ASSIGN, 0xC3);
  });
});

// ── Enums ───────────────────────────────────────────────────────

describe('SwarmRole', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(SwarmRole));
  });

  it('contains the three roles', () => {
    assert.deepEqual(SwarmRole, ['leader', 'follower', 'candidate']);
  });
});

describe('TaskStrategy', () => {
  it('is frozen', () => {
    assert.ok(Object.isFrozen(TaskStrategy));
  });

  it('contains the five strategies', () => {
    assert.deepEqual(TaskStrategy, [
      'leader-follower',
      'round-robin',
      'load-balanced',
      'redundant',
      'pipeline',
    ]);
  });
});

// ── SwarmMember ─────────────────────────────────────────────────

describe('SwarmMember', () => {
  it('constructor sets all provided fields', () => {
    const m = new SwarmMember({
      podId: 'pod-1',
      role: 'leader',
      load: 0.5,
      capabilities: ['chat', 'tools'],
      joinedAt: 1000,
      lastHeartbeat: 2000,
    });
    assert.equal(m.podId, 'pod-1');
    assert.equal(m.role, 'leader');
    assert.equal(m.load, 0.5);
    assert.deepEqual(m.capabilities, ['chat', 'tools']);
    assert.equal(m.joinedAt, 1000);
    assert.equal(m.lastHeartbeat, 2000);
  });

  it('applies defaults when not provided', () => {
    const m = new SwarmMember({ podId: 'pod-2' });
    assert.equal(m.podId, 'pod-2');
    assert.equal(m.role, 'candidate');
    assert.equal(m.load, 0);
    assert.deepEqual(m.capabilities, []);
    assert.equal(typeof m.joinedAt, 'number');
    assert.equal(typeof m.lastHeartbeat, 'number');
  });

  it('throws when podId is missing', () => {
    assert.throws(() => new SwarmMember({}), /podId is required/);
  });

  it('throws when podId is empty string', () => {
    assert.throws(() => new SwarmMember({ podId: '' }), /podId is required/);
  });

  it('copies capabilities array', () => {
    const caps = ['a', 'b'];
    const m = new SwarmMember({ podId: 'p', capabilities: caps });
    caps.push('c');
    assert.deepEqual(m.capabilities, ['a', 'b']);
  });

  it('isStale returns false for fresh member', () => {
    const m = new SwarmMember({ podId: 'p', lastHeartbeat: Date.now() });
    assert.equal(m.isStale(), false);
  });

  it('isStale returns true for old heartbeat', () => {
    const m = new SwarmMember({ podId: 'p', lastHeartbeat: Date.now() - 60000 });
    assert.equal(m.isStale(), true);
  });

  it('isStale respects custom timeout', () => {
    const m = new SwarmMember({ podId: 'p', lastHeartbeat: Date.now() - 500 });
    assert.equal(m.isStale(200), true);
    assert.equal(m.isStale(10000), false);
  });

  it('toJSON returns plain object with all fields', () => {
    const m = new SwarmMember({ podId: 'p1', role: 'leader', load: 0.3, capabilities: ['x'] });
    const json = m.toJSON();
    assert.equal(json.podId, 'p1');
    assert.equal(json.role, 'leader');
    assert.equal(json.load, 0.3);
    assert.deepEqual(json.capabilities, ['x']);
    assert.equal(typeof json.joinedAt, 'number');
    assert.equal(typeof json.lastHeartbeat, 'number');
  });

  it('toJSON capabilities is a copy', () => {
    const m = new SwarmMember({ podId: 'p', capabilities: ['a'] });
    const json = m.toJSON();
    json.capabilities.push('b');
    assert.deepEqual(m.capabilities, ['a']);
  });

  it('fromJSON round-trips correctly', () => {
    const original = new SwarmMember({
      podId: 'rnd',
      role: 'follower',
      load: 0.7,
      capabilities: ['chat'],
      joinedAt: 5000,
      lastHeartbeat: 6000,
    });
    const restored = SwarmMember.fromJSON(original.toJSON());
    assert.deepEqual(restored.toJSON(), original.toJSON());
  });
});

// ── SwarmTask ───────────────────────────────────────────────────

describe('SwarmTask', () => {
  it('constructor sets all provided fields', () => {
    const t = new SwarmTask({
      taskId: 'task-abc',
      description: 'Do something',
      strategy: 'redundant',
      assignedTo: ['pod-1', 'pod-2'],
      status: 'running',
      input: { data: 1 },
      output: { result: 2 },
      createdAt: 1000,
      startedAt: 2000,
      completedAt: 3000,
    });
    assert.equal(t.taskId, 'task-abc');
    assert.equal(t.description, 'Do something');
    assert.equal(t.strategy, 'redundant');
    assert.deepEqual(t.assignedTo, ['pod-1', 'pod-2']);
    assert.equal(t.status, 'running');
    assert.deepEqual(t.input, { data: 1 });
    assert.deepEqual(t.output, { result: 2 });
    assert.equal(t.createdAt, 1000);
    assert.equal(t.startedAt, 2000);
    assert.equal(t.completedAt, 3000);
  });

  it('applies defaults when not provided', () => {
    const t = new SwarmTask({ description: 'test task' });
    assert.ok(t.taskId.startsWith('task_'));
    assert.equal(t.strategy, 'leader-follower');
    assert.deepEqual(t.assignedTo, []);
    assert.equal(t.status, 'pending');
    assert.equal(t.input, null);
    assert.equal(t.output, null);
    assert.equal(typeof t.createdAt, 'number');
    assert.equal(t.startedAt, null);
    assert.equal(t.completedAt, null);
  });

  it('throws when description is missing', () => {
    assert.throws(() => new SwarmTask({}), /description is required/);
  });

  it('throws when description is empty string', () => {
    assert.throws(() => new SwarmTask({ description: '' }), /description is required/);
  });

  it('auto-generates unique taskIds', () => {
    const t1 = new SwarmTask({ description: 'a' });
    const t2 = new SwarmTask({ description: 'b' });
    assert.notEqual(t1.taskId, t2.taskId);
  });

  it('toJSON returns plain object with all fields', () => {
    const t = new SwarmTask({ description: 'test', input: 42 });
    const json = t.toJSON();
    assert.equal(json.description, 'test');
    assert.equal(json.input, 42);
    assert.deepEqual(Object.keys(json).sort(), [
      'assignedTo', 'completedAt', 'createdAt', 'description',
      'input', 'output', 'startedAt', 'status', 'strategy', 'taskId',
    ]);
  });

  it('fromJSON round-trips correctly', () => {
    const original = new SwarmTask({
      taskId: 'rt-1',
      description: 'roundtrip',
      strategy: 'pipeline',
      assignedTo: ['a'],
      status: 'completed',
      input: 'in',
      output: 'out',
      createdAt: 100,
      startedAt: 200,
      completedAt: 300,
    });
    const restored = SwarmTask.fromJSON(original.toJSON());
    assert.deepEqual(restored.toJSON(), original.toJSON());
  });
});

// ── LeaderElection ──────────────────────────────────────────────

describe('LeaderElection', () => {
  /** @type {LeaderElection} */
  let el;

  beforeEach(() => {
    el = new LeaderElection('pod-b');
  });

  it('constructor registers local pod as candidate', () => {
    assert.deepEqual(el.candidates, ['pod-b']);
  });

  it('localPodId returns the local id', () => {
    assert.equal(el.localPodId, 'pod-b');
  });

  it('leader is null before election', () => {
    assert.equal(el.leader, null);
  });

  it('role is candidate before election', () => {
    assert.equal(el.role, 'candidate');
  });

  it('elect picks lowest lexicographic podId', () => {
    el.addCandidate('pod-a');
    el.addCandidate('pod-c');
    const winner = el.elect();
    assert.equal(winner, 'pod-a');
    assert.equal(el.leader, 'pod-a');
  });

  it('elect with single candidate picks that candidate', () => {
    const winner = el.elect();
    assert.equal(winner, 'pod-b');
  });

  it('role becomes leader when local pod wins', () => {
    el.elect(); // only pod-b
    assert.equal(el.role, 'leader');
  });

  it('role becomes follower when another pod wins', () => {
    el.addCandidate('pod-a');
    el.elect();
    assert.equal(el.role, 'follower');
  });

  it('addCandidate adds to candidates list', () => {
    el.addCandidate('pod-x');
    assert.ok(el.candidates.includes('pod-x'));
  });

  it('removeCandidate removes from candidates', () => {
    el.addCandidate('pod-x');
    assert.equal(el.removeCandidate('pod-x'), true);
    assert.ok(!el.candidates.includes('pod-x'));
  });

  it('removeCandidate returns false for unknown', () => {
    assert.equal(el.removeCandidate('nope'), false);
  });

  it('removeCandidate clears leader if leader is removed', () => {
    el.elect(); // pod-b is leader
    el.removeCandidate('pod-b');
    assert.equal(el.leader, null);
  });

  it('receiveHeartbeat updates timestamp', () => {
    el.addCandidate('pod-a');
    el.receiveHeartbeat('pod-a', 9999);
    el.elect(); // pod-a leads
    assert.equal(el.checkLeaderAlive(9999 + 1000), true);
  });

  it('checkLeaderAlive returns false when no leader', () => {
    assert.equal(el.checkLeaderAlive(), false);
  });

  it('checkLeaderAlive returns false when leader heartbeat is stale', () => {
    el.receiveHeartbeat('pod-b', 1000);
    el.elect();
    // electionTimeoutMs defaults to 15000, so 1000 + 20000 is stale
    assert.equal(el.checkLeaderAlive(21001), false);
  });

  it('checkLeaderAlive returns true when leader heartbeat is fresh', () => {
    const now = Date.now();
    el.receiveHeartbeat('pod-b', now);
    el.elect();
    assert.equal(el.checkLeaderAlive(now + 100), true);
  });

  it('yieldLeadership transfers to next candidate', () => {
    el.addCandidate('pod-a');
    el.addCandidate('pod-c');
    el.elect(); // pod-a wins
    const next = el.yieldLeadership();
    assert.equal(next, 'pod-b'); // next lexicographic
  });

  it('yieldLeadership returns null when only one candidate', () => {
    el.elect();
    assert.equal(el.yieldLeadership(), null);
  });

  it('yieldLeadership wraps around', () => {
    el.addCandidate('pod-a');
    el.elect(); // pod-a
    el.yieldLeadership(); // pod-b
    const wrapped = el.yieldLeadership(); // back to pod-a
    assert.equal(wrapped, 'pod-a');
  });

  it('candidates returns sorted list', () => {
    el.addCandidate('pod-z');
    el.addCandidate('pod-a');
    assert.deepEqual(el.candidates, ['pod-a', 'pod-b', 'pod-z']);
  });

  it('toJSON/fromJSON round-trips', () => {
    el.addCandidate('pod-a');
    el.receiveHeartbeat('pod-a', 5000);
    el.elect();
    const json = el.toJSON();
    const restored = LeaderElection.fromJSON(json);
    assert.equal(restored.leader, el.leader);
    assert.equal(restored.localPodId, el.localPodId);
    assert.deepEqual(restored.candidates, el.candidates);
  });

  it('throws when localPodId is missing', () => {
    assert.throws(() => new LeaderElection(''), /localPodId is required/);
  });
});

// ── TaskDistributor ─────────────────────────────────────────────

describe('TaskDistributor', () => {
  /** @type {TaskDistributor} */
  let dist;

  beforeEach(() => {
    dist = new TaskDistributor();
  });

  it('starts empty', () => {
    assert.equal(dist.size, 0);
    assert.deepEqual(dist.members, []);
  });

  it('constructor accepts initial members', () => {
    const d = new TaskDistributor([
      new SwarmMember({ podId: 'a' }),
      new SwarmMember({ podId: 'b' }),
    ]);
    assert.equal(d.size, 2);
  });

  it('addMember increases size', () => {
    dist.addMember(new SwarmMember({ podId: 'pod-1' }));
    assert.equal(dist.size, 1);
  });

  it('removeMember decreases size', () => {
    dist.addMember(new SwarmMember({ podId: 'pod-1' }));
    assert.equal(dist.removeMember('pod-1'), true);
    assert.equal(dist.size, 0);
  });

  it('removeMember returns false for unknown', () => {
    assert.equal(dist.removeMember('nope'), false);
  });

  it('getMember returns the member', () => {
    dist.addMember(new SwarmMember({ podId: 'pod-1', load: 0.5 }));
    const m = dist.getMember('pod-1');
    assert.equal(m.podId, 'pod-1');
    assert.equal(m.load, 0.5);
  });

  it('getMember returns null for unknown', () => {
    assert.equal(dist.getMember('nope'), null);
  });

  it('distribute leader-follower assigns to first member', () => {
    dist.addMember(new SwarmMember({ podId: 'alpha' }));
    dist.addMember(new SwarmMember({ podId: 'beta' }));
    const task = new SwarmTask({ description: 'test' });
    const assigned = dist.distribute(task, 'leader-follower');
    assert.deepEqual(assigned, ['alpha']);
    assert.equal(task.status, 'assigned');
  });

  it('distribute round-robin rotates through members', () => {
    dist.addMember(new SwarmMember({ podId: 'a' }));
    dist.addMember(new SwarmMember({ podId: 'b' }));
    dist.addMember(new SwarmMember({ podId: 'c' }));

    const t1 = new SwarmTask({ description: 't1' });
    const t2 = new SwarmTask({ description: 't2' });
    const t3 = new SwarmTask({ description: 't3' });
    const t4 = new SwarmTask({ description: 't4' });

    assert.deepEqual(dist.distribute(t1, 'round-robin'), ['a']);
    assert.deepEqual(dist.distribute(t2, 'round-robin'), ['b']);
    assert.deepEqual(dist.distribute(t3, 'round-robin'), ['c']);
    assert.deepEqual(dist.distribute(t4, 'round-robin'), ['a']); // wraps
  });

  it('distribute load-balanced picks lowest load', () => {
    dist.addMember(new SwarmMember({ podId: 'heavy', load: 0.9 }));
    dist.addMember(new SwarmMember({ podId: 'light', load: 0.1 }));
    dist.addMember(new SwarmMember({ podId: 'medium', load: 0.5 }));
    const task = new SwarmTask({ description: 'test' });
    const assigned = dist.distribute(task, 'load-balanced');
    assert.deepEqual(assigned, ['light']);
  });

  it('distribute redundant assigns to all members', () => {
    dist.addMember(new SwarmMember({ podId: 'a' }));
    dist.addMember(new SwarmMember({ podId: 'b' }));
    dist.addMember(new SwarmMember({ podId: 'c' }));
    const task = new SwarmTask({ description: 'test' });
    const assigned = dist.distribute(task, 'redundant');
    assert.equal(assigned.length, 3);
    assert.ok(assigned.includes('a'));
    assert.ok(assigned.includes('b'));
    assert.ok(assigned.includes('c'));
  });

  it('distribute pipeline assigns to all members', () => {
    dist.addMember(new SwarmMember({ podId: 'stage-1' }));
    dist.addMember(new SwarmMember({ podId: 'stage-2' }));
    const task = new SwarmTask({ description: 'test' });
    const assigned = dist.distribute(task, 'pipeline');
    assert.equal(assigned.length, 2);
  });

  it('distribute returns empty array when no members', () => {
    const task = new SwarmTask({ description: 'test' });
    assert.deepEqual(dist.distribute(task), []);
  });

  it('distribute uses task strategy by default', () => {
    dist.addMember(new SwarmMember({ podId: 'a' }));
    dist.addMember(new SwarmMember({ podId: 'b' }));
    const task = new SwarmTask({ description: 'test', strategy: 'redundant' });
    const assigned = dist.distribute(task);
    assert.equal(assigned.length, 2);
  });

  it('distribute throws for unknown strategy', () => {
    dist.addMember(new SwarmMember({ podId: 'a' }));
    const task = new SwarmTask({ description: 'test' });
    assert.throws(() => dist.distribute(task, 'unknown'), /Unknown task strategy/);
  });
});

// ── SwarmCoordinator ────────────────────────────────────────────

describe('SwarmCoordinator', () => {
  /** @type {SwarmCoordinator} */
  let coord;

  beforeEach(() => {
    coord = new SwarmCoordinator('local-pod');
  });

  it('constructor adds self to distributor', () => {
    assert.equal(coord.swarmSize, 1);
  });

  it('election accessor returns LeaderElection', () => {
    assert.ok(coord.election instanceof LeaderElection);
  });

  it('distributor accessor returns TaskDistributor', () => {
    assert.ok(coord.distributor instanceof TaskDistributor);
  });

  it('join adds a member and candidate', () => {
    coord.join('pod-2', ['chat']);
    assert.equal(coord.swarmSize, 2);
    assert.ok(coord.election.candidates.includes('pod-2'));
  });

  it('join returns the new SwarmMember', () => {
    const m = coord.join('pod-2', ['tools']);
    assert.equal(m.podId, 'pod-2');
    assert.deepEqual(m.capabilities, ['tools']);
  });

  it('leave removes the member', () => {
    coord.join('pod-2');
    assert.equal(coord.leave('pod-2'), true);
    assert.equal(coord.swarmSize, 1);
  });

  it('leave returns false for unknown', () => {
    assert.equal(coord.leave('nope'), false);
  });

  it('submitTask creates and distributes a task', () => {
    const task = coord.submitTask('do work', 'leader-follower', { x: 1 });
    assert.ok(task.taskId);
    assert.equal(task.description, 'do work');
    assert.equal(task.status, 'assigned');
    assert.deepEqual(task.input, { x: 1 });
  });

  it('getTask retrieves a submitted task', () => {
    const task = coord.submitTask('find me');
    assert.equal(coord.getTask(task.taskId).description, 'find me');
  });

  it('getTask returns null for unknown', () => {
    assert.equal(coord.getTask('nope'), null);
  });

  it('completeTask marks task as completed', () => {
    const task = coord.submitTask('complete me');
    assert.equal(coord.completeTask(task.taskId, 'done'), true);
    assert.equal(coord.getTask(task.taskId).status, 'completed');
    assert.equal(coord.getTask(task.taskId).output, 'done');
    assert.equal(typeof coord.getTask(task.taskId).completedAt, 'number');
  });

  it('completeTask returns false for unknown task', () => {
    assert.equal(coord.completeTask('nope'), false);
  });

  it('failTask marks task as failed', () => {
    const task = coord.submitTask('fail me');
    assert.equal(coord.failTask(task.taskId, 'error!'), true);
    assert.equal(coord.getTask(task.taskId).status, 'failed');
    assert.equal(coord.getTask(task.taskId).output, 'error!');
    assert.equal(typeof coord.getTask(task.taskId).completedAt, 'number');
  });

  it('failTask returns false for unknown task', () => {
    assert.equal(coord.failTask('nope'), false);
  });

  it('listTasks returns all tasks', () => {
    coord.submitTask('t1');
    coord.submitTask('t2');
    assert.equal(coord.listTasks().length, 2);
  });

  it('listTasks filters by status', () => {
    const t1 = coord.submitTask('t1');
    coord.submitTask('t2');
    coord.completeTask(t1.taskId);
    assert.equal(coord.listTasks({ status: 'completed' }).length, 1);
    assert.equal(coord.listTasks({ status: 'assigned' }).length, 1);
  });

  it('isLeader returns false before election', () => {
    assert.equal(coord.isLeader, false);
  });

  it('isLeader returns true when local pod is elected', () => {
    coord.election.elect();
    assert.equal(coord.isLeader, true);
  });

  it('isLeader returns false when another pod wins', () => {
    coord.join('aaa-pod'); // lexicographically lower
    coord.election.elect();
    assert.equal(coord.isLeader, false);
  });
});

// ---------------------------------------------------------------------------
// SwarmCoordinator — multi-swarm
// ---------------------------------------------------------------------------

describe('SwarmCoordinator multi-swarm', () => {
  let coord;

  beforeEach(() => {
    coord = new SwarmCoordinator('local-pod');
  });

  describe('listSwarms', () => {
    it('starts with only the local swarm', () => {
      const swarms = coord.listSwarms();
      assert.equal(swarms.length, 1);
      assert.equal(swarms[0].swarmId, 'local');
      assert.equal(swarms[0].size, 1);
      assert.equal(swarms[0].taskCount, 0);
    });

    it('reflects a newly created swarm', () => {
      coord.createSwarm('team-a');
      const swarms = coord.listSwarms();
      assert.equal(swarms.length, 2);
      assert.deepEqual(swarms.map(s => s.swarmId).sort(), ['local', 'team-a']);
    });

    it('reflects size and task counts per swarm', () => {
      coord.join('peer-1', [], 'team-a');
      coord.submitTask('do work', 'leader-follower', null, 'team-a');
      const teamA = coord.listSwarms().find(s => s.swarmId === 'team-a');
      assert.equal(teamA.size, 2); // local-pod + peer-1
      assert.equal(teamA.taskCount, 1);
    });
  });

  describe('createSwarm / hasSwarm / disbandSwarm', () => {
    it('createSwarm returns true for a new swarm, false if it already exists', () => {
      assert.equal(coord.createSwarm('team-a'), true);
      assert.equal(coord.createSwarm('team-a'), false);
    });

    it('a newly created swarm includes the local pod as its first member', () => {
      coord.createSwarm('team-a');
      assert.equal(coord.swarmSize, 1); // 'local' unaffected
      const swarms = coord.listSwarms();
      assert.equal(swarms.find(s => s.swarmId === 'team-a').size, 1);
    });

    it('hasSwarm reflects existence', () => {
      assert.equal(coord.hasSwarm('team-a'), false);
      coord.createSwarm('team-a');
      assert.equal(coord.hasSwarm('team-a'), true);
    });

    it('disbandSwarm removes a non-local swarm', () => {
      coord.createSwarm('team-a');
      assert.equal(coord.disbandSwarm('team-a'), true);
      assert.equal(coord.hasSwarm('team-a'), false);
    });

    it('disbandSwarm returns false for an unknown swarm', () => {
      assert.equal(coord.disbandSwarm('nope'), false);
    });

    it('disbandSwarm throws when asked to disband the local swarm', () => {
      assert.throws(() => coord.disbandSwarm('local'), /cannot disband/);
    });

    it('tasks in a disbanded swarm are no longer reachable', () => {
      const task = coord.submitTask('do work', 'leader-follower', null, 'team-a');
      coord.disbandSwarm('team-a');
      assert.equal(coord.getTask(task.taskId), null);
    });
  });

  describe('join / leave with an explicit swarmId', () => {
    it('join auto-creates the target swarm', () => {
      assert.equal(coord.hasSwarm('team-a'), false);
      coord.join('peer-1', [], 'team-a');
      assert.equal(coord.hasSwarm('team-a'), true);
    });

    it('join to a non-local swarm does not affect the local swarm', () => {
      coord.join('peer-1', [], 'team-a');
      assert.equal(coord.swarmSize, 1); // local unaffected
      assert.equal(coord.listSwarms().find(s => s.swarmId === 'team-a').size, 2);
    });

    it('join defaults to the local swarm — identical to pre-multi-swarm behavior', () => {
      coord.join('peer-1');
      assert.equal(coord.swarmSize, 2);
    });

    it('leave removes a member from the specified swarm only', () => {
      coord.join('peer-1'); // local
      coord.join('peer-1', [], 'team-a');
      coord.leave('peer-1', 'team-a');
      assert.equal(coord.swarmSize, 2); // local still has peer-1
      assert.equal(coord.listSwarms().find(s => s.swarmId === 'team-a').size, 1);
    });

    it('leave returns false for a swarm that does not exist', () => {
      assert.equal(coord.leave('peer-1', 'nonexistent'), false);
    });
  });

  describe('submitTask / listTasks with an explicit swarmId', () => {
    it('submitTask defaults to the local swarm', () => {
      coord.submitTask('t1');
      assert.equal(coord.listTasks().length, 1);
      assert.equal(coord.listTasks({ swarmId: 'team-a' }).length, 0);
    });

    it('submitTask to a non-local swarm keeps local swarm tasks unaffected', () => {
      coord.submitTask('local-task');
      coord.submitTask('team-task', 'leader-follower', null, 'team-a');
      assert.equal(coord.listTasks().length, 1);
      assert.equal(coord.listTasks({ swarmId: 'team-a' }).length, 1);
    });

    it("listTasks with swarmId '*' lists across every swarm", () => {
      coord.submitTask('local-task');
      coord.submitTask('team-task', 'leader-follower', null, 'team-a');
      assert.equal(coord.listTasks({ swarmId: '*' }).length, 2);
    });

    it('listTasks combines status and swarmId filters', () => {
      const t1 = coord.submitTask('team-task', 'leader-follower', null, 'team-a');
      coord.completeTask(t1.taskId);
      coord.submitTask('team-task-2', 'leader-follower', null, 'team-a');
      assert.equal(coord.listTasks({ swarmId: 'team-a', status: 'completed' }).length, 1);
    });
  });

  describe('getTask / completeTask / failTask / cancelTask across swarms', () => {
    it('getTask finds a task regardless of which swarm it belongs to', () => {
      const task = coord.submitTask('team-task', 'leader-follower', null, 'team-a');
      assert.equal(coord.getTask(task.taskId)?.taskId, task.taskId);
    });

    it('completeTask works for a task in a non-local swarm', () => {
      const task = coord.submitTask('team-task', 'leader-follower', null, 'team-a');
      assert.equal(coord.completeTask(task.taskId), true);
      assert.equal(coord.getTask(task.taskId).status, 'completed');
    });

    it('failTask works for a task in a non-local swarm', () => {
      const task = coord.submitTask('team-task', 'leader-follower', null, 'team-a');
      assert.equal(coord.failTask(task.taskId, 'boom'), true);
      assert.equal(coord.getTask(task.taskId).status, 'failed');
    });

    it('cancelTask works for a task in a non-local swarm', () => {
      const task = coord.submitTask('team-task', 'leader-follower', null, 'team-a');
      assert.equal(coord.cancelTask(task.taskId), true);
      assert.equal(coord.getTask(task.taskId).status, 'cancelled');
    });
  });

  describe('listMembers', () => {
    it('defaults to the local swarm', () => {
      coord.join('peer-1');
      assert.deepEqual(coord.listMembers().sort(), ['local-pod', 'peer-1']);
    });

    it('lists members of a non-local swarm', () => {
      coord.join('peer-1', [], 'team-a');
      assert.deepEqual(coord.listMembers('team-a').sort(), ['local-pod', 'peer-1']);
    });

    it('returns an empty array for an unknown swarm', () => {
      assert.deepEqual(coord.listMembers('nonexistent'), []);
    });
  });

  describe('election isolation between swarms', () => {
    it('each swarm has its own independent leader election', () => {
      coord.join('aaa-pod', [], 'team-a'); // lexicographically first in team-a
      coord.createSwarm('team-b');

      coord.election.elect(); // local swarm — local-pod is the only candidate
      assert.equal(coord.isLeader, true);

      const teamAElection = coord.listSwarms().find(s => s.swarmId === 'team-a');
      assert.equal(teamAElection.isLeader, false); // not elected yet — leader is null until elect() runs
    });
  });
});
