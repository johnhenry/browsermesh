// #472, the two mechanisms on their own, on fake timers: the early cut of an upload that cannot finish, and the bounded FIFO wait for an upload slot.
import { describe, it, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { INGRESS_LIMIT_DEFAULTS, createProgressMonitor, createUploadSlots, resolveLimits } from '../src/limits.mjs'

afterEach(() => mock.timers.reset())
const fake = () => { mock.timers.reset(); mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 }) }

describe('defaults and validation', () => {
  it('queue and maximum-rate options exist with their documented defaults', () => {
    assert.equal(INGRESS_LIMIT_DEFAULTS.uploadQueueMs, 2000)
    assert.equal(INGRESS_LIMIT_DEFAULTS.uploadQueueMax, 8)
    assert.equal(INGRESS_LIMIT_DEFAULTS.uploadMaxBytesPerSec, 256 * 1024 * 1024)
  })
  it('a queue of 0 (off) is allowed; a negative or fractional one is not', () => {
    assert.equal(resolveLimits({ uploadQueueMs: 0 }).uploadQueueMs, 0)
    assert.equal(resolveLimits({ uploadQueueMax: 0 }).uploadQueueMax, 0)
    for (const bad of [{ uploadQueueMs: -1 }, { uploadQueueMax: 1.5 }, { uploadMaxBytesPerSec: 0 }]) assert.throws(() => resolveLimits(bad), TypeError)
  })
})

describe('the early cut: remaining bytes against the remaining deadline, at the observed rate', () => {
  // The sender is waited on for the whole of the first 30 s (the grace); `bytes` arrive in that time; the deadline is `deadline` ms from the start.
  function run({ bytes, declared, deadline = 300_000, extraWaitedMs = 0 }) {
    fake()
    let cut = null
    const m = createProgressMonitor({ graceMs: 30_000, windowMs: 10_000, minBytesPerSec: 1, now: () => Date.now(), declared, deadlineAt: deadline, onStall: () => { cut = 'stall' }, onCannotFinish: () => { cut = 'cannot-finish' } })
    m.waiting()
    mock.timers.tick(29_999)
    m.got(bytes)
    m.waiting()
    mock.timers.tick(1) // the grace ends: the first look
    void extraWaitedMs
    m.stop()
    return cut
  }

  it('an upload that can finish exactly is not cut; one byte more than it can is', () => {
    // 10_000 bytes in 30_000 ms of waiting on the sender = 1 byte per 3 ms; 270_000 ms are left = 90_000 more bytes.
    assert.equal(run({ bytes: 10_000, declared: 100_000 }), null)
    assert.equal(run({ bytes: 10_000, declared: 100_001 }), 'cannot-finish')
  })

  it('one second short of the deadline cuts what could just finish', () => {
    assert.equal(run({ bytes: 10_000, declared: 100_000, deadline: 300_000 }), null)
    assert.equal(run({ bytes: 10_000, declared: 100_000, deadline: 299_000 }), 'cannot-finish')
  })

  it('an upload of unknown length is never cut by the projection', () => {
    assert.equal(run({ bytes: 10_000, declared: undefined }), null)
  })

  it('does not look before the grace period is over', () => {
    fake()
    let cut = null
    const m = createProgressMonitor({ graceMs: 30_000, windowMs: 10_000, minBytesPerSec: 1, now: () => Date.now(), declared: 1e9, deadlineAt: 300_000, onStall: () => { cut = 'stall' }, onCannotFinish: () => { cut = 'cannot-finish' } })
    m.waiting()
    mock.timers.tick(29_999)
    assert.equal(cut, null)
    m.stop()
  })

  it('time spent waiting on the origin is not counted against the sender', () => {
    fake()
    let cut = null
    const m = createProgressMonitor({ graceMs: 30_000, windowMs: 10_000, minBytesPerSec: 1, now: () => Date.now(), declared: 60_000_000, deadlineAt: 130_000, onStall: () => { cut = 'stall' }, onCannotFinish: () => { cut = 'cannot-finish' } })
    // 6 s waiting on the sender at 1 MB/s, 24 s waiting on a slow origin (the sender is not being waited on).
    m.waiting()
    mock.timers.tick(6000)
    m.got(6_000_000)
    mock.timers.tick(24_000) // grace ends here: 54 MB left, 100 s left, the sender's own rate is 1 MB/s
    assert.equal(cut, null, 'by the sender\'s rate 54 s are needed, 100 s are left')
    m.stop()
  })

  it('looks again every window: a sender that slows down is cut at the next look', () => {
    fake()
    let cut = null
    const m = createProgressMonitor({ graceMs: 30_000, windowMs: 10_000, minBytesPerSec: 1, now: () => Date.now(), declared: 40_000, deadlineAt: 60_000, onStall: () => { cut = 'stall' }, onCannotFinish: () => { cut = 'cannot-finish' } })
    m.waiting()
    mock.timers.tick(29_999)
    m.got(20_000) // 20_000 bytes in 30 s: 20_000 left, 30 s left, rate 0.67/ms -> 20_000 needed 30_000 ms: exactly
    m.waiting()
    mock.timers.tick(1)
    assert.equal(cut, null)
    mock.timers.tick(10_000) // 10 s more with nothing arriving: 20_000 left in 20 s needs 1000 B/s over 40 s of waiting at the average 500 B/s
    assert.equal(cut, 'cannot-finish')
    m.stop()
  })
})

describe('the upload slot queue', () => {
  const slots = (o = {}) => createUploadSlots({ limit: () => 2, queueMax: 2, queueMs: 1000, ...o })
  const signal = () => new AbortController()
  const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

  it('grants a free slot at once (synchronously) and counts it until released, once', () => {
    const s = slots()
    const a = s.acquire(signal().signal)
    assert.equal(typeof a, 'function')
    assert.equal(s.active, 1)
    a(); a()
    assert.equal(s.active, 0)
  })

  it('a request that finds the slots busy waits, and is granted when one frees', async () => {
    fake()
    const s = slots()
    const r1 = s.acquire(signal().signal)
    s.acquire(signal().signal)
    const waiting = s.acquire(signal().signal)
    assert.ok(waiting instanceof Promise)
    assert.equal(s.queued, 1)
    r1()
    const got = await waiting
    assert.equal(typeof got, 'function')
    assert.equal(s.active, 2)
    assert.equal(s.queued, 0)
  })

  it('is FIFO: the oldest waiter gets the freed slot, and a newcomer cannot jump ahead of the queue', async () => {
    fake()
    const s = slots({ queueMax: 5 })
    const [r1] = [s.acquire(signal().signal), s.acquire(signal().signal)]
    const order = []
    const w1 = s.acquire(signal().signal).then((r) => { order.push(1); return r })
    const w2 = s.acquire(signal().signal).then((r) => { order.push(2); return r })
    r1()
    const g1 = await w1
    await settle()
    assert.deepEqual(order, [1], 'the second is still waiting')
    const w3 = s.acquire(signal().signal).then((r) => { order.push(3); return r })
    g1()
    await w2
    assert.deepEqual(order, [1, 2])
    assert.equal(s.queued, 1, 'the newcomer waits behind the older entry')
    ;(await w2)()
    await w3
    assert.deepEqual(order, [1, 2, 3])
  })

  it('beyond the queue length: refused at once with "full"', async () => {
    fake()
    const s = slots()
    s.acquire(signal().signal); s.acquire(signal().signal)
    const w1 = s.acquire(signal().signal); const w2 = s.acquire(signal().signal)
    await assert.rejects(s.acquire(signal().signal), { queue: 'full' })
    assert.equal(s.queued, 2)
    w1.catch(() => {}); w2.catch(() => {})
  })

  it('a queue of length 0 is the old behaviour: refused at once', async () => {
    const s = slots({ queueMax: 0 })
    s.acquire(signal().signal); s.acquire(signal().signal)
    await assert.rejects(s.acquire(signal().signal), { queue: 'full' })
  })

  it('waits at most queueMs, then "timeout", and leaves the queue', async () => {
    fake()
    const s = slots()
    s.acquire(signal().signal); s.acquire(signal().signal)
    const w = s.acquire(signal().signal)
    const done = assert.rejects(w, { queue: 'timeout' })
    mock.timers.tick(999)
    assert.equal(s.queued, 1)
    mock.timers.tick(1)
    await done
    assert.equal(s.queued, 0)
  })

  it('a waiter whose request ends (the client disconnects) leaves the queue at once with the abort reason', async () => {
    fake()
    const s = slots()
    s.acquire(signal().signal); const r2 = s.acquire(signal().signal)
    const ac = signal()
    const w = s.acquire(ac.signal)
    const reason = new Error('client went away')
    const done = assert.rejects(w, (e) => e === reason)
    ac.abort(reason)
    await done
    assert.equal(s.queued, 0)
    r2()
    assert.equal(s.active, 1, 'the freed slot is not granted to the departed waiter')
  })

  it('an already-aborted request is not queued at all', async () => {
    const s = slots()
    s.acquire(signal().signal); s.acquire(signal().signal)
    const ac = signal(); ac.abort(new Error('gone'))
    await assert.rejects(s.acquire(ac.signal), { message: 'gone' })
    assert.equal(s.queued, 0)
  })

  it('several slots freeing at once drain several waiters, and nothing leaks', async () => {
    fake()
    const s = slots({ queueMax: 4 })
    const a = s.acquire(signal().signal); const b = s.acquire(signal().signal)
    const w1 = s.acquire(signal().signal); const w2 = s.acquire(signal().signal); const w3 = s.acquire(signal().signal)
    a(); b()
    const [g1, g2] = await Promise.all([w1, w2])
    assert.equal(s.active, 2)
    assert.equal(s.queued, 1)
    g1(); g2()
    const g3 = await w3
    g3()
    assert.equal(s.active, 0)
    assert.equal(s.queued, 0)
    mock.timers.tick(5000) // no stray timer fires on anything
    assert.equal(s.active, 0)
  })

  it('a timed-out waiter in the middle does not block the ones behind it', async () => {
    fake()
    const s = slots({ queueMax: 3 })
    const a = s.acquire(signal().signal); s.acquire(signal().signal)
    const w1 = s.acquire(signal().signal); const e1 = assert.rejects(w1, { queue: 'timeout' })
    mock.timers.tick(500)
    const w2 = s.acquire(signal().signal)
    mock.timers.tick(500)
    await e1
    a()
    const g2 = await w2
    assert.equal(typeof g2, 'function')
    assert.equal(s.active, 2)
  })
})
