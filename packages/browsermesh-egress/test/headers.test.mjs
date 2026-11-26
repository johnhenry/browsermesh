// Item 1 of #379: the fetch form's response header allow-list passes what a registry or an ordinary API needs and nothing that
// is a cookie, a hop-by-hop or a proxy header; what passes stays bounded in count and in size. The consumer-side filter is the
// same list, so a hostile provider cannot add to it.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createStreamLayer } from '@johnhenry/browsermesh-apps/protocol-stream'
import { connectEgress, EgressError, EGRESS_SCOPES } from '../src/index.mjs'
import { RESPONSE_HEADERS, responseHeaders } from '../src/http-policy.mjs'
import { threePods, grant } from './helpers/mesh.mjs'
import { A1, httpOrigin, fetchRig } from './helpers/http.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

// The response header allow-list of 0.2.0, as published. Every name must still pass: a header a 0.2.0 consumer relied on is never taken away.
const LIST_0_2_0 = ['accept-ranges', 'age', 'cache-control', 'content-disposition', 'content-encoding', 'content-language', 'content-length', 'content-range', 'content-type', 'date', 'etag', 'expires', 'last-modified', 'location', 'retry-after', 'vary']

async function served(head) {
  const o = await httpOrigin((req, res) => { res.writeHead(200, head); res.end('body') })
  cleanups.push(() => o.close())
  const rig = await fetchRig(cleanups, { names: { 'plain.test': [A1] }, origins: { [`${A1}:80`]: o.port }, grants: [EGRESS_SCOPES.http('plain.test', 80)] })
  return rig
}

describe('the response headers a registry needs pass the fetch form', () => {
  it('www-authenticate (every challenge line), docker-distribution-api-version, docker-content-digest and link reach the Response', async () => {
    const { link } = await served({
      'content-type': 'application/json',
      'www-authenticate': ['Bearer realm="https://auth.registry.test/token",service="registry.test"', 'Basic realm="registry"'],
      'docker-distribution-api-version': 'registry/2.0',
      'docker-content-digest': 'sha256:abc123',
      link: '</v2/_catalog?last=b&n=100>; rel="next"',
    })
    const res = await link.fetch('http://plain.test/v2/')
    assert.equal(await res.text(), 'body')
    assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="https://auth.registry.test/token",service="registry.test", Basic realm="registry"')
    assert.equal(res.headers.get('docker-distribution-api-version'), 'registry/2.0')
    assert.equal(res.headers.get('docker-content-digest'), 'sha256:abc123')
    assert.equal(res.headers.get('link'), '</v2/_catalog?last=b&n=100>; rel="next"')
  })

  it('the range, retry and validator headers an API needs pass; rate-limit headers pass', async () => {
    const { link } = await served({
      'accept-ranges': 'bytes', 'content-range': 'bytes 0-3/4', 'retry-after': '120', etag: '"v1"', 'last-modified': 'Wed, 21 Oct 2015 07:28:00 GMT',
      'ratelimit-limit': '100', 'ratelimit-remaining': '99', 'ratelimit-reset': '30', 'x-ratelimit-limit': '100', 'x-ratelimit-remaining': '99', 'x-ratelimit-reset': '1700000000',
    })
    const res = await link.fetch('http://plain.test/')
    for (const name of ['accept-ranges', 'content-range', 'retry-after', 'etag', 'last-modified', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']) assert.ok(res.headers.get(name), name)
  })

  it('a cookie, a hop-by-hop header, a proxy header and an unlisted one never pass, whatever the destination sends', async () => {
    const { link } = await served({
      'www-authenticate': 'Bearer realm="x"', 'set-cookie': ['sid=1', 'b=2'], 'set-cookie2': 'a=b', 'proxy-authenticate': 'Basic', 'proxy-authorization': 'x', 'keep-alive': 'timeout=5',
      'x-secret': 'no', 'access-control-allow-origin': '*', server: 'nginx', 'strict-transport-security': 'max-age=1', 'content-security-policy': 'default-src none', 'content-location': '/x',
    })
    const res = await link.fetch('http://plain.test/')
    assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="x"')
    for (const name of ['set-cookie', 'set-cookie2', 'proxy-authenticate', 'proxy-authorization', 'keep-alive', 'x-secret', 'access-control-allow-origin', 'server', 'strict-transport-security', 'content-security-policy', 'content-location', 'connection', 'transfer-encoding']) assert.equal(res.headers.get(name), null, name)
  })
})

describe('what passes is bounded', () => {
  it('a value longer than a header may be, and a name that is not a token, are dropped; the rest of the head is kept', () => {
    const out = responseHeaders([['www-authenticate', 'x'.repeat(9000)], ['www-authenticate', 'Bearer realm="ok"'], ['link', 'a\r\nb'], ['etag', '"v"']])
    assert.deepEqual(out, [['www-authenticate', 'Bearer realm="ok"'], ['etag', '"v"']])
  })

  it('the count of headers handed on is at most 100, however many challenge lines the destination sends', () => {
    const many = Array.from({ length: 400 }, (_, i) => ['www-authenticate', `Bearer realm="r${i}"`])
    assert.equal(responseHeaders(many).length, 100)
  })

  it('a head larger than the provider\'s byte limit is refused whole, as before (bad-response)', () => {
    const pairs = Array.from({ length: 20 }, () => ['www-authenticate', 'x'.repeat(2000)])
    assert.throws(() => responseHeaders(pairs, { maxBytes: 16 * 1024 }), (e) => e instanceof EgressError && e.code === 'bad-response')
  })
})

describe('the list itself', () => {
  it('keeps every name 0.2.0 passed, adds the registry and API headers, and has no cookie or hop-by-hop header', () => {
    for (const name of LIST_0_2_0) assert.ok(RESPONSE_HEADERS.includes(name), name)
    for (const name of ['www-authenticate', 'docker-distribution-api-version', 'docker-content-digest', 'link']) assert.ok(RESPONSE_HEADERS.includes(name), name)
    for (const name of ['set-cookie', 'set-cookie2', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authenticate', 'proxy-authorization']) assert.ok(!RESPONSE_HEADERS.includes(name), name)
    assert.equal(new Set(RESPONSE_HEADERS).size, RESPONSE_HEADERS.length)
    assert.ok(RESPONSE_HEADERS.every((n) => n === n.toLowerCase()))
  })

  it('a hostile provider cannot add to it: the consumer applies the same list to what it is told', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const stop = pods.p.api.serveProtocol('egress', (channel) => {
      const streams = createStreamLayer(channel, {})
      channel.onRequest('fetch', async (p) => {
        const w = await streams.open({ cid: p.cid, kind: 'down' })
        w.end().catch(() => {})
        return { ok: true, status: 401, headers: [['www-authenticate', 'Bearer realm="r"'], ['set-cookie', 'a=b'], ['x-evil', '1'], ['link', '<http://x/>; rel="next"']], url: 'http://plain.test/' }
      })
    }, { versions: [1] })
    cleanups.push(() => stop())
    grant(pods, [])
    const link = await connectEgress(pods.c, pods.provider.podId)
    cleanups.push(() => link.close())
    const res = await link.fetch('http://plain.test/')
    assert.equal(res.status, 401)
    assert.equal(res.headers.get('www-authenticate'), 'Bearer realm="r"')
    assert.equal(res.headers.get('link'), '<http://x/>; rel="next"')
    assert.equal(res.headers.get('set-cookie'), null)
    assert.equal(res.headers.get('x-evil'), null)
  })
})
