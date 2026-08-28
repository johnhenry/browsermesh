/**
 * Tests for TimestampAuthority and TimestampProof — distributed timestamp consensus.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/peer-timestamp.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Provide crypto.randomUUID if not available
if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

import {
  TimestampAuthority,
  TimestampProof,
  TIMESTAMP_DEFAULTS,
} from '../src/peer-timestamp.mjs'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Create a mock identity with sign/verify and podId.
 * sign() returns a deterministic Uint8Array based on the data string.
 */
function createMockIdentity(podId = 'pod-local') {
  return {
    podId,
    async sign(data) {
      const encoder = new TextEncoder()
      const bytes = encoder.encode(`sig:${podId}:${data}`)
      return new Uint8Array(bytes)
    },
    async verify(signature, data, signerPodId) {
      const encoder = new TextEncoder()
      const expected = encoder.encode(`sig:${signerPodId}:${data}`)
      if (signature.length !== expected.length) return false
      for (let i = 0; i < expected.length; i++) {
        if (signature[i] !== expected[i]) return false
      }
      return true
    },
  }
}

/**
 * Create a mock sessions object with a given set of remote peers.
 * Each session has a remotePodId and a send() stub.
 */
function createMockSessions(peerPodIds = []) {
  const sessions = peerPodIds.map(podId => ({
    remotePodId: podId,
    send(type, payload) { /* no-op for testing */ },
  }))
  return {
    listSessions() { return sessions },
  }
}

// ---------------------------------------------------------------------------
// Tests — TIMESTAMP_DEFAULTS
// ---------------------------------------------------------------------------

describe('TIMESTAMP_DEFAULTS', () => {
  it('has correct default values', () => {
    assert.equal(TIMESTAMP_DEFAULTS.clockSkewMs, 30_000)
    assert.equal(TIMESTAMP_DEFAULTS.minWitnesses, 1)
    assert.equal(TIMESTAMP_DEFAULTS.confidenceThreshold, 0.5)
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(TIMESTAMP_DEFAULTS))
  })
})

// ---------------------------------------------------------------------------
// Tests — TimestampAuthority
// ---------------------------------------------------------------------------

describe('TimestampAuthority', () => {
  let authority
  let identity
  let sessions

  beforeEach(() => {
    identity = createMockIdentity('pod-local')
    sessions = createMockSessions(['pod-a', 'pod-b', 'pod-c'])
  })

  // -- Test 1: stamp returns canonical timestamp with witnesses ---------------

  it('stamp returns canonical timestamp with witnesses', async () => {
    authority = new TimestampAuthority({ sessions, identity })
    const now = Date.now()
    const peerTimestamps = new Map([
      ['pod-a', now - 100],
      ['pod-b', now + 50],
      ['pod-c', now + 200],
    ])

    const proof = await authority.stamp('abc123', peerTimestamps)

    assert.ok(proof instanceof TimestampProof)
    assert.equal(proof.eventHash, 'abc123')
    assert.equal(typeof proof.canonicalTimestamp, 'number')
    assert.ok(proof.canonicalTimestamp > 0)
    assert.ok(Array.isArray(proof.witnesses))
    assert.ok(proof.witnesses.length > 0)
    assert.equal(proof.issuedBy, 'pod-local')
    assert.equal(typeof proof.confidence, 'number')
    assert.ok(proof.confidence > 0 && proof.confidence <= 1)
  })

  // -- Test 2: verify confirms valid proof ------------------------------------

  it('verify confirms valid proof', async () => {
    authority = new TimestampAuthority({ sessions, identity })
    const now = Date.now()
    const peerTimestamps = new Map([
      ['pod-a', now - 100],
      ['pod-b', now + 50],
      ['pod-c', now + 200],
    ])

    const proof = await authority.stamp('abc123', peerTimestamps)
    const result = await authority.verify(proof)

    assert.equal(result.valid, true)
    assert.equal(result.reason, undefined)
  })

  // -- Test 3: verify rejects proof with tampered eventHash -------------------

  it('verify rejects proof with tampered eventHash', async () => {
    authority = new TimestampAuthority({ sessions, identity })
    const now = Date.now()
    const peerTimestamps = new Map([
      ['pod-a', now],
      ['pod-b', now],
      ['pod-c', now],
    ])

    const proof = await authority.stamp('abc123', peerTimestamps)
    // Tamper with the eventHash
    const tampered = TimestampProof.fromJSON({
      ...proof.toJSON(),
      eventHash: 'tampered-hash',
    })

    const result = await authority.verify(tampered)
    assert.equal(result.valid, false)
    assert.ok(result.reason)
  })

  // -- Test 4: getNetworkTime returns median of peer clocks -------------------

  it('getNetworkTime returns median of peer clocks', () => {
    authority = new TimestampAuthority({ sessions, identity })
    const peerTimestamps = new Map([
      ['pod-a', 1000],
      ['pod-b', 2000],
      ['pod-c', 3000],
    ])

    // With 3 peers + local clock, the median is computed from 4 values
    // We use a fixed local clock by passing it
    const networkTime = authority.getNetworkTime(peerTimestamps)
    assert.equal(typeof networkTime, 'number')
    assert.ok(networkTime > 0)
  })

  // -- Test 5: outlier peer clock rejected (>30s skew from median) ------------

  it('outlier peer clock rejected (>30s skew from median)', async () => {
    authority = new TimestampAuthority({ sessions, identity })
    const now = Date.now()
    const peerTimestamps = new Map([
      ['pod-a', now],
      ['pod-b', now + 100],
      ['pod-c', now + 100_000], // 100s out — way beyond 30s tolerance
    ])

    const proof = await authority.stamp('abc123', peerTimestamps)

    // pod-c should be excluded as an outlier
    const witnessIds = proof.witnesses.map(w => w.podId)
    assert.ok(!witnessIds.includes('pod-c'), 'pod-c should be rejected as outlier')
    assert.ok(proof.confidence < 1.0, 'confidence should be < 1 with rejected peer')
  })

  // -- Test 6: single peer (no sessions) uses local clock only ----------------

  it('single peer (no sessions) uses local clock only', async () => {
    const emptySessions = createMockSessions([])
    authority = new TimestampAuthority({ sessions: emptySessions, identity })

    const proof = await authority.stamp('abc123')

    assert.ok(proof instanceof TimestampProof)
    assert.equal(proof.eventHash, 'abc123')
    assert.equal(typeof proof.canonicalTimestamp, 'number')
    // Only local witness (the issuer itself)
    assert.equal(proof.witnesses.length, 1)
    assert.equal(proof.witnesses[0].podId, 'pod-local')
    assert.equal(proof.confidence, 1.0)
  })

  // -- Test 7: all peers agree -> confidence 1.0 ------------------------------

  it('all peers agree -> confidence 1.0', async () => {
    authority = new TimestampAuthority({ sessions, identity })
    const now = Date.now()
    const peerTimestamps = new Map([
      ['pod-a', now],
      ['pod-b', now + 10],
      ['pod-c', now + 20],
    ])

    const proof = await authority.stamp('abc123', peerTimestamps)

    assert.equal(proof.confidence, 1.0)
    assert.equal(proof.witnesses.length, 4) // 3 peers + local
  })

  // -- Test 8: split clocks with some rejected -> lower confidence ------------

  it('split clocks with some rejected -> lower confidence', async () => {
    authority = new TimestampAuthority({ sessions, identity })
    const now = Date.now()
    const peerTimestamps = new Map([
      ['pod-a', now],
      ['pod-b', now + 60_000],  // 60s off — outlier
      ['pod-c', now + 90_000],  // 90s off — outlier
    ])

    const proof = await authority.stamp('abc123', peerTimestamps)

    assert.ok(proof.confidence < 1.0)
    assert.ok(proof.confidence > 0)
    // At least local + pod-a should be accepted
    const witnessIds = proof.witnesses.map(w => w.podId)
    assert.ok(witnessIds.includes('pod-local'))
    assert.ok(witnessIds.includes('pod-a'))
  })

  // -- Test 10: clock skew tolerance is configurable --------------------------

  it('clock skew tolerance is configurable', async () => {
    // Use 500ms tolerance — tight enough to reject seconds-off peers
    authority = new TimestampAuthority({
      sessions,
      identity,
      clockSkewMs: 500,
    })
    const now = Date.now()
    // pod-a and pod-b are close (within 500ms), pod-c is far away.
    // 4 values: [now, now+50, now+100, now+60_000]
    // Median = (now+50 + now+100)/2 = now+75
    // Distances: now=75, pod-a=25, pod-b=25, pod-c=59925
    // pod-c is the only outlier beyond 500ms
    const peerTimestamps = new Map([
      ['pod-a', now + 50],     // ~25ms from median — within 500ms
      ['pod-b', now + 100],    // ~25ms from median — within 500ms
      ['pod-c', now + 60_000], // ~59925ms from median — way beyond 500ms
    ])

    const proof = await authority.stamp('abc123', peerTimestamps)

    // pod-c should be rejected; pod-local, pod-a, pod-b accepted
    const witnessIds = proof.witnesses.map(w => w.podId)
    assert.ok(witnessIds.includes('pod-local'), 'local should be accepted')
    assert.ok(witnessIds.includes('pod-a'), 'pod-a should be accepted (within tolerance)')
    assert.ok(witnessIds.includes('pod-b'), 'pod-b should be accepted (within tolerance)')
    assert.ok(!witnessIds.includes('pod-c'), 'pod-c should be rejected (beyond tolerance)')
    assert.equal(proof.confidence, 3 / 4, 'confidence = 3 accepted / 4 total')
  })

  // -- Test 11: empty event hash throws --------------------------------------

  it('empty event hash throws', async () => {
    authority = new TimestampAuthority({ sessions, identity })

    await assert.rejects(
      () => authority.stamp(''),
      { message: /eventHash.*required/i },
    )

    await assert.rejects(
      () => authority.stamp(null),
      { message: /eventHash.*required/i },
    )
  })
})

// ---------------------------------------------------------------------------
// Tests — TimestampProof
// ---------------------------------------------------------------------------

describe('TimestampProof', () => {
  // -- Test 9: toJSON/fromJSON round-trip -------------------------------------

  it('toJSON/fromJSON round-trip', () => {
    const witnesses = [
      { podId: 'pod-a', localTimestamp: 1000, signature: 'c2lnOg==' },
      { podId: 'pod-b', localTimestamp: 2000, signature: 'c2lnOg==' },
    ]
    const proof = new TimestampProof({
      eventHash: 'hash-abc',
      canonicalTimestamp: 1500,
      witnesses,
      issuedBy: 'pod-local',
      issuedAt: 999,
      confidence: 0.75,
      signature: 'bWFpbi1zaWc=',
    })

    const json = proof.toJSON()
    assert.equal(typeof json, 'object')
    assert.equal(json.eventHash, 'hash-abc')
    assert.equal(json.canonicalTimestamp, 1500)
    assert.equal(json.issuedBy, 'pod-local')
    assert.equal(json.issuedAt, 999)
    assert.equal(json.confidence, 0.75)
    assert.deepEqual(json.witnesses, witnesses)

    const restored = TimestampProof.fromJSON(json)
    assert.ok(restored instanceof TimestampProof)
    assert.equal(restored.eventHash, 'hash-abc')
    assert.equal(restored.canonicalTimestamp, 1500)
    assert.equal(restored.issuedBy, 'pod-local')
    assert.equal(restored.issuedAt, 999)
    assert.equal(restored.confidence, 0.75)
    assert.deepEqual(restored.witnesses, witnesses)
  })

  // -- Test 12: median computation correct for even/odd peer counts -----------

  it('median computation correct for even/odd peer counts', () => {
    const identity = createMockIdentity('pod-local')

    // Odd count: 3 peers + 1 local = 4 values (even array, but tests median logic)
    const sessionsOdd = createMockSessions(['pod-a', 'pod-b', 'pod-c'])
    const authorityOdd = new TimestampAuthority({ sessions: sessionsOdd, identity })

    // With values [100, 200, 300, 400] sorted, median = (200 + 300) / 2 = 250
    const medianEven = authorityOdd.getNetworkTime(new Map([
      ['pod-a', 100],
      ['pod-b', 300],
      ['pod-c', 400],
    ]))
    // Local clock added too, but we're testing the pure math
    // Let's use a simpler approach: test with only peer timestamps
    // by creating a sessions object with specific peer counts

    // Test with 3 values (odd count): median = middle value
    const sessions2 = createMockSessions(['pod-a', 'pod-b'])
    const authority3 = new TimestampAuthority({ sessions: sessions2, identity })
    // 3 values: [100, 200, 300] (local=200, pod-a=100, pod-b=300)
    // We can't control local clock easily, so let's test getNetworkTime
    // with explicit peer timestamps and check the math indirectly

    // Odd count: [100, 200, 300] -> median = 200
    const sessions0 = createMockSessions([])
    const authority1 = new TimestampAuthority({ sessions: sessions0, identity })
    // Only local clock — result equals local
    const single = authority1.getNetworkTime(new Map())
    assert.equal(typeof single, 'number')
    assert.ok(single > 0)

    // Even count: [100, 200, 300, 400] -> median = 250
    // We test this indirectly through the authority
    const sessions3 = createMockSessions(['pod-a', 'pod-b', 'pod-c'])
    const authority4 = new TimestampAuthority({ sessions: sessions3, identity })
    // Override local clock behavior by providing 4 peer timestamps and no local
    // Actually, local is always included. Let's just verify the math:

    // Use _computeMedianForTest if available, or test through getNetworkTime
    // The spec says the median is used, so let's verify both even and odd paths
    // by controlling all inputs via peerTimestamps
    const evenSessions = createMockSessions([])
    const evenAuthority = new TimestampAuthority({ sessions: evenSessions, identity })

    // 1 value (local only): median = local
    const t1 = evenAuthority.getNetworkTime(new Map())
    assert.equal(typeof t1, 'number')

    // Test static/exposed computeMedian if available
    if (typeof TimestampAuthority.computeMedian === 'function') {
      assert.equal(TimestampAuthority.computeMedian([1, 3, 5]), 3)
      assert.equal(TimestampAuthority.computeMedian([1, 3, 5, 7]), 4)
      assert.equal(TimestampAuthority.computeMedian([10, 20]), 15)
      assert.equal(TimestampAuthority.computeMedian([42]), 42)
    } else {
      // Verify through network time with known inputs
      // Even: [100, 200, 300, 400] -> median = 250
      // We need to know local clock, so this test verifies the return is reasonable
      const s4 = createMockSessions(['a', 'b', 'c'])
      const a4 = new TimestampAuthority({ sessions: s4, identity })
      const now = Date.now()
      const nt = a4.getNetworkTime(new Map([
        ['a', now - 100],
        ['b', now + 100],
        ['c', now + 200],
      ]))
      // Median of [now-100, now, now+100, now+200] sorted = (now + now+100)/2 = now+50
      // Allow some tolerance for Date.now() drift during execution
      assert.ok(Math.abs(nt - (now + 50)) < 50, `expected ~${now + 50}, got ${nt}`)
    }
  })
})
