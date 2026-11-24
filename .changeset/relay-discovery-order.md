---
"@johnhenry/browsermesh-pod": patch
---

Pods now discover each other over `WebSocketTransport` whatever order the server's frames arrive in. The signalling server sends `peers` in a frame after `registered`, so the boot-time `hello` could go out before the pod knew anyone. `TransportDiscovery` now also sends a directed `hello` to each peer the transport newly learns of (`peers`, `peer-joined`), so a pod that was already running greets one that joins later. `WebSocketTransport` gains `onPeerJoined(handler)` for this, and a `protocol: 'signaling'` primary connection now reads `peers` / `peer-joined` / `peer-left` itself. A server that sends both frames at once, or `peers` first, behaves as before; an older peer receives an ordinary `hello` carrying an extra `to` field.
