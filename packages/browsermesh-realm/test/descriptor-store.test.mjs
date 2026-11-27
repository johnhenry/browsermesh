import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDescriptorStore } from "../src/index.mjs";
import { buildRealm, T0 } from "./helpers.mjs";

const reason = (v) => (v.ok ? "ok" : v.reason);
const forgedOf = async (serial = 9) => (await buildRealm({ serial })).text.replace("test realm", "xx");

describe("createDescriptorStore", () => {
  it("holds a verified baked descriptor, and nothing when the baked one does not verify", async () => {
    const r = await buildRealm();
    const s = createDescriptorStore({ pinnedId: r.id, held: r.text, now: T0 });
    assert.equal((await s.ready).ok, true);
    assert.equal(s.current().serial, 1);
    assert.equal(s.export(), r.text);
    const bad = createDescriptorStore({ pinnedId: r.id, held: r.text.replace("test realm", "evil realm"), now: T0 });
    assert.equal((await bad.ready).ok, false);
    assert.equal(bad.current(), null);
    assert.equal(bad.export(), null);
    const none = createDescriptorStore({ pinnedId: r.id, now: T0 });
    assert.equal((await none.ready).ok, true);
    assert.equal(none.current(), null);
  });

  it("adopts a verified higher serial, calls onAdopt with (new, previous), and exports it for the host to persist", async () => {
    const r1 = await buildRealm();
    const r2 = await buildRealm({ serial: 2, epoch: 1 });
    const seen = [];
    const s = createDescriptorStore({ pinnedId: r1.id, held: r1.text, now: T0, onAdopt: (d, prev) => seen.push([d.serial, prev?.serial]) });
    await s.ready;
    const v = await s.offer(r2.text, { linkId: "a" });
    assert.equal(v.ok, true);
    assert.equal(s.current().serial, 2);
    assert.deepEqual(seen, [[2, 1]]);
    const again = createDescriptorStore({ pinnedId: r1.id, held: s.export(), now: T0 });
    await again.ready;
    assert.equal(again.current().serial, 2, "export round-trips through `held`");
  });

  it("onAdopt can also be added later and removed", async () => {
    const r1 = await buildRealm();
    const s = createDescriptorStore({ pinnedId: r1.id, held: r1.text, now: T0 });
    await s.ready;
    const seen = [];
    const off = s.onAdopt((d) => seen.push(d.serial));
    await s.offer((await buildRealm({ serial: 2 })).text, { linkId: "a" });
    off();
    await s.offer((await buildRealm({ serial: 3 })).text, { linkId: "b" });
    assert.deepEqual(seen, [2]);
  });

  it("never verifies a serial that is not higher (a stale offer costs a JSON read, not an Ed25519 check)", async () => {
    const r = await buildRealm({ serial: 5 });
    const s = createDescriptorStore({ pinnedId: r.id, held: r.text, now: T0 });
    await s.ready;
    const before = s.stats().verifies;
    for (const serial of [1, 4, 5]) assert.equal(reason(await s.offer((await buildRealm({ serial })).text, { linkId: `l${serial}` })), "stale-serial");
    assert.equal(s.stats().verifies, before);
    assert.equal(reason(await s.offer("not json", { linkId: "x" })), "malformed");
    assert.equal(s.stats().verifies, before);
  });

  it("refuses forged, oversized and epoch-regressed offers and keeps what it holds", async () => {
    const r = await buildRealm({ serial: 2, epoch: 3 });
    const s = createDescriptorStore({ pinnedId: r.id, held: r.text, now: T0 });
    await s.ready;
    assert.equal(reason(await s.offer(await forgedOf(), { linkId: "a" })), "bad-signature");
    assert.equal(reason(await s.offer((await buildRealm({ serial: 9, epoch: 1 })).text, { linkId: "b" })), "epoch-regressed");
    assert.equal(reason(await s.offer("x".repeat(100000), { linkId: "c" })), "too-large");
    assert.equal(s.current().serial, 2);
  });

  it("rate-limits per link, and bounds total verification work across links", async () => {
    const r = await buildRealm();
    const s = createDescriptorStore({
      pinnedId: r.id, held: r.text, now: T0, limits: { maxVerifiesPerLink: 2, maxOffersPerLink: 4, maxVerifiesPerWindow: 5, windowSeconds: 60 },
    });
    await s.ready;
    const forged = await forgedOf();
    assert.equal(reason(await s.offer(forged, { linkId: "spam" })), "bad-signature");
    assert.equal(reason(await s.offer(forged, { linkId: "spam" })), "bad-signature");
    assert.equal(reason(await s.offer(forged, { linkId: "spam" })), "rate-limited");
    assert.equal(s.stats().verifies, 2);
    for (const id of ["b", "c", "d"]) assert.equal(reason(await s.offer(forged, { linkId: id })), "bad-signature");
    assert.equal(reason(await s.offer(forged, { linkId: "e" })), "rate-limited");
    assert.equal(s.stats().verifies, 5);
  });

  it("the global window slides with the clock", async () => {
    const r = await buildRealm();
    let now = T0;
    const s = createDescriptorStore({ pinnedId: r.id, held: r.text, now: () => now, limits: { maxVerifiesPerWindow: 1, windowSeconds: 60 } });
    await s.ready;
    const forged = await forgedOf();
    assert.equal(reason(await s.offer(forged, { linkId: "a" })), "bad-signature");
    assert.equal(reason(await s.offer(forged, { linkId: "b" })), "rate-limited");
    now += 61;
    assert.equal(reason(await s.offer(forged, { linkId: "c" })), "bad-signature");
  });

  it("serialises concurrent offers so the higher one wins and onAdopt fires in order", async () => {
    const r1 = await buildRealm();
    const order = [];
    const s = createDescriptorStore({ pinnedId: r1.id, held: r1.text, now: T0, onAdopt: (d) => order.push(d.serial) });
    await s.ready;
    const [a, b] = await Promise.all([
      s.offer((await buildRealm({ serial: 2 })).text, { linkId: "a" }),
      s.offer((await buildRealm({ serial: 3 })).text, { linkId: "b" }),
    ]);
    assert.equal(a.ok && b.ok, true);
    assert.deepEqual(order, [2, 3]);
    assert.equal(s.current().serial, 3);
  });

  it("forget(linkId) frees a link's counters; the table is bounded", async () => {
    const r = await buildRealm();
    const s = createDescriptorStore({ pinnedId: r.id, held: r.text, now: T0, limits: { maxLinks: 3, maxVerifiesPerLink: 1 } });
    await s.ready;
    const forged = await forgedOf();
    await s.offer(forged, { linkId: "a" });
    assert.equal(reason(await s.offer(forged, { linkId: "a" })), "rate-limited");
    s.forget("a");
    assert.equal(reason(await s.offer(forged, { linkId: "a" })), "bad-signature");
    for (const id of "bcdef") await s.offer(forged, { linkId: id });
    assert.ok(s.stats().links <= 3);
  });

  it("accepts a first descriptor when it holds none", async () => {
    const r = await buildRealm();
    const s = createDescriptorStore({ pinnedId: r.id, now: T0 });
    await s.ready;
    assert.equal((await s.offer(r.text, { linkId: "a" })).ok, true);
    assert.equal(s.current().id, r.id);
  });
});
