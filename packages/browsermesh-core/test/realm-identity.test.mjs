// Run with: node --import ./test/_setup-globals.mjs --test test/realm-identity.test.mjs
// Realms (docs/design/realms.md 5.10): one seed, one derived non-extractable identity per realm.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MeshIdentityManager,
  InMemoryIdentityStorage,
  IdentityWallet,
  derivePodId,
  encodeBase64url,
} from '../src/index.mjs';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const REALM = 'realm-test-vector-0000000000000000000000000';
const VECTOR = {
  derivedSeedHex: '0da1010425a78f9783e802c9109d3899cdb281f4a1cd5079cec7878a0a8d1235',
  publicKeyX: 'iAZS2VHtgLy47Huzd17k93TsC8HDwmHZCJNJhX7Ejng',
  signatureHex: 'cd3879ce06ce5d6cc9089851c6cf309519ec4bf6bcb1ea41eb00d89e8a03490eeb3e01f185fa8f966d96dcfdab12ab9aeff56f7b91288849416ce199d036500d',
};
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const MSG = new TextEncoder().encode('realm exchange');

function withSeed(opts) {
  const m = new MeshIdentityManager(opts);
  m.setSeed(SEED);
  return m;
}

describe('realm identity derivation: pinned vector', () => {
  it('derives the pinned key bytes, public key and signature', async () => {
    const m = withSeed();
    assert.equal(hex(await m.deriveRealmKeyBytes(REALM)), VECTOR.derivedSeedHex);
    const s = await m.deriveRealmIdentity(REALM);
    const pub = await m.getPublicKeyBytes(s.podId);
    assert.equal(encodeBase64url(pub), VECTOR.publicKeyX);
    const sig = await m.sign(s.podId, MSG);
    assert.equal(hex(sig), VECTOR.signatureHex);
    assert.equal(await m.verify(pub, sig, MSG), true);
  });
  it('podId is the hash of the public key like any identity', async () => {
    const m = withSeed();
    const s = await m.deriveRealmIdentity(REALM);
    assert.equal(s.podId, await derivePodId(m.getIdentity(s.podId).keyPair.publicKey));
  });
});

describe('realm identity derivation: properties', () => {
  it('is deterministic across managers', async () => {
    const a = await withSeed().deriveRealmIdentity(REALM);
    const b = await withSeed().deriveRealmIdentity(REALM);
    assert.equal(a.podId, b.podId);
  });
  it('deriving twice on one manager returns the same identity, not a duplicate', async () => {
    const m = withSeed();
    const a = await m.deriveRealmIdentity(REALM);
    const b = await m.deriveRealmIdentity(REALM);
    assert.equal(a.podId, b.podId);
    assert.equal(m.size, 1);
  });
  it('different realm ids give different keys; different seeds too', async () => {
    const m = withSeed();
    const a = await m.deriveRealmIdentity('realm-a');
    const b = await m.deriveRealmIdentity('realm-b');
    assert.notEqual(a.podId, b.podId);
    const m2 = new MeshIdentityManager();
    m2.setSeed(new Uint8Array(32).fill(7));
    assert.notEqual((await m2.deriveRealmIdentity('realm-a')).podId, a.podId);
  });
  it('the key is non-extractable and refuses export', async () => {
    const m = withSeed();
    const s = await m.deriveRealmIdentity(REALM);
    const key = m.getIdentity(s.podId).keyPair.privateKey;
    assert.equal(key.extractable, false);
    await assert.rejects(() => crypto.subtle.exportKey('pkcs8', key));
    await assert.rejects(() => crypto.subtle.exportKey('jwk', key));
  });
  it('records the realm in summary metadata and has a DID', async () => {
    const m = withSeed();
    const s = await m.deriveRealmIdentity(REALM);
    assert.equal(s.metadata.realm, REALM);
    assert.equal(s.metadata.derived, true);
    assert.match(s.did, /^did:key:z6Mk/);
  });
  it('requires a seed', async () => {
    await assert.rejects(() => new MeshIdentityManager().deriveRealmIdentity(REALM), /seed/i);
  });
  it('validates realm ids', async () => {
    const m = withSeed();
    for (const bad of ['', 'a\0b', undefined, null, 5, {}]) {
      await assert.rejects(() => m.deriveRealmIdentity(bad), TypeError, String(bad));
    }
  });
  it('validates the seed', () => {
    const m = new MeshIdentityManager();
    assert.throws(() => m.setSeed(new Uint8Array(31)), TypeError);
    assert.throws(() => m.setSeed('x'), TypeError);
  });
  it('createSeed makes a random seed, hasSeed reports it', async () => {
    const m = new MeshIdentityManager();
    assert.equal(m.hasSeed, false);
    m.createSeed();
    assert.equal(m.hasSeed, true);
    const n = new MeshIdentityManager();
    n.createSeed();
    assert.notEqual((await m.deriveRealmIdentity('r')).podId, (await n.deriveRealmIdentity('r')).podId);
  });
  it('save() skips derived identities (recovered from the seed) and keeps the rest', async () => {
    const storage = new InMemoryIdentityStorage();
    const m = withSeed({ storage });
    const plain = await m.create('plain');
    await m.deriveRealmIdentity(REALM);
    await m.save();
    const m2 = new MeshIdentityManager({ storage });
    await m2.load();
    assert.deepEqual(m2.list().map((s) => s.podId), [plain.podId]);
  });
  it('works through IdentityWallet', async () => {
    const w = new IdentityWallet({ identityManager: withSeed() });
    const s = await w.deriveRealmIdentity(REALM);
    assert.equal(w.getIdentity(s.podId).metadata.realm, REALM);
  });
});

describe('realm seed backup', () => {
  it('round trips into a fresh manager and derives the same realm key', async () => {
    const m = withSeed();
    const a = await m.deriveRealmIdentity(REALM);
    const text = await m.exportSeed('correct horse', { label: 'laptop' });
    const rec = JSON.parse(text);
    assert.equal(rec.t, 'browsermesh-realm-seed');
    assert.equal(rec.fmt, 1);
    assert.equal(rec.label, 'laptop');
    assert.equal(typeof rec.createdAt, 'number');
    assert.ok(!text.includes(hex(SEED)));
    const n = new MeshIdentityManager();
    const info = await n.importSeed(text, 'correct horse');
    assert.equal(info.label, 'laptop');
    const b = await n.deriveRealmIdentity(REALM);
    assert.equal(b.podId, a.podId);
  });
  it('wrong passphrase gives a clear coded error', async () => {
    const text = await withSeed().exportSeed('right');
    await assert.rejects(() => new MeshIdentityManager().importSeed(text, 'wrong'),
      (e) => e.name === 'RealmSeedError' && e.code === 'bad_passphrase' && e.cause?.name === 'VaultError');
  });
  it('wrong record type is refused', async () => {
    const m = withSeed();
    const s = await m.create('x');
    const other = await m.export(s.podId, 'pw');
    await assert.rejects(() => new MeshIdentityManager().importSeed(JSON.stringify(other), 'pw'),
      (e) => e.name === 'RealmSeedError' && e.code === 'wrong_type');
  });
  it('empty or missing passphrase is refused on both sides', async () => {
    const m = withSeed();
    await assert.rejects(() => m.exportSeed(''), TypeError);
    await assert.rejects(() => m.exportSeed(undefined), TypeError);
    const text = await m.exportSeed('pw');
    await assert.rejects(() => new MeshIdentityManager().importSeed(text, ''), TypeError);
  });
  it('a tampered header is refused', async () => {
    const text = await withSeed().exportSeed('pw', { label: 'mine' });
    const rec = JSON.parse(text);
    rec.label = 'evil';
    await assert.rejects(() => new MeshIdentityManager().importSeed(JSON.stringify(rec), 'pw'),
      (e) => e.name === 'RealmSeedError' && e.code === 'bad_passphrase');
  });
  it('garbage text is refused as corrupt', async () => {
    await assert.rejects(() => new MeshIdentityManager().importSeed('not json', 'pw'),
      (e) => e.name === 'RealmSeedError' && e.code === 'corrupt');
  });
  it('exporting without a seed fails clearly', async () => {
    await assert.rejects(() => new MeshIdentityManager().exportSeed('pw'), /seed/i);
  });
  it('wallet delegates export/import', async () => {
    const w = new IdentityWallet({ identityManager: withSeed() });
    const text = await w.exportSeed('pw');
    const w2 = new IdentityWallet({ identityManager: new MeshIdentityManager() });
    await w2.importSeed(text, 'pw');
    assert.equal((await w2.deriveRealmIdentity(REALM)).podId, (await w.deriveRealmIdentity(REALM)).podId);
  });
});

describe('realm identity fallback (derive: false)', () => {
  it('makes independent random keys, not derivable from the seed', async () => {
    const m = withSeed();
    const d = await m.deriveRealmIdentity(REALM);
    const f1 = await m.createRealmIdentity(REALM, { derive: false });
    const f2 = await m.createRealmIdentity(REALM, { derive: false });
    assert.notEqual(f1.podId, d.podId);
    assert.notEqual(f1.podId, f2.podId);
    assert.equal(f1.metadata.realm, REALM);
    assert.equal(f1.metadata.derived, false);
    const n = withSeed();
    await n.deriveRealmIdentity(REALM);
    assert.ok(!n.has(f1.podId));
  });
  it('works without a seed, validates the realm id, and is saveable', async () => {
    const m = new MeshIdentityManager();
    const f = await m.createRealmIdentity('r1', { derive: false });
    assert.ok(m.has(f.podId));
    await assert.rejects(() => m.createRealmIdentity('', { derive: false }), TypeError);
    await m.save();
  });
  it('createRealmIdentity defaults to derivation', async () => {
    const m = withSeed();
    const a = await m.createRealmIdentity(REALM);
    assert.equal(a.metadata.derived, true);
  });
});
