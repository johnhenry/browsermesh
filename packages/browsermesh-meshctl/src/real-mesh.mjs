/**
 * real-mesh.mjs — the `--signaling <ws://>` connection mode: `meshctl` joins
 * a real mesh as a real `PeerNode`, over real WebRTC, signaled through a
 * real relay/signaling server.
 *
 * This is NOT `@johnhenry/browsermesh-apps`'s `createMeshNode()` called
 * directly, even though that is "the established path" the design doc
 * points at -- `createMeshNode()` always mints a *fresh* identity via
 * `wallet.createIdentity(label)` and uses ITS return value as the node's
 * `podId`; it has no "reuse an existing identity" hook. Calling it as-is
 * would silently defeat `identity.mjs`'s whole point (a `meshctl` identity
 * that survives between invocations, so a host's grant to it is worth
 * anything on the second run).
 *
 * So this module inlines the same core wiring `createMeshNode()` does --
 * `PeerRegistry` (core's real `MeshPeerManager`/`TrustGraph`/`MeshACL`),
 * `WebRTCMeshManager` + `MeshSignalingChannel` + `MeshTransportNegotiator` +
 * `createWebRTCTransportFactory()` (`webrtc-negotiator.mjs`) -- but built
 * around `identity.mjs`'s already-loaded wallet, and skipping every
 * `enableXxx` optional subsystem `createMeshNode()` offers that pod-host
 * has no use for (sync, DHT, hardening, chat, GPU, ...). Anyone diffing
 * this against `mesh-bootstrap.mjs` should see the same shape for the
 * pieces both use.
 *
 * The signaling transport is `@johnhenry/browsermesh-pod`'s
 * `WebSocketTransport` in `protocol: 'signaling'` mode -- WP1's adapter,
 * already speaking the exact `browsermesh-servers/signaling` wire protocol
 * `MeshSignalingChannel`'s injectable `{send, onMessage, open, close}`
 * transport contract needs. Reusing it here instead of hand-rolling a raw
 * `WebSocket` adapter is the same "don't duplicate a working piece" call
 * `identity.mjs` makes about JWK (de)serialization.
 *
 * `--relay <ws://>` opens a SECOND `WebSocketTransport`, this time in
 * `protocol: 'relay'` mode, and hands it back on the session as
 * `relayTransport`. KNOWN LIMITATION, stated plainly: it is opened and
 * closed correctly, but nothing in this module threads it into the actual
 * pod-host data path yet -- `PeerNode.sendTo()` only ever goes over a
 * session `connectToPeer()`/`adoptIncomingSession()` created, and today
 * only the `'webrtc'` adapter is registered on `transportNegotiator`. A
 * relay-backed transport adapter (so a host unreachable over WebRTC --
 * symmetric NAT, no TURN -- is still reachable) is follow-up work, tracked
 * by this comment rather than a half-finished adapter.
 *
 * WHETHER THIS WAS EXERCISED END TO END: no. Real WebRTC connectivity
 * needs `node-datachannel`'s native binding, which `test/real-mesh-wiring.
 * test.mjs` does not assume is present (same guard
 * `test/real-peer/mesh-bootstrap.test.mjs` uses elsewhere in this
 * monorepo). That suite instead verifies this module's WIRING -- that it
 * builds a `PeerNode` carrying the persisted identity's `podId`, that the
 * signaling transport registers and can be closed, that `--relay` opens
 * and is reachable on the session, and that a connect attempt against a
 * peer nothing answers surfaces as a real rejection rather than hanging --
 * against a fake, in-process signaling transport. See that file's own
 * header for exactly what is and is not covered.
 */

import {
  MeshPeerManager, TrustGraph, MeshACL,
} from '@johnhenry/browsermesh-core'
import {
  PeerNode, PeerRegistry, MeshSignalingChannel, createPodHostClient, createWebRTCTransportFactory,
} from '@johnhenry/browsermesh-apps'
import { MeshTransportNegotiator, WebRTCMeshManager, mergeIceServers } from '@johnhenry/browsermesh-transport'
import { WebSocketTransport } from '@johnhenry/browsermesh-pod'
import { UsageError } from './output.mjs'
import { withSupervisor } from './session-supervisor.mjs'

/**
 * @param {object} opts
 * @param {import('./identity.mjs').MeshctlIdentity} opts.cliIdentity
 * @param {string} opts.signalingUrl - `--signaling`.
 * @param {string} [opts.relayUrl] - `--relay`.
 * @param {RTCIceServer[]} [opts.iceServers]
 * @param {Function} [opts.WebSocketCtor] - Injectable `WebSocket`, for tests.
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.onLog]
 * @returns {Promise<import('./connect.mjs').MeshctlSession>}
 */
export async function createRealMeshSession({
  cliIdentity, signalingUrl, relayUrl, iceServers = [], WebSocketCtor, timeoutMs, onLog = () => {},
} = {}) {
  if (!signalingUrl) {
    throw new UsageError('--signaling <ws://...> is required for the real mesh path (or pass --loopback instead)')
  }

  const podId = cliIdentity.podId
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({ onLog }),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId, onLog }),
  })

  const signalingTransport = new WebSocketTransport({
    url: signalingUrl,
    podId,
    protocol: 'signaling',
    WebSocket: WebSocketCtor,
    onLog,
  })

  let relayTransport = null
  if (relayUrl) {
    relayTransport = new WebSocketTransport({
      url: relayUrl,
      podId,
      protocol: 'relay',
      WebSocket: WebSocketCtor,
      onLog,
    })
    await relayTransport.open()
  }

  const meshManager = new WebRTCMeshManager({ localPodId: podId, iceServers: mergeIceServers(iceServers), onLog })
  const signaling = new MeshSignalingChannel({ localPodId: podId, transport: signalingTransport, onLog })
  await signaling.open()

  const transportNegotiator = new MeshTransportNegotiator()
  const node = new PeerNode({ wallet: cliIdentity.wallet, registry, transportNegotiator, onLog })

  const webrtcFactory = createWebRTCTransportFactory({
    localPodId: podId,
    meshManager,
    signaling,
    onLog,
    onIncomingConnection: (remotePodId, adapter, connectionId) => {
      node.adoptIncomingSession(remotePodId, adapter, 'webrtc', { connectionId }).catch((err) => {
        onLog(`[meshctl] failed to adopt incoming session from ${remotePodId}: ${err?.message || err}`)
      })
    },
  })
  transportNegotiator.registerAdapter('webrtc', webrtcFactory)

  await node.boot({ label: cliIdentity.label, skipDiscovery: true })
  node.meshManager = meshManager
  node.signaling = signaling
  node.transportNegotiator = transportNegotiator

  const client = createPodHostClient({ peerNode: node, timeoutMs })

  /**
   * Negotiate a WebRTC session to `hostPubKey` if one isn't already open.
   * `createPodHostClient()`'s calls go straight to `node.sendTo()`, which
   * requires a pre-existing session -- unlike the loopback hosts (linked at
   * connect time), real hosts are only reachable once negotiated.
   * @param {string} hostPubKey
   */
  async function ensureConnected(hostPubKey) {
    if (node.hasActiveSession(hostPubKey)) return
    await node.connectToPeer(hostPubKey, { webrtc: hostPubKey }, {})
  }

  return withSupervisor({
    mode: 'real',
    podId,
    peerNode: node,
    client,
    relayTransport,
    // Exposed mainly for `test/real-mesh-wiring.test.mjs`: there is no
    // other way from outside this module to confirm the signaling
    // transport actually registered with the (fake, in tests) signaling
    // server.
    signalingTransport,
    knownHosts: () => [],
    resolveHost(ref) {
      return { podId: ref, label: ref, lane: null }
    },
    ensureConnected,
    async close() {
      client.close()
      await signaling.close()
      if (relayTransport) await relayTransport.close()
      await node.shutdown()
    },
  })
}
