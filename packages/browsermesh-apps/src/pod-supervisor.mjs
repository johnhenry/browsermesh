/**
 * pod-supervisor.mjs -- issue #185 item 6: links, monitors, and restart
 * policy over the hosted-pods control surface ("docs/hosted-pods.md" §8a's
 * last control-surface row -- "`restart` policy + `status`/`spawn`/`drain`
 * in a loop").
 *
 * PRECEDENT: OTP. Three ideas, each already present elsewhere in this
 * surface and composed here rather than reinvented:
 *
 *   - **links** -- parent/child pod relationships that cascade on drain
 *     (`docs/hosted-pods.md` §7: "Hosted pods are `child`-role pods of the
 *     host pod ... `drainPod()` on the host must cascade." This file is
 *     the general form of that rule, for ANY parent pod, not just a host.)
 *   - **monitors** -- be told when a pod you care about dies, without
 *     taking responsibility for it.
 *   - **supervisors** -- `podspec.restart` (`host-protocol.mjs`) finally
 *     gets an implementation: watch a pod's `exit` events and re-spawn it
 *     per its declared policy.
 *
 * THE ONE RULE THAT MATTERS: **a restart is a NEW `spawn` request the host
 * may refuse.** This file never calls a driver directly and never bypasses
 * `pod-host-service.mjs`'s gate -- every (re)spawn goes through
 * `orchestrator.spawnPod()` (which itself goes through the gated
 * `PodHostClient`) or, when no orchestrator was supplied, straight through
 * an injected `PodHostClient`. A host that returns `EACCES`/`EBUSY` for a
 * restart is answered the same way `MeshctlSpawnTool` answers it for a
 * fresh spawn: "the orchestrator proposes, the host accepts" -- this file
 * proposes a DIFFERENT host next (`pickHost`) rather than hammering the one
 * that refused.
 *
 * NO POLLING BY DEFAULT. Everything here is event-driven: the
 * `PodHostClient`'s own `onEvent()` (lifecycle/log/exit, forwarded by
 * `pod-host-service.mjs` to every requester with "interest" in a pod -- see
 * that module's `noteInterest()`) and, for host loss, `PeerNode`'s own
 * `'peer:disconnect'` signal (`peer-node.mjs`). `reconcileIntervalMs` is
 * an OPT-IN, slow safety-net sweep for the case an event genuinely never
 * arrives (a dropped message, a host that vanished without a disconnect
 * signal ever firing) -- not the primary mechanism.
 *
 * COMPOSES WITH `AutoMigrator` (`peer-health.mjs`), DOES NOT DUPLICATE IT.
 * `AutoMigrator` already does "move work when a peer degrades" for the
 * MESH-PEER population (`#knownPeers`, skills redeployed via
 * `deploySkill()`). This file does the analogous thing for the HOSTED-POD
 * population (pods a `PodHostDriver` tracks, redeployed via `spawnPod()`).
 * They watch different health signals (`HealthMonitor`'s heartbeat
 * liveness vs. this file's `pod-host:event` stream) and move different
 * things (skills on a bare peer vs. a podspec on a pod host); a mesh using
 * both gets whole-peer failover from one and single-pod supervision from
 * the other, with no overlap to reconcile.
 *
 * No browser-only imports at module level.
 */

import { validatePodSpec, PodHostDriverError } from '@johnhenry/browsermesh-pod'
import { createPodHostClient } from './pod-host-service.mjs'
import { pickAutoHost } from './orchestrator.mjs'

/**
 * Audit record kinds this file writes that are NOT already covered by
 * `orchestrator.mjs`'s `PLACEMENT_AUDIT` (`placement_requested` /
 * `placement_ready` / `placement_denied` are written automatically by
 * `orchestrator.spawnPod()` for every (re)spawn this file issues -- see the
 * module doc comment's "a restart is a new spawn" rule. This file never
 * records those itself, to avoid double-recording the same placement).
 */
export const SUPERVISOR_AUDIT = Object.freeze({
  RESTART_SCHEDULED: 'supervisor_restart_scheduled',
  RESTARTED: 'supervisor_restarted',
  GAVE_UP: 'supervisor_gave_up',
  CASCADE: 'supervisor_cascade',
  HOST_LOST: 'supervisor_host_lost',
})

/** Default `restart.maxRestarts` when a podspec did not say (matches `host-protocol.mjs`'s own silence on a default -- 3 is this file's choice, not the protocol's). */
const DEFAULT_MAX_RESTARTS = 3
/** Default `restart.backoffMs` base. */
const DEFAULT_BACKOFF_MS = 1000
/** Backoff never waits longer than this, regardless of restart count. */
const MAX_BACKOFF_MS = 60_000

/** @param {{host: string, name: string}} ref @returns {string} */
function refKey(ref) {
  return `${ref.host}::${ref.name}`
}

/**
 * Whether `policy` says to restart a pod that exited with `{code, reason}`.
 * `reason === 'drained'` is handled by the CALLER, before this is ever
 * consulted -- an intentional drain is never a restart candidate under any
 * policy (see `#onExit()`).
 *
 * @param {'never'|'on-failure'|'always'} policy
 * @param {{code?: number, reason?: string}} exit
 * @returns {boolean}
 */
function policyWantsRestart(policy, { code, reason }) {
  switch (policy) {
    case 'always':
      return true
    case 'on-failure':
      return code !== 0 || reason === 'crashed' || reason === 'host-lost'
    case 'never':
    default:
      return false
  }
}

/**
 * Build the `PodSupervisor` (issue #185 item 6).
 *
 * @param {object} opts
 * @param {object} [opts.orchestrator] - A `MeshOrchestrator`
 *   (`orchestrator.mjs`). Supplies `spawnPod()` (the gated restart path,
 *   which also records the requester-side `PLACEMENT_AUDIT` trail for
 *   free), the default `pickHost` (`pickAutoHost()` against this
 *   orchestrator), and -- via `.peerNode` -- the `'peer:disconnect'` signal
 *   `monitor()`'s synthesized `host-lost` events come from. Either this or
 *   `client` is required.
 * @param {object} [opts.client] - A `PodHostClient`
 *   (`pod-host-service.mjs`), used directly when no `orchestrator` was
 *   given. No requester-side placement audit trail exists on this path
 *   (`PLACEMENT_AUDIT` is `MeshOrchestrator#recordPlacement()`'s to write,
 *   not a raw client's); `auditChain` records (`SUPERVISOR_AUDIT`) still
 *   work as long as `opts.auditChain`/`opts.peerNode` are supplied.
 * @param {() => string[]} [opts.hosts] - Extra hosts the reconcile sweep
 *   and the fallback `pickHost` should consider, beyond the hosts already
 *   tracked because a pod is supervised on them.
 * @param {(spec: object, opts?: {excludeHost?: string}) => Promise<string|null>} [opts.pickHost]
 *   Choose a re-placement host for a restart that cannot stay on its
 *   current host (refused with `EACCES`/`EBUSY`, or the host itself is
 *   gone -- `reason: 'host-lost'`). Defaults to `pickAutoHost()` against
 *   `orchestrator` for `spec.lane`, the same selection
 *   `MeshctlSpawnTool`/`meshctl spawn auto` use -- see `orchestrator.mjs`.
 *   Returns `null`/throws when no orchestrator and no override were given.
 * @param {number} [opts.reconcileIntervalMs=0] - `0` disables the sweep
 *   (the default -- see module doc comment on why polling is not the
 *   primary mechanism).
 * @param {number} [opts.maxConcurrentRestarts=1] - How many `spawn` calls
 *   this supervisor will have in flight for restarts at once; further
 *   restarts whose backoff has elapsed wait their turn.
 * @param {() => number} [opts.now=Date.now]
 * @param {Function} [opts.setTimeout] - Injectable, for fake-timer tests.
 * @param {Function} [opts.clearTimeout] - Injectable, for fake-timer tests.
 * @param {Function} [opts.onLog] - `(event, data) => void` debug logging.
 * @param {object} [opts.auditChain] - Duck-typed `AuditChain`
 *   (`{append(authorPodId, operation, data, signFn)}`, matching
 *   `pod-host-service.mjs`'s own convention). Requires a `peerNode` to sign
 *   with -- taken from `orchestrator.peerNode` when present, or
 *   `opts.peerNode` directly.
 * @param {object} [opts.peerNode] - Used for `'peer:disconnect'` ->
 *   synthesized `host-lost`, and for audit signing, when no `orchestrator`
 *   was supplied.
 * @returns {object} A `PodSupervisor`.
 */
export function createPodSupervisor({
  orchestrator,
  client,
  hosts,
  pickHost,
  reconcileIntervalMs = 0,
  maxConcurrentRestarts = 1,
  now = Date.now,
  setTimeout: injectedSetTimeout,
  clearTimeout: injectedClearTimeout,
  onLog,
  auditChain,
  peerNode,
} = {}) {
  if (!orchestrator && !client) {
    throw new Error('createPodSupervisor: orchestrator or client is required')
  }

  const log = onLog || (() => {})
  const doSetTimeout = injectedSetTimeout || globalThis.setTimeout.bind(globalThis)
  const doClearTimeout = injectedClearTimeout || globalThis.clearTimeout.bind(globalThis)
  const effectivePeerNode = peerNode || orchestrator?.peerNode || null
  const maxConcurrent = Math.max(1, maxConcurrentRestarts)

  /** The `PodHostClient` every verb this file issues (other than restarts, which prefer `orchestrator.spawnPod()`) goes through. Built once, lazily. */
  let hostClient = client || null
  function getHostClient() {
    if (hostClient) return hostClient
    if (!effectivePeerNode) {
      throw new Error('createPodSupervisor: no client and no peerNode to build one from')
    }
    hostClient = createPodHostClient({ peerNode: effectivePeerNode })
    return hostClient
  }

  // -- state ------------------------------------------------------------
  /** @type {Map<string, object>} refKey -> supervised-pod record */
  const pods = new Map()
  /** @type {Map<string, Set<string>>} parent refKey -> Set<child refKey> */
  const childrenOf = new Map()
  /** @type {Map<string, string>} child refKey -> parent refKey */
  const parentOf = new Map()
  /** @type {Map<string, Set<Function>>} refKey -> monitor callbacks */
  const monitors = new Map()
  /** @type {Map<string, Set<Function>>} event name -> listeners */
  const listeners = new Map()

  let activeRestarts = 0
  /** @type {Function[]} queued restart attempts, FIFO, when `maxConcurrent` is saturated */
  const restartQueue = []
  let stopped = false
  let reconcileTimer = null
  let unsubscribeHostEvents = null
  let unsubscribePeerDisconnect = null

  /** @param {string} event @param {object} data */
  function emit(event, data) {
    const set = listeners.get(event)
    if (!set) return
    for (const fn of [...set]) {
      try {
        fn(data)
      } catch {
        // A throwing subscriber never breaks delivery to the others or to
        // this file's own control flow -- the same rule `mesh-service.mjs`'s
        // event bus applies everywhere else in this package.
      }
    }
  }

  /**
   * @param {string} operation - A `SUPERVISOR_AUDIT` value.
   * @param {object} data
   */
  async function audit(operation, data) {
    if (!auditChain || typeof auditChain.append !== 'function') return
    const podId = effectivePeerNode?.podId
    if (!podId || typeof effectivePeerNode?.wallet?.sign !== 'function') return
    try {
      await auditChain.append(podId, operation, data, (payload) => effectivePeerNode.wallet.sign(podId, payload))
    } catch (err) {
      log('supervisor:audit-failed', { operation, error: err?.message || String(err) })
    }
  }

  /** @param {string} key @param {{ref: object, event: object}} payload */
  function fireMonitors(key, payload) {
    const set = monitors.get(key)
    if (!set) return
    for (const fn of [...set]) {
      try {
        fn(payload)
      } catch {
        // Same isolation rule as `emit()`.
      }
    }
  }

  /**
   * Re-key every map entry for `entry` after its host changes (a
   * re-placed restart). `entry.ref` is the SAME object across the move --
   * callers holding a `supervise()` handle's `.ref` see the new host
   * without having to re-fetch anything.
   * @param {object} entry
   * @param {string} newHost
   */
  function rekey(entry, newHost) {
    const oldKey = refKey(entry.ref)
    entry.ref.host = newHost
    entry.host = newHost
    const newKey = refKey(entry.ref)
    if (newKey === oldKey) return

    pods.delete(oldKey)
    pods.set(newKey, entry)

    const mons = monitors.get(oldKey)
    if (mons) { monitors.delete(oldKey); monitors.set(newKey, mons) }

    const kids = childrenOf.get(oldKey)
    if (kids) { childrenOf.delete(oldKey); childrenOf.set(newKey, kids) }

    const parentKey = parentOf.get(oldKey)
    if (parentKey) {
      parentOf.delete(oldKey)
      parentOf.set(newKey, parentKey)
      const siblings = childrenOf.get(parentKey)
      if (siblings) { siblings.delete(oldKey); siblings.add(newKey) }
    }
  }

  /**
   * Issue a (re)spawn -- ALWAYS through the gate. Prefers
   * `orchestrator.spawnPod()` (gated `PodHostClient` round trip, plus the
   * requester-side `PLACEMENT_AUDIT` trail for free); falls back to the
   * raw `client.spawn()` when no orchestrator was supplied.
   * @param {string} host
   * @param {object} spec
   * @returns {Promise<object>}
   */
  async function doSpawn(host, spec) {
    if (orchestrator) return orchestrator.spawnPod(host, spec)
    return getHostClient().spawn(host, spec)
  }

  /**
   * @param {object} spec - normalized podspec
   * @param {{excludeHost?: string}} [opts]
   * @returns {Promise<string|null>}
   */
  async function choosePlacement(spec, opts = {}) {
    if (pickHost) return pickHost(spec, opts)
    if (orchestrator) {
      const picked = await pickAutoHost(orchestrator, spec.lane)
      if (!picked) return null
      if (opts.excludeHost && picked.podId === opts.excludeHost) return null
      return picked.podId
    }
    if (typeof hosts === 'function') {
      const candidates = hosts().filter((h) => h !== opts.excludeHost)
      return candidates[0] ?? null
    }
    return null
  }

  // -- public API: supervise / link / monitor / unsupervise -----------------

  /**
   * Spawn a pod (via `doSpawn()`, the gated path) and start supervising it
   * per `spec.restart`. `spec.links.parent` implies `link()` against
   * `{host, name: spec.links.parent}` -- the parent is assumed to live on
   * the SAME host as the child (podspec's `links.parent` is a bare name,
   * not a full ref; a cross-host parent needs an explicit `link()` call
   * after the fact instead).
   *
   * @param {string} hostPodId - Target host, or `'auto'` to pick one via
   *   `choosePlacement()` the same way `MeshctlSpawnTool`/`meshctl spawn
   *   auto` do.
   * @param {object} spec - A podspec (`validatePodSpec()`).
   * @returns {Promise<{ref: {host: string, name: string}, spec: object, host: string, status: object}>}
   */
  async function supervise(hostPodId, spec) {
    if (stopped) throw new Error('supervisor is stopped')
    const validated = validatePodSpec(spec)
    if (!validated.ok) {
      throw new PodHostDriverError('EINVAL', validated.errors.join('; '), { errors: validated.errors })
    }
    const normalized = validated.value

    let host = hostPodId
    if (!host || host === 'auto') {
      host = await choosePlacement(normalized)
      if (!host) throw new Error(`supervise: no host available for lane '${normalized.lane}'`)
    }

    const status = await doSpawn(host, normalized)

    /** @type {{host: string, name: string}} */
    const ref = { host, name: normalized.name }
    const entry = {
      ref,
      spec: normalized,
      host,
      restarts: 0,
      state: 'running',
      backoffTimer: null,
      createdAt: now(),
    }
    pods.set(refKey(ref), entry)

    if (normalized.links?.parent) {
      link({ host, name: normalized.links.parent }, ref)
    }

    return { ref, spec: normalized, host, status }
  }

  /**
   * Register `childRef` as a child of `parentRef`: when the parent drains
   * (`drain()`) or unexpectedly exits, the child is cascade-drained too
   * (unless `childRef`'s own podspec set `links.detachOnParentExit: true`
   * together with `restart.policy: 'always'`).
   * @param {{host: string, name: string}} parentRef
   * @param {{host: string, name: string}} childRef
   */
  function link(parentRef, childRef) {
    const parentKey = refKey(parentRef)
    const childKey = refKey(childRef)
    let set = childrenOf.get(parentKey)
    if (!set) { set = new Set(); childrenOf.set(parentKey, set) }
    set.add(childKey)
    parentOf.set(childKey, parentKey)
  }

  /**
   * @param {{host: string, name: string}} parentRef
   * @param {{host: string, name: string}} childRef
   */
  function unlink(parentRef, childRef) {
    const parentKey = refKey(parentRef)
    const childKey = refKey(childRef)
    childrenOf.get(parentKey)?.delete(childKey)
    if (parentOf.get(childKey) === parentKey) parentOf.delete(childKey)
  }

  /**
   * Fire `fn({ref, event})` for every lifecycle/exit event of the pod named
   * by `ref`, including a synthesized `{kind: 'exit', data: {reason:
   * 'host-lost', restartable: true, ...}}` when its host disconnects.
   * @param {{host: string, name: string}} ref
   * @param {(payload: {ref: object, event: object}) => void} fn
   * @returns {() => void} Unsubscribe.
   */
  function monitor(ref, fn) {
    const key = refKey(ref)
    let set = monitors.get(key)
    if (!set) { set = new Set(); monitors.set(key, set) }
    set.add(fn)
    return () => { monitors.get(key)?.delete(fn) }
  }

  /**
   * Stop supervising `ref` -- clears any pending restart timer and forgets
   * it. Does NOT drain the pod; use `drain()` for that.
   * @param {{host: string, name: string}} ref
   */
  function unsupervise(ref) {
    const key = refKey(ref)
    const entry = pods.get(key)
    if (entry?.backoffTimer) doClearTimeout(entry.backoffTimer)
    pods.delete(key)
  }

  /** @returns {object[]} Every supervised pod this instance is tracking. */
  function list() {
    return [...pods.values()].map((entry) => ({
      ref: entry.ref, spec: entry.spec, host: entry.host, restarts: entry.restarts, state: entry.state,
    }))
  }

  // -- cascade ----------------------------------------------------------

  /**
   * Depth-first drain of every child of `parentRef` (grandchildren before
   * children), skipping a child that opted out via `links.detachOnParentExit
   * && restart.policy === 'always'`. Returns the flat drain order
   * (deepest descendants first), NOT including `parentRef` itself.
   * @param {{host: string, name: string}} parentRef
   * @returns {Promise<object[]>}
   */
  async function drainChildren(parentRef) {
    const parentKey = refKey(parentRef)
    const childKeys = childrenOf.get(parentKey)
    if (!childKeys || childKeys.size === 0) return []

    /** @type {object[]} */
    const order = []
    for (const childKey of [...childKeys]) {
      const childEntry = pods.get(childKey)
      const childRef = childEntry ? childEntry.ref : parseKey(childKey)

      if (childEntry?.spec?.links?.detachOnParentExit && childEntry?.spec?.restart?.policy === 'always') {
        // Detached: left running (and left supervised -- it restarts on its
        // own per its own policy if it independently fails later).
        continue
      }

      // Grandchildren before children (depth-first).
      order.push(...await drainChildren(childRef))

      if (childEntry?.backoffTimer) {
        doClearTimeout(childEntry.backoffTimer)
        childEntry.backoffTimer = null
      }
      try {
        await getHostClient().drain(childRef.host, childRef.name, { cascade: false })
      } catch (err) {
        log('supervisor:cascade-drain-failed', { ref: childRef, error: err?.message || String(err) })
      }
      if (childEntry) childEntry.state = 'dead'
      order.push(childRef)

      // Sever the relationship now that it has been handled: the
      // driver-level `drain()` just issued above will, asynchronously,
      // deliver its OWN 'drained' exit event back to this supervisor
      // (`onExit()`), which would otherwise re-discover this same
      // parent/child edge and cascade-drain an already-drained subtree a
      // second time.
      childrenOf.delete(childKey)
      parentOf.delete(childKey)
      childKeys.delete(childKey)
    }
    return order
  }

  /** @param {string} key @returns {{host: string, name: string}} */
  function parseKey(key) {
    const idx = key.indexOf('::')
    return { host: key.slice(0, idx), name: key.slice(idx + 2) }
  }

  /**
   * Drain `ref`: cascade-drain its children first (depth-first), then
   * drain `ref` itself, emitting `supervisor:cascade` with the full order
   * (children, then `ref` last).
   * @param {{host: string, name: string}} ref
   * @param {{cascade?: boolean}} [opts]
   * @returns {Promise<{ref: object, order: object[]}>}
   */
  async function drain(ref, { cascade = true } = {}) {
    const order = cascade ? await drainChildren(ref) : []

    const key = refKey(ref)
    const entry = pods.get(key)
    if (entry?.backoffTimer) {
      doClearTimeout(entry.backoffTimer)
      entry.backoffTimer = null
    }
    try {
      await getHostClient().drain(ref.host, ref.name, { cascade: false })
    } catch (err) {
      log('supervisor:drain-failed', { ref, error: err?.message || String(err) })
    }
    if (entry) entry.state = 'dead'
    order.push(ref)

    // Same reasoning as `drainChildren()`'s own cleanup: sever `ref`'s
    // relationship to ITS parent (if linked) now, before the driver's own
    // asynchronous 'drained' echo for `ref` can re-discover it.
    childrenOf.delete(key)
    const parentKey = parentOf.get(key)
    if (parentKey) { childrenOf.get(parentKey)?.delete(key); parentOf.delete(key) }

    emit('supervisor:cascade', { parent: ref, order })
    await audit(SUPERVISOR_AUDIT.CASCADE, { parent: ref, order })
    return { ref, order }
  }

  // -- restart scheduling -------------------------------------------------

  /**
   * @param {object} entry
   * @param {string} [reason]
   */
  async function scheduleRestart(entry, reason) {
    const maxRestarts = entry.spec.restart?.maxRestarts ?? DEFAULT_MAX_RESTARTS
    if (entry.restarts >= maxRestarts) {
      entry.state = 'dead'
      emit('supervisor:gave-up', { ref: entry.ref, restarts: entry.restarts, reason })
      await audit(SUPERVISOR_AUDIT.GAVE_UP, { ref: entry.ref, restarts: entry.restarts, reason })
      return
    }

    const base = entry.spec.restart?.backoffMs ?? DEFAULT_BACKOFF_MS
    const delayMs = Math.min(base * (2 ** entry.restarts), MAX_BACKOFF_MS)
    entry.restarts += 1
    const attempt = entry.restarts

    emit('supervisor:restart-scheduled', { ref: entry.ref, attempt, delayMs, reason })
    await audit(SUPERVISOR_AUDIT.RESTART_SCHEDULED, { ref: entry.ref, attempt, delayMs, reason })

    entry.backoffTimer = doSetTimeout(() => {
      entry.backoffTimer = null
      runRestart(entry, reason).catch((err) => {
        log('supervisor:restart-failed', { ref: entry.ref, error: err?.message || String(err) })
      })
    }, delayMs)
    if (typeof entry.backoffTimer === 'object' && typeof entry.backoffTimer.unref === 'function') {
      entry.backoffTimer.unref()
    }
  }

  /**
   * @param {object} entry
   * @param {string} [reason]
   */
  async function runRestart(entry, reason) {
    if (activeRestarts >= maxConcurrent) {
      await new Promise((resolve) => { restartQueue.push(resolve) })
    }
    activeRestarts += 1
    try {
      let targetHost = entry.host
      let placed = false

      if (reason !== 'host-lost') {
        try {
          const status = await doSpawn(targetHost, entry.spec)
          entry.state = 'running'
          placed = true
          emit('supervisor:restarted', { ref: entry.ref, attempt: entry.restarts, host: targetHost, status })
          await audit(SUPERVISOR_AUDIT.RESTARTED, { ref: entry.ref, attempt: entry.restarts, host: targetHost })
        } catch (err) {
          const code = err?.code
          if (code !== 'EACCES' && code !== 'EBUSY') throw err
          log('supervisor:restart-refused', { ref: entry.ref, host: targetHost, code })
        }
      }

      if (!placed) {
        const newHost = await choosePlacement(entry.spec, { excludeHost: targetHost })
        if (!newHost) throw new Error(`no host available to re-place '${entry.ref.name}'`)
        const status = await doSpawn(newHost, entry.spec)
        rekey(entry, newHost)
        entry.state = 'running'
        emit('supervisor:restarted', { ref: entry.ref, attempt: entry.restarts, host: newHost, status })
        await audit(SUPERVISOR_AUDIT.RESTARTED, { ref: entry.ref, attempt: entry.restarts, host: newHost })
      }
    } catch (err) {
      // This restart ATTEMPT failed (no host would take it, or spawn threw
      // something other than a refusal). Schedule another attempt -- still
      // bounded by `maxRestarts`, which `scheduleRestart()` enforces.
      await scheduleRestart(entry, 'restart-failed')
    } finally {
      activeRestarts -= 1
      const next = restartQueue.shift()
      if (next) next()
    }
  }

  // -- exit handling --------------------------------------------------------

  /**
   * @param {string} host - The host pubKey the event came from.
   * @param {object} data - A `PodHostExitEventData` shape.
   */
  async function onExit(host, data) {
    const ref = { host, name: data.name }
    const key = refKey(ref)

    fireMonitors(key, { ref, event: { kind: 'exit', data } })

    // Cascade to children regardless of whether `ref` itself is supervised
    // -- a parent that is merely LINKED (not itself under this supervisor's
    // restart policy) still cascades.
    const cascaded = await drainChildren(ref)
    if (cascaded.length > 0) {
      emit('supervisor:cascade', { parent: ref, order: cascaded })
      await audit(SUPERVISOR_AUDIT.CASCADE, { parent: ref, order: cascaded })
    }

    const entry = pods.get(key)
    if (!entry || entry.state === 'dead') return

    if (data.reason === 'drained') {
      entry.state = 'dead'
      return
    }

    const policy = entry.spec.restart?.policy || 'never'
    if (!policyWantsRestart(policy, data)) {
      entry.state = 'dead'
      return
    }

    entry.state = 'restarting'
    await scheduleRestart(entry, data.reason)
  }

  // -- host loss --------------------------------------------------------

  /** @param {string} hostPubKey */
  async function onHostLost(hostPubKey) {
    const affected = [...pods.values()]
      .filter((entry) => entry.host === hostPubKey && entry.state === 'running')
      .map((entry) => entry.ref)
    if (affected.length === 0) return

    emit('supervisor:host-lost', { host: hostPubKey, affected })
    await audit(SUPERVISOR_AUDIT.HOST_LOST, { host: hostPubKey, affected })

    for (const ref of affected) {
      await onExit(hostPubKey, { name: ref.name, reason: 'host-lost', restartable: true })
    }
  }

  // -- wiring -------------------------------------------------------------

  function wireHostEvents() {
    if (!hostClient && !effectivePeerNode) return // no client to build one from; onExit only reachable via reconcile/manual crash
    const c = getHostClient()
    unsubscribeHostEvents = c.onEvent((hostPubKey, event) => {
      if (event.kind !== 'exit') return
      onExit(hostPubKey, event.data).catch((err) => {
        log('supervisor:on-exit-failed', { error: err?.message || String(err) })
      })
    })
  }

  function wirePeerDisconnect() {
    const node = effectivePeerNode
    if (!node || typeof node.on !== 'function') return
    const handler = (peer) => {
      const hostPubKey = typeof peer === 'string'
        ? peer
        : (peer?.fingerprint || peer?.pubKey || peer?.podId || null)
      if (!hostPubKey) return
      onHostLost(hostPubKey).catch((err) => {
        log('supervisor:on-host-lost-failed', { error: err?.message || String(err) })
      })
    }
    node.on('peer:disconnect', handler)
    unsubscribePeerDisconnect = () => { if (typeof node.off === 'function') node.off('peer:disconnect', handler) }
  }

  wireHostEvents()
  wirePeerDisconnect()

  if (reconcileIntervalMs > 0) {
    reconcileTimer = doSetTimeout(function tick() {
      reconcile().catch((err) => log('supervisor:reconcile-failed', { error: err?.message || String(err) }))
      if (!stopped) {
        reconcileTimer = doSetTimeout(tick, reconcileIntervalMs)
        if (typeof reconcileTimer === 'object' && typeof reconcileTimer.unref === 'function') reconcileTimer.unref()
      }
    }, reconcileIntervalMs)
    if (typeof reconcileTimer === 'object' && typeof reconcileTimer.unref === 'function') reconcileTimer.unref()
  }

  /**
   * Slow safety-net sweep (opt-in via `reconcileIntervalMs`): for every
   * distinct host with a `state: 'running'` supervised pod, `list()` that
   * host and treat any pod this supervisor still thinks is `running` but
   * the host reports `gone` as a MISSED exit event -- synthesizing one with
   * `reason: 'crashed'` (the conservative assumption; an intentional drain
   * that genuinely got lost in transit is rare enough that over-restarting
   * it is the safer failure mode than under-restarting a real crash).
   * @returns {Promise<void>}
   */
  async function reconcile() {
    const byHost = new Map()
    for (const entry of pods.values()) {
      if (entry.state !== 'running') continue
      if (!byHost.has(entry.host)) byHost.set(entry.host, [])
      byHost.get(entry.host).push(entry)
    }
    for (const [host, entries] of byHost) {
      let statuses
      try {
        statuses = await getHostClient().list(host)
      } catch (err) {
        log('supervisor:reconcile-list-failed', { host, error: err?.message || String(err) })
        continue
      }
      const stateByName = new Map(statuses.map((s) => [s.name, s.state]))
      for (const entry of entries) {
        if (stateByName.get(entry.ref.name) === 'gone') {
          await onExit(host, { name: entry.ref.name, reason: 'crashed', restartable: true })
        }
      }
    }
  }

  // -- bus / lifecycle ------------------------------------------------------

  /** @param {string} event @param {Function} fn */
  function on(event, fn) {
    let set = listeners.get(event)
    if (!set) { set = new Set(); listeners.set(event, set) }
    set.add(fn)
    return () => { listeners.get(event)?.delete(fn) }
  }

  function stop() {
    if (stopped) return
    stopped = true
    for (const entry of pods.values()) {
      if (entry.backoffTimer) doClearTimeout(entry.backoffTimer)
      entry.backoffTimer = null
    }
    if (reconcileTimer) doClearTimeout(reconcileTimer)
    reconcileTimer = null
    if (unsubscribeHostEvents) unsubscribeHostEvents()
    if (unsubscribePeerDisconnect) unsubscribePeerDisconnect()
    listeners.clear()
    monitors.clear()
  }

  return {
    supervise,
    link,
    unlink,
    monitor,
    unsupervise,
    drain,
    list,
    stop,
    on,
  }
}
