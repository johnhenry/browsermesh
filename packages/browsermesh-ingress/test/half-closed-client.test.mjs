// A client that has sent its whole request and finished sending (its FIN: `nc -N`, `shutdown(SHUT_WR)`) and keeps reading.
// The page it asked for may take seconds to be made by the provider; the answer must still reach it. The bounds that keep
// such a connection from being held for ever are the ingress's own (`timeoutMs` for the whole request, the listener's
// request timeout), not the client's end of file.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { httpRig, statusOf } from './helpers/http.mjs'
import { until } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
// Opt-in: a client's end of file is ambiguous (see `halfClosedClients` in src/node.mjs); the default is Node's, a hang-up.
const rig = (opts) => httpRig({ ...opts, listen: { halfClosedClients: true, ...opts?.listen } }, cleanups)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Send `request`, finish sending, and read until the server ends the connection. */
function halfClosed(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true })
    let buffer = ''
    socket.setEncoding('latin1')
    socket.on('data', (d) => { buffer += d })
    socket.on('end', () => { socket.end(); resolve({ text: buffer, ended: true }) })
    socket.on('error', (e) => { if (e.code === 'ECONNRESET') resolve({ text: buffer, ended: false }); else reject(e) })
    socket.on('connect', () => { socket.write(request); socket.end() })
  })
}

/** The body of a response that came chunked (the listener does not know the length of a streamed body). */
function chunkedBody(text) {
  const head = text.indexOf('\r\n\r\n')
  let rest = Buffer.from(text.slice(head + 4), 'latin1')
  const parts = []
  for (;;) {
    const eol = rest.indexOf('\r\n')
    const size = parseInt(rest.subarray(0, eol).toString('latin1'), 16)
    if (!size) return Buffer.concat(parts)
    parts.push(rest.subarray(eol + 2, eol + 2 + size))
    rest = rest.subarray(eol + 2 + size + 2)
  }
}

describe('a client that half-closes after its request', () => {
  it('gets the page the provider takes two seconds to make', { timeout: 20_000 }, async () => {
    const t = await rig({ handler: async () => { await sleep(2000); return new Response('late page') } })
    const answer = await halfClosed(t.listener.port, 'GET / HTTP/1.1\r\nHost: app.test\r\n\r\n')
    assert.equal(statusOf(answer.text), 200)
    assert.equal(chunkedBody(answer.text).toString(), 'late page')
    assert.equal(answer.ended, true, 'and the server ends the connection after the answer')
    await until(() => t.mesh.stats().inflight === 0)
  })

  it('by default (halfClosedClients off) a client\'s end of file is a hang-up: the page\'s handler is aborted', { timeout: 20_000 }, async () => {
    const aborted = Promise.withResolvers()
    const t = await httpRig({ handler: (request) => new Promise((resolve) => { request.signal.addEventListener('abort', () => { aborted.resolve(true); resolve(new Response('x')) }) }) }, cleanups)
    await halfClosed(t.listener.port, 'GET / HTTP/1.1\r\nHost: app.test\r\n\r\n')
    assert.equal(await aborted.promise, true)
  })

  it('gets a large response after the half-close', { timeout: 20_000 }, async () => {
    const data = new Uint8Array(2 * 1024 * 1024).map((_, i) => (i * 7) % 256)
    const t = await rig({ handler: async () => { await sleep(300); return new Response(data) } })
    const answer = await halfClosed(t.listener.port, 'GET / HTTP/1.1\r\nHost: app.test\r\n\r\n')
    assert.equal(statusOf(answer.text), 200)
    const body = chunkedBody(answer.text)
    assert.equal(body.length, data.length)
    assert.ok(body.every((b, i) => b === data[i]))
  })

  it('a request body that was sent whole before the half-close reaches the provider, and the answer comes back', { timeout: 20_000 }, async () => {
    const t = await rig({
      ingress: { methods: ['GET', 'POST'] },
      handler: async (request) => { const n = (await request.arrayBuffer()).byteLength; await sleep(1500); return new Response(`got ${n}`) },
    })
    const body = 'x'.repeat(5000)
    const answer = await halfClosed(t.listener.port, `POST / HTTP/1.1\r\nHost: app.test\r\nContent-Length: ${body.length}\r\n\r\n${body}`)
    assert.equal(statusOf(answer.text), 200)
    assert.equal(chunkedBody(answer.text).toString(), 'got 5000')
  })

  it('a client that half-closes in the middle of a request body does not leave the request in flight', { timeout: 20_000 }, async () => {
    const t = await rig({ ingress: { methods: ['GET', 'POST'] }, handler: async (request) => new Response(`got ${(await request.arrayBuffer()).byteLength}`) })
    const answer = await halfClosed(t.listener.port, 'POST / HTTP/1.1\r\nHost: app.test\r\nContent-Length: 5000\r\n\r\nonly a little')
    assert.notEqual(statusOf(answer.text), 200)
    await until(() => t.mesh.stats().inflight === 0)
  })

  it('one that half-closes and never reads is bounded by the ingress\'s whole-request time, and the slot is freed', { timeout: 20_000 }, async () => {
    const t = await rig({ ingress: { limits: { timeoutMs: 400 } }, handler: () => new Promise(() => {}) })
    const answer = await halfClosed(t.listener.port, 'GET / HTTP/1.1\r\nHost: app.test\r\n\r\n')
    assert.ok(answer.ended || answer.text !== '', 'the connection was answered or ended, not left')
    await until(() => t.mesh.stats().inflight === 0)
  })
})
