# browsermesh-primitives

Shared primitives for browser mesh networking -- wire format, identity (Ed25519), CRDTs, capabilities, trust model, and ACL engine. Zero dependencies, pure ES modules, runs in browsers and Node.js.

## Install

```bash
npm install browsermesh-primitives
```

Or via CDN:

```html
<script type="module">
  import { PodIdentity, VectorClock, ACLEngine } from 'https://esm.sh/browsermesh-primitives'
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
} from 'browsermesh-primitives'

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
