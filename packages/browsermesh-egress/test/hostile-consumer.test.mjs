// A hostile consumer: it holds the protocol channel and talks to the provider with no link library in between.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamLayer } from '@johnhenry/browsermesh-apps/protocol-stream'
import { connectEgress, EgressError, EGRESS_SCOPES } from '../src/index.mjs'
import { threePods, grant, rig, rawChannel, echoOrigin, startOrigin, until, deferred, bytes, PUBLIC } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
const code = (c) => (e) => e instanceof EgressError && e.code === c

/** A raw consumer: the channel, a stream layer, and the `down` streams it was handed. */
async function raw(pods, layerOptions = {}) {
  const channel = await rawChannel(pods)
  const streams = createStreamLayer(channel, layerOptions)
  const downs = new Map()
  streams.onStream((reader, { meta }) => { downs.set(meta.cid, reader) })
  const ends = []
  channel.onNotification('end', (p) => ends.push(p))
  return { channel, streams, downs, ends, connect: (params) => channel.request('connect', params), resolve: (params) => channel.request('resolve', params) }
}

describe('who can open the channel at all', () => {
  it('a pod with no grant for the protocol is refused, and learns nothing about what is served', async () => {
    const { pods } = await rig(cleanups, { link: false })
    await assert.rejects(connectEgress(pods.s, pods.provider.podId), code('provider-not-authorized'))
  })

  it('the protocol grant alone buys nothing: every destination is still refused no-grant', async () => {
    const { pods, net } = await rig(cleanups, { link: false })
    const c = await raw(pods)
    for (const host of ['pkg.test', 'example.com', '93.184.216.34', 'localhost', '127.0.0.1']) assert.deepEqual(await c.connect({ cid: 1, host, port: 443, hops: 0 }), { ok: false, code: 'no-grant' })
    assert.deepEqual(await c.resolve({ name: 'pkg.test', type: 'A', hops: 0 }), { ok: false, code: 'no-grant' })
    assert.deepEqual(net.calls.lookups, [])
  })

  it('scopes that are not egress scopes grant nothing: other protocols, other resources, other actions', async () => {
    const { pods, net } = await rig(cleanups, { link: false, grants: ['protocol:http:open', 'wsh-relay:*:open', 'mesh-relay:pkg.test:connect', 'gateway:tcp:pkg.test:443', 'tcp:connect', 'egress:tcp:pkg.test:443:send', 'egress:udp:pkg.test:443:send', 'egress:http:pkg.test:443:fetch', 'egress:dns:pkg.test:connect', 'egress:tcp:pkg.test:80:connect', 'egress:set:nothing:connect'] })
    const c = await raw(pods)
    assert.equal((await c.connect({ cid: 1, host: 'pkg.test', port: 443, hops: 0 })).code, 'no-grant')
    assert.equal((await c.resolve({ name: 'pkg.test', type: 'A', hops: 0 })).code, 'no-grant')
    assert.deepEqual(net.calls.dials, [])
  })

  it('a wildcard over protocols opens the channel and nothing else', async () => {
    const { pods } = await rig(cleanups, { link: false })
    pods.provider.registry.grantCapabilities(pods.stranger.podId, ['protocol:*:open'])
    const link = await connectEgress(pods.s, pods.provider.podId)
    cleanups.push(() => link.close())
    await assert.rejects(link.connect('pkg.test', 443), code('no-grant'))
  })
})

describe('destinations a consumer should not reach', () => {
  it('a destination outside its set, its host, its port, or spelled another way', async () => {
    const { link, net } = await rig(cleanups, { sets: { pkgs: ['pkg.test:443', '*.cdn.test:80,443'] }, grants: ['egress:set:pkgs:connect'] })
    for (const [h, p] of [['pkg.test', 80], ['pkg.test.', 443], ['cdn.test', 443], ['evilcdn.test', 443], ['x.cdn.test', 8080], ['pkg.test', 4430]]) {
      const e = await link.connect(h, p).catch((x) => x)
      assert.ok(e instanceof EgressError && ['no-grant', 'bad-destination'].includes(e.code), `${h}:${p} ${e?.code}`)
    }
    assert.deepEqual(net.calls.dials, [])
  })

  it('private space by literal and by name, loopback, link-local and metadata included, with grants for all of it', async () => {
    const names = { 'lan.test': ['192.168.0.7'], 'home.test': ['127.0.0.1'], 'meta.test': ['169.254.169.254'], 'v6.test': ['10.0.0.1'] }
    const grants = [...Object.keys(names), '10.0.0.1', '127.0.0.1', '169.254.169.254', '192.168.1.1', '172.16.5.5', '100.64.0.9', '0.0.0.0', '224.0.0.1'].map((h) => EGRESS_SCOPES.tcp(h, 443))
    const { link, net } = await rig(cleanups, { names, grants })
    const seen = {}
    for (const h of [...Object.keys(names), '10.0.0.1', '127.0.0.1', '169.254.169.254', '192.168.1.1', '172.16.5.5', '100.64.0.9', '0.0.0.0', '224.0.0.1']) {
      const e = await link.connect(h, 443).catch((x) => x)
      assert.ok(e instanceof EgressError && e.code === 'destination-refused', `${h}: ${e?.code}`)
      seen[h] = e.addressClass
    }
    assert.deepEqual(seen, { 'lan.test': 'private', 'home.test': 'loopback', 'meta.test': 'metadata', 'v6.test': 'private', '10.0.0.1': 'private', '127.0.0.1': 'loopback', '169.254.169.254': 'metadata', '192.168.1.1': 'private', '172.16.5.5': 'private', '100.64.0.9': 'carrier-nat', '0.0.0.0': 'unspecified', '224.0.0.1': 'multicast' })
    assert.ok(net.calls.dials.every((d) => d.wide === false))
  })

  it('a resolver that changes its answer between lookups cannot move a connection off the address that was checked', async () => {
    const good = await echoOrigin()
    const bad = await startOrigin((s) => { s.end('YOU-SHOULD-NOT-SEE-THIS') })
    cleanups.push(() => good.close(), () => bad.close())
    const { link, net } = await rig(cleanups, { names: { 'flip.test': [[PUBLIC], ['127.0.0.1'], ['127.0.0.1']] }, origins: { [`${PUBLIC}:443`]: good.port, '127.0.0.1:443': bad.port }, grants: [EGRESS_SCOPES.tcp('flip.test', 443)] })
    const s = await link.connect('flip.test', 443)
    await s.write(bytes('x'))
    assert.equal(Buffer.from(await s.read()).toString(), 'x')
    await s.close()
    for (let i = 0; i < 2; i++) assert.equal((await link.connect('flip.test', 443).catch((e) => e)).code, 'destination-refused')
    assert.equal(net.calls.lookups.length, 3, 'one lookup per attempt, never a second one for the same dial')
    assert.equal(bad.sockets.size, 0, 'nothing was ever connected to the second answer')
  })
})

describe('flooding', () => {
  it('a flood of opens is cut by the rate budget: only that many ever reach the network', async () => {
    const { pods, net, provider } = await rig(cleanups, { link: false, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { limits: { connectRate: { limit: 5, windowMs: 3_600_000 }, maxConnectionsPerConsumer: 64 } } })
    const c = await raw(pods, { maxStreams: 256 })
    const answers = await Promise.all(Array.from({ length: 60 }, (_, i) => c.connect({ cid: i + 1, host: 'pkg.test', port: 443, hops: 0 })))
    assert.equal(answers.filter((a) => a.ok).length, 5)
    assert.ok(answers.filter((a) => !a.ok).every((a) => a.code === 'budget-exceeded' && a.budget === 'connect-rate'))
    assert.equal(net.calls.dials.length, 5)
    assert.equal(provider.stats().open, 5)
  })

  it('a flood of opens is cut by the connection cap, concurrently', async () => {
    const { pods, net } = await rig(cleanups, { link: false, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { limits: { maxConnectionsPerConsumer: 3 } } })
    const c = await raw(pods, { maxStreams: 256 })
    const answers = await Promise.all(Array.from({ length: 30 }, (_, i) => c.connect({ cid: i + 1, host: 'pkg.test', port: 443, hops: 0 })))
    assert.equal(answers.filter((a) => a.ok).length, 3)
    assert.ok(answers.filter((a) => !a.ok).every((a) => a.code === 'budget-exceeded' && a.budget === 'connections-per-consumer'))
    assert.equal(net.calls.dials.length, 3)
  })

  it('a flood of refused opens is bounded too: refused attempts count against the rate', async () => {
    const { pods, net } = await rig(cleanups, { link: false, grants: [], egress: { limits: { connectRate: { limit: 4, windowMs: 3_600_000 } } } })
    const c = await raw(pods)
    const codes = []
    for (let i = 0; i < 10; i++) codes.push((await c.connect({ cid: i + 1, host: `h${i}.test`, port: 443, hops: 0 })).code)
    assert.deepEqual(codes, ['no-grant', 'no-grant', 'no-grant', 'no-grant', ...Array(6).fill('budget-exceeded')])
    assert.deepEqual(net.calls.lookups, [])
  })

  it('a connection id used twice is refused, and the first connection is untouched', async () => {
    const { pods, provider } = await rig(cleanups, { link: false, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const c = await raw(pods)
    assert.equal((await c.connect({ cid: 7, host: 'pkg.test', port: 443, hops: 0 })).ok, true)
    assert.equal((await c.connect({ cid: 7, host: 'pkg.test', port: 443, hops: 0 })).code, 'bad-request')
    assert.equal(provider.stats().open, 1)
  })

  it('malformed requests are refused one by one, and the channel is closed after too many', async () => {
    const { pods } = await rig(cleanups, { link: false, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { limits: { maxBadRequests: 4 } } })
    const c = await raw(pods)
    const bad = [null, 'x', 5, [], {}, { cid: 'a', host: 'pkg.test', port: 443, hops: 0 }, { cid: 1, host: { x: 1 }, port: 443, hops: 0 }, { cid: 1, host: 'pkg.test', port: 4.5, hops: 0 }, { cid: 1, host: 'pkg.test', port: 443 }, { cid: 1, host: 'pkg.test', port: 443, hops: 0, nonce: 'short' }]
    const answers = []
    for (const params of bad) answers.push(await c.connect(params).catch((e) => ({ threw: e.reason ?? e.message })))
    assert.ok(answers.slice(0, 5).every((a) => a.ok === false && ['bad-request', 'bad-destination'].includes(a.code)), JSON.stringify(answers))
    await until(() => c.channel.closed, 'the channel to be closed')
  })
})

describe('breaking the stream rules', () => {
  it('an up stream for a connection that does not exist, is not waiting, or arrives twice is refused', async () => {
    const { pods } = await rig(cleanups, { link: false, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const c = await raw(pods)
    await assert.rejects(c.streams.open({ cid: 5, kind: 'up' }))
    await assert.rejects(c.streams.open({ cid: 1, kind: 'down' }), 'a consumer may only open `up`')
    await assert.rejects(c.streams.open({ kind: 'up' }))
    await assert.rejects(c.streams.open({ cid: -1, kind: 'up' }))
    await assert.rejects(c.streams.open('up'))
    assert.equal((await c.connect({ cid: 1, host: 'pkg.test', port: 443, hops: 0 })).ok, true)
    const up = await c.streams.open({ cid: 1, kind: 'up' })
    await assert.rejects(c.streams.open({ cid: 1, kind: 'up' }), 'a second sending stream for one connection')
    await up.end()
  })

  it('one consumer cannot open the stream of another consumer\'s connection', async () => {
    const { pods, provider } = await rig(cleanups, { link: false, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    pods.provider.registry.grantCapabilities(pods.stranger.podId, ['protocol:egress:open'])
    const mine = await raw(pods)
    assert.equal((await mine.connect({ cid: 1, host: 'pkg.test', port: 443, hops: 0 })).ok, true)
    const sChannel = await pods.s.api.openProtocol(pods.provider.podId, 'egress', { versions: [1] })
    const sStreams = createStreamLayer(sChannel, {})
    await assert.rejects(sStreams.open({ cid: 1, kind: 'up' }))
    assert.equal(provider.stats().open, 1)
  })

  it('a flood of broken stream rules cuts the consumer off: its connections end `stream-abuse` and the channel closes', async () => {
    const { pods, provider, audit } = await rig(cleanups, { link: false, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { limits: { maxViolations: 3 } } })
    const c = await raw(pods)
    const ups = []
    for (let cid = 1; cid <= 4; cid++) {
      assert.equal((await c.connect({ cid, host: 'pkg.test', port: 443, hops: 0 })).ok, true)
      ups.push(await c.streams.open({ cid, kind: 'up' }))
    }
    // on each stream: a frame out of sequence (each is one broken rule; the budget is three)
    for (const up of ups) c.channel.notify('stream.data', { id: up.id, s: 99, d: new Uint8Array(8) })
    await until(() => provider.stats().ends['stream-abuse'] >= 1, 'a connection to end stream-abuse')
    await until(() => c.channel.closed, 'the channel to close')
    assert.ok(audit.some((r) => r.event === 'egress-abuse'))
    await until(() => provider.stats().open === 0, 'every connection to end')
  })

  it('a frame out of sequence ends that connection `stream-abuse`, and the origin gets only what arrived in order', async () => {
    const received = []
    const origin = await startOrigin((s) => { s.on('data', (d) => received.push(...d)) })
    const { pods, provider } = await rig(cleanups, { origin, link: false, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const c = await raw(pods)
    assert.equal((await c.connect({ cid: 1, host: 'pkg.test', port: 443, hops: 0 })).ok, true)
    const up = await c.streams.open({ cid: 1, kind: 'up' })
    c.channel.notify('stream.data', { id: up.id, s: 0, d: new Uint8Array([1, 2, 3]) })
    c.channel.notify('stream.data', { id: up.id, s: 1, d: new Uint8Array([4, 5]) })
    c.channel.notify('stream.data', { id: up.id, s: 7, d: new Uint8Array([6, 6, 6]) })
    c.channel.notify('stream.data', { id: up.id, s: 2, d: new Uint8Array([7, 7, 7]) })
    await until(() => provider.stats().ends['stream-abuse'] === 1, 'the connection to end')
    assert.ok(received.length <= 5 && received.every((b, i) => b === i + 1), JSON.stringify(received))
  })
})

describe('chaining', () => {
  it('a request that says it came through another egress, or does not say, is refused chaining-refused / bad-request', async () => {
    const { pods, net } = await rig(cleanups, { link: false, grants: [EGRESS_SCOPES.tcp('pkg.test', 443), EGRESS_SCOPES.dns('pkg.test')] })
    const c = await raw(pods)
    for (const hops of [1, 2, 5, 1000]) {
      assert.equal((await c.connect({ cid: hops, host: 'pkg.test', port: 443, hops })).code, 'chaining-refused', `hops ${hops}`)
      assert.equal((await c.resolve({ name: 'pkg.test', type: 'A', hops })).code, 'chaining-refused')
    }
    for (const hops of [undefined, -1, 0.5, '0', null]) assert.equal((await c.connect({ cid: 50, host: 'pkg.test', port: 443, hops })).code, 'bad-request', String(hops))
    assert.deepEqual(net.calls.dials, [])
  })

  it('a destination that is a mesh pod id is refused by the provider as well, whatever the consumer library does', async () => {
    const { pods } = await rig(cleanups, { link: false, grants: ['egress:tcp:*:*:connect'], egress: { wide: { acknowledge: 'any-public-address' } } })
    const c = await raw(pods)
    for (const host of [pods.provider.podId, pods.stranger.podId, 'A'.repeat(43)]) assert.equal((await c.connect({ cid: 9, host, port: 443, hops: 0 })).code, 'bad-destination')
  })

  it('a dial that hands back a consumer\'s socket instead of a network socket is a failed connect, not a chain', async () => {
    const first = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    // an operator who wraps a consumer by hand, past the construction check, gets nothing that works: its sockets are not network sockets
    const second = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { dial: async ({ host, port }) => ({ socket: await first.link.connect(host, port), address: PUBLIC, class: 'public' }) } })
    const e = await second.link.connect('pkg.test', 443).catch((x) => x)
    assert.ok(e instanceof EgressError && e.code === 'connect-failed' && e.detail === 'failed', String(e))
    assert.equal(second.provider.stats().open, 0)
  })
})

describe('what a provider reveals', () => {
  it('a refusal says the same thing whether the destination exists or not', async () => {
    const { pods } = await rig(cleanups, { link: false, grants: [] })
    const c = await raw(pods)
    const a = await c.connect({ cid: 1, host: 'pkg.test', port: 443, hops: 0 })
    const b = await c.connect({ cid: 2, host: 'does-not-exist.example', port: 443, hops: 0 })
    assert.deepEqual(a, b)
    assert.deepEqual(Object.keys(a).sort(), ['code', 'ok'])
  })

  it('a request in flight when the provider stops is refused shutting-down', async () => {
    const gate = deferred()
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const slow = (await import('./helpers/mesh.mjs')).simNetwork({ names: { 'pkg.test': [PUBLIC] }, origins: { [`${PUBLIC}:443`]: origin.port } })
    const { pods, provider, origin: o } = await rig(cleanups, { link: false, origin, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { dial: async (r) => { await gate.promise; return slow.dial(r) } } })
    void o
    const c = await raw(pods)
    const answer = c.connect({ cid: 1, host: 'pkg.test', port: 443, hops: 0 })
    await until(() => provider.stats().requests === 1, 'the request to arrive')
    await new Promise((r) => setTimeout(r, 10))
    await provider.stop()
    gate.resolve()
    assert.deepEqual(await answer.catch((e) => ({ threw: e.reason })), { ok: false, code: 'shutting-down' })
    assert.equal(origin.sockets.size, 0)
  })
})
