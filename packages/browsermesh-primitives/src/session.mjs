/**
 * Session certificates and signed revocation.
 *
 * A long-lived identity key signs a short-lived SESSION key (a certificate with
 * a scope and a validity window). The identity key is then used rarely -- once
 * per session -- while the session key signs the traffic. A stolen session key
 * stops working when its certificate expires, or sooner if the identity signs a
 * REVOCATION that peers hear of.
 *
 * Rules, in one place:
 *
 * - Chain length is exactly one. A session key cannot issue certificates
 *   (`issueSessionCertificate` refuses a session identity) and a credential
 *   presented as a list of more than one certificate is refused.
 * - Scope is a list of capability strings (the `namespace:resource:action`
 *   form `matchScope` understands, `*` per part). An EMPTY scope grants
 *   nothing: issuing refuses it, and `scopeAllows` is false for every request.
 *   "Everything the identity may" must be written out as `'*'`.
 * - Time is whole seconds. A certificate is valid during
 *   `[notBefore - skew, notAfter + skew)`; `skewSeconds` defaults to 30 and is
 *   capped at 300. A verifier also enforces its OWN maximum lifetime
 *   (`maxLifetimeSeconds`, default 24 h) whatever the issuer chose.
 * - A revocation is only ever valid when signed by the identity key it names,
 *   so a key can revoke its own sessions and retire itself, nothing else.
 *
 * Wire encodings (all integers big-endian; `field` = u16 length + bytes):
 *
 *   certificate  = "BMSC" | u8 version=1 | field identityKey(32) | field sessionKey(32)
 *                  | field serial(16) | u64 notBefore | u64 notAfter
 *                  | u16 scopeCount | field scope...   (scopes sorted bytewise, unique)
 *                  | field signature(64)
 *   revocation   = "BMRV" | u8 version=1 | u8 kind (1 session, 2 identity)
 *                  | field identityKey(32) | field serial (16, or empty for kind 2)
 *                  | u64 issuedAt | u64 retainUntil (0 = forever) | field signature(64)
 *
 * The signature covers `domain + body` where `body` is everything before the
 * signature field and `domain` is the ASCII string
 * `browsermesh/session-certificate/v1\n` or `browsermesh/revocation/v1\n`, so
 * a signature made for one purpose never verifies as another.
 */

import { PodIdentity, encodeBase64url, decodeBase64url } from './identity.mjs';
import { matchScope } from './capability.mjs';

export const CERT_VERSION = 1;
export const DEFAULT_MAX_LIFETIME_SECONDS = 86400;
export const DEFAULT_SKEW_SECONDS = 30;
export const MAX_SKEW_SECONDS = 300;
export const MAX_SCOPE_ENTRIES = 64;
export const MAX_SCOPE_ENTRY_BYTES = 256;
export const DEFAULT_REVOCATION_STORE_SIZE = 10000;

const CERT_MAGIC = [0x42, 0x4d, 0x53, 0x43]; // BMSC
const REV_MAGIC = [0x42, 0x4d, 0x52, 0x56]; // BMRV
const CERT_DOMAIN = 'browsermesh/session-certificate/v1\n';
const REV_DOMAIN = 'browsermesh/revocation/v1\n';
const PROOF_DOMAIN = 'browsermesh/session-proof/v1\n';
const KEY_BYTES = 32;
const SERIAL_BYTES = 16;
const SIG_BYTES = 64;
const MAX_U64 = (1n << 64n) - 1n;

/** Revocation kinds. */
export const REVOCATION_KIND = Object.freeze({ SESSION: 1, IDENTITY: 2 });

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

/** Error thrown for every refusal; `code` says why. */
export class CredentialError extends Error {
  /**
   * @param {string} code - malformed | unsupported-version | bad-signature | not-yet-valid | expired |
   *   invalid-lifetime | lifetime-too-long | chain-too-long | revoked | identity-retired |
   *   wrong-identity | scope-denied | bad-proof | bad-argument | store-full
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'CredentialError';
    this.code = code;
  }
}

/** Session identities created by `createSession`: they may not issue certificates. */
const sessionIdentities = new WeakSet();

// ---------------------------------------------------------------------------
// byte helpers
// ---------------------------------------------------------------------------

function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function u16(n) {
  return new Uint8Array([(n >>> 8) & 0xff, n & 0xff]);
}

function u64(n) {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n));
  return out;
}

function field(bytes) {
  if (bytes.length > 0xffff) throw new CredentialError('bad-argument', 'field too long');
  return concat(u16(bytes.length), bytes);
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function compareBytes(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

class Reader {
  constructor(bytes) { this.b = bytes; this.o = 0; }
  take(n) {
    if (this.o + n > this.b.length) throw new CredentialError('malformed', 'truncated');
    const out = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return out;
  }
  u8() { return this.take(1)[0]; }
  u16() { const t = this.take(2); return (t[0] << 8) | t[1]; }
  u64() {
    const v = new DataView(this.b.buffer, this.b.byteOffset + this.o, 8).getBigUint64(0);
    this.take(8);
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new CredentialError('malformed', 'time out of range');
    return Number(v);
  }
  field() { return this.take(this.u16()); }
  done() { if (this.o !== this.b.length) throw new CredentialError('malformed', 'trailing bytes'); }
}

function toBytes(v, what) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'string') {
    try { return decodeBase64url(v); } catch { throw new CredentialError('malformed', `${what} is not valid base64url`); }
  }
  throw new CredentialError('bad-argument', `${what} must be bytes or a base64url string`);
}

async function importRawPublic(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, true, ['verify']);
}

/**
 * Verify an Ed25519 signature against a RAW 32-byte public key. Resolves false
 * (never throws) for a bad key, a bad length or a bad signature.
 *
 * @param {Uint8Array} rawPublicKey
 * @param {Uint8Array} signature
 * @param {BufferSource} data
 * @returns {Promise<boolean>}
 */
export async function verifyWithRawPublicKey(rawPublicKey, signature, data) {
  try {
    if (rawPublicKey.length !== KEY_BYTES || signature.length !== SIG_BYTES) return false;
    return await crypto.subtle.verify('Ed25519', await importRawPublic(rawPublicKey), signature, data);
  } catch {
    return false;
  }
}

/**
 * Pod id (base64url SHA-256) of a raw public key; equals `derivePodId`.
 *
 * @param {Uint8Array} rawPublicKey
 * @returns {Promise<string>}
 */
export async function podIdFromRawKey(rawPublicKey) {
  return encodeBase64url(new Uint8Array(await crypto.subtle.digest('SHA-256', rawPublicKey)));
}

function nowSeconds(now) {
  const ms = now instanceof Date ? now.getTime() : now === undefined ? Date.now() : now;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) throw new CredentialError('bad-argument', 'now must be a finite number of milliseconds or a Date');
  return Math.floor(ms / 1000);
}

function skewOf(opts) {
  const s = opts.skewSeconds ?? DEFAULT_SKEW_SECONDS;
  if (!Number.isInteger(s) || s < 0 || s > MAX_SKEW_SECONDS) {
    throw new CredentialError('bad-argument', `skewSeconds must be an integer from 0 to ${MAX_SKEW_SECONDS}`);
  }
  return s;
}

function maxLifetimeOf(opts) {
  const m = opts.maxLifetimeSeconds ?? DEFAULT_MAX_LIFETIME_SECONDS;
  if (!Number.isInteger(m) || m < 1) throw new CredentialError('bad-argument', 'maxLifetimeSeconds must be a positive integer');
  return m;
}

// ---------------------------------------------------------------------------
// certificate encoding
// ---------------------------------------------------------------------------

function normalizeScope(scope) {
  if (!Array.isArray(scope)) throw new CredentialError('bad-argument', 'scope must be an array of strings');
  const entries = scope.map((s) => {
    if (typeof s !== 'string' || s.length === 0) throw new CredentialError('bad-argument', 'scope entries must be non-empty strings');
    const b = enc.encode(s);
    if (b.length > MAX_SCOPE_ENTRY_BYTES) throw new CredentialError('bad-argument', 'scope entry too long');
    return b;
  });
  entries.sort(compareBytes);
  const unique = entries.filter((e, i) => i === 0 || compareBytes(entries[i - 1], e) !== 0);
  if (unique.length > MAX_SCOPE_ENTRIES) throw new CredentialError('bad-argument', 'too many scope entries');
  return unique;
}

/**
 * Canonical body of a certificate (everything the signature covers, minus the
 * domain prefix). Exposed so another implementation can be checked against the
 * test vectors.
 *
 * @param {{ identityKey: Uint8Array, sessionKey: Uint8Array, serial: Uint8Array, notBefore: number, notAfter: number, scope: string[] }} c
 * @returns {Uint8Array}
 */
export function encodeSessionCertificateBody(c) {
  if (c.identityKey.length !== KEY_BYTES || c.sessionKey.length !== KEY_BYTES) throw new CredentialError('bad-argument', 'keys must be 32 bytes');
  if (c.serial.length !== SERIAL_BYTES) throw new CredentialError('bad-argument', 'serial must be 16 bytes');
  for (const t of [c.notBefore, c.notAfter]) {
    if (!Number.isSafeInteger(t) || t < 0) throw new CredentialError('bad-argument', 'times must be non-negative integer seconds');
  }
  const scope = normalizeScope(c.scope);
  return concat(
    new Uint8Array(CERT_MAGIC),
    new Uint8Array([CERT_VERSION]),
    field(c.identityKey),
    field(c.sessionKey),
    field(c.serial),
    u64(c.notBefore),
    u64(c.notAfter),
    u16(scope.length),
    ...scope.map(field)
  );
}

function certSigningInput(body) {
  return concat(enc.encode(CERT_DOMAIN), body);
}

/**
 * Parse certificate bytes WITHOUT checking the signature or the time. Strict:
 * unknown version, non-canonical scope order, wrong lengths and trailing bytes
 * are all refused. Use `verifyPeerCredential` to decide whether to trust it.
 *
 * @param {Uint8Array|string} credential - bytes or base64url
 * @returns {{ version: number, identityKey: Uint8Array, sessionKey: Uint8Array, serial: Uint8Array, notBefore: number, notAfter: number, scope: string[], signature: Uint8Array, body: Uint8Array }}
 */
export function decodeSessionCertificate(credential) {
  const bytes = toBytes(credential, 'certificate');
  const r = new Reader(bytes);
  const magic = r.take(4);
  if (!bytesEqual(magic, new Uint8Array(CERT_MAGIC))) throw new CredentialError('malformed', 'not a session certificate');
  const version = r.u8();
  if (version !== CERT_VERSION) throw new CredentialError('unsupported-version', `unsupported certificate version ${version}`);
  const identityKey = r.field();
  const sessionKey = r.field();
  const serial = r.field();
  if (identityKey.length !== KEY_BYTES || sessionKey.length !== KEY_BYTES || serial.length !== SERIAL_BYTES) {
    throw new CredentialError('malformed', 'bad key or serial length');
  }
  const notBefore = r.u64();
  const notAfter = r.u64();
  const count = r.u16();
  if (count > MAX_SCOPE_ENTRIES) throw new CredentialError('malformed', 'too many scope entries');
  const raw = [];
  for (let i = 0; i < count; i++) {
    const f = r.field();
    if (f.length === 0 || f.length > MAX_SCOPE_ENTRY_BYTES) throw new CredentialError('malformed', 'bad scope entry');
    if (i > 0 && compareBytes(raw[i - 1], f) >= 0) throw new CredentialError('malformed', 'scope is not sorted and unique');
    raw.push(f);
  }
  const body = bytes.subarray(0, r.o);
  const signature = r.field();
  if (signature.length !== SIG_BYTES) throw new CredentialError('malformed', 'bad signature length');
  r.done();
  let scope;
  try { scope = raw.map((f) => dec.decode(f)); } catch { throw new CredentialError('malformed', 'scope is not UTF-8'); }
  return {
    version,
    identityKey: new Uint8Array(identityKey),
    sessionKey: new Uint8Array(sessionKey),
    serial: new Uint8Array(serial),
    notBefore,
    notAfter,
    scope,
    signature: new Uint8Array(signature),
    body: new Uint8Array(body),
  };
}

// ---------------------------------------------------------------------------
// issuing
// ---------------------------------------------------------------------------

async function publicKeyBytes(k) {
  if (k instanceof Uint8Array) return new Uint8Array(k);
  if (k && k.type === 'public') return new Uint8Array(await crypto.subtle.exportKey('raw', k));
  throw new CredentialError('bad-argument', 'sessionPublicKey must be 32 raw bytes or a public CryptoKey');
}

/**
 * Sign a certificate for `sessionPublicKey` with the identity key. This is the
 * ONE use of the identity key per session.
 *
 * @param {PodIdentity} identity - Long-lived identity (key, non-extractable key or external signer)
 * @param {object} opts
 * @param {Uint8Array|CryptoKey} opts.sessionPublicKey
 * @param {string[]} opts.scope - Non-empty list of capability strings; use `['*']` for everything
 * @param {number} [opts.ttlSeconds=3600] - Used when `notAfter` is not given
 * @param {number} [opts.notBefore] - Seconds; default now
 * @param {number} [opts.notAfter] - Seconds
 * @param {Uint8Array} [opts.serial] - 16 bytes; default random
 * @param {number|Date} [opts.now] - Milliseconds; default `Date.now()`
 * @param {number} [opts.maxLifetimeSeconds=86400]
 * @returns {Promise<{ certificate: Uint8Array, serial: string, identityKey: Uint8Array, sessionKey: Uint8Array, scope: string[], notBefore: number, notAfter: number }>}
 */
export async function issueSessionCertificate(identity, opts) {
  if (!identity || typeof identity.sign !== 'function' || typeof identity.rawPublicKey !== 'function') {
    throw new CredentialError('bad-argument', 'identity must be a PodIdentity');
  }
  if (sessionIdentities.has(identity)) {
    throw new CredentialError('chain-too-long', 'a session key cannot issue certificates (chain length is exactly one)');
  }
  const scope = Array.isArray(opts.scope) ? opts.scope : null;
  if (!scope || scope.length === 0) {
    throw new CredentialError('bad-argument', "scope must list at least one capability; an empty scope grants nothing (use ['*'] for everything)");
  }
  const now = nowSeconds(opts.now);
  const notBefore = opts.notBefore ?? now;
  const notAfter = opts.notAfter ?? notBefore + (opts.ttlSeconds ?? 3600);
  if (!Number.isSafeInteger(notBefore) || !Number.isSafeInteger(notAfter) || notAfter <= notBefore) {
    throw new CredentialError('invalid-lifetime', 'notAfter must be after notBefore');
  }
  const max = maxLifetimeOf(opts);
  if (notAfter - notBefore > max) {
    throw new CredentialError('lifetime-too-long', `lifetime ${notAfter - notBefore}s exceeds the maximum ${max}s`);
  }
  const serial = opts.serial ?? crypto.getRandomValues(new Uint8Array(SERIAL_BYTES));
  const identityKey = await identity.rawPublicKey();
  const sessionKey = await publicKeyBytes(opts.sessionPublicKey);
  const body = encodeSessionCertificateBody({ identityKey, sessionKey, serial, notBefore, notAfter, scope });
  const signature = await identity.sign(certSigningInput(body));
  if (signature.length !== SIG_BYTES) throw new CredentialError('bad-argument', 'signer returned a bad signature');
  const certificate = concat(body, field(signature));
  return {
    certificate,
    serial: encodeBase64url(serial),
    identityKey,
    sessionKey,
    scope: decodeSessionCertificate(certificate).scope,
    notBefore,
    notAfter,
  };
}

/**
 * Create a fresh NON-EXTRACTABLE session key and have the identity certify it
 * (one identity signature). The returned `session` is a `PodIdentity` for
 * signing traffic; it cannot issue certificates.
 *
 * @param {PodIdentity} identity
 * @param {Parameters<typeof issueSessionCertificate>[1] extends infer O ? Omit<O & object, 'sessionPublicKey'> : never} opts
 * @returns {Promise<{ session: PodIdentity, certificate: Uint8Array, serial: string, identityKey: Uint8Array, sessionKey: Uint8Array, scope: string[], notBefore: number, notAfter: number }>}
 */
export async function createSession(identity, opts) {
  const session = await PodIdentity.generate({ extractable: false });
  const issued = await issueSessionCertificate(identity, { ...opts, sessionPublicKey: await session.rawPublicKey() });
  sessionIdentities.add(session);
  return { session, ...issued };
}

/**
 * Sign a challenge with the session key to show possession (a certificate
 * alone only says the identity authorised that key; anyone can replay it).
 *
 * @param {PodIdentity} session
 * @param {Uint8Array} challenge
 * @returns {Promise<Uint8Array>}
 */
export async function createSessionProof(session, challenge) {
  return session.sign(concat(enc.encode(PROOF_DOMAIN), await session.rawPublicKey(), challenge));
}

// ---------------------------------------------------------------------------
// verifying
// ---------------------------------------------------------------------------

/**
 * Whether `scope` (what a certificate grants) covers `required`. An empty
 * scope covers nothing; `'*'` covers everything; otherwise `matchScope` rules
 * apply (`namespace:resource:action`, `*` per part).
 *
 * @param {string[]} scope
 * @param {string} required
 * @returns {boolean}
 */
export function scopeAllows(scope, required) {
  if (typeof required !== 'string' || required.length === 0) return false;
  return scope.some((granted) => granted === '*' || granted === required || matchScope(granted, required));
}

/**
 * Check a peer's credential and return who it speaks for.
 *
 * Refusals throw `CredentialError` with a `code`. Checks, in order: the
 * credential is exactly one certificate; encoding; the identity's signature;
 * lifetime sanity and the verifier's maximum; the validity window with skew;
 * `expectedIdentity`; revocation (store errors fail closed); `requireScope`;
 * `proof`.
 *
 * Verifying the certificate does NOT verify messages: the caller still checks
 * message signatures against the returned `sessionKey` (see
 * `verifyWithRawPublicKey`), or passes a `proof`.
 *
 * @param {Uint8Array|string|Uint8Array[]} credential
 * @param {object} [opts]
 * @param {number|Date} [opts.now] - Milliseconds; default `Date.now()`
 * @param {number} [opts.skewSeconds=30] - 0..300
 * @param {number} [opts.maxLifetimeSeconds=86400]
 * @param {RevocationStore} [opts.revocations]
 * @param {Uint8Array|string} [opts.expectedIdentity] - Raw identity key, or its pod id
 * @param {string} [opts.requireScope] - The certificate must cover this
 * @param {{ challenge: Uint8Array, signature: Uint8Array }} [opts.proof]
 * @returns {Promise<{ identityKey: Uint8Array, podId: string, sessionKey: Uint8Array, scope: string[], serial: string, notBefore: number, notAfter: number }>}
 */
export async function verifyPeerCredential(credential, opts = {}) {
  if (Array.isArray(credential)) {
    if (credential.length !== 1) throw new CredentialError('chain-too-long', 'a credential is exactly one certificate (no delegation from a session key)');
    credential = credential[0];
  }
  const skew = skewOf(opts);
  const max = maxLifetimeOf(opts);
  const now = nowSeconds(opts.now);
  const cert = decodeSessionCertificate(credential);

  if (!(await verifyWithRawPublicKey(cert.identityKey, cert.signature, certSigningInput(cert.body)))) {
    throw new CredentialError('bad-signature', 'the certificate is not signed by its identity key');
  }
  if (cert.notAfter <= cert.notBefore) throw new CredentialError('invalid-lifetime', 'notAfter is not after notBefore');
  if (cert.notAfter - cert.notBefore > max) {
    throw new CredentialError('lifetime-too-long', `lifetime ${cert.notAfter - cert.notBefore}s exceeds the maximum ${max}s`);
  }
  if (now < cert.notBefore - skew) throw new CredentialError('not-yet-valid', 'the certificate is not valid yet');
  if (now >= cert.notAfter + skew) throw new CredentialError('expired', 'the certificate has expired');

  const podId = await podIdFromRawKey(cert.identityKey);
  if (opts.expectedIdentity !== undefined) {
    const e = opts.expectedIdentity;
    const ok = typeof e === 'string' ? e === podId : e instanceof Uint8Array && bytesEqual(e, cert.identityKey);
    if (!ok) throw new CredentialError('wrong-identity', 'the certificate speaks for a different identity');
  }

  if (opts.revocations) {
    let revoked;
    try {
      revoked = await opts.revocations.isRevoked(cert.identityKey, cert.serial);
    } catch (err) {
      throw new CredentialError('revoked', `revocation store failed, refusing: ${err?.message ?? err}`);
    }
    if (revoked) throw new CredentialError('revoked', 'the certificate or its identity has been revoked');
  }

  if (opts.requireScope !== undefined && !scopeAllows(cert.scope, opts.requireScope)) {
    throw new CredentialError('scope-denied', `the certificate does not cover ${opts.requireScope}`);
  }

  if (opts.proof) {
    const ok = await verifyWithRawPublicKey(
      cert.sessionKey,
      opts.proof.signature,
      concat(enc.encode(PROOF_DOMAIN), cert.sessionKey, opts.proof.challenge)
    );
    if (!ok) throw new CredentialError('bad-proof', 'the proof was not signed by the session key');
  }

  return {
    identityKey: cert.identityKey,
    podId,
    sessionKey: cert.sessionKey,
    scope: cert.scope,
    serial: encodeBase64url(cert.serial),
    notBefore: cert.notBefore,
    notAfter: cert.notAfter,
  };
}

// ---------------------------------------------------------------------------
// revocation
// ---------------------------------------------------------------------------

function encodeRevocationBody({ kind, identityKey, serial, issuedAt, retainUntil }) {
  return concat(
    new Uint8Array(REV_MAGIC),
    new Uint8Array([CERT_VERSION, kind]),
    field(identityKey),
    field(serial),
    u64(issuedAt),
    u64(retainUntil)
  );
}

function revSigningInput(body) {
  return concat(enc.encode(REV_DOMAIN), body);
}

/**
 * Sign a revocation of one session certificate. Only the identity that issued
 * it can: pass the certificate (bytes) and the same identity.
 *
 * @param {PodIdentity} identity
 * @param {Uint8Array|string} certificate
 * @param {{ now?: number|Date }} [opts]
 * @returns {Promise<Uint8Array>} Revocation bytes, ready to forward
 */
export async function revokeSessionCertificate(identity, certificate, opts = {}) {
  const cert = decodeSessionCertificate(certificate);
  const identityKey = await identity.rawPublicKey();
  if (!bytesEqual(identityKey, cert.identityKey)) {
    throw new CredentialError('wrong-identity', 'only the identity that issued a certificate can revoke it');
  }
  return signRevocation(identity, identityKey, REVOCATION_KIND.SESSION, cert.serial, nowSeconds(opts.now), cert.notAfter);
}

/**
 * Sign the identity's retirement: every certificate it ever issued, and any it
 * would issue later, is to be refused. Kept by stores until pruned by size.
 *
 * @param {PodIdentity} identity
 * @param {{ now?: number|Date }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function retireIdentity(identity, opts = {}) {
  const identityKey = await identity.rawPublicKey();
  return signRevocation(identity, identityKey, REVOCATION_KIND.IDENTITY, new Uint8Array(0), nowSeconds(opts.now), 0);
}

async function signRevocation(identity, identityKey, kind, serial, issuedAt, retainUntil) {
  const body = encodeRevocationBody({ kind, identityKey, serial, issuedAt, retainUntil });
  const signature = await identity.sign(revSigningInput(body));
  return concat(body, field(signature));
}

/**
 * Parse and verify a revocation. It is valid only if signed by the identity
 * key it names. Throws `CredentialError` otherwise.
 *
 * @param {Uint8Array|string} bytes
 * @returns {Promise<{ kind: number, identityKey: Uint8Array, serial: Uint8Array, issuedAt: number, retainUntil: number, bytes: Uint8Array }>}
 */
export async function verifyRevocation(bytes) {
  const raw = toBytes(bytes, 'revocation');
  const r = new Reader(raw);
  if (!bytesEqual(r.take(4), new Uint8Array(REV_MAGIC))) throw new CredentialError('malformed', 'not a revocation');
  const version = r.u8();
  if (version !== CERT_VERSION) throw new CredentialError('unsupported-version', `unsupported revocation version ${version}`);
  const kind = r.u8();
  if (kind !== REVOCATION_KIND.SESSION && kind !== REVOCATION_KIND.IDENTITY) throw new CredentialError('malformed', 'unknown revocation kind');
  const identityKey = r.field();
  const serial = r.field();
  if (identityKey.length !== KEY_BYTES) throw new CredentialError('malformed', 'bad key length');
  if (kind === REVOCATION_KIND.SESSION ? serial.length !== SERIAL_BYTES : serial.length !== 0) throw new CredentialError('malformed', 'bad serial length');
  const issuedAt = r.u64();
  const retainUntil = r.u64();
  const body = raw.subarray(0, r.o);
  const signature = r.field();
  r.done();
  if (!(await verifyWithRawPublicKey(identityKey, signature, revSigningInput(body)))) {
    throw new CredentialError('bad-signature', 'the revocation is not signed by the identity it names');
  }
  return {
    kind,
    identityKey: new Uint8Array(identityKey),
    serial: new Uint8Array(serial),
    issuedAt,
    retainUntil,
    bytes: new Uint8Array(raw),
  };
}

/**
 * @typedef {object} RevocationStore
 * @property {(statement: object, bytes: Uint8Array) => boolean|Promise<boolean>} add - Record a VERIFIED revocation; resolve true if it was new
 * @property {(identityKey: Uint8Array, serial: Uint8Array|null) => boolean|Promise<boolean>} isRevoked - True if that serial, or the whole identity, is revoked
 */

/**
 * Receive a revocation from the network: verify it, then offer it to the
 * store. Idempotent: a repeat resolves `status: 'duplicate'`. Forward the
 * returned `bytes` onward ONLY when `status` is `'added'`, which keeps gossip
 * from looping. Throws `CredentialError` for malformed or wrongly-signed input
 * (count those; do not forward them).
 *
 * @param {Uint8Array|string} bytes
 * @param {RevocationStore} store
 * @returns {Promise<{ status: 'added'|'duplicate'|'ignored', statement: object, bytes: Uint8Array }>}
 */
export async function receiveRevocation(bytes, store) {
  const statement = await verifyRevocation(bytes);
  const added = await store.add(statement, statement.bytes);
  return { status: added === 'ignored' ? 'ignored' : added ? 'added' : 'duplicate', statement, bytes: statement.bytes };
}

/**
 * Is this certificate (or `{ identityKey, serial }`) revoked in `store`?
 *
 * @param {{ identityKey: Uint8Array, serial: Uint8Array }} subject
 * @param {RevocationStore} store
 * @returns {Promise<boolean>}
 */
export async function isRevoked(subject, store) {
  return !!(await store.isRevoked(subject.identityKey, subject.serial ?? null));
}

/**
 * In-memory revocation store with a size bound.
 *
 * Bounding: expired certificate revocations are dropped first (a revocation of
 * a certificate is moot once the certificate's own `notAfter`, plus the
 * maximum skew, has passed). If the store is still full, the certificate
 * revocation closest to expiry is evicted. Identity retirements are never
 * evicted for a certificate revocation; if the store holds only retirements
 * and is full, `add` throws `store-full`. Anyone can mint identities and sign
 * revocations for them, so give the store a `filter` that admits only
 * identities you care about on a public network.
 */
export class MemoryRevocationStore {
  #max;
  #filter;
  #entries = new Map();
  #listeners = new Set();
  #retired = new Set();

  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEntries=10000]
   * @param {(statement: object) => boolean} [opts.filter] - Return false to ignore a statement
   * @param {() => number} [opts.clock] - Milliseconds; default `Date.now`
   */
  constructor({ maxEntries = DEFAULT_REVOCATION_STORE_SIZE, filter, clock = Date.now } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new TypeError('maxEntries must be a positive integer');
    this.#max = maxEntries;
    this.#filter = filter ?? null;
    this.clock = clock;
  }

  /** @returns {number} */
  get size() { return this.#entries.size; }

  #key(identityKey, serial) {
    return `${encodeBase64url(identityKey)}|${serial && serial.length ? encodeBase64url(serial) : ''}`;
  }

  /**
   * Drop revocations of certificates that have expired (beyond the maximum skew).
   *
   * @param {number|Date} [now]
   * @returns {number} How many were dropped
   */
  prune(now) {
    const t = nowSeconds(now ?? this.clock());
    let dropped = 0;
    for (const [k, e] of this.#entries) {
      if (e.retainUntil !== 0 && t >= e.retainUntil + MAX_SKEW_SECONDS) { this.#entries.delete(k); dropped++; }
    }
    return dropped;
  }

  /** @returns {boolean|'ignored'} */
  add(statement, bytes) {
    if (this.#filter && !this.#filter(statement)) return 'ignored';
    const key = this.#key(statement.identityKey, statement.serial);
    if (this.#entries.has(key)) return false;
    const t = nowSeconds(this.clock());
    if (statement.retainUntil !== 0 && t >= statement.retainUntil + MAX_SKEW_SECONDS) return 'ignored';
    if (this.#entries.size >= this.#max) this.prune();
    if (this.#entries.size >= this.#max) {
      let victim = null;
      for (const [k, e] of this.#entries) {
        if (e.retainUntil !== 0 && (victim === null || e.retainUntil < this.#entries.get(victim).retainUntil)) victim = k;
      }
      if (victim === null) {
        throw new CredentialError('store-full', 'the revocation store is full of identity retirements');
      }
      this.#entries.delete(victim);
    }
    this.#entries.set(key, { bytes: new Uint8Array(bytes), retainUntil: statement.retainUntil, kind: statement.kind });
    if (statement.kind === REVOCATION_KIND.IDENTITY) this.#retired.add(encodeBase64url(statement.identityKey));
    for (const fn of [...this.#listeners]) {
      try { fn({ statement, bytes: new Uint8Array(bytes) }); } catch { /* a listener must not break reception */ }
    }
    return true;
  }

  /** @returns {boolean} */
  isRevoked(identityKey, serial) {
    if (this.#retired.has(encodeBase64url(identityKey))) return true;
    return serial ? this.#entries.has(this.#key(identityKey, serial)) : false;
  }

  /**
   * Revocations to hand a newly connected peer (unexpired ones).
   *
   * @returns {Uint8Array[]}
   */
  list() {
    this.prune();
    return [...this.#entries.values()].map((e) => new Uint8Array(e.bytes));
  }

  /**
   * Called once for each NEW revocation (not for duplicates), with
   * `{ statement, bytes }`; forward `bytes` to other peers.
   *
   * @param {(ev: { statement: object, bytes: Uint8Array }) => void} fn
   * @returns {() => void} Unsubscribe
   */
  onRevocation(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}
