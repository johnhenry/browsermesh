// Two real PeerNodes (real identities, real data channels, loopback host candidates only) dial each other at the same moment:
// both dials must come back with the one connection, each side holds one session for it, and what one sends the other
// receives once. Then a peer that starts over on a connection the other side still holds is wired in once, not twice.
//
// Same optional `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as every other real-peer suite.
import { describe, it, afterEach, after } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

let ndc = null
let ndcMain = null
try {
  ndc = await import('node-datachannel/polyfill')
  ndcMain = await import('node-datachannel')
} catch { /* optional dependency absent: the suite below skips */ }

if (!ndc && process.env.REQUIRE_REAL_PEER) {
  throw new Error('REQUIRE_REAL_PEER is set but `node-datachannel` did not load, so the real-peer suite would have skipped and reported success. Install the devDependency, or unset REQUIRE_REAL_PEER to allow the skip.')
}
if (!ndc) describe('glare over real WebRTC peers', () => { it('skipped: optional devDependency `node-datachannel` is not installed', () => {}) })
const describeIfReal = ndc ? describe : describe.skip

const WEBRTC_TIMEOUT_MS = 30_000

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

describeIfReal('two peers that dial each other at once', () => {
  const open = []
  afterEach(async () => {
    for (const n of open.splice(0)) { try { await n.shutdown() } catch { /* gone */ } try { n.meshManager.closeAll() } catch { /* gone */ } }
  })

  async function pair() {
    Object.assign(globalThis, { RTCPeerConnection: ndc.RTCPeerConnection, RTCIceCandidate: ndc.RTCIceCandidate, RTCSessionDescription: ndc.RTCSessionDescription })
    const { createMeshNode } = await import('@johnhenry/browsermesh-apps')
    const { ManualStrategy, DiscoveryRecord } = await import('@johnhenry/browsermesh-discovery')
    const bus = new Set()
    const transport = () => { let handler = null; const rx = (m) => handler?.(m); bus.add(rx); return { send(m) { for (const fn of bus) if (fn !== rx) fn(m) }, onMessage(cb) { handler = cb } } }
    const discovery = { a: new ManualStrategy(), b: new ManualStrategy() }
    const nodes = {}
    for (const label of ['a', 'b']) nodes[label] = await createMeshNode({ label, discoveryStrategies: [discovery[label]], signalingTransport: transport(), iceServers: [] })
    open.push(nodes.a, nodes.b)
    discovery.a.addPeer(new DiscoveryRecord({ podId: nodes.b.podId, transport: 'webrtc', label: 'b' }))
    discovery.b.addPeer(new DiscoveryRecord({ podId: nodes.a.podId, transport: 'webrtc', label: 'a' }))
    await nodes.a.discover()
    await nodes.b.discover()
    return nodes
  }

  const dial = (from, to) => from.connectToPeer(to.podId, { webrtc: to.podId }, { answerTimeoutMs: WEBRTC_TIMEOUT_MS, openTimeoutMs: WEBRTC_TIMEOUT_MS })

  it('three times over: both dials resolve, one connection each, and a message is delivered once', async () => {
    for (let round = 0; round < 3; round++) {
      const { a, b } = await pair()
      const [ra, rb] = await Promise.all([dial(a, b), dial(b, a)])
      assert.ok(ra.sessionId && rb.sessionId)
      await waitFor(() => a.hasActiveSession(b.podId) && b.hasActiveSession(a.podId), WEBRTC_TIMEOUT_MS, 'a session on each side')
      assert.equal(a.meshManager.connectionCount, 1, 'one connection at a')
      assert.equal(b.meshManager.connectionCount, 1, 'one connection at b')
      assert.equal(a.sessionsFor(b.podId).length, 1, 'one session at a')
      assert.equal(b.sessionsFor(a.podId).length, 1, 'one session at b')
      const got = []
      b.onIncomingData((from, data) => got.push([from, data]))
      await a.sendTo(b.podId, JSON.stringify({ type: 'hello', n: round }))
      await waitFor(() => got.length >= 1, WEBRTC_TIMEOUT_MS, 'the message to arrive')
      await new Promise((r) => setTimeout(r, 100)) // a duplicate would have arrived by now
      assert.equal(got.length, 1, 'delivered once')
      await a.shutdown(); a.meshManager.closeAll()
      await b.shutdown(); b.meshManager.closeAll()
    }
  })

  it('after the connection closes, the node says the peer is not reachable, and a new dial works', async () => {
    const { a, b } = await pair()
    await dial(a, b)
    await waitFor(() => b.hasActiveSession(a.podId), WEBRTC_TIMEOUT_MS, 'b to have a session')
    a.meshManager.closeAll()
    await waitFor(() => !b.hasActiveSession(a.podId), WEBRTC_TIMEOUT_MS, 'b to see the connection close')
    assert.equal(b.sessionsFor(a.podId).length, 0)
    await dial(b, a)
    await waitFor(() => a.hasActiveSession(b.podId) && b.hasActiveSession(a.podId), WEBRTC_TIMEOUT_MS, 'sessions again')
  })

  after(() => { try { ndcMain?.cleanup() } catch { /* nothing to clean up */ } })
})
