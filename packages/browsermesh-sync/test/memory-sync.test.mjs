/**
 * Tests for CRDT-backed agent memory sync — AgentMemorySync, MemoryEntry,
 * ConflictEntry, SyncResult.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/memory-sync.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  AgentMemorySync,
  MemoryEntry,
  ConflictEntry,
  SyncResult,
  CONFLICT_STRATEGIES,
  MEMORY_SYNC_DEFAULTS,
} from '../src/memory-sync.mjs'

// ---------------------------------------------------------------------------
// Helpers — mock session
// ---------------------------------------------------------------------------

function createMockSession(remotePodId = 'pod-remote') {
  const handlers = new Map()
  const sent = []
  return {
    remotePodId,
    send(type, payload) { sent.push({ type, payload }) },
    registerHandler(type, cb) { handlers.set(type, cb) },
    removeHandler(type) { handlers.delete(type) },
    _triggerHandler(type, envelope) {
      const handler = handlers.get(type)
      if (handler) handler(envelope)
    },
    _hasHandler(type) { return handlers.has(type) },
    sent,
    handlers,
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('CONFLICT_STRATEGIES', () => {
  it('has correct values and is frozen', () => {
    assert.equal(CONFLICT_STRATEGIES.LAST_WRITE_WINS, 'lww')
    assert.equal(CONFLICT_STRATEGIES.TRUST_WEIGHTED, 'trust')
    assert.equal(CONFLICT_STRATEGIES.KEEP_BOTH, 'keep_both')
    assert.equal(CONFLICT_STRATEGIES.ASK_USER, 'ask_user')
    assert.ok(Object.isFrozen(CONFLICT_STRATEGIES))
  })
})

describe('MEMORY_SYNC_DEFAULTS', () => {
  it('has correct defaults and is frozen', () => {
    assert.equal(MEMORY_SYNC_DEFAULTS.syncIntervalMs, 30_000)
    assert.equal(MEMORY_SYNC_DEFAULTS.conflictStrategy, 'lww')
    assert.ok(Object.isFrozen(MEMORY_SYNC_DEFAULTS))
  })
})

// ---------------------------------------------------------------------------
// MemoryEntry
// ---------------------------------------------------------------------------

describe('MemoryEntry', () => {
  it('creates entry with required fields', () => {
    const entry = new MemoryEntry({ key: 'name', value: 'Alice' })
    assert.equal(entry.key, 'name')
    assert.equal(entry.value, 'Alice')
    assert.equal(entry.category, 'core')
    assert.equal(entry.tombstone, false)
    assert.equal(typeof entry.timestamp, 'number')
  })

  it('throws on missing key', () => {
    assert.throws(() => new MemoryEntry({ value: 'x' }), /key is required/)
  })

  it('round-trips through toJSON / fromJSON', () => {
    const original = new MemoryEntry({
      key: 'pref',
      value: { theme: 'dark' },
      category: 'user',
      timestamp: 1000,
      podId: 'pod-1',
      tombstone: false,
    })
    const json = original.toJSON()
    const restored = MemoryEntry.fromJSON(json)
    assert.equal(restored.key, 'pref')
    assert.deepEqual(restored.value, { theme: 'dark' })
    assert.equal(restored.category, 'user')
    assert.equal(restored.timestamp, 1000)
    assert.equal(restored.podId, 'pod-1')
    assert.equal(restored.tombstone, false)
  })
})

// ---------------------------------------------------------------------------
// ConflictEntry
// ---------------------------------------------------------------------------

describe('ConflictEntry', () => {
  it('serializes to JSON', () => {
    const local = new MemoryEntry({ key: 'k', value: 'A', timestamp: 1 })
    const remote = new MemoryEntry({ key: 'k', value: 'B', timestamp: 2 })
    const conflict = new ConflictEntry({
      key: 'k',
      local,
      remote,
      strategy: 'lww',
    })
    const json = conflict.toJSON()
    assert.equal(json.key, 'k')
    assert.equal(json.local.value, 'A')
    assert.equal(json.remote.value, 'B')
    assert.equal(json.strategy, 'lww')
    assert.equal(json.resolved, false)
  })
})

// ---------------------------------------------------------------------------
// SyncResult
// ---------------------------------------------------------------------------

describe('SyncResult', () => {
  it('captures merge count and conflicts', () => {
    const result = new SyncResult({ merged: 5, conflicts: [{ key: 'x' }] })
    assert.equal(result.merged, 5)
    assert.equal(result.conflicts.length, 1)
    assert.equal(typeof result.timestamp, 'number')
  })
})

// ---------------------------------------------------------------------------
// AgentMemorySync — constructor validation
// ---------------------------------------------------------------------------

describe('AgentMemorySync — constructor', () => {
  it('throws without agentId', () => {
    assert.throws(
      () => new AgentMemorySync({ session: createMockSession() }),
      /agentId is required/,
    )
  })

  it('throws without session.send', () => {
    assert.throws(
      () => new AgentMemorySync({ agentId: 'a1', session: {} }),
      /session with send/,
    )
  })

  it('throws without session.registerHandler', () => {
    assert.throws(
      () => new AgentMemorySync({
        agentId: 'a1',
        session: { send() {}, remotePodId: 'x' },
      }),
      /session with registerHandler/,
    )
  })
})

// ---------------------------------------------------------------------------
// AgentMemorySync — enable / disable
// ---------------------------------------------------------------------------

describe('AgentMemorySync — enable / disable', () => {
  let sync
  let session

  beforeEach(() => {
    session = createMockSession()
    sync = new AgentMemorySync({ agentId: 'agent-1', session })
  })

  afterEach(() => {
    sync.disable()
  })

  // Test 1: Enable starts periodic sync interval
  it('enable starts periodic sync interval and registers handler', () => {
    sync.enable({ syncIntervalMs: 100 })
    const status = sync.getSyncStatus()
    assert.equal(status.enabled, true)
    assert.ok(session._hasHandler('memory-sync'))
  })

  // Test 2: Disable clears interval and handler
  it('disable clears interval and removes handler', () => {
    sync.enable({ syncIntervalMs: 100 })
    sync.disable()
    const status = sync.getSyncStatus()
    assert.equal(status.enabled, false)
    assert.ok(!session._hasHandler('memory-sync'))
  })
})

// ---------------------------------------------------------------------------
// AgentMemorySync — applyLocalOp
// ---------------------------------------------------------------------------

describe('AgentMemorySync — applyLocalOp', () => {
  let sync
  let session

  beforeEach(() => {
    session = createMockSession()
    sync = new AgentMemorySync({ agentId: 'agent-1', session })
  })

  afterEach(() => {
    sync.disable()
  })

  // Test 3: applyLocalOp stores entry in state
  it('stores entry in state', () => {
    sync.applyLocalOp({
      type: 'store',
      key: 'user_name',
      value: 'Alice',
      category: 'user',
      timestamp: 5000,
    })

    const state = sync.getState()
    assert.equal(state.size, 1)
    const entry = state.get('user_name')
    assert.ok(entry)
    assert.equal(entry.value, 'Alice')
    assert.equal(entry.category, 'user')
    assert.equal(entry.tombstone, false)
  })

  // Test 4: applyLocalOp with 'forget' creates tombstone
  it('forget creates tombstone', () => {
    // First store an entry
    sync.applyLocalOp({ type: 'store', key: 'secret', value: 'abc', timestamp: 1000 })
    assert.equal(sync.getState().size, 1)

    // Now forget it
    sync.applyLocalOp({ type: 'forget', key: 'secret', timestamp: 2000 })

    // getState() should not include tombstoned entries
    assert.equal(sync.getState().size, 0)

    // But the full internal state should have a tombstone
    const full = sync.getFullState()
    assert.equal(full.size, 1)
    const entry = full.get('secret')
    assert.ok(entry)
    assert.equal(entry.tombstone, true)
    assert.equal(entry.timestamp, 2000)
  })

  // Test 10: getSyncStatus reports pending ops
  it('getSyncStatus reports pending ops', () => {
    sync.applyLocalOp({ type: 'store', key: 'a', value: 1, timestamp: 1000 })
    sync.applyLocalOp({ type: 'store', key: 'b', value: 2, timestamp: 2000 })

    const status = sync.getSyncStatus()
    assert.equal(status.pendingOps, 2)
    assert.equal(status.enabled, false)
    assert.equal(status.lastSync, null)
  })
})

// ---------------------------------------------------------------------------
// AgentMemorySync — merge
// ---------------------------------------------------------------------------

describe('AgentMemorySync — merge', () => {
  let sync
  let session

  beforeEach(() => {
    session = createMockSession()
    sync = new AgentMemorySync({ agentId: 'agent-1', session })
  })

  afterEach(() => {
    sync.disable()
  })

  // Test 5: merge with no conflicts applies all remote entries
  it('applies all remote entries when no local entries exist', () => {
    const remoteState = [
      { key: 'fact1', value: 'sky is blue', category: 'learned', timestamp: 1000, podId: 'pod-2', tombstone: false },
      { key: 'fact2', value: 'water is wet', category: 'learned', timestamp: 2000, podId: 'pod-2', tombstone: false },
    ]

    const result = sync.merge(remoteState)
    assert.equal(result.merged, 2)
    assert.equal(result.conflicts.length, 0)

    const state = sync.getState()
    assert.equal(state.size, 2)
    assert.equal(state.get('fact1').value, 'sky is blue')
    assert.equal(state.get('fact2').value, 'water is wet')
  })

  // Test 6: merge with LWW picks latest timestamp
  it('LWW strategy picks latest timestamp', () => {
    // Set up local entry with earlier timestamp
    sync.applyLocalOp({ type: 'store', key: 'name', value: 'Alice', timestamp: 1000 })

    // Merge remote entry with later timestamp
    const remoteState = [
      { key: 'name', value: 'Bob', category: 'core', timestamp: 2000, podId: 'pod-2', tombstone: false },
    ]

    const result = sync.merge(remoteState)
    assert.equal(result.merged, 1)
    assert.equal(sync.getState().get('name').value, 'Bob')
  })

  it('LWW strategy keeps local when local timestamp is later', () => {
    sync.applyLocalOp({ type: 'store', key: 'name', value: 'Alice', timestamp: 3000 })

    const remoteState = [
      { key: 'name', value: 'Bob', category: 'core', timestamp: 1000, podId: 'pod-2', tombstone: false },
    ]

    const result = sync.merge(remoteState)
    assert.equal(result.merged, 0)
    assert.equal(sync.getState().get('name').value, 'Alice')
  })

  // Test 7: merge with KEEP_BOTH stores both entries
  it('KEEP_BOTH strategy stores both entries', () => {
    sync.enable({ conflictStrategy: CONFLICT_STRATEGIES.KEEP_BOTH })

    sync.applyLocalOp({ type: 'store', key: 'color', value: 'red', timestamp: 1000 })

    const remoteState = [
      { key: 'color', value: 'blue', category: 'core', timestamp: 2000, podId: 'pod-2', tombstone: false },
    ]

    const result = sync.merge(remoteState)
    assert.equal(result.merged, 1)

    const state = sync.getState()
    // Local 'color' should still be 'red'
    assert.equal(state.get('color').value, 'red')
    // Remote should be stored under 'color__conflict_1'
    assert.equal(state.get('color__conflict_1').value, 'blue')

    sync.disable()
  })

  // Test 8: merge with ASK_USER creates unresolved conflict
  it('ASK_USER strategy creates unresolved conflict', () => {
    sync.enable({ conflictStrategy: CONFLICT_STRATEGIES.ASK_USER })

    sync.applyLocalOp({ type: 'store', key: 'lang', value: 'en', timestamp: 1000 })

    const remoteState = [
      { key: 'lang', value: 'fr', category: 'core', timestamp: 2000, podId: 'pod-2', tombstone: false },
    ]

    const conflictEvents = []
    sync.on('conflict', (c) => conflictEvents.push(c))

    const result = sync.merge(remoteState)
    assert.equal(result.merged, 0)
    assert.equal(result.conflicts.length, 1)
    assert.equal(result.conflicts[0].key, 'lang')
    assert.equal(result.conflicts[0].resolved, false)

    // Local state should remain unchanged
    assert.equal(sync.getState().get('lang').value, 'en')

    // Conflict event should have fired
    assert.equal(conflictEvents.length, 1)

    // getSyncStatus should report 1 unresolved conflict
    assert.equal(sync.getSyncStatus().conflicts, 1)

    sync.disable()
  })

  // Test 11: Tombstone with later timestamp wins over value
  it('tombstone with later timestamp wins over value', () => {
    // Local has a live entry at t=1000
    sync.applyLocalOp({ type: 'store', key: 'secret', value: 'shh', timestamp: 1000 })

    // Remote sends a tombstone at t=2000
    const remoteState = [
      { key: 'secret', value: undefined, category: 'core', timestamp: 2000, podId: 'pod-2', tombstone: true },
    ]

    const result = sync.merge(remoteState)
    assert.equal(result.merged, 1)

    // getState() should not include tombstoned entries
    assert.equal(sync.getState().has('secret'), false)

    // Full state should show tombstone
    const full = sync.getFullState()
    assert.equal(full.get('secret').tombstone, true)
  })

  it('value with later timestamp wins over tombstone', () => {
    // Local has a tombstone at t=1000
    sync.applyLocalOp({ type: 'store', key: 'item', value: 'old', timestamp: 500 })
    sync.applyLocalOp({ type: 'forget', key: 'item', timestamp: 1000 })

    // Remote sends a live value at t=2000
    const remoteState = [
      { key: 'item', value: 'revived', category: 'core', timestamp: 2000, podId: 'pod-2', tombstone: false },
    ]

    const result = sync.merge(remoteState)
    assert.equal(result.merged, 1)

    const state = sync.getState()
    assert.equal(state.get('item').value, 'revived')
  })
})

// ---------------------------------------------------------------------------
// AgentMemorySync — resolveConflict
// ---------------------------------------------------------------------------

describe('AgentMemorySync — resolveConflict', () => {
  let sync
  let session

  beforeEach(() => {
    session = createMockSession()
    sync = new AgentMemorySync({ agentId: 'agent-1', session })
    sync.enable({ conflictStrategy: CONFLICT_STRATEGIES.ASK_USER })
  })

  afterEach(() => {
    sync.disable()
  })

  // Test 9: resolveConflict resolves a pending conflict
  it('resolves a pending conflict with keep_remote', () => {
    sync.applyLocalOp({ type: 'store', key: 'city', value: 'NYC', timestamp: 1000 })

    const remoteState = [
      { key: 'city', value: 'London', category: 'core', timestamp: 2000, podId: 'pod-2', tombstone: false },
    ]

    sync.merge(remoteState)
    assert.equal(sync.getSyncStatus().conflicts, 1)

    sync.resolveConflict('city', 'keep_remote')
    assert.equal(sync.getState().get('city').value, 'London')
    assert.equal(sync.getSyncStatus().conflicts, 0)
  })

  it('resolves a pending conflict with keep_local', () => {
    sync.applyLocalOp({ type: 'store', key: 'city', value: 'NYC', timestamp: 1000 })

    const remoteState = [
      { key: 'city', value: 'London', category: 'core', timestamp: 2000, podId: 'pod-2', tombstone: false },
    ]

    sync.merge(remoteState)
    sync.resolveConflict('city', 'keep_local')
    assert.equal(sync.getState().get('city').value, 'NYC')
    assert.equal(sync.getSyncStatus().conflicts, 0)
  })

  it('resolves a pending conflict with keep_both', () => {
    sync.applyLocalOp({ type: 'store', key: 'city', value: 'NYC', timestamp: 1000 })

    const remoteState = [
      { key: 'city', value: 'London', category: 'core', timestamp: 2000, podId: 'pod-2', tombstone: false },
    ]

    sync.merge(remoteState)
    sync.resolveConflict('city', 'keep_both')

    const state = sync.getState()
    assert.equal(state.get('city').value, 'NYC')
    assert.equal(state.get('city__conflict_1').value, 'London')
    assert.equal(sync.getSyncStatus().conflicts, 0)
  })

  it('throws when no unresolved conflict exists', () => {
    assert.throws(
      () => sync.resolveConflict('nonexistent', 'keep_local'),
      /No unresolved conflict/,
    )
  })
})

// ---------------------------------------------------------------------------
// AgentMemorySync — syncNow
// ---------------------------------------------------------------------------

describe('AgentMemorySync — syncNow', () => {
  let sync
  let session

  beforeEach(() => {
    session = createMockSession()
    sync = new AgentMemorySync({ agentId: 'agent-1', session })
  })

  afterEach(() => {
    sync.disable()
  })

  it('sends local state to peer and clears pending ops', async () => {
    sync.applyLocalOp({ type: 'store', key: 'x', value: 1, timestamp: 1000 })
    sync.applyLocalOp({ type: 'store', key: 'y', value: 2, timestamp: 2000 })

    assert.equal(sync.getSyncStatus().pendingOps, 2)

    const result = await sync.syncNow()
    assert.equal(result.merged, 0)
    assert.equal(result.conflicts.length, 0)

    // Should have sent one memory-sync message
    assert.equal(session.sent.length, 1)
    assert.equal(session.sent[0].type, 'memory-sync')
    assert.equal(session.sent[0].payload.length, 2)

    // Pending ops should be cleared
    assert.equal(sync.getSyncStatus().pendingOps, 0)
    assert.ok(sync.getSyncStatus().lastSync !== null)
  })

  it('emits synced event', async () => {
    const events = []
    sync.on('synced', (r) => events.push(r))

    await sync.syncNow()
    assert.equal(events.length, 1)
    assert.ok(events[0] instanceof SyncResult)
  })
})

// ---------------------------------------------------------------------------
// AgentMemorySync — toJSON / fromJSON round-trip
// ---------------------------------------------------------------------------

describe('AgentMemorySync — toJSON / fromJSON', () => {
  let session

  beforeEach(() => {
    session = createMockSession()
  })

  // Test 12: toJSON/fromJSON round-trip preserves state
  it('round-trip preserves state', () => {
    const original = new AgentMemorySync({ agentId: 'agent-1', session })
    original.applyLocalOp({ type: 'store', key: 'a', value: 1, timestamp: 1000 })
    original.applyLocalOp({ type: 'store', key: 'b', value: 2, timestamp: 2000 })
    original.applyLocalOp({ type: 'forget', key: 'a', timestamp: 3000 })

    const json = original.toJSON()
    assert.equal(json.agentId, 'agent-1')
    assert.equal(json.state.length, 2) // 'a' (tombstoned) and 'b'

    const restored = AgentMemorySync.fromJSON(json, { session })
    const state = restored.getState()
    // Only 'b' should be live
    assert.equal(state.size, 1)
    assert.equal(state.get('b').value, 2)

    // Full state should have both including tombstone
    const full = restored.getFullState()
    assert.equal(full.size, 2)
    assert.equal(full.get('a').tombstone, true)
  })

  it('round-trip preserves conflicts', () => {
    const original = new AgentMemorySync({ agentId: 'agent-1', session })
    original.enable({ conflictStrategy: CONFLICT_STRATEGIES.ASK_USER })

    original.applyLocalOp({ type: 'store', key: 'x', value: 'local', timestamp: 1000 })
    original.merge([
      { key: 'x', value: 'remote', category: 'core', timestamp: 2000, podId: 'pod-2', tombstone: false },
    ])

    const json = original.toJSON()
    assert.equal(json.conflicts.length, 1)

    const restored = AgentMemorySync.fromJSON(json, { session })
    assert.equal(restored.getSyncStatus().conflicts, 1)

    original.disable()
  })
})

// ---------------------------------------------------------------------------
// AgentMemorySync — events
// ---------------------------------------------------------------------------

describe('AgentMemorySync — events', () => {
  let sync
  let session

  beforeEach(() => {
    session = createMockSession()
    sync = new AgentMemorySync({ agentId: 'agent-1', session })
  })

  afterEach(() => {
    sync.disable()
  })

  it('emits op-applied on local ops', () => {
    const events = []
    sync.on('op-applied', (e) => events.push(e))

    sync.applyLocalOp({ type: 'store', key: 'k', value: 'v', timestamp: 1000 })
    assert.equal(events.length, 1)
    assert.equal(events[0].op, 'store')
    assert.equal(events[0].key, 'k')
  })

  it('off removes listener', () => {
    const events = []
    const cb = (e) => events.push(e)
    sync.on('op-applied', cb)
    sync.off('op-applied', cb)

    sync.applyLocalOp({ type: 'store', key: 'k', value: 'v', timestamp: 1000 })
    assert.equal(events.length, 0)
  })
})

// ---------------------------------------------------------------------------
// AgentMemorySync — incoming handler via session
// ---------------------------------------------------------------------------

describe('AgentMemorySync — session handler', () => {
  let sync
  let session

  beforeEach(() => {
    session = createMockSession()
    sync = new AgentMemorySync({ agentId: 'agent-1', session })
    sync.enable()
  })

  afterEach(() => {
    sync.disable()
  })

  it('merges incoming remote state from session handler', () => {
    // Simulate receiving a memory-sync message from the peer
    session._triggerHandler('memory-sync', {
      payload: [
        { key: 'remote_fact', value: 'hello', category: 'learned', timestamp: 5000, podId: 'pod-2', tombstone: false },
      ],
    })

    const state = sync.getState()
    assert.equal(state.size, 1)
    assert.equal(state.get('remote_fact').value, 'hello')
  })
})
