/**
 * Tests for PeerSession and SessionManager — authenticated peer session management.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/peer-session.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// Provide crypto.randomUUID if not available
if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

import {
  PeerSession,
  SessionManager,
  SESSION_MSG_TYPES,
  createEnvelope,
  parseEnvelope,
  createErrorEnvelope,
} from '../src/peer-session.mjs'

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

function createMockTransport() {
  const handlers = {}
  const sent = []
  return {
    send(data) { sent.push(typeof data === 'string' ? JSON.parse(data) : data) },
    on(event, cb) { (handlers[event] ??= []).push(cb) },
    onMessage(cb) { (handlers.message ??= []).push(cb) },
    onClose(cb) { (handlers.close ??= []).push(cb) },
    onError(cb) { (handlers.error ??= []).push(cb) },
    close() { for (const cb of handlers.close || []) cb() },
    _receive(data) { for (const cb of handlers.message || []) cb(data) },
    sent,
    get type() { return 'mock' },
    get connected() { return true },
  }
}

// ---------------------------------------------------------------------------
// Tests — SESSION_MSG_TYPES
// ---------------------------------------------------------------------------

describe('SESSION_MSG_TYPES', () => {
  it('has correct values', () => {
    assert.equal(SESSION_MSG_TYPES.CHAT, 'chat')
    assert.equal(SESSION_MSG_TYPES.TERMINAL, 'terminal')
    assert.equal(SESSION_MSG_TYPES.FILES, 'files')
    assert.equal(SESSION_MSG_TYPES.AGENT, 'agent')
    assert.equal(SESSION_MSG_TYPES.PING, 'ping')
    assert.equal(SESSION_MSG_TYPES.PONG, 'pong')
    assert.equal(SESSION_MSG_TYPES.ERROR, 'error')
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(SESSION_MSG_TYPES))
  })
})

// ---------------------------------------------------------------------------
// Tests — createEnvelope
// ---------------------------------------------------------------------------

describe('createEnvelope', () => {
  it('creates valid envelope with all required fields', () => {
    const env = createEnvelope('chat', { text: 'hi' }, 'sess-1', 'pod-local')
    assert.equal(env.type, 'chat')
    assert.deepEqual(env.payload, { text: 'hi' })
    assert.equal(env.sessionId, 'sess-1')
    assert.equal(env.from, 'pod-local')
    assert.equal(typeof env.timestamp, 'number')
    assert.ok(env.timestamp > 0)
  })
})

// ---------------------------------------------------------------------------
// Tests — parseEnvelope
// ---------------------------------------------------------------------------

describe('parseEnvelope', () => {
  it('parses a valid object', () => {
    const raw = { type: 'chat', payload: 'hello', sessionId: 's1', from: 'pod-a', timestamp: 1000 }
    const env = parseEnvelope(raw)
    assert.ok(env)
    assert.equal(env.type, 'chat')
    assert.equal(env.payload, 'hello')
    assert.equal(env.sessionId, 's1')
    assert.equal(env.from, 'pod-a')
    assert.equal(env.timestamp, 1000)
  })

  it('parses a valid JSON string', () => {
    const raw = JSON.stringify({ type: 'ping', payload: null, sessionId: 's2', from: 'pod-b', timestamp: 2000 })
    const env = parseEnvelope(raw)
    assert.ok(env)
    assert.equal(env.type, 'ping')
    assert.equal(env.sessionId, 's2')
  })

  it('returns null for invalid envelope (missing type)', () => {
    assert.equal(parseEnvelope({ payload: 1, sessionId: 's', from: 'p', timestamp: 1 }), null)
  })

  it('returns null for invalid JSON string', () => {
    assert.equal(parseEnvelope('not json'), null)
  })

  it('returns null for null input', () => {
    assert.equal(parseEnvelope(null), null)
  })

  it('returns null for a number', () => {
    assert.equal(parseEnvelope(42), null)
  })
})

// ---------------------------------------------------------------------------
// Tests — createErrorEnvelope
// ---------------------------------------------------------------------------

describe('createErrorEnvelope', () => {
  it('creates error envelope with code', () => {
    const env = createErrorEnvelope('sess-1', 'pod-local', 'something broke', 'BAD_REQUEST')
    assert.equal(env.type, SESSION_MSG_TYPES.ERROR)
    assert.equal(env.payload.error, 'something broke')
    assert.equal(env.payload.code, 'BAD_REQUEST')
    assert.equal(env.sessionId, 'sess-1')
    assert.equal(env.from, 'pod-local')
  })

  it('defaults code to UNKNOWN', () => {
    const env = createErrorEnvelope('sess-1', 'pod-local', 'oops')
    assert.equal(env.payload.code, 'UNKNOWN')
  })
})

// ---------------------------------------------------------------------------
// Tests — PeerSession
// ---------------------------------------------------------------------------

describe('PeerSession', () => {
  let transport

  beforeEach(() => {
    transport = createMockTransport()
  })

  afterEach(() => {
    // No timers to clean up in these tests since we don't start heartbeats
  })

  // -- Constructor validation -------------------------------------------------

  describe('constructor', () => {
    it('requires sessionId', () => {
      assert.throws(
        () => new PeerSession({ localIdentity: { podId: 'a' }, remoteIdentity: { podId: 'b' }, transport }),
        /sessionId is required/,
      )
    })

    it('requires localIdentity with podId', () => {
      assert.throws(
        () => new PeerSession({ sessionId: 's1', remoteIdentity: { podId: 'b' }, transport }),
        /localIdentity/,
      )
    })

    it('requires remoteIdentity with podId', () => {
      assert.throws(
        () => new PeerSession({ sessionId: 's1', localIdentity: { podId: 'a' }, transport }),
        /remoteIdentity/,
      )
    })

    it('requires transport with send()', () => {
      assert.throws(
        () => new PeerSession({ sessionId: 's1', localIdentity: { podId: 'a' }, remoteIdentity: { podId: 'b' }, transport: {} }),
        /transport/,
      )
    })
  })

  // -- Properties -------------------------------------------------------------

  describe('properties', () => {
    it('exposes sessionId, localPodId, remotePodId, capabilities, state, createdAt', () => {
      const session = new PeerSession({
        sessionId: 'sess-42',
        localIdentity: { podId: 'local-pod' },
        remoteIdentity: { podId: 'remote-pod' },
        capabilities: ['chat:*', 'files:read'],
        transport,
      })
      assert.equal(session.sessionId, 'sess-42')
      assert.equal(session.localPodId, 'local-pod')
      assert.equal(session.remotePodId, 'remote-pod')
      assert.deepEqual(session.capabilities, ['chat:*', 'files:read'])
      assert.equal(session.state, 'active')
      assert.equal(typeof session.createdAt, 'number')
    })

    it('capabilities returns a copy', () => {
      const session = new PeerSession({
        sessionId: 's1',
        localIdentity: { podId: 'a' },
        remoteIdentity: { podId: 'b' },
        capabilities: ['chat:*'],
        transport,
      })
      const caps = session.capabilities
      caps.push('extra')
      assert.equal(session.capabilities.length, 1)
    })
  })

  // -- hasCapability ----------------------------------------------------------

  describe('hasCapability', () => {
    it('returns true for a matching scope', () => {
      const session = new PeerSession({
        sessionId: 's1',
        localIdentity: { podId: 'a' },
        remoteIdentity: { podId: 'b' },
        capabilities: ['chat:write', 'files:read'],
        transport,
      })
      assert.equal(session.hasCapability('chat:write'), true)
      assert.equal(session.hasCapability('files:read'), true)
    })

    it('returns false for a missing scope', () => {
      const session = new PeerSession({
        sessionId: 's1',
        localIdentity: { podId: 'a' },
        remoteIdentity: { podId: 'b' },
        capabilities: ['chat:write'],
        transport,
      })
      assert.equal(session.hasCapability('files:read'), false)
    })

    it('supports wildcard capability', () => {
      const session = new PeerSession({
        sessionId: 's1',
        localIdentity: { podId: 'a' },
        remoteIdentity: { podId: 'b' },
        capabilities: ['*'],
        transport,
      })
      assert.equal(session.hasCapability('anything'), true)
    })
  })

  // -- requireCapability ------------------------------------------------------

  describe('requireCapability', () => {
    it('throws for missing capability', () => {
      const session = new PeerSession({
        sessionId: 's1',
        localIdentity: { podId: 'a' },
        remoteIdentity: { podId: 'b' },
        capabilities: [],
        transport,
      })
      assert.throws(() => session.requireCapability('files:write'), /not granted/)
    })

    it('does not throw for present capability', () => {
      const session = new PeerSession({
        sessionId: 's1',
        localIdentity: { podId: 'a' },
        remoteIdentity: { podId: 'b' },
        capabilities: ['files:write'],
        transport,
      })
      session.requireCapability('files:write') // should not throw
    })
  })

  // -- send -------------------------------------------------------------------

  describe('send', () => {
    it('sends envelope via transport and increments messagesSent', () => {
      const session = new PeerSession({
        sessionId: 'sess-1',
        localIdentity: { podId: 'local' },
        remoteIdentity: { podId: 'remote' },
        capabilities: [],
        transport,
      })
      session.send('chat', { text: 'hello' })

      assert.equal(transport.sent.length, 1)
      assert.equal(transport.sent[0].type, 'chat')
      assert.equal(transport.sent[0].sessionId, 'sess-1')
      assert.equal(transport.sent[0].from, 'local')
      assert.deepEqual(transport.sent[0].payload, { text: 'hello' })
      assert.equal(session.stats.messagesSent, 1)
    })

    it('throws when session is closed', () => {
      const session = new PeerSession({
        sessionId: 's1',
        localIdentity: { podId: 'a' },
        remoteIdentity: { podId: 'b' },
        capabilities: [],
        transport,
      })
      session.close()
      assert.throws(() => session.send('chat', {}), /closed/)
    })

    it('throws when session is suspended', () => {
      const session = new PeerSession({
        sessionId: 's1',
        localIdentity: { podId: 'a' },
        remoteIdentity: { podId: 'b' },
        capabilities: [],
        transport,
      })
      session.suspend()
      assert.throws(() => session.send('chat', {}), /suspended/)
    })
  })

  // -- registerHandler / removeHandler ----------------------------------------

  describe('registerHandler / removeHandler', () => {
    it('handler is called on matching message type', () => {
      const session = new PeerSession({
        sessionId: 'sess-1',
        localIdentity: { podId: 'local' },
        remoteIdentity: { podId: 'remote' },
        capabilities: [],
        transport,
      })
      const received = []
      session.registerHandler('chat', (envelope) => received.push(envelope))

      // Simulate incoming message via transport
      transport._receive({
        type: 'chat',
        payload: { text: 'hi' },
        sessionId: 'sess-1',
        from: 'remote',
        timestamp: Date.now(),
      })

      assert.equal(received.length, 1)
      assert.equal(received[0].payload.text, 'hi')
    })

    it('removeHandler stops delivery', () => {
      const session = new PeerSession({
        sessionId: 'sess-1',
        localIdentity: { podId: 'local' },
        remoteIdentity: { podId: 'remote' },
        capabilities: [],
        transport,
      })
      const received = []
      session.registerHandler('chat', (envelope) => received.push(envelope))
      session.removeHandler('chat')

      transport._receive({
        type: 'chat',
        payload: { text: 'hi' },
        sessionId: 'sess-1',
        from: 'remote',
        timestamp: Date.now(),
      })

      assert.equal(received.length, 0)
    })
  })

  // -- Lifecycle transitions --------------------------------------------------

  describe('lifecycle', () => {
    it('suspend transitions active -> suspended', () => {
      const session = new PeerSession({
        sessionId: 's1',
        localIdentity: { podId: 'a' },
        remoteIdentity: { podId: 'b' },
        capabilities: [],
        transport,
      })
      assert.equal(session.state, 'active')
      session.suspend()
      assert.equal(session.state, 'suspended')
    })

    it('resume transitions suspended -> active', () => {
      const session = new PeerSession({
        sessionId: 's1',
        localIdentity: { podId: 'a' },
        remoteIdentity: { podId: 'b' },
        capabilities: [],
        transport,
      })
      session.suspend()
      session.resume()
      assert.equal(session.state, 'active')
    })

    it('resume throws if not suspended', () => {
      const session = new PeerSession({
        sessionId: 's1',
        localIdentity: { podId: 'a' },
        remoteIdentity: { podId: 'b' },
        capabilities: [],
        transport,
      })
      assert.throws(() => session.resume(), /Cannot resume/)
    })

    it('close sets state to closed', () => {
      const session = new PeerSession({
        sessionId: 's1',
        localIdentity: { podId: 'a' },
        remoteIdentity: { podId: 'b' },
        capabilities: [],
        transport,
      })
      session.close()
      assert.equal(session.state, 'closed')
    })

    it('close is idempotent', () => {
      const session = new PeerSession({
        sessionId: 's1',
        localIdentity: { podId: 'a' },
        remoteIdentity: { podId: 'b' },
        capabilities: [],
        transport,
      })
      session.close()
      session.close() // should not throw
      assert.equal(session.state, 'closed')
    })

    it('suspend on closed session is a no-op', () => {
      const session = new PeerSession({
        sessionId: 's1',
        localIdentity: { podId: 'a' },
        remoteIdentity: { podId: 'b' },
        capabilities: [],
        transport,
      })
      session.close()
      session.suspend() // should not throw
      assert.equal(session.state, 'closed')
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — SessionManager
// ---------------------------------------------------------------------------

describe('SessionManager', () => {
  let mgr

  beforeEach(() => {
    mgr = new SessionManager({ localPodId: 'local-pod' })
  })

  afterEach(() => {
    mgr.closeAll()
  })

  // -- createSession ----------------------------------------------------------

  describe('createSession', () => {
    it('creates a session and tracks by ID', () => {
      const transport = createMockTransport()
      const session = mgr.createSession('remote-pod', transport, ['chat:*'])
      assert.ok(session.sessionId)
      assert.equal(session.localPodId, 'local-pod')
      assert.equal(session.remotePodId, 'remote-pod')
      assert.deepEqual(session.capabilities, ['chat:*'])
    })

    it('getSession retrieves the created session', () => {
      const transport = createMockTransport()
      const session = mgr.createSession('remote-pod', transport, [])
      const found = mgr.getSession(session.sessionId)
      assert.equal(found, session)
    })

    it('getSessionsForPeer returns sessions for a specific peer', () => {
      const t1 = createMockTransport()
      const t2 = createMockTransport()
      mgr.createSession('peer-a', t1, [])
      mgr.createSession('peer-a', t2, [])
      mgr.createSession('peer-b', createMockTransport(), [])
      const sessions = mgr.getSessionsForPeer('peer-a')
      assert.equal(sessions.length, 2)
    })
  })

  // -- endSession -------------------------------------------------------------

  describe('endSession', () => {
    it('removes the session', () => {
      const transport = createMockTransport()
      const session = mgr.createSession('remote-pod', transport, [])
      mgr.endSession(session.sessionId)
      assert.equal(mgr.getSession(session.sessionId), null)
    })

    it('endSession on unknown ID is a no-op', () => {
      mgr.endSession('no-such-id') // should not throw
    })
  })

  // -- getSession / listSessions ----------------------------------------------

  describe('getSession / listSessions', () => {
    it('getSession returns null for unknown ID', () => {
      assert.equal(mgr.getSession('unknown'), null)
    })

    it('listSessions returns all active sessions', () => {
      mgr.createSession('a', createMockTransport(), [])
      mgr.createSession('b', createMockTransport(), [])
      assert.equal(mgr.listSessions().length, 2)
    })

    it('size reflects session count', () => {
      assert.equal(mgr.size, 0)
      mgr.createSession('a', createMockTransport(), [])
      assert.equal(mgr.size, 1)
    })
  })

  // -- checkRateLimit ---------------------------------------------------------

  describe('checkRateLimit', () => {
    it('enforces rate limit', () => {
      const transport = createMockTransport()
      const customMgr = new SessionManager({
        localPodId: 'local',
        rateLimits: { maxMessagesPerMinute: 3 },
      })
      const session = customMgr.createSession('peer', transport, [])

      // Initially allowed with full remaining
      let rl = customMgr.checkRateLimit(session.sessionId)
      assert.equal(rl.allowed, true)
      assert.equal(rl.remaining, 3)

      // Record 3 messages
      customMgr.recordMessage(session.sessionId)
      customMgr.recordMessage(session.sessionId)
      customMgr.recordMessage(session.sessionId)

      rl = customMgr.checkRateLimit(session.sessionId)
      assert.equal(rl.allowed, false)
      assert.equal(rl.remaining, 0)

      customMgr.closeAll()
    })

    it('returns not allowed for unknown session', () => {
      const rl = mgr.checkRateLimit('unknown-session')
      assert.equal(rl.allowed, false)
      assert.equal(rl.remaining, 0)
    })
  })

  // -- pruneInactive ----------------------------------------------------------

  describe('pruneInactive', () => {
    it('closes sessions idle beyond threshold', () => {
      const transport = createMockTransport()
      const session = mgr.createSession('remote', transport, [])
      // prune with 0ms threshold -> everything is idle
      const pruned = mgr.pruneInactive(0)
      assert.equal(pruned, 1)
      assert.equal(mgr.getSession(session.sessionId), null)
    })

    it('keeps recently active sessions', () => {
      const transport = createMockTransport()
      mgr.createSession('remote', transport, [])
      const pruned = mgr.pruneInactive(60000)
      assert.equal(pruned, 0)
      assert.equal(mgr.size, 1)
    })
  })

  // -- closeAll ---------------------------------------------------------------

  describe('closeAll', () => {
    it('closes all sessions', () => {
      mgr.createSession('a', createMockTransport(), [])
      mgr.createSession('b', createMockTransport(), [])
      mgr.createSession('c', createMockTransport(), [])
      assert.equal(mgr.size, 3)
      mgr.closeAll()
      assert.equal(mgr.size, 0)
    })
  })

  // -- Events -----------------------------------------------------------------

  describe('events', () => {
    it('fires session:create on createSession', () => {
      const events = []
      mgr.on('session:create', (s) => events.push(s.sessionId))
      mgr.createSession('peer', createMockTransport(), [])
      assert.equal(events.length, 1)
    })

    it('fires session:end on endSession', () => {
      const events = []
      mgr.on('session:end', (s) => events.push(s.sessionId))
      const session = mgr.createSession('peer', createMockTransport(), [])
      mgr.endSession(session.sessionId)
      assert.equal(events.length, 1)
      assert.equal(events[0], session.sessionId)
    })

    it('off removes listener', () => {
      const events = []
      const cb = (s) => events.push(s)
      mgr.on('session:create', cb)
      mgr.off('session:create', cb)
      mgr.createSession('peer', createMockTransport(), [])
      assert.equal(events.length, 0)
    })
  })

  // -- Per-peer session limit -------------------------------------------------

  describe('per-peer session limit', () => {
    it('throws when max sessions per peer exceeded', () => {
      const limitedMgr = new SessionManager({
        localPodId: 'local',
        rateLimits: { maxSessionsPerPeer: 2 },
      })
      limitedMgr.createSession('peer', createMockTransport(), [])
      limitedMgr.createSession('peer', createMockTransport(), [])
      assert.throws(
        () => limitedMgr.createSession('peer', createMockTransport(), []),
        /Session limit reached/,
      )
      limitedMgr.closeAll()
    })
  })
})
