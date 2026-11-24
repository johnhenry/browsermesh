// SignalingClient and fetchIceServers against the REAL signalling server
// (browsermesh-servers/signaling) started as a child process on a loopback
// port, in both of its modes. Opt-in: part of `npm run test:real-peer`, not of
// `npm test`. Skips, saying why, where the servers checkout is absent.
//
// Run with: node --import ./test/_setup-globals.mjs --test test/real-peer/signaling-server.test.mjs
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { SignalingClient, SignalingAuthError, SignalingAuthRequiredError, fetchIceServers } from '../../src/handshake.mjs'
import { locateSignalingServer, startRealSignalingServer } from '../../../../tests/support/real-signaling-server.mjs'

const found = locateSignalingServer()
if (!found.available && process.env.REQUIRE_REAL_SIGNALING) {
  throw new Error(`REQUIRE_REAL_SIGNALING is set but ${found.reason}`)
}
const skip = found.available ? false : `real signalling server not available: ${found.reason}`

const TOKEN = 'test-ice-token-0123456789'

function once(client, event) {
  return new Promise((resolve) => { const off = client.on(event, (d, f) => { off(); resolve({ d, f }) }) })
}

describe('real signalling server: authenticated mode', { skip }, () => {
  let srv
  const clients = []
  before(async () => {
    srv = await startRealSignalingServer({ mode: 'authenticated', env: { ICE_API_TOKEN: TOKEN, TURN_URLS: 'turn:127.0.0.1:3478', TURN_SECRET: 'a-test-secret-of-16+chars', STUN_URLS: 'stun:127.0.0.1:3478' } })
  })
  after(async () => { for (const c of clients) c.disconnect(); await srv.stop() })
  const track = (c) => { clients.push(c); return c }

  it('registers a client with an identity, verified', async () => {
    const identity = await PodIdentity.generate()
    const c = track(new SignalingClient({ url: srv.wsUrl, localPodId: identity.podId, identity }))
    await c.connect()
    assert.deepEqual(c.registration, { mode: 'authenticated', verified: true })
  })

  it('forwards between two authenticated clients with sourceVerified set by the server', async () => {
    const ia = await PodIdentity.generate()
    const ib = await PodIdentity.generate()
    const a = track(new SignalingClient({ url: srv.wsUrl, localPodId: ia.podId, identity: ia }))
    const b = track(new SignalingClient({ url: srv.wsUrl, localPodId: ib.podId, identity: ib }))
    await a.connect(); await b.connect()
    const seen = once(b, 'offer')
    a.send(ib.podId, 'offer', { offer: { sdp: 'x' }, sourceVerified: false })
    const { d, f } = await seen
    assert.equal(f, ia.podId)
    assert.equal(b.isSourceVerified(d), true)
  })

  it('without an identity: a named error', async () => {
    const c = track(new SignalingClient({ url: srv.wsUrl, localPodId: 'a'.repeat(43), waitForRegistration: true }))
    await assert.rejects(c.connect(), (e) => e instanceof SignalingAuthRequiredError)
  })

  it('a pod id that is not the hash of the key is refused by the server', async () => {
    const a = await PodIdentity.generate()
    const b = await PodIdentity.generate()
    const liar = { podId: a.podId, rawPublicKey: () => b.rawPublicKey(), sign: (d) => b.sign(d) }
    const c = track(new SignalingClient({ url: srv.wsUrl, localPodId: a.podId, identity: liar }))
    await assert.rejects(c.connect(), (e) => e instanceof SignalingAuthError && e.code === 'pod-id-mismatch')
  })

  it('a client that signs another origin than the server\'s own is refused', async () => {
    // Same server, reached under another name: the proof is for ws://localhost:<port>.
    const identity = await PodIdentity.generate()
    const c = track(new SignalingClient({ url: `ws://localhost:${srv.port}`, localPodId: identity.podId, identity }))
    await assert.rejects(c.connect(), (e) => e instanceof SignalingAuthError && e.code === 'bad-signature')
  })

  it('an explicit origin makes the same connection acceptable', async () => {
    const identity = await PodIdentity.generate()
    const c = track(new SignalingClient({ url: `ws://localhost:${srv.port}`, origin: srv.wsUrl, localPodId: identity.podId, identity }))
    await c.connect()
    assert.equal(c.registration.verified, true)
  })

  it('/ice-servers: refused without the token, time-limited TURN credentials with it', async () => {
    await assert.rejects(fetchIceServers({ signalingUrl: srv.wsUrl }), (e) => e.code === 'ice-unauthorized')
    await assert.rejects(fetchIceServers({ signalingUrl: srv.wsUrl, token: 'wrong' }), (e) => e.code === 'ice-unauthorized')
    const list = await fetchIceServers({ signalingUrl: srv.wsUrl, token: TOKEN })
    const turn = list.find((s) => String(s.urls).startsWith('turn:'))
    assert.ok(turn, 'a TURN entry')
    assert.ok(Number(turn.username.split(':')[0]) > Date.now() / 1000, 'the username carries a future expiry')
    assert.ok(turn.credential.length > 10)
  })
})

describe('real signalling server: open mode', { skip }, () => {
  let srv
  const clients = []
  before(async () => { srv = await startRealSignalingServer({ mode: 'open' }) })
  after(async () => { for (const c of clients) c.disconnect(); await srv.stop() })
  const track = (c) => { clients.push(c); return c }

  it('a client without an identity registers as before and is not verified', async () => {
    const a = track(new SignalingClient({ url: srv.wsUrl, localPodId: 'open-a' }))
    const b = track(new SignalingClient({ url: srv.wsUrl, localPodId: 'open-b', waitForRegistration: true }))
    await a.connect(); await b.connect()
    assert.deepEqual(b.registration, { mode: 'open', verified: false })
    const seen = once(a, 'offer')
    b.send('open-a', 'offer', { offer: { sdp: 'x' } })
    const { d } = await seen
    assert.equal(a.isSourceVerified(d), false)
  })

  it('a client with an identity falls back to the open flow, and says it is unverified', async () => {
    const identity = await PodIdentity.generate()
    const c = track(new SignalingClient({ url: srv.wsUrl, localPodId: identity.podId, identity, challengeWaitMs: 300 }))
    await c.connect()
    assert.deepEqual(c.registration, { mode: 'open', verified: false })
  })

  it("authentication: 'required' refuses to fall back", async () => {
    const identity = await PodIdentity.generate()
    const c = track(new SignalingClient({ url: srv.wsUrl, localPodId: identity.podId, identity, authentication: 'required', challengeWaitMs: 300 }))
    await assert.rejects(c.connect(), (e) => e.code === 'no-challenge')
  })
})
