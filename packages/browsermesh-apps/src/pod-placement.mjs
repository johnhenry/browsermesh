/**
 * pod-placement.mjs -- which host a hosted pod goes to (issue #185 §6), as
 * pure, deterministic logic plus a small pool that applies it to lane
 * drivers.
 *
 * Nothing in here reads a clock or starts a timer: time is a number the
 * caller passes (`now`), and "wait this long before restarting" is a number
 * the caller schedules. That is what makes every rule below unit-testable
 * with fake lane drivers (`InMemoryPodHostDriver`) and no sleeps.
 *
 * Layers:
 *
 *   - `planPlacement()`   the hard rules (lane, verb, health, boundary,
 *                         capability, admission limits, quota) and the
 *                         ranking among the hosts that pass. Pure function.
 *   - `HostHealth`        a circuit breaker per host: healthy, degraded,
 *                         unhealthy (cooling down), probing (one try).
 *   - `PlacementLedger`   what is reserved on each host and per requester.
 *   - `createHostPool()`  planner + ledger + health + `PodHostDriver`s:
 *                         `spawn`, `drain`, `drainHost`, `handleExit`.
 *
 * The rule from `pod-host-service.mjs` still holds: the orchestrator
 * PROPOSES, the host ACCEPTS. A host's refusal (`EACCES`, `EBUSY`, ...) is
 * final for that spawn; only a transport-level failure (`ETIMEDOUT`) can
 * move a spawn to the next host, and only when `maxAttempts` > 1 (default 1).
 *
 * ISOLATION BOUNDARY. A host states how strongly it separates a pod from
 * itself (`BOUNDARY`): a `worker_threads` pod is `none` (same process, no
 * boundary), a permission-restricted child process is `process`, a V8
 * isolate in its own process is `language`, a microVM is `hardware`. An
 * untrusted requester (the default) is only placed behind `language` or
 * `hardware`. Nothing here establishes a boundary; it only refuses to place
 * untrusted work where a host says there is none.
 */

import {
  POD_HOST_ERROR,
  POD_HOST_VERB,
  POD_LANE_VERBS,
  PodHostDriverError,
  validatePodSpec,
} from '@johnhenry/browsermesh-pod'
import { decideRestart } from './restart-policy.mjs'

/** How strongly a host separates a hosted pod from the host. Ordered weakest to strongest. */
export const BOUNDARY = Object.freeze({
  NONE: 'none',
  PROCESS: 'process',
  LANGUAGE: 'language',
  HARDWARE: 'hardware',
})

const BOUNDARY_RANK = Object.freeze({ none: 0, process: 1, language: 2, hardware: 3 })

/** Whether the requester's code is trusted by the host operator. */
export const TRUST = Object.freeze({
  TRUSTED: 'trusted',
  UNTRUSTED: 'untrusted',
})

/** Charged to a pod that states no limits. */
const DEFAULT_LIMITS = Object.freeze({ vcpus: 1, memMib: 128 })

/** @param {*} value @returns {number} */
function boundaryRank(value) {
  return BOUNDARY_RANK[value] ?? 0
}

/**
 * @typedef {object} PlacementHost
 * @property {string} id
 * @property {string} lane - A `POD_LANE` value.
 * @property {string} [boundary] - A `BOUNDARY` value; absent means `none`.
 * @property {string[]} [verbs] - Verbs served; defaults to the lane's.
 * @property {string[]} [caps] - Kernel capabilities the host can grant (podspec `caps`).
 * @property {{pods?: number, vcpus?: number, memMib?: number}} [capacity] - Absent dimension = unlimited.
 * @property {'healthy'|'degraded'|'probing'|'unhealthy'|'draining'} [health]
 */

/**
 * @typedef {object} PlacementPolicy
 * @property {string} [minBoundary] - Floor for every requester.
 * @property {{vcpus?: number, memMib?: number}} [defaultLimits]
 * @property {number} [perRequesterMaxPods]
 * @property {string[]} [avoidHosts]
 * @property {string} [preferHost]
 */

/**
 * Decide where a podspec may go and in what order of preference.
 *
 * @param {object} input
 * @param {object} input.spec - A podspec (validated here).
 * @param {PlacementHost[]} input.hosts
 * @param {{id?: string, trust?: string}} [input.requester] - Default: untrusted.
 * @param {Map<string, {pods: number, vcpus: number, memMib: number}>} [input.usage] - Reserved per host.
 * @param {Map<string, {pods: number}>} [input.requesterUsage]
 * @param {PlacementPolicy} [input.policy]
 * @returns {{ok: true, host: PlacementHost, ranked: Array<{id: string, score: number, host: PlacementHost}>, rejected: Array<{id: string, code: string, reason: string}>}
 *   | {ok: false, code: string, ranked: [], rejected: Array<{id: string, code: string, reason: string}>}}
 */
export function planPlacement({
  spec, hosts = [], requester = {}, usage = new Map(), requesterUsage = new Map(), policy = {},
} = {}) {
  const validated = validatePodSpec(spec)
  if (!validated.ok) {
    return { ok: false, code: 'invalid-spec', ranked: [], rejected: [], errors: validated.errors }
  }
  const pod = validated.value

  if (!Array.isArray(hosts) || hosts.length === 0) {
    return { ok: false, code: 'no-hosts', ranked: [], rejected: [] }
  }

  const requesterId = requester.id ?? null
  if (policy.perRequesterMaxPods !== undefined && requesterId !== null) {
    const held = requesterUsage.get(requesterId)?.pods ?? 0
    if (held >= policy.perRequesterMaxPods) {
      return { ok: false, code: 'quota', ranked: [], rejected: [] }
    }
  }

  const trusted = requester.trust === TRUST.TRUSTED
  const floor = Math.max(
    boundaryRank(policy.minBoundary),
    trusted ? BOUNDARY_RANK.none : BOUNDARY_RANK.language,
  )
  const charge = {
    vcpus: pod.limits?.vcpus ?? policy.defaultLimits?.vcpus ?? DEFAULT_LIMITS.vcpus,
    memMib: pod.limits?.memMib ?? policy.defaultLimits?.memMib ?? DEFAULT_LIMITS.memMib,
  }
  const avoid = new Set(policy.avoidHosts ?? [])

  /** @type {Array<{id: string, code: string, reason: string}>} */
  const rejected = []
  /** @type {Array<{id: string, score: number, host: PlacementHost}>} */
  const ranked = []

  for (const host of hosts) {
    /** @param {string} code @param {string} reason */
    const reject = (code, reason) => { rejected.push({ id: host.id, code, reason }) }

    if (host.lane !== pod.lane) {
      reject('lane', `host runs lane '${host.lane}', pod needs '${pod.lane}'`)
      continue
    }
    const verbs = host.verbs ?? POD_LANE_VERBS[host.lane] ?? []
    if (!verbs.includes(POD_HOST_VERB.SPAWN)) {
      reject('verb', "host does not serve 'spawn'")
      continue
    }
    if (host.health === 'draining') {
      reject('draining', 'host is draining')
      continue
    }
    if (host.health === 'unhealthy') {
      reject('health', 'host is unhealthy')
      continue
    }
    if (avoid.has(host.id)) {
      reject('avoided', 'host is excluded for this placement')
      continue
    }
    if (boundaryRank(host.boundary) < floor) {
      reject('boundary', `host boundary '${host.boundary ?? BOUNDARY.NONE}' is below the required '${Object.keys(BOUNDARY_RANK).find((k) => BOUNDARY_RANK[k] === floor)}'`)
      continue
    }
    const missing = (pod.caps ?? []).filter((cap) => !(host.caps ?? []).includes(cap))
    if (missing.length > 0) {
      reject('caps', `host cannot grant: ${missing.join(', ')}`)
      continue
    }

    const used = usage.get(host.id) ?? { pods: 0, vcpus: 0, memMib: 0 }
    const cap = host.capacity ?? {}
    if (cap.pods !== undefined && used.pods + 1 > cap.pods) {
      reject('capacity', `host is at its limit of ${cap.pods} pods`)
      continue
    }
    if (cap.vcpus !== undefined && used.vcpus + charge.vcpus > cap.vcpus) {
      reject('capacity', `host has ${Math.max(0, cap.vcpus - used.vcpus)} vcpus free, pod needs ${charge.vcpus}`)
      continue
    }
    if (cap.memMib !== undefined && used.memMib + charge.memMib > cap.memMib) {
      reject('capacity', `host has ${Math.max(0, cap.memMib - used.memMib)} MiB free, pod needs ${charge.memMib}`)
      continue
    }

    // -- score -------------------------------------------------------------
    let score = 100
    if (host.health === 'degraded') score -= 30
    else if (host.health === 'probing') score -= 60

    /** @type {number[]} */
    const freeFractions = []
    if (cap.pods !== undefined && cap.pods > 0) freeFractions.push(1 - (used.pods + 1) / cap.pods)
    if (cap.vcpus !== undefined && cap.vcpus > 0) freeFractions.push(1 - (used.vcpus + charge.vcpus) / cap.vcpus)
    if (cap.memMib !== undefined && cap.memMib > 0) freeFractions.push(1 - (used.memMib + charge.memMib) / cap.memMib)
    const free = freeFractions.length === 0 ? 1 : freeFractions.reduce((a, b) => a + b, 0) / freeFractions.length
    score += 40 * free
    if (policy.preferHost === host.id) score += 15

    ranked.push({ id: host.id, score, host })
  }

  ranked.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  if (ranked.length === 0) return { ok: false, code: 'no-eligible-host', ranked: [], rejected }
  return { ok: true, host: ranked[0].host, ranked, rejected }
}

// ---------------------------------------------------------------------------
// HostHealth
// ---------------------------------------------------------------------------

/**
 * A circuit breaker per host. `now` is always passed in.
 *
 *   healthy    no failures since the last success
 *   degraded   some failures, below the threshold: still eligible, ranks lower
 *   unhealthy  threshold reached: not eligible until the cooldown passes
 *   probing    cooldown passed: eligible (ranks last) for one try; a success
 *              restores it, a failure doubles the cooldown (up to the cap)
 */
export class HostHealth {
  #failureThreshold
  #cooldownMs
  #maxCooldownMs
  /** @type {Map<string, {failures: number, trips: number, openedAt: number|null}>} */
  #records = new Map()

  /**
   * @param {object} [opts]
   * @param {number} [opts.failureThreshold=3]
   * @param {number} [opts.cooldownMs=30000]
   * @param {number} [opts.maxCooldownMs=300000]
   */
  constructor({ failureThreshold = 3, cooldownMs = 30_000, maxCooldownMs = 300_000 } = {}) {
    this.#failureThreshold = failureThreshold
    this.#cooldownMs = cooldownMs
    this.#maxCooldownMs = maxCooldownMs
  }

  /** @param {{trips: number}} record @returns {number} */
  #cooldown(record) {
    return Math.min(this.#cooldownMs * (2 ** record.trips), this.#maxCooldownMs)
  }

  /** @param {string} id @param {number} now */
  recordFailure(id, now) {
    const record = this.#records.get(id) ?? { failures: 0, trips: 0, openedAt: null }
    record.failures += 1
    if (record.failures >= this.#failureThreshold) {
      if (record.openedAt === null) {
        record.openedAt = now
      } else if (now >= record.openedAt + this.#cooldown(record)) {
        // A failure after the cooldown is a failed probe.
        record.trips += 1
        record.openedAt = now
      }
    }
    this.#records.set(id, record)
  }

  /** @param {string} id @param {number} _now */
  recordSuccess(id, _now) {
    this.#records.delete(id)
  }

  /**
   * @param {string} id
   * @param {number} now
   * @returns {'healthy'|'degraded'|'unhealthy'|'probing'}
   */
  state(id, now) {
    const record = this.#records.get(id)
    if (!record || record.failures === 0) return 'healthy'
    if (record.openedAt === null) return 'degraded'
    return now >= record.openedAt + this.#cooldown(record) ? 'probing' : 'unhealthy'
  }

  /** @param {number} now @returns {Record<string, string>} Every host that is not healthy. */
  snapshot(now) {
    /** @type {Record<string, string>} */
    const out = {}
    for (const id of this.#records.keys()) {
      const state = this.state(id, now)
      if (state !== 'healthy') out[id] = state
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// PlacementLedger
// ---------------------------------------------------------------------------

/** What is reserved on each host and by each requester. */
export class PlacementLedger {
  /** @type {Map<string, {hostId: string, name: string, requesterId: string|null, vcpus: number, memMib: number}>} */
  #entries = new Map()

  /**
   * @param {{hostId: string, name: string, requesterId?: string|null, limits: {vcpus: number, memMib: number}}} entry
   */
  reserve({ hostId, name, requesterId = null, limits }) {
    const key = `${hostId}\0${name}`
    if (this.#entries.has(key)) throw new Error(`'${name}' is already reserved on host '${hostId}'`)
    this.#entries.set(key, { hostId, name, requesterId, vcpus: limits.vcpus, memMib: limits.memMib })
  }

  /** @param {string} hostId @param {string} name */
  release(hostId, name) {
    this.#entries.delete(`${hostId}\0${name}`)
  }

  /** @returns {Map<string, {pods: number, vcpus: number, memMib: number}>} */
  usage() {
    /** @type {Map<string, {pods: number, vcpus: number, memMib: number}>} */
    const out = new Map()
    for (const entry of this.#entries.values()) {
      const used = out.get(entry.hostId) ?? { pods: 0, vcpus: 0, memMib: 0 }
      used.pods += 1
      used.vcpus += entry.vcpus
      used.memMib += entry.memMib
      out.set(entry.hostId, used)
    }
    return out
  }

  /** @returns {Map<string, {pods: number}>} */
  requesterUsage() {
    /** @type {Map<string, {pods: number}>} */
    const out = new Map()
    for (const entry of this.#entries.values()) {
      if (entry.requesterId === null) continue
      const used = out.get(entry.requesterId) ?? { pods: 0 }
      used.pods += 1
      out.set(entry.requesterId, used)
    }
    return out
  }
}

// ---------------------------------------------------------------------------
// createHostPool
// ---------------------------------------------------------------------------

/** Rejection codes that mean "not now" rather than "never". */
const TRANSIENT = new Set(['capacity', 'health', 'draining', 'avoided'])

/**
 * The `PodHostDriverError` a failed plan becomes.
 * @param {ReturnType<typeof planPlacement>} plan
 * @returns {PodHostDriverError}
 */
function planError(plan) {
  const details = { rejected: plan.rejected, plan: plan.code }
  switch (plan.code) {
    case 'invalid-spec':
      return new PodHostDriverError(POD_HOST_ERROR.EINVAL, (plan.errors ?? []).join('; ') || 'invalid podspec', details)
    case 'quota':
      return new PodHostDriverError(POD_HOST_ERROR.EACCES, 'requester is at its pod quota', details)
    case 'no-hosts':
      return new PodHostDriverError(POD_HOST_ERROR.ENOENT, 'no pod hosts are configured', details)
    default: {
      const codes = plan.rejected.map((r) => r.code)
      if (codes.every((c) => c === 'lane' || c === 'verb')) {
        return new PodHostDriverError(POD_HOST_ERROR.ELANE, 'no host serves this pod\'s lane', details)
      }
      if (codes.some((c) => TRANSIENT.has(c))) {
        return new PodHostDriverError(POD_HOST_ERROR.EBUSY, 'no eligible host has room right now', details)
      }
      return new PodHostDriverError(POD_HOST_ERROR.EACCES, 'no host may take this pod', details)
    }
  }
}

/**
 * @typedef {object} PoolHost
 * @property {string} id
 * @property {import('@johnhenry/browsermesh-pod').PodHostDriver} driver
 * @property {string} [boundary]
 * @property {string[]} [caps]
 * @property {{pods?: number, vcpus?: number, memMib?: number}} [capacity]
 */

/**
 * Apply the planner to a set of lane drivers.
 *
 * @param {object} opts
 * @param {PoolHost[]} opts.hosts - `lane` and `verbs` come from each driver.
 * @param {PlacementPolicy} [opts.policy]
 * @param {() => number} [opts.now=Date.now]
 * @param {HostHealth} [opts.health]
 * @param {number} [opts.maxAttempts=1] - Hosts one spawn may try; only a
 *   transport-level failure moves it to the next.
 * @param {string[]} [opts.failoverCodes=['ETIMEDOUT']]
 */
export function createHostPool({
  hosts, policy = {}, now = Date.now, health = new HostHealth(), maxAttempts = 1,
  failoverCodes = [POD_HOST_ERROR.ETIMEDOUT],
} = {}) {
  if (!Array.isArray(hosts) || hosts.length === 0) throw new Error('createHostPool: hosts are required')
  /** @type {Map<string, PoolHost>} */
  const byId = new Map()
  for (const host of hosts) {
    if (!host?.id || typeof host.driver?.spawn !== 'function') throw new Error('createHostPool: every host needs an id and a driver')
    if (byId.has(host.id)) throw new Error(`createHostPool: duplicate host id '${host.id}'`)
    byId.set(host.id, host)
  }
  const ledger = new PlacementLedger()
  const draining = new Set()
  /** @type {Map<string, {hostId: string, spec: object, requester: object, restarts: number}>} */
  const pods = new Map()

  /** @returns {PlacementHost[]} */
  function placementHosts() {
    const t = now()
    return [...byId.values()].map((host) => ({
      id: host.id,
      lane: host.driver.lane,
      boundary: host.boundary,
      verbs: host.driver.capabilities?.().verbs,
      caps: host.caps,
      capacity: host.capacity,
      health: draining.has(host.id) ? 'draining' : health.state(host.id, t),
    }))
  }

  /** @param {object} spec @returns {{vcpus: number, memMib: number}} */
  function chargeOf(spec) {
    return {
      vcpus: spec.limits?.vcpus ?? policy.defaultLimits?.vcpus ?? DEFAULT_LIMITS.vcpus,
      memMib: spec.limits?.memMib ?? policy.defaultLimits?.memMib ?? DEFAULT_LIMITS.memMib,
    }
  }

  /**
   * @param {object} specIn
   * @param {object} opts
   */
  async function place(specIn, { requester = {}, avoidHosts = [], restarts = 0 } = {}) {
    const validated = validatePodSpec(specIn)
    if (!validated.ok) throw planError({ ok: false, code: 'invalid-spec', ranked: [], rejected: [], errors: validated.errors })
    const spec = validated.value
    if (pods.has(spec.name)) {
      throw new PodHostDriverError(POD_HOST_ERROR.EEXIST, `pod '${spec.name}' already exists`, { name: spec.name })
    }

    /** @type {Array<{hostId: string, outcome: string}>} */
    const attempts = []
    const avoid = new Set([...(policy.avoidHosts ?? []), ...avoidHosts])
    /** @type {PodHostDriverError|null} */
    let last = null
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const plan = planPlacement({
        spec,
        hosts: placementHosts(),
        requester,
        usage: ledger.usage(),
        requesterUsage: ledger.requesterUsage(),
        policy: { ...policy, avoidHosts: [...avoid] },
      })
      if (!plan.ok) throw last ?? planError(plan)

      const target = plan.host
      // Reserved BEFORE the driver runs, so a second spawn that starts while
      // this one is in flight already sees the capacity as taken.
      ledger.reserve({ hostId: target.id, name: spec.name, requesterId: requester.id ?? null, limits: chargeOf(spec) })
      try {
        const status = await byId.get(target.id).driver.spawn(spec)
        health.recordSuccess(target.id, now())
        attempts.push({ hostId: target.id, outcome: 'ok' })
        pods.set(spec.name, { hostId: target.id, spec, requester, restarts })
        return { hostId: target.id, status, attempts }
      } catch (err) {
        ledger.release(target.id, spec.name)
        const error = PodHostDriverError.from(err)
        attempts.push({ hostId: target.id, outcome: error.code })
        if (error.code === POD_HOST_ERROR.ETIMEDOUT || !(err instanceof PodHostDriverError)) {
          health.recordFailure(target.id, now())
        }
        if (!failoverCodes.includes(error.code)) throw error
        avoid.add(target.id)
        last = error
      }
    }
    throw last
  }

  return {
    /**
     * @param {object} spec
     * @param {{requester?: {id?: string, trust?: string}}} [opts]
     */
    spawn(spec, { requester = {} } = {}) {
      return place(spec, { requester })
    },

    /** @param {string} name */
    async drain(name) {
      const entry = pods.get(name)
      if (!entry) throw new PodHostDriverError(POD_HOST_ERROR.ENOENT, `no pod named '${name}'`, { name })
      const status = await byId.get(entry.hostId).driver.drain(name)
      ledger.release(entry.hostId, name)
      pods.delete(name)
      return status
    },

    /**
     * Stop placing on a host, and move its pods elsewhere (or drain them).
     * A pod that cannot be re-placed is left running and reported: draining a
     * host never silently loses one.
     *
     * @param {string} hostId
     * @param {{replace?: boolean}} [opts]
     */
    async drainHost(hostId, { replace = true } = {}) {
      if (!byId.has(hostId)) throw new PodHostDriverError(POD_HOST_ERROR.ENOENT, `no host '${hostId}'`, { hostId })
      draining.add(hostId)
      /** @type {Array<{name: string, from: string, to: string}>} */
      const moved = []
      /** @type {Array<{name: string, from: string, code: string, message: string}>} */
      const failed = []
      for (const [name, entry] of [...pods]) {
        if (entry.hostId !== hostId) continue
        if (!replace) {
          await byId.get(hostId).driver.drain(name)
          ledger.release(hostId, name)
          pods.delete(name)
          continue
        }
        try {
          // Make before break: the new pod is up before the old one stops.
          pods.delete(name)
          const placed = await place(entry.spec, { requester: entry.requester, avoidHosts: [hostId], restarts: entry.restarts })
          await byId.get(hostId).driver.drain(name)
          ledger.release(hostId, name)
          moved.push({ name, from: hostId, to: placed.hostId })
        } catch (err) {
          pods.set(name, entry)
          const error = PodHostDriverError.from(err)
          failed.push({ name, from: hostId, code: error.code, message: error.message })
        }
      }
      return { moved, failed }
    },

    /**
     * What to do about a pod that exited. Releases its reservation, applies
     * the shared restart policy and returns the decision; the caller
     * schedules `delayMs` and then calls `run()`, which re-places the pod
     * on a host other than the one that failed.
     *
     * @param {{hostId: string, name: string, exit: {code?: number, reason?: string}}} event
     */
    handleExit({ hostId, name, exit }) {
      const entry = pods.get(name)
      if (!entry || entry.hostId !== hostId) return { restart: false, why: 'unknown' }
      ledger.release(hostId, name)
      pods.delete(name)
      const decision = decideRestart({ restart: entry.spec.restart, exit, restartsSoFar: entry.restarts })
      if (!decision.restart) return decision
      return {
        ...decision,
        avoidHosts: [hostId],
        run: () => place(entry.spec, { requester: entry.requester, avoidHosts: [hostId], restarts: entry.restarts + 1 }),
      }
    },

    usage: () => ledger.usage(),
    requesterUsage: () => ledger.requesterUsage(),
    /** @returns {Record<string, string>} Every host that is not healthy, plus draining ones. */
    health() {
      const out = health.snapshot(now())
      for (const id of draining) out[id] = 'draining'
      return out
    },
    /** @returns {Array<{name: string, hostId: string}>} */
    pods: () => [...pods].map(([name, entry]) => ({ name, hostId: entry.hostId })),
  }
}
