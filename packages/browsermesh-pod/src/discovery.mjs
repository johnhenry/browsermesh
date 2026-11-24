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
 *
 * Discovery messages are attributable. A pod signs its hello, hello-ack and
 * goodbye with the same scheme as its other messages (`signed-message.mjs`),
 * and a receiver admits a peer only for a key that proved itself: the pod id a
 * hello names must be the id of the key that signed it. A goodbye is honoured
 * only from the peer it names. A server's list of who is connected (see
 * `WebSocketTransport#onPeerJoined`) is a hint of whom to greet, never
 * membership: a peer is known once its signed hello or ack verifies.
 */

import {
  POD_HELLO, POD_HELLO_ACK, POD_GOODBYE,
  createHello, createHelloAck, createGoodbye,
} from './messages.mjs'
import { admitDiscovery } from './signed-message.mjs'

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
  #signer
  #guard
  #allowUnsigned
  #onPeerFound = null
  #onPeerLost = null
  #onNonDiscoveryMessage = null
  #onDropped = null
  #unsubscribePeers = null
  #rx = Promise.resolve()

  /**
   * @param {object} opts
   * @param {import('./transport.mjs').BroadcastChannelTransport|import('./transport.mjs').EventEmitterTransport} opts.transport
   * @param {string} opts.localPodId
   * @param {string} opts.localKind
   * @param {object} [opts.capabilities]
   * @param {number} [opts.timeout=2000]
   * @param {{ sign: Function }|null} [opts.signer] - a `MessageSigner`: hello, ack and goodbye are signed with it. Without one they are sent unsigned (a pod whose identity cannot sign).
   * @param {import('./signed-message.mjs').ReplayGuard} [opts.guard] - refuses a copy of a discovery message already accepted
   * @param {boolean} [opts.allowUnsigned=true] - admit unsigned hello/ack/goodbye from older peers (they are marked
   *   `authenticated: false`). A bare adapter has no transport policy to consult, so it keeps accepting them;
   *   `Pod` always passes an explicit value (true only for a same-origin transport, or when `allowUnsigned` is set on the pod).
   */
  constructor({ transport, localPodId, localKind, capabilities, timeout = 2000, signer = null, guard, allowUnsigned = true }) {
    this.#transport = transport
    this.#localPodId = localPodId
    this.#localKind = localKind
    this.#capabilities = capabilities || null
    this.#timeout = timeout
    this.#signer = signer
    this.#guard = guard
    this.#allowUnsigned = allowUnsigned
  }

  /**
   * @param {(peerInfo: { podId: string, kind?: string, sid: string|null, authenticated: boolean }) => void} handler
   */
  onPeerDiscovered(handler) {
    this.#onPeerFound = handler
  }

  /**
   * @param {(peerInfo: { podId: string, sid: string|null, authenticated: boolean }) => void} handler
   */
  onPeerLost(handler) {
    this.#onPeerLost = handler
  }

  /**
   * Register handler for non-discovery messages that come through the transport.
   * @param {(msg: object, meta?: { peerId?: string }) => void} handler - `meta.peerId` is set by a
   *   transport whose link authenticates the peer (see `Pod`'s `allowUnsigned` notes).
   */
  onMessage(handler) {
    this.#onNonDiscoveryMessage = handler
  }

  /**
   * Register a handler for discovery messages that were refused.
   * @param {(info: { reason: string, type: string }) => void} handler
   */
  onDropped(handler) {
    this.#onDropped = handler
  }

  /**
   * Start discovery: announce ourselves and listen for peers.
   * Returns a promise that resolves after the discovery timeout.
   */
  async start() {
    // Wire message routing
    this.#transport.onMessage((msg, meta) => {
      if (!msg || !msg.type) return
      this.#handleMessage(msg, meta)
    })

    // A transport that learns its peers from a server (WebSocketTransport)
    // can learn them after open() resolves, or any time later. Greet each
    // peer it announces that the broadcast hello below did not reach. What the
    // server says is a hint of whom to greet: nobody is a peer until their
    // signed hello or ack verifies.
    if (typeof this.#transport.onPeerJoined === 'function') {
      this.#unsubscribePeers = this.#transport.onPeerJoined((podId) => this.#greet(podId))
    }

    // Open transport if not already open
    if (!this.#transport.ready) {
      await this.#transport.open()
    }

    // Announce ourselves
    this.#transport.send(await this.#sign(this.#hello()))

    // Wait for discovery period
    return new Promise((resolve) => {
      setTimeout(resolve, this.#timeout)
    })
  }

  #hello() {
    return createHello({
      podId: this.#localPodId,
      kind: this.#localKind,
      capabilities: this.#capabilities,
    })
  }

  #sign(msg) {
    return this.#signer ? this.#signer.sign(msg) : Promise.resolve(msg)
  }

  /**
   * Send our hello to one newly announced peer (the transport reports each
   * peer once, again only after it left). Skipped until the transport is
   * ready: the broadcast hello in start() reaches every peer known by then.
   */
  #greet(podId) {
    if (!this.#transport.ready) return
    this.#sign({ ...this.#hello(), to: podId })
      .then((hello) => { if (this.#transport.ready) this.#transport.send(hello) })
      .catch(() => {})
  }

  /**
   * Stop discovery: send goodbye and close transport.
   * @param {object} [opts]
   * @param {boolean} [opts.silent] - Skip sending goodbye
   */
  async stop(opts = {}) {
    this.#unsubscribePeers?.()
    this.#unsubscribePeers = null
    if (!opts.silent) {
      try {
        this.#transport.send(await this.#sign(createGoodbye({ podId: this.#localPodId })))
      } catch { /* transport may already be closed */ }
    }
    await this.#transport.close()
  }

  #handleMessage(msg, meta) {
    switch (msg.type) {
      case POD_HELLO:
      case POD_HELLO_ACK:
      case POD_GOODBYE:
        // Verification is asynchronous; one queue keeps arrival order.
        this.#rx = this.#rx.then(() => this.#handleDiscovery(msg, meta)).catch(() => {})
        break
      default: {
        // Non-discovery message — pass through
        if (this.#onNonDiscoveryMessage) {
          this.#onNonDiscoveryMessage(msg, meta)
        }
        break
      }
    }
  }

  async #handleDiscovery(msg, meta) {
    // Not for us: another pod's hello, or an ack addressed elsewhere.
    if (msg.type === POD_HELLO_ACK && msg.targetPodId !== this.#localPodId) return
    if (msg.type !== POD_HELLO_ACK && typeof msg.to === 'string' && msg.to !== '*' && msg.to !== this.#localPodId) return
    if (msg.podId === this.#localPodId) return

    const verdict = await admitDiscovery(msg, meta, { guard: this.#guard, allowUnsigned: this.#allowUnsigned })
    if (!verdict.ok) {
      this.#onDropped?.({ reason: verdict.reason, type: msg.type })
      return
    }
    const { podId, authenticated, sid } = verdict

    switch (msg.type) {
      case POD_HELLO: {
        // The peer is known to the transport from now on: broadcasts reach it.
        this.#transport.confirmPeer?.(podId)
        this.#onPeerFound?.({ podId, kind: msg.kind, sid, authenticated })
        // Respond with ACK
        const ack = await this.#sign(createHelloAck({
          podId: this.#localPodId,
          kind: this.#localKind,
          targetPodId: podId,
        }))
        this.#transport.send(ack)
        break
      }
      case POD_HELLO_ACK: {
        this.#transport.confirmPeer?.(podId)
        this.#onPeerFound?.({ podId, kind: msg.kind, sid, authenticated })
        break
      }
      case POD_GOODBYE: {
        this.#onPeerLost?.({ podId, sid, authenticated })
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
