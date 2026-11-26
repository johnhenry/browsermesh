// Real WebRTC, the CLI as a child process: a pod tears itself down, in the order the README gives, while a request is in
// flight. The visitor is answered at once with a named failure (not left to the request deadline), however the pod's node
// is closed straight after: that is the case where a close notice that has not left the pod is lost with the link.
//
// The pod is a page's lean node (the apps package's `lean-node` entry, the slim browser entry's recipe), which does not close
// the WebRTC connection when it is shut down.
//
// Same optional `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as every other real-peer suite here.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
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
if (!ndc) describe('a pod torn down in flight, over real WebRTC', () => { it('skipped: optional dependency `node-datachannel` is not installed', () => {}) })
const describeIfReal = ndc ? describe : describe.skip

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '../../bin/browsermesh-ingress.mjs')
const ZONE = 'pods.example.test'
const WEBRTC_TIMEOUT_MS = 30_000
const PROMPT_MS = 8_000 // far under the request deadline (30 s by default): a request that waits for that has hung

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

/** A GET with a Host of the caller's choosing; resolves with what came back, or with `{ hung: true }` after `giveUpMs`. */
function get({ port, host, path: p = '/', giveUpMs }) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const timer = setTimeout(() => { req.destroy(); resolve({ hung: true, ms: Date.now() - t0 }) }, giveUpMs)
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, reason: res.headers['x-browsermesh-ingress-reason'], body: Buffer.concat(chunks).toString(), ms: Date.now() - t0 }) })
      res.on('error', reject)
    })
    req.on('error', (e) => { clearTimeout(timer); reject(e) })
    req.end()
  })
}

describeIfReal('a pod torn down while a request is in flight, over real WebRTC and the CLI', () => {
  let startServer, ingressPkg, apps, lean, core, podPkg
  let tmp, hub, signaling
  const cleanups = []

  before(async () => {
    Object.assign(globalThis, { RTCPeerConnection: ndc.RTCPeerConnection, RTCIceCandidate: ndc.RTCIceCandidate, RTCSessionDescription: ndc.RTCSessionDescription })
    ;({ startServer } = await import('../../../../tests/browser/server.mjs'))
    ingressPkg = await import('../../src/index.mjs')
    apps = await import('@johnhenry/browsermesh-apps')
    lean = await import('@johnhenry/browsermesh-apps/lean-node')
    core = await import('@johnhenry/browsermesh-core')
    podPkg = await import('@johnhenry/browsermesh-pod')
    tmp = await mkdtemp(path.join(tmpdir(), 'bm-ingress-teardown-'))
    hub = await startServer()
    signaling = `ws://127.0.0.1:${hub.port}/signaling`
  })

  after(async () => {
    for (const c of cleanups.splice(0).reverse()) { try { await c() } catch { /* gone */ } }
    try { await hub?.close() } catch { /* gone */ }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  /** A page's lean mesh node: a new identity, the signalling transport, the protocol service; `close()` shuts the node down and leaves its connections. */
  async function leanPod() {
    class Adopting extends core.MeshIdentityManager {
      #pending = null
      adopt(summary) { this.#pending = summary }
      async create(label, opts) { if (this.#pending) { const s = this.#pending; this.#pending = null; return s } return super.create(label, opts) }
    }
    const identityManager = new Adopting({})
    const summary = await identityManager.create('pod')
    const podId = summary.podId
    identityManager.adopt(summary)
    const transport = new podPkg.WebSocketTransport({
      url: signaling,
      podId,
      protocol: 'signaling',
      identity: { podId, rawPublicKey: () => identityManager.getPublicKeyBytes(podId), sign: (data) => identityManager.sign(podId, data) },
      authentication: 'auto',
    })
    await transport.open?.()
    const node = await lean.createLeanMeshNode({ label: 'pod', identityManager, signalingTransport: transport, iceServers: [] })
    const service = lean.attachService(node, undefined, lean.createMeshProtocolService())
    return {
      podId, node, service,
      async close() {
        try { service.teardown?.() } catch { /* gone */ }
        try { await node.shutdown() } catch { /* gone */ }
        try { await transport.close?.() } catch { /* gone */ }
      },
    }
  }

  /** The CLI granting the pod the right to claim names; the pod dials it, serves by name (a slow origin and a fast one), claims `app`, and has been answered once. */
  async function rig() {
    const pod = await leanPod()
    cleanups.push(() => pod.close())
    const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
    const out = { text: '' }
    const child = spawn(process.execPath, [BIN, '--listen', `127.0.0.1:${port}`, '--signaling', signaling, '--names-zone', ZONE, '--names-allow', `${pod.podId}=*`,
      '--identity', path.join(tmp, `ingress-${port}.json`)], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: tmp, USERPROFILE: tmp, XDG_CONFIG_HOME: tmp } })
    cleanups.push(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.once('close', r)) } })
    child.stdout.on('data', (d) => { out.text += d })
    child.stderr.on('data', (d) => { out.text += d })
    await waitFor(() => /listening on http/.test(out.text), WEBRTC_TIMEOUT_MS, `the CLI to start (output so far: ${out.text})`)
    const ingressPodId = /pod id: (\S+)/.exec(out.text)[1]
    const arrived = { count: 0 }
    const origin = (request) => new Promise((resolve) => {
      if (new URL(request.url).pathname === '/fast') { resolve(new Response('fast')); return }
      arrived.count += 1 // a slow origin: it never answers by itself, and does not notice that the request is gone
    })
    const served = ingressPkg.serveHttpOnMesh(pod.service, origin, { allowFrom: [ingressPodId], services: { web: origin } })
    cleanups.push(() => served.stop())
    pod.node.registry.grantCapabilities(ingressPodId, [apps.protocolScope('http')])
    await pod.node.connectToPeer(ingressPodId, { webrtc: ingressPodId }, { answerTimeoutMs: WEBRTC_TIMEOUT_MS, openTimeoutMs: WEBRTC_TIMEOUT_MS })
    const client = await ingressPkg.openNameClient(pod.service, ingressPodId)
    await client.claim('app', { service: 'web' })
    const visit = (p) => get({ port, host: `app.${ZONE}`, path: p, giveUpMs: PROMPT_MS })
    const first = await visit('/fast')
    assert.equal(first.status, 200, out.text)
    return { pod, served, client, arrived, out, visit }
  }

  it('the README order, the node closed the moment stop() resolves: the visitor is answered 502 provider-closed at once', async () => {
    const t = await rig()
    const answer = t.visit('/slow')
    await waitFor(() => t.arrived.count === 1, 15_000, 'the request to reach the pod')
    await t.client.close()
    await t.served.stop()
    await t.pod.close()
    const r = await answer
    assert.ok(!r.hung, `the request was still unanswered ${r.ms} ms after the pod went\n${t.out.text}`)
    assert.deepEqual([r.status, r.reason], [502, 'provider-closed'], t.out.text)
    assert.match(t.out.text, /name release app\.pods\.example\.test/, 'and the name was given up by the goodbye')
  })

  it('a grace that runs out: the goodbye makes the name a 404 at once, and the request still being answered then ends 502 provider-closed', async () => {
    const t = await rig()
    const answer = t.visit('/slow')
    await waitFor(() => t.arrived.count === 1, 15_000, 'the request to reach the pod')
    await t.client.close()
    const late = await t.visit('/fast')
    assert.deepEqual([late.status, late.reason], [404, 'no-mapping'], 'nobody new is sent to a pod that said goodbye')
    await t.served.stop({ graceMs: 300 }) // the origin never answers: the grace runs out
    await t.pod.close()
    const r = await answer
    assert.ok(!r.hung, `unanswered ${r.ms} ms\n${t.out.text}`)
    assert.deepEqual([r.status, r.reason], [502, 'provider-closed'], t.out.text)
  })
})
