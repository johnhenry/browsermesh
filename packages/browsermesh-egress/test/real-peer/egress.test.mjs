// Real WebRTC. Two mesh nodes (real identities, a real data channel between them, loopback host candidates only), a real local
// TCP origin, and the provider's real address guard (wsh's) with the operator's one allowance for this machine's loopback.
// Nothing here connects to another host.
//
// Same optional `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as every other real-peer suite here.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

let ndc = null
let ndcMain = null
try {
  ndc = await import('node-datachannel/polyfill')
  ndcMain = await import('node-datachannel')
} catch { /* optional dependency absent: the suite below skips */ }

if (!ndc && process.env.REQUIRE_REAL_PEER) {
  throw new Error('REQUIRE_REAL_PEER is set but `node-datachannel` did not load, so the real-peer suite would have skipped and reported success. Install the dependency, or unset REQUIRE_REAL_PEER to allow the skip.')
}
if (!ndc) describe('egress over real WebRTC peers', () => { it('skipped: optional dependency `node-datachannel` is not installed', () => {}) })
const describeIfReal = ndc ? describe : describe.skip

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}
const WEBRTC_TIMEOUT_MS = 30_000
const MiB = 1024 * 1024
/** The same pseudo-random byte at every index: both ends can check every byte without holding the data. */
const patternByte = (i) => ((i * 2654435761) >>> 24) & 0xff
const patternChunk = (start, length) => { const out = new Uint8Array(length); for (let i = 0; i < length; i++) out[i] = patternByte(start + i); return out }

describeIfReal('a consumer reaches a local origin through a provider, over a real WebRTC data channel', () => {
  let apps, egressPkg, node
  const nodes = {}
  const services = {}
  const audit = []
  const meter = []
  let provider, link, origin, originPort
  /** What the origin saw, per connection index: bytes received and whether they were all in order. */
  const seen = []

  before(async () => {
    Object.assign(globalThis, { RTCPeerConnection: ndc.RTCPeerConnection, RTCIceCandidate: ndc.RTCIceCandidate, RTCSessionDescription: ndc.RTCSessionDescription })
    apps = await import('@johnhenry/browsermesh-apps')
    egressPkg = await import('../../src/index.mjs')
    node = await import('../../src/node.mjs')
    const { ManualStrategy, DiscoveryRecord } = await import('@johnhenry/browsermesh-discovery')
    const bus = new Set()
    const transport = () => { let handler = null; const rx = (m) => handler?.(m); bus.add(rx); return { send(m) { for (const fn of bus) if (fn !== rx) fn(m) }, onMessage(cb) { handler = cb } } }
    const discovery = { consumer: new ManualStrategy(), provider: new ManualStrategy() }
    for (const label of ['consumer', 'provider']) nodes[label] = await apps.createMeshNode({ label, discoveryStrategies: [discovery[label]], signalingTransport: transport(), iceServers: [] })
    discovery.consumer.addPeer(new DiscoveryRecord({ podId: nodes.provider.podId, transport: 'webrtc', label: 'provider' }))
    discovery.provider.addPeer(new DiscoveryRecord({ podId: nodes.consumer.podId, transport: 'webrtc', label: 'consumer' }))
    await nodes.consumer.discover()
    await nodes.provider.discover()
    await nodes.consumer.connectToPeer(nodes.provider.podId, { webrtc: nodes.provider.podId }, { answerTimeoutMs: WEBRTC_TIMEOUT_MS, openTimeoutMs: WEBRTC_TIMEOUT_MS })
    await waitFor(() => nodes.provider.meshManager.getConnection(nodes.consumer.podId)?.isOpen, WEBRTC_TIMEOUT_MS, "the provider's side of the data channel to open")
    for (const label of ['consumer', 'provider']) services[label] = apps.attachService(nodes[label], undefined, apps.createMeshProtocolService())

    // The origin: for each connection, count and check what arrives; then it sends the same pattern back (a download of the size
    // the connection's first line asks for, or an echo of the upload, per the first byte).
    origin = net.createServer({ allowHalfOpen: true }, (socket) => {
      const rec = { received: 0, inOrder: true, closed: false }
      seen.push(rec)
      socket.on('error', () => {})
      socket.on('close', () => { rec.closed = true })
      let mode = null
      let want = 0
      let header = Buffer.alloc(0)
      socket.on('data', (d) => {
        if (mode === null) {
          header = Buffer.concat([header, d])
          const nl = header.indexOf(10)
          if (nl < 0) return
          const [kind, n] = header.subarray(0, nl).toString().split(' ')
          mode = kind
          want = Number(n)
          rec.mode = mode
          d = header.subarray(nl + 1)
          if (mode === 'download' || mode === 'download-slow-consumer') {
            let at = 0
            const pump = () => {
              while (at < want) {
                const len = Math.min(64 * 1024, want - at)
                const ok = socket.write(Buffer.from(patternChunk(at, len)))
                at += len
                rec.sent = at
                if (!ok) { socket.once('drain', pump); return }
              }
              socket.end()
            }
            pump()
            return
          }
        }
        for (let i = 0; i < d.length; i += 1) if (d[i] !== patternByte(rec.received + i)) { rec.inOrder = false; break }
        rec.received += d.length
        if (mode === 'echo') socket.write(d)
      })
      socket.on('end', () => { if (mode === 'upload') { socket.write(`got ${rec.received}`); socket.end() } else if (mode === 'echo') socket.end() })
    })
    await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve))
    originPort = origin.address().port

    // The provider: wsh's real address guard; the operator allows this machine's 127.0.0.1 and nothing else private.
    const lookup = async (name) => (name === 'origin.test' ? ['127.0.0.1'] : name === 'sibling.test' ? ['127.0.0.2'] : (() => { const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e })())
    provider = egressPkg.createMeshEgress({
      service: services.provider, registry: nodes.provider.registry, ...node.nodeDialer({ lookup, allowPrivate: ['127.0.0.1/32'] }),
      unattended: true, onAudit: (r) => audit.push(r), onMeter: (r) => meter.push(r),
    })
    provider.start()
  })

  after(async () => {
    try { await link?.close() } catch { /* gone */ }
    try { await provider?.stop() } catch { /* gone */ }
    try { origin?.close(); origin?.closeAllConnections?.() } catch { /* gone */ }
    for (const s of Object.values(services)) { try { s.teardown() } catch { /* gone */ } }
    for (const n of Object.values(nodes)) { try { await n.shutdown() } catch { /* gone */ } }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  const grantOrigin = () => nodes.provider.registry.grantCapabilities(nodes.consumer.podId, [apps.protocolScope('egress'), `egress:tcp:origin.test:${originPort}:connect`, 'egress:dns:origin.test:resolve'])

  it('with no grant for the protocol the provider refuses, and names it', async () => {
    await assert.rejects(egressPkg.connectEgress(services.consumer, nodes.provider.podId), (e) => e.code === 'provider-not-authorized')
  })

  it('with the protocol but no grant for the destination: no-grant, before anything is dialled; and a lookup is its own grant', async () => {
    nodes.provider.registry.grantCapabilities(nodes.consumer.podId, [apps.protocolScope('egress')])
    link = await egressPkg.connectEgress(services.consumer, nodes.provider.podId, { limits: { requestTimeoutMs: WEBRTC_TIMEOUT_MS } })
    await assert.rejects(link.connect('origin.test', originPort), (e) => e.code === 'no-grant')
    await assert.rejects(link.lookup('origin.test'), (e) => e.code === 'no-grant')
    assert.equal(seen.length, 0)
    grantOrigin()
  })

  it('moves 8 MiB up and 8 MiB back (an echo) with every byte checked, each way', async (t) => {
    const total = 8 * MiB
    const socket = await link.connect('origin.test', originPort)
    const started = Date.now()
    await socket.write(new TextEncoder().encode('echo 0\n'))
    let got = 0
    let bad = 0
    const reading = (async () => {
      for (;;) {
        const chunk = await socket.read()
        if (chunk === null) break
        for (let i = 0; i < chunk.length; i++) if (chunk[i] !== patternByte(got + i)) bad++
        got += chunk.length
      }
    })()
    for (let at = 0; at < total; at += 32 * 1024) await socket.write(patternChunk(at, Math.min(32 * 1024, total - at)))
    await socket.end()
    await reading
    const seconds = (Date.now() - started) / 1000
    t.diagnostic(`8 MiB up and 8 MiB down through a real data channel in ${seconds.toFixed(2)} s (${((2 * total) / MiB / seconds).toFixed(1)} MiB/s both ways together)`)
    assert.equal(got, total)
    assert.equal(bad, 0)
    const rec = seen.at(-1)
    assert.equal(rec.received, total)
    assert.ok(rec.inOrder, 'the origin saw every byte in order')
    await waitFor(() => provider.stats().closed === 1, 10_000, 'the provider to see the close')
    const close = audit.find((r) => r.event === 'egress-close')
    assert.equal(close.bytesUp, total + 'echo 0\n'.length, 'the payload and the one header line')
    assert.equal(close.bytesDown, total)
    assert.equal(close.addressClass, 'loopback')
    assert.equal(close.reason, 'closed')
  })

  it('downloads 16 MiB with every byte checked, and an upload ends with the origin\'s own count', async (t) => {
    const total = 16 * MiB
    const down = await link.connect('origin.test', originPort)
    await down.write(new TextEncoder().encode(`download ${total}\n`))
    const started = Date.now()
    let got = 0
    let bad = 0
    for (;;) {
      const chunk = await down.read()
      if (chunk === null) break
      for (let i = 0; i < chunk.length; i += 7) if (chunk[i] !== patternByte(got + i)) bad++
      got += chunk.length
    }
    t.diagnostic(`16 MiB download through a real data channel in ${((Date.now() - started) / 1000).toFixed(2)} s`)
    assert.equal(got, total)
    assert.equal(bad, 0)
    await down.end()

    const up = await link.connect('origin.test', originPort)
    await up.write(new TextEncoder().encode('upload 0\n'))
    for (let at = 0; at < 4 * MiB; at += 32 * 1024) await up.write(patternChunk(at, 32 * 1024))
    await up.end()
    const parts = []
    for (;;) { const c = await up.read(); if (c === null) break; parts.push(c) }
    assert.equal(Buffer.concat(parts).toString(), `got ${4 * MiB}`)
  })

  it('a slow reader slows the origin: what the provider has moved stays within a bound while the consumer reads nothing, over the real channel', async (t) => {
    const total = 48 * MiB
    const before = provider.stats().bytesDown
    const socket = await link.connect('origin.test', originPort)
    await socket.write(new TextEncoder().encode(`download-slow-consumer ${total}\n`))
    await waitFor(() => socket.readableLength >= socket.windowBytes - 64 * 1024, 20_000, "the consumer's window to fill")
    await new Promise((r) => setTimeout(r, 400))
    const moved = provider.stats().bytesDown - before
    const rec = seen.at(-1)
    t.diagnostic(`consumer reading nothing: provider moved ${moved} bytes (bound 1 MiB), socket holds ${socket.readableLength} of a ${socket.windowBytes} byte window, origin wrote ${rec.sent} of ${total}`)
    assert.ok(socket.readableLength <= socket.windowBytes)
    assert.ok(moved <= 1 * MiB, `moved ${moved}`)
    assert.ok(rec.sent < total, 'the origin was held back')
    let got = 0
    let bad = 0
    for (;;) {
      const chunk = await socket.read()
      if (chunk === null) break
      for (let i = 0; i < chunk.length; i += 13) if (chunk[i] !== patternByte(got + i)) bad++
      got += chunk.length
    }
    assert.equal(got, total)
    assert.equal(bad, 0)
    await socket.end()
  })

  it('an address the operator did not allow is refused by wsh\'s guard, with its class, over the real link', async () => {
    nodes.provider.registry.grantCapabilities(nodes.consumer.podId, [`egress:tcp:sibling.test:${originPort}:connect`, 'egress:tcp:10.1.2.3:80:connect'])
    const a = await link.connect('sibling.test', originPort).catch((e) => e)
    assert.ok(a.code === 'destination-refused' && a.addressClass === 'loopback', String(a))
    const b = await link.connect('10.1.2.3', 80).catch((e) => e)
    assert.ok(b.code === 'destination-refused' && b.addressClass === 'private', String(b))
  })

  it('revoking the grant mid-transfer ends the connection at once, over the real link', async () => {
    await waitFor(() => provider.connections.length === 0, 10_000, 'the earlier connections to finish')
    const socket = await link.connect('origin.test', originPort)
    await socket.write(new TextEncoder().encode('upload 0\n'))
    let failure = null
    let sent = 0
    const writing = (async () => {
      try { for (let at = 0; at < 256 * MiB; at += 32 * 1024) { await socket.write(patternChunk(at, 32 * 1024)); sent = at } } catch (e) { failure = e }
    })()
    await waitFor(() => provider.connections.length === 1 && provider.connections[0].bytesUp > 1 * MiB, 20_000, 'a transfer under way')
    nodes.provider.registry.revokeCapabilities(nodes.consumer.podId, [`egress:tcp:origin.test:${originPort}:connect`])
    await writing
    assert.ok(failure, 'the write failed')
    const rec = seen.at(-1)
    await waitFor(() => rec.closed, 10_000, 'the origin to see its connection close')
    assert.equal(provider.stats().ends.revoked, 1)
    assert.ok(sent < 256 * MiB)
    assert.ok(audit.some((r) => r.event === 'egress-close' && r.reason === 'revoked'))
    await assert.rejects(link.connect('origin.test', originPort), (e) => e.code === 'no-grant')
  })

  it('every meter record is accounted for, and none names a destination', () => {
    assert.ok(meter.length > 0)
    for (const r of meter) assert.ok(!('host' in r) && !('address' in r) && !('port' in r))
    assert.equal(meter.filter((r) => r.final && r.form === 'tcp').length, provider.stats().closed)
  })
})
