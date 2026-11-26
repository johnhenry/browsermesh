import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "@johnhenry/browsermesh-primitives";
import {
  createRotation, signRotation, countersignRotation, verifyRotation, verifyChain,
  createDescriptor, signDescriptor, verifyDescriptor, publicKeyOf, keyId, DOMAINS,
} from "../src/index.mjs";
import { rawSign, identityFromSeed, SEEDS, T0, DAY, ROLES, RENDEZVOUS } from "./helpers.mjs";

const reason = (v) => (v.ok ? "ok" : v.reason);

async function keys() {
  const ids = {};
  for (const n of ["root0", "root1", "root2", "rogue"]) {
    const identity = await identityFromSeed(SEEDS[n]);
    ids[n] = { identity, key: await publicKeyOf(identity) };
  }
  ids.realm = await keyId(ids.root0.key);
  return ids;
}

const step = (k, pos, from, to, eff = T0 + pos) => createRotation({ realm: k.realm, pos, from: k[from].key, to: k[to].key, effective: eff }, k[from].identity, k[to].identity);

describe("rotation statements", () => {
  it("are signed by the outgoing root and countersigned by the successor, under their own domains", async () => {
    const k = await keys();
    const s = await step(k, 1, "root0", "root1");
    assert.deepEqual(Object.keys(s).sort(), ["countersig", "effective", "from", "pos", "realm", "sig", "to", "v"]);
    assert.equal(DOMAINS.rotation, "browsermesh-realm/rotation/1");
    assert.notEqual(DOMAINS.rotationAccept, DOMAINS.rotation);
    assert.equal((await verifyRotation(s, { realm: k.realm })).ok, true);
  });

  it("builds in two steps: signRotation then countersignRotation", async () => {
    const k = await keys();
    const body = { v: 1, realm: k.realm, pos: 1, from: k.root0.key, to: k.root1.key, effective: T0 };
    const sig = await signRotation(body, k.root0.identity);
    const full = await countersignRotation({ ...body, sig }, k.root1.identity);
    assert.deepEqual(full, await step(k, 1, "root0", "root1", T0));
    await assert.rejects(signRotation(body, k.rogue.identity), { code: "wrong-signer" });
    await assert.rejects(countersignRotation({ ...body, sig }, k.rogue.identity), { code: "wrong-signer" });
  });

  it("is refused without a valid countersignature (the successor must hold the key)", async () => {
    const k = await keys();
    const s = await step(k, 1, "root0", "root1");
    const body = { v: 1, realm: k.realm, pos: 1, from: k.root0.key, to: k.root1.key, effective: T0 };
    const sig = await signRotation(body, k.root0.identity);
    const noCounter = { ...body, sig, countersig: await rawSign(k.rogue.identity, DOMAINS.rotationAccept, { ...body, sig }) };
    assert.equal(reason(await verifyRotation(noCounter, { realm: k.realm })), "bad-countersignature");
    assert.equal(reason(await verifyRotation({ ...s, countersig: s.sig }, { realm: k.realm })), "bad-countersignature");
  });

  it("is refused if the outgoing signature or any field is tampered or the realm differs", async () => {
    const k = await keys();
    const s = await step(k, 1, "root0", "root1");
    assert.equal(reason(await verifyRotation({ ...s, effective: s.effective + 1 }, { realm: k.realm })), "bad-signature");
    assert.equal(reason(await verifyRotation({ ...s, to: k.rogue.key }, { realm: k.realm })), "bad-signature");
    assert.equal(reason(await verifyRotation(s, { realm: await keyId(k.rogue.key) })), "wrong-realm");
    assert.equal(reason(await verifyRotation({ ...s, extra: 1 }, { realm: k.realm })), "malformed");
    assert.equal(reason(await verifyRotation(null, { realm: k.realm })), "malformed");
  });
});

describe("verifyChain", () => {
  it("an empty chain verifies when the key hashes to the id", async () => {
    const k = await keys();
    const v = await verifyChain([], { id: k.realm, key: k.root0.key });
    assert.equal(v.ok, true);
    assert.equal(v.rootKey, k.root0.key);
    assert.equal(reason(await verifyChain([], { id: k.realm, key: k.root1.key })), "bad-id");
  });

  it("walks from the genesis key to the current key", async () => {
    const k = await keys();
    const chain = [await step(k, 1, "root0", "root1"), await step(k, 2, "root1", "root2")];
    const v = await verifyChain(chain, { id: k.realm, key: k.root2.key });
    assert.equal(v.ok, true);
    assert.equal(v.length, 2);
  });

  it("refuses a gap, a repeat, a wrong position, a broken link and a wrong final key", async () => {
    const k = await keys();
    const s1 = await step(k, 1, "root0", "root1");
    const s2 = await step(k, 2, "root1", "root2");
    assert.equal(reason(await verifyChain([s2], { id: k.realm, key: k.root2.key })), "bad-chain");
    assert.equal(reason(await verifyChain([s1, s1], { id: k.realm, key: k.root1.key })), "bad-chain");
    const wrongPos = await step(k, 3, "root1", "root2");
    assert.equal(reason(await verifyChain([s1, wrongPos], { id: k.realm, key: k.root2.key })), "bad-chain");
    const broken = await step(k, 2, "root2", "root1");
    assert.equal(reason(await verifyChain([s1, broken], { id: k.realm, key: k.root1.key })), "bad-chain");
    assert.equal(reason(await verifyChain([s1, s2], { id: k.realm, key: k.root1.key })), "bad-chain");
  });

  it("refuses a chain whose effective times go backwards", async () => {
    const k = await keys();
    const s1 = await step(k, 1, "root0", "root1", T0 + 100);
    const s2 = await step(k, 2, "root1", "root2", T0 + 50);
    assert.equal(reason(await verifyChain([s1, s2], { id: k.realm, key: k.root2.key })), "bad-chain");
  });

  it("caps the chain length (default 8) before verifying signatures", async () => {
    const k = await keys();
    const junk = Array.from({ length: 9 }, () => ({}));
    assert.equal(reason(await verifyChain(junk, { id: k.realm, key: k.root0.key })), "chain-too-long");
    assert.equal(reason(await verifyChain([await step(k, 1, "root0", "root1")], { id: k.realm, key: k.root1.key, maxChain: 0 })), "chain-too-long");
  });

  it("first-seen fork rule: a held position is never replaced by a different statement", async () => {
    const k = await keys();
    const real = await step(k, 1, "root0", "root1");
    const fork = await step(k, 1, "root0", "rogue");
    const held = [real];
    assert.equal((await verifyChain([fork], { id: k.realm, key: k.rogue.key })).ok, true, "a fresh verifier cannot tell (the known limit)");
    assert.equal(reason(await verifyChain([fork], { id: k.realm, key: k.rogue.key, held })), "chain-fork");
    assert.equal((await verifyChain([real], { id: k.realm, key: k.root1.key, held })).ok, true);
    const longer = [real, await step(k, 2, "root1", "root2")];
    assert.equal((await verifyChain(longer, { id: k.realm, key: k.root2.key, held })).ok, true);
  });

  it("refuses a chain shorter than the one held (a regression)", async () => {
    const k = await keys();
    const s1 = await step(k, 1, "root0", "root1");
    const s2 = await step(k, 2, "root1", "root2");
    assert.equal(reason(await verifyChain([s1], { id: k.realm, key: k.root1.key, held: [s1, s2] })), "chain-regressed");
  });

  it("never throws on hostile input", async () => {
    const k = await keys();
    for (const chain of [null, "x", [null], [1], [{}], [[]], {}]) {
      const v = await verifyChain(chain, { id: k.realm, key: k.root0.key });
      assert.equal(v.ok, false);
    }
  });
});

describe("a descriptor carrying a rotation chain", () => {
  async function rotated() {
    const k = await keys();
    const chain = [await step(k, 1, "root0", "root1")];
    const d = await createDescriptor({
      name: "rotated", serial: 2, mode: "invite", root: { key: k.root1.key, chain }, issuers: [],
      roles: ROLES, rendezvous: RENDEZVOUS, ttl: 7 * DAY, genesisKey: k.root0.key,
    });
    return { k, chain, signed: await signDescriptor(d, k.root1.identity) };
  }

  it("keeps the id of the genesis key and is signed by the current root", async () => {
    const { k, signed } = await rotated();
    assert.equal(signed.descriptor.id, k.realm);
    const v = await verifyDescriptor(signed.text, { pinnedId: k.realm, now: T0 });
    assert.equal(v.ok, true);
    assert.equal(v.chainLength, 1);
  });

  it("is refused when signed by the retired key instead of the current one", async () => {
    const { k, signed } = await rotated();
    const { sig, ...body } = signed.descriptor;
    const stale = canonicalJson({ ...body, sig: await rawSign(k.root0.identity, DOMAINS.descriptor, body) });
    assert.equal(reason(await verifyDescriptor(stale, { pinnedId: k.realm, now: T0 })), "bad-signature");
  });

  it("is refused when the chain is cut off (current key does not follow from genesis)", async () => {
    const { k, signed } = await rotated();
    const cut = await createDescriptor({
      name: "rotated", serial: 2, mode: "invite", root: { key: k.root1.key, chain: [] },
      roles: ROLES, rendezvous: RENDEZVOUS, ttl: 7 * DAY, genesisKey: k.root0.key,
    });
    const s = await signDescriptor(cut, k.root1.identity);
    assert.equal(reason(await verifyDescriptor(s.text, { pinnedId: k.realm, now: T0 })), "bad-id");
    assert.ok(signed);
  });

  it("is refused when the chain length is over the cap", async () => {
    const { k, signed } = await rotated();
    assert.equal(reason(await verifyDescriptor(signed.text, { pinnedId: k.realm, now: T0, maxChain: 0 })), "chain-too-long");
  });

  it("canonical text round-trips", async () => {
    const { signed } = await rotated();
    assert.equal(signed.text, canonicalJson(signed.descriptor));
  });
});
