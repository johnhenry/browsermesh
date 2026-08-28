# browsermesh-core

Identity, crypto, peer management, and trust primitives for BrowserMesh.

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
import { MeshIdentityManager, MeshKeyring, TrustGraph } from 'browsermesh-core';
```

## License

MIT
