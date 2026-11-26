// Names a pod may claim under the operator's zone: the table's rules (each broken once), then the same rules over the
// protocol channel, with a real PeerRegistry on the ingress deciding what a pod may claim (default deny).
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  NAME_DENY_DEFAULTS, NAMES_PROTOCOL, NameRefusal, checkLabel, createMeshIngress, createNameTable, openNameClient, registryAllow, serveHttpOnMesh, serveIngressNames,
} from '../src/index.mjs'
import { threePods, grantHttp, until } from './helpers/mesh.mjs'

const ZONE = 'pods.example.test'
const POD_A = `podA${'A'.repeat(39)}`
const POD_B = `podB${'B'.repeat(39)}`
const LINK_A1 = {}
const LINK_A2 = {}
const LINK_B = {}

function clockAt(t = 1_000_000) {
  const clock = { t, now: () => clock.t, advance: (ms) => { clock.t += ms } }
  return clock
}
const everything = () => true
const table = (opts = {}) => {
  const clock = clockAt()
  const audits = []
  const t = createNameTable({ zone: ZONE, allow: everything, clock, onAudit: (r) => audits.push(r), ...opts })
  return { t, clock, audits }
}
const refusal = (reason) => (e) => e instanceof NameRefusal && e.reason === reason
const refused = async (promise, reason) => assert.rejects(promise, refusal(reason))

describe('what a name may be', () => {
  it('takes plain lowercase DNS labels', () => {
    for (const ok of ['app', 'a', 'my-app', 'app2', '2fa-app', 'x'.repeat(63)]) assert.equal(checkLabel(ok), ok)
  })

  it('refuses everything else, and does not fold case', () => {
    for (const bad of ['', 'App', 'a.b', 'a_b', '-a', 'a-', 'a b', 'a/b', 'app\n', 'x'.repeat(64), 'café', 'aаpp', 5, null, undefined, {}]) {
      assert.throws(() => checkLabel(bad), refusal('bad-name'), String(bad))
    }
  })

  it('refuses a label with hyphens in the third and fourth places: punycode and what looks like it', () => {
    for (const bad of ['xn--pple-43d', 'xn--a', 'ab--cd', 'ab--c']) assert.throws(() => checkLabel(bad), refusal('bad-name'), bad)
    assert.equal(checkLabel('a-b--c'), 'a-b--c') // hyphens elsewhere are fine
  })

  it('has a deny-list of confusing names, and the operator adds to it', async () => {
    for (const name of ['www', 'api', 'admin', 'mail', 'login', 'ns1', 'localhost']) assert.ok(NAME_DENY_DEFAULTS.includes(name), name)
    const { t } = table({ deny: ['staff', 'ops-*'] })
    for (const name of ['www', 'api', 'admin', 'staff', 'ops-db', 'ops-x']) await refused(t.claim(POD_A, name, { link: LINK_A1 }), 'denied-name')
    assert.equal((await t.claim(POD_A, 'opsdb', { link: LINK_A1 })).host, `opsdb.${ZONE}`)
  })

  it('a granted name on the deny-list is still refused: the operator maps those by hand', async () => {
    const { t } = table({ allow: () => true })
    await refused(t.claim(POD_A, 'admin', { link: LINK_A1 }), 'denied-name')
  })
})

describe('who may claim', () => {
  it('nothing is allowed without an allow function, and the zone must be a hostname', async () => {
    const t = createNameTable({ zone: ZONE })
    await refused(t.claim(POD_A, 'app', { link: LINK_A1 }), 'not-granted')
    for (const zone of ['', 'a b', 'UP.example', '.example.test', 'x'.repeat(300), 'host:80', undefined]) assert.throws(() => createNameTable({ zone }), TypeError, String(zone))
  })

  it('a pod the allow function says no to, or one that throws, claims nothing', async () => {
    for (const allow of [() => false, () => undefined, () => 'yes', () => { throw new Error('x') }, async () => false, async () => { throw new Error('x') }]) {
      const { t } = table({ allow })
      await refused(t.claim(POD_A, 'app', { link: LINK_A1 }), 'not-granted')
      assert.equal(t.lookup(`app.${ZONE}`), null)
    }
  })

  it('is asked with the pod and the name, so a grant can be per name', async () => {
    const asked = []
    const { t } = table({ allow: (pod, label) => { asked.push([pod, label]); return label === 'mine' } })
    await t.claim(POD_A, 'mine', { link: LINK_A1 })
    await refused(t.claim(POD_A, 'yours', { link: LINK_A1 }), 'not-granted')
    assert.deepEqual(asked, [[POD_A, 'mine'], [POD_A, 'yours']])
  })
})

describe('lookup', () => {
  it('finds a claimed name under the zone, with or without a port, and nothing else', async () => {
    const { t } = table()
    await t.claim(POD_A, 'app', { link: LINK_A1, service: 'web' })
    assert.deepEqual(t.lookup(`app.${ZONE}`), { peer: POD_A, service: 'web', name: 'app', held: false })
    assert.equal(t.lookup(`app.${ZONE}:8080`)?.peer, POD_A)
    for (const host of [ZONE, `other.${ZONE}`, `a.app.${ZONE}`, `app.${ZONE}.evil.test`, 'app.elsewhere.test', `xapp.${ZONE}`, '', 'app']) assert.equal(t.lookup(host), null, host)
  })
})

describe('a name another live pod holds', () => {
  it('is never given to a second pod, however often it asks', async () => {
    const { t } = table()
    await t.claim(POD_A, 'app', { link: LINK_A1 })
    for (let i = 0; i < 3; i++) await refused(t.claim(POD_B, 'app', { link: LINK_B }), 'name-taken')
    assert.equal(t.lookup(`app.${ZONE}`).peer, POD_A)
  })

  it('claiming it again is the same pod changing its service, not a second slot', async () => {
    const { t } = table({ maxPerPod: 1 })
    await t.claim(POD_A, 'app', { link: LINK_A1, service: 'one' })
    await t.claim(POD_A, 'app', { link: LINK_A1, service: 'two' })
    assert.equal(t.lookup(`app.${ZONE}`).service, 'two')
    assert.equal(t.stats().names, 1)
  })

  it('two claims racing behind a slow allow: exactly one pod gets it', async () => {
    const { t } = table({ allow: async () => { await new Promise((r) => setTimeout(r, 1)); return true } })
    const results = await Promise.allSettled([t.claim(POD_A, 'app', { link: LINK_A1 }), t.claim(POD_B, 'app', { link: LINK_B })])
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.reason === 'name-taken').length, 1)
  })

  it('release frees it for others, and only its holder can release it', async () => {
    const { t } = table()
    await t.claim(POD_A, 'app', { link: LINK_A1 })
    assert.equal(t.release(POD_B, 'app'), false)
    assert.equal(t.lookup(`app.${ZONE}`).peer, POD_A)
    assert.equal(t.release(POD_A, 'app'), true)
    assert.equal(t.lookup(`app.${ZONE}`), null)
    await t.claim(POD_B, 'app', { link: LINK_B })
    assert.equal(t.lookup(`app.${ZONE}`).peer, POD_B)
  })
})

describe('bounds', () => {
  it('a pod holds at most maxPerPod names, and the zone at most maxNames', async () => {
    const { t } = table({ maxPerPod: 2, maxNames: 3 })
    await t.claim(POD_A, 'a1', { link: LINK_A1 })
    await t.claim(POD_A, 'a2', { link: LINK_A1 })
    await refused(t.claim(POD_A, 'a3', { link: LINK_A1 }), 'too-many-names')
    await t.claim(POD_B, 'b1', { link: LINK_B })
    await refused(t.claim(POD_B, 'b2', { link: LINK_B }), 'zone-full')
    t.release(POD_A, 'a1')
    await t.claim(POD_B, 'b2', { link: LINK_B })
  })

  it('a flood of claims is cut off, refused ones included, and the window passes', async () => {
    const { t, clock } = table({ claimRate: { limit: 5, windowMs: 60_000 }, maxPerPod: 100, maxNames: 1000 })
    for (let i = 0; i < 5; i++) await refused(t.claim(POD_A, 'api', { link: LINK_A1 }), 'denied-name')
    const flooded = await t.claim(POD_A, 'app', { link: LINK_A1 }).catch((e) => e)
    assert.ok(refusal('claim-rate')(flooded))
    assert.ok(flooded.retryAfterMs > 0)
    await refused(t.claim(POD_A, 'app', { link: LINK_A1 }), 'claim-rate')
    await t.claim(POD_B, 'app', { link: LINK_B }) // another pod has its own allowance
    clock.advance(60_000)
    await refused(t.claim(POD_A, 'app', { link: LINK_A1 }), 'name-taken')
  })

  it('a host that the operator maps by hand cannot be claimed', async () => {
    const { t } = table({ reserved: (host) => host === `fixed.${ZONE}` })
    await refused(t.claim(POD_A, 'fixed', { link: LINK_A1 }), 'name-reserved')
  })

  it('a service is a short plain name, or nothing', async () => {
    const { t } = table()
    for (const bad of ['', 'A', 'a b', 'x'.repeat(65), 5, 'a/b']) await refused(t.claim(POD_A, 'app', { link: LINK_A1, service: bad }), 'bad-service')
    assert.equal((await t.claim(POD_A, 'app', { link: LINK_A1, service: 'web-ui.v2' })).service, 'web-ui.v2')
  })
})

describe('a link going down: the hold', () => {
  it('keeps the name for the holder for a while, for nobody else', async () => {
    const { t, clock } = table({ holdMs: 30_000 })
    await t.claim(POD_A, 'app', { link: LINK_A1 })
    t.linkLost(POD_A, LINK_A1)
    assert.deepEqual(t.lookup(`app.${ZONE}`), { peer: POD_A, service: undefined, name: 'app', held: true })
    clock.advance(29_999)
    await refused(t.claim(POD_B, 'app', { link: LINK_B }), 'name-taken')
    assert.equal(t.lookup(`app.${ZONE}`).peer, POD_A)
  })

  it('a pod that comes back with a new link gets its name back at once, whatever else happened', async () => {
    const { t, clock } = table({ holdMs: 30_000 })
    await t.claim(POD_A, 'app', { link: LINK_A1 })
    t.linkLost(POD_A, LINK_A1)
    await refused(t.claim(POD_B, 'app', { link: LINK_B }), 'name-taken') // tries to take it mid-handover
    clock.advance(10_000)
    await t.claim(POD_A, 'app', { link: LINK_A2 })
    assert.equal(t.lookup(`app.${ZONE}`).held, false)
    clock.advance(100_000)
    assert.equal(t.lookup(`app.${ZONE}`).peer, POD_A, 'the hold of the old link does not run out on the new claim')
  })

  it('flapping: every reconnect re-claims, and a stranger never gets in between', async () => {
    const { t } = table({ holdMs: 30_000, claimRate: { limit: 1000, windowMs: 60_000 } })
    let link = {}
    await t.claim(POD_A, 'app', { link })
    for (let i = 0; i < 25; i++) {
      t.linkLost(POD_A, link)
      await refused(t.claim(POD_B, 'app', { link: LINK_B }), 'name-taken')
      link = {}
      await t.claim(POD_A, 'app', { link })
    }
    assert.equal(t.lookup(`app.${ZONE}`).peer, POD_A)
    assert.equal(t.stats().names, 1)
  })

  it('a link that closes late, after the pod came back, takes nothing from the new claim', async () => {
    const { t } = table()
    await t.claim(POD_A, 'app', { link: LINK_A1 })
    await t.claim(POD_A, 'app', { link: LINK_A2 }) // came back on a new link before the old one was seen to close
    t.linkLost(POD_A, LINK_A1)
    assert.equal(t.lookup(`app.${ZONE}`).held, false)
  })

  it('after the hold the name is free: a stranger can have it and the old holder is a stranger', async () => {
    const { t, clock, audits } = table({ holdMs: 30_000 })
    await t.claim(POD_A, 'app', { link: LINK_A1 })
    t.linkLost(POD_A, LINK_A1)
    clock.advance(30_000)
    assert.equal(t.lookup(`app.${ZONE}`), null)
    await t.claim(POD_B, 'app', { link: LINK_B })
    await refused(t.claim(POD_A, 'app', { link: LINK_A2 }), 'name-taken')
    assert.ok(audits.some((r) => r.action === 'expire' && r.pod === POD_A && r.name === 'app'))
  })

  it('a held name still counts against the quotas until it expires', async () => {
    const { t, clock } = table({ maxPerPod: 1, holdMs: 30_000 })
    await t.claim(POD_A, 'app', { link: LINK_A1 })
    t.linkLost(POD_A, LINK_A1)
    await refused(t.claim(POD_A, 'other', { link: LINK_A2 }), 'too-many-names')
    clock.advance(30_000)
    await t.claim(POD_A, 'other', { link: LINK_A2 })
  })

  it('a link closed on purpose gives its names up at once: nothing is held, and nobody is told to wait for the pod', async () => {
    const events = []
    const { t, audits } = table({ holdMs: 30_000, onChange: (e) => events.push(e) })
    await t.claim(POD_A, 'app', { link: LINK_A1 })
    await t.claim(POD_A, 'docs', { link: LINK_A2 }) // another link of the same pod
    t.linkLost(POD_A, LINK_A1, { hold: false })
    assert.equal(t.lookup(`app.${ZONE}`), null)
    assert.equal(t.lookup(`docs.${ZONE}`).held, false, 'only the names of the link that closed')
    assert.deepEqual(events.map((e) => [e.type, e.name]), [['claimed', 'app'], ['claimed', 'docs'], ['released', 'app']])
    assert.ok(audits.some((r) => r.action === 'release' && r.name === 'app'))
    assert.ok(!audits.some((r) => r.action === 'hold'))
    await t.claim(POD_B, 'app', { link: LINK_B }) // free for anybody at once
  })

  it('holdMs 0 frees a name the moment its link goes', async () => {
    const { t } = table({ holdMs: 0 })
    await t.claim(POD_A, 'app', { link: LINK_A1 })
    t.linkLost(POD_A, LINK_A1)
    assert.equal(t.lookup(`app.${ZONE}`), null)
  })

  it('tells a listener when a name is held, so the ingress can wait for the pod', async () => {
    const events = []
    const { t } = table({ onChange: (e) => events.push(e) })
    await t.claim(POD_A, 'app', { link: LINK_A1 })
    t.linkLost(POD_A, LINK_A1)
    assert.deepEqual(events.map((e) => [e.type, e.pod, e.name]), [['claimed', POD_A, 'app'], ['held', POD_A, 'app']])
    assert.ok(events[1].holdMs > 0)
  })
})

describe('audit', () => {
  it('has a line for each claim, refusal, release and hold, with the pod and the name and never a request', async () => {
    const { t, audits } = table()
    await t.claim(POD_A, 'app', { link: LINK_A1 })
    await refused(t.claim(POD_B, 'app', { link: LINK_B }), 'name-taken')
    await refused(t.claim(POD_B, 'www', { link: LINK_B }), 'denied-name')
    t.linkLost(POD_A, LINK_A1)
    t.release(POD_A, 'app')
    assert.deepEqual(audits.map((r) => [r.action, r.pod, r.name, r.reason]), [
      ['claim', POD_A, 'app', undefined], ['refuse', POD_B, 'app', 'name-taken'], ['refuse', POD_B, 'www', 'denied-name'],
      ['hold', POD_A, 'app', undefined], ['release', POD_A, 'app', undefined],
    ])
    for (const r of audits) assert.equal(r.type, 'name')
  })

  it('a sink that throws never breaks a claim', async () => {
    const t = createNameTable({ zone: ZONE, allow: everything, onAudit: () => { throw new Error('sink') } })
    await t.claim(POD_A, 'app', { link: LINK_A1 })
  })
})

describe('the allow function a registry makes', () => {
  it('reads ingress:name:<label>:claim, and the notation\'s wildcard, from a real registry', async () => {
    const { ingress, provider, stranger } = await threePods()
    const allow = registryAllow(ingress.registry)
    assert.equal(allow(provider.podId, 'app'), false)
    ingress.registry.grantCapabilities(provider.podId, ['ingress:name:app:claim'])
    assert.equal(allow(provider.podId, 'app'), true)
    assert.equal(allow(provider.podId, 'other'), false)
    assert.equal(allow(stranger.podId, 'app'), false)
    ingress.registry.grantCapabilities(stranger.podId, ['ingress:name:*:claim'])
    assert.equal(allow(stranger.podId, 'anything'), true)
    ingress.registry.revokeCapabilities(provider.podId, ['ingress:name:app:claim'])
    assert.equal(allow(provider.podId, 'app'), false)
  })
})

// ------------------------------------------------------------------------------------- over the protocol channel
const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

async function rig({ tableOptions = {}, grants = ['ingress:name:app:claim'], protocolGrant = true } = {}) {
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  const clock = clockAt()
  const names = createNameTable({ zone: ZONE, allow: registryAllow(pods.ingress.registry), clock, ...tableOptions })
  const served = serveIngressNames(pods.i, names)
  cleanups.push(() => served.stop())
  if (protocolGrant) pods.ingress.registry.grantCapabilities(pods.provider.podId, [`protocol:${NAMES_PROTOCOL}:open`])
  if (grants.length) pods.ingress.registry.grantCapabilities(pods.provider.podId, grants)
  const open = async (service = pods.p, ingress = pods.ingress.podId) => { const c = await openNameClient(service, ingress); cleanups.push(async () => c.close()); return c }
  return { ...pods, names, clock, served, open }
}

describe('claiming over the protocol channel', () => {
  it('a pod with the channel grant and the name grant claims the name, and the table has it', async () => {
    const t = await rig()
    const client = await t.open()
    assert.deepEqual(await client.claim('app', { service: 'web' }), { name: 'app', host: `app.${ZONE}`, service: 'web' })
    assert.deepEqual(t.names.lookup(`app.${ZONE}`), { peer: t.provider.podId, service: 'web', name: 'app', held: false })
    assert.deepEqual(await client.names(), [{ name: 'app', host: `app.${ZONE}`, service: 'web', held: false }])
  })

  it('the pod is the channel\'s verified peer, never a field a pod sends', async () => {
    const t = await rig()
    const client = await t.open()
    await client.channel.request('claim', { name: 'app', pod: t.stranger.podId })
    assert.equal(t.names.lookup(`app.${ZONE}`).peer, t.provider.podId)
  })

  it('without the channel grant the open is refused and no name is claimed', async () => {
    const t = await rig({ protocolGrant: false })
    await assert.rejects(t.open(), (e) => e.reason === 'not-authorized')
    assert.equal(t.names.stats().names, 0)
  })

  it('a pod with the channel grant but no name grant claims nothing (a pod claiming a name it has no grant for)', async () => {
    const t = await rig({ grants: ['ingress:name:other:claim'] })
    const client = await t.open()
    await assert.rejects(client.claim('app'), (e) => e.reason === 'not-granted')
    assert.equal(t.names.lookup(`app.${ZONE}`), null)
  })

  it('a pod claiming a name another pod holds is refused, and the holder keeps it', async () => {
    const t = await rig({ grants: ['ingress:name:*:claim'] })
    t.ingress.registry.grantCapabilities(t.stranger.podId, [`protocol:${NAMES_PROTOCOL}:open`, 'ingress:name:*:claim'])
    const mine = await t.open()
    await mine.claim('app')
    const theirs = await t.open(t.s)
    await assert.rejects(theirs.claim('app'), (e) => e.reason === 'name-taken')
    assert.equal(t.names.lookup(`app.${ZONE}`).peer, t.provider.podId)
  })

  it('a revoked grant stops the next claim; names already held are not taken back by it', async () => {
    const t = await rig()
    const client = await t.open()
    await client.claim('app')
    t.ingress.registry.revokeCapabilities(t.provider.podId, ['ingress:name:app:claim'])
    await assert.rejects(client.claim('app2'), (e) => e.reason === 'not-granted')
    assert.ok(t.names.lookup(`app.${ZONE}`))
  })

  it('malformed requests are refused as bad requests', async () => {
    const t = await rig()
    const client = await t.open()
    for (const params of [undefined, null, 5, {}, { name: 5 }, { name: 'app', service: 5 }, { name: 'App' }]) {
      await assert.rejects(client.channel.request('claim', params), (e) => ['bad-name', 'bad-request', 'bad-service'].includes(e.reason), JSON.stringify(params))
    }
    await assert.rejects(client.channel.request('nope', {}), (e) => e.code === -32601)
    assert.equal(t.names.stats().names, 0)
  })

  it('a flood of claims over one channel is cut off by the rate limit', async () => {
    const t = await rig({ tableOptions: { claimRate: { limit: 4, windowMs: 60_000 } } })
    const client = await t.open()
    const reasons = []
    for (let i = 0; i < 8; i++) reasons.push(await client.claim('app').then(() => 'ok', (e) => e.reason))
    assert.deepEqual(reasons.filter((r) => r === 'claim-rate').length > 0, true)
    assert.equal(reasons[0], 'ok')
    assert.equal(t.names.stats().names, 1)
  })

  it('a pod that leaves holds its name for a while; one that comes back on a new channel has it back; a stranger never does', async () => {
    const t = await rig({ grants: ['ingress:name:*:claim'] })
    t.ingress.registry.grantCapabilities(t.stranger.podId, [`protocol:${NAMES_PROTOCOL}:open`, 'ingress:name:*:claim'])
    const first = await t.open()
    await first.claim('app')
    first.channel.close() // the channel is gone without a goodbye: the same as a link that dropped
    await until(() => t.names.lookup(`app.${ZONE}`)?.held === true, 'the name to be held')
    const other = await t.open(t.s)
    await assert.rejects(other.claim('app'), (e) => e.reason === 'name-taken')
    const second = await t.open()
    await second.claim('app')
    assert.equal(t.names.lookup(`app.${ZONE}`).held, false)
    t.clock.advance(1_000_000)
    assert.equal(t.names.lookup(`app.${ZONE}`).peer, t.provider.podId)
  })

  it('release frees the name and the channel stays usable', async () => {
    const t = await rig()
    const client = await t.open()
    await client.claim('app')
    assert.deepEqual(await client.release('app'), { released: true })
    assert.deepEqual(await client.release('app'), { released: false })
    assert.equal(t.names.lookup(`app.${ZONE}`), null)
    await client.claim('app')
  })

  it('closing the client says goodbye: its names are given up at once, not held, and nobody is made to wait for the pod', async () => {
    const t = await rig({ grants: ['ingress:name:*:claim'] })
    const changes = []
    t.names.subscribe((e) => changes.push(e.type))
    const client = await t.open()
    await client.claim('app')
    await client.claim('docs')
    await client.close()
    assert.equal(t.names.lookup(`app.${ZONE}`), null)
    assert.equal(t.names.lookup(`docs.${ZONE}`), null)
    assert.equal(client.channel.closed, true)
    await until(() => !changes.includes('held'), 'no hold')
    assert.deepEqual(changes, ['claimed', 'claimed', 'released', 'released'])
    assert.equal(t.names.stats().names, 0)
  })

  it('a goodbye over a channel that other names were claimed on by another pod touches only this pod\'s names', async () => {
    const t = await rig({ grants: ['ingress:name:*:claim'] })
    t.ingress.registry.grantCapabilities(t.stranger.podId, [`protocol:${NAMES_PROTOCOL}:open`, 'ingress:name:*:claim'])
    const mine = await t.open()
    const theirs = await t.open(t.s)
    await mine.claim('app')
    await theirs.claim('docs')
    await mine.close()
    assert.equal(t.names.lookup(`app.${ZONE}`), null)
    assert.equal(t.names.lookup(`docs.${ZONE}`).peer, t.stranger.podId)
  })

  it('an older client\'s close (no bye, the reason `done`) is read as a goodbye too; any other reason is a lost channel', async () => {
    const t = await rig({ grants: ['ingress:name:*:claim'] })
    const old = await t.open()
    await old.claim('app')
    old.channel.close('done')
    await until(() => t.names.lookup(`app.${ZONE}`) === null, 'the name to be given up')
    const other = await t.open()
    await other.claim('docs')
    other.channel.close('network lost')
    await until(() => t.names.lookup(`docs.${ZONE}`)?.held === true, 'the name to be held')
  })

  it('bye is a request of its own: it gives up what this channel claimed and the channel stays usable', async () => {
    const t = await rig()
    const client = await t.open()
    await client.claim('app')
    assert.deepEqual(await client.channel.request('bye', {}), { released: ['app'] })
    assert.equal(t.names.lookup(`app.${ZONE}`), null)
    assert.deepEqual(await client.channel.request('bye', {}), { released: [] })
    await client.claim('app')
  })

  it('an ingress that does not know bye: closing the client still closes the channel, with the reason the older ingress reads as a goodbye', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    pods.ingress.registry.grantCapabilities(pods.provider.podId, [`protocol:${NAMES_PROTOCOL}:open`])
    const seen = {}
    pods.i.api.serveProtocol(NAMES_PROTOCOL, (channel) => { channel.onClose(() => { seen.reason = channel.remoteReason }) }, { versions: [1] })
    const client = await openNameClient(pods.p, pods.ingress.podId)
    await client.close()
    assert.equal(client.channel.closed, true)
    await until(() => seen.reason !== undefined, 'the other end to see the close')
    assert.equal(seen.reason, 'done')
  })

  it('an ingress that never answers bye cannot hold the pod up: the close gives up after closeTimeoutMs', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    pods.ingress.registry.grantCapabilities(pods.provider.podId, [`protocol:${NAMES_PROTOCOL}:open`])
    pods.i.api.serveProtocol(NAMES_PROTOCOL, (channel) => { channel.onRequest('bye', () => new Promise(() => {})) }, { versions: [1] })
    const client = await openNameClient(pods.p, pods.ingress.podId, { closeTimeoutMs: 25 })
    await client.close()
    assert.equal(client.channel.closed, true)
    await client.close() // closing twice is fine
  })

  it('an ingress that predates names: the pod learns it, and nothing else changes', async () => {
    const pods = await threePods() // no serveIngressNames on the ingress
    cleanups.push(() => pods.teardown())
    pods.ingress.registry.grantCapabilities(pods.provider.podId, [`protocol:${NAMES_PROTOCOL}:open`])
    await assert.rejects(openNameClient(pods.p, pods.ingress.podId), (e) => ['unknown-protocol', 'unsupported'].includes(e.reason) || e.code === -32601)
  })
})

describe('a claimed name serves requests', () => {
  it('end to end: the pod claims a name, the ingress answers for it from the pod, and a released name is a 404', async () => {
    const t = await rig()
    const served = serveHttpOnMesh(t.p, (request) => new Response(`hello ${new URL(request.url).host}`), { allowFrom: [t.ingress.podId] })
    cleanups.push(() => served.stop())
    grantHttp(t)
    const mesh = createMeshIngress({
      service: t.i,
      resolve: (request) => { const hit = t.names.lookup(new URL(request.url).host); return hit ? { peer: hit.peer } : null },
    })
    cleanups.push(() => mesh.close())
    const client = await t.open()
    await client.claim('app')
    const res = await mesh.handle(new Request(`http://app.${ZONE}/x`))
    assert.equal(res.status, 200)
    assert.equal(await res.text(), `hello app.${ZONE}`)
    await client.release('app')
    assert.equal((await mesh.handle(new Request(`http://app.${ZONE}/x`))).status, 404)
  })
})
