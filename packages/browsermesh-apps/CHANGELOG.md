# Changelog

## 0.2.0

### Minor Changes

- Wired discovery -> WebRTC signaling -> identity-verified connection (Phase 2). No code in the repo previously instantiated `PeerNode` with real subsystems — only hand-rolled test mocks.

  - `src/signaling.mjs` (new): `MeshSignalingChannel`, a small relay for `{type: 'webrtc-offer'|'webrtc-answer'|'webrtc-ice', from, to, payload}` messages over an injectable transport (works with `BroadcastChannel` in a browser or an `EventEmitterTransport`-shaped bus in Node).
  - `src/webrtc-negotiator.mjs` (new): wires a real `WebRTCMeshManager` + a `MeshSignalingChannel` into the factory shape `MeshTransportNegotiator.registerAdapter('webrtc', factory)` expects, handling both the caller side (offer/answer/DataChannel-open) and the callee side (auto-answer inbound offers), plus bidirectional ICE relay over the signaling channel.
  - `src/mesh-bootstrap.mjs` (new): `createMeshNode(options) => Promise<PeerNode>`, the composition root — builds a real `IdentityWallet`, `PeerRegistry` wired to real `MeshPeerManager`/`TrustGraph`/`MeshACL`, a `DiscoveryManager`, and the WebRTC negotiator above, then boots a real `PeerNode`.

- Wired `MeshSyncEngine` into `PeerNode`'s dispatch bus (Phase 3).

  - `peer-node.mjs`: added `PeerNode.adoptIncomingSession()`, resolving the callee-side session gap Phase 2 left out of scope — callees that only ever answer an inbound offer previously had a real, open transport but no `PeerNode`-level session, so `sendTo()`/`onIncomingData()` didn't work for them.
  - `webrtc-negotiator.mjs`: `createWebRTCTransportFactory()` gains an optional `onIncomingConnection(remotePodId, adapter)` hook, fired once a callee-side auto-answered offer's DataChannel opens.
  - `mesh-bootstrap.mjs`: `createMeshNode()` gains an opt-in `{ enableSync: true }` option that builds a `MeshSyncEngine` (durable `IndexedDBSyncStorage` by default) and attaches it as `node.sync`.
  - `src/mesh-sync.mjs` (new): `MeshSyncBinding` wires a `MeshSyncEngine` to a `PeerNode`'s existing dispatch bus — outbound via `sendTo()`, inbound via `onIncomingData()`, routed by `envelope.type`. `syncDocWithPeer()` sends a document's full state to one peer; `watch()` auto-broadcasts local changes to one or more peers.

- Wired the `MESH` kernel capability to a scoped, `checkAccess`-gated `PeerNode` view (Phase 4). New `src/kernel-mesh.mjs` (`createMeshKernel()`) composes a real `@johnhenry/browsermesh-kernel` `Kernel` with a `PeerNode` as its duck-typed mesh provider, so a kernel tenant granted `KERNEL_CAP.MESH` gets a capability view whose every send/receive is gated by `PeerRegistry.checkAccess()`. `browsermesh-apps` gains a new optional peer dependency on `@johnhenry/browsermesh-kernel`.

- `PeerRegistry.grantCapabilities()`/`revokeCapabilities()` now issue/revoke real `CapabilityToken`s through a `CapabilityValidator` (Phase 5), tracked per peer/scope so revocation has a live target independent of the ACL template's own state. `checkAccess()` now additionally consults live token revocation status (after the existing ACL check passes), so a capability granted then revoked is denied on the very next check — not just once the ACL template happens to be re-read. Peers/scopes granted outside `grantCapabilities()` are governed by the ACL alone, exactly as before — fully additive, no breaking API change.

- `createMeshNode()` already accepted `options.iceServers` and passed it straight to `WebRTCMeshManager`, but bypassed `webrtc.mjs`'s own `mergeIceServers()` extension point (Phase 6). Caller-supplied servers now route through `mergeIceServers()`, so TURN servers are validated and merged alongside the defaults rather than reimplemented ad hoc. Default (no `iceServers` supplied) and explicit `iceServers: []` behave identically to before.

- Added `MeshRelayHost` (`src/mesh-relay-host.mjs`) and `MeshRelayBackend` (`src/mesh-relay-backend.mjs`) (Phase 8), letting one mesh peer share access to a service on its own `VirtualNetwork` with specific, authorized peers over the real WebRTC mesh. Follows `mesh-sync.mjs`'s composition pattern and mirrors `GatewayBackend`'s connect/data/close/multiplex shape, carried as JSON envelopes with base64-encoded byte payloads. Authorization reuses `PeerRegistry`'s existing `grantCapabilities()`/`revokeCapabilities()`/`checkAccess()` with zero API or schema changes. `MeshRelayBackend` extends `@johnhenry/browsermesh-netway`'s `Backend`, so `browsermesh-apps` gains a new optional peer dependency on `@johnhenry/browsermesh-netway`. `mesh-bootstrap.mjs`'s `createMeshNode()` gains an opt-in `{ enableRelayHost, relayHostNetwork, relayHostServices }` option, attaching the host as `node.relayHost`.

- `GradientAggregator.aggregateGPU(device)` dispatches a real WGSL compute shader (`src/gpu-kernel.mjs`, new) instead of the plain-JS `aggregate()` math, with a tested fallback to `aggregate()` when no device is supplied or the flattened gradient buffer exceeds the device's storage-buffer limit; `aggregate()` itself is unchanged. Also fixes a completeness bug: `TrainingOrchestrator.handleGradientPush()` marked jobs `'aggregated'` but never called `aggregate()` at all — the result is now actually computed (via `aggregateGPU()`) and retrievable via the new `getJobResult()`/`getJobStatus().result`. `handleGradientPush()` and `handleMessage()` are now async as a result; the only prior callers were tests.

- `src/index.mjs` did not re-export `mesh-sync.mjs` (`createMeshSync`/`MeshSyncBinding`), unlike every other composition-root file added this cycle (`mesh-bootstrap`, `kernel-mesh`, `mesh-relay-host`/`-backend`). Fixed, alongside a new cross-package integration test (`test/real-peer/full-pipeline.test.mjs`) proving `enableSync`, a kernel-gated mesh capability, and `enableRelayHost` all wired onto the same `PeerNode` at once compose without collision.

## 0.1.1

### Patch Changes

- Peer dependency ranges were all ">=0.0.0", which accepts any version including a future incompatible major. They are now bounded at both ends: at least the version actually required, and below 1.0.0.

  browsermesh-apps declared core, transport and discovery as required peers but never imports any of them at runtime; every reference is a JSDoc type import, and the objects themselves are injected by the caller (discovery and transportNegotiator are optional and guarded at every use; wallet is required but supplied by the consumer, who therefore already has core). Since npm 7 installs peer dependencies automatically, that made installing apps pull in three packages it only needs for types. They are marked optional in peerDependenciesMeta.

## 0.1.0

### Minor Changes

- TimestampProof.verify() is now async. It accepted a verifyFn, documented it, and never called it, so any structurally well-formed proof verified with the confidence the proof asserted about itself. It now checks the authority signature and every witness entry and reports which was checked. Callers must await it.

  TimestampAuthority.verify() verifies through the issuing pod key rather than re-signing with its own, so a proof from another authority can be verified at all rather than reported as tampered.

  AutoMigrator no longer reports a migration it did not perform. It honours the drainPod verdict, takes a resolveWorkload option to supply what should be deployed, and workload names only what actually landed.

  The PeerSession heartbeat timeout can now fire; it was cleared by every ping, so a dead peer was never detected.

## 0.0.1

### Patch Changes

- Port clawser #31's unsigned-payment security fix into `payments.mjs`

  Found during a 2026-08-30 clawser feature audit: clawser's own local copy
  of the payment channel logic (`web/clawser-mesh-payments.js`) had a fix
  for unsigned/forgeable `PaymentUpdate`s and a unilateral `close()`, but
  that file is dead code -- `clawser-pod.js` constructs `PaymentRouter`
  from this published package, not the local copy, so the live app was
  still exposed. Same discovery pattern as `7491e94` (escrow/torrent tool
  bugs): the local "fixed" copy was never actually wired in.

  `PaymentChannel` now accepts an injected `signFn`/`verifyFn` pair (same
  shape as `peer-chat.mjs`'s convention, and compatible with
  `MeshIdentityManager.sign(podId, data)`/`.verify(pubKey, data, sig)`
  from `@johnhenry/browsermesh-core`):

  - `pay()` signs the `PaymentUpdate` it produces when a `signFn` is
    configured.
  - `receive()` verifies an incoming update's signature and rejects
    unsigned/tampered/forged updates when a `verifyFn` is configured.
  - `close()` becomes a two-phase mutual close when signing is active: the
    initiator signs a `CloseClaim`, the counterparty verifies it via the
    new `handleCloseMessage()` and cross-checks it against its own local
    ledger state before co-signing a `CloseAck` (`finalizeClose()` on the
    initiator's side) -- rather than trusting whatever numbers the wire
    message claims. A mismatch or invalid signature raises a
    `PaymentDispute` (`onPaymentDispute()`/`listDisputes()` on both
    `PaymentChannel` and `PaymentRouter`) instead of silently accepting or
    silently closing.

  Fully backward compatible: without an injected `signFn`/`verifyFn`,
  `pay()`/`receive()`/`close()` behave exactly as before (signature stays
  `null`, close stays unilateral and synchronous) -- signing is opt-in via
  the `PaymentChannel`/`PaymentRouter.openChannel()` constructor options,
  not mandatory, since not every consumer of this published package has a
  signing identity available.

## 0.0.0

Extracted from the private `clawser` monorepo and imported into the `@johnhenry` npm scope as part of the browsermesh monorepo consolidation. Previously published unscoped as `browsermesh-apps@0.1.0` (2026-07-17, manual publish, never CI-automated). Per family convention, the version restarts at 0.0.0 on scope import.
