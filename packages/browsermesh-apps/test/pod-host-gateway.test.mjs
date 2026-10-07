/**
 * Tests for pod-host-gateway.mjs -- issue #185 control-surface item 3's
 * Node HTTP gateway so the pod-host verbs can be driven from outside the
 * mesh over plain HTTP, using the gateway's own mesh identity.
 *
 * Layers:
 *   - `createPodHostGatewayHandler()` driven directly (no real `node:http`):
 *     auth rejected -> 401, unknown host -> 404, `GET /hosts`.
 *   - the full lifecycle through `serveNodeGateway()` on an ephemeral port,
 *     exercised with Node's global `fetch()`, authorized with a bearer
 *     token (the "operator's own auth scheme" example the module doc
 *     comment promises).
 *
 * Setup follows `pod-host-service.test.mjs`'s pattern: real Ed25519
 * identities, real `PeerRegistry`/`MeshACL`, a minimal duck-typed mesh bus.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/pod-host-gateway.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'
import { InMemoryPodHostDriver, POD_LANE, POD_LIFECYCLE } from '@johnhenry/browsermesh-pod'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createPodHostService, createPodHostClient, DEFAULT_POD_HOST_RESOURCE } from '../src/pod-host-service.mjs'
import { createPodHostGatewayHandler, serveNodeGateway } from '../src/pod-host-gateway.mjs'

const RESOURCE = DEFAULT_POD_HOST_RESOURCE
const ALL_SCOPES = ['spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list']
  .map((verb) => `${RESOURCE}:${verb}`)

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

/** Same minimal duck-typed mesh bus `pod-host-service.test.mjs` uses. */
function wireMesh(peers) {
  const listeners = new Map()
  const nodes = new Map()
  for (const peer of peers) {
    listeners.set(peer.podId, new Set())
    nodes.set(peer.podId, {
      podId: peer.podId,
      wallet: peer.wallet,
      registry: peer.registry,
      onIncomingData(cb) {
        listeners.get(peer.podId).add(cb)
        return () => listeners.get(peer.podId).delete(cb)
      },
      async sendTo(pubKey, data) {
        const target = listeners.get(pubKey)
        if (!target) throw new Error(`no such peer: ${pubKey}`)
        queueMicrotask(() => {
          for (const cb of [...target]) cb(peer.podId, data)
        })
      },
    })
  }
  return nodes
}

function minimalSpec(overrides = {}) {
  return { name: 'alpha', lane: POD_LANE.NODE, run: { kind: 'command', ref: '/bin/echo' }, ...overrides }
}

/** Build alice-as-host + gateway-as-mesh-operator, granted every verb. */
async function buildHostAndGatewayClient() {
  const alice = await createPeer('alice') // host
  const gatewayPeer = await createPeer('gateway') // the gateway's own mesh identity
  const nodes = wireMesh([alice, gatewayPeer])
  const nodeAlice = nodes.get(alice.podId)
  const nodeGateway = nodes.get(gatewayPeer.podId)

  const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
  const hostHandle = attachService(nodeAlice, undefined, createPodHostService({ driver, hostLabel: 'alice-laptop' }))
  alice.registry.grantCapabilities(gatewayPeer.podId, ALL_SCOPES)

  const client = createPodHostClient({ peerNode: nodeGateway, timeoutMs: 5000 })
  return { alice, gatewayPeer, hostHandle, client }
}

const BEARER_TOKEN = 'operator-secret-token'
/** The "bearer token example" the module doc comment promises. */
function bearerAuth(req) {
  const header = req.headers.get('authorization') || ''
  if (header === `Bearer ${BEARER_TOKEN}`) return { ok: true, pubKey: 'operator' }
  return { ok: false }
}

// ---------------------------------------------------------------------------
// createPodHostGatewayHandler: argument validation
// ---------------------------------------------------------------------------

describe('createPodHostGatewayHandler: argument validation', () => {
  it('requires client or peerNode', () => {
    assert.throws(() => createPodHostGatewayHandler({ auth: () => ({ ok: true }) }), /client/)
  })

  it('requires auth', () => {
    assert.throws(() => createPodHostGatewayHandler({ client: { spawn() {} } }), /auth/)
  })
})

// ---------------------------------------------------------------------------
// Handler driven directly (no real node:http)
// ---------------------------------------------------------------------------

describe('createPodHostGatewayHandler: handler behavior', () => {
  it('unauthorized -> 401, never reaching resolveHost/the mesh', async () => {
    const { client } = await buildHostAndGatewayClient()
    let resolveCalls = 0
    const handler = createPodHostGatewayHandler({
      client,
      resolveHost: () => { resolveCalls += 1; return null },
      auth: () => ({ ok: false }),
    })
    const res = await handler(new Request('http://gateway.local/hosts/alice/pods'))
    assert.equal(res.status, 401)
    assert.equal(resolveCalls, 0)
  })

  it('unknown host -> 404', async () => {
    const { client } = await buildHostAndGatewayClient()
    const handler = createPodHostGatewayHandler({
      client,
      resolveHost: () => null,
      auth: () => ({ ok: true }),
    })
    const res = await handler(new Request('http://gateway.local/hosts/nobody/pods'))
    assert.equal(res.status, 404)
  })

  it('unknown route -> 404', async () => {
    const { client } = await buildHostAndGatewayClient()
    const handler = createPodHostGatewayHandler({
      client,
      resolveHost: () => 'whatever',
      auth: () => ({ ok: true }),
    })
    const res = await handler(new Request('http://gateway.local/hosts/alice/not-a-route'))
    assert.equal(res.status, 404)
  })

  it('GET /hosts lists hosts from a resolveHost map, with no auth required', async () => {
    const { client } = await buildHostAndGatewayClient()
    let authCalled = false
    const handler = createPodHostGatewayHandler({
      client,
      resolveHost: { alice: 'alice-pubkey', bob: 'bob-pubkey' },
      auth: () => { authCalled = true; return { ok: true } },
    })
    const res = await handler(new Request('http://gateway.local/hosts'))
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.deepEqual([...body.result].sort(), ['alice', 'bob'])
    assert.equal(authCalled, false)
  })

  it('full lifecycle through the handler directly: spawn (201) -> status -> exec -> snapshot -> restore -> drain (204)', async () => {
    const { alice, client } = await buildHostAndGatewayClient()
    const handler = createPodHostGatewayHandler({
      client,
      resolveHost: { alice: alice.podId },
      auth: bearerAuth,
    })
    const authed = (path, init) => handler(new Request(`http://gateway.local${path}`, {
      ...init,
      headers: { ...(init?.headers || {}), authorization: `Bearer ${BEARER_TOKEN}` },
    }))

    const spawnRes = await authed('/hosts/alice/pods', { method: 'POST', body: JSON.stringify(minimalSpec()) })
    assert.equal(spawnRes.status, 201)
    const spawned = (await spawnRes.json()).result
    assert.equal(spawned.state, POD_LIFECYCLE.REGISTERED)

    const statusRes = await authed('/hosts/alice/pods/alpha')
    assert.equal(statusRes.status, 200)
    assert.equal((await statusRes.json()).result.state, POD_LIFECYCLE.REGISTERED)

    const execRes = await authed('/hosts/alice/pods/alpha/exec', {
      method: 'POST',
      body: JSON.stringify({ command: ['echo', 'hi'] }),
    })
    assert.equal(execRes.status, 200)
    assert.equal((await execRes.json()).result.code, 0)

    const snapshotRes = await authed('/hosts/alice/pods/alpha/snapshot', { method: 'POST' })
    assert.equal((await snapshotRes.json()).result.state, POD_LIFECYCLE.SNAPSHOTTED)

    const restoreRes = await authed('/hosts/alice/pods/alpha/restore', { method: 'POST' })
    assert.equal((await restoreRes.json()).result.state, POD_LIFECYCLE.REGISTERED)

    const describeRes = await authed('/hosts/alice/host')
    assert.equal(describeRes.status, 200)
    assert.equal((await describeRes.json()).result.lane, POD_LANE.NODE)

    const drainRes = await authed('/hosts/alice/pods/alpha?cascade=true', { method: 'DELETE' })
    assert.equal(drainRes.status, 204)
    assert.equal(await drainRes.text(), '')

    const afterDrainRes = await authed('/hosts/alice/pods/alpha')
    assert.equal((await afterDrainRes.json()).result.state, POD_LIFECYCLE.GONE)
  })

  it('a remote EACCES denial surfaces as 403', async () => {
    const alice = await createPeer('alice')
    const stranger = await createPeer('stranger')
    const nodes = wireMesh([alice, stranger])
    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    attachService(nodes.get(alice.podId), undefined, createPodHostService({ driver }))
    // stranger granted nothing
    const client = createPodHostClient({ peerNode: nodes.get(stranger.podId), timeoutMs: 5000 })

    const handler = createPodHostGatewayHandler({
      client,
      resolveHost: { alice: alice.podId },
      auth: () => ({ ok: true }),
    })
    const res = await handler(new Request('http://gateway.local/hosts/alice/pods', { method: 'POST', body: JSON.stringify(minimalSpec()) }))
    assert.equal(res.status, 403)
  })
})

// ---------------------------------------------------------------------------
// serveNodeGateway: real node:http, real fetch()
// ---------------------------------------------------------------------------

describe('serveNodeGateway', () => {
  it('serves the handler over a real node:http server on an ephemeral port, driven with global fetch()', async () => {
    const { alice, client } = await buildHostAndGatewayClient()
    const handler = createPodHostGatewayHandler({
      client,
      resolveHost: { alice: alice.podId },
      auth: bearerAuth,
    })

    const gateway = await serveNodeGateway({ handler, port: 0, host: '127.0.0.1' })
    assert.ok(gateway.port > 0)

    try {
      const unauthed = await fetch(`${gateway.url}/hosts/alice/pods`)
      assert.equal(unauthed.status, 401)

      const spawnRes = await fetch(`${gateway.url}/hosts/alice/pods`, {
        method: 'POST',
        headers: { authorization: `Bearer ${BEARER_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(minimalSpec({ name: 'nodehttp' })),
      })
      assert.equal(spawnRes.status, 201)
      const spawned = (await spawnRes.json()).result
      assert.equal(spawned.name, 'nodehttp')

      const execRes = await fetch(`${gateway.url}/hosts/alice/pods/nodehttp/exec`, {
        method: 'POST',
        headers: { authorization: `Bearer ${BEARER_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ command: ['echo', 'over-http'] }),
      })
      assert.equal(execRes.status, 200)
      assert.equal((await execRes.json()).result.stdout, 'echo over-http')

      const drainRes = await fetch(`${gateway.url}/hosts/alice/pods/nodehttp`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      })
      assert.equal(drainRes.status, 204)

      const hostsRes = await fetch(`${gateway.url}/hosts`)
      assert.equal(hostsRes.status, 200)
      assert.deepEqual((await hostsRes.json()).result, ['alice'])

      const unknownHostRes = await fetch(`${gateway.url}/hosts/nope/pods`, {
        headers: { authorization: `Bearer ${BEARER_TOKEN}` },
      })
      assert.equal(unknownHostRes.status, 404)
    } finally {
      await gateway.close()
    }
  })
})
