/**
 * mesh-node.mjs -- the CLI's own mesh node: a persisted identity, a signaling connection, WebRTC through
 * `node-datachannel` (an optional dependency) and the protocol channel service the ingress opens `http` on.
 *
 * Without `node-datachannel` there is no WebRTC in Node, so there is nothing for this node to connect with and
 * `startMeshNode` says so (the library still works over any other transport you attach a service to).
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export class MeshStartError extends Error {
  constructor(message) { super(message); this.name = 'MeshStartError' }
}

async function readStored(path) {
  let text
  try { text = await readFile(path, 'utf8') } catch (e) { if (e.code === 'ENOENT') return null; throw e }
  let json
  try { json = JSON.parse(text) } catch { throw new MeshStartError(`The identity file ${path} is not valid JSON; refusing to overwrite it.`) }
  if (!json?.privateKeyJwk) throw new MeshStartError(`The identity file ${path} has no key in it; refusing to overwrite it.`)
  return json
}

/**
 * @param {object} opts
 * @param {string} opts.signaling - signaling server URL
 * @param {string} [opts.identityPath] - persisted identity (created, mode 0600, when missing); without it the identity is new each run
 * @param {Function} [opts.onLog]
 * @returns {Promise<{ podId: string, created: boolean, service: object, close(): Promise<void> }>}
 */
export async function startMeshNode({ signaling, identityPath, iceServers = [], connectTimeoutMs = 30_000, onLog = () => {} }) {
  let ndc
  try { ndc = await import('node-datachannel/polyfill') } catch {
    throw new MeshStartError('WebRTC is not available: the optional dependency node-datachannel is not installed, so this node cannot connect to any pod. Install it (npm install node-datachannel) and run again.')
  }
  Object.assign(globalThis, { RTCPeerConnection: ndc.RTCPeerConnection, RTCIceCandidate: ndc.RTCIceCandidate, RTCSessionDescription: ndc.RTCSessionDescription })
  let apps, core, pod
  try {
    ;[apps, core, pod] = await Promise.all([import('@johnhenry/browsermesh-apps'), import('@johnhenry/browsermesh-core'), import('@johnhenry/browsermesh-pod')])
  } catch (e) {
    throw new MeshStartError(`A BrowserMesh package the CLI needs could not be loaded (${e.message}). Install @johnhenry/browsermesh-apps, -core, -pod, -primitives, -transport and -discovery next to this package.`)
  }

  // An identity that is created once and reused: `createMeshNode` creates one through `identityManager.create`, so the
  // manager hands back the persisted one when it has it.
  class StableIdentityManager extends core.MeshIdentityManager {
    #pending = null
    adopt(summary) { this.#pending = summary }
    async create(label, opts) {
      if (this.#pending) { const s = this.#pending; this.#pending = null; return s }
      return super.create(label, opts)
    }
  }
  const identityManager = new StableIdentityManager({})
  let summary
  let created = false
  const stored = identityPath ? await readStored(identityPath) : null
  if (stored) summary = await identityManager.import(stored.privateKeyJwk, stored.label || 'ingress')
  else {
    summary = await identityManager.create('ingress')
    created = true
    if (identityPath) {
      await mkdir(dirname(identityPath), { recursive: true })
      await writeFile(identityPath, `${JSON.stringify({ podId: summary.podId, label: 'ingress', privateKeyJwk: await identityManager.export(summary.podId) }, null, 2)}\n`, { mode: 0o600 })
      await chmod(identityPath, 0o600)
    }
  }
  identityManager.adopt(summary)
  const podId = summary.podId

  const signalingTransport = new pod.WebSocketTransport({
    url: signaling,
    podId,
    protocol: 'signaling',
    identity: { podId, rawPublicKey: () => identityManager.getPublicKeyBytes(podId), sign: (data) => identityManager.sign(podId, data) },
    authentication: 'auto',
    onLog,
  })
  await signalingTransport.open?.()
  const node = await apps.createMeshNode({
    label: 'ingress',
    identityManager,
    signalingTransport,
    discoveryStrategies: [],
    skipDiscovery: true,
    iceServers,
    onLog,
  })
  if (node.podId !== podId) throw new MeshStartError('The mesh node did not take the stored identity; refusing to run under another pod id.')
  const protocols = apps.attachService(node, undefined, apps.createMeshProtocolService())

  // The mesh channel needs a session with the peer: connect to a pod the first time it is wanted (and only the
  // pods a mapping names ever get here), once at a time per pod.
  const connecting = new Map()
  const ensureConnected = (peer) => {
    if (node.hasActiveSession(peer)) return Promise.resolve()
    let p = connecting.get(peer)
    if (!p) {
      p = node.connectToPeer(peer, { webrtc: peer }, { answerTimeoutMs: connectTimeoutMs, openTimeoutMs: connectTimeoutMs }).finally(() => connecting.delete(peer))
      connecting.set(peer, p)
    }
    return p
  }
  const service = {
    api: {
      ...protocols.api,
      async openProtocol(peer, name, opts) {
        await ensureConnected(peer)
        return protocols.api.openProtocol(peer, name, opts)
      },
    },
  }
  return {
    podId,
    created,
    service,
    node,
    async close() {
      try { await protocols.teardown?.() } catch { /* gone */ }
      try { await node.shutdown() } catch { /* gone */ }
      try { await signalingTransport.close?.() } catch { /* gone */ }
      try { ndc && (await import('node-datachannel')).cleanup?.() } catch { /* nothing to clean up */ }
    },
  }
}
