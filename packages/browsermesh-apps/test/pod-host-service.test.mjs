/**
 * Tests for pod-host-service.mjs -- the gated, audited mesh service that
 * speaks `@johnhenry/browsermesh-pod`'s pod host protocol (issue #185's
 * hosted-pods control surface, item 2).
 *
 * Setup follows this family's established pattern (mesh-kv.test.mjs,
 * grant-log.test.mjs, manifest-sync.test.mjs): real Ed25519 identities via
 * `IdentityWallet`/`MeshIdentityManager`, real `PeerRegistry`s over real
 * `MeshACL`, wired to each other with the same minimal duck-typed
 * `sendTo`/`onIncomingData` bus those files use -- real enough that
 * `checkAccess()` is genuinely enforced, without needing WebRTC.
 *
 * Layers:
 *   - the host service: every verb end to end, the EACCES path, EINVAL,
 *     ELANE, event forwarding, audit records
 *   - the client: correlation, timeout, close()
 *   - `MeshOrchestrator`'s `spawnPod`/`snapshotPod`/`restorePod`/
 *     `listHostedPods` and the placement audit records they write
 *   - the two lane driver adapters (the spikes' `src/driver.mjs`) against fakes
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/pod-host-service.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'
import {
  InMemoryPodHostDriver,
  POD_HOST_ERROR,
  POD_HOST_EVENT_KIND,
  POD_LANE,
  POD_LIFECYCLE,
} from '@johnhenry/browsermesh-pod'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import {
  createPodHostService,
  createPodHostClient,
  podHostRuntimePeer,
  DEFAULT_POD_HOST_RESOURCE,
} from '../src/pod-host-service.mjs'
import { MeshOrchestrator, PLACEMENT_AUDIT } from '../src/orchestrator.mjs'

const RESOURCE = DEFAULT_POD_HOST_RESOURCE
const ALL_SCOPES = [
  'spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list',
].map((verb) => `${RESOURCE}:${verb}`)

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
 * A minimal duck-typed `PeerNode` mesh: every peer can `sendTo()` every
 * other, and `onIncomingData()` sees whatever was sent to it. Same shape
 * `mesh-kv.test.mjs`'s `wireNodes()` builds, generalized past two peers.
 */
function wireMesh(peers) {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()
  /** @type {Map<string, object>} */
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

/** A fake `AuditChain`, recording what was appended instead of hashing it. */
function fakeAuditChain() {
  /** @type {object[]} */
  const entries = []
  return {
    entries,
    async append(authorPodId, operation, data) {
      entries.push({ authorPodId, operation, data })
    },
    operations() {
      return entries.map((entry) => entry.operation)
    },
  }
}

/** A fake `auditRecorder`, matching what `MeshOrchestrator` calls. */
function fakeAuditRecorder() {
  /** @type {object[]} */
  const records = []
  return {
    records,
    async record(operation, data) {
      records.push({ operation, data })
    },
    operations() {
      return records.map((record) => record.operation)
    },
  }
}

function minimalSpec(overrides = {}) {
  return { name: 'alpha', lane: POD_LANE.NODE, run: { kind: 'command', ref: '/bin/echo' }, ...overrides }
}

// ---------------------------------------------------------------------------
// Host service
// ---------------------------------------------------------------------------

describe('createPodHostService: argument validation', () => {
  it('requires a driver with a lane and capabilities()', () => {
    assert.throws(() => createPodHostService(), /driver is required/)
    assert.throws(() => createPodHostService({ driver: {} }), /driver.lane is required/)
    assert.throws(() => createPodHostService({ driver: { lane: 'node' } }), /capabilities\(\) is required/)
  })
})

describe('createPodHostService: the eight verbs over the mesh', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodes
  /** @type {any} */ let handle
  /** @type {any} */ let client
  /** @type {any} */ let driver
  /** @type {any} */ let auditChain

  beforeEach(async () => {
    alice = await createPeer('alice-host')
    bob = await createPeer('bob-requester')
    nodes = wireMesh([alice, bob])
    driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    auditChain = fakeAuditChain()
    handle = attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver, auditChain, hostLabel: 'alice-host',
    }))
    // alice grants bob every verb on her pod host.
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })
  })

  it('spawns, statuses, sends, execs, snapshots, restores, drains and lists', async () => {
    const spawned = await client.spawn(alice.podId, minimalSpec())
    assert.equal(spawned.name, 'alpha')
    assert.equal(spawned.state, POD_LIFECYCLE.REGISTERED)

    assert.equal((await client.status(alice.podId, 'alpha')).state, POD_LIFECYCLE.REGISTERED)
    assert.deepEqual(await client.send(alice.podId, 'alpha', { hi: true }), { delivered: true, inbox: 1 })
    assert.deepEqual(await client.exec(alice.podId, 'alpha', ['echo', 'hi']), {
      stdout: 'echo hi', stderr: '', code: 0,
    })
    assert.equal((await client.snapshot(alice.podId, 'alpha')).state, POD_LIFECYCLE.SNAPSHOTTED)
    assert.equal((await client.restore(alice.podId, 'alpha')).state, POD_LIFECYCLE.REGISTERED)

    const listed = await client.list(alice.podId)
    assert.deepEqual(listed.map((pod) => pod.name), ['alpha'])

    assert.equal((await client.drain(alice.podId, 'alpha', { cascade: true })).state, POD_LIFECYCLE.GONE)
  })

  it('normalizes the payload host-side before the driver sees it', async () => {
    await client.spawn(alice.podId, { name: 'beta', lane: 'node', run: { kind: 'command', ref: 'x' } })
    // A string command reaches the driver as a single-element argv.
    assert.equal((await client.exec(alice.podId, 'beta', 'uptime')).stdout, 'uptime')
    // restart.policy was defaulted by validatePodSpec(), host-side.
    assert.equal((await client.status(alice.podId, 'beta')).spec.restart.policy, 'never')
  })

  it('answers describe() without a grant, with the lane, verbs and deployment support', async () => {
    const stranger = await createPeer('stranger')
    const mesh = wireMesh([alice, stranger])
    attachService(mesh.get(alice.podId), undefined, createPodHostService({ driver, hostLabel: 'alice-host' }))
    const strangerClient = createPodHostClient({ peerNode: mesh.get(stranger.podId), timeoutMs: 1000 })

    const description = await strangerClient.describe(alice.podId)
    assert.equal(description.lane, POD_LANE.NODE)
    assert.equal(description.podId, alice.podId)
    assert.deepEqual(description.runtimeClasses, [POD_LANE.NODE])
    assert.equal(description.shellBackend, 'pty')
    assert.deepEqual(description.deploymentSupport, { canDeploy: true })
    assert.equal(description.verbs.length, 8)
    assert.equal(description.hostLabel, 'alice-host')
    // ...but the stranger still cannot actually spawn anything.
    await assert.rejects(
      strangerClient.spawn(alice.podId, minimalSpec()),
      (err) => err.code === POD_HOST_ERROR.EACCES,
    )
    strangerClient.close()
  })

  it('rejects an invalid podspec with EINVAL listing every problem', async () => {
    await assert.rejects(client.spawn(alice.podId, { name: 'bad name' }), (err) => {
      assert.equal(err.code, POD_HOST_ERROR.EINVAL)
      assert.match(err.message, /run is required/)
      return true
    })
  })

  it('surfaces driver errors with their own codes', async () => {
    await assert.rejects(client.status(alice.podId, 'ghost'), (err) => err.code === POD_HOST_ERROR.ENOENT)
    await client.spawn(alice.podId, minimalSpec())
    await assert.rejects(client.spawn(alice.podId, minimalSpec()), (err) => err.code === POD_HOST_ERROR.EEXIST)
  })

  it('writes the placement audit trail for a spawn', async () => {
    await client.spawn(alice.podId, minimalSpec())
    assert.deepEqual(auditChain.operations(), [
      PLACEMENT_AUDIT.REQUESTED, PLACEMENT_AUDIT.STARTED, PLACEMENT_AUDIT.READY,
    ])
    assert.equal(auditChain.entries[0].authorPodId, alice.podId)
    assert.equal(auditChain.entries[2].data.name, 'alpha')
    assert.equal(auditChain.entries[2].data.lane, POD_LANE.NODE)
  })

  it('writes placement_evicted for drain and snapshot', async () => {
    await client.spawn(alice.podId, minimalSpec())
    await client.snapshot(alice.podId, 'alpha')
    await client.restore(alice.podId, 'alpha')
    await client.drain(alice.podId, 'alpha')
    const evictions = auditChain.entries.filter((entry) => entry.operation === PLACEMENT_AUDIT.EVICTED)
    assert.deepEqual(evictions.map((entry) => entry.data.verb), ['snapshot', 'drain'])
  })

  it('emits request/completed observability events', async () => {
    /** @type {object[]} */
    const seen = []
    handle.onEvent((event, data) => seen.push({ event, data }))
    await client.spawn(alice.podId, minimalSpec())
    const names = seen.map((entry) => entry.event)
    assert.ok(names.includes('pod-host:request'))
    assert.ok(names.includes('pod-host:completed'))
    assert.ok(names.includes('pod-host:event'))
  })

  it('forwards driver lifecycle events to the requester that owns the pod', async () => {
    /** @type {object[]} */
    const received = []
    client.onEvent((hostPubKey, event) => received.push({ hostPubKey, event }))

    await client.spawn(alice.podId, minimalSpec())
    await client.exec(alice.podId, 'alpha', ['echo', 'hi'])
    await client.drain(alice.podId, 'alpha')
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.ok(received.length > 0)
    assert.ok(received.every((entry) => entry.hostPubKey === alice.podId))
    const kinds = new Set(received.map((entry) => entry.event.kind))
    assert.ok(kinds.has(POD_HOST_EVENT_KIND.LIFECYCLE))
    assert.ok(kinds.has(POD_HOST_EVENT_KIND.LOG))
    assert.ok(kinds.has(POD_HOST_EVENT_KIND.EXIT))
    const lifecycle = received
      .filter((entry) => entry.event.kind === POD_HOST_EVENT_KIND.LIFECYCLE)
      .map((entry) => `${entry.event.data.from}->${entry.event.data.to}`)
    assert.ok(lifecycle.includes('cold->booting'))
    assert.ok(lifecycle.includes('draining->gone'))
  })

  it('does not forward events for pods the requester never addressed', async () => {
    /** @type {object[]} */
    const received = []
    client.onEvent((hostPubKey, event) => received.push(event))
    // Spawned directly on the driver, so no requester is interested in it.
    await driver.spawn({ name: 'orphan', lane: 'node', run: { kind: 'command', ref: 'x' } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(received, [])
  })

  it('stops serving after teardown', async () => {
    await handle.teardown()
    await assert.rejects(client.list(alice.podId), (err) => err.code === POD_HOST_ERROR.ETIMEDOUT)
  })
})

describe('createPodHostService: access control', () => {
  it('denies an ungranted peer with EACCES and emits pod-host:denied', async () => {
    const alice = await createPeer('alice-host')
    const carol = await createPeer('carol-stranger')
    const nodes = wireMesh([alice, carol])
    const auditChain = fakeAuditChain()
    const handle = attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.NODE }),
      auditChain,
    }))
    /** @type {object[]} */
    const denials = []
    handle.on('pod-host:denied', (data) => denials.push(data))

    const client = createPodHostClient({ peerNode: nodes.get(carol.podId), timeoutMs: 1000 })
    await assert.rejects(client.spawn(alice.podId, minimalSpec()), (err) => {
      assert.equal(err.code, POD_HOST_ERROR.EACCES)
      assert.match(err.message, /pod-host:spawn/)
      return true
    })

    assert.equal(denials.length, 1)
    assert.equal(denials[0].from, carol.podId)
    assert.equal(denials[0].verb, 'spawn')
    assert.deepEqual(auditChain.operations(), [PLACEMENT_AUDIT.REQUESTED, PLACEMENT_AUDIT.DENIED])
    client.close()
  })

  it('gates each verb independently', async () => {
    const alice = await createPeer('alice-host')
    const bob = await createPeer('bob-partial')
    const nodes = wireMesh([alice, bob])
    attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.NODE }),
    }))
    alice.registry.grantCapabilities(bob.podId, [`${RESOURCE}:spawn`, `${RESOURCE}:status`])

    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })
    await client.spawn(alice.podId, minimalSpec())
    assert.equal((await client.status(alice.podId, 'alpha')).name, 'alpha')
    await assert.rejects(
      client.exec(alice.podId, 'alpha', ['ls']),
      (err) => err.code === POD_HOST_ERROR.EACCES,
    )
    client.close()
  })

  it('checks a custom resource when one is configured', async () => {
    const alice = await createPeer('alice-host')
    const bob = await createPeer('bob-tenant')
    const nodes = wireMesh([alice, bob])
    attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.NODE }),
      resource: 'pod-host:tenant-a',
    }))
    alice.registry.grantCapabilities(bob.podId, [`${RESOURCE}:spawn`])
    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })
    await assert.rejects(client.spawn(alice.podId, minimalSpec()), (err) => err.code === POD_HOST_ERROR.EACCES)

    alice.registry.grantCapabilities(bob.podId, ['pod-host:tenant-a:spawn'])
    assert.equal((await client.spawn(alice.podId, minimalSpec())).name, 'alpha')
    client.close()
  })
})

describe('createPodHostService: lanes', () => {
  it('answers exec/snapshot/restore with ELANE on an isolate-lane host', async () => {
    const alice = await createPeer('alice-isolate-host')
    const bob = await createPeer('bob')
    const nodes = wireMesh([alice, bob])
    attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.ISOLATE }),
    }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })

    await client.spawn(alice.podId, { name: 'alpha', run: { kind: 'skill', ref: 'greeter' } })
    for (const call of [
      () => client.exec(alice.podId, 'alpha', ['ls']),
      () => client.snapshot(alice.podId, 'alpha'),
      () => client.restore(alice.podId, 'alpha'),
    ]) {
      await assert.rejects(call(), (err) => {
        assert.equal(err.code, POD_HOST_ERROR.ELANE)
        assert.match(err.message, /lane 'isolate' cannot/)
        return true
      })
    }
    const description = await client.describe(alice.podId)
    assert.equal(description.shellBackend, null)
    assert.deepEqual(description.verbs, ['spawn', 'status', 'send', 'drain', 'list'])
    client.close()
  })

  it('answers ENOTSUP when the lane could but the driver does not implement the verb', async () => {
    const alice = await createPeer('alice-partial-host')
    const bob = await createPeer('bob')
    const nodes = wireMesh([alice, bob])
    attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.MICROVM, verbs: ['spawn', 'status', 'list'] }),
    }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })
    await client.spawn(alice.podId, minimalSpec({ lane: POD_LANE.MICROVM }))
    await assert.rejects(
      client.exec(alice.podId, 'alpha', ['ls']),
      (err) => err.code === POD_HOST_ERROR.ENOTSUP,
    )
    client.close()
  })
})

describe('podHostRuntimePeer', () => {
  it('produces the shape runtimePeerToComputeDescriptor() reads', async () => {
    const alice = await createPeer('alice-host')
    const nodes = wireMesh([alice])
    const handle = attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.MICROVM }),
    }))
    const peer = handle.api.runtimePeer({ resources: { cpu: 4 } })
    assert.equal(peer.identity.podId, alice.podId)
    assert.deepEqual(peer.metadata.runtimeClasses, [POD_LANE.MICROVM])
    assert.equal(peer.metadata.deploymentSupport.canDeploy, true)
    assert.equal(peer.shellBackend, 'vm-console')
    assert.ok(peer.capabilities.includes('exec'))
    assert.deepEqual(peer.metadata.resources, { cpu: 4 })
  })

  it('omits shellBackend and exec for an isolate host (no compute descriptor today)', async () => {
    const description = {
      podId: 'pod-1', lane: POD_LANE.ISOLATE, verbs: ['spawn', 'list'],
      runtimeClasses: [POD_LANE.ISOLATE], shellBackend: null,
      deploymentSupport: { canDeploy: true }, capabilities: ['pod-host'],
      resource: 'pod-host', hostLabel: null,
    }
    const peer = podHostRuntimePeer(description)
    assert.equal(peer.shellBackend, undefined)
    assert.equal(peer.capabilities.includes('exec'), false)
  })
})

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

describe('createPodHostClient', () => {
  it('requires a peerNode or ctx', () => {
    assert.throws(() => createPodHostClient({}), /peerNode \(or ctx\) is required/)
  })

  it('accepts a MeshServiceContext in place of a peerNode', async () => {
    const alice = await createPeer('alice-host')
    const bob = await createPeer('bob')
    const nodes = wireMesh([alice, bob])
    attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.NODE }),
    }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const client = createPodHostClient({ ctx: { peerNode: nodes.get(bob.podId) }, timeoutMs: 1000 })
    assert.deepEqual(await client.list(alice.podId), [])
    client.close()
  })

  it('times out with ETIMEDOUT when no host answers', async () => {
    const bob = await createPeer('bob')
    const silent = await createPeer('silent')
    const nodes = wireMesh([bob, silent])
    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 30 })
    await assert.rejects(client.list(silent.podId), (err) => {
      assert.equal(err.code, POD_HOST_ERROR.ETIMEDOUT)
      assert.match(err.message, /did not answer 'list' within 30ms/)
      return true
    })
    client.close()
  })

  it('rejects when sendTo fails, without leaking a pending entry', async () => {
    const bob = await createPeer('bob')
    const nodes = wireMesh([bob])
    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })
    await assert.rejects(client.list('nobody'), /no such peer/)
    client.close()
  })

  it('requires a hostPubKey', async () => {
    const bob = await createPeer('bob')
    const nodes = wireMesh([bob])
    const client = createPodHostClient({ peerNode: nodes.get(bob.podId) })
    await assert.rejects(client.list(''), (err) => err.code === POD_HOST_ERROR.EINVAL)
    client.close()
  })

  it('correlates concurrent requests to several hosts by requestId', async () => {
    const hostA = await createPeer('host-a')
    const hostB = await createPeer('host-b')
    const bob = await createPeer('bob')
    const nodes = wireMesh([hostA, hostB, bob])
    for (const host of [hostA, hostB]) {
      attachService(nodes.get(host.podId), undefined, createPodHostService({
        driver: new InMemoryPodHostDriver({ lane: POD_LANE.NODE }),
      }))
      host.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    }
    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })
    const [a, b] = await Promise.all([
      client.spawn(hostA.podId, minimalSpec({ name: 'on-a' })),
      client.spawn(hostB.podId, minimalSpec({ name: 'on-b' })),
    ])
    assert.equal(a.name, 'on-a')
    assert.equal(b.name, 'on-b')
    client.close()
  })

  it('rejects in-flight and subsequent requests once closed', async () => {
    const bob = await createPeer('bob')
    const silent = await createPeer('silent')
    const nodes = wireMesh([bob, silent])
    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 5000 })
    const inFlight = client.list(silent.podId)
    client.close()
    await assert.rejects(inFlight, /closed before the response arrived/)
    await assert.rejects(client.list(silent.podId), /client is closed/)
    client.close() // idempotent
  })

  it('isolates a throwing event subscriber', async () => {
    const alice = await createPeer('alice-host')
    const bob = await createPeer('bob')
    const nodes = wireMesh([alice, bob])
    attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.NODE }),
    }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })
    /** @type {object[]} */
    const seen = []
    client.onEvent(() => { throw new Error('boom') })
    const off = client.onEvent((_host, event) => seen.push(event))
    assert.equal(typeof client.onEvent('nope'), 'function')
    await client.spawn(alice.podId, minimalSpec())
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(seen.length > 0)
    off()
    client.close()
  })
})

// ---------------------------------------------------------------------------
// Orchestrator integration
// ---------------------------------------------------------------------------

describe('MeshOrchestrator hosted-pod methods', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodes
  /** @type {any} */ let auditRecorder
  /** @type {any} */ let orchestrator
  /** @type {any} */ let client

  beforeEach(async () => {
    alice = await createPeer('alice-host')
    bob = await createPeer('bob-operator')
    nodes = wireMesh([alice, bob])
    attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.MICROVM }),
    }))
    auditRecorder = fakeAuditRecorder()
    client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })
    orchestrator = new MeshOrchestrator({
      peerNode: nodes.get(bob.podId),
      auditRecorder,
      podHostClient: client,
    })
  })

  it('spawnPod records placement_requested then placement_ready', async () => {
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const result = await orchestrator.spawnPod(alice.podId, minimalSpec({ lane: POD_LANE.MICROVM }))
    assert.equal(result.state, POD_LIFECYCLE.REGISTERED)
    assert.deepEqual(auditRecorder.operations(), [PLACEMENT_AUDIT.REQUESTED, PLACEMENT_AUDIT.READY])
    assert.equal(auditRecorder.records[1].data.name, 'alpha')
    assert.equal(auditRecorder.records[1].data.lane, POD_LANE.MICROVM)
  })

  it('spawnPod records placement_denied on EACCES and rethrows', async () => {
    await assert.rejects(
      orchestrator.spawnPod(alice.podId, minimalSpec({ lane: POD_LANE.MICROVM })),
      (err) => err.code === POD_HOST_ERROR.EACCES,
    )
    assert.deepEqual(auditRecorder.operations(), [PLACEMENT_AUDIT.REQUESTED, PLACEMENT_AUDIT.DENIED])
  })

  it('does not record placement_denied for a non-EACCES failure', async () => {
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    await assert.rejects(
      orchestrator.spawnPod(alice.podId, { name: 'bad name' }),
      (err) => err.code === POD_HOST_ERROR.EINVAL,
    )
    assert.deepEqual(auditRecorder.operations(), [PLACEMENT_AUDIT.REQUESTED])
  })

  it('snapshotPod records placement_evicted and restorePod a requested/ready pair', async () => {
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    await orchestrator.spawnPod(alice.podId, minimalSpec({ lane: POD_LANE.MICROVM }))
    await orchestrator.snapshotPod(alice.podId, 'alpha')
    await orchestrator.restorePod(alice.podId, 'alpha')
    assert.deepEqual(auditRecorder.operations(), [
      PLACEMENT_AUDIT.REQUESTED, PLACEMENT_AUDIT.READY,
      PLACEMENT_AUDIT.EVICTED,
      PLACEMENT_AUDIT.REQUESTED, PLACEMENT_AUDIT.READY,
    ])
  })

  it('listHostedPods reads the host without writing an audit record', async () => {
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    await orchestrator.spawnPod(alice.podId, minimalSpec({ lane: POD_LANE.MICROVM }))
    auditRecorder.records.length = 0
    const pods = await orchestrator.listHostedPods(alice.podId)
    assert.deepEqual(pods.map((pod) => pod.name), ['alpha'])
    assert.deepEqual(auditRecorder.operations(), [])
  })

  it('lazily builds a PodHostClient from the peerNode when none is injected', async () => {
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const lazy = new MeshOrchestrator({ peerNode: nodes.get(bob.podId), auditRecorder: fakeAuditRecorder() })
    const result = await lazy.spawnPod(alice.podId, minimalSpec({ name: 'lazy', lane: POD_LANE.MICROVM }))
    assert.equal(result.name, 'lazy')
  })
})

// ---------------------------------------------------------------------------
// Lane driver adapters
// ---------------------------------------------------------------------------

/**
 * The two real lane drivers live in the spikes (`spikes/vm-pod-host` and
 * `spikes/isolate-pod-host`), which are not npm workspace members. These
 * tests exist here, rather than only in each spike's own suite, to assert
 * the one property neither spike can check on its own: that a spike driver
 * is a valid `PodHostDriver` for THIS service -- attachable, gateable, and
 * answering the same coded errors over the mesh that it answers locally.
 * Each spike's own suite covers its driver's internals (see
 * `spikes/vm-pod-host/test/driver.test.mjs` and
 * `spikes/isolate-pod-host/test/routes.test.mjs`).
 */
describe('lane driver adapters serve the pod host service', () => {
  it('serves a microvm host backed by a dryRun VmPodHost', async () => {
    const { VmPodHost } = await import('../../../spikes/vm-pod-host/src/host-pod.mjs')
    const { createVmPodDriver } = await import('../../../spikes/vm-pod-host/src/driver.mjs')

    const vmHost = new VmPodHost({ dryRun: true })
    await vmHost.start()
    const driver = createVmPodDriver(vmHost, {
      kernelImage: '/boot/vmlinux', rootfs: '/vm/default.ext4',
      snapshotDir: '/vm/snapshots', runDir: '/vm/run', idleTimeoutMs: 0, dryRun: true,
    })

    const alice = await createPeer('alice-vm-host')
    const bob = await createPeer('bob')
    const nodes = wireMesh([alice, bob])
    const handle = attachService(nodes.get(alice.podId), undefined, createPodHostService({ driver }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })

    assert.equal((await client.describe(alice.podId)).shellBackend, 'vm-console')
    const spawned = await client.spawn(alice.podId, {
      name: 'alpha', lane: POD_LANE.MICROVM, run: { kind: 'command', ref: '/bin/echo' },
      limits: { vcpus: 1, memMib: 128 },
    })
    assert.equal(spawned.state, 'booting')

    vmHost.vms.get('alpha').markRegistered('guest-1')
    assert.deepEqual(await client.exec(alice.podId, 'alpha', ['ls', '/data']), {
      stdout: '', stderr: '', code: 0,
    })
    // WP3's host agent has no message path yet -- a driver gap, not a lane limit.
    await assert.rejects(
      client.send(alice.podId, 'alpha', { hi: true }),
      (err) => err.code === POD_HOST_ERROR.ENOTSUP,
    )
    assert.equal((await client.drain(alice.podId, 'alpha')).state, POD_LIFECYCLE.GONE)

    client.close()
    await handle.teardown()
  })

  it('serves an isolate host backed by the Worker route table', async () => {
    const { handlePodHostRequest } = await import('../../../spikes/isolate-pod-host/src/routes.mjs')
    const { createIsolatePodDriver } = await import('../../../spikes/isolate-pod-host/src/driver.mjs')

    // A minimal fake Durable Object namespace: enough of `/boot`,
    // `/status`, `/send`, `/drain` and `/roster*` for the route table.
    const instances = new Map()
    const instanceFor = (id) => {
      if (!instances.has(id)) instances.set(id, { record: null, roster: [] })
      return instances.get(id)
    }
    const env = {
      POD: {
        idFromName: (name) => name,
        get: (id) => ({
          async fetch(request) {
            const instance = instanceFor(id)
            const url = new URL(request.url)
            if (url.pathname === '/roster') return Response.json({ names: instance.roster })
            if (url.pathname === '/roster/add') {
              const { name } = await request.json()
              if (!instance.roster.includes(name)) instance.roster.push(name)
              return Response.json({ names: instance.roster })
            }
            if (url.pathname === '/roster/remove') {
              const { name } = await request.json()
              instance.roster = instance.roster.filter((entry) => entry !== name)
              return Response.json({ names: instance.roster })
            }
            if (url.pathname === '/boot') {
              const { name, spec } = await request.json()
              instance.record = {
                name, lane: POD_LANE.ISOLATE, state: POD_LIFECYCLE.REGISTERED, spec,
                createdAt: 1, updatedAt: 2,
              }
              return Response.json({ ...instance.record, podId: `pod-${name}`, peers: [], booted: true })
            }
            if (url.pathname === '/status') {
              if (!instance.record) {
                return Response.json({ name: null, podId: null, booted: false, state: POD_LIFECYCLE.COLD })
              }
              return Response.json({ ...instance.record, podId: `pod-${instance.record.name}`, booted: true })
            }
            if (url.pathname === '/send') return Response.json({ ok: true })
            if (url.pathname === '/drain') {
              instance.record = { ...(instance.record || {}), state: POD_LIFECYCLE.GONE }
              return Response.json({ ...instance.record, podId: null, booted: false })
            }
            return Response.json({ code: 'ENOENT', message: 'not found' }, { status: 404 })
          },
        }),
      },
    }

    const driver = createIsolatePodDriver({
      baseUrl: 'http://worker',
      fetch: async (url, init) => handlePodHostRequest(new Request(url, init), env),
    })

    const alice = await createPeer('alice-isolate-host')
    const bob = await createPeer('bob')
    const nodes = wireMesh([alice, bob])
    const handle = attachService(nodes.get(alice.podId), undefined, createPodHostService({ driver }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })

    const description = await client.describe(alice.podId)
    assert.equal(description.lane, POD_LANE.ISOLATE)
    assert.equal(description.shellBackend, null)
    assert.deepEqual(description.verbs, ['spawn', 'status', 'send', 'drain', 'list'])

    const spawned = await client.spawn(alice.podId, { name: 'alpha', run: { kind: 'skill', ref: 'greeter' } })
    assert.equal(spawned.state, POD_LIFECYCLE.REGISTERED)
    assert.deepEqual(await client.send(alice.podId, 'alpha', { hi: true }), { ok: true })
    assert.deepEqual((await client.list(alice.podId)).map((pod) => pod.name), ['alpha'])
    await assert.rejects(
      client.exec(alice.podId, 'alpha', ['ls']),
      (err) => err.code === POD_HOST_ERROR.ELANE,
    )
    assert.equal((await client.drain(alice.podId, 'alpha')).state, POD_LIFECYCLE.GONE)

    client.close()
    await handle.teardown()
  })
})

describe('createPodHostClient: real-wire (JSON text) responses (#208)', () => {
  // A real transport can hand a raw PeerNode subscriber the JSON text the
  // host put on the wire, not an object. The client must parse it.
  function wireNode() {
    let cb = null
    const sent = []
    return {
      sent,
      node: {
        onIncomingData(fn) { cb = fn; return () => { cb = null } },
        sendTo(pubKey, envelope) { sent.push({ pubKey, envelope }); return Promise.resolve() },
      },
      deliver(pubKey, value) { cb(pubKey, typeof value === 'string' ? value : JSON.stringify(value)) },
    }
  }

  it('resolves a call from a JSON-text response', async () => {
    const w = wireNode()
    const client = createPodHostClient({ peerNode: w.node, timeoutMs: 1000 })
    const pending = client.list('host-1')
    const { envelope } = w.sent[0]
    w.deliver('host-1', { type: 'pod-host:response', requestId: envelope.requestId, ok: true, result: [{ name: 'a' }] })
    assert.deepEqual(await pending, [{ name: 'a' }])
    client.close()
  })

  it('rejects with the remote error code from a JSON-text failure', async () => {
    const w = wireNode()
    const client = createPodHostClient({ peerNode: w.node, timeoutMs: 1000 })
    const pending = client.list('host-1')
    const { envelope } = w.sent[0]
    w.deliver('host-1', { type: 'pod-host:response', requestId: envelope.requestId, ok: false, error: { code: 'EACCES', message: 'no' } })
    await assert.rejects(pending, (err) => err.code === POD_HOST_ERROR.EACCES)
    client.close()
  })

  it('delivers a JSON-text lifecycle event to onEvent subscribers', async () => {
    const w = wireNode()
    const client = createPodHostClient({ peerNode: w.node, timeoutMs: 1000 })
    const seen = []
    client.onEvent((host, event) => seen.push([host, event.kind, event.data.to]))
    w.deliver('host-1', { type: 'pod-host:event', kind: 'lifecycle', data: { name: 'a', to: 'registered' }, ts: 1 })
    assert.deepEqual(seen, [['host-1', 'lifecycle', 'registered']])
    client.close()
  })

  it('ignores plain-text payloads that merely look like JSON scalars', () => {
    const w = wireNode()
    const client = createPodHostClient({ peerNode: w.node, timeoutMs: 1000 })
    assert.doesNotThrow(() => { w.deliver('host-1', '42'); w.deliver('host-1', 'hello') })
    client.close()
  })
})
