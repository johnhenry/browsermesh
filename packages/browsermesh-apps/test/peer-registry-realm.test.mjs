// Run with: node --import ./test/_setup-globals.mjs --test test/peer-registry-realm.test.mjs
//
// The realm grant source in `PeerRegistry` (docs/design/realms.md, principles 2 and 7, 5.7 and section 7):
// unioned with the operator's grants in `checkAccess`, keyed by (realm, credential serial, peer), with its own
// expiry and epoch, never persisted, and held to a per-host realm policy.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PeerRegistry } from '../src/peer-registry.mjs';
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core';

const OWNER = 'owner';
const A = 'peer-a';
const B = 'peer-b';
const REALM = 'realm-a';
const OTHER_REALM = 'realm-b';
const T0 = 1_000_000;
const HOUR = 3_600_000;

function fakeClock(start = T0) {
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

const POLICY = {
  [REALM]: {
    roles: {
      member: ['protocol:mcp:open', 'protocol:chat:*', 'files:*:read'],
      guest: ['chat:*:read'],
      relay: ['egress:*:connect', 'mesh-relay:*:connect'],
    },
  },
};

function setup(extra = {}) {
  const clock = fakeClock();
  const dropped = [];
  const events = [];
  const reg = new PeerRegistry({
    localPodId: OWNER,
    clock,
    realmPolicy: POLICY,
    onRealmGrantDropped: (d) => dropped.push(d),
    ...extra,
  });
  reg.onAccessChange((e) => events.push(e));
  return { reg, clock, dropped, events };
}

const grant = (reg, over = {}) => reg.grantRealmScopes({
  realmId: REALM, serial: 1, peerKey: A, role: 'member', scopes: ['protocol:mcp:open'], notAfter: T0 + HOUR, epoch: 1, ...over,
});
const can = (reg, peer, resource, action) => reg.checkAccess(peer, resource, action).allowed;

describe('default policy: no realm is honoured', () => {
  it('a registry built without a policy grants nothing from any realm', () => {
    const reg = new PeerRegistry({ localPodId: OWNER, clock: fakeClock() });
    const r = reg.grantRealmScopes({ realmId: REALM, serial: 1, peerKey: A, role: 'member', scopes: ['protocol:mcp:open'], notAfter: T0 + HOUR, epoch: 1 });
    assert.deepEqual(r.granted, []);
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), false);
    assert.deepEqual(reg.listRealmGrants(), []);
  });

  it('the operator paths behave exactly as before when no realm is in use', () => {
    const reg = new PeerRegistry({ localPodId: OWNER, clock: fakeClock() });
    reg.grantCapabilities(A, ['files:read']);
    assert.equal(can(reg, A, 'files', 'read'), true);
    assert.equal(can(reg, A, 'files', 'write'), false);
    assert.equal(reg.checkAccess(B, 'files', 'read').reason, 'not_in_roster');
    assert.deepEqual(reg.listRealmGrants(), []);
  });
});

describe('granting and checking', () => {
  it('a live realm grant allows, an unrelated scope and an unrelated peer do not', () => {
    const { reg } = setup();
    const r = grant(reg);
    assert.deepEqual(r.granted, ['protocol:mcp:open']);
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), true);
    assert.equal(can(reg, A, 'protocol:other', 'open'), false);
    assert.equal(can(reg, B, 'protocol:mcp', 'open'), false);
  });

  it('a wildcard in the host allow list covers the concrete scopes under it', () => {
    const { reg } = setup();
    const r = grant(reg, { scopes: ['protocol:chat:open', 'files:a:read'] });
    assert.deepEqual(r.granted, ['protocol:chat:open', 'files:a:read']);
    assert.equal(can(reg, A, 'protocol:chat', 'open'), true);
    assert.equal(can(reg, A, 'files:a', 'read'), true);
  });

  it('is denied again once the clock passes notAfter, with no capability_revoked poisoning', () => {
    const { reg, clock } = setup();
    grant(reg);
    clock.advance(HOUR);
    const r = reg.checkAccess(A, 'protocol:mcp', 'open');
    assert.equal(r.allowed, false);
    assert.notEqual(r.reason, 'capability_revoked');
  });

  it('is unioned with the operator source: either one allows', () => {
    const { reg, clock } = setup();
    reg.grantCapabilities(A, ['files:read']);
    grant(reg);
    assert.equal(can(reg, A, 'files', 'read'), true);
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), true);
    clock.advance(2 * HOUR);
    assert.equal(can(reg, A, 'files', 'read'), true);
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), false);
  });

  it('a live realm grant allows even where the operator\'s own dead token for the scope denies', () => {
    const { reg, clock } = setup();
    reg.grantCapabilities(A, ['protocol:mcp:open'], { expiresAt: T0 + HOUR / 2 });
    grant(reg, { notAfter: T0 + 2 * HOUR });
    clock.advance(HOUR);
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), true);
  });

  it('requires a finite notAfter, a realm id, a peer key, a role, a scope list and an integer epoch', () => {
    const { reg } = setup();
    assert.throws(() => grant(reg, { notAfter: undefined }), TypeError);
    assert.throws(() => grant(reg, { notAfter: Infinity }), TypeError);
    assert.throws(() => grant(reg, { realmId: '' }), TypeError);
    assert.throws(() => grant(reg, { peerKey: '' }), TypeError);
    assert.throws(() => grant(reg, { role: '' }), TypeError);
    assert.throws(() => grant(reg, { epoch: 1.5 }), TypeError);
    assert.throws(() => grant(reg, { scopes: 'protocol:mcp:open' }), TypeError);
    assert.deepEqual(reg.listRealmGrants(), []);
  });

  it('a grant that is already past notAfter grants nothing', () => {
    const { reg } = setup();
    const r = grant(reg, { notAfter: T0 });
    assert.deepEqual(r.granted, []);
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), false);
  });
});

describe('host realm policy (principle 2)', () => {
  it('a realm id not in the policy grants nothing, and says so', () => {
    const { reg, dropped } = setup();
    const r = grant(reg, { realmId: OTHER_REALM });
    assert.deepEqual(r.granted, []);
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), false);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].reason, 'realm-not-honoured');
    assert.equal(dropped[0].realmId, OTHER_REALM);
  });

  it('a role the policy does not list grants nothing', () => {
    const { reg, dropped } = setup();
    const r = grant(reg, { role: 'admin' });
    assert.deepEqual(r.granted, []);
    assert.equal(dropped[0].reason, 'role-not-allowed');
  });

  it('a scope outside the role\'s allow list is dropped and reported; the rest is kept', () => {
    const { reg, dropped } = setup();
    const r = grant(reg, { scopes: ['protocol:mcp:open', 'protocol:other:open'] });
    assert.deepEqual(r.granted, ['protocol:mcp:open']);
    assert.deepEqual(r.dropped.map((d) => [d.scope, d.reason]), [['protocol:other:open', 'scope-not-allowed']]);
    assert.deepEqual(dropped.map((d) => [d.scope, d.reason]), [['protocol:other:open', 'scope-not-allowed']]);
    assert.equal(dropped[0].peerKey, A);
    assert.equal(dropped[0].role, 'member');
    assert.equal(dropped[0].serial, 1);
    assert.equal(can(reg, A, 'protocol:other', 'open'), false);
  });

  for (const scope of ['egress:example.com:connect', 'ingress:web:serve', 'pod-host:status:read', 'pod-host:t:exec', 'wsh-shell:x:open', 'wsh-objects:x:get']) {
    it(`${scope} is never granted from a realm unless the policy names it`, () => {
      // A broad allow list that does not name the sensitive prefix is not enough.
      const policy = { [REALM]: { roles: { member: ['*:*:*', 'protocol:*:*'] } } };
      const { reg, dropped } = setup({ realmPolicy: policy });
      const r = grant(reg, { scopes: [scope] });
      assert.deepEqual(r.granted, []);
      assert.equal(dropped[0].reason, 'sensitive-scope-not-named');
    });
  }

  it('a sensitive scope the policy names explicitly is granted', () => {
    const policy = { [REALM]: { roles: { relay: ['egress:example.com:connect', 'wsh-shell:*:open'] } } };
    const { reg } = setup({ realmPolicy: policy });
    const r = grant(reg, { role: 'relay', scopes: ['egress:example.com:connect', 'wsh-shell:main:open', 'egress:other.com:connect'] });
    assert.deepEqual(r.granted, ['egress:example.com:connect', 'wsh-shell:main:open']);
    assert.equal(can(reg, A, 'egress:example.com', 'connect'), true);
    assert.equal(can(reg, A, 'egress:other.com', 'connect'), false);
  });

  it('a role that lists `egress:*:connect` still cannot be handed a wildcard egress scope', () => {
    const { reg } = setup();
    assert.throws(() => grant(reg, { role: 'relay', scopes: ['egress:*:connect'] }), TypeError);
  });

  for (const scope of ['*', '*:*', '*:*:*', 'protocol:*:open', 'protocol:mcp:*', 'protocol:mcp', 'protocol::open', 'protocol:mcp:', ':mcp:open', 'files', '']) {
    it(`rejects the scope ${JSON.stringify(scope)} outright, and grants none of the list`, () => {
      const { reg } = setup();
      assert.throws(() => grant(reg, { scopes: ['protocol:mcp:open', scope] }), TypeError);
      assert.deepEqual(reg.listRealmGrants(), []);
      assert.equal(can(reg, A, 'protocol:mcp', 'open'), false);
    });
  }

  it('rejects a non-string scope', () => {
    const { reg } = setup();
    assert.throws(() => grant(reg, { scopes: [42] }), TypeError);
  });

  it('a policy change takes effect on grants already held: narrowing drops them, with an access change', () => {
    const { reg, events } = setup();
    grant(reg);
    events.length = 0;
    reg.setRealmPolicy({});
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), false);
    assert.deepEqual(reg.listRealmGrants(), []);
    assert.ok(events.some((e) => e.pubKey === A));
  });

  it('a policy change that widens grants what the credential asked for and an earlier policy dropped', () => {
    const { reg } = setup({ realmPolicy: { [REALM]: { roles: { member: [] } } } });
    grant(reg);
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), false);
    reg.setRealmPolicy(POLICY);
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), true);
  });

  it('setRealmPolicy validates its input', () => {
    const { reg } = setup();
    assert.throws(() => reg.setRealmPolicy({ [REALM]: { roles: { member: 'protocol:mcp:open' } } }), TypeError);
    assert.throws(() => reg.setRealmPolicy(null), TypeError);
  });
});

describe('renewal and replacement', () => {
  it('a new serial for the same (realm, peer, role) replaces the old grants atomically', () => {
    const { reg, clock } = setup();
    grant(reg, { serial: 1, scopes: ['protocol:mcp:open', 'files:a:read'], notAfter: T0 + HOUR });
    grant(reg, { serial: 2, scopes: ['protocol:mcp:open'], notAfter: T0 + 3 * HOUR });
    const held = reg.listRealmGrants({ peerKey: A });
    assert.equal(held.length, 1);
    assert.equal(held[0].serial, 2);
    assert.equal(can(reg, A, 'files:a', 'read'), false, 'scopes the new credential no longer carries are gone');
    clock.advance(2 * HOUR);
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), true, 'the renewal extends access');
  });

  it('a different role, realm or peer is a different slot', () => {
    const { reg } = setup({ realmPolicy: { ...POLICY, [OTHER_REALM]: { roles: { member: ['protocol:mcp:open'] } } } });
    grant(reg, { serial: 1 });
    grant(reg, { serial: 2, role: 'guest', scopes: ['chat:a:read'] });
    grant(reg, { serial: 3, realmId: OTHER_REALM });
    grant(reg, { serial: 4, peerKey: B });
    assert.equal(reg.listRealmGrants().length, 4);
  });

  it('a renewal whose scopes are all dropped removes the old grant rather than keeping it', () => {
    const { reg } = setup();
    grant(reg, { serial: 1 });
    grant(reg, { serial: 2, scopes: ['protocol:other:open'] });
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), false);
    assert.deepEqual(reg.listRealmGrants(), []);
  });

  it('a renewal does not touch the operator\'s grant of the same scope', () => {
    const { reg, clock } = setup();
    reg.grantCapabilities(A, ['protocol:mcp:open']);
    grant(reg, { serial: 1 });
    grant(reg, { serial: 2, notAfter: T0 + 2 * HOUR });
    clock.advance(3 * HOUR);
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), true);
  });
});

describe('removal and inspection', () => {
  function populated() {
    const s = setup({ realmPolicy: { ...POLICY, [OTHER_REALM]: { roles: { member: ['protocol:mcp:open'] } } } });
    grant(s.reg, { serial: 1, peerKey: A, epoch: 1 });
    grant(s.reg, { serial: 2, peerKey: B, epoch: 2 });
    grant(s.reg, { serial: 3, peerKey: B, role: 'guest', scopes: ['chat:a:read'], epoch: 3 });
    grant(s.reg, { serial: 4, peerKey: A, realmId: OTHER_REALM, epoch: 1 });
    s.events.length = 0;
    return s;
  }

  it('lists what is held, filterable', () => {
    const { reg } = populated();
    assert.equal(reg.listRealmGrants().length, 4);
    assert.equal(reg.listRealmGrants({ realmId: REALM }).length, 3);
    assert.equal(reg.listRealmGrants({ peerKey: B }).length, 2);
    assert.deepEqual(reg.listRealmGrants({ realmId: REALM, peerKey: A }), [{
      realmId: REALM, serial: 1, peerKey: A, role: 'member', scopes: ['protocol:mcp:open'], notAfter: T0 + HOUR, epoch: 1,
    }]);
  });

  it('the listing is a copy: editing it changes nothing', () => {
    const { reg } = populated();
    reg.listRealmGrants({ peerKey: A })[0].scopes.push('files:a:read');
    assert.equal(can(reg, A, 'files:a', 'read'), false);
  });

  it('removes by realm and peer, and only that realm\'s', () => {
    const { reg } = populated();
    assert.equal(reg.revokeRealmGrants({ realmId: REALM, peerKey: A }), 1);
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), false);
    assert.equal(reg.listRealmGrants({ realmId: OTHER_REALM, peerKey: A }).length, 1, 'the other realm\'s grant stays');
    assert.equal(reg.listRealmGrants({ peerKey: B }).length, 2);
  });

  it('removes by serial', () => {
    const { reg } = populated();
    assert.equal(reg.revokeRealmGrants({ realmId: REALM, serial: 2 }), 1);
    assert.deepEqual(reg.listRealmGrants({ peerKey: B }).map((g) => g.serial), [3]);
  });

  it('removes everything with an epoch below N for a realm', () => {
    const { reg } = populated();
    assert.equal(reg.revokeRealmGrants({ realmId: REALM, belowEpoch: 3 }), 2);
    assert.deepEqual(reg.listRealmGrants({ realmId: REALM }).map((g) => g.serial), [3]);
    assert.equal(reg.listRealmGrants({ realmId: OTHER_REALM }).length, 1, 'epochs are per realm');
  });

  it('needs a realm id and at least one selector', () => {
    const { reg } = populated();
    assert.throws(() => reg.revokeRealmGrants({}), TypeError);
    assert.throws(() => reg.revokeRealmGrants({ realmId: REALM }), TypeError);
    assert.equal(reg.listRealmGrants().length, 4);
  });

  it('removing nothing is not an access change', () => {
    const { reg, events } = populated();
    assert.equal(reg.revokeRealmGrants({ realmId: REALM, serial: 99 }), 0);
    assert.deepEqual(events, []);
  });

  it('revoking a realm grant never touches the operator\'s identical grant', () => {
    const { reg } = setup();
    reg.grantCapabilities(A, ['protocol:mcp:open']);
    grant(reg);
    reg.revokeRealmGrants({ realmId: REALM, peerKey: A });
    assert.equal(can(reg, A, 'protocol:mcp', 'open'), true);
  });

  it('removePeer drops the realm grants for that peer as well', () => {
    const { reg } = populated();
    reg.removePeer(A);
    assert.equal(reg.listRealmGrants({ peerKey: A }).length, 0);
    assert.equal(reg.listRealmGrants({ peerKey: B }).length, 2);
  });
});

describe('access-change events: open links re-check', () => {
  it('fires for a grant added, replaced and removed', () => {
    const { reg, events } = setup();
    grant(reg, { serial: 1 });
    grant(reg, { serial: 2 });
    reg.revokeRealmGrants({ realmId: REALM, peerKey: A });
    assert.deepEqual(events.map((e) => [e.pubKey, e.kind]), [[A, 'realm-granted'], [A, 'realm-replaced'], [A, 'realm-revoked']]);
  });

  it('fires once per affected peer on a removal by epoch', () => {
    const { reg, events } = setup();
    grant(reg, { peerKey: A, epoch: 1 });
    grant(reg, { peerKey: B, serial: 2, epoch: 1 });
    grant(reg, { peerKey: 'peer-c', serial: 3, epoch: 5 });
    events.length = 0;
    reg.revokeRealmGrants({ realmId: REALM, belowEpoch: 2 });
    assert.deepEqual(events.map((e) => e.pubKey).sort(), [A, B]);
  });

  it('a grant that dropped everything is not announced as a grant', () => {
    const { reg, events } = setup();
    grant(reg, { scopes: ['protocol:other:open'] });
    assert.deepEqual(events, []);
  });

  it('fires kind "expired" when a realm grant runs out, once, and the grant is gone', () => {
    const { reg, clock, events } = setup();
    grant(reg);
    events.length = 0;
    clock.advance(HOUR - 1);
    assert.deepEqual(events, []);
    clock.advance(1);
    assert.deepEqual(events, [{ pubKey: A, kind: 'expired' }]);
    assert.deepEqual(reg.listRealmGrants(), []);
    clock.advance(10 * HOUR);
    assert.equal(events.length, 1);
  });

  it('a link that re-checks on the event sees the grant already denied', () => {
    const { reg, clock } = setup();
    grant(reg);
    let seen = null;
    reg.onAccessChange(({ pubKey, kind }) => { if (kind === 'expired') seen = can(reg, pubKey, 'protocol:mcp', 'open'); });
    clock.advance(HOUR);
    assert.equal(seen, false);
  });

  it('a renewal before expiry means no expiry event for the old grant', () => {
    const { reg, clock, events } = setup();
    grant(reg, { serial: 1, notAfter: T0 + HOUR });
    clock.advance(HOUR / 2);
    grant(reg, { serial: 2, notAfter: T0 + 3 * HOUR });
    events.length = 0;
    clock.advance(HOUR);
    assert.deepEqual(events, []);
    clock.advance(2 * HOUR);
    assert.deepEqual(events, [{ pubKey: A, kind: 'expired' }]);
  });

  it('one timer serves any number of grants and the operator\'s tokens, armed for the nearest expiry', () => {
    const { reg, clock, events } = setup();
    reg.grantCapabilities(B, ['files:read'], { expiresAt: T0 + 5 * HOUR });
    for (let i = 0; i < 500; i += 1) grant(reg, { serial: i, peerKey: `p${i}`, notAfter: T0 + (i + 2) * HOUR });
    assert.equal(clock.pending, 1);
    assert.deepEqual(clock.delays, [2 * HOUR]);
    clock.advance(2 * HOUR);
    assert.equal(clock.pending, 1);
    assert.deepEqual(events.filter((e) => e.kind === 'expired').map((e) => e.pubKey), ['p0']);
    clock.advance(3 * HOUR);
    const expired = events.filter((e) => e.kind === 'expired').map((e) => e.pubKey);
    assert.ok(expired.includes(B), 'the operator\'s token still announces');
    assert.ok(expired.includes('p3'));
  });

  it('with realm grants and then none, no timer is left pending after the early wake-up', () => {
    const { reg, clock } = setup();
    grant(reg);
    assert.equal(clock.pending, 1);
    reg.revokeRealmGrants({ realmId: REALM, peerKey: A });
    clock.advance(2 * HOUR);
    assert.equal(clock.pending, 0);
  });

  it('dispose releases the timer', () => {
    const { reg, clock } = setup();
    grant(reg);
    reg.dispose();
    assert.equal(clock.pending, 0);
  });
});

describe('persistence: realm grants are never saved or restored', () => {
  const factories = { PeerManager: MeshPeerManager, TrustGraph, ACL: MeshACL };
  function real(clock) {
    return new PeerRegistry({
      localPodId: OWNER,
      peerManager: new MeshPeerManager({}),
      trustGraph: new TrustGraph(),
      acl: new MeshACL({ owner: OWNER }),
      clock,
      realmPolicy: POLICY,
    });
  }

  it('toJSON carries nothing about them, and the operator\'s grants are carried as before', () => {
    const clock = fakeClock();
    const reg = real(clock);
    reg.grantCapabilities(B, ['files:read']);
    const before = JSON.stringify(reg.toJSON());
    grant(reg);
    const after = JSON.stringify(reg.toJSON());
    assert.equal(after, before);
    assert.ok(!/realm/i.test(after));
    assert.deepEqual(Object.keys(reg.toJSON()).sort(), ['acl', 'localPodId', 'observedTrust', 'peers', 'trust']);
  });

  it('a restored registry has no realm grants and honours no realm', () => {
    const clock = fakeClock();
    const reg = real(clock);
    grant(reg);
    const restored = PeerRegistry.fromJSON(JSON.parse(JSON.stringify(reg.toJSON())), factories);
    assert.deepEqual(restored.listRealmGrants(), []);
    assert.equal(can(restored, A, 'protocol:mcp', 'open'), false);
    const r = restored.grantRealmScopes({ realmId: REALM, serial: 1, peerKey: A, role: 'member', scopes: ['protocol:mcp:open'], notAfter: T0 + HOUR, epoch: 1 });
    assert.deepEqual(r.granted, [], 'the policy is not persisted either: the host configures it');
  });
});
