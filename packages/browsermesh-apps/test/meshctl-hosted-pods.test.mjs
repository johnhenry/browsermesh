/**
 * Tests for the hosted-pods control surface's `meshctl` projection (issue
 * #185 §8a item 4): `MeshctlSpawnTool`/`MeshctlSnapshotTool`/
 * `MeshctlRestoreTool`/`MeshctlHostedPodsTool`/`MeshctlHostsTool`
 * (`orchestrator.mjs`), the `meshctl spawn|snapshot|restore|hosted|hosts`
 * text-command cases (`registerMeshctlBuiltins()`), and their registration
 * into `createOrchestratorToolRegistry()`/`registerOrchestratorTools()`
 * (`mesh-orchestrator-tools.mjs`).
 *
 * Mesh setup mirrors `test/pod-host-service.test.mjs`: real Ed25519
 * identities via `IdentityWallet`/`MeshIdentityManager`, real `PeerRegistry`s
 * over real `MeshACL`, wired with the same minimal duck-typed
 * `sendTo`/`onIncomingData` bus -- real enough that `checkAccess()` is
 * genuinely enforced, without needing WebRTC.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/meshctl-hosted-pods.test.mjs
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
  POD_LANE,
} from '@johnhenry/browsermesh-pod'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createPodHostService, createPodHostClient, DEFAULT_POD_HOST_RESOURCE } from '../src/pod-host-service.mjs'
import {
  MeshOrchestrator,
  PLACEMENT_AUDIT,
  MeshctlSpawnTool,
  MeshctlSnapshotTool,
  MeshctlRestoreTool,
  MeshctlHostedPodsTool,
  MeshctlHostsTool,
  registerMeshctlBuiltins,
  createMeshctlTools,
} from '../src/orchestrator.mjs'
import { BrowserToolRegistry } from '../src/compat.mjs'
import {
  registerOrchestratorTools,
  createOrchestratorToolRegistry,
} from '../src/mesh-orchestrator-tools.mjs'

const RESOURCE = DEFAULT_POD_HOST_RESOURCE
const ALL_SCOPES = [
  'spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list',
].map((verb) => `${RESOURCE}:${verb}`)

/** A real Ed25519 identity + wallet + registry bundle for one "peer" (mirrors pod-host-service.test.mjs). */
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

/** A minimal duck-typed `PeerNode` mesh (mirrors pod-host-service.test.mjs's `wireMesh()`). */
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

/** A fake `auditRecorder`, matching what `MeshOrchestrator#recordPlacement()` calls. */
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

/** A runtime-registry fake carrying `podHostRuntimePeer()`-shaped records, matching orchestrator.test.mjs's own `makeRuntimeRegistry()`. */
function makeRuntimeRegistry(peers = []) {
  const byId = new Map()
  for (const peer of peers) {
    const podId = peer.identity?.podId
    byId.set(podId, peer)
  }
  return {
    listPeers() {
      return peers
    },
    resolvePeer(selector) {
      return byId.get(selector) || null
    },
  }
}

function minimalSpec(overrides = {}) {
  return { name: 'alpha', lane: POD_LANE.NODE, run: { kind: 'command', ref: '/bin/echo' }, ...overrides }
}

// ---------------------------------------------------------------------------
// Parameter schemas are valid JSON-schema shapes
// ---------------------------------------------------------------------------

describe('hosted-pods meshctl tools: parameter schemas', () => {
  const orch = new MeshOrchestrator({ peerNode: { podId: 'local' } })
  const tools = [
    new MeshctlSpawnTool(orch),
    new MeshctlSnapshotTool(orch),
    new MeshctlRestoreTool(orch),
    new MeshctlHostedPodsTool(orch),
    new MeshctlHostsTool(orch),
  ]

  it('each tool has a well-formed name/description/parameters/permission', () => {
    for (const tool of tools) {
      assert.match(tool.name, /^meshctl_[a-z_]+$/)
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 0)
      assert.equal(tool.parameters.type, 'object')
      assert.equal(typeof tool.parameters.properties, 'object')
      if (tool.parameters.required) {
        assert.ok(Array.isArray(tool.parameters.required))
        for (const key of tool.parameters.required) {
          assert.ok(key in tool.parameters.properties, `${tool.name}: required key '${key}' is not in properties`)
        }
      }
      assert.ok(['read', 'write', 'network', 'internal'].includes(tool.permission))
    }
  })

  it('names are the five new tools', () => {
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'meshctl_hosted_pods', 'meshctl_hosts', 'meshctl_restore', 'meshctl_snapshot', 'meshctl_spawn',
    ])
  })

  it('meshctl_spawn requires name and run; meshctl_snapshot/restore/hosted_pods require host', () => {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
    assert.deepEqual(byName.meshctl_spawn.parameters.required, ['name', 'run'])
    assert.deepEqual(byName.meshctl_snapshot.parameters.required, ['host', 'name'])
    assert.deepEqual(byName.meshctl_restore.parameters.required, ['host', 'name'])
    assert.deepEqual(byName.meshctl_hosted_pods.parameters.required, ['host'])
    assert.equal(byName.meshctl_hosts.parameters.required, undefined)
  })

  it('createMeshctlTools() returns 13 tools including the five new ones', () => {
    const all = createMeshctlTools(orch)
    assert.equal(all.length, 13)
    const names = all.map((t) => t.name)
    for (const name of ['meshctl_spawn', 'meshctl_snapshot', 'meshctl_restore', 'meshctl_hosted_pods', 'meshctl_hosts']) {
      assert.ok(names.includes(name))
    }
  })
})

// ---------------------------------------------------------------------------
// Happy path: spawn/snapshot/restore/hosted_pods against a real two-PeerNode
// mesh, driver = InMemoryPodHostDriver on the host.
// ---------------------------------------------------------------------------

describe('MeshctlSpawnTool/SnapshotTool/RestoreTool/HostedPodsTool: real two-peer mesh', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodes
  /** @type {any} */ let auditRecorder
  /** @type {any} */ let orchestrator
  /** @type {any} */ let spawnTool
  /** @type {any} */ let snapshotTool
  /** @type {any} */ let restoreTool
  /** @type {any} */ let hostedPodsTool

  beforeEach(async () => {
    alice = await createPeer('alice-host')
    bob = await createPeer('bob-operator')
    nodes = wireMesh([alice, bob])
    attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.MICROVM }), hostLabel: 'alice-host',
    }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    auditRecorder = fakeAuditRecorder()
    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })
    orchestrator = new MeshOrchestrator({ peerNode: nodes.get(bob.podId), auditRecorder, podHostClient: client })
    spawnTool = new MeshctlSpawnTool(orchestrator)
    snapshotTool = new MeshctlSnapshotTool(orchestrator)
    restoreTool = new MeshctlRestoreTool(orchestrator)
    hostedPodsTool = new MeshctlHostedPodsTool(orchestrator)
  })

  it('meshctl_spawn spawns a named host directly (no auto selection)', async () => {
    const result = await spawnTool.execute({
      host: alice.podId, name: 'alpha', run: { kind: 'command', ref: '/bin/echo' },
    })
    assert.equal(result.success, true)
    assert.match(result.output, new RegExp(alice.podId))
    assert.match(result.output, /state=registered/)
  })

  it('meshctl_spawn rejects an invalid podspec before ever touching the host', async () => {
    const result = await spawnTool.execute({ host: alice.podId, name: 'bad name', run: { kind: 'command', ref: 'x' } })
    assert.equal(result.success, false)
    assert.match(result.error, /Invalid podspec/)
    assert.match(result.error, /name/)
  })

  it('meshctl_snapshot and meshctl_restore round-trip a spawned pod', async () => {
    await spawnTool.execute({ host: alice.podId, name: 'alpha', run: { kind: 'command', ref: '/bin/echo' } })
    const snap = await snapshotTool.execute({ host: alice.podId, name: 'alpha' })
    assert.equal(snap.success, true)
    assert.match(snap.output, /state=snapshotted/)
    const restore = await restoreTool.execute({ host: alice.podId, name: 'alpha' })
    assert.equal(restore.success, true)
    assert.match(restore.output, /state=registered/)
  })

  it('meshctl_hosted_pods lists what the host is tracking, as a table and JSON', async () => {
    await spawnTool.execute({ host: alice.podId, name: 'alpha', run: { kind: 'command', ref: '/bin/echo' } })
    const result = await hostedPodsTool.execute({ host: alice.podId })
    assert.equal(result.success, true)
    assert.match(result.output, /NAME \| LANE \| STATE/)
    assert.match(result.output, /alpha \| microvm \| registered/)
    const jsonPart = result.output.slice(result.output.indexOf('['))
    const parsed = JSON.parse(jsonPart)
    assert.deepEqual(parsed.map((p) => p.name), ['alpha'])
  })

  it('meshctl_hosted_pods on an empty host says so without throwing', async () => {
    const result = await hostedPodsTool.execute({ host: alice.podId })
    assert.equal(result.success, true)
    assert.match(result.output, /No hosted pods/)
  })

  it('every spawn/snapshot/restore call records the matching PLACEMENT_AUDIT event exactly once', async () => {
    await spawnTool.execute({ host: alice.podId, name: 'alpha', run: { kind: 'command', ref: '/bin/echo' } })
    await snapshotTool.execute({ host: alice.podId, name: 'alpha' })
    await restoreTool.execute({ host: alice.podId, name: 'alpha' })
    assert.deepEqual(auditRecorder.operations(), [
      PLACEMENT_AUDIT.REQUESTED, PLACEMENT_AUDIT.READY,
      PLACEMENT_AUDIT.EVICTED,
      PLACEMENT_AUDIT.REQUESTED, PLACEMENT_AUDIT.READY,
    ])
  })

  it('meshctl_hosted_pods is read-only: it writes no PLACEMENT_AUDIT record', async () => {
    await spawnTool.execute({ host: alice.podId, name: 'alpha', run: { kind: 'command', ref: '/bin/echo' } })
    auditRecorder.records.length = 0
    await hostedPodsTool.execute({ host: alice.podId })
    assert.deepEqual(auditRecorder.operations(), [])
  })
})

// ---------------------------------------------------------------------------
// EACCES: refused as a failure, naming the host, no silent retry elsewhere.
// ---------------------------------------------------------------------------

describe('MeshctlSpawnTool: EACCES is reported, not retried', () => {
  it('an ungranted requester gets success:false naming the host and the verb', async () => {
    const alice = await createPeer('alice-host')
    const carol = await createPeer('carol-stranger')
    const nodes = wireMesh([alice, carol])
    attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.NODE }),
    }))
    // Deliberately no grantCapabilities() call.
    const client = createPodHostClient({ peerNode: nodes.get(carol.podId), timeoutMs: 1000 })
    const orchestrator = new MeshOrchestrator({ peerNode: nodes.get(carol.podId), podHostClient: client })
    const spawnTool = new MeshctlSpawnTool(orchestrator)

    const result = await spawnTool.execute({ host: alice.podId, name: 'alpha', run: { kind: 'command', ref: '/bin/echo' } })
    assert.equal(result.success, false)
    assert.match(result.error, new RegExp(alice.podId))
    assert.match(result.error, /not authorized/)
    assert.match(result.error, /spawn/)
  })
})

// ---------------------------------------------------------------------------
// ELANE: lane-aware messages for an isolate-lane host (POD_LANE_VERBS
// excludes exec/snapshot/restore for 'isolate').
// ---------------------------------------------------------------------------

describe('MeshctlSnapshotTool/MeshctlRestoreTool: ELANE on an isolate-lane host', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let orchestrator
  /** @type {any} */ let spawnTool
  /** @type {any} */ let snapshotTool
  /** @type {any} */ let restoreTool

  beforeEach(async () => {
    alice = await createPeer('alice-isolate-host')
    const carol = await createPeer('carol-operator')
    const nodes = wireMesh([alice, carol])
    attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.ISOLATE }), hostLabel: 'alice-isolate',
    }))
    alice.registry.grantCapabilities(carol.podId, ALL_SCOPES)
    const client = createPodHostClient({ peerNode: nodes.get(carol.podId), timeoutMs: 1000 })
    orchestrator = new MeshOrchestrator({ peerNode: nodes.get(carol.podId), podHostClient: client })
    spawnTool = new MeshctlSpawnTool(orchestrator)
    snapshotTool = new MeshctlSnapshotTool(orchestrator)
    restoreTool = new MeshctlRestoreTool(orchestrator)
    await spawnTool.execute({ host: alice.podId, name: 'iso1', run: { kind: 'skill', ref: 'greeter' } })
  })

  it('meshctl_snapshot answers with a lane-aware hint, not the raw ELANE code', async () => {
    const result = await snapshotTool.execute({ host: alice.podId, name: 'iso1' })
    assert.equal(result.success, false)
    assert.match(result.error, /isolate pods cannot snapshot/)
    assert.match(result.error, /hibernation is automatic/)
  })

  it('meshctl_restore answers with a lane-aware hint, not the raw ELANE code', async () => {
    const result = await restoreTool.execute({ host: alice.podId, name: 'iso1' })
    assert.equal(result.success, false)
    assert.match(result.error, /isolate pods cannot restore/)
  })
})

// ---------------------------------------------------------------------------
// meshctl_spawn auto host selection: two hosts, two lanes.
// ---------------------------------------------------------------------------

describe('MeshctlSpawnTool: host: "auto" selects a host matching the lane', () => {
  /** @type {any} */ let isolateHost
  /** @type {any} */ let microvmHost
  /** @type {any} */ let operator
  /** @type {any} */ let orchestrator
  /** @type {any} */ let spawnTool

  beforeEach(async () => {
    isolateHost = await createPeer('isolate-host')
    microvmHost = await createPeer('microvm-host')
    operator = await createPeer('operator')
    const nodes = wireMesh([isolateHost, microvmHost, operator])

    const isolateHandle = attachService(nodes.get(isolateHost.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.ISOLATE }), hostLabel: 'isolate-host',
    }))
    const microvmHandle = attachService(nodes.get(microvmHost.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.MICROVM }), hostLabel: 'microvm-host',
    }))
    isolateHost.registry.grantCapabilities(operator.podId, ALL_SCOPES)
    microvmHost.registry.grantCapabilities(operator.podId, ALL_SCOPES)

    // Both hosts' describe() projected into the runtime-registry peer shape
    // -- the same thing a real deployment would feed a RemoteRuntimeRegistry
    // via `handle.api.runtimePeer()` on announce.
    const runtimeRegistry = makeRuntimeRegistry([
      isolateHandle.api.runtimePeer(),
      microvmHandle.api.runtimePeer(),
    ])

    const client = createPodHostClient({ peerNode: nodes.get(operator.podId), timeoutMs: 1000 })
    orchestrator = new MeshOrchestrator({ peerNode: nodes.get(operator.podId), podHostClient: client, runtimeRegistry })
    spawnTool = new MeshctlSpawnTool(orchestrator)
  })

  it('picks the isolate host for a skill run (isolate has no exec, invisible to compute-candidate scoring)', async () => {
    const result = await spawnTool.execute({ host: 'auto', name: 'skillpod', run: { kind: 'skill', ref: 'greeter' } })
    assert.equal(result.success, true)
    assert.match(result.output, new RegExp(`orchestrator proposes host ${isolateHost.podId}`))
    assert.match(result.output, /lane 'isolate'/)
    assert.match(result.output, new RegExp(`spawned 'skillpod' on ${isolateHost.podId}`))
  })

  it('picks the microvm host for a command run (visible via compute-candidate scoring)', async () => {
    const result = await spawnTool.execute({ host: 'auto', name: 'cmdpod', run: { kind: 'command', ref: '/bin/echo' } })
    assert.equal(result.success, true)
    assert.match(result.output, new RegExp(`orchestrator proposes host ${microvmHost.podId}`))
    assert.match(result.output, /lane 'microvm'/)
    assert.match(result.output, new RegExp(`spawned 'cmdpod' on ${microvmHost.podId}`))
  })

  it('fails clearly when no known host advertises the requested lane', async () => {
    const result = await spawnTool.execute({ host: 'auto', name: 'nodepod', lane: 'node', run: { kind: 'command', ref: '/bin/echo' } })
    assert.equal(result.success, false)
    assert.match(result.error, /No known pod host advertises lane 'node'/)
  })
})

// ---------------------------------------------------------------------------
// MeshctlHostsTool
// ---------------------------------------------------------------------------

describe('MeshctlHostsTool', () => {
  it('lists known pod hosts with lane, verbs and runtime classes', async () => {
    const alice = await createPeer('alice-host')
    const bob = await createPeer('bob-operator')
    const nodes = wireMesh([alice, bob])
    const handle = attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.MICROVM }), hostLabel: 'alice-host',
    }))
    const runtimeRegistry = makeRuntimeRegistry([handle.api.runtimePeer()])
    const orchestrator = new MeshOrchestrator({ peerNode: nodes.get(bob.podId), runtimeRegistry })
    const hostsTool = new MeshctlHostsTool(orchestrator)

    const result = await hostsTool.execute({})
    assert.equal(result.success, true)
    assert.match(result.output, /HOST \| LANE \| VERBS \| RUNTIME CLASSES/)
    assert.match(result.output, new RegExp(`${alice.podId} \\| microvm`))
    assert.match(result.output, /verbs: spawn,status,send,exec,snapshot,restore,drain,list/)
  })

  it('says so when no pod hosts are known', async () => {
    const bob = await createPeer('bob')
    const nodes = wireMesh([bob])
    const orchestrator = new MeshOrchestrator({ peerNode: nodes.get(bob.podId) })
    const hostsTool = new MeshctlHostsTool(orchestrator)
    const result = await hostsTool.execute({})
    assert.equal(result.success, true)
    assert.match(result.output, /No pod hosts known/)
  })
})

// ---------------------------------------------------------------------------
// MeshOrchestrator#listPodHosts()
// ---------------------------------------------------------------------------

describe('MeshOrchestrator#listPodHosts()', () => {
  it('reads podHost-tagged runtime-registry peers, including an isolate host with no compute descriptor', async () => {
    const alice = await createPeer('alice-isolate-host')
    const nodes = wireMesh([alice])
    const handle = attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.ISOLATE }), hostLabel: 'alice-isolate',
    }))
    const runtimeRegistry = makeRuntimeRegistry([handle.api.runtimePeer()])
    const orchestrator = new MeshOrchestrator({ peerNode: nodes.get(alice.podId), runtimeRegistry })

    const hosts = await orchestrator.listPodHosts()
    assert.equal(hosts.length, 1)
    assert.equal(hosts[0].podId, alice.podId)
    assert.equal(hosts[0].lane, 'isolate')
    assert.deepEqual(hosts[0].verbs, ['spawn', 'status', 'send', 'drain', 'list'])
    assert.equal(hosts[0].shellBackend, null)

    // Confirms the documented gap pickAutoHost()'s fallback exists for:
    // this isolate host is listed by listPodHosts() but invisible to
    // listComputeCandidates() (no exec -> no 'compute' capability).
    const candidates = await orchestrator.listComputeCandidates({})
    assert.deepEqual(candidates, [])
  })

  it('returns an empty list when no runtimeRegistry is wired', async () => {
    const bob = await createPeer('bob')
    const nodes = wireMesh([bob])
    const orchestrator = new MeshOrchestrator({ peerNode: nodes.get(bob.podId) })
    assert.deepEqual(await orchestrator.listPodHosts(), [])
  })
})

// ---------------------------------------------------------------------------
// meshctl text dispatcher: spawn, snapshot, restore, hosted, hosts
// ---------------------------------------------------------------------------

describe('registerMeshctlBuiltins: spawn/snapshot/restore/hosted/hosts', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let orchestrator
  /** @type {any} */ let registered

  beforeEach(async () => {
    alice = await createPeer('alice-host')
    bob = await createPeer('bob-operator')
    const nodes = wireMesh([alice, bob])
    attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.MICROVM }), hostLabel: 'alice-host',
    }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })
    orchestrator = new MeshOrchestrator({ peerNode: nodes.get(bob.podId), podHostClient: client })
    registered = {}
    const shellRegistry = { register(name, handler, meta) { registered[name] = { handler, meta } } }
    registerMeshctlBuiltins(shellRegistry, orchestrator)
  })

  it('spawn requires host, name, --kind and --ref', async () => {
    const missingArgs = await registered.meshctl.handler({ args: ['spawn'] })
    assert.equal(missingArgs.exitCode, 1)
    assert.match(missingArgs.stderr, /Usage: meshctl spawn/)

    const missingFlags = await registered.meshctl.handler({ args: ['spawn', alice.podId, 'alpha'] })
    assert.equal(missingFlags.exitCode, 1)
    assert.match(missingFlags.stderr, /Usage: meshctl spawn/)
  })

  it('spawn <host> <name> --kind --ref succeeds against a named host', async () => {
    const result = await registered.meshctl.handler({
      args: ['spawn', alice.podId, 'alpha', '--kind', 'command', '--ref', '/bin/echo'],
    })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, new RegExp(`spawned 'alpha' on ${alice.podId}`))
  })

  it('spawn <host> <name> --lane --kind --ref --entry parses every flag', async () => {
    const result = await registered.meshctl.handler({
      args: ['spawn', alice.podId, 'beta', '--lane', 'microvm', '--kind', 'module', '--ref', 'my-module', '--entry', 'main'],
    })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /state=registered/)
  })

  it('snapshot and restore require <host> <name>', async () => {
    const usageSnap = await registered.meshctl.handler({ args: ['snapshot', alice.podId] })
    assert.equal(usageSnap.exitCode, 1)
    assert.match(usageSnap.stderr, /Usage: meshctl snapshot/)

    const usageRestore = await registered.meshctl.handler({ args: ['restore'] })
    assert.equal(usageRestore.exitCode, 1)
    assert.match(usageRestore.stderr, /Usage: meshctl restore/)
  })

  it('snapshot and restore round-trip a spawned pod', async () => {
    await registered.meshctl.handler({ args: ['spawn', alice.podId, 'alpha', '--kind', 'command', '--ref', '/bin/echo'] })
    const snap = await registered.meshctl.handler({ args: ['snapshot', alice.podId, 'alpha'] })
    assert.equal(snap.exitCode, 0)
    assert.match(snap.stdout, /snapshotted 'alpha'/)
    const restore = await registered.meshctl.handler({ args: ['restore', alice.podId, 'alpha'] })
    assert.equal(restore.exitCode, 0)
    assert.match(restore.stdout, /restored 'alpha'/)
  })

  it('hosted requires <host> and lists hosted pods', async () => {
    const usage = await registered.meshctl.handler({ args: ['hosted'] })
    assert.equal(usage.exitCode, 1)
    assert.match(usage.stderr, /Usage: meshctl hosted/)

    await registered.meshctl.handler({ args: ['spawn', alice.podId, 'alpha', '--kind', 'command', '--ref', '/bin/echo'] })
    const result = await registered.meshctl.handler({ args: ['hosted', alice.podId] })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /alpha\tmicrovm\tregistered/)
  })

  it('hosts lists known pod hosts (empty here: no runtimeRegistry wired)', async () => {
    const result = await registered.meshctl.handler({ args: ['hosts'] })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /No pod hosts known/)
  })

  it('an EACCES spawn failure surfaces on stderr naming the host', async () => {
    const carol = await createPeer('carol-stranger')
    const nodes2 = wireMesh([alice, carol])
    attachService(nodes2.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.NODE }),
    }))
    const strangerClient = createPodHostClient({ peerNode: nodes2.get(carol.podId), timeoutMs: 1000 })
    const strangerOrchestrator = new MeshOrchestrator({ peerNode: nodes2.get(carol.podId), podHostClient: strangerClient })
    const strangerRegistered = {}
    registerMeshctlBuiltins({ register(name, handler, meta) { strangerRegistered[name] = { handler, meta } } }, strangerOrchestrator)

    const result = await strangerRegistered.meshctl.handler({
      args: ['spawn', alice.podId, 'alpha', '--kind', 'command', '--ref', '/bin/echo'],
    })
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, new RegExp(alice.podId))
    assert.match(result.stderr, /not authorized/)
  })

  it('the default/unknown-subcommand usage string includes all 13 subcommands', async () => {
    const result = await registered.meshctl.handler({ args: ['bogus'] })
    assert.equal(result.exitCode, 1)
    for (const sub of ['pods', 'status', 'exec', 'deploy', 'top', 'compute', 'expose', 'drain', 'spawn', 'snapshot', 'restore', 'hosted', 'hosts']) {
      assert.match(result.stderr, new RegExp(`\\b${sub}\\b`))
    }
  })
})

// ---------------------------------------------------------------------------
// createOrchestratorToolRegistry()/registerOrchestratorTools() expose the
// five new tool names.
// ---------------------------------------------------------------------------

describe('createOrchestratorToolRegistry(): exposes the five new hosted-pods tools', () => {
  it('a raw MeshOrchestrator instance registers all five new tools by name', async () => {
    const alice = await createPeer('alice')
    const nodes = wireMesh([alice])
    const raw = new MeshOrchestrator({ peerNode: nodes.get(alice.podId), peerRegistry: alice.registry })

    const registry = createOrchestratorToolRegistry(raw)
    assert.equal(registry.listSpecs().length, 13)
    for (const name of ['meshctl_spawn', 'meshctl_snapshot', 'meshctl_restore', 'meshctl_hosted_pods', 'meshctl_hosts']) {
      assert.ok(registry.get(name), `${name} should be registered`)
    }
  })

  it('registerOrchestratorTools() against an existing registry adds the same five', async () => {
    const alice = await createPeer('alice')
    const nodes = wireMesh([alice])
    const raw = new MeshOrchestrator({ peerNode: nodes.get(alice.podId), peerRegistry: alice.registry })
    const registry = new BrowserToolRegistry()
    const tools = registerOrchestratorTools(registry, raw)
    assert.equal(tools.length, 13)
    assert.ok(registry.get('meshctl_hosts').execute)
  })

  it('meshctl_hosted_pods really dispatches through the raw instance on a real mesh', async () => {
    const alice = await createPeer('alice-host')
    const bob = await createPeer('bob-operator')
    const nodes = wireMesh([alice, bob])
    attachService(nodes.get(alice.podId), undefined, createPodHostService({
      driver: new InMemoryPodHostDriver({ lane: POD_LANE.NODE }),
    }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })
    const raw = new MeshOrchestrator({ peerNode: nodes.get(bob.podId), podHostClient: client })
    const registry = createOrchestratorToolRegistry(raw)

    await registry.get('meshctl_spawn').execute({ host: alice.podId, name: 'alpha', run: { kind: 'command', ref: '/bin/echo' } })
    const result = await registry.get('meshctl_hosted_pods').execute({ host: alice.podId })
    assert.equal(result.success, true)
    assert.match(result.output, /alpha/)
  })
})
