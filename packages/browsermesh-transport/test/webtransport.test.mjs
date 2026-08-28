// Run with: node --import ./test/_setup-globals.mjs --test test/webtransport.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// Mock WebTransport API
// ---------------------------------------------------------------------------

function createMockDatagrams() {
  let datagramReader
  const readable = new ReadableStream({
    start(controller) {
      datagramReader = controller
    },
  })
  const writable = new WritableStream({
    write(chunk) { /* swallow */ },
  })
  return { readable, writable, _controller: datagramReader }
}

function createMockBidiStream() {
  return {
    readable: new ReadableStream(),
    writable: new WritableStream(),
  }
}

class MockWebTransport {
  #closedResolve
  #closedReject
  datagrams
  incomingBidirectionalStreams
  _incomingController

  constructor(url) {
    this.url = url
    this.ready = Promise.resolve()
    this.closed = new Promise((resolve, reject) => {
      this.#closedResolve = resolve
      this.#closedReject = reject
    })
    this.datagrams = createMockDatagrams()
    let ctrl
    this.incomingBidirectionalStreams = new ReadableStream({
      start(controller) { ctrl = controller },
    })
    this._incomingController = ctrl
  }

  async createBidirectionalStream() {
    return createMockBidiStream()
  }

  close() {
    this.#closedResolve()
  }
}

// Install mock before importing the module under test
globalThis.WebTransport = MockWebTransport

// ---------------------------------------------------------------------------
// Import module under test (after mock is installed)
// ---------------------------------------------------------------------------

const {
  supportsWebTransport,
  WebTransportBridge,
  WebTransportAdapterFactory,
} = await import('../src/webtransport.mjs')

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('supportsWebTransport', () => {
  it('returns true when WebTransport is defined', () => {
    assert.equal(supportsWebTransport(), true)
  })

  it('returns false when WebTransport is undefined', () => {
    const saved = globalThis.WebTransport
    delete globalThis.WebTransport
    try {
      assert.equal(supportsWebTransport(), false)
    } finally {
      globalThis.WebTransport = saved
    }
  })
})

describe('WebTransportBridge', () => {
  /** @type {WebTransportBridge} */
  let bridge

  beforeEach(() => {
    bridge = new WebTransportBridge()
  })

  afterEach(() => {
    if (bridge.state !== 'closed' && bridge.state !== 'disconnected') {
      bridge.close()
    }
  })

  it('constructor sets type to wsh-wt', () => {
    assert.equal(bridge.type, 'wsh-wt')
  })

  it('starts in disconnected state', () => {
    assert.equal(bridge.state, 'disconnected')
    assert.equal(bridge.connected, false)
  })

  it('url is null before connect', () => {
    assert.equal(bridge.url, null)
  })

  it('connect transitions state to connected', async () => {
    await bridge.connect('https://example.com/wt')
    assert.equal(bridge.state, 'connected')
    assert.equal(bridge.connected, true)
  })

  it('connect stores the url', async () => {
    await bridge.connect('https://example.com/wt')
    assert.equal(bridge.url, 'https://example.com/wt')
  })

  it('connect throws if already connected', async () => {
    await bridge.connect('https://example.com/wt')
    await assert.rejects(
      () => bridge.connect('https://example.com/wt2'),
      /Already connected/,
    )
  })

  it('connect sets state to disconnected on failure', async () => {
    const saved = globalThis.WebTransport
    globalThis.WebTransport = class {
      constructor() { this.ready = Promise.reject(new Error('fail')) }
    }
    const failBridge = new WebTransportBridge()
    try {
      await assert.rejects(() => failBridge.connect('https://bad'), /fail/)
      assert.equal(failBridge.state, 'disconnected')
    } finally {
      globalThis.WebTransport = saved
    }
  })

  it('send throws when not connected', () => {
    assert.throws(
      () => bridge.send('hello'),
      /Not connected/,
    )
  })

  it('send does not throw when connected', async () => {
    await bridge.connect('https://example.com/wt')
    // Should not throw
    bridge.send('hello')
    bridge.send(new Uint8Array([1, 2, 3]))
    bridge.send({ type: 'data' })
  })

  it('close transitions to closed', async () => {
    await bridge.connect('https://example.com/wt')
    bridge.close()
    assert.equal(bridge.state, 'closed')
    assert.equal(bridge.connected, false)
  })

  it('close fires close callback', async () => {
    await bridge.connect('https://example.com/wt')
    let fired = false
    bridge.onClose(() => { fired = true })
    bridge.close()
    assert.equal(fired, true)
  })

  it('close is idempotent', async () => {
    await bridge.connect('https://example.com/wt')
    bridge.close()
    bridge.close() // should not throw
    assert.equal(bridge.state, 'closed')
  })

  it('close clears streams', async () => {
    await bridge.connect('https://example.com/wt')
    await bridge.openStream('test-stream')
    assert.equal(bridge.streamCount, 1)
    bridge.close()
    assert.equal(bridge.streamCount, 0)
  })

  it('openStream creates a tracked stream', async () => {
    await bridge.connect('https://example.com/wt')
    const stream = await bridge.openStream('my-stream')
    assert.ok(stream.readable)
    assert.ok(stream.writable)
    assert.equal(bridge.streamCount, 1)
  })

  it('openStream fires stream event', async () => {
    await bridge.connect('https://example.com/wt')
    let received = null
    bridge.onStream((data) => { received = data })
    await bridge.openStream('evt-stream')
    assert.ok(received)
    assert.equal(received.id, 'evt-stream')
    assert.ok(received.readable)
    assert.ok(received.writable)
  })

  it('openStream throws when not connected', async () => {
    await assert.rejects(
      () => bridge.openStream('fail'),
      /Not connected/,
    )
  })

  it('streamCount starts at 0', () => {
    assert.equal(bridge.streamCount, 0)
  })

  it('toJSON includes wsh-wt type', async () => {
    const json = bridge.toJSON()
    assert.equal(json.type, 'wsh-wt')
    assert.equal(json.state, 'disconnected')
  })
})

describe('WebTransportAdapterFactory', () => {
  /** @type {WebTransportAdapterFactory} */
  let factory

  beforeEach(() => {
    factory = new WebTransportAdapterFactory()
  })

  it('canCreate returns true for wsh-wt', () => {
    assert.equal(factory.canCreate('wsh-wt'), true)
  })

  it('canCreate returns false for webrtc', () => {
    assert.equal(factory.canCreate('webrtc'), false)
  })

  it('canCreate returns false for wsh-ws', () => {
    assert.equal(factory.canCreate('wsh-ws'), false)
  })

  it('create returns a WebTransportBridge instance', () => {
    const bridge = factory.create('https://example.com/wt')
    assert.ok(bridge instanceof WebTransportBridge)
  })

  it('create returns a bridge that is not yet connected', () => {
    const bridge = factory.create('https://example.com/wt')
    assert.equal(bridge.connected, false)
    assert.equal(bridge.state, 'disconnected')
  })
})
