/**
 * clawser-wisp-transport.mjs -- WISP Transport Adapter for WSH.
 *
 * Adapts a WispClient as a mesh transport that can carry WSH protocol
 * messages through a WISP relay tunnel. WSH commands are serialized
 * and sent over a dedicated control stream; additional streams can be
 * opened for data transfer, RPC, or mesh relay connections.
 *
 * Implements the same interface as WebSocketTransport from
 * clawser-mesh-websocket.js so it can be used interchangeably.
 *
 * Standalone uses beyond WSH:
 *   - Exposing RPC mode over a tunneled port
 *   - Mesh relay connections through restrictive networks
 *   - Future v86 guest networking
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-wisp-transport.test.mjs
 */

import { WispClient, WispStream, WISP_DATA } from './wisp-client.mjs'
import { silentCatch } from './silent-catch.mjs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default control stream port (WSH protocol) */
const WSH_CONTROL_PORT = 9083

/** Valid events */
const EVENTS = Object.freeze(['open', 'message', 'close', 'error', 'reconnect', 'stream'])

// ---------------------------------------------------------------------------
// WispTransport
// ---------------------------------------------------------------------------

/**
 * WISP-backed mesh transport.
 *
 * Wraps a WispClient to present the same interface as WebSocketTransport.
 * A control stream carries WSH messages; additional streams can be opened
 * for side-channel data (file transfers, RPC tunnels, etc.).
 *
 * @example
 *   const transport = new WispTransport({
 *     url: 'wss://wisp-relay.example.com/',
 *     targetHost: 'my-server.local',
 *     targetPort: 9083,
 *   })
 *   await transport.connect()
 *   transport.send(wshMessage)
 *   transport.on('message', (data) => handleWshMessage(data))
 *
 * @example
 *   // Open additional streams for data transfer
 *   const dataStream = transport.openStream('data-host.local', 8080)
 *   dataStream.write(payload)
 */
export class WispTransport {
  /** @type {string} */
  #url

  /** @type {string} */
  #targetHost

  /** @type {number} */
  #targetPort

  /** @type {WispClient|null} */
  #client = null

  /** @type {WispStream|null} */
  #controlStream = null

  /** @type {string} */
  #state = 'disconnected'

  /** @type {boolean} */
  #reconnect

  /** @type {number} */
  #maxReconnectAttempts

  /** @type {number} */
  #reconnectDelayMs

  /** @type {Function} */
  #WebSocketCtor

  /** @type {{ open: Function[], message: Function[], close: Function[], error: Function[], reconnect: Function[], stream: Function[] }} */
  #callbacks = { open: [], message: [], close: [], error: [], reconnect: [], stream: [] }

  /** @type {{ messagesSent: number, messagesReceived: number, bytesIn: number, bytesOut: number, reconnects: number }} */
  #stats = { messagesSent: 0, messagesReceived: 0, bytesIn: 0, bytesOut: 0, reconnects: 0 }

  /**
   * @param {object} opts
   * @param {string} opts.url - WISP relay WebSocket URL
   * @param {string} [opts.targetHost='localhost'] - Target host for the WSH control stream
   * @param {number} [opts.targetPort=9083] - Target port for the WSH control stream
   * @param {boolean} [opts.reconnect=true] - Enable auto-reconnect
   * @param {number} [opts.maxReconnectAttempts=5] - Max reconnection attempts
   * @param {number} [opts.reconnectDelayMs=1000] - Base delay between reconnects
   * @param {Function} [opts._WebSocket] - Injectable WebSocket constructor (for testing)
   * @param {Function} [opts._WispClient] - Injectable WispClient constructor (for testing)
   */
  constructor(opts = {}) {
    if (!opts.url) throw new Error('url is required')
    this.#url = opts.url
    this.#targetHost = opts.targetHost || 'localhost'
    this.#targetPort = opts.targetPort || WSH_CONTROL_PORT
    this.#reconnect = opts.reconnect !== undefined ? opts.reconnect : true
    this.#maxReconnectAttempts = opts.maxReconnectAttempts ?? 5
    this.#reconnectDelayMs = opts.reconnectDelayMs ?? 1000
    this.#WebSocketCtor = opts._WebSocket || globalThis.WebSocket

    // Allow injecting a custom WispClient for testing
    if (opts._WispClient) {
      /** @type {Function} */
      this._WispClientCtor = opts._WispClient
    }
  }

  // -- Getters ---------------------------------------------------------------

  /** Transport type identifier. */
  get type() { return 'wisp' }

  /** Current connection state. */
  get state() { return this.#state }

  /** True when transport is connected. */
  get connected() { return this.#state === 'connected' }

  /** WISP relay URL. */
  get url() { return this.#url }

  /** Target host for the control stream. */
  get targetHost() { return this.#targetHost }

  /** Target port for the control stream. */
  get targetPort() { return this.#targetPort }

  /** The underlying WispClient instance. */
  get client() { return this.#client }

  /** Whether auto-reconnect is enabled. */
  get reconnectEnabled() { return this.#reconnect }

  // -- Public API ------------------------------------------------------------

  /**
   * Connect to the WISP relay and open the control stream.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this.#state === 'connected' || this.#state === 'connecting') {
      throw new Error('Already connected or connecting')
    }
    this.#state = 'connecting'

    try {
      const ClientCtor = this._WispClientCtor || WispClient
      this.#client = new ClientCtor({
        url: this.#url,
        reconnect: false, // we handle reconnection at this layer
        _WebSocket: this.#WebSocketCtor,
      })

      this.#client.on('error', (err) => this._fireEvent('error', err))
      this.#client.on('close', () => this.#handleClientClose())

      await this.#client.connect()

      // open the WSH control stream
      this.#controlStream = this.#client.open(this.#targetHost, this.#targetPort)
      this.#controlStream.onData((data) => {
        this.#stats.messagesReceived++
        this.#stats.bytesIn += data.byteLength
        this._fireEvent('message', data)
      })
      this.#controlStream.onClose((reason) => {
        // control stream closed — treat as transport close
        if (this.#state === 'connected') {
          this.#handleClientClose()
        }
      })
      this.#controlStream.onError((err) => this._fireEvent('error', err))

      this.#state = 'connected'
      this._fireEvent('open')
    } catch (err) {
      this.#state = 'disconnected'
      this._fireEvent('error', err)
      throw err
    }
  }

  /**
   * Send data over the WSH control stream.
   *
   * @param {Uint8Array|ArrayBuffer|string} data
   */
  send(data) {
    if (!this.connected) throw new Error('Not connected')
    if (!this.#controlStream || this.#controlStream.closed) {
      throw new Error('Control stream is closed')
    }
    let bytes
    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data)
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else {
      bytes = data
    }
    this.#controlStream.write(bytes)
    this.#stats.messagesSent++
    this.#stats.bytesOut += bytes.byteLength
  }

  /**
   * Open an additional stream through the WISP relay.
   * Useful for side-channel data: file transfers, RPC tunnels, etc.
   *
   * @example
   *   const rpcStream = transport.openStream('rpc-server.local', 5000)
   *
   * @param {string} host - Target host
   * @param {number} port - Target port
   * @returns {WispStream}
   */
  openStream(host, port) {
    if (!this.connected || !this.#client) throw new Error('Not connected')
    const stream = this.#client.open(host, port)
    this._fireEvent('stream', stream)
    return stream
  }

  /**
   * Close the transport and underlying WISP client.
   * @param {number} [code]
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async close(code, reason) {
    if (this.#state === 'closed' || this.#state === 'disconnected') return
    this.#state = 'closing'

    if (this.#client) {
      await this.#client.close()
    }
    this.#controlStream = null
    this.#state = 'closed'
    this._fireEvent('close')
  }

  /**
   * Register an event listener.
   * @param {string} event - One of: 'open', 'message', 'close', 'error', 'reconnect', 'stream'
   * @param {Function} cb
   */
  on(event, cb) {
    if (!EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`)
    this.#callbacks[event].push(cb)
  }

  /**
   * Get transport statistics.
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
      type: this.type,
      state: this.#state,
      url: this.#url,
      targetHost: this.#targetHost,
      targetPort: this.#targetPort,
      stats: this.getStats(),
      clientInfo: this.#client ? this.#client.toJSON() : null,
    }
  }

  // -- Internal methods ------------------------------------------------------

  /**
   * Handle underlying client disconnect.
   */
  #handleClientClose() {
    if (this.#state === 'closing' || this.#state === 'closed') return

    this.#controlStream = null
    this.#state = 'disconnected'
    this._fireEvent('close')

    if (this.#reconnect) {
      this.#attemptReconnect()
    }
  }

  /** @type {number} */
  #reconnectAttempts = 0

  /**
   * Attempt reconnection with exponential backoff.
   */
  async #attemptReconnect() {
    if (this.#reconnectAttempts >= this.#maxReconnectAttempts) return

    this.#reconnectAttempts++
    this.#stats.reconnects++
    this._fireEvent('reconnect', { attempt: this.#reconnectAttempts })

    const delay = this.#reconnectDelayMs * Math.pow(2, this.#reconnectAttempts - 1)
    await new Promise(r => setTimeout(r, delay))

    if (this.#state === 'closing' || this.#state === 'closed') return

    try {
      await this.connect()
      this.#reconnectAttempts = 0
    } catch {
      if (this.#reconnect && this.#reconnectAttempts < this.#maxReconnectAttempts) {
        this.#attemptReconnect()
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
      try { cb(data) } catch (e) { silentCatch('clawser-wisp-transport', 'swallow-listener-errors', e) }
    }
  }
}
