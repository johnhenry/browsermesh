// SignalingClient against the signalling server's authenticated protocol
// (protocol 2) and its open mode, using a double that follows the server's
// own messages (tests/support/signaling-double.mjs).
// Run with: node --import ./test/_setup-globals.mjs --test test/signaling-auth.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { SignalingClient, SignalingAuthError, SignalingAuthRequiredError, fetchIceServers } from '../src/handshake.mjs'
import { SignalingDouble, createDoubleNetwork, registrationMessage } from '../../../tests/support/signaling-double.mjs'

const URL_AUTH = 'ws://signal.test'

function setup(doubleOpts = {}, url = URL_AUTH) {
  const net = createDoubleNetwork()
  const server = net.add(url, new SignalingDouble(doubleOpts))
  return { net, server, url }
}

function once(client, event) {
  return new Promise((resolve) => { const off = client.on(event, (d, f) => { off(); resolve({ d, f }) }) })
}

describe('SignalingClient: protocol 2', () => {
  it('answers the challenge with a key-bound signature and registers verified', async () => {
    const { net, server, url } = setup({ mode: 'authenticated', publicOrigin: 'ws://signal.test' })
    const identity = await PodIdentity.generate()
    const c = new SignalingClient({ url, localPodId: identity.podId, identity, _WebSocket: net.WebSocket })
    await c.connect()
    assert.equal(c.registration.mode, 'authenticated')
    assert.equal(c.registration.verified, true)
    assert.equal(server.size, 1)
    const reg = server.received.find((r) => r.data.type === 'register').data
    assert.equal(reg.protocol, 2)
    assert.equal(reg.podId, identity.podId)
    c.disconnect()
  })

  it('signs the origin of its own URL, not the one the challenge names', async () => {
    // The server believes its origin is ws://signal.test; a client that was
    // pointed at another host must not be accepted by relaying a proof.
    const net = createDoubleNetwork()
    const server = net.add('ws://other.test', new SignalingDouble({ mode: 'authenticated', publicOrigin: 'ws://signal.test' }))
    const identity = await PodIdentity.generate()
    const c = new SignalingClient({ url: 'ws://other.test', localPodId: identity.podId, identity, _WebSocket: net.WebSocket })
    await assert.rejects(c.connect(), (e) => e instanceof SignalingAuthError && e.code === 'bad-signature')
    assert.equal(server.size, 0)
  })

  it('an explicit origin is what gets signed (server behind a different URL)', async () => {
    const net = createDoubleNetwork()
    net.add('ws://internal.test', new SignalingDouble({ mode: 'authenticated', publicOrigin: 'wss://signal.example.org' }))
    const identity = await PodIdentity.generate()
    const c = new SignalingClient({ url: 'ws://internal.test', origin: 'wss://signal.example.org', localPodId: identity.podId, identity, _WebSocket: net.WebSocket })
    await c.connect()
    assert.equal(c.registration.verified, true)
    c.disconnect()
  })

  it('refuses at construction when the identity is not the pod id', async () => {
    const identity = await PodIdentity.generate()
    assert.throws(
      () => new SignalingClient({ url: URL_AUTH, localPodId: 'someone-else', identity }),
      /identity/,
    )
  })

  it('without an identity, an authenticated server gives a named error', async () => {
    const { net, url } = setup({ mode: 'authenticated' })
    const c = new SignalingClient({ url, localPodId: 'a'.repeat(43), waitForRegistration: true, _WebSocket: net.WebSocket })
    await assert.rejects(c.connect(), (e) => e instanceof SignalingAuthRequiredError && e.code === 'auth-required')
    assert.equal(c.connected, false)
  })

  it('without an identity and without waiting, the same refusal is announced as an auth-error event', async () => {
    const { net, url } = setup({ mode: 'authenticated' })
    const c = new SignalingClient({ url, localPodId: 'a'.repeat(43), _WebSocket: net.WebSocket })
    const seen = once(c, 'auth-error')
    await c.connect()
    const { d } = await seen
    assert.ok(d instanceof SignalingAuthRequiredError)
    assert.equal(c.lastAuthError, d)
  })

  it('a challenge for a protocol this client does not speak is refused by name', async () => {
    const { net, server, url } = setup({ mode: 'authenticated' })
    const identity = await PodIdentity.generate()
    const orig = server.connect.bind(server)
    server.connect = (ws) => { ws._serverSend({ type: 'challenge', protocol: 3, purpose: 'register', origin: url, nonce: 'n', ttlMs: 1000 }); void orig }
    const c = new SignalingClient({ url, localPodId: identity.podId, identity, _WebSocket: net.WebSocket })
    await assert.rejects(c.connect(), (e) => e instanceof SignalingAuthError && e.code === 'protocol-unsupported')
  })

  it('falls back to the open flow against an open-mode server, and says so', async () => {
    const { net, server, url } = setup({ mode: 'open' })
    const identity = await PodIdentity.generate()
    const c = new SignalingClient({ url, localPodId: identity.podId, identity, challengeWaitMs: 5, _WebSocket: net.WebSocket })
    await c.connect()
    assert.equal(c.registration.mode, 'open')
    assert.equal(c.registration.verified, false)
    const reg = server.received.find((r) => r.data.type === 'register').data
    assert.equal(reg.protocol, undefined)
    assert.equal(reg.signature, undefined)
    c.disconnect()
  })

  it('an older server (no mode or verified in registered) still registers', async () => {
    const { net, server, url } = setup({ mode: 'open' })
    const identity = await PodIdentity.generate()
    const origReceive = server.receive.bind(server)
    server.receive = async (ws, data) => {
      if (data.type === 'register') { ws.podId = data.podId; ws._serverSend({ type: 'registered', podId: data.podId }); return }
      return origReceive(ws, data)
    }
    const c = new SignalingClient({ url, localPodId: identity.podId, identity, challengeWaitMs: 5, _WebSocket: net.WebSocket })
    await c.connect()
    assert.equal(c.registration.mode, 'open')
    assert.equal(c.registration.verified, false)
    c.disconnect()
  })

  it("authentication: 'required' never falls back to the open flow", async () => {
    const { net, server, url } = setup({ mode: 'open' })
    const identity = await PodIdentity.generate()
    const c = new SignalingClient({ url, localPodId: identity.podId, identity, authentication: 'required', challengeWaitMs: 5, _WebSocket: net.WebSocket })
    await assert.rejects(c.connect(), (e) => e instanceof SignalingAuthError && e.code === 'no-challenge')
    assert.equal(server.size, 0)
    assert.equal(server.received.some((r) => r.data.type === 'register'), false)
  })

  it("authentication: 'required' without an identity is refused up front", () => {
    assert.throws(() => new SignalingClient({ url: URL_AUTH, localPodId: 'a', authentication: 'required' }), SignalingAuthRequiredError)
  })

  it("authentication: 'off' with an identity registers the open way", async () => {
    const { net, server, url } = setup({ mode: 'open' })
    const identity = await PodIdentity.generate()
    const c = new SignalingClient({ url, localPodId: identity.podId, identity, authentication: 'off', _WebSocket: net.WebSocket })
    await c.connect()
    assert.equal(server.received.find((r) => r.data.type === 'register').data.protocol, undefined)
    c.disconnect()
  })

  it('a stripped challenge in auto mode ends in a named refusal from the authenticated server, not a hang', async () => {
    const { net, url } = setup({ mode: 'authenticated', challenge: false })
    const identity = await PodIdentity.generate()
    const c = new SignalingClient({ url, localPodId: identity.podId, identity, challengeWaitMs: 5, _WebSocket: net.WebSocket })
    await assert.rejects(c.connect(), (e) => e instanceof SignalingAuthError && e.code === 'protocol-unsupported')
  })

  it('an expired challenge is a named error', async () => {
    let t = 0
    const { net, url } = setup({ mode: 'authenticated', now: () => t, nonceTtlMs: 10 })
    const identity = await PodIdentity.generate()
    const slow = {
      podId: identity.podId,
      rawPublicKey: () => identity.rawPublicKey(),
      sign: async (d) => { t += 1000; return identity.sign(d) },
    }
    const c = new SignalingClient({ url, localPodId: identity.podId, identity: slow, _WebSocket: net.WebSocket })
    await assert.rejects(c.connect(), (e) => e instanceof SignalingAuthError && e.code === 'challenge-expired')
  })

  it('a signature over another pod id is refused by the server and reported by name', async () => {
    const { net, url } = setup({ mode: 'authenticated' })
    const a = await PodIdentity.generate()
    const b = await PodIdentity.generate()
    // Identity whose key is b's but whose id claims a's: the binding check must fail server-side.
    const liar = { podId: a.podId, rawPublicKey: () => b.rawPublicKey(), sign: (d) => b.sign(d) }
    const c = new SignalingClient({ url, localPodId: a.podId, identity: liar, _WebSocket: net.WebSocket })
    await assert.rejects(c.connect(), (e) => e instanceof SignalingAuthError && e.code === 'pod-id-mismatch')
  })

  it('signs exactly the registration message the server verifies', async () => {
    const { net, server, url } = setup({ mode: 'authenticated', publicOrigin: 'ws://signal.test' })
    const identity = await PodIdentity.generate()
    const c = new SignalingClient({ url, localPodId: identity.podId, identity, _WebSocket: net.WebSocket })
    await c.connect()
    const reg = server.received.find((r) => r.data.type === 'register').data
    const key = await crypto.subtle.importKey('raw', Buffer.from(reg.pubKey, 'base64'), { name: 'Ed25519' }, false, ['verify'])
    const msg = registrationMessage({ purpose: 'register', origin: 'ws://signal.test', podId: identity.podId, nonce: reg.nonce })
    assert.equal(await crypto.subtle.verify('Ed25519', key, Buffer.from(reg.signature, 'base64'), new TextEncoder().encode(msg)), true)
    c.disconnect()
  })
})

describe('SignalingClient: verified and sourceVerified', () => {
  it('hands the server-stamped sourceVerified to listeners, never the sender-supplied one', async () => {
    const { net, url } = setup({ mode: 'authenticated' })
    const ia = await PodIdentity.generate()
    const ib = await PodIdentity.generate()
    const a = new SignalingClient({ url, localPodId: ia.podId, identity: ia, _WebSocket: net.WebSocket })
    const b = new SignalingClient({ url, localPodId: ib.podId, identity: ib, _WebSocket: net.WebSocket })
    await a.connect(); await b.connect()
    const seenFull = once(b, 'offer')
    a.send(ib.podId, 'offer', { offer: { sdp: 'x' }, sourceVerified: false })
    const { d, f } = await seenFull
    assert.deepEqual(d.offer, { sdp: 'x' })
    assert.equal(f, ia.podId)
    assert.equal(d.sourceVerified, true)
    assert.equal(b.isSourceVerified(d), true)
    a.disconnect(); b.disconnect()
  })

  it('open mode: forwarded messages are not verified', async () => {
    const { net, url } = setup({ mode: 'open' })
    const a = new SignalingClient({ url, localPodId: 'pa', _WebSocket: net.WebSocket })
    const b = new SignalingClient({ url, localPodId: 'pb', _WebSocket: net.WebSocket })
    await a.connect(); await b.connect()
    const seen = once(b, 'offer')
    a.send('pb', 'offer', { offer: { sdp: 'x' } })
    const { d } = await seen
    assert.equal(d.sourceVerified, false)
    assert.equal(b.isSourceVerified(d), false)
    a.disconnect(); b.disconnect()
  })

  it('a message with no sourceVerified at all (an older server) is not verified', async () => {
    const { net, url } = setup({ mode: 'open' })
    const b = new SignalingClient({ url, localPodId: 'pb', _WebSocket: net.WebSocket })
    assert.equal(b.isSourceVerified({ type: 'offer', source: 'x' }), false)
    assert.equal(b.isSourceVerified({ type: 'offer', source: 'x', sourceVerified: 'true' }), false)
    void net; void url
  })
})

describe('fetchIceServers', () => {
  function fakeFetch(handler) {
    const calls = []
    const f = async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init) }
    f.calls = calls
    return f
  }
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

  it('sends the token as a Bearer header and returns the list', async () => {
    const f = fakeFetch(() => json(200, [{ urls: 'stun:x' }]))
    const list = await fetchIceServers({ url: 'https://signal.example/ice-servers', token: 't0k', fetch: f })
    assert.deepEqual(list, [{ urls: 'stun:x' }])
    assert.equal(f.calls[0].init.headers.Authorization, 'Bearer t0k')
  })

  it('without a token sends no Authorization header (same-origin callers)', async () => {
    const f = fakeFetch(() => json(200, []))
    await fetchIceServers({ url: '/ice-servers', fetch: f })
    assert.equal(f.calls[0].init.headers?.Authorization, undefined)
  })

  it('derives the http(s) endpoint from a ws(s) signalling URL', async () => {
    const f = fakeFetch(() => json(200, []))
    await fetchIceServers({ signalingUrl: 'wss://signal.example.org', fetch: f })
    assert.equal(f.calls[0].url, 'https://signal.example.org/ice-servers')
  })

  it('names the refusal: 401 and 429 are distinct errors', async () => {
    await assert.rejects(fetchIceServers({ url: 'https://s/ice-servers', fetch: fakeFetch(() => json(401, {})) }), (e) => e.code === 'ice-unauthorized')
    await assert.rejects(fetchIceServers({ url: 'https://s/ice-servers', fetch: fakeFetch(() => json(429, {})) }), (e) => e.code === 'ice-rate-limited')
  })

  it('rejects a body that is not a list of ICE servers', async () => {
    await assert.rejects(fetchIceServers({ url: 'https://s/ice-servers', fetch: fakeFetch(() => json(200, { nope: 1 })) }), (e) => e.code === 'ice-bad-response')
  })

  it('does not follow redirects with the token', async () => {
    const f = fakeFetch(() => json(200, []))
    await fetchIceServers({ url: 'https://s/ice-servers', token: 't', fetch: f })
    assert.equal(f.calls[0].init.redirect, 'error')
  })

  it('refuses to send a token over plain http to a non-loopback host', async () => {
    const f = fakeFetch(() => json(200, []))
    await assert.rejects(fetchIceServers({ url: 'http://signal.example.org/ice-servers', token: 't', fetch: f }), (e) => e.code === 'ice-insecure-token')
    assert.equal(f.calls.length, 0)
    await fetchIceServers({ url: 'http://127.0.0.1:1/ice-servers', token: 't', fetch: f })
    assert.equal(f.calls.length, 1)
  })
})
