import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { MeshInspector, MeshInspectTool } from '../src/devtools.mjs'

function makeState(overrides = {}) {
  return {
    pod: { podId: 'test-pod', state: 'running' },
    peerNode: { podId: 'test-pod', state: 'running', peerCount: 2 },
    swarmCoordinator: { listSwarms: () => ['swarm-1'] },
    discoveryManager: {},
    transportNegotiator: {},
    auditChain: { length: 5 },
    streamMultiplexer: {},
    fileTransfer: {},
    serviceDirectory: {},
    syncEngine: {},
    resourceRegistry: { listAll: () => [] },
    meshMarketplace: { getStats: () => ({ totalListings: 0, activeListings: 0, totalReviews: 0, avgRating: 0 }) },
    quotaManager: {},
    quotaEnforcer: {},
    paymentRouter: {},
    consensusManager: { size: 0 },
    relayClient: {},
    nameResolver: {},
    appRegistry: { getStats: () => ({ totalInstalled: 0, running: 0, paused: 0, stopped: 0 }) },
    appStore: {},
    orchestrator: { peerCount: 0 },
    ...overrides,
  }
}

describe('MeshInspector', () => {
  it('constructor requires state', () => {
    assert.throws(() => new MeshInspector(), /state is required/)
    assert.throws(() => new MeshInspector(null), /state is required/)
  })

  it('snapshot returns all expected keys', () => {
    const inspector = new MeshInspector(makeState())
    const snap = inspector.snapshot()
    const expectedKeys = [
      'pod', 'peerNode', 'swarm', 'discovery', 'transport', 'audit',
      'streams', 'files', 'services', 'sync', 'resources', 'marketplace',
      'quotas', 'payments', 'consensus', 'relay', 'naming', 'apps', 'orchestrator',
      'connectivity',
    ]
    for (const key of expectedKeys) {
      assert.ok(key in snap, `snapshot missing key: ${key}`)
    }
    assert.equal(snap.pod.podId, 'test-pod')
    assert.equal(snap.peerNode.peerCount, 2)
    assert.equal(snap.swarm.swarmCount, 1)
    assert.equal(snap.audit.entryCount, 5)
  })

  it('connectivity is inactive with empty stats when webrtcMeshManager is absent', () => {
    const inspector = new MeshInspector(makeState())
    const snap = inspector.snapshot()
    assert.equal(snap.connectivity.active, false)
    assert.equal(snap.connectivity.connectionCount, 0)
    assert.deepEqual(snap.connectivity.stats, [])
  })

  it('connectivity reflects webrtcMeshManager connectionCount and cached lastStats', () => {
    const inspector = new MeshInspector(makeState({
      webrtcMeshManager: {
        connectionCount: 2,
        lastStats: [{ remotePodId: 'p1', roundTripTime: 0.05, packetLossRatio: 0 }],
      },
    }))
    const snap = inspector.snapshot()
    assert.equal(snap.connectivity.active, true)
    assert.equal(snap.connectivity.connectionCount, 2)
    assert.equal(snap.connectivity.stats.length, 1)
    assert.equal(snap.connectivity.stats[0].remotePodId, 'p1')
  })

  it('healthCheck returns healthy for full state', () => {
    const inspector = new MeshInspector(makeState())
    const result = inspector.healthCheck()
    assert.equal(result.overall, 'healthy')
    assert.ok(Array.isArray(result.checks))
    assert.ok(result.checks.every(c => c.status === 'ok'))
  })

  it('healthCheck returns unhealthy when pod is null', () => {
    const inspector = new MeshInspector(makeState({ pod: null }))
    const result = inspector.healthCheck()
    assert.equal(result.overall, 'unhealthy')
    const podCheck = result.checks.find(c => c.name === 'pod')
    assert.equal(podCheck.status, 'missing')
  })

  it('healthCheck returns degraded when a few subsystems are null', () => {
    const inspector = new MeshInspector(makeState({
      relayClient: null,
      nameResolver: null,
    }))
    const result = inspector.healthCheck()
    assert.equal(result.overall, 'degraded')
    const missingChecks = result.checks.filter(c => c.status === 'missing')
    assert.equal(missingChecks.length, 2)
  })

  it('toMarkdownReport returns a string with expected content', () => {
    const inspector = new MeshInspector(makeState())
    const report = inspector.toMarkdownReport()
    assert.equal(typeof report, 'string')
    assert.ok(report.includes('# Mesh Inspector Report'))
    assert.ok(report.includes('**Overall Health:** healthy'))
    assert.ok(report.includes('test-pod'))
    assert.ok(report.includes('## Health Checks'))
  })
})

describe('MeshInspectTool', () => {
  it('name is mesh_inspect', () => {
    const tool = new MeshInspectTool(makeState())
    assert.equal(tool.name, 'mesh_inspect')
  })

  it('permission is read', () => {
    const tool = new MeshInspectTool(makeState())
    assert.equal(tool.permission, 'read')
  })

  it('execute() with no section returns full snapshot', async () => {
    const tool = new MeshInspectTool(makeState())
    const result = await tool.execute()
    assert.equal(result.success, true)
    const parsed = JSON.parse(result.output)
    assert.ok('pod' in parsed)
    assert.ok('peerNode' in parsed)
    assert.ok('swarm' in parsed)
  })

  it('execute({ section: "health" }) returns health check', async () => {
    const tool = new MeshInspectTool(makeState())
    const result = await tool.execute({ section: 'health' })
    assert.equal(result.success, true)
    const parsed = JSON.parse(result.output)
    assert.equal(parsed.overall, 'healthy')
    assert.ok(Array.isArray(parsed.checks))
  })

  it('execute({ section: "pod" }) returns pod info', async () => {
    const tool = new MeshInspectTool(makeState())
    const result = await tool.execute({ section: 'pod' })
    assert.equal(result.success, true)
    const parsed = JSON.parse(result.output)
    assert.equal(parsed.podId, 'test-pod')
    assert.equal(parsed.state, 'running')
  })

  it('execute({ section: "report" }) returns markdown', async () => {
    const tool = new MeshInspectTool(makeState())
    const result = await tool.execute({ section: 'report' })
    assert.equal(result.success, true)
    assert.ok(result.output.includes('# Mesh Inspector Report'))
  })
})
