/**
 * transport.mjs — Pluggable transport adapters for Pod messaging.
 *
 * A TransportAdapter is any object that provides:
 *   send(msg)          — send a message to all peers
 *   onMessage(handler) — register a message handler
 *   open()             — connect/initialize the transport
 *   close()            — disconnect/cleanup
 *   ready              — boolean, whether the transport is connected
 *
 * Three built-in implementations:
 *   BroadcastChannelTransport — browser BroadcastChannel (same-origin tabs)
 *   EventEmitterTransport     — in-process event emitter (Node.js / testing)
 *   NullTransport             — no-op (headless / disabled)
 */

// ---------------------------------------------------------------------------
// BroadcastChannelTransport
// ---------------------------------------------------------------------------

/**
 * Transport backed by the browser BroadcastChannel API.
 * Messages are delivered to all same-origin browsing contexts
 * subscribed to the same channel name.
 */
export class BroadcastChannelTransport {
  #channel = null
  #channelName
  #handler = null
  #BCConstructor

  /**
   * @param {string} channelName - BroadcastChannel name
   * @param {Function} [BCConstructor] - BroadcastChannel constructor (for testing)
   */
  constructor(channelName, BCConstructor) {
    this.#channelName = channelName
    this.#BCConstructor = BCConstructor || globalThis.BroadcastChannel
  }

  get ready() { return this.#channel !== null }

  /**
   * @param {(msg: object) => void} handler
   */
  onMessage(handler) {
    this.#handler = handler
  }

  async open() {
    if (this.#channel) return
    this.#channel = new this.#BCConstructor(this.#channelName)
    this.#channel.onmessage = (event) => {
      if (this.#handler) this.#handler(event.data)
    }
  }

  /**
   * @param {object} msg
   */
  send(msg) {
    if (!this.#channel) return
    this.#channel.postMessage(msg)
  }

  async close() {
    if (this.#channel) {
      this.#channel.close()
      this.#channel = null
    }
  }
}

// ---------------------------------------------------------------------------
// EventEmitterTransport
// ---------------------------------------------------------------------------

/**
 * In-process transport using a shared subscriber list.
 * Useful for Node.js and testing where BroadcastChannel is unavailable.
 *
 * Create a shared bus and pass it to multiple EventEmitterTransport instances
 * to simulate multi-pod communication:
 *
 *   const bus = EventEmitterTransport.createBus()
 *   const t1 = new EventEmitterTransport(bus)
 *   const t2 = new EventEmitterTransport(bus)
 */
export class EventEmitterTransport {
  #bus
  #handler = null
  #ready = false
  #boundReceiver = null

  /**
   * @param {Set<Function>} [bus] - Shared subscriber set
   */
  constructor(bus) {
    this.#bus = bus || EventEmitterTransport.createBus()
  }

  /**
   * Create a shared message bus.
   * @returns {Set<Function>}
   */
  static createBus() {
    return new Set()
  }

  get ready() { return this.#ready }
  get bus() { return this.#bus }

  /**
   * @param {(msg: object) => void} handler
   */
  onMessage(handler) {
    this.#handler = handler
  }

  async open() {
    if (this.#ready) return
    this.#boundReceiver = (msg, sender) => {
      if (sender !== this && this.#handler) {
        this.#handler(msg)
      }
    }
    this.#bus.add(this.#boundReceiver)
    this.#ready = true
  }

  /**
   * @param {object} msg
   */
  send(msg) {
    if (!this.#ready) return
    for (const receiver of this.#bus) {
      try { receiver(msg, this) } catch { /* listener errors don't crash */ }
    }
  }

  async close() {
    if (this.#boundReceiver) {
      this.#bus.delete(this.#boundReceiver)
      this.#boundReceiver = null
    }
    this.#ready = false
  }
}

// ---------------------------------------------------------------------------
// NullTransport
// ---------------------------------------------------------------------------

/**
 * No-op transport. Messages are silently dropped.
 * Used when no transport is available or desired.
 */
export class NullTransport {
  get ready() { return true }
  onMessage(_handler) {}
  async open() {}
  send(_msg) {}
  async close() {}
}
