# Changelog

## 0.6.1

### Patch Changes

- 1363a42: Adopt `@johnhenry/wsh` 0.49.0.

  - transport: `WshServices` starts a session (audit, `sessions`, indicator) when wsh reports the session sealed, not at login. A plain client that passes login on the sealed-only host was audited as a session and shown to the person although it was served nothing; now it is only a `refused` audit. The per-tool grants go through wsh's `permits` hook (`mcp-tool` for listing, `mcp-call` for running) instead of a wrapper around the handler, and the duplicate calls-per-minute count is gone (wsh's own bound applies). `WshServices` needs wsh 0.49 or later (the rest of the package still works from 0.45); results carry wsh's `wsh/untrusted` label only. The tests use `@johnhenry/wsh/testing`'s in-process relay; the `wsh-in-process` subpath is unchanged.
  - primitives: no behaviour change. `ssh-keys.mjs` is now run against `@johnhenry/wsh/identity` in a test (valid inputs, strictness cases and the written differences).
  - netway: no behaviour change. `GATEWAY_ERROR` is checked against wsh's exported `GATEWAY_FAIL_TABLE` and its doc says code 5 is a timeout in the Node gateway and "gateway disabled" in the Rust server.

## 0.6.0

### Minor Changes

- 8433d52: One conversion between a pod id and a wsh fingerprint, and explicit OpenSSH public key interop (#334).

  primitives: `podIdToFingerprint` / `fingerprintToPodId` (the same 32 bytes in base64url and in hex; strict about length and encoding), `openSSHPublicKeyFromRaw`, `rawPublicKeyFromOpenSSH` (exactly one `ssh-ed25519` key: options, other key types and non-canonical or multi-line input are refused), `podIdFromOpenSSHPublicKey`, `authorizedKeysLine`, and on `PodIdentity` `toOpenSSHPublicKey()` and `toAuthorizedKeysLine({ capabilities, expires, comment })`. `capabilities` is required (an empty list is a key that may do nothing) and characters that could end an option or the line are refused. Nothing calls any of this by default, nothing reads or writes a key file, and only public keys cross (there is no OpenSSH private key parser). See `docs/security.md`, "One key in both worlds".

  transport: `podIdToFingerprint`, `fingerprintToPodId` and `podIdFromRawKey` are no longer implemented here; the names are still exported from the package and are now the primitives functions, so the repository has one conversion. These functions need `@johnhenry/browsermesh-primitives` >= 0.6.0: the peer range must be raised to match in the version bump (it cannot be installed ahead of the release).

  Additive. A `fingerprintToPodId` / `podIdToFingerprint` that was given something that is not a canonical 32 byte value used to accept a non-canonical final base64url character; it is now refused.

## 0.5.0

### Minor Changes

- 05b5b81: Signed key-agreement statements and sealing to them (`key-agreement.mjs`).

  `generateAgreementKeyPair()`, `createKeyStatement(identity, pair, { now, lifetimeMs })`, `verifyKeyStatement(statement, { now, expectedPodId, revocations })`, `sealToStatement(verified, { aad, plaintext, maxBytes })`, `openSealed(box, { privateKeys, aad, maxBytes })`, `supportsKeyAgreement()`, `keyIdOf()` and `KeyAgreementError` (with a `code`).

  A statement binds an X25519 key to a pod id: it is signed by the Ed25519 key whose hash is the pod id, lasts at most 24 hours with no grace after `notAfter`, and is refused for an identity retired in the revocation store used for session certificates. Sealing is ephemeral-static X25519, HKDF-SHA-256 and AES-256-GCM with a fresh key and a random nonce per message and the caller's header as associated data. WebCrypto only; runs in Node and the browsers.

  Additive. Nothing in existing exports changes.

## 0.4.1

### Patch Changes

- d258e4b: Access control: one scope matcher, grants that end are announced, and what holds a grant open follows it.

  - `matchScope()` (primitives) compares scopes segment by segment for any number of segments; it used to ignore every segment past the third. Scopes of three segments or fewer match exactly as before. `PeerRegistry`'s built-in ACL (used when none is injected) now uses it instead of a matcher that looked at two segments, so `mesh-relay:<service>:connect`, `server-share:<name>:request`, `protocol:<name>:open`, `mesh:link:connect` and the like match their grants (before, only `*:*` did) and `mesh-relay:*:connect` no longer matches every action.
  - A grant with `expiresAt` is announced like a revocation: `registry.onAccessChange` gets `{ pubKey, kind: 'expired' }`, from one timer per registry for the nearest expiry. New options `clock` and method `dispose()`.
  - Long-lived holders follow access changes instead of waiting for their next use: `createMeshWebSocketService` sessions (new `accessResource`, `accessAction`, `recheckOnAccessChange`; closed with 4403 `access revoked`), open protocol channels, swarm members admitted through the join gate, wsh links under the default authorizer (new `watchWshAccess()`), and torrent serving after a rate-limit wait.
  - `createProxyHandler()` checks the caller (`checkAccess`, `resource`, `public`).

  Breaking defaults: `createProxyHandler()` throws at construction unless given `checkAccess` or `public: true` (and answers 403 to a caller `checkAccess` does not allow); `createMeshWebSocketService` now asks `onConnection` again when that peer's access changes (set `recheckOnAccessChange: false` to keep the old behaviour); a protocol channel is closed at the moment of revocation rather than on its next use. A registry with no injected ACL that relied on three-segment scopes matching only `*:*` now matches the scopes it was granted. No wire change: pods on older versions are unaffected.

## 0.4.0

### Minor Changes

- 2555d57: Vault-friendly identity, session certificates and signed revocation. `PodIdentity` can now be built from a non-extractable key (`generate({ extractable: false })`, `fromCryptoKeyPair`), an imported JWK or PKCS#8 key (non-extractable by default), or an external signer (`fromSigner({ publicKey, sign })`, the shape `@johnhenry/wsh` takes); all signing goes through the one `sign()` seam and `exportPrivateKey()` rejects unless the identity is exportable. New: versioned, length-prefixed session certificates (`createSession`, `issueSessionCertificate`, `verifyPeerCredential`, `scopeAllows`), signed revocation of a session or of an identity (`revokeSessionCertificate`, `retireIdentity`, `receiveRevocation`, `isRevoked`) and a bounded pluggable store (`MemoryRevocationStore`). Existing exports and behaviour are unchanged.

## 0.3.1

### Patch Changes

- e2b4758: Share browser-safe mesh address parsing through primitives and discovery, retaining case-sensitive IDs and query strings. Remove the Node-only mesh-fetch factory path. Add explicit HTTP body mode and Request input with bounded byte-preserving uploads, native multipart headers, cancellation and correct HEAD/bodyless responses, while retaining the default structured JSON-body convention. HTTP bodies are buffered, not streamed.

## 0.3.0

### Minor Changes

- e4e6899: ACL and CRDT fixes, plus capability/ACL guidance.

  - `ACLEngine.check()` / `AccessGrant.check()` now report `grant_revoked` for a revoked grant instead of `grant_expired`. `grant_expired` is reserved for `conditions.expires` and exhausted `maxUses`. New `AccessGrant#isRevoked()`; `isExpired()` is unchanged. Callers that matched on `reason === 'grant_expired'` to detect revocation must also handle `grant_revoked`.
  - `LWWMap` `value`, `toJSON()`, `keys()`, `values()` and `entries()` now yield keys in sorted order, so converged replicas serialize identically.
  - New `grantFromToken(token)` maps a `CapabilityToken` onto an `AccessGrant`, and the README explains when to use tokens versus grants and lists the ACL reason strings.

- 774e86e: Add `padTo()`, `unpad()`, `paddedLength()`, `DEFAULT_PAD_BUCKETS` and `PAD_TRAILER_BYTES`: opt-in size-bucket padding (default buckets 256/1024/4096/16384; oversize payloads round up to a multiple of the largest) so a relay that only sees ciphertext learns the bucket, not the exact payload length. Pad before sealing.

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
