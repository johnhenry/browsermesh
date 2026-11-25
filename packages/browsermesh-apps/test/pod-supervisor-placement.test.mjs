/**
 * The supervisor re-places a pod through the placement planner, under the identity and trust of the pod's ORIGINAL
 * requester as recorded when it was supervised, never under the supervisor's own (wider) rights. When that requester's
 * rules no longer allow any host the supervisor stops with a named reason.
 *
 * A fake `PodHostClient`, a fake `placer` (the planner's decision) and a fake clock keep every step in the test's hands.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { POD_LANE, PodHostDriverError, POD_HOST_ERROR } from '@johnhenry/browsermesh-pod'
import { createPodSupervisor, SUPERVISOR_AUDIT } from '../src/pod-supervisor.mjs'

const spec = (extra = {}) => ({ name: 'alpha', lane: POD_LANE.NODE, run: { kind: 'command', ref: '/bin/echo' }, restart: { policy: 'always', backoffMs: 1, maxRestarts: 5 }, ...extra })
const tick = async (n = 20) => { for (let i = 0; i < n; i += 1) await Promise.resolve() }

function fakeClient({ refuse = new Set() } = {}) {
  let onEventFn = null
  const spawns = []
  return {
    spawns,
    client: {
      async spawn(host, s) {
        spawns.push({ host, name: s.name })
        if (refuse.has(host)) throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, 'full')
        return { name: s.name, lane: s.lane, state: 'registered' }
      },
      async drain(host, name) { return { name, state: 'gone' } },
      async list() { return [] },
      async status(host, name) { return { name, state: 'registered' } },
      onEvent(fn) { onEventFn = fn; return () => { onEventFn = null } },
    },
    fire: (host, event) => onEventFn?.(host, event),
  }
}

function fakeClock() {
  let now = 0
  let next = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, delay) { const id = next++; timers.set(id, { fn, due: now + delay }); return id },
    clearTimeout(id) { timers.delete(id) },
    async advance(ms) {
      now += ms
      for (const [id, t] of [...timers].filter(([, x]) => x.due <= now).sort((a, b) => a[1].due - b[1].due)) {
        if (!timers.has(id)) continue
        timers.delete(id)
        t.fn()
        await tick()
      }
    },
  }
}

const crash = (fire, host, reason = 'crashed') => fire(host, { kind: 'exit', data: { name: 'alpha', code: 1, reason, restartable: true } })

function build({ placer, refuse } = {}) {
  const fake = fakeClient({ refuse })
  const clock = fakeClock()
  const calls = []
  const supervisor = createPodSupervisor({
    client: fake.client,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    placer: placer ? async (request) => { calls.push(request); return placer(request, calls.length) } : undefined,
    pickHost: async () => 'picked-by-pickHost',
  })
  return { ...fake, clock, supervisor, calls }
}

describe('supervise with a requester', () => {
  it("'auto' asks the planner under the stated requester and minimum boundary, and records them", async () => {
    const { supervisor, calls, spawns } = build({ placer: async () => 'host-2' })
    const { host } = await supervisor.supervise('auto', spec(), { requesterId: 'req-1', minBoundary: 'language' })
    assert.equal(host, 'host-2')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].requesterId, 'req-1')
    assert.deepEqual(calls[0].policy, { minBoundary: 'language' })
    assert.equal(calls[0].spec.name, 'alpha')
    assert.deepEqual(spawns, [{ host: 'host-2', name: 'alpha' }])
    assert.equal(supervisor.list()[0].requesterId, 'req-1')
  })

  it("'auto' with no requester and no boundary is unchanged: pickHost, no planner", async () => {
    const { supervisor, calls } = build({ placer: async () => 'host-2' })
    const { host } = await supervisor.supervise('auto', spec())
    assert.equal(host, 'picked-by-pickHost')
    assert.equal(calls.length, 0)
    assert.equal('requesterId' in supervisor.list()[0], false)
  })

  it('a boundary alone records no requester (it is never the supervisor itself): the planner treats it as untrusted', async () => {
    const { supervisor, calls } = build({ placer: async () => 'host-2' })
    await supervisor.supervise('auto', spec(), { minBoundary: 'hardware' })
    assert.equal(calls[0].requesterId, null)
  })

  it('a planner refusal at supervise time is the caller\'s error, with the plan code intact', async () => {
    const { supervisor } = build({
      placer: async () => { throw new PodHostDriverError(POD_HOST_ERROR.EACCES, 'no host', { plan: 'boundary' }) },
    })
    await assert.rejects(supervisor.supervise('auto', spec(), { requesterId: 'req-1' }), (err) => err.details.plan === 'boundary')
  })
})

describe('re-placement under the original requester', () => {
  it('a crash asks the planner again for the SAME requester, preferring the current host', async () => {
    const { supervisor, calls, spawns, fire, clock } = build({ placer: async (_r, n) => (n === 1 ? 'host-1' : 'host-1') })
    await supervisor.supervise('auto', spec(), { requesterId: 'req-1', minBoundary: 'process' })
    crash(fire, 'host-1')
    await tick()
    await clock.advance(10)
    assert.equal(calls.length, 2)
    assert.equal(calls[1].requesterId, 'req-1')
    assert.deepEqual(calls[1].policy, { minBoundary: 'process', preferHost: 'host-1' })
    assert.equal(spawns.length, 2)
    assert.equal(supervisor.list()[0].state, 'running')
  })

  it('a lost host is avoided, and the pod moves to the host the planner chose', async () => {
    const { supervisor, calls, spawns, fire, clock } = build({ placer: async (_r, n) => (n === 1 ? 'host-1' : 'host-2') })
    await supervisor.supervise('auto', spec(), { requesterId: 'req-1' })
    crash(fire, 'host-1', 'host-lost')
    await tick()
    await clock.advance(10)
    assert.deepEqual(calls[1].policy, { avoidHosts: ['host-1'] })
    assert.equal(spawns.at(-1).host, 'host-2')
    const entry = supervisor.list()[0]
    assert.equal(entry.host, 'host-2')
    assert.equal(entry.requesterId, 'req-1')
  })

  it('when the requester\'s rules no longer allow any host, the supervisor stops with a named reason and does not retry', async () => {
    const { supervisor, calls, spawns, fire, clock } = build({
      placer: async (_r, n) => {
        if (n === 1) return 'host-1'
        throw new PodHostDriverError(POD_HOST_ERROR.EACCES, 'requester may not be placed', { plan: 'boundary', rejected: [{ id: 'host-1', code: 'boundary' }] })
      },
    })
    const refused = []
    const gaveUp = []
    supervisor.on('supervisor:replacement-refused', (e) => refused.push(e))
    supervisor.on('supervisor:gave-up', (e) => gaveUp.push(e))
    await supervisor.supervise('auto', spec(), { requesterId: 'req-1' })
    crash(fire, 'host-1')
    await tick()
    await clock.advance(10)
    await clock.advance(100000)
    assert.equal(refused.length, 1)
    assert.equal(refused[0].requesterId, 'req-1')
    assert.equal(refused[0].code, POD_HOST_ERROR.EACCES)
    assert.equal(refused[0].plan, 'boundary')
    assert.equal(gaveUp[0].reason, 'replacement-refused:boundary')
    assert.equal(supervisor.list()[0].state, 'dead')
    assert.equal(spawns.length, 1, 'nothing was spawned under wider rights')
    assert.equal(calls.length, 2, 'the planner was asked once, not retried')
  })

  it('a refusal for lack of room (EBUSY) is retried, as any restart is, within maxRestarts', async () => {
    const { supervisor, calls, spawns, fire, clock } = build({
      placer: async (_r, n) => {
        if (n === 1) return 'host-1'
        if (n === 2) throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, 'no room', { plan: 'capacity' })
        return 'host-2'
      },
    })
    await supervisor.supervise('auto', spec(), { requesterId: 'req-1' })
    crash(fire, 'host-1')
    await tick()
    await clock.advance(10)
    await tick()
    await clock.advance(1000)
    assert.ok(calls.length >= 3)
    assert.equal(spawns.at(-1).host, 'host-2')
    assert.equal(supervisor.list()[0].state, 'running')
  })

  it('a pod supervised without a requester or boundary is restarted exactly as before, planner or not', async () => {
    const { supervisor, calls, spawns, fire, clock } = build({ placer: async () => 'host-9' })
    await supervisor.supervise('host-1', spec())
    crash(fire, 'host-1')
    await tick()
    await clock.advance(10)
    assert.equal(calls.length, 0)
    assert.deepEqual(spawns.map((s) => s.host), ['host-1', 'host-1'])
  })

  it('records the refusal in the audit chain', async () => {
    const entries = []
    const fake = fakeClient()
    const clock = fakeClock()
    const supervisor = createPodSupervisor({
      client: fake.client,
      peerNode: { podId: 'sup', wallet: { sign: async () => new Uint8Array(1) } },
      auditChain: { append: async (_a, operation, data) => { entries.push({ operation, data }) } },
      now: clock.now,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      placer: async ({ requesterId }, n = 0) => {
        if (entries.length === 0 && requesterId) return 'host-1'
        throw new PodHostDriverError(POD_HOST_ERROR.EACCES, 'no', { plan: 'trust' })
      },
    })
    await supervisor.supervise('auto', spec(), { requesterId: 'req-1' })
    fake.fire('host-1', { kind: 'exit', data: { name: 'alpha', code: 1, reason: 'crashed', restartable: true } })
    await tick()
    await clock.advance(10)
    await tick()
    assert.ok(entries.some((e) => e.operation === SUPERVISOR_AUDIT.REPLACEMENT_REFUSED && e.data.requesterId === 'req-1' && e.data.plan === 'trust'))
  })
})
