/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-webtransport.js -- WebTransport transport bridge.
 *
 * Extends MeshTransport with WebTransport API support. Provides
 * datagram and bidirectional stream communication. Falls back gracefully
 * when WebTransport is unavailable.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-webtransport.test.mjs
 */

import { MeshTransport } from './transport.mjs'
import { silentCatch } from './silent-catch.mjs'

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

/**
 * Check if the WebTransport API is available.
 * @returns {boolean}
 */
export function supportsWebTransport() {
  return typeof WebTransport !== 'undefined'
}

// ---------------------------------------------------------------------------
// WebTransportBridge
// ---------------------------------------------------------------------------

/**
 * WebTransport-based mesh transport.
 * Uses datagrams for small messages and bidirectional streams for larger data.
 */
export class WebTransportBridge extends MeshTransport {
  /** @type {WebTransport|null} */
  #transport = null

  /** @type {WritableStreamDefaultWriter|null} */
  #writer = null

  /** @type {Map<string, { readable: ReadableStream, writable: WritableStream }>} */
  #streams = new Map()

  /** @type {string|null} */
  #url = null

  /** @type {boolean} */
  #closed = false

  constructor() {
    super('wsh-wt')
  }

  /**
   * Connect to a WebTransport server.
   * @param {string} url - wss:// or https:// URL
   * @param {object} [opts]
   * @returns {Promise<void>}
   */
  async connect(url, opts = {}) {
    if (this.connected) throw new Error('Already connected')
    this.#url = url
    this._setState('connecting')

    try {
      this.#transport = new WebTransport(url)
      await this.#transport.ready
      this.#writer = this.#transport.datagrams.writable.getWriter()
      this._setState('connected')

      // Read incoming datagrams
      this.#readDatagrams()

      // Handle incoming bidirectional streams
      this.#acceptStreams()

      // Handle close
      this.#transport.closed.then(() => {
        if (!this.#closed) this.close()
      }).catch(() => {
        if (!this.#closed) {
          this._fire('error', new Error('Transport closed unexpectedly'))
          this.close()
        }
      })
    } catch (err) {
      this._setState('disconnected')
      throw err
    }
  }

  /**
   * Send data via datagram.
   * @param {*} data - Will be encoded as UTF-8 if string, or sent as-is if Uint8Array
   */
  send(data) {
    if (!this.connected) throw new Error('Not connected')
    const bytes = typeof data === 'string'
      ? new TextEncoder().encode(data)
      : (data instanceof Uint8Array ? data : new TextEncoder().encode(JSON.stringify(data)))
    this.#writer.write(bytes)
  }

  /**
   * Open a named bidirectional stream.
   * @param {string} id - Stream identifier
   * @returns {Promise<{ readable: ReadableStream, writable: WritableStream }>}
   */
  async openStream(id) {
    if (!this.connected) throw new Error('Not connected')
    const bidi = await this.#transport.createBidirectionalStream()
    this.#streams.set(id, { readable: bidi.readable, writable: bidi.writable })
    this._fire('stream', { id, readable: bidi.readable, writable: bidi.writable })
    return { readable: bidi.readable, writable: bidi.writable }
  }

  /**
   * Close the transport and all streams.
   */
  close() {
    if (this.#closed) return
    this.#closed = true
    this._setState('closing')
    this.#streams.clear()
    if (this.#writer) {
      try { this.#writer.close() } catch (e) { silentCatch('clawser-mesh-webtransport', 'this', e) }
      this.#writer = null
    }
    if (this.#transport) {
      try { this.#transport.close() } catch (e) { silentCatch('clawser-mesh-webtransport', 'this', e) }
      this.#transport = null
    }
    this._setState('closed')
  }

  /** Number of currently tracked streams. */
  get streamCount() { return this.#streams.size }

  /** The URL this transport is connected to. */
  get url() { return this.#url }

  // -- Private helpers ------------------------------------------------------

  /**
   * Read datagrams loop. Runs until the transport is closed or the
   * datagram readable stream ends.
   */
  async #readDatagrams() {
    try {
      const reader = this.#transport.datagrams.readable.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done || this.#closed) break
        const decoded = new TextDecoder().decode(value)
        try {
          this._fire('message', JSON.parse(decoded))
        } catch {
          this._fire('message', decoded)
        }
      }
    } catch {
      // Transport closed or errored — no action needed
    }
  }

  /**
   * Accept incoming bidirectional streams and fire 'stream' events.
   */
  async #acceptStreams() {
    try {
      const reader = this.#transport.incomingBidirectionalStreams.getReader()
      while (true) {
        const { value, done } = await reader.read()
        if (done || this.#closed) break
        const id = `incoming_${this.#streams.size}`
        this.#streams.set(id, { readable: value.readable, writable: value.writable })
        this._fire('stream', { id, readable: value.readable, writable: value.writable })
      }
    } catch {
      // Transport closed or errored — no action needed
    }
  }
}

// ---------------------------------------------------------------------------
// WebTransportAdapterFactory
// ---------------------------------------------------------------------------

/**
 * Factory for creating WebTransport transports.
 * Can be registered with MeshTransportNegotiator.
 */
export class WebTransportAdapterFactory {
  /**
   * Whether this factory handles the given transport type.
   * @param {string} type
   * @returns {boolean}
   */
  canCreate(type) { return type === 'wsh-wt' }

  /**
   * Create a new WebTransportBridge (not yet connected).
   * Caller must call bridge.connect(url, opts).
   * @param {string} url
   * @param {object} [opts]
   * @returns {WebTransportBridge}
   */
  create(url, opts) {
    const bridge = new WebTransportBridge()
    return bridge
  }
}
