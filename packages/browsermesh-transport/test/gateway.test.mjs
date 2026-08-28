// Run with: node --import ./test/_setup-globals.mjs --test test/gateway.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  GatewayRoute,
  RouteTable,
  GatewayNode,
  GatewayDiscovery,
  GATEWAY_ANNOUNCE,
  GATEWAY_ROUTE,
  GATEWAY_RELAY,
  GATEWAY_WITHDRAW,
} from '../src/gateway.mjs';

// ── Wire Constants ──────────────────────────────────────────────

describe('Wire constants', () => {
  it('GATEWAY_ANNOUNCE is 0xA0', () => {
    assert.equal(GATEWAY_ANNOUNCE, 0xA0);
  });

  it('GATEWAY_ROUTE is 0xA1', () => {
    assert.equal(GATEWAY_ROUTE, 0xA1);
  });

  it('GATEWAY_RELAY is 0xA2', () => {
    assert.equal(GATEWAY_RELAY, 0xA2);
  });

  it('GATEWAY_WITHDRAW is 0xA3', () => {
    assert.equal(GATEWAY_WITHDRAW, 0xA3);
  });
});

// ── GatewayRoute ────────────────────────────────────────────────

describe('GatewayRoute', () => {
  it('constructor sets all fields', () => {
    const r = new GatewayRoute({
      fromPodId: 'pod-a',
      toPodId: 'pod-b',
      viaGateway: 'gw-1',
      hopCount: 2,
      latencyMs: 15,
    });
    assert.equal(r.fromPodId, 'pod-a');
    assert.equal(r.toPodId, 'pod-b');
    assert.equal(r.viaGateway, 'gw-1');
    assert.equal(r.hopCount, 2);
    assert.equal(r.latencyMs, 15);
    assert.equal(typeof r.createdAt, 'number');
    assert.equal(r.ttl, 60_000);
  });

  it('constructor defaults latencyMs to null', () => {
    const r = new GatewayRoute({
      fromPodId: 'a',
      toPodId: 'b',
      viaGateway: 'gw',
      hopCount: 1,
    });
    assert.equal(r.latencyMs, null);
  });

  it('constructor throws without fromPodId', () => {
    assert.throws(
      () => new GatewayRoute({ toPodId: 'b', viaGateway: 'gw', hopCount: 1 }),
      /fromPodId is required/,
    );
  });

  it('constructor throws without toPodId', () => {
    assert.throws(
      () => new GatewayRoute({ fromPodId: 'a', viaGateway: 'gw', hopCount: 1 }),
      /toPodId is required/,
    );
  });

  it('constructor throws without viaGateway', () => {
    assert.throws(
      () => new GatewayRoute({ fromPodId: 'a', toPodId: 'b', hopCount: 1 }),
      /viaGateway is required/,
    );
  });

  it('constructor throws for negative hopCount', () => {
    assert.throws(
      () => new GatewayRoute({ fromPodId: 'a', toPodId: 'b', viaGateway: 'gw', hopCount: -1 }),
      /hopCount must be a non-negative number/,
    );
  });

  it('isExpired returns false when route is fresh', () => {
    const r = new GatewayRoute({
      fromPodId: 'a',
      toPodId: 'b',
      viaGateway: 'gw',
      hopCount: 1,
      ttl: 60_000,
    });
    assert.equal(r.isExpired(), false);
  });

  it('isExpired returns true after TTL elapsed', () => {
    const r = new GatewayRoute({
      fromPodId: 'a',
      toPodId: 'b',
      viaGateway: 'gw',
      hopCount: 1,
      createdAt: 1000,
      ttl: 500,
    });
    assert.equal(r.isExpired(1500), true);
    assert.equal(r.isExpired(1499), false);
  });

  it('toJSON returns a plain object', () => {
    const r = new GatewayRoute({
      fromPodId: 'a',
      toPodId: 'b',
      viaGateway: 'gw',
      hopCount: 3,
      latencyMs: 10,
      createdAt: 5000,
      ttl: 30_000,
    });
    const json = r.toJSON();
    assert.deepEqual(json, {
      fromPodId: 'a',
      toPodId: 'b',
      viaGateway: 'gw',
      hopCount: 3,
      latencyMs: 10,
      createdAt: 5000,
      ttl: 30_000,
    });
  });

  it('fromJSON round-trips correctly', () => {
    const original = new GatewayRoute({
      fromPodId: 'x',
      toPodId: 'y',
      viaGateway: 'gw-z',
      hopCount: 4,
      latencyMs: 22,
      createdAt: 9000,
      ttl: 45_000,
    });
    const restored = GatewayRoute.fromJSON(original.toJSON());
    assert.deepEqual(restored.toJSON(), original.toJSON());
  });
});

// ── RouteTable ──────────────────────────────────────────────────

describe('RouteTable', () => {
  /** @type {RouteTable} */
  let table;

  beforeEach(() => {
    table = new RouteTable();
  });

  it('starts empty', () => {
    assert.equal(table.size, 0);
    assert.deepEqual(table.listAll(), []);
  });

  it('addRoute stores a route', () => {
    const r = new GatewayRoute({ fromPodId: 'a', toPodId: 'b', viaGateway: 'gw', hopCount: 1 });
    table.addRoute(r);
    assert.equal(table.size, 1);
  });

  it('addRoute replaces existing route with same key', () => {
    const r1 = new GatewayRoute({ fromPodId: 'a', toPodId: 'b', viaGateway: 'gw', hopCount: 3 });
    const r2 = new GatewayRoute({ fromPodId: 'a', toPodId: 'b', viaGateway: 'gw', hopCount: 1 });
    table.addRoute(r1);
    table.addRoute(r2);
    assert.equal(table.size, 1);
    assert.equal(table.findRoute('a', 'b').hopCount, 1);
  });

  it('removeRoute returns true for existing route', () => {
    const r = new GatewayRoute({ fromPodId: 'a', toPodId: 'b', viaGateway: 'gw', hopCount: 1 });
    table.addRoute(r);
    assert.equal(table.removeRoute('a', 'b'), true);
    assert.equal(table.size, 0);
  });

  it('removeRoute returns false for nonexistent route', () => {
    assert.equal(table.removeRoute('x', 'y'), false);
  });

  it('findRoute returns route when present', () => {
    const r = new GatewayRoute({ fromPodId: 'a', toPodId: 'b', viaGateway: 'gw', hopCount: 2 });
    table.addRoute(r);
    const found = table.findRoute('a', 'b');
    assert.equal(found.fromPodId, 'a');
    assert.equal(found.toPodId, 'b');
    assert.equal(found.hopCount, 2);
  });

  it('findRoute returns null when not present', () => {
    assert.equal(table.findRoute('a', 'b'), null);
  });

  it('findRoutes returns all routes to a destination sorted by hopCount', () => {
    table.addRoute(new GatewayRoute({ fromPodId: 'c', toPodId: 'dest', viaGateway: 'gw', hopCount: 5 }));
    table.addRoute(new GatewayRoute({ fromPodId: 'a', toPodId: 'dest', viaGateway: 'gw', hopCount: 1 }));
    table.addRoute(new GatewayRoute({ fromPodId: 'b', toPodId: 'dest', viaGateway: 'gw', hopCount: 3 }));
    table.addRoute(new GatewayRoute({ fromPodId: 'x', toPodId: 'other', viaGateway: 'gw', hopCount: 1 }));

    const routes = table.findRoutes('dest');
    assert.equal(routes.length, 3);
    assert.equal(routes[0].hopCount, 1);
    assert.equal(routes[1].hopCount, 3);
    assert.equal(routes[2].hopCount, 5);
  });

  it('findRoutes returns empty for unknown destination', () => {
    assert.deepEqual(table.findRoutes('nowhere'), []);
  });

  it('pruneExpired removes expired routes', () => {
    table.addRoute(new GatewayRoute({
      fromPodId: 'a', toPodId: 'b', viaGateway: 'gw', hopCount: 1,
      createdAt: 1000, ttl: 100,
    }));
    table.addRoute(new GatewayRoute({
      fromPodId: 'c', toPodId: 'd', viaGateway: 'gw', hopCount: 1,
      createdAt: Date.now(), ttl: 60_000,
    }));
    assert.equal(table.size, 2);

    const pruned = table.pruneExpired();
    assert.equal(pruned, 1);
    assert.equal(table.size, 1);
    assert.equal(table.findRoute('a', 'b'), null);
    assert.notEqual(table.findRoute('c', 'd'), null);
  });

  it('pruneExpired returns 0 when no routes expired', () => {
    table.addRoute(new GatewayRoute({
      fromPodId: 'a', toPodId: 'b', viaGateway: 'gw', hopCount: 1,
    }));
    assert.equal(table.pruneExpired(), 0);
  });

  it('evicts oldest route when maxRoutes exceeded', () => {
    const small = new RouteTable({ maxRoutes: 2 });
    small.addRoute(new GatewayRoute({ fromPodId: 'a', toPodId: 'b', viaGateway: 'gw', hopCount: 1 }));
    small.addRoute(new GatewayRoute({ fromPodId: 'c', toPodId: 'd', viaGateway: 'gw', hopCount: 1 }));
    small.addRoute(new GatewayRoute({ fromPodId: 'e', toPodId: 'f', viaGateway: 'gw', hopCount: 1 }));
    assert.equal(small.size, 2);
    // The first route (a->b) should have been evicted
    assert.equal(small.findRoute('a', 'b'), null);
    assert.notEqual(small.findRoute('c', 'd'), null);
    assert.notEqual(small.findRoute('e', 'f'), null);
  });

  it('toJSON / fromJSON round-trip', () => {
    table.addRoute(new GatewayRoute({ fromPodId: 'a', toPodId: 'b', viaGateway: 'gw', hopCount: 2, createdAt: 1000, ttl: 5000 }));
    table.addRoute(new GatewayRoute({ fromPodId: 'c', toPodId: 'd', viaGateway: 'gw', hopCount: 4, createdAt: 2000, ttl: 8000 }));

    const json = table.toJSON();
    const restored = RouteTable.fromJSON(json);
    assert.equal(restored.size, 2);
    assert.deepEqual(restored.toJSON(), json);
  });
});

// ── GatewayNode ─────────────────────────────────────────────────

describe('GatewayNode', () => {
  /** @type {GatewayNode} */
  let gw;

  beforeEach(() => {
    gw = new GatewayNode('gw-local');
  });

  it('constructor sets localPodId', () => {
    assert.equal(gw.localPodId, 'gw-local');
  });

  it('constructor throws without localPodId', () => {
    assert.throws(() => new GatewayNode(''), /localPodId is required/);
  });

  it('defaults to relay enabled', () => {
    assert.equal(gw.isRelayEnabled, true);
  });

  it('allowRelay=false disables relay', () => {
    const node = new GatewayNode('gw', { allowRelay: false });
    assert.equal(node.isRelayEnabled, false);
  });

  it('starts with no peers and no routes', () => {
    assert.equal(gw.connectedPeers.size, 0);
    assert.equal(gw.routeTable.size, 0);
  });

  // -- Peer management --

  it('registerPeer adds a peer', () => {
    gw.registerPeer('pod-a');
    assert.equal(gw.connectedPeers.size, 1);
    assert.ok(gw.connectedPeers.has('pod-a'));
  });

  it('registerPeer throws for empty podId', () => {
    assert.throws(() => gw.registerPeer(''), /podId is required/);
  });

  it('registerPeer is idempotent', () => {
    gw.registerPeer('pod-a');
    gw.registerPeer('pod-a');
    assert.equal(gw.connectedPeers.size, 1);
  });

  it('registerPeer throws when maxConnections reached', () => {
    const node = new GatewayNode('gw', { maxConnections: 2 });
    node.registerPeer('a');
    node.registerPeer('b');
    assert.throws(() => node.registerPeer('c'), /Maximum connections reached/);
  });

  it('unregisterPeer removes a peer', () => {
    gw.registerPeer('pod-a');
    assert.equal(gw.unregisterPeer('pod-a'), true);
    assert.equal(gw.connectedPeers.size, 0);
  });

  it('unregisterPeer returns false for unknown peer', () => {
    assert.equal(gw.unregisterPeer('unknown'), false);
  });

  // -- Routing --

  it('canRoute returns true for directly connected peers', () => {
    gw.registerPeer('pod-a');
    gw.registerPeer('pod-b');
    assert.equal(gw.canRoute('pod-a', 'pod-b'), true);
  });

  it('canRoute returns false when peers not connected', () => {
    gw.registerPeer('pod-a');
    assert.equal(gw.canRoute('pod-a', 'pod-c'), false);
  });

  it('canRoute returns true for explicit route in table', () => {
    gw.advertiseRoute('pod-a', 'pod-b', 2);
    assert.equal(gw.canRoute('pod-a', 'pod-b'), true);
  });

  it('findBestRoute returns explicit route from table', () => {
    gw.advertiseRoute('pod-a', 'pod-b', 3);
    const route = gw.findBestRoute('pod-a', 'pod-b');
    assert.notEqual(route, null);
    assert.equal(route.hopCount, 3);
    assert.equal(route.viaGateway, 'gw-local');
  });

  it('findBestRoute synthesizes 1-hop route for direct peers', () => {
    gw.registerPeer('pod-a');
    gw.registerPeer('pod-b');
    const route = gw.findBestRoute('pod-a', 'pod-b');
    assert.notEqual(route, null);
    assert.equal(route.hopCount, 1);
    assert.equal(route.viaGateway, 'gw-local');
  });

  it('findBestRoute returns null when no route exists', () => {
    assert.equal(gw.findBestRoute('pod-a', 'pod-z'), null);
  });

  // -- advertiseRoute --

  it('advertiseRoute adds route to table', () => {
    const route = gw.advertiseRoute('pod-a', 'pod-b', 2);
    assert.equal(route.fromPodId, 'pod-a');
    assert.equal(route.toPodId, 'pod-b');
    assert.equal(route.viaGateway, 'gw-local');
    assert.equal(route.hopCount, 2);
    assert.equal(gw.routeTable.size, 1);
  });

  it('advertiseRoute throws when hopCount exceeds maxHops', () => {
    const node = new GatewayNode('gw', { maxHops: 3 });
    assert.throws(
      () => node.advertiseRoute('a', 'b', 5),
      /hopCount 5 exceeds maxHops 3/,
    );
  });

  // -- relay --

  it('relay succeeds when route exists', () => {
    gw.registerPeer('pod-a');
    gw.registerPeer('pod-b');
    const result = gw.relay('pod-a', 'pod-b', { msg: 'hello' });
    assert.equal(result.relayed, true);
    assert.notEqual(result.route, undefined);
  });

  it('relay fails when relay is disabled', () => {
    const node = new GatewayNode('gw', { allowRelay: false });
    node.registerPeer('pod-a');
    node.registerPeer('pod-b');
    const result = node.relay('pod-a', 'pod-b', { msg: 'hello' });
    assert.equal(result.relayed, false);
    assert.ok(result.error.includes('disabled'));
  });

  it('relay fails when no route exists', () => {
    const result = gw.relay('pod-a', 'pod-z', { msg: 'hello' });
    assert.equal(result.relayed, false);
    assert.ok(result.error.includes('No route'));
  });

  it('relay increments relayCount', () => {
    gw.registerPeer('pod-a');
    gw.registerPeer('pod-b');
    assert.equal(gw.stats.relayCount, 0);
    gw.relay('pod-a', 'pod-b', {});
    assert.equal(gw.stats.relayCount, 1);
    gw.relay('pod-a', 'pod-b', {});
    assert.equal(gw.stats.relayCount, 2);
  });

  // -- stats --

  it('stats returns correct counts', () => {
    gw.registerPeer('pod-a');
    gw.registerPeer('pod-b');
    gw.advertiseRoute('pod-a', 'pod-b', 1);
    gw.relay('pod-a', 'pod-b', {});

    const s = gw.stats;
    assert.equal(s.peerCount, 2);
    assert.equal(s.routeCount, 1);
    assert.equal(s.relayCount, 1);
  });

  // -- toJSON / fromJSON --

  it('toJSON returns serializable snapshot', () => {
    gw.registerPeer('pod-a');
    gw.advertiseRoute('pod-a', 'pod-b', 2);
    const json = gw.toJSON();
    assert.equal(json.localPodId, 'gw-local');
    assert.deepEqual(json.peers, ['pod-a']);
    assert.equal(json.routeTable.routes.length, 1);
  });

  it('fromJSON round-trips correctly', () => {
    gw.registerPeer('pod-a');
    gw.registerPeer('pod-b');
    gw.advertiseRoute('pod-a', 'pod-b', 3);
    gw.relay('pod-a', 'pod-b', {});

    const json = gw.toJSON();
    const restored = GatewayNode.fromJSON(json);
    assert.equal(restored.localPodId, 'gw-local');
    assert.equal(restored.connectedPeers.size, 2);
    assert.equal(restored.routeTable.size, 1);
    assert.equal(restored.stats.relayCount, 1);
  });
});

// ── GatewayDiscovery ────────────────────────────────────────────

describe('GatewayDiscovery', () => {
  /** @type {GatewayDiscovery} */
  let disc;

  beforeEach(() => {
    disc = new GatewayDiscovery('local-pod');
  });

  it('constructor sets localPodId', () => {
    assert.ok(disc);
  });

  it('constructor throws without localPodId', () => {
    assert.throws(() => new GatewayDiscovery(''), /localPodId is required/);
  });

  it('starts empty', () => {
    assert.equal(disc.size, 0);
    assert.deepEqual(disc.listGateways(), []);
  });

  it('addGateway registers a gateway', () => {
    disc.addGateway('gw-1', ['relay']);
    assert.equal(disc.size, 1);
  });

  it('addGateway throws for empty podId', () => {
    assert.throws(() => disc.addGateway(''), /podId is required/);
  });

  it('addGateway replaces existing gateway with same podId', () => {
    disc.addGateway('gw-1', ['relay']);
    disc.addGateway('gw-1', ['relay', 'store']);
    assert.equal(disc.size, 1);
    const gateways = disc.listGateways();
    assert.deepEqual(gateways[0].capabilities, ['relay', 'store']);
  });

  it('removeGateway returns true for existing', () => {
    disc.addGateway('gw-1');
    assert.equal(disc.removeGateway('gw-1'), true);
    assert.equal(disc.size, 0);
  });

  it('removeGateway returns false for nonexistent', () => {
    assert.equal(disc.removeGateway('gw-x'), false);
  });

  it('listGateways returns all gateways with metadata', () => {
    disc.addGateway('gw-1', ['relay']);
    disc.addGateway('gw-2', ['relay', 'store']);
    const list = disc.listGateways();
    assert.equal(list.length, 2);
    assert.equal(list[0].podId, 'gw-1');
    assert.deepEqual(list[0].capabilities, ['relay']);
    assert.equal(typeof list[0].addedAt, 'number');
    assert.equal(list[1].podId, 'gw-2');
  });

  it('selectGateway picks first suitable gateway', () => {
    disc.addGateway('gw-1', ['relay']);
    disc.addGateway('gw-2', ['relay', 'store']);
    const selected = disc.selectGateway('pod-dest');
    assert.equal(selected, 'gw-1');
  });

  it('selectGateway skips local pod', () => {
    disc.addGateway('local-pod', ['relay']);
    disc.addGateway('gw-2', ['relay']);
    const selected = disc.selectGateway('pod-dest');
    assert.equal(selected, 'gw-2');
  });

  it('selectGateway skips destination pod', () => {
    disc.addGateway('pod-dest', ['relay']);
    disc.addGateway('gw-2', ['relay']);
    const selected = disc.selectGateway('pod-dest');
    assert.equal(selected, 'gw-2');
  });

  it('selectGateway filters by requiredCapability', () => {
    disc.addGateway('gw-1', ['relay']);
    disc.addGateway('gw-2', ['relay', 'store']);
    const selected = disc.selectGateway('pod-dest', { requiredCapability: 'store' });
    assert.equal(selected, 'gw-2');
  });

  it('selectGateway returns null when no gateway matches', () => {
    disc.addGateway('local-pod', ['relay']);
    const selected = disc.selectGateway('pod-dest');
    assert.equal(selected, null);
  });

  it('selectGateway returns null when empty', () => {
    assert.equal(disc.selectGateway('pod-dest'), null);
  });
});
