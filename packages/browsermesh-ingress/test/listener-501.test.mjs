// #471: a method token Node's HTTP parser does not know is answered 501 by the listener, and the answer says what the listener can carry.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { httpRig, statusOf } from './helpers/http.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

describe('the listener and a method token Node does not know (#471)', () => {
  it('answers 501 with a body that says which methods the listener carries and that handle() carries any token', async () => {
    const t = await httpRig({ handler: () => { throw new Error('must not run') } }, cleanups)
    const r = await t.raw('X-Custom.Verb / HTTP/1.1\r\nHost: app.test\r\nConnection: close\r\n\r\n')
    assert.equal(statusOf(r.text), 501)
    assert.match(r.text, /x-browsermesh-ingress-reason: method-not-implemented/i)
    assert.match(r.text, /content-type: text\/plain/i)
    const length = Number(/content-length: (\d+)/i.exec(r.text)?.[1])
    const body = r.text.split('\r\n\r\n')[1]
    assert.ok(length > 0 && body.length === length, 'a body whose Content-Length is right')
    assert.match(body, /http\.METHODS/)
    assert.match(body, /handle\(\)/)
    assert.match(body, /any RFC 9110 method token/)
    assert.match(body, /GET/)
    assert.match(body, /PROPFIND/)
  })

  it('still carries every standard method Node knows (http.METHODS minus CONNECT, TRACE)', async () => {
    const seen = []
    const t = await httpRig({ handler: (request) => { seen.push(request.method); return new Response('ok') } }, cleanups)
    const sent = http.METHODS.filter((m) => !['CONNECT', 'TRACE', 'HEAD'].includes(m))
    for (const method of sent) {
      const r = await t.raw(`${method} / HTTP/1.1\r\nHost: app.test\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
      assert.equal(statusOf(r.text), 200, method)
    }
    assert.deepEqual(seen, sent)
  })
})
