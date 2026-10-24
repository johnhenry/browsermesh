---
"@johnhenry/browsermesh-core": minor
---

**BREAKING (0.x):** `SignedKeyUnlink` now requires a signed `expires`, and v1 unlinks are no longer accepted (johnhenry/browsermesh#262). Supersedes the "optional" wording of the previous changeset.

- The signed payload domain is now `"browsermesh/keyunlink/v2\n"` and always includes `expires`. `SignedKeyUnlink.create()` throws without `expires`; `SignedKeyUnlink.forLink(parent, link)` copies the link's expiry (pass `{ expires }` for a link that never expires).
- An unlink without `expires`, or signed under the v1 domain, fails `verify()`, is refused by `applyUnlink()`, and is dropped by `MeshKeyring.fromJSON()` (reported in `keyring.droppedRevocations` with a reason) rather than crashing.
- `MeshKeyring` drops expired revocations from `listRevocations({ now })`, `toJSON()` and `fromJSON()`; new `pruneRevocations(now)`; `isRevoked(link, now)` ignores expired ones. A stale link arriving after its unlink lapsed is accepted only while the link itself is unexpired, so give an unlink an `expires` at least as late as its link's.

Migration: re-issue any stored or relayed unlinks with `SignedKeyUnlink.create(..., { expires })` or `forLink()`.
