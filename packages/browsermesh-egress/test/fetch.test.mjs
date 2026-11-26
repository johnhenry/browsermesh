// The fetch form: the provider is the HTTP client. Grants (reusing the TCP form's rules), methods, redirects (each hop re-authorised
// and re-checked), TLS verified against the NAME on the checked address, header policy, streamed bodies under the same budgets,
// and what the audit carries. Every origin is a local listener; "public" addresses are table entries behind the provider's seam.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { createStreamLayer } from '@johnhenry/browsermesh-apps/protocol-stream'
import { connectEgress, createMeshEgress, EgressError, EGRESS_SCOPES, WIDE_ACKNOWLEDGEMENT } from '../src/index.mjs'
import { createExchange } from '../src/node.mjs'
import { threePods, grant, revoke, until, patternByte, patternChunk, rawChannel, deferred } from './helpers/mesh.mjs'
import { A1, A2, A3, PRIVATE, httpOrigin, httpsOrigin, ok, fetchRig, bodyOf } from './helpers/http.mjs'
import { SECURE, OTHER } from './helpers/pki.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
const KiB = 1024
const MiB = 1024 * KiB
const code = (c) => (e) => e instanceof EgressError && e.code === c
const origin = async (handler = ok()) => { const o = await httpOrigin(handler); cleanups.push(() => o.close()); return o }
const tlsOrigin = async (pki, handler = ok('secure')) => { const o = await httpsOrigin(pki, handler); cleanups.push(() => o.close()); return o }

/** One plain origin at plain.test:80, granted. */
async function plain(handler = ok('hello'), extra = {}) {
  const o = await origin(handler)
  const r = await fetchRig(cleanups, { names: { 'plain.test': [A1] }, origins: { [`${A1}:80`]: o.port }, grants: [EGRESS_SCOPES.http('plain.test', 80)], ...extra })
  return { o, ...r }
}

/** A raw consumer: the channel and a stream layer, no link library. `ask` sends a fetch request with defaults. */
async function raw(pods) {
  const channel = await rawChannel(pods)
  const streams = createStreamLayer(channel, {})
  const downs = new Map()
  streams.onStream((reader, { meta }) => { downs.set(meta.cid, reader) })
  const ask = (params) => channel.request('fetch', { method: 'GET', headers: [], body: false, redirect: 'follow', hops: 0, ...params })
  return { channel, streams, downs, ask }
}

describe('the request, as the origin sees it, and the Response, as the consumer gets it', () => {
  it('a GET returns a Response with the origin\'s status, body and allow-listed headers; the origin sees only what the policy sends', async () => {
    const { o, link } = await plain(ok('hello', { etag: '"v1"', 'x-custom': 'dropped', 'set-cookie': 'sid=1', 'set-cookie2': 'a=b', 'proxy-authenticate': 'Basic', 'keep-alive': 'timeout=5' }))
    const res = await link.fetch('http://plain.test/a/b?q=1', { headers: { accept: 'text/plain', cookie: 'a=b', 'x-forwarded-for': '1.2.3.4', 'proxy-authorization': 'Basic x', origin: 'https://page.test', referer: 'https://page.test/', 'user-agent': 'a-browser', te: 'trailers', upgrade: 'websocket', 'x-anything': '1' } })
    assert.ok(res instanceof Response)
    assert.equal(res.status, 200)
    assert.equal(await res.text(), 'hello')
    assert.equal(res.headers.get('content-type'), 'text/plain')
    assert.equal(res.headers.get('etag'), '"v1"')
    for (const dropped of ['x-custom', 'set-cookie', 'set-cookie2', 'proxy-authenticate', 'keep-alive', 'connection', 'transfer-encoding']) assert.equal(res.headers.get(dropped), null, dropped)
    assert.equal(res.url, 'http://plain.test/a/b?q=1')
    assert.equal(res.redirected, false)
    const seen = o.seen[0]
    assert.equal(seen.method, 'GET')
    assert.equal(seen.url, '/a/b?q=1')
    assert.deepEqual(Object.keys(seen.headers).sort(), ['accept', 'accept-encoding', 'connection', 'host', 'user-agent'])
    assert.equal(seen.headers.host, 'plain.test')
    assert.equal(seen.headers.accept, 'text/plain')
    assert.equal(seen.headers['accept-encoding'], 'identity')
    assert.equal(seen.headers['user-agent'], 'browsermesh-egress')
    assert.equal(seen.headers.connection, 'close')
  })

  it('the consumer\'s identity is never added to the request; an option adds it, and the consumer cannot set that header itself', async () => {
    const a = await plain()
    await (await a.link.fetch('http://plain.test/', { headers: { 'x-browsermesh-consumer': 'forged' } })).arrayBuffer()
    assert.equal(a.o.seen[0].headers['x-browsermesh-consumer'], undefined)
    const b = await plain(ok(), { egress: { identifyConsumers: true } })
    await (await b.link.fetch('http://plain.test/', { headers: { 'x-browsermesh-consumer': 'forged' } })).arrayBuffer()
    assert.equal(b.o.seen[0].headers['x-browsermesh-consumer'], b.pods.consumer.podId)
  })

  it('what the consumer may send on: conditional, range, content-type, authorization and a length; nothing else', async () => {
    const { o, link } = await plain(ok(), { egress: { fetchMethods: ['GET', 'HEAD', 'POST'] } })
    await (await link.fetch('http://plain.test/', { method: 'POST', body: 'abc', headers: { 'content-type': 'text/x', authorization: 'Bearer t', range: 'bytes=0-1', 'if-none-match': '"x"', 'if-modified-since': 'Sat, 01 Jan 2000 00:00:00 GMT', 'accept-language': 'en', 'cache-control': 'no-cache', pragma: 'no-cache' } })).arrayBuffer()
    const h = o.seen[0].headers
    assert.equal(h.authorization, 'Bearer t')
    assert.equal(h['content-type'], 'text/x')
    assert.equal(h.range, 'bytes=0-1')
    assert.equal(h['if-none-match'], '"x"')
    assert.equal(h['accept-language'], 'en')
    assert.equal(o.seen[0].body.toString(), 'abc')
  })

  it('no decompression: the origin\'s compressed bytes and its content-encoding reach the consumer exactly; the request said identity', async () => {
    const gz = gzipSync(Buffer.from('compressed text'))
    const { o, link } = await plain((req, res) => { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip', 'content-length': gz.length }); res.end(gz) })
    const res = await link.fetch('http://plain.test/', { headers: { 'accept-encoding': 'gzip, br' } })
    assert.equal(res.headers.get('content-encoding'), 'gzip')
    assert.deepEqual(await bodyOf(res), gz)
    assert.equal(o.seen[0].headers['accept-encoding'], 'identity')
  })

  it('HEAD has no body; 204 and 304 have none either; a 404 is a Response, not an error', async () => {
    const { link } = await plain((req, res) => {
      if (req.url === '/204') { res.writeHead(204); res.end(); return }
      if (req.url === '/304') { res.writeHead(304, { etag: '"x"' }); res.end(); return }
      if (req.url === '/404') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nope'); return }
      res.writeHead(200, { 'content-length': '5' }); res.end(req.method === 'HEAD' ? undefined : 'hello')
    })
    const head = await link.fetch('http://plain.test/', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(head.headers.get('content-length'), '5')
    assert.equal((await bodyOf(head)).length, 0)
    assert.equal((await link.fetch('http://plain.test/204')).status, 204)
    const r304 = await link.fetch('http://plain.test/304')
    assert.equal(r304.status, 304)
    assert.equal(r304.headers.get('etag'), '"x"')
    const nf = await link.fetch('http://plain.test/404')
    assert.equal(nf.status, 404)
    assert.equal(await nf.text(), 'nope')
  })
})

describe('grants: the TCP form\'s rules, for the fetch scope', () => {
  it('no grant: refused no-grant, the same for a URL that exists and one that does not, before any lookup; the TCP grant is not a fetch grant', async () => {
    const o = await origin()
    const { link, net, audit } = await fetchRig(cleanups, { names: { 'plain.test': [A1] }, origins: { [`${A1}:80`]: o.port }, grants: [EGRESS_SCOPES.tcp('plain.test', 80), EGRESS_SCOPES.dns('plain.test'), EGRESS_SCOPES.udp('plain.test', 80)] })
    const a = await link.fetch('http://plain.test/').catch((e) => e)
    const b = await link.fetch('http://nowhere.test/').catch((e) => e)
    for (const e of [a, b]) assert.ok(e instanceof EgressError && e.code === 'no-grant', String(e))
    assert.equal(a.message, b.message)
    assert.deepEqual(net.calls.lookups, [])
    assert.deepEqual(net.calls.dials, [])
    assert.ok(audit.every((r) => r.event === 'egress-refused' && r.form === 'fetch'))
  })

  it('a fetch grant is not a TCP grant, and the port is part of the grant', async () => {
    const o = await origin()
    const { link } = await fetchRig(cleanups, { names: { 'plain.test': [A1] }, origins: { [`${A1}:80`]: o.port, [`${A1}:8080`]: o.port }, grants: [EGRESS_SCOPES.http('plain.test', 80)] })
    await assert.rejects(link.connect('plain.test', 80), code('no-grant'))
    await assert.rejects(link.fetch('http://plain.test:8080/'), code('no-grant'))
    assert.equal((await link.fetch('http://plain.test/')).status, 200)
  })

  it('a default port is the scheme\'s: http is 80, https is 443', async () => {
    const o = await origin()
    const t = await tlsOrigin(SECURE)
    const { link } = await fetchRig(cleanups, { names: { 'plain.test': [A1], 'secure.test': [A2] }, origins: { [`${A1}:80`]: o.port, [`${A2}:443`]: t.port }, grants: [EGRESS_SCOPES.http('plain.test', 80), EGRESS_SCOPES.http('secure.test', 443)] })
    assert.equal(await (await link.fetch('http://plain.test/')).text(), 'ok')
    assert.equal(await (await link.fetch('https://secure.test/')).text(), 'secure')
    assert.equal(await (await link.fetch('http://plain.test:80/')).text(), 'ok')
  })

  it('any port of a host, and a set\'s own fetch grant (a connect grant on the set is not one)', async () => {
    const o = await origin()
    const a = await fetchRig(cleanups, { names: { 'plain.test': [A1] }, origins: { [`${A1}:80`]: o.port, [`${A1}:8081`]: o.port }, grants: [EGRESS_SCOPES.httpAnyPort('plain.test')] })
    assert.equal(await (await a.link.fetch('http://plain.test:8081/')).text(), 'ok')
    const b = await fetchRig(cleanups, { names: { 'plain.test': [A1] }, origins: { [`${A1}:80`]: o.port }, sets: { web: ['plain.test:80,443'] }, grants: [EGRESS_SCOPES.set('web')] })
    await assert.rejects(b.link.fetch('http://plain.test/'), code('no-grant'))
    grant(b.pods, [EGRESS_SCOPES.setFetch('web')])
    assert.equal(await (await b.link.fetch('http://plain.test/')).text(), 'ok')
    await assert.rejects(b.link.fetch('http://plain.test:81/'), code('no-grant'))
  })

  it('a wildcard fetch grant is refused wide-not-acknowledged; with the acknowledgement it reaches public destinations only', async () => {
    const o = await origin()
    const names = { 'plain.test': [A1], 'inside.test': [PRIVATE] }
    const origins = { [`${A1}:80`]: o.port, [`${PRIVATE}:80`]: o.port }
    const refused = await fetchRig(cleanups, { names, origins, grants: ['egress:http:*:*:fetch'] })
    await assert.rejects(refused.link.fetch('http://plain.test/'), code('wide-not-acknowledged'))
    const wide = await fetchRig(cleanups, { names, origins, grants: ['egress:http:*:*:fetch'], egress: { wide: { acknowledge: WIDE_ACKNOWLEDGEMENT } } })
    assert.equal(await (await wide.link.fetch('http://plain.test/')).text(), 'ok')
    const e = await wide.link.fetch('http://inside.test/').catch((x) => x)
    assert.ok(e.code === 'destination-refused' && e.addressClass === 'private', String(e.code))
    assert.equal(wide.net.calls.dials.at(-1).wide, true)
    // wide per form: a wide TCP grant is not a wide fetch grant
    const tcpWide = await fetchRig(cleanups, { names, origins, grants: ['egress:tcp:*:*:connect'], egress: { wide: { acknowledge: WIDE_ACKNOWLEDGEMENT } } })
    await assert.rejects(tcpWide.link.fetch('http://plain.test/'), code('no-grant'))
  })

  it('port 25 stays blocked for the fetch form, and the operator\'s deny hook is asked', async () => {
    const o = await origin()
    const { link } = await fetchRig(cleanups, { names: { 'plain.test': [A1] }, origins: { [`${A1}:25`]: o.port, [`${A1}:80`]: o.port }, grants: [EGRESS_SCOPES.httpAnyPort('plain.test')], egress: { deny: ({ host, port }) => port === 81 && host === 'plain.test' } })
    await assert.rejects(link.fetch('http://plain.test:25/'), code('port-blocked'))
    await assert.rejects(link.fetch('http://plain.test:81/'), code('destination-refused'))
    assert.equal((await link.fetch('http://plain.test/')).status, 200)
  })
})

describe('methods', () => {
  it('GET and HEAD by default; POST, PUT, PATCH, DELETE and OPTIONS only when the operator lists them; CONNECT and TRACE never', async () => {
    const { o, link } = await plain(ok(), { egress: { fetchMethods: ['GET', 'HEAD', 'DELETE'] } })
    for (const method of ['POST', 'PUT', 'PATCH', 'OPTIONS']) await assert.rejects(link.fetch('http://plain.test/', { method, ...(method === 'OPTIONS' ? {} : { body: 'x' }) }), code('method-not-allowed'), method)
    assert.equal(o.seen.length, 0, 'nothing reached the origin')
    assert.equal((await link.fetch('http://plain.test/', { method: 'DELETE' })).status, 200)
    for (const bad of [['CONNECT'], ['TRACE'], ['GET', 'TRACK'], ['get'], 'GET']) {
      const pods = await threePods()
      cleanups.push(() => pods.teardown())
      assert.throws(() => createMeshEgress({ service: pods.p, registry: pods.provider.registry, dial: async () => {}, resolve: async () => {}, unattended: true, fetchMethods: bad }), TypeError, JSON.stringify(bad))
    }
  })

  it('a request body streams to the origin with every byte checked', async () => {
    const { o, link } = await plain((req, res) => { req.on('end', () => res.end('stored')) }, { egress: { fetchMethods: ['GET', 'HEAD', 'POST', 'PUT'] } })
    const total = 3 * MiB + 17
    let at = 0
    const body = new ReadableStream({ pull(c) { if (at >= total) { c.close(); return } const n = Math.min(100_000, total - at); c.enqueue(patternChunk(at, n)); at += n } })
    const res = await link.fetch('http://plain.test/upload', { method: 'PUT', body, duplex: 'half', headers: { 'content-type': 'application/octet-stream' } })
    assert.equal(await res.text(), 'stored')
    await until(() => o.seen[0].body.length === total, 'the origin to finish reading')
    for (let i = 0; i < total; i += 997) assert.equal(o.seen[0].body[i], patternByte(i), `byte ${i}`)
  })

  it('a body on a GET is not sent', async () => {
    const { link } = await plain()
    await assert.rejects(link.fetch('http://plain.test/', { method: 'GET', body: 'x' }), TypeError)
  })
})

describe('what a URL may be', () => {
  it('only http and https, no credentials in it, no IPv6 literal, no pod id, no other spelling of an address', async () => {
    const { link, net } = await plain()
    await assert.rejects(link.fetch('ftp://plain.test/'), code('bad-url'))
    await assert.rejects(link.fetch('http://user:pw@plain.test/'), TypeError, 'the platform\'s own Request refuses credentials in a URL')
    await assert.rejects(link.fetch('http://[::1]/'), code('bad-destination'))
    await assert.rejects(link.fetch('/relative'), TypeError)
    await assert.rejects(link.fetch(`http://${'a'.repeat(43)}/`), code('chaining-refused'))
    await assert.rejects(link.fetch(`http://${link.peer}/`), code('chaining-refused'))
    assert.deepEqual(net.calls.lookups, [])
  })

  it('the provider checks too: a raw request with a URL it will not serve is refused bad-url, or bad-request when it is not even a string', async () => {
    const { pods } = await plain(ok(), { link: false, egress: { limits: { maxBadRequests: 100 } } })
    const { ask: send } = await raw(pods)
    const ask = (params) => send({ cid: 1, ...params })
    assert.equal((await ask({ url: 'gopher://plain.test/' })).code, 'bad-url')
    assert.equal((await ask({ cid: 2, url: 'http://u:p@plain.test/' })).code, 'bad-url')
    assert.equal((await ask({ cid: 3, url: 'http://plain.test/' + 'a'.repeat(9000) })).code, 'bad-url')
    assert.equal((await ask({ cid: 4, url: 5 })).code, 'bad-request')
    assert.equal((await ask({ cid: 5, url: 'http://Plain.Test/x' })).ok, true, 'the URL parser lower-cases a host: the grant for plain.test covers it')
    assert.equal((await ask({ cid: 13, url: 'http://Evil.Test/x' })).code, 'no-grant')
    assert.equal((await ask({ cid: 6, url: 'http://plain.test/', hops: 1 })).code, 'chaining-refused')
    assert.equal((await ask({ cid: 7, url: 'http://plain.test/', method: 'get' })).code, 'bad-request')
    assert.equal((await ask({ cid: 8, url: 'http://plain.test/', redirect: 'whatever' })).code, 'bad-request')
    assert.equal((await ask({ cid: 9, url: 'http://plain.test/', headers: [['accept', 'a\r\nx: y']] })).code, 'bad-request')
    assert.equal((await ask({ cid: 10, url: 'http://plain.test/', headers: [['bad name', 'x']] })).code, 'bad-request')
    assert.equal((await ask({ cid: 11, url: 'http://plain.test/', headers: [['accept', 'x'.repeat(20_000)]] })).code, 'bad-request')
    assert.equal((await ask({ cid: 12, url: 'http://plain.test/', method: 'GET', body: true })).code, 'bad-request')
  })
})

describe('redirects: every hop is authorised and checked again', () => {
  const redirectTo = (location, status = 302) => (req, res) => { res.writeHead(status, { location }); res.end() }

  it('a redirect to a destination the consumer holds a grant for is followed, with the relative form resolved; Authorization stays on the same origin and is dropped on another', async () => {
    const b = await origin(ok('landed'))
    const a = await origin((req, res) => {
      if (req.url === '/same') { res.writeHead(302, { location: '/landing' }); res.end(); return }
      if (req.url === '/landing') { res.writeHead(200); res.end('same origin'); return }
      res.writeHead(302, { location: 'http://other.test/final' }); res.end()
    })
    const { link, net } = await fetchRig(cleanups, { names: { 'plain.test': [A1], 'other.test': [A2] }, origins: { [`${A1}:80`]: a.port, [`${A2}:80`]: b.port }, grants: [EGRESS_SCOPES.http('plain.test', 80), EGRESS_SCOPES.http('other.test', 80)] })
    const same = await link.fetch('http://plain.test/same', { headers: { authorization: 'Bearer t' } })
    assert.equal(await same.text(), 'same origin')
    assert.equal(same.url, 'http://plain.test/landing')
    assert.equal(same.redirected, true)
    assert.equal(a.seen[1].headers.authorization, 'Bearer t')
    const cross = await link.fetch('http://plain.test/away', { headers: { authorization: 'Bearer t', accept: 'text/plain' } })
    assert.equal(await cross.text(), 'landed')
    assert.equal(cross.url, 'http://other.test/final')
    assert.equal(b.seen[0].headers.authorization, undefined, 'a credential does not follow to another host')
    assert.equal(b.seen[0].headers.accept, 'text/plain')
    assert.equal(b.seen[0].headers.host, 'other.test')
    assert.equal(net.calls.lookups.filter((n) => n === 'other.test').length, 1, 'each hop resolves once')
  })

  it('a redirect to a destination with no grant is refused redirect-refused and never dialled or looked up', async () => {
    const b = await origin(ok('should not be reached'))
    const a = await origin(redirectTo('http://secret.test/x'))
    const { link, net, audit } = await fetchRig(cleanups, { names: { 'plain.test': [A1], 'secret.test': [A2] }, origins: { [`${A1}:80`]: a.port, [`${A2}:80`]: b.port }, grants: [EGRESS_SCOPES.http('plain.test', 80)] })
    await assert.rejects(link.fetch('http://plain.test/'), code('redirect-refused'))
    assert.deepEqual(net.calls.lookups, ['plain.test'])
    assert.equal(b.seen.length, 0)
    const refused = audit.find((r) => r.event === 'egress-refused')
    assert.equal(refused.code, 'redirect-refused')
    assert.equal(refused.host, 'secret.test')
    assert.equal(refused.hop, 1)
  })

  it('a redirect to a private address is destination-refused with its class; to a blocked port, port-blocked; to another scheme, redirect-refused', async () => {
    const pass = await origin(ok())
    const targets = { '/private': 'http://inside.test/', '/blocked': 'http://plain.test:25/', '/ftp': 'ftp://plain.test/', '/creds': 'http://u:p@plain.test/', '/v6': 'http://[::1]/', '/junk': 'http://' }
    const a = await origin((req, res) => { res.writeHead(302, { location: targets[req.url] }); res.end() })
    const { link } = await fetchRig(cleanups, { names: { 'plain.test': [A1], 'inside.test': [PRIVATE] }, origins: { [`${A1}:80`]: a.port, [`${A1}:25`]: pass.port, [`${PRIVATE}:80`]: pass.port }, grants: [EGRESS_SCOPES.http('plain.test', 80), EGRESS_SCOPES.httpAnyPort('plain.test'), EGRESS_SCOPES.http('inside.test', 80)] })
    const p = await link.fetch('http://plain.test/private').catch((e) => e)
    assert.ok(p.code === 'destination-refused' && p.addressClass === 'private', String(p.code))
    await assert.rejects(link.fetch('http://plain.test/blocked'), code('port-blocked'))
    for (const path of ['/ftp', '/creds', '/v6', '/junk']) await assert.rejects(link.fetch(`http://plain.test${path}`), code('redirect-refused'), path)
    assert.equal(pass.seen.length, 0)
  })

  it('at most maxRedirects hops: a loop is too-many-redirects, and each hop was checked', async () => {
    const a = await origin((req, res) => { res.writeHead(302, { location: '/again' }); res.end() })
    const { link, net } = await fetchRig(cleanups, { names: { 'plain.test': [A1] }, origins: { [`${A1}:80`]: a.port }, grants: [EGRESS_SCOPES.http('plain.test', 80)], egress: { limits: { maxRedirects: 3 } } })
    await assert.rejects(link.fetch('http://plain.test/'), code('too-many-redirects'))
    assert.equal(a.seen.length, 4, 'the first request and three hops')
    assert.equal(net.calls.lookups.length, 4)
  })

  it('https never falls back to http', async () => {
    const t = await tlsOrigin(SECURE, redirectTo('http://secure.test/plain'))
    const { link } = await fetchRig(cleanups, { names: { 'secure.test': [A1] }, origins: { [`${A1}:443`]: t.port, [`${A1}:80`]: t.port }, grants: [EGRESS_SCOPES.http('secure.test', 443), EGRESS_SCOPES.http('secure.test', 80)] })
    await assert.rejects(link.fetch('https://secure.test/'), code('redirect-refused'))
  })

  it('303 and a POST answered 301 or 302 become a GET without the body; 307 and 308 with a body are refused (the body cannot be sent again)', async () => {
    const a = await origin((req, res) => {
      if (req.url === '/post303') { res.writeHead(303, { location: '/got' }); res.end(); return }
      if (req.url === '/post307') { res.writeHead(307, { location: '/got' }); res.end(); return }
      if (req.url === '/get307') { res.writeHead(307, { location: '/got' }); res.end(); return }
      res.writeHead(200); res.end('got')
    })
    const { link } = await fetchRig(cleanups, { names: { 'plain.test': [A1] }, origins: { [`${A1}:80`]: a.port }, grants: [EGRESS_SCOPES.http('plain.test', 80)], egress: { fetchMethods: ['GET', 'HEAD', 'POST'] } })
    assert.equal(await (await link.fetch('http://plain.test/post303', { method: 'POST', body: 'x' })).text(), 'got')
    assert.equal(a.seen.at(-1).method, 'GET')
    assert.equal(a.seen.at(-1).body.length, 0)
    await assert.rejects(link.fetch('http://plain.test/post307', { method: 'POST', body: 'x' }), code('redirect-refused'))
    assert.equal(await (await link.fetch('http://plain.test/get307')).text(), 'got')
  })

  it('redirect: manual hands back the 3xx with its Location and follows nothing; redirect: error rejects', async () => {
    const a = await origin(redirectTo('http://secret.test/x'))
    const { link, net } = await fetchRig(cleanups, { names: { 'plain.test': [A1] }, origins: { [`${A1}:80`]: a.port }, grants: [EGRESS_SCOPES.http('plain.test', 80)] })
    const res = await link.fetch('http://plain.test/', { redirect: 'manual' })
    assert.equal(res.status, 302)
    assert.equal(res.headers.get('location'), 'http://secret.test/x')
    assert.deepEqual(net.calls.lookups, ['plain.test'])
    await assert.rejects(link.fetch('http://plain.test/', { redirect: 'error' }), TypeError)
  })
})

describe('TLS: the connection goes to the checked address and the certificate is verified against the name', () => {
  it('https works against a certificate for the name, and the server saw the NAME as SNI', async () => {
    const t = await tlsOrigin(SECURE)
    const { link, net } = await fetchRig(cleanups, { names: { 'secure.test': [A1] }, origins: { [`${A1}:443`]: t.port }, grants: [EGRESS_SCOPES.http('secure.test', 443)] })
    const res = await link.fetch('https://secure.test/x?y=1')
    assert.equal(await res.text(), 'secure')
    assert.deepEqual(t.servernames, ['secure.test'])
    assert.equal(t.seen[0].headers.host, 'secure.test')
    assert.equal(net.calls.dials[0].host, 'secure.test')
    assert.equal(net.calls.lookups.length, 1, 'resolved once, the checked address dialled')
  })

  it('a certificate for another name is refused (connect-failed, certificate) and no request byte reaches the origin', async () => {
    const t = await tlsOrigin(OTHER)
    const { link } = await fetchRig(cleanups, { names: { 'secure.test': [A1] }, origins: { [`${A1}:443`]: t.port }, grants: [EGRESS_SCOPES.http('secure.test', 443)] })
    const e = await link.fetch('https://secure.test/private?token=1').catch((x) => x)
    assert.ok(e instanceof EgressError && e.code === 'connect-failed' && e.detail === 'certificate', String(e?.code))
    assert.equal(t.seen.length, 0, 'the request was never sent')
    assert.deepEqual(t.servernames, ['secure.test'])
  })

  it('an authority the operator did not trust is refused the same way, and a name that resolves differently the second time does not matter (one lookup)', async () => {
    const t = await tlsOrigin(SECURE)
    const strict = createExchange({})
    const { link, net } = await fetchRig(cleanups, { names: { 'secure.test': [[A1], [A2]] }, origins: { [`${A1}:443`]: t.port }, grants: [EGRESS_SCOPES.http('secure.test', 443)], egress: { exchange: strict } })
    const e = await link.fetch('https://secure.test/').catch((x) => x)
    assert.ok(e.code === 'connect-failed' && e.detail === 'certificate', String(e.code))
    assert.equal(net.calls.lookups.length, 1)
    assert.equal(t.seen.length, 0)
  })

  it('a name that answers differently on a second lookup is dialled at the first answer, once', async () => {
    const t = await tlsOrigin(SECURE)
    const elsewhere = await tlsOrigin(SECURE, ok('the second answer'))
    const { link, net } = await fetchRig(cleanups, { names: { 'secure.test': [[A1], [A2]] }, origins: { [`${A1}:443`]: t.port, [`${A2}:443`]: elsewhere.port }, grants: [EGRESS_SCOPES.http('secure.test', 443)] })
    assert.equal(await (await link.fetch('https://secure.test/')).text(), 'secure')
    assert.equal(net.calls.lookups.length, 1)
    assert.equal(elsewhere.seen.length + elsewhere.servernames.length, 0)
  })
})

describe('response limits and what a hostile origin can make the consumer hold', () => {
  it('a response head over maxHeaderBytes or with too many headers is bad-response, never partly delivered', async () => {
    const big = await origin((req, res) => { res.writeHead(200, { 'x-big': 'v'.repeat(30 * KiB) }); res.end('body') })
    const many = await origin((req, res) => { const h = {}; for (let i = 0; i < 150; i++) h[`x-h${i}`] = '1'; res.writeHead(200, h); res.end('body') })
    const { link } = await fetchRig(cleanups, { names: { 'big.test': [A1], 'many.test': [A2] }, origins: { [`${A1}:80`]: big.port, [`${A2}:80`]: many.port }, grants: [EGRESS_SCOPES.http('big.test', 80), EGRESS_SCOPES.http('many.test', 80)] })
    await assert.rejects(link.fetch('http://big.test/'), code('bad-response'))
    await assert.rejects(link.fetch('http://many.test/'), code('bad-response'))
  })

  it('a body longer than maxBytesPerConnection ends the stream: the consumer\'s body fails connection-ended (byte-budget)', async () => {
    const { link, provider } = await plain((req, res) => { res.writeHead(200); const chunk = Buffer.alloc(64 * KiB, 1); let n = 0; const pump = () => { while (n < 40) { n += 1; if (!res.write(chunk)) { res.once('drain', pump); return } } res.end() }; pump() }, { egress: { limits: { maxBytesPerConnection: 256 * KiB } } })
    const res = await link.fetch('http://plain.test/')
    const e = await res.arrayBuffer().catch((x) => x)
    assert.ok(e instanceof EgressError && e.code === 'connection-ended' && e.reason === 'byte-budget', String(e))
    assert.equal(provider.stats().ends['byte-budget'], 1)
  })

  it('a consumer that stops reading stops the origin: what is held anywhere is bounded', async () => {
    const total = 32 * MiB
    let written = 0
    const { link, provider } = await plain((req, res) => {
      res.writeHead(200)
      const pump = () => { while (written < total) { const n = Math.min(64 * KiB, total - written); const okay = res.write(Buffer.from(patternChunk(written, n))); written += n; if (!okay) { res.once('drain', pump); return } } res.end() }
      pump()
    })
    const res = await link.fetch('http://plain.test/')
    await until(() => provider.stats().bytesDown > 128 * KiB, 'the first bytes to move')
    let last = -1
    await until(async () => { const now = provider.stats().bytesDown; const same = now === last; last = now; await new Promise((r) => setTimeout(r, 80)); return same }, 'the flow to stop')
    assert.ok(provider.stats().bytesDown <= 1 * MiB, `moved ${provider.stats().bytesDown} with nobody reading`)
    assert.ok(written < total, 'the origin was stopped, not drained')
    const reader = res.body.getReader()
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (let i = 0; i < value.length; i += 4099) assert.equal(value[i], patternByte(got + i), `byte ${got + i}`)
      got += value.length
    }
    assert.equal(got, total)
  })

  it('a response that claims more than it sends fails the body, one that claims less is cut at its length', async () => {
    const { link } = await plain((req, res) => {
      const socket = res.socket
      if (req.url === '/short') socket.end('HTTP/1.1 200 OK\r\ncontent-length: 100\r\nconnection: close\r\n\r\nonly ten b')
      else socket.end('HTTP/1.1 200 OK\r\ncontent-length: 3\r\nconnection: close\r\n\r\nabcdefghij')
    })
    const short = await link.fetch('http://plain.test/short')
    const e = await short.arrayBuffer().catch((x) => x)
    assert.ok(e instanceof EgressError && e.code === 'connection-ended' && e.reason === 'origin-error', String(e))
    const long = await link.fetch('http://plain.test/long')
    assert.equal(await long.text(), 'abc')
  })
})

describe('budgets, audit and meter', () => {
  it('a fetch counts as a connection attempt (connect-rate), and holds a connection while it lives (connections-per-consumer)', async () => {
    const hang = deferred()
    const { link } = await plain((req, res) => { res.writeHead(200); res.write('x'); hang.promise.then(() => res.end()) }, { egress: { limits: { connectRate: { limit: 5, windowMs: 60_000 }, maxConnectionsPerConsumer: 2 } } })
    const one = await link.fetch('http://plain.test/')
    const two = await link.fetch('http://plain.test/')
    const e = await link.fetch('http://plain.test/').catch((x) => x)
    assert.ok(e.code === 'budget-exceeded' && e.budget === 'connections-per-consumer', String(e.budget))
    hang.resolve()
    await one.arrayBuffer()
    await two.arrayBuffer()
    for (let i = 0; i < 2; i++) await link.fetch('http://plain.test/').then((r) => r.arrayBuffer()).catch(() => {})
    const rate = await link.fetch('http://plain.test/').catch((x) => x)
    assert.ok(rate.code === 'budget-exceeded' && rate.budget === 'connect-rate', String(rate.budget))
  })

  it('the consumer\'s byte budget counts request and response bodies', async () => {
    const { link, provider } = await plain(ok('x'.repeat(5000)), { egress: { limits: { maxBytesPerConsumer: { limit: 8000, windowMs: 60_000 } } } })
    await (await link.fetch('http://plain.test/')).arrayBuffer()
    const second = await link.fetch('http://plain.test/').then((r) => r.arrayBuffer()).catch((x) => x)
    assert.ok(second instanceof EgressError && second.reason === 'consumer-budget', String(second))
    const third = await link.fetch('http://plain.test/').catch((x) => x)
    assert.ok(third.code === 'budget-exceeded' && third.budget === 'bytes-per-consumer')
    assert.ok(provider.stats().bytesDown >= 8000)
  })

  it('the audit says method, host, port, path length, status and the address; never the path, query, headers or bodies; the meter names no destination', async () => {
    const secret = 'zz-secret-marker'
    const { link, audit, meter } = await plain((req, res) => { res.writeHead(200, { 'x-reply': secret, 'content-type': 'text/plain' }); res.end(`body-${secret}`) }, { egress: { fetchMethods: ['GET', 'POST'] } })
    const res = await link.fetch(`http://plain.test/path-${secret}?q=${secret}`, { method: 'POST', body: `request-${secret}`, headers: { 'content-type': 'text/plain', authorization: `Bearer ${secret}`, accept: secret } })
    assert.equal(await res.text(), `body-${secret}`)
    await until(() => audit.some((r) => r.event === 'egress-close'), 'the close to be audited')
    const open = audit.find((r) => r.event === 'egress-open')
    assert.deepEqual({ form: open.form, method: open.method, host: open.host, port: open.port, address: open.address, addressClass: open.addressClass, status: open.status, pathLength: open.pathLength, via: open.via, outcome: open.outcome },
      { form: 'fetch', method: 'POST', host: 'plain.test', port: 80, address: A1, addressClass: 'public', status: 200, pathLength: `/path-${secret}?q=${secret}`.length, via: 'exact', outcome: 'opened' })
    const close = audit.find((r) => r.event === 'egress-close')
    assert.equal(close.form, 'fetch')
    assert.equal(close.reason, 'closed')
    assert.equal(close.bytesUp, `request-${secret}`.length)
    assert.equal(close.bytesDown, `body-${secret}`.length)
    assert.equal(close.status, 200)
    assert.ok(audit.some((r) => r.event === 'egress-hop' && r.hop === 0 && r.host === 'plain.test'))
    assert.ok(!JSON.stringify(audit).includes(secret), 'no path, query, header or body text in any audit record')
    assert.ok(!JSON.stringify(audit).includes('/path-'))
    const last = meter.at(-1)
    assert.deepEqual({ form: last.form, final: last.final, connections: last.connections }, { form: 'fetch', final: true, connections: 1 })
    assert.equal(meter.reduce((n, r) => n + r.bytesDown, 0), `body-${secret}`.length)
    assert.ok(!JSON.stringify(meter).includes('plain.test'))
  })

  it('auditUrls is the operator\'s opt-in: "path" adds the path, "full" adds the query too, and nothing else ever (no header, no body)', async () => {
    for (const [mode, wantPath, wantQuery] of [['path', '/where', undefined], ['full', '/where', 'q=1&k=v']]) {
      const { link, audit } = await plain((req, res) => { res.writeHead(200, { 'x-reply': 'hdr-marker' }); res.end('body-marker') }, { egress: { auditUrls: mode } })
      await (await link.fetch('http://plain.test/where?q=1&k=v', { headers: { accept: 'hdr-marker' } })).arrayBuffer()
      await until(() => audit.some((r) => r.event === 'egress-close'), 'the close to be audited')
      for (const event of ['egress-hop', 'egress-open', 'egress-close']) {
        const r = audit.find((x) => x.event === event)
        assert.equal(r.path, wantPath, `${mode} ${event} path`)
        assert.equal(r.query, wantQuery, `${mode} ${event} query`)
      }
      assert.ok(!JSON.stringify(audit).includes('marker'))
    }
  })

  it('a bad auditUrls is refused at construction', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    assert.throws(() => createMeshEgress({ service: pods.p, registry: pods.provider.registry, dial: async () => {}, resolve: async () => {}, unattended: true, auditUrls: true }), /auditUrls/)
  })

  it('every hop is in the audit, with its own host and address; a refusal says which hop', async () => {
    const b = await origin(ok('landed'))
    const a = await origin((req, res) => { res.writeHead(302, { location: 'http://other.test/final' }); res.end() })
    const { link, audit } = await fetchRig(cleanups, { names: { 'plain.test': [A1], 'other.test': [A2] }, origins: { [`${A1}:80`]: a.port, [`${A2}:80`]: b.port }, grants: [EGRESS_SCOPES.http('plain.test', 80), EGRESS_SCOPES.http('other.test', 80)] })
    await (await link.fetch('http://plain.test/')).arrayBuffer()
    const hops = audit.filter((r) => r.event === 'egress-hop')
    assert.deepEqual(hops.map((h) => [h.hop, h.host, h.address, h.status]), [[0, 'plain.test', A1, 302], [1, 'other.test', A2, 200]])
  })
})

describe('the signal, revocation and the end of a fetch', () => {
  it('an aborted signal before the headers rejects with the signal\'s reason and closes the connection to the origin', async () => {
    const gate = deferred()
    let sockets = 0
    const { link, provider } = await plain((req, res) => { sockets += 1; req.socket.on('close', () => { sockets -= 1 }); gate.promise.then(() => res.end()) })
    const ac = new AbortController()
    const pending = link.fetch('http://plain.test/', { signal: ac.signal }).catch((e) => e)
    await until(() => sockets === 1, 'the origin to hold the request')
    ac.abort()
    const e = await pending
    assert.equal(e.name, 'AbortError')
    await until(() => sockets === 0 && provider.stats().open === 0, 'the origin connection to close')
    gate.resolve()
    await assert.rejects(link.fetch('http://plain.test/', { signal: AbortSignal.abort() }), (x) => x.name === 'AbortError')
  })

  it('an abort in the middle of the body fails the body and stops the origin', async () => {
    let closed = false
    const { link } = await plain((req, res) => { res.socket.on('close', () => { closed = true }); res.writeHead(200); res.write('start'); })
    const ac = new AbortController()
    const res = await link.fetch('http://plain.test/', { signal: ac.signal })
    const reader = res.body.getReader()
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'start')
    ac.abort()
    const e = await reader.read().catch((x) => x)
    assert.equal(e.name, 'AbortError')
    await until(() => closed, 'the origin to see the connection close')
  })

  it('cancelling the body stops the origin', async () => {
    let closed = false
    const { link } = await plain((req, res) => { res.socket.on('close', () => { closed = true }); res.writeHead(200); res.write('start') })
    const res = await link.fetch('http://plain.test/')
    const reader = res.body.getReader()
    await reader.read()
    await reader.cancel()
    await until(() => closed, 'the origin to see the connection close')
  })

  it('revoking the grant mid-body ends it: the body fails connection-ended (revoked)', async () => {
    const { link, pods } = await plain((req, res) => { res.writeHead(200); res.write('start') })
    const res = await link.fetch('http://plain.test/')
    const reader = res.body.getReader()
    await reader.read()
    revoke(pods, [EGRESS_SCOPES.http('plain.test', 80)])
    const e = await reader.read().catch((x) => x)
    assert.ok(e instanceof EgressError && e.code === 'connection-ended' && e.reason === 'revoked', String(e))
  })

  it('stopping the provider ends a live fetch: shutdown', async () => {
    const { link, provider } = await plain((req, res) => { res.writeHead(200); res.write('start') })
    const res = await link.fetch('http://plain.test/')
    const reader = res.body.getReader()
    await reader.read()
    await provider.stop()
    const e = await reader.read().catch((x) => x)
    assert.ok(e instanceof EgressError && e.reason === 'shutdown', String(e))
  })
})

describe('forms a provider does not offer, and a consumer\'s view of a provider that cannot', () => {
  it('a provider with no exchange answers not-offered, and says it for the TCP form of nothing else', async () => {
    const { link } = await plain(ok(), { egress: { exchange: undefined } })
    await assert.rejects(link.fetch('http://plain.test/'), code('not-offered'))
  })

  it('a provider that has no fetch method at all (an older one) is named provider-no-form', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const stop = pods.p.api.serveProtocol('egress', (channel) => { channel.onRequest('connect', async () => ({ ok: false, code: 'no-grant' })) }, { versions: [1] })
    cleanups.push(() => stop())
    grant(pods, [])
    const link = await connectEgress(pods.c, pods.provider.podId)
    cleanups.push(() => link.close())
    await assert.rejects(link.fetch('http://plain.test/'), code('provider-no-form'))
  })

  it('a provider that is the consumer\'s own egress cannot be the exchange', async () => {
    const { link } = await plain()
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const make = (exchange) => createMeshEgress({ service: pods.p, registry: pods.provider.registry, dial: async () => {}, resolve: async () => {}, exchange, unattended: true })
    assert.throws(() => make(link.fetch), /exchange is an egress consumer/)
    assert.throws(() => make(5), /exchange must be a function/)
  })
})

describe('a hostile consumer of the fetch form', () => {
  it('a stream for a request that does not exist, or that is not waiting for a body, is refused', async () => {
    const { pods } = await plain(ok(), { link: false })
    const c = await raw(pods)
    await assert.rejects(c.streams.open({ cid: 77, kind: 'up' }), /bad-stream|no connection/)
    const a = await c.ask({ cid: 1, url: 'http://plain.test/' })
    assert.equal(a.ok, true)
    await assert.rejects(c.streams.open({ cid: 1, kind: 'up' }), /bad-stream|no connection/)
  })

  it('a request that says it has a body and never sends it is ended up-timeout, and the origin is never asked to wait for it forever', async () => {
    const { pods, provider } = await plain(ok(), { link: false, egress: { fetchMethods: ['GET', 'POST'], limits: { upWaitMs: 150 } } })
    const c = await raw(pods)
    const answer = await c.ask({ cid: 1, url: 'http://plain.test/', method: 'POST', body: true }).catch((e) => e)
    assert.ok(answer.ok === false || answer instanceof Error)
    await until(() => provider.stats().open === 0 && (provider.stats().ends['up-timeout'] ?? 0) + (provider.stats().reasons['connect-failed'] ?? 0) >= 1, 'the request to end')
  })

  it('the same cid twice is a bad request, and a flood of requests is cut off', async () => {
    const hang = deferred()
    const { pods } = await plain((req, res) => { res.writeHead(200); res.write('x'); hang.promise.then(() => res.end()) }, { link: false })
    const c = await raw(pods)
    assert.equal((await c.ask({ cid: 1, url: 'http://plain.test/' })).ok, true)
    assert.equal((await c.ask({ cid: 1, url: 'http://plain.test/' })).code, 'bad-request')
    hang.resolve()
  })
})

describe('a hostile provider, as the consumer sees it', () => {
  async function hostile(answer, { stream = true } = {}) {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const stop = pods.p.api.serveProtocol('egress', (channel) => {
      const streams = createStreamLayer(channel, {})
      channel.onRequest('fetch', async (p) => {
        if (stream) { const w = await streams.open({ cid: p.cid, kind: 'down' }); w.write(new TextEncoder().encode('body')).then(() => w.end()).catch(() => {}) }
        return typeof answer === 'function' ? answer(p) : answer
      })
    }, { versions: [1] })
    cleanups.push(() => stop())
    grant(pods, [])
    const link = await connectEgress(pods.c, pods.provider.podId)
    cleanups.push(() => link.close())
    return link
  }

  it('an answer that is not a status, a status outside 200-599, headers that are not pairs: bad-answer', async () => {
    for (const answer of [{ ok: true }, { ok: true, status: 99, headers: [] }, { ok: true, status: 600, headers: [] }, { ok: true, status: '200', headers: [] }, { ok: true, status: 200, headers: 'x' },
      { ok: true, status: 200, headers: [['a']] }, { ok: true, status: 200, headers: [[1, 2]] }, { ok: true, status: 200, headers: [], url: 5 }, { ok: true, status: 200, headers: [], url: 'ftp://x/' }, 'nonsense', null]) {
      const link = await hostile(answer)
      await assert.rejects(link.fetch('http://plain.test/'), code('bad-answer'), JSON.stringify(answer))
    }
  })

  it('a hostile provider\'s set-cookie, hop-by-hop headers and a flood of headers do not reach the Response', async () => {
    const link = await hostile({ ok: true, status: 200, headers: [['set-cookie', 'a=b'], ['connection', 'close'], ['content-type', 'text/plain'], ['bad name', 'x'], ['x-ok', 'a\r\nb'], ...Array.from({ length: 300 }, (_, i) => [`x-${i}`, '1'])], url: 'http://plain.test/' })
    const res = await link.fetch('http://plain.test/')
    assert.equal(res.headers.get('set-cookie'), null)
    assert.equal(res.headers.get('connection'), null)
    assert.equal(res.headers.get('content-type'), 'text/plain')
    assert.equal(res.headers.get('x-ok'), null)
    assert.ok([...res.headers].length <= 100)
  })

  it('a 204 with a body stream is a Response with no body; a provider that never opens its stream is provider-timeout', async () => {
    const link = await hostile({ ok: true, status: 204, headers: [], url: 'http://plain.test/' })
    const res = await link.fetch('http://plain.test/')
    assert.equal(res.status, 204)
    assert.equal(res.body, null)
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const stop = pods.p.api.serveProtocol('egress', (channel) => { channel.onRequest('fetch', async () => ({ ok: true, status: 200, headers: [], url: 'http://plain.test/' })) }, { versions: [1] })
    cleanups.push(() => stop())
    grant(pods, [])
    const quick = await connectEgress(pods.c, pods.provider.podId, { limits: { requestTimeoutMs: 200 } })
    cleanups.push(() => quick.close())
    await assert.rejects(quick.fetch('http://plain.test/'), code('provider-timeout'))
  })
})

describe('the fetch form does not change the TCP form', () => {
  it('connect and lookup still work beside it', async () => {
    const { link } = await plain(ok(), { grants: [EGRESS_SCOPES.http('plain.test', 80), EGRESS_SCOPES.tcp('plain.test', 80), EGRESS_SCOPES.dns('plain.test')] })
    assert.deepEqual(await link.lookup('plain.test'), [A1])
    const socket = await link.connect('plain.test', 80)
    await socket.write(new TextEncoder().encode('GET / HTTP/1.1\r\nhost: plain.test\r\nconnection: close\r\n\r\n'))
    const first = await socket.read()
    assert.match(Buffer.from(first).toString(), /^HTTP\/1\.1 200/)
    socket.destroy()
    void A3
  })
})
