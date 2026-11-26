// Language-neutral test vectors (test/vectors/*.json). Each file lists fixed keys (32-byte seeds as hex), the exact
// canonical text and signature, and verdicts. This runner uses only the JSON and the public API; the generator
// (test/make-vectors.mjs) is checked to reproduce the committed files byte for byte.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { canonicalJson, parseCanonical, domainSigningBytes } from "@johnhenry/browsermesh-primitives";
import {
  verifyDescriptor, verifyAuthorityless, adoptDescriptor, verifyChain, verifyRotation, verifyCredential,
  checkSubject, createCredentialTracker, publicKeyOf, keyId,
} from "../src/index.mjs";
import { identityFromSeed } from "./helpers.mjs";
import { buildVectors } from "./make-vectors.mjs";

const DIR = fileURLToPath(new URL("./vectors/", import.meta.url));
const load = async (name) => JSON.parse(await readFile(join(DIR, name), "utf8"));

const verdict = (v) => (v.ok ? { ok: true } : { ok: false, reason: v.reason });

async function check(c, ctx) {
  const o = c.options ?? {};
  switch (c.op) {
    case "verifyDescriptor":
      return verdict(await verifyDescriptor(c.input, o));
    case "verifyAuthorityless":
      return verdict(await verifyAuthorityless(c.input, o));
    case "adoptDescriptor": {
      const held = c.held ? (await verifyDescriptor(c.held, { pinnedId: o.pinnedId, now: o.now })).descriptor : null;
      return verdict(await adoptDescriptor(held, c.offered, o));
    }
    case "verifyRotation":
      return verdict(await verifyRotation(c.statement, o));
    case "verifyChain":
      return verdict(await verifyChain(c.chain, o));
    case "verifyCredential": {
      const text = c.descriptor ?? ctx.descriptor;
      const d = (await verifyDescriptor(text, { pinnedId: ctx.realmId, now: o.now })).descriptor;
      const v = await verifyCredential(c.input, d, o);
      const out = verdict(v);
      if (v.ok && c.effective) out.effective = v.effective;
      return out;
    }
    case "checkSubject": {
      const d = (await verifyDescriptor(ctx.descriptor, { pinnedId: ctx.realmId, now: o.now })).descriptor;
      const v = await verifyCredential(c.input, d, { now: o.now });
      return verdict(checkSubject(v.credential, c.provenKey));
    }
    case "tracker": {
      const d = (await verifyDescriptor(ctx.descriptor, { pinnedId: ctx.realmId, now: o.now })).descriptor;
      const tracker = createCredentialTracker();
      if (c.noteEpoch !== undefined) tracker.noteEpoch(ctx.realmId, c.noteEpoch);
      let last;
      for (const text of c.sequence) {
        const v = await verifyCredential(text, d, { now: o.now });
        last = tracker.admit(v);
      }
      return verdict(last);
    }
    default:
      throw new Error(`unknown op ${c.op}`);
  }
}

describe("vectors", () => {
  it("the vector files exist", async () => {
    const files = (await readdir(DIR)).filter((f) => f.endsWith(".json")).sort();
    assert.deepEqual(files, ["credential.json", "descriptor.json", "rotation.json"]);
  });

  it("the committed files are exactly what the generator produces (Ed25519 is deterministic)", async () => {
    const built = await buildVectors();
    for (const [name, value] of Object.entries(built)) {
      const committed = await readFile(join(DIR, name), "utf8");
      assert.equal(committed, JSON.stringify(value, null, 2) + "\n", name);
    }
  });

  for (const file of ["descriptor.json", "rotation.json", "credential.json"]) {
    describe(file, () => {
      it("keys: seeds reproduce the listed public keys and ids", async () => {
        const v = await load(file);
        for (const [name, k] of Object.entries(v.keys)) {
          const id = await identityFromSeed(k.seed);
          assert.equal(await publicKeyOf(id), k.publicKey, name);
          assert.equal(await keyId(k.publicKey), k.keyId, name);
        }
      });

      it("every document's canonical text and signature reproduce", async () => {
        const v = await load(file);
        for (const doc of v.documents ?? []) {
          const body = parseCanonical(doc.unsigned);
          assert.equal(canonicalJson(body), doc.unsigned, doc.name);
          const signer = await identityFromSeed(v.keys[doc.signer].seed);
          const sig = Buffer.from(await signer.sign(domainSigningBytes(doc.domain, doc.unsigned))).toString("base64url");
          assert.equal(sig, doc.signature, doc.name);
          assert.equal(canonicalJson({ ...body, sig }), doc.signed, doc.name);
          assert.equal(Buffer.from(domainSigningBytes(doc.domain, doc.unsigned)).toString("hex"), doc.signingBytesHex, doc.name);
          if (doc.countersigner) {
            const counter = await identityFromSeed(v.keys[doc.countersigner].seed);
            const text = canonicalJson({ ...body, sig });
            const cs = Buffer.from(await counter.sign(domainSigningBytes(doc.countersignDomain, text))).toString("base64url");
            assert.equal(cs, doc.countersignature, doc.name);
          }
        }
      });

      it("every case yields its stated verdict", async () => {
        const v = await load(file);
        assert.ok(v.cases.length > 0);
        const ctx = { descriptor: v.descriptor, realmId: v.realmId };
        for (const c of v.cases) {
          assert.deepEqual(await check(c, ctx), c.expect, `${file}: ${c.name}`);
        }
      });
    });
  }

  it("cover the required reject classes", async () => {
    const names = [];
    for (const f of ["descriptor.json", "rotation.json", "credential.json"]) names.push(...(await load(f)).cases.map((c) => c.name));
    const text = names.join("\n").toLowerCase();
    for (const needle of [
      "non-canonical", "wrong domain", "tampered", "expired", "skew edge", "revoked serial", "removed issuer",
      "older epoch", "stale serial", "forked chain",
    ]) assert.ok(text.includes(needle), `no case named like "${needle}"`);
  });
});
