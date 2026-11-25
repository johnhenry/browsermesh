/**
 * share-code.mjs -- a share code that names the key that made it. Pure functions, no browser APIs beyond
 * WebCrypto, nothing called by default.
 *
 * What a sharer hands out is two things together:
 *
 *   code         12 Crockford base32 characters (60 bits) from a random source: it names a room or a rendezvous.
 *                It is NOT an identity: everyone who was given the share holds it.
 *   fingerprint  28 Crockford base32 characters (140 bits): the first 140 bits of the sharer's POD ID, which is
 *                itself `SHA-256(raw Ed25519 public key)` (identity.mjs `derivePodId`). There is no second hash and
 *                no second key format: a fingerprint is a prefix of a name browsermesh already has.
 *
 * The text a person copies joins them with a dot, and a link carries exactly that:
 *
 *   K7QM-2XPD-9TNR.4F2K-X9ZQ-WD3H-T7NR-CV8M-P6YB-A2XG
 *   https://host/app/?join=K7QM-2XPD-9TNR.4F2K-X9ZQ-WD3H-T7NR-CV8M-P6YB-A2XG
 *
 * The short half alone is REFUSED (`parseShareInput` says `no-fingerprint`, with a message that tells the person
 * what to ask for): it cannot prove who answers. Whoever joins checks the peer that answered against the
 * fingerprint with `podIdMatchesShareFingerprint(podId, fingerprint)` once it has a pod id it has verified (the
 * identity binding of a WebRTC connection proves possession of the key behind it).
 *
 * How many bits, and why that is enough. To pass as the sharer an attacker needs a key pair whose pod id starts
 * with the same 140 bits: a second preimage of a 140-bit prefix of SHA-256, found by generating keys and hashing
 * them. The target is known to the attacker, so the cost is about 2^140 key-generations-plus-hashes, which is
 * beyond the 2^128 that is the usual ceiling for infeasible, and leaves 12 bits of margin for an attacker
 * working against many shares at once. The joiner compares all 140 bits, never a prefix of them, so a key
 * ground to match the first 20 or 40 bits gains nothing. The short code (60 bits) is not an identity and is not
 * meant to be: 2^60 offline work would be cheap, which is why it is never accepted alone.
 *
 * Why not a shorter, typeable fingerprint: typed in by a person it would have to carry the key binding, and
 * a short one can be ground offline. A safety-number style comparison needs a commitment round and a UI that both
 * sides operate correctly; this module offers the link and the full code (copy and paste), and nothing weaker.
 */
import { decodeBase64url, encodeBase64url, derivePodId } from './identity.mjs';
import { podIdFromRawKey } from './session.mjs';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U

/** Characters of the short code (5 bits each). */
export const SHARE_CODE_CHARS = 12;
/** Characters of the fingerprint (5 bits each). */
export const SHARE_FINGERPRINT_CHARS = 28;
/** Bits of the pod id the fingerprint carries. */
export const SHARE_FINGERPRINT_BITS = SHARE_FINGERPRINT_CHARS * 5;
/** Longest label `sanitizeLabel` keeps, in characters (code points). */
export const MAX_LABEL_CHARS = 64;

const POD_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** Upper case, no separators, I and L read as 1, O as 0 (what a person mistyping a Crockford code meant). */
const clean = (s) => String(s).trim().toUpperCase().replace(/[\s_-]+/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');

const isValid = (s, n) => {
  if (s.length !== n) return false;
  for (const ch of s) if (!ALPHABET.includes(ch)) return false;
  return true;
};

const group = (s, n) => s.match(new RegExp(`.{1,${n}}`, 'g'))?.join('-') ?? '';

/** Base32 text of the first `chars` x 5 bits of `bytes`. */
function base32Prefix(bytes, chars) {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < chars) {
      out += ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
    if (out.length >= chars) break;
  }
  return out;
}

/**
 * A fresh short code: 12 characters, 60 bits.
 * @param {(n: number) => Uint8Array} [random] - byte source, `n` bytes (default WebCrypto)
 * @returns {string} canonical form (no separators); `formatShareCode` groups it
 */
export function generateShareCode(random = (n) => crypto.getRandomValues(new Uint8Array(n))) {
  const bytes = random(SHARE_CODE_CHARS);
  if (!bytes || bytes.length < SHARE_CODE_CHARS) throw new TypeError(`generateShareCode: the random source must return ${SHARE_CODE_CHARS} bytes`);
  let s = '';
  for (let i = 0; i < SHARE_CODE_CHARS; i++) s += ALPHABET[bytes[i] & 31]; // 256 % 32 == 0: no modulo bias
  return s;
}

/**
 * The share fingerprint of a pod id: the first 140 bits of the 32 bytes the pod id encodes, as 28 base32 characters.
 * @param {string} podId - canonical 43 character base64url pod id
 * @returns {string} canonical form (upper case, no separators)
 */
export function shareFingerprintOfPodId(podId) {
  if (typeof podId !== 'string' || !POD_ID_RE.test(podId)) throw new TypeError('shareFingerprintOfPodId: expected a 43 character base64url pod id');
  const bytes = decodeBase64url(podId);
  if (bytes.length !== 32 || encodeBase64url(bytes) !== podId) throw new TypeError('shareFingerprintOfPodId: a pod id is 32 bytes, canonically encoded');
  return base32Prefix(bytes, SHARE_FINGERPRINT_CHARS);
}

/**
 * The share fingerprint of a public key: of its pod id (`derivePodId`), nothing else.
 * @param {Uint8Array|CryptoKey} publicKey - raw 32 byte Ed25519 key, or the public CryptoKey
 * @returns {Promise<string>}
 */
export async function shareFingerprintOfPublicKey(publicKey) {
  const podId = publicKey instanceof Uint8Array ? await podIdFromRawKey(publicKey) : await derivePodId(publicKey);
  return shareFingerprintOfPodId(podId);
}

/**
 * Does this pod id belong to the key the share code named? All 140 bits are compared. Answers false, never throws,
 * for input that is not a pod id or not a fingerprint.
 * @param {string} podId
 * @param {string} fingerprint - any case and grouping
 * @returns {boolean}
 */
export function podIdMatchesShareFingerprint(podId, fingerprint) {
  const want = normalizeShareFingerprint(fingerprint);
  if (want === null) return false;
  let have;
  try { have = shareFingerprintOfPodId(podId); } catch { return false; }
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ have.charCodeAt(i);
  return diff === 0;
}

/**
 * Does this public key belong to the key the share code named?
 * @param {Uint8Array|CryptoKey} publicKey
 * @param {string} fingerprint
 * @returns {Promise<boolean>}
 */
export async function publicKeyMatchesShareFingerprint(publicKey, fingerprint) {
  if (normalizeShareFingerprint(fingerprint) === null) return false;
  try { return podIdMatchesShareFingerprint(await podIdOf(publicKey), fingerprint); } catch { return false; }
}

const podIdOf = (publicKey) => (publicKey instanceof Uint8Array ? podIdFromRawKey(publicKey) : derivePodId(publicKey));

/**
 * The 12 character short code in canonical form, or null. Accepts the short code alone or a full share code
 * (`CODE.FINGERPRINT`, only the short half is returned): it does not check, or require, the fingerprint.
 * @param {string} input
 * @returns {string|null}
 */
export function normalizeShareCode(input) {
  if (typeof input !== 'string') return null;
  const raw = clean(input.split('.')[0] ?? '');
  return isValid(raw, SHARE_CODE_CHARS) ? raw : null;
}

/**
 * The 28 character fingerprint in canonical form, or null.
 * @param {string} input
 * @returns {string|null}
 */
export function normalizeShareFingerprint(input) {
  if (typeof input !== 'string') return null;
  const raw = clean(input);
  return isValid(raw, SHARE_FINGERPRINT_CHARS) ? raw : null;
}

/** `XXXX-XXXX-XXXX` */
export function formatShareCode(code) { return group(String(code).replace(/-/g, ''), 4); }
/** `XXXX-XXXX-...` (seven groups) */
export function formatShareFingerprint(fingerprint) { return group(String(fingerprint).replace(/-/g, ''), 4); }

/** `s` without its trailing slashes (a loop, not a pattern: the text is the caller's). */
function withoutTrailingSlashes(s) {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

/**
 * What a sharer hands out: the full share code (`CODE.FINGERPRINT`, grouped) and the link that carries it.
 * @param {{ code: string, fingerprint: string, origin?: string, linkBase?: string }} parts
 *   `linkBase` is the app's own URL (origin plus base path); `origin` is a convenience for the root of a site.
 * @returns {{ code: string, url: string }}
 */
export function formatShare(parts) {
  const code = normalizeShareCode(parts?.code);
  const fingerprint = normalizeShareFingerprint(parts?.fingerprint);
  if (code === null) throw new TypeError(`formatShare: code must be ${SHARE_CODE_CHARS} characters of the share alphabet`);
  if (fingerprint === null) throw new TypeError(`formatShare: fingerprint must be ${SHARE_FINGERPRINT_CHARS} characters of the share alphabet`);
  const text = `${formatShareCode(code)}.${formatShareFingerprint(fingerprint)}`;
  const prefix = `${withoutTrailingSlashes(String(parts.linkBase !== undefined ? parts.linkBase : (parts.origin ?? '')))}/`;
  return { code: text, url: `${prefix}?join=${text}` };
}

const FULL_SHAPE = 'XXXX-XXXX-XXXX.XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX';
const BARE_MESSAGE = `that is only the short part of a share code, which cannot prove who is sharing. Ask for the full share code or the link: it looks like ${FULL_SHAPE}`;

/**
 * Pull a share out of whatever was pasted or typed: a full share code (`CODE.FINGERPRINT`) or a share link
 * (`...?join=CODE.FINGERPRINT`, also `#join=`). The short half alone is refused with reason `no-fingerprint`.
 * Never throws.
 *
 * @param {string} text
 * @returns {{ ok: true, code: string, fingerprint: string } | { ok: false, reason: 'empty'|'invalid'|'no-fingerprint'|'bad-fingerprint', message: string }}
 */
export function parseShareInput(text) {
  const t = typeof text === 'string' ? text.trim() : (text === null || text === undefined ? '' : String(text).trim());
  if (!t) return { ok: false, reason: 'empty', message: 'paste a share code or link' };
  let v = t.length > 4096 ? t.slice(0, 4096) : t; // a share is about 60 characters; never work on a megabyte
  const m = /[?&#]join=([^&#\s]+)/i.exec(v);
  if (m) { try { v = decodeURIComponent(m[1]); } catch { v = m[1]; } }
  const dot = v.indexOf('.');
  const code = clean(dot < 0 ? v : v.slice(0, dot));
  if (!isValid(code, SHARE_CODE_CHARS)) {
    return { ok: false, reason: 'invalid', message: `that is not a valid share code (expected ${FULL_SHAPE}, or the link)` };
  }
  if (dot < 0 || !v.slice(dot + 1).trim()) return { ok: false, reason: 'no-fingerprint', message: BARE_MESSAGE };
  const fingerprint = clean(v.slice(dot + 1));
  if (!isValid(fingerprint, SHARE_FINGERPRINT_CHARS)) {
    return {
      ok: false,
      reason: 'bad-fingerprint',
      message: `the second half of the share code is damaged or cut short (${SHARE_FINGERPRINT_CHARS} characters expected): copy the whole code or the link again`,
    };
  }
  return { ok: true, code, fingerprint };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

// Escape-introduced sequences first (CSI, OSC, DCS/SOS/PM/APC strings, two-character escapes, and the 8-bit CSI and
// OSC introducers), then every remaining control, format (bidi controls, zero width, BOM, tag characters),
// line/paragraph separator, private-use and unpaired surrogate character.
const ESC_SEQ = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[PX^_][^\u001b]*(?:\u001b\\)?|[@-Z\\-_]|.)?|\u009b[0-?]*[ -/]*[@-~]|\u009d[^\u0007\u009c]*[\u0007\u009c]?/gsu;
const BAD_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}]/gu;

/**
 * Make text a peer controls (a label it announces) safe to keep and show: no escape sequences, control characters,
 * bidi or invisible formatting characters, whitespace collapsed, at most `max` characters (counted as code points),
 * normalised to NFC. A non-string becomes ''. Run where the text ENTERS the application; display code should still
 * escape it for its own medium.
 *
 * @param {unknown} input
 * @param {number} [max=64]
 * @returns {string}
 */
export function sanitizeLabel(input, max = MAX_LABEL_CHARS) {
  if (typeof input !== 'string') return '';
  const head = input.length > max * 8 ? input.slice(0, max * 8) : input; // never scan a megabyte
  const s = head
    .replace(ESC_SEQ, '')
    .replace(/[\t\n\v\f\r]+/g, ' ')
    .replace(BAD_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
  return [...s].slice(0, max).join('').trim();
}
