// A hostile provider: a pod the operator mapped, which answers however it likes. The provider here is hand-written
// against the protocol channel (not serveHttpOnMesh), so it can send what no honest provider would.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamLayer } from '@johnhenry/browsermesh-apps'
import { createMeshIngress, serveHttpOnMesh } from '../src/index.mjs'
import { REASON_HEADER } from '../src/errors.mjs'
import { threePods, grantHttp, deferred, until } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

/**
 * `behave({ head, channel, streams, ctx })` answers each `fetch`. Returns the ingress, the pods and a `get`.
 */
async function evil(behave, { ingress = {}, onChannel } = {}) {
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  const unserve = pods.p.api.serveProtocol('http', (channel) => {
    const streams = createStreamLayer(channel)
    streams.onStream((reader) => { reader.cancel('not wanted').catch(() => {}) })
    onChannel?.({ channel, streams })
    channel.onRequest('fetch', (head, ctx) => behave({ head, channel, streams, ctx }))
  })
  cleanups.push(() => unserve())
  grantHttp(pods)
  const audits = []
  const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }), onAudit: (r) => audits.push(r), limits: { timeoutMs: 2000, responseIdleMs: 80, openTimeoutMs: 1000 }, ...ingress })
  cleanups.push(() => mesh.close())
  return { ...pods, mesh, audits, get: (path = '/', init) => mesh.handle(new Request(`http://app.example.test${path}`, init), { clientAddress: '203.0.113.9' }) }
}

const reasonOf = (res) => res.headers.get(REASON_HEADER)

describe('malformed answers', () => {
  const heads = {
    'not an object': 'hello',
    'null': null,
    'status below 200': { status: 100, headers: [], body: false },
    'a 101': { status: 101, headers: [], body: false },
    'status above 599': { status: 700, headers: [], body: false },
    'a fractional status': { status: 200.5, headers: [], body: false },
    'a status that is text': { status: '200', headers: [], body: false },
    'headers that are not a list': { status: 200, headers: 'x', body: false },
    'a header pair of three': { status: 200, headers: [['a', 'b', 'c']], body: false },
    'a header name that is not a token': { status: 200, headers: [['bad name', 'v']], body: false },
    'a header value with a newline': { status: 200, headers: [['x-a', 'v\r\nset-cookie: a=1']], body: false },
    'a body flag that is not a boolean': { status: 200, headers: [], body: 'yes' },
    'a signature that is not text': { status: 200, headers: [], body: false, sig: 5 },
  }
  for (const [name, head] of Object.entries(heads)) {
    it(`${name} is a 502, never passed on`, async () => {
      const t = await evil(() => head)
      const res = await t.get('/')
      assert.equal(res.status, 502)
      assert.match(reasonOf(res), /^bad-response-(head|status)$/)
    })
  }

  it('more headers than allowed, or more bytes than allowed, is a 502', async () => {
    const many = await evil(() => ({ status: 200, headers: Array.from({ length: 200 }, (_, i) => [`x-${i}`, 'v']), body: false }))
    assert.equal((await many.get('/')).status, 502)
    const big = await evil(() => ({ status: 200, headers: [['x-big', 'v'.repeat(8000)], ['x-big2', 'v'.repeat(8000)], ['x-big3', 'v'.repeat(8000)]], body: false }))
    assert.equal((await big.get('/')).status, 502)
  })

  it('a provider that fails, or closes the channel, mid-request is a 502', async () => {
    const failing = await evil(() => { throw new Error('boom') })
    const a = await failing.get('/')
    assert.equal(a.status, 502)
    assert.equal(reasonOf(a), 'provider-error')
    const closing = await evil(({ channel }) => { channel.close('bye'); return new Promise(() => {}) })
    const b = await closing.get('/')
    assert.equal(b.status, 502)
  })
})

describe('forbidden headers', () => {
  it('a content coding the ingress did not negotiate is refused', async () => {
    const t = await evil(() => ({ status: 200, headers: [['content-encoding', 'gzip']], body: false }))
    const res = await t.get('/')
    assert.equal(res.status, 502)
    assert.equal(reasonOf(res), 'bad-content-encoding')
  })

  it('cookies, hop-by-hop, framing and active-content headers never reach the client; the policy headers are the ingress\'s', async () => {
    const t = await evil(() => ({
      status: 200,
      headers: [
        ['set-cookie', 'sid=1; Path=/'], ['set-cookie2', 'x=1'], ['connection', 'keep-alive, x-secret'], ['keep-alive', 'timeout=5'], ['transfer-encoding', 'chunked'],
        ['upgrade', 'websocket'], ['proxy-authenticate', 'Basic'], ['trailer', 'x'], ['te', 'trailers'], ['content-security-policy', 'default-src *; script-src *'],
        ['content-security-policy-report-only', 'x'], ['x-content-type-options', 'sniff'], ['cache-control', 'public, max-age=31536000'], ['expires', 'Wed, 1 Jan 2999 00:00:00 GMT'],
        ['strict-transport-security', 'max-age=0'], ['access-control-allow-origin', '*'], ['access-control-allow-credentials', 'true'], ['refresh', '0; url=http://evil.test'],
        ['alt-svc', 'h3=":443"'], ['clear-site-data', '"cookies"'], ['x-forwarded-for', '1.1.1.1'], ['content-type', 'text/html'], ['x-secret', 'internal'],
      ],
      body: false,
    }))
    const res = await t.get('/')
    assert.equal(res.status, 200)
    assert.deepEqual([...res.headers.keys()].sort(), ['cache-control', 'content-security-policy', 'content-type', 'vary', 'x-content-type-options'])
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; sandbox")
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.getSetCookie().length, 0)
  })

  it('Content-Length must be one number inside the cap', async () => {
    for (const value of ['abc', '-1', '1e3', '9'.repeat(30)]) {
      const t = await evil(() => ({ status: 200, headers: [['content-length', value]], body: false }))
      assert.equal((await t.get('/')).status, 502, value)
    }
  })

  it('a Vary header from the provider is merged, not trusted to be the whole story', async () => {
    const t = await evil(() => ({ status: 200, headers: [['vary', 'Cookie, Accept-Language']], body: false }))
    const vary = (await t.get('/')).headers.get('vary')
    assert.match(vary, /cookie/)
    assert.match(vary, /accept/)
  })
})

describe('redirects', () => {
  it('a redirect to an internal address is refused and nothing is fetched', async () => {
    const real = globalThis.fetch
    let fetched = 0
    globalThis.fetch = (...args) => { fetched += 1; return real(...args) }
    cleanups.push(() => { globalThis.fetch = real })
    for (const location of ['http://169.254.169.254/latest/meta-data/', 'http://localhost:8080/admin', 'http://127.0.0.1/', 'file:///etc/passwd', '//evil.test/x', '/\\evil.test', 'https://other.example/', 'javascript:alert(1)', '']) {
      const t = await evil(() => ({ status: 302, headers: [['location', location]], body: false }))
      const res = await t.get('/')
      assert.equal(res.status, 502, location)
      assert.equal(reasonOf(res), 'provider-redirect-refused', location)
      assert.equal(res.headers.get('location'), null)
    }
    assert.equal(fetched, 0)
  })

  it('a redirect to a path on the same origin is passed on, not followed', async () => {
    const seen = []
    const t = await evil(({ head }) => { seen.push(head.target); return { status: 302, headers: [['location', '/elsewhere']], body: false } })
    const res = await t.get('/start')
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), '/elsewhere')
    assert.deepEqual(seen, ['/start']) // one request: the ingress did not follow it
  })
})

describe('oversized and slow answers', () => {
  it('a stream that outgrows the response cap is cut and the slots are released', async () => {
    const t = await evil(async ({ head, streams, channel }) => {
      const w = await streams.open({ rid: head.rid, kind: 'response' })
      // A rude writer: data frames straight onto the channel, ignoring the limit it was told.
      for (let s = 0; s < 8; s++) channel.notify('stream.data', { id: w.id, s, d: new Uint8Array(8 * 1024) })
      return { status: 200, headers: [], body: true }
    }, { ingress: { limits: { maxResponseBytes: 50_000, timeoutMs: 2000, responseIdleMs: 500 } } })
    const res = await t.get('/')
    assert.equal(res.status, 200)
    await assert.rejects(res.arrayBuffer())
    await until(() => t.mesh.stats().inflight === 0)
    assert.deepEqual(t.mesh.stats().reasons, { 'response-too-large': 1 })
  })

  it('a body longer or shorter than the declared length is refused', async () => {
    for (const [declared, actual] of [[10, 20], [20, 10]]) {
      const t = await evil(async ({ head, streams }) => {
        const w = await streams.open({ rid: head.rid, kind: 'response' })
        w.write(new Uint8Array(actual)).then(() => w.end()).catch(() => {})
        return { status: 200, headers: [['content-length', String(declared)]], body: true }
      })
      const res = await t.get('/')
      await assert.rejects(res.arrayBuffer())
    }
  })

  it('a provider that never answers is a 504 at the deadline', async () => {
    const t = await evil(() => new Promise(() => {}), { ingress: { limits: { timeoutMs: 60 } } })
    const res = await t.get('/')
    assert.equal(res.status, 504)
    assert.equal(reasonOf(res), 'provider-timeout')
    assert.equal(t.mesh.stats().inflight, 0)
  })

  it('a body that stalls after the head is a broken body once the idle time passes, not a hang', async () => {
    const t = await evil(async ({ head, streams }) => {
      const w = await streams.open({ rid: head.rid, kind: 'response' })
      await w.write(new Uint8Array(10)) // then nothing
      return { status: 200, headers: [], body: true }
    })
    const res = await t.get('/')
    assert.equal(res.status, 200)
    await assert.rejects(res.arrayBuffer())
    await until(() => t.mesh.stats().inflight === 0)
    assert.equal(t.mesh.stats().reasons['provider-idle'], 1)
  })

  it('a head that announces a body and never opens the stream is a 504', async () => {
    const t = await evil(() => ({ status: 200, headers: [], body: true }))
    const res = await t.get('/')
    assert.equal(res.status, 504)
    assert.equal(reasonOf(res), 'provider-idle')
  })

  it('a stream the head did not announce is refused', async () => {
    const t = await evil(async ({ head, streams }) => {
      const w = await streams.open({ rid: head.rid, kind: 'response' })
      w.write(new Uint8Array(4)).catch(() => {})
      return { status: 200, headers: [], body: false }
    })
    const res = await t.get('/')
    assert.equal(res.status, 502)
    assert.equal(reasonOf(res), 'bad-response-head')
  })

  it('a stream for a request the ingress never made, or of the wrong kind, is refused at the open', async () => {
    const t = await evil(async ({ head, streams }) => {
      await assert.rejects(streams.open({ rid: head.rid + 1000, kind: 'response' }))
      await assert.rejects(streams.open({ rid: head.rid, kind: 'request' }))
      await assert.rejects(streams.open({ rid: 'x', kind: 'response' }))
      await assert.rejects(streams.open({}))
      return { status: 200, headers: [], body: false }
    })
    assert.equal((await t.get('/')).status, 200)
  })

  it('an announced body on a HEAD, a 204 or a 304 is ignored and cancelled', async () => {
    const cancelled = deferred()
    const t = await evil(async ({ head, streams }) => {
      const w = await streams.open({ rid: head.rid, kind: 'response' })
      w.signal.addEventListener('abort', () => cancelled.resolve(true)) // the reader cancelled
      w.write(new Uint8Array(100)).catch(() => {})
      return { status: 200, headers: [], body: true }
    })
    const res = await t.get('/', { method: 'HEAD' })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), '')
    assert.equal(await cancelled.promise, true)
  })
})

describe('the wrong pod answering', () => {
  it('a channel that is bound to another pod than the mapping names is refused and that pod is sent nothing', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const asked = []
    for (const [svc, label] of [[pods.p, 'provider'], [pods.s, 'stranger']]) {
      const served = serveHttpOnMesh(svc, (request) => { asked.push(label); return new Response('from ' + label) }, { allowFrom: [pods.ingress.podId] })
      cleanups.push(() => served.stop())
    }
    pods.provider.registry.grantCapabilities(pods.ingress.podId, ['protocol:http:open'])
    pods.stranger.registry.grantCapabilities(pods.ingress.podId, ['protocol:http:open'])
    // A service that opens the channel to the stranger whatever pod it is asked for: what a mix-up in a transport would look like.
    const lying = { api: { openProtocol: (peer, name, opts) => pods.i.api.openProtocol(pods.stranger.podId, name, opts) } }
    const mesh = createMeshIngress({ service: lying, resolve: () => ({ peer: pods.provider.podId }) })
    cleanups.push(() => mesh.close())
    const res = await mesh.handle(new Request('http://app.example.test/'))
    assert.equal(res.status, 502)
    assert.equal(reasonOf(res), 'provider-pin-mismatch')
    assert.deepEqual(asked, [])
    assert.equal(mesh.stats().providers, 0)
  })

  it('an honest ingress mapping to the stranger is answered by the stranger only', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const answers = []
    for (const [svc, label] of [[pods.p, 'provider'], [pods.s, 'stranger']]) {
      const served = serveHttpOnMesh(svc, () => { answers.push(label); return new Response(label) }, { allowFrom: [pods.ingress.podId] })
      cleanups.push(() => served.stop())
    }
    pods.provider.registry.grantCapabilities(pods.ingress.podId, ['protocol:http:open'])
    pods.stranger.registry.grantCapabilities(pods.ingress.podId, ['protocol:http:open'])
    const mesh = createMeshIngress({ service: pods.i, resolve: (r) => ({ peer: new URL(r.url).pathname === '/s' ? pods.stranger.podId : pods.provider.podId }) })
    cleanups.push(() => mesh.close())
    assert.equal(await (await mesh.handle(new Request('http://a.test/s'))).text(), 'stranger')
    assert.equal(await (await mesh.handle(new Request('http://a.test/p'))).text(), 'provider')
    assert.deepEqual(answers, ['stranger', 'provider'])
  })

  it('a pod with no direct link is refused with a named reason: routed delivery is not part of v1', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: 'podNotOnThisBus' }) })
    cleanups.push(() => mesh.close())
    const res = await mesh.handle(new Request('http://a.test/'))
    assert.equal(res.status, 502)
    assert.equal(reasonOf(res), 'provider-unreachable')
  })
})

describe('authorisation on the provider, default deny', () => {
  it('with no grant the provider refuses the open, and the ingress says so', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, () => new Response('x'), { allowFrom: [pods.ingress.podId] })
    cleanups.push(() => served.stop())
    const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }) })
    cleanups.push(() => mesh.close())
    const res = await mesh.handle(new Request('http://a.test/'))
    assert.equal(res.status, 502)
    assert.equal(reasonOf(res), 'provider-not-authorized')
  })

  it('a granted pod that allowFrom does not name is closed out', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, () => new Response('x'), { allowFrom: [pods.stranger.podId] })
    cleanups.push(() => served.stop())
    grantHttp(pods) // the registry would let the ingress open it; allowFrom does not
    const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }) })
    cleanups.push(() => mesh.close())
    const res = await mesh.handle(new Request('http://a.test/'))
    assert.equal(res.status, 502)
    assert.equal(served.stats().refused, 1)
    assert.equal(served.stats().requests, 0)
  })

  it('serveHttpOnMesh needs allowFrom', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    for (const allowFrom of [undefined, [], 'pod', [5], ['has space']]) {
      assert.throws(() => serveHttpOnMesh(pods.p, () => new Response('x'), { allowFrom }), /allowFrom/)
    }
    assert.throws(() => serveHttpOnMesh(pods.p, 'nope', { allowFrom: ['a'] }), /handler/)
    assert.throws(() => serveHttpOnMesh({}, () => new Response('x'), { allowFrom: ['a'] }), /serveProtocol/)
  })

  it('revoking the grant ends the channel and the next request is refused', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, () => new Response('x'), { allowFrom: [pods.ingress.podId] })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }) })
    cleanups.push(() => mesh.close())
    assert.equal(await (await mesh.handle(new Request('http://a.test/'))).text(), 'x')
    pods.provider.registry.revokeCapabilities(pods.ingress.podId, ['protocol:http:open'])
    const res = await mesh.handle(new Request('http://a.test/'))
    assert.equal(res.status, 502)
  })
})

describe('after the client has gone', () => {
  it('a provider that keeps writing after the cancel is ignored: the writer is told, nothing is delivered, the next request works', async () => {
    const writerSaw = deferred()
    let calls = 0
    const t = await evil(async ({ head, streams }) => {
      calls += 1
      if (calls > 1) return { status: 200, headers: [], body: false }
      const w = await streams.open({ rid: head.rid, kind: 'response' })
      ;(async () => {
        try { for (;;) await w.write(new Uint8Array(4096)) } catch (e) { writerSaw.resolve(e.reason) }
      })()
      return { status: 200, headers: [], body: true }
    })
    const res = await t.get('/')
    const reader = res.body.getReader()
    await reader.read()
    await reader.cancel()
    assert.equal(await writerSaw.promise, 'stream-cancelled')
    await until(() => t.mesh.stats().inflight === 0)
    assert.equal((await t.get('/second')).status, 200)
  })

  it('a handler that finishes after the client aborted is not delivered anywhere', async () => {
    const release = deferred()
    const t = await evil(async () => { await release.promise; return { status: 200, headers: [], body: false } })
    const ac = new AbortController()
    const pending = t.get('/', { signal: ac.signal })
    ac.abort()
    const res = await pending
    assert.ok(res.status >= 400)
    release.resolve()
    await until(() => t.mesh.stats().inflight === 0)
    assert.equal((await t.get('/again').then((r) => r.status)) >= 200, true)
  })
})
