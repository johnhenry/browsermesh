// The consumer: its socket, half-close, backpressure and the bound on what a slow reader makes anyone hold; the netway backend;
// and what it does when it meets a provider that is not honest.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { VirtualNetwork, ConnectionRefusedError, StreamSocket } from '@johnhenry/browsermesh-netway'
import { connectEgress, createMeshEgress, EgressError, EGRESS_SCOPES, EgressBackend, CONSUMER_LIMIT_DEFAULTS } from '../src/index.mjs'
import { threePods, grant, rig, simNetwork, startOrigin, echoOrigin, readAll, text, bytes, until, outcome, patternChunk, patternByte, PUBLIC, deferred } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
const code = (c) => (e) => e instanceof EgressError && e.code === c
const KiB = 1024
const MiB = 1024 * 1024

describe('the socket a consumer gets', () => {
  it('is a netway StreamSocket: write, read, end (half-close) and close', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const socket = await link.connect('pkg.test', 443)
    assert.ok(socket instanceof StreamSocket)
    await socket.write(bytes('one'))
    assert.equal(text(await socket.read()), 'one')
    await socket.end()
    assert.equal(await socket.read(), null)
  })

  it('the destination half-closing (it has finished sending) leaves the consumer free to send: half-close both ways', async () => {
    const received = deferred()
    const origin = await startOrigin((s) => {
      s.write('greeting')
      s.end() // finished sending; still reading
      const parts = []
      s.on('data', (d) => parts.push(d))
      s.on('end', () => received.resolve(Buffer.concat(parts).toString()))
    })
    const { link } = await rig(cleanups, { origin, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const socket = await link.connect('pkg.test', 443)
    assert.equal(text(await socket.read()), 'greeting')
    assert.equal(await socket.read(), null, 'the end of what the destination sends')
    await socket.write(bytes('still here'))
    await socket.end()
    assert.equal(await received.promise, 'still here')
  })

  it('the consumer half-closing leaves the destination free to keep sending', async () => {
    const origin = await startOrigin((s) => {
      s.on('end', () => { s.write('after your end'); s.end() })
    })
    const { link } = await rig(cleanups, { origin, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const socket = await link.connect('pkg.test', 443)
    await socket.end()
    assert.equal(text(await readAll(socket)), 'after your end')
  })

  it('close() ends both directions and frees the provider\'s slot', async () => {
    const { link, provider } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const socket = await link.connect('pkg.test', 443)
    await socket.close()
    await until(() => provider.stats().closed === 1 && provider.stats().open === 0, 'the connection to end')
    await until(() => link.stats().open === 0, 'the link to forget it')
  })

  it('destroy() ends the connection at once, and the provider stops dialling nothing more', async () => {
    const { link, provider, origin } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const socket = await link.connect('pkg.test', 443)
    socket.destroy(new Error('no thanks'))
    await until(() => provider.stats().open === 0, 'the connection to end')
    await until(() => origin.sockets.size === 0, 'the origin to see it close')
  })

  it('a destination that resets the connection fails the socket, not hangs it', async () => {
    const origin = await startOrigin((s) => { s.resetAndDestroy ? s.resetAndDestroy() : s.destroy() })
    const { link } = await rig(cleanups, { origin, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const socket = await link.connect('pkg.test', 443)
    const e = await outcome(socket)
    assert.ok(e === null || (e instanceof EgressError && e.code === 'connection-ended'), String(e))
    await until(async () => { try { await socket.write(bytes('x')); return false } catch { return true } }, 'a write to fail')
  })

  it('an aborted signal during connect ends the attempt', async () => {
    const gate = deferred()
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const net = simNetwork({ names: { 'pkg.test': [PUBLIC] }, origins: { [`${PUBLIC}:443`]: origin.port } })
    const { link, provider } = await rig(cleanups, { origin, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], egress: { dial: async (r) => { await gate.promise; return net.dial(r) } } })
    const ac = new AbortController()
    const attempt = link.connect('pkg.test', 443, { signal: ac.signal }).catch((e) => e)
    await until(() => provider.stats().requests === 1, 'the request to arrive')
    ac.abort()
    const e = await attempt
    assert.ok(e instanceof EgressError && e.code === 'aborted', String(e))
    gate.resolve()
    await assert.rejects(link.connect('pkg.test', 443, { signal: ac.signal }), code('aborted'))
  })

  it('closing the link ends every socket with link-closed, and nothing more can be opened', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443), EGRESS_SCOPES.dns('pkg.test')] })
    const a = await link.connect('pkg.test', 443)
    await link.close()
    const e = await outcome(a)
    assert.ok(e instanceof EgressError && e.code === 'link-closed', String(e))
    await assert.rejects(link.connect('pkg.test', 443), code('link-closed'))
    await assert.rejects(link.lookup('pkg.test'), code('link-closed'))
    assert.equal(link.closed, true)
  })

  it('limits.maxConnections bounds one link, and every limit is validated', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)], link: { limits: { maxConnections: 2 } } })
    const a = await link.connect('pkg.test', 443)
    const b = await link.connect('pkg.test', 443)
    await assert.rejects(link.connect('pkg.test', 443), code('too-many-connections'))
    await a.close()
    await b.close()
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    await assert.rejects(connectEgress(pods.c, pods.provider.podId, { limits: { nope: 1 } }), TypeError)
    await assert.rejects(connectEgress(pods.c, pods.provider.podId, { limits: { maxConnections: 0 } }), TypeError)
    await assert.rejects(connectEgress({}, pods.provider.podId), TypeError)
    await assert.rejects(connectEgress(pods.c, ''), TypeError)
    assert.deepEqual(Object.keys(CONSUMER_LIMIT_DEFAULTS).sort(), ['maxConnections', 'maxViolations', 'openTimeoutMs', 'requestTimeoutMs', 'socketWindowBytes', 'streamWindowBytes'])
  })
})

describe('backpressure, end to end, with a bound', () => {
  it('a consumer that stops reading stops the destination: what is held anywhere is bounded', async () => {
    const total = 32 * MiB
    const origin = await startOrigin((s) => {
      let at = 0
      const pump = () => {
        while (at < total) {
          const n = Math.min(64 * KiB, total - at)
          const ok = s.write(Buffer.from(patternChunk(at, n)))
          at += n
          origin.written = at
          if (!ok) { s.once('drain', pump); return }
        }
        s.end()
      }
      pump()
    })
    origin.written = 0
    const { link, provider } = await rig(cleanups, { origin, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const socket = await link.connect('pkg.test', 443)
    // Do not read. The socket's window fills, then the stream's credit runs out, then the provider pauses the origin.
    await until(() => socket.readableLength >= socket.windowBytes - 64 * KiB && provider.stats().bytesDown > socket.windowBytes, 'the consumer\'s window to fill')
    await new Promise((r) => setTimeout(r, 150))
    const moved = provider.stats().bytesDown
    const held = socket.readableLength
    assert.ok(held <= socket.windowBytes, `the socket holds at most its window (${held})`)
    // socket window + the stream's window + one chunk in each stage: well under 1 MiB, against 32 MiB offered.
    assert.ok(moved <= 1 * MiB, `the provider moved ${moved} bytes with nobody reading`)
    assert.ok(origin.written < total, 'the origin was stopped, not drained')
    // Now read it all: every byte, in order.
    let got = 0
    for (;;) {
      const chunk = await socket.read()
      if (chunk === null) break
      for (let i = 0; i < chunk.length; i += 4099) assert.equal(chunk[i], patternByte(got + i), `byte ${got + i}`)
      got += chunk.length
    }
    assert.equal(got, total)
  })

  it('a destination that stops reading stops the consumer\'s writes: the writer waits, nothing piles up', async () => {
    const total = 64 * MiB
    const origin = await startOrigin((s) => { s.pause() })
    const { link, provider } = await rig(cleanups, { origin, grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const socket = await link.connect('pkg.test', 443)
    let written = 0
    let finished = false
    ;(async () => {
      try { for (let at = 0; at < total; at += 64 * KiB) { await socket.write(patternChunk(at, 64 * KiB)); written = at + 64 * KiB } finished = true } catch { /* ended */ }
    })()
    await until(() => provider.stats().bytesUp > 0, 'bytes to flow')
    let last = -1
    await until(async () => { const now = provider.stats().bytesUp; const same = now === last; last = now; await new Promise((r) => setTimeout(r, 60)); return same }, 'the flow to stop')
    assert.equal(finished, false)
    assert.ok(provider.stats().bytesUp < total / 2, `the provider took ${provider.stats().bytesUp} of ${total}`)
    assert.ok(socket.writableLength <= 2 * MiB, `the socket's own pending bytes (${socket.writableLength}) stay bounded`)
    void written
    socket.destroy()
  })
})

describe('the netway backend', () => {
  it('is a Backend: connect and resolve, nothing else', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443), EGRESS_SCOPES.dns('pkg.test')] })
    const backend = link.asBackend()
    assert.ok(backend instanceof EgressBackend)
    assert.equal(backend.link, link)
    const socket = await backend.connect('pkg.test', 443)
    await socket.end()
    assert.deepEqual(await backend.resolve('pkg.test'), [PUBLIC])
    await assert.rejects(backend.resolve('pkg.test', 'AAAA'), code('bad-request'))
    await assert.rejects(backend.listen(80), /not implemented/)
    await assert.rejects(backend.sendDatagram('pkg.test', 53, new Uint8Array(1)), /not implemented/)
    await backend.close()
    assert.equal(link.closed, false, 'closing the backend leaves the caller\'s link alone')
  })

  it('maps a refused connection to netway\'s ConnectionRefusedError, and keeps every other refusal as it is', async () => {
    const { link } = await rig(cleanups, { names: { 'closed.test': ['93.184.216.35'] }, grants: [EGRESS_SCOPES.tcp('closed.test', 443)] })
    const backend = link.asBackend()
    const refused = await backend.connect('closed.test', 443).catch((e) => e)
    assert.ok(refused instanceof ConnectionRefusedError && refused.cause?.code === 'connect-failed')
    const net = new VirtualNetwork()
    net.addBackend('tcp', backend)
    await assert.rejects(net.connect('tcp://pkg.test:443'), code('no-grant'))
  })

  it('refuses to be a provider\'s dial', async () => {
    const { link } = await rig(cleanups, { grants: [] })
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const backend = link.asBackend()
    assert.throws(() => createMeshEgress({ service: pods.p, registry: pods.provider.registry, dial: backend.connect, resolve: async () => [], unattended: true }), /egress consumer/)
  })
})

describe('chaining, from the consumer\'s side', () => {
  it('a mesh pod id (or the provider itself) is not a destination, in connect, lookup or the backend', async () => {
    const { link, pods, net } = await rig(cleanups, { grants: ['egress:*'] })
    for (const host of [pods.provider.podId, pods.stranger.podId, pods.consumer.podId, 'A'.repeat(43)]) {
      await assert.rejects(link.connect(host, 443), code('chaining-refused'), host)
      await assert.rejects(link.lookup(host), code('chaining-refused'), host)
      await assert.rejects(link.asBackend().connect(host, 443), code('chaining-refused'), host)
    }
    assert.deepEqual(net.calls.dials, [])
  })

  it('a destination is validated before anything is sent', async () => {
    const { link, provider } = await rig(cleanups, { grants: [] })
    for (const [h, p] of [['', 443], ['a b', 443], ['host:443', 80], ['example.com', 0], ['example.com', 70000], ['127.1', 80], [5, 80], ['example.com', '80']]) {
      await assert.rejects(link.connect(h, p), code('bad-destination'), `${h}:${p}`)
    }
    await assert.rejects(link.lookup('203.0.113.1'), code('bad-destination'))
    assert.equal(provider.stats().requests, 0, 'none of it reached the provider')
  })

  it('a host in capitals is the same host', async () => {
    const { link } = await rig(cleanups, { grants: [EGRESS_SCOPES.tcp('pkg.test', 443)] })
    const socket = await link.connect('PKG.Test', 443)
    await socket.end()
  })
})

describe('what a consumer does about a provider that is not what it should be', () => {
  /** A provider written by hand on the real protocol host: `serve(channel)` is the whole of its behaviour. */
  async function hostile(serve, linkOptions) {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    pods.p.api.serveProtocol('egress', serve)
    pods.provider.registry.grantCapabilities(pods.consumer.podId, ['protocol:egress:open'])
    const link = await connectEgress(pods.c, pods.provider.podId, linkOptions)
    cleanups.push(() => link.close())
    return { pods, link }
  }

  it('an answer that is not an answer is `bad-answer`', async () => {
    for (const answer of [null, 'ok', 42, {}, { ok: 'yes' }, [], undefined]) {
      const { link } = await hostile((ch) => { ch.onRequest('connect', () => answer); ch.onRequest('resolve', () => answer) })
      await assert.rejects(link.connect('a.test', 443), (e) => e.code === 'bad-answer' || e.code === 'unknown', JSON.stringify(answer))
      await assert.rejects(link.lookup('a.test'), (e) => e.code === 'bad-answer' || e.code === 'unknown', JSON.stringify(answer))
      await link.close()
    }
  })

  it('a refusal it does not know is `unknown`, and what the refusal carries is only what the code defines', async () => {
    const { link } = await hostile((ch) => {
      ch.onRequest('connect', (p) => ({ ok: false, code: p.host === 'a.test' ? 'made-up' : p.host === 'b.test' ? 'budget-exceeded' : p.host === 'd.test' ? '__proto__' : 'destination-refused', budget: '<script>x</script>', addressClass: 'a'.repeat(500), detail: 'x', reason: 'y', message: 'words from the provider' }))
    })
    const a = await link.connect('a.test', 443).catch((e) => e)
    assert.ok(a.code === 'unknown' && a.budget === undefined && a.addressClass === undefined)
    const b = await link.connect('b.test', 443).catch((e) => e)
    assert.ok(b.code === 'budget-exceeded' && b.budget === undefined)
    const c = await link.connect('c.test', 443).catch((e) => e)
    assert.ok(c.code === 'destination-refused' && c.addressClass === undefined)
    const d = await link.connect('d.test', 443).catch((e) => e)
    assert.equal(d.code, 'unknown')
    assert.ok(!/words from the provider/.test(a.message + b.message + c.message), 'a provider\'s own words are not repeated')
  })

  it('an ok with no stream behind it times out: provider-timeout, and nothing is left registered', async () => {
    const { link } = await hostile((ch) => { ch.onRequest('connect', () => ({ ok: true })) }, { limits: { requestTimeoutMs: 80 } })
    await assert.rejects(link.connect('a.test', 443), code('provider-timeout'))
    assert.equal(link.stats().open, 0)
  })

  it('addresses that are not IPv4 strings, too many of them, or none, are `bad-answer`', async () => {
    for (const addresses of [['not an address'], ['1.2.3.256'], ['::1'], [], Array.from({ length: 17 }, (_, i) => `1.2.3.${i}`), 'x', undefined, [1]]) {
      const { link } = await hostile((ch) => { ch.onRequest('resolve', () => ({ ok: true, addresses })) })
      await assert.rejects(link.lookup('a.test'), code('bad-answer'), JSON.stringify(addresses))
      await link.close()
    }
    const { link } = await hostile((ch) => { ch.onRequest('resolve', () => ({ ok: true, addresses: ['1.2.3.4', '5.6.7.8'] })) })
    assert.deepEqual(await link.lookup('a.test'), ['1.2.3.4', '5.6.7.8'])
  })

  it('a stream the provider opens for a connection nobody asked for is refused', async () => {
    const { createStreamLayer } = await import('@johnhenry/browsermesh-apps/protocol-stream')
    const refused = deferred()
    const { link } = await hostile((ch) => {
      const streams = createStreamLayer(ch, {})
      ch.onRequest('connect', async () => { refused.resolve(streams.open({ cid: 999, kind: 'down' }).catch((e) => e)); return { ok: false, code: 'no-grant' } })
    })
    await link.connect('a.test', 443).catch(() => {})
    const e = await refused.promise
    assert.ok(e instanceof Error, 'the open was refused')
  })

  it('a provider that breaks the stream rules past the budget gets the link cut', async () => {
    const { createStreamLayer } = await import('@johnhenry/browsermesh-apps/protocol-stream')
    const { link } = await hostile((ch) => {
      createStreamLayer(ch, {})
      ch.onRequest('connect', async () => {
        // streams nobody asked for (each refused), and a stream id used twice (the layer's own violation count)
        for (let i = 0; i < 10; i++) ch.request('stream.open', { id: 100 + i, meta: {} }).catch(() => {})
        for (let i = 0; i < 10; i++) ch.request('stream.open', { id: 1, meta: { cid: 1, kind: 'down' } }).catch(() => {})
        return { ok: false, code: 'no-grant' }
      })
    }, { limits: { maxViolations: 3 } })
    await link.connect('a.test', 443).catch(() => {})
    await until(() => link.closed, 'the link to be cut')
  })

  it('an end notice with a reason it does not know is not repeated to the caller', async () => {
    const { createStreamLayer } = await import('@johnhenry/browsermesh-apps/protocol-stream')
    const { link } = await hostile((ch) => {
      const streams = createStreamLayer(ch, {})
      streams.onStream(() => {})
      ch.onRequest('connect', async (p) => {
        const down = await streams.open({ cid: p.cid, kind: 'down' })
        setTimeout(() => { ch.notify('end', { cid: p.cid, reason: 'a reason nobody defined' }); down.abort('x') }, 20)
        return { ok: true }
      })
    })
    const socket = await link.connect('a.test', 443)
    const e = await outcome(socket)
    assert.ok(e instanceof EgressError && e.code === 'connection-ended')
    assert.ok(e.reason === undefined && !/nobody defined/.test(e.message))
  })

  it('a channel bound to a pod other than the one named is refused, and a pod that does not serve egress or has not granted it is named', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    pods.p.api.serveProtocol('egress', () => {})
    pods.provider.registry.grantCapabilities(pods.consumer.podId, ['protocol:egress:open'])
    const mismatched = { api: { openProtocol: async (_peer, name, opts) => pods.c.api.openProtocol(pods.provider.podId, name, opts) } }
    await assert.rejects(connectEgress(mismatched, pods.stranger.podId), code('provider-pin-mismatch'))
    await assert.rejects(connectEgress(pods.c, pods.stranger.podId), (e) => e instanceof EgressError && e.code.startsWith('provider-'))
    const fresh = await threePods()
    cleanups.push(() => fresh.teardown())
    await assert.rejects(connectEgress(fresh.c, fresh.provider.podId), code('provider-not-authorized'))
    fresh.provider.registry.grantCapabilities(fresh.consumer.podId, ['protocol:egress:open'])
    await assert.rejects(connectEgress(fresh.c, fresh.provider.podId), code('provider-no-egress'))
  })
})
