// Tearing a pod down while a request is in flight (README, "Closing a pod: the order"): the visitor is answered promptly with
// a named failure, and a pod may give the requests it is answering a grace of its own choosing first.
//
// In-process, on the in-memory bus, with a link that can be cut: what the pod has not yet sent when its node is closed never
// leaves (a real transport behaves so), which is what makes the order of the steps matter.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  NAMES_PROTOCOL, createMeshIngress, createNameTable, openNameClient, registryAllow, serveHttpOnMesh, serveIngressNames,
} from '../src/index.mjs'
import { REASON_HEADER } from '../src/errors.mjs'
import { threePods, grantHttp, deferred, until } from './helpers/mesh.mjs'

const ZONE = 'pods.example.test'
const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

/** `promise`, or `'hung'` after `ms`: a failure detector only (a passing run never waits for it), not a timing assertion. */
const orHung = (promise, ms = 2_000) => Promise.race([promise, new Promise((resolve) => { const t = setTimeout(() => resolve('hung'), ms); t.unref() })])

async function rig({ names = true, handler, serve = {} } = {}) {
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  // The pod's link: each frame takes a turn of the event loop to leave, and once the link is `cut` nothing leaves any more.
  const link = { cut: false, sent: [] }
  const send = pods.provider.sendTo.bind(pods.provider)
  pods.provider.sendTo = async (to, data) => { await new Promise((r) => setTimeout(r, 5)); if (link.cut) return; link.sent.push(data); return send(to, data) }
  const arrived = []
  const release = deferred() // the slow origin answers when the test says so
  const served = serveHttpOnMesh(pods.p, handler ?? (async (request) => {
    const path = new URL(request.url).pathname
    arrived.push(path)
    if (path === '/slow') await release.promise
    return new Response(`answered ${path}`)
  }), { allowFrom: [pods.ingress.podId], ...serve })
  cleanups.push(() => served.stop())
  grantHttp(pods)
  let table
  let client
  if (names) {
    pods.ingress.registry.grantCapabilities(pods.provider.podId, [`protocol:${NAMES_PROTOCOL}:open`, 'ingress:name:*:claim'])
    table = createNameTable({ zone: ZONE, allow: registryAllow(pods.ingress.registry) })
    const namesServed = serveIngressNames(pods.i, table)
    cleanups.push(() => namesServed.stop())
  }
  const mesh = createMeshIngress({
    service: pods.i,
    ...(names ? { names: table } : { resolve: () => ({ peer: pods.provider.podId }) }),
    limits: { timeoutMs: 20_000 },
  })
  cleanups.push(() => mesh.close())
  if (names) { client = await openNameClient(pods.p, pods.ingress.podId); await client.claim('app') }
  const get = async (path = '/slow') => {
    const res = await mesh.handle(new Request(`http://app.${ZONE}${path}`))
    return { status: res.status, reason: res.headers.get(REASON_HEADER), text: await res.text() }
  }
  return { ...pods, link, mesh, served, client, release, arrived, get }
}

describe('a pod torn down while a request is in flight', () => {
  it('the documented order (goodbye, services, node): the visitor is answered at once, naming the failure', async () => {
    const t = await rig()
    const answer = t.get()
    await until(() => t.arrived.length === 1, 'the request to reach the pod')
    await t.client.close()
    await t.served.stop()
    t.link.cut = true // the node closes: nothing the pod has not sent leaves
    t.p.teardown()
    const r = await orHung(answer)
    assert.notEqual(r, 'hung', 'the request was still waiting after the pod was gone')
    assert.equal(r.status, 502)
    assert.equal(r.reason, 'provider-closed')
  })

  it('stop() resolves once the channels\' close notices have left the pod, not before', async () => {
    const t = await rig({ names: false })
    assert.equal((await t.get('/fast')).status, 200) // a channel is open
    const before = t.link.sent.length
    await t.served.stop()
    assert.ok(t.link.sent.length > before, 'a close notice was sent')
    const text = t.link.sent.slice(before).map((f) => (typeof f.f === 'string' ? Buffer.from(f.f, 'base64').toString('latin1') : '')).join('\n')
    assert.match(text, /mesh\.protocol\.close/, 'the notice is the close of a protocol channel')
    assert.match(text, /http/, 'of the http channel')
  })

  it('without a grace, stop() ends what is in flight at once (the default is unchanged)', async () => {
    const t = await rig({ names: false })
    const answer = t.get()
    await until(() => t.arrived.length === 1, 'the request to reach the pod')
    await t.served.stop()
    const r = await orHung(answer)
    assert.notEqual(r, 'hung')
    assert.deepEqual([r.status, r.reason], [502, 'provider-closed'])
  })
})

describe('the names client\'s goodbye', () => {
  it('close() resolves once the closing of its channel has left the pod too, so the node can be closed straight after', async () => {
    const t = await rig()
    const before = t.link.sent.length
    await t.client.close()
    const text = t.link.sent.slice(before).map((f) => (typeof f.f === 'string' ? Buffer.from(f.f, 'base64').toString('latin1') : '')).join('\n')
    assert.match(text, /bye/, 'the goodbye request left')
    assert.match(text, /mesh\.protocol\.close/, 'and so did the close of the channel, with its reason')
    assert.match(text, /done/)
  })
})

describe('stop({ graceMs }): what is being answered may finish first', () => {
  it('a request in flight is answered whole, a request that arrives meanwhile is told the pod is stopping, then the channels close', async () => {
    const t = await rig({ names: false })
    const answer = t.get('/slow')
    await until(() => t.arrived.length === 1, 'the request to reach the pod')
    const stopping = t.served.stop({ graceMs: 60_000 })
    let done = false
    stopping.then(() => { done = true })
    const late = await orHung(t.get('/fast'))
    assert.notEqual(late, 'hung')
    assert.deepEqual([late.status, late.reason], [503, 'provider-stopping'])
    assert.equal(t.arrived.length, 1, 'the handler never saw the late request')
    assert.equal(done, false, 'stop() waits for the request that is being answered')
    t.release.resolve()
    const r = await orHung(answer)
    assert.notEqual(r, 'hung')
    assert.deepEqual([r.status, r.text], [200, 'answered /slow'])
    await orHung(stopping)
    assert.equal(done, true)
    assert.equal(t.served.stats().open, 0, 'every channel is closed')
  })

  it('a request still being answered when the grace runs out is ended, with the same named failure as an immediate stop', async () => {
    const t = await rig({ names: false })
    const answer = t.get('/slow')
    await until(() => t.arrived.length === 1, 'the request to reach the pod')
    await t.served.stop({ graceMs: 20 }) // never released: the grace runs out
    const r = await orHung(answer)
    assert.notEqual(r, 'hung')
    assert.deepEqual([r.status, r.reason], [502, 'provider-closed'])
  })

  it('with nothing in flight the grace is not waited for', async () => {
    const t = await rig({ names: false })
    assert.equal((await t.get('/fast')).status, 200)
    const out = await orHung(t.served.stop({ graceMs: 3_600_000 }))
    assert.notEqual(out, 'hung')
    assert.equal(t.served.stats().open, 0)
  })

  it('graceMs is a non-negative integer, and a second stop() is the same stop', async () => {
    const t = await rig({ names: false })
    for (const graceMs of [-1, 1.5, '5', NaN, Infinity]) assert.throws(() => t.served.stop({ graceMs }), TypeError, String(graceMs))
    const first = t.served.stop()
    assert.equal(await first, undefined)
    assert.equal(await t.served.stop(), undefined)
  })

})
