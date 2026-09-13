/**
 * Unit-level tests for mesh-websocket.mjs (Phase 3 of the
 * BrowserMeshFetch/BrowserMeshWebSocket plan -- see that file's own module
 * doc comment for the full wire-protocol/binary-encoding/send-semantics
 * writeup).
 *
 * Matches this family's established pattern for this kind of test
 * (mesh-rpc.test.mjs is the direct precedent): real `PeerRegistry`s wired
 * to real `MeshACL` (`@johnhenry/browsermesh-core`), real Ed25519
 * `IdentityWallet`/`MeshIdentityManager` identities, connected via a
 * minimal duck-typed in-memory bus (not real WebRTC -- that's a later
 * phase's job).
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-websocket.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshWebSocketService, BrowserMeshWebSocket } from '../src/mesh-websocket.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

// ---------------------------------------------------------------------------
// Test fixtures (mirrors mesh-rpc.test.mjs's own createPeer()/wireNodes())
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
 * A minimal duck-typed `PeerNode` pair, matching mesh-rpc.test.mjs's own
 * `wireNodes()` exactly: `podId`/`wallet`/`registry` plus an async
 * `sendTo()`/`onIncomingData()` bus.
 */
function wireNodes(peerA, peerB) {
  const listenersA = new Set()
  const listenersB = new Set()

  const nodeA = {
    podId: peerA.podId,
    wallet: peerA.wallet,
    registry: peerA.registry,
    onIncomingData(cb) {
      listenersA.add(cb)
      return () => listenersA.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersB) cb(peerA.podId, data)
      })
    },
  }
  const nodeB = {
    podId: peerB.podId,
    wallet: peerB.wallet,
    registry: peerB.registry,
    onIncomingData(cb) {
      listenersB.add(cb)
      return () => listenersB.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersA) cb(peerB.podId, data)
      })
    },
  }
  return { nodeA, nodeB }
}

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs = 1000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

/** Wait for one 'open'/'error'/'close' event via addEventListener, resolving with the event. */
function waitForEvent(ws, type, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for '${type}' event`)), timeoutMs)
    ws.addEventListener(type, (event) => {
      clearTimeout(timer)
      resolve(event)
    })
  })
}

// ---------------------------------------------------------------------------
// Client-initiated connection accepted: duplex send/receive, string + binary
// ---------------------------------------------------------------------------

describe('mesh-websocket: accepted connection, duplex send/receive', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodeA
  /** @type {any} */ let nodeB

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    ;({ nodeA, nodeB } = wireNodes(alice, bob))
  })

  it('reaches OPEN on both sides, and both can send/receive string and binary messages', async () => {
    const seenConnections = []
    attachService(nodeB, undefined, createMeshWebSocketService({
      onConnection: (fromPubKey, path) => fromPubKey === alice.podId && path === '/chat',
      onIncomingConnection: (session, info) => seenConnections.push({ session, info }),
    }))

    const client = new BrowserMeshWebSocket(`mesh://${bob.podId}/chat`, { peerNode: nodeA })
    assert.equal(client.readyState, BrowserMeshWebSocket.CONNECTING)

    await waitForEvent(client, 'open')
    assert.equal(client.readyState, BrowserMeshWebSocket.OPEN)

    await waitFor(() => seenConnections.length === 1, 500, 'server-side session created')
    const { session: server, info } = seenConnections[0]
    assert.equal(info.fromPubKey, alice.podId)
    assert.equal(info.path, '/chat')
    assert.equal(server.readyState, BrowserMeshWebSocket.OPEN)
    assert.equal(server.path, '/chat')
    assert.equal(server.remotePodId, alice.podId)

    // String message, client -> server.
    const serverMessages = []
    server.onmessage = (event) => serverMessages.push(event.data)
    client.send('hello from alice')
    await waitFor(() => serverMessages.length === 1, 500, 'server received string message')
    assert.equal(serverMessages[0], 'hello from alice')

    // String message, server -> client.
    const clientMessages = []
    client.onmessage = (event) => clientMessages.push(event.data)
    server.send('hello from bob')
    await waitFor(() => clientMessages.length === 1, 500, 'client received string message')
    assert.equal(clientMessages[0], 'hello from bob')

    // Binary message, client -> server (Uint8Array).
    const binaryPayload = new Uint8Array([1, 2, 3, 4, 250])
    client.send(binaryPayload)
    await waitFor(() => serverMessages.length === 2, 500, 'server received binary message')
    const receivedBinary = serverMessages[1]
    assert.ok(receivedBinary instanceof ArrayBuffer, 'binary message arrives as an ArrayBuffer')
    assert.deepEqual(new Uint8Array(receivedBinary), binaryPayload)

    // Binary message, server -> client (ArrayBuffer).
    const replyBuffer = new Uint8Array([9, 8, 7]).buffer
    server.send(replyBuffer)
    await waitFor(() => clientMessages.length === 2, 500, 'client received binary message')
    assert.ok(clientMessages[1] instanceof ArrayBuffer)
    assert.deepEqual(new Uint8Array(clientMessages[1]), new Uint8Array([9, 8, 7]))

    client.close()
    server.close()
  })

  it('onConnection can be async and returns a Promise<boolean>', async () => {
    attachService(nodeB, undefined, createMeshWebSocketService({
      onConnection: async (fromPubKey) => {
        await new Promise((r) => setTimeout(r, 10))
        return fromPubKey === alice.podId
      },
    }))

    const client = new BrowserMeshWebSocket(`mesh://${bob.podId}/x`, { peerNode: nodeA })
    await waitForEvent(client, 'open')
    assert.equal(client.readyState, BrowserMeshWebSocket.OPEN)
    client.close()
  })
})

// ---------------------------------------------------------------------------
// Rejection: onConnection returns false, or is missing entirely
// ---------------------------------------------------------------------------

describe('mesh-websocket: rejected connections never reach OPEN', () => {
  it('onConnection returning false rejects the connection: never OPEN, fires error then close', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshWebSocketService({
      onConnection: () => false,
    }))

    const client = new BrowserMeshWebSocket(`mesh://${bob.podId}/denied`, { peerNode: nodeA })
    // Register both listeners synchronously, before either event has a
    // chance to fire (error+close fire back-to-back synchronously once the
    // ws-reject envelope arrives) -- see similar fix for the timeout test below.
    const errorPromise = waitForEvent(client, 'error')
    const closePromise = waitForEvent(client, 'close')

    const errorEvent = await errorPromise
    assert.ok(errorEvent.message)

    const closeEvent = await closePromise
    assert.equal(closeEvent.code, 4403)
    assert.equal(client.readyState, BrowserMeshWebSocket.CLOSED)
  })

  it('a target with no onConnection handler at all rejects every inbound connection by default', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshWebSocketService({})) // no onConnection supplied

    const client = new BrowserMeshWebSocket(`mesh://${bob.podId}/anything`, { peerNode: nodeA })
    const closeEvent = await waitForEvent(client, 'close')
    assert.equal(closeEvent.code, 4403)
    assert.equal(closeEvent.reason, 'no onConnection handler registered')
  })

  it('onConnection throwing is treated as a rejection, not an unhandled rejection or a crash', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshWebSocketService({
      onConnection: () => { throw new Error('boom') },
    }))

    const client = new BrowserMeshWebSocket(`mesh://${bob.podId}/explode`, { peerNode: nodeA })
    const closeEvent = await waitForEvent(client, 'close')
    assert.equal(closeEvent.code, 4403)
  })

  it('an open handshake that never gets any response times out into error + close with code 1006', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA } = wireNodes(alice, bob) // nodeB never attaches a mesh-websocket service

    const client = new BrowserMeshWebSocket(`mesh://${bob.podId}/never-answered`, { peerNode: nodeA, openTimeoutMs: 100 })
    assert.equal(client.readyState, BrowserMeshWebSocket.CONNECTING)
    // Register both listeners synchronously, before either event has a
    // chance to fire (error+close fire back-to-back synchronously from the
    // same setTimeout callback once openTimeoutMs elapses).
    const errorPromise = waitForEvent(client, 'error', 1000)
    const closePromise = waitForEvent(client, 'close', 1000)

    const start = Date.now()
    const errorEvent = await errorPromise
    const closeEvent = await closePromise
    const elapsed = Date.now() - start

    assert.ok(errorEvent.message.includes('timed out'))
    assert.equal(closeEvent.code, 1006)
    assert.ok(elapsed < 1000, `expected a prompt timeout around 100ms, took ${elapsed}ms`)
    assert.equal(client.readyState, BrowserMeshWebSocket.CLOSED)
  })
})

// ---------------------------------------------------------------------------
// close() from either side transitions both ends to CLOSED
// ---------------------------------------------------------------------------

describe('mesh-websocket: close() from either side', () => {
  async function setupOpenPair() {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    let serverSession = null
    attachService(nodeB, undefined, createMeshWebSocketService({
      onConnection: () => true,
      onIncomingConnection: (session) => { serverSession = session },
    }))

    const client = new BrowserMeshWebSocket(`mesh://${bob.podId}/pair`, { peerNode: nodeA })
    await waitForEvent(client, 'open')
    await waitFor(() => serverSession !== null, 500, 'server session created')
    return { client, server: serverSession }
  }

  it('close() from the client cleanly transitions both ends to CLOSED and fires onclose on both', async () => {
    const { client, server } = await setupOpenPair()

    const clientClosed = waitForEvent(client, 'close')
    const serverClosed = waitForEvent(server, 'close')

    client.close(1000, 'bye from client')

    const clientCloseEvent = await clientClosed
    const serverCloseEvent = await serverClosed

    assert.equal(client.readyState, BrowserMeshWebSocket.CLOSED)
    assert.equal(server.readyState, BrowserMeshWebSocket.CLOSED)
    assert.equal(clientCloseEvent.code, 1000)
    assert.equal(serverCloseEvent.code, 1000)
    assert.equal(serverCloseEvent.reason, 'bye from client')
  })

  it('close() from the server cleanly transitions both ends to CLOSED and fires onclose on both', async () => {
    const { client, server } = await setupOpenPair()

    const clientClosed = waitForEvent(client, 'close')
    const serverClosed = waitForEvent(server, 'close')

    server.close(1000, 'bye from server')

    const clientCloseEvent = await clientClosed
    const serverCloseEvent = await serverClosed

    assert.equal(client.readyState, BrowserMeshWebSocket.CLOSED)
    assert.equal(server.readyState, BrowserMeshWebSocket.CLOSED)
    assert.equal(clientCloseEvent.code, 1000)
    assert.equal(clientCloseEvent.reason, 'bye from server')
    assert.equal(serverCloseEvent.code, 1000)
  })

  it('close() is idempotent -- calling it twice does not throw or double-fire close', async () => {
    const { client } = await setupOpenPair()
    let closeCount = 0
    client.addEventListener('close', () => { closeCount += 1 })

    client.close()
    client.close()
    await waitFor(() => closeCount === 1, 500, 'close fired exactly once')
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(closeCount, 1)
  })
})

// ---------------------------------------------------------------------------
// send() before OPEN / after CLOSE throws
// ---------------------------------------------------------------------------

describe('mesh-websocket: send() state-machine enforcement', () => {
  it('send() before OPEN (readyState CONNECTING) throws InvalidStateError', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA } = wireNodes(alice, bob)

    const client = new BrowserMeshWebSocket(`mesh://${bob.podId}/x`, { peerNode: nodeA })
    assert.equal(client.readyState, BrowserMeshWebSocket.CONNECTING)
    assert.throws(() => client.send('too early'), /InvalidStateError/)
  })

  it('send() after CLOSE throws rather than silently dropping the data', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshWebSocketService({ onConnection: () => true }))
    const client = new BrowserMeshWebSocket(`mesh://${bob.podId}/x`, { peerNode: nodeA })
    await waitForEvent(client, 'open')

    client.close()
    await waitForEvent(client, 'close')
    assert.equal(client.readyState, BrowserMeshWebSocket.CLOSED)
    assert.throws(() => client.send('too late'), /InvalidStateError/)
  })

  it('send() rejects non-string/ArrayBuffer/ArrayBufferView payloads with a TypeError', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshWebSocketService({ onConnection: () => true }))
    const client = new BrowserMeshWebSocket(`mesh://${bob.podId}/x`, { peerNode: nodeA })
    await waitForEvent(client, 'open')

    assert.throws(() => client.send({ not: 'supported' }), TypeError)
    client.close()
  })
})

// ---------------------------------------------------------------------------
// api.connect() convenience wrapper
// ---------------------------------------------------------------------------

describe('mesh-websocket: createMeshWebSocketService api.connect()', () => {
  it('api.connect() returns a working BrowserMeshWebSocket bound to the attached peerNode', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshWebSocketService({ onConnection: () => true }))
    const { api: aliceApi } = attachService(nodeA, undefined, createMeshWebSocketService({}))

    const client = aliceApi.connect(`mesh://${bob.podId}/via-api`)
    assert.ok(client instanceof BrowserMeshWebSocket)
    await waitForEvent(client, 'open')
    assert.equal(client.readyState, BrowserMeshWebSocket.OPEN)
    client.close()
  })
})

// ---------------------------------------------------------------------------
// addEventListener / removeEventListener
// ---------------------------------------------------------------------------

describe('mesh-websocket: addEventListener/removeEventListener', () => {
  it('both onmessage property and addEventListener("message", ...) listeners fire for the same event', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    let serverSession = null
    attachService(nodeB, undefined, createMeshWebSocketService({
      onConnection: () => true,
      onIncomingConnection: (session) => { serverSession = session },
    }))
    const client = new BrowserMeshWebSocket(`mesh://${bob.podId}/x`, { peerNode: nodeA })
    await waitForEvent(client, 'open')
    await waitFor(() => serverSession !== null, 500, 'server session created')

    const viaProperty = []
    const viaListener = []
    serverSession.onmessage = (e) => viaProperty.push(e.data)
    serverSession.addEventListener('message', (e) => viaListener.push(e.data))

    client.send('dual-dispatch')
    await waitFor(() => viaProperty.length === 1 && viaListener.length === 1, 500, 'both dispatch paths fired')
    assert.equal(viaProperty[0], 'dual-dispatch')
    assert.equal(viaListener[0], 'dual-dispatch')

    client.close()
  })

  it('removeEventListener stops further delivery to that listener', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    attachService(nodeB, undefined, createMeshWebSocketService({ onConnection: () => true }))
    const client = new BrowserMeshWebSocket(`mesh://${bob.podId}/x`, { peerNode: nodeA })

    let calls = 0
    const listener = () => { calls += 1 }
    client.addEventListener('open', listener)
    client.removeEventListener('open', listener)

    await new Promise((r) => setTimeout(r, 50))
    assert.equal(calls, 0, 'removed listener must not fire')
    client.close()
  })
})

// ---------------------------------------------------------------------------
// Invalid URL
// ---------------------------------------------------------------------------

describe('mesh-websocket: constructor validation', () => {
  it('throws for a non-mesh URL', async () => {
    const alice = await createPeer('alice')
    const nodeA = { podId: alice.podId, sendTo: async () => {}, onIncomingData: () => () => {} }
    assert.throws(() => new BrowserMeshWebSocket('https://example.com/not-mesh', { peerNode: nodeA }), /invalid mesh URL/)
  })

  it('throws when opts.peerNode is missing or malformed', () => {
    assert.throws(() => new BrowserMeshWebSocket('mesh://podid/x', {}), /peerNode/)
    assert.throws(() => new BrowserMeshWebSocket('mesh://podid/x', { peerNode: {} }), /peerNode/)
  })
})
