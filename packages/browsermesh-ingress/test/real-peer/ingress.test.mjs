// Real WebRTC. Two mesh nodes (real identities, a real data channel between them, loopback host candidates only):
// a real HTTP client -> the Node listener -> the ingress -> the protocol channel over the data channel -> a pod that
// answers. Then the CLI as a child process doing the same through a real WebSocket signalling server.
//
// Same optional `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as every other real-peer suite here.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

let ndc = null
let ndcMain = null
try {
  ndc = await import('node-datachannel/polyfill')
  ndcMain = await import('node-datachannel')
} catch { /* optional dependency absent: the suite below skips */ }

if (!ndc && process.env.REQUIRE_REAL_PEER) {
  throw new Error('REQUIRE_REAL_PEER is set but `node-datachannel` did not load, so the real-peer suite would have skipped and reported success. Install the dependency, or unset REQUIRE_REAL_PEER to allow the skip.')
}
if (!ndc) describe('ingress over real WebRTC peers', () => { it('skipped: optional dependency `node-datachannel` is not installed', () => {}) })
const describeIfReal = ndc ? describe : describe.skip

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '../../bin/browsermesh-ingress.mjs')

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}
const WEBRTC_TIMEOUT_MS = 30_000

/** An HTTP request with a Host the caller chooses (fetch does not allow it). */
function request({ port, host, path: p = '/', method = 'GET', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host, ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}

describeIfReal('HTTP in, a pod over a real WebRTC data channel answers', () => {
  let apps, ingressPkg, node
  const nodes = {}
  const services = {}
  let listener, mesh, served

  before(async () => {
    Object.assign(globalThis, { RTCPeerConnection: ndc.RTCPeerConnection, RTCIceCandidate: ndc.RTCIceCandidate, RTCSessionDescription: ndc.RTCSessionDescription })
    apps = await import('@johnhenry/browsermesh-apps')
    ingressPkg = await import('../../src/index.mjs')
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
    await nodes.ingress.connectToPeer(nodes.provider.podId, { webrtc: nodes.provider.podId }, { answerTimeoutMs: WEBRTC_TIMEOUT_MS, openTimeoutMs: WEBRTC_TIMEOUT_MS })
    await waitFor(() => nodes.provider.meshManager.getConnection(nodes.ingress.podId)?.isOpen, WEBRTC_TIMEOUT_MS, "the provider's side of the data channel to open")
    for (const label of ['ingress', 'provider']) services[label] = apps.attachService(nodes[label], undefined, apps.createMeshProtocolService())

    served = ingressPkg.serveHttpOnMesh(services.provider, async (req, { peer }) => {
      const url = new URL(req.url)
      if (url.pathname === '/big') return new Response(new Uint8Array(1_200_000).map((_, i) => i % 251), { headers: { 'content-type': 'application/octet-stream' } })
      if (url.pathname === '/echo') return new Response(`${req.method} ${await req.text()} from ${peer === nodes.ingress.podId ? 'the ingress' : 'someone else'}`, { headers: { 'set-cookie': 'sid=1' } })
      return new Response('<h1>hello from a pod</h1>', { headers: { 'content-type': 'text/html' } })
    }, { allowFrom: [nodes.ingress.podId] })
    mesh = ingressPkg.createMeshIngress({
      service: services.ingress,
      resolve: (r) => (new URL(r.url).host === 'pod.test' ? { peer: nodes.provider.podId } : null),
      methods: ['GET', 'HEAD', 'POST'],
    })
    listener = await node.listenNode(mesh, { port: 0 })
  })

  after(async () => {
    try { await listener?.close() } catch { /* gone */ }
    try { await mesh?.close() } catch { /* gone */ }
    try { served?.stop() } catch { /* gone */ }
    for (const s of Object.values(services)) { try { s.teardown() } catch { /* gone */ } }
    for (const n of Object.values(nodes)) { try { await n.shutdown() } catch { /* gone */ } }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('with no grant the provider refuses, and the HTTP client gets a 502 with a named reason', async () => {
    const res = await request({ port: listener.port, host: 'pod.test' })
    assert.equal(res.status, 502)
    assert.equal(res.headers['x-browsermesh-ingress-reason'], 'provider-not-authorized')
  })

  it('with the grant a page is served, with the policy headers, and a POST reaches the pod from the ingress\'s pod id', async () => {
    nodes.provider.registry.grantCapabilities(nodes.ingress.podId, [apps.protocolScope('http')])
    const page = await request({ port: listener.port, host: 'pod.test' })
    assert.equal(page.status, 200)
    assert.equal(page.body.toString(), '<h1>hello from a pod</h1>')
    assert.equal(page.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'; sandbox")
    assert.equal(page.headers['cache-control'], 'no-store')
    const echo = await request({ port: listener.port, host: 'pod.test', path: '/echo', method: 'POST', body: 'ping' })
    assert.equal(echo.body.toString(), 'POST ping from the ingress')
    assert.equal(echo.headers['set-cookie'], undefined)
  })

  it('a 1.2 MB body crosses the data channel in chunks, intact', async () => {
    const res = await request({ port: listener.port, host: 'pod.test', path: '/big' })
    assert.equal(res.body.byteLength, 1_200_000)
    assert.ok(res.body.every((b, i) => b === i % 251))
  })

  it('an unmapped host is a 404; revoking the grant ends the pod\'s service at once', async () => {
    assert.equal((await request({ port: listener.port, host: 'other.test' })).status, 404)
    nodes.provider.registry.revokeCapabilities(nodes.ingress.podId, [apps.protocolScope('http')])
    await waitFor(async () => (await request({ port: listener.port, host: 'pod.test' })).status === 502, 10_000, 'the revoked grant to refuse the next request')
  })
})

describeIfReal('the CLI as a child process, through a real signalling server', () => {
  let startServer, startMeshNode, ingressPkg, apps
  let tmp, hub, provider, served
  let child, port, podId, output

  before(async () => {
    ;({ startServer } = await import('../../../../tests/browser/server.mjs'))
    ;({ startMeshNode } = await import('../../src/cli/mesh-node.mjs'))
    ingressPkg = await import('../../src/index.mjs')
    apps = await import('@johnhenry/browsermesh-apps')
    tmp = await mkdtemp(path.join(tmpdir(), 'bm-ingress-cli-real-'))
    hub = await startServer()
    provider = await startMeshNode({ signaling: `ws://127.0.0.1:${hub.port}/signaling`, identityPath: path.join(tmp, 'provider.json') })

    // a free loopback port for the CLI to listen on
    port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
    child = spawn(process.execPath, [BIN, '--listen', `127.0.0.1:${port}`, '--signaling', `ws://127.0.0.1:${hub.port}/signaling`, '--map', `pod.test=${provider.podId}`,
      '--identity', path.join(tmp, 'ingress.json'), '--allow-methods', 'GET,HEAD,POST'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: tmp, USERPROFILE: tmp, XDG_CONFIG_HOME: tmp } })
    output = ''
    child.stdout.on('data', (d) => { output += d })
    child.stderr.on('data', (d) => { output += d })
    await waitFor(() => /listening on http/.test(output), WEBRTC_TIMEOUT_MS, `the CLI to start (output so far: ${output})`)
    podId = /pod id: (\S+)/.exec(output)[1]

    served = ingressPkg.serveHttpOnMesh(provider.service, async (req) => new Response(`served ${req.method} ${new URL(req.url).pathname} ${await req.text()}`, { headers: { 'content-type': 'text/plain' } }), { allowFrom: [podId] })
    provider.node.registry.grantCapabilities(podId, [apps.protocolScope('http')])
  })

  after(async () => {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.once('close', r)) }
    try { served?.stop() } catch { /* gone */ }
    try { await provider?.close() } catch { /* gone */ }
    try { await hub?.close() } catch { /* gone */ }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  it('prints what it serves, its pod id and where it listens', () => {
    assert.match(output, new RegExp(`serving pod\\.test -> ${provider.podId}`))
    assert.match(output, /methods: GET, HEAD, POST/)
    assert.match(output, new RegExp(`listening on http://127\\.0\\.0\\.1:${port}`))
  })

  it('an HTTP request is answered by the mapped pod over a real data channel; a POST body arrives; the policy headers are there', async () => {
    const get = await request({ port, host: 'pod.test', path: '/hello' })
    assert.equal(get.status, 200)
    assert.equal(get.body.toString(), 'served GET /hello ')
    assert.equal(get.headers['x-content-type-options'], 'nosniff')
    const post = await request({ port, host: 'pod.test', path: '/form', method: 'POST', body: 'a=1' })
    assert.equal(post.body.toString(), 'served POST /form a=1')
  })

  it('an unmapped host is a 404, a method that is not allowed is a 405', async () => {
    assert.equal((await request({ port, host: 'nope.test' })).status, 404)
    assert.equal((await request({ port, host: 'pod.test', method: 'DELETE' })).status, 405)
  })

  it('the identity file is reused: the same pod id on the next start, and the file is private to its owner', async () => {
    const { stat } = await import('node:fs/promises')
    assert.equal((await stat(path.join(tmp, 'ingress.json'))).mode & 0o077, 0)
    const signaling = `ws://127.0.0.1:${hub.port}/signaling`
    const first = await startMeshNode({ signaling, identityPath: path.join(tmp, 'reused.json') })
    assert.equal(first.created, true)
    await first.close()
    const second = await startMeshNode({ signaling, identityPath: path.join(tmp, 'reused.json') })
    assert.equal(second.created, false)
    assert.equal(second.podId, first.podId)
    await second.close()
  })

  it('a damaged identity file is refused, never overwritten', async () => {
    const { writeFile, readFile } = await import('node:fs/promises')
    const file = path.join(tmp, 'damaged.json')
    await writeFile(file, '{ not json')
    await assert.rejects(startMeshNode({ signaling: `ws://127.0.0.1:${hub.port}/signaling`, identityPath: file }), /not valid JSON; refusing to overwrite/)
    assert.equal(await readFile(file, 'utf8'), '{ not json')
  })
})
