# Changelog

## 0.1.0

### Minor Changes

- `MeshSyncEngine` only shipped `InMemorySyncStorage`, so CRDT/workspace state was lost on reload unless a caller wrote their own durable adapter.

  Add `IndexedDBSyncStorage`, a drop-in save/load/clear adapter modeled on `browsermesh-core`'s `IndexedDBIdentityStorage` pattern, self-contained within `browsermesh-sync` (no new cross-package dependency). Configurable `dbName`/`storeName` let multiple sync engines share a page without colliding. Exported from `src/index.mjs` alongside `InMemorySyncStorage`.

## 0.0.1

### Patch Changes

- Peer dependency ranges were all ">=0.0.0", which accepts any version including a future incompatible major. They are now bounded at both ends: at least the version actually required, and below 1.0.0.

  browsermesh-apps declared core, transport and discovery as required peers but never imports any of them at runtime; every reference is a JSDoc type import, and the objects themselves are injected by the caller (discovery and transportNegotiator are optional and guarded at every use; wallet is required but supplied by the consumer, who therefore already has core). Since npm 7 installs peer dependencies automatically, that made installing apps pull in three packages it only needs for types. They are marked optional in peerDependenciesMeta.

## 0.0.0

Extracted from the private `clawser` monorepo and imported into the `@johnhenry` npm scope as part of the browsermesh monorepo consolidation. Previously published unscoped as `browsermesh-sync@0.1.0` (2026-07-17, manual publish, never CI-automated). Per family convention, the version restarts at 0.0.0 on scope import.
