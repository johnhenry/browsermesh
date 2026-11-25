// The whole path in process: a consumer pod, a provider pod, a simulated network behind the provider's seam, a local origin.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { VirtualNetwork } from '@johnhenry/browsermesh-netway'
import { connectEgress, createMeshEgress, EgressError, EGRESS_SCOPES } from '../src/index.mjs'
import { threePods, grant, revoke, simNetwork, echoOrigin, startOrigin, readAll, text, bytes, until, outcome, patternChunk, patternByte } from './helpers/mesh.mjs'

const PUBLIC = '93.184.216.34'

describe('a granted connection and lookup, end to end', () => {
  const cleanups = []
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

  async function setup({ names, sets, grants = [EGRESS_SCOPES.tcp('pkg.test', 443)], egress = {}, link = {} } = {}) {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const net = simNetwork({ names: names ?? { 'pkg.test': [PUBLIC] }, origins: { [`${PUBLIC}:443`]: origin.port } })
    const audit = []
    const meter = []
    const provider = createMeshEgress({ service: pods.p, registry: pods.provider.registry, dial: net.dial, resolve: net.resolve, sets, unattended: true, onAudit: (r) => audit.push(r), onMeter: (r) => meter.push(r), ...egress })
    provider.start()
    cleanups.push(() => provider.stop())
    grant(pods, grants)
    const conn = await connectEgress(pods.c, pods.provider.podId, link)
    cleanups.push(() => conn.close())
    return { pods, origin, net, provider, link: conn, audit, meter }
  }

  it('connects, moves bytes both ways, and half-closes', async () => {
    const { link, audit, meter, provider } = await setup()
    const socket = await link.connect('pkg.test', 443)
    await socket.write(bytes('hello '))
    await socket.write(bytes('mesh'))
    await socket.end()
    assert.equal(text(await readAll(socket)), 'hello mesh')
    await until(() => provider.stats().closed === 1, 'the connection to end')
    assert.deepEqual(audit.map((r) => r.event), ['egress-open', 'egress-close'])
    assert.equal(audit[1].reason, 'closed')
    assert.equal(audit[1].bytesUp, 10)
    assert.equal(audit[1].bytesDown, 10)
    assert.equal(audit[1].addressClass, 'public')
    assert.equal(audit[1].host, 'pkg.test')
    assert.equal(audit[1].port, 443)
    assert.equal(audit[1].address, PUBLIC)
    assert.equal(meter.at(-1).final, true)
    assert.equal(meter.at(-1).connections, 1)
    assert.equal(meter.at(-1).bytesUp + meter.at(-1).bytesDown, 20)
    assert.ok(!('host' in meter.at(-1)), 'the meter carries no destination')
  })

  it('looks a name up, and tells a name that does not exist from a failure', async () => {
    const { link } = await setup({ grants: [EGRESS_SCOPES.dns('pkg.test'), EGRESS_SCOPES.dns('gone.test')] })
    assert.deepEqual(await link.lookup('pkg.test'), [PUBLIC])
    await assert.rejects(link.lookup('gone.test'), (e) => e instanceof EgressError && e.code === 'name-not-found' && e.posix === 'ENOTFOUND')
  })

  it('serves a netway VirtualNetwork through its backend', async () => {
    const { link } = await setup({ grants: [EGRESS_SCOPES.tcp('pkg.test', 443), EGRESS_SCOPES.dns('pkg.test')] })
    const net = new VirtualNetwork()
    net.addBackend('tcp', link.asBackend())
    const socket = await net.connect('tcp://pkg.test:443')
    await socket.write(bytes('via netway'))
    await socket.end()
    assert.equal(text(await readAll(socket)), 'via netway')
    // (a VirtualNetwork asks its own loopback backend first; the egress backend answers for itself)
    assert.deepEqual(await link.asBackend().resolve('pkg.test'), [PUBLIC])
  })

  it('a grant for a set covers what the set lists, and no other set', async () => {
    const { link } = await setup({ sets: { pkgs: ['*.pkg.test:443'], other: ['pkg.test:443'] }, grants: [EGRESS_SCOPES.set('other')] })
    const socket = await link.connect('pkg.test', 443)
    await socket.end()
    await readAll(socket)
    await assert.rejects(link.connect('www.pkg.test', 443), (e) => e.code === 'no-grant')
  })

  it('moves a megabyte each way with every byte checked', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const total = 1024 * 1024
    const received = { n: 0, ok: true }
    const origin = await startOrigin((socket) => {
      let seen = 0
      socket.on('data', (d) => { for (let i = 0; i < d.length; i++) if (d[i] !== patternByte(seen + i)) received.ok = false; seen += d.length; received.n = seen })
      socket.on('end', () => { for (let at = 0; at < total; at += 16384) socket.write(patternChunk(at, Math.min(16384, total - at))); socket.end() })
    })
    cleanups.push(() => origin.close())
    const net = simNetwork({ names: { 'pkg.test': [PUBLIC] }, origins: { [`${PUBLIC}:443`]: origin.port } })
    const provider = createMeshEgress({ service: pods.p, registry: pods.provider.registry, dial: net.dial, resolve: net.resolve, unattended: true })
    provider.start()
    cleanups.push(() => provider.stop())
    grant(pods, [EGRESS_SCOPES.tcp('pkg.test', 443)])
    const link = await connectEgress(pods.c, pods.provider.podId)
    cleanups.push(() => link.close())
    const socket = await link.connect('pkg.test', 443)
    for (let at = 0; at < total; at += 20000) await socket.write(patternChunk(at, Math.min(20000, total - at)))
    await socket.end()
    let got = 0
    for (;;) {
      const chunk = await socket.read()
      if (chunk === null) break
      for (let i = 0; i < chunk.length; i++) assert.equal(chunk[i], patternByte(got + i), `byte ${got + i}`)
      got += chunk.length
    }
    assert.equal(got, total)
    assert.equal(received.n, total)
    assert.ok(received.ok)
  })

  it('revoking the grant ends the live connection at once', async () => {
    const { link, pods, provider } = await setup()
    const socket = await link.connect('pkg.test', 443)
    await socket.write(bytes('x'))
    assert.equal(text(await socket.read()), 'x')
    revoke(pods, [EGRESS_SCOPES.tcp('pkg.test', 443)])
    const e = await outcome(socket)
    assert.ok(e instanceof EgressError && e.code === 'connection-ended' && e.reason === 'revoked', String(e))
    assert.equal(provider.stats().ends.revoked, 1)
  })
})
