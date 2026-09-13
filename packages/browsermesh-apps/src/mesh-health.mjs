/**
 * mesh-health.mjs -- Phase 1 of the browsermesh-app-layer-migration plan
 * (issue #120): wraps `peer-health.mjs`'s `HealthMonitor` (+ `AutoMigrator`,
 * opt-in) as a `MeshService` (`mesh-service.mjs`, Phase C's `attach()`/`ctx`
 * convention).
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE FILE FROM `mesh-timestamp.mjs` (the plan's "could be one
 * file or two -- your call, document why"): every existing `mesh-*.mjs`
 * wrapper in this package corresponds to ONE cohesive wire-protocol/feature
 * area (`mesh-rpc.mjs` is request/response only, `mesh-keepalive.mjs` is
 * ping/pong liveness only). `mesh-kv.mjs` is the one file that composes two
 * services together, but only because `MeshKv`'s `grant()`/`revoke()`
 * genuinely has to sequence `GrantLog` + the KV sync engine together (a real
 * coupling). `peer-timestamp.mjs` (signed consensus timestamping) and
 * `peer-health.mjs` (heartbeat liveness/auto-migration) have no such
 * coupling -- different wire protocols, different envelope types, different
 * `createMeshNode()` opt-in options (`enableTimestamp` vs
 * `enableHealthMonitor`) -- so combining them would just be arbitrary
 * co-location with zero shared code. Two files, matching the family's
 * default (one wrapper per cohesive feature), is the more legible choice.
 *
 * ---------------------------------------------------------------------------
 * SESSIONS ADAPTER -- `HealthMonitor`'s own `#tick()` calls
 * `sessions.listSessions()` and, UNLIKE `TimestampAuthority`, genuinely uses
 * the result: it expects `{remotePodId, send(type, payload)}` entries (see
 * `peer-health.mjs`'s own constructor doc comment). `PeerNode.listSessions()`
 * (`peer-node.mjs`) returns real, live session entries, but shaped as
 * `{pubKey, sessionId, transport, connectedAt, state}` -- `pubKey` instead of
 * `remotePodId`, and no `send()` at all (`transportInstance` is stripped
 * before the caller ever sees it, by design -- see that method's own doc
 * comment). This file bridges the two with a small adapter, routing `send()`
 * through `ctx.sendTo()` (the same dispatch bus every other `MeshService` in
 * this family uses) rather than reaching for a raw transport:
 *
 *   { remotePodId: session.pubKey, sessionId: session.sessionId,
 *     send: (type, payload) => ctx.sendTo(session.pubKey, type, payload) }
 *
 * `session.send('heartbeat:ping', {timestamp})` (the exact call
 * `peer-health.mjs`'s `#tick()` already makes, hardcoded literal type
 * string and all) is CALLED SYNCHRONOUSLY inside a `try/catch` there --
 * but `ctx.sendTo()` is async, so a rejected promise cannot be caught by
 * that synchronous `catch`. The adapter's own `send()` therefore swallows
 * (and logs) any `ctx.sendTo()` rejection itself, so a transient
 * send failure can never become an unhandled rejection escaping
 * `HealthMonitor`'s own tick loop.
 *
 * ---------------------------------------------------------------------------
 * WIRE PROTOCOL this file adds (not owned by `peer-health.mjs` itself,
 * exactly like `mesh-timestamp.mjs`'s witness collection is not owned by
 * `peer-timestamp.mjs`): `HealthMonitor` only ever SENDS `'heartbeat:ping'`
 * envelopes and exposes `recordHeartbeat(podId, latencyMs)` for something
 * else to call when a reply arrives -- it has no receiving-side logic of its
 * own. This file supplies both missing halves via `ctx.onIncomingData()`:
 *
 *   - Inbound `'heartbeat:ping'` -> reply with `'heartbeat:pong'`, echoing
 *     the ping's own `timestamp` back as `replyTo` (so the asking side can
 *     compute round-trip latency), mirroring `mesh-keepalive.mjs`'s own
 *     `replyTo` convention for the identical reason.
 *   - Inbound `'heartbeat:pong'` -> `monitor.recordHeartbeat(fromPubKey,
 *     latencyMs)`, `latencyMs = now - replyTo`.
 *
 * ---------------------------------------------------------------------------
 * AUTO-MIGRATION (opt-in via `opts.orchestrator`) -- `AutoMigrator` is
 * constructed and `.enable()`d only when the caller supplies a duck-typed
 * `orchestrator` (`{drainPod(), deploySkill()?}`). Per the migration plan's
 * own scoping note: this is NOT the unwired `MeshOrchestrator` class from
 * issue #92 -- that class is a different, still-unwired thing, out of scope
 * here. Any caller-supplied orchestrator-shaped object works, matching how
 * every other `MeshService` in this family accepts duck-typed dependencies
 * rather than reaching for one specific class.
 *
 * ---------------------------------------------------------------------------
 * Observability events (`ctx.emit()`, see `mesh-service.mjs`'s module doc
 * comment for the full convention). `HealthMonitor`'s own `on`/`off` events
 * (`'healthy'`, `'degraded'`, `'failed'`, `'recovered'`) and, when
 * `AutoMigrator` is active, its own (`'migrating'`, `'migrated'`,
 * `'migration-failed'`) are bridged through 1:1, not dropped:
 *
 *   - `health-monitor:peer-healthy`   `PeerHealth.toJSON()` shape
 *   - `health-monitor:peer-degraded`  `PeerHealth.toJSON()` shape
 *   - `health-monitor:peer-failed`    `PeerHealth.toJSON()` shape
 *   - `health-monitor:peer-recovered` `PeerHealth.toJSON()` shape
 *   - `health-monitor:migrating`      `{fromPod, toPod}`
 *   - `health-monitor:migrated`       `MigrationResult.toJSON()` shape
 *   - `health-monitor:migration-failed` `MigrationResult.toJSON()` shape
 *
 * No browser-only imports at module level.
 */

import { HealthMonitor, AutoMigrator } from './peer-health.mjs'

/** Envelope type `HealthMonitor` itself hardcodes for its outbound ping (see `peer-health.mjs`'s `#tick()`). */
const HEARTBEAT_PING_TYPE = 'heartbeat:ping'
/** Envelope type this file uses for the reply -- not owned by `peer-health.mjs`, see module doc comment. */
const HEARTBEAT_PONG_TYPE = 'heartbeat:pong'

/**
 * Build a `MeshService` descriptor (`mesh-service.mjs`, Phase C) wrapping
 * `HealthMonitor` (+ `AutoMigrator`, opt-in). See this file's module doc
 * comment for the full design writeup.
 *
 * @param {object} [opts]
 * @param {object} [opts.trust] - Passed through to `HealthMonitor` (object
 *   with `getReputation(podId)`).
 * @param {object} [opts.orchestrator] - Duck-typed `{drainPod(podId),
 *   deploySkill(podId, skill)?}`. When supplied, an `AutoMigrator` is
 *   constructed and enabled, automatically migrating workloads off peers
 *   `HealthMonitor` reports `'failed'`. See module doc comment's
 *   "AUTO-MIGRATION" section for what this is and is not.
 * @param {Function} [opts.resolveWorkload] - Passed through to
 *   `AutoMigrator`. Requires `opts.orchestrator.deploySkill` to also be
 *   supplied (enforced by `AutoMigrator`'s own constructor).
 * @param {number} [opts.intervalMs] - Heartbeat tick interval, passed to
 *   `monitor.start()` (default 10000, see `HEALTH_DEFAULTS`).
 * @param {object} [opts.thresholds] - Passed to `monitor.setThresholds()`
 *   before `start()` -- partial overrides of `HEALTH_DEFAULTS`
 *   (`heartbeatIntervalMs`/`heartbeatTimeoutMs`/`maxMissedHeartbeats`/
 *   `degradedThresholdMs`).
 * @param {Function} [opts.onLog]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createHealthMonitorService({
  trust,
  orchestrator,
  resolveWorkload,
  intervalMs,
  thresholds,
  onLog,
} = {}) {
  const log = onLog || (() => {})

  return {
    name: 'health-monitor',

    attach(peerNode, ctx) {
      if (typeof peerNode?.listSessions !== 'function') {
        throw new Error(
          'mesh-health: peerNode must be a real PeerNode providing listSessions() ' +
          '(a duck-typed {sendTo, onIncomingData} node, as other MeshServices in this ' +
          'family accept, is not enough here -- see module doc comment).',
        )
      }

      // Bridges PeerNode.listSessions()'s {pubKey, sessionId, ...} shape to
      // the {remotePodId, send(type, payload)} shape HealthMonitor's own
      // #tick() genuinely calls -- see module doc comment's "SESSIONS ADAPTER".
      const sessionsAdapter = {
        listSessions() {
          return peerNode.listSessions().map((session) => ({
            sessionId: session.sessionId,
            remotePodId: session.pubKey,
            send: (type, payload) => {
              ctx.sendTo(session.pubKey, type, payload).catch((err) => {
                log('mesh-health:heartbeat-send-failed', { to: session.pubKey, error: err?.message || String(err) })
              })
            },
          }))
        },
      }

      const monitor = new HealthMonitor({
        sessions: sessionsAdapter,
        trust,
        onLog: (level, msg) => log('mesh-health:internal', { level, msg }),
      })

      if (thresholds) monitor.setThresholds(thresholds)

      // -----------------------------------------------------------------
      // Bridge HealthMonitor's own on/off events into ctx.emit() -- see
      // module doc comment's "Observability events".
      // -----------------------------------------------------------------
      const forwardHealthy = (health) => ctx.emit('health-monitor:peer-healthy', health.toJSON())
      const forwardDegraded = (health) => ctx.emit('health-monitor:peer-degraded', health.toJSON())
      const forwardFailed = (health) => ctx.emit('health-monitor:peer-failed', health.toJSON())
      const forwardRecovered = (health) => ctx.emit('health-monitor:peer-recovered', health.toJSON())
      monitor.on('healthy', forwardHealthy)
      monitor.on('degraded', forwardDegraded)
      monitor.on('failed', forwardFailed)
      monitor.on('recovered', forwardRecovered)

      // -----------------------------------------------------------------
      // Wire protocol this file adds -- see module doc comment's "WIRE
      // PROTOCOL".
      // -----------------------------------------------------------------
      const unsubscribe = ctx.onIncomingData([HEARTBEAT_PING_TYPE, HEARTBEAT_PONG_TYPE], (fromPubKey, msg) => {
        if (msg.type === HEARTBEAT_PING_TYPE) {
          ctx.sendTo(fromPubKey, HEARTBEAT_PONG_TYPE, { replyTo: msg.timestamp, timestamp: Date.now() }).catch((err) => {
            log('mesh-health:pong-send-failed', { to: fromPubKey, error: err?.message || String(err) })
          })
        } else if (msg.type === HEARTBEAT_PONG_TYPE) {
          const latencyMs = typeof msg.replyTo === 'number' ? Math.max(0, Date.now() - msg.replyTo) : 0
          monitor.recordHeartbeat(fromPubKey, latencyMs)
        }
      })

      // -----------------------------------------------------------------
      // Auto-migration (opt-in) -- see module doc comment's "AUTO-MIGRATION".
      // -----------------------------------------------------------------
      let autoMigrator = null
      let forwardMigrating, forwardMigrated, forwardMigrationFailed
      if (orchestrator) {
        autoMigrator = new AutoMigrator({
          healthMonitor: monitor,
          orchestrator,
          resolveWorkload,
          onLog: (level, msg) => log('mesh-health:auto-migrator', { level, msg }),
        })
        forwardMigrating = (data) => ctx.emit('health-monitor:migrating', data)
        forwardMigrated = (result) => ctx.emit('health-monitor:migrated', result.toJSON())
        forwardMigrationFailed = (result) => ctx.emit('health-monitor:migration-failed', result.toJSON())
        autoMigrator.on('migrating', forwardMigrating)
        autoMigrator.on('migrated', forwardMigrated)
        autoMigrator.on('migration-failed', forwardMigrationFailed)
        autoMigrator.enable()
      }

      monitor.start(intervalMs)

      const api = {
        /** @param {string} podId @returns {import('./peer-health.mjs').PeerHealth|null} */
        getPeerHealth(podId) {
          return monitor.getPeerHealth(podId)
        },
        /** @returns {Map<string, import('./peer-health.mjs').PeerHealth>} */
        getStatus() {
          return monitor.getStatus()
        },
        /** @param {object} partial */
        setThresholds(partial) {
          monitor.setThresholds(partial)
        },
        /** @returns {object} */
        getThresholds() {
          return monitor.getThresholds()
        },
        /** Stop the periodic heartbeat tick. */
        stop() {
          monitor.stop()
        },
        /** (Re)start the periodic heartbeat tick. @param {number} [ms] */
        start(ms) {
          monitor.start(ms)
        },
        /**
         * @param {string} fromPodId
         * @param {string} [toPodId]
         * @returns {Promise<import('./peer-health.mjs').MigrationResult>}
         */
        migrateNow(fromPodId, toPodId) {
          if (!autoMigrator) {
            throw new Error('mesh-health: migrateNow() requires opts.orchestrator to have been supplied at attach time')
          }
          return autoMigrator.migrateNow(fromPodId, toPodId)
        },
        /** The underlying `AutoMigrator`, or `null` if `opts.orchestrator` was not supplied. */
        autoMigrator,
      }

      return {
        api,
        teardown() {
          monitor.stop()
          monitor.off('healthy', forwardHealthy)
          monitor.off('degraded', forwardDegraded)
          monitor.off('failed', forwardFailed)
          monitor.off('recovered', forwardRecovered)
          if (autoMigrator) {
            autoMigrator.disable()
            autoMigrator.off('migrating', forwardMigrating)
            autoMigrator.off('migrated', forwardMigrated)
            autoMigrator.off('migration-failed', forwardMigrationFailed)
          }
          unsubscribe()
        },
      }
    },
  }
}

export { HEARTBEAT_PING_TYPE, HEARTBEAT_PONG_TYPE }
