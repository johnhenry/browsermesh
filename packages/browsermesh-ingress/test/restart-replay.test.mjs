// A request sent on a link in the moment before the ingress hears that the pod started over on the connection is cut when it does
// (the link ends at once, which ends what runs on it). The new life of the pod never saw the request. A request that has had no
// answer byte, and that may be sent again (an idempotent method, a body not streamed), is sent once more, on the new link;
// everything else keeps the 502 `provider-closed` it always had.
//
// In-process on the in-memory bus, in order, with no wall-clock wait: the ingress node here reports `peer:transport-restart`
// the way a real node does, at the moment the test chooses (the request is in the pod's handler, so it is on the old link).
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { attachService, createMeshProtocolService } from '@johnhenry/browsermesh-apps'
import { createMeshIngress, serveHttpOnMesh } from '../src/index.mjs'
import { REASON_HEADER } from '../src/errors.mjs'
import { createNodes, grantHttp, deferred, until } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

/** An ingress node that reports node events (what the real `PeerNode` does), a provider whose handler the test steers. */
async function rig({ ingress: ingressOptions = {}, methods, channelOptions } = {}) {
  const [ingress, provider] = await createNodes(2)
  const events = new Map()
  Object.assign(ingress, {
    hasActiveSession: () => true,
    on(event, cb) { if (!events.has(event)) events.set(event, new Set()); events.get(event).add(cb) },
    off(event, cb) { events.get(event)?.delete(cb) },
    fire(event, data) { for (const cb of [...(events.get(event) ?? [])]) cb(data) },
  })
  // The transport under the link refuses to send (a connection swapped for one that is not verified yet): the next `count` data
  // frames after `skip` of them fail, each with the error the real transport throws.
  const failing = { skip: 0, count: 0 }
  const send = ingress.sendTo.bind(ingress)
  ingress.sendTo = (to, data) => {
    if (data?.k === 'd' && failing.count > 0) {
      if (failing.skip > 0) failing.skip -= 1
      else { failing.count -= 1; return Promise.reject(new Error('Peer identity not verified yet')) }
    }
    return send(to, data)
  }
  const i = attachService(ingress, undefined, createMeshProtocolService(channelOptions))
  const p = attachService(provider, undefined, createMeshProtocolService())
  cleanups.push(() => { i.teardown(); p.teardown() })
  grantHttp({ provider, ingress })
  // What the pod does with each request it is given, in order: `script[n]` is called with `(request, n)`.
  const calls = []
  const script = []
  const served = serveHttpOnMesh(p, async (request) => {
    const n = calls.length
    calls.push({ method: request.method, entered: deferred() })
    calls[n].entered.resolve()
    return script[n] ? script[n](request, n) : new Response(`answer ${n}`)
  }, { allowFrom: [ingress.podId], ...(methods ? { methods } : {}) })
  cleanups.push(() => served.stop())
  const audits = []
  const mesh = createMeshIngress({
    service: i, methods, limits: { openTimeoutMs: 500 }, resolve: () => ({ peer: provider.podId }), onAudit: (r) => audits.push(r), ...ingressOptions,
  })
  cleanups.push(() => mesh.close())
  const restart = () => ingress.fire('peer:transport-restart', { pubKey: provider.podId, sessionId: 's', transport: 'webrtc', connectionId: 'default' })
  const hang = () => new Promise(() => {}) // a request the old life of the pod never answers
  return { ingress, provider, mesh, calls, script, audits, restart, hang, failing }
}

const text = async (res) => ({ status: res.status, reason: res.headers.get(REASON_HEADER), body: await res.text() })

describe('a request cut by the pod starting over, before any answer byte', () => {
  it('a GET is sent again on the new link and answered by it', async () => {
    const t = await rig()
    t.script[0] = t.hang
    const pending = t.mesh.handle(new Request('http://site.example.test/x'))
    await until(() => t.calls.length === 1, 'the pod to be asked')
    t.restart()
    const r = await text(await pending)
    assert.deepEqual([r.status, r.reason, r.body], [200, null, 'answer 1'])
    assert.equal(t.calls.length, 2)
    assert.deepEqual(t.audits.map((a) => [a.status, a.reason, a.retried === true]), [[502, 'provider-closed', true], [200, undefined, false]])
    assert.equal(t.mesh.stats().failed, 0)
  })

  it('is sent again once only: a second restart is the 502 it always was', async () => {
    const t = await rig()
    t.script[0] = t.hang
    t.script[1] = t.hang
    const pending = t.mesh.handle(new Request('http://site.example.test/x'))
    await until(() => t.calls.length === 1, 'the first ask')
    t.restart()
    await until(() => t.calls.length === 2, 'the second ask')
    t.restart()
    const r = await text(await pending)
    assert.deepEqual([r.status, r.reason], [502, 'provider-closed'])
    assert.equal(t.calls.length, 2)
  })

  for (const retry of [undefined, { attempts: 2, nonIdempotent: true }]) {
    it(`a POST is never sent again (retry ${JSON.stringify(retry)})`, async () => {
      const t = await rig({ methods: ['GET', 'POST'], ingress: retry ? { retry } : {} })
      t.script[0] = t.hang
      const pending = t.mesh.handle(new Request('http://site.example.test/x', { method: 'POST', body: 'hello' }))
      await until(() => t.calls.length === 1, 'the pod to be asked')
      t.restart()
      const r = await text(await pending)
      assert.deepEqual([r.status, r.reason], [502, 'provider-closed'])
      assert.equal(t.calls.length, 1, 'the pod was asked once')
    })
  }

  it('a request whose body streams (not held, so it cannot be sent again) is not sent again', async () => {
    const t = await rig({ methods: ['GET', 'PUT'] })
    t.script[0] = t.hang
    const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('first part')) } }) // never ends: unknown length
    const pending = t.mesh.handle(new Request('http://site.example.test/x', { method: 'PUT', body, duplex: 'half' }))
    await until(() => t.calls.length === 1, 'the pod to be asked')
    t.restart()
    const r = await text(await pending)
    assert.deepEqual([r.status, r.reason], [502, 'provider-closed'])
    assert.equal(t.calls.length, 1)
  })

  it('an answer that has begun is never sent again: the cut is the cut', async () => {
    const t = await rig()
    const gate = deferred()
    t.script[0] = () => new Response(new ReadableStream({
      async start(c) { c.enqueue(new TextEncoder().encode('first half')); await gate.promise; c.close() },
    }))
    const res = await t.mesh.handle(new Request('http://site.example.test/x'))
    assert.equal(res.status, 200)
    const reader = res.body.getReader()
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'first half')
    t.restart()
    await assert.rejects(async () => { for (;;) { const { done } = await reader.read(); if (done) return } })
    gate.resolve()
    assert.equal(t.calls.length, 1, 'the pod was asked once')
  })

  it('a restart with nothing pending, and another peer\'s restart, change nothing', async () => {
    const t = await rig()
    t.restart()
    const r = await text(await t.mesh.handle(new Request('http://site.example.test/x')))
    assert.deepEqual([r.status, r.body], [200, 'answer 0'])
    t.ingress.fire('peer:transport-restart', { pubKey: 'someone-else', connectionId: 'default' })
    assert.equal(t.calls.length, 1)
  })
})

describe('a request the link could not send (the transport under it refused), before any answer byte', () => {
  // The first request opens the link; the next data frame is the one that fails, which ends the link and with it the request.
  const open = async (t) => {
    assert.equal((await text(await t.mesh.handle(new Request('http://site.example.test/open')))).status, 200)
    t.calls.length = 0
  }

  it('a GET never reached the pod: it is sent again on a new link and answered by it', async () => {
    const t = await rig()
    await open(t)
    t.failing.count = 1
    const r = await text(await t.mesh.handle(new Request('http://site.example.test/x')))
    assert.deepEqual([r.status, r.reason, r.body], [200, null, 'answer 0'])
    assert.equal(t.calls.length, 1, 'the pod was asked once: the first frame never left')
    assert.deepEqual(t.audits.slice(1).map((a) => [a.status, a.reason, a.retried === true]), [[502, 'provider-closed', true], [200, undefined, false]])
  })

  it('is sent again once only: a second failure is the 502 it always was', async () => {
    const t = await rig()
    await open(t)
    t.failing.count = 2
    const r = await text(await t.mesh.handle(new Request('http://site.example.test/x')))
    assert.equal(r.status, 502) // (the new link's own opening frame is the second failure: named as the link that could not be opened)
    assert.equal(t.calls.length, 0)
    assert.equal(t.audits.length, 3, 'the first request; then this one, once for the attempt that was sent again and once for its end: sent again once, not twice')
  })

  it('a POST with no body that never left is sent again; a POST with a body is not', async () => {
    const t = await rig({ methods: ['GET', 'POST'] })
    await open(t)
    t.failing.count = 1
    const bare = await text(await t.mesh.handle(new Request('http://site.example.test/x', { method: 'POST' })))
    assert.deepEqual([bare.status, bare.body], [200, 'answer 0'])
    t.failing.count = 1
    const withBody = await text(await t.mesh.handle(new Request('http://site.example.test/x', { method: 'POST', body: 'hello' })))
    assert.deepEqual([withBody.status, withBody.reason], [502, 'provider-closed'])
    assert.equal(t.calls.length, 1, 'the pod was never asked the one with a body')
  })

  it('a POST with a body is not sent again even when the body is held whole (so it could be)', async () => {
    const t = await rig({ methods: ['GET', 'POST'], ingress: { retry: { attempts: 1, nonIdempotent: true } } })
    await open(t)
    t.failing.count = 1
    const r = await text(await t.mesh.handle(new Request('http://site.example.test/x', { method: 'POST', body: 'hello' })))
    assert.deepEqual([r.status, r.reason], [502, 'provider-closed'])
    assert.equal(t.calls.length, 0)
  })

  it('a request part of which left (a later frame failed) is never sent again', async () => {
    const t = await rig({ channelOptions: { chunkBytes: 256, window: 4096, maxMessageBytes: 4096 } })
    await open(t)
    t.failing.skip = 1 // the first frame goes out, the second fails
    t.failing.count = 1
    const long = 'x'.repeat(600)
    const r = await text(await t.mesh.handle(new Request(`http://site.example.test/${long}`)))
    assert.deepEqual([r.status, r.reason], [502, 'provider-closed'])
    assert.equal(t.audits.length, 2, 'one for the first request, one for this one: no second attempt')
  })
})
