// The provider: construction, grants, wide mode, blocked ports, the address policy at the seam, audit, meter, budgets.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createMeshEgress, connectEgress, EGRESS_SCOPES, EgressError, DEFAULT_BLOCKED_PORTS, WIDE_ACKNOWLEDGEMENT } from '../src/index.mjs'
import { threePods, grant, revoke, rig, simNetwork, echoOrigin, startOrigin, bytes, text, readAll, until, outcome, deferred, PUBLIC } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
const noop = async () => { throw new Error('unused') }
const base = (pods, extra = {}) => ({ service: pods.p, registry: pods.provider.registry, dial: noop, resolve: noop, unattended: true, ...extra })
const code = (c) => (e) => e instanceof EgressError && e.code === c

describe('construction and start', () => {
  it('needs a service, a registry, a dial and a resolve; nothing is served until start()', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    assert.throws(() => createMeshEgress({}), /service/)
    assert.throws(() => createMeshEgress({ service: pods.p }), /registry/)
    assert.throws(() => createMeshEgress({ service: pods.p, registry: pods.provider.registry }), /dial is required/)
    assert.throws(() => createMeshEgress({ service: pods.p, registry: pods.provider.registry, dial: noop }), /resolve is required/)
    const egress = createMeshEgress(base(pods))
    assert.equal(egress.started, false)
    grant(pods)
    await assert.rejects(connectEgress(pods.c, pods.provider.podId), code('provider-no-egress'))
    egress.start()
    cleanups.push(() => egress.stop())
    const link = await connectEgress(pods.c, pods.provider.podId)
    assert.equal(link.peer, pods.provider.podId)
    await link.close()
  })

  it('start() refuses without an indicator or unattended: true, and the indicator sees each connection', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    assert.throws(() => createMeshEgress(base(pods, { unattended: undefined })).start(), /indicator.*unattended/)
    assert.throws(() => createMeshEgress(base(pods, { indicator: {} })), /indicator needs/)
    const events = []
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const net = simNetwork({ names: { 'pkg.test': [PUBLIC] }, origins: { [`${PUBLIC}:443`]: origin.port } })
    const egress = createMeshEgress(base(pods, { dial: net.dial, resolve: net.resolve, unattended: undefined, indicator: { connected: (who, control) => events.push(['on', who, typeof control.stop]), disconnected: (who) => events.push(['off', who]) } }))
    egress.start()
    cleanups.push(() => egress.stop())
    grant(pods, [EGRESS_SCOPES.tcp('pkg.test', 443)])
    const link = await connectEgress(pods.c, pods.provider.podId)
    cleanups.push(() => link.close())
    const socket = await link.connect('pkg.test', 443)
    await socket.end()
    await readAll(socket)
    await until(() => events.length === 2, 'the indicator to hear both')
    assert.deepEqual(events[0], ['on', { peer: pods.consumer.podId, host: 'pkg.test', port: 443 }, 'function'])
    assert.equal(events[1][0], 'off')
  })

  it('the indicator can stop one connection', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const net = simNetwork({ names: { 'pkg.test': [PUBLIC] }, origins: { [`${PUBLIC}:443`]: origin.port } })
    let control
    const egress = createMeshEgress(base(pods, { dial: net.dial, resolve: net.resolve, unattended: undefined, indicator: { connected: (_w, c) => { control = c }, disconnected() {} } }))
    egress.start()
    cleanups.push(() => egress.stop())
    grant(pods, [EGRESS_SCOPES.tcp('pkg.test', 443)])
    const link = await connectEgress(pods.c, pods.provider.podId)
    cleanups.push(() => link.close())
    const socket = await link.connect('pkg.test', 443)
    await control.stop()
    const e = await outcome(socket)
    assert.ok(e instanceof EgressError && e.code === 'connection-ended' && e.reason === 'shutdown')
  })

  it('refuses a dial or resolve that is itself an egress consumer (no chaining by construction)', async () => {
    const first = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    assert.throws(() => createMeshEgress(base(pods, { dial: first.link.connect })), /dial is an egress consumer/)
    assert.throws(() => createMeshEgress(base(pods, { resolve: first.link.lookup })), /resolve is an egress consumer/)
    const backend = first.link.asBackend()
    assert.throws(() => createMeshEgress(base(pods, { dial: backend.connect })), /egress consumer/)
  })

  it('stops: every connection ends `shutdown`, the consumer is told, and nothing more is served', async () => {
    const { link, provider, pods } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const socket = await link.connect('pkg.test', 443)
    await provider.stop()
    const e = await outcome(socket)
    assert.ok(e instanceof EgressError && e.reason === 'shutdown', String(e))
    assert.equal(provider.stats().ends.shutdown, 1)
    assert.equal(provider.started, false)
    await until(() => link.closed, 'the link to close')
    await assert.rejects(connectEgress(pods.c, pods.provider.podId), code('provider-no-egress'))
    assert.throws(() => provider.start(), /stopped/)
  })

  it('validates each option it takes', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    for (const bad of [{ sets: { a: ['*:443'] } }, { sets: { a: [] } }, { blockedPorts: 25 }, { blockedPorts: [0] }, { limits: { maxConnections: 0 } }, { limits: { maxConnections: Infinity } },
      { limits: { nope: 1 } }, { limits: { connectRate: { limit: 1 } } }, { allowFrom: [] }, { allowFrom: 'x' }, { deny: 1 }, { onAudit: 1 }, { onMeter: 1 }, { verifyRequest: 1 }, { recheckIntervalMs: 0 }, { wide: true }, { wide: {} }, { wide: { acknowledge: 'yes' } }]) {
      assert.throws(() => createMeshEgress(base(pods, bad)), TypeError, JSON.stringify(bad))
    }
  })
})

describe('grants', () => {
  it('no grant: refused no-grant, the same for a destination that exists and one that does not, before any lookup', async () => {
    const { link, net, audit } = await rig(cleanups, { grants: [] })
    const a = await link.connect('pkg.test', 443).catch((e) => e)
    const b = await link.connect('nowhere.example', 443).catch((e) => e)
    for (const e of [a, b]) assert.ok(e instanceof EgressError && e.code === 'no-grant', String(e))
    assert.equal(a.message, b.message)
    assert.deepEqual(net.calls.lookups, [], 'nothing was looked up')
    assert.deepEqual(net.calls.dials, [])
    assert.ok(audit.every((r) => r.event === 'egress-refused' && r.code === 'no-grant'))
    const lookup = await link.lookup('pkg.test').catch((e) => e)
    assert.equal(lookup.code, 'no-grant')
  })

  it('a grant is for one host and one port: another port, another host and an IP literal are not covered', async () => {
    const { link, net } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    await assert.rejects(link.connect('pkg.test', 80), code('no-grant'))
    await assert.rejects(link.connect('other.test', 443), code('no-grant'))
    await assert.rejects(link.connect(PUBLIC, 443), code('no-grant'))
    await assert.rejects(link.connect('www.pkg.test', 443), code('no-grant'))
    assert.deepEqual(net.calls.dials, [])
    const socket = await link.connect('pkg.test', 443)
    await socket.end()
  })

  it('a grant for any port of a host covers every port but the blocked ones', async () => {
    const o2 = await echoOrigin()
    cleanups.push(() => o2.close())
    const { link, origin } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcpAnyPort('pkg.test')], origins: undefined, simOptions: {} })
    void origin
    await assert.rejects(link.connect('pkg.test', 25), code('port-blocked'))
    await assert.rejects(link.connect('pkg.test', 587), code('port-blocked'))
    const socket = await link.connect('pkg.test', 443)
    await socket.end()
  })

  it('a lookup needs its own grant: connecting by name does not carry one', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    await assert.rejects(link.lookup('pkg.test'), code('no-grant'))
  })

  it('a set grant covers what the set lists; a set an operator did not write covers nothing', async () => {
    const { link } = await rig(cleanups, { sets: { hosts: ['pkg.test:443'] }, grants: [EGRESS_SCOPES.set('hosts'), EGRESS_SCOPES.set('ghost')] })
    const socket = await link.connect('pkg.test', 443)
    await socket.end()
    await assert.rejects(link.connect('pkg.test', 80), code('no-grant'))
    await assert.rejects(link.connect('other.test', 443), code('no-grant'))
  })

  it('a set can hold an IP block, evaluated only for destinations given as IP literals', async () => {
    const { link, net } = await rig(cleanups, { sets: { nets: ['93.184.216.0/24:443'] }, grants: [EGRESS_SCOPES.set('nets')] })
    const socket = await link.connect(PUBLIC, 443)
    await socket.end()
    await assert.rejects(link.connect('pkg.test', 443), code('no-grant'), 'a name is not looked up to see whether it falls in a block')
    assert.deepEqual(net.calls.dials.map((d) => d.host), [PUBLIC])
  })

  it('allowFrom narrows who is served beyond the registry: a pod not on the list gets no channel', async () => {
    const { pods } = await rig(cleanups, { link: false, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { allowFrom: ['A'.repeat(43)] } })
    const link = await connectEgress(pods.c, pods.provider.podId).catch((e) => e)
    // the open is answered, then the channel is closed: the consumer finds out on its first request
    if (link instanceof EgressError) assert.ok(['provider-closed', 'provider-not-authorized', 'provider-unreachable'].includes(link.code), link.code)
    else {
      const e = await link.connect('pkg.test', 443).catch((x) => x)
      assert.ok(e instanceof EgressError && ['provider-closed', 'link-closed'].includes(e.code), String(e))
    }
  })

  it('allowFrom naming the consumer serves it', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: (pods) => ({ allowFrom: [pods.consumer.podId] }) })
    const socket = await link.connect('pkg.test', 443)
    await socket.end()
  })

  it('a function allowFrom is asked with the verified peer on every request; only true serves', async () => {
    let verdict = true
    const asked = []
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { allowFrom: (peer, ctx) => { asked.push([peer, ctx.protocol]); return verdict } } })
    const socket = await link.connect('pkg.test', 443)
    await socket.end()
    verdict = 'yes'
    await assert.rejects(link.connect('pkg.test', 443), code('no-grant'))
    verdict = true
    const again = await link.connect('pkg.test', 443)
    await again.end()
    assert.ok(asked.length >= 3)
    assert.ok(asked.every(([, p]) => p === 'egress'))
  })

  it('verifyRequest sees what signRequest signed, and a request it rejects is refused', async () => {
    const seen = []
    const { pods, provider } = await rig(cleanups, { link: false, grants: [EGRESS_SCOPES.tcp('pkg.test', 443), EGRESS_SCOPES.dns('pkg.test')], egress: { verifyRequest: ({ peer, bytes: b, sig, request }) => { seen.push({ peer, sig, request, signed: new TextDecoder().decode(b) }); return sig === 'good' } } })
    const link = await connectEgress(pods.c, pods.provider.podId, { signRequest: async (b, { peer }) => { assert.equal(peer, pods.provider.podId); return 'good' } })
    cleanups.push(() => link.close())
    const socket = await link.connect('pkg.test', 443)
    await socket.end()
    await link.lookup('pkg.test')
    assert.equal(seen.length, 2)
    assert.equal(seen[0].peer, pods.consumer.podId)
    assert.deepEqual(JSON.parse(seen[0].signed), { v: 1, dir: 'request', form: 'connect', cid: seen[0].request.cid, nonce: JSON.parse(seen[0].signed).nonce, host: 'pkg.test', port: 443 })
    assert.equal(JSON.parse(seen[1].signed).form, 'resolve')
    assert.equal(provider.stats().refused, 0)
  })

  it('a request whose signature is not accepted is refused and nothing is dialled', async () => {
    const { pods, net } = await rig(cleanups, { link: false, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { verifyRequest: () => false } })
    const link = await connectEgress(pods.c, pods.provider.podId, { signRequest: async () => 'anything' })
    cleanups.push(() => link.close())
    await assert.rejects(link.connect('pkg.test', 443), code('bad-request'))
    assert.deepEqual(net.calls.dials, [])
  })

  it('deny is the operator\'s veto, after the grant', async () => {
    const asked = []
    const { link, net } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { deny: (d) => { asked.push(d); return d.host === 'pkg.test' } } })
    await assert.rejects(link.connect('pkg.test', 443), code('destination-refused'))
    assert.deepEqual(net.calls.dials, [])
    assert.deepEqual(asked.map((d) => [d.host, d.port]), [['pkg.test', 443]])
    await assert.rejects(link.connect('other.test', 443), code('no-grant'))
    assert.equal(asked.length, 1, 'the veto is asked only about destinations that hold a grant')
  })
})

describe('wide mode', () => {
  const acknowledged = { wide: { acknowledge: WIDE_ACKNOWLEDGEMENT } }

  it('a wildcard grant is refused wide-not-acknowledged unless the operator acknowledged it, even if an exact grant would also cover the request', async () => {
    for (const wildcard of ['egress:tcp:*:443:connect', 'egress:tcp:*:*:connect', 'egress:tcp:*', 'egress:*', '*']) {
      const { link, net } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443), wildcard] })
      await assert.rejects(link.connect('pkg.test', 443), code('wide-not-acknowledged'), wildcard)
      await assert.rejects(link.connect('other.test', 443), code('wide-not-acknowledged'), wildcard)
      assert.deepEqual(net.calls.dials, [])
      for (const c of cleanups.splice(0).reverse()) await c()
    }
  })

  it('acknowledging it lets that grant reach any public destination, dialled as wide (public addresses only)', async () => {
    const { link, net } = await rig(cleanups, { grants: ['egress:tcp:*:443:connect'], egress: acknowledged })
    const socket = await link.connect('pkg.test', 443)
    await socket.end()
    assert.deepEqual(net.calls.dials, [{ host: 'pkg.test', port: 443, wide: true }])
    await assert.rejects(link.connect('pkg.test', 80), code('no-grant'), 'a wildcard over hosts for one port covers that port only')
  })

  it('a wide grant never reaches private, loopback, link-local, unique-local, carrier-NAT or metadata space, by literal or by name, whatever the operator allows for granted names', async () => {
    const names = { 'lan.test': ['10.0.0.5'], 'meta.test': ['169.254.169.254'], 'loop.test': ['127.0.0.1'], 'cgnat.test': ['100.64.0.1'] }
    const { link, net } = await rig(cleanups, { names, grants: ['egress:tcp:*:*:connect'], egress: acknowledged, simOptions: { allowPrivate: ['10.0.0.0/8', '127.0.0.0/8', '100.64.0.0/10'] } })
    for (const [host, cls] of [['10.0.0.5', 'private'], ['127.0.0.1', 'loopback'], ['169.254.169.254', 'metadata'], ['100.64.0.1', 'carrier-nat'], ['lan.test', 'private'], ['meta.test', 'metadata'], ['loop.test', 'loopback'], ['cgnat.test', 'carrier-nat']]) {
      const e = await link.connect(host, 443).catch((x) => x)
      assert.ok(e instanceof EgressError && e.code === 'destination-refused' && e.addressClass === cls, `${host}: ${e?.code} ${e?.addressClass}`)
    }
    assert.ok(net.calls.dials.every((d) => d.wide === true))
  })

  it('a dial that ignores `wide` and returns a non-public address is refused anyway (the provider checks the class it was told)', async () => {
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const loose = simNetwork({ names: { 'lan.test': ['10.0.0.5'] }, origins: { '10.0.0.5:443': origin.port }, allowPrivate: ['10.0.0.0/8'] })
    const { link } = await rig(cleanups, { grants: ['egress:tcp:*:*:connect'], egress: { ...acknowledged, dial: (r) => loose.dial({ ...r, wide: false }) } })
    const e = await link.connect('lan.test', 443).catch((x) => x)
    assert.ok(e.code === 'destination-refused' && e.addressClass === 'private')
  })

  it('only the operator can admit private space, and only for destinations a grant names', async () => {
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const { link } = await rig(cleanups, { names: { 'lan.test': ['10.0.0.5'] }, origins: { '10.0.0.5:5432': origin.port }, grants: [EGRESS_SCOPES.tcp('lan.test', 5432), EGRESS_SCOPES.tcp('10.0.0.5', 5432)], simOptions: { allowPrivate: ['10.0.0.5/32'] } })
    const socket = await link.connect('lan.test', 5432)
    await socket.end()
    const byLiteral = await link.connect('10.0.0.5', 5432)
    await byLiteral.end()
  })

  it('the mail ports stay blocked in wide mode, and the defaults cannot be removed while it is on', async () => {
    const { link } = await rig(cleanups, { grants: ['egress:tcp:*:*:connect'], egress: acknowledged })
    for (const p of DEFAULT_BLOCKED_PORTS) await assert.rejects(link.connect('pkg.test', p), code('port-blocked'))
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    assert.throws(() => createMeshEgress(base(pods, { ...acknowledged, blockedPorts: [25, 465] })), /port 587 blocked/)
    assert.throws(() => createMeshEgress(base(pods, { ...acknowledged, blockedPorts: [] })), /keeps port 25 blocked/)
    createMeshEgress(base(pods, { ...acknowledged, blockedPorts: [25, 465, 587, 3306] }))
  })

  it('a wide lookup grant is refused too without the acknowledgement', async () => {
    const { link } = await rig(cleanups, { grants: ['egress:dns:*:resolve'] })
    await assert.rejects(link.lookup('pkg.test'), code('wide-not-acknowledged'))
    const again = await rig(cleanups, { grants: ['egress:dns:*:resolve'], egress: acknowledged })
    assert.deepEqual(await again.link.lookup('pkg.test'), [PUBLIC])
    assert.deepEqual(again.net.calls.resolves, [{ name: 'pkg.test', wide: true }])
  })

  it('a set holding a bare wildcard cannot be written, so wide mode is never reached through a set', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    assert.throws(() => createMeshEgress(base(pods, { ...acknowledged, sets: { all: ['*:443'] } })), /never a set entry/)
  })
})

describe('blocked ports', () => {
  it('mail submission ports are refused by default, even with an exact grant', async () => {
    const { link, net } = await rig(cleanups, { grants: [25, 465, 587, 443].map((p) => EGRESS_SCOPES.tcp('pkg.test', p)) })
    for (const p of [25, 465, 587]) await assert.rejects(link.connect('pkg.test', p), code('port-blocked'))
    assert.deepEqual(net.calls.dials, [])
  })

  it('the operator replaces the list: blockedPorts: [] opens them, another list blocks those', async () => {
    const o25 = await echoOrigin()
    cleanups.push(() => o25.close())
    const open = await rig(cleanups, { origins: { [`${PUBLIC}:25`]: o25.port }, grants: [EGRESS_SCOPES.tcp('pkg.test', 25)], egress: { blockedPorts: [] } })
    const socket = await open.link.connect('pkg.test', 25)
    await socket.end()
    const custom = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443), EGRESS_SCOPES.tcp('pkg.test', 443 + 1)], egress: { blockedPorts: [444] } })
    await assert.rejects(custom.link.connect('pkg.test', 444), code('port-blocked'))
  })
})

describe('the address policy, after resolution, at the seam', () => {
  it('a name that resolves to a private address is refused with its class, and nothing is dialled', async () => {
    const { link, net, audit } = await rig(cleanups, { names: { 'lan.test': ['192.168.1.9'] }, grants: [EGRESS_SCOPES.tcp('lan.test', 443)] })
    const e = await link.connect('lan.test', 443).catch((x) => x)
    assert.ok(e.code === 'destination-refused' && e.addressClass === 'private')
    assert.equal(net.calls.lookups.length, 1)
    assert.ok(audit.some((r) => r.event === 'egress-refused' && r.code === 'destination-refused' && r.addressClass === 'private'))
  })

  it('a granted IP literal in private space is refused unless the operator allowed that space', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('10.1.2.3', 443), EGRESS_SCOPES.tcp('127.0.0.1', 443), EGRESS_SCOPES.tcp('169.254.169.254', 80)] })
    const classes = []
    for (const [h, p] of [['10.1.2.3', 443], ['127.0.0.1', 443], ['169.254.169.254', 80]]) classes.push((await link.connect(h, p).catch((x) => x)).addressClass)
    assert.deepEqual(classes, ['private', 'loopback', 'metadata'])
  })

  it('a refused address is refused the same whether or not anything listens there', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('10.9.9.9', 443), EGRESS_SCOPES.tcp('10.0.0.1', 443)] })
    const [a, b] = await Promise.all([link.connect('10.9.9.9', 443).catch((x) => x), link.connect('10.0.0.1', 443).catch((x) => x)])
    assert.equal(a.code, b.code)
    assert.equal(a.message, b.message)
    assert.equal(a.addressClass, b.addressClass)
  })

  it('a name that answers with both a public and a private address is refused whole (refuseMixed: the choice made by ./node, and by this double)', async () => {
    const { link, net } = await rig(cleanups, { names: { 'mixed.test': [PUBLIC, '10.0.0.5'] }, grants: [EGRESS_SCOPES.tcp('mixed.test', 443)] })
    const e = await link.connect('mixed.test', 443).catch((x) => x)
    assert.ok(e.code === 'destination-refused' && e.addressClass === 'private')
    assert.deepEqual(net.calls.dials.map((d) => d.host), ['mixed.test'])
  })

  it('a resolver that answers differently the second time cannot redirect the connection: one lookup, and the checked address is the one dialled', async () => {
    const origin = await echoOrigin()
    const other = await startOrigin((s) => { s.end('THE-OTHER-ANSWER') })
    cleanups.push(() => origin.close(), () => other.close())
    const { link, net, audit } = await rig(cleanups, { names: { 'flip.test': [[PUBLIC], ['127.0.0.1']] }, origins: { [`${PUBLIC}:443`]: origin.port, [`127.0.0.1:443`]: other.port }, grants: [EGRESS_SCOPES.tcp('flip.test', 443)] })
    const socket = await link.connect('flip.test', 443)
    await socket.write(bytes('ping'))
    await socket.end()
    assert.equal(text(await readAll(socket)), 'ping')
    assert.equal(net.calls.lookups.length, 1, 'the name is resolved once')
    assert.equal(audit.find((r) => r.event === 'egress-open').address, PUBLIC)
    // the next connection looks the name up again (a new decision) and the answer is now loopback: refused
    const second = await link.connect('flip.test', 443).catch((x) => x)
    assert.ok(second.code === 'destination-refused' && second.addressClass === 'loopback')
  })

  it('failures at the destination are named: not found, refused, and a resolver failure', async () => {
    const { link } = await rig(cleanups, { names: { 'closed.test': ['93.184.216.35'] }, grants: [EGRESS_SCOPES.tcp('closed.test', 443), EGRESS_SCOPES.tcp('nowhere.test', 443)] })
    assert.equal((await link.connect('nowhere.test', 443).catch((x) => x)).code, 'name-not-found')
    const e = await link.connect('closed.test', 443).catch((x) => x)
    assert.ok(e.code === 'connect-failed' && e.detail === 'refused' && e.posix === 'ECONNREFUSED')
  })

  it('a dial that never answers is ended at connectTimeoutMs: connect-failed timeout', async () => {
    const hang = () => new Promise(() => {})
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { dial: hang, limits: { connectTimeoutMs: 40 } } })
    const e = await link.connect('pkg.test', 443).catch((x) => x)
    assert.ok(e.code === 'connect-failed' && e.detail === 'timeout' && e.posix === 'ETIMEDOUT')
  })

  it('a dial that returns no socket is a failed connect, never a crash', async () => {
    const { link, provider } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { dial: async () => ({ socket: 'nope' }) } })
    const e = await link.connect('pkg.test', 443).catch((x) => x)
    assert.ok(e.code === 'connect-failed' && e.detail === 'failed')
    assert.equal(provider.stats().open, 0)
  })

  it('lookup answers are the resolver\'s A records, deduplicated and bounded, and a refused answer is a refusal', async () => {
    const { link } = await rig(cleanups, { names: { 'many.test': Array.from({ length: 40 }, (_, i) => `93.184.${i}.1`), 'lan.test': ['10.0.0.1'], 'mixed.test': [PUBLIC, '10.0.0.1'] }, grants: ['many.test', 'lan.test', 'mixed.test'].map((n) => EGRESS_SCOPES.dns(n)) })
    assert.equal((await link.lookup('many.test')).length, 16)
    const lan = await link.lookup('lan.test').catch((x) => x)
    assert.ok(lan.code === 'destination-refused' && lan.addressClass === 'private')
    assert.equal((await link.lookup('mixed.test').catch((x) => x)).code, 'destination-refused')
  })
})

describe('audit and meter', () => {
  it('audit lines carry who, where, the address class, bytes each way, duration and outcome, and never contents', async () => {
    const secret = 'THE-CONTENTS-OF-THE-STREAM'
    const { link, audit, provider, pods } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const socket = await link.connect('pkg.test', 443)
    await socket.write(bytes(secret))
    await socket.end()
    await readAll(socket)
    await until(() => provider.stats().closed === 1, 'close')
    const [open, close] = audit
    assert.equal(open.event, 'egress-open')
    assert.equal(open.outcome, 'opened')
    assert.equal(close.event, 'egress-close')
    assert.deepEqual({ peer: close.peer, host: close.host, port: close.port, addressClass: close.addressClass, bytesUp: close.bytesUp, bytesDown: close.bytesDown, reason: close.reason }, { peer: pods.consumer.podId, host: 'pkg.test', port: 443, addressClass: 'public', bytesUp: secret.length, bytesDown: secret.length, reason: 'closed' })
    assert.ok(Number.isFinite(close.durationMs) && close.durationMs >= 0)
    assert.ok(!JSON.stringify(audit).includes(secret))
  })

  it('a sink that throws never breaks a connection', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { onAudit: () => { throw new Error('sink') }, onMeter: () => { throw new Error('sink') } } })
    const socket = await link.connect('pkg.test', 443)
    await socket.write(bytes('ok'))
    await socket.end()
    assert.equal(text(await readAll(socket)), 'ok')
  })

  it('every refusal is audited with its code and named budget, and counted in stats()', async () => {
    const { link, audit, provider, pods } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { limits: { maxConnectionsPerConsumer: 1 } } })
    const first = await link.connect('pkg.test', 443)
    await assert.rejects(link.connect('pkg.test', 443), (e) => e.code === 'budget-exceeded' && e.budget === 'connections-per-consumer')
    await assert.rejects(link.connect('other.test', 443), code('no-grant'))
    const refused = audit.filter((r) => r.event === 'egress-refused')
    assert.deepEqual(refused.map((r) => [r.code, r.budget]), [['budget-exceeded', 'connections-per-consumer'], ['no-grant', undefined]])
    const stats = provider.stats()
    assert.equal(stats.refused, 2)
    assert.equal(stats.reasons['budget-exceeded'], 1)
    assert.equal(stats.peers[pods.consumer.podId].refused, 2)
    assert.equal(stats.peers[pods.consumer.podId].open, 1)
    await first.end()
  })

  it('the meter reports a connection\'s bytes once at its end, and in deltas while it lives; lookups are metered; no destination is in any record', async () => {
    const { link, meter, provider } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443), EGRESS_SCOPES.dns('pkg.test')], egress: { limits: { meterIntervalMs: 20 } } })
    const socket = await link.connect('pkg.test', 443)
    await socket.write(bytes('abcd'))
    assert.equal(text(await socket.read()), 'abcd')
    await until(() => meter.some((r) => !r.final && r.bytesUp === 4), 'a delta')
    await socket.write(bytes('ef'))
    await socket.read()
    await socket.end()
    await readAll(socket)
    await until(() => provider.stats().closed === 1)
    await link.lookup('pkg.test')
    const tcp = meter.filter((r) => r.form === 'tcp')
    assert.equal(tcp.filter((r) => r.final).length, 1)
    assert.equal(tcp.reduce((n, r) => n + r.connections, 0), 1)
    assert.equal(tcp.reduce((n, r) => n + r.bytesUp, 0), 6)
    assert.equal(tcp.reduce((n, r) => n + r.bytesDown, 0), 6)
    assert.equal(meter.filter((r) => r.form === 'dns').length, 1)
    for (const r of meter) assert.deepEqual(Object.keys(r).filter((k) => !['peer', 'form', 'connections', 'bytesUp', 'bytesDown', 'durationMs', 'reason', 'final'].includes(k)), [])
  })
})

describe('budgets: each one named', () => {
  it('connections per consumer', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { limits: { maxConnectionsPerConsumer: 2 } } })
    const a = await link.connect('pkg.test', 443)
    const b = await link.connect('pkg.test', 443)
    await assert.rejects(link.connect('pkg.test', 443), (e) => e.code === 'budget-exceeded' && e.budget === 'connections-per-consumer')
    await a.close()
    await until(async () => { try { (await link.connect('pkg.test', 443)).close(); return true } catch { return false } }, 'a slot to free')
    await b.close()
  })

  it('connections in all, across consumers', async () => {
    const { link, pods, provider } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { limits: { maxConnections: 1 } } })
    const first = await link.connect('pkg.test', 443)
    // a second consumer pod holds its own grant
    const second = await connectEgress(pods.s, pods.provider.podId).catch((e) => e)
    assert.equal(second.code, 'provider-not-authorized')
    pods.provider.registry.grantCapabilities(pods.stranger.podId, ['protocol:egress:open', EGRESS_SCOPES.tcp('pkg.test', 443)])
    const other = await connectEgress(pods.s, pods.provider.podId)
    cleanups.push(() => other.close())
    await assert.rejects(other.connect('pkg.test', 443), (e) => e.code === 'budget-exceeded' && e.budget === 'connections-global')
    assert.equal(provider.stats().open, 1)
    await first.close()
  })

  it('connection attempts per window (refused attempts count), against an injected clock', async () => {
    let t = 1_000
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { clock: { now: () => t }, limits: { connectRate: { limit: 3, windowMs: 60_000 } } } })
    for (let i = 0; i < 2; i++) await link.connect('pkg.test', 443).then((s) => s.close())
    await assert.rejects(link.connect('nope.test', 443), code('no-grant'))
    await assert.rejects(link.connect('pkg.test', 443), (e) => e.code === 'budget-exceeded' && e.budget === 'connect-rate')
    t += 60_001
    const s = await link.connect('pkg.test', 443)
    await s.close()
  })

  it('connection attempts per window, all consumers together', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { limits: { globalConnectRate: { limit: 2, windowMs: 60_000 } } } })
    await link.connect('pkg.test', 443).then((s) => s.close())
    await link.connect('pkg.test', 443).then((s) => s.close())
    await assert.rejects(link.connect('pkg.test', 443), (e) => e.code === 'budget-exceeded' && e.budget === 'connect-rate-global')
  })

  it('lookups per window', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.dns('pkg.test')], egress: { limits: { dnsRate: { limit: 2, windowMs: 60_000 } } } })
    await link.lookup('pkg.test')
    await link.lookup('pkg.test')
    await assert.rejects(link.lookup('pkg.test'), (e) => e.code === 'budget-exceeded' && e.budget === 'dns-rate')
  })

  it('bytes of one connection, both directions together: the connection ends byte-budget and the consumer is told', async () => {
    const { link, provider } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { limits: { maxBytesPerConnection: 10_000 } } })
    const socket = await link.connect('pkg.test', 443)
    const chunk = new Uint8Array(4000)
    const writing = (async () => { for (let i = 0; i < 8; i++) await socket.write(chunk) })().catch(() => {})
    const e = await outcome(socket)
    await writing
    assert.ok(e instanceof EgressError && e.code === 'connection-ended' && e.reason === 'byte-budget', String(e))
    assert.equal(provider.stats().ends['byte-budget'], 1)
  })

  it('bytes of one consumer per window: a live connection ends consumer-budget, and a new one is refused naming the budget', async () => {
    let t = 5_000
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { clock: { now: () => t }, limits: { maxBytesPerConsumer: { limit: 6_000, windowMs: 86_400_000 } } } })
    const socket = await link.connect('pkg.test', 443)
    const writing = (async () => { for (let i = 0; i < 6; i++) await socket.write(new Uint8Array(2000)) })().catch(() => {})
    const e = await outcome(socket)
    await writing
    assert.ok(e instanceof EgressError && e.reason === 'consumer-budget', String(e))
    await assert.rejects(link.connect('pkg.test', 443), (x) => x.code === 'budget-exceeded' && x.budget === 'bytes-per-consumer')
    t += 86_400_001
    const fresh = await link.connect('pkg.test', 443)
    await fresh.close()
  })

  it('idle time ends a connection: `idle`', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { limits: { idleMs: 40 } } })
    const socket = await link.connect('pkg.test', 443)
    const e = await outcome(socket)
    assert.ok(e instanceof EgressError && e.reason === 'idle', String(e))
  })

  it('total duration ends a connection however busy it is: `time-budget`', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { limits: { maxDurationMs: 60 } } })
    const socket = await link.connect('pkg.test', 443)
    const keep = setInterval(() => socket.write(bytes('.')).catch(() => {}), 10)
    const e = await outcome(socket)
    clearInterval(keep)
    assert.ok(e instanceof EgressError && e.reason === 'time-budget', String(e))
  })

  it('a consumer that never opens its sending stream is ended `up-timeout`', async () => {
    const { pods, provider } = await rig(cleanups, { link: false, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { limits: { upWaitMs: 40 } } })
    const { createStreamLayer } = await import('@johnhenry/browsermesh-apps/protocol-stream')
    const channel = await pods.c.api.openProtocol(pods.provider.podId, 'egress', { versions: [1] })
    const streams = createStreamLayer(channel, {})
    streams.onStream(() => {})
    const ended = deferred()
    channel.onNotification('end', (p) => ended.resolve(p))
    const answer = await channel.request('connect', { cid: 1, host: 'pkg.test', port: 443, hops: 0 })
    assert.equal(answer.ok, true)
    assert.equal((await ended.promise).reason, 'up-timeout')
    assert.equal(provider.stats().ends['up-timeout'], 1)
  })
})

describe('revocation', () => {
  it('revoking the destination\'s grant ends that consumer\'s live connections at once, with reason `revoked`; others stay', async () => {
    const { link, pods, provider, audit } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443), EGRESS_SCOPES.dns('pkg.test')] })
    const socket = await link.connect('pkg.test', 443)
    await socket.write(bytes('before'))
    assert.equal(text(await socket.read()), 'before')
    revoke(pods, [EGRESS_SCOPES.tcp('pkg.test', 443)])
    const e = await outcome(socket)
    assert.ok(e instanceof EgressError && e.reason === 'revoked', String(e))
    assert.equal(audit.filter((r) => r.event === 'egress-close').at(-1).reason, 'revoked')
    assert.equal(provider.stats().open, 0)
    assert.deepEqual(await link.lookup('pkg.test'), [PUBLIC], 'a grant that was not revoked still serves')
    await assert.rejects(link.connect('pkg.test', 443), code('no-grant'))
  })

  it('revoking the protocol itself ends the channel and every connection on it', async () => {
    const { link, pods } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const socket = await link.connect('pkg.test', 443)
    revoke(pods, ['protocol:egress:open'])
    const e = await outcome(socket)
    assert.ok(e instanceof EgressError, String(e))
    await until(() => link.closed, 'the link to close')
  })

  it('a grant that expires is noticed by recheck() (and by the interval)', async () => {
    const { link, pods, provider } = await rig(cleanups, { grants: [], egress: { recheckIntervalMs: 1_000_000 } })
    pods.provider.registry.grantCapabilities(pods.consumer.podId, [EGRESS_SCOPES.tcp('pkg.test', 443)], { expiresAt: Date.now() + 50 })
    const socket = await link.connect('pkg.test', 443)
    await until(() => Date.now() > Date.now() - 1 && pods.provider.registry.checkAccess(pods.consumer.podId, 'egress:tcp:pkg.test:443', 'connect').allowed === false, 'the grant to expire')
    provider.recheck()
    const e = await outcome(socket)
    assert.ok(e instanceof EgressError && e.reason === 'revoked', String(e))
  })

  it('a grant revoked while the destination is still being dialled never yields a connection', async () => {
    const gate = deferred()
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const net = simNetwork({ names: { 'pkg.test': [PUBLIC] }, origins: { [`${PUBLIC}:443`]: origin.port } })
    const { link, pods, provider } = await rig(cleanups, { origin, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { dial: async (r) => { await gate.promise; return net.dial(r) } } })
    const pending = link.connect('pkg.test', 443).catch((e) => e)
    await until(() => provider.stats().channels === 1 && provider.stats().requests === 1, 'the request')
    await new Promise((r) => setTimeout(r, 10))
    revoke(pods, [EGRESS_SCOPES.tcp('pkg.test', 443)])
    gate.resolve()
    const e = await pending
    assert.ok(e instanceof EgressError && e.code === 'no-grant', String(e))
    assert.equal(provider.stats().open, 0)
    assert.equal(origin.sockets.size, 0, 'the dialled socket was closed')
  })
})
