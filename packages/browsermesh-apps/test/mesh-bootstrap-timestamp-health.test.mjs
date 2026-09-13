/**
 * Unit-level test for `createMeshNode()`'s `enableTimestamp`/
 * `timestampOptions` and `enableHealthMonitor`/`healthMonitorOptions`
 * plumbing (Phase 1 of the browsermesh-app-layer-migration plan, issue
 * #120). Mirrors `mesh-bootstrap-audit.test.mjs`'s own structure/reasoning:
 * no real WebRTC/`node-datachannel` is needed here since both services only
 * need to ATTACH and be reachable, which requires nothing beyond a real,
 * booted `PeerNode`/`PeerRegistry` (the actual real-peer wire-protocol
 * round-trips are covered in `mesh-timestamp.test.mjs`/`mesh-health.test.mjs`).
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-bootstrap-timestamp-health.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

const { createMeshNode } = await import('../src/mesh-bootstrap.mjs')
const { ManualStrategy } = await import('@johnhenry/browsermesh-discovery')

/** Stub signaling transport -- MeshSignalingChannel only requires
 * send(msg)/onMessage(cb); see signaling.mjs. Never actually used here
 * since no real WebRTC offer/answer is exchanged. */
function createStubSignalingTransport() {
  return { send() {}, onMessage() {} }
}

describe('createMeshNode: enableTimestamp/enableHealthMonitor wiring (issue #120)', () => {
  it('enableTimestamp: true attaches a real timestamp service, reachable both as node.timestamp and via node.services', async () => {
    const node = await createMeshNode({
      label: 'alice',
      discoveryStrategies: [new ManualStrategy()],
      signalingTransport: createStubSignalingTransport(),
      enableTimestamp: true,
    })

    assert.ok(node.timestamp, 'node.timestamp is attached')
    assert.equal(node.timestamp, node.services.get('timestamp'), 'node.timestamp === node.services.get("timestamp")')
    assert.equal(typeof node.timestamp.api.stamp, 'function')
    assert.equal(typeof node.timestamp.api.verify, 'function')
    assert.equal(typeof node.timestamp.api.getNetworkTime, 'function')

    // Actually usable: a real, self-signed, self-verifiable proof.
    const proof = await node.timestamp.api.stamp('abc123')
    assert.equal(proof.issuedBy, node.podId)
    const result = await node.timestamp.api.verify(proof)
    assert.equal(result.valid, true)

    await node.timestamp.teardown()
  })

  it('enableHealthMonitor: true attaches a real health-monitor service, reachable both as node.healthMonitor and via node.services', async () => {
    const node = await createMeshNode({
      label: 'bob',
      discoveryStrategies: [new ManualStrategy()],
      signalingTransport: createStubSignalingTransport(),
      enableHealthMonitor: true,
    })

    assert.ok(node.healthMonitor, 'node.healthMonitor is attached')
    assert.equal(node.healthMonitor, node.services.get('health-monitor'), 'node.healthMonitor === node.services.get("health-monitor")')
    assert.equal(typeof node.healthMonitor.api.getStatus, 'function')
    assert.equal(node.healthMonitor.api.autoMigrator, null, 'no AutoMigrator without healthMonitorOptions.orchestrator')

    await node.healthMonitor.teardown()
  })

  it('both enableTimestamp and enableHealthMonitor together attach independently and do not interfere', async () => {
    const node = await createMeshNode({
      label: 'carol',
      discoveryStrategies: [new ManualStrategy()],
      signalingTransport: createStubSignalingTransport(),
      enableTimestamp: true,
      enableHealthMonitor: true,
    })

    assert.ok(node.timestamp)
    assert.ok(node.healthMonitor)
    assert.equal(node.services.size, 2)
    assert.deepEqual([...node.services.keys()].sort(), ['health-monitor', 'timestamp'])

    await node.timestamp.teardown()
    await node.healthMonitor.teardown()
  })

  it('neither is attached when both options are omitted (default off)', async () => {
    const node = await createMeshNode({
      label: 'dave',
      discoveryStrategies: [new ManualStrategy()],
      signalingTransport: createStubSignalingTransport(),
    })

    assert.equal(node.timestamp, undefined)
    assert.equal(node.healthMonitor, undefined)
    assert.equal(node.services.size, 0)
  })
})
