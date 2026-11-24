// Three real PeerNodes over real WebRTC data channels: alice -- bob -- carol, with no direct link between
// alice and carol. Alice fetches carol's key statement through bob (a routed request, over the real wire),
// seals a message to it, and bob forwards what he cannot read. Everything bob's PeerNode received is checked
// for the plaintext; carol opens it and learns it was sealed and who sent it.
//
// Same optional `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as every other real-peer suite.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

/** @type {any} */ let ndc = null
/** @type {any} */ let ndcMain = null
try {
  ndc = await import('node-datachannel/polyfill')
  ndcMain = await import('node-datachannel')
} catch {
  // Optional dependency absent -- the suite below skips.
}

if (!ndc && process.env.REQUIRE_REAL_PEER) {
  throw new Error(
    'REQUIRE_REAL_PEER is set but `node-datachannel` did not load, so the ' +
    'real-peer suite would have skipped and reported success. Install the ' +
    'devDependency, or unset REQUIRE_REAL_PEER to allow the skip.'
  )
}

if (!ndc) {
  describe('sealed routed messages against real WebRTC peers', () => {
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

const bus = () => new Set()
function busTransport(shared) {
  let handler = null
  const receiver = (msg) => { if (handler) handler(msg) }
  shared.add(receiver)
  return {
    send(msg) { for (const fn of shared) if (fn !== receiver) fn(msg) },
    onMessage(cb) { handler = cb },
  }
}

const SECRET = 'the launch code is 0451'

describeIfReal('sealed routed messages: alice -- bob -- carol over real WebRTC', () => {
  /** @type {any} */ let createMeshNode
  /** @type {any} */ let ManualStrategy
  /** @type {any} */ let attachService
  /** @type {any} */ let createMeshRoutingService
  const nodes = {}
  const svc = {}
  const atBob = []

  before(async () => {
    Object.assign(globalThis, {
      RTCPeerConnection: ndc.RTCPeerConnection,
      RTCIceCandidate: ndc.RTCIceCandidate,
      RTCSessionDescription: ndc.RTCSessionDescription,
    })
    ;({ createMeshNode } = await import('../../src/mesh-bootstrap.mjs'))
    ;({ ManualStrategy } = await import('@johnhenry/browsermesh-discovery'))
    ;({ attachService } = await import('../../src/mesh-service.mjs'))
    ;({ createMeshRoutingService } = await import('../../src/peer-routing.mjs'))

    const shared = bus()
    for (const label of ['alice', 'bob', 'carol']) {
      nodes[label] = await createMeshNode({
        label,
        discoveryStrategies: [new ManualStrategy()],
        signalingTransport: busTransport(shared),
        iceServers: [], // host candidates only: hermetic
      })
    }
    const { alice, bob, carol } = nodes
    const open = { answerTimeoutMs: 10_000, openTimeoutMs: 10_000 }
    await alice.connectToPeer(bob.podId, { webrtc: bob.podId }, open)
    await carol.connectToPeer(bob.podId, { webrtc: bob.podId }, open)
    await waitFor(() => bob.hasActiveSession(alice.podId) && bob.hasActiveSession(carol.podId), 10_000, "bob's sessions with alice and carol")

    for (const label of ['alice', 'bob', 'carol']) svc[label] = attachService(nodes[label], undefined, createMeshRoutingService({}))
    svc.bob.api.addDirectPeer(alice.podId)
    svc.bob.api.addDirectPeer(carol.podId)
    svc.alice.api.addRoute(carol.podId, bob.podId, 2)
    svc.carol.api.addRoute(alice.podId, bob.podId, 2)
    bob.onIncomingData((from, data) => atBob.push({ from, data }))
  })

  after(async () => {
    for (const n of Object.values(nodes)) { try { await n.shutdown?.() } catch { /* already down */ } }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('fetches the destination\'s key statement through the hop, seals to it, and the hop forwards what it cannot read', async () => {
    const { alice, carol } = nodes
    const statement = await svc.alice.api.ensureKey(carol.podId, { timeoutMs: 15_000 })
    assert.equal(statement.podId, carol.podId, 'the statement is the destination\'s, verified against its pod id')

    const got = []
    svc.carol.on('mesh-routing:message', (m) => got.push(m))
    svc.alice.api.route(carol.podId, { text: SECRET })
    await waitFor(() => got.length === 1, 15_000, 'carol to receive the sealed message through bob')

    assert.deepEqual(got[0].message, { text: SECRET })
    assert.equal(got[0].sealed, true)
    assert.equal(got[0].authenticated, true)
    assert.equal(got[0].from, alice.podId)

    const routed = atBob.map((x) => x.data).filter((d) => d?.type === 'mesh-routing' && d.signed?.payload?.sealed)
    assert.ok(routed.length >= 1, 'bob received the sealed envelope over the real channel')
    assert.ok(!JSON.stringify(atBob).includes('launch code'), 'nothing bob received over the wire holds the message')
  })

  it('requireSealed refuses to send to a pod whose statement is not known, with the named error', async () => {
    const stranger = 'a-pod-nobody-has-a-statement-for'
    assert.equal(svc.alice.api.getKeyStatement(stranger), null)
    assert.throws(() => svc.alice.api.route(stranger, { text: 'x' }, { requireSealed: true }), { code: 'E_SEALED_UNAVAILABLE' })
  })
})
