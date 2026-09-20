# Changelog

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
