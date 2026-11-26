// Root rotation (docs/design/realms.md 5.1).
//
// A statement is signed by the outgoing root (domain `rotation`) and countersigned by the successor (domain
// `rotation-accept`, over the statement including the first signature), so the successor provably holds its key.
// The realm id is the hash of the GENESIS key, so a chain is checked from the genesis key forward.
//
// First-seen fork rule: a verifier that holds chain positions never accepts a different statement for one of them
// (`held`). KNOWN LIMIT: a leaked retired key can sign a competing successor; a verifier that has seen nothing cannot
// tell the two apart. Rotation limits key aging and planned changes, not compromise.
import { canonicalJson } from "@johnhenry/browsermesh-primitives";
import { fail, guard, building } from "./errors.mjs";
import { DOMAINS, MAX_CHAIN } from "./limits.mjs";
import { isKey, isSig, keyId, signBody, verifyBody, requireSigner } from "./keys.mjs";
import { exactKeys, isInt, isTime, need } from "./validate.mjs";

const BODY_KEYS = ["v", "realm", "pos", "from", "to", "effective"];

function checkBody(body) {
  exactKeys(body, BODY_KEYS, ["sig", "countersig"], "rotation");
  need(body.v === 1, "rotation: unsupported version");
  need(isKey(body.realm), "rotation: bad realm id");
  need(isInt(body.pos, 1, 1000), "rotation: bad position");
  need(isKey(body.from) && isKey(body.to) && body.from !== body.to, "rotation: bad keys");
  need(isTime(body.effective), "rotation: bad effective time");
}

const bodyOf = (s) => ({ v: s.v, realm: s.realm, pos: s.pos, from: s.from, to: s.to, effective: s.effective });

/**
 * Sign a rotation body as the outgoing root. Returns the base64url signature.
 * @param {{ v?: 1, realm: string, pos: number, from: string, to: string, effective: number }} body
 * @param {import("@johnhenry/browsermesh-primitives").PodIdentity} outgoing
 */
export function signRotation(body, outgoing) {
  return building(async () => {
    const b = { ...bodyOf({ v: 1, ...body }) };
    checkBody(b);
    await requireSigner(outgoing, b.from);
    return signBody(outgoing, DOMAINS.rotation, b);
  });
}

/**
 * Countersign a statement (`body` plus `sig`) as the successor. Returns the full statement.
 */
export function countersignRotation(statement, successor) {
  return building(async () => {
    checkBody(statement);
    need(isSig(statement.sig), "rotation: missing signature");
    await requireSigner(successor, statement.to);
    const base = { ...bodyOf(statement), sig: statement.sig };
    return { ...base, countersig: await signBody(successor, DOMAINS.rotationAccept, base) };
  });
}

/** Both steps at once. */
export async function createRotation(fields, outgoing, successor) {
  const body = bodyOf({ v: 1, ...fields });
  const sig = await signRotation(body, outgoing);
  return countersignRotation({ ...body, sig }, successor);
}

/**
 * Check one statement's shape and both signatures. `opts.realm`, when given, must match the statement's realm.
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, detail?: string }>}
 */
export function verifyRotation(statement, opts = {}) {
  return guard(async () => {
    exactKeys(statement, [...BODY_KEYS, "sig", "countersig"], [], "rotation");
    checkBody(statement);
    need(isSig(statement.sig) && isSig(statement.countersig), "rotation: bad signature encoding");
    if (opts?.realm !== undefined && statement.realm !== opts.realm) fail("wrong-realm", "rotation is for another realm");
    if (!(await verifyBody(statement.from, DOMAINS.rotation, bodyOf(statement), statement.sig))) {
      fail("bad-signature", "outgoing root's signature does not verify");
    }
    const base = { ...bodyOf(statement), sig: statement.sig };
    if (!(await verifyBody(statement.to, DOMAINS.rotationAccept, base, statement.countersig))) {
      fail("bad-countersignature", "successor's countersignature does not verify");
    }
    return { ok: true };
  });
}

const sameStatement = (a, b) => {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
};

/**
 * Verify a chain from the genesis key to `key` (the descriptor's current root key).
 * @param {unknown[]} chain
 * @param {{ id: string, key: string, maxChain?: number, held?: unknown[] }} opts `held` is the chain the verifier
 *   already holds (first seen wins)
 * @returns {Promise<{ ok: true, rootKey: string, length: number } | { ok: false, reason: string, detail?: string }>}
 */
export function verifyChain(chain, opts = {}) {
  return guard(async () => {
    const { id, key, maxChain = MAX_CHAIN } = opts ?? {};
    const held = Array.isArray(opts?.held) ? opts.held : [];
    need(typeof id === "string" && typeof key === "string", "verifyChain needs id and key");
    if (!Array.isArray(chain)) fail("bad-chain", "chain must be an array");
    if (chain.length > maxChain) fail("chain-too-long", `chain longer than ${maxChain}`);

    for (let i = 0; i < Math.min(chain.length, held.length); i++) {
      if (!sameStatement(chain[i], held[i])) fail("chain-fork", `a different statement for position ${i + 1} is already held`);
    }
    if (chain.length < held.length) fail("chain-regressed", "chain is shorter than the one held");

    let expectedFrom = null;
    let lastEffective = 0;
    for (let i = 0; i < chain.length; i++) {
      const s = chain[i];
      const shape = await verifyRotation(s, { realm: id });
      if (!shape.ok) fail("bad-chain", `statement ${i + 1}: ${shape.reason}`);
      if (s.pos !== i + 1) fail("bad-chain", `statement ${i + 1} has position ${s.pos}`);
      if (i === 0) {
        if ((await keyId(s.from)) !== id) fail("bad-id", "the first statement's outgoing key is not the genesis key");
      } else if (s.from !== expectedFrom) {
        fail("bad-chain", `statement ${i + 1} does not continue from the previous successor`);
      }
      if (s.effective < lastEffective) fail("bad-chain", "effective times go backwards");
      lastEffective = s.effective;
      expectedFrom = s.to;
    }
    if (chain.length === 0) {
      if ((await keyId(key)) !== id) fail("bad-id", "the root key does not hash to the realm id");
    } else if (expectedFrom !== key) {
      fail("bad-chain", "the chain does not end at the current root key");
    }
    return { ok: true, rootKey: key, length: chain.length };
  });
}
