# browsermesh-netway

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fbrowsermesh-netway.svg)](https://www.npmjs.com/package/@johnhenry/browsermesh-netway)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fbrowsermesh-netway.svg)](LICENSE)

Virtual networking layer with BSD-socket-like abstractions for browser environments. Provides TCP-like streams, UDP-like datagrams, DNS resolution, and capability-based policy enforcement -- all running in-memory or proxied through a remote gateway server.

## Why this exists

Browsers give code no raw sockets and no uniform way to say "this piece of code may only reach the loopback backend, not the open internet." Every mesh-adjacent package that wants to move bytes between execution contexts -- in-memory for tests, proxied through a real `wsh` gateway for actual TCP/UDP/DNS, or intentionally denied by policy -- ends up needing the same `connect`/`listen`/`accept`/`read`/`write` shape and the same capability check in front of it. `browsermesh-netway` exists so that shape is written once: `VirtualNetwork` gives every backend (loopback, gateway-proxied, service-registry-routed, chaos-wrapped) the identical `StreamSocket`/`DatagramSocket`/`Listener` surface, and `PolicyEngine`/`ScopedNetwork` let a caller hand out a network view that's restricted to specific capabilities (`TCP_CONNECT`, `TCP_LISTEN`, `UDP_SEND`, `UDP_BIND`, `DNS_RESOLVE`, `LOOPBACK`, or `ALL`) without the restricted code ever seeing the difference. It has zero dependencies on the rest of this monorepo -- nothing about "sockets with capability policy" requires identity, CRDTs, or a mesh transport to exist first.

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
- `CAPABILITY` -- capability tags (`TCP_CONNECT` = `tcp:connect`, `TCP_LISTEN`, `UDP_SEND`, `UDP_BIND`, `DNS_RESOLVE`, `LOOPBACK`, `ALL` = `*`)
- `GATEWAY_ERROR` -- gateway error codes, kept equal to wsh's `GATEWAY_FAIL` (1 `CONNECTION_REFUSED`, 2 `HOST_UNREACHABLE`, 3 `DNS_FAILED`, 4 `POLICY_DENIED`, 5 `GATEWAY_DISABLED`, 6 `CLOSED`, 7 `QUEUE_FULL`, 8 `TIMEOUT`). `GatewayBackend` throws a received 8 as an `OperationTimeoutError`. A received 5 is thrown as a `ConnectionRefusedError` that says "the gateway is disabled, or a timeout from an older gateway": the Rust server sends 5 when its gateway is off, and a Node gateway at wsh 0.51.0 or earlier sent 5 for a timeout
- `NetwayError` -- base error class
- `ConnectionRefusedError`, `PolicyDeniedError`, `AddressInUseError`, `QueueFullError`, `UnknownSchemeError`, `SocketClosedError`, `OperationTimeoutError`

### Core Abstractions

- `StreamSocket` -- reliable ordered byte stream (TCP-like), with `createPair()` for paired sockets. Byte-level backpressure: each direction has a receive window (`createPair({ windowBytes })`, default 256 KiB), `write()` resolves only once the peer's window has taken every byte, and reading returns credit. A reader that never reads stops its writer; `readableLength` / `writableLength` report the bytes held at each side. `end()` is a half-close, `close()` lets the peer read what was already accepted and then see EOF, `destroy(err)` makes the peer's reads reject with `err`, and `readable` / `writable` are Web Streams views. `close(reason)` records why on both endpoints (`closeReason`, and `SocketClosedError.reason` on a write that fails afterwards). A peer with no window (`windowBytes: 0`, or a buffer from before windows) is served as before: `write()` resolves when the chunk is queued and the buffer closes at the chunk cap. `GatewayBackend` sockets use that window in both directions when the host states `gateway-credit` (see "Gateway flow control" below), and a window for the user's writes only against a host that does not.
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
- `GatewayBackend` -- wsh-proxied backend for real TCP/UDP/DNS (TCP and DNS are complete; UDP is send-only, see below)
- `ServiceBackend` -- `svc://` scheme backend using a service registry
- `ChaosBackendWrapper` -- wraps any backend with fault injection (latency, drops, partitions)
- `FsServiceBackend` -- filesystem service routing backend

#### Gateway flow control

wsh meters a gateway connection's data in both directions with `GatewayCredit` when the host states the `gateway-credit`
feature (and the client offers it: wsh's `WshClient` always does): each direction starts with 256 KiB of credit, the
receiver returns credit as its application takes data in, and a sender never has more than the credit it holds in
flight. `GatewayBackend` follows that, on every connection it opens or accepts, and only when
`wshClient.hasFeature('gateway-credit')` is true when the connection is established:

- **Writing to the origin**: the pump sends in frames of at most 64 KiB and only as far as the host's credit allows; a
  `write()` on the socket waits on the socket's own 256 KiB window, which the pump drains as credit arrives. Held at most:
  the window plus the chunk the pump is working on.
- **Reading from the origin**: the socket has a 256 KiB receive window, and credit goes back to the host as bytes are
  taken into that window, which happens as the consumer reads. A consumer that stops reading stops the origin, and what is
  held is at most the window plus the credit granted (`2 x 256 KiB`).
- A wait for credit ends when the host closes the connection, the user destroys the socket, the backend is closed, or the
  client's transport closes (`GatewayBackend` wraps the client's `onClose` if it has one, and calls the handler that was
  there): the write rejects with `SocketClosedError` and reads return `null`. A `close()` (not `destroy()`) on the socket
  lets what it already wrote go out as credit arrives. The failure codes are unchanged (8 is an `OperationTimeoutError`;
  5 is read as "the gateway is disabled, or a timeout from an older gateway").
- **A host that does not state the feature** (or a client object with no `hasFeature()`): nothing new is sent; writes are
  paced by the transport, and data from the host is queued without a window as before, with the socket closed once 1024
  chunks are queued unread. wsh's own hosts then bound what a client makes them hold with byte caps (4 MiB per connection by
  default) and close a connection that exceeds them, so a large transfer against such a host works while the consumer reads.
  This is covered against the mock only, not against a real older host.

#### UDP through the gateway is send-only

`GatewayBackend.sendDatagram` opens a wsh UDP flow, sends the one datagram and closes the flow; a reply is not read, and
there is no `bindDatagram` (it throws, as `Backend.bindDatagram()` does). This is deliberate. A wsh UDP flow is fixed to one
destination and the host drops anything from another address, so it cannot stand for a socket bound to a local port that
hears from anyone; a bound socket would need a flow per peer address (the host allows 16 per client, closes idle ones and
rate-limits them), a lifetime and eviction policy for them, and the WebTransport-datagram form (which `WshClient` handles
itself, not this backend). That is more than a contained change, so it is not done here. `sendDatagram` against a real host
is tested (a datagram reaches a real UDP socket).

### Network

- `VirtualNetwork` -- top-level facade composing all of the above
- `ScopedNetwork` -- capability-restricted view of a `VirtualNetwork`

## License

MIT
