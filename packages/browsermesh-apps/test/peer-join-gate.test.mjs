// Run with: node --import ./test/_setup-globals.mjs --test test/peer-join-gate.test.mjs
//
// A held join: the offering side approves, the joining side confirms ("keep"), and nothing is installed (no
// registry peer, no capability) until both have happened. An approval that is not confirmed in time runs out, and
// either side can leave. State machines with an injected clock; no UI, no wire, off unless a caller builds one.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createOfferingJoinGate, createJoiningJoinGate, JOIN_STATE, JOIN_GATE_DEFAULTS } from '../src/peer-join-gate.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'

/** A clock whose timers fire only when the test advances it. */
function fakeClock(start = 1_000_000) {
  let t = start
  let seq = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimeout(fn, ms) { const id = ++seq; timers.set(id, { fn, at: t + ms }); return id },
    clearTimeout(id) { timers.delete(id) },
    get pending() { return timers.size },
    advance(ms) {
      const target = t + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        t = due[1].at
        timers.delete(due[0])
        due[1].fn()
      }
      t = target
    },
  }
}

const OWNER = 'pod-owner'
const BOB = 'pk-bob'
const CAROL = 'pk-carol'

function offering(opts = {}) {
  const clock = fakeClock()
  const registry = new PeerRegistry({ localPodId: OWNER })
  const events = []
  const gate = createOfferingJoinGate({ registry, clock, ...opts })
  gate.on((e) => events.push(e))
  return { gate, registry, clock, events }
}

describe('offering side: nothing flows until both have happened', () => {
  it('defaults: 5 minutes to keep', () => {
    assert.deepEqual({ ...JOIN_GATE_DEFAULTS }, { keepTimeoutMs: 300_000, requestTimeoutMs: 300_000, graceMs: 10_000, maxWaiting: 16 })
  })

  it('a request waits for the offering side; the registry is untouched', () => {
    const { gate, registry } = offering()
    assert.deepEqual(gate.request(BOB, { label: 'Bob' }), { ok: true, state: 'pending' })
    assert.equal(gate.state(BOB), 'pending')
    assert.equal(registry.getPeer(BOB), null)
  })

  it('approval alone installs nothing: the joiner has not confirmed', () => {
    const { gate, registry } = offering()
    gate.request(BOB, { label: 'Bob' })
    assert.deepEqual(gate.approve(BOB, { scopes: ['chat:write'] }), { ok: true, state: 'approved' })
    assert.equal(gate.state(BOB), 'approved')
    assert.equal(registry.getPeer(BOB), null)
    assert.equal(gate.isActive(BOB), false)
  })

  it('confirmation after approval adds the peer with the approved scopes', () => {
    const { gate, registry, events } = offering()
    gate.request(BOB, { label: 'Bob' })
    gate.approve(BOB, { scopes: ['chat:write'] })
    assert.deepEqual(gate.kept(BOB), { ok: true, state: 'kept' })
    assert.equal(gate.isActive(BOB), true)
    assert.equal(registry.getPeer(BOB).label, 'Bob')
    assert.deepEqual(registry.getPeerCapabilities(BOB).scopes, ['chat:write'])
    assert.equal(registry.checkAccess(BOB, 'chat', 'write').allowed, true)
    assert.deepEqual(events.map((e) => e.type), ['request', 'approved', 'kept'])
  })

  it('confirmation without an approval is refused and installs nothing', () => {
    const { gate, registry } = offering()
    assert.deepEqual(gate.kept(BOB), { ok: false, reason: 'not-approved' })
    gate.request(BOB)
    assert.deepEqual(gate.kept(BOB), { ok: false, reason: 'not-approved' })
    assert.equal(registry.getPeer(BOB), null)
    assert.equal(gate.state(BOB), 'pending')
  })

  it('approving a peer that never asked, or twice, is refused', () => {
    const { gate } = offering()
    assert.deepEqual(gate.approve(BOB), { ok: false, reason: 'no-request' })
    gate.request(BOB)
    gate.approve(BOB)
    assert.deepEqual(gate.approve(BOB), { ok: false, reason: 'no-request' })
  })

  it('a second confirmation does nothing more', () => {
    const { gate, events } = offering()
    gate.request(BOB); gate.approve(BOB); gate.kept(BOB)
    assert.deepEqual(gate.kept(BOB), { ok: false, reason: 'not-approved' })
    assert.equal(events.filter((e) => e.type === 'kept').length, 1)
  })

  it('a repeated request from a peer that is already waiting or active is refused', () => {
    const { gate } = offering()
    gate.request(BOB)
    assert.deepEqual(gate.request(BOB), { ok: false, reason: 'already-waiting' })
    gate.approve(BOB)
    assert.deepEqual(gate.request(BOB), { ok: false, reason: 'already-waiting' })
    gate.kept(BOB)
    assert.deepEqual(gate.request(BOB), { ok: false, reason: 'already-joined' })
  })

  it('deny discards the request', () => {
    const { gate, registry, events } = offering()
    gate.request(BOB)
    assert.deepEqual(gate.deny(BOB), { ok: true })
    assert.equal(gate.state(BOB), null)
    assert.equal(registry.getPeer(BOB), null)
    assert.deepEqual(events.map((e) => e.type), ['request', 'denied'])
    assert.deepEqual(gate.deny(BOB), { ok: false, reason: 'no-request' })
  })

  it('the registry\'s peer id and label are sanitised and bounded', () => {
    const { gate, registry } = offering()
    gate.request(BOB, { label: 'Bob\u001b[31m‮!' })
    gate.approve(BOB)
    gate.kept(BOB)
    assert.equal(registry.getPeer(BOB).label, 'Bob!')
    assert.deepEqual(gate.request('', {}), { ok: false, reason: 'bad-peer-id' })
    assert.deepEqual(gate.request('x'.repeat(300), {}), { ok: false, reason: 'bad-peer-id' })
    assert.deepEqual(gate.request(5, {}), { ok: false, reason: 'bad-peer-id' })
  })
})

describe('offering side: an approval that is not confirmed in time runs out', () => {
  it('the approval runs out after the keep timeout plus the grace for the message to arrive', () => {
    const { gate, clock, registry, events } = offering({ keepTimeoutMs: 1000, graceMs: 100 })
    gate.request(BOB); gate.approve(BOB)
    clock.advance(1099)
    assert.equal(gate.state(BOB), 'approved')
    clock.advance(1)
    assert.equal(gate.state(BOB), null)
    assert.equal(registry.getPeer(BOB), null)
    assert.deepEqual(events.map((e) => e.type), ['request', 'approved', 'expired'])
    assert.deepEqual(gate.kept(BOB), { ok: false, reason: 'not-approved' })
  })

  it('a confirmation in time cancels the deadline', () => {
    const { gate, clock } = offering({ keepTimeoutMs: 1000, graceMs: 0 })
    gate.request(BOB); gate.approve(BOB)
    clock.advance(999)
    gate.kept(BOB)
    clock.advance(10_000)
    assert.equal(gate.state(BOB), 'kept')
    assert.equal(clock.pending, 0)
  })

  it('a request nobody answers runs out too', () => {
    const { gate, clock, events } = offering({ requestTimeoutMs: 500 })
    gate.request(BOB)
    clock.advance(500)
    assert.equal(gate.state(BOB), null)
    assert.deepEqual(events.map((e) => e.type), ['request', 'expired'])
  })

  it('approving resets the wait to the keep deadline', () => {
    const { gate, clock } = offering({ requestTimeoutMs: 500, keepTimeoutMs: 5000, graceMs: 0 })
    gate.request(BOB)
    clock.advance(400)
    gate.approve(BOB)
    clock.advance(4999)
    assert.equal(gate.state(BOB), 'approved')
    clock.advance(1)
    assert.equal(gate.state(BOB), null)
  })

  it('a peer whose approval ran out can ask again', () => {
    const { gate, clock } = offering({ keepTimeoutMs: 100, graceMs: 0 })
    gate.request(BOB); gate.approve(BOB)
    clock.advance(100)
    assert.deepEqual(gate.request(BOB), { ok: true, state: 'pending' })
  })

  it('uses the default five minutes', () => {
    const { gate, clock } = offering({ graceMs: 0 })
    gate.request(BOB); gate.approve(BOB)
    clock.advance(299_999)
    assert.equal(gate.state(BOB), 'approved')
    clock.advance(1)
    assert.equal(gate.state(BOB), null)
  })
})

describe('offering side: leaving', () => {
  it('leaving while pending or approved discards the join', () => {
    const { gate, registry, clock, events } = offering()
    gate.request(BOB); gate.request(CAROL); gate.approve(CAROL)
    assert.deepEqual(gate.leave(BOB), { ok: true })
    assert.deepEqual(gate.leave(CAROL), { ok: true })
    assert.equal(gate.state(BOB), null)
    assert.equal(gate.state(CAROL), null)
    assert.equal(registry.getPeer(CAROL), null)
    assert.equal(clock.pending, 0)
    assert.deepEqual(events.filter((e) => e.type === 'left').map((e) => e.peerId), [BOB, CAROL])
  })

  it('leaving after the join was kept removes the peer from the registry', () => {
    const { gate, registry } = offering()
    gate.request(BOB); gate.approve(BOB, { scopes: ['chat:write'] }); gate.kept(BOB)
    assert.deepEqual(gate.leave(BOB), { ok: true })
    assert.equal(registry.getPeer(BOB), null)
    assert.equal(gate.isActive(BOB), false)
  })

  it('the joiner leaving is reported as such', () => {
    const { gate, events } = offering()
    gate.request(BOB)
    gate.leave(BOB, { by: 'peer' })
    assert.equal(events.at(-1).by, 'peer')
  })

  it('leaving a peer that is not here is refused', () => {
    const { gate } = offering()
    assert.deepEqual(gate.leave(BOB), { ok: false, reason: 'no-such-join' })
  })
})

describe('offering side: bounds', () => {
  it('only maxWaiting joins wait at once; the rest are refused, and a freed slot is reusable', () => {
    const { gate } = offering({ maxWaiting: 2 })
    assert.equal(gate.request('a').ok, true)
    assert.equal(gate.request('b').ok, true)
    assert.deepEqual(gate.request('c'), { ok: false, reason: 'too-many-waiting' })
    gate.deny('a')
    assert.equal(gate.request('c').ok, true)
  })

  it('kept joins do not count against the waiting bound', () => {
    const { gate } = offering({ maxWaiting: 1 })
    gate.request('a'); gate.approve('a'); gate.kept('a')
    assert.equal(gate.request('b').ok, true)
  })

  it('list shows who is waiting and in what state', () => {
    const { gate } = offering()
    gate.request(BOB, { label: 'Bob' }); gate.request(CAROL); gate.approve(CAROL)
    assert.deepEqual(gate.list().map((e) => [e.peerId, e.state]), [[BOB, 'pending'], [CAROL, 'approved']])
    assert.equal(gate.list()[0].label, 'Bob')
  })

  it('dispose drops every join and every timer', () => {
    const { gate, clock } = offering()
    gate.request(BOB); gate.approve(BOB)
    gate.dispose()
    assert.equal(clock.pending, 0)
    assert.equal(gate.state(BOB), null)
  })

  it('an install that fails keeps the join approved so it can still be kept', () => {
    const clock = fakeClock()
    let fail = true
    const registry = { addPeer() { if (fail) throw new Error('boom') }, removePeer() {}, getPeer() { return null } }
    const gate = createOfferingJoinGate({ registry, clock })
    gate.request(BOB); gate.approve(BOB)
    const r = gate.kept(BOB)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'install-failed')
    assert.equal(gate.state(BOB), 'approved')
    fail = false
    assert.deepEqual(gate.kept(BOB), { ok: true, state: 'kept' })
  })

  it('a throwing event listener does not stop the machine', () => {
    const { gate } = offering()
    gate.on(() => { throw new Error('listener') })
    assert.equal(gate.request(BOB).ok, true)
  })

  it('refuses to be built without a registry, or with nonsense bounds', () => {
    assert.throws(() => createOfferingJoinGate({}), /registry/)
    const registry = { addPeer() {}, removePeer() {} }
    assert.throws(() => createOfferingJoinGate({ registry, keepTimeoutMs: 0 }), /keepTimeoutMs/)
    assert.throws(() => createOfferingJoinGate({ registry, maxWaiting: 0 }), /maxWaiting/)
  })
})

describe('joining side', () => {
  function joining(opts = {}) {
    const clock = fakeClock()
    const calls = []
    const gate = createJoiningJoinGate({
      clock,
      install: async (info) => { calls.push(['install', info.peerId]) },
      uninstall: async (info) => { calls.push(['uninstall', info.peerId]) },
      ...opts,
    })
    const events = []
    gate.on((e) => events.push(e))
    return { gate, clock, calls, events }
  }

  it('an approval is held: nothing is installed until the joiner keeps it', async () => {
    const { gate, calls } = joining()
    assert.equal(gate.state(), null)
    assert.deepEqual(gate.approved({ peerId: BOB, label: 'Bob' }), { ok: true, state: 'approved' })
    assert.equal(gate.state(), 'approved')
    assert.deepEqual(calls, [])
    const r = await gate.keep()
    assert.deepEqual(r, { ok: true, state: 'kept', peerId: BOB })
    assert.deepEqual(calls, [['install', BOB]])
    assert.equal(gate.isActive(), true)
  })

  it('keep without an approval, or twice, is refused', async () => {
    const { gate, calls } = joining()
    assert.deepEqual(await gate.keep(), { ok: false, reason: 'not-approved' })
    gate.approved({ peerId: BOB })
    await gate.keep()
    assert.deepEqual(await gate.keep(), { ok: false, reason: 'not-approved' })
    assert.deepEqual(calls, [['install', BOB]])
  })

  it('an approval that is not kept in time runs out and nothing was installed', async () => {
    const { gate, clock, calls, events } = joining({ keepTimeoutMs: 1000 })
    gate.approved({ peerId: BOB })
    clock.advance(999)
    assert.equal(gate.state(), 'approved')
    clock.advance(1)
    assert.equal(gate.state(), null)
    assert.deepEqual(await gate.keep(), { ok: false, reason: 'not-approved' })
    assert.deepEqual(calls, [])
    assert.deepEqual(events.map((e) => e.type), ['approved', 'expired'])
  })

  it('defaults to the same five minutes', () => {
    const { gate, clock } = joining()
    gate.approved({ peerId: BOB })
    clock.advance(299_999)
    assert.equal(gate.state(), 'approved')
    clock.advance(1)
    assert.equal(gate.state(), null)
  })

  it('keeping cancels the deadline', async () => {
    const { gate, clock } = joining({ keepTimeoutMs: 1000 })
    gate.approved({ peerId: BOB })
    await gate.keep()
    clock.advance(100_000)
    assert.equal(gate.state(), 'kept')
    assert.equal(clock.pending, 0)
  })

  it('an install that fails leaves the approval held, to try again before it runs out', async () => {
    let fail = true
    const { gate, clock } = joining({ keepTimeoutMs: 1000, install: async () => { if (fail) throw new Error('no route') } })
    gate.approved({ peerId: BOB })
    const r = await gate.keep()
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'install-failed')
    assert.match(r.error, /no route/)
    assert.equal(gate.state(), 'approved')
    fail = false
    clock.advance(500)
    assert.equal((await gate.keep()).ok, true)
  })

  it('an approval that runs out while the install is in flight is undone', async () => {
    let release
    const calls = []
    const { gate, clock } = joining({
      keepTimeoutMs: 1000,
      install: () => new Promise((r) => { release = r }),
      uninstall: async (info) => { calls.push(['uninstall', info.peerId]) },
    })
    gate.approved({ peerId: BOB })
    const kept = gate.keep()
    clock.advance(1000)
    release()
    const r = await kept
    assert.deepEqual(r, { ok: false, reason: 'expired' })
    assert.deepEqual(calls, [['uninstall', BOB]])
    assert.equal(gate.state(), null)
  })

  it('leaving while held discards the approval', async () => {
    const { gate, clock, calls, events } = joining()
    gate.approved({ peerId: BOB })
    assert.deepEqual(await gate.leave(), { ok: true })
    assert.equal(gate.state(), null)
    assert.equal(clock.pending, 0)
    assert.deepEqual(await gate.keep(), { ok: false, reason: 'not-approved' })
    assert.deepEqual(calls, [])
    assert.equal(events.at(-1).type, 'left')
  })

  it('leaving after keeping uninstalls', async () => {
    const { gate, calls } = joining()
    gate.approved({ peerId: BOB })
    await gate.keep()
    assert.deepEqual(await gate.leave(), { ok: true })
    assert.deepEqual(calls, [['install', BOB], ['uninstall', BOB]])
    assert.equal(gate.state(), null)
  })

  it('the offering side leaving is reported as such', async () => {
    const { gate, events } = joining()
    gate.approved({ peerId: BOB })
    await gate.leave({ by: 'peer' })
    assert.equal(events.at(-1).by, 'peer')
  })

  it('leave with nothing held is refused; a second approval while one is held is refused', async () => {
    const { gate } = joining()
    assert.deepEqual(await gate.leave(), { ok: false, reason: 'no-such-join' })
    gate.approved({ peerId: BOB })
    assert.deepEqual(gate.approved({ peerId: CAROL }), { ok: false, reason: 'already-waiting' })
  })

  it('the label is sanitised', () => {
    const { gate, events } = joining()
    gate.approved({ peerId: BOB, label: 'x\u001b[2Jy' })
    assert.equal(events[0].label, 'xy')
  })

  it('refuses to be built without an install hook, or with a nonsense timeout', () => {
    assert.throws(() => createJoiningJoinGate({}), /install/)
    assert.throws(() => createJoiningJoinGate({ install() {}, keepTimeoutMs: -1 }), /keepTimeoutMs/)
  })
})

describe('both sides together', () => {
  it('nothing flows on either side until the joiner keeps and the offering side hears it', async () => {
    const clock = fakeClock()
    const registry = new PeerRegistry({ localPodId: OWNER })
    const offer = createOfferingJoinGate({ registry, clock })
    const installed = []
    const join = createJoiningJoinGate({ clock, install: async (i) => { installed.push(i.peerId) } })

    offer.request(BOB, { label: 'Bob' })
    offer.approve(BOB, { scopes: ['chat:write'] })
    join.approved({ peerId: OWNER, label: 'Owner' })
    assert.equal(registry.getPeer(BOB), null)
    assert.deepEqual(installed, [])

    const mine = await join.keep()
    assert.equal(mine.ok, true)
    assert.deepEqual(installed, [OWNER])
    assert.equal(registry.getPeer(BOB), null, 'still nothing on the offering side until it hears the joiner kept')

    offer.kept(BOB)
    assert.equal(registry.getPeer(BOB).label, 'Bob')
  })

  it('the states are exported', () => {
    assert.deepEqual(Object.values(JOIN_STATE).sort(), ['approved', 'kept', 'pending'])
  })
})
