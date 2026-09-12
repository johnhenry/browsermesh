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
 * `MeshRelayBackend`, constructed directly (not via this function) and
 * registered on the *client's own* `VirtualNetwork`.
 *
 * No browser-only imports at module level.
 */

import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'
import {
  DiscoveryManager,
  DiscoveryRecord,
  BroadcastChannelStrategy,
} from '@johnhenry/browsermesh-discovery'
import {
  MeshTransportNegotiator,
  WebRTCMeshManager,
  mergeIceServers,
} from '@johnhenry/browsermesh-transport'

import { PeerNode } from './peer-node.mjs'
import { PeerRegistry } from './peer-registry.mjs'
import { MeshSignalingChannel } from './signaling.mjs'
import { createWebRTCTransportFactory } from './webrtc-negotiator.mjs'
import { createMeshSync } from './mesh-sync.mjs'
import { MeshRelayHost } from './mesh-relay-host.mjs'

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
 * @param {import('./audit.mjs').AuditChain} [options.auditChain]
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
 * @returns {Promise<PeerNode>} A booted (unless `skipBoot`) PeerNode, with
 *   `node.meshManager` (`WebRTCMeshManager`) and `node.signaling`
 *   (`MeshSignalingChannel`) attached for callers/tests that need lower-level
 *   access beyond what `PeerNode`'s own API exposes, `node.sync`
 *   (`MeshSyncBinding`, see `mesh-sync.mjs`) attached when `enableSync`, and
 *   `node.relayHost` (`MeshRelayHost`, see `mesh-relay-host.mjs`) attached
 *   when `enableRelayHost`.
 */
export async function createMeshNode(options = {}) {
  const {
    label = 'default',
    identityManager: providedIdentityManager,
    peerManager,
    trustGraph,
    acl,
    discoveryStrategies,
    discoveryChannelName = 'mesh-discovery',
    announceInterval,
    capabilities = [],
    signalingTransport,
    iceServers,
    auditChain,
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
  } = options

  if (!signalingTransport) {
    throw new Error(
      'createMeshNode: options.signalingTransport is required (an injectable ' +
      'bidirectional bus for WebRTC offer/answer/ICE relay -- see signaling.mjs)',
    )
  }

  // -- Identity ---------------------------------------------------------
  const identityManager = providedIdentityManager || new MeshIdentityManager({ onLog })
  const wallet = new IdentityWallet({ identityManager, onLog })
  const { podId } = await wallet.createIdentity(label)

  // -- Registry (peers + trust + ACL) ------------------------------------
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: peerManager || new MeshPeerManager({ onLog }),
    trustGraph: trustGraph || new TrustGraph(),
    acl: acl || new MeshACL({ owner: podId, onLog }),
    onLog,
  })

  // -- Discovery ----------------------------------------------------------
  let strategies = discoveryStrategies
  if (!strategies) {
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error(
        'createMeshNode: no options.discoveryStrategies supplied and BroadcastChannel ' +
        'is not available in this environment (e.g. Node). Pass a Node-safe strategy, ' +
        'such as [new ManualStrategy()] from @johnhenry/browsermesh-discovery.',
      )
    }
    strategies = [new BroadcastChannelStrategy({ channelName: discoveryChannelName })]
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
  const signaling = new MeshSignalingChannel({ localPodId: podId, transport: signalingTransport, onLog })
  await signaling.open()

  // The negotiator is constructed (and handed to PeerNode) before its
  // 'webrtc' adapter is registered -- registerAdapter() only needs to run
  // before connectToPeer() is actually called at runtime, not before
  // PeerNode's constructor captures the negotiator reference. This
  // ordering is what lets the webrtc factory's onIncomingConnection hook
  // below close over `node` and call PeerNode.adoptIncomingSession() --
  // resolving the callee-side session gap (see peer-node.mjs / Phase 3).
  const transportNegotiator = new MeshTransportNegotiator()

  // -- PeerNode -------------------------------------------------------------
  const node = new PeerNode({
    wallet,
    registry,
    discovery,
    transportNegotiator,
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
    onIncomingConnection: (remotePodId, adapter) => {
      node.adoptIncomingSession(remotePodId, adapter, 'webrtc').catch((err) => {
        onLog('mesh-bootstrap:adopt-incoming-session-failed', {
          remotePodId,
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
  // (e.g. to inspect connection stats, or to close the signaling bus).
  node.meshManager = meshManager
  node.signaling = signaling

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

  return node
}
