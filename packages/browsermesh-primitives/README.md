# browsermesh-primitives

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-primitives.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-primitives)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-primitives.svg)](LICENSE)

Shared primitives for browser mesh networking -- wire format, identity (Ed25519), CRDTs, capabilities, trust model, and ACL engine. Zero dependencies, pure ES modules, runs in browsers and Node.js.

## Why this exists

Every other package in this monorepo needs the same handful of building blocks -- an identity to sign with, a wire format to put bytes on the network, CRDTs that merge deterministically across peers, and a shared vocabulary for "does this peer have permission to do X." Reimplementing any of those per package would mean N slightly-different Ed25519 key derivations, N incompatible wire encodings, and no guarantee that two packages' capability tokens even mean the same thing. `browsermesh-primitives` exists to be that one shared, dependency-free floor: every downstream package imports its identity, CRDT, capability, or wire-format types directly rather than rolling its own, so two peers running different BrowserMesh packages built against the same primitives version can always talk to, sign for, and verify each other. It has zero dependencies of its own on purpose -- nothing downstream should have to worry about *this* package dragging in a second copy of anything.

## Used by

Every other package in this monorepo depends on `browsermesh-primitives` directly, or transitively through one that does:

- `@johnhenry/browsermesh-core` -- identity, keyring, ACL, and trust-graph classes wrap this package's `PodIdentity`, `MESH_TYPE`, and capability/CRDT types.
- `@johnhenry/browsermesh-discovery` -- DHT, naming, and swarm messages are tagged with this package's `MESH_TYPE` constants.
- `@johnhenry/browsermesh-pod` -- `Pod` generates its Ed25519 identity via `PodIdentity.generate()`.
- `@johnhenry/browsermesh-sync` -- `SyncDocument` is built directly on this package's `VectorClock`, `LWWRegister`, `GCounter`, `PNCounter`, `ORSet`, `RGA`, and `LWWMap` CRDT classes.
- `@johnhenry/browsermesh-transport` -- transport message/error types (`MESH_TYPE`, `MESH_ERROR`) come from here.
- `@johnhenry/browsermesh-apps` -- imports this package directly (`MESH_TYPE`, `LWWMap`, base64url helpers) alongside its required `browsermesh-sync` peer.
- `@johnhenry/browsermesh-embed` -- transitively, through its hard dependency on `browsermesh-pod`.

`browsermesh-kernel`, `browsermesh-netway`, and `browsermesh-priority-mux` are the exceptions: each is deliberately zero-dependency and imports nothing from this package.

## Provenance

Previously maintained as an independent, standalone repository and published to npm, unscoped, as `browsermesh-primitives@0.1.1` (initial release `0.2.0`, 2026-03-15), with its own CI already wired up (tests, CodeQL, dependency review). Imported into the `@johnhenry/browsermesh` monorepo via `git subtree` -- preserving its full commit history -- and rescoped to `@johnhenry/browsermesh-primitives`; the version restarts at `0.0.0` per family convention.

## Install

```bash
npm install @johnhenry/browsermesh-primitives
```

Or via CDN:

```html
<script type="module">
  import { PodIdentity, VectorClock, ACLEngine } from 'https://esm.sh/@johnhenry/browsermesh-primitives'
</script>
```

## Quick Start

```js
import {
  PodIdentity,
  VectorClock,
  ORSet,
  CapabilityToken,
  ACLEngine,
  encodeMeshMessage,
  decodeMeshMessage,
} from '@johnhenry/browsermesh-primitives'

// Generate an Ed25519 identity
const identity = await PodIdentity.generate()
console.log(identity.podId) // base64url-encoded SHA-256 of public key

// Sign and verify data
const data = new TextEncoder().encode('hello mesh')
const sig = await identity.sign(data)
// Argument order is (publicKey, signature, data) -- same as crypto.subtle.verify.
// BREAKING in 0.2.0: earlier versions took (publicKey, data, signature); the old
// order now throws a TypeError instead of silently returning false.
const ok = await PodIdentity.verify(identity.keyPair.publicKey, sig, data)

// CRDTs -- merge state across peers
const clockA = new VectorClock()
clockA.increment('node-a')
const clockB = new VectorClock()
clockB.increment('node-b')
const merged = clockA.merge(clockB)

// Observed-Remove Set
const set = new ORSet()
set.add('item', identity.podId)
console.log(set.has('item')) // true
```

## API Overview

### Constants & Errors

- `MESH_TYPE` -- message type constants
- `MESH_ERROR` -- error code constants
- `MeshError`, `MeshProtocolError`, `MeshCapabilityError` -- error classes

### Identity

- `PodIdentity` -- Ed25519 key pair with sign/verify; also `fromCryptoKeyPair`, `fromJwk`, `fromPkcs8`, `fromSigner`, `generate({ extractable })` (see [Vault-friendly identity](#vault-friendly-identity-session-certificates-and-revocation))
- `derivePodId(publicKey)` -- SHA-256 hash to base64url pod ID
- `encodeBase64url(bytes)` / `decodeBase64url(str)` -- URL-safe base64
- Session certificates and signed revocation: `createSession`, `issueSessionCertificate`, `verifyPeerCredential`, `scopeAllows`, `revokeSessionCertificate`, `retireIdentity`, `receiveRevocation`, `isRevoked`, `MemoryRevocationStore`, `CredentialError`

### Wire Format

- `parseMeshRequest(url)` — shared browser-safe parsing of `mesh://` and
  `*.mesh.local` addresses into `{ podId, path }`, preserving ID case and
  query strings and excluding fragments. Discovery re-exports the same helper.

- `messageTypeRegistry` -- extensible registry of message types
- `encodeMeshMessage(msg)` / `decodeMeshMessage(bytes)` -- binary serialization

### Capabilities

- `CapabilityToken` -- signed-by-issuer capability with scopes and expiry (see [Capability tokens vs ACL grants](#capability-tokens-vs-acl-grants))
- `parseScope(str)` / `matchScope(pattern, target)` -- scope parsing and matching

### Trust

- `TRUST_CATEGORIES` -- predefined trust category constants
- `createTrustEdge(from, to, category, score)` -- weighted trust edge
- `computeTransitiveTrust(edges, source, target)` -- transitive trust score

### ACL

- `ACLEngine` -- evaluate access grants against resource patterns
- `Permission` -- permission level enum
- `AccessGrant` -- grant struct with resource pattern, permission, and principal
- `matchResourcePattern(pattern, resource)` -- glob-style resource matching
- `generateGrantId()` -- unique grant ID generator
- `grantFromToken(token, { grantor?, id? })` -- map a `CapabilityToken` onto an `AccessGrant` (does not verify the token)

`AccessGrant.check()` / `ACLEngine.check()` report a denial as one of:

| `reason` | Meaning |
| --- | --- |
| `grant_revoked` | The grant was revoked (`grant.revoke()`, `ACLEngine.revokeGrant()`, `revokeAll()`) |
| `grant_expired` | `conditions.expires` has passed or `conditions.maxUses` is exhausted |
| `outside_time_window` | None of `conditions.timeWindows` covers the current time |
| `no_matching_permission` | The grant is live but no permission covers the resource + action |
| `no_grants` | (`ACLEngine` only) the grantee has no grants at all |

With several grants for one grantee, the engine returns the reason from the last grant it examined.

### Padding

- `padTo(bytes, { buckets? })` / `unpad(padded)` -- round a payload up to a size bucket (default 256 / 1024 / 4096 / 16384; larger payloads round up to a multiple of the largest) with a length trailer, and strip it again
- `paddedLength(length, { buckets? })`, `DEFAULT_PAD_BUCKETS`, `PAD_TRAILER_BYTES`

Apply `padTo()` before sealing (encrypting) a message, so a relay that only sees ciphertext learns the bucket rather than the exact length; the trailer is plaintext, so padding already-encrypted bytes hides nothing. Size only, no timing or cover traffic.

### CRDTs

- `VectorClock` -- partial-order logical clock with merge
- `LWWRegister` -- last-writer-wins register with nodeId tiebreak
- `GCounter` -- grow-only counter
- `PNCounter` -- positive-negative counter
- `ORSet` -- observed-remove set (add-wins semantics)
- `RGA` -- replicated growable array (ordered list)
- `LWWMap` -- last-writer-wins map with tombstones

All CRDTs support `merge()`, `toJSON()`, and `fromJSON()` for serialization.

`LWWMap`'s `value`, `toJSON()`, `keys()`, `values()` and `entries()` yield keys in sorted order (UTF-16 code unit order), not insertion order. Replicas that have converged therefore serialize identically, so hashing or signing `JSON.stringify(map.value)` agrees across peers.

### Capability tokens vs ACL grants

The package ships two authorization models. They are not interchangeable and nothing converts between them implicitly.

| | `CapabilityToken` | `AccessGrant` / `ACLEngine` |
| --- | --- | --- |
| Shape | `scopes: ['namespace:resource:action']`, `issuer`, `subject`, `expiresAt` (seconds) | `permissions: [{ resource: 'mesh://ns/resource', actions }]`, `grantee`, `grantor`, `conditions` |
| Matching | `covers()` / `matchScope()`, `*` per part | glob patterns (`*`, `**`, `?`), `*`/`admin` actions |
| Signed | Yes, the issuer signs it | No, it is local state |
| Revocable | No (only expires) | Yes, plus `maxUses`, time windows, usage counting |
| Lives | travels with the holder, handed to a peer | in the enforcing pod, never leaves it |

Use a token as the portable, verifiable thing you hand to another pod ("the issuer says you may do X"). Use grants as the local, revocable policy a pod keeps about who may touch what. To enforce a received token while keeping revocation, verify it, then convert it to a grant in your engine:

```js
import { ACLEngine, grantFromToken } from '@johnhenry/browsermesh-primitives';

const acl = new ACLEngine();

// `token` is a CapabilityToken a peer presented; `sender` is the pod ID the
// transport authenticated for that peer.
function accept(token, sender) {
  // 1. Verify the issuer's signature over token.toJSON() yourself
  //    (PodIdentity), then check it is addressed to the sender and live.
  if (token.subject !== sender || token.isExpired()) throw new Error('rejected');
  // 2. Mirror it into the ACL. Scope 'memory:notes:write' becomes
  //    resource 'mesh://memory/notes', actions ['write'].
  const grant = grantFromToken(token);
  acl.addGrant(grant);
  return grant.id; // keep it to revoke later
}

accept(token, sender);
acl.check(sender, 'mesh://memory/notes', 'write'); // { allowed: true, grant }
acl.revokeAll(sender);
acl.check(sender, 'mesh://memory/notes', 'write'); // { allowed: false, reason: 'grant_revoked' }
```


### Vault-friendly identity, session certificates and revocation

**Where the key lives.** `PodIdentity` can be built four ways, and every signature goes through one `sign()` seam:

```js
await PodIdentity.generate();                          // as before: extractable key
await PodIdentity.generate({ extractable: false });    // usable, never readable by the page
await PodIdentity.fromJwk(jwk);                        // import (non-extractable unless { extractable: true })
await PodIdentity.fromPkcs8(bytes, { publicKey });     // PKCS#8 has no public half: pass it, or ask for extractable: true
await PodIdentity.fromCryptoKeyPair(storedKeyPair);    // e.g. a non-extractable pair loaded from IndexedDB
await PodIdentity.fromSigner({ publicKey, sign });     // the private key is in a vault, token, extension...
```

Nothing in this package calls `exportKey` on a private key; `identity.exportPrivateKey()` is the only way, and it rejects unless the identity was made exportable. The signer is `{ publicKey, sign(data) }` -- `publicKey` the raw 32-byte key or a public `CryptoKey`, `sign` returning the 64-byte signature, sync or async. That is the same shape as `@johnhenry/wsh`'s "Signing with a page-held signer", so one signer object can serve both libraries.

**Session certificates.** Use the long-lived identity key rarely: once per session, to certify a short-lived, non-extractable session key.

```js
const { session, certificate } = await createSession(identity, {
  scope: ['chat:*:read', 'mesh:peer:send'],   // required; [] grants nothing, ['*'] is "everything"
  ttlSeconds: 3600,                           // default 1 h; the issuer and every verifier cap it at 24 h by default
});
const sig = await session.sign(message);      // the session key signs traffic, the identity key is not touched
// ...send `certificate` (bytes, or encodeBase64url(certificate)) once, with a proof of possession:
const proof = await createSessionProof(session, challenge);

// verifier
const peer = await verifyPeerCredential(certificate, {
  now: Date.now(), skewSeconds: 30, revocations: store,
  expectedIdentity: knownPodId, requireScope: 'chat:room1:read', proof: { challenge, signature: proof },
});
// -> { identityKey, podId, sessionKey, scope, serial, notBefore, notAfter }; throws CredentialError otherwise
```

Rules: a certificate is valid during `[notBefore - skew, notAfter + skew)` in whole seconds (`skewSeconds` defaults to 30, at most 300); a verifier enforces its own `maxLifetimeSeconds` (default 86400) whatever the issuer chose; chain length is exactly one (a session key cannot issue certificates, and a list of certificates is refused); an empty scope grants nothing (the conservative choice: "all" has to be written as `'*'`); scope entries use the `namespace:resource:action` form of `matchScope`. A certificate proves the identity authorised that session key -- it does not prove the sender holds it, so also verify message signatures against `peer.sessionKey` (`verifyWithRawPublicKey`) or pass a `proof`. Pass `expectedIdentity` when you know whom you are talking to; otherwise the certificate only says "some identity key vouches for this session".

**Encoding** (so another implementation can match; test vectors are in `test/session.test.mjs`): `"BMSC" | u8 version=1 | field identityKey | field sessionKey | field serial(16) | u64 notBefore | u64 notAfter | u16 scopeCount | field scope... | field signature`, where `field` is a big-endian u16 length plus bytes and scopes are sorted bytewise and unique. The signature covers `"browsermesh/session-certificate/v1\n" + body`.

**Revocation.** The identity key signs `revokeSessionCertificate(identity, certificate)` (one session, by serial) or `retireIdentity(identity)` (the identity is done; all its certificates, past and future, are refused). Only the key a statement names can sign it, so a key can revoke only its own sessions and itself. Feed what arrives to a store:

```js
const store = new MemoryRevocationStore({ maxEntries: 10000, filter: (st) => iCareAbout(st.identityKey) });
store.onRevocation(({ bytes }) => broadcast(bytes));   // fires once per NEW revocation: forward these
const { status } = await receiveRevocation(bytes, store); // 'added' | 'duplicate' | 'ignored'; throws CredentialError if malformed or mis-signed
```

Revocations are idempotent and may arrive before the certificate. A certificate revocation is dropped once the certificate's own `notAfter` plus 300 s has passed; retirements are kept. The store is bounded: expired entries go first, then the revocation nearest expiry; if it holds only retirements and is full, `add` throws `store-full`. Because anyone can mint identities and sign statements for them, give the store a `filter` that admits only identities you care about on an open network. A store is any object with `add(statement, bytes)` and `isRevoked(identityKey, serial)` (sync or async); a store that throws makes verification fail closed.

**What this does and does not protect.** It limits the damage of a stolen session key to its lifetime and scope, and keeps the identity key off the hot path (so it can sit in a vault or token that prompts the user). Revocation only reaches peers that hear of it: a peer that is offline, partitioned or not forwarding keeps accepting the certificate until it expires, so keep lifetimes short and treat revocation as a way to shorten the tail, not an instant switch. It does not protect against theft of the identity key itself (retiring it needs the identity key, so a thief can race you; there is no recovery or key-rotation chain here), against a compromised page that can ask a signer to sign anything, or against a verifier with a wrong clock beyond the skew. Message signing, replay protection and channel binding remain the transport's job.

**Adoption by other layers.** A peer layer should send the certificate (and a challenge proof) when it introduces a session key, call `verifyPeerCredential(credential, { now, revocations, expectedIdentity })` before trusting any message signed by `sessionKey`, and wire `store.onRevocation` to its broadcast and a new-connection sync (`store.list()`). The wsh transport can use `PodIdentity.fromSigner` to wrap its signer, mint a session per connection with `createSession`, and verify the remote with `verifyPeerCredential`.

### Test Utilities

- `DeterministicRNG` -- seeded RNG for reproducible tests
- `LocalChannel` / `createLocalChannelPair()` -- in-memory transport
- `TestMesh` -- lightweight mesh harness
- `TESTMESH_LIMITS` -- default resource limits for test meshes

## License

MIT
