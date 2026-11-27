// What a review of the any-method change found, each pinned: connections that end after an early answer, a client that cannot hold every
// upload slot or trickle one forever, a pod that does not say what it accepts, the headers a pod needs to defend itself, the held-body
// fallback's bounds, tiny chunks, and the small things around the listener.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createStreamLayer } from '@johnhenry/browsermesh-apps'
import { createMeshIngress, serveHttpOnMesh } from '../src/index.mjs'
import { createCollector } from '../src/limits.mjs'
import { listenNode } from '../src/node.mjs'
import { REASON_HEADER } from '../src/errors.mjs'
import { DEFAULT_FORWARD_REQUEST_HEADERS } from '../src/headers.mjs'
import { httpRig, statusOf } from './helpers/http.mjs'
import { threePods, grantHttp, deferred, until } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
const MiB = 1024 * 1024
const rig = (options) => httpRig(options, cleanups)

function connect(port) {
  const socket = net.connect(port, '127.0.0.1')
  const state = { text: '', closed: false, socket }
  socket.setEncoding('latin1')
  socket.on('data', (d) => { state.text += d })
  socket.on('close', () => { state.closed = true })
  socket.on('error', () => {})
  state.opened = new Promise((resolve) => socket.once('connect', resolve))
  state.write = (chunk) => new Promise((resolve) => { if (state.closed || socket.destroyed) return resolve(false); socket.write(chunk, 'latin1', () => resolve(!state.closed)) })
  return state
}

async function ask(pods, options, path = '/', init) {
  const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }), ...options })
  cleanups.push(() => mesh.close())
  return mesh.handle(new Request(`http://app.example.test${path}`, init), { clientAddress: '203.0.113.9' })
}

describe('a connection that has been answered early does not outlive its upload', () => {
  it('a client that finishes the declared body and then says nothing is hung up on', async () => {
    const t = await rig({ handler: () => new Response('x') })
    const c = connect(t.listener.port)
    await c.opened
    await c.write('POST / HTTP/1.1\r\nHost: other.test\r\nContent-Length: 5\r\n\r\n')
    await until(() => c.text.includes('404'), 'the refusal')
    await c.write('hello')
    await until(() => c.closed, 'the server to hang up')
    assert.equal(statusOf(c.text), 404)
  })

  it('requests pipelined behind an early-answered upload are never dispatched', async () => {
    const t = await rig({ handler: () => new Response('no', { status: 401 }) })
    const c = connect(t.listener.port)
    await c.opened
    await c.write('POST / HTTP/1.1\r\nHost: app.test\r\nContent-Length: 5\r\n\r\n')
    await until(() => c.text.includes('401'), 'the early answer')
    await c.write('helloGET /second HTTP/1.1\r\nHost: app.test\r\n\r\n')
    await until(() => c.closed, 'the server to hang up')
    assert.equal(t.served.stats().requests, 1, 'only the POST reached the pod')
    assert.equal(statusOf(c.text), 401)
  })

  it('a refusal before anything was read still lets a client that is mid-upload read the whole answer', async () => {
    const t = await rig({ handler: () => new Response('x') })
    const c = connect(t.listener.port)
    await c.opened
    await c.write(`POST / HTTP/1.1\r\nHost: other.test\r\nContent-Length: ${4 * MiB}\r\n\r\n`)
    const piece = 'z'.repeat(64 * 1024)
    let written = 0
    while (!c.closed && written < 4 * MiB) { if (!await c.write(piece)) break; written += piece.length }
    await until(() => c.closed, 'the connection to end')
    assert.equal(statusOf(c.text), 404)
    assert.match(c.text, /Nothing is served at this address\./)
  })

  it('a GET that declares a body is refused, and the connection does not wait out the request timeout for it', async () => {
    const t = await rig({ handler: () => new Response('x') })
    const c = connect(t.listener.port)
    await c.opened
    await c.write('GET / HTTP/1.1\r\nHost: app.test\r\nContent-Length: 5\r\n\r\n')
    await until(() => c.text.includes('400'), 'the refusal')
    assert.match(c.text, /connection: close/i)
    await c.write('hello')
    await until(() => c.closed, 'the server to hang up')
  })
})

describe('the listener, small things', () => {
  it('Allow on a 405 the listener makes itself reflects what the ingress carries', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'HEAD'] }, handler: () => new Response('x') })
    const r = await t.raw('TRACE / HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n\r\n')
    assert.equal(statusOf(r.text), 405)
    assert.match(r.text, /allow: GET, HEAD\r\n/i)
  })

  it('requestTimeoutMs follows the ingress\'s upload deadline when it is raised, and has its own default otherwise', async () => {
    const t = await rig({ handler: () => new Response('x') })
    assert.equal(t.listener.server.requestTimeout, 300_000)
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const mesh = createMeshIngress({ service: pods.i, resolve: () => null, limits: { uploadTimeoutMs: 900_000 } })
    cleanups.push(() => mesh.close())
    const listener = await listenNode(mesh, { port: 0 })
    cleanups.push(() => listener.close())
    assert.equal(listener.server.requestTimeout, 900_000)
    const explicit = await listenNode(mesh, { port: 0, requestTimeoutMs: 20_000 })
    cleanups.push(() => explicit.close())
    assert.equal(explicit.server.requestTimeout, 20_000)
  })
})

describe('one client cannot hold the upload slots, or trickle an upload for ever', () => {
  const holding = () => { const gate = deferred(); return { gate, source: () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)) }, pull(c) { return gate.promise.then(() => c.close()) } }, { highWaterMark: 0 }) } }
  const upload = (body) => ({ method: 'POST', body, duplex: 'half' })

  it('a client at its upload cap is refused with 429 and Retry-After; another address is not', async () => {
    const hold = holding()
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, async (request) => { await request.arrayBuffer(); return new Response('ok') }, { allowFrom: [pods.ingress.podId] })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }), limits: { maxUploadsPerClient: 2, maxUploadsPerProvider: 4, maxInflightPerClient: 8 } })
    cleanups.push(() => mesh.close())
    const send = (client, body) => mesh.handle(new Request('http://a.test/', upload(body)), { clientAddress: client })
    const a = send('198.51.100.1', hold.source())
    const b = send('198.51.100.1', hold.source())
    await until(() => served.stats().inflight === 2, 'two uploads')
    const third = await send('198.51.100.1', hold.source())
    assert.equal(third.status, 429)
    assert.equal(third.headers.get(REASON_HEADER), 'client-uploads')
    assert.ok(third.headers.get('retry-after'))
    const other = send('198.51.100.2', hold.source())
    await until(() => served.stats().inflight === 3, 'another address gets a slot')
    hold.gate.resolve()
    for (const r of await Promise.all([a, b, other])) assert.equal(r.status, 200)
  })

  const trickle = (everyMs) => new ReadableStream({ async pull(c) { await new Promise((r) => setTimeout(r, everyMs)); c.enqueue(new Uint8Array(1)) } }, { highWaterMark: 0 })

  it('the ingress cuts an upload that does not keep a minimum rate: 408', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, async (request) => { await request.arrayBuffer(); return new Response('ok') }, { allowFrom: [pods.ingress.podId] })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    const res = await ask(pods, { limits: { uploadGraceMs: 1, uploadProgressMs: 60, uploadMinBytesPerSec: 1000, bodyIdleMs: 60_000, uploadTimeoutMs: 20_000 } }, '/', upload(trickle(10)))
    assert.equal(res.status, 408)
    assert.equal(res.headers.get(REASON_HEADER), 'body-timeout')
  })

  it('the pod cuts one too, whatever the ingress allows', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const errored = deferred()
    const served = serveHttpOnMesh(pods.p, async (request) => { try { await request.arrayBuffer() } catch (e) { errored.resolve(e?.reason) } return new Response('ok') }, { allowFrom: [pods.ingress.podId], limits: { uploadGraceMs: 1, uploadProgressMs: 60, uploadMinBytesPerSec: 1000 } })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    const res = await ask(pods, { limits: { uploadGraceMs: 1e9, bodyIdleMs: 60_000, uploadTimeoutMs: 20_000 } }, '/', upload(trickle(10)))
    assert.equal(await errored.promise, 'body-timeout')
    assert.ok(res.status >= 400)
  })

  it('a sender that keeps up is not cut, and a slow origin is never blamed on the sender', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, async (request) => { for await (const c of request.body) { void c; await new Promise((r) => setTimeout(r, 15)) } return new Response('ok') }, { allowFrom: [pods.ingress.podId], limits: { uploadGraceMs: 1, uploadProgressMs: 60, uploadMinBytesPerSec: 1000 } })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    let sent = 0
    const body = new ReadableStream({ pull(c) { if (sent >= 40) return c.close(); sent++; c.enqueue(new Uint8Array(4096)) } }, { highWaterMark: 0 })
    const res = await ask(pods, { limits: { uploadGraceMs: 1, uploadProgressMs: 60, uploadMinBytesPerSec: 1000 } }, '/', upload(body))
    assert.equal(res.status, 200)
  })
})

describe('a version 2 pod that does not say what it accepts', () => {
  it('is treated as version 1: GET and HEAD only, whatever method the ingress carries', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const seen = []
    pods.p.api.serveProtocol('http', (channel) => {
      channel.onRequest('fetch', async (params) => { seen.push(params.method); return { status: 200, headers: [], body: false } })
      createStreamLayer(channel).onStream((reader) => { reader.bytes().catch(() => {}) })
    }, { versions: [2, 1] })
    grantHttp(pods)
    const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }) })
    cleanups.push(() => mesh.close())
    const code = async (method, body) => mesh.handle(new Request('http://a.test/', { method, body }))
    assert.equal((await code('GET')).status, 200)
    const post = await code('POST', 'x')
    assert.equal(post.status, 405)
    assert.equal(post.headers.get('allow'), 'GET, HEAD')
    assert.equal((await code('PURGE')).status, 405)
    assert.deepEqual(seen, ['GET'])
  })
})

describe('what a pod receives by default, to defend itself across sites', () => {
  it('the browser-set Origin, Referer and Sec-Fetch-* headers are forwarded by default; cookies and Authorization are not', async () => {
    const seen = deferred()
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, (request) => { seen.resolve(Object.fromEntries(request.headers)); return new Response('ok') }, { allowFrom: [pods.ingress.podId] })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    const headers = { origin: 'https://evil.test', referer: 'https://evil.test/x', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', 'sec-fetch-user': '?1', cookie: 'a=1', authorization: 'Bearer t' }
    await ask(pods, {}, '/', { method: 'POST', body: 'x', headers })
    const got = await seen.promise
    for (const name of ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']) assert.equal(got[name], headers[name], name)
    assert.equal(got.cookie, undefined)
    assert.equal(got.authorization, undefined)
    for (const name of ['origin', 'referer', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user']) assert.ok(DEFAULT_FORWARD_REQUEST_HEADERS.includes(name), name)
  })
})

describe('the held-body fallback is bounded on its own', () => {
  it('a runtime that cannot stream is told so in `capabilities` (a smaller cap, fewer uploads), and refuses over it with a 413', async () => {
    const RealRequest = globalThis.Request
    class StringifyingRequest extends RealRequest {
      static [Symbol.hasInstance](x) { return x instanceof RealRequest }
      constructor(input, init = {}) {
        if (init.body instanceof ReadableStream) { const { duplex, ...rest } = init; void duplex; super(input, { ...rest, body: String(init.body), headers: { ...Object.fromEntries(new Headers(init.headers)), 'content-type': 'text/plain;charset=UTF-8' } }) } else super(input, init)
      }
    }
    const fresh = await import('../src/provider.mjs?held-fallback')
    globalThis.Request = StringifyingRequest
    try {
      const pods = await threePods()
      cleanups.push(() => pods.teardown())
      const served = fresh.serveHttpOnMesh(pods.p, async (request) => new Response(String((await request.arrayBuffer()).byteLength)), { allowFrom: [pods.ingress.podId], limits: { maxHeldBodyBytes: 2000 } })
      cleanups.push(() => served.stop())
      grantHttp(pods)
      const channel = await pods.i.api.openProtocol(pods.provider.podId, 'http', { versions: [2, 1] })
      assert.deepEqual(await channel.request('capabilities', {}), { default: { methods: '*', maxBodyBytes: 2000 }, services: {}, maxUploads: 2 })
      await channel.close('done')
      const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }) })
      cleanups.push(() => mesh.close())
      const put = (n) => mesh.handle(new RealRequest('http://x.test/', { method: 'PUT', body: new Uint8Array(n).fill(1) }))
      assert.equal(await (await put(1500)).text(), '1500')
      const over = await put(3000)
      assert.equal(over.status, 413)
      assert.equal(over.headers.get(REASON_HEADER), 'body-too-large')
    } finally { globalThis.Request = RealRequest }
  })
})

describe('many tiny chunks cost bytes, not objects or frames', () => {
  it('the collector holds a million one-byte chunks in a few blocks', () => {
    const c = createCollector()
    for (let i = 0; i < 1_000_000; i++) c.add(new Uint8Array([i & 255]))
    assert.ok(c.parts.length < 40, `${c.parts.length} parts`)
    const out = c.finish()
    assert.equal(out.byteLength, 1_000_000)
    assert.ok(out.every((b, i) => b === (i & 255)))
  })

  const oneByte = (n) => { let i = 0; return new ReadableStream({ pull(c) { if (i >= n) return c.close(); c.enqueue(new Uint8Array([i++ & 255])) } }, { highWaterMark: 0 }) }
  const wireTap = (pods) => {
    const frames = []
    for (const node of [pods.ingress, pods.provider]) { const o = node.sendTo; node.sendTo = async (to, data) => { frames.push(typeof data?.f === 'string' ? Buffer.from(data.f, 'base64').toString('latin1') : ''); return o(to, data) } }
    return frames
  }

  it('streaming: 20 000 one-byte chunks make a handful of frames and arrive exactly', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const frames = wireTap(pods)
    const served = serveHttpOnMesh(pods.p, async (request) => { const b = new Uint8Array(await request.arrayBuffer()); return new Response(`${b.byteLength}:${b.every((x, i) => x === (i & 255))}`) }, { allowFrom: [pods.ingress.podId] })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    const res = await ask(pods, {}, '/', { method: 'POST', body: oneByte(20_000), duplex: 'half' })
    assert.equal(await res.text(), '20000:true')
    const data = frames.filter((f) => f.includes('http/stream.data')).length
    assert.ok(data < 60, `${data} data frames`)
  })

  it('held: one-byte chunks for an older pod arrive exactly', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, async (request) => { const b = new Uint8Array(await request.arrayBuffer()); return new Response(`${b.byteLength}:${b.every((x, i) => x === (i & 255))}`) }, { allowFrom: [pods.ingress.podId], versions: [1] })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    const res = await ask(pods, { methods: ['GET', 'POST'] }, '/', { method: 'POST', body: oneByte(100_000), duplex: 'half' })
    assert.equal(await res.text(), '100000:true')
  })
})
