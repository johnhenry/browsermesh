// Half-close through the real Node dial (`nodeDialer`, on wsh's address guard) and real TCP origins that keep their own half open.
//
// The shape of wsh issue 271 (a connection ended about a second after one side finished sending, so a late answer was lost),
// asked of the egress protocol's own stream handling: the consumer finishes sending and keeps reading, and the destination
// answers seconds later. The bounds are the provider's: a connection that nothing moves on for `idleMs` is ended and its
// slot freed, whether or not it was half-closed.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { nodeDialer } from '../src/node.mjs'
import { EGRESS_SCOPES } from '../src/index.mjs'
import { rig, startOrigin, readAll, text, bytes, until, deferred, outcome, patternChunk, patternByte } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
const MiB = 1024 * 1024
const LATE_MS = 2000

/** A rig whose provider dials with the real guard, to `pkg.test`, which this machine's loopback answers for. */
async function realDial({ origin, limits, grants } = {}) {
  const lookup = async () => ['127.0.0.1']
  return rig(cleanups, {
    origin,
    grants: grants ?? [EGRESS_SCOPES.tcp('pkg.test', origin.port)],
    egress: { ...nodeDialer({ lookup, allowPrivate: ['127.0.0.1/32'] }), ...(limits ? { limits } : {}) },
  })
}

describe('half-close through the Node dial', () => {
  it('an answer that arrives two seconds after the consumer finished sending is delivered', { timeout: 20_000 }, async () => {
    const origin = await startOrigin((s) => {
      s.on('end', () => setTimeout(() => s.end('done\n'), LATE_MS))
      s.resume()
    })
    const { link } = await realDial({ origin })
    const socket = await link.connect('pkg.test', origin.port)
    await socket.write(bytes('request'))
    await socket.end()
    assert.equal(text(await readAll(socket)), 'done\n')
  })

  it('a large answer after the half-close arrives whole, to a consumer that starts reading late', { timeout: 30_000 }, async () => {
    const size = 3 * MiB
    const origin = await startOrigin((s) => {
      s.on('end', () => s.end(Buffer.from(patternChunk(0, size))))
      s.resume()
    })
    const { link } = await realDial({ origin })
    const socket = await link.connect('pkg.test', origin.port)
    await socket.end()
    await new Promise((r) => setTimeout(r, 300)) // the answer is on its way before anyone reads
    const got = await readAll(socket, 20_000)
    assert.equal(got.length, size)
    for (let i = 0; i < size; i += 4099) assert.equal(got[i], patternByte(i), `byte ${i}`)
    assert.equal(got[size - 1], patternByte(size - 1))
  })

  it('a destination that finishes first still receives what the consumer sends afterwards', { timeout: 20_000 }, async () => {
    const received = deferred()
    const origin = await startOrigin((s) => {
      const parts = []
      s.on('data', (d) => parts.push(d))
      s.on('end', () => { received.resolve(Buffer.concat(parts).toString()); s.end() })
      s.write('greeting')
      s.end() // finished sending, still reading
    })
    const { link } = await realDial({ origin })
    const socket = await link.connect('pkg.test', origin.port)
    assert.equal(text(await readAll(socket)), 'greeting')
    await socket.write(bytes('late reply'))
    await socket.end()
    assert.equal(await received.promise, 'late reply')
  })

  it('both sides finishing ends the connection and frees the slot at once, with no timer involved', { timeout: 20_000 }, async () => {
    const origin = await startOrigin((s) => { s.on('end', () => s.end('bye')); s.resume() })
    // a cap of one connection, and an idle bound that would take an hour: only the end of both sides can free the slot
    const { link, provider } = await realDial({ origin, limits: { maxConnectionsPerConsumer: 1, idleMs: 3_600_000 } })
    const first = await link.connect('pkg.test', origin.port)
    await first.end()
    assert.equal(text(await readAll(first)), 'bye')
    await until(() => provider.stats().open === 0 && provider.stats().closed === 1, 'the provider to free the slot')
    const second = await link.connect('pkg.test', origin.port)
    await second.end()
    assert.equal(text(await readAll(second)), 'bye')
  })

  it('a consumer that half-closes and never reads is ended by the idle bound, and the slot is freed', { timeout: 20_000 }, async () => {
    const origin = await startOrigin((s) => { s.resume() }) // never answers, never ends
    const { link, provider } = await realDial({ origin, limits: { maxConnectionsPerConsumer: 1, idleMs: 300 } })
    const socket = await link.connect('pkg.test', origin.port)
    await socket.end()
    const e = await outcome(socket)
    assert.ok(e && e.reason === 'idle', String(e))
    await until(() => provider.stats().open === 0, 'the slot to be freed')
    const again = await link.connect('pkg.test', origin.port)
    await again.close()
  })

  it('a connection that is slow to be answered is not ended while bytes move', { timeout: 20_000 }, async () => {
    const origin = await startOrigin((s) => {
      s.on('end', () => {
        let n = 0
        const timer = setInterval(() => { s.write('.'); if (++n === 4) { clearInterval(timer); s.end() } }, 200)
      })
      s.resume()
    })
    const { link } = await realDial({ origin, limits: { idleMs: 500 } })
    const socket = await link.connect('pkg.test', origin.port)
    await socket.end()
    assert.equal(text(await readAll(socket)), '....')
  })
})
