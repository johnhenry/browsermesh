// Two real PeerNodes over real WebRTC (node-datachannel), the receiver gating inbound sessions with `admission`.
// Same guard as mesh-bootstrap.test.mjs: skips without the optional dependency, hard-fails under REQUIRE_REAL_PEER=1.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

/** @type {any} */ let ndc = null
/** @type {any} */ let ndcMain = null
try {
  ndc = await import('node-datachannel/polyfill')
  ndcMain = await import('node-datachannel')
} catch { /* optional dependency absent */ }

if (!ndc && process.env.REQUIRE_REAL_PEER) {
  throw new Error('REQUIRE_REAL_PEER is set but `node-datachannel` did not load, so the real-peer suite would have skipped and reported success.')
}
if (!ndc) {
  describe('link admission over real WebRTC peers', () => {
    it('skipped: optional devDependency `node-datachannel` is not installed', () => {})
  })
}
const describeIfReal = ndc ? describe : describe.skip

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

function createBus() {
  const bus = new Set()
  return () => {
    let handler = null
    const receiver = (msg) => { if (handler) handler(msg) }
    bus.add(receiver)
    return { send(msg) { for (const fn of bus) if (fn !== receiver) fn(msg) }, onMessage(cb) { handler = cb } }
  }
}

describeIfReal('inbound WebRTC sessions behind `admission`', () => {
  /** @type {any} */ let createMeshNode
  /** @type {any} */ let ManualStrategy
  const nodes = []

  before(async () => {
    Object.assign(globalThis, { RTCPeerConnection: ndc.RTCPeerConnection, RTCIceCandidate: ndc.RTCIceCandidate, RTCSessionDescription: ndc.RTCSessionDescription })
    ;({ createMeshNode } = await import('../../src/mesh-bootstrap.mjs'))
    ;({ ManualStrategy } = await import('@johnhenry/browsermesh-discovery'))
  })
  after(async () => {
    for (const n of nodes) await n.shutdown().catch(() => {})
    try { ndcMain.cleanup() } catch { /* nothing */ }
  })

  async function pair({ bob = {}, alice = {} } = {}) {
    const mk = createBus()
    const a = await createMeshNode({ label: 'alice', discoveryStrategies: [new ManualStrategy()], signalingTransport: mk(), iceServers: [], ...alice })
    const b = await createMeshNode({ label: 'bob', discoveryStrategies: [new ManualStrategy()], signalingTransport: mk(), iceServers: [], ...bob })
    nodes.push(a, b)
    return { a, b }
  }
  const dial = (a, b) => a.connectToPeer(b.podId, { webrtc: b.podId }, { answerTimeoutMs: 10_000, openTimeoutMs: 10_000 })

  it('restrict: the handler gets the frames, the node gets none until promote, and a promoted link works', async () => {
    const seen = []
    let link = null
    const { a, b } = await pair({
      bob: { admission: { decide: () => 'restrict', handler: (l) => { link = l; l.onFrame((f) => { seen.push(f); l.send({ type: 'x:ack' }) }) } } },
    })
    const atBob = []
    b.onIncomingData((from, data) => atBob.push({ from, data }))
    const atAlice = []
    a.onIncomingData((from, data) => atAlice.push(data))
    await dial(a, b)
    await waitFor(() => link, 10_000, 'bob to hold the inbound link restricted')
    assert.equal(link.proven, true)
    assert.equal(link.transport, 'webrtc')
    assert.equal(link.peerKey, a.podId)
    await a.sendTo(b.podId, { type: 'x:hello' })
    await waitFor(() => seen.length === 1, 5_000, 'the handler gets a frame')
    assert.deepEqual(seen[0], { type: 'x:hello' })
    await waitFor(() => atAlice.length === 1, 5_000, 'alice gets the handler\'s frame')
    assert.deepEqual(atAlice[0], { type: 'x:ack' })
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(atBob, [], 'nothing reached the node\'s handlers')
    assert.equal(b.hasActiveSession(a.podId), false)

    assert.equal(link.promote(), true)
    assert.equal(b.hasActiveSession(a.podId), true)
    await a.sendTo(b.podId, { type: 'normal' })
    await waitFor(() => atBob.length === 1, 5_000, 'a promoted link carries normal frames')
    assert.deepEqual(atBob[0].data, { type: 'normal' })
    assert.equal(seen.length, 1)
  })

  it('a link whose peer did not prove its key reports proven:false to decide', async () => {
    const asked = []
    const { a, b } = await pair({
      alice: { webrtcIdentityBinding: false },
      bob: { webrtcAllowUnboundPeers: true, admission: { decide: (i) => { asked.push(i); return 'deny' }, handler() {} } },
    })
    await dial(a, b).catch(() => {})
    await waitFor(() => asked.length >= 1, 10_000, 'decide to be asked')
    assert.equal(asked[0].proven, false)
    assert.equal(asked[0].transport, 'webrtc')
    assert.equal(asked[0].peerKey, a.podId)
  })

  it('deny closes the link and never adopts a session', async () => {
    const { a, b } = await pair({ bob: { admission: { decide: () => 'deny', handler() {} } } })
    await dial(a, b).catch(() => {})
    await waitFor(() => b.admission.stats().denied === 1, 10_000, 'a denial')
    assert.equal(b.hasActiveSession(a.podId), false)
  })

  it('without the option, behaviour is as before: every inbound session is adopted', async () => {
    const { a, b } = await pair()
    await dial(a, b)
    await waitFor(() => b.hasActiveSession(a.podId), 10_000, 'bob adopts the inbound session')
    assert.equal(b.admission, undefined)
  })
})
