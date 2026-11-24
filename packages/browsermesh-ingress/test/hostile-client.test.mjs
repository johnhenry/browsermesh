// A hostile HTTP client, on raw sockets: smuggling shapes, huge headers, many connections, slow bodies, Host tricks,
// methods that are not served. Whatever it sends, nothing it makes up reaches the provider.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { httpRig, statusOf } from './helpers/http.mjs'
import { deferred, until } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

/** A rig whose provider records every request it is asked to answer. */
async function rig(opts = {}) {
  const asked = []
  const t = await httpRig({
    handler: (request) => { asked.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers) }); return new Response('ok') },
    ...opts,
  }, cleanups)
  t.asked = asked
  return t
}
const close = 'Connection: close\r\n'
const status = async (t, text) => statusOf((await t.raw(text)).text)

describe('request smuggling shapes', () => {
  it('Transfer-Encoding with Content-Length is refused and nothing reaches the provider', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'POST'] } })
    assert.equal(await status(t, `POST / HTTP/1.1\r\nHost: app.test\r\nContent-Length: 5\r\nTransfer-Encoding: chunked\r\n${close}\r\n0\r\n\r\n`), 400)
    assert.equal(t.asked.length, 0)
  })

  it('two different Content-Length headers, a signed or listed one, and an obfuscated Transfer-Encoding are refused', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'POST'] } })
    for (const headers of [
      'Content-Length: 5\r\nContent-Length: 6\r\n',
      'Content-Length: +5\r\n',
      'Content-Length: 5, 5\r\n',
      'Content-Length: 0x5\r\n',
      'Transfer-Encoding: xchunked\r\n',
      'Transfer-Encoding : chunked\r\n',
      'Transfer-Encoding: chunked, identity\r\n',
      'Transfer-Encoding: gzip\r\n',
      'Transfer-Encoding:\tchunked\r\nContent-Length: 4\r\n',
    ]) {
      const code = await status(t, `POST / HTTP/1.1\r\nHost: app.test\r\n${headers}${close}\r\nabcde`)
      assert.ok(code >= 400 && code < 500, `${JSON.stringify(headers)} -> ${code}`)
    }
    assert.equal(t.asked.length, 0)
  })

  it('bare line feeds, obsolete line folding and a NUL in a header are refused', async () => {
    const t = await rig()
    for (const text of [
      'GET / HTTP/1.1\nHost: app.test\n\n',
      'GET / HTTP/1.1\r\nHost: app.test\r\nX-A: b\r\n c\r\n\r\n',
      'GET / HTTP/1.1\r\nHost: app.test\r\nX-A: a\u0000b\r\n\r\n',
      'GET / HTTP/1.1\r\nHost: app.test\r\nBad Name: x\r\n\r\n',
    ]) {
      const { text: out } = await t.raw(text)
      assert.ok(statusOf(out) === 400 || out === '', JSON.stringify(text))
    }
    assert.equal(t.asked.length, 0)
  })

  it('a body smuggled behind a GET is not read as the next request', async () => {
    const t = await rig()
    const smuggled = 'GET /admin HTTP/1.1\r\nHost: app.test\r\n\r\n'
    const { text } = await t.raw(`GET / HTTP/1.1\r\nHost: app.test\r\nContent-Length: ${smuggled.length}\r\n${close}\r\n${smuggled}`)
    assert.equal(statusOf(text), 400)
    assert.ok(!t.asked.some((r) => r.url.endsWith('/admin')))
    assert.equal(t.asked.length, 0)
  })

  it('a POST whose body is longer than its Content-Length leaves the extra bytes as a separate (and refused) request, never part of the first', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'POST'] }, handler: async (request) => new Response(`len=${(await request.text()).length}`) })
    const { text } = await t.raw(`POST / HTTP/1.1\r\nHost: app.test\r\nContent-Length: 3\r\n\r\nabcDELETE / HTTP/1.1\r\nHost: app.test\r\n${close}\r\n`, { until: (b) => (b.match(/HTTP\/1\.1 \d{3}/g) ?? []).length >= 2 })
    const statuses = [...text.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1]))
    assert.equal(statuses[0], 200)
    assert.ok(text.includes('len=3'))
    assert.equal(statuses[1], 405) // the pipelined DELETE is a request of its own, refused by method
  })

  it('a GET or HEAD with any body, and a chunked GET, is a 400', async () => {
    const t = await rig()
    assert.equal(await status(t, `GET / HTTP/1.1\r\nHost: app.test\r\nContent-Length: 4\r\n${close}\r\nabcd`), 400)
    assert.equal(await status(t, `HEAD / HTTP/1.1\r\nHost: app.test\r\nContent-Length: 4\r\n${close}\r\nabcd`), 400)
    assert.equal(await status(t, `GET / HTTP/1.1\r\nHost: app.test\r\nTransfer-Encoding: chunked\r\n${close}\r\n0\r\n\r\n`), 400)
    assert.equal(t.asked.length, 0)
  })
})

describe('huge and many', () => {
  it('a header section over the limit is a 431', async () => {
    const t = await rig()
    assert.equal(await status(t, `GET / HTTP/1.1\r\nHost: app.test\r\nX-Big: ${'a'.repeat(40_000)}\r\n${close}\r\n`), 431)
    assert.equal(t.asked.length, 0)
  })

  it('many small headers are refused (431)', async () => {
    const t = await rig()
    const many = Array.from({ length: 200 }, (_, i) => `X-H${i}: v\r\n`).join('')
    assert.equal(await status(t, `GET / HTTP/1.1\r\nHost: app.test\r\n${many}${close}\r\n`), 431)
    assert.equal(t.asked.length, 0)
  })

  it('a very long request target is refused', async () => {
    const t = await rig()
    const code = await status(t, `GET /${'a'.repeat(5000)} HTTP/1.1\r\nHost: app.test\r\n${close}\r\n`)
    assert.ok(code === 414 || code === 431)
    assert.equal(t.asked.length, 0)
  })

  it('more connections than the listener allows are dropped at once, those already open are unharmed', async () => {
    const t = await rig({ listen: { maxConnections: 3 } })
    const held = []
    for (let i = 0; i < 3; i++) {
      const s = net.connect(t.listener.port, '127.0.0.1')
      await new Promise((r) => s.once('connect', r))
      held.push(s)
    }
    await until(() => t.listener.server.listenerCount('request') > 0 && true)
    const extra = net.connect(t.listener.port, '127.0.0.1')
    const dropped = await new Promise((resolve) => { extra.on('close', () => resolve(true)); extra.on('error', () => {}) })
    assert.equal(dropped, true)
    // The ones that got in still work.
    held[0].write(`GET / HTTP/1.1\r\nHost: app.test\r\n${close}\r\n`)
    const body = await new Promise((resolve) => { let b = ''; held[0].setEncoding('latin1'); held[0].on('data', (d) => { b += d }); held[0].on('close', () => resolve(b)) })
    assert.equal(statusOf(body), 200)
    for (const s of held) s.destroy()
  })

  it('a client that sends the head slowly is cut off by the header timeout', async () => {
    const t = await rig({ listen: { headersTimeoutMs: 100 } })
    const { text, closed } = await t.raw('', { parts: ['GET / HTTP/1.1\r\n', 'Host: app'] })
    // never completed: the server gives up on its own (a 408 or a plain close)
    assert.ok(closed)
    assert.ok(text === '' || statusOf(text) === 408)
    assert.equal(t.asked.length, 0)
  })
})

describe('slow bodies', () => {
  it('a POST that sends part of its body and stops is a 408, and the provider is never asked', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'POST'], limits: { bodyIdleMs: 60 } } })
    const { text } = await t.raw('', { parts: ['POST / HTTP/1.1\r\nHost: app.test\r\nContent-Length: 10\r\n\r\n', 'ab'], until: (b) => b.includes('\r\n\r\n') })
    assert.equal(statusOf(text), 408)
    assert.equal(t.asked.length, 0)
    await until(() => t.mesh.stats().inflight === 0)
  })

  it('a chunked body that never ends is cut at the cap', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'POST'], limits: { maxRequestBodyBytes: 100 } } })
    const chunk = `${(50).toString(16)}\r\n${'a'.repeat(50)}\r\n`
    const { text } = await t.raw(`POST / HTTP/1.1\r\nHost: app.test\r\nTransfer-Encoding: chunked\r\n\r\n${chunk}${chunk}${chunk}${chunk}`, { until: (b) => b.includes('\r\n\r\n') })
    assert.equal(statusOf(text), 413)
    assert.equal(t.asked.length, 0)
  })

  it('a client that never reads its response cannot hold the provider forever: the deadline releases the slot', async () => {
    const t = await rig({ handler: () => new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(16 * 1024)) } })), ingress: { limits: { timeoutMs: 300, responseIdleMs: 300 } } })
    const { socket } = await t.raw(`GET / HTTP/1.1\r\nHost: app.test\r\n\r\n`, { keepOpen: true, until: (b) => b.includes('\r\n\r\n') })
    socket.pause()
    await until(() => t.mesh.stats().inflight === 0)
    socket.destroy()
  })
})

describe('Host tricks', () => {
  it('a missing Host, two Hosts, userinfo, a path, spaces and a list in Host are all 400, and nothing reaches the provider', async () => {
    const t = await rig()
    const hosts = [
      '', 'Host: app.test\r\nHost: evil.test\r\n', 'Host: evil@app.test\r\n', 'Host: app.test/evil\r\n', 'Host: app test\r\n',
      'Host: app.test, evil.test\r\n', 'Host: app.test\u0000\r\n', 'Host: \r\n', 'Host: app_test\r\n', 'Host: app.test:99999x\r\n', 'Host: [::1\r\n',
    ]
    for (const h of hosts) {
      const { text } = await t.raw(`GET / HTTP/1.1\r\n${h}${close}\r\n`)
      assert.ok(statusOf(text) === 400 || text === '', JSON.stringify(h))
    }
    assert.equal(t.asked.length, 0)
  })

  it('X-Forwarded-Host, Forwarded and X-Original-URL do not change which pod answers or what it sees as the host', async () => {
    const t = await rig()
    const { text } = await t.raw(`GET /p HTTP/1.1\r\nHost: app.test\r\nX-Forwarded-Host: evil.test\r\nForwarded: host=evil.test\r\nX-Original-URL: /admin\r\nX-Rewrite-URL: /admin\r\nX-Forwarded-For: 6.6.6.6\r\n${close}\r\n`)
    assert.equal(statusOf(text), 200)
    assert.equal(t.asked.length, 1)
    assert.equal(t.asked[0].url, 'http://app.test/p')
    for (const name of ['x-forwarded-host', 'forwarded', 'x-original-url', 'x-rewrite-url', 'x-forwarded-for', 'host']) assert.equal(t.asked[0].headers[name], undefined, name)
  })

  it('the Host is matched as the mapping says: case-folded, and a host that is not mapped is a 404', async () => {
    const t = await rig()
    assert.equal(await status(t, `GET / HTTP/1.1\r\nHost: APP.TEST\r\n${close}\r\n`), 200)
    assert.equal(await status(t, `GET / HTTP/1.1\r\nHost: app.test:8080\r\n${close}\r\n`), 404)
    assert.equal(await status(t, `GET / HTTP/1.1\r\nHost: sub.app.test\r\n${close}\r\n`), 404)
    assert.equal(await status(t, `GET / HTTP/1.1\r\nHost: app.test.evil.test\r\n${close}\r\n`), 404)
    assert.equal(await status(t, `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n${close}\r\n`), 404)
  })

  it('an absolute-form target, a protocol-relative one, an asterisk and an authority-form one name a URL the client chose and are refused', async () => {
    const t = await rig()
    for (const target of ['http://evil.test/', 'http://app.test/', '//evil.test/x', '*', 'evil.test:443', 'ftp://x/y']) {
      const { text } = await t.raw(`GET ${target} HTTP/1.1\r\nHost: app.test\r\n${close}\r\n`)
      assert.ok(statusOf(text) === 400 || text === '', target)
    }
    assert.equal(t.asked.length, 0)
  })

  it('dot segments and encodings stay inside the path the provider is asked for', async () => {
    const t = await rig()
    await t.raw(`GET /a/../../etc/passwd HTTP/1.1\r\nHost: app.test\r\n${close}\r\n`)
    await t.raw(`GET /%2e%2e/%2e%2e/x HTTP/1.1\r\nHost: app.test\r\n${close}\r\n`)
    for (const r of t.asked) assert.ok(new URL(r.url).host === 'app.test' && new URL(r.url).pathname.startsWith('/'))
  })
})

describe('methods and upgrades', () => {
  it('TRACE, PUT, DELETE, PATCH and OPTIONS are 405 by default; CONNECT and an unknown method never reach the provider', async () => {
    const t = await rig()
    for (const m of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) assert.equal(await status(t, `${m} / HTTP/1.1\r\nHost: app.test\r\nContent-Length: 0\r\n${close}\r\n`), 405, m)
    const trace = await status(t, `TRACE / HTTP/1.1\r\nHost: app.test\r\n${close}\r\n`)
    assert.ok(trace === 405 || trace === 400, 'TRACE is refused (by the parser or the ingress)')
    const connect = await t.raw('CONNECT app.test:443 HTTP/1.1\r\nHost: app.test:443\r\n\r\n')
    assert.ok(statusOf(connect.text) === 405 || connect.text === '')
    const odd = await t.raw(`FOO / HTTP/1.1\r\nHost: app.test\r\n${close}\r\n`)
    assert.ok(statusOf(odd.text) >= 400 || odd.text === '')
    assert.equal(t.asked.length, 0)
  })

  it('a WebSocket upgrade is a 426 with a sentence, and nothing is bridged', async () => {
    const t = await rig()
    const { text } = await t.raw(`GET /ws HTTP/1.1\r\nHost: app.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`, { until: (b) => b.includes('\r\n\r\n') && b.includes('WebSocket') })
    assert.equal(statusOf(text), 426)
    assert.match(text, /WebSocket/)
    assert.equal(t.asked.length, 0)
  })

  it('an Upgrade header on a plain request is refused too (h2c and friends)', async () => {
    const t = await rig()
    assert.equal(await status(t, `GET / HTTP/1.1\r\nHost: app.test\r\nUpgrade: h2c\r\nConnection: Upgrade, HTTP2-Settings\r\nHTTP2-Settings: AAMAAABkAAQAAP__\r\n${close}\r\n`), 426)
  })

  it('Expect: 100-continue is not forwarded to the provider', async () => {
    const t = await rig({ ingress: { methods: ['GET', 'POST'] } })
    const { text } = await t.raw(`POST / HTTP/1.1\r\nHost: app.test\r\nExpect: 100-continue\r\nContent-Length: 2\r\n${close}\r\nab`)
    assert.ok([100, 200].includes(statusOf(text)))
    assert.equal(t.asked[0]?.headers.expect, undefined)
  })
})

describe('what the provider is never told', () => {
  it('cookies, credentials and proxy headers from a client stop at the ingress', async () => {
    const t = await rig()
    await t.raw(`GET / HTTP/1.1\r\nHost: app.test\r\nCookie: sid=secret\r\nAuthorization: Bearer secret\r\nProxy-Authorization: Basic x\r\nX-Real-IP: 1.2.3.4\r\nVia: 1.1 x\r\nAccept: text/html\r\n${close}\r\n`)
    assert.deepEqual(Object.keys(t.asked[0].headers).sort(), ['accept'])
  })
})
