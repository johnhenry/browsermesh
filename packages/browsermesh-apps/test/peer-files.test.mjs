/**
 * Tests for FileHost and FileClient — remote file access over peer sessions.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/peer-files.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Provide crypto.randomUUID if not available
if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

import {
  FileHost,
  FileClient,
  FILE_DEFAULTS,
  FILE_ACTIONS,
  FILE_CAPABILITIES,
} from '../src/peer-files.mjs'

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

function createMockSession(localPodId = 'local', remotePodId = 'remote', capabilities = ['fs:read', 'fs:write', 'fs:delete']) {
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
    get sessionId() { return 'session-f1' },
    _simulateIncoming(payload) { handlers.files?.(payload) },
    _transport: transport,
  }
}

// ---------------------------------------------------------------------------
// Mock fs
// ---------------------------------------------------------------------------

function createMockFs() {
  const files = new Map([['test.txt', { data: 'hello', size: 5 }]])
  return {
    async list(path) {
      return [...files.entries()].map(([name, f]) => ({ name, type: 'file', size: f.size }))
    },
    async read(path) {
      const f = files.get(path)
      if (!f) throw new Error('Not found')
      return { data: f.data, size: f.size }
    },
    async write(path, data) {
      const size = typeof data === 'string' ? data.length : data.byteLength
      files.set(path, { data, size })
      return { success: true, size }
    },
    async delete(path) {
      return { success: files.delete(path) }
    },
    async stat(path) {
      const f = files.get(path)
      return f ? { name: path, type: 'file', size: f.size, modified: Date.now() } : null
    },
  }
}

// ---------------------------------------------------------------------------
// Tests — Constants
// ---------------------------------------------------------------------------

describe('FILE_DEFAULTS', () => {
  it('has correct values', () => {
    assert.equal(FILE_DEFAULTS.maxFileSize, 10 * 1024 * 1024)
    assert.equal(FILE_DEFAULTS.timeout, 30000)
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(FILE_DEFAULTS))
  })
})

describe('FILE_ACTIONS', () => {
  it('has correct values', () => {
    assert.equal(FILE_ACTIONS.LIST, 'list')
    assert.equal(FILE_ACTIONS.READ, 'read')
    assert.equal(FILE_ACTIONS.WRITE, 'write')
    assert.equal(FILE_ACTIONS.DELETE, 'delete')
    assert.equal(FILE_ACTIONS.STAT, 'stat')
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(FILE_ACTIONS))
  })
})

describe('FILE_CAPABILITIES', () => {
  it('has correct values', () => {
    assert.equal(FILE_CAPABILITIES.READ, 'fs:read')
    assert.equal(FILE_CAPABILITIES.WRITE, 'fs:write')
    assert.equal(FILE_CAPABILITIES.DELETE, 'fs:delete')
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(FILE_CAPABILITIES))
  })
})

// ---------------------------------------------------------------------------
// Tests — FileHost
// ---------------------------------------------------------------------------

describe('FileHost', () => {
  let session, fs, host

  beforeEach(() => {
    session = createMockSession()
    fs = createMockFs()
    host = new FileHost({ session, fs })
  })

  describe('constructor', () => {
    it('registers files handler on session', () => {
      // Verify by simulating incoming list request
      session._simulateIncoming({
        payload: { action: 'list', path: '/', requestId: 'r1' },
      })
      return new Promise((resolve) => {
        setTimeout(() => {
          assert.ok(session._transport.sent.length >= 1)
          resolve()
        }, 20)
      })
    })

    it('throws when session is missing', () => {
      assert.throws(() => new FileHost({ fs }), /session is required/)
    })

    it('throws when fs is missing', () => {
      assert.throws(() => new FileHost({ session }), /fs.*list/)
    })
  })

  describe('handles list action', () => {
    it('returns file listing', async () => {
      session._simulateIncoming({
        payload: { action: 'list', path: '/', requestId: 'req-list' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = session._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-list')
      assert.ok(response)
      assert.equal(response.payload.success, true)
      assert.ok(Array.isArray(response.payload.result))
      assert.equal(response.payload.result[0].name, 'test.txt')
    })
  })

  describe('handles read action', () => {
    it('returns file content', async () => {
      session._simulateIncoming({
        payload: { action: 'read', path: 'test.txt', requestId: 'req-read' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = session._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-read')
      assert.ok(response)
      assert.equal(response.payload.success, true)
      assert.equal(response.payload.result.data, 'hello')
      assert.equal(response.payload.result.size, 5)
    })
  })

  describe('handles write action', () => {
    it('writes data and returns success', async () => {
      session._simulateIncoming({
        payload: { action: 'write', path: 'new.txt', data: 'new content', requestId: 'req-write' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = session._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-write')
      assert.ok(response)
      assert.equal(response.payload.success, true)
      assert.equal(response.payload.result.size, 11)
    })
  })

  describe('handles delete action', () => {
    it('deletes file and returns success', async () => {
      session._simulateIncoming({
        payload: { action: 'delete', path: 'test.txt', requestId: 'req-del' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = session._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-del')
      assert.ok(response)
      assert.equal(response.payload.success, true)
    })
  })

  describe('handles stat action', () => {
    it('returns file metadata', async () => {
      session._simulateIncoming({
        payload: { action: 'stat', path: 'test.txt', requestId: 'req-stat' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = session._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-stat')
      assert.ok(response)
      assert.equal(response.payload.success, true)
      assert.equal(response.payload.result.name, 'test.txt')
      assert.equal(response.payload.result.type, 'file')
      assert.equal(response.payload.result.size, 5)
    })

    it('returns null for non-existent file', async () => {
      session._simulateIncoming({
        payload: { action: 'stat', path: 'missing.txt', requestId: 'req-stat2' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = session._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-stat2')
      assert.ok(response)
      assert.equal(response.payload.success, true)
      assert.equal(response.payload.result, null)
    })
  })

  describe('rejects oversized writes', () => {
    it('returns error for files exceeding maxFileSize', async () => {
      const smallHost = new FileHost({ session: createMockSession(), fs, maxFileSize: 10 })
      const smallSession = createMockSession()
      new FileHost({ session: smallSession, fs, maxFileSize: 10 })

      smallSession._simulateIncoming({
        payload: { action: 'write', path: 'big.txt', data: 'x'.repeat(100), requestId: 'req-big' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = smallSession._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-big')
      assert.ok(response)
      assert.equal(response.payload.success, false)
      assert.ok(response.payload.error.includes('exceeds'))
    })
  })

  describe('checks capabilities', () => {
    it('rejects write without fs:write capability', async () => {
      const readOnlySession = createMockSession('local', 'remote', ['fs:read'])
      new FileHost({ session: readOnlySession, fs })

      readOnlySession._simulateIncoming({
        payload: { action: 'write', path: 'new.txt', data: 'test', requestId: 'req-noperm' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = readOnlySession._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-noperm')
      assert.ok(response)
      assert.ok(response.payload.error)
      assert.ok(response.payload.error.includes('capability'))
    })

    it('rejects delete without fs:delete capability', async () => {
      const readOnlySession = createMockSession('local', 'remote', ['fs:read'])
      new FileHost({ session: readOnlySession, fs })

      readOnlySession._simulateIncoming({
        payload: { action: 'delete', path: 'test.txt', requestId: 'req-nodelperm' },
      })

      await new Promise((r) => setTimeout(r, 20))

      const sent = readOnlySession._transport.sent
      const response = sent.find(s => s.payload?.requestId === 'req-nodelperm')
      assert.ok(response)
      assert.ok(response.payload.error)
    })
  })

  describe('close', () => {
    it('removes handler from session', () => {
      host.close()
      session._simulateIncoming({
        payload: { action: 'list', path: '/', requestId: 'after-close' },
      })
      assert.equal(session._transport.sent.length, 0)
    })
  })
})

// ---------------------------------------------------------------------------
// Tests — FileClient
// ---------------------------------------------------------------------------

describe('FileClient', () => {
  let session, client

  beforeEach(() => {
    session = createMockSession()
    client = new FileClient({ session, timeout: 500 })
  })

  describe('constructor', () => {
    it('throws when session is missing', () => {
      assert.throws(() => new FileClient({}), /session is required/)
    })
  })

  describe('listFiles', () => {
    it('sends list request', async () => {
      const promise = client.listFiles('/docs')
      const sent = session._transport.sent
      assert.equal(sent.length, 1)
      assert.equal(sent[0].payload.action, 'list')
      assert.equal(sent[0].payload.path, '/docs')
      const requestId = sent[0].payload.requestId

      session._simulateIncoming({
        payload: { requestId, action: 'list', success: true, result: [{ name: 'a.txt' }] },
      })

      const result = await promise
      assert.deepEqual(result, [{ name: 'a.txt' }])
    })
  })

  describe('readFile', () => {
    it('sends read request', async () => {
      const promise = client.readFile('test.txt')
      const sent = session._transport.sent
      const requestId = sent[0].payload.requestId

      session._simulateIncoming({
        payload: { requestId, action: 'read', success: true, result: { data: 'hello', size: 5 } },
      })

      const result = await promise
      assert.equal(result.data, 'hello')
      assert.equal(result.size, 5)
    })
  })

  describe('writeFile', () => {
    it('sends write request with data', async () => {
      const promise = client.writeFile('out.txt', 'content')
      const sent = session._transport.sent
      assert.equal(sent[0].payload.action, 'write')
      assert.equal(sent[0].payload.data, 'content')
      const requestId = sent[0].payload.requestId

      session._simulateIncoming({
        payload: { requestId, action: 'write', success: true, result: { success: true, size: 7 } },
      })

      const result = await promise
      assert.equal(result.success, true)
      assert.equal(result.size, 7)
    })
  })

  describe('deleteFile', () => {
    it('sends delete request', async () => {
      const promise = client.deleteFile('old.txt')
      const sent = session._transport.sent
      assert.equal(sent[0].payload.action, 'delete')
      const requestId = sent[0].payload.requestId

      session._simulateIncoming({
        payload: { requestId, action: 'delete', success: true, result: { success: true } },
      })

      const result = await promise
      assert.equal(result.success, true)
    })
  })

  describe('stat', () => {
    it('sends stat request', async () => {
      const promise = client.stat('test.txt')
      const sent = session._transport.sent
      assert.equal(sent[0].payload.action, 'stat')
      const requestId = sent[0].payload.requestId

      session._simulateIncoming({
        payload: { requestId, action: 'stat', success: true, result: { name: 'test.txt', type: 'file', size: 5, modified: 1000 } },
      })

      const result = await promise
      assert.equal(result.name, 'test.txt')
      assert.equal(result.size, 5)
    })
  })

  describe('close', () => {
    it('rejects pending requests', async () => {
      const promise = client.listFiles('/foo')
      client.close()
      await assert.rejects(() => promise, /FileClient closed/)
    })
  })

  describe('timeout', () => {
    it('rejects on timeout', async () => {
      const shortClient = new FileClient({ session: createMockSession(), timeout: 50 })
      await assert.rejects(
        () => shortClient.readFile('slow.txt'),
        /timed out/,
      )
    })
  })

  describe('remote error', () => {
    it('rejects when server returns error', async () => {
      const promise = client.readFile('bad.txt')
      const sent = session._transport.sent
      const requestId = sent[0].payload.requestId

      session._simulateIncoming({
        payload: { requestId, action: 'read', success: false, error: 'Not found' },
      })

      await assert.rejects(() => promise, /Not found/)
    })
  })
})
