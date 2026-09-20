/**
 * mesh-bootstrap.mjs -- composition root for a real, connected PeerNode.
 *
 * This is the file the rest of the audit found missing: nothing anywhere in
 * the repo instantiates `PeerNode` with real `IdentityWallet` /
 * `PeerRegistry` / `DiscoveryManager` / `MeshTransportNegotiator`
 * implementations -- only hand-rolled test mocks. `createMeshNode()` does
 * exactly that wiring, using:
 *   - `IdentityWallet` + `MeshIdentityManager` from `@johnhenry/browsermesh-core`
 *     for a real Ed25519 identity.
 *   - `PeerRegistry` (this package) wired to real `MeshPeerManager` /
 *     `TrustGraph` / `MeshACL` from `@johnhenry/browsermesh-core`.
 *   - `DiscoveryManager` from `@johnhenry/browsermesh-discovery`, with
 *     whatever `DiscoveryStrategy` instances the caller supplies (default:
 *     `BroadcastChannelStrategy`, browser-only -- see below).
 *   - `MeshTransportNegotiator` + `WebRTCMeshManager` from
 *     `@johnhenry/browsermesh-transport`, wired through this package's own
 *     `signaling.mjs` / `webrtc-negotiator.mjs`.
 *
 * **Discovery is browser-only by default.** `BroadcastChannelStrategy`
 * requires a global `BroadcastChannel`, which Node does not have. Rather
 * than inventing a new Node-only discovery mechanism, callers running
 * outside a browser (tests, this package's own integration suite) pass
 * `discoveryStrategies` explicitly -- `ManualStrategy` from
 * `@johnhenry/browsermesh-discovery` is the existing, real, Node-safe
 * strategy that fits (peers are added explicitly rather than found via a
 * browser API), the same way the existing Pod example
 * (`examples/02-two-pods-discover-and-message.mjs`) injects an
 * `EventEmitterTransport` instead of relying on a browser transport.
 *
 * **Signaling has no default at all** -- `signalingTransport` must always be
 * supplied. There is no in-repo precedent for a "default" signaling bus the
 * way there is for discovery, and guessing one (e.g. silently reaching for
 * `BroadcastChannel`) would hide a real infrastructure decision (which bus
 * carries offer/answer/ICE traffic) behind a default that only works in one
 * environment. `createBroadcastChannelSignalingTransport()` (signaling.mjs)
 * is the ready-made browser option; tests supply a Node-safe bus (see
 * `test/mesh-bootstrap.test.mjs`).
 *
 * **CRDT sync is opt-in via `{ enableSync: true }`** (Phase 3). When set,
 * this function also builds a `MeshSyncEngine` (`@johnhenry/browsermesh-sync`)
 * -- durable `IndexedDBSyncStorage` by default -- and wires it to the
 * returned `PeerNode` via `mesh-sync.mjs`'s `createMeshSync()`, attached as
 * `node.sync` (a `MeshSyncBinding`). This keeps `createMeshNode()` the one
 * obvious place to get a fully-wired mesh node, while leaving direct
 * `createMeshSync({ node })` available for callers who want to construct
 * the binding themselves (e.g. a custom storage adapter per document type).
 *
 * **Mesh relay is opt-in via `{ enableRelayHost: true, relayHostNetwork }`**
 * (Phase 8). When set, this function builds a `MeshRelayHost`
 * (`mesh-relay-host.mjs`) bridging inbound, `PeerRegistry`-authorized relay
 * connections into `relayHostNetwork` (a caller-supplied `VirtualNetwork`,
 * e.g. one with a `GatewayBackend` reaching a real local service), attached
 * as `node.relayHost`. This is the "share my `VirtualNetwork` access with
 * specific peers" side; the client side is `mesh-relay-backend.mjs`'s
 * `createMeshRelayBackend()`, called directly (not via this function) and
 * registered on the *client's own* `VirtualNetwork`.
 *
 * **Transport hardening is opt-in via `{ enableHardening: true,
 * hardeningOptions }`.** When set, the `MeshTransportNegotiator` this
 * function constructs is wrapped (`mesh-hardening.mjs`'s
 * `createHardenedNegotiator()`) with `@johnhenry/browsermesh-core`'s
 * `hardening.mjs` primitives -- `RetryWithBackoff` (exponential backoff +
 * circuit breaker, scoped per peer) and `TransportFailover` (transport-type
 * failover) around every `connectToPeer()`'s negotiation attempt, plus
 * `TransportMetrics`/`MetricsRegistry` for per-peer byte/message/error/
 * latency counters -- before it is handed to `PeerNode`. This is what
 * turns a transient WebRTC/ICE negotiation failure into a retried attempt
 * instead of an immediate `connectToPeer()` rejection (see issue #26's
 * documented WebRTC/ICE flakiness). Exposed as `node.hardening` (the full
 * `{ metrics, failovers, retries }` bundle) and `node.transportMetrics`
 * (alias for `node.hardening.metrics`, matching `node.sync`/`node.relayHost`'s
 * convention of exposing the opt-in subsystem directly on the node).
 * `ConnectionPool` is *not* wired here -- see `mesh-hardening.mjs`'s own
 * header comment for why (no call site under `PeerNode`'s current
 * one-session-per-peer model; deliberately deferred, see issue #110).
 *
 * **`TransportHealthCheck` IS wired, opt-in via `{ enableHealthCheck: true,
 * healthCheckOptions }`** (issue #110, follow-up to the above). Unlike
 * `enableHardening`, this doesn't wrap the negotiator -- it attaches
 * `mesh-keepalive.mjs`'s `createMeshKeepaliveService()` as a `MeshService`
 * (Phase C's `attach()`/`ctx` convention), which runs a real ping/pong
 * keepalive envelope protocol per connected peer and feeds `'unhealthy'`
 * transitions into `enableHardening`'s `TransportFailover` (if also on) and
 * into `ctx.emit()` for observability. See `mesh-keepalive.mjs`'s own header
 * comment for the full wire-protocol/lifecycle writeup. Exposed as
 * `node.healthCheck` (the `attachService()` handle -- also reachable at
 * `node.services.get('keepalive')`, same as any other opt-in service).
 *
 * **Multi-hop mesh routing is opt-in via `{ enableRouting: true,
 * routingOptions }`** (issue #121). When set, this function attaches
 * `peer-routing.mjs`'s `createMeshRoutingService()` -- wiring `MeshRouter`'s
 * `forwardFn` onto `ctx.sendTo()` and its inbound dispatch onto
 * `ctx.onIncomingData()`, so this node can forward messages to peers it has
 * no direct connection to, via any intermediate peer(s) with a known route
 * (see `peer-routing.mjs`'s own header for the full multi-hop design). If
 * `routingOptions.fetchFn` is supplied (even `null`), `ServerSharing` is
 * also wired, letting other peers proxy HTTP requests to a local server this
 * node has `expose()`d. Attached to the returned node as `node.router` (the
 * `attachService()` handle -- also reachable at
 * `node.services.get('mesh-routing')`, same as any other opt-in service).
 *
 * **Mesh-local IPFS-style content storage is opt-in via `{ enableIpfs: true,
 * ipfsOptions }`** (issue #123). When set, this function attaches
 * `peer-ipfs.mjs`'s `createIpfsService()` -- wrapping a fresh `IPFSStore`
 * (content-addressed `add`/`get`/`pin`/`unpin`/`remove`/`listCids`/
 * `getStats`/`close`, `ChunkStore`-compatible SHA-256 CIDs) as a
 * `MeshService`, bridging its own `on`/`off` events through `ctx.emit()`.
 * **Despite the name, this is NOT wired to a real IPFS network today** --
 * see `peer-ipfs.mjs`'s own header comment ("HONEST STATUS OF HELIA/IPFS")
 * for the full, verified explanation: `helia` is not a dependency anywhere
 * in this repo, and even when `ensureLoaded()`'s CDN-loaded Helia instance
 * succeeds, no storage operation actually calls into it. Each node's store
 * is also entirely local -- `createIpfsService()` adds no wire protocol, so
 * content is never visible across peers, unlike `CloudStorage`'s replicated
 * chunks. Attached to the returned node as `node.ipfs` (the
 * `attachService()` handle -- also reachable via
 * `node.services.get('peer-ipfs')`).
 *
 * **Escrow (real credit/payment holds) is opt-in via `{ enableEscrow: true,
 * escrowOptions: { creditLedger } }`** (issue #117). When set, this function
 * attaches `peer-escrow.mjs`'s `createEscrowService()` -- wiring
 * `EscrowManager` (`create`/`release`/`refund`/`dispute`/`checkExpired`
 * against the caller-supplied `creditLedger`) so a peer can ask this node
 * (or this node can ask another peer's own `enableEscrow` node) to hold
 * credits in escrow. `escrowOptions.creditLedger` is REQUIRED -- there is no
 * default ledger, matching the `enableRelayHost`/`relayHostNetwork`
 * "opt-in flag needs its one real dependency supplied explicitly" pattern
 * (this function throws if `enableEscrow` is set with no
 * `escrowOptions.creditLedger`). See `peer-escrow.mjs`'s own
 * `createEscrowService()` doc comment for the full authorization model
 * (peer-initiated `create`/`release`/`refund`/`dispute` are individually
 * gated via `registry.checkAccess()`; `getContract`/`listContracts`/
 * `getStats`/`checkExpired` are local-only, never wire-exposed). Attached
 * to the returned node as `node.escrow` (the `attachService()` handle --
 * also reachable at `node.services.get('escrow')`, same as any other
 * opt-in service).
 *
 * **Mesh-native services are opt-in via `{ services: [...] }`** (Phase C).
 * Each entry is a `MeshService` descriptor (`mesh-service.mjs`) attached via
 * `attachService()`, mirroring the `enableRelayHost`/`relayHostServices`
 * opt-in shape exactly -- this is the generic version of that pattern, for
 * services beyond mesh-relay (the first consumer is the CloudStorage plan's
 * later phases). Results are stored in `node.services`, a `Map<string,
 * { name, backendScheme, teardown }>` keyed by descriptor name, always
 * present (empty if `services` is omitted).
 *
 * **The audit trail is opt-in via `{ enableAudit: true }`** (or by passing
 * an already-constructed `{ auditChain }`, the same "boolean toggle for a
 * default, or supply your own instance" shape `enableSync`/`syncStorage`
 * already establishes). Unlike `sync`/`relayHost`, the resulting
 * `AuditChain` (`audit.mjs`) has to exist *before* `PeerNode` is
 * constructed -- it's a constructor-time dependency, not something attached
 * to the node afterwards -- so this function builds it (or accepts a
 * caller-supplied one) right after the local identity is created and passes
 * it straight into `new PeerNode({ ..., auditChain })`. `AuditChain` itself
 * needs no signing key at construction; `PeerNode`'s `#audit()` already
 * signs every entry with the node's own identity via `wallet.sign()`, so
 * `enableAudit: true` only needs a `chainId` (defaults to `audit-${podId}`,
 * overridable via `auditChainId`). The instance is attached as
 * `node.auditChain`, mirroring `node.sync`/`node.relayHost`'s convention;
 * it is left unset when neither `enableAudit` nor `auditChain` is supplied,
 * so `PeerNode`'s audit path silently no-ops exactly as it did before this
 * option existed.
 *
 * **DHT discovery is opt-in via `{ enableDht: true, dhtBootstrapPeers }`**
 * (Phase D, issue #87). `@johnhenry/browsermesh-discovery`'s
 * `DhtDiscoveryStrategy` (dht.mjs) is a real, tested Kademlia
 * `DiscoveryStrategy` implementation that was never constructed anywhere in
 * this repo -- it only takes a bare `sendFn`, with no transport of its own.
 * When set, this function constructs one via `mesh-dht.mjs`'s
 * `createMeshDht()`, multiplexing its wire traffic onto the same
 * `signalingTransport` bus already required for WebRTC signaling (the one
 * thing in this architecture that already reaches arbitrary podIds before a
 * WebRTC connection exists), and adds it to `discoveryStrategies`. This is
 * NOT a full rendezvous solution: `dhtBootstrapPeers` must supply at least
 * one already-known peer podId out-of-band, or the node has no way to find
 * its first DHT contact -- see `mesh-dht.mjs`'s header for the full
 * explanation of what this does and does not solve. The constructed
 * strategy is attached as `node.dht`.
 *
 * **`peer-timestamp.mjs`/`peer-health.mjs` are opt-in via `{ enableTimestamp,
 * timestampOptions }`/`{ enableHealthMonitor, healthMonitorOptions }`**
 * (Phase 1 of the browsermesh-app-layer-migration plan, issue #120). Both
 * follow the exact `enableHealthCheck`/`healthCheckOptions` shape just
 * above: `mesh-timestamp.mjs`'s `createTimestampService()` and
 * `mesh-health.mjs`'s `createHealthMonitorService()` are each attached via
 * `attachService()` the same way `mesh-keepalive.mjs`'s descriptor is,
 * stored in `node.services` under their own descriptor names (`'timestamp'`/
 * `'health-monitor'`) and ALSO exposed directly as `node.timestamp`/
 * `node.healthMonitor`, mirroring `node.healthCheck`'s "reachable both ways"
 * convention. See those two files' own header comments for the full
 * wire-protocol/design writeup -- both are near-trivial wrappers, per the
 * migration plan's own Phase 1 note, since `TimestampAuthority`/
 * `HealthMonitor` already duck-type against `PeerNode.listSessions()`.
 *
 * **`peer-verification.mjs` is opt-in via `{ enableVerification,
 * verificationOptions }`** (Phase 4 of the browsermesh-app-layer-migration
 * plan, issue #119). Attaches `mesh-verification.mjs`'s
 * `createVerificationService()` -- a real request/response wire protocol
 * (`'verify-request'`/`'verify-response'`) wrapping `peer-verification.mjs`'s
 * `VerificationQuorum`: this node can dispatch a job to a quorum of trusted
 * peers, collect their independently-computed results, and vote on
 * correctness (unanimous/majority/threshold/byzantine). Follows the exact
 * `enableTimestamp`/`timestampOptions` shape just above: attached via
 * `attachService()`, stored in `node.services` under `'verification'`, and
 * also exposed directly as `node.verification`. See `mesh-verification.mjs`'s
 * own header comment for the full design -- in particular, why answering an
 * inbound verification request requires both `ctx.registry.checkAccess()`
 * authorization AND a caller-supplied `verificationOptions.executeFn` (never
 * invented by this file), mirroring the same restraint `peer-compute.mjs`
 * already shows while that module (and `peer-terminal.mjs`) stay blocked on
 * issue #86's still-open execution-gating design pass.
 * **Remote file access is opt-in via `{ enableFileShare: true,
 * fileShareOptions }`** (Phase 8 of the app-layer migration plan, issue
 * #84). `peer-files.mjs`'s `createFileShareService()` is attached via
 * `attachService()`, the same as every other opt-in service above --
 * `FileHost`/`FileClient` now run on `ctx.sendTo()`/`ctx.onIncomingData()`
 * instead of the `peer-session.mjs`/`PeerSession` dependency that module
 * used to have before this migration (see `peer-files.mjs`'s own header for
 * the full writeup). Stored in `node.services` under `'file-share'` and
 * ALSO exposed directly as `node.fileShare`, mirroring `node.router`/
 * `node.healthCheck`'s "reachable both ways" convention.
 * **`peer-chat.mjs` is opt-in via `{ enableChat, chatOptions }`** (Phase 9
 * of the browsermesh-app-layer-migration plan, issue #84 -- a migration off
 * `PeerSession`, not a fresh wire-up: `peer-chat.mjs`'s `PeerChat` used to
 * require a live `PeerSession`, which nothing in this repo ever constructs).
 * Follows the exact `enableTimestamp`/`timestampOptions` shape just above:
 * `createChatService()` is attached via `attachService()` the same way,
 * stored in `node.services` under `'chat'` and ALSO exposed directly as
 * `node.chat` (the `attachService()` handle -- `node.chat.api.sendMessage()`/
 * etc., same "reachable both ways" convention `node.timestamp`/
 * `node.healthMonitor`/`node.router` already establish). See
 * `peer-chat.mjs`'s own header comment for the full design
 * writeup (why `sendMessage()`/`sendTyping()` now take an explicit target
 * pubKey, and why signature verification keys off each message's real
 * sender instead of one fixed constructor-time key).
 *
 * **Federated compute (dispatching code to a remote peer to run) is opt-in
 * via `{ enableCompute: true, computeOptions: { executeFn } }`** (Phase 11 of
 * the browsermesh-app-layer-migration plan, issue #118 -- the last of the
 * two modules that stayed blocked on issue #86's execution-gating design
 * pass, alongside `peer-terminal.mjs`). Attaches `mesh-compute.mjs`'s
 * `createComputeService()`: a real request/response wire protocol
 * (`'compute-request'`/`'compute-response'`) wrapping `peer-compute.mjs`'s
 * `FederatedCompute`, so this node can split a job (via `computeOptions
 * .splitFn` or a per-call `jobSpec.splitFn`), dispatch chunks to connected
 * peers, and merge their results (via `computeOptions.mergeFn`/
 * `jobSpec.mergeFn`). Follows the exact `enableVerification`/
 * `verificationOptions` shape just above -- see `mesh-compute.mjs`'s own
 * header comment for the full design (in particular, why answering an
 * inbound compute-chunk request requires both `ctx.registry.checkAccess()`
 * authorization AND a caller-supplied `computeOptions.executeFn`, never
 * invented by this file, matching issue #86's resolved "bring-your-own,
 * required, no default execution backend" decision). Unlike
 * `enableVerification` (where `executeFn` is optional -- a node can submit
 * verification jobs without ever answering them), `enableCompute` REQUIRES
 * `computeOptions.executeFn` up front: this function throws if it's missing,
 * mirroring `enableEscrow`'s required `escrowOptions.creditLedger` check,
 * since (per issue #86's design pass) there is no real execution backend
 * anywhere in this repo to fall back to, and a compute-only node with no
 * ability to ever serve a chunk has little practical use compared to
 * verification's legitimate "submit-only" role. Attached to the returned
 * node as `node.compute` (the `attachService()` handle -- also reachable via
 * `node.services.get('compute')`).
 *
 * **Remote terminal/shell execution is opt-in via `{ enableTerminal: true,
 * terminalOptions: { shell } }`** (issue #84, Phase 10 of the
 * browsermesh-app-layer-migration plan -- blocked on, and unblocked by,
 * issue #86's design pass). When set, this function attaches
 * `peer-terminal.mjs`'s `createTerminalService()` -- wiring `TerminalHost`/
 * `TerminalClient` (real remote command execution, migrated off
 * `peer-session.mjs`'s `PeerSession`) onto `ctx.sendTo()`/
 * `ctx.onIncomingData()`, gating inbound exec requests via
 * `registry.checkAccess(fromPubKey, 'terminal', 'execute')` -- see that
 * function's own doc comment for the full design (in particular, why this is
 * a single coarse scope rather than per-command/per-target). Just like
 * `enableEscrow`'s `escrowOptions.creditLedger`, `terminalOptions.shell` is
 * REQUIRED -- there is no default shell (no `child_process`, no OS command
 * execution shipped by this package); this function throws if `enableTerminal`
 * is set with no `terminalOptions.shell`, so nobody gets real remote shell
 * execution just by flipping the opt-in flag. Attached to the returned node
 * as `node.terminal` (the `attachService()` handle -- also reachable at
 * `node.services.get('terminal')`, same as any other opt-in service).
 *
 * **SWIM cluster membership + leader election + task distribution is
 * opt-in via `{ enableSwarm: true, swarmOptions }`** (issue #88). When set,
 * this function attaches `mesh-swarm.mjs`'s `createSwarmService()` --
 * wrapping `@johnhenry/browsermesh-discovery`'s `SwarmCoordinator` with an
 * internally-constructed `SwimMembership`, so swarm membership becomes real
 * and SWIM-driven (direct ping -> indirect ping-req -> suspect -> dead, with
 * piggybacked membership dissemination), plus a genuinely new leader-election
 * heartbeat pump and a real `SWARM_TASK_ASSIGN` wire notification when a task
 * is assigned to a remote peer. Peer-initiated join requests and task
 * submissions are individually authorized via `registry.checkAccess()` --
 * see `mesh-swarm.mjs`'s own header comment for the full design (in
 * particular why `SwimMembership`'s single-slot `onJoin`/`onDead` callbacks
 * are composed rather than overwritten, and the SWARM_JOIN/SWARM_LEAVE
 * admission-control design distinct from SWIM's own dead-via-timeout
 * detection). Attached to the returned node as `node.swarm` (the
 * `attachService()` handle -- also reachable via `node.services.get('swarm')`).
 *
 * No browser-only imports at module level. @johnhenry/browsermesh-core/
 * -discovery/-transport (all optional peerDependencies) are imported
 * lazily inside createMeshNode() itself, not here -- see that function's
 * own comment and the CHANGELOG entry documenting this fix.
 */

import { PeerNode } from './peer-node.mjs'
import { PeerRegistry } from './peer-registry.mjs'
import { MeshSignalingChannel } from './signaling.mjs'
import { createWebRTCTransportFactory } from './webrtc-negotiator.mjs'
import { createMeshSync } from './mesh-sync.mjs'
import { MeshRelayHost } from './mesh-relay-host.mjs'
import { attachService } from './mesh-service.mjs'
import { AuditChain } from './audit.mjs'
import { createHardenedNegotiator } from './mesh-hardening.mjs'
import { createMeshDht, shareTransport } from './mesh-dht.mjs'
import { createMeshKeepaliveService } from './mesh-keepalive.mjs'
import { createMeshRoutingService } from './peer-routing.mjs'
import { createFileShareService } from './peer-files.mjs'
import { createTimestampService } from './mesh-timestamp.mjs'
import { createHealthMonitorService } from './mesh-health.mjs'
import { createIpfsService } from './peer-ipfs.mjs'
import { createVerificationService } from './mesh-verification.mjs'
import { createTorrentService } from './mesh-torrent.mjs'
import { createEscrowService } from './peer-escrow.mjs'
import { createChatService } from './peer-chat.mjs'
import { createComputeService } from './mesh-compute.mjs'
import { createTerminalService } from './peer-terminal.mjs'
import { createSwarmService } from './mesh-swarm.mjs'
import { createAgentSwarmService } from './mesh-agent-swarm.mjs'
import { createOrchestratorService } from './mesh-orchestrator.mjs'
import { BrowserToolRegistry } from './compat.mjs'
import { registerOrchestratorTools } from './mesh-orchestrator-tools.mjs'

/**
 * Build and boot a real, WebRTC-capable `PeerNode`.
 *
 * Order of operations matters here: `DiscoveryManager` and `PeerRegistry`
 * both need the local podId *before* they can be constructed, but
 * `PeerNode.boot()` is what normally auto-creates the default identity. So
 * this function creates the identity itself up front (via
 * `wallet.createIdentity(label)`) and passes `{ skipDiscovery }` through to
 * `boot()` for the rest of the lifecycle -- `boot()` sees an identity
 * already exists and does not create a second one.
 *
 * @param {object} [options]
 * @param {string} [options.label='default'] - Identity label.
 * @param {import('@johnhenry/browsermesh-core').MeshIdentityManager} [options.identityManager]
 *   Pre-constructed identity manager (e.g. one backed by
 *   `IndexedDBIdentityStorage` for persistence). Defaults to a fresh
 *   in-memory `MeshIdentityManager`.
 * @param {import('@johnhenry/browsermesh-core').MeshPeerManager} [options.peerManager]
 * @param {import('@johnhenry/browsermesh-core').TrustGraph} [options.trustGraph]
 * @param {import('@johnhenry/browsermesh-core').MeshACL} [options.acl]
 * @param {import('@johnhenry/browsermesh-core').CapabilityValidator} [options.capabilityValidator]
 *   Backs `PeerRegistry.grantCapabilities()`/`.revokeCapabilities()`'s real
 *   token issuance/revocation (Phase 5). Defaults to a fresh real
 *   `CapabilityValidator` from `@johnhenry/browsermesh-core`.
 * @param {import('@johnhenry/browsermesh-discovery').DiscoveryStrategy[]} [options.discoveryStrategies]
 *   Defaults to `[new BroadcastChannelStrategy(...)]`; throws if omitted
 *   and `BroadcastChannel` is not available (e.g. plain Node) -- pass e.g.
 *   `[new ManualStrategy()]` there instead.
 * @param {string} [options.discoveryChannelName='mesh-discovery']
 * @param {number} [options.announceInterval]
 * @param {string[]} [options.capabilities] - Advertised in the local discovery record.
 * @param {{send: Function, onMessage: Function, open?: Function, close?: Function}} options.signalingTransport
 *   Required. Injectable bus for WebRTC offer/answer/ICE relay -- see
 *   `signaling.mjs`.
 * @param {RTCIceServer[]} [options.iceServers] - TURN (or additional STUN)
 *   servers, merged alongside `DEFAULT_ICE_SERVERS` via
 *   `@johnhenry/browsermesh-transport`'s `mergeIceServers()` -- the same
 *   extension point `webrtc.mjs` already documents, not reimplemented here.
 *   `DEFAULT_ICE_SERVERS` is empty (no ICE servers, for privacy -- see
 *   `webrtc.mjs`), so omitting this option preserves today's default
 *   behaviour exactly. An explicit `iceServers: []` is honoured as "no ICE
 *   servers at all" (used by this package's own real-peer test for a
 *   hermetic, loopback-only connection); a non-empty array is merged with
 *   the defaults and malformed entries are silently dropped. To combine a
 *   TURN server with the family's opt-in public STUN server, spread
 *   `PUBLIC_STUN_SERVERS` in yourself:
 *   ```js
 *   import { PUBLIC_STUN_SERVERS } from '@johnhenry/browsermesh-transport'
 *   import { createMeshNode } from '@johnhenry/browsermesh-apps'
 *
 *   const node = await createMeshNode({
 *     signalingTransport,
 *     iceServers: [
 *       ...PUBLIC_STUN_SERVERS,
 *       { urls: 'turn:turn.example.com:3478', username: 'alice', credential: 's3cr3t' },
 *     ],
 *   })
 *   ```
 * @param {Function} [options.onLog]
 * @param {boolean} [options.skipDiscovery=false] - Passed through to `PeerNode.boot()`.
 * @param {boolean} [options.skipBoot=false] - Construct but don't boot (caller calls `node.boot()` itself).
 * @param {boolean} [options.enableSync=false] - Build a `MeshSyncEngine` and
 *   wire it to the returned node as `node.sync` (see `mesh-sync.mjs`).
 * @param {object} [options.syncStorage] - Storage adapter for the sync engine.
 *   Defaults to a durable `IndexedDBSyncStorage`; only used when `enableSync`.
 * @param {string} [options.syncDbName] - dbName for the default `IndexedDBSyncStorage`.
 *   Defaults to `mesh-sync-${podId}`. Ignored if `syncStorage` is supplied.
 * @param {string} [options.syncEnvelopeType] - Overrides the `envelope.type`
 *   the sync binding sends/routes on `PeerNode`'s dispatch bus (default `'mesh-sync'`).
 * @param {boolean} [options.syncAutoLoad=true] - When `enableSync`, await
 *   `node.sync.load()` before returning so previously-persisted documents
 *   (e.g. from a prior page session, via `IndexedDBSyncStorage`) are already
 *   present -- the actual "a workspace survives a reload" behavior.
 * @param {boolean} [options.enableRelayHost=false] - Build a `MeshRelayHost`
 *   (Phase 8) and wire it to the returned node as `node.relayHost`, so
 *   authorized mesh peers can relay through `options.relayHostNetwork` (e.g.
 *   a `VirtualNetwork` with a `GatewayBackend` reaching a real local
 *   service) via `PeerRegistry.grantCapabilities()`-gated
 *   `mesh-relay:<service>:connect` scopes. See `mesh-relay-host.mjs`.
 * @param {import('@johnhenry/browsermesh-netway').VirtualNetwork} [options.relayHostNetwork]
 *   Required when `enableRelayHost` -- the `VirtualNetwork` `MeshRelayHost`
 *   bridges inbound relay connections into.
 * @param {Object<string,string>} [options.relayHostServices] - Optional
 *   `{ name: targetAddress }` map of services to `exposeService()` on the
 *   new `MeshRelayHost` immediately (equivalent to calling
 *   `node.relayHost.exposeService(name, targetAddress)` for each entry).
 * @param {string} [options.relayHostEnvelopeType] - Overrides the
 *   `envelope.type` the relay host routes/sends on `PeerNode`'s dispatch bus
 *   (default `'mesh-relay'`).
 * @param {import('./mesh-service.mjs').MeshService[]} [options.services] -
 *   Optional array of `MeshService` descriptors (Phase C, see
 *   `mesh-service.mjs`) to attach immediately via `attachService()`,
 *   mirroring the `relayHostServices` opt-in shape exactly. Each descriptor
 *   is attached in array order; the resulting per-service handle (`{ name,
 *   backendScheme, teardown }`) is stored in the returned node's
 *   `node.services` map, keyed by `descriptor.name`.
 * @param {boolean} [options.enableFileShare=false] - Attach `peer-files.mjs`'s
 *   `createFileShareService()` (issue #84, Phase 8): real, `PeerRegistry`-
 *   gated remote file access -- `FileHost` serves `fileShareOptions.fs` (if
 *   supplied) to any peer holding `files:read`/`files:write`/`files:delete`
 *   capabilities, and `FileClient` (always available once attached) can
 *   request files from any other peer running this service, via `node
 *   .fileShare.api.listFiles(pubKey, path)`/`.readFile()`/`.writeFile()`/
 *   `.deleteFile()`/`.stat()`. Attached to the returned node as
 *   `node.fileShare` (the `attachService()` handle -- also reachable via
 *   `node.services.get('file-share')`).
 * @param {object} [options.fileShareOptions] - Only used when
 *   `enableFileShare`. Passed straight through to `createFileShareService()`
 *   (`fs`/`maxFileSize`/`timeout`/`resource`/`requestEnvelopeType`/
 *   `responseEnvelopeType`) -- see that function's own doc comment. Omitting
 *   `fileShareOptions.fs` means this node only acts as a client (no local
 *   filesystem is exposed to other peers).
 * @param {import('@johnhenry/browsermesh-netway').VirtualNetwork} [options.servicesNetwork]
 *   `VirtualNetwork` passed through to `attachService()` for each entry in
 *   `options.services`. Only required if at least one descriptor declares
 *   `createBackend`; `attachService()` throws for any such descriptor if
 *   this is omitted.
 * @param {boolean} [options.enableAudit=false] - Construct a default
 *   `AuditChain` (`audit.mjs`) and wire it into the returned `PeerNode` as
 *   `options.auditChain`, so `PeerNode`'s existing "audit trail for every
 *   session action" path (boot, connect, shutdown -- see `peer-node.mjs`'s
 *   `#audit()`) actually produces signed entries, using the node's own
 *   identity (`node.wallet.sign()`) the same way `PeerNode` already does.
 *   Ignored if `options.auditChain` is supplied directly.
 * @param {import('./audit.mjs').AuditChain} [options.auditChain] - Pass a
 *   pre-built `AuditChain` instead of letting `enableAudit` construct a
 *   default one (e.g. to share one chain across multiple nodes/chainIds, or
 *   to restore one via `AuditChain.fromJSON()`). Implies audit logging is
 *   active even if `enableAudit` is left `false`, mirroring the
 *   `enableSync`/`syncStorage` "boolean toggle for a default, or supply your
 *   own instance" pattern.
 * @param {string} [options.auditChainId] - `chainId` for the default
 *   `AuditChain` `enableAudit` constructs. Defaults to `audit-${podId}`.
 *   Ignored if `options.auditChain` is supplied.
 * @param {boolean} [options.enableHardening=false] - Wrap the constructed
 *   `MeshTransportNegotiator` with retry/backoff + failover + metrics (see
 *   `mesh-hardening.mjs`) before it is handed to `PeerNode`, so
 *   `connectToPeer()` retries transient negotiation failures instead of
 *   rejecting immediately. Attached to the returned node as `node.hardening`
 *   (`{ metrics, failovers, retries }`) and `node.transportMetrics` (alias
 *   for `node.hardening.metrics`).
 * @param {object} [options.hardeningOptions] - Only used when
 *   `enableHardening`.
 * @param {object} [options.hardeningOptions.retry] - Passed to each
 *   per-peer `new RetryWithBackoff()` (see `hardening.mjs` for
 *   `maxRetries`/`baseDelayMs`/`maxDelayMs`/`jitterFactor`/`resetTimeoutMs`).
 * @param {boolean} [options.enableDht=false] - Build a real, wire-connected
 *   `DhtDiscoveryStrategy` (Phase D, issue #87; see `mesh-dht.mjs`) and add
 *   it to `discoveryStrategies`, in addition to any other strategies
 *   (default `BroadcastChannelStrategy`, or caller-supplied
 *   `discoveryStrategies`). Its wire traffic is multiplexed onto
 *   `signalingTransport` (the same bus already required for WebRTC
 *   signaling) via `mesh-dht.mjs`'s `shareTransport()`. Does NOT solve
 *   first-contact rendezvous -- see `dhtBootstrapPeers` and `mesh-dht.mjs`'s
 *   header.
 * @param {Array<string|{podId: string}>} [options.dhtBootstrapPeers=[]] -
 *   Already-known peer podIds (or `{podId}` records) to seed the DHT routing
 *   table with. Only used when `enableDht`. Required for this node to
 *   discover anyone via DHT at all; without it the strategy starts with an
 *   empty routing table and can only ever learn of peers who bootstrap
 *   *with* this node directly.
 * @param {number} [options.dhtK] - Kademlia bucket size, forwarded to
 *   `DhtDiscoveryStrategy` (defaults to 20 there). Only used when
 *   `enableDht`.
 * @param {string} [options.dhtMessageType] - Overrides the `type` tag used
 *   to distinguish DHT wire messages sharing `signalingTransport` with
 *   WebRTC signaling traffic (default `'dht-relay'`). Only used when
 *   `enableDht`.
 * @param {boolean} [options.enableHealthCheck=false] - Attach
 *   `mesh-keepalive.mjs`'s `createMeshKeepaliveService()` (issue #110): a
 *   real ping/pong keepalive envelope protocol, one
 *   `@johnhenry/browsermesh-core` `TransportHealthCheck` per connected peer.
 *   `'unhealthy'` transitions feed `enableHardening`'s `TransportFailover`
 *   (if also on -- gracefully skipped otherwise) and `ctx.emit()` for
 *   observability. Attached to the returned node as `node.healthCheck` (the
 *   `attachService()` handle).
 * @param {object} [options.healthCheckOptions] - Only used when
 *   `enableHealthCheck`. Passed straight through to each per-peer
 *   `TransportHealthCheck`.
 * @param {number} [options.healthCheckOptions.intervalMs] - See `hardening.mjs` (default 10000).
 * @param {number} [options.healthCheckOptions.timeoutMs] - See `hardening.mjs` (default 5000).
 * @param {number} [options.healthCheckOptions.maxMissed] - See `hardening.mjs` (default 3).
 * @param {boolean} [options.enableRouting=false] - Attach `peer-routing.mjs`'s
 *   `createMeshRoutingService()` (issue #121): real multi-hop message
 *   forwarding via `MeshRouter` (`forwardFn` -> `ctx.sendTo()`), plus
 *   `ServerSharing` if `routingOptions.fetchFn` is supplied. Attached to the
 *   returned node as `node.router` (the `attachService()` handle -- also
 *   reachable via `node.services.get('mesh-routing')`).
 * @param {object} [options.routingOptions] - Only used when `enableRouting`.
 *   Passed straight through to `createMeshRoutingService()`
 *   (`maxTTL`/`routeCacheMs`/`envelopeType`/`fetchFn`/
 *   `serverShareEnvelopeType`/`proxyTimeoutMs`) -- see that function's own
 *   doc comment.
 * @param {boolean} [options.enableTimestamp=false] - Attach
 *   `mesh-timestamp.mjs`'s `createTimestampService()` (issue #120): signed
 *   consensus timestamping wrapping `peer-timestamp.mjs`'s
 *   `TimestampAuthority`. Attached to the returned node as `node.timestamp`
 *   (the `attachService()` handle -- also reachable via
 *   `node.services.get('timestamp')`).
 * @param {object} [options.timestampOptions] - Only used when
 *   `enableTimestamp`. Passed straight through to `createTimestampService()`
 *   (`identity`/`clockSkewMs`/`witnessTimeoutMs`/`envelopeType`).
 * @param {boolean} [options.enableHealthMonitor=false] - Attach
 *   `mesh-health.mjs`'s `createHealthMonitorService()` (issue #120): peer
 *   heartbeat liveness tracking (+ opt-in auto-migration) wrapping
 *   `peer-health.mjs`'s `HealthMonitor`/`AutoMigrator`. Attached to the
 *   returned node as `node.healthMonitor` (the `attachService()` handle --
 *   also reachable via `node.services.get('health-monitor')`).
 * @param {object} [options.healthMonitorOptions] - Only used when
 *   `enableHealthMonitor`. Passed straight through to
 *   `createHealthMonitorService()` (`trust`/`orchestrator`/
 *   `resolveWorkload`/`intervalMs`/`thresholds`).
 * @param {boolean} [options.enableIpfs=false] - Attach `peer-ipfs.mjs`'s
 *   `createIpfsService()` (issue #123): mesh-LOCAL content-addressed storage
 *   wrapping a fresh `IPFSStore`. Despite the name, NOT real IPFS-network
 *   interop -- see `peer-ipfs.mjs`'s own header comment. Attached to the
 *   returned node as `node.ipfs` (the `attachService()` handle -- also
 *   reachable via `node.services.get('peer-ipfs')`).
 * @param {object} [options.ipfsOptions] - Only used when `enableIpfs`.
 *   Passed straight through to `createIpfsService()`
 *   (`enabled`/`maxStorageMb`).
 * @param {boolean} [options.enableVerification=false] - Attach
 *   `mesh-verification.mjs`'s `createVerificationService()` (Phase 4, issue
 *   #119): quorum-based job-result verification wrapping
 *   `peer-verification.mjs`'s `VerificationQuorum`. Attached to the returned
 *   node as `node.verification` (the `attachService()` handle -- also
 *   reachable via `node.services.get('verification')`).
 * @param {object} [options.verificationOptions] - Only used when
 *   `enableVerification`. Passed straight through to
 *   `createVerificationService()` (`scheduler`/`trust`/`executeFn`/
 *   `dispatchTimeoutMs`/`envelopeType`/`accessResource`/`accessAction`) --
 *   see that function's own doc comment. `executeFn` is REQUIRED for this
 *   node to usefully serve as a verifier for other peers' jobs (see
 *   `mesh-verification.mjs`'s header for why it is never defaulted).
 * @param {boolean} [options.enableTorrent=false] - Attach
 *   `mesh-torrent.mjs`'s `createTorrentService()` (Phase 5, issue #122): a
 *   real mesh-native swarm piece-exchange protocol wrapping
 *   `peer-torrent.mjs`'s `TorrentManager`. Attached to the returned node as
 *   `node.torrent` (the `attachService()` handle -- also reachable via
 *   `node.services.get('torrent')`).
 * @param {object} [options.torrentOptions] - Only used when `enableTorrent`.
 *   Passed straight through to `createTorrentService()`
 *   (`trackerUrl`/`chunkSize`/`envelopeType`/`manifestTimeoutMs`/`chunkTimeoutMs`).
 * @param {boolean} [options.enableEscrow=false] - Attach `peer-escrow.mjs`'s
 *   `createEscrowService()` (issue #117): real escrow-contract create/
 *   release/refund/dispute against `escrowOptions.creditLedger`, with
 *   peer-initiated operations individually authorized via
 *   `registry.checkAccess()` -- see that function's own doc comment for the
 *   full authorization model. Attached to the returned node as
 *   `node.escrow` (the `attachService()` handle -- also reachable via
 *   `node.services.get('escrow')`).
 * @param {object} [options.escrowOptions] - Required when `enableEscrow`.
 *   Passed straight through to `createEscrowService()`
 *   (`creditLedger`/`onLog`/`envelopeType`/`requestTimeoutMs`) -- see that
 *   function's own doc comment. `escrowOptions.creditLedger` (must have
 *   `charge()`/`credit()`/`getBalance()`) is required; this function throws
 *   if it's missing.
 * @param {boolean} [options.enableChat=false] - Attach `peer-chat.mjs`'s
 *   `createChatService()` (issue #84, Phase 9): P2P chat with optional
 *   message signing/verification, history, typing indicators, and an
 *   auto-responder hook, migrated off `PeerSession` onto `ctx.sendTo()`/
 *   `ctx.onIncomingData()`. Attached to the returned node as `node.chat`
 *   (the `attachService()` handle -- also reachable via
 *   `node.services.get('chat')`).
 * @param {object} [options.chatOptions] - Only used when `enableChat`.
 *   Passed straight through to `createChatService()`
 *   (`signFn`/`verifyFn`/`maxHistory`/`autoResponder`/`onLog`).
 * @param {boolean} [options.enableCompute=false] - Attach `mesh-compute.mjs`'s
 *   `createComputeService()` (issue #118, Phase 11): federated compute
 *   orchestration -- split a job into chunks, dispatch each to a connected
 *   peer over a real `'compute-request'`/`'compute-response'` wire protocol,
 *   retry on failure, merge completed results -- wrapping `peer-compute.mjs`'s
 *   `FederatedCompute`. Peer-initiated inbound chunk-execution requests are
 *   individually authorized via `registry.checkAccess()` -- see that
 *   function's own doc comment for the full authorization model. Attached to
 *   the returned node as `node.compute` (the `attachService()` handle --
 *   also reachable via `node.services.get('compute')`).
 * @param {object} [options.computeOptions] - Required when `enableCompute`.
 *   Passed straight through to `createComputeService()`
 *   (`scheduler`/`listAvailablePeers`/`splitFn`/`mergeFn`/`executeFn`/
 *   `dispatchTimeoutMs`/`envelopeType`/`accessResource`/`accessAction`/
 *   `onLog`) -- see that function's own doc comment.
 *   `computeOptions.executeFn` is REQUIRED (unlike `verificationOptions
 *   .executeFn`, which is merely recommended) for this node to usefully
 *   serve as a compute worker for other peers' jobs; this function throws if
 *   `enableCompute` is set without it -- see `mesh-compute.mjs`'s header for
 *   why, settled by issue #86's resolved design pass.
 * @param {boolean} [options.enableTerminal=false] - Attach `peer-terminal.mjs`'s
 *   `createTerminalService()` (issue #84, Phase 10): real remote shell
 *   execution, migrated off `PeerSession` onto `ctx.sendTo()`/
 *   `ctx.onIncomingData()`, gated via `registry.checkAccess(fromPubKey,
 *   'terminal', 'execute')` (issue #86's resolved gate mechanism). Attached
 *   to the returned node as `node.terminal` (the `attachService()` handle --
 *   also reachable via `node.services.get('terminal')`).
 * @param {object} [options.terminalOptions] - Required when `enableTerminal`.
 *   Passed straight through to `createTerminalService()`
 *   (`shell`/`allowedCommands`/`blockedCommands`/`maxOutputLength`/`timeout`/
 *   `accessResource`/`accessAction`/`requestEnvelopeType`/
 *   `responseEnvelopeType`) -- see that function's own doc comment.
 *   `terminalOptions.shell` (must implement `execute(command) ->
 *   {output, exitCode}`) is required; this function throws if it's missing
 *   (issue #86's resolved "bring-your-own, required, no default" execution-
 *   backend decision).
 * @param {boolean} [options.enableSwarm=false] - Attach `mesh-swarm.mjs`'s
 *   `createSwarmService()` (issue #88): real SWIM failure detection +
 *   leader election + task distribution, wrapping
 *   `@johnhenry/browsermesh-discovery`'s `SwarmCoordinator`/`SwimMembership`.
 *   Peer-initiated join requests and task submissions are individually
 *   authorized via `registry.checkAccess()` -- see `mesh-swarm.mjs`'s own
 *   doc comment for the full design. Attached to the returned node as
 *   `node.swarm` (the `attachService()` handle -- also reachable via
 *   `node.services.get('swarm')`).
 * @param {object} [options.swarmOptions] - Only used when `enableSwarm`.
 *   Passed straight through to `createSwarmService()`
 *   (`heartbeatMs`/`electionTimeoutMs`/`swimOptions`/`swimEnvelopeType`/
 *   `heartbeatEnvelopeType`/`membershipEnvelopeType`/`taskEnvelopeType`/
 *   `accessResource`/`requestTimeoutMs`) -- see that function's own doc comment.
 * @param {boolean} [options.enableAgentSwarm=false] - Attach
 *   `mesh-agent-swarm.mjs`'s `createAgentSwarmService()` (issue #124): real
 *   multi-agent goal decomposition/assignment/execution wrapping
 *   `peer-agent-swarm.mjs`'s `AgentSwarmCoordinator`, with `executeSubTask()`
 *   now genuinely reaching a REMOTE assignee over a real
 *   `'agent-swarm-request'`/`'agent-swarm-response'` wire protocol (self-
 *   assigned subtasks stay local, no network round-trip). Peer-initiated
 *   inbound execute requests are individually authorized via
 *   `registry.checkAccess()` -- see that function's own doc comment for the
 *   full design. Distinct from, and independently wireable from,
 *   `enableSwarm`/`enableCompute` -- `AgentSwarmCoordinator` has no code
 *   dependency on either `SwarmCoordinator` or `FederatedCompute` (see
 *   `mesh-agent-swarm.mjs`'s header for the corrected grounding). Attached to
 *   the returned node as `node.agentSwarm` (the `attachService()` handle --
 *   also reachable via `node.services.get('agent-swarm')`).
 * @param {object} [options.agentSwarmOptions] - Required when `enableAgentSwarm`.
 *   Passed straight through to `createAgentSwarmService()`
 *   (`agentProxy`/`dispatchTimeoutMs`/`envelopeType`/`accessResource`/
 *   `accessAction`/`onLog`) -- see that function's own doc comment.
 *   `agentSwarmOptions.agentProxy` (must implement `async chat(podId,
 *   message) -> string`) is required; this function throws if it's missing
 *   (issue #86's resolved "bring-your-own, required, no default" execution-
 *   backend decision -- see `mesh-agent-swarm.mjs`'s header for why this one
 *   is checked twice, once here and once inside `createAgentSwarmService()`
 *   itself).
 * @param {boolean} [options.enableOrchestrator=false] - Attach
 *   `mesh-orchestrator.mjs`'s `createOrchestratorService()` (issue #92,
 *   Phase 3 of the agent-runtime plan): wires a real `MeshOrchestrator`
 *   (`orchestrator.mjs`) onto this node, with `execOnPod`/`deploySkill`/
 *   `drainPod` gated via `registry.checkAccess(fromPubKey, 'orchestrator',
 *   action)` when triggered by an inbound peer request, over a real
 *   `'orchestrator-request'`/`'orchestrator-response'` wire protocol
 *   (self-targeted calls stay local, no network round-trip, mirroring
 *   `enableAgentSwarm`'s own local-self-assignment shortcut). `listPods`/
 *   `getPodStatus`/`topPods` are local-only aggregation, left ungated --
 *   see `mesh-orchestrator.mjs`'s own doc comment for the full design
 *   (including why `serviceAdvertiser`/`serviceBrowser` stay `null` and the
 *   confirmed non-relationship with `enableSwarm`). When `enableRouting` is
 *   also set, `node.router.api` (shape-compatible -- `MeshOrchestrator`
 *   only ever calls `addRoute()` on its `router`) is passed straight
 *   through as `MeshOrchestrator`'s own `router` dependency. Attached to
 *   the returned node as `node.orchestrator` (the `attachService()` handle
 *   -- also reachable via `node.services.get('orchestrator')`); the raw
 *   `MeshOrchestrator` instance itself is `node.orchestrator.api.orchestrator`,
 *   for a later phase's `Meshctl*Tool` registration.
 * @param {object} [options.orchestratorOptions] - Only used when
 *   `enableOrchestrator`. Passed straight through to
 *   `createOrchestratorService()` (`router`/`runtimeRegistry`/
 *   `remoteSessionBroker`/`resourceRegistry`/`auditRecorder`/
 *   `dispatchTimeoutMs`/`envelopeType`/`accessResource`/`onLog`) -- see that
 *   function's own doc comment. `router` defaults to `node.router?.api`
 *   when `enableRouting` is also set and `orchestratorOptions.router` is
 *   omitted; explicitly pass `router: null` to opt out.
 * @param {boolean} [options.enableAgentRuntime=false] - Attach a real
 *   `BrowserToolRegistry` (`compat.mjs`, Phase 1 of the agent-runtime plan,
 *   issue #90) to the returned node as `node.toolRegistry`, ready to drive
 *   `agent-runtime.mjs`'s `createAgentRuntime({registry: node.toolRegistry,
 *   llmFn})` (Phase 2). Deliberately decoupled from `enableOrchestrator`: a
 *   caller may want an agent runtime for entirely non-orchestrator tools (its
 *   own `BrowserTool` subclasses registered directly via
 *   `node.toolRegistry.register(...)` after `createMeshNode()` returns), so
 *   this flag alone always produces an EMPTY registry, never throwing just
 *   because `enableOrchestrator` was left off. When BOTH `enableAgentRuntime`
 *   AND `enableOrchestrator` are set, this function additionally calls
 *   `mesh-orchestrator-tools.mjs`'s `registerOrchestratorTools(node.toolRegistry,
 *   node.orchestrator.api)` (Phase 4, issue #92), pre-populating the registry
 *   with the 8 real `Meshctl*Tool`s (`meshctl_pods`/`meshctl_status`/
 *   `meshctl_exec`/`meshctl_deploy`/`meshctl_top`/`meshctl_compute`/
 *   `meshctl_expose`/`meshctl_drain`) wired against this node's own attached
 *   orchestrator -- see `mesh-orchestrator-tools.mjs`'s own doc comment for
 *   exactly which of those 8 route through the orchestrator service's gated
 *   wire dispatch (`meshctl_exec`/`meshctl_deploy`/`meshctl_drain`) vs.
 *   straight to the raw `MeshOrchestrator` instance (the rest -- including
 *   `meshctl_compute`/`meshctl_expose`, which have no gated equivalent at
 *   all, since Phase 3 never built one for either). `enableOrchestrator` set
 *   WITHOUT `enableAgentRuntime` is unaffected -- `node.toolRegistry` is only
 *   ever created when `enableAgentRuntime` itself is set.
 * @returns {Promise<PeerNode>} A booted (unless `skipBoot`) PeerNode, with
 *   `node.meshManager` (`WebRTCMeshManager`), `node.signaling`
 *   (`MeshSignalingChannel`), and `node.transportNegotiator` (the real,
 *   unwrapped `MeshTransportNegotiator` -- see `enableHardening` below)
 *   attached for callers/tests that need lower-level
 *   access beyond what `PeerNode`'s own API exposes, `node.sync`
 *   (`MeshSyncBinding`, see `mesh-sync.mjs`) attached when `enableSync`,
 *   `node.relayHost` (`MeshRelayHost`, see `mesh-relay-host.mjs`) attached
 *   when `enableRelayHost`, `node.services` (a `Map<string, { name,
 *   backendScheme, api, teardown }>`, see `mesh-service.mjs`) populated from
 *   `options.services` (always present, empty when `options.services` is
 *   omitted), `node.auditChain` (`AuditChain`, see `audit.mjs`) attached
 *   when `enableAudit` or `options.auditChain` is supplied (left unset
 *   otherwise), `node.hardening`/`node.transportMetrics` attached when
 *   `enableHardening`, `node.dht` (`DhtDiscoveryStrategy`, see
 *   `mesh-dht.mjs`) attached when `enableDht`, `node.healthCheck`
 *   (`attachService()`'s handle for `mesh-keepalive.mjs`, also reachable via
 *   `node.services.get('keepalive')`) attached when `enableHealthCheck`,
 *   `node.router` (`attachService()`'s handle for `peer-routing.mjs`'s
 *   `createMeshRoutingService()`, also reachable via
 *   `node.services.get('mesh-routing')`) attached when `enableRouting`,
 *   `node.timestamp` (`attachService()`'s handle for `mesh-timestamp.mjs`,
 *   also reachable via `node.services.get('timestamp')`) attached when
 *   `enableTimestamp`, `node.healthMonitor` (`attachService()`'s handle
 *   for `mesh-health.mjs`, also reachable via
 *   `node.services.get('health-monitor')`) attached when
 *   `enableHealthMonitor`, `node.ipfs` (`attachService()`'s handle for
 *   `peer-ipfs.mjs`'s `createIpfsService()`, also reachable via
 *   `node.services.get('peer-ipfs')`) attached when `enableIpfs`, and
 *   `node.verification` (`attachService()`'s handle for
 *   `mesh-verification.mjs`, also reachable via
 *   `node.services.get('verification')`) attached when `enableVerification`.
 *   `node.torrent` (`attachService()`'s handle for `mesh-torrent.mjs`, also
 *   reachable via `node.services.get('torrent')`) attached when `enableTorrent`.
 *   `node.fileShare` (`attachService()`'s handle for `peer-files.mjs`'s
 *   `createFileShareService()`, also reachable via
 *   `node.services.get('file-share')`) attached when `enableFileShare`.
 *   `node.escrow` (`attachService()`'s handle for `peer-escrow.mjs`'s
 *   `createEscrowService()`, also reachable via `node.services.get('escrow')`)
 *   attached when `enableEscrow`.
 *   `node.chat` (`attachService()`'s handle for `peer-chat.mjs`'s
 *   `createChatService()`, also reachable via `node.services.get('chat')`)
 *   attached when `enableChat`.
 *   `node.compute` (`attachService()`'s handle for `mesh-compute.mjs`'s
 *   `createComputeService()`, also reachable via `node.services.get('compute')`)
 *   attached when `enableCompute`.
 *   `node.orchestrator` (`attachService()`'s handle for `mesh-orchestrator.mjs`'s
 *   `createOrchestratorService()`, also reachable via
 *   `node.services.get('orchestrator')`) attached when `enableOrchestrator`.
 *   `node.toolRegistry` (a `BrowserToolRegistry`, `compat.mjs`) attached when
 *   `enableAgentRuntime` -- empty unless `enableOrchestrator` is ALSO set, in
 *   which case it is pre-populated with the 8 `Meshctl*Tool`s (see
 *   `enableAgentRuntime` above and `mesh-orchestrator-tools.mjs`).
 */
export async function createMeshNode(options = {}) {
  const {
    label = 'default',
    identityManager: providedIdentityManager,
    peerManager,
    trustGraph,
    acl,
    capabilityValidator,
    discoveryStrategies,
    discoveryChannelName = 'mesh-discovery',
    announceInterval,
    capabilities = [],
    signalingTransport,
    iceServers,
    enableAudit = false,
    auditChain: providedAuditChain,
    auditChainId,
    onLog = () => {},
    skipDiscovery = false,
    skipBoot = false,
    enableSync = false,
    syncStorage,
    syncDbName,
    syncEnvelopeType,
    syncAutoLoad = true,
    enableRelayHost = false,
    relayHostNetwork,
    relayHostServices,
    relayHostEnvelopeType,
    services,
    servicesNetwork,
    enableHardening = false,
    hardeningOptions,
    enableDht = false,
    dhtBootstrapPeers = [],
    dhtK,
    dhtMessageType,
    enableHealthCheck = false,
    healthCheckOptions,
    enableRouting = false,
    routingOptions,
    enableTimestamp = false,
    timestampOptions,
    enableHealthMonitor = false,
    healthMonitorOptions,
    enableIpfs = false,
    ipfsOptions,
    enableVerification = false,
    verificationOptions,
    enableTorrent = false,
    torrentOptions,
    enableFileShare = false,
    fileShareOptions,
    enableEscrow = false,
    escrowOptions,
    enableChat = false,
    chatOptions,
    enableCompute = false,
    computeOptions,
    enableTerminal = false,
    terminalOptions,
    enableSwarm = false,
    swarmOptions,
    enableAgentSwarm = false,
    agentSwarmOptions,
    enableOrchestrator = false,
    orchestratorOptions,
    enableAgentRuntime = false,
  } = options

  if (!signalingTransport) {
    throw new Error(
      'createMeshNode: options.signalingTransport is required (an injectable ' +
      'bidirectional bus for WebRTC offer/answer/ICE relay -- see signaling.mjs)',
    )
  }

  // @johnhenry/browsermesh-core/-discovery/-transport (all optional
  // peerDependencies) are imported lazily here, not eagerly at module
  // top-level, so this module doesn't force them on every consumer of
  // this package's top-level `.` entrypoint -- see the CHANGELOG entry
  // documenting this fix. createMeshNode() was already async, so this
  // adds no signature change.
  const [
    { IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL, CapabilityValidator, CapabilityToken },
    { DiscoveryManager, DiscoveryRecord, BroadcastChannelStrategy },
    { MeshTransportNegotiator, WebRTCMeshManager, mergeIceServers },
  ] = await Promise.all([
    import('@johnhenry/browsermesh-core'),
    import('@johnhenry/browsermesh-discovery'),
    import('@johnhenry/browsermesh-transport'),
  ])

  // -- Identity ---------------------------------------------------------
  const identityManager = providedIdentityManager || new MeshIdentityManager({ onLog })
  const wallet = new IdentityWallet({ identityManager, onLog })
  const { podId } = await wallet.createIdentity(label)

  // -- Audit chain (opt-in, boolean enableAudit or pass-your-own via
  // auditChain) -- resolved here, before PeerNode is constructed, since
  // (unlike sync/relayHost) PeerNode takes it as a constructor-time
  // dependency rather than something attached to the node afterwards.
  const auditChain = providedAuditChain
    || (enableAudit ? new AuditChain(auditChainId || `audit-${podId}`) : undefined)

  // -- Registry (peers + trust + ACL + capability tokens) -----------------
  // capabilityValidator/tokenFactory back Phase 5's real granting/revocation
  // path (see peer-registry.mjs's grantCapabilities()/revokeCapabilities()/
  // checkAccess()) with the genuine, tested `-core` classes rather than
  // PeerRegistry's in-package duck-typed defaults.
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: peerManager || new MeshPeerManager({ onLog }),
    trustGraph: trustGraph || new TrustGraph(),
    acl: acl || new MeshACL({ owner: podId, onLog }),
    capabilityValidator: capabilityValidator || new CapabilityValidator(),
    tokenFactory: (tokenOpts) => new CapabilityToken(tokenOpts),
    onLog,
  })

  // -- Discovery ----------------------------------------------------------
  let strategies = discoveryStrategies
  if (!strategies) {
    if (typeof BroadcastChannel === 'undefined' && !enableDht) {
      throw new Error(
        'createMeshNode: no options.discoveryStrategies supplied and BroadcastChannel ' +
        'is not available in this environment (e.g. Node). Pass a Node-safe strategy, ' +
        'such as [new ManualStrategy()] from @johnhenry/browsermesh-discovery, or set ' +
        '{ enableDht: true, dhtBootstrapPeers } instead.',
      )
    }
    strategies = typeof BroadcastChannel !== 'undefined'
      ? [new BroadcastChannelStrategy({ channelName: discoveryChannelName })]
      : []
  }

  // -- DHT discovery (opt-in, Phase D, issue #87) --------------------------
  // DhtDiscoveryStrategy has no transport of its own (see mesh-dht.mjs's
  // header) -- its wire traffic is multiplexed onto signalingTransport, the
  // same bus already required for WebRTC offer/answer/ICE relay, since it's
  // the one thing here that already reaches arbitrary podIds pre-connection.
  // shareTransport() wraps it so both MeshSignalingChannel (below) and the
  // DHT strategy can subscribe independently -- most real transports only
  // support one onMessage() subscriber at a time.
  let effectiveSignalingTransport = signalingTransport
  let dht = null
  if (enableDht) {
    effectiveSignalingTransport = shareTransport(signalingTransport)
    dht = createMeshDht({
      localPodId: podId,
      transport: effectiveSignalingTransport,
      bootstrapPeers: dhtBootstrapPeers,
      k: dhtK,
      messageType: dhtMessageType,
      onLog,
    })
    strategies.push(dht.strategy)
  }

  const localRecord = new DiscoveryRecord({
    podId,
    label,
    transport: 'webrtc',
    capabilities,
  })
  const discoveryOpts = { strategies, localRecord }
  if (announceInterval !== undefined) discoveryOpts.announceInterval = announceInterval
  const discovery = new DiscoveryManager(discoveryOpts)

  // -- WebRTC transport negotiator -----------------------------------------
  // mergeIceServers() is webrtc.mjs's own extension point: it honours an
  // explicit `[]` as "no ICE servers" (used by this package's real-peer
  // test for a hermetic, loopback-only connection) and otherwise merges any
  // caller-supplied servers (typically TURN) alongside DEFAULT_ICE_SERVERS
  // (empty by default), filtering out malformed entries rather than handing
  // them straight to WebRTCMeshManager.
  const meshManager = new WebRTCMeshManager({ localPodId: podId, iceServers: mergeIceServers(iceServers), onLog })
  const signaling = new MeshSignalingChannel({ localPodId: podId, transport: effectiveSignalingTransport, onLog })
  await signaling.open()

  // The negotiator is constructed (and handed to PeerNode) before its
  // 'webrtc' adapter is registered -- registerAdapter() only needs to run
  // before connectToPeer() is actually called at runtime, not before
  // PeerNode's constructor captures the negotiator reference. This
  // ordering is what lets the webrtc factory's onIncomingConnection hook
  // below close over `node` and call PeerNode.adoptIncomingSession() --
  // resolving the callee-side session gap (see peer-node.mjs / Phase 3).
  const transportNegotiator = new MeshTransportNegotiator()

  // -- Transport hardening (opt-in) -----------------------------------------
  // Wrapping happens before PeerNode is constructed, but adapter
  // registration (below, after PeerNode's construction) still targets
  // `transportNegotiator` -- the real, unwrapped instance -- directly:
  // `createHardenedNegotiator()`'s returned `negotiate()` closes over that
  // same `transportNegotiator` reference, so it sees adapters registered on
  // it regardless of when registration happens relative to wrapping.
  const hardening = enableHardening
    ? await createHardenedNegotiator({
      negotiator: transportNegotiator,
      retryOptions: hardeningOptions?.retry,
      onLog,
    })
    : null

  // -- PeerNode -------------------------------------------------------------
  const node = new PeerNode({
    wallet,
    registry,
    discovery,
    transportNegotiator: hardening ? hardening : transportNegotiator,
    auditChain,
    onLog,
  })

  const webrtcFactory = createWebRTCTransportFactory({
    localPodId: podId,
    meshManager,
    signaling,
    onLog,
    // Callee side: once an auto-answered inbound offer's DataChannel opens,
    // give it the same PeerNode-level session bookkeeping connectToPeer()
    // gives the caller side, so sendTo()/onIncomingData() work symmetrically
    // regardless of which side dialed.
    onIncomingConnection: (remotePodId, adapter, connectionId) => {
      node.adoptIncomingSession(remotePodId, adapter, 'webrtc', { connectionId }).catch((err) => {
        onLog('mesh-bootstrap:adopt-incoming-session-failed', {
          remotePodId,
          connectionId,
          error: err?.message || String(err),
        })
      })
    },
  })
  transportNegotiator.registerAdapter('webrtc', webrtcFactory)

  if (!skipBoot) {
    await node.boot({ label, skipDiscovery })
  }

  // Not part of PeerNode's own API surface, but real callers/tests
  // occasionally need direct access below the PeerNode abstraction
  // (e.g. to inspect connection stats, close the signaling bus, or register
  // an additional transport adapter directly -- registering on this real,
  // unwrapped negotiator works identically whether or not enableHardening
  // wrapped it for PeerNode's own use, since the wrapper closes over this
  // same instance).
  node.meshManager = meshManager
  node.signaling = signaling
  node.transportNegotiator = transportNegotiator

  // -- Audit chain (opt-in) --------------------------------------------------
  // Attached for inspection/verification, mirroring node.sync/node.relayHost's
  // convention. Left unset (not even `null`) when neither enableAudit nor
  // auditChain was supplied, matching those subsystems' "absent means never
  // opted in" contract -- PeerNode's own #audit() already no-ops in that case.
  if (auditChain) {
    node.auditChain = auditChain
  }

  // -- DHT discovery (opt-in, Phase D, issue #87) -----------------------------
  if (dht) {
    node.dht = dht.strategy
  }

  // -- CRDT sync (opt-in, Phase 3) -------------------------------------------
  if (enableSync) {
    node.sync = createMeshSync({
      node,
      storage: syncStorage,
      dbName: syncDbName,
      envelopeType: syncEnvelopeType,
      onLog,
    })
    if (syncAutoLoad) {
      await node.sync.load()
    }
  }

  // -- Mesh relay host (opt-in, Phase 8) -------------------------------------
  if (enableRelayHost) {
    if (!relayHostNetwork) {
      throw new Error(
        'createMeshNode: options.relayHostNetwork is required when enableRelayHost is true ' +
        '(the VirtualNetwork MeshRelayHost bridges inbound relay connections into).',
      )
    }
    node.relayHost = new MeshRelayHost({
      node,
      network: relayHostNetwork,
      registry,
      envelopeType: relayHostEnvelopeType,
      onLog,
    })
    if (relayHostServices) {
      for (const [name, targetAddress] of Object.entries(relayHostServices)) {
        node.relayHost.exposeService(name, targetAddress)
      }
    }
  }

  // -- Mesh-native services (opt-in, Phase C) --------------------------------
  // `node.services` is always present (empty when `services` is omitted) so
  // callers never need to null-check it before looking up an attached
  // service by name.
  node.services = new Map()
  if (services) {
    for (const descriptor of services) {
      const handle = attachService(node, servicesNetwork, descriptor)
      node.services.set(handle.name, handle)
    }
  }

  // -- Transport hardening (opt-in) -----------------------------------------
  if (hardening) {
    node.hardening = hardening
    node.transportMetrics = hardening.metrics
  }

  // -- Transport health check / keepalive (opt-in, issue #110) --------------
  // Attached the same way options.services entries are (attachService()),
  // just after -- so node.services already has whatever the caller listed
  // in options.services before this one is added under the 'keepalive' key.
  // Passing the local `hardening` variable (not node.hardening) directly:
  // both are the same value when enableHardening is on, and mesh-keepalive.mjs
  // itself handles `hardening` being undefined (enableHardening off) by
  // skipping failover integration entirely -- see that file's own header
  // comment.
  if (enableHealthCheck) {
    const keepaliveDescriptor = createMeshKeepaliveService({
      intervalMs: healthCheckOptions?.intervalMs,
      timeoutMs: healthCheckOptions?.timeoutMs,
      maxMissed: healthCheckOptions?.maxMissed,
      hardening,
      onLog,
    })
    const keepaliveHandle = attachService(node, servicesNetwork, keepaliveDescriptor)
    node.services.set(keepaliveHandle.name, keepaliveHandle)
    node.healthCheck = keepaliveHandle
  }

  // -- Multi-hop mesh routing (opt-in, issue #121) ---------------------------
  // Attached the same way options.services/enableHealthCheck entries are
  // (attachService()), just after -- so node.services already has whatever
  // the caller listed in options.services (plus 'keepalive', if enabled)
  // before this one is added under createMeshRoutingService()'s own
  // 'mesh-routing' name.
  if (enableRouting) {
    const routingDescriptor = createMeshRoutingService({
      ...routingOptions,
      onLog: routingOptions?.onLog ?? onLog,
    })
    const routingHandle = attachService(node, servicesNetwork, routingDescriptor)
    node.services.set(routingHandle.name, routingHandle)
    node.router = routingHandle
  }

  // -- Signed consensus timestamping (opt-in, Phase 1, issue #120) ----------
  // Attached the same way enableHealthCheck's keepalive service is above --
  // see mesh-timestamp.mjs's own header comment for the full design.
  if (enableTimestamp) {
    const timestampDescriptor = createTimestampService({
      identity: timestampOptions?.identity,
      clockSkewMs: timestampOptions?.clockSkewMs,
      witnessTimeoutMs: timestampOptions?.witnessTimeoutMs,
      envelopeType: timestampOptions?.envelopeType,
      onLog,
    })
    const timestampHandle = attachService(node, servicesNetwork, timestampDescriptor)
    node.services.set(timestampHandle.name, timestampHandle)
    node.timestamp = timestampHandle
  }

  // -- Peer health monitoring / auto-migration (opt-in, Phase 1, issue #120) -
  // Attached the same way enableHealthCheck's keepalive service is above --
  // see mesh-health.mjs's own header comment for the full design. Distinct
  // from enableHealthCheck's transport-level keepalive: this is
  // application-level heartbeat liveness (peer-health.mjs's HealthMonitor),
  // with opt-in workload auto-migration on failure.
  if (enableHealthMonitor) {
    const healthMonitorDescriptor = createHealthMonitorService({
      trust: healthMonitorOptions?.trust,
      orchestrator: healthMonitorOptions?.orchestrator,
      resolveWorkload: healthMonitorOptions?.resolveWorkload,
      intervalMs: healthMonitorOptions?.intervalMs,
      thresholds: healthMonitorOptions?.thresholds,
      onLog,
    })
    const healthMonitorHandle = attachService(node, servicesNetwork, healthMonitorDescriptor)
    node.services.set(healthMonitorHandle.name, healthMonitorHandle)
    node.healthMonitor = healthMonitorHandle
  }

  // -- Mesh-local IPFS-style content storage (opt-in, Phase 6, issue #123) --
  // Attached the same way the other opt-in services above are
  // (attachService()) -- see peer-ipfs.mjs's own header comment for why this
  // is NOT real IPFS-network interop despite the name.
  if (enableIpfs) {
    const ipfsDescriptor = createIpfsService({
      enabled: ipfsOptions?.enabled,
      maxStorageMb: ipfsOptions?.maxStorageMb,
      onLog: ipfsOptions?.onLog ?? onLog,
    })
    const ipfsHandle = attachService(node, servicesNetwork, ipfsDescriptor)
    node.services.set(ipfsHandle.name, ipfsHandle)
    node.ipfs = ipfsHandle
  }

  // -- Quorum-based job-result verification (opt-in, Phase 4, issue #119) ---
  // Attached the same way enableTimestamp/enableHealthMonitor's services are
  // above -- see mesh-verification.mjs's own header comment for the full
  // design (in particular, why executeFn is required-but-not-provided for
  // this node to usefully serve as a verifier).
  if (enableVerification) {
    const verificationDescriptor = createVerificationService({
      scheduler: verificationOptions?.scheduler,
      trust: verificationOptions?.trust,
      executeFn: verificationOptions?.executeFn,
      dispatchTimeoutMs: verificationOptions?.dispatchTimeoutMs,
      envelopeType: verificationOptions?.envelopeType,
      accessResource: verificationOptions?.accessResource,
      accessAction: verificationOptions?.accessAction,
      onLog: verificationOptions?.onLog ?? onLog,
    })
    const verificationHandle = attachService(node, servicesNetwork, verificationDescriptor)
    node.services.set(verificationHandle.name, verificationHandle)
    node.verification = verificationHandle
  }

  // -- Mesh-native swarm torrent distribution (opt-in, Phase 5, issue #122) --
  // Attached the same way enableHealthCheck's keepalive service is above --
  // see mesh-torrent.mjs's own header comment for the full design.
  if (enableTorrent) {
    const torrentDescriptor = createTorrentService({
      trackerUrl: torrentOptions?.trackerUrl,
      chunkSize: torrentOptions?.chunkSize,
      envelopeType: torrentOptions?.envelopeType,
      manifestTimeoutMs: torrentOptions?.manifestTimeoutMs,
      chunkTimeoutMs: torrentOptions?.chunkTimeoutMs,
      onLog,
    })
    const torrentHandle = attachService(node, servicesNetwork, torrentDescriptor)
    node.services.set(torrentHandle.name, torrentHandle)
    node.torrent = torrentHandle
  }

  // -- Remote file access (opt-in, Phase 8, issue #84) -----------------------
  // Attached the same way every other opt-in service above is
  // (attachService()) -- see peer-files.mjs's own header comment for the
  // full migration writeup (this used to depend on peer-session.mjs's
  // PeerSession, now runs on ctx.sendTo()/ctx.onIncomingData() like
  // everything else here).
  if (enableFileShare) {
    const fileShareDescriptor = createFileShareService({
      fs: fileShareOptions?.fs,
      maxFileSize: fileShareOptions?.maxFileSize,
      timeout: fileShareOptions?.timeout,
      resource: fileShareOptions?.resource,
      requestEnvelopeType: fileShareOptions?.requestEnvelopeType,
      responseEnvelopeType: fileShareOptions?.responseEnvelopeType,
      onLog,
    })
    const fileShareHandle = attachService(node, servicesNetwork, fileShareDescriptor)
    node.services.set(fileShareHandle.name, fileShareHandle)
    node.fileShare = fileShareHandle
  }

  // -- Escrow (real credit/payment holds, opt-in, issue #117) ----------------
  // Attached the same way options.services/enableHealthCheck/enableRouting/
  // enableTimestamp/enableHealthMonitor/enableIpfs entries are
  // (attachService()), just after -- so node.services already has whatever
  // the caller listed in options.services (plus 'keepalive'/'mesh-routing'/
  // 'timestamp'/'health-monitor'/'peer-ipfs', if enabled) before this one is
  // added under createEscrowService()'s own 'escrow' name. Unlike
  // enableRouting, creditLedger has no sensible default (there is no
  // "default ledger" the way there's a default MeshACL/TrustGraph) --
  // mirrors enableRelayHost's own required-dependency check for
  // relayHostNetwork.
  if (enableEscrow) {
    if (!escrowOptions?.creditLedger) {
      throw new Error(
        'createMeshNode: options.escrowOptions.creditLedger is required when enableEscrow is true ' +
        '(must implement charge()/credit()/getBalance() -- see peer-escrow.mjs\'s EscrowManager).',
      )
    }
    const escrowDescriptor = createEscrowService({
      ...escrowOptions,
      onLog: escrowOptions?.onLog ?? onLog,
    })
    const escrowHandle = attachService(node, servicesNetwork, escrowDescriptor)
    node.services.set(escrowHandle.name, escrowHandle)
    node.escrow = escrowHandle
  }

  // -- P2P chat (opt-in, Phase 9 of the browsermesh-app-layer-migration
  // plan, issue #84) --------------------------------------------------------
  // Attached the same way enableHealthCheck's keepalive service is above --
  // see peer-chat.mjs's own header comment for the full design (migration
  // off PeerSession, not a fresh wire-up).
  if (enableChat) {
    const chatDescriptor = createChatService({
      signFn: chatOptions?.signFn,
      verifyFn: chatOptions?.verifyFn,
      maxHistory: chatOptions?.maxHistory,
      autoResponder: chatOptions?.autoResponder,
      onLog: chatOptions?.onLog ?? onLog,
    })
    const chatHandle = attachService(node, servicesNetwork, chatDescriptor)
    node.services.set(chatHandle.name, chatHandle)
    node.chat = chatHandle
  }

  // -- Federated compute (opt-in, Phase 11 of the browsermesh-app-layer-
  // migration plan, issue #118) ----------------------------------------------
  // Attached the same way options.services/enableEscrow/enableVerification
  // entries are (attachService()), just after -- see mesh-compute.mjs's own
  // header comment for the full design (in particular why executeFn is
  // REQUIRED here, unlike enableVerification's optional executeFn). Mirrors
  // enableEscrow's required-dependency check for escrowOptions.creditLedger:
  // there is no default execution backend anywhere in this repo (issue #86's
  // resolved design pass), so a compute-only node with no way to ever serve
  // a chunk has little practical use.
  if (enableCompute) {
    if (typeof computeOptions?.executeFn !== 'function') {
      throw new Error(
        'createMeshNode: options.computeOptions.executeFn is required when enableCompute is true ' +
        '(a function (job) => Promise<result> that actually runs an inbound, authorized compute ' +
        'chunk -- see mesh-compute.mjs\'s createComputeService() for why this is never defaulted).',
      )
    }
    const computeDescriptor = createComputeService({
      scheduler: computeOptions?.scheduler,
      listAvailablePeers: computeOptions?.listAvailablePeers,
      splitFn: computeOptions?.splitFn,
      mergeFn: computeOptions?.mergeFn,
      executeFn: computeOptions?.executeFn,
      dispatchTimeoutMs: computeOptions?.dispatchTimeoutMs,
      envelopeType: computeOptions?.envelopeType,
      accessResource: computeOptions?.accessResource,
      accessAction: computeOptions?.accessAction,
      onLog: computeOptions?.onLog ?? onLog,
    })
    const computeHandle = attachService(node, servicesNetwork, computeDescriptor)
    node.services.set(computeHandle.name, computeHandle)
    node.compute = computeHandle
  }

  // -- Remote terminal/shell execution (opt-in, Phase 10 of the
  // browsermesh-app-layer-migration plan, issue #84, unblocked by issue #86) -
  // Attached the same way options.services/enableHealthCheck/enableRouting/
  // enableTimestamp/enableHealthMonitor/enableIpfs/enableEscrow entries are
  // (attachService()), just after -- so node.services already has whatever
  // the caller listed in options.services (plus any other enabled services)
  // before this one is added under createTerminalService()'s own 'terminal'
  // name. Unlike enableRouting, `shell` has no sensible default (no
  // `child_process`, no OS command execution shipped by this package) --
  // mirrors enableEscrow's own required-dependency check for
  // escrowOptions.creditLedger (issue #86's resolved "bring-your-own,
  // required, no default" execution-backend decision).
  if (enableTerminal) {
    if (!terminalOptions?.shell) {
      throw new Error(
        'createMeshNode: options.terminalOptions.shell is required when enableTerminal is true ' +
        '(must implement execute(command) -> {output, exitCode} -- see peer-terminal.mjs\'s TerminalHost). ' +
        'No default shell is provided by this package.',
      )
    }
    const terminalDescriptor = createTerminalService({
      shell: terminalOptions.shell,
      allowedCommands: terminalOptions?.allowedCommands,
      blockedCommands: terminalOptions?.blockedCommands,
      maxOutputLength: terminalOptions?.maxOutputLength,
      timeout: terminalOptions?.timeout,
      accessResource: terminalOptions?.accessResource,
      accessAction: terminalOptions?.accessAction,
      requestEnvelopeType: terminalOptions?.requestEnvelopeType,
      responseEnvelopeType: terminalOptions?.responseEnvelopeType,
      onLog: terminalOptions?.onLog ?? onLog,
    })
    const terminalHandle = attachService(node, servicesNetwork, terminalDescriptor)
    node.services.set(terminalHandle.name, terminalHandle)
    node.terminal = terminalHandle
  }

  // -- SWIM cluster membership + leader election + task distribution
  // (opt-in, issue #88) -----------------------------------------------------
  // Attached the same way every other opt-in service above is
  // (attachService()) -- see mesh-swarm.mjs's own header comment for the
  // full design (SWIM bridge, single-slot callback composition, the leader
  // election heartbeat pump, and the SWARM_JOIN/SWARM_LEAVE/SWARM_TASK_ASSIGN
  // wire use).
  if (enableSwarm) {
    const swarmDescriptor = createSwarmService({
      heartbeatMs: swarmOptions?.heartbeatMs,
      electionTimeoutMs: swarmOptions?.electionTimeoutMs,
      swimOptions: swarmOptions?.swimOptions,
      swimEnvelopeType: swarmOptions?.swimEnvelopeType,
      heartbeatEnvelopeType: swarmOptions?.heartbeatEnvelopeType,
      membershipEnvelopeType: swarmOptions?.membershipEnvelopeType,
      taskEnvelopeType: swarmOptions?.taskEnvelopeType,
      accessResource: swarmOptions?.accessResource,
      requestTimeoutMs: swarmOptions?.requestTimeoutMs,
      onLog: swarmOptions?.onLog ?? onLog,
    })
    const swarmHandle = attachService(node, servicesNetwork, swarmDescriptor)
    node.services.set(swarmHandle.name, swarmHandle)
    node.swarm = swarmHandle
  }

  // -- Multi-agent goal decomposition/assignment/execution (opt-in,
  // issue #124) --------------------------------------------------------------
  // Attached the same way every other opt-in service above is
  // (attachService()) -- see mesh-agent-swarm.mjs's own header comment for
  // the full design (the meshAgentProxy local-vs-remote wrapper that gives
  // executeSubTask() a real cross-peer dispatch path, and why agentProxy is
  // required unconditionally, unlike enableVerification's optional
  // executeFn). Mirrors enableCompute's/enableTerminal's required-dependency
  // check: AgentSwarmCoordinator's own constructor throws on a missing
  // agentProxy, but this file always hands it an always-truthy
  // meshAgentProxy wrapper, so that check alone can never catch a caller who
  // omitted the real one -- check explicitly here too, before any service is
  // attached.
  if (enableAgentSwarm) {
    if (!agentSwarmOptions?.agentProxy) {
      throw new Error(
        'createMeshNode: options.agentSwarmOptions.agentProxy is required when enableAgentSwarm is true ' +
        '(must implement async chat(podId, message) -> string -- see peer-agent-swarm.mjs\'s AgentSwarmCoordinator). ' +
        'No default agentProxy is provided by this package.',
      )
    }
    const agentSwarmDescriptor = createAgentSwarmService({
      agentProxy: agentSwarmOptions.agentProxy,
      dispatchTimeoutMs: agentSwarmOptions?.dispatchTimeoutMs,
      envelopeType: agentSwarmOptions?.envelopeType,
      accessResource: agentSwarmOptions?.accessResource,
      accessAction: agentSwarmOptions?.accessAction,
      onLog: agentSwarmOptions?.onLog ?? onLog,
    })
    const agentSwarmHandle = attachService(node, servicesNetwork, agentSwarmDescriptor)
    node.services.set(agentSwarmHandle.name, agentSwarmHandle)
    node.agentSwarm = agentSwarmHandle
  }

  // -- Pod orchestration (opt-in, Phase 3 of the agent-runtime plan,
  // issue #92) --------------------------------------------------------------
  // Attached the same way every other opt-in service above is
  // (attachService()) -- see mesh-orchestrator.mjs's own header comment for
  // the full design (the local-vs-remote dispatch shortcut for
  // execOnPod/deploySkill/drainPod, the checkAccess() gate, why
  // listPods/getPodStatus/topPods stay ungated, the router
  // shape-compatibility finding, and the confirmed non-relationship with
  // enableSwarm). Unlike enableCompute/enableTerminal/enableAgentSwarm,
  // MeshOrchestrator has no required bring-your-own execution backend --
  // its own constructor already defaults every collaborator (router,
  // runtimeRegistry, remoteSessionBroker, resourceRegistry, auditRecorder)
  // to null and stays usable (local-only) with none of them wired -- so
  // there is nothing to throw on here. `router` defaults to `node.router?.api`
  // when enableRouting also attached one and the caller didn't already
  // supply (or explicitly null out) orchestratorOptions.router.
  if (enableOrchestrator) {
    const orchestratorRouter = orchestratorOptions && 'router' in orchestratorOptions
      ? orchestratorOptions.router
      : (node.router?.api ?? null)
    const orchestratorDescriptor = createOrchestratorService({
      router: orchestratorRouter,
      runtimeRegistry: orchestratorOptions?.runtimeRegistry,
      remoteSessionBroker: orchestratorOptions?.remoteSessionBroker,
      resourceRegistry: orchestratorOptions?.resourceRegistry,
      auditRecorder: orchestratorOptions?.auditRecorder,
      dispatchTimeoutMs: orchestratorOptions?.dispatchTimeoutMs,
      envelopeType: orchestratorOptions?.envelopeType,
      accessResource: orchestratorOptions?.accessResource,
      onLog: orchestratorOptions?.onLog ?? onLog,
    })
    const orchestratorHandle = attachService(node, servicesNetwork, orchestratorDescriptor)
    node.services.set(orchestratorHandle.name, orchestratorHandle)
    node.orchestrator = orchestratorHandle
  }

  // -- Agent tool registry (opt-in, Phase 4 of the agent-runtime plan,
  // issues #90/#92) -----------------------------------------------------
  // Deliberately independent of enableOrchestrator -- see enableAgentRuntime's
  // own doc comment above for the full rationale. node.toolRegistry always
  // exists (and is always empty at minimum) when this flag is set, so a
  // caller wanting only its own non-orchestrator BrowserTools never has to
  // opt into orchestrator wiring it doesn't want. Only pre-populated with the
  // 8 real Meshctl*Tools when enableOrchestrator was ALSO set -- see
  // mesh-orchestrator-tools.mjs's own doc comment for exactly which of those
  // route through the orchestrator service's gated wire dispatch.
  if (enableAgentRuntime) {
    node.toolRegistry = new BrowserToolRegistry()
    if (enableOrchestrator) {
      registerOrchestratorTools(node.toolRegistry, node.orchestrator.api)
    }
  }

  return node
}
