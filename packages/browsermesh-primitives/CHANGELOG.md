# Changelog

## 0.2.0

### Minor Changes

- c452f21: BREAKING: `PodIdentity.verify` now takes `(publicKey, signature, data)`, the same order as `crypto.subtle.verify`; it previously took `(publicKey, data, signature)`. Swap the last two arguments at every call site. To avoid silently returning `false` for old-order callers, a call whose `signature` is not 64 bytes while `data` is exactly 64 bytes throws a `TypeError` naming the new order. `sign` is unchanged. (The 0.1.0 object-form overload is removed.)

## 0.1.0

### Minor Changes

- 90bb906: Add the canonical object form `PodIdentity.verify({ publicKey, signature, message })` (and `identity.sign({ message })`), matching the sibling libraries. The positional `verify(publicKey, data, signature)` form is unchanged; its argument order is now documented loudly because it differs from WebCrypto and wsh (key, signature, data).

## 0.0.3 (2026-09-26)

### Patch Changes

- Add missing `probeEd25519Support`, `supportsEd25519`, and
  `_resetEd25519Probe` type declarations (#181).

  All three have been exported at runtime from `src/index.mjs` (re-exported
  from `src/identity.mjs`) since before the package shipped declarations at
  all, but none were added to `src/index.d.ts`. TypeScript consumers hit
  `TS2305` ("has no exported member") and had to write a local `declare
module` augmentation just to call any of them. `src/index.d.ts` now
  declares `probeEd25519Support(): Promise<boolean>` (never throws; resolves
  `true`/`false` and caches the answer), `supportsEd25519(): boolean | null`
  (the cached answer, `null` until the probe first resolves), and
  `_resetEd25519Probe(): void` (clears the cache; tests only, but still part
  of the public export surface, so still needs a declaration). A `.ts`
  fixture under `test/` imports all three by the package's published name
  and is type-checked via a new `typecheck` script (wired into `pretest`, so
  `npm test` catches this class of regression going forward).

## 0.0.2

### Patch Changes

- Fix TypeScript declarations not being resolved (#179).

  `browsermesh-primitives` shipped `src/index.d.ts`, but its `exports` map
  used a bare string target with no `types` condition (and no top-level
  `types` field), so TypeScript ignored the sibling declaration file
  entirely and consumers hit `TS7016` on every import. `exports["."]` now
  has an explicit `types` condition (checked first) alongside `import`,
  and a top-level `types` field points at the same file.

  `browsermesh-pod` shipped no declarations at all, even though `Pod` and
  `BroadcastChannelTransport` are real public exports the tutorial docs
  use. It now ships `src/index.d.ts` covering its full public surface —
  `Pod`, `InjectedPod`, `detectPodKind`, `detectCapabilities`, the
  transport adapters (`BroadcastChannelTransport`, `EventEmitterTransport`,
  `NullTransport`), the discovery adapters (`TransportDiscovery`,
  `NullDiscovery`), the wire-protocol message constants and factories, and
  the `installPodRuntime` / `createRuntime` / `createClient` /
  `createServer` runtime entrypoints — wired into `package.json` the same
  way as primitives.

## 0.0.1

### Patch Changes

- Feature-detect the platform floors instead of crashing on them.

## 0.0.0

Imported into the `@johnhenry` npm scope as part of the browsermesh
monorepo consolidation. Previously published unscoped as
`browsermesh-primitives@0.1.1`. Per family convention, the version restarts
at 0.0.0 on scope import — see the README's Provenance section.

## 0.1.1 (unreleased entry, retroactively documented)

- Minimum Node.js bumped to 24.
- Added CodeQL and dependency-review CI workflows.

## 0.1.0 (2026-03-15)

Initial release.

- **Identity**: `PodIdentity` with Ed25519 key generation, signing, and verification; `derivePodId` for deterministic pod IDs; base64url encode/decode utilities
- **Wire format**: `encodeMeshMessage` / `decodeMeshMessage` with extensible message type registry
- **Capabilities**: `CapabilityToken` with scope parsing and matching (`parseScope`, `matchScope`)
- **Trust**: `createTrustEdge`, `computeTransitiveTrust` across configurable trust categories
- **ACL**: `ACLEngine` with resource pattern matching, `Permission` and `AccessGrant` primitives
- **CRDTs**: `VectorClock`, `LWWRegister`, `GCounter`, `PNCounter`, `ORSet`, `RGA`, `LWWMap` -- all with merge, toJSON/fromJSON round-trip
- **Test utilities**: `DeterministicRNG`, `LocalChannel`, `createLocalChannelPair`, `TestMesh`
