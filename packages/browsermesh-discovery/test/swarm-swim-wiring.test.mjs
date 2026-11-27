// SwarmCoordinator <-> SwimMembership wiring (issue #434, bug 2): SWIM's
// `left` and `dead` both drop the member from the coordinator, a higher-
// incarnation `alive` brings it back, and stop() unhooks everything.
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { SwarmCoordinator, SwimMembership, SWIM_PING } from '../src/swarm.mjs'

const gossip = (swim, updates, seq = 1) =>
  swim.handleMessage('peer', { type: SWIM_PING, from: 'peer', seq, updates })

function make(opts = {}) {
  const swim = new SwimMembership({ localId: 'me', sendFn: () => {}, ...opts })
  const coord = new SwarmCoordinator('me', { swim })
  return { swim, coord }
}

describe('SwarmCoordinator wired to SwimMembership', () => {
  it('a member learned via SWIM joins the coordinator', () => {
    const { swim, coord } = make()
    gossip(swim, [{ podId: 'x', state: 'alive', incarnation: 0 }])
    assert.ok(coord.listMembers().includes('x'))
    assert.ok(coord.election.candidates.includes('x'))
  })

  it('SWIM `left` removes the member from the coordinator', () => {
    const { swim, coord } = make()
    gossip(swim, [{ podId: 'x', state: 'alive', incarnation: 0 }])
    gossip(swim, [{ podId: 'x', state: 'left', incarnation: 0 }], 2)
    assert.equal(swim.getState('x'), 'left')
    assert.ok(!coord.listMembers().includes('x'))
    assert.ok(!coord.election.candidates.includes('x'))
  })

  it('SWIM `dead` removes the member from the coordinator', () => {
    const { swim, coord } = make()
    gossip(swim, [{ podId: 'x', state: 'alive', incarnation: 0 }])
    gossip(swim, [{ podId: 'x', state: 'dead', incarnation: 0 }], 2)
    assert.ok(!coord.listMembers().includes('x'))
  })

  it('an alive update with a higher incarnation brings the member back', () => {
    const { swim, coord } = make()
    gossip(swim, [{ podId: 'x', state: 'alive', incarnation: 0 }])
    gossip(swim, [{ podId: 'x', state: 'left', incarnation: 0 }], 2)
    gossip(swim, [{ podId: 'x', state: 'alive', incarnation: 0 }], 3)
    assert.ok(!coord.listMembers().includes('x'), 'same-incarnation alive does not undo left')
    gossip(swim, [{ podId: 'x', state: 'alive', incarnation: 1 }], 4)
    assert.ok(coord.listMembers().includes('x'))
  })

  it('leave() on the coordinator still marks the peer left in SWIM, once', () => {
    const { swim, coord } = make()
    gossip(swim, [{ podId: 'x', state: 'alive', incarnation: 0 }])
    let lefts = 0
    const wired = swim.onLeave
    swim.onLeave = (id) => { lefts++; wired(id) }
    assert.equal(coord.leave('x'), true)
    assert.equal(swim.getState('x'), 'left')
    assert.equal(lefts, 1, 'no re-entrant leave loop')
    assert.ok(!coord.listMembers().includes('x'))
  })

  it('only the local swarm follows SWIM; other swarms are untouched', () => {
    const { swim, coord } = make()
    coord.join('x', [], 'other')
    gossip(swim, [{ podId: 'x', state: 'alive', incarnation: 0 }])
    gossip(swim, [{ podId: 'x', state: 'left', incarnation: 0 }], 2)
    assert.ok(coord.listMembers('other').includes('x'))
  })

  it('callbacks set before construction keep firing', () => {
    const seen = []
    const swim = new SwimMembership({
      localId: 'me', sendFn: () => {},
      onJoin: (id) => seen.push(`join:${id}`),
      onLeave: (id) => seen.push(`left:${id}`),
    })
    const coord = new SwarmCoordinator('me', { swim })
    gossip(swim, [{ podId: 'x', state: 'alive', incarnation: 0 }])
    gossip(swim, [{ podId: 'x', state: 'left', incarnation: 0 }], 2)
    assert.deepEqual(seen, ['join:x', 'left:x'])
    assert.ok(!coord.listMembers().includes('x'))
  })

  it('stop() unhooks the coordinator and restores the previous callbacks', () => {
    const prev = { join: () => {}, leave: () => {}, dead: () => {} }
    const swim = new SwimMembership({
      localId: 'me', sendFn: () => {}, onJoin: prev.join, onLeave: prev.leave, onDead: prev.dead,
    })
    const coord = new SwarmCoordinator('me', { swim })
    assert.notEqual(swim.onLeave, prev.leave)
    coord.stop()
    assert.equal(swim.onJoin, prev.join)
    assert.equal(swim.onLeave, prev.leave)
    assert.equal(swim.onDead, prev.dead)
    gossip(swim, [{ podId: 'x', state: 'alive', incarnation: 0 }])
    assert.ok(!coord.listMembers().includes('x'), 'a stopped coordinator no longer follows SWIM')
    coord.stop() // idempotent
  })

  it('stop() leaves callbacks someone else installed on top alone, and goes inert', () => {
    const { swim, coord } = make()
    const mine = () => {}
    swim.onLeave = mine
    coord.stop()
    assert.equal(swim.onLeave, mine)
    gossip(swim, [{ podId: 'x', state: 'alive', incarnation: 0 }])
    assert.ok(!coord.listMembers().includes('x'))
  })

  it('stop() on a coordinator with no swim is a no-op', () => {
    const coord = new SwarmCoordinator('solo')
    assert.doesNotThrow(() => coord.stop())
  })
})

describe('two pods: a leave on one reaches the other coordinator', () => {
  beforeEach(() => mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] }))
  afterEach(() => mock.timers.reset())

  it('a leaves c; b (which only hears it by gossip) drops c too', () => {
    const queue = []
    const pods = new Map()
    for (const name of ['a', 'b', 'c']) {
      const swim = new SwimMembership({
        localId: name, pingIntervalMs: 1000, pingTimeoutMs: 400, suspectTimeoutMs: 60_000,
        sendFn: (to, msg) => queue.push({ from: name, to, msg }),
      })
      pods.set(name, { swim, coord: new SwarmCoordinator(name, { swim }) })
    }
    const drain = () => {
      while (queue.length) {
        const { from, to, msg } = queue.shift()
        pods.get(to)?.swim.handleMessage(from, structuredClone(msg))
      }
    }
    const rounds = (n) => { for (let i = 0; i < n; i++) { mock.timers.tick(1000); drain() } }
    pods.get('a').coord.join('b')
    pods.get('b').coord.join('c')
    for (const { swim } of pods.values()) swim.start()
    rounds(12)
    for (const name of ['a', 'b', 'c']) assert.equal(pods.get(name).coord.listMembers().length, 3, name)
    pods.get('a').coord.leave('c')
    rounds(12)
    assert.ok(!pods.get('b').coord.listMembers().includes('c'), 'b dropped c')
    assert.ok(!pods.get('a').coord.listMembers().includes('c'))
    for (const { swim } of pods.values()) swim.stop()
  })
})
