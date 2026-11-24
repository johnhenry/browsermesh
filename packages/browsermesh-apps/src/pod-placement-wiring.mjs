/**
 * pod-placement-wiring.mjs -- the glue between the pure placement planner
 * (`pod-placement.mjs`) and the callers that choose hosts for a requester:
 * `MeshOrchestrator#placePod()`, the `meshctl_spawn` tool and the `meshctl`
 * CLI. One function decides; each caller records the audit data and does the
 * spawn.
 *
 * Trust. A requester's trust is read from the local operator's trust graph
 * (`PeerRegistry#getTrust(pubKey)`, a value in [0, 1] that already follows
 * transitive edges). The requester is `trusted` only when that value is a
 * finite number at or above `threshold` (`DEFAULT_TRUST_THRESHOLD`), or is
 * the local pod itself. No requester, no registry, a value that is missing,
 * not a number or outside [0, 1], or a registry that throws, all mean
 * `untrusted`, which the planner places only behind a language or hardware
 * boundary. Nothing here lets a caller state its own trust.
 *
 * Budgets. A podspec's `budget` is checked BEFORE any host is looked at, by
 * the `budgetCheck` the caller wired in; a podspec that states a budget when
 * no check is wired is refused, because a limit nothing can verify is not a
 * limit. Nothing is debited here.
 */

import { TRUST, planPlacement, planError } from './pod-placement.mjs'

/** The trust value at or above which a requester counts as trusted. */
export const DEFAULT_TRUST_THRESHOLD = 0.8

/**
 * @param {object} opts
 * @param {string} [opts.requesterId]
 * @param {{getTrust?: (id: string) => number}} [opts.registry]
 * @param {string} [opts.localPodId]
 * @param {number} [opts.threshold]
 * @returns {{id: string|null, trust: 'trusted'|'untrusted', level: number|null, source: string}}
 */
export function resolveRequesterTrust({ requesterId, registry, localPodId, threshold = DEFAULT_TRUST_THRESHOLD } = {}) {
  if (typeof requesterId !== 'string' || requesterId === '') {
    return { id: null, trust: TRUST.UNTRUSTED, level: null, source: 'no requester stated' }
  }
  if (localPodId !== undefined && requesterId === localPodId) {
    return { id: requesterId, trust: TRUST.TRUSTED, level: null, source: 'the local pod' }
  }
  if (typeof registry?.getTrust !== 'function') {
    return { id: requesterId, trust: TRUST.UNTRUSTED, level: null, source: 'no trust graph' }
  }
  let level
  try {
    level = registry.getTrust(requesterId)
  } catch {
    level = undefined
  }
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 0 || level > 1) {
    return { id: requesterId, trust: TRUST.UNTRUSTED, level: null, source: 'no usable trust value' }
  }
  return {
    id: requesterId,
    trust: level >= threshold ? TRUST.TRUSTED : TRUST.UNTRUSTED,
    level,
    source: 'trust graph',
  }
}

/**
 * @param {object} description - A `listPodHosts()` entry or a host's `describe()` result.
 * @returns {import('./pod-placement.mjs').PlacementHost}
 */
function toPlacementHost(description) {
  const id = description.podId
  return {
    id,
    lane: description.lane,
    boundary: typeof description.boundary === 'string' ? description.boundary : undefined,
    verbs: description.verbs,
    ...(description.capacity ? { capacity: description.capacity } : {}),
    ...(description.health ? { health: description.health } : {}),
  }
}

/**
 * Decide where a podspec may go.
 *
 * @param {object} input
 * @param {object} input.spec
 * @param {object[]} input.hosts - `{podId, lane, boundary?, verbs?, capacity?, health?}`.
 * @param {string} [input.requesterId]
 * @param {{getTrust?: Function}} [input.registry]
 * @param {string} [input.localPodId]
 * @param {number} [input.trustThreshold]
 * @param {import('./pod-placement.mjs').PlacementPolicy} [input.policy]
 * @param {Map<string, object>} [input.usage]
 * @param {Map<string, {pods: number}>} [input.requesterUsage]
 * @param {(request: {requesterId: string|null, budget: object, spec: object}) => boolean|{allowed: boolean, reason?: string}} [input.budgetCheck]
 * @returns {{plan: object, requester: object, error: Error|null, audit: object}}
 */
export function decidePlacement({
  spec, hosts = [], requesterId, registry, localPodId, trustThreshold, policy = {}, usage, requesterUsage, budgetCheck,
} = {}) {
  const requester = resolveRequesterTrust({ requesterId, registry, localPodId, threshold: trustThreshold })

  /** @type {object} */
  let plan
  if (spec?.budget !== undefined) {
    let verdict
    if (typeof budgetCheck !== 'function') {
      verdict = { allowed: false, reason: 'the podspec states a budget and no budget check is configured' }
    } else {
      try {
        const raw = budgetCheck({ requesterId: requester.id, budget: spec.budget, spec })
        verdict = typeof raw === 'object' && raw !== null ? raw : { allowed: raw === true }
      } catch (err) {
        verdict = { allowed: false, reason: `the budget check failed: ${err?.message || String(err)}` }
      }
    }
    if (!verdict.allowed) {
      plan = { ok: false, code: 'budget', ranked: [], rejected: [], reason: verdict.reason ?? 'the budget check said no' }
    }
  }
  plan ??= planPlacement({
    spec,
    hosts: hosts.map(toPlacementHost),
    requester: { id: requester.id ?? undefined, trust: requester.trust },
    usage,
    requesterUsage,
    policy,
  })

  const error = plan.ok ? null : planError(plan)
  const audit = {
    phase: 'decision',
    name: spec?.name ?? null,
    lane: spec?.lane ?? null,
    requesterId: requester.id,
    trust: requester.trust,
    trustLevel: requester.level,
    trustSource: requester.source,
    minBoundary: policy.minBoundary ?? null,
    ok: plan.ok,
    code: plan.ok ? null : plan.code,
    chosen: plan.ok ? plan.host.id : null,
    ranked: plan.ranked.map((r) => ({ id: r.id, score: r.score })),
    rejected: plan.rejected.map((r) => ({ id: r.id, code: r.code })),
  }
  return { plan, requester, error, audit }
}
