// Credentials (docs/design/realms.md 5.4).
//
// An issuer-signed statement that one KEY has a role in one realm for a time. Fields: realm id, subject key, role,
// serial, notBefore, notAfter (whole seconds), epoch, and the issuer's key. There is no keyless form: the subject is
// always a key, and the exchange layer checks it against the key the link proved (`checkSubject`).
//
// The verifier does not trust the issuer's dates: it CLAMPS the lifetime so that
//   effective notAfter = min(notAfter, notBefore + descriptor.ttl, issuer.notAfter)
// which means a compromised issuer cannot mint past the realm's ttl and cannot gain anything by backdating notBefore
// (a backdated window simply ends in the past). Delegation is exactly one level deep: the descriptor lists issuers, and
// only a listed issuer's signature counts.
import { canonicalJson, parseCanonical, encodeBase64url } from "@johnhenry/browsermesh-primitives";
import { fail, guard, building } from "./errors.mjs";
import { DOMAINS, MAX_CREDENTIAL_BYTES, DEFAULT_SKEW, MAX_SKEW } from "./limits.mjs";
import { isKey, isSig, keyBytes, publicKeyOf, signBody, verifyBody, resolveNow } from "./keys.mjs";
import { exactKeys, isInt, isPlainObject, isTime, need, utf8Length } from "./validate.mjs";
import { isRoleName } from "./roles.mjs";
import { isStale } from "./descriptor.mjs";

const BODY = ["v", "realm", "subject", "role", "serial", "notBefore", "notAfter", "epoch", "issuer"];

function checkBody(c) {
  exactKeys(c, BODY, ["sig"], "credential");
  if (c.v !== 1) fail("unsupported-version", "credential version must be 1");
  need(isKey(c.realm), "bad realm id");
  need(isKey(c.subject), "subject must be a key (there is no keyless credential)");
  need(isKey(c.issuer), "bad issuer key");
  need(isRoleName(c.role), "bad role name");
  need(isInt(c.serial, 1), "serial must be an integer >= 1");
  need(isTime(c.notBefore) && isTime(c.notAfter) && c.notAfter > c.notBefore, "bad lifetime (whole seconds, notAfter after notBefore)");
  need(isInt(c.epoch, 0), "epoch must be an integer >= 0");
}

/**
 * Sign a credential as an issuer.
 * @param {{ realm: string, subject: string, role: string, serial: number, notBefore: number, notAfter: number, epoch: number }} fields
 * @param {import("@johnhenry/browsermesh-primitives").PodIdentity} issuer
 * @returns {Promise<{ credential: object, text: string }>}
 */
export function issueCredential(fields, issuer) {
  return building(async () => {
    need(isPlainObject(fields), "fields must be an object");
    const body = {
      v: 1, realm: fields.realm, subject: fields.subject, role: fields.role, serial: fields.serial,
      notBefore: fields.notBefore, notAfter: fields.notAfter, epoch: fields.epoch, issuer: await publicKeyOf(issuer),
    };
    checkBody(body);
    const text = canonicalJson({ ...body, sig: await signBody(issuer, DOMAINS.credential, body) });
    return { credential: parseCanonical(text), text };
  });
}

function checkDescriptorShape(d) {
  need(
    isPlainObject(d) && isKey(d.id) && Array.isArray(d.issuers) && isPlainObject(d.roles) && Number.isSafeInteger(d.ttl) &&
      Array.isArray(d.revoked) && Number.isSafeInteger(d.epoch),
    "a verified descriptor is required",
  );
}

/**
 * Verify a credential against a descriptor the caller has already verified.
 *
 * Order: size, strict canonical parse, shape, realm, descriptor freshness, issuer listed, signature, role defined,
 * epoch, revoked serial, lifetime (clamped, with skew). Never throws.
 *
 * @param {unknown} text the exact received text
 * @param {object} descriptor a descriptor returned by `verifyDescriptor` / `adoptDescriptor`
 * @param {{ now?: number | (() => number), skew?: number, tracker?: ReturnType<import("./tracker.mjs").createCredentialTracker> }} [opts]
 *   `skew` is clamped to 0..300 seconds
 * @returns {Promise<{ ok: true, credential: object, effective: { notBefore: number, notAfter: number }, clamped: boolean, descriptorBehind: boolean } | { ok: false, reason: string, detail?: string }>}
 */
export function verifyCredential(text, descriptor, opts) {
  return guard(async () => {
    const o = opts ?? {};
    const now = resolveNow(o.now);
    const skew = Math.max(0, Math.min(MAX_SKEW, Number.isFinite(o.skew) ? Math.floor(o.skew) : DEFAULT_SKEW));
    if (typeof text !== "string") fail("malformed", "credential must be text");
    if (utf8Length(text) > MAX_CREDENTIAL_BYTES) fail("too-large", "credential is too large");
    const doc = parseCanonical(text);
    exactKeys(doc, [...BODY, "sig"], [], "credential");
    need(isSig(doc.sig), "bad signature encoding");
    const { sig, ...body } = doc;
    checkBody(body);
    checkDescriptorShape(descriptor);

    if (body.realm !== descriptor.id) fail("wrong-realm", "credential is for another realm");
    if (isStale(descriptor, now)) fail("descriptor-stale", "the descriptor snapshot is past its validUntil");
    const issuer = descriptor.issuers.find((i) => i?.key === body.issuer);
    if (!issuer) fail("issuer-not-listed", "the descriptor does not list this issuer");
    if (!(await verifyBody(body.issuer, DOMAINS.credential, body, sig))) fail("bad-signature", "issuer signature does not verify");
    if (!Object.hasOwn(descriptor.roles, body.role)) fail("unknown-role", "the descriptor does not define this role");
    if (body.epoch < descriptor.epoch) fail("epoch-too-old", "credential predates the realm's epoch");
    if (descriptor.revoked.includes(body.serial)) fail("revoked", "credential serial is revoked");

    const effNotAfter = Math.min(body.notAfter, body.notBefore + descriptor.ttl, issuer.notAfter);
    if (now < body.notBefore - skew) fail("not-yet-valid", "credential is not valid yet");
    if (now > effNotAfter + skew) fail("expired", "credential has expired");

    const result = {
      ok: true,
      credential: doc,
      effective: { notBefore: body.notBefore, notAfter: effNotAfter },
      clamped: effNotAfter < body.notAfter,
      descriptorBehind: body.epoch > descriptor.epoch,
    };
    if (o.tracker) {
      o.tracker.noteEpoch(descriptor.id, descriptor.epoch);
      const admitted = o.tracker.admit(result, { now });
      if (!admitted.ok) return { ok: false, reason: admitted.reason };
    }
    return result;
  });
}

/**
 * The exchange layer's check: the credential's subject must be the key the link proved.
 * @param {{ subject?: string, credential?: { subject: string } } | null} credential a credential, or a `verifyCredential` result
 * @param {string | Uint8Array} provenKey base64url or raw 32-byte public key from the link
 * @returns {{ ok: true } | { ok: false, reason: "subject-mismatch" | "malformed" }}
 */
export function checkSubject(credential, provenKey) {
  const c = credential?.credential ?? credential;
  if (!c || typeof c.subject !== "string") return { ok: false, reason: "malformed" };
  let key;
  try {
    key = typeof provenKey === "string" ? provenKey : rawToKey(provenKey);
    keyBytes(key);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  return key === c.subject ? { ok: true } : { ok: false, reason: "subject-mismatch" };
}

function rawToKey(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new TypeError("expected 32 bytes");
  return encodeBase64url(bytes);
}
