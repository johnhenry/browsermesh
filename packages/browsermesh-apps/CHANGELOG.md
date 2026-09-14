# Changelog

## 0.4.0

### Minor Changes

- **BrowserMesh Serverless**: static sites and serverless functions served across mesh peers, adapted from a local `actually-serverless` reference (a single-machine, multi-tab Service Worker proxy) into a real mesh-native equivalent.

  - `src/cloud-storage.mjs`: added `getObject(key) -> {data, contentType, metadata}` and `stat(key) -> {size, contentType, metadata, updatedAt, version}` — the backend's `get`/`head` ops already returned these fields; the public class was discarding everything but raw bytes.
  - `src/serverless-static.mjs` (new): `createStaticHandler({store, indexFile, spaFallback, public, checkAccess})` — static-site serving on a `CloudStorage` bucket: index.html/implicit-directory-index resolution, optional SPA fallback, extension-based content-type guessing, HEAD via `stat()` (no chunk bytes pulled over the mesh). "Public" sites skip the read-access gate entirely at this layer (no wildcard-peer grant primitive exists anywhere in this repo's ACL stack); gated sites take an injected `checkAccess`.
  - `src/serverless-router.mjs` + `src/serverless-fetch.mjs` (new): `createSiteRequestHandler()` chains static → functions → proxy over a dedicated `'mesh-serverless'` `mesh-rpc` envelope type; `createServerlessFetchRouter()` finally gives `@johnhenry/browsermesh-discovery`'s `MeshFetchRouter` its first real caller.
  - `src/serverless-wire.mjs` (new): base64-encodes binary response bodies for the `mesh-rpc` wire hop, matching `cloud-storage-backend.mjs`'s existing chunk-byte convention.
  - `src/serverless-executor-andbox.mjs` + `src/serverless-functions.mjs` (new): `createAndboxExecutor()`, the light/default function-execution backend on `@johnhenry/andbox`'s Worker-isolated JS runtime — one fresh sandbox per invocation, never pooled (concurrent inbound requests are real, and andbox's own Worker-realm sharing plus collateral-timeout hazard makes pooling unsafe). `createFunctionsHandler()` is the backend-agnostic route matcher adapting any `executor(job) -> Promise<result>` into the router.
  - `src/serverless-proxy.mjs` (new): `createProxyHandler({targetOrigin, spaFallback})` — plain `fetch()` reverse proxy to an external URL with SPA fallback, not built on `GatewayBackend` (a different, transport-layer concern).
  - `src/serverless-peer-select.mjs` + `src/serverless-sites.mjs` (new): `selectPeer()`, a pure peer-selection function extracted from `scheduler.mjs`'s own inlined policy switch; `SiteRegistry` tracks which connected, admin-designated peers can serve a given site (mirroring `CloudStorage`'s own `replicaPeers` precedent).

  `andbox` is imported lazily (inside the executor, not a top-level static import) since it's a genuinely separate, not-yet-published package, not a workspace sibling like this package's other optional peer dependencies.

## 0.3.0

### Minor Changes

- **Mesh-native CloudStorage**: a full S3-like, encrypted, replicated object store with no server, built entirely from mesh primitives.

  - `src/mesh-service.mjs` (new): the `MeshService` attach convention (`{name, attach(peerNode, ctx) -> {teardown, api}}`) every service below is built on, plus an observability event bus (`ctx.emit()`/`handle.on()`/`handle.onEvent()`) and async-rejection isolation on `ctx.onIncomingData()` (a throwing/rejecting handler can no longer crash the shared dispatch loop or produce an unhandled rejection).
  - `src/cloud-storage-backend.mjs` (new): local encrypted (AES-256-GCM) object storage — `put`/`get`/`delete`/`list`/`head` over content-addressed, chunked (256KB) ciphertext, backed by `@johnhenry/browsermesh-sync`'s new `IndexedDBChunkStore`.
  - `src/grant-log.mjs` (new): a signed, replicated append-log for multi-peer bucket authorization (`s3:<bucket>:{read,write,delete,list,admin}` scopes), replaying into each peer's own unmodified `PeerRegistry`.
  - `src/key-distribution.mjs` (new): per-recipient encrypted bucket-key delivery on grant, built on `@johnhenry/browsermesh-core`'s existing `wrapKeyForMember()`/`unwrapKeyForMember()` (X25519 ECDH + AES-GCM).
  - `src/manifest-sync.mjs` (new): ACL-gated cross-peer manifest CRDT sync — a remote write is verified against the live `GrantLog` state before it's ever merged, not after.
  - `src/chunk-replication.mjs` (new): real cross-peer chunk push/pull with a `{durability: 'local-only'|'replicated', replicatedTo}` contract — `put()` never blocks or throws on an offline replica.
  - `src/cloud-storage.mjs` (new): the ergonomic `CloudStorage` SDK class composing all of the above behind `put`/`get`/`delete`/`list` plus `grant`/`revoke`/`designateReplica`.
  - `packages/browsermesh-sync/src/storage-indexeddb-chunks.mjs` (new, `browsermesh-sync` package): `IndexedDBChunkStore`, a durable, drop-in-compatible counterpart to the existing in-memory `ChunkStore`.
  - Proven over real WebRTC in `test/real-peer/cloud-storage.test.mjs`, not just mocked transport.

- **`fetch()`/`WebSocket`-shaped mesh access**: familiar Web APIs for reaching mesh-addressable resources.

  - `src/mesh-rpc.mjs` (new): request/response mesh-RPC transport (`createMeshRpcService()`), correlation IDs + timeouts, a clean `501` for an unregistered handler rather than a silent drop.
  - `src/mesh-fetch.mjs` (new): `createBrowserMeshFetch(meshRpcApi)` — a `fetch(url, init)`-shaped function for `mesh://podId/path` addresses, matching real `fetch()`'s reject-on-network-failure/resolve-on-HTTP-error semantics.
  - `src/mesh-websocket.mjs` (new): `BrowserMeshWebSocket`, a persistent duplex channel over the mesh with the standard `WebSocket` instance surface (`readyState`/`onopen`/`onmessage`/`send()`/`close()`), plus `createMeshWebSocketService()` for the accepting side.

- **Mesh-native key-value store and observability**: a second, smaller `MeshService` to prove the pattern generalizes, plus real event visibility.

  - `src/mesh-kv.mjs` (new): `MeshKv`, a small CRDT-backed replicated key-value store — no chunking, no encryption, reusing `GrantLog`'s ACL-gate-before-merge pattern directly.
  - `src/observability-bridge.mjs` (new): gives the previously-dormant `visualizations.mjs` (`TopologySnapshot`/`TrustHeatmap`/`VisualizationExporter`) a real data source — grants, replication activity, and connection events now flow into it live via `ctx.emit()`.

- **Nine previously-unwired application-layer modules wired as real `MeshService`s**, and three more migrated off the dead `PeerSession`/`SessionManager` architecture (now deleted):

  - `src/mesh-timestamp.mjs`, `src/mesh-health.mjs`, `src/peer-routing.mjs` (`createMeshRoutingService`, real multi-hop forwarding), `src/peer-escrow.mjs` (`createEscrowService`), `src/mesh-verification.mjs`, `src/mesh-torrent.mjs`, `src/peer-ipfs.mjs` — all wired for the first time.
  - `src/peer-files.mjs`, `src/peer-chat.mjs`, `src/peer-terminal.mjs` — migrated from the unwired `PeerSession` class onto `MeshService`; `src/peer-session.mjs` deleted entirely once nothing referenced it.
  - `src/mesh-compute.mjs`, `src/mesh-agent-swarm.mjs` — wired with a required, caller-supplied executor (`executeFn`/`agentProxy.chat`) rather than any default remote-code-execution backend.
  - `src/mesh-swarm.mjs` (new): the real SWIM failure-detection algorithm, leader election, and task distribution — `swarm.mjs`'s `SWARM_JOIN`/`SWARM_LEAVE`/`SWARM_HEARTBEAT`/`SWARM_TASK_ASSIGN` constants get their first real use.
  - `src/mesh-hardening.mjs`, `src/mesh-dht.mjs`, `src/mesh-keepalive.mjs` — real transport retry/backoff/failover, DHT peer discovery, and ping/pong liveness detection, all opt-in via `createMeshNode()`.
  - `src/audit.mjs`'s `AuditChain` wired into `createMeshNode({enableAudit})` — real, verifiable signed session audit entries.

- **A minimal, bring-your-own-LLM agent tool-calling runtime**: no LLM SDK dependency added, ever.

  - `src/agent-runtime.mjs` (new): `createAgentRuntime({registry, llmFn})` — a real tool-selection/dispatch loop; `llmFn` is required and caller-supplied (matching `mesh-compute.mjs`'s `executeFn`/`mesh-agent-swarm.mjs`'s `agentProxy` precedent).
  - `src/compat.mjs`: added `BrowserToolRegistry`, referenced in JSDoc across three files for a long time but never actually defined until now.
  - `src/mesh-orchestrator.mjs` (new): `MeshOrchestrator` (pod deploy/drain/discovery across the mesh) wired as a real, `checkAccess()`-gated `MeshService`.
  - `src/mesh-orchestrator-tools.mjs` (new): registers the 8 real `Meshctl*Tool` classes into a `BrowserToolRegistry`, gating risky actions through the service's checked `api`, not the raw class.
  - `src/kernel.mjs`'s `caps.net` (`@johnhenry/browsermesh-kernel`) upgraded from a bare boolean to a real, capability-scoped `ScopedNetwork` view via the new `Kernel#networkFor()`, mirroring `caps.mesh`/`meshFor()`.

### Patch Changes

- Fixed an unhandled-promise-rejection gap in `ctx.onIncomingData()`: it only caught synchronous throws, but every real handler in this package is `async`, so a failing handler could crash the dispatch loop instead of being isolated and logged like every other error path already was.
- Fixed a real open-ack/`onIncomingConnection` ordering race in `BrowserMeshWebSocket`: the accepting side could send its ack before the application had a chance to attach message handlers to the new session, silently losing a fast peer's first message.
- Fixed `FederatedCompute`'s dispatch retry loop continuing to run after `mesh-compute.mjs`'s `teardown()` — added a real `FederatedCompute#destroy()` cancellation path.
- Corrected `peer-ipfs.mjs`'s `IPFSStore` doc claims: it constructs a Helia instance but never actually used it for any storage operation — now documented as mesh-local content-addressed storage, not real IPFS-network interop.

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
