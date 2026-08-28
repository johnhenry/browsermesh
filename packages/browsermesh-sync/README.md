# browsermesh-sync

CRDT sync engine, delta sync, file transfer, and real-time collaboration for BrowserMesh.

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
import { MeshSyncEngine, MeshFileTransfer, CollabSession } from 'browsermesh-sync';
```

## License

MIT
