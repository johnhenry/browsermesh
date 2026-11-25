/**
 * A pod lends its network to a peer that holds a grant (`@johnhenry/browsermesh-egress`).
 *
 * The consumer has no sockets (think of a browser tab); the provider has. A local TCP echo server stands in for "the
 * network", and a resolver double names it `origin.test`: nothing here leaves this machine.
 *
 *   - the provider serves protocol `egress`, off until `start()`; the consumer needs `protocol:egress:open`, and then a
 *     grant for each destination: `egress:tcp:<host>:<port>:connect`, and `egress:dns:<name>:resolve` for a lookup;
 *   - the provider checks the address a name resolves to, with wsh's address guard, and connects to the address it
 *     checked: private space (this machine, here) is reachable only because the operator listed it in `allowPrivate`;
 *   - bytes move both ways with half-close and backpressure; the audit line carries who, where, the address class,
 *     bytes each way and duration, never contents;
 *   - revoking the grant ends the live connection at once.
 *
 * As in the other examples the link between the pods is a simulated in-process bus.
 */
import assert from 'node:assert/strict'
import net from 'node:net'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { attachService, createMeshProtocolService, PeerRegistry, protocolScope } from '@johnhenry/browsermesh-apps'
import { connectEgress, createMeshEgress, EGRESS_SCOPES } from '@johnhenry/browsermesh-egress'
import { nodeDialer } from '@johnhenry/browsermesh-egress/node'

// ── two pods on a simulated bus ─────────────────────────────────────────────
async function createNodes(count) {
  const nodes = new Map()
  for (let i = 0; i < count; i++) {
    const { podId } = await PodIdentity.generate()
    const listeners = new Set()
    nodes.set(podId, {
      podId,
      listeners,
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo(to, data) {
        const target = nodes.get(to)
        if (!target) throw new Error('unreachable peer')
        const text = JSON.stringify(data) // a real transport carries JSON text
        queueMicrotask(() => { for (const cb of target.listeners) cb(podId, text) })
      },
    })
  }
  return [...nodes.values()]
}
const [consumerNode, providerNode] = await createNodes(2)
for (const node of [consumerNode, providerNode]) {
  node.registry = new PeerRegistry({ localPodId: node.podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: node.podId }) })
}
const consumerSvc = attachService(consumerNode, undefined, createMeshProtocolService())
const providerSvc = attachService(providerNode, undefined, createMeshProtocolService())

// ── "the network": a local echo server ──────────────────────────────────────
const origin = net.createServer({ allowHalfOpen: true }, (socket) => {
  socket.on('data', (d) => socket.write(d))
  socket.on('end', () => socket.end())
  socket.on('error', () => {})
})
await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve))
const { port } = origin.address()

// ── the provider ────────────────────────────────────────────────────────────
const audit = []
const lookup = async (name) => {
  if (name === 'origin.test') return ['127.0.0.1']
  const e = new Error('no such name'); e.code = 'ENOTFOUND'; throw e
}
const egress = createMeshEgress({
  service: providerSvc,
  registry: providerNode.registry,
  ...nodeDialer({ lookup, allowPrivate: ['127.0.0.1/32'] }), // the operator's one allowance: this machine's loopback
  unattended: true,
  onAudit: (record) => audit.push(record),
})

// Off until started: nothing is served before this line.
egress.start()

// ── the consumer, step by step ──────────────────────────────────────────────
// 1. No grant for the protocol: refused, by name.
await assert.rejects(connectEgress(consumerSvc, providerNode.podId), (e) => e.code === 'provider-not-authorized')
console.log('no protocol grant: refused (provider-not-authorized)')

// 2. The protocol alone buys no destination.
providerNode.registry.grantCapabilities(consumerNode.podId, [protocolScope('egress')])
const link = await connectEgress(consumerSvc, providerNode.podId)
await assert.rejects(link.connect('origin.test', port), (e) => e.code === 'no-grant')
await assert.rejects(link.lookup('origin.test'), (e) => e.code === 'no-grant')
console.log('protocol but no destination grant: refused (no-grant), and nothing was dialled')

// 3. A grant for one host and one port.
providerNode.registry.grantCapabilities(consumerNode.podId, [EGRESS_SCOPES.tcp('origin.test', port), EGRESS_SCOPES.dns('origin.test')])
console.log('lookup:', await link.lookup('origin.test'))
const socket = await link.connect('origin.test', port)
await socket.write(new TextEncoder().encode('hello through a peer'))
await socket.end() // half-close: the origin sees the end, and answers what it has
const parts = []
for (let chunk = await socket.read(); chunk !== null; chunk = await socket.read()) parts.push(chunk)
const echoed = Buffer.concat(parts).toString()
assert.equal(echoed, 'hello through a peer')
console.log('echoed:', echoed)

// 4. Another port of the same host is not covered.
await assert.rejects(link.connect('origin.test', port + 1), (e) => e.code === 'no-grant')

// 5. The audit line: who, where, address class, bytes each way, duration; never contents.
await new Promise((resolve) => { const t = setInterval(() => { if (egress.stats().closed === 1) { clearInterval(t); resolve() } }, 5) })
const close = audit.find((r) => r.event === 'egress-close')
assert.equal(close.peer, consumerNode.podId)
assert.equal(close.host, 'origin.test')
assert.equal(close.addressClass, 'loopback')
assert.equal(close.bytesUp, 'hello through a peer'.length)
assert.equal(close.bytesDown, 'hello through a peer'.length)
assert.ok(!JSON.stringify(audit).includes('hello through'))
console.log('audit:', { host: close.host, port: close.port, addressClass: close.addressClass, bytesUp: close.bytesUp, bytesDown: close.bytesDown, reason: close.reason })

// 6. Revoking the grant ends a live connection at once.
const live = await link.connect('origin.test', port)
providerNode.registry.revokeCapabilities(consumerNode.podId, [EGRESS_SCOPES.tcp('origin.test', port)])
let ended
try { for (;;) { if ((await live.read()) === null) break } } catch (e) { ended = e }
assert.equal(ended?.reason, 'revoked')
console.log('revoked: the live connection ended (reason: %s)', ended.reason)

await link.close()
await egress.stop()
await new Promise((resolve) => origin.close(resolve))
consumerSvc.teardown()
providerSvc.teardown()
console.log('done')
