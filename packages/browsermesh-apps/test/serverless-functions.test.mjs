/**
 * Tests for serverless-functions.mjs (Phase 3 of the BrowserMesh Serverless
 * plan -- see that file's own module doc comment).
 *
 * Exercises `createFunctionsHandler()` against a fake/mock executor
 * (a plain `(job) => Promise<result>` function) -- the whole point of this
 * file's design is that route matching and response shaping are backend-
 * agnostic, so a mock executor is the correct, sufficient way to test it,
 * not a gap. `serverless-executor-andbox.test.mjs` covers the real andbox
 * backend's own (narrower, environment-limited) surface separately.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/serverless-functions.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createFunctionsHandler } from '../src/serverless-functions.mjs'

describe('createFunctionsHandler: construction', () => {
  it('throws without an executor', () => {
    assert.throws(() => createFunctionsHandler({}), /opts.executor is required/)
  })
})

describe('createFunctionsHandler: route matching', () => {
  it('returns null when no route matches the path', async () => {
    const handler = createFunctionsHandler({ routes: [{ path: '/api/hello', code: '' }], executor: async () => 'unused' })
    const res = await handler({ method: 'GET', path: '/nope' })
    assert.equal(res, null)
  })

  it('returns null when the path matches but the method does not', async () => {
    const handler = createFunctionsHandler({ routes: [{ path: '/api/hello', method: 'POST', code: '' }], executor: async () => 'unused' })
    const res = await handler({ method: 'GET', path: '/api/hello' })
    assert.equal(res, null)
  })

  it('defaults a route\'s method to GET', async () => {
    const handler = createFunctionsHandler({ routes: [{ path: '/api/hello', code: '' }], executor: async () => 'hit' })
    const res = await handler({ method: 'GET', path: '/api/hello' })
    assert.equal(res.body, 'hit')
  })

  it('matches an explicit non-GET method', async () => {
    const handler = createFunctionsHandler({ routes: [{ path: '/api/submit', method: 'POST', code: '' }], executor: async () => 'submitted' })
    const res = await handler({ method: 'POST', path: '/api/submit' })
    assert.equal(res.body, 'submitted')
    const wrongMethod = await handler({ method: 'GET', path: '/api/submit' })
    assert.equal(wrongMethod, null)
  })
})

describe('createFunctionsHandler: executor invocation', () => {
  it('passes the matched route\'s code and the full request to the executor', async () => {
    let capturedJob
    const handler = createFunctionsHandler({
      routes: [{ path: '/api/echo', code: 'return request' }],
      executor: async (job) => { capturedJob = job; return { ok: true } },
      timeoutMs: 1234,
    })
    await handler({ fromPubKey: 'peer-a', method: 'GET', path: '/api/echo', headers: { 'x-h': '1' }, body: 'b' })

    assert.equal(capturedJob.code, 'return request')
    assert.deepEqual(capturedJob.request, { fromPubKey: 'peer-a', method: 'GET', path: '/api/echo', headers: { 'x-h': '1' }, body: 'b' })
    assert.equal(capturedJob.timeoutMs, 1234)
  })
})

describe('createFunctionsHandler: response shaping', () => {
  it('wraps a raw (non-status-shaped) return value as a 200 JSON body', async () => {
    const handler = createFunctionsHandler({ routes: [{ path: '/', code: '' }], executor: async () => ({ greeting: 'hi' }) })
    const res = await handler({ method: 'GET', path: '/' })
    assert.equal(res.status, 200)
    assert.equal(res.headers['content-type'], 'application/json')
    assert.deepEqual(res.body, { greeting: 'hi' })
  })

  it('wraps a primitive return value the same way', async () => {
    const handler = createFunctionsHandler({ routes: [{ path: '/', code: '' }], executor: async () => 42 })
    const res = await handler({ method: 'GET', path: '/' })
    assert.equal(res.status, 200)
    assert.equal(res.body, 42)
  })

  it('uses an already response-shaped return value (status/headers/body) as-is', async () => {
    const handler = createFunctionsHandler({
      routes: [{ path: '/', code: '' }],
      executor: async () => ({ status: 201, headers: { 'x-created': 'yes' }, body: 'created' }),
    })
    const res = await handler({ method: 'GET', path: '/' })
    assert.equal(res.status, 201)
    assert.equal(res.headers['x-created'], 'yes')
    assert.equal(res.body, 'created')
  })

  it('turns a thrown/rejected executor into a clean 500, never an unhandled rejection', async () => {
    const handler = createFunctionsHandler({ routes: [{ path: '/', code: '' }], executor: async () => { throw new Error('sandbox blew up') } })
    const res = await handler({ method: 'GET', path: '/' })
    assert.equal(res.status, 500)
    assert.equal(res.body.error, 'sandbox blew up')
  })
})
