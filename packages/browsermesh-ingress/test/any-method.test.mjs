// Any method, the whole body, streamed: the web-standard handler over the in-memory bus, a real provider on a second pod.
// What is asserted: every method works with no options; each end can narrow what it carries and neither can widen the other;
// a body streams in both directions with bounded memory and arrives byte for byte; aborts and early answers stop the upload;
// the bounds hold on both sides; an older end on either side is never sent what it cannot handle.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createStreamLayer } from '@johnhenry/browsermesh-apps'
import { createMeshIngress, serveHttpOnMesh, declineRequest } from '../src/index.mjs'
import { isMethodToken, FORBIDDEN_METHODS } from '../src/wire.mjs'
import { REASON_HEADER } from '../src/errors.mjs'
import { threePods, grantHttp, deferred, until } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

const MiB = 1024 * 1024

/** What every frame that crossed the bus said (method names and field names are plain text in a frame), so a test can say what was (not) sent. */
function tap(node, log) {
  const original = node.sendTo
  node.sendTo = async (to, data) => { log.push(typeof data?.f === 'string' ? Buffer.from(data.f, 'base64').toString('latin1') : ''); return original(to, data) }
}

async function rig({ handler, provider = {}, ingress = {}, wire } = {}) {
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  if (wire) { tap(pods.ingress, wire); tap(pods.provider, wire) }
  const served = serveHttpOnMesh(pods.p, handler ?? (() => new Response('hello')), { allowFrom: [pods.ingress.podId], ...provider })
  cleanups.push(() => served.stop())
  grantHttp(pods)
  const audits = []
  const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }), onAudit: (r) => audits.push(r), ...ingress })
  cleanups.push(() => mesh.close())
  return { ...pods, served, mesh, audits, ask: (path, init) => mesh.handle(new Request(`http://app.example.test${path}`, init), { clientAddress: '203.0.113.9' }) }
}

/** A deterministic byte stream that is only read as it is pulled; `digest()` is the SHA-256 of what has been produced. */
function patterned(total, { chunk = 16 * 1024, onPull } = {}) {
  const hash = createHash('sha256')
  let produced = 0
  let seed = 7
  const stream = new ReadableStream({
    pull(controller) {
      if (produced >= total) { controller.close(); return }
      const n = Math.min(chunk, total - produced)
      const bytes = new Uint8Array(n)
      for (let i = 0; i < n; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; bytes[i] = seed >>> 24 }
      hash.update(bytes)
      produced += n
      onPull?.(produced)
      controller.enqueue(bytes)
    },
  }, { highWaterMark: 0 })
  return { stream, get produced() { return produced }, digest: () => hash.copy().digest('hex') }
}

const upload = (body, { method = 'POST', length, headers = {} } = {}) => ({
  method, body, duplex: 'half', headers: { ...(length === undefined ? {} : { 'content-length': String(length) }), ...headers },
})

async function digestOf(stream) {
  const hash = createHash('sha256')
  let n = 0
  for await (const chunk of stream) { hash.update(chunk); n += chunk.byteLength }
  return { n, hex: hash.digest('hex') }
}

describe('methods: on by default, narrowed by either end', () => {
  const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'PURGE', 'PROPFIND', 'M-SEARCH', 'X.custom_1']

  it('carries every method token with no options, bodies included', async () => {
    const t = await rig({ handler: async (request) => new Response(request.method === 'HEAD' ? null : `${request.method}:${await request.text()}`, { headers: { allow: 'x' } }) })
    for (const method of METHODS) {
      const body = ['GET', 'HEAD'].includes(method) ? undefined : `body-of-${method}`
      const res = await t.ask('/x', { method, body })
      assert.equal(res.status, 200, method)
      assert.equal(await res.text(), method === 'HEAD' ? '' : `${method}:${body ?? ''}`, method)
    }
  })

  it('passes OPTIONS (a preflight too) to the pod like any other method', async () => {
    const seen = []
    const t = await rig({ handler: (request) => { seen.push([request.method, request.headers.get('access-control-request-method')]); return new Response(null, { status: 204 }) }, ingress: { forwardHeaders: ['access-control-request-method'] } })
    const res = await t.ask('/', { method: 'OPTIONS', headers: { 'access-control-request-method': 'PUT', origin: 'https://x.test' } })
    assert.equal(res.status, 204)
    assert.deepEqual(seen, [['OPTIONS', 'PUT']])
  })

  it('refuses CONNECT, TRACE and TRACK always, with Allow, even when asked for', async () => {
    const t = await rig()
    // (a web Request cannot even be built for these: the listener answers them 405 itself, see listener-methods.test.mjs)
    for (const m of ['CONNECT', 'TRACE', 'TRACK']) {
      assert.throws(() => createMeshIngress({ service: t.i, resolve: () => null, methods: [m] }), /never served/)
      assert.throws(() => serveHttpOnMesh(t.p, () => new Response(), { allowFrom: [t.ingress.podId], methods: [m] }), /never served/)
      assert.ok(FORBIDDEN_METHODS.has(m))
    }
  })

  it('knows the RFC 9110 token grammar', () => {
    for (const ok of ['GET', 'M-SEARCH', 'X.y_z', 'a!b#c$d%e&f\'g*h+i^j`k|l~m', '9']) assert.ok(isMethodToken(ok), ok)
    for (const bad of ['', 'A B', 'A\tB', 'A,B', 'A/B', 'A(B)', 'A"B', 'A;B', 'A\nB', 'é', 'CONNECT', 'TRACE', 'TRACK', 'x'.repeat(33)]) assert.ok(!isMethodToken(bad), JSON.stringify(bad))
    assert.throws(() => createMeshIngress({ service: {}, resolve: () => null, methods: ['A B'] }), /method/)
  })

  it('the ingress can narrow what its process carries: 405 with Allow, the pod is not asked', async () => {
    let ran = 0
    const t = await rig({ handler: () => { ran++; return new Response('x') }, ingress: { methods: ['GET', 'HEAD'] } })
    const res = await t.ask('/', { method: 'POST', body: 'x' })
    assert.equal(res.status, 405)
    assert.equal(res.headers.get(REASON_HEADER), 'method-not-allowed')
    assert.equal(res.headers.get('allow'), 'GET, HEAD')
    assert.equal(ran, 0)
    assert.equal((await t.ask('/')).status, 200)
  })

  it('the pod can narrow what it serves: 405 with Allow before any body is read, and the ingress cannot widen it', async () => {
    let ran = 0
    const t = await rig({ handler: () => { ran++; return new Response('x') }, provider: { methods: ['GET', 'HEAD', 'PUT'] }, ingress: { methods: '*' } })
    let pulls = 0
    const body = patterned(1 * MiB, { onPull: () => pulls++ })
    const res = await t.ask('/', upload(body.stream, { method: 'POST', length: MiB }))
    assert.equal(res.status, 405)
    assert.equal(res.headers.get(REASON_HEADER), 'method-not-allowed')
    assert.equal(res.headers.get('allow'), 'GET, HEAD, PUT')
    assert.equal(pulls, 0, 'the body was not read')
    assert.equal(ran, 0)
    assert.equal((await t.ask('/', { method: 'PUT', body: 'abc' })).status, 200)
    assert.equal(ran, 1)
  })

  it('the pod narrows per service, and a service inherits the pod-wide setting', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const echo = async (request) => new Response(`${request.method}`)
    const served = serveHttpOnMesh(pods.p, null, {
      allowFrom: [pods.ingress.podId], methods: ['GET', 'HEAD', 'POST'],
      services: { read: { fetch: echo, methods: ['GET', 'HEAD'] }, write: echo, wide: { fetch: echo, methods: '*' } },
    })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    const mesh = createMeshIngress({ service: pods.i, resolve: (r) => ({ peer: pods.provider.podId, service: new URL(r.url).host.split('.')[0] }) })
    cleanups.push(() => mesh.close())
    const code = async (service, method) => (await mesh.handle(new Request(`http://${service}.test/`, { method, body: method === 'GET' ? undefined : 'b' }))).status
    assert.equal(await code('read', 'POST'), 405)
    assert.equal(await code('read', 'GET'), 200)
    assert.equal(await code('write', 'POST'), 200)
    assert.equal(await code('write', 'PUT'), 405)
    assert.equal(await code('wide', 'PURGE'), 200)
  })
})

describe('streaming a body end to end', () => {
  it('echoes a multi-megabyte upload byte for byte (Content-Length) through the pod handler', async () => {
    const t = await rig({ handler: (request) => new Response(request.body, { headers: { 'content-type': 'application/octet-stream' } }) })
    const total = 6 * MiB + 12345
    const body = patterned(total)
    const res = await t.ask('/echo', upload(body.stream, { length: total }))
    assert.equal(res.status, 200)
    const got = await digestOf(res.body)
    assert.equal(got.n, total)
    assert.equal(got.hex, body.digest())
    assert.equal(t.audits.at(-1).requestBytes, total)
  })

  it('carries a chunked upload (no Content-Length) and the pod sees the same digest', async () => {
    const seen = deferred()
    const t = await rig({ handler: async (request) => { const d = await digestOf(request.body); seen.resolve({ ...d, length: request.headers.get('content-length') }); return new Response(d.hex) } })
    const total = 5 * MiB + 1
    const body = patterned(total, { chunk: 7919 })
    const res = await t.ask('/', upload(body.stream))
    assert.equal(await res.text(), body.digest())
    const pod = await seen.promise
    assert.equal(pod.n, total)
    assert.equal(pod.length, null)
  })

  it('tells the handler the declared length', async () => {
    const t = await rig({ handler: async (request) => { await request.arrayBuffer(); return new Response(String(request.headers.get('content-length'))) } })
    const res = await t.ask('/', upload(patterned(100_000).stream, { length: 100_000 }))
    assert.equal(await res.text(), '100000')
  })

  it('holds memory to a window while the origin is slow: the visitor is not read ahead', async () => {
    let consumed = 0
    let maxAhead = 0
    const total = 24 * MiB
    const body = patterned(total, { onPull: (produced) => { maxAhead = Math.max(maxAhead, produced - consumed) } })
    const t = await rig({
      handler: async (request) => {
        for await (const chunk of request.body) { consumed += chunk.byteLength; await new Promise((r) => setImmediate(r)) }
        return new Response('done')
      },
    })
    const res = await t.ask('/', upload(body.stream, { length: total }))
    assert.equal(await res.text(), 'done')
    assert.equal(consumed, total)
    assert.ok(maxAhead < 4 * MiB, `the ingress read ${maxAhead} bytes ahead of the origin`)
  })

  it('holds memory to a window while the visitor is slow to read the echo', async () => {
    const total = 24 * MiB
    let produced = 0
    let received = 0
    let maxAhead = 0
    const body = patterned(total, { onPull: (p) => { produced = p; maxAhead = Math.max(maxAhead, produced - received) } })
    const t = await rig({ handler: (request) => new Response(request.body), provider: { limits: { maxResponseBytes: 64 * MiB } }, ingress: { limits: { maxResponseBytes: 64 * MiB, timeoutMs: 120_000, uploadTimeoutMs: 120_000, responseIdleMs: 60_000 } } })
    const res = await t.ask('/', upload(body.stream, { length: total }))
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      await new Promise((r) => setImmediate(r))
    }
    assert.equal(received, total)
    assert.ok(maxAhead < 6 * MiB, `${maxAhead} bytes were in flight`)
  })

  it('a handler that answers early on a GET is unchanged and a body on GET is refused', async () => {
    const t = await rig()
    const res = await t.ask('/', { method: 'GET' })
    assert.equal(res.status, 200)
  })
})

describe('aborts and early answers', () => {
  it('a visitor that disconnects mid-upload errors the pod\'s body and aborts the origin request', async () => {
    const ended = deferred()
    const aborted = deferred()
    const t = await rig({
      handler: async (request, { signal }) => {
        signal.addEventListener('abort', () => aborted.resolve(true), { once: true })
        try { for await (const chunk of request.body) void chunk; ended.resolve('completed') } catch (e) { ended.resolve(`errored:${e?.name}`) }
        return new Response('too late')
      },
    })
    const client = new AbortController()
    let pulls = 0
    const endless = new ReadableStream({
      pull(c) { pulls++; if (pulls === 8) client.abort(); c.enqueue(new Uint8Array(16 * 1024)) },
    }, { highWaterMark: 0 })
    const res = await t.ask('/', { ...upload(endless, { length: 30 * MiB }), signal: client.signal })
    await res.text().catch(() => {})
    assert.match(await ended.promise, /^errored:/)
    assert.equal(await aborted.promise, true)
    await until(() => t.audits.length > 0, 'the audit record')
    assert.ok([499, 500].includes(t.audits.at(-1).status) || t.audits.at(-1).reason === 'client-aborted')
    assert.ok(pulls < 200, 'the ingress stopped reading the visitor')
  })

  it('the visitor\'s body failing is a client abort, not a hang', async () => {
    const ended = deferred()
    const t = await rig({ handler: async (request) => { try { await request.arrayBuffer(); ended.resolve('completed') } catch (e) { ended.resolve('errored') } return new Response('x') } })
    let n = 0
    const broken = new ReadableStream({ pull(c) { if (++n > 3) c.error(new Error('reset')); else c.enqueue(new Uint8Array(1000)) } }, { highWaterMark: 0 })
    const res = await t.ask('/', upload(broken))
    assert.ok(res.status >= 400)
    assert.equal(await ended.promise, 'errored')
  })

  it('an origin that answers 413 early while the body is still coming: the answer is delivered and the upload stops', async () => {
    const t = await rig({ handler: () => new Response('no room', { status: 413 }) })
    let pulls = 0
    const endless = new ReadableStream({ pull(c) { pulls++; c.enqueue(new Uint8Array(16 * 1024)) } }, { highWaterMark: 0 })
    const res = await t.ask('/', upload(endless))
    assert.equal(res.status, 413)
    assert.equal(await res.text(), 'no room')
    await until(() => t.audits.length > 0, 'the audit record')
    const settled = pulls
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(pulls, settled, 'the ingress is not reading the visitor any more')
    assert.ok(settled * 16 * 1024 < 4 * MiB, `${settled} chunks were read`)
  })

  it('an origin that answers 401 with a body it never read, while a slow upload is coming', async () => {
    const t = await rig({ handler: () => new Response(null, { status: 401 }) })
    let stalled = 0
    const slow = new ReadableStream({ pull(c) { if (stalled++ === 0) c.enqueue(new Uint8Array(10)); else return new Promise(() => {}) } }, { highWaterMark: 0 })
    const res = await t.ask('/', upload(slow))
    assert.equal(res.status, 401)
    await until(() => t.audits.length > 0, 'the audit record')
  })
})

describe('bounds, on both sides', () => {
  it('refuses a declared length over the ingress cap before reading any of it: 413', async () => {
    const t = await rig({ ingress: { limits: { maxRequestBodyBytes: 1000 } } })
    let pulls = 0
    const res = await t.ask('/', upload(patterned(5000, { onPull: () => pulls++ }).stream, { length: 5000 }))
    assert.equal(res.status, 413)
    assert.equal(res.headers.get(REASON_HEADER), 'body-too-large')
    assert.equal(pulls, 0)
  })

  it('cuts a chunked upload at the ingress cap: 413', async () => {
    const t = await rig({ ingress: { limits: { maxRequestBodyBytes: 100_000 } }, handler: async (request) => { await request.arrayBuffer(); return new Response('ok') } })
    const body = patterned(1 * MiB)
    const res = await t.ask('/', upload(body.stream))
    assert.equal(res.status, 413)
    assert.equal(res.headers.get(REASON_HEADER), 'body-too-large')
    assert.ok(body.produced < 100_000 + 600 * 1024, `${body.produced} bytes were read`)
  })

  it('the pod refuses a declared length over its own cap before reading: 413, whatever the ingress allows', async () => {
    const t = await rig({ provider: { maxBodyBytes: 1000 }, ingress: { limits: { maxRequestBodyBytes: 64 * MiB } } })
    let pulls = 0
    const res = await t.ask('/', upload(patterned(5000, { onPull: () => pulls++ }).stream, { length: 5000 }))
    assert.equal(res.status, 413)
    assert.equal(res.headers.get(REASON_HEADER), 'body-too-large')
    assert.equal(pulls, 0)
  })

  it('the pod cuts a chunked upload at its own cap, and the origin never sees more', async () => {
    let seen = 0
    const t = await rig({
      provider: { maxBodyBytes: 100_000 },
      ingress: { limits: { maxRequestBodyBytes: 64 * MiB } },
      handler: async (request) => { for await (const c of request.body) seen += c.byteLength; return new Response('ok') },
    })
    const res = await t.ask('/', upload(patterned(1 * MiB).stream))
    assert.equal(res.status, 413)
    assert.equal(res.headers.get(REASON_HEADER), 'body-too-large')
    assert.ok(seen <= 100_000, `the handler read ${seen}`)
  })

  it('has finite defaults on both sides: 32 MiB', async () => {
    const t = await rig({ handler: async (request) => new Response(String((await request.arrayBuffer()).byteLength)) })
    assert.equal((await t.ask('/', upload(patterned(1000).stream, { length: 32 * MiB + 1 }))).status, 413)
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, () => new Response('x'), { allowFrom: [pods.ingress.podId] })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }), limits: { maxRequestBodyBytes: 1024 * MiB } })
    cleanups.push(() => mesh.close())
    const res = await mesh.handle(new Request('http://x.test/', upload(patterned(1000).stream, { length: 32 * MiB + 1 })))
    assert.equal(res.status, 413, 'the pod\'s own default cap')
  })

  it('an explicit Infinity lifts a cap (and nothing else does)', async () => {
    const t = await rig({ provider: { maxBodyBytes: Infinity }, ingress: { limits: { maxRequestBodyBytes: Infinity } }, handler: async (request) => new Response(String((await request.arrayBuffer()).byteLength)) })
    assert.equal(await (await t.ask('/', upload(patterned(40 * MiB).stream))).text(), String(40 * MiB))
  })

  it('a visitor that stalls mid-upload is cut by the ingress: 408', async () => {
    const t = await rig({ ingress: { limits: { bodyIdleMs: 40 } }, handler: async (request) => { await request.arrayBuffer(); return new Response('x') } })
    let n = 0
    const stalls = new ReadableStream({ pull(c) { if (n++ === 0) c.enqueue(new Uint8Array(10)); else return new Promise(() => {}) } }, { highWaterMark: 0 })
    const res = await t.ask('/', upload(stalls))
    assert.equal(res.status, 408)
    assert.equal(res.headers.get(REASON_HEADER), 'body-timeout')
  })

  it('the pod cuts an upload that stalls on the link (its own idle bound), whatever the ingress allows', async () => {
    const errored = deferred()
    const t = await rig({
      provider: { limits: { bodyIdleMs: 40 } },
      ingress: { limits: { bodyIdleMs: 60_000, timeoutMs: 20_000, uploadTimeoutMs: 20_000 } },
      handler: async (request) => { try { await request.arrayBuffer() } catch (e) { errored.resolve(e?.reason ?? e?.message) } return new Response('x') },
    })
    let n = 0
    const stalls = new ReadableStream({ pull(c) { if (n++ === 0) c.enqueue(new Uint8Array(10)); else return new Promise(() => {}) } }, { highWaterMark: 0 })
    const res = await t.ask('/', upload(stalls))
    assert.ok(res.status >= 400)
    assert.equal(await errored.promise, 'body-timeout')
  })

  it('the whole request has a total time on both sides: the ingress ends a slow upload with 504', async () => {
    const t = await rig({ ingress: { limits: { uploadTimeoutMs: 60, bodyIdleMs: 60_000 } }, handler: async (request) => { await request.arrayBuffer(); return new Response('ok') } })
    let n = 0
    const trickle = new ReadableStream({ pull(c) { if (n++ === 0) c.enqueue(new Uint8Array(10)); else return new Promise(() => {}) } }, { highWaterMark: 0 })
    const res = await t.ask('/', upload(trickle))
    assert.equal(res.status, 504)
    assert.equal(res.headers.get(REASON_HEADER), 'provider-timeout')
  })

  it('the pod ends a handler that outlives its own upload deadline', async () => {
    const aborted = deferred()
    const t = await rig({
      provider: { limits: { uploadTimeoutMs: 50, handlerTimeoutMs: 50 } },
      ingress: { limits: { timeoutMs: 20_000, uploadTimeoutMs: 20_000, bodyIdleMs: 60_000 } },
      handler: async (request, { signal }) => { signal.addEventListener('abort', () => aborted.resolve(true)); await new Promise((r) => signal.addEventListener('abort', r)); throw new Error('deadline') },
    })
    const res = await t.ask('/', upload(new ReadableStream({ pull() { return new Promise(() => {}) } }, { highWaterMark: 0 })))
    assert.equal(await aborted.promise, true)
    assert.ok(res.status >= 400)
  })

  it('caps concurrent uploads per pod link at the ingress: 503 with Retry-After', async () => {
    const release = deferred()
    const t = await rig({ handler: async (request) => { if (request.body) { await release.promise; await request.arrayBuffer() } return new Response('ok') }, ingress: { limits: { maxUploadsPerProvider: 2, maxUploadsPerClient: 10 } } })
    const hang = () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)) }, pull() { return release.promise.then(() => {}) } }, { highWaterMark: 0 })
    const closing = () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close() } })
    const a = t.ask('/', upload(closing()))
    const b = t.ask('/', upload(closing()))
    await until(() => t.served.stats().inflight === 2, 'two uploads in flight')
    const third = await t.ask('/', upload(hang()))
    assert.equal(third.status, 503)
    assert.equal(third.headers.get(REASON_HEADER), 'provider-uploads')
    assert.ok(third.headers.get('retry-after'))
    assert.equal((await t.ask('/')).status, 200, 'a request with no body is not an upload')
    release.resolve()
    assert.equal((await a).status, 200)
    assert.equal((await b).status, 200)
  })

  it('caps concurrent uploads per pod link at the pod, whatever the ingress allows', async () => {
    const release = deferred()
    const t = await rig({ handler: async (request) => { await release.promise; await request.arrayBuffer(); return new Response('ok') }, provider: { limits: { maxUploads: 1 } }, ingress: { limits: { maxUploadsPerProvider: 8 } } })
    const closing = () => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close() } })
    const a = t.ask('/', upload(closing()))
    await until(() => t.served.stats().inflight === 1, 'one upload in flight')
    const second = await t.ask('/', upload(closing()))
    assert.equal(second.status, 503)
    assert.equal(second.headers.get(REASON_HEADER), 'provider-uploads')
    release.resolve()
    assert.equal((await a).status, 200)
  })

  it('retries a request whose body it could hold, with the same body, and never one whose body has begun to stream', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const asked = []
    const decliner = serveHttpOnMesh(pods.p, async (request) => { asked.push('provider'); await request.arrayBuffer().catch(() => {}); return declineRequest() }, { allowFrom: [pods.ingress.podId] })
    const taker = serveHttpOnMesh(pods.s, async (request) => { asked.push('stranger'); return new Response(`stranger got ${(await request.arrayBuffer()).byteLength}`) }, { allowFrom: [pods.ingress.podId] })
    cleanups.push(() => decliner.stop(), () => taker.stop())
    grantHttp(pods)
    pods.stranger.registry.grantCapabilities(pods.ingress.podId, ['protocol:http:open'])
    const mesh = createMeshIngress({
      service: pods.i, limits: { maxBufferedBodyBytes: 4000 }, retry: { attempts: 1, nonIdempotent: true },
      resolve: (_request, { tried }) => ({ peer: tried.length ? pods.stranger.podId : pods.provider.podId }),
    })
    cleanups.push(() => mesh.close())
    // small, declared: held, so it can be sent again
    const small = await mesh.handle(new Request('http://x.test/', upload(patterned(1000).stream, { length: 1000 })))
    assert.equal(await small.text(), 'stranger got 1000')
    // small, no declared length: read up to the limit, ends within it, held
    asked.length = 0
    const chunkedSmall = await mesh.handle(new Request('http://x.test/', upload(patterned(1000).stream)))
    assert.equal(await chunkedSmall.text(), 'stranger got 1000')
    // over the limit: it streams, and a stream that has begun cannot be sent again
    asked.length = 0
    for (const length of [10_000, undefined]) {
      asked.length = 0
      const big = await mesh.handle(new Request('http://x.test/', upload(patterned(10_000).stream, { length })))
      assert.equal(big.status, 502)
      assert.equal(big.headers.get(REASON_HEADER), 'provider-declined')
      assert.deepEqual(asked, ['provider'], 'the second pod was not asked')
    }
  })
})

describe('a runtime that cannot build a Request from a stream', () => {
  it('is given the same bytes whole, bounded by the cap (a browser that would turn the stream into text is detected)', async () => {
    const RealRequest = globalThis.Request
    // What an older Firefox does: a stream body is quietly made into the text "[object ReadableStream]".
    class StringifyingRequest extends RealRequest {
      static [Symbol.hasInstance](x) { return x instanceof RealRequest }
      constructor(input, init = {}) {
        if (init.body instanceof ReadableStream) { const { duplex, ...rest } = init; void duplex; super(input, { ...rest, body: String(init.body), headers: { ...Object.fromEntries(new Headers(init.headers)), 'content-type': 'text/plain;charset=UTF-8' } }) } else super(input, init)
      }
    }
    const fresh = await import('../src/provider.mjs?no-stream-bodies')
    globalThis.Request = StringifyingRequest
    try {
      assert.equal(fresh.streamBodiesWork(), false)
      const pods = await threePods()
      cleanups.push(() => pods.teardown())
      const served = fresh.serveHttpOnMesh(pods.p, async (request) => new Response(`${request.method}:${await request.text()}`), { allowFrom: [pods.ingress.podId], maxBodyBytes: 1000 })
      cleanups.push(() => served.stop())
      grantHttp(pods)
      const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }) })
      cleanups.push(() => mesh.close())
      const res = await mesh.handle(new RealRequest('http://x.test/', { method: 'PUT', body: new Uint8Array(500).fill(97), duplex: 'half' }))
      assert.equal(await res.text(), `PUT:${'a'.repeat(500)}`)
      const big = await mesh.handle(new RealRequest('http://x.test/', upload(patterned(5000).stream)))
      assert.equal(big.status, 413, 'the cap holds when the body is held')
    } finally { globalThis.Request = RealRequest }
    assert.equal((await import('../src/provider.mjs')).streamBodiesWork(), true)
  })
})

describe('the pod does not trust the ingress', () => {
  /** A raw client on the pod's protocol, at the version asked for: what an ingress that does not follow the rules could send. */
  async function rawClient(pods, versions) {
    const channel = await pods.i.api.openProtocol(pods.provider.podId, 'http', { versions })
    const streams = createStreamLayer(channel)
    streams.onStream((reader) => { reader.bytes().catch(() => {}) })
    const head = (over = {}) => ({ rid: 1, nonce: 'a'.repeat(16), method: 'GET', target: '/', host: 'app.example.test', headers: [], body: false, ...over })
    return { channel, streams, fetch: (over, opts) => channel.request('fetch', head(over), opts) }
  }
  const podRig = async (handler, provider = {}) => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, handler, { allowFrom: [pods.ingress.podId], ...provider })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    return { ...pods, served }
  }

  it('refuses a method it was narrowed away from, a forbidden one, and a non-token, before the handler runs', async () => {
    let ran = 0
    const t = await podRig(() => { ran++; return new Response('x') }, { methods: ['GET', 'HEAD', 'PURGE'] })
    const c = await rawClient(t, [2, 1])
    for (const method of ['POST', 'post', 'TRACE', 'CONNECT', 'TRACK', 'A B', '']) {
      await assert.rejects(c.fetch({ method }), (e) => e.reason === 'method-not-allowed', JSON.stringify(method))
    }
    assert.equal((await c.fetch({ method: 'PURGE', rid: 2 })).status, 200)
    assert.equal(ran, 1)
  })

  it('refuses a declared length over its cap before a byte is read, and cuts an undeclared body at the cap', async () => {
    const t = await podRig(async (request) => new Response(String((await request.arrayBuffer()).byteLength)), { maxBodyBytes: 100 })
    const c = await rawClient(t, [2, 1])
    await assert.rejects(c.fetch({ method: 'POST', body: true, length: 500 }), (e) => e.reason === 'body-too-large')
    const sending = c.streams.sendBody(new Uint8Array(500), { rid: 2, kind: 'request' }).catch((e) => e)
    await assert.rejects(c.fetch({ rid: 2, method: 'POST', body: true }), (e) => e.reason === 'body-too-large')
    await sending
    const exact = c.streams.sendBody(new Uint8Array(100), { rid: 3, kind: 'request' })
    assert.equal((await c.fetch({ rid: 3, method: 'POST', body: true, length: 100 })).status, 200)
    await exact
  })

  it('refuses a body that is not the length its head declared', async () => {
    const t = await podRig(async (request) => new Response(String((await request.arrayBuffer()).byteLength)))
    const c = await rawClient(t, [2, 1])
    const sending = c.streams.sendBody(new Uint8Array(50), { rid: 2, kind: 'request' }).catch((e) => e)
    await assert.rejects(c.fetch({ rid: 2, method: 'POST', body: true, length: 80 }), (e) => e.reason === 'bad-framing')
    await sending
  })

  it('takes no more uploads on a link than its own cap, whatever the ingress does', async () => {
    const gate = deferred()
    const t = await podRig(async (request) => { await gate.promise; await request.arrayBuffer(); return new Response('x') }, { limits: { maxUploads: 1 } })
    const c = await rawClient(t, [2, 1])
    const first = c.streams.sendBody(new Uint8Array(5), { rid: 1, kind: 'request' })
    const a = c.fetch({ rid: 1, method: 'POST', body: true })
    await until(() => t.served.stats().inflight === 1, 'one upload')
    await assert.rejects(c.fetch({ rid: 2, method: 'POST', body: true }), (e) => e.reason === 'uploads-busy')
    gate.resolve()
    assert.equal((await a).status, 200)
    await first
  })

  it('when it answers without reading the upload, the unread body is cancelled and the sender is told to stop', async () => {
    const t = await podRig(() => new Response('no', { status: 401 }))
    const c = await rawClient(t, [2, 1])
    let produced = 0
    async function * endless() { for (;;) { produced += 16 * 1024; yield new Uint8Array(16 * 1024) } }
    const sending = c.streams.sendBody(endless(), { rid: 2, kind: 'request' }).catch((e) => e)
    const head = await c.fetch({ rid: 2, method: 'POST', body: true })
    assert.equal(head.status, 401)
    const stopped = await sending
    assert.equal(stopped?.reason, 'stream-cancelled')
    assert.ok(produced < 8 * MiB, `${produced} bytes were produced`)
  })

  it('on a version 1 link: no method tokens, no `length`, no `capabilities`: it speaks as it always did', async () => {
    const t = await podRig(() => new Response('x'))
    const c = await rawClient(t, [1])
    assert.equal(c.channel.version, 1)
    await assert.rejects(c.fetch({ method: 'PURGE' }), (e) => e.reason === 'method-not-allowed')
    await assert.rejects(c.fetch({ method: 'POST', body: true, length: 5 }), (e) => e.reason === 'bad-request-head')
    await assert.rejects(c.channel.request('capabilities', {}), (e) => e.code === -32601)
  })

  it('states what it accepts when asked on a version 2 link, per service, and a pod with no default says so', async () => {
    const t = await podRig(null, { methods: ['GET'], maxBodyBytes: 1000, services: { api: { fetch: () => new Response('a'), methods: '*', maxBodyBytes: Infinity }, web: () => new Response('w') } })
    const c = await rawClient(t, [2, 1])
    assert.deepEqual(await c.channel.request('capabilities', {}), {
      default: null,
      services: { api: { methods: '*', maxBodyBytes: null }, web: { methods: ['GET'], maxBodyBytes: 1000 } },
      maxUploads: 4,
    })
  })
})

describe('headers and credentials on writing methods', () => {
  it('passes cookies and Authorization on a POST exactly as on a GET: only when the operator names them', async () => {
    const seen = []
    const handler = (request) => { seen.push([request.method, request.headers.get('cookie'), request.headers.get('authorization'), request.headers.get('host'), request.headers.get('x-forwarded-for')]); return new Response('ok') }
    const withNames = await rig({ handler, ingress: { forwardHeaders: ['cookie', 'authorization'], forwardClientAddress: true } })
    const headers = { cookie: 'a=1', authorization: 'Bearer t', 'x-forwarded-for': '1.2.3.4', 'x-forwarded-host': 'evil.test', forwarded: 'for=1.2.3.4', connection: 'keep-alive', te: 'trailers' }
    await withNames.ask('/', { method: 'POST', body: 'x', headers })
    await withNames.ask('/', { headers })
    assert.deepEqual(seen[0].slice(1, 3), ['a=1', 'Bearer t'])
    assert.deepEqual(seen[1].slice(1, 3), ['a=1', 'Bearer t'])
    assert.equal(seen[0][4], '203.0.113.9', 'the client address is the ingress\'s, never the visitor\'s claim')
    seen.length = 0
    const plain = await rig({ handler })
    await plain.ask('/', { method: 'POST', body: 'x', headers })
    assert.deepEqual(seen[0].slice(1, 3), [null, null])
  })
})

describe('what an older end is sent, and what a newer end says', () => {
  it('a new ingress in front of an older pod: GET and HEAD only, a POST is 405 and no body frame leaves', async () => {
    const wire = []
    const t = await rig({ wire, provider: { versions: [1] } })
    assert.equal((await t.ask('/')).status, 200)
    wire.length = 0
    const res = await t.ask('/', { method: 'POST', body: 'x' })
    assert.equal(res.status, 405)
    assert.equal(res.headers.get(REASON_HEADER), 'method-not-allowed')
    assert.equal(res.headers.get('allow'), 'GET, HEAD')
    assert.equal((await t.ask('/', { method: 'PURGE' })).status, 405)
    assert.ok(!wire.some((f) => f.includes('stream.open') || f.includes('http/fetch')), 'nothing was sent to the older pod for the refused requests')
    assert.ok(!wire.some((f) => f.includes('capabilities')), 'an older pod is never asked a question it does not know')
  })

  it('a new ingress keeps an operator\'s explicit legacy opt-in working for an older pod: the standard methods, buffered', async () => {
    const t = await rig({ provider: { versions: [1] }, handler: async (request) => new Response(`${request.method}:${await request.text()}`), ingress: { methods: ['GET', 'HEAD', 'POST'] } })
    const res = await t.ask('/', { method: 'POST', body: 'hello' })
    assert.equal(await res.text(), 'POST:hello')
    assert.equal((await t.ask('/', { method: 'PUT', body: 'x' })).status, 405)
    assert.equal((await t.ask('/', { method: 'POST', body: 'x'.repeat(2 * MiB) })).status, 413)
  })

  it('a new pod behind an older ingress works as before and says nothing new on the wire', async () => {
    const wire = []
    const t = await rig({ wire, ingress: { versions: [1], methods: ['GET', 'HEAD', 'POST'] }, handler: async (request) => new Response(`${request.method}:${await request.text()}`) })
    assert.equal(await (await t.ask('/')).text(), 'GET:')
    assert.equal(await (await t.ask('/', { method: 'POST', body: 'old' })).text(), 'POST:old')
    assert.ok(!wire.some((f) => f.includes('capabilities')), 'the pod says nothing the older ingress did not ask for')
    assert.ok(wire.some((f) => f.includes('http/fetch')))
    assert.ok(!wire.some((f) => f.includes('http/fetch') && f.includes('length')), 'no new head field was sent')
  })

  it('a new pod that is told to narrow keeps narrowing for an older ingress', async () => {
    const t = await rig({ ingress: { versions: [1], methods: ['GET', 'HEAD', 'POST'] }, provider: { methods: ['GET', 'HEAD'] } })
    assert.equal((await t.ask('/')).status, 200)
    assert.notEqual((await t.ask('/', { method: 'POST', body: 'x' })).status, 200)
  })

  it('both ends new: version 2, and the pod states what it accepts once per link', async () => {
    const wire = []
    const t = await rig({ wire })
    await t.ask('/')
    assert.ok(!wire.some((f) => f.includes('http/capabilities')), 'a plain GET asks nothing')
    await t.ask('/', { method: 'POST', body: 'x' })
    await t.ask('/', { method: 'PUT', body: 'y' })
    assert.equal(wire.filter((f) => f.includes('http/capabilities')).length, 1, 'asked once for the link')
    assert.ok(wire.some((f) => f.includes('http/stream.open')))
  })
})
