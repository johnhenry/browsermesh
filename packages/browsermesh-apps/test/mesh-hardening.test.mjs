/**
 * Integration test for `createMeshNode({ enableHardening })` (issue #89).
 *
 * This proves the *wiring* -- that a `connectToPeer()` negotiation attempt
 * going through `createMeshNode()`'s constructed `MeshTransportNegotiator`
 * is actually retried (via `@johnhenry/browsermesh-core`'s `RetryWithBackoff`,
 * through `mesh-hardening.mjs`'s `createHardenedNegotiator()`) when
 * `enableHardening: true`. It deliberately does not exercise real WebRTC:
 * a fake `'wsh-ws'` adapter that fails N times then succeeds is registered
 * directly on `node.transportNegotiator` (mirroring how
 * `hardening.test.mjs`'s own `TransportFailover` "works with
 * RetryWithBackoff" test simulates a transient failure -- see
 * packages/browsermesh-core/test/hardening.test.mjs), and `endpoints` in
 * the `connectToPeer()` call below omits `webrtc` entirely, so
 * `MeshTransportNegotiator.negotiate()` never touches the real `'webrtc'`
 * adapter `createMeshNode()` also registers -- no RTCPeerConnection mock
 * needed.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-hardening.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

import { ManualStrategy } from '@johnhenry/browsermesh-discovery'
import { MockMeshTransport } from '@johnhenry/browsermesh-transport'
const { createMeshNode } = await import('../src/mesh-bootstrap.mjs')

// ---------------------------------------------------------------------------
// Stub signaling transport -- MeshSignalingChannel only requires
// send(msg)/onMessage(cb); see signaling.mjs. Same helper mesh-bootstrap.test.mjs uses.
// ---------------------------------------------------------------------------

function createStubSignalingTransport() {
  return { send() {}, onMessage() {} }
}

/** Fast retry options: no real delays, deterministic. */
const FAST_RETRY = { maxRetries: 5, baseDelayMs: 1, jitterFactor: 0, sleepFn: () => Promise.resolve() }

describe('createMeshNode: enableHardening (issue #89)', () => {
  it('retries a transiently-failing transport adapter and connects once it succeeds', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      discoveryStrategies: [new ManualStrategy()],
      skipDiscovery: true,
      enableHardening: true,
      hardeningOptions: { retry: FAST_RETRY },
    })

    let attempts = 0
    node.transportNegotiator.registerAdapter('wsh-ws', async (endpoint) => {
      attempts++
      if (attempts < 3) throw new Error('transient failure')
      const t = new MockMeshTransport('wsh-ws')
      await t.connect(endpoint)
      return t
    })

    const session = await node.connectToPeer('remote-pubkey', { 'wsh-ws': 'ws://fake-peer' })

    assert.equal(attempts, 3, 'the failing adapter was retried until it succeeded')
    assert.equal(session.transport, 'wsh-ws', 'the retried negotiation ultimately produced a real session')
    assert.ok(node.hasActiveSession('remote-pubkey'))
  })

  it('opens the circuit breaker (and stops retrying) once an adapter fails persistently', async () => {
    const node = await createMeshNode({
      label: 'alice-persistent-failure',
      signalingTransport: createStubSignalingTransport(),
      discoveryStrategies: [new ManualStrategy()],
      skipDiscovery: true,
      enableHardening: true,
      hardeningOptions: { retry: { ...FAST_RETRY, maxRetries: 3 } },
    })

    let attempts = 0
    node.transportNegotiator.registerAdapter('wsh-ws', async () => {
      attempts++
      throw new Error('always fails')
    })

    // connectToPeer() itself never rejects -- PeerNode falls back to a
    // direct registry connection (transport: null) when negotiation fails
    // entirely. See peer-node.mjs's connectToPeer() catch/fall-through.
    const session = await node.connectToPeer('remote-pubkey-2', { 'wsh-ws': 'ws://fake-peer' })

    assert.equal(attempts, 3, 'exactly maxRetries attempts were made before the circuit opened')
    assert.equal(session.transport, null, 'negotiation exhausted retries, so PeerNode fell back to a direct connection')

    const key = 'wsh-ws=ws://fake-peer'
    assert.equal(node.hardening.retries.get(key)?.circuitState, 'open', 'the per-peer circuit breaker opened')
    assert.ok(node.transportMetrics.get(key)?.errors >= 1, 'the negotiation failure was recorded in per-peer metrics')
  })

  it('records send/receive/latency metrics for a hardened connection', async () => {
    const node = await createMeshNode({
      label: 'alice-metrics',
      signalingTransport: createStubSignalingTransport(),
      discoveryStrategies: [new ManualStrategy()],
      skipDiscovery: true,
      enableHardening: true,
      hardeningOptions: { retry: FAST_RETRY },
    })

    node.transportNegotiator.registerAdapter('wsh-ws', async (endpoint) => {
      const t = new MockMeshTransport('wsh-ws')
      await t.connect(endpoint)
      return t
    })

    await node.connectToPeer('remote-pubkey-3', { 'wsh-ws': 'ws://fake-peer-3' })
    await node.sendTo('remote-pubkey-3', 'hello')

    const key = 'wsh-ws=ws://fake-peer-3'
    const metrics = node.transportMetrics.get(key)
    assert.ok(metrics, 'metrics are tracked per endpoints key')
    assert.equal(metrics.messagesSent, 1)
    assert.equal(metrics.getLatencyStats().count, 1, 'negotiation latency was recorded')
  })

  it('omitting enableHardening leaves existing behaviour completely unchanged (no retry, no hardening state)', async () => {
    const node = await createMeshNode({
      label: 'bob',
      signalingTransport: createStubSignalingTransport(),
      discoveryStrategies: [new ManualStrategy()],
      skipDiscovery: true,
      // enableHardening intentionally omitted
    })

    assert.equal(node.hardening, undefined, 'node.hardening is not attached when enableHardening is omitted')
    assert.equal(node.transportMetrics, undefined, 'node.transportMetrics is not attached when enableHardening is omitted')

    let attempts = 0
    node.transportNegotiator.registerAdapter('wsh-ws', async (endpoint) => {
      attempts++
      if (attempts < 3) throw new Error('transient failure')
      const t = new MockMeshTransport('wsh-ws')
      await t.connect(endpoint)
      return t
    })

    const session = await node.connectToPeer('remote-pubkey-4', { 'wsh-ws': 'ws://fake-peer-4' })

    assert.equal(attempts, 1, 'without enableHardening, a failing negotiation is not retried at all')
    assert.equal(session.transport, null, 'PeerNode falls back to a direct connection exactly as before')
  })
})
