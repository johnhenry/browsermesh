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

  it('proxies a GET request and returns the target\'s status/body/content-type', async () => {
    const handler = createProxyHandler({ targetOrigin: origin })
    const res = await handler({ path: '/hello', method: 'GET' })
    assert.equal(res.status, 200)
    assert.equal(dec.decode(res.body), 'hello from origin')
    assert.equal(res.headers['content-type'], 'text/plain')
  })

  it('strips set-cookie from the proxied response (never forwarded)', async () => {
    const handler = createProxyHandler({ targetOrigin: origin })
    const res = await handler({ path: '/hello', method: 'GET' })
    assert.equal(res.headers['set-cookie'], undefined)
  })

  it('forwards the request method', async () => {
    const handler = createProxyHandler({ targetOrigin: origin })
    const res = await handler({ path: '/echo-method', method: 'PUT', headers: {}, body: undefined })
    assert.equal(dec.decode(res.body), 'PUT')
  })

  it('forwards a POST body to the target', async () => {
    const handler = createProxyHandler({ targetOrigin: origin })
    const res = await handler({ path: '/echo-body', method: 'POST', body: 'the request body' })
    assert.equal(dec.decode(res.body), 'the request body')
  })

  it('forwards a custom request header, minus hop-by-hop ones', async () => {
    const handler = createProxyHandler({ targetOrigin: origin })
    const res = await handler({ path: '/echo-header', method: 'GET', headers: { 'x-custom': 'passed-through' } })
    assert.equal(dec.decode(res.body), 'passed-through')
  })

  it('passes through a real 404 unchanged when spaFallback is false', async () => {
    const handler = createProxyHandler({ targetOrigin: origin, spaFallback: false })
    const res = await handler({ path: '/does-not-exist', method: 'GET' })
    assert.equal(res.status, 404)
  })

  it('spaFallback:true serves /index.html on a 404', async () => {
    const handler = createProxyHandler({ targetOrigin: origin, spaFallback: true })
    const res = await handler({ path: '/some/client/route', method: 'GET' })
    assert.equal(res.status, 200)
    assert.equal(dec.decode(res.body), '<html>spa shell</html>')
  })

  it('returns a clean 502 (never throws) when the target is unreachable', async () => {
    const handler = createProxyHandler({ targetOrigin: 'http://127.0.0.1:1' }) // port 1: nothing listens, connection refused
    const res = await handler({ path: '/', method: 'GET' })
    assert.equal(res.status, 502)
  })
})
