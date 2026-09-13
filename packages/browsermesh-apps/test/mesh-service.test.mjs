/**
 * Unit-level tests for mesh-service.mjs (Phase C of the CloudStorage plan --
 * see /Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md,
 * "MeshService attach convention").
 *
 * Deliberately NOT mocked at the layers where correctness actually lives: a
 * real `PeerRegistry` wired to a real `MeshACL` (`@johnhenry/browsermesh-core`)
 * and a real `VirtualNetwork` (`@johnhenry/browsermesh-netway`), matching
 * `test/mesh-relay.test.mjs`'s established convention. What IS a test
 * double: the `PeerNode` itself -- a minimal, duck-typed `{ podId, registry,
 * sendTo, onIncomingData }` pair wired directly to each other over an async
 * bus, since this suite tests `attachService()`'s own ctx/wiring/teardown
 * logic, not `PeerNode`/WebRTC itself.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-service.test.mjs
 */

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { attachService } from '../src/mesh-service.mjs'
import { createMeshNode } from '../src/mesh-bootstrap.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { VirtualNetwork, Backend, StreamSocket } from '@johnhenry/browsermesh-netway'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

// ---------------------------------------------------------------------------
// Test doubles (mirrors test/mesh-relay.test.mjs's createNodePair exactly)
// ---------------------------------------------------------------------------

/**
 * A minimal duck-typed `PeerNode` pair: `podId`, `registry`, `sendTo(pubKey,
 * data)`, `onIncomingData(cb)`, wired directly to each other over an async
 * bus. Only carries what `attachService()`/`ctx` actually touch.
 */
function createNodePair(podIdA, podIdB, { registryA, registryB } = {}) {
  const listenersA = new Set()
  const listenersB = new Set()

  const nodeA = {
    podId: podIdA,
    registry: registryA,
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
    registry: registryB,
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
// Fixture descriptors
// ---------------------------------------------------------------------------

/** A minimal MeshService: records every ctx it was attached with, plus every matching envelope it received. */
function createRecordingDescriptor({ name = 'recorder', envelopeType = 'ping' } = {}) {
  const received = []
  let capturedCtx = null
  const descriptor = {
    name,
    attach(peerNode, ctx) {
      capturedCtx = ctx
      const unsubscribe = ctx.onIncomingData(envelopeType, (pubKey, envelope) => {
        received.push({ pubKey, envelope })
      })
      return () => unsubscribe()
    },
  }
  return { descriptor, received, getCtx: () => capturedCtx }
}

/** A tiny Backend that hands back a connected StreamSocket pair, echoing writes back to the caller. */
class RecordingBackend extends Backend {
  constructor() {
    super()
    this.connectCalls = []
  }

  async connect(host, port) {
    this.connectCalls.push({ host, port })
    const [clientSocket, serverSocket] = StreamSocket.createPair()
    ;(async () => {
      try {
        while (true) {
          const chunk = await serverSocket.read()
          if (chunk === null) break
          await serverSocket.write(chunk)
        }
      } catch { /* closed */ }
    })()
    return clientSocket
  }
}

// ---------------------------------------------------------------------------
// attachService() unit tests
// ---------------------------------------------------------------------------

describe('mesh-service: attachService()', () => {
  const ALICE = 'alice-pod'
  const BOB = 'bob-pod'

  it('calls descriptor.attach() with a working ctx, and onIncomingData() only fires for matching envelope types', async () => {
    const registryA = createRegistry(ALICE)
    const { nodeA, nodeB } = createNodePair(ALICE, BOB, { registryA })

    const { descriptor, received, getCtx } = createRecordingDescriptor({ envelopeType: 'ping' })
    const handle = attachService(nodeA, undefined, descriptor)

    assert.equal(handle.name, 'recorder')
    assert.equal(handle.backendScheme, null, 'no createBackend on this descriptor -- no backend scheme registered')

    const ctx = getCtx()
    assert.ok(ctx, 'attach() was called')
    assert.equal(ctx.peerNode, nodeA, 'ctx.peerNode is the raw peerNode')
    assert.equal(ctx.registry, registryA, 'ctx.registry is peerNode.registry')
    assert.equal(typeof ctx.onIncomingData, 'function')
    assert.equal(typeof ctx.sendTo, 'function')

    // Matching envelope type: must fire.
    await nodeB.sendTo(ALICE, { type: 'ping', n: 1 })
    await waitFor(() => received.length === 1, 500, 'matching envelope delivered')
    assert.equal(received[0].pubKey, BOB)
    assert.equal(received[0].envelope.n, 1)

    // Non-matching envelope type: must NOT fire.
    await nodeB.sendTo(ALICE, { type: 'pong', n: 2 })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(received.length, 1, 'non-matching envelope type must not reach the callback')

    await handle.teardown()
  })

  it('attach() may return { teardown, api } instead of a bare function; api surfaces on the handle', async () => {
    const registryA = createRegistry(ALICE)
    const { nodeA } = createNodePair(ALICE, BOB, { registryA })

    let torn = false
    const fakeApi = { greet: () => 'hi' }
    const descriptor = {
      name: 'api-shaped',
      attach() {
        return {
          teardown: () => { torn = true },
          api: fakeApi,
        }
      },
    }
    const handle = attachService(nodeA, undefined, descriptor)

    assert.equal(handle.api, fakeApi, 'attachService() surfaces attach()\'s returned api on the handle')
    assert.equal(handle.api.greet(), 'hi')

    await handle.teardown()
    assert.equal(torn, true, 'teardown from the { teardown, api } shape is still invoked')
  })

  it('attach() returning a bare teardown function still works with no api (backward compatible)', async () => {
    const registryA = createRegistry(ALICE)
    const { nodeA } = createNodePair(ALICE, BOB, { registryA })

    const descriptor = {
      name: 'bare-teardown',
      attach() {
        return () => {}
      },
    }
    const handle = attachService(nodeA, undefined, descriptor)
    assert.equal(handle.api, undefined)
    await handle.teardown()
  })

  it('ctx.onIncomingData accepts an array of types', async () => {
    const registryA = createRegistry(ALICE)
    const { nodeA, nodeB } = createNodePair(ALICE, BOB, { registryA })

    const received = []
    const descriptor = {
      name: 'multi-type',
      attach(peerNode, ctx) {
        const unsubscribe = ctx.onIncomingData(['type-a', 'type-b'], (pubKey, envelope) => {
          received.push(envelope.type)
        })
        return unsubscribe
      },
    }
    const handle = attachService(nodeA, undefined, descriptor)

    await nodeB.sendTo(ALICE, { type: 'type-a' })
    await nodeB.sendTo(ALICE, { type: 'type-b' })
    await nodeB.sendTo(ALICE, { type: 'type-c' })
    await waitFor(() => received.length === 2, 500, 'both matching types delivered')
    assert.deepEqual(received.sort(), ['type-a', 'type-b'])

    await handle.teardown()
  })

  it('a rejecting async onIncomingData callback does not become an unhandled promise rejection, and other subscribers still fire', async () => {
    const registryA = createRegistry(ALICE)
    const { nodeA, nodeB } = createNodePair(ALICE, BOB, { registryA })

    const otherReceived = []
    const descriptor = {
      name: 'async-throws',
      attach(peerNode, ctx) {
        const unsubA = ctx.onIncomingData('ping', async () => {
          throw new Error('boom -- simulated failing async handler')
        })
        const unsubB = ctx.onIncomingData('ping', (pubKey, envelope) => {
          otherReceived.push(envelope.type)
        })
        return () => { unsubA(); unsubB() }
      },
    }
    const handle = attachService(nodeA, undefined, descriptor)

    await nodeB.sendTo(ALICE, { type: 'ping' })
    await waitFor(() => otherReceived.length === 1, 500, 'the non-throwing subscriber still received the envelope')
    // If the throwing async callback's rejection were unhandled, Node's
    // test runner would fail this test file with an unhandledRejection --
    // reaching this line at all is the actual assertion.
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(otherReceived, ['ping'])

    await handle.teardown()
  })

  it('ctx.sendTo(pubKey, type, payload) merges { type, ...payload } into the sent envelope', async () => {
    const registryA = createRegistry(ALICE)
    const { nodeA, nodeB } = createNodePair(ALICE, BOB, { registryA })

    const descriptor = {
      name: 'sender',
      attach(peerNode, ctx) {
        ctx.sendTo(BOB, 'greeting', { text: 'hi bob' })
        return () => {}
      },
    }

    const receivedOnB = []
    nodeB.onIncomingData((pubKey, data) => receivedOnB.push({ pubKey, data }))

    const handle = attachService(nodeA, undefined, descriptor)
    await waitFor(() => receivedOnB.length === 1, 500, 'ctx.sendTo delivered to bob')
    assert.deepEqual(receivedOnB[0], { pubKey: ALICE, data: { type: 'greeting', text: 'hi bob' } })

    await handle.teardown()
  })

  it('teardown() actually unsubscribes -- a matching envelope sent after teardown does not fire the callback again', async () => {
    const registryA = createRegistry(ALICE)
    const { nodeA, nodeB } = createNodePair(ALICE, BOB, { registryA })

    const { descriptor, received } = createRecordingDescriptor({ envelopeType: 'ping' })
    const handle = attachService(nodeA, undefined, descriptor)

    await nodeB.sendTo(ALICE, { type: 'ping', n: 1 })
    await waitFor(() => received.length === 1, 500, 'first ping delivered')

    await handle.teardown()

    await nodeB.sendTo(ALICE, { type: 'ping', n: 2 })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(received.length, 1, 'no further callback invocations after teardown()')
  })

  it('a descriptor with createBackend/backendScheme registers a Backend on the supplied VirtualNetwork, connectable via network.connect()', async () => {
    const registryA = createRegistry(ALICE)
    const { nodeA } = createNodePair(ALICE, BOB, { registryA })
    const network = new VirtualNetwork()

    let capturedCtx = null
    const backend = new RecordingBackend()
    const descriptor = {
      name: 'echo-service',
      backendScheme: 'svc-echo',
      attach(peerNode, ctx) {
        return () => {}
      },
      createBackend(ctx) {
        capturedCtx = ctx
        return backend
      },
    }

    const handle = attachService(nodeA, network, descriptor)
    assert.equal(handle.backendScheme, 'svc-echo')
    assert.ok(capturedCtx, 'createBackend() was called with a ctx')
    assert.equal(capturedCtx.network, network)

    const socket = await network.connect('svc-echo://echo-service')
    assert.equal(backend.connectCalls.length, 1)

    await socket.write(enc.encode('hello backend'))
    const echoed = await socket.read()
    assert.equal(dec.decode(echoed), 'hello backend')

    await socket.close()
    await handle.teardown()
    await network.close()
  })

  it('createBackend without a network throws (not a silent no-op)', () => {
    const registryA = createRegistry(ALICE)
    const { nodeA } = createNodePair(ALICE, BOB, { registryA })

    const descriptor = {
      name: 'needs-network',
      attach() { return () => {} },
      createBackend() { return new RecordingBackend() },
    }

    assert.throws(
      () => attachService(nodeA, undefined, descriptor),
      /network/i,
    )
  })

  it('defaults backendScheme to "svc" when a descriptor declares createBackend without an explicit scheme', async () => {
    const registryA = createRegistry(ALICE)
    const { nodeA } = createNodePair(ALICE, BOB, { registryA })
    const network = new VirtualNetwork()

    const descriptor = {
      name: 'default-scheme',
      attach() { return () => {} },
      createBackend() { return new RecordingBackend() },
    }

    const handle = attachService(nodeA, network, descriptor)
    assert.equal(handle.backendScheme, 'svc')

    await handle.teardown()
    await network.close()
  })

  it('throws if descriptor.attach is missing, or descriptor.name is missing', () => {
    const registryA = createRegistry(ALICE)
    const { nodeA } = createNodePair(ALICE, BOB, { registryA })

    assert.throws(() => attachService(nodeA, undefined, { name: 'no-attach' }), /attach/i)
    assert.throws(() => attachService(nodeA, undefined, { attach: () => () => {} }), /name/i)
  })
})

// ---------------------------------------------------------------------------
// createMeshNode({ services }) integration
// ---------------------------------------------------------------------------

describe('mesh-service: createMeshNode({ services })', () => {
  function createStubSignalingTransport() {
    return { send() {}, onMessage() {} }
  }

  it('invokes attach() for each descriptor and exposes node.services for lookup/teardown', async () => {
    const seenPeerNodes = []
    const teardownCalls = []

    const descriptorOne = {
      name: 'service-one',
      attach(peerNode) {
        seenPeerNodes.push(peerNode)
        return () => teardownCalls.push('service-one')
      },
    }
    const descriptorTwo = {
      name: 'service-two',
      attach(peerNode) {
        seenPeerNodes.push(peerNode)
        return () => teardownCalls.push('service-two')
      },
    }

    const node = await createMeshNode({
      label: 'services-test',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
      services: [descriptorOne, descriptorTwo],
    })

    assert.equal(seenPeerNodes.length, 2, 'attach() was called once per descriptor')
    assert.ok(seenPeerNodes.every((n) => n === node), 'attach() received the real constructed PeerNode')

    assert.ok(node.services instanceof Map, 'node.services is a Map for lookup by name')
    assert.equal(node.services.size, 2)
    assert.ok(node.services.has('service-one'))
    assert.ok(node.services.has('service-two'))

    await node.services.get('service-one').teardown()
    assert.deepEqual(teardownCalls, ['service-one'])

    await node.services.get('service-two').teardown()
    assert.deepEqual(teardownCalls.sort(), ['service-one', 'service-two'])
  })

  it('node.services is an empty Map when options.services is omitted', async () => {
    const node = await createMeshNode({
      label: 'no-services-test',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
    })

    assert.ok(node.services instanceof Map)
    assert.equal(node.services.size, 0)
  })

  it('a services entry with createBackend registers onto servicesNetwork', async () => {
    const network = new VirtualNetwork()
    const backend = new RecordingBackend()
    const descriptor = {
      name: 'backend-service',
      backendScheme: 'svc-cs',
      attach() { return () => {} },
      createBackend() { return backend },
    }

    const node = await createMeshNode({
      label: 'backend-services-test',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
      services: [descriptor],
      servicesNetwork: network,
    })

    assert.equal(node.services.get('backend-service').backendScheme, 'svc-cs')
    const socket = await network.connect('svc-cs://backend-service')
    assert.equal(backend.connectCalls.length, 1)
    await socket.close()
    await network.close()
  })
})
