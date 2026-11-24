// A real HTTP client (Node's fetch) against the real listener, the provider on a second pod.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { listenNode, clientAddressOf, isLoopbackHost } from '../src/node.mjs'
import { createMeshIngress } from '../src/index.mjs'
import { threePods } from './helpers/mesh.mjs'
import { httpRig } from './helpers/http.mjs'
import { deferred, until } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
const rig = (opts) => httpRig(opts, cleanups)

describe('over a real socket', () => {
  it('a GET gets the provider\'s page with the policy headers', async () => {
    const t = await rig({ handler: (request) => new Response(`<p>${new URL(request.url).pathname}</p>`, { headers: { 'content-type': 'text/html', 'set-cookie': 'a=1' } }) })
    const res = await t.fetch('/hello?x=1')
    assert.equal(res.status, 200)
    assert.equal(await res.text(), '<p>/hello</p>')
    assert.equal(res.headers.get('content-type'), 'text/html')
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; sandbox")
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.getSetCookie().length, 0)
  })

  it('HEAD, 404 for an unmapped host, 405 for a method not allowed', async () => {
    const t = await rig()
    const head = await t.fetch('/', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
    const unmapped = await t.raw('GET / HTTP/1.1\r\nHost: other.test\r\nConnection: close\r\n\r\n')
    assert.match(unmapped.text, /^HTTP\/1\.1 404/)
    const post = await t.fetch('/', { method: 'POST', body: 'x' })
    assert.equal(post.status, 405)
    assert.equal(post.headers.get('allow'), 'GET, HEAD')
  })

  it('a POST body arrives at the provider byte for byte once the method is allowed', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'POST'] }, handler: async (request) => new Response(`${request.method} ${request.headers.get('content-type')} ${(await request.arrayBuffer()).byteLength}`) })
    const res = await t.fetch('/', { method: 'POST', body: new Uint8Array(30_000), headers: { 'content-type': 'application/octet-stream' } })
    assert.equal(await res.text(), 'POST application/octet-stream 30000')
    const big = await t.fetch('/', { method: 'POST', body: new Uint8Array(70_000) })
    assert.equal(big.status, 413)
  })

  it('a 3 MiB response streams through intact', async () => {
    const data = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 7) % 256)
    const t = await rig({ handler: () => new Response(data) })
    const got = new Uint8Array(await (await t.fetch('/big')).arrayBuffer())
    assert.equal(got.byteLength, data.byteLength)
    assert.ok(got.every((b, i) => b === data[i]))
  })

  it('a client that hangs up mid-response stops the provider and frees the slots', async () => {
    const stopped = deferred()
    const t = await rig({ handler: () => new Response(new ReadableStream({ async pull(c) { await new Promise((r) => setTimeout(r, 2)); c.enqueue(new Uint8Array(8192)) }, cancel() { stopped.resolve(true) } })) })
    const ac = new AbortController()
    const res = await t.fetch('/', { signal: ac.signal })
    const reader = res.body.getReader()
    await reader.read()
    ac.abort()
    assert.equal(await stopped.promise, true)
    await until(() => t.mesh.stats().inflight === 0)
  })

  it('a provider that fails after the head drops the connection (the client sees a broken body, not a clean end)', async () => {
    const t = await rig({ handler: () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); setTimeout(() => c.error(new Error('boom')), 5) } })) })
    const res = await t.fetch('/')
    await assert.rejects(res.arrayBuffer())
  })

  it('the audit record is written once the body ends, with no query string', async () => {
    const t = await rig()
    await (await t.fetch('/p?secret=1')).text()
    await until(() => t.audits.length === 1)
    assert.equal(t.audits[0].status, 200)
    assert.ok(!JSON.stringify(t.audits[0]).includes('secret'))
  })
})

describe('the listener', () => {
  it('binds to loopback by default and says which port', async () => {
    const t = await rig()
    assert.equal(t.listener.host, '127.0.0.1')
    assert.equal(t.listener.server.address().address, '127.0.0.1')
    assert.ok(t.listener.port > 0)
  })

  it('refuses a bind that is not loopback unless public is stated', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const mesh = createMeshIngress({ service: pods.i, resolve: () => null })
    cleanups.push(() => mesh.close())
    for (const host of ['0.0.0.0', '::', '192.0.2.1', 'example.test']) await assert.rejects(listenNode(mesh, { host }), /loopback/)
    const ok = await listenNode(mesh, { host: '127.0.0.1', public: true })
    await ok.close()
    assert.ok(isLoopbackHost('::1') && isLoopbackHost('127.0.0.5') && isLoopbackHost('localhost') && !isLoopbackHost('10.0.0.1') && !isLoopbackHost('0.0.0.0'))
  })

  it('needs an ingress', async () => {
    await assert.rejects(listenNode({}), TypeError)
  })

  it('close() ends open connections', async () => {
    const t = await rig()
    const { socket } = await t.raw('GET / HTTP/1.1\r\nHost: app.test\r\n\r\n', { keepOpen: true, until: (b) => b.includes('hello') })
    const closed = new Promise((r) => socket.once('close', r))
    await t.listener.close()
    await closed
  })
})

describe('the client address', () => {
  it('clientAddressOf: the socket\'s, unless trustProxy says how many proxies are in front', () => {
    assert.equal(clientAddressOf('10.0.0.9', '1.2.3.4', false), '10.0.0.9')
    assert.equal(clientAddressOf('10.0.0.9', '1.2.3.4', undefined), '10.0.0.9')
    assert.equal(clientAddressOf('10.0.0.9', '1.2.3.4', true), '1.2.3.4')
    assert.equal(clientAddressOf('10.0.0.9', '6.6.6.6, 1.2.3.4', true), '1.2.3.4') // the client's own claim is to the left
    assert.equal(clientAddressOf('10.0.0.9', '6.6.6.6, 1.2.3.4, 10.0.0.1', 2), '1.2.3.4')
    assert.equal(clientAddressOf('10.0.0.9', 'not-an-ip', true), '10.0.0.9')
    assert.equal(clientAddressOf('10.0.0.9', undefined, true), '10.0.0.9')
    assert.equal(clientAddressOf('10.0.0.9', '1.2.3.4', 0), '10.0.0.9')
    assert.equal(clientAddressOf(undefined, undefined, false), 'unknown')
    assert.equal(clientAddressOf('10.0.0.9', '2001:db8::1', true), '2001:db8::1')
  })

  it('without trustProxy a client cannot dodge its rate limit with X-Forwarded-For', async () => {
    const t = await rig({ ingress: { limits: { clientRate: { limit: 2, windowMs: 3_600_000 } } } })
    const statuses = []
    for (const xff of ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4']) {
      const res = await t.fetch('/', { headers: { 'x-forwarded-for': xff } })
      statuses.push(res.status)
      await res.text()
    }
    assert.deepEqual(statuses, [200, 200, 429, 429])
  })

  it('with trustProxy the address is the entry the trusted proxy added, never one the client wrote', async () => {
    const t = await rig({ ingress: { limits: { clientRate: { limit: 1, windowMs: 3_600_000 } } }, listen: { trustProxy: true } })
    const go = async (xff) => { const r = await t.fetch('/', { headers: { 'x-forwarded-for': xff } }); await r.text(); return r.status }
    assert.equal(await go('9.9.9.9, 1.1.1.1'), 200)
    assert.equal(await go('8.8.8.8, 1.1.1.1'), 429) // the same real client: its spoofed left-hand entries do not count
    assert.equal(await go('8.8.8.8, 2.2.2.2'), 200)
  })

  it('the provider is told the client\'s address only when asked, and then the trusted one', async () => {
    const seen = []
    const t = await rig({ ingress: { forwardClientAddress: true }, listen: { trustProxy: true }, handler: (request) => { seen.push(request.headers.get('x-forwarded-for')); return new Response('ok') } })
    await (await t.fetch('/', { headers: { 'x-forwarded-for': '7.7.7.7, 1.2.3.4' } })).text()
    assert.deepEqual(seen, ['1.2.3.4'])
  })
})
