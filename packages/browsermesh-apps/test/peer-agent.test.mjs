/**
 * Tests for AgentHost and AgentClient — remote agent interaction over peer sessions.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/peer-agent.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Provide crypto.randomUUID if not available
if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

import {
  AgentHost,
  AgentClient,
  AGENT_DEFAULTS,
  AGENT_ACTIONS,
  AGENT_CAPABILITIES,
} from '../src/peer-agent.mjs'

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

function createMockSession(localPodId = 'local', remotePodId = 'remote', capabilities = ['agent:chat', 'agent:tools', 'agent:memory']) {
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
    get sessionId() { return 'session-a1' },
    _simulateIncoming(payload) { handlers.agent?.(payload) },
    _transport: transport,
  }
}

// ---------------------------------------------------------------------------
// Mock agent
// ---------------------------------------------------------------------------

function createMockAgent() {
  return {
    async run(message) {
      return { response: `Echo: ${message}`, usage: { input_tokens: 10, output_tokens: 5 } }
    },
    async executeTool(name, args) {
      return { success: true, output: `Ran ${name}` }
    },
    searchMemories(query) {
      return [{ id: 'm1', key: query, content: 'result', category: 'learned', timestamp: Date.now() }]
    },
  }
}

// ---------------------------------------------------------------------------
// Tests — Constants
// ---------------------------------------------------------------------------

describe('AGENT_DEFAULTS', () => {
  it('has correct values', () => {
    assert.equal(AGENT_DEFAULTS.timeout, 60000)
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(AGENT_DEFAULTS))
  })
})

describe('AGENT_ACTIONS', () => {
  it('has correct values', () => {
    assert.equal(AGENT_ACTIONS.CHAT, 'chat')
    assert.equal(AGENT_ACTIONS.TOOL, 'tool')
    assert.equal(AGENT_ACTIONS.MEMORIES, 'memories')
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(AGENT_ACTIONS))
  })
})

describe('AGENT_CAPABILITIES', () => {
  it('has correct values', () => {
    assert.equal(AGENT_CAPABILITIES.CHAT, 'agent:chat')
    assert.equal(AGENT_CAPABILITIES.TOOLS, 'agent:tools')
    assert.equal(AGENT_CAPABILITIES.MEMORY, 'agent:memory')
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(AGENT_CAPABILITIES))
  })
})

// ---------------------------------------------------------------------------
// Tests — AgentHost
// ---------------------------------------------------------------------------

describe('AgentHost', () => {
  let session, agent, host

  beforeEach(() => {
    session = createMockSession()
    agent = createMockAgent()
    host = new AgentHost({ session, agent })
  })

  describe('constructor', () => {
    it('registers agent handler on session', () => {
      // Verify by simulating incoming chat request
      session._simulateIncoming({
        payload: { action: 'chat', message: 'hello', requestId: 'r1' },
      })
      return new Promise((resolve) => {
        setTimeout(() => {
          assert.ok(session._transport.sent.length >= 1)
          resolve()
        }, 20)
      })
    })

    it('throws when session is missing', () => {
      assert.throws(() => new AgentHost({ agent }), /session is required/)
    })

    it('throws when agent is missing', () => {
      assert.throws(() => new AgentHost({ session }), /agent.*run/)
    })
  })

  describe('handles chat action', () => {
    it('returns agent response', async () => {
      session._simulateIncoming({
        payload: { action: 'chat', message: 'hello agent', requestId: 'req-chat' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = session._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-chat')
      assert.ok(response)
      assert.equal(response.payload.success, true)
      assert.equal(response.payload.result.response, 'Echo: hello agent')
      assert.deepEqual(response.payload.result.usage, { input_tokens: 10, output_tokens: 5 })
    })
  })

  describe('handles tool action', () => {
    it('returns tool result', async () => {
      session._simulateIncoming({
        payload: { action: 'tool', name: 'fetch', args: { url: 'http://x' }, requestId: 'req-tool' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = session._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-tool')
      assert.ok(response)
      assert.equal(response.payload.success, true)
      assert.equal(response.payload.result.success, true)
      assert.equal(response.payload.result.output, 'Ran fetch')
    })
  })

  describe('handles memories action', () => {
    it('returns memory search results', async () => {
      session._simulateIncoming({
        payload: { action: 'memories', query: 'architecture', requestId: 'req-mem' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = session._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-mem')
      assert.ok(response)
      assert.equal(response.payload.success, true)
      assert.ok(Array.isArray(response.payload.result))
      assert.equal(response.payload.result.length, 1)
      assert.equal(response.payload.result[0].key, 'architecture')
    })
  })

  describe('checks capabilities', () => {
    it('rejects chat without agent:chat capability', async () => {
      const noChatSession = createMockSession('local', 'remote', ['agent:tools'])
      new AgentHost({ session: noChatSession, agent })

      noChatSession._simulateIncoming({
        payload: { action: 'chat', message: 'hi', requestId: 'req-nochat' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = noChatSession._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-nochat')
      assert.ok(response)
      assert.ok(response.payload.error)
      assert.ok(response.payload.error.includes('capability'))
    })

    it('rejects tool without agent:tools capability', async () => {
      const noToolSession = createMockSession('local', 'remote', ['agent:chat'])
      new AgentHost({ session: noToolSession, agent })

      noToolSession._simulateIncoming({
        payload: { action: 'tool', name: 'fetch', args: {}, requestId: 'req-notool' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = noToolSession._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-notool')
      assert.ok(response)
      assert.ok(response.payload.error)
    })

    it('rejects memories without agent:memory capability', async () => {
      const noMemSession = createMockSession('local', 'remote', ['agent:chat'])
      new AgentHost({ session: noMemSession, agent })

      noMemSession._simulateIncoming({
        payload: { action: 'memories', query: 'test', requestId: 'req-nomem' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = noMemSession._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-nomem')
      assert.ok(response)
      assert.ok(response.payload.error)
    })
  })

  describe('tracks cost via costTracker', () => {
    it('records usage on chat action', async () => {
      const usageRecords = []
      const costTracker = {
        recordUsage(peerId, usage) { usageRecords.push({ peerId, usage }) },
      }
      const trackedSession = createMockSession()
      new AgentHost({ session: trackedSession, agent, costTracker })

      trackedSession._simulateIncoming({
        payload: { action: 'chat', message: 'tracked', requestId: 'req-cost' },
      })

      await new Promise((r) => setTimeout(r, 20))

      assert.equal(usageRecords.length, 1)
      assert.equal(usageRecords[0].peerId, 'remote')
      assert.equal(usageRecords[0].usage.input_tokens, 10)
      assert.equal(usageRecords[0].usage.output_tokens, 5)
    })
  })

  describe('close', () => {
    it('removes handler from session', () => {
      host.close()
      session._simulateIncoming({
        payload: { action: 'chat', message: 'after close', requestId: 'req-closed' },
      })
      assert.equal(session._transport.sent.length, 0)
    })
  })

  describe('unknown action', () => {
    it('returns error for unrecognized action', async () => {
      session._simulateIncoming({
        payload: { action: 'bogus', requestId: 'req-bogus' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = session._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-bogus')
      assert.ok(response)
      assert.ok(response.payload.error.includes('Unknown action'))
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — AgentClient
// ---------------------------------------------------------------------------

describe('AgentClient', () => {
  let session, client

  beforeEach(() => {
    session = createMockSession()
    client = new AgentClient({ session, timeout: 500 })
  })

  describe('constructor', () => {
    it('throws when session is missing', () => {
      assert.throws(() => new AgentClient({}), /session is required/)
    })
  })

  describe('chat', () => {
    it('sends chat request and resolves', async () => {
      const promise = client.chat('hello')
      const sent = session._transport.sent
      assert.equal(sent.length, 1)
      assert.equal(sent[0].payload.action, 'chat')
      assert.equal(sent[0].payload.message, 'hello')
      const requestId = sent[0].payload.requestId

      session._simulateIncoming({
        payload: { requestId, action: 'chat', success: true, result: { response: 'Echo: hello', usage: { input_tokens: 10 } } },
      })

      const result = await promise
      assert.equal(result.response, 'Echo: hello')
    })

    it('throws for empty message', async () => {
      await assert.rejects(() => client.chat(''), /non-empty string/)
    })
  })

  describe('runTool', () => {
    it('sends tool request and resolves', async () => {
      const promise = client.runTool('fetch', { url: 'http://x' })
      const sent = session._transport.sent
      assert.equal(sent[0].payload.action, 'tool')
      assert.equal(sent[0].payload.name, 'fetch')
      assert.deepEqual(sent[0].payload.args, { url: 'http://x' })
      const requestId = sent[0].payload.requestId

      session._simulateIncoming({
        payload: { requestId, action: 'tool', success: true, result: { success: true, output: 'Ran fetch' } },
      })

      const result = await promise
      assert.equal(result.success, true)
      assert.equal(result.output, 'Ran fetch')
    })

    it('throws for empty tool name', async () => {
      await assert.rejects(() => client.runTool(''), /non-empty string/)
    })
  })

  describe('searchMemories', () => {
    it('sends memories request and resolves', async () => {
      const promise = client.searchMemories('architecture')
      const sent = session._transport.sent
      assert.equal(sent[0].payload.action, 'memories')
      assert.equal(sent[0].payload.query, 'architecture')
      const requestId = sent[0].payload.requestId

      session._simulateIncoming({
        payload: { requestId, action: 'memories', success: true, result: [{ id: 'm1', key: 'architecture' }] },
      })

      const result = await promise
      assert.ok(Array.isArray(result))
      assert.equal(result[0].key, 'architecture')
    })

    it('throws for empty query', async () => {
      await assert.rejects(() => client.searchMemories(''), /non-empty string/)
    })
  })

  describe('close', () => {
    it('rejects pending requests', async () => {
      const promise = client.chat('pending')
      client.close()
      await assert.rejects(() => promise, /AgentClient closed/)
    })
  })

  describe('timeout', () => {
    it('rejects on timeout', async () => {
      const shortClient = new AgentClient({ session: createMockSession(), timeout: 50 })
      await assert.rejects(
        () => shortClient.chat('slow'),
        /timed out/,
      )
    })
  })

  describe('remote error', () => {
    it('rejects when server returns error', async () => {
      const promise = client.chat('fail')
      const sent = session._transport.sent
      const requestId = sent[0].payload.requestId

      session._simulateIncoming({
        payload: { requestId, action: 'chat', success: false, error: 'Agent unavailable' },
      })

      await assert.rejects(() => promise, /Agent unavailable/)
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — AgentHost with ChannelGateway
// ---------------------------------------------------------------------------

import { bridgePeerAgent } from '../src/peer-agent.mjs'

describe('AgentHost with gateway', () => {
  it('routes chat through gateway when provided', async () => {
    const session = createMockSession()
    const agent = createMockAgent()

    // Create a mock gateway
    const ingestCalls = []
    const mockGateway = {
      async ingest(msg, channelId) {
        ingestCalls.push({ msg, channelId })
        return 'gateway response'
      },
      register() {},
    }

    const host = new AgentHost({ session, agent, gateway: mockGateway })

    // Send a chat request
    session._simulateIncoming({
      payload: { action: 'chat', message: 'hello via gateway', requestId: 'req-gw' },
    })

    await new Promise((r) => setTimeout(r, 30))

    // Verify gateway was called
    assert.equal(ingestCalls.length, 1)
    assert.equal(ingestCalls[0].msg.content, 'hello via gateway')
    assert.equal(ingestCalls[0].msg.channel, 'mesh')
    assert.ok(ingestCalls[0].channelId.startsWith('mesh:'))

    // Verify response was sent back
    const sent = session._transport.sent
    const response = sent.find(s => s.payload?.requestId === 'req-gw')
    assert.ok(response)
    assert.equal(response.payload.success, true)
    assert.equal(response.payload.result.response, 'gateway response')
  })

  it('falls back to direct agent.run when no gateway', async () => {
    const session = createMockSession()
    const agent = createMockAgent()
    const host = new AgentHost({ session, agent })

    session._simulateIncoming({
      payload: { action: 'chat', message: 'direct call', requestId: 'req-direct' },
    })

    await new Promise((r) => setTimeout(r, 20))

    const sent = session._transport.sent
    const response = sent.find(s => s.payload?.requestId === 'req-direct')
    assert.ok(response)
    assert.equal(response.payload.success, true)
    assert.equal(response.payload.result.response, 'Echo: direct call')
  })

  it('setGateway updates gateway reference', async () => {
    const session = createMockSession()
    const agent = createMockAgent()
    const host = new AgentHost({ session, agent })

    let gwCalled = false
    host.setGateway({
      async ingest() { gwCalled = true; return 'gw' },
      register() {},
    })

    session._simulateIncoming({
      payload: { action: 'chat', message: 'test', requestId: 'req-set' },
    })

    await new Promise((r) => setTimeout(r, 20))
    assert.ok(gwCalled)
  })
})

// ---------------------------------------------------------------------------
// Tests — bridgePeerAgent factory
// ---------------------------------------------------------------------------

describe('bridgePeerAgent', () => {
  it('creates AgentHost with gateway and registers mesh plugin', () => {
    const session = createMockSession()
    const agent = createMockAgent()

    const registeredChannels = []
    const mockGateway = {
      register(channelId, plugin, config) {
        registeredChannels.push({ channelId, plugin, config })
      },
      async ingest() { return 'bridged' },
    }

    const host = bridgePeerAgent(session, agent, mockGateway)
    assert.ok(host instanceof AgentHost)

    // Verify mesh plugin was registered on gateway
    assert.equal(registeredChannels.length, 1)
    assert.ok(registeredChannels[0].channelId.startsWith('mesh:'))
    assert.ok(registeredChannels[0].plugin.running)
    assert.equal(typeof registeredChannels[0].plugin.sendMessage, 'function')
  })

  it('mesh plugin sends response via session', async () => {
    const session = createMockSession()
    const agent = createMockAgent()

    let registeredPlugin = null
    const mockGateway = {
      register(channelId, plugin) { registeredPlugin = plugin },
      async ingest() { return 'response' },
    }

    bridgePeerAgent(session, agent, mockGateway)
    assert.ok(registeredPlugin)

    // Call sendMessage on the plugin
    const ok = await registeredPlugin.sendMessage('hello from agent')
    assert.ok(ok)

    // Verify it sent through session transport
    const sent = session._transport.sent
    assert.ok(sent.length >= 1)
  })
})
