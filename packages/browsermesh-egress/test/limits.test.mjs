import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EGRESS_LIMIT_DEFAULTS, createByteBudget, createInflight, createRateLimiter, parseBytes, parseDuration, resolveLimits } from '../src/limits.mjs'

const MiB = 1024 * 1024

describe('the defaults are the ones the README states', () => {
  it('16 connections per consumer, 64 in all, 120 and 600 attempts a minute, 64 MiB a connection, 1 GiB a consumer a day, 15 s, 5 min, 1 h', () => {
    assert.equal(EGRESS_LIMIT_DEFAULTS.maxConnectionsPerConsumer, 16)
    assert.equal(EGRESS_LIMIT_DEFAULTS.maxConnections, 64)
    assert.deepEqual({ ...EGRESS_LIMIT_DEFAULTS.connectRate }, { limit: 120, windowMs: 60_000 })
    assert.deepEqual({ ...EGRESS_LIMIT_DEFAULTS.globalConnectRate }, { limit: 600, windowMs: 60_000 })
    assert.equal(EGRESS_LIMIT_DEFAULTS.maxBytesPerConnection, 64 * MiB)
    assert.deepEqual({ ...EGRESS_LIMIT_DEFAULTS.maxBytesPerConsumer }, { limit: 1024 * MiB, windowMs: 86_400_000 })
    assert.equal(EGRESS_LIMIT_DEFAULTS.connectTimeoutMs, 15_000)
    assert.equal(EGRESS_LIMIT_DEFAULTS.idleMs, 300_000)
    assert.equal(EGRESS_LIMIT_DEFAULTS.maxDurationMs, 3_600_000)
    assert.deepEqual({ ...EGRESS_LIMIT_DEFAULTS.dnsRate }, { limit: 30, windowMs: 60_000 })
  })
})

describe('resolveLimits', () => {
  it('overlays what is given and returns every limit', () => {
    const l = resolveLimits({ maxConnections: 3 })
    assert.equal(l.maxConnections, 3)
    assert.equal(l.maxConnectionsPerConsumer, 16)
  })

  it('there is no way to say unlimited: zero, negative, fractional, infinite and non-numbers are refused, as is an unknown name', () => {
    for (const v of [0, -1, 1.5, Infinity, NaN, '5', null, undefined, true]) {
      if (v === undefined) continue
      assert.throws(() => resolveLimits({ maxConnections: v }), TypeError, String(v))
      assert.throws(() => resolveLimits({ idleMs: v }), TypeError, String(v))
    }
    for (const bad of [{ limit: Infinity, windowMs: 1 }, { limit: 1, windowMs: 0 }, { limit: 0, windowMs: 1 }, null, 5, { limit: 1 }]) {
      assert.throws(() => resolveLimits({ connectRate: bad }), TypeError)
      assert.throws(() => resolveLimits({ maxBytesPerConsumer: bad }), TypeError)
    }
    assert.throws(() => resolveLimits({ maxConnection: 1 }), /not a limit/)
    assert.throws(() => resolveLimits(null), TypeError)
    assert.throws(() => resolveLimits({ streamWindowBytes: 32 * MiB }), /16 MiB/)
  })
})

describe('the mechanisms', () => {
  it('a rate limiter counts per key in a fixed window and starts a new one after it, against a clock the test owns', () => {
    let t = 0
    const r = createRateLimiter({ limit: 2, windowMs: 100 }, { now: () => t })
    assert.equal(r.take('a').ok, true)
    assert.equal(r.take('a').ok, true)
    const refused = r.take('a')
    assert.equal(refused.ok, false)
    assert.equal(refused.retryAfterMs, 100)
    assert.equal(r.take('b').ok, true, 'another key has its own window')
    t = 100
    assert.equal(r.take('a').ok, true)
  })

  it('a rate limiter forgets the oldest keys past maxTracked, so its memory is bounded', () => {
    const r = createRateLimiter({ limit: 1, windowMs: 1000 }, { now: () => 0, maxTracked: 3 })
    for (let i = 0; i < 20; i++) r.take(`k${i}`)
    assert.ok(r.size() <= 3)
  })

  it('a byte budget adds per key and resets with its window', () => {
    let t = 0
    const b = createByteBudget({ limit: 100, windowMs: 1000 }, { now: () => t })
    assert.equal(b.add('p', 60), true)
    assert.equal(b.spent('p'), false)
    assert.equal(b.add('p', 60), false)
    assert.equal(b.spent('p'), true)
    assert.equal(b.used('q'), 0)
    t = 1000
    assert.equal(b.spent('p'), false)
    assert.equal(b.used('p'), 0)
  })

  it('in-flight counts hand out releases that work once, and refuse past a cap and past maxTracked keys', () => {
    const f = createInflight({ maxTracked: 2 })
    const a = f.enter('x', 1)
    assert.equal(f.enter('x', 1), null)
    a()
    a()
    assert.equal(f.count('x'), 0)
    assert.ok(f.enter('x', 1))
    assert.ok(f.enter('y', 1))
    assert.equal(f.enter('z', 1), null, 'a third key is refused while two are tracked')
  })

  it('parses durations and sizes', () => {
    assert.equal(parseDuration('15s'), 15_000)
    assert.equal(parseDuration('5m'), 300_000)
    assert.equal(parseDuration('1h'), 3_600_000)
    assert.equal(parseDuration('250'), 250)
    assert.equal(parseBytes('64MiB'), 64 * MiB)
    assert.equal(parseBytes('1g'), 1024 * MiB)
    assert.equal(parseBytes('256k'), 256 * 1024)
    for (const bad of ['', 'x', '0', '-1', '1 parsec', '1.5m']) assert.throws(() => parseBytes(bad), TypeError)
    for (const bad of ['', 'x', '0s', '-1s']) assert.throws(() => parseDuration(bad), TypeError)
  })
})
