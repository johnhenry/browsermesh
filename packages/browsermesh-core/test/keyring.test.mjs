// Run with: node --import ./test/_setup-globals.mjs --test test/keyring.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  KeyLink,
  SignedKeyLink,
  SignedKeyUnlink,
  KEYLINK_DOMAIN,
  KEYUNLINK_DOMAIN,
  SuccessionPolicy,
  MeshKeyring,
  VALID_RELATIONS,
  encodeBase64url,
  decodeBase64url,
} from '../src/keyring.mjs';
import { PodIdentity } from '../src/identity.mjs';

// ---------------------------------------------------------------------------
// KeyLink
// ---------------------------------------------------------------------------

describe('KeyLink', () => {
  it('constructs with required fields', () => {
    const link = new KeyLink({
      parent: 'root',
      child: 'device1',
      relation: 'device',
    });
    assert.equal(link.parent, 'root');
    assert.equal(link.child, 'device1');
    assert.equal(link.relation, 'device');
    assert.equal(link.scope, null);
    assert.equal(link.expires, null);
    assert.equal(typeof link.created, 'number');
  });

  it('constructs with optional fields', () => {
    const link = new KeyLink({
      parent: 'org',
      child: 'member',
      relation: 'org',
      scope: ['read', 'write'],
      expires: 9999999999999,
      created: 1000,
    });
    assert.deepEqual(link.scope, ['read', 'write']);
    assert.equal(link.expires, 9999999999999);
    assert.equal(link.created, 1000);
  });

  it('defaults scope to null when not provided', () => {
    const link = new KeyLink({ parent: 'a', child: 'b', relation: 'device' });
    assert.equal(link.scope, null);
  });

  it('defaults expires to null when not provided', () => {
    const link = new KeyLink({ parent: 'a', child: 'b', relation: 'device' });
    assert.equal(link.expires, null);
  });

  it('defaults created to Date.now()', () => {
    const before = Date.now();
    const link = new KeyLink({ parent: 'a', child: 'b', relation: 'device' });
    const after = Date.now();
    assert.ok(link.created >= before);
    assert.ok(link.created <= after);
  });

  it('isExpired returns false when no expiration', () => {
    const link = new KeyLink({ parent: 'a', child: 'b', relation: 'device' });
    assert.equal(link.isExpired(), false);
  });

  it('isExpired returns false before expiration', () => {
    const link = new KeyLink({
      parent: 'a',
      child: 'b',
      relation: 'device',
      expires: Date.now() + 100_000,
    });
    assert.equal(link.isExpired(), false);
  });

  it('isExpired returns true at or after expiration', () => {
    const link = new KeyLink({
      parent: 'a',
      child: 'b',
      relation: 'device',
      expires: 1000,
    });
    assert.equal(link.isExpired(1000), true);
    assert.equal(link.isExpired(2000), true);
    assert.equal(link.isExpired(999), false);
  });

  it('isExpired uses Date.now() as default when called without arguments', () => {
    const link = new KeyLink({
      parent: 'a',
      child: 'b',
      relation: 'device',
      expires: 1, // expired long ago
    });
    assert.equal(link.isExpired(), true);
  });

  it('toJSON returns a plain object with all fields', () => {
    const link = new KeyLink({
      parent: 'p',
      child: 'c',
      relation: 'delegate',
      scope: ['s1'],
      expires: 5000,
      created: 1000,
    });
    const json = link.toJSON();
    assert.equal(json.parent, 'p');
    assert.equal(json.child, 'c');
    assert.equal(json.relation, 'delegate');
    assert.deepEqual(json.scope, ['s1']);
    assert.equal(json.expires, 5000);
    assert.equal(json.created, 1000);
    // Should be a plain object, not a KeyLink instance
    assert.equal(json instanceof KeyLink, false);
  });

  it('toJSON round-trips via fromJSON', () => {
    const link = new KeyLink({
      parent: 'p',
      child: 'c',
      relation: 'delegate',
      scope: ['s1'],
      expires: 5000,
      created: 1000,
    });
    const json = link.toJSON();
    const restored = KeyLink.fromJSON(json);
    assert.equal(restored.parent, 'p');
    assert.equal(restored.child, 'c');
    assert.equal(restored.relation, 'delegate');
    assert.deepEqual(restored.scope, ['s1']);
    assert.equal(restored.expires, 5000);
    assert.equal(restored.created, 1000);
  });

  it('fromJSON creates a KeyLink instance', () => {
    const data = {
      parent: 'x',
      child: 'y',
      relation: 'alias',
      scope: null,
      expires: null,
      created: 42,
    };
    const link = KeyLink.fromJSON(data);
    assert.ok(link instanceof KeyLink);
    assert.equal(link.parent, 'x');
    assert.equal(link.child, 'y');
    assert.equal(link.relation, 'alias');
    assert.equal(link.created, 42);
  });
});

// ---------------------------------------------------------------------------
// VALID_RELATIONS
// ---------------------------------------------------------------------------

describe('VALID_RELATIONS', () => {
  it('contains all 5 expected relation types', () => {
    assert.ok(VALID_RELATIONS.includes('device'));
    assert.ok(VALID_RELATIONS.includes('delegate'));
    assert.ok(VALID_RELATIONS.includes('org'));
    assert.ok(VALID_RELATIONS.includes('alias'));
    assert.ok(VALID_RELATIONS.includes('recovery'));
  });

  it('has exactly 5 entries', () => {
    assert.equal(VALID_RELATIONS.length, 5);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(VALID_RELATIONS));
  });
});

// ---------------------------------------------------------------------------
// MeshKeyring
// ---------------------------------------------------------------------------

describe('MeshKeyring', () => {
  let kr;
  beforeEach(() => {
    kr = new MeshKeyring();
  });

  // -- size -----------------------------------------------------------------

  describe('size', () => {
    it('starts at 0', () => {
      assert.equal(kr.size, 0);
    });

    it('increases as links are added', () => {
      kr.link('a', 'b', 'device');
      assert.equal(kr.size, 1);
      kr.link('c', 'd', 'org');
      assert.equal(kr.size, 2);
    });
  });

  // -- link / unlink --------------------------------------------------------

  describe('link', () => {
    it('creates a link and returns it', () => {
      const link = kr.link('root', 'dev1', 'device');
      assert.ok(link instanceof KeyLink);
      assert.equal(link.parent, 'root');
      assert.equal(link.child, 'dev1');
      assert.equal(link.relation, 'device');
      assert.equal(kr.size, 1);
    });

    it('creates a link with scope and expires', () => {
      const link = kr.link('root', 'del', 'delegate', {
        scope: ['read'],
        expires: 9999999999999,
      });
      assert.deepEqual(link.scope, ['read']);
      assert.equal(link.expires, 9999999999999);
    });

    it('throws for invalid relation', () => {
      assert.throws(
        () => kr.link('a', 'b', 'invalid'),
        /Invalid relation: invalid/
      );
    });

    it('throws for self-link', () => {
      assert.throws(
        () => kr.link('a', 'a', 'device'),
        /Cannot link identity to itself/
      );
    });

    it('throws for duplicate link', () => {
      kr.link('a', 'b', 'device');
      assert.throws(
        () => kr.link('a', 'b', 'delegate'),
        /Link already exists/
      );
    });

    it('allows reverse link (different direction)', () => {
      kr.link('a', 'b', 'device');
      const link = kr.link('b', 'a', 'alias');
      assert.equal(link.parent, 'b');
      assert.equal(link.child, 'a');
      assert.equal(kr.size, 2);
    });
  });

  describe('unlink', () => {
    it('removes an existing link', () => {
      kr.link('a', 'b', 'device');
      assert.equal(kr.unlink('a', 'b'), true);
      assert.equal(kr.size, 0);
    });

    it('returns false for non-existing link', () => {
      assert.equal(kr.unlink('x', 'y'), false);
    });

    it('only removes the specified link', () => {
      kr.link('a', 'b', 'device');
      kr.link('a', 'c', 'delegate');
      kr.unlink('a', 'b');
      assert.equal(kr.size, 1);
      const remaining = kr.listLinks();
      assert.equal(remaining[0].child, 'c');
    });
  });

  // -- chain traversal ------------------------------------------------------

  describe('getChain', () => {
    it('returns empty array for root identity', () => {
      kr.link('root', 'child', 'device');
      const chain = kr.getChain('root');
      assert.deepEqual(chain, []);
    });

    it('returns empty array for unknown identity', () => {
      const chain = kr.getChain('nonexistent');
      assert.deepEqual(chain, []);
    });

    it('returns single link for direct child', () => {
      kr.link('root', 'child', 'device');
      const chain = kr.getChain('child');
      assert.equal(chain.length, 1);
      assert.equal(chain[0].parent, 'root');
      assert.equal(chain[0].child, 'child');
    });

    it('returns full chain for deep hierarchy', () => {
      kr.link('root', 'mid', 'org');
      kr.link('mid', 'leaf', 'delegate');
      const chain = kr.getChain('leaf');
      assert.equal(chain.length, 2);
      assert.equal(chain[0].parent, 'mid');
      assert.equal(chain[0].child, 'leaf');
      assert.equal(chain[1].parent, 'root');
      assert.equal(chain[1].child, 'mid');
    });

    it('handles cycles without infinite loop', () => {
      kr.link('a', 'b', 'device');
      kr.link('b', 'c', 'device');
      // Manually force a cycle by re-creating with fromJSON
      const data = kr.toJSON();
      data.links.push({ parent: 'c', child: 'a', relation: 'alias', scope: null, expires: null, created: Date.now() });
      const kr2 = MeshKeyring.fromJSON(data);
      const chain = kr2.getChain('a');
      // Should terminate without looping forever
      assert.ok(chain.length <= 3);
    });
  });

  describe('getChildren', () => {
    it('returns children of a parent', () => {
      kr.link('root', 'c1', 'device');
      kr.link('root', 'c2', 'delegate');
      kr.link('other', 'c3', 'org');
      const children = kr.getChildren('root');
      assert.equal(children.length, 2);
    });

    it('returns empty array for leaf', () => {
      kr.link('root', 'leaf', 'device');
      assert.deepEqual(kr.getChildren('leaf'), []);
    });

    it('returns children with correct parent references', () => {
      kr.link('root', 'c1', 'device');
      kr.link('root', 'c2', 'org');
      const children = kr.getChildren('root');
      for (const c of children) {
        assert.equal(c.parent, 'root');
      }
    });
  });

  describe('getParent', () => {
    it('returns parent link', () => {
      kr.link('root', 'child', 'device');
      const parent = kr.getParent('child');
      assert.ok(parent);
      assert.equal(parent.parent, 'root');
    });

    it('returns null for root', () => {
      kr.link('root', 'child', 'device');
      assert.equal(kr.getParent('root'), null);
    });

    it('returns null for unknown identity', () => {
      assert.equal(kr.getParent('unknown'), null);
    });
  });

  describe('isDescendant', () => {
    it('returns true for direct child', () => {
      kr.link('root', 'child', 'device');
      assert.equal(kr.isDescendant('root', 'child'), true);
    });

    it('returns true for transitive descendant', () => {
      kr.link('root', 'mid', 'org');
      kr.link('mid', 'leaf', 'delegate');
      assert.equal(kr.isDescendant('root', 'leaf'), true);
    });

    it('returns false for unrelated identities', () => {
      kr.link('a', 'b', 'device');
      kr.link('c', 'd', 'device');
      assert.equal(kr.isDescendant('a', 'd'), false);
    });

    it('returns false for reverse direction', () => {
      kr.link('root', 'child', 'device');
      assert.equal(kr.isDescendant('child', 'root'), false);
    });

    it('returns false when descendant equals ancestor', () => {
      kr.link('root', 'child', 'device');
      assert.equal(kr.isDescendant('root', 'root'), false);
    });
  });

  describe('resolveAuthority', () => {
    it('returns root for leaf identity', () => {
      kr.link('root', 'mid', 'org');
      kr.link('mid', 'leaf', 'delegate');
      assert.equal(kr.resolveAuthority('leaf'), 'root');
    });

    it('returns self for root identity', () => {
      kr.link('root', 'child', 'device');
      assert.equal(kr.resolveAuthority('root'), 'root');
    });

    it('returns self for isolated identity', () => {
      assert.equal(kr.resolveAuthority('standalone'), 'standalone');
    });

    it('returns root for mid-level identity', () => {
      kr.link('root', 'mid', 'org');
      kr.link('mid', 'leaf', 'delegate');
      assert.equal(kr.resolveAuthority('mid'), 'root');
    });
  });

  // -- verifyChain ----------------------------------------------------------

  describe('verifyChain', () => {
    it('returns valid for non-expired chain', () => {
      kr.link('root', 'child', 'device');
      const chain = kr.getChain('child');
      const result = kr.verifyChain(chain);
      assert.equal(result.valid, true);
      assert.equal(result.depth, 1);
      assert.deepEqual(result.expired, []);
    });

    it('returns invalid when a link is expired', () => {
      kr.link('root', 'child', 'device', { expires: 1000 });
      const chain = kr.getChain('child');
      const result = kr.verifyChain(chain, 2000);
      assert.equal(result.valid, false);
      assert.equal(result.expired.length, 1);
    });

    it('returns valid for empty chain', () => {
      const result = kr.verifyChain([]);
      assert.equal(result.valid, true);
      assert.equal(result.depth, 0);
    });

    it('detects expired link in the middle of a multi-link chain', () => {
      kr.link('root', 'mid', 'org', { expires: 500 });
      kr.link('mid', 'leaf', 'delegate');
      const chain = kr.getChain('leaf');
      const result = kr.verifyChain(chain, 1000);
      assert.equal(result.valid, false);
      assert.equal(result.depth, 2);
      assert.equal(result.expired.length, 1);
      assert.equal(result.expired[0].child, 'mid');
    });

    it('reports multiple expired links in same chain', () => {
      kr.link('root', 'mid', 'org', { expires: 500 });
      kr.link('mid', 'leaf', 'delegate', { expires: 600 });
      const chain = kr.getChain('leaf');
      const result = kr.verifyChain(chain, 1000);
      assert.equal(result.valid, false);
      assert.equal(result.expired.length, 2);
    });
  });

  // -- pruneExpired ---------------------------------------------------------

  describe('pruneExpired', () => {
    it('removes expired links', () => {
      kr.link('a', 'b', 'device', { expires: 1000 });
      kr.link('c', 'd', 'device');
      const pruned = kr.pruneExpired(2000);
      assert.equal(pruned, 1);
      assert.equal(kr.size, 1);
    });

    it('returns 0 when nothing expired', () => {
      kr.link('a', 'b', 'device');
      assert.equal(kr.pruneExpired(), 0);
    });

    it('removes all links when all are expired', () => {
      kr.link('a', 'b', 'device', { expires: 100 });
      kr.link('c', 'd', 'org', { expires: 200 });
      kr.link('e', 'f', 'alias', { expires: 300 });
      const pruned = kr.pruneExpired(1000);
      assert.equal(pruned, 3);
      assert.equal(kr.size, 0);
    });

    it('returns 0 on empty keyring', () => {
      assert.equal(kr.pruneExpired(), 0);
    });
  });

  // -- listLinks ------------------------------------------------------------

  describe('listLinks', () => {
    it('returns a copy of all links', () => {
      kr.link('a', 'b', 'device');
      kr.link('c', 'd', 'org');
      const links = kr.listLinks();
      assert.equal(links.length, 2);
      // Modifying returned array should not affect internal state
      links.pop();
      assert.equal(kr.size, 2);
    });

    it('returns empty array for empty keyring', () => {
      assert.deepEqual(kr.listLinks(), []);
    });
  });

  // -- serialization --------------------------------------------------------

  describe('toJSON / fromJSON', () => {
    it('round-trips all links', () => {
      kr.link('root', 'dev', 'device');
      kr.link('root', 'del', 'delegate', { scope: ['x'], expires: 5000 });
      const json = kr.toJSON();
      const kr2 = MeshKeyring.fromJSON(json);
      assert.equal(kr2.size, 2);
      const links = kr2.listLinks();
      const devLink = links.find((l) => l.child === 'dev');
      assert.ok(devLink);
      assert.equal(devLink.relation, 'device');
      const delLink = links.find((l) => l.child === 'del');
      assert.ok(delLink);
      assert.deepEqual(delLink.scope, ['x']);
      assert.equal(delLink.expires, 5000);
    });

    it('fromJSON with empty array', () => {
      const kr2 = MeshKeyring.fromJSON([]);
      assert.equal(kr2.size, 0);
    });

    it('toJSON returns { v: 3, namespace, links, revocations } of plain objects', () => {
      kr.link('a', 'b', 'device');
      const json = kr.toJSON();
      assert.equal(json.v, 3);
      assert.equal(json.namespace, null);
      assert.deepEqual(json.revocations, []);
      assert.ok(Array.isArray(json.links));
      assert.equal(json.links.length, 1);
      assert.equal(json.links[0].parent, 'a');
      assert.equal(json.links[0].child, 'b');
      assert.equal(json.links[0] instanceof KeyLink, false);
    });

    it('fromJSON still reads the pre-0.10 bare array form', () => {
      const kr2 = MeshKeyring.fromJSON([
        { parent: 'a', child: 'b', relation: 'device', scope: null, expires: null, created: 1 },
      ]);
      assert.equal(kr2.size, 1);
      assert.equal(kr2.resolveAuthority('b'), 'a');
    });

    it('fromJSON preserves functional behavior', () => {
      kr.link('root', 'mid', 'org');
      kr.link('mid', 'leaf', 'delegate');
      const kr2 = MeshKeyring.fromJSON(kr.toJSON());
      // Chain traversal should work on deserialized keyring
      assert.equal(kr2.resolveAuthority('leaf'), 'root');
      assert.equal(kr2.isDescendant('root', 'leaf'), true);
      assert.equal(kr2.getChildren('root').length, 1);
    });
  });

  // -- addVerifiedLink ----------------------------------------------------

  describe('addVerifiedLink', () => {
    it('adds a signed link after verifying signatures', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();

      const signedLink = await SignedKeyLink.create(parent, child, 'device');
      await kr.addVerifiedLink(signedLink, parent.keyPair.publicKey, child.keyPair.publicKey);

      assert.equal(kr.size, 1);
      const links = kr.listLinks();
      assert.equal(links[0].parent, parent.podId);
      assert.equal(links[0].child, child.podId);
    });

    it('rejects non-SignedKeyLink', async () => {
      const link = new KeyLink({ parent: 'a', child: 'b', relation: 'device' });
      await assert.rejects(
        () => kr.addVerifiedLink(link, null, null),
        /Expected a SignedKeyLink/
      );
    });

    it('rejects invalid relation', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();
      const link = new SignedKeyLink({
        parent: parent.podId,
        child: child.podId,
        relation: 'invalid',
      });
      await assert.rejects(
        () => kr.addVerifiedLink(link, parent.keyPair.publicKey, child.keyPair.publicKey),
        /Invalid relation/
      );
    });

    it('rejects self-link', async () => {
      const identity = await PodIdentity.generate();
      const link = new SignedKeyLink({
        parent: identity.podId,
        child: identity.podId,
        relation: 'device',
        parentSignature: new Uint8Array(64),
        childSignature: new Uint8Array(64),
      });
      await assert.rejects(
        () => kr.addVerifiedLink(link, identity.keyPair.publicKey, identity.keyPair.publicKey),
        /Cannot link identity to itself/
      );
    });

    it('rejects tampered signatures', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();

      const signedLink = await SignedKeyLink.create(parent, child, 'device');
      // Tamper with parent signature
      signedLink.parentSignature[0] ^= 0xff;

      await assert.rejects(
        () => kr.addVerifiedLink(signedLink, parent.keyPair.publicKey, child.keyPair.publicKey),
        /Signature verification failed/
      );
    });

    it('rejects duplicate links', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();

      const link1 = await SignedKeyLink.create(parent, child, 'device');
      await kr.addVerifiedLink(link1, parent.keyPair.publicKey, child.keyPair.publicKey);

      const link2 = await SignedKeyLink.create(parent, child, 'alias');
      await assert.rejects(
        () => kr.addVerifiedLink(link2, parent.keyPair.publicKey, child.keyPair.publicKey),
        /Link already exists/
      );
    });
  });

  // -- verifyCryptoChain --------------------------------------------------

  describe('verifyCryptoChain', () => {
    it('verifies a valid signed chain', async () => {
      const root = await PodIdentity.generate();
      const mid = await PodIdentity.generate();
      const leaf = await PodIdentity.generate();

      const link1 = await SignedKeyLink.create(root, mid, 'org');
      const link2 = await SignedKeyLink.create(mid, leaf, 'delegate');
      await kr.addVerifiedLink(link1, root.keyPair.publicKey, mid.keyPair.publicKey);
      await kr.addVerifiedLink(link2, mid.keyPair.publicKey, leaf.keyPair.publicKey);

      const keyMap = new Map([
        [root.podId, root.keyPair.publicKey],
        [mid.podId, mid.keyPair.publicKey],
        [leaf.podId, leaf.keyPair.publicKey],
      ]);

      const result = await kr.verifyCryptoChain(leaf.podId, root.podId, (id) => keyMap.get(id));
      assert.equal(result.valid, true);
      assert.equal(result.chain.length, 2);
    });

    it('returns invalid when no path exists', async () => {
      const a = await PodIdentity.generate();
      const b = await PodIdentity.generate();

      // No links between a and b
      const result = await kr.verifyCryptoChain(a.podId, b.podId, () => null);
      assert.equal(result.valid, false);
      assert.equal(result.brokenAt, 'no-path');
    });

    it('returns invalid for expired links', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();

      // The expiry has to be present when the link is signed. Bolting it on
      // afterwards no longer verifies — see 'SignedKeyLink signature coverage'.
      const link = await SignedKeyLink.create(parent, child, 'device', { expires: 1 });
      await kr.addVerifiedLink(link, parent.keyPair.publicKey, child.keyPair.publicKey);

      const keyMap = new Map([
        [parent.podId, parent.keyPair.publicKey],
        [child.podId, child.keyPair.publicKey],
      ]);

      const result = await kr.verifyCryptoChain(child.podId, parent.podId, (id) => keyMap.get(id));
      assert.equal(result.valid, false);
      assert.equal(result.brokenAt, child.podId);
    });

    it('refuses unsigned links in the chain by default', async () => {
      kr.link('root', 'mid', 'org');
      const result = await kr.verifyCryptoChain('mid', 'root', () => null);
      assert.equal(result.valid, false);
      assert.equal(result.brokenAt, 'mid');
      assert.equal(result.reason, 'unsigned');
    });

    it('skips unsigned links only with requireSigned: false', async () => {
      kr.link('root', 'mid', 'org');
      const result = await kr.verifyCryptoChain('mid', 'root', () => null, { requireSigned: false });
      assert.equal(result.valid, true);
      assert.equal(result.chain.length, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// SignedKeyLink
// ---------------------------------------------------------------------------

describe('SignedKeyLink', () => {
  it('extends KeyLink', () => {
    const link = new SignedKeyLink({
      parent: 'p',
      child: 'c',
      relation: 'device',
    });
    assert.ok(link instanceof KeyLink);
    assert.ok(link instanceof SignedKeyLink);
  });

  it('stores parent and child signatures', () => {
    const sig = new Uint8Array([1, 2, 3]);
    const link = new SignedKeyLink({
      parent: 'p',
      child: 'c',
      relation: 'device',
      parentSignature: sig,
      childSignature: sig,
    });
    assert.deepEqual(link.parentSignature, sig);
    assert.deepEqual(link.childSignature, sig);
  });

  it('defaults signatures to null', () => {
    const link = new SignedKeyLink({
      parent: 'p',
      child: 'c',
      relation: 'device',
    });
    assert.equal(link.parentSignature, null);
    assert.equal(link.childSignature, null);
  });

  it('signedPayload generates canonical bytes covering every asserted field', () => {
    const link = new SignedKeyLink({
      parent: 'PARENT',
      child: 'CHILD',
      relation: 'device',
      created: 12345,
    });
    const str = new TextDecoder().decode(link.signedPayload);
    assert.equal(
      str,
      'browsermesh/keylink/v3\n' +
        '{"child":"CHILD","created":12345,"expires":null,"namespace":null,"parent":"PARENT","relation":"device","scope":null}'
    );
  });

  it('signedPayload changes when scope or expires changes', () => {
    const base = {
      parent: 'PARENT',
      child: 'CHILD',
      relation: 'delegate',
      created: 12345,
    };
    const decode = (l) => new TextDecoder().decode(l.signedPayload);

    const plain = decode(new SignedKeyLink({ ...base }));
    const scoped = decode(new SignedKeyLink({ ...base, scope: ['read'] }));
    const wider = decode(new SignedKeyLink({ ...base, scope: ['read', 'admin'] }));
    const dated = decode(new SignedKeyLink({ ...base, expires: 999 }));

    assert.notEqual(plain, scoped);
    assert.notEqual(scoped, wider);
    assert.notEqual(plain, dated);
  });

  it('signedPayload does not confuse a scope entry containing the legacy delimiter', () => {
    const base = { parent: 'P', child: 'C', relation: 'delegate', created: 1 };
    const joined = new SignedKeyLink({ ...base, scope: ['a|b'] });
    const split = new SignedKeyLink({ ...base, scope: ['a', 'b'] });
    assert.notDeepEqual(joined.signedPayload, split.signedPayload);
  });

  it('signedPayload binds the namespace', () => {
    const base = { parent: 'P', child: 'C', relation: 'device', created: 1 };
    const a = new SignedKeyLink({ ...base, namespace: 'acct-a' });
    const b = new SignedKeyLink({ ...base, namespace: 'acct-b' });
    const none = new SignedKeyLink({ ...base });
    assert.notDeepEqual(a.signedPayload, b.signedPayload);
    assert.notDeepEqual(a.signedPayload, none.signedPayload);
  });

  it('no longer exposes the v1 payload', () => {
    const link = new SignedKeyLink({ parent: 'P', child: 'C', relation: 'device', created: 1 });
    assert.equal('legacySignedPayload' in link, false);
  });

  it('legacyV2SignedPayload keeps the pre-0.10 form (verification only)', () => {
    const link = new SignedKeyLink({ parent: 'P', child: 'C', relation: 'device', created: 1 });
    assert.equal(
      new TextDecoder().decode(link.legacyV2SignedPayload),
      '{"v":2,"parent":"P","child":"C","relation":"device","scope":null,"expires":null,"created":1}'
    );
  });

  describe('create', () => {
    it('creates a signed link between two PodIdentities', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();

      const link = await SignedKeyLink.create(parent, child, 'device');
      assert.equal(link.parent, parent.podId);
      assert.equal(link.child, child.podId);
      assert.equal(link.relation, 'device');
      assert.ok(link.parentSignature instanceof Uint8Array);
      assert.ok(link.childSignature instanceof Uint8Array);
      assert.ok(link.parentSignature.length > 0);
      assert.ok(link.childSignature.length > 0);
    });

    it('creates with scope and expires', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();

      const link = await SignedKeyLink.create(parent, child, 'delegate', {
        scope: ['read'],
        expires: 99999999999,
      });
      assert.deepEqual(link.scope, ['read']);
      assert.equal(link.expires, 99999999999);
    });
  });

  describe('verify', () => {
    it('verifyParent succeeds with correct key', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();
      const link = await SignedKeyLink.create(parent, child, 'device');

      const ok = await link.verifyParent(parent.keyPair.publicKey);
      assert.equal(ok, true);
    });

    it('verifyParent fails with wrong key', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();
      const wrong = await PodIdentity.generate();
      const link = await SignedKeyLink.create(parent, child, 'device');

      const ok = await link.verifyParent(wrong.keyPair.publicKey);
      assert.equal(ok, false);
    });

    it('verifyParent returns false when no signature', async () => {
      const link = new SignedKeyLink({
        parent: 'p',
        child: 'c',
        relation: 'device',
      });
      const id = await PodIdentity.generate();
      const ok = await link.verifyParent(id.keyPair.publicKey);
      assert.equal(ok, false);
    });

    it('verifyChild succeeds with correct key', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();
      const link = await SignedKeyLink.create(parent, child, 'device');

      const ok = await link.verifyChild(child.keyPair.publicKey);
      assert.equal(ok, true);
    });

    it('verifyChild fails with wrong key', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();
      const wrong = await PodIdentity.generate();
      const link = await SignedKeyLink.create(parent, child, 'device');

      const ok = await link.verifyChild(wrong.keyPair.publicKey);
      assert.equal(ok, false);
    });

    it('verifyBoth succeeds with correct keys', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();
      const link = await SignedKeyLink.create(parent, child, 'device');

      const ok = await link.verifyBoth(parent.keyPair.publicKey, child.keyPair.publicKey);
      assert.equal(ok, true);
    });

    it('verifyBoth fails if parent key wrong', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();
      const wrong = await PodIdentity.generate();
      const link = await SignedKeyLink.create(parent, child, 'device');

      const ok = await link.verifyBoth(wrong.keyPair.publicKey, child.keyPair.publicKey);
      assert.equal(ok, false);
    });

    it('verifyBoth fails if child key wrong', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();
      const wrong = await PodIdentity.generate();
      const link = await SignedKeyLink.create(parent, child, 'device');

      const ok = await link.verifyBoth(parent.keyPair.publicKey, wrong.keyPair.publicKey);
      assert.equal(ok, false);
    });
  });

  describe('toJSON / fromJSON', () => {
    it('round-trips signatures as base64url', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();
      const link = await SignedKeyLink.create(parent, child, 'device');

      const json = link.toJSON();
      assert.equal(json.signed, true);
      assert.equal(typeof json.parentSignature, 'string');
      assert.equal(typeof json.childSignature, 'string');

      const restored = SignedKeyLink.fromJSON(json);
      assert.ok(restored instanceof SignedKeyLink);
      assert.equal(restored.parent, parent.podId);
      assert.equal(restored.child, child.podId);
      assert.ok(restored.parentSignature instanceof Uint8Array);
      assert.ok(restored.childSignature instanceof Uint8Array);

      // Verify signatures still valid after round-trip
      const ok = await restored.verifyBoth(parent.keyPair.publicKey, child.keyPair.publicKey);
      assert.equal(ok, true);
    });

    it('handles null signatures in JSON', () => {
      const json = {
        parent: 'p',
        child: 'c',
        relation: 'device',
        scope: null,
        expires: null,
        created: 1000,
        parentSignature: null,
        childSignature: null,
        signed: true,
      };
      const link = SignedKeyLink.fromJSON(json);
      assert.equal(link.parentSignature, null);
      assert.equal(link.childSignature, null);
    });
  });
});

// ---------------------------------------------------------------------------
// SuccessionPolicy
// ---------------------------------------------------------------------------

describe('SuccessionPolicy', () => {
  it('constructor validates required fields', () => {
    assert.throws(() => new SuccessionPolicy({
      successorId: 'b',
      inactivityThresholdMs: 1000,
    }), /primaryId is required/);

    assert.throws(() => new SuccessionPolicy({
      primaryId: 'a',
      inactivityThresholdMs: 1000,
    }), /successorId is required/);

    assert.throws(() => new SuccessionPolicy({
      primaryId: 'a',
      successorId: 'b',
      inactivityThresholdMs: -1,
    }), /inactivityThresholdMs must be a positive number/);

    assert.throws(() => new SuccessionPolicy({
      primaryId: 'a',
      successorId: 'b',
      inactivityThresholdMs: 1000,
      action: 'destroy',
    }), /Invalid action/);
  });

  it('isArmed returns true when inactive past threshold', () => {
    const policy = new SuccessionPolicy({
      primaryId: 'a',
      successorId: 'b',
      inactivityThresholdMs: 5000,
    });
    // Last active 10000ms ago, threshold is 5000ms -> armed
    const now = 20000;
    const lastActive = 10000;
    assert.equal(policy.isArmed(now, lastActive), true);
    // No activity ever -> armed
    assert.equal(policy.isArmed(now, undefined), true);
  });

  it('isArmed returns false when active within threshold', () => {
    const policy = new SuccessionPolicy({
      primaryId: 'a',
      successorId: 'b',
      inactivityThresholdMs: 5000,
    });
    // Last active 2000ms ago, threshold is 5000ms -> not armed
    const now = 20000;
    const lastActive = 18000;
    assert.equal(policy.isArmed(now, lastActive), false);
  });

  it('toJSON / fromJSON round-trip', () => {
    const policy = new SuccessionPolicy({
      primaryId: 'pod-alpha',
      successorId: 'pod-beta',
      inactivityThresholdMs: 60000,
      action: 'revoke',
    });
    const json = policy.toJSON();
    assert.equal(json.primaryId, 'pod-alpha');
    assert.equal(json.successorId, 'pod-beta');
    assert.equal(json.inactivityThresholdMs, 60000);
    assert.equal(json.action, 'revoke');
    assert.equal(typeof json.createdAt, 'number');

    const restored = SuccessionPolicy.fromJSON(json);
    assert.equal(restored.primaryId, 'pod-alpha');
    assert.equal(restored.successorId, 'pod-beta');
    assert.equal(restored.inactivityThresholdMs, 60000);
    assert.equal(restored.action, 'revoke');
    assert.equal(restored.createdAt, json.createdAt);
  });
});

// ---------------------------------------------------------------------------
// MeshKeyring Succession
// ---------------------------------------------------------------------------

describe('MeshKeyring Succession', () => {
  let kr;
  beforeEach(() => {
    kr = new MeshKeyring();
  });

  it('setSuccessor creates policy', () => {
    const policy = kr.setSuccessor('primary', 'backup', 30000, 'transfer');
    assert.ok(policy instanceof SuccessionPolicy);
    assert.equal(policy.primaryId, 'primary');
    assert.equal(policy.successorId, 'backup');
    assert.equal(policy.inactivityThresholdMs, 30000);
    assert.equal(policy.action, 'transfer');
  });

  it('removeSuccessor removes policy', () => {
    kr.setSuccessor('primary', 'backup', 30000);
    assert.equal(kr.removeSuccessor('primary'), true);
    // Removing again returns false
    assert.equal(kr.removeSuccessor('primary'), false);
  });

  it('recordActivity updates timestamp', () => {
    kr.setSuccessor('primary', 'backup', 5000);
    // No activity recorded yet -> armed
    const armed1 = kr.checkSuccession(Date.now());
    assert.equal(armed1.length, 1);

    // Record activity -> no longer armed
    kr.recordActivity('primary');
    const armed2 = kr.checkSuccession(Date.now());
    assert.equal(armed2.length, 0);
  });

  it('checkSuccession returns armed policies', () => {
    kr.setSuccessor('podA', 'backupA', 5000);
    kr.setSuccessor('podB', 'backupB', 10000);

    // Both have no activity -> both armed
    const armed = kr.checkSuccession(Date.now());
    assert.equal(armed.length, 2);

    // Record activity for podA, check at a time within threshold
    kr.recordActivity('podA');
    const now = Date.now();
    const armed2 = kr.checkSuccession(now);
    // podA is active (just recorded), podB has no activity -> only podB armed
    assert.equal(armed2.length, 1);
    assert.equal(armed2[0].policy.primaryId, 'podB');
  });

  it('executeSuccession with transfer + localOnly re-links children (unsigned)', async () => {
    // Build: primary -> child1, primary -> child2
    kr.link('primary', 'child1', 'device');
    kr.link('primary', 'child2', 'delegate');
    kr.setSuccessor('primary', 'backup', 5000, 'transfer');

    const result = await kr.executeSuccession('primary', { localOnly: true });
    assert.equal(result.action, 'transfer');
    assert.equal(result.primaryId, 'primary');
    assert.equal(result.successorId, 'backup');
    assert.equal(result.affected, 2);

    // Old links should be gone
    assert.deepEqual(kr.getChildren('primary'), []);

    // Children should now be under backup
    const newChildren = kr.getChildren('backup');
    assert.equal(newChildren.length, 2);
    const childIds = newChildren.map((l) => l.child).sort();
    assert.deepEqual(childIds, ['child1', 'child2']);

    // Policy should be removed after execution
    assert.equal(kr.removeSuccessor('primary'), false);
  });

  it('executeSuccession with revoke removes all children', async () => {
    kr.link('primary', 'child1', 'device');
    kr.link('primary', 'child2', 'org');
    kr.link('primary', 'child3', 'alias');
    kr.setSuccessor('primary', 'backup', 5000, 'revoke');

    const result = await kr.executeSuccession('primary');
    assert.equal(result.action, 'revoke');
    assert.equal(result.affected, 3);

    // All children removed
    assert.deepEqual(kr.getChildren('primary'), []);

    // No links transferred to backup
    assert.deepEqual(kr.getChildren('backup'), []);

    // Policy should be removed after execution
    assert.equal(kr.removeSuccessor('primary'), false);
  });
});

// ---------------------------------------------------------------------------
// Signature coverage: scope and expiry must be signed
//
// Regression for the case where SignedKeyLink signed only
// `parent|child|relation|created`. Everything the delegation actually limits
// — its scope and its expiry — sat outside the signature, so any holder of a
// link could widen it and push the expiry out without breaking either
// signature, and MeshKeyring.addVerifiedLink() would accept the result.
// ---------------------------------------------------------------------------

describe('SignedKeyLink signature coverage', () => {
  /** Round-trip a link through the wire form, mutating it on the way. */
  const tamperOnTheWire = (link, changes) =>
    SignedKeyLink.fromJSON({ ...link.toJSON(), ...changes });

  it('rejects a link whose scope was widened after signing', async () => {
    const parent = await PodIdentity.generate();
    const child = await PodIdentity.generate();
    const link = await SignedKeyLink.create(parent, child, 'delegate', {
      scope: ['read'],
    });
    assert.equal(
      await link.verifyBoth(parent.keyPair.publicKey, child.keyPair.publicKey),
      true,
      'the link as issued must verify'
    );

    const forged = tamperOnTheWire(link, { scope: ['read', 'write', 'admin'] });
    assert.deepEqual(forged.scope, ['read', 'write', 'admin']);
    assert.equal(await forged.verifyParent(parent.keyPair.publicKey), false);
    assert.equal(await forged.verifyChild(child.keyPair.publicKey), false);
    assert.equal(
      await forged.verifyBoth(parent.keyPair.publicKey, child.keyPair.publicKey),
      false
    );
  });

  it('rejects a link whose scope was removed after signing', async () => {
    const parent = await PodIdentity.generate();
    const child = await PodIdentity.generate();
    const link = await SignedKeyLink.create(parent, child, 'delegate', {
      scope: ['read'],
    });

    // Dropping the scope entirely is the widest widening there is: it also
    // makes the link look like one that never had a scope, which is exactly
    // the shape the legacy fallback accepts.
    const forged = tamperOnTheWire(link, { scope: null });
    assert.equal(
      await forged.verifyBoth(parent.keyPair.publicKey, child.keyPair.publicKey),
      false
    );
  });

  it('rejects an expired link whose expiry was pushed out after signing', async () => {
    const parent = await PodIdentity.generate();
    const child = await PodIdentity.generate();
    const link = await SignedKeyLink.create(parent, child, 'delegate', {
      expires: Date.now() - 1000,
    });
    assert.equal(link.isExpired(), true);

    const forged = tamperOnTheWire(link, { expires: Date.now() + 86_400_000 });
    assert.equal(forged.isExpired(), false, 'the tampered link looks live');
    assert.equal(
      await forged.verifyBoth(parent.keyPair.publicKey, child.keyPair.publicKey),
      false,
      'but it must not verify'
    );
  });

  it('rejects a link given an expiry it never had', async () => {
    const parent = await PodIdentity.generate();
    const child = await PodIdentity.generate();
    const link = await SignedKeyLink.create(parent, child, 'device');

    const forged = tamperOnTheWire(link, { expires: Date.now() + 86_400_000 });
    assert.equal(
      await forged.verifyBoth(parent.keyPair.publicKey, child.keyPair.publicKey),
      false
    );
  });

  it('MeshKeyring.addVerifiedLink refuses a widened link', async () => {
    const parent = await PodIdentity.generate();
    const child = await PodIdentity.generate();
    const link = await SignedKeyLink.create(parent, child, 'delegate', {
      scope: ['read'],
      expires: Date.now() - 1000,
    });

    const forged = tamperOnTheWire(link, {
      scope: ['read', 'write', 'admin'],
      expires: Date.now() + 86_400_000,
    });

    const kr = new MeshKeyring();
    await assert.rejects(
      () => kr.addVerifiedLink(forged, parent.keyPair.publicKey, child.keyPair.publicKey),
      /Signature verification failed/
    );
  });

  it('verifyCryptoChain refuses a chain containing a widened link', async () => {
    const parent = await PodIdentity.generate();
    const child = await PodIdentity.generate();
    const link = await SignedKeyLink.create(parent, child, 'delegate', {
      scope: ['read'],
    });
    const forged = tamperOnTheWire(link, { scope: ['admin'] });

    const kr = new MeshKeyring();
    // Reach past addVerifiedLink so the chain walker is what is under test.
    await kr.addVerifiedLink(link, parent.keyPair.publicKey, child.keyPair.publicKey);
    kr.unlink(parent.podId, child.podId);
    await assert.rejects(
      () => kr.addVerifiedLink(forged, parent.keyPair.publicKey, child.keyPair.publicKey),
      /Signature verification failed/
    );

    // And if a forged link is smuggled in by some other route, the chain
    // walker must still catch it.
    const getPublicKey = async (id) =>
      id === parent.podId ? parent.keyPair.publicKey : child.keyPair.publicKey;
    await kr.addVerifiedLink(link, parent.keyPair.publicKey, child.keyPair.publicKey);
    link.scope = ['admin'];
    const res = await kr.verifyCryptoChain(child.podId, parent.podId, getPublicKey);
    assert.equal(res.valid, false);
    assert.equal(res.brokenAt, child.podId);
  });

  describe('legacy signatures', () => {
    /** Sign arbitrary bytes the way older code did. */
    const signWith = async (link, payload, parentIdentity, childIdentity) => {
      link.parentSignature = await parentIdentity.sign(payload);
      link.childSignature = await childIdentity.sign(payload);
      return link;
    };
    const v1Payload = (l) =>
      new TextEncoder().encode(`${l.parent}|${l.child}|${l.relation}|${l.created}`);

    it('refuses a v1 (a|b|c|d) signature, even with acceptLegacyV2', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();
      const link = new SignedKeyLink({
        parent: parent.podId, child: child.podId, relation: 'device', created: 1_700_000_000_000,
      });
      await signWith(link, v1Payload(link), parent, child);

      assert.equal(await link.verifyBoth(parent.keyPair.publicKey, child.keyPair.publicKey), false);
      assert.equal(
        await link.verifyBoth(parent.keyPair.publicKey, child.keyPair.publicKey, { acceptLegacyV2: true }),
        false
      );
      assert.equal(await link.signatureVersion(parent.keyPair.publicKey, child.keyPair.publicKey), null);
    });

    it('refuses a v2 signature by default and accepts it only with acceptLegacyV2', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();
      const link = new SignedKeyLink({
        parent: parent.podId, child: child.podId, relation: 'delegate', scope: ['read'], created: 1,
      });
      await signWith(link, link.legacyV2SignedPayload, parent, child);

      const pp = parent.keyPair.publicKey;
      const cp = child.keyPair.publicKey;
      assert.equal(await link.verifyBoth(pp, cp), false);
      assert.equal(await link.verifyBoth(pp, cp, { acceptLegacyV2: true }), true);
      assert.equal(await link.signatureVersion(pp, cp), 2);

      // Keyring default refuses; opted-in keyring accepts.
      await assert.rejects(() => new MeshKeyring().addVerifiedLink(link, pp, cp), /Signature verification failed/);
      const migrating = new MeshKeyring({ acceptLegacyV2: true });
      await migrating.addVerifiedLink(link, pp, cp);
      const getPublicKey = (id) => (id === parent.podId ? pp : cp);
      assert.equal((await migrating.verifyCryptoChain(child.podId, parent.podId, getPublicKey)).valid, true);
      assert.equal(
        (await migrating.verifyCryptoChain(child.podId, parent.podId, getPublicKey, { acceptLegacyV2: false })).valid,
        false
      );
    });

    it('never accepts a v2 signature for a namespaced link', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();
      const link = new SignedKeyLink({
        parent: parent.podId, child: child.podId, relation: 'device', created: 1,
      });
      await signWith(link, link.legacyV2SignedPayload, parent, child);
      // v2 never covered a namespace, so stamping one on must not verify.
      const forged = SignedKeyLink.fromJSON({ ...link.toJSON(), namespace: 'acct-a' });
      assert.equal(
        await forged.verifyBoth(parent.keyPair.publicKey, child.keyPair.publicKey, { acceptLegacyV2: true }),
        false
      );
    });

    it('resign() migrates a v2 link to v3, keeping created', async () => {
      const parent = await PodIdentity.generate();
      const child = await PodIdentity.generate();
      const link = new SignedKeyLink({
        parent: parent.podId, child: child.podId, relation: 'delegate',
        scope: ['read'], expires: 9_999_999_999_999, created: 42,
      });
      await signWith(link, link.legacyV2SignedPayload, parent, child);

      const migrated = await link.resign(parent, child, { namespace: 'acct-a' });
      assert.equal(migrated.created, 42);
      assert.deepEqual(migrated.scope, ['read']);
      assert.equal(migrated.namespace, 'acct-a');
      assert.equal(
        await migrated.signatureVersion(parent.keyPair.publicKey, child.keyPair.publicKey),
        3
      );
      const other = await PodIdentity.generate();
      await assert.rejects(() => link.resign(other, child), /identities/);
    });
  });
});

/* ── A restored keyring still has to prove itself (#33) ──────────────── */

describe('MeshKeyring.fromJSON preserves signed links', () => {
  /*
   * `fromJSON` revived every link through `KeyLink.fromJSON`, which returns a
   * plain KeyLink. `verifyCryptoChain` only checks a signature
   * `if (link instanceof SignedKeyLink)`, so after a round trip that branch
   * never ran: the function returned `valid: true` having called
   * `getPublicKey` zero times.
   *
   * The signatures survived serialisation the whole time. Only the class was
   * lost, and the class is what the check keys on -- so a keyring that had
   * been persisted, sent to a peer, or reloaded verified without any
   * cryptography whatsoever.
   */
  it('revives a signed link as a SignedKeyLink, not a bare KeyLink', () => {
    const signed = new SignedKeyLink({
      parent: 'root', child: 'mid', relation: 'org',
      parentSignature: new Uint8Array([1, 2, 3]),
      childSignature: new Uint8Array([4, 5, 6]),
    });

    const revived = MeshKeyring.fromJSON([signed.toJSON()]);
    const links = revived.toJSON().links;
    assert.equal(links.length, 1, 'the link survived the round trip');
    assert.ok(revived.listLinks()[0] instanceof SignedKeyLink);
    assert.ok(links[0].parentSignature, 'and kept its signatures');
  });

  it('actually checks signatures on a restored chain', async () => {
    const signed = new SignedKeyLink({
      parent: 'root', child: 'mid', relation: 'org',
      parentSignature: new Uint8Array([1, 2, 3]),
      childSignature: new Uint8Array([4, 5, 6]),
    });
    const revived = MeshKeyring.fromJSON([signed.toJSON()]);

    let publicKeyLookups = 0;
    const result = await revived.verifyCryptoChain('mid', 'root', async () => {
      publicKeyLookups += 1;
      return new Uint8Array(32);
    });

    // The measurement that mattered: this was 0, and the verdict was `true`.
    assert.ok(publicKeyLookups > 0, 'a restored chain consults the public keys');
    assert.equal(result.valid, false, 'and refuses signatures that do not verify');
  });
});

/* ── p2pws#302: hardening of chain verification, context binding,
 *    signed revocation and succession ─────────────────────────────────── */

/** A few identities plus a key lookup. */
async function makeIds(n) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(await PodIdentity.generate());
  const keys = new Map(ids.map((id) => [id.podId, id.keyPair.publicKey]));
  return { ids, getPublicKey: async (podId) => keys.get(podId) };
}

describe('verifyCryptoChain refuses forged unsigned edges (#302 item 1)', () => {
  it('a forged unsigned edge spliced into a signed chain does not verify', async () => {
    const { ids: [root, mid, attacker], getPublicKey } = await makeIds(3);
    const kr = new MeshKeyring();
    await kr.addVerifiedLink(await SignedKeyLink.create(root, mid, 'org'),
      root.keyPair.publicKey, mid.keyPair.publicKey);

    // An attacker hands over a serialised keyring with an extra unsigned
    // edge claiming mid delegated to them.
    const data = kr.toJSON();
    data.links.push({
      parent: mid.podId, child: attacker.podId, relation: 'delegate',
      scope: null, expires: null, created: Date.now(), namespace: null,
    });
    const tampered = MeshKeyring.fromJSON(data);

    const res = await tampered.verifyCryptoChain(attacker.podId, root.podId, getPublicKey);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'unsigned');
    assert.equal(res.brokenAt, attacker.podId);
  });

  it('a SignedKeyLink with its signatures stripped does not verify', async () => {
    const { ids: [root, child], getPublicKey } = await makeIds(2);
    const link = await SignedKeyLink.create(root, child, 'device');
    const stripped = { ...link.toJSON(), parentSignature: null, childSignature: null };
    const kr = MeshKeyring.fromJSON({ v: 3, namespace: null, links: [stripped], revocations: [] });
    const res = await kr.verifyCryptoChain(child.podId, root.podId, getPublicKey);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'bad-signature');
  });
});

describe('SignedKeyLink domain separation and namespace binding (#302 item 2)', () => {
  it('signs exactly KEYLINK_DOMAIN + sorted-key canonical JSON', async () => {
    const { ids: [p, c] } = await makeIds(2);
    const link = await SignedKeyLink.create(p, c, 'delegate', {
      scope: ['read'], namespace: 'acct-a', created: 7,
    });
    const text = new TextDecoder().decode(link.signedPayload);
    assert.ok(text.startsWith(KEYLINK_DOMAIN));
    const body = JSON.parse(text.slice(KEYLINK_DOMAIN.length));
    assert.deepEqual(Object.keys(body), [...Object.keys(body)].sort());
    assert.equal(body.namespace, 'acct-a');
  });

  it('a link signature is not valid as an unlink signature (domain separation)', async () => {
    const { ids: [p, c] } = await makeIds(2);
    const link = await SignedKeyLink.create(p, c, 'device');
    const unlink = new SignedKeyUnlink({
      parent: p.podId, child: c.podId, created: link.created, signature: link.parentSignature,
    });
    assert.equal(await unlink.verify(p.keyPair.publicKey), false);
  });

  it('a link replayed into a keyring with another namespace is refused', async () => {
    const { ids: [p, c], getPublicKey } = await makeIds(2);
    const link = await SignedKeyLink.create(p, c, 'delegate', { namespace: 'acct-a' });

    const krA = new MeshKeyring({ namespace: 'acct-a' });
    await krA.addVerifiedLink(link, p.keyPair.publicKey, c.keyPair.publicKey);
    assert.equal((await krA.verifyCryptoChain(c.podId, p.podId, getPublicKey)).valid, true);

    const krB = new MeshKeyring({ namespace: 'acct-b' });
    await assert.rejects(
      () => krB.addVerifiedLink(link, p.keyPair.publicKey, c.keyPair.publicKey),
      /Namespace mismatch/
    );
    // Nor is it valid in a keyring with no namespace.
    await assert.rejects(
      () => new MeshKeyring().addVerifiedLink(link, p.keyPair.publicKey, c.keyPair.publicKey),
      /Namespace mismatch/
    );
  });

  it('rewriting the namespace field to match the target keyring breaks the signatures', async () => {
    const { ids: [p, c], getPublicKey } = await makeIds(2);
    const link = await SignedKeyLink.create(p, c, 'delegate', { namespace: 'acct-a' });
    const replayed = SignedKeyLink.fromJSON({ ...link.toJSON(), namespace: 'acct-b' });

    const krB = new MeshKeyring({ namespace: 'acct-b' });
    await assert.rejects(
      () => krB.addVerifiedLink(replayed, p.keyPair.publicKey, c.keyPair.publicKey),
      /Signature verification failed/
    );

    // Smuggled in through a serialised keyring, the chain walker catches it.
    const smuggled = MeshKeyring.fromJSON({
      v: 3, namespace: 'acct-b', links: [replayed.toJSON()], revocations: [],
    });
    const res = await smuggled.verifyCryptoChain(c.podId, p.podId, getPublicKey);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'bad-signature');

    // Un-rewritten, the link is refused by namespace.
    const wrongNs = MeshKeyring.fromJSON({
      v: 3, namespace: 'acct-b', links: [link.toJSON()], revocations: [],
    });
    assert.equal((await wrongNs.verifyCryptoChain(c.podId, p.podId, getPublicKey)).reason, 'namespace');
  });

  it('namespace round-trips through keyring serialisation', async () => {
    const { ids: [p, c], getPublicKey } = await makeIds(2);
    const kr = new MeshKeyring({ namespace: 'acct-a' });
    await kr.addVerifiedLink(
      await SignedKeyLink.create(p, c, 'device', { namespace: 'acct-a' }),
      p.keyPair.publicKey, c.keyPair.publicKey
    );
    const revived = MeshKeyring.fromJSON(JSON.parse(JSON.stringify(kr)));
    assert.equal(revived.namespace, 'acct-a');
    assert.equal((await revived.verifyCryptoChain(c.podId, p.podId, getPublicKey)).valid, true);
    assert.throws(() => MeshKeyring.fromJSON(kr.toJSON(), { namespace: 'acct-b' }), /Namespace mismatch/);
  });
});

describe('SignedKeyUnlink: signed, transferable, cascading revocation (#302 item 3)', () => {
  /** root -> mid -> leaf, all signed, in namespace `ns`. */
  async function chain(ns = null) {
    const { ids: [root, mid, leaf, other], getPublicKey } = await makeIds(4);
    const kr = new MeshKeyring({ namespace: ns });
    const l1 = await SignedKeyLink.create(root, mid, 'org', { namespace: ns ?? undefined });
    const l2 = await SignedKeyLink.create(mid, leaf, 'delegate', { namespace: ns ?? undefined });
    await kr.addVerifiedLink(l1, root.keyPair.publicKey, mid.keyPair.publicKey);
    await kr.addVerifiedLink(l2, mid.keyPair.publicKey, leaf.keyPair.publicKey);
    return { kr, root, mid, leaf, other, l1, l2, getPublicKey };
  }

  it('signs KEYUNLINK_DOMAIN + canonical body and round-trips', async () => {
    const { ids: [p, c] } = await makeIds(2);
    const u = await SignedKeyUnlink.create(p, c.podId, { reason: 'lost device' });
    assert.ok(new TextDecoder().decode(u.signedPayload).startsWith(KEYUNLINK_DOMAIN));
    const back = SignedKeyUnlink.fromJSON(JSON.parse(JSON.stringify(u)));
    assert.equal(await back.verify(p.keyPair.publicKey), true);
    const tampered = SignedKeyUnlink.fromJSON({ ...u.toJSON(), child: 'someone-else' });
    assert.equal(await tampered.verify(p.keyPair.publicKey), false);
  });

  it('cascades: a revoked descendant no longer verifies to the root', async () => {
    const { kr, root, mid, leaf, getPublicKey } = await chain();
    assert.equal((await kr.verifyCryptoChain(leaf.podId, root.podId, getPublicKey)).valid, true);

    const unlink = await SignedKeyUnlink.create(root, mid.podId);
    const { removed, descendants } = await kr.applyUnlink(unlink, root.keyPair.publicKey);
    assert.equal(removed, true);
    assert.deepEqual(descendants, [leaf.podId]);

    assert.equal((await kr.verifyCryptoChain(mid.podId, root.podId, getPublicKey)).valid, false);
    assert.equal((await kr.verifyCryptoChain(leaf.podId, root.podId, getPublicKey)).valid, false);
    // The mid -> leaf edge itself was not revoked.
    assert.equal((await kr.verifyCryptoChain(leaf.podId, mid.podId, getPublicKey)).valid, true);
  });

  it('transfers to a peer: the relayed unlink revokes there too, and the old link cannot be re-added', async () => {
    const a = await chain('mesh-1');
    // Peer B holds the same links.
    const peer = MeshKeyring.fromJSON(JSON.parse(JSON.stringify(a.kr)));

    const unlink = await SignedKeyUnlink.create(a.root, a.mid.podId, { namespace: 'mesh-1' });
    const wire = JSON.parse(JSON.stringify(unlink));
    await peer.applyUnlink(SignedKeyUnlink.fromJSON(wire), a.root.keyPair.publicKey);

    const res = await peer.verifyCryptoChain(a.leaf.podId, a.root.podId, a.getPublicKey);
    assert.equal(res.valid, false);

    // Replaying the original link is refused.
    await assert.rejects(
      () => peer.addVerifiedLink(a.l1, a.root.keyPair.publicKey, a.mid.keyPair.publicKey),
      /revoked/
    );
  });

  it('honors a revocation that arrives before the link, and survives serialisation', async () => {
    const a = await chain();
    const fresh = new MeshKeyring();
    await fresh.applyUnlink(await SignedKeyUnlink.create(a.root, a.mid.podId), a.root.keyPair.publicKey);
    await assert.rejects(
      () => fresh.addVerifiedLink(a.l1, a.root.keyPair.publicKey, a.mid.keyPair.publicKey),
      /revoked/
    );

    // A stale link list restored next to the revocation is caught by the walker.
    const restored = MeshKeyring.fromJSON({
      v: 3, namespace: null,
      links: [a.l1.toJSON(), a.l2.toJSON()],
      revocations: fresh.toJSON().revocations,
    });
    const res = await restored.verifyCryptoChain(a.leaf.podId, a.root.podId, a.getPublicKey);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'revoked');
    assert.equal(res.brokenAt, a.mid.podId);
  });

  it('a later re-link signed by both parties is not affected', async () => {
    const a = await chain();
    const unlink = await SignedKeyUnlink.create(a.root, a.mid.podId, { created: a.l1.created });
    await a.kr.applyUnlink(unlink, a.root.keyPair.publicKey);
    const relink = await SignedKeyLink.create(a.root, a.mid, 'org', { created: a.l1.created + 1 });
    await a.kr.addVerifiedLink(relink, a.root.keyPair.publicKey, a.mid.keyPair.publicKey);
    assert.equal((await a.kr.verifyCryptoChain(a.leaf.podId, a.root.podId, a.getPublicKey)).valid, true);
  });

  it('refuses an unlink not signed by the parent', async () => {
    const a = await chain();
    // The leaf (or anyone else) cannot revoke root -> mid.
    const forged = new SignedKeyUnlink({ parent: a.root.podId, child: a.mid.podId });
    forged.signature = await a.other.sign(forged.signedPayload);
    await assert.rejects(() => a.kr.applyUnlink(forged, a.root.keyPair.publicKey), /Signature verification failed/);
    await assert.rejects(
      () => a.kr.applyUnlink(new SignedKeyUnlink({ parent: a.root.podId, child: a.mid.podId }), a.root.keyPair.publicKey),
      /Signature verification failed/
    );
    assert.equal(a.kr.listRevocations().length, 0);
    assert.equal((await a.kr.verifyCryptoChain(a.leaf.podId, a.root.podId, a.getPublicKey)).valid, true);
  });

  it('refuses an unlink from another namespace', async () => {
    const a = await chain('mesh-1');
    const u = await SignedKeyUnlink.create(a.root, a.mid.podId, { namespace: 'mesh-2' });
    await assert.rejects(() => a.kr.applyUnlink(u, a.root.keyPair.publicKey), /Namespace mismatch/);
  });
});

describe('executeSuccession transfer requires successor-signed links (#302 item 4)', () => {
  async function setup() {
    const { ids: [primary, successor, c1, c2], getPublicKey } = await makeIds(4);
    const kr = new MeshKeyring();
    await kr.addVerifiedLink(
      await SignedKeyLink.create(primary, c1, 'device'),
      primary.keyPair.publicKey, c1.keyPair.publicKey
    );
    await kr.addVerifiedLink(
      await SignedKeyLink.create(primary, c2, 'delegate', { scope: ['read', 'write'] }),
      primary.keyPair.publicKey, c2.keyPair.publicKey
    );
    kr.setSuccessor(primary.podId, successor.podId, 1000, 'transfer');
    return { kr, primary, successor, c1, c2, getPublicKey };
  }

  it('refuses to transfer without replacement links and leaves the keyring untouched', async () => {
    const { kr, primary } = await setup();
    await assert.rejects(() => kr.executeSuccession(primary.podId), /SignedKeyLink/);
    assert.equal(kr.getChildren(primary.podId).length, 2);
    // Policy is still there.
    assert.equal(kr.checkSuccession().length, 1);
  });

  it('transfers with successor-signed links, which then verify', async () => {
    const { kr, primary, successor, c1, c2, getPublicKey } = await setup();
    const links = [
      await SignedKeyLink.create(successor, c1, 'device'),
      await SignedKeyLink.create(successor, c2, 'delegate', { scope: ['read'] }),
    ];
    const res = await kr.executeSuccession(primary.podId, { links, getPublicKey });
    assert.equal(res.affected, 2);
    assert.equal(kr.getChildren(primary.podId).length, 0);
    for (const l of kr.getChildren(successor.podId)) assert.ok(l instanceof SignedKeyLink);
    assert.equal((await kr.verifyCryptoChain(c2.podId, successor.podId, getPublicKey)).valid, true);
  });

  it('refuses a replacement that is forged, widened, or unsigned — atomically', async () => {
    const { kr, primary, successor, c1, c2, getPublicKey } = await setup();
    const good = await SignedKeyLink.create(successor, c1, 'device');

    const widened = await SignedKeyLink.create(successor, c2, 'delegate', { scope: ['read', 'admin'] });
    await assert.rejects(
      () => kr.executeSuccession(primary.podId, { links: [good, widened], getPublicKey }),
      /wider/
    );

    const tampered = SignedKeyLink.fromJSON({
      ...(await SignedKeyLink.create(successor, c2, 'delegate', { scope: ['read'] })).toJSON(),
      scope: ['read', 'write'],
    });
    await assert.rejects(
      () => kr.executeSuccession(primary.podId, { links: [good, tampered], getPublicKey }),
      /signature verification failed/
    );

    const unsigned = new KeyLink({ parent: successor.podId, child: c2.podId, relation: 'delegate', scope: ['read'] });
    await assert.rejects(
      () => kr.executeSuccession(primary.podId, { links: [good, unsigned], getPublicKey }),
      /SignedKeyLink/
    );

    // Nothing moved.
    assert.equal(kr.getChildren(primary.podId).length, 2);
    assert.equal(kr.getChildren(successor.podId).length, 0);
  });

  it('localOnly transfer produces unsigned links that verifyCryptoChain refuses', async () => {
    const { kr, primary, successor, c1, getPublicKey } = await setup();
    await kr.executeSuccession(primary.podId, { localOnly: true });
    const res = await kr.verifyCryptoChain(c1.podId, successor.podId, getPublicKey);
    assert.equal(res.valid, false);
    assert.equal(res.reason, 'unsigned');
  });
});
