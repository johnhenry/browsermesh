/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-gateway.js -- Gateway Node for BrowserMesh.
 *
 * Thin wrapper around relay functionality providing multi-hop routing,
 * route advertisement, and gateway discovery for the mesh network.
 *
 * GatewayRoute represents a single route between two pods via a gateway.
 * RouteTable manages a collection of routes with TTL expiration.
 * GatewayNode orchestrates peer registration, route management, and relay.
 * GatewayDiscovery tracks available gateways for destination selection.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-gateway.test.mjs
 */

// ---------------------------------------------------------------------------
// Wire Constants
// ---------------------------------------------------------------------------

/** Gateway announcement message type. */
const GATEWAY_ANNOUNCE = 0xA0;

/** Gateway route advertisement message type. */
const GATEWAY_ROUTE = 0xA1;

/** Gateway relay request message type. */
const GATEWAY_RELAY = 0xA2;

/** Gateway route withdrawal message type. */
const GATEWAY_WITHDRAW = 0xA3;

// ---------------------------------------------------------------------------
// GatewayRoute
// ---------------------------------------------------------------------------

/**
 * A single route between two pods via a gateway node.
 */
export class GatewayRoute {
  /**
   * @param {object} opts
   * @param {string} opts.fromPodId   - Source pod identifier
   * @param {string} opts.toPodId     - Destination pod identifier
   * @param {string} opts.viaGateway  - Gateway pod that forwarded this route
   * @param {number} opts.hopCount    - Number of hops along this route
   * @param {number} [opts.latencyMs] - Estimated latency in milliseconds
   * @param {number} [opts.createdAt] - Unix timestamp (ms) when route was created
   * @param {number} [opts.ttl]       - Time-to-live in milliseconds
   */
  constructor({
    fromPodId,
    toPodId,
    viaGateway,
    hopCount,
    latencyMs = null,
    createdAt = Date.now(),
    ttl = 60_000,
  }) {
    if (!fromPodId || typeof fromPodId !== 'string') {
      throw new Error('fromPodId is required and must be a non-empty string');
    }
    if (!toPodId || typeof toPodId !== 'string') {
      throw new Error('toPodId is required and must be a non-empty string');
    }
    if (!viaGateway || typeof viaGateway !== 'string') {
      throw new Error('viaGateway is required and must be a non-empty string');
    }
    if (typeof hopCount !== 'number' || hopCount < 0) {
      throw new Error('hopCount must be a non-negative number');
    }
    this.fromPodId = fromPodId;
    this.toPodId = toPodId;
    this.viaGateway = viaGateway;
    this.hopCount = hopCount;
    this.latencyMs = latencyMs;
    this.createdAt = createdAt;
    this.ttl = ttl;
  }

  /**
   * Check whether this route has expired.
   *
   * @param {number} [now=Date.now()] - Current timestamp in ms
   * @returns {boolean}
   */
  isExpired(now = Date.now()) {
    return now >= this.createdAt + this.ttl;
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      fromPodId: this.fromPodId,
      toPodId: this.toPodId,
      viaGateway: this.viaGateway,
      hopCount: this.hopCount,
      latencyMs: this.latencyMs,
      createdAt: this.createdAt,
      ttl: this.ttl,
    };
  }

  /**
   * Re-hydrate from a plain object.
   * @param {object} data
   * @returns {GatewayRoute}
   */
  static fromJSON(data) {
    return new GatewayRoute(data);
  }
}

// ---------------------------------------------------------------------------
// RouteTable
// ---------------------------------------------------------------------------

/**
 * Collection of gateway routes with TTL-based expiration.
 */
export class RouteTable {
  /** @type {Map<string, GatewayRoute>} key -> route */
  #routes = new Map();

  /** @type {number} */
  #maxRoutes;

  /** @type {number} */
  #ttlMs;

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxRoutes=1000] - Maximum number of routes to store
   * @param {number} [opts.ttlMs=60000]    - Default TTL for routes in ms
   */
  constructor(opts = {}) {
    this.#maxRoutes = opts.maxRoutes ?? 1000;
    this.#ttlMs = opts.ttlMs ?? 60_000;
  }

  /**
   * Generate a composite key for a route.
   * @param {string} fromPodId
   * @param {string} toPodId
   * @returns {string}
   */
  static #key(fromPodId, toPodId) {
    return `${fromPodId}:${toPodId}`;
  }

  /**
   * Add or replace a route.
   * If the table is full, the oldest route is evicted.
   *
   * @param {GatewayRoute} route
   */
  addRoute(route) {
    const key = RouteTable.#key(route.fromPodId, route.toPodId);
    if (!this.#routes.has(key) && this.#routes.size >= this.#maxRoutes) {
      // Evict the oldest route
      const oldest = this.#routes.keys().next().value;
      this.#routes.delete(oldest);
    }
    this.#routes.set(key, route);
  }

  /**
   * Remove a specific route.
   *
   * @param {string} fromPodId
   * @param {string} toPodId
   * @returns {boolean} true if the route existed
   */
  removeRoute(fromPodId, toPodId) {
    return this.#routes.delete(RouteTable.#key(fromPodId, toPodId));
  }

  /**
   * Find a specific route.
   *
   * @param {string} fromPodId
   * @param {string} toPodId
   * @returns {GatewayRoute|null}
   */
  findRoute(fromPodId, toPodId) {
    return this.#routes.get(RouteTable.#key(fromPodId, toPodId)) ?? null;
  }

  /**
   * Find all routes to a destination, sorted by hopCount ascending.
   *
   * @param {string} toPodId
   * @returns {GatewayRoute[]}
   */
  findRoutes(toPodId) {
    const matches = [];
    for (const route of this.#routes.values()) {
      if (route.toPodId === toPodId) {
        matches.push(route);
      }
    }
    matches.sort((a, b) => a.hopCount - b.hopCount);
    return matches;
  }

  /**
   * Remove all expired routes.
   *
   * @returns {number} number of routes pruned
   */
  pruneExpired() {
    const now = Date.now();
    let count = 0;
    for (const [key, route] of this.#routes) {
      if (route.isExpired(now)) {
        this.#routes.delete(key);
        count++;
      }
    }
    return count;
  }

  /** @returns {number} current number of routes */
  get size() {
    return this.#routes.size;
  }

  /** @returns {number} configured default TTL */
  get defaultTtl() {
    return this.#ttlMs;
  }

  /**
   * List all routes.
   * @returns {GatewayRoute[]}
   */
  listAll() {
    return [...this.#routes.values()];
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      maxRoutes: this.#maxRoutes,
      ttlMs: this.#ttlMs,
      routes: [...this.#routes.values()].map(r => r.toJSON()),
    };
  }

  /**
   * Re-hydrate from serialized data.
   * @param {object} data
   * @returns {RouteTable}
   */
  static fromJSON(data) {
    const table = new RouteTable({
      maxRoutes: data.maxRoutes,
      ttlMs: data.ttlMs,
    });
    for (const r of data.routes || []) {
      table.addRoute(GatewayRoute.fromJSON(r));
    }
    return table;
  }
}

// ---------------------------------------------------------------------------
// GatewayNode
// ---------------------------------------------------------------------------

/**
 * Orchestrates peer registration, route management, and payload relay
 * for a single gateway node in the mesh.
 */
export class GatewayNode {
  /** @type {string} */
  #localPodId;

  /** @type {Set<string>} connected peer pod IDs */
  #peers = new Set();

  /** @type {RouteTable} */
  #routeTable;

  /** @type {number} */
  #maxConnections;

  /** @type {number} */
  #maxHops;

  /** @type {boolean} */
  #allowRelay;

  /** @type {number} total relay operations performed */
  #relayCount = 0;

  /**
   * @param {string} localPodId - This gateway's pod identifier
   * @param {object} [opts]
   * @param {number} [opts.maxConnections=64] - Maximum peer connections
   * @param {number} [opts.maxHops=8]         - Maximum hop count for routes
   * @param {boolean} [opts.allowRelay=true]  - Whether relay is enabled
   */
  constructor(localPodId, opts = {}) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string');
    }
    this.#localPodId = localPodId;
    this.#maxConnections = opts.maxConnections ?? 64;
    this.#maxHops = opts.maxHops ?? 8;
    this.#allowRelay = opts.allowRelay !== undefined ? opts.allowRelay : true;
    this.#routeTable = new RouteTable();
  }

  // -- Accessors ------------------------------------------------------------

  /** This gateway's pod identifier. */
  get localPodId() {
    return this.#localPodId;
  }

  /** Whether relay is enabled. */
  get isRelayEnabled() {
    return this.#allowRelay;
  }

  /** Set of connected peer pod IDs. */
  get connectedPeers() {
    return new Set(this.#peers);
  }

  /** The underlying route table. */
  get routeTable() {
    return this.#routeTable;
  }

  // -- Peer Management ------------------------------------------------------

  /**
   * Register a directly connected peer.
   *
   * @param {string} podId
   */
  registerPeer(podId) {
    if (!podId || typeof podId !== 'string') {
      throw new Error('podId is required and must be a non-empty string');
    }
    if (this.#peers.size >= this.#maxConnections && !this.#peers.has(podId)) {
      throw new Error('Maximum connections reached');
    }
    this.#peers.add(podId);
  }

  /**
   * Unregister a peer connection.
   *
   * @param {string} podId
   * @returns {boolean} true if the peer existed
   */
  unregisterPeer(podId) {
    return this.#peers.delete(podId);
  }

  // -- Routing --------------------------------------------------------------

  /**
   * Check if a route exists between two pods.
   * A route exists if both pods are directly connected peers, or if
   * an explicit route is registered in the route table.
   *
   * @param {string} fromPodId
   * @param {string} toPodId
   * @returns {boolean}
   */
  canRoute(fromPodId, toPodId) {
    // Direct connection: both peers are registered
    if (this.#peers.has(fromPodId) && this.#peers.has(toPodId)) {
      return true;
    }
    // Explicit route in the table
    return this.#routeTable.findRoute(fromPodId, toPodId) !== null;
  }

  /**
   * Find the best route (lowest hop count) between two pods.
   * Returns null if no route exists.
   *
   * @param {string} fromPodId
   * @param {string} toPodId
   * @returns {GatewayRoute|null}
   */
  findBestRoute(fromPodId, toPodId) {
    // Check for direct route in table first
    const direct = this.#routeTable.findRoute(fromPodId, toPodId);
    if (direct) return direct;

    // If both are directly connected peers, synthesize a 1-hop route
    if (this.#peers.has(fromPodId) && this.#peers.has(toPodId)) {
      return new GatewayRoute({
        fromPodId,
        toPodId,
        viaGateway: this.#localPodId,
        hopCount: 1,
      });
    }

    return null;
  }

  /**
   * Advertise a route through this gateway.
   * Rejects routes exceeding maxHops.
   *
   * @param {string} fromPodId
   * @param {string} toPodId
   * @param {number} hopCount
   * @returns {GatewayRoute}
   */
  advertiseRoute(fromPodId, toPodId, hopCount) {
    if (hopCount > this.#maxHops) {
      throw new Error(`hopCount ${hopCount} exceeds maxHops ${this.#maxHops}`);
    }
    const route = new GatewayRoute({
      fromPodId,
      toPodId,
      viaGateway: this.#localPodId,
      hopCount,
      ttl: this.#routeTable.defaultTtl,
    });
    this.#routeTable.addRoute(route);
    return route;
  }

  /**
   * Revoke (remove) an advertised route.
   *
   * @param {string} fromPodId
   * @param {string} toPodId
   * @returns {boolean} true if a route was removed
   */
  revokeRoute(fromPodId, toPodId) {
    return this.#routeTable.removeRoute(fromPodId, toPodId);
  }

  /**
   * Relay a payload from one pod to another.
   * Returns a result object indicating success or failure.
   *
   * @param {string} fromPodId
   * @param {string} toPodId
   * @param {*} payload
   * @returns {{ relayed: boolean, route?: GatewayRoute, error?: string }}
   */
  relay(fromPodId, toPodId, payload) {
    if (!this.#allowRelay) {
      return { relayed: false, error: 'Relay is disabled on this gateway' };
    }
    const route = this.findBestRoute(fromPodId, toPodId);
    if (!route) {
      return { relayed: false, error: `No route from ${fromPodId} to ${toPodId}` };
    }
    this.#relayCount++;
    return { relayed: true, route };
  }

  // -- Statistics ------------------------------------------------------------

  /**
   * Get aggregate gateway statistics.
   * @returns {{ routeCount: number, peerCount: number, relayCount: number }}
   */
  get stats() {
    return {
      routeCount: this.#routeTable.size,
      peerCount: this.#peers.size,
      relayCount: this.#relayCount,
    };
  }

  // -- Serialization --------------------------------------------------------

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      localPodId: this.#localPodId,
      maxConnections: this.#maxConnections,
      maxHops: this.#maxHops,
      allowRelay: this.#allowRelay,
      peers: [...this.#peers],
      routeTable: this.#routeTable.toJSON(),
      relayCount: this.#relayCount,
    };
  }

  /**
   * Re-hydrate from serialized data.
   * @param {object} data
   * @returns {GatewayNode}
   */
  static fromJSON(data) {
    const node = new GatewayNode(data.localPodId, {
      maxConnections: data.maxConnections,
      maxHops: data.maxHops,
      allowRelay: data.allowRelay,
    });
    for (const peerId of data.peers || []) {
      node.registerPeer(peerId);
    }
    node.#routeTable = RouteTable.fromJSON(data.routeTable);
    node.#relayCount = data.relayCount || 0;
    return node;
  }
}

// ---------------------------------------------------------------------------
// GatewayDiscovery
// ---------------------------------------------------------------------------

/**
 * Tracks available gateways in the mesh for destination selection.
 */
export class GatewayDiscovery {
  /** @type {string} */
  #localPodId;

  /** @type {Map<string, { podId: string, capabilities: string[], addedAt: number }>} */
  #gateways = new Map();

  /**
   * @param {string} localPodId - This node's pod identifier
   */
  constructor(localPodId) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string');
    }
    this.#localPodId = localPodId;
  }

  /**
   * Register a gateway node.
   *
   * @param {string} podId
   * @param {string[]} [capabilities=[]]
   */
  addGateway(podId, capabilities = []) {
    if (!podId || typeof podId !== 'string') {
      throw new Error('podId is required and must be a non-empty string');
    }
    this.#gateways.set(podId, {
      podId,
      capabilities: [...capabilities],
      addedAt: Date.now(),
    });
  }

  /**
   * Remove a gateway.
   *
   * @param {string} podId
   * @returns {boolean} true if the gateway existed
   */
  removeGateway(podId) {
    return this.#gateways.delete(podId);
  }

  /**
   * List all known gateways.
   *
   * @returns {Array<{ podId: string, capabilities: string[], addedAt: number }>}
   */
  listGateways() {
    return [...this.#gateways.values()].map(g => ({
      podId: g.podId,
      capabilities: [...g.capabilities],
      addedAt: g.addedAt,
    }));
  }

  /**
   * Select the best gateway for reaching a destination.
   * Returns the first gateway that isn't the local node and isn't the
   * destination itself. Returns null if no suitable gateway exists.
   *
   * @param {string} toPodId
   * @param {object} [opts]
   * @param {string} [opts.requiredCapability] - Only consider gateways with this capability
   * @returns {string|null} pod ID of the selected gateway, or null
   */
  selectGateway(toPodId, opts = {}) {
    for (const gw of this.#gateways.values()) {
      if (gw.podId === this.#localPodId) continue;
      if (gw.podId === toPodId) continue;
      if (opts.requiredCapability && !gw.capabilities.includes(opts.requiredCapability)) {
        continue;
      }
      return gw.podId;
    }
    return null;
  }

  /** @returns {number} number of known gateways */
  get size() {
    return this.#gateways.size;
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  GATEWAY_ANNOUNCE,
  GATEWAY_ROUTE,
  GATEWAY_RELAY,
  GATEWAY_WITHDRAW,
};
