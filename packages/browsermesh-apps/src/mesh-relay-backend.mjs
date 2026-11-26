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
 *
 * `@johnhenry/browsermesh-netway` (an optional peerDependency) is lazily
 * resolved via `createLazyRequire(import.meta.url)`
 * (`./internal/lazy-node-require.mjs`, using
 * `process.getBuiltinModule('module')` rather than a static
 * `import ... from 'node:module'`, so no Node-only code runs merely from
 * importing this file -- see issue #183). `Backend` is used as a
 * base class (`class MeshRelayBackend extends Backend`); a class's
 * `extends` clause is evaluated at class-DECLARATION time, and a
 * `class ... extends ... {}` statement written at module top level always
 * runs at module-LOAD time, no matter how the `Backend` reference feeding
 * it is obtained -- there is no way to defer that with a plain lazy
 * import, sync or async (see `cloud-storage-backend.mjs`'s identical
 * constraint). The fix here instead moves the class declaration itself out
 * of module-top-level scope, into a function that resolves `Backend` via
 * `require()` and builds+memoizes the class on first call, so it still
 * only runs once, lazily, the first time this file is actually used, not
 * merely imported.
 *
 * **BREAKING CHANGE**: `MeshRelayBackend` is no longer exported as a
 * class. Replace `new MeshRelayBackend(opts)` with
 * `createMeshRelayBackend(opts)` (same `opts` shape, still returns a real
 * `MeshRelayBackend` instance with the exact same instance API) -- see the
 * CHANGELOG entry documenting this fix across the package for the full
 * rationale and the sibling `cloud-storage-backend.mjs` fix.
 */

import { createLazyRequire } from './internal/lazy-node-require.mjs'
import { decodeWireData } from './internal/wire-envelope.mjs'
import { randomUUID } from './internal/secure-id.mjs'
import { CreditReceiver, CreditSender, resolveFlowOptions } from './internal/relay-flow.mjs'

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

let _MeshRelayBackendClass = null

/**
 * Lazily builds (and memoizes) the `MeshRelayBackend` class, deferring
 * resolution of `@johnhenry/browsermesh-netway`'s `Backend` past
 * module-load time -- see module doc comment. Only ever runs once per
 * process; every later call returns the same class reference.
 * @returns {typeof MeshRelayBackend}
 */
function resolveMeshRelayBackendClass() {
  if (_MeshRelayBackendClass) return _MeshRelayBackendClass
  const require = createLazyRequire(import.meta.url)
  const { Backend, StreamSocket, ConnectionRefusedError } = require('@johnhenry/browsermesh-netway')

  /**
   * A `Backend` that relays TCP-like `connect()`s through one specific mesh
   * peer's `MeshRelayHost`, over `PeerNode.sendTo()`/`onIncomingData()`.
   *
   * @extends Backend
   */
  class MeshRelayBackend extends Backend {
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

  /** @type {Map<string, {socket: import('@johnhenry/browsermesh-netway').StreamSocket, tx: CreditSender, rx: CreditReceiver, closed: boolean}>} connId -> relay-side connection */
  #connections = new Map()

  /** @type {Readonly<import('./internal/relay-flow.mjs').RELAY_FLOW_DEFAULTS>} */
  #flow

  /** @type {(() => void)|null} */
  #unsubscribeIncoming = null

  /**
   * @param {object} opts
   * @param {import('./peer-node.mjs').PeerNode} opts.node
   * @param {string} opts.relayPeerPubKey - The `MeshRelayHost` peer's fingerprint/pubkey.
   * @param {string} [opts.envelopeType='mesh-relay']
   * @param {number} [opts.connectTimeoutMs=15000] - `0` disables the timeout.
   * @param {Function} [opts.onLog]
   * @param {number} [opts.highWaterBytes=262144] - Receive window per connection; the host pauses at it.
   * @param {number} [opts.lowWaterBytes=65536]
   * @param {number} [opts.maxBufferedBytesPerConnection=1048576] - Hard cap on bytes received and not yet consumed.
   * @param {number} [opts.maxFrameBytes=65536]
   */
  constructor({ node, relayPeerPubKey, envelopeType, connectTimeoutMs, onLog, ...flow } = {}) {
    super()
    if (!node) throw new Error('node is required')
    if (!relayPeerPubKey || typeof relayPeerPubKey !== 'string') {
      throw new Error('relayPeerPubKey is required')
    }

    this.#flow = resolveFlowOptions(flow)
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

    const connId = randomUUID()
    const pending = new Promise((resolve, reject) => {
      this.#pending.set(connId, { resolve, reject, service: host })
    })

    // `halfClose: true` says this backend understands the `end` frame; a host that does not ignores it and answers without
    // it, and then an end of stream is a full close, as it always was.
    await this.#send({ op: 'connect', connId, service: host, window: this.#flow.highWaterBytes, halfClose: true })

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
    data = decodeWireData(data)
    if (!data || typeof data !== 'object' || data.type !== this.#envelopeType) return
    const { op, connId } = data
    if (!connId || typeof connId !== 'string') return

    if (op === 'ok') {
      const pending = this.#pending.get(connId)
      if (!pending) return
      this.#pending.delete(connId)

      const [userSocket, relaySocket] = StreamSocket.createPair()
      // The host advertises a window only if it understands credit; an older
      // host is sent no credit frames and is held to the buffer bound only.
      const creditAware = Number.isInteger(data.window) && data.window > 0
      const conn = {
        socket: relaySocket,
        user: userSocket,
        closed: false,
        // Half-close only if the host said so in its ok (it understood our connect's halfClose).
        halfClose: data.halfClose === true,
        localEnded: false, remoteEnded: false, lastActive: Date.now(), idleTimer: null,
        tx: new CreditSender({
          window: creditAware ? Math.min(data.window, this.#flow.maxBufferedBytesPerConnection) : 0,
          lowWater: this.#flow.lowWaterBytes,
        }),
        rx: new CreditReceiver({
          window: this.#flow.highWaterBytes,
          lowWater: this.#flow.lowWaterBytes,
          maxBuffered: this.#flow.maxBufferedBytesPerConnection,
          creditAware,
          grant: (bytes) => {
            if (!conn.closed) { conn.lastActive = Date.now(); this.#send({ op: 'credit', connId, bytes }).catch(() => {}) }
          },
        }),
      }
      this.#connections.set(connId, conn)
      this.#pumpToRemote(connId, conn)
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
    const conn = this.#connections.get(connId)
    if (!conn) return

    if (op === 'data') {
      if (typeof data.data !== 'string') return
      if (conn.remoteEnded) return // the host said it was done sending: nothing more is taken from it
      conn.lastActive = Date.now()
      const approx = Math.floor((data.data.length * 3) / 4)
      if (approx > this.#flow.maxBufferedBytesPerConnection
        || (conn.rx.creditAware && approx > this.#flow.maxFrameBytes + 3)) {
        this.#closeConnection(connId, conn, { notifyHost: true, reason: 'buffer limit exceeded' })
        return
      }
      const bytes = fromBase64(data.data)
      const verdict = conn.rx.receive(bytes.length)
      if (verdict !== 'ok') {
        this.#closeConnection(connId, conn, {
          notifyHost: true,
          reason: verdict === 'violation' ? 'flow control violation' : 'buffer limit exceeded',
        })
        return
      }
      try {
        await conn.socket.write(bytes)
      } catch (err) {
        if (!conn.closed) this.#onLog('mesh-relay-backend:data:write-failed', { connId, error: err?.message || String(err) })
      } finally {
        conn.rx.consumed(bytes.length)
      }
      return
    }

    if (op === 'credit') {
      if (conn.tx.enabled && !conn.tx.credit(data.bytes)) {
        this.#closeConnection(connId, conn, { notifyHost: true, reason: 'flow control violation' })
      } else {
        conn.lastActive = Date.now()
      }
      return
    }

    if (op === 'end') {
      // The host will send no more (the service finished sending), on a connection that negotiated half-close: the application
      // reads the end of stream and may go on writing. Without that negotiation an `end` is not a frame this backend was told to expect.
      if (!conn.halfClose || conn.remoteEnded) return
      conn.remoteEnded = true
      conn.lastActive = Date.now()
      try { await conn.socket.end() } catch { /* the application closed meanwhile */ }
      if (conn.closed) return
      if (conn.localEnded) this.#finish(connId, conn)
      else this.#watchIdle(connId, conn)
      return
    }

    if (op === 'close') {
      await this.#closeConnection(connId, conn, {
        notifyHost: false,
        reason: typeof data.reason === 'string' ? data.reason.slice(0, 200) : 'closed by host',
      })
    }
  }

  /**
   * Close a relayed connection: both endpoints of the local socket pair see
   * end of stream and `closeReason`.
   *
   * @param {string} connId
   * @param {{socket: object, tx: CreditSender, closed: boolean}} conn
   * @param {{notifyHost: boolean, reason: string}} opts
   */
  async #closeConnection(connId, conn, { notifyHost, reason }) {
    if (conn.closed) return
    conn.closed = true
    this.#connections.delete(connId)
    clearTimeout(conn.idleTimer)
    conn.tx.close()
    try { await conn.socket.close(reason) } catch { /* already closed */ }
    if (notifyHost) await this.#send({ op: 'close', connId, reason }).catch(() => {})
  }

  /**
   * Half-closed: close the connection when nothing has moved in either direction for `halfCloseIdleMs`. One timer; traffic only
   * stamps `lastActive`, and the timer re-arms for what is left of the bound when it fires.
   */
  #watchIdle(connId, conn) {
    const ms = this.#flow.halfCloseIdleMs
    conn.lastActive = Date.now()
    if (!(ms > 0) || conn.idleTimer || conn.closed) return
    const check = () => {
      conn.idleTimer = null
      if (conn.closed) return
      const left = conn.lastActive + ms - Date.now()
      if (left > 0) { conn.idleTimer = setTimeout(check, left); conn.idleTimer.unref?.(); return }
      this.#closeConnection(connId, conn, { notifyHost: true, reason: 'idle timeout' })
    }
    conn.idleTimer = setTimeout(check, ms)
    conn.idleTimer.unref?.()
  }

  /** Both sides have finished sending: the connection is over; nothing needs saying to the host, which finishes the same way. */
  #finish(connId, conn) {
    if (conn.closed) return
    conn.closed = true
    this.#connections.delete(connId)
    clearTimeout(conn.idleTimer)
    conn.tx.close()
    Promise.resolve(conn.socket.close()).catch(() => {})
  }

  /**
   * Counters for bytes held for relayed connections.
   * `bufferedBytes`: received and not yet accepted by the user-facing socket,
   * plus bytes the user wrote that the relay has not yet read (bytes held in
   * the user-facing socket's own receive window are not counted);
   * `inFlightBytes`: sent to the host and not yet credited back.
   *
   * @returns {{ connections: number, bufferedBytes: number, inFlightBytes: number }}
   */
  stats() {
    let bufferedBytes = 0
    let inFlightBytes = 0
    for (const conn of this.#connections.values()) {
      bufferedBytes += conn.rx.outstanding + (conn.socket.readableLength ?? 0)
      inFlightBytes += conn.tx.inFlight
    }
    return { connections: this.#connections.size, bufferedBytes, inFlightBytes }
  }

  /**
   * Pump bytes written to the user-facing socket to the relay-host peer as
   * `data` envelopes. Runs until the relay-side socket closes (the user
   * closed their side), at which point the host is told via `close`.
   *
   * @param {string} connId
   * @param {import('@johnhenry/browsermesh-netway').StreamSocket} relaySocket
   */
  #pumpToRemote(connId, conn) {
    (async () => {
      let eof = false
      try {
        outer: while (!conn.closed) {
          const chunk = await conn.socket.read()
          if (chunk === null) { eof = true; break }
          conn.lastActive = Date.now()
          for (let off = 0; off < chunk.length;) {
            const want = Math.min(chunk.length - off, this.#flow.maxFrameBytes)
            const n = await conn.tx.reserve(want)
            if (n === 0 || conn.closed) break outer
            await this.#send({ op: 'data', connId, data: toBase64(chunk.subarray(off, off + n)) })
            off += n
          }
        }
      } catch (err) {
        if (!conn.closed) this.#onLog('mesh-relay-backend:pump:error', { connId, error: err?.message || String(err) })
      }
      // The application finished sending (`end()`): with a host that understands half-close that is only "no more from me", the
      // host's answer is still delivered, and the connection is over when the host has finished too. An application that closed
      // or destroyed its socket has discarded the connection and reads nothing more: that, and any host that predates half-close,
      // is a full close, as before.
      if (eof && conn.halfClose && !conn.closed && !conn.user.closed) {
        conn.localEnded = true
        await this.#send({ op: 'end', connId }).catch(() => {})
        if (conn.closed) return
        if (conn.remoteEnded) this.#finish(connId, conn)
        else this.#watchIdle(connId, conn)
        return
      }
      await this.#closeConnection(connId, conn, { notifyHost: true, reason: 'closed by client' })
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
    for (const [connId, conn] of [...this.#connections]) {
      await this.#closeConnection(connId, conn, { notifyHost: false, reason: 'relay backend closed' })
    }
    for (const [connId, pending] of [...this.#pending]) {
      this.#pending.delete(connId)
      pending.reject(new Error('MeshRelayBackend closed'))
    }
  }
  }

  _MeshRelayBackendClass = MeshRelayBackend
  return MeshRelayBackend
}

/**
 * Construct a `MeshRelayBackend` -- the class itself is no longer exported
 * directly (see module doc comment's "BREAKING CHANGE" note).
 *
 * @param {object} opts - Same shape as `MeshRelayBackend`'s constructor:
 *   `{node, relayPeerPubKey, envelopeType?, connectTimeoutMs?, onLog?}`.
 * @returns {import('@johnhenry/browsermesh-netway').Backend} A real
 *   `MeshRelayBackend` instance (the full instance API is unchanged).
 */
export function createMeshRelayBackend(opts) {
  const MeshRelayBackend = resolveMeshRelayBackendClass()
  return new MeshRelayBackend(opts)
}

export { DEFAULT_ENVELOPE_TYPE }
