// Real WebRTC, the CLI as the ingress (a child process, default flags: every method, bodies streamed) and a pod in this process
// reached over a real data channel through a real signalling server: POST, PUT, PATCH and DELETE with bodies of several MiB,
// byte for byte; an extension method; a narrowed pod; and an upload that is cut by the pod going away, which ends cleanly.
//
// Same optional `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as every other real-peer suite here.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let ndc = null
let ndcMain = null
try {
  ndc = await import('node-datachannel/polyfill')
  ndcMain = await import('node-datachannel')
} catch { /* optional dependency absent: the suite below skips */ }

if (!ndc && process.env.REQUIRE_REAL_PEER) {
  throw new Error('REQUIRE_REAL_PEER is set but `node-datachannel` did not load, so the real-peer suite would have skipped and reported success. Install the dependency, or unset REQUIRE_REAL_PEER to allow the skip.')
}
if (!ndc) describe('any method over real WebRTC peers', () => { it('skipped: optional dependency `node-datachannel` is not installed', () => {}) })
const describeIfReal = ndc ? describe : describe.skip

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '../../bin/browsermesh-ingress.mjs')
const MiB = 1024 * 1024
const WEBRTC_TIMEOUT_MS = 30_000

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const pattern = (n) => { const b = Buffer.alloc(n); let s = 11; for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; b[i] = s >>> 24 } return b }

/** One request with a Host the caller chooses; the body is written in pieces (so it streams) with Content-Length. */
function send({ port, host = 'pod.test', path: p = '/', method = 'GET', body, headers = {}, pieceBytes = 64 * 1024, chunked = false }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host, ...(body && !chunked ? { 'content-length': body.byteLength } : {}), ...headers } }, (res) => {
      const parts = []
      res.on('data', (c) => parts.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    if (!body) return req.end()
    let at = 0
    const pump = () => {
      while (at < body.byteLength) {
        const piece = body.subarray(at, at + pieceBytes)
        at += piece.byteLength
        if (!req.write(piece)) return req.once('drain', pump)
      }
      req.end()
    }
    pump()
  })
}

describeIfReal('the CLI as an ingress, every method, a pod over a real data channel', () => {
  let startServer, startMeshNode, ingressPkg, apps
  let tmp, hub, signaling, provider, served
  let child, port, podId, output
  const seen = []

  const serve = () => {
    served = ingressPkg.serveHttpOnMesh(provider.service, async (request, { signal }) => {
      const pathname = new URL(request.url).pathname
      seen.push(`${request.method} ${pathname}`)
      if (pathname === '/echo') return new Response(request.body, { headers: { 'content-type': 'application/octet-stream' } })
      if (pathname === '/sha') {
        const hash = createHash('sha256')
        let n = 0
        for await (const chunk of request.body ?? []) { hash.update(chunk); n += chunk.byteLength }
        return new Response(JSON.stringify({ method: request.method, bytes: n, sha: hash.digest('hex') }), { headers: { 'content-type': 'application/json' } })
      }
      if (pathname === '/slow') {
        // reads its body until the request is cancelled
        try { for await (const chunk of request.body) void chunk } catch { return new Response('body failed', { status: 499 }) }
        return new Response('read it all')
      }
      return new Response(`${request.method} ${pathname}`)
    }, { allowFrom: [podId], limits: { maxResponseBytes: 16 * MiB } })
  }

  before(async () => {
    ;({ startServer } = await import('../../../../tests/browser/server.mjs'))
    ;({ startMeshNode } = await import('../../src/cli/mesh-node.mjs'))
    ingressPkg = await import('../../src/index.mjs')
    apps = await import('@johnhenry/browsermesh-apps')
    tmp = await mkdtemp(path.join(tmpdir(), 'bm-ingress-any-method-'))
    hub = await startServer()
    signaling = `ws://127.0.0.1:${hub.port}/signaling`
    provider = await startMeshNode({ signaling, identityPath: path.join(tmp, 'provider.json') })
    port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
    // default flags: no --allow-methods, no --max-body: every method, bodies up to 32 MiB
    child = spawn(process.execPath, [BIN, '--listen', `127.0.0.1:${port}`, '--signaling', signaling, '--map', `pod.test=${provider.podId}`, '--identity', path.join(tmp, 'ingress.json')],
      { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: tmp, USERPROFILE: tmp, XDG_CONFIG_HOME: tmp } })
    output = ''
    child.stdout.on('data', (d) => { output += d })
    child.stderr.on('data', (d) => { output += d })
    await waitFor(() => /listening on http/.test(output), WEBRTC_TIMEOUT_MS, `the CLI to start (output so far: ${output})`)
    podId = /pod id: (\S+)/.exec(output)[1]
    serve()
    provider.node.registry.grantCapabilities(podId, [apps.protocolScope('http')])
  })

  after(async () => {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.once('close', r)) }
    try { await served?.stop() } catch { /* gone */ }
    try { await provider?.close() } catch { /* gone */ }
    try { await hub?.close() } catch { /* gone */ }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  it('says it carries every method', () => {
    assert.match(output, /methods: every method/)
  })

  it('POST, PUT, PATCH and DELETE with bodies of several MiB arrive byte for byte', { timeout: 120_000 }, async () => {
    for (const [method, size] of [['POST', 5 * MiB + 17], ['PUT', 3 * MiB], ['PATCH', 1 * MiB + 1], ['DELETE', 200_000]]) {
      const body = pattern(size)
      const res = await send({ port, path: '/sha', method, body })
      assert.equal(res.status, 200, method)
      assert.deepEqual(JSON.parse(res.body.toString()), { method, bytes: size, sha: sha(body) }, method)
    }
  })

  it('echoes an upload back byte for byte (the response streams while the request does), Content-Length and chunked', { timeout: 120_000 }, async () => {
    const body = pattern(6 * MiB + 3)
    for (const chunked of [false, true]) {
      const res = await send({ port, path: '/echo', method: 'POST', body, chunked })
      assert.equal(res.status, 200)
      assert.equal(res.body.byteLength, body.byteLength)
      assert.equal(sha(res.body), sha(body))
    }
  })

  it('carries an extension method and OPTIONS to the pod', async () => {
    assert.equal((await send({ port, path: '/x', method: 'PURGE' })).body.toString(), 'PURGE /x')
    assert.equal((await send({ port, path: '/x', method: 'OPTIONS', headers: { 'access-control-request-method': 'PUT', origin: 'https://x.test' } })).body.toString(), 'OPTIONS /x')
  })

  it('refuses TRACE with a 405 and Allow', async () => {
    const res = await send({ port, path: '/x', method: 'TRACE' })
    assert.equal(res.status, 405)
    assert.match(res.headers.allow, /GET, HEAD, POST/)
  })

  it('a body over the default cap is a 413 before it is read', async () => {
    const res = await send({ port, path: '/sha', method: 'POST', body: Buffer.alloc(0), headers: { 'content-length': String(40 * MiB) } }).catch((e) => ({ status: 0, error: e.code }))
    assert.ok(res.status === 413 || res.status === 0, `status ${res.status}`)
    if (res.status === 413) assert.equal(res.headers['x-browsermesh-ingress-reason'], 'body-too-large')
  })

  it('an upload cut by the pod going away ends cleanly with an answer, and the next request is served after the pod is back', { timeout: 120_000 }, async () => {
    const before = seen.length
    // a slow upload: a few pieces now, the rest never comes until the pod has gone
    const req = http.request({ host: '127.0.0.1', port, path: '/slow', method: 'POST', headers: { host: 'pod.test', 'transfer-encoding': 'chunked' } })
    const outcome = new Promise((resolve) => {
      req.on('response', (res) => { const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); res.on('error', () => resolve({ status: 0 })) })
      req.on('error', (e) => resolve({ status: 0, error: e.code }))
    })
    req.write(pattern(256 * 1024))
    const early = await Promise.race([waitFor(() => seen.length > before, 15_000, 'the pod to be handed the request').then(() => null), outcome])
    assert.equal(early, null, `the request was answered before the pod had it: ${JSON.stringify(early)} ${output.slice(-400)}`)
    // the pod goes away mid-upload (its identity is kept, as a restarted pod's would be)
    await served.stop()
    await provider.close()
    const result = await outcome
    req.destroy()
    // an honest answer (the channel closed under it) or a closed connection; never a hang, never a 200
    assert.ok(result.status === 0 || (result.status >= 500 && result.status < 600), `status ${result.status}`)
    if (result.status) assert.match(result.headers['x-browsermesh-ingress-reason'] ?? '', /provider-/)
    provider = await startMeshNode({ signaling, identityPath: path.join(tmp, 'provider.json') })
    serve()
    provider.node.registry.grantCapabilities(podId, [apps.protocolScope('http')])
    // (the restarted pod dials the ingress, as a pod that only serves does; the ingress is dialling it too)
    await provider.node.connectToPeer(podId, { webrtc: podId }, { answerTimeoutMs: WEBRTC_TIMEOUT_MS, openTimeoutMs: WEBRTC_TIMEOUT_MS }).catch(() => {})
    await waitFor(async () => { try { return (await send({ port, path: '/after' })).status === 200 } catch { return false } }, 40_000, 'the restarted pod to be served')
    const body = pattern(2 * MiB)
    const res = await send({ port, path: '/sha', method: 'PUT', body })
    assert.deepEqual(JSON.parse(res.body.toString()), { method: 'PUT', bytes: body.byteLength, sha: sha(body) })
  })
})
