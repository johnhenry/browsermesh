// Pods that can reach each other over an in-memory JSON bus (as a real transport carries text), each with its own real
// PeerRegistry and real mesh protocol service.
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { PeerRegistry } from '../../src/peer-registry.mjs'
import { attachService } from '../../src/mesh-service.mjs'
import { createMeshProtocolService } from '../../src/protocol-channel.mjs'

export async function pods(count) {
  const nodes = new Map()
  const out = []
  for (let i = 0; i < count; i++) {
    const identity = await PodIdentity.generate()
    const listeners = new Set()
    const node = {
      identity,
      podId: identity.podId,
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo(to, data) {
        const target = nodes.get(to)
        if (!target) throw new Error('unreachable peer')
        const text = JSON.stringify(data)
        queueMicrotask(() => { for (const cb of target.listeners) cb(identity.podId, text) })
      },
    }
    node.listeners = listeners
    node.registry = new PeerRegistry({ localPodId: identity.podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: identity.podId }) })
    node.service = attachService(node, undefined, createMeshProtocolService()).api
    nodes.set(identity.podId, node)
    out.push(node)
  }
  return out
}

/** A service whose channels pass the BYTES they carry through `tap(direction, bytes)` (return bytes to pass on, or null to drop); control objects pass untouched. */
export function hostile(api, tap) {
  const wrap = (ch) => new Proxy(ch, {
    get(target, key) {
      if (key === 'send') return (m, opts) => { if (!(m instanceof Uint8Array)) return target.send(m, opts); const out = tap('to-relay', m); return out === null ? Promise.resolve() : target.send(out, opts) }
      if (key === 'onMessage') return (cb) => target.onMessage((m, ctx) => { if (!(m instanceof Uint8Array)) return cb(m, ctx); const out = tap('to-client', m); return out === null ? undefined : cb(out, ctx) })
      const value = target[key]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    openProtocol: async (peer, name, opts = {}) => wrap(await api.openProtocol(peer, name, { ...opts, setup: opts.setup && ((ch) => opts.setup(wrap(ch))) })),
  }
}

export async function waitFor(fn, what, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out waiting for: ${what}`)
}
