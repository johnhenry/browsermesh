# Changelog

## 0.3.0

### Minor Changes

- bfc4133: Follow wsh 0.52.0's numbering of the gateway failure codes. In netway's `GATEWAY_ERROR`, `TIMEOUT` is now `8` and
  `GATEWAY_DISABLED: 5` is new (the rest are unchanged: 1 to 4, `CLOSED` 6, `QUEUE_FULL` 7). `GatewayBackend` throws a
  received 8 as an `OperationTimeoutError`, like its own operation timeout. A received 5 is read as "the gateway is
  disabled, or a timeout from an older gateway" and its `ConnectionRefusedError` says so, because the Rust server has
  always sent 5 for a disabled gateway and a Node gateway at wsh 0.51.0 or earlier sent 5 for a timeout. netway itself
  sends no failure code. Compatibility: a netway peer on the previous version reads an 8 from a gateway as a code it does
  not know (it throws a `ConnectionRefusedError` with the host's message and `(code: 8)`, no more), and a peer on the
  previous version, and a gateway at 0.51.0 or earlier, still use 5 for a timeout, which the new version reads as
  described above (netway has no code of its own to send, so the only senders are gateways).
  `browsermesh-mcp`, `browsermesh-objects` and `browsermesh-transport` are tested against wsh 0.52.0 (documentation only).

## 0.2.1

### Patch Changes

- 1363a42: Adopt `@johnhenry/wsh` 0.49.0.

  - transport: `WshServices` starts a session (audit, `sessions`, indicator) when wsh reports the session sealed, not at login. A plain client that passes login on the sealed-only host was audited as a session and shown to the person although it was served nothing; now it is only a `refused` audit. The per-tool grants go through wsh's `permits` hook (`mcp-tool` for listing, `mcp-call` for running) instead of a wrapper around the handler, and the duplicate calls-per-minute count is gone (wsh's own bound applies). `WshServices` needs wsh 0.49 or later (the rest of the package still works from 0.45); results carry wsh's `wsh/untrusted` label only. The tests use `@johnhenry/wsh/testing`'s in-process relay; the `wsh-in-process` subpath is unchanged.
  - primitives: no behaviour change. `ssh-keys.mjs` is now run against `@johnhenry/wsh/identity` in a test (valid inputs, strictness cases and the written differences).
  - netway: no behaviour change. `GATEWAY_ERROR` is checked against wsh's exported `GATEWAY_FAIL_TABLE` and its doc says code 5 is a timeout in the Node gateway and "gateway disabled" in the Rust server.

## 0.2.0

### Minor Changes

- 9aadc63: apps: `channelAdvertisement()`, `readChannelAdvertisement()`, `advertisedProtocolSupport()` and `peerSupportsFromAdvertisements()` (`@johnhenry/browsermesh-apps/channel-advertisement`) let a peer say, and another learn without a handshake, that it runs the message channel and which layered protocols and versions it serves; a peer that advertises nothing is still tried. netway: `new VirtualNetwork({ maxBufferedBytes })` caps the bytes held unread or unsent by the sockets its `connect()` handed out and refuses new connections with `BufferLimitError` (`ENOBUFS`) while it is reached; off by default.

### Patch Changes

- ffeae5f: A JSON message that arrives in window-sized pieces is now reassembled with a bound and parsed once: `readJsonMessage` (apps) and `FsServiceBackend` (netway) scan the bytes they already hold and parse when the document is balanced instead of after every piece, and refuse a message larger than `maxBytes` (default 16 MiB, `maxMessageBytes` option on `FsServiceBackend` and the cloud-storage backend) with an error reply and a closed connection. The wire format is unchanged, so an older peer is served as before.

## 0.1.0

### Minor Changes

- b07934f: `StreamSocket` now has byte-level backpressure. Each direction has a receive window (`createPair({ windowBytes })`, default 256 KiB): `write()` resolves only once the peer's window has taken every byte, reading returns credit, and the data held on each side is bounded (`readableLength` / `writableLength` report it). New: `end()` (half-close), `destroy(err)`, `windowBytes` / `peerWindowBytes`, and `readable` / `writable` Web Streams views. A peer with no window (`windowBytes: 0`, or a buffer from before windows) is served as before; `GatewayBackend` does not window data arriving from the wire.

  Behaviour changes for existing callers: a `write()` to a reader that does not read now stays pending once the window is full (before, it returned at once and the socket closed after 1,024 queued chunks); and `close()` now lets the peer read what it had already been given before it sees EOF (before, the peer's unread data was discarded). Code that wrote more than the window before reading must read concurrently, or pass `windowBytes: 0` for the old behaviour. Also, a write larger than the window now reaches the reader in window-sized pieces: code that treats one `read()` as one message (for example a JSON request over a socket) must reassemble across reads, or pass `windowBytes: 0`.

- 171ba28: Relayed connections end with the permission that allowed them, and hold a bounded amount of memory.

  `@johnhenry/browsermesh-apps`:

  - `MeshRelayHost` closes a peer's open connections, in both directions and with a reason, when the registry announces an access change (new `PeerRegistry#onAccessChange()` / `notifyAccessChange()`, fired by `revokeCapabilities()`, `removePeer()` and `updatePermissions()`), on `recheck()`, and every `recheckIntervalMs` (default 30000, `0` disables). `hideService()` and `detach()` close the matching connections; a connect that completes after `detach()`, a hidden service or a revocation is not acknowledged and its socket is closed.
  - Byte credit per connection (`highWaterBytes` 262144, `lowWaterBytes` 65536), a cap on unconsumed bytes per connection (`maxBufferedBytesPerConnection` 1048576) and per peer (`maxBufferedBytesPerPeer` 4194304), `maxConnectionsPerPeer` 16 and `maxFrameBytes` 65536, all options of `MeshRelayHost` (and, for the first four, `createMeshRelayBackend()`); `createMeshNode({ relayHostOptions })` passes them on. `host.stats()` / `backend.stats()` report buffered and in-flight bytes. A close sent for any of these reasons carries a `reason`, shown to the client as `socket.closeReason`.
  - Wire additions, all optional fields or new frames an older peer ignores: `window` on `connect` and `ok`, `credit` frames (sent only to a peer that advertised a window), `reason` on `close`. An older peer is held to the byte caps and is never paused.
  - `createMeshNode()` option `relayHostOptions`.

  `@johnhenry/browsermesh-netway`:

  - `StreamSocket#close(reason)` records why a socket was closed: the reason is readable as `closeReason` on both endpoints (the first reason given is kept) and is carried by `SocketClosedError#reason` on writes that fail afterwards. `close()` without a reason behaves as before. (Byte-level backpressure for `StreamSocket` is described in its own changeset.)

### Patch Changes

- b07934f: The JSON request/response sockets (`CloudStorageBackend` / `CloudStorage`, and netway's `FsServiceBackend`) no longer assume one `read()` is one message. A socket with a receive window hands a write larger than the window to its reader in window-sized pieces, so these readers now reassemble a message across pieces before parsing it; objects and files over 256 KiB round-trip again.
- 9f75c48: README: the capability tags it lists now match `CAPABILITY` in `constants.mjs` (`TCP_CONNECT`, `TCP_LISTEN`, `UDP_SEND`, `UDP_BIND`, `DNS_RESOLVE`, `LOOPBACK`, `ALL`).

## 0.0.1

### Patch Changes

- Documentation only: `policy.mjs`/`virtual-network.mjs` now document that `VirtualNetwork.scope()`/`ScopedNetwork` finally has a real caller — `@johnhenry/browsermesh-kernel`'s `Kernel#networkFor()` uses it to hand sandboxed tenant code a real, capability-scoped `caps.net` view (previously a bare boolean). No code/behavior change in this package; `.scope()`'s own logic is unmodified.

## 0.0.0

Imported into the `@johnhenry` npm scope as part of the browsermesh
monorepo consolidation. Previously published unscoped as
`browsermesh-netway@0.1.1`. Per family convention, the version restarts at
0.0.0 on scope import — see the README's Provenance section.

## 0.1.1 (unreleased entry, retroactively documented)

- Minimum Node.js bumped to 24.
- Added CodeQL and dependency-review CI workflows.

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
