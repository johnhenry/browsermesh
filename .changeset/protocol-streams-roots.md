---
'@johnhenry/browsermesh-apps': minor
---

Streams and per-root authorisation for layered protocols over a protocol channel (#272).

`createStreamLayer(channel)` (`protocol-stream.mjs`, also `@johnhenry/browsermesh-apps/protocol-stream`) carries a body larger than one message over any protocol channel: a per-stream byte window the receiver grants and the reader returns as it consumes (so a reader that stops reading stops the writer, and the receiver never holds more than a window), `maxStreams` and `maxStreamBytes` limits, cancel from either end or an `AbortSignal`, `authorize(meta, { peer })` before the open is answered, and `sendBody`, `reader.bytes()`, async iteration and web-stream adapters. It is built on `request` and `notify` only, so it runs over the mesh channel and over any hand-written duplex; a stalled stream holds neither the link nor other requests.

`createRootAuthorizer({ protocol, check })` (`protocol-roots.mjs`, also `@johnhenry/browsermesh-apps/protocol-roots`) and `service.api.rootAuthorizer(protocol)` on the protocol service: the scope `<protocol>:<root>:<action>` through `PeerRegistry.checkAccess` for the channel's verified peer, default deny, with `guard()`, `can()`, `assert()`, `allowed()` and `scopes()` helpers.

Additive. Nothing is attached or enabled by default. A peer that does not run the stream layer answers `stream.open` with -32601 and receives nothing else; an older peer never sees a new frame.
