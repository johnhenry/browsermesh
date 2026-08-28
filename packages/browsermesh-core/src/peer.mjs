/**
// STATUS: EXPERIMENTAL — complete implementation, not yet integrated into main application
 * clawser-mesh-peer.js -- Peer Connection Manager.
 *
 * Discovers, connects to, and maintains connections with mesh peers.
 * Does not handle the actual transport -- delegates to MeshTransportManager.
 *
 * Peer status lifecycle: disconnected -> connecting -> connected -> authenticated
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-peer.test.mjs
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @type {readonly string[]} */
const PEER_STATUSES = Object.freeze([
  'disconnected',
  'connecting',
  'connected',
  'authenticated',
]);

// ---------------------------------------------------------------------------
// PeerState
// ---------------------------------------------------------------------------

/**
 * Immutable-ish snapshot of a single peer's connection state.
 */
export class PeerState {
  /**
   * @param {object} opts
   * @param {string} opts.fingerprint - Unique peer identifier (public key hash)
   * @param {string} [opts.label]     - Human-readable name
   * @param {string} [opts.status]    - One of PEER_STATUSES
   * @param {string|null} [opts.transport] - 'webrtc' | 'wsh-wt' | 'wsh-ws' | 'relay' | null
   * @param {string|null} [opts.endpoint] - Connection endpoint URL
   * @param {number|null} [opts.latency]  - Last measured latency in ms
   * @param {number} [opts.lastSeen]      - Unix timestamp (ms)
   * @param {string[]} [opts.capabilities] - Advertised capabilities
   * @param {number} [opts.trustLevel]     - 0 = untrusted, higher = more trust
   */
  constructor({
    fingerprint,
    label = null,
    status = 'disconnected',
    transport = null,
    endpoint = null,
    latency = null,
    lastSeen = Date.now(),
    capabilities = [],
    trustLevel = 0,
  }) {
    if (!fingerprint || typeof fingerprint !== 'string') {
      throw new Error('fingerprint is required and must be a non-empty string');
    }
    this.fingerprint = fingerprint;
    this.label = label;
    this.status = status;
    this.transport = transport;
    this.endpoint = endpoint;
    this.latency = latency;
    this.lastSeen = lastSeen;
    this.capabilities = [...capabilities];
    this.trustLevel = trustLevel;
  }

  /**
   * Serialize to a plain JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      fingerprint: this.fingerprint,
      label: this.label,
      status: this.status,
      transport: this.transport,
      endpoint: this.endpoint,
      latency: this.latency,
      lastSeen: this.lastSeen,
      capabilities: [...this.capabilities],
      trustLevel: this.trustLevel,
    };
  }

  /**
   * Re-hydrate from a plain object.
   * @param {object} data
   * @returns {PeerState}
   */
  static fromJSON(data) {
    return new PeerState(data);
  }
}

// ---------------------------------------------------------------------------
// MeshPeerManager
// ---------------------------------------------------------------------------

/**
 * Manages a registry of known mesh peers and their lifecycle.
 *
 * Fires callbacks on status transitions:
 *   - connect:     peer transitioned to 'connected' or 'authenticated'
 *   - disconnect:  peer transitioned to 'disconnected'
 *   - discovered:  new peer discovered (via relay or mDNS)
 */
export class MeshPeerManager {
  /** @type {Map<string, PeerState>} fingerprint -> PeerState */
  #peers = new Map();

  /** @type {{ connect: Function[], disconnect: Function[], discovered: Function[] }} */
  #callbacks = { connect: [], disconnect: [], discovered: [] };

  /** @type {string[]} */
  #ownCapabilities = [];

  /** @type {Function} */
  #onLog;

  /**
   * @param {object} [opts]
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   */
  constructor(opts = {}) {
    this.#onLog = opts.onLog || (() => {});
  }

  // -- Peer CRUD ----------------------------------------------------------

  /**
   * Add a new peer or update an existing one.
   *
   * @param {string} fingerprint
   * @param {object} [info] - Partial PeerState fields
   * @returns {PeerState}
   */
  addPeer(fingerprint, info = {}) {
    if (this.#peers.has(fingerprint)) {
      const existing = this.#peers.get(fingerprint);
      Object.assign(existing, info);
      return existing;
    }
    const peer = new PeerState({ fingerprint, ...info });
    this.#peers.set(fingerprint, peer);
    this.#onLog(2, `Peer added: ${fingerprint}`);
    return peer;
  }

  /**
   * Update fields on an existing peer, firing lifecycle callbacks as needed.
   *
   * @param {string} fingerprint
   * @param {object} updates - Fields to merge
   * @returns {PeerState|null}
   */
  updatePeer(fingerprint, updates) {
    const peer = this.#peers.get(fingerprint);
    if (!peer) return null;

    const oldStatus = peer.status;
    Object.assign(peer, updates);
    peer.lastSeen = Date.now();

    // Fire callbacks on status transitions
    if (
      oldStatus !== 'connected' &&
      oldStatus !== 'authenticated' &&
      (peer.status === 'connected' || peer.status === 'authenticated')
    ) {
      this.#fire('connect', peer);
    } else if (oldStatus !== 'disconnected' && peer.status === 'disconnected') {
      this.#fire('disconnect', peer);
    }

    return peer;
  }

  /**
   * Mark a peer as connected with optional transport/endpoint metadata.
   *
   * @param {string} fingerprint
   * @param {object} [opts]
   * @param {string} [opts.transport]
   * @param {string} [opts.endpoint]
   * @returns {PeerState}
   */
  connect(fingerprint, opts = {}) {
    if (!this.#peers.has(fingerprint)) {
      this.addPeer(fingerprint, opts);
    }
    this.updatePeer(fingerprint, {
      status: 'connected',
      transport: opts.transport || null,
      endpoint: opts.endpoint || null,
    });
    return this.#peers.get(fingerprint);
  }

  /**
   * Mark a peer as disconnected and clear its transport.
   *
   * @param {string} fingerprint
   */
  disconnect(fingerprint) {
    const peer = this.#peers.get(fingerprint);
    if (!peer) return;
    this.updatePeer(fingerprint, { status: 'disconnected', transport: null });
  }

  /**
   * Disconnect every known peer.
   */
  disconnectAll() {
    for (const fingerprint of this.#peers.keys()) {
      this.disconnect(fingerprint);
    }
  }

  /**
   * Remove a peer from the registry entirely.
   *
   * @param {string} fingerprint
   * @returns {boolean} true if the peer existed
   */
  removePeer(fingerprint) {
    return this.#peers.delete(fingerprint);
  }

  // -- Queries ------------------------------------------------------------

  /**
   * List peers, optionally filtering by status or minimum trust level.
   *
   * @param {object} [filter]
   * @param {string} [filter.status]
   * @param {number} [filter.minTrust]
   * @returns {PeerState[]}
   */
  listPeers(filter = {}) {
    let peers = [...this.#peers.values()];
    if (filter.status) {
      peers = peers.filter(p => p.status === filter.status);
    }
    if (filter.minTrust !== undefined) {
      peers = peers.filter(p => p.trustLevel >= filter.minTrust);
    }
    return peers;
  }

  /**
   * Get a specific peer by fingerprint.
   *
   * @param {string} fingerprint
   * @returns {PeerState|null}
   */
  getPeer(fingerprint) {
    return this.#peers.get(fingerprint) || null;
  }

  // -- Lifecycle callbacks ------------------------------------------------

  /**
   * Register a callback for when a peer becomes connected/authenticated.
   * @param {Function} cb - Receives PeerState
   */
  onPeerConnect(cb) {
    this.#callbacks.connect.push(cb);
  }

  /**
   * Register a callback for when a peer disconnects.
   * @param {Function} cb - Receives PeerState
   */
  onPeerDisconnect(cb) {
    this.#callbacks.disconnect.push(cb);
  }

  /**
   * Register a callback for when a new peer is discovered.
   * @param {Function} cb - Receives PeerState
   */
  onPeerDiscovered(cb) {
    this.#callbacks.discovered.push(cb);
  }

  // -- Discovery ----------------------------------------------------------

  /**
   * Process a batch of discovered peers (e.g. from relay or mDNS).
   * Adds them to the registry and fires 'discovered' callbacks.
   *
   * @param {object[]} peers - Array of { fingerprint, ...info }
   */
  discovered(peers) {
    for (const info of peers) {
      const peer = this.addPeer(info.fingerprint, info);
      this.#fire('discovered', peer);
    }
  }

  // -- Capabilities -------------------------------------------------------

  /**
   * Set the capabilities this node advertises to peers.
   *
   * @param {string[]} capabilities
   */
  advertise(capabilities) {
    this.#ownCapabilities = [...capabilities];
  }

  /**
   * Get the currently advertised capabilities.
   *
   * @returns {string[]}
   */
  getAdvertisedCapabilities() {
    return [...this.#ownCapabilities];
  }

  // -- Statistics ---------------------------------------------------------

  /**
   * Get aggregate connection statistics.
   *
   * @returns {{ total: number, connected: number, disconnected: number, connecting: number }}
   */
  getStats() {
    const peers = [...this.#peers.values()];
    return {
      total: peers.length,
      connected: peers.filter(
        p => p.status === 'connected' || p.status === 'authenticated',
      ).length,
      disconnected: peers.filter(p => p.status === 'disconnected').length,
      connecting: peers.filter(p => p.status === 'connecting').length,
    };
  }

  /** @returns {number} */
  get size() {
    return this.#peers.size;
  }

  // -- Serialization ------------------------------------------------------

  /**
   * Serialize all peers to a JSON-safe array.
   * @returns {object[]}
   */
  toJSON() {
    return [...this.#peers.values()].map(p => p.toJSON());
  }

  /**
   * Re-hydrate a MeshPeerManager from serialized data.
   *
   * @param {object[]} data
   * @returns {MeshPeerManager}
   */
  static fromJSON(data) {
    const mgr = new MeshPeerManager();
    for (const item of data) {
      mgr.#peers.set(item.fingerprint, PeerState.fromJSON(item));
    }
    return mgr;
  }

  // -- Internal -----------------------------------------------------------

  /**
   * Fire all callbacks for a given event, swallowing listener errors.
   * @param {string} event
   * @param {*} data
   */
  #fire(event, data) {
    for (const cb of this.#callbacks[event] || []) {
      try {
        cb(data);
      } catch {
        /* listener errors do not propagate */
      }
    }
  }
}

export { PEER_STATUSES };
