import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "@johnhenry/browsermesh-primitives";
import {
  createDescriptor, signDescriptor, issueCredential, verifyCredential, checkSubject, createCredentialTracker, DOMAINS, publicKeyOf,
} from "../src/index.mjs";
import { buildRealm, rawSign, identityFromSeed, SEEDS, T0, DAY } from "./helpers.mjs";

const reason = (v) => (v.ok ? "ok" : v.reason);

async function setup(over = {}) {
  const r = await buildRealm(over);
  const fields = (o = {}) => ({
    realm: r.id, subject: r.aliceKey, role: "member", serial: 1, notBefore: T0, notAfter: T0 + DAY, epoch: r.descriptor.epoch, ...o,
  });
  const issue = async (o = {}, issuer = r.issuerA) => (await issueCredential(fields(o), issuer)).text;
  return { r, fields, issue };
}

describe("issueCredential", () => {
  it("produces canonical text with exactly the credential fields and a domain-separated signature", async () => {
    const { r, fields } = await setup();
    const { text, credential } = await issueCredential(fields(), r.issuerA);
    assert.equal(text, canonicalJson(credential));
    assert.deepEqual(Object.keys(credential).sort(), ["epoch", "issuer", "notAfter", "notBefore", "realm", "role", "serial", "sig", "subject", "v"]);
    assert.equal(credential.issuer, r.issuerAKey);
    const { sig, ...body } = credential;
    assert.equal(sig, await rawSign(r.issuerA, DOMAINS.credential, body));
    assert.equal(DOMAINS.credential, "browsermesh-realm/credential/1");
  });

  it("refuses to issue malformed credentials (there is no keyless form)", async () => {
    const { r, fields } = await setup();
    for (const o of [
      { subject: "*" }, { subject: "" }, { subject: null }, { subject: "A".repeat(42) },
      { role: "Bad Role" }, { serial: 0 }, { serial: 1.5 }, { notAfter: T0 - 1 }, { notBefore: -1 }, { epoch: -1 }, { realm: "nope" },
      { notAfter: T0 * 1000 },
    ]) {
      await assert.rejects(issueCredential(fields(o), r.issuerA), { code: "malformed" }, JSON.stringify(o));
    }
  });
});

describe("verifyCredential", () => {
  it("accepts a good credential and reports the effective lifetime", async () => {
    const { r, issue } = await setup();
    const v = await verifyCredential(await issue(), r.descriptor, { now: T0 + 100 });
    assert.equal(v.ok, true);
    assert.equal(v.credential.subject, r.aliceKey);
    assert.deepEqual(v.effective, { notBefore: T0, notAfter: T0 + DAY });
    assert.equal(v.clamped, false);
    assert.equal(v.descriptorBehind, false);
  });

  it("refuses text that is not canonical", async () => {
    const { r, issue } = await setup();
    const text = await issue();
    assert.equal(reason(await verifyCredential(" " + text, r.descriptor, { now: T0 })), "not-canonical");
    assert.equal(reason(await verifyCredential(JSON.stringify(JSON.parse(text), null, 2), r.descriptor, { now: T0 })), "not-canonical");
  });

  it("refuses a tampered field and a signature under the wrong domain", async () => {
    const { r, issue, fields } = await setup();
    const c = JSON.parse(await issue());
    assert.equal(reason(await verifyCredential(canonicalJson({ ...c, role: "guest" }), r.descriptor, { now: T0 })), "bad-signature");
    assert.equal(reason(await verifyCredential(canonicalJson({ ...c, notAfter: c.notAfter + 1 }), r.descriptor, { now: T0 })), "bad-signature");
    const { sig, ...body } = c;
    for (const domain of [DOMAINS.descriptor, DOMAINS.rotation, DOMAINS.ticket]) {
      const wrong = canonicalJson({ ...body, sig: await rawSign(r.issuerA, domain, body) });
      assert.equal(reason(await verifyCredential(wrong, r.descriptor, { now: T0 })), "bad-signature", domain);
    }
    assert.ok(fields);
  });

  it("refuses a credential for another realm (replay across realms), even from a shared issuer key", async () => {
    const { r, issue } = await setup();
    const rogueRoot = await identityFromSeed(SEEDS.rogue);
    const d2 = await signDescriptor(await createDescriptor({
      name: "second", mode: "invite", root: { key: await publicKeyOf(rogueRoot), chain: [] }, issuers: r.fields.issuers,
      roles: r.fields.roles, rendezvous: r.fields.rendezvous,
    }), rogueRoot);
    assert.notEqual(d2.descriptor.id, r.id);
    assert.equal(reason(await verifyCredential(await issue(), d2.descriptor, { now: T0 })), "wrong-realm");
  });

  it("refuses an unknown role and an issuer the descriptor does not list (removed issuer)", async () => {
    const { r, issue } = await setup();
    assert.equal(reason(await verifyCredential(await issue({ role: "admin" }), r.descriptor, { now: T0 })), "unknown-role");
    const removed = await buildRealm({ issuers: [r.fields.issuers[1]] });
    assert.equal(removed.id, r.id);
    assert.equal(reason(await verifyCredential(await issue({}, r.issuerA), removed.descriptor, { now: T0 })), "issuer-not-listed");
    assert.equal((await verifyCredential(await issue({}, r.issuerB), removed.descriptor, { now: T0 })).ok, true);
  });

  it("respects the issuer's own expiry", async () => {
    const base = await buildRealm();
    const short = await buildRealm({ issuers: [{ key: base.issuerAKey, notAfter: T0 + 1000 }] });
    const text = (await issueCredential({ realm: short.id, subject: short.aliceKey, role: "member", serial: 1, notBefore: T0, notAfter: T0 + DAY, epoch: 0 }, short.issuerA)).text;
    const v = await verifyCredential(text, short.descriptor, { now: T0 + 500 });
    assert.equal(v.ok, true);
    assert.equal(v.effective.notAfter, T0 + 1000);
    assert.equal(v.clamped, true);
    assert.equal(reason(await verifyCredential(text, short.descriptor, { now: T0 + 1000 + 301 })), "expired");
  });

  it("refuses an epoch below the descriptor's; notes when the verifier's descriptor is behind", async () => {
    const { r, issue } = await setup({ epoch: 2 });
    assert.equal(reason(await verifyCredential(await issue({ epoch: 1 }), r.descriptor, { now: T0 })), "epoch-too-old");
    assert.equal((await verifyCredential(await issue({ epoch: 2 }), r.descriptor, { now: T0 })).ok, true);
    const ahead = await verifyCredential(await issue({ epoch: 3 }), r.descriptor, { now: T0 });
    assert.equal(ahead.ok, true);
    assert.equal(ahead.descriptorBehind, true);
  });

  it("refuses a serial listed in revoked", async () => {
    const { r, issue } = await setup({ revoked: [5, 9] });
    assert.equal(reason(await verifyCredential(await issue({ serial: 5 }), r.descriptor, { now: T0 })), "revoked");
    assert.equal(reason(await verifyCredential(await issue({ serial: 9 }), r.descriptor, { now: T0 })), "revoked");
    assert.equal((await verifyCredential(await issue({ serial: 6 }), r.descriptor, { now: T0 })).ok, true);
  });

  it("clock skew: 300 s tolerance at both ends, never more", async () => {
    const { r, issue } = await setup();
    const text = await issue();
    const at = (now, opts = {}) => verifyCredential(text, r.descriptor, { now, ...opts });
    assert.equal((await at(T0 - 300)).ok, true);
    assert.equal(reason(await at(T0 - 301)), "not-yet-valid");
    assert.equal((await at(T0 + DAY + 300)).ok, true);
    assert.equal(reason(await at(T0 + DAY + 301)), "expired");
    assert.equal(reason(await at(T0 - 301, { skew: 100000 })), "not-yet-valid", "skew is capped at 300");
    assert.equal(reason(await at(T0 + DAY + 301, { skew: 100000 })), "expired");
    assert.equal((await at(T0 - 10, { skew: 0 })).ok, false);
    assert.equal((await at(T0 - 100, { skew: 100 })).ok, true);
    assert.equal(reason(await at(T0 - 1, { skew: -50 })), "not-yet-valid", "negative skew is zero");
  });

  it("accepts now as a function and defaults to the real clock", async () => {
    const { r, issue } = await setup();
    assert.equal((await verifyCredential(await issue(), r.descriptor, { now: () => T0 })).ok, true);
    assert.equal((await verifyCredential(await issue(), r.descriptor)).ok, false, "the real clock is not T0");
  });

  it("refuses against a stale descriptor snapshot", async () => {
    const { r, issue } = await setup({ validUntil: T0 + 10 });
    assert.equal(reason(await verifyCredential(await issue(), r.descriptor, { now: T0 + 11 })), "descriptor-stale");
  });

  it("never throws on hostile input", async () => {
    const { r } = await setup();
    for (const input of [null, undefined, 1, {}, [], "", "{}", '{"v":1}', "x".repeat(100000)]) {
      const v = await verifyCredential(input, r.descriptor, { now: T0 });
      assert.equal(v.ok, false);
    }
    const { issue } = await setup();
    assert.equal((await verifyCredential(await issue(), null, { now: T0 })).ok, false);
    assert.equal((await verifyCredential(await issue(), {}, { now: T0 })).ok, false);
  });
});

describe("checkSubject", () => {
  it("accepts only the proven key (base64url or raw bytes)", async () => {
    const { r, issue } = await setup();
    const v = await verifyCredential(await issue(), r.descriptor, { now: T0 });
    assert.equal(checkSubject(v.credential, r.aliceKey).ok, true);
    assert.equal(checkSubject(v.credential, await r.alice.rawPublicKey()).ok, true);
    assert.equal(checkSubject(v.credential, r.bobKey).reason, "subject-mismatch");
    assert.equal(checkSubject(v.credential, await r.bob.rawPublicKey()).reason, "subject-mismatch");
    assert.equal(checkSubject(v.credential, null).ok, false);
    assert.equal(checkSubject(null, r.aliceKey).ok, false);
    assert.equal(checkSubject(v, r.aliceKey).ok, true, "also takes a verifyCredential result");
  });
});

describe("monotonic checks (the registry does not order serials)", () => {
  it("refuses a serial older than the one held for the same (realm, issuer, subject, role)", async () => {
    const { r, issue } = await setup();
    const tracker = createCredentialTracker();
    const v5 = await verifyCredential(await issue({ serial: 5 }), r.descriptor, { now: T0 });
    assert.equal(tracker.admit(v5, { now: T0 }).ok, true);
    const v3 = await verifyCredential(await issue({ serial: 3 }), r.descriptor, { now: T0 });
    assert.equal(tracker.check(v3).reason, "stale-serial");
    assert.equal(tracker.admit(v3).reason, "stale-serial");
    assert.equal(tracker.admit(v5).ok, true, "the same serial again is idempotent");
    const v7 = await verifyCredential(await issue({ serial: 7 }), r.descriptor, { now: T0 });
    assert.equal(tracker.admit(v7).ok, true);
    assert.equal(tracker.admit(v5).reason, "stale-serial", "after renewal the older one is dead");
  });

  it("is independent per role, subject and issuer", async () => {
    const { r, issue } = await setup();
    const tracker = createCredentialTracker();
    const a = await verifyCredential(await issue({ serial: 9 }), r.descriptor, { now: T0 });
    tracker.admit(a);
    for (const text of [await issue({ serial: 2, role: "guest" }), await issue({ serial: 2, subject: r.bobKey }), await issue({ serial: 2 }, r.issuerB)]) {
      assert.equal(tracker.admit(await verifyCredential(text, r.descriptor, { now: T0 })).ok, true);
    }
  });

  it("refuses a credential whose epoch is older than the highest epoch noted for the realm", async () => {
    const { r, issue } = await setup();
    const tracker = createCredentialTracker();
    tracker.noteEpoch(r.id, 4);
    const v = await verifyCredential(await issue({ epoch: 3 }), r.descriptor, { now: T0 });
    assert.equal(v.ok, true);
    assert.equal(tracker.check(v).reason, "epoch-too-old");
    tracker.noteEpoch(r.id, 2);
    assert.equal(tracker.epochOf(r.id), 4, "noting a lower epoch does not lower it");
  });

  it("verifyCredential can drive the tracker itself", async () => {
    const { r, issue } = await setup();
    const tracker = createCredentialTracker();
    assert.equal((await verifyCredential(await issue({ serial: 5 }), r.descriptor, { now: T0, tracker })).ok, true);
    assert.equal(reason(await verifyCredential(await issue({ serial: 4 }), r.descriptor, { now: T0, tracker })), "stale-serial");
  });

  it("is bounded: when full it refuses new keys rather than forgetting held serials", async () => {
    const { r, issue } = await setup();
    const tracker = createCredentialTracker({ maxEntries: 2 });
    for (const serial of [1, 2]) {
      const v = await verifyCredential(await issue({ serial, role: serial === 1 ? "member" : "guest" }), r.descriptor, { now: T0 });
      assert.equal(tracker.admit(v, { now: T0 }).ok, true);
    }
    const v = await verifyCredential(await issue({ serial: 3, subject: r.bobKey }), r.descriptor, { now: T0 });
    assert.equal(tracker.admit(v, { now: T0 }).reason, "tracker-full");
    const later = await verifyCredential(await issue({ serial: 3, subject: r.bobKey, notBefore: T0 + 3 * DAY, notAfter: T0 + 4 * DAY }), r.descriptor, { now: T0 + 3 * DAY });
    assert.equal(tracker.admit(later, { now: T0 + 3 * DAY }).ok, true, "expired entries are evicted to make room");
  });
});
