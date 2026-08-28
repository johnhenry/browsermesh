/**
 * discovery.mjs — Pluggable discovery adapters for Pod peer discovery.
 *
 * A DiscoveryAdapter uses a TransportAdapter to announce this pod and
 * discover peers. It filters discovery-related messages (hello/ack/goodbye)
 * from the transport stream.
 *
 * Two built-in implementations:
 *   TransportDiscovery — runs the hello/ack/goodbye protocol over any transport
 *   NullDiscovery      — no-op (discovery disabled)
 */

import {
  POD_HELLO, POD_HELLO_ACK, POD_GOODBYE,
  createHello, createHelloAck, createGoodbye,
} from './messages.mjs'

// ---------------------------------------------------------------------------
// TransportDiscovery
// ---------------------------------------------------------------------------

/**
 * Discovery protocol that runs over any TransportAdapter.
 * Sends hello/ack/goodbye messages and fires callbacks for peer events.
 *
 * This replaces the hardcoded BroadcastChannel discovery in Pod.
 * It works with BroadcastChannelTransport, EventEmitterTransport, or any
 * custom transport.
 */
export class TransportDiscovery {
  #transport
  #localPodId
  #localKind
  #capabilities
  #timeout
  #onPeerFound = null
  #onPeerLost = null
  #onNonDiscoveryMessage = null

  /**
   * @param {object} opts
   * @param {import('./transport.mjs').BroadcastChannelTransport|import('./transport.mjs').EventEmitterTransport} opts.transport
   * @param {string} opts.localPodId
   * @param {string} opts.localKind
   * @param {object} [opts.capabilities]
   * @param {number} [opts.timeout=2000]
   */
  constructor({ transport, localPodId, localKind, capabilities, timeout = 2000 }) {
    this.#transport = transport
    this.#localPodId = localPodId
    this.#localKind = localKind
    this.#capabilities = capabilities || null
    this.#timeout = timeout
  }

  /**
   * @param {(peerInfo: { podId: string, kind?: string }) => void} handler
   */
  onPeerDiscovered(handler) {
    this.#onPeerFound = handler
  }

  /**
   * @param {(peerInfo: { podId: string }) => void} handler
   */
  onPeerLost(handler) {
    this.#onPeerLost = handler
  }

  /**
   * Register handler for non-discovery messages that come through the transport.
   * @param {(msg: object) => void} handler
   */
  onMessage(handler) {
    this.#onNonDiscoveryMessage = handler
  }

  /**
   * Start discovery: announce ourselves and listen for peers.
   * Returns a promise that resolves after the discovery timeout.
   */
  async start() {
    // Wire message routing
    this.#transport.onMessage((msg) => {
      if (!msg || !msg.type) return
      this.#handleMessage(msg)
    })

    // Open transport if not already open
    if (!this.#transport.ready) {
      await this.#transport.open()
    }

    // Announce ourselves
    this.#transport.send(
      createHello({
        podId: this.#localPodId,
        kind: this.#localKind,
        capabilities: this.#capabilities,
      })
    )

    // Wait for discovery period
    return new Promise((resolve) => {
      setTimeout(resolve, this.#timeout)
    })
  }

  /**
   * Stop discovery: send goodbye and close transport.
   * @param {object} [opts]
   * @param {boolean} [opts.silent] - Skip sending goodbye
   */
  async stop(opts = {}) {
    if (!opts.silent) {
      try {
        this.#transport.send(createGoodbye({ podId: this.#localPodId }))
      } catch { /* transport may already be closed */ }
    }
    await this.#transport.close()
  }

  #handleMessage(msg) {
    switch (msg.type) {
      case POD_HELLO: {
        if (msg.podId === this.#localPodId) return
        if (this.#onPeerFound) {
          this.#onPeerFound({ podId: msg.podId, kind: msg.kind })
        }
        // Respond with ACK
        this.#transport.send(
          createHelloAck({
            podId: this.#localPodId,
            kind: this.#localKind,
            targetPodId: msg.podId,
          })
        )
        break
      }
      case POD_HELLO_ACK: {
        if (msg.targetPodId !== this.#localPodId) return
        if (this.#onPeerFound) {
          this.#onPeerFound({ podId: msg.podId, kind: msg.kind })
        }
        break
      }
      case POD_GOODBYE: {
        if (this.#onPeerLost) {
          this.#onPeerLost({ podId: msg.podId })
        }
        break
      }
      default: {
        // Non-discovery message — pass through
        if (this.#onNonDiscoveryMessage) {
          this.#onNonDiscoveryMessage(msg)
        }
        break
      }
    }
  }
}

// ---------------------------------------------------------------------------
// NullDiscovery
// ---------------------------------------------------------------------------

/**
 * No-op discovery adapter. No peers will be discovered.
 */
export class NullDiscovery {
  onPeerDiscovered(_handler) {}
  onPeerLost(_handler) {}
  onMessage(_handler) {}
  async start() {}
  async stop() {}
}
