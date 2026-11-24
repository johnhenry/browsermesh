import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PodIdentity,
  CredentialError,
  MemoryRevocationStore,
  createSession,
  createSessionProof,
  decodeSessionCertificate,
  encodeSessionCertificateBody,
  isRevoked,
  issueSessionCertificate,
  podIdFromRawKey,
  derivePodId,
  receiveRevocation,
  retireIdentity,
  revokeSessionCertificate,
  scopeAllows,
  verifyPeerCredential,
  verifyRevocation,
  verifyWithRawPublicKey,
  encodeBase64url,
} from '../src/index.mjs';

const hex = (s) => Uint8Array.from(Buffer.from(s, 'hex'));
const toHex = (b) => Buffer.from(b).toString('hex');
const pkcs8 = (n) => Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...new Uint8Array(32).fill(n)]);

// Fixed vectors: identity seed = 32 x 0x01, session seed = 32 x 0x02, serial = 16 x 0xaa.
// Another implementation should reproduce these bytes exactly (Ed25519 is deterministic).
const V = {
  identityKey: '8a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c',
  sessionKey: '8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394',
  podId: 'NHUPmL1Z_PyUbaRaqr6TO-FUpLUJThxKv0KGZQXzyX4',
  scope: ['mesh:peer:send', 'chat:*:read', '*:b:c'], // given unsorted on purpose
  notBefore: 1700000000,
  notAfter: 1700003600,
  body: '424d53430100208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c00208139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b3940010aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000006553f100000000006553ff10000300052a3a623a63000b636861743a2a3a72656164000e6d6573683a706565723a73656e64',
  cert: '424d53430100208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c00208139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b3940010aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000006553f100000000006553ff10000300052a3a623a63000b636861743a2a3a72656164000e6d6573683a706565723a73656e6400402c4e05736108cc7240a48f7b9d7f8942999fc1d3966b36723320854653bb3895980346f844151869e514ecbba4df03bcd1c67554c48c85a8fca211666f9d310e',
  revocation: '424d5256010100208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c0010aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa000000006553f164000000006553ff10004008d9f8932d575a277d504c2be02032e84c993e27c0fdf972a2d7ec1bfdbcd6aca2d88599f759e7f1ddd30b1b7ea0ee0987c912ee529fc7d31b601874f2a6f80f',
  retirement: '424d5256010200208a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c0000000000006553f1c800000000000000000040ee0008df86f3893d46b50478d9ffae416b76f4b969ecb95f498e8230574d878d4493508b0250cef1bf629fe851e33312ed5be7ea0ca2636bb374f883b9749103',
};
const SERIAL = new Uint8Array(16).fill(0xaa);
const T0 = V.notBefore * 1000;

async function code(promise) {
  try { await promise; } catch (e) { assert.ok(e instanceof CredentialError, `expected CredentialError, got ${e}`); return e.code; }
  assert.fail('expected a refusal');
}

async function fixedIdentity(n = 1) {
  return PodIdentity.fromPkcs8(pkcs8(n), { extractable: true });
}

/** A signer that counts its uses, backed by a non-extractable key. */
async function countingSigner() {
  const real = await PodIdentity.generate({ extractable: false });
  const signer = { publicKey: await real.rawPublicKey(), uses: 0, sign(data) { this.uses++; return real.sign(data); } };
  return signer;
}

describe('test vectors', () => {
  it('the fixed keys give the documented identity key and pod id', async () => {
    const id = await fixedIdentity(1);
    assert.equal(toHex(await id.rawPublicKey()), V.identityKey);
    assert.equal(id.podId, V.podId);
    assert.equal(await podIdFromRawKey(hex(V.identityKey)), await derivePodId(id.keyPair.publicKey));
  });

  it('encodes the body canonically (scope sorted bytewise, length-prefixed, big-endian times)', () => {
    const body = encodeSessionCertificateBody({
      identityKey: hex(V.identityKey), sessionKey: hex(V.sessionKey), serial: SERIAL,
      notBefore: V.notBefore, notAfter: V.notAfter, scope: V.scope,
    });
    assert.equal(toHex(body), V.body);
    // a different input order and a duplicate encode identically
    const again = encodeSessionCertificateBody({
      identityKey: hex(V.identityKey), sessionKey: hex(V.sessionKey), serial: SERIAL,
      notBefore: V.notBefore, notAfter: V.notAfter, scope: [...V.scope].reverse().concat(V.scope[0]),
    });
    assert.equal(toHex(again), V.body);
  });

  it('signs the certificate and the revocations to the documented bytes', async () => {
    const id = await fixedIdentity(1);
    const issued = await issueSessionCertificate(id, {
      sessionPublicKey: hex(V.sessionKey), scope: V.scope, serial: SERIAL,
      notBefore: V.notBefore, notAfter: V.notAfter, now: T0,
    });
    assert.equal(toHex(issued.certificate), V.cert);
    assert.equal(toHex(await revokeSessionCertificate(id, issued.certificate, { now: T0 + 100000 })), V.revocation);
    assert.equal(toHex(await retireIdentity(id, { now: T0 + 200000 })), V.retirement);
  });

  it('the documented certificate and revocations verify', async () => {
    const r = await verifyPeerCredential(hex(V.cert), { now: T0 + 1000 });
    assert.equal(toHex(r.identityKey), V.identityKey);
    assert.equal(toHex(r.sessionKey), V.sessionKey);
    assert.equal(r.podId, V.podId);
    assert.deepEqual(r.scope, ['*:b:c', 'chat:*:read', 'mesh:peer:send']);
    assert.equal((await verifyRevocation(hex(V.revocation))).kind, 1);
    assert.equal((await verifyRevocation(hex(V.retirement))).kind, 2);
  });
});

describe('verifyPeerCredential: refusals', () => {
  async function fresh(opts = {}) {
    const identity = await PodIdentity.generate();
    const s = await createSession(identity, { scope: ['chat:*:read'], now: T0, ttlSeconds: 600, ...opts });
    return { identity, ...s };
  }

  it('accepts a good certificate and accepts a base64url string', async () => {
    const { certificate, identityKey, sessionKey } = await fresh();
    const r = await verifyPeerCredential(certificate, { now: T0 + 1000 });
    assert.deepEqual(r.identityKey, identityKey);
    assert.deepEqual(r.sessionKey, sessionKey);
    await verifyPeerCredential(encodeBase64url(certificate), { now: T0 + 1000 });
  });

  it('refuses an expired certificate (notAfter is exclusive; skew extends it)', async () => {
    const { certificate } = await fresh();
    const end = T0 + 600 * 1000;
    assert.equal(await code(verifyPeerCredential(certificate, { now: end + 30_000 })), 'expired');
    await verifyPeerCredential(certificate, { now: end + 29_000 });
    assert.equal(await code(verifyPeerCredential(certificate, { now: end, skewSeconds: 0 })), 'expired');
    await verifyPeerCredential(certificate, { now: end - 1000, skewSeconds: 0 });
  });

  it('refuses a certificate that is not yet valid (skew tolerates a slow verifier clock)', async () => {
    const { certificate } = await fresh({ notBefore: V.notBefore + 1000, ttlSeconds: 600 });
    const start = (V.notBefore + 1000) * 1000;
    assert.equal(await code(verifyPeerCredential(certificate, { now: start - 31_000 })), 'not-yet-valid');
    await verifyPeerCredential(certificate, { now: start - 29_000 });
    assert.equal(await code(verifyPeerCredential(certificate, { now: start - 1000, skewSeconds: 0 })), 'not-yet-valid');
  });

  it('bounds the skew option', async () => {
    const { certificate } = await fresh();
    assert.equal(await code(verifyPeerCredential(certificate, { now: T0, skewSeconds: 301 })), 'bad-argument');
    assert.equal(await code(verifyPeerCredential(certificate, { now: T0, skewSeconds: -1 })), 'bad-argument');
  });

  it('refuses a certificate not signed by its identity key (forged identity field)', async () => {
    const { certificate } = await fresh();
    const other = await PodIdentity.generate();
    const forged = new Uint8Array(certificate);
    forged.set(await other.rawPublicKey(), 7); // swap the identity key, keep the signature
    assert.equal(await code(verifyPeerCredential(forged, { now: T0 })), 'bad-signature');
  });

  it('refuses a certificate signed by a different key than it names', async () => {
    const identity = await PodIdentity.generate();
    const impostor = await PodIdentity.generate();
    const sess = await PodIdentity.generate({ extractable: false });
    const issued = await issueSessionCertificate(impostor, { sessionPublicKey: await sess.rawPublicKey(), scope: ['*'], now: T0 });
    // present impostor's certificate as if it were identity's
    const bad = new Uint8Array(issued.certificate);
    bad.set(await identity.rawPublicKey(), 7);
    assert.equal(await code(verifyPeerCredential(bad, { now: T0 })), 'bad-signature');
  });

  it('refuses a tampered scope, session key, serial or time', async () => {
    const { certificate } = await fresh();
    const c = decodeSessionCertificate(certificate);
    const at = c.body.length;
    for (const [label, offset] of [['session key', 7 + 34 + 2], ['serial', 7 + 34 + 34 + 2], ['notBefore', 7 + 34 + 34 + 18 + 7], ['notAfter', 7 + 34 + 34 + 18 + 8 + 7], ['scope bytes', at - 3]]) {
      const bad = new Uint8Array(certificate);
      bad[offset] ^= 1;
      const got = await code(verifyPeerCredential(bad, { now: T0 + 1000 }));
      assert.ok(['bad-signature', 'malformed'].includes(got), `${label}: ${got}`);
    }
  });

  it('refuses a widened scope re-encoded with the original signature', async () => {
    const { certificate, identityKey, sessionKey } = await fresh();
    const c = decodeSessionCertificate(certificate);
    const wider = encodeSessionCertificateBody({ identityKey, sessionKey, serial: c.serial, notBefore: c.notBefore, notAfter: c.notAfter, scope: ['*'] });
    const sig = c.signature;
    const forged = new Uint8Array(wider.length + 2 + 64);
    forged.set(wider, 0);
    forged.set([0, 64], wider.length);
    forged.set(sig, wider.length + 2);
    assert.equal(await code(verifyPeerCredential(forged, { now: T0 + 1000 })), 'bad-signature');
  });

  it('refuses a lifetime over the verifier maximum, whatever the issuer chose', async () => {
    const identity = await PodIdentity.generate();
    const s = await createSession(identity, { scope: ['*'], now: T0, ttlSeconds: 90000, maxLifetimeSeconds: 100000 });
    assert.equal(await code(verifyPeerCredential(s.certificate, { now: T0 + 1000 })), 'lifetime-too-long');
    await verifyPeerCredential(s.certificate, { now: T0 + 1000, maxLifetimeSeconds: 100000 });
  });

  it('issuing refuses an over-long lifetime, an empty scope, and notAfter <= notBefore', async () => {
    const identity = await PodIdentity.generate();
    const sk = await (await PodIdentity.generate()).rawPublicKey();
    assert.equal(await code(issueSessionCertificate(identity, { sessionPublicKey: sk, scope: ['*'], ttlSeconds: 86401 })), 'lifetime-too-long');
    assert.equal(await code(issueSessionCertificate(identity, { sessionPublicKey: sk, scope: [] })), 'bad-argument');
    assert.equal(await code(issueSessionCertificate(identity, { sessionPublicKey: sk, scope: ['*'], notBefore: 100, notAfter: 100 })), 'invalid-lifetime');
  });

  it('refuses a chain: a list of certificates, and a session key issuing a certificate', async () => {
    const identity = await PodIdentity.generate();
    const a = await createSession(identity, { scope: ['*'], now: T0 });
    // the session key tries to delegate
    assert.equal(
      await code(issueSessionCertificate(a.session, { sessionPublicKey: await (await PodIdentity.generate()).rawPublicKey(), scope: ['*'], now: T0 })),
      'chain-too-long'
    );
    // a second certificate signed by the session key through its raw signer, presented as a chain
    const rogue = await PodIdentity.fromSigner({ publicKey: a.sessionKey, sign: (d) => a.session.sign(d) });
    const b = await issueSessionCertificate(rogue, { sessionPublicKey: await (await PodIdentity.generate()).rawPublicKey(), scope: ['*'], now: T0 });
    assert.equal(await code(verifyPeerCredential([a.certificate, b.certificate], { now: T0 + 1000 })), 'chain-too-long');
    // and the delegated certificate alone does not speak for the real identity
    assert.equal(await code(verifyPeerCredential(b.certificate, { now: T0 + 1000, expectedIdentity: identity.podId })), 'wrong-identity');
  });

  it('expectedIdentity accepts the pod id or the raw key and refuses another identity', async () => {
    const { certificate, identity } = await fresh();
    await verifyPeerCredential(certificate, { now: T0, expectedIdentity: identity.podId });
    await verifyPeerCredential(certificate, { now: T0, expectedIdentity: await identity.rawPublicKey() });
    const other = await PodIdentity.generate();
    assert.equal(await code(verifyPeerCredential(certificate, { now: T0, expectedIdentity: other.podId })), 'wrong-identity');
  });

  it('requireScope: covered, wildcard, and denied; an empty scope grants nothing', async () => {
    const { certificate } = await fresh();
    await verifyPeerCredential(certificate, { now: T0, requireScope: 'chat:room1:read' });
    assert.equal(await code(verifyPeerCredential(certificate, { now: T0, requireScope: 'chat:room1:write' })), 'scope-denied');
    assert.equal(scopeAllows(['*'], 'anything:at:all'), true);
    assert.equal(scopeAllows([], 'chat:room1:read'), false);
    assert.equal(scopeAllows(['chat:*:read'], ''), false);
  });

  it('refuses malformed input: truncated, trailing bytes, wrong magic, unknown version, unsorted scope', async () => {
    const { certificate } = await fresh();
    assert.equal(await code(verifyPeerCredential(certificate.subarray(0, certificate.length - 1), { now: T0 })), 'malformed');
    assert.equal(await code(verifyPeerCredential(new Uint8Array([...certificate, 0]), { now: T0 })), 'malformed');
    const wrongMagic = new Uint8Array(certificate); wrongMagic[0] = 0;
    assert.equal(await code(verifyPeerCredential(wrongMagic, { now: T0 })), 'malformed');
    const v2 = new Uint8Array(certificate); v2[4] = 2;
    assert.equal(await code(verifyPeerCredential(v2, { now: T0 })), 'unsupported-version');
    const unsorted = hex(V.cert);
    // swap the first two scope entries' first bytes so order is violated
    const i = toHex(unsorted).indexOf('00052a3a623a63') / 2;
    unsorted[i + 2] = 0x7a; // '*:b:c' -> 'z:b:c' sorts after 'chat...'
    assert.equal(await code(verifyPeerCredential(unsorted, { now: T0 })), 'malformed');
    assert.equal(await code(verifyPeerCredential('!!!not base64!!!', { now: T0 })), 'malformed');
  });

  it('proof of possession: the session key signature, not just the certificate', async () => {
    const { certificate, session } = await fresh();
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const signature = await createSessionProof(session, challenge);
    await verifyPeerCredential(certificate, { now: T0, proof: { challenge, signature } });
    const thief = await PodIdentity.generate();
    const stolen = await createSessionProof(thief, challenge);
    assert.equal(await code(verifyPeerCredential(certificate, { now: T0, proof: { challenge, signature: stolen } })), 'bad-proof');
    assert.equal(await code(verifyPeerCredential(certificate, { now: T0, proof: { challenge: new Uint8Array(32), signature } })), 'bad-proof');
  });

  it('a signature made for another purpose does not verify as a certificate or revocation', async () => {
    const identity = await PodIdentity.generate();
    const sk = await (await PodIdentity.generate()).rawPublicKey();
    const issued = await issueSessionCertificate(identity, { sessionPublicKey: sk, scope: ['*'], now: T0 });
    const body = decodeSessionCertificate(issued.certificate).body;
    // the same body signed WITHOUT the domain prefix must not verify
    const plain = await identity.sign(body);
    const forged = new Uint8Array([...body, 0, 64, ...plain]);
    assert.equal(await code(verifyPeerCredential(forged, { now: T0 })), 'bad-signature');
  });
});

describe('session identity: the identity key is used once per session', () => {
  it('a counting signer signs once for the certificate, never per message', async () => {
    const signer = await countingSigner();
    const identity = await PodIdentity.fromSigner(signer);
    const s = await createSession(identity, { scope: ['chat:*:*'], now: T0 });
    assert.equal(signer.uses, 1);
    for (let i = 0; i < 50; i++) {
      const msg = new TextEncoder().encode(`m${i}`);
      const sig = await s.session.sign(msg);
      assert.equal(await verifyWithRawPublicKey(s.sessionKey, sig, msg), true);
    }
    assert.equal(signer.uses, 1, 'messages must be signed by the session key');
    const r = await verifyPeerCredential(s.certificate, { now: T0 + 1000, expectedIdentity: identity.podId });
    assert.deepEqual(r.identityKey, signer.publicKey);
    assert.equal(signer.uses, 1);
  });

  it('the session key is non-extractable', async () => {
    const identity = await PodIdentity.generate();
    const s = await createSession(identity, { scope: ['*'], now: T0 });
    assert.equal(s.session.extractable, false);
    await assert.rejects(crypto.subtle.exportKey('jwk', s.session.keyPair.privateKey));
    await assert.rejects(s.session.exportPrivateKey());
  });

  it('nothing here exports a private key', async () => {
    const calls = [];
    const orig = crypto.subtle.exportKey;
    crypto.subtle.exportKey = function (format, key) { calls.push(key.type); return orig.call(this, format, key); };
    try {
      const identity = await PodIdentity.generate({ extractable: false });
      const s = await createSession(identity, { scope: ['*'], now: T0 });
      const store = new MemoryRevocationStore({ clock: () => T0 });
      await verifyPeerCredential(s.certificate, { now: T0, revocations: store });
      await receiveRevocation(await revokeSessionCertificate(identity, s.certificate, { now: T0 }), store);
      await receiveRevocation(await retireIdentity(identity, { now: T0 }), store);
    } finally {
      crypto.subtle.exportKey = orig;
    }
    assert.ok(calls.length > 0);
    assert.ok(calls.every((t) => t === 'public'), `exportKey called on: ${calls}`);
  });
});

describe('revocation', () => {
  async function setup() {
    const identity = await PodIdentity.generate();
    const s = await createSession(identity, { scope: ['*'], now: T0, ttlSeconds: 600 });
    const store = new MemoryRevocationStore({ clock: () => T0 });
    return { identity, s, store };
  }

  it('a revoked certificate is refused; a sibling certificate is not', async () => {
    const { identity, s, store } = await setup();
    const sibling = await createSession(identity, { scope: ['*'], now: T0, ttlSeconds: 600 });
    await verifyPeerCredential(s.certificate, { now: T0, revocations: store });
    const rev = await revokeSessionCertificate(identity, s.certificate, { now: T0 });
    assert.equal((await receiveRevocation(rev, store)).status, 'added');
    assert.equal(await code(verifyPeerCredential(s.certificate, { now: T0, revocations: store })), 'revoked');
    await verifyPeerCredential(sibling.certificate, { now: T0, revocations: store });
    assert.equal(await isRevoked(decodeSessionCertificate(s.certificate), store), true);
    assert.equal(await isRevoked(decodeSessionCertificate(sibling.certificate), store), false);
  });

  it('retiring an identity refuses all its certificates, including ones issued later', async () => {
    const { identity, s, store } = await setup();
    await receiveRevocation(await retireIdentity(identity, { now: T0 }), store);
    assert.equal(await code(verifyPeerCredential(s.certificate, { now: T0, revocations: store })), 'revoked');
    const later = await createSession(identity, { scope: ['*'], now: T0 + 1000 });
    assert.equal(await code(verifyPeerCredential(later.certificate, { now: T0 + 1000, revocations: store })), 'revoked');
  });

  it('only the issuing identity may revoke: a stranger cannot revoke someone else\'s session', async () => {
    const { s, store } = await setup();
    const stranger = await PodIdentity.generate();
    await assert.rejects(revokeSessionCertificate(stranger, s.certificate), (e) => e.code === 'wrong-identity');
    // a stranger-signed statement about the victim's serial is bound to the stranger's key, so it does not match
    const decoded = decodeSessionCertificate(s.certificate);
    const own = await createSession(stranger, { scope: ['*'], now: T0, serial: decoded.serial });
    const rev = await revokeSessionCertificate(stranger, own.certificate, { now: T0 });
    await receiveRevocation(rev, store);
    await verifyPeerCredential(s.certificate, { now: T0, revocations: store });
  });

  it('refuses a forged or altered revocation', async () => {
    const { identity, s } = await setup();
    const rev = await revokeSessionCertificate(identity, s.certificate, { now: T0 });
    const swapped = new Uint8Array(rev);
    swapped.set(await (await PodIdentity.generate()).rawPublicKey(), 8);
    assert.equal(await code(verifyRevocation(swapped)), 'bad-signature');
    const flipped = new Uint8Array(rev); flipped[flipped.length - 1] ^= 1;
    assert.equal(await code(verifyRevocation(flipped)), 'bad-signature');
    assert.equal(await code(verifyRevocation(new Uint8Array(rev.subarray(0, 20)))), 'malformed');
  });

  it('is idempotent: a repeat is a duplicate and fires no second event', async () => {
    const { identity, s, store } = await setup();
    const events = [];
    const off = store.onRevocation((e) => events.push(e));
    const rev = await revokeSessionCertificate(identity, s.certificate, { now: T0 });
    assert.equal((await receiveRevocation(rev, store)).status, 'added');
    assert.equal((await receiveRevocation(rev, store)).status, 'duplicate');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].bytes, rev);
    assert.equal(store.size, 1);
    off();
    await receiveRevocation(await retireIdentity(identity, { now: T0 }), store);
    assert.equal(events.length, 1, 'unsubscribed');
  });

  it('a revocation can arrive before the certificate does', async () => {
    const { identity, s, store } = await setup();
    await receiveRevocation(await revokeSessionCertificate(identity, s.certificate, { now: T0 }), store);
    assert.equal(await code(verifyPeerCredential(s.certificate, { now: T0, revocations: store })), 'revoked');
  });

  it('is forwardable: bytes from one store feed another', async () => {
    const { identity, s, store } = await setup();
    const other = new MemoryRevocationStore({ clock: () => T0 });
    const pending = [];
    store.onRevocation(({ bytes }) => pending.push(receiveRevocation(bytes, other)));
    await receiveRevocation(await revokeSessionCertificate(identity, s.certificate, { now: T0 }), store);
    await Promise.all(pending);
    assert.equal(await code(verifyPeerCredential(s.certificate, { now: T0, revocations: other })), 'revoked');
    assert.equal(store.list().length, 1);
  });

  it('drops a certificate revocation after the certificate\'s own notAfter (plus maximum skew)', async () => {
    const { identity, s } = await setup();
    let clock = T0;
    const store = new MemoryRevocationStore({ clock: () => clock });
    await receiveRevocation(await revokeSessionCertificate(identity, s.certificate, { now: T0 }), store);
    clock = T0 + (600 + 299) * 1000;
    assert.equal(store.prune(), 0);
    clock = T0 + (600 + 300) * 1000;
    assert.equal(store.prune(), 1);
    assert.equal(store.size, 0);
    // an already-moot revocation is not stored at all
    const rev = await revokeSessionCertificate(identity, s.certificate, { now: T0 });
    assert.equal((await receiveRevocation(rev, store)).status, 'ignored');
    // retirements are kept
    await receiveRevocation(await retireIdentity(identity, { now: clock }), store);
    clock += 10 * 86400 * 1000;
    assert.equal(store.prune(), 0);
    assert.equal(store.isRevoked(await identity.rawPublicKey(), null), true);
  });

  it('is bounded: expired entries go first, then the soonest-expiring; retirements are kept', async () => {
    const store = new MemoryRevocationStore({ maxEntries: 3, clock: () => T0 });
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const id = await PodIdentity.generate();
      const s = await createSession(id, { scope: ['*'], now: T0, ttlSeconds: 1000 + i * 100 });
      ids.push({ id, s });
      await receiveRevocation(await revokeSessionCertificate(id, s.certificate, { now: T0 }), store);
    }
    assert.equal(store.size, 3);
    const extra = await PodIdentity.generate();
    const sx = await createSession(extra, { scope: ['*'], now: T0, ttlSeconds: 5000 });
    await receiveRevocation(await revokeSessionCertificate(extra, sx.certificate, { now: T0 }), store);
    assert.equal(store.size, 3);
    // the soonest-expiring (ids[0]) was evicted, the rest remain
    assert.equal(store.isRevoked(ids[0].s.identityKey, decodeSessionCertificate(ids[0].s.certificate).serial), false);
    assert.equal(store.isRevoked(ids[2].s.identityKey, decodeSessionCertificate(ids[2].s.certificate).serial), true);

    const full = new MemoryRevocationStore({ maxEntries: 2, clock: () => T0 });
    await receiveRevocation(await retireIdentity(await PodIdentity.generate(), { now: T0 }), full);
    await receiveRevocation(await retireIdentity(await PodIdentity.generate(), { now: T0 }), full);
    const late = await PodIdentity.generate();
    await assert.rejects(receiveRevocation(await retireIdentity(late, { now: T0 }), full), (e) => e.code === 'store-full');
    assert.equal(full.size, 2);
  });

  it('a filter lets a peer ignore identities it does not care about', async () => {
    const { identity, s } = await setup();
    const known = await identity.rawPublicKey();
    const store = new MemoryRevocationStore({ clock: () => T0, filter: (st) => st.identityKey.every((b, i) => b === known[i]) });
    const other = await PodIdentity.generate();
    assert.equal((await receiveRevocation(await retireIdentity(other, { now: T0 }), store)).status, 'ignored');
    assert.equal(store.size, 0);
    assert.equal((await receiveRevocation(await revokeSessionCertificate(identity, s.certificate, { now: T0 }), store)).status, 'added');
  });

  it('a failing revocation store fails closed', async () => {
    const { s } = await setup();
    const broken = { isRevoked() { throw new Error('db down'); }, add() {} };
    assert.equal(await code(verifyPeerCredential(s.certificate, { now: T0, revocations: broken })), 'revoked');
  });

  it('works with an asynchronous custom store', async () => {
    const { identity, s } = await setup();
    const seen = new Set();
    const custom = {
      async add(st) { const k = encodeBase64url(st.serial); const fresh = !seen.has(k); seen.add(k); return fresh; },
      async isRevoked(_id, serial) { return seen.has(encodeBase64url(serial)); },
    };
    await receiveRevocation(await revokeSessionCertificate(identity, s.certificate, { now: T0 }), custom);
    assert.equal(await code(verifyPeerCredential(s.certificate, { now: T0, revocations: custom })), 'revoked');
  });
});
