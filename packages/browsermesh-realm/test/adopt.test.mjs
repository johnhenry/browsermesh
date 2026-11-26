import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  adoptDescriptor, createDescriptor, signDescriptor, createRotation, publicKeyOf, keyId, createAuthorityless,
} from "../src/index.mjs";
import { buildRealm, identityFromSeed, SEEDS, T0, DAY, ROLES, RENDEZVOUS } from "./helpers.mjs";

const reason = (v) => (v.ok ? "ok" : v.reason);

describe("adoptDescriptor", () => {
  it("adopts a verified descriptor when nothing is held", async () => {
    const r = await buildRealm();
    const a = await adoptDescriptor(null, r.text, { pinnedId: r.id, now: T0 });
    assert.equal(a.ok, true);
    assert.equal(a.descriptor.serial, 1);
    assert.equal(a.text, r.text);
  });

  it("adopts only a strictly higher serial", async () => {
    const held = await buildRealm({ serial: 5 });
    for (const serial of [1, 4, 5]) {
      const offered = await buildRealm({ serial });
      assert.equal(reason(await adoptDescriptor(held.descriptor, offered.text, { pinnedId: held.id, now: T0 })), "stale-serial", `serial ${serial}`);
    }
    const newer = await buildRealm({ serial: 6 });
    assert.equal((await adoptDescriptor(held.descriptor, newer.text, { pinnedId: held.id, now: T0 })).ok, true);
  });

  it("refuses a lower epoch even with a higher serial", async () => {
    const held = await buildRealm({ serial: 2, epoch: 3 });
    const offered = await buildRealm({ serial: 3, epoch: 2 });
    assert.equal(reason(await adoptDescriptor(held.descriptor, offered.text, { pinnedId: held.id, now: T0 })), "epoch-regressed");
  });

  it("refuses a descriptor for another realm and one that does not verify", async () => {
    const r = await buildRealm({ serial: 2 });
    const rogue = await identityFromSeed(SEEDS.rogue);
    const other = await signDescriptor(await createDescriptor({
      name: "other", serial: 9, root: { key: await publicKeyOf(rogue), chain: [] }, roles: ROLES, rendezvous: RENDEZVOUS,
    }), rogue);
    assert.equal(reason(await adoptDescriptor(r.descriptor, other.text, { pinnedId: r.id, now: T0 })), "wrong-realm");
    const tampered = (await buildRealm({ serial: 3 })).text.replace("test realm", "test realmX");
    assert.equal(reason(await adoptDescriptor(r.descriptor, tampered, { pinnedId: r.id, now: T0 })), "bad-signature");
  });

  it("refuses when the held descriptor is not for the pinned id, and an expired offer", async () => {
    const r = await buildRealm();
    const rogue = await identityFromSeed(SEEDS.rogue);
    const other = await signDescriptor(await createDescriptor({
      name: "other", root: { key: await publicKeyOf(rogue), chain: [] }, roles: ROLES, rendezvous: RENDEZVOUS,
    }), rogue);
    assert.equal(reason(await adoptDescriptor(other.descriptor, r.text, { pinnedId: r.id, now: T0 })), "held-mismatch");
    const expiring = await buildRealm({ serial: 2, validUntil: T0 + 5 });
    assert.equal(reason(await adoptDescriptor(r.descriptor, expiring.text, { pinnedId: r.id, now: T0 + 6 })), "expired");
  });

  it("caps descriptor size and chain length (a peer announcing a high serial wastes bounded work)", async () => {
    const held = await buildRealm();
    const big = await buildRealm({ serial: 2 });
    assert.equal(reason(await adoptDescriptor(held.descriptor, big.text, { pinnedId: held.id, now: T0, maxBytes: 200 })), "too-large");
    assert.equal(reason(await adoptDescriptor(held.descriptor, "x".repeat(200000), { pinnedId: held.id, now: T0 })), "too-large");
  });

  it("never throws on hostile input", async () => {
    const held = await buildRealm();
    for (const offered of [null, undefined, 42, {}, [], "", "{", '{"v":1}', Buffer.from("zz")]) {
      const a = await adoptDescriptor(held.descriptor, offered, { pinnedId: held.id, now: T0 });
      assert.equal(a.ok, false);
      assert.equal(typeof a.reason, "string");
    }
    for (const bad of ["x", 5, {}, { id: 1 }, []]) {
      assert.equal((await adoptDescriptor(bad, held.text, { pinnedId: held.id, now: T0 })).ok, false);
    }
    assert.equal((await adoptDescriptor(held.descriptor, held.text, undefined)).ok, false);
  });

  it("refuses the authority-less form (its hints are unsigned and never 'higher')", async () => {
    const r = await buildRealm();
    const a = await createAuthorityless({ name: "c", roles: { guest: ["protocol:mcp:open"] }, salt: "AAAAAAAAAAAAAAAAAAAAAA", hints: { signaling: [], relays: [], ice: [], bootstrap: [] } });
    assert.equal((await adoptDescriptor(null, a.text, { pinnedId: a.descriptor.id, now: T0 })).ok, false);
    assert.ok(r);
  });
});

describe("adoptDescriptor with rotation", () => {
  async function world() {
    const ids = {};
    for (const n of ["root0", "root1", "root2", "rogue"]) {
      const identity = await identityFromSeed(SEEDS[n]);
      ids[n] = { identity, key: await publicKeyOf(identity) };
    }
    const realm = await keyId(ids.root0.key);
    const rot = (pos, from, to) => createRotation({ realm, pos, from: ids[from].key, to: ids[to].key, effective: T0 + pos }, ids[from].identity, ids[to].identity);
    const desc = async (serial, current, chain) => (await signDescriptor(await createDescriptor({
      name: "w", serial, root: { key: ids[current].key, chain }, roles: ROLES, rendezvous: RENDEZVOUS, genesisKey: ids.root0.key,
    }), ids[current].identity));
    return { ids, realm, rot, desc };
  }

  it("adopts a descriptor carrying a longer chain that extends the held one", async () => {
    const w = await world();
    const s1 = await w.rot(1, "root0", "root1");
    const held = await w.desc(2, "root1", [s1]);
    const s2 = await w.rot(2, "root1", "root2");
    const next = await w.desc(3, "root2", [s1, s2]);
    const a = await adoptDescriptor(held.descriptor, next.text, { pinnedId: w.realm, now: T0 });
    assert.equal(a.ok, true);
    assert.equal(a.chainLength, 2);
  });

  it("first-seen fork rule: refuses a competing statement for a position it holds", async () => {
    const w = await world();
    const real = await w.rot(1, "root0", "root1");
    const held = await w.desc(2, "root1", [real]);
    const fork = await w.rot(1, "root0", "rogue");
    const forked = await w.desc(9, "rogue", [fork]);
    assert.equal(reason(await adoptDescriptor(held.descriptor, forked.text, { pinnedId: w.realm, now: T0 })), "chain-fork");
  });

  it("a fresh verifier (holding nothing) cannot tell the fork apart: the documented limit", async () => {
    const w = await world();
    const fork = await w.rot(1, "root0", "rogue");
    const forked = await w.desc(9, "rogue", [fork]);
    assert.equal((await adoptDescriptor(null, forked.text, { pinnedId: w.realm, now: T0 })).ok, true);
  });

  it("refuses a higher serial that drops the rotation it holds (regression to the retired key)", async () => {
    const w = await world();
    const held = await w.desc(2, "root1", [await w.rot(1, "root0", "root1")]);
    const back = await w.desc(3, "root0", []);
    assert.equal(reason(await adoptDescriptor(held.descriptor, back.text, { pinnedId: w.realm, now: T0 })), "chain-regressed");
  });

  it("applies the chain cap", async () => {
    const w = await world();
    const d = await w.desc(2, "root1", [await w.rot(1, "root0", "root1")]);
    assert.equal(reason(await adoptDescriptor(null, d.text, { pinnedId: w.realm, now: T0, maxChain: 0 })), "chain-too-long");
  });
});
