// Generates test/vectors/*.json (run `npm run vectors` in this package). The inputs (documents) come from the library
// and fixed seeds; every `expect` is written out by hand here, so a regression shows up as a mismatch in
// vectors.test.mjs rather than being regenerated away. Ed25519 is deterministic, so the output is reproducible.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonicalJson, domainSigningBytes, encodeBase64url } from "@johnhenry/browsermesh-primitives";
import {
  createDescriptor, signDescriptor, createRotation, issueCredential, createAuthorityless, publicKeyOf, keyId, DOMAINS,
} from "../src/index.mjs";
import { identityFromSeed, rawSign, buildRealm, SEEDS, T0, DAY, ROLES, RENDEZVOUS } from "./helpers.mjs";

const hex = (bytes) => Buffer.from(bytes).toString("hex");

async function keyTable(names) {
  const keys = {};
  const ids = {};
  for (const n of names) {
    const identity = await identityFromSeed(SEEDS[n]);
    const publicKey = await publicKeyOf(identity);
    keys[n] = { seed: SEEDS[n], publicKey, keyId: await keyId(publicKey) };
    ids[n] = identity;
  }
  return { keys, ids };
}

/** A document entry: canonical unsigned text, its signature, and the exact bytes that were signed. */
function document(name, domain, signer, signedDoc, extra = {}) {
  const { sig, ...body } = signedDoc;
  const unsigned = canonicalJson(body);
  return {
    name, domain, signer, unsigned, signature: sig, signed: canonicalJson(signedDoc),
    signingBytesHex: hex(domainSigningBytes(domain, unsigned)), ...extra,
  };
}

const T = { ok: { ok: true } };
const no = (reason) => ({ ok: false, reason });

export async function buildVectors() {
  // ---------------------------------------------------------------- descriptor.json
  const r = await buildRealm();
  const opts = { pinnedId: r.id, now: T0 };
  const d = await keyTable(["root0", "rogue", "issuerA", "issuerB"]);
  const wild = async (scope) => {
    const body = { ...r.descriptor, roles: { ...ROLES, member: [scope] } };
    delete body.sig;
    return canonicalJson({ ...body, sig: await rawSign(r.root, DOMAINS.descriptor, body) });
  };
  const wrongDomain = (() => {
    const { sig, ...body } = r.descriptor;
    return body;
  })();
  const expiring = await buildRealm({ validUntil: T0 + DAY });
  const serial5 = await buildRealm({ serial: 5 });
  const epoch3 = await buildRealm({ serial: 5, epoch: 3 });
  const al = await createAuthorityless({ name: "commons", roles: { guest: ["protocol:mcp:open"] }, salt: "AAAAAAAAAAAAAAAAAAAAAA", hints: RENDEZVOUS });
  const alForged = (() => {
    const forged = { ...al.descriptor, roles: { guest: ["protocol:mcp:open"], admin: ["mcp:search:call"] } };
    return forged;
  })();
  // A forged authority-less descriptor with an admin role whose id is recomputed, so only the role rule stops it.
  const alAdminId = encodeBase64url(new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    domainSigningBytes(DOMAINS.authorityless, canonicalJson({ name: alForged.name, roles: alForged.roles, salt: alForged.salt })),
  )));

  const descriptorVectors = {
    description: "Realm descriptor vectors (docs/design/realms.md 5.2, 5.9). Keys come from fixed 32-byte seeds. 'documents' give the canonical unsigned text, the signature and the exact signed bytes (UTF-8 domain, 0x00, canonical text). Times are whole seconds; 'now' is in 'options'. 'verifyDescriptor' and 'verifyAuthorityless' take the received text; 'adoptDescriptor' takes the held descriptor text (or null) and the offered text.",
    realmId: r.id,
    keys: d.keys,
    documents: [
      document("valid invite-mode descriptor", DOMAINS.descriptor, "root0", r.descriptor),
      document("descriptor with validUntil", DOMAINS.descriptor, "root0", expiring.descriptor),
    ],
    cases: [
      { name: "valid descriptor", op: "verifyDescriptor", input: r.text, options: opts, expect: T.ok },
      { name: "non-canonical: leading whitespace", op: "verifyDescriptor", input: " " + r.text, options: opts, expect: no("not-canonical") },
      { name: "non-canonical: keys not sorted", op: "verifyDescriptor", input: JSON.stringify(Object.fromEntries(Object.entries(r.descriptor).reverse())), options: opts, expect: no("not-canonical") },
      { name: "non-canonical: pretty-printed", op: "verifyDescriptor", input: JSON.stringify(r.descriptor, null, 2), options: opts, expect: no("not-canonical") },
      { name: "wrong domain: signed under the credential domain", op: "verifyDescriptor", input: canonicalJson({ ...wrongDomain, sig: await rawSign(r.root, DOMAINS.credential, wrongDomain) }), options: opts, expect: no("bad-signature") },
      { name: "wrong domain: signed under the rotation domain", op: "verifyDescriptor", input: canonicalJson({ ...wrongDomain, sig: await rawSign(r.root, DOMAINS.rotation, wrongDomain) }), options: opts, expect: no("bad-signature") },
      { name: "tampered name", op: "verifyDescriptor", input: r.text.replace('"name":"test realm"', '"name":"test realms"'), options: opts, expect: no("bad-signature") },
      { name: "tampered epoch", op: "verifyDescriptor", input: canonicalJson({ ...r.descriptor, epoch: 1 }), options: opts, expect: no("bad-signature") },
      { name: "signed by a key that is not the root", op: "verifyDescriptor", input: canonicalJson({ ...wrongDomain, sig: await rawSign(await identityFromSeed(SEEDS.rogue), DOMAINS.descriptor, wrongDomain) }), options: opts, expect: no("bad-signature") },
      { name: "pinned to another realm id", op: "verifyDescriptor", input: r.text, options: { pinnedId: d.keys.rogue.keyId, now: T0 }, expect: no("wrong-realm") },
      { name: "expired snapshot: validUntil reached", op: "verifyDescriptor", input: expiring.text, options: { pinnedId: r.id, now: T0 + DAY + 1 }, expect: no("expired") },
      { name: "snapshot valid at validUntil", op: "verifyDescriptor", input: expiring.text, options: { pinnedId: r.id, now: T0 + DAY }, expect: T.ok },
      { name: "wildcard role scope, correctly signed", op: "verifyDescriptor", input: await wild("mcp:*:call"), options: opts, expect: no("bad-scope") },
      { name: "two-segment role scope, correctly signed", op: "verifyDescriptor", input: await wild("mcp:tool"), options: opts, expect: no("bad-scope") },
      { name: "empty-segment role scope, correctly signed", op: "verifyDescriptor", input: await wild("mcp::call"), options: opts, expect: no("bad-scope") },
      { name: "too large", op: "verifyDescriptor", input: r.text, options: { ...opts, maxBytes: 100 }, expect: no("too-large") },
      { name: "adopt: higher serial", op: "adoptDescriptor", held: r.text, offered: serial5.text, options: opts, expect: T.ok },
      { name: "adopt refused: stale serial (equal)", op: "adoptDescriptor", held: serial5.text, offered: serial5.text, options: opts, expect: no("stale-serial") },
      { name: "adopt refused: stale serial (lower, replayed old descriptor)", op: "adoptDescriptor", held: serial5.text, offered: r.text, options: opts, expect: no("stale-serial") },
      { name: "adopt refused: older epoch with a higher serial", op: "adoptDescriptor", held: epoch3.text, offered: (await buildRealm({ serial: 6, epoch: 2 })).text, options: opts, expect: no("epoch-regressed") },
      { name: "authority-less: valid", op: "verifyAuthorityless", input: al.text, options: { pinnedId: al.descriptor.id }, expect: T.ok },
      { name: "authority-less: replaced hints keep the id", op: "verifyAuthorityless", input: canonicalJson({ ...al.descriptor, hints: { ...RENDEZVOUS, relays: ["wss://other.example.test/wsh"] } }), options: { pinnedId: al.descriptor.id }, expect: T.ok },
      { name: "authority-less tampered name", op: "verifyAuthorityless", input: canonicalJson({ ...al.descriptor, name: "commons2" }), options: { pinnedId: al.descriptor.id }, expect: no("bad-id") },
      { name: "authority-less non-canonical", op: "verifyAuthorityless", input: " " + al.text, options: { pinnedId: al.descriptor.id }, expect: no("not-canonical") },
      { name: "authority-less with a privileged role and a matching id", op: "verifyAuthorityless", input: canonicalJson({ ...alForged, id: alAdminId }), options: { pinnedId: alAdminId }, expect: no("bad-role") },
    ],
  };

  // ---------------------------------------------------------------- rotation.json
  const k = await keyTable(["root0", "root1", "root2", "rogue"]);
  const realm = k.keys.root0.keyId;
  const step = (pos, from, to, eff) => createRotation({ realm, pos, from: k.keys[from].publicKey, to: k.keys[to].publicKey, effective: eff ?? T0 + pos }, k.ids[from], k.ids[to]);
  const s1 = await step(1, "root0", "root1");
  const s2 = await step(2, "root1", "root2");
  const fork1 = await step(1, "root0", "rogue");
  const rotatedDesc = async (serial, current, chain) => (await signDescriptor(await createDescriptor({
    name: "rotated", serial, root: { key: k.keys[current].publicKey, chain }, roles: ROLES, rendezvous: RENDEZVOUS, genesisKey: k.keys.root0.publicKey,
  }), k.ids[current])).text;
  const held2 = await rotatedDesc(2, "root1", [s1]);
  const { sig: s1sig, countersig: s1counter, ...s1body } = s1;
  const rotationVectors = {
    description: "Root rotation vectors (docs/design/realms.md 5.1). A statement is signed by the outgoing root under 'browsermesh-realm/rotation/1' and countersigned by the successor under 'browsermesh-realm/rotation-accept/1' over the statement INCLUDING the first signature. The realm id is the hash of the genesis key. 'held' is the chain the verifier already holds (first seen wins).",
    realmId: realm,
    keys: k.keys,
    documents: [
      {
        ...document("rotation 1: root0 to root1", DOMAINS.rotation, "root0", { ...s1body, sig: s1sig }),
        countersigner: "root1", countersignDomain: DOMAINS.rotationAccept, countersignature: s1counter,
      },
    ],
    cases: [
      { name: "valid statement", op: "verifyRotation", statement: s1, options: { realm }, expect: T.ok },
      { name: "tampered effective time", op: "verifyRotation", statement: { ...s1, effective: s1.effective + 1 }, options: { realm }, expect: no("bad-signature") },
      { name: "tampered successor", op: "verifyRotation", statement: { ...s1, to: k.keys.rogue.publicKey }, options: { realm }, expect: no("bad-signature") },
      { name: "wrong domain: countersigned under the rotation domain", op: "verifyRotation", statement: { ...s1, countersig: await rawSign(k.ids.root1, DOMAINS.rotation, { ...s1body, sig: s1sig }) }, options: { realm }, expect: no("bad-countersignature") },
      { name: "countersigned by a key that is not the successor", op: "verifyRotation", statement: { ...s1, countersig: await rawSign(k.ids.rogue, DOMAINS.rotationAccept, { ...s1body, sig: s1sig }) }, options: { realm }, expect: no("bad-countersignature") },
      { name: "missing countersignature", op: "verifyRotation", statement: { ...s1body, sig: s1sig }, options: { realm }, expect: no("malformed") },
      { name: "statement for another realm", op: "verifyRotation", statement: s1, options: { realm: k.keys.rogue.keyId }, expect: no("wrong-realm") },
      { name: "valid chain of two", op: "verifyChain", chain: [s1, s2], options: { id: realm, key: k.keys.root2.publicKey }, expect: T.ok },
      { name: "empty chain at the genesis key", op: "verifyChain", chain: [], options: { id: realm, key: k.keys.root0.publicKey }, expect: T.ok },
      { name: "empty chain at a key that is not the genesis key", op: "verifyChain", chain: [], options: { id: realm, key: k.keys.root1.publicKey }, expect: no("bad-id") },
      { name: "chain with a gap", op: "verifyChain", chain: [s2], options: { id: realm, key: k.keys.root2.publicKey }, expect: no("bad-chain") },
      { name: "chain ending at the wrong key", op: "verifyChain", chain: [s1, s2], options: { id: realm, key: k.keys.root1.publicKey }, expect: no("bad-chain") },
      { name: "chain over the length cap", op: "verifyChain", chain: [s1, s2], options: { id: realm, key: k.keys.root2.publicKey, maxChain: 1 }, expect: no("chain-too-long") },
      { name: "forked chain: a fresh verifier cannot tell (known limit)", op: "verifyChain", chain: [fork1], options: { id: realm, key: k.keys.rogue.publicKey }, expect: T.ok },
      { name: "forked chain refused by first-seen rule", op: "verifyChain", chain: [fork1], options: { id: realm, key: k.keys.rogue.publicKey, held: [s1] }, expect: no("chain-fork") },
      { name: "regressed chain refused", op: "verifyChain", chain: [s1], options: { id: realm, key: k.keys.root1.publicKey, held: [s1, s2] }, expect: no("chain-regressed") },
      { name: "forked chain: descriptor adoption refused", op: "adoptDescriptor", held: held2, offered: await rotatedDesc(9, "rogue", [fork1]), options: { pinnedId: realm, now: T0 }, expect: no("chain-fork") },
      { name: "extending chain: descriptor adoption accepted", op: "adoptDescriptor", held: held2, offered: await rotatedDesc(3, "root2", [s1, s2]), options: { pinnedId: realm, now: T0 }, expect: T.ok },
      { name: "descriptor signed by the retired root", op: "verifyDescriptor", input: canonicalJson({ ...JSON.parse(held2), sig: await rawSign(k.ids.root0, DOMAINS.descriptor, (({ sig, ...b }) => b)(JSON.parse(held2))) }), options: { pinnedId: realm, now: T0 }, expect: no("bad-signature") },
    ],
  };

  // ---------------------------------------------------------------- credential.json
  const c = await keyTable(["root0", "issuerA", "issuerB", "alice", "bob", "rogue"]);
  const alice = c.keys.alice.publicKey;
  const fields = (o = {}) => ({ realm: r.id, subject: alice, role: "member", serial: 1, notBefore: T0, notAfter: T0 + DAY, epoch: 0, ...o });
  const issue = async (o = {}, who = "issuerA") => issueCredential(fields(o), c.ids[who]);
  const good = await issue();
  const credVerify = (name, text, now, expect, extra = {}) => ({ name, op: "verifyCredential", input: text, options: { now }, expect, ...extra });
  const withRevoked = (await buildRealm({ revoked: [1, 7] })).text;
  const withoutA = (await buildRealm({ issuers: [r.fields.issuers[1]] })).text;
  const epoch1 = (await buildRealm({ serial: 2, epoch: 1 })).text;
  const goodBody = (({ sig, ...b }) => b)(good.credential);
  const longLife = await issue({ notAfter: T0 + 365 * DAY });
  const backdated = await issue({ notBefore: T0 - 30 * DAY, notAfter: T0 + 30 * DAY });
  const credentialVectors = {
    description: "Credential vectors (docs/design/realms.md 5.4). 'descriptor' is the verified realm descriptor (ttl 604800 s, epoch 0, two issuers). Times are whole seconds; the verifier tolerates 300 s of clock skew and clamps the lifetime to min(notAfter, notBefore + ttl, issuer.notAfter). 'tracker' feeds the credentials in order to a monotonic tracker and reports the last verdict; 'checkSubject' compares the subject with the key a link proved.",
    realmId: r.id,
    descriptor: r.text,
    keys: c.keys,
    documents: [document("member credential for alice", DOMAINS.credential, "issuerA", good.credential)],
    cases: [
      { ...credVerify("valid credential", good.text, T0 + 100, { ok: true, effective: { notBefore: T0, notAfter: T0 + DAY } }), effective: true, name: "valid credential reports its effective lifetime" },
      credVerify("non-canonical: leading whitespace", " " + good.text, T0, no("not-canonical")),
      credVerify("non-canonical: pretty-printed", JSON.stringify(good.credential, null, 2), T0, no("not-canonical")),
      credVerify("wrong domain: signed under the descriptor domain", canonicalJson({ ...goodBody, sig: await rawSign(c.ids.issuerA, DOMAINS.descriptor, goodBody) }), T0, no("bad-signature")),
      credVerify("wrong domain: signed under the ticket domain", canonicalJson({ ...goodBody, sig: await rawSign(c.ids.issuerA, DOMAINS.ticket, goodBody) }), T0, no("bad-signature")),
      credVerify("tampered role", good.text.replace('"role":"member"', '"role":"guest"'), T0, no("bad-signature")),
      credVerify("tampered notAfter", canonicalJson({ ...good.credential, notAfter: T0 + 2 * DAY }), T0, no("bad-signature")),
      credVerify("expired", good.text, T0 + DAY + 301, no("expired")),
      credVerify("skew edge: accepted 300 s before notBefore", good.text, T0 - 300, T.ok),
      credVerify("skew edge: refused 301 s before notBefore", good.text, T0 - 301, no("not-yet-valid")),
      credVerify("skew edge: accepted 300 s after notAfter", good.text, T0 + DAY + 300, T.ok),
      credVerify("skew edge: refused 301 s after notAfter", good.text, T0 + DAY + 301, no("expired")),
      { name: "skew option above 300 is capped at 300", op: "verifyCredential", input: good.text, options: { now: T0 - 301, skew: 100000 }, expect: no("not-yet-valid") },
      credVerify("clamped: a year-long credential is valid inside the ttl", longLife.text, T0 + 6 * DAY, { ok: true, effective: { notBefore: T0, notAfter: T0 + 7 * DAY } }, { effective: true }),
      credVerify("clamped: a year-long credential has expired after the ttl", longLife.text, T0 + 8 * DAY, no("expired")),
      credVerify("backdated notBefore does not extend the lifetime", backdated.text, T0, no("expired")),
      credVerify("revoked serial", (await issue({ serial: 7 })).text, T0, no("revoked"), { descriptor: withRevoked }),
      credVerify("revoked serial: another serial still passes", (await issue({ serial: 2 })).text, T0, T.ok, { descriptor: withRevoked }),
      credVerify("removed issuer", good.text, T0, no("issuer-not-listed"), { descriptor: withoutA }),
      credVerify("removed issuer: the other issuer still passes", (await issue({}, "issuerB")).text, T0, T.ok, { descriptor: withoutA }),
      credVerify("older epoch than the descriptor", good.text, T0, no("epoch-too-old"), { descriptor: epoch1 }),
      credVerify("unknown role", (await issue({ role: "admin" })).text, T0, no("unknown-role")),
      credVerify("another realm's id", (await issue({ realm: c.keys.rogue.keyId })).text, T0, no("wrong-realm")),
      credVerify("issuer not in the descriptor", (await issue({}, "alice")).text, T0, no("issuer-not-listed")),
      { name: "subject is the proven key", op: "checkSubject", input: good.text, provenKey: alice, options: { now: T0 }, expect: T.ok },
      { name: "subject mismatch: a stolen credential", op: "checkSubject", input: good.text, provenKey: c.keys.bob.publicKey, options: { now: T0 }, expect: no("subject-mismatch") },
      { name: "tracker: newer serial then stale serial", op: "tracker", sequence: [(await issue({ serial: 5 })).text, (await issue({ serial: 3 })).text], options: { now: T0 }, expect: no("stale-serial") },
      { name: "tracker: increasing serials", op: "tracker", sequence: [(await issue({ serial: 3 })).text, (await issue({ serial: 5 })).text], options: { now: T0 }, expect: T.ok },
      { name: "tracker: older epoch than noted", op: "tracker", noteEpoch: 1, sequence: [good.text], options: { now: T0 }, expect: no("epoch-too-old") },
    ],
  };

  return { "descriptor.json": descriptorVectors, "rotation.json": rotationVectors, "credential.json": credentialVectors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = await buildVectors();
  for (const [name, value] of Object.entries(out)) {
    await writeFile(new URL(`./vectors/${name}`, import.meta.url), JSON.stringify(value, null, 2) + "\n");
  }
  console.log(`wrote ${Object.keys(out).join(", ")}`);
}
