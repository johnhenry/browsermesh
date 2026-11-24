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

Extracted from a private monorepo (previously `packages/browsermesh-core`), where it was manually published to npm, unscoped, as `browsermesh-core@0.1.0` (2026-07-17) with no CI ever automating that publish. This is its first release as part of the `@johnhenry/browsermesh` monorepo; the version restarts at `0.0.0` per family convention.


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
- A `SignedKeyUnlink` REQUIRES a signed `expires` (ms epoch, like
  `SignedKeyLink`): `SignedKeyUnlink.create(p, childId, { expires })` throws
  without one, or use `SignedKeyUnlink.forLink(parentIdentity, link)`, which
  copies the link's expiry and namespace (pass `{ expires }` for a link that
  never expires). It signs `"browsermesh/keyunlink/v2\n"` + canonical JSON.
  **v1 unlinks (no `expires`) are no longer accepted**: `verify` is false,
  `applyUnlink` throws, and `MeshKeyring.fromJSON` drops them (listed with a
  reason in `keyring.droppedRevocations`). Once an unlink expires the keyring
  stops counting it: `listRevocations({ now })`, `toJSON()` and `fromJSON()`
  drop it, `pruneRevocations(now)` drops them explicitly and returns the
  count, and `applyUnlink` records nothing for an already-expired one. Rule:
  an unlink should expire no earlier than the link it revokes (what `forLink`
  does). If it expires sooner, the revocation lapses and a stale copy of the
  link is accepted again, but only while the link itself is unexpired;
  `verifyCryptoChain` always refuses an expired link.
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

## Authenticated signalling (protocol 2)

The `browsermesh-servers` signalling server can run in `AUTH_MODE=authenticated`: it sends each connection a single-use challenge and registers a pod only when the pod id is the hash of the Ed25519 key that signs the server's origin, the pod id and the nonce. A client that does not speak it is refused (`protocol-unsupported`); in open mode every peer is stamped `verified: false`.

`SignalingClient` speaks both. Give it an `identity` (a `PodIdentity`, whose `podId` must be `localPodId`):

```js
const signaler = new SignalingClient({ url: 'wss://signal.example.org', localPodId: identity.podId, identity })
await signaler.connect()        // resolves on `registered`; rejects with the server's refusal
signaler.registration           // { mode: 'authenticated', verified: true }
signaler.onOffer((data, from) => {
  if (signaler.isSourceVerified(data)) { /* the server vouched for `from` */ }
})
```

- With an identity it answers the challenge, signing the origin of `url` (or `origin`, for a server reached under another name; never the origin the challenge names). Against an open-mode or older server, which sends no challenge, it registers as before after `challengeWaitMs` (default 2000). `authentication: 'required'` never falls back (`SignalingAuthError`, `code: 'no-challenge'`); `'off'` never signs.
- Without an identity against an authenticated server it fails with `SignalingAuthRequiredError` (`code: 'auth-required'`). By default such a client keeps the old behaviour (`connect()` resolves on open) and the refusal is announced as an `auth-error` event and `lastAuthError`; pass `waitForRegistration: true` to have `connect()` reject instead. With an identity `connect()` waits for `registered` by default. Other refusals carry the server's own `code` (`bad-nonce`, `challenge-expired`, `bad-pod-id`, `bad-key`, `bad-signature`, `pod-id-mismatch`).
- `isSourceVerified(message)` is true only when the server stamped `sourceVerified: true` on a forwarded message (it overwrites whatever the sender put there). It is the server's statement about the link, not proof about the peer's payload; open-mode and older servers read as false.
- A client in `auto` mode can be pushed into the open flow by something that strips the challenge from an unprotected `ws://` link; use `wss://` and `authentication: 'required'` where that matters.

`fetchIceServers({ url | signalingUrl, token })` calls the server's `GET /ice-servers`, which answers only a caller that sends `Authorization: Bearer <ICE_API_TOKEN>` or is the same origin as the server, and returns time-limited TURN credentials. The token is sent as a header only, never over plain `http` to a non-loopback host, and a redirect is never followed with it. Failures are named: `ice-unauthorized`, `ice-rate-limited`, `ice-bad-response`, `ice-insecure-token`. Pass the result as `iceServers` to `HandshakeCoordinator`.

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
