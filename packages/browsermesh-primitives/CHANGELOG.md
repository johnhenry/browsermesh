# Changelog

## 0.0.0

Imported into the `@johnhenry` npm scope as part of the browsermesh
monorepo consolidation. Previously published unscoped as
`browsermesh-primitives@0.1.1`. Per family convention, the version restarts
at 0.0.0 on scope import — see the README's Provenance section.

## 0.1.1 (unreleased entry, retroactively documented)

- Minimum Node.js bumped to 24.
- Added CodeQL and dependency-review CI workflows.

## 0.1.0 (2026-03-15)

Initial release.

- **Identity**: `PodIdentity` with Ed25519 key generation, signing, and verification; `derivePodId` for deterministic pod IDs; base64url encode/decode utilities
- **Wire format**: `encodeMeshMessage` / `decodeMeshMessage` with extensible message type registry
- **Capabilities**: `CapabilityToken` with scope parsing and matching (`parseScope`, `matchScope`)
- **Trust**: `createTrustEdge`, `computeTransitiveTrust` across configurable trust categories
- **ACL**: `ACLEngine` with resource pattern matching, `Permission` and `AccessGrant` primitives
- **CRDTs**: `VectorClock`, `LWWRegister`, `GCounter`, `PNCounter`, `ORSet`, `RGA`, `LWWMap` -- all with merge, toJSON/fromJSON round-trip
- **Test utilities**: `DeterministicRNG`, `LocalChannel`, `createLocalChannelPair`, `TestMesh`
