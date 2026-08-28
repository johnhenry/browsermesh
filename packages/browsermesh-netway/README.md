# browsermesh-netway

Virtual networking layer with BSD-socket-like abstractions for browser environments. Provides TCP-like streams, UDP-like datagrams, DNS resolution, and capability-based policy enforcement -- all running in-memory or proxied through a remote gateway server.

## Install

```bash
npm install browsermesh-netway
```

Or via CDN:

```html
<script type="module">
  import { VirtualNetwork } from 'https://esm.sh/browsermesh-netway';
</script>
```

## Quick Start

```js
import { VirtualNetwork, CAPABILITY } from 'browsermesh-netway';

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
