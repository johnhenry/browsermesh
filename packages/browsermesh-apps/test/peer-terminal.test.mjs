/**
 * Tests for TerminalHost and TerminalClient — remote terminal over peer sessions.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/peer-terminal.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Provide crypto.randomUUID if not available
if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

import { TerminalHost, TerminalClient, TERMINAL_DEFAULTS } from '../src/peer-terminal.mjs'

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
// Mock session (for host and client)
// ---------------------------------------------------------------------------

function createMockSession(localPodId = 'local', remotePodId = 'remote', capabilities = ['terminal:execute']) {
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
    get sessionId() { return 'session-t1' },
    _simulateIncoming(payload) { handlers.terminal?.(payload) },
    _transport: transport,
  }
}

// ---------------------------------------------------------------------------
// Mock shell
// ---------------------------------------------------------------------------

function createMockShell() {
  return {
    async execute(command) {
      if (command === 'error-cmd') throw new Error('shell error')
      return { output: `output of: ${command}`, exitCode: 0 }
    },
  }
}

// ---------------------------------------------------------------------------
// Tests — TERMINAL_DEFAULTS
// ---------------------------------------------------------------------------

describe('TERMINAL_DEFAULTS', () => {
  it('has correct values', () => {
    assert.equal(TERMINAL_DEFAULTS.maxOutputLength, 65536)
    assert.equal(TERMINAL_DEFAULTS.timeout, 30000)
    assert.ok(Array.isArray(TERMINAL_DEFAULTS.blockedCommands))
    assert.ok(TERMINAL_DEFAULTS.blockedCommands.includes('exit'))
    assert.ok(TERMINAL_DEFAULTS.blockedCommands.includes('shutdown'))
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(TERMINAL_DEFAULTS))
  })
})

// ---------------------------------------------------------------------------
// Tests — TerminalHost
// ---------------------------------------------------------------------------

describe('TerminalHost', () => {
  let session, shell, host

  beforeEach(() => {
    session = createMockSession()
    shell = createMockShell()
    host = new TerminalHost({ session, shell })
  })

  describe('constructor', () => {
    it('registers terminal handler on session', () => {
      // Verify by simulating incoming — if handler registered it will call shell
      session._simulateIncoming({
        payload: { command: 'ls', requestId: 'r1' },
      })
      // Wait for async handler
      return new Promise((resolve) => {
        setTimeout(() => {
          const sent = session._transport.sent
          assert.ok(sent.length >= 1)
          resolve()
        }, 20)
      })
    })

    it('throws when session is missing', () => {
      assert.throws(() => new TerminalHost({ shell }), /session is required/)
    })

    it('throws when shell is missing', () => {
      assert.throws(() => new TerminalHost({ session }), /shell.*execute/)
    })
  })

  describe('executes command via shell', () => {
    it('returns output and exitCode', async () => {
      session._simulateIncoming({
        payload: { command: 'echo hello', requestId: 'req-1' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = session._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-1')
      assert.ok(response)
      assert.equal(response.payload.output, 'output of: echo hello')
      assert.equal(response.payload.exitCode, 0)
    })
  })

  describe('blocks disallowed commands', () => {
    it('blocks exit', async () => {
      session._simulateIncoming({
        payload: { command: 'exit', requestId: 'req-exit' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = session._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-exit')
      assert.ok(response)
      assert.equal(response.payload.exitCode, 126)
      assert.ok(response.payload.output.includes('not allowed'))
    })

    it('blocks shutdown', async () => {
      session._simulateIncoming({
        payload: { command: 'shutdown now', requestId: 'req-sd' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = session._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-sd')
      assert.ok(response)
      assert.equal(response.payload.exitCode, 126)
    })
  })

  describe('respects allowlist', () => {
    it('only allows listed commands', async () => {
      const restricted = new TerminalHost({
        session: createMockSession(),
        shell: createMockShell(),
        allowedCommands: ['ls', 'pwd'],
      })

      // Allowed command
      restricted._transport = restricted // N/A, use session directly
      const restrictedSession = createMockSession()
      const restrictedHost = new TerminalHost({
        session: restrictedSession,
        shell,
        allowedCommands: ['ls', 'pwd'],
      })

      restrictedSession._simulateIncoming({
        payload: { command: 'cat /etc/passwd', requestId: 'req-cat' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = restrictedSession._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-cat')
      assert.ok(response)
      assert.equal(response.payload.exitCode, 126)
      assert.ok(response.payload.output.includes('not allowed'))
    })
  })

  describe('truncates long output', () => {
    it('truncates output exceeding maxOutputLength', async () => {
      const longShell = {
        async execute() { return { output: 'x'.repeat(200), exitCode: 0 } },
      }
      const smallSession = createMockSession()
      new TerminalHost({ session: smallSession, shell: longShell, maxOutputLength: 50 })

      smallSession._simulateIncoming({
        payload: { command: 'big-output', requestId: 'req-trunc' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = smallSession._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-trunc')
      assert.ok(response)
      assert.equal(response.payload.output.length, 50)
      assert.equal(response.payload.truncated, true)
    })
  })

  describe('requires terminal:execute capability', () => {
    it('rejects when capability is missing', async () => {
      const noCapsSession = createMockSession('local', 'remote', [])
      new TerminalHost({ session: noCapsSession, shell })

      noCapsSession._simulateIncoming({
        payload: { command: 'ls', requestId: 'req-nocap' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = noCapsSession._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-nocap')
      assert.ok(response)
      assert.ok(response.payload.output.includes('Error'))
    })
  })

  describe('close', () => {
    it('removes handler from session', () => {
      host.close()
      // After close, simulate incoming — should not trigger shell
      session._simulateIncoming({
        payload: { command: 'ls', requestId: 'req-after-close' },
      })
      // No response should be sent
      assert.equal(session._transport.sent.length, 0)
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — TerminalClient
// ---------------------------------------------------------------------------

describe('TerminalClient', () => {
  let session, client

  beforeEach(() => {
    session = createMockSession()
    client = new TerminalClient({ session, timeout: 500 })
  })

  describe('constructor', () => {
    it('throws when session is missing', () => {
      assert.throws(() => new TerminalClient({}), /session is required/)
    })
  })

  describe('execute', () => {
    it('sends request and resolves on response', async () => {
      const promise = client.execute('ls -la')

      // Inspect what was sent
      const sent = session._transport.sent
      assert.equal(sent.length, 1)
      assert.equal(sent[0].type, 'terminal')
      assert.equal(sent[0].payload.command, 'ls -la')
      const requestId = sent[0].payload.requestId

      // Simulate response
      session._simulateIncoming({
        payload: { requestId, output: 'file1\nfile2', exitCode: 0 },
      })

      const result = await promise
      assert.equal(result.output, 'file1\nfile2')
      assert.equal(result.exitCode, 0)
    })

    it('rejects on timeout', async () => {
      const shortClient = new TerminalClient({ session: createMockSession(), timeout: 50 })
      await assert.rejects(
        () => shortClient.execute('slow-cmd'),
        /timed out/,
      )
    })

    it('throws for empty command', async () => {
      await assert.rejects(() => client.execute(''), /non-empty string/)
    })
  })

  describe('sendResize', () => {
    it('sends resize event', () => {
      client.sendResize(120, 40)
      const sent = session._transport.sent
      assert.equal(sent.length, 1)
      assert.equal(sent[0].type, 'terminal')
      assert.deepEqual(sent[0].payload.resize, { cols: 120, rows: 40 })
    })
  })

  describe('close', () => {
    it('rejects pending requests', async () => {
      const promise = client.execute('pending-cmd')
      client.close()
      await assert.rejects(() => promise, /TerminalClient closed/)
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — Host+Client integration
// ---------------------------------------------------------------------------

describe('TerminalHost + TerminalClient integration', () => {
  it('command flows from client through host and back', async () => {
    // Create two sessions that share the same "wire" by bridging sends
    const hostSession = createMockSession('host-pod', 'client-pod', ['terminal:execute'])
    const clientSession = createMockSession('client-pod', 'host-pod', ['terminal:execute'])

    const shell = createMockShell()
    new TerminalHost({ session: hostSession, shell })
    const client = new TerminalClient({ session: clientSession, timeout: 1000 })

    // Bridge: when client sends, deliver to host
    const clientSentWatcher = setInterval(() => {
      while (clientSession._transport.sent.length > 0) {
        const msg = clientSession._transport.sent.shift()
        hostSession._simulateIncoming({ payload: msg.payload })
      }
    }, 5)

    // Bridge: when host sends, deliver to client
    const hostSentWatcher = setInterval(() => {
      while (hostSession._transport.sent.length > 0) {
        const msg = hostSession._transport.sent.shift()
        clientSession._simulateIncoming({ payload: msg.payload })
      }
    }, 5)

    try {
      const result = await client.execute('whoami')
      assert.equal(result.output, 'output of: whoami')
      assert.equal(result.exitCode, 0)
    } finally {
      clearInterval(clientSentWatcher)
      clearInterval(hostSentWatcher)
    }
  })
})
