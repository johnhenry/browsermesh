# Changelog

## 0.1.0

### Minor Changes

- `ResourceTable.get()`/`getTyped()`/`drop()` previously took only a handle string, so any code holding the shared kernel reference could access or destroy another tenant's resource by guessing its sequential handle (`res_1`, `res_2`, ...), even though `owner` was already tracked per-entry.

  They now accept an optional `expectedOwner` param that, when supplied, must match the stored owner or throws the new `ResourceOwnershipError` (`EOWNERSHIP`). Omitting `expectedOwner` preserves the old ambient/ownership-blind behavior for trusted kernel-internal callers (e.g. `destroyTenant`'s cleanup sweep).

  `Kernel#resourcesFor(tenantId)` returns a `{get, getTyped, drop}` view that auto-binds `expectedOwner` to `tenantId`, so tenant-facing code can no longer reach another tenant's resource by handle. The raw `kernel.resources` getter stays for backward compat and kernel-internal use.

- `buildCaps()`'s `caps.mesh` was previously a bare `true` marker with nothing real behind it. `Kernel` now accepts an optional `mesh` constructor option (a duck-typed provider shaped like `{ sendTo, onIncomingData, registry: { checkAccess } }`) and exposes `Kernel#meshFor(tenantId)`, mirroring `resourcesFor(tenantId)`: a tenant granted `KERNEL_CAP.MESH` gets a frozen `{ send, onReceive }` view — not the raw peer API — with every send/receive gated by the provider's `registry.checkAccess(peerId, 'mesh', 'send'|'receive')`, so a tenant can only reach peers the registry has actually authorized. Denied access throws the new `MeshAccessDeniedError` (`EMESHDENIED`). Tenants without `KERNEL_CAP.MESH` still get no `caps.mesh` at all, and kernels constructed without a `mesh` option keep the pre-existing bare boolean marker, so existing callers that only check truthiness are unaffected.

  `browsermesh-kernel` keeps zero dependency on any `@johnhenry/browsermesh-*` package — the `mesh` option is duck-typed, not an imported class. `src/index.d.ts` also gains type declarations for `ResourceOwnershipError`/`expectedOwner` and `meshFor()`/`MeshAccessDeniedError`, which had fallen out of sync.

## 0.0.0

Extracted from the private `clawser` monorepo and imported into the `@johnhenry` npm scope as part of the browsermesh monorepo consolidation. Previously published unscoped as `browsermesh-kernel@0.1.0` (2026-07-17, manual publish, never CI-automated). Per family convention, the version restarts at 0.0.0 on scope import.
