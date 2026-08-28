/**
 * pod.mjs — Pod base class.
 *
 * A Pod is any execution context (browser tab, worker, Node.js process) that
 * can execute code, receive messages, and be discovered/addressed. This base
 * class implements the 6-phase BrowserMesh boot sequence: Install Runtime →
 * Install Listeners → Self-Classification → Parent Handshake → Peer Discovery
 * → Role Finalization.
 *
 * Transport and discovery are pluggable via adapter objects passed to boot().
 * When no adapters are provided, Pod auto-detects: BroadcastChannel in browsers,
 * NullTransport/NullDiscovery in Node.js.
 *
 * Zero Clawser imports — depends only on @johnhenry/browsermesh-primitives for identity.
 */

import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { detectPodKind } from './detect-kind.mjs'
import { detectCapabilities } from './capabilities.mjs'
import {
  POD_HELLO, POD_HELLO_ACK, POD_GOODBYE, POD_MESSAGE,
  POD_RPC_REQUEST, POD_RPC_RESPONSE,
  createHello, createHelloAck, createGoodbye, createMessage,
} from './messages.mjs'
import { BroadcastChannelTransport, NullTransport } from './transport.mjs'
import { TransportDiscovery, NullDiscovery } from './discovery.mjs'

const POD_RUNTIME_KEY = Symbol.for('pod.runtime')
const DEFAULT_HANDSHAKE_TIMEOUT = 1000
const DEFAULT_DISCOVERY_TIMEOUT = 2000
const DEFAULT_DISCOVERY_CHANNEL = 'pod-discovery'

/** @typedef {'idle'|'booting'|'ready'|'shutdown'} PodState */
/** @typedef {'autonomous'|'child'|'peer'|'controlled'|'hybrid'} PodRole */

export class Pod {
  #identity = null
  #kind = null
  #capabilities = null
  #role = 'autonomous'
  #state = 'idle'
  #peers = new Map()
  #listeners = new Map()
  #transport = null
  #discovery = null
  #messageHandler = null
  #g = null

  // ── Getters ──────────────────────────────────────────────────

  /** @returns {string|null} */
  get podId() { return this.#identity?.podId ?? null }

  /** @returns {PodIdentity|null} */
  get identity() { return this.#identity }

  /** @returns {import('./capabilities.mjs').PodCapabilities|null} */
  get capabilities() { return this.#capabilities }

  /** @returns {import('./detect-kind.mjs').PodKind|null} */
  get kind() { return this.#kind }

  /** @returns {PodRole} */
  get role() { return this.#role }

  /** @returns {PodState} */
  get state() { return this.#state }

  /** @returns {Map<string, object>} podId → peer info */
  get peers() { return new Map(this.#peers) }

  /** @returns {import('./transport.mjs').BroadcastChannelTransport|import('./transport.mjs').EventEmitterTransport|import('./transport.mjs').NullTransport|null} */
  get transport() { return this.#transport }

  // ── Boot ─────────────────────────────────────────────────────

  /**
   * Run the 6-phase boot sequence.
   *
   * @param {object} [opts]
   * @param {PodIdentity|{podId: string}} [opts.identity] - Pre-existing identity (skips generation)
   * @param {object} [opts.transport] - TransportAdapter instance (auto-detected if omitted)
   * @param {object} [opts.discovery] - DiscoveryAdapter instance (auto-created if omitted)
   * @param {string} [opts.discoveryChannel] - BroadcastChannel name (used by auto-created transport)
   * @param {number} [opts.handshakeTimeout] - ms to wait for parent ACK
   * @param {number} [opts.discoveryTimeout] - ms to wait for peer responses
   * @param {object} [opts.globalThis] - Override globalThis for testing
   */
  async boot(opts = {}) {
    if (this.#state !== 'idle') {
      throw new Error(`Pod already in state: ${this.#state}`)
    }
    this.#state = 'booting'
    this.#g = opts.globalThis || globalThis

    try {
      // Phase 0: Install Runtime
      this._emit('phase', { phase: 0, name: 'install-runtime' })
      this.#identity = opts.identity || await PodIdentity.generate()
      this.#kind = detectPodKind(this.#g)
      this.#capabilities = detectCapabilities(this.#g)
      this.#g[POD_RUNTIME_KEY] = {
        podId: this.podId,
        kind: this.#kind,
        capabilities: this.#capabilities,
        pod: this,
      }

      // Phase 1: Install Listeners
      this._emit('phase', { phase: 1, name: 'install-listeners' })
      this.#installMessageHandler()
      this._onInstallListeners(this.#g)

      // Phase 2: Self-Classification
      this._emit('phase', { phase: 2, name: 'self-classification' })

      // Phase 3: Parent Handshake
      this._emit('phase', { phase: 3, name: 'parent-handshake' })
      await this.#parentHandshake(opts.handshakeTimeout ?? DEFAULT_HANDSHAKE_TIMEOUT)

      // Phase 4: Peer Discovery
      this._emit('phase', { phase: 4, name: 'peer-discovery' })
      await this.#peerDiscovery(opts)

      // Phase 5: Role Finalization
      this._emit('phase', { phase: 5, name: 'role-finalization' })
      this.#finalizeRole()
      this.#state = 'ready'
      this._onReady()
      this._emit('ready', { podId: this.podId, kind: this.#kind, role: this.#role })
    } catch (err) {
      this.#state = 'idle'
      this._emit('error', { phase: 'boot', error: err })
      throw err
    }
  }

  // ── Shutdown ─────────────────────────────────────────────────

  /**
   * Gracefully shut down the pod.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.silent] - Skip broadcasting POD_GOODBYE
   */
  async shutdown(opts = {}) {
    if (this.#state === 'shutdown' || this.#state === 'idle') return

    if (this.#discovery) {
      await this.#discovery.stop({ silent: opts.silent })
      this.#discovery = null
    } else if (this.#transport) {
      // No discovery adapter — close transport directly
      if (!opts.silent) {
        try {
          this.#transport.send(createGoodbye({ podId: this.podId }))
        } catch { /* transport may already be closed */ }
      }
      await this.#transport.close()
    }
    this.#transport = null

    if (this.#messageHandler && this.#g?.removeEventListener) {
      this.#g.removeEventListener('message', this.#messageHandler)
      this.#messageHandler = null
    }

    if (this.#g) {
      delete this.#g[POD_RUNTIME_KEY]
    }

    this.#peers.clear()
    this.#state = 'shutdown'
    this._emit('shutdown', { podId: this.podId })
  }

  // ── Messaging ────────────────────────────────────────────────

  /**
   * Send a message to a specific peer via the transport.
   *
   * @param {string} targetPodId
   * @param {*} payload
   */
  send(targetPodId, payload) {
    if (this.#state !== 'ready') {
      throw new Error('Pod is not ready')
    }
    if (!this.#transport) {
      throw new Error('No transport available')
    }
    this.#transport.send(
      createMessage({ from: this.podId, to: targetPodId, payload })
    )
  }

  /**
   * Broadcast a message to all peers via the transport.
   *
   * @param {*} payload
   */
  broadcast(payload) {
    this.send('*', payload)
  }

  // ── Events ───────────────────────────────────────────────────

  /**
   * Register an event listener.
   * @param {string} event
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, [])
    this.#listeners.get(event).push(cb)
  }

  /**
   * Remove an event listener.
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const list = this.#listeners.get(event)
    if (!list) return
    const idx = list.indexOf(cb)
    if (idx !== -1) list.splice(idx, 1)
  }

  // ── Serialization ────────────────────────────────────────────

  /** @returns {object} Serializable snapshot */
  toJSON() {
    return {
      podId: this.podId,
      kind: this.#kind,
      role: this.#role,
      state: this.#state,
      capabilities: this.#capabilities,
      peerCount: this.#peers.size,
      peers: [...this.#peers.keys()],
    }
  }

  // ── Subclass hooks ───────────────────────────────────────────

  /**
   * Called during Phase 1 (Install Listeners). Override in subclasses
   * to install additional message handlers.
   * @param {object} _g - globalThis reference
   */
  _onInstallListeners(_g) { /* override me */ }

  /** Called during Phase 5 (Role Finalization) when boot completes. */
  _onReady() { /* override me */ }

  /**
   * Called for each incoming message that targets this pod.
   * @param {object} _msg
   */
  _onMessage(_msg) { /* override me */ }

  // ── Private: boot phases ─────────────────────────────────────

  #installMessageHandler() {
    if (!this.#g?.addEventListener) return
    this.#messageHandler = (event) => {
      const data = event.data
      if (!data || !data.type) return
      this.#handleIncoming(data)
    }
    this.#g.addEventListener('message', this.#messageHandler)
  }

  async #parentHandshake(timeout) {
    const hasParent = this.#kind === 'iframe' || this.#kind === 'spawned'
    if (!hasParent) return

    const target = this.#kind === 'iframe'
      ? this.#g.parent
      : this.#g.opener

    if (!target || typeof target.postMessage !== 'function') return

    const hello = createHello({
      podId: this.podId,
      kind: this.#kind,
      capabilities: this.#capabilities,
    })

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), timeout)

      const handler = (event) => {
        const data = event.data
        if (data?.type === POD_HELLO_ACK && data.targetPodId === this.podId) {
          clearTimeout(timer)
          this.#g.removeEventListener('message', handler)
          this.#addPeer(data.podId, { kind: data.kind, role: 'parent' })
          this.#role = 'child'
          resolve()
        }
      }
      this.#g.addEventListener('message', handler)
      target.postMessage(hello, '*')
    })
  }

  async #peerDiscovery(opts) {
    const channelName = opts.discoveryChannel ?? DEFAULT_DISCOVERY_CHANNEL
    const timeout = opts.discoveryTimeout ?? DEFAULT_DISCOVERY_TIMEOUT

    // Use provided transport or auto-detect
    if (opts.transport) {
      this.#transport = opts.transport
    } else if (this.#capabilities?.messaging?.broadcastChannel) {
      const BC = this.#g.BroadcastChannel || globalThis.BroadcastChannel
      this.#transport = new BroadcastChannelTransport(channelName, BC)
    } else {
      this.#transport = new NullTransport()
    }

    // Use provided discovery or create one based on transport
    if (opts.discovery) {
      this.#discovery = opts.discovery
    } else if (!(this.#transport instanceof NullTransport)) {
      this.#discovery = new TransportDiscovery({
        transport: this.#transport,
        localPodId: this.podId,
        localKind: this.#kind,
        capabilities: this.#capabilities,
        timeout,
      })
    } else {
      this.#discovery = new NullDiscovery()
    }

    // Wire discovery callbacks
    this.#discovery.onPeerDiscovered((info) => {
      this.#addPeer(info.podId, { kind: info.kind })
    })
    this.#discovery.onPeerLost((info) => {
      this.#removePeer(info.podId)
    })
    this.#discovery.onMessage((msg) => {
      this.#handleIncoming(msg)
    })

    // Run discovery
    await this.#discovery.start()
  }

  #finalizeRole() {
    if (this.#role === 'child') return

    if (this.#peers.size === 0) {
      this.#role = 'autonomous'
    } else {
      this.#role = 'peer'
    }
  }

  // ── Private: message routing ─────────────────────────────────

  #handleIncoming(data) {
    switch (data.type) {
      case POD_HELLO: {
        if (data.podId !== this.podId) {
          this.#addPeer(data.podId, { kind: data.kind })
          if (this.#transport) {
            this.#transport.send(
              createHelloAck({ podId: this.podId, kind: this.#kind, targetPodId: data.podId })
            )
          }
        }
        break
      }
      case POD_HELLO_ACK: {
        if (data.targetPodId === this.podId) {
          this.#addPeer(data.podId, { kind: data.kind })
        }
        break
      }
      case POD_GOODBYE: {
        this.#removePeer(data.podId)
        break
      }
      case POD_MESSAGE:
      case POD_RPC_REQUEST:
      case POD_RPC_RESPONSE: {
        if (data.to === this.podId || data.to === '*') {
          this._onMessage(data)
          this._emit('message', data)
        }
        break
      }
    }
  }

  #addPeer(podId, info) {
    if (podId === this.podId) return
    const isNew = !this.#peers.has(podId)
    this.#peers.set(podId, { ...info, podId, lastSeen: Date.now() })
    if (isNew) {
      this._emit('peer:found', { podId, ...info })
    }
  }

  #removePeer(podId) {
    if (this.#peers.delete(podId)) {
      this._emit('peer:lost', { podId })
    }
  }

  // ── Protected: event emitter ─────────────────────────────────
  // Underscore-prefixed by convention, not a JS #private field: subclasses
  // (e.g. InjectedPod) need to dispatch events through the same listener
  // registry that on()/off() populate.

  _emit(event, data) {
    const list = this.#listeners.get(event)
    if (!list) return
    for (const fn of list) {
      try { fn(data) } catch { /* listener errors don't crash the pod */ }
    }
  }
}
