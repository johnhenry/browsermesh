// A stand-in for the registry's two methods WshServices uses, with the registry's scope rules for these tests:
// a grant is `resource:action`, a segment may be `*`, and nothing is allowed that was not granted (default deny).
// Revoking announces the change as PeerRegistry does (`onAccessChange({ pubKey, kind })`).
export function fakeRegistry() {
  const grants = new Map(); // pod id -> Set of scopes
  const listeners = new Set();
  const matches = (scope, wanted) => {
    const a = scope.split(':');
    const b = wanted.split(':');
    return a.length === b.length && a.every((seg, i) => seg === '*' || seg === b[i]);
  };
  const announce = (pubKey, kind) => { for (const cb of [...listeners]) cb({ pubKey, kind }); };
  return {
    checks: [],
    checkAccess(pubKey, resource, action) {
      this.checks.push([pubKey, resource, action]);
      const wanted = `${resource}:${action}`;
      for (const scope of grants.get(pubKey) ?? []) if (matches(scope, wanted)) return { allowed: true };
      return { allowed: false, reason: 'scope_denied' };
    },
    onAccessChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    grant(pubKey, scopes) {
      const set = grants.get(pubKey) ?? new Set();
      for (const s of scopes) set.add(s);
      grants.set(pubKey, set);
    },
    revoke(pubKey, scopes) {
      for (const s of scopes) grants.get(pubKey)?.delete(s);
      announce(pubKey, 'revoked');
    },
  };
}
