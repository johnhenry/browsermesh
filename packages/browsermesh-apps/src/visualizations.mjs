/**
 * clawser-mesh-visualizations.js -- Trust & Topology Visualization Data.
 *
 * Produces structured data for rendering trust graphs and mesh topology.
 * UI-agnostic — outputs JSON-friendly objects suitable for any renderer
 * (Canvas, SVG, D3, etc.).
 *
 * - TrustGraphLayout: positions nodes and edges for trust graph rendering.
 * - TrustHeatmap: aggregates trust levels into a grid/matrix.
 * - TopologySnapshot: captures current mesh topology state.
 * - TopologyLayout: assigns positions to topology nodes.
 * - TopologyDiff: computes changes between two topology snapshots.
 * - VisualizationExporter: serializes layouts for external renderers.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-visualizations.test.mjs
 */

// ---------------------------------------------------------------------------
// Wire Constants
// ---------------------------------------------------------------------------

/** Wire type for topology snapshot broadcast. */
export const TOPOLOGY_SNAPSHOT = 0xE6;

/** Wire type for topology diff broadcast. */
export const TOPOLOGY_DIFF = 0xE7;

// ---------------------------------------------------------------------------
// TrustGraphLayout
// ---------------------------------------------------------------------------

/**
 * Computes positions for trust graph visualization.
 * Uses a simple force-directed layout approximation.
 */
export class TrustGraphLayout {
  /** @type {{ id: string, x: number, y: number, label: string, trustLevel: number }[]} */
  #nodes = [];

  /** @type {{ from: string, to: string, weight: number, label?: string }[]} */
  #edges = [];

  /** @type {number} */
  #width;

  /** @type {number} */
  #height;

  /**
   * @param {object} [opts]
   * @param {number} [opts.width=800]
   * @param {number} [opts.height=600]
   */
  constructor({ width = 800, height = 600 } = {}) {
    this.#width = width;
    this.#height = height;
  }

  get width() { return this.#width; }
  get height() { return this.#height; }
  get nodeCount() { return this.#nodes.length; }
  get edgeCount() { return this.#edges.length; }

  /**
   * Add a node to the graph.
   * @param {string} id
   * @param {object} [opts]
   * @param {string} [opts.label]
   * @param {number} [opts.trustLevel=0.5]
   * @param {number} [opts.x] - Fixed x position (auto-placed if omitted)
   * @param {number} [opts.y] - Fixed y position (auto-placed if omitted)
   */
  addNode(id, { label, trustLevel = 0.5, x, y } = {}) {
    if (!id || typeof id !== 'string') {
      throw new Error('id is required and must be a non-empty string');
    }
    if (this.#nodes.some(n => n.id === id)) {
      throw new Error(`Duplicate node id: ${id}`);
    }
    this.#nodes.push({
      id,
      label: label || id,
      trustLevel: Math.max(0, Math.min(1, trustLevel)),
      x: x ?? Math.random() * this.#width,
      y: y ?? Math.random() * this.#height,
    });
  }

  /**
   * Add an edge between two nodes.
   * @param {string} from
   * @param {string} to
   * @param {object} [opts]
   * @param {number} [opts.weight=1.0] Trust weight
   * @param {string} [opts.label]
   */
  addEdge(from, to, { weight = 1.0, label } = {}) {
    if (!this.#nodes.some(n => n.id === from)) {
      throw new Error(`Unknown source node: ${from}`);
    }
    if (!this.#nodes.some(n => n.id === to)) {
      throw new Error(`Unknown target node: ${to}`);
    }
    this.#edges.push({ from, to, weight, label });
  }

  /**
   * Remove a node and its associated edges.
   * @param {string} id
   */
  removeNode(id) {
    const idx = this.#nodes.findIndex(n => n.id === id);
    if (idx === -1) throw new Error(`Node not found: ${id}`);
    this.#nodes.splice(idx, 1);
    this.#edges = this.#edges.filter(e => e.from !== id && e.to !== id);
  }

  /**
   * Run a simple spring-layout iteration.
   * Moves nodes toward attractive equilibrium.
   * @param {number} [iterations=50]
   * @param {number} [repulsion=5000]
   * @param {number} [attraction=0.01]
   */
  layout(iterations = 50, repulsion = 5000, attraction = 0.01) {
    for (let iter = 0; iter < iterations; iter++) {
      // Repulsive forces between all node pairs
      for (let i = 0; i < this.#nodes.length; i++) {
        for (let j = i + 1; j < this.#nodes.length; j++) {
          const a = this.#nodes[i];
          const b = this.#nodes[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.sqrt(dx * dx + dy * dy) || 1;
          const force = repulsion / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.x -= fx;
          a.y -= fy;
          b.x += fx;
          b.y += fy;
        }
      }

      // Attractive forces along edges
      for (const edge of this.#edges) {
        const a = this.#nodes.find(n => n.id === edge.from);
        const b = this.#nodes.find(n => n.id === edge.to);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const force = dist * attraction * edge.weight;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.x += fx;
        a.y += fy;
        b.x -= fx;
        b.y -= fy;
      }

      // Center gravity
      const cx = this.#width / 2;
      const cy = this.#height / 2;
      for (const n of this.#nodes) {
        n.x += (cx - n.x) * 0.01;
        n.y += (cy - n.y) * 0.01;
        // Clamp to bounds
        n.x = Math.max(20, Math.min(this.#width - 20, n.x));
        n.y = Math.max(20, Math.min(this.#height - 20, n.y));
      }
    }
  }

  /** Get node by ID. */
  getNode(id) {
    return this.#nodes.find(n => n.id === id) || null;
  }

  /** Get all nodes (copy). */
  getNodes() {
    return this.#nodes.map(n => ({ ...n }));
  }

  /** Get all edges (copy). */
  getEdges() {
    return this.#edges.map(e => ({ ...e }));
  }

  /** Get edges connected to a node. */
  getEdgesFor(nodeId) {
    return this.#edges.filter(e => e.from === nodeId || e.to === nodeId);
  }

  toJSON() {
    return {
      width: this.#width,
      height: this.#height,
      nodes: this.getNodes(),
      edges: this.getEdges(),
    };
  }

  static fromJSON(data) {
    const layout = new TrustGraphLayout({ width: data.width, height: data.height });
    for (const n of data.nodes) {
      layout.addNode(n.id, { label: n.label, trustLevel: n.trustLevel, x: n.x, y: n.y });
    }
    for (const e of data.edges) {
      layout.addEdge(e.from, e.to, { weight: e.weight, label: e.label });
    }
    return layout;
  }
}

// ---------------------------------------------------------------------------
// TrustHeatmap
// ---------------------------------------------------------------------------

/**
 * Aggregates trust relationships into a matrix for heatmap rendering.
 */
export class TrustHeatmap {
  /** @type {string[]} */
  #podIds = [];

  /** @type {Map<string, Map<string, number>>} from → (to → level) */
  #matrix = new Map();

  /**
   * Add a pod to the heatmap.
   * @param {string} podId
   */
  addPod(podId) {
    if (!this.#podIds.includes(podId)) {
      this.#podIds.push(podId);
      this.#matrix.set(podId, new Map());
    }
  }

  /**
   * Set trust level between two pods.
   * @param {string} from
   * @param {string} to
   * @param {number} level - Trust level [0.0, 1.0]
   */
  setTrust(from, to, level) {
    this.addPod(from);
    this.addPod(to);
    this.#matrix.get(from).set(to, Math.max(0, Math.min(1, level)));
  }

  /**
   * Get trust level between two pods.
   * @param {string} from
   * @param {string} to
   * @returns {number} Trust level (0 if not set)
   */
  getTrust(from, to) {
    return this.#matrix.get(from)?.get(to) ?? 0;
  }

  /** Get the ordered list of pod IDs (rows/columns). */
  getPodIds() {
    return [...this.#podIds];
  }

  /** Get the number of pods. */
  get size() {
    return this.#podIds.length;
  }

  /**
   * Export as a 2D number array [rows][cols].
   * @returns {number[][]}
   */
  toMatrix() {
    return this.#podIds.map(from =>
      this.#podIds.map(to => this.getTrust(from, to))
    );
  }

  /**
   * Get row (outbound trust from a pod).
   * @param {string} podId
   * @returns {Object} { podId: level }
   */
  getRow(podId) {
    const row = {};
    for (const to of this.#podIds) {
      row[to] = this.getTrust(podId, to);
    }
    return row;
  }

  /**
   * Get column (inbound trust to a pod).
   * @param {string} podId
   * @returns {Object} { podId: level }
   */
  getColumn(podId) {
    const col = {};
    for (const from of this.#podIds) {
      col[from] = this.getTrust(from, podId);
    }
    return col;
  }

  /**
   * Compute average inbound trust for a pod.
   * @param {string} podId
   * @returns {number}
   */
  averageInbound(podId) {
    const others = this.#podIds.filter(p => p !== podId);
    if (others.length === 0) return 0;
    const sum = others.reduce((s, from) => s + this.getTrust(from, podId), 0);
    return sum / others.length;
  }

  toJSON() {
    return {
      podIds: [...this.#podIds],
      matrix: this.toMatrix(),
    };
  }

  static fromJSON(data) {
    const hm = new TrustHeatmap();
    for (const id of data.podIds) hm.addPod(id);
    for (let i = 0; i < data.podIds.length; i++) {
      for (let j = 0; j < data.podIds.length; j++) {
        if (data.matrix[i][j] > 0) {
          hm.setTrust(data.podIds[i], data.podIds[j], data.matrix[i][j]);
        }
      }
    }
    return hm;
  }
}

// ---------------------------------------------------------------------------
// TopologySnapshot
// ---------------------------------------------------------------------------

/**
 * Captures current mesh topology state at a point in time.
 */
export class TopologySnapshot {
  /**
   * @param {object} opts
   * @param {string} [opts.id]
   * @param {number} [opts.timestamp]
   * @param {{ id: string, label?: string, type?: string, status?: string, x?: number, y?: number }[]} [opts.nodes]
   * @param {{ from: string, to: string, transport?: string, latency?: number, status?: string }[]} [opts.links]
   * @param {Object} [opts.metadata]
   */
  constructor({
    id,
    timestamp,
    nodes = [],
    links = [],
    metadata = {},
  } = {}) {
    this.id = id || `topo_${Date.now()}`;
    this.timestamp = timestamp || Date.now();
    this.nodes = nodes.map(n => ({ ...n }));
    this.links = links.map(l => ({ ...l }));
    this.metadata = { ...metadata };
  }

  /** Number of nodes. */
  get nodeCount() {
    return this.nodes.length;
  }

  /** Number of links. */
  get linkCount() {
    return this.links.length;
  }

  /** Find node by ID. */
  getNode(id) {
    return this.nodes.find(n => n.id === id) || null;
  }

  /** Get links for a specific node. */
  getLinksFor(nodeId) {
    return this.links.filter(l => l.from === nodeId || l.to === nodeId);
  }

  /** Get the set of unique transport types in use. */
  getTransportTypes() {
    const types = new Set();
    for (const l of this.links) {
      if (l.transport) types.add(l.transport);
    }
    return [...types];
  }

  /** Compute average latency across all links. */
  averageLatency() {
    const withLatency = this.links.filter(l => typeof l.latency === 'number');
    if (withLatency.length === 0) return 0;
    return withLatency.reduce((s, l) => s + l.latency, 0) / withLatency.length;
  }

  /** Get nodes with a specific status. */
  getNodesByStatus(status) {
    return this.nodes.filter(n => n.status === status);
  }

  toJSON() {
    return {
      id: this.id,
      timestamp: this.timestamp,
      nodes: this.nodes.map(n => ({ ...n })),
      links: this.links.map(l => ({ ...l })),
      metadata: { ...this.metadata },
    };
  }

  static fromJSON(data) {
    return new TopologySnapshot(data);
  }
}

// ---------------------------------------------------------------------------
// TopologyLayout
// ---------------------------------------------------------------------------

/**
 * Assigns positions to topology nodes using layout algorithms.
 */
export class TopologyLayout {
  /** @type {number} */
  #width;
  /** @type {number} */
  #height;

  /**
   * @param {object} [opts]
   * @param {number} [opts.width=800]
   * @param {number} [opts.height=600]
   */
  constructor({ width = 800, height = 600 } = {}) {
    this.#width = width;
    this.#height = height;
  }

  get width() { return this.#width; }
  get height() { return this.#height; }

  /**
   * Apply circular layout: nodes evenly distributed on a circle.
   * @param {TopologySnapshot} snapshot
   * @returns {TopologySnapshot} New snapshot with positions
   */
  circular(snapshot) {
    const cx = this.#width / 2;
    const cy = this.#height / 2;
    const radius = Math.min(cx, cy) * 0.8;
    const n = snapshot.nodes.length;

    const positioned = snapshot.nodes.map((node, i) => ({
      ...node,
      x: cx + radius * Math.cos((2 * Math.PI * i) / n),
      y: cy + radius * Math.sin((2 * Math.PI * i) / n),
    }));

    return new TopologySnapshot({
      ...snapshot.toJSON(),
      nodes: positioned,
    });
  }

  /**
   * Apply grid layout: nodes placed in rows and columns.
   * @param {TopologySnapshot} snapshot
   * @param {number} [cols] - Columns (auto-computed if omitted)
   * @returns {TopologySnapshot} New snapshot with positions
   */
  grid(snapshot, cols) {
    const n = snapshot.nodes.length;
    const c = cols || Math.ceil(Math.sqrt(n));
    const cellW = this.#width / (c + 1);
    const cellH = this.#height / (Math.ceil(n / c) + 1);

    const positioned = snapshot.nodes.map((node, i) => ({
      ...node,
      x: ((i % c) + 1) * cellW,
      y: (Math.floor(i / c) + 1) * cellH,
    }));

    return new TopologySnapshot({
      ...snapshot.toJSON(),
      nodes: positioned,
    });
  }

  /**
   * Apply hierarchical layout: nodes arranged by connection depth.
   * Root nodes (no incoming links) are at the top.
   * @param {TopologySnapshot} snapshot
   * @returns {TopologySnapshot}
   */
  hierarchical(snapshot) {
    // Compute depth for each node via BFS from roots
    const inbound = new Map();
    for (const l of snapshot.links) {
      if (!inbound.has(l.to)) inbound.set(l.to, []);
      inbound.get(l.to).push(l.from);
    }

    // Roots: nodes with no inbound links
    const roots = snapshot.nodes.filter(n => !inbound.has(n.id) || inbound.get(n.id).length === 0);
    const depths = new Map();
    const queue = roots.map(r => r.id);
    for (const r of queue) depths.set(r, 0);

    let head = 0;
    while (head < queue.length) {
      const current = queue[head++];
      const d = depths.get(current);
      for (const l of snapshot.links.filter(l => l.from === current)) {
        if (!depths.has(l.to)) {
          depths.set(l.to, d + 1);
          queue.push(l.to);
        }
      }
    }

    // Assign depth 0 to any unvisited nodes
    for (const n of snapshot.nodes) {
      if (!depths.has(n.id)) depths.set(n.id, 0);
    }

    const maxDepth = Math.max(...depths.values(), 0);
    const levelHeight = this.#height / (maxDepth + 2);

    // Group by level
    const levels = new Map();
    for (const [id, d] of depths) {
      if (!levels.has(d)) levels.set(d, []);
      levels.get(d).push(id);
    }

    const positioned = snapshot.nodes.map(node => {
      const d = depths.get(node.id);
      const levelNodes = levels.get(d);
      const idx = levelNodes.indexOf(node.id);
      const levelWidth = this.#width / (levelNodes.length + 1);
      return {
        ...node,
        x: (idx + 1) * levelWidth,
        y: (d + 1) * levelHeight,
      };
    });

    return new TopologySnapshot({
      ...snapshot.toJSON(),
      nodes: positioned,
    });
  }
}

// ---------------------------------------------------------------------------
// TopologyDiff
// ---------------------------------------------------------------------------

/**
 * Computes changes between two topology snapshots.
 */
export class TopologyDiff {
  /**
   * @param {object} opts
   * @param {{ id: string }[]} [opts.addedNodes]
   * @param {{ id: string }[]} [opts.removedNodes]
   * @param {{ id: string, changes: Object }[]} [opts.changedNodes]
   * @param {{ from: string, to: string }[]} [opts.addedLinks]
   * @param {{ from: string, to: string }[]} [opts.removedLinks]
   * @param {{ from: string, to: string, changes: Object }[]} [opts.changedLinks]
   * @param {number} [opts.timestamp]
   */
  constructor({
    addedNodes = [],
    removedNodes = [],
    changedNodes = [],
    addedLinks = [],
    removedLinks = [],
    changedLinks = [],
    timestamp,
  } = {}) {
    this.addedNodes = addedNodes;
    this.removedNodes = removedNodes;
    this.changedNodes = changedNodes;
    this.addedLinks = addedLinks;
    this.removedLinks = removedLinks;
    this.changedLinks = changedLinks;
    this.timestamp = timestamp || Date.now();
  }

  /** True if no changes exist. */
  get isEmpty() {
    return this.addedNodes.length === 0 &&
           this.removedNodes.length === 0 &&
           this.changedNodes.length === 0 &&
           this.addedLinks.length === 0 &&
           this.removedLinks.length === 0 &&
           this.changedLinks.length === 0;
  }

  /** Total number of changes. */
  get changeCount() {
    return this.addedNodes.length + this.removedNodes.length +
           this.changedNodes.length + this.addedLinks.length +
           this.removedLinks.length + this.changedLinks.length;
  }

  /**
   * Compute diff between two snapshots.
   * @param {TopologySnapshot} before
   * @param {TopologySnapshot} after
   * @returns {TopologyDiff}
   */
  static compute(before, after) {
    const beforeNodeIds = new Set(before.nodes.map(n => n.id));
    const afterNodeIds = new Set(after.nodes.map(n => n.id));

    const addedNodes = after.nodes.filter(n => !beforeNodeIds.has(n.id));
    const removedNodes = before.nodes.filter(n => !afterNodeIds.has(n.id));

    const changedNodes = [];
    for (const an of after.nodes) {
      if (!beforeNodeIds.has(an.id)) continue;
      const bn = before.nodes.find(n => n.id === an.id);
      const changes = {};
      for (const key of Object.keys(an)) {
        if (key === 'id') continue;
        if (JSON.stringify(an[key]) !== JSON.stringify(bn[key])) {
          changes[key] = { from: bn[key], to: an[key] };
        }
      }
      if (Object.keys(changes).length > 0) {
        changedNodes.push({ id: an.id, changes });
      }
    }

    // Link comparison (identify by from+to)
    const linkKey = l => `${l.from}->${l.to}`;
    const beforeLinks = new Map(before.links.map(l => [linkKey(l), l]));
    const afterLinks = new Map(after.links.map(l => [linkKey(l), l]));

    const addedLinks = after.links.filter(l => !beforeLinks.has(linkKey(l)));
    const removedLinks = before.links.filter(l => !afterLinks.has(linkKey(l)));

    const changedLinks = [];
    for (const [key, al] of afterLinks) {
      const bl = beforeLinks.get(key);
      if (!bl) continue;
      const changes = {};
      for (const k of Object.keys(al)) {
        if (k === 'from' || k === 'to') continue;
        if (JSON.stringify(al[k]) !== JSON.stringify(bl[k])) {
          changes[k] = { from: bl[k], to: al[k] };
        }
      }
      if (Object.keys(changes).length > 0) {
        changedLinks.push({ from: al.from, to: al.to, changes });
      }
    }

    return new TopologyDiff({
      addedNodes, removedNodes, changedNodes,
      addedLinks, removedLinks, changedLinks,
    });
  }

  toJSON() {
    return {
      addedNodes: this.addedNodes,
      removedNodes: this.removedNodes,
      changedNodes: this.changedNodes,
      addedLinks: this.addedLinks,
      removedLinks: this.removedLinks,
      changedLinks: this.changedLinks,
      timestamp: this.timestamp,
    };
  }

  static fromJSON(data) {
    return new TopologyDiff(data);
  }
}

// ---------------------------------------------------------------------------
// VisualizationExporter
// ---------------------------------------------------------------------------

/**
 * Serializes visualization layouts for external renderers.
 */
// ---------------------------------------------------------------------------
// TopologyBroadcaster
// ---------------------------------------------------------------------------

/**
 * Broadcasts and receives topology snapshots and diffs over the mesh wire protocol.
 */
export class TopologyBroadcaster {
  /** @type {string} */
  #localPodId;

  /** @type {Function} (targetId, msg) => void */
  #sendFn;

  /** @type {Function[]} */
  #snapshotListeners = [];

  /** @type {Function[]} */
  #diffListeners = [];

  /**
   * @param {object} opts
   * @param {string} opts.localPodId
   * @param {Function} opts.sendFn - Send function: (targetId, msg) => {}
   */
  constructor({ localPodId, sendFn }) {
    if (!localPodId || typeof localPodId !== 'string') {
      throw new Error('localPodId is required and must be a non-empty string');
    }
    if (typeof sendFn !== 'function') {
      throw new Error('sendFn is required and must be a function');
    }
    this.#localPodId = localPodId;
    this.#sendFn = sendFn;
  }

  /**
   * Handle an incoming wire message.
   * @param {string} fromId - Sender pod ID
   * @param {object} msg - Message with `type` field
   */
  handleMessage(fromId, msg) {
    switch (msg.type) {
      case TOPOLOGY_SNAPSHOT: {
        if (!msg.snapshot) break;
        const snapshot = TopologySnapshot.fromJSON(msg.snapshot);
        for (const cb of this.#snapshotListeners) cb(fromId, snapshot);
        break;
      }

      case TOPOLOGY_DIFF: {
        if (!msg.diff) break;
        const diff = TopologyDiff.fromJSON(msg.diff);
        for (const cb of this.#diffListeners) cb(fromId, diff);
        break;
      }

      default:
        break;
    }
  }

  /**
   * Broadcast a topology snapshot to listed peers.
   * @param {string[]} peerIds
   * @param {TopologySnapshot} snapshot
   */
  broadcastSnapshot(peerIds, snapshot) {
    const payload = { type: TOPOLOGY_SNAPSHOT, snapshot: snapshot.toJSON() };
    for (const peerId of peerIds) {
      this.#sendFn(peerId, payload);
    }
  }

  /**
   * Broadcast a topology diff to listed peers.
   * @param {string[]} peerIds
   * @param {TopologyDiff} diff
   */
  broadcastDiff(peerIds, diff) {
    const payload = { type: TOPOLOGY_DIFF, diff: diff.toJSON() };
    for (const peerId of peerIds) {
      this.#sendFn(peerId, payload);
    }
  }

  /**
   * Register a listener for incoming topology snapshots.
   * @param {Function} cb - (fromId, TopologySnapshot) => void
   */
  onSnapshot(cb) {
    this.#snapshotListeners.push(cb);
  }

  /**
   * Remove a snapshot listener.
   * @param {Function} cb
   * @returns {boolean} True if the listener was found and removed
   */
  offSnapshot(cb) {
    const idx = this.#snapshotListeners.indexOf(cb);
    if (idx !== -1) { this.#snapshotListeners.splice(idx, 1); return true; }
    return false;
  }

  /**
   * Register a listener for incoming topology diffs.
   * @param {Function} cb - (fromId, TopologyDiff) => void
   */
  onDiff(cb) {
    this.#diffListeners.push(cb);
  }

  /**
   * Remove a diff listener.
   * @param {Function} cb
   * @returns {boolean} True if the listener was found and removed
   */
  offDiff(cb) {
    const idx = this.#diffListeners.indexOf(cb);
    if (idx !== -1) { this.#diffListeners.splice(idx, 1); return true; }
    return false;
  }
}

// ---------------------------------------------------------------------------
// VisualizationExporter
// ---------------------------------------------------------------------------

/**
 * Serializes visualization layouts for external renderers.
 */
export class VisualizationExporter {
  /**
   * Export a TrustGraphLayout as a node-link JSON format.
   * @param {TrustGraphLayout} layout
   * @returns {Object}
   */
  exportTrustGraph(layout) {
    return {
      type: 'trust-graph',
      ...layout.toJSON(),
      exportedAt: Date.now(),
    };
  }

  /**
   * Export a TrustHeatmap as a matrix format.
   * @param {TrustHeatmap} heatmap
   * @returns {Object}
   */
  exportHeatmap(heatmap) {
    return {
      type: 'trust-heatmap',
      ...heatmap.toJSON(),
      exportedAt: Date.now(),
    };
  }

  /**
   * Export a TopologySnapshot as renderable data.
   * @param {TopologySnapshot} snapshot
   * @param {TopologyLayout} [layoutEngine]
   * @param {string} [layoutType='circular']
   * @returns {Object}
   */
  exportTopology(snapshot, layoutEngine, layoutType = 'circular') {
    let positioned = snapshot;
    if (layoutEngine) {
      switch (layoutType) {
        case 'circular':  positioned = layoutEngine.circular(snapshot); break;
        case 'grid':      positioned = layoutEngine.grid(snapshot); break;
        case 'hierarchical': positioned = layoutEngine.hierarchical(snapshot); break;
        default: positioned = layoutEngine.circular(snapshot);
      }
    }
    return {
      type: 'topology',
      ...positioned.toJSON(),
      layout: layoutType,
      exportedAt: Date.now(),
    };
  }

  /**
   * Export a TopologyDiff as renderable change data.
   * @param {TopologyDiff} diff
   * @returns {Object}
   */
  exportDiff(diff) {
    return {
      type: 'topology-diff',
      ...diff.toJSON(),
      exportedAt: Date.now(),
    };
  }
}
