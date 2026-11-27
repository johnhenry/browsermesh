// #472 end to end: a bounded wait for an upload slot instead of an immediate 503, the early cut of an upload that cannot finish, and the
// start refusal of a declared length that cannot be sent in the deadline, each enforced by the ingress and by the pod on its own.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createMeshIngress, serveHttpOnMesh } from '../src/index.mjs'
import { REASON_HEADER } from '../src/errors.mjs'
import { httpRig, statusOf } from './helpers/http.mjs'
import { threePods, grantHttp, deferred, until } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

const upload = (body, extra = {}) => ({ method: 'POST', body, duplex: 'half', ...extra })
const closing = (n = 10) => new ReadableStream({ start(c) { c.enqueue(new Uint8Array(n)); c.close() } })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** A provider whose handler holds every upload until `gate` opens, recording the order in which uploads reach it. */
async function holdingRig({ ingress = {}, provider = {} } = {}) {
  const gate = deferred()
  const order = []
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  const served = serveHttpOnMesh(pods.p, async (request) => {
    const tag = request.headers.get('x-tag') ?? '?'
    order.push(tag)
    if (tag.startsWith('hold')) await gate.promise
    await request.arrayBuffer()
    return new Response(`done ${tag}`)
  }, { allowFrom: [pods.ingress.podId], ...provider })
  cleanups.push(() => served.stop())
  grantHttp(pods)
  const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }), ...ingress, limits: { maxUploadsPerClient: 20, ...ingress.limits } })
  cleanups.push(() => mesh.close())
  const send = (tag, client = '198.51.100.1', init = {}) => mesh.handle(new Request('http://app.example.test/', upload(closing(), { headers: { 'x-tag': tag }, ...init })), { clientAddress: client })
  return { ...pods, served, mesh, gate, order, send }
}

describe('the ingress queues an upload that finds no slot (#472)', () => {
  it('a request that finds the slots busy waits and is served when one frees, instead of a 503', async () => {
    const t = await holdingRig({ ingress: { limits: { maxUploadsPerProvider: 1 } } })
    const a = t.send('hold-a')
    await until(() => t.order.length === 1, 'a holds the slot')
    const b = t.send('b', '198.51.100.2')
    await sleep(100)
    assert.deepEqual(t.order, ['hold-a'], 'b is waiting, not sent')
    t.gate.resolve()
    assert.equal((await a).status, 200)
    const rb = await b
    assert.equal(rb.status, 200)
    assert.equal(await rb.text(), 'done b')
  })

  it('waits at most uploadQueueMs, then the 503 provider-uploads as before', async () => {
    const t = await holdingRig({ ingress: { limits: { maxUploadsPerProvider: 1, uploadQueueMs: 150 } } })
    const a = t.send('hold-a')
    await until(() => t.order.length === 1, 'a holds the slot')
    const started = Date.now()
    const b = await t.send('b', '198.51.100.2')
    assert.equal(b.status, 503)
    assert.equal(b.headers.get(REASON_HEADER), 'provider-uploads')
    assert.ok(b.headers.get('retry-after'))
    assert.ok(Date.now() - started >= 140, 'it did wait')
    t.gate.resolve()
    assert.equal((await a).status, 200)
  })

  it('beyond uploadQueueMax the 503 is at once, and the ones queued are still served', async () => {
    const t = await holdingRig({ ingress: { limits: { maxUploadsPerProvider: 1, uploadQueueMax: 1, uploadQueueMs: 5000 } } })
    const a = t.send('hold-a')
    await until(() => t.order.length === 1, 'a holds the slot')
    const b = t.send('b', '198.51.100.2')
    await sleep(50)
    const started = Date.now()
    const c = await t.send('c', '198.51.100.3')
    assert.equal(c.status, 503)
    assert.equal(c.headers.get(REASON_HEADER), 'provider-uploads')
    assert.ok(Date.now() - started < 1000, 'refused without waiting')
    t.gate.resolve()
    assert.equal((await a).status, 200)
    assert.equal((await b).status, 200)
  })

  it('uploadQueueMax 0 is the old behaviour: no wait at all', async () => {
    const t = await holdingRig({ ingress: { limits: { maxUploadsPerProvider: 1, uploadQueueMax: 0 } } })
    const a = t.send('hold-a')
    await until(() => t.order.length === 1, 'a holds the slot')
    const b = await t.send('b', '198.51.100.2')
    assert.equal(b.status, 503)
    t.gate.resolve()
    await a
  })

  it('the per-client cap counts a client\'s queued uploads together with its active ones', async () => {
    const t = await holdingRig({ ingress: { limits: { maxUploadsPerProvider: 1, maxUploadsPerClient: 2, uploadQueueMs: 5000 } } })
    const a = t.send('hold-a', '198.51.100.1')
    await until(() => t.order.length === 1, 'a holds the slot')
    const b = t.send('b', '198.51.100.1') // queued: the client has 2 (one active, one queued)
    await sleep(50)
    const c = await t.send('c', '198.51.100.1')
    assert.equal(c.status, 429)
    assert.equal(c.headers.get(REASON_HEADER), 'client-uploads')
    t.gate.resolve()
    assert.equal((await a).status, 200)
    assert.equal((await b).status, 200)
  })

  it('a queued request whose client disconnects leaves the queue at once, and frees its place', async () => {
    const t = await holdingRig({ ingress: { limits: { maxUploadsPerProvider: 1, uploadQueueMax: 1, uploadQueueMs: 5000, maxUploadsPerClient: 1 } } })
    const a = t.send('hold-a', '198.51.100.1')
    await until(() => t.order.length === 1, 'a holds the slot')
    const gone = new AbortController()
    const b = t.send('b', '198.51.100.2', { signal: gone.signal })
    await sleep(50)
    gone.abort()
    const rb = await b
    assert.equal(rb.status, 499)
    assert.equal(rb.headers.get(REASON_HEADER), 'client-aborted')
    // the queue place (and the client's slot) is free again: another client can queue, and the same one can send
    const c = t.send('c', '198.51.100.3')
    const d = await t.send('d', '198.51.100.2').then((r) => r.status, () => 'rejected')
    assert.equal(d, 503, 'the queue holds c (max 1): d is refused at once, not b\'s ghost')
    t.gate.resolve()
    assert.equal((await a).status, 200)
    assert.equal((await c).status, 200)
    assert.ok(!t.order.includes('b'), 'b was never sent')
  })

  it('serves the waiters in the order they came', async () => {
    const t = await holdingRig({ ingress: { limits: { maxUploadsPerProvider: 1, uploadQueueMax: 4, uploadQueueMs: 5000 } } })
    const a = t.send('hold-a', '198.51.100.1')
    await until(() => t.order.length === 1, 'a holds the slot')
    const rest = []
    for (const [i, tag] of ['b', 'c', 'd'].entries()) { rest.push(t.send(tag, `198.51.100.${10 + i}`)); await sleep(20) }
    t.gate.resolve()
    for (const r of [await a, ...await Promise.all(rest)]) assert.equal(r.status, 200)
    assert.deepEqual(t.order, ['hold-a', 'b', 'c', 'd'])
  })

  it('leaks nothing: after a burst with refusals and timeouts every slot is free again', async () => {
    const t = await holdingRig({ ingress: { limits: { maxUploadsPerProvider: 2, uploadQueueMax: 2, uploadQueueMs: 100 } } })
    const first = [t.send('hold-1', '198.51.100.1'), t.send('hold-2', '198.51.100.2')]
    await until(() => t.order.length === 2, 'two hold')
    const burst = await Promise.all(Array.from({ length: 6 }, (_, i) => t.send(`x${i}`, `198.51.100.${20 + i}`)))
    assert.deepEqual(burst.map((r) => r.status), [503, 503, 503, 503, 503, 503])
    t.gate.resolve()
    await Promise.all(first)
    for (let i = 0; i < 4; i++) assert.equal((await t.send(`later${i}`, `198.51.100.${40 + i}`)).status, 200)
    assert.deepEqual(t.mesh.stats?.().inflight ?? 0, 0)
  })
})

describe('the pod queues an upload that finds no slot, on its own (#472)', () => {
  it('waits for a slot, whatever the ingress allows', async () => {
    const t = await holdingRig({ ingress: { limits: { maxUploadsPerProvider: 8 } }, provider: { limits: { maxUploads: 1 } } })
    const a = t.send('hold-a')
    await until(() => t.order.length === 1, 'a holds the slot')
    const b = t.send('b', '198.51.100.2')
    await sleep(100)
    assert.deepEqual(t.order, ['hold-a'])
    t.gate.resolve()
    assert.equal((await a).status, 200)
    assert.equal((await b).status, 200)
  })

  it('refuses beyond its own queue length and after its own wait: 503 provider-uploads', async () => {
    const t = await holdingRig({ ingress: { limits: { maxUploadsPerProvider: 8 } }, provider: { limits: { maxUploads: 1, uploadQueueMax: 1, uploadQueueMs: 200 } } })
    const a = t.send('hold-a')
    await until(() => t.order.length === 1, 'a holds the slot')
    const b = t.send('b', '198.51.100.2') // queued at the pod, times out after 200 ms
    await sleep(30)
    const c = await t.send('c', '198.51.100.3') // the pod's queue is full
    assert.equal(c.status, 503)
    assert.equal(c.headers.get(REASON_HEADER), 'provider-uploads')
    const rb = await b
    assert.equal(rb.status, 503)
    assert.equal(rb.headers.get(REASON_HEADER), 'provider-uploads')
    t.gate.resolve()
    assert.equal((await a).status, 200)
  })
})

describe('a declared length that cannot be sent in the whole upload deadline is refused at the start (#472)', () => {
  const post = (length, extra = '') => `POST / HTTP/1.1\r\nHost: app.test\r\nContent-Length: ${length}\r\nConnection: close\r\n${extra}\r\n`

  it('the ingress: 413 upload-exceeds-deadline before a byte is read; exactly what fits is served', async () => {
    const t = await httpRig({ handler: async (r) => { await r.arrayBuffer(); return new Response('ok') }, ingress: { limits: { uploadTimeoutMs: 2000, uploadMaxBytesPerSec: 1000 } } }, cleanups)
    const over = await t.raw(post(2001))
    assert.equal(statusOf(over.text), 413)
    assert.match(over.text, /x-browsermesh-ingress-reason: upload-exceeds-deadline/i)
    const fits = await t.raw(post(2000) + 'x'.repeat(2000))
    assert.equal(statusOf(fits.text), 200)
  })

  it('the pod enforces it on its own, whatever the ingress allows', async () => {
    const t = await httpRig({
      handler: async (r) => { await r.arrayBuffer(); return new Response('ok') },
      provider: { limits: { uploadTimeoutMs: 2000, handlerTimeoutMs: 2000, uploadMaxBytesPerSec: 1000 } },
    }, cleanups)
    const over = await t.raw(post(2001) + 'x'.repeat(2001))
    assert.equal(statusOf(over.text), 413)
    assert.match(over.text, /x-browsermesh-ingress-reason: upload-exceeds-deadline/i)
    const fits = await t.raw(post(2000) + 'x'.repeat(2000))
    assert.equal(statusOf(fits.text), 200)
  })
})

describe('an upload that cannot finish is cut as soon as that is known (#472)', () => {
  const slow = { uploadGraceMs: 150, uploadProgressMs: 100, uploadMinBytesPerSec: 1, bodyIdleMs: 60_000 }
  /** `perTick` bytes every `everyMs`, until `total` have been sent. */
  const paced = (total, perTick, everyMs) => { let sent = 0; return new ReadableStream({ async pull(c) { if (sent >= total) return c.close(); await sleep(everyMs); const n = Math.min(perTick, total - sent); sent += n; c.enqueue(new Uint8Array(n)) } }, { highWaterMark: 0 }) }
  const withLength = (n) => ({ headers: { 'content-length': String(n) } })

  it('the ingress cuts at the first look after the grace, long before the deadline: 408 upload-too-slow', async () => {
    const t = await httpRig({ handler: async (r) => { await r.arrayBuffer(); return new Response('ok') }, ingress: { limits: { ...slow, uploadTimeoutMs: 20_000 } } }, cleanups)
    const started = Date.now()
    const res = await t.mesh.handle(new Request('http://app.test/', upload(paced(1_000_000, 100, 20), withLength(1_000_000))), { clientAddress: '203.0.113.9' })
    assert.equal(res.status, 408)
    assert.equal(res.headers.get(REASON_HEADER), 'upload-too-slow')
    assert.ok(Date.now() - started < 5000, 'cut early, not at the 20 s deadline')
  })

  it('the pod cuts on its own, whatever the ingress allows', async () => {
    const errored = deferred()
    const t = await httpRig({
      handler: async (r) => { try { await r.arrayBuffer() } catch (e) { errored.resolve(e?.reason) } return new Response('ok') },
      provider: { limits: { ...slow, uploadTimeoutMs: 20_000, handlerTimeoutMs: 20_000 } },
      ingress: { limits: { uploadGraceMs: 1e9, uploadTimeoutMs: 20_000, bodyIdleMs: 60_000 } },
    }, cleanups)
    const res = await t.mesh.handle(new Request('http://app.test/', upload(paced(1_000_000, 100, 20), withLength(1_000_000))), { clientAddress: '203.0.113.9' })
    assert.equal(await errored.promise, 'upload-too-slow')
    assert.ok(res.status >= 400)
  })

  it('an upload that is fast enough is never cut', async () => {
    const t = await httpRig({ handler: async (r) => new Response(String((await r.arrayBuffer()).byteLength)), ingress: { limits: { ...slow, uploadTimeoutMs: 20_000 } }, provider: { limits: { ...slow, uploadTimeoutMs: 20_000, handlerTimeoutMs: 20_000 } } }, cleanups)
    // 40 000 bytes at about 100 KB/s while 20 s are left: finishes in well under a second.
    const res = await t.mesh.handle(new Request('http://app.test/', upload(paced(40_000, 2000, 20), withLength(40_000))), { clientAddress: '203.0.113.9' })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), '40000')
  })

  it('a slow origin is not blamed on the sender', async () => {
    const t = await httpRig({
      handler: async (r) => { for await (const c of r.body) { void c; await sleep(30) } return new Response('ok') },
      ingress: { limits: { ...slow, uploadTimeoutMs: 20_000 } }, provider: { limits: { ...slow, uploadTimeoutMs: 20_000, handlerTimeoutMs: 20_000 } },
    }, cleanups)
    let sent = 0
    const fast = new ReadableStream({ pull(c) { if (sent >= 30) return c.close(); sent++; c.enqueue(new Uint8Array(4096)) } }, { highWaterMark: 0 })
    const res = await t.mesh.handle(new Request('http://app.test/', upload(fast, withLength(30 * 4096))), { clientAddress: '203.0.113.9' })
    assert.equal(res.status, 200)
  })
})
