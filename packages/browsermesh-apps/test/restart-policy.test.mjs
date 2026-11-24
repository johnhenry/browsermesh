// Run with: node --import ./test/_setup-globals.mjs --test test/restart-policy.test.mjs
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_RESTARTS,
  MAX_BACKOFF_MS,
  decideRestart,
  policyWantsRestart,
  restartDelayMs,
} from '../src/restart-policy.mjs'

describe('policyWantsRestart', () => {
  it("'never' never restarts, whatever happened", () => {
    for (const exit of [{ code: 1 }, { code: 0 }, { reason: 'crashed' }, { reason: 'host-lost' }]) {
      assert.equal(policyWantsRestart('never', exit), false)
    }
  })

  it("'on-failure' restarts a non-zero exit, a crash and a lost host, not a clean exit", () => {
    assert.equal(policyWantsRestart('on-failure', { code: 1 }), true)
    assert.equal(policyWantsRestart('on-failure', { code: 0, reason: 'crashed' }), true)
    assert.equal(policyWantsRestart('on-failure', { code: 0, reason: 'host-lost' }), true)
    assert.equal(policyWantsRestart('on-failure', { code: 0 }), false)
  })

  it("'always' restarts a clean exit too", () => {
    assert.equal(policyWantsRestart('always', { code: 0 }), true)
  })

  it('an unknown policy restarts nothing', () => {
    assert.equal(policyWantsRestart('sometimes', { code: 1 }), false)
    assert.equal(policyWantsRestart(undefined, { code: 1 }), false)
  })
})

describe('restartDelayMs', () => {
  it('doubles per restart already made and stops at the cap', () => {
    assert.equal(restartDelayMs(0, 100), 100)
    assert.equal(restartDelayMs(1, 100), 200)
    assert.equal(restartDelayMs(3, 100), 800)
    assert.equal(restartDelayMs(40, 100), MAX_BACKOFF_MS)
  })

  it('uses the default base when none is given', () => {
    assert.equal(restartDelayMs(0), DEFAULT_BACKOFF_MS)
  })
})

describe('decideRestart', () => {
  it('never restarts an intentional drain, even under the always policy', () => {
    assert.deepEqual(
      decideRestart({ restart: { policy: 'always' }, exit: { code: 0, reason: 'drained' }, restartsSoFar: 0 }),
      { restart: false, why: 'drained' },
    )
  })

  it('follows the policy and reports why it did not restart', () => {
    assert.deepEqual(
      decideRestart({ restart: { policy: 'on-failure' }, exit: { code: 0 }, restartsSoFar: 0 }),
      { restart: false, why: 'policy' },
    )
  })

  it('schedules a restart with exponential backoff, then gives up at maxRestarts', () => {
    const restart = { policy: 'on-failure', maxRestarts: 2, backoffMs: 50 }
    const exit = { code: 1, reason: 'crashed' }
    assert.deepEqual(decideRestart({ restart, exit, restartsSoFar: 0 }), { restart: true, delayMs: 50, why: 'restart' })
    assert.deepEqual(decideRestart({ restart, exit, restartsSoFar: 1 }), { restart: true, delayMs: 100, why: 'restart' })
    assert.deepEqual(decideRestart({ restart, exit, restartsSoFar: 2 }), { restart: false, why: 'gave-up' })
  })

  it('applies the documented defaults when the podspec says nothing', () => {
    const decision = decideRestart({ restart: { policy: 'always' }, exit: { code: 1 }, restartsSoFar: 0 })
    assert.equal(decision.delayMs, DEFAULT_BACKOFF_MS)
    assert.equal(decideRestart({ restart: { policy: 'always' }, exit: { code: 1 }, restartsSoFar: DEFAULT_MAX_RESTARTS }).restart, false)
  })
})
