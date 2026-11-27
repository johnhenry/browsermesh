// SWIM infection-style dissemination (issue #434, bug 1): an update rides up
// to lambda * ceil(log2(n + 1)) messages, least-transmitted first, so it
// spreads along a chain of seeds instead of dying after one message.
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { SwimMembership, SWIM_PING } from '../src/swarm.mjs'

const INTERVAL = 1000

/** Small seeded PRNG so shuffles (and therefore the tests) are deterministic. */
function seeded(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** An in-process wire; `sent` records every message. */
function makeNet(names, opts = {}) {
  const nodes = new Map()
  const sent = []
  const queue = []
  for (const name of names) {
    nodes.set(name, new SwimMembership({
      localId: name,
      pingIntervalMs: INTERVAL,
      pingTimeoutMs: 400,
      suspectTimeoutMs: 60_000,
      sendFn: (to, msg) => { sent.push({ from: name, to, msg }); queue.push({ from: name, to, msg }) },
      ...opts,
    }))
  }
  const drain = () => {
    while (queue.length) {
      const { from, to, msg } = queue.shift()
      nodes.get(to)?.handleMessage(from, structuredClone(msg))
    }
  }
  const round = () => { mock.timers.tick(INTERVAL); drain() }
  return { nodes, sent, round, drain }
}

const everyoneKnowsEveryone = (net, names) =>
  names.every((a) => names.every((b) => a === b || net.nodes.get(a).getState(b) === 'alive'))

function roundsToConverge(net, names, max) {
  let rounds = 0
  while (!everyoneKnowsEveryone(net, names) && rounds < max) { net.round(); rounds++ }
  return rounds
}

describe('SwimMembership update dissemination', () => {
  let realRandom
  beforeEach(() => {
    mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
    realRandom = Math.random
    Math.random = seeded(1234)
  })
  afterEach(() => {
    Math.random = realRandom
    mock.timers.reset()
  })

  it('a three-node chain a-b-c converges: c learns a', () => {
    const names = ['a', 'b', 'c']
    const net = makeNet(names)
    net.nodes.get('a').addMember('b')
    net.nodes.get('b').addMember('c')
    for (const n of net.nodes.values()) n.start()
    const rounds = roundsToConverge(net, names, 12)
    assert.ok(everyoneKnowsEveryone(net, names), `not converged after ${rounds} rounds`)
    for (const n of net.nodes.values()) n.stop()
  })

  it('an eight-node chain converges within a bounded number of rounds', () => {
    const names = Array.from({ length: 8 }, (_, i) => `n${i}`)
    const net = makeNet(names)
    for (let i = 0; i < names.length - 1; i++) net.nodes.get(names[i]).addMember(names[i + 1])
    for (const n of net.nodes.values()) n.start()
    const rounds = roundsToConverge(net, names, 40)
    assert.ok(everyoneKnowsEveryone(net, names), `not converged after ${rounds} rounds`)
    for (const n of net.nodes.values()) n.stop()
  })

  it('a retired update is not retransmitted forever', () => {
    const net = makeNet(['a', 'b'], { retransmitMultiplier: 1 })
    net.nodes.get('a').addMember('b')
    net.nodes.get('b').addMember('a')
    net.nodes.get('a').addMember('extra')
    for (const n of net.nodes.values()) n.start()
    for (let i = 0; i < 40; i++) net.round()
    const carrying = net.sent.filter((m) => m.from === 'a' && (m.msg.updates ?? []).some((u) => u.podId === 'extra'))
    assert.ok(carrying.length > 0, 'the update is sent at least once')
    assert.ok(carrying.length <= 6, `sent ${carrying.length} times, expected a small bound`)
    const tail = net.sent.slice(-6).flatMap((m) => m.msg.updates ?? [])
    assert.equal(tail.filter((u) => u.podId === 'extra').length, 0, 'retired updates stay retired')
    assert.equal(net.nodes.get('a').toJSON().updateBufferSize, 0, 'the queue empties once everything is retired')
    for (const n of net.nodes.values()) n.stop()
  })

  it('never puts more than maxPiggyback updates on one message', () => {
    const net = makeNet(['a', 'b'], { maxPiggyback: 3 })
    const a = net.nodes.get('a')
    a.addMember('b')
    for (let i = 0; i < 20; i++) a.addMember(`extra-${i}`)
    a.start()
    for (let i = 0; i < 10; i++) net.round()
    assert.ok(net.sent.length > 0)
    for (const { msg } of net.sent) assert.ok((msg.updates ?? []).length <= 3)
    a.stop()
  })

  it('prefers the least-transmitted updates', () => {
    const net = makeNet(['a', 'b'], { maxPiggyback: 1, retransmitMultiplier: 3 })
    const a = net.nodes.get('a')
    a.addMember('b')
    a.addMember('old')
    a.start()
    net.round()
    net.round()
    a.addMember('fresh')
    const before = net.sent.length
    net.round()
    const next = net.sent.slice(before).find((m) => m.from === 'a')
    assert.equal(next.msg.updates.length, 1)
    assert.equal(next.msg.updates[0].podId, 'fresh', 'a fresh update beats ones already sent')
    a.stop()
  })

  it('bounds the update queue', () => {
    const net = makeNet(['a'])
    const a = net.nodes.get('a')
    for (let i = 0; i < 1000; i++) a.addMember(`m-${i}`)
    assert.ok(a.toJSON().updateBufferSize <= 128)
  })

  it('applying the same update twice is idempotent', () => {
    const net = makeNet(['a', 'b'])
    const a = net.nodes.get('a')
    let joins = 0
    a.onJoin = () => { joins++ }
    const update = { podId: 'x', state: 'alive', incarnation: 2 }
    a.handleMessage('b', { type: SWIM_PING, from: 'b', seq: 1, updates: [update] })
    const size = a.toJSON().updateBufferSize
    const joinsAfterFirst = joins
    a.handleMessage('b', { type: SWIM_PING, from: 'b', seq: 2, updates: [update, update] })
    assert.equal(joins, joinsAfterFirst, 'no second join')
    assert.equal(a.toJSON().updateBufferSize, size)
    assert.equal(a.getState('x'), 'alive')
  })

  it('left and dead beat an equal alive; only a higher incarnation rejoins', () => {
    const net = makeNet(['a'])
    const a = net.nodes.get('a')
    const ping = (u, seq) => a.handleMessage('p', { type: SWIM_PING, from: 'p', seq, updates: [u] })
    ping({ podId: 'm', state: 'alive', incarnation: 1 }, 1)
    ping({ podId: 'm', state: 'left', incarnation: 1 }, 2)
    assert.equal(a.getState('m'), 'left')
    ping({ podId: 'm', state: 'alive', incarnation: 1 }, 3)
    assert.equal(a.getState('m'), 'left', 'same-incarnation alive does not undo left')
    ping({ podId: 'm', state: 'alive', incarnation: 0 }, 4)
    assert.equal(a.getState('m'), 'left')
    ping({ podId: 'm', state: 'alive', incarnation: 2 }, 5)
    assert.equal(a.getState('m'), 'alive')
    ping({ podId: 'd', state: 'alive', incarnation: 1 }, 6)
    ping({ podId: 'd', state: 'dead', incarnation: 1 }, 7)
    assert.equal(a.getState('d'), 'dead')
  })

  it('a left update spreads along a chain', () => {
    const names = ['a', 'b', 'c']
    const net = makeNet(names)
    net.nodes.get('a').addMember('b')
    net.nodes.get('b').addMember('c')
    for (const n of net.nodes.values()) n.start()
    roundsToConverge(net, names, 12)
    assert.ok(everyoneKnowsEveryone(net, names))
    net.nodes.get('c').removeMember('a')
    for (let i = 0; i < 12; i++) net.round()
    assert.equal(net.nodes.get('b').getState('a'), 'left')
    for (const n of net.nodes.values()) n.stop()
  })

  it('rejects nonsense options', () => {
    const sendFn = () => {}
    assert.throws(() => new SwimMembership({ localId: 'a', sendFn, maxPiggyback: 0 }))
    assert.throws(() => new SwimMembership({ localId: 'a', sendFn, retransmitMultiplier: -1 }))
  })
})
