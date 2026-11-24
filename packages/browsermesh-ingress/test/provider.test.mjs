// The provider side (serveHttpOnMesh), signed responses, the site-handler wrapper and the opt-in buffered fallback.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { attachService, createMeshProtocolService, createMeshRpcService, createSiteMeshRpcService, createSiteRequestHandler, createStreamLayer } from '@johnhenry/browsermesh-apps'
import { createMeshIngress, fromSiteHandler, serveHttpOnMesh } from '../src/index.mjs'
import { REASON_HEADER } from '../src/errors.mjs'
import { createNodes, threePods, grantHttp, deferred, until } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

async function rig(handler, { provider = {}, ingress = {} } = {}) {
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  const served = serveHttpOnMesh(pods.p, handler, { allowFrom: [pods.ingress.podId], ...provider })
  cleanups.push(() => served.stop())
  grantHttp(pods)
  const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }), ...ingress })
  cleanups.push(() => mesh.close())
  return { ...pods, served, mesh, get: (path = '/', init) => mesh.handle(new Request(`http://app.example.test${path}`, init), { clientAddress: '203.0.113.9' }) }
}

/** A raw client on the provider's protocol: what an ingress that does not follow the rules could send. */
async function rawClient(pods) {
  const channel = await pods.i.api.openProtocol(pods.provider.podId, 'http', { versions: [1] })
  const streams = createStreamLayer(channel)
  streams.onStream((reader) => { reader.bytes().catch(() => {}) }) // response bodies: taken and dropped
  const head = (over = {}) => ({ rid: 1, nonce: 'a'.repeat(16), method: 'GET', target: '/', host: 'app.example.test', headers: [], body: false, ...over })
  return { channel, streams, head, fetch: (over, opts) => channel.request('fetch', head(over), opts) }
}

describe('what the provider accepts from an ingress', () => {
  const bad = {
    'a method that is never served': { method: 'TRACE' },
    'a lower-case method': { method: 'get' },
    'a target that is not in origin form': { target: 'http://169.254.169.254/' },
    'a protocol-relative target': { target: '//evil.test/x' },
    'a target with a space': { target: '/a b' },
    'a host with userinfo': { host: 'a@evil.test' },
    'a host that is not a hostname': { host: 'a b' },
    'a Host header in the head': { headers: [['host', 'evil.test']] },
    'a Content-Length in the head': { headers: [['content-length', '5']] },
    'a Transfer-Encoding in the head': { headers: [['transfer-encoding', 'chunked']] },
    'a header with a bad name': { headers: [['bad name', 'x']] },
    'a request id that is not a positive integer': { rid: 0 },
    'a request id that is text': { rid: 'one' },
    'a body flag that is not a boolean': { body: 1 },
    'no nonce': { nonce: undefined },
    'a short nonce': { nonce: 'abc' },
    'a client field that is not short text': { client: 5 },
  }
  for (const [name, over] of Object.entries(bad)) {
    it(`${name} is refused before the handler runs`, async () => {
      let ran = 0
      const t = await rig(() => { ran += 1; return new Response('x') })
      const c = await rawClient(t)
      await assert.rejects(c.fetch(over), (e) => ['bad-request-head', 'method-not-allowed', 'bad-target', 'bad-host', 'bad-headers'].includes(e.reason))
      assert.equal(ran, 0)
    })
  }

  it('a body for a GET is refused; a body for a POST is read', async () => {
    const t = await rig(async (request) => new Response(`${request.method}:${await request.text()}`))
    const c = await rawClient(t)
    await assert.rejects(c.fetch({ body: true }), (e) => e.reason === 'body-on-get')
    const sent = c.streams.sendBody(new TextEncoder().encode('payload'), { rid: 2, kind: 'request' })
    const head = await c.fetch({ rid: 2, method: 'POST', body: true })
    await sent
    assert.equal(head.status, 200)
    assert.equal(head.body, true)
  })

  it('a stream whose request id nobody claims is dropped after the wait, and a stream of the wrong kind is refused', async () => {
    const t = await rig(() => new Response('x'), { provider: { limits: { bodyWaitMs: 40 } } })
    const c = await rawClient(t)
    await assert.rejects(c.streams.open({ rid: 5, kind: 'response' }))
    await assert.rejects(c.streams.open({ rid: 'x', kind: 'request' }))
    const w = await c.streams.open({ rid: 9, kind: 'request' })
    const gone = deferred()
    w.signal.addEventListener('abort', () => gone.resolve(true))
    assert.equal(await gone.promise, true)
  })

  it('a request body stream larger than the provider\'s cap is cut', async () => {
    const t = await rig(async (request) => new Response(String((await request.arrayBuffer()).byteLength)), { provider: { limits: { maxRequestBodyBytes: 100 } } })
    const c = await rawClient(t)
    const sending = c.streams.sendBody(new Uint8Array(500), { rid: 3, kind: 'request' }).catch((e) => e)
    await assert.rejects(c.fetch({ rid: 3, method: 'POST', body: true }), (e) => e.reason === 'body-too-large' || e.reason === 'handler-failed')
    await sending
  })

  it('too many requests in flight is BUSY, not queued without bound', async () => {
    const gate = deferred()
    const t = await rig(() => gate.promise.then(() => new Response('x')), { provider: { limits: { maxInflight: 2 } } })
    const c = await rawClient(t)
    const a = c.fetch({ rid: 1 })
    const b = c.fetch({ rid: 2 })
    await until(() => t.served.stats().inflight === 2)
    await assert.rejects(c.fetch({ rid: 3 }), (e) => e.reason === 'busy')
    gate.resolve()
    await Promise.all([a, b])
  })

  it('a handler that throws, returns nothing, or returns a bad status is an error to the ingress and no detail', async () => {
    for (const handler of [() => { throw new Error('secret detail') }, () => 'nope', () => ({ status: 99, headers: new Headers() }), () => ({ status: 700, headers: new Headers() })]) {
      const t = await rig(handler)
      const res = await t.get('/')
      assert.equal(res.status, 502)
      assert.ok(!(await res.text()).includes('secret'))
    }
  })

  it('the handler deadline aborts its signal', async () => {
    const aborted = deferred()
    const t = await rig((request, { signal }) => { signal.addEventListener('abort', () => aborted.resolve(true)); return new Promise(() => {}) }, { provider: { limits: { handlerTimeoutMs: 40 } }, ingress: { limits: { timeoutMs: 400 } } })
    await t.get('/', {}).catch(() => {})
    assert.equal(await aborted.promise, true)
  })

  it('a response larger than the provider\'s cap is cut', async () => {
    const t = await rig(() => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1000)) } })), { provider: { limits: { maxResponseBytes: 5000 } }, ingress: { limits: { responseIdleMs: 200 } } })
    const res = await t.get('/')
    assert.equal(res.status, 200)
    await assert.rejects(res.arrayBuffer())
  })

  it('stop() unserves the protocol and closes the channels', async () => {
    const t = await rig(() => new Response('x'))
    assert.equal((await t.get('/')).status, 200)
    t.served.stop()
    const res = await t.get('/')
    assert.equal(res.status, 502)
  })
})

describe('signed responses', () => {
  async function keyPair() { return globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']) }
  const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')
  const unhex = (s) => new Uint8Array(s.match(/../g).map((x) => parseInt(x, 16)))

  it('a response whose signature verifies is delivered, with the body the signature covers', async () => {
    const keys = await keyPair()
    const seen = []
    const t = await rig(() => new Response('signed body', { headers: { 'content-type': 'text/plain' } }), {
      provider: { sign: async (bytes) => hex(await crypto.subtle.sign('Ed25519', keys.privateKey, bytes)) },
      ingress: { verifyResponse: async ({ peer, bytes, sig, request }) => { seen.push({ peer, request }); return crypto.subtle.verify('Ed25519', keys.publicKey, unhex(sig), bytes) } },
    })
    const res = await t.get('/x?y=1')
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'signed body')
    assert.equal(seen[0].peer, t.provider.podId)
    assert.equal(seen[0].request.target, '/x?y=1')
  })

  it('a response with no signature, a wrong signature, or a signature from another key is refused', async () => {
    const keys = await keyPair()
    const other = await keyPair()
    const verify = async ({ bytes, sig }) => { try { return await crypto.subtle.verify('Ed25519', keys.publicKey, unhex(sig), bytes) } catch { return false } }
    const unsigned = await rig(() => new Response('x'), { ingress: { verifyResponse: verify } })
    const a = await unsigned.get('/')
    assert.equal(a.status, 502)
    assert.equal(a.headers.get(REASON_HEADER), 'response-unsigned')
    const wrongKey = await rig(() => new Response('x'), { provider: { sign: async (b) => hex(await crypto.subtle.sign('Ed25519', other.privateKey, b)) }, ingress: { verifyResponse: verify } })
    const b = await wrongKey.get('/')
    assert.equal(b.status, 502)
    assert.equal(b.headers.get(REASON_HEADER), 'response-signature-invalid')
    const garbage = await rig(() => new Response('x'), { provider: { sign: async () => 'zz' }, ingress: { verifyResponse: verify } })
    assert.equal((await garbage.get('/')).headers.get(REASON_HEADER), 'response-signature-invalid')
    const throwing = await rig(() => new Response('x'), { provider: { sign: async () => 'aa' }, ingress: { verifyResponse: () => { throw new Error('x') } } })
    assert.equal((await throwing.get('/')).headers.get(REASON_HEADER), 'response-signature-invalid')
  })

  it('a signature covers the body, the request and the nonce: another body or another request does not verify', async () => {
    const keys = await keyPair()
    const captured = []
    const t = await rig(() => new Response('real'), {
      provider: { sign: async (bytes) => { captured.push(bytes); return hex(await crypto.subtle.sign('Ed25519', keys.privateKey, bytes)) } },
      ingress: { verifyResponse: async ({ bytes, sig }) => crypto.subtle.verify('Ed25519', keys.publicKey, unhex(sig), bytes) },
    })
    await t.get('/one')
    await t.get('/two')
    const [a, b] = captured.map((x) => JSON.parse(new TextDecoder().decode(x)))
    assert.notEqual(a.nonce, b.nonce)
    assert.notEqual(a.target, b.target)
    assert.match(a.digest, /^[0-9a-f]{64}$/)
    assert.equal(a.digest, b.digest)
  })
})

describe('serving a site that already exists', () => {
  it('fromSiteHandler serves a serverless site over http: bytes, JSON and status survive', async () => {
    const site = createSiteRequestHandler({
      functionsHandler: async ({ method, path, fromPubKey }) => {
        if (path.startsWith('/bin')) return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([0, 1, 2, 255]) }
        if (path.startsWith('/json')) return { status: 201, headers: {}, body: { ok: true, method, from: fromPubKey } }
        return null
      },
    })
    const t = await rig(fromSiteHandler(site))
    const bin = await t.get('/bin')
    assert.deepEqual([...new Uint8Array(await bin.arrayBuffer())], [0, 1, 2, 255])
    const json = await t.get('/json')
    assert.equal(json.status, 201)
    assert.deepEqual(await json.json(), { ok: true, method: 'GET', from: t.ingress.podId })
    assert.equal((await t.get('/missing')).status, 404)
    assert.throws(() => fromSiteHandler('nope'), TypeError)
  })
})

describe('the opt-in buffered fallback for a provider that does not serve http', () => {
  async function legacyRig({ withChannelService, ingress = {} }) {
    const [ingressNode, siteNode] = await createNodes(2)
    const i = attachService(ingressNode, undefined, createMeshProtocolService())
    const rpc = attachService(ingressNode, undefined, createMeshRpcService({ envelopeType: 'mesh-serverless' }))
    const site = attachService(siteNode, undefined, createSiteMeshRpcService({
      functionsHandler: async ({ method, path, body }) => ({ status: 200, headers: { 'content-type': 'text/plain', 'set-cookie': 'a=1' }, body: `legacy:${method}:${path}:${body ? new TextDecoder().decode(body) : ''}` }),
    }))
    const p = withChannelService ? attachService(siteNode, undefined, createMeshProtocolService()) : null
    cleanups.push(() => { i.teardown(); rpc.teardown(); site.teardown(); p?.teardown() })
    if (withChannelService) siteNode.registry.grantCapabilities(ingressNode.podId, ['protocol:http:open'])
    const mesh = createMeshIngress({ service: i, rpc: rpc.api, resolve: () => ({ peer: siteNode.podId }), limits: { openTimeoutMs: 80 }, methods: ['GET', 'POST'], ...ingress })
    cleanups.push(() => mesh.close())
    return { mesh, siteNode, get: (path, init) => mesh.handle(new Request(`http://app.example.test${path}`, init)) }
  }

  it('a provider that answers the open with "not served" is asked through mesh-rpc, and the answer gets the same policy', async () => {
    const t = await legacyRig({ withChannelService: true })
    const res = await t.get('/page?q=1', { method: 'POST', body: 'hello' })
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'legacy:POST:/page?q=1:hello')
    assert.equal(res.headers.getSetCookie().length, 0)
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox")
    assert.equal(t.mesh.stats().fallbacks, 1)
  })

  it('a provider that runs only the older service and never answers the open is asked through mesh-rpc, and remembered', async () => {
    const t = await legacyRig({ withChannelService: false })
    assert.equal(await (await t.get('/a')).text(), 'legacy:GET:/a:')
    assert.equal(await (await t.get('/b')).text(), 'legacy:GET:/b:')
    assert.equal(t.mesh.stats().fallbacks, 2)
  })

  it('is off unless `rpc` is given: the ingress answers 502 provider-no-http', async () => {
    const [ingressNode, siteNode] = await createNodes(2)
    const i = attachService(ingressNode, undefined, createMeshProtocolService())
    const p = attachService(siteNode, undefined, createMeshProtocolService())
    cleanups.push(() => { i.teardown(); p.teardown() })
    siteNode.registry.grantCapabilities(ingressNode.podId, ['protocol:http:open'])
    const mesh = createMeshIngress({ service: i, resolve: () => ({ peer: siteNode.podId }) })
    cleanups.push(() => mesh.close())
    const res = await mesh.handle(new Request('http://a.test/'))
    assert.equal(res.status, 502)
    assert.equal(res.headers.get(REASON_HEADER), 'provider-no-http')
  })

  it('never on a refusal: a provider that did not grant the open is not asked through the older path', async () => {
    const [ingressNode, siteNode] = await createNodes(2)
    const i = attachService(ingressNode, undefined, createMeshProtocolService())
    const rpc = attachService(ingressNode, undefined, createMeshRpcService({ envelopeType: 'mesh-serverless' }))
    const p = attachService(siteNode, undefined, createMeshProtocolService())
    let asked = 0
    const site = attachService(siteNode, undefined, createSiteMeshRpcService({ functionsHandler: async () => { asked += 1; return { status: 200, headers: {}, body: 'x' } } }))
    cleanups.push(() => { i.teardown(); rpc.teardown(); p.teardown(); site.teardown() })
    const mesh = createMeshIngress({ service: i, rpc: rpc.api, resolve: () => ({ peer: siteNode.podId }) })
    cleanups.push(() => mesh.close())
    const res = await mesh.handle(new Request('http://a.test/'))
    assert.equal(res.status, 502)
    assert.equal(res.headers.get(REASON_HEADER), 'provider-not-authorized')
    assert.equal(asked, 0)
  })

  it('an oversized or malformed buffered answer is refused like any other', async () => {
    const [ingressNode, siteNode] = await createNodes(2)
    const i = attachService(ingressNode, undefined, createMeshProtocolService())
    const rpc = attachService(ingressNode, undefined, createMeshRpcService({ envelopeType: 'mesh-serverless' }))
    const site = attachService(siteNode, undefined, createSiteMeshRpcService({ functionsHandler: async ({ path }) => path === '/status' ? { status: 99, headers: {}, body: 'x' } : { status: 200, headers: { location: 'http://169.254.169.254/' }, body: 'x'.repeat(5000) } }))
    cleanups.push(() => { i.teardown(); rpc.teardown(); site.teardown() })
    const mesh = createMeshIngress({ service: i, rpc: rpc.api, resolve: () => ({ peer: siteNode.podId }), limits: { openTimeoutMs: 50, maxResponseBytes: 1000 } })
    cleanups.push(() => mesh.close())
    assert.equal((await mesh.handle(new Request('http://a.test/status'))).status, 502)
    assert.equal((await mesh.handle(new Request('http://a.test/big'))).headers.get(REASON_HEADER), 'response-too-large')
  })
})
