// Run with: node --import ./test/_setup-globals.mjs --test test/wisp.test.mjs
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  WispClient,
  WispStream,
  encodeFrame,
  WISP_CONNECT,
  WISP_DATA,
  WISP_CLOSE,
  CLOSE_REASON_NORMAL,
  CLOSE_REASON_ERROR,
} from '../src/wisp-client.mjs'

// ── Mock WebSocket ──────────────────────────────────────────────────

class MockWebSocket {
  constructor(url) {
    this.url = url
    this.binaryType = 'blob'
    this.readyState = 0
    this._listeners = {}
    this._sent = []
  }
  addEventListener(e, cb) { (this._listeners[e] ||= []).push(cb) }
  removeEventListener(e, cb) {
    this._listeners[e] = (this._listeners[e] || []).filter(f => f !== cb)
  }
  send(data) { this._sent.push(data) }
  close(code, reason) {
    this.readyState = 2
    setTimeout(() => {
      this.readyState = 3
      this._fire('close', { code: code || 1000, reason: reason || '' })
    }, 0)
  }
  _fire(e, data) { (this._listeners[e] || []).forEach(cb => cb(data)) }
  _open() { this.readyState = 1; this._fire('open', {}) }
  _message(data) { this._fire('message', { data }) }
}

// Track the last created MockWebSocket
let lastMockWS = null
const AutoOpenWS = class extends MockWebSocket {
  constructor(url) {
    super(url)
    lastMockWS = this
    setTimeout(() => this._open(), 0)
  }
}

import { WispTransport } from '../src/wisp.mjs'

// ── WispTransport ───────────────────────────────────────────────────

describe('WispTransport', () => {
  let transport

  beforeEach(() => {
    lastMockWS = null
    transport = new WispTransport({
      url: 'wss://wisp-relay.example.com/',
      targetHost: 'my-server.local',
      targetPort: 9083,
      reconnect: false,
      _WebSocket: AutoOpenWS,
    })
  })

  it('constructor requires url', () => {
    assert.throws(() => new WispTransport({}), /url is required/)
  })

  it('has correct defaults', () => {
    const t = new WispTransport({ url: 'wss://x.com/', reconnect: false, _WebSocket: AutoOpenWS })
    assert.equal(t.type, 'wisp')
    assert.equal(t.targetHost, 'localhost')
    assert.equal(t.targetPort, 9083)
  })

  it('starts disconnected', () => {
    assert.equal(transport.state, 'disconnected')
    assert.equal(transport.connected, false)
  })

  describe('connect()', () => {
    it('transitions to connected', async () => {
      await transport.connect()
      assert.equal(transport.state, 'connected')
      assert.equal(transport.connected, true)
    })

    it('fires open event', async () => {
      let opened = false
      transport.on('open', () => { opened = true })
      await transport.connect()
      assert.equal(opened, true)
    })

    it('creates underlying WispClient', async () => {
      await transport.connect()
      assert.ok(transport.client)
      assert.ok(transport.client instanceof WispClient)
    })

    it('throws on double connect', async () => {
      await transport.connect()
      await assert.rejects(() => transport.connect(), /Already connected/)
    })

    it('opens a control stream to targetHost:targetPort', async () => {
      await transport.connect()
      // The CONNECT frame should have been sent
      assert.ok(lastMockWS._sent.length >= 1)
    })
  })

  describe('send()', () => {
    beforeEach(async () => {
      await transport.connect()
      lastMockWS._sent = [] // clear CONNECT frame
    })

    it('sends data over the control stream', () => {
      transport.send(new Uint8Array([0x01, 0x02]))
      assert.equal(lastMockWS._sent.length, 1)
    })

    it('accepts string data', () => {
      transport.send('hello')
      assert.equal(lastMockWS._sent.length, 1)
    })

    it('throws when not connected', async () => {
      await transport.close()
      assert.throws(() => transport.send(new Uint8Array([1])), /Not connected/)
    })

    it('tracks stats', () => {
      transport.send(new Uint8Array([0xAA, 0xBB, 0xCC]))
      const stats = transport.getStats()
      assert.equal(stats.messagesSent, 1)
      assert.ok(stats.bytesOut > 0)
    })
  })

  describe('receive', () => {
    beforeEach(async () => {
      await transport.connect()
    })

    it('fires message event on incoming DATA', () => {
      const received = []
      transport.on('message', (d) => received.push(d))

      // Send a DATA frame for the control stream (stream ID 1)
      const frame = encodeFrame(WISP_DATA, 1, new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]))
      lastMockWS._message(frame.buffer)

      assert.equal(received.length, 1)
      assert.deepEqual(received[0], new Uint8Array([0x48, 0x65, 0x6C, 0x6C, 0x6F]))
    })
  })

  describe('openStream()', () => {
    beforeEach(async () => {
      await transport.connect()
      lastMockWS._sent = []
    })

    it('opens additional streams', () => {
      const stream = transport.openStream('data-host.local', 8080)
      assert.ok(stream instanceof WispStream)
      assert.equal(stream.host, 'data-host.local')
      assert.equal(stream.port, 8080)
    })

    it('fires stream event', () => {
      let streamEvent = null
      transport.on('stream', (s) => { streamEvent = s })
      const stream = transport.openStream('rpc.local', 5000)
      assert.ok(streamEvent === stream)
    })

    it('throws when not connected', async () => {
      await transport.close()
      assert.throws(() => transport.openStream('x.com', 80), /Not connected/)
    })
  })

  describe('close()', () => {
    it('closes the transport', async () => {
      await transport.connect()
      let closed = false
      transport.on('close', () => { closed = true })
      await transport.close()
      assert.equal(transport.state, 'closed')
      assert.equal(closed, true)
    })

    it('is idempotent', async () => {
      await transport.connect()
      await transport.close()
      await transport.close() // should not throw
      assert.equal(transport.state, 'closed')
    })
  })

  describe('on()', () => {
    it('rejects unknown events', () => {
      assert.throws(() => transport.on('bogus', () => {}), /Unknown event/)
    })

    it('accepts all valid events', () => {
      for (const e of ['open', 'message', 'close', 'error', 'reconnect', 'stream']) {
        transport.on(e, () => {}) // should not throw
      }
    })
  })

  describe('toJSON()', () => {
    it('returns serializable object before connect', () => {
      const json = transport.toJSON()
      assert.equal(json.type, 'wisp')
      assert.equal(json.state, 'disconnected')
      assert.equal(json.url, 'wss://wisp-relay.example.com/')
      assert.equal(json.targetHost, 'my-server.local')
      assert.equal(json.targetPort, 9083)
      assert.ok(json.stats)
      assert.equal(json.clientInfo, null)
    })

    it('includes client info after connect', async () => {
      await transport.connect()
      const json = transport.toJSON()
      assert.equal(json.state, 'connected')
      assert.ok(json.clientInfo)
      assert.equal(json.clientInfo.state, 'connected')
    })
  })

  describe('getters', () => {
    it('exposes url, targetHost, targetPort, type', () => {
      assert.equal(transport.url, 'wss://wisp-relay.example.com/')
      assert.equal(transport.targetHost, 'my-server.local')
      assert.equal(transport.targetPort, 9083)
      assert.equal(transport.type, 'wisp')
      assert.equal(transport.reconnectEnabled, false)
    })
  })
})
