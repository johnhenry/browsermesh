/**
 * Categories of trust relationships between pods.
 *
 * @enum {string}
 */
export const TRUST_CATEGORIES = Object.freeze({
  /** Direct interaction history */
  DIRECT: "direct",
  /** Vouched for by a trusted peer */
  TRANSITIVE: "transitive",
  /** Shared group or federation membership */
  MEMBERSHIP: "membership",
  /** Reputation from external attestations */
  REPUTATION: "reputation",
});

/**
 * @typedef {object} TrustEdge
 * @property {string} from - Truster pod ID
 * @property {string} to - Trustee pod ID
 * @property {string} category - One of TRUST_CATEGORIES
 * @property {number} value - Trust level in [0.0, 1.0]
 * @property {number} timestamp - Unix timestamp of last update
 */

/**
 * Create a trust edge.
 *
 * @param {object} opts
 * @param {string} opts.from
 * @param {string} opts.to
 * @param {string} opts.category - One of TRUST_CATEGORIES
 * @param {number} opts.value - Must be in [0.0, 1.0]
 * @param {number} [opts.timestamp=Date.now()]
 * @returns {TrustEdge}
 */
export function createTrustEdge({ from, to, category, value, timestamp = Date.now() }) {
  if (value < 0 || value > 1) {
    throw new RangeError(`Trust value must be in [0.0, 1.0], got ${value}`);
  }
  return Object.freeze({ from, to, category, value, timestamp });
}

/**
 * Compute transitive trust from source to target through a trust graph.
 * Uses multiplicative path aggregation with max over paths.
 *
 * @param {TrustEdge[]} edges - All known trust edges
 * @param {string} source - Source pod ID
 * @param {string} target - Target pod ID
 * @param {number} [maxDepth=3] - Maximum path length
 * @returns {number} Computed trust level in [0.0, 1.0]
 */
export function computeTransitiveTrust(edges, source, target, maxDepth = 3) {
  if (source === target) return 1.0;

  // Build adjacency map: from -> [{to, value}]
  const adj = new Map();
  for (const edge of edges) {
    if (edge.value <= 0) continue; // blocked edges never propagate
    if (!adj.has(edge.from)) adj.set(edge.from, []);
    adj.get(edge.from).push({ to: edge.to, value: edge.value });
  }

  // BFS with trust propagation
  let bestTrust = 0;
  // Queue entries: [node, currentTrust, depth, visited]
  const queue = [[source, 1.0, 0, new Set([source])]];

  while (queue.length > 0) {
    const [node, trust, depth, visited] = queue.shift();
    if (depth >= maxDepth) continue;

    const neighbors = adj.get(node) || [];
    for (const { to, value } of neighbors) {
      if (visited.has(to)) continue;
      const pathTrust = trust * value;
      if (to === target) {
        bestTrust = Math.max(bestTrust, pathTrust);
        continue;
      }
      if (pathTrust > bestTrust) { // Only explore if could improve
        const newVisited = new Set(visited);
        newVisited.add(to);
        queue.push([to, pathTrust, depth + 1, newVisited]);
      }
    }
  }

  return bestTrust;
}
