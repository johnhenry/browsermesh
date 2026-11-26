// `createMeshNode({ realm })` over real WebRTC (node-datachannel): a stranger with a credential is restricted by the admission seam,
// presents over the data channel, is promoted and holds exactly its role's scopes; a renewal then runs over the `realm` protocol.
// Same guard as link-admission.test.mjs: skips without the optional dependency, hard-fails under REQUIRE_REAL_PEER=1.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { makeRealm, realmOption, allowed, ROLES, waitFor, nowS, HOUR } from '../helpers/realm-fixtures.mjs'

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
  describe('realm exchange over real WebRTC peers', () => {
    it('skipped: optional devDependency `node-datachannel` is not installed', () => {})
  })
}
const describeIfReal = ndc ? describe : describe.skip

function createBus() {
  const bus = new Set()
  return () => {
    let handler = null
    const receiver = (msg) => { if (handler) handler(msg) }
    bus.add(receiver)
    return { send(msg) { for (const fn of bus) if (fn !== receiver) fn(msg) }, onMessage(cb) { handler = cb } }
  }
}

describeIfReal('the realm option over real WebRTC', () => {
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

  it('a stranger links over WebRTC, is restricted, presents, is promoted, then renews over the realm protocol', async () => {
    const realm = await makeRealm()
    const mk = createBus()
    const bob = await createMeshNode({ label: 'bob', discoveryStrategies: [new ManualStrategy()], signalingTransport: mk(), iceServers: [], realm: realmOption(realm) })
    const alice = await createMeshNode({ label: 'alice', discoveryStrategies: [new ManualStrategy()], signalingTransport: mk(), iceServers: [], realm: { pinnedId: realm.id, descriptor: realm.text, policy: {} } })
    nodes.push(alice, bob)
    alice.realm.setCredential(await realm.credential(alice.podId))

    const result = await alice.realm.present(bob.podId, { timeoutMs: 15_000, auth: { answerTimeoutMs: 10_000, openTimeoutMs: 10_000 } })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.role, 'member')
    await waitFor(() => bob.hasActiveSession(alice.podId), 10_000, 'the promoted WebRTC link is a session')
    assert.equal(bob.admission.stats().promoted, 1)
    for (const scope of ROLES.member) assert.equal(allowed(bob, alice.podId, scope), true, scope)
    assert.equal(allowed(bob, alice.podId, 'egress:tcp:connect'), false)

    const res = await alice.realm.renew(bob.podId, await realm.credential(alice.podId, { serial: 2, notAfter: nowS() + 2 * HOUR }), { timeoutMs: 15_000 })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(bob.registry.listRealmGrants({ peerKey: alice.podId })[0].serial, 2)
  })
})
