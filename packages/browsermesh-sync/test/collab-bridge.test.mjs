/**
 * Tests for clawser-peer-collab-bridge.js — CollabBridge + CollabManager
 * wiring between CollabSession, PeerSession, MeshSyncEngine, and SyncCoordinator.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/collab-bridge.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  CollabBridge,
  CollabManager,
  COLLAB_SERVICE_TYPE,
  CRDT_SYNC_SERVICE_TYPE,
} from '../src/collab-bridge.mjs'

import {
  COLLAB_UPDATE,
  COLLAB_SYNC,
  COLLAB_AWARENESS,
} from '../src/collab.mjs'

import { MeshSyncEngine, InMemorySyncStorage } from '../src/sync.mjs'
import { SyncCoordinator } from '../src/delta-sync.mjs'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockPeerSession(remotePodId = 'peer-1') {
  const handlers = new Map()
  const sent = []
  return {
    remotePodId,
    sent,
    handlers,
    send(type, payload) {
      sent.push({ type, payload })
    },
    registerHandler(type, cb) {
      handlers.set(type, cb)
    },
    removeHandler(type) {
      handlers.delete(type)
    },
    // Simulate incoming message dispatch
    _dispatch(type, payload) {
      const handler = handlers.get(type)
      if (handler) handler({ type, payload, sessionId: 'sess1', from: remotePodId, timestamp: Date.now() })
    },
  }
}

function mockSessionManager(sessions = new Map()) {
  return {
    getSessionsForPeer(peerId) {
      const s = sessions.get(peerId)
      return s ? [s] : []
    },
    createSession() { return null },
    endSession() {},
    listSessions() { return [...sessions.values()] },
    get size() { return sessions.size },
  }
}

function mockPeerNode() {
  const listeners = new Map()
  return {
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(cb)
    },
    off(event, cb) {
      const set = listeners.get(event)
      if (set) set.delete(cb)
    },
    _emit(event, data) {
      const set = listeners.get(event)
      if (!set) return
      for (const cb of set) cb(data)
    },
    _listeners: listeners,
  }
}

// ---------------------------------------------------------------------------
// CollabBridge
// ---------------------------------------------------------------------------

describe('CollabBridge', () => {
  let peerSession, bridge

  beforeEach(() => {
    peerSession = mockPeerSession('peer-1')
    bridge = new CollabBridge({ peerSession })
  })

  it('requires peerSession', () => {
    assert.throws(() => new CollabBridge({}), /peerSession is required/)
  })

  it('registers collab and crdt-sync handlers on PeerSession', () => {
    assert.ok(peerSession.handlers.has(COLLAB_SERVICE_TYPE))
    assert.ok(peerSession.handlers.has(CRDT_SYNC_SERVICE_TYPE))
  })

  it('exposes remotePodId', () => {
    assert.equal(bridge.remotePodId, 'peer-1')
  })

  it('starts with zero sessions', () => {
    assert.equal(bridge.sessionCount, 0)
    assert.equal(bridge.destroyed, false)
  })

  // -- Document management --------------------------------------------------

  it('openDocument creates and starts a CollabSession', () => {
    const collab = bridge.openDocument('doc1')
    assert.ok(collab)
    assert.equal(collab.active, true)
    assert.equal(collab.docId, 'doc1')
    assert.equal(bridge.sessionCount, 1)
  })

  it('openDocument returns existing session for same docId', () => {
    const c1 = bridge.openDocument('doc1')
    const c2 = bridge.openDocument('doc1')
    assert.equal(c1, c2)
    assert.equal(bridge.sessionCount, 1)
  })

  it('openDocument sends initial sync', () => {
    bridge.openDocument('doc1')
    // Should have sent a COLLAB_SYNC message via the PeerSession
    const syncMsg = peerSession.sent.find(s => s.type === COLLAB_SERVICE_TYPE && s.payload?.type === COLLAB_SYNC)
    assert.ok(syncMsg, 'Expected a COLLAB_SYNC message')
  })

  it('closeDocument closes and removes the session', () => {
    const collab = bridge.openDocument('doc1')
    bridge.closeDocument('doc1')
    assert.equal(collab.active, false)
    assert.equal(bridge.sessionCount, 0)
    assert.equal(bridge.getDocument('doc1'), null)
  })

  it('listDocuments returns open doc IDs', () => {
    bridge.openDocument('doc1')
    bridge.openDocument('doc2')
    assert.deepEqual(bridge.listDocuments().sort(), ['doc1', 'doc2'])
  })

  // -- Message routing: collab updates via PeerSession ----------------------

  it('routes incoming COLLAB_UPDATE to CollabSession', () => {
    const collab = bridge.openDocument('doc1')
    // Simulate incoming collab message from peer
    peerSession._dispatch(COLLAB_SERVICE_TYPE, {
      type: COLLAB_UPDATE,
      docId: 'doc1',
      update: [1, 2, 3],
    })
    assert.equal(collab.adapter.doc._updates.length, 1)
  })

  it('routes incoming COLLAB_AWARENESS to CollabSession', () => {
    const collab = bridge.openDocument('doc1')
    peerSession._dispatch(COLLAB_SERVICE_TYPE, {
      type: COLLAB_AWARENESS,
      docId: 'doc1',
      peerId: 'peer-1',
      state: { cursor: 42 },
    })
    assert.ok(collab.awareness.getStates().has('peer-1'))
    assert.equal(collab.awareness.getStates().get('peer-1').cursor, 42)
  })

  it('routes outgoing messages through PeerSession', () => {
    const collab = bridge.openDocument('doc1')
    collab.broadcastAwareness({ cursor: 10 })
    // Should have sent via COLLAB_SERVICE_TYPE
    const awarenessMsg = peerSession.sent.find(s =>
      s.type === COLLAB_SERVICE_TYPE && s.payload?.type === COLLAB_AWARENESS
    )
    assert.ok(awarenessMsg, 'Expected COLLAB_AWARENESS sent via PeerSession')
  })

  // -- CRDT Sync Engine bridge ----------------------------------------------

  it('pushSyncDocument sends sync payload via PeerSession', () => {
    const syncEngine = new MeshSyncEngine({ storage: new InMemorySyncStorage() })
    syncEngine.create('settings', 'lww-map')
    syncEngine.update('settings', (crdt) => crdt.set('theme', 'dark', Date.now(), 'node1'))

    const bridgeWithSync = new CollabBridge({
      peerSession: mockPeerSession('peer-2'),
      syncEngine,
    })

    bridgeWithSync.pushSyncDocument('settings')
    const msg = bridgeWithSync.destroyed ? null : peerSession // check sent on the peer session used
    // The bridge should have sent via CRDT_SYNC_SERVICE_TYPE
    // We need to check the actual peerSession used
    const ps = mockPeerSession('peer-2')
    const b2 = new CollabBridge({ peerSession: ps, syncEngine })
    b2.pushSyncDocument('settings')
    const syncMsg = ps.sent.find(s => s.type === CRDT_SYNC_SERVICE_TYPE)
    assert.ok(syncMsg, 'Expected crdt-sync message sent')
    assert.equal(syncMsg.payload.action, 'sync')
    assert.equal(syncMsg.payload.docId, 'settings')
    assert.ok(syncMsg.payload.crdt)
    assert.ok(syncMsg.payload.version)
  })

  it('handles incoming crdt-sync merge', () => {
    const syncEngine = new MeshSyncEngine({
      nodeId: 'local',
      storage: new InMemorySyncStorage(),
    })
    syncEngine.create('config', 'lww-map')

    const ps = mockPeerSession('peer-2')
    const b = new CollabBridge({ peerSession: ps, syncEngine })

    // Build a remote payload
    const remoteSyncEngine = new MeshSyncEngine({
      nodeId: 'remote',
      storage: new InMemorySyncStorage(),
    })
    remoteSyncEngine.create('config', 'lww-map')
    remoteSyncEngine.update('config', (crdt) => crdt.set('color', 'blue', Date.now(), 'remote'))
    const remotePayload = remoteSyncEngine.prepareSyncPayload('config')

    // Simulate incoming crdt-sync
    ps._dispatch(CRDT_SYNC_SERVICE_TYPE, {
      action: 'sync',
      docId: 'config',
      crdt: remotePayload.crdt,
      version: remotePayload.version,
    })

    // Local doc should now have the merged state
    const state = syncEngine.getState('config')
    assert.ok(state, 'State should exist after merge')
  })

  it('ignores crdt-sync for unknown documents', () => {
    const syncEngine = new MeshSyncEngine({ storage: new InMemorySyncStorage() })
    const ps = mockPeerSession('peer-2')
    const b = new CollabBridge({ peerSession: ps, syncEngine })

    // Should not throw for unknown doc
    ps._dispatch(CRDT_SYNC_SERVICE_TYPE, {
      action: 'sync',
      docId: 'nonexistent',
      crdt: {},
      version: {},
    })
    // No assertions needed — just verifying it doesn't throw
  })

  // -- Lifecycle ------------------------------------------------------------

  it('destroy closes all sessions and removes handlers', () => {
    bridge.openDocument('doc1')
    bridge.openDocument('doc2')
    bridge.destroy()

    assert.equal(bridge.destroyed, true)
    assert.equal(bridge.sessionCount, 0)
    assert.ok(!peerSession.handlers.has(COLLAB_SERVICE_TYPE))
    assert.ok(!peerSession.handlers.has(CRDT_SYNC_SERVICE_TYPE))
  })

  it('openDocument throws after destroy', () => {
    bridge.destroy()
    assert.throws(() => bridge.openDocument('doc1'), /destroyed/)
  })

  it('toJSON serializes bridge state', () => {
    bridge.openDocument('doc1')
    const json = bridge.toJSON()
    assert.equal(json.remotePodId, 'peer-1')
    assert.deepEqual(json.documents, ['doc1'])
  })
})

// ---------------------------------------------------------------------------
// CollabManager
// ---------------------------------------------------------------------------

describe('CollabManager', () => {
  let manager, syncEngine

  beforeEach(() => {
    syncEngine = new MeshSyncEngine({
      nodeId: 'local-pod',
      storage: new InMemorySyncStorage(),
    })
    manager = new CollabManager({
      localPodId: 'local-pod',
      syncEngine,
    })
  })

  it('requires localPodId', () => {
    assert.throws(() => new CollabManager({}), /localPodId is required/)
  })

  it('starts with zero bridges', () => {
    assert.equal(manager.bridgeCount, 0)
    assert.equal(manager.localPodId, 'local-pod')
  })

  // -- PeerNode attachment --------------------------------------------------

  it('attach / detach hooks into PeerNode events', () => {
    const peerNode = mockPeerNode()
    manager.attach(peerNode)
    assert.ok(peerNode._listeners.has('peer:connect'))
    assert.ok(peerNode._listeners.has('peer:disconnect'))

    manager.detach()
    assert.equal(peerNode._listeners.get('peer:connect').size, 0)
    assert.equal(peerNode._listeners.get('peer:disconnect').size, 0)
  })

  it('auto-creates bridge on peer:connect when SessionManager provides a session', () => {
    const ps = mockPeerSession('peer-1')
    const sessionMgr = mockSessionManager(new Map([['peer-1', ps]]))
    const mgr = new CollabManager({
      localPodId: 'local-pod',
      syncEngine,
      sessionManager: sessionMgr,
    })
    const peerNode = mockPeerNode()
    mgr.attach(peerNode)

    peerNode._emit('peer:connect', { podId: 'peer-1' })
    assert.equal(mgr.bridgeCount, 1)
    assert.ok(mgr.getBridge('peer-1'))
  })

  it('auto-destroys bridge on peer:disconnect', () => {
    const ps = mockPeerSession('peer-1')
    const sessionMgr = mockSessionManager(new Map([['peer-1', ps]]))
    const mgr = new CollabManager({
      localPodId: 'local-pod',
      syncEngine,
      sessionManager: sessionMgr,
    })
    const peerNode = mockPeerNode()
    mgr.attach(peerNode)

    peerNode._emit('peer:connect', { podId: 'peer-1' })
    assert.equal(mgr.bridgeCount, 1)

    peerNode._emit('peer:disconnect', { podId: 'peer-1' })
    assert.equal(mgr.bridgeCount, 0)
  })

  it('skips bridge creation when no PeerSession found', () => {
    const sessionMgr = mockSessionManager(new Map()) // no sessions
    const mgr = new CollabManager({
      localPodId: 'local-pod',
      sessionManager: sessionMgr,
    })
    const peerNode = mockPeerNode()
    mgr.attach(peerNode)

    peerNode._emit('peer:connect', { podId: 'peer-1' })
    assert.equal(mgr.bridgeCount, 0) // no bridge created
  })

  // -- Document sharing -----------------------------------------------------

  it('shareDocument opens doc on all existing bridges', () => {
    const ps = mockPeerSession('peer-1')
    const sessionMgr = mockSessionManager(new Map([['peer-1', ps]]))
    const mgr = new CollabManager({
      localPodId: 'local-pod',
      sessionManager: sessionMgr,
    })
    const peerNode = mockPeerNode()
    mgr.attach(peerNode)

    peerNode._emit('peer:connect', { podId: 'peer-1' })

    const sessions = mgr.shareDocument('shared-doc')
    assert.equal(sessions.size, 1)
    assert.ok(sessions.has('peer-1'))

    const bridge = mgr.getBridge('peer-1')
    assert.deepEqual(bridge.listDocuments(), ['shared-doc'])
  })

  it('shared documents auto-open on new peer connections', () => {
    const ps1 = mockPeerSession('peer-1')
    const ps2 = mockPeerSession('peer-2')
    const sessMap = new Map([['peer-1', ps1], ['peer-2', ps2]])
    const sessionMgr = mockSessionManager(sessMap)
    const mgr = new CollabManager({
      localPodId: 'local-pod',
      sessionManager: sessionMgr,
    })
    const peerNode = mockPeerNode()
    mgr.attach(peerNode)

    // Share document before peer-2 connects
    peerNode._emit('peer:connect', { podId: 'peer-1' })
    mgr.shareDocument('shared-doc')

    // Now peer-2 connects — should auto-open shared-doc
    peerNode._emit('peer:connect', { podId: 'peer-2' })
    const bridge2 = mgr.getBridge('peer-2')
    assert.deepEqual(bridge2.listDocuments(), ['shared-doc'])
  })

  it('unshareDocument closes doc on all bridges', () => {
    const ps = mockPeerSession('peer-1')
    const sessionMgr = mockSessionManager(new Map([['peer-1', ps]]))
    const mgr = new CollabManager({
      localPodId: 'local-pod',
      sessionManager: sessionMgr,
    })
    const peerNode = mockPeerNode()
    mgr.attach(peerNode)

    peerNode._emit('peer:connect', { podId: 'peer-1' })
    mgr.shareDocument('shared-doc')
    mgr.unshareDocument('shared-doc')

    const bridge = mgr.getBridge('peer-1')
    assert.deepEqual(bridge.listDocuments(), [])
    assert.deepEqual(mgr.listSharedDocuments(), [])
  })

  // -- Sync engine integration ----------------------------------------------

  it('pushes sync engine documents to new peers', () => {
    syncEngine.create('settings', 'lww-map')
    syncEngine.update('settings', (crdt) => crdt.set('theme', 'dark', Date.now(), 'local-pod'))

    const ps = mockPeerSession('peer-1')
    const sessionMgr = mockSessionManager(new Map([['peer-1', ps]]))
    const mgr = new CollabManager({
      localPodId: 'local-pod',
      syncEngine,
      sessionManager: sessionMgr,
    })
    const peerNode = mockPeerNode()
    mgr.attach(peerNode)

    peerNode._emit('peer:connect', { podId: 'peer-1' })

    // Should have sent crdt-sync for 'settings' document
    const syncMsgs = ps.sent.filter(s => s.type === CRDT_SYNC_SERVICE_TYPE)
    assert.ok(syncMsgs.length > 0, 'Expected at least one crdt-sync message')
    assert.equal(syncMsgs[0].payload.docId, 'settings')
  })

  it('subscribes to sync engine updates and broadcasts changes', () => {
    syncEngine.create('live-doc', 'lww-map')

    const ps = mockPeerSession('peer-1')
    const sessionMgr = mockSessionManager(new Map([['peer-1', ps]]))
    const mgr = new CollabManager({
      localPodId: 'local-pod',
      syncEngine,
      sessionManager: sessionMgr,
    })
    const peerNode = mockPeerNode()
    mgr.attach(peerNode)

    peerNode._emit('peer:connect', { podId: 'peer-1' })
    mgr.shareDocument('live-doc')

    // Clear sent messages from setup
    ps.sent.length = 0

    // Update the sync engine document
    syncEngine.update('live-doc', (crdt) => crdt.set('key', 'val', Date.now(), 'local-pod'))

    // Should have broadcast the update
    const syncMsgs = ps.sent.filter(s => s.type === CRDT_SYNC_SERVICE_TYPE)
    assert.ok(syncMsgs.length > 0, 'Expected broadcast of sync engine update')
  })

  // -- Lifecycle ------------------------------------------------------------

  it('destroy cleans up everything', () => {
    const ps = mockPeerSession('peer-1')
    const sessionMgr = mockSessionManager(new Map([['peer-1', ps]]))
    const mgr = new CollabManager({
      localPodId: 'local-pod',
      sessionManager: sessionMgr,
    })
    const peerNode = mockPeerNode()
    mgr.attach(peerNode)

    peerNode._emit('peer:connect', { podId: 'peer-1' })
    mgr.shareDocument('doc1')

    mgr.destroy()
    assert.equal(mgr.bridgeCount, 0)
    assert.deepEqual(mgr.listSharedDocuments(), [])
    // Should have detached from PeerNode
    assert.equal(peerNode._listeners.get('peer:connect').size, 0)
  })

  it('toJSON serializes manager state', () => {
    const ps = mockPeerSession('peer-1')
    const sessionMgr = mockSessionManager(new Map([['peer-1', ps]]))
    const mgr = new CollabManager({
      localPodId: 'local-pod',
      sessionManager: sessionMgr,
    })
    const peerNode = mockPeerNode()
    mgr.attach(peerNode)

    peerNode._emit('peer:connect', { podId: 'peer-1' })
    mgr.shareDocument('doc-A')

    const json = mgr.toJSON()
    assert.equal(json.localPodId, 'local-pod')
    assert.equal(json.bridges.length, 1)
    assert.deepEqual(json.sharedDocuments, ['doc-A'])
  })
})

// ---------------------------------------------------------------------------
// SyncCoordinator.setSendFn
// ---------------------------------------------------------------------------

describe('SyncCoordinator.setSendFn', () => {
  it('allows setting sendFn after construction', () => {
    const coordinator = new SyncCoordinator({ localPodId: 'pod-1' })
    const sent = []
    coordinator.setSendFn((targetId, msg) => sent.push({ targetId, msg }))

    coordinator.set('key1', 'value1')
    coordinator.requestSync('pod-2')

    assert.ok(sent.length > 0, 'Expected sendFn to be called')
    assert.equal(sent[0].targetId, 'pod-2')
  })

  it('setSendFn(null) disables sending', () => {
    const coordinator = new SyncCoordinator({ localPodId: 'pod-1' })
    const sent = []
    coordinator.setSendFn((targetId, msg) => sent.push({ targetId, msg }))
    coordinator.setSendFn(null)

    coordinator.requestSync('pod-2')
    assert.equal(sent.length, 0) // sendFn was cleared
  })
})
