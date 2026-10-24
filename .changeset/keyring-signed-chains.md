---
"@johnhenry/browsermesh-core": minor
---

Harden `MeshKeyring` and capability chains for use across peers (johnhenry/p2pws#302). **Breaking** for unsigned chains, v1/v2-signed links and the keyring's serialised shape.

- `verifyCryptoChain()` refuses unsigned `KeyLink`s on the path (`reason: 'unsigned'`). Pass `{ requireSigned: false }` for a purely local graph. Failures now also report `reason` (`no-path`, `expired`, `revoked`, `namespace`, `unsigned`, `bad-signature`).
- `SignedKeyLink` signs `"browsermesh/keylink/v3\n"` + sorted-key canonical JSON of every field, including a new optional `namespace`. `MeshKeyring` takes a `namespace` option and only accepts links and unlinks for it, so a link cannot be replayed into another keyring. The v1 `a|b|c|d` fallback and `legacySignedPayload` are removed.
- New `SignedKeyUnlink`: a revocation the parent signs, which serialises and can be relayed. `MeshKeyring#applyUnlink()` verifies and records it, removes the edge, and returns the child's descendants, which lose authority derived through it. A revoked link is refused by `addVerifiedLink()` and `verifyCryptoChain()` even if it arrives after the unlink. `unlink()` remains local only.
- `executeSuccession()` is now async. A `transfer` needs `{ links, getPublicKey }`: successor-signed `SignedKeyLink`s, one per child, with the same relation and no wider scope or expiry. They are all verified before anything changes. `{ localOnly: true }` keeps the old unsigned re-linking, which `verifyCryptoChain()` refuses.
- `CapabilityToken`s can be signed by their issuer (`CapabilityToken.issue()`, `token.sign()`, `token.attenuateSigned()`) over `"browsermesh/capability/v1\n"` + canonical JSON, which binds `parentId` and `depth`. `CapabilityChain#verifySignatures(getPublicKey, { rootIssuer })` also requires each delegation to be issued by its parent's holder. Unsigned tokens work as before and keep their JSON shape.
- `MeshKeyring#toJSON()` returns `{ v: 3, namespace, links, revocations }` instead of a bare array. `fromJSON()` still reads the array. An older reader given the new shape fails to load it; it does not misread it.

Migration: links signed by 0.5–0.9 (v2 payload) stop verifying. While migrating, open the keyring with `{ acceptLegacyV2: true }` (verification only, namespace-less links only). Find old links with `link.signatureVersion(parentPub, childPub) === 2` and re-sign them with `link.resign(parentIdentity, childIdentity, { namespace })`. Re-create v1-signed links.
