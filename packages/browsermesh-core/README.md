# browsermesh-core

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-core.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-core)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-core.svg)](LICENSE)

Identity, crypto, peer management, and trust primitives for BrowserMesh.

## Why this exists

`browsermesh-primitives` gives you an Ed25519 keypair and a bare capability token; it has no opinion about *peers* -- who you've seen, how much you trust them, or what they're currently allowed to do. `browsermesh-core` is the layer that turns raw identity primitives into a working peer model: `MeshIdentityManager`/`IdentityWallet` manage which identity is active, `MeshPeerManager`/`PeerState` track who's been seen and when, `TrustGraph` accumulates trust edges into a transitive score, and `MeshACL`/`CapabilityChain`/`CapabilityValidator` turn a raw `CapabilityToken` into an actual access decision. It sits directly on `browsermesh-primitives` and nothing else -- every downstream package that needs to answer "is this peer who they say they are, and are they allowed to do this" builds on `browsermesh-core` rather than reimplementing peer/trust bookkeeping itself.

## Cross-package relationship

- **Depends on** `@johnhenry/browsermesh-primitives` (required) -- `identity.mjs`, `acl.mjs`, `keyring.mjs`, and `trust.mjs` all import their base types (`PodIdentity`, capability/wire-format primitives) from there.
- **Used by** `@johnhenry/browsermesh-apps` (optional peer) -- `peer-registry.mjs` types its registry against `MeshPeerManager`/`TrustGraph`/`MeshACL`, and several modules (`mesh-hardening.mjs`, `mesh-keepalive.mjs`, `key-distribution.mjs`) lazily `import()` this package at runtime for `RetryWithBackoff`, `TransportFailover`, `TransportHealthCheck`, `MetricsRegistry`, and the `wrapKeyForMember`/`unwrapKeyForMember` key-wrapping helpers used by CloudStorage's key-distribution service.
- **Optionally reaches back into** `@johnhenry/browsermesh-apps` itself -- `peer-tools.mjs` lazily `import()`s `ScheduledTask` from `browsermesh-apps` when a peer tool needs to schedule follow-up work. This is a genuine (narrow, optional-on-both-sides) circular relationship: neither package requires the other to load, but each reaches into the other for one specific, lazily-imported piece.

## Provenance

Extracted from the private `clawser` monorepo (previously `packages/browsermesh-core`), where it was manually published to npm, unscoped, as `browsermesh-core@0.1.0` (2026-07-17) with no CI ever automating that publish. This is its first release as part of the `@johnhenry/browsermesh` monorepo; the version restarts at `0.0.0` per family convention.


## Modules

| Module | Key Exports |
|--------|-------------|
| identity | `MeshIdentityManager`, `AutoIdentityManager`, `IdentitySelector`, `PodIdentity`, `derivePodId` |
| identity-tools | `IdentityCreateTool`, `IdentityListTool`, `IdentitySwitchTool`, `registerIdentityTools` |
| keyring | `MeshKeyring`, `KeyLink`, `SignedKeyLink`, `SignedKeyUnlink`, `SuccessionPolicy` |
| group-keys | `GroupKeyManager`, `GroupState` |
| peer | `PeerState`, `MeshPeerManager` |
| peer-tools | `MeshPeerToolsContext`, `registerMeshPeerTools` + 30 BrowserTool subclasses |
| handshake | `HandshakeCoordinator`, `SignalingClient`, `DirectInputHandshake` |
| acl | `MeshACL`, `ScopeTemplate`, `RosterEntry`, `InvitationToken` |
| capabilities | `CapabilityToken`, `CapabilityChain`, `CapabilityValidator`, `WasmSandbox` |
| trust | `TrustGraph` |
| hardening | `RetryWithBackoff`, `TransportHealthCheck`, `ConnectionPool`, `TransportFailover` |
| identity-base | `IdentityManager`, `compileSystemPrompt`, `detectIdentityFormat` |
| identity-wallet | `IdentityWallet` |

## Install

```bash
npm install @johnhenry/browsermesh-core @johnhenry/browsermesh-primitives
```

## Usage

```js
import { MeshIdentityManager, MeshKeyring, TrustGraph } from '@johnhenry/browsermesh-core';
```

## Verifying key links and capabilities from peers

- `MeshKeyring#verifyCryptoChain(from, to, getPublicKey)` requires every link
  on the path to be a `SignedKeyLink` signed by both ends, unexpired, in the
  keyring's `namespace` and not revoked. Unsigned `KeyLink`s (from `link()`)
  are refused unless you pass `{ requireSigned: false }`.
- `SignedKeyLink`s sign `"browsermesh/keylink/v3\n"` + sorted-key canonical
  JSON, including an optional `namespace`. Give the keyring and its links the
  same namespace (`new MeshKeyring({ namespace })`,
  `SignedKeyLink.create(p, c, rel, { namespace })`) so a link issued for one
  keyring is refused by another.
- Revoke an edge with `SignedKeyUnlink.create(parentIdentity, childId)` and
  `keyring.applyUnlink(unlink, parentPub)`. Unlinks serialise, can be relayed
  to peers, and cut off every descendant of the child. `unlink()` is local only.
- `executeSuccession(primary, { links, getPublicKey })` with a `transfer`
  policy needs successor-signed replacement links (`{ localOnly: true }` keeps
  the old unsigned behaviour).
- Before a capability chain crosses peers, sign it (`CapabilityToken.issue`,
  `token.attenuateSigned`) and check it on arrival with
  `chain.verifySignatures(getPublicKey, { rootIssuer })`.

**Migrating links signed before 0.10 (v2 payload).** They no longer verify by
default. To migrate, load them into a keyring with `{ acceptLegacyV2: true }`
(verification only, never for signing), find them with
`link.signatureVersion(parentPub, childPub) === 2`, and re-sign each with
`link.resign(parentIdentity, childIdentity, { namespace })`. v1
(`a|b|c|d`) signatures are no longer accepted at all; re-create those links.

## Padding group-key envelopes

`GroupKeyManager.encrypt()` leaks the exact plaintext length to anything that
sees the ciphertext (a relay, for instance). Pass `padding` to round the
plaintext up to a size bucket before sealing it:

```js
const { ciphertext, iv, epoch } = await keys.encrypt(bytes, { padding: true });
const back = await keys.decrypt(ciphertext, iv, epoch, { padding: true });
```

`padding: true` uses buckets of 256 / 1024 / 4096 / 16384 bytes (larger
payloads round up to a multiple of 16384); `{ buckets: [...] }` picks your own;
`new GroupKeyManager({ ..., padding })` sets the default. Ciphertexts are then
`bucket + 16` bytes. Sender and receiver must agree on the setting (the padded
plaintext is not self-describing). Off by default; no cover traffic or timing
protection is provided.

## License

MIT
