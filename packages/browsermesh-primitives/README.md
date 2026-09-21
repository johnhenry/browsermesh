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

Previously maintained as an independent, standalone repository and published to npm, unscoped, as `browsermesh-primitives@0.1.1` (initial release `0.1.0`, 2026-03-15), with its own CI already wired up (tests, CodeQL, dependency review). Imported into the `@johnhenry/browsermesh` monorepo via `git subtree` -- preserving its full commit history -- and rescoped to `@johnhenry/browsermesh-primitives`; the version restarts at `0.0.0` per family convention.

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
const ok = await PodIdentity.verify(identity.keyPair.publicKey, data, sig)

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

- `PodIdentity` -- Ed25519 key pair with sign/verify
- `derivePodId(publicKey)` -- SHA-256 hash to base64url pod ID
- `encodeBase64url(bytes)` / `decodeBase64url(str)` -- URL-safe base64

### Wire Format

- `messageTypeRegistry` -- extensible registry of message types
- `encodeMeshMessage(msg)` / `decodeMeshMessage(bytes)` -- binary serialization

### Capabilities

- `CapabilityToken` -- scoped capability with expiry
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

### CRDTs

- `VectorClock` -- partial-order logical clock with merge
- `LWWRegister` -- last-writer-wins register with nodeId tiebreak
- `GCounter` -- grow-only counter
- `PNCounter` -- positive-negative counter
- `ORSet` -- observed-remove set (add-wins semantics)
- `RGA` -- replicated growable array (ordered list)
- `LWWMap` -- last-writer-wins map with tombstones

All CRDTs support `merge()`, `toJSON()`, and `fromJSON()` for serialization.

### Test Utilities

- `DeterministicRNG` -- seeded RNG for reproducible tests
- `LocalChannel` / `createLocalChannelPair()` -- in-memory transport
- `TestMesh` -- lightweight mesh harness
- `TESTMESH_LIMITS` -- default resource limits for test meshes

## License

MIT
