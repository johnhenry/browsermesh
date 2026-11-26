import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, parseCanonical, domainSigningBytes } from "@johnhenry/browsermesh-primitives";
import {
  createDescriptor, signDescriptor, verifyDescriptor, createAuthorityless, verifyAuthorityless,
  keyId, publicKeyOf, DOMAINS, DEFAULT_TTL, isStale,
} from "../src/index.mjs";
import { buildRealm, identityFromSeed, SEEDS, T0, DAY, ROLES } from "./helpers.mjs";

const reason = (v) => (v.ok ? "ok" : v.reason);

describe("descriptor: creation and signing", () => {
  it("derives the realm id as base64url SHA-256 of the genesis root key (the pod-id derivation)", async () => {
    const r = await buildRealm();
    assert.equal(r.id, await keyId(r.rootKey));
    assert.equal(r.id, r.root.podId);
  });

  it("defaults: ttl 7 days, empty lists, serial 1, epoch 0", async () => {
    assert.equal(DEFAULT_TTL, 7 * DAY);
    const r = await buildRealm({ ttl: undefined, serial: undefined, epoch: undefined });
    assert.equal(r.descriptor.ttl, 7 * DAY);
    assert.equal(r.descriptor.serial, 1);
    assert.equal(r.descriptor.epoch, 0);
    assert.deepEqual(r.descriptor.revoked, []);
    assert.deepEqual(r.descriptor.admitters, []);
  });

  it("signs a canonical text that is byte-identical to canonicalJson of the document", async () => {
    const r = await buildRealm();
    assert.equal(r.text, canonicalJson(parseCanonical(r.text)));
    assert.ok(typeof r.descriptor.sig === "string" && r.descriptor.sig.length === 86);
  });

  it("the signature is over domainSigningBytes(descriptor domain, canonical text without sig)", async () => {
    const r = await buildRealm();
    const { sig, ...body } = r.descriptor;
    const bytes = domainSigningBytes(DOMAINS.descriptor, canonicalJson(body));
    assert.equal(DOMAINS.descriptor, "browsermesh-realm/descriptor/1");
    const key = await crypto.subtle.importKey("raw", Buffer.from(r.rootKey, "base64url"), "Ed25519", false, ["verify"]);
    assert.equal(await crypto.subtle.verify("Ed25519", key, Buffer.from(sig, "base64url"), bytes), true);
  });

  it("is deterministic (Ed25519): the same inputs sign to the same text", async () => {
    const a = await buildRealm();
    const b = await buildRealm();
    assert.equal(a.text, b.text);
  });

  it("createDescriptor throws a typed error on invalid input", async () => {
    await assert.rejects(buildRealm({ mode: "weird" }), { code: "malformed" });
    await assert.rejects(buildRealm({ roles: { member: ["mcp:*:call"] } }), { code: "bad-scope" });
    await assert.rejects(buildRealm({ ttl: 5 }), { code: "malformed" });
    await assert.rejects(buildRealm({ serial: 0 }), { code: "malformed" });
  });

  it("signDescriptor refuses to sign with a key that is not the descriptor's root", async () => {
    const r = await buildRealm();
    const rogue = await identityFromSeed(SEEDS.rogue);
    await assert.rejects(signDescriptor(r.descriptor, rogue), { code: "wrong-signer" });
  });
});

describe("descriptor: verification", () => {
  it("accepts a good descriptor", async () => {
    const r = await buildRealm();
    const v = await verifyDescriptor(r.text, { pinnedId: r.id, now: T0 });
    assert.equal(v.ok, true);
    assert.equal(v.descriptor.name, "test realm");
    assert.equal(v.chainLength, 0);
  });

  it("refuses a different pinned id", async () => {
    const r = await buildRealm();
    const other = await keyId(await publicKeyOf(await identityFromSeed(SEEDS.rogue)));
    assert.equal(reason(await verifyDescriptor(r.text, { pinnedId: other, now: T0 })), "wrong-realm");
  });

  it("refuses text that is not canonical (whitespace, key order, short escapes)", async () => {
    const r = await buildRealm();
    assert.equal(reason(await verifyDescriptor(" " + r.text, { pinnedId: r.id, now: T0 })), "not-canonical");
    assert.equal(reason(await verifyDescriptor(JSON.stringify(r.descriptor, null, 1), { pinnedId: r.id, now: T0 })), "not-canonical");
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(r.descriptor).reverse()));
    assert.equal(reason(await verifyDescriptor(reordered, { pinnedId: r.id, now: T0 })), "not-canonical");
  });

  it("refuses a tampered field (signature no longer verifies)", async () => {
    const r = await buildRealm();
    const tampered = r.text.replace('"name":"test realm"', '"name":"test realms"');
    assert.notEqual(tampered, r.text);
    assert.equal(reason(await verifyDescriptor(tampered, { pinnedId: r.id, now: T0 })), "bad-signature");
    const bumped = canonicalJson({ ...r.descriptor, epoch: 1 });
    assert.equal(reason(await verifyDescriptor(bumped, { pinnedId: r.id, now: T0 })), "bad-signature");
  });

  it("refuses a signature made under another domain (a credential-domain signature is not a descriptor's)", async () => {
    const r = await buildRealm();
    const { sig, ...body } = r.descriptor;
    const wrong = domainSigningBytes(DOMAINS.credential, canonicalJson(body));
    const forged = Buffer.from(await r.root.sign(wrong)).toString("base64url");
    const text = canonicalJson({ ...body, sig: forged });
    assert.equal(reason(await verifyDescriptor(text, { pinnedId: r.id, now: T0 })), "bad-signature");
  });

  it("refuses a descriptor signed by a key other than the root", async () => {
    const r = await buildRealm();
    const rogue = await identityFromSeed(SEEDS.rogue);
    const { sig, ...body } = r.descriptor;
    const forged = Buffer.from(await rogue.sign(domainSigningBytes(DOMAINS.descriptor, canonicalJson(body)))).toString("base64url");
    assert.equal(reason(await verifyDescriptor(canonicalJson({ ...body, sig: forged }), { pinnedId: r.id, now: T0 })), "bad-signature");
  });

  it("refuses a root key that does not hash to the id when there is no chain", async () => {
    const r = await buildRealm();
    const rogue = await identityFromSeed(SEEDS.rogue);
    const rogueKey = await publicKeyOf(rogue);
    const { sig, ...body } = r.descriptor;
    const swapped = { ...body, root: { key: rogueKey, chain: [] } };
    const s = Buffer.from(await rogue.sign(domainSigningBytes(DOMAINS.descriptor, canonicalJson(swapped)))).toString("base64url");
    assert.equal(reason(await verifyDescriptor(canonicalJson({ ...swapped, sig: s }), { pinnedId: r.id, now: T0 })), "bad-id");
  });

  it("refuses an expired snapshot (validUntil in the past) and reports staleness", async () => {
    const r = await buildRealm({ validUntil: T0 + DAY });
    assert.equal((await verifyDescriptor(r.text, { pinnedId: r.id, now: T0 })).ok, true);
    assert.equal(reason(await verifyDescriptor(r.text, { pinnedId: r.id, now: T0 + DAY + 1 })), "expired");
    assert.equal(isStale(r.descriptor, T0 + DAY), false);
    assert.equal(isStale(r.descriptor, T0 + DAY + 1), true);
  });

  it("refuses a role with a wildcard or short scope at parse (even if correctly signed)", async () => {
    const r = await buildRealm();
    for (const scope of ["mcp:*:call", "mcp:tool", "*", "a::c"]) {
      const { sig, ...body } = r.descriptor;
      const bad = { ...body, roles: { ...ROLES, member: [scope] } };
      const s = Buffer.from(await r.root.sign(domainSigningBytes(DOMAINS.descriptor, canonicalJson(bad)))).toString("base64url");
      assert.equal(reason(await verifyDescriptor(canonicalJson({ ...bad, sig: s }), { pinnedId: r.id, now: T0 })), "bad-scope", scope);
    }
  });

  it("refuses unknown top-level fields, wrong version and open mode without guest", async () => {
    const r = await buildRealm();
    const resign = async (body) => {
      const s = Buffer.from(await r.root.sign(domainSigningBytes(DOMAINS.descriptor, canonicalJson(body)))).toString("base64url");
      return canonicalJson({ ...body, sig: s });
    };
    const { sig, ...body } = r.descriptor;
    assert.equal(reason(await verifyDescriptor(await resign({ ...body, surprise: 1 }), { pinnedId: r.id, now: T0 })), "malformed");
    assert.equal(reason(await verifyDescriptor(await resign({ ...body, v: 2 }), { pinnedId: r.id, now: T0 })), "unsupported-version");
    assert.equal(reason(await verifyDescriptor(await resign({ ...body, mode: "open", roles: { member: ROLES.member } }), { pinnedId: r.id, now: T0 })), "malformed");
  });

  it("enforces the size limit before parsing", async () => {
    const r = await buildRealm();
    assert.equal(reason(await verifyDescriptor(r.text, { pinnedId: r.id, now: T0, maxBytes: 100 })), "too-large");
    await assert.rejects(buildRealm({ extensions: { blob: "x".repeat(40000) } }), { code: "too-large" });
  });

  it("never throws on hostile input", async () => {
    const r = await buildRealm();
    for (const input of [null, undefined, 5, {}, [], "", "{", "null", "[]", '{"a":1}', "\u0000", "x".repeat(100000), Buffer.from("abc")]) {
      const v = await verifyDescriptor(input, { pinnedId: r.id, now: T0 });
      assert.equal(v.ok, false);
      assert.equal(typeof v.reason, "string");
    }
    assert.equal((await verifyDescriptor(r.text, {})).ok, false);
    assert.equal((await verifyDescriptor(r.text)).ok, false);
  });

  it("refuses duplicate issuers, more issuers than the cap and unbounded revoked lists", async () => {
    await assert.rejects(buildRealm({ issuers: [{ key: "A".repeat(43), notAfter: T0 }, { key: "A".repeat(43), notAfter: T0 }] }), { code: "malformed" });
    await assert.rejects(buildRealm({ revoked: Array.from({ length: 600 }, (_, i) => i + 1) }), { code: "malformed" });
    await assert.rejects(buildRealm({ revoked: [3, 2] }), { code: "malformed" });
  });

  it("validates rendezvous: browser-usable URLs only", async () => {
    await assert.rejects(buildRealm({ rendezvous: { signaling: ["tcp://x.test:1"], relays: [], ice: [], bootstrap: [] } }), { code: "malformed" });
    await assert.rejects(buildRealm({ rendezvous: { signaling: ["ws://sig.example.test/"], relays: [], ice: [], bootstrap: [] } }), { code: "malformed" });
    const ok = await buildRealm({ rendezvous: { signaling: ["ws://localhost:8787/"], relays: [], ice: [{ urls: ["turn:t.example.test:3478"], username: "u", credential: "c" }], bootstrap: [] } });
    assert.equal(ok.descriptor.rendezvous.signaling[0], "ws://localhost:8787/");
  });

  it("open mode: guest is the default role; privileged roles still exist", async () => {
    const r = await buildRealm({ mode: "open" });
    assert.equal(r.descriptor.mode, "open");
    assert.equal((await verifyDescriptor(r.text, { pinnedId: r.id, now: T0 })).ok, true);
  });
});

describe("authority-less open form", () => {
  const roles = { guest: ["protocol:mcp:open"] };
  const hints = { signaling: ["wss://sig.example.test/ws"], relays: [], ice: [], bootstrap: [] };

  it("has no root, no issuers; id hashes name, roles and salt only", async () => {
    const a = await createAuthorityless({ name: "commons", roles, salt: "AAAAAAAAAAAAAAAAAAAAAA", hints });
    assert.equal(a.descriptor.root, undefined);
    assert.equal(a.descriptor.issuers, undefined);
    assert.equal(a.descriptor.mode, "open");
    const b = await createAuthorityless({ name: "commons", roles, salt: "AAAAAAAAAAAAAAAAAAAAAA", hints: { ...hints, signaling: ["wss://other.example.test/"] } });
    assert.equal(a.descriptor.id, b.descriptor.id, "changing the hints does not change the id");
    const c = await createAuthorityless({ name: "commons", roles, salt: "BBBBBBBBBBBBBBBBBBBBBB", hints });
    assert.notEqual(a.descriptor.id, c.descriptor.id);
    const d = await createAuthorityless({ name: "commons2", roles, salt: "AAAAAAAAAAAAAAAAAAAAAA", hints });
    assert.notEqual(a.descriptor.id, d.descriptor.id);
  });

  it("verifies against a pinned id; hints are outside the hash and so replaceable", async () => {
    const a = await createAuthorityless({ name: "commons", roles, salt: "AAAAAAAAAAAAAAAAAAAAAA", hints });
    assert.equal((await verifyAuthorityless(a.text, { pinnedId: a.descriptor.id })).ok, true);
    const swapped = canonicalJson({ ...a.descriptor, hints: { ...hints, relays: ["wss://new-relay.example.test/"] } });
    const v = await verifyAuthorityless(swapped, { pinnedId: a.descriptor.id });
    assert.equal(v.ok, true);
    assert.deepEqual(v.descriptor.hints.relays, ["wss://new-relay.example.test/"]);
  });

  it("refuses a changed name or role set (the id no longer matches)", async () => {
    const a = await createAuthorityless({ name: "commons", roles, salt: "AAAAAAAAAAAAAAAAAAAAAA", hints });
    const renamed = canonicalJson({ ...a.descriptor, name: "other" });
    assert.equal(reason(await verifyAuthorityless(renamed, { pinnedId: a.descriptor.id })), "bad-id");
    const widened = canonicalJson({ ...a.descriptor, roles: { guest: ["protocol:mcp:open", "mcp:x:call"] } });
    assert.equal(reason(await verifyAuthorityless(widened, { pinnedId: a.descriptor.id })), "bad-id");
  });

  it("can never carry a privileged role or a non-open mode", async () => {
    await assert.rejects(createAuthorityless({ name: "x", roles: { guest: ["a:b:c"], admin: ["a:b:c"] }, salt: "AAAAAAAAAAAAAAAAAAAAAA", hints }), { code: "bad-role" });
    await assert.rejects(createAuthorityless({ name: "x", roles: { guest: ["egress:tcp:h.test:443:connect"] }, salt: "AAAAAAAAAAAAAAAAAAAAAA", hints }), { code: "bad-scope" });
    await assert.rejects(createAuthorityless({ name: "x", roles: { guest: ["pod-host:spawn:call"] }, salt: "AAAAAAAAAAAAAAAAAAAAAA", hints }), { code: "bad-scope" });
    await assert.rejects(createAuthorityless({ name: "x", roles: { guest: ["rpc:wsh-exec:call"] }, salt: "AAAAAAAAAAAAAAAAAAAAAA", hints }), { code: "bad-scope" });
    const a = await createAuthorityless({ name: "commons", roles, salt: "AAAAAAAAAAAAAAAAAAAAAA", hints });
    for (const extra of [{ mode: "invite" }, { root: { key: "A".repeat(43), chain: [] } }, { issuers: [] }, { sig: "x" }]) {
      const v = await verifyAuthorityless(canonicalJson({ ...a.descriptor, ...extra }), { pinnedId: a.descriptor.id });
      assert.equal(v.ok, false, JSON.stringify(extra));
    }
  });

  it("is refused by verifyDescriptor and refuses non-canonical text", async () => {
    const a = await createAuthorityless({ name: "commons", roles, salt: "AAAAAAAAAAAAAAAAAAAAAA", hints });
    assert.equal((await verifyDescriptor(a.text, { pinnedId: a.descriptor.id, now: T0 })).ok, false);
    assert.equal(reason(await verifyAuthorityless(" " + a.text, { pinnedId: a.descriptor.id })), "not-canonical");
    assert.equal((await verifyAuthorityless(null, {})).ok, false);
  });
});
