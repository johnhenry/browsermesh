// The web-standard handler over the in-memory bus: a real provider (serveHttpOnMesh) on a second pod, the real protocol
// channel and stream layer between them, a real PeerRegistry on the provider (default deny).
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createMeshIngress, serveHttpOnMesh } from '../src/index.mjs'
import { REASON_HEADER } from '../src/errors.mjs'
import { threePods, grantHttp, deferred, until } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

/** A provider answering with `handler`, an ingress mapping every host to it. */
async function rig({ handler, provider = {}, ingress = {}, grant = true, allowFrom } = {}) {
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  const served = serveHttpOnMesh(pods.p, handler ?? (() => new Response('hello')), { allowFrom: allowFrom ?? [pods.ingress.podId], ...provider })
  cleanups.push(() => served.stop())
  if (grant) grantHttp(pods)
  const audits = []
  const mesh = createMeshIngress({
    service: pods.i,
    resolve: () => ({ peer: pods.provider.podId }),
    onAudit: (r) => audits.push(r),
    ...ingress,
  })
  cleanups.push(() => mesh.close())
  return { ...pods, served, mesh, audits, get: (path = '/', init) => mesh.handle(new Request(`http://app.example.test${path}`, init), { clientAddress: '203.0.113.9' }) }
}

describe('the happy path', () => {
  it('answers a GET with the provider\'s response and the policy headers', async () => {
    const t = await rig({ handler: () => new Response('<h1>hi</h1>', { headers: { 'content-type': 'text/html' } }) })
    const res = await t.get('/page?x=1')
    assert.equal(res.status, 200)
    assert.equal(await res.text(), '<h1>hi</h1>')
    assert.equal(res.headers.get('content-type'), 'text/html')
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; sandbox")
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.ok(res.headers.get('vary'))
  })

  it('hands the provider a Request built from parsed parts, and the verified ingress pod', async () => {
    const seen = deferred()
    const t = await rig({ handler: (request, ctx) => { seen.resolve({ url: request.url, method: request.method, peer: ctx.peer }); return new Response('ok') } })
    await t.get('/a/b?c=d')
    assert.deepEqual(await seen.promise, { url: 'http://app.example.test/a/b?c=d', method: 'GET', peer: t.ingress.podId })
  })

  it('accepts a { fetch } handler', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, { fetch: (request) => new Response(`fetch:${new URL(request.url).pathname}`) }, { allowFrom: [pods.ingress.podId] })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }) })
    cleanups.push(() => mesh.close())
    assert.equal(await (await mesh.handle(new Request('http://x.test/q'))).text(), 'fetch:/q')
  })

  it('HEAD has no body but keeps the provider\'s headers', async () => {
    const t = await rig({ handler: () => new Response('abcdef', { headers: { 'content-type': 'text/plain', etag: '"1"' } }), ingress: { methods: ['GET', 'HEAD'] } })
    const res = await t.get('/', { method: 'HEAD' })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('etag'), '"1"')
    assert.equal((await res.text()), '')
  })

  it('a 204 and a 304 carry no body', async () => {
    const t = await rig({ handler: (request) => new Response(null, { status: new URL(request.url).pathname === '/nc' ? 204 : 304 }) })
    assert.equal((await t.get('/nc')).status, 204)
    assert.equal((await t.get('/other')).status, 304)
  })

  it('a POST body crosses as a stream and arrives intact', async () => {
    const t = await rig({
      ingress: { methods: ['GET', 'POST'] },
      handler: async (request) => new Response(`${request.method}:${request.headers.get('content-type')}:${await request.text()}`),
    })
    const res = await t.get('/', { method: 'POST', body: 'x'.repeat(40_000), headers: { 'content-type': 'text/plain' } })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), `POST:text/plain:${'x'.repeat(40_000)}`)
  })

  it('a large response streams in chunks, byte for byte', async () => {
    const big = new Uint8Array(900_000).map((_, i) => i % 251)
    const t = await rig({ handler: () => new Response(big, { headers: { 'content-type': 'application/octet-stream' } }) })
    const res = await t.get('/big')
    const got = new Uint8Array(await res.arrayBuffer())
    assert.equal(got.byteLength, big.byteLength)
    assert.ok(got.every((b, i) => b === big[i]))
  })

  it('a mapping can rewrite the path and add headers the provider sees, keeping the query', async () => {
    const seen = deferred()
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, (request) => { seen.resolve({ path: new URL(request.url).pathname + new URL(request.url).search, tenant: request.headers.get('x-tenant') }); return new Response('ok') }, { allowFrom: [pods.ingress.podId] })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId, path: '/inner', headers: { 'x-tenant': 'acme' } }) })
    cleanups.push(() => mesh.close())
    await mesh.handle(new Request('http://x.test/outer/path?q=1'))
    assert.deepEqual(await seen.promise, { path: '/inner?q=1', tenant: 'acme' })
  })
})

describe('what the ingress refuses before any provider is involved', () => {
  it('construction needs a mapping, a service, and refuses methods that are never served', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    assert.throws(() => createMeshIngress({ service: pods.i }), /resolve/)
    assert.throws(() => createMeshIngress({ resolve: () => null }), /service/)
    assert.throws(() => createMeshIngress({ service: pods.i, resolve: () => null, methods: ['GET', 'TRACE'] }), /never served/)
    assert.throws(() => createMeshIngress({ service: pods.i, resolve: () => null, methods: ['CONNECT'] }), /never served/)
  })

  it('serves GET and HEAD only when narrowed to them: others are 405 with Allow', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'HEAD'] } })
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
      const res = await t.get('/', { method, body: method === 'OPTIONS' ? undefined : 'x' })
      assert.equal(res.status, 405, method)
      assert.equal(res.headers.get('allow'), 'GET, HEAD')
      assert.equal(res.headers.get(REASON_HEADER), 'method-not-allowed')
    }
  })

  it('`methods` widens the list, and only to methods the wire has', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'HEAD', 'POST'] }, handler: (r) => new Response(r.method) })
    assert.equal(await (await t.get('/', { method: 'POST', body: 'x' })).text(), 'POST')
    assert.equal((await t.get('/', { method: 'DELETE', body: 'x' })).status, 405)
  })

  it('an unmapped host is a 404 and asks no provider', async () => {
    const t = await rig({ ingress: { resolve: () => null } })
    const res = await t.get('/')
    assert.equal(res.status, 404)
    assert.equal(t.served.stats().requests, 0)
  })

  it('a failing mapping is a 500, a mapping that names a non-pod is a 500, an invalid path is a 500', async () => {
    for (const resolve of [() => { throw new Error('boom') }, () => ({ peer: 'bad id with spaces' }), () => ({ peer: 'pod', path: '/a/../b' }), () => ({ peer: 'pod', path: 'relative' }), () => ({ peer: 'pod', headers: { host: 'evil' } })]) {
      const t = await rig({ ingress: { resolve } })
      assert.equal((await t.get('/')).status, 500)
    }
  })

  it('authorize decides: false, a throw and anything but true are 403', async () => {
    for (const authorize of [() => false, () => { throw new Error('x') }, () => 'yes', async () => undefined]) {
      const t = await rig({ ingress: { authorize } })
      assert.equal((await t.get('/')).status, 403)
    }
    const t = await rig({ ingress: { authorize: (request, target) => target.peer.length > 0 } })
    assert.equal((await t.get('/')).status, 200)
  })

  it('deny: a Response is sent as it is, true is a 451, null lets it pass', async () => {
    const custom = await rig({ ingress: { deny: () => new Response('gone', { status: 410 }) } })
    assert.equal((await custom.get('/')).status, 410)
    const legal = await rig({ ingress: { deny: () => true } })
    const res = await legal.get('/')
    assert.equal(res.status, 451)
    assert.equal(res.headers.get(REASON_HEADER), 'denied')
    const open = await rig({ ingress: { deny: () => null } })
    assert.equal((await open.get('/')).status, 200)
    const throwing = await rig({ ingress: { deny: () => { throw new Error('x') } } })
    assert.equal((await throwing.get('/')).status, 500)
  })

  it('an Upgrade (WebSocket) is a 426 with a sentence', async () => {
    const t = await rig()
    const res = await t.get('/socket', { headers: { upgrade: 'websocket', connection: 'Upgrade' } })
    assert.equal(res.status, 426)
    assert.match(await res.text(), /WebSocket/)
    assert.equal(res.headers.get(REASON_HEADER), 'upgrade-unsupported')
  })

  it('refuses a Host that is not a plain hostname (with an optional port)', async () => {
    const t = await rig()
    assert.equal((await t.mesh.handle(new Request('http://exa_mple.test/'))).status, 400)
    assert.equal((await t.mesh.handle(new Request('http://app.example.test:8080/'))).status, 200)
    assert.equal((await t.mesh.handle(new Request('http://[::1]:8080/'))).status, 200)
  })

  it('refuses a request URL that carries credentials, however it was built', async () => {
    const t = await rig()
    const request = new Request('http://app.example.test/')
    Object.defineProperty(request, 'url', { value: 'http://user:pw@app.example.test/' })
    assert.equal((await t.mesh.handle(request)).status, 400)
  })

  it('a body on GET is a 400; Transfer-Encoding with Content-Length is a 400', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'POST'] } })
    assert.equal((await t.get('/', { headers: { 'content-length': '3' } })).status, 400)
    const res = await t.get('/', { method: 'POST', body: 'abc', headers: { 'transfer-encoding': 'chunked', 'content-length': '3' } }).catch((e) => e)
    // The runtime may refuse to build such a Request at all; if it does build one, the ingress refuses it.
    if (res instanceof Response) assert.equal(res.status, 400)
  })

  it('the request body cap: a declared length over it is refused unread, a longer stream is cut', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'POST'], limits: { maxRequestBodyBytes: 64 * 1024 } }, handler: async (request) => { await request.arrayBuffer(); return new Response('ok') } })
    assert.equal((await t.get('/', { method: 'POST', body: new Uint8Array(64 * 1024) })).status, 200)
    const over = await t.get('/', { method: 'POST', body: new Uint8Array(64 * 1024 + 1) })
    assert.equal(over.status, 413)
    assert.equal(over.headers.get(REASON_HEADER), 'body-too-large')
    // A chunked body with no declared length is counted as it arrives.
    const stream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(20 * 1024)) } })
    const chunked = await t.get('/', { method: 'POST', body: stream, duplex: 'half' })
    assert.equal(chunked.status, 413)
  })

  it('limits.maxRequestBodyBytes moves the cap', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'POST'], limits: { maxRequestBodyBytes: 10 } }, handler: async (request) => { await request.arrayBuffer(); return new Response('ok') } })
    assert.equal((await t.get('/', { method: 'POST', body: 'x'.repeat(10) })).status, 200)
    assert.equal((await t.get('/', { method: 'POST', body: 'x'.repeat(11) })).status, 413)
  })

  it('a slow request body is a 408 once it stalls', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'POST'], limits: { bodyIdleMs: 30 } }, handler: async (request) => { await request.arrayBuffer(); return new Response('ok') } })
    const stalls = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4)) } /* then nothing */ })
    const res = await t.get('/', { method: 'POST', body: stalls, duplex: 'half' })
    assert.equal(res.status, 408)
    assert.equal(res.headers.get(REASON_HEADER), 'body-timeout')
  })

  it('headers: too many are a 431, a target that is too long is a 414', async () => {
    const t = await rig({ ingress: { limits: { maxHeaderCount: 5, maxTargetLength: 50 } } })
    const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`x-h${i}`, 'v']))
    assert.equal((await t.get('/', { headers: many })).status, 431)
    assert.equal((await t.get(`/${'a'.repeat(60)}`)).status, 414)
    const bytes = await rig({ ingress: { limits: { maxHeaderBytes: 100 } } })
    assert.equal((await bytes.get('/', { headers: { 'x-big': 'v'.repeat(200) } })).status, 431)
  })
})

describe('the request the provider is sent', () => {
  it('passes the allow-listed headers and nothing else; never Host, Forwarded, X-Forwarded-*, Cookie, Authorization, Upgrade, Proxy-*', async () => {
    const seen = deferred()
    const t = await rig({ handler: (request) => { seen.resolve([...request.headers.keys()].sort()); return new Response('ok') } })
    await t.get('/', {
      headers: {
        accept: 'text/html', 'accept-language': 'en', 'if-none-match': '"a"', range: 'bytes=0-1',
        cookie: 'sid=1', authorization: 'Bearer s', forwarded: 'for=1.2.3.4', 'x-forwarded-for': '1.2.3.4', 'x-forwarded-host': 'evil.test',
        'x-forwarded-proto': 'https', 'x-real-ip': '9.9.9.9', 'proxy-authorization': 'x', 'proxy-connection': 'keep-alive', via: '1.1 x',
        'user-agent': 'curl', 'x-custom': 'v', 'sec-websocket-key': 'abc',
      },
    })
    assert.deepEqual(await seen.promise, ['accept', 'accept-language', 'if-none-match', 'range'])
  })

  it('`forwardHeaders` adds names, but never one on the never-list', async () => {
    const seen = deferred()
    const t = await rig({
      ingress: { forwardHeaders: ['authorization', 'x-custom', 'x-forwarded-for', 'host', 'transfer-encoding'] },
      handler: (request) => { seen.resolve([...request.headers.keys()].sort()); return new Response('ok') },
    })
    await t.get('/', { headers: { authorization: 'Bearer s', 'x-custom': 'v', 'x-forwarded-for': '1.2.3.4' } })
    assert.deepEqual(await seen.promise, ['authorization', 'x-custom'])
  })

  it('a client address reaches the provider only when asked, as a freshly set X-Forwarded-For', async () => {
    const seen = []
    const handler = (request) => { seen.push(request.headers.get('x-forwarded-for')); return new Response('ok') }
    const off = await rig({ handler })
    await off.get('/', { headers: { 'x-forwarded-for': '6.6.6.6' } })
    const on = await rig({ handler, ingress: { forwardClientAddress: true } })
    await on.get('/', { headers: { 'x-forwarded-for': '6.6.6.6' } })
    assert.deepEqual(seen, [null, '203.0.113.9'])
  })
})

describe('the response the client gets', () => {
  const hostile = () => new Response('body', {
    headers: [
      ['content-type', 'text/html'], ['set-cookie', 'a=1'], ['set-cookie', 'b=2'], ['content-security-policy', 'default-src *'],
      ['x-content-type-options', 'sniff'], ['cache-control', 'public, max-age=999'], ['strict-transport-security', 'max-age=1'],
      ['access-control-allow-origin', '*'], ['x-powered-by', 'x'], ['refresh', '0;url=http://elsewhere.test'], ['alt-svc', 'h3=":443"'],
      ['vary', 'Accept-Language'], ['clear-site-data', '"cache"'], ['link', '</x>; rel=preload'],
    ],
  })

  it('strips Set-Cookie and every header not on the pass list, and forces the policy headers', async () => {
    const t = await rig({ handler: hostile })
    const res = await t.get('/')
    assert.deepEqual([...res.headers.keys()].sort(), ['cache-control', 'content-security-policy', 'content-type', 'vary', 'x-content-type-options'])
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; sandbox")
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.match(res.headers.get('vary'), /accept-language/)
    assert.match(res.headers.get('vary'), /accept/)
  })

  it('a mapping can opt out of each part of the policy explicitly', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, hostile, { allowFrom: [pods.ingress.podId] })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    const policies = {
      '/relaxed': { contentSecurityPolicy: "default-src 'self'", cacheControl: 'max-age=5', allowSetCookie: true },
      '/bare': { contentSecurityPolicy: false, cacheControl: false },
    }
    const mesh = createMeshIngress({ service: pods.i, resolve: (request) => ({ peer: pods.provider.podId, response: policies[new URL(request.url).pathname] }) })
    cleanups.push(() => mesh.close())
    const res = await mesh.handle(new Request('http://x.test/relaxed'))
    assert.equal(res.headers.get('content-security-policy'), "default-src 'self'")
    assert.equal(res.headers.get('cache-control'), 'max-age=5')
    assert.deepEqual(res.headers.getSetCookie(), ['a=1', 'b=2'])
    await res.text()
    const bare = await mesh.handle(new Request('http://x.test/bare'))
    assert.equal(bare.headers.get('content-security-policy'), null)
    assert.equal(bare.headers.get('cache-control'), null)
    assert.equal(bare.headers.get('x-content-type-options'), 'nosniff') // not something a mapping turns off
    assert.equal(bare.headers.getSetCookie().length, 0)
  })

  it('`exposeHeaders` lets a named provider header through', async () => {
    const t = await rig({ handler: () => new Response('x', { headers: { 'x-request-id': '7', 'x-other': '1' } }), ingress: { exposeHeaders: ['x-request-id'] } })
    const res = await t.get('/')
    assert.equal(res.headers.get('x-request-id'), '7')
    assert.equal(res.headers.get('x-other'), null)
  })

  it('error responses carry the policy headers and a named reason too', async () => {
    const t = await rig({ ingress: { resolve: () => null } })
    const res = await t.get('/')
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; sandbox")
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get(REASON_HEADER), 'no-mapping')
  })
})

describe('limits', () => {
  it('the response cap: a declared length over it is refused before anything is sent', async () => {
    const t = await rig({ handler: () => new Response('x'.repeat(2000), { headers: { 'content-length': '2000' } }), ingress: { limits: { maxResponseBytes: 1000 } } })
    const res = await t.get('/')
    assert.equal(res.status, 502)
    assert.equal(res.headers.get(REASON_HEADER), 'response-too-large')
    assert.equal(t.mesh.stats().inflight, 0)
  })

  it('the response cap: a body of no declared length that outgrows it is cut, not delivered whole', async () => {
    const t = await rig({ handler: () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(400)) } })), ingress: { limits: { maxResponseBytes: 1000 } } })
    const res = await t.get('/')
    assert.equal(res.status, 200) // the head had gone out: the only honest signal left is a broken body
    await assert.rejects(res.arrayBuffer())
    await until(() => t.mesh.stats().inflight === 0)
    assert.equal(t.mesh.stats().reasons['response-too-large'], 1)
  })

  it('the total deadline: a provider that never answers is a 504', async () => {
    const never = deferred()
    const t = await rig({ handler: () => never.promise, ingress: { limits: { timeoutMs: 50 } } })
    const res = await t.get('/')
    assert.equal(res.status, 504)
    assert.equal(res.headers.get(REASON_HEADER), 'provider-timeout')
    never.resolve(new Response('late'))
  })

  it('a global in-flight cap answers 503 with Retry-After', async () => {
    const gate = deferred()
    const t = await rig({ handler: () => gate.promise.then(() => new Response('done')), ingress: { limits: { maxInflight: 2 } } })
    const first = t.mesh.handle(new Request('http://a.test/'), { clientAddress: '10.0.0.1' })
    const second = t.mesh.handle(new Request('http://a.test/'), { clientAddress: '10.0.0.2' })
    await until(() => t.mesh.stats().inflight === 2)
    const third = await t.mesh.handle(new Request('http://a.test/'), { clientAddress: '10.0.0.3' })
    assert.equal(third.status, 503)
    assert.ok(third.headers.get('retry-after'))
    gate.resolve()
    const [a, b] = await Promise.all([first, second])
    assert.deepEqual([a.status, b.status], [200, 200])
    await Promise.all([a.text(), b.text()])
    assert.equal(t.mesh.stats().inflight, 0)
  })

  it('a per-client in-flight cap answers 429 for that client only', async () => {
    const gate = deferred()
    const t = await rig({ handler: () => gate.promise.then(() => new Response('done')), ingress: { limits: { maxInflightPerClient: 1 } } })
    const first = t.mesh.handle(new Request('http://a.test/'), { clientAddress: '10.0.0.1' })
    await until(() => t.mesh.stats().inflight === 1)
    assert.equal((await t.mesh.handle(new Request('http://a.test/'), { clientAddress: '10.0.0.1' })).status, 429)
    const other = t.mesh.handle(new Request('http://a.test/'), { clientAddress: '10.0.0.2' })
    gate.resolve()
    const [a, b] = await Promise.all([first, other])
    assert.deepEqual([a.status, b.status], [200, 200])
    await Promise.all([a.text(), b.text()])
  })

  it('a per-provider in-flight cap answers 503', async () => {
    const gate = deferred()
    const t = await rig({ handler: () => gate.promise.then(() => new Response('done')), ingress: { limits: { maxInflightPerProvider: 1 } } })
    const first = t.mesh.handle(new Request('http://a.test/'), { clientAddress: '10.0.0.1' })
    await until(() => t.mesh.stats().inflight === 1)
    const second = await t.mesh.handle(new Request('http://a.test/'), { clientAddress: '10.0.0.2' })
    assert.equal(second.status, 503)
    assert.equal(second.headers.get(REASON_HEADER), 'provider-inflight')
    gate.resolve()
    await (await first).text()
  })

  it('per-client and per-provider rates run on an injected clock', async () => {
    let now = 1_000_000
    const t = await rig({ ingress: { clock: { now: () => now }, limits: { clientRate: { limit: 2, windowMs: 1000 }, providerRate: { limit: 3, windowMs: 1000 } } } })
    const go = (client) => t.mesh.handle(new Request('http://a.test/'), { clientAddress: client })
    assert.equal((await go('1.1.1.1')).status, 200)
    assert.equal((await go('1.1.1.1')).status, 200)
    const limited = await go('1.1.1.1')
    assert.equal(limited.status, 429)
    assert.ok(Number(limited.headers.get('retry-after')) >= 1)
    assert.equal((await go('2.2.2.2')).status, 200) // another client, the provider's third
    const providerLimited = await go('3.3.3.3')
    assert.equal(providerLimited.status, 503)
    assert.equal(providerLimited.headers.get(REASON_HEADER), 'provider-rate')
    now += 1001
    assert.equal((await go('1.1.1.1')).status, 200)
  })

  it('limits are validated at construction', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    assert.throws(() => createMeshIngress({ service: pods.i, resolve: () => null, limits: { maxInflight: 0 } }), /maxInflight/)
    assert.throws(() => createMeshIngress({ service: pods.i, resolve: () => null, limits: { clientRate: { limit: 1 } } }), /clientRate/)
  })
})

describe('a client that goes away', () => {
  it('aborting the request aborts the provider\'s handler and releases every slot', async () => {
    const aborted = deferred()
    const started = deferred()
    const t = await rig({ handler: (request, { signal }) => { started.resolve(); signal.addEventListener('abort', () => aborted.resolve(true)); return new Promise(() => {}) } })
    const ac = new AbortController()
    const pending = t.mesh.handle(new Request('http://a.test/', { signal: ac.signal }))
    await started.promise
    ac.abort()
    const res = await pending
    assert.ok([499, 500, 504].includes(res.status) || res.status >= 400)
    assert.equal(await aborted.promise, true)
    await until(() => t.mesh.stats().inflight === 0)
  })

  it('cancelling the body of a streaming response stops the provider writing', async () => {
    const stopped = deferred()
    const t = await rig({
      handler: () => new Response(new ReadableStream({
        async pull(c) { await new Promise((r) => setTimeout(r, 1)); c.enqueue(new Uint8Array(16 * 1024)) },
        cancel() { stopped.resolve(true) },
      })),
    })
    const res = await t.get('/')
    const reader = res.body.getReader()
    await reader.read()
    await reader.cancel()
    assert.equal(await stopped.promise, true)
    await until(() => t.mesh.stats().inflight === 0)
  })
})

describe('audit and stats', () => {
  it('an audit record has the pod, status, bytes and duration, and never a query string, path or body', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'POST'] }, handler: async (request) => new Response(`got ${(await request.text()).length}`) })
    await (await t.get('/secret/path?token=abc123', { method: 'POST', body: 'password=hunter2' })).text()
    await until(() => t.audits.length === 1)
    const [record] = t.audits
    assert.equal(record.peer, t.provider.podId)
    assert.equal(record.status, 200)
    assert.equal(record.requestBytes, 16)
    assert.ok(record.responseBytes > 0)
    assert.ok(record.durationMs >= 0)
    assert.equal(record.host, 'app.example.test')
    const text = JSON.stringify(record)
    for (const secret of ['abc123', 'hunter2', 'secret', 'token', '/path']) assert.ok(!text.includes(secret), secret)
  })

  it('a refusal is audited with its reason', async () => {
    const t = await rig({ ingress: { resolve: () => null } })
    await t.get('/')
    assert.equal(t.audits[0].status, 404)
    assert.equal(t.audits[0].reason, 'no-mapping')
    assert.equal(t.mesh.stats().reasons['no-mapping'], 1)
  })

  it('a throwing audit sink does not break the request', async () => {
    const t = await rig({ ingress: { onAudit: () => { throw new Error('sink') } } })
    assert.equal((await t.get('/')).status, 200)
  })

  it('stats count what happened', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'HEAD'] } })
    await (await t.get('/')).text()
    await t.get('/', { method: 'DELETE' })
    const s = t.mesh.stats()
    assert.equal(s.requests, 2)
    assert.equal(s.served, 1)
    assert.equal(s.refused, 1)
    assert.equal(s.providers, 1)
  })

  it('close() refuses new requests and closes the channels', async () => {
    const t = await rig()
    await t.get('/')
    await t.mesh.close()
    const res = await t.get('/')
    assert.equal(res.status, 503)
    assert.equal(res.headers.get(REASON_HEADER), 'closing')
  })
})
