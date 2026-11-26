/**
 * mesh-node.mjs -- the CLI's own mesh node: a persisted identity, a signaling connection, WebRTC through `node-datachannel`
 * (an optional dependency) and the protocol channel service the egress provider serves `egress` on.
 *
 * A provider is the side that is found: peers connect to it by its pod id through the signaling server, and the node answers
 * their offers. Whether a peer is then served is the registry's (the grants), never the connection's.
 *
 * Without `node-datachannel` there is no WebRTC in Node, so there is nothing for a peer to connect to and `startMeshNode` says so.
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
 * @returns {Promise<{ podId: string, created: boolean, service: object, registry: object, close(): Promise<void> }>}
 */
export async function startMeshNode({ signaling, identityPath, iceServers = [], onLog = () => {} }) {
  let ndc
  try { ndc = await import('node-datachannel/polyfill') } catch {
    throw new MeshStartError('WebRTC is not available: the optional dependency node-datachannel is not installed, so no peer can connect to this node. Install it (npm install node-datachannel) and run again.')
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
  if (stored) summary = await identityManager.import(stored.privateKeyJwk, stored.label || 'egress')
  else {
    summary = await identityManager.create('egress')
    created = true
    if (identityPath) {
      await mkdir(dirname(identityPath), { recursive: true })
      await writeFile(identityPath, `${JSON.stringify({ podId: summary.podId, label: 'egress', privateKeyJwk: await identityManager.export(summary.podId) }, null, 2)}\n`, { mode: 0o600 })
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
    label: 'egress',
    identityManager,
    signalingTransport,
    discoveryStrategies: [],
    skipDiscovery: true,
    iceServers,
    onLog,
  })
  if (node.podId !== podId) throw new MeshStartError('The mesh node did not take the stored identity; refusing to run under another pod id.')
  const protocols = apps.attachService(node, undefined, apps.createMeshProtocolService())
  return {
    podId,
    created,
    service: protocols,
    registry: node.registry,
    node,
    async close() {
      try { await protocols.teardown?.() } catch { /* gone */ }
      try { await node.shutdown() } catch { /* gone */ }
      try { await signalingTransport.close?.() } catch { /* gone */ }
      try { ndc && (await import('node-datachannel')).cleanup?.() } catch { /* nothing to clean up */ }
    },
  }
}
