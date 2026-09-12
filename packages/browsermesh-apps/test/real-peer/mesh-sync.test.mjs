// Two real PeerNodes, one Node process, no server: proves Phase 3's claim --
// MeshSyncEngine (browsermesh-sync) actually wired to PeerNode's dispatch
// bus, over a real WebRTC connection, with real IndexedDB-backed
// persistence that survives a simulated reload.
//
// Mirrors packages/browsermesh-apps/test/real-peer/mesh-bootstrap.test.mjs
// (Phase 2's proof): same optional `node-datachannel` devDependency guard
// (skip when absent, hard-fail when REQUIRE_REAL_PEER=1 so CI can't
// silently report a decorative skip as success), same "iceServers: []"
// hermetic loopback setup.
//
// What's real here: everything Phase 2's suite proves (real identities,
// real discovery, real WebRTCPeerConnection/DataChannel) PLUS: a real
// MeshSyncEngine on each side, a real IndexedDB implementation
// (`fake-indexeddb`, the same real-in-Node IndexedDB polyfill
// browsermesh-sync's own storage-indexeddb.test.mjs uses) backing
// IndexedDBSyncStorage, and CRDT deltas actually carried over the
// DataChannel via PeerNode.sendTo()/onIncomingData() -- not handed
// directly from one engine to the other in memory (contrast with
// examples/05-crdt-sync-across-two-engines.mjs, which is deliberately
// network-free).
//
// This suite is also the specific proof that the callee-side PeerNode
// session gap (flagged by the Phase 2 implementer as "properly Phase 3's
// concern") is actually resolved: Bob never calls connectToPeer() himself
// (he only auto-answers Alice's offer), yet his MeshSyncBinding sends a
// delta to Alice via `node.sendTo()` -- which requires a PeerNode-level
// session that, before this phase's PeerNode.adoptIncomingSession() /
// webrtc-negotiator.mjs onIncomingConnection wiring, simply did not exist
// on the callee side.
import 'fake-indexeddb/auto'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

/** @type {any} */ let ndc = null
/** @type {any} */ let ndcMain = null
try {
  ndc = await import('node-datachannel/polyfill')
  ndcMain = await import('node-datachannel')
} catch {
  // Optional dependency absent -- the suite below skips.
}

if (!ndc && process.env.REQUIRE_REAL_PEER) {
  throw new Error(
    'REQUIRE_REAL_PEER is set but `node-datachannel` did not load, so the ' +
    'real-peer suite would have skipped and reported success. Install the ' +
    'devDependency, or unset REQUIRE_REAL_PEER to allow the skip.'
  )
}

if (!ndc) {
  describe('mesh-sync against real WebRTC peers', () => {
    it('skipped: optional devDependency `node-datachannel` is not installed', () => {})
  })
}

const describeIfReal = ndc ? describe : describe.skip

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

/**
 * A shared in-process pub/sub bus standing in for a real signaling
 * transport (BroadcastChannel in a browser, a WebSocket relay, etc). Same
 * shape as Phase 2's mesh-bootstrap.test.mjs helper -- written locally
 * rather than imported/shared, matching that file's own rationale.
 */
function createSharedSignalingBus() {
  return new Set()
}

/** One endpoint on a createSharedSignalingBus() bus. Matches the
 * `{send(msg), onMessage(cb)}` shape MeshSignalingChannel requires. */
function createBusTransport(sharedBus) {
  let handler = null
  const receiver = (msg) => { if (handler) handler(msg) }
  sharedBus.add(receiver)
  return {
    send(msg) {
      for (const fn of sharedBus) {
        if (fn !== receiver) fn(msg)
      }
    },
    onMessage(cb) { handler = cb },
  }
}

describeIfReal('mesh-sync: MeshSyncEngine wired to two real PeerNodes over real WebRTC', () => {
  /** @type {any} */ let createMeshNode
  /** @type {any} */ let IndexedDBSyncStorage
  /** @type {any} */ let ManualStrategy
  /** @type {any} */ let DiscoveryRecord

  before(async () => {
    // webrtc.mjs reads RTCPeerConnection off the global at call time, so
    // the globals must be in place before any WebRTCPeerConnection is
    // constructed (not necessarily before it's imported).
    Object.assign(globalThis, {
      RTCPeerConnection: ndc.RTCPeerConnection,
      RTCIceCandidate: ndc.RTCIceCandidate,
      RTCSessionDescription: ndc.RTCSessionDescription,
    })
    ;({ createMeshNode } = await import('../../src/mesh-bootstrap.mjs'))
    ;({ IndexedDBSyncStorage } = await import('@johnhenry/browsermesh-sync'))
    ;({ ManualStrategy, DiscoveryRecord } = await import('@johnhenry/browsermesh-discovery'))
  })

  after(() => {
    // libdatachannel holds a worker pool that would keep the process alive.
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('converges a CRDT edit made on either side over the real connection, and the result survives a simulated reload', async () => {
    const signalingBus = createSharedSignalingBus()
    const discoveryA = new ManualStrategy()
    const discoveryB = new ManualStrategy()

    // Fresh, uniquely-named IndexedDB databases per run so this test is
    // hermetic against re-runs in the same process.
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const aliceDbName = `mesh-sync-test-alice-${runId}`
    const bobDbName = `mesh-sync-test-bob-${runId}`

    const nodeA = await createMeshNode({
      label: 'alice',
      discoveryStrategies: [discoveryA],
      signalingTransport: createBusTransport(signalingBus),
      iceServers: [], // host candidates only: hermetic, no STUN/TURN/network dependency
      enableSync: true,
      syncDbName: aliceDbName,
    })
    const nodeB = await createMeshNode({
      label: 'bob',
      discoveryStrategies: [discoveryB],
      signalingTransport: createBusTransport(signalingBus),
      iceServers: [],
      enableSync: true,
      syncDbName: bobDbName,
    })

    try {
      // -- enableSync wired a real MeshSyncEngine + IndexedDBSyncStorage --
      assert.ok(nodeA.sync, 'alice has a sync binding')
      assert.ok(nodeB.sync, 'bob has a sync binding')

      // -- Real discovery + real WebRTC connection (Phase 2's proof) --------
      discoveryA.addPeer(new DiscoveryRecord({ podId: nodeB.podId, transport: 'webrtc', label: 'bob' }))
      discoveryB.addPeer(new DiscoveryRecord({ podId: nodeA.podId, transport: 'webrtc', label: 'alice' }))
      await nodeA.discover()
      await nodeB.discover()

      // Alice is the caller. Bob never calls connectToPeer() himself -- his
      // side of the connection comes up via the standing
      // signaling.onOffer() auto-answer, exactly as a passive mesh peer
      // would in production.
      await nodeA.connectToPeer(
        nodeB.podId,
        { webrtc: nodeB.podId },
        { answerTimeoutMs: 10_000, openTimeoutMs: 10_000 },
      )
      await waitFor(
        () => nodeB.meshManager.getConnection(nodeA.podId)?.isOpen,
        10_000,
        "bob's side of the DataChannel to open",
      )

      // -- The callee-side session gap, resolved -----------------------------
      // Before Phase 3, Bob (the callee) had a real, open WebRTCPeerConnection
      // but no PeerNode-level session, so hasActiveSession()/sendTo() didn't
      // work for him. Assert that gap is actually closed: both sides report
      // an active session for each other.
      assert.ok(nodeA.hasActiveSession(nodeB.podId), 'alice (caller) has a session for bob')
      assert.ok(nodeB.hasActiveSession(nodeA.podId), 'bob (callee) has a session for alice -- the Phase 3 fix')

      // -- CRDT edit on the caller side (Alice), observed by the callee (Bob) --
      nodeA.sync.engine.create('shared-notes', 'lww-map')
      nodeA.sync.engine.update('shared-notes', (m) => m.set('title', 'hello from alice', Date.now(), nodeA.podId))
      await nodeA.sync.syncDocWithPeer(nodeB.podId, 'shared-notes')

      await waitFor(
        () => nodeB.sync.engine.get('shared-notes') && nodeB.sync.engine.getState('shared-notes')?.title === 'hello from alice',
        5_000,
        "bob's engine to observe alice's edit after real delivery",
      )
      assert.deepEqual(nodeB.sync.engine.getState('shared-notes'), { title: 'hello from alice' })

      // -- CRDT edit on the callee side (Bob), observed by the caller (Alice) --
      // This direction specifically exercises the callee-side session fix:
      // nodeB.sync.syncDocWithPeer() calls node.sendTo(), which throws
      // "no active session" without PeerNode.adoptIncomingSession() having
      // run for Bob's inbound connection.
      nodeB.sync.engine.update('shared-notes', (m) => m.set('status', 'reviewed by bob', Date.now(), nodeB.podId))
      await nodeB.sync.syncDocWithPeer(nodeA.podId, 'shared-notes')

      await waitFor(
        () => nodeA.sync.engine.getState('shared-notes')?.status === 'reviewed by bob',
        5_000,
        "alice's engine to observe bob's edit after real delivery",
      )
      assert.deepEqual(nodeA.sync.engine.getState('shared-notes'), {
        title: 'hello from alice',
        status: 'reviewed by bob',
      })
      // Both sides converged on the identical merged state.
      assert.deepEqual(nodeA.sync.engine.getState('shared-notes'), nodeB.sync.engine.getState('shared-notes'))

      // -- Persistence: actually persist, then prove a "reload" sees it -----
      await nodeA.sync.save()
      await nodeB.sync.save()

      // Simulate a reload on Alice's side: a fresh MeshSyncEngine + fresh
      // IndexedDBSyncStorage instance pointed at the same dbName, no shared
      // in-memory state with nodeA.sync at all (not even the same
      // MeshSyncBinding -- constructing a new one against a throwaway node
      // stub would be more machinery than the claim needs; the point is
      // the storage adapter, not PeerNode).
      const reloadedStorage = new IndexedDBSyncStorage({ dbName: aliceDbName })
      const { MeshSyncEngine } = await import('@johnhenry/browsermesh-sync')
      const reloadedEngine = new MeshSyncEngine({ nodeId: 'alice-reloaded', storage: reloadedStorage })
      await reloadedEngine.load()

      assert.equal(reloadedEngine.size, 1, 'the reloaded engine sees exactly the one synced document')
      assert.deepEqual(reloadedEngine.getState('shared-notes'), {
        title: 'hello from alice',
        status: 'reviewed by bob',
      }, 'the fully-converged, merged state survived the simulated reload')
    } finally {
      nodeA.meshManager.closeAll()
      nodeB.meshManager.closeAll()
      await nodeA.shutdown()
      await nodeB.shutdown()
      await nodeA.signaling.close()
      await nodeB.signaling.close()
    }
  })
})
