import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  TrustGraphLayout,
  TrustHeatmap,
  TopologySnapshot,
  TopologyLayout,
  TopologyDiff,
  TopologyBroadcaster,
  VisualizationExporter,
  TOPOLOGY_SNAPSHOT,
  TOPOLOGY_DIFF,
} from '../src/visualizations.mjs';

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('has correct hex values', () => {
    assert.equal(TOPOLOGY_SNAPSHOT, 0xE6);
    assert.equal(TOPOLOGY_DIFF, 0xE7);
  });
});

// ---------------------------------------------------------------------------
// TrustGraphLayout
// ---------------------------------------------------------------------------

describe('TrustGraphLayout', () => {
  let layout;

  beforeEach(() => {
    layout = new TrustGraphLayout({ width: 400, height: 300 });
  });

  it('sets defaults', () => {
    const def = new TrustGraphLayout();
    assert.equal(def.width, 800);
    assert.equal(def.height, 600);
  });

  it('addNode() requires id', () => {
    assert.throws(() => layout.addNode(''), /id/);
  });

  it('addNode() rejects duplicates', () => {
    layout.addNode('a');
    assert.throws(() => layout.addNode('a'), /Duplicate/);
  });

  it('addNode() accepts position', () => {
    layout.addNode('a', { x: 100, y: 200, trustLevel: 0.8, label: 'Alice' });
    const node = layout.getNode('a');
    assert.equal(node.x, 100);
    assert.equal(node.y, 200);
    assert.equal(node.trustLevel, 0.8);
    assert.equal(node.label, 'Alice');
  });

  it('addNode() clamps trustLevel', () => {
    layout.addNode('a', { trustLevel: 1.5 });
    assert.equal(layout.getNode('a').trustLevel, 1.0);
    layout.addNode('b', { trustLevel: -0.5 });
    assert.equal(layout.getNode('b').trustLevel, 0.0);
  });

  it('addEdge() requires known nodes', () => {
    layout.addNode('a');
    assert.throws(() => layout.addEdge('a', 'b'), /Unknown target/);
    assert.throws(() => layout.addEdge('c', 'a'), /Unknown source/);
  });

  it('addEdge() creates edge', () => {
    layout.addNode('a');
    layout.addNode('b');
    layout.addEdge('a', 'b', { weight: 0.7, label: 'trusts' });
    assert.equal(layout.edgeCount, 1);
    const edges = layout.getEdges();
    assert.equal(edges[0].weight, 0.7);
  });

  it('removeNode() removes node and edges', () => {
    layout.addNode('a');
    layout.addNode('b');
    layout.addEdge('a', 'b');
    layout.removeNode('a');
    assert.equal(layout.nodeCount, 1);
    assert.equal(layout.edgeCount, 0);
  });

  it('removeNode() throws for unknown', () => {
    assert.throws(() => layout.removeNode('x'), /not found/);
  });

  it('getEdgesFor() returns connected edges', () => {
    layout.addNode('a');
    layout.addNode('b');
    layout.addNode('c');
    layout.addEdge('a', 'b');
    layout.addEdge('b', 'c');
    assert.equal(layout.getEdgesFor('b').length, 2);
    assert.equal(layout.getEdgesFor('a').length, 1);
  });

  it('layout() adjusts positions', () => {
    layout.addNode('a', { x: 100, y: 100 });
    layout.addNode('b', { x: 100, y: 101 });
    layout.addEdge('a', 'b');
    const beforeA = { ...layout.getNode('a') };
    layout.layout(10);
    const afterA = layout.getNode('a');
    // Positions should have changed due to repulsive forces
    assert.ok(afterA.x !== beforeA.x || afterA.y !== beforeA.y);
  });

  it('layout() keeps nodes within bounds', () => {
    layout.addNode('a', { x: 0, y: 0 });
    layout.addNode('b', { x: 400, y: 300 });
    layout.layout(10);
    const a = layout.getNode('a');
    const b = layout.getNode('b');
    assert.ok(a.x >= 20 && a.x <= 380);
    assert.ok(a.y >= 20 && a.y <= 280);
    assert.ok(b.x >= 20 && b.x <= 380);
  });

  describe('toJSON / fromJSON', () => {
    it('round-trips', () => {
      layout.addNode('a', { x: 50, y: 50, trustLevel: 0.9 });
      layout.addNode('b', { x: 150, y: 150 });
      layout.addEdge('a', 'b', { weight: 0.5 });
      const restored = TrustGraphLayout.fromJSON(layout.toJSON());
      assert.equal(restored.nodeCount, 2);
      assert.equal(restored.edgeCount, 1);
      assert.equal(restored.width, 400);
    });
  });
});

// ---------------------------------------------------------------------------
// TrustHeatmap
// ---------------------------------------------------------------------------

describe('TrustHeatmap', () => {
  let heatmap;

  beforeEach(() => {
    heatmap = new TrustHeatmap();
  });

  it('starts empty', () => {
    assert.equal(heatmap.size, 0);
  });

  it('addPod() adds pod ids', () => {
    heatmap.addPod('a');
    heatmap.addPod('b');
    assert.equal(heatmap.size, 2);
    // Adding same pod again is a no-op
    heatmap.addPod('a');
    assert.equal(heatmap.size, 2);
  });

  it('setTrust / getTrust', () => {
    heatmap.setTrust('a', 'b', 0.8);
    assert.equal(heatmap.getTrust('a', 'b'), 0.8);
    assert.equal(heatmap.getTrust('b', 'a'), 0); // not set
  });

  it('setTrust clamps to [0,1]', () => {
    heatmap.setTrust('a', 'b', 1.5);
    assert.equal(heatmap.getTrust('a', 'b'), 1.0);
    heatmap.setTrust('a', 'b', -0.3);
    assert.equal(heatmap.getTrust('a', 'b'), 0.0);
  });

  it('setTrust auto-adds pods', () => {
    heatmap.setTrust('x', 'y', 0.5);
    assert.equal(heatmap.size, 2);
  });

  it('toMatrix() returns 2D array', () => {
    heatmap.setTrust('a', 'b', 0.8);
    heatmap.setTrust('b', 'a', 0.6);
    const m = heatmap.toMatrix();
    assert.equal(m.length, 2);
    assert.equal(m[0].length, 2);
    assert.equal(m[0][1], 0.8); // a→b
    assert.equal(m[1][0], 0.6); // b→a
    assert.equal(m[0][0], 0);   // a→a
  });

  it('getRow() returns outbound trust', () => {
    heatmap.setTrust('a', 'b', 0.8);
    heatmap.setTrust('a', 'c', 0.3);
    const row = heatmap.getRow('a');
    assert.equal(row.b, 0.8);
    assert.equal(row.c, 0.3);
  });

  it('getColumn() returns inbound trust', () => {
    heatmap.setTrust('a', 'c', 0.8);
    heatmap.setTrust('b', 'c', 0.6);
    const col = heatmap.getColumn('c');
    assert.equal(col.a, 0.8);
    assert.equal(col.b, 0.6);
  });

  it('averageInbound() computes mean', () => {
    heatmap.setTrust('a', 'c', 0.8);
    heatmap.setTrust('b', 'c', 0.6);
    const avg = heatmap.averageInbound('c');
    assert.ok(Math.abs(avg - 0.7) < 0.001);
  });

  it('averageInbound() returns 0 for single pod', () => {
    heatmap.addPod('a');
    assert.equal(heatmap.averageInbound('a'), 0);
  });

  describe('toJSON / fromJSON', () => {
    it('round-trips', () => {
      heatmap.setTrust('a', 'b', 0.9);
      heatmap.setTrust('b', 'a', 0.4);
      const restored = TrustHeatmap.fromJSON(heatmap.toJSON());
      assert.equal(restored.getTrust('a', 'b'), 0.9);
      assert.equal(restored.getTrust('b', 'a'), 0.4);
      assert.equal(restored.size, 2);
    });
  });
});

// ---------------------------------------------------------------------------
// TopologySnapshot
// ---------------------------------------------------------------------------

describe('TopologySnapshot', () => {
  let snapshot;

  beforeEach(() => {
    snapshot = new TopologySnapshot({
      nodes: [
        { id: 'a', label: 'Alice', status: 'connected' },
        { id: 'b', label: 'Bob', status: 'connected' },
        { id: 'c', label: 'Charlie', status: 'disconnected' },
      ],
      links: [
        { from: 'a', to: 'b', transport: 'webrtc', latency: 25 },
        { from: 'b', to: 'c', transport: 'wsh-ws', latency: 50 },
      ],
    });
  });

  it('sets defaults', () => {
    const empty = new TopologySnapshot();
    assert.equal(empty.nodeCount, 0);
    assert.equal(empty.linkCount, 0);
    assert.ok(empty.id.startsWith('topo_'));
  });

  it('nodeCount and linkCount', () => {
    assert.equal(snapshot.nodeCount, 3);
    assert.equal(snapshot.linkCount, 2);
  });

  it('getNode() finds by id', () => {
    assert.equal(snapshot.getNode('a').label, 'Alice');
    assert.equal(snapshot.getNode('x'), null);
  });

  it('getLinksFor() returns connected links', () => {
    assert.equal(snapshot.getLinksFor('b').length, 2);
    assert.equal(snapshot.getLinksFor('c').length, 1);
  });

  it('getTransportTypes() returns unique types', () => {
    const types = snapshot.getTransportTypes();
    assert.ok(types.includes('webrtc'));
    assert.ok(types.includes('wsh-ws'));
    assert.equal(types.length, 2);
  });

  it('averageLatency() computes mean', () => {
    assert.equal(snapshot.averageLatency(), 37.5);
  });

  it('averageLatency() returns 0 for no links', () => {
    const empty = new TopologySnapshot();
    assert.equal(empty.averageLatency(), 0);
  });

  it('getNodesByStatus() filters nodes', () => {
    assert.equal(snapshot.getNodesByStatus('connected').length, 2);
    assert.equal(snapshot.getNodesByStatus('disconnected').length, 1);
  });

  describe('toJSON / fromJSON', () => {
    it('round-trips', () => {
      const restored = TopologySnapshot.fromJSON(snapshot.toJSON());
      assert.equal(restored.nodeCount, 3);
      assert.equal(restored.linkCount, 2);
      assert.equal(restored.getNode('a').label, 'Alice');
    });
  });
});

// ---------------------------------------------------------------------------
// TopologyLayout
// ---------------------------------------------------------------------------

describe('TopologyLayout', () => {
  let engine, snapshot;

  beforeEach(() => {
    engine = new TopologyLayout({ width: 400, height: 300 });
    snapshot = new TopologySnapshot({
      nodes: [
        { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' },
      ],
      links: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'd' },
      ],
    });
  });

  it('circular() positions nodes on a circle', () => {
    const result = engine.circular(snapshot);
    assert.equal(result.nodeCount, 4);
    // All nodes should have x,y positions
    for (const n of result.nodes) {
      assert.ok(typeof n.x === 'number');
      assert.ok(typeof n.y === 'number');
    }
  });

  it('circular() returns new snapshot (immutable)', () => {
    const result = engine.circular(snapshot);
    // New snapshot object — original nodes should be unmodified
    assert.notEqual(result, snapshot);
    assert.equal(snapshot.nodes[0].x, undefined); // original has no x
    assert.ok(typeof result.nodes[0].x === 'number'); // result has x
  });

  it('grid() positions nodes in grid', () => {
    const result = engine.grid(snapshot, 2);
    assert.equal(result.nodeCount, 4);
    // Check that nodes are arranged in 2 columns
    const xs = result.nodes.map(n => n.x);
    const uniqueXs = [...new Set(xs)];
    assert.equal(uniqueXs.length, 2);
  });

  it('grid() auto-computes columns', () => {
    const result = engine.grid(snapshot);
    assert.equal(result.nodeCount, 4);
    for (const n of result.nodes) {
      assert.ok(n.x > 0);
      assert.ok(n.y > 0);
    }
  });

  it('hierarchical() arranges by depth', () => {
    const result = engine.hierarchical(snapshot);
    assert.equal(result.nodeCount, 4);
    // Node 'a' should be at top (root), 'd' at bottom
    const aNode = result.nodes.find(n => n.id === 'a');
    const dNode = result.nodes.find(n => n.id === 'd');
    assert.ok(aNode.y < dNode.y);
  });

  it('hierarchical() handles disconnected nodes', () => {
    const disconnected = new TopologySnapshot({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'isolated' }],
      links: [{ from: 'a', to: 'b' }],
    });
    const result = engine.hierarchical(disconnected);
    assert.equal(result.nodeCount, 3);
    // Isolated node should still have position
    const iso = result.nodes.find(n => n.id === 'isolated');
    assert.ok(typeof iso.x === 'number');
  });
});

// ---------------------------------------------------------------------------
// TopologyDiff
// ---------------------------------------------------------------------------

describe('TopologyDiff', () => {
  it('isEmpty for identical snapshots', () => {
    const s = new TopologySnapshot({
      nodes: [{ id: 'a' }],
      links: [],
    });
    const diff = TopologyDiff.compute(s, s);
    assert.equal(diff.isEmpty, true);
    assert.equal(diff.changeCount, 0);
  });

  it('detects added nodes', () => {
    const before = new TopologySnapshot({ nodes: [{ id: 'a' }] });
    const after = new TopologySnapshot({ nodes: [{ id: 'a' }, { id: 'b' }] });
    const diff = TopologyDiff.compute(before, after);
    assert.equal(diff.addedNodes.length, 1);
    assert.equal(diff.addedNodes[0].id, 'b');
  });

  it('detects removed nodes', () => {
    const before = new TopologySnapshot({ nodes: [{ id: 'a' }, { id: 'b' }] });
    const after = new TopologySnapshot({ nodes: [{ id: 'a' }] });
    const diff = TopologyDiff.compute(before, after);
    assert.equal(diff.removedNodes.length, 1);
    assert.equal(diff.removedNodes[0].id, 'b');
  });

  it('detects changed nodes', () => {
    const before = new TopologySnapshot({ nodes: [{ id: 'a', status: 'connected' }] });
    const after = new TopologySnapshot({ nodes: [{ id: 'a', status: 'disconnected' }] });
    const diff = TopologyDiff.compute(before, after);
    assert.equal(diff.changedNodes.length, 1);
    assert.equal(diff.changedNodes[0].id, 'a');
    assert.equal(diff.changedNodes[0].changes.status.from, 'connected');
    assert.equal(diff.changedNodes[0].changes.status.to, 'disconnected');
  });

  it('detects added links', () => {
    const before = new TopologySnapshot({ nodes: [{ id: 'a' }, { id: 'b' }], links: [] });
    const after = new TopologySnapshot({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ from: 'a', to: 'b' }],
    });
    const diff = TopologyDiff.compute(before, after);
    assert.equal(diff.addedLinks.length, 1);
  });

  it('detects removed links', () => {
    const before = new TopologySnapshot({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ from: 'a', to: 'b' }],
    });
    const after = new TopologySnapshot({ nodes: [{ id: 'a' }, { id: 'b' }], links: [] });
    const diff = TopologyDiff.compute(before, after);
    assert.equal(diff.removedLinks.length, 1);
  });

  it('detects changed links', () => {
    const before = new TopologySnapshot({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ from: 'a', to: 'b', latency: 10 }],
    });
    const after = new TopologySnapshot({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ from: 'a', to: 'b', latency: 50 }],
    });
    const diff = TopologyDiff.compute(before, after);
    assert.equal(diff.changedLinks.length, 1);
    assert.equal(diff.changedLinks[0].changes.latency.from, 10);
    assert.equal(diff.changedLinks[0].changes.latency.to, 50);
  });

  it('changeCount sums all changes', () => {
    const before = new TopologySnapshot({ nodes: [{ id: 'a' }], links: [] });
    const after = new TopologySnapshot({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ from: 'a', to: 'b' }],
    });
    const diff = TopologyDiff.compute(before, after);
    assert.equal(diff.changeCount, 2); // 1 added node + 1 added link
  });

  describe('toJSON / fromJSON', () => {
    it('round-trips', () => {
      const diff = new TopologyDiff({
        addedNodes: [{ id: 'new' }],
        removedLinks: [{ from: 'a', to: 'b' }],
      });
      const restored = TopologyDiff.fromJSON(diff.toJSON());
      assert.equal(restored.addedNodes.length, 1);
      assert.equal(restored.removedLinks.length, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// VisualizationExporter
// ---------------------------------------------------------------------------

describe('VisualizationExporter', () => {
  let exporter;

  beforeEach(() => {
    exporter = new VisualizationExporter();
  });

  it('exportTrustGraph() adds type and timestamp', () => {
    const layout = new TrustGraphLayout();
    layout.addNode('a');
    layout.addNode('b');
    layout.addEdge('a', 'b');
    const result = exporter.exportTrustGraph(layout);
    assert.equal(result.type, 'trust-graph');
    assert.ok(result.exportedAt > 0);
    assert.equal(result.nodes.length, 2);
  });

  it('exportHeatmap() adds type', () => {
    const heatmap = new TrustHeatmap();
    heatmap.setTrust('a', 'b', 0.9);
    const result = exporter.exportHeatmap(heatmap);
    assert.equal(result.type, 'trust-heatmap');
    assert.deepEqual(result.podIds, ['a', 'b']);
  });

  it('exportTopology() with circular layout', () => {
    const snapshot = new TopologySnapshot({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ from: 'a', to: 'b' }],
    });
    const engine = new TopologyLayout();
    const result = exporter.exportTopology(snapshot, engine, 'circular');
    assert.equal(result.type, 'topology');
    assert.equal(result.layout, 'circular');
    assert.ok(result.nodes[0].x !== undefined);
  });

  it('exportTopology() without layout engine', () => {
    const snapshot = new TopologySnapshot({
      nodes: [{ id: 'a' }],
    });
    const result = exporter.exportTopology(snapshot);
    assert.equal(result.type, 'topology');
    assert.equal(result.nodes.length, 1);
  });

  it('exportTopology() with grid layout', () => {
    const snapshot = new TopologySnapshot({
      nodes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
    });
    const engine = new TopologyLayout();
    const result = exporter.exportTopology(snapshot, engine, 'grid');
    assert.equal(result.layout, 'grid');
  });

  it('exportTopology() with hierarchical layout', () => {
    const snapshot = new TopologySnapshot({
      nodes: [{ id: 'a' }, { id: 'b' }],
      links: [{ from: 'a', to: 'b' }],
    });
    const engine = new TopologyLayout();
    const result = exporter.exportTopology(snapshot, engine, 'hierarchical');
    assert.equal(result.layout, 'hierarchical');
  });

  it('exportDiff() adds type', () => {
    const diff = new TopologyDiff({ addedNodes: [{ id: 'new' }] });
    const result = exporter.exportDiff(diff);
    assert.equal(result.type, 'topology-diff');
    assert.equal(result.addedNodes.length, 1);
  });
});

// ---------------------------------------------------------------------------
// TopologyBroadcaster
// ---------------------------------------------------------------------------

describe('TopologyBroadcaster', () => {
  let sent;
  let sendFn;
  let broadcaster;

  beforeEach(() => {
    sent = [];
    sendFn = (targetId, msg) => sent.push({ targetId, msg });
    broadcaster = new TopologyBroadcaster({ localPodId: 'podA', sendFn });
  });

  it('constructor requires localPodId and sendFn', () => {
    assert.throws(() => new TopologyBroadcaster({ sendFn }), /localPodId/);
    assert.throws(() => new TopologyBroadcaster({ localPodId: 'a' }), /sendFn/);
  });

  it('broadcastSnapshot sends TOPOLOGY_SNAPSHOT to all peers', () => {
    const snapshot = new TopologySnapshot({ nodes: [{ id: 'a' }] });
    broadcaster.broadcastSnapshot(['podB', 'podC'], snapshot);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].msg.type, TOPOLOGY_SNAPSHOT);
    assert.equal(sent[0].targetId, 'podB');
    assert.equal(sent[1].targetId, 'podC');
    assert.equal(sent[0].msg.snapshot.nodes[0].id, 'a');
  });

  it('broadcastDiff sends TOPOLOGY_DIFF to all peers', () => {
    const diff = new TopologyDiff({ addedNodes: [{ id: 'new' }] });
    broadcaster.broadcastDiff(['podB'], diff);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].msg.type, TOPOLOGY_DIFF);
    assert.equal(sent[0].msg.diff.addedNodes[0].id, 'new');
  });

  it('handleMessage TOPOLOGY_SNAPSHOT calls snapshot listeners', () => {
    const received = [];
    broadcaster.onSnapshot((fromId, snapshot) => received.push({ fromId, snapshot }));
    const snapshot = new TopologySnapshot({ nodes: [{ id: 'x' }] });
    broadcaster.handleMessage('podB', { type: TOPOLOGY_SNAPSHOT, snapshot: snapshot.toJSON() });
    assert.equal(received.length, 1);
    assert.equal(received[0].fromId, 'podB');
    assert.equal(received[0].snapshot.nodeCount, 1);
  });

  it('handleMessage TOPOLOGY_DIFF calls diff listeners', () => {
    const received = [];
    broadcaster.onDiff((fromId, diff) => received.push({ fromId, diff }));
    const diff = new TopologyDiff({ removedNodes: [{ id: 'gone' }] });
    broadcaster.handleMessage('podC', { type: TOPOLOGY_DIFF, diff: diff.toJSON() });
    assert.equal(received.length, 1);
    assert.equal(received[0].fromId, 'podC');
    assert.equal(received[0].diff.removedNodes.length, 1);
  });

  it('handleMessage unknown type is ignored', () => {
    const received = [];
    broadcaster.onSnapshot(() => received.push('snap'));
    broadcaster.onDiff(() => received.push('diff'));
    broadcaster.handleMessage('podB', { type: 0xFF });
    assert.equal(received.length, 0);
  });

  it('handleMessage TOPOLOGY_SNAPSHOT with missing snapshot field is ignored', () => {
    const received = [];
    broadcaster.onSnapshot(() => received.push('snap'));
    broadcaster.handleMessage('podB', { type: TOPOLOGY_SNAPSHOT });
    assert.equal(received.length, 0);
  });

  it('handleMessage TOPOLOGY_DIFF with missing diff field is ignored', () => {
    const received = [];
    broadcaster.onDiff(() => received.push('diff'));
    broadcaster.handleMessage('podB', { type: TOPOLOGY_DIFF });
    assert.equal(received.length, 0);
  });

  it('listeners receive proper class instances', () => {
    let snapInstance = null;
    let diffInstance = null;
    broadcaster.onSnapshot((_, s) => { snapInstance = s; });
    broadcaster.onDiff((_, d) => { diffInstance = d; });

    const snapshot = new TopologySnapshot({ nodes: [{ id: 'n1' }], links: [{ from: 'n1', to: 'n1' }] });
    broadcaster.handleMessage('podB', { type: TOPOLOGY_SNAPSHOT, snapshot: snapshot.toJSON() });
    assert.ok(snapInstance instanceof TopologySnapshot);
    assert.equal(snapInstance.nodeCount, 1);

    const diff = new TopologyDiff({ addedNodes: [{ id: 'x' }] });
    broadcaster.handleMessage('podB', { type: TOPOLOGY_DIFF, diff: diff.toJSON() });
    assert.ok(diffInstance instanceof TopologyDiff);
    assert.equal(diffInstance.addedNodes.length, 1);
  });
});
