// Real WebRTC, real signalling server, the command as a child process. The CLI is the provider (a grants file, the real address
// guard with the operator's one allowance for this machine's loopback, local TCP, HTTP and UDP destinations); a second mesh node
// (the same mesh-node module, as a consumer) reaches it through the local signalling hub. Nothing here connects to another host.
//
// Same optional `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as every other real-peer suite here.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
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
if (!ndc) describe('the egress command over real WebRTC peers', () => { it('skipped: optional dependency `node-datachannel` is not installed', () => {}) })
const describeIfReal = ndc ? describe : describe.skip

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '../../bin/browsermesh-egress.mjs')
const WEBRTC_TIMEOUT_MS = 30_000

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

describeIfReal('the egress command as a child process, through a real signalling server', () => {
  let startServer, startMeshNode, connectEgress
  let tmp, hub, consumer, link
  let child, cliPod, output
  const log = { tcp: [], http: [], udp: [] }
  const closers = []

  before(async () => {
    ;({ startServer } = await import('../../../../tests/browser/server.mjs'))
    ;({ startMeshNode } = await import('../../src/cli/mesh-node.mjs'))
    ;({ connectEgress } = await import('../../src/index.mjs'))
    tmp = await mkdtemp(path.join(tmpdir(), 'bm-egress-cli-real-'))
    hub = await startServer()
    const signaling = `ws://127.0.0.1:${hub.port}/signaling`
    consumer = await startMeshNode({ signaling, identityPath: path.join(tmp, 'consumer.json') })

    const tcp = net.createServer((s) => { s.on('error', () => {}); s.on('data', (d) => { log.tcp.push(String(d)); s.write(`echo:${d}`) }); s.on('end', () => s.end()) })
    const web = http.createServer((req, res) => { const parts = []; req.on('data', (d) => parts.push(d)); req.on('end', () => { log.http.push(`${req.method} ${req.url} ${Buffer.concat(parts)}`); res.writeHead(200, { 'set-cookie': 'sid=1' }); res.end(`web:${req.method}:${Buffer.concat(parts)}`) }) })
    const udp = dgram.createSocket('udp4')
    udp.on('message', (m, r) => { log.udp.push(String(m)); udp.send(`echo:${m}`, r.port, r.address) })
    await Promise.all([new Promise((r) => tcp.listen(0, '127.0.0.1', r)), new Promise((r) => web.listen(0, '127.0.0.1', r)), new Promise((r) => udp.bind(0, '127.0.0.1', r))])
    closers.push(() => new Promise((r) => tcp.close(r)), () => new Promise((r) => web.close(r)), () => new Promise((r) => udp.close(r)))
    const ports = { tcp: tcp.address().port, http: web.address().port, udp: udp.address().port }
    consumer.ports = ports

    await writeFile(path.join(tmp, 'grants.json'), JSON.stringify({
      grants: [{ peer: consumer.podId, scopes: [`egress:tcp:127.0.0.1:${ports.tcp}:connect`, `egress:http:127.0.0.1:${ports.http}:fetch`, `egress:udp:127.0.0.1:${ports.udp}:send`] }],
    }))
    child = spawn(process.execPath, [BIN, '--config', path.join(tmp, 'grants.json'), '--signaling', signaling, '--identity', path.join(tmp, 'egress.json'),
      '--allow-private', '127.0.0.1', '--fetch-methods', 'GET,POST', '--audit-urls', 'path'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: tmp, USERPROFILE: tmp, XDG_CONFIG_HOME: tmp } })
    output = ''
    child.stdout.on('data', (d) => { output += d })
    child.stderr.on('data', (d) => { output += d })
    await waitFor(() => /audit lines follow/.test(output), WEBRTC_TIMEOUT_MS, `the CLI to start (output so far: ${output})`)
    cliPod = /pod id: (\S+)/.exec(output)[1]
    await consumer.node.connectToPeer(cliPod, { webrtc: cliPod }, { answerTimeoutMs: WEBRTC_TIMEOUT_MS, openTimeoutMs: WEBRTC_TIMEOUT_MS })
    link = await connectEgress(consumer.service, cliPod)
  })

  after(async () => {
    try { await link?.close() } catch { /* gone */ }
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.once('close', r)) }
    try { await consumer?.close() } catch { /* gone */ }
    try { await hub?.close() } catch { /* gone */ }
    for (const close of closers) { try { await close() } catch { /* gone */ } }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
    if (tmp) await rm(tmp, { recursive: true, force: true })
  })

  it('prints its pod id and what it serves, keeps its identity file private, and a consumer holding a grant gets TCP, a fetch and UDP', async () => {
    assert.match(output, /browsermesh-egress pod id: \S+ \(new identity\)/)
    assert.match(output, /serving 1 grant .*; wide mode off; audit lines follow/)
    assert.equal((await stat(path.join(tmp, 'egress.json'))).mode & 0o077, 0)
    const { tcp, http: web, udp } = consumer.ports
    const socket = await link.connect('127.0.0.1', tcp)
    await socket.write(new TextEncoder().encode('tcp payload'))
    await socket.end()
    const parts = []
    for (;;) { const chunk = await socket.read(); if (chunk === null) break; parts.push(new TextDecoder().decode(chunk)) }
    assert.equal(parts.join(''), 'echo:tcp payload')
    const get = await link.fetch(`http://127.0.0.1:${web}/path?q=1`)
    assert.equal(await get.text(), 'web:GET:')
    assert.equal(get.headers.get('set-cookie'), null)
    const post = await link.fetch(`http://127.0.0.1:${web}/post`, { method: 'POST', body: 'posted' })
    assert.equal(await post.text(), 'web:POST:posted')
    const flow = await link.udp('127.0.0.1', udp)
    await flow.send(new TextEncoder().encode('udp payload'))
    assert.equal(new TextDecoder().decode(await flow.read()), 'echo:udp payload')
    await flow.close()
    assert.deepEqual(log.tcp, ['tcp payload'])
    assert.deepEqual(log.http, ['GET /path?q=1 ', 'POST /post posted'])
    assert.deepEqual(log.udp, ['udp payload'])
  })

  it('refuses what is not granted, by name, and says so in its audit lines; the lines carry no payload, and the path only because --audit-urls path was given', async () => {
    const refused = await link.connect('127.0.0.1', consumer.ports.tcp + 1).catch((e) => e)
    assert.equal(refused.code, 'no-grant')
    const metadata = await link.connect('169.254.169.254', 80).catch((e) => e)
    assert.equal(metadata.code, 'no-grant', 'no grant for it: refused before the guard is asked')
    await waitFor(() => /egress-refused .*code=no-grant/.test(output) && /egress-close .*form=udp/.test(output), 10_000, `the lines (output so far: ${output})`)
    assert.match(output, new RegExp(`egress-open .*dest=127\\.0\\.0\\.1:${consumer.ports.tcp} .*form=tcp .*addressClass=loopback`))
    assert.match(output, /egress-open .*form=fetch .*path=\/path/)
    assert.match(output, /egress-close .*form=udp .*datagramsUp=1 .*datagramsDown=1/)
    for (const secret of ['tcp payload', 'udp payload', 'posted', 'q=1']) assert.ok(!output.includes(secret), `the output has "${secret}"`)
  })

  it('stops on SIGTERM with exit status 0', async () => {
    const code = new Promise((resolve) => child.once('close', (c) => resolve(c)))
    child.kill('SIGTERM')
    assert.equal(await code, 0)
  })
})
