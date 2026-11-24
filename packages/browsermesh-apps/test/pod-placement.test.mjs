// Run with: node --import ./test/_setup-globals.mjs --test test/pod-placement.test.mjs
//
// Pure placement logic for hosted pods (issue #185 §6, "Placement"): which
// host a podspec may go to and which is best, admission limits, host
// health, draining, and restart. Nothing here uses a clock or a timer: time
// is a number the test passes in.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { InMemoryPodHostDriver, PodHostDriverError, POD_HOST_ERROR } from '@johnhenry/browsermesh-pod'
import {
  BOUNDARY,
  TRUST,
  HostHealth,
  PlacementLedger,
  createHostPool,
  planPlacement,
} from '../src/pod-placement.mjs'

const SPEC_JS = { name: 'p1', lane: 'isolate', run: { kind: 'module', ref: 'echo' }, restart: { policy: 'never' } }
const SPEC_CMD = { name: 'c1', lane: 'microvm', run: { kind: 'command', ref: '/bin/echo' }, restart: { policy: 'never' } }

function host(overrides = {}) {
  return {
    id: 'h1',
    lane: 'isolate',
    boundary: BOUNDARY.LANGUAGE,
    verbs: ['spawn', 'status', 'send', 'drain', 'list'],
    caps: [],
    capacity: { pods: 10, vcpus: 8, memMib: 4096 },
    ...overrides,
  }
}

const ids = (plan) => plan.ranked.map((r) => r.id)
const rejectedFor = (plan, id) => plan.rejected.find((r) => r.id === id)?.code

describe('planPlacement: matching', () => {
  it('only hosts of the requested lane are eligible', () => {
    const plan = planPlacement({
      spec: SPEC_JS,
      hosts: [host({ id: 'iso' }), host({ id: 'vm', lane: 'microvm', boundary: BOUNDARY.HARDWARE })],
    })
    assert.equal(plan.ok, true)
    assert.deepEqual(ids(plan), ['iso'])
    assert.equal(rejectedFor(plan, 'vm'), 'lane')
  })

  it('a host that does not serve spawn is never eligible', () => {
    const plan = planPlacement({ spec: SPEC_JS, hosts: [host({ verbs: ['status', 'list'] })] })
    assert.equal(plan.ok, false)
    assert.equal(rejectedFor(plan, 'h1'), 'verb')
  })

  it('every capability the podspec asks for must be offered by the host', () => {
    const spec = { ...SPEC_JS, caps: ['net', 'clock'] }
    const plan = planPlacement({
      spec,
      hosts: [host({ id: 'a', caps: ['net'] }), host({ id: 'b', caps: ['net', 'clock', 'fs'] })],
    })
    assert.deepEqual(ids(plan), ['b'])
    assert.equal(rejectedFor(plan, 'a'), 'caps')
  })

  it('fails with a code and a per-host reason when nothing matches', () => {
    const plan = planPlacement({ spec: SPEC_CMD, hosts: [host()] })
    assert.equal(plan.ok, false)
    assert.equal(plan.code, 'no-eligible-host')
    assert.deepEqual(plan.rejected, [{ id: 'h1', code: 'lane', reason: "host runs lane 'isolate', pod needs 'microvm'" }])
  })

  it('fails with no-hosts when there are none', () => {
    assert.equal(planPlacement({ spec: SPEC_JS, hosts: [] }).code, 'no-hosts')
  })

  it('refuses a podspec that does not validate', () => {
    const plan = planPlacement({ spec: { name: '', run: {} }, hosts: [host()] })
    assert.equal(plan.ok, false)
    assert.equal(plan.code, 'invalid-spec')
  })
})

describe('planPlacement: isolation boundary and requester trust', () => {
  const worker = host({ id: 'worker', lane: 'node', boundary: BOUNDARY.NONE, verbs: ['spawn', 'status', 'send', 'drain', 'list'] })
  const proc = host({ id: 'proc', lane: 'node', boundary: BOUNDARY.PROCESS })
  const iso = host({ id: 'iso', lane: 'node', boundary: BOUNDARY.LANGUAGE })
  const spec = { ...SPEC_JS, lane: 'node' }

  it('untrusted requesters (the default) are only placed behind a language or hardware boundary', () => {
    const plan = planPlacement({ spec, hosts: [worker, proc, iso] })
    assert.deepEqual(ids(plan), ['iso'])
    assert.equal(rejectedFor(plan, 'worker'), 'boundary')
    assert.equal(rejectedFor(plan, 'proc'), 'boundary')
  })

  it('a trusted requester may use any boundary', () => {
    const plan = planPlacement({ spec, hosts: [worker, proc, iso], requester: { id: 'me', trust: TRUST.TRUSTED } })
    assert.deepEqual(ids(plan).sort(), ['iso', 'proc', 'worker'])
  })

  it('a host with no declared boundary counts as none', () => {
    const plan = planPlacement({ spec, hosts: [{ ...iso, boundary: undefined }] })
    assert.equal(plan.ok, false)
    assert.equal(rejectedFor(plan, 'iso'), 'boundary')
  })

  it('policy.minBoundary raises the floor even for a trusted requester', () => {
    const plan = planPlacement({
      spec, hosts: [worker, proc, iso],
      requester: { id: 'me', trust: TRUST.TRUSTED },
      policy: { minBoundary: BOUNDARY.PROCESS },
    })
    assert.deepEqual(ids(plan).sort(), ['iso', 'proc'])
  })

  it('an unknown trust value is treated as untrusted', () => {
    const plan = planPlacement({ spec, hosts: [worker], requester: { id: 'me', trust: 'sure' } })
    assert.equal(plan.ok, false)
  })
})

describe('planPlacement: admission limits', () => {
  it('a full host is skipped, by pod count', () => {
    const plan = planPlacement({
      spec: SPEC_JS,
      hosts: [host({ id: 'full', capacity: { pods: 2 } }), host({ id: 'free', capacity: { pods: 2 } })],
      usage: new Map([['full', { pods: 2, vcpus: 0, memMib: 0 }]]),
    })
    assert.deepEqual(ids(plan), ['free'])
    assert.equal(rejectedFor(plan, 'full'), 'capacity')
  })

  it('requested limits must fit the remaining vcpus and memory', () => {
    const spec = { ...SPEC_JS, limits: { vcpus: 2, memMib: 512 } }
    const hosts = [host({ id: 'small', capacity: { vcpus: 4, memMib: 1024 } })]
    const fits = planPlacement({ spec, hosts, usage: new Map([['small', { pods: 1, vcpus: 2, memMib: 512 }]]) })
    assert.equal(fits.ok, true, 'exactly the remainder fits')
    const tooMuchCpu = planPlacement({ spec, hosts, usage: new Map([['small', { pods: 1, vcpus: 3, memMib: 0 }]]) })
    assert.equal(rejectedFor(tooMuchCpu, 'small'), 'capacity')
    const tooMuchMem = planPlacement({ spec, hosts, usage: new Map([['small', { pods: 1, vcpus: 0, memMib: 600 }]]) })
    assert.equal(rejectedFor(tooMuchMem, 'small'), 'capacity')
  })

  it('a podspec without limits is charged the policy defaults', () => {
    const hosts = [host({ id: 'h', capacity: { vcpus: 1, memMib: 100 } })]
    const plan = planPlacement({ spec: SPEC_JS, hosts, policy: { defaultLimits: { vcpus: 1, memMib: 128 } } })
    assert.equal(rejectedFor(plan, 'h'), 'capacity')
  })

  it('a host with no stated capacity is unlimited', () => {
    const plan = planPlacement({ spec: SPEC_JS, hosts: [host({ capacity: undefined })], usage: new Map([['h1', { pods: 9999, vcpus: 9999, memMib: 9999 }]]) })
    assert.equal(plan.ok, true)
  })

  it('a requester over its pod quota is refused before any host is considered', () => {
    const plan = planPlacement({
      spec: SPEC_JS,
      hosts: [host()],
      requester: { id: 'alice', trust: TRUST.UNTRUSTED },
      requesterUsage: new Map([['alice', { pods: 3 }]]),
      policy: { perRequesterMaxPods: 3 },
    })
    assert.equal(plan.ok, false)
    assert.equal(plan.code, 'quota')
    assert.equal(plan.rejected.length, 0)
  })

  it('another requester is unaffected by that quota', () => {
    const plan = planPlacement({
      spec: SPEC_JS,
      hosts: [host()],
      requester: { id: 'bob' },
      requesterUsage: new Map([['alice', { pods: 3 }]]),
      policy: { perRequesterMaxPods: 3 },
    })
    assert.equal(plan.ok, true)
  })
})

describe('planPlacement: health and draining', () => {
  it('unhealthy and draining hosts are never eligible', () => {
    const plan = planPlacement({
      spec: SPEC_JS,
      hosts: [host({ id: 'ok' }), host({ id: 'bad', health: 'unhealthy' }), host({ id: 'going', health: 'draining' })],
    })
    assert.deepEqual(ids(plan), ['ok'])
    assert.equal(rejectedFor(plan, 'bad'), 'health')
    assert.equal(rejectedFor(plan, 'going'), 'draining')
  })

  it('a degraded host is eligible but ranks below an otherwise identical healthy one', () => {
    const plan = planPlacement({
      spec: SPEC_JS,
      hosts: [host({ id: 'a', health: 'degraded' }), host({ id: 'b' })],
    })
    assert.deepEqual(ids(plan), ['b', 'a'])
  })

  it('a host being probed after a failure is eligible but ranks last', () => {
    const plan = planPlacement({
      spec: SPEC_JS,
      hosts: [host({ id: 'a', health: 'probing' }), host({ id: 'b', health: 'degraded' }), host({ id: 'c' })],
    })
    assert.deepEqual(ids(plan), ['c', 'b', 'a'])
  })

  it('avoidHosts removes a host (a restart should not return to the host that just failed)', () => {
    const plan = planPlacement({
      spec: SPEC_JS,
      hosts: [host({ id: 'a' }), host({ id: 'b' })],
      policy: { avoidHosts: ['a'] },
    })
    assert.deepEqual(ids(plan), ['b'])
    assert.equal(rejectedFor(plan, 'a'), 'avoided')
  })
})

describe('planPlacement: ranking', () => {
  it('prefers the host with more headroom', () => {
    const plan = planPlacement({
      spec: SPEC_JS,
      hosts: [host({ id: 'busy' }), host({ id: 'idle' })],
      usage: new Map([['busy', { pods: 8, vcpus: 6, memMib: 3000 }]]),
    })
    assert.deepEqual(ids(plan), ['idle', 'busy'])
    assert.equal(plan.host.id, 'idle')
  })

  it('breaks ties by host id so the answer does not depend on input order', () => {
    const a = planPlacement({ spec: SPEC_JS, hosts: [host({ id: 'x' }), host({ id: 'y' })] })
    const b = planPlacement({ spec: SPEC_JS, hosts: [host({ id: 'y' }), host({ id: 'x' })] })
    assert.deepEqual(ids(a), ['x', 'y'])
    assert.deepEqual(ids(b), ['x', 'y'])
  })

  it('policy.preferHost wins among otherwise comparable hosts but never overrides a hard rule', () => {
    const hosts = [host({ id: 'a' }), host({ id: 'b' })]
    assert.equal(planPlacement({ spec: SPEC_JS, hosts, policy: { preferHost: 'b' } }).host.id, 'b')
    const full = [host({ id: 'a' }), host({ id: 'b', capacity: { pods: 0 } })]
    assert.equal(planPlacement({ spec: SPEC_JS, hosts: full, policy: { preferHost: 'b' } }).host.id, 'a')
  })

  it('does not modify its inputs', () => {
    const hosts = [host({ id: 'a' }), host({ id: 'b' })]
    const copy = structuredClone(hosts)
    planPlacement({ spec: SPEC_JS, hosts })
    assert.deepEqual(hosts, copy)
  })
})

describe('HostHealth', () => {
  it('is healthy until it has seen a failure', () => {
    const health = new HostHealth()
    assert.equal(health.state('h', 0), 'healthy')
  })

  it('one failure degrades; the threshold trips it to unhealthy', () => {
    const health = new HostHealth({ failureThreshold: 3 })
    health.recordFailure('h', 0)
    assert.equal(health.state('h', 0), 'degraded')
    health.recordFailure('h', 1)
    assert.equal(health.state('h', 1), 'degraded')
    health.recordFailure('h', 2)
    assert.equal(health.state('h', 2), 'unhealthy')
  })

  it('after the cooldown an unhealthy host is probed once, and a success restores it', () => {
    const health = new HostHealth({ failureThreshold: 1, cooldownMs: 1000 })
    health.recordFailure('h', 0)
    assert.equal(health.state('h', 999), 'unhealthy')
    assert.equal(health.state('h', 1000), 'probing')
    health.recordSuccess('h', 1000)
    assert.equal(health.state('h', 1001), 'healthy')
  })

  it('a failed probe doubles the cooldown, up to the cap', () => {
    const health = new HostHealth({ failureThreshold: 1, cooldownMs: 1000, maxCooldownMs: 3000 })
    health.recordFailure('h', 0)
    health.recordFailure('h', 1000) // failed probe
    assert.equal(health.state('h', 2999), 'unhealthy')
    assert.equal(health.state('h', 3000), 'probing')
    health.recordFailure('h', 3000)
    health.recordFailure('h', 6000)
    assert.equal(health.state('h', 8999), 'unhealthy')
    assert.equal(health.state('h', 9000), 'probing', 'the cooldown stopped doubling at the 3000 cap')
  })

  it('hosts are tracked independently, and snapshot() reports each', () => {
    const health = new HostHealth({ failureThreshold: 1 })
    health.recordFailure('a', 0)
    assert.equal(health.state('b', 0), 'healthy')
    assert.deepEqual(health.snapshot(0), { a: 'unhealthy' })
  })
})

describe('PlacementLedger', () => {
  it('sums what is reserved per host and per requester, and releases it', () => {
    const ledger = new PlacementLedger()
    ledger.reserve({ hostId: 'h', name: 'p1', requesterId: 'alice', limits: { vcpus: 2, memMib: 256 } })
    ledger.reserve({ hostId: 'h', name: 'p2', requesterId: 'alice', limits: { vcpus: 1, memMib: 128 } })
    assert.deepEqual(ledger.usage().get('h'), { pods: 2, vcpus: 3, memMib: 384 })
    assert.deepEqual(ledger.requesterUsage().get('alice'), { pods: 2 })
    ledger.release('h', 'p1')
    assert.deepEqual(ledger.usage().get('h'), { pods: 1, vcpus: 1, memMib: 128 })
    ledger.release('h', 'p2')
    assert.equal(ledger.usage().has('h'), false)
  })

  it('releasing something that was never reserved is a no-op, and a name is reserved once per host', () => {
    const ledger = new PlacementLedger()
    ledger.release('h', 'nope')
    ledger.reserve({ hostId: 'h', name: 'p', requesterId: 'a', limits: { vcpus: 1, memMib: 1 } })
    assert.throws(() => ledger.reserve({ hostId: 'h', name: 'p', requesterId: 'a', limits: { vcpus: 1, memMib: 1 } }), /already reserved/)
  })
})

// ---------------------------------------------------------------------------
// createHostPool with fake lane drivers
// ---------------------------------------------------------------------------

function poolWith(hostDefs, { policy, now = () => 0, ...rest } = {}) {
  const hosts = hostDefs.map((def) => ({
    driver: def.driver ?? new InMemoryPodHostDriver({ lane: def.lane ?? 'isolate' }),
    ...def,
  }))
  return { hosts, pool: createHostPool({ hosts, policy, now, ...rest }) }
}

describe('createHostPool', () => {
  it('places a pod on the best eligible host and records its usage', async () => {
    const { pool, hosts } = poolWith([
      { id: 'a', lane: 'isolate', boundary: BOUNDARY.LANGUAGE, capacity: { pods: 5 } },
      { id: 'b', lane: 'microvm', boundary: BOUNDARY.HARDWARE },
    ])
    const placed = await pool.spawn(SPEC_JS, { requester: { id: 'alice' } })
    assert.equal(placed.hostId, 'a')
    assert.equal(placed.status.state, 'registered')
    assert.equal((await hosts[0].driver.list()).length, 1)
    assert.equal((await hosts[1].driver.list()).length, 0)
    assert.equal(pool.usage().get('a').pods, 1)
  })

  it('refuses when a host would exceed its admission limit, and the driver is never called', async () => {
    const calls = []
    const driver = new InMemoryPodHostDriver({ lane: 'isolate' })
    const spawn = driver.spawn.bind(driver)
    driver.spawn = async (spec) => { calls.push(spec.name); return spawn(spec) }
    const { pool } = poolWith([{ id: 'a', driver, boundary: BOUNDARY.LANGUAGE, capacity: { pods: 1 } }])
    await pool.spawn(SPEC_JS)
    await assert.rejects(
      () => pool.spawn({ ...SPEC_JS, name: 'p2' }),
      (err) => err instanceof PodHostDriverError && err.code === POD_HOST_ERROR.EBUSY && err.details.rejected[0].code === 'capacity',
    )
    assert.deepEqual(calls, ['p1'])
  })

  it('answers ELANE when no host serves the lane at all', async () => {
    const { pool } = poolWith([{ id: 'a', lane: 'isolate', boundary: BOUNDARY.LANGUAGE }])
    await assert.rejects(() => pool.spawn(SPEC_CMD), (err) => err.code === POD_HOST_ERROR.ELANE)
  })

  it('answers EACCES for a requester over its quota', async () => {
    const { pool } = poolWith([{ id: 'a', boundary: BOUNDARY.LANGUAGE }], { policy: { perRequesterMaxPods: 1 } })
    await pool.spawn(SPEC_JS, { requester: { id: 'alice' } })
    await assert.rejects(
      () => pool.spawn({ ...SPEC_JS, name: 'p2' }, { requester: { id: 'alice' } }),
      (err) => err.code === POD_HOST_ERROR.EACCES,
    )
    await pool.spawn({ ...SPEC_JS, name: 'p3' }, { requester: { id: 'bob' } })
  })

  it('a refusal by the host (EACCES) is final: no other host is tried', async () => {
    const refusing = new InMemoryPodHostDriver({ lane: 'isolate' })
    refusing.spawn = async () => { throw new PodHostDriverError(POD_HOST_ERROR.EACCES, 'no') }
    const { pool, hosts } = poolWith([
      { id: 'a', driver: refusing, boundary: BOUNDARY.LANGUAGE },
      { id: 'b', boundary: BOUNDARY.LANGUAGE },
    ], { policy: { preferHost: 'a' } })
    await assert.rejects(() => pool.spawn(SPEC_JS), (err) => err.code === POD_HOST_ERROR.EACCES)
    assert.equal((await hosts[1].driver.list()).length, 0)
    assert.equal(pool.usage().size, 0, 'a failed spawn holds no reservation')
  })

  it('fails over to the next host only on a transport-level failure, and records the failure', async () => {
    const down = new InMemoryPodHostDriver({ lane: 'isolate' })
    down.spawn = async () => { throw new PodHostDriverError(POD_HOST_ERROR.ETIMEDOUT, 'unreachable') }
    const { pool } = poolWith([
      { id: 'a', driver: down, boundary: BOUNDARY.LANGUAGE },
      { id: 'b', boundary: BOUNDARY.LANGUAGE },
    ], { policy: { preferHost: 'a' }, maxAttempts: 2 })
    const placed = await pool.spawn(SPEC_JS)
    assert.equal(placed.hostId, 'b')
    assert.deepEqual(placed.attempts.map((a) => [a.hostId, a.outcome]), [['a', 'ETIMEDOUT'], ['b', 'ok']])
    assert.equal(pool.health().a, 'degraded')
  })

  it('with the default of one attempt it proposes one host and reports its failure', async () => {
    const down = new InMemoryPodHostDriver({ lane: 'isolate' })
    down.spawn = async () => { throw new PodHostDriverError(POD_HOST_ERROR.ETIMEDOUT, 'unreachable') }
    const { pool } = poolWith([
      { id: 'a', driver: down, boundary: BOUNDARY.LANGUAGE },
      { id: 'b', boundary: BOUNDARY.LANGUAGE },
    ], { policy: { preferHost: 'a' } })
    await assert.rejects(() => pool.spawn(SPEC_JS), (err) => err.code === POD_HOST_ERROR.ETIMEDOUT)
  })

  it('a host that keeps failing is taken out of rotation until its cooldown passes', async () => {
    let t = 0
    const down = new InMemoryPodHostDriver({ lane: 'isolate' })
    down.spawn = async () => { throw new PodHostDriverError(POD_HOST_ERROR.ETIMEDOUT, 'unreachable') }
    const health = new HostHealth({ failureThreshold: 2, cooldownMs: 1000 })
    const { pool } = poolWith([
      { id: 'a', driver: down, boundary: BOUNDARY.LANGUAGE },
      { id: 'b', boundary: BOUNDARY.LANGUAGE },
    ], { policy: { preferHost: 'a' }, now: () => t, health })
    // A failing spawn is recorded against its host, and a degraded host ranks
    // below a healthy one even when it is the preferred one.
    await assert.rejects(() => pool.spawn({ ...SPEC_JS, name: 'x0' }))
    assert.equal(pool.health().a, 'degraded')
    health.recordFailure('a', 0)
    assert.equal(pool.health().a, 'unhealthy')
    assert.equal((await pool.spawn({ ...SPEC_JS, name: 'y' })).hostId, 'b', 'a is skipped even though it is preferred')
    t = 1000
    assert.equal(pool.health().a, 'probing')
  })

  it('draining a host stops new placements and re-places its pods elsewhere', async () => {
    const { pool, hosts } = poolWith([
      { id: 'a', boundary: BOUNDARY.LANGUAGE },
      { id: 'b', boundary: BOUNDARY.LANGUAGE },
    ], { policy: { preferHost: 'a' } })
    await pool.spawn(SPEC_JS)
    await pool.spawn({ ...SPEC_JS, name: 'p2' })
    const result = await pool.drainHost('a')
    assert.deepEqual(result.moved.map((m) => [m.name, m.from, m.to]), [['p1', 'a', 'b'], ['p2', 'a', 'b']])
    assert.deepEqual(result.failed, [])
    assert.equal(pool.health().a, 'draining')
    assert.equal((await hosts[1].driver.list()).filter((s) => s.state === 'registered').length, 2)
    assert.equal(pool.usage().get('b').pods, 2)
    assert.equal(pool.usage().has('a'), false)
    // And nothing new lands on the draining host.
    assert.equal((await pool.spawn({ ...SPEC_JS, name: 'p3' })).hostId, 'b')
  })

  it('drainHost reports a pod it could not re-place instead of losing it silently', async () => {
    const { pool } = poolWith([{ id: 'only', boundary: BOUNDARY.LANGUAGE }])
    await pool.spawn(SPEC_JS)
    const result = await pool.drainHost('only')
    assert.equal(result.moved.length, 0)
    assert.equal(result.failed[0].name, 'p1')
    assert.equal(result.failed[0].code, POD_HOST_ERROR.EBUSY, 'no other host is available right now')
  })

  it('drainHost without replacement just drains', async () => {
    const { pool, hosts } = poolWith([{ id: 'a', boundary: BOUNDARY.LANGUAGE }, { id: 'b', boundary: BOUNDARY.LANGUAGE }])
    await pool.spawn(SPEC_JS)
    const result = await pool.drainHost('a', { replace: false })
    assert.deepEqual(result.moved, [])
    assert.equal((await hosts[0].driver.status('p1')).state, 'gone')
    assert.equal(pool.usage().size, 0)
  })

  it('draining one pod releases its reservation', async () => {
    const { pool } = poolWith([{ id: 'a', boundary: BOUNDARY.LANGUAGE, capacity: { pods: 1 } }])
    await pool.spawn(SPEC_JS)
    await pool.drain('p1')
    assert.equal(pool.usage().size, 0)
    await pool.spawn({ ...SPEC_JS, name: 'p2' })
  })

  describe('handleExit (restart and backoff)', () => {
    it('decides with the shared restart policy and never returns to the host that failed', async () => {
      const { pool } = poolWith([{ id: 'a', boundary: BOUNDARY.LANGUAGE }, { id: 'b', boundary: BOUNDARY.LANGUAGE }], { policy: { preferHost: 'a' } })
      await pool.spawn({ ...SPEC_JS, restart: { policy: 'on-failure', maxRestarts: 2, backoffMs: 10 } })
      const first = pool.handleExit({ hostId: 'a', name: 'p1', exit: { code: 1, reason: 'crashed' } })
      assert.deepEqual({ restart: first.restart, delayMs: first.delayMs }, { restart: true, delayMs: 10 })
      assert.deepEqual(first.avoidHosts, ['a'])
      const placed = await first.run()
      assert.equal(placed.hostId, 'b')
      assert.equal(pool.usage().has('a'), false, 'the dead pod no longer holds capacity on a')
    })

    it('counts restarts per pod and gives up at maxRestarts', async () => {
      const { pool } = poolWith([{ id: 'a', boundary: BOUNDARY.LANGUAGE }, { id: 'b', boundary: BOUNDARY.LANGUAGE }], { policy: { preferHost: 'a' } })
      await pool.spawn({ ...SPEC_JS, restart: { policy: 'always', maxRestarts: 1, backoffMs: 10 } })
      const first = pool.handleExit({ hostId: 'a', name: 'p1', exit: { code: 1 } })
      assert.equal(first.restart, true)
      assert.equal((await first.run()).hostId, 'b')
      const second = pool.handleExit({ hostId: 'b', name: 'p1', exit: { code: 1 } })
      assert.deepEqual({ restart: second.restart, why: second.why }, { restart: false, why: 'gave-up' })
    })

    it('an intentional drain is not restarted, and a pod it does not know is ignored', async () => {
      const { pool } = poolWith([{ id: 'a', boundary: BOUNDARY.LANGUAGE }])
      await pool.spawn({ ...SPEC_JS, restart: { policy: 'always' } })
      assert.equal(pool.handleExit({ hostId: 'a', name: 'p1', exit: { code: 0, reason: 'drained' } }).restart, false)
      assert.equal(pool.handleExit({ hostId: 'a', name: 'ghost', exit: { code: 1 } }).restart, false)
    })
  })
})
