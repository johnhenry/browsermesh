import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  BroadcastChannelTransport,
  EventEmitterTransport,
  NullTransport,
} from '../src/transport.mjs'

// ---------------------------------------------------------------------------
// Stub BroadcastChannel for testing BroadcastChannelTransport
// ---------------------------------------------------------------------------

const channels = new Map()

class StubBroadcastChannel {
  constructor(name) {
    this.name = name
    this.onmessage = null
    this._closed = false
    this._posted = []
    if (!channels.has(name)) channels.set(name, new Set())
    channels.get(name).add(this)
  }
  postMessage(data) {
    if (this._closed) return
    this._posted.push(data)
    const peers = channels.get(this.name)
    if (!peers) return
    for (const ch of peers) {
      if (ch !== this && !ch._closed && ch.onmessage) {
        Promise.resolve().then(() => ch.onmessage({ data }))
      }
    }
  }
  close() {
    this._closed = true
    const set = channels.get(this.name)
    if (set) set.delete(this)
  }
}

// ---------------------------------------------------------------------------
// BroadcastChannelTransport
// ---------------------------------------------------------------------------

describe('BroadcastChannelTransport', () => {
  afterEach(() => {
    channels.clear()
  })

  it('is not ready before open()', () => {
    const t = new BroadcastChannelTransport('test-ch', StubBroadcastChannel)
    assert.equal(t.ready, false)
  })

  it('is ready after open()', async () => {
    const t = new BroadcastChannelTransport('test-ch', StubBroadcastChannel)
    await t.open()
    assert.equal(t.ready, true)
    await t.close()
  })

  it('open() is idempotent', async () => {
    const t = new BroadcastChannelTransport('test-ch', StubBroadcastChannel)
    await t.open()
    await t.open() // should not throw or create a second channel
    assert.equal(t.ready, true)
    await t.close()
  })

  it('send() posts a message on the underlying channel', async () => {
    const t = new BroadcastChannelTransport('test-ch', StubBroadcastChannel)
    await t.open()
    t.send({ hello: 1 })
    // Grab the underlying StubBroadcastChannel instance
    const stubs = [...channels.get('test-ch')]
    assert.equal(stubs.length, 1)
    assert.deepEqual(stubs[0]._posted, [{ hello: 1 }])
    await t.close()
  })

  it('send() is a no-op before open()', () => {
    const t = new BroadcastChannelTransport('test-ch', StubBroadcastChannel)
    t.send({ nope: true }) // should not throw
  })

  it('onMessage handler receives messages from peers', async () => {
    const t1 = new BroadcastChannelTransport('test-ch', StubBroadcastChannel)
    const t2 = new BroadcastChannelTransport('test-ch', StubBroadcastChannel)

    const received = []
    t1.onMessage((msg) => received.push(msg))

    await t1.open()
    await t2.open()

    t2.send({ from: 't2' })
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(received.length, 1)
    assert.deepEqual(received[0], { from: 't2' })

    await t1.close()
    await t2.close()
  })

  it('close() sets ready to false', async () => {
    const t = new BroadcastChannelTransport('test-ch', StubBroadcastChannel)
    await t.open()
    assert.equal(t.ready, true)
    await t.close()
    assert.equal(t.ready, false)
  })

  it('close() is safe to call when not open', async () => {
    const t = new BroadcastChannelTransport('test-ch', StubBroadcastChannel)
    await t.close() // should not throw
  })
})

// ---------------------------------------------------------------------------
// EventEmitterTransport
// ---------------------------------------------------------------------------

describe('EventEmitterTransport', () => {
  it('createBus() returns a Set', () => {
    const bus = EventEmitterTransport.createBus()
    assert.ok(bus instanceof Set)
  })

  it('is not ready before open()', () => {
    const t = new EventEmitterTransport()
    assert.equal(t.ready, false)
  })

  it('is ready after open()', async () => {
    const t = new EventEmitterTransport()
    await t.open()
    assert.equal(t.ready, true)
    await t.close()
  })

  it('open() is idempotent', async () => {
    const bus = EventEmitterTransport.createBus()
    const t = new EventEmitterTransport(bus)
    await t.open()
    await t.open()
    assert.equal(t.ready, true)
    // Should only have one receiver registered
    assert.equal(bus.size, 1)
    await t.close()
  })

  it('cross-delivers messages between two transports on the same bus', async () => {
    const bus = EventEmitterTransport.createBus()
    const t1 = new EventEmitterTransport(bus)
    const t2 = new EventEmitterTransport(bus)

    const received1 = []
    const received2 = []
    t1.onMessage((msg) => received1.push(msg))
    t2.onMessage((msg) => received2.push(msg))

    await t1.open()
    await t2.open()

    t1.send({ from: 't1' })
    t2.send({ from: 't2' })

    assert.deepEqual(received1, [{ from: 't2' }])
    assert.deepEqual(received2, [{ from: 't1' }])

    await t1.close()
    await t2.close()
  })

  it('does NOT deliver messages to self', async () => {
    const bus = EventEmitterTransport.createBus()
    const t = new EventEmitterTransport(bus)

    const received = []
    t.onMessage((msg) => received.push(msg))
    await t.open()

    t.send({ self: true })
    assert.equal(received.length, 0)

    await t.close()
  })

  it('send() is a no-op before open()', () => {
    const t = new EventEmitterTransport()
    t.send({ nope: true }) // should not throw
  })

  it('close() removes the receiver from the bus', async () => {
    const bus = EventEmitterTransport.createBus()
    const t = new EventEmitterTransport(bus)
    await t.open()
    assert.equal(bus.size, 1)
    await t.close()
    assert.equal(bus.size, 0)
    assert.equal(t.ready, false)
  })

  it('listener errors do not crash the sender', async () => {
    const bus = EventEmitterTransport.createBus()
    const t1 = new EventEmitterTransport(bus)
    const t2 = new EventEmitterTransport(bus)

    t2.onMessage(() => { throw new Error('boom') })
    await t1.open()
    await t2.open()

    // Should not throw
    t1.send({ test: true })

    await t1.close()
    await t2.close()
  })

  it('exposes the bus via .bus getter', () => {
    const bus = EventEmitterTransport.createBus()
    const t = new EventEmitterTransport(bus)
    assert.equal(t.bus, bus)
  })

  it('creates its own bus when none is provided', () => {
    const t = new EventEmitterTransport()
    assert.ok(t.bus instanceof Set)
  })
})

// ---------------------------------------------------------------------------
// NullTransport
// ---------------------------------------------------------------------------

describe('NullTransport', () => {
  it('is always ready', () => {
    const t = new NullTransport()
    assert.equal(t.ready, true)
  })

  it('open/close/send/onMessage are no-ops', async () => {
    const t = new NullTransport()
    await t.open()
    t.onMessage(() => {})
    t.send({ msg: 1 })
    await t.close()
    assert.equal(t.ready, true) // still true after close
  })
})
