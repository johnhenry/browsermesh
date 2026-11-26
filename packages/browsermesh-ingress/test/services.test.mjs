// Several services on one pod: a pod declares the named services it serves, a route names one, and the ingress asks the
// pod for nothing it did not declare. An older pod (one that declares nothing) is never sent a service name.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createMeshIngress, serveHttpOnMesh, signedRequestBytes } from '../src/index.mjs'
import { REASON_HEADER } from '../src/errors.mjs'
import { validateRequestHead } from '../src/wire.mjs'
import { threePods, grantHttp } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

async function rig({ handler, services, provider = {}, ingress = {} } = {}) {
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  const seen = []
  const tag = (name) => (request, ctx) => { seen.push([name, ctx.service, new URL(request.url).pathname]); return new Response(`${name}:${new URL(request.url).pathname}`) }
  const served = serveHttpOnMesh(pods.p, handler === null ? null : (handler ?? tag('default')), {
    allowFrom: [pods.ingress.podId],
    ...(services === false ? {} : { services: services ?? { web: tag('web'), api: { fetch: tag('api') } } }),
    ...provider,
  })
  cleanups.push(() => served.stop())
  grantHttp(pods)
  const mesh = createMeshIngress({ service: pods.i, resolve: (request) => ({ peer: pods.provider.podId, service: new URL(request.url).host.split('.')[0] === 'plain' ? undefined : new URL(request.url).host.split('.')[0] }), ...ingress })
  cleanups.push(() => mesh.close())
  const get = async (host, path = '/') => { const res = await mesh.handle(new Request(`http://${host}${path}`)); return { status: res.status, reason: res.headers.get(REASON_HEADER), text: await res.text() } }
  return { ...pods, served, mesh, seen, get }
}

describe('a route that names a service', () => {
  it('reaches that service\'s handler, which is told its name; a route with none reaches the default', async () => {
    const t = await rig()
    assert.deepEqual(await t.get('web.example.test', '/a'), { status: 200, reason: null, text: 'web:/a' })
    assert.deepEqual(await t.get('api.example.test', '/b'), { status: 200, reason: null, text: 'api:/b' })
    assert.deepEqual(await t.get('plain.example.test', '/c'), { status: 200, reason: null, text: 'default:/c' })
    assert.deepEqual(t.seen, [['web', 'web', '/a'], ['api', 'api', '/b'], ['default', undefined, '/c']])
  })

  it('a service the pod did not declare is refused by the ingress, and the pod is sent nothing', async () => {
    const t = await rig()
    const r = await t.get('db.example.test')
    assert.equal(r.status, 502)
    assert.equal(r.reason, 'provider-no-service')
    assert.deepEqual(t.seen, [])
    assert.equal(t.served.stats().requests, 0)
  })

  it('a pod with services and no default serves nothing to a route that names none', async () => {
    const t = await rig({ handler: null })
    const r = await t.get('plain.example.test')
    assert.equal(r.status, 502)
    assert.equal(r.reason, 'provider-no-service')
    assert.equal((await t.get('web.example.test')).status, 200)
  })

  it('a hostile ingress that names an undeclared service anyway is refused by the pod', async () => {
    const t = await rig()
    const channel = await t.i.api.openProtocol(t.provider.podId, 'http', { versions: [1] })
    const head = { rid: 1, nonce: 'a'.repeat(16), method: 'GET', target: '/', host: 'x.test', headers: [], body: false }
    await assert.rejects(channel.request('fetch', { ...head, service: 'db' }), (e) => e.reason === 'unknown-service')
    await assert.rejects(channel.request('fetch', { ...head, rid: 2, service: '../etc' }), (e) => e.reason === 'bad-request-head')
    assert.deepEqual(t.seen, [])
    channel.close()
  })

  it('only services that were declared are named in the declaration, with whether there is a default', async () => {
    const t = await rig()
    const channel = await t.i.api.openProtocol(t.provider.podId, 'http', { versions: [1] })
    assert.deepEqual(await channel.request('services', {}), { services: ['api', 'web'], default: true })
    channel.close()
  })

  it('a service name in a mapping that is not a short plain name is a bad mapping, found before any pod is asked', async () => {
    const t = await rig({ ingress: { resolve: () => ({ peer: 'x'.repeat(43), service: 'Not Valid' }) } })
    const r = await t.get('web.example.test')
    assert.equal(r.status, 500)
    assert.equal(r.reason, 'bad-mapping')
  })
})

describe('a pod that predates services', () => {
  it('is asked nothing for a route with no service, and a route with one is refused, not sent to its only handler', async () => {
    const t = await rig({ services: false })
    assert.equal((await t.get('plain.example.test')).text, 'default:/')
    const r = await t.get('web.example.test')
    assert.equal(r.status, 502)
    assert.equal(r.reason, 'provider-no-service')
    assert.deepEqual(t.seen, [['default', undefined, '/']])
  })

  it('a pod that cannot be asked at all does not make a route without a service fail', async () => {
    const t = await rig({ services: false })
    const channel = await t.i.api.openProtocol(t.provider.podId, 'http', { versions: [1] })
    await assert.rejects(channel.request('services', {}), (e) => e.code === -32601)
    channel.close()
  })
})

describe('what the wire carries', () => {
  it('a request head may carry a service name and no other new field is believed', () => {
    const base = { rid: 1, nonce: 'a'.repeat(16), method: 'GET', target: '/', host: 'x.test', headers: [], body: false }
    const limits = { maxHeaderCount: 64, maxHeaderBytes: 16384, maxTargetLength: 2048 }
    assert.ok(validateRequestHead({ ...base, service: 'web' }, limits))
    assert.ok(validateRequestHead(base, limits))
    for (const bad of ['', 5, 'A', 'a b', 'x'.repeat(65), null, {}]) assert.throws(() => validateRequestHead({ ...base, service: bad }, limits), /service/, String(bad))
  })

  it('the signed bytes of a request with no service are exactly what they were, and with one they cover it', () => {
    const parts = { rid: 1, nonce: 'n'.repeat(16), host: 'x.test', method: 'GET', target: '/', headers: [], digest: 'd' }
    const plain = new TextDecoder().decode(signedRequestBytes(parts))
    assert.equal(plain, JSON.stringify({ v: 1, dir: 'request', rid: 1, nonce: 'n'.repeat(16), host: 'x.test', method: 'GET', target: '/', headers: [], digest: 'd' }))
    const named = JSON.parse(new TextDecoder().decode(signedRequestBytes({ ...parts, service: 'web' })))
    assert.equal(named.service, 'web')
  })

  it('a signed request for a service reaches the provider\'s verifyRequest with the service in the bytes it checks', async () => {
    const checked = []
    const t = await rig({
      provider: { verifyRequest: (request, { bytes, sig }) => { checked.push(JSON.parse(new TextDecoder().decode(bytes)).service); return sig === 'ok' } },
      ingress: { signRequest: () => 'ok' },
    })
    assert.equal((await t.get('api.example.test')).status, 200)
    assert.equal((await t.get('plain.example.test')).status, 200)
    assert.deepEqual(checked, ['api', undefined])
  })
})

describe('a provider\'s own checks', () => {
  it('refuses services that are not named plainly, handlers that are not functions, and having nothing to serve', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const allowFrom = [pods.ingress.podId]
    const handler = () => new Response('x')
    for (const services of [{ 'Bad Name': handler }, { web: 5 }, { web: {} }, [], 'web', {}]) {
      assert.throws(() => serveHttpOnMesh(pods.p, null, { allowFrom, services }), TypeError, JSON.stringify(services))
    }
    assert.throws(() => serveHttpOnMesh(pods.p, null, { allowFrom }), TypeError)
    const many = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`s${i}`, handler]))
    assert.throws(() => serveHttpOnMesh(pods.p, null, { allowFrom, services: many }), TypeError)
  })
})
