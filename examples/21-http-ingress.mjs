/**
 * Real HTTP in, a mesh pod answers (`@johnhenry/browsermesh-ingress`).
 *
 * A real HTTP request (Node's `fetch`) reaches a listener on loopback; the ingress forwards it, over protocol `http`
 * on a protocol channel, to the ONE pod the mapping names; that pod's `(Request) => Response` handler answers.
 *
 *   - the provider serves a handler to the ingress pod it names in `allowFrom`, and the ingress needs the grant
 *     `protocol:http:open` in the provider's registry: before it, the HTTP client is told so (502, by name);
 *   - the answer is accepted only from the pod the mapping names (a stranger that is also serving the protocol is
 *     never asked);
 *   - what the HTTP client gets is the ingress's policy, not the pod's: Set-Cookie stripped, an inert
 *     Content-Security-Policy, no-store;
 *   - the operator's methods are the only ones served; a body over the cap is refused; an unmapped host is a 404;
 *   - the audit record has the pod, status, bytes and duration, never the query string.
 *
 * As in the other examples the link between the pods is a simulated in-process bus.
 */
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { attachService, createMeshProtocolService, PeerRegistry, protocolScope } from '@johnhenry/browsermesh-apps'
import { createMeshIngress, serveHttpOnMesh } from '@johnhenry/browsermesh-ingress'
import { listenNode } from '@johnhenry/browsermesh-ingress/node'

// ── a simulated bus of three pods ───────────────────────────────────────────
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
const [ingressNode, siteNode, strangerNode] = await createNodes(3)
for (const node of [ingressNode, siteNode, strangerNode]) {
  node.registry = new PeerRegistry({ localPodId: node.podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: node.podId }) })
}
const ingressSvc = attachService(ingressNode, undefined, createMeshProtocolService())
const siteSvc = attachService(siteNode, undefined, createMeshProtocolService())
const strangerSvc = attachService(strangerNode, undefined, createMeshProtocolService())

// ── the pod that answers: a (Request) => Response handler ───────────────────
const seen = []
const site = serveHttpOnMesh(siteSvc, async (request, { peer }) => {
  const url = new URL(request.url)
  seen.push({ method: request.method, path: url.pathname, peer })
  if (url.pathname === '/echo') return new Response(`you sent: ${await request.text()}`, { headers: { 'content-type': 'text/plain' } })
  // A pod can say anything it likes; the ingress decides what reaches the HTTP client.
  return new Response('<h1>hello from a pod</h1>', { headers: { 'content-type': 'text/html', 'set-cookie': 'sid=1', 'content-security-policy': 'default-src *' } })
}, { allowFrom: [ingressNode.podId] })

// A stranger that serves the protocol too, to show that only the mapped pod ever answers.
let strangerAsked = 0
serveHttpOnMesh(strangerSvc, () => { strangerAsked += 1; return new Response('not me') }, { allowFrom: [ingressNode.podId] })
strangerNode.registry.grantCapabilities(ingressNode.podId, [protocolScope('http')])

// ── the ingress and a real listener on loopback ─────────────────────────────
const audits = []
const ingress = createMeshIngress({
  service: ingressSvc,
  resolve: (request) => (new URL(request.url).host.startsWith('127.0.0.1:') ? { peer: siteNode.podId } : null),
  methods: ['GET', 'HEAD', 'POST'],
  onAudit: (record) => audits.push(record),
})
const listener = await listenNode(ingress, { port: 0 }) // 127.0.0.1, plain HTTP: terminate TLS in front of it
const base = `http://127.0.0.1:${listener.port}`

// Nothing granted yet: the provider refuses, and the HTTP client is told so by name.
const refused = await fetch(`${base}/`)
assert.equal(refused.status, 502)
assert.equal(refused.headers.get('x-browsermesh-ingress-reason'), 'provider-not-authorized')

// The provider grants the ingress pod the protocol.
siteNode.registry.grantCapabilities(ingressNode.podId, [protocolScope('http')])
const page = await fetch(`${base}/?secret=not-in-the-audit-log`)
assert.equal(page.status, 200)
assert.equal(await page.text(), '<h1>hello from a pod</h1>')
assert.equal(page.headers.getSetCookie().length, 0) // the pod's cookie never reaches the client
assert.equal(page.headers.get('content-security-policy'), "default-src 'none'; sandbox") // nor its own policy
assert.equal(page.headers.get('cache-control'), 'no-store')
assert.equal(page.headers.get('x-content-type-options'), 'nosniff')

// A POST body crosses as a protocol stream; the pod sees the ingress's verified pod id, not a header.
const echoed = await fetch(`${base}/echo`, { method: 'POST', body: 'ping' })
assert.equal(await echoed.text(), 'you sent: ping')
assert.equal(seen.at(-1).peer, ingressNode.podId)

// Safe defaults: a method the operator did not allow, a body over the cap, an unmapped host, an upgrade.
assert.equal((await fetch(`${base}/`, { method: 'DELETE' })).status, 405)
assert.equal((await fetch(`${base}/echo`, { method: 'POST', body: new Uint8Array(70_000) })).status, 413)
assert.equal(strangerAsked, 0)
await ingress.close()
await listener.close()
site.stop()

// The audit log: pod, status, bytes, duration. Never a query string.
const served = audits.find((a) => a.status === 200 && a.method === 'GET')
assert.equal(served.peer, siteNode.podId)
assert.ok(served.responseBytes > 0 && served.durationMs >= 0)
assert.ok(!JSON.stringify(audits).includes('secret'))

for (const svc of [ingressSvc, siteSvc, strangerSvc]) svc.teardown()
console.log('ok: real HTTP was answered by the mapped pod only; the client got the ingress\'s policy, not the pod\'s; refusals were named and audited without the query')
