// Run with: node --import ./test/_setup-globals.mjs --test test/peer-registry-realm-shared-slot.test.mjs
//
// Why a realm needs its own grant source in `PeerRegistry` (docs/design/realms.md, section 7).
//
// Each scenario below is written once and run through two ways of giving a peer a realm's grant:
//
//   - "shared slot": the NAIVE way, the operator API (`grantCapabilities` / `revokeCapabilities`), which keeps one
//     expiring token per (peer, scope string) with no record of who granted it. Every scenario fails there: that
//     is the demonstration, and the suite asserts that it keeps failing so nobody is tempted to take the shortcut.
//   - "realm source": `grantRealmScopes` / `revokeRealmGrants`, the separate source. Every scenario passes there.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import { PeerRegistry } from '../src/peer-registry.mjs';
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core';

const OWNER = 'owner';
const PEER = 'peer';
const REALM = 'realm-a';
const T0 = 1_000_000;
const HOUR = 3_600_000;

/** A clock whose timers fire only when the test advances it. */
function fakeClock(start = T0) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
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

/** The real core classes, so the ACL template really is serialised and restored. */
const factories = { PeerManager: MeshPeerManager, TrustGraph, ACL: MeshACL };
function realRegistry(clock, extra = {}) {
  return new PeerRegistry({
    localPodId: OWNER,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: OWNER }),
    clock,
    realmPolicy: { [REALM]: { roles: { member: ['protocol:*:open'] } } },
    ...extra,
  });
}

const sharedSlot = {
  name: 'shared slot',
  // The wildcard is what makes the third scenario bite; a realm source refuses wildcards, see its adapter.
  wildcard: 'protocol:*:open',
  grant(reg, scopes, notAfter, serial = 1) { reg.grantCapabilities(PEER, scopes, { expiresAt: notAfter }); },
  revoke(reg, scopes) { reg.revokeCapabilities(PEER, scopes); },
};
const realmSource = {
  name: 'realm source',
  wildcard: 'protocol:mcp:open',
  grant(reg, scopes, notAfter, serial = 1) {
    reg.grantRealmScopes({ realmId: REALM, serial, peerKey: PEER, role: 'member', scopes, notAfter, epoch: 1 });
  },
  revoke(reg) { reg.revokeRealmGrants({ realmId: REALM, peerKey: PEER }); },
};

const allowed = (reg, scope = 'protocol:mcp:open') => {
  const i = scope.lastIndexOf(':');
  return reg.checkAccess(PEER, scope.slice(0, i), scope.slice(i + 1)).allowed;
};

const SCENARIOS = [
  ['1. a renewal with a later expiry extends access', (src) => {
    const clock = fakeClock();
    const reg = realRegistry(clock);
    src.grant(reg, ['protocol:mcp:open'], T0 + HOUR, 1);
    clock.advance(HOUR / 2);
    src.grant(reg, ['protocol:mcp:open'], T0 + 3 * HOUR, 2); // renewed before it ran out
    clock.advance(HOUR); // past the first expiry
    assert.equal(allowed(reg), true, 'still allowed after the first expiry, the renewal carries it');
    clock.advance(2 * HOUR); // past the renewal too
    assert.equal(allowed(reg), false, 'and gone when the renewal runs out');
  }],
  ['2. an operator permanent grant made after the realm grant outlives the realm expiry', (src) => {
    const clock = fakeClock();
    const reg = realRegistry(clock);
    src.grant(reg, ['protocol:mcp:open'], T0 + HOUR);
    reg.grantCapabilities(PEER, ['protocol:mcp:open']); // the operator, permanently
    clock.advance(2 * HOUR);
    assert.equal(allowed(reg), true, 'the operator grant has no expiry');
  }],
  ['3. an expired realm wildcard does not deny a permanent operator grant', (src) => {
    const clock = fakeClock();
    const reg = realRegistry(clock);
    reg.grantCapabilities(PEER, ['protocol:mcp:open']); // the operator, permanently
    src.grant(reg, [src.wildcard], T0 + HOUR);
    clock.advance(2 * HOUR);
    const result = reg.checkAccess(PEER, 'protocol:mcp', 'open');
    assert.deepEqual({ allowed: result.allowed, reason: result.reason }, { allowed: true, reason: undefined });
  }],
  ['4. revoking the realm grant leaves the operator\'s identical grant alone', (src) => {
    const reg = realRegistry(fakeClock());
    reg.grantCapabilities(PEER, ['protocol:mcp:open']); // the operator
    src.grant(reg, ['protocol:mcp:open'], T0 + HOUR);
    src.revoke(reg, ['protocol:mcp:open']);
    assert.equal(allowed(reg), true, 'the operator grant is still there');
  }],
  ['5. an expired realm grant does not come back through toJSON / fromJSON', (src) => {
    const clock = fakeClock();
    const reg = realRegistry(clock);
    src.grant(reg, ['protocol:mcp:open'], T0 + HOUR);
    clock.advance(2 * HOUR);
    assert.equal(allowed(reg), false, 'expired');
    const restored = PeerRegistry.fromJSON(JSON.parse(JSON.stringify(reg.toJSON())), factories);
    assert.equal(allowed(restored), false, 'still not allowed after a restore');
  }],
];

describe('realm grants through the operator slot (the demonstration: each scenario fails)', () => {
  // SHOW_NAIVE=1 also runs the scenarios raw, to see the failure each one is about.
  if (process.env.SHOW_NAIVE) for (const [name, scenario] of SCENARIOS) it(`RAW ${name}`, () => scenario(sharedSlot));
  for (const [name, scenario] of SCENARIOS) {
    it(`${name}`, () => {
      assert.throws(() => scenario(sharedSlot), AssertionError);
    });
  }
});

describe('realm grants through the realm source (each scenario passes)', () => {
  for (const [name, scenario] of SCENARIOS) {
    it(`${name}`, () => { scenario(realmSource); });
  }
});
