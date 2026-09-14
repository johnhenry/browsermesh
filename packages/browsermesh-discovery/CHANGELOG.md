# Changelog

## 0.0.4

### Patch Changes

- Documentation only: corrected `sw-routing.mjs`'s stale `STATUS: INTEGRATED — wired into ClawserPod lifecycle` header comment now that `parseMeshRequest()`/`MeshFetchRouter` has a real caller — `@johnhenry/browsermesh-apps`'s `browserMeshFetch()` reuses `parseMeshRequest()` directly. No code/behavior change in this package.

## 0.0.3

### Patch Changes

- `RelayStrategy#connect()`'s 10s WebSocket-connection-timeout guard was never captured, cleared, or unref'd, so it kept the event loop alive for the full 10s after every connection attempt, success or failure, not just genuine timeouts. The handle is now cleared in both the `onopen` success path and the `onerror` path.

## 0.0.2

### Patch Changes

- Peer dependency ranges were all ">=0.0.0", which accepts any version including a future incompatible major. They are now bounded at both ends: at least the version actually required, and below 1.0.0.

  browsermesh-apps declared core, transport and discovery as required peers but never imports any of them at runtime; every reference is a JSDoc type import, and the objects themselves are injected by the caller (discovery and transportNegotiator are optional and guarded at every use; wallet is required but supplied by the consumer, who therefore already has core). Since npm 7 installs peer dependencies automatically, that made installing apps pull in three packages it only needs for types. They are marked optional in peerDependenciesMeta.

## 0.0.1

### Patch Changes

- Feature-detect the platform floors instead of crashing on them.

## 0.0.0

Extracted from the private `clawser` monorepo and imported into the `@johnhenry` npm scope as part of the browsermesh monorepo consolidation. Previously published unscoped as `browsermesh-discovery@0.1.0` (2026-07-17, manual publish, never CI-automated). Per family convention, the version restarts at 0.0.0 on scope import.
