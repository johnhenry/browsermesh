import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFrame, FRAME_TYPES, MAX_FRAME_BYTES, MIN_SEAM_FRAME_BYTES, MAX_DESCRIPTOR_BYTES } from "../src/index.mjs";

const ID = "A".repeat(43);

describe("parseFrame", () => {
  it("accepts each documented frame, as an object or as JSON text", () => {
    const good = [
      { t: "realm:hello", id: ID, serial: 3, epoch: 0 },
      { t: "realm:need-descriptor", have: 0 },
      { t: "realm:descriptor", text: "{}" },
      { t: "realm:credential", text: "{}" },
      { t: "realm:credential", text: null },
      { t: "realm:result", ok: true, role: "member", notAfter: 5 },
      { t: "realm:result", ok: false, reason: "expired" },
    ];
    for (const f of good) {
      assert.deepEqual(parseFrame(f), { ok: true, frame: f });
      assert.deepEqual(parseFrame(JSON.stringify(f)), { ok: true, frame: f });
    }
    assert.deepEqual([...FRAME_TYPES].sort(), [...new Set(good.map((f) => f.t))].sort());
  });

  it("refuses everything else without throwing", () => {
    const bad = [
      null, undefined, 5, "x", "[]", "{", [], {}, { t: 1 }, { t: "realm:nope" }, { t: "mesh:ping" },
      { t: "realm:hello", id: ID, serial: -1, epoch: 0 }, { t: "realm:hello", id: ID, serial: 1.5, epoch: 0 },
      { t: "realm:hello", id: ID, serial: 1, epoch: 0, extra: 1 }, { t: "realm:hello", id: 5, serial: 1, epoch: 0 },
      { t: "realm:hello", id: "x".repeat(200), serial: 1, epoch: 0 }, { t: "realm:hello", id: ID, serial: 2 ** 60, epoch: 0 },
      { t: "realm:need-descriptor" }, { t: "realm:need-descriptor", have: "1" },
      { t: "realm:descriptor", text: 5 }, { t: "realm:descriptor", text: "x".repeat(MAX_DESCRIPTOR_BYTES + 1) },
      { t: "realm:credential", text: "x".repeat(5000) }, { t: "realm:credential" }, { t: "realm:credential", text: 5 },
      { t: "realm:result", ok: "yes" }, { t: "realm:result", ok: false, reason: 5 }, { t: "realm:result", ok: false, reason: "r".repeat(100) },
      { t: "realm:result", ok: true, role: "Bad Role" }, { t: "realm:result", ok: true, notAfter: -1 },
      "x".repeat(MAX_FRAME_BYTES + 1),
    ];
    for (const f of bad) {
      const v = parseFrame(f);
      assert.equal(v.ok, false, JSON.stringify(f)?.slice(0, 80));
      assert.equal(v.reason, "bad-frame");
    }
  });

  it("documents the frame size a host's admission seam must allow", () => {
    assert.ok(MIN_SEAM_FRAME_BYTES >= 2 * MAX_DESCRIPTOR_BYTES, "a descriptor's JSON escaping can double it");
    assert.ok(MAX_FRAME_BYTES <= MIN_SEAM_FRAME_BYTES);
  });
});
