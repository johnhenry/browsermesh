---
"@johnhenry/browsermesh-core": minor
---

`SignedKeyUnlink` takes an optional signed `expires` (ms epoch, same convention as `SignedKeyLink`), and `MeshKeyring` drops recorded revocations once they expire (johnhenry/browsermesh#262).

- `SignedKeyUnlink.create(parent, childId, { expires })` and `SignedKeyUnlink.forLink(parent, link)`, which copies the link's expiry and namespace. `unlink.expires` and `unlink.isExpired(now)`.
- `expires` is in the canonical payload only when set, so existing unlinks keep their exact signed bytes and verify unchanged (the `keyunlink/v1` domain is kept). Changing or removing `expires` breaks the signature.
- `listRevocations({ now })`, `toJSON()` and `fromJSON()` omit expired revocations; new `pruneRevocations(now)`; `isRevoked(link, now)` ignores expired ones; `applyUnlink` records nothing for an already-expired unlink. A stale link arriving after its unlink lapsed is accepted only while the link itself is unexpired, so give an unlink an `expires` at least as late as its link's.
