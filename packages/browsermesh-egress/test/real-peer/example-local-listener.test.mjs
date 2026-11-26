// Real WebRTC, real signalling server, both ends as child processes: the egress command is the provider (reading a grants file made
// from the example's own), examples/local-listener.mjs is the consumer in its real mode, and a local client talks to the port it
// opens. Nothing here connects to another host.
//
// Same optional `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as every other real-peer suite here.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
if (!ndc) describe('the local-listener example over real WebRTC peers', () => { it('skipped: optional dependency `node-datachannel` is not installed', () => {}) })
const describeIfReal = ndc ? describe : describe.skip

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '../../bin/browsermesh-egress.mjs')
const EXAMPLE = path.resolve(HERE, '../../examples/local-listener.mjs')
const GRANTS = path.resolve(HERE, '../../examples/local-listener.grants.json')
const WEBRTC_TIMEOUT_MS = 30_000

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

describeIfReal('examples/local-listener.mjs against the egress command, over real WebRTC', () => {
  let startServer, tmp, hub, origin, env
  const children = []
  const outputs = new Map()

  const run = (args, { name }) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env })
    outputs.set(name, '')
    child.stdout.on('data', (d) => { outputs.set(name, outputs.get(name) + d) })
    child.stderr.on('data', (d) => { outputs.set(name, outputs.get(name) + d) })
    children.push(child)
    return child
  }
  const exited = (child) => new Promise((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once('close', (code) => resolve(code))))

  before(async () => {
    ;({ startServer } = await import('../../../../tests/browser/server.mjs'))
    tmp = await mkdtemp(path.join(tmpdir(), 'bm-egress-example-real-'))
    env = { PATH: process.env.PATH, HOME: tmp, USERPROFILE: tmp, XDG_CONFIG_HOME: tmp }
    hub = await startServer()
    origin = net.createServer({ allowHalfOpen: true }, (s) => { s.on('error', () => {}); s.on('data', (d) => s.write(`echo:${d}`)); s.on('end', () => s.end()) })
    await new Promise((r) => origin.listen(0, '127.0.0.1', r))
  })

  after(async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.all(children.map(exited))
    try { await hub?.close() } catch { /* gone */ }
    try { await new Promise((r) => origin.close(r)) } catch { /* gone */ }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  it('--print-pod-id keeps an identity and prints the same pod id each time; the provider is started with the example\'s grants file; a local client is answered through both', async () => {
    const signaling = `ws://127.0.0.1:${hub.port}/signaling`
    const identity = path.join(tmp, 'consumer.json')
    const idOf = async (name) => {
      const child = run([EXAMPLE, '--print-pod-id', '--identity', identity, '--signaling', signaling], { name })
      assert.equal(await exited(child), 0, outputs.get(name))
      return outputs.get(name).split('\n').map((l) => l.trim()).filter((l) => /^[A-Za-z0-9_-]{43}$/.test(l))[0]
    }
    const podId = await idOf('print-1')
    assert.ok(podId, outputs.get('print-1'))
    assert.equal(await idOf('print-2'), podId)

    // the example's own file, with the pod id put in and the destination changed to the local origin
    const grants = JSON.parse(await readFile(GRANTS, 'utf8'))
    grants.grants[0].peer = podId
    grants.grants[0].scopes = [`egress:tcp:127.0.0.1:${origin.address().port}:connect`]
    await writeFile(path.join(tmp, 'grants.json'), JSON.stringify(grants))
    const provider = run([BIN, '--config', path.join(tmp, 'grants.json'), '--signaling', signaling, '--identity', path.join(tmp, 'egress.json'), '--allow-private', '127.0.0.1'], { name: 'provider' })
    await waitFor(() => /audit lines follow/.test(outputs.get('provider')), WEBRTC_TIMEOUT_MS, `the provider to start (${outputs.get('provider')})`)
    const providerPod = /pod id: (\S+)/.exec(outputs.get('provider'))[1]

    const consumer = run([EXAMPLE, '--provider', providerPod, '--signaling', signaling, '--identity', identity, '--target', `127.0.0.1:${origin.address().port}`, '--listen', '127.0.0.1:0'], { name: 'consumer' })
    await waitFor(() => /listening on 127\.0\.0\.1:\d+/.test(outputs.get('consumer')), WEBRTC_TIMEOUT_MS, `the consumer to listen (${outputs.get('consumer')})`)
    assert.match(outputs.get('consumer'), new RegExp(`this pod id .*: ${podId}`))
    const port = Number(/listening on 127\.0\.0\.1:(\d+)/.exec(outputs.get('consumer'))[1])

    const answer = await new Promise((resolve, reject) => {
      const parts = []
      const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true }, () => socket.end('through two processes'))
      socket.on('data', (d) => parts.push(d))
      socket.on('end', () => resolve(Buffer.concat(parts).toString()))
      socket.on('error', reject)
    })
    assert.equal(answer, 'echo:through two processes')
    await waitFor(() => /egress-open .*dest=127\.0\.0\.1:\d+ .*form=tcp/.test(outputs.get('provider')), 10_000, `the provider to audit the connection (${outputs.get('provider')})`)

    consumer.kill('SIGTERM')
    assert.equal(await exited(consumer), 0)
    provider.kill('SIGTERM')
    assert.equal(await exited(provider), 0)
  })
})
