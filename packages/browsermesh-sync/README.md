# browsermesh-sync

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-sync.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-sync)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-sync.svg)](LICENSE)

CRDT sync engine, delta sync, file transfer, and real-time collaboration for BrowserMesh.

## Why this exists

`browsermesh-primitives` ships the raw CRDT types (`VectorClock`, `LWWRegister`, `GCounter`, `PNCounter`, `ORSet`, `RGA`, `LWWMap`) but has no opinion about how a whole *document* made of several of them gets synchronized, chunked into transferable deltas, or reconciled after a schema change. `browsermesh-sync` is that layer: `SyncDocument`/`MeshSyncEngine` compose primitives' CRDT classes into a synchronizable document, `DeltaLog`/`DeltaEncoder`/`SyncCoordinator` turn ongoing changes into transportable deltas instead of resending full state, `MeshFileTransfer`/`ChunkStore` extend the same content-addressed approach to binary files, and `CollabSession`/`YjsAdapter` bridge to real-time collaborative editing. It depends on `browsermesh-primitives` directly -- `SyncDocument`'s field types *are* primitives' CRDT classes, not a reimplementation of them.

## Used by

`@johnhenry/browsermesh-apps` requires this package as a non-optional peer (unlike `browsermesh-core`/`browsermesh-transport`/`browsermesh-discovery`, which are optional there) -- it's load-bearing, not an add-on. `MeshSyncEngine`/`InMemorySyncStorage` back `mesh-sync.mjs` and `mesh-kv.mjs`'s replicated key-value store; `ChunkStore` backs `mesh-torrent.mjs` and `peer-ipfs.mjs`'s content-addressed chunk storage; and `IndexedDBChunkStore`/`IndexedDBSyncStorage` (this package's durable, browser-persisted storage adapters) back `cloud-storage-backend.mjs` and `manifest-sync.mjs`, the storage layer underneath `browsermesh-apps`'s `CloudStorage` SDK.

## Provenance

Extracted from the private `clawser` monorepo (previously `packages/browsermesh-sync`), where it was manually published to npm, unscoped, as `browsermesh-sync@0.1.0` (2026-07-17) with no CI ever automating that publish. This is its first release as part of the `@johnhenry/browsermesh` monorepo; the version restarts at `0.0.0` per family convention.


## Modules

| Module | Key Exports |
|--------|-------------|
| sync | `SyncDocument`, `MeshSyncEngine`, `InMemorySyncStorage` |
| delta-sync | `SyncCoordinator`, `DeltaLog`, `DeltaEncoder`, `DeltaDecoder`, `DeltaBranch` |
| migration | `MigrationEngine`, `MigrationPlan`, `DualActiveWindow` |
| files | `MeshFileTransfer`, `ChunkStore`, `FileDescriptor`, `TransferOffer` |
| collab | `CollabSession`, `YjsAdapter`, `AwarenessState` |
| collab-bridge | `CollabBridge`, `CollabManager` |
| memory-sync | `AgentMemorySync`, `MemoryEntry`, `ConflictEntry` |

## Install

```bash
npm install @johnhenry/browsermesh-sync @johnhenry/browsermesh-primitives
```

## Usage

```js
import { MeshSyncEngine, MeshFileTransfer, CollabSession } from '@johnhenry/browsermesh-sync';
```

## License

MIT
