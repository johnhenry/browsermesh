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
 * no new dependency.
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
 * `checkAccess()`. This composes a 3-segment `namespace:resource:action`
 * scope (`mesh-relay:<service>:connect`) that the real `MeshACL`/
 * `matchScope()` grammar already parses cleanly, wildcards included (e.g.
 * `mesh-relay:*:connect`, `mesh-relay:s3-local:*`).
 *
 * Lifetime: an accepted connection lasts only as long as the permission that
 * allowed it. The host re-checks every open connection when the registry
 * announces an access change (`registry.onAccessChange()`), when
 * `recheck()` is called, and every `recheckIntervalMs` (so expiry is
 * noticed); never per packet. A connection is also closed when its service
 * is hidden or the host is detached, and a connect that finishes after any of
 * those is not acknowledged. A closed connection is closed in both
 * directions, with a reason sent to the peer, and its resources are freed.
 *
 * Flow control: see `internal/relay-flow.mjs`. Each side advertises a window
 * in `connect`/`ok`; the sender stops reading its local socket when the
 * window is used and resumes when credit (`credit` frames) brings it under
 * the low-water mark. Received bytes that are not yet consumed are bounded per
 * connection and per peer; exceeding a bound closes the connection with a
 * reason. A peer that advertises no window (an older version) is sent no
 * credit frames and is held to the same bounds.
 *
 * Connections are keyed by `(fromPubKey, connId)` so concurrent peers can't
 * collide or spoof-close each other's sessions; `fromPubKey` is the key of the
 * session the envelope arrived on.
 *
 * Kernel involvement: explicitly none -- this is a peer-relationship
 * decision ("Peer A trusts Peer B to relay to this service"), orthogonal to
 * the kernel-mesh capability that gates tenant-code network access.
 *
 * No browser-only imports at module level.
 */

/** Default `envelope.type` used to route relay payloads on the shared `onIncomingData()` bus. */
import { decodeWireData } from './internal/wire-envelope.mjs'
import { CreditReceiver, CreditSender, RELAY_FLOW_DEFAULTS, resolveFlowOptions } from './internal/relay-flow.mjs'

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
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
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

  /** @type {Readonly<typeof RELAY_FLOW_DEFAULTS>} */
  #flow

  /** @type {Map<string, string>} service name -> target address (e.g. `'mem://localhost:8080'`) */
  #services = new Map()

  /** @type {Map<string, object>} key: `${fromPubKey}::${connId}` */
  #connections = new Map()

  /** Connects that are being opened, per peer (they count toward the per-peer limit). @type {Map<string, number>} */
  #opening = new Map()

  /** Bytes received and not yet consumed, per peer. @type {Map<string, number>} */
  #peerBuffered = new Map()

  /** @type {(() => void)|null} */
  #unsubscribeIncoming = null

  /** @type {(() => void)|null} */
  #unsubscribeAccess = null

  /** @type {ReturnType<typeof setInterval>|null} */
  #recheckTimer = null

  #detached = false

  /**
   * @param {object} opts
   * @param {import('./peer-node.mjs').PeerNode} opts.node
   * @param {import('@johnhenry/browsermesh-netway').VirtualNetwork} opts.network
   *   Peer A's own, already-configured `VirtualNetwork` (e.g. with a
   *   `GatewayBackend` registered for real TCP via wsh).
   * @param {import('./peer-registry.mjs').PeerRegistry} opts.registry
   * @param {string} [opts.envelopeType='mesh-relay']
   * @param {Function} [opts.onLog]
   * @param {number} [opts.highWaterBytes=262144] - Receive window per connection; senders pause at it.
   * @param {number} [opts.lowWaterBytes=65536] - Paused senders resume once this far back under it.
   * @param {number} [opts.maxBufferedBytesPerConnection=1048576] - Hard cap on bytes received and not yet consumed, per connection.
   * @param {number} [opts.maxBufferedBytesPerPeer=4194304] - The same, summed over one peer's connections.
   * @param {number} [opts.maxConnectionsPerPeer=16]
   * @param {number} [opts.maxFrameBytes=65536] - Largest data frame, before base64.
   * @param {number} [opts.recheckIntervalMs=30000] - How often open connections are re-checked; 0 disables.
   */
  constructor({ node, network, registry, envelopeType, onLog, ...flow } = {}) {
    if (!node) throw new Error('node is required')
    if (!network) throw new Error('network is required')
    if (!registry) throw new Error('registry is required')

    this.#flow = resolveFlowOptions(flow)
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

    if (typeof registry.onAccessChange === 'function') {
      this.#unsubscribeAccess = registry.onAccessChange(({ pubKey } = {}) => {
        this.#recheckSync(pubKey)
      })
    }
    if (this.#flow.recheckIntervalMs > 0) {
      this.#recheckTimer = setInterval(() => this.#recheckSync(), this.#flow.recheckIntervalMs)
      this.#recheckTimer.unref?.()
    }
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
   * Stop exposing a previously-exposed service. New `connect` attempts are
   * refused and every open connection to it is closed (reason
   * `service hidden`).
   *
   * @param {string} name
   * @returns {boolean} true if the service was exposed
   */
  hideService(name) {
    const had = this.#services.delete(name)
    if (had) {
      this.#onLog('mesh-relay-host:service:hidden', { name })
      for (const [key, conn] of [...this.#connections]) {
        if (conn.service === name) this.#closeConnection(key, conn, { notifyPeer: true, reason: 'service hidden' })
      }
    }
    return had
  }

  /** @returns {string[]} Names of currently exposed services. */
  listServices() {
    return [...this.#services.keys()]
  }

  // -----------------------------------------------------------------------
  // Re-checking access
  // -----------------------------------------------------------------------

  /**
   * Check the access of every open connection (of one peer, or all) again and
   * close those no longer allowed. Called by the registry's access-change
   * event and by the interval; call it yourself after changing the ACL by a
   * path the registry does not see.
   *
   * @param {string} [pubKey]
   * @returns {Promise<void>}
   */
  async recheck(pubKey) {
    this.#recheckSync(pubKey)
  }

  /** @param {string} [pubKey] */
  #recheckSync(pubKey) {
    if (this.#detached) return
    for (const [key, conn] of [...this.#connections]) {
      if (pubKey !== undefined && conn.fromPubKey !== pubKey) continue
      if (!this.#allowed(conn.fromPubKey, conn.service)) {
        this.#onLog('mesh-relay-host:connection:revoked', { fromPubKey: conn.fromPubKey, connId: conn.connId, service: conn.service })
        this.#closeConnection(key, conn, { notifyPeer: true, reason: 'access revoked' })
      }
    }
  }

  /** @param {string} fromPubKey @param {string} service @returns {boolean} */
  #allowed(fromPubKey, service) {
    try {
      return this.#registry.checkAccess(fromPubKey, `mesh-relay:${service}`, 'connect')?.allowed === true
    } catch {
      return false
    }
  }

  // -----------------------------------------------------------------------
  // Counters
  // -----------------------------------------------------------------------

  /**
   * Counters for what is held in memory on behalf of peers.
   *
   * `bufferedBytes` is bytes received from peers and not yet accepted by the
   * service socket plus bytes the service wrote that the relay has not yet read;
   * bytes the service socket holds in its own receive window (at most
   * `windowBytes` per connection, 256 KiB by default) are not counted.
   * `inFlightBytes` is bytes sent to peers and not yet credited back.
   *
   * @returns {{ connections: number, bufferedBytes: number, inFlightBytes: number,
   *   peers: Record<string, { connections: number, bufferedBytes: number }> }}
   */
  stats() {
    let bufferedBytes = 0
    let inFlightBytes = 0
    /** @type {Record<string, { connections: number, bufferedBytes: number }>} */
    const peers = {}
    for (const conn of this.#connections.values()) {
      const queued = typeof conn.socket.readableLength === 'number' ? conn.socket.readableLength : 0
      const held = conn.rx.outstanding + queued
      bufferedBytes += held
      inFlightBytes += conn.tx.inFlight
      const p = (peers[conn.fromPubKey] ??= { connections: 0, bufferedBytes: 0 })
      p.connections++
      p.bufferedBytes += held
    }
    return { connections: this.#connections.size, bufferedBytes, inFlightBytes, peers }
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
    if (this.#detached) return
    data = decodeWireData(data)
    if (!data || typeof data !== 'object' || data.type !== this.#envelopeType) return
    const { op, connId } = data
    if (!connId || typeof connId !== 'string') return

    if (op === 'connect') {
      await this.#handleConnect(fromPubKey, connId, data.service, data.window)
      return
    }

    // 'data' / 'credit' / 'close' only act on connections this host itself
    // accepted for this exact (fromPubKey, connId) pair -- unknown/foreign
    // connIds are silently ignored rather than acted on, so a peer can't
    // spoof-close or inject data into another peer's session.
    const key = this.#key(fromPubKey, connId)
    const conn = this.#connections.get(key)
    if (!conn) return

    if (op === 'data') {
      await this.#handleData(key, conn, data.data)
    } else if (op === 'credit') {
      if (conn.tx.enabled && !conn.tx.credit(data.bytes)) {
        this.#closeConnection(key, conn, { notifyPeer: true, reason: 'flow control violation' })
      }
    } else if (op === 'close') {
      await this.#closeConnection(key, conn, { notifyPeer: false, reason: 'closed by peer' })
    }
  }

  /**
   * @param {string} fromPubKey
   * @param {string} connId
   * @param {*} service
   * @param {*} peerWindow - the window the peer advertised, if any
   */
  async #handleConnect(fromPubKey, connId, service, peerWindow) {
    if (!service || typeof service !== 'string') {
      await this.#refuse(fromPubKey, connId, 'invalid service')
      return
    }

    const key = this.#key(fromPubKey, connId)
    if (this.#connections.has(key)) {
      await this.#refuse(fromPubKey, connId, 'duplicate connection id')
      return
    }

    if (!this.#allowed(fromPubKey, service)) {
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

    const open = [...this.#connections.values()].filter((c) => c.fromPubKey === fromPubKey).length
      + (this.#opening.get(fromPubKey) ?? 0)
    if (open >= this.#flow.maxConnectionsPerPeer) {
      this.#onLog('mesh-relay-host:connect:too-many', { fromPubKey, service, connId })
      await this.#refuse(fromPubKey, connId, 'too many connections')
      return
    }

    this.#opening.set(fromPubKey, (this.#opening.get(fromPubKey) ?? 0) + 1)
    let socket
    try {
      socket = await this.#network.connect(targetAddress)
    } catch (err) {
      this.#onLog('mesh-relay-host:connect:failed', {
        fromPubKey, service, connId, error: err?.message || String(err),
      })
      await this.#refuse(fromPubKey, connId, 'connect failed')
      return
    } finally {
      const left = (this.#opening.get(fromPubKey) ?? 1) - 1
      if (left > 0) this.#opening.set(fromPubKey, left)
      else this.#opening.delete(fromPubKey)
    }

    // Whatever happened while the connect was in flight decides it: a host
    // that was detached, a service that was hidden or re-pointed, or a grant
    // that was revoked must not get a live connection.
    if (this.#detached) {
      try { await socket.close('service detached') } catch { /* already closed */ }
      return
    }
    if (this.#services.get(service) !== targetAddress || !this.#allowed(fromPubKey, service)) {
      try { await socket.close('access revoked') } catch { /* already closed */ }
      await this.#refuse(fromPubKey, connId, 'access denied')
      return
    }

    const creditAware = Number.isInteger(peerWindow) && peerWindow > 0
    const conn = {
      socket, fromPubKey, connId, service, closed: false,
      tx: new CreditSender({
        window: creditAware ? Math.min(peerWindow, this.#flow.maxBufferedBytesPerConnection) : 0,
        lowWater: this.#flow.lowWaterBytes,
      }),
      rx: new CreditReceiver({
        window: this.#flow.highWaterBytes,
        lowWater: this.#flow.lowWaterBytes,
        maxBuffered: this.#flow.maxBufferedBytesPerConnection,
        creditAware,
        grant: (bytes) => {
          if (!conn.closed) this.#send(fromPubKey, { op: 'credit', connId, bytes }).catch(() => {})
        },
      }),
    }
    this.#connections.set(key, conn)
    this.#pumpToRemote(key, conn)

    await this.#send(fromPubKey, { op: 'ok', connId, window: this.#flow.highWaterBytes })
    this.#onLog('mesh-relay-host:connect:ok', { fromPubKey, service, connId })
  }

  /**
   * @param {string} key
   * @param {object} conn
   * @param {*} base64Data
   */
  async #handleData(key, conn, base64Data) {
    if (typeof base64Data !== 'string') return
    const approx = Math.floor((base64Data.length * 3) / 4)
    if (approx > this.#flow.maxBufferedBytesPerConnection) {
      this.#closeConnection(key, conn, { notifyPeer: true, reason: 'buffer limit exceeded' })
      return
    }
    if (conn.rx.creditAware && approx > this.#flow.maxFrameBytes + 3) {
      this.#closeConnection(key, conn, { notifyPeer: true, reason: 'flow control violation' })
      return
    }
    const bytes = fromBase64(base64Data)
    const n = bytes.length

    const peerTotal = this.#peerBuffered.get(conn.fromPubKey) ?? 0
    if (peerTotal + n > this.#flow.maxBufferedBytesPerPeer) {
      this.#closeConnection(key, conn, { notifyPeer: true, reason: 'buffer limit exceeded' })
      return
    }
    const verdict = conn.rx.receive(n)
    if (verdict !== 'ok') {
      this.#closeConnection(key, conn, {
        notifyPeer: true,
        reason: verdict === 'violation' ? 'flow control violation' : 'buffer limit exceeded',
      })
      return
    }
    this.#peerBuffered.set(conn.fromPubKey, peerTotal + n)

    try {
      await conn.socket.write(bytes)
    } catch (err) {
      if (!conn.closed) {
        this.#onLog('mesh-relay-host:data:write-failed', {
          connId: conn.connId, error: err?.message || String(err),
        })
      }
    } finally {
      const left = (this.#peerBuffered.get(conn.fromPubKey) ?? n) - n
      if (left > 0) this.#peerBuffered.set(conn.fromPubKey, left)
      else this.#peerBuffered.delete(conn.fromPubKey)
      conn.rx.consumed(n) // credit is only sent while the connection is open
    }
  }

  /**
   * Pump bytes read from the local service socket back to the remote peer as
   * `data` envelopes, no faster than the peer's credit allows. Runs until the
   * local socket closes (natural EOF) or errors, at which point the remote
   * peer is told via a `close` envelope.
   *
   * @param {string} key
   * @param {object} conn
   */
  #pumpToRemote(key, conn) {
    (async () => {
      try {
        outer: while (!conn.closed) {
          const chunk = await conn.socket.read()
          if (chunk === null) break // local service closed the connection (EOF)
          for (let off = 0; off < chunk.length;) {
            const want = Math.min(chunk.length - off, this.#flow.maxFrameBytes)
            const n = await conn.tx.reserve(want)
            if (n === 0 || conn.closed) break outer
            await this.#send(conn.fromPubKey, {
              op: 'data',
              connId: conn.connId,
              data: toBase64(chunk.subarray(off, off + n)),
            })
            off += n
          }
        }
      } catch (err) {
        if (!conn.closed) this.#onLog('mesh-relay-host:pump:error', { connId: conn.connId, error: err?.message || String(err) })
      }
      await this.#closeConnection(key, conn, { notifyPeer: true, reason: 'service closed' })
    })()
  }

  /**
   * Close a connection in both directions and free what it holds. The
   * connection is marked closed before anything is awaited, so no byte moves
   * in either direction after this is called.
   *
   * @param {string} key
   * @param {object} conn
   * @param {{notifyPeer: boolean, reason: string}} opts
   */
  async #closeConnection(key, conn, { notifyPeer, reason }) {
    if (conn.closed) return
    conn.closed = true
    this.#connections.delete(key)
    conn.tx.close()
    try { await conn.socket.close(reason) } catch { /* already closed */ }
    if (notifyPeer) {
      await this.#send(conn.fromPubKey, { op: 'close', connId: conn.connId, reason }).catch(() => {})
    }
    this.#onLog('mesh-relay-host:connection:closed', { connId: conn.connId, fromPubKey: conn.fromPubKey, reason })
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
   * relayed connection. After this the host neither accepts nor serves: a
   * connect still in flight is not acknowledged and its socket is closed.
   * Does not close `network` itself (the host doesn't own its lifecycle).
   */
  async detach() {
    this.#detached = true
    if (this.#unsubscribeIncoming) {
      this.#unsubscribeIncoming()
      this.#unsubscribeIncoming = null
    }
    if (this.#unsubscribeAccess) {
      this.#unsubscribeAccess()
      this.#unsubscribeAccess = null
    }
    if (this.#recheckTimer) {
      clearInterval(this.#recheckTimer)
      this.#recheckTimer = null
    }
    for (const [key, conn] of [...this.#connections]) {
      await this.#closeConnection(key, conn, { notifyPeer: true, reason: 'service detached' })
    }
  }
}

export { DEFAULT_ENVELOPE_TYPE, RELAY_FLOW_DEFAULTS }
