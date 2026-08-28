// Run with: node --import ./test/_setup-globals.mjs --test test/orchestrator.test.mjs
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  ORCH_LIST_PODS,
  ORCH_POD_STATUS,
  ORCH_EXEC,
  ORCH_DEPLOY,
  ORCH_DRAIN,
  ORCH_EXPOSE,
  ORCH_ROUTE,
  PodInfo,
  PodStatus,
  PodResourceInfo,
  MeshOrchestrator,
  MeshctlPodsTool,
  MeshctlStatusTool,
  MeshctlExecTool,
  MeshctlDeployTool,
  MeshctlTopTool,
  MeshctlComputeTool,
  MeshctlExposeTool,
  MeshctlDrainTool,
  registerMeshctlBuiltins,
  createMeshctlTools,
} from '../src/orchestrator.mjs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePeerNode(overrides = {}) {
  return {
    podId: 'local-pod',
    id: 'local-pod',
    label: 'Local Pod',
    capabilities: ['wasm', 'gpu'],
    services: [],
    resources: { cpu: 8, memory: 16384, storage: 102400 },
    uptime: 60000,
    activeTasks: 2,
    ...overrides,
  }
}

function makeOrchestrator(overrides = {}) {
  return new MeshOrchestrator({
    peerNode: makePeerNode(),
    ...overrides,
  })
}

function makeRuntimeRegistry(peers = []) {
  const byId = new Map()
  for (const peer of peers) {
    const podId = peer.identity?.podId || peer.identity?.fingerprint || peer.identity?.canonicalId
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

function makeRemotePeer(overrides = {}) {
  return {
    label: 'Remote Pod',
    status: 'online',
    capabilities: ['js'],
    services: ['api'],
    resources: { cpu: 4, memory: 8192, storage: 51200 },
    connections: 3,
    uptime: 30000,
    activeTasks: 1,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Wire constants
// ---------------------------------------------------------------------------

describe('Wire constants', () => {
  it('ORCH_LIST_PODS equals 0xD8', () => {
    assert.equal(ORCH_LIST_PODS, 0xd8)
  })

  it('ORCH_POD_STATUS equals 0xD9', () => {
    assert.equal(ORCH_POD_STATUS, 0xd9)
  })

  it('ORCH_EXEC equals 0xDA', () => {
    assert.equal(ORCH_EXEC, 0xda)
  })

  it('ORCH_DEPLOY equals 0xDB', () => {
    assert.equal(ORCH_DEPLOY, 0xdb)
  })

  it('ORCH_DRAIN equals 0xDC', () => {
    assert.equal(ORCH_DRAIN, 0xdc)
  })

  it('ORCH_EXPOSE equals 0xDD', () => {
    assert.equal(ORCH_EXPOSE, 0xdd)
  })

  it('ORCH_ROUTE equals 0xDE', () => {
    assert.equal(ORCH_ROUTE, 0xde)
  })
})

// ---------------------------------------------------------------------------
// PodInfo
// ---------------------------------------------------------------------------

describe('PodInfo', () => {
  it('constructor sets all fields', () => {
    const p = new PodInfo({
      podId: 'pod-a',
      label: 'Alpha',
      status: 'online',
      services: ['web', 'api'],
      connections: 5,
      isLocal: true,
    })
    assert.equal(p.podId, 'pod-a')
    assert.equal(p.label, 'Alpha')
    assert.equal(p.status, 'online')
    assert.deepEqual(p.services, ['web', 'api'])
    assert.equal(p.connections, 5)
    assert.equal(p.isLocal, true)
  })

  it('applies defaults', () => {
    const p = new PodInfo({ podId: 'pod-b' })
    assert.equal(p.label, '')
    assert.equal(p.status, 'online')
    assert.deepEqual(p.services, [])
    assert.equal(p.connections, 0)
    assert.equal(p.isLocal, false)
  })

  it('throws when podId is missing', () => {
    assert.throws(() => new PodInfo({}), /podId is required/)
  })

  it('round-trips via JSON', () => {
    const p = new PodInfo({ podId: 'pod-c', label: 'Charlie', services: ['db'] })
    const p2 = PodInfo.fromJSON(p.toJSON())
    assert.deepEqual(p2.toJSON(), p.toJSON())
  })

  it('copies services array', () => {
    const svcs = ['a', 'b']
    const p = new PodInfo({ podId: 'pod-d', services: svcs })
    svcs.push('c')
    assert.deepEqual(p.services, ['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// PodStatus
// ---------------------------------------------------------------------------

describe('PodStatus', () => {
  it('constructor sets all fields', () => {
    const s = new PodStatus({
      podId: 'pod-a',
      status: 'online',
      capabilities: ['gpu'],
      services: ['api'],
      connections: 3,
      uptime: 60000,
      resources: { cpu: 8, memory: 16384, storage: 1024 },
      isLocal: true,
    })
    assert.equal(s.podId, 'pod-a')
    assert.equal(s.status, 'online')
    assert.deepEqual(s.capabilities, ['gpu'])
    assert.equal(s.connections, 3)
    assert.equal(s.uptime, 60000)
    assert.equal(s.resources.cpu, 8)
    assert.equal(s.isLocal, true)
  })

  it('applies defaults', () => {
    const s = new PodStatus({ podId: 'pod-b' })
    assert.equal(s.status, 'online')
    assert.deepEqual(s.capabilities, [])
    assert.equal(s.resources.cpu, 0)
  })

  it('throws when podId is missing', () => {
    assert.throws(() => new PodStatus({}), /podId is required/)
  })

  it('round-trips via JSON', () => {
    const s = new PodStatus({ podId: 'pod-c', capabilities: ['wasm'] })
    const s2 = PodStatus.fromJSON(s.toJSON())
    assert.deepEqual(s2.toJSON(), s.toJSON())
  })
})

// ---------------------------------------------------------------------------
// MeshOrchestrator — construction
// ---------------------------------------------------------------------------

describe('MeshOrchestrator', () => {
  let orch

  beforeEach(() => {
    orch = makeOrchestrator()
  })

  it('constructor requires peerNode', () => {
    assert.throws(() => new MeshOrchestrator({}), /peerNode is required/)
  })

  it('constructor accepts optional dependencies', () => {
    const o = new MeshOrchestrator({
      peerNode: makePeerNode(),
      serviceAdvertiser: { advertise() {} },
      serviceBrowser: {},
      router: {},
      onLog: () => {},
    })
    assert.ok(o)
  })

  // -- listPods -------------------------------------------------------------

  it('listPods includes local pod', async () => {
    const pods = await orch.listPods()
    assert.equal(pods.length, 1)
    assert.equal(pods[0].podId, 'local-pod')
    assert.equal(pods[0].isLocal, true)
  })

  it('listPods includes remote peers', async () => {
    orch.addPeer('remote-1', makeRemotePeer())
    const pods = await orch.listPods()
    assert.equal(pods.length, 2)
    const remote = pods.find(p => p.podId === 'remote-1')
    assert.ok(remote)
    assert.equal(remote.isLocal, false)
  })

  it('listPods includes remote runtime registry peers', async () => {
    const registryOrch = makeOrchestrator({
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'browser-fp', fingerprint: 'browser-fp', aliases: [] },
          username: 'browser',
          capabilities: ['shell'],
          reachability: [{ kind: 'reverse-relay' }],
          metadata: { status: 'online', services: ['terminal'] },
        },
      ]),
    })

    const pods = await registryOrch.listPods()
    const runtimePeer = pods.find((pod) => pod.podId === 'browser-fp')
    assert.ok(runtimePeer)
    assert.equal(runtimePeer.label, 'browser')
    assert.deepEqual(runtimePeer.services, ['terminal'])
  })

  it('listPods filters by status', async () => {
    orch.addPeer('remote-1', makeRemotePeer({ status: 'online' }))
    orch.addPeer('remote-2', makeRemotePeer({ status: 'offline' }))
    const online = await orch.listPods('online')
    // local-pod is online + remote-1 is online
    assert.equal(online.length, 2)
    const offline = await orch.listPods('offline')
    assert.equal(offline.length, 1)
    assert.equal(offline[0].podId, 'remote-2')
  })

  it('listPods with "all" filter returns everything', async () => {
    orch.addPeer('remote-1', makeRemotePeer({ status: 'offline' }))
    const all = await orch.listPods('all')
    assert.equal(all.length, 2)
  })

  // -- getPodStatus ---------------------------------------------------------

  it('getPodStatus returns detailed info for local pod', async () => {
    const status = await orch.getPodStatus('local-pod')
    assert.ok(status)
    assert.equal(status.podId, 'local-pod')
    assert.equal(status.isLocal, true)
    assert.deepEqual(status.capabilities, ['wasm', 'gpu'])
    assert.equal(status.uptime, 60000)
    assert.equal(status.resources.cpu, 8)
  })

  it('getPodStatus returns detailed info for remote pod', async () => {
    orch.addPeer('remote-1', makeRemotePeer({ capabilities: ['js', 'wasm'] }))
    const status = await orch.getPodStatus('remote-1')
    assert.ok(status)
    assert.equal(status.podId, 'remote-1')
    assert.equal(status.isLocal, false)
    assert.deepEqual(status.capabilities, ['js', 'wasm'])
  })

  it('getPodStatus returns null for unknown pod', async () => {
    const status = await orch.getPodStatus('nonexistent')
    assert.equal(status, null)
  })

  it('getPodStatus falls back to the runtime registry', async () => {
    const registryOrch = makeOrchestrator({
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'vm-peer', fingerprint: 'vm-peer', aliases: [] },
          username: 'vm',
          capabilities: ['shell', 'files'],
          reachability: [{ kind: 'reverse-relay' }],
          metadata: {
            status: 'online',
            resources: { cpu: 1, memory: 512, storage: 2048 },
            services: ['ssh'],
          },
        },
      ]),
    })

    const status = await registryOrch.getPodStatus('vm-peer')
    assert.ok(status)
    assert.deepEqual(status.capabilities, ['shell', 'files'])
    assert.equal(status.resources.memory, 512)
    assert.deepEqual(status.services, ['ssh'])
  })

  // -- execOnPod ------------------------------------------------------------

  it('execOnPod delegates to peer terminal (mock)', async () => {
    orch.addPeer('remote-1', makeRemotePeer({
      exec: async (cmd) => ({ output: `ran: ${cmd}`, exitCode: 0 }),
    }))
    const result = await orch.execOnPod('remote-1', 'echo hello')
    assert.equal(result.output, 'ran: echo hello')
    assert.equal(result.exitCode, 0)
  })

  it('execOnPod falls back to send if no exec', async () => {
    let sent = null
    orch.addPeer('remote-2', makeRemotePeer({
      send: (msg) => { sent = msg },
    }))
    const result = await orch.execOnPod('remote-2', 'ls')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(sent, { type: 'exec', command: 'ls' })
  })

  it('execOnPod throws for unknown pod', async () => {
    await assert.rejects(
      () => orch.execOnPod('nonexistent', 'echo hello'),
      /not found/,
    )
  })

  it('execOnPod throws when command is empty', async () => {
    await assert.rejects(
      () => orch.execOnPod('local-pod', ''),
      /command is required/,
    )
  })

  it('execOnPod executes locally when peerNode has exec', async () => {
    const o = makeOrchestrator({
      peerNode: makePeerNode({
        exec: async (cmd) => ({ output: `local: ${cmd}`, exitCode: 0 }),
      }),
    })
    const result = await o.execOnPod('local-pod', 'pwd')
    assert.equal(result.output, 'local: pwd')
  })

  // -- deploySkill ----------------------------------------------------------

  it('deploySkill sends content to remote pod (mock)', async () => {
    let deployed = null
    orch.addPeer('remote-1', makeRemotePeer({
      deploySkill: async (content) => { deployed = content; return { success: true } },
    }))
    const result = await orch.deploySkill('remote-1', '# My Skill\nname: test')
    assert.equal(result.success, true)
    assert.equal(deployed, '# My Skill\nname: test')
  })

  it('deploySkill falls back to send', async () => {
    let sent = null
    orch.addPeer('remote-2', makeRemotePeer({
      send: (msg) => { sent = msg },
    }))
    const result = await orch.deploySkill('remote-2', 'skill content')
    assert.equal(result.success, true)
    assert.deepEqual(sent, { type: 'deploy_skill', content: 'skill content' })
  })

  it('deploySkill fails for unknown pod', async () => {
    const result = await orch.deploySkill('nonexistent', 'content')
    assert.equal(result.success, false)
    assert.match(result.error, /not found/)
  })

  it('deploySkill fails for empty content', async () => {
    orch.addPeer('remote-1', makeRemotePeer())
    const result = await orch.deploySkill('remote-1', '')
    assert.equal(result.success, false)
    assert.match(result.error, /skillContent is required/)
  })

  it('deploySkill uses the shared broker for runtime-registry peers', async () => {
    const calls = []
    const records = []
    const registryOrch = makeOrchestrator({
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'relay-peer', fingerprint: 'relay-peer', aliases: [] },
          username: 'relay',
          capabilities: ['fs'],
          reachability: [{ kind: 'reverse-relay' }],
          metadata: {
            deploymentSupport: { canDeploy: true, skillSync: true },
          },
        },
      ]),
      remoteSessionBroker: {
        async openSession(selector, opts) {
          calls.push({ selector, opts })
          return { ok: true }
        },
      },
      auditRecorder: {
        async record(operation, data) {
          records.push({ operation, data })
        },
      },
    })

    const result = await registryOrch.deploySkill('relay-peer', '# Demo Skill')

    assert.equal(result.success, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].opts.intent, 'deployment')
    assert.equal(calls[0].opts.operation, 'upload')
    assert.deepEqual(calls[0].opts.requiredCapabilities, ['fs'])
    assert.match(calls[0].opts.path, /^\/\.skills\/demo-skill\/SKILL\.md$/)
    assert.equal(records[0].operation, 'remote_deploy_started')
    assert.equal(records[1].operation, 'remote_deploy_completed')
  })

  it('deploySkill denies runtime-registry peers that do not advertise deployment support', async () => {
    const calls = []
    const records = []
    const registryOrch = makeOrchestrator({
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'relay-peer', fingerprint: 'relay-peer', aliases: [] },
          username: 'relay',
          capabilities: ['fs'],
          reachability: [{ kind: 'reverse-relay' }],
          metadata: {
            deploymentSupport: { canDeploy: false },
          },
        },
      ]),
      remoteSessionBroker: {
        async openSession(selector, opts) {
          calls.push({ selector, opts })
          return { ok: true }
        },
      },
      auditRecorder: {
        async record(operation, data) {
          records.push({ operation, data })
        },
      },
    })

    const result = await registryOrch.deploySkill('relay-peer', '# Demo Skill')

    assert.equal(result.success, false)
    assert.match(result.error, /does not advertise deployment support/i)
    assert.equal(calls.length, 0)
    assert.equal(records[0].operation, 'remote_deploy_denied')
  })

  it('listRemoteServices merges service browser and runtime-registry records', async () => {
    const registryOrch = makeOrchestrator({
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'relay-peer', fingerprint: 'relay-peer', aliases: [] },
          username: 'relay',
          capabilities: ['tools'],
          reachability: [{ kind: 'reverse-relay' }],
          metadata: {
            services: ['shell-api'],
            serviceDetails: {
              'shell-api': { type: 'terminal', metadata: { backend: 'wsh' } },
            },
          },
        },
      ]),
      serviceBrowser: {
        discover() {
          return [{ name: 'mesh-api', podId: 'mesh-peer', type: 'http-proxy' }]
        },
      },
    })

    const services = await registryOrch.listRemoteServices()

    assert.equal(services.length, 2)
    assert.ok(services.some((service) => service.name === 'mesh-api'))
    assert.ok(services.some((service) => service.name === 'shell-api' && service.source === 'runtime-registry'))
  })

  it('browseRemoteFiles and automation use the shared broker for runtime peers', async () => {
    const calls = []
    const registryOrch = makeOrchestrator({
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'relay-peer', fingerprint: 'relay-peer', aliases: [] },
          username: 'relay',
          capabilities: ['fs', 'exec'],
          reachability: [{ kind: 'reverse-relay' }],
          metadata: {},
        },
      ]),
      remoteSessionBroker: {
        async openSession(selector, opts) {
          calls.push({ selector, opts })
          if (opts.intent === 'files') {
            return { entries: [{ name: 'hello.txt', kind: 'file' }], content: 'hello world' }
          }
          return { output: 'automation ok', exitCode: 0 }
        },
      },
    })

    const files = await registryOrch.browseRemoteFiles('relay-peer', '/workspace')
    const content = await registryOrch.readRemoteFile('relay-peer', '/workspace/hello.txt')
    const automation = await registryOrch.runAutomationOnPod('relay-peer', 'echo ok')

    assert.deepEqual(files.entries, [{ name: 'hello.txt', kind: 'file' }])
    assert.equal(content, 'hello world')
    assert.equal(automation.output, 'automation ok')
    assert.equal(calls[0].opts.operation, 'list')
    assert.equal(calls[1].opts.operation, 'read')
    assert.equal(calls[2].opts.intent, 'automation')
  })

  it('listComputeCandidates merges resource registry and runtime peers', async () => {
    const registryOrch = makeOrchestrator({
      peerNode: makePeerNode({
        exec: async () => ({ output: '', exitCode: 0 }),
      }),
      resourceRegistry: {
        discover() {
          return [
            new PodResourceInfo({
              podId: 'gpu-peer',
              cpu: 16,
              memory: 32768,
              storage: 102400,
              activeTasks: 1,
              status: 'online',
            }),
          ].map((info) => ({
            toJSON() {
              return {
                podId: info.podId,
                resources: {
                  cpu: info.cpu,
                  memory: info.memory,
                  storage: info.storage,
                },
                capabilities: ['compute', 'gpu'],
                availability: info.status,
              }
            },
            source: 'resource-registry',
          }))
        },
      },
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'relay-peer', fingerprint: 'relay-peer', aliases: [] },
          username: 'relay-peer',
          capabilities: ['exec'],
          reachability: [{ kind: 'reverse-relay', health: 'online' }],
          metadata: {
            resources: { cpu: 4, memory: 4096, storage: 8192 },
          },
        },
      ]),
    })

    const candidates = await registryOrch.listComputeCandidates()

    assert.ok(candidates.some((candidate) => candidate.podId === 'local-pod'))
    assert.ok(candidates.some((candidate) => candidate.podId === 'gpu-peer'))
    assert.ok(candidates.some((candidate) => candidate.podId === 'relay-peer'))
  })

  it('runComputeTask auto-selects broker-backed runtime peers', async () => {
    const calls = []
    const records = []
    const trustUpdates = []
    const registryOrch = makeOrchestrator({
      peerNode: makePeerNode({
        exec: undefined,
        capabilities: ['wasm'],
      }),
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'relay-peer', fingerprint: 'relay-peer', aliases: [] },
          username: 'relay-peer',
          capabilities: ['exec'],
          reachability: [{ kind: 'reverse-relay', health: 'online' }],
          metadata: {
            resources: { cpu: 8, memory: 8192, storage: 16384 },
          },
        },
      ]),
      remoteSessionBroker: {
        async openSession(selector, opts) {
          calls.push({ selector, opts })
          return { output: 'compute ok', exitCode: 0 }
        },
      },
      auditRecorder: {
        async record(operation, data) {
          records.push({ operation, data })
        },
      },
      peerRegistry: {
        recordObservedTrust(fingerprint, level) {
          trustUpdates.push({ fingerprint, level })
        },
      },
    })

    const result = await registryOrch.runComputeTask({ command: 'node job.mjs' })

    assert.equal(result.podId, 'relay-peer')
    assert.equal(result.output, 'compute ok')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].selector, 'relay-peer')
    assert.equal(calls[0].opts.intent, 'automation')
    assert.equal(records[0].operation, 'remote_compute_dispatched')
    assert.equal(records[1].operation, 'remote_compute_completed')
    assert.deepEqual(trustUpdates, [{ fingerprint: 'relay-peer', level: 1 }])
  })

  it('selectComputeTarget can prefer VM runtimes when requested', () => {
    const registryOrch = makeOrchestrator({
      peerNode: makePeerNode({
        exec: undefined,
        capabilities: ['wasm'],
      }),
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'host-peer', fingerprint: 'host-peer', aliases: [] },
          username: 'host-peer',
          peerType: 'host',
          shellBackend: 'pty',
          capabilities: ['exec'],
          reachability: [{ kind: 'reverse-relay', health: 'online' }],
          metadata: { resources: { cpu: 8, memory: 8192, storage: 16384 } },
        },
        {
          identity: { canonicalId: 'vm-peer', fingerprint: 'vm-peer', aliases: [] },
          username: 'vm-peer',
          peerType: 'vm-guest',
          shellBackend: 'vm-console',
          capabilities: ['exec'],
          reachability: [{ kind: 'reverse-relay', health: 'online' }],
          metadata: { resources: { cpu: 4, memory: 4096, storage: 8192 } },
        },
      ]),
    })

    const selection = registryOrch.selectComputeTarget({
      constraints: {
        capabilities: ['compute'],
        preferRuntimeClass: 'vm-guest',
      },
    })

    assert.equal(selection.podId, 'vm-peer')
  })

  it('uses canonical runtime classes for compute target preference', () => {
    const registryOrch = makeOrchestrator({
      peerNode: makePeerNode({
        exec: undefined,
        capabilities: ['wasm'],
      }),
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'host-peer', fingerprint: 'host-peer', aliases: [] },
          username: 'host-peer',
          peerType: 'host',
          shellBackend: 'pty',
          capabilities: ['exec'],
          reachability: [{ kind: 'reverse-relay', health: 'online' }],
          metadata: {
            resources: { cpu: 8, memory: 8192, storage: 16384 },
            runtimeClasses: ['host', 'pty', 'compute'],
            deploymentSupport: { canDeploy: false },
          },
        },
        {
          identity: { canonicalId: 'deploy-peer', fingerprint: 'deploy-peer', aliases: [] },
          username: 'deploy-peer',
          peerType: 'browser-shell',
          shellBackend: 'virtual-shell',
          capabilities: ['exec', 'fs', 'tools'],
          reachability: [{ kind: 'reverse-relay', health: 'online' }],
          metadata: {
            resources: { cpu: 4, memory: 4096, storage: 8192 },
            runtimeClasses: ['browser-shell', 'virtual-shell', 'compute', 'deployer'],
            deploymentSupport: { canDeploy: true, skillSync: true, toolInjection: true },
          },
        },
      ]),
    })

    const selection = registryOrch.selectComputeTarget({
      constraints: {
        capabilities: ['compute'],
        preferRuntimeClass: 'deployer',
      },
    })

    assert.equal(selection.podId, 'deploy-peer')
  })

  it('supports guest-exec as a first-class compute runtime preference', () => {
    const registryOrch = makeOrchestrator({
      peerNode: makePeerNode({
        exec: undefined,
        capabilities: ['wasm'],
      }),
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'host-peer', fingerprint: 'host-peer', aliases: [] },
          username: 'host-peer',
          peerType: 'host',
          shellBackend: 'pty',
          capabilities: ['exec'],
          reachability: [{ kind: 'reverse-relay', health: 'online' }],
          metadata: {
            resources: { cpu: 8, memory: 8192, storage: 16384 },
            runtimeClasses: ['host', 'pty', 'compute', 'host-exec'],
          },
        },
        {
          identity: { canonicalId: 'vm-peer', fingerprint: 'vm-peer', aliases: [] },
          username: 'vm-peer',
          peerType: 'vm-guest',
          shellBackend: 'vm-console',
          capabilities: ['shell', 'exec', 'fs'],
          reachability: [{ kind: 'reverse-relay', health: 'online' }],
          metadata: {
            resources: { cpu: 4, memory: 4096, storage: 8192 },
            runtimeClasses: ['vm-guest', 'vm-console', 'compute', 'guest-exec'],
            executionApis: ['guest-exec'],
          },
        },
      ]),
    })

    const selection = registryOrch.selectComputeTarget({
      constraints: {
        capabilities: ['compute'],
        preferRuntimeClass: 'guest-exec',
      },
    })

    assert.equal(selection.podId, 'vm-peer')
  })

  // -- drainPod -------------------------------------------------------------

  it('drainPod disconnects peer and returns success', async () => {
    orch.addPeer('remote-1', makeRemotePeer())
    const result = await orch.drainPod('remote-1')
    assert.equal(result.success, true)
    assert.equal(orch.peerCount, 0)
  })

  it('drainPod invokes drain callback if available', async () => {
    let drained = false
    orch.addPeer('remote-1', makeRemotePeer({
      drain: async () => { drained = true; return { migrated: 3 } },
    }))
    const result = await orch.drainPod('remote-1')
    assert.equal(result.success, true)
    assert.equal(result.migrated, 3)
    assert.ok(drained)
  })

  it('drainPod fails for unknown pod', async () => {
    const result = await orch.drainPod('nonexistent')
    assert.equal(result.success, false)
  })

  it('drainPod marks pod as draining in listings', async () => {
    // Drain the local pod (stays in listings)
    await orch.drainPod('local-pod')
    const pods = await orch.listPods()
    assert.equal(pods[0].status, 'draining')
  })

  // -- topPods --------------------------------------------------------------

  it('topPods returns resource snapshot for local pod', async () => {
    const { pods } = await orch.topPods()
    assert.equal(pods.length, 1)
    assert.equal(pods[0].podId, 'local-pod')
    assert.equal(pods[0].cpu, 8)
    assert.equal(pods[0].memory, 16384)
    assert.equal(pods[0].activeTasks, 2)
  })

  it('topPods includes remote peers', async () => {
    orch.addPeer('remote-1', makeRemotePeer({ activeTasks: 5 }))
    const { pods } = await orch.topPods()
    assert.equal(pods.length, 2)
    const remote = pods.find(p => p.podId === 'remote-1')
    assert.ok(remote)
    assert.equal(remote.activeTasks, 5)
  })

  it('topPods includes runtime registry peers', async () => {
    const registryOrch = makeOrchestrator({
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'relay-peer', fingerprint: 'relay-peer', aliases: [] },
          username: 'relay-peer',
          capabilities: ['exec'],
          reachability: [{ kind: 'reverse-relay' }],
          metadata: {
            status: 'online',
            resources: { cpu: 2, memory: 1024, storage: 4096 },
            activeTasks: 3,
          },
        },
      ]),
    })

    const { pods } = await registryOrch.topPods()
    const remote = pods.find((pod) => pod.podId === 'relay-peer')
    assert.ok(remote)
    assert.equal(remote.cpu, 2)
    assert.equal(remote.activeTasks, 3)
  })

  it('execOnPod uses the remote session broker for runtime registry peers', async () => {
    let called = null
    const registryOrch = makeOrchestrator({
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'relay-peer', fingerprint: 'relay-peer', aliases: [] },
          username: 'relay-peer',
          capabilities: ['exec'],
          reachability: [{ kind: 'reverse-relay' }],
          metadata: { status: 'online' },
        },
      ]),
      remoteSessionBroker: {
        openSession: async (selector, opts) => {
          called = { selector, opts }
          return { output: 'relay exec', exitCode: 0 }
        },
      },
    })

    const result = await registryOrch.execOnPod('relay-peer', 'printf hello')
    assert.equal(result.output, 'relay exec')
    assert.deepEqual(called, {
      selector: 'relay-peer',
      opts: { intent: 'exec', command: 'printf hello' },
    })
  })

  // -- exposePod / routeService ---------------------------------------------

  it('exposePod registers a service', async () => {
    const result = await orch.exposePod('local-pod', 8080, 'web')
    assert.equal(result.success, true)
    assert.equal(result.address, 'local-pod:8080')
  })

  it('exposePod shows up in listPods services', async () => {
    await orch.exposePod('local-pod', 8080, 'web')
    const pods = await orch.listPods()
    assert.ok(pods[0].services.includes('web'))
  })

  it('exposePod calls serviceAdvertiser if available', async () => {
    let advertised = null
    const o = makeOrchestrator({
      serviceAdvertiser: { advertise: (svc) => { advertised = svc } },
    })
    await o.exposePod('local-pod', 3000, 'api')
    assert.deepEqual(advertised, { name: 'api', type: 'http-proxy', podId: 'local-pod', port: 3000 })
  })

  it('exposePod fails with invalid port', async () => {
    const result = await orch.exposePod('local-pod', 0, 'web')
    assert.equal(result.success, false)
  })

  it('routeService registers a route', async () => {
    const result = await orch.routeService('db', 'remote-1')
    assert.equal(result.success, true)
  })

  it('routeService calls router.addRoute if available', async () => {
    let routed = null
    const o = makeOrchestrator({
      router: { addRoute: (target, nextHop, hops) => { routed = { target, nextHop, hops } } },
    })
    await o.routeService('api', 'pod-x')
    assert.deepEqual(routed, { target: 'pod-x', nextHop: 'pod-x', hops: 1 })
  })

  it('routeService fails with empty name', async () => {
    const result = await orch.routeService('', 'pod-x')
    assert.equal(result.success, false)
  })

  // -- tunnelPort -----------------------------------------------------------

  it('tunnelPort creates a tunnel', async () => {
    const result = await orch.tunnelPort('remote-1', 5432, 15432)
    assert.equal(result.success, true)
    assert.ok(result.tunnelId)
    assert.match(result.tunnelId, /^tunnel_/)
  })

  it('tunnelPort fails with invalid port', async () => {
    const result = await orch.tunnelPort('remote-1', 0, 15432)
    assert.equal(result.success, false)
  })

  // -- peer management ------------------------------------------------------

  it('addPeer / removePeer manage known peers', () => {
    orch.addPeer('remote-1', makeRemotePeer())
    assert.equal(orch.peerCount, 1)
    orch.removePeer('remote-1')
    assert.equal(orch.peerCount, 0)
  })

  it('removePeer returns false for unknown peer', () => {
    assert.equal(orch.removePeer('nope'), false)
  })
})

// ---------------------------------------------------------------------------
// BrowserTool subclasses — shared basics
// ---------------------------------------------------------------------------

describe('BrowserTool subclasses — basics', () => {
  let orch
  let tools

  beforeEach(() => {
    orch = makeOrchestrator()
    tools = createMeshctlTools(orch)
  })

  it('createMeshctlTools returns array of 8 tools', () => {
    assert.equal(tools.length, 8)
  })

  it('all have unique names', () => {
    const names = tools.map(t => t.name)
    assert.equal(new Set(names).size, 8)
  })

  it('all have descriptions', () => {
    for (const tool of tools) {
      assert.ok(tool.description.length > 0, `${tool.name} needs description`)
    }
  })

  it('all have parameters with type object', () => {
    for (const tool of tools) {
      assert.equal(tool.parameters.type, 'object', `${tool.name} params`)
    }
  })

  it('all have correct permission levels', () => {
    const expected = {
      meshctl_pods: 'read',
      meshctl_status: 'read',
      meshctl_exec: 'network',
      meshctl_deploy: 'write',
      meshctl_top: 'read',
      meshctl_compute: 'network',
      meshctl_expose: 'network',
      meshctl_drain: 'network',
    }
    for (const tool of tools) {
      assert.equal(tool.permission, expected[tool.name], `${tool.name} permission`)
    }
  })

  it('tool names are meshctl_pods, meshctl_status, meshctl_exec, meshctl_deploy, meshctl_top, meshctl_compute, meshctl_expose, meshctl_drain', () => {
    const names = tools.map(t => t.name).sort()
    assert.deepEqual(names, [
      'meshctl_compute',
      'meshctl_deploy',
      'meshctl_drain',
      'meshctl_exec',
      'meshctl_expose',
      'meshctl_pods',
      'meshctl_status',
      'meshctl_top',
    ])
  })
})

// ---------------------------------------------------------------------------
// MeshctlPodsTool
// ---------------------------------------------------------------------------

describe('MeshctlPodsTool', () => {
  let orch, tool

  beforeEach(() => {
    orch = makeOrchestrator()
    tool = new MeshctlPodsTool(orch)
  })

  it('lists pods with success', async () => {
    const result = await tool.execute()
    assert.ok(result.success)
    assert.match(result.output, /local-pod/)
    assert.match(result.output, /local/)
  })

  it('includes remote pods', async () => {
    orch.addPeer('remote-1', makeRemotePeer())
    const result = await tool.execute()
    assert.ok(result.success)
    assert.match(result.output, /remote-1/)
  })

  it('filters by status', async () => {
    orch.addPeer('remote-1', makeRemotePeer({ status: 'offline' }))
    const result = await tool.execute({ filter: 'offline' })
    assert.ok(result.success)
    assert.match(result.output, /remote-1/)
    // local-pod is online, should not appear
    assert.ok(!result.output.includes('local-pod'))
  })
})

// ---------------------------------------------------------------------------
// MeshctlStatusTool
// ---------------------------------------------------------------------------

describe('MeshctlStatusTool', () => {
  let orch, tool

  beforeEach(() => {
    orch = makeOrchestrator()
    tool = new MeshctlStatusTool(orch)
  })

  it('returns detailed status', async () => {
    const result = await tool.execute({ podId: 'local-pod' })
    assert.ok(result.success)
    assert.match(result.output, /local-pod/)
    assert.match(result.output, /wasm/)
    assert.match(result.output, /cpu=8/)
  })

  it('returns error for unknown pod', async () => {
    const result = await tool.execute({ podId: 'nonexistent' })
    assert.equal(result.success, false)
    assert.match(result.error, /not found/)
  })
})

// ---------------------------------------------------------------------------
// MeshctlExecTool
// ---------------------------------------------------------------------------

describe('MeshctlExecTool', () => {
  let orch, tool

  beforeEach(() => {
    orch = makeOrchestrator()
    tool = new MeshctlExecTool(orch)
  })

  it('executes and returns output', async () => {
    orch.addPeer('remote-1', makeRemotePeer({
      exec: async (cmd) => ({ output: `result: ${cmd}`, exitCode: 0 }),
    }))
    const result = await tool.execute({ podId: 'remote-1', command: 'ls' })
    assert.ok(result.success)
    assert.match(result.output, /result: ls/)
  })

  it('returns error on non-zero exit code', async () => {
    orch.addPeer('remote-1', makeRemotePeer({
      exec: async () => ({ output: 'fail', exitCode: 1 }),
    }))
    const result = await tool.execute({ podId: 'remote-1', command: 'bad' })
    assert.equal(result.success, false)
    assert.match(result.error, /Exit code/)
  })

  it('returns error for unknown pod', async () => {
    const result = await tool.execute({ podId: 'nonexistent', command: 'ls' })
    assert.equal(result.success, false)
    assert.match(result.error, /not found/)
  })
})

// ---------------------------------------------------------------------------
// MeshctlDeployTool
// ---------------------------------------------------------------------------

describe('MeshctlDeployTool', () => {
  let orch, tool

  beforeEach(() => {
    orch = makeOrchestrator()
    tool = new MeshctlDeployTool(orch)
  })

  it('deploys skill and returns success', async () => {
    orch.addPeer('remote-1', makeRemotePeer({
      deploySkill: async () => ({ success: true }),
    }))
    const result = await tool.execute({ podId: 'remote-1', skillContent: '# Skill\nname: test' })
    assert.ok(result.success)
    assert.match(result.output, /deployed/i)
  })

  it('returns error for unknown pod', async () => {
    const result = await tool.execute({ podId: 'nonexistent', skillContent: 'content' })
    assert.equal(result.success, false)
    assert.match(result.error, /not found/)
  })

  it('returns error for empty content', async () => {
    orch.addPeer('remote-1', makeRemotePeer())
    const result = await tool.execute({ podId: 'remote-1', skillContent: '' })
    assert.equal(result.success, false)
  })
})

// ---------------------------------------------------------------------------
// MeshctlTopTool
// ---------------------------------------------------------------------------

describe('MeshctlTopTool', () => {
  let orch, tool

  beforeEach(() => {
    orch = makeOrchestrator()
    tool = new MeshctlTopTool(orch)
  })

  it('returns resource snapshot', async () => {
    const result = await tool.execute()
    assert.ok(result.success)
    assert.match(result.output, /local-pod/)
    assert.match(result.output, /cpu: 8/)
    assert.match(result.output, /mem: 16384/)
  })

  it('includes remote peers', async () => {
    orch.addPeer('remote-1', makeRemotePeer())
    const result = await tool.execute()
    assert.ok(result.success)
    assert.match(result.output, /remote-1/)
  })
})

// ---------------------------------------------------------------------------
// MeshctlComputeTool
// ---------------------------------------------------------------------------

describe('MeshctlComputeTool', () => {
  let orch, tool

  beforeEach(() => {
    orch = makeOrchestrator({
      peerNode: makePeerNode({
        exec: async (cmd) => ({ output: `computed: ${cmd}`, exitCode: 0 }),
      }),
    })
    tool = new MeshctlComputeTool(orch)
  })

  it('runs compute tasks and returns output', async () => {
    const result = await tool.execute({ podId: 'local-pod', command: 'npm test' })
    assert.ok(result.success)
    assert.match(result.output, /\[local-pod\] computed: npm test/)
  })

  it('returns an error when compute execution fails', async () => {
    orch = makeOrchestrator({
      peerNode: makePeerNode({
        exec: async () => ({ output: 'boom', exitCode: 2 }),
      }),
    })
    tool = new MeshctlComputeTool(orch)
    const result = await tool.execute({ podId: 'local-pod', command: 'npm test' })
    assert.equal(result.success, false)
    assert.match(result.error, /Exit code: 2/)
  })
})

// ---------------------------------------------------------------------------
// MeshctlExposeTool
// ---------------------------------------------------------------------------

describe('MeshctlExposeTool', () => {
  let orch, tool

  beforeEach(() => {
    orch = makeOrchestrator()
    tool = new MeshctlExposeTool(orch)
  })

  it('exposes a service', async () => {
    const result = await tool.execute({ port: 8080, name: 'web' })
    assert.ok(result.success)
    assert.match(result.output, /web/)
    assert.match(result.output, /8080/)
  })

  it('uses provided podId', async () => {
    orch.addPeer('remote-1', makeRemotePeer())
    const result = await tool.execute({ podId: 'remote-1', port: 3000, name: 'api' })
    assert.ok(result.success)
    assert.match(result.output, /remote-1:3000/)
  })
})

// ---------------------------------------------------------------------------
// MeshctlDrainTool
// ---------------------------------------------------------------------------

describe('MeshctlDrainTool', () => {
  let orch, tool

  beforeEach(() => {
    orch = makeOrchestrator()
    tool = new MeshctlDrainTool(orch)
  })

  it('drains a pod', async () => {
    orch.addPeer('remote-1', makeRemotePeer())
    const result = await tool.execute({ podId: 'remote-1' })
    assert.ok(result.success)
    assert.match(result.output, /drained/i)
  })

  it('returns error for unknown pod', async () => {
    const result = await tool.execute({ podId: 'nonexistent' })
    assert.equal(result.success, false)
    assert.match(result.error, /not found/)
  })
})

// ---------------------------------------------------------------------------
// registerMeshctlBuiltins
// ---------------------------------------------------------------------------

describe('registerMeshctlBuiltins', () => {
  it('registers meshctl command', () => {
    const registered = {}
    const shellRegistry = {
      register(name, handler, meta) { registered[name] = { handler, meta } },
    }
    const orch = makeOrchestrator()
    registerMeshctlBuiltins(shellRegistry, orch)
    assert.ok(registered.meshctl)
    assert.equal(registered.meshctl.meta.category, 'mesh')
  })

  it('meshctl pods subcommand works', async () => {
    const registered = {}
    const shellRegistry = {
      register(name, handler, meta) { registered[name] = { handler, meta } },
    }
    const orch = makeOrchestrator()
    registerMeshctlBuiltins(shellRegistry, orch)
    const result = await registered.meshctl.handler({ args: ['pods'] })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /local-pod/)
  })

  it('meshctl status subcommand requires podId', async () => {
    const registered = {}
    const shellRegistry = {
      register(name, handler, meta) { registered[name] = { handler, meta } },
    }
    const orch = makeOrchestrator()
    registerMeshctlBuiltins(shellRegistry, orch)
    const result = await registered.meshctl.handler({ args: ['status'] })
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /Usage/)
  })

  it('meshctl unknown subcommand returns error', async () => {
    const registered = {}
    const shellRegistry = {
      register(name, handler, meta) { registered[name] = { handler, meta } },
    }
    const orch = makeOrchestrator()
    registerMeshctlBuiltins(shellRegistry, orch)
    const result = await registered.meshctl.handler({ args: ['bogus'] })
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /Unknown subcommand/)
  })

  it('meshctl top subcommand returns resource info', async () => {
    const registered = {}
    const shellRegistry = {
      register(name, handler, meta) { registered[name] = { handler, meta } },
    }
    const orch = makeOrchestrator()
    registerMeshctlBuiltins(shellRegistry, orch)
    const result = await registered.meshctl.handler({ args: ['top'] })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /local-pod/)
  })

  it('meshctl compute subcommand auto-selects a target', async () => {
    const registered = {}
    const shellRegistry = {
      register(name, handler, meta) { registered[name] = { handler, meta } },
    }
    const orch = makeOrchestrator({
      peerNode: makePeerNode({
        exec: async (cmd) => ({ output: `computed: ${cmd}`, exitCode: 0 }),
      }),
    })
    registerMeshctlBuiltins(shellRegistry, orch)
    const result = await registered.meshctl.handler({ args: ['compute', 'auto', 'npm', 'test'] })
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /\[local-pod\] computed: npm test/)
  })

  it('meshctl expose subcommand requires all args', async () => {
    const registered = {}
    const shellRegistry = {
      register(name, handler, meta) { registered[name] = { handler, meta } },
    }
    const orch = makeOrchestrator()
    registerMeshctlBuiltins(shellRegistry, orch)
    const result = await registered.meshctl.handler({ args: ['expose', 'pod-a'] })
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /Usage/)
  })

  it('meshctl drain subcommand requires podId', async () => {
    const registered = {}
    const shellRegistry = {
      register(name, handler, meta) { registered[name] = { handler, meta } },
    }
    const orch = makeOrchestrator()
    registerMeshctlBuiltins(shellRegistry, orch)
    const result = await registered.meshctl.handler({ args: ['drain'] })
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /Usage/)
  })
})
