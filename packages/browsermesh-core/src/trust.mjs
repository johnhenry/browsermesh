/**
 * clawser-mesh-trust.js -- Trust graph management.
 *
 * Float [0.0, 1.0] trust with multiplicative transitive decay,
 * scope intersection, and reputation aggregation.
 *
 * Wraps mesh-primitives trust functions with higher-level management:
 * scope-aware filtering, reputation computation, persistence, and
 * JSON round-trip.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-trust.test.mjs
 */

import {
  createTrustEdge,
  computeTransitiveTrust,
  TRUST_CATEGORIES,
} from '@johnhenry/browsermesh-primitives';

// Re-export primitives for consumers
export { TRUST_CATEGORIES, createTrustEdge, computeTransitiveTrust };

// ---------------------------------------------------------------------------
// TrustGraph
// ---------------------------------------------------------------------------

/**
 * @typedef {object} TrustEdgeWrapper
 * @property {import('./packages/mesh-primitives/src/trust.mjs').TrustEdge} edge
 * @property {string[]} scopes - Scope tags for this trust relationship
 */

/**
 * @typedef {object} ReputationInfo
 * @property {number} trustCount - Number of inbound trust edges
 * @property {number} avgLevel - Average trust level
 * @property {string[]} scopes - Union of all inbound scopes
 */

/**
 * @typedef {object} TransitiveTrustResult
 * @property {number} level - Computed trust in [0.0, 1.0]
 * @property {boolean} direct - Whether a direct edge exists
 */

/**
 * Scope-aware trust graph with transitive computation and persistence.
 *
 * @class
 */
export class TrustGraph {
  /**
   * Internal storage: each entry holds the frozen TrustEdge from primitives
   * plus associated scopes.
   *
   * @type {{ edge: object, scopes: string[] }[]}
   */
  #entries = [];

  /** @type {Map<string, number>} keyed by `${fromId}|${toId}` → timestamp */
  #interactions = new Map();

  /** @type {*} */
  #storage;

  /**
   * @param {object} [opts]
   * @param {*} [opts.storage] - Optional persistence adapter
   */
  constructor(opts = {}) {
    this.#storage = opts.storage || null;
  }

  // -- Edge management ----------------------------------------------------

  /**
   * Add or replace a trust edge.
   *
   * If an edge from `fromId` to `toId` already exists it is replaced.
   *
   * @param {string} fromId - Truster pod ID
   * @param {string} toId - Trustee pod ID
   * @param {number} level - Trust in [0.0, 1.0]
   * @param {string[]} [scopes] - Scope tags (e.g. ['code', 'data'])
   * @param {object} [opts]
   * @param {string} [opts.category] - One of TRUST_CATEGORIES (default: DIRECT)
   * @param {number} [opts.timestamp]
   * @param {number} [opts.expires] - Optional expiration timestamp (ms)
   * @returns {object} The created TrustEdge
   */
  addEdge(fromId, toId, level, scopes = [], opts = {}) {
    if (typeof level !== 'number' || level < 0 || level > 1) {
      throw new RangeError(`Trust level must be in [0.0, 1.0], got ${level}`);
    }

    // Remove existing edge between same pair
    this.#entries = this.#entries.filter(
      (e) => !(e.edge.from === fromId && e.edge.to === toId)
    );

    const edge = createTrustEdge({
      from: fromId,
      to: toId,
      category: opts.category || TRUST_CATEGORIES.DIRECT,
      value: level,
      timestamp: opts.timestamp || Date.now(),
    });

    // Wrap with scopes and optional expires
    this.#entries.push({
      edge,
      scopes: Array.isArray(scopes) ? [...scopes] : [],
      expires: opts.expires ?? null,
    });

    return edge;
  }

  /**
   * Remove a trust edge.
   *
   * @param {string} fromId
   * @param {string} toId
   * @returns {boolean} true if an edge was removed
   */
  removeEdge(fromId, toId) {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter(
      (e) => !(e.edge.from === fromId && e.edge.to === toId)
    );
    return this.#entries.length < before;
  }

  /**
   * Get a direct edge (or null).
   *
   * @param {string} fromId
   * @param {string} toId
   * @returns {object|null} The TrustEdge or null
   */
  getEdge(fromId, toId) {
    const found = this.#entries.find(
      (e) => e.edge.from === fromId && e.edge.to === toId
    );
    return found ? found.edge : null;
  }

  /**
   * Get the scopes associated with a direct edge.
   *
   * @param {string} fromId
   * @param {string} toId
   * @returns {string[]}
   */
  getEdgeScopes(fromId, toId) {
    const found = this.#entries.find(
      (e) => e.edge.from === fromId && e.edge.to === toId
    );
    return found ? [...found.scopes] : [];
  }

  // -- Trust computation --------------------------------------------------

  /**
   * Get the trust level from `fromId` to `toId`, checking direct first
   * then falling back to transitive computation.
   *
   * @param {string} fromId
   * @param {string} toId
   * @returns {number} Trust in [0.0, 1.0]
   */
  getTrustLevel(fromId, toId) {
    const direct = this.getEdge(fromId, toId);
    if (direct) return direct.value;
    const edges = this.#entries.map((e) => e.edge);
    return computeTransitiveTrust(edges, fromId, toId);
  }

  /**
   * Get transitive trust with metadata.
   *
   * @param {string} fromId
   * @param {string} toId
   * @param {number} [maxDepth=3]
   * @returns {TransitiveTrustResult}
   */
  getTransitiveTrust(fromId, toId, maxDepth = 3) {
    const edges = this.#entries.map((e) => e.edge);
    const level = computeTransitiveTrust(edges, fromId, toId, maxDepth);
    const direct = this.getEdge(fromId, toId);
    return { level, direct: !!direct };
  }

  // -- Peer queries -------------------------------------------------------

  /**
   * Get all peers trusted by `fromId` at or above `minLevel`.
   * Optionally filtered by scope.
   *
   * @param {string} fromId
   * @param {number} [minLevel=0.01]
   * @param {string|null} [scope=null] - Filter by scope tag
   * @returns {string[]} Pod IDs of trusted peers
   */
  getTrustedPeers(fromId, minLevel = 0.01, scope = null) {
    const peers = [];
    for (const entry of this.#entries) {
      if (entry.edge.from !== fromId) continue;
      if (entry.edge.value < minLevel) continue;
      if (scope && entry.scopes.length > 0 && !entry.scopes.includes(scope)) {
        continue;
      }
      peers.push(entry.edge.to);
    }
    return peers;
  }

  /**
   * Check whether `fromId` trusts `toId` at the given threshold,
   * optionally within a specific scope.
   *
   * @param {string} fromId
   * @param {string} toId
   * @param {string|null} [scope=null]
   * @param {number} [minLevel=0.25]
   * @returns {boolean}
   */
  isTrusted(fromId, toId, scope = null, minLevel = 0.25) {
    const level = this.getTrustLevel(fromId, toId);
    if (level < minLevel) return false;
    if (scope) {
      const entry = this.#entries.find(
        (e) => e.edge.from === fromId && e.edge.to === toId
      );
      if (entry && entry.scopes.length > 0 && !entry.scopes.includes(scope)) {
        return false;
      }
    }
    return true;
  }

  // -- Reputation ---------------------------------------------------------

  /**
   * Compute aggregate reputation for `toId` across all inbound edges.
   *
   * @param {string} toId
   * @returns {ReputationInfo}
   */
  getReputation(toId) {
    const inbound = this.#entries.filter((e) => e.edge.to === toId);
    if (inbound.length === 0) {
      return { trustCount: 0, avgLevel: 0, scopes: [] };
    }

    const total = inbound.reduce((sum, e) => sum + e.edge.value, 0);
    const avgLevel = total / inbound.length;

    const scopeSet = new Set();
    for (const e of inbound) {
      for (const s of e.scopes) scopeSet.add(s);
    }

    return {
      trustCount: inbound.length,
      avgLevel,
      scopes: [...scopeSet],
    };
  }

  // -- Reputation Decay ---------------------------------------------------

  /**
   * Record an interaction between two peers, updating the timestamp.
   *
   * @param {string} fromId
   * @param {string} toId
   * @param {number} [timestamp=Date.now()] - Override for testing
   */
  recordInteraction(fromId, toId, timestamp) {
    this.#interactions.set(`${fromId}|${toId}`, timestamp ?? Date.now());
  }

  /**
   * Get the timestamp of the last recorded interaction.
   *
   * @param {string} fromId
   * @param {string} toId
   * @returns {number|null} Timestamp or null if no interaction recorded
   */
  getLastInteraction(fromId, toId) {
    return this.#interactions.get(`${fromId}|${toId}`) ?? null;
  }

  /**
   * Get the trust level with time-based decay applied.
   *
   * If no interaction has been recorded for this pair, falls back to
   * the raw `getTrustLevel()` with no decay applied.
   *
   * @param {string} fromId
   * @param {string} toId
   * @param {object} [opts]
   * @param {number} [opts.decayRate=0.99] - Daily decay multiplier in (0, 1]
   * @param {number} [opts.now] - Current time for testing
   * @returns {number} Decayed trust in [0.0, 1.0]
   */
  getDecayedTrustLevel(fromId, toId, opts = {}) {
    const level = this.getTrustLevel(fromId, toId);
    const lastInteraction = this.getLastInteraction(fromId, toId);
    if (lastInteraction === null) return level;

    const now = opts.now ?? Date.now();
    const decayRate = opts.decayRate ?? 0.99;
    const daysSince = (now - lastInteraction) / (1000 * 60 * 60 * 24);
    return level * Math.pow(decayRate, daysSince);
  }

  /**
   * Batch-apply decay to all edges, pruning those that fall below threshold.
   *
   * For each edge, computes the decayed trust level. If the decayed value is
   * below 0.01, the edge is pruned. If `maxAgeDays` is provided, edges whose
   * last interaction is older than that are also pruned.
   *
   * @param {number|null} [maxAgeDays=null] - Prune interactions older than this
   * @returns {number} Number of edges pruned
   */
  applyDecay(maxAgeDays = null) {
    const now = Date.now();
    const msPerDay = 1000 * 60 * 60 * 24;
    let pruned = 0;

    this.#entries = this.#entries.filter((entry) => {
      const key = `${entry.edge.from}|${entry.edge.to}`;
      const lastInteraction = this.#interactions.get(key);

      // Check maxAgeDays constraint
      if (maxAgeDays !== null && lastInteraction !== undefined) {
        const ageDays = (now - lastInteraction) / msPerDay;
        if (ageDays > maxAgeDays) {
          this.#interactions.delete(key);
          pruned++;
          return false;
        }
      }

      // Check decay threshold
      if (lastInteraction !== undefined) {
        const daysSince = (now - lastInteraction) / msPerDay;
        const decayed = entry.edge.value * Math.pow(0.99, daysSince);
        if (decayed < 0.01) {
          this.#interactions.delete(key);
          pruned++;
          return false;
        }
      }

      return true;
    });

    return pruned;
  }

  // -- Maintenance --------------------------------------------------------

  /**
   * Remove all expired edges.
   *
   * @param {number} [now=Date.now()]
   * @returns {number} Number of edges pruned
   */
  pruneExpired(now = Date.now()) {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter(
      (e) => e.expires === null || e.expires > now
    );
    return before - this.#entries.length;
  }

  /** @returns {number} */
  get size() {
    return this.#entries.length;
  }

  // -- Serialization ------------------------------------------------------

  /**
   * Serialize the trust graph to a JSON-friendly array.
   *
   * @returns {object[]}
   */
  toJSON() {
    return this.#entries.map((e) => ({
      from: e.edge.from,
      to: e.edge.to,
      category: e.edge.category,
      value: e.edge.value,
      timestamp: e.edge.timestamp,
      scopes: [...e.scopes],
      expires: e.expires,
    }));
  }

  /**
   * Deserialize from an array of serialized edge data.
   *
   * @param {object[]} data
   * @returns {TrustGraph}
   */
  static fromJSON(data) {
    const tg = new TrustGraph();
    for (const item of data) {
      tg.addEdge(item.from, item.to, item.value, item.scopes || [], {
        category: item.category,
        timestamp: item.timestamp,
        expires: item.expires ?? null,
      });
    }
    return tg;
  }
}
