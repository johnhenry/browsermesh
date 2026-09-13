// Run with: node --import ./test/_setup-globals.mjs --test test/peer-routing.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  ROUTING_DEFAULTS,
  MeshRouter,
  ServerSharing,
  createMeshRoutingService,
} from '../src/peer-routing.mjs';
import { attachService } from '../src/mesh-service.mjs';
import { PeerRegistry } from '../src/peer-registry.mjs';
import { createMeshNode } from '../src/mesh-bootstrap.mjs';
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core';

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

// =============================================================================
// createMeshRoutingService -- wired as a MeshService (attachService(), Phase C)
// =============================================================================
//
// Fixtures mirror mesh-rpc.test.mjs's own: real Ed25519 IdentityWallet/
// MeshIdentityManager identities + real PeerRegistry (wired to real
// MeshACL/MeshPeerManager/TrustGraph from @johnhenry/browsermesh-core),
// connected via a minimal duck-typed in-memory sendTo()/onIncomingData()
// bus -- not real WebRTC (that's a different layer's job).

/** A real Ed25519 identity + wallet + registry bundle for one "peer". */
async function createRoutingTestPeer(label) {
  const identityManager = new MeshIdentityManager({});
  const wallet = new IdentityWallet({ identityManager });
  const { podId } = await wallet.createIdentity(label);
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId }),
  });
  return { podId, wallet, registry };
}

/**
 * A duck-typed multi-peer bus restricted to an explicit set of edges: `sendTo()`
 * only delivers between two podIds if an edge connects them, silently
 * dropping otherwise (modeling "no transport reachability", the same way an
 * unconnected real PeerNode pair would never exchange envelopes at all).
 * This is what makes the "A and C are not directly connected" multi-hop
 * proof genuine: if `createMeshRoutingService()`'s `forwardFn` ever sent
 * straight to the ultimate target instead of the next hop `MeshRouter`
 * handed it, the message would never arrive here, not just skip an
 * intermediate hop.
 * @param {Array<{podId: string, wallet?: object, registry: object}>} peers
 * @param {Array<[string, string]>} edges - Pairs of podIds with a direct transport link.
 * @returns {Record<string, any>} keyed by each peer's `podId`
 */
function wireRestrictedMesh(peers, edges) {
  const edgeSet = new Set();
  for (const [a, b] of edges) {
    edgeSet.add(`${a}|${b}`);
    edgeSet.add(`${b}|${a}`);
  }
  const listenersByPodId = new Map(peers.map((p) => [p.podId, new Set()]));
  const nodesByPodId = {};
  for (const peer of peers) {
    nodesByPodId[peer.podId] = {
      podId: peer.podId,
      wallet: peer.wallet,
      registry: peer.registry,
      onIncomingData(cb) {
        const set = listenersByPodId.get(peer.podId);
        set.add(cb);
        return () => set.delete(cb);
      },
      async sendTo(pubKey, data) {
        if (!edgeSet.has(`${peer.podId}|${pubKey}`)) return; // no direct link -- silently unreachable
        const set = listenersByPodId.get(pubKey);
        if (!set) return;
        queueMicrotask(() => {
          for (const cb of set) cb(peer.podId, data);
        });
      },
    };
  }
  return nodesByPodId;
}

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs = 1000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
}

// -----------------------------------------------------------------------
// The real capability-gap proof: A -> B -> C, A and C share no transport edge
// -----------------------------------------------------------------------

describe('createMeshRoutingService: multi-hop forwarding closes the real capability gap', () => {
  it('a message from A, routed through B, reaches C even though A and C have no direct transport link', async () => {
    const alice = await createRoutingTestPeer('alice');
    const bob = await createRoutingTestPeer('bob');
    const carol = await createRoutingTestPeer('carol');

    // Only A<->B and B<->C edges exist -- no A<->C edge at all.
    const mesh = wireRestrictedMesh(
      [alice, bob, carol],
      [[alice.podId, bob.podId], [bob.podId, carol.podId]],
    );
    const { [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC } = mesh;

    const bobForwards = [];
    const { api: bobApi, on: bobOn } = attachService(nodeB, undefined, createMeshRoutingService({}));
    bobOn('mesh-routing:forward', (envelope) => bobForwards.push(envelope));
    // Bob knows Carol directly; this is the routing-table knowledge that
    // makes Bob able to relay onward, entirely separate from transport
    // reachability (which wireRestrictedMesh already grants for B<->C).
    bobApi.addDirectPeer(carol.podId);

    const carolMessages = [];
    const { on: carolOn } = attachService(nodeC, undefined, createMeshRoutingService({}));
    carolOn('mesh-routing:message', (envelope) => carolMessages.push(envelope));

    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRoutingService({}));
    // Alice has no direct transport link to Carol -- only a route entry
    // saying "reach Carol via Bob".
    aliceApi.addRoute(carol.podId, bob.podId, 2);

    const result = aliceApi.route(carol.podId, { hello: 'world' });
    assert.equal(result.success, true);
    assert.equal(result.hops, 2);
    assert.deepEqual(result.path, [alice.podId, bob.podId]);

    await waitFor(() => carolMessages.length > 0, 1000, "carol to receive alice's routed message");

    assert.equal(carolMessages[0].from, alice.podId);
    assert.equal(carolMessages[0].to, carol.podId);
    assert.deepEqual(carolMessages[0].message, { hello: 'world' });
    // path proves it actually transited bob, not a direct hop.
    assert.deepEqual(carolMessages[0].path, [alice.podId, bob.podId]);

    assert.equal(bobForwards.length, 1);
    assert.equal(bobForwards[0].to, carol.podId);
  });

  it('TTL still expires correctly across a real relayed hop (message dropped, not delivered)', async () => {
    const alice = await createRoutingTestPeer('alice');
    const bob = await createRoutingTestPeer('bob');
    const carol = await createRoutingTestPeer('carol');

    const mesh = wireRestrictedMesh(
      [alice, bob, carol],
      [[alice.podId, bob.podId], [bob.podId, carol.podId]],
    );
    const { [alice.podId]: nodeA, [bob.podId]: nodeB, [carol.podId]: nodeC } = mesh;

    const { api: bobApi } = attachService(nodeB, undefined, createMeshRoutingService({}));
    bobApi.addDirectPeer(carol.podId);

    const carolMessages = [];
    const { on: carolOn } = attachService(nodeC, undefined, createMeshRoutingService({}));
    carolOn('mesh-routing:message', (envelope) => carolMessages.push(envelope));

    // maxTTL: 1 -- by the time bob decrements it, it reaches 0 and bob drops it.
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRoutingService({ maxTTL: 1 }));
    aliceApi.addRoute(carol.podId, bob.podId, 2);

    aliceApi.route(carol.podId, { hello: 'dropped' });

    // Give the microtask chain a beat to (not) deliver.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(carolMessages.length, 0);
  });
});

// -----------------------------------------------------------------------
// Route table management + ctx.emit() bridging, through the api surface
// -----------------------------------------------------------------------

describe('createMeshRoutingService: route table management via api, bridged through ctx.emit()', () => {
  it('addRoute/getRoute/listRoutes/removeRoute delegate correctly and emit mesh-routing:route-add/-remove', async () => {
    const alice = await createRoutingTestPeer('alice');
    const bob = await createRoutingTestPeer('bob');
    const mesh = wireRestrictedMesh([alice, bob], [[alice.podId, bob.podId]]);
    const { [alice.podId]: nodeA } = mesh;

    const events = [];
    const { api, on } = attachService(nodeA, undefined, createMeshRoutingService({}));
    on('mesh-routing:route-add', (entry) => events.push({ type: 'add', entry }));
    on('mesh-routing:route-remove', (data) => events.push({ type: 'remove', data }));

    assert.deepEqual(api.listRoutes(), []);
    api.addRoute(bob.podId, 'relay-1', 2);
    assert.equal(api.getRoute(bob.podId).nextHop, 'relay-1');
    assert.equal(api.listRoutes().length, 1);

    const removed = api.removeRoute(bob.podId);
    assert.equal(removed, true);
    assert.equal(api.getRoute(bob.podId), null);

    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'add');
    assert.equal(events[0].entry.target, bob.podId);
    assert.equal(events[1].type, 'remove');
    assert.equal(events[1].data.target, bob.podId);
  });

  it('addDirectPeer/removeDirectPeer/listDirectPeers delegate correctly', async () => {
    const alice = await createRoutingTestPeer('alice');
    const mesh = wireRestrictedMesh([alice], []);
    const { [alice.podId]: nodeA } = mesh;
    const { api } = attachService(nodeA, undefined, createMeshRoutingService({}));

    assert.deepEqual(api.listDirectPeers(), []);
    api.addDirectPeer('pod-x');
    assert.deepEqual(api.listDirectPeers(), ['pod-x']);
    api.removeDirectPeer('pod-x');
    assert.deepEqual(api.listDirectPeers(), []);
  });

  it('pruneExpired removes expired routes and emits mesh-routing:route-remove for each', async () => {
    const alice = await createRoutingTestPeer('alice');
    const mesh = wireRestrictedMesh([alice], []);
    const { [alice.podId]: nodeA } = mesh;

    const removedTargets = [];
    const { api, on } = attachService(nodeA, undefined, createMeshRoutingService({}));
    on('mesh-routing:route-remove', ({ target }) => removedTargets.push(target));

    api.addRoute('pod-old', 'pod-x', 1, 1); // 1ms TTL
    api.addRoute('pod-new', 'pod-y', 1); // default 60s TTL

    const pruned = api.pruneExpired(Date.now() + 100);
    assert.equal(pruned, 1);
    assert.equal(api.getRoute('pod-old'), null);
    assert.notEqual(api.getRoute('pod-new'), null);
    assert.deepEqual(removedTargets, ['pod-old']);
  });

  it('teardown unsubscribes from incoming data and stops further event delivery', async () => {
    const alice = await createRoutingTestPeer('alice');
    const bob = await createRoutingTestPeer('bob');
    const mesh = wireRestrictedMesh([alice, bob], [[alice.podId, bob.podId]]);
    const { [alice.podId]: nodeA } = mesh;

    const events = [];
    const { api, on, teardown } = attachService(nodeA, undefined, createMeshRoutingService({}));
    on('mesh-routing:route-add', (entry) => events.push(entry));

    api.addRoute(bob.podId, 'relay-1', 1);
    assert.equal(events.length, 1);

    await teardown();

    api.addRoute('pod-after-teardown', 'relay-2', 1);
    // The router itself still works (teardown only detaches this file's own
    // wiring), but the event bus is closed -- no further emit() reaches `on()`.
    assert.equal(events.length, 1);
  });
});

// -----------------------------------------------------------------------
// ServerSharing wiring (opt-in via fetchFn)
// -----------------------------------------------------------------------

describe('createMeshRoutingService: ServerSharing wiring (opt-in via fetchFn)', () => {
  it('is NOT wired when fetchFn is omitted entirely', async () => {
    const alice = await createRoutingTestPeer('alice');
    const mesh = wireRestrictedMesh([alice], []);
    const { [alice.podId]: nodeA } = mesh;
    const { api } = attachService(nodeA, undefined, createMeshRoutingService({}));

    assert.equal(api.expose, undefined);
    assert.equal(api.requestProxy, undefined);
  });

  it('a remote peer can requestProxy() a server this peer exposed, proxied via the injected fetchFn', async () => {
    const alice = await createRoutingTestPeer('alice');
    const bob = await createRoutingTestPeer('bob');
    const mesh = wireRestrictedMesh([alice, bob], [[alice.podId, bob.podId]]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    const fetchCalls = [];
    const events = [];
    const { api: bobApi, on: bobOn } = attachService(nodeB, undefined, createMeshRoutingService({
      fetchFn: async (url, init) => {
        fetchCalls.push({ url, init });
        return {
          status: 200,
          headers: new Map([['content-type', 'application/json']]),
          text: async () => '{"ok":true}',
        };
      },
    }));
    bobOn('mesh-routing:server-share-served', (data) => events.push(data));
    bobApi.expose(3000, 'api');

    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRoutingService({ fetchFn: null }));

    const res = await aliceApi.requestProxy(bob.podId, { name: 'api', method: 'GET', path: '/data' });

    assert.equal(res.status, 200);
    assert.equal(res.body, '{"ok":true}');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].url, 'http://localhost:3000/data');

    await waitFor(() => events.length > 0, 1000, 'mesh-routing:server-share-served to fire on the host side');
    assert.equal(events[0].name, 'api');
    assert.equal(events[0].status, 200);
  });

  it('requestProxy() returns 404 when the named server was never exposed', async () => {
    const alice = await createRoutingTestPeer('alice');
    const bob = await createRoutingTestPeer('bob');
    const mesh = wireRestrictedMesh([alice, bob], [[alice.podId, bob.podId]]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    attachService(nodeB, undefined, createMeshRoutingService({ fetchFn: null }));
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRoutingService({ fetchFn: null }));

    const res = await aliceApi.requestProxy(bob.podId, { name: 'nonexistent' });
    assert.equal(res.status, 404);
  });

  it('requestProxy() times out cleanly when the target has no mesh-routing service attached at all', async () => {
    const alice = await createRoutingTestPeer('alice');
    const bob = await createRoutingTestPeer('bob');
    const mesh = wireRestrictedMesh([alice, bob], [[alice.podId, bob.podId]]);
    const { [alice.podId]: nodeA } = mesh; // bob's node is never given a service

    const { api: aliceApi } = attachService(nodeA, undefined, createMeshRoutingService({
      fetchFn: null,
      proxyTimeoutMs: 100,
    }));

    const start = Date.now();
    await assert.rejects(
      () => aliceApi.requestProxy(bob.podId, { name: 'anything' }),
      /timed out after 100ms/,
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 90 && elapsed < 1000, `expected a timeout around 100ms, took ${elapsed}ms`);
  });

  it('teardown rejects any still-in-flight requestProxy() calls', async () => {
    const alice = await createRoutingTestPeer('alice');
    const bob = await createRoutingTestPeer('bob');
    const mesh = wireRestrictedMesh([alice, bob], [[alice.podId, bob.podId]]);
    const { [alice.podId]: nodeA, [bob.podId]: nodeB } = mesh;

    const { api: bobApi } = attachService(nodeB, undefined, createMeshRoutingService({
      fetchFn: () => new Promise(() => {}), // bob's fetchFn never resolves
    }));
    bobApi.expose(3000, 'whatever'); // must be exposed, or handleRequest() 404s instantly instead of hanging
    const { api: aliceApi, teardown } = attachService(nodeA, undefined, createMeshRoutingService({
      fetchFn: null,
      proxyTimeoutMs: 5000,
    }));

    const pending = aliceApi.requestProxy(bob.podId, { name: 'whatever' });
    await new Promise((r) => setTimeout(r, 10));
    await teardown();

    await assert.rejects(() => pending, /torn down/);
  });
});

// -----------------------------------------------------------------------
// createMeshNode({ enableRouting: true }) -- opt-in surface (issue #121)
// -----------------------------------------------------------------------
// Mirrors mesh-dht.test.mjs's own "createMeshNode({ enableDht: true })"
// integration section: real createMeshNode() PeerNodes, skipBoot: true where
// the test doesn't need actual discovery/WebRTC boot, just construction and
// the opt-in wiring surface itself.

function createStubSignalingTransport() {
  return { send() {}, onMessage() {} };
}

describe('createMeshNode({ enableRouting: true })', () => {
  it('leaves node.router unset and node.services empty of "mesh-routing" when enableRouting is omitted', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
    });

    assert.equal(node.router, undefined);
    assert.equal(node.services.has('mesh-routing'), false);
  });

  it('attaches node.router (== node.services.get("mesh-routing")) when enableRouting is set', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableRouting: true,
      skipBoot: true,
    });

    assert.ok(node.router, 'node.router is attached');
    assert.equal(node.router, node.services.get('mesh-routing'));
    assert.equal(typeof node.router.api.route, 'function');
    assert.equal(node.router.api.expose, undefined, 'ServerSharing not wired without routingOptions.fetchFn');
  });

  it('routingOptions are forwarded to createMeshRoutingService(), including wiring ServerSharing via fetchFn', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableRouting: true,
      routingOptions: { maxTTL: 3, fetchFn: null },
      skipBoot: true,
    });

    assert.equal(typeof node.router.api.expose, 'function', 'ServerSharing wired since routingOptions.fetchFn was supplied');

    node.router.api.addDirectPeer('pod-x');
    const result = node.router.api.route('pod-x', { hello: 'world' });
    assert.equal(result.success, true);
  });
});
