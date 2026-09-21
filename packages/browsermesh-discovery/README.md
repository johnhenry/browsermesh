# browsermesh-discovery

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-discovery.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-discovery)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-discovery.svg)](LICENSE)

DHT, peer discovery, naming, swarm coordination, and stealth networking for BrowserMesh.

## Why this exists

Identity (`browsermesh-primitives`/`browsermesh-core`) answers "who is this peer," but a mesh also needs to answer "which peers exist, and how do I find one I haven't talked to yet." That's a genuinely different problem -- Kademlia-style routing tables, gossip, service directories, name resolution, swarm membership/leader-election -- and bundling it into `browsermesh-core` would force every identity-only consumer to pull in DHT/swarm machinery it doesn't need. `browsermesh-discovery` exists as that separate layer: `DhtNode`/`RoutingTable`/`GossipProtocol` for peer-to-peer lookup, `DiscoveryManager`/`DiscoveryStrategy` for pluggable discovery mechanisms (including DHT-backed bootstrap), `MeshNameResolver` for human-readable naming, and `SwarmCoordinator`/`SwimMembership` for group membership and coordination. It depends only on `browsermesh-primitives`, for the shared `MESH_TYPE` message-type constants its DHT and swarm messages are tagged with.

## Used by

`@johnhenry/browsermesh-apps` treats this package as an optional peer: `mesh-bootstrap.mjs` lazily `import()`s it to wire a real DHT-backed discovery strategy into `createMeshNode()` (`mesh-dht.mjs`), and `serverless-fetch.mjs`'s `MeshFetchRouter` reuses this package's `parseMeshRequest()` directly to route `mesh://` URLs. Neither is a hard requirement -- `createMeshNode()` works with no discovery strategy at all, or with a caller-supplied one.

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
import { DhtNode, DiscoveryManager, SwarmCoordinator } from '@johnhenry/browsermesh-discovery';
```

## License

MIT
