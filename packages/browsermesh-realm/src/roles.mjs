// Roles (docs/design/realms.md 5.3): a role is a named list of scope patterns, an UPPER BOUND that each host narrows.
//
// A scope here is in the `<namespace>:<resource>:<action>` notation of docs/capability-notation.md, written out in
// full. Under `matchScope` a missing or empty segment counts as `*`, so a 2-segment form such as `mcp:tool` is a
// wildcard: roles therefore write `mcp:tool:call`. A role scope with a `*`, fewer than 3 segments or an empty segment
// is rejected.
import { MAX_ROLES, MAX_SCOPES_PER_ROLE, MAX_SCOPE_LENGTH } from "./limits.mjs";
import { isPlainObject } from "./validate.mjs";

export const GUEST_ROLE = "guest";

const ROLE_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
const PRIVILEGED_NAMESPACES = new Set(["egress", "ingress", "pod-host"]);

export const isRoleName = (s) => typeof s === "string" && ROLE_NAME.test(s);

const bad = (reason, detail) => ({ ok: false, reason, detail });

/**
 * @param {unknown} scope
 * @returns {{ ok: true } | { ok: false, reason: "bad-scope", detail: string }}
 */
export function validateScope(scope) {
  if (typeof scope !== "string") return bad("bad-scope", "a scope must be a string");
  if (scope.length === 0 || scope.length > MAX_SCOPE_LENGTH) return bad("bad-scope", "scope is empty or too long");
  const segments = scope.split(":");
  if (segments.length < 3) return bad("bad-scope", `scope ${JSON.stringify(scope)} has fewer than 3 segments (under matchScope that is a wildcard)`);
  for (const seg of segments) {
    if (seg === "") return bad("bad-scope", `scope ${JSON.stringify(scope)} has an empty segment`);
    if (!SEGMENT.test(seg)) return bad("bad-scope", `scope ${JSON.stringify(scope)} has a segment with a wildcard or unusual character`);
  }
  return { ok: true };
}

/**
 * Scopes a host must never grant from a realm unless its own policy lists them: `egress:`, `ingress:`, `pod-host`
 * and anything `wsh-`.
 * @param {string} scope
 */
export function isPrivilegedScope(scope) {
  const segments = String(scope).split(":");
  return PRIVILEGED_NAMESPACES.has(segments[0]) || segments.some((s) => s.startsWith("wsh-"));
}

/**
 * @param {unknown} roles `{ roleName: [scope, ...] }`
 * @returns {{ ok: true } | { ok: false, reason: "bad-role" | "bad-scope", detail: string }}
 */
export function validateRoles(roles) {
  if (!isPlainObject(roles)) return bad("bad-role", "roles must be an object");
  const names = Object.keys(roles);
  if (names.length > MAX_ROLES) return bad("bad-role", `more than ${MAX_ROLES} roles`);
  for (const name of names) {
    if (!isRoleName(name)) return bad("bad-role", `bad role name ${JSON.stringify(name)}`);
    const scopes = roles[name];
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > MAX_SCOPES_PER_ROLE) {
      return bad("bad-role", `role ${name} needs 1 to ${MAX_SCOPES_PER_ROLE} scopes`);
    }
    const seen = new Set();
    for (const scope of scopes) {
      const v = validateScope(scope);
      if (!v.ok) return bad("bad-scope", `role ${name}: ${v.detail}`);
      if (seen.has(scope)) return bad("bad-scope", `role ${name}: duplicate scope ${JSON.stringify(scope)}`);
      seen.add(scope);
    }
  }
  return { ok: true };
}

/**
 * The role a peer with no credential gets: `guest` (or the descriptor's `defaultRole`) in open mode, else null.
 * @param {{ mode?: string, roles?: Record<string, string[]>, defaultRole?: string }} descriptor
 * @returns {string | null}
 */
export function defaultRole(descriptor) {
  if (!descriptor || descriptor.mode !== "open" || !isPlainObject(descriptor.roles)) return null;
  const name = descriptor.defaultRole ?? GUEST_ROLE;
  return Object.hasOwn(descriptor.roles, name) ? name : null;
}
