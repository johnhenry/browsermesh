// Run with: node --import ./test/_setup-globals.mjs --test test/peer-routing.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROUTING_DEFAULTS,
  MeshRouter,
  ServerSharing,
} from '../src/peer-routing.mjs';

// ── ROUTING_DEFAULTS ───────────────────────────────────────────────

describe('ROUTING_DEFAULTS', () => {
  it('has correct maxTTL', () => {
    assert.equal(ROUTING_DEFAULTS.maxTTL, 8);
  });

  it('has correct routeCacheMs (1 minute)', () => {
    assert.equal(ROUTING_DEFAULTS.routeCacheMs, 60_000);
  });

  it('has correct maxRouteEntries', () => {
    assert.equal(ROUTING_DEFAULTS.maxRouteEntries, 1000);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(ROUTING_DEFAULTS));
  });
});

// ── MeshRouter ─────────────────────────────────────────────────────

describe('MeshRouter', () => {
  /** @type {MeshRouter} */
  let router;
  /** @type {Array<{nextHop: string, envelope: object}>} */
  let forwards;

  beforeEach(() => {
    forwards = [];
    router = new MeshRouter({
      localPodId: 'pod-local',
      forwardFn: (nextHop, envelope) => forwards.push({ nextHop, envelope }),
    });
  });

  it('constructor throws without localPodId', () => {
    assert.throws(
      () => new MeshRouter({ localPodId: '' }),
      /localPodId is required/,
    );
  });

  it('starts with no direct peers and no routes', () => {
    assert.deepEqual(router.listDirectPeers(), []);
    assert.deepEqual(router.listRoutes(), []);
  });

  // -- Direct peer management --

  it('addDirectPeer registers a peer', () => {
    router.addDirectPeer('pod-a');
    assert.deepEqual(router.listDirectPeers(), ['pod-a']);
  });

  it('removeDirectPeer removes a peer', () => {
    router.addDirectPeer('pod-a');
    router.removeDirectPeer('pod-a');
    assert.deepEqual(router.listDirectPeers(), []);
  });

  it('addDirectPeer is idempotent', () => {
    router.addDirectPeer('pod-a');
    router.addDirectPeer('pod-a');
    assert.equal(router.listDirectPeers().length, 1);
  });

  // -- route to direct peer --

  it('route succeeds for direct peer', () => {
    router.addDirectPeer('pod-a');
    const result = router.route('pod-a', { hello: 'world' });
    assert.equal(result.success, true);
    assert.equal(result.hops, 1);
    assert.deepEqual(result.path, ['pod-local', 'pod-a']);
  });

  it('route calls forwardFn for direct peer', () => {
    router.addDirectPeer('pod-a');
    router.route('pod-a', { data: 42 });
    assert.equal(forwards.length, 1);
    assert.equal(forwards[0].nextHop, 'pod-a');
    assert.equal(forwards[0].envelope.to, 'pod-a');
    assert.equal(forwards[0].envelope.from, 'pod-local');
    assert.deepEqual(forwards[0].envelope.message, { data: 42 });
  });

  // -- route via known route (forwarding) --

  it('route succeeds via known route', () => {
    router.addRoute('pod-c', 'pod-b', 3);
    const result = router.route('pod-c', { msg: 'hello' });
    assert.equal(result.success, true);
    assert.equal(result.hops, 3);
    assert.deepEqual(result.path, ['pod-local', 'pod-b']);
  });

  it('route forwards to nextHop for known route', () => {
    router.addRoute('pod-c', 'pod-b', 2);
    router.route('pod-c', { msg: 'hello' });
    assert.equal(forwards.length, 1);
    assert.equal(forwards[0].nextHop, 'pod-b');
  });

  it('route emits forward event for non-direct routes', () => {
    const events = [];
    router.on('forward', (env) => events.push(env));
    router.addRoute('pod-c', 'pod-b', 2);
    router.route('pod-c', { msg: 'hello' });
    assert.equal(events.length, 1);
  });

  // -- route fails for unknown target --

  it('route fails for unknown target', () => {
    const result = router.route('pod-unknown', { msg: 'hello' });
    assert.equal(result.success, false);
    assert.equal(result.hops, undefined);
  });

  // -- route table management --

  it('addRoute stores a route entry', () => {
    router.addRoute('pod-x', 'pod-y', 2);
    const entry = router.getRoute('pod-x');
    assert.notEqual(entry, null);
    assert.equal(entry.target, 'pod-x');
    assert.equal(entry.nextHop, 'pod-y');
    assert.equal(entry.hops, 2);
    assert.equal(typeof entry.addedAt, 'number');
    assert.equal(typeof entry.expiresAt, 'number');
  });

  it('addRoute emits route:add event', () => {
    const events = [];
    router.on('route:add', (entry) => events.push(entry));
    router.addRoute('pod-x', 'pod-y', 2);
    assert.equal(events.length, 1);
    assert.equal(events[0].target, 'pod-x');
  });

  it('addRoute replaces existing route for same target', () => {
    router.addRoute('pod-x', 'pod-y', 3);
    router.addRoute('pod-x', 'pod-z', 1);
    assert.equal(router.listRoutes().length, 1);
    assert.equal(router.getRoute('pod-x').nextHop, 'pod-z');
    assert.equal(router.getRoute('pod-x').hops, 1);
  });

  it('removeRoute removes a route', () => {
    router.addRoute('pod-x', 'pod-y', 2);
    const result = router.removeRoute('pod-x');
    assert.equal(result, true);
    assert.equal(router.getRoute('pod-x'), null);
  });

  it('removeRoute returns false for unknown route', () => {
    assert.equal(router.removeRoute('pod-nonexistent'), false);
  });

  it('removeRoute emits route:remove event', () => {
    const events = [];
    router.on('route:remove', (target) => events.push(target));
    router.addRoute('pod-x', 'pod-y', 2);
    router.removeRoute('pod-x');
    assert.equal(events.length, 1);
    assert.equal(events[0], 'pod-x');
  });

  it('getRoute returns null for unknown target', () => {
    assert.equal(router.getRoute('pod-nonexistent'), null);
  });

  it('listRoutes returns all routes', () => {
    router.addRoute('pod-a', 'pod-x', 1);
    router.addRoute('pod-b', 'pod-y', 2);
    router.addRoute('pod-c', 'pod-z', 3);
    assert.equal(router.listRoutes().length, 3);
  });

  // -- pruneExpired --

  it('pruneExpired removes expired routes', () => {
    // Manually craft an expired route by adding with short TTL
    router.addRoute('pod-old', 'pod-x', 1, 1); // 1ms TTL
    router.addRoute('pod-new', 'pod-y', 1);     // default 60s TTL

    // The 1ms TTL route should expire very quickly
    const pruned = router.pruneExpired(Date.now() + 100);
    assert.equal(pruned, 1);
    assert.equal(router.getRoute('pod-old'), null);
    assert.notEqual(router.getRoute('pod-new'), null);
  });

  it('pruneExpired returns 0 when nothing expired', () => {
    router.addRoute('pod-a', 'pod-x', 1);
    assert.equal(router.pruneExpired(), 0);
  });

  it('pruneExpired emits route:remove for each pruned route', () => {
    const events = [];
    router.on('route:remove', (target) => events.push(target));
    router.addRoute('pod-old', 'pod-x', 1, 1);
    router.pruneExpired(Date.now() + 100);
    assert.equal(events.length, 1);
    assert.equal(events[0], 'pod-old');
  });

  // -- handleRoutedMessage --

  it('handleRoutedMessage delivers message to local pod', () => {
    const events = [];
    router.on('message', (env) => events.push(env));
    router.handleRoutedMessage({
      from: 'pod-a',
      to: 'pod-local',
      ttl: 5,
      message: { text: 'hello' },
      path: ['pod-a'],
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].from, 'pod-a');
    assert.deepEqual(events[0].message, { text: 'hello' });
  });

  it('handleRoutedMessage forwards message to direct peer', () => {
    router.addDirectPeer('pod-b');
    router.handleRoutedMessage({
      from: 'pod-a',
      to: 'pod-b',
      ttl: 5,
      message: { text: 'hello' },
      path: ['pod-a'],
    });
    assert.equal(forwards.length, 1);
    assert.equal(forwards[0].nextHop, 'pod-b');
    assert.equal(forwards[0].envelope.ttl, 4);
    assert.ok(forwards[0].envelope.path.includes('pod-local'));
  });

  it('handleRoutedMessage forwards via known route', () => {
    router.addRoute('pod-c', 'pod-b', 2);
    const forwardEvents = [];
    router.on('forward', (env) => forwardEvents.push(env));

    router.handleRoutedMessage({
      from: 'pod-a',
      to: 'pod-c',
      ttl: 5,
      message: { text: 'hello' },
      path: ['pod-a'],
    });

    assert.equal(forwards.length, 1);
    assert.equal(forwards[0].nextHop, 'pod-b');
    assert.equal(forwardEvents.length, 1);
  });

  it('handleRoutedMessage drops message when TTL reaches 0', () => {
    router.addDirectPeer('pod-b');
    router.handleRoutedMessage({
      from: 'pod-a',
      to: 'pod-b',
      ttl: 1,
      message: { text: 'hello' },
      path: ['pod-a'],
    });
    // TTL was 1, after decrement it becomes 0 -> dropped
    assert.equal(forwards.length, 0);
  });

  it('handleRoutedMessage drops message when TTL is 0', () => {
    router.addDirectPeer('pod-b');
    router.handleRoutedMessage({
      from: 'pod-a',
      to: 'pod-b',
      ttl: 0,
      message: { text: 'hello' },
      path: ['pod-a'],
    });
    assert.equal(forwards.length, 0);
  });

  it('handleRoutedMessage ignores null/invalid input', () => {
    router.handleRoutedMessage(null);
    router.handleRoutedMessage('not an object');
    assert.equal(forwards.length, 0);
  });

  // -- events off --

  it('off removes a listener', () => {
    const events = [];
    const handler = (entry) => events.push(entry);
    router.on('route:add', handler);
    router.addRoute('pod-a', 'pod-x', 1);
    assert.equal(events.length, 1);

    router.off('route:add', handler);
    router.addRoute('pod-b', 'pod-y', 1);
    assert.equal(events.length, 1);
  });

  // -- toJSON --

  it('toJSON returns serializable snapshot', () => {
    router.addDirectPeer('pod-a');
    router.addRoute('pod-b', 'pod-c', 2);
    const json = router.toJSON();
    assert.equal(json.localPodId, 'pod-local');
    assert.equal(json.maxTTL, 8);
    assert.equal(json.routeCacheMs, 60_000);
    assert.deepEqual(json.directPeers, ['pod-a']);
    assert.equal(json.routes.length, 1);
    assert.equal(json.routes[0].target, 'pod-b');
  });

  // -- no forwardFn --

  it('works without forwardFn (no throws)', () => {
    const plain = new MeshRouter({ localPodId: 'pod-x' });
    plain.addDirectPeer('pod-a');
    const result = plain.route('pod-a', { msg: 'hello' });
    assert.equal(result.success, true);
  });

  // -- custom maxTTL --

  it('respects custom maxTTL in route envelope', () => {
    const customRouter = new MeshRouter({
      localPodId: 'pod-local',
      maxTTL: 3,
      forwardFn: (nextHop, envelope) => forwards.push({ nextHop, envelope }),
    });
    customRouter.addDirectPeer('pod-a');
    customRouter.route('pod-a', { msg: 'hello' });
    assert.equal(forwards[forwards.length - 1].envelope.ttl, 3);
  });
});

// ── ServerSharing ──────────────────────────────────────────────────

describe('ServerSharing', () => {
  /** @type {ServerSharing} */
  let sharing;

  beforeEach(() => {
    sharing = new ServerSharing({
      localPodId: 'pod-local',
      fetchFn: null,
    });
  });

  it('constructor throws without localPodId', () => {
    assert.throws(
      () => new ServerSharing({ localPodId: '' }),
      /localPodId is required/,
    );
  });

  it('starts with no exposed servers', () => {
    assert.deepEqual(sharing.listExposed(), []);
  });

  // -- expose --

  it('expose creates a server config', () => {
    const config = sharing.expose(3000, 'api');
    assert.equal(config.name, 'api');
    assert.equal(config.port, 3000);
    assert.equal(config.hostname, 'localhost');
    assert.equal(config.protocol, 'http');
    assert.equal(config.address, 'mesh://pod-local/http/api');
    assert.equal(typeof config.exposedAt, 'number');
  });

  it('expose accepts custom hostname and protocol', () => {
    const config = sharing.expose(8443, 'secure', {
      hostname: '0.0.0.0',
      protocol: 'https',
    });
    assert.equal(config.hostname, '0.0.0.0');
    assert.equal(config.protocol, 'https');
  });

  it('expose throws for invalid port', () => {
    assert.throws(
      () => sharing.expose(0, 'bad'),
      /port must be a positive number/,
    );
    assert.throws(
      () => sharing.expose(-1, 'bad'),
      /port must be a positive number/,
    );
  });

  it('expose throws without name', () => {
    assert.throws(
      () => sharing.expose(3000, ''),
      /name is required/,
    );
  });

  it('expose overwrites existing server with same name', () => {
    sharing.expose(3000, 'api');
    sharing.expose(4000, 'api');
    assert.equal(sharing.listExposed().length, 1);
    assert.equal(sharing.getExposed('api').port, 4000);
  });

  // -- unexpose --

  it('unexpose removes an exposed server', () => {
    sharing.expose(3000, 'api');
    const result = sharing.unexpose('api');
    assert.equal(result, true);
    assert.deepEqual(sharing.listExposed(), []);
  });

  it('unexpose returns false for unknown server', () => {
    assert.equal(sharing.unexpose('nonexistent'), false);
  });

  // -- listExposed / getExposed --

  it('listExposed returns all exposed servers', () => {
    sharing.expose(3000, 'api');
    sharing.expose(8080, 'web');
    assert.equal(sharing.listExposed().length, 2);
  });

  it('getExposed returns config for known server', () => {
    sharing.expose(3000, 'api');
    const config = sharing.getExposed('api');
    assert.equal(config.port, 3000);
    assert.equal(config.name, 'api');
  });

  it('getExposed returns null for unknown server', () => {
    assert.equal(sharing.getExposed('nope'), null);
  });

  // -- handleRequest --

  it('handleRequest returns 404 for unknown server', async () => {
    const result = await sharing.handleRequest({
      name: 'unknown',
      method: 'GET',
      path: '/',
    });
    assert.equal(result.status, 404);
  });

  it('handleRequest returns 400 for invalid request', async () => {
    const result = await sharing.handleRequest(null);
    assert.equal(result.status, 400);
  });

  it('handleRequest returns 503 when fetchFn is null', async () => {
    sharing.expose(3000, 'api');
    const result = await sharing.handleRequest({
      name: 'api',
      method: 'GET',
      path: '/data',
    });
    assert.equal(result.status, 503);
  });

  it('handleRequest proxies to the local server', async () => {
    const proxySharing = new ServerSharing({
      localPodId: 'pod-local',
      fetchFn: async (url, init) => ({
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: async () => '{"ok":true}',
      }),
    });
    proxySharing.expose(3000, 'api');

    const result = await proxySharing.handleRequest({
      name: 'api',
      method: 'GET',
      path: '/data',
    });
    assert.equal(result.status, 200);
    assert.equal(result.body, '{"ok":true}');
  });

  it('handleRequest constructs correct proxy URL', async () => {
    let capturedUrl = null;
    const proxySharing = new ServerSharing({
      localPodId: 'pod-local',
      fetchFn: async (url) => {
        capturedUrl = url;
        return { status: 200, headers: new Map(), text: async () => 'ok' };
      },
    });
    proxySharing.expose(8080, 'web', { hostname: '127.0.0.1', protocol: 'https' });

    await proxySharing.handleRequest({
      name: 'web',
      method: 'POST',
      path: '/api/submit',
      body: 'data',
    });
    assert.equal(capturedUrl, 'https://127.0.0.1:8080/api/submit');
  });

  it('handleRequest returns 502 on fetch error', async () => {
    const proxySharing = new ServerSharing({
      localPodId: 'pod-local',
      fetchFn: async () => { throw new Error('Connection refused') },
    });
    proxySharing.expose(3000, 'api');

    const result = await proxySharing.handleRequest({
      name: 'api',
      method: 'GET',
      path: '/',
    });
    assert.equal(result.status, 502);
    assert.ok(result.body.includes('Connection refused'));
  });

  it('handleRequest defaults path to /', async () => {
    let capturedUrl = null;
    const proxySharing = new ServerSharing({
      localPodId: 'pod-local',
      fetchFn: async (url) => {
        capturedUrl = url;
        return { status: 200, headers: new Map(), text: async () => 'ok' };
      },
    });
    proxySharing.expose(3000, 'api');

    await proxySharing.handleRequest({
      name: 'api',
      method: 'GET',
    });
    assert.equal(capturedUrl, 'http://localhost:3000/');
  });

  // -- toJSON --

  it('toJSON returns serializable snapshot', () => {
    sharing.expose(3000, 'api');
    sharing.expose(8080, 'web');
    const json = sharing.toJSON();
    assert.equal(json.localPodId, 'pod-local');
    assert.equal(json.servers.length, 2);
  });
});
