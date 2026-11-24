/**
 * Tests for serverless-proxy.mjs (Phase 4 of the BrowserMesh Serverless
 * plan -- see that file's own module doc comment).
 *
 * Exercises `createProxyHandler()` against a real local HTTP fixture server
 * (`node:http`, no external network dependency), per the plan's own Phase 4
 * verification note.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/serverless-proxy.test.mjs
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { createProxyHandler } from '../src/serverless-proxy.mjs'

const dec = new TextDecoder()

/** A tiny fixture server exercising the cases this handler needs to get right. */
function startFixtureServer() {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')

      if (req.url === '/hello') {
        res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'session=should-not-leak' })
        res.end('hello from origin')
        return
      }
      if (req.url === '/echo-method') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(req.method)
        return
      }
      if (req.url === '/echo-body' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(body)
        return
      }
      if (req.url === '/echo-header') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(req.headers['x-custom'] || '(none)')
        return
      }
      if (req.url === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<html>spa shell</html>')
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

describe('createProxyHandler', () => {
  let server, origin

  before(async () => {
    server = await startFixtureServer()
    origin = `http://127.0.0.1:${server.address().port}`
  })

  after(() => new Promise((resolve) => server.close(resolve)))

  it('throws without targetOrigin, and on an invalid URL', () => {
    assert.throws(() => createProxyHandler({}), /opts.targetOrigin is required/)
    assert.throws(() => createProxyHandler({ targetOrigin: 'not a url' }))
  })

  describe('who may use it', () => {
    const request = { path: '/hello', method: 'GET' }

    it('refuses to be built without checkAccess or public: true: no handler exists to fetch anything', () => {
      assert.throws(() => createProxyHandler({ targetOrigin: origin }), /checkAccess is required unless opts\.public is true/)
      assert.throws(() => createProxyHandler({ targetOrigin: origin, public: false }), /checkAccess/)
      assert.doesNotThrow(() => createProxyHandler({ targetOrigin: origin, public: true }))
      assert.doesNotThrow(() => createProxyHandler({ targetOrigin: origin, checkAccess: () => ({ allowed: false }) }))
    })

    it('asks checkAccess about the caller (the key of the session the request came on) and the target, and fetches only when allowed', async () => {
      const asked = []
      const allowed = new Set(['peer-ok'])
      const handler = createProxyHandler({
        targetOrigin: origin,
        checkAccess: (key, resource, action) => { asked.push({ key, resource, action }); return { allowed: allowed.has(key) } },
      })
      const ok = await handler({ ...request, fromPubKey: 'peer-ok' })
      assert.equal(ok.status, 200)
      assert.equal(dec.decode(ok.body), 'hello from origin')
      const denied = await handler({ ...request, fromPubKey: 'peer-no' })
      assert.equal(denied.status, 403)
      const anonymous = await handler(request)
      assert.equal(anonymous.status, 403)
      assert.equal(asked[0].key, 'peer-ok')
      assert.equal(asked[0].action, 'request')
      assert.equal(asked[0].resource, `serverless-proxy:${encodeURIComponent(new URL(origin).host)}`)
    })

    it('never asks on behalf of a caller that named nobody', async () => {
      let asked = 0
      const handler = createProxyHandler({ targetOrigin: origin, checkAccess: () => { asked++; return { allowed: true } } })
      for (const fromPubKey of [undefined, '', 5, {}]) assert.equal((await handler({ ...request, fromPubKey })).status, 403)
      assert.equal(asked, 0)
    })

    it('a checkAccess that throws, or answers anything but allowed: true, denies', async () => {
      for (const checkAccess of [() => { throw new Error('boom') }, async () => ({ allowed: true }), () => true, () => ({ allowed: 'yes' }), () => undefined]) {
        const handler = createProxyHandler({ targetOrigin: origin, checkAccess })
        assert.equal((await handler({ ...request, fromPubKey: 'peer' })).status, 403, String(checkAccess))
      }
    })

    it('the resource can be named, and public: true opens it to every caller', async () => {
      const seen = []
      const named = createProxyHandler({ targetOrigin: origin, resource: 'site:docs', checkAccess: (k, r) => { seen.push(r); return { allowed: true } } })
      assert.equal((await named({ ...request, fromPubKey: 'p' })).status, 200)
      assert.deepEqual(seen, ['site:docs'])
      const open = createProxyHandler({ targetOrigin: origin, public: true })
      assert.equal((await open(request)).status, 200)
    })

    it('rejects a checkAccess that is not a function', () => {
      assert.throws(() => createProxyHandler({ targetOrigin: origin, checkAccess: true }), /checkAccess must be a function/)
    })
  })

  it('proxies a GET request and returns the target\'s status/body/content-type', async () => {
    const handler = createProxyHandler({ public: true, targetOrigin: origin })
    const res = await handler({ path: '/hello', method: 'GET' })
    assert.equal(res.status, 200)
    assert.equal(dec.decode(res.body), 'hello from origin')
    assert.equal(res.headers['content-type'], 'text/plain')
  })

  it('strips set-cookie from the proxied response (never forwarded)', async () => {
    const handler = createProxyHandler({ public: true, targetOrigin: origin })
    const res = await handler({ path: '/hello', method: 'GET' })
    assert.equal(res.headers['set-cookie'], undefined)
  })

  it('forwards the request method', async () => {
    const handler = createProxyHandler({ public: true, targetOrigin: origin })
    const res = await handler({ path: '/echo-method', method: 'PUT', headers: {}, body: undefined })
    assert.equal(dec.decode(res.body), 'PUT')
  })

  it('forwards a POST body to the target', async () => {
    const handler = createProxyHandler({ public: true, targetOrigin: origin })
    const res = await handler({ path: '/echo-body', method: 'POST', body: 'the request body' })
    assert.equal(dec.decode(res.body), 'the request body')
  })

  it('forwards a custom request header, minus hop-by-hop ones', async () => {
    const handler = createProxyHandler({ public: true, targetOrigin: origin })
    const res = await handler({ path: '/echo-header', method: 'GET', headers: { 'x-custom': 'passed-through' } })
    assert.equal(dec.decode(res.body), 'passed-through')
  })

  it('passes through a real 404 unchanged when spaFallback is false', async () => {
    const handler = createProxyHandler({ public: true, targetOrigin: origin, spaFallback: false })
    const res = await handler({ path: '/does-not-exist', method: 'GET' })
    assert.equal(res.status, 404)
  })

  it('spaFallback:true serves /index.html on a 404', async () => {
    const handler = createProxyHandler({ public: true, targetOrigin: origin, spaFallback: true })
    const res = await handler({ path: '/some/client/route', method: 'GET' })
    assert.equal(res.status, 200)
    assert.equal(dec.decode(res.body), '<html>spa shell</html>')
  })

  it('refuses a path that would leave the target origin, sending nothing', async () => {
    const seen = []
    const second = http.createServer((req, res) => { seen.push(req.url); res.end('x') })
    await new Promise((r) => second.listen(0, '127.0.0.1', r))
    const o = second.address().port
    try {
      const handler = createProxyHandler({ public: true, targetOrigin: origin })
      const paths = [
        `//127.0.0.1:${o}/x`, `@127.0.0.1:${o}/x`, `127.0.0.1:${o}/x`, `http://127.0.0.1:${o}/x`,
        `/\\127.0.0.1:${o}/x`, `\\\\127.0.0.1:${o}/x`, '/x\r\ny', '/x\u0000', '/a b', 5, {},
      ]
      for (const path of paths) {
        const res = await handler({ path, method: 'GET' })
        assert.equal(res.status, 400, `path ${JSON.stringify(path)} must be refused`)
      }
      assert.deepEqual(seen, [])
    } finally {
      await new Promise((r) => { second.closeAllConnections(); second.close(r) })
    }
  })

  it('does not follow a redirect, including one to another origin', async () => {
    const seen = []
    const second = http.createServer((req, res) => { seen.push(req.url); res.end('x') })
    await new Promise((r) => second.listen(0, '127.0.0.1', r))
    const o = second.address().port
    const redirecting = http.createServer((req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${o}/landed` })
      res.end()
    })
    await new Promise((r) => redirecting.listen(0, '127.0.0.1', r))
    try {
      const handler = createProxyHandler({ public: true, targetOrigin: `http://127.0.0.1:${redirecting.address().port}` })
      const res = await handler({ path: '/go', method: 'GET' })
      assert.equal(res.status, 302)
      assert.deepEqual(seen, [])
    } finally {
      await new Promise((r) => { second.closeAllConnections(); second.close(r) })
      await new Promise((r) => { redirecting.closeAllConnections(); redirecting.close(r) })
    }
  })

  it('bounds the response body', async () => {
    const big = http.createServer((req, res) => { res.writeHead(200); res.write(Buffer.alloc(64 * 1024)); res.end(Buffer.alloc(64 * 1024)) })
    await new Promise((r) => big.listen(0, '127.0.0.1', r))
    try {
      const handler = createProxyHandler({ public: true, targetOrigin: `http://127.0.0.1:${big.address().port}`, maxResponseBytes: 1024 })
      const res = await handler({ path: '/', method: 'GET' })
      assert.equal(res.status, 502)
    } finally {
      await new Promise((r) => { big.closeAllConnections(); big.close(r) })
    }
  })

  it('returns a clean 502 (never throws) when the target is unreachable', async () => {
    const handler = createProxyHandler({ public: true, targetOrigin: 'http://127.0.0.1:1' }) // port 1: nothing listens, connection refused
    const res = await handler({ path: '/', method: 'GET' })
    assert.equal(res.status, 502)
  })
})
