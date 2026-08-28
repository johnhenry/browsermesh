// Run with: node --import ./test/_setup-globals.mjs --test test/wisp-client.test.mjs
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// ── Mock WebSocket ──────────────────────────────────────────────────

class MockWebSocket {
  constructor(url) {
    this.url = url
    this.binaryType = 'blob'
    this.readyState = 0 // CONNECTING
    this._listeners = {}
    this._sent = []
    this._closeCode = null
  }
  addEventListener(e, cb) { (this._listeners[e] ||= []).push(cb) }
  removeEventListener(e, cb) {
    this._listeners[e] = (this._listeners[e] || []).filter(f => f !== cb)
  }
  send(data) { this._sent.push(data) }
  close(code, reason) {
    this._closeCode = code
    this.readyState = 2
    setTimeout(() => {
      this.readyState = 3
      this._fire('close', { code: code || 1000, reason: reason || '' })
    }, 0)
  }
  _fire(e, data) { (this._listeners[e] || []).forEach(cb => cb(data)) }
  _open() { this.readyState = 1; this._fire('open', {}) }
  _error(err) { this._fire('error', err || new Error('ws error')) }
  _message(data) { this._fire('message', { data }) }
}

// Auto-open helper: creates a MockWebSocket that opens on next tick
const autoOpenWS = () => {
  return class extends MockWebSocket {
    constructor(url) {
      super(url)
      setTimeout(() => this._open(), 0)
    }
  }
}

import {
  WispClient,
  WispStream,
  encodeFrame,
  decodeFrame,
  encodeConnectPayload,
  decodeConnectPayload,
  WISP_CONNECT,
  WISP_DATA,
  WISP_CONTINUE,
  WISP_CLOSE,
  WISP_INFO,
  CLOSE_REASON_NORMAL,
  CLOSE_REASON_REFUSED,
  CLOSE_REASON_ERROR,
} from '../src/wisp-client.mjs'

// ── Frame encoding/decoding ─────────────────────────────────────────

describe('WISP frame encoding', () => {
  it('encodeFrame produces correct binary layout', () => {
    const payload = new Uint8Array([0xAA, 0xBB])
    const frame = encodeFrame(WISP_DATA, 42, payload)
    assert.equal(frame.byteLength, 7) // 1 + 4 + 2
    assert.equal(frame[0], WISP_DATA)
    const view = new DataView(frame.buffer)
    assert.equal(view.getUint32(1, true), 42)
    assert.equal(frame[5], 0xAA)
    assert.equal(frame[6], 0xBB)
  })

  it('encodeFrame with no payload', () => {
    const frame = encodeFrame(WISP_CLOSE, 1)
    assert.equal(frame.byteLength, 5)
    assert.equal(frame[0], WISP_CLOSE)
  })

  it('decodeFrame round-trips', () => {
    const original = encodeFrame(WISP_CONNECT, 999, new Uint8Array([1, 2, 3]))
    const { type, streamId, payload } = decodeFrame(original)
    assert.equal(type, WISP_CONNECT)
    assert.equal(streamId, 999)
    assert.deepEqual(payload, new Uint8Array([1, 2, 3]))
  })

  it('decodeFrame throws on short frames', () => {
    assert.throws(() => decodeFrame(new Uint8Array([0x01, 0x02])), /too short/)
  })

  it('decodeFrame accepts ArrayBuffer input', () => {
    const frame = encodeFrame(WISP_DATA, 7, new Uint8Array([0xFF]))
    const { type, streamId, payload } = decodeFrame(frame.buffer)
    assert.equal(type, WISP_DATA)
    assert.equal(streamId, 7)
    assert.equal(payload[0], 0xFF)
  })
})

describe('WISP CONNECT payload encoding', () => {
  it('round-trips host and port', () => {
    const encoded = encodeConnectPayload('example.com', 443)
    const { host, port } = decodeConnectPayload(encoded)
    assert.equal(host, 'example.com')
    assert.equal(port, 443)
  })

  it('handles localhost and high ports', () => {
    const encoded = encodeConnectPayload('localhost', 65535)
    const { host, port } = decodeConnectPayload(encoded)
    assert.equal(host, 'localhost')
    assert.equal(port, 65535)
  })

  it('throws on missing null terminator', () => {
    assert.throws(
      () => decodeConnectPayload(new Uint8Array([0x61, 0x62, 0x63])),
      /no null terminator/
    )
  })
})

// ── WispClient ──────────────────────────────────────────────────────

describe('WispClient', () => {
  let client
  let lastWS

  beforeEach(() => {
    const Ctor = class extends MockWebSocket {
      constructor(url) {
        super(url)
        lastWS = this
        setTimeout(() => this._open(), 0)
      }
    }
    client = new WispClient({
      url: 'wss://wisp.example.com/',
      reconnect: false,
      _WebSocket: Ctor,
    })
  })

  it('constructor requires url', () => {
    assert.throws(() => new WispClient({}), /url is required/)
  })

  it('starts in disconnected state', () => {
    assert.equal(client.state, 'disconnected')
    assert.equal(client.connected, false)
    assert.equal(client.activeStreams, 0)
  })

  it('connect() transitions to connected', async () => {
    await client.connect()
    assert.equal(client.state, 'connected')
    assert.equal(client.connected, true)
  })

  it('connect() sets binaryType to arraybuffer', async () => {
    await client.connect()
    assert.equal(lastWS.binaryType, 'arraybuffer')
  })

  it('connect() fires open event', async () => {
    let opened = false
    client.on('open', () => { opened = true })
    await client.connect()
    assert.equal(opened, true)
  })

  it('connect() rejects on ws error', async () => {
    const ErrorWS = class extends MockWebSocket {
      constructor(url) {
        super(url)
        setTimeout(() => this._error(new Error('refused')), 0)
      }
    }
    const c = new WispClient({ url: 'wss://bad.example.com/', _WebSocket: ErrorWS, reconnect: false })
    await assert.rejects(() => c.connect(), /refused/)
    assert.equal(c.state, 'disconnected')
  })

  it('throws on double connect', async () => {
    await client.connect()
    await assert.rejects(() => client.connect(), /Already connected/)
  })

  it('on() rejects unknown events', () => {
    assert.throws(() => client.on('bogus', () => {}), /Unknown event/)
  })

  describe('open()', () => {
    beforeEach(async () => {
      await client.connect()
    })

    it('returns a WispStream', () => {
      const stream = client.open('example.com', 80)
      assert.ok(stream instanceof WispStream)
      assert.equal(stream.host, 'example.com')
      assert.equal(stream.port, 80)
      assert.equal(stream.closed, false)
    })

    it('sends a CONNECT frame', () => {
      client.open('example.com', 443)
      const sent = lastWS._sent
      assert.equal(sent.length, 1)
      const { type, streamId, payload } = decodeFrame(sent[0])
      assert.equal(type, WISP_CONNECT)
      assert.equal(streamId, 1)
      const { host, port } = decodeConnectPayload(payload)
      assert.equal(host, 'example.com')
      assert.equal(port, 443)
    })

    it('assigns incrementing stream IDs', () => {
      const s1 = client.open('a.com', 80)
      const s2 = client.open('b.com', 80)
      const s3 = client.open('c.com', 80)
      assert.equal(s1.id, 1)
      assert.equal(s2.id, 2)
      assert.equal(s3.id, 3)
      assert.equal(client.activeStreams, 3)
    })

    it('throws when not connected', async () => {
      await client.close()
      assert.throws(() => client.open('x.com', 80), /Not connected/)
    })

    it('validates host', () => {
      assert.throws(() => client.open('', 80), /host is required/)
      assert.throws(() => client.open(null, 80), /host is required/)
    })

    it('validates port', () => {
      assert.throws(() => client.open('x.com', 0), /port must be/)
      assert.throws(() => client.open('x.com', 70000), /port must be/)
      assert.throws(() => client.open('x.com', 1.5), /port must be/)
    })
  })

  describe('incoming frames', () => {
    let stream

    beforeEach(async () => {
      await client.connect()
      stream = client.open('target.com', 8080)
      lastWS._sent = [] // clear the CONNECT frame
    })

    it('DATA frame delivers to stream', () => {
      const received = []
      stream.onData((d) => received.push(d))

      const frame = encodeFrame(WISP_DATA, stream.id, new Uint8Array([0x48, 0x69]))
      lastWS._message(frame.buffer)

      assert.equal(received.length, 1)
      assert.deepEqual(received[0], new Uint8Array([0x48, 0x69]))
    })

    it('CONTINUE frame updates buffer', () => {
      let cont = null
      stream.onContinue((val) => { cont = val })

      const payload = new Uint8Array(4)
      new DataView(payload.buffer).setUint32(0, 128, true)
      const frame = encodeFrame(WISP_CONTINUE, stream.id, payload)
      lastWS._message(frame.buffer)

      assert.equal(cont, 128)
      assert.equal(stream.bufferRemaining, 128)
    })

    it('CLOSE frame closes the stream and removes it', () => {
      let closeReason = null
      stream.onClose((r) => { closeReason = r })

      const frame = encodeFrame(WISP_CLOSE, stream.id, new Uint8Array([CLOSE_REASON_REFUSED]))
      lastWS._message(frame.buffer)

      assert.equal(closeReason, CLOSE_REASON_REFUSED)
      assert.equal(stream.closed, true)
      assert.equal(client.activeStreams, 0)
    })

    it('INFO frame stores server info', () => {
      let info = null
      client.on('info', (i) => { info = i })

      const infoData = new TextEncoder().encode(JSON.stringify({ version: 2, extensions: ['udp'] }))
      const frame = encodeFrame(WISP_INFO, 0, infoData)
      lastWS._message(frame.buffer)

      assert.deepEqual(info, { version: 2, extensions: ['udp'] })
      assert.deepEqual(client.serverInfo, { version: 2, extensions: ['udp'] })
    })

    it('ignores DATA for unknown stream IDs', () => {
      // Should not throw
      const frame = encodeFrame(WISP_DATA, 9999, new Uint8Array([1]))
      lastWS._message(frame.buffer)
    })

    it('fires error on malformed frames', () => {
      let err = null
      client.on('error', (e) => { err = e })
      lastWS._message(new Uint8Array([0x01, 0x02]).buffer) // too short
      assert.ok(err)
      assert.ok(err.message.includes('Malformed'))
    })
  })

  describe('stream write', () => {
    let stream

    beforeEach(async () => {
      await client.connect()
      stream = client.open('target.com', 80)
      lastWS._sent = []
    })

    it('write sends DATA frame', () => {
      stream.write(new Uint8Array([0x01, 0x02, 0x03]))
      assert.equal(lastWS._sent.length, 1)
      const { type, streamId, payload } = decodeFrame(lastWS._sent[0])
      assert.equal(type, WISP_DATA)
      assert.equal(streamId, stream.id)
      assert.deepEqual(payload, new Uint8Array([0x01, 0x02, 0x03]))
    })

    it('write accepts string input', () => {
      stream.write('hello')
      const { payload } = decodeFrame(lastWS._sent[0])
      assert.deepEqual(payload, new TextEncoder().encode('hello'))
    })

    it('write throws on closed stream', () => {
      stream.close()
      assert.throws(() => stream.write(new Uint8Array([1])), /closed/)
    })
  })

  describe('stream close', () => {
    let stream

    beforeEach(async () => {
      await client.connect()
      stream = client.open('target.com', 80)
      lastWS._sent = []
    })

    it('close sends CLOSE frame', () => {
      stream.close()
      assert.equal(lastWS._sent.length, 1)
      const { type, streamId, payload } = decodeFrame(lastWS._sent[0])
      assert.equal(type, WISP_CLOSE)
      assert.equal(streamId, stream.id)
      assert.equal(payload[0], CLOSE_REASON_NORMAL)
    })

    it('close with custom reason', () => {
      stream.close(CLOSE_REASON_REFUSED)
      const { payload } = decodeFrame(lastWS._sent[0])
      assert.equal(payload[0], CLOSE_REASON_REFUSED)
    })

    it('close is idempotent', () => {
      stream.close()
      stream.close()
      assert.equal(lastWS._sent.length, 1)
    })

    it('fires close event', () => {
      let reason = null
      stream.onClose((r) => { reason = r })
      stream.close()
      assert.equal(reason, CLOSE_REASON_NORMAL)
    })
  })

  describe('client close', () => {
    it('closes all streams and the websocket', async () => {
      await client.connect()
      const s1 = client.open('a.com', 80)
      const s2 = client.open('b.com', 80)

      let closeFired = false
      client.on('close', () => { closeFired = true })

      await client.close()
      assert.equal(client.state, 'closed')
      assert.equal(s1.closed, true)
      assert.equal(s2.closed, true)
      assert.equal(client.activeStreams, 0)
      assert.equal(closeFired, true)
    })

    it('close is idempotent', async () => {
      await client.connect()
      await client.close()
      await client.close() // should not throw
      assert.equal(client.state, 'closed')
    })
  })

  describe('stats', () => {
    it('tracks messages and bytes', async () => {
      await client.connect()
      const stream = client.open('x.com', 80)
      lastWS._sent = []

      stream.write(new Uint8Array([1, 2, 3]))

      const frame = encodeFrame(WISP_DATA, stream.id, new Uint8Array([4, 5]))
      lastWS._message(frame.buffer)

      const stats = client.getStats()
      assert.ok(stats.messagesSent >= 1)
      assert.ok(stats.messagesReceived >= 1)
      assert.ok(stats.bytesOut > 0)
      assert.ok(stats.bytesIn > 0)
      assert.equal(stats.streamsOpened, 1)
    })
  })

  describe('toJSON', () => {
    it('returns serializable object', async () => {
      await client.connect()
      client.open('x.com', 80)
      const json = client.toJSON()
      assert.equal(json.url, 'wss://wisp.example.com/')
      assert.equal(json.state, 'connected')
      assert.equal(json.activeStreams, 1)
      assert.ok(json.stats)
    })
  })

  describe('WispStream.toJSON', () => {
    it('returns serializable object', async () => {
      await client.connect()
      const stream = client.open('host.com', 9999)
      const json = stream.toJSON()
      assert.equal(json.host, 'host.com')
      assert.equal(json.port, 9999)
      assert.equal(json.closed, false)
      assert.equal(typeof json.id, 'number')
    })
  })

  describe('websocket disconnect', () => {
    it('force-closes all streams on unexpected disconnect', async () => {
      await client.connect()
      const s1 = client.open('a.com', 80)
      const s2 = client.open('b.com', 80)

      let s1Closed = false
      let s2Closed = false
      s1.onClose(() => { s1Closed = true })
      s2.onClose(() => { s2Closed = true })

      // simulate unexpected close
      lastWS._fire('close', { code: 1006, reason: 'abnormal' })

      assert.equal(s1Closed, true)
      assert.equal(s2Closed, true)
      assert.equal(client.state, 'disconnected')
    })
  })
})
