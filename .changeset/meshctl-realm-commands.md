---
"@johnhenry/browsermesh-meshctl": minor
---

`meshctl realm ...`: the operator and member commands for realms (`docs/design/realms.md`, section 8). Additive: no existing command or flag changes.

- **Commands.** `realm create`, `issue`, `revoke`, `rotate`, `ledger`, `join`, `ls`, `inspect`, `export`, and `invite`, which exists only to answer `EREALM_NOT_IMPLEMENTED` (exit 2, pointing at key-bound `realm issue`: there is no keyless credential in v1). One JSON document per command, with the existing exit-code table plus stable `EREALM_*` codes. They work on local files only, in a store set by `--realm-dir` (default `~/.config/browsermesh/realms/`, `0700` directories and `0600` files).
- **Key custody.** The root and issuer keys are sealed with `@johnhenry/keyvault` (`browsermesh-realm-root`), unsealed only for the signing call and imported non-extractable. The passphrase comes only from `--passphrase-env <VAR>` or a `--passphrase-file` that must be mode `0600`; never from argv. `export` never returns a key. `issue` signs with the issuer key only, so the root can stay off the issuing machine. One ledger per realm keeps serials from colliding.
- **Members.** `join` verifies a descriptor against the pinned realm id and makes an independent per-realm identity (random, in the realm's profile directory). Seed-derived per-realm identities are a follow-up. `inspect` shows the stored descriptor and local profile and says it cannot list live peers; there is no `realm leave` (delete the profile).
- **Dependencies.** `@johnhenry/browsermesh-realm` is an optional peer, loaded on first use: without it the realm commands exit 2 and say what to install, and every other command is unchanged. `@johnhenry/keyvault` becomes a dependency.
