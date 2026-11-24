// WebSocketTransport against the REAL signalling server
// (browsermesh-servers/signaling) started as a child process on a loopback
// port, in both of its modes. Opt-in: part of `npm run test:real-peer`, not of
// `npm test`. Skips, saying why, where the servers checkout is absent.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { WebSocketTransport, SignalingAuthError, SignalingAuthRequiredError } from '../../src/ws-transport.mjs'
import { locateSignalingServer, startRealSignalingServer } from '../../../../tests/support/real-signaling-server.mjs'

const found = locateSignalingServer()
if (!found.available && process.env.REQUIRE_REAL_SIGNALING) {
  throw new Error(`REQUIRE_REAL_SIGNALING is set but ${found.reason}`)
}
const skip = found.available ? false : `real signalling server not available: ${found.reason}`

async function until(cond, what, timeoutMs = 5000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const noRetry = { maxAttempts: 0 }

describe('real signalling server: authenticated mode', { skip }, () => {
  let srv
  const open = []
  before(async () => { srv = await startRealSignalingServer({ mode: 'authenticated' }) })
  after(async () => { for (const t of open) await t.close(); await srv.stop() })
  const make = (o) => { const t = new WebSocketTransport({ url: srv.wsUrl, protocol: 'signaling', reconnect: noRetry, ...o }); open.push(t); return t }

  it('registers with an identity, verified, and sees the other pod as server-verified', async () => {
    const ia = await PodIdentity.generate()
    const ib = await PodIdentity.generate()
    const a = make({ podId: ia.podId, identity: ia })
    const b = make({ podId: ib.podId, identity: ib })
    await a.open(); await b.open()
    assert.deepEqual(a.registration, { mode: 'authenticated', verified: true })
    await until(() => a.serverVerifiedPeers.has(ib.podId) && b.serverVerifiedPeers.has(ia.podId), 'server-verified peer hints')
    assert.equal(a.verifiedPeers.has(ib.podId), false)
  })

  it('relayed messages carry the server\'s sourceVerified', async () => {
    const ia = await PodIdentity.generate()
    const ib = await PodIdentity.generate()
    const a = make({ podId: ia.podId, identity: ia })
    const b = make({ podId: ib.podId, identity: ib })
    const got = []
    b.onMessage((m) => got.push(m))
    await a.open(); await b.open()
    a.send({ type: 'pod:hello', to: ib.podId, relaySourceVerified: false })
    await until(() => got.length === 1, 'relayed message')
    assert.equal(got[0].relaySource, ia.podId)
    assert.equal(got[0].relaySourceVerified, true)
  })

  it('a pod holds two connections; a third displaces the oldest, which is told "replaced" and stays down', async () => {
    const identity = await PodIdentity.generate()
    const sameId = () => make({ podId: identity.podId, identity })
    const first = sameId()
    const notices = []
    first.onReplaced((n) => notices.push(n))
    await first.open()
    const second = sameId(); await second.open()
    assert.equal(first.ready, true)
    assert.equal(second.ready, true)
    const third = sameId(); await third.open()
    await until(() => notices.length === 1, 'the replaced notice')
    assert.equal(first.replaced.kind, 'primary')
    await until(() => !first.ready, 'the displaced connection closing')
    assert.equal(second.ready && third.ready, true)
  })

  it('the same server as primary and as signalingUrl: both stay connected, each message arrives once', async () => {
    const identity = await PodIdentity.generate()
    const other = await PodIdentity.generate()
    const pod = make({ podId: identity.podId, identity, signalingUrl: srv.wsUrl, peersFromSignaling: true })
    const got = []
    pod.onMessage((m) => got.push(m.n))
    const replaced = []
    pod.onReplaced((n) => replaced.push(n))
    await pod.open()
    const sender = make({ podId: other.podId, identity: other })
    await sender.open()
    for (let n = 1; n <= 5; n++) sender.send({ type: 'pod:hello', to: identity.podId, n })
    await until(() => got.length >= 5, 'five messages')
    await new Promise((r) => setTimeout(r, 100))
    assert.deepEqual(got, [1, 2, 3, 4, 5])
    assert.equal(replaced.length, 0)
    assert.equal(pod.ready, true)
  })

  it('without an identity: a named error', async () => {
    const t = make({ podId: 'a'.repeat(43) })
    await assert.rejects(t.open(), (e) => e instanceof SignalingAuthRequiredError)
  })

  it('a pod id that is not the hash of the key is refused', async () => {
    const a = await PodIdentity.generate()
    const b = await PodIdentity.generate()
    const t = make({ podId: a.podId, identity: { podId: a.podId, rawPublicKey: () => b.rawPublicKey(), sign: (d) => b.sign(d) } })
    await assert.rejects(t.open(), (e) => e instanceof SignalingAuthError && e.code === 'pod-id-mismatch')
  })

  it('signing another origin than the server\'s own is refused; an explicit origin fixes it', async () => {
    const identity = await PodIdentity.generate()
    const wrong = make({ url: `ws://localhost:${srv.port}`, podId: identity.podId, identity })
    await assert.rejects(wrong.open(), (e) => e.code === 'bad-signature')
    const right = make({ url: `ws://localhost:${srv.port}`, origin: srv.wsUrl, podId: identity.podId, identity })
    await right.open()
    assert.equal(right.registration.verified, true)
  })
})

describe('real signalling server: open mode', { skip }, () => {
  let srv
  const open = []
  before(async () => { srv = await startRealSignalingServer({ mode: 'open' }) })
  after(async () => { for (const t of open) await t.close(); await srv.stop() })
  const make = (o) => { const t = new WebSocketTransport({ url: srv.wsUrl, protocol: 'signaling', reconnect: noRetry, ...o }); open.push(t); return t }

  it('registers as before; nothing is verified', async () => {
    const a = make({ podId: 'open-a' })
    const b = make({ podId: 'open-b' })
    const got = []
    b.onMessage((m) => got.push(m))
    await a.open(); await b.open()
    assert.deepEqual(a.registration, { mode: 'open', verified: false })
    a.send({ type: 'pod:hello', to: 'open-b' })
    await until(() => got.length === 1, 'relayed message')
    assert.equal(got[0].relaySourceVerified, false)
    assert.equal(b.serverVerifiedPeers.size, 0)
  })

  it('a second connection for an id is refused as before ("podId already registered"), and is not a "replaced"', async () => {
    const a = make({ podId: 'open-dup' })
    await a.open()
    const b = make({ podId: 'open-dup' })
    const notices = []
    b.onReplaced((n) => notices.push(n))
    await assert.rejects(b.open(), /podId already registered/)
    assert.equal(notices.length, 0)
    assert.equal(a.ready, true)
  })

  it('with an identity it falls back to the open flow', async () => {
    const identity = await PodIdentity.generate()
    const t = make({ podId: identity.podId, identity, challengeWaitMs: 300 })
    await t.open()
    assert.deepEqual(t.registration, { mode: 'open', verified: false })
  })

  it("authentication: 'required' refuses to fall back", async () => {
    const identity = await PodIdentity.generate()
    const t = make({ podId: identity.podId, identity, authentication: 'required', challengeWaitMs: 300 })
    await assert.rejects(t.open(), (e) => e.code === 'no-challenge')
  })
})
