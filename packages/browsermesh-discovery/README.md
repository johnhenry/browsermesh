# browsermesh-discovery

DHT, peer discovery, naming, swarm coordination, and stealth networking for BrowserMesh.

## Provenance

Extracted from the private `clawser` monorepo (previously `packages/browsermesh-discovery`), where it was manually published to npm, unscoped, as `browsermesh-discovery@0.1.0` (2026-07-17) with no CI ever automating that publish. This is its first release as part of the `@johnhenry/browsermesh` monorepo; the version restarts at `0.0.0` per family convention.


## Modules

| Module | Key Exports |
|--------|-------------|
| dht | `DhtNode`, `RoutingTable`, `KBucket`, `GossipProtocol` |
| discovery | `DiscoveryManager`, `DiscoveryStrategy`, `ServiceDirectory`, `BroadcastChannelStrategy` |
| naming | `MeshNameResolver`, `NameRecord`, `parseMeshUri` |
| swarm | `SwarmCoordinator`, `LeaderElection`, `TaskDistributor`, `SwimMembership` |
| sw-routing | `MeshFetchRouter`, `parseMeshRequest` |
| stealth | `StealthAgent`, `ShardDistributor`, `ShardCollector` |

## Install

```bash
npm install @johnhenry/browsermesh-discovery @johnhenry/browsermesh-primitives
```

## Usage

```js
import { DhtNode, DiscoveryManager, SwarmCoordinator } from 'browsermesh-discovery';
```

## License

MIT
