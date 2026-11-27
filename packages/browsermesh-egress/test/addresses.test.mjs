// Item 2 of #379: a guest OS connects by the ADDRESS its lookup returned, and a grant for a NAME does not cover an address.
//
// Provider side (`connectByResolvedAddress`, off by default): for each consumer link the provider remembers which addresses ITS OWN
// lookup returned for a name the consumer holds a `dns` grant for, for a bounded time and count, and takes a `connect` to such an
// address as a connect to that name under the name's TCP grant. The connection goes to the address the provider resolved (the dial
// is the checked one, and no second lookup happens). Consumer side (`mapAddresses`, off by default): the link remembers what its own
// lookups returned and, when a provider refuses an address, asks for the name instead.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { connectEgress, createMeshEgress, EgressError, EGRESS_SCOPES, EGRESS_LIMIT_DEFAULTS } from '../src/index.mjs'
import { createAddressMemory } from '../src/address-memory.mjs'
import { rig, grant, bytes, text, readAll, rawChannel, PUBLIC } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
const code = (c) => (e) => e instanceof EgressError && e.code === c
const B = '93.184.216.50'
const C = '93.184.216.51'
const D = '93.184.216.52'

/** pkg.test -> PUBLIC (granted for dns and tcp:443); each origin is the one echo origin. */
const boot = ({ names = { 'pkg.test': [PUBLIC] }, grants = [EGRESS_SCOPES.dns('pkg.test'), EGRESS_SCOPES.tcp('pkg.test', 443)], on = true, egress = {}, link = {} } = {}) => rig(cleanups, {
  names,
  grants,
  egress: () => ({ ...(on ? { connectByResolvedAddress: true } : {}), ...egress }),
  link,
})

async function echoes(socket) {
  await socket.write(bytes('ping'))
  assert.equal(text(await socket.read()), 'ping')
  await socket.end()
  await readAll(socket)
}

const refusals = (r) => r.audit.filter((a) => a.event === 'egress-refused')

describe('the memory: bounded in time and in count, newest first', () => {
  it('remembers address -> names, forgets after ttlMs, and drops the oldest past maxEntries', () => {
    let t = 1000
    const memory = createAddressMemory({ ttlMs: 100, maxEntries: 3, now: () => t })
    memory.remember('a.test', ['1.1.1.1', '1.1.1.2'])
    assert.deepEqual(memory.namesFor('1.1.1.1'), ['a.test'])
    memory.remember('b.test', ['1.1.1.1'])
    assert.deepEqual(memory.namesFor('1.1.1.1'), ['b.test', 'a.test'], 'most recently looked up first')
    assert.equal(memory.size, 3)
    memory.remember('c.test', ['1.1.1.3'])
    assert.equal(memory.size, 3, 'never more than maxEntries pairs')
    assert.deepEqual(memory.namesFor('1.1.1.1'), ['b.test'], 'the oldest pair went first')
    assert.deepEqual(memory.namesFor('1.1.1.2'), ['a.test'])
    t += 101
    assert.deepEqual(memory.namesFor('1.1.1.1'), [])
    assert.equal(memory.size, 0, 'expired pairs are not held')
  })

  it('a new lookup of the same name renews it and does not count twice', () => {
    let t = 0
    const memory = createAddressMemory({ ttlMs: 100, maxEntries: 5, now: () => t })
    memory.remember('a.test', ['1.1.1.1'])
    t = 90
    memory.remember('a.test', ['1.1.1.1'])
    t = 150
    assert.deepEqual(memory.namesFor('1.1.1.1'), ['a.test'])
    assert.equal(memory.size, 1)
  })

  it('refuses nonsense it is given', () => {
    assert.throws(() => createAddressMemory({ ttlMs: 0, maxEntries: 1 }), TypeError)
    assert.throws(() => createAddressMemory({ ttlMs: 1, maxEntries: 0 }), TypeError)
    // A clock the test holds: with the real clock and a 10 ms ttl, a scheduler stall between remember() and namesFor() expires the entry.
    const memory = createAddressMemory({ ttlMs: 10, maxEntries: 2, now: () => 0 })
    memory.remember('a.test', ['not an address', 5, '1.1.1.1'])
    assert.deepEqual(memory.namesFor('1.1.1.1'), ['a.test'])
    assert.equal(memory.size, 1)
  })
})

describe('provider: a connect to an address its own lookup returned is a connect to that name', () => {
  it('lookup, then connect by the address: it opens, to the address the provider resolved, with no second lookup', async () => {
    const r = await boot()
    assert.deepEqual(await r.link.lookup('pkg.test'), [PUBLIC])
    const socket = await r.link.connect(PUBLIC, 443)
    await echoes(socket)
    assert.equal(r.net.calls.lookups.filter((n) => n === 'pkg.test').length, 1, 'the one lookup was the consumer\'s lookup')
    assert.deepEqual(r.net.calls.dials.at(-1), { host: PUBLIC, port: 443, wide: false }, 'the dial is given the resolved address itself')
    const open = r.audit.find((a) => a.event === 'egress-open')
    assert.equal(open.host, PUBLIC)
    assert.equal(open.address, PUBLIC)
    assert.equal(open.via, 'resolved-name')
    assert.equal(open.name, 'pkg.test')
  })

  it('off by default: the same connect is no-grant, as in 0.2.0', async () => {
    const r = await boot({ on: false })
    await r.link.lookup('pkg.test')
    await assert.rejects(r.link.connect(PUBLIC, 443), code('no-grant'))
  })

  it('without a lookup first there is nothing to take the address for: no-grant', async () => {
    const r = await boot()
    await assert.rejects(r.link.connect(PUBLIC, 443), code('no-grant'))
  })

  it('a name the consumer has no TCP grant for gives nothing: the address of a DNS-only name is no-grant', async () => {
    const r = await boot({ names: { 'pkg.test': [PUBLIC], 'other.test': [B] }, grants: [EGRESS_SCOPES.dns('pkg.test'), EGRESS_SCOPES.dns('other.test'), EGRESS_SCOPES.tcp('pkg.test', 443)] })
    assert.deepEqual(await r.link.lookup('other.test'), [B])
    await assert.rejects(r.link.connect(B, 443), code('no-grant'))
  })

  it('only the granted port: an address remembered for a name is not reachable on another port', async () => {
    const r = await boot()
    await r.link.lookup('pkg.test')
    await assert.rejects(r.link.connect(PUBLIC, 22), code('no-grant'))
    await assert.rejects(r.link.connect(PUBLIC, 8443), code('no-grant'))
  })

  it('a port-wide grant for the name covers its ports, but not a blocked one', async () => {
    const wide = await boot({ grants: [EGRESS_SCOPES.dns('pkg.test'), EGRESS_SCOPES.tcpAnyPort('pkg.test')] })
    await wide.link.lookup('pkg.test')
    await assert.rejects(wide.link.connect(PUBLIC, 25), code('port-blocked'))
    await assert.rejects(wide.link.connect(PUBLIC, 8080), code('connect-failed'), 'granted, and nothing listens there: it got as far as the dial')
    await echoes(await wide.link.connect(PUBLIC, 443))
  })

  it('a set grant: the address of a name the set lists is admitted under the set', async () => {
    const r = await boot({ grants: [EGRESS_SCOPES.dns('pkg.test'), EGRESS_SCOPES.set('registries')], egress: { sets: { registries: ['pkg.test:443'] } } })
    await r.link.lookup('pkg.test')
    await echoes(await r.link.connect(PUBLIC, 443))
  })

  it('an address two names returned is taken as the granted one, and as that one only', async () => {
    const r = await boot({
      names: { 'ungranted.test': [PUBLIC], 'pkg.test': [PUBLIC] },
      grants: [EGRESS_SCOPES.dns('ungranted.test'), EGRESS_SCOPES.dns('pkg.test'), EGRESS_SCOPES.tcp('pkg.test', 443)],
    })
    await r.link.lookup('pkg.test')
    await r.link.lookup('ungranted.test')
    await echoes(await r.link.connect(PUBLIC, 443))
    assert.equal(r.audit.find((a) => a.event === 'egress-open').name, 'pkg.test')
    await assert.rejects(r.link.connect(PUBLIC, 22), code('no-grant'))
  })

  it('it is per consumer link: what one consumer looked up is nothing to another', async () => {
    const r = await boot({ link: false })
    // the stranger holds the same grants, and never looked anything up
    r.pods.provider.registry.grantCapabilities(r.pods.stranger.podId, ['protocol:egress:open', EGRESS_SCOPES.dns('pkg.test'), EGRESS_SCOPES.tcp('pkg.test', 443)])
    const mine = await connectEgress(r.pods.c, r.pods.provider.podId)
    cleanups.push(() => mine.close())
    const theirs = await connectEgress(r.pods.s, r.pods.provider.podId)
    cleanups.push(() => theirs.close())
    await mine.lookup('pkg.test')
    await echoes(await mine.connect(PUBLIC, 443))
    await assert.rejects(theirs.connect(PUBLIC, 443), code('no-grant'))
  })

  it('what a consumer cannot do: name a mapping itself (extra fields on the request mean nothing)', async () => {
    const r = await boot({ link: false })
    const channel = await rawChannel(r.pods)
    const answer = await channel.request('connect', { cid: 1, host: PUBLIC, port: 443, hops: 0, name: 'pkg.test', via: 'resolved-name', resolved: { [PUBLIC]: 'pkg.test' } })
    assert.deepEqual(answer, { ok: false, code: 'no-grant' })
  })

  it('a lookup that failed or was refused remembers nothing', async () => {
    const r = await boot({ names: { 'pkg.test': [PUBLIC], 'priv.test': ['10.0.0.5'] }, grants: [EGRESS_SCOPES.dns('pkg.test'), EGRESS_SCOPES.dns('priv.test'), EGRESS_SCOPES.tcp('priv.test', 443)] })
    await assert.rejects(r.link.lookup('priv.test'), code('destination-refused'))
    await assert.rejects(r.link.connect('10.0.0.5', 443), code('no-grant'))
    await assert.rejects(r.link.lookup('missing.test'), code('no-grant'))
    await assert.rejects(r.link.connect(PUBLIC, 443), code('no-grant'))
  })
})

describe('provider: what it takes to keep the address, and what ends it', () => {
  it('after addressMemoryMs the address is no longer taken for the name, and a new lookup renews it', async () => {
    let t = 1_000_000
    const r = await boot({ egress: { clock: { now: () => t }, limits: { addressMemoryMs: 60_000 } } })
    await r.link.lookup('pkg.test')
    t += 59_000
    await echoes(await r.link.connect(PUBLIC, 443))
    t += 2_000
    await assert.rejects(r.link.connect(PUBLIC, 443), code('no-grant'))
    await r.link.lookup('pkg.test')
    await echoes(await r.link.connect(PUBLIC, 443))
  })

  it('at most maxRememberedAddresses addresses per link: the oldest lookup is forgotten first', async () => {
    const names = { 'a.test': [PUBLIC], 'b.test': [B], 'c.test': [C] }
    const r = await boot({
      names,
      grants: Object.keys(names).flatMap((n) => [EGRESS_SCOPES.dns(n), EGRESS_SCOPES.tcp(n, 443)]),
      egress: { limits: { maxRememberedAddresses: 2 } },
    })
    for (const n of Object.keys(names)) await r.link.lookup(n)
    await assert.rejects(r.link.connect(PUBLIC, 443), code('no-grant'))
    // the two newest are still taken (nothing listens on B and C: the answer is that the connection was tried)
    await assert.rejects(r.link.connect(B, 443), code('connect-failed'))
    await assert.rejects(r.link.connect(C, 443), code('connect-failed'))
  })

  it('revoking the DNS grant or the TCP grant ends the address path at once', async () => {
    const r = await boot()
    await r.link.lookup('pkg.test')
    await echoes(await r.link.connect(PUBLIC, 443))
    r.pods.provider.registry.revokeCapabilities(r.pods.consumer.podId, [EGRESS_SCOPES.dns('pkg.test')])
    await assert.rejects(r.link.connect(PUBLIC, 443), code('no-grant'))
    r.pods.provider.registry.grantCapabilities(r.pods.consumer.podId, [EGRESS_SCOPES.dns('pkg.test')])
    await r.link.lookup('pkg.test')
    await echoes(await r.link.connect(PUBLIC, 443))
    r.pods.provider.registry.revokeCapabilities(r.pods.consumer.podId, [EGRESS_SCOPES.tcp('pkg.test', 443)])
    await assert.rejects(r.link.connect(PUBLIC, 443), code('no-grant'))
  })

  it('a connection opened this way ends revoked when the name\'s TCP grant is revoked', async () => {
    const r = await boot()
    await r.link.lookup('pkg.test')
    const socket = await r.link.connect(PUBLIC, 443)
    r.pods.provider.registry.revokeCapabilities(r.pods.consumer.podId, [EGRESS_SCOPES.tcp('pkg.test', 443)])
    r.provider.recheck()
    let failure
    try { for (;;) { if ((await socket.read()) === null) break } } catch (e) { failure = e }
    assert.ok(failure instanceof EgressError && failure.code === 'connection-ended' && failure.reason === 'revoked')
  })

  it('the operator\'s veto is asked about the name as well as the address, and the budgets and blocked ports apply as to any connect', async () => {
    const asked = []
    const denied = new Set()
    const r = await boot({ egress: { deny: ({ host }) => { asked.push(host); return denied.has(host) } } })
    await r.link.lookup('pkg.test')
    denied.add('pkg.test') // the operator vetoes the name after the lookup was answered
    await assert.rejects(r.link.connect(PUBLIC, 443), code('destination-refused'))
    assert.ok(asked.includes('pkg.test') && asked.includes(PUBLIC), `asked ${asked}`)
    const veto = await boot({ egress: { deny: ({ host }) => host === PUBLIC } })
    await veto.link.lookup('pkg.test')
    await assert.rejects(veto.link.connect(PUBLIC, 443), code('destination-refused'))
  })

  it('the address guard applies as ever: the address is dialled through the same checked dial, and a refusal there is a refusal', async () => {
    let seen
    const refusingDial = async (request) => { seen = request; const e = new Error('refused'); e.code = 'ADDRESS_REFUSED'; e.refused = [{ class: 'private' }]; throw e }
    const r = await boot({ egress: { dial: refusingDial } })
    await r.link.lookup('pkg.test')
    await assert.rejects(r.link.connect(PUBLIC, 443), (e) => e.code === 'destination-refused' && e.addressClass === 'private')
    assert.deepEqual({ host: seen.host, port: seen.port, wide: seen.wide }, { host: PUBLIC, port: 443, wide: false })
  })

  it('a wildcard-grant holder is not helped or hindered: wide mode still decides', async () => {
    const r = await boot({ grants: [EGRESS_SCOPES.dns('pkg.test'), 'egress:tcp:*:*:connect'] })
    await r.link.lookup('pkg.test')
    await assert.rejects(r.link.connect(PUBLIC, 443), code('wide-not-acknowledged'))
  })
})

describe('the limits are the ones the README names', () => {
  it('the defaults, and that a limit must be a positive whole number', () => {
    assert.equal(EGRESS_LIMIT_DEFAULTS.addressMemoryMs, 10 * 60_000)
    assert.equal(EGRESS_LIMIT_DEFAULTS.maxRememberedAddresses, 256)
    assert.throws(() => createMeshEgress({ service: { openProtocol() {}, serveProtocol() {} }, registry: { checkAccess() {} }, dial: async () => {}, resolve: async () => {}, limits: { addressMemoryMs: 0 } }), /addressMemoryMs/)
    assert.throws(() => createMeshEgress({ service: { serveProtocol() {} }, registry: { checkAccess() {} }, dial: async () => {}, resolve: async () => {}, connectByResolvedAddress: 'yes' }), /connectByResolvedAddress/)
  })
})

describe('consumer: mapAddresses (works with any provider, 0.1.1 and 0.2.0 included)', () => {
  it('off by default: an address the provider refuses stays refused', async () => {
    const r = await boot({ on: false })
    await r.link.lookup('pkg.test')
    await assert.rejects(r.link.connect(PUBLIC, 443), code('no-grant'))
  })

  it('a provider that does not take addresses refuses; the link then asks for the name it looked up, once, and remembers that this provider needs it', async () => {
    const r = await boot({ on: false, link: { mapAddresses: true } })
    assert.deepEqual(await r.link.lookup('pkg.test'), [PUBLIC])
    await echoes(await r.link.connect(PUBLIC, 443))
    assert.equal(refusals(r).length, 1, 'one refused attempt, then the name')
    assert.equal(r.audit.find((a) => a.event === 'egress-open').host, 'pkg.test')
    await echoes(await r.link.connect(PUBLIC, 443))
    assert.equal(refusals(r).length, 1, 'the second connect went straight to the name')
    assert.equal(r.net.calls.lookups.filter((n) => n === 'pkg.test').length >= 3, true)
  })

  it('a provider that takes addresses: the address goes first and is the one dialled, no name is asked for', async () => {
    const r = await boot({ on: true, link: { mapAddresses: true } })
    await r.link.lookup('pkg.test')
    await echoes(await r.link.connect(PUBLIC, 443))
    assert.equal(refusals(r).length, 0)
    assert.equal(r.audit.find((a) => a.event === 'egress-open').via, 'resolved-name')
  })

  it('an address this link never looked up is passed on as it is, and refused as it is', async () => {
    const r = await boot({ on: false, link: { mapAddresses: true } })
    await assert.rejects(r.link.connect(B, 443), code('no-grant'))
    assert.equal(refusals(r).length, 1)
  })

  it('only no-grant leads to the name: another refusal, or another port the name has no grant for, is the answer', async () => {
    const r = await boot({ on: false, link: { mapAddresses: true } })
    await r.link.lookup('pkg.test')
    await assert.rejects(r.link.connect(PUBLIC, 25), code('no-grant'), 'the name\'s port 25 is not granted either')
    await assert.rejects(r.link.connect(PUBLIC, 8443), code('no-grant'))
  })

  it('a refusal that is not no-grant is the answer: the name is not tried (a connect that failed is not retried by name)', async () => {
    const r = await boot({ on: true, grants: [EGRESS_SCOPES.dns('pkg.test'), EGRESS_SCOPES.tcpAnyPort('pkg.test')], link: { mapAddresses: true } })
    await r.link.lookup('pkg.test')
    await assert.rejects(r.link.connect(PUBLIC, 8080), code('connect-failed'), 'granted, and nothing listens: it was dialled')
    assert.equal(r.net.calls.dials.length, 1, 'one dial: the address, and not the name after it')
    await assert.rejects(r.link.connect(PUBLIC, 25), code('port-blocked'))
    assert.equal(r.net.calls.dials.length, 1)
  })

  it('the map is bounded: maxEntries (its expiry is the memory\'s, tested above)', async () => {
    const r = await boot({
      on: false, names: { 'pkg.test': [PUBLIC], 'two.test': [B] }, grants: [EGRESS_SCOPES.dns('pkg.test'), EGRESS_SCOPES.dns('two.test')],
      link: { mapAddresses: { ttlMs: 60_000, maxEntries: 1 } },
    })
    await r.link.lookup('pkg.test')
    assert.deepEqual(r.link.namesFor(PUBLIC), ['pkg.test'])
    await r.link.lookup('two.test')
    assert.deepEqual(r.link.namesFor(PUBLIC), [])
    assert.deepEqual(r.link.namesFor(B), ['two.test'])
  })

  it('the helper is exported for a consumer that routes by itself', () => {
    const memory = createAddressMemory({ ttlMs: 1000, maxEntries: 8 })
    memory.remember('pkg.test', [PUBLIC])
    assert.deepEqual(memory.namesFor(PUBLIC), ['pkg.test'])
  })

  it('a link without mapAddresses has no map to ask', async () => {
    const r = await boot({ on: false })
    await r.link.lookup('pkg.test')
    assert.deepEqual(r.link.namesFor(PUBLIC), [])
  })
})
