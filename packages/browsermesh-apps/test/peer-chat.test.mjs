/**
 * Tests for PeerChat — P2P chat over peer sessions.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/peer-chat.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Provide crypto.randomUUID if not available
if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

import { PeerChat } from '../src/peer-chat.mjs'

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
// Mock session
// ---------------------------------------------------------------------------

function createMockSession(localPodId = 'local', remotePodId = 'remote', capabilities = ['chat:*']) {
  const handlers = {}
  const transport = createMockTransport()
  return {
    send(type, payload) { transport.send({ type, payload, from: localPodId }) },
    registerHandler(type, handler) { handlers[type] = handler },
    removeHandler(type) { delete handlers[type] },
    hasCapability(scope) {
      return capabilities.some(c =>
        c === scope || c === '*' || (c.endsWith(':*') && scope.startsWith(c.slice(0, -1)))
      )
    },
    requireCapability(scope) {
      if (!this.hasCapability(scope)) throw new Error(`Missing capability: ${scope}`)
    },
    get localPodId() { return localPodId },
    get remotePodId() { return remotePodId },
    get sessionId() { return 'session-1' },
    _simulateIncoming(payload) { handlers.chat?.(payload) },
    _transport: transport,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PeerChat', () => {
  let session, chat

  beforeEach(() => {
    session = createMockSession()
    chat = new PeerChat({ session })
  })

  // -- Constructor ------------------------------------------------------------

  describe('constructor', () => {
    it('registers chat handler on session', () => {
      // The handler was registered in beforeEach — verify by simulating
      // an incoming message; if no handler was registered, nothing happens.
      const events = []
      chat.on('message:received', (msg) => events.push(msg))
      session._simulateIncoming({ payload: { id: 'm1', from: 'remote', to: 'local', text: 'hello', timestamp: 1000 } })
      assert.equal(events.length, 1)
    })

    it('throws when session is missing', () => {
      assert.throws(() => new PeerChat({}), /session is required/)
    })
  })

  // -- sendMessage ------------------------------------------------------------

  describe('sendMessage', () => {
    it('creates message with correct fields', async () => {
      const msg = await chat.sendMessage('hello world')
      assert.equal(msg.from, 'local')
      assert.equal(msg.to, 'remote')
      assert.equal(msg.text, 'hello world')
      assert.ok(msg.id)
      assert.equal(typeof msg.timestamp, 'number')
    })

    it('adds sent message to history', async () => {
      await chat.sendMessage('one')
      await chat.sendMessage('two')
      const history = chat.getHistory()
      assert.equal(history.length, 2)
      assert.equal(history[0].text, 'one')
      assert.equal(history[1].text, 'two')
    })

    it('sends over session transport', async () => {
      await chat.sendMessage('hi')
      const sent = session._transport.sent
      assert.equal(sent.length, 1)
      assert.equal(sent[0].type, 'chat')
      assert.equal(sent[0].payload.text, 'hi')
    })
  })

  // -- Incoming messages ------------------------------------------------------

  describe('incoming messages', () => {
    it('received message is added to history', () => {
      session._simulateIncoming({
        payload: { id: 'm1', from: 'remote', to: 'local', text: 'hey there', timestamp: Date.now() },
      })
      const history = chat.getHistory()
      assert.equal(history.length, 1)
      assert.equal(history[0].text, 'hey there')
      assert.equal(history[0].from, 'remote')
    })
  })

  // -- getHistory / clearHistory ----------------------------------------------

  describe('getHistory / clearHistory', () => {
    it('getHistory returns a copy', async () => {
      await chat.sendMessage('msg')
      const h1 = chat.getHistory()
      h1.push({ fake: true })
      assert.equal(chat.getHistory().length, 1)
    })

    it('clearHistory empties history', async () => {
      await chat.sendMessage('msg')
      chat.clearHistory()
      assert.equal(chat.getHistory().length, 0)
    })
  })

  // -- Events -----------------------------------------------------------------

  describe('events', () => {
    it('message:sent fires on sendMessage', async () => {
      const events = []
      chat.on('message:sent', (msg) => events.push(msg))
      await chat.sendMessage('hello')
      assert.equal(events.length, 1)
      assert.equal(events[0].text, 'hello')
    })

    it('message:received fires on incoming message', () => {
      const events = []
      chat.on('message:received', (msg) => events.push(msg))
      session._simulateIncoming({
        payload: { id: 'm1', from: 'remote', to: 'local', text: 'yo', timestamp: Date.now() },
      })
      assert.equal(events.length, 1)
      assert.equal(events[0].text, 'yo')
    })

    it('off removes listener', async () => {
      const events = []
      const cb = (msg) => events.push(msg)
      chat.on('message:sent', cb)
      chat.off('message:sent', cb)
      await chat.sendMessage('hello')
      assert.equal(events.length, 0)
    })
  })

  // -- Auto-responder ---------------------------------------------------------

  describe('auto-responder', () => {
    it('sends reply on incoming message', async () => {
      const autoSession = createMockSession()
      const autoChat = new PeerChat({
        session: autoSession,
        autoResponder: async (msg) => `Reply to: ${msg.text}`,
      })

      // Simulate an incoming message
      autoSession._simulateIncoming({
        payload: { id: 'm1', from: 'remote', to: 'local', text: 'question?', timestamp: Date.now() },
      })

      // Wait for async auto-responder to complete
      await new Promise((r) => setTimeout(r, 10))

      const sent = autoSession._transport.sent
      assert.ok(sent.length >= 1)
      // The auto-reply payload text should reference the incoming text
      const replyPayload = sent.find(s => s.payload && s.payload.text && s.payload.text.includes('Reply to:'))
      assert.ok(replyPayload, 'Expected an auto-reply to be sent')
    })

    it('does not send reply when autoResponder returns null', async () => {
      const autoSession = createMockSession()
      new PeerChat({
        session: autoSession,
        autoResponder: async () => null,
      })

      autoSession._simulateIncoming({
        payload: { id: 'm1', from: 'remote', to: 'local', text: 'ignored', timestamp: Date.now() },
      })

      await new Promise((r) => setTimeout(r, 10))

      // Only the received message was processed, no reply sent
      assert.equal(autoSession._transport.sent.length, 0)
    })
  })

  // -- sendTyping -------------------------------------------------------------

  describe('sendTyping', () => {
    it('sends typing indicator', () => {
      chat.sendTyping()
      const sent = session._transport.sent
      assert.equal(sent.length, 1)
      assert.equal(sent[0].type, 'chat')
      assert.equal(sent[0].payload.type, 'typing')
      assert.equal(sent[0].payload.from, 'local')
    })
  })

  // -- close ------------------------------------------------------------------

  describe('close', () => {
    it('removes handler from session', () => {
      chat.close()
      // After close, incoming messages should not be processed
      const events = []
      chat.on('message:received', (msg) => events.push(msg))
      session._simulateIncoming({
        payload: { id: 'm2', from: 'remote', to: 'local', text: 'after close', timestamp: Date.now() },
      })
      assert.equal(events.length, 0)
    })
  })

  // -- History cap ------------------------------------------------------------

  describe('history cap', () => {
    it('enforces maxHistory limit', async () => {
      const limitedChat = new PeerChat({ session: createMockSession(), maxHistory: 5 })
      for (let i = 0; i < 10; i++) {
        await limitedChat.sendMessage(`msg-${i}`)
      }
      const history = limitedChat.getHistory()
      assert.equal(history.length, 5)
      assert.equal(history[0].text, 'msg-5')
      assert.equal(history[4].text, 'msg-9')
    })
  })
})
