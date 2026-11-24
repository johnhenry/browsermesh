// Options the first adoption needed: allowFrom as a function, signed requests, the frame-ancestors default, operator
// response headers, a provider declining a request, and bounded retry. Each rule is broken once by a test here.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamLayer } from '@johnhenry/browsermesh-apps'
import { createMeshIngress, serveHttpOnMesh, declineRequest, DEFAULT_CSP, signedRequestBytes } from '../src/index.mjs'
import { REASON_HEADER } from '../src/errors.mjs'
import { threePods, grantHttp } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
const reasonOf = (res) => res.headers.get(REASON_HEADER)

async function rig({ handler, provider = {}, ingress = {}, both = false } = {}) {
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  const handlers = { provider: handler ?? (() => new Response('hello')), stranger: both?.stranger ?? (() => new Response('from stranger')) }
  const served = serveHttpOnMesh(pods.p, handlers.provider, { allowFrom: [pods.ingress.podId], ...provider })
  cleanups.push(() => served.stop())
  grantHttp(pods)
  let servedStranger
  if (both) {
    servedStranger = serveHttpOnMesh(pods.s, handlers.stranger, { allowFrom: [pods.ingress.podId] })
    cleanups.push(() => servedStranger.stop())
    pods.stranger.registry.grantCapabilities(pods.ingress.podId, ['protocol:http:open'])
  }
  const audits = []
  const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }), onAudit: (r) => audits.push(r), ...ingress })
  cleanups.push(() => mesh.close())
  return { ...pods, served, servedStranger, mesh, audits, get: (path = '/', init) => mesh.handle(new Request(`http://app.example.test${path}`, init), { clientAddress: '203.0.113.9' }) }
}

const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (s) => new Uint8Array(s.match(/../g).map((x) => parseInt(x, 16)))
const keyPair = () => globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])

describe('allowFrom as a function', () => {
  it('may be async, gets the verified pod id and a context, and its yes serves', async () => {
    const calls = []
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const served = serveHttpOnMesh(pods.p, () => new Response('ok'), { allowFrom: async (podId, context) => { calls.push({ podId, context }); return true } })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }) })
    cleanups.push(() => mesh.close())
    const res = await mesh.handle(new Request('http://a.test/'))
    assert.equal(await res.text(), 'ok')
    assert.ok(calls.length >= 1)
    assert.equal(calls[0].podId, pods.ingress.podId)
    assert.equal(calls[0].context.peer, pods.ingress.podId)
    assert.equal(calls[0].context.protocol, 'http')
    assert.equal(calls[0].context.version, 1)
  })

  for (const [name, allowFrom] of Object.entries({
    'says no': async () => false,
    'says something that is not true': async () => 'yes',
    'says nothing': () => undefined,
    'throws': () => { throw new Error('boom') },
    'rejects': async () => { throw new Error('boom') },
  })) {
    it(`a function that ${name} refuses, and the handler never runs`, async () => {
      let ran = 0
      const pods = await threePods()
      cleanups.push(() => pods.teardown())
      const served = serveHttpOnMesh(pods.p, () => { ran += 1; return new Response('x') }, { allowFrom })
      cleanups.push(() => served.stop())
      grantHttp(pods)
      const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }) })
      cleanups.push(() => mesh.close())
      const res = await mesh.handle(new Request('http://a.test/'))
      assert.equal(res.status, 502)
      assert.equal(ran, 0)
      assert.equal(served.stats().requests, 0)
      assert.ok(served.stats().refused >= 1)
    })
  }

  it('is re-asked for every request: a pod that stops being allowed is refused at once', async () => {
    let allowed = true
    const t = await rig({ provider: { allowFrom: async () => allowed } })
    assert.equal(await (await t.get('/')).text(), 'hello')
    allowed = false
    const res = await t.get('/')
    assert.equal(res.status, 502)
  })

  it('stays required: nothing, null, a number or an empty list is still an error', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    for (const allowFrom of [undefined, null, 5, [], {}]) assert.throws(() => serveHttpOnMesh(pods.p, () => new Response('x'), { allowFrom }), /allowFrom/)
  })
})

describe('signed requests: signRequest on the ingress, verifyRequest on the provider', () => {
  const sign = (keys) => async (bytes) => hex(await crypto.subtle.sign('Ed25519', keys.privateKey, bytes))
  const verifyWith = (keys, log = []) => async (request, { peer, sig, bytes }) => {
    log.push({ request, peer, sig, bytes })
    if (typeof sig !== 'string') return false
    try { return await crypto.subtle.verify('Ed25519', keys.publicKey, unhex(sig), bytes) } catch { return false }
  }

  it('a request whose signature verifies reaches the handler, and the handler can still read its body', async () => {
    const keys = await keyPair()
    const log = []
    const t = await rig({
      handler: async (request) => new Response(`${request.method}:${await request.text()}`),
      provider: { verifyRequest: verifyWith(keys, log) },
      ingress: { signRequest: sign(keys), methods: ['GET', 'POST'] },
    })
    const res = await t.get('/p?q=1', { method: 'POST', body: 'payload' })
    assert.equal(await res.text(), 'POST:payload')
    assert.equal(log[0].peer, t.ingress.podId)
    assert.equal(new URL(log[0].request.url).pathname, '/p')
  })

  it('the signature covers the request, a fresh nonce and the body digest (and says it is a request)', async () => {
    const keys = await keyPair()
    const signed = []
    const t = await rig({
      provider: { verifyRequest: verifyWith(keys) },
      ingress: { methods: ['GET', 'POST'], signRequest: async (bytes, info) => { signed.push({ bytes, info }); return sign(keys)(bytes) } },
    })
    await t.get('/one', { method: 'POST', body: 'a' })
    await t.get('/two', { method: 'POST', body: 'b' })
    const [a, b] = signed.map((s) => JSON.parse(new TextDecoder().decode(s.bytes)))
    assert.equal(a.dir, 'request')
    assert.notEqual(a.nonce, b.nonce)
    assert.notEqual(a.target, b.target)
    assert.notEqual(a.digest, b.digest)
    assert.equal(signed[0].info.peer, t.provider.podId)
    // the bytes are a pure function of the parts, so a provider rebuilds exactly what was signed
    assert.deepEqual(signedRequestBytes({ rid: a.rid, nonce: a.nonce, host: a.host, method: a.method, target: a.target, headers: a.headers, digest: a.digest }), signed[0].bytes)
  })

  it('an unsigned request, a wrong key, a failing or throwing hook: the handler never runs and the ingress names it', async () => {
    const keys = await keyPair()
    const other = await keyPair()
    const cases = {
      'unsigned': { ingress: {}, provider: { verifyRequest: verifyWith(keys) } },
      'signed with another key': { ingress: { signRequest: sign(other) }, provider: { verifyRequest: verifyWith(keys) } },
      'hook says no': { ingress: { signRequest: sign(keys) }, provider: { verifyRequest: async () => false } },
      'hook says not-true': { ingress: { signRequest: sign(keys) }, provider: { verifyRequest: async () => 'yes' } },
      'hook throws': { ingress: { signRequest: sign(keys) }, provider: { verifyRequest: () => { throw new Error('x') } } },
    }
    for (const [name, opts] of Object.entries(cases)) {
      let ran = 0
      const t = await rig({ handler: () => { ran += 1; return new Response('x') }, ...opts })
      const res = await t.get('/')
      assert.equal(res.status, 502, name)
      assert.equal(reasonOf(res), 'provider-refused-request', name)
      assert.equal(ran, 0, name)
    }
  })

  it('a signature made for one request does not verify for another', async () => {
    const keys = await keyPair()
    const log = []
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    let ran = 0
    const served = serveHttpOnMesh(pods.p, () => { ran += 1; return new Response('x') }, { allowFrom: [pods.ingress.podId], verifyRequest: verifyWith(keys, log) })
    cleanups.push(() => served.stop())
    grantHttp(pods)
    const channel = await pods.i.api.openProtocol(pods.provider.podId, 'http', { versions: [1] })
    const streams = createStreamLayer(channel)
    streams.onStream((reader) => { reader.bytes().catch(() => {}) })
    const head = { rid: 1, nonce: 'a'.repeat(16), method: 'GET', target: '/real', host: 'app.example.test', headers: [], body: false }
    const bytes = signedRequestBytes({ rid: 1, nonce: head.nonce, host: head.host, method: 'GET', target: '/real', headers: [], digest: await digest(new Uint8Array(0)) })
    const sig = await sign(keys)(bytes)
    assert.equal((await channel.request('fetch', { ...head, sig })).status, 200)
    for (const change of [{ target: '/other' }, { nonce: 'b'.repeat(16) }, { host: 'evil.test' }, { rid: 2 }, { headers: [['accept', 'x']] }]) {
      await assert.rejects(channel.request('fetch', { ...head, rid: 3, ...change, sig }), (e) => e.reason === 'request-unverified')
    }
    assert.equal(ran, 1)
  })

  it('a signRequest that throws or returns no text is a 500 and nothing is sent', async () => {
    for (const signRequest of [async () => { throw new Error('x') }, async () => 5, async () => '']) {
      let ran = 0
      const t = await rig({ handler: () => { ran += 1; return new Response('x') }, ingress: { signRequest } })
      const res = await t.get('/')
      assert.equal(res.status, 500)
      assert.equal(reasonOf(res), 'sign-error')
      assert.equal(ran, 0)
    }
  })

  it('both hooks must be functions', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    assert.throws(() => serveHttpOnMesh(pods.p, () => new Response('x'), { allowFrom: ['a'], verifyRequest: 'yes' }), /verifyRequest/)
    assert.throws(() => createMeshIngress({ service: pods.i, resolve: () => null, signRequest: 'yes' }), /signRequest/)
  })
})

async function digest(bytes) {
  return hex(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)))
}

describe('the forced Content-Security-Policy refuses framing by default', () => {
  it('the default forbids frame ancestors', async () => {
    assert.match(DEFAULT_CSP, /frame-ancestors 'none'/)
    const t = await rig()
    const res = await t.get('/')
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; sandbox")
    const refused = await rig({ ingress: { resolve: () => null } })
    assert.match((await refused.get('/')).headers.get('content-security-policy'), /frame-ancestors 'none'/)
  })

  it('the mapping\'s own opt-out covers it: false removes the policy, a string replaces it', async () => {
    for (const [policy, expected] of [[false, null], ["default-src 'none'; frame-ancestors 'self'", "default-src 'none'; frame-ancestors 'self'"]]) {
      const t = await rig()
      const mesh = createMeshIngress({ service: t.i, resolve: () => ({ peer: t.provider.podId, response: { contentSecurityPolicy: policy } }) })
      cleanups.push(() => mesh.close())
      const res = await mesh.handle(new Request('http://a.test/'))
      assert.equal(res.headers.get('content-security-policy'), expected)
    }
  })
})

describe('operator response headers (response.addHeaders)', () => {
  const withMapping = async (response, handler) => {
    const t = await rig({ handler })
    const mesh = createMeshIngress({ service: t.i, resolve: () => ({ peer: t.provider.podId, response }) })
    cleanups.push(() => mesh.close())
    return (path = '/') => mesh.handle(new Request(`http://a.test${path}`))
  }

  it('adds the operator\'s headers to the provider\'s response, buffered or streamed', async () => {
    const get = await withMapping({ addHeaders: { 'Access-Control-Allow-Origin': 'https://app.example', 'x-served-by': 'edge-1' } }, () => new Response('body', { headers: { 'content-type': 'text/plain' } }))
    const res = await get()
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://app.example')
    assert.equal(res.headers.get('x-served-by'), 'edge-1')
    assert.equal(res.headers.get('content-type'), 'text/plain')
    assert.equal(await res.text(), 'body')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  })

  it('the operator\'s value wins over a header the provider was allowed to set', async () => {
    const get = await withMapping({ addHeaders: { vary: 'origin', allow: 'GET' } }, () => new Response('x', { headers: { allow: 'GET, POST' } }))
    const res = await get()
    assert.equal(res.headers.get('allow'), 'GET')
    assert.match(res.headers.get('vary'), /origin/)
  })

  const refused = {
    'a line break in a value': { 'x-a': 'one\r\nset-cookie: a=1' },
    'a bare newline in a value': { 'x-a': 'one\ntwo' },
    'a name that is not a token': { 'x a': '1' },
    'an empty name': { '': '1' },
    'a hop-by-hop header (connection)': { connection: 'close' },
    'a hop-by-hop header (transfer-encoding)': { 'transfer-encoding': 'chunked' },
    'a hop-by-hop header (upgrade)': { upgrade: 'websocket' },
    'a hop-by-hop header (proxy-authenticate)': { 'proxy-authenticate': 'Basic' },
    'framing (content-length)': { 'content-length': '3' },
    'framing (content-encoding)': { 'content-encoding': 'gzip' },
    'a forced header without its opt-out (content-security-policy)': { 'content-security-policy': "default-src *" },
    'a forced header that has no opt-out (x-content-type-options)': { 'x-content-type-options': 'sniff' },
    'a forced header without its opt-out (cache-control)': { 'cache-control': 'public' },
    'set-cookie without allowSetCookie': { 'set-cookie': 'a=1' },
    'a value that is not text': { 'x-a': 5 },
    'a value over the bound': { 'x-a': 'v'.repeat(1025) },
    'more headers than the bound': Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`x-h${i}`, '1'])),
  }
  for (const [name, addHeaders] of Object.entries(refused)) {
    it(`refuses ${name} as a bad mapping, before any provider is asked`, async () => {
      let ran = 0
      const t = await rig({ handler: () => { ran += 1; return new Response('x') } })
      const mesh = createMeshIngress({ service: t.i, resolve: () => ({ peer: t.provider.podId, response: { addHeaders } }) })
      cleanups.push(() => mesh.close())
      const res = await mesh.handle(new Request('http://a.test/'))
      assert.equal(res.status, 500)
      assert.equal(reasonOf(res), 'bad-mapping')
      assert.equal(ran, 0)
    })
  }

  it('the forced headers can be replaced only where their own opt-out is set', async () => {
    const get = await withMapping({ contentSecurityPolicy: false, cacheControl: false, addHeaders: { 'content-security-policy': "default-src 'self'", 'cache-control': 'max-age=60' } })
    const res = await get()
    assert.equal(res.headers.get('content-security-policy'), "default-src 'self'")
    assert.equal(res.headers.get('cache-control'), 'max-age=60')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    const custom = await withMapping({ contentSecurityPolicy: "default-src 'none'", addHeaders: { 'content-security-policy': "default-src *" } })
    assert.equal((await custom()).status, 500)
  })

  it('set-cookie is allowed only with allowSetCookie', async () => {
    const get = await withMapping({ allowSetCookie: true, addHeaders: { 'set-cookie': 'a=1; HttpOnly' } })
    assert.deepEqual((await get()).headers.getSetCookie(), ['a=1; HttpOnly'])
  })

  it('addHeaders must be an object of text', async () => {
    for (const addHeaders of ['x: 1', [['x', '1']], 5]) {
      const get = await withMapping({ addHeaders })
      assert.equal((await get()).status, 500)
    }
  })
})

describe('a provider that declines: "not me, try another"', () => {
  it('declineRequest() is surfaced as provider-declined, never as the provider\'s own response', async () => {
    const t = await rig({ handler: () => declineRequest() })
    const res = await t.get('/')
    assert.equal(res.status, 502)
    assert.equal(reasonOf(res), 'provider-declined')
    assert.notEqual(res.status, 421)
    assert.equal(t.audits.at(-1).reason, 'provider-declined')
    assert.equal(t.mesh.stats().reasons['provider-declined'], 1)
  })

  it('a plain 421 from a handler is that provider\'s own answer; only the helper declines', async () => {
    const t = await rig({ handler: () => new Response('mine', { status: 421 }) })
    const res = await t.get('/')
    assert.equal(res.status, 421)
    assert.equal(await res.text(), 'mine')
  })

  it('a decline is recognised before a signature is required (it is not a response)', async () => {
    const t = await rig({ handler: () => declineRequest(), ingress: { verifyResponse: async () => true } })
    assert.equal(reasonOf(await t.get('/')), 'provider-declined')
  })

  it('a provider that sends a decline with a body or headers is refused as a bad head', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    pods.p.api.serveProtocol('http', (channel) => {
      channel.onRequest('fetch', async () => ({ status: 421, headers: [['x-a', '1']], body: false, declined: true }))
    }, { versions: [1] })
    grantHttp(pods)
    const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }) })
    cleanups.push(() => mesh.close())
    const res = await mesh.handle(new Request('http://a.test/'))
    assert.equal(reasonOf(res), 'bad-response-head')
  })
})

describe('retry: bounded, only before a provider did any work', () => {
  const ON = ['provider-unreachable', 'provider-pin-mismatch', 'provider-declined']
  /** resolve: the first pod not yet tried, in this order. */
  const inOrder = (order, log) => (request, ctx) => { log.push({ attempt: ctx?.attempt, tried: [...(ctx?.tried ?? [])] }); const peer = order.find((p) => !(ctx?.tried ?? []).includes(p)); return peer ? { peer } : null }

  it('a declined request is asked again with the tried pod ids, and the next pod answers', async () => {
    const log = []
    const t = await rig({ handler: () => declineRequest(), both: {}, ingress: { retry: { attempts: 1, on: ON } } })
    const mesh = createMeshIngress({ service: t.i, resolve: inOrder([t.provider.podId, t.stranger.podId], log), retry: { attempts: 1, on: ON }, onAudit: (r) => t.audits.push(r) })
    cleanups.push(() => mesh.close())
    t.audits.length = 0
    const res = await mesh.handle(new Request('http://a.test/'))
    assert.equal(await res.text(), 'from stranger')
    assert.deepEqual(log, [{ attempt: 0, tried: [] }, { attempt: 1, tried: [t.provider.podId] }])
    // audited per attempt: the one that was handed on, and the one that answered
    assert.equal(t.audits.length, 2)
    assert.deepEqual(t.audits.map((a) => [a.attempt, a.peer, a.reason, a.retried === true]), [[0, t.provider.podId, 'provider-declined', true], [1, t.stranger.podId, undefined, false]])
    assert.equal(t.audits[1].status, 200)
    assert.equal(mesh.stats().retries, 1)
  })

  it('a pod with no direct link is handed on to the next', async () => {
    const t = await rig({ both: {} })
    const log = []
    const mesh = createMeshIngress({ service: t.i, resolve: inOrder(['podNotOnThisBus', t.stranger.podId], log), retry: { attempts: 1, on: ON } })
    cleanups.push(() => mesh.close())
    assert.equal(await (await mesh.handle(new Request('http://a.test/'))).text(), 'from stranger')
    assert.equal(log.length, 2)
  })

  it('a channel bound to another pod is handed on, and that pod was sent nothing', async () => {
    const asked = []
    const t = await rig({ handler: () => { asked.push('provider'); return new Response('p') }, both: { stranger: () => { asked.push('stranger'); return new Response('s') } } })
    // A service whose open for the first pod lands on the stranger: the pin check refuses it and the retry names the stranger itself.
    const lying = { api: { openProtocol: (peer, name, opts) => t.i.api.openProtocol(peer === t.provider.podId ? t.stranger.podId : peer, name, opts) } }
    const mesh = createMeshIngress({ service: lying, resolve: inOrder([t.provider.podId, t.stranger.podId], []), retry: { attempts: 1, on: ON } })
    cleanups.push(() => mesh.close())
    assert.equal(await (await mesh.handle(new Request('http://a.test/'))).text(), 's')
    assert.deepEqual(asked, ['stranger'])
  })

  it('is bounded by attempts: one retry is two resolves, and the last failure is the answer', async () => {
    const log = []
    let n = 0
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const mesh = createMeshIngress({ service: pods.i, resolve: (r, ctx) => { log.push(ctx.attempt); return { peer: `ghost${n++}` } }, retry: { attempts: 2, on: ON } })
    cleanups.push(() => mesh.close())
    const res = await mesh.handle(new Request('http://a.test/'))
    assert.equal(reasonOf(res), 'provider-unreachable')
    assert.deepEqual(log, [0, 1, 2])
  })

  it('only the failures listed in `on` are retried', async () => {
    const log = []
    const t = await rig({ both: {} })
    const mesh = createMeshIngress({ service: t.i, resolve: inOrder(['podNotOnThisBus', t.stranger.podId], log), retry: { attempts: 3, on: ['provider-declined'] } })
    cleanups.push(() => mesh.close())
    assert.equal(reasonOf(await mesh.handle(new Request('http://a.test/'))), 'provider-unreachable')
    assert.equal(log.length, 1)
  })

  it('nothing is retried once a provider answered: its own error, a bad signature, a refused request', async () => {
    const keys = await keyPair()
    const cases = {
      'its own 503': { handler: () => new Response('busy', { status: 503 }), ingress: {}, status: 503 },
      'a bad signature': { handler: () => new Response('x'), provider: { sign: async () => 'aa' }, ingress: { verifyResponse: async () => false }, status: 502 },
      'a refused request': { handler: () => new Response('x'), provider: { verifyRequest: async () => false }, ingress: { signRequest: async (b) => hex(await crypto.subtle.sign('Ed25519', keys.privateKey, b)) }, status: 502 },
    }
    for (const [name, c] of Object.entries(cases)) {
      const log = []
      const t = await rig({ handler: c.handler, provider: c.provider, both: {} })
      const mesh = createMeshIngress({ service: t.i, resolve: inOrder([t.provider.podId, t.stranger.podId], log), retry: { attempts: 3, on: ON }, ...c.ingress })
      cleanups.push(() => mesh.close())
      const res = await mesh.handle(new Request('http://a.test/'))
      assert.equal(res.status, c.status, name)
      assert.equal(log.length, 1, name)
    }
  })

  it('a non-idempotent method is retried only if the caller opts in', async () => {
    for (const [optIn, expected] of [[false, 'provider-declined'], [true, 'from stranger']]) {
      const log = []
      const t = await rig({ handler: () => declineRequest(), both: {} })
      const mesh = createMeshIngress({ service: t.i, methods: ['GET', 'POST', 'PUT'], resolve: inOrder([t.provider.podId, t.stranger.podId], log), retry: { attempts: 1, on: ON, nonIdempotent: optIn } })
      cleanups.push(() => mesh.close())
      const res = await mesh.handle(new Request('http://a.test/', { method: 'POST', body: 'x' }))
      assert.equal(reasonOf(res) ?? await res.text(), expected)
    }
    // PUT is idempotent by definition: retried without the opt-in, with the same body
    const t = await rig({ handler: () => declineRequest(), both: { stranger: async (request) => new Response(`got ${await request.text()}`) } })
    const mesh = createMeshIngress({ service: t.i, methods: ['GET', 'PUT'], resolve: inOrder([t.provider.podId, t.stranger.podId], []), retry: { attempts: 1, on: ON } })
    cleanups.push(() => mesh.close())
    assert.equal(await (await mesh.handle(new Request('http://a.test/', { method: 'PUT', body: 'the body' }))).text(), 'got the body')
  })

  it('every attempt is authorised against the mapping it names: a refused second mapping is a 403, not a hidden retry', async () => {
    const asked = []
    const t = await rig({ handler: () => declineRequest(), both: {} })
    const mesh = createMeshIngress({
      service: t.i,
      resolve: inOrder([t.provider.podId, t.stranger.podId], []),
      authorize: (request, mapping) => { asked.push(mapping.peer); return mapping.peer === t.provider.podId },
      retry: { attempts: 1, on: ON },
    })
    cleanups.push(() => mesh.close())
    const res = await mesh.handle(new Request('http://a.test/'))
    assert.equal(res.status, 403)
    assert.deepEqual(asked, [t.provider.podId, t.stranger.podId])
  })

  it('a mapping that goes away on retry leaves the original failure, and a repeated pod is not asked twice', async () => {
    const t = await rig({ handler: () => declineRequest() })
    const asked = []
    const mesh = createMeshIngress({ service: t.i, resolve: (r, ctx) => (ctx.attempt === 0 ? { peer: t.provider.podId } : null), retry: { attempts: 2, on: ON } })
    cleanups.push(() => mesh.close())
    assert.equal(reasonOf(await mesh.handle(new Request('http://a.test/'))), 'provider-declined')
    await mesh.close() // one ingress at a time holds the channel to a provider
    const again = createMeshIngress({ service: t.i, resolve: () => { asked.push(1); return { peer: t.provider.podId } }, retry: { attempts: 2, on: ON } })
    cleanups.push(() => again.close())
    assert.equal(reasonOf(await again.handle(new Request('http://a.test/'))), 'provider-declined')
    assert.equal(asked.length, 2, 'asked again once, and the same pod was not tried a second time')
  })

  it('the whole request stays under one deadline', async () => {
    const t = await rig({ handler: () => declineRequest(), both: { stranger: () => new Promise(() => {}) } })
    const mesh = createMeshIngress({ service: t.i, resolve: inOrder([t.provider.podId, t.stranger.podId], []), limits: { timeoutMs: 100 }, retry: { attempts: 2, on: ON } })
    cleanups.push(() => mesh.close())
    assert.equal((await mesh.handle(new Request('http://a.test/'))).status, 504)
  })

  it('is validated: attempts 1 to 5, only the three failures, nonIdempotent a boolean', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const make = (retry) => () => createMeshIngress({ service: pods.i, resolve: () => null, retry })
    for (const retry of [{ attempts: 0 }, { attempts: 6 }, { attempts: 1.5 }, { attempts: 'x' }, { attempts: 1, on: ['provider-timeout'] }, { attempts: 1, on: 'provider-declined' }, { attempts: 1, on: [] }, { attempts: 1, nonIdempotent: 'yes' }, 5, null]) {
      assert.throws(make(retry), /retry/, JSON.stringify(retry))
    }
    assert.doesNotThrow(make({ attempts: 1 }))
    assert.doesNotThrow(make(undefined))
  })

  it('without retry, nothing changes: resolve is asked once, with no second argument needed', async () => {
    const calls = []
    const t = await rig({ handler: () => declineRequest() })
    const mesh = createMeshIngress({ service: t.i, resolve: (...args) => { calls.push(args.length); return { peer: t.provider.podId } } })
    cleanups.push(() => mesh.close())
    assert.equal(reasonOf(await mesh.handle(new Request('http://a.test/'))), 'provider-declined')
    assert.equal(calls.length, 1)
    assert.equal(mesh.stats().retries, 0)
  })
})
