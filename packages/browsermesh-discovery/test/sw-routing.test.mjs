// Run with: node --import ./test/_setup-globals.mjs --test test/sw-routing.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// -- Stubs for Request / Response / Headers (Service Worker API) -----------

class StubHeaders {
  #map = new Map()
  constructor(init = {}) {
    if (init && typeof init === 'object') {
      for (const [k, v] of Object.entries(init)) this.#map.set(k, v)
    }
  }
  forEach(cb) { this.#map.forEach(cb) }
  entries() { return this.#map.entries() }
  get(k) { return this.#map.get(k) ?? null }
}

class StubRequest {
  constructor(url, opts = {}) {
    this.url = url
    this.method = opts.method || 'GET'
    this.headers = new StubHeaders(opts.headers || {})
    this._body = opts.body ?? null
  }
  async text() { return this._body != null ? String(this._body) : '' }
}

globalThis.Response = globalThis.Response || class Response {
  constructor(body, init = {}) {
    this._body = body
    this.status = init.status ?? 200
    this.headers = new StubHeaders(init.headers || {})
  }
  async text() { return this._body }
  async json() { return JSON.parse(this._body) }
}

import { MeshFetchRouter, parseMeshRequest } from '../src/sw-routing.mjs'

// ── parseMeshRequest ─────────────────────────────────────────────

describe('parseMeshRequest', () => {
  it('parses mesh://podId/path', () => {
    const result = parseMeshRequest('mesh://podA/api/v1')
    assert.deepEqual(result, { podId: 'podA', path: '/api/v1' })
  })

  it('parses https://podId.mesh.local/path', () => {
    const result = parseMeshRequest('https://podB.mesh.local/data')
    assert.deepEqual(result, { podId: 'podB', path: '/data' })
  })

  it('parses http://podId.mesh.local/path', () => {
    const result = parseMeshRequest('http://podX.mesh.local/info')
    assert.deepEqual(result, { podId: 'podX', path: '/info' })
  })

  it('defaults path to / when missing (mesh://)', () => {
    const result = parseMeshRequest('mesh://podC')
    assert.deepEqual(result, { podId: 'podC', path: '/' })
  })

  it('defaults path to / when just trailing slash (mesh://)', () => {
    const result = parseMeshRequest('mesh://podD/')
    assert.deepEqual(result, { podId: 'podD', path: '/' })
  })

  it('returns null for regular https URL', () => {
    assert.equal(parseMeshRequest('https://example.com/foo'), null)
  })

  it('returns null for empty string', () => {
    assert.equal(parseMeshRequest(''), null)
  })

  it('returns null for null/undefined', () => {
    assert.equal(parseMeshRequest(null), null)
    assert.equal(parseMeshRequest(undefined), null)
  })

  it('returns null for mesh:// with no podId', () => {
    assert.equal(parseMeshRequest('mesh://'), null)
  })

  it('returns null for bare .mesh.local with no podId', () => {
    assert.equal(parseMeshRequest('https://.mesh.local/path'), null)
  })
})

// ── MeshFetchRouter ──────────────────────────────────────────────

describe('MeshFetchRouter', () => {
  it('constructor requires onRpc', () => {
    assert.throws(
      () => new MeshFetchRouter({}),
      /onRpc callback is required/,
    )
  })

  it('route returns null for non-mesh URLs', async () => {
    const router = new MeshFetchRouter({ onRpc: async () => ({}) })
    const req = new StubRequest('https://example.com/api')
    const res = await router.route(req)
    assert.equal(res, null)
  })

  it('route calls onRpc and returns Response for mesh:// URL', async () => {
    const calls = []
    const router = new MeshFetchRouter({
      onRpc: async (params) => {
        calls.push(params)
        return { status: 200, body: { ok: true } }
      },
    })

    const req = new StubRequest('mesh://pod1/rpc/ping', {
      headers: { 'x-token': 'abc' },
    })
    const res = await router.route(req)

    assert.equal(calls.length, 1)
    assert.equal(calls[0].podId, 'pod1')
    assert.equal(calls[0].path, '/rpc/ping')
    assert.equal(calls[0].method, 'GET')
    assert.equal(calls[0].headers['x-token'], 'abc')

    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual(body, { ok: true })
  })

  it('route reads body for POST requests', async () => {
    const calls = []
    const router = new MeshFetchRouter({
      onRpc: async (params) => {
        calls.push(params)
        return { body: { received: true } }
      },
    })

    const req = new StubRequest('mesh://pod2/data', {
      method: 'POST',
      body: JSON.stringify({ key: 'value' }),
    })
    const res = await router.route(req)

    assert.equal(calls[0].method, 'POST')
    assert.deepEqual(calls[0].body, { key: 'value' })
    assert.equal(res.status, 200)
  })

  it('route keeps non-JSON body as string', async () => {
    const calls = []
    const router = new MeshFetchRouter({
      onRpc: async (params) => {
        calls.push(params)
        return { body: 'ok' }
      },
    })

    const req = new StubRequest('mesh://pod3/upload', {
      method: 'PUT',
      body: 'plain text body',
    })
    await router.route(req)

    assert.equal(calls[0].body, 'plain text body')
  })

  it('route returns 502 on RPC error', async () => {
    const router = new MeshFetchRouter({
      onRpc: async () => { throw new Error('pod unreachable') },
    })

    const req = new StubRequest('mesh://pod4/fail')
    const res = await router.route(req)

    assert.equal(res.status, 502)
    const body = await res.json()
    assert.equal(body.error, 'pod unreachable')
  })

  it('route works with *.mesh.local hostnames', async () => {
    const calls = []
    const router = new MeshFetchRouter({
      onRpc: async (params) => {
        calls.push(params)
        return { body: { mesh: 'local' } }
      },
    })

    const req = new StubRequest('https://myPod.mesh.local/status')
    const res = await router.route(req)

    assert.equal(calls[0].podId, 'myPod')
    assert.equal(calls[0].path, '/status')
    assert.equal(res.status, 200)
  })
})
