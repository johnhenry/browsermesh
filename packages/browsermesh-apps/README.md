# browsermesh-apps

Application layer for BrowserMesh: marketplace, chat, payments, compute orchestration, and agent tools.

## Provenance

Extracted from the private `clawser` monorepo (previously `packages/browsermesh-apps`), where it was manually published to npm, unscoped, as `browsermesh-apps@0.1.0` (2026-07-17) with no CI ever automating that publish. This is its first release as part of the `@johnhenry/browsermesh` monorepo; the version restarts at `0.0.0` per family convention.


## Modules

| Module | Key Exports |
|--------|-------------|
| apps | `AppRegistry`, `AppStore`, `AppRPC`, `AppEventBus` |
| marketplace | `Marketplace`, `MarketplaceIndex`, `ServiceListing` |
| chat | `MeshChat`, `ChatRoom`, `ChatMessage` |
| payments | `PaymentChannel`, `EscrowManager`, `CreditLedger`, `PaymentRouter` |
| quotas | `QuotaManager`, `QuotaEnforcer` |
| resources | `ResourceRegistry`, `ComputeRequest`, `ResourceScorer`, `JobQueue` |
| gpu | `TrainingOrchestrator`, `GpuProbe`, `GradientAggregator` |
| scheduler | `MeshScheduler`, `TaskQueue` |
| consensus | `ConsensusManager`, `Proposal`, `Ballot` |
| orchestrator | `MeshOrchestrator` + meshctl BrowserTool subclasses |
| audit | `AuditChain`, `AuditStore`, `detectFork`, `buildMerkleRoot` |
| visualizations | `TopologyLayout`, `TrustGraphLayout`, `TrustHeatmap` |
| devtools | `MeshInspector`, `MeshInspectTool` |
| tools | `registerMeshTools` + stream/file/DHT/GPU/IoT BrowserTool subclasses |
| peer-agent | `AgentHost`, `AgentClient`, `bridgePeerAgent` |
| peer-agent-swarm | `AgentSwarmCoordinator` |
| peer-chat | `PeerChat` |
| peer-compute | `FederatedCompute`, `FederatedJob` |
| peer-encrypted-store | `EncryptedBlobStore` |
| peer-escrow | `EscrowContract`, `EscrowManager` |
| peer-files | `FileHost`, `FileClient` |
| peer-health | `HealthMonitor`, `AutoMigrator` |
| peer-ipfs | `IPFSStore` |
| peer-node | `PeerNode` |
| peer-payments | `CreditLedger`, `WebLNProvider` |
| peer-registry | `PeerRegistry` |
| peer-routing | `MeshRouter`, `ServerSharing` |
| peer-services | `ServiceAdvertiser`, `ServiceBrowser` |
| peer-session | `PeerSession`, `SessionManager` |
| peer-terminal | `TerminalHost`, `TerminalClient` |
| peer-timestamp | `TimestampAuthority`, `TimestampProof` |
| peer-torrent | `TorrentManager` |
| peer-verification | `VerificationQuorum`, `Attestation` |
| marketplace-ui | `SkillMarketplace` |

## Install

```bash
npm install @johnhenry/browsermesh-apps @johnhenry/browsermesh-primitives @johnhenry/browsermesh-core @johnhenry/browsermesh-transport @johnhenry/browsermesh-sync @johnhenry/browsermesh-discovery
```

## Usage

```js
import { MeshChat, AppRegistry, MeshOrchestrator } from 'browsermesh-apps';
```

## Connecting a real mesh node: `createMeshNode()`

`mesh-bootstrap.mjs`'s `createMeshNode(options)` is the composition root that
wires a real Ed25519 identity, discovery, and a real WebRTC transport
negotiator into a booted `PeerNode`. A minimal call needs only an injectable
signaling transport (see `signaling.mjs`) to relay WebRTC offer/answer/ICE
messages between peers:

```js
import { createMeshNode } from '@johnhenry/browsermesh-apps';

const node = await createMeshNode({
  signalingTransport, // a {send(msg), onMessage(cb)} bus -- see signaling.mjs
});
```

### TURN server configuration

By default, `createMeshNode()` gathers **no ICE servers at all** (no STUN,
no TURN) -- host candidates only, which is enough for peers on the same LAN
and discloses nothing to a third party. That's fine for typical NAT, but
peers behind symmetric or restrictive NATs need a STUN and/or TURN server to
connect at all.

Pass standard `RTCIceServer`-shaped entries via `options.iceServers`:

```js
import { createMeshNode } from '@johnhenry/browsermesh-apps';
import { PUBLIC_STUN_SERVERS } from '@johnhenry/browsermesh-transport';

const node = await createMeshNode({
  signalingTransport,
  iceServers: [
    ...PUBLIC_STUN_SERVERS, // opt-in public STUN (see browsermesh-transport's webrtc.mjs)
    { urls: 'turn:turn.example.com:3478', username: 'alice', credential: 's3cr3t' },
  ],
});
```

`iceServers` is merged with `DEFAULT_ICE_SERVERS` via
`@johnhenry/browsermesh-transport`'s `mergeIceServers()` -- the same
extension point `webrtc.mjs` already exposes, reused here rather than
reimplemented:

- Omit the option, or pass `undefined`/`null`, to keep the default (no ICE
  servers).
- Pass a non-empty array (TURN and/or STUN entries) to **add** them
  alongside the defaults; malformed entries (missing `urls`) are silently
  dropped rather than passed through to `RTCPeerConnection`.
- Pass an explicit `iceServers: []` to mean "no ICE servers at all" --
  honoured as given, never replaced by the defaults. This is what this
  package's own `test/real-peer/mesh-bootstrap.test.mjs` uses for a
  hermetic, loopback-only connection in CI.

This reaches the `WebRTCMeshManager` that `createMeshNode()` attaches to the
returned node as `node.meshManager`, and from there every
`WebRTCPeerConnection` it creates.

## License

MIT
