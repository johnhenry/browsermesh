---
"@johnhenry/browsermesh-transport": minor
---

- `iceTransportPolicy` (`'all' | 'relay'`) is now accepted by `WebRTCPeerConnection`, `WebRTCMeshManager`, `WebRTCTransport` and `TransportFactory` and forwarded to `RTCPeerConnection`, so TURN-only pods never gather host or server-reflexive candidates. `'relay'` without a `turn:`/`turns:` server throws at construction. New exports `hasTurnServer()` and `resolveIceTransportPolicy()`.
- `WebSocketTransport` gains opt-in `padding` (size-bucketed binary frames, both ends must enable it) and `jitterMs` (random per-send delay, order preserved). Both default off.
- `padding` needs `@johnhenry/browsermesh-primitives` >= 0.3.0 and throws a clear error otherwise; the peer range is unchanged.
