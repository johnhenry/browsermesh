// Run with: node --import ./test/_setup-globals.mjs --test test/keyring.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  KeyLink,
  SignedKeyLink,
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
      data.push({ parent: 'c', child: 'a', relation: 'alias', scope: null, expires: null, created: Date.now() });
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

    it('toJSON returns an array of plain objects', () => {
      kr.link('a', 'b', 'device');
      const json = kr.toJSON();
      assert.ok(Array.isArray(json));
      assert.equal(json.length, 1);
      assert.equal(json[0].parent, 'a');
      assert.equal(json[0].child, 'b');
      assert.equal(json[0] instanceof KeyLink, false);
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

      const link = await SignedKeyLink.create(parent, child, 'device');
      // Force expiration
      link.expires = 1;
      await kr.addVerifiedLink(link, parent.keyPair.publicKey, child.keyPair.publicKey);

      const keyMap = new Map([
        [parent.podId, parent.keyPair.publicKey],
        [child.podId, child.keyPair.publicKey],
      ]);

      const result = await kr.verifyCryptoChain(child.podId, parent.podId, (id) => keyMap.get(id));
      assert.equal(result.valid, false);
      assert.equal(result.brokenAt, child.podId);
    });

    it('works with unsigned links in chain', async () => {
      // Mix signed and unsigned links
      kr.link('root', 'mid', 'org');
      const mid = await PodIdentity.generate();
      const leaf = await PodIdentity.generate();

      // Add unsigned link manually (already done above as 'root' -> 'mid')
      // The verifyCryptoChain skips sig check for unsigned links
      const result = await kr.verifyCryptoChain('mid', 'root', () => null);
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

  it('signedPayload generates canonical bytes', () => {
    const link = new SignedKeyLink({
      parent: 'PARENT',
      child: 'CHILD',
      relation: 'device',
      created: 12345,
    });
    const payload = link.signedPayload;
    const str = new TextDecoder().decode(payload);
    assert.equal(str, 'PARENT|CHILD|device|12345');
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

  it('executeSuccession with transfer re-links children', () => {
    // Build: primary -> child1, primary -> child2
    kr.link('primary', 'child1', 'device');
    kr.link('primary', 'child2', 'delegate');
    kr.setSuccessor('primary', 'backup', 5000, 'transfer');

    const result = kr.executeSuccession('primary');
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

  it('executeSuccession with revoke removes all children', () => {
    kr.link('primary', 'child1', 'device');
    kr.link('primary', 'child2', 'org');
    kr.link('primary', 'child3', 'alias');
    kr.setSuccessor('primary', 'backup', 5000, 'revoke');

    const result = kr.executeSuccession('primary');
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
