/**
 * Tests for mesh-keepalive.mjs (issue #110): the real ping/pong keepalive
 * envelope protocol wiring `@johnhenry/browsermesh-core`'s
 * `TransportHealthCheck` to `PeerNode`'s own dispatch bus.
 *
 * Mirrors `observability-bridge.test.mjs`'s own reasoning for why this file
 * needs REAL `PeerNode` instances rather than the minimal duck-typed
 * `{podId, wallet, registry, onIncomingData, sendTo}` node pair
 * `mesh-rpc.test.mjs`/`grant-log.test.mjs` use: this service subscribes to a
 * real `PeerNode`'s OWN `'peer:connect'`/`'peer:disconnect'`/
 * `'peer:transport-close'`/`'peer:transport-error'` events (`peer-node.mjs`),
 * which only a real `PeerNode` exposes. Two real `PeerNode`s are linked via
 * `adoptIncomingSession()` fed a minimal in-memory duplex transport --
 * `observability-bridge.test.mjs`'s own `linkRealNodes()` pattern, extended
 * here to also support manually firing `onClose()`/`onError()` (for the
 * "bonus" native-transport-close wiring tests).
 *
 * Real, small `intervalMs`/`timeoutMs` are used throughout (matching
 * `packages/browsermesh-core/test/hardening.test.mjs`'s own
 * `TransportHealthCheck` test pattern -- that class drives its ping schedule
 * off real `setInterval`/`setTimeout`, not an injectable clock) with real,
 * short `await` delays rather than mocked timers, since nothing in this
 * repo mocks `setInterval`/`setTimeout` today.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-keepalive.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PeerNode } from '../src/peer-node.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshKeepaliveService } from '../src/mesh-keepalive.mjs'
import { endpointsKey } from '../src/mesh-hardening.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'
import { MockMeshTransport } from '@johnhenry/browsermesh-transport'

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
 * Build a minimal in-memory duplex transport pair (send/onMessage, plus
 * onClose/onError with manual trigger helpers) and adopt each side onto a
 * real, already-booted PeerNode via adoptIncomingSession() -- mirrors
 * observability-bridge.test.mjs's own linkRealNodes(), extended with
 * fireCloseA()/fireCloseB()/fireErrorA()/fireErrorB() so tests can simulate
 * a transport's own native close/error signal (the "bonus" wiring peer-node.mjs
 * now surfaces as 'peer:transport-close'/'peer:transport-error').
 *
 * @param {PeerNode} nodeA
 * @param {PeerNode} nodeB
 */
async function linkRealNodes(nodeA, nodeB) {
  let aOnMessage = null, bOnMessage = null
  let aOnClose = null, bOnClose = null
  let aOnError = null, bOnError = null

  const transportForA = {
    send(data) { queueMicrotask(() => { if (bOnMessage) bOnMessage(data) }) },
    onMessage(cb) { aOnMessage = cb },
    onClose(cb) { aOnClose = cb },
    onError(cb) { aOnError = cb },
  }
  const transportForB = {
    send(data) { queueMicrotask(() => { if (aOnMessage) aOnMessage(data) }) },
    onMessage(cb) { bOnMessage = cb },
    onClose(cb) { bOnClose = cb },
    onError(cb) { bOnError = cb },
  }

  await nodeA.adoptIncomingSession(nodeB.podId, transportForA, 'inmemory')
  await nodeB.adoptIncomingSession(nodeA.podId, transportForB, 'inmemory')

  return {
    fireCloseA: () => aOnClose && aOnClose(),
    fireCloseB: () => bOnClose && bOnClose(),
    fireErrorA: (err) => aOnError && aOnError(err),
    fireErrorB: (err) => bOnError && bOnError(err),
  }
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
// Real ping sent, real pong received -> healthy
// ---------------------------------------------------------------------------

describe('mesh-keepalive: real ping/pong -> healthy', () => {
  it('reports healthy once real pongs are flowing both ways', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    await linkRealNodes(nodeA, nodeB)

    const handleA = attachService(nodeA, undefined, createMeshKeepaliveService({ intervalMs: 25, timeoutMs: 200, maxMissed: 3 }))
    const handleB = attachService(nodeB, undefined, createMeshKeepaliveService({ intervalMs: 25, timeoutMs: 200, maxMissed: 3 }))

    assert.equal(handleA.api.getStatus(bob.podId), 'healthy', 'starts healthy before the first ping (TransportHealthCheck default)')

    await waitFor(() => handleA.api.getStatus(bob.podId) === 'healthy' && handleA.api.getCheck(bob.podId).totalPongs > 0, 2000, 'nodeA to receive a real pong from nodeB')
    await waitFor(() => handleB.api.getStatus(alice.podId) === 'healthy' && handleB.api.getCheck(alice.podId).totalPongs > 0, 2000, 'nodeB to receive a real pong from nodeA')

    assert.ok(handleA.api.getCheck(bob.podId).totalPings > 0, 'nodeA actually sent ping envelopes')
    assert.ok(handleB.api.getCheck(alice.podId).totalPings > 0, 'nodeB actually sent ping envelopes')

    handleA.teardown()
    handleB.teardown()
  })
})

// ---------------------------------------------------------------------------
// Missed pongs -> degraded -> unhealthy, matching TransportHealthCheck's
// own documented thresholds
// ---------------------------------------------------------------------------

describe('mesh-keepalive: missed pongs -> degraded -> unhealthy', () => {
  it('escalates through degraded to unhealthy when the far side never replies', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    // nodeB never gets the keepalive service attached, so it never answers
    // pings -- every ping nodeA sends will time out.
    await linkRealNodes(nodeA, nodeB)

    const handleA = attachService(nodeA, undefined, createMeshKeepaliveService({ intervalMs: 30, timeoutMs: 20, maxMissed: 2 }))
    const events = recordEvents(handleA)

    await waitFor(() => handleA.api.getStatus(bob.podId) === 'degraded', 2000, 'first missed pong -> degraded')
    await waitFor(() => handleA.api.getStatus(bob.podId) === 'unhealthy', 2000, 'maxMissed misses -> unhealthy')

    const degradedEvents = events.filter((e) => e.event === 'keepalive:peer-degraded')
    const unhealthyEvents = events.filter((e) => e.event === 'keepalive:peer-unhealthy')
    assert.ok(degradedEvents.length >= 1, 'keepalive:peer-degraded fired')
    assert.equal(degradedEvents[0].data.pubKey, bob.podId)
    assert.ok(unhealthyEvents.length >= 1, 'keepalive:peer-unhealthy fired')
    assert.equal(unhealthyEvents[0].data.pubKey, bob.podId)
    assert.equal(unhealthyEvents[0].data.reason, 'ping-timeout')
    assert.ok(unhealthyEvents[0].data.missedCount >= 2, 'unhealthy only fires once maxMissed is reached')

    handleA.teardown()
  })

  it('recovers to healthy once pongs resume', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    await linkRealNodes(nodeA, nodeB)

    const handleA = attachService(nodeA, undefined, createMeshKeepaliveService({ intervalMs: 25, timeoutMs: 15, maxMissed: 2 }))
    // Attach nodeB's own responder late, after nodeA has already gone unhealthy.
    await waitFor(() => handleA.api.getStatus(bob.podId) === 'unhealthy', 2000, 'goes unhealthy with nobody answering')

    const handleB = attachService(nodeB, undefined, createMeshKeepaliveService({ intervalMs: 25, timeoutMs: 200, maxMissed: 3 }))
    await waitFor(() => handleA.api.getStatus(bob.podId) === 'healthy', 2000, 'recovers once nodeB starts answering')

    handleA.teardown()
    handleB.teardown()
  })
})

// ---------------------------------------------------------------------------
// enableHardening + enableHealthCheck together: unhealthy flips the
// TransportFailover/circuit-breaker state
// ---------------------------------------------------------------------------

describe('mesh-keepalive: hardening integration', () => {
  it('resolves the right per-peer TransportFailover and genuinely calls failover() on unhealthy', async () => {
    // NOTE ON WHAT THIS TEST CAN AND CANNOT PROVE: mesh-bootstrap.mjs (and
    // therefore every real deployment of this repo today) only ever
    // registers a single 'webrtc' transport adapter -- see that file's own
    // header comment and webrtc-negotiator.mjs. TransportFailover.failover()
    // marks the CURRENT transport type as failed and retries among
    // whatever OTHER types were present in the original `endpoints` object
    // -- with only one type ever supplied, there is structurally nothing to
    // fail over TO, so a real `.failover()` call here correctly rejects
    // with "No transports available" (hardening.mjs's own documented
    // behaviour, not a bug in mesh-keepalive.mjs). This test therefore
    // proves the wiring is genuinely connected end-to-end -- the right
    // TransportFailover instance is found via endpointsKey({webrtc: pubKey}),
    // and failover() is actually invoked with the right reason once
    // unhealthy fires -- and that the honest failure is caught and logged
    // rather than thrown or silently swallowed. A deployment that registers
    // a second transport type would see failover() actually succeed; that
    // path is TransportFailover's own responsibility, already covered by
    // packages/browsermesh-core/test/hardening.test.mjs's
    // "works with RetryWithBackoff" style tests.
    const alice = await createPeer('alice')

    // Real MeshTransportNegotiator, wrapped by createHardenedNegotiator() --
    // the same composition mesh-bootstrap.mjs's enableHardening does, done
    // here directly (no signaling/discovery needed) to isolate the
    // keepalive <-> hardening wiring itself.
    const { MeshTransportNegotiator } = await import('@johnhenry/browsermesh-transport')
    const { createHardenedNegotiator } = await import('../src/mesh-hardening.mjs')

    const negotiator = new MeshTransportNegotiator()
    let attempts = 0
    // By convention (webrtc-negotiator.mjs), endpoints.webrtc is the remote
    // peer's podId -- matched here so mesh-keepalive.mjs's best-effort
    // endpointsKey({webrtc: pubKey}) lookup finds the right TransportFailover.
    negotiator.registerAdapter('webrtc', async (endpoint) => {
      attempts++
      const t = new MockMeshTransport('webrtc')
      await t.connect(endpoint)
      return t
    })

    const hardening = await createHardenedNegotiator({ negotiator })
    const nodeWithHardening = new PeerNode({ wallet: alice.wallet, registry: alice.registry, transportNegotiator: hardening })
    await nodeWithHardening.boot()

    const logs = []
    const handle = attachService(nodeWithHardening, undefined, createMeshKeepaliveService({
      intervalMs: 25, timeoutMs: 15, maxMissed: 2, hardening,
      onLog: (event, data) => logs.push({ event, data }),
    }))
    const events = recordEvents(handle)

    const remotePubKey = 'remote-pod-xyz'
    await nodeWithHardening.connectToPeer(remotePubKey, { webrtc: remotePubKey })
    assert.equal(attempts, 1, 'the fake webrtc adapter negotiated the initial session')

    const key = endpointsKey({ webrtc: remotePubKey })
    const failover = hardening.failovers.get(key)
    assert.ok(failover, 'a TransportFailover instance exists for this peer, found via the same endpointsKey() convention mesh-keepalive.mjs uses')

    // Nobody ever answers a keepalive-ping for this peer (no real remote
    // side in this test), so the health check escalates to unhealthy and
    // mesh-keepalive.mjs should call failover.failover() for us.
    await waitFor(
      () => logs.some((l) => l.event === 'mesh-keepalive:failover-failed' && l.data.pubKey === remotePubKey),
      2000,
      'failover() was genuinely invoked (and, with only one registered transport type, honestly reported it had nothing to fail over to)',
    )

    // A real state flip DID happen inside TransportFailover, even though
    // there was nowhere to reconnect to: the failed type is recorded.
    assert.ok(failover.failedTypes.includes('webrtc'), 'failover() genuinely marked webrtc as a failed type before discovering there was no alternative')

    const unhealthyEvents = events.filter((e) => e.event === 'keepalive:peer-unhealthy')
    assert.ok(unhealthyEvents.length >= 1, 'keepalive:peer-unhealthy fired regardless of whether failover itself could succeed')
    assert.equal(unhealthyEvents[0].data.pubKey, remotePubKey)

    // failover() rejected, so the "it worked" event must NOT have fired --
    // this file never fakes success.
    assert.equal(events.filter((e) => e.event === 'keepalive:failover-triggered').length, 0)

    handle.teardown()
  })

  it('emits keepalive:failover-triggered when failover() genuinely succeeds', async () => {
    // The previous test proves the real TransportFailover correlation and
    // invocation; this test isolates the success path with a duck-typed
    // stub failover (real TransportFailover can only succeed when a second
    // transport type was registered up front -- see the note in the
    // previous test), so the "on success, emit keepalive:failover-triggered"
    // half of this file's own logic is exercised directly.
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    await linkRealNodes(nodeA, nodeB)

    let failoverCalls = 0
    const stubFailover = {
      failingOver: false,
      async failover(reason) {
        failoverCalls++
        return { type: 'wsh-ws', reason }
      },
    }
    const hardening = { failovers: new Map([[endpointsKey({ webrtc: bob.podId }), stubFailover]]) }

    // nodeB never gets the keepalive service attached, so pings from nodeA
    // always time out -> unhealthy.
    const handleA = attachService(nodeA, undefined, createMeshKeepaliveService({ intervalMs: 25, timeoutMs: 15, maxMissed: 2, hardening }))
    const events = recordEvents(handleA)

    await waitFor(() => failoverCalls >= 1, 2000, 'the stub failover was invoked')
    await waitFor(() => events.some((e) => e.event === 'keepalive:failover-triggered'), 1000, 'keepalive:failover-triggered fired on success')

    const triggered = events.find((e) => e.event === 'keepalive:failover-triggered')
    assert.equal(triggered.data.pubKey, bob.podId)
    assert.equal(triggered.data.reason, 'keepalive:unhealthy')

    handleA.teardown()
  })

  it('degrades gracefully (no throw) when enableHardening is off', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    await linkRealNodes(nodeA, nodeB)

    // No `hardening` option passed at all.
    const handleA = attachService(nodeA, undefined, createMeshKeepaliveService({ intervalMs: 25, timeoutMs: 15, maxMissed: 2 }))

    await waitFor(() => handleA.api.getStatus(bob.podId) === 'unhealthy', 2000, 'still reaches unhealthy with no hardening wired')

    handleA.teardown()
  })
})

// ---------------------------------------------------------------------------
// Bonus wiring: native transport close/error is an immediate, stronger
// signal than waiting out maxMissed ping/pong cycles
// ---------------------------------------------------------------------------

describe('mesh-keepalive: bonus native transport-close/error wiring', () => {
  it('peer:transport-close immediately reports unhealthy without waiting for maxMissed pings', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    const link = await linkRealNodes(nodeA, nodeB)

    // Long interval/timeout/maxMissed -- ping/pong escalation alone would
    // take a long time. onClose firing should short-circuit straight to
    // unhealthy well before that.
    const handleA = attachService(nodeA, undefined, createMeshKeepaliveService({ intervalMs: 60000, timeoutMs: 30000, maxMissed: 10 }))
    const events = recordEvents(handleA)

    assert.equal(handleA.api.getStatus(bob.podId), 'healthy', 'still healthy before any close signal')

    link.fireCloseA()

    await waitFor(() => events.some((e) => e.event === 'keepalive:peer-unhealthy' && e.data.reason === 'transport-close'), 500, 'transport-close reported as unhealthy')

    handleA.teardown()
  })

  it('peer:transport-error is logged and reported unhealthy', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    const link = await linkRealNodes(nodeA, nodeB)

    const handleA = attachService(nodeA, undefined, createMeshKeepaliveService({ intervalMs: 60000, timeoutMs: 30000, maxMissed: 10 }))
    const events = recordEvents(handleA)

    link.fireErrorA(new Error('simulated ICE failure'))

    await waitFor(() => events.some((e) => e.event === 'keepalive:peer-unhealthy' && e.data.reason === 'transport-error'), 500, 'transport-error reported as unhealthy')

    handleA.teardown()
  })

  it('a transport with no onClose()/onError() is unaffected (duck-typed, optional)', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()

    // Bare transport, no onClose/onError at all -- mirrors mesh-rpc.test.mjs's
    // own minimal transport shape.
    let bOnMessage = null
    const transportForA = { send(data) { queueMicrotask(() => { if (bOnMessage) bOnMessage(data) }) }, onMessage() {} }
    const transportForB = { send() {}, onMessage(cb) { bOnMessage = cb } }
    await nodeA.adoptIncomingSession(bob.podId, transportForA, 'inmemory')
    await nodeB.adoptIncomingSession(alice.podId, transportForB, 'inmemory')

    const handleA = attachService(nodeA, undefined, createMeshKeepaliveService({ intervalMs: 25, timeoutMs: 200, maxMissed: 3 }))
    assert.equal(handleA.api.getStatus(bob.podId), 'healthy')
    handleA.teardown()
  })
})

// ---------------------------------------------------------------------------
// Disconnect tears down the per-peer TransportHealthCheck instance --
// no leaked timers.
// ---------------------------------------------------------------------------

describe('mesh-keepalive: instance lifecycle / no leaked timers', () => {
  it('stops tracking and stops sending pings for a peer once it disconnects', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    await linkRealNodes(nodeA, nodeB)

    const handleA = attachService(nodeA, undefined, createMeshKeepaliveService({ intervalMs: 20, timeoutMs: 200, maxMissed: 5 }))
    const handleB = attachService(nodeB, undefined, createMeshKeepaliveService({ intervalMs: 20, timeoutMs: 200, maxMissed: 5 }))

    await waitFor(() => handleA.api.getCheck(bob.podId) !== null, 1000, 'peer tracked once connected')

    // Spy on nodeA.sendTo to count keepalive-ping envelopes actually sent,
    // proving (not just asserting) that the interval timer really stops
    // firing after disconnect -- matches this family's SessionManager
    // heartbeat-leak-fix precedent of proving timer cleanup via observable
    // behaviour rather than reaching into private state.
    const originalSendTo = nodeA.sendTo.bind(nodeA)
    let pingsSent = 0
    nodeA.sendTo = async (pubKey, data) => {
      if (data && data.type === 'keepalive-ping') pingsSent++
      return originalSendTo(pubKey, data)
    }

    await waitFor(() => pingsSent >= 2, 1000, 'at least two ping cycles observed while connected')

    nodeA.disconnectPeer(bob.podId)

    assert.equal(handleA.api.getStatus(bob.podId), null, 'no longer tracked immediately after disconnect')
    assert.equal(handleA.api.getCheck(bob.podId), null)
    assert.ok(!handleA.api.listTracked().includes(bob.podId))

    const countAtDisconnect = pingsSent
    await new Promise((r) => setTimeout(r, 120)) // several would-be interval cycles
    assert.equal(pingsSent, countAtDisconnect, 'no further pings were sent for the disconnected peer -- the interval timer was actually cleared')

    handleA.teardown()
    handleB.teardown()
  })

  it('teardown() stops every tracked peer\'s health check', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const carol = await createPeer('carol')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    const nodeC = new PeerNode({ wallet: carol.wallet, registry: carol.registry })
    await nodeA.boot()
    await nodeB.boot()
    await nodeC.boot()
    await linkRealNodes(nodeA, nodeB)
    await linkRealNodes(nodeA, nodeC)

    const handleA = attachService(nodeA, undefined, createMeshKeepaliveService({ intervalMs: 20, timeoutMs: 200, maxMissed: 5 }))

    await waitFor(() => handleA.api.listTracked().length === 2, 1000, 'both peers tracked')

    handleA.teardown()

    assert.deepEqual(handleA.api.listTracked(), [], 'teardown() stopped and cleared every tracked peer')
  })

  it('bootstraps peers that connected before this service was attached', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const nodeA = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
    const nodeB = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
    await nodeA.boot()
    await nodeB.boot()
    // Connect BEFORE the keepalive service is attached.
    await linkRealNodes(nodeA, nodeB)

    const handleA = attachService(nodeA, undefined, createMeshKeepaliveService({ intervalMs: 25, timeoutMs: 200, maxMissed: 3 }))

    assert.ok(handleA.api.listTracked().includes(bob.podId), 'a peer connected before attach() is still picked up')

    handleA.teardown()
  })
})
