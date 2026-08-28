/**
 * Tests for AgentSwarmCoordinator — multi-agent coordination protocol.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/peer-agent-swarm.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// Provide crypto.randomUUID if not available
if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `swarm-${Math.random().toString(36).slice(2)}`

import {
  SWARM_STRATEGIES,
  SWARM_DEFAULTS,
  SubTask,
  SwarmInstance,
  AgentSwarmCoordinator,
} from '../src/peer-agent-swarm.mjs'

// ---------------------------------------------------------------------------
// Mock agent proxy
// ---------------------------------------------------------------------------

function createMockAgentProxy(responses = {}) {
  const calls = []
  return {
    async chat(podId, message) {
      calls.push({ podId, message })
      if (responses[podId]) return responses[podId]
      return `result from ${podId}: ${message.slice(0, 30)}`
    },
    calls,
  }
}

// ---------------------------------------------------------------------------
// Test: SubTask
// ---------------------------------------------------------------------------

describe('SubTask', () => {
  it('constructs with defaults', () => {
    const st = new SubTask({ id: 'st-1', description: 'do something' })
    assert.equal(st.id, 'st-1')
    assert.equal(st.description, 'do something')
    assert.equal(st.assignee, null)
    assert.deepEqual(st.dependencies, [])
    assert.equal(st.status, 'pending')
  })

  it('toJSON/fromJSON round-trip (test 16)', () => {
    const st = new SubTask({
      id: 'st-x',
      description: 'task x',
      assignee: 'pod-a',
      dependencies: ['st-y'],
      status: 'running',
    })
    const json = st.toJSON()
    const restored = SubTask.fromJSON(json)
    assert.equal(restored.id, 'st-x')
    assert.equal(restored.assignee, 'pod-a')
    assert.deepEqual(restored.dependencies, ['st-y'])
    assert.equal(restored.status, 'running')
  })

  it('tracks dependencies (test 16)', () => {
    const st = new SubTask({
      id: 'st-2',
      description: 'depends on st-1',
      dependencies: ['st-1'],
    })
    assert.deepEqual(st.dependencies, ['st-1'])
  })
})

// ---------------------------------------------------------------------------
// Test: SwarmInstance
// ---------------------------------------------------------------------------

describe('SwarmInstance', () => {
  it('creates swarm with defaults', () => {
    const sw = new SwarmInstance({
      id: 'sw-1',
      goal: 'build a thing',
      leader: 'pod-a',
    })
    assert.equal(sw.id, 'sw-1')
    assert.equal(sw.goal, 'build a thing')
    assert.equal(sw.leader, 'pod-a')
    assert.deepEqual(sw.members, [])
    assert.equal(sw.strategy, SWARM_STRATEGIES.ROUND_ROBIN)
    assert.equal(sw.status, 'forming')
  })

  it('addMember adds a pod (test 10)', () => {
    const sw = new SwarmInstance({ id: 'sw-1', goal: 'g', leader: 'pod-a' })
    sw.addMember('pod-b')
    sw.addMember('pod-c')
    assert.deepEqual(sw.members, ['pod-b', 'pod-c'])
  })

  it('addMember does not duplicate', () => {
    const sw = new SwarmInstance({ id: 'sw-1', goal: 'g', leader: 'pod-a' })
    sw.addMember('pod-b')
    sw.addMember('pod-b')
    assert.deepEqual(sw.members, ['pod-b'])
  })

  it('removeMember removes a pod (test 11)', () => {
    const sw = new SwarmInstance({
      id: 'sw-1', goal: 'g', leader: 'pod-a',
      members: ['pod-b', 'pod-c'],
    })
    sw.removeMember('pod-b')
    assert.deepEqual(sw.members, ['pod-c'])
  })

  it('getProgress returns correct percentages (test 12)', () => {
    const sw = new SwarmInstance({ id: 'sw-1', goal: 'g', leader: 'pod-a' })
    sw.setSubTasks([
      new SubTask({ id: 'a', description: 'a', status: 'completed' }),
      new SubTask({ id: 'b', description: 'b', status: 'completed' }),
      new SubTask({ id: 'c', description: 'c', status: 'failed' }),
      new SubTask({ id: 'd', description: 'd', status: 'running' }),
    ])
    const p = sw.getProgress()
    assert.equal(p.total, 4)
    assert.equal(p.completed, 2)
    assert.equal(p.failed, 1)
    assert.equal(p.pct, 50)
  })

  it('getProgress with zero tasks', () => {
    const sw = new SwarmInstance({ id: 'sw-1', goal: 'g', leader: 'pod-a' })
    const p = sw.getProgress()
    assert.equal(p.total, 0)
    assert.equal(p.pct, 0)
  })

  it('toJSON/fromJSON round-trip (test 15)', () => {
    const sw = new SwarmInstance({
      id: 'sw-1',
      goal: 'build app',
      leader: 'pod-a',
      members: ['pod-a', 'pod-b'],
      strategy: SWARM_STRATEGIES.CAPABILITY_MATCH,
      status: 'active',
    })
    sw.setSubTasks([
      new SubTask({ id: 'st-1', description: 'part 1', assignee: 'pod-a' }),
    ])
    const json = sw.toJSON()
    const restored = SwarmInstance.fromJSON(json)
    assert.equal(restored.id, 'sw-1')
    assert.equal(restored.goal, 'build app')
    assert.equal(restored.leader, 'pod-a')
    assert.deepEqual(restored.members, ['pod-a', 'pod-b'])
    assert.equal(restored.strategy, SWARM_STRATEGIES.CAPABILITY_MATCH)
    assert.equal(restored.status, 'active')
    assert.equal(restored.getSubTask('st-1').description, 'part 1')
  })

  it('updateSubTask updates status/assignee', () => {
    const sw = new SwarmInstance({ id: 'sw-1', goal: 'g', leader: 'pod-a' })
    sw.setSubTasks([
      new SubTask({ id: 'st-1', description: 'do it' }),
    ])
    sw.updateSubTask('st-1', { status: 'assigned', assignee: 'pod-b' })
    const st = sw.getSubTask('st-1')
    assert.equal(st.status, 'assigned')
    assert.equal(st.assignee, 'pod-b')
  })

  it('getSubTask returns null for unknown id', () => {
    const sw = new SwarmInstance({ id: 'sw-1', goal: 'g', leader: 'pod-a' })
    assert.equal(sw.getSubTask('nope'), null)
  })
})

// ---------------------------------------------------------------------------
// Test: AgentSwarmCoordinator
// ---------------------------------------------------------------------------

describe('AgentSwarmCoordinator', () => {
  let proxy
  let coord
  let logs

  beforeEach(() => {
    proxy = createMockAgentProxy({
      'pod-a': 'alpha result',
      'pod-b': 'beta result',
      'pod-c': 'gamma result',
    })
    logs = []
    coord = new AgentSwarmCoordinator({
      agentProxy: proxy,
      onLog: (level, msg) => logs.push({ level, msg }),
    })
  })

  it('creates swarm with goal and members (test 1)', async () => {
    const sw = await coord.createSwarm('build a website', {
      members: ['pod-a', 'pod-b'],
    })
    assert.equal(sw.goal, 'build a website')
    assert.ok(sw.id)
    assert.deepEqual(sw.members, ['pod-a', 'pod-b'])
    assert.equal(sw.status, 'active')
  })

  it('leader is first member (test 2)', async () => {
    const sw = await coord.createSwarm('do stuff', {
      members: ['pod-x', 'pod-y'],
    })
    assert.equal(sw.leader, 'pod-x')
  })

  it('decompose splits goal into subtasks with custom decomposer (test 3)', async () => {
    const sw = await coord.createSwarm('big goal', {
      members: ['pod-a'],
      decomposer: async (goal) => ['step 1', 'step 2', 'step 3'],
    })
    await coord.decompose(sw.id, async (goal) => ['step 1', 'step 2', 'step 3'])
    const subtasks = sw.subtasks
    assert.equal(subtasks.length, 3)
    assert.equal(subtasks[0].description, 'step 1')
    assert.equal(subtasks[1].description, 'step 2')
    assert.equal(subtasks[2].description, 'step 3')
  })

  it('default decompose creates single subtask (test 4)', async () => {
    const sw = await coord.createSwarm('simple goal', {
      members: ['pod-a'],
    })
    const subtasks = await coord.decompose(sw.id)
    assert.equal(subtasks.length, 1)
    assert.equal(subtasks[0].description, 'simple goal')
  })

  it('assign distributes subtasks round-robin (test 5)', async () => {
    const sw = await coord.createSwarm('goal', {
      members: ['pod-a', 'pod-b'],
      decomposer: async () => ['task 1', 'task 2', 'task 3', 'task 4'],
    })
    await coord.decompose(sw.id, async () => ['task 1', 'task 2', 'task 3', 'task 4'])
    const assignments = await coord.assign(sw.id)
    // round-robin: a, b, a, b
    assert.equal(assignments[0].assignee, 'pod-a')
    assert.equal(assignments[1].assignee, 'pod-b')
    assert.equal(assignments[2].assignee, 'pod-a')
    assert.equal(assignments[3].assignee, 'pod-b')
  })

  it('assign with leader_decompose assigns all to leader (test 6)', async () => {
    const sw = await coord.createSwarm('goal', {
      members: ['pod-a', 'pod-b'],
      strategy: SWARM_STRATEGIES.LEADER_DECOMPOSE,
      decomposer: async () => ['t1', 't2'],
    })
    await coord.decompose(sw.id, async () => ['t1', 't2'])
    const assignments = await coord.assign(sw.id)
    assert.equal(assignments[0].assignee, 'pod-a')
    assert.equal(assignments[1].assignee, 'pod-a')
  })

  it('executeSubTask calls agentProxy.chat (test 7)', async () => {
    const sw = await coord.createSwarm('goal', {
      members: ['pod-a'],
    })
    await coord.decompose(sw.id)
    await coord.assign(sw.id)
    const st = sw.subtasks[0]
    const result = await coord.executeSubTask(sw.id, st.id, 'pod-a')
    assert.equal(result.success, true)
    assert.equal(result.result, 'alpha result')
    assert.ok(proxy.calls.some(c => c.podId === 'pod-a'))
  })

  it('executeSubTask updates subtask status (test 8)', async () => {
    const sw = await coord.createSwarm('goal', {
      members: ['pod-a'],
    })
    await coord.decompose(sw.id)
    await coord.assign(sw.id)
    const st = sw.subtasks[0]
    await coord.executeSubTask(sw.id, st.id, 'pod-a')
    assert.equal(sw.getSubTask(st.id).status, 'completed')
  })

  it('collectResults gathers all completed results (test 9)', async () => {
    const sw = await coord.createSwarm('goal', {
      members: ['pod-a', 'pod-b'],
      decomposer: async () => ['do A', 'do B'],
    })
    await coord.decompose(sw.id, async () => ['do A', 'do B'])
    await coord.assign(sw.id)

    // Execute both subtasks
    for (const st of sw.subtasks) {
      await coord.executeSubTask(sw.id, st.id, st.assignee)
    }

    const results = await coord.collectResults(sw.id)
    assert.equal(results.individual.length, 2)
    assert.ok(results.merged.includes('alpha result'))
    assert.ok(results.merged.includes('beta result'))
  })

  it('timeout on slow agent (test 13)', async () => {
    const slowProxy = {
      async chat() {
        await new Promise(r => setTimeout(r, 200))
        return 'slow result'
      },
    }
    const c = new AgentSwarmCoordinator({
      agentProxy: slowProxy,
      onLog: () => {},
    })
    const sw = await c.createSwarm('goal', {
      members: ['pod-a'],
      timeoutMs: 50,
    })
    await c.decompose(sw.id)
    await c.assign(sw.id)
    const st = sw.subtasks[0]
    const result = await c.executeSubTask(sw.id, st.id, 'pod-a')
    assert.equal(result.success, false)
    assert.ok(result.error.includes('timeout') || result.error.includes('Timeout'))
  })

  it('events emitted for lifecycle (test 14)', async () => {
    const events = []
    coord.on('created', (d) => events.push({ type: 'created', d }))
    coord.on('task-assigned', (d) => events.push({ type: 'task-assigned', d }))
    coord.on('subtask-complete', (d) => events.push({ type: 'subtask-complete', d }))
    coord.on('completed', (d) => events.push({ type: 'completed', d }))

    const sw = await coord.createSwarm('goal', {
      members: ['pod-a'],
    })
    assert.ok(events.some(e => e.type === 'created'))

    await coord.decompose(sw.id)
    await coord.assign(sw.id)
    assert.ok(events.some(e => e.type === 'task-assigned'))

    for (const st of sw.subtasks) {
      await coord.executeSubTask(sw.id, st.id, st.assignee)
    }
    assert.ok(events.some(e => e.type === 'subtask-complete'))

    await coord.collectResults(sw.id)
    assert.ok(events.some(e => e.type === 'completed'))
  })

  it('listSwarms returns all swarms', async () => {
    await coord.createSwarm('g1', { members: ['pod-a'] })
    await coord.createSwarm('g2', { members: ['pod-b'] })
    const list = coord.listSwarms()
    assert.equal(list.length, 2)
  })

  it('disbandSwarm sets status to disbanded', async () => {
    const sw = await coord.createSwarm('g', { members: ['pod-a'] })
    await coord.disbandSwarm(sw.id)
    assert.equal(coord.getSwarm(sw.id).status, 'disbanded')
  })
})
