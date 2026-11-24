# What is protected today: relayed connections

Part of the "what is protected today" notes (tracking issue: #269). "Peer key"
means the key of the session a message arrived on, as reported by the
transport, never a field of the message.

## `MeshRelayHost` / `createMeshRelayBackend` (`@johnhenry/browsermesh-apps`)

Protected:

- A connection is accepted only if
  `PeerRegistry.checkAccess(peerKey, 'mesh-relay:<service>', 'connect')`
  allows it, and it ends when that stops being true: on a registry access
  change (revocation, peer removal, permission update), on `recheck()`, and on
  an interval (default 30 s). A service that is hidden or a host that is
  detached ends its connections too. Both directions stop at once and the peer
  is told why.
- Bytes buffered for a connection are bounded: credit-based pausing of the
  fast side, per-connection and per-peer caps on unconsumed bytes, a per-peer
  connection limit, and a close with a reason when a cap is passed. Defaults
  are in the package README.

Not protected:

- Relayed bytes are carried as base64 in JSON envelopes and are readable by
  any peer that forwards them; there is no end-to-end encryption.
- An open connection is not re-checked per packet; the delay between a change
  and its effect is the time to run the re-check (immediate for registry
  events, up to the interval for expiry).
- Sessions accepted by `createMeshWebSocketService` follow the `onConnection`
  hook the application gives it; this service does not re-check them.

## `StreamSocket` (`@johnhenry/browsermesh-netway`)

Bytes queued per direction are bounded and a fast writer waits for a slow
reader (see the package README). Nothing is dropped; a queue past its hard cap
closes the socket and records why.
