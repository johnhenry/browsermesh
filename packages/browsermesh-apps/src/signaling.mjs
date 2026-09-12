/**
 * signaling.mjs -- MeshSignalingChannel: WebRTC offer/answer/ICE relay.
 *
 * `webrtc-negotiator.mjs`'s adapter factory needs some way to hand an SDP
 * offer to a remote peer and get an SDP answer (and ICE candidates) back,
 * before the WebRTC connection itself exists to carry that traffic. That
 * bootstrap channel is "signaling", and WebRTC deliberately doesn't specify
 * one -- it's left to the application.
 *
 * Rather than adopting `browsermesh-core`'s `SignalingClient` (needs an
 * external WebSocket signaling server that isn't implemented anywhere in
 * this repo) or `browsermesh-transport/websocket.mjs`'s separate
 * `WebRTCTransport`/`TransportFactory` pair (same requirement, and not the
 * implementation the real `test/real-peer/` suite exercises), this is a
 * small, new, transport-agnostic relay: it wraps whatever bidirectional bus
 * is already in hand and speaks exactly three message shapes over it --
 * `{type: 'webrtc-offer'|'webrtc-answer'|'webrtc-ice', from, to, payload}`.
 *
 * The injected `transport` only needs to implement `send(msg)` and
 * `onMessage(cb)` (optionally `open()`/`close()`) -- the same minimal shape
 * `browsermesh-pod`'s `EventEmitterTransport` already exposes, and the shape
 * `createBroadcastChannelSignalingTransport()` below adapts a real
 * `BroadcastChannel` to. Messages not addressed to this channel's
 * `localPodId` (or echoed from itself) are ignored, so many peers can safely
 * share one broadcast-style bus -- exactly how BroadcastChannel and the
 * existing Pod example's `EventEmitterTransport` bus already work in this
 * repo.
 *
 * No browser-only imports at module level.
 */

/** @type {readonly string[]} */
const SIGNAL_TYPES = Object.freeze(['webrtc-offer', 'webrtc-answer', 'webrtc-ice'])

// ---------------------------------------------------------------------------
// MeshSignalingChannel
// ---------------------------------------------------------------------------

/**
 * Relays WebRTC offer/answer/ICE-candidate messages between peers over an
 * injectable transport.
 */
export class MeshSignalingChannel {
  /** @type {string} */
  #localPodId

  /** @type {{send: Function, onMessage: Function, open?: Function, close?: Function}} */
  #transport

  /** @type {Function} */
  #onLog

  /** @type {Record<string, Set<Function>>} */
  #listeners

  /** @type {boolean} */
  #opened = false

  /**
   * @param {object} opts
   * @param {string} opts.localPodId - This node's pod identifier; messages
   *   not addressed to this id (`msg.to !== localPodId`) are ignored.
   * @param {{send: Function, onMessage: Function, open?: Function, close?: Function}} opts.transport
   *   Injectable bidirectional bus. Must implement `send(msg)` and
   *   `onMessage(cb)`. `open()`/`close()` are called if present.
   * @param {Function} [opts.onLog]
   */
  constructor({ localPodId, transport, onLog } = {}) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string')
    }
    if (!transport || typeof transport.send !== 'function') {
      throw new Error('transport is required and must implement send(msg)')
    }
    if (typeof transport.onMessage !== 'function') {
      throw new Error('transport is required and must implement onMessage(cb)')
    }

    this.#localPodId = localPodId
    this.#transport = transport
    this.#onLog = onLog || (() => {})
    this.#listeners = {
      'webrtc-offer': new Set(),
      'webrtc-answer': new Set(),
      'webrtc-ice': new Set(),
    }

    this.#transport.onMessage((msg) => this.#handleMessage(msg))
  }

  /** This channel's local pod identifier. */
  get localPodId() {
    return this.#localPodId
  }

  /**
   * Open the underlying transport (no-op if it has no `open()`).
   * @returns {Promise<void>}
   */
  async open() {
    if (this.#opened) return
    if (typeof this.#transport.open === 'function') {
      await this.#transport.open()
    }
    this.#opened = true
  }

  /**
   * Close the underlying transport (no-op if it has no `close()`).
   * @returns {Promise<void>}
   */
  async close() {
    if (!this.#opened) return
    if (typeof this.#transport.close === 'function') {
      await this.#transport.close()
    }
    this.#opened = false
  }

  /**
   * Send a signaling message to a specific peer.
   *
   * @param {'webrtc-offer'|'webrtc-answer'|'webrtc-ice'} type
   * @param {string} to - Target pod identifier
   * @param {*} payload - The offer/answer/candidate object
   */
  send(type, to, payload) {
    if (!SIGNAL_TYPES.includes(type)) {
      throw new Error(`Unknown signal type: ${type}`)
    }
    if (!to || typeof to !== 'string') {
      throw new Error('to is required and must be a non-empty string')
    }
    this.#transport.send({ type, from: this.#localPodId, to, payload })
  }

  /**
   * Subscribe to incoming offers. Callback receives `(fromPodId, offer)`.
   * @param {(fromPodId: string, offer: object) => void} cb
   * @returns {() => void} Unsubscribe function.
   */
  onOffer(cb) {
    return this.#on('webrtc-offer', cb)
  }

  /**
   * Subscribe to incoming answers. Callback receives `(fromPodId, answer)`.
   * @param {(fromPodId: string, answer: object) => void} cb
   * @returns {() => void} Unsubscribe function.
   */
  onAnswer(cb) {
    return this.#on('webrtc-answer', cb)
  }

  /**
   * Subscribe to incoming ICE candidates. Callback receives `(fromPodId, candidate)`.
   * @param {(fromPodId: string, candidate: object) => void} cb
   * @returns {() => void} Unsubscribe function.
   */
  onIce(cb) {
    return this.#on('webrtc-ice', cb)
  }

  // -- Internal -------------------------------------------------------------

  #on(type, cb) {
    if (typeof cb !== 'function') {
      throw new Error('callback must be a function')
    }
    this.#listeners[type].add(cb)
    return () => this.#listeners[type].delete(cb)
  }

  #handleMessage(msg) {
    if (!msg || typeof msg !== 'object') return
    if (!SIGNAL_TYPES.includes(msg.type)) return
    if (msg.to !== this.#localPodId) return // not addressed to us
    if (msg.from === this.#localPodId) return // ignore our own broadcast echo

    for (const cb of [...this.#listeners[msg.type]]) {
      try {
        cb(msg.from, msg.payload)
      } catch (err) {
        this.#onLog('signaling:listener-error', {
          type: msg.type,
          error: err?.message || String(err),
        })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// BroadcastChannel adapter
// ---------------------------------------------------------------------------

/**
 * Wrap a real `BroadcastChannel` as a `{send, onMessage, close}` transport
 * suitable for `MeshSignalingChannel`. Browser-only (throws if
 * `BroadcastChannel` is not on the global scope) -- for Node, supply a
 * different transport (e.g. an `EventEmitterTransport`-shaped bus) instead.
 *
 * @param {string} [channelName='mesh-signaling']
 * @returns {{send: Function, onMessage: Function, close: Function}}
 */
export function createBroadcastChannelSignalingTransport(channelName = 'mesh-signaling') {
  if (typeof BroadcastChannel === 'undefined') {
    throw new Error(
      'createBroadcastChannelSignalingTransport() requires a global BroadcastChannel ' +
      '(browser-only). Supply a Node-safe transport instead.',
    )
  }
  const channel = new BroadcastChannel(channelName)
  let handler = null
  channel.onmessage = (event) => {
    if (handler) handler(event.data)
  }
  return {
    send(msg) {
      channel.postMessage(msg)
    },
    onMessage(cb) {
      handler = cb
    },
    close() {
      channel.close()
    },
  }
}

export { SIGNAL_TYPES }
