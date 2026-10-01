/**
 * clawser-mesh-orchestrator.js -- Pod orchestration engine + tools.
 *
 * MeshOrchestrator coordinates pods across the P2P mesh network.
 * Each operation is also exposed as a BrowserTool subclass so the AI agent
 * can invoke them via structured tool_use.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-orchestrator.test.mjs
 */

import { MESH_TYPE } from '@johnhenry/browsermesh-primitives'
import { ComputeRequest, ResourceDescriptor, ResourceScorer, RUNTIME_CLASS, ISOLATION } from './resources.mjs'
import { BrowserTool as CompatBrowserTool } from './compat.mjs'
import {
  validatePodSpec,
  POD_LANE,
  POD_HOST_ERROR,
  PodHostDriverError,
} from '@johnhenry/browsermesh-pod'

// A real browser environment (clawser's web/clawser-tools.js) may already
// have defined a real, richer `globalThis.BrowserTool` -- honored first, as
// before. Otherwise (plain Node, e.g. this package's own tests, or any
// standalone use of this file), fall back to compat.mjs's real `BrowserTool`
// (Phase 1 of the agent-runtime plan, issue #90) rather than the do-nothing
// stub this used to fall back to (`class { constructor() {} }`, with no
// `.spec` getter at all). That stub silently broke `BrowserToolRegistry
// .register()` (Phase 4, `mesh-orchestrator-tools.mjs`) for every Meshctl*Tool
// below in Node -- `.spec` composes `{name, description, parameters,
// required_permission}` from each subclass's own overridden getters, which
// only exists on compat.mjs's real `BrowserTool`, not the old stub. Using the
// real class changes nothing about the 13 Meshctl*Tool subclasses' own bodies
// below (their name/description/parameters/permission getters and execute()
// methods are all still their own overrides) -- only what `.spec` (and the
// default `execute()`/`permission` a subclass doesn't override) resolves to.
const BrowserTool = globalThis.BrowserTool || CompatBrowserTool

// ---------------------------------------------------------------------------
// Wire constants (re-exported from canonical registry)
// ---------------------------------------------------------------------------

export const ORCH_LIST_PODS = MESH_TYPE.ORCH_LIST_PODS    // 0xd8
export const ORCH_POD_STATUS = MESH_TYPE.ORCH_POD_STATUS  // 0xd9
export const ORCH_EXEC = MESH_TYPE.ORCH_EXEC              // 0xda
export const ORCH_DEPLOY = MESH_TYPE.ORCH_DEPLOY          // 0xdb
export const ORCH_DRAIN = MESH_TYPE.ORCH_DRAIN            // 0xdc
export const ORCH_EXPOSE = MESH_TYPE.ORCH_EXPOSE          // 0xdd
export const ORCH_ROUTE = MESH_TYPE.ORCH_ROUTE            // 0xde

// ---------------------------------------------------------------------------
// Valid enumerations
// ---------------------------------------------------------------------------

const VALID_POD_STATUSES = Object.freeze([
  'online', 'offline', 'draining', 'unknown',
])

/**
 * Placement-lifecycle audit record names (issue #185 §7/§8 WP4). WP4 wires
 * only the vocabulary and the audit path -- actual placement RPC (spawning
 * or restoring a hosted pod on an isolate/microvm host) is WP2/WP3, not
 * implemented here. Mirrors the existing `remote_deploy_*`/`remote_exec_*`
 * audit record naming.
 */
export const PLACEMENT_AUDIT = Object.freeze({
  REQUESTED: 'placement_requested',
  DENIED: 'placement_denied',
  STARTED: 'placement_started',
  READY: 'placement_ready',
  EVICTED: 'placement_evicted',
})

// ---------------------------------------------------------------------------
// PodInfo
// ---------------------------------------------------------------------------

/**
 * Summary information about a pod in the mesh.
 */
export class PodInfo {
  /**
   * @param {object} opts
   * @param {string} opts.podId
   * @param {string} [opts.label]
   * @param {string} [opts.status]
   * @param {string[]} [opts.services]
   * @param {number} [opts.connections]
   * @param {boolean} [opts.isLocal]
   */
  constructor({
    podId,
    label = '',
    status = 'online',
    services = [],
    connections = 0,
    isLocal = false,
  }) {
    if (!podId || typeof podId !== 'string') {
      throw new Error('podId is required and must be a non-empty string')
    }
    this.podId = podId
    this.label = label
    this.status = status
    this.services = [...services]
    this.connections = connections
    this.isLocal = isLocal
  }

  toJSON() {
    return {
      podId: this.podId,
      label: this.label,
      status: this.status,
      services: [...this.services],
      connections: this.connections,
      isLocal: this.isLocal,
    }
  }

  /**
   * @param {object} data
   * @returns {PodInfo}
   */
  static fromJSON(data) {
    return new PodInfo(data)
  }
}

// ---------------------------------------------------------------------------
// PodStatus
// ---------------------------------------------------------------------------

/**
 * Detailed status of a specific pod.
 */
export class PodStatus {
  /**
   * @param {object} opts
   * @param {string} opts.podId
   * @param {string} [opts.status]
   * @param {string[]} [opts.capabilities]
   * @param {string[]} [opts.services]
   * @param {number} [opts.connections]
   * @param {number} [opts.uptime]
   * @param {object} [opts.resources]
   * @param {number} [opts.resources.cpu]
   * @param {number} [opts.resources.memory]
   * @param {number} [opts.resources.storage]
   * @param {boolean} [opts.isLocal]
   */
  constructor({
    podId,
    status = 'online',
    capabilities = [],
    services = [],
    connections = 0,
    uptime = 0,
    resources = {},
    isLocal = false,
  }) {
    if (!podId || typeof podId !== 'string') {
      throw new Error('podId is required and must be a non-empty string')
    }
    this.podId = podId
    this.status = status
    this.capabilities = [...capabilities]
    this.services = [...services]
    this.connections = connections
    this.uptime = uptime
    this.resources = {
      cpu: resources.cpu ?? 0,
      memory: resources.memory ?? 0,
      storage: resources.storage ?? 0,
    }
    this.isLocal = isLocal
  }

  toJSON() {
    return {
      podId: this.podId,
      status: this.status,
      capabilities: [...this.capabilities],
      services: [...this.services],
      connections: this.connections,
      uptime: this.uptime,
      resources: { ...this.resources },
      isLocal: this.isLocal,
    }
  }

  /**
   * @param {object} data
   * @returns {PodStatus}
   */
  static fromJSON(data) {
    return new PodStatus(data)
  }
}

// ---------------------------------------------------------------------------
// PodResourceInfo
// ---------------------------------------------------------------------------

/**
 * Resource usage snapshot for a single pod (used by topPods).
 */
export class PodResourceInfo {
  /**
   * @param {object} opts
   * @param {string} opts.podId
   * @param {number} [opts.cpu]
   * @param {number} [opts.memory]
   * @param {number} [opts.storage]
   * @param {number} [opts.activeTasks]
   * @param {string} [opts.status]
   */
  constructor({
    podId,
    cpu = 0,
    memory = 0,
    storage = 0,
    activeTasks = 0,
    status = 'online',
  }) {
    this.podId = podId
    this.cpu = cpu
    this.memory = memory
    this.storage = storage
    this.activeTasks = activeTasks
    this.status = status
  }

  toJSON() {
    return {
      podId: this.podId,
      cpu: this.cpu,
      memory: this.memory,
      storage: this.storage,
      activeTasks: this.activeTasks,
      status: this.status,
    }
  }
}

// ---------------------------------------------------------------------------
// MeshOrchestrator
// ---------------------------------------------------------------------------

/**
 * Coordinates pods across the P2P mesh network.
 * Provides pod queries, remote execution, deployment, draining,
 * resource monitoring, and service operations.
 */
export class MeshOrchestrator {
  /** @type {object|null} PeerNode -- the local peer */
  #peerNode
  /** @type {object|null} ServiceAdvertiser */
  #serviceAdvertiser
  /** @type {object|null} ServiceBrowser */
  #serviceBrowser
  /** @type {object|null} MeshRouter */
  #router
  /** @type {Function|null} */
  #onLog
  /** @type {object|null} */
  #runtimeRegistry
  /** @type {object|null} */
  #remoteSessionBroker
  /** @type {object|null} */
  #resourceRegistry
  /** @type {object|null} */
  #auditRecorder
  /** @type {object|null} */
  #peerRegistry
  /** @type {object|null} PodHostClient -- injected, or lazily built from #peerNode */
  #podHostClient
  /** @type {Promise<object>|null} In-flight lazy `createPodHostClient()` import */
  #podHostClientPromise = null
  /** @type {Map<string, object>} podId -> peer info */
  #knownPeers = new Map()
  /** @type {Map<string, object>} name -> { podId, port } */
  #exposedServices = new Map()
  /** @type {Map<string, object>} name -> targetPodId */
  #routes = new Map()
  /** @type {Map<string, object>} tunnelId -> tunnel record */
  #tunnels = new Map()
  /** @type {Set<string>} podIds currently draining */
  #draining = new Set()
  /** @type {number} */
  #tunnelCounter = 0

  /**
   * @param {object} opts
   * @param {object} opts.peerNode        - PeerNode -- the local peer
   * @param {object} [opts.serviceAdvertiser] - ServiceAdvertiser or null
   * @param {object} [opts.serviceBrowser]    - ServiceBrowser or null
   * @param {object} [opts.router]            - MeshRouter or null
   * @param {object} [opts.runtimeRegistry]   - RemoteRuntimeRegistry or null
   * @param {object} [opts.remoteSessionBroker] - RemoteSessionBroker or null
   * @param {object} [opts.resourceRegistry] - ResourceRegistry or null
   * @param {object} [opts.auditRecorder]     - RemoteRuntimeAuditRecorder or null
   * @param {object} [opts.peerRegistry]      - PeerRegistry or null
   * @param {object} [opts.podHostClient]     - `PodHostClient`
   *   (`pod-host-service.mjs`) used by `spawnPod()`/`snapshotPod()`/
   *   `restorePod()`/`listHostedPods()`. Lazily built from `peerNode` on
   *   first use when omitted.
   * @param {Function} [opts.onLog]           - Logging callback
   */
  constructor({ peerNode, serviceAdvertiser, serviceBrowser, router, runtimeRegistry, remoteSessionBroker, resourceRegistry, auditRecorder, peerRegistry, podHostClient, onLog }) {
    if (!peerNode) {
      throw new Error('peerNode is required')
    }
    this.#peerNode = peerNode
    this.#serviceAdvertiser = serviceAdvertiser ?? null
    this.#serviceBrowser = serviceBrowser ?? null
    this.#router = router ?? null
    this.#runtimeRegistry = runtimeRegistry ?? null
    this.#remoteSessionBroker = remoteSessionBroker ?? null
    this.#resourceRegistry = resourceRegistry ?? null
    this.#auditRecorder = auditRecorder ?? null
    this.#peerRegistry = peerRegistry ?? null
    this.#podHostClient = podHostClient ?? null
    this.#onLog = onLog ?? null
  }

  /** @returns {object} The local peer node */
  get peerNode() {
    return this.#peerNode
  }

  /** @returns {string} Local pod ID (cached from peerNode) */
  get localPodId() {
    return this.#peerNode.podId || this.#peerNode.id || 'local'
  }

  // -- Logging --------------------------------------------------------------

  #log(msg) {
    if (this.#onLog) this.#onLog(msg)
  }

  async #recordAudit(operation, data = {}) {
    await this.#auditRecorder?.record?.(operation, data)
  }

  /**
   * Record a placement-lifecycle audit event (issue #185 §7/§8 WP4): one of
   * `PLACEMENT_AUDIT`'s `placement_requested`/`placement_denied`/
   * `placement_started`/`placement_ready`/`placement_evicted`. Writes
   * through the same `#recordAudit` path as `execOnPod`/`deploySkill`'s
   * `remote_*` records -- a no-op when no `auditRecorder` is wired. This is
   * vocabulary + audit plumbing only: WP4 does not implement the placement
   * RPC itself (spawning/restoring a hosted pod), that is WP2 (isolate pod
   * host) / WP3 (microVM pod host).
   *
   * @param {string} kind - One of `PLACEMENT_AUDIT`'s values
   * @param {object} [details]
   * @returns {Promise<void>}
   */
  async recordPlacement(kind, details = {}) {
    await this.#recordAudit(kind, details)
  }

  // -- Hosted pods (issue #185 control surface) -----------------------------

  /**
   * The `PodHostClient` used by `spawnPod()` and friends: the injected one
   * when the constructor was given a `podHostClient`, otherwise one built
   * lazily from this orchestrator's own `peerNode`.
   *
   * `pod-host-service.mjs` is imported DYNAMICALLY rather than at module
   * top level on purpose: that module imports `PLACEMENT_AUDIT` from this
   * one, and a static import in both directions would be a cycle. This is
   * the same lazy-`await import()` convention `mesh-hardening.mjs` /
   * `key-distribution.mjs` already use for the apps<->core pair (see
   * AGENTS.md's "Cross-package relationship" note).
   *
   * @returns {Promise<object>} A `PodHostClient`.
   */
  async #hostClient() {
    if (this.#podHostClient) return this.#podHostClient
    if (!this.#podHostClientPromise) {
      this.#podHostClientPromise = import('./pod-host-service.mjs')
        .then(({ createPodHostClient }) => createPodHostClient({ peerNode: this.#peerNode }))
    }
    this.#podHostClient = await this.#podHostClientPromise
    return this.#podHostClient
  }

  /**
   * Spawn a hosted pod on a pod host, recording the requester half of the
   * placement audit trail (`placement_requested` on the way out, then
   * `placement_ready` or `placement_denied`). The HOST writes its own,
   * independent `placement_started`/`placement_ready` records -- see
   * `pod-host-service.mjs`'s module doc comment on why the two chains are
   * deliberately separate.
   *
   * @param {string} hostPodId - The host pod's pubKey/podId.
   * @param {object} spec - A podspec (`validatePodSpec()` in
   *   `@johnhenry/browsermesh-pod`), validated host-side.
   * @returns {Promise<object>} The host's pod status.
   */
  async spawnPod(hostPodId, spec) {
    const client = await this.#hostClient()
    await this.recordPlacement(PLACEMENT_AUDIT.REQUESTED, {
      actor: 'operator', hostPodId, name: spec?.name ?? null, lane: spec?.lane ?? null,
    })
    try {
      const result = await client.spawn(hostPodId, spec)
      await this.recordPlacement(PLACEMENT_AUDIT.READY, {
        actor: 'operator', hostPodId, name: result?.name ?? spec?.name ?? null,
        lane: result?.lane ?? null, state: result?.state ?? null,
      })
      return result
    } catch (err) {
      if (err?.code === 'EACCES') {
        await this.recordPlacement(PLACEMENT_AUDIT.DENIED, {
          actor: 'operator', hostPodId, name: spec?.name ?? null, reason: err.message,
        })
      }
      throw err
    }
  }

  /**
   * Snapshot a hosted pod. A snapshotted pod has left the host's live set
   * (§5.3: the VMM is killed), so this records `placement_evicted`.
   *
   * @param {string} hostPodId
   * @param {string} name
   * @returns {Promise<object>}
   */
  async snapshotPod(hostPodId, name) {
    const client = await this.#hostClient()
    const result = await client.snapshot(hostPodId, name)
    await this.recordPlacement(PLACEMENT_AUDIT.EVICTED, {
      actor: 'operator', hostPodId, name, reason: 'snapshot', state: result?.state ?? null,
    })
    return result
  }

  /**
   * Restore a snapshotted hosted pod, recording the same
   * `placement_requested` -> `placement_ready` pair `spawnPod()` does: from
   * the requester's point of view a restore IS a placement.
   *
   * @param {string} hostPodId
   * @param {string} name
   * @returns {Promise<object>}
   */
  async restorePod(hostPodId, name) {
    const client = await this.#hostClient()
    await this.recordPlacement(PLACEMENT_AUDIT.REQUESTED, {
      actor: 'operator', hostPodId, name, reason: 'restore',
    })
    try {
      const result = await client.restore(hostPodId, name)
      await this.recordPlacement(PLACEMENT_AUDIT.READY, {
        actor: 'operator', hostPodId, name, reason: 'restore', state: result?.state ?? null,
      })
      return result
    } catch (err) {
      if (err?.code === 'EACCES') {
        await this.recordPlacement(PLACEMENT_AUDIT.DENIED, {
          actor: 'operator', hostPodId, name, reason: err.message,
        })
      }
      throw err
    }
  }

  /**
   * List the pods a host is tracking. Read-only: no audit record, matching
   * `listPods()`.
   *
   * @param {string} hostPodId
   * @returns {Promise<object[]>}
   */
  async listHostedPods(hostPodId) {
    const client = await this.#hostClient()
    return client.list(hostPodId)
  }

  /**
   * List known pod hosts (issue #185 control surface item 4's `meshctl_hosts`):
   * runtime-registry peers whose `describe()` was projected through
   * `podHostRuntimePeer()` (`pod-host-service.mjs`), i.e. peers carrying a
   * `metadata.podHost` entry. Read-only, from the same `#runtimeDescriptors()`
   * source `#collectComputeDescriptors()` already walks -- no audit record,
   * matching `listHostedPods()`/`listPods()`.
   *
   * Deliberately NOT routed through `#collectComputeDescriptors()` /
   * `listComputeCandidates()`: those drop any pod host with no `exec`
   * (every ISOLATE-lane host, by lane definition -- see
   * `pod-host-service.mjs`'s `podHostRuntimePeer()` doc comment and this
   * package's README "Known limitation" section) before a caller ever gets
   * a chance to filter on lane. Reading `#runtimeDescriptors()` directly
   * sidesteps that filter, so an isolate host is listed here even though it
   * is invisible to `listComputeCandidates()`.
   *
   * @returns {Array<{podId: string, lane: string|null, verbs: string[], runtimeClasses: string[], shellBackend: string|null, resource: string, capabilities: string[], hostedBy: string|null}>}
   */
  async listPodHosts() {
    const hosts = []
    for (const peer of this.#runtimeDescriptors()) {
      const podHost = peer.metadata?.podHost
      if (!podHost) continue
      const podId = this.#descriptorPodId(peer)
      if (!podId) continue
      hosts.push({
        podId,
        lane: (peer.metadata?.runtimeClasses || [])[0] ?? null,
        verbs: [...(podHost.verbs || [])],
        runtimeClasses: [...(peer.metadata?.runtimeClasses || [])],
        shellBackend: peer.shellBackend ?? null,
        resource: podHost.resource || 'pod-host',
        capabilities: [...(peer.capabilities || [])],
        hostedBy: peer.metadata?.hostedBy || null,
      })
    }
    return hosts
  }

  #recordComputeReputation(descriptor, score) {
    const fingerprint = descriptor?.identity?.fingerprint || null
    if (!fingerprint || !this.#peerRegistry?.recordObservedTrust) return
    this.#peerRegistry.recordObservedTrust(fingerprint, score)
  }

  // -- Pod queries ----------------------------------------------------------

  /**
   * List all known pods (local + remote).
   * @param {string} [filter] - Status filter: 'online', 'offline', 'all'
   * @returns {Promise<PodInfo[]>}
   */
  async listPods(filter) {
    const pods = []

    // Local pod is always included
    const localPodId = this.localPodId
    const localServices = this.#getLocalServices()
    const localPod = new PodInfo({
      podId: localPodId,
      label: this.#peerNode.label || localPodId,
      status: this.#draining.has(localPodId) ? 'draining' : 'online',
      services: localServices,
      connections: this.#knownPeers.size,
      isLocal: true,
    })
    pods.push(localPod)

    // Add known remote peers
    for (const [podId, info] of this.#knownPeers) {
      const status = this.#draining.has(podId) ? 'draining' : (info.status || 'online')
      pods.push(new PodInfo({
        podId,
        label: info.label || podId,
        status,
        services: info.services || [],
        connections: info.connections ?? 0,
        isLocal: false,
      }))
    }

    const knownPodIds = new Set(pods.map((pod) => pod.podId))
    for (const descriptor of this.#runtimeDescriptors()) {
      const podId = this.#descriptorPodId(descriptor)
      if (knownPodIds.has(podId)) continue
      knownPodIds.add(podId)
      pods.push(new PodInfo({
        podId,
        label: this.#descriptorLabel(descriptor),
        status: this.#descriptorStatus(descriptor, podId),
        services: descriptor.metadata?.services || [],
        connections: descriptor.reachability?.length || 0,
        isLocal: false,
      }))
    }

    // Apply filter
    if (filter && filter !== 'all') {
      return pods.filter(p => p.status === filter)
    }
    return pods
  }

  /**
   * Get detailed status for a specific pod.
   * @param {string} podId
   * @returns {Promise<PodStatus|null>}
   */
  async getPodStatus(podId) {
    const localPodId = this.localPodId

    if (podId === localPodId) {
      return new PodStatus({
        podId: localPodId,
        status: this.#draining.has(localPodId) ? 'draining' : 'online',
        capabilities: this.#peerNode.capabilities || [],
        services: this.#getLocalServices(),
        connections: this.#knownPeers.size,
        uptime: this.#peerNode.uptime ?? 0,
        resources: this.#peerNode.resources || {},
        isLocal: true,
      })
    }

    const info = this.#knownPeers.get(podId)
    if (!info) {
      const descriptor = this.#runtimeDescriptorForPodId(podId)
      if (!descriptor) return null
      return new PodStatus({
        podId,
        status: this.#descriptorStatus(descriptor, podId),
        capabilities: descriptor.capabilities || [],
        services: descriptor.metadata?.services || [],
        connections: descriptor.reachability?.length || 0,
        uptime: descriptor.metadata?.uptime ?? 0,
        resources: descriptor.metadata?.resources || {},
        isLocal: false,
      })
    }

    return new PodStatus({
      podId,
      status: this.#draining.has(podId) ? 'draining' : (info.status || 'online'),
      capabilities: info.capabilities || [],
      services: info.services || [],
      connections: info.connections ?? 0,
      uptime: info.uptime ?? 0,
      resources: info.resources || {},
      isLocal: false,
    })
  }

  // -- Remote execution -----------------------------------------------------

  /**
   * Execute a command on a remote pod via peer session.
   * @param {string} podId
   * @param {string} command
   * @returns {Promise<{ output: string, exitCode: number }>}
   */
  async execOnPod(podId, command) {
    if (!command || typeof command !== 'string') {
      throw new Error('command is required and must be a non-empty string')
    }

    const localPodId = this.localPodId
    if (podId === localPodId) {
      // Execute locally via peerNode if it has an exec method
      if (this.#peerNode.exec) {
        return await this.#peerNode.exec(command)
      }
      return { output: `Local execution not supported`, exitCode: 1 }
    }

    const runtime = this.#resolveRuntime(podId)
    if (runtime && isIsolateOnlyRuntime(runtime)) {
      await this.#recordAudit('remote_exec_denied', {
        actor: 'operator',
        podId,
        reason: 'isolate runtime cannot execute shell commands',
        layer: 'runtime',
      })
      return {
        output: 'pod runtime "isolate" cannot execute shell commands; use deploySkill or a microvm pod',
        exitCode: 126,
      }
    }
    if (runtime && this.#remoteSessionBroker) {
      const result = await this.#remoteSessionBroker.openSession(podId, {
        intent: 'exec',
        command,
      })
      if (typeof result?.output === 'string') {
        return { output: result.output, exitCode: result.exitCode ?? 0 }
      }
    }

    const info = this.#knownPeers.get(podId)
    if (!info) {
      throw new Error(`Pod "${podId}" not found`)
    }

    // Delegate to the peer's terminal/session if available
    if (info.exec) {
      return await info.exec(command)
    }
    if (info.send) {
      info.send({ type: 'exec', command })
      return { output: `Command sent to ${podId}`, exitCode: 0 }
    }

    throw new Error(`Pod "${podId}" does not support remote execution`)
  }

  // -- Deployment -----------------------------------------------------------

  /**
   * Deploy a skill (SKILL.md content) to a remote pod.
   * @param {string} podId
   * @param {string} skillContent - SKILL.md content to deploy
   * @returns {Promise<{ success: boolean, error?: string }>}
   */
  async deploySkill(podId, skillContent) {
    if (!skillContent || typeof skillContent !== 'string') {
      return { success: false, error: 'skillContent is required' }
    }

    const runtime = this.#resolveRuntime(podId)
    if (runtime && this.#remoteSessionBroker) {
      if (runtime.metadata?.deploymentSupport?.canDeploy !== true) {
        await this.#recordAudit('remote_deploy_denied', {
          actor: 'operator',
          podId,
          reason: 'target does not advertise deployment support',
          layer: 'capability',
          deploymentType: 'skill',
        })
        return { success: false, error: `Pod "${podId}" does not advertise deployment support` }
      }
      const skillName = deriveSkillName(skillContent)
      const path = `/.skills/${skillName}/SKILL.md`
      await this.#recordAudit('remote_deploy_started', {
        actor: 'operator',
        podId,
        path,
        deploymentType: 'skill',
      })
      await this.#remoteSessionBroker.openSession(podId, {
        intent: 'deployment',
        operation: 'upload',
        path,
        data: skillContent,
        requiredCapabilities: ['fs'],
        actor: 'operator',
      })
      await this.#recordAudit('remote_deploy_completed', {
        actor: 'operator',
        podId,
        path,
        deploymentType: 'skill',
      })
      return { success: true, path }
    }

    const info = this.#knownPeers.get(podId)
    if (!info) {
      return { success: false, error: `Pod "${podId}" not found` }
    }

    this.#log(`Deploying skill to ${podId} (${skillContent.length} bytes)`)

    if (info.deploySkill) {
      return await info.deploySkill(skillContent)
    }
    if (info.send) {
      info.send({ type: 'deploy_skill', content: skillContent })
      return { success: true }
    }

    return { success: false, error: `Pod "${podId}" does not support deployment` }
  }

  async listRemoteServices(filter = {}) {
    const discovered = []

    if (this.#serviceBrowser?.discover) {
      for (const service of this.#serviceBrowser.discover(filter)) {
        discovered.push({ ...service, source: 'service-browser' })
      }
    }

    for (const descriptor of this.#runtimeDescriptors()) {
      const podId = this.#descriptorPodId(descriptor)
      const details = descriptor.metadata?.serviceDetails || {}
      const names = descriptor.metadata?.services || Object.keys(details)
      for (const name of names) {
        const detail = details[name] || { name }
        if (filter.type && detail.type && detail.type !== filter.type) continue
        if (filter.podId && filter.podId !== podId) continue
        discovered.push({
          ...detail,
          name,
          podId,
          source: 'runtime-registry',
        })
      }
    }

    return discovered
  }

  async browseRemoteFiles(podId, path = '/') {
    const runtime = this.#resolveRuntime(podId)
    if (runtime && this.#remoteSessionBroker) {
      const result = await this.#remoteSessionBroker.openSession(podId, {
        intent: 'files',
        operation: 'list',
        path,
      })
      return { entries: result.entries || [] }
    }
    throw new Error(`Pod "${podId}" does not support remote filesystem browsing`)
  }

  async readRemoteFile(podId, path) {
    if (!path || typeof path !== 'string') {
      throw new Error('path is required')
    }
    const runtime = this.#resolveRuntime(podId)
    if (runtime && this.#remoteSessionBroker) {
      const result = await this.#remoteSessionBroker.openSession(podId, {
        intent: 'files',
        operation: 'read',
        path,
      })
      return result.content || ''
    }
    throw new Error(`Pod "${podId}" does not support remote file reads`)
  }

  async writeRemoteFile(podId, path, content) {
    if (!path || typeof path !== 'string') {
      throw new Error('path is required')
    }
    const runtime = this.#resolveRuntime(podId)
    if (runtime && this.#remoteSessionBroker) {
      await this.#remoteSessionBroker.openSession(podId, {
        intent: 'files',
        operation: 'write',
        path,
        data: content,
      })
      return { success: true }
    }
    throw new Error(`Pod "${podId}" does not support remote file writes`)
  }

  async runAutomationOnPod(podId, command) {
    return this.runComputeTask({ selector: podId, command })
  }

  async listComputeCandidates(constraints = {}) {
    return this.#collectComputeDescriptors(constraints).map((descriptor) => ({
      podId: descriptor.podId,
      resources: { ...descriptor.resources },
      capabilities: [...descriptor.capabilities],
      availability: descriptor.availability,
      source: descriptor.source || 'resource-registry',
    }))
  }

  selectComputeTarget({ selector = null, constraints = {}, request = null } = {}) {
    const nextRequest = request instanceof ComputeRequest
      ? request
      : new ComputeRequest({
          moduleType: 'js',
          moduleCid: 'runtime-task',
          entry: 'main',
          constraints,
          requesterId: this.localPodId,
        })

    const descriptors = this.#collectComputeDescriptors(nextRequest.constraints || {})
    if (selector) {
      const selected = descriptors.find((descriptor) => descriptor.podId === selector)
      if (!selected) {
        throw new Error(`Pod "${selector}" is not available for compute`)
      }
      return {
        podId: selected.podId,
        descriptor: selected,
        request: nextRequest,
        source: selected.source || 'resource-registry',
      }
    }

    const selected = ResourceScorer.selectBest(nextRequest, descriptors)
    if (!selected) {
      throw new Error('No compute-capable runtime matches the requested constraints')
    }
    return {
      podId: selected.podId,
      descriptor: selected,
      request: nextRequest,
      source: selected.source || 'resource-registry',
    }
  }

  async runComputeTask({ selector = null, command, constraints = {}, timeoutMs = null } = {}) {
    if (!command || typeof command !== 'string') {
      throw new Error('command is required')
    }

    const selection = this.selectComputeTarget({ selector, constraints })
    const podId = selection.podId
    await this.#recordAudit('remote_compute_dispatched', {
      actor: 'automation',
      podId,
      source: selection.source,
      preferRuntimeClass: constraints?.preferRuntimeClass || null,
    })
    const runtime = this.#resolveRuntime(podId)
    if (runtime && this.#remoteSessionBroker) {
      try {
        const result = await this.#remoteSessionBroker.openSession(podId, {
          intent: 'automation',
          command,
          timeout: timeoutMs || selection.request?.constraints?.timeoutMs || 30_000,
        })
        this.#recordComputeReputation(runtime, (result.exitCode ?? 0) === 0 ? 1 : 0.7)
        await this.#recordAudit('remote_compute_completed', {
          actor: 'automation',
          podId,
          source: selection.source,
          exitCode: result.exitCode ?? 0,
        })
        return {
          podId,
          output: result.output || '',
          exitCode: result.exitCode ?? 0,
          source: selection.source,
        }
      } catch (error) {
        this.#recordComputeReputation(runtime, 0)
        throw error
      }
    }

    if (podId === this.localPodId && this.#peerNode.exec) {
      const result = await this.#peerNode.exec(command)
      await this.#recordAudit('remote_compute_completed', {
        actor: 'automation',
        podId,
        source: 'local',
        exitCode: result.exitCode ?? 0,
      })
      return { podId, output: result.output || '', exitCode: result.exitCode ?? 0, source: 'local' }
    }

    const info = this.#knownPeers.get(podId)
    if (info?.exec) {
      const result = await info.exec(command)
      await this.#recordAudit('remote_compute_completed', {
        actor: 'automation',
        podId,
        source: 'known-peer',
        exitCode: result.exitCode ?? 0,
      })
      return { podId, output: result.output || '', exitCode: result.exitCode ?? 0, source: 'known-peer' }
    }
    if (info?.send) {
      info.send({ type: 'compute', command, constraints })
      await this.#recordAudit('remote_compute_completed', {
        actor: 'automation',
        podId,
        source: 'known-peer',
        exitCode: 0,
      })
      return { podId, output: `Compute task sent to ${podId}`, exitCode: 0, source: 'known-peer' }
    }

    throw new Error(`Pod "${podId}" does not support compute execution`)
  }

  // -- Pod management -------------------------------------------------------

  /**
   * Gracefully drain a pod: mark it as draining, migrate tasks, disconnect.
   * @param {string} podId
   * @returns {Promise<{ success: boolean, migrated: number }>}
   */
  async drainPod(podId) {
    const info = this.#knownPeers.get(podId)
    const localPodId = this.localPodId

    if (podId !== localPodId && !info) {
      return { success: false, migrated: 0 }
    }

    this.#draining.add(podId)
    this.#log(`Draining pod ${podId}`)

    let migrated = 0

    // If the peer has a drain callback, invoke it
    if (info && info.drain) {
      const result = await info.drain()
      migrated = result?.migrated ?? 0
    }

    // Remove from known peers (disconnect)
    if (podId !== localPodId) {
      this.#knownPeers.delete(podId)
    }

    return { success: true, migrated }
  }

  // -- Resource usage -------------------------------------------------------

  /**
   * Snapshot of resource usage across all known pods.
   * @returns {Promise<{ pods: PodResourceInfo[] }>}
   */
  async topPods() {
    const pods = []
    const localPodId = this.localPodId
    const localRes = this.#peerNode.resources || {}

    pods.push(new PodResourceInfo({
      podId: localPodId,
      cpu: localRes.cpu ?? 0,
      memory: localRes.memory ?? 0,
      storage: localRes.storage ?? 0,
      activeTasks: this.#peerNode.activeTasks ?? 0,
      status: this.#draining.has(localPodId) ? 'draining' : 'online',
    }))

    for (const [podId, info] of this.#knownPeers) {
      const res = info.resources || {}
      pods.push(new PodResourceInfo({
        podId,
        cpu: res.cpu ?? 0,
        memory: res.memory ?? 0,
        storage: res.storage ?? 0,
        activeTasks: info.activeTasks ?? 0,
        status: this.#draining.has(podId) ? 'draining' : (info.status || 'online'),
      }))
    }

    const knownPodIds = new Set(pods.map((pod) => pod.podId))
    for (const descriptor of this.#runtimeDescriptors()) {
      const podId = this.#descriptorPodId(descriptor)
      if (knownPodIds.has(podId)) continue
      knownPodIds.add(podId)
      const resources = descriptor.metadata?.resources || {}
      pods.push(new PodResourceInfo({
        podId,
        cpu: resources.cpu ?? 0,
        memory: resources.memory ?? 0,
        storage: resources.storage ?? 0,
        activeTasks: descriptor.metadata?.activeTasks ?? 0,
        status: this.#descriptorStatus(descriptor, podId),
      }))
    }

    return { pods }
  }

  // -- Service operations ---------------------------------------------------

  /**
   * Expose a pod service on the mesh.
   * @param {string} podId
   * @param {number} port
   * @param {string} name - Service name
   * @returns {Promise<{ success: boolean, address?: string }>}
   */
  async exposePod(podId, port, name) {
    if (!name || typeof name !== 'string') {
      return { success: false }
    }
    if (typeof port !== 'number' || !Number.isFinite(port) || port <= 0 || port > 65535) {
      return { success: false }
    }

    const address = `${podId}:${port}`
    this.#exposedServices.set(name, { podId, port, address })
    this.#log(`Exposed service "${name}" at ${address}`)

    // Advertise via service advertiser if available
    if (this.#serviceAdvertiser && this.#serviceAdvertiser.advertise) {
      this.#serviceAdvertiser.advertise({ name, type: 'http-proxy', podId, port })
    }

    return { success: true, address }
  }

  /**
   * Route a named service to a target pod.
   * @param {string} name - Service name
   * @param {string} targetPodId
   * @returns {Promise<{ success: boolean }>}
   */
  async routeService(name, targetPodId) {
    if (!name || typeof name !== 'string') {
      return { success: false }
    }
    if (!targetPodId || typeof targetPodId !== 'string') {
      return { success: false }
    }

    this.#routes.set(name, targetPodId)
    this.#log(`Routed service "${name}" to ${targetPodId}`)

    // Update router if available
    if (this.#router && this.#router.addRoute) {
      this.#router.addRoute(targetPodId, targetPodId, 1)
    }

    return { success: true }
  }

  // -- Tunnel (port forwarding concept) ------------------------------------

  /**
   * Create a port-forwarding tunnel to a remote pod.
   * @param {string} podId
   * @param {number} remotePort
   * @param {number} localPort
   * @returns {Promise<{ success: boolean, tunnelId?: string }>}
   */
  async tunnelPort(podId, remotePort, localPort) {
    if (!podId || typeof podId !== 'string') {
      return { success: false }
    }
    if (typeof remotePort !== 'number' || remotePort <= 0) {
      return { success: false }
    }
    if (typeof localPort !== 'number' || localPort <= 0) {
      return { success: false }
    }

    const tunnelId = `tunnel_${++this.#tunnelCounter}`
    this.#tunnels.set(tunnelId, { podId, remotePort, localPort, createdAt: Date.now() })
    this.#log(`Tunnel ${tunnelId}: local:${localPort} -> ${podId}:${remotePort}`)

    return { success: true, tunnelId }
  }

  // -- Peer management (used by the mesh layer to keep state in sync) ------

  /**
   * Register a known remote peer.
   * @param {string} podId
   * @param {object} info - { label, status, services, capabilities, resources, connections, uptime, exec?, send?, drain?, deploySkill? }
   */
  addPeer(podId, info) {
    this.#knownPeers.set(podId, info)
  }

  /**
   * Remove a known remote peer.
   * @param {string} podId
   * @returns {boolean}
   */
  removePeer(podId) {
    this.#draining.delete(podId)
    return this.#knownPeers.delete(podId)
  }

  /**
   * Number of known remote peers.
   * @returns {number}
   */
  get peerCount() {
    return this.#knownPeers.size
  }

  // -- Internal helpers -----------------------------------------------------

  #getLocalServices() {
    const services = []
    for (const [name, entry] of this.#exposedServices) {
      const localPodId = this.localPodId
      if (entry.podId === localPodId) {
        services.push(name)
      }
    }
    return services
  }

  #runtimeDescriptors() {
    if (!this.#runtimeRegistry || typeof this.#runtimeRegistry.listPeers !== 'function') {
      return []
    }
    return this.#runtimeRegistry.listPeers()
  }

  #runtimeDescriptorForPodId(podId) {
    if (!this.#runtimeRegistry || typeof this.#runtimeRegistry.resolvePeer !== 'function') {
      return null
    }
    return this.#runtimeRegistry.resolvePeer(podId)
  }

  #resolveRuntime(podId) {
    return this.#runtimeDescriptorForPodId(podId)
      || this.#runtimeRegistry?.resolvePeer?.(`@${podId}`)
      || null
  }

  #descriptorPodId(descriptor) {
    return descriptor.identity?.podId
      || descriptor.identity?.fingerprint
      || descriptor.identity?.canonicalId
      || descriptor.username
  }

  #descriptorLabel(descriptor) {
    return descriptor.metadata?.name
      || descriptor.username
      || descriptor.identity?.aliases?.[0]
      || this.#descriptorPodId(descriptor)
  }

  #descriptorStatus(descriptor, podId) {
    if (this.#draining.has(podId)) return 'draining'
    const route = (descriptor.reachability || [])[0]
    const status = descriptor.metadata?.status
    if (status) return status
    return route ? 'online' : 'unknown'
  }

  #collectComputeDescriptors(constraints = {}) {
    const merged = new Map()
    const descriptors = []

    const localDescriptor = new ResourceDescriptor({
      podId: this.localPodId,
      resources: this.#peerNode.resources || {},
      capabilities: dedupeStrings([
        ...(this.#peerNode.capabilities || []),
        ...(this.#peerNode.exec ? ['compute'] : []),
      ]),
      availability: this.#draining.has(this.localPodId) ? 'busy' : 'online',
    })
    if (localDescriptor.capabilities.includes('compute')) {
      localDescriptor.source = 'local'
      descriptors.push(localDescriptor)
    }

    if (this.#resourceRegistry?.discover) {
      for (const descriptor of this.#resourceRegistry.discover(constraints)) {
        descriptors.push(Object.assign(ResourceDescriptor.fromJSON(descriptor.toJSON()), {
          source: descriptor.source || 'resource-registry',
        }))
      }
    }

    for (const peer of this.#runtimeDescriptors()) {
      const descriptor = runtimePeerToComputeDescriptor(peer)
      if (!descriptor) continue
      if (constraints && !descriptor.matches(constraints)) continue
      descriptors.push(descriptor)
    }

    for (const descriptor of descriptors) {
      const existing = merged.get(descriptor.podId)
      merged.set(descriptor.podId, existing ? mergeResourceDescriptors(existing, descriptor) : descriptor)
    }

    return [...merged.values()]
  }
}

function runtimePeerToComputeDescriptor(peer) {
  const podId = peer?.identity?.podId
    || peer?.identity?.fingerprint
    || peer?.identity?.canonicalId
    || peer?.username
  if (!podId) return null
  const capabilities = dedupeStrings([
    ...(peer.capabilities || []),
    ...((peer.metadata?.runtimeClasses || []).map((runtimeClass) => `runtime:${runtimeClass}`)),
    ...(peer.peerType ? [`runtime:${peer.peerType}`] : []),
    ...(peer.shellBackend ? [`runtime:${peer.shellBackend}`] : []),
    ...(peer.shellBackend === 'vm-console' ? ['vm_console'] : []),
    ...(peer.shellBackend === 'pty' ? ['host_pty'] : []),
    ...((peer.capabilities || []).some((cap) => cap === 'shell' || cap === 'exec' || cap === 'tools')
      ? ['compute']
      : []),
  ])
  if (!capabilities.includes('compute')) {
    return null
  }
  const route = (peer.reachability || [])[0] || null
  const availability = route?.health === 'offline'
    ? 'offline'
    : route?.health === 'degraded'
      ? 'busy'
      : 'online'
  const descriptor = new ResourceDescriptor({
    podId,
    resources: peer.metadata?.resources || {},
    capabilities,
    availability,
    hostedBy: peer.metadata?.hostedBy || null,
  })
  descriptor.source = 'runtime-registry'
  return descriptor
}

/**
 * Whether a runtime-registry peer's advertised runtime classes mean it can
 * only run inside a V8 isolate (issue #185 §6/§8 WP4): `'isolate'` is one
 * of its `metadata.runtimeClasses`, and nothing else about the peer --
 * another runtime class of `'microvm'`/`'node'`/`'browser'`, or an
 * explicit `shellBackend` -- says it can also execute shell commands. Used
 * by `execOnPod()` to deny shell execution against isolate-only pods
 * instead of silently dispatching a request the pod has no way to honor.
 *
 * @param {object} runtime - A runtime-registry peer, as returned by
 *   `#resolveRuntime()` (the same shape `runtimePeerToComputeDescriptor()`
 *   and `deploySkill()`'s `runtime.metadata?.deploymentSupport` read).
 * @returns {boolean}
 */
function isIsolateOnlyRuntime(runtime) {
  const runtimeClasses = runtime?.metadata?.runtimeClasses || []
  if (!runtimeClasses.includes(RUNTIME_CLASS.ISOLATE)) return false
  if (runtimeClasses.includes(RUNTIME_CLASS.MICROVM)) return false
  if (runtimeClasses.includes(RUNTIME_CLASS.NODE)) return false
  if (runtimeClasses.includes(RUNTIME_CLASS.BROWSER)) return false
  if (runtime?.shellBackend) return false
  return true
}

function mergeResourceDescriptors(base, incoming) {
  const merged = new ResourceDescriptor({
    podId: base.podId,
    resources: {
      cpu: incoming.resources.cpu || base.resources.cpu,
      gpu: incoming.resources.gpu || base.resources.gpu,
      memory: incoming.resources.memory || base.resources.memory,
      storage: incoming.resources.storage || base.resources.storage,
      bandwidth: incoming.resources.bandwidth || base.resources.bandwidth,
    },
    capabilities: dedupeStrings([...(base.capabilities || []), ...(incoming.capabilities || [])]),
    availability: availabilityPriority(incoming.availability) > availabilityPriority(base.availability)
      ? incoming.availability
      : base.availability,
    hostedBy: incoming.hostedBy || base.hostedBy || null,
  })
  merged.source = incoming.source || base.source || 'resource-registry'
  return merged
}

function availabilityPriority(value) {
  switch (value) {
    case 'online':
      return 3
    case 'busy':
      return 2
    default:
      return 1
  }
}

function dedupeStrings(values) {
  return [...new Set((values || []).filter(Boolean))]
}

function deriveSkillName(skillContent) {
  const frontmatter = /^---\s*[\r\n]+([\s\S]*?)[\r\n]+---/.exec(skillContent)
  if (frontmatter) {
    const nameMatch = /(?:^|\n)name:\s*([a-zA-Z0-9._-]+)/.exec(frontmatter[1])
    if (nameMatch?.[1]) return nameMatch[1]
  }
  const heading = /^#\s+([^\r\n]+)/m.exec(skillContent)
  if (heading?.[1]) {
    return heading[1].trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-')
  }
  return `skill-${Date.now().toString(36)}`
}

// ---------------------------------------------------------------------------
// BrowserTool subclasses
// ---------------------------------------------------------------------------

// ── meshctl_pods ──────────────────────────────────────────────────────

export class MeshctlPodsTool extends BrowserTool {
  #orchestrator

  constructor(orchestrator) {
    super()
    this.#orchestrator = orchestrator
  }

  get name() { return 'meshctl_pods' }
  get description() { return 'List all known pods (local + remote) with their status and services' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Status filter: online, offline, all (default: all)' },
      },
    }
  }
  get permission() { return 'read' }

  async execute({ filter } = {}) {
    try {
      const pods = await this.#orchestrator.listPods(filter)
      if (pods.length === 0) {
        return { success: true, output: 'No pods found.' }
      }
      const lines = pods.map(p => {
        const local = p.isLocal ? ' (local)' : ''
        const svcs = p.services.length > 0 ? ` [${p.services.join(', ')}]` : ''
        return `${p.podId} | ${p.status}${local} | conns: ${p.connections}${svcs}`
      })
      return {
        success: true,
        output: `POD | STATUS | CONNECTIONS | SERVICES\n${lines.join('\n')}`,
      }
    } catch (err) {
      return { success: false, output: '', error: `Failed to list pods: ${err.message}` }
    }
  }
}

// ── meshctl_status ────────────────────────────────────────────────────

export class MeshctlStatusTool extends BrowserTool {
  #orchestrator

  constructor(orchestrator) {
    super()
    this.#orchestrator = orchestrator
  }

  get name() { return 'meshctl_status' }
  get description() { return 'Get detailed status of a specific pod including resources, capabilities, and uptime' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        podId: { type: 'string', description: 'Pod ID to query' },
      },
      required: ['podId'],
    }
  }
  get permission() { return 'read' }

  async execute({ podId }) {
    try {
      const status = await this.#orchestrator.getPodStatus(podId)
      if (!status) {
        return { success: false, output: '', error: `Pod "${podId}" not found.` }
      }
      const lines = [
        `Pod: ${status.podId}${status.isLocal ? ' (local)' : ''}`,
        `Status: ${status.status}`,
        `Uptime: ${status.uptime}ms`,
        `Connections: ${status.connections}`,
        `Capabilities: ${status.capabilities.join(', ') || 'none'}`,
        `Services: ${status.services.join(', ') || 'none'}`,
        `Resources: cpu=${status.resources.cpu}, memory=${status.resources.memory}MB, storage=${status.resources.storage}MB`,
      ]
      return { success: true, output: lines.join('\n') }
    } catch (err) {
      return { success: false, output: '', error: `Failed to get status: ${err.message}` }
    }
  }
}

// ── meshctl_exec ──────────────────────────────────────────────────────

export class MeshctlExecTool extends BrowserTool {
  #orchestrator

  constructor(orchestrator) {
    super()
    this.#orchestrator = orchestrator
  }

  get name() { return 'meshctl_exec' }
  get description() { return 'Execute a command on a remote pod via peer session' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        podId: { type: 'string', description: 'Target pod ID' },
        command: { type: 'string', description: 'Command to execute' },
      },
      required: ['podId', 'command'],
    }
  }
  get permission() { return 'network' }

  async execute({ podId, command }) {
    try {
      const result = await this.#orchestrator.execOnPod(podId, command)
      return {
        success: result.exitCode === 0,
        output: result.output,
        error: result.exitCode !== 0 ? `Exit code: ${result.exitCode}` : undefined,
      }
    } catch (err) {
      return { success: false, output: '', error: `Exec failed: ${err.message}` }
    }
  }
}

// ── meshctl_deploy ────────────────────────────────────────────────────

export class MeshctlDeployTool extends BrowserTool {
  #orchestrator

  constructor(orchestrator) {
    super()
    this.#orchestrator = orchestrator
  }

  get name() { return 'meshctl_deploy' }
  get description() { return 'Deploy a skill (SKILL.md content) to a remote pod' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        podId: { type: 'string', description: 'Target pod ID' },
        skillContent: { type: 'string', description: 'SKILL.md content to deploy' },
      },
      required: ['podId', 'skillContent'],
    }
  }
  get permission() { return 'write' }

  async execute({ podId, skillContent }) {
    try {
      const result = await this.#orchestrator.deploySkill(podId, skillContent)
      if (result.success) {
        return { success: true, output: `Skill deployed to ${podId} (${skillContent.length} bytes)` }
      }
      return { success: false, output: '', error: result.error || 'Deploy failed' }
    } catch (err) {
      return { success: false, output: '', error: `Deploy failed: ${err.message}` }
    }
  }
}

// ── meshctl_top ───────────────────────────────────────────────────────

export class MeshctlTopTool extends BrowserTool {
  #orchestrator

  constructor(orchestrator) {
    super()
    this.#orchestrator = orchestrator
  }

  get name() { return 'meshctl_top' }
  get description() { return 'Show resource usage across all pods (CPU, memory, storage, active tasks)' }
  get parameters() {
    return {
      type: 'object',
      properties: {},
    }
  }
  get permission() { return 'read' }

  async execute() {
    try {
      const { pods } = await this.#orchestrator.topPods()
      if (pods.length === 0) {
        return { success: true, output: 'No pods found.' }
      }
      const lines = pods.map(p =>
        `${p.podId} | ${p.status} | cpu: ${p.cpu} | mem: ${p.memory}MB | storage: ${p.storage}MB | tasks: ${p.activeTasks}`
      )
      return {
        success: true,
        output: `POD | STATUS | CPU | MEMORY | STORAGE | TASKS\n${lines.join('\n')}`,
      }
    } catch (err) {
      return { success: false, output: '', error: `Top failed: ${err.message}` }
    }
  }
}

// ── meshctl_compute ──────────────────────────────────────────────────

export class MeshctlComputeTool extends BrowserTool {
  #orchestrator

  constructor(orchestrator) {
    super()
    this.#orchestrator = orchestrator
  }

  get name() { return 'meshctl_compute' }
  get description() { return 'Select a compute-capable runtime and execute a task through the shared remote runtime broker' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        podId: { type: 'string', description: 'Optional target pod ID (omit to auto-select)' },
        command: { type: 'string', description: 'Command to execute' },
        prefer: { type: 'string', description: 'Resource preference: gpu, cpu, any' },
      },
      required: ['command'],
    }
  }
  get permission() { return 'network' }

  async execute({ podId, command, prefer } = {}) {
    try {
      const result = await this.#orchestrator.runComputeTask({
        selector: podId || null,
        command,
        constraints: prefer ? { prefer } : {},
      })
      return {
        success: result.exitCode === 0,
        output: `[${result.podId}] ${result.output}`.trim(),
        error: result.exitCode !== 0 ? `Exit code: ${result.exitCode}` : undefined,
      }
    } catch (err) {
      return { success: false, output: '', error: `Compute failed: ${err.message}` }
    }
  }
}

// ── meshctl_expose ────────────────────────────────────────────────────

export class MeshctlExposeTool extends BrowserTool {
  #orchestrator

  constructor(orchestrator) {
    super()
    this.#orchestrator = orchestrator
  }

  get name() { return 'meshctl_expose' }
  get description() { return 'Expose a pod service on the mesh network with a named endpoint' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        podId: { type: 'string', description: 'Pod ID to expose (default: local pod)' },
        port: { type: 'number', description: 'Port number to expose' },
        name: { type: 'string', description: 'Service name for discovery' },
      },
      required: ['port', 'name'],
    }
  }
  get permission() { return 'network' }

  async execute({ podId, port, name }) {
    try {
      const effectivePodId = podId || this.#orchestrator.peerNode.podId || this.#orchestrator.peerNode.id || 'local'
      const result = await this.#orchestrator.exposePod(effectivePodId, port, name)
      if (result.success) {
        return { success: true, output: `Service "${name}" exposed at ${result.address}` }
      }
      return { success: false, output: '', error: 'Expose failed' }
    } catch (err) {
      return { success: false, output: '', error: `Expose failed: ${err.message}` }
    }
  }
}

// ── meshctl_drain ─────────────────────────────────────────────────────

export class MeshctlDrainTool extends BrowserTool {
  #orchestrator

  constructor(orchestrator) {
    super()
    this.#orchestrator = orchestrator
  }

  get name() { return 'meshctl_drain' }
  get description() { return 'Gracefully drain a pod: stop accepting work, migrate tasks, and disconnect' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        podId: { type: 'string', description: 'Pod ID to drain' },
      },
      required: ['podId'],
    }
  }
  get permission() { return 'network' }

  async execute({ podId }) {
    try {
      const result = await this.#orchestrator.drainPod(podId)
      if (result.success) {
        return { success: true, output: `Pod ${podId} drained. Migrated ${result.migrated} tasks.` }
      }
      return { success: false, output: '', error: `Pod "${podId}" not found or already drained.` }
    } catch (err) {
      return { success: false, output: '', error: `Drain failed: ${err.message}` }
    }
  }
}

// ---------------------------------------------------------------------------
// Hosted pods control surface (issue #185 §8a item 4) -- meshctl_spawn,
// meshctl_snapshot, meshctl_restore, meshctl_hosted_pods, meshctl_hosts
// ---------------------------------------------------------------------------

/**
 * Lane-aware hints for `POD_HOST_ERROR.ELANE` failures, keyed by verb. Only
 * `exec`/`snapshot`/`restore` are ever `ELANE` (`POD_LANE_VERBS` in
 * `host-protocol.mjs`), and only for the `isolate`/`browser` lanes -- a V8
 * isolate has no shell and no process to freeze to disk; Durable Object
 * hibernation is automatic, not a verb a caller drives.
 */
const ELANE_HINTS = Object.freeze({
  exec: 'isolate pods cannot exec; use meshctl_deploy or spawn on a microvm host',
  snapshot: 'isolate pods cannot snapshot; Durable Object hibernation is automatic, not a verb you drive',
  restore: 'isolate pods cannot restore; Durable Object hibernation is automatic, not a verb you drive',
})

/**
 * Turn a `PodHostDriverError` (or anything `PodHostDriverError.from()`
 * accepts) into a human-readable, lane-aware message for a `meshctl_*`
 * tool's `error` field or the `meshctl` shell's `stderr`. Never retries or
 * picks a different host -- "the orchestrator proposes, the host accepts":
 * an `EACCES` (or any other code) is reported as-is, exactly once.
 *
 * @param {*} err
 * @param {{host?: string, verb?: string}} [ctx]
 * @returns {string}
 */
function formatPodHostError(err, { host, verb } = {}) {
  const driverError = PodHostDriverError.from(err)
  const lane = driverError.details?.lane ?? null
  const name = driverError.details?.name ?? null
  const where = host ? ` on host '${host}'` : ''
  switch (driverError.code) {
    case POD_HOST_ERROR.EACCES:
      return `not authorized to '${verb}'${where} (grant pod-host:${verb} to this requester)`
    case POD_HOST_ERROR.ENOENT:
      return `no pod${name ? ` named '${name}'` : ''} found${where}`
    case POD_HOST_ERROR.EEXIST:
      return `pod${name ? ` '${name}'` : ''} already exists${where}`
    case POD_HOST_ERROR.EINVAL:
      return `invalid request: ${driverError.message}`
    case POD_HOST_ERROR.ENOTSUP:
      return `host${where} does not implement '${verb}' (its lane could, but this driver has not)`
    case POD_HOST_ERROR.ELANE:
      return ELANE_HINTS[verb] || `lane '${lane ?? 'unknown'}' structurally cannot '${verb}'`
    case POD_HOST_ERROR.ETIMEDOUT:
      return `host${where} did not respond in time`
    case POD_HOST_ERROR.EBUSY:
      return `pod${where} is mid-transition; try again`
    default:
      return driverError.message
  }
}

/**
 * Pick the best pod host for a given lane -- `meshctl_spawn`'s `host: 'auto'`
 * path, and the `meshctl spawn <host|auto> ...` shell command's equivalent.
 * "The orchestrator proposes, the host accepts": this picks exactly one
 * host and never retries a different one after a refusal (see
 * `formatPodHostError()` and `MeshctlSpawnTool#execute()`).
 *
 * Primary path: `orchestrator.listComputeCandidates()` (the same
 * `ResourceScorer`-adjacent descriptor list `MeshctlComputeTool` reads),
 * narrowed to hosts advertising `runtime:<lane>`, preferring one with
 * `availability: 'online'`.
 *
 * Fallback: `orchestrator.listPodHosts()`. This exists because of a
 * documented gap (`pod-host-service.mjs`'s `podHostRuntimePeer()` doc
 * comment, and this package's README "Known limitation" section):
 * `listComputeCandidates()` derives its `compute` capability from `exec`,
 * so an ISOLATE-lane host (no `exec`, by lane definition -- same for
 * `browser`) never appears in it at all, regardless of lane filtering.
 * `listPodHosts()` reads the same runtime-registry peers directly, without
 * that filter, so it still finds such a host.
 *
 * @param {object} orchestrator - A `MeshOrchestrator` (or the tool facade
 *   `mesh-orchestrator-tools.mjs` builds around one).
 * @param {string} lane - A `POD_LANE` value.
 * @returns {Promise<{podId: string, reason: string}|null>}
 */
async function pickAutoHost(orchestrator, lane) {
  const isolation = lane === POD_LANE.ISOLATE
    ? ISOLATION.ISOLATE
    : lane === POD_LANE.MICROVM
      ? ISOLATION.MICROVM
      : ISOLATION.ANY
  const candidates = typeof orchestrator.listComputeCandidates === 'function'
    ? await orchestrator.listComputeCandidates({ isolation })
    : []
  const laneCandidates = candidates.filter((c) => c.capabilities.includes(`runtime:${lane}`))
  const best = laneCandidates.find((c) => c.availability === 'online') || laneCandidates[0] || null
  if (best) {
    return {
      podId: best.podId,
      reason: `best compute candidate advertising lane '${lane}' (${best.availability}, via ${best.source})`,
    }
  }

  if (typeof orchestrator.listPodHosts !== 'function') return null
  const hosts = await orchestrator.listPodHosts()
  const laneHosts = hosts.filter((h) => h.lane === lane)
  if (laneHosts.length === 0) return null
  return {
    podId: laneHosts[0].podId,
    reason: `only known pod host advertising lane '${lane}' (no exec, so invisible to compute-candidate scoring)`,
  }
}

/**
 * Build a podspec from `MeshctlSpawnTool#execute()`'s separate arguments,
 * omitting any key the caller did not supply -- `validatePodSpec()` treats
 * an explicit `undefined` the same as a present-but-wrong-typed value
 * (`rejectUnknownKeys()` walks `Object.keys()`, which includes keys whose
 * value is `undefined`), so building the object conditionally matters, not
 * just cosmetically.
 *
 * @param {object} args
 * @returns {object}
 */
function buildPodSpec({ name, lane, run, limits, caps, env, budget, restart, labels }) {
  const spec = { name, run }
  if (lane !== undefined) spec.lane = lane
  if (limits !== undefined) spec.limits = limits
  if (caps !== undefined) spec.caps = caps
  if (env !== undefined) spec.env = env
  if (budget !== undefined) spec.budget = budget
  if (restart !== undefined) spec.restart = restart
  if (labels !== undefined) spec.labels = labels
  return spec
}

// ── meshctl_spawn ─────────────────────────────────────────────────────

export class MeshctlSpawnTool extends BrowserTool {
  #orchestrator

  constructor(orchestrator) {
    super()
    this.#orchestrator = orchestrator
  }

  get name() { return 'meshctl_spawn' }
  get description() {
    return "Spawn a hosted pod (issue #185 control surface) on a pod host, in a V8 isolate or microVM lane. " +
      "Pass host: 'auto' (or omit it) to let the orchestrator pick a host matching the lane."
  }
  get parameters() {
    return {
      type: 'object',
      properties: {
        host: { type: 'string', description: "Target pod host's pod ID, or 'auto' to let the orchestrator pick one matching the lane (default: auto)" },
        name: { type: 'string', description: "Pod name, matching [A-Za-z0-9][A-Za-z0-9._-]{0,63}" },
        lane: { type: 'string', description: "Isolation lane: 'isolate'|'microvm'|'node'|'browser' (default inferred from run.kind: skill/module -> isolate, command/rootfs -> microvm)" },
        run: {
          type: 'object',
          description: 'What to run',
          properties: {
            kind: { type: 'string', description: "'skill'|'module'|'rootfs'|'command'" },
            ref: { type: 'string', description: 'Reference: skill name, module cid, rootfs image, or command path' },
            entry: { type: 'string', description: 'Entry point, if applicable' },
            input: { description: 'Input payload, if applicable' },
          },
          required: ['kind', 'ref'],
        },
        limits: { type: 'object', description: 'Resource limits: vcpus, memMib, timeoutMs, netRateLimiter, blockRateLimiter' },
        caps: { type: 'array', items: { type: 'string' }, description: 'KERNEL_CAP strings this pod is granted' },
        env: { type: 'object', description: 'Environment variables (string values)' },
        budget: { type: 'object', description: 'Budget: credits, currency' },
        restart: { type: 'object', description: 'Restart policy: policy (never|on-failure|always), maxRestarts, backoffMs' },
      },
      required: ['name', 'run'],
    }
  }
  get permission() { return 'network' }

  async execute({ host, name, lane, run, limits, caps, env, budget, restart } = {}) {
    const validated = validatePodSpec(buildPodSpec({ name, lane, run, limits, caps, env, budget, restart }))
    if (!validated.ok) {
      return { success: false, output: '', error: `Invalid podspec: ${validated.errors.join('; ')}` }
    }
    const spec = validated.value

    let targetHost = host && host !== 'auto' ? host : null
    let note = ''
    if (!targetHost) {
      const picked = await pickAutoHost(this.#orchestrator, spec.lane)
      if (!picked) {
        return { success: false, output: '', error: `No known pod host advertises lane '${spec.lane}' for auto selection` }
      }
      targetHost = picked.podId
      note = `orchestrator proposes host ${targetHost} for lane '${spec.lane}': ${picked.reason}\n`
    }

    try {
      const result = await this.#orchestrator.spawnPod(targetHost, spec)
      return {
        success: true,
        output: `${note}spawned '${result.name}' on ${targetHost} (lane '${result.lane}'): state=${result.state}\n${JSON.stringify(result)}`,
      }
    } catch (err) {
      // "The orchestrator proposes, the host accepts": a refusal (EACCES or
      // otherwise) from the host we picked -- or the one the caller named
      // explicitly -- is reported as-is, never silently retried elsewhere.
      return { success: false, output: note, error: formatPodHostError(err, { host: targetHost, verb: 'spawn' }) }
    }
  }
}

// ── meshctl_snapshot ──────────────────────────────────────────────────

export class MeshctlSnapshotTool extends BrowserTool {
  #orchestrator

  constructor(orchestrator) {
    super()
    this.#orchestrator = orchestrator
  }

  get name() { return 'meshctl_snapshot' }
  get description() { return 'Freeze a hosted pod to durable storage (microvm/node lanes only; isolate/browser answer ELANE)' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Pod host pod ID' },
        name: { type: 'string', description: 'Hosted pod name' },
      },
      required: ['host', 'name'],
    }
  }
  get permission() { return 'network' }

  async execute({ host, name } = {}) {
    try {
      const result = await this.#orchestrator.snapshotPod(host, name)
      return { success: true, output: `snapshotted '${name}' on ${host}: state=${result.state}\n${JSON.stringify(result)}` }
    } catch (err) {
      return { success: false, output: '', error: formatPodHostError(err, { host, verb: 'snapshot' }) }
    }
  }
}

// ── meshctl_restore ───────────────────────────────────────────────────

export class MeshctlRestoreTool extends BrowserTool {
  #orchestrator

  constructor(orchestrator) {
    super()
    this.#orchestrator = orchestrator
  }

  get name() { return 'meshctl_restore' }
  get description() { return 'Thaw a snapshotted hosted pod (microvm/node lanes only; isolate/browser answer ELANE)' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Pod host pod ID' },
        name: { type: 'string', description: 'Hosted pod name' },
      },
      required: ['host', 'name'],
    }
  }
  get permission() { return 'network' }

  async execute({ host, name } = {}) {
    try {
      const result = await this.#orchestrator.restorePod(host, name)
      return { success: true, output: `restored '${name}' on ${host}: state=${result.state}\n${JSON.stringify(result)}` }
    } catch (err) {
      return { success: false, output: '', error: formatPodHostError(err, { host, verb: 'restore' }) }
    }
  }
}

// ── meshctl_hosted_pods ───────────────────────────────────────────────

export class MeshctlHostedPodsTool extends BrowserTool {
  #orchestrator

  constructor(orchestrator) {
    super()
    this.#orchestrator = orchestrator
  }

  get name() { return 'meshctl_hosted_pods' }
  get description() { return 'List every pod a pod host is tracking (spawned, snapshotted, or drained tombstones)' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        host: { type: 'string', description: 'Pod host pod ID' },
      },
      required: ['host'],
    }
  }
  get permission() { return 'read' }

  async execute({ host } = {}) {
    try {
      const pods = await this.#orchestrator.listHostedPods(host)
      if (pods.length === 0) {
        return { success: true, output: `No hosted pods on ${host}.\n[]` }
      }
      const lines = pods.map((p) => `${p.name} | ${p.lane} | ${p.state} | execs:${p.execs ?? 0}`)
      return {
        success: true,
        output: `NAME | LANE | STATE | EXECS\n${lines.join('\n')}\n\n${JSON.stringify(pods)}`,
      }
    } catch (err) {
      return { success: false, output: '', error: formatPodHostError(err, { host, verb: 'list' }) }
    }
  }
}

// ── meshctl_hosts ─────────────────────────────────────────────────────

export class MeshctlHostsTool extends BrowserTool {
  #orchestrator

  constructor(orchestrator) {
    super()
    this.#orchestrator = orchestrator
  }

  get name() { return 'meshctl_hosts' }
  get description() { return 'List known pod hosts with their lane, served verbs and runtime classes' }
  get parameters() {
    return { type: 'object', properties: {} }
  }
  get permission() { return 'read' }

  async execute() {
    try {
      const hosts = await this.#orchestrator.listPodHosts()
      if (hosts.length === 0) {
        return { success: true, output: 'No pod hosts known.' }
      }
      const lines = hosts.map((h) => `${h.podId} | ${h.lane} | verbs: ${h.verbs.join(',')} | runtimeClasses: ${h.runtimeClasses.join(',')}`)
      return {
        success: true,
        output: `HOST | LANE | VERBS | RUNTIME CLASSES\n${lines.join('\n')}`,
      }
    } catch (err) {
      return { success: false, output: '', error: `Failed to list pod hosts: ${err.message}` }
    }
  }
}

// ---------------------------------------------------------------------------
// Shell integration helper
// ---------------------------------------------------------------------------

/**
 * A tiny `--flag value` parser for `meshctl spawn`'s flag-style arguments
 * (`--lane`, `--kind`, `--ref`, `--entry`). Deliberately minimal rather than
 * a dependency: every recognized flag takes exactly one value, order does
 * not matter, and an unrecognized `--flag` is collected too (the caller
 * only reads the ones it needs).
 *
 * @param {string[]} args
 * @returns {Record<string, string>}
 */
function parseMeshctlFlags(args) {
  /** @type {Record<string, string>} */
  const flags = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      flags[arg.slice(2)] = args[i + 1]
      i += 1
    }
  }
  return flags
}

/**
 * Register 'meshctl' as a compound command in the shell registry.
 * Subcommands: pods, status, exec, deploy, top, compute, expose, drain,
 * spawn, snapshot, restore, hosted, hosts
 *
 * @param {import('./clawser-shell.js').CommandRegistry} shellRegistry
 * @param {MeshOrchestrator} orchestrator
 */
export function registerMeshctlBuiltins(shellRegistry, orchestrator) {
  shellRegistry.register('meshctl', async ({ args }) => {
    const subcommand = args[0]
    const rest = args.slice(1)

    switch (subcommand) {
      case 'pods': {
        const filter = rest[0] || 'all'
        const pods = await orchestrator.listPods(filter)
        if (pods.length === 0) return { stdout: 'No pods found.\n', stderr: '', exitCode: 0 }
        const lines = pods.map(p => {
          const local = p.isLocal ? ' (local)' : ''
          return `${p.podId}\t${p.status}${local}\tconns:${p.connections}`
        })
        return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
      }

      case 'status': {
        const podId = rest[0]
        if (!podId) return { stdout: '', stderr: 'Usage: meshctl status <podId>\n', exitCode: 1 }
        const status = await orchestrator.getPodStatus(podId)
        if (!status) return { stdout: '', stderr: `Pod "${podId}" not found.\n`, exitCode: 1 }
        return {
          stdout: JSON.stringify(status.toJSON(), null, 2) + '\n',
          stderr: '',
          exitCode: 0,
        }
      }

      case 'exec': {
        const podId = rest[0]
        const command = rest.slice(1).join(' ')
        if (!podId || !command) return { stdout: '', stderr: 'Usage: meshctl exec <podId> <command>\n', exitCode: 1 }
        try {
          const result = await orchestrator.execOnPod(podId, command)
          return { stdout: result.output + '\n', stderr: '', exitCode: result.exitCode }
        } catch (err) {
          return { stdout: '', stderr: err.message + '\n', exitCode: 1 }
        }
      }

      case 'deploy': {
        const podId = rest[0]
        const skillContent = rest.slice(1).join(' ')
        if (!podId || !skillContent) return { stdout: '', stderr: 'Usage: meshctl deploy <podId> <skillContent>\n', exitCode: 1 }
        const result = await orchestrator.deploySkill(podId, skillContent)
        if (result.success) return { stdout: `Deployed to ${podId}\n`, stderr: '', exitCode: 0 }
        return { stdout: '', stderr: result.error + '\n', exitCode: 1 }
      }

      case 'top': {
        const { pods } = await orchestrator.topPods()
        if (pods.length === 0) return { stdout: 'No pods.\n', stderr: '', exitCode: 0 }
        const lines = pods.map(p =>
          `${p.podId}\tcpu:${p.cpu}\tmem:${p.memory}\tstorage:${p.storage}\ttasks:${p.activeTasks}`
        )
        return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
      }

      case 'compute': {
        const [targetOrAuto, ...commandParts] = rest
        const selector = targetOrAuto && targetOrAuto !== 'auto' ? targetOrAuto : null
        const command = targetOrAuto ? commandParts.join(' ') : ''
        if (!command) return { stdout: '', stderr: 'Usage: meshctl compute <podId|auto> <command>\n', exitCode: 1 }
        try {
          const result = await orchestrator.runComputeTask({ selector, command })
          return { stdout: `[${result.podId}] ${result.output}`.trimEnd() + '\n', stderr: '', exitCode: result.exitCode }
        } catch (err) {
          return { stdout: '', stderr: err.message + '\n', exitCode: 1 }
        }
      }

      case 'expose': {
        // meshctl expose <podId> <port> <name>
        const [ePodId, ePort, eName] = rest
        const parsedPort = parseInt(ePort, 10)
        if (!ePodId || !ePort || !eName || !Number.isFinite(parsedPort)) {
          return { stdout: '', stderr: 'Usage: meshctl expose <podId> <port> <name>\n', exitCode: 1 }
        }
        const result = await orchestrator.exposePod(ePodId, parsedPort, eName)
        if (result.success) return { stdout: `Exposed "${eName}" at ${result.address}\n`, stderr: '', exitCode: 0 }
        return { stdout: '', stderr: 'Expose failed.\n', exitCode: 1 }
      }

      case 'drain': {
        const podId = rest[0]
        if (!podId) return { stdout: '', stderr: 'Usage: meshctl drain <podId>\n', exitCode: 1 }
        const result = await orchestrator.drainPod(podId)
        if (result.success) return { stdout: `Drained ${podId}. Migrated ${result.migrated} tasks.\n`, stderr: '', exitCode: 0 }
        return { stdout: '', stderr: `Pod "${podId}" not found.\n`, exitCode: 1 }
      }

      case 'spawn': {
        const USAGE = 'Usage: meshctl spawn <host|auto> <name> --lane <lane> --kind <kind> --ref <ref> [--entry <entry>]\n'
        const [hostArg, nameArg, ...flagArgs] = rest
        if (!hostArg || !nameArg) return { stdout: '', stderr: USAGE, exitCode: 1 }
        const flags = parseMeshctlFlags(flagArgs)
        if (!flags.kind || !flags.ref) return { stdout: '', stderr: USAGE, exitCode: 1 }
        const run = { kind: flags.kind, ref: flags.ref }
        if (flags.entry) run.entry = flags.entry
        const spec = buildPodSpec({ name: nameArg, lane: flags.lane, run })
        const validated = validatePodSpec(spec)
        if (!validated.ok) return { stdout: '', stderr: `Invalid podspec: ${validated.errors.join('; ')}\n`, exitCode: 1 }
        try {
          let host = hostArg
          let note = ''
          if (hostArg === 'auto') {
            const picked = await pickAutoHost(orchestrator, validated.value.lane)
            if (!picked) return { stdout: '', stderr: `No known pod host advertises lane '${validated.value.lane}'\n`, exitCode: 1 }
            host = picked.podId
            note = `orchestrator proposes host ${host} for lane '${validated.value.lane}': ${picked.reason}\n`
          }
          const result = await orchestrator.spawnPod(host, validated.value)
          return { stdout: `${note}spawned '${result.name}' on ${host} (lane '${result.lane}'): state=${result.state}\n`, stderr: '', exitCode: 0 }
        } catch (err) {
          return { stdout: '', stderr: formatPodHostError(err, { host: hostArg === 'auto' ? null : hostArg, verb: 'spawn' }) + '\n', exitCode: 1 }
        }
      }

      case 'snapshot': {
        const [host, name] = rest
        if (!host || !name) return { stdout: '', stderr: 'Usage: meshctl snapshot <host> <name>\n', exitCode: 1 }
        try {
          const result = await orchestrator.snapshotPod(host, name)
          return { stdout: `snapshotted '${name}' on ${host}: state=${result.state}\n`, stderr: '', exitCode: 0 }
        } catch (err) {
          return { stdout: '', stderr: formatPodHostError(err, { host, verb: 'snapshot' }) + '\n', exitCode: 1 }
        }
      }

      case 'restore': {
        const [host, name] = rest
        if (!host || !name) return { stdout: '', stderr: 'Usage: meshctl restore <host> <name>\n', exitCode: 1 }
        try {
          const result = await orchestrator.restorePod(host, name)
          return { stdout: `restored '${name}' on ${host}: state=${result.state}\n`, stderr: '', exitCode: 0 }
        } catch (err) {
          return { stdout: '', stderr: formatPodHostError(err, { host, verb: 'restore' }) + '\n', exitCode: 1 }
        }
      }

      case 'hosted': {
        const host = rest[0]
        if (!host) return { stdout: '', stderr: 'Usage: meshctl hosted <host>\n', exitCode: 1 }
        try {
          const pods = await orchestrator.listHostedPods(host)
          if (pods.length === 0) return { stdout: `No hosted pods on ${host}.\n`, stderr: '', exitCode: 0 }
          const lines = pods.map((p) => `${p.name}\t${p.lane}\t${p.state}`)
          return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
        } catch (err) {
          return { stdout: '', stderr: formatPodHostError(err, { host, verb: 'list' }) + '\n', exitCode: 1 }
        }
      }

      case 'hosts': {
        const hosts = await orchestrator.listPodHosts()
        if (hosts.length === 0) return { stdout: 'No pod hosts known.\n', stderr: '', exitCode: 0 }
        const lines = hosts.map((h) => `${h.podId}\t${h.lane}\tverbs:${h.verbs.join(',')}`)
        return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 }
      }

      default:
        return {
          stdout: '',
          stderr: `Unknown subcommand: ${subcommand || '(none)'}. Available: pods, status, exec, deploy, top, compute, expose, drain, spawn, snapshot, restore, hosted, hosts\n`,
          exitCode: 1,
        }
    }
  }, {
    description: 'Pod orchestration commands for the mesh network',
    category: 'mesh',
    usage: 'meshctl <subcommand> [args...]',
  })
}

// ---------------------------------------------------------------------------
// Tool registration helper
// ---------------------------------------------------------------------------

/**
 * Create all meshctl BrowserTool instances for a given orchestrator -- the
 * original 8 (`pods`/`status`/`exec`/`deploy`/`top`/`compute`/`expose`/
 * `drain`) plus the 5 hosted-pods control surface tools (issue #185 §8a
 * item 4): `spawn`/`snapshot`/`restore`/`hosted_pods`/`hosts`. 13 total.
 * @param {MeshOrchestrator} orchestrator
 * @returns {BrowserTool[]}
 */
export function createMeshctlTools(orchestrator) {
  return [
    new MeshctlPodsTool(orchestrator),
    new MeshctlStatusTool(orchestrator),
    new MeshctlExecTool(orchestrator),
    new MeshctlDeployTool(orchestrator),
    new MeshctlTopTool(orchestrator),
    new MeshctlComputeTool(orchestrator),
    new MeshctlExposeTool(orchestrator),
    new MeshctlDrainTool(orchestrator),
    new MeshctlSpawnTool(orchestrator),
    new MeshctlSnapshotTool(orchestrator),
    new MeshctlRestoreTool(orchestrator),
    new MeshctlHostedPodsTool(orchestrator),
    new MeshctlHostsTool(orchestrator),
  ]
}
