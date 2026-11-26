// Real WebRTC. A pod claims a name over a real data channel to the ingress, a real HTTP client is answered at that name by a
// named service on the pod, and the name is held for the pod when its channel closes.
//
// Same optional `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as every other real-peer suite here.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

let ndc = null
let ndcMain = null
try {
  ndc = await import('node-datachannel/polyfill')
  ndcMain = await import('node-datachannel')
} catch { /* optional dependency absent: the suite below skips */ }

if (!ndc && process.env.REQUIRE_REAL_PEER) {
  throw new Error('REQUIRE_REAL_PEER is set but `node-datachannel` did not load, so the real-peer suite would have skipped and reported success. Install the dependency, or unset REQUIRE_REAL_PEER to allow the skip.')
}
if (!ndc) describe('names over real WebRTC peers', () => { it('skipped: optional dependency `node-datachannel` is not installed', () => {}) })
const describeIfReal = ndc ? describe : describe.skip

const WEBRTC_TIMEOUT_MS = 30_000
const ZONE = 'pods.example.test'

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

const request = ({ port, host, path: p = '/' }) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    res.on('error', reject)
  })
  req.on('error', reject)
  req.end()
})

describeIfReal('a pod claims a name over a real data channel', () => {
  let apps, pkg, node
  const nodes = {}
  const services = {}
  let table, namesServed, served, mesh, listener, client

  before(async () => {
    Object.assign(globalThis, { RTCPeerConnection: ndc.RTCPeerConnection, RTCIceCandidate: ndc.RTCIceCandidate, RTCSessionDescription: ndc.RTCSessionDescription })
    apps = await import('@johnhenry/browsermesh-apps')
    pkg = await import('../../src/index.mjs')
    node = await import('../../src/node.mjs')
    const { ManualStrategy, DiscoveryRecord } = await import('@johnhenry/browsermesh-discovery')
    const bus = new Set()
    const transport = () => { let handler = null; const rx = (m) => handler?.(m); bus.add(rx); return { send(m) { for (const fn of bus) if (fn !== rx) fn(m) }, onMessage(cb) { handler = cb } } }
    const discovery = { ingress: new ManualStrategy(), provider: new ManualStrategy() }
    for (const label of ['ingress', 'provider']) nodes[label] = await apps.createMeshNode({ label, discoveryStrategies: [discovery[label]], signalingTransport: transport(), iceServers: [] })
    discovery.ingress.addPeer(new DiscoveryRecord({ podId: nodes.provider.podId, transport: 'webrtc', label: 'provider' }))
    discovery.provider.addPeer(new DiscoveryRecord({ podId: nodes.ingress.podId, transport: 'webrtc', label: 'ingress' }))
    await nodes.ingress.discover()
    await nodes.provider.discover()
    // The pod dials the ingress: it is the pod that claims, so it is the pod that has the link.
    await nodes.provider.connectToPeer(nodes.ingress.podId, { webrtc: nodes.ingress.podId }, { answerTimeoutMs: WEBRTC_TIMEOUT_MS, openTimeoutMs: WEBRTC_TIMEOUT_MS })
    await waitFor(() => nodes.ingress.meshManager.getConnection(nodes.provider.podId)?.isOpen, WEBRTC_TIMEOUT_MS, "the ingress's side of the data channel to open")
    for (const label of ['ingress', 'provider']) services[label] = apps.attachService(nodes[label], undefined, apps.createMeshProtocolService())

    table = pkg.createNameTable({ zone: ZONE, allow: pkg.registryAllow(nodes.ingress.registry), holdMs: 60_000 })
    namesServed = pkg.serveIngressNames(services.ingress, table)
    nodes.ingress.registry.grantCapabilities(nodes.provider.podId, [apps.protocolScope(pkg.NAMES_PROTOCOL), 'ingress:name:app:claim', 'ingress:name:docs:claim'])
    served = pkg.serveHttpOnMesh(services.provider, null, {
      allowFrom: [nodes.ingress.podId],
      services: { web: () => new Response('the web service'), docs: (req, { service }) => new Response(`docs via ${service}`) },
    })
    nodes.provider.registry.grantCapabilities(nodes.ingress.podId, [apps.protocolScope('http')])
    mesh = pkg.createMeshIngress({ service: services.ingress, names: table })
    listener = await node.listenNode(mesh, { port: 0 })
  })

  after(async () => {
    try { client?.close() } catch { /* gone */ }
    try { await listener?.close() } catch { /* gone */ }
    try { await mesh?.close() } catch { /* gone */ }
    try { namesServed?.stop() } catch { /* gone */ }
    try { served?.stop() } catch { /* gone */ }
    for (const s of Object.values(services)) { try { s.teardown() } catch { /* gone */ } }
    for (const n of Object.values(nodes)) { try { await n.shutdown() } catch { /* gone */ } }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('claims names for two services, is answered at each, and is refused a name it has no grant for', async () => {
    client = await pkg.openNameClient(services.provider, nodes.ingress.podId, { timeoutMs: WEBRTC_TIMEOUT_MS })
    assert.equal((await client.claim('app', { service: 'web' })).host, `app.${ZONE}`)
    await client.claim('docs', { service: 'docs' })
    await assert.rejects(client.claim('blog'), (e) => e.reason === 'not-granted')
    const app = await request({ port: listener.port, host: `app.${ZONE}` })
    assert.equal(app.status, 200)
    assert.equal(app.body, 'the web service')
    assert.equal((await request({ port: listener.port, host: `docs.${ZONE}` })).body, 'docs via docs')
    assert.equal((await request({ port: listener.port, host: `blog.${ZONE}` })).status, 404)
  })

  it('when the channel closes the name is held for the pod, and claiming again on a new channel gets it back', async () => {
    client.close()
    await waitFor(() => table.lookup(`app.${ZONE}`)?.held === true, WEBRTC_TIMEOUT_MS, 'the name to be held')
    client = await pkg.openNameClient(services.provider, nodes.ingress.podId, { timeoutMs: WEBRTC_TIMEOUT_MS })
    await client.claim('app', { service: 'web' })
    assert.equal(table.lookup(`app.${ZONE}`).held, false)
    assert.equal((await request({ port: listener.port, host: `app.${ZONE}` })).body, 'the web service')
  })
})
