// Run with: node --import ./test/_setup-globals.mjs --test test/peer-registry-access.test.mjs
//
// 1. A registry with no injected ACL matches scopes exactly like `MeshACL`:
//    one matcher, any number of segments.
// 2. A grant that expires produces the same access-change event as a revocation,
//    from a single bounded timer, with an injected clock.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { PeerRegistry } from '../src/peer-registry.mjs';
import {
  MeshPeerManager, TrustGraph, MeshACL, CapabilityValidator, CapabilityToken,
} from '@johnhenry/browsermesh-core';

const OWNER = 'owner';
const PEER = 'peer';

/** A registry with no injected ACL, and the same one over the real `MeshACL`. */
function bothRegistries(extra = {}) {
  const plain = new PeerRegistry({ localPodId: OWNER, ...extra });
  const real = new PeerRegistry({
    localPodId: OWNER,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: OWNER }),
    ...extra,
  });
  return { plain, real };
}

// Every (resource, action) pair a `checkAccess()` call in this repository can produce, with a scope
// that grants it and one that must not. `from` names the module (the inventory test below keeps this honest).
const USED = [
  { from: 'peer-routing', resource: 'server-share:docs', action: 'request', grant: 'server-share:docs:request', other: 'server-share:other:request' },
  { from: 'peer-routing', resource: 'server-share:docs', action: 'request', grant: 'server-share:*:request', other: 'server-share:*:read' },
  { from: 'mesh-relay-host', resource: 'mesh-relay:chat', action: 'connect', grant: 'mesh-relay:chat:connect', other: 'mesh-relay:files:connect' },
  { from: 'mesh-relay-host', resource: 'mesh-relay:chat', action: 'connect', grant: 'mesh-relay:*:connect', other: 'mesh-relay:*:disconnect' },
  { from: 'protocol-channel', resource: 'protocol:counter', action: 'open', grant: 'protocol:counter:open', other: 'protocol:other:open' },
  { from: 'protocol-channel', resource: 'protocol:counter', action: 'open', grant: 'protocol:counter:*', other: 'protocol:*:close' },
  { from: 'wsh-negotiator', resource: 'mesh:link', action: 'connect', grant: 'mesh:link:connect', other: 'mesh:link:accept' },
  { from: 'peer-escrow', resource: 'escrow', action: 'create', grant: 'escrow:create', other: 'escrow:release' },
  { from: 'peer-escrow', resource: 'escrow:c-1', action: 'release', grant: 'escrow:c-1:release', other: 'escrow:c-2:release' },
  { from: 'mesh-swarm', resource: 'swarm', action: 'join', grant: 'swarm:join', other: 'swarm:submit-task' },
  { from: 'mesh-swarm', resource: 'swarm', action: 'submit-task', grant: 'swarm:*', other: 'orchestrator:*' },
  { from: 'mesh-orchestrator', resource: 'orchestrator', action: 'exec', grant: 'orchestrator:exec', other: 'orchestrator:drain' },
  { from: 'mesh-compute', resource: 'compute', action: 'execute', grant: 'compute:execute', other: 'compute:chunk' },
  { from: 'mesh-agent-swarm', resource: 'agent-swarm', action: 'execute', grant: 'agent-swarm:execute', other: 'swarm:execute' },
  { from: 'mesh-verification', resource: 'verification', action: 'execute', grant: 'verification:*', other: 'verify:*' },
  { from: 'peer-terminal', resource: 'terminal', action: 'execute', grant: 'terminal:execute', other: 'terminal:read' },
  { from: 'peer-files', resource: 'files', action: 'read', grant: 'files:read', other: 'files:write' },
  { from: 'mesh-kv', resource: 'kv:settings', action: 'write', grant: 'kv:settings:write', other: 'kv:other:write' },
  { from: 'chunk-replication', resource: 'chunks:blob', action: 'read', grant: 'chunks:blob:read', other: 'chunks:blob:write' },
  { from: 'manifest-sync', resource: 'manifest:site', action: 'write', grant: 'manifest:site:write', other: 'manifest:other:write' },
  { from: 'serverless-static', resource: 's3:bucket', action: 'read', grant: 's3:bucket:read', other: 's3:other:read' },
  { from: 'pod-host-service', resource: 'pod-host', action: 'exec', grant: 'pod-host:exec', other: 'pod-host:drain' },
  { from: 'pod-host-service', resource: 'pod-host:tenant-a', action: 'exec', grant: 'pod-host:tenant-a:exec', other: 'pod-host:tenant-b:exec' },
  { from: 'serverless-proxy', resource: 'serverless-proxy:api.example.com', action: 'request', grant: 'serverless-proxy:api.example.com:request', other: 'serverless-proxy:other.example.com:request' },
  { from: 'mesh-websocket', resource: 'mesh-websocket:chat', action: 'connect', grant: 'mesh-websocket:chat:connect', other: 'mesh-websocket:files:connect' },
  { from: 'pod-host-routes', resource: 'pod-host', action: 'status', grant: 'pod-host:status', other: 'pod-host:exec' },
  { from: 'kernel', resource: 'mesh', action: 'send', grant: 'mesh:send', other: 'mesh:receive' },
  // wildcards and deeper scopes
  { from: 'any', resource: 'anything:at:all', action: 'x', grant: '*:*', other: null },
  { from: 'any', resource: 'a:b:c', action: 'd', grant: 'a:b:c:d', other: 'a:b:c:e' },
  { from: 'any', resource: 'a:b:c', action: 'd', grant: 'a:b:*:d', other: 'a:b:*:e' },
];

describe('PeerRegistry default ACL matches scopes of any depth, exactly like MeshACL', () => {
  for (const row of USED) {
    it(`${row.from}: ${row.resource} / ${row.action} is granted by ${row.grant}${row.other ? ` and not by ${row.other}` : ''}`, () => {
      const { plain, real } = bothRegistries();
      for (const [name, registry] of [['default ACL', plain], ['MeshACL', real]]) {
        registry.grantCapabilities(PEER, [row.grant]);
        assert.equal(registry.checkAccess(PEER, row.resource, row.action).allowed, true, `${name} allows ${row.grant}`);
        if (row.other) {
          const denied = new PeerRegistry({ ...(name === 'MeshACL' ? { localPodId: OWNER, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: OWNER }) } : { localPodId: OWNER }) });
          denied.grantCapabilities(PEER, [row.other]);
          assert.equal(denied.checkAccess(PEER, row.resource, row.action).allowed, false, `${name} refuses ${row.other}`);
        }
      }
    });
  }

  it('a peer with no grant and the owner behave as before', () => {
    const { plain, real } = bothRegistries();
    for (const registry of [plain, real]) {
      assert.equal(registry.checkAccess('stranger', 'mesh-relay:chat', 'connect').allowed, false);
      assert.equal(registry.checkAccess(OWNER, 'mesh-relay:chat', 'connect').allowed, true);
    }
  });

  it('the named ACL templates still work through the default ACL', () => {
    const { plain, real } = bothRegistries();
    for (const registry of [plain, real]) {
      registry.updatePermissions(PEER, 'collaborator');
      assert.equal(registry.checkAccess(PEER, 'chat', 'read').allowed, true);
      assert.equal(registry.checkAccess(PEER, 'files', 'write').allowed, true);
      assert.equal(registry.checkAccess(PEER, 'mesh-relay:chat', 'connect').allowed, false);
    }
  });

  it('every module that calls checkAccess() is covered by the table above', () => {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const sources = readdirSync(dir).filter((f) => f.endsWith('.mjs'));
    const isCode = (line) => !/^\s*(\*|\/\/|\/\*)/.test(line);
    const calling = sources
      .filter((f) => readFileSync(path.join(dir, f), 'utf8').split('\n').filter(isCode).some((line) => /\bcheckAccess\(/.test(line)))
      .map((f) => f.replace(/\.mjs$/, ''))
      .filter((f) => f !== 'peer-registry');
    const covered = new Set(USED.map((r) => r.from));
    const missing = calling.filter((f) => !covered.has(f));
    assert.deepEqual(missing, [], `add a row for these modules' scopes: ${missing.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// Expiry
// ---------------------------------------------------------------------------

/** A clock whose timers fire only when the test advances it. */
function fakeClock(start = 1_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + ms, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    get pending() { return timers.size; },
    get delays() { return [...timers.values()].map((x) => x.ms); },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        t = due[1].at;
        timers.delete(due[0]);
        due[1].fn();
      }
      t = target;
    },
  };
}

function expiryRegistry() {
  const clock = fakeClock();
  const registry = new PeerRegistry({
    localPodId: OWNER,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: OWNER }),
    capabilityValidator: new CapabilityValidator(),
    tokenFactory: (o) => new CapabilityToken(o),
    clock,
  });
  const events = [];
  registry.onAccessChange((e) => events.push(e));
  return { clock, registry, events };
}

describe('a grant that expires is announced like a revocation', () => {
  it('emits an access change for the peer when its grant expires, and denies from then on', () => {
    const { clock, registry, events } = expiryRegistry();
    registry.grantCapabilities(PEER, ['mesh-relay:chat:connect'], { expiresAt: clock.now() + 1000 });
    assert.equal(registry.checkAccess(PEER, 'mesh-relay:chat', 'connect').allowed, true);
    clock.advance(999);
    assert.deepEqual(events, []);
    assert.equal(registry.checkAccess(PEER, 'mesh-relay:chat', 'connect').allowed, true);
    clock.advance(1);
    assert.deepEqual(events, [{ pubKey: PEER, kind: 'expired' }]);
    assert.equal(registry.checkAccess(PEER, 'mesh-relay:chat', 'connect').allowed, false);
    assert.equal(clock.pending, 0, 'nothing is left armed');
  });

  it('uses one timer for the nearest expiry however many grants there are', () => {
    const { clock, registry, events } = expiryRegistry();
    registry.grantCapabilities('a', ['x:y'], { expiresAt: clock.now() + 3000 });
    registry.grantCapabilities('b', ['x:y'], { expiresAt: clock.now() + 1000 });
    registry.grantCapabilities('c', ['x:y', 'x:z'], { expiresAt: clock.now() + 2000 });
    registry.grantCapabilities('d', ['x:y']); // no expiry: no timer of its own
    assert.equal(clock.pending, 1);
    assert.deepEqual(clock.delays, [1000]);
    clock.advance(1000);
    assert.deepEqual(events, [{ pubKey: 'b', kind: 'expired' }]);
    assert.equal(clock.pending, 1);
    assert.deepEqual(clock.delays, [1000]);
    clock.advance(1000);
    assert.deepEqual(events.map((e) => e.pubKey), ['b', 'c'], 'one event per peer even with two grants expiring together');
    clock.advance(1000);
    assert.deepEqual(events.map((e) => e.pubKey), ['b', 'c', 'a']);
    assert.equal(clock.pending, 0);
  });

  it('a grant revoked before it expires is not announced again, and its timer is released', () => {
    const { clock, registry, events } = expiryRegistry();
    registry.grantCapabilities(PEER, ['x:y'], { expiresAt: clock.now() + 1000 });
    registry.revokeCapabilities(PEER, ['x:y']);
    assert.deepEqual(events, [{ pubKey: PEER, kind: 'revoked' }]);
    assert.equal(clock.pending, 0);
    clock.advance(5000);
    assert.deepEqual(events, [{ pubKey: PEER, kind: 'revoked' }]);
  });

  it('a removed peer is not announced when its old grant would have expired', () => {
    const { clock, registry, events } = expiryRegistry();
    registry.grantCapabilities(PEER, ['x:y'], { expiresAt: clock.now() + 1000 });
    registry.removePeer(PEER);
    assert.equal(clock.pending, 0);
    clock.advance(5000);
    assert.deepEqual(events, [{ pubKey: PEER, kind: 'removed' }]);
  });

  it('a later grant for the same peer that expires sooner moves the timer', () => {
    const { clock, registry, events } = expiryRegistry();
    registry.grantCapabilities('a', ['x:y'], { expiresAt: clock.now() + 5000 });
    registry.grantCapabilities('b', ['x:y'], { expiresAt: clock.now() + 500 });
    assert.equal(clock.pending, 1);
    clock.advance(500);
    assert.deepEqual(events, [{ pubKey: 'b', kind: 'expired' }]);
  });

  it('an expiry further away than a timer can wait is reached in steps, without announcing early', () => {
    const { clock, registry, events } = expiryRegistry();
    const far = 40 * 24 * 3600 * 1000;
    registry.grantCapabilities(PEER, ['x:y'], { expiresAt: clock.now() + far });
    assert.equal(clock.pending, 1);
    assert.ok(clock.delays[0] <= 2 ** 31 - 1, `timer delay ${clock.delays[0]} fits a timer`);
    clock.advance(clock.delays[0]);
    assert.deepEqual(events, []);
    assert.equal(clock.pending, 1);
    clock.advance(far);
    assert.deepEqual(events, [{ pubKey: PEER, kind: 'expired' }]);
  });

  it('works with the registry default token, not only the core one', () => {
    const clock = fakeClock();
    const registry = new PeerRegistry({ localPodId: OWNER, clock });
    const events = [];
    registry.onAccessChange((e) => events.push(e));
    registry.grantCapabilities(PEER, ['x:y'], { expiresAt: clock.now() + 10 });
    assert.equal(registry.checkAccess(PEER, 'x', 'y').allowed, true);
    clock.advance(10);
    assert.deepEqual(events, [{ pubKey: PEER, kind: 'expired' }]);
    assert.equal(registry.checkAccess(PEER, 'x', 'y').allowed, false);
  });
});
