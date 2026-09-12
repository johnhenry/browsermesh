/**
 * mesh-relay-host.mjs -- Peer A's side of Phase 8 (mesh relay): share access
 * to Peer A's own `VirtualNetwork` (`@johnhenry/browsermesh-netway`) with
 * specific, authorized mesh peers.
 *
 * Real-world scenario this closes: Peer A runs a local service (e.g. an
 * S3-compatible emulator) plus a `wsh` server, and already reaches that
 * service via `browsermesh-netway`'s `GatewayBackend` on its own
 * `VirtualNetwork` (wsh-tunneled TCP, confirmed real and working -- zero new
 * work needed there). `MeshRelayHost` lets Peer A additionally share that
 * *reachability* with other mesh peers, gated per-peer/per-service, without
 * those peers needing their own wsh connection at all.
 *
 * Follows `mesh-sync.mjs`'s proven pattern exactly: a composition file that
 * subscribes to `PeerNode.onIncomingData()`, filters on `envelope.type`
 * (default `'mesh-relay'`), and sends replies via `node.sendTo()`. Modeled
 * on `browsermesh-netway`'s `GatewayBackend` connect/data/close/multiplex
 * shape, carried over `PeerNode.sendTo()`/`onIncomingData()` (JSON envelopes,
 * base64-encoded byte payloads) instead of wsh's binary control protocol --
 * no new dependency, zero changes to `browsermesh-netway` itself.
 *
 * `MeshRelayHost` never dials out over the mesh itself; it only responds to
 * inbound `mesh-relay` envelopes. `exposeService()`/`hideService()` is a
 * small local `Map` -- deliberately NOT `browsermesh-kernel`'s
 * `ServiceRegistry` (same-process, no peer/mesh awareness, wrong tool for a
 * cross-peer relationship).
 *
 * Authorization: each inbound `connect` is checked via
 * `registry.checkAccess(fromPubKey, 'mesh-relay:' + service, 'connect')` --
 * `PeerRegistry`'s existing `grantCapabilities()`/`revokeCapabilities()`/
 * `checkAccess()`, zero API or schema changes. This composes a 3-segment
 * `namespace:resource:action` scope (`mesh-relay:<service>:connect`) that
 * the real `MeshACL`/`matchScope()` grammar already parses cleanly, wildcards
 * included (e.g. `mesh-relay:*:connect`, `mesh-relay:s3-local:*`).
 *
 * Connections are keyed by `(fromPubKey, connId)` so concurrent peers can't
 * collide or spoof-close each other's sessions.
 *
 * Kernel involvement: explicitly none -- this is a peer-relationship
 * decision ("Peer A trusts Peer B to relay to this service"), orthogonal to
 * the kernel-mesh capability that gates tenant-code network access.
 *
 * No browser-only imports at module level.
 */

/** Default `envelope.type` used to route relay payloads on the shared `onIncomingData()` bus. */
const DEFAULT_ENVELOPE_TYPE = 'mesh-relay'

// ---------------------------------------------------------------------------
// Base64 helpers (mirrors peer-encrypted-store.mjs's Buffer-first, btoa/atob
// fallback -- PeerNode.sendTo() JSON-serializes envelopes, so raw byte
// payloads must travel as base64 strings, not Uint8Array).
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
// MeshRelayHost
// ---------------------------------------------------------------------------

/**
 * Binds Peer A's `VirtualNetwork` to its `PeerNode`'s dispatch bus, exposing
 * named services to specific, authorized mesh peers.
 */
export class MeshRelayHost {
  /** @type {import('./peer-node.mjs').PeerNode} */
  #node

  /** @type {import('@johnhenry/browsermesh-netway').VirtualNetwork} */
  #network

  /** @type {import('./peer-registry.mjs').PeerRegistry} */
  #registry

  /** @type {string} */
  #envelopeType

  /** @type {Function} */
  #onLog

  /** @type {Map<string, string>} service name -> target address (e.g. `'mem://localhost:8080'`) */
  #services = new Map()

  /** @type {Map<string, {socket: object, fromPubKey: string, connId: string, service: string}>}
   *  key: `${fromPubKey}::${connId}` */
  #connections = new Map()

  /** @type {(() => void)|null} */
  #unsubscribeIncoming = null

  /**
   * @param {object} opts
   * @param {import('./peer-node.mjs').PeerNode} opts.node
   * @param {import('@johnhenry/browsermesh-netway').VirtualNetwork} opts.network
   *   Peer A's own, already-configured `VirtualNetwork` (e.g. with a
   *   `GatewayBackend` registered for real TCP via wsh).
   * @param {import('./peer-registry.mjs').PeerRegistry} opts.registry
   * @param {string} [opts.envelopeType='mesh-relay']
   * @param {Function} [opts.onLog]
   */
  constructor({ node, network, registry, envelopeType, onLog } = {}) {
    if (!node) throw new Error('node is required')
    if (!network) throw new Error('network is required')
    if (!registry) throw new Error('registry is required')

    this.#node = node
    this.#network = network
    this.#registry = registry
    this.#envelopeType = envelopeType || DEFAULT_ENVELOPE_TYPE
    this.#onLog = onLog || (() => {})

    this.#unsubscribeIncoming = this.#node.onIncomingData((pubKey, data) => {
      this.#handleIncoming(pubKey, data).catch((err) => {
        this.#onLog('mesh-relay-host:handle-incoming-error', { error: err?.message || String(err) })
      })
    })
  }

  /** The `envelope.type` this host routes on the shared dispatch bus. */
  get envelopeType() {
    return this.#envelopeType
  }

  // -----------------------------------------------------------------------
  // Service exposure
  // -----------------------------------------------------------------------

  /**
   * Expose a named service to authorized mesh peers. `targetAddress` is any
   * address `network.connect()` understands (e.g. `'mem://localhost:8080'`,
   * or a `tcp://` address routed through a `GatewayBackend`).
   *
   * @param {string} name
   * @param {string} targetAddress
   */
  exposeService(name, targetAddress) {
    if (!name || typeof name !== 'string') {
      throw new Error('MeshRelayHost.exposeService: name is required')
    }
    if (!targetAddress || typeof targetAddress !== 'string') {
      throw new Error('MeshRelayHost.exposeService: targetAddress is required')
    }
    this.#services.set(name, targetAddress)
    this.#onLog('mesh-relay-host:service:exposed', { name, targetAddress })
  }

  /**
   * Stop exposing a previously-exposed service. Already-open connections to
   * it are left alone; only new `connect` attempts are affected.
   *
   * @param {string} name
   * @returns {boolean} true if the service was exposed
   */
  hideService(name) {
    const had = this.#services.delete(name)
    if (had) this.#onLog('mesh-relay-host:service:hidden', { name })
    return had
  }

  /** @returns {string[]} Names of currently exposed services. */
  listServices() {
    return [...this.#services.keys()]
  }

  // -----------------------------------------------------------------------
  // Inbound envelope handling
  // -----------------------------------------------------------------------

  /** @param {string} fromPubKey @param {string} connId @returns {string} */
  #key(fromPubKey, connId) {
    return `${fromPubKey}::${connId}`
  }

  /**
   * @param {string} fromPubKey
   * @param {*} data
   */
  async #handleIncoming(fromPubKey, data) {
    if (!data || typeof data !== 'object' || data.type !== this.#envelopeType) return
    const { op, connId } = data
    if (!connId || typeof connId !== 'string') return

    if (op === 'connect') {
      await this.#handleConnect(fromPubKey, connId, data.service)
      return
    }

    // 'data' / 'close' only act on connections this host itself accepted
    // for this exact (fromPubKey, connId) pair -- unknown/foreign connIds
    // are silently ignored rather than acted on, so a peer can't spoof-close
    // or inject data into another peer's session.
    const key = this.#key(fromPubKey, connId)
    const conn = this.#connections.get(key)
    if (!conn) return

    if (op === 'data') {
      await this.#handleData(conn, data.data)
    } else if (op === 'close') {
      await this.#closeConnection(key, conn, { notifyPeer: false })
    }
  }

  /**
   * @param {string} fromPubKey
   * @param {string} connId
   * @param {*} service
   */
  async #handleConnect(fromPubKey, connId, service) {
    if (!service || typeof service !== 'string') {
      await this.#refuse(fromPubKey, connId, 'invalid service')
      return
    }

    const { allowed } = this.#registry.checkAccess(fromPubKey, `mesh-relay:${service}`, 'connect')
    if (!allowed) {
      this.#onLog('mesh-relay-host:connect:denied', { fromPubKey, service, connId })
      await this.#refuse(fromPubKey, connId, 'access denied')
      return
    }

    const targetAddress = this.#services.get(service)
    if (!targetAddress) {
      // Explicit refusal, never a silent no-op -- an unknown service must
      // never be treated as "connect to nothing" / a dangling success.
      this.#onLog('mesh-relay-host:connect:unknown-service', { fromPubKey, service, connId })
      await this.#refuse(fromPubKey, connId, 'unknown service')
      return
    }

    let socket
    try {
      socket = await this.#network.connect(targetAddress)
    } catch (err) {
      this.#onLog('mesh-relay-host:connect:failed', {
        fromPubKey, service, connId, error: err?.message || String(err),
      })
      await this.#refuse(fromPubKey, connId, 'connect failed')
      return
    }

    const key = this.#key(fromPubKey, connId)
    const conn = { socket, fromPubKey, connId, service }
    this.#connections.set(key, conn)
    this.#pumpToRemote(key, conn)

    await this.#send(fromPubKey, { op: 'ok', connId })
    this.#onLog('mesh-relay-host:connect:ok', { fromPubKey, service, connId })
  }

  /**
   * @param {{socket: object}} conn
   * @param {*} base64Data
   */
  async #handleData(conn, base64Data) {
    if (typeof base64Data !== 'string') return
    try {
      await conn.socket.write(fromBase64(base64Data))
    } catch (err) {
      this.#onLog('mesh-relay-host:data:write-failed', {
        connId: conn.connId, error: err?.message || String(err),
      })
    }
  }

  /**
   * Pump bytes read from the local service socket back to the remote peer as
   * `data` envelopes. Runs until the local socket closes (natural EOF) or
   * errors, at which point the remote peer is told via a `close` envelope.
   *
   * @param {string} key
   * @param {{socket: object, fromPubKey: string, connId: string}} conn
   */
  #pumpToRemote(key, conn) {
    (async () => {
      try {
        while (true) {
          const chunk = await conn.socket.read()
          if (chunk === null) break // local service closed the connection (EOF)
          await this.#send(conn.fromPubKey, {
            op: 'data',
            connId: conn.connId,
            data: toBase64(chunk),
          })
        }
      } catch (err) {
        this.#onLog('mesh-relay-host:pump:error', { connId: conn.connId, error: err?.message || String(err) })
      }
      await this.#closeConnection(key, conn, { notifyPeer: true })
    })()
  }

  /**
   * @param {string} key
   * @param {{socket: object, fromPubKey: string, connId: string}} conn
   * @param {{notifyPeer: boolean}} opts
   */
  async #closeConnection(key, conn, { notifyPeer }) {
    if (!this.#connections.has(key)) return
    this.#connections.delete(key)
    try { await conn.socket.close() } catch { /* already closed */ }
    if (notifyPeer) {
      await this.#send(conn.fromPubKey, { op: 'close', connId: conn.connId }).catch(() => {})
    }
    this.#onLog('mesh-relay-host:connection:closed', { connId: conn.connId, fromPubKey: conn.fromPubKey })
  }

  /**
   * @param {string} fromPubKey
   * @param {string} connId
   * @param {string} reason
   */
  async #refuse(fromPubKey, connId, reason) {
    await this.#send(fromPubKey, { op: 'refused', connId, reason }).catch(() => {})
  }

  /**
   * @param {string} pubKey
   * @param {object} payload
   */
  async #send(pubKey, payload) {
    await this.#node.sendTo(pubKey, { type: this.#envelopeType, ...payload })
  }

  // -----------------------------------------------------------------------
  // Teardown
  // -----------------------------------------------------------------------

  /**
   * Detach from the `PeerNode` dispatch bus and close every currently
   * relayed connection. Does not close `network` itself (the host doesn't
   * own its lifecycle).
   */
  async detach() {
    if (this.#unsubscribeIncoming) {
      this.#unsubscribeIncoming()
      this.#unsubscribeIncoming = null
    }
    for (const [key, conn] of [...this.#connections]) {
      this.#connections.delete(key)
      try { await conn.socket.close() } catch { /* already closed */ }
    }
  }
}

export { DEFAULT_ENVELOPE_TYPE }
