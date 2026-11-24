// WebSocketTransport against the signalling server's authenticated protocol
// (protocol 2) and its open mode, using a double that follows the server's own
// messages (tests/support/signaling-double.mjs).
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { WebSocketTransport, SignalingAuthError, SignalingAuthRequiredError } from '../src/ws-transport.mjs'
import { SignalingDouble, createDoubleNetwork } from '../../../tests/support/signaling-double.mjs'

const toClose = []
afterEach(async () => {
  for (const t of toClose) { try { await t.close() } catch { /* ignore */ } }
  toClose.length = 0
})
const track = (t) => { toClose.push(t); return t }

async function until(cond, what, timeoutMs = 2000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 2))
  }
}

function world(doubleOpts) {
  const net = createDoubleNetwork()
  const server = net.add('ws://signal.test', new SignalingDouble(doubleOpts))
  return { net, server }
}

const sigOpts = (net, extra) => ({ url: 'ws://signal.test', protocol: 'signaling', WebSocket: net.WebSocket, ...extra })

describe('WebSocketTransport: signalling protocol 2', () => {
  it('registers with a signed, key-bound proof and reports the server verified it', async () => {
    const { net, server } = world({ mode: 'authenticated' })
    const identity = await PodIdentity.generate()
    const t = track(new WebSocketTransport(sigOpts(net, { podId: identity.podId, identity })))
    await t.open()
    assert.equal(t.ready, true)
    assert.deepEqual(t.registration, { mode: 'authenticated', verified: true })
    const reg = server.received.find((r) => r.data.type === 'register').data
    assert.equal(reg.protocol, 2)
    assert.equal(reg.podId, identity.podId)
  })

  it('a peer the server verified is a hint with a server stamp, never a broadcast recipient', async () => {
    const { net, server } = world({ mode: 'authenticated' })
    const ia = await PodIdentity.generate()
    const ib = await PodIdentity.generate()
    const a = track(new WebSocketTransport(sigOpts(net, { podId: ia.podId, identity: ia })))
    await a.open()
    const b = track(new WebSocketTransport(sigOpts(net, { podId: ib.podId, identity: ib })))
    await b.open()
    await until(() => a.knownPeers.has(ib.podId) && b.knownPeers.has(ia.podId), 'peer hints')
    assert.equal(a.serverVerifiedPeers.has(ib.podId), true)
    assert.equal(b.serverVerifiedPeers.has(ia.podId), true)
    assert.equal(a.verifiedPeers.has(ib.podId), false, 'the server stamp does not stand in for the peer signed hello')
    a.send({ type: 'pod:other', to: '*' })
    assert.equal(server.received.some((r) => r.podId === ia.podId && r.data.envelope?.type === 'pod:other'), false)
  })

  it('stamps relayed messages with the server\'s sourceVerified and ignores the sender\'s', async () => {
    const { net } = world({ mode: 'authenticated' })
    const ia = await PodIdentity.generate()
    const ib = await PodIdentity.generate()
    const a = track(new WebSocketTransport(sigOpts(net, { podId: ia.podId, identity: ia })))
    const b = track(new WebSocketTransport(sigOpts(net, { podId: ib.podId, identity: ib })))
    const got = []
    b.onMessage((m) => got.push(m))
    await a.open(); await b.open()
    a.send({ type: 'pod:hello', to: ib.podId, relaySourceVerified: false })
    await until(() => got.length === 1, 'delivery')
    assert.equal(got[0].relaySource, ia.podId)
    assert.equal(got[0].relaySourceVerified, true)
    assert.equal(b.serverVerifiedPeers.has(ia.podId), true)
  })

  it('open mode: nothing is stamped verified, and relayed messages say so', async () => {
    const { net } = world({ mode: 'open' })
    const a = track(new WebSocketTransport(sigOpts(net, { podId: 'pa' })))
    const b = track(new WebSocketTransport(sigOpts(net, { podId: 'pb' })))
    const got = []
    b.onMessage((m) => got.push(m))
    await a.open(); await b.open()
    assert.deepEqual(a.registration, { mode: 'open', verified: false })
    a.send({ type: 'pod:hello', to: 'pb', relaySourceVerified: true })
    await until(() => got.length === 1, 'delivery')
    assert.equal(got[0].relaySourceVerified, false)
    assert.equal(b.serverVerifiedPeers.size, 0)
  })

  it('an older server that stamps nothing reads as unverified', async () => {
    const { net } = world({ mode: 'open' })
    const t = track(new WebSocketTransport(sigOpts(net, { podId: 'pa' })))
    const got = []
    t.onMessage((m) => got.push(m))
    await t.open()
    // A frame as a server from before sourceVerified existed would send it.
    net.sockets[0]._serverSend({ type: 'signal', source: 'old', envelope: { type: 'x' } })
    // Anything but a literal true is not a stamp.
    net.sockets[0]._serverSend({ type: 'signal', source: 'old2', sourceVerified: 'yes', envelope: { type: 'x' } })
    await until(() => got.length === 2, 'delivery')
    assert.equal(got[0].relaySourceVerified, false)
    assert.equal(got[1].relaySourceVerified, false)
    assert.equal(t.serverVerifiedPeers.size, 0)
  })

  it('with an identity against an open-mode server it falls back to the open flow', async () => {
    const { net, server } = world({ mode: 'open' })
    const identity = await PodIdentity.generate()
    const t = track(new WebSocketTransport(sigOpts(net, { podId: identity.podId, identity, challengeWaitMs: 5 })))
    await t.open()
    assert.deepEqual(t.registration, { mode: 'open', verified: false })
    const reg = server.received.find((r) => r.data.type === 'register').data
    assert.equal(reg.protocol, undefined)
    assert.equal(reg.signature, undefined)
  })

  it("authentication: 'required' does not fall back", async () => {
    const { net, server } = world({ mode: 'open' })
    const identity = await PodIdentity.generate()
    const t = track(new WebSocketTransport(sigOpts(net, { podId: identity.podId, identity, authentication: 'required', challengeWaitMs: 5, reconnect: { maxAttempts: 0 } })))
    await assert.rejects(t.open(), (e) => e instanceof SignalingAuthError && e.code === 'no-challenge')
    assert.equal(server.received.some((r) => r.data.type === 'register'), false)
  })

  it('without an identity the refusal is a named error and the transport does not keep retrying', async () => {
    const { net, server } = world({ mode: 'authenticated' })
    const t = track(new WebSocketTransport(sigOpts(net, { podId: 'pa', reconnect: { baseMs: 1, maxMs: 1 } })))
    await assert.rejects(t.open(), (e) => e instanceof SignalingAuthRequiredError && e.code === 'auth-required')
    await new Promise((r) => setTimeout(r, 40))
    assert.equal(server.connectionCount, 1, 'a refusal that cannot change is not retried')
    assert.equal(t.ready, false)
  })

  it('refuses a stripped challenge by name (the server will not take the open flow)', async () => {
    const { net } = world({ mode: 'authenticated', challenge: false })
    const identity = await PodIdentity.generate()
    const t = track(new WebSocketTransport(sigOpts(net, { podId: identity.podId, identity, challengeWaitMs: 5, reconnect: { maxAttempts: 0 } })))
    await assert.rejects(t.open(), (e) => e instanceof SignalingAuthError && e.code === 'protocol-unsupported')
  })

  it('a proof relayed to a server with another origin is refused there', async () => {
    const net = createDoubleNetwork()
    net.add('ws://other.test', new SignalingDouble({ mode: 'authenticated', publicOrigin: 'ws://signal.test' }))
    const identity = await PodIdentity.generate()
    const t = track(new WebSocketTransport({ url: 'ws://other.test', protocol: 'signaling', WebSocket: net.WebSocket, podId: identity.podId, identity, reconnect: { maxAttempts: 0 } }))
    await assert.rejects(t.open(), (e) => e.code === 'bad-signature')
  })

  it('the second (peersFromSignaling) connection authenticates too', async () => {
    const net = createDoubleNetwork()
    const relay = net.add('ws://relay.test', new SignalingDouble({ mode: 'open' }))
    const sig = net.add('ws://signal.test', new SignalingDouble({ mode: 'authenticated' }))
    const identity = await PodIdentity.generate()
    const t = track(new WebSocketTransport({
      url: 'ws://relay.test', protocol: 'relay', WebSocket: net.WebSocket, podId: identity.podId, identity,
      signalingUrl: 'ws://signal.test', peersFromSignaling: true,
    }))
    await t.open()
    assert.equal(sig.size, 1)
    assert.equal(sig.received.find((r) => r.data.type === 'register').data.protocol, 2)
    assert.equal(relay.received.find((r) => r.data.type === 'register').data.protocol, undefined, 'the relay dialect is untouched')
  })

  it('reconnecting answers a fresh challenge', async () => {
    const { net, server } = world({ mode: 'authenticated' })
    const identity = await PodIdentity.generate()
    const t = track(new WebSocketTransport(sigOpts(net, { podId: identity.podId, identity, reconnect: { baseMs: 1, maxMs: 1 } })))
    await t.open()
    net.sockets[0]._serverClose()
    await until(() => server.connectionCount === 2 && t.ready && server.size === 1, 're-registration')
    const regs = server.received.filter((r) => r.data.type === 'register')
    assert.equal(regs.length, 2)
    assert.notEqual(regs[0].data.nonce, regs[1].data.nonce)
  })

  it('refuses an identity that is not the pod id', async () => {
    const identity = await PodIdentity.generate()
    assert.throws(() => new WebSocketTransport({ url: 'ws://x', podId: 'other', identity }), /identity/)
  })

  it("authentication: 'required' needs an identity", () => {
    assert.throws(() => new WebSocketTransport({ url: 'ws://x', podId: 'a', authentication: 'required' }), SignalingAuthRequiredError)
  })
})

describe('WebSocketTransport: a displaced connection ("replaced")', () => {
  const quiet = (ms = 40) => new Promise((r) => setTimeout(r, ms))

  it('does not reconnect, says so by name, and the application decides', async () => {
    const { net, server } = world({ mode: 'authenticated', maxConnectionsPerPod: 2 })
    const identity = await PodIdentity.generate()
    const make = () => track(new WebSocketTransport(sigOpts(net, { podId: identity.podId, identity, reconnect: { baseMs: 1, maxMs: 1 } })))
    const first = make()
    const seen = []
    first.onReplaced((info) => seen.push(info))
    await first.open()
    await make().open()
    await make().open() // a third connection of the pod displaces the oldest
    await until(() => seen.length === 1, 'the replaced notice')
    assert.equal(seen[0].kind, 'primary')
    assert.match(seen[0].message, /newer connection/)
    assert.equal(first.replaced?.kind, 'primary')
    await until(() => !first.ready, 'the closed connection')
    const before = server.connectionCount
    await quiet()
    assert.equal(server.connectionCount, before, 'no automatic reconnect after being replaced')
    assert.equal(server.connectionsOf(identity.podId), 2, 'the other two stay')
    // The application may open it again on purpose.
    await first.open()
    assert.equal(first.ready, true)
    assert.equal(first.replaced, null)
  })

  it('a 4409 close with reason "replaced" is enough, even if the error frame never arrived', async () => {
    const { net, server } = world({ mode: 'authenticated' })
    const identity = await PodIdentity.generate()
    const t = track(new WebSocketTransport(sigOpts(net, { podId: identity.podId, identity, reconnect: { baseMs: 1, maxMs: 1 } })))
    const seen = []
    t.onReplaced((info) => seen.push(info))
    await t.open()
    net.sockets[0]._serverClose(4409, 'replaced')
    await until(() => seen.length === 1, 'the replaced notice')
    await quiet()
    assert.equal(server.connectionCount, 1)
  })

  it('other closes still reconnect (4409 with another reason, or a plain drop)', async () => {
    const { net, server } = world({ mode: 'authenticated' })
    const identity = await PodIdentity.generate()
    const t = track(new WebSocketTransport(sigOpts(net, { podId: identity.podId, identity, reconnect: { baseMs: 1, maxMs: 1 } })))
    const seen = []
    t.onReplaced((info) => seen.push(info))
    await t.open()
    net.sockets[0]._serverClose(4409, 'something else')
    await until(() => server.connectionCount === 2 && t.ready, 'a reconnect')
    assert.equal(seen.length, 0)
  })

  it('open mode keeps today\'s behaviour: a second connection for an id is refused ("podId already registered"), open() rejects, and the loser keeps retrying', async () => {
    const { net, server } = world({ mode: 'open' })
    const a = track(new WebSocketTransport(sigOpts(net, { podId: 'same-id' })))
    await a.open()
    const seen = []
    const b = track(new WebSocketTransport(sigOpts(net, { podId: 'same-id', reconnect: { baseMs: 1, maxMs: 1 } })))
    b.onReplaced((info) => seen.push(info))
    await assert.rejects(b.open(), /podId already registered/)
    await until(() => server.connectionCount >= 3, 'the loser retrying')
    assert.equal(seen.length, 0, 'not a "replaced": an older server\'s 4409 carries no such code')
    assert.equal(a.ready, true)
  })

  it('one pod using the same server for its primary and its signalingUrl stays connected on both and receives each message once', async () => {
    const { net, server } = world({ mode: 'authenticated' })
    const identity = await PodIdentity.generate()
    const other = await PodIdentity.generate()
    const t = track(new WebSocketTransport(sigOpts(net, {
      podId: identity.podId, identity, signalingUrl: 'ws://signal.test', peersFromSignaling: true,
    })))
    const got = []
    t.onMessage((m) => got.push(m.n))
    const replaced = []
    t.onReplaced((i) => replaced.push(i))
    await t.open()
    const sender = track(new WebSocketTransport(sigOpts(net, { podId: other.podId, identity: other })))
    await sender.open()
    assert.equal(server.connectionsOf(identity.podId), 2)
    for (let n = 1; n <= 6; n++) sender.send({ type: 'pod:hello', to: identity.podId, n })
    await until(() => got.length >= 6, 'six messages')
    await quiet()
    assert.deepEqual(got, [1, 2, 3, 4, 5, 6], 'each message once, in order, whichever connection is the newest')
    assert.equal(server.connectionsOf(identity.podId), 2, 'neither connection displaced the other')
    assert.equal(replaced.length, 0)
    assert.equal(t.ready, true)
  })
})
