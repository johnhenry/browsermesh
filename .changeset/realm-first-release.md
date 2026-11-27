---
"@johnhenry/browsermesh-realm": minor
---

First release of `@johnhenry/browsermesh-realm`, a preview. Realms for browsermesh as pure functions over strict canonical JSON and Ed25519: signed realm descriptors with root rotation (countersigned, first-seen fork rule), roles with fully written-out scopes, issuer-signed credentials with clamped lifetimes and a monotonic tracker, the issuer ledger, an authority-less open form, and the realm exchange (frames, descriptor store, verifier and prover, duck-typed over a channel and a registry), with language-neutral test vectors. `browsermesh-apps` (`createMeshNode({ realm })`) and `browsermesh-meshctl` (`realm` commands) use it through optional peer dependencies. Not built yet: tickets and admitters, federation between realms, live peer listing. The API may change before 1.0.
