/**
 * ServerSharing: the request target is built from parsed parts and must stay
 * on the configured origin; method/header/size limits; no redirect following;
 * every peer request passes PeerRegistry.checkAccess for its share.
 *
 * The upstreams are real loopback HTTP servers on ports opened and closed by
 * these tests; they record exactly what they receive.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/server-sharing-target.test.mjs
 */

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { ServerSharing } from '../src/peer-routing.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { MeshACL, MeshPeerManager, TrustGraph } from '@johnhenry/browsermesh-core'

/** A loopback HTTP server that records every request it receives. */
function startRecorder(handler) {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const record = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      }
      seen.push(record)
      if (handler) return handler(req, res, record)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`ok ${req.method} ${req.url}`)
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      seen,
      port: server.address().port,
      close: () => new Promise((r) => { server.closeAllConnections(); server.close(r) }),
    }))
  })
}

function makeRegistry(owner = 'pod-host') {
  return new PeerRegistry({
    localPodId: owner,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner }),
  })
}

describe('ServerSharing request target', () => {
  let upstream
  let other
  let calls
  let sharing

  before(async () => {
    other = await startRecorder()
    upstream = await startRecorder((req, res) => {
      if (req.url === '/to-other') {
        res.writeHead(302, { location: `http://127.0.0.1:${other.port}/landed` })
        res.end()
        return
      }
      if (req.url === '/same-origin-redirect') {
        res.writeHead(302, { location: '/hello' })
        res.end()
        return
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.write(Buffer.alloc(64 * 1024, 0x61))
        res.end(Buffer.alloc(64 * 1024, 0x62))
        return
      }
      if (req.url === '/echo-headers') {
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'a=b', connection: 'close' })
        res.end(JSON.stringify(req.headers))
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(`ok ${req.method} ${req.url}`)
    })
  })

  after(async () => {
    await upstream.close()
    await other.close()
  })

  beforeEach(() => {
    upstream.seen.length = 0
    other.seen.length = 0
    calls = []
    sharing = new ServerSharing({
      localPodId: 'pod-host',
      fetchFn: (url, init) => { calls.push(url); return fetch(url, init) },
    })
    sharing.expose(upstream.port, 'web', { hostname: '127.0.0.1' })
  })

  function hostile() {
    const o = other.port
    return [
      `@127.0.0.1:${o}/x`,
      `127.0.0.1:${o}/x`,
      `//127.0.0.1:${o}/x`,
      `/\\127.0.0.1:${o}/x`,
      `\\\\127.0.0.1:${o}/x`,
      `\\/127.0.0.1:${o}/x`,
      `http://127.0.0.1:${o}/x`,
      `HTTP://127.0.0.1:${o}/x`,
      `https://127.0.0.1:${o}/x`,
      `javascript:alert(1)`,
      `x`,
      `?q=1`,
      `.:${o}/x`,
      `/x\r\nHost: evil`,
      `/x\nX-Injected: 1`,
      `/x\u0000`,
      `/x\u007f`,
      `/x\u0085`,
      `/x\ty`,
      `/a b`,
      `/x#fragment`,
      `/${'a'.repeat(9000)}`,
      123,
      {},
      ['/x'],
      true,
    ]
  }

  it('refuses every hostile path value with nothing sent upstream', async () => {
    for (const path of hostile()) {
      const res = await sharing.handleRequest({ name: 'web', method: 'GET', path })
      assert.equal(res.status, 400, `path ${JSON.stringify(path).slice(0, 60)} must be refused`)
    }
    assert.equal(calls.length, 0, 'fetch was never called')
    assert.equal(upstream.seen.length, 0, 'the shared server received nothing')
    assert.equal(other.seen.length, 0, 'the other server received nothing')
  })

  it('serves an allowed request, with path and query, to the configured origin only', async () => {
    const res = await sharing.handleRequest({ name: 'web', method: 'GET', path: '/hello/world?x=1&y=2' })
    assert.equal(res.status, 200)
    assert.equal(res.body, 'ok GET /hello/world?x=1&y=2')
    assert.equal(upstream.seen.length, 1)
    assert.equal(upstream.seen[0].url, '/hello/world?x=1&y=2')
    assert.equal(upstream.seen[0].headers.host, `127.0.0.1:${upstream.port}`)
    assert.equal(other.seen.length, 0)
  })

  it('treats a missing or empty path as /', async () => {
    const a = await sharing.handleRequest({ name: 'web', method: 'GET' })
    const b = await sharing.handleRequest({ name: 'web', method: 'GET', path: '' })
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.deepEqual(upstream.seen.map((r) => r.url), ['/', '/'])
  })

  it('forwards a request body as text or bytes', async () => {
    await sharing.handleRequest({ name: 'web', method: 'POST', path: '/p', body: 'hello' })
    await sharing.handleRequest({ name: 'web', method: 'PUT', path: '/p', body: new Uint8Array([1, 2, 3]) })
    assert.equal(upstream.seen[0].body.toString(), 'hello')
    assert.deepEqual([...upstream.seen[1].body], [1, 2, 3])
  })

  it('refuses a method outside the allow-list, and a body on GET', async () => {
    for (const method of ['CONNECT', 'TRACE', 'TRACK', 'get\r\nX: y', 'PROPFIND', 7, {}]) {
      const res = await sharing.handleRequest({ name: 'web', method, path: '/' })
      assert.equal(res.status, 405, `method ${JSON.stringify(method)}`)
    }
    const res = await sharing.handleRequest({ name: 'web', method: 'GET', path: '/', body: 'x' })
    assert.equal(res.status, 400)
    assert.equal(upstream.seen.length, 0)
  })

  it('allowedMethods narrows the allow-list', async () => {
    const narrow = new ServerSharing({ localPodId: 'pod-host', allowedMethods: ['GET'] })
    narrow.expose(upstream.port, 'web', { hostname: '127.0.0.1' })
    const res = await narrow.handleRequest({ name: 'web', method: 'POST', path: '/', body: 'x' })
    assert.equal(res.status, 405)
    assert.equal(upstream.seen.length, 0)
  })

  it('does not forward Host, hop-by-hop headers or credentials the sharer did not configure', async () => {
    const res = await sharing.handleRequest({
      name: 'web',
      method: 'GET',
      path: '/echo-headers',
      headers: {
        Host: 'evil.example',
        Connection: 'keep-alive, X-Secret',
        'Transfer-Encoding': 'chunked',
        Upgrade: 'websocket',
        TE: 'trailers',
        Cookie: 'sid=1',
        Authorization: 'Bearer stolen',
        'Proxy-Authorization': 'Basic abc',
        'X-Forwarded-For': '1.2.3.4',
        Forwarded: 'for=1.2.3.4',
        Accept: 'text/plain',
        'X-Not-Listed': 'drop me',
      },
    })
    assert.equal(res.status, 200)
    const seen = JSON.parse(res.body)
    assert.equal(seen.host, `127.0.0.1:${upstream.port}`)
    assert.equal(seen.accept, 'text/plain')
    for (const name of ['cookie', 'authorization', 'proxy-authorization', 'x-forwarded-for', 'forwarded', 'upgrade', 'te', 'x-not-listed', 'x-secret']) {
      assert.equal(seen[name], undefined, `${name} must not be forwarded`)
    }
    assert.notEqual(seen['transfer-encoding'], 'chunked')
  })

  it('sends credentials the sharer configured, and the peer cannot override them', async () => {
    sharing.expose(upstream.port, 'authed', { hostname: '127.0.0.1', headers: { authorization: 'Bearer configured' } })
    const res = await sharing.handleRequest({
      name: 'authed',
      method: 'GET',
      path: '/echo-headers',
      headers: { Authorization: 'Bearer from-peer' },
    })
    assert.equal(JSON.parse(res.body).authorization, 'Bearer configured')
  })

  it('refuses header values that carry line breaks, and too many headers', async () => {
    const crlf = await sharing.handleRequest({ name: 'web', method: 'GET', path: '/', headers: { Accept: 'a\r\nX-Injected: 1' } })
    assert.equal(crlf.status, 400)
    const badName = await sharing.handleRequest({ name: 'web', method: 'GET', path: '/', headers: { 'Bad Name': 'x' } })
    assert.equal(badName.status, 400)
    const many = {}
    for (let i = 0; i < 100; i++) many[`x-h${i}`] = 'v'
    const tooMany = await sharing.handleRequest({ name: 'web', method: 'GET', path: '/', headers: many })
    assert.equal(tooMany.status, 400)
    const big = await sharing.handleRequest({ name: 'web', method: 'GET', path: '/', headers: { Accept: 'a'.repeat(20000) } })
    assert.equal(big.status, 400)
    assert.equal(upstream.seen.length, 0)
  })

  it('bounds the request body (text and bytes), refusing before anything is sent', async () => {
    const small = new ServerSharing({ localPodId: 'pod-host', maxRequestBodyBytes: 10 })
    small.expose(upstream.port, 'web', { hostname: '127.0.0.1' })
    const text = await small.handleRequest({ name: 'web', method: 'POST', path: '/', body: 'x'.repeat(11) })
    const multi = await small.handleRequest({ name: 'web', method: 'POST', path: '/', body: 'é'.repeat(6) })
    const bytes = await small.handleRequest({ name: 'web', method: 'POST', path: '/', body: new Uint8Array(11) })
    const obj = await small.handleRequest({ name: 'web', method: 'POST', path: '/', body: { a: 1 } })
    assert.equal(text.status, 413)
    assert.equal(multi.status, 413, 'size is counted in bytes, not characters')
    assert.equal(bytes.status, 413)
    assert.equal(obj.status, 400)
    assert.equal(upstream.seen.length, 0)
    const ok = await small.handleRequest({ name: 'web', method: 'POST', path: '/', body: 'x'.repeat(10) })
    assert.equal(ok.status, 200)
  })

  it('bounds the response and does not return a partial body', async () => {
    const small = new ServerSharing({ localPodId: 'pod-host', maxResponseBytes: 1024 })
    small.expose(upstream.port, 'web', { hostname: '127.0.0.1' })
    const res = await small.handleRequest({ name: 'web', method: 'GET', path: '/big' })
    assert.equal(res.status, 502)
    assert.ok(!String(res.body).includes('aaaa'))
    const fits = await small.handleRequest({ name: 'web', method: 'GET', path: '/x' })
    assert.equal(fits.status, 200)
  })

  it('does not follow a redirect to another origin (it is returned unchanged)', async () => {
    const res = await sharing.handleRequest({ name: 'web', method: 'GET', path: '/to-other' })
    assert.equal(res.status, 302)
    assert.equal(res.headers.location, `http://127.0.0.1:${other.port}/landed`)
    assert.equal(other.seen.length, 0, 'the other origin received nothing')
  })

  it('does not follow a redirect on the same origin either', async () => {
    const res = await sharing.handleRequest({ name: 'web', method: 'GET', path: '/same-origin-redirect' })
    assert.equal(res.status, 302)
    assert.equal(upstream.seen.length, 1)
  })

  it('refuses a response that a custom fetch followed to another origin', async () => {
    const following = new ServerSharing({
      localPodId: 'pod-host',
      fetchFn: async () => ({
        status: 200,
        url: `http://127.0.0.1:${other.port}/landed`,
        redirected: true,
        headers: new Map(),
        text: async () => 'secret from elsewhere',
      }),
    })
    following.expose(upstream.port, 'web', { hostname: '127.0.0.1' })
    const res = await following.handleRequest({ name: 'web', method: 'GET', path: '/' })
    assert.equal(res.status, 502)
    assert.ok(!String(res.body).includes('secret'))
  })

  it('does not pass hop-by-hop or cookie response headers back to the peer', async () => {
    const res = await sharing.handleRequest({ name: 'web', method: 'GET', path: '/echo-headers' })
    assert.equal(res.headers['set-cookie'], undefined)
    assert.equal(res.headers.connection, undefined)
    assert.equal(res.headers['content-type'], 'application/json')
  })

  it('refuses a share whose configured origin is not a plain host and port', () => {
    assert.throws(() => sharing.expose(80, 'x', { hostname: 'a@b' }))
    assert.throws(() => sharing.expose(80, 'x', { hostname: 'a/b' }))
    assert.throws(() => sharing.expose(80, 'x', { hostname: '' }))
    assert.throws(() => sharing.expose(80, 'x', { protocol: 'ftp' }))
    assert.throws(() => sharing.expose(70000, 'x'))
    assert.throws(() => sharing.expose(1.5, 'x'))
    assert.throws(() => sharing.expose(80, 'a:b'))
    assert.throws(() => sharing.expose(80, 'a*'))
  })
})

describe('ServerSharing access check', () => {
  let upstream
  let registry
  let sharing

  before(async () => {
    upstream = await startRecorder()
  })
  after(() => upstream.close())

  beforeEach(() => {
    upstream.seen.length = 0
    registry = makeRegistry('pod-host')
    sharing = new ServerSharing({ localPodId: 'pod-host', registry })
    sharing.expose(upstream.port, 'web', { hostname: '127.0.0.1' })
    sharing.expose(upstream.port, 'admin', { hostname: '127.0.0.1' })
  })

  const asPeer = (key) => ({ fromPubKey: key })

  it('refuses a peer that holds no grant, without contacting the upstream', async () => {
    const res = await sharing.handleRequest({ name: 'web', method: 'GET', path: '/' }, asPeer('peer-a'))
    assert.equal(res.status, 403)
    assert.equal(upstream.seen.length, 0)
  })

  it('refuses a peer when the share does not exist the same way as when it is not allowed', async () => {
    const res = await sharing.handleRequest({ name: 'nope', method: 'GET', path: '/' }, asPeer('peer-a'))
    assert.equal(res.status, 403)
  })

  it('serves a peer that holds the scope of that share only', async () => {
    registry.grantCapabilities('peer-a', ['server-share:web:request'])
    const ok = await sharing.handleRequest({ name: 'web', method: 'GET', path: '/x' }, asPeer('peer-a'))
    assert.equal(ok.status, 200)
    const other = await sharing.handleRequest({ name: 'admin', method: 'GET', path: '/x' }, asPeer('peer-a'))
    assert.equal(other.status, 403)
    const stranger = await sharing.handleRequest({ name: 'web', method: 'GET', path: '/x' }, asPeer('peer-b'))
    assert.equal(stranger.status, 403)
    assert.equal(upstream.seen.length, 1)
  })

  it('honours a wildcard scope, and stops serving once it is revoked', async () => {
    registry.grantCapabilities('peer-a', ['server-share:*:request'])
    assert.equal((await sharing.handleRequest({ name: 'admin', method: 'GET', path: '/' }, asPeer('peer-a'))).status, 200)
    registry.revokeCapabilities('peer-a', ['server-share:*:request'])
    assert.equal((await sharing.handleRequest({ name: 'admin', method: 'GET', path: '/' }, asPeer('peer-a'))).status, 403)
  })

  it('denies when no registry is configured and a peer is the caller', async () => {
    const bare = new ServerSharing({ localPodId: 'pod-host' })
    bare.expose(upstream.port, 'web', { hostname: '127.0.0.1' })
    const res = await bare.handleRequest({ name: 'web', method: 'GET', path: '/' }, asPeer('peer-a'))
    assert.equal(res.status, 403)
    assert.equal(upstream.seen.length, 0)
  })

  it('denies a caller without a usable key', async () => {
    registry.grantCapabilities('peer-a', ['server-share:*:request'])
    for (const caller of [{}, { fromPubKey: '' }, { fromPubKey: 5 }, { fromPubKey: null }]) {
      const res = await sharing.handleRequest({ name: 'web', method: 'GET', path: '/' }, caller)
      assert.equal(res.status, 403)
    }
  })

  it('still checks the target when the caller is allowed', async () => {
    registry.grantCapabilities('peer-a', ['server-share:*:request'])
    const res = await sharing.handleRequest({ name: 'web', method: 'GET', path: '//example.com/x' }, asPeer('peer-a'))
    assert.equal(res.status, 400)
    assert.equal(upstream.seen.length, 0)
  })
})
