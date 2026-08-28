// Run with: node --import ./test/_setup-globals.mjs --test test/peer-verification.test.mjs
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  VERIFICATION_STRATEGIES,
  VERIFICATION_DEFAULTS,
  Attestation,
  VerificationQuorum,
  computeResultHash,
} from '../src/peer-verification.mjs'

// ── Helpers ──────────────────────────────────────────────────────────

/** Build a mock scheduler that returns a fixed result per peerId */
function mockScheduler(resultMap) {
  return {
    async dispatch(peerId, job) {
      if (resultMap instanceof Function) return resultMap(peerId, job)
      return resultMap[peerId] ?? resultMap['*'] ?? { answer: 42 }
    },
  }
}

/** Build a mock trust system */
function mockTrust(peers, reputations = {}) {
  return {
    getReputation(podId) {
      return reputations[podId] ?? 0.5
    },
    listTrustedPeers(threshold) {
      if (threshold != null) {
        return peers.filter((p) => (reputations[p] ?? 0.5) >= threshold)
      }
      return [...peers]
    },
  }
}

/** Create a slow scheduler that delays a specific peer */
function slowScheduler(slowPeer, delayMs, resultMap) {
  return {
    async dispatch(peerId, job) {
      if (peerId === slowPeer) {
        await new Promise((r) => setTimeout(r, delayMs))
      }
      if (resultMap instanceof Function) return resultMap(peerId, job)
      return resultMap[peerId] ?? resultMap['*'] ?? { answer: 42 }
    },
  }
}

// ── VERIFICATION_STRATEGIES ──────────────────────────────────────────

describe('VERIFICATION_STRATEGIES', () => {
  it('is frozen with expected values', () => {
    assert.ok(Object.isFrozen(VERIFICATION_STRATEGIES))
    assert.equal(VERIFICATION_STRATEGIES.UNANIMOUS, 'unanimous')
    assert.equal(VERIFICATION_STRATEGIES.MAJORITY, 'majority')
    assert.equal(VERIFICATION_STRATEGIES.THRESHOLD, 'threshold')
    assert.equal(VERIFICATION_STRATEGIES.BYZANTINE, 'byzantine')
  })
})

// ── VERIFICATION_DEFAULTS ────────────────────────────────────────────

describe('VERIFICATION_DEFAULTS', () => {
  // Test 15: Default strategy is majority
  it('default strategy is majority', () => {
    assert.ok(Object.isFrozen(VERIFICATION_DEFAULTS))
    assert.equal(VERIFICATION_DEFAULTS.strategy, 'majority')
    assert.equal(VERIFICATION_DEFAULTS.minPeers, 2)
    assert.equal(VERIFICATION_DEFAULTS.maxPeers, 10)
    assert.equal(VERIFICATION_DEFAULTS.timeoutMs, 30000)
    assert.equal(VERIFICATION_DEFAULTS.thresholdPct, 0.67)
  })
})

// ── computeResultHash ────────────────────────────────────────────────

describe('computeResultHash', () => {
  it('produces consistent hashes for identical inputs', () => {
    const a = computeResultHash({ answer: 42 })
    const b = computeResultHash({ answer: 42 })
    assert.equal(a, b)
  })

  it('produces different hashes for different inputs', () => {
    const a = computeResultHash({ answer: 42 })
    const b = computeResultHash({ answer: 99 })
    assert.notEqual(a, b)
  })

  it('handles string input', () => {
    const h = computeResultHash('hello')
    assert.equal(typeof h, 'string')
    assert.ok(h.length > 0)
  })
})

// ── Attestation ──────────────────────────────────────────────────────

describe('Attestation', () => {
  // Test 9: Attestation toJSON/fromJSON round-trip
  it('toJSON/fromJSON round-trip', () => {
    const att = new Attestation({
      podId: 'pod-a',
      jobId: 'job-1',
      resultHash: 'abc123',
      signature: 'sig-xyz',
      timestamp: 1000,
    })

    const json = att.toJSON()
    assert.equal(json.podId, 'pod-a')
    assert.equal(json.jobId, 'job-1')
    assert.equal(json.resultHash, 'abc123')
    assert.equal(json.signature, 'sig-xyz')
    assert.equal(json.timestamp, 1000)

    const restored = Attestation.fromJSON(json)
    assert.equal(restored.podId, 'pod-a')
    assert.equal(restored.jobId, 'job-1')
    assert.equal(restored.resultHash, 'abc123')
    assert.equal(restored.signature, 'sig-xyz')
    assert.equal(restored.timestamp, 1000)
  })

  // Test 10: Attestation.verify calls verifyFn correctly
  it('verify calls verifyFn correctly', () => {
    const att = new Attestation({
      podId: 'pod-a',
      jobId: 'job-1',
      resultHash: 'abc123',
      signature: 'sig-xyz',
      timestamp: 1000,
    })

    const calls = []
    const verifyFn = (podId, resultHash, signature) => {
      calls.push({ podId, resultHash, signature })
      return true
    }

    const result = att.verify(verifyFn)
    assert.equal(result, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].podId, 'pod-a')
    assert.equal(calls[0].resultHash, 'abc123')
    assert.equal(calls[0].signature, 'sig-xyz')
  })

  it('verify returns false when verifyFn returns false', () => {
    const att = new Attestation({
      podId: 'pod-a',
      jobId: 'job-1',
      resultHash: 'abc123',
      signature: 'sig-xyz',
      timestamp: 1000,
    })

    assert.equal(att.verify(() => false), false)
  })
})

// ── VerificationQuorum ───────────────────────────────────────────────

describe('VerificationQuorum', () => {
  let peers
  let trust
  let scheduler

  beforeEach(() => {
    peers = ['pod-a', 'pod-b', 'pod-c']
    trust = mockTrust(peers, {
      'pod-a': 0.9,
      'pod-b': 0.8,
      'pod-c': 0.7,
    })
    // All peers return same result
    scheduler = mockScheduler({ '*': { answer: 42 } })
  })

  it('throws if scheduler or trust is missing', () => {
    assert.throws(() => new VerificationQuorum({}), /scheduler.*required/i)
    assert.throws(
      () => new VerificationQuorum({ scheduler: mockScheduler({}) }),
      /trust.*required/i,
    )
  })

  // Test 1: Submit job to 3 peers, all match -> confidence 1.0
  it('all peers match -> confidence 1.0', async () => {
    const quorum = new VerificationQuorum({ scheduler, trust })
    quorum.setPolicy({ minPeers: 3, maxPeers: 3 })

    const result = await quorum.submitVerified({ task: 'compute' })

    assert.deepEqual(result.result, { answer: 42 })
    assert.equal(result.confidence, 1.0)
    assert.equal(result.attestations.length, 3)
    assert.equal(result.divergent, undefined)
  })

  // Test 2: 2/3 match -> majority wins, confidence ~0.67
  it('2/3 match -> majority wins', async () => {
    const sched = mockScheduler({
      'pod-a': { answer: 42 },
      'pod-b': { answer: 42 },
      'pod-c': { answer: 99 },
    })
    const quorum = new VerificationQuorum({ scheduler: sched, trust })
    quorum.setPolicy({ minPeers: 3, maxPeers: 3 })

    const result = await quorum.submitVerified({ task: 'compute' })

    assert.deepEqual(result.result, { answer: 42 })
    assert.ok(Math.abs(result.confidence - 2 / 3) < 0.01)
    assert.equal(result.attestations.length, 2)
  })

  // Test 3: All diverge -> throws with divergent results
  it('all diverge -> throws with divergent info', async () => {
    const sched = mockScheduler({
      'pod-a': { answer: 1 },
      'pod-b': { answer: 2 },
      'pod-c': { answer: 3 },
    })
    const quorum = new VerificationQuorum({ scheduler: sched, trust })
    quorum.setPolicy({ minPeers: 3, maxPeers: 3 })

    await assert.rejects(
      () => quorum.submitVerified({ task: 'compute' }),
      (err) => {
        assert.ok(err.message.includes('diverge') || err.message.includes('No winner'))
        assert.ok(err.divergent)
        return true
      },
    )
  })

  // Test 4: Timeout on slow peer -> proceeds with available results
  it('timeout on slow peer -> proceeds with available results', async () => {
    const sched = slowScheduler('pod-c', 5000, { '*': { answer: 42 } })
    const quorum = new VerificationQuorum({ scheduler: sched, trust })
    quorum.setPolicy({ minPeers: 2, maxPeers: 3, timeoutMs: 100 })

    const result = await quorum.submitVerified({ task: 'compute' })

    assert.deepEqual(result.result, { answer: 42 })
    assert.ok(result.confidence >= 0.5)
    // At least 2 peers responded (pod-a and pod-b)
    assert.ok(result.attestations.length >= 2)
  })

  // Test 5: Trust-weighted peer selection prefers higher trust
  it('trust-weighted peer selection prefers higher trust', async () => {
    const allPeers = ['pod-low', 'pod-mid', 'pod-high', 'pod-top']
    const allTrust = mockTrust(allPeers, {
      'pod-low': 0.1,
      'pod-mid': 0.4,
      'pod-high': 0.7,
      'pod-top': 0.95,
    })

    const dispatched = []
    const sched = {
      async dispatch(peerId, job) {
        dispatched.push(peerId)
        return { answer: 42 }
      },
    }

    const quorum = new VerificationQuorum({ scheduler: sched, trust: allTrust })
    quorum.setPolicy({ minPeers: 2, maxPeers: 2 })

    await quorum.submitVerified({ task: 'compute' })

    // The top 2 by reputation should be selected: pod-top and pod-high
    assert.ok(dispatched.includes('pod-top'))
    assert.ok(dispatched.includes('pod-high'))
    assert.ok(!dispatched.includes('pod-low'))
  })

  // Test 6: Byzantine strategy tolerates 1 faulty out of 4
  it('byzantine strategy tolerates 1 faulty out of 4', async () => {
    const fourPeers = ['pod-a', 'pod-b', 'pod-c', 'pod-d']
    const fourTrust = mockTrust(fourPeers)
    const sched = mockScheduler({
      'pod-a': { answer: 42 },
      'pod-b': { answer: 42 },
      'pod-c': { answer: 42 },
      'pod-d': { answer: 99 }, // faulty
    })
    const quorum = new VerificationQuorum({ scheduler: sched, trust: fourTrust })
    quorum.setPolicy({ minPeers: 4, maxPeers: 4, strategy: 'byzantine' })

    const result = await quorum.submitVerified({ task: 'compute' })

    assert.deepEqual(result.result, { answer: 42 })
    assert.equal(result.confidence, 3 / 4)
    assert.equal(result.attestations.length, 3)
  })

  // Test 7: Unanimous requires all match
  it('unanimous requires all match', async () => {
    // All match — should succeed
    const quorum1 = new VerificationQuorum({ scheduler, trust })
    quorum1.setPolicy({ minPeers: 3, maxPeers: 3, strategy: 'unanimous' })

    const result1 = await quorum1.submitVerified({ task: 'compute' })
    assert.deepEqual(result1.result, { answer: 42 })
    assert.equal(result1.confidence, 1.0)

    // One diverges — should fail
    const sched2 = mockScheduler({
      'pod-a': { answer: 42 },
      'pod-b': { answer: 42 },
      'pod-c': { answer: 99 },
    })
    const quorum2 = new VerificationQuorum({ scheduler: sched2, trust })
    quorum2.setPolicy({ minPeers: 3, maxPeers: 3, strategy: 'unanimous' })

    await assert.rejects(
      () => quorum2.submitVerified({ task: 'compute' }),
      (err) => {
        assert.ok(err.divergent)
        return true
      },
    )
  })

  // Test 8: Threshold strategy with custom pct
  it('threshold strategy with custom pct', async () => {
    const sched = mockScheduler({
      'pod-a': { answer: 42 },
      'pod-b': { answer: 42 },
      'pod-c': { answer: 99 },
    })
    const quorum = new VerificationQuorum({ scheduler: sched, trust })

    // 2/3 = 0.667, so thresholdPct 0.60 should pass
    quorum.setPolicy({ minPeers: 3, maxPeers: 3, strategy: 'threshold', thresholdPct: 0.60 })
    const result = await quorum.submitVerified({ task: 'compute' })
    assert.deepEqual(result.result, { answer: 42 })
    assert.ok(result.confidence >= 0.60)

    // thresholdPct 0.80 should fail (2/3 = 0.667 < 0.80)
    const quorum2 = new VerificationQuorum({ scheduler: sched, trust })
    quorum2.setPolicy({ minPeers: 3, maxPeers: 3, strategy: 'threshold', thresholdPct: 0.80 })
    await assert.rejects(
      () => quorum2.submitVerified({ task: 'compute' }),
      (err) => {
        assert.ok(err.divergent)
        return true
      },
    )
  })

  // Test 11: Policy override via setPolicy
  it('policy override via setPolicy', async () => {
    const quorum = new VerificationQuorum({ scheduler, trust })
    quorum.setPolicy({ minPeers: 2, maxPeers: 2, strategy: 'unanimous', timeoutMs: 5000, thresholdPct: 0.75 })

    const result = await quorum.submitVerified({ task: 'compute' })
    // Only 2 verifiers used
    assert.equal(result.attestations.length, 2)
    assert.equal(result.confidence, 1.0)
  })

  // Test 12: Empty verifier pool throws
  it('empty verifier pool throws', async () => {
    const emptyTrust = mockTrust([])
    const quorum = new VerificationQuorum({ scheduler, trust: emptyTrust })

    await assert.rejects(
      () => quorum.submitVerified({ task: 'compute' }),
      /no.*verifiers|not enough/i,
    )
  })

  // Test 13: Single peer (degenerates to direct execution)
  it('single peer degenerates to direct execution', async () => {
    const singleTrust = mockTrust(['pod-solo'])
    const sched = mockScheduler({ 'pod-solo': { answer: 42 } })
    const quorum = new VerificationQuorum({ scheduler: sched, trust: singleTrust })
    quorum.setPolicy({ minPeers: 1 })

    const result = await quorum.submitVerified({ task: 'compute' })

    assert.deepEqual(result.result, { answer: 42 })
    assert.equal(result.confidence, 1.0)
    assert.equal(result.attestations.length, 1)
  })

  // Test 14: Events emitted: verified, divergent
  it('emits verified event on success', async () => {
    const quorum = new VerificationQuorum({ scheduler, trust })
    quorum.setPolicy({ minPeers: 3, maxPeers: 3 })

    const events = []
    quorum.on('verified', (data) => events.push(data))

    await quorum.submitVerified({ task: 'compute' })

    assert.equal(events.length, 1)
    assert.deepEqual(events[0].result, { answer: 42 })
    assert.equal(events[0].confidence, 1.0)
  })

  it('emits divergent event on failure', async () => {
    const sched = mockScheduler({
      'pod-a': { answer: 1 },
      'pod-b': { answer: 2 },
      'pod-c': { answer: 3 },
    })
    const quorum = new VerificationQuorum({ scheduler: sched, trust })
    quorum.setPolicy({ minPeers: 3, maxPeers: 3 })

    const events = []
    quorum.on('divergent', (data) => events.push(data))

    try {
      await quorum.submitVerified({ task: 'compute' })
    } catch {
      // expected
    }

    assert.equal(events.length, 1)
    assert.ok(events[0].groups)
  })

  it('emits timeout event when a peer times out', async () => {
    const sched = slowScheduler('pod-c', 5000, { '*': { answer: 42 } })
    const quorum = new VerificationQuorum({ scheduler: sched, trust })
    quorum.setPolicy({ minPeers: 2, maxPeers: 3, timeoutMs: 100 })

    const events = []
    quorum.on('timeout', (data) => events.push(data))

    await quorum.submitVerified({ task: 'compute' })

    assert.ok(events.length >= 1)
    assert.equal(events[0].peerId, 'pod-c')
  })

  it('off removes a listener', async () => {
    const quorum = new VerificationQuorum({ scheduler, trust })
    quorum.setPolicy({ minPeers: 3, maxPeers: 3 })

    const events = []
    const handler = (data) => events.push(data)
    quorum.on('verified', handler)
    await quorum.submitVerified({ task: 'compute' })
    assert.equal(events.length, 1)

    quorum.off('verified', handler)
    await quorum.submitVerified({ task: 'compute' })
    assert.equal(events.length, 1) // unchanged
  })

  it('accepts explicit verifiers list', async () => {
    const dispatched = []
    const sched = {
      async dispatch(peerId, job) {
        dispatched.push(peerId)
        return { answer: 42 }
      },
    }
    const quorum = new VerificationQuorum({ scheduler: sched, trust })

    await quorum.submitVerified({ task: 'compute' }, { verifiers: ['pod-b', 'pod-c'] })

    assert.deepEqual(dispatched.sort(), ['pod-b', 'pod-c'])
  })
})
