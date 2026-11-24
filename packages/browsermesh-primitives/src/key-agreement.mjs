/**
 * key-agreement.mjs -- key agreement keys bound to pod ids, and sealing to them.
 *
 * A pod id is the hash of an Ed25519 identity key. That key signs; it does not
 * agree on secrets. An X25519 key is a separate key, so nothing about a pod id
 * tells a sender which X25519 key to encrypt to. A **key statement** closes the
 * gap: the identity key signs "this X25519 key is mine, from now until then".
 * A receiver of a statement checks the signature against the pod id (the hash
 * of the key inside the statement) before it uses the X25519 key for anything.
 *
 *   signed bytes = "browsermesh/key-agreement/v1\n" +
 *                  JSON [podId, pk, ka, notBefore, notAfter]      (fixed order)
 *
 *   statement = { v: 1, podId, pk, ka, kid, notBefore, notAfter, sig }
 *     pk   raw Ed25519 public key (base64url), podId must be its hash
 *     ka   raw X25519 public key (base64url)
 *     kid  names ka: first 16 bytes of SHA-256(ka), base64url (checked, not trusted)
 *
 * A statement expires (at most 24 h after `notBefore`, no grace after
 * `notAfter`), is refused when the identity has been retired in the revocation
 * store used for session certificates, and is rotated by issuing a new one.
 *
 * **Sealing** is ephemeral-static: for each message the sender makes a fresh
 * X25519 key pair, agrees with the statement's `ka`, derives an AES-256-GCM key
 * with HKDF-SHA-256 (salt = ephemeral public key || ka), and encrypts with the
 * caller's header as additional authenticated data. Because the key is fresh for
 * every message, the (key, nonce) pair cannot repeat; the 12-byte nonce is
 * random as well. The sender throws its ephemeral private key away, so a later
 * compromise of the SENDER reveals nothing about what it sealed. A later
 * compromise of the RECIPIENT's static agreement key reveals every message
 * sealed to it, unless the recipient has already deleted that key: rotation
 * (and deleting expired private keys) bounds the exposure to one statement
 * lifetime. There is no sender authentication at this layer; the signed
 * envelope around the sealed bytes provides it.
 *
 * Browser-safe: WebCrypto only (X25519, HKDF, AES-GCM, Ed25519).
 */

import { encodeBase64url, decodeBase64url } from './identity.mjs';
import { verifyWithRawPublicKey, podIdFromRawKey } from './session.mjs';

export const KEY_STATEMENT_VERSION = 1;
export const STATEMENT_DOMAIN = 'browsermesh/key-agreement/v1\n';
export const SEAL_DOMAIN = 'browsermesh/sealed/v1';
/** A statement never lives longer than this. */
export const MAX_STATEMENT_LIFETIME_MS = 24 * 3_600_000;
export const DEFAULT_STATEMENT_LIFETIME_MS = 2 * 3_600_000;
/** Clock skew tolerated before `notBefore`. There is none after `notAfter`. */
export const DEFAULT_SKEW_MS = 30_000;
/** Largest plaintext sealed or opened unless the caller says otherwise. */
export const DEFAULT_MAX_SEALED_BYTES = 256 * 1024;

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const enc = new TextEncoder();

/** Every refusal. `code`: malformed | unsupported-version | pod-id-mismatch | bad-signature | not-yet-valid | expired | invalid-lifetime | lifetime-too-long | wrong-identity | identity-retired | unknown-key | open-failed | too-large | bad-argument | unsupported */
export class KeyAgreementError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KeyAgreementError';
    this.code = code;
  }
}

const b64len = (n) => Math.ceil((n * 4) / 3);
const isB64 = (s, bytes) => typeof s === 'string' && s.length === b64len(bytes) && /^[A-Za-z0-9_-]+$/.test(s);

/** Whether this environment's WebCrypto can do X25519 (Node 18.4+, Chromium 133+, Firefox 130+, Safari 17+ per MDN). Never throws. */
export async function supportsKeyAgreement() {
  try {
    await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
    return true;
  } catch {
    return false;
  }
}

/**
 * A fresh X25519 key pair for key agreement. The private key is not extractable.
 *
 * @returns {Promise<{ privateKey: CryptoKey, publicKeyRaw: Uint8Array }>}
 */
export async function generateAgreementKeyPair() {
  let pair;
  try {
    pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  } catch (err) {
    throw new KeyAgreementError('unsupported', `X25519 is not available here: ${err?.message ?? err}`);
  }
  const publicKeyRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  // Re-import the private key as non-extractable so it cannot be read back out.
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'X25519' }, false, ['deriveBits']);
  return { privateKey, publicKeyRaw };
}

/** @param {Uint8Array} ka @returns {Promise<string>} */
export async function keyIdOf(ka) {
  return encodeBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256', ka)).subarray(0, 16));
}

function signingInput({ podId, pk, ka, notBefore, notAfter }) {
  return enc.encode(STATEMENT_DOMAIN + JSON.stringify([podId, pk, ka, notBefore, notAfter]));
}

/**
 * Sign a key statement for `agreement` with the pod's identity key.
 *
 * @param {{ podId: string, sign: (data: Uint8Array) => Promise<Uint8Array>|Uint8Array, rawPublicKey: () => Promise<Uint8Array> }} identity - a `PodIdentity`, or anything shaped like one
 * @param {{ publicKeyRaw: Uint8Array }} agreement - from `generateAgreementKeyPair()`
 * @param {{ now?: number, lifetimeMs?: number }} [opts]
 * @returns {Promise<object>} the statement (plain JSON)
 */
export async function createKeyStatement(identity, agreement, { now = Date.now(), lifetimeMs = DEFAULT_STATEMENT_LIFETIME_MS } = {}) {
  if (!Number.isInteger(lifetimeMs) || lifetimeMs <= 0) throw new KeyAgreementError('bad-argument', 'lifetimeMs must be a positive integer');
  if (lifetimeMs > MAX_STATEMENT_LIFETIME_MS) throw new KeyAgreementError('lifetime-too-long', `a statement lives at most ${MAX_STATEMENT_LIFETIME_MS} ms`);
  if (!Number.isSafeInteger(now)) throw new KeyAgreementError('bad-argument', 'now must be a whole number of milliseconds');
  const pk = encodeBase64url(await identity.rawPublicKey());
  const ka = encodeBase64url(agreement.publicKeyRaw);
  const body = { podId: identity.podId, pk, ka, notBefore: now, notAfter: now + lifetimeMs };
  const sig = encodeBase64url(new Uint8Array(await identity.sign(signingInput(body))));
  return { v: KEY_STATEMENT_VERSION, ...body, kid: await keyIdOf(agreement.publicKeyRaw), sig };
}

/**
 * Check a statement and return what may be trusted from it. Throws a
 * `KeyAgreementError` for anything wrong with it.
 *
 * @param {object} statement
 * @param {object} [opts]
 * @param {number} [opts.now=Date.now()] - ms
 * @param {number} [opts.skewMs=30000]
 * @param {string} [opts.expectedPodId] - refuse a statement for another pod
 * @param {{ isRevoked: (identityKey: Uint8Array, serial: Uint8Array|null) => boolean|Promise<boolean> }} [opts.revocations] - the store `receiveRevocation()` feeds; a retired identity is refused. A store that throws fails closed.
 * @returns {Promise<{ podId: string, pk: Uint8Array, ka: Uint8Array, kid: string, notBefore: number, notAfter: number }>}
 */
export async function verifyKeyStatement(statement, { now = Date.now(), skewMs = DEFAULT_SKEW_MS, expectedPodId, revocations } = {}) {
  const s = statement;
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new KeyAgreementError('malformed', 'a statement is an object');
  if (s.v !== KEY_STATEMENT_VERSION) throw new KeyAgreementError(s.v === undefined ? 'malformed' : 'unsupported-version', 'unsupported statement version');
  if (typeof s.podId !== 'string' || s.podId.length === 0 || s.podId.length > 128
    || !isB64(s.pk, KEY_BYTES) || !isB64(s.ka, KEY_BYTES) || !isB64(s.sig, 64)
    || !Number.isSafeInteger(s.notBefore) || !Number.isSafeInteger(s.notAfter)) {
    throw new KeyAgreementError('malformed', 'a statement has podId, pk, ka, sig, notBefore and notAfter');
  }
  if (s.notAfter <= s.notBefore) throw new KeyAgreementError('invalid-lifetime', 'notAfter is not after notBefore');
  if (s.notAfter - s.notBefore > MAX_STATEMENT_LIFETIME_MS) throw new KeyAgreementError('lifetime-too-long', 'the statement lives too long');

  const pk = decodeBase64url(s.pk);
  if ((await podIdFromRawKey(pk)) !== s.podId) throw new KeyAgreementError('pod-id-mismatch', 'the signing key is not the pod id the statement names');
  if (expectedPodId !== undefined && expectedPodId !== s.podId) throw new KeyAgreementError('wrong-identity', 'the statement is for a different pod');
  if (!(await verifyWithRawPublicKey(pk, decodeBase64url(s.sig), signingInput(s)))) {
    throw new KeyAgreementError('bad-signature', 'the statement is not signed by its identity key');
  }
  if (now < s.notBefore - skewMs) throw new KeyAgreementError('not-yet-valid', 'the statement is not valid yet');
  if (now >= s.notAfter) throw new KeyAgreementError('expired', 'the statement has expired');
  if (revocations) {
    let revoked;
    try { revoked = await revocations.isRevoked(pk, null); } catch { revoked = true; }
    if (revoked) throw new KeyAgreementError('identity-retired', 'the identity has been retired');
  }
  const ka = decodeBase64url(s.ka);
  return { podId: s.podId, pk, ka, kid: await keyIdOf(ka), notBefore: s.notBefore, notAfter: s.notAfter };
}

async function deriveKey(sharedBits, epk, ka, usage) {
  const salt = new Uint8Array(epk.length + ka.length);
  salt.set(epk, 0);
  salt.set(ka, epk.length);
  const hkdf = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(`${SEAL_DOMAIN} key`) },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  );
}

function aadBytes(aad) {
  const head = enc.encode(`${SEAL_DOMAIN}\0`);
  const out = new Uint8Array(head.length + aad.length);
  out.set(head, 0);
  out.set(aad, head.length);
  return out;
}

/**
 * Seal `plaintext` so only the holder of the statement's agreement key can open it.
 *
 * @param {{ ka: Uint8Array, kid: string }} verified - the result of `verifyKeyStatement()`; never an unverified statement
 * @param {object} opts
 * @param {Uint8Array} opts.aad - the header the ciphertext belongs to; opening needs the same bytes
 * @param {Uint8Array} opts.plaintext
 * @param {number} [opts.maxBytes=262144]
 * @returns {Promise<{ v: 1, kid: string, epk: string, iv: string, ct: string }>}
 */
export async function sealToStatement(verified, { aad, plaintext, maxBytes = DEFAULT_MAX_SEALED_BYTES }) {
  if (!(plaintext instanceof Uint8Array) || !(aad instanceof Uint8Array)) throw new KeyAgreementError('bad-argument', 'aad and plaintext are bytes');
  if (plaintext.length > maxBytes) throw new KeyAgreementError('too-large', `the message is ${plaintext.length} bytes; the limit is ${maxBytes}`);
  const ephemeral = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  const epk = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const recipient = await crypto.subtle.importKey('raw', verified.ka, { name: 'X25519' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: recipient }, ephemeral.privateKey, 256);
  const key = await deriveKey(shared, epk, verified.ka, 'encrypt');
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aadBytes(aad), tagLength: TAG_BYTES * 8 }, key, plaintext));
  return { v: 1, kid: verified.kid, epk: encodeBase64url(epk), iv: encodeBase64url(iv), ct: encodeBase64url(ct) };
}

/**
 * Open what `sealToStatement()` made.
 *
 * @param {object} sealed
 * @param {object} opts
 * @param {Map<string, { privateKey: CryptoKey, publicKeyRaw: Uint8Array }>|((kid: string) => { privateKey: CryptoKey, publicKeyRaw: Uint8Array }|undefined)} opts.privateKeys - the recipient's agreement key pairs (`generateAgreementKeyPair()`) by key id: the current one and the not-yet-expired older ones
 * @param {Uint8Array} opts.aad
 * @param {number} [opts.maxBytes=262144]
 * @returns {Promise<Uint8Array>}
 */
export async function openSealed(sealed, { privateKeys, aad, maxBytes = DEFAULT_MAX_SEALED_BYTES }) {
  if (!sealed || typeof sealed !== 'object' || sealed.v !== 1 || typeof sealed.kid !== 'string'
    || !isB64(sealed.epk, KEY_BYTES) || !isB64(sealed.iv, IV_BYTES) || typeof sealed.ct !== 'string' || !/^[A-Za-z0-9_-]*$/.test(sealed.ct)) {
    throw new KeyAgreementError('malformed', 'not a sealed message');
  }
  if (sealed.ct.length > b64len(maxBytes + TAG_BYTES) + 4) throw new KeyAgreementError('too-large', 'the sealed message is larger than the limit');
  const pair = typeof privateKeys === 'function' ? privateKeys(sealed.kid) : privateKeys.get(sealed.kid);
  if (!pair) throw new KeyAgreementError('unknown-key', 'sealed to a key this pod does not hold (any more)');
  const epk = decodeBase64url(sealed.epk);
  const ct = decodeBase64url(sealed.ct);
  if (ct.length < TAG_BYTES) throw new KeyAgreementError('malformed', 'too short');
  if (ct.length - TAG_BYTES > maxBytes) throw new KeyAgreementError('too-large', 'the sealed message is larger than the limit');
  try {
    const sender = await crypto.subtle.importKey('raw', epk, { name: 'X25519' }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: 'X25519', public: sender }, pair.privateKey, 256);
    // The recipient's own public key is part of the key derivation, as it was when sealing.
    const ka = pair.publicKeyRaw;
    if ((await keyIdOf(ka)) !== sealed.kid) throw new Error('kid');
    const key = await deriveKey(shared, epk, ka, 'decrypt');
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeBase64url(sealed.iv), additionalData: aadBytes(aad), tagLength: TAG_BYTES * 8 }, key, ct));
  } catch {
    throw new KeyAgreementError('open-failed', 'the sealed message did not open');
  }
}
