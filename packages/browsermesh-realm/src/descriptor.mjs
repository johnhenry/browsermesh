// Realm descriptors (docs/design/realms.md 5.2 and 5.9).
//
// A descriptor is a canonical-JSON document signed by the realm's current root key. The signature (`sig`) is a field of
// the document and covers `UTF-8(domain) || 0x00 || canonicalJson(document without sig)`. A verifier parses with the
// strict `parseCanonical`, so anything that is not already in canonical form is refused, and it signs and checks the
// text it received, not a re-encoding.
//
// Times are whole seconds. Absent optional fields are omitted (there is no `null`).
import { canonicalJson, parseCanonical, domainSigningBytes, encodeBase64url } from "@johnhenry/browsermesh-primitives";
import { fail, guard, building } from "./errors.mjs";
import {
  DOMAINS, DEFAULT_TTL, MIN_TTL, MAX_TTL, MAX_DESCRIPTOR_BYTES, MAX_CHAIN, MAX_ISSUERS, MAX_ADMITTERS, MAX_REVOKED,
  MAX_RENDEZVOUS_ENTRIES,
} from "./limits.mjs";
import { isKey, isSig, keyId, signBody, verifyBody, requireSigner, resolveNow } from "./keys.mjs";
import { exactKeys, hasControl, isInt, isPlainObject, isTime, need, utf8Length } from "./validate.mjs";
import { validateRoles, defaultRole, isPrivilegedScope, GUEST_ROLE } from "./roles.mjs";
import { verifyChain } from "./rotation.mjs";

/** Room for the `sig` field when checking a body against the size limit. */
const SIG_ALLOWANCE = 100;

const REQUIRED = ["v", "id", "name", "serial", "epoch", "mode", "root", "issuers", "roles", "rendezvous", "admitters", "ttl", "revoked", "labels", "extensions", "sig"];
const OPTIONAL = ["updateUrl", "validUntil", "defaultRole"];

// ---- rendezvous ---------------------------------------------------------------------------------------------------

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function checkUrl(value, secure, insecure, what) {
  need(typeof value === "string" && value.length > 0 && value.length <= 512, `${what}: bad URL`);
  let u;
  try {
    u = new URL(value);
  } catch {
    fail("malformed", `${what}: not a URL`);
  }
  need(!u.username && !u.password, `${what}: no credentials in URLs`);
  const ok = u.protocol === secure || (u.protocol === insecure && LOOPBACK.has(u.hostname));
  need(ok, `${what}: only ${secure}// (or ${insecure}// on loopback) is browser-usable`);
}

const ICE_URL = /^(stun|stuns|turn|turns):[^\s]{1,250}$/;

/**
 * Validate a rendezvous object (also used for the unsigned hints of the authority-less form).
 * @param {unknown} r
 */
export function checkRendezvous(r) {
  exactKeys(r, ["signaling", "relays", "ice", "bootstrap"], [], "rendezvous");
  for (const k of ["signaling", "relays", "ice", "bootstrap"]) {
    need(Array.isArray(r[k]) && r[k].length <= MAX_RENDEZVOUS_ENTRIES, `rendezvous.${k}: at most ${MAX_RENDEZVOUS_ENTRIES} entries`);
  }
  r.signaling.forEach((u) => checkUrl(u, "wss:", "ws:", "rendezvous.signaling"));
  r.relays.forEach((u) => checkUrl(u, "wss:", "ws:", "rendezvous.relays"));
  r.bootstrap.forEach((u) => checkUrl(u, "https:", "http:", "rendezvous.bootstrap"));
  for (const e of r.ice) {
    exactKeys(e, ["urls"], ["username", "credential"], "rendezvous.ice entry");
    need(Array.isArray(e.urls) && e.urls.length >= 1 && e.urls.length <= 4 && e.urls.every((u) => typeof u === "string" && ICE_URL.test(u)), "rendezvous.ice: bad urls");
    for (const k of ["username", "credential"]) {
      need(!(k in e) || (typeof e[k] === "string" && e[k].length <= 256), `rendezvous.ice: bad ${k}`);
    }
  }
}

// ---- body ---------------------------------------------------------------------------------------------------------

function checkName(name) {
  need(typeof name === "string" && name.length >= 1 && name.length <= 64 && !hasControl(name) && name.isWellFormed(), "bad name");
}

/** Validate a descriptor document WITHOUT its signature (`body`), throwing a typed RealmError. */
function checkBody(d) {
  exactKeys(d, REQUIRED.filter((k) => k !== "sig"), OPTIONAL, "descriptor");
  if (d.v !== 1) fail("unsupported-version", "descriptor version must be 1");
  need(isKey(d.id), "bad id");
  checkName(d.name);
  need(isInt(d.serial, 1), "serial must be an integer >= 1");
  need(isInt(d.epoch, 0), "epoch must be an integer >= 0");
  need(d.mode === "open" || d.mode === "invite", "mode must be open or invite");

  exactKeys(d.root, ["key", "chain"], [], "root");
  need(isKey(d.root.key) && Array.isArray(d.root.chain), "bad root");

  need(Array.isArray(d.issuers) && d.issuers.length <= MAX_ISSUERS, `at most ${MAX_ISSUERS} issuers`);
  const seen = new Set();
  for (const i of d.issuers) {
    exactKeys(i, ["key", "notAfter"], [], "issuer");
    need(isKey(i.key) && isTime(i.notAfter), "bad issuer");
    need(!seen.has(i.key), "duplicate issuer");
    seen.add(i.key);
  }

  const roles = validateRoles(d.roles);
  if (!roles.ok) fail(roles.reason, roles.detail);
  if ("defaultRole" in d) {
    need(d.mode === "open", "defaultRole only applies in open mode");
    need(typeof d.defaultRole === "string" && Object.hasOwn(d.roles, d.defaultRole), "defaultRole must name a defined role");
  }
  if (d.mode === "open") need(defaultRole(d) !== null, "open mode needs a default role (guest)");

  checkRendezvous(d.rendezvous);

  need(Array.isArray(d.admitters) && d.admitters.length <= MAX_ADMITTERS && d.admitters.every(isKey), "bad admitters");
  need(new Set(d.admitters).size === d.admitters.length, "duplicate admitter");
  need(isInt(d.ttl, MIN_TTL, MAX_TTL), `ttl must be ${MIN_TTL} to ${MAX_TTL} seconds`);
  need(
    Array.isArray(d.revoked) && d.revoked.length <= MAX_REVOKED && d.revoked.every((s, i) => isInt(s, 1) && (i === 0 || s > d.revoked[i - 1])),
    `revoked must be at most ${MAX_REVOKED} ascending unique serials`,
  );
  need(isPlainObject(d.labels) && Object.keys(d.labels).length <= 16, "bad labels");
  for (const [k, v] of Object.entries(d.labels)) {
    need(k.length >= 1 && k.length <= 64 && typeof v === "string" && v.length <= 128 && v.isWellFormed(), "bad label");
  }
  need(isPlainObject(d.extensions), "extensions must be an object");
  if ("updateUrl" in d) checkUrl(d.updateUrl, "https:", "http:", "updateUrl");
  if ("validUntil" in d) need(isTime(d.validUntil), "bad validUntil");
}

const withoutSig = (d) => {
  const { sig, ...body } = d;
  return body;
};

function sizeCheck(text, maxBytes) {
  if (utf8Length(text) > maxBytes) fail("too-large", `descriptor is larger than ${maxBytes} bytes`);
}

/** True when a baked snapshot is past its `validUntil` and must be refreshed. */
export function isStale(descriptor, now) {
  return descriptor?.validUntil !== undefined && resolveNow(now) > descriptor.validUntil;
}

// ---- create / sign ------------------------------------------------------------------------------------------------

/**
 * Build an unsigned descriptor. `id` is the base64url SHA-256 of the GENESIS root key: `genesisKey` if given, else
 * the first rotation's outgoing key, else `root.key`. Throws a typed `RealmError` on bad input.
 * @param {object} fields see docs/design/realms.md 5.2
 * @returns {Promise<object>}
 */
export function createDescriptor(fields) {
  return building(async () => {
    need(isPlainObject(fields), "fields must be an object");
    const f = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    need(isPlainObject(f.root) && isKey(f.root.key), "root.key is required");
    need(typeof f.name === "string" && isPlainObject(f.roles), "name and roles are required");
    const chain = f.root.chain ?? [];
    need(Array.isArray(chain), "root.chain must be an array");
    const genesisKey = f.genesisKey ?? (chain.length > 0 ? chain[0]?.from : f.root.key);
    if (f.genesisKey !== undefined && chain.length > 0) need(chain[0]?.from === f.genesisKey, "genesisKey is not the first rotation's outgoing key");
    const body = {
      v: 1,
      id: await keyId(genesisKey),
      name: f.name,
      serial: f.serial ?? 1,
      epoch: f.epoch ?? 0,
      mode: f.mode ?? "invite",
      root: { key: f.root.key, chain },
      issuers: f.issuers ?? [],
      roles: f.roles,
      rendezvous: f.rendezvous ?? { signaling: [], relays: [], ice: [], bootstrap: [] },
      admitters: f.admitters ?? [],
      ttl: f.ttl ?? DEFAULT_TTL,
      revoked: f.revoked ?? [],
      labels: f.labels ?? {},
      extensions: f.extensions ?? {},
    };
    for (const k of OPTIONAL) if (f[k] !== undefined) body[k] = f[k];
    const text = canonicalJson(body);
    sizeCheck(text, (f.maxBytes ?? MAX_DESCRIPTOR_BYTES) - SIG_ALLOWANCE);
    const normal = parseCanonical(text);
    checkBody(normal);
    return normal;
  });
}

/**
 * Sign a descriptor as its current root key.
 * @param {object} descriptor from `createDescriptor` (a `sig` already on it is ignored)
 * @param {import("@johnhenry/browsermesh-primitives").PodIdentity} rootIdentity
 * @returns {Promise<{ descriptor: object, text: string }>}
 */
export function signDescriptor(descriptor, rootIdentity, opts = {}) {
  return building(async () => {
    need(isPlainObject(descriptor), "descriptor must be an object");
    const body = withoutSig(descriptor);
    checkBody(body);
    await requireSigner(rootIdentity, body.root.key);
    const signed = { ...body, sig: await signBody(rootIdentity, DOMAINS.descriptor, body) };
    const text = canonicalJson(signed);
    sizeCheck(text, opts?.maxBytes ?? MAX_DESCRIPTOR_BYTES);
    return { descriptor: parseCanonical(text), text };
  });
}

// ---- verify -------------------------------------------------------------------------------------------------------

/**
 * Verify a signed descriptor end to end against a pinned realm id.
 *
 * Order: size, strict canonical parse, shape (roles and scopes included), pinned id, rotation chain (against `held`
 * chain), root signature, `validUntil`. Never throws.
 *
 * @param {unknown} text the exact received text
 * @param {{ pinnedId: string, now?: number | (() => number), maxBytes?: number, maxChain?: number, heldChain?: unknown[] }} opts
 * @returns {Promise<{ ok: true, descriptor: object, text: string, chainLength: number } | { ok: false, reason: string, detail?: string }>}
 */
export function verifyDescriptor(text, opts) {
  return guard(async () => {
    const { pinnedId, now, maxBytes = MAX_DESCRIPTOR_BYTES, maxChain = MAX_CHAIN, heldChain } = opts ?? {};
    need(typeof pinnedId === "string", "verifyDescriptor needs a pinnedId");
    if (typeof text !== "string") fail("malformed", "descriptor must be text");
    sizeCheck(text, maxBytes);
    const doc = parseCanonical(text);
    if (isPlainObject(doc) && "form" in doc) fail("wrong-form", "this is not a signed descriptor");
    if (isPlainObject(doc) && doc.v !== undefined && doc.v !== 1) fail("unsupported-version", "descriptor version must be 1");
    exactKeys(doc, REQUIRED, OPTIONAL, "descriptor");
    need(isSig(doc.sig), "bad signature encoding");
    const body = withoutSig(doc);
    checkBody(body);
    if (body.id !== pinnedId) fail("wrong-realm", "descriptor is for another realm");

    const chain = await verifyChain(body.root.chain, { id: body.id, key: body.root.key, maxChain, held: heldChain });
    if (!chain.ok) return chain;

    if (!(await verifyBody(body.root.key, DOMAINS.descriptor, body, doc.sig))) fail("bad-signature", "root signature does not verify");
    if (isStale(body, now)) fail("expired", "descriptor is past its validUntil");
    return { ok: true, descriptor: doc, text, chainLength: chain.length };
  });
}

// ---- authority-less open form (5.9) -------------------------------------------------------------------------------

const AL_REQUIRED = ["v", "form", "id", "name", "mode", "roles", "salt", "hints"];
const SALT = /^[A-Za-z0-9_-]{16,64}$/;

async function authorityLessId({ name, roles, salt }) {
  const bytes = domainSigningBytes(DOMAINS.authorityless, canonicalJson({ name, roles, salt }));
  return encodeBase64url(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function checkAuthorityLessShape(d) {
  exactKeys(d, AL_REQUIRED, [], "authority-less descriptor");
  if (d.v !== 1) fail("unsupported-version", "descriptor version must be 1");
  need(d.form === "authorityless" && d.mode === "open", "authority-less descriptors are open");
  need(isKey(d.id), "bad id");
  checkName(d.name);
  need(typeof d.salt === "string" && SALT.test(d.salt), "bad salt");
  const roles = validateRoles(d.roles);
  if (!roles.ok) fail(roles.reason, roles.detail);
  // Never any privileged role: only `guest`, and never a machine-right scope family.
  if (Object.keys(d.roles).some((r) => r !== GUEST_ROLE) || !Object.hasOwn(d.roles, GUEST_ROLE)) {
    fail("bad-role", "the authority-less form carries exactly one role, guest");
  }
  for (const scope of d.roles.guest) {
    if (isPrivilegedScope(scope)) fail("bad-scope", `guest scope ${JSON.stringify(scope)} is a privileged family`);
  }
  checkRendezvous(d.hints);
}

/**
 * Build the authority-less open form: no root, no issuers, no signature. The id hashes (name, roles, salt) only, so the
 * `hints` (signalling, relays, ICE, bootstrap) are unsigned, replaceable candidates and a dead relay cannot orphan it.
 * @param {{ name: string, roles: Record<string, string[]>, salt?: string, hints?: object }} fields
 */
export function createAuthorityless(fields) {
  return building(async () => {
    need(isPlainObject(fields), "fields must be an object");
    const salt = fields.salt ?? encodeBase64url(crypto.getRandomValues(new Uint8Array(16)));
    const d = {
      v: 1, form: "authorityless", id: "", name: fields.name, mode: "open", roles: fields.roles, salt,
      hints: fields.hints ?? { signaling: [], relays: [], ice: [], bootstrap: [] },
    };
    d.id = await authorityLessId(d);
    checkAuthorityLessShape(d);
    const text = canonicalJson(d);
    sizeCheck(text, MAX_DESCRIPTOR_BYTES);
    return { descriptor: parseCanonical(text), text };
  });
}

/**
 * Verify the authority-less form: canonical, well formed, and the id equals the hash of (name, roles, salt).
 * @returns {Promise<{ ok: true, descriptor: object, text: string } | { ok: false, reason: string, detail?: string }>}
 */
export function verifyAuthorityless(text, opts) {
  return guard(async () => {
    const { pinnedId, maxBytes = MAX_DESCRIPTOR_BYTES } = opts ?? {};
    if (typeof text !== "string") fail("malformed", "descriptor must be text");
    sizeCheck(text, maxBytes);
    const doc = parseCanonical(text);
    checkAuthorityLessShape(doc);
    if ((await authorityLessId(doc)) !== doc.id) fail("bad-id", "id is not the hash of name, roles and salt");
    if (pinnedId !== undefined && doc.id !== pinnedId) fail("wrong-realm", "descriptor is for another realm");
    return { ok: true, descriptor: doc, text };
  });
}
