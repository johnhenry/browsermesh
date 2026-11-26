import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateScope, validateRoles, defaultRole, GUEST_ROLE } from "../src/index.mjs";

describe("validateScope", () => {
  for (const ok of ["protocol:mcp:open", "mcp:search:call", "objects:window:get", "egress:tcp:host.example:443:connect"]) {
    it(`accepts ${ok}`, () => assert.equal(validateScope(ok).ok, true));
  }
  const bad = {
    "*": "wildcard",
    "mcp:*:call": "wildcard segment",
    "*:tool:call": "wildcard namespace",
    "mcp:tool:*": "wildcard action",
    "mcp:tool": "fewer than 3 segments (a wildcard under matchScope)",
    "mcp": "one segment",
    "": "empty",
    "mcp::call": "empty middle segment",
    "mcp:tool:": "trailing empty segment",
    ":tool:call": "leading empty segment",
    "mcp:to ol:call": "whitespace",
    "mcp:tool*:call": "partial wildcard",
  };
  for (const [scope, why] of Object.entries(bad)) {
    it(`rejects ${JSON.stringify(scope)} (${why})`, () => {
      const v = validateScope(scope);
      assert.equal(v.ok, false);
      assert.equal(v.reason, "bad-scope");
    });
  }
  it("rejects non-strings", () => {
    for (const v of [null, undefined, 3, {}, []]) assert.equal(validateScope(v).ok, false);
  });
});

describe("validateRoles", () => {
  it("accepts a normal set", () => {
    assert.equal(validateRoles({ guest: ["protocol:mcp:open"], member: ["mcp:search:call"] }).ok, true);
  });
  it("rejects a role whose scope is a wildcard, naming the role", () => {
    const v = validateRoles({ member: ["mcp:*:call"] });
    assert.equal(v.ok, false);
    assert.equal(v.reason, "bad-scope");
    assert.match(v.detail, /member/);
  });
  it("rejects bad role names, duplicates, empty scope lists and too many roles", () => {
    assert.equal(validateRoles({ "Bad Name": ["a:b:c"] }).reason, "bad-role");
    assert.equal(validateRoles({ member: ["a:b:c", "a:b:c"] }).reason, "bad-scope");
    assert.equal(validateRoles({ member: [] }).reason, "bad-role");
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`r${i}`, ["a:b:c"]]));
    assert.equal(validateRoles(many).reason, "bad-role");
  });
  it("rejects non-objects and non-array scope lists", () => {
    assert.equal(validateRoles(null).ok, false);
    assert.equal(validateRoles([]).ok, false);
    assert.equal(validateRoles({ member: "mcp:a:b" }).ok, false);
  });
});

describe("defaultRole", () => {
  it("is guest in open mode when guest is defined, otherwise null", () => {
    assert.equal(GUEST_ROLE, "guest");
    assert.equal(defaultRole({ mode: "open", roles: { guest: ["a:b:c"] } }), "guest");
    assert.equal(defaultRole({ mode: "invite", roles: { guest: ["a:b:c"] } }), null);
    assert.equal(defaultRole({ mode: "open", roles: { member: ["a:b:c"] } }), null);
    assert.equal(defaultRole({ mode: "open", defaultRole: "member", roles: { member: ["a:b:c"] } }), "member");
  });
});
