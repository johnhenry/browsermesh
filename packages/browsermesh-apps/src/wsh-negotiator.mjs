/**
 * wsh-negotiator.mjs -- wires `@johnhenry/browsermesh-transport`'s wsh peer
 * links (`WshPeerLinks`: sealed, key-authenticated mesh links over wsh) into
 * `PeerNode`, the way `webrtc-negotiator.mjs` wires WebRTC.
 *
 *   - `createWshAuthorizer(registry)` is the `authorize` callback for the
 *     LISTENING side: a peer may link to this pod only if `PeerRegistry.
 *     checkAccess(podId, 'mesh:link', 'connect')` allows it (the ACL scope
 *     `mesh:link:connect`; `grantCapabilities()` / `revokeCapabilities()` /
 *     `MeshACL` wildcards all apply). It runs after the peer's key signature
 *     verified and before any mesh frame; default deny.
 *   - `createWshAdapterFactory(links)` is the `'wsh'` adapter factory for
 *     `MeshTransportNegotiator.registerAdapter()`. As with `'webrtc'`, the
 *     endpoint is the remote peer's pod id. A link to a different pod than the
 *     one asked for cannot exist: the dialler pins the host key to that pod id.
 *   - `attachWshLinks({ node, links, negotiator })` registers the adapter and
 *     gives the callee side of an inbound link the same PeerNode session
 *     bookkeeping `connectToPeer()` gives the caller side
 *     (`adoptIncomingSession()`), keyed by the pod id derived from the key wsh
 *     authenticated -- so `fromPubKey` in `onIncomingData()` is that key and
 *     never a field a peer wrote.
 *
 * `createMeshNode({ wsh: { relays, ... } })` does all of this. `links` is
 * duck-typed (no import of the transport package here), so this module loads
 * without it.
 *
 * No browser-only imports at module level.
 */

/** The ACL resource a peer needs `connect` on to link to this pod. */
export const WSH_LINK_RESOURCE = 'mesh:link'
/** The ACL action. */
export const WSH_LINK_ACTION = 'connect'

/**
 * `authorize` for `WshPeerLinks`, backed by a `PeerRegistry`.
 *
 * @param {import('./peer-registry.mjs').PeerRegistry} registry
 * @param {object} [opts]
 * @param {string} [opts.resource='mesh:link']
 * @param {string} [opts.action='connect']
 * @param {boolean} [opts.requireKnownPeer=false] - Also require the peer to be in the registry's peer list.
 * @returns {(peer: { podId: string }) => boolean}
 */
export function createWshAuthorizer(registry, { resource = WSH_LINK_RESOURCE, action = WSH_LINK_ACTION, requireKnownPeer = false } = {}) {
  if (!registry || typeof registry.checkAccess !== 'function') throw new TypeError('createWshAuthorizer: a PeerRegistry (with checkAccess) is required')
  return ({ podId }) => {
    if (requireKnownPeer && !registry.getPeer(podId)) return false
    return registry.checkAccess(podId, resource, action)?.allowed === true
  }
}

/**
 * Close the live link of a peer whose permission to link ends. `createWshAuthorizer` decides at login;
 * this keeps deciding for as long as the link is up: when the registry announces an access change for a
 * peer (a revocation, a removal, a permission update, or a grant that expired) and the registry no longer
 * allows that peer to link, its link is closed and not redialled.
 *
 * @param {object} opts
 * @param {import('./peer-registry.mjs').PeerRegistry} opts.registry
 * @param {{ isConnected: (podId: string) => boolean, disconnect: (podId: string) => void }} opts.links - a `WshPeerLinks`
 * @param {string} [opts.resource='mesh:link']
 * @param {string} [opts.action='connect']
 * @param {boolean} [opts.requireKnownPeer=false] - as for `createWshAuthorizer`
 * @returns {() => void} stop watching
 */
export function watchWshAccess({ registry, links, resource = WSH_LINK_RESOURCE, action = WSH_LINK_ACTION, requireKnownPeer = false }) {
  if (!registry || typeof registry.onAccessChange !== 'function') throw new TypeError('watchWshAccess: a PeerRegistry (with onAccessChange) is required')
  if (!links || typeof links.disconnect !== 'function' || typeof links.isConnected !== 'function') throw new TypeError('watchWshAccess: a WshPeerLinks is required')
  const authorize = createWshAuthorizer(registry, { resource, action, requireKnownPeer })
  return registry.onAccessChange(({ pubKey } = {}) => {
    if (typeof pubKey === 'string' && links.isConnected(pubKey) && !authorize({ podId: pubKey })) links.disconnect(pubKey)
  })
}

/**
 * `'wsh'` adapter factory for `MeshTransportNegotiator`.
 *
 * @param {{ link: (podId: string) => object }} links - a `WshPeerLinks`
 * @returns {(endpoint: string, auth?: object) => Promise<object>}
 */
export function createWshAdapterFactory(links) {
  if (!links || typeof links.link !== 'function') throw new TypeError('createWshAdapterFactory: a WshPeerLinks is required')
  return async (endpoint) => {
    const podId = typeof endpoint === 'string' ? endpoint : endpoint?.podId
    const link = links.link(podId)
    try {
      await link.connect()
    } catch (err) {
      link.dispose?.()
      throw err
    }
    return link
  }
}

/**
 * Register the wsh adapter on `negotiator` and adopt inbound links as PeerNode sessions.
 *
 * @param {object} opts
 * @param {import('./peer-node.mjs').PeerNode} opts.node
 * @param {object} opts.links - a `WshPeerLinks`
 * @param {import('@johnhenry/browsermesh-transport').MeshTransportNegotiator} opts.negotiator
 * @param {(event: string, data: object) => void} [opts.onLog]
 * @returns {{ links: object, detach: () => void }}
 */
export function attachWshLinks({ node, links, negotiator, onLog }) {
  if (!node || typeof node.adoptIncomingSession !== 'function') throw new TypeError('attachWshLinks: a PeerNode is required')
  if (!negotiator || typeof negotiator.registerAdapter !== 'function') throw new TypeError('attachWshLinks: a MeshTransportNegotiator is required')
  const log = onLog || (() => {})
  negotiator.registerAdapter('wsh', createWshAdapterFactory(links))
  const off = links.on('peer-up', ({ podId, initiator }) => {
    // A link this node dialled is adopted by connectToPeer() itself.
    if (initiator === 'local' || node.hasActiveSession(podId)) return
    node.adoptIncomingSession(podId, links.link(podId), 'wsh').catch((err) => {
      log('wsh-negotiator:adopt-incoming-session-failed', { podId, error: err?.message || String(err) })
    })
  })
  return { links, detach: off }
}
