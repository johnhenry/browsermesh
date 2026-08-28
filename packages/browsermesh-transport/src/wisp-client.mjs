import { silentCatch } from './silent-catch.mjs'
/**
 * clawser-wisp.mjs -- WISP (WebSocket Internet Subprotocol) Transport.
 *
 * Multiplexes TCP streams over a single WebSocket connection to a WISP
 * relay server. Each stream gets a unique 32-bit stream ID. Messages
 * are binary frames with a type byte + stream ID + payload.
 *
 * WISP frame format (little-endian):
 *   [type:u8][streamId:u32][payload:...]
 *
 * Message types:
 *   0x01 CONNECT  — client→relay: open TCP stream (payload = host\0 + port:u16)
 *   0x02 DATA     — bidirectional: stream data
 *   0x03 CONTINUE — relay→client: flow control (payload = buffer_remaining:u32)
 *   0x04 CLOSE    — bidirectional: close stream (payload = reason:u8)
 *   0x05 INFO     — relay→client: server info (WISP v2 extension)
 *
 * Can be used standalone for tunneling or as the backing transport for
 * clawser-wisp-transport.mjs (WSH adapter).
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-wisp.test.mjs
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** WISP frame types */
export const WISP_CONNECT  = 0x01
export const WISP_DATA     = 0x02
export const WISP_CONTINUE = 0x03
export const WISP_CLOSE    = 0x04
export const WISP_INFO     = 0x05

/** Close reasons */
export const CLOSE_REASON_NORMAL     = 0x00
export const CLOSE_REASON_REFUSED    = 0x01
export const CLOSE_REASON_THROTTLED  = 0x02
export const CLOSE_REASON_UNREACHABLE = 0x03
export const CLOSE_REASON_TIMEOUT    = 0x04
export const CLOSE_REASON_ERROR      = 0x05

/** Client states */
const STATES = Object.freeze(['disconnected', 'connecting', 'connected', 'closing', 'closed'])

/** Valid event names for WispClient */
const CLIENT_EVENTS = Object.freeze(['open', 'close', 'error', 'reconnect', 'info'])

/** Valid event names for WispStream */
const STREAM_EVENTS = Object.freeze(['data', 'close', 'error', 'continue'])

// ---------------------------------------------------------------------------
// Frame encoding / decoding
// ---------------------------------------------------------------------------

/**
 * Encode a WISP frame.
 *
 * @example
 *   const frame = encodeFrame(WISP_DATA, 42, new Uint8Array([1, 2, 3]))
 *
 * @param {number} type - Frame type byte
 * @param {number} streamId - 32-bit stream ID
 * @param {Uint8Array} [payload] - Optional payload bytes
 * @returns {Uint8Array}
 */
export const encodeFrame = (type, streamId, payload) => {
  const payloadLen = payload ? payload.byteLength : 0
  const buf = new Uint8Array(5 + payloadLen)
  const view = new DataView(buf.buffer)
  view.setUint8(0, type)
  view.setUint32(1, streamId, true) // little-endian
  if (payload) buf.set(payload, 5)
  return buf
}

/**
 * Decode a WISP frame from binary data.
 *
 * @example
 *   const { type, streamId, payload } = decodeFrame(data)
 *
 * @param {ArrayBuffer|Uint8Array} data - Raw frame bytes
 * @returns {{ type: number, streamId: number, payload: Uint8Array }}
 */
export const decodeFrame = (data) => {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.byteLength < 5) throw new Error('WISP frame too short')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const type = view.getUint8(0)
  const streamId = view.getUint32(1, true)
  const payload = bytes.slice(5)
  return { type, streamId, payload }
}

/**
 * Encode a CONNECT payload: host (null-terminated UTF-8) + port (u16 LE).
 *
 * @param {string} host
 * @param {number} port
 * @returns {Uint8Array}
 */
export const encodeConnectPayload = (host, port) => {
  const encoder = new TextEncoder()
  const hostBytes = encoder.encode(host)
  const buf = new Uint8Array(hostBytes.byteLength + 1 + 2)
  buf.set(hostBytes, 0)
  buf[hostBytes.byteLength] = 0x00 // null terminator
  const view = new DataView(buf.buffer)
  view.setUint16(hostBytes.byteLength + 1, port, true)
  return buf
}

/**
 * Decode a CONNECT payload.
 *
 * @param {Uint8Array} payload
 * @returns {{ host: string, port: number }}
 */
export const decodeConnectPayload = (payload) => {
  const nullIdx = payload.indexOf(0x00)
  if (nullIdx === -1) throw new Error('Invalid CONNECT payload: no null terminator')
  const decoder = new TextDecoder()
  const host = decoder.decode(payload.slice(0, nullIdx))
  const view = new DataView(payload.buffer, payload.byteOffset + nullIdx + 1, 2)
  const port = view.getUint16(0, true)
  return { host, port }
}

// ---------------------------------------------------------------------------
// WispStream
// ---------------------------------------------------------------------------

/**
 * A single multiplexed TCP stream within a WISP connection.
 *
 * @example
 *   const stream = await client.connect('example.com', 80)
 *   stream.onData((data) => console.log('received', data))
 *   stream.write(new TextEncoder().encode('GET / HTTP/1.0\r\n\r\n'))
 *   stream.close()
 */
export class WispStream {
  /** @type {number} */
  #id

  /** @type {string} */
  #host

  /** @type {number} */
  #port

  /** @type {boolean} */
  #closed = false

  /** @type {number} */
  #bufferRemaining = 0

  /** @type {Uint8Array[]} */
  #writeQueue = []

  /** @type {Function|null} */
  #sendFrame

  /** @type {{ data: Function[], close: Function[], error: Function[], continue: Function[] }} */
  #callbacks = { data: [], close: [], error: [], continue: [] }

  /**
   * @param {number} id - Stream ID
   * @param {string} host - Target host
   * @param {number} port - Target port
   * @param {Function} sendFrame - Callback to send frames via the parent client
   */
  constructor(id, host, port, sendFrame) {
    this.#id = id
    this.#host = host
    this.#port = port
    this.#sendFrame = sendFrame
  }

  /** Stream ID. */
  get id() { return this.#id }

  /** Target host. */
  get host() { return this.#host }

  /** Target port. */
  get port() { return this.#port }

  /** Whether the stream has been closed. */
  get closed() { return this.#closed }

  /** Remaining buffer space reported by relay. */
  get bufferRemaining() { return this.#bufferRemaining }

  /**
   * Write data to the stream.
   *
   * @example
   *   stream.write(new TextEncoder().encode('hello'))
   *   stream.write(new Uint8Array([0x01, 0x02]))
   *
   * @param {Uint8Array|ArrayBuffer|string} data
   */
  write(data) {
    if (this.#closed) throw new Error(`Stream ${this.#id} is closed`)
    let bytes
    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data)
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else {
      bytes = data
    }
    this.#sendFrame(encodeFrame(WISP_DATA, this.#id, bytes))
  }

  /**
   * Register callback for incoming data.
   * @param {(data: Uint8Array) => void} cb
   */
  onData(cb) { this.#callbacks.data.push(cb) }

  /**
   * Register callback for stream close.
   * @param {(reason: number) => void} cb
   */
  onClose(cb) { this.#callbacks.close.push(cb) }

  /**
   * Register callback for stream errors.
   * @param {(err: Error) => void} cb
   */
  onError(cb) { this.#callbacks.error.push(cb) }

  /**
   * Register callback for CONTINUE (flow control) messages.
   * @param {(bufferRemaining: number) => void} cb
   */
  onContinue(cb) { this.#callbacks.continue.push(cb) }

  /**
   * Close the stream gracefully.
   * @param {number} [reason=CLOSE_REASON_NORMAL]
   */
  close(reason = CLOSE_REASON_NORMAL) {
    if (this.#closed) return
    this.#closed = true
    const payload = new Uint8Array([reason])
    this.#sendFrame(encodeFrame(WISP_CLOSE, this.#id, payload))
    this._fireEvent('close', reason)
  }

  // -- Internal methods (called by WispClient) --------------------------------

  /**
   * Handle incoming DATA frame.
   * @param {Uint8Array} payload
   * @internal
   */
  _handleData(payload) {
    if (this.#closed) return
    this._fireEvent('data', payload)
  }

  /**
   * Handle incoming CONTINUE frame.
   * @param {Uint8Array} payload
   * @internal
   */
  _handleContinue(payload) {
    if (payload.byteLength >= 4) {
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
      this.#bufferRemaining = view.getUint32(0, true)
    }
    this._fireEvent('continue', this.#bufferRemaining)

    // flush write queue if buffer space available
    while (this.#writeQueue.length > 0 && this.#bufferRemaining > 0) {
      const queued = this.#writeQueue.shift()
      this.#sendFrame(encodeFrame(WISP_DATA, this.#id, queued))
      this.#bufferRemaining--
    }
  }

  /**
   * Handle remote close.
   * @param {number} reason
   * @internal
   */
  _handleClose(reason) {
    this.#closed = true
    this.#sendFrame = () => {} // no-op after close
    this._fireEvent('close', reason)
  }

  /**
   * Force-close without sending a frame (used during disconnect).
   * @internal
   */
  _forceClose() {
    this.#closed = true
    this.#sendFrame = () => {}
    this._fireEvent('close', CLOSE_REASON_ERROR)
  }

  /**
   * Fire all callbacks for a given event.
   * @param {string} event
   * @param {*} [data]
   */
  _fireEvent(event, data) {
    for (const cb of this.#callbacks[event] || []) {
      try { cb(data) } catch (e) { silentCatch('clawser-wisp', 'swallow-listener-errors', e) }
    }
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.#id,
      host: this.#host,
      port: this.#port,
      closed: this.#closed,
      bufferRemaining: this.#bufferRemaining,
    }
  }
}

// ---------------------------------------------------------------------------
// WispClient
// ---------------------------------------------------------------------------

/**
 * WISP client — connects to a relay server and multiplexes TCP streams.
 *
 * @example
 *   const client = new WispClient({
 *     url: 'wss://wisp-relay.example.com/',
 *     _WebSocket: MockWebSocket, // for testing
 *   })
 *   await client.connect()
 *
 *   const stream = await client.open('httpbin.org', 80)
 *   stream.onData((data) => console.log(new TextDecoder().decode(data)))
 *   stream.write(new TextEncoder().encode('GET / HTTP/1.0\r\nHost: httpbin.org\r\n\r\n'))
 */
export class WispClient {
  /** @type {string} */
  #url

  /** @type {string} */
  #state = 'disconnected'

  /** @type {object|null} */
  #ws = null

  /** @type {Function} */
  #WebSocketCtor

  /** @type {boolean} */
  #reconnect

  /** @type {number} */
  #maxReconnectAttempts

  /** @type {number} */
  #reconnectDelayMs

  /** @type {number} */
  #reconnectAttempts = 0

  /** @type {boolean} */
  #userClosed = false

  /** @type {number} */
  #nextStreamId = 1

  /** @type {Map<number, WispStream>} */
  #streams = new Map()

  /** @type {{ open: Function[], close: Function[], error: Function[], reconnect: Function[], info: Function[] }} */
  #callbacks = { open: [], close: [], error: [], reconnect: [], info: [] }

  /** @type {{ messagesSent: number, messagesReceived: number, bytesIn: number, bytesOut: number, reconnects: number, streamsOpened: number, streamsClosed: number }} */
  #stats = {
    messagesSent: 0,
    messagesReceived: 0,
    bytesIn: 0,
    bytesOut: 0,
    reconnects: 0,
    streamsOpened: 0,
    streamsClosed: 0,
  }

  /** @type {object|null} */
  #serverInfo = null

  /**
   * @param {object} opts
   * @param {string} opts.url - WISP relay WebSocket URL
   * @param {boolean} [opts.reconnect=true] - Enable auto-reconnect
   * @param {number} [opts.maxReconnectAttempts=5] - Max reconnection attempts
   * @param {number} [opts.reconnectDelayMs=1000] - Base delay between reconnects
   * @param {Function} [opts._WebSocket] - Injectable WebSocket constructor (for testing)
   */
  constructor(opts = {}) {
    if (!opts.url) throw new Error('url is required')
    this.#url = opts.url
    this.#reconnect = opts.reconnect !== undefined ? opts.reconnect : true
    this.#maxReconnectAttempts = opts.maxReconnectAttempts ?? 5
    this.#reconnectDelayMs = opts.reconnectDelayMs ?? 1000
    this.#WebSocketCtor = opts._WebSocket || globalThis.WebSocket
  }

  // -- Getters ---------------------------------------------------------------

  /** WISP relay URL. */
  get url() { return this.#url }

  /** Current connection state. */
  get state() { return this.#state }

  /** True when client is connected. */
  get connected() { return this.#state === 'connected' }

  /** Number of active (non-closed) streams. */
  get activeStreams() { return this.#streams.size }

  /** Reconnection attempts since last successful connect. */
  get reconnectAttempts() { return this.#reconnectAttempts }

  /** Whether auto-reconnect is enabled. */
  get reconnectEnabled() { return this.#reconnect }

  /** Server info received from relay (WISP v2). */
  get serverInfo() { return this.#serverInfo }

  // -- Public API ------------------------------------------------------------

  /**
   * Connect to the WISP relay server.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.#state === 'connected' || this.#state === 'connecting') {
      throw new Error('Already connected or connecting')
    }
    this.#userClosed = false
    this.#state = 'connecting'

    return new Promise((resolve, reject) => {
      try {
        this.#ws = new this.#WebSocketCtor(this.#url)
        if (this.#ws.binaryType !== undefined) {
          this.#ws.binaryType = 'arraybuffer'
        }
      } catch (err) {
        this.#state = 'disconnected'
        return reject(err)
      }

      const onOpen = () => {
        cleanup()
        this.#state = 'connected'
        this.#reconnectAttempts = 0
        this.#ws.addEventListener('message', this.#onMessage)
        this.#ws.addEventListener('close', this.#onClose)
        this.#ws.addEventListener('error', this.#onError)
        this._fireEvent('open')
        resolve()
      }

      const onError = (err) => {
        cleanup()
        this.#state = 'disconnected'
        this._fireEvent('error', err)
        reject(err instanceof Error ? err : new Error('WebSocket connection failed'))
      }

      const cleanup = () => {
        this.#ws.removeEventListener('open', onOpen)
        this.#ws.removeEventListener('error', onError)
      }

      this.#ws.addEventListener('open', onOpen)
      this.#ws.addEventListener('error', onError)
    })
  }

  /**
   * Open a new TCP stream through the WISP relay.
   *
   * @example
   *   const stream = await client.open('example.com', 443)
   *
   * @param {string} host - Target hostname
   * @param {number} port - Target port (1-65535)
   * @returns {WispStream}
   */
  open(host, port) {
    if (!this.connected) throw new Error('Not connected')
    if (!host || typeof host !== 'string') throw new Error('host is required')
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('port must be an integer between 1 and 65535')
    }

    const streamId = this.#nextStreamId++
    const sendFrame = (frame) => this.#sendRaw(frame)
    const stream = new WispStream(streamId, host, port, sendFrame)
    this.#streams.set(streamId, stream)
    this.#stats.streamsOpened++

    // send CONNECT frame
    const payload = encodeConnectPayload(host, port)
    this.#sendRaw(encodeFrame(WISP_CONNECT, streamId, payload))

    return stream
  }

  /**
   * Close the client and all active streams.
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#state === 'closed' || this.#state === 'disconnected') return
    this.#userClosed = true
    this.#state = 'closing'

    // close all streams
    for (const stream of this.#streams.values()) {
      if (!stream.closed) {
        stream._forceClose()
        this.#stats.streamsClosed++
      }
    }
    this.#streams.clear()

    if (this.#ws) {
      return new Promise((resolve) => {
        const onClose = () => {
          this.#ws.removeEventListener('close', onClose)
          this.#state = 'closed'
          this._fireEvent('close')
          resolve()
        }
        this.#ws.addEventListener('close', onClose)
        this.#ws.removeEventListener('close', this.#onClose)
        this.#ws.close(1000, 'client shutdown')
      })
    }
    this.#state = 'closed'
    this._fireEvent('close')
  }

  /**
   * Get a stream by ID.
   * @param {number} streamId
   * @returns {WispStream|undefined}
   */
  getStream(streamId) {
    return this.#streams.get(streamId)
  }

  /**
   * Register an event listener.
   * @param {string} event - One of: 'open', 'close', 'error', 'reconnect', 'info'
   * @param {Function} cb
   */
  on(event, cb) {
    if (!CLIENT_EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`)
    this.#callbacks[event].push(cb)
  }

  /**
   * Get client statistics.
   * @returns {object}
   */
  getStats() {
    return { ...this.#stats }
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      url: this.#url,
      state: this.#state,
      activeStreams: this.#streams.size,
      reconnectAttempts: this.#reconnectAttempts,
      stats: this.getStats(),
      serverInfo: this.#serverInfo,
    }
  }

  // -- Internal event handlers (arrow fns for stable `this`) -----------------

  /** @type {(ev: { data: * }) => void} */
  #onMessage = (ev) => {
    const raw = ev.data
    this.#stats.messagesReceived++

    let bytes
    if (raw instanceof ArrayBuffer) {
      bytes = new Uint8Array(raw)
    } else if (raw instanceof Uint8Array) {
      bytes = raw
    } else {
      // unexpected text frame — ignore
      return
    }

    this.#stats.bytesIn += bytes.byteLength

    let frame
    try {
      frame = decodeFrame(bytes)
    } catch {
      this._fireEvent('error', new Error('Malformed WISP frame'))
      return
    }

    const { type, streamId, payload } = frame

    switch (type) {
      case WISP_DATA: {
        const stream = this.#streams.get(streamId)
        if (stream) stream._handleData(payload)
        break
      }
      case WISP_CONTINUE: {
        const stream = this.#streams.get(streamId)
        if (stream) stream._handleContinue(payload)
        break
      }
      case WISP_CLOSE: {
        const stream = this.#streams.get(streamId)
        if (stream) {
          const reason = payload.byteLength > 0 ? payload[0] : CLOSE_REASON_NORMAL
          stream._handleClose(reason)
          this.#streams.delete(streamId)
          this.#stats.streamsClosed++
        }
        break
      }
      case WISP_INFO: {
        try {
          const decoder = new TextDecoder()
          this.#serverInfo = JSON.parse(decoder.decode(payload))
          this._fireEvent('info', this.#serverInfo)
        } catch {
          // non-JSON info — store raw
          this.#serverInfo = payload
          this._fireEvent('info', payload)
        }
        break
      }
      default:
        // Unknown frame type — ignore for forward compatibility
        break
    }
  }

  /** @type {(ev: *) => void} */
  #onClose = (ev) => {
    // force-close all active streams
    for (const stream of this.#streams.values()) {
      if (!stream.closed) {
        stream._forceClose()
        this.#stats.streamsClosed++
      }
    }
    this.#streams.clear()

    if (this.#userClosed) {
      this.#state = 'closed'
      this._fireEvent('close', ev)
      return
    }

    this.#state = 'disconnected'
    this._fireEvent('close', ev)
    if (this.#reconnect) {
      this._handleReconnect()
    }
  }

  /** @type {(err: *) => void} */
  #onError = (err) => {
    this._fireEvent('error', err)
  }

  // -- Internal methods ------------------------------------------------------

  /**
   * Send raw bytes over the WebSocket.
   * @param {Uint8Array} data
   */
  #sendRaw(data) {
    if (!this.connected || !this.#ws) throw new Error('Not connected')
    this.#ws.send(data)
    this.#stats.messagesSent++
    this.#stats.bytesOut += data.byteLength
  }

  /**
   * Attempt reconnection with exponential backoff.
   */
  async _handleReconnect() {
    if (this.#reconnectAttempts >= this.#maxReconnectAttempts) return

    this.#reconnectAttempts++
    this.#stats.reconnects++
    this._fireEvent('reconnect', { attempt: this.#reconnectAttempts })

    const delay = this.#reconnectDelayMs * Math.pow(2, this.#reconnectAttempts - 1)
    await new Promise(r => setTimeout(r, delay))

    if (this.#userClosed) return

    try {
      await this.connect()
    } catch {
      if (this.#reconnect && this.#reconnectAttempts < this.#maxReconnectAttempts) {
        this._handleReconnect()
      }
    }
  }

  /**
   * Fire all callbacks for a given event.
   * @param {string} event
   * @param {*} [data]
   */
  _fireEvent(event, data) {
    for (const cb of this.#callbacks[event] || []) {
      try { cb(data) } catch (e) { silentCatch('clawser-wisp', 'swallow-listener-errors', e) }
    }
  }
}
