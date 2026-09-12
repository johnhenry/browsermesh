/**
 * mesh-relay-backend.mjs -- Peer B's side of Phase 8 (mesh relay): a
 * `browsermesh-netway` `Backend` that reaches services exposed by a
 * `MeshRelayHost` (`mesh-relay-host.mjs`) on another mesh peer, over the
 * real WebRTC mesh (Phases 2-4) -- no direct `wsh` connection of its own.
 *
 * The one file in this package that imports *from* `browsermesh-netway`,
 * keeping the family's dependency graph one-directional (`-netway` stays
 * dependency-free and mesh-unaware; all mesh awareness lives here in
 * `-apps`).
 *
 * `connect(host, port)` treats `host` as a service name -- exact precedent:
 * `browsermesh-netway`'s own `ServiceBackend.connect(host, port)` (`host` is
 * a service name, `port` ignored). A `MeshRelayBackend` instance is bound to
 * one relay-host peer's pubkey; register it on the client's own
 * `VirtualNetwork` under a caller-chosen scheme (e.g.
 * `network.addBackend('s3-via-alice', backend)`) so application code
 * addresses the shared service via the existing, unmodified
 * `VirtualNetwork.connect()` API (e.g. `network.connect('s3-via-alice://s3-local')`).
 *
 * TCP-only this phase: `listen()` / `bindDatagram()` / `resolve()` are left
 * as `Backend`'s inherited "not implemented" throws -- see the Phase 8 plan's
 * explicit "out of scope" list (UDP relay, inbound listen-relay).
 *
 * No browser-only imports at module level.
 */

import { Backend, StreamSocket, ConnectionRefusedError } from '@johnhenry/browsermesh-netway'

/** Default `envelope.type` used to route relay payloads on the shared `onIncomingData()` bus. */
const DEFAULT_ENVELOPE_TYPE = 'mesh-relay'

/** Default timeout (ms) for a relay `connect` awaiting `ok`/`refused` from the host peer. */
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

// ---------------------------------------------------------------------------
// Base64 helpers (see mesh-relay-host.mjs -- same rationale, duplicated
// locally rather than shared, matching this family's existing convention of
// small self-contained per-file helpers, e.g. peer-encrypted-store.mjs).
// ---------------------------------------------------------------------------

/** @param {Uint8Array} bytes @returns {string} */
function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64')
  }
  return btoa(String.fromCharCode(...bytes))
}

/** @param {string} str @returns {Uint8Array} */
function fromBase64(str) {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(str, 'base64'))
  }
  const bin = atob(str)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// ---------------------------------------------------------------------------
// MeshRelayBackend
// ---------------------------------------------------------------------------

/**
 * A `Backend` that relays TCP-like `connect()`s through one specific mesh
 * peer's `MeshRelayHost`, over `PeerNode.sendTo()`/`onIncomingData()`.
 *
 * @extends Backend
 */
export class MeshRelayBackend extends Backend {
  /** @type {import('./peer-node.mjs').PeerNode} */
  #node

  /** @type {string} */
  #relayPeerPubKey

  /** @type {string} */
  #envelopeType

  /** @type {number} */
  #connectTimeoutMs

  /** @type {Function} */
  #onLog

  /** @type {Map<string, {resolve: Function, reject: Function, service: string}>} connId -> pending connect */
  #pending = new Map()

  /** @type {Map<string, import('@johnhenry/browsermesh-netway').StreamSocket>} connId -> relay-side socket */
  #connections = new Map()

  /** @type {(() => void)|null} */
  #unsubscribeIncoming = null

  /**
   * @param {object} opts
   * @param {import('./peer-node.mjs').PeerNode} opts.node
   * @param {string} opts.relayPeerPubKey - The `MeshRelayHost` peer's fingerprint/pubkey.
   * @param {string} [opts.envelopeType='mesh-relay']
   * @param {number} [opts.connectTimeoutMs=15000] - `0` disables the timeout.
   * @param {Function} [opts.onLog]
   */
  constructor({ node, relayPeerPubKey, envelopeType, connectTimeoutMs, onLog } = {}) {
    super()
    if (!node) throw new Error('node is required')
    if (!relayPeerPubKey || typeof relayPeerPubKey !== 'string') {
      throw new Error('relayPeerPubKey is required')
    }

    this.#node = node
    this.#relayPeerPubKey = relayPeerPubKey
    this.#envelopeType = envelopeType || DEFAULT_ENVELOPE_TYPE
    this.#connectTimeoutMs = connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.#onLog = onLog || (() => {})

    this.#unsubscribeIncoming = this.#node.onIncomingData((pubKey, data) => {
      if (pubKey !== this.#relayPeerPubKey) return
      this.#handleIncoming(data).catch((err) => {
        this.#onLog('mesh-relay-backend:handle-incoming-error', { error: err?.message || String(err) })
      })
    })
  }

  /** The relay-host peer this backend is bound to. */
  get relayPeerPubKey() {
    return this.#relayPeerPubKey
  }

  /** The `envelope.type` this backend routes on the shared dispatch bus. */
  get envelopeType() {
    return this.#envelopeType
  }

  // -----------------------------------------------------------------------
  // Backend API
  // -----------------------------------------------------------------------

  /**
   * Connect to a service exposed by the bound relay-host peer. `host` is
   * treated as the service name (see `ServiceBackend` for the same
   * precedent); `port` is ignored.
   *
   * @param {string} host - Service name (e.g. `'s3-local'`).
   * @param {number} [port] - Ignored.
   * @returns {Promise<import('@johnhenry/browsermesh-netway').StreamSocket>} The client-side socket.
   * @throws {ConnectionRefusedError} If the host peer refuses (unauthorized,
   *   unknown service, or its own connect to the local service failed).
   */
  async connect(host, port) {
    if (!host || typeof host !== 'string') {
      throw new Error('MeshRelayBackend.connect: host (service name) is required')
    }

    const connId = crypto.randomUUID()
    const pending = new Promise((resolve, reject) => {
      this.#pending.set(connId, { resolve, reject, service: host })
    })

    await this.#send({ op: 'connect', connId, service: host })

    if (!this.#connectTimeoutMs) return pending

    let timer
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        if (this.#pending.delete(connId)) {
          reject(new Error(`MeshRelayBackend.connect: timed out waiting for '${host}' via ${this.#relayPeerPubKey}`))
        }
      }, this.#connectTimeoutMs)
    })

    try {
      return await Promise.race([pending, timeoutPromise])
    } finally {
      clearTimeout(timer)
    }
  }

  // -----------------------------------------------------------------------
  // Inbound envelope handling
  // -----------------------------------------------------------------------

  /** @param {*} data */
  async #handleIncoming(data) {
    if (!data || typeof data !== 'object' || data.type !== this.#envelopeType) return
    const { op, connId } = data
    if (!connId || typeof connId !== 'string') return

    if (op === 'ok') {
      const pending = this.#pending.get(connId)
      if (!pending) return
      this.#pending.delete(connId)

      const [userSocket, relaySocket] = StreamSocket.createPair()
      this.#connections.set(connId, relaySocket)
      this.#pumpToRemote(connId, relaySocket)
      pending.resolve(userSocket)
      return
    }

    if (op === 'refused') {
      const pending = this.#pending.get(connId)
      if (!pending) return
      this.#pending.delete(connId)
      pending.reject(new ConnectionRefusedError(
        `mesh-relay://${this.#relayPeerPubKey}/${pending.service}${data.reason ? ` (${data.reason})` : ''}`,
      ))
      return
    }

    // 'data' / 'close' only act on connIds this backend itself originated
    // and that are still open -- unrecognized connIds are ignored.
    const relaySocket = this.#connections.get(connId)
    if (!relaySocket) return

    if (op === 'data') {
      if (typeof data.data !== 'string') return
      try {
        await relaySocket.write(fromBase64(data.data))
      } catch (err) {
        this.#onLog('mesh-relay-backend:data:write-failed', { connId, error: err?.message || String(err) })
      }
      return
    }

    if (op === 'close') {
      this.#connections.delete(connId)
      try { await relaySocket.close() } catch { /* already closed */ }
    }
  }

  /**
   * Pump bytes written to the user-facing socket to the relay-host peer as
   * `data` envelopes. Runs until the relay-side socket closes (the user
   * closed their side), at which point the host is told via `close`.
   *
   * @param {string} connId
   * @param {import('@johnhenry/browsermesh-netway').StreamSocket} relaySocket
   */
  #pumpToRemote(connId, relaySocket) {
    (async () => {
      try {
        while (true) {
          const chunk = await relaySocket.read()
          if (chunk === null) break
          await this.#send({ op: 'data', connId, data: toBase64(chunk) })
        }
      } catch (err) {
        this.#onLog('mesh-relay-backend:pump:error', { connId, error: err?.message || String(err) })
      }
      if (this.#connections.delete(connId)) {
        await this.#send({ op: 'close', connId }).catch(() => {})
      }
    })()
  }

  /** @param {object} payload */
  async #send(payload) {
    await this.#node.sendTo(this.#relayPeerPubKey, { type: this.#envelopeType, ...payload })
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  /**
   * Detach from the `PeerNode` dispatch bus, close every open relayed
   * connection, and reject any still-pending `connect()`s.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.#unsubscribeIncoming) {
      this.#unsubscribeIncoming()
      this.#unsubscribeIncoming = null
    }
    for (const [connId, socket] of [...this.#connections]) {
      this.#connections.delete(connId)
      try { await socket.close() } catch { /* already closed */ }
    }
    for (const [connId, pending] of [...this.#pending]) {
      this.#pending.delete(connId)
      pending.reject(new Error('MeshRelayBackend closed'))
    }
  }
}

export { DEFAULT_ENVELOPE_TYPE }
