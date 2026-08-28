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

## License

MIT
