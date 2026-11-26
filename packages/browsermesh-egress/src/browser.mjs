/**
 * browser.mjs -- `@johnhenry/browsermesh-egress/browser`: everything a PAGE needs to reach an egress provider, and nothing it does not.
 *
 *   import { createEgressNode } from '@johnhenry/browsermesh-egress/browser'
 *
 *   const egress = await createEgressNode({ signaling: 'wss://signal.example/signaling' })
 *   const link = await egress.connect(providerPodId)      // connects to the pod, opens protocol `egress`, pins the link to it
 *   const res = await link.fetch('https://registry.example/v2/')
 *   await egress.close()
 *
 * Without this entry a page builds its mesh node from `createMeshNode` (the apps package's root, which imports every service the
 * package has: about a megabyte after minification) and copies the CLI's recipe for the identity and the signalling transport.
 * This does the same wiring on `createLeanMeshNode` (apps' `/lean-node`), the identity of `-core` and the signalling transport of
 * `-pod`, each imported by name, so a bundler keeps only what is used (a test pins the size). The provider side stays in the main
 * entry and in `./node`: this entry has no provider, no `node:` import, no wsh.
 *
 * The provider and the page need nothing else in common than the signalling server and the grants the provider's operator writes:
 * the page's pod id (`egress.podId`) is what the operator grants `protocol:egress:open` and the destinations to.
 */
import { createLeanMeshNode, attachService, createMeshProtocolService, MeshIdentityManager } from '@johnhenry/browsermesh-apps/lean-node'
import { WebSocketTransport } from '@johnhenry/browsermesh-pod'
import { connectEgress } from './consumer.mjs'
import { EgressError } from './errors.mjs'

export { connectEgress, EgressError }
export { EgressBackend } from './backend.mjs'
export { REFUSAL_CODES, BUDGET_NAMES, END_REASONS, LINK_CODES, CLOSE_REASONS } from './errors.mjs'
export { CONSUMER_LIMIT_DEFAULTS } from './consumer.mjs'
export { createAddressMemory } from './address-memory.mjs'
export { KEEPALIVE_DEFAULTS } from './liveness.mjs'
export { EGRESS_PROTOCOL, EGRESS_VERSIONS } from './wire.mjs'
export { EGRESS_SCOPES } from './destination.mjs'

/** A MeshIdentityManager that hands back the identity made before the node was, once: the node's own `create` returns it instead of making a second. */
class AdoptingIdentityManager extends MeshIdentityManager {
  #pending = null
  adopt(summary) { this.#pending = summary }
  async create(label, opts) {
    if (this.#pending) { const summary = this.#pending; this.#pending = null; return summary }
    return super.create(label, opts)
  }
}

/** What a failed connect to a pod means, as an error (the messages are the mesh's own: see `webrtc-negotiator.mjs`). */
function connectFailure(e) {
  if (e instanceof EgressError) return e
  const message = typeof e?.message === 'string' ? e.message : ''
  if (/timed out waiting for an answer/.test(message)) return new EgressError('provider-not-found', undefined, { cause: e })
  if (/did not open in time/.test(message)) return new EgressError('provider-timeout', undefined, { cause: e })
  if (/not (?:open|connected)|WebSocket|signal+ing/i.test(message)) return new EgressError('signalling-unreachable', undefined, { cause: e })
  if (e?.name === 'AbortError') return new EgressError('aborted', undefined, { cause: e })
  return new EgressError('provider-unreachable', undefined, { cause: e })
}

/**
 * @param {object} opts
 * @param {string|{ send(message: object): void, onMessage(cb: Function): void }} opts.signaling
 *   The signalling server's WebSocket URL (`ws://` or `wss://`; the dialect of `browsermesh-servers`' signalling server), or a ready transport.
 * @param {{ privateKeyJwk: object, label?: string }} [opts.identity] - an identity to restore (`node.identityManager.export(podId)` gives the key); a new one when absent
 * @param {string} [opts.label='egress-consumer']
 * @param {RTCIceServer[]} [opts.iceServers] - add TURN servers here; `[]` means none
 * @param {number} [opts.answerTimeoutMs=15000] - how long `connect` waits for the provider to answer through the signalling server
 * @param {number} [opts.openTimeoutMs=15000] - how long `connect` waits for the data channel to open once it answered
 * @param {(event: string, data?: object) => void} [opts.onLog]
 */
export async function createEgressNode({ signaling, identity, label = 'egress-consumer', iceServers, answerTimeoutMs = 15_000, openTimeoutMs = 15_000, onLog = () => {} } = {}) {
  if (typeof signaling !== 'string' && !(signaling && typeof signaling.send === 'function' && typeof signaling.onMessage === 'function')) {
    throw new TypeError('createEgressNode: signaling is the signalling server\'s WebSocket URL, or a transport with send(message) and onMessage(cb)')
  }
  const identityManager = new AdoptingIdentityManager({})
  const summary = identity ? await identityManager.import(identity.privateKeyJwk, identity.label || label) : await identityManager.create(label)
  const podId = summary.podId
  identityManager.adopt(summary)

  let transport = signaling
  if (typeof signaling === 'string') {
    transport = new WebSocketTransport({
      url: signaling,
      podId,
      protocol: 'signaling',
      identity: { podId, rawPublicKey: () => identityManager.getPublicKeyBytes(podId), sign: (data) => identityManager.sign(podId, data) },
      authentication: 'auto',
      onLog,
    })
    try { await transport.open?.() } catch (e) {
      try { await transport.close?.() } catch { /* nothing to close */ } // a transport that failed to open may still be retrying
      // A server that answered and refused this pod (a signed registration was required, or failed) is not "unreachable".
      if (e?.name === 'SignalingAuthError' || e?.name === 'SignalingAuthRequiredError') throw e
      throw new EgressError('signalling-unreachable', undefined, { cause: e })
    }
  }

  const node = await createLeanMeshNode({ label, identityManager, signalingTransport: transport, iceServers, onLog })
  if (node.podId !== podId) throw new Error('createEgressNode: the mesh node did not take the identity it was given; refusing to run under another pod id')
  const service = attachService(node, undefined, createMeshProtocolService())
  let closed = false

  return {
    podId,
    service,
    registry: node.registry,
    node,
    identityManager,
    /**
     * Connect to the provider's pod (once: a live session is reused), then open protocol `egress` on it and return the link.
     * Rejects with an `EgressError`: `signalling-unreachable`, `provider-not-found` (no answer through the signalling server),
     * `provider-timeout`, `provider-not-authorized`, `provider-no-egress`, `provider-version`, `provider-refused`, ... (see LINK_CODES).
     * `options` are `connectEgress`'s (`limits`, `keepAlive`, `mapAddresses`, `signRequest`, `signal`).
     */
    async connect(providerPodId, options = {}) {
      if (closed) throw new EgressError('link-closed', 'This egress node was closed.')
      if (typeof providerPodId !== 'string' || !providerPodId) throw new TypeError('connect: the provider\'s pod id is required')
      if (!node.hasActiveSession(providerPodId)) {
        try {
          await node.connectToPeer(providerPodId, { webrtc: providerPodId }, { answerTimeoutMs, openTimeoutMs })
        } catch (e) { throw connectFailure(e) }
      }
      return connectEgress(service, providerPodId, options)
    },
    /** Close the node: the signalling connection and every link with it. */
    async close() {
      if (closed) return
      closed = true
      try { service.teardown?.() } catch { /* gone */ }
      try { await node.shutdown() } catch { /* gone */ }
      try { await transport?.close?.() } catch { /* gone */ }
    },
  }
}
