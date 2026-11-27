// Item 3 of #379: a provider (or a consumer) that is killed outright is noticed in seconds, not minutes.
//
// A keep-alive rides the protocol channel: a `ping` request each interval, answered `{ ok: true }`. A peer is declared gone only
// after `misses` intervals in which nothing at all was heard from it (an answer to a ping, a ping of its own, any message of the
// protocol). A peer that predates the keep-alive answers `ping` with method-not-found, which is itself proof it is there: it is
// never declared gone for lacking the method.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MeshChannelError, ChannelErrorCode } from '@johnhenry/browsermesh-apps/mesh-channel'
import { connectEgress, createMeshEgress, EgressError, EGRESS_SCOPES, CLOSE_REASONS, LINK_CODES } from '../src/index.mjs'
import { KEEPALIVE_DEFAULTS, resolveKeepAlive, startLiveness } from '../src/liveness.mjs'
import { threePods, grant, rig, until, deferred, echoOrigin, simNetwork, outcome, PUBLIC, rawChannel } from './helpers/mesh.mjs'
import { fetchRig } from './helpers/http.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
const code = (c) => (e) => e instanceof EgressError && e.code === c
const FAST = { intervalMs: 20, misses: 3 }
// For a test that waits on the live link before the bus goes dark: a stall of the event loop longer than the whole FAST window (60 ms)
// declares the provider gone while it is still answering. 750 ms still ends the test in about a second.
const PATIENT = { intervalMs: 250, misses: 3 }

/** A fake channel and a manual clock: `tick()` is the timer firing, `advance(ms)` moves time. */
function manual() {
  let t = 0
  let tick = null
  const requests = []
  const messages = new Set()
  const channel = {
    request(method, params, opts) { const d = deferred(); requests.push({ method, params, opts, ...d }); return d.promise },
    onMessage(cb) { messages.add(cb); return () => messages.delete(cb) },
    onClose() { return () => {} },
  }
  return {
    channel, requests,
    now: () => t,
    advance(ms) { t += ms },
    setTimer: (fn) => { tick = fn; return 1 },
    clearTimer: () => { tick = null },
    tick: () => tick?.(),
    get armed() { return tick !== null },
    hear: (m = {}) => { for (const cb of messages) cb(m, {}) },
  }
}

describe('the keep-alive, with a clock the test holds', () => {
  const start = (m, extra = {}) => {
    const dead = []
    const live = startLiveness(m.channel, { intervalMs: 1000, misses: 3, now: m.now, setTimer: m.setTimer, clearTimer: m.clearTimer, onDead: () => dead.push('dead'), ...extra })
    return { live, dead }
  }

  it('sends one ping per interval, and a peer that answers is never declared gone', async () => {
    const m = manual()
    const { dead } = start(m)
    for (let i = 0; i < 20; i++) {
      m.advance(1000)
      m.tick()
      m.requests.at(-1).resolve({ ok: true })
      await Promise.resolve(); await Promise.resolve()
    }
    assert.equal(m.requests.length, 20)
    assert.ok(m.requests.every((r) => r.method === 'ping'))
    assert.deepEqual(dead, [])
  })

  it('a peer heard from in no way for `misses` intervals is declared gone, once', async () => {
    const m = manual()
    const { dead } = start(m)
    m.advance(1000); m.tick()
    m.advance(1000); m.tick()
    assert.deepEqual(dead, [], 'two silent intervals are not three')
    m.advance(1000); m.tick()
    assert.deepEqual(dead, ['dead'])
    m.advance(5000); m.tick()
    assert.deepEqual(dead, ['dead'], 'said once')
    assert.equal(m.armed, false, 'the timer is stopped')
  })

  it('any message of the protocol is proof of life, and so is a ping of the peer\'s own', () => {
    const m = manual()
    const { dead, live } = start(m)
    for (let i = 0; i < 10; i++) { m.advance(2500); m.hear({ any: 'thing' }); m.tick() }
    assert.deepEqual(dead, [])
    m.advance(2500)
    live.heard()
    m.advance(2500); m.tick()
    assert.deepEqual(dead, [])
  })

  it('an older peer answers ping with method-not-found: that is an answer, so it is alive (and busy/failed handlers count too)', async () => {
    const m = manual()
    const { dead } = start(m)
    for (const e of [new MeshChannelError(ChannelErrorCode.METHOD_NOT_FOUND, 'method-not-found'), new MeshChannelError(ChannelErrorCode.BUSY, 'too-many-requests'), new MeshChannelError(ChannelErrorCode.INTERNAL, 'handler-failed')]) {
      m.advance(2500); m.tick()
      m.requests.at(-1).reject(e)
      await Promise.resolve(); await Promise.resolve()
    }
    m.advance(2500); m.tick()
    assert.deepEqual(dead, [])
  })

  it('a timeout, a cancelled ping and a closed channel are not proof of life', async () => {
    const m = manual()
    const { dead } = start(m)
    for (const e of [new MeshChannelError(ChannelErrorCode.CANCELLED, 'timeout'), new MeshChannelError(ChannelErrorCode.CANCELLED, 'channel-closed'), new Error('x')]) {
      m.advance(1000); m.tick()
      m.requests.at(-1).reject(e)
      await Promise.resolve(); await Promise.resolve()
    }
    assert.deepEqual(dead, ['dead'])
  })

  it('stop() ends it: no more pings, never declared gone', () => {
    const m = manual()
    const { live, dead } = start(m)
    live.stop()
    m.advance(100_000); m.tick()
    assert.deepEqual(dead, [])
    assert.equal(m.requests.length, 0)
  })
})

describe('the settings', () => {
  it('noticed within about 15 s by default: every 5 s, three misses', () => {
    assert.deepEqual({ ...KEEPALIVE_DEFAULTS }, { intervalMs: 5000, misses: 3 })
    assert.equal(KEEPALIVE_DEFAULTS.intervalMs * KEEPALIVE_DEFAULTS.misses, 15_000)
  })
  it('resolveKeepAlive: undefined or true is the defaults, false is off, an object overrides, anything else is a TypeError', () => {
    assert.deepEqual(resolveKeepAlive(undefined), { ...KEEPALIVE_DEFAULTS })
    assert.deepEqual(resolveKeepAlive(true), { ...KEEPALIVE_DEFAULTS })
    assert.equal(resolveKeepAlive(false), null)
    assert.deepEqual(resolveKeepAlive({ intervalMs: 100 }), { intervalMs: 100, misses: 3 })
    for (const bad of [0, -1, 'x', { intervalMs: 0 }, { misses: 0 }, { misses: 1.5 }, { intervalMs: 'x' }, { other: 1 }, null, []]) assert.throws(() => resolveKeepAlive(bad), TypeError, JSON.stringify(bad))
  })
})

describe('the consumer\'s link: events with a reason', () => {
  it('a link closed by its owner says local-close; closed stays a boolean; onClose and whenClosed both hear it, once', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const heard = []
    link.onClose((info) => heard.push(info))
    assert.equal(link.closed, false)
    assert.equal(link.closeReason, undefined)
    await link.close()
    await link.close()
    assert.equal(link.closed, true)
    assert.deepEqual(await link.whenClosed, { reason: 'local-close' })
    assert.deepEqual(heard, [{ reason: 'local-close' }])
    assert.equal(link.closeReason, 'local-close')
    // a listener added after the end hears it too, and the off function works
    const late = []
    link.onClose((info) => late.push(info))
    await Promise.resolve()
    assert.deepEqual(late, [{ reason: 'local-close' }])
    assert.equal(typeof link.onClose(() => {}), 'function')
  })

  it('a provider that stops says provider-stopped; one that revokes the consumer\'s access says revoked', async () => {
    const stopping = await rig(cleanups, { grants: [] })
    const stoppedReason = stopping.link.whenClosed
    await stopping.provider.stop()
    assert.deepEqual(await stoppedReason, { reason: 'provider-stopped' })

    const revoking = await rig(cleanups, { grants: [] })
    const revokedReason = revoking.link.whenClosed
    revoking.pods.provider.registry.revokeCapabilities(revoking.pods.consumer.podId, ['protocol:egress:open'])
    assert.deepEqual(await revokedReason, { reason: 'revoked' })
  })

  it('a provider that refuses the consumer after the open (allowFrom) says provider-refused', async () => {
    const r = await rig(cleanups, { grants: [], link: false, egress: { allowFrom: async () => false } })
    // the open succeeds (the channel accepts, then the pod decides): the link learns it was closed on it
    const link = await connectEgress(r.pods.c, r.pods.provider.podId).catch((e) => e)
    if (link instanceof Error) assert.ok(['provider-closed', 'provider-refused'].includes(link.code), link.code)
    else assert.deepEqual(await link.whenClosed, { reason: 'provider-refused' })
  })

  it('a channel closed with no reason is provider-closed; the reasons are a documented list', () => {
    for (const reason of ['local-close', 'provider-gone', 'provider-closed', 'provider-stopped', 'revoked', 'provider-refused', 'protocol-violation']) assert.ok(Object.hasOwn(CLOSE_REASONS, reason), reason)
    assert.ok(Object.hasOwn(LINK_CODES, 'provider-gone'))
  })
})

/** A bus that can go dark: every message after `dark.on` is dropped, both ways, as when a process is killed or a network is cut. */
function darkBus() {
  const dark = { on: false }
  return { dark, deliver: (fn) => { if (!dark.on) queueMicrotask(fn) } }
}

describe('a provider that is killed outright', () => {
  it('is noticed: the link ends provider-gone, a connect that was waiting fails with provider-gone, and nothing is left open', async () => {
    const bus = darkBus()
    const hang = deferred()
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const net = simNetwork({ names: { 'pkg.test': [PUBLIC] }, origins: { [`${PUBLIC}:443`]: origin.port, [`${PUBLIC}:80`]: origin.port } })
    const r = await fetchRig(cleanups, {
      names: { 'pkg.test': [PUBLIC] }, origins: { [`${PUBLIC}:443`]: origin.port, [`${PUBLIC}:80`]: origin.port },
      deliver: bus.deliver, grants: [EGRESS_SCOPES.tcp('pkg.test', 443), EGRESS_SCOPES.dns('pkg.test'), EGRESS_SCOPES.http('pkg.test', 80)],
      egress: { dial: async (request) => { await hang.promise; return net.dial(request) } },
      link: { keepAlive: PATIENT },
    })
    const waiting = r.link.connect('pkg.test', 443)
    waiting.catch(() => {}) // asserted below; never an unhandled rejection while the test waits
    const fetching = r.link.fetch('http://pkg.test/').catch((e) => e)
    await until(() => r.provider.stats().requests >= 2, 'the provider to have the requests')
    // the lookup is sent as the bus goes dark: it can only fail with the link's own end
    bus.dark.on = true
    const lookup = r.link.lookup('pkg.test').catch((e) => e)
    await assert.rejects(waiting, code('provider-gone'))
    assert.ok(await lookup instanceof EgressError && (await lookup).code === 'provider-gone')
    assert.ok(await fetching instanceof EgressError && (await fetching).code === 'provider-gone')
    assert.deepEqual(await r.link.whenClosed, { reason: 'provider-gone' })
    assert.equal(r.link.closed, true)
    assert.equal(r.link.stats().open, 0)
    await assert.rejects(r.link.connect('pkg.test', 443), code('link-closed'))
    hang.resolve()
  })

  it('an open connection fails with provider-gone, not with a hang', async () => {
    const bus = darkBus()
    const r = await rig(cleanups, { deliver: bus.deliver, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], link: { keepAlive: FAST } })
    const socket = await r.link.connect('pkg.test', 443)
    bus.dark.on = true
    const e = await outcome(socket)
    assert.ok(e instanceof EgressError && e.code === 'provider-gone', String(e?.code))
  })

  it('the provider notices a dead consumer too, ends its connections and frees its budgets', async () => {
    const bus = darkBus()
    const r = await rig(cleanups, { deliver: bus.deliver, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], link: { keepAlive: false }, egress: { keepAlive: FAST, limits: { maxConnections: 1, maxConnectionsPerConsumer: 1 } } })
    r.pods.provider.registry.grantCapabilities(r.pods.stranger.podId, ['protocol:egress:open', EGRESS_SCOPES.tcp('pkg.test', 443)])
    await r.link.connect('pkg.test', 443)
    assert.equal(r.provider.connections.length, 1)
    // the one global slot is held by the consumer that is about to vanish
    await assert.rejects(r.link.connect('pkg.test', 443), (e) => e.code === 'budget-exceeded')
    bus.dark.on = true
    await until(() => r.provider.connections.length === 0 && r.provider.stats().gone >= 1, 'the provider to give up on the consumer')
    assert.equal(r.provider.stats().ends['consumer-left'], 1)
    assert.ok(r.audit.some((a) => a.event === 'egress-consumer-gone' && a.peer === r.pods.consumer.podId))
    // the slot is free again: another consumer is served
    bus.dark.on = false
    const other = await connectEgress(r.pods.s, r.pods.provider.podId, { keepAlive: false })
    cleanups.push(() => other.close())
    const served = await other.connect('pkg.test', 443)
    served.destroy()
  })

  it('a link and a provider that keep answering are never declared gone, over many intervals', async () => {
    const r = await rig(cleanups, { grants: [], link: { keepAlive: FAST }, egress: { keepAlive: FAST } })
    await until(() => r.link.stats().pongs >= 6 && r.provider.stats().pings >= 6, 'six pings each way')
    assert.equal(r.link.closed, false)
    assert.equal(r.provider.stats().gone, 0)
  })
})

describe('what an older peer does', () => {
  it('a provider of 0.2.0 has no ping: it answers method-not-found, and the link stays up while it keeps answering', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const stop = pods.p.api.serveProtocol('egress', () => {}, { versions: [1] })
    cleanups.push(() => stop())
    grant(pods, [])
    const link = await connectEgress(pods.c, pods.provider.podId, { keepAlive: FAST })
    cleanups.push(() => link.close())
    await until(() => link.stats().pongs >= 6, 'six answers of method-not-found')
    assert.equal(link.closed, false)
  })

  it('a consumer of 0.2.0 does not answer ping: the provider hears method-not-found and keeps serving it', async () => {
    const r = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], link: false, egress: { keepAlive: FAST } })
    const channel = await rawChannel(r.pods) // a consumer with no ping handler and no keep-alive
    await until(() => r.provider.stats().pings >= 6, 'six pings to the raw consumer')
    assert.equal(r.provider.stats().gone, 0)
    assert.equal(r.provider.stats().channels, 1)
    assert.equal(channel.closed, false)
  })

  it('the keep-alive can be switched off at either end: no ping is sent, and nothing is declared gone', async () => {
    const r = await rig(cleanups, { grants: [], link: { keepAlive: false }, egress: { keepAlive: false } })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(r.link.stats().pings, 0)
    assert.equal(r.provider.stats().pings, 0)
  })

  it('bad settings are refused when the link or the provider is made', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    grant(pods, [])
    await assert.rejects(connectEgress(pods.c, pods.provider.podId, { keepAlive: { intervalMs: 0 } }), TypeError)
    assert.throws(() => createMeshEgress({ service: pods.p, registry: pods.provider.registry, dial() {}, resolve() {}, keepAlive: { misses: -1 } }), TypeError)
  })
})
