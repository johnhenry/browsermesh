import { encodeBase64url, decodeBase64url, canonicalJson, domainSigningBytes } from "@johnhenry/browsermesh-primitives";
import { fail } from "./errors.mjs";

/** A raw Ed25519 key or signature as strict base64url (no padding, no stray bits). */
function decodeExact(str, bytes) {
  const chars = Math.ceil((bytes * 8) / 6);
  if (typeof str !== "string" || str.length !== chars || !/^[A-Za-z0-9_-]+$/.test(str)) return null;
  const out = decodeBase64url(str);
  if (out.length !== bytes || encodeBase64url(out) !== str) return null;
  return out;
}

export const isKey = (s) => decodeExact(s, 32) !== null;
export const isSig = (s) => decodeExact(s, 64) !== null;

/** Raw 32 bytes of a base64url key; throws `malformed`. */
export function keyBytes(key) {
  const b = decodeExact(key, 32);
  if (!b) fail("malformed", "not a base64url Ed25519 public key");
  return b;
}

/**
 * Realm id / pod id of a key: base64url SHA-256 of the raw public key (the primitives `derivePodId` derivation).
 * @param {string} key base64url public key
 * @returns {Promise<string>}
 */
export async function keyId(key) {
  const hash = await crypto.subtle.digest("SHA-256", keyBytes(key));
  return encodeBase64url(new Uint8Array(hash));
}

/**
 * The base64url public key of a `PodIdentity`.
 * @param {{ rawPublicKey(): Promise<Uint8Array> }} identity
 * @returns {Promise<string>}
 */
export async function publicKeyOf(identity) {
  return encodeBase64url(await identity.rawPublicKey());
}

/** Sign `UTF-8(domain) || 0x00 || canonical(body)`; returns base64url. */
export async function signBody(identity, domain, body) {
  const sig = await identity.sign(domainSigningBytes(domain, canonicalJson(body)));
  return encodeBase64url(new Uint8Array(sig));
}

/** Verify a base64url signature over the domain-prefixed canonical body; false on anything wrong. */
export async function verifyBody(keyB64, domain, body, sigB64) {
  const key = decodeExact(keyB64, 32);
  const sig = decodeExact(sigB64, 64);
  if (!key || !sig) return false;
  try {
    const pub = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", pub, sig, domainSigningBytes(domain, canonicalJson(body)));
  } catch {
    return false;
  }
}

/** Make sure `identity` holds `expectedKey` before signing for it. */
export async function requireSigner(identity, expectedKey) {
  let key;
  try {
    key = await publicKeyOf(identity);
  } catch {
    fail("wrong-signer", "not a usable identity");
  }
  if (key !== expectedKey) fail("wrong-signer", "the identity does not hold the key that must sign");
  return key;
}

/** `now` in whole seconds: a number, a function returning one, or the real clock when absent. */
export function resolveNow(now) {
  const v = typeof now === "function" ? now() : now === undefined ? Math.floor(Date.now() / 1000) : now;
  if (!Number.isSafeInteger(v) || v < 0) fail("malformed", "now must be whole seconds");
  return v;
}
