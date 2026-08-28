import { silentCatch } from './silent-catch.mjs'
/**
 * clawser-mesh-discovery.js -- Peer discovery and service directory for BrowserMesh.
 *
 * Provides multi-strategy peer discovery (BroadcastChannel, relay, manual) and
 * a local service directory with svc:// URI routing for the mesh network.
 *
 * DiscoveryRecord represents a discovered peer with TTL-based expiration.
 * DiscoveryStrategy is the abstract base for pluggable discovery backends.
 * BroadcastChannelStrategy discovers peers in same-origin tabs via BroadcastChannel.
 * RelayStrategy discovers peers via a relay/signaling server.
 * ManualStrategy allows explicit peer addition and removal.
 * DiscoveryManager orchestrates multiple strategies with periodic announce/prune.
 * ServiceEndpoint describes a svc:// service offered by a pod.
 * ServiceDirectory manages local and remote service registrations with URI lookup.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-discovery.test.mjs
 */

// ---------------------------------------------------------------------------
// Wire Constants
// ---------------------------------------------------------------------------

/** Discovery announcement message type. */
export const DISCOVERY_ANNOUNCE = 0xC0;

/** Discovery query message type. */
export const DISCOVERY_QUERY = 0xC1;

/** Discovery response message type. */
export const DISCOVERY_RESPONSE = 0xC2;

/** Discovery goodbye (peer departure) message type. */
export const DISCOVERY_GOODBYE = 0xC3;

/** Service registration message type. */
export const SVC_REGISTER = 0xC4;

/** Service lookup message type. */
export const SVC_LOOKUP = 0xC5;

/** SharedWorker relay register message type. */
export const RELAY_REGISTER = 0x96;

/** SharedWorker relay query message type. */
export const RELAY_QUERY = 0x97;

// ---------------------------------------------------------------------------
// PEER_TYPE — taxonomy
// ---------------------------------------------------------------------------

/**
 * Canonical peer type taxonomy.
 *
 * - `chat`       — Standard agent peer offering conversational chat.
 * - `runtime`    — Hosts a remote-runtime endpoint (wsh server, exec
 *                  capable). Routing prefers these for code/file ops.
 * - `host-shell` — A fixed host shell (e.g. browser tab acting as a
 *                  stationary backplane); accepts inbound `wsh` sessions.
 * - `vm-compute` — VM-backed compute peer (v86/WebVM); routing target for
 *                  long-running compute jobs that need a real OS.
 * - `unknown`    — Default for older peers without a `peerType` field.
 *
 * @readonly
 */
export const PEER_TYPE = Object.freeze({
  CHAT: 'chat',
  RUNTIME: 'runtime',
  HOST_SHELL: 'host-shell',
  VM_COMPUTE: 'vm-compute',
  UNKNOWN: 'unknown',
});

/** @type {ReadonlySet<string>} Valid peer-type values. */
export const PEER_TYPES = new Set(Object.values(PEER_TYPE));

// ---------------------------------------------------------------------------
// DiscoveryRecord
// ---------------------------------------------------------------------------

/**
 * Represents a discovered peer in the mesh network.
 */
export class DiscoveryRecord {
  /**
   * @param {object} opts
   * @param {string} opts.podId          - Unique pod identifier
   * @param {string} [opts.label]        - Human-readable label
   * @param {string} [opts.endpoint]     - Connection endpoint (URL)
   * @param {string} [opts.transport]    - Transport protocol name
   * @param {string[]} [opts.capabilities] - List of capability tags
   * @param {object} [opts.metadata]     - Arbitrary metadata
   * @param {number} [opts.ttl]          - Time-to-live in ms (default 30000)
   * @param {number} [opts.discoveredAt] - Timestamp when discovered
   * @param {string} [opts.source]       - Discovery source strategy type
   * @param {string} [opts.peerType]     - Canonical peer type (see PEER_TYPE).
   *   Unknown values are accepted but normalised to `'unknown'` to keep the
   *   wire format forward-compatible with future taxonomies.
   */
  constructor({
    podId,
    label = null,
    endpoint = null,
    transport = null,
    capabilities = [],
    metadata = {},
    ttl = 30_000,
    discoveredAt,
    source = null,
    peerType = PEER_TYPE.UNKNOWN,
  }) {
    if (!podId || typeof podId !== 'string') {
      throw new Error('podId is required and must be a non-empty string');
    }
    this.podId = podId;
    this.label = label;
    this.endpoint = endpoint;
    this.transport = transport;
    this.capabilities = [...capabilities];
    this.metadata = { ...metadata };
    this.ttl = ttl;
    this.discoveredAt = discoveredAt ?? Date.now();
    this.source = source;
    this.peerType = PEER_TYPES.has(peerType) ? peerType : PEER_TYPE.UNKNOWN;
  }

  /**
   * Check whether this record has expired.
   *
   * @param {number} [now=Date.now()] - Current timestamp in ms
   * @returns {boolean}
   */
  isExpired(now = Date.now()) {
    return now >= this.discoveredAt + this.ttl;
  }

  /**
   * Check whether this record matches a filter.
   *
   * @param {object} [filter]
   * @param {string[]} [filter.capabilities] - Required capabilities
   * @param {string|string[]} [filter.peerType] - Required peer type(s)
   * @returns {boolean}
   */
  matchesFilter(filter) {
    if (!filter) return true;
    if (filter.capabilities) {
      for (const cap of filter.capabilities) {
        if (!this.capabilities.includes(cap)) return false;
      }
    }
    if (filter.peerType) {
      const allowed = Array.isArray(filter.peerType) ? filter.peerType : [filter.peerType];
      if (!allowed.includes(this.peerType)) return false;
    }
    return true;
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      podId: this.podId,
      label: this.label,
      endpoint: this.endpoint,
      transport: this.transport,
      capabilities: [...this.capabilities],
      metadata: { ...this.metadata },
      ttl: this.ttl,
      discoveredAt: this.discoveredAt,
      source: this.source,
      peerType: this.peerType,
    };
  }

  /**
   * Re-hydrate from a plain object.
   * @param {object} data
   * @returns {DiscoveryRecord}
   */
  static fromJSON(data) {
    return new DiscoveryRecord(data);
  }
}

// ---------------------------------------------------------------------------
// DiscoveryStrategy (abstract base)
// ---------------------------------------------------------------------------

/**
 * Abstract base class for discovery backends.
 * Subclasses must implement start(), stop(), announce(), and query().
 */
export class DiscoveryStrategy {
  /** @type {string} */
  #type;

  /** @type {boolean} */
  #active = false;

  /** @type {Function[]} */
  #discoveredCallbacks = [];

  /**
   * @param {object} opts
   * @param {string} opts.type - Strategy type identifier (e.g., 'broadcast', 'relay', 'manual')
   */
  constructor({ type }) {
    if (!type || typeof type !== 'string') {
      throw new Error('type is required and must be a non-empty string');
    }
    this.#type = type;
  }

  /** @returns {string} Strategy type identifier */
  get type() {
    return this.#type;
  }

  /** @returns {boolean} Whether the strategy is currently active */
  get active() {
    return this.#active;
  }

  /** @param {boolean} value */
  set _active(value) {
    this.#active = value;
  }

  /**
   * Register a callback for when a peer is discovered.
   * @param {Function} cb - Callback receiving a DiscoveryRecord
   */
  onDiscovered(cb) {
    this.#discoveredCallbacks.push(cb);
  }

  /**
   * Fire all discovered callbacks.
   * @param {DiscoveryRecord} record
   * @protected
   */
  _fireDiscovered(record) {
    for (const cb of this.#discoveredCallbacks) {
      cb(record);
    }
  }

  /**
   * Start the discovery strategy.
   * @abstract
   * @returns {Promise<void>}
   */
  async start() {
    throw new Error('start() must be implemented by subclass');
  }

  /**
   * Stop the discovery strategy.
   * @abstract
   * @returns {Promise<void>}
   */
  async stop() {
    throw new Error('stop() must be implemented by subclass');
  }

  /**
   * Announce a local record to peers.
   * @abstract
   * @param {DiscoveryRecord} record
   * @returns {Promise<void>}
   */
  async announce(record) {
    throw new Error('announce() must be implemented by subclass');
  }

  /**
   * Query for discovered peers, optionally filtered.
   * @abstract
   * @param {object} [filter]
   * @returns {Promise<DiscoveryRecord[]>}
   */
  async query(filter) {
    throw new Error('query() must be implemented by subclass');
  }
}

// ---------------------------------------------------------------------------
// BroadcastChannelStrategy
// ---------------------------------------------------------------------------

/**
 * Discovers peers in same-origin browser tabs using BroadcastChannel.
 */
export class BroadcastChannelStrategy extends DiscoveryStrategy {
  /** @type {string} */
  #channelName;

  /** @type {BroadcastChannel|null} */
  #channel = null;

  /** @type {Map<string, DiscoveryRecord>} */
  #peers = new Map();

  /**
   * @param {object} [opts]
   * @param {string} [opts.channelName='mesh-discovery'] - BroadcastChannel name
   */
  constructor({ channelName = 'mesh-discovery' } = {}) {
    super({ type: 'broadcast' });
    this.#channelName = channelName;
  }

  /**
   * Start listening on the BroadcastChannel.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.active) return;
    this.#channel = new BroadcastChannel(this.#channelName);
    this.#channel.onmessage = (event) => {
      this.#handleMessage(event.data);
    };
    this._active = true;
  }

  /**
   * Stop listening and close the channel.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.active) return;
    if (this.#channel) {
      this.#channel.close();
      this.#channel = null;
    }
    this._active = false;
  }

  /**
   * Announce a record to all tabs on the same BroadcastChannel.
   * @param {DiscoveryRecord} record
   * @returns {Promise<void>}
   */
  async announce(record) {
    if (this.#channel) {
      this.#channel.postMessage({
        type: DISCOVERY_ANNOUNCE,
        record: record.toJSON(),
      });
    }
  }

  /**
   * Query for peers discovered via BroadcastChannel.
   * Posts a query and returns currently known peers.
   *
   * @param {object} [filter]
   * @returns {Promise<DiscoveryRecord[]>}
   */
  async query(filter) {
    if (this.#channel) {
      this.#channel.postMessage({ type: DISCOVERY_QUERY, filter });
    }
    const results = [];
    for (const record of this.#peers.values()) {
      if (!record.isExpired() && record.matchesFilter(filter)) {
        results.push(record);
      }
    }
    return results;
  }

  /**
   * Handle an incoming BroadcastChannel message.
   * @param {object} data
   * @private
   */
  #handleMessage(data) {
    if (!data || typeof data !== 'object') return;

    if (data.type === DISCOVERY_ANNOUNCE && data.record) {
      const record = DiscoveryRecord.fromJSON(data.record);
      record.source = 'broadcast';
      this.#peers.set(record.podId, record);
      this._fireDiscovered(record);
    } else if (data.type === DISCOVERY_RESPONSE && data.record) {
      const record = DiscoveryRecord.fromJSON(data.record);
      record.source = 'broadcast';
      this.#peers.set(record.podId, record);
      this._fireDiscovered(record);
    } else if (data.type === DISCOVERY_GOODBYE && data.podId) {
      this.#peers.delete(data.podId);
    }
  }
}

// ---------------------------------------------------------------------------
// RelayStrategy
// ---------------------------------------------------------------------------

/**
 * Discovers peers via a relay/signaling server.
 */
export class RelayStrategy extends DiscoveryStrategy {
  /** @type {string} */
  #relayUrl;

  /** @type {string} */
  #podId;

  /** @type {Map<string, DiscoveryRecord>} */
  #peers = new Map();

  /** @type {Function|null} */
  #signFn;

  /**
   * @param {object} opts
   * @param {string} opts.relayUrl - URL of the relay/signaling server
   * @param {string} opts.podId    - Local pod identifier for registration
   * @param {Function} [opts.signFn] - Optional async (podId) => { pubKey, signature }
   */
  constructor({ relayUrl, podId, signFn }) {
    super({ type: 'relay' });
    if (!relayUrl || typeof relayUrl !== 'string') {
      throw new Error('relayUrl is required and must be a non-empty string');
    }
    if (!podId || typeof podId !== 'string') {
      throw new Error('podId is required and must be a non-empty string');
    }
    this.#relayUrl = relayUrl;
    this.#podId = podId;
    this.#signFn = signFn ?? null;
  }

  /** @type {WebSocket|null} */
  #ws = null;

  /** @type {number|null} */
  #reconnectTimer = null;

  /**
   * Connect to the relay/signaling server and start listening for peers.
   * Automatically reconnects on disconnect while active.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.active) return;
    this._active = true;
    await this.#connect();
  }

  /**
   * Close the WebSocket and stop listening.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.active) return;
    this._active = false;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    if (this.#ws) {
      this.#ws.onclose = null; // prevent reconnect
      this.#ws.close(1000, 'strategy stopped');
      this.#ws = null;
    }
    this.#peers.clear();
  }

  /**
   * Announce a discovery record to the relay server.
   * The signaling server broadcasts our presence to other peers on registration,
   * so this sends a lightweight announce if the connection is open.
   * @param {DiscoveryRecord} record
   * @returns {Promise<void>}
   */
  async announce(record) {
    if (this.#ws && this.#ws.readyState === 1) {
      this.#ws.send(JSON.stringify({
        type: 'signal',
        target: '__broadcast__',
        data: { type: 'discovery-announce', record: record.toJSON?.() ?? record },
      }));
    }
  }

  /**
   * Query cached peers matching an optional filter.
   * @param {object} [filter]
   * @returns {Promise<DiscoveryRecord[]>}
   */
  async query(filter) {
    const results = [];
    for (const record of this.#peers.values()) {
      if (!record.isExpired() && record.matchesFilter(filter)) {
        results.push(record);
      }
    }
    return results;
  }

  // ── Internal ──────────────────────────────────────────────────────

  /** Open WebSocket, register, and wire message handlers. */
  async #connect() {
    if (!this.active) return;

    try {
      const WS = globalThis.WebSocket;
      if (!WS) throw new Error('WebSocket not available');
      const ws = new WS(this.#relayUrl);
      this.#ws = ws;

      await new Promise((resolve, reject) => {
        ws.onopen = async () => {
          try {
            const regMsg = { type: 'register', podId: this.#podId };
            if (this.#signFn) {
              const { pubKey, signature } = await this.#signFn(this.#podId);
              regMsg.pubKey = pubKey;
              regMsg.signature = signature;
            }
            ws.send(JSON.stringify(regMsg));
            resolve();
          } catch (err) {
            reject(err);
          }
        };
        ws.onerror = () => reject(new Error('WebSocket connection failed'));
        setTimeout(() => reject(new Error('WebSocket connection timeout')), 10000);
      });

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          this.#handleMessage(msg);
        } catch (e) { silentCatch('clawser-mesh-discovery', 'ignore-malformed', e) }
      };

      ws.onclose = () => {
        this.#ws = null;
        // Auto-reconnect after 3s if still active
        if (this.active) {
          this.#reconnectTimer = setTimeout(() => this.#connect(), 3000);
        }
      };
    } catch {
      // Retry after 5s on connection failure
      if (this.active) {
        this.#reconnectTimer = setTimeout(() => this.#connect(), 5000);
      }
    }
  }

  /** Handle incoming signaling messages and fire discovery callbacks. */
  #handleMessage(msg) {
    if (msg.type === 'peers') {
      // Full peer list from server — sync our cache
      for (const podId of msg.peers) {
        if (podId === this.#podId) continue;
        if (!this.#peers.has(podId)) {
          const record = new DiscoveryRecord({
            podId,
            label: podId.slice(0, 8),
            transport: 'relay',
            source: 'relay',
          });
          this.#peers.set(podId, record);
          this._fireDiscovered(record);
        }
      }
    }

    if (msg.type === 'peer-joined') {
      const { podId } = msg;
      if (podId && podId !== this.#podId && !this.#peers.has(podId)) {
        const record = new DiscoveryRecord({
          podId,
          label: podId.slice(0, 8),
          transport: 'relay',
          source: 'relay',
        });
        this.#peers.set(podId, record);
        this._fireDiscovered(record);
      }
    }

    if (msg.type === 'peer-left') {
      this.#peers.delete(msg.podId);
    }
  }
}

// ---------------------------------------------------------------------------
// ManualStrategy
// ---------------------------------------------------------------------------

/**
 * Allows explicit manual peer addition and removal.
 */
export class ManualStrategy extends DiscoveryStrategy {
  /** @type {Map<string, DiscoveryRecord>} */
  #peers = new Map();

  /**
   * @param {object} [opts]
   */
  constructor(opts = {}) {
    super({ type: 'manual' });
  }

  /**
   * Start the manual strategy (no-op but marks active).
   * @returns {Promise<void>}
   */
  async start() {
    this._active = true;
  }

  /**
   * Stop the manual strategy.
   * @returns {Promise<void>}
   */
  async stop() {
    this._active = false;
  }

  /**
   * Announce is a no-op for manual strategy.
   * @param {DiscoveryRecord} record
   * @returns {Promise<void>}
   */
  async announce(record) {
    // No-op for manual strategy
  }

  /**
   * Add a peer record manually.
   * @param {DiscoveryRecord} record
   */
  addPeer(record) {
    this.#peers.set(record.podId, record);
    this._fireDiscovered(record);
  }

  /**
   * Remove a manually added peer.
   * @param {string} podId
   * @returns {boolean} true if the peer existed
   */
  removePeer(podId) {
    return this.#peers.delete(podId);
  }

  /**
   * Query all manually added peers, optionally filtered.
   * @param {object} [filter]
   * @returns {DiscoveryRecord[]}
   */
  query(filter) {
    const results = [];
    for (const record of this.#peers.values()) {
      if (record.matchesFilter(filter)) {
        results.push(record);
      }
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// PexStrategy — Peer Exchange
// ---------------------------------------------------------------------------

/**
 * Discovers peers by exchanging peer lists with directly connected peers.
 *
 * When a new peer connects, both sides exchange their known peer lists.
 * This reduces dependency on the signaling server — peers can discover
 * each other transitively through the mesh itself.
 *
 * Usage:
 *   const pex = new PexStrategy({ localId: podId })
 *   discoveryManager.addStrategy(pex)
 *   // When a WebRTC peer connects:
 *   pex.addPeer(remotePodId, sendFn)
 *   // When a WebRTC message arrives with type PEX_EXCHANGE:
 *   pex.handleMessage(fromPodId, msg)
 */
export class PexStrategy extends DiscoveryStrategy {
  /** @type {string} */
  #localId;

  /** @type {Map<string, DiscoveryRecord>} */
  #peers = new Map();

  /** @type {Map<string, function>} podId -> sendFn */
  #transports = new Map();

  /** @type {number} */
  #exchangeIntervalMs;

  /** @type {*} */
  #timer = null;

  /**
   * @param {object} opts
   * @param {string} opts.localId - Local pod identifier
   * @param {number} [opts.exchangeIntervalMs=30000] - Periodic exchange interval
   */
  constructor({ localId, exchangeIntervalMs = 30000 }) {
    super({ type: 'pex' });
    if (!localId || typeof localId !== 'string') {
      throw new Error('localId is required and must be a non-empty string');
    }
    this.#localId = localId;
    this.#exchangeIntervalMs = exchangeIntervalMs;
  }

  /**
   * Start periodic peer exchange.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.active) return;
    this._active = true;
    this.#timer = setInterval(() => this.#exchangeAll(), this.#exchangeIntervalMs);
  }

  /**
   * Stop periodic exchange and clear state.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.active) return;
    this._active = false;
    clearInterval(this.#timer);
    this.#timer = null;
    this.#transports.clear();
    this.#peers.clear();
  }

  /**
   * Announce is a no-op for PEX — peers are announced via exchange.
   * @param {DiscoveryRecord} _record
   * @returns {Promise<void>}
   */
  async announce(_record) { /* no-op */ }

  /**
   * Return cached peers matching an optional filter.
   * @param {object} [filter]
   * @returns {Promise<DiscoveryRecord[]>}
   */
  async query(filter) {
    const results = [];
    for (const record of this.#peers.values()) {
      if (!record.isExpired() && record.matchesFilter(filter)) {
        results.push(record);
      }
    }
    return results;
  }

  /**
   * Register a directly connected peer and immediately exchange peer lists.
   *
   * @param {string} podId - Remote peer's pod identifier
   * @param {function} sendFn - (msg: object) => void — sends to this peer
   */
  addPeer(podId, sendFn) {
    if (podId === this.#localId) return;
    this.#transports.set(podId, sendFn);

    // Add as a discovered peer if not already known
    if (!this.#peers.has(podId)) {
      const record = new DiscoveryRecord({
        podId,
        label: podId.slice(0, 8),
        transport: 'webrtc',
        source: 'pex',
      });
      this.#peers.set(podId, record);
      this._fireDiscovered(record);
    }

    // Immediately send our peer list to the new peer
    this.#sendExchange(podId);
  }

  /**
   * Remove a disconnected peer's transport.
   *
   * @param {string} podId
   */
  removePeer(podId) {
    this.#transports.delete(podId);
  }

  /**
   * Handle an incoming PEX exchange message from a remote peer.
   * Creates DiscoveryRecords for any unknown peers and fires callbacks.
   *
   * @param {string} fromPodId
   * @param {object} msg - { type: 'pex-exchange', peers: string[] }
   */
  handleMessage(fromPodId, msg) {
    if (msg.type !== 'pex-exchange' || !Array.isArray(msg.peers)) return;

    for (const podId of msg.peers) {
      if (podId === this.#localId) continue;
      if (this.#peers.has(podId)) continue;

      const record = new DiscoveryRecord({
        podId,
        label: podId.slice(0, 8),
        transport: 'webrtc',
        source: 'pex',
      });
      this.#peers.set(podId, record);
      this._fireDiscovered(record);
    }
  }

  /** @returns {string[]} List of known peer IDs */
  knownPeers() {
    return [...this.#peers.keys()];
  }

  /** @returns {number} Number of peers with active transports */
  get connectedCount() {
    return this.#transports.size;
  }

  // ── Internal ──────────────────────────────────────────────────────

  /** Send our peer list to a specific peer. */
  #sendExchange(targetPodId) {
    const sendFn = this.#transports.get(targetPodId);
    if (!sendFn) return;
    sendFn({
      type: 'pex-exchange',
      from: this.#localId,
      peers: [...this.#peers.keys()],
    });
  }

  /** Exchange peer lists with all connected peers. */
  #exchangeAll() {
    for (const podId of this.#transports.keys()) {
      this.#sendExchange(podId);
    }
  }
}

// ---------------------------------------------------------------------------
// SharedWorkerRelayStrategy
// ---------------------------------------------------------------------------

const WORKER_SCRIPT = `
  const registry = new Map();
  const ports = new Map();

  self.onconnect = (e) => {
    const port = e.ports[0];
    let connPodId = null;

    port.onmessage = ({ data }) => {
      if (data.type === 'register') {
        connPodId = data.podId;
        registry.set(data.podId, data.profile);
        ports.set(data.podId, port);
        // Broadcast to all other ports
        for (const [id, p] of ports) {
          if (id !== data.podId) {
            p.postMessage({ type: 'announce', record: data.profile });
          }
        }
      } else if (data.type === 'query') {
        const peers = [];
        for (const [id, profile] of registry) {
          if (id !== connPodId) peers.push(profile);
        }
        port.postMessage({ type: 'peers', peers });
      } else if (data.type === 'relay' && data.targetPodId) {
        const target = ports.get(data.targetPodId);
        if (target) {
          target.postMessage({ type: 'relay', from: connPodId, payload: data.payload });
        }
      } else if (data.type === 'unregister') {
        if (connPodId) {
          registry.delete(connPodId);
          ports.delete(connPodId);
        }
      }
    };
    port.start();
  };
`;

/**
 * Discovers peers within same-origin tabs using a SharedWorker as relay.
 * The SharedWorker maintains a peer registry and forwards messages
 * between connected ports.
 */
export class SharedWorkerRelayStrategy extends DiscoveryStrategy {
  /** @type {Function|null} */
  #createWorkerFn;

  /** @type {object|null} */
  #worker = null;

  /** @type {object|null} */
  #port = null;

  /** @type {Map<string, DiscoveryRecord>} */
  #peers = new Map();

  /**
   * @param {object} [opts]
   * @param {Function} [opts.createWorkerFn] - Injectable factory for testing
   */
  constructor({ createWorkerFn } = {}) {
    super({ type: 'shared-worker' })
    this.#createWorkerFn = createWorkerFn ?? null
    this.#peers = new Map()
  }

  /**
   * Start the SharedWorker relay strategy.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.active) return

    const factory = this.#createWorkerFn ?? (() => {
      const blob = new Blob([WORKER_SCRIPT], { type: 'application/javascript' })
      const url = URL.createObjectURL(blob)
      const worker = new SharedWorker(url, 'clawser-mesh-relay')
      URL.revokeObjectURL(url)
      return worker
    })

    this.#worker = factory()
    this.#port = this.#worker.port
    this.#port.onmessage = (event) => {
      this.#handleMessage(event.data)
    }
    if (typeof this.#port.start === 'function') {
      this.#port.start()
    }
    this._active = true
  }

  /**
   * Stop the SharedWorker relay strategy.
   * @returns {Promise<void>}
   */
  async stop() {
    if (!this.active) return
    if (this.#port) {
      this.#port.postMessage({ type: 'unregister' })
      if (typeof this.#port.close === 'function') {
        this.#port.close()
      }
      this.#port = null
    }
    this.#worker = null
    this._active = false
  }

  /**
   * Announce a record via the SharedWorker relay.
   * @param {DiscoveryRecord} record
   * @returns {Promise<void>}
   */
  async announce(record) {
    if (this.#port) {
      this.#port.postMessage({
        type: 'register',
        podId: record.podId,
        profile: record.toJSON(),
      })
    }
  }

  /**
   * Query for peers discovered via the SharedWorker relay.
   * Sends a query to the worker and returns currently cached peers.
   *
   * @param {object} [filter]
   * @returns {Promise<DiscoveryRecord[]>}
   */
  async query(filter) {
    if (this.#port) {
      this.#port.postMessage({ type: 'query', filter })
    }
    const results = []
    for (const record of this.#peers.values()) {
      if (!record.isExpired() && record.matchesFilter(filter)) {
        results.push(record)
      }
    }
    return results
  }

  /**
   * Handle an incoming message from the SharedWorker port.
   * @param {object} data
   * @private
   */
  #handleMessage(data) {
    if (!data || typeof data !== 'object') return

    if (data.type === 'peers' && Array.isArray(data.peers)) {
      for (const peerData of data.peers) {
        const record = DiscoveryRecord.fromJSON(peerData)
        record.source = 'shared-worker'
        this.#peers.set(record.podId, record)
      }
    } else if (data.type === 'announce' && data.record) {
      const record = DiscoveryRecord.fromJSON(data.record)
      record.source = 'shared-worker'
      this.#peers.set(record.podId, record)
      this._fireDiscovered(record)
    } else if (data.type === 'relay') {
      // Handle relayed payload — if it looks like a discovery record, fire discovered
      if (data.payload && data.payload.podId) {
        const record = DiscoveryRecord.fromJSON(data.payload)
        record.source = 'shared-worker'
        this.#peers.set(record.podId, record)
        this._fireDiscovered(record)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// DiscoveryManager
// ---------------------------------------------------------------------------

/**
 * Orchestrates multiple discovery strategies with periodic announce and
 * TTL-based pruning.
 */
export class DiscoveryManager {
  /** @type {DiscoveryStrategy[]} */
  #strategies = [];

  /** @type {DiscoveryRecord} */
  #localRecord;

  /** @type {number} */
  #announceInterval;

  /** @type {Map<string, DiscoveryRecord>} peers indexed by podId */
  #peers = new Map();

  /** @type {Function[]} */
  #peerDiscoveredCallbacks = [];

  /** @type {Function[]} */
  #peerLostCallbacks = [];

  /** @type {number|null} */
  #announceTimer = null;

  /** @type {number|null} */
  #pruneTimer = null;

  /**
   * @param {object} opts
   * @param {DiscoveryStrategy[]} [opts.strategies=[]] - Initial strategies
   * @param {DiscoveryRecord} opts.localRecord          - Record describing the local node
   * @param {number} [opts.announceInterval=15000]      - How often to re-announce (ms)
   */
  constructor({ strategies = [], localRecord, announceInterval = 15_000 } = {}) {
    if (!localRecord) {
      throw new Error('localRecord is required');
    }
    this.#localRecord = localRecord;
    this.#announceInterval = announceInterval;
    for (const s of strategies) {
      this.#strategies.push(s);
      this.#wireStrategy(s);
    }
  }

  /**
   * Wire a strategy's onDiscovered callback to propagate into the manager.
   * @param {DiscoveryStrategy} strategy
   * @private
   */
  #wireStrategy(strategy) {
    strategy.onDiscovered((record) => {
      this.#peers.set(record.podId, record);
      for (const cb of this.#peerDiscoveredCallbacks) {
        cb(record);
      }
    });
  }

  /**
   * Start all strategies, begin periodic announce and pruning.
   * @returns {Promise<void>}
   */
  async start() {
    for (const s of this.#strategies) {
      await s.start();
    }
    // Initial announce
    await this.announce();
    // Periodic announce (skip in test / no-timer environments)
    if (typeof setInterval === 'function') {
      this.#announceTimer = setInterval(() => {
        this.announce().catch(() => {});
        this._pruneExpired();
      }, this.#announceInterval);
      // Unref so it doesn't keep Node alive in tests
      if (this.#announceTimer && typeof this.#announceTimer === 'object' && this.#announceTimer.unref) {
        this.#announceTimer.unref();
      }
    }
  }

  /**
   * Stop all strategies and clear timers.
   * @returns {Promise<void>}
   */
  async stop() {
    if (this.#announceTimer !== null) {
      clearInterval(this.#announceTimer);
      this.#announceTimer = null;
    }
    if (this.#pruneTimer !== null) {
      clearInterval(this.#pruneTimer);
      this.#pruneTimer = null;
    }
    for (const s of this.#strategies) {
      await s.stop();
    }
  }

  /**
   * Announce the local record to all strategies.
   * @returns {Promise<void>}
   */
  async announce() {
    for (const s of this.#strategies) {
      try {
        await s.announce(this.#localRecord);
      } catch {
        // Ignore announce failures on individual strategies
      }
    }
  }

  /**
   * Query all strategies, merge and deduplicate results.
   * @param {object} [filter]
   * @returns {Promise<DiscoveryRecord[]>}
   */
  async discover(filter) {
    const seen = new Map();
    for (const s of this.#strategies) {
      try {
        const results = await s.query(filter);
        for (const r of results) {
          if (!seen.has(r.podId)) {
            seen.set(r.podId, r);
            // Also add to internal peers map
            this.#peers.set(r.podId, r);
          }
        }
      } catch {
        // Ignore query failures on individual strategies
      }
    }
    return [...seen.values()];
  }

  /**
   * Add a new discovery strategy.
   * @param {DiscoveryStrategy} strategy
   */
  addStrategy(strategy) {
    this.#strategies.push(strategy);
    this.#wireStrategy(strategy);
  }

  /**
   * Remove a strategy by type.
   * @param {string} type
   * @returns {boolean} true if a strategy was removed
   */
  removeStrategy(type) {
    const idx = this.#strategies.findIndex(s => s.type === type);
    if (idx === -1) return false;
    this.#strategies.splice(idx, 1);
    return true;
  }

  /**
   * Register a callback for when a new peer is discovered.
   * @param {Function} cb - Callback receiving a DiscoveryRecord
   */
  onPeerDiscovered(cb) {
    this.#peerDiscoveredCallbacks.push(cb);
  }

  /**
   * Register a callback for when a peer is lost (expired/pruned).
   * @param {Function} cb - Callback receiving a DiscoveryRecord
   */
  onPeerLost(cb) {
    this.#peerLostCallbacks.push(cb);
  }

  /**
   * Get all known peers.
   * @returns {Map<string, DiscoveryRecord>}
   */
  getPeers() {
    return new Map(this.#peers);
  }

  /**
   * Get a single peer by podId.
   * @param {string} podId
   * @returns {DiscoveryRecord|null}
   */
  getPeer(podId) {
    return this.#peers.get(podId) ?? null;
  }

  /**
   * Remove expired records from the internal peers map.
   * Fires onPeerLost callbacks for each removed peer.
   * @internal
   */
  _pruneExpired() {
    const now = Date.now();
    for (const [podId, record] of this.#peers) {
      if (record.isExpired(now)) {
        this.#peers.delete(podId);
        for (const cb of this.#peerLostCallbacks) {
          cb(record);
        }
      }
    }
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      localRecord: this.#localRecord.toJSON(),
      announceInterval: this.#announceInterval,
      strategies: this.#strategies.map(s => s.type),
      peers: [...this.#peers.values()].map(r => r.toJSON()),
    };
  }

  /**
   * Re-hydrate from serialized data.
   * Creates a manager with no strategies (strategies must be re-added manually).
   * Restores the peers map from serialized data.
   *
   * @param {object} data
   * @returns {DiscoveryManager}
   */
  static fromJSON(data) {
    const localRecord = DiscoveryRecord.fromJSON(data.localRecord);
    const mgr = new DiscoveryManager({
      strategies: [],
      localRecord,
      announceInterval: data.announceInterval,
    });
    for (const peerData of data.peers || []) {
      const record = DiscoveryRecord.fromJSON(peerData);
      mgr.#peers.set(record.podId, record);
    }
    return mgr;
  }
}

// ---------------------------------------------------------------------------
// ServiceEndpoint
// ---------------------------------------------------------------------------

/**
 * Describes a svc:// service offered by a mesh pod.
 */
export class ServiceEndpoint {
  /**
   * @param {object} opts
   * @param {string} opts.name           - Service name
   * @param {string} opts.podId          - Pod offering this service
   * @param {string} [opts.protocol='svc'] - Protocol (always 'svc')
   * @param {string} [opts.version='1.0'] - Service version
   * @param {object} [opts.metadata={}]  - Arbitrary metadata
   * @param {number} [opts.ttl=60000]    - Time-to-live in ms
   * @param {number} [opts.registeredAt] - Registration timestamp
   */
  constructor({
    name,
    podId,
    protocol = 'svc',
    version = '1.0',
    metadata = {},
    ttl = 60_000,
    registeredAt,
  }) {
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a non-empty string');
    }
    if (!podId || typeof podId !== 'string') {
      throw new Error('podId is required and must be a non-empty string');
    }
    this.name = name;
    this.podId = podId;
    this.protocol = protocol;
    this.version = version;
    this.metadata = { ...metadata };
    this.ttl = ttl;
    this.registeredAt = registeredAt ?? Date.now();
  }

  /**
   * Get the full svc:// URI for this service.
   * @returns {string}
   */
  get uri() {
    return `svc://${this.podId}/${this.name}`;
  }

  /**
   * Check whether this endpoint has expired.
   *
   * @param {number} [now=Date.now()] - Current timestamp in ms
   * @returns {boolean}
   */
  isExpired(now = Date.now()) {
    return now >= this.registeredAt + this.ttl;
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      name: this.name,
      podId: this.podId,
      protocol: this.protocol,
      version: this.version,
      metadata: { ...this.metadata },
      ttl: this.ttl,
      registeredAt: this.registeredAt,
    };
  }

  /**
   * Re-hydrate from a plain object.
   * @param {object} data
   * @returns {ServiceEndpoint}
   */
  static fromJSON(data) {
    return new ServiceEndpoint(data);
  }
}

// ---------------------------------------------------------------------------
// ServiceDirectory
// ---------------------------------------------------------------------------

/**
 * Local service registry and directory with svc:// URI routing.
 * Manages both local service handlers and remote service endpoint references.
 */
export class ServiceDirectory {
  /** @type {string} */
  #localPodId;

  /** @type {Map<string, { endpoint: ServiceEndpoint, handler: Function }>} name -> local svc */
  #local = new Map();

  /** @type {Map<string, ServiceEndpoint>} uri -> remote endpoint */
  #remote = new Map();

  /** @type {Function[]} */
  #registerCallbacks = [];

  /** @type {Function[]} */
  #unregisterCallbacks = [];

  /**
   * @param {object} opts
   * @param {string} opts.localPodId - This node's pod identifier
   */
  constructor({ localPodId }) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string');
    }
    this.#localPodId = localPodId;
  }

  /**
   * Register a local service handler.
   *
   * @param {string} name     - Service name
   * @param {Function} handler - Handler function for incoming requests
   * @param {object} [opts]
   * @param {object} [opts.metadata] - Metadata for the endpoint
   * @param {number} [opts.ttl]      - TTL for the endpoint
   * @returns {ServiceEndpoint}
   */
  register(name, handler, opts = {}) {
    if (!name || typeof name !== 'string') {
      throw new Error('name is required and must be a non-empty string');
    }
    if (!handler || typeof handler !== 'function') {
      throw new Error('handler is required and must be a function');
    }
    if (this.#local.has(name)) {
      throw new Error(`Service '${name}' is already registered`);
    }
    const endpoint = new ServiceEndpoint({
      name,
      podId: this.#localPodId,
      metadata: opts.metadata,
      ttl: opts.ttl,
    });
    this.#local.set(name, { endpoint, handler });
    for (const cb of this.#registerCallbacks) {
      cb(endpoint);
    }
    return endpoint;
  }

  /**
   * Unregister a local service.
   *
   * @param {string} name
   * @returns {boolean} true if the service existed
   */
  unregister(name) {
    if (!this.#local.has(name)) return false;
    this.#local.delete(name);
    for (const cb of this.#unregisterCallbacks) {
      cb(name);
    }
    return true;
  }

  /**
   * Look up a service by its svc:// URI.
   * Parses the URI to extract podId and service name, then checks
   * local services first, then remote endpoints.
   *
   * @param {string} uri - URI in format svc://podId/serviceName
   * @returns {{ endpoint: ServiceEndpoint, isLocal: boolean }|null}
   */
  lookup(uri) {
    const parsed = ServiceDirectory.#parseUri(uri);
    if (!parsed) return null;

    const { podId, name } = parsed;

    // Check local services
    if (podId === this.#localPodId && this.#local.has(name)) {
      return { endpoint: this.#local.get(name).endpoint, isLocal: true };
    }

    // Check remote endpoints
    const remoteKey = `svc://${podId}/${name}`;
    if (this.#remote.has(remoteKey)) {
      return { endpoint: this.#remote.get(remoteKey), isLocal: false };
    }

    return null;
  }

  /**
   * Find all endpoints (local and remote) offering a service by name.
   *
   * @param {string} name
   * @returns {ServiceEndpoint[]}
   */
  lookupByName(name) {
    const results = [];
    // Local
    if (this.#local.has(name)) {
      results.push(this.#local.get(name).endpoint);
    }
    // Remote
    for (const ep of this.#remote.values()) {
      if (ep.name === name) {
        results.push(ep);
      }
    }
    return results;
  }

  /**
   * Add a remote service endpoint reference.
   *
   * @param {ServiceEndpoint} endpoint
   */
  addRemote(endpoint) {
    this.#remote.set(endpoint.uri, endpoint);
  }

  /**
   * Remove a remote service endpoint by URI.
   *
   * @param {string} uri
   * @returns {boolean} true if the endpoint existed
   */
  removeRemote(uri) {
    return this.#remote.delete(uri);
  }

  /**
   * List all locally registered service endpoints.
   * @returns {ServiceEndpoint[]}
   */
  listLocal() {
    return [...this.#local.values()].map(e => e.endpoint);
  }

  /**
   * List all remote service endpoints.
   * @returns {ServiceEndpoint[]}
   */
  listRemote() {
    return [...this.#remote.values()];
  }

  /**
   * List all service endpoints (local + remote).
   * @returns {ServiceEndpoint[]}
   */
  listAll() {
    return [...this.listLocal(), ...this.listRemote()];
  }

  /**
   * Register a callback for when a local service is registered.
   * @param {Function} cb - Callback receiving a ServiceEndpoint
   */
  onRegister(cb) {
    this.#registerCallbacks.push(cb);
  }

  /**
   * Register a callback for when a local service is unregistered.
   * @param {Function} cb - Callback receiving the service name
   */
  onUnregister(cb) {
    this.#unregisterCallbacks.push(cb);
  }

  /**
   * Parse a svc:// URI into podId and name.
   * @param {string} uri
   * @returns {{ podId: string, name: string }|null}
   * @private
   */
  static #parseUri(uri) {
    if (!uri || typeof uri !== 'string') return null;
    const match = uri.match(/^svc:\/\/([^/]+)\/(.+)$/);
    if (!match) return null;
    return { podId: match[1], name: match[2] };
  }
}
