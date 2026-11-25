/**
 * Test helpers: pods on a simulated in-process bus, each with its own PeerRegistry (default deny) and a protocol
 * service. A real transport carries JSON text, so the bus does too.
 */
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { attachService, createMeshProtocolService, createMeshRpcService, PeerRegistry } from '@johnhenry/browsermesh-apps'

export async function createNodes(count) {
  const nodes = new Map()
  for (let i = 0; i < count; i++) {
    const identity = await PodIdentity.generate()
    const { podId } = identity
    const listeners = new Set()
    const node = {
      podId,
      identity,
      listeners,
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo(to, data) {
        const target = nodes.get(to)
        if (!target) throw new Error('unreachable peer')
        const text = JSON.stringify(data)
        queueMicrotask(() => { for (const cb of target.listeners) cb(podId, text) })
      },
    }
    node.registry = new PeerRegistry({ localPodId: podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: podId }) })
    nodes.set(podId, node)
  }
  return [...nodes.values()]
}

/** An ingress pod, a provider pod, and a stranger, each with a protocol service. `channelOptions` are the mesh channel's limits. */
export async function threePods({ channelOptions } = {}) {
  const [ingress, provider, stranger] = await createNodes(3)
  const svc = (node) => attachService(node, undefined, createMeshProtocolService(channelOptions))
  const i = svc(ingress)
  const p = svc(provider)
  const s = svc(stranger)
  return { ingress, provider, stranger, i, p, s, teardown() { i.teardown(); p.teardown(); s.teardown() } }
}

export const OPEN = 'protocol:http:open'

/** The provider grants the ingress the `http` protocol (and the ingress is named in `allowFrom` by the caller). */
export const grantHttp = (pods) => pods.provider.registry.grantCapabilities(pods.ingress.podId, [OPEN])

/** A mesh-rpc service attached to `node` (the legacy buffered path). */
export const attachRpc = (node, options) => attachService(node, undefined, createMeshRpcService(options))

/** A promise and its resolvers. */
export function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Wait until `fn()` is truthy by yielding to the event loop (no wall-clock assertion depends on it). */
export async function until(fn, what = 'condition') {
  for (let i = 0; i < 5000; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 2))
  }
  throw new Error(`gave up waiting for ${what}`)
}

/** A GET request for a host and path, the way a listener builds one. */
export const req = (url, init) => new Request(url, init)
