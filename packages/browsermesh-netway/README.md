# browsermesh-netway

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-netway.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-netway)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-netway.svg)](LICENSE)

Virtual networking layer with BSD-socket-like abstractions for browser environments. Provides TCP-like streams, UDP-like datagrams, DNS resolution, and capability-based policy enforcement -- all running in-memory or proxied through a remote gateway server.

## Why this exists

Browsers give code no raw sockets and no uniform way to say "this piece of code may only reach the loopback backend, not the open internet." Every mesh-adjacent package that wants to move bytes between execution contexts -- in-memory for tests, proxied through a real `wsh` gateway for actual TCP/UDP/DNS, or intentionally denied by policy -- ends up needing the same `connect`/`listen`/`accept`/`read`/`write` shape and the same capability check in front of it. `browsermesh-netway` exists so that shape is written once: `VirtualNetwork` gives every backend (loopback, gateway-proxied, service-registry-routed, chaos-wrapped) the identical `StreamSocket`/`DatagramSocket`/`Listener` surface, and `PolicyEngine`/`ScopedNetwork` let a caller hand out a network view that's restricted to specific capabilities (`LOOPBACK`, `NET`, `DNS`, `RAW`) without the restricted code ever seeing the difference. It has zero dependencies on the rest of this monorepo -- nothing about "sockets with capability policy" requires identity, CRDTs, or a mesh transport to exist first.

## Used by

`browsermesh-netway` has no hard dependents in this monorepo -- every relationship below is duck-typed, not a real import, by design (so this package stays usable standalone):

- `@johnhenry/browsermesh-kernel`'s `Kernel#networkFor()` is the wired entry point: it wraps a caller-supplied network object (in practice, a `VirtualNetwork`) in a `ScopedNetwork` and hands it to sandboxed tenant code as `caps.net` -- `kernel.mjs`/`caps.mjs` have no static import of this package, so any object shaped like `VirtualNetwork` works, but `browsermesh-netway`'s own `VirtualNetwork`/`ScopedNetwork` are what satisfy that shape in practice.
- `@johnhenry/browsermesh-apps` type-annotates several internals (`CloudStorageBackend`'s private local socket, `MeshRelayHost`/`MeshRelayBackend`) against this package's `VirtualNetwork`/`StreamSocket`/`Backend` types and tunnels real TCP-shaped traffic (e.g. an S3-compatible emulator) through a `GatewayBackend` -- but always receives the network instance from its caller rather than constructing or importing one itself.

## Provenance

Previously maintained as an independent, standalone repository and published to npm, unscoped, as `browsermesh-netway@0.1.1` (initial release `0.1.0`, 2026-03-15), with its own CI already wired up (tests, CodeQL, dependency review). Imported into the `@johnhenry/browsermesh` monorepo via `git subtree` -- preserving its full commit history -- and rescoped to `@johnhenry/browsermesh-netway`; the version restarts at `0.0.0` per family convention.

## Install

```bash
npm install @johnhenry/browsermesh-netway
```

Or via CDN:

```html
<script type="module">
  import { VirtualNetwork } from 'https://esm.sh/@johnhenry/browsermesh-netway';
</script>
```

## Quick Start

```js
import { VirtualNetwork, CAPABILITY } from '@johnhenry/browsermesh-netway';

// Create a network (comes with in-memory loopback for mem:// and loop://)
const net = new VirtualNetwork();

// Listen and connect over the loopback backend
const listener = await net.listen('mem://localhost:8080');
const client   = await net.connect('mem://localhost:8080');
const server   = await listener.accept();

await client.write(new TextEncoder().encode('hello'));
const chunk = await server.read(); // Uint8Array: "hello"

// Scoped policy enforcement
const sandbox = net.scope({ capabilities: [CAPABILITY.LOOPBACK] });
await sandbox.connect('mem://localhost:8080'); // allowed
// sandbox.connect('tcp://example.com:80');    // throws PolicyDeniedError

await net.close();
```

## API Overview

### Constants & Errors

- `DEFAULTS` -- default configuration values
- `CAPABILITY` -- capability tags (`LOOPBACK`, `NET`, `DNS`, `RAW`)
- `GATEWAY_ERROR` -- gateway error codes
- `NetwayError` -- base error class
- `ConnectionRefusedError`, `PolicyDeniedError`, `AddressInUseError`, `QueueFullError`, `UnknownSchemeError`, `SocketClosedError`, `OperationTimeoutError`

### Core Abstractions

- `StreamSocket` -- reliable ordered byte stream (TCP-like), with `createPair()` for paired sockets
- `DatagramSocket` -- unreliable message socket (UDP-like)
- `Listener` -- server-side accept queue for incoming connections

### Policy & Routing

- `PolicyEngine` -- capability-based access control engine
- `Router` -- address parsing and scheme-to-backend dispatch
- `parseAddress(url)` -- parse a URL into `{ scheme, host, port }` components
- `OperationQueue` -- offline operation buffer with deferred drain

### Backends

- `Backend` -- abstract base class for network backends
- `LoopbackBackend` -- in-memory backend for `mem://` and `loop://` schemes
- `GatewayBackend` -- wsh-proxied backend for real TCP/UDP/DNS
- `ServiceBackend` -- `svc://` scheme backend using a service registry
- `ChaosBackendWrapper` -- wraps any backend with fault injection (latency, drops, partitions)
- `FsServiceBackend` -- filesystem service routing backend

### Network

- `VirtualNetwork` -- top-level facade composing all of the above
- `ScopedNetwork` -- capability-restricted view of a `VirtualNetwork`

## License

MIT
