---
"@johnhenry/browsermesh-apps": minor
---

Add `createMeshChannelService()` (`mesh-channel.mjs`, also exported as `@johnhenry/browsermesh-apps/mesh-channel`): a message-oriented duplex channel beside `mesh-rpc` with requests in both directions, notifications, per-request progress and cancel, native `Uint8Array` values, a negotiated maximum message size enforced before a message is assembled, byte-based credit flow control, bounded in-flight requests per peer, close semantics that reject pending requests, and the caller's verified identity handed to every handler. It is negotiated with a version handshake; a peer that does not run it is never sent more than one `hello` and `open()` rejects cleanly. `mesh-rpc` is unchanged apart from its request ids, which now carry a random component (same string shape, one extra colon-separated field).
