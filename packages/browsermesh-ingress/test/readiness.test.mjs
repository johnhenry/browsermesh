// A request for a pod whose link is still being made waits, bounded, instead of failing; readiness says when the routes are
// live; a name in its hold waits for its pod. Nothing changes for a pod the ingress was not told to expect.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  NAMES_PROTOCOL, createMeshIngress, createNameTable, openNameClient, registryAllow, serveHttpOnMesh, serveIngressNames,
} from '../src/index.mjs'
import { listenNode } from '../src/node.mjs'
import { REASON_HEADER } from '../src/errors.mjs'
import { threePods, grantHttp, until } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

async function rig({ serve = true, ingress = {} } = {}) {
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  const startProvider = () => {
    const served = serveHttpOnMesh(pods.p, () => new Response('up'), { allowFrom: [pods.ingress.podId] })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    return served
  }
  const served = serve ? startProvider() : null
  const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }), ...ingress })
  cleanups.push(() => mesh.close())
  const get = async (path = '/') => { const res = await mesh.handle(new Request(`http://app.example.test${path}`)); return { status: res.status, reason: res.headers.get(REASON_HEADER), text: await res.text() } }
  // What reached the provider pod: lets a test start the provider only after the ingress has really tried it and found it not serving.
  const inbound = []
  pods.provider.onIncomingData(() => { inbound.push(1) })
  const afterNextAttempt = async () => { const seen = inbound.length; await until(() => inbound.length > seen, 'the ingress to try the pod'); await new Promise((r) => setImmediate(r)) }
  return { ...pods, mesh, served, startProvider, get, afterNextAttempt }
}

describe('expecting a pod', () => {
  it('dials it before any request, and readiness says when it is up', async () => {
    const t = await rig()
    assert.deepEqual(t.mesh.readiness(), { ready: true, peers: { up: 0, total: 0 } })
    t.mesh.expect(t.provider.podId, { retryMs: 5 })
    assert.equal(t.mesh.readiness().ready, false)
    assert.equal(await t.mesh.whenReady({ timeoutMs: 10_000 }), true)
    assert.deepEqual(t.mesh.readiness(), { ready: true, peers: { up: 1, total: 1 } })
    assert.equal(t.mesh.stats().providers, 1)
    assert.equal(t.mesh.stats().requests, 0)
  })

  it('readiness is not ready while a pod is not serving, and becomes ready when it starts', async () => {
    const t = await rig({ serve: false })
    t.mesh.expect(t.provider.podId, { retryMs: 5 })
    assert.equal(await t.mesh.whenReady({ timeoutMs: 30 }), false)
    assert.deepEqual(t.mesh.readiness(), { ready: false, peers: { up: 0, total: 1 } })
    t.startProvider()
    assert.equal(await t.mesh.whenReady({ timeoutMs: 10_000 }), true)
  })

  it('readiness never says which pods', async () => {
    const t = await rig()
    t.mesh.expect(t.provider.podId, { retryMs: 5 })
    await t.mesh.whenReady({ timeoutMs: 10_000 })
    assert.doesNotMatch(JSON.stringify(t.mesh.readiness()), new RegExp(t.provider.podId))
  })

  it('takes only pod ids and sane times', async () => {
    const t = await rig()
    for (const bad of ['has space', '', 5, null]) assert.throws(() => t.mesh.expect(bad), TypeError)
    assert.throws(() => t.mesh.expect(t.provider.podId, { graceMs: -1 }), TypeError)
    assert.throws(() => t.mesh.expect(t.provider.podId, { retryMs: 0 }), TypeError)
  })
})

describe('a request while the link is being made', () => {
  it('waits for it and is answered, instead of a 502 (the first request after the ingress starts)', async () => {
    const t = await rig({ serve: false })
    t.mesh.expect(t.provider.podId, { retryMs: 5 })
    const attempt = t.afterNextAttempt()
    const answered = t.get()
    await attempt
    t.startProvider() // the pod is up a moment after the ingress tried it and found nothing
    assert.deepEqual(await answered, { status: 200, reason: null, text: 'up' })
  })

  it('the same request to a pod that was not expected fails at once, as it always did', async () => {
    const t = await rig({ serve: false })
    const r = await t.get()
    assert.equal(r.status, 502)
    assert.equal(r.reason, 'provider-not-authorized') // nothing serves http on that pod, and it has granted nothing
  })

  it('a pod that never comes: the wait ends with the original failure, and is bounded by graceMs', async () => {
    const t = await rig({ serve: false })
    t.mesh.expect(t.provider.podId, { graceMs: 40, retryMs: 5 })
    const r = await t.get()
    assert.equal(r.status, 502)
    assert.equal(r.reason, 'provider-not-authorized')
  })

  it('is never held past the request\'s own deadline', async () => {
    const t = await rig({ serve: false, ingress: { limits: { timeoutMs: 80 } } })
    t.mesh.expect(t.provider.podId, { graceMs: 60_000, retryMs: 5 })
    const r = await t.get()
    assert.equal(r.status, 504)
    assert.equal(r.reason, 'provider-timeout')
  })

  it('a link that goes away is dialled again, and requests wait for it (the pod stops and starts)', async () => {
    const t = await rig()
    t.mesh.expect(t.provider.podId, { retryMs: 5 })
    await t.mesh.whenReady({ timeoutMs: 10_000 })
    t.served.stop()
    await until(() => !t.mesh.readiness().ready, 'readiness to notice the link going')
    const attempt = t.afterNextAttempt()
    const answered = t.get()
    await attempt
    t.startProvider()
    assert.deepEqual(await answered, { status: 200, reason: null, text: 'up' })
    assert.equal(await t.mesh.whenReady({ timeoutMs: 10_000 }), true)
  })

  it('close() stops dialling and holds nothing open', async () => {
    const t = await rig({ serve: false })
    t.mesh.expect(t.provider.podId, { retryMs: 5 })
    const waiting = t.get()
    await t.mesh.close()
    const r = await waiting
    assert.ok([502, 503].includes(r.status))
    t.mesh.expect(t.provider.podId) // after close: nothing happens
    assert.equal(t.mesh.readiness().peers.total, 0)
  })
})

describe('the readiness endpoint of the Node listener', () => {
  const fetchText = (port, path, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => { let body = ''; res.on('data', (d) => { body += d }); res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] })) })
    req.on('error', reject)
    req.end()
  })

  it('answers 503 until the expected pods are up and 200 after, and is off unless asked for', async () => {
    const t = await rig({ serve: false })
    t.mesh.expect(t.provider.podId, { retryMs: 5 })
    const off = await listenNode(t.mesh)
    cleanups.push(() => off.close())
    assert.equal((await fetchText(off.port, '/_ready')).status, 502) // an ordinary request for the pod, which is not serving yet
    const on = await listenNode(t.mesh, { readyPath: '/_ready' })
    cleanups.push(() => on.close())
    const before = await fetchText(on.port, '/_ready')
    assert.equal(before.status, 503)
    assert.deepEqual(JSON.parse(before.body), { ready: false, peers: { up: 0, total: 1 } })
    t.startProvider()
    await t.mesh.whenReady({ timeoutMs: 10_000 })
    const after = await fetchText(on.port, '/_ready')
    assert.equal(after.status, 200)
    assert.match(after.type, /application\/json/)
    assert.deepEqual(JSON.parse(after.body), { ready: true, peers: { up: 1, total: 1 } })
    assert.equal((await fetchText(on.port, '/_ready', 'HEAD')).status, 200)
    // Only that exact path: a longer one, a query and another method are ordinary requests for the pod.
    assert.equal((await fetchText(on.port, '/_ready/x')).body, 'up')
    assert.equal((await fetchText(on.port, '/_ready?x=1')).body, 'up')
    assert.equal((await fetchText(on.port, '/_ready', 'POST')).status, 405)
  })

  it('refuses a path that is not a plain absolute path', async () => {
    const t = await rig()
    for (const bad of ['', 'ready', '//x', '/a b', 5]) await assert.rejects(listenNode(t.mesh, { readyPath: bad }), TypeError, String(bad))
  })
})

describe('a name in its hold', () => {
  async function namesRig() {
    const t = await rig({ serve: false })
    const zone = 'pods.example.test'
    const table = createNameTable({ zone, allow: registryAllow(t.ingress.registry), holdMs: 60_000 })
    const namesServed = serveIngressNames(t.i, table)
    cleanups.push(() => namesServed.stop())
    t.ingress.registry.grantCapabilities(t.provider.podId, [`protocol:${NAMES_PROTOCOL}:open`, 'ingress:name:app:claim'])
    const mesh = createMeshIngress({ service: t.i, names: table })
    cleanups.push(() => mesh.close())
    const get = async () => { const res = await mesh.handle(new Request(`http://app.${zone}/`)); return { status: res.status, reason: res.headers.get(REASON_HEADER), text: await res.text() } }
    return { ...t, table, mesh, get, zone }
  }

  it('a request for a name whose pod is mid-handover waits for it and is answered', async () => {
    const t = await namesRig()
    const first = t.startProvider()
    const client = await openNameClient(t.p, t.ingress.podId)
    await client.claim('app')
    assert.equal((await t.get()).text, 'up')
    // The pod's link drops: the name is held, the pod stops serving for a moment.
    first.stop()
    client.channel.close() // the link drops without a goodbye
    await until(() => t.table.lookup(`app.${t.zone}`)?.held === true, 'the name to be held')
    const waiting = t.get()
    // A stranger cannot take it meanwhile; the pod comes back, serves again and claims again.
    t.ingress.registry.grantCapabilities(t.stranger.podId, [`protocol:${NAMES_PROTOCOL}:open`, 'ingress:name:*:claim'])
    const other = await openNameClient(t.s, t.ingress.podId)
    await assert.rejects(other.claim('app'), (e) => e.reason === 'name-taken')
    other.close()
    t.startProvider()
    const back = await openNameClient(t.p, t.ingress.podId)
    await back.claim('app')
    assert.deepEqual(await waiting, { status: 200, reason: null, text: 'up' })
    back.close()
  })

  it('a name whose pod never returns: the request ends with the original failure, then the name is gone', async () => {
    const t = await namesRig()
    const first = t.startProvider()
    const client = await openNameClient(t.p, t.ingress.podId)
    await client.claim('app')
    first.stop()
    client.channel.close() // the link drops without a goodbye
    await until(() => t.table.lookup(`app.${t.zone}`)?.held === true, 'the name to be held')
    const r = await t.get()
    assert.equal(r.status, 502)
    assert.equal(r.reason, 'provider-no-http')
  })

  it('names need a resolve or a table, and a table is checked', () => {
    assert.throws(() => createMeshIngress({ service: { api: { openProtocol() {} } } }), /resolve/)
    assert.throws(() => createMeshIngress({ service: { api: { openProtocol() {} } }, names: {} }), /names/)
  })

  it('an operator mapping wins over a name, and anything else under the zone is a 404', async () => {
    const t = await namesRig()
    t.startProvider()
    const mesh = createMeshIngress({ service: t.i, names: t.table, resolve: (r) => (new URL(r.url).host === 'fixed.example.test' ? { peer: t.provider.podId } : null) })
    cleanups.push(() => mesh.close())
    assert.equal((await mesh.handle(new Request('http://fixed.example.test/'))).status, 200)
    assert.equal((await mesh.handle(new Request(`http://nobody.${t.zone}/`))).status, 404)
  })
})
