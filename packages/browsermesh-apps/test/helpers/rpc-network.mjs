import { PodIdentity } from '@johnhenry/browsermesh-primitives'

export async function network() {
  const nodes = new Map()
  const make = async () => {
    const identity = await PodIdentity.generate(), listeners = new Set()
    const node = {
      podId: identity.podId,
      listeners,
      onIncomingData(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      async sendTo(id, message) {
        const other = nodes.get(id)
        if (!other) throw new Error('unreachable peer')
        // Deliberately cross a JSON serialization boundary, as real transports do.
        const text = JSON.stringify(message)
        queueMicrotask(() => { for (const fn of other.listeners) fn(node.podId, text) })
      },
    }
    nodes.set(node.podId, node)
    return node
  }
  return Promise.all([make(), make(), make()])
}
