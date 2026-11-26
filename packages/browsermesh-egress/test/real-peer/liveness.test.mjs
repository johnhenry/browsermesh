// Real WebRTC (node-datachannel on both ends), the other end a CHILD PROCESS that is killed outright with SIGKILL: no close frame,
// no goodbye. How long does the survivor take to notice, with the default keep-alive (a ping every 5 s, gone after 3 silent intervals)?
// Before the keep-alive a consumer measured about 237 s for this.
//
// The two processes signal each other over the IPC channel; the data channel is real. The page-side entry (`./browser`) is the
// consumer in both directions. Nothing here connects to another host: the destination is a TCP listener on this machine's loopback,
// which the provider's operator allows (`allowPrivate`), as in the other real-peer suites.
//
// Same optional `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as every other real-peer suite here.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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
if (!ndc) describe('egress liveness over real WebRTC peers', () => { it('skipped: optional dependency `node-datachannel` is not installed', () => {}) })
const describeIfReal = ndc ? describe : describe.skip

const CHILD = fileURLToPath(new URL('./helpers/peer-child.mjs', import.meta.url))
const WEBRTC_TIMEOUT_MS = 30_000
/** Far more than the ~15 s the defaults take; what is asserted is that it ends, not how long it takes. */
const NOTICE_LIMIT_MS = 60_000

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

/** A child process and a message queue for what it says. */
function spawn(role) {
  const child = fork(CHILD, [role], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  const inbox = []
  let signalHandler = null
  child.on('message', (m) => { if (m?.signal) signalHandler?.(m.signal); else inbox.push(m) })
  return {
    child,
    /** A signalling transport whose other end is the child. */
    transport: { send: (message) => { try { child.send({ signal: message }) } catch { /* the child is gone */ } }, onMessage: (cb) => { signalHandler = cb } },
    async said(key, ms = WEBRTC_TIMEOUT_MS) {
      let found
      await waitFor(() => { const i = inbox.findIndex((m) => key in m); if (i < 0) return false; found = inbox.splice(i, 1)[0]; return true }, ms, `the child to say ${key}`)
      return found
    },
    tell: (message) => child.send(message),
  }
}

describeIfReal('a peer that is killed outright is noticed', () => {
  let origin
  let originPort
  const children = []
  const nodes = []

  before(async () => {
    Object.assign(globalThis, { RTCPeerConnection: ndc.RTCPeerConnection, RTCIceCandidate: ndc.RTCIceCandidate, RTCSessionDescription: ndc.RTCSessionDescription })
    const sockets = new Set()
    origin = net.createServer({ allowHalfOpen: true }, (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.on('data', (d) => socket.write(d)) })
    origin.closeAll = () => { for (const s of sockets) s.destroy() }
    await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve))
    originPort = origin.address().port
  })

  after(async () => {
    for (const c of children) { try { c.child.kill('SIGKILL') } catch { /* gone */ } }
    for (const n of nodes) { try { await n() } catch { /* gone */ } }
    try { origin?.closeAll(); origin?.close() } catch { /* gone */ }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('a consumer notices its provider was killed: the link ends provider-gone, what was open fails with it', async (t) => {
    const { createEgressNode } = await import('../../src/browser.mjs')
    const provider = spawn('provider')
    children.push(provider)
    const { podId: providerPodId } = await provider.said('podId')
    const egressNode = await createEgressNode({ signaling: provider.transport, iceServers: [], answerTimeoutMs: WEBRTC_TIMEOUT_MS, openTimeoutMs: WEBRTC_TIMEOUT_MS })
    nodes.push(() => egressNode.close())
    provider.tell({ grant: egressNode.podId, originPort })
    await provider.said('ready')
    const link = await egressNode.connect(providerPodId, { limits: { requestTimeoutMs: WEBRTC_TIMEOUT_MS } })
    const socket = await link.connect('origin.test', originPort)
    await socket.write(new TextEncoder().encode('ping'))
    assert.equal(new TextDecoder().decode(await socket.read()), 'ping')
    assert.equal(link.closed, false)

    const waiting = socket.read().then(() => null, (e) => e)
    const killedAt = Date.now()
    provider.child.kill('SIGKILL')
    const info = await Promise.race([link.whenClosed, new Promise((_, reject) => setTimeout(() => reject(new Error('the link was not closed')), NOTICE_LIMIT_MS))])
    const took = Date.now() - killedAt
    t.diagnostic(`provider killed with SIGKILL: the consumer's link ended '${info.reason}' after ${(took / 1000).toFixed(1)} s (keep-alive defaults: every 5 s, 3 misses)`)
    assert.equal(info.reason, 'provider-gone')
    const failure = await waiting
    assert.ok(failure && failure.code === 'provider-gone', String(failure?.code ?? failure))
    assert.equal(link.stats().open, 0)
    await assert.rejects(link.connect('origin.test', originPort), (e) => e.code === 'link-closed')
  })

  // For the record, not for CI: how long the transport alone takes (keep-alive off), which is what a consumer measured at about 237 s.
  // `EGRESS_MEASURE_UNASSISTED=1 node --test test/real-peer/liveness.test.mjs`
  it('without the keep-alive the transport\'s own timers decide (minutes): measured only when asked for', { skip: !process.env.EGRESS_MEASURE_UNASSISTED, timeout: 15 * 60_000 }, async (t) => {
    const { createEgressNode } = await import('../../src/browser.mjs')
    const provider = spawn('provider')
    children.push(provider)
    const { podId: providerPodId } = await provider.said('podId')
    const egressNode = await createEgressNode({ signaling: provider.transport, iceServers: [], answerTimeoutMs: WEBRTC_TIMEOUT_MS, openTimeoutMs: WEBRTC_TIMEOUT_MS })
    nodes.push(() => egressNode.close())
    provider.tell({ grant: egressNode.podId, originPort })
    await provider.said('ready')
    const link = await egressNode.connect(providerPodId, { keepAlive: false })
    const killedAt = Date.now()
    provider.child.kill('SIGKILL')
    const noticed = await waitFor(() => link.closed, 12 * 60_000, 'the transport to notice').then(() => true, () => false)
    t.diagnostic(noticed
      ? `keep-alive off, provider killed with SIGKILL: the transport's own timers ended the link after ${((Date.now() - killedAt) / 1000).toFixed(1)} s`
      : 'keep-alive off, provider killed with SIGKILL: the transport had not noticed after 12 minutes')
  })

  it('a provider notices its consumer was killed: the connection ends, the channel is gone, the budget is free', async (t) => {
    const apps = await import('@johnhenry/browsermesh-apps')
    const { ManualStrategy } = await import('@johnhenry/browsermesh-discovery')
    const egress = await import('../../src/index.mjs')
    const nodeEntry = await import('../../src/node.mjs')
    const consumer = spawn('consumer')
    children.push(consumer)
    const { podId: consumerPodId } = await consumer.said('podId')
    const node = await apps.createMeshNode({ label: 'provider', discoveryStrategies: [new ManualStrategy()], skipDiscovery: true, signalingTransport: consumer.transport, iceServers: [] })
    nodes.push(() => node.shutdown())
    const svc = apps.attachService(node, undefined, apps.createMeshProtocolService())
    const lookup = async (name) => { if (name === 'origin.test') return ['127.0.0.1']; const e = new Error('nx'); e.code = 'ENOTFOUND'; throw e }
    const audit = []
    const provider = egress.createMeshEgress({ service: svc, registry: node.registry, ...nodeEntry.nodeDialer({ lookup, allowPrivate: ['127.0.0.1/32'] }), unattended: true, onAudit: (r) => audit.push(r) })
    provider.start()
    nodes.push(() => provider.stop())
    node.registry.grantCapabilities(consumerPodId, [apps.protocolScope('egress'), `egress:tcp:origin.test:${originPort}:connect`])
    consumer.tell({ connect: node.podId, originPort })
    await consumer.said('connected')
    await waitFor(() => provider.connections.length === 1, 10_000, 'the provider to hold the consumer\'s connection')

    const killedAt = Date.now()
    consumer.child.kill('SIGKILL')
    await waitFor(() => provider.stats().gone === 1 && provider.connections.length === 0, NOTICE_LIMIT_MS, 'the provider to give up on the killed consumer')
    t.diagnostic(`consumer killed with SIGKILL: the provider ended its connection and channel after ${((Date.now() - killedAt) / 1000).toFixed(1)} s (keep-alive defaults: every 5 s, 3 misses)`)
    assert.equal(provider.stats().channels, 0)
    assert.equal(provider.stats().ends['consumer-left'], 1)
    assert.ok(audit.some((a) => a.event === 'egress-consumer-gone' && a.peer === consumerPodId))
  })
})
