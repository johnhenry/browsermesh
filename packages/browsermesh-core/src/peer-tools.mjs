/**
 * clawser-mesh-peer-tools.js — BrowserTool subclasses for mesh peer subsystems
 *
 * Exposes chat, compute, scheduling, health, escrow, routing, timestamp,
 * stealth, delta-sync, gateway, torrent, IPFS, ACL, and capability tools
 * to the AI agent.
 *
 * @module clawser-mesh-peer-tools
 */

import { BrowserTool } from './compat.mjs'

// ── Shared context ────────────────────────────────────────────────────

export class MeshPeerToolsContext {
  #meshChat = null
  #meshScheduler = null
  #federatedCompute = null
  #agentSwarmCoordinator = null
  #healthMonitor = null
  #escrowManager = null
  #meshRouter = null
  #timestampAuthority = null
  #stealthAgent = null
  #syncCoordinator = null
  #gatewayNode = null
  #torrentManager = null
  #ipfsStore = null
  #meshACL = null
  #capabilityValidator = null
  #sessionManager = null
  #crossOriginBridge = null
  #verificationQuorum = null
  #migrationEngine = null
  #creditLedger = null

  set(key, value) { this[`#${key}`] = value }

  setMeshChat(v) { this.#meshChat = v }
  getMeshChat() { return this.#meshChat }
  setMeshScheduler(v) { this.#meshScheduler = v }
  getMeshScheduler() { return this.#meshScheduler }
  setFederatedCompute(v) { this.#federatedCompute = v }
  getFederatedCompute() { return this.#federatedCompute }
  setAgentSwarmCoordinator(v) { this.#agentSwarmCoordinator = v }
  getAgentSwarmCoordinator() { return this.#agentSwarmCoordinator }
  setHealthMonitor(v) { this.#healthMonitor = v }
  getHealthMonitor() { return this.#healthMonitor }
  setEscrowManager(v) { this.#escrowManager = v }
  getEscrowManager() { return this.#escrowManager }
  setMeshRouter(v) { this.#meshRouter = v }
  getMeshRouter() { return this.#meshRouter }
  setTimestampAuthority(v) { this.#timestampAuthority = v }
  getTimestampAuthority() { return this.#timestampAuthority }
  setStealthAgent(v) { this.#stealthAgent = v }
  getStealthAgent() { return this.#stealthAgent }
  setSyncCoordinator(v) { this.#syncCoordinator = v }
  getSyncCoordinator() { return this.#syncCoordinator }
  setGatewayNode(v) { this.#gatewayNode = v }
  getGatewayNode() { return this.#gatewayNode }
  setTorrentManager(v) { this.#torrentManager = v }
  getTorrentManager() { return this.#torrentManager }
  setIpfsStore(v) { this.#ipfsStore = v }
  getIpfsStore() { return this.#ipfsStore }
  setMeshACL(v) { this.#meshACL = v }
  getMeshACL() { return this.#meshACL }
  setCapabilityValidator(v) { this.#capabilityValidator = v }
  getCapabilityValidator() { return this.#capabilityValidator }
  setSessionManager(v) { this.#sessionManager = v }
  getSessionManager() { return this.#sessionManager }
  setCrossOriginBridge(v) { this.#crossOriginBridge = v }
  getCrossOriginBridge() { return this.#crossOriginBridge }
  setVerificationQuorum(v) { this.#verificationQuorum = v }
  getVerificationQuorum() { return this.#verificationQuorum }
  setMigrationEngine(v) { this.#migrationEngine = v }
  getMigrationEngine() { return this.#migrationEngine }
  setCreditLedger(v) { this.#creditLedger = v }
  getCreditLedger() { return this.#creditLedger }
}

export const peerToolsContext = new MeshPeerToolsContext()

// ── Chat tools ────────────────────────────────────────────────────────

export class MeshChatCreateRoomTool extends BrowserTool {
  get name() { return 'mesh_chat_create_room' }
  get description() { return 'Create a new mesh chat room.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Room name' },
        maxMembers: { type: 'number', description: 'Maximum members (default: 256)' },
      },
      required: ['name'],
    }
  }
  get permission() { return 'write' }

  async execute({ name, maxMembers }) {
    const chat = peerToolsContext.getMeshChat()
    if (!chat) return { success: false, output: '', error: 'Mesh chat not initialized.' }
    try {
      const room = chat.createRoom({ name, opts: maxMembers ? { maxMembers } : undefined })
      return { success: true, output: `Room created: ${room.id} (${room.name})` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

export class MeshChatSendTool extends BrowserTool {
  get name() { return 'mesh_chat_send' }
  get description() { return 'Send a message to a mesh chat room.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Target room ID' },
        body: { type: 'string', description: 'Message body' },
        type: { type: 'string', description: 'Message type (default: text)' },
      },
      required: ['roomId', 'body'],
    }
  }
  get permission() { return 'write' }

  async execute({ roomId, body, type }) {
    const chat = peerToolsContext.getMeshChat()
    if (!chat) return { success: false, output: '', error: 'Mesh chat not initialized.' }
    try {
      const msg = chat.sendMessage({ roomId, body, type: type || 'text' })
      return { success: true, output: `Message sent: ${msg.id} to room ${roomId}` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

export class MeshChatHistoryTool extends BrowserTool {
  get name() { return 'mesh_chat_history' }
  get description() { return 'Get message history from a mesh chat room.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        roomId: { type: 'string', description: 'Room ID' },
        limit: { type: 'number', description: 'Max messages to return (default: 20)' },
      },
      required: ['roomId'],
    }
  }
  get permission() { return 'read' }

  async execute({ roomId, limit }) {
    const chat = peerToolsContext.getMeshChat()
    if (!chat) return { success: false, output: '', error: 'Mesh chat not initialized.' }
    try {
      const messages = chat.getHistory(roomId, limit || 20)
      if (!messages || messages.length === 0) return { success: true, output: 'No messages.' }
      const lines = messages.map(m => `[${m.sender}] ${m.body}`)
      return { success: true, output: lines.join('\n') }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

export class MeshChatListRoomsTool extends BrowserTool {
  get name() { return 'mesh_chat_list_rooms' }
  get description() { return 'List all mesh chat rooms.' }
  get parameters() { return { type: 'object', properties: {} } }
  get permission() { return 'read' }

  async execute() {
    const chat = peerToolsContext.getMeshChat()
    if (!chat) return { success: true, output: 'Mesh chat not initialized.' }
    try {
      const rooms = chat.listRooms()
      if (!rooms || rooms.length === 0) return { success: true, output: 'No rooms.' }
      const lines = rooms.map(r => `${r.id} | ${r.name} | ${r.memberCount ?? '?'} members`)
      return { success: true, output: `ID | NAME | MEMBERS\n${lines.join('\n')}` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Scheduler tools ───────────────────────────────────────────────────

export class MeshSchedulerSubmitTool extends BrowserTool {
  get name() { return 'mesh_scheduler_submit' }
  get description() { return 'Submit a task to the mesh scheduler for distributed execution.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Task type (e.g., compute, io, transfer)' },
        payload: { type: 'object', description: 'Task payload data' },
        priority: { type: 'string', description: 'Priority: low, normal, high, critical (default: normal)' },
      },
      required: ['type', 'payload'],
    }
  }
  get permission() { return 'approve' }

  async execute({ type, payload, priority }) {
    const sched = peerToolsContext.getMeshScheduler()
    if (!sched) return { success: false, output: '', error: 'Mesh scheduler not initialized.' }
    try {
      // ScheduledTask lives in the sibling browsermesh-apps package, which
      // itself depends on browsermesh-core (peerDependency) — core can't
      // depend back on apps without a cycle, so this reaches across via a
      // relative path that only resolves inside this monorepo, pre-existing
      // from before this package was re-extracted. Contained by the
      // surrounding try/catch: if apps isn't present, this one tool fails
      // gracefully rather than crashing the module.
      const { ScheduledTask } = await import('../../browsermesh-apps/src/scheduler.mjs')
      const task = new ScheduledTask({
        id: crypto.randomUUID(),
        type,
        payload,
        priority: priority || 'normal',
        submittedBy: 'agent',
      })
      const id = await sched.submit(task)
      return { success: true, output: `Task submitted: ${id}` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

export class MeshSchedulerListTool extends BrowserTool {
  get name() { return 'mesh_scheduler_list' }
  get description() { return 'List tasks in the mesh scheduler.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status (optional)' },
      },
    }
  }
  get permission() { return 'read' }

  async execute({ status } = {}) {
    const sched = peerToolsContext.getMeshScheduler()
    if (!sched) return { success: true, output: 'Mesh scheduler not initialized.' }
    try {
      const tasks = sched.listTasks?.(status) || []
      if (tasks.length === 0) return { success: true, output: 'No tasks.' }
      const lines = tasks.map(t => `${t.id} | ${t.type} | ${t.status} | ${t.priority}`)
      return { success: true, output: `ID | TYPE | STATUS | PRIORITY\n${lines.join('\n')}` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Compute tools ─────────────────────────────────────────────────────

export class FederatedComputeSubmitTool extends BrowserTool {
  get name() { return 'federated_compute_submit' }
  get description() { return 'Submit a federated compute job across mesh peers.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Compute type: map_reduce, pipeline, broadcast, scatter_gather' },
        payload: { type: 'object', description: 'Job payload' },
      },
      required: ['payload'],
    }
  }
  get permission() { return 'approve' }

  async execute({ type, payload }) {
    const fc = peerToolsContext.getFederatedCompute()
    if (!fc) return { success: false, output: '', error: 'Federated compute not initialized.' }
    try {
      const job = await fc.submit({
        type: type || 'scatter_gather',
        payload,
        splitFn: (p) => [p],
        mergeFn: (results) => results[0],
      })
      return { success: true, output: `Job submitted: ${job.id || job}` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Swarm tools ───────────────────────────────────────────────────────

export class SwarmCreateTool extends BrowserTool {
  get name() { return 'agent_swarm_create' }
  get description() { return 'Create a multi-agent swarm to collaboratively solve a goal.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'The goal for the swarm' },
        strategy: { type: 'string', description: 'Strategy: competitive, collaborative, hierarchical' },
        members: { type: 'array', items: { type: 'string' }, description: 'Peer IDs to include' },
      },
      required: ['goal'],
    }
  }
  get permission() { return 'approve' }

  async execute({ goal, strategy, members }) {
    const swarm = peerToolsContext.getAgentSwarmCoordinator()
    if (!swarm) return { success: false, output: '', error: 'Agent swarm coordinator not initialized.' }
    try {
      const instance = swarm.createSwarm({ goal, strategy, members: members || [] })
      return { success: true, output: `Swarm created: ${instance.id} (goal: ${goal})` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

export class SwarmStatusTool extends BrowserTool {
  get name() { return 'agent_swarm_status' }
  get description() { return 'Get the status of an agent swarm.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        swarmId: { type: 'string', description: 'Swarm ID' },
      },
      required: ['swarmId'],
    }
  }
  get permission() { return 'read' }

  async execute({ swarmId }) {
    const swarm = peerToolsContext.getAgentSwarmCoordinator()
    if (!swarm) return { success: false, output: '', error: 'Agent swarm coordinator not initialized.' }
    try {
      const status = swarm.getStatus(swarmId)
      if (!status) return { success: false, output: '', error: `Swarm ${swarmId} not found.` }
      return { success: true, output: JSON.stringify(status, null, 2) }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Health tools ──────────────────────────────────────────────────────

export class MeshHealthStatusTool extends BrowserTool {
  get name() { return 'mesh_health_status' }
  get description() { return 'Get health status of mesh peers.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        podId: { type: 'string', description: 'Specific peer to check (optional, omit for all)' },
      },
    }
  }
  get permission() { return 'read' }

  async execute({ podId } = {}) {
    const monitor = peerToolsContext.getHealthMonitor()
    if (!monitor) return { success: true, output: 'Health monitor not initialized.' }
    try {
      if (podId) {
        const health = monitor.getHealth(podId)
        if (!health) return { success: true, output: `No health data for ${podId}.` }
        return { success: true, output: `${podId}: ${health.status} (latency: ${health.latencyMs}ms, uptime: ${health.uptimeMs}ms)` }
      }
      const all = monitor.getAllHealth?.() || []
      if (all.length === 0) return { success: true, output: 'No peer health data.' }
      const lines = all.map(h => `${h.podId} | ${h.status} | ${h.latencyMs}ms`)
      return { success: true, output: `POD | STATUS | LATENCY\n${lines.join('\n')}` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Escrow tools ──────────────────────────────────────────────────────

export class EscrowCreateTool extends BrowserTool {
  get name() { return 'escrow_create' }
  get description() { return 'Create an escrow contract holding funds until conditions are met.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        payer: { type: 'string', description: 'Payer pod ID' },
        payee: { type: 'string', description: 'Payee pod ID' },
        amount: { type: 'number', description: 'Amount to escrow' },
        description: { type: 'string', description: 'Contract description' },
        conditions: { type: 'array', items: { type: 'object' }, description: 'Release conditions' },
      },
      required: ['payer', 'payee', 'amount'],
    }
  }
  get permission() { return 'approve' }

  async execute({ payer, payee, amount, description, conditions }) {
    const mgr = peerToolsContext.getEscrowManager()
    if (!mgr) return { success: false, output: '', error: 'Escrow manager not initialized.' }
    try {
      const contract = mgr.createEscrow(payer, payee, amount, { description, conditions })
      return { success: true, output: `Escrow created: ${contract.id} (${amount} from ${payer} to ${payee})` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

export class EscrowListTool extends BrowserTool {
  get name() { return 'escrow_list' }
  get description() { return 'List escrow contracts.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: pending, locked, released, refunded' },
      },
    }
  }
  get permission() { return 'read' }

  async execute({ status } = {}) {
    const mgr = peerToolsContext.getEscrowManager()
    if (!mgr) return { success: true, output: 'Escrow manager not initialized.' }
    try {
      const contracts = mgr.listContracts(status)
      if (!contracts || contracts.length === 0) return { success: true, output: 'No escrow contracts.' }
      const lines = contracts.map(c => `${c.id} | ${c.status} | ${c.amount} | ${c.payer} → ${c.payee}`)
      return { success: true, output: `ID | STATUS | AMOUNT | FLOW\n${lines.join('\n')}` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

export class EscrowReleaseTool extends BrowserTool {
  get name() { return 'escrow_release' }
  get description() { return 'Release an escrow contract, transferring funds to the payee.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        contractId: { type: 'string', description: 'Escrow contract ID' },
      },
      required: ['contractId'],
    }
  }
  get permission() { return 'approve' }

  async execute({ contractId }) {
    const mgr = peerToolsContext.getEscrowManager()
    if (!mgr) return { success: false, output: '', error: 'Escrow manager not initialized.' }
    try {
      mgr.releaseEscrow(contractId)
      return { success: true, output: `Escrow ${contractId} released.` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Router tools ──────────────────────────────────────────────────────

export class MeshRouterAddRouteTool extends BrowserTool {
  get name() { return 'mesh_router_add_route' }
  get description() { return 'Add a route to the mesh routing table.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Destination pod ID' },
        nextHop: { type: 'string', description: 'Next hop pod ID' },
        cost: { type: 'number', description: 'Route cost/metric (default: 1)' },
      },
      required: ['destination', 'nextHop'],
    }
  }
  get permission() { return 'write' }

  async execute({ destination, nextHop, cost }) {
    const router = peerToolsContext.getMeshRouter()
    if (!router) return { success: false, output: '', error: 'Mesh router not initialized.' }
    try {
      router.addRoute(destination, nextHop, cost ?? 1)
      return { success: true, output: `Route added: ${destination} via ${nextHop} (cost: ${cost ?? 1})` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

export class MeshRouterLookupTool extends BrowserTool {
  get name() { return 'mesh_router_lookup' }
  get description() { return 'Look up the best route to a destination pod.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        destination: { type: 'string', description: 'Destination pod ID' },
      },
      required: ['destination'],
    }
  }
  get permission() { return 'read' }

  async execute({ destination }) {
    const router = peerToolsContext.getMeshRouter()
    if (!router) return { success: false, output: '', error: 'Mesh router not initialized.' }
    try {
      const route = router.resolve(destination)
      if (!route) return { success: true, output: `No route to ${destination}.` }
      return { success: true, output: `Route to ${destination}: next hop ${route.nextHop}, cost ${route.cost}` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Timestamp tools ───────────────────────────────────────────────────

export class TimestampProofTool extends BrowserTool {
  get name() { return 'mesh_timestamp_proof' }
  get description() { return 'Request a cryptographic timestamp proof for an event.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        eventHash: { type: 'string', description: 'Hash of the event to timestamp' },
      },
      required: ['eventHash'],
    }
  }
  get permission() { return 'network' }

  async execute({ eventHash }) {
    const ta = peerToolsContext.getTimestampAuthority()
    if (!ta) return { success: false, output: '', error: 'Timestamp authority not initialized.' }
    try {
      const proof = await ta.createProof(eventHash)
      return { success: true, output: `Proof created: timestamp=${proof.canonicalTimestamp}, confidence=${proof.confidence}, witnesses=${proof.witnesses?.length || 0}` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Stealth tools ─────────────────────────────────────────────────────

export class StealthSaveTool extends BrowserTool {
  get name() { return 'stealth_save' }
  get description() { return 'Save agent state as threshold-encrypted shards distributed across the DHT.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        state: { type: 'object', description: 'State object to shard and distribute' },
      },
      required: ['state'],
    }
  }
  get permission() { return 'approve' }

  async execute({ state }) {
    const agent = peerToolsContext.getStealthAgent()
    if (!agent) return { success: false, output: '', error: 'Stealth agent not initialized.' }
    try {
      await agent.saveState(state)
      return { success: true, output: 'State saved as distributed shards.' }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

export class StealthRestoreTool extends BrowserTool {
  get name() { return 'stealth_restore' }
  get description() { return 'Restore agent state from threshold-encrypted DHT shards.' }
  get parameters() { return { type: 'object', properties: {} } }
  get permission() { return 'approve' }

  async execute() {
    const agent = peerToolsContext.getStealthAgent()
    if (!agent) return { success: false, output: '', error: 'Stealth agent not initialized.' }
    try {
      const state = await agent.restoreState()
      return { success: true, output: state ? JSON.stringify(state) : 'No state found.' }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── ACL tools ─────────────────────────────────────────────────────────

export class MeshACLAddEntryTool extends BrowserTool {
  get name() { return 'mesh_acl_add' }
  get description() { return 'Add a peer to the mesh access control list with a role template.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        identity: { type: 'string', description: 'Peer fingerprint/pod ID' },
        template: { type: 'string', description: 'Role template: guest, collaborator, admin' },
        label: { type: 'string', description: 'Display label (optional)' },
      },
      required: ['identity', 'template'],
    }
  }
  get permission() { return 'approve' }

  async execute({ identity, template, label }) {
    const acl = peerToolsContext.getMeshACL()
    if (!acl) return { success: false, output: '', error: 'Mesh ACL not initialized.' }
    try {
      acl.addEntry(identity, template, { label })
      return { success: true, output: `Added ${identity} as ${template}${label ? ` (${label})` : ''}.` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

export class MeshACLListTool extends BrowserTool {
  get name() { return 'mesh_acl_list' }
  get description() { return 'List all entries in the mesh access control list.' }
  get parameters() { return { type: 'object', properties: {} } }
  get permission() { return 'read' }

  async execute() {
    const acl = peerToolsContext.getMeshACL()
    if (!acl) return { success: true, output: 'Mesh ACL not initialized.' }
    try {
      const entries = acl.listEntries()
      if (!entries || entries.length === 0) return { success: true, output: 'No ACL entries.' }
      const lines = entries.map(e => `${e.identity} | ${e.templateName} | ${e.label || ''}`)
      return { success: true, output: `IDENTITY | ROLE | LABEL\n${lines.join('\n')}` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

export class MeshACLCheckTool extends BrowserTool {
  get name() { return 'mesh_acl_check' }
  get description() { return 'Check if a peer has a specific scope/permission.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        identity: { type: 'string', description: 'Peer fingerprint/pod ID' },
        scope: { type: 'string', description: 'Scope to check (e.g., read, write, admin)' },
      },
      required: ['identity', 'scope'],
    }
  }
  get permission() { return 'read' }

  async execute({ identity, scope }) {
    const acl = peerToolsContext.getMeshACL()
    if (!acl) return { success: false, output: '', error: 'Mesh ACL not initialized.' }
    try {
      const allowed = acl.check(identity, scope)
      return { success: true, output: `${identity} ${allowed ? 'HAS' : 'DOES NOT HAVE'} scope "${scope}".` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Session tools ─────────────────────────────────────────────────────

export class MeshSessionListTool extends BrowserTool {
  get name() { return 'mesh_session_list' }
  get description() { return 'List active peer sessions.' }
  get parameters() { return { type: 'object', properties: {} } }
  get permission() { return 'read' }

  async execute() {
    const mgr = peerToolsContext.getSessionManager()
    if (!mgr) return { success: true, output: 'Session manager not initialized.' }
    try {
      const sessions = mgr.listSessions()
      if (!sessions || sessions.length === 0) return { success: true, output: 'No active sessions.' }
      const lines = sessions.map(s => `${s.sessionId} | ${s.remoteIdentity || '?'} | ${s.state || 'active'}`)
      return { success: true, output: `SESSION | PEER | STATE\n${lines.join('\n')}` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Gateway tools ─────────────────────────────────────────────────────

export class MeshGatewayStatusTool extends BrowserTool {
  get name() { return 'mesh_gateway_status' }
  get description() { return 'Get status of the local mesh gateway node.' }
  get parameters() { return { type: 'object', properties: {} } }
  get permission() { return 'read' }

  async execute() {
    const gw = peerToolsContext.getGatewayNode()
    if (!gw) return { success: true, output: 'Gateway node not initialized.' }
    try {
      const stats = gw.getStats?.() || {}
      const peers = gw.connectedPeers?.() || []
      return {
        success: true,
        output: `Gateway: ${peers.length} connected peers, ${stats.routeCount || 0} routes, relay=${stats.allowRelay ?? true}`,
      }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Torrent tools ─────────────────────────────────────────────────────

export class TorrentSeedTool extends BrowserTool {
  get name() { return 'torrent_seed' }
  get description() { return 'Seed a file or data via BitTorrent-style P2P distribution.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Content name/identifier' },
        data: { type: 'string', description: 'Base64-encoded data or text to seed' },
      },
      required: ['name', 'data'],
    }
  }
  get permission() { return 'approve' }

  async execute({ name, data }) {
    const tm = peerToolsContext.getTorrentManager()
    if (!tm) return { success: false, output: '', error: 'Torrent manager not initialized.' }
    try {
      const result = await tm.seed(name, data)
      return { success: true, output: `Seeding: ${result?.infoHash || name}` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── IPFS tools ────────────────────────────────────────────────────────

export class IpfsStoreTool extends BrowserTool {
  get name() { return 'ipfs_store' }
  get description() { return 'Store data in the IPFS-compatible content-addressed store.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'Data to store' },
      },
      required: ['data'],
    }
  }
  get permission() { return 'write' }

  async execute({ data }) {
    const store = peerToolsContext.getIpfsStore()
    if (!store) return { success: false, output: '', error: 'IPFS store not initialized.' }
    try {
      const cid = await store.add(data)
      return { success: true, output: `Stored with CID: ${cid}` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

export class IpfsRetrieveTool extends BrowserTool {
  get name() { return 'ipfs_retrieve' }
  get description() { return 'Retrieve data from the IPFS-compatible store by CID.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        cid: { type: 'string', description: 'Content identifier (CID)' },
      },
      required: ['cid'],
    }
  }
  get permission() { return 'read' }

  async execute({ cid }) {
    const store = peerToolsContext.getIpfsStore()
    if (!store) return { success: false, output: '', error: 'IPFS store not initialized.' }
    try {
      const data = await store.get(cid)
      if (!data) return { success: true, output: `CID ${cid} not found.` }
      return { success: true, output: typeof data === 'string' ? data : JSON.stringify(data) }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Credit ledger tools ───────────────────────────────────────────────

export class CreditBalanceTool extends BrowserTool {
  get name() { return 'credit_balance' }
  get description() { return 'Check the local credit balance or balance with a specific peer.' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        peerId: { type: 'string', description: 'Peer pod ID (optional, omit for local balance)' },
      },
    }
  }
  get permission() { return 'read' }

  async execute({ peerId } = {}) {
    const ledger = peerToolsContext.getCreditLedger()
    if (!ledger) return { success: true, output: 'Credit ledger not initialized.' }
    try {
      const balance = ledger.balance ?? ledger.getBalance?.(peerId) ?? 0
      return { success: true, output: `Balance${peerId ? ` (${peerId})` : ''}: ${balance} credits` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Migration tools ───────────────────────────────────────────────────

export class MeshMigrationStatusTool extends BrowserTool {
  get name() { return 'mesh_migration_status' }
  get description() { return 'Get the status of active mesh migrations.' }
  get parameters() { return { type: 'object', properties: {} } }
  get permission() { return 'read' }

  async execute() {
    const engine = peerToolsContext.getMigrationEngine()
    if (!engine) return { success: true, output: 'Migration engine not initialized.' }
    try {
      const migrations = engine.listMigrations?.() || []
      if (migrations.length === 0) return { success: true, output: 'No active migrations.' }
      const lines = migrations.map(m => `${m.migrationId} | ${m.state} | ${m.sourcePodId} → ${m.targetPodId}`)
      return { success: true, output: `ID | STATE | FLOW\n${lines.join('\n')}` }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Delta sync tools ──────────────────────────────────────────────────

export class DeltaSyncStatusTool extends BrowserTool {
  get name() { return 'delta_sync_status' }
  get description() { return 'Get the status of the delta sync coordinator.' }
  get parameters() { return { type: 'object', properties: {} } }
  get permission() { return 'read' }

  async execute() {
    const sc = peerToolsContext.getSyncCoordinator()
    if (!sc) return { success: true, output: 'Delta sync coordinator not initialized.' }
    try {
      const state = sc.state
      const sessions = sc.listSessions?.() || []
      return {
        success: true,
        output: `Delta sync: ${sessions.length} session(s), state keys: ${Object.keys(state).length}`,
      }
    } catch (err) {
      return { success: false, output: '', error: err.message }
    }
  }
}

// ── Registry helper ───────────────────────────────────────────────────

/**
 * Register all mesh peer tools with a BrowserToolRegistry.
 * @param {import('./compat.mjs').BrowserToolRegistry} registry
 * @param {object} deps - Subsystem instances
 */
export function registerMeshPeerTools(registry, deps = {}) {
  // Wire context
  if (deps.meshChat) peerToolsContext.setMeshChat(deps.meshChat)
  if (deps.meshScheduler) peerToolsContext.setMeshScheduler(deps.meshScheduler)
  if (deps.federatedCompute) peerToolsContext.setFederatedCompute(deps.federatedCompute)
  if (deps.agentSwarmCoordinator) peerToolsContext.setAgentSwarmCoordinator(deps.agentSwarmCoordinator)
  if (deps.healthMonitor) peerToolsContext.setHealthMonitor(deps.healthMonitor)
  if (deps.escrowManager) peerToolsContext.setEscrowManager(deps.escrowManager)
  if (deps.meshRouter) peerToolsContext.setMeshRouter(deps.meshRouter)
  if (deps.timestampAuthority) peerToolsContext.setTimestampAuthority(deps.timestampAuthority)
  if (deps.stealthAgent) peerToolsContext.setStealthAgent(deps.stealthAgent)
  if (deps.syncCoordinator) peerToolsContext.setSyncCoordinator(deps.syncCoordinator)
  if (deps.gatewayNode) peerToolsContext.setGatewayNode(deps.gatewayNode)
  if (deps.torrentManager) peerToolsContext.setTorrentManager(deps.torrentManager)
  if (deps.ipfsStore) peerToolsContext.setIpfsStore(deps.ipfsStore)
  if (deps.meshACL) peerToolsContext.setMeshACL(deps.meshACL)
  if (deps.capabilityValidator) peerToolsContext.setCapabilityValidator(deps.capabilityValidator)
  if (deps.sessionManager) peerToolsContext.setSessionManager(deps.sessionManager)
  if (deps.crossOriginBridge) peerToolsContext.setCrossOriginBridge(deps.crossOriginBridge)
  if (deps.verificationQuorum) peerToolsContext.setVerificationQuorum(deps.verificationQuorum)
  if (deps.migrationEngine) peerToolsContext.setMigrationEngine(deps.migrationEngine)
  if (deps.creditLedger) peerToolsContext.setCreditLedger(deps.creditLedger)

  // Register tools
  // Chat
  registry.register(new MeshChatCreateRoomTool())
  registry.register(new MeshChatSendTool())
  registry.register(new MeshChatHistoryTool())
  registry.register(new MeshChatListRoomsTool())
  // Scheduler
  registry.register(new MeshSchedulerSubmitTool())
  registry.register(new MeshSchedulerListTool())
  // Compute
  registry.register(new FederatedComputeSubmitTool())
  // Swarm
  registry.register(new SwarmCreateTool())
  registry.register(new SwarmStatusTool())
  // Health
  registry.register(new MeshHealthStatusTool())
  // Escrow
  registry.register(new EscrowCreateTool())
  registry.register(new EscrowListTool())
  registry.register(new EscrowReleaseTool())
  // Router
  registry.register(new MeshRouterAddRouteTool())
  registry.register(new MeshRouterLookupTool())
  // Timestamp
  registry.register(new TimestampProofTool())
  // Stealth
  registry.register(new StealthSaveTool())
  registry.register(new StealthRestoreTool())
  // ACL
  registry.register(new MeshACLAddEntryTool())
  registry.register(new MeshACLListTool())
  registry.register(new MeshACLCheckTool())
  // Sessions
  registry.register(new MeshSessionListTool())
  // Gateway
  registry.register(new MeshGatewayStatusTool())
  // Torrent
  registry.register(new TorrentSeedTool())
  // IPFS
  registry.register(new IpfsStoreTool())
  registry.register(new IpfsRetrieveTool())
  // Credits
  registry.register(new CreditBalanceTool())
  // Migration
  registry.register(new MeshMigrationStatusTool())
  // Delta sync
  registry.register(new DeltaSyncStatusTool())
}
