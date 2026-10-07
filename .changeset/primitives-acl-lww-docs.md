---
"@johnhenry/browsermesh-primitives": minor
---

ACL and CRDT fixes, plus capability/ACL guidance.

- `ACLEngine.check()` / `AccessGrant.check()` now report `grant_revoked` for a revoked grant instead of `grant_expired`. `grant_expired` is reserved for `conditions.expires` and exhausted `maxUses`. New `AccessGrant#isRevoked()`; `isExpired()` is unchanged. Callers that matched on `reason === 'grant_expired'` to detect revocation must also handle `grant_revoked`.
- `LWWMap` `value`, `toJSON()`, `keys()`, `values()` and `entries()` now yield keys in sorted order, so converged replicas serialize identically.
- New `grantFromToken(token)` maps a `CapabilityToken` onto an `AccessGrant`, and the README explains when to use tokens versus grants and lists the ACL reason strings.
