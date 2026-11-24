---
"@johnhenry/browsermesh-apps": minor
"@johnhenry/browsermesh-netway": minor
---

Relayed connections end with the permission that allowed them, and hold a bounded amount of memory.

`@johnhenry/browsermesh-apps`:

- `MeshRelayHost` closes a peer's open connections, in both directions and with a reason, when the registry announces an access change (new `PeerRegistry#onAccessChange()` / `notifyAccessChange()`, fired by `revokeCapabilities()`, `removePeer()` and `updatePermissions()`), on `recheck()`, and every `recheckIntervalMs` (default 30000, `0` disables). `hideService()` and `detach()` close the matching connections; a connect that completes after `detach()`, a hidden service or a revocation is not acknowledged and its socket is closed.
- Byte credit per connection (`highWaterBytes` 262144, `lowWaterBytes` 65536), a cap on unconsumed bytes per connection (`maxBufferedBytesPerConnection` 1048576) and per peer (`maxBufferedBytesPerPeer` 4194304), `maxConnectionsPerPeer` 16 and `maxFrameBytes` 65536, all options of `MeshRelayHost` (and, for the first four, `createMeshRelayBackend()`); `createMeshNode({ relayHostOptions })` passes them on. `host.stats()` / `backend.stats()` report buffered and in-flight bytes. A close sent for any of these reasons carries a `reason`, shown to the client as `socket.closeReason`.
- Wire additions, all optional fields or new frames an older peer ignores: `window` on `connect` and `ok`, `credit` frames (sent only to a peer that advertised a window), `reason` on `close`. An older peer is held to the byte caps and is never paused.
- `createMeshNode()` option `relayHostOptions`.

`@johnhenry/browsermesh-netway`:

- `StreamSocket` has byte-level backpressure (issue #267): `write()` stays pending while `highWaterBytes` (default 1 MiB) are queued unread and continues at `lowWaterBytes`; a queue past `maxBufferedBytes` (default 4 MiB) or `highWaterMark` chunks closes the socket with a reason. New `close(reason)`, `closeReason`, `bufferedInbound`, `bufferedOutbound`, `STREAM_DEFAULTS`; `SocketClosedError` carries `reason`. A write made while a very large amount is already queued now waits instead of returning at once.
