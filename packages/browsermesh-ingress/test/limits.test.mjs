import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { INGRESS_LIMIT_DEFAULTS, createInflight, createRateLimiter, parseBytes, parseDuration, resolveLimits } from '../src/limits.mjs'

describe('defaults', () => {
  it('are the documented ones', () => {
    assert.equal(INGRESS_LIMIT_DEFAULTS.maxRequestBodyBytes, 64 * 1024)
    assert.equal(INGRESS_LIMIT_DEFAULTS.timeoutMs, 30_000)
    assert.equal(INGRESS_LIMIT_DEFAULTS.maxInflight, 64)
    assert.equal(INGRESS_LIMIT_DEFAULTS.maxInflightPerClient, 8)
    assert.equal(INGRESS_LIMIT_DEFAULTS.maxInflightPerProvider, 16)
    assert.ok(Object.isFrozen(INGRESS_LIMIT_DEFAULTS))
  })
  it('a given limit overrides one default and is validated', () => {
    assert.equal(resolveLimits({ timeoutMs: 5 }).timeoutMs, 5)
    assert.equal(resolveLimits({ timeoutMs: 5 }).maxInflight, 64)
    for (const bad of [{ timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }, { timeoutMs: '5' }, { maxInflight: NaN }, { clientRate: { limit: 0, windowMs: 1 } }, { providerRate: null }]) {
      assert.throws(() => resolveLimits(bad), TypeError)
    }
  })
})

describe('the rate limiter', () => {
  it('counts per key in a window on an injected clock, and forgets the window when it ends', () => {
    let now = 0
    const r = createRateLimiter({ limit: 2, windowMs: 100 }, { now: () => now })
    assert.ok(r.take('a').ok && r.take('a').ok)
    const third = r.take('a')
    assert.equal(third.ok, false)
    assert.equal(third.retryAfterMs, 100)
    assert.ok(r.take('b').ok)
    now = 99
    assert.equal(r.take('a').ok, false)
    now = 100
    assert.ok(r.take('a').ok)
  })
  it('is bounded in memory: past maxTracked keys the oldest windows are forgotten', () => {
    const r = createRateLimiter({ limit: 1, windowMs: 1_000_000 }, { now: () => 0, maxTracked: 3 })
    for (const k of ['a', 'b', 'c', 'd', 'e']) r.take(k)
    assert.equal(r.size(), 3)
  })
})

describe('in-flight counts', () => {
  it('enter until the cap, release once (a second release does nothing), then enter again', () => {
    const c = createInflight()
    const a = c.enter('k', 2)
    const b = c.enter('k', 2)
    assert.equal(c.enter('k', 2), null)
    assert.equal(c.count('k'), 2)
    a(); a()
    assert.equal(c.count('k'), 1)
    assert.ok(c.enter('k', 2))
    b()
  })
  it('keys are independent and the table is bounded', () => {
    const c = createInflight({ maxTracked: 2 })
    assert.ok(c.enter('a', 1) && c.enter('b', 1))
    assert.equal(c.enter('c', 1), null)
  })
})

describe('sizes and durations', () => {
  it('parse the forms the CLI accepts', () => {
    assert.equal(parseBytes('65536'), 65536)
    assert.equal(parseBytes('64k'), 65536)
    assert.equal(parseBytes('64KiB'), 65536)
    assert.equal(parseBytes('2m'), 2 * 1024 * 1024)
    assert.equal(parseDuration('30s'), 30_000)
    assert.equal(parseDuration('500ms'), 500)
    assert.equal(parseDuration('2m'), 120_000)
    assert.equal(parseDuration('1500'), 1500)
    for (const bad of ['', 'x', '-1', '0', '1.5k', '10 parsecs']) assert.throws(() => parseBytes(bad), TypeError)
    for (const bad of ['', 'x', '-1s', '0s', '5h']) assert.throws(() => parseDuration(bad), TypeError)
  })
})
