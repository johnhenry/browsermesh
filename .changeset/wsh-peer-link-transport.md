---
"@johnhenry/browsermesh-transport": minor
---

Add a wsh peer-link transport: a mesh link carried on a sealed, key-authenticated wsh session (#273).

`WshPeerLinks` makes a pod reachable (a wsh host waiting at the pod's own rendezvous id on a wsh pipe relay) and reaches other pods (a wsh client that pins the host key to the pod id it meant to reach, logs in with the pod's Ed25519 key, seals the session, and opens one named endpoint). The pod id a peer claims must be the hash of the key wsh authenticated, so the sender of every message on a link is that key and never a field of the message. The host decides who may link through an `authorize` callback (default: nobody) and grants the key only the mesh endpoint. Frames are length prefixed with a maximum enforced on the header, sends honour the endpoint's flow control through a bounded queue, a lost link is redialled with backoff, and when two pods dial each other at once exactly one link survives (the one the lower pod id initiated).

- New: `WshPeerLinks`, `WshLink` (a per-peer transport shaped like the other mesh transports), `WshPodTransport` (a `Pod` `TransportAdapter`), `createWshTransportFactory`, `createInProcessPipeRelay` (for tests and examples), `encodeFrame` / `FrameDecoder`, `WshLinkError`, and the pod id / wsh fingerprint conversions.
- `'wsh'` is added to `TRANSPORT_TYPES`. It is not in any default preference order: nothing changes for code that does not ask for it. `MeshTransportNegotiator` takes a `require` option (constructor, or third argument of `negotiate()`): only that adapter is tried and its failure is the failure, so `require: 'wsh'` never falls back to an unsealed transport. `TransportFactory.create('wsh', { links, peerPodId })` returns an unconnected link.
- `MeshWshBridge` converts with the same two functions (no behaviour change for valid input; malformed input now throws a `TypeError`).
- `@johnhenry/wsh` (`^0.45.0`) is an optional peer dependency, imported lazily on first use.

A peer that has no wsh transport is unaffected: it never sees a wsh dial, and two pods without `require` can still link over any other transport they share.
