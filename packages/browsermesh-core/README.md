# browsermesh-core

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-core.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-core)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-core.svg)](LICENSE)

Identity, crypto, peer management, and trust primitives for BrowserMesh.

## Why this exists

`browsermesh-primitives` gives you an Ed25519 keypair and a bare capability token; it has no opinion about *peers* -- who you've seen, how much you trust them, or what they're currently allowed to do. `browsermesh-core` is the layer that turns raw identity primitives into a working peer model: `MeshIdentityManager`/`IdentityWallet` manage which identity is active, `MeshPeerManager`/`PeerState` track who's been seen and when, `TrustGraph` accumulates trust edges into a transitive score, and `MeshACL`/`CapabilityChain`/`CapabilityValidator` turn a raw `CapabilityToken` into an actual access decision. It sits directly on `browsermesh-primitives` and nothing else -- every downstream package that needs to answer "is this peer who they say they are, and are they allowed to do this" builds on `browsermesh-core` rather than reimplementing peer/trust bookkeeping itself.

## Cross-package relationship

- **Depends on** `@johnhenry/browsermesh-primitives` (required) -- `identity.mjs`, `acl.mjs`, `keyring.mjs`, and `trust.mjs` all import their base types (`PodIdentity`, capability/wire-format primitives) from there.
- **Used by** `@johnhenry/browsermesh-apps` (optional peer) -- `peer-registry.mjs` types its registry against `MeshPeerManager`/`TrustGraph`/`MeshACL`, and several modules (`mesh-hardening.mjs`, `mesh-keepalive.mjs`, `key-distribution.mjs`) lazily `import()` this package at runtime for `RetryWithBackoff`, `TransportFailover`, `TransportHealthCheck`, `MetricsRegistry`, and the `wrapKeyForMember`/`unwrapKeyForMember` key-wrapping helpers used by CloudStorage's key-distribution service.
- **Optionally reaches back into** `@johnhenry/browsermesh-apps` itself -- `peer-tools.mjs` lazily `import()`s `ScheduledTask` from `browsermesh-apps` when a peer tool needs to schedule follow-up work. This is a genuine (narrow, optional-on-both-sides) circular relationship: neither package requires the other to load, but each reaches into the other for one specific, lazily-imported piece.

## Provenance

Extracted from the private `clawser` monorepo (previously `packages/browsermesh-core`), where it was manually published to npm, unscoped, as `browsermesh-core@0.1.0` (2026-07-17) with no CI ever automating that publish. This is its first release as part of the `@johnhenry/browsermesh` monorepo; the version restarts at `0.0.0` per family convention.


## Modules

| Module | Key Exports |
|--------|-------------|
| identity | `MeshIdentityManager`, `AutoIdentityManager`, `IdentitySelector`, `PodIdentity`, `derivePodId` |
| identity-tools | `IdentityCreateTool`, `IdentityListTool`, `IdentitySwitchTool`, `registerIdentityTools` |
| keyring | `MeshKeyring`, `KeyLink`, `SignedKeyLink`, `SuccessionPolicy` |
| group-keys | `GroupKeyManager`, `GroupState` |
| peer | `PeerState`, `MeshPeerManager` |
| peer-tools | `MeshPeerToolsContext`, `registerMeshPeerTools` + 30 BrowserTool subclasses |
| handshake | `HandshakeCoordinator`, `SignalingClient`, `DirectInputHandshake` |
| acl | `MeshACL`, `ScopeTemplate`, `RosterEntry`, `InvitationToken` |
| capabilities | `CapabilityToken`, `CapabilityChain`, `CapabilityValidator`, `WasmSandbox` |
| trust | `TrustGraph` |
| hardening | `RetryWithBackoff`, `TransportHealthCheck`, `ConnectionPool`, `TransportFailover` |
| identity-base | `IdentityManager`, `compileSystemPrompt`, `detectIdentityFormat` |
| identity-wallet | `IdentityWallet` |

## Install

```bash
npm install @johnhenry/browsermesh-core @johnhenry/browsermesh-primitives
```

## Usage

```js
import { MeshIdentityManager, MeshKeyring, TrustGraph } from '@johnhenry/browsermesh-core';
```

## License

MIT
