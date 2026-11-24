import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PodIdentity, derivePodId } from '../src/index.mjs';

const pkcs8 = (n) => Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...new Uint8Array(32).fill(n)]);
const DATA = new TextEncoder().encode('hello vault');

async function check(identity) {
  const sig = await identity.sign(DATA);
  assert.equal(sig.length, 64);
  assert.equal(await PodIdentity.verify(identity.keyPair.publicKey, sig, DATA), true);
}

describe('PodIdentity: vault-friendly construction', () => {
  it('generate() still makes an extractable key by default', async () => {
    const id = await PodIdentity.generate();
    assert.equal(id.extractable, true);
    assert.equal((await id.exportPrivateKey('jwk')).kty, 'OKP');
    assert.equal((await id.exportPrivateKey('pkcs8')).length, 48);
    await check(id);
  });

  it('generate({ extractable: false }) signs but cannot be exported', async () => {
    const id = await PodIdentity.generate({ extractable: false });
    assert.equal(id.extractable, false);
    await check(id);
    await assert.rejects(id.exportPrivateKey(), /not exportable/);
    await assert.rejects(crypto.subtle.exportKey('jwk', id.keyPair.privateKey));
    await assert.rejects(crypto.subtle.exportKey('pkcs8', id.keyPair.privateKey));
    assert.equal((await id.rawPublicKey()).length, 32);
  });

  it('fromCryptoKeyPair wraps a non-extractable pair and rejects non-Ed25519 keys', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
    const id = await PodIdentity.fromCryptoKeyPair(kp);
    assert.equal(id.podId, await derivePodId(kp.publicKey));
    await check(id);
    const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    await assert.rejects(PodIdentity.fromCryptoKeyPair(ec), /Ed25519/);
    await assert.rejects(PodIdentity.fromCryptoKeyPair({}), /expected/);
  });

  it('fromJwk imports non-extractable by default and round-trips an exported identity', async () => {
    const source = await PodIdentity.generate();
    const jwk = await source.exportPrivateKey('jwk');
    const id = await PodIdentity.fromJwk(jwk);
    assert.equal(id.podId, source.podId);
    assert.equal(id.extractable, false);
    await assert.rejects(id.exportPrivateKey());
    await check(id);
    const back = await PodIdentity.fromJwk(jwk, { extractable: true });
    assert.equal(back.extractable, true);
    await assert.rejects(PodIdentity.fromJwk({ kty: 'OKP', crv: 'Ed25519', x: jwk.x }), /private JWK/);
  });

  it('fromJwk rejects a JWK whose public half does not match its private key', async () => {
    const a = await (await PodIdentity.generate()).exportPrivateKey('jwk');
    const b = await (await PodIdentity.generate()).exportPrivateKey('jwk');
    // some engines refuse at import, others at our sign/verify round trip
    await assert.rejects(PodIdentity.fromJwk({ ...a, x: b.x }));
  });

  it('fromPkcs8 needs the public key for a non-extractable import, and checks the pair', async () => {
    const derived = await PodIdentity.fromPkcs8(pkcs8(1), { extractable: true });
    assert.equal(derived.podId, 'NHUPmL1Z_PyUbaRaqr6TO-FUpLUJThxKv0KGZQXzyX4');
    await assert.rejects(PodIdentity.fromPkcs8(pkcs8(1)), /public key/);
    const id = await PodIdentity.fromPkcs8(pkcs8(1), { publicKey: await derived.rawPublicKey() });
    assert.equal(id.extractable, false);
    assert.equal(id.podId, derived.podId);
    await assert.rejects(id.exportPrivateKey('pkcs8'));
    await check(id);
    const other = await PodIdentity.fromPkcs8(pkcs8(2), { extractable: true });
    await assert.rejects(PodIdentity.fromPkcs8(pkcs8(1), { publicKey: await other.rawPublicKey() }), /does not match/);
    // the public key may also be a CryptoKey
    await PodIdentity.fromPkcs8(pkcs8(1), { publicKey: derived.keyPair.publicKey });
  });

  it('fromSigner routes every signature through the signer, sync or async', async () => {
    const real = await PodIdentity.generate({ extractable: false });
    let uses = 0;
    const rawKey = await real.rawPublicKey();
    const asyncSigner = { publicKey: rawKey, async sign(d) { uses++; return real.sign(d); } };
    const id = await PodIdentity.fromSigner(asyncSigner);
    assert.equal(id.isExternalSigner, true);
    assert.equal(id.extractable, false);
    assert.equal(id.keyPair.privateKey, null);
    assert.equal(id.podId, real.podId);
    await check(id);
    await id.sign(DATA);
    assert.equal(uses, 2);
    await assert.rejects(id.exportPrivateKey(), /not exportable/);

    // wsh-compatible: a public CryptoKey and a synchronous sign() returning bytes
    const syncKey = await PodIdentity.generate({ extractable: false });
    const exportedSigs = new Map();
    const syncSigner = { publicKey: syncKey.keyPair.publicKey, sign: (d) => exportedSigs.get(Buffer.from(d).toString('hex')) };
    exportedSigs.set(Buffer.from(DATA).toString('hex'), await syncKey.sign(DATA));
    const id2 = await PodIdentity.fromSigner(syncSigner);
    assert.equal(await PodIdentity.verify(id2.keyPair.publicKey, await id2.sign(DATA), DATA), true);
  });

  it('fromSigner validates the signer and its output', async () => {
    const real = await PodIdentity.generate({ extractable: false });
    const publicKey = await real.rawPublicKey();
    await assert.rejects(PodIdentity.fromSigner({ publicKey }), /expected/);
    await assert.rejects(PodIdentity.fromSigner({ sign() {} }), /expected/);
    await assert.rejects(PodIdentity.fromSigner({ publicKey: new Uint8Array(5), sign() {} }), /32/);
    await assert.rejects(PodIdentity.fromSigner({ publicKey: real.keyPair.privateKey, sign() {} }), /public/);
    const short = await PodIdentity.fromSigner({ publicKey, sign: () => new Uint8Array(10) });
    await assert.rejects(short.sign(DATA), /64-byte/);
  });

  it('fromSigner({ check: true }) uses the signer once and rejects a signer that does not match its key', async () => {
    const real = await PodIdentity.generate({ extractable: false });
    const wrong = await PodIdentity.generate({ extractable: false });
    let uses = 0;
    await PodIdentity.fromSigner({ publicKey: await real.rawPublicKey(), sign: (d) => { uses++; return real.sign(d); } }, { check: true });
    assert.equal(uses, 1);
    await assert.rejects(
      PodIdentity.fromSigner({ publicKey: await real.rawPublicKey(), sign: (d) => wrong.sign(d) }, { check: true }),
      /does not match/
    );
    // without check, construction never calls the signer
    uses = 0;
    await PodIdentity.fromSigner({ publicKey: await real.rawPublicKey(), sign: (d) => { uses++; return real.sign(d); } });
    assert.equal(uses, 0);
  });

  it('the existing constructor and keyPair field still work', async () => {
    const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const id = new PodIdentity({ keyPair: kp, podId: await derivePodId(kp.publicKey) });
    assert.equal(id.keyPair, kp);
    assert.equal(id.extractable, true);
    await check(id);
  });
});
