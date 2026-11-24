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
 * Zero host-application imports — depends only on @johnhenry/browsermesh-primitives for identity.
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
import { MessageSigner, ReplayGuard, verifyMessage, admitDiscovery, DROP_REASONS } from './signed-message.mjs'

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
  #signer = null
  #guard = new ReplayGuard()
  #allowUnsigned = undefined
  #trust = 'untrusted'
  #rx = Promise.resolve()
  #dropped = Object.fromEntries(DROP_REASONS.map((r) => [r, 0]))

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

  /**
   * Messages refused so far, by reason (`unsigned`, `unsigned-rpc`, `malformed`,
   * `sender-mismatch`, `bad-signature`, `replay`). Each is also announced as a
   * `message:dropped` event `{ reason, type }`.
   * @returns {Record<string, number>}
   */
  get dropped() { return { ...this.#dropped } }

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
   * @param {boolean} [opts.sign=true] - Sign outgoing `pod:message`/`pod:rpc-*` messages with this pod's key.
   *   `send()` then returns a promise that settles once the message is on the transport.
   * @param {boolean} [opts.allowUnsigned] - Accept unsigned `pod:message` / `pod:rpc-response`
   *   and unsigned `pod:hello` / `pod:hello-ack` / `pod:goodbye` from older peers (a peer admitted
   *   that way is listed with `authenticated: false`). Default: `true` when the transport reports
   *   `trust === 'same-origin'` (BroadcastChannel, in-process) and for messages posted to the
   *   window; `false` for every other transport (WebSocket relay, custom adapters). Unsigned
   *   `pod:rpc-request`s are never accepted. A message that carries a signature must verify
   *   whatever this is set to. A link that authenticates its peer (see `meta.peerId`) needs no
   *   signature for discovery messages either.
   * @param {'same-origin'|'untrusted'} [opts.trust] - Overrides the transport's own `trust`.
   * @param {{ maxSenders?: number, maxSessionsPerSender?: number }} [opts.replay] - Bounds of the replay window state.
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
      this.#signer = opts.sign !== false && MessageSigner.canSign(this.#identity)
        ? new MessageSigner(this.#identity)
        : null
      this.#allowUnsigned = opts.allowUnsigned
      this.#guard = new ReplayGuard(opts.replay)
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
          const goodbye = createGoodbye({ podId: this.podId })
          this.#transport.send(this.#signer ? await this.#signer.sign(goodbye) : goodbye)
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
   * Messages are signed by default (see `signed-message.mjs`), which needs a
   * JSON-compatible payload and makes sending asynchronous: await the
   * returned promise before relying on the message having been handed to the
   * transport.
   *
   * @param {string} targetPodId
   * @param {*} payload
   * @returns {Promise<void>}
   */
  send(targetPodId, payload) {
    if (this.#state !== 'ready') {
      throw new Error('Pod is not ready')
    }
    if (!this.#transport) {
      throw new Error('No transport available')
    }
    const msg = createMessage({ from: this.podId, to: targetPodId, payload })
    const transport = this.#transport
    if (!this.#signer) {
      transport.send(msg)
      return Promise.resolve()
    }
    return this.#signer.sign(msg).then((signed) => {
      if (this.#transport === transport) transport.send(signed)
    })
  }

  /**
   * Broadcast a message to all peers via the transport.
   *
   * @param {*} payload
   * @returns {Promise<void>}
   */
  broadcast(payload) {
    return this.send('*', payload)
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
      this.#handleIncoming(data, 'window')
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

    const unsigned = createHello({
      podId: this.podId,
      kind: this.#kind,
      capabilities: this.#capabilities,
    })
    const hello = this.#signer ? await this.#signer.sign(unsigned) : unsigned

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), timeout)

      const handler = (event) => {
        const data = event.data
        if (data?.type === POD_HELLO_ACK && data.targetPodId === this.podId) {
          // The ack names the parent; it counts only if that parent proved it.
          admitDiscovery(data, undefined, { guard: this.#guard, allowUnsigned: this.#allowUnsigned ?? true }).then((verdict) => {
            if (!verdict.ok) return this.#countDrop(verdict.reason, data.type)
            clearTimeout(timer)
            this.#g.removeEventListener('message', handler)
            this.#addPeer(verdict.podId, { kind: data.kind, role: 'parent', sid: verdict.sid, authenticated: verdict.authenticated })
            this.#role = 'child'
            resolve()
          })
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

    this.#trust = opts.trust ?? opts.discovery?.trust ?? this.#transport?.trust ?? 'untrusted'

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
        signer: this.#signer,
        guard: this.#guard,
        allowUnsigned: this.#allowUnsigned ?? this.#trust === 'same-origin',
      })
    } else {
      this.#discovery = new NullDiscovery()
    }

    // Wire discovery callbacks
    this.#discovery.onPeerDiscovered((info) => {
      this.#addPeer(info.podId, { kind: info.kind, sid: info.sid ?? null, authenticated: info.authenticated === true })
    })
    this.#discovery.onPeerLost((info) => {
      this.#goodbye(info)
    })
    this.#discovery.onDropped?.((info) => this.#countDrop(info.reason, info.type))
    this.#discovery.onMessage((msg, meta) => {
      this.#handleIncoming(msg, 'transport', meta)
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

  /**
   * @param {object} data
   * @param {'window'|'transport'} [source]
   * @param {{ peerId?: string }} [meta] - `peerId`: the peer identity the link itself authenticated
   */
  #handleIncoming(data, source = 'transport', meta) {
    switch (data.type) {
      case POD_HELLO:
      case POD_HELLO_ACK:
      case POD_GOODBYE: {
        // Same queue as messages: verification is asynchronous.
        this.#rx = this.#rx.then(() => this.#receiveDiscovery(data, source, meta)).catch(() => {})
        break
      }
      case POD_MESSAGE:
      case POD_RPC_REQUEST:
      case POD_RPC_RESPONSE: {
        if (data.to === this.podId || data.to === '*') {
          // Verification is asynchronous; one queue keeps arrival order.
          this.#rx = this.#rx.then(() => this.#receive(data, source, meta)).catch(() => {})
        }
        break
      }
    }
  }

  /**
   * Decide whether a message that targets this pod is delivered, and as
   * whom. The sender is never read from a field the sender or a relay wrote:
   * it is the identity the link authenticated, or the key that signed.
   */
  async #receive(data, source, meta) {
    const drop = (reason) => {
      this.#dropped[reason]++
      this._emit('message:dropped', { reason, type: data.type })
    }
    if (this.#state === 'shutdown') return

    const linkPeer = typeof meta?.peerId === 'string' ? meta.peerId : null
    let delivered

    if (linkPeer !== null) {
      // The link authenticates the peer: the sender is the link's identity,
      // and a message that claims another one is dropped.
      if (data.from !== linkPeer) return drop('sender-mismatch')
      delivered = { ...data, authenticated: true }
    } else if (data.sig !== undefined || data.pk !== undefined) {
      const verdict = await verifyMessage(data, { guard: this.#guard })
      if (!verdict.ok) return drop(verdict.reason)
      delivered = { ...verdict.message, authenticated: true }
    } else {
      if (data.type === POD_RPC_REQUEST) return drop('unsigned-rpc')
      const allowed = this.#allowUnsigned ?? (source === 'window' || this.#trust === 'same-origin')
      if (!allowed) return drop('unsigned')
      delivered = { ...data, authenticated: false }
    }

    if (this.#state === 'shutdown') return
    this._onMessage(delivered)
    this._emit('message', delivered)
  }

  /**
   * A discovery message that reached the pod outside its discovery adapter
   * (posted to the window). Same rules as `TransportDiscovery`: the pod a hello
   * names must be the key that signed it, or the link must have said so.
   */
  async #receiveDiscovery(data, source, meta) {
    if (this.#state === 'shutdown') return
    if (data.type === POD_HELLO_ACK ? data.targetPodId !== this.podId
      : (typeof data.to === 'string' && data.to !== '*' && data.to !== this.podId)) return
    if (data.podId === this.podId) return
    const allowUnsigned = this.#allowUnsigned ?? (source === 'window' || this.#trust === 'same-origin')
    const verdict = await admitDiscovery(data, meta, { guard: this.#guard, allowUnsigned })
    if (!verdict.ok) return this.#countDrop(verdict.reason, data.type)
    if (this.#state === 'shutdown') return
    const { podId, authenticated, sid } = verdict
    switch (data.type) {
      case POD_HELLO: {
        this.#addPeer(podId, { kind: data.kind, sid, authenticated })
        if (this.#transport) {
          const ack = createHelloAck({ podId: this.podId, kind: this.#kind, targetPodId: podId })
          this.#transport.send(this.#signer ? await this.#signer.sign(ack) : ack)
        }
        break
      }
      case POD_HELLO_ACK:
        this.#addPeer(podId, { kind: data.kind, sid, authenticated })
        break
      case POD_GOODBYE:
        this.#goodbye({ podId, sid, authenticated })
        break
    }
  }

  #countDrop(reason, type) {
    if (reason in this.#dropped) this.#dropped[reason]++
    this._emit('message:dropped', { reason, type })
  }

  #addPeer(podId, info) {
    if (podId === this.podId) return
    const isNew = !this.#peers.has(podId)
    this.#peers.set(podId, { ...info, podId, lastSeen: Date.now() })
    if (isNew) {
      this._emit('peer:found', { podId, ...info })
    }
  }

  /**
   * A goodbye removes the peer it names when it is as well attributed as the
   * entry: an entry that a signature proved is not removed by an unsigned
   * goodbye, and a goodbye left over from an earlier session of the same key
   * does not remove the session that replaced it.
   */
  #goodbye({ podId, sid, authenticated }) {
    const known = this.#peers.get(podId)
    if (!known) return
    if (known.authenticated && !authenticated) return
    if (known.sid && sid && known.sid !== sid) return
    this.#removePeer(podId)
  }

  #removePeer(podId) {
    this.#transport?.forgetPeer?.(podId)
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
