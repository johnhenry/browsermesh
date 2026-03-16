# Changelog

## 0.1.0 (2026-03-15)

Initial release.

- **Identity**: `PodIdentity` with Ed25519 key generation, signing, and verification; `derivePodId` for deterministic pod IDs; base64url encode/decode utilities
- **Wire format**: `encodeMeshMessage` / `decodeMeshMessage` with extensible message type registry
- **Capabilities**: `CapabilityToken` with scope parsing and matching (`parseScope`, `matchScope`)
- **Trust**: `createTrustEdge`, `computeTransitiveTrust` across configurable trust categories
- **ACL**: `ACLEngine` with resource pattern matching, `Permission` and `AccessGrant` primitives
- **CRDTs**: `VectorClock`, `LWWRegister`, `GCounter`, `PNCounter`, `ORSet`, `RGA`, `LWWMap` -- all with merge, toJSON/fromJSON round-trip
- **Test utilities**: `DeterministicRNG`, `LocalChannel`, `createLocalChannelPair`, `TestMesh`
