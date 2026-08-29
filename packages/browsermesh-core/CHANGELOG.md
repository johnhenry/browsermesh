# Changelog

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
