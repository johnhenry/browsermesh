// Run with: node --import ./test/_setup-globals.mjs --test test/cross-origin.test.mjs
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  TRUST_LEVELS,
  XO_REQUEST,
  XO_RESPONSE,
  XO_HANDSHAKE,
  XO_HANDSHAKE_ACK,
  RateLimiter,
  CrossOriginBridge,
  CrossOriginHandshake,
} from '../src/cross-origin.mjs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(data, origin = 'https://example.com', source = null) {
  return { data, origin, source }
}

function makePostMessageTarget() {
  const sent = []
  return {
    sent,
    postMessage(msg, origin) { sent.push({ msg, origin }) },
  }
}

// ---------------------------------------------------------------------------
// TRUST_LEVELS
// ---------------------------------------------------------------------------

describe('TRUST_LEVELS', () => {
  it('has all expected levels', () => {
    assert.equal(TRUST_LEVELS.ISOLATED, 'isolated')
    assert.equal(TRUST_LEVELS.VERIFIED, 'verified')
    assert.equal(TRUST_LEVELS.TRUSTED, 'trusted')
    assert.equal(TRUST_LEVELS.LINKED, 'linked')
    assert.equal(TRUST_LEVELS.PINNED, 'pinned')
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(TRUST_LEVELS))
  })

  it('has exactly 5 levels', () => {
    assert.equal(Object.keys(TRUST_LEVELS).length, 5)
  })
})

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('XO_REQUEST is mesh-xo-request', () => {
    assert.equal(XO_REQUEST, 'mesh-xo-request')
  })

  it('XO_RESPONSE is mesh-xo-response', () => {
    assert.equal(XO_RESPONSE, 'mesh-xo-response')
  })

  it('XO_HANDSHAKE is mesh-xo-handshake', () => {
    assert.equal(XO_HANDSHAKE, 'mesh-xo-handshake')
  })

  it('XO_HANDSHAKE_ACK is mesh-xo-handshake-ack', () => {
    assert.equal(XO_HANDSHAKE_ACK, 'mesh-xo-handshake-ack')
  })
})

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

describe('RateLimiter', () => {
  it('check returns true initially for any peer', () => {
    const rl = new RateLimiter({ maxPerWindow: 5, windowMs: 60000 })
    assert.equal(rl.check('peer-a'), true)
    assert.equal(rl.check('peer-b'), true)
  })

  it('after recording maxPerWindow times, check returns false', () => {
    const rl = new RateLimiter({ maxPerWindow: 3, windowMs: 60000 })
    rl.record('peer-a')
    rl.record('peer-a')
    rl.record('peer-a')
    assert.equal(rl.check('peer-a'), false)
    // Other peers unaffected
    assert.equal(rl.check('peer-b'), true)
  })

  it('reset clears all counters', () => {
    const rl = new RateLimiter({ maxPerWindow: 1, windowMs: 60000 })
    rl.record('peer-a')
    assert.equal(rl.check('peer-a'), false)
    rl.reset()
    assert.equal(rl.check('peer-a'), true)
  })

  it('resetPeer clears only the specified peer', () => {
    const rl = new RateLimiter({ maxPerWindow: 1, windowMs: 60000 })
    rl.record('peer-a')
    rl.record('peer-b')
    assert.equal(rl.check('peer-a'), false)
    assert.equal(rl.check('peer-b'), false)
    rl.resetPeer('peer-a')
    assert.equal(rl.check('peer-a'), true)
    assert.equal(rl.check('peer-b'), false)
  })

  it('exposes config via getters', () => {
    const rl = new RateLimiter({ maxPerWindow: 42, windowMs: 1234 })
    assert.equal(rl.maxPerWindow, 42)
    assert.equal(rl.windowMs, 1234)
  })
})

// ---------------------------------------------------------------------------
// CrossOriginBridge -- constructor
// ---------------------------------------------------------------------------

describe('CrossOriginBridge', () => {
  it('constructor requires localPodId', () => {
    assert.throws(() => new CrossOriginBridge(), /localPodId is required/)
    assert.throws(() => new CrossOriginBridge({}), /localPodId is required/)
  })

  it('exposes localPodId and peerCount', () => {
    const b = new CrossOriginBridge({ localPodId: 'pod-1' })
    assert.equal(b.localPodId, 'pod-1')
    assert.equal(b.peerCount, 0)
  })
})

// ---------------------------------------------------------------------------
// CrossOriginBridge -- peer management
// ---------------------------------------------------------------------------

describe('CrossOriginBridge peer management', () => {
  let bridge

  beforeEach(() => {
    bridge = new CrossOriginBridge({ localPodId: 'pod-local' })
  })

  it('registerPeer requires peerId and origin', () => {
    assert.throws(() => bridge.registerPeer(''), /peerId is required/)
    assert.throws(() => bridge.registerPeer('p1'), /origin is required/)
    assert.throws(() => bridge.registerPeer('p1', {}), /origin is required/)
  })

  it('registerPeer + listPeers round trip', () => {
    bridge.registerPeer('p1', { origin: 'https://a.com', trust: TRUST_LEVELS.TRUSTED })
    bridge.registerPeer('p2', { origin: 'https://b.com', allowedMethods: ['ping'] })
    assert.equal(bridge.peerCount, 2)

    const peers = bridge.listPeers()
    assert.equal(peers.length, 2)

    const p1 = peers.find((p) => p.peerId === 'p1')
    assert.equal(p1.origin, 'https://a.com')
    assert.equal(p1.trust, TRUST_LEVELS.TRUSTED)

    const p2 = peers.find((p) => p.peerId === 'p2')
    assert.equal(p2.origin, 'https://b.com')
    assert.equal(p2.trust, TRUST_LEVELS.VERIFIED)  // default
    assert.deepEqual(p2.allowedMethods, ['ping'])
  })

  it('removePeer returns true for existing, false for missing', () => {
    bridge.registerPeer('p1', { origin: 'https://a.com' })
    assert.equal(bridge.removePeer('p1'), true)
    assert.equal(bridge.removePeer('p1'), false)
    assert.equal(bridge.peerCount, 0)
  })

  it('getPeer returns info or null', () => {
    bridge.registerPeer('p1', { origin: 'https://a.com' })
    const info = bridge.getPeer('p1')
    assert.equal(info.peerId, 'p1')
    assert.equal(info.origin, 'https://a.com')
    assert.equal(bridge.getPeer('nope'), null)
  })

  it('setTrust updates trust level', () => {
    bridge.registerPeer('p1', { origin: 'https://a.com' })
    bridge.setTrust('p1', TRUST_LEVELS.TRUSTED)
    assert.equal(bridge.getPeer('p1').trust, TRUST_LEVELS.TRUSTED)
  })

  it('setTrust throws for unknown peer or invalid trust', () => {
    assert.throws(() => bridge.setTrust('nope', TRUST_LEVELS.TRUSTED), /not registered/)
    bridge.registerPeer('p1', { origin: 'https://a.com' })
    assert.throws(() => bridge.setTrust('p1', 'bogus'), /Unknown trust level/)
  })
})

// ---------------------------------------------------------------------------
// CrossOriginBridge -- method handlers
// ---------------------------------------------------------------------------

describe('CrossOriginBridge method handlers', () => {
  let bridge

  beforeEach(() => {
    bridge = new CrossOriginBridge({ localPodId: 'pod-local' })
  })

  it('setMethodHandler + listMethods', () => {
    bridge.setMethodHandler('ping', () => 'pong')
    bridge.setMethodHandler('echo', (p) => p)
    assert.deepEqual(bridge.listMethods().sort(), ['echo', 'ping'])
  })

  it('setMethodHandler rejects non-functions', () => {
    assert.throws(() => bridge.setMethodHandler('x', 'not-a-fn'), /handler must be a function/)
  })

  it('removeMethodHandler', () => {
    bridge.setMethodHandler('ping', () => 'pong')
    assert.equal(bridge.removeMethodHandler('ping'), true)
    assert.equal(bridge.removeMethodHandler('ping'), false)
    assert.deepEqual(bridge.listMethods(), [])
  })
})

// ---------------------------------------------------------------------------
// CrossOriginBridge -- handleMessage dispatches to handler
// ---------------------------------------------------------------------------

describe('CrossOriginBridge handleMessage', () => {
  let bridge
  let responseTarget

  beforeEach(() => {
    bridge = new CrossOriginBridge({ localPodId: 'pod-local' })
    bridge.registerPeer('pod-remote', { origin: 'https://example.com' })
    responseTarget = makePostMessageTarget()
  })

  it('dispatches to registered handler and sends response', () => {
    bridge.setMethodHandler('ping', () => 'pong')

    const event = makeEvent(
      { type: XO_REQUEST, requestId: 'r1', fromPodId: 'pod-remote', method: 'ping', params: {} },
      'https://example.com',
      responseTarget,
    )
    bridge.handleMessage(event)

    assert.equal(responseTarget.sent.length, 1)
    const resp = responseTarget.sent[0].msg
    assert.equal(resp.type, XO_RESPONSE)
    assert.equal(resp.requestId, 'r1')
    assert.equal(resp.result, 'pong')
    assert.equal(resp.error, null)
  })

  it('sends error for unknown method', () => {
    const event = makeEvent(
      { type: XO_REQUEST, requestId: 'r2', fromPodId: 'pod-remote', method: 'unknown', params: {} },
      'https://example.com',
      responseTarget,
    )
    bridge.handleMessage(event)

    assert.equal(responseTarget.sent.length, 1)
    assert.ok(responseTarget.sent[0].msg.error.includes('not found'))
  })

  it('ignores non-mesh messages', () => {
    bridge.setMethodHandler('ping', () => 'pong')

    // null data
    bridge.handleMessage(makeEvent(null))
    // non-object data
    bridge.handleMessage(makeEvent('hello'))
    // missing type
    bridge.handleMessage(makeEvent({ foo: 1 }))
    // wrong type prefix
    bridge.handleMessage(makeEvent({ type: 'other-request' }))
    // No response should have been sent
    assert.equal(responseTarget.sent.length, 0)
  })

  it('rejects messages with origin mismatch', () => {
    bridge.setMethodHandler('ping', () => 'pong')

    const event = makeEvent(
      { type: XO_REQUEST, requestId: 'r3', fromPodId: 'pod-remote', method: 'ping', params: {} },
      'https://evil.com',  // wrong origin
      responseTarget,
    )
    bridge.handleMessage(event)
    assert.equal(responseTarget.sent.length, 0)
  })

  it('enforces method allowlist for VERIFIED peers', () => {
    bridge.removePeer('pod-remote')
    bridge.registerPeer('pod-remote', {
      origin: 'https://example.com',
      trust: TRUST_LEVELS.VERIFIED,
      allowedMethods: ['ping'],
    })
    bridge.setMethodHandler('ping', () => 'pong')
    bridge.setMethodHandler('secret', () => 'nope')

    // Allowed method works
    bridge.handleMessage(makeEvent(
      { type: XO_REQUEST, requestId: 'r4', fromPodId: 'pod-remote', method: 'ping', params: {} },
      'https://example.com',
      responseTarget,
    ))
    assert.equal(responseTarget.sent.length, 1)
    assert.equal(responseTarget.sent[0].msg.result, 'pong')

    // Disallowed method blocked
    bridge.handleMessage(makeEvent(
      { type: XO_REQUEST, requestId: 'r5', fromPodId: 'pod-remote', method: 'secret', params: {} },
      'https://example.com',
      responseTarget,
    ))
    assert.equal(responseTarget.sent.length, 2)
    assert.ok(responseTarget.sent[1].msg.error.includes('not allowed'))
  })

  it('rate limiting blocks excessive messages', () => {
    const rl = new RateLimiter({ maxPerWindow: 2, windowMs: 60000 })
    const b = new CrossOriginBridge({ localPodId: 'pod-local', rateLimiter: rl })
    b.registerPeer('pod-remote', { origin: 'https://example.com' })
    b.setMethodHandler('ping', () => 'pong')

    const mkReq = (id) => makeEvent(
      { type: XO_REQUEST, requestId: id, fromPodId: 'pod-remote', method: 'ping', params: {} },
      'https://example.com',
      responseTarget,
    )

    b.handleMessage(mkReq('a1'))
    b.handleMessage(mkReq('a2'))
    b.handleMessage(mkReq('a3'))  // should be dropped

    // Only 2 responses should be sent
    assert.equal(responseTarget.sent.length, 2)
  })
})

// ---------------------------------------------------------------------------
// CrossOriginBridge -- send
// ---------------------------------------------------------------------------

describe('CrossOriginBridge send', () => {
  it('throws for unregistered peer', async () => {
    const b = new CrossOriginBridge({ localPodId: 'pod-1' })
    await assert.rejects(() => b.send('nope', 'ping', {}, null), /not registered/)
  })

  it('throws for isolated peer', async () => {
    const b = new CrossOriginBridge({ localPodId: 'pod-1' })
    b.registerPeer('p1', { origin: 'https://a.com', trust: TRUST_LEVELS.ISOLATED })
    await assert.rejects(() => b.send('p1', 'ping', {}, null), /isolated/)
  })

  it('posts message to target', () => {
    const b = new CrossOriginBridge({ localPodId: 'pod-1', defaultTimeout: 0 })
    b.registerPeer('p1', { origin: 'https://a.com', trust: TRUST_LEVELS.TRUSTED })
    const target = makePostMessageTarget()

    // Don't await -- we just want to verify the postMessage was called
    b.send('p1', 'ping', { value: 1 }, target, { timeout: 0 })

    assert.equal(target.sent.length, 1)
    assert.equal(target.sent[0].msg.type, XO_REQUEST)
    assert.equal(target.sent[0].msg.method, 'ping')
    assert.deepEqual(target.sent[0].msg.params, { value: 1 })
    assert.equal(target.sent[0].origin, 'https://a.com')
  })
})

// ---------------------------------------------------------------------------
// CrossOriginBridge -- response handling
// ---------------------------------------------------------------------------

describe('CrossOriginBridge response handling', () => {
  it('resolves pending request on success response', async () => {
    const b = new CrossOriginBridge({ localPodId: 'pod-1' })
    b.registerPeer('p1', { origin: 'https://a.com', trust: TRUST_LEVELS.TRUSTED })
    const target = makePostMessageTarget()

    const promise = b.send('p1', 'add', { a: 1, b: 2 }, target)

    // Simulate response
    const requestId = target.sent[0].msg.requestId
    b.handleMessage(makeEvent(
      { type: XO_RESPONSE, requestId, result: 3, error: null },
      'https://a.com',
    ))

    const result = await promise
    assert.equal(result, 3)
  })

  it('rejects pending request on error response', async () => {
    const b = new CrossOriginBridge({ localPodId: 'pod-1' })
    b.registerPeer('p1', { origin: 'https://a.com', trust: TRUST_LEVELS.TRUSTED })
    const target = makePostMessageTarget()

    const promise = b.send('p1', 'fail', {}, target)

    const requestId = target.sent[0].msg.requestId
    b.handleMessage(makeEvent(
      { type: XO_RESPONSE, requestId, result: null, error: 'boom' },
      'https://a.com',
    ))

    await assert.rejects(promise, /boom/)
  })
})

// ---------------------------------------------------------------------------
// CrossOriginBridge -- destroy
// ---------------------------------------------------------------------------

describe('CrossOriginBridge destroy', () => {
  it('clears peers, handlers, and rejects pending', async () => {
    const b = new CrossOriginBridge({ localPodId: 'pod-1' })
    b.registerPeer('p1', { origin: 'https://a.com', trust: TRUST_LEVELS.TRUSTED })
    b.setMethodHandler('ping', () => 'pong')
    const target = makePostMessageTarget()

    const promise = b.send('p1', 'ping', {}, target)
    b.destroy()

    assert.equal(b.peerCount, 0)
    assert.deepEqual(b.listMethods(), [])
    await assert.rejects(promise, /destroyed/)
  })
})

// ---------------------------------------------------------------------------
// CrossOriginHandshake
// ---------------------------------------------------------------------------

describe('CrossOriginHandshake', () => {
  it('accept returns null for non-handshake events', async () => {
    const result1 = await CrossOriginHandshake.accept(makeEvent(null))
    assert.equal(result1, null)

    const result2 = await CrossOriginHandshake.accept(makeEvent({ type: 'other' }))
    assert.equal(result2, null)

    const result3 = await CrossOriginHandshake.accept(makeEvent({ type: XO_RESPONSE }))
    assert.equal(result3, null)
  })

  it('accept sends ack back via event.source', async () => {
    const source = makePostMessageTarget()
    const event = makeEvent(
      { type: XO_HANDSHAKE, peerId: 'remote-1' },
      'https://remote.com',
      source,
    )

    const result = await CrossOriginHandshake.accept(event, { localPodId: 'local-1' })

    assert.ok(result)
    assert.equal(result.peerId, 'remote-1')
    assert.equal(result.port, null)

    // Verify the ack was sent
    assert.equal(source.sent.length, 1)
    assert.equal(source.sent[0].msg.type, XO_HANDSHAKE_ACK)
    assert.equal(source.sent[0].msg.peerId, 'local-1')
    assert.equal(source.sent[0].origin, 'https://remote.com')
  })

  it('accept works without event.source', async () => {
    const event = makeEvent(
      { type: XO_HANDSHAKE, peerId: 'remote-2' },
      'https://remote.com',
      null,
    )

    const result = await CrossOriginHandshake.accept(event)
    assert.ok(result)
    assert.equal(result.peerId, 'remote-2')
  })
})
