// `nodeDialer`: the provider's dial and resolve on wsh's address guard, with the real guard and real local sockets. Nothing here
// connects to a public address: names are answered by a resolver double, and the only addresses dialled are on this machine.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { nodeDialer, createMeshEgress, DEFAULT_BLOCKED_PORTS } from '../src/node.mjs'
import { connectEgress, EgressError, EGRESS_SCOPES } from '../src/index.mjs'
import { threePods, grant, startOrigin, echoOrigin, readAll, text, bytes, until, deferred } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
const answers = (table) => async (name, { family }) => { (answers.log ??= []).push([name, family]); if (!table[name]) { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e } return table[name] }
const refusedWith = (cls) => (e) => e.name === 'AddressGuardError' && e.code === 'ADDRESS_REFUSED' && e.refused?.[0]?.class === cls

describe('nodeDialer', () => {
  it('returns the options createMeshEgress takes: the TCP dial, the UDP dial, the lookup and the fetch form\'s HTTP client', () => {
    const d = nodeDialer()
    for (const name of ['dial', 'dialUdp', 'resolve', 'exchange']) assert.equal(typeof d[name], 'function', name)
    assert.deepEqual(Object.keys(d).sort(), ['dial', 'dialUdp', 'exchange', 'resolve'])
  })

  it('refuses private, loopback, link-local and metadata addresses by literal and by name, before any connection', async () => {
    const d = nodeDialer({ lookup: answers({ 'lan.test': ['10.0.0.5'], 'home.test': ['127.0.0.1'], 'meta.test': ['169.254.169.254'], 'cg.test': ['100.64.1.1'], 'ula.test': ['fd00::1'] }) })
    for (const [host, cls] of [['10.0.0.5', 'private'], ['127.0.0.1', 'loopback'], ['169.254.169.254', 'metadata'], ['100.64.1.1', 'carrier-nat'], ['lan.test', 'private'], ['home.test', 'loopback'], ['meta.test', 'metadata'], ['cg.test', 'carrier-nat'], ['ula.test', 'unique-local']]) {
      await assert.rejects(d.dial({ host, port: 9, timeoutMs: 1000 }), refusedWith(cls), host)
      if (!/^\d/.test(host) && cls !== 'unique-local') await assert.rejects(d.resolve({ name: host, timeoutMs: 1000 }), refusedWith(cls), host)
    }
  })

  it('a name that answers with both a public and a private address is refused whole by default (refuseMixed), for dial and for resolve', async () => {
    const lookup = answers({ 'mixed.test': ['93.184.216.34', '10.0.0.5'] })
    await assert.rejects(nodeDialer({ lookup }).dial({ host: 'mixed.test', port: 9, timeoutMs: 1000 }), refusedWith('private'))
    await assert.rejects(nodeDialer({ lookup }).resolve({ name: 'mixed.test', timeoutMs: 1000 }), refusedWith('private'))
    // the other choice, available to an operator who wants wsh's own default: the refused answers are dropped
    const dropped = await nodeDialer({ lookup, refuseMixed: false }).resolve({ name: 'mixed.test', timeoutMs: 1000 })
    assert.deepEqual(dropped.map((a) => a.address), ['93.184.216.34'])
  })

  it('resolves A records only, once', async () => {
    answers.log = []
    const lookup = answers({ 'pkg.test': ['93.184.216.34'] })
    const out = await nodeDialer({ lookup }).resolve({ name: 'pkg.test', timeoutMs: 1000 })
    assert.deepEqual(out, [{ address: '93.184.216.34', family: 4, class: 'public' }])
    assert.deepEqual(answers.log, [['pkg.test', 4]])
    await assert.rejects(nodeDialer({ lookup }).resolve({ name: 'gone.test', timeoutMs: 1000 }), (e) => e.code === 'NAME_NOT_FOUND')
  })

  it('only the operator\'s allowPrivate admits private space, and it connects to the address that was checked, half-open', async () => {
    const received = deferred()
    const origin = await startOrigin((s) => { s.end('hello'); const parts = []; s.on('data', (d) => parts.push(d)); s.on('end', () => received.resolve(Buffer.concat(parts).toString())) })
    cleanups.push(() => origin.close())
    const lookup = answers({ 'local.test': ['127.0.0.1'] })
    await assert.rejects(nodeDialer({ lookup }).dial({ host: 'local.test', port: origin.port, timeoutMs: 1000 }), refusedWith('loopback'))
    const d = nodeDialer({ lookup, allowPrivate: ['127.0.0.1/32'] })
    const r = await d.dial({ host: 'local.test', port: origin.port, timeoutMs: 1000 })
    assert.equal(r.address, '127.0.0.1')
    assert.equal(r.class, 'loopback')
    const got = []
    r.socket.on('data', (c) => got.push(c))
    await new Promise((resolve) => r.socket.once('end', resolve))
    assert.equal(Buffer.concat(got).toString(), 'hello')
    r.socket.write('after the destination finished')
    r.socket.end()
    assert.equal(await received.promise, 'after the destination finished')
  })

  it('a destination admitted by a wildcard grant (wide) ignores allowPrivate', async () => {
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const d = nodeDialer({ lookup: answers({ 'local.test': ['127.0.0.1'] }), allowPrivate: ['127.0.0.0/8', '10.0.0.0/8'] })
    await assert.rejects(d.dial({ host: 'local.test', port: origin.port, wide: true, timeoutMs: 1000 }), refusedWith('loopback'))
    await assert.rejects(d.dial({ host: '10.1.1.1', port: 80, wide: true, timeoutMs: 1000 }), refusedWith('private'))
    await assert.rejects(d.resolve({ name: 'local.test', wide: true, timeoutMs: 1000 }), refusedWith('loopback'))
    const ok = await d.dial({ host: 'local.test', port: origin.port, wide: false, timeoutMs: 1000 })
    ok.socket.destroy()
  })

  it('deny wins over allowPrivate, and over a public address', async () => {
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const d = nodeDialer({ lookup: answers({ 'local.test': ['127.0.0.1'], 'pkg.test': ['93.184.216.34'] }), allowPrivate: ['127.0.0.0/8'], deny: ['127.0.0.1/32', '93.184.216.0/24'] })
    await assert.rejects(d.dial({ host: 'local.test', port: origin.port, timeoutMs: 1000 }), (e) => e.code === 'ADDRESS_REFUSED')
    await assert.rejects(d.dial({ host: 'pkg.test', port: 443, timeoutMs: 1000 }), (e) => e.code === 'ADDRESS_REFUSED')
  })

  it('refuses an allowPrivate or deny that is not a list of CIDR blocks and addresses, at construction', () => {
    for (const bad of [{ allowPrivate: true }, { allowPrivate: '10.0.0.0/8' }, { allowPrivate: ['not-a-cidr'] }, { allowPrivate: [5] }, { deny: ['10.0.0.0/99'] }, { deny: 'x' }]) assert.throws(() => nodeDialer(bad), TypeError, JSON.stringify(bad))
  })

  it('a destination that is refused by the network (nothing listens) says so', async () => {
    const origin = await echoOrigin()
    const port = origin.port
    await origin.close()
    const d = nodeDialer({ lookup: answers({ 'local.test': ['127.0.0.1'] }), allowPrivate: ['127.0.0.1/32'] })
    await assert.rejects(d.dial({ host: 'local.test', port, timeoutMs: 1000 }), (e) => e.code === 'CONNECTION_REFUSED')
  })
})

describe('the real guard behind the provider, over the mesh', () => {
  async function build({ dialer, grants, egress = {} }) {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const audit = []
    const provider = createMeshEgress({ service: pods.p, registry: pods.provider.registry, ...dialer, unattended: true, onAudit: (r) => audit.push(r), ...egress })
    provider.start()
    cleanups.push(() => provider.stop())
    grant(pods, grants)
    const link = await connectEgress(pods.c, pods.provider.podId)
    cleanups.push(() => link.close())
    return { pods, provider, link, audit }
  }
  const code = (c) => (e) => e instanceof EgressError && e.code === c

  it('a named destination in private space is reachable only because the operator listed it, and a grant alone is refused', async () => {
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const lookup = answers({ 'db.internal.test': ['127.0.0.1'] })
    const closed = await build({ dialer: nodeDialer({ lookup }), grants: [EGRESS_SCOPES.tcp('db.internal.test', origin.port)] })
    const refused = await closed.link.connect('db.internal.test', origin.port).catch((e) => e)
    assert.ok(refused.code === 'destination-refused' && refused.addressClass === 'loopback')
    const open = await build({ dialer: nodeDialer({ lookup, allowPrivate: ['127.0.0.1/32'] }), grants: [EGRESS_SCOPES.tcp('db.internal.test', origin.port)] })
    const socket = await open.link.connect('db.internal.test', origin.port)
    await socket.write(bytes('select 1'))
    assert.equal(text(await socket.read()), 'select 1')
    await socket.end()
    await readAll(socket)
    await until(() => open.provider.stats().closed === 1)
    assert.equal(open.audit.find((r) => r.event === 'egress-close').addressClass, 'loopback')
  })

  it('wide mode on the real guard: every private class stays refused, with the operator\'s allowPrivate in place', async () => {
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const lookup = answers({ 'home.test': ['127.0.0.1'] })
    const { link } = await build({ dialer: nodeDialer({ lookup, allowPrivate: ['127.0.0.0/8', '10.0.0.0/8'] }), grants: ['egress:tcp:*:*:connect', 'egress:dns:*:resolve'], egress: { wide: { acknowledge: 'any-public-address' } } })
    for (const host of ['home.test', '127.0.0.1', '10.2.3.4', '169.254.169.254']) {
      const e = await link.connect(host, origin.port).catch((x) => x)
      assert.ok(e.code === 'destination-refused' && ['loopback', 'private', 'metadata'].includes(e.addressClass), `${host}: ${e.code}`)
    }
    await assert.rejects(link.lookup('home.test'), code('destination-refused'))
  })

  it('the blocked-ports default is the mail ports', () => {
    assert.deepEqual([...DEFAULT_BLOCKED_PORTS], [25, 465, 587])
  })
})
