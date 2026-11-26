/**
 * Tests for hibernation.mjs: "cold boot as sleep" for hosted pods (decision 1 of
 * docs/design/hosted-pods-open-decisions.md, option B).
 *
 * Everything runs in process, over `InMemoryPodHostDriver`, with a fake clock and fake timers: nothing sleeps
 * and nothing asserts a count of wall-clock time. The Durable Object specifics (a real eviction, the measured wake)
 * need a deployed Worker and are not tested here.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  InMemoryPodHostDriver,
  POD_HOST_ERROR,
  POD_HOST_EVENT_KIND,
  POD_LIFECYCLE,
  PodHostDriverError,
  HIBERNATION_DEFAULTS,
  WAKE_FAILURE,
  MemoryHibernationStore,
  createHibernatingDriver,
} from '../src/index.mjs'

function fakeClock(start = 1_000_000) {
  let t = start
  const timers = new Set()
  return {
    now: () => t,
    setTimer(fn, ms) { const timer = { fn, at: t + ms }; timers.add(timer); return timer },
    clearTimer(timer) { timers.delete(timer) },
    pending: () => timers.size,
    advance(ms) {
      t += ms
      for (const timer of [...timers].filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) {
        timers.delete(timer)
        timer.fn()
      }
    },
  }
}

const spec = (name = 'alpha', extra = {}) => ({ name, lane: 'isolate', run: { kind: 'skill', ref: 'greeter' }, ...extra })

/** An in-memory lane driver whose pods have a podId and whose spawn can be held or failed. */
function makeInner({ lane = 'isolate' } = {}) {
  const base = new InMemoryPodHostDriver({ lane })
  const probe = {
    spawnCalls: [],
    gate: null,
    failNext: null,
    spawns: 0,
    podId: (name) => `id-of-${name}`,
  }
  const withId = (s) => ({ ...s, podId: probe.podId(s.name) })
  const driver = {
    lane: base.lane,
    capabilities: () => base.capabilities(),
    onEvent: (fn) => base.onEvent(fn),
    async spawn(s, options) {
      probe.spawnCalls.push(options)
      if (probe.gate) await probe.gate
      if (probe.failNext) { const e = probe.failNext; probe.failNext = null; throw e }
      probe.spawns += 1
      return withId(await base.spawn(s))
    },
    async status(name) { return withId(await base.status(name)) },
    send: (name, msg) => base.send(name, msg),
    exec: (name, argv, opts) => base.exec(name, argv, opts),
    snapshot: (name) => base.snapshot(name),
    restore: (name) => base.restore(name),
    drain: (name, opts) => base.drain(name, opts),
    async list() { return (await base.list()).map(withId) },
  }
  return { driver, base, probe }
}

function setup(options = {}) {
  const clock = fakeClock()
  const { driver: inner, base, probe } = makeInner({ lane: options.lane })
  const store = options.store ?? new MemoryHibernationStore()
  const events = []
  const host = createHibernatingDriver(inner, {
    store,
    idleMs: 1000,
    wakeTimeoutMs: 500,
    discoveryWindowMs: 40,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...options.driver,
  })
  host.onEvent((e) => events.push(e))
  return { clock, host, inner, base, probe, store, events }
}

async function rejection(promise) {
  try { await promise } catch (err) { return err }
  assert.fail('expected a rejection')
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('sleeping', () => {
  it('a pod idle for idleMs is drained to a durable record, and reports cold and sleeping with its identity', async () => {
    const { clock, host, store } = setup()
    await host.spawn(spec())
    clock.advance(999)
    assert.deepEqual(await host.sweep(), { slept: [], failed: [] })
    clock.advance(1)
    assert.deepEqual(await host.sweep(), { slept: ['alpha'], failed: [] })

    const status = await host.status('alpha')
    assert.equal(status.state, POD_LIFECYCLE.COLD)
    assert.equal(status.sleeping, true)
    assert.equal(status.podId, 'id-of-alpha')
    assert.equal(status.spec.name, 'alpha')
    assert.equal(status.sleptAt, clock.now())
    const record = await store.get('alpha')
    assert.equal(record.podId, 'id-of-alpha')
    assert.equal(record.spec.run.ref, 'greeter')
  })

  it('sleeping is not an exit: no exit event is sent, so a supervisor sees nothing to restart', async () => {
    const { clock, host, events } = setup()
    await host.spawn(spec())
    events.length = 0
    clock.advance(1000)
    await host.sweep()
    assert.equal(events.filter((e) => e.kind === POD_HOST_EVENT_KIND.EXIT).length, 0)
    const slept = events.filter((e) => e.kind === POD_HOST_EVENT_KIND.LIFECYCLE && e.data.reason === 'slept')
    assert.equal(slept.length, 1)
    assert.equal(slept[0].data.name, 'alpha')
    assert.equal(slept[0].data.to, POD_LIFECYCLE.COLD)
    // None of the inner driver's own drain events leaked either.
    assert.equal(events.filter((e) => e.data.name === 'alpha' && e.data.reason === 'drain').length, 0)
  })

  it('a message resets the idle clock; a status or list does not', async () => {
    const { clock, host } = setup()
    await host.spawn(spec())
    clock.advance(900)
    await host.send('alpha', { payload: 1 })
    clock.advance(900)
    assert.deepEqual((await host.sweep()).slept, [])
    await host.status('alpha')
    await host.list()
    clock.advance(100)
    assert.deepEqual((await host.sweep()).slept, ['alpha'])
  })

  it('a pod with a verb in flight is never slept', async () => {
    const { clock, host, base } = setup({ lane: 'node' })
    let release
    const held = new Promise((resolve) => { release = resolve })
    base.exec = async () => { await held; return { stdout: '', stderr: '', code: 0 } }
    await host.spawn({ name: 'alpha', lane: 'node', run: { kind: 'skill', ref: 'x' } })
    const pending = host.exec('alpha', ['x'])
    await tick()
    clock.advance(5000)
    assert.deepEqual((await host.sweep()).slept, [])
    release()
    await pending
    clock.advance(1000)
    assert.deepEqual((await host.sweep()).slept, ['alpha'])
  })

  it('eligible() keeps a pod awake', async () => {
    const { clock, host } = setup({ driver: { eligible: (s) => s.name !== 'pinned' } })
    await host.spawn(spec('pinned'))
    await host.spawn(spec('free'))
    clock.advance(5000)
    assert.deepEqual((await host.sweep()).slept, ['free'])
  })

  it('a failed drain leaves the pod awake and keeps no record', async () => {
    const { clock, host, inner, store } = setup()
    await host.spawn(spec())
    inner.drain = async () => { throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, 'cannot drain now') }
    clock.advance(1000)
    const result = await host.sweep()
    assert.deepEqual(result.slept, [])
    assert.equal(result.failed[0].name, 'alpha')
    assert.equal(await store.get('alpha'), null)
    assert.equal((await host.status('alpha')).state, POD_LIFECYCLE.REGISTERED)
  })
})

describe('waking', () => {
  async function asleep(options) {
    const ctx = setup(options)
    await ctx.host.spawn(spec())
    ctx.clock.advance(1000)
    await ctx.host.sweep()
    ctx.events.length = 0
    return ctx
  }

  it('a send to a sleeping pod boots it with the short discovery window, delivers, and says it woke', async () => {
    const { host, probe, base } = await asleep()
    const reply = await host.send('alpha', { payload: { n: 1 } })
    assert.equal(reply.delivered, true)
    assert.equal(reply.woke, true)
    assert.equal(typeof reply.wakeMs, 'number')
    assert.deepEqual(probe.spawnCalls.at(-1), { wake: { discoveryWindowMs: 40, podId: 'id-of-alpha' } })
    assert.equal((await base.status('alpha')).state, POD_LIFECYCLE.REGISTERED)
    assert.equal((await host.status('alpha')).sleeping, undefined)
    assert.equal((await host.status('alpha')).podId, 'id-of-alpha')
  })

  it('a wake emits waking then woke lifecycle events, and never an exit', async () => {
    const { host, events } = await asleep()
    await host.send('alpha', { payload: 1 })
    const reasons = events.filter((e) => e.kind === POD_HOST_EVENT_KIND.LIFECYCLE && e.data.name === 'alpha').map((e) => e.data.reason)
    assert.ok(reasons.includes('waking'))
    assert.ok(reasons.includes('woke'))
    assert.equal(events.filter((e) => e.kind === POD_HOST_EVENT_KIND.EXIT).length, 0)
  })

  it('status and list do not wake; they show the pod cold with its podId', async () => {
    const { host, probe } = await asleep()
    const spawnsBefore = probe.spawns
    const listed = (await host.list()).find((s) => s.name === 'alpha')
    assert.equal(listed.sleeping, true)
    assert.equal(listed.state, POD_LIFECYCLE.COLD)
    assert.equal((await host.status('alpha')).sleeping, true)
    assert.equal(probe.spawns, spawnsBefore)
  })

  it('while a wake is in flight, status says booting and concurrent sends share one boot and arrive in order', async () => {
    const { host, probe, base } = await asleep()
    let open
    probe.gate = new Promise((resolve) => { open = resolve })
    const sends = [1, 2, 3].map((n) => host.send('alpha', { payload: n }))
    await tick()
    const mid = await host.status('alpha')
    assert.equal(mid.state, POD_LIFECYCLE.BOOTING)
    assert.equal(mid.waking, true)
    probe.gate = null
    open()
    const replies = await Promise.all(sends)
    assert.ok(replies.every((r) => r.delivered && r.woke))
    assert.equal(probe.spawnCalls.length, 2, 'one initial spawn and one wake, however many senders')
    assert.equal((await base.list())[0].inbox, 3)
  })

  it('messages reach the pod in the order they were sent', async () => {
    const { host, probe, base } = await asleep()
    const seen = []
    const original = base.send.bind(base)
    base.send = async (name, msg) => { seen.push(msg.payload); return original(name, msg) }
    let open
    probe.gate = new Promise((resolve) => { open = resolve })
    const sends = [1, 2, 3, 4].map((n) => host.send('alpha', { payload: n }))
    await tick()
    probe.gate = null
    open()
    await Promise.all(sends)
    assert.deepEqual(seen, [1, 2, 3, 4])
  })

  it('the queue is bounded: past maxQueuedPerPod a send is refused EBUSY wake-queue-full and nothing is lost for the others', async () => {
    const { host, probe } = await asleep({ driver: { maxQueuedPerPod: 2 } })
    let open
    probe.gate = new Promise((resolve) => { open = resolve })
    const a = host.send('alpha', { payload: 1 })
    const b = host.send('alpha', { payload: 2 })
    await tick()
    const err = await rejection(host.send('alpha', { payload: 3 }))
    assert.equal(err.code, POD_HOST_ERROR.EBUSY)
    assert.equal(err.details.reason, WAKE_FAILURE.QUEUE_FULL)
    probe.gate = null
    open()
    assert.equal((await a).delivered, true)
    assert.equal((await b).delivered, true)
  })

  it('a wake that takes longer than wakeTimeoutMs fails the caller ETIMEDOUT wake-timeout, and the pod stays asleep until the boot finishes', async () => {
    const { clock, host, probe, store } = await asleep()
    let open
    probe.gate = new Promise((resolve) => { open = resolve })
    const pending = host.send('alpha', { payload: 1 })
    const outcome = rejection(pending)
    await tick()
    clock.advance(500)
    const err = await outcome
    assert.equal(err.code, POD_HOST_ERROR.ETIMEDOUT)
    assert.equal(err.details.reason, WAKE_FAILURE.TIMEOUT)
    assert.equal(err.details.wakeTimeoutMs, 500)
    assert.ok(await store.get('alpha'), 'the record is kept while the boot has not finished')
    probe.gate = null
    open()
    await tick()
    await tick()
    // The boot completed in the background: the next send finds the pod awake and does not wake it again.
    const reply = await host.send('alpha', { payload: 2 })
    assert.equal(reply.woke, undefined)
    assert.equal(await store.get('alpha'), null)
  })

  it('a wake that fails keeps the pod asleep with its record, names the failure, and the next send tries again', async () => {
    const { host, probe, store } = await asleep()
    probe.failNext = new PodHostDriverError(POD_HOST_ERROR.EBUSY, 'relay unreachable')
    const err = await rejection(host.send('alpha', { payload: 1 }))
    assert.equal(err.code, POD_HOST_ERROR.EBUSY)
    assert.equal(err.details.reason, WAKE_FAILURE.FAILED)
    assert.match(err.message, /relay unreachable/)
    const record = await store.get('alpha')
    assert.equal(record.lastWakeError.code, POD_HOST_ERROR.EBUSY)
    assert.equal((await host.status('alpha')).sleeping, true)
    const reply = await host.send('alpha', { payload: 2 })
    assert.equal(reply.woke, true)
  })

  it('the pod must keep its identity: a different podId after the boot fails the wake and drains the stranger', async () => {
    const { host, probe, base, store } = await asleep()
    probe.podId = (name) => `other-${name}`
    const err = await rejection(host.send('alpha', { payload: 1 }))
    assert.equal(err.code, POD_HOST_ERROR.EINVAL)
    assert.equal(err.details.reason, WAKE_FAILURE.IDENTITY)
    assert.equal((await base.status('alpha')).state, POD_LIFECYCLE.GONE)
    assert.ok(await store.get('alpha'))
  })

  it('wakes are bounded in number at once: past maxConcurrentWakes a wake is refused EBUSY wake-capacity', async () => {
    const ctx = setup({ driver: { maxConcurrentWakes: 1 } })
    for (const n of ['one', 'two']) await ctx.host.spawn(spec(n))
    ctx.clock.advance(1000)
    await ctx.host.sweep()
    let open
    ctx.probe.gate = new Promise((resolve) => { open = resolve })
    const first = ctx.host.send('one', { payload: 1 })
    await tick()
    const err = await rejection(ctx.host.send('two', { payload: 1 }))
    assert.equal(err.code, POD_HOST_ERROR.EBUSY)
    assert.equal(err.details.reason, WAKE_FAILURE.CAPACITY)
    ctx.probe.gate = null
    open()
    await first
    assert.equal((await ctx.host.send('two', { payload: 1 })).woke, true)
  })

  it('admitWake can refuse a wake, and then the pod is not booted', async () => {
    const calls = []
    const { host, probe } = await asleep({
      driver: { admitWake: async ({ name }) => { calls.push(name); throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, 'no room', { reason: WAKE_FAILURE.REFUSED }) } },
    })
    const spawnsBefore = probe.spawns
    const err = await rejection(host.send('alpha', { payload: 1 }))
    assert.equal(err.details.reason, WAKE_FAILURE.REFUSED)
    assert.deepEqual(calls, ['alpha'])
    assert.equal(probe.spawns, spawnsBefore)
    assert.equal((await host.status('alpha')).sleeping, true)
  })

  it('a verb the lane cannot serve is refused as the lane refuses it, without waking the pod', async () => {
    const { host, probe } = await asleep()
    const spawnsBefore = probe.spawns
    const err = await rejection(host.exec('alpha', ['ls']))
    assert.equal(err.code, POD_HOST_ERROR.ELANE)
    assert.equal(probe.spawns, spawnsBefore)
  })

  it('snapshot and restore of a sleeping pod are refused EBUSY asleep: they are not waking verbs', async () => {
    const ctx = setup({ lane: 'node' })
    await ctx.host.spawn({ name: 'alpha', lane: 'node', run: { kind: 'skill', ref: 'x' } })
    ctx.clock.advance(1000)
    await ctx.host.sweep()
    const spawnsBefore = ctx.probe.spawns
    for (const verb of ['snapshot', 'restore']) {
      const err = await rejection(ctx.host[verb]('alpha'))
      assert.equal(err.code, POD_HOST_ERROR.EBUSY, verb)
      assert.equal(err.details.reason, 'asleep', verb)
    }
    assert.equal(ctx.probe.spawns, spawnsBefore)
  })
})

describe('what survives, and how a sleeping pod is found', () => {
  it('a host restart keeps its sleepers: a new driver over the same store lists and wakes them', async () => {
    const store = new MemoryHibernationStore()
    const first = setup({ store })
    await first.host.spawn(spec())
    first.clock.advance(1000)
    await first.host.sweep()

    const second = setup({ store })
    const listed = await second.host.list()
    assert.deepEqual(listed.map((s) => [s.name, s.sleeping, s.podId]), [['alpha', true, 'id-of-alpha']])
    const reply = await second.host.send('alpha', { payload: 1 })
    assert.equal(reply.woke, true)
    assert.equal(second.probe.spawnCalls.length, 1)
  })

  it('deliver() wakes the pod that holds a podId, and refuses a podId nobody holds', async () => {
    const ctx = setup()
    await ctx.host.spawn(spec())
    ctx.clock.advance(1000)
    await ctx.host.sweep()
    assert.equal(await ctx.host.resolve('id-of-alpha'), 'alpha')
    assert.equal(await ctx.host.resolve('id-of-nobody'), null)
    const reply = await ctx.host.deliver('id-of-alpha', { payload: 'hello' })
    assert.equal(reply.woke, true)
    const err = await rejection(ctx.host.deliver('id-of-nobody', { payload: 'hello' }))
    assert.equal(err.code, POD_HOST_ERROR.ENOENT)
  })

  it('a pod that exists asleep cannot be spawned again', async () => {
    const ctx = setup()
    await ctx.host.spawn(spec())
    ctx.clock.advance(1000)
    await ctx.host.sweep()
    const err = await rejection(ctx.host.spawn(spec()))
    assert.equal(err.code, POD_HOST_ERROR.EEXIST)
  })

  it('drain of a sleeping pod removes the record without waking it, and says drained to its listeners', async () => {
    const { clock, host, store, probe, events } = setup()
    await host.spawn(spec())
    clock.advance(1000)
    await host.sweep()
    events.length = 0
    const spawnsBefore = probe.spawns
    const status = await host.drain('alpha')
    assert.equal(status.state, POD_LIFECYCLE.GONE)
    assert.equal(probe.spawns, spawnsBefore)
    assert.equal(await store.get('alpha'), null)
    const exits = events.filter((e) => e.kind === POD_HOST_EVENT_KIND.EXIT)
    assert.equal(exits.length, 1)
    assert.equal(exits[0].data.restartable, false)
    assert.equal(exits[0].data.reason, 'drained')
    assert.equal((await rejection(host.send('alpha', { payload: 1 }))).code, POD_HOST_ERROR.ENOENT)
  })

  it('drain during a wake waits for the boot and then drains the pod', async () => {
    const { clock, host, probe, base } = setup()
    await host.spawn(spec())
    clock.advance(1000)
    await host.sweep()
    let open
    probe.gate = new Promise((resolve) => { open = resolve })
    const send = host.send('alpha', { payload: 1 })
    await tick()
    const drain = host.drain('alpha')
    probe.gate = null
    open()
    // Whether the message is delivered before the drain is not promised; the drain is.
    const [, drained] = await Promise.allSettled([send, drain])
    assert.equal(drained.value.state, POD_LIFECYCLE.GONE)
    assert.equal((await base.status('alpha')).state, POD_LIFECYCLE.GONE)
  })
})

describe('the driver surface', () => {
  it('states its hibernation policy in capabilities() and keeps the lane verbs unchanged', () => {
    const { host, inner } = setup()
    const caps = host.capabilities()
    assert.deepEqual(caps.verbs, inner.capabilities().verbs)
    assert.deepEqual(caps.hibernation, { idleMs: 1000, wakeTimeoutMs: 500, discoveryWindowMs: 40 })
    assert.equal(host.lane, 'isolate')
  })

  it('has bounded, documented defaults, and refuses values that are not positive numbers', () => {
    assert.deepEqual(Object.keys(HIBERNATION_DEFAULTS).sort(), ['discoveryWindowMs', 'idleMs', 'maxConcurrentWakes', 'maxQueuedPerPod', 'wakeTimeoutMs'])
    assert.ok(HIBERNATION_DEFAULTS.discoveryWindowMs < 1500, 'shorter than the 1.5 s a first boot waits')
    const { driver } = makeInner()
    for (const bad of [{ idleMs: 0 }, { wakeTimeoutMs: -1 }, { discoveryWindowMs: -5 }, { maxQueuedPerPod: 0 }, { maxConcurrentWakes: 1.5 }, { idleMs: 'x' }]) {
      assert.throws(() => createHibernatingDriver(driver, bad), /must be/, JSON.stringify(bad))
    }
    assert.throws(() => createHibernatingDriver({}, {}), /PodHostDriver/)
  })

  it('counts what happened', async () => {
    const { clock, host, probe } = setup()
    await host.spawn(spec())
    clock.advance(1000)
    await host.sweep()
    await host.send('alpha', { payload: 1 })
    probe.failNext = null
    const stats = host.stats()
    assert.equal(stats.sleeps, 1)
    assert.equal(stats.wakes, 1)
    assert.equal(stats.wakeFailures, 0)
    assert.equal(typeof stats.lastWakeMs, 'number')
  })

  it('an automatic sweep runs on the injected timer and stops on dispose()', async () => {
    const ctx = setup({ driver: { sweepIntervalMs: 250 } })
    await ctx.host.spawn(spec())
    ctx.host.start()
    assert.equal(ctx.clock.pending(), 1)
    ctx.clock.advance(1000)
    await tick()
    await tick()
    assert.equal((await ctx.host.status('alpha')).sleeping, true)
    ctx.host.dispose()
    assert.equal(ctx.clock.pending(), 0)
  })
})
