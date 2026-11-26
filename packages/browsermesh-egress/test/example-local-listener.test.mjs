// The example in examples/local-listener.mjs: a local TCP listener whose connections go through `connectEgress` to a granted
// destination. The function the example is built on is tested here against a real provider on the in-process bus; the grants file
// is checked with the command line's own argument rules; and the example is run as a child process, as `npm run examples` runs it.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectEgress, createMeshEgress, EGRESS_SCOPES } from '../src/index.mjs'
import { fromConfig, resolveOptions, UsageError } from '../src/cli/args.mjs'
import { listenThroughEgress } from '../examples/local-listener.mjs'
import { threePods, grant, revoke, echoOrigin, startOrigin, simNetwork, until } from './helpers/mesh.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXAMPLE = path.resolve(HERE, '../examples/local-listener.mjs')
const GRANTS = path.resolve(HERE, '../examples/local-listener.grants.json')
const PUBLIC = '93.184.216.34'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

async function rig({ origin, scopes } = {}) {
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  const tcp = origin ?? await echoOrigin()
  cleanups.push(() => tcp.close())
  const network = simNetwork({ names: { 'db.test': [PUBLIC] }, origins: { [`${PUBLIC}:5432`]: tcp.port, [`${PUBLIC}:5433`]: tcp.port } })
  const provider = createMeshEgress({ service: pods.p, registry: pods.provider.registry, dial: network.dial, resolve: network.resolve, unattended: true })
  provider.start()
  cleanups.push(() => provider.stop())
  grant(pods, scopes ?? [EGRESS_SCOPES.tcp('db.test', 5432)])
  const link = await connectEgress(pods.c, pods.provider.podId)
  cleanups.push(() => link.close())
  return { ...pods, link, egress: provider, origin: tcp }
}

/** A local client: connects, sends `data`, half-closes, and returns everything it was sent back. */
function client(port, data) {
  return new Promise((resolve, reject) => {
    const parts = []
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true }, () => { socket.end(data) })
    socket.on('data', (d) => parts.push(d))
    socket.on('end', () => resolve(Buffer.concat(parts)))
    socket.on('error', reject)
  })
}

describe('listenThroughEgress', () => {
  it('a local connection reaches the granted destination and gets its answer, half-close included', async () => {
    const t = await rig()
    const errors = []
    const listener = await listenThroughEgress(t.link, { target: { host: 'db.test', port: 5432 }, onError: (e) => errors.push(e) })
    cleanups.push(() => listener.close())
    assert.equal((await client(listener.port, 'hello through a peer')).toString(), 'hello through a peer')
    assert.deepEqual(errors, [])
  })

  it('binds to loopback by default, and only there', async () => {
    const t = await rig()
    const listener = await listenThroughEgress(t.link, { target: { host: 'db.test', port: 5432 } })
    cleanups.push(() => listener.close())
    assert.equal(listener.host, '127.0.0.1')
    await assert.rejects(listenThroughEgress(t.link, { target: { host: 'db.test', port: 5432 }, host: '0.0.0.0' }), /loopback/)
    await assert.rejects(listenThroughEgress(t.link, { target: { host: 'db.test', port: 5432 }, host: '192.0.2.1' }), /loopback/)
  })

  it('several connections at once each get their own bytes back', async () => {
    const t = await rig()
    const listener = await listenThroughEgress(t.link, { target: { host: 'db.test', port: 5432 } })
    cleanups.push(() => listener.close())
    const answers = await Promise.all(Array.from({ length: 6 }, (_, i) => client(listener.port, `client ${i} `.repeat(50))))
    answers.forEach((a, i) => assert.equal(a.toString(), `client ${i} `.repeat(50)))
  })

  it('a megabyte each way arrives intact (the listener waits for the link instead of buffering)', async () => {
    const t = await rig()
    const listener = await listenThroughEgress(t.link, { target: { host: 'db.test', port: 5432 } })
    cleanups.push(() => listener.close())
    const payload = Buffer.from(Array.from({ length: 1 << 20 }, (_, i) => (i * 31) & 255))
    const echoed = await client(listener.port, payload)
    assert.equal(echoed.length, payload.length)
    assert.ok(echoed.equals(payload))
  })

  it('a destination the pod holds no grant for closes the local connection, reports why, and the listener keeps serving', async () => {
    const t = await rig()
    const errors = []
    const denied = await listenThroughEgress(t.link, { target: { host: 'db.test', port: 5433 }, onError: (e) => errors.push(e) })
    cleanups.push(() => denied.close())
    assert.equal((await client(denied.port, 'x')).length, 0)
    await until(() => errors.length === 1, 'the refusal to be reported')
    assert.equal(errors[0].code, 'no-grant')
    assert.equal((await client(denied.port, 'y')).length, 0)
    await until(() => errors.length === 2, 'the second refusal')
    grant(t, [EGRESS_SCOPES.tcp('db.test', 5433)])
    assert.equal((await client(denied.port, 'now granted')).toString(), 'now granted')
  })

  it('a local client that vanishes ends the connection to the destination', async () => {
    const t = await rig()
    const listener = await listenThroughEgress(t.link, { target: { host: 'db.test', port: 5432 } })
    cleanups.push(() => listener.close())
    await new Promise((resolve) => { const s = net.connect({ port: listener.port, host: '127.0.0.1' }, () => { s.write('hi'); s.once('data', () => { s.destroy(); resolve() }) }) })
    await until(() => t.origin.sockets.size === 0, 'the destination to see the end')
    await until(() => listener.stats().open === 0, 'the listener to forget the connection')
  })

  it('the destination ending ends the local connection', async () => {
    const origin = await startOrigin((socket) => { socket.on('data', () => socket.end('bye')) })
    const t = await rig({ origin })
    const listener = await listenThroughEgress(t.link, { target: { host: 'db.test', port: 5432 } })
    cleanups.push(() => listener.close())
    assert.equal((await client(listener.port, 'x')).toString(), 'bye')
  })

  it('revoking the grant ends a live connection', async () => {
    const t = await rig()
    const listener = await listenThroughEgress(t.link, { target: { host: 'db.test', port: 5432 } })
    cleanups.push(() => listener.close())
    const socket = net.connect({ port: listener.port, host: '127.0.0.1' })
    await new Promise((resolve) => { socket.write('ping'); socket.once('data', resolve) })
    revoke(t, [EGRESS_SCOPES.tcp('db.test', 5432)])
    await new Promise((resolve) => { socket.on('close', resolve); socket.on('error', () => {}) })
    assert.equal(socket.destroyed, true)
  })

  it('the link ending ends every local connection and tells the owner', async () => {
    const t = await rig()
    const closed = []
    const listener = await listenThroughEgress(t.link, { target: { host: 'db.test', port: 5432 }, onLinkClosed: (info) => closed.push(info.reason) })
    cleanups.push(() => listener.close())
    const socket = net.connect({ port: listener.port, host: '127.0.0.1' })
    socket.on('error', () => {})
    await new Promise((resolve) => { socket.write('ping'); socket.once('data', resolve) })
    await t.link.close()
    await new Promise((resolve) => socket.on('close', resolve))
    await until(() => closed.length === 1, 'the owner to be told')
    assert.deepEqual(closed, ['local-close'])
  })

  it('at most maxConnections at once: another is closed at once and reported, not queued', async () => {
    const t = await rig()
    const errors = []
    const listener = await listenThroughEgress(t.link, { target: { host: 'db.test', port: 5432 }, maxConnections: 2, onError: (e) => errors.push(e) })
    cleanups.push(() => listener.close())
    const open = []
    for (let i = 0; i < 2; i++) {
      const s = net.connect({ port: listener.port, host: '127.0.0.1' })
      s.on('error', () => {})
      await new Promise((resolve) => { s.write('x'); s.once('data', resolve) })
      open.push(s)
    }
    const third = net.connect({ port: listener.port, host: '127.0.0.1' })
    third.on('error', () => {})
    await new Promise((resolve) => third.on('close', resolve))
    assert.equal(errors.at(-1)?.code, 'too-many-connections')
    for (const s of open) s.destroy()
    await until(() => listener.stats().open === 0, 'the listener to settle')
    assert.equal((await client(listener.port, 'again')).toString(), 'again')
  })

  it('close() ends the listener and every connection it holds', async () => {
    const t = await rig()
    const listener = await listenThroughEgress(t.link, { target: { host: 'db.test', port: 5432 } })
    const socket = net.connect({ port: listener.port, host: '127.0.0.1' })
    socket.on('error', () => {})
    await new Promise((resolve) => { socket.write('ping'); socket.once('data', resolve) })
    await listener.close()
    await new Promise((resolve) => socket.on('close', resolve))
    await assert.rejects(client(listener.port, 'x'))
  })

  it('refuses a target that is not a host and a port', async () => {
    const t = await rig()
    for (const target of [undefined, {}, { host: 'db.test' }, { host: 'db.test', port: 0 }, { host: 'db.test', port: 70000 }, { host: '', port: 5432 }, { host: 5, port: 5432 }]) {
      await assert.rejects(listenThroughEgress(t.link, { target }), TypeError, JSON.stringify(target))
    }
  })
})

describe('the grants file', () => {
  it('is a grants file the command line accepts, once the consumer\'s pod id is put in', async () => {
    const text = await readFile(GRANTS, 'utf8')
    const json = JSON.parse(text)
    assert.equal(json.grants.length, 1)
    assert.match(json.grants[0].peer, /pod id/)
    assert.throws(() => resolveOptions({ ...fromConfig(json), 'dry-run': true }), (e) => e instanceof UsageError && /pod id/.test(e.message), 'the placeholder is not a pod id')
    json.grants[0].peer = 'Q'.repeat(43)
    const options = resolveOptions({ ...fromConfig(json), 'dry-run': true })
    assert.deepEqual(options.grants.map((g) => g.scopes), [['egress:tcp:db.internal.example:5432:connect']])
  })
})

describe('the example, run as `npm run examples` runs it', () => {
  it('exits 0 and shows what it did', async () => {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [EXAMPLE], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += d })
      child.stderr.on('data', (d) => { stderr += d })
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('the example did not finish')) }, 60_000)
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
    })
    assert.equal(out.code, 0, out.stderr)
    assert.match(out.stdout, /listening on 127\.0\.0\.1:\d+ -> db\.internal\.example:5432/)
    assert.match(out.stdout, /echoed through the provider: hello from a local client/)
    assert.match(out.stdout, /a destination with no grant: the local connection was closed \(no-grant\)/)
    assert.match(out.stdout, /done/)
  })
})
