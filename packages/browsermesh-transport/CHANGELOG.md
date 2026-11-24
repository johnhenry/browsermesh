# Changelog

## 0.9.0

### Minor Changes

- 64ac674: `WshServices` can be served to a mesh peer over a protocol channel (wsh 0.50's `@johnhenry/wsh/duplex`), not only through a pipe relay: `services.serveChannel(channel)`, `services.serveOnMesh(service, { protocol })` and, for the dialling side, `connectWshServicesOverMesh(service, peer, credentials)` (the real wsh client, the pod id pinned as the host key, sealed). Off unless called; objects and MCP only, as over a relay. Opening the channel is `protocol:wsh:open` in the registry (default deny); the existing services grants are asked on top; the key that logs in must be the channel's verified peer's own (a login for another key is refused as `not-the-channel-peer`). Nothing is added to the mesh link: `wsh` is one more protocol name.

  `WshServices` now needs `@johnhenry/wsh` 0.50 (it was 0.49): the registry, not a capability named on the key, opens its two channels (`authorizesItself`), so the `mcp:*` capability it used to give every key at wsh's level is gone. The peer range of the package is unchanged (the rest of it still works from 0.45).

### Patch Changes

- 1363a42: Adopt `@johnhenry/wsh` 0.49.0.

  - transport: `WshServices` starts a session (audit, `sessions`, indicator) when wsh reports the session sealed, not at login. A plain client that passes login on the sealed-only host was audited as a session and shown to the person although it was served nothing; now it is only a `refused` audit. The per-tool grants go through wsh's `permits` hook (`mcp-tool` for listing, `mcp-call` for running) instead of a wrapper around the handler, and the duplicate calls-per-minute count is gone (wsh's own bound applies). `WshServices` needs wsh 0.49 or later (the rest of the package still works from 0.45); results carry wsh's `wsh/untrusted` label only. The tests use `@johnhenry/wsh/testing`'s in-process relay; the `wsh-in-process` subpath is unchanged.
  - primitives: no behaviour change. `ssh-keys.mjs` is now run against `@johnhenry/wsh/identity` in a test (valid inputs, strictness cases and the written differences).
  - netway: no behaviour change. `GATEWAY_ERROR` is checked against wsh's exported `GATEWAY_FAIL_TABLE` and its doc says code 5 is a timeout in the Node gateway and "gateway disabled" in the Rust server.

## 0.8.0

### Minor Changes

- 818e4fd: Add `WshServices`: a stock wsh client may use a pod's objects and MCP tools. Off unless the embedder constructs and starts it; it listens at its own rendezvous id, apart from the mesh link host, as a sealed wsh host that serves only the `mcp` and `wsh-objects` rpc channels. A key is admitted only by the pod's registry grants for its pod id (`wsh-services:open`, then `protocol:mcp:open` / `protocol:objects:open`, then per request `mcp:<tool>:list|call` and `objects:<root>:get|call|set|on`); a revocation or an expiry ends the session. The mesh link host is unchanged. Needs `@johnhenry/wsh` 0.48 or later when started.

### Patch Changes

- 8433d52: One conversion between a pod id and a wsh fingerprint, and explicit OpenSSH public key interop (#334).

  primitives: `podIdToFingerprint` / `fingerprintToPodId` (the same 32 bytes in base64url and in hex; strict about length and encoding), `openSSHPublicKeyFromRaw`, `rawPublicKeyFromOpenSSH` (exactly one `ssh-ed25519` key: options, other key types and non-canonical or multi-line input are refused), `podIdFromOpenSSHPublicKey`, `authorizedKeysLine`, and on `PodIdentity` `toOpenSSHPublicKey()` and `toAuthorizedKeysLine({ capabilities, expires, comment })`. `capabilities` is required (an empty list is a key that may do nothing) and characters that could end an option or the line are refused. Nothing calls any of this by default, nothing reads or writes a key file, and only public keys cross (there is no OpenSSH private key parser). See `docs/security.md`, "One key in both worlds".

  transport: `podIdToFingerprint`, `fingerprintToPodId` and `podIdFromRawKey` are no longer implemented here; the names are still exported from the package and are now the primitives functions, so the repository has one conversion. These functions need `@johnhenry/browsermesh-primitives` >= 0.6.0: the peer range must be raised to match in the version bump (it cannot be installed ahead of the release).

  Additive. A `fingerprintToPodId` / `podIdToFingerprint` that was given something that is not a canonical 32 byte value used to accept a non-canonical final base64url character; it is now refused.

- 41c3cad: The optional peer `@johnhenry/wsh` is `>=0.45.0 <1.0.0` instead of `^0.45.0` (#334).

  For a 0.x version `^0.45.0` means 0.45 only, so any current wsh was a peer conflict. The wsh link tests (116) and the sealed link example were run against wsh 0.45.0, 0.46.0, 0.46.1, 0.47.0 and 0.48.0 and pass on each; nothing newer has been tried. No code changed.

## 0.7.0

### Minor Changes

- 4e71bfa: `createMeshNode()` wires the node's identity into its WebRTC connections, so the identity binding proof runs by default: each side proves possession of its pod key over the DTLS fingerprints of the session descriptions it applied, and a signalling server that swaps the descriptions is detected and the connection closed. `requirePeerBinding` is true (nothing a peer sends is delivered before its proof verified). New options: `webrtcIdentityBinding` (default `true`; `false` turns it off), `webrtcAllowUnboundPeers` (default `false`; the named opt-out for interop with peers on transport older than 0.6.0) and `webrtcBindingTimeoutMs` (default 10000).

  A peer that sends no proof (transport older than 0.6.0) is closed after the binding timeout, with the reason `timeout`. The reason now reaches the application: the caller's `connectToPeer()` rejects with `... identity binding failed: timeout` as soon as the connection is closed (it used to wait out the open timeout and say only that the channel did not open), and `PeerNode` emits `peer:binding-failed` (`{ pubKey, transport, connectionId, reason }`) on both sides (new `PeerNode#reportBindingFailure`, new `onBindingFailure` option of `createWebRTCTransportFactory`). Transport: `WebRTCMeshManager#bindingPolicy` reports whether binding is enabled and how it is applied.

  Breaking default: connections between a node from this release and a peer on transport older than 0.6.0 no longer come up unless `webrtcAllowUnboundPeers: true` (or `webrtcIdentityBinding: false`). Peers on 0.6.0 or later already send and check the proof when given an identity, so two nodes from this release interoperate with no configuration. `@johnhenry/browsermesh-apps` now asks for `@johnhenry/browsermesh-transport` `>=0.6.0` as a peer. Verified on a real `RTCPeerConnection` in Chromium and Firefox (see `tests/browser/README.md`); no problem was found in how the DTLS fingerprints are read from real session descriptions.

### Patch Changes

- 505c215: Defaults that still carried the project's earlier name now use `browsermesh`: the default identity's display and full names (the earlier short aliases stay), the embed widget's default container id (`#browsermesh`; an existing `#clawser` element is still found when `#browsermesh` does not exist, and an explicit `containerId` is never replaced) and the channel relay's default sender. The `ChannelRelay` BroadcastChannel name and the discovery SharedWorker name keep their earlier values on purpose, because they are rendezvous points between pages that may run different releases; both are documented in the code.
- 0341de6: Discovery messages (`pod:hello`, `pod:hello-ack`, `pod:goodbye`) are now signed with the same scheme as other pod messages, and a peer list entry exists only for a key that proved itself. A goodbye is honoured only from the peer it names (for the session that said hello), or from the link that peer was on going down. What a relay or signalling server reports about peers (`peers`, `peer-joined`, `peer-left`, a relayed frame's `source`) is a hint of whom to greet: `WebSocketTransport` sends a hello to a hinted pod and any other broadcast only to pods whose signed hello or ack verified (new `verifiedPeers`, `confirmPeer()`, `forgetPeer()`). Peers carry `authenticated` and `sid`.

  Breaking default: over a relay or a custom adapter, an unsigned hello from a pod on 0.2.0 is now refused (counted as `unsigned`), so such a pod no longer joins the peer list or receives broadcasts. Set `allowUnsigned: true` on the newer pod to keep accepting them (listed with `authenticated: false`); same-origin transports keep accepting them by default. Signed hellos are accepted by 0.2.0 pods, which ignore the added fields.

  `@johnhenry/browsermesh-transport`: `WshPodTransport` now hands the pod the goodbye it synthesises when a link goes down under the link's identity (`{ peerId }`), so a pod on this release honours it. A pod on an older release is unaffected.

- 450e5d4: Identifiers that match a response to a request, or name a connection, are now 128 random bits from `crypto.getRandomValues` (apps: mesh-rpc, the routing proxy, orchestrator, compute, agent swarm, verification, timestamp witnesses, swarm join and submit, escrow, chunk replication, torrent, mesh-websocket and mesh-relay connections; transport: stream ids; pod: hosted-pod request ids). There is no `Math.random` or clock-and-counter fallback any more: where the platform has no CSPRNG, creating the id throws an error that says so. The modules that patched `crypto.randomUUID` with a `Math.random` version when it was missing no longer do. Escrow contract and dispute ids are random as well.

  Every response is matched on the peer as well as the id: orchestrator, compute, agent swarm, verification, escrow, swarm join and submit, chunk fetch and "have" answers, timestamp witnesses (a peer that was not asked is not counted) and mesh-websocket sessions (an envelope for a connection id is taken only from the peer at the other end). mesh-rpc, the routing proxy, torrent pieces and manifests, files and terminal already did.

  No wire change: the id is an opaque string to the peer that echoes it. A peer on an older release answers with whatever id it was sent. Ids are no longer of the form `<podId>:<time>:<counter>`; anything that parsed them should not.

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
