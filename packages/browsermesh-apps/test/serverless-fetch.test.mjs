/**
 * Tests for serverless-fetch.mjs (Phase 2 of the BrowserMesh Serverless
 * plan -- see that file's own module doc comment).
 *
 * Exercises `createServerlessFetchRouter()` against real `Request` objects
 * and `MeshFetchRouter.route()` (giving `sw-routing.mjs`'s router its first
 * real, tested caller), with a duck-typed `meshRpcApi` standing in for a
 * real mesh-rpc.mjs attach -- the mesh-rpc transport itself is already
 * covered by mesh-rpc.test.mjs and exercised end-to-end in
 * serverless-router.test.mjs; this file's job is the fetch-router-level
 * wiring: site-name resolution/fallback and binary-body round-tripping
 * through a real `Response`.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/serverless-fetch.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createServerlessFetchRouter } from '../src/serverless-fetch.mjs'
import { encodeWireResponse } from '../src/serverless-wire.mjs'

const enc = new TextEncoder()
const dec = new TextDecoder()

/** A duck-typed mesh-rpc api that records calls and serves canned wire-encoded responses keyed by podId. */
function fakeMeshRpcApi(responsesByPodId) {
  const calls = []
  return {
    calls,
    async request(podId, req) {
      calls.push({ podId, req })
      const res = responsesByPodId[podId]
      if (!res) throw new Error(`fakeMeshRpcApi: no canned response for podId ${podId}`)
      return res
    },
  }
}

describe('createServerlessFetchRouter: construction', () => {
  it('throws without a meshRpcApi with .request()', () => {
    assert.throws(() => createServerlessFetchRouter(null), /meshRpcApi/)
    assert.throws(() => createServerlessFetchRouter({}), /meshRpcApi/)
  })
})

describe('createServerlessFetchRouter: site-name resolution', () => {
  it('resolves the mesh:// token via resolveSite() when it returns a podId', async () => {
    const meshRpcApi = fakeMeshRpcApi({
      'real-pod-id': encodeWireResponse({ status: 200, headers: { 'content-type': 'text/html' }, body: '<html>site</html>' }),
    })
    const router = createServerlessFetchRouter(meshRpcApi, { resolveSite: (token) => (token === 'my-blog' ? 'real-pod-id' : null) })

    const res = await router.route(new Request('mesh://my-blog/index.html'))
    assert.ok(res)
    assert.equal(await res.text(), '<html>site</html>')
    assert.equal(meshRpcApi.calls[0].podId, 'real-pod-id')
  })

  it('falls back to treating the token as a literal podId when resolveSite returns null/undefined', async () => {
    const meshRpcApi = fakeMeshRpcApi({
      'literal-pod-id': encodeWireResponse({ status: 200, headers: {}, body: 'direct hit' }),
    })
    const router = createServerlessFetchRouter(meshRpcApi, { resolveSite: () => null })

    const res = await router.route(new Request('mesh://literal-pod-id/'))
    assert.equal(await res.text(), 'direct hit')
    assert.equal(meshRpcApi.calls[0].podId, 'literal-pod-id')
  })

  it('behaves identically to direct podId addressing when resolveSite is omitted entirely (Phase 5 not yet wired)', async () => {
    const meshRpcApi = fakeMeshRpcApi({ 'some-pod': encodeWireResponse({ status: 200, headers: {}, body: 'ok' }) })
    const router = createServerlessFetchRouter(meshRpcApi)
    const res = await router.route(new Request('mesh://some-pod/'))
    assert.equal(await res.text(), 'ok')
  })

  it('supports the https://podId.mesh.local/path URL form too', async () => {
    const meshRpcApi = fakeMeshRpcApi({ 'my-pod': encodeWireResponse({ status: 200, headers: {}, body: 'via mesh.local' }) })
    const router = createServerlessFetchRouter(meshRpcApi)
    const res = await router.route(new Request('https://my-pod.mesh.local/about'))
    assert.equal(await res.text(), 'via mesh.local')
    assert.equal(meshRpcApi.calls[0].req.path, '/about')
  })

  it('returns null for a non-mesh URL (not its concern, MeshFetchRouter\'s own existing behavior)', async () => {
    const meshRpcApi = fakeMeshRpcApi({})
    const router = createServerlessFetchRouter(meshRpcApi)
    const res = await router.route(new Request('https://example.com/'))
    assert.equal(res, null)
  })
})

describe('createServerlessFetchRouter: binary body round-trips through a real Response', () => {
  it('decodes a base64-wire-encoded static-file body back into real bytes on the final Response', async () => {
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // PNG magic bytes
    const meshRpcApi = fakeMeshRpcApi({
      'site-pod': encodeWireResponse({ status: 200, headers: { 'content-type': 'image/png' }, body: pngBytes }),
    })
    const router = createServerlessFetchRouter(meshRpcApi)

    const res = await router.route(new Request('mesh://site-pod/logo.png'))
    assert.equal(res.headers.get('content-type'), 'image/png')
    const receivedBytes = new Uint8Array(await res.arrayBuffer())
    assert.deepEqual([...receivedBytes], [...pngBytes], 'the exact binary bytes must survive the full encode -> mesh-rpc -> decode -> Response round trip')
  })

  it('never leaks the internal wire-encoding header onto the final Response', async () => {
    const meshRpcApi = fakeMeshRpcApi({
      'site-pod': encodeWireResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: enc.encode('hi') }),
    })
    const router = createServerlessFetchRouter(meshRpcApi)
    const res = await router.route(new Request('mesh://site-pod/file.txt'))
    assert.equal(res.headers.get('x-mesh-serverless-body-encoding'), null)
    assert.equal(dec.decode(await res.arrayBuffer()), 'hi')
  })
})
