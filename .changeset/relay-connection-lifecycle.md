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

- `StreamSocket#close(reason)` records why a socket was closed: the reason is readable as `closeReason` on both endpoints (the first reason given is kept) and is carried by `SocketClosedError#reason` on writes that fail afterwards. `close()` without a reason behaves as before. (Byte-level backpressure for `StreamSocket` is described in its own changeset.)
