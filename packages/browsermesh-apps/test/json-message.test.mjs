import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { StreamSocket } from '@johnhenry/browsermesh-netway'
import { readJsonMessage } from '../src/internal/json-message.mjs'

const enc = new TextEncoder()

describe('readJsonMessage', () => {
  it('reassembles one message larger than the receive window', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 1024 })
    const doc = { data: 'x'.repeat(5000), n: 1 }
    const writing = a.write(enc.encode(JSON.stringify(doc)))
    const msg = await readJsonMessage(b)
    await writing
    assert.deepEqual(msg.value, doc)
  })

  it('reassembles a message whose size is an exact multiple of the window', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 1024 })
    const body = JSON.stringify({ d: 'y'.repeat(2048 - 8) })
    assert.equal(body.length, 2048)
    const writing = a.write(enc.encode(body))
    const msg = await readJsonMessage(b)
    await writing
    assert.equal(msg.value.d.length, 2040)
  })

  it('reports invalid JSON without waiting for more bytes', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 1024 })
    await a.write(enc.encode('{not json'))
    const msg = await readJsonMessage(b)
    assert.equal(msg.eof, false)
    assert.ok(msg.error)
  })

  it('reads one message per write on a socket with no window', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 0 })
    await a.write(enc.encode('{"a":1}'))
    await a.write(enc.encode('{"b":2}'))
    assert.deepEqual((await readJsonMessage(b)).value, { a: 1 })
    assert.deepEqual((await readJsonMessage(b)).value, { b: 2 })
  })

  it('reports eof, and an error when the peer closes mid-message', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 4 })
    await a.close()
    assert.equal((await readJsonMessage(b)).eof, true)

    const [c, d] = StreamSocket.createPair({ windowBytes: 4 })
    const reading = readJsonMessage(d)
    await c.write(enc.encode('{"abcdefgh":'))
    await c.end()
    const msg = await reading
    assert.equal(msg.eof, false)
    assert.match(msg.error.message, /middle of a message/)
  })
})

describe('readJsonMessage: bounded size, parsed once', () => {
  it('a message of many pieces is parsed once, not after every piece', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 1024 })
    const doc = { data: 'x'.repeat(50_000) }
    const writing = a.write(enc.encode(JSON.stringify(doc)))
    const msg = await readJsonMessage(b)
    await writing
    assert.deepEqual(msg.value, doc)
    assert.ok(msg.stats.pieces >= 49, `${msg.stats.pieces} pieces`)
    assert.equal(msg.stats.parseAttempts, 1)
  })

  it('exact-window and exact-multiple messages parse', async () => {
    for (const windows of [1, 2, 7]) {
      const [a, b] = StreamSocket.createPair({ windowBytes: 1024 })
      const body = JSON.stringify({ d: 'z'.repeat(1024 * windows - 8) })
      assert.equal(body.length, 1024 * windows)
      const writing = a.write(enc.encode(body))
      const msg = await readJsonMessage(b)
      await writing
      assert.equal(msg.value.d.length, 1024 * windows - 8, `${windows} window(s)`)
      assert.equal(msg.stats.parseAttempts, 1)
    }
  })

  it('braces, quotes and escapes inside strings do not end or extend a message early', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 16 })
    const doc = { s: '}{]["\\"} \\\\ }}}', t: 'é中', n: [1, { x: '"' }] }
    const writing = a.write(enc.encode(JSON.stringify(doc)))
    const msg = await readJsonMessage(b)
    await writing
    assert.deepEqual(msg.value, doc)
    assert.equal(msg.stats.parseAttempts, 1)
  })

  it('an endless stream of full windows is refused at the bound with bounded memory', async () => {
    const window = 1024
    const [a, b] = StreamSocket.createPair({ windowBytes: window })
    // Opens a document and never closes it.
    const endless = (async () => {
      await a.write(enc.encode(`{"d":"${'y'.repeat(window - 6)}`))
      try { for (;;) await a.write(enc.encode('y'.repeat(window))) } catch { /* the reader closed */ }
    })()
    const msg = await readJsonMessage(b, { maxBytes: 10 * window })
    assert.equal(msg.eof, false)
    assert.equal(msg.tooLarge, true)
    assert.match(msg.error.message, /larger than 10240 bytes/)
    assert.ok(msg.stats.bytes <= 10 * window + window, `${msg.stats.bytes} bytes held at most`)
    assert.equal(msg.stats.parseAttempts, 0, 'nothing was parsed on the way')
    await b.close()
    await a.close().catch(() => {})
    await endless
  })

  it('the default bound is large enough for the services\' own messages and is overridable', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 256 * 1024 })
    const big = { data: 'q'.repeat(1_200_000) }
    const writing = a.write(enc.encode(JSON.stringify(big)))
    assert.equal((await readJsonMessage(b)).value.data.length, 1_200_000)
    await writing
    const [c, d] = StreamSocket.createPair({ windowBytes: 1024 })
    const writing2 = c.write(enc.encode(JSON.stringify({ data: 'q'.repeat(5000) })))
    const refused = await readJsonMessage(d, { maxBytes: 2048 })
    assert.equal(refused.tooLarge, true)
    await d.close()
    await writing2.catch(() => {})
  })

  it('a message exactly at the bound is accepted, one byte over is refused', async () => {
    const exact = JSON.stringify({ d: 'e'.repeat(2048 - 8) })
    assert.equal(exact.length, 2048)
    const [a, b] = StreamSocket.createPair({ windowBytes: 512 })
    const writing = a.write(enc.encode(exact))
    assert.equal((await readJsonMessage(b, { maxBytes: 2048 })).value.d.length, 2040)
    await writing
    const [c, d] = StreamSocket.createPair({ windowBytes: 512 })
    const writing2 = c.write(enc.encode(JSON.stringify({ d: 'e'.repeat(2048 - 8 + 1) })))
    const refused = await readJsonMessage(d, { maxBytes: 2048 })
    assert.equal(refused.tooLarge, true)
    await d.close()
    await writing2.catch(() => {})
  })

  it('a message with no window is not subject to reassembly, but the bound still applies to it', async () => {
    const [a, b] = StreamSocket.createPair({ windowBytes: 0 })
    await a.write(enc.encode(JSON.stringify({ d: 'w'.repeat(3000) })))
    const msg = await readJsonMessage(b, { maxBytes: 100 })
    assert.equal(msg.tooLarge, true)
  })
})
