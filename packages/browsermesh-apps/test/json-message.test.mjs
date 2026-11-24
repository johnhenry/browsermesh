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
