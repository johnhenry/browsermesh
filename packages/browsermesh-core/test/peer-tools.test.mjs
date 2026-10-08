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
import { BrowserToolRegistry } from '../src/compat.mjs'
// Real StealthAgent + DhtNode (cross-package relative import, like hardening.test.mjs)
import { StealthAgent } from '../../browsermesh-discovery/src/stealth.mjs'
import { DhtNode } from '../../browsermesh-discovery/src/dht.mjs'

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

describe('MeshSchedulerSubmitTool — real cross-package ScheduledTask import', () => {
  // Regression test for a real bug: this tool dynamically imported
  // ScheduledTask via a monorepo-relative path
  // ('../../browsermesh-apps/src/scheduler.mjs') that only ever resolved
  // inside this workspace -- any standalone consumer installing both
  // packages via npm (e.g. clawser) would hit ERR_MODULE_NOT_FOUND on
  // every real invocation, since esm.sh/node_modules resolution has no
  // concept of monorepo-relative paths. Fixed to import the real package
  // NAME (`@johnhenry/browsermesh-apps`), matching the lazy-optional-peer
  // pattern already established for `@johnhenry/andbox`. This test relies
  // on browsermesh-apps being a real, installed sibling workspace package
  // here (which it genuinely is in this monorepo) -- it exercises the
  // real import and the real ScheduledTask shape, not a mock of it.
  afterEach(() => {
    peerToolsContext.setMeshScheduler(null)
  })

  it('imports the real ScheduledTask and submits it to the scheduler', async () => {
    const submitted = []
    const fakeSched = {
      async submit(task) {
        submitted.push(task)
        return 'task-1'
      },
    }
    peerToolsContext.setMeshScheduler(fakeSched)

    const tool = new MeshSchedulerSubmitTool()
    const result = await tool.execute({ type: 'compute', payload: { x: 1 }, priority: 'high' })

    assert.equal(result.success, true, result.error)
    assert.ok(result.output.includes('task-1'))
    assert.equal(submitted.length, 1)
    assert.equal(submitted[0].constructor.name, 'ScheduledTask')
    assert.equal(submitted[0].type, 'compute')
    assert.deepEqual(submitted[0].payload, { x: 1 })
    assert.equal(submitted[0].priority, 'high')
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

  function recordingManager() {
    const calls = []
    return {
      calls,
      async seed(data, opts) {
        calls.push({ data, opts })
        return { infoHash: 'abc123', magnetURI: 'magnet:?xt=urn:btih:abc123', size: data.byteLength }
      },
    }
  }

  it('TorrentSeedTool passes data first, name inside opts — not swapped', async () => {
    const fakeMgr = recordingManager()
    peerToolsContext.setTorrentManager(fakeMgr)

    const tool = new TorrentSeedTool()
    const result = await tool.execute({ name: 'notes.txt', data: 'hello world' })

    assert.equal(result.success, true)
    assert.equal(fakeMgr.calls.length, 1)
    // The real file content must be the `data` positional arg, not the name.
    assert.equal(new TextDecoder().decode(fakeMgr.calls[0].data), 'hello world')
    assert.equal(fakeMgr.calls[0].opts.name, 'notes.txt')
  })

  it('decodes text to UTF-8 bytes by default, so a string is never seeded as-is (#195)', async () => {
    const fakeMgr = recordingManager()
    peerToolsContext.setTorrentManager(fakeMgr)

    const result = await new TorrentSeedTool().execute({ name: 'greeting', data: 'héllo' })

    assert.equal(result.success, true)
    assert.ok(fakeMgr.calls[0].data instanceof Uint8Array)
    assert.deepEqual([...fakeMgr.calls[0].data], [...new TextEncoder().encode('héllo')])
    assert.match(result.output, /magnet:\?xt=urn:btih:abc123/)
    assert.match(result.output, /6 bytes/)
  })

  it('decodes base64 when encoding is "base64"', async () => {
    const fakeMgr = recordingManager()
    peerToolsContext.setTorrentManager(fakeMgr)
    const original = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255])
    const b64 = Buffer.from(original).toString('base64')

    const result = await new TorrentSeedTool().execute({ name: 'blob.bin', data: b64, encoding: 'base64' })

    assert.equal(result.success, true)
    assert.deepEqual([...fakeMgr.calls[0].data], [...original])
  })

  it('rejects invalid base64 and unknown encodings without seeding anything', async () => {
    const fakeMgr = recordingManager()
    peerToolsContext.setTorrentManager(fakeMgr)
    const tool = new TorrentSeedTool()

    const bad = await tool.execute({ name: 'x', data: 'not base64!!', encoding: 'base64' })
    assert.equal(bad.success, false)
    assert.match(bad.error, /base64/)

    const unknown = await tool.execute({ name: 'x', data: 'abc', encoding: 'hex' })
    assert.equal(unknown.success, false)
    assert.match(unknown.error, /encoding/)

    assert.equal(fakeMgr.calls.length, 0)
  })

  it('advertises the encoding parameter in its schema', () => {
    const props = new TorrentSeedTool().parameters.properties
    assert.deepEqual(props.encoding.enum, ['text', 'base64'])
  })
})

describe('ipfs_store / ipfs_retrieve rendering (#196)', () => {
  afterEach(() => {
    peerToolsContext.setIpfsStore(null)
  })

  /** Minimal stand-in with IPFSStore's real return shapes: add() -> { cid, size }, get() -> Uint8Array|null. */
  function fakeStore() {
    const m = new Map()
    return {
      async add(data) {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
        const cid = `cid${m.size + 1}`
        m.set(cid, bytes)
        return { cid, size: bytes.byteLength }
      },
      async get(cid) { return m.get(cid) ?? null },
    }
  }

  it('ipfs_store prints the CID and size, not [object Object]', async () => {
    peerToolsContext.setIpfsStore(fakeStore())
    const result = await new IpfsStoreTool().execute({ data: 'hi there' })
    assert.equal(result.success, true)
    assert.equal(result.output, 'Stored with CID: cid1 (8 bytes)')
  })

  it('ipfs_store still works against a store whose add() returns a bare cid string', async () => {
    peerToolsContext.setIpfsStore({ async add() { return 'abc' } })
    const result = await new IpfsStoreTool().execute({ data: 'hi' })
    assert.equal(result.output, 'Stored with CID: abc (2 bytes)')
  })

  it('ipfs_store decodes base64 input before storing', async () => {
    const added = []
    peerToolsContext.setIpfsStore({ async add(d) { added.push(d); return { cid: 'c', size: d.byteLength } } })
    const result = await new IpfsStoreTool().execute({ data: Buffer.from([255, 0, 1]).toString('base64'), encoding: 'base64' })
    assert.equal(result.success, true)
    assert.deepEqual([...added[0]], [255, 0, 1])
  })

  it('ipfs_retrieve returns UTF-8 text, not a byte-index object', async () => {
    const store = fakeStore()
    peerToolsContext.setIpfsStore(store)
    const { cid } = await store.add('hi there')
    const result = await new IpfsRetrieveTool().execute({ cid })
    assert.equal(result.success, true)
    assert.equal(result.output, 'hi there')
    assert.equal(result.encoding, 'text')
  })

  it('ipfs_retrieve falls back to base64 (and says so) for non-text bytes', async () => {
    const store = fakeStore()
    peerToolsContext.setIpfsStore(store)
    const raw = Uint8Array.from([0xff, 0xfe, 0x00, 0x80])
    const { cid } = await store.add(raw)
    const result = await new IpfsRetrieveTool().execute({ cid })
    assert.equal(result.success, true)
    assert.equal(result.encoding, 'base64')
    assert.ok(result.output.endsWith(Buffer.from(raw).toString('base64')))
    assert.match(result.output, /Binary content \(4 bytes\)/)
  })

  it('ipfs_retrieve encoding "base64" returns bare base64 even for text; "text" refuses binary', async () => {
    const store = fakeStore()
    peerToolsContext.setIpfsStore(store)
    const { cid: textCid } = await store.add('hello')
    const { cid: binCid } = await store.add(Uint8Array.from([0xff, 0xfe]))
    const tool = new IpfsRetrieveTool()

    const b64 = await tool.execute({ cid: textCid, encoding: 'base64' })
    assert.equal(b64.output, Buffer.from('hello').toString('base64'))

    const refused = await tool.execute({ cid: binCid, encoding: 'text' })
    assert.equal(refused.success, false)
    assert.match(refused.error, /base64/)

    const unknown = await tool.execute({ cid: textCid, encoding: 'hex' })
    assert.equal(unknown.success, false)
  })

  it('ipfs_retrieve reports an unknown CID as not found', async () => {
    peerToolsContext.setIpfsStore(fakeStore())
    const result = await new IpfsRetrieveTool().execute({ cid: 'nope' })
    assert.equal(result.success, true)
    assert.equal(result.output, 'CID nope not found.')
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

  it('registers all 29 tools into a real BrowserToolRegistry', () => {
    const registry = new BrowserToolRegistry()
    registerMeshPeerTools(registry, {})
    assert.equal(registry.list().length, 29)
    assert.ok(registry.get('mesh_chat_create_room') instanceof MeshChatCreateRoomTool)
    const specs = registry.listSpecs()
    assert.ok(specs.some((s) => s.name === 'federated_compute_submit'))
  })
})

// #189: the tools used to call agent.saveState/restoreState, which StealthAgent
// does not have, so every call failed. These drive them against a real agent.
describe('stealth tools against a real StealthAgent (#189)', () => {
  let dhtNode
  let agent

  beforeEach(() => {
    dhtNode = new DhtNode({ localId: 'stealth-node', sendFn: () => {} })
    agent = new StealthAgent({ agentId: 'agent-007', dhtNode, threshold: 3, totalShards: 5 })
    peerToolsContext.setStealthAgent(agent)
  })
  afterEach(() => peerToolsContext.setStealthAgent(null))

  const state = { goal: 'find the needle', step: 4, notes: ['alpha', 'beta'] }

  it('stealth_save then stealth_restore round-trips the state', async () => {
    const saved = await new StealthSaveTool().execute({ state })
    assert.equal(saved.success, true, saved.error)
    assert.equal(agent.isViable(), true)
    assert.equal(agent.getManifest().shardIds.length, 5)

    const restored = await new StealthRestoreTool().execute({})
    assert.equal(restored.success, true, restored.error)
    assert.deepEqual(JSON.parse(restored.output), state)
  })

  it('stealth_restore reports No state found when nothing was saved', async () => {
    const restored = await new StealthRestoreTool().execute({})
    assert.equal(restored.success, true)
    assert.equal(restored.output, 'No state found.')
  })

  it('stealth_restore survives the loss of one data shard (XOR parity)', async () => {
    await new StealthSaveTool().execute({ state })
    dhtNode.store('stealth:agent-007:shard:1', null)
    const restored = await new StealthRestoreTool().execute({})
    assert.equal(restored.success, true, restored.error)
    assert.deepEqual(JSON.parse(restored.output), state)
  })

  it('does not claim encryption, and the stored shards are plaintext (honesty check)', async () => {
    assert.doesNotMatch(new StealthSaveTool().description, /threshold-encrypted|encrypted shards/i)
    assert.match(new StealthSaveTool().description, /NOT encrypted/)
    assert.match(new StealthRestoreTool().description, /not encrypted/)
    await new StealthSaveTool().execute({ state: { secret: 'hunter2-hunter2-hunter2' } })
    const stored = [0, 1, 2]
      .map((i) => dhtNode.get(`stealth:agent-007:shard:${i}`).data)
      .join('')
    assert.ok(stored.includes('hunter2-hunter2-hunter2'), 'data shards hold the state verbatim')
  })

  it('a duck-typed agent exposing saveState/restoreState still works', async () => {
    let held = null
    peerToolsContext.setStealthAgent({
      async saveState(s) { held = s },
      async restoreState() { return held },
    })
    assert.equal((await new StealthSaveTool().execute({ state })).success, true)
    const restored = await new StealthRestoreTool().execute({})
    assert.deepEqual(JSON.parse(restored.output), state)
  })
})
