// Wire compatibility with the published 0.1.1 (TCP connect and A lookup only). Nothing in 0.1.1's messages changed: the fetch form and
// UDP are two new request methods on the same protocol version, so what is new is reached only by a consumer that asks for it,
// and an older provider answers that with method-not-found (the consumer says `provider-no-form`).
//
// The messages below are PINNED: they are what 0.1.1's consumer sends and its provider answers, copied as literals (checked once
// against the published package, both directions, by running 0.1.1 itself against this code). They are not read from src/.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamLayer } from '@johnhenry/browsermesh-apps/protocol-stream'
import { connectEgress, createMeshEgress, EGRESS_PROTOCOL, EGRESS_VERSIONS, EGRESS_SCOPES, END_REASONS, REFUSAL_CODES } from '../src/index.mjs'
import { createExchange } from '../src/node.mjs'
import { threePods, grant, simNetwork, echoOrigin, until, bytes, text, readAll, rawChannel, PUBLIC } from './helpers/mesh.mjs'
import { simUdp, udpOrigin } from './helpers/udp.mjs'
import { httpOrigin, ok } from './helpers/http.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

// What 0.1.1's consumer sends.
const OLD_CONNECT = { cid: 1, host: 'pkg.test', port: 443, hops: 0 }
const OLD_RESOLVE = { name: 'pkg.test', type: 'A', hops: 0 }
const OLD_UP_META = { cid: 1, kind: 'up' }
// What 0.1.1's provider answers.
const OLD_OK = { ok: true }
const OLD_NO_GRANT = { ok: false, code: 'no-grant' }
const OLD_CHAINING = { ok: false, code: 'chaining-refused' }
const OLD_BAD_DESTINATION = { ok: false, code: 'bad-destination' }

/** The same provider options with and without the new forms switched on. */
async function bootProvider({ newForms }) {
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  const tcp = await echoOrigin()
  const web = await httpOrigin(ok('x'))
  const udp = await udpOrigin()
  cleanups.push(() => tcp.close(), () => web.close(), () => udp.close())
  const net = simNetwork({ names: { 'pkg.test': [PUBLIC] }, origins: { [`${PUBLIC}:443`]: tcp.port, [`${PUBLIC}:80`]: web.port } })
  const sim = simUdp({ names: { 'pkg.test': [PUBLIC] }, origins: { [`${PUBLIC}:4000`]: udp.port } })
  const provider = createMeshEgress({
    service: pods.p, registry: pods.provider.registry, dial: net.dial, resolve: net.resolve, unattended: true,
    ...(newForms ? { exchange: createExchange({}), dialUdp: sim.dialUdp, fetchMethods: ['GET', 'HEAD', 'POST'], auditUrls: 'full' } : {}),
  })
  provider.start()
  cleanups.push(() => provider.stop())
  return { pods, provider }
}

describe('a 0.1.1 consumer against this provider: the same answers, whether or not the new forms are on', () => {
  for (const newForms of [false, true]) {
    it(`pinned requests get the pinned answers (new forms ${newForms ? 'on' : 'off'})`, async () => {
      const { pods } = await bootProvider({ newForms })
      grant(pods, [EGRESS_SCOPES.tcp('pkg.test', 443), EGRESS_SCOPES.dns('pkg.test')])
      const channel = await rawChannel(pods)
      assert.equal(channel.version, 1)
      const streams = createStreamLayer(channel, {})
      const downs = new Map()
      streams.onStream((reader, { meta }) => downs.set(meta.cid, reader))
      assert.deepEqual(await channel.request('connect', OLD_CONNECT), OLD_OK)
      assert.ok(downs.has(1), 'the down stream was opened before the answer')
      const up = await streams.open(OLD_UP_META)
      await up.write(bytes('ping'))
      const { value } = await downs.get(1).read()
      assert.equal(text(value), 'ping')
      await up.end()
      assert.deepEqual(await channel.request('resolve', OLD_RESOLVE), { ok: true, addresses: [PUBLIC] })
      // refusals keep their shapes
      assert.deepEqual(await channel.request('connect', { ...OLD_CONNECT, cid: 2, host: 'other.test' }), OLD_NO_GRANT)
      assert.deepEqual(await channel.request('connect', { ...OLD_CONNECT, cid: 3, hops: 1 }), OLD_CHAINING)
      assert.deepEqual(await channel.request('connect', { ...OLD_CONNECT, cid: 4, host: 'Pkg Test' }), OLD_BAD_DESTINATION)
    })
  }

  it('the protocol name and version are unchanged, and every refusal code and end reason 0.1.1 knew is still there with the same name', () => {
    assert.equal(EGRESS_PROTOCOL, 'egress')
    assert.deepEqual([...EGRESS_VERSIONS], [1])
    for (const code of ['no-grant', 'destination-refused', 'budget-exceeded', 'wide-not-acknowledged', 'chaining-refused', 'shutting-down', 'port-blocked', 'bad-request', 'bad-destination', 'name-not-found', 'lookup-failed', 'connect-failed', 'unknown']) assert.ok(Object.hasOwn(REFUSAL_CODES, code), code)
    for (const reason of ['closed', 'revoked', 'shutdown', 'byte-budget', 'consumer-budget', 'idle', 'time-budget', 'stream-abuse', 'origin-error', 'consumer-left', 'up-timeout']) assert.ok(Object.hasOwn(END_REASONS, reason), reason)
  })

  it('a new refusal detail or end reason is only ever sent for a form 0.1.1 cannot ask for (certificate: fetch; datagram-budget: udp)', async () => {
    // 0.1.1 reads a `detail` outside refused/unreachable/timeout/failed as no detail, and an end reason it does not know as none:
    // neither is sent to it, because the only requests that can produce them are `fetch` and `udp`.
    const { pods, provider } = await bootProvider({ newForms: true })
    grant(pods, [EGRESS_SCOPES.tcp('pkg.test', 443)])
    const channel = await rawChannel(pods)
    const answer = await channel.request('connect', { cid: 1, host: 'pkg.test', port: 9999, hops: 0 })
    assert.equal(answer.ok, false)
    assert.ok(answer.detail === undefined || ['refused', 'unreachable', 'timeout', 'failed'].includes(answer.detail))
    assert.equal(provider.stats().udp.flows, 0)
  })
})

describe('this consumer against a 0.1.1 provider (connect and resolve only)', () => {
  /** What 0.1.1 registers on a channel: `connect`, `resolve`; any other method is answered method-not-found by the channel. */
  async function oldProvider() {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const net = simNetwork({ names: { 'pkg.test': [PUBLIC] }, origins: { [`${PUBLIC}:443`]: origin.port } })
    const seen = []
    const stop = pods.p.api.serveProtocol('egress', (channel) => {
      const streams = createStreamLayer(channel, {})
      let up
      streams.onStream((reader) => { up = reader })
      channel.onRequest('connect', async (params) => {
        seen.push(['connect', params])
        const { socket } = await net.dial({ host: params.host, port: params.port })
        const down = await streams.open({ cid: params.cid, kind: 'down' })
        socket.on('data', (d) => down.write(new Uint8Array(d)))
        socket.on('end', () => down.end())
        const pump = async () => { for (;;) { while (!up) await new Promise((r) => setTimeout(r, 1)); const { done, value } = await up.read(); if (done) { socket.end(); return } socket.write(value) } }
        pump()
        return OLD_OK
      })
      channel.onRequest('resolve', async (params) => {
        seen.push(['resolve', params])
        return { ok: true, addresses: (await net.resolve({ name: params.name })).map((a) => a.address) }
      })
    }, { versions: [1] })
    cleanups.push(() => stop())
    grant(pods, [])
    const link = await connectEgress(pods.c, pods.provider.podId)
    cleanups.push(() => link.close())
    return { pods, link, seen }
  }

  it('connect and lookup work; what this consumer sends for them is what 0.1.1 sent', async () => {
    const { link, seen } = await oldProvider()
    const socket = await link.connect('pkg.test', 443)
    await socket.write(bytes('hello'))
    assert.equal(text(await socket.read()), 'hello')
    await socket.end()
    await readAll(socket)
    assert.deepEqual(await link.lookup('pkg.test'), [PUBLIC])
    assert.deepEqual(seen, [['connect', { cid: 1, host: 'pkg.test', port: 443, hops: 0 }], ['resolve', { name: 'pkg.test', type: 'A', hops: 0 }]])
  })

  it('fetch and udp are answered method-not-found by the older provider: provider-no-form, nothing else happens, and the link keeps working', async () => {
    const { link, seen } = await oldProvider()
    const f = await link.fetch('http://pkg.test/').catch((e) => e)
    assert.equal(f.code, 'provider-no-form')
    const u = await link.udp('pkg.test', 4000).catch((e) => e)
    assert.equal(u.code, 'provider-no-form')
    assert.deepEqual(seen, [], 'the older provider\'s handlers were never reached')
    assert.deepEqual(await link.lookup('pkg.test'), [PUBLIC])
    assert.equal(link.stats().open, 0, 'nothing is left open on this side')
  })
})

describe('this consumer against this provider with a form switched off', () => {
  it('a provider without an exchange or dialUdp answers not-offered, and says so only after the grant check', async () => {
    const { pods } = await bootProvider({ newForms: false })
    grant(pods, ['egress:http:pkg.test:80:fetch', 'egress:udp:pkg.test:4000:send'])
    const link = await connectEgress(pods.c, pods.provider.podId)
    cleanups.push(() => link.close())
    assert.equal((await link.fetch('http://pkg.test/').catch((e) => e)).code, 'not-offered')
    assert.equal((await link.udp('pkg.test', 4000).catch((e) => e)).code, 'not-offered')
    assert.equal((await link.fetch('http://nogrant.test/').catch((e) => e)).code, 'no-grant', 'no grant is said before anything about what the provider offers')
    assert.equal((await link.udp('nogrant.test', 4000).catch((e) => e)).code, 'no-grant')
    await until(() => true, 'nothing')
  })
})
