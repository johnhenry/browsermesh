/**
 * Test helpers: a simulated bus of pods (JSON over a microtask, as a real transport carries
 * text), a PeerRegistry per node, a fake window with a capture, and a serving/consuming
 * pair wired the way a deployment would wire them.
 */
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { attachService, createMeshProtocolService, PeerRegistry } from '@johnhenry/browsermesh-apps'
import { captureWebMcp } from '@johnhenry/wsh/page'

/** `count` nodes that can reach each other. */
export async function bus(count, { clock } = {}) {
  const nodes = new Map()
  const out = []
  for (let i = 0; i < count; i++) {
    const { podId } = await PodIdentity.generate()
    const listeners = new Set()
    const node = {
      podId,
      listeners,
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo(to, data) {
        const target = nodes.get(to)
        if (!target) throw new Error('unreachable peer')
        const text = JSON.stringify(data)
        queueMicrotask(() => { for (const cb of target.listeners) cb(podId, text) })
      },
    }
    node.registry = new PeerRegistry({ localPodId: podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: podId }), ...(clock ? { clock } : {}) })
    nodes.set(podId, node)
    out.push(node)
  }
  return out
}

/** A service (the api of attachService + createMeshProtocolService) for a node. */
export function serviceOn(node, options) {
  return attachService(node, undefined, createMeshProtocolService(options)).api
}

/** A fake window with a WebMCP capture installed: pages register tools on `window.navigator.modelContext`. */
export function fakeWindow() {
  const window = { navigator: {} }
  const capture = captureWebMcp(window)
  return { window, capture, register: (tool) => window.navigator.modelContext.registerTool(tool) }
}

/** A tool definition. `execute` defaults to echoing its input as text. */
export function tool(name, extra = {}) {
  return {
    name,
    description: `the ${name} tool`,
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true },
    execute: async (input) => `${name}: ${input.text ?? ''}`,
    ...extra,
  }
}

/** Let queued microtasks and immediates settle (the bus delivers on microtasks). */
export const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }

/** Resolves when `predicate()` holds, checked after each turn of the event loop (no clock). */
export async function until(predicate, what = 'condition') {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return
    await new Promise((r) => setImmediate(r))
  }
  throw new Error(`gave up waiting for ${what}`)
}
