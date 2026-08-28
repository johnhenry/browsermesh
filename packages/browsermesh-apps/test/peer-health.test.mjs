/**
 * Tests for HealthMonitor and AutoMigrator — automatic health monitoring
 * with self-healing workload migration.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/peer-health.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  HEALTH_DEFAULTS,
  HEALTH_STATUSES,
  PeerHealth,
  MigrationResult,
  HealthMonitor,
  AutoMigrator,
} from '../src/peer-health.mjs'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockSessions() {
  const sent = []
  return {
    listSessions() {
      return [
        { remotePodId: 'peer-a', sessionId: 's1', send(type, payload) { sent.push({ to: 'peer-a', type, payload }) } },
        { remotePodId: 'peer-b', sessionId: 's2', send(type, payload) { sent.push({ to: 'peer-b', type, payload }) } },
      ]
    },
    get sent() { return sent },
  }
}

function createMockOrchestrator() {
  const calls = []
  return {
    async drainPod(podId) { calls.push({ action: 'drain', podId }) },
    listPods() { return ['peer-a', 'peer-b', 'peer-c'] },
    async deploySkill(podId, skill) { calls.push({ action: 'deploy', podId, skill }) },
    get calls() { return calls },
  }
}

// ---------------------------------------------------------------------------
// Tests — Constants
// ---------------------------------------------------------------------------

describe('HEALTH_DEFAULTS', () => {
  it('has expected default values', () => {
    assert.equal(HEALTH_DEFAULTS.heartbeatIntervalMs, 10000)
    assert.equal(HEALTH_DEFAULTS.heartbeatTimeoutMs, 5000)
    assert.equal(HEALTH_DEFAULTS.maxMissedHeartbeats, 3)
    assert.equal(HEALTH_DEFAULTS.degradedThresholdMs, 2000)
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(HEALTH_DEFAULTS))
  })
})

describe('HEALTH_STATUSES', () => {
  it('contains expected statuses', () => {
    assert.deepEqual([...HEALTH_STATUSES], ['healthy', 'degraded', 'failed', 'unknown'])
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(HEALTH_STATUSES))
  })
})

// ---------------------------------------------------------------------------
// Tests — PeerHealth
// ---------------------------------------------------------------------------

describe('PeerHealth', () => {
  it('creates with defaults', () => {
    const h = new PeerHealth({ podId: 'p1' })
    assert.equal(h.podId, 'p1')
    assert.equal(h.status, 'unknown')
    assert.equal(h.missedHeartbeats, 0)
    assert.equal(h.latencyMs, 0)
    assert.equal(h.uptimeMs, 0)
  })

  it('toJSON serializes all fields', () => {
    const h = new PeerHealth({ podId: 'p1', status: 'healthy', latencyMs: 50 })
    const json = h.toJSON()
    assert.equal(json.podId, 'p1')
    assert.equal(json.status, 'healthy')
    assert.equal(json.latencyMs, 50)
  })
})

// ---------------------------------------------------------------------------
// Tests — MigrationResult
// ---------------------------------------------------------------------------

describe('MigrationResult', () => {
  it('creates with all fields', () => {
    const r = new MigrationResult({
      success: true,
      fromPod: 'a',
      toPod: 'b',
      workload: 'agent',
      durationMs: 150,
    })
    assert.equal(r.success, true)
    assert.equal(r.fromPod, 'a')
    assert.equal(r.toPod, 'b')
    assert.equal(r.workload, 'agent')
    assert.equal(r.durationMs, 150)
    assert.equal(r.error, null)
  })

  it('toJSON includes error when present', () => {
    const r = new MigrationResult({
      success: false,
      fromPod: 'a',
      toPod: 'b',
      error: 'timeout',
    })
    const json = r.toJSON()
    assert.equal(json.success, false)
    assert.equal(json.error, 'timeout')
  })
})

// ---------------------------------------------------------------------------
// Tests — HealthMonitor
// ---------------------------------------------------------------------------

describe('HealthMonitor', () => {
  let sessions
  let monitor

  beforeEach(() => {
    sessions = createMockSessions()
    monitor = new HealthMonitor({ sessions })
  })

  afterEach(() => {
    monitor.stop()
  })

  // -- Test 1: Start sends periodic heartbeats --------------------------------

  it('start sends periodic heartbeats', async () => {
    // Use a very short interval so we can observe sends
    monitor.start(20)

    // Wait enough for at least one tick
    await new Promise((r) => setTimeout(r, 60))
    monitor.stop()

    // Should have sent heartbeat pings to both peers
    assert.ok(sessions.sent.length >= 2, `Expected at least 2 sends, got ${sessions.sent.length}`)
    const peerAPings = sessions.sent.filter((s) => s.to === 'peer-a' && s.type === 'heartbeat:ping')
    const peerBPings = sessions.sent.filter((s) => s.to === 'peer-b' && s.type === 'heartbeat:ping')
    assert.ok(peerAPings.length >= 1)
    assert.ok(peerBPings.length >= 1)
  })

  // -- Test 2: recordHeartbeat sets status to healthy -------------------------

  it('recordHeartbeat sets status to healthy', () => {
    monitor.recordHeartbeat('peer-a', 100)
    const health = monitor.getPeerHealth('peer-a')
    assert.ok(health)
    assert.equal(health.status, 'healthy')
    assert.equal(health.missedHeartbeats, 0)
    assert.equal(health.latencyMs, 100)
  })

  // -- Test 3: Missed heartbeat increments missed count -----------------------

  it('missed heartbeat increments missed count', async () => {
    // Record initial heartbeat so the peer is tracked
    monitor.recordHeartbeat('peer-a', 50)

    // Start with short interval
    monitor.start(20)
    await new Promise((r) => setTimeout(r, 60))
    monitor.stop()

    const health = monitor.getPeerHealth('peer-a')
    assert.ok(health)
    assert.ok(health.missedHeartbeats >= 1, `Expected >= 1 missed, got ${health.missedHeartbeats}`)
  })

  // -- Test 4: Status transitions to degraded after 1 miss --------------------

  it('status transitions to degraded after 1 miss', async () => {
    // Record initial heartbeat
    monitor.recordHeartbeat('peer-a', 50)
    assert.equal(monitor.getPeerHealth('peer-a').status, 'healthy')

    // One tick should increment missed and transition to degraded
    monitor.start(20)
    await new Promise((r) => setTimeout(r, 40))
    monitor.stop()

    const health = monitor.getPeerHealth('peer-a')
    assert.ok(health)
    assert.ok(
      health.status === 'degraded' || health.status === 'failed',
      `Expected degraded or failed, got ${health.status}`,
    )
  })

  // -- Test 5: Status transitions to failed after maxMissedHeartbeats ---------

  it('status transitions to failed after maxMissedHeartbeats', async () => {
    monitor.setThresholds({ maxMissedHeartbeats: 2 })
    monitor.recordHeartbeat('peer-a', 50)

    // Run enough ticks for the peer to be marked failed
    monitor.start(15)
    await new Promise((r) => setTimeout(r, 100))
    monitor.stop()

    const health = monitor.getPeerHealth('peer-a')
    assert.ok(health)
    assert.equal(health.status, 'failed')
  })

  // -- Test 6: Recovery: failed -> healthy on new heartbeat -------------------

  it('recovery: failed->healthy on new heartbeat, emits recovered', async () => {
    const events = []
    monitor.on('recovered', (h) => events.push(h))

    // Set low threshold to reach failed state quickly
    monitor.setThresholds({ maxMissedHeartbeats: 2 })
    monitor.recordHeartbeat('peer-a', 50)

    // Let it go to failed
    monitor.start(15)
    await new Promise((r) => setTimeout(r, 80))
    monitor.stop()

    assert.equal(monitor.getPeerHealth('peer-a').status, 'failed')

    // Now record a heartbeat — should recover
    monitor.recordHeartbeat('peer-a', 30)

    const health = monitor.getPeerHealth('peer-a')
    assert.equal(health.status, 'healthy')
    assert.equal(health.missedHeartbeats, 0)
    assert.equal(events.length, 1)
    assert.equal(events[0].podId, 'peer-a')
  })

  // -- Test 7: getPeerHealth returns correct data -----------------------------

  it('getPeerHealth returns correct data', () => {
    assert.equal(monitor.getPeerHealth('nonexistent'), null)

    monitor.recordHeartbeat('peer-a', 200)
    const health = monitor.getPeerHealth('peer-a')
    assert.equal(health.podId, 'peer-a')
    assert.equal(health.latencyMs, 200)
    assert.ok(health.lastHeartbeat > 0)
  })

  // -- Test 8: getStatus returns all peers ------------------------------------

  it('getStatus returns all peers', () => {
    monitor.recordHeartbeat('peer-a', 10)
    monitor.recordHeartbeat('peer-b', 20)

    const status = monitor.getStatus()
    assert.ok(status instanceof Map)
    assert.equal(status.size, 2)
    assert.ok(status.has('peer-a'))
    assert.ok(status.has('peer-b'))
  })

  // -- Test 9: Stop clears interval ------------------------------------------

  it('stop clears interval', async () => {
    monitor.start(20)
    monitor.stop()

    const countBefore = sessions.sent.length
    await new Promise((r) => setTimeout(r, 60))
    const countAfter = sessions.sent.length

    assert.equal(countBefore, countAfter, 'No new heartbeats should be sent after stop')
  })

  // -- Test 10: Thresholds configurable via setThresholds ---------------------

  it('thresholds configurable via setThresholds', () => {
    monitor.setThresholds({ degradedThresholdMs: 500 })

    // Latency of 600 should trigger degraded
    monitor.recordHeartbeat('peer-a', 600)
    assert.equal(monitor.getPeerHealth('peer-a').status, 'degraded')

    // Latency of 400 should be healthy
    monitor.recordHeartbeat('peer-b', 400)
    assert.equal(monitor.getPeerHealth('peer-b').status, 'healthy')
  })
})

// ---------------------------------------------------------------------------
// Tests — AutoMigrator
// ---------------------------------------------------------------------------

describe('AutoMigrator', () => {
  let sessions
  let monitor
  let orchestrator
  let migrator

  beforeEach(() => {
    sessions = createMockSessions()
    monitor = new HealthMonitor({ sessions })
    orchestrator = createMockOrchestrator()
    migrator = new AutoMigrator({ healthMonitor: monitor, orchestrator })
  })

  afterEach(() => {
    migrator.disable()
    monitor.stop()
  })

  // -- Test 11: Enable listens to failed events -------------------------------

  it('enable listens to failed events', async () => {
    const migrated = []
    migrator.on('migrating', (ev) => migrated.push(ev))

    migrator.enable()

    // Set threshold low so peers reach failed quickly
    monitor.setThresholds({ maxMissedHeartbeats: 2 })

    // Record heartbeats for both peers so they are tracked
    monitor.recordHeartbeat('peer-a', 50)
    monitor.recordHeartbeat('peer-b', 50)

    monitor.start(15)
    await new Promise((r) => setTimeout(r, 100))
    monitor.stop()

    // Give the async migration a tick to fire
    await new Promise((r) => setTimeout(r, 20))

    // At least one migration event should fire when a peer goes to failed
    assert.ok(migrated.length >= 1, `Expected migration event, got ${migrated.length}`)
    // The fromPod should be one of the two peers
    const fromPods = migrated.map((m) => m.fromPod)
    assert.ok(
      fromPods.includes('peer-a') || fromPods.includes('peer-b'),
      `Expected migration from peer-a or peer-b, got ${fromPods}`,
    )
  })

  // -- Test 12: migrateNow calls orchestrator.drainPod ------------------------

  it('migrateNow calls orchestrator.drainPod', async () => {
    // Set up healthy target
    monitor.recordHeartbeat('peer-b', 50)

    const result = await migrator.migrateNow('peer-a', 'peer-b')
    assert.equal(result.success, true)
    assert.equal(result.fromPod, 'peer-a')
    assert.equal(result.toPod, 'peer-b')
    assert.ok(result.durationMs >= 0)

    assert.equal(orchestrator.calls.length, 1)
    assert.equal(orchestrator.calls[0].action, 'drain')
    assert.equal(orchestrator.calls[0].podId, 'peer-a')
  })

  // -- Test 13: Auto-select picks healthiest target ---------------------------

  it('auto-select picks healthiest target', async () => {
    // peer-b is healthy, peer-c is degraded
    monitor.recordHeartbeat('peer-b', 50)
    monitor.recordHeartbeat('peer-c', 3000) // above degraded threshold

    // Manually mark peer-a as the source (no heartbeat)
    const result = await migrator.migrateNow('peer-a')
    assert.equal(result.success, true)
    // Should pick peer-b (healthy, low latency) over peer-c (degraded)
    assert.equal(result.toPod, 'peer-b')
  })

  // -- Test 14: Events emitted for full lifecycle -----------------------------

  it('events emitted for full lifecycle', async () => {
    const events = []
    migrator.on('migrating', (ev) => events.push({ type: 'migrating', ...ev }))
    migrator.on('migrated', (ev) => events.push({ type: 'migrated', ...ev.toJSON() }))
    migrator.on('migration-failed', (ev) => events.push({ type: 'migration-failed', ...ev.toJSON() }))

    monitor.recordHeartbeat('peer-b', 50)

    const result = await migrator.migrateNow('peer-a', 'peer-b')
    assert.equal(result.success, true)

    assert.equal(events.length, 2)
    assert.equal(events[0].type, 'migrating')
    assert.equal(events[0].fromPod, 'peer-a')
    assert.equal(events[0].toPod, 'peer-b')
    assert.equal(events[1].type, 'migrated')
    assert.equal(events[1].success, true)
  })

  // -- Constructor validation -----------------------------------------------

  it('requires healthMonitor', () => {
    assert.throws(
      () => new AutoMigrator({ orchestrator }),
      /healthMonitor is required/,
    )
  })

  it('requires orchestrator with drainPod', () => {
    assert.throws(
      () => new AutoMigrator({ healthMonitor: monitor, orchestrator: {} }),
      /orchestrator with drainPod/,
    )
  })

  it('migrateNow returns failure when no target available', async () => {
    // No peers recorded — no target
    const result = await migrator.migrateNow('peer-a')
    assert.equal(result.success, false)
    assert.equal(result.error, 'No healthy target pod available')
  })
})
