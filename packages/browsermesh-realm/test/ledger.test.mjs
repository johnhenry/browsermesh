import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseCanonical } from "@johnhenry/browsermesh-primitives";
import { createLedger, importLedger } from "../src/index.mjs";
import { T0, DAY } from "./helpers.mjs";

const key = (n) => Buffer.alloc(32, n + 1).toString("base64url"); // a valid 32-byte key, distinct per n

describe("ledger", () => {
  it("allocates serials 1, 2, 3... and records entries", () => {
    const l = createLedger();
    const e1 = l.allocate({ subject: key(0), role: "member", notAfter: T0 + DAY });
    const e2 = l.allocate({ subject: key(1), role: "guest", notAfter: T0 + DAY });
    assert.deepEqual(e1, { serial: 1, subject: key(0), role: "member", notAfter: T0 + DAY, state: "issued" });
    assert.equal(e2.serial, 2);
    assert.equal(l.get(2).subject, key(1));
    assert.equal(l.get(99), null);
    assert.equal(l.size, 2);
    assert.equal(l.nextSerial, 3);
  });

  it("can start at a given serial (disjoint ranges for several issuers)", () => {
    const l = createLedger({ serialStart: 1000 });
    assert.equal(l.allocate({ subject: key(0), role: "member", notAfter: T0 }).serial, 1000);
  });

  it("markRevoked flips state once and is idempotent; unknown serials return false", () => {
    const l = createLedger();
    l.allocate({ subject: key(0), role: "member", notAfter: T0 + DAY });
    assert.equal(l.markRevoked(1), true);
    assert.equal(l.get(1).state, "revoked");
    assert.equal(l.markRevoked(1), true);
    assert.equal(l.markRevoked(7), false);
    assert.equal(l.markRevoked("1"), false);
  });

  it("list returns copies in serial order, optionally filtered; mutating them changes nothing", () => {
    const l = createLedger();
    for (let i = 0; i < 3; i++) l.allocate({ subject: key(i), role: "member", notAfter: T0 + DAY });
    l.markRevoked(2);
    assert.deepEqual(l.list().map((e) => e.serial), [1, 2, 3]);
    assert.deepEqual(l.list({ state: "revoked" }).map((e) => e.serial), [2]);
    const got = l.list();
    assert.throws(() => { got[0].state = "revoked"; }, TypeError);
    assert.equal(l.get(1).state, "issued");
    assert.throws(() => { l.get(1).role = "x"; }, TypeError);
  });

  it("validates what it records", () => {
    const l = createLedger();
    for (const bad of [
      { subject: "nope", role: "member", notAfter: T0 }, { subject: key(0), role: "Bad Role", notAfter: T0 },
      { subject: key(0), role: "member", notAfter: -1 }, { subject: key(0), role: "member", notAfter: 1.5 }, {}, null,
    ]) assert.throws(() => l.allocate(bad), { code: "malformed" });
  });

  it("revokedSerials feeds descriptor.revoked: ascending, only still-relevant ones", () => {
    const l = createLedger();
    l.allocate({ subject: key(0), role: "member", notAfter: T0 + DAY });
    l.allocate({ subject: key(1), role: "member", notAfter: T0 - 10 * DAY });
    l.allocate({ subject: key(2), role: "member", notAfter: T0 + 2 * DAY });
    l.allocate({ subject: key(3), role: "member", notAfter: T0 + 2 * DAY });
    for (const s of [3, 2, 1]) l.markRevoked(s);
    assert.deepEqual(l.revokedSerials({ now: T0 }), [1, 3], "serial 2 expired long ago: the verifier refuses it anyway");
    assert.throws(() => l.revokedSerials({ now: T0, max: 1 }), { code: "too-many-revoked" });
  });

  it("is bounded: refuses to allocate past maxEntries until compact() drops dead entries", () => {
    const l = createLedger({ maxEntries: 2 });
    l.allocate({ subject: key(0), role: "member", notAfter: T0 - 10 * DAY });
    l.allocate({ subject: key(1), role: "member", notAfter: T0 + DAY });
    assert.throws(() => l.allocate({ subject: key(2), role: "member", notAfter: T0 + DAY }), { code: "ledger-full" });
    assert.equal(l.compact({ now: T0 }), 1);
    const e = l.allocate({ subject: key(2), role: "member", notAfter: T0 + DAY });
    assert.equal(e.serial, 3, "serials are never reused");
    assert.equal(l.get(1), null);
  });

  it("exports canonical JSON and imports it back", () => {
    const l = createLedger();
    for (let i = 0; i < 4; i++) l.allocate({ subject: key(i), role: i % 2 ? "guest" : "member", notAfter: T0 + DAY });
    l.markRevoked(3);
    const text = l.export();
    assert.equal(typeof text, "string");
    assert.doesNotThrow(() => parseCanonical(text));
    const back = importLedger(text);
    assert.deepEqual(back.list(), l.list());
    assert.equal(back.nextSerial, 5);
    assert.equal(back.export(), text);
    assert.equal(back.allocate({ subject: key(9), role: "member", notAfter: T0 }).serial, 5);
  });

  it("export and import are size-capped", () => {
    const l = createLedger();
    for (let i = 0; i < 20; i++) l.allocate({ subject: key(i), role: "member", notAfter: T0 + DAY });
    assert.throws(() => l.export({ maxBytes: 200 }), { code: "too-large" });
    const text = l.export();
    assert.throws(() => importLedger(text, { maxBytes: 200 }), { code: "too-large" });
    assert.throws(() => importLedger(text, { maxEntries: 5 }), { code: "ledger-full" });
  });

  it("import refuses corrupt or non-canonical input with a typed error", () => {
    const l = createLedger();
    l.allocate({ subject: key(0), role: "member", notAfter: T0 + DAY });
    l.allocate({ subject: key(1), role: "member", notAfter: T0 + DAY });
    const text = l.export();
    const bad = [
      " " + text, "", "{", "null", "[]", '{"v":2,"next":1,"entries":[]}',
      text.replace('"serial":1', '"serial":2'),            // duplicate serial
      text.replace('"next":3', '"next":2'),                // next not above the highest serial
      text.replace('"state":"issued"', '"state":"gone"'),
      text.replace('"role":"member"', '"role":"Bad Role"'),
    ];
    for (const t of bad) assert.throws(() => importLedger(t), (e) => typeof e.code === "string", t);
    assert.throws(() => importLedger(5), { code: "malformed" });
  });

  it("serial and counters stay in the safe-integer range", () => {
    const l = createLedger({ serialStart: Number.MAX_SAFE_INTEGER });
    l.allocate({ subject: key(0), role: "member", notAfter: T0 });
    assert.throws(() => l.allocate({ subject: key(1), role: "member", notAfter: T0 }), { code: "ledger-full" });
  });
});
