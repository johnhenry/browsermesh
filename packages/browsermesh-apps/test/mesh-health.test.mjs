/**
 * Tests for mesh-health.mjs (Phase 1 of the browsermesh-app-layer-migration
 * plan, issue #120): the `MeshService` wrapper around `peer-health.mjs`'s
 * `HealthMonitor` (+ `AutoMigrator`, opt-in).
 *
 * Mirrors `mesh-keepalive.test.mjs`'s own reasoning for why REAL `PeerNode`
 * instances are needed: this service requires a real `PeerNode.listSessions()`
 * (genuinely called every tick, unlike `mesh-timestamp.mjs`'s constructor-only
 * guard) to discover connected sessions to heartbeat. Real `PeerNode`s are
 * linked via `adoptIncomingSession()` fed a minimal in-memory duplex
 * transport, `mesh-keepalive.test.mjs`'s own `linkRealNodes()` pattern.
 *
 * Real, small `intervalMs`/`thresholds` are used throughout (matching
 * `mesh-keepalive.test.mjs`'s own convention) with real, short `await`
 * delays rather than mocked timers.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-health.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { PeerNode } from '../src/peer-node.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createHealthMonitorService } from '../src/mesh-health.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A real Ed25519 identity + wallet + registry bundle for one "peer". */
async function createPeer(label) {
  const identityManager = new MeshIdentityManager({})
  const wallet = new IdentityWallet({ identityManager })
  const { podId } = await wallet.createIdentity(label)
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId }),
  })
  return { podId, wallet, registry }
}

/**
 * Build a minimal in-memory duplex transport pair and adopt each side onto a
 * real, already-booted `PeerNode` via `adoptIncomingSession()`. Mirrors
 * `mesh-keepalive.test.mjs`'s own `linkRealNodes()`.
 * @param {PeerNode} nodeA @param {PeerNode} nodeB
 */
async function linkRealNodes(nodeA, nodeB) {
  let aOnMessage = null, bOnMessage = null
  const transportForA = { send(data) { queueMicrotask(() => { if (bOnMessage) bOnMessage(data) }) }, onMessage(cb) { aOnMessage = cb } }
  const transportForB = { send(data) { queueMicrotask(() => { if (aOnMessage) aOnMessage(data) }) }, onMessage(cb) { bOnMessage = cb } }
  await nodeA.adoptIncomingSession(nodeB.podId, transportForA, 'inmemory')
  await nodeB.adoptIncomingSession(nodeA.podId, transportForB, 'inmemory')
}

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs = 2000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

/** Collects (event, data) pairs fired on an attachService() handle. */
function recordEvents(handle) {
  const events = []
  handle.onEvent((event, data) => events.push({ event, data }))
  return events
}

// ---------------------------------------------------------------------------
// Real ping/pong heartbeat -> healthy
// ---------------------------------------------------------------------------

describe('mesh-health: real heartbeat round-trip -> healthy', () => {
  it('tracks a real connected peer as healthy once real heartbeat pongs are flowing', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    await linkRealNodes(nodeA, nodeB)

    const handleA = attachService(nodeA, undefined, createHealthMonitorService({ intervalMs: 25 }))
    const handleB = attachService(nodeB, undefined, createHealthMonitorService({ intervalMs: 25 }))
    const events = recordEvents(handleA)

    await waitFor(() => handleA.api.getPeerHealth(bob.podId)?.status === 'healthy', 2000, 'nodeA to see bob as healthy')
    await waitFor(() => handleB.api.getPeerHealth(alice.podId)?.status === 'healthy', 2000, 'nodeB to see alice as healthy')

    const healthyEvents = events.filter((e) => e.event === 'health-monitor:peer-healthy')
    assert.ok(healthyEvents.length >= 1, 'health-monitor:peer-healthy fired')
    assert.equal(healthyEvents[0].data.podId, bob.podId)

    const status = handleA.api.getStatus()
    assert.ok(status instanceof Map)
    assert.equal(status.get(bob.podId).status, 'healthy')

    handleA.teardown()
    handleB.teardown()
  })
})

// ---------------------------------------------------------------------------
// Missed heartbeats -> degraded -> failed
// ---------------------------------------------------------------------------

describe('mesh-health: missed heartbeats -> degraded -> failed', () => {
  it('escalates through degraded to failed when the connected peer never answers', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    // No health-monitor service attached on nodeB -- it never answers
    // heartbeat:ping, so every ping nodeA sends goes unanswered.
    await linkRealNodes(nodeA, nodeB)

    const handleA = attachService(nodeA, undefined, createHealthMonitorService({
      intervalMs: 20,
      thresholds: { maxMissedHeartbeats: 2 },
    }))
    const events = recordEvents(handleA)

    await waitFor(() => handleA.api.getPeerHealth(bob.podId)?.status === 'degraded', 2000, 'first missed heartbeat -> degraded')
    await waitFor(() => handleA.api.getPeerHealth(bob.podId)?.status === 'failed', 2000, 'maxMissedHeartbeats misses -> failed')

    const degradedEvents = events.filter((e) => e.event === 'health-monitor:peer-degraded')
    const failedEvents = events.filter((e) => e.event === 'health-monitor:peer-failed')
    assert.ok(degradedEvents.length >= 1, 'health-monitor:peer-degraded fired')
    assert.equal(degradedEvents[0].data.podId, bob.podId)
    assert.ok(failedEvents.length >= 1, 'health-monitor:peer-failed fired')
    assert.equal(failedEvents[0].data.podId, bob.podId)

    handleA.teardown()
  })
})

// ---------------------------------------------------------------------------
// AutoMigrator: a real failure triggers a real migration to a real,
// still-healthy peer, via a caller-supplied duck-typed orchestrator.
// ---------------------------------------------------------------------------

describe('mesh-health: AutoMigrator wiring (opt-in via opts.orchestrator)', () => {
  it('automatically drains a failed peer and migrates to a still-healthy one once HealthMonitor reports it failed', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob') // never responds -- will be declared failed
    const carol = await createPeer('carol') // responds -- stays healthy, becomes the migration target

    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    const nodeC = new PeerNode({ wallet: carol.wallet, registry: carol.registry })
    await nodeA.boot()
    await nodeB.boot()
    await nodeC.boot()
    await linkRealNodes(nodeA, nodeB)
    await linkRealNodes(nodeA, nodeC)

    const drainedPods = []
    const orchestrator = {
      async drainPod(podId) {
        drainedPods.push(podId)
        return { success: true }
      },
    }

    const handleA = attachService(nodeA, undefined, createHealthMonitorService({
      intervalMs: 20,
      thresholds: { maxMissedHeartbeats: 2 },
      orchestrator,
    }))
    // Carol answers nodeA's heartbeat:ping so she's tracked as healthy and
    // becomes a valid #selectTarget() candidate.
    const handleC = attachService(nodeC, undefined, createHealthMonitorService({ intervalMs: 20 }))

    const events = recordEvents(handleA)

    assert.ok(handleA.api.autoMigrator, 'AutoMigrator was constructed since opts.orchestrator was supplied')

    await waitFor(() => handleA.api.getPeerHealth(carol.podId)?.status === 'healthy', 2000, 'carol tracked healthy (valid migration target)')
    await waitFor(() => handleA.api.getPeerHealth(bob.podId)?.status === 'failed', 2000, 'bob declared failed')
    await waitFor(() => drainedPods.includes(bob.podId), 2000, 'AutoMigrator automatically drained the failed peer')

    const migratingEvents = events.filter((e) => e.event === 'health-monitor:migrating')
    const migratedEvents = events.filter((e) => e.event === 'health-monitor:migrated')
    assert.ok(migratingEvents.length >= 1, 'health-monitor:migrating fired')
    assert.equal(migratingEvents[0].data.fromPod, bob.podId)
    assert.equal(migratingEvents[0].data.toPod, carol.podId)
    assert.ok(migratedEvents.length >= 1, 'health-monitor:migrated fired')
    assert.equal(migratedEvents[0].data.success, true)
    assert.equal(migratedEvents[0].data.fromPod, bob.podId)
    assert.equal(migratedEvents[0].data.toPod, carol.podId)
    // No resolveWorkload was supplied, so nothing was actually redeployed --
    // matches peer-health.mjs's own documented "drained but nothing
    // deployed" success shape.
    assert.equal(migratedEvents[0].data.workload, null)
    assert.deepEqual(migratedEvents[0].data.deployed, [])

    handleA.teardown()
    handleC.teardown()
  })

  it('migrateNow() throws a clear error when no orchestrator was supplied at attach time', async () => {
    const alice = await createPeer('alice')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    await nodeA.boot()
    const handleA = attachService(nodeA, undefined, createHealthMonitorService())

    assert.equal(handleA.api.autoMigrator, null)
    assert.throws(() => handleA.api.migrateNow('some-pod'), /requires opts.orchestrator/)

    handleA.teardown()
  })
})

// ---------------------------------------------------------------------------
// Guard: requires a real PeerNode
// ---------------------------------------------------------------------------

describe('mesh-health: real-PeerNode guard', () => {
  it('throws a clear error when attached to a duck-typed node with no listSessions()', () => {
    const fakeNode = { podId: 'fake', onIncomingData() { return () => {} }, sendTo: async () => {} }
    assert.throws(
      () => attachService(fakeNode, undefined, createHealthMonitorService()),
      /must be a real PeerNode providing listSessions\(\)/,
    )
  })
})
