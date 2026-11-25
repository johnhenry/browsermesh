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
 * `relayTransport`. It is opened and closed correctly and is NOT used for
 * pod-host traffic, on purpose: that relay dialect is readable by the relay and
 * its `register` frame proves no key, so it is not a link to carry requests
 * over. The relay path is `--wsh-relay`: `WshPeerLinks` (sealed, key-bound,
 * the host pinned to the pod id asked for) registered as the `'wsh'` adapter,
 * alone (no signalling server, no WebRTC) or ahead of WebRTC.
 *
 * WHETHER THE WEBRTC PATH WAS EXERCISED END TO END: no. Real WebRTC connectivity
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
  PeerNode, PeerRegistry, MeshSignalingChannel, createPodHostClient, createWebRTCTransportFactory, attachWshLinks,
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
 * @param {'auto'|'required'|'off'} [opts.signalingAuthentication='auto'] - How to register with the signalling server: `auto` signs when the server asks, `required` never falls back to the open flow, `off` never signs.
 * @param {number} [opts.signalingChallengeWaitMs=1000] - How long to wait for the server's challenge before registering the open way (an open-mode server sends none).
 * @param {Function} [opts.WebSocketCtor] - Injectable `WebSocket`, for tests.
 * @param {number} [opts.timeoutMs]
 * @param {Function} [opts.onLog]
 * @returns {Promise<import('./connect.mjs').MeshctlSession>}
 */
export async function createRealMeshSession({
  cliIdentity, signalingUrl, relayUrl, iceServers = [], WebSocketCtor, timeoutMs, onLog = () => {},
  signalingAuthentication = 'auto', signalingChallengeWaitMs = 1000,
  wshRelays = [], wsh = {},
} = {}) {
  if (!signalingUrl && wshRelays.length === 0) {
    throw new UsageError('--signaling <ws://...> or --wsh-relay <wss://...> is required for the real mesh path (or pass --loopback instead)')
  }
  if (relayUrl && !signalingUrl) {
    throw new UsageError('--relay is used together with --signaling (for a relay path use --wsh-relay)')
  }

  const podId = cliIdentity.podId
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({ onLog }),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId, onLog }),
  })

  const manager = cliIdentity.identityManager
  const useSignaling = Boolean(signalingUrl)

  // The signalling server can require a signed registration (protocol 2): the
  // pod id must be the hash of the key that proves it. meshctl's persisted
  // identity is that key, so a server in authenticated mode accepts it, and an
  // open-mode or older server (which sends no challenge) is joined as before.
  const signalingTransport = !useSignaling ? null : new WebSocketTransport({
    url: signalingUrl,
    podId,
    protocol: 'signaling',
    WebSocket: WebSocketCtor,
    // The manager signs for the persisted identity; the key never leaves it.
    identity: {
      podId,
      rawPublicKey: () => manager.getPublicKeyBytes(podId),
      sign: (data) => manager.sign(podId, data),
    },
    authentication: signalingAuthentication,
    challengeWaitMs: signalingChallengeWaitMs,
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

  let meshManager = null
  let signaling = null
  if (useSignaling) {
    meshManager = new WebRTCMeshManager({ localPodId: podId, iceServers: mergeIceServers(iceServers), onLog })
    signaling = new MeshSignalingChannel({ localPodId: podId, transport: signalingTransport, onLog })
    await signaling.open()
  }

  // With `--wsh-relay` the sealed wsh link is the first choice and, with no
  // signalling server, the only one (a failed link is then a failed connect,
  // never a session on something else). With both, a link that cannot be made
  // falls through to WebRTC, which is itself encrypted and key-bound.
  const useWsh = wshRelays.length > 0
  const transportNegotiator = new MeshTransportNegotiator(
    useWsh ? (useSignaling ? { preferenceOrder: ['wsh', 'webrtc'] } : { require: 'wsh' }) : {},
  )
  // The reason `PeerNode` gave for the last transport that failed, so that a connect which negotiated nothing can say why.
  let lastNegotiationError = null
  const nodeLog = (event, data) => {
    if (event === 'peer-node:transport:negotiation-failed') lastNegotiationError = data?.error ?? null
    onLog(event, data)
  }
  const node = new PeerNode({ wallet: cliIdentity.wallet, registry, transportNegotiator, onLog: nodeLog })

  if (useSignaling) {
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
  }

  // meshctl only dials: it never listens on the relay, so no pod can open a link
  // to it, and `authorize` (the question of who may link IN) says no to everyone.
  let wshLinks = null
  if (useWsh) {
    let WshPeerLinks
    try {
      ({ WshPeerLinks } = await import('@johnhenry/browsermesh-transport/wsh'))
    } catch (cause) {
      throw new UsageError(`--wsh-relay needs @johnhenry/browsermesh-transport (>=0.11) and its peer @johnhenry/wsh: ${cause?.message || cause}`)
    }
    wshLinks = new WshPeerLinks({
      identity: manager.getIdentity(podId),
      relays: wshRelays,
      WebSocket: WebSocketCtor,
      authorize: () => false,
      onLog: (line) => onLog(`[meshctl] wsh: ${line}`),
      ...wsh,
    })
    attachWshLinks({ node, links: wshLinks, negotiator: transportNegotiator, onLog })
  }

  await node.boot({ label: cliIdentity.label, skipDiscovery: true })
  node.meshManager = meshManager
  node.signaling = signaling
  node.transportNegotiator = transportNegotiator

  const client = createPodHostClient({ peerNode: node, timeoutMs })

  /**
   * Open a session to `hostPubKey` if one isn't already open: a sealed wsh
   * link through the relay (`--wsh-relay`) and/or WebRTC (`--signaling`).
   * `createPodHostClient()`'s calls go straight to `node.sendTo()`, which
   * requires a pre-existing session -- unlike the loopback hosts (linked at
   * connect time), real hosts are only reachable once negotiated.
   * @param {string} hostPubKey
   */
  async function ensureConnected(hostPubKey) {
    if (node.hasActiveSession(hostPubKey)) return
    const endpoints = {}
    if (useWsh) endpoints.wsh = hostPubKey
    if (useSignaling) endpoints.webrtc = hostPubKey
    lastNegotiationError = null
    const session = await node.connectToPeer(hostPubKey, endpoints, {})
    // `connectToPeer()` falls back to a session with no transport when every
    // negotiation failed; a request on it could only fail later and less clearly.
    if (!session.transport) {
      node.disconnectPeer(hostPubKey)
      throw Object.assign(
        new Error(`could not open a link to ${hostPubKey}${lastNegotiationError ? `: ${lastNegotiationError}` : ''}`),
        { code: 'ECONNECT' },
      )
    }
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
    wshLinks,
    knownHosts: () => [],
    resolveHost(ref) {
      return { podId: ref, label: ref, lane: null }
    },
    ensureConnected,
    async close() {
      client.close()
      if (signaling) await signaling.close()
      if (relayTransport) await relayTransport.close()
      if (wshLinks) await wshLinks.close()
      await node.shutdown()
    },
  })
}
