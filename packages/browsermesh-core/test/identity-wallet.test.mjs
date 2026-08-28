// Run with: node --import ./test/_setup-globals.mjs --test test/identity-wallet.test.mjs
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { IdentityWallet } from '../src/identity-wallet.mjs';

// ── Mock helpers ──────────────────────────────────────────────────

function createMockIdentityManager() {
  const identities = new Map();
  let defaultId = null;
  let nextId = 0;
  return {
    async create(label, opts) {
      const podId = `pod_${nextId++}`;
      const summary = { podId, label, did: `did:key:z${podId}`, created: Date.now(), metadata: opts?.metadata || {} };
      identities.set(podId, summary);
      if (!defaultId) defaultId = podId;
      return summary;
    },
    async import(jwk, label, opts) { return this.create(label, opts); },
    async export(podId) { return { type: 'jwk', podId }; },
    delete(podId) { const had = identities.has(podId); identities.delete(podId); if (defaultId === podId) defaultId = null; return had; },
    list() { return [...identities.values()]; },
    get(podId) { return identities.get(podId) || null; },
    has(podId) { return identities.has(podId); },
    setDefault(podId) { if (!identities.has(podId)) throw new Error('unknown'); defaultId = podId; },
    getDefault() { return defaultId ? identities.get(defaultId) : null; },
    async sign(podId, data) { return new Uint8Array([1, 2, 3]); },
    async verify() { return true; },
    async getPublicKeyBytes(podId) { return new Uint8Array([4, 5, 6]); },
    toDID(podId) { return `did:key:z${podId}`; },
    get size() { return identities.size; },
    toJSON() { return { defaultId, identities: [...identities.values()] }; },
    getIdentity(podId) { return identities.has(podId) ? { podId } : null; },
  };
}

function createMockIdentitySelector() {
  const rules = new Map();
  return {
    setRule(peerId, podId) { rules.set(peerId, podId); },
    removeRule(peerId) { return rules.delete(peerId); },
    resolve(peerId) { return rules.has(peerId) ? { podId: rules.get(peerId) } : null; },
    listRules() { return [...rules.entries()].map(([peerId, podId]) => ({ peerId, podId })); },
    toJSON() { return Object.fromEntries(rules); },
    fromJSON(data) { for (const [k, v] of Object.entries(data || {})) rules.set(k, v); },
  };
}

// ── Tests ─────────────────────────────────────────────────────────

describe('IdentityWallet', () => {
  let mgr;
  let selector;
  let wallet;
  let logs;

  beforeEach(() => {
    mgr = createMockIdentityManager();
    selector = createMockIdentitySelector();
    logs = [];
    wallet = new IdentityWallet({
      identityManager: mgr,
      identitySelector: selector,
      onLog: (event, data) => logs.push({ event, data }),
    });
  });

  // ── Constructor ───────────────────────────────────────────────

  describe('constructor', () => {
    it('throws when identityManager is missing', () => {
      assert.throws(() => new IdentityWallet({}), /identityManager is required/);
    });

    it('works without optional identitySelector and onLog', () => {
      const w = new IdentityWallet({ identityManager: mgr });
      assert.equal(w.size, 0);
    });
  });

  // ── Identity CRUD ─────────────────────────────────────────────

  describe('identity CRUD', () => {
    it('createIdentity returns summary and logs', async () => {
      const s = await wallet.createIdentity('Alice');
      assert.equal(s.label, 'Alice');
      assert.ok(s.podId);
      assert.equal(logs.length, 1);
      assert.equal(logs[0].event, 'wallet:identity:create');
    });

    it('listIdentities returns all created identities', async () => {
      await wallet.createIdentity('A');
      await wallet.createIdentity('B');
      assert.equal(wallet.listIdentities().length, 2);
    });

    it('getIdentity returns summary or null', async () => {
      const s = await wallet.createIdentity('C');
      assert.equal(wallet.getIdentity(s.podId).label, 'C');
      assert.equal(wallet.getIdentity('nonexistent'), null);
    });

    it('deleteIdentity removes and logs, returns false for unknown', async () => {
      const s = await wallet.createIdentity('D');
      assert.equal(wallet.deleteIdentity(s.podId), true);
      assert.equal(wallet.getIdentity(s.podId), null);
      assert.equal(wallet.deleteIdentity('nope'), false);
      // only create + delete logs (not a second delete log)
      assert.equal(logs.filter(l => l.event === 'wallet:identity:delete').length, 1);
    });

    it('setDefault / getDefault', async () => {
      const a = await wallet.createIdentity('A');
      const b = await wallet.createIdentity('B');
      // first created is auto-default
      assert.equal(wallet.getDefault().podId, a.podId);
      wallet.setDefault(b.podId);
      assert.equal(wallet.getDefault().podId, b.podId);
      assert.ok(logs.some(l => l.event === 'wallet:identity:setDefault'));
    });
  });

  // ── Import / Export ───────────────────────────────────────────

  describe('import / export', () => {
    it('importIdentity delegates to manager and logs', async () => {
      const s = await wallet.importIdentity({ kty: 'OKP' }, 'Imported');
      assert.equal(s.label, 'Imported');
      assert.ok(logs.some(l => l.event === 'wallet:identity:import'));
    });

    it('exportIdentity returns JWK-like object', async () => {
      const s = await wallet.createIdentity('E');
      const exported = await wallet.exportIdentity(s.podId);
      assert.equal(exported.type, 'jwk');
      assert.equal(exported.podId, s.podId);
    });
  });

  // ── Per-peer identity selection ───────────────────────────────

  describe('per-peer identity selection', () => {
    it('selectForPeer returns null with no rule set', () => {
      assert.equal(wallet.selectForPeer('peer1'), null);
    });

    it('setIdentityForPeer + selectForPeer round-trips', async () => {
      const s = await wallet.createIdentity('F');
      wallet.setIdentityForPeer('peer1', s.podId);
      const resolved = wallet.selectForPeer('peer1');
      assert.equal(resolved.podId, s.podId);
    });

    it('removeIdentityForPeer clears the rule', async () => {
      const s = await wallet.createIdentity('G');
      wallet.setIdentityForPeer('peer2', s.podId);
      assert.equal(wallet.removeIdentityForPeer('peer2'), true);
      assert.equal(wallet.selectForPeer('peer2'), null);
    });

    it('selectForPeer returns null when no selector configured', () => {
      const w = new IdentityWallet({ identityManager: mgr });
      assert.equal(w.selectForPeer('peer1'), null);
    });

    it('setIdentityForPeer throws when no selector configured', () => {
      const w = new IdentityWallet({ identityManager: mgr });
      assert.throws(() => w.setIdentityForPeer('p', 'id'), /No IdentitySelector configured/);
    });

    it('removeIdentityForPeer returns false when no selector configured', () => {
      const w = new IdentityWallet({ identityManager: mgr });
      assert.equal(w.removeIdentityForPeer('p'), false);
    });
  });

  // ── Contact management ────────────────────────────────────────

  describe('contacts', () => {
    const pk = 'aabbccdd11223344aabbccdd11223344';

    it('addContact creates and returns a contact copy', () => {
      const c = wallet.addContact(pk, 'Bob');
      assert.equal(c.publicKeyHex, pk);
      assert.equal(c.label, 'Bob');
      assert.equal(c.trustLevel, 0.5);
      assert.ok(c.addedAt > 0);
    });

    it('addContact rejects duplicate keys', () => {
      wallet.addContact(pk, 'Bob');
      assert.throws(() => wallet.addContact(pk, 'Bob2'), /Contact already exists/);
    });

    it('addContact validates inputs', () => {
      assert.throws(() => wallet.addContact('', 'X'), /publicKeyHex is required/);
      assert.throws(() => wallet.addContact('abc', ''), /label is required/);
    });

    it('addContact clamps trust to [0,1]', () => {
      const c1 = wallet.addContact('k1', 'Lo', -5);
      assert.equal(c1.trustLevel, 0);
      const c2 = wallet.addContact('k2', 'Hi', 99);
      assert.equal(c2.trustLevel, 1);
    });

    it('getContact returns copy or null', () => {
      wallet.addContact(pk, 'Bob');
      const c = wallet.getContact(pk);
      assert.equal(c.label, 'Bob');
      assert.equal(wallet.getContact('missing'), null);
    });

    it('listContacts returns all contacts', () => {
      wallet.addContact('k1', 'A');
      wallet.addContact('k2', 'B');
      assert.equal(wallet.listContacts().length, 2);
    });

    it('removeContact deletes and returns boolean', () => {
      wallet.addContact(pk, 'Bob');
      assert.equal(wallet.removeContact(pk), true);
      assert.equal(wallet.removeContact(pk), false);
      assert.equal(wallet.getContact(pk), null);
    });

    it('updateContact modifies label, trustLevel, metadata', () => {
      wallet.addContact(pk, 'Bob');
      const updated = wallet.updateContact(pk, {
        label: 'Robert',
        trustLevel: 0.9,
        metadata: { org: 'Acme' },
      });
      assert.equal(updated.label, 'Robert');
      assert.equal(updated.trustLevel, 0.9);
      assert.deepEqual(updated.metadata, { org: 'Acme' });
    });

    it('updateContact returns null for unknown key', () => {
      assert.equal(wallet.updateContact('nope', { label: 'X' }), null);
    });

    it('updateContact clamps trustLevel', () => {
      wallet.addContact(pk, 'Bob');
      const c = wallet.updateContact(pk, { trustLevel: 2.5 });
      assert.equal(c.trustLevel, 1);
    });

    it('updateContact rejects empty label', () => {
      wallet.addContact(pk, 'Bob');
      assert.throws(() => wallet.updateContact(pk, { label: '' }), /label must be a non-empty string/);
    });
  });

  // ── Access grants ─────────────────────────────────────────────

  describe('access grants', () => {
    const pk = 'aabbccdd11223344aabbccdd11223344';

    beforeEach(() => {
      wallet.addContact(pk, 'Grantee');
    });

    it('grantAccess adds capabilities', () => {
      wallet.grantAccess(pk, ['read', 'write']);
      assert.deepEqual(wallet.getGrantedAccess(pk), ['read', 'write']);
    });

    it('grantAccess is additive and deduplicates', () => {
      wallet.grantAccess(pk, ['read']);
      wallet.grantAccess(pk, ['read', 'admin']);
      assert.deepEqual(wallet.getGrantedAccess(pk), ['read', 'admin']);
    });

    it('revokeAccess removes specific capabilities', () => {
      wallet.grantAccess(pk, ['read', 'write', 'admin']);
      wallet.revokeAccess(pk, ['write']);
      assert.deepEqual(wallet.getGrantedAccess(pk), ['read', 'admin']);
    });

    it('revokeAccess cleans up map when all revoked', () => {
      wallet.grantAccess(pk, ['read']);
      wallet.revokeAccess(pk, ['read']);
      assert.deepEqual(wallet.getGrantedAccess(pk), []);
    });

    it('grantAccess throws for unknown contact', () => {
      assert.throws(() => wallet.grantAccess('unknown', ['read']), /Contact not found/);
    });

    it('grantAccess throws for empty capabilities array', () => {
      assert.throws(() => wallet.grantAccess(pk, []), /capabilities must be a non-empty array/);
    });

    it('revokeAccess throws for empty capabilities array', () => {
      assert.throws(() => wallet.revokeAccess(pk, []), /capabilities must be a non-empty array/);
    });

    it('removeContact also clears grants', () => {
      wallet.grantAccess(pk, ['read']);
      wallet.removeContact(pk);
      assert.deepEqual(wallet.getGrantedAccess(pk), []);
    });

    it('getGrantedAccess returns empty for unknown key', () => {
      assert.deepEqual(wallet.getGrantedAccess('nope'), []);
    });
  });

  // ── Crypto delegation ─────────────────────────────────────────

  describe('crypto delegation', () => {
    it('sign delegates to identityManager', async () => {
      const s = await wallet.createIdentity('Signer');
      const sig = await wallet.sign(s.podId, new Uint8Array([10]));
      assert.deepEqual(sig, new Uint8Array([1, 2, 3]));
    });

    it('verify delegates to identityManager', async () => {
      const ok = await wallet.verify(new Uint8Array([4, 5, 6]), new Uint8Array([10]), new Uint8Array([1, 2, 3]));
      assert.equal(ok, true);
    });

    it('getPublicKeyBytes delegates to identityManager', async () => {
      const s = await wallet.createIdentity('Pub');
      const bytes = await wallet.getPublicKeyBytes(s.podId);
      assert.deepEqual(bytes, new Uint8Array([4, 5, 6]));
    });
  });

  // ── size getter ───────────────────────────────────────────────

  describe('size', () => {
    it('reflects identityManager.size', async () => {
      assert.equal(wallet.size, 0);
      await wallet.createIdentity('X');
      assert.equal(wallet.size, 1);
      await wallet.createIdentity('Y');
      assert.equal(wallet.size, 2);
    });
  });

  // ── toJSON / fromJSON ─────────────────────────────────────────

  describe('toJSON / fromJSON', () => {
    it('round-trips contacts, grants, and selector rules', async () => {
      const pk = 'aabbcc1122334455';
      await wallet.createIdentity('Z');
      wallet.addContact(pk, 'Carol', 0.8);
      wallet.grantAccess(pk, ['sync', 'chat']);
      wallet.setIdentityForPeer('peer9', 'pod_0');

      const json = wallet.toJSON();

      // Reconstruct with fresh mocks
      const mgr2 = createMockIdentityManager();
      const sel2 = createMockIdentitySelector();
      const w2 = IdentityWallet.fromJSON(json, mgr2, sel2);

      // Contacts restored
      const c = w2.getContact(pk);
      assert.equal(c.label, 'Carol');
      assert.equal(c.trustLevel, 0.8);

      // Grants restored
      assert.deepEqual(w2.getGrantedAccess(pk), ['sync', 'chat']);

      // Selector rules restored
      const resolved = w2.selectForPeer('peer9');
      assert.equal(resolved.podId, 'pod_0');
    });

    it('fromJSON handles empty/null data gracefully', () => {
      const w = IdentityWallet.fromJSON(null, mgr);
      assert.equal(w.listContacts().length, 0);
    });

    it('toJSON includes identities and selector fields', async () => {
      const json = wallet.toJSON();
      assert.ok('contacts' in json);
      assert.ok('grants' in json);
      assert.ok('identities' in json);
      assert.ok('selector' in json);
    });

    it('toJSON selector is null without identitySelector', async () => {
      const w = new IdentityWallet({ identityManager: mgr });
      const json = w.toJSON();
      assert.equal(json.selector, null);
    });
  });

  // ── Logging callback ──────────────────────────────────────────

  describe('logging', () => {
    it('logs events for major operations', async () => {
      const pk = 'abcdef0123456789';
      await wallet.createIdentity('L');
      wallet.addContact(pk, 'Loggy');
      wallet.grantAccess(pk, ['x']);
      wallet.revokeAccess(pk, ['x']);
      wallet.removeContact(pk);
      wallet.setIdentityForPeer('p', 'pod_0');
      wallet.removeIdentityForPeer('p');

      const events = logs.map(l => l.event);
      assert.ok(events.includes('wallet:identity:create'));
      assert.ok(events.includes('wallet:contact:add'));
      assert.ok(events.includes('wallet:grant'));
      assert.ok(events.includes('wallet:revoke'));
      assert.ok(events.includes('wallet:contact:remove'));
      assert.ok(events.includes('wallet:selector:set'));
      assert.ok(events.includes('wallet:selector:remove'));
    });
  });
});
