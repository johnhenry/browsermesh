// Real WebRTC, the CLI as a child process, a real signalling hub. One pod identity stops and starts again many times against
// the one ingress process that never restarts; every request during and after each cycle is answered whole, however the pod
// stopped (its node closed with the connection left open, or everything closed), and a pod that dials an ingress that is
// dialling it (a hand mapping with the CLI's default dialling) gets its first answer without a long wait.
//
// Same optional `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as every other real-peer suite here.
import { describe, it, before, after, afterEach } from 'node:test'
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
if (!ndc) describe('a pod that stops and starts again over real WebRTC', () => { it('skipped: optional dependency `node-datachannel` is not installed', () => {}) })
const describeIfReal = ndc ? describe : describe.skip

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '../../bin/browsermesh-ingress.mjs')
const WEBRTC_TIMEOUT_MS = 30_000
const ZONE = 'pods.example.test'

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

/** An HTTP request with a Host the caller chooses; resolves with what arrived, and says if the connection was cut. */
function request({ port, host, path: p = '/' }) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, reason: res.headers['x-browsermesh-ingress-reason'], body: Buffer.concat(chunks) }))
      res.on('aborted', () => resolve({ status: res.statusCode, cut: true, body: Buffer.concat(chunks) }))
      res.on('error', (e) => resolve({ status: res.statusCode, cut: true, error: e.code, body: Buffer.concat(chunks) }))
    })
    req.setTimeout(WEBRTC_TIMEOUT_MS, () => { req.destroy(); resolve({ timedOut: true }) })
    req.on('error', (e) => resolve({ cut: true, error: e.code }))
    req.end()
  })
}

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })

describeIfReal('a pod that stops and starts again against a running ingress, over real WebRTC', () => {
  let tmp, hub, startMeshNode, ingressPkg, apps, signaling
  let child, port, output, ingressPodId, podId
  // Everything a test starts is tracked here and stopped by `afterEach`, so a test that fails halfway (an assertion thrown
  // between a start and its stop) leaves no pod, signalling socket or CLI process behind to keep the process alive.
  const pods = new Set()
  const clis = new Set()

  const env = () => ({ PATH: process.env.PATH, HOME: tmp, USERPROFILE: tmp, XDG_CONFIG_HOME: tmp })
  async function startCli(args) {
    const p = await freePort()
    const c = spawn(process.execPath, [BIN, '--listen', `127.0.0.1:${p}`, '--signaling', signaling, '--identity', path.join(tmp, `ingress-${p}.json`), ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: env() })
    const out = { text: '' }
    c.stdout.on('data', (d) => { out.text += d })
    c.stderr.on('data', (d) => { out.text += d })
    clis.add(c)
    await waitFor(() => /listening on http/.test(out.text), WEBRTC_TIMEOUT_MS, `the CLI to start (output so far: ${out.text})`)
    return { child: c, port: p, out, podId: /pod id: (\S+)/.exec(out.text)[1] }
  }
  const stopCli = async (c) => {
    clis.delete(c)
    if (c && c.exitCode === null) { c.kill('SIGTERM'); await new Promise((r) => c.once('close', r)) }
  }

  /** The pod: a stored identity, a mesh node, `http` served by name, and a name claimed. `mode` says how it stops. */
  async function startPod({ mode = 'shutdown-only', claim = true, dial = false, ingress = ingressPodId } = {}) {
    const mesh = await startMeshNode({ signaling, identityPath: path.join(tmp, 'pod.json') })
    mesh.node.registry.grantCapabilities(ingress, [apps.protocolScope('http')])
    const served = ingressPkg.serveHttpOnMesh(mesh.service, null, {
      allowFrom: [ingress],
      services: { web: (req) => (new URL(req.url).pathname === '/big' ? new Response(new Uint8Array(300_000).fill(7)) : new Response(`web answered ${new URL(req.url).pathname}`)) },
    })
    let client = null
    try {
      if (claim) {
        client = await ingressPkg.openNameClient(mesh.service, ingress, { timeoutMs: WEBRTC_TIMEOUT_MS })
        await client.claim('app', { service: 'web' })
      } else if (dial) {
        await mesh.node.connectToPeer(ingress, { webrtc: ingress }, { answerTimeoutMs: WEBRTC_TIMEOUT_MS, openTimeoutMs: WEBRTC_TIMEOUT_MS }).catch(() => {})
      }
    } catch (e) {
      // A pod that did not come up is not in `pods` for `afterEach` to stop: its node, signalling socket and connections would
      // keep the process alive after the test failed.
      try { await served.stop() } catch { /* gone */ }
      try { await mesh.close() } catch { /* gone */ }
      throw e
    }
    let stopped = false
    const pod = {
      mesh, served, client,
      async stop() {
        if (stopped) return
        stopped = true
        pods.delete(pod)
        if (client) await client.release('app').catch(() => {})
        // The node is closed, the connection it had is left as it is (what a page that closes its node and keeps running does);
        // only the signalling socket goes, or the hub would see the old node reconnect and take the pod id from the new one.
        if (mode === 'shutdown-only') { await mesh.node.shutdown(); await mesh.node.signaling.close() }
        // `stop()` returns once the close notices have left (bounded): waited for, so they are not still going out while the
        // node under them is torn down.
        else { await served.stop(); await mesh.close() }
      },
    }
    pods.add(pod)
    return pod
  }

  before(async () => {
    Object.assign(globalThis, { RTCPeerConnection: ndc.RTCPeerConnection, RTCIceCandidate: ndc.RTCIceCandidate, RTCSessionDescription: ndc.RTCSessionDescription })
    ;({ startServer: globalThis.__startServer } = await import('../../../../tests/browser/server.mjs'))
    ;({ startMeshNode } = await import('../../src/cli/mesh-node.mjs'))
    ingressPkg = await import('../../src/index.mjs')
    apps = await import('@johnhenry/browsermesh-apps')
    tmp = await mkdtemp(path.join(tmpdir(), 'bm-ingress-restart-'))
    hub = await globalThis.__startServer()
    signaling = `ws://127.0.0.1:${hub.port}/signaling`
    // The pod's identity is created once and stored: every start is the same pod id.
    const first = await startMeshNode({ signaling, identityPath: path.join(tmp, 'pod.json') })
    podId = first.podId
    await first.close()
  })

  // Whatever a test left running, on failure or not: every pod, then every CLI process.
  const stopEverything = async () => {
    for (const pod of [...pods]) { try { await pod.stop() } catch { /* gone */ } }
    for (const c of [...clis]) { try { await stopCli(c) } catch { /* gone */ } }
  }
  afterEach(stopEverything)

  after(async () => {
    await stopEverything()
    try { await hub?.close() } catch { /* gone */ }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  for (const mode of ['shutdown-only', 'everything-closed']) {
    const cycles = mode === 'shutdown-only' ? 20 : 10
    it(`${cycles} cycles, the node closed with ${mode === 'shutdown-only' ? 'its connection left open' : 'everything closed'}: each time the same identity is answered whole`, async () => {
      const cli = await startCli(['--names-zone', ZONE, '--names-allow', `${podId}=app`])
      child = cli.child
      port = cli.port
      ingressPodId = cli.podId
      try {
        for (let cycle = 1; cycle <= cycles; cycle++) {
          const pod = await startPod({ mode })
          for (const p of ['/a', '/b']) {
            const r = await request({ port, host: `app.${ZONE}`, path: p })
            assert.deepEqual([r.status, r.cut, r.body.toString()], [200, undefined, `web answered ${p}`], `cycle ${cycle} ${p}: ${r.reason ?? r.error ?? ''}`)
          }
          const big = await request({ port, host: `app.${ZONE}`, path: '/big' })
          assert.deepEqual([big.status, big.cut, big.body.length], [200, undefined, 300_000], `cycle ${cycle} /big`)
          await pod.stop()
        }
        assert.doesNotMatch(cli.out.text, /provider-failed|provider-closed/, 'the ingress logged no failed answer')
      } finally { await stopCli(cli.child) }
    })
  }

  it('a pod that says goodbye gives its name up at once: the next request is a 404, not a wait for a pod that is not coming back', async () => {
    const cli = await startCli(['--names-zone', ZONE, '--names-allow', `${podId}=app`])
    child = cli.child
    port = cli.port
    try {
      const pod = await startPod({ mode: 'everything-closed', ingress: cli.podId })
      assert.equal((await request({ port, host: `app.${ZONE}` })).status, 200)
      await pod.client.close() // the goodbye, before the node
      const r = await request({ port, host: `app.${ZONE}` })
      assert.equal(r.status, 404)
      assert.equal(r.reason, 'no-mapping')
      assert.match(cli.out.text, /name release app\.pods\.example\.test/)
      assert.doesNotMatch(cli.out.text, /name hold/)
      await pod.stop()
    } finally { await stopCli(cli.child) }
  })

  for (const mode of ['shutdown-only', 'everything-closed']) {
    it(`a hand mapping with the CLI's default dialling, the pod stopped (${mode}) and started again against the same running ingress: the first request after each start is answered`, async () => {
      const cli = await startCli(['--map', `site.example.test=${podId}#web`])
      child = cli.child
      port = cli.port
      try {
        for (let cycle = 1; cycle <= 3; cycle++) {
          const t0 = Date.now()
          const pod = await startPod({ mode, claim: false, dial: true, ingress: cli.podId })
          const first = await request({ port, host: 'site.example.test', path: '/x' })
          assert.deepEqual([first.status, first.body?.toString()], [200, 'web answered /x'], `cycle ${cycle}, ${Date.now() - t0} ms after its start: ${first.reason ?? first.error ?? ''}\n${cli.out.text}`)
          await pod.stop()
        }
      } finally { await stopCli(cli.child) }
    })
  }

  it('a hand mapping with the CLI\'s default dialling and a pod that dials the ingress at the same time: the first request is answered, not failed for a minute', async () => {
    const cli = await startCli(['--map', `site.example.test=${podId}#web`])
    child = cli.child
    port = cli.port
    let starting
    try {
      await new Promise((r) => setTimeout(r, 1000)) // the ingress is already dialling the pod, which is not there yet
      starting = startPod({ claim: false, dial: true, ingress: cli.podId })
      const first = await request({ port, host: 'site.example.test', path: '/x' })
      assert.deepEqual([first.status, first.body.toString()], [200, 'web answered /x'], first.reason ?? '')
      const pod = await starting
      await pod.stop()
    } finally {
      // The pod may still be starting when an assertion above throws: let it finish, so `afterEach` finds it to stop.
      await starting?.catch(() => {})
      await stopCli(cli.child)
    }
  })
})
