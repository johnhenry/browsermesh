---
"@johnhenry/browsermesh-core": minor
---

A realm seed and per-realm identities, the first prerequisite of realms (`docs/design/realms.md`, 5.10). Additive: no existing method, record format or stored data changes.

- **Seed.** `MeshIdentityManager` (and `IdentityWallet`) can `createSeed()`, `setSeed(bytes)` and hold a random 32-byte seed. The seed is extractable by decision, so one backup recovers every realm identity; any script running in the page can read it while it is loaded.
- **Derivation.** `deriveRealmIdentity(realmId)` derives a non-extractable Ed25519 identity with HKDF-SHA-256 (empty salt, `info = "browsermesh/realm/v1 identity " + realmId`). The same seed and realm id always give the same key; different realm ids give unrelated keys. It registers like any other identity, so it can be passed to `createMeshNode`'s `identity` option. Pinned by a test vector that the browser spec also checks. Existing random identities cannot be derived.
- **Backup.** `exportSeed(passphrase)` / `importSeed(text, passphrase)` use a `@johnhenry/keyvault` record of type `browsermesh-realm-seed` with an authenticated `{ fmt, label, createdAt }` header. Failures are a `RealmSeedError` whose `code` is the keyvault code (`bad_passphrase`, `wrong_type`, `corrupt`, `unsupported`).
- **Fallback.** `createRealmIdentity(realmId, { derive: false })` makes an independent random key for a browser that cannot derive. It is not recoverable from the seed.
- `save()` now skips derived identities (they are non-extractable and come back from the seed); it would otherwise throw on them.
