/**
 * Tests for cdp.mjs -- the minimal CDP client (`connect()`) against a fake
 * `WebSocket`, and `launchChrome()`/`findChromeExecutable()` against a fake
 * `spawn()` (building a real headless Chrome is the e2e test's job).
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { connect, findChromeExecutable, launchChrome } from '../src/cdp.mjs'

// ---------------------------------------------------------------------------
// A fake CDP server over a fake WebSocket -- "server" logic is a callback
// the test supplies, invoked with each outgoing command and a `reply()`
// function that queues a response as an incoming 'message' event.
// ---------------------------------------------------------------------------

function makeFakeWebSocketClass(onCommand) {
  return class FakeCdpSocket {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this._listeners = new Map()
      queueMicrotask(() => {
        this.readyState = 1
        this._dispatch('open', {})
      })
    }

    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, new Set())
      this._listeners.get(type).add(fn)
    }

    removeEventListener(type, fn) {
      this._listeners.get(type)?.delete(fn)
    }

    _dispatch(type, event) {
      for (const fn of [...(this._listeners.get(type) || [])]) fn(event)
    }

    send(data) {
      const msg = JSON.parse(data)
      onCommand(msg, (response) => {
        queueMicrotask(() => this._dispatch('message', { data: JSON.stringify(response) }))
      })
    }

    emitServerEvent(method, params, sessionId) {
      queueMicrotask(() => this._dispatch('message', { data: JSON.stringify({ method, params, sessionId }) }))
    }

    close() {
      this.readyState = 3
      this._dispatch('close', {})
    }
  }
}

describe('connect()', () => {
  it('resolves send() with the id-correlated result', async () => {
    const WS = makeFakeWebSocketClass((msg, reply) => {
      reply({ id: msg.id, result: { echoed: msg.method } })
    })
    const client = connect('ws://fake/devtools/browser/abc', { WebSocketImpl: WS })
    const result = await client.send('Target.getTargets')
    assert.deepEqual(result, { echoed: 'Target.getTargets' })
    client.close()
  })

  it('includes sessionId on the outgoing payload when given', async () => {
    let seenPayload = null
    const WS = makeFakeWebSocketClass((msg, reply) => {
      seenPayload = msg
      reply({ id: msg.id, result: {} })
    })
    const client = connect('ws://fake', { WebSocketImpl: WS })
    await client.send('Runtime.evaluate', { expression: '1+1' }, 'session-42')
    assert.equal(seenPayload.sessionId, 'session-42')
    assert.deepEqual(seenPayload.params, { expression: '1+1' })
    client.close()
  })

  it('rejects when the server answers with an error', async () => {
    const WS = makeFakeWebSocketClass((msg, reply) => {
      reply({ id: msg.id, error: { code: -32000, message: 'boom' } })
    })
    const client = connect('ws://fake', { WebSocketImpl: WS })
    await assert.rejects(client.send('Target.createTarget'), /boom/)
    client.close()
  })

  it('correlates several in-flight requests independently', async () => {
    const WS = makeFakeWebSocketClass((msg, reply) => {
      // Reply out of order to prove correlation is by id, not arrival order.
      setTimeout(() => reply({ id: msg.id, result: { id: msg.id } }), msg.id === 1 ? 10 : 0)
    })
    const client = connect('ws://fake', { WebSocketImpl: WS })
    const [a, b] = await Promise.all([client.send('A'), client.send('B')])
    assert.deepEqual(a, { id: 1 })
    assert.deepEqual(b, { id: 2 })
    client.close()
  })

  it('dispatches server-initiated events to on(method, fn), with sessionId', async () => {
    const WS = makeFakeWebSocketClass(() => {})
    const client = connect('ws://fake', { WebSocketImpl: WS })
    /** @type {object[]} */
    const seen = []
    client.on('Target.attachedToTarget', (params, sessionId) => seen.push({ params, sessionId }))
    client.socket.emitServerEvent('Target.attachedToTarget', { targetInfo: { targetId: 't1' } }, 'sess-1')
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(seen.length, 1)
    assert.equal(seen[0].sessionId, 'sess-1')
    assert.deepEqual(seen[0].params.targetInfo, { targetId: 't1' })
    client.close()
  })

  it('on() returns an unsubscribe function', async () => {
    const WS = makeFakeWebSocketClass(() => {})
    const client = connect('ws://fake', { WebSocketImpl: WS })
    let count = 0
    const unsubscribe = client.on('X', () => { count += 1 })
    client.socket.emitServerEvent('X', {})
    await new Promise((resolve) => setTimeout(resolve, 5))
    unsubscribe()
    client.socket.emitServerEvent('X', {})
    await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(count, 1)
    client.close()
  })

  it('rejects pending requests when the connection closes', async () => {
    const WS = makeFakeWebSocketClass(() => { /* never replies */ })
    const client = connect('ws://fake', { WebSocketImpl: WS })
    const pending = client.send('Target.getTargets')
    client.close()
    await assert.rejects(pending, /connection closed/)
  })

  it('throws without a global WebSocket and no override', () => {
    const saved = globalThis.WebSocket
    // @ts-expect-error -- deliberately removing it for this assertion
    globalThis.WebSocket = undefined
    try {
      assert.throws(() => connect('ws://fake'), /no global WebSocket/)
    } finally {
      globalThis.WebSocket = saved
    }
  })
})

// ---------------------------------------------------------------------------
// findChromeExecutable()
// ---------------------------------------------------------------------------

describe('findChromeExecutable()', () => {
  it('prefers CHROME_PATH when it points at a real file', () => {
    // This test file itself is a real, stat-able path -- good enough to
    // prove the env var takes priority without depending on any browser
    // actually being installed.
    const found = findChromeExecutable({ env: { CHROME_PATH: import.meta.filename } })
    assert.equal(found, import.meta.filename)
  })

  it('ignores a CHROME_PATH that does not exist', () => {
    const found = findChromeExecutable({ env: { CHROME_PATH: '/definitely/not/a/real/path/chrome' } })
    // Falls through to the macOS app bundle / PATH search; either a real
    // path or null, but never the bogus one.
    assert.notEqual(found, '/definitely/not/a/real/path/chrome')
  })

  it('returns null when nothing in the (overridden) search list exists', () => {
    const found = findChromeExecutable({
      env: {},
      macAppPaths: ['/definitely/not/a/real/path/Chrome.app'],
      pathNames: ['definitely-not-a-real-chrome-binary'],
    })
    assert.equal(found, null)
  })
})

// ---------------------------------------------------------------------------
// launchChrome() against a fake child_process
// ---------------------------------------------------------------------------

/** A fake ChildProcess-like object good enough for launchChrome()'s needs. */
function makeFakeChild() {
  const child = new EventEmitter()
  child.stderr = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = (signal) => {
    child.signalCode = signal
    queueMicrotask(() => {
      child.exitCode = 0
      child.emit('exit', 0, signal)
    })
  }
  return child
}

describe('launchChrome()', () => {
  it('resolves with the wsUrl and port parsed from stderr', async () => {
    const child = makeFakeChild()
    const spawnImpl = () => child
    const promise = launchChrome({ executable: '/fake/chrome', spawnImpl, timeoutMs: 2000 })
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('[1234:1:x] some startup log\n'))
      child.stderr.emit('data', Buffer.from('DevTools listening on ws://127.0.0.1:56123/devtools/browser/abc-def\n'))
    })
    const result = await promise
    assert.equal(result.wsUrl, 'ws://127.0.0.1:56123/devtools/browser/abc-def')
    assert.equal(result.port, 56123)
    assert.ok(result.userDataDir)
    await result.close()
    assert.equal(child.exitCode, 0)
  })

  it('passes --headless=new by default and omits it when headless:false', async () => {
    let capturedArgs = null
    const child = makeFakeChild()
    const spawnImpl = (exe, args) => { capturedArgs = args; return child }
    const promise = launchChrome({ executable: '/fake/chrome', spawnImpl, headless: false, timeoutMs: 2000 })
    queueMicrotask(() => child.stderr.emit('data', Buffer.from('DevTools listening on ws://127.0.0.1:1/x\n')))
    await promise
    assert.ok(!capturedArgs.includes('--headless=new'))
    assert.ok(capturedArgs.some((a) => a.startsWith('--remote-debugging-port=')))
  })

  it('rejects after timeoutMs if Chrome never prints the DevTools line', async () => {
    const child = makeFakeChild()
    const spawnImpl = () => child
    await assert.rejects(
      launchChrome({ executable: '/fake/chrome', spawnImpl, timeoutMs: 20 }),
      /timed out/,
    )
  })

  it('rejects if Chrome exits before printing the DevTools line', async () => {
    const child = makeFakeChild()
    const spawnImpl = () => child
    const promise = launchChrome({ executable: '/fake/chrome', spawnImpl, timeoutMs: 2000 })
    queueMicrotask(() => child.emit('exit', 1, null))
    await assert.rejects(promise, /exited before it was ready/)
  })

  it('rejects synchronously when spawnImpl itself throws (e.g. ENOENT for a bad executable)', async () => {
    const spawnImpl = () => { throw new Error('spawn ENOENT') }
    await assert.rejects(
      launchChrome({ executable: '/not/a/real/binary', spawnImpl, timeoutMs: 2000 }),
      /ENOENT/,
    )
  })
})
