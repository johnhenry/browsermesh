# Changelog

## 0.1.1

### Patch Changes

- Peer dependency ranges were all ">=0.0.0", which accepts any version including a future incompatible major. They are now bounded at both ends: at least the version actually required, and below 1.0.0.

  browsermesh-apps declared core, transport and discovery as required peers but never imports any of them at runtime; every reference is a JSDoc type import, and the objects themselves are injected by the caller (discovery and transportNegotiator are optional and guarded at every use; wallet is required but supplied by the consumer, who therefore already has core). Since npm 7 installs peer dependencies automatically, that made installing apps pull in three packages it only needs for types. They are marked optional in peerDependenciesMeta.

## 0.1.0

### Minor Changes

- WasmSandbox.execute() no longer invents its CPU figure. It used Math.random() and enforced the policy budget against that, so usage.cpuMs was noise and the absence of a Policy violation throw meant nothing. load() now takes the executor that actually runs the module, and execute() returns { result, cpuMs, executed }.

  MeshKeyring.fromJSON() now dispatches on the serialised shape, so a restored keyring carrying signed links actually verifies them. A keyring that previously round-tripped as valid without running any cryptography can now report invalid.

  An encrypted identity export can be imported again, and attenuation actually narrows the resource scope.

## 0.0.1

### Patch Changes

- Fix escrow_create/escrow_release/torrent_seed tools calling the wrong manager API

  Found during a 2026-08-28 clawser feature audit: `escrow_create`/`escrow_release`
  called `EscrowManager.createEscrow()`/`.releaseEscrow()`, which don't exist —
  the real methods are `.create(opts)`/`.release(contractId)`. `torrent_seed`
  called `TorrentManager.seed(name, data)`, but `seed(data, opts)` takes the
  file content first — the filename was silently being seeded as the torrent's
  actual content. All three tools threw or misbehaved on every real invocation.
  Added regression tests exercising `execute()` against a duck-typed fake
  matching each manager's real public API (the existing tests only checked
  tool _registration_, never the actual call, which is why this shipped
  unnoticed).

## 0.0.0

Extracted from the private `clawser` monorepo and imported into the `@johnhenry` npm scope as part of the browsermesh monorepo consolidation. Previously published unscoped as `browsermesh-core@0.1.0` (2026-07-17, manual publish, never CI-automated). Per family convention, the version restarts at 0.0.0 on scope import.
