// UDP: one flow per destination, datagrams as frames of two protocol streams, a connected socket behind wsh's address guard,
// budgets per flow and per consumer, replies bounded by what the consumer sent, DNS kept to its own scope.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamLayer } from '@johnhenry/browsermesh-apps/protocol-stream'
import { connectEgress, createMeshEgress, EgressError, EGRESS_SCOPES, WIDE_ACKNOWLEDGEMENT } from '../src/index.mjs'
import { encodeDatagram } from '../src/wire.mjs'
import { threePods, grant, revoke, until, rawChannel, bytes, text } from './helpers/mesh.mjs'
import { udpRig, udpOrigin, simUdp, PUBLIC } from './helpers/udp.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
const code = (c) => (e) => e instanceof EgressError && e.code === c
const GRANT = [EGRESS_SCOPES.udp('game.test', 4000)]
const rig = (extra = {}) => udpRig(cleanups, { grants: GRANT, ...extra })

/** The next `n` datagrams of a flow, or a failure of it. Fails the test if they do not come in 8 s. */
async function readN(flow, n, ms = 8000) {
  let timer
  const never = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`only ${got.length} of ${n} datagrams came`)), ms) })
  const got = []
  const all = (async () => { while (got.length < n) { const d = await flow.read(); if (d === null) break; got.push(d) } return got })()
  try { return await Promise.race([all, never]) } finally { clearTimeout(timer) }
}
/** What ends a flow: the error its read fails with, or null for a clean end. */
async function ended(flow, ms = 8000) {
  let timer
  const never = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the flow neither ended nor failed')), ms) })
  const drained = (async () => { try { for (;;) { if ((await flow.read()) === null) return null } } catch (e) { return e } })()
  try { return await Promise.race([drained, never]) } finally { clearTimeout(timer) }
}
const reasonOf = (e) => (e instanceof EgressError && e.code === 'connection-ended' ? e.reason : String(e?.code ?? e))

describe('a flow', () => {
  it('sends datagrams to the destination and reads what it answers; the origin saw exactly the bytes, from one source', async () => {
    const { link, udpOrigin: origin, audit } = await rig({ onDatagram: (m, send) => send(Buffer.concat([Buffer.from('re:'), m])) })
    const flow = await link.udp('game.test', 4000)
    assert.equal(flow.maxDatagramBytes, 1472)
    await flow.send(bytes('one'))
    await flow.send(bytes(''))
    await flow.send(bytes('three'))
    const replies = await readN(flow, 3)
    assert.deepEqual(replies.map(text), ['re:one', 're:', 're:three'])
    assert.deepEqual(origin.received.map(text), ['one', '', 'three'])
    assert.equal(origin.sources.size, 1)
    await flow.close()
    await until(() => audit.some((r) => r.event === 'egress-close'), 'the close to be audited')
    const open = audit.find((r) => r.event === 'egress-open')
    assert.deepEqual({ form: open.form, host: open.host, port: open.port, address: open.address, addressClass: open.addressClass, via: open.via }, { form: 'udp', host: 'game.test', port: 4000, address: PUBLIC, addressClass: 'public', via: 'exact' })
    const close = audit.find((r) => r.event === 'egress-close')
    assert.deepEqual({ form: close.form, reason: close.reason, datagramsUp: close.datagramsUp, datagramsDown: close.datagramsDown, bytesUp: close.bytesUp, bytesDown: close.bytesDown }, { form: 'udp', reason: 'closed', datagramsUp: 3, datagramsDown: 3, bytesUp: 8, bytesDown: 17 })
  })

  it('a datagram split across stream chunks, and several in one chunk, are the same datagrams', async () => {
    const { pods, udpOrigin: origin } = await rig({ link: false })
    const channel = await rawChannel(pods)
    const streams = createStreamLayer(channel, {})
    const downs = new Map()
    streams.onStream((reader, { meta }) => downs.set(meta.cid, reader))
    const answer = await channel.request('udp', { cid: 1, host: 'game.test', port: 4000, hops: 0 })
    assert.equal(answer.ok, true)
    const up = await streams.open({ cid: 1, kind: 'up' })
    const a = encodeDatagram(bytes('alpha'))
    const b = encodeDatagram(bytes('bravo'))
    await up.write(a.slice(0, 1))
    await up.write(Uint8Array.from([...a.slice(1), ...b.slice(0, 4)]))
    await up.write(b.slice(4))
    await until(() => origin.received.length === 2, 'both datagrams')
    assert.deepEqual(origin.received.map(text), ['alpha', 'bravo'])
  })

  it('the consumer refuses a datagram larger than the flow allows, locally, and a closed flow rejects sends', async () => {
    const { link } = await rig()
    const flow = await link.udp('game.test', 4000)
    await assert.rejects(flow.send(new Uint8Array(1473)), code('datagram-too-large'))
    await assert.rejects(flow.send('text'), TypeError)
    await flow.send(new Uint8Array(1472))
    await flow.close()
    await assert.rejects(flow.send(bytes('x')), code('link-closed'))
    assert.equal(await flow.read(), null)
  })

  it('a flow is async iterable and ends cleanly when the consumer closes it', async () => {
    const { link } = await rig()
    const flow = await link.udp('game.test', 4000)
    await flow.send(bytes('x'))
    const seen = []
    for await (const d of flow) { seen.push(text(d)); await flow.close() }
    assert.deepEqual(seen, ['x'])
  })
})

describe('grants: the same rules as the other forms, for their own scope', () => {
  it('no grant: refused no-grant before any lookup; a TCP, fetch or DNS grant is not a UDP grant', async () => {
    const { link, sim } = await rig({ grants: [EGRESS_SCOPES.tcp('game.test', 4000), EGRESS_SCOPES.http('game.test', 4000), EGRESS_SCOPES.dns('game.test'), EGRESS_SCOPES.udp('game.test', 4001)] })
    await assert.rejects(link.udp('game.test', 4000), code('no-grant'))
    await assert.rejects(link.udp('nowhere.test', 4000), code('no-grant'))
    assert.deepEqual(sim.calls.lookups, [], 'nothing was looked up')
  })

  it('a host with any port, and a set\'s send grant (its connect grant is not one)', async () => {
    const a = await rig({ grants: [EGRESS_SCOPES.udpAnyPort('game.test')] })
    await (await a.link.udp('game.test', 4000)).close()
    const b = await udpRig(cleanups, { grants: [EGRESS_SCOPES.set('games')], egress: { sets: { games: ['game.test:4000'] } } })
    await assert.rejects(b.link.udp('game.test', 4000), code('no-grant'))
    revoke(b.pods, [EGRESS_SCOPES.set('games')])
    grant(b.pods, [EGRESS_SCOPES.setUdp('games')])
    await (await b.link.udp('game.test', 4000)).close()
  })

  it('a wildcard UDP grant is refused wide-not-acknowledged; with the acknowledgement it reaches public destinations only', async () => {
    const wild = ['egress:udp:*:*:send']
    const off = await rig({ grants: wild })
    await assert.rejects(off.link.udp('game.test', 4000), code('wide-not-acknowledged'))
    const on = await rig({ grants: wild, egress: { wide: { acknowledge: WIDE_ACKNOWLEDGEMENT } }, names: { 'game.test': [PUBLIC], 'lan.test': ['10.0.0.9'] } })
    await (await on.link.udp('game.test', 4000)).close()
    const refused = await on.link.udp('lan.test', 4000).catch((e) => e)
    assert.ok(refused.code === 'destination-refused' && refused.addressClass === 'private', String(refused.code))
  })

  it('DNS stays its own scope: UDP port 53 is blocked for every grant, wide mode included, and wide mode cannot unblock it', async () => {
    const { link, sim } = await rig({ grants: [EGRESS_SCOPES.udp('game.test', 53), 'egress:udp:*:*:send'], egress: { wide: { acknowledge: WIDE_ACKNOWLEDGEMENT } } })
    await assert.rejects(link.udp('game.test', 53), code('port-blocked'))
    await assert.rejects(link.udp('other.test', 53), code('port-blocked'))
    assert.deepEqual(sim.calls.dials, [])
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const make = (extra) => createMeshEgress({ service: pods.p, registry: pods.provider.registry, dial: async () => {}, resolve: async () => {}, unattended: true, ...extra })
    assert.throws(() => make({ wide: { acknowledge: WIDE_ACKNOWLEDGEMENT }, blockedUdpPorts: [123] }), /UDP port 53/)
    make({ blockedUdpPorts: [123] })
    assert.throws(() => make({ blockedUdpPorts: [0] }), /blockedUdpPorts/)
  })

  it('the operator\'s deny hook is asked, and a provider with no dialUdp says not-offered', async () => {
    const asked = []
    const { link } = await rig({ egress: { deny: ({ host, port }) => { asked.push([host, port]); return true } } })
    await assert.rejects(link.udp('game.test', 4000), code('destination-refused'))
    assert.deepEqual(asked, [['game.test', 4000]])
    const none = await rig({ egress: { dialUdp: undefined } })
    await assert.rejects(none.link.udp('game.test', 4000), code('not-offered'))
  })

  it('a pod id is not a destination, on either side', async () => {
    const { link, pods } = await rig()
    await assert.rejects(link.udp(pods.provider.podId, 4000), code('chaining-refused'))
    const second = await rig({ link: false })
    const raw = await rawChannel(second.pods)
    assert.equal((await raw.request('udp', { cid: 5, host: 'game.test', port: 4000, hops: 1 })).code, 'chaining-refused')
  })
})

describe('the address guard', () => {
  it('private and metadata addresses are refused with their class, by literal and by name, before anything is sent', async () => {
    const { link, sim } = await rig({ grants: [EGRESS_SCOPES.udp('10.0.0.5', 4000), EGRESS_SCOPES.udp('169.254.169.254', 4000), EGRESS_SCOPES.udp('lan.test', 4000), EGRESS_SCOPES.udp('mixed.test', 4000)], names: { 'lan.test': ['192.168.1.2'], 'mixed.test': [PUBLIC, '10.0.0.5'] } })
    const classOf = async (host) => (await link.udp(host, 4000).catch((e) => e)).addressClass
    assert.equal(await classOf('10.0.0.5'), 'private')
    assert.equal(await classOf('169.254.169.254'), 'metadata')
    assert.equal(await classOf('lan.test'), 'private')
    assert.equal(await classOf('mixed.test'), 'private', 'a name that mixes a refused answer is refused whole')
    assert.equal(sim.calls.dials.length, 4)
  })

  it('the flow goes to the address that was checked: a name that answers differently the second time does not matter (one lookup)', async () => {
    const { link, sim, audit } = await rig({ names: { 'game.test': [[PUBLIC], ['10.0.0.5']] } })
    const flow = await link.udp('game.test', 4000)
    await flow.send(bytes('x'))
    assert.equal((await readN(flow, 1)).length, 1)
    assert.deepEqual(sim.calls.lookups, ['game.test'])
    assert.equal(audit.find((r) => r.event === 'egress-open').address, PUBLIC)
  })

  it('only datagrams from the destination are delivered: a stranger writing to the flow\'s socket is not heard', async () => {
    const { link, udpOrigin: origin } = await rig({ onDatagram: (m, send, { rinfo }) => { if (m.toString() === 'hello') send(bytes('hi')) } })
    const flow = await link.udp('game.test', 4000)
    await flow.send(bytes('hello'))
    assert.equal(text((await readN(flow, 1))[0]), 'hi')
    // the destination's own socket is the only one the kernel lets through; a second socket's datagram never arrives
    const stranger = await udpOrigin()
    cleanups.push(() => stranger.close())
    const [port] = origin.sources
    stranger.sendTo(bytes('from-a-stranger'), port)
    await flow.send(bytes('hello'))
    const next = await readN(flow, 1)
    assert.equal(text(next[0]), 'hi')
  })

  it('a destination that cannot be reached is connect-failed, not a hang', async () => {
    const { link } = await rig({ grants: [EGRESS_SCOPES.udp('game.test', 4999)] })
    const e = await link.udp('game.test', 4999).catch((x) => x)
    assert.ok(e.code === 'connect-failed' && e.detail === 'refused', String(e.code))
  })
})

describe('budgets', () => {
  it('flows per consumer: the third is refused budget-exceeded, and a closed one frees its place', async () => {
    const { link, provider } = await rig({ egress: { limits: { maxUdpFlowsPerConsumer: 2 } } })
    const one = await link.udp('game.test', 4000)
    await link.udp('game.test', 4000)
    const e = await link.udp('game.test', 4000).catch((x) => x)
    assert.ok(e.code === 'budget-exceeded' && e.budget === 'udp-flows-per-consumer', String(e.budget))
    await one.close()
    await until(() => provider.stats().open === 1, 'the flow to be gone')
    await (await link.udp('game.test', 4000)).close()
  })

  it('a flow ends datagram-budget after maxUdpDatagramsPerFlow, and byte-budget after maxUdpBytesPerFlow', async () => {
    const a = await rig({ egress: { limits: { maxUdpDatagramsPerFlow: 3 } }, onDatagram: () => {} })
    const f = await a.link.udp('game.test', 4000)
    for (let i = 0; i < 4; i++) await f.send(bytes('d')).catch(() => {})
    assert.equal(reasonOf(await ended(f)), 'datagram-budget')
    const b = await rig({ egress: { limits: { maxUdpBytesPerFlow: 100 } }, onDatagram: () => {} })
    const g = await b.link.udp('game.test', 4000)
    for (let i = 0; i < 3; i++) await g.send(new Uint8Array(60)).catch(() => {})
    assert.equal(reasonOf(await ended(g)), 'byte-budget')
  })

  it('a flood past the consumer\'s datagram rate is dropped, as a network would, and counted; the flow lives', async () => {
    const t = { now: 1000 }
    const { link, provider, udpOrigin: origin, audit } = await rig({ egress: { clock: { now: () => t.now }, limits: { udpDatagramRate: { limit: 5, windowMs: 1000 } } }, onDatagram: () => {} })
    const flow = await link.udp('game.test', 4000)
    for (let i = 0; i < 20; i++) await flow.send(bytes(`d${i}`))
    await until(() => provider.stats().udp.dropped.rate >= 15, 'the flood to be counted')
    assert.equal(origin.received.length, 5)
    assert.deepEqual(origin.received.map(text), ['d0', 'd1', 'd2', 'd3', 'd4'])
    t.now += 2000
    await flow.send(bytes('later'))
    await until(() => origin.received.length === 6, 'the next window to be served')
    await flow.close()
    await until(() => audit.some((r) => r.event === 'egress-close'), 'the close')
    assert.equal(audit.find((r) => r.event === 'egress-close').droppedUp, 15)
  })

  it('the consumer\'s byte budget counts datagrams too, and a live flow ends consumer-budget', async () => {
    const { link } = await rig({ egress: { limits: { maxBytesPerConsumer: { limit: 100, windowMs: 60_000 } } }, onDatagram: () => {} })
    const flow = await link.udp('game.test', 4000)
    for (let i = 0; i < 3; i++) await flow.send(new Uint8Array(60)).catch(() => {})
    assert.equal(reasonOf(await ended(flow)), 'consumer-budget')
    const e = await link.udp('game.test', 4000).catch((x) => x)
    assert.ok(e.code === 'budget-exceeded' && e.budget === 'bytes-per-consumer')
  })

  it('an idle flow ends idle at udpIdleMs', async () => {
    const { link } = await rig({ egress: { limits: { udpIdleMs: 60 } } })
    const flow = await link.udp('game.test', 4000)
    assert.equal(reasonOf(await ended(flow)), 'idle')
  })

  it('a flow counts as a connection attempt and holds a connection while it lives', async () => {
    const { link } = await rig({ egress: { limits: { connectRate: { limit: 2, windowMs: 60_000 } } } })
    await (await link.udp('game.test', 4000)).close()
    await (await link.udp('game.test', 4000)).close()
    const e = await link.udp('game.test', 4000).catch((x) => x)
    assert.ok(e.code === 'budget-exceeded' && e.budget === 'connect-rate')
  })

  it('limits that cannot carry a datagram are refused at construction', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const make = (limits) => createMeshEgress({ service: pods.p, registry: pods.provider.registry, dial: async () => {}, resolve: async () => {}, unattended: true, limits })
    assert.throws(() => make({ maxDatagramBytes: 70000 }), /65507/)
    assert.throws(() => make({ streamWindowBytes: 4096 }), /four datagrams/)
    assert.throws(() => make({ udpReplyCreditMaxBytes: 100 }), /one datagram/)
    assert.throws(() => make({ udpIdleMs: 0 }), /positive/)
  })
})

describe('no amplification: replies are bounded by what the consumer sent', () => {
  const burst = (n, size) => (message, send) => { for (let i = 0; i < n; i++) send(Buffer.alloc(size, i)) }

  it('a tiny request earns the floor (4096 bytes) of replies, however many the destination sends; the rest are dropped and counted', async () => {
    const { link, provider } = await rig({ onDatagram: burst(20, 1000) })
    const flow = await link.udp('game.test', 4000)
    await flow.send(bytes('x'))
    const got = await readN(flow, 4)
    assert.deepEqual(got.map((d) => d.byteLength), [1000, 1000, 1000, 1000])
    await until(() => provider.stats().udp.dropped.credit >= 16, 'the excess replies to be dropped')
    assert.equal(provider.stats().udp.dropped.credit, 16)
  })

  it('credit is earned per datagram sent at udpReplyRatio times its size (or the floor, whichever is more)', async () => {
    const limits = { udpReplyFloorBytes: 1000, udpReplyRatio: 4, udpReplyCreditMaxBytes: 100_000 }
    const { link, provider } = await rig({ egress: { limits }, onDatagram: burst(10, 1000) })
    const flow = await link.udp('game.test', 4000)
    // 1000 bytes sent earns max(1000, 4 * 1000) = 4000: four of the ten replies pass, six are dropped
    await flow.send(new Uint8Array(1000))
    assert.equal((await readN(flow, 4)).length, 4)
    await until(() => provider.stats().udp.dropped.credit === 6, 'six replies to be dropped')
    assert.equal(provider.stats().udp.datagramsDown, 4)
  })

  it('credit is never held past udpReplyCreditMaxBytes: a long silence of the destination does not bank a burst', async () => {
    const limits = { udpReplyFloorBytes: 1000, udpReplyRatio: 4, udpReplyCreditMaxBytes: 5000 }
    const trigger = (m, send) => { if (m.byteLength === 1) for (let i = 0; i < 10; i++) send(Buffer.alloc(1000, i)) }
    const { link, provider } = await rig({ egress: { limits }, onDatagram: trigger })
    const flow = await link.udp('game.test', 4000)
    // six sends of 1000 bytes would earn 24000, held at 5000; the one-byte trigger earns 1000 more, still capped at 5000
    for (let i = 0; i < 6; i++) await flow.send(new Uint8Array(1000))
    await flow.send(new Uint8Array(1))
    assert.equal((await readN(flow, 5)).length, 5)
    await until(() => provider.stats().udp.dropped.credit === 5, 'five replies to be dropped')
    assert.equal(provider.stats().udp.datagramsDown, 5)
  })

  it('a reply larger than maxDatagramBytes is dropped, not truncated or split', async () => {
    const { link, provider } = await rig({ onDatagram: (m, send) => { send(Buffer.alloc(3000, 1)); send(bytes('small')) } })
    const flow = await link.udp('game.test', 4000)
    await flow.send(bytes('x'))
    assert.equal(text((await readN(flow, 1))[0]), 'small')
    assert.equal(provider.stats().udp.dropped.size, 1)
  })

  it('a consumer that does not read holds at most udpOutboxBytes of replies on the provider; the rest are dropped', async () => {
    const limits = { udpOutboxBytes: 2048, udpReplyFloorBytes: 60_000, udpReplyCreditMaxBytes: 65_536, streamWindowBytes: 8192, maxDatagramBytes: 1000 }
    const { link, provider } = await rig({ egress: { limits }, link: { limits: { streamWindowBytes: 8192 } }, onDatagram: burst(60, 900) })
    const flow = await link.udp('game.test', 4000)
    await flow.send(bytes('x'))
    await until(() => provider.stats().udp.dropped.outbox > 0, 'replies to be dropped at the outbox')
    const held = provider.stats().udp.datagramsDown
    assert.ok(held < 60, `${held} of 60 replies were taken`)
    // what was taken is delivered, in order, once the consumer reads
    const got = await readN(flow, held)
    assert.equal(got.length, held)
  })
})

describe('revocation and the end of a flow', () => {
  it('revoking the grant ends the flow: the read fails connection-ended (revoked)', async () => {
    const { link, pods } = await rig()
    const flow = await link.udp('game.test', 4000)
    revoke(pods, GRANT)
    assert.equal(reasonOf(await ended(flow)), 'revoked')
  })

  it('stopping the provider ends it: shutdown; and closing the flow frees the provider\'s end', async () => {
    const a = await rig()
    const f = await a.link.udp('game.test', 4000)
    await a.provider.stop()
    assert.equal(reasonOf(await ended(f)), 'shutdown')
    const b = await rig()
    const g = await b.link.udp('game.test', 4000)
    await g.close()
    await until(() => b.provider.stats().open === 0, 'the provider to let go')
    assert.equal(b.provider.stats().ends.closed, 1)
  })

  it('the indicator sees a flow and can stop it', async () => {
    let control
    const events = []
    const { link } = await rig({ egress: { unattended: undefined, indicator: { connected: (who, c) => { control = c; events.push(who) }, disconnected() {} } } })
    const flow = await link.udp('game.test', 4000)
    assert.deepEqual(events, [{ peer: events[0].peer, host: 'game.test', port: 4000, form: 'udp' }])
    await control.stop()
    assert.equal(reasonOf(await ended(flow)), 'shutdown')
  })

  it('an aborted signal before the answer rejects with the reason', async () => {
    const { link } = await rig()
    const ac = new AbortController()
    ac.abort(new Error('stop'))
    await assert.rejects(link.udp('game.test', 4000, { signal: ac.signal }))
  })
})

describe('a hostile consumer of the UDP form', () => {
  it('a frame longer than the flow allows ends the flow stream-abuse, and nothing of it reaches the destination', async () => {
    const { pods, udpOrigin: origin, provider } = await rig({ link: false })
    const channel = await rawChannel(pods)
    const streams = createStreamLayer(channel, {})
    streams.onStream(() => {})
    assert.equal((await channel.request('udp', { cid: 1, host: 'game.test', port: 4000, hops: 0 })).ok, true)
    const up = await streams.open({ cid: 1, kind: 'up' })
    await up.write(Uint8Array.from([0x10, 0x00, 1, 2, 3])).catch(() => {})
    await until(() => provider.stats().ends['stream-abuse'] === 1, 'the flow to be ended')
    assert.equal(origin.received.length, 0)
  })

  it('a stream for a flow that does not exist, a second up stream, and the same cid twice are refused', async () => {
    const { pods } = await rig({ link: false })
    const channel = await rawChannel(pods)
    const streams = createStreamLayer(channel, {})
    streams.onStream(() => {})
    await assert.rejects(streams.open({ cid: 9, kind: 'up' }), /bad-stream|no connection/)
    assert.equal((await channel.request('udp', { cid: 1, host: 'game.test', port: 4000, hops: 0 })).ok, true)
    assert.equal((await channel.request('udp', { cid: 1, host: 'game.test', port: 4000, hops: 0 })).code, 'bad-request')
    await streams.open({ cid: 1, kind: 'up' })
    await assert.rejects(streams.open({ cid: 1, kind: 'up' }), /bad-stream|no connection/)
  })

  it('a flow whose consumer never opens its sending stream is ended up-timeout', async () => {
    const { pods, provider } = await rig({ link: false, egress: { limits: { upWaitMs: 100 } } })
    const channel = await rawChannel(pods)
    const streams = createStreamLayer(channel, {})
    streams.onStream(() => {})
    assert.equal((await channel.request('udp', { cid: 1, host: 'game.test', port: 4000, hops: 0 })).ok, true)
    await until(() => provider.stats().ends['up-timeout'] === 1, 'up-timeout')
  })

  it('malformed requests: a bad host, a port out of range and a string cid are refused by name', async () => {
    const { pods } = await rig({ link: false })
    const channel = await rawChannel(pods)
    assert.equal((await channel.request('udp', { cid: 1, host: 'Game Test', port: 4000, hops: 0 })).code, 'bad-destination')
    assert.equal((await channel.request('udp', { cid: 1, host: 'game.test', port: 70000, hops: 0 })).code, 'bad-destination')
    assert.equal((await channel.request('udp', { cid: '1', host: 'game.test', port: 4000, hops: 0 })).code, 'bad-request')
  })
})

describe('a hostile provider, as the consumer sees it', () => {
  async function hostile(handle, { stream = true } = {}) {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const stop = pods.p.api.serveProtocol('egress', (channel) => {
      const streams = createStreamLayer(channel, {})
      streams.onStream(() => {}) // the consumer's sending stream: this provider takes it and ignores it
      channel.onRequest('udp', async (p) => handle(p, { streams, channel }))
    }, { versions: [1] })
    cleanups.push(() => stop())
    grant(pods, [])
    const link = await connectEgress(pods.c, pods.provider.podId)
    cleanups.push(() => link.close())
    return link
  }
  const down = (writes, { end = true } = {}) => async (p, { streams }) => {
    const w = await streams.open({ cid: p.cid, kind: 'down' })
    ;(async () => { for (const chunk of writes) await w.write(chunk); if (end) await w.end() })().catch(() => {})
    return { ok: true, maxDatagramBytes: 100 }
  }

  it('a datagram bound that is not a number from 1 to 65507 is bad-answer', async () => {
    for (const max of [0, 70000, '100', null, 1.5]) {
      const link = await hostile(async () => ({ ok: true, maxDatagramBytes: max }))
      await assert.rejects(link.udp('game.test', 4000), code('bad-answer'))
    }
  })

  it('a frame longer than the bound it announced fails the flow bad-answer; it is never delivered', async () => {
    const link = await hostile(down([encodeDatagram(bytes('ok')), Uint8Array.from([0, 200, ...new Uint8Array(200)])], { end: false }))
    const flow = await link.udp('game.test', 4000)
    assert.equal(text(await flow.read()), 'ok')
    await assert.rejects(flow.read(), code('bad-answer'))
  })

  it('a truncated frame at the end of the stream fails the flow; a clean end is null', async () => {
    const link = await hostile(down([Uint8Array.from([0, 5, 1, 2])]))
    const flow = await link.udp('game.test', 4000)
    await assert.rejects(flow.read(), code('bad-answer'))
    const clean = await hostile(down([encodeDatagram(bytes('last'))]))
    const f2 = await clean.udp('game.test', 4000)
    assert.equal(text(await f2.read()), 'last')
    assert.equal(await f2.read(), null)
  })

  it('a provider that has no udp method at all (one older than the form) is provider-no-form', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const stop = pods.p.api.serveProtocol('egress', (channel) => { channel.onRequest('connect', async () => ({ ok: false, code: 'no-grant' })) }, { versions: [1] })
    cleanups.push(() => stop())
    grant(pods, [])
    const link = await connectEgress(pods.c, pods.provider.podId)
    cleanups.push(() => link.close())
    await assert.rejects(link.udp('game.test', 4000), code('provider-no-form'))
  })

  it('what the consumer can and cannot trust: the datagrams are the provider\'s word, not the destination\'s, and nothing authenticates them', async () => {
    // A lying provider can invent any reply. The consumer's defence is the same as for TCP: do not treat a datagram as the
    // destination's unless the payload protocol authenticates it (DTLS, QUIC, a signature).
    const link = await hostile(down([encodeDatagram(bytes('I am the destination'))]))
    const flow = await link.udp('game.test', 4000)
    assert.equal(text(await flow.read()), 'I am the destination')
  })
})

describe('the UDP form does not change the others', () => {
  it('connect, lookup and fetch still work beside it, and a provider with dialUdp serves both', async () => {
    const { link } = await rig({ grants: [...GRANT, EGRESS_SCOPES.tcp('pkg.test', 443), EGRESS_SCOPES.dns('pkg.test')], names: { 'game.test': [PUBLIC], 'pkg.test': [PUBLIC] }, origins: undefined })
    await (await link.udp('game.test', 4000)).close()
    assert.deepEqual(await link.lookup('pkg.test'), [PUBLIC])
  })
})

describe('the real guard behind a real datagram socket', () => {
  it('nodeDialer().dialUdp reaches loopback only when the operator listed it, and a datagram goes to the checked address', async () => {
    const { nodeDialer } = await import('../src/node.mjs')
    const origin = await udpOrigin((m, send) => send(m))
    cleanups.push(() => origin.close())
    const refusing = nodeDialer()
    await assert.rejects(refusing.dialUdp({ host: '127.0.0.1', port: origin.port }), (e) => e.code === 'ADDRESS_REFUSED')
    const allowing = nodeDialer({ allowPrivate: ['127.0.0.1'], denyOwnAddresses: false })
    const dialed = await allowing.dialUdp({ host: '127.0.0.1', port: origin.port })
    cleanups.push(() => dialed.socket.close())
    assert.equal(dialed.class, 'loopback')
    const echoed = new Promise((resolve) => dialed.socket.once('message', resolve))
    dialed.socket.send(bytes('real'))
    assert.equal(text(await echoed), 'real')
    // wide mode ignores allowPrivate
    await assert.rejects(allowing.dialUdp({ host: '127.0.0.1', port: origin.port, wide: true }), (e) => e.code === 'ADDRESS_REFUSED')
  })
})
