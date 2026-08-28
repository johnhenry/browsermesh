/**
 * clawser-peer-node.js -- Top-level P2P mesh orchestrator.
 *
 * Wires together IdentityWallet, PeerRegistry, DiscoveryManager,
 * MeshTransportNegotiator, and AuditChain into a unified PeerNode
 * lifecycle. All subsystems are accepted via dependency injection --
 * no imports at module level.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-node.test.mjs
 */

// ---------------------------------------------------------------------------
// Valid lifecycle states
// ---------------------------------------------------------------------------

const PEER_NODE_STATES = Object.freeze([
  'stopped',
  'booting',
  'running',
  'shutting_down',
])

// ---------------------------------------------------------------------------
// PeerNode
// ---------------------------------------------------------------------------

/**
 * Top-level orchestrator for a mesh peer. Manages the full lifecycle
 * from identity bootstrap through discovery, connection, and shutdown.
 *
 * All subsystems are injected via the constructor. Only `wallet` and
 * `registry` are required; discovery, transport negotiation, and audit
 * are optional and gracefully degrade when absent.
 */
export class PeerNode {
  /** @type {import('@johnhenry/browsermesh-core').IdentityWallet} */
  #wallet

  /** @type {import('./peer-registry.mjs').PeerRegistry} */
  #registry

  /** @type {import('@johnhenry/browsermesh-discovery').DiscoveryManager|null} */
  #discovery

  /** @type {import('@johnhenry/browsermesh-transport').MeshTransportNegotiator|null} */
  #transportNeg

  /** @type {import('./audit.mjs').AuditChain|null} */
  #auditChain

  /** @type {Map<string, object>} sessionId -> session info */
  #sessions = new Map()

  /** @type {'stopped'|'booting'|'running'|'shutting_down'} */
  #state = 'stopped'

  /** @type {Function} */
  #onLog

  /** @type {Map<string, Set<Function>>} event -> callbacks */
  #listeners = new Map()

  /** @type {Set<Function>} listeners for raw incoming session data
   *  (cb(pubKey, data, {sessionId, transport})). Used by ClawserPod
   *  to surface a pod-level message bus on top of per-transport
   *  inbound bytes. */
  #dataListeners = new Set()

  /** @type {Function|null} bound peer connect listener for cleanup */
  #boundPeerConnect = null

  /** @type {Function|null} bound peer disconnect listener for cleanup */
  #boundPeerDisconnect = null

  /**
   * @param {object} opts
   * @param {import('@johnhenry/browsermesh-core').IdentityWallet} opts.wallet
   * @param {import('./peer-registry.mjs').PeerRegistry} opts.registry
   * @param {import('@johnhenry/browsermesh-discovery').DiscoveryManager} [opts.discovery]
   * @param {import('@johnhenry/browsermesh-transport').MeshTransportNegotiator} [opts.transportNegotiator]
   * @param {import('./audit.mjs').AuditChain} [opts.auditChain]
   * @param {Function} [opts.onLog]
   */
  constructor({ wallet, registry, discovery, transportNegotiator, auditChain, onLog }) {
    if (!wallet) {
      throw new Error('wallet is required')
    }
    if (!registry) {
      throw new Error('registry is required')
    }

    this.#wallet = wallet
    this.#registry = registry
    this.#discovery = discovery || null
    this.#transportNeg = transportNegotiator || null
    this.#auditChain = auditChain || null
    this.#onLog = onLog || (() => {})
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Boot the peer node. Creates a default identity if none exist,
   * starts discovery, and transitions to 'running'.
   *
   * @param {object} [opts]
   * @param {string} [opts.label='default'] - Label for auto-created identity
   * @param {boolean} [opts.skipDiscovery=false] - Skip starting discovery
   * @returns {Promise<void>}
   */
  async boot(opts = {}) {
    if (this.#state === 'running') {
      throw new Error('PeerNode is already running')
    }
    if (this.#state === 'booting') {
      throw new Error('PeerNode is already booting')
    }
    if (this.#state === 'shutting_down') {
      throw new Error('PeerNode is shutting down')
    }

    this.#state = 'booting'
    this.#onLog('peer-node:boot:start', { state: this.#state })

    try {
      // Ensure at least one identity exists
      const identities = this.#wallet.listIdentities()
      if (identities.length === 0) {
        const label = opts.label || 'default'
        await this.#wallet.createIdentity(label)
        this.#onLog('peer-node:identity:auto-created', { label })
      }

      // Start discovery if available and not skipped
      if (this.#discovery && !opts.skipDiscovery) {
        await this.#discovery.start()
        this.#onLog('peer-node:discovery:started', {})
      }

      // Wire registry events to our event bus (store refs for cleanup)
      this.#boundPeerConnect = (peer) => { this.#emit('peer:connect', peer) } // emitted for future extension hooks
      this.#boundPeerDisconnect = (peer) => { this.#emit('peer:disconnect', peer) } // emitted for future extension hooks
      this.#registry.onPeerConnect(this.#boundPeerConnect)
      this.#registry.onPeerDisconnect(this.#boundPeerDisconnect)

      // Transition to running
      this.#state = 'running'
      this.#onLog('peer-node:boot:complete', { podId: this.podId })

      // Log boot to audit chain
      await this.#audit('peer-node:boot', {
        podId: this.podId,
        timestamp: Date.now(),
      })

      this.#emit('boot', { podId: this.podId })
    } catch (err) {
      this.#state = 'stopped'
      this.#onLog('peer-node:boot:failed', { error: err.message })
      throw err
    }
  }

  /**
   * Shut down the peer node. Stops discovery, disconnects all peers,
   * cleans up sessions, and transitions to 'stopped'.
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (this.#state === 'stopped') {
      return
    }
    if (this.#state === 'shutting_down') {
      throw new Error('PeerNode is already shutting down')
    }

    const previousState = this.#state
    this.#state = 'shutting_down'
    this.#onLog('peer-node:shutdown:start', { previousState })

    try {
      // Stop discovery
      if (this.#discovery) {
        await this.#discovery.stop()
        this.#onLog('peer-node:discovery:stopped', {})
      }

      // Remove registry event listeners to prevent accumulation on re-boot
      if (this.#boundPeerConnect && this.#registry.offPeerConnect) {
        this.#registry.offPeerConnect(this.#boundPeerConnect)
      }
      if (this.#boundPeerDisconnect && this.#registry.offPeerDisconnect) {
        this.#registry.offPeerDisconnect(this.#boundPeerDisconnect)
      }
      this.#boundPeerConnect = null
      this.#boundPeerDisconnect = null

      // Disconnect all peers
      this.#registry.disconnectAll()

      // Clear all sessions
      this.#sessions.clear()

      // Log shutdown to audit chain
      await this.#audit('peer-node:shutdown', {
        podId: this.podId,
        timestamp: Date.now(),
      })

      this.#state = 'stopped'
      this.#onLog('peer-node:shutdown:complete', {})
      this.#emit('shutdown', { podId: this.podId })
    } catch (err) {
      // Force stopped even on error
      this.#state = 'stopped'
      this.#onLog('peer-node:shutdown:error', { error: err.message })
      throw err
    }
  }

  /**
   * Current lifecycle state.
   *
   * @returns {'stopped'|'booting'|'running'|'shutting_down'}
   */
  get state() {
    return this.#state
  }

  // -----------------------------------------------------------------------
  // Identity shortcuts
  // -----------------------------------------------------------------------

  /**
   * The default identity's podId, or null if no identities exist.
   *
   * @returns {string|null}
   */
  get podId() {
    const def = this.#wallet.getDefault()
    return def ? def.podId : null
  }

  /**
   * The identity wallet.
   *
   * @returns {import('@johnhenry/browsermesh-core').IdentityWallet}
   */
  get wallet() {
    return this.#wallet
  }

  // -----------------------------------------------------------------------
  // Registry shortcuts
  // -----------------------------------------------------------------------

  /**
   * The peer registry.
   *
   * @returns {import('./peer-registry.mjs').PeerRegistry}
   */
  get registry() {
    return this.#registry
  }

  /**
   * Add a peer to the registry.
   *
   * @param {string} pubKey - Peer fingerprint / public key hash
   * @param {string} [label] - Human-readable name
   * @param {string[]} [caps] - Initial capability scopes
   * @returns {import('@johnhenry/browsermesh-core').PeerState}
   */
  addPeer(pubKey, label, caps) {
    this.#ensureRunning('addPeer')
    const peer = this.#registry.addPeer(pubKey, label, caps)
    this.#onLog('peer-node:peer:add', { pubKey, label })
    return peer
  }

  /**
   * Remove a peer from the registry and clean up its sessions.
   *
   * @param {string} pubKey
   * @returns {boolean} true if the peer existed
   */
  removePeer(pubKey) {
    this.#ensureRunning('removePeer')

    // Remove any sessions associated with this peer
    for (const [sessionId, session] of this.#sessions) {
      if (session.pubKey === pubKey) {
        this.#sessions.delete(sessionId)
      }
    }

    const removed = this.#registry.removePeer(pubKey)
    if (removed) {
      this.#onLog('peer-node:peer:remove', { pubKey })
    }
    return removed
  }

  /**
   * List peers, optionally filtered.
   *
   * @param {object} [filter]
   * @param {string} [filter.status]
   * @param {number} [filter.minTrust]
   * @returns {import('@johnhenry/browsermesh-core').PeerState[]}
   */
  listPeers(filter) {
    return this.#registry.listPeers(filter)
  }

  // -----------------------------------------------------------------------
  // Connection management
  // -----------------------------------------------------------------------

  /**
   * Connect to a peer using the transport negotiator (if available)
   * or falling back to direct registry connection.
   *
   * Creates a session entry and logs the connection to the audit chain.
   *
   * @param {string} pubKey - Peer fingerprint / public key hash
   * @param {object} [endpoints] - Map of transport type -> endpoint string
   * @param {object} [auth] - Auth credentials for transport negotiation
   * @returns {Promise<object>} Session info
   */
  async connectToPeer(pubKey, endpoints, auth) {
    this.#ensureRunning('connectToPeer')

    let transport = null
    let transportType = null

    // Try transport negotiation if we have a negotiator and endpoints
    if (this.#transportNeg && endpoints && Object.keys(endpoints).length > 0) {
      try {
        transport = await this.#transportNeg.negotiate(endpoints, auth)
        transportType = transport.type
        this.#onLog('peer-node:transport:negotiated', { pubKey, type: transportType })
      } catch (err) {
        this.#onLog('peer-node:transport:negotiation-failed', {
          pubKey,
          error: err.message,
        })
        // Fall through to direct registry connection
      }
    }

    // Connect through the registry
    const connectOpts = {}
    if (transportType) connectOpts.transport = transportType
    if (endpoints) {
      // Use the first available endpoint as a fallback
      const firstEndpoint = Object.values(endpoints)[0]
      if (firstEndpoint) connectOpts.endpoint = firstEndpoint
    }

    this.#registry.connect(pubKey, connectOpts)

    // Create session
    const sessionId = crypto.randomUUID()
    const session = {
      sessionId,
      pubKey,
      transport: transportType,
      transportInstance: transport,
      connectedAt: Date.now(),
      state: 'active',
    }
    this.#sessions.set(sessionId, session)

    // Wire inbound data fan-out — every connected transport pushes
    // received bytes to subscribers registered via `onIncomingData`.
    // This is what backs `ClawserPod.onMessage` so workspace consumers
    // can route incoming sync/deploy envelopes by `envelope.type`.
    if (transport && typeof transport.onMessage === 'function') {
      transport.onMessage((data) => {
        for (const cb of this.#dataListeners) {
          try { cb(pubKey, data, { sessionId, transport: transportType }) }
          catch (err) { this.#onLog('peer-node:data-listener-error', { error: err?.message || String(err) }) }
        }
      })
    }

    this.#onLog('peer-node:session:created', { sessionId, pubKey, transport: transportType })

    // Log to audit chain
    await this.#audit('peer-node:connect', {
      sessionId,
      pubKey,
      transport: transportType,
    })

    return { ...session, transportInstance: undefined }
  }

  /**
   * Send raw bytes/data to a connected peer via its current transport
   * session. Looks up the most recently-created active session for the
   * given pubKey and calls `transport.send(data)`.
   *
   * Throws when no active session exists for the peer (caller should
   * either connect first or surface the error to the user).
   *
   * @param {string} pubKey - Peer fingerprint / public key hash
   * @param {*} data - Wire payload to send. Format is transport-defined;
   *   typical callers stringify a JSON envelope first.
   * @returns {Promise<void>} Resolves when the underlying transport
   *   has accepted the send (transport-defined; some are fire-and-
   *   forget, others await an ack).
   *
   * @example
   *   await peerNode.sendTo('podid_abc', JSON.stringify({ type: 'ping' }));
   */
  async sendTo(pubKey, data) {
    this.#ensureRunning('sendTo');
    let session = null;
    for (const [, s] of this.#sessions) {
      if (s.pubKey === pubKey && s.state === 'active') {
        // Prefer the most recently-created active session
        if (!session || (s.connectedAt || 0) > (session.connectedAt || 0)) session = s;
      }
    }
    if (!session) {
      throw new Error(`PeerNode.sendTo: no active session for pubKey ${pubKey}`);
    }
    if (!session.transportInstance || typeof session.transportInstance.send !== 'function') {
      throw new Error(`PeerNode.sendTo: session for ${pubKey} has no transport.send`);
    }
    return session.transportInstance.send(data);
  }

  /**
   * Subscribe to raw incoming data from any session. The callback
   * receives `(pubKey, data, {sessionId, transport})`. Used by
   * `ClawserPod.onMessage` to fan an envelope-level dispatch on
   * top of per-transport bytes. Returns an unsubscribe function.
   *
   * @param {(pubKey:string, data:any, meta:{sessionId:string, transport:string}) => void} cb
   * @returns {() => void}
   */
  onIncomingData(cb) {
    if (typeof cb !== 'function') return () => {}
    this.#dataListeners.add(cb)
    return () => this.#dataListeners.delete(cb)
  }

  /**
   * Whether the peer has an active session ready for `sendTo`.
   *
   * @param {string} pubKey
   * @returns {boolean}
   */
  hasActiveSession(pubKey) {
    for (const [, s] of this.#sessions) {
      if (s.pubKey === pubKey && s.state === 'active') return true;
    }
    return false;
  }

  /**
   * Disconnect a peer and clean up its sessions.
   *
   * @param {string} pubKey
   */
  disconnectPeer(pubKey) {
    this.#ensureRunning('disconnectPeer')

    // Close transport instances and remove sessions for this peer
    for (const [sessionId, session] of this.#sessions) {
      if (session.pubKey === pubKey) {
        if (session.transportInstance && typeof session.transportInstance.close === 'function') {
          try {
            session.transportInstance.close()
          } catch {
            // Swallow close errors
          }
        }
        session.state = 'closed'
        this.#sessions.delete(sessionId)
        this.#onLog('peer-node:session:closed', { sessionId, pubKey })
      }
    }

    this.#registry.disconnect(pubKey)
    this.#onLog('peer-node:peer:disconnect', { pubKey })
  }

  // -----------------------------------------------------------------------
  // Session tracking
  // -----------------------------------------------------------------------

  /**
   * Get a session by ID.
   *
   * @param {string} sessionId
   * @returns {object|null} Session info (without transport instance)
   */
  getSession(sessionId) {
    const session = this.#sessions.get(sessionId)
    if (!session) return null
    return { ...session, transportInstance: undefined }
  }

  /**
   * List all active sessions.
   *
   * @returns {object[]} Session info array (without transport instances)
   */
  listSessions() {
    const result = []
    for (const session of this.#sessions.values()) {
      result.push({ ...session, transportInstance: undefined })
    }
    return result
  }

  // -----------------------------------------------------------------------
  // Discovery
  // -----------------------------------------------------------------------

  /**
   * Announce this node to the mesh network via discovery.
   * No-op if discovery is not configured.
   *
   * @returns {Promise<void>}
   */
  async announce() {
    this.#ensureRunning('announce')

    if (!this.#discovery) {
      this.#onLog('peer-node:announce:skip', { reason: 'no discovery manager' })
      return
    }

    await this.#discovery.announce()
    this.#onLog('peer-node:announce:complete', { podId: this.podId })
  }

  /**
   * Discover peers on the mesh network.
   * Returns an empty array if discovery is not configured.
   *
   * @param {object} [filter]
   * @param {string[]} [filter.capabilities] - Required capabilities
   * @returns {Promise<import('@johnhenry/browsermesh-discovery').DiscoveryRecord[]>}
   */
  async discover(filter) {
    this.#ensureRunning('discover')

    if (!this.#discovery) {
      this.#onLog('peer-node:discover:skip', { reason: 'no discovery manager' })
      return []
    }

    const records = await this.#discovery.discover(filter)
    this.#onLog('peer-node:discover:complete', { count: records.length })
    return records
  }

  // -----------------------------------------------------------------------
  // Audit
  // -----------------------------------------------------------------------

  /**
   * Log an action to the audit chain.
   * No-op if audit chain is not configured.
   *
   * @param {string} operation - Operation name
   * @param {*} data - Arbitrary payload
   * @returns {Promise<void>}
   */
  async logAction(operation, data) {
    await this.#audit(operation, data)
  }

  /**
   * Get all audit entries.
   * Returns an empty array if audit chain is not configured.
   *
   * @returns {import('./audit.mjs').AuditEntry[]}
   */
  getAuditEntries() {
    if (!this.#auditChain) return []
    return [...this.#auditChain.entries()]
  }

  // -----------------------------------------------------------------------
  // Events
  // -----------------------------------------------------------------------

  /**
   * Register a callback for a node event.
   *
   * Supported events:
   *   - 'peer:connect'    — fired when a peer connects
   *   - 'peer:disconnect' — fired when a peer disconnects
   *   - 'boot'            — fired after successful boot
   *   - 'shutdown'        — fired after shutdown
   *
   * @param {string} event
   * @param {Function} cb
   */
  on(event, cb) {
    if (typeof cb !== 'function') {
      throw new Error('Callback must be a function')
    }
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set())
    }
    this.#listeners.get(event).add(cb)
  }

  /**
   * Remove a callback for a node event.
   *
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const cbs = this.#listeners.get(event)
    if (cbs) {
      cbs.delete(cb)
      if (cbs.size === 0) {
        this.#listeners.delete(event)
      }
    }
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Serialize the PeerNode state to a JSON-safe object.
   * Includes wallet, registry, discovery, audit, and session data.
   *
   * @returns {object}
   */
  toJSON() {
    const sessions = []
    for (const session of this.#sessions.values()) {
      sessions.push({
        sessionId: session.sessionId,
        pubKey: session.pubKey,
        transport: session.transport,
        connectedAt: session.connectedAt,
        state: session.state,
      })
    }

    return {
      state: this.#state,
      wallet: this.#wallet.toJSON(),
      registry: this.#registry.toJSON(),
      discovery: this.#discovery && typeof this.#discovery.toJSON === 'function'
        ? this.#discovery.toJSON()
        : null,
      auditChain: this.#auditChain && typeof this.#auditChain.toJSON === 'function'
        ? this.#auditChain.toJSON()
        : null,
      sessions,
    }
  }

  /**
   * Restore a PeerNode from serialized data.
   *
   * Subsystem instances must be provided via deps since they cannot be
   * reconstructed from JSON alone (they require their own constructors
   * and injected dependencies).
   *
   * @param {object} data - Output of toJSON()
   * @param {object} deps - Pre-constructed subsystem instances
   * @param {import('@johnhenry/browsermesh-core').IdentityWallet} deps.wallet
   * @param {import('./peer-registry.mjs').PeerRegistry} deps.registry
   * @param {import('@johnhenry/browsermesh-discovery').DiscoveryManager} [deps.discovery]
   * @param {import('@johnhenry/browsermesh-transport').MeshTransportNegotiator} [deps.transportNegotiator]
   * @param {import('./audit.mjs').AuditChain} [deps.auditChain]
   * @param {Function} [deps.onLog]
   * @returns {PeerNode}
   */
  static fromJSON(data, deps) {
    if (!deps || !deps.wallet || !deps.registry) {
      throw new Error('deps.wallet and deps.registry are required')
    }

    const node = new PeerNode({
      wallet: deps.wallet,
      registry: deps.registry,
      discovery: deps.discovery || null,
      transportNegotiator: deps.transportNegotiator || null,
      auditChain: deps.auditChain || null,
      onLog: deps.onLog,
    })

    // Restore sessions
    if (Array.isArray(data?.sessions)) {
      for (const s of data.sessions) {
        if (s.sessionId) {
          node.#sessions.set(s.sessionId, {
            sessionId: s.sessionId,
            pubKey: s.pubKey,
            transport: s.transport || null,
            transportInstance: null,
            connectedAt: s.connectedAt || 0,
            state: s.state || 'closed',
          })
        }
      }
    }

    // Restore lifecycle state — always restore as 'stopped'. A restored
    // node must call boot() to re-wire event listeners and discovery.
    // Restoring as 'running' would skip the boot sequence, leaving event
    // bridging unwired.
    node.#state = 'stopped'

    return node
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Emit an event to all registered listeners. Swallows listener errors.
   *
   * @param {string} event
   * @param {*} data
   */
  #emit(event, data) {
    const cbs = this.#listeners.get(event)
    if (!cbs || cbs.size === 0) return
    for (const cb of [...cbs]) {
      try {
        cb(data)
      } catch {
        // Listener errors do not propagate
      }
    }
  }

  /**
   * Append an entry to the audit chain if available.
   * Uses the default identity's podId as the author, and the wallet's
   * sign method for the signature.
   *
   * @param {string} operation
   * @param {*} data
   * @returns {Promise<void>}
   */
  async #audit(operation, data) {
    if (!this.#auditChain) return

    const podId = this.podId
    if (!podId) return

    try {
      await this.#auditChain.append(
        podId,
        operation,
        data,
        (payload) => this.#wallet.sign(podId, payload),
      )
    } catch (err) {
      // Audit failures are logged but do not break operations
      this.#onLog('peer-node:audit:error', { operation, error: err.message })
    }
  }

  /**
   * Guard that throws if the node is not in the 'running' state.
   *
   * @param {string} method - Name of the calling method, for the error message
   */
  #ensureRunning(method) {
    if (this.#state !== 'running') {
      throw new Error(`PeerNode must be running to call ${method}() (current state: ${this.#state})`)
    }
  }
}

export { PEER_NODE_STATES }
