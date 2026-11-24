# Changelog

## 0.6.0

### Minor Changes

- 404e5be: Optional identity binding for WebRTC connections. Pass `identity` (a `PodIdentity`) to `WebRTCPeerConnection` or `WebRTCMeshManager` and each side proves possession of its pod key, on the control data channel, over a transcript of both pod ids and the DTLS fingerprints of both session descriptions. The proof's key must hash to the pod id claimed in signalling. The connection is `connected` and accepts application messages only after the peer's proof verifies; a failing proof closes the connection and is reported through `onError()` (`bindingFailure`). A peer that sends no proof is closed after `bindingTimeoutMs` (default 10000) unless `requirePeerBinding: false`. New exports from `identity-binding.mjs`: `extractDtlsFingerprints`, `bindingTranscript`, `createBindingProof`, `verifyBindingProof`.

  Nothing changes without `identity`. An older peer receiving the proof sees one extra `mesh:bind` JSON message on the control channel. Verified with an in-memory duplex and fixed vectors, not over a real browser `RTCPeerConnection` (issue #270).

- ee77776: Add a wsh peer-link transport: a mesh link carried on a sealed, key-authenticated wsh session (#273).

  `WshPeerLinks` makes a pod reachable (a wsh host waiting at the pod's own rendezvous id on a wsh pipe relay) and reaches other pods (a wsh client that pins the host key to the pod id it meant to reach, logs in with the pod's Ed25519 key, seals the session, and opens one named endpoint). The pod id a peer claims must be the hash of the key wsh authenticated, so the sender of every message on a link is that key and never a field of the message. The host decides who may link through an `authorize` callback (default: nobody) and grants the key only the mesh endpoint. Frames are length prefixed with a maximum enforced on the header, sends honour the endpoint's flow control through a bounded queue, a lost link is redialled with backoff, and when two pods dial each other at once exactly one link survives (the one the lower pod id initiated).

  - New: `WshPeerLinks`, `WshLink` (a per-peer transport shaped like the other mesh transports), `WshPodTransport` (a `Pod` `TransportAdapter`), `createWshTransportFactory`, `createInProcessPipeRelay` (for tests and examples; the `@johnhenry/browsermesh-transport/wsh-in-process` subpath, kept out of the main entry so browser bundles do not follow it into wsh's Node-only relay listener), `encodeFrame` / `FrameDecoder`, `WshLinkError`, and the pod id / wsh fingerprint conversions.
  - `'wsh'` is added to `TRANSPORT_TYPES`. It is not in any default preference order: nothing changes for code that does not ask for it. `MeshTransportNegotiator` takes a `require` option (constructor, or third argument of `negotiate()`): only that adapter is tried and its failure is the failure, so `require: 'wsh'` never falls back to an unsealed transport. `TransportFactory.create('wsh', { links, peerPodId })` returns an unconnected link.
  - `MeshWshBridge` converts with the same two functions (no behaviour change for valid input; malformed input now throws a `TypeError`).
  - `@johnhenry/wsh` (`^0.45.0`) is an optional peer dependency, imported lazily on first use.

  A peer that has no wsh transport is unaffected: it never sees a wsh dial, and two pods without `require` can still link over any other transport they share.

- a81ccac: Wire the sealed wsh peer link through the peer layer (#273).

  - `createMeshNode({ wsh: { relays, ... } })` opts a node in (off unless given). The node's own identity is the wsh identity, a peer may link to it only if the registry grants `mesh:link:connect` (override with `wsh.authorize`), and `node.connectToPeer(podId, { wsh: podId })` reaches a peer. The listening side's inbound link is adopted as a `PeerNode` session under the pod id derived from the key wsh authenticated, so `fromPubKey` is that key and mesh-rpc, mesh-sync, mesh-relay and every other service run over it unchanged. `wsh.require: true` makes wsh the only transport `connectToPeer()` uses; a failed wsh link is then a failed connect.
  - New exports: `createWshAuthorizer(registry)`, `createWshAdapterFactory(links)`, `attachWshLinks({ node, links, negotiator })`, `WSH_LINK_RESOURCE`, `WSH_LINK_ACTION`.
  - `PeerNode.connectToPeer()` rethrows a negotiation failure when its negotiator was told to require a transport (`MeshTransportNegotiator` `require`), instead of falling through to a session with no transport. Without `require` nothing changes.
  - `MeshTransportNegotiator` gains a `required` getter (the transport type it was told to require, or `null`); `createHardenedNegotiator()` forwards it.

### Patch Changes

- 0504296: When a WebRTC connection fails and no ICE servers are configured, log a one-time note explaining that only host candidates were tried and how to supply `iceServers` (or opt in to `PUBLIC_STUN_SERVERS`). The README now documents why no third-party STUN server is used by default. The default itself (no ICE servers) is unchanged.
- 15d5f74: File headers, comments, log tags, READMEs and examples no longer carry the name of the private monorepo this code was extracted from. No behaviour change, with these naming additions: `BrowsermeshEmbed` is the primary export of `@johnhenry/browsermesh-embed` and `ClawserEmbed` stays as a deprecated alias; the debug switch is now the `browsermesh_debug` localStorage key and the `[browsermesh:silent-catch]` console prefix, and the old `clawser_debug` key still works as a deprecated alias.

## 0.5.1

### Patch Changes

- f7837d6: Preserve FIFO delivery when jitter timer callbacks fire out of order under load. Readiness now drains a send queue rather than allowing each timer to send independently; closing clears the queue and all timers.

## 0.5.0

### Minor Changes

- 6c85935: Multiple named data channels over one negotiated WebRTC connection (#115). `WebRTCPeerConnection#openChannel(name, { ordered, maxRetransmits, maxPacketLifeTime })`, `closeChannel(name)` and `channels` add independent SCTP streams (no new ICE/DTLS handshake); `send(data, { channel: name })` addresses them (no fallback to control for an unknown or closed name), the remote adopts them automatically, and `onMessage` callbacks receive the channel name as a second argument. `WebRTCTransportAdapter` forwards these, and `PeerNode.sendTo` / `broadcast` accept a named channel the session's transport has opened. Open named channels only to peers on a build that has this: older builds adopt an unrecognised label as their control channel.

## 0.4.1

### Patch Changes

- 38a87ce: Raise the `@johnhenry/browsermesh-primitives` peer range to `>=0.3.0 <1.0.0` and import `padTo` / `unpad` by name. Padding (primitives 0.3.0) no longer needs a runtime "primitives too old" check; an older primitives is now rejected by the peer range instead (#231). Also makes the `TransportHealthCheck` and `startAutoSync` tests deterministic with mock timers (#232).
- 03989a4: Fix three-pod meshes where one link came up one-way and a pod ended with no sessions (#224). `WebRTCTransport` now acts only on answers and ICE candidates from its own remote peer, applies an answer once, and unsubscribes from the shared signaler when it closes; before, every in-flight negotiation on a pod applied every peer's answer to its own `RTCPeerConnection`. `SignalingClient#on`, `onOffer`, `onAnswer` and `onIceCandidate` now return an unsubscribe function (they returned `undefined`). A signaler that does not report who a message is from keeps working unchanged.

## 0.4.0

### Minor Changes

- 774e86e: - `iceTransportPolicy` (`'all' | 'relay'`) is now accepted by `WebRTCPeerConnection`, `WebRTCMeshManager`, `WebRTCTransport` and `TransportFactory` and forwarded to `RTCPeerConnection`, so TURN-only pods never gather host or server-reflexive candidates. `'relay'` without a `turn:`/`turns:` server throws at construction. New exports `hasTurnServer()` and `resolveIceTransportPolicy()`.
  - `WebSocketTransport` gains opt-in `padding` (size-bucketed binary frames, both ends must enable it) and `jitterMs` (random per-send delay, order preserved). Both default off.
  - `padding` needs `@johnhenry/browsermesh-primitives` >= 0.3.0 and throws a clear error otherwise; the peer range is unchanged.

## 0.3.3

### Patch Changes

- 14485f6: Fixes browsermesh#208. `WebRTCTransport`, `WebSocketTransport` and `WebTransportTransport` (in `websocket.mjs`) handed whatever they were given straight to the platform. `RTCDataChannel.send()` and `WebSocket.send()` only take a string or binary, and silently turn anything else into the text `"[object Object]"`, so every envelope object `PeerNode.sendTo()` and every `MeshService` sent over a real session arrived as garbage.

  `send()` on those three classes now sends strings and binary unchanged and any other value as its JSON text, the same rule `WebRTCPeerConnection.send()` already followed. `WebRTCPeerConnection.send()` uses the same helper, so it no longer turns an `ArrayBuffer` or typed array into `"{}"`.

  The rule is exported as `encodeWireData()` (with `isWireNative()`) so a custom transport can follow it. It throws a `TypeError` for a value with no JSON form (`undefined`, a function) instead of sending the text `"undefined"`.

## 0.3.2

### Patch Changes

- Peer range on `@johnhenry/browsermesh-primitives` is now `>=0.2.0 <1.0.0`, so it no longer admits primitives 0.1.x, whose `PodIdentity.verify` takes `(publicKey, data, signature)`.

## 0.3.1

### Patch Changes

- Part of browsermesh#183: removed an internal engineering note that had
  leaked into `MeshWshBridge`'s (`src/wsh-bridge.mjs`) published source
  comments -- it referenced an unrelated private codebase by name and
  included internal implementation-status notes not appropriate for a
  public package. Two stale, non-existent relative type-import paths in the
  same file's JSDoc (pointing at files that don't exist in this repo) were
  also fixed to plain `{*}` annotations, matching the constructor's own
  untyped parameters -- this package doesn't depend on `@johnhenry/wsh` or
  `@johnhenry/browsermesh-core`, so a concrete type import was never
  resolvable here anyway. No behavior change; `MeshWshBridge`'s actual
  technical documentation (the hex/base64url key-format bridging it does)
  is preserved, just rewritten without the leaked references.

## 0.3.0

### Minor Changes

- 6ba7b98: Multiple independent connections per peer (issue #116). Previously `WebRTCMeshManager.connectToPeer()` hard-deduped by `remotePodId` alone, so a peer already connected to could never get a second, independently-negotiated `RTCPeerConnection` -- and `PeerNode`, `webrtc-negotiator.mjs`'s signaling correlation, and `mesh-hardening.mjs`'s per-peer retry/failover/metrics scoping all assumed the same one-connection-per-peer shape.

  All of that is now additive and opt-in via a `connectionId` (defaults to `'default'`, so every existing call site is unaffected):

  - `WebRTCMeshManager.connectToPeer(remotePodId, { connectionId })` opens (or returns) an independent `RTCPeerConnection`, with its own ICE/STUN/DTLS negotiation and its own reconnect backoff. New `getConnectionsFor()`; `getConnection()`, `hasConnection()`, `listConnections()`, `closePeer()`, `broadcast()`, `getAllConnectionStats()` all became connectionId-aware.
  - `webrtc-negotiator.mjs` and `signaling.mjs` thread `connectionId` through the offer/answer/ICE exchange so two concurrent negotiations with the same peer never cross-route an answer or candidate.
  - `PeerNode.connectToPeer()`/`adoptIncomingSession()` tag the session they create with `connectionId`; `sendTo()`/`hasActiveSession()` accept an optional `connectionId` to address a specific one instead of always falling back to "most recently created". New `PeerNode.sessionsFor(pubKey)`.
  - `mesh-hardening.mjs`'s `endpointsKey(endpoints, auth)` folds `auth.connectionId` into its key. Without this fix a second `connectToPeer()` call with a different `connectionId` silently reused the first call's cached `TransportFailover` and reconnected _that_ connection instead of ever negotiating its own -- a real bug on the hardened path, not just a missing feature.
  - `@johnhenry/browsermesh-core`'s `ConnectionPool.add(peerId, transport, { purpose })` / `acquire(peerId, { purpose, select })` gained a real selector, answering the issue's second open question ("no way to request 'the connection for purpose X'").

## 0.2.0

### Minor Changes

- `WebRTCPeerConnection` (webrtc.mjs) and `WebRTCTransport` (websocket.mjs) now open a second `RTCDataChannel` (`'mesh-bulk'`, unordered but reliable) alongside the original `'mesh'` channel, on the SAME already-negotiated `RTCPeerConnection` -- a second SCTP stream, not a second ICE/DTLS handshake. Previously every kind of traffic (chat, file transfer, sync, agent RPC, consensus votes) shared the one `'mesh'` channel, so a large file-transfer chunk queued on it blocked every other message's delivery order behind it.

  `send(data, { channel })` is the new opt-in: `'control'` (default, unchanged behavior for every existing call site) or `'bulk'`. New `isBulkOpen` getter.

  No version negotiation was added, and none is needed: reads are channel-agnostic (a message fires the same `onMessage`/`'message'` callbacks regardless of which channel it arrived on) and a `'bulk'` send silently falls back to the control channel when the bulk channel doesn't exist -- which is exactly what happens when the remote peer is running an older, single-channel build. Verified against real `RTCPeerConnection`s in both skew directions (old offerer/new answerer, and new offerer/old answerer) in `test/real-peer/dual-channel.test.mjs`.

## 0.1.1

### Patch Changes

- Peer dependency ranges were all ">=0.0.0", which accepts any version including a future incompatible major. They are now bounded at both ends: at least the version actually required, and below 1.0.0.

  browsermesh-apps declared core, transport and discovery as required peers but never imports any of them at runtime; every reference is a JSDoc type import, and the objects themselves are injected by the caller (discovery and transportNegotiator are optional and guarded at every use; wallet is required but supplied by the consumer, who therefore already has core). Since npm 7 installs peer dependencies automatically, that made installing apps pull in three packages it only needs for types. They are marked optional in peerDependenciesMeta.

## 0.1.0

### Minor Changes

- DEFAULT_ICE_SERVERS is now empty. It was Google STUN, so every pairing attempt disclosed the device public IP to a third party, and mergeIceServers([]) returned Google anyway. Anyone relying on the default for NAT traversal must now configure a STUN or TURN server explicitly.

  state gains a failed value. A remotely-failed handshake reports failed in every browser and never closed (measured on WebKit, Chromium 153, Firefox 155), and only the closed branch moved the state, so a dead connection reported connecting forever with isOpen never going false.

  Remote ICE candidates arriving before the remote description are now held and applied instead of discarded. A peer gathers in 1-2ms while an answer crosses a signaling server, so on a real network that was all of them.

  The relay client re-announces its capabilities after an auto-reconnect, so a peer does not silently become undiscoverable after a transient drop.

## 0.0.0

Extracted from the private `clawser` monorepo and imported into the `@johnhenry` npm scope as part of the browsermesh monorepo consolidation. Previously published unscoped as `browsermesh-transport@0.1.0` (2026-07-17, manual publish, never CI-automated). Per family convention, the version restarts at 0.0.0 on scope import.
