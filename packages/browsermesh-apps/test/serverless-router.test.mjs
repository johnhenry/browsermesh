/**
 * Tests for serverless-router.mjs (Phase 2 of the BrowserMesh Serverless
 * plan -- see that file's own module doc comment).
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/serverless-router.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createSiteRequestHandler, createSiteMeshRpcService, DEFAULT_SITE_ENVELOPE_TYPE } from '../src/serverless-router.mjs'
import { WIRE_ENCODING_HEADER } from '../src/serverless-wire.mjs'

const enc = new TextEncoder()
const dec = new TextDecoder()

describe('createSiteRequestHandler: chain precedence', () => {
  it('static wins when it returns a response, functions/proxy are never called', async () => {
    let functionsCalled = false
    let proxyCalled = false
    const onRequest = createSiteRequestHandler({
      staticHandler: async () => ({ status: 200, headers: {}, body: 'static hit' }),
      functionsHandler: async () => { functionsCalled = true; return { status: 200, headers: {}, body: 'fn hit' } },
      proxyHandler: async () => { proxyCalled = true; return { status: 200, headers: {}, body: 'proxy hit' } },
    })
    const res = await onRequest({ method: 'GET', path: '/' })
    assert.equal(res.body, 'static hit')
    assert.equal(functionsCalled, false)
    assert.equal(proxyCalled, false)
  })

  it('falls through to functions when static returns null', async () => {
    let proxyCalled = false
    const onRequest = createSiteRequestHandler({
      staticHandler: async () => null,
      functionsHandler: async () => ({ status: 200, headers: {}, body: 'fn hit' }),
      proxyHandler: async () => { proxyCalled = true; return { status: 200, headers: {}, body: 'proxy hit' } },
    })
    const res = await onRequest({ method: 'GET', path: '/api/whatever' })
    assert.equal(res.body, 'fn hit')
    assert.equal(proxyCalled, false)
  })

  it('falls through to proxy when both static and functions return null', async () => {
    const onRequest = createSiteRequestHandler({
      staticHandler: async () => null,
      functionsHandler: async () => null,
      proxyHandler: async () => ({ status: 200, headers: {}, body: 'proxy hit' }),
    })
    const res = await onRequest({ method: 'GET', path: '/anything' })
    assert.equal(res.body, 'proxy hit')
  })

  it('returns a clean 404 when nothing in the chain handles the request', async () => {
    const onRequest = createSiteRequestHandler({ staticHandler: async () => null })
    const res = await onRequest({ method: 'GET', path: '/missing' })
    assert.equal(res.status, 404)
  })

  it('a site with only staticHandler set works end to end (functions/proxy phases not yet built)', async () => {
    const onRequest = createSiteRequestHandler({ staticHandler: async () => ({ status: 200, headers: {}, body: 'hi' }) })
    const res = await onRequest({ method: 'GET', path: '/' })
    assert.equal(res.status, 200)
    assert.equal(res.body, 'hi')
  })

  it('base64-encodes a binary body from any handler in the chain via encodeWireResponse()', async () => {
    const bytes = enc.encode('binary from static')
    const onRequest = createSiteRequestHandler({ staticHandler: async () => ({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: bytes }) })
    const res = await onRequest({ method: 'GET', path: '/file.bin' })
    assert.equal(typeof res.body, 'string')
    assert.equal(res.headers[WIRE_ENCODING_HEADER], 'base64')
    assert.equal(res.headers['content-type'], 'application/octet-stream')
  })
})

describe('createSiteMeshRpcService', () => {
  it('produces a MeshService descriptor named "mesh-serverless" using the mesh-serverless envelope type by default', () => {
    const service = createSiteMeshRpcService({ staticHandler: async () => null })
    assert.equal(service.name, 'mesh-serverless')
    assert.equal(typeof service.attach, 'function')
    assert.equal(DEFAULT_SITE_ENVELOPE_TYPE, 'mesh-serverless')
  })

  it('attaches successfully and routes an inbound rpc-request to the site handler, over the mesh-serverless envelope', async () => {
    const service = createSiteMeshRpcService({
      staticHandler: async ({ path }) => (path === '/' ? { status: 200, headers: { 'content-type': 'text/plain' }, body: 'home' } : null),
    })

    // Minimal fake ctx, matching mesh-service.mjs's createServiceContext() shape.
    // mesh-rpc.mjs's real dispatch callback is fire-and-forget (sync callback
    // that internally kicks off an unawaited async handleRequest()), exactly
    // like the real ctx.onIncomingData() -- so this fake must let the test
    // await completion via the sendTo() call itself, not via the callback's
    // own (non-existent) return value.
    const sent = []
    const handlers = new Map()
    let sendToResolve
    const sendToDone = new Promise((resolve) => { sendToResolve = resolve })
    const ctx = {
      onIncomingData(types, cb) {
        const typeSet = new Set(Array.isArray(types) ? types : [types])
        for (const t of typeSet) handlers.set(t, cb)
        return () => {}
      },
      async sendTo(pubKey, type, payload) {
        sent.push({ pubKey, type, payload })
        sendToResolve()
      },
      emit() {},
    }

    const result = service.attach({ podId: 'local' }, ctx)
    assert.equal(typeof result.api.request, 'function')

    // Simulate an inbound rpc-request envelope arriving on the mesh-serverless type.
    const cb = handlers.get('mesh-serverless')
    assert.ok(cb, 'attach() must have subscribed to the mesh-serverless envelope type')
    cb('remote-peer', { kind: 'rpc-request', requestId: 'req-1', method: 'GET', path: '/', headers: {}, body: undefined })
    await sendToDone

    assert.equal(sent.length, 1)
    assert.equal(sent[0].type, 'mesh-serverless')
    assert.equal(sent[0].payload.kind, 'rpc-response')
    assert.equal(sent[0].payload.status, 200)
    assert.equal(sent[0].payload.body, 'home')

    await result.teardown()
  })
})
