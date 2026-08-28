# Changelog

## 0.1.0 (2026-03-15)

Initial release.

- TCP-like `StreamSocket` with bidirectional byte streams and backpressure
- UDP-like `DatagramSocket` for unreliable message passing
- `Listener` with server-side accept queue
- `PolicyEngine` with capability-based access control (`LOOPBACK`, `NET`, `DNS`, `RAW`)
- `Router` for address parsing and scheme-to-backend dispatch
- `OperationQueue` for offline operation buffering with deferred drain
- `LoopbackBackend` for in-memory networking (`mem://`, `loop://`)
- `GatewayBackend` for real TCP/UDP/DNS via wsh proxy
- `ServiceBackend` for `svc://` scheme routing to named services
- `ChaosBackendWrapper` for fault injection testing
- `FsServiceBackend` for filesystem service routing
- `VirtualNetwork` facade composing all abstractions
- `ScopedNetwork` for sandboxed capability-restricted network views
