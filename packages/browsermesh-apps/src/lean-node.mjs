/**
 * lean-node.mjs -- `createLeanMeshNode`: the smallest connected PeerNode, for a page that only needs to reach one pod.
 *
 * `createMeshNode` (mesh-bootstrap.mjs) wires in every optional service the package has, and its module imports all of them, so a
 * bundler that follows the package root pulls in the marketplace, the orchestrator, the swarm and the rest (about a megabyte) even
 * for a page that uses none. This is the same composition for the part every node needs, and nothing else:
 *
 *   identity (`IdentityWallet`) -> `PeerRegistry` (default deny, the grants live here) -> `DiscoveryManager` (no strategies)
 *   -> `WebRTCMeshManager` + `MeshSignalingChannel` -> `MeshTransportNegotiator` with the `webrtc` adapter -> `PeerNode`
 *
 * It takes the options of `createMeshNode` that mean the same thing here (`label`, `identityManager`, `signalingTransport`,
 * `iceServers`, `webrtcIdentityBinding`, `webrtcAllowUnboundPeers`, `webrtcBindingTimeoutMs`, `maxHalfOpenInbound`,
 * `halfOpenTimeoutMs`, `capabilities`, `skipBoot`, `onLog`) and returns the same kind of node (`podId`, `registry`, `connectToPeer`,
 * `sendTo`, `shutdown`, plus `meshManager`, `signaling` and `transportNegotiator`). Services are attached the usual way:
 * `attachService(node, undefined, createMeshProtocolService())`, both exported here so one import line reaches everything a
 * consumer of a layered protocol needs.
 *
 * What it does not have, on purpose: wsh links, discovery strategies (peers are connected by pod id), sync, hardening, relay,
 * and every opt-in service. A node that needs one of those is `createMeshNode`.
 *
 * Its imports are static and named (`@johnhenry/browsermesh-core`, `-discovery`, `-transport`, optional peers of this package that
 * this entry requires), so a bundler keeps only the few classes used from each: a test pins the size.
 */
import {
  IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL, CapabilityValidator, CapabilityToken,
} from '@johnhenry/browsermesh-core'
import { DiscoveryManager, DiscoveryRecord } from '@johnhenry/browsermesh-discovery'
import { MeshTransportNegotiator, WebRTCMeshManager, mergeIceServers } from '@johnhenry/browsermesh-transport'
import { PeerNode } from './peer-node.mjs'
import { PeerRegistry } from './peer-registry.mjs'
import { MeshSignalingChannel } from './signaling.mjs'
import { createWebRTCTransportFactory } from './webrtc-negotiator.mjs'
import { attachService } from './mesh-service.mjs'
import { createMeshProtocolService } from './protocol-channel.mjs'

export { attachService, createMeshProtocolService, PeerRegistry, PeerNode, MeshIdentityManager }

/**
 * @param {object} options
 * @param {object} options.signalingTransport - an object with `send(msg)` and `onMessage(cb)`: the bus WebRTC offers, answers and ICE cross (required)
 * @param {string} [options.label='default']
 * @param {object} [options.identityManager] - a `MeshIdentityManager`; a new one (a new identity) when absent
 * @param {RTCIceServer[]} [options.iceServers] - merged with the defaults (none); `[]` means none at all
 * @param {boolean} [options.webrtcIdentityBinding=true] - each side proves its pod key over the DTLS fingerprints (see `createMeshNode`)
 * @param {boolean} [options.webrtcAllowUnboundPeers=false]
 * @param {number} [options.webrtcBindingTimeoutMs]
 * @param {number} [options.maxHalfOpenInbound]
 * @param {number} [options.halfOpenTimeoutMs]
 * @param {string[]} [options.capabilities]
 * @param {boolean} [options.skipBoot=false]
 * @param {(event: string, data?: object) => void} [options.onLog]
 * @returns {Promise<PeerNode & { meshManager: object, signaling: object, transportNegotiator: object }>}
 */
export async function createLeanMeshNode(options = {}) {
  const {
    label = 'default',
    identityManager: providedIdentityManager,
    signalingTransport,
    iceServers,
    webrtcIdentityBinding = true,
    webrtcAllowUnboundPeers = false,
    webrtcBindingTimeoutMs,
    maxHalfOpenInbound,
    halfOpenTimeoutMs,
    capabilities = [],
    skipBoot = false,
    onLog = () => {},
  } = options

  if (!signalingTransport) {
    throw new Error('createLeanMeshNode: options.signalingTransport is required (an object with send(msg) and onMessage(cb): the bus for WebRTC offer/answer/ICE -- see signaling.mjs)')
  }

  const identityManager = providedIdentityManager || new MeshIdentityManager({ onLog })
  const wallet = new IdentityWallet({ identityManager, onLog })
  const { podId } = await wallet.createIdentity(label)

  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({ onLog }),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId, onLog }),
    capabilityValidator: new CapabilityValidator(),
    tokenFactory: (tokenOpts) => new CapabilityToken(tokenOpts),
    onLog,
  })

  // No discovery strategy: a lean node reaches a peer by the pod id it is given. The manager is still there, as PeerNode wants one.
  const discovery = new DiscoveryManager({ strategies: [], localRecord: new DiscoveryRecord({ podId, label, transport: 'webrtc', capabilities }) })

  // The node's own identity is wired into every connection: each side proves possession of its pod key over the DTLS fingerprints.
  let bindingIdentity = null
  if (webrtcIdentityBinding !== false) {
    const candidate = identityManager.getIdentity(podId)
    if (candidate && typeof candidate.sign === 'function' && typeof candidate.rawPublicKey === 'function') bindingIdentity = candidate
    else onLog('lean-node:webrtc-binding-unavailable', { reason: 'the node identity cannot sign' })
  }
  const meshManager = new WebRTCMeshManager({
    localPodId: podId,
    iceServers: mergeIceServers(iceServers),
    onLog,
    ...(bindingIdentity ? { identity: bindingIdentity, requirePeerBinding: !webrtcAllowUnboundPeers, bindingTimeoutMs: webrtcBindingTimeoutMs } : {}),
  })
  const signaling = new MeshSignalingChannel({ localPodId: podId, transport: signalingTransport, onLog })
  await signaling.open()

  // WebRTC is the only transport here, and a failure to negotiate it is the failure: `connectToPeer` rejects with the reason instead of
  // leaving a session with no transport behind (what `createMeshNode`'s default negotiator does when WebRTC fails).
  const transportNegotiator = new MeshTransportNegotiator({ require: 'webrtc' })
  const node = new PeerNode({ wallet, registry, discovery, transportNegotiator, onLog })

  const webrtcFactory = createWebRTCTransportFactory({
    localPodId: podId,
    meshManager,
    signaling,
    onLog,
    maxHalfOpenInbound,
    halfOpenTimeoutMs,
    onBindingFailure: ({ remotePodId, connectionId, reason }) => {
      node.reportBindingFailure(remotePodId, { transport: 'webrtc', connectionId, reason })
    },
    // The callee side gets the same session bookkeeping the caller side does, so sendTo and incoming data work either way round.
    onIncomingConnection: (remotePodId, adapter, connectionId, info) => {
      node.adoptIncomingSession(remotePodId, adapter, 'webrtc', { connectionId, restarted: info?.restarted === true }).catch((err) => {
        onLog('lean-node:adopt-incoming-session-failed', { remotePodId, connectionId, error: err?.message || String(err) })
      })
    },
  })
  transportNegotiator.registerAdapter('webrtc', webrtcFactory)

  if (!skipBoot) await node.boot({ label, skipDiscovery: true })

  node.meshManager = meshManager
  node.signaling = signaling
  node.transportNegotiator = transportNegotiator
  node.services = new Map()
  return node
}
