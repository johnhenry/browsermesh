/**
 * Mesh nodes linked over wsh: the peer layer on top of `@johnhenry/browsermesh-transport`'s
 * sealed, key-authenticated wsh links, through an in-process pipe relay (no network).
 *
 * The point: application code is unchanged. `PeerNode.sendTo()` / `onIncomingData()`, mesh-rpc,
 * mesh-sync and mesh-relay all run over the wsh link exactly as over any other transport, and
 * `fromPubKey` is the key wsh authenticated.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/wsh-link.test.mjs
 */
import 'fake-indexeddb/auto'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { createMeshNode } from '../src/mesh-bootstrap.mjs'
import { createMeshRpcService } from '../src/mesh-rpc.mjs'
import { createMeshRelayBackend } from '../src/mesh-relay-backend.mjs'
import { createWshAuthorizer } from '../src/wsh-negotiator.mjs'
import { PeerNode } from '../src/peer-node.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { ManualStrategy } from '@johnhenry/browsermesh-discovery'
import { VirtualNetwork } from '@johnhenry/browsermesh-netway'
import { MeshPeerManager, TrustGraph, MeshACL, MeshIdentityManager, IdentityWallet } from '@johnhenry/browsermesh-core'
import { createInProcessPipeRelay, MeshTransportNegotiator } from '@johnhenry/browsermesh-transport'

const RELAY = 'wss://relay.invalid'
const enc = new TextEncoder()
const dec = new TextDecoder()

async function waitFor(fn, timeoutMs = 4000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

const cleanups = []
afterEach(async () => {
  while (cleanups.length) { try { await cleanups.pop()() } catch { /* best effort */ } }
})

let runId = 0
async function makeNode(env, label, extra = {}) {
  const node = await createMeshNode({
    label,
    signalingTransport: { send() {}, onMessage() {} },
    discoveryStrategies: [new ManualStrategy()],
    wsh: { relays: [RELAY], WebSocket: env.WebSocket, reconnect: { baseMs: 5, maxMs: 25 }, connectTimeoutMs: 3000, ...extra.wsh },
    ...extra.node,
    syncDbName: `wsh-link-${label}-${++runId}-${Date.now()}`,
  })
  cleanups.push(async () => { await node.wsh.links.close(); await node.shutdown(); await node.signaling.close() })
  return node
}

async function pair(extra = {}) {
  const env = await createInProcessPipeRelay()
  cleanups.push(() => env.close())
  const alice = await makeNode(env, 'alice', extra.alice)
  const bob = await makeNode(env, 'bob', extra.bob)
  return { env, alice, bob }
}

describe('createWshAuthorizer', () => {
  function registryFor(podId) {
    return new PeerRegistry({ localPodId: podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: podId }) })
  }
  it('denies everyone until the registry grants mesh:link:connect, and denies again once revoked', () => {
    const registry = registryFor('local-pod')
    const authorize = createWshAuthorizer(registry)
    assert.equal(authorize({ podId: 'peer-x' }), false)
    registry.grantCapabilities('peer-x', ['mesh:link:connect'])
    assert.equal(authorize({ podId: 'peer-x' }), true)
    assert.equal(authorize({ podId: 'peer-y' }), false, 'a grant is per peer')
    registry.revokeCapabilities('peer-x', ['mesh:link:connect'])
    assert.equal(authorize({ podId: 'peer-x' }), false)
  })

  it('does not treat a grant for something else as permission to link', () => {
    const registry = registryFor('local-pod')
    registry.grantCapabilities('peer-x', ['mesh-relay:s3:connect'])
    assert.equal(createWshAuthorizer(registry)({ podId: 'peer-x' }), false)
  })

  it('can require the peer to be known to the registry as well', () => {
    const registry = registryFor('local-pod')
    registry.grantCapabilities('peer-x', ['mesh:link:connect'])
    const strict = createWshAuthorizer(registry, { requireKnownPeer: true })
    assert.equal(strict({ podId: 'peer-x' }), false)
    registry.addPeer('peer-x', 'x')
    assert.equal(strict({ podId: 'peer-x' }), true)
  })
})

describe('mesh nodes over a wsh link', () => {
  it('connectToPeer links the nodes; both sides get a session under the authenticated key', async () => {
    const { alice, bob } = await pair()
    bob.registry.grantCapabilities(alice.podId, ['mesh:link:connect'])
    const session = await alice.connectToPeer(bob.podId, { wsh: bob.podId })
    assert.equal(session.transport, 'wsh')
    assert.equal(session.pubKey, bob.podId)
    await waitFor(() => bob.hasActiveSession(alice.podId), 4000, "bob's inbound session")
    assert.equal(bob.sessionsFor(alice.podId)[0].transport, 'wsh')
  })

  it('carries raw PeerNode data both ways, with fromPubKey the authenticated key', async () => {
    const { alice, bob } = await pair()
    bob.registry.grantCapabilities(alice.podId, ['mesh:link:connect'])
    const atBob = []
    const atAlice = []
    bob.onIncomingData((from, data) => atBob.push({ from, data }))
    alice.onIncomingData((from, data) => atAlice.push({ from, data }))
    await alice.connectToPeer(bob.podId, { wsh: bob.podId })
    await waitFor(() => bob.hasActiveSession(alice.podId))
    await alice.sendTo(bob.podId, { type: 'hello', from: 'someone-else' })
    await bob.sendTo(alice.podId, 'plain text')
    await bob.sendTo(alice.podId, new Uint8Array([7, 8, 9]), { channel: 'bulk' })
    await waitFor(() => atBob.length === 1 && atAlice.length === 2)
    assert.equal(atBob[0].from, alice.podId, 'the sender is the session key, not the envelope field')
    assert.deepEqual(JSON.parse(atBob[0].data), { type: 'hello', from: 'someone-else' })
    assert.equal(atAlice[0].from, bob.podId)
    assert.equal(atAlice[0].data, 'plain text')
    assert.deepEqual([...atAlice[1].data], [7, 8, 9])
  })

  it('runs mesh-rpc, mesh-sync and mesh-relay over the one link, application code unchanged', async () => {
    const aliceNet = new VirtualNetwork()
    cleanups.push(() => aliceNet.close())
    const echo = await aliceNet.listen('mem://localhost:9777')
    ;(async () => {
      for (;;) {
        const sock = await echo.accept()
        if (!sock) break
        ;(async () => { try { for (;;) { const c = await sock.read(); if (c === null) break; await sock.write(c) } } catch { /* closed */ } })()
      }
    })()

    const { alice, bob } = await pair({
      alice: {
        node: {
          enableSync: true,
          enableRelayHost: true,
          relayHostNetwork: aliceNet,
          relayHostServices: { echo: 'mem://localhost:9777' },
          services: [createMeshRpcService({ onRequest: async ({ fromPubKey, body }) => ({ status: 200, body: { from: fromPubKey, got: body } }) })],
        },
      },
      bob: {
        node: {
          enableSync: true,
          services: [createMeshRpcService({ onRequest: async ({ body }) => ({ status: 200, body: { pong: body } }) })],
        },
      },
    })
    bob.registry.grantCapabilities(alice.podId, ['mesh:link:connect'])
    alice.registry.grantCapabilities(bob.podId, ['mesh-relay:echo:connect'])

    await alice.connectToPeer(bob.podId, { wsh: bob.podId })
    await waitFor(() => bob.hasActiveSession(alice.podId))

    // mesh-rpc, both directions (the responder is also a requester)
    const rpcA = alice.services.get('mesh-rpc').api
    const rpcB = bob.services.get('mesh-rpc').api
    const r1 = await rpcA.request(bob.podId, { method: 'POST', path: '/x', body: { n: 1 } })
    assert.deepEqual(r1.body, { pong: { n: 1 } })
    const r2 = await rpcB.request(alice.podId, { method: 'POST', path: '/y', body: { n: 2 } })
    assert.deepEqual(r2.body, { from: bob.podId, got: { n: 2 } })

    // mesh-sync, both directions
    alice.sync.engine.create('notes', 'lww-map')
    alice.sync.engine.update('notes', (m) => m.set('title', 'from alice', Date.now(), alice.podId))
    await alice.sync.syncDocWithPeer(bob.podId, 'notes')
    await waitFor(() => bob.sync.engine.getState('notes')?.title === 'from alice', 4000, "bob's engine to observe alice's edit")
    bob.sync.engine.update('notes', (m) => m.set('status', 'seen by bob', Date.now(), bob.podId))
    await bob.sync.syncDocWithPeer(alice.podId, 'notes')
    await waitFor(() => alice.sync.engine.getState('notes')?.status === 'seen by bob', 4000, "alice's engine to observe bob's edit")
    assert.deepEqual(alice.sync.engine.getState('notes'), bob.sync.engine.getState('notes'))

    // mesh-relay: bob reaches alice's local service through the link
    const bobNet = new VirtualNetwork()
    cleanups.push(() => bobNet.close())
    const backend = createMeshRelayBackend({ node: bob, relayPeerPubKey: alice.podId })
    bobNet.addBackend('via-alice', backend)
    const sock = await bobNet.connect('via-alice://echo')
    await sock.write(enc.encode('through a sealed link'))
    assert.equal(dec.decode(await sock.read()), 'through a sealed link')
    await sock.close()
    await backend.close()
  })

  it('a peer the registry has not granted is refused before any mesh frame, and has no session', async () => {
    const { alice, bob } = await pair()
    const frames = []
    bob.onIncomingData((from, data) => frames.push({ from, data }))
    await assert.rejects(alice.wsh.links.connect(bob.podId), (e) => e.code === 'WSH_REFUSED' && e.reason === 'unauthorized')
    assert.equal(bob.hasActiveSession(alice.podId), false)
    assert.equal(bob.wsh.links.isConnected(alice.podId), false)
    assert.deepEqual(frames, [])
  })

  it('require: a failing wsh link is a failed connect, never a session on something else', async () => {
    const { alice, bob } = await pair({ alice: { wsh: { require: true } } })
    // Bob grants nothing, so the wsh link is refused. With `require`, connectToPeer must not fall through.
    await assert.rejects(alice.connectToPeer(bob.podId, { wsh: bob.podId, webrtc: bob.podId }), (e) => e.code === 'WSH_REFUSED')
    assert.equal(alice.hasActiveSession(bob.podId), false)
    assert.equal(alice.registry.listPeers({ status: 'connected' }).some((p) => p.fingerprint === bob.podId), false)
  })

  it('wsh is off unless asked for: no wsh option, no wsh adapter, nothing listening', async () => {
    const node = await createMeshNode({
      label: 'plain',
      signalingTransport: { send() {}, onMessage() {} },
      discoveryStrategies: [new ManualStrategy()],
      syncDbName: `wsh-link-plain-${Date.now()}`,
    })
    cleanups.push(async () => { await node.shutdown(); await node.signaling.close() })
    assert.equal(node.wsh, undefined)
    assert.equal(node.transportNegotiator.availableTypes().includes('wsh'), false)
  })

  it('the link comes back after the relay drops, and the sessions keep working', async () => {
    const { env, alice, bob } = await pair()
    bob.registry.grantCapabilities(alice.podId, ['mesh:link:connect'])
    const atBob = []
    bob.onIncomingData((from, data) => atBob.push(data))
    await alice.connectToPeer(bob.podId, { wsh: bob.podId })
    await waitFor(() => bob.hasActiveSession(alice.podId))
    env.dropAll()
    await waitFor(() => !alice.wsh.links.isConnected(bob.podId), 4000, 'the drop to be noticed')
    await waitFor(() => alice.wsh.links.isConnected(bob.podId) && bob.wsh.links.isConnected(alice.podId), 8000, 'the link to come back')
    await alice.sendTo(bob.podId, 'after the drop')
    await waitFor(() => atBob.includes('after the drop'))
  })
})

describe('PeerNode with a required transport', () => {
  async function bareNode(negotiator) {
    const identityManager = new MeshIdentityManager({})
    const wallet = new IdentityWallet({ identityManager })
    const { podId } = await wallet.createIdentity('n')
    const registry = new PeerRegistry({ localPodId: podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: podId }) })
    const node = new PeerNode({ wallet, registry, transportNegotiator: negotiator })
    await node.boot({ skipDiscovery: true })
    return node
  }

  it('rethrows the negotiation failure instead of falling through to a transportless session', async () => {
    const n = new MeshTransportNegotiator({ require: 'wsh' })
    n.registerAdapter('wsh', async () => { throw new Error('no sealed link') })
    const node = await bareNode(n)
    await assert.rejects(node.connectToPeer('some-pod', { wsh: 'some-pod' }), /no sealed link/)
    assert.equal(node.hasActiveSession('some-pod'), false)
  })

  it('without `require`, behaviour is as before: the failure is logged and the registry connection stands', async () => {
    const n = new MeshTransportNegotiator({ preferenceOrder: ['wsh'] })
    n.registerAdapter('wsh', async () => { throw new Error('no link') })
    const node = await bareNode(n)
    const session = await node.connectToPeer('some-pod', { wsh: 'some-pod' })
    assert.equal(session.transport, null)
  })
})
