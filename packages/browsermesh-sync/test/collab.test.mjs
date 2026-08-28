/**
 * Tests for clawser-peer-collab.js -- Real-time collaborative editing
 * via Yjs CRDT adapter, awareness state, and collab sessions.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/collab.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  COLLAB_UPDATE,
  COLLAB_AWARENESS,
  COLLAB_SYNC,
  YjsAdapter,
  AwarenessState,
  CollabSession,
} from '../src/collab.mjs'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockSession() {
  const sent = []
  const handlers = []
  return {
    sent,
    send(msg) { sent.push(msg) },
    onMessage(cb) { handlers.push(cb) },
    _fire(msg) { for (const h of handlers) h(msg) },
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('Collab Wire Constants', () => {
  it('has expected constant values', () => {
    assert.equal(COLLAB_UPDATE, 0xF0)
    assert.equal(COLLAB_AWARENESS, 0xF1)
    assert.equal(COLLAB_SYNC, 0xF2)
  })
})

// ---------------------------------------------------------------------------
// YjsAdapter (stub mode)
// ---------------------------------------------------------------------------

describe('YjsAdapter', () => {
  it('requires docId', () => {
    assert.throws(() => new YjsAdapter(''), /docId is required/)
    assert.throws(() => new YjsAdapter(), /docId is required/)
  })

  it('creates stub doc without Y module', () => {
    const adapter = new YjsAdapter('doc1')
    assert.ok(adapter.doc)
    assert.equal(adapter.docId, 'doc1')
    assert.equal(adapter.destroyed, false)
  })

  it('getText creates and returns stub text', () => {
    const adapter = new YjsAdapter('doc1')
    const text = adapter.getText('main')
    assert.ok(text)
    text.insert(0, 'hello')
    assert.equal(text.toString(), 'hello')
    assert.equal(text.length, 5)
  })

  it('getText returns same instance on repeated calls', () => {
    const adapter = new YjsAdapter('doc1')
    const t1 = adapter.getText('main')
    const t2 = adapter.getText('main')
    assert.equal(t1, t2)
  })

  it('stub text supports insert, delete, and toString', () => {
    const adapter = new YjsAdapter('doc1')
    const text = adapter.getText('content')
    text.insert(0, 'abcde')
    text.delete(1, 2) // remove 'bc'
    assert.equal(text.toString(), 'ade')
    assert.equal(text.length, 3)
  })

  it('getMap creates and returns stub map', () => {
    const adapter = new YjsAdapter('doc1')
    const map = adapter.getMap('meta')
    map.set('key1', 'value1')
    assert.equal(map.get('key1'), 'value1')
    assert.ok(map.has('key1'))
    assert.equal(map.size, 1)
  })

  it('stub map supports set, get, has, delete, toJSON, size', () => {
    const adapter = new YjsAdapter('doc1')
    const map = adapter.getMap('data')
    map.set('a', 1)
    map.set('b', 2)
    assert.equal(map.size, 2)
    map.delete('a')
    assert.equal(map.has('a'), false)
    assert.equal(map.size, 1)
    assert.deepEqual(map.toJSON(), { b: 2 })
  })

  it('applyUpdate stores update in stub mode', () => {
    const adapter = new YjsAdapter('doc1')
    adapter.applyUpdate(new Uint8Array([1, 2, 3]))
    assert.equal(adapter.doc._updates.length, 1)
  })

  it('applyUpdate throws when destroyed', () => {
    const adapter = new YjsAdapter('doc1')
    adapter.destroy()
    assert.throws(() => adapter.applyUpdate(new Uint8Array([1])), /destroyed/)
  })

  it('encodeState returns Uint8Array', () => {
    const adapter = new YjsAdapter('doc1')
    const state = adapter.encodeState()
    assert.ok(state instanceof Uint8Array)
  })

  it('onUpdate registers callback', () => {
    const adapter = new YjsAdapter('doc1')
    let called = false
    adapter.onUpdate(() => { called = true })
    // In stub mode, callbacks are registered but not auto-fired
    assert.equal(called, false)
  })

  it('destroy marks adapter as destroyed and is idempotent', () => {
    const adapter = new YjsAdapter('doc1')
    adapter.destroy()
    assert.equal(adapter.destroyed, true)
    // Double destroy is safe
    adapter.destroy()
    assert.equal(adapter.destroyed, true)
  })
})

// ---------------------------------------------------------------------------
// AwarenessState
// ---------------------------------------------------------------------------

describe('AwarenessState', () => {
  let awareness

  beforeEach(() => {
    awareness = new AwarenessState()
  })

  it('getLocal returns null initially', () => {
    assert.equal(awareness.getLocal(), null)
  })

  it('setLocal / getLocal round-trips', () => {
    awareness.setLocal({ cursor: 5, user: 'alice' })
    const local = awareness.getLocal()
    assert.equal(local.cursor, 5)
    assert.equal(local.user, 'alice')
    assert.ok(local.updatedAt)
  })

  it('getLocal returns a copy, not original reference', () => {
    awareness.setLocal({ cursor: 5 })
    const a = awareness.getLocal()
    const b = awareness.getLocal()
    assert.notEqual(a, b)
    assert.deepEqual(a.cursor, b.cursor)
  })

  it('setRemote / getStates tracks remote peers', () => {
    awareness.setRemote('peer1', { cursor: 10 })
    const states = awareness.getStates()
    assert.ok(states.has('peer1'))
    assert.equal(states.get('peer1').cursor, 10)
  })

  it('removeRemote removes peer state', () => {
    awareness.setRemote('peer1', { cursor: 10 })
    awareness.removeRemote('peer1')
    const states = awareness.getStates()
    assert.ok(!states.has('peer1'))
  })

  it('getStates includes local state under "local" key', () => {
    awareness.setLocal({ cursor: 0 })
    awareness.setRemote('peer1', { cursor: 1 })
    const states = awareness.getStates()
    assert.ok(states.has('local'))
    assert.ok(states.has('peer1'))
    assert.equal(states.size, 2)
  })

  it('onUpdate fires when remote state changes', () => {
    let fired = null
    awareness.onUpdate((peerId, state) => { fired = { peerId, state } })
    awareness.setRemote('peer1', { cursor: 3 })
    assert.ok(fired)
    assert.equal(fired.peerId, 'peer1')
    assert.equal(fired.state.cursor, 3)
  })

  it('clear removes all remote states', () => {
    awareness.setRemote('p1', { x: 1 })
    awareness.setRemote('p2', { x: 2 })
    awareness.clear()
    // Only local (if set) should remain
    assert.equal(awareness.getStates().size, 0)
  })
})

// ---------------------------------------------------------------------------
// CollabSession
// ---------------------------------------------------------------------------

describe('CollabSession', () => {
  it('requires session and docId', () => {
    assert.throws(() => new CollabSession({}), /session is required/)
    assert.throws(() => new CollabSession({ session: {} }), /docId is required/)
    assert.throws(() => new CollabSession({ session: {}, docId: '' }), /docId is required/)
  })

  it('exposes adapter, awareness, docId, and active getters', () => {
    const session = mockSession()
    const collab = new CollabSession({ session, docId: 'doc1' })
    assert.ok(collab.adapter instanceof YjsAdapter)
    assert.ok(collab.awareness instanceof AwarenessState)
    assert.equal(collab.docId, 'doc1')
    assert.equal(collab.active, false)
  })

  it('start activates session', () => {
    const session = mockSession()
    const collab = new CollabSession({ session, docId: 'doc1' })
    collab.start()
    assert.equal(collab.active, true)
  })

  it('start is idempotent', () => {
    const session = mockSession()
    const collab = new CollabSession({ session, docId: 'doc1' })
    collab.start()
    collab.start() // second call is a no-op
    assert.equal(collab.active, true)
  })

  it('syncWithPeer sends full state', () => {
    const session = mockSession()
    const collab = new CollabSession({ session, docId: 'doc1' })
    collab.start()
    collab.syncWithPeer()
    assert.equal(session.sent.length, 1)
    assert.equal(session.sent[0].type, COLLAB_SYNC)
    assert.equal(session.sent[0].docId, 'doc1')
    assert.ok(Array.isArray(session.sent[0].state))
  })

  it('broadcastAwareness sends and sets local state', () => {
    const session = mockSession()
    const collab = new CollabSession({ session, docId: 'doc1' })
    collab.start()
    collab.broadcastAwareness({ cursor: 7 })
    assert.equal(session.sent.length, 1)
    assert.equal(session.sent[0].type, COLLAB_AWARENESS)
    assert.equal(session.sent[0].state.cursor, 7)
    assert.equal(collab.awareness.getLocal().cursor, 7)
  })

  it('handles incoming COLLAB_UPDATE', () => {
    const session = mockSession()
    const collab = new CollabSession({ session, docId: 'doc1' })
    collab.start()
    session._fire({ type: COLLAB_UPDATE, docId: 'doc1', update: [1, 2, 3] })
    assert.equal(collab.adapter.doc._updates.length, 1)
  })

  it('handles incoming COLLAB_AWARENESS', () => {
    const session = mockSession()
    const collab = new CollabSession({ session, docId: 'doc1' })
    collab.start()
    session._fire({ type: COLLAB_AWARENESS, docId: 'doc1', peerId: 'p1', state: { cursor: 4 } })
    assert.ok(collab.awareness.getStates().has('p1'))
    assert.equal(collab.awareness.getStates().get('p1').cursor, 4)
  })

  it('handles incoming COLLAB_SYNC with state', () => {
    const session = mockSession()
    const collab = new CollabSession({ session, docId: 'doc1' })
    collab.start()
    session._fire({ type: COLLAB_SYNC, docId: 'doc1', state: [10, 20] })
    assert.equal(collab.adapter.doc._updates.length, 1)
  })

  it('ignores messages for different docId', () => {
    const session = mockSession()
    const collab = new CollabSession({ session, docId: 'doc1' })
    collab.start()
    session._fire({ type: COLLAB_UPDATE, docId: 'other', update: [1] })
    assert.equal(collab.adapter.doc._updates.length, 0)
  })

  it('ignores null messages', () => {
    const session = mockSession()
    const collab = new CollabSession({ session, docId: 'doc1' })
    collab.start()
    session._fire(null)
    assert.equal(collab.adapter.doc._updates.length, 0)
  })

  it('close deactivates and destroys', () => {
    const session = mockSession()
    const collab = new CollabSession({ session, docId: 'doc1' })
    collab.start()
    collab.close()
    assert.equal(collab.active, false)
    assert.equal(collab.adapter.destroyed, true)
  })
})
