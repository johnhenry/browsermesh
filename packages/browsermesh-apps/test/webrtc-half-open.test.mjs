// Run with: node --import ./test/_setup-globals.mjs --test test/webrtc-half-open.test.mjs
//
// The standing offer handler of createWebRTCTransportFactory() answers inbound offers. How many may be
// connecting at once (not yet open) is bounded, and so is how long one may stay that way: a peer that
// sends offers it never completes cannot hold the node's connections forever.
import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { createWebRTCTransportFactory } from '../src/webrtc-negotiator.mjs'

const tick = () => new Promise((r) => setImmediate(r))

/** Just enough of a WebRTCPeerConnection: opens and closes on demand. */
function fakeConnection(remotePodId) {
  const stateCbs = []
  const conn = {
    remotePodId,
    isOpen: false,
    state: 'connecting',
    bindingFailure: null,
    closes: 0,
    onIceCandidate() {},
    onClose() {},
    onError() {},
    onStateChange(cb) { stateCbs.push(cb) },
    async handleOffer() { return { type: 'answer', sdp: 'a' } },
    open() { conn.isOpen = true; conn.state = 'connected'; for (const cb of stateCbs) cb('connected') },
    close() { conn.closes++; conn.state = 'closed'; conn.isOpen = false; for (const cb of stateCbs) cb('closed') },
  }
  return conn
}

/** A meshManager that keeps one fake connection per (peer, connectionId), as WebRTCMeshManager does. */
function fakeManager() {
  const conns = new Map()
  const key = (p, c) => `${p} ${c}`
  return {
    conns,
    async connectToPeer(p, { connectionId = 'default' } = {}) {
      const k = key(p, connectionId)
      if (!conns.has(k)) conns.set(k, fakeConnection(p))
      return conns.get(k)
    },
    getConnection(p, c = 'default') { return conns.get(key(p, c)) || null },
  }
}

function setup(opts = {}) {
  const meshManager = fakeManager()
  const sent = []
  const handlers = { offer: [] }
  const signaling = {
    send(type, to, payload, connectionId) { sent.push({ type, to, connectionId }) },
    onOffer(cb) { handlers.offer.push(cb) },
    onAnswer() { return () => {} },
    onIce() {},
  }
  const factory = createWebRTCTransportFactory({ localPodId: 'local', meshManager, signaling, ...opts })
  const offer = async (from, connectionId = 'default') => {
    await handlers.offer[0](from, { type: 'offer', sdp: 'o' }, connectionId)
  }
  const answeredTo = () => sent.filter((m) => m.type === 'webrtc-answer').map((m) => m.to)
  return { factory, meshManager, offer, answeredTo }
}

afterEach(() => mock.timers.reset())

describe('half-open inbound connections: defaults', () => {
  it('are generous: 64 connecting at once, 60 s each', () => {
    const { factory } = setup()
    assert.equal(factory.halfOpenInbound.max, 64)
    assert.equal(factory.halfOpenInbound.timeoutMs, 60_000)
    assert.equal(factory.halfOpenInbound.count, 0)
  })

  it('reject nonsense options', () => {
    assert.throws(() => setup({ maxHalfOpenInbound: 0 }), /maxHalfOpenInbound/)
    assert.throws(() => setup({ maxHalfOpenInbound: 1.5 }), /maxHalfOpenInbound/)
    assert.throws(() => setup({ halfOpenTimeoutMs: -1 }), /halfOpenTimeoutMs/)
  })
})

describe('half-open inbound connections: the cap', () => {
  it('answers every offer up to the cap', async () => {
    const { offer, answeredTo, factory } = setup({ maxHalfOpenInbound: 3 })
    for (const p of ['a', 'b', 'c']) await offer(p)
    assert.deepEqual(answeredTo(), ['a', 'b', 'c'])
    assert.equal(factory.halfOpenInbound.count, 3)
  })

  it('past the cap the oldest unfinished connection is closed to make room, and the new offer is answered', async () => {
    const { offer, answeredTo, factory, meshManager } = setup({ maxHalfOpenInbound: 2 })
    await offer('a'); await offer('b'); await offer('c')
    assert.deepEqual(answeredTo(), ['a', 'b', 'c'])
    assert.equal(meshManager.getConnection('a').closes, 1, 'oldest closed')
    assert.equal(meshManager.getConnection('b').closes, 0)
    assert.equal(meshManager.getConnection('c').closes, 0)
    assert.equal(factory.halfOpenInbound.count, 2)
  })

  it('a connection that opened no longer counts', async () => {
    const { offer, factory, meshManager } = setup({ maxHalfOpenInbound: 2 })
    await offer('a'); await offer('b')
    meshManager.getConnection('a').open()
    assert.equal(factory.halfOpenInbound.count, 1)
    await offer('c')
    assert.equal(meshManager.getConnection('b').closes, 0, 'nothing evicted: there was room')
    assert.equal(meshManager.getConnection('a').closes, 0, 'an open connection is never evicted')
  })

  it('an offer repeated for the same peer and connection id takes no second slot', async () => {
    const { offer, factory, meshManager } = setup({ maxHalfOpenInbound: 2 })
    await offer('a'); await offer('a'); await offer('a')
    assert.equal(factory.halfOpenInbound.count, 1)
    await offer('b')
    await offer('a') // the table is full: a repeat must not evict anybody, itself included
    await offer('b')
    assert.equal(factory.halfOpenInbound.count, 2)
    assert.equal(meshManager.getConnection('a').closes, 0)
    assert.equal(meshManager.getConnection('b').closes, 0)
  })

  it('a different connection id of the same peer is a different slot', async () => {
    const { offer, factory } = setup({ maxHalfOpenInbound: 5 })
    await offer('a', 'one'); await offer('a', 'two')
    assert.equal(factory.halfOpenInbound.count, 2)
  })

  it('an offer for a connection that is already open (a renegotiation) is not counted and evicts nothing', async () => {
    const { offer, factory, meshManager } = setup({ maxHalfOpenInbound: 1 })
    await offer('a')
    meshManager.getConnection('a').open()
    await offer('b')
    await offer('a')
    assert.equal(factory.halfOpenInbound.count, 1)
    assert.equal(meshManager.getConnection('b').closes, 0)
  })

  it('a connection that closes on its own frees its slot', async () => {
    const { offer, factory, meshManager } = setup({ maxHalfOpenInbound: 2 })
    await offer('a')
    meshManager.getConnection('a').close()
    assert.equal(factory.halfOpenInbound.count, 0)
  })
})

describe('half-open inbound connections: the deadline', () => {
  it('closes a connection that is still not open when the deadline passes, and frees its slot', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { offer, factory, meshManager } = setup({ halfOpenTimeoutMs: 1000, openTimeoutMs: 600_000 })
    await offer('a')
    mock.timers.tick(999)
    assert.equal(meshManager.getConnection('a').closes, 0)
    mock.timers.tick(1)
    assert.equal(meshManager.getConnection('a').closes, 1)
    assert.equal(factory.halfOpenInbound.count, 0)
  })

  it('does not close a connection that opened in time', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { offer, meshManager } = setup({ halfOpenTimeoutMs: 1000, openTimeoutMs: 600_000 })
    await offer('a')
    meshManager.getConnection('a').open()
    mock.timers.tick(5000)
    assert.equal(meshManager.getConnection('a').closes, 0)
  })

  it('an evicted connection is not closed a second time by its own deadline', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { offer, meshManager } = setup({ maxHalfOpenInbound: 1, halfOpenTimeoutMs: 1000, openTimeoutMs: 600_000 })
    await offer('a'); await offer('b')
    mock.timers.tick(5000)
    assert.equal(meshManager.getConnection('a').closes, 1)
    assert.equal(meshManager.getConnection('b').closes, 1)
  })

  it('Infinity turns the deadline off', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    const { offer, meshManager } = setup({ halfOpenTimeoutMs: Infinity, openTimeoutMs: 600_000 })
    await offer('a')
    mock.timers.tick(10 ** 9)
    assert.equal(meshManager.getConnection('a').closes, 0)
  })
})

describe('half-open inbound connections: a concurrent burst', () => {
  it('never holds more than the cap at once', async () => {
    const { offer, factory } = setup({ maxHalfOpenInbound: 4 })
    await Promise.all(Array.from({ length: 20 }, (_, i) => offer(`p${i}`)))
    await tick()
    assert.ok(factory.halfOpenInbound.count <= 4, `held ${factory.halfOpenInbound.count}`)
  })
})
