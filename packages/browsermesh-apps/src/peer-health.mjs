/**
// STATUS: INTEGRATED — wired into ClawserPod lifecycle, proven via E2E testing
 * clawser-peer-health.js — Automatic health monitoring with self-healing.
 *
 * Watches heartbeats, detects failures, triggers workload migration.
 * Enables "self-healing personal mesh infrastructure" scenario.
 *
 * Run tests:
 *   node --import ./web/test/_setup-globals.mjs --test web/test/clawser-peer-health.test.mjs
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default health monitoring thresholds. */
export const HEALTH_DEFAULTS = Object.freeze({
  heartbeatIntervalMs: 10000,
  heartbeatTimeoutMs: 5000,
  maxMissedHeartbeats: 3,
  degradedThresholdMs: 2000,
})

/** Possible peer health statuses. */
export const HEALTH_STATUSES = Object.freeze(['healthy', 'degraded', 'failed', 'unknown'])

// ---------------------------------------------------------------------------
// PeerHealth — snapshot of a single peer's health state
// ---------------------------------------------------------------------------

/**
 * Immutable snapshot of health data for a single peer.
 */
export class PeerHealth {
  /** @type {string} */
  podId

  /** @type {'healthy'|'degraded'|'failed'|'unknown'} */
  status

  /** @type {number} */
  lastHeartbeat

  /** @type {number} */
  missedHeartbeats

  /** @type {number} */
  latencyMs

  /** @type {number} */
  uptimeMs

  /**
   * @param {object} opts
   * @param {string} opts.podId - Peer pod identifier
   * @param {'healthy'|'degraded'|'failed'|'unknown'} [opts.status='unknown']
   * @param {number} [opts.lastHeartbeat=0]
   * @param {number} [opts.missedHeartbeats=0]
   * @param {number} [opts.latencyMs=0]
   * @param {number} [opts.uptimeMs=0]
   */
  constructor({
    podId,
    status = 'unknown',
    lastHeartbeat = 0,
    missedHeartbeats = 0,
    latencyMs = 0,
    uptimeMs = 0,
  }) {
    this.podId = podId
    this.status = status
    this.lastHeartbeat = lastHeartbeat
    this.missedHeartbeats = missedHeartbeats
    this.latencyMs = latencyMs
    this.uptimeMs = uptimeMs
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      podId: this.podId,
      status: this.status,
      lastHeartbeat: this.lastHeartbeat,
      missedHeartbeats: this.missedHeartbeats,
      latencyMs: this.latencyMs,
      uptimeMs: this.uptimeMs,
    }
  }
}

// ---------------------------------------------------------------------------
// MigrationResult — outcome of a workload migration
// ---------------------------------------------------------------------------

/**
 * Result of a workload migration operation.
 */
export class MigrationResult {
  /** @type {boolean} */
  success

  /** @type {string} */
  fromPod

  /** @type {string} */
  toPod

  /**
   * What was actually redeployed to `toPod`, or null when nothing was.
   * Never a summary word like 'all' -- see `deployed` for the itemised list.
   * @type {string|null}
   */
  workload

  /** @type {string[]} names of the skills deployed to toPod (may be empty) */
  deployed

  /** @type {number} */
  durationMs

  /** @type {string|null} */
  error

  /**
   * @param {object} opts
   * @param {boolean} opts.success
   * @param {string} opts.fromPod
   * @param {string} opts.toPod
   * @param {string} [opts.workload=null]
   * @param {string[]} [opts.deployed=[]]
   * @param {number} [opts.durationMs=0]
   * @param {string} [opts.error=null]
   */
  constructor({
    success,
    fromPod,
    toPod,
    workload = null,
    deployed = [],
    durationMs = 0,
    error = null,
  }) {
    this.success = success
    this.fromPod = fromPod
    this.toPod = toPod
    this.workload = workload
    this.deployed = deployed
    this.durationMs = durationMs
    this.error = error
  }

  /**
   * Serialize to a JSON-safe object.
   * @returns {object}
   */
  toJSON() {
    return {
      success: this.success,
      fromPod: this.fromPod,
      toPod: this.toPod,
      workload: this.workload,
      deployed: [...this.deployed],
      durationMs: this.durationMs,
      error: this.error,
    }
  }
}

// ---------------------------------------------------------------------------
// HealthMonitor — periodic heartbeat checks with status tracking
// ---------------------------------------------------------------------------

/**
 * Monitors peer health via periodic heartbeat pings.
 *
 * Each tick:
 * 1. Increments missedHeartbeats for all tracked peers
 * 2. Sends a heartbeat ping to each active session
 * 3. Updates status based on missed count and latency
 *
 * When `recordHeartbeat(podId, latencyMs)` is called (externally, when a
 * heartbeat response arrives), it resets the missed count and updates latency.
 *
 * Status transitions:
 * - unknown  -> healthy   (on first heartbeat)
 * - healthy  -> degraded  (high latency OR 1 miss)
 * - degraded -> failed    (>= maxMissedHeartbeats)
 * - failed   -> healthy   (on heartbeat after failure, emits 'recovered')
 */
export class HealthMonitor {
  /** @type {object} sessions provider with listSessions() */
  #sessions

  /** @type {object|null} trust provider with getReputation(podId) */
  #trust

  /** @type {Function} */
  #onLog

  /** @type {Map<string, PeerHealth>} podId -> PeerHealth */
  #peers = new Map()

  /** @type {Map<string, number>} podId -> timestamp when first tracked */
  #firstSeen = new Map()

  /** @type {object} current thresholds (mutable copy of HEALTH_DEFAULTS) */
  #thresholds = { ...HEALTH_DEFAULTS }

  /** @type {*} interval timer ID */
  #intervalId = null

  /** @type {Map<string, Set<Function>>} event -> listeners */
  #listeners = new Map()

  /**
   * @param {object} opts
   * @param {object} opts.sessions - Object with listSessions() -> array of { remotePodId, send(type, payload), sessionId }
   * @param {object} [opts.trust] - Object with getReputation(podId) -> number
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   */
  constructor({ sessions, trust, onLog }) {
    if (!sessions || typeof sessions.listSessions !== 'function') {
      throw new Error('sessions with listSessions() method is required')
    }
    this.#sessions = sessions
    this.#trust = trust || null
    this.#onLog = onLog || (() => {})
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Start periodic heartbeat checks.
   *
   * @param {number} [intervalMs] - Override default heartbeat interval
   */
  start(intervalMs) {
    this.stop()
    const ms = intervalMs ?? this.#thresholds.heartbeatIntervalMs
    this.#intervalId = globalThis.setInterval(() => this.#tick(), ms)
    this.#onLog(2, `Health monitor started (interval=${ms}ms)`)
  }

  /**
   * Stop periodic heartbeat checks.
   */
  stop() {
    if (this.#intervalId !== null) {
      globalThis.clearInterval(this.#intervalId)
      this.#intervalId = null
      this.#onLog(2, 'Health monitor stopped')
    }
  }

  // -- Heartbeat recording --------------------------------------------------

  /**
   * Record a heartbeat response from a peer.
   * Called externally when a heartbeat pong is received.
   *
   * @param {string} podId - Peer pod identifier
   * @param {number} [latencyMs=0] - Round-trip latency in milliseconds
   */
  recordHeartbeat(podId, latencyMs = 0) {
    const now = Date.now()
    const existing = this.#peers.get(podId)
    const previousStatus = existing ? existing.status : 'unknown'

    if (!this.#firstSeen.has(podId)) {
      this.#firstSeen.set(podId, now)
    }
    const uptimeMs = now - this.#firstSeen.get(podId)

    // Determine new status based on latency
    let newStatus = 'healthy'
    if (latencyMs > this.#thresholds.degradedThresholdMs) {
      newStatus = 'degraded'
    }

    const health = new PeerHealth({
      podId,
      status: newStatus,
      lastHeartbeat: now,
      missedHeartbeats: 0,
      latencyMs,
      uptimeMs,
    })

    this.#peers.set(podId, health)

    // Emit status transition events
    if (previousStatus === 'failed') {
      this.#emit('recovered', health)
      this.#onLog(2, `Peer ${podId} recovered`)
    }
    if (newStatus === 'healthy' && previousStatus !== 'healthy') {
      this.#emit('healthy', health)
    }
    if (newStatus === 'degraded') {
      this.#emit('degraded', health)
    }
  }

  // -- Status queries -------------------------------------------------------

  /**
   * Get health status for all tracked peers.
   *
   * @returns {Map<string, PeerHealth>}
   */
  getStatus() {
    return new Map(this.#peers)
  }

  /**
   * Get health data for a single peer.
   *
   * @param {string} podId - Peer pod identifier
   * @returns {PeerHealth|null}
   */
  getPeerHealth(podId) {
    return this.#peers.get(podId) || null
  }

  // -- Configuration --------------------------------------------------------

  /**
   * Override default health monitoring thresholds.
   *
   * @param {object} thresholds - Partial threshold overrides
   */
  setThresholds(thresholds) {
    if (thresholds && typeof thresholds === 'object') {
      Object.assign(this.#thresholds, thresholds)
    }
  }

  /**
   * Return current threshold configuration.
   * @returns {object}
   */
  getThresholds() {
    return { ...this.#thresholds }
  }

  /**
   * Reset heartbeat history for a specific peer.
   * @param {string} podId
   */
  clearHeartbeat(podId) {
    const peer = this.#peers.get(podId)
    if (peer) {
      peer.lastHeartbeat = null
      peer.missedHeartbeats = 0
      peer.latencyMs = null
    }
  }

  /**
   * Completely remove a peer from monitoring.
   * @param {string} podId
   * @returns {boolean}
   */
  untrack(podId) {
    return this.#peers.delete(podId)
  }

  // -- Events ---------------------------------------------------------------

  /**
   * Register a listener for a health event.
   * Events: 'healthy', 'degraded', 'failed', 'recovered'
   *
   * @param {string} event - Event name
   * @param {Function} cb - Callback function
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set())
    }
    this.#listeners.get(event).add(cb)
  }

  /**
   * Remove a listener for a health event.
   *
   * @param {string} event - Event name
   * @param {Function} cb - Callback function
   */
  off(event, cb) {
    const set = this.#listeners.get(event)
    if (set) set.delete(cb)
  }

  // -- Serialization --------------------------------------------------------

  /**
   * Serialize the monitor state.
   * @returns {object}
   */
  toJSON() {
    const peers = {}
    for (const [podId, health] of this.#peers) {
      peers[podId] = health.toJSON()
    }
    return {
      peers,
      thresholds: { ...this.#thresholds },
      running: this.#intervalId !== null,
    }
  }

  // -- Internal -------------------------------------------------------------

  /**
   * Single heartbeat tick: increment missed counts, send pings, update statuses.
   */
  #tick() {
    const sessions = this.#sessions.listSessions()

    // Ensure all session peers are tracked
    for (const session of sessions) {
      if (!this.#peers.has(session.remotePodId)) {
        this.#peers.set(session.remotePodId, new PeerHealth({
          podId: session.remotePodId,
        }))
        if (!this.#firstSeen.has(session.remotePodId)) {
          this.#firstSeen.set(session.remotePodId, Date.now())
        }
      }
    }

    // Increment missed heartbeats for all tracked peers
    for (const [podId, health] of this.#peers) {
      const newMissed = health.missedHeartbeats + 1
      const uptimeMs = Date.now() - (this.#firstSeen.get(podId) || Date.now())

      let newStatus = health.status
      if (newMissed >= this.#thresholds.maxMissedHeartbeats) {
        newStatus = 'failed'
      } else if (newMissed >= 1 && health.status !== 'failed') {
        newStatus = 'degraded'
      }

      const previousStatus = health.status
      const updated = new PeerHealth({
        podId,
        status: newStatus,
        lastHeartbeat: health.lastHeartbeat,
        missedHeartbeats: newMissed,
        latencyMs: health.latencyMs,
        uptimeMs,
      })
      this.#peers.set(podId, updated)

      // Emit status transition events
      if (newStatus === 'degraded' && previousStatus !== 'degraded' && previousStatus !== 'failed') {
        this.#emit('degraded', updated)
        this.#onLog(1, `Peer ${podId} degraded (missed=${newMissed})`)
      }
      if (newStatus === 'failed' && previousStatus !== 'failed') {
        this.#emit('failed', updated)
        this.#onLog(0, `Peer ${podId} failed (missed=${newMissed})`)
      }
    }

    // Send heartbeat pings to all sessions
    for (const session of sessions) {
      try {
        session.send('heartbeat:ping', { timestamp: Date.now() })
      } catch (err) {
        this.#onLog(0, `Failed to send heartbeat to ${session.remotePodId}: ${err.message}`)
      }
    }
  }

  /**
   * Emit an event to all registered listeners, swallowing errors.
   *
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  #emit(event, data) {
    const set = this.#listeners.get(event)
    if (!set) return
    for (const cb of [...set]) {
      try {
        cb(data)
      } catch {
        /* listener errors do not propagate */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// AutoMigrator — automatic workload migration on peer failure
// ---------------------------------------------------------------------------

/**
 * Listens to HealthMonitor failure events and automatically migrates
 * workloads away from failed peers.
 */
export class AutoMigrator {
  /** @type {HealthMonitor} */
  #healthMonitor

  /** @type {object} orchestrator with drainPod(), listPods(), deploySkill() */
  #orchestrator

  /** @type {Function} */
  #onLog

  /** @type {boolean} */
  #enabled = false

  /** @type {string[]|null} services to migrate (null = all) */
  #services = null

  /** @type {string[]|null} preferred failover targets in priority order */
  #failoverPriority = null

  /** @type {Function|null} bound handler reference for cleanup */
  #failedHandler = null

  /** @type {Map<string, Set<Function>>} event -> listeners */
  #listeners = new Map()

  /** @type {Function|null} resolves the workload to redeploy on the target */
  #resolveWorkload = null

  /**
   * @param {object} opts
   * @param {HealthMonitor} opts.healthMonitor - Health monitor to listen to
   * @param {object} opts.orchestrator - Object with drainPod(podId), listPods(), deploySkill(podId, skill)
   * @param {Function} [opts.resolveWorkload] - `(fromPodId, { services }) => Promise<Array<{name, content}>>`
   *   Supplies the skills to deploy on the target. A failed peer cannot be asked
   *   what it was running, so the workload has to come from the caller -- a
   *   registry, a manifest, whatever the application uses as its source of
   *   truth. Without it the migrator can drain the dead pod but cannot start
   *   anything in its place, and says so in the result rather than reporting a
   *   migration that did not happen.
   * @param {Function} [opts.onLog] - Logging callback (level, msg)
   */
  constructor({ healthMonitor, orchestrator, resolveWorkload, onLog }) {
    if (!healthMonitor) {
      throw new Error('healthMonitor is required')
    }
    if (!orchestrator || typeof orchestrator.drainPod !== 'function') {
      throw new Error('orchestrator with drainPod() method is required')
    }
    if (resolveWorkload !== undefined && typeof resolveWorkload !== 'function') {
      throw new Error('resolveWorkload must be a function')
    }
    if (resolveWorkload && typeof orchestrator.deploySkill !== 'function') {
      throw new Error('orchestrator with deploySkill() method is required when resolveWorkload is given')
    }
    this.#healthMonitor = healthMonitor
    this.#orchestrator = orchestrator
    this.#resolveWorkload = resolveWorkload || null
    this.#onLog = onLog || (() => {})
  }

  // -- Lifecycle ------------------------------------------------------------

  /**
   * Enable automatic migration on peer failure.
   *
   * @param {object} [opts]
   * @param {string[]} [opts.services] - Only migrate these services (null = all)
   * @param {string[]} [opts.failoverPriority] - Preferred target pods in order
   */
  enable(opts) {
    if (this.#enabled) return

    this.#services = opts?.services || null
    this.#failoverPriority = opts?.failoverPriority || null

    this.#failedHandler = (health) => this.#onPeerFailed(health.podId)
    this.#healthMonitor.on('failed', this.#failedHandler)
    this.#enabled = true

    this.#onLog(2, 'AutoMigrator enabled')
  }

  /**
   * Disable automatic migration.
   */
  disable() {
    if (!this.#enabled) return

    if (this.#failedHandler) {
      this.#healthMonitor.off('failed', this.#failedHandler)
      this.#failedHandler = null
    }
    this.#enabled = false

    this.#onLog(2, 'AutoMigrator disabled')
  }

  // -- Manual migration -----------------------------------------------------

  /**
   * Manually trigger migration from one pod to another.
   *
   * @param {string} fromPodId - Pod to drain workload from
   * @param {string} [toPodId] - Target pod (auto-selected if omitted)
   * @returns {Promise<MigrationResult>}
   */
  async migrateNow(fromPodId, toPodId) {
    const startTime = Date.now()
    const target = toPodId || this.#selectTarget(fromPodId)

    if (!target) {
      const result = new MigrationResult({
        success: false,
        fromPod: fromPodId,
        toPod: '',
        error: 'No healthy target pod available',
        durationMs: Date.now() - startTime,
      })
      this.#emit('migration-failed', result)
      return result
    }

    this.#emit('migrating', { fromPod: fromPodId, toPod: target })
    this.#onLog(2, `Migrating workload from ${fromPodId} to ${target}`)

    try {
      // drainPod reports failure for exactly the case this path exists to
      // handle -- a pod that has already dropped out of the peer table -- so
      // its verdict decides the migration. An orchestrator that returns
      // nothing is giving no verdict, which is not the same as failing.
      const drain = await this.#orchestrator.drainPod(fromPodId)
      if (drain && drain.success === false) {
        const reason = drain.error || `drainPod("${fromPodId}") reported failure`
        return this.#fail(fromPodId, target, reason, startTime)
      }

      // Move the workload. Nothing below runs on a peer until deploySkill has
      // said it succeeded, and `deployed` records what actually landed.
      const workload = await this.#workloadFor(fromPodId)
      const deployed = []

      for (const item of workload) {
        const name = item?.name || 'unnamed skill'
        let outcome
        try {
          outcome = await this.#orchestrator.deploySkill(target, item?.content)
        } catch (err) {
          return this.#fail(
            fromPodId, target,
            `deploying "${name}" to ${target} threw: ${err.message}`,
            startTime, deployed,
          )
        }
        if (!outcome || outcome.success === false) {
          const why = outcome?.error || 'deploySkill reported failure'
          return this.#fail(
            fromPodId, target,
            `deploying "${name}" to ${target} failed: ${why}`,
            startTime, deployed,
          )
        }
        deployed.push(name)
      }

      const result = new MigrationResult({
        success: true,
        fromPod: fromPodId,
        toPod: target,
        // Only ever names what was really deployed. This used to read 'all'
        // unconditionally, while nothing at all was started on the target.
        workload: deployed.length ? deployed.join(', ') : null,
        deployed,
        durationMs: Date.now() - startTime,
      })
      this.#emit('migrated', result)
      this.#onLog(
        2,
        deployed.length
          ? `Migration complete: ${fromPodId} -> ${target}, deployed ${deployed.length} (${result.durationMs}ms)`
          : `Drained ${fromPodId}; NO workload was deployed to ${target} (${result.durationMs}ms)`,
      )
      return result
    } catch (err) {
      return this.#fail(fromPodId, target, err.message, startTime)
    }
  }

  // -- Events ---------------------------------------------------------------

  /**
   * Register a listener for a migration event.
   * Events: 'migrating', 'migrated', 'migration-failed'
   *
   * @param {string} event - Event name
   * @param {Function} cb - Callback function
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) {
      this.#listeners.set(event, new Set())
    }
    this.#listeners.get(event).add(cb)
  }

  /**
   * Remove a listener for a migration event.
   *
   * @param {string} event - Event name
   * @param {Function} cb - Callback function
   */
  off(event, cb) {
    const set = this.#listeners.get(event)
    if (set) set.delete(cb)
  }

  // -- Internal -------------------------------------------------------------

  /**
   * Build a failed MigrationResult, emit it, and log it.
   *
   * @param {string} fromPodId
   * @param {string} target
   * @param {string} error - Why the migration failed
   * @param {number} startTime
   * @param {string[]} [deployed=[]] - Skills that did land before the failure
   * @returns {MigrationResult}
   */
  #fail(fromPodId, target, error, startTime, deployed = []) {
    const result = new MigrationResult({
      success: false,
      fromPod: fromPodId,
      toPod: target,
      workload: deployed.length ? deployed.join(', ') : null,
      deployed,
      error,
      durationMs: Date.now() - startTime,
    })
    this.#emit('migration-failed', result)
    this.#onLog(0, `Migration failed: ${fromPodId} -> ${target}: ${error}`)
    return result
  }

  /**
   * Resolve the workload to deploy on the target, normalised to a list.
   *
   * @param {string} fromPodId - Pod whose workload is being moved
   * @returns {Promise<Array<{name: string, content: *}>>}
   */
  async #workloadFor(fromPodId) {
    if (!this.#resolveWorkload) {
      // Loud, because the alternative is a self-healing component that heals
      // nothing while reporting success.
      this.#onLog(
        1,
        `No resolveWorkload configured: ${fromPodId}'s workload will NOT be redeployed`,
      )
      return []
    }
    const resolved = await this.#resolveWorkload(fromPodId, { services: this.#services })
    if (!resolved) return []
    return Array.isArray(resolved) ? resolved : [resolved]
  }

  /**
   * Select the best target pod for migration.
   * Prefers failoverPriority list, then picks the healthiest peer.
   *
   * @param {string} fromPodId - Pod being drained (excluded from candidates)
   * @returns {string|null}
   */
  #selectTarget(fromPodId) {
    const status = this.#healthMonitor.getStatus()

    // Try failover priority list first
    if (this.#failoverPriority) {
      for (const podId of this.#failoverPriority) {
        if (podId === fromPodId) continue
        const health = status.get(podId)
        if (health && (health.status === 'healthy' || health.status === 'degraded')) {
          return podId
        }
      }
    }

    // Fall back to healthiest available peer
    let bestPod = null
    let bestScore = -Infinity

    for (const [podId, health] of status) {
      if (podId === fromPodId) continue
      if (health.status === 'failed') continue

      // Score: lower missed heartbeats and lower latency is better
      const score = -(health.missedHeartbeats * 1000 + health.latencyMs)
      if (score > bestScore) {
        bestScore = score
        bestPod = podId
      }
    }

    return bestPod
  }

  /**
   * Handler for peer failure events from the health monitor.
   *
   * @param {string} podId - Failed peer pod identifier
   */
  async #onPeerFailed(podId) {
    this.#onLog(1, `Auto-migration triggered for failed peer: ${podId}`)
    await this.migrateNow(podId)
  }

  /**
   * Emit an event to all registered listeners, swallowing errors.
   *
   * @param {string} event - Event name
   * @param {*} data - Event data
   */
  #emit(event, data) {
    const set = this.#listeners.get(event)
    if (!set) return
    for (const cb of [...set]) {
      try {
        cb(data)
      } catch {
        /* listener errors do not propagate */
      }
    }
  }
}
