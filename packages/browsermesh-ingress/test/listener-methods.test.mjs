// Any method and a streamed body through the real Node listener: framing (Content-Length, chunked, trailers), Expect: 100-continue,
// an answer that comes before the upload ends, a client that goes away mid-upload, and TCP backpressure from a slow origin.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { httpRig, statusOf } from './helpers/http.mjs'
import { deferred, until } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

const MiB = 1024 * 1024
const rig = (options) => httpRig(options, cleanups)

/** A socket to the listener that reads everything the server writes, and can write with backpressure. */
function connect(port) {
  const socket = net.connect(port, '127.0.0.1')
  const state = { text: '', closed: false, socket }
  socket.setEncoding('latin1')
  socket.on('data', (d) => { state.text += d })
  socket.on('close', () => { state.closed = true })
  socket.on('error', () => {})
  state.opened = new Promise((resolve) => socket.once('connect', resolve))
  state.write = (chunk) => new Promise((resolve) => { if (state.closed || socket.destroyed) return resolve(false); socket.write(chunk, 'latin1', () => resolve(!state.closed)) })
  return state
}

const chunked = (data) => `${data.length.toString(16)}\r\n${data}\r\n`

describe('methods through the listener', () => {
  it('carries POST, PUT, PATCH, DELETE and OPTIONS with bodies and an extension method', async () => {
    const t = await rig({ handler: async (request) => new Response(`${request.method}:${await request.text()}`) })
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'PURGE']) {
      const res = await t.fetch('/x', { method, body: `body of ${method}` })
      assert.equal(res.status, 200, method)
      assert.equal(await res.text(), `${method}:body of ${method}`)
    }
    const options = await t.fetch('/x', { method: 'OPTIONS', headers: { 'access-control-request-method': 'PUT', origin: 'https://x.test' } })
    assert.equal(options.status, 200)
    assert.equal(await options.text(), 'OPTIONS:')
  })

  it('carries a method Node knows that is not a standard one (M-SEARCH, PROPFIND) and says 501 to one it cannot parse', async () => {
    const t = await rig({ handler: (request) => new Response(request.method) })
    for (const method of ['M-SEARCH', 'PROPFIND', 'REPORT']) {
      const r = await t.raw(`${method} / HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n\r\n`)
      assert.equal(statusOf(r.text), 200, method)
      assert.ok(r.text.includes(`\r\n${method}\r\n`), method)
    }
    const odd = await t.raw('X-Custom.Verb / HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n\r\n')
    assert.equal(statusOf(odd.text), 501)
  })

  it('refuses TRACE and CONNECT, always, with Allow', async () => {
    const t = await rig({ handler: () => { throw new Error('must not run') } })
    const trace = await t.raw('TRACE / HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n\r\n')
    assert.equal(statusOf(trace.text), 405)
    assert.match(trace.text, /allow: GET, HEAD, POST/i)
    assert.match(trace.text, /x-browsermesh-ingress-reason: method-not-allowed/i)
    const connect = await t.raw('CONNECT app.test:443 HTTP/1.1\r\nHost: app.test:443\r\n\r\n')
    assert.equal(statusOf(connect.text), 405)
    assert.equal(t.served.stats().requests, 0)
  })

  it('narrowing at the ingress is a 405 with Allow, and the provider is not asked', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'HEAD', 'POST'] }, handler: (request) => new Response(request.method) })
    assert.equal((await t.fetch('/', { method: 'POST', body: 'x' })).status, 200)
    const put = await t.fetch('/', { method: 'PUT', body: 'x' })
    assert.equal(put.status, 405)
    assert.equal(put.headers.get('allow'), 'GET, HEAD, POST')
  })

  it('carries a 4 MiB POST with Content-Length byte for byte', async () => {
    const t = await rig({ handler: (request) => new Response(request.body) })
    const bytes = new Uint8Array(4 * MiB)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 255
    const res = await t.fetch('/echo', { method: 'PUT', body: bytes })
    assert.equal(res.status, 200)
    const back = new Uint8Array(await res.arrayBuffer())
    assert.equal(createHash('sha256').update(back).digest('hex'), createHash('sha256').update(bytes).digest('hex'))
  })

  it('carries a chunked upload, and drops request trailers', async () => {
    const seen = deferred()
    const t = await rig({ handler: async (request) => { seen.resolve({ body: await request.text(), trailer: request.headers.get('x-checksum'), te: request.headers.get('trailer'), hasTe: request.headers.get('te') }); return new Response('ok') } })
    const text = 'POST / HTTP/1.1\r\nHost: app.test\r\nTransfer-Encoding: chunked\r\nTrailer: x-checksum\r\nTE: trailers\r\nConnection: close\r\n\r\n'
      + `${chunked('hello ')}${chunked('trailers')}0\r\nx-checksum: abc\r\n\r\n`
    const r = await t.raw(text)
    assert.equal(statusOf(r.text), 200)
    assert.deepEqual(await seen.promise, { body: 'hello trailers', trailer: null, te: null, hasTe: null })
  })

  it('refuses a body whose length is not what Content-Length said (the client sent less and left)', async () => {
    const ended = deferred()
    const t = await rig({ handler: async (request) => { try { await request.arrayBuffer(); ended.resolve('completed') } catch { ended.resolve('errored') } return new Response('x') } })
    const c = connect(t.listener.port)
    await c.opened
    await c.write('POST / HTTP/1.1\r\nHost: app.test\r\nContent-Length: 1000\r\n\r\nshort')
    c.socket.destroy()
    assert.equal(await ended.promise, 'errored')
  })
})

describe('Expect: 100-continue', () => {
  it('is answered once the ingress is ready to read, and the body then goes through', async () => {
    const t = await rig({ handler: async (request) => new Response(`got ${(await request.text()).length}`) })
    const c = connect(t.listener.port)
    await c.opened
    await c.write('POST / HTTP/1.1\r\nHost: app.test\r\nContent-Length: 5\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n')
    await until(() => c.text.includes('100 Continue'), 'the 100 Continue')
    assert.ok(!c.text.includes('200 OK'), 'no answer before the body')
    await c.write('hello')
    await until(() => c.closed, 'the answer')
    assert.equal(statusOf(c.text.slice(c.text.indexOf('HTTP/1.1 200'))), 200)
    assert.match(c.text, /\r\ngot 5\r\n/)
  })

  it('is NOT sent to a client that is going to be refused: the answer comes with no 100', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'HEAD'] }, handler: () => new Response('x') })
    const c = connect(t.listener.port)
    await c.opened
    await c.write('POST / HTTP/1.1\r\nHost: app.test\r\nContent-Length: 50000000\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n')
    await until(() => c.closed, 'the refusal')
    assert.equal(statusOf(c.text), 405)
    assert.ok(!c.text.includes('100 Continue'))
  })

  it('is NOT sent for a declared length over the cap: 413 straight away', async () => {
    const t = await rig({ handler: () => new Response('x') })
    const c = connect(t.listener.port)
    await c.opened
    await c.write(`POST / HTTP/1.1\r\nHost: app.test\r\nContent-Length: ${64 * MiB}\r\nExpect: 100-continue\r\nConnection: close\r\n\r\n`)
    await until(() => c.closed, 'the refusal')
    assert.equal(statusOf(c.text), 413)
    assert.match(c.text, /x-browsermesh-ingress-reason: body-too-large/i)
    assert.ok(!c.text.includes('100 Continue'))
  })
})

describe('answers that come before the upload ends, and clients that leave', () => {
  it('delivers an early 401 while a chunked upload is still going, and stops the upload cleanly', async () => {
    const t = await rig({ handler: () => new Response('who are you', { status: 401 }) })
    const c = connect(t.listener.port)
    await c.opened
    await c.write('POST / HTTP/1.1\r\nHost: app.test\r\nTransfer-Encoding: chunked\r\n\r\n')
    const piece = chunked('x'.repeat(64 * 1024))
    let written = 0
    while (!c.closed && written < 64 * MiB) {
      if (!await c.write(piece)) break
      written += piece.length
    }
    await until(() => c.closed, 'the connection to end')
    assert.equal(statusOf(c.text), 401)
    assert.match(c.text, /who are you/)
    assert.match(c.text, /connection: close/i)
    assert.ok(written < 16 * MiB, `the client got to send ${written} bytes`)
  })

  it('a client that disconnects mid-upload errors the pod\'s body and aborts the origin request', async () => {
    const ended = deferred()
    const aborted = deferred()
    const t = await rig({
      handler: async (request, { signal }) => {
        signal.addEventListener('abort', () => aborted.resolve(true), { once: true })
        try { for await (const c of request.body) void c; ended.resolve('completed') } catch { ended.resolve('errored') }
        return new Response('late')
      },
    })
    const c = connect(t.listener.port)
    await c.opened
    await c.write('POST / HTTP/1.1\r\nHost: app.test\r\nTransfer-Encoding: chunked\r\n\r\n')
    await c.write(chunked('x'.repeat(64 * 1024)))
    await c.write(chunked('x'.repeat(64 * 1024)))
    c.socket.destroy()
    assert.equal(await ended.promise, 'errored')
    assert.equal(await aborted.promise, true)
    await until(() => t.audits.length > 0, 'the audit record')
    assert.equal(t.audits.at(-1).reason, 'client-aborted')
  })

  it('pushes back on a client when the origin is slow: the kernel and the ingress hold a bounded amount', async () => {
    const gate = deferred()
    let read = 0
    const t = await rig({
      handler: async (request) => { await gate.promise; for await (const c of request.body) read += c.byteLength; return new Response(String(read)) },
      ingress: { limits: { maxRequestBodyBytes: 256 * MiB } }, provider: { maxBodyBytes: 256 * MiB },
    })
    const c = connect(t.listener.port)
    await c.opened
    await c.write('POST / HTTP/1.1\r\nHost: app.test\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n')
    const piece = chunked('y'.repeat(64 * 1024))
    let sent = 0
    let pushedBack = false
    // Write until the socket says "wait" (a full send buffer): it must happen well before 64 MiB, since nothing reads while the origin waits.
    while (sent < 64 * MiB && !pushedBack) {
      const ok = await new Promise((resolve) => { const flushed = c.socket.write(piece, 'latin1'); if (flushed) resolve(true); else { pushedBack = true; resolve(false) } })
      if (ok) sent += piece.length
    }
    assert.ok(pushedBack, `${sent} bytes went into the connection and nothing pushed back`)
    assert.ok(sent < 32 * MiB, `${sent} bytes were taken before pushing back`)
    gate.resolve()
    c.socket.write('0\r\n\r\n', 'latin1')
    await until(() => c.closed, 'the answer')
    assert.equal(statusOf(c.text), 200)
    assert.ok(read > 0)
  })
})
