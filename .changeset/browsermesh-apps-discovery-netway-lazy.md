---
"@johnhenry/browsermesh-apps": minor
---

`@johnhenry/browsermesh-discovery` and `@johnhenry/browsermesh-netway` are now genuinely optional peerDependencies -- the final 2 of the 5 originally-eager "optional" peers (after `browsermesh-transport`/`browsermesh-kernel` and `browsermesh-core` in the two prior releases) now actually behave that way. A consumer of `.` with zero optional peers installed can import the full barrel and use any feature that doesn't touch discovery/netway without error.

**Technique**: unlike the transport/kernel/core fixes (which used a dynamic `await import()`, requiring 3 factory functions to become `async`), every file here uses `createRequire(import.meta.url)` -- Node's stable synchronous `require()` of an ES module (Node >=22.12/23, well within this package's own `engines.node: >=24` floor). `require()` resolves the module lazily (only when the code path that needs it actually runs, not at this module's own load time) while staying fully synchronous, so it works in places a dynamic import structurally cannot: inside a constructor, or where a synchronous validation-throw is directly tested via `assert.throws(...)`.

**Fixed, zero breaking changes** (all five keep their exact existing signature and throw/return semantics):
- `mesh-fetch.mjs` -- `createBrowserMeshFetch()` and the `browserMeshFetch(url, init)` it returns both stay fully synchronous, including the synchronous `TypeError` for a malformed URL (matching real `fetch()`).
- `mesh-websocket.mjs` -- `parseMeshRequest()` is resolved lazily *inside* `BrowserMeshWebSocket`'s constructor (the file that motivated trying `require()` at all: a constructor can never be `async`, so a dynamic `import()` was a structural dead end here regardless of any breaking-change tolerance).
- `mesh-dht.mjs` -- `createMeshDht()` stays synchronous; its directly-tested validation throws are unaffected.
- `mesh-swarm.mjs` -- `SwimMembership`/`SwarmCoordinator`/the `SWARM_*` constants are resolved lazily inside `attach()`, preserving `mesh-service.mjs`'s synchronous `attachService()` convention.
- `serverless-fetch.mjs` -- `createServerlessFetchRouter()` stays synchronous; its directly-tested validation throws are unaffected.

**Fixed, BREAKING change** (the one case `require()` can't help with): a class's `extends` clause is evaluated at class-declaration time, and a `class X extends Y {}` statement written at module top level always runs at module-load time no matter how `Y` is obtained -- there is no way to defer that with a plain lazy import, sync or async. Fixed by moving the class declaration itself out of module-top-level scope into a function that resolves the base class via `require()` and builds+memoizes the class on first call:
- `cloud-storage-backend.mjs` -- `CloudStorageBackend` is no longer exported as a class. Replace `new CloudStorageBackend(opts)` with `createCloudStorageBackend(opts)` (same `opts` shape, returns a real `CloudStorageBackend` instance with the identical instance API).
- `mesh-relay-backend.mjs` -- same change: replace `new MeshRelayBackend(opts)` with `createMeshRelayBackend(opts)`.

  Every in-repo call site (5 test files for `CloudStorageBackend`, 3 test files + 2 runnable `examples/` scripts + the README for `MeshRelayBackend`, plus `cloud-storage.mjs`'s own internal use of `CloudStorageBackend`) has been updated. No `instanceof`/subclassing usage of either class existed anywhere in the repo (verified by grep before making this change).

**Also fixed in this release**: `examples/07-full-mesh-pipeline.mjs` was missing an `await` on `createMeshKernel()` (made `async` in the prior 0.6.0 release) -- a real, previously-undetected gap, since `npm run examples` isn't part of either the default or `test:real-peer` suite. Running every example end-to-end as part of this release's own verification (not just the test suites) caught it; it's fixed here, and all 11 examples now run clean via `npm run examples`.

**Still required, not optional** (unaffected by this release): `@johnhenry/browsermesh-primitives` and `@johnhenry/browsermesh-sync` remain genuine, non-optional dependencies of this package -- `cloud-storage-backend.mjs` imports `LWWMap`/`IndexedDBChunkStore`/`IndexedDBSyncStorage`/`TRANSFER_DEFAULTS` from them eagerly, deliberately, same as before.

With this release, all 5 of `browsermesh-apps`'s originally-eager "optional" peerDependencies (`browsermesh-transport`, `browsermesh-kernel`, `browsermesh-core`, `browsermesh-discovery`, `browsermesh-netway`) are now genuinely optional -- verified end-to-end by temporarily removing all five from `node_modules` and confirming the full `.` barrel (333 exports) still imports cleanly, and that a peer-dependent function invoked without its peer installed fails with a clear, synchronous `MODULE_NOT_FOUND`, not a confusing crash.
