import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

// Stub BrowserTool
globalThis.BrowserTool = globalThis.BrowserTool || class { constructor() {} }

import {
  MeshPeerToolsContext,
  peerToolsContext,
  MeshChatCreateRoomTool,
  MeshChatSendTool,
  MeshChatHistoryTool,
  MeshChatListRoomsTool,
  MeshSchedulerSubmitTool,
  MeshSchedulerListTool,
  FederatedComputeSubmitTool,
  SwarmCreateTool,
  SwarmStatusTool,
  MeshHealthStatusTool,
  EscrowCreateTool,
  EscrowListTool,
  EscrowReleaseTool,
  MeshRouterAddRouteTool,
  MeshRouterLookupTool,
  TimestampProofTool,
  StealthSaveTool,
  StealthRestoreTool,
  MeshACLAddEntryTool,
  MeshACLListTool,
  MeshACLCheckTool,
  MeshSessionListTool,
  MeshGatewayStatusTool,
  TorrentSeedTool,
  IpfsStoreTool,
  IpfsRetrieveTool,
  CreditBalanceTool,
  MeshMigrationStatusTool,
  DeltaSyncStatusTool,
  registerMeshPeerTools,
} from '../src/peer-tools.mjs'

describe('MeshPeerToolsContext', () => {
  it('is exported as a singleton', () => {
    assert.ok(peerToolsContext instanceof MeshPeerToolsContext)
  })

  it('round-trips all setters/getters', () => {
    const ctx = new MeshPeerToolsContext()
    const sentinel = { id: 'test' }
    const pairs = [
      ['MeshChat', 'getMeshChat', 'setMeshChat'],
      ['MeshScheduler', 'getMeshScheduler', 'setMeshScheduler'],
      ['FederatedCompute', 'getFederatedCompute', 'setFederatedCompute'],
      ['AgentSwarmCoordinator', 'getAgentSwarmCoordinator', 'setAgentSwarmCoordinator'],
      ['HealthMonitor', 'getHealthMonitor', 'setHealthMonitor'],
      ['EscrowManager', 'getEscrowManager', 'setEscrowManager'],
      ['MeshRouter', 'getMeshRouter', 'setMeshRouter'],
      ['TimestampAuthority', 'getTimestampAuthority', 'setTimestampAuthority'],
      ['StealthAgent', 'getStealthAgent', 'setStealthAgent'],
      ['SyncCoordinator', 'getSyncCoordinator', 'setSyncCoordinator'],
      ['GatewayNode', 'getGatewayNode', 'setGatewayNode'],
      ['TorrentManager', 'getTorrentManager', 'setTorrentManager'],
      ['IpfsStore', 'getIpfsStore', 'setIpfsStore'],
      ['MeshACL', 'getMeshACL', 'setMeshACL'],
      ['CapabilityValidator', 'getCapabilityValidator', 'setCapabilityValidator'],
      ['SessionManager', 'getSessionManager', 'setSessionManager'],
      ['CrossOriginBridge', 'getCrossOriginBridge', 'setCrossOriginBridge'],
      ['VerificationQuorum', 'getVerificationQuorum', 'setVerificationQuorum'],
      ['MigrationEngine', 'getMigrationEngine', 'setMigrationEngine'],
      ['CreditLedger', 'getCreditLedger', 'setCreditLedger'],
    ]
    for (const [, getter, setter] of pairs) {
      assert.equal(ctx[getter](), null)
      ctx[setter](sentinel)
      assert.equal(ctx[getter](), sentinel)
    }
  })
})

describe('Tool class exports', () => {
  const toolClasses = [
    MeshChatCreateRoomTool,
    MeshChatSendTool,
    MeshChatHistoryTool,
    MeshChatListRoomsTool,
    MeshSchedulerSubmitTool,
    MeshSchedulerListTool,
    FederatedComputeSubmitTool,
    SwarmCreateTool,
    SwarmStatusTool,
    MeshHealthStatusTool,
    EscrowCreateTool,
    EscrowListTool,
    EscrowReleaseTool,
    MeshRouterAddRouteTool,
    MeshRouterLookupTool,
    TimestampProofTool,
    StealthSaveTool,
    StealthRestoreTool,
    MeshACLAddEntryTool,
    MeshACLListTool,
    MeshACLCheckTool,
    MeshSessionListTool,
    MeshGatewayStatusTool,
    TorrentSeedTool,
    IpfsStoreTool,
    IpfsRetrieveTool,
    CreditBalanceTool,
    MeshMigrationStatusTool,
    DeltaSyncStatusTool,
  ]

  for (const ToolClass of toolClasses) {
    it(`${ToolClass.name} has name, description, parameters, permission, execute`, () => {
      const tool = new ToolClass()
      assert.equal(typeof tool.name, 'string')
      assert.ok(tool.name.length > 0)
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 0)
      assert.equal(typeof tool.parameters, 'object')
      assert.equal(tool.parameters.type, 'object')
      assert.equal(typeof tool.permission, 'string')
      assert.equal(typeof tool.execute, 'function')
    })
  }
})

describe('Tools graceful fallback when context is empty', () => {
  let ctx

  beforeEach(() => {
    ctx = new MeshPeerToolsContext()
    // Clear the singleton — tests should use fresh context
  })

  it('MeshChatListRoomsTool returns fallback when chat not set', async () => {
    // peerToolsContext defaults to null
    const tool = new MeshChatListRoomsTool()
    const result = await tool.execute()
    assert.equal(result.success, true)
    assert.ok(result.output.includes('not initialized'))
  })

  it('MeshSchedulerListTool returns fallback when scheduler not set', async () => {
    const tool = new MeshSchedulerListTool()
    const result = await tool.execute()
    assert.equal(result.success, true)
    assert.ok(result.output.includes('not initialized'))
  })

  it('MeshHealthStatusTool returns fallback when monitor not set', async () => {
    const tool = new MeshHealthStatusTool()
    const result = await tool.execute()
    assert.equal(result.success, true)
    assert.ok(result.output.includes('not initialized'))
  })

  it('EscrowListTool returns fallback when escrow not set', async () => {
    const tool = new EscrowListTool()
    const result = await tool.execute()
    assert.equal(result.success, true)
    assert.ok(result.output.includes('not initialized'))
  })

  it('MeshSessionListTool returns fallback when session mgr not set', async () => {
    const tool = new MeshSessionListTool()
    const result = await tool.execute()
    assert.equal(result.success, true)
    assert.ok(result.output.includes('not initialized'))
  })

  it('MeshGatewayStatusTool returns fallback when gateway not set', async () => {
    const tool = new MeshGatewayStatusTool()
    const result = await tool.execute()
    assert.equal(result.success, true)
    assert.ok(result.output.includes('not initialized'))
  })

  it('DeltaSyncStatusTool returns fallback when coordinator not set', async () => {
    const tool = new DeltaSyncStatusTool()
    const result = await tool.execute()
    assert.equal(result.success, true)
    assert.ok(result.output.includes('not initialized'))
  })

  it('MeshMigrationStatusTool returns fallback when engine not set', async () => {
    const tool = new MeshMigrationStatusTool()
    const result = await tool.execute()
    assert.equal(result.success, true)
    assert.ok(result.output.includes('not initialized'))
  })

  it('CreditBalanceTool returns fallback when ledger not set', async () => {
    const tool = new CreditBalanceTool()
    const result = await tool.execute()
    assert.equal(result.success, true)
    assert.ok(result.output.includes('not initialized'))
  })
})

describe('EscrowCreateTool / EscrowReleaseTool — real manager API', () => {
  // Regression test for a real bug: these tools called mgr.createEscrow()/
  // mgr.releaseEscrow(), but EscrowManager's actual methods are create()/
  // release() with an options-object signature. Registration-only tests
  // (above) never caught this since they don't invoke execute(). Uses a
  // duck-typed fake matching EscrowManager's real public API (peer-escrow.mjs),
  // not a mock of the bug's assumed API.
  afterEach(() => {
    peerToolsContext.setEscrowManager(null)
    peerToolsContext.setTorrentManager(null)
  })

  it('EscrowCreateTool calls the real create(opts) API, not createEscrow(...)', async () => {
    const calls = []
    const fakeMgr = {
      create(opts) {
        calls.push(opts)
        return { id: 'escrow-1' }
      },
    }
    peerToolsContext.setEscrowManager(fakeMgr)

    const tool = new EscrowCreateTool()
    const result = await tool.execute({
      payer: 'pod-a', payee: 'pod-b', amount: 50,
      description: 'test contract', conditions: [{ type: 'manual' }],
    })

    assert.equal(result.success, true)
    assert.ok(result.output.includes('escrow-1'))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].payerPodId, 'pod-a')
    assert.equal(calls[0].payeePodId, 'pod-b')
    assert.equal(calls[0].amount, 50)
    assert.equal(calls[0].description, 'test contract')
  })

  it('EscrowReleaseTool calls the real release(contractId) API, not releaseEscrow(...)', async () => {
    const calls = []
    const fakeMgr = { release(contractId) { calls.push(contractId) } }
    peerToolsContext.setEscrowManager(fakeMgr)

    const tool = new EscrowReleaseTool()
    const result = await tool.execute({ contractId: 'escrow-1' })

    assert.equal(result.success, true)
    assert.deepEqual(calls, ['escrow-1'])
  })
})

describe('TorrentSeedTool — real manager API', () => {
  // Regression test for a real bug: the tool called tm.seed(name, data) —
  // TorrentManager.seed(data, opts) takes data FIRST, so the filename was
  // being seeded as the actual torrent content.
  afterEach(() => {
    peerToolsContext.setTorrentManager(null)
  })

  it('TorrentSeedTool passes data first, name inside opts — not swapped', async () => {
    const calls = []
    const fakeMgr = {
      async seed(data, opts) {
        calls.push({ data, opts })
        return { infoHash: 'abc123' }
      },
    }
    peerToolsContext.setTorrentManager(fakeMgr)

    const tool = new TorrentSeedTool()
    const result = await tool.execute({ name: 'notes.txt', data: 'hello world' })

    assert.equal(result.success, true)
    assert.equal(calls.length, 1)
    // The real file content must be the `data` positional arg, not the name.
    assert.equal(calls[0].data, 'hello world')
    assert.equal(calls[0].opts.name, 'notes.txt')
  })
})

describe('registerMeshPeerTools', () => {
  it('registers all 29 tools with a mock registry', () => {
    const registered = new Map()
    const mockRegistry = {
      register(tool) { registered.set(tool.name, tool) },
    }
    registerMeshPeerTools(mockRegistry, {})
    assert.equal(registered.size, 29)
    // Spot check a few
    assert.ok(registered.has('mesh_chat_create_room'))
    assert.ok(registered.has('mesh_scheduler_submit'))
    assert.ok(registered.has('federated_compute_submit'))
    assert.ok(registered.has('agent_swarm_create'))
    assert.ok(registered.has('mesh_health_status'))
    assert.ok(registered.has('escrow_create'))
    assert.ok(registered.has('mesh_router_add_route'))
    assert.ok(registered.has('mesh_timestamp_proof'))
    assert.ok(registered.has('stealth_save'))
    assert.ok(registered.has('mesh_acl_add'))
    assert.ok(registered.has('mesh_session_list'))
    assert.ok(registered.has('mesh_gateway_status'))
    assert.ok(registered.has('torrent_seed'))
    assert.ok(registered.has('ipfs_store'))
    assert.ok(registered.has('credit_balance'))
    assert.ok(registered.has('mesh_migration_status'))
    assert.ok(registered.has('delta_sync_status'))
  })

  it('wires deps into context', () => {
    const mockRegistry = { register() {} }
    const deps = {
      meshChat: { id: 'chat' },
      meshScheduler: { id: 'sched' },
      healthMonitor: { id: 'health' },
    }
    registerMeshPeerTools(mockRegistry, deps)
    assert.equal(peerToolsContext.getMeshChat(), deps.meshChat)
    assert.equal(peerToolsContext.getMeshScheduler(), deps.meshScheduler)
    assert.equal(peerToolsContext.getHealthMonitor(), deps.healthMonitor)
  })
})
