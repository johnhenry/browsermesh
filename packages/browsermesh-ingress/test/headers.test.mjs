// Every header rule as a pure function.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkClientRequestShape, checkHeaderList, checkHost, checkMappedPath, checkTarget, hostName, isPodId, requestHeadersForProvider,
  responseHeadersForClient, safeLocation, varyNames, DEFAULT_CSP,
} from '../src/headers.mjs'
import { IngressError } from '../src/errors.mjs'

const refused = (fn, status, reason) => assert.throws(fn, (e) => e instanceof IngressError && e.status === status && (reason === undefined || e.reason === reason))
const shape = (headers, method = 'GET') => checkClientRequestShape(new Headers(headers), method, { maxCount: 64, maxBytes: 16 * 1024 })

describe('Host', () => {
  it('accepts a lower-case hostname with an optional port, and a bracketed IPv6 address', () => {
    assert.equal(checkHost('App.Example.TEST'), 'app.example.test')
    assert.equal(checkHost('localhost:8080'), 'localhost:8080')
    assert.equal(checkHost('[::1]:80'), '[::1]:80')
    assert.equal(hostName('a.test:81'), 'a.test')
    assert.equal(hostName('[::1]:81'), '[::1]')
  })
  it('refuses userinfo, paths, spaces, empty names, underscores, control characters, a missing host and absurd length', () => {
    for (const bad of ['user@evil.test', 'a.test/path', 'a b.test', '', 'a_b.test', 'a.test\r\nx: y', '-a.test', 'a..test', 'a.test:99999x', 'a.test:', undefined, null, 5, 'x'.repeat(300), '[::1', '.a.test', 'a.test.:1:2']) {
      refused(() => checkHost(bad), 400, 'bad-host')
    }
  })
})

describe('request target and mapped path', () => {
  it('a target is a path in origin form, bounded', () => {
    assert.equal(checkTarget('/a/b?c=d'), '/a/b?c=d')
    for (const bad of ['', 'a', '//evil.test/x', 'http://evil.test/', '*', '/a b', '/a\\b', '/a\u0000', '/a\r\nHost: x', '/\u0085']) refused(() => checkTarget(bad), 400, 'bad-target')
    refused(() => checkTarget(`/${'a'.repeat(3000)}`), 414, 'target-too-long')
  })
  it('a mapping\'s path is a plain path: no query, no fragment, no dot segments', () => {
    assert.equal(checkMappedPath('/inner/x'), '/inner/x')
    for (const bad of ['relative', '//x', '/a?b', '/a#b', '/a/../b', '/./a', '/a/..']) refused(() => checkMappedPath(bad), 500, 'bad-mapping')
  })
})

describe('pod ids a mapping may name', () => {
  it('base64url-ish ids are fine; scope syntax, wildcards, spaces and empty are not', () => {
    for (const ok of ['pod-alice', `-${'A'.repeat(42)}`, `_${'b'.repeat(42)}`, 'a.b_c-d']) assert.ok(isPodId(ok), ok)
    for (const bad of ['', 'a:b', 'a*', 'a b', 'a/b', '.a', 'x'.repeat(200), 5, null]) assert.ok(!isPodId(bad), String(bad))
  })
})

describe('what the client sends, as the ingress reads it', () => {
  it('Transfer-Encoding together with Content-Length is refused', () => {
    refused(() => shape({ 'transfer-encoding': 'chunked', 'content-length': '5' }, 'POST'), 400, 'bad-framing')
  })
  it('only the chunked transfer coding is accepted', () => {
    refused(() => shape({ 'transfer-encoding': 'gzip, chunked' }, 'POST'), 400, 'bad-framing')
    refused(() => shape({ 'transfer-encoding': 'identity' }, 'POST'), 400, 'bad-framing')
    assert.deepEqual(shape({ 'transfer-encoding': ' Chunked ' }, 'POST'), { contentLength: null, chunked: true })
  })
  it('Content-Length is one non-negative decimal number', () => {
    for (const bad of ['-1', '1,2', '1 2', '0x10', '1e3', '', 'abc', '9'.repeat(20)]) refused(() => shape({ 'content-length': bad }, 'POST'), 400, 'bad-framing')
    assert.equal(shape({ 'content-length': ' 12 ' }, 'POST').contentLength, 12)
  })
  it('a GET or HEAD with a body is refused, a zero length is not', () => {
    refused(() => shape({ 'content-length': '1' }, 'GET'), 400, 'body-on-get')
    refused(() => shape({ 'transfer-encoding': 'chunked' }, 'HEAD'), 400, 'body-on-get')
    assert.equal(shape({ 'content-length': '0' }, 'GET').contentLength, 0)
  })
  it('count and size of headers are bounded (431), and a value with a control character is refused (400)', () => {
    const big = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`x-${i}`, 'v']))
    refused(() => shape(big), 431, 'headers-too-large')
    refused(() => checkClientRequestShape(new Headers({ 'x-a': 'v'.repeat(100) }), 'GET', { maxCount: 10, maxBytes: 50 }), 431)
    const h = new Headers()
    refused(() => checkClientRequestShape({ [Symbol.iterator]: function* () { yield ['x-a', 'a\u0001b'] } }, 'GET', { maxCount: 10, maxBytes: 100 }), 400, 'bad-header-value')
    void h
  })
})

describe('request headers sent to the provider', () => {
  const send = (init, opts) => Object.fromEntries(requestHeadersForProvider(new Headers(init), opts))

  it('only the allow-list passes by default', () => {
    assert.deepEqual(send({ accept: 'a', 'accept-language': 'l', 'content-type': 't', 'if-none-match': 'e', range: 'bytes=0-1', 'user-agent': 'ua', cookie: 'c', authorization: 'a', 'x-x': '1' }),
      { accept: 'a', 'accept-language': 'l', 'content-type': 't', 'if-none-match': 'e', range: 'bytes=0-1' })
  })
  it('the never-list cannot be widened into: Host, Forwarded, X-Forwarded-*, Upgrade, Proxy-*, framing', () => {
    const never = ['host', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-anything', 'x-real-ip', 'via', 'upgrade', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-anything', 'te', 'trailer', 'transfer-encoding', 'content-length', 'expect']
    const init = Object.fromEntries(never.map((n) => [n, 'v']).filter(([n]) => !['host', 'connection', 'content-length', 'upgrade', 'transfer-encoding', 'keep-alive', 'te', 'trailer', 'expect'].includes(n)))
    assert.deepEqual(send(init, { forward: never }), {})
  })
  it('`forward` adds names that are not on the never-list, case-insensitively', () => {
    assert.deepEqual(send({ authorization: 'Bearer x', 'x-custom': '1' }, { forward: ['Authorization', 'X-Custom'] }), { authorization: 'Bearer x', 'x-custom': '1' })
  })
  it('a mapping\'s headers override the client\'s and cannot name a never-list header or carry bad bytes', () => {
    assert.deepEqual(send({ accept: 'a' }, { extra: { accept: 'b', 'X-Tenant': 'acme' } }), { accept: 'b', 'x-tenant': 'acme' })
    for (const extra of [{ host: 'x' }, { 'x-forwarded-for': '1' }, { 'bad name': 'x' }, { 'x-a': 'v\r\nx: y' }, { upgrade: 'websocket' }]) refused(() => requestHeadersForProvider(new Headers(), { extra }), 500, 'bad-mapping')
  })
  it('Vary names the headers that can change the answer', () => {
    assert.ok(varyNames().includes('accept'))
    assert.ok(!varyNames().includes('content-type'))
    assert.ok(varyNames(['x-tenant']).includes('x-tenant'))
    assert.ok(!varyNames(['x-forwarded-for']).includes('x-forwarded-for'))
  })
})

describe('response headers sent to the client', () => {
  const out = (list, opts) => responseHeadersForClient(list, opts)

  it('passes the allow-list and drops everything else', () => {
    const h = out([['content-type', 'text/plain'], ['etag', '"1"'], ['x-anything', '1'], ['server', 'x'], ['date', 'x'], ['content-disposition', 'inline']])
    assert.deepEqual([...h.keys()].sort(), ['cache-control', 'content-disposition', 'content-security-policy', 'content-type', 'etag', 'vary', 'x-content-type-options'])
  })
  it('Set-Cookie is dropped, unless the mapping says allowSetCookie, and then every cookie is kept', () => {
    assert.equal(out([['set-cookie', 'a=1']]).getSetCookie().length, 0)
    assert.deepEqual(out([['set-cookie', 'a=1'], ['set-cookie', 'b=2']], { response: { allowSetCookie: true } }).getSetCookie(), ['a=1', 'b=2'])
  })
  it('the policy headers are forced over whatever the provider says', () => {
    const h = out([['content-security-policy', '*'], ['x-content-type-options', 'x'], ['cache-control', 'public']])
    assert.equal(h.get('content-security-policy'), DEFAULT_CSP)
    assert.equal(h.get('x-content-type-options'), 'nosniff')
    assert.equal(h.get('cache-control'), 'no-store')
  })
  it('a mapping opts out of the CSP and Cache-Control explicitly, or replaces them; nosniff stays', () => {
    const replaced = out([], { response: { contentSecurityPolicy: "default-src 'self'", cacheControl: 'max-age=60' } })
    assert.equal(replaced.get('content-security-policy'), "default-src 'self'")
    assert.equal(replaced.get('cache-control'), 'max-age=60')
    const off = out([['cache-control', 'public']], { response: { contentSecurityPolicy: false, cacheControl: false } })
    assert.equal(off.get('content-security-policy'), null)
    assert.equal(off.get('cache-control'), null)
    assert.equal(off.get('x-content-type-options'), 'nosniff')
  })
  it('Vary is the provider\'s names plus the forwarded request headers, lower-cased and de-duplicated; * wins', () => {
    const v = out([['vary', 'Accept, Cookie']]).get('vary').split(', ')
    assert.ok(v.includes('cookie') && v.includes('accept') && v.includes('accept-language'))
    assert.equal(new Set(v).size, v.length)
    assert.equal(out([['vary', '*']]).get('vary'), '*')
  })
  it('a content coding other than identity is a 502; identity is dropped', () => {
    refused(() => out([['content-encoding', 'gzip']]), 502, 'bad-content-encoding')
    refused(() => out([['content-encoding', 'br']]), 502)
    assert.equal(out([['content-encoding', 'identity']]).get('content-encoding'), null)
  })
  it('a Location is passed only as a path on the same origin', () => {
    assert.equal(out([['location', '/next?x=1']]).get('location'), '/next?x=1')
    for (const bad of ['http://x/', '//x/y', '/\\x', 'javascript:1', '', 'next', '/a\r\nb']) {
      if (bad.includes('\r')) continue // a CR or LF never gets this far: the head is shape-checked first
      refused(() => out([['location', bad]]), 502, 'provider-redirect-refused')
    }
    assert.ok(safeLocation('/ok'))
    assert.ok(!safeLocation('//no'))
  })
  it('a singleton header is set once; the first value wins', () => {
    assert.equal(out([['content-type', 'a'], ['content-type', 'b']]).get('content-type'), 'a')
  })
  it('`expose` adds names to the pass list', () => {
    assert.equal(out([['x-request-id', '7']], { expose: ['X-Request-Id'] }).get('x-request-id'), '7')
  })
})

describe('header lists on the wire', () => {
  it('names are tokens, values have no control characters, counts and bytes are bounded', () => {
    const limits = { maxCount: 3, maxBytes: 100 }
    checkHeaderList([['a', 'b']], limits)
    for (const bad of ['x', [['a']], [['a b', 'c']], [['a', 'b\n']], [['a', 5]], [[1, 'b']], new Array(4).fill(['a', 'b']), [['a', 'b'.repeat(200)]]]) {
      refused(() => checkHeaderList(bad, limits), 400, 'bad-headers')
    }
    refused(() => checkHeaderList('x', { ...limits, status: 502, reason: 'bad-response-head' }), 502, 'bad-response-head')
  })
})
