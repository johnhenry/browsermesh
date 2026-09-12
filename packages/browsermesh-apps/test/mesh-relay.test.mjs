/**
 * Unit-level tests for mesh-relay-host.mjs / mesh-relay-backend.mjs (Phase 8,
 * issue #72).
 *
 * Deliberately NOT mocked at the layers where correctness actually lives:
 * a real `PeerRegistry` wired to a real `MeshACL` (`@johnhenry/browsermesh-core`)
 * for authorization, and a real `VirtualNetwork` (`@johnhenry/browsermesh-netway`)
 * with its default `LoopbackBackend` standing in for "the real local service"
 * (an in-memory `mem://` echo listener). What IS a test double: the two
 * `PeerNode`s -- a minimal, duck-typed `{ sendTo, onIncomingData }` bus
 * (async, over `queueMicrotask`, so ordering assumptions aren't accidentally
 * relying on same-tick delivery) wired directly between two "sides", since
 * this suite tests `MeshRelayHost`/`MeshRelayBackend`'s own framing/
 * multiplexing/authorization logic, not `PeerNode`/WebRTC itself (that's
 * `test/real-peer/mesh-relay.test.mjs`'s job).
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-relay.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { MeshRelayHost } from '../src/mesh-relay-host.mjs'
import { MeshRelayBackend } from '../src/mesh-relay-backend.mjs'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { VirtualNetwork } from '@johnhenry/browsermesh-netway'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * A minimal duck-typed `PeerNode` pair: `sendTo(pubKey, data)` /
 * `onIncomingData(cb)`, wired directly to each other over an async bus.
 * Only carries the two methods `MeshRelayHost`/`MeshRelayBackend` actually
 * call -- everything else about a real `PeerNode` (identity, discovery,
 * transport negotiation) is irrelevant to what this suite is proving.
 */
function createNodePair(podIdA, podIdB) {
  const listenersA = new Set()
  const listenersB = new Set()

  const nodeA = {
    podId: podIdA,
    onIncomingData(cb) {
      listenersA.add(cb)
      return () => listenersA.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersB) cb(podIdA, data)
      })
    },
  }
  const nodeB = {
    podId: podIdB,
    onIncomingData(cb) {
      listenersB.add(cb)
      return () => listenersB.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersA) cb(podIdB, data)
      })
    },
  }
  return { nodeA, nodeB }
}

/** A real `PeerRegistry` wired to a real `MeshACL`, matching mesh-bootstrap.mjs's own wiring. */
function createRegistry(localPodId) {
  return new PeerRegistry({
    localPodId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: localPodId }),
  })
}

/**
 * A real `VirtualNetwork` with a `mem://` echo listener standing in for "the
 * real local service" `MeshRelayHost` bridges into. Echoes every chunk
 * received back verbatim; runs until the listener closes.
 */
async function createEchoNetwork(address = 'mem://localhost:9000') {
  const network = new VirtualNetwork()
  const listener = await network.listen(address)

  ;(async () => {
    while (true) {
      const sock = await listener.accept()
      if (!sock) break
      ;(async () => {
        try {
          while (true) {
            const chunk = await sock.read()
            if (chunk === null) break
            await sock.write(chunk)
          }
        } catch { /* socket closed mid-read/write */ }
      })()
    }
  })()

  return { network, listener }
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

const enc = new TextEncoder()
const dec = new TextDecoder()

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

describe('mesh-relay: MeshRelayHost + MeshRelayBackend', () => {
  const ALICE = 'alice-pod'
  const BOB = 'bob-pod'
  const CAROL = 'carol-pod'

  /** @type {any} */ let echoNetwork
  /** @type {any} */ let registry

  beforeEach(async () => {
    echoNetwork = await createEchoNetwork()
    registry = createRegistry(ALICE)
  })

  afterEach(async () => {
    await echoNetwork.network.close()
  })

  it('connect -> data -> close framing works end to end, via VirtualNetwork.connect()', async () => {
    const { nodeA: aliceNode, nodeB: bobNode } = createNodePair(ALICE, BOB)
    const host = new MeshRelayHost({ node: aliceNode, network: echoNetwork.network, registry })
    host.exposeService('echo', 'mem://localhost:9000')

    registry.grantCapabilities(BOB, ['mesh-relay:echo:connect'])

    const backend = new MeshRelayBackend({ node: bobNode, relayPeerPubKey: ALICE })
    const bobNetwork = new VirtualNetwork()
    bobNetwork.addBackend('via-alice', backend)

    try {
      const socket = await bobNetwork.connect('via-alice://echo')
      assert.ok(socket, 'connect() resolved with a socket')

      await socket.write(enc.encode('hello, alice'))
      const echoed = await socket.read()
      assert.equal(dec.decode(echoed), 'hello, alice')

      await socket.close()
      // Give the host's pump a tick to notice EOF and clean up -- no
      // observable side effect to assert beyond "it doesn't throw/hang",
      // covered by the afterEach network.close() completing cleanly.
      await new Promise((r) => setTimeout(r, 20))
    } finally {
      await backend.close()
      await host.detach()
    }
  })

  it('multiplexes two simultaneous connIds without cross-talk', async () => {
    const { nodeA: aliceNode, nodeB: bobNode } = createNodePair(ALICE, BOB)
    const host = new MeshRelayHost({ node: aliceNode, network: echoNetwork.network, registry })
    host.exposeService('echo', 'mem://localhost:9000')
    registry.grantCapabilities(BOB, ['mesh-relay:echo:connect'])

    const backend = new MeshRelayBackend({ node: bobNode, relayPeerPubKey: ALICE })

    try {
      const [socketOne, socketTwo] = await Promise.all([
        backend.connect('echo'),
        backend.connect('echo'),
      ])
      assert.notEqual(socketOne, socketTwo)

      await Promise.all([
        socketOne.write(enc.encode('stream-one')),
        socketTwo.write(enc.encode('stream-two')),
      ])

      const [backOne, backTwo] = await Promise.all([socketOne.read(), socketTwo.read()])
      assert.equal(dec.decode(backOne), 'stream-one', 'stream one got its own echo back, not stream two\'s')
      assert.equal(dec.decode(backTwo), 'stream-two', 'stream two got its own echo back, not stream one\'s')

      await socketOne.close()
      await socketTwo.close()
    } finally {
      await backend.close()
      await host.detach()
    }
  })

  it('refuses a peer with no grant at all', async () => {
    const { nodeA: aliceNode, nodeB: carolNode } = createNodePair(ALICE, CAROL)
    const host = new MeshRelayHost({ node: aliceNode, network: echoNetwork.network, registry })
    host.exposeService('echo', 'mem://localhost:9000')
    // Deliberately: no registry.grantCapabilities(CAROL, ...) call.

    const backend = new MeshRelayBackend({ node: carolNode, relayPeerPubKey: ALICE })

    try {
      await assert.rejects(
        () => backend.connect('echo'),
        (err) => {
          assert.equal(err.name, 'ConnectionRefusedError')
          return true
        },
        'an ungranted peer must be refused, not silently connected',
      )
    } finally {
      await backend.close()
      await host.detach()
    }
  })

  it('refuses an unknown service explicitly -- never silently connects to nothing', async () => {
    const { nodeA: aliceNode, nodeB: bobNode } = createNodePair(ALICE, BOB)
    const host = new MeshRelayHost({ node: aliceNode, network: echoNetwork.network, registry })
    // Note: 'echo' is intentionally NOT exposed via host.exposeService() here.
    registry.grantCapabilities(BOB, ['mesh-relay:echo:connect'])

    const backend = new MeshRelayBackend({ node: bobNode, relayPeerPubKey: ALICE })

    try {
      await assert.rejects(
        () => backend.connect('echo'),
        (err) => {
          assert.equal(err.name, 'ConnectionRefusedError')
          assert.match(err.message, /unknown service/)
          return true
        },
      )
    } finally {
      await backend.close()
      await host.detach()
    }
  })

  it('wildcard grants (mesh-relay:*:connect) authorize any exposed service', async () => {
    const { nodeA: aliceNode, nodeB: bobNode } = createNodePair(ALICE, BOB)
    const host = new MeshRelayHost({ node: aliceNode, network: echoNetwork.network, registry })
    host.exposeService('echo', 'mem://localhost:9000')
    registry.grantCapabilities(BOB, ['mesh-relay:*:connect'])

    const backend = new MeshRelayBackend({ node: bobNode, relayPeerPubKey: ALICE })

    try {
      const socket = await backend.connect('echo')
      assert.ok(socket)
      await socket.close()
    } finally {
      await backend.close()
      await host.detach()
    }
  })

  it('revoke mid-session: an already-open connection is unaffected, but the next connect() is denied', async () => {
    const { nodeA: aliceNode, nodeB: bobNode } = createNodePair(ALICE, BOB)
    const host = new MeshRelayHost({ node: aliceNode, network: echoNetwork.network, registry })
    host.exposeService('echo', 'mem://localhost:9000')
    registry.grantCapabilities(BOB, ['mesh-relay:echo:connect'])

    const backend = new MeshRelayBackend({ node: bobNode, relayPeerPubKey: ALICE })

    try {
      // Grant -> one successful round trip.
      const socket = await backend.connect('echo')
      await socket.write(enc.encode('before revoke'))
      const echoed = await socket.read()
      assert.equal(dec.decode(echoed), 'before revoke')
      await socket.close()

      // Revoke.
      registry.revokeCapabilities(BOB, ['mesh-relay:echo:connect'])

      // Next connect attempt must be denied.
      await assert.rejects(
        () => backend.connect('echo'),
        (err) => {
          assert.equal(err.name, 'ConnectionRefusedError')
          return true
        },
        'the next connect() after revoke must be refused',
      )
    } finally {
      await backend.close()
      await host.detach()
    }
  })

  it('hideService() causes subsequent connects to that service to be refused as unknown', async () => {
    const { nodeA: aliceNode, nodeB: bobNode } = createNodePair(ALICE, BOB)
    const host = new MeshRelayHost({ node: aliceNode, network: echoNetwork.network, registry })
    host.exposeService('echo', 'mem://localhost:9000')
    registry.grantCapabilities(BOB, ['mesh-relay:echo:connect'])

    const backend = new MeshRelayBackend({ node: bobNode, relayPeerPubKey: ALICE })

    try {
      const socket = await backend.connect('echo')
      await socket.close()

      assert.ok(host.hideService('echo'))
      assert.deepEqual(host.listServices(), [])

      await assert.rejects(
        () => backend.connect('echo'),
        (err) => {
          assert.equal(err.name, 'ConnectionRefusedError')
          assert.match(err.message, /unknown service/)
          return true
        },
      )
    } finally {
      await backend.close()
      await host.detach()
    }
  })

  it('connect() times out if the host never responds (e.g. envelope dropped)', async () => {
    const { nodeA: aliceNode, nodeB: bobNode } = createNodePair(ALICE, BOB)
    // Deliberately: no MeshRelayHost constructed on aliceNode's side, so no
    // 'ok'/'refused' will ever arrive.
    const backend = new MeshRelayBackend({ node: bobNode, relayPeerPubKey: ALICE, connectTimeoutMs: 50 })

    try {
      await assert.rejects(() => backend.connect('echo'), /timed out/)
    } finally {
      await backend.close()
    }
  })

  it('a natural EOF on the local service closes the relayed connection and the client sees EOF', async () => {
    // A second echo network whose listener closes the accepted socket
    // immediately after one write, to exercise the "natural socket EOF"
    // close path (not an explicit close op from either peer).
    const network = new VirtualNetwork()
    const listener = await network.listen('mem://localhost:9100')
    ;(async () => {
      const sock = await listener.accept()
      await sock.write(enc.encode('one shot'))
      // Give the relay's read pump a chance to actually pull the queued
      // chunk before close() runs -- StreamSocket.close() discards
      // whatever is still sitting unread in the buffer (existing,
      // out-of-scope-here AsyncBuffer behavior), so an immediate
      // write-then-close in the same microtask batch would race it away.
      await new Promise((r) => setTimeout(r, 30))
      await sock.close()
    })()

    const { nodeA: aliceNode, nodeB: bobNode } = createNodePair(ALICE, BOB)
    const host = new MeshRelayHost({ node: aliceNode, network, registry })
    host.exposeService('one-shot', 'mem://localhost:9100')
    registry.grantCapabilities(BOB, ['mesh-relay:one-shot:connect'])

    const backend = new MeshRelayBackend({ node: bobNode, relayPeerPubKey: ALICE })

    try {
      const socket = await backend.connect('one-shot')
      const chunk = await socket.read()
      assert.equal(dec.decode(chunk), 'one shot')

      const eof = await socket.read()
      assert.equal(eof, null, 'the client socket sees EOF once the local service closes naturally')
    } finally {
      await backend.close()
      await host.detach()
      await network.close()
    }
  })
})
