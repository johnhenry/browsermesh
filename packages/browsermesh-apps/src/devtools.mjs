/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-mesh-devtools.js -- Mesh DevTools Inspector.
 *
 * Provides diagnostic snapshot and health checking for the mesh subsystem.
 * Exposed as a BrowserTool so the AI agent can query mesh state.
 *
 * No browser-only imports at module level.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-mesh-devtools.test.mjs
 */

const BrowserTool = globalThis.BrowserTool || class { constructor() {} }

/**
 * Diagnostic inspector for mesh subsystem state.
 */
export class MeshInspector {
  #state

  /**
   * @param {object} state - The global state object containing mesh subsystem references
   */
  constructor(state) {
    if (!state) throw new Error('state is required')
    this.#state = state
  }

  /**
   * Take a complete snapshot of mesh subsystem state.
   * @returns {object}
   */
  snapshot() {
    const s = this.#state
    return {
      pod: {
        podId: s.pod?.podId || null,
        state: s.pod?.state || 'unknown',
      },
      peerNode: {
        podId: s.peerNode?.podId || null,
        state: s.peerNode?.state || 'unknown',
        peerCount: s.peerNode?.peerCount ?? 0,
      },
      swarm: {
        active: !!s.swarmCoordinator,
        swarmCount: s.swarmCoordinator?.listSwarms?.()?.length ?? 0,
      },
      discovery: {
        active: !!s.discoveryManager,
      },
      transport: {
        active: !!s.transportNegotiator,
      },
      audit: {
        active: !!s.auditChain,
        entryCount: s.auditChain?.length ?? s.auditChain?.size ?? 0,
      },
      streams: {
        active: !!s.streamMultiplexer,
      },
      files: {
        active: !!s.fileTransfer,
      },
      services: {
        active: !!s.serviceDirectory,
      },
      sync: {
        active: !!s.syncEngine,
      },
      resources: {
        active: !!s.resourceRegistry,
        count: s.resourceRegistry?.listAll?.()?.length ?? 0,
      },
      marketplace: {
        active: !!s.meshMarketplace,
        stats: s.meshMarketplace?.getStats?.() || null,
      },
      quotas: {
        managerActive: !!s.quotaManager,
        enforcerActive: !!s.quotaEnforcer,
      },
      payments: {
        active: !!s.paymentRouter,
      },
      consensus: {
        active: !!s.consensusManager,
        proposalCount: s.consensusManager?.size ?? 0,
      },
      relay: {
        active: !!s.relayClient,
      },
      naming: {
        active: !!s.nameResolver,
      },
      apps: {
        registryActive: !!s.appRegistry,
        storeActive: !!s.appStore,
        stats: s.appRegistry?.getStats?.() || null,
      },
      orchestrator: {
        active: !!s.orchestrator,
        peerCount: s.orchestrator?.peerCount ?? 0,
      },
      connectivity: {
        active: !!s.webrtcMeshManager,
        connectionCount: s.webrtcMeshManager?.connectionCount ?? 0,
        // Synchronous read of the last getAllConnectionStats() call — the
        // Tracer/health-metrics poller refreshes this, snapshot() can't
        // await a live RTCPeerConnection.getStats() call.
        stats: s.webrtcMeshManager?.lastStats ?? [],
      },
    }
  }

  /**
   * Run health checks on all subsystems.
   * @returns {{ overall: 'healthy'|'degraded'|'unhealthy', checks: Array<{ name: string, status: string, detail?: string }> }}
   */
  healthCheck() {
    const checks = []
    const s = this.#state

    // Pod check
    checks.push({
      name: 'pod',
      status: s.pod ? 'ok' : 'missing',
      detail: s.pod ? `podId: ${s.pod.podId || 'unknown'}` : 'Pod not initialized',
    })

    // PeerNode check
    checks.push({
      name: 'peerNode',
      status: s.peerNode ? 'ok' : 'missing',
    })

    // Core subsystems
    const coreNames = [
      ['swarmCoordinator', 'swarm'],
      ['discoveryManager', 'discovery'],
      ['transportNegotiator', 'transport'],
      ['auditChain', 'audit'],
      ['streamMultiplexer', 'streams'],
      ['fileTransfer', 'files'],
      ['serviceDirectory', 'services'],
      ['syncEngine', 'sync'],
    ]
    for (const [key, name] of coreNames) {
      checks.push({ name, status: s[key] ? 'ok' : 'missing' })
    }

    // Extended subsystems
    const extNames = [
      ['resourceRegistry', 'resources'],
      ['meshMarketplace', 'marketplace'],
      ['quotaManager', 'quotas'],
      ['paymentRouter', 'payments'],
      ['consensusManager', 'consensus'],
      ['relayClient', 'relay'],
      ['nameResolver', 'naming'],
      ['appRegistry', 'apps'],
      ['orchestrator', 'orchestrator'],
    ]
    for (const [key, name] of extNames) {
      checks.push({ name, status: s[key] ? 'ok' : 'missing' })
    }

    // Determine overall health
    const missingCount = checks.filter(c => c.status === 'missing').length
    let overall = 'healthy'
    if (missingCount > 0 && missingCount <= 5) overall = 'degraded'
    if (missingCount > 5) overall = 'unhealthy'
    // If pod or peerNode missing, always unhealthy
    if (!s.pod || !s.peerNode) overall = 'unhealthy'

    return { overall, checks }
  }

  /**
   * Generate a markdown report of mesh state.
   * @returns {string}
   */
  toMarkdownReport() {
    const snap = this.snapshot()
    const health = this.healthCheck()

    let md = `# Mesh Inspector Report\n\n`
    md += `**Overall Health:** ${health.overall}\n\n`
    md += `## Pod\n- ID: ${snap.pod.podId || 'N/A'}\n- State: ${snap.pod.state}\n\n`
    md += `## Peer Node\n- ID: ${snap.peerNode.podId || 'N/A'}\n- Peers: ${snap.peerNode.peerCount}\n\n`
    md += `## Health Checks\n`
    for (const check of health.checks) {
      const icon = check.status === 'ok' ? 'OK' : 'MISSING'
      md += `- ${check.name}: ${icon}${check.detail ? ` (${check.detail})` : ''}\n`
    }
    return md
  }
}

/**
 * BrowserTool exposing mesh inspection to the AI agent.
 */
export class MeshInspectTool extends BrowserTool {
  #inspector

  constructor(state) {
    super()
    this.#inspector = new MeshInspector(state)
  }

  get name() { return 'mesh_inspect' }
  get description() { return 'Inspect mesh subsystem state, health, and diagnostics' }
  get parameters() {
    return {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          description: 'Optional: specific section to inspect (pod, peers, health, full). Default: full',
        },
      },
    }
  }
  get permission() { return 'read' }

  async execute({ section } = {}) {
    try {
      switch (section) {
        case 'health': {
          const health = this.#inspector.healthCheck()
          return { success: true, output: JSON.stringify(health, null, 2) }
        }
        case 'pod': {
          const snap = this.#inspector.snapshot()
          return { success: true, output: JSON.stringify(snap.pod, null, 2) }
        }
        case 'peers': {
          const snap = this.#inspector.snapshot()
          return { success: true, output: JSON.stringify(snap.peerNode, null, 2) }
        }
        case 'report':
        case 'markdown': {
          return { success: true, output: this.#inspector.toMarkdownReport() }
        }
        default: {
          const snap = this.#inspector.snapshot()
          return { success: true, output: JSON.stringify(snap, null, 2) }
        }
      }
    } catch (err) {
      return { success: false, output: '', error: `Inspection failed: ${err.message}` }
    }
  }
}
