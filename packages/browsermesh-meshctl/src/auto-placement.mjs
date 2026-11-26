/**
 * auto-placement.mjs — `pods spawn auto`'s host selection.
 *
 * `auto` means "ask the mesh's own placement scorer", not "pick the first
 * host that answers". `MeshOrchestrator#selectComputeTarget()`
 * (`browsermesh-apps/src/orchestrator.mjs`) already does exactly this scoring
 * — it just needs a `runtimeRegistry` (duck-typed: `{listPeers()}`) to read
 * candidates from. This module builds that registry CHEAPLY, from
 * `describe()` calls `meshctl` was going to need anyway (to print
 * `meshctl hosts`), rather than standing up anything that watches the mesh
 * continuously.
 *
 * An isolate-lane host has no `exec`, so it is not a compute candidate; it
 * is scored here by asking the orchestrator to include spawn hosts
 * (`includeSpawnHosts`), which never makes it a target for a shell. Manual
 * matching of `describe().lane === lane` remains as the fallback whenever
 * the orchestrator comes back empty or picks a host whose lane doesn't
 * actually match — "orchestrator scoring when cheaply reachable, else lane
 * matching" from the design doc.
 */

import { MeshOrchestrator, podHostRuntimePeer, decidePlacement } from '@johnhenry/browsermesh-apps'
import { PodHostDriverError, POD_HOST_ERROR } from '@johnhenry/browsermesh-pod'

/**
 * @typedef {object} AutoCandidate
 * @property {string} podId
 * @property {string} ref - The `<host>` reference the caller resolved this from.
 * @property {import('@johnhenry/browsermesh-apps').PodHostDescription} description
 */

/**
 * Describe every candidate host (connecting first, where the session
 * requires it), tolerating unreachable ones rather than failing the whole
 * selection for one bad host.
 *
 * @param {import('./connect.mjs').MeshctlSession} session
 * @param {string[]} refs - `<host>` references (pubKeys, or loopback labels).
 * @returns {Promise<AutoCandidate[]>}
 */
async function describeCandidates(session, refs) {
  /** @type {AutoCandidate[]} */
  const candidates = []
  for (const ref of refs) {
    const resolved = session.resolveHost(ref)
    const podId = resolved ? resolved.podId : ref
    try {
      await session.ensureConnected(podId)
      const description = await session.client.describe(podId)
      candidates.push({ podId, ref, description })
    } catch {
      // Unreachable/non-responsive candidate -- skip it, don't fail the
      // whole auto-selection for one bad host in the list.
    }
  }
  return candidates
}

/**
 * Choose a host with the placement planner (`planPlacement()`), for a
 * requester whose trust is read from this CLI's trust graph
 * (`session.peerNode.registry`). Used only when a placement flag
 * (`--requester`, `--min-boundary`) is given; `selectAutoHost()` is
 * unchanged for everyone else. A host that states no boundary counts as
 * `none`, and an untrusted requester (the default) is only placed behind a
 * `language` or `hardware` one. One-shot CLI: there is no running pod count
 * to enforce a per-requester quota against, so none is offered here.
 *
 * @param {object} opts
 * @param {import('./connect.mjs').MeshctlSession} opts.session
 * @param {string[]} opts.candidateRefs
 * @param {object} opts.spec - A normalized podspec.
 * @param {string} [opts.requesterId]
 * @param {string} [opts.minBoundary]
 * @param {object} [opts.policy] - More planner policy (`avoidHosts`, `preferHost`), as a supervisor's re-placement asks.
 * @returns {Promise<{podId: string, description: object, via: 'planner', placement: object}>}
 */
export async function selectPlannedHost({ session, candidateRefs, spec, requesterId, minBoundary, policy = {} }) {
  const candidates = await describeCandidates(session, candidateRefs)
  if (candidates.length === 0) {
    throw new PodHostDriverError(
      POD_HOST_ERROR.ENOENT,
      'pods spawn auto: no known hosts answered describe() -- pass --host <pubKey> at least once, '
      + 'or use --loopback, which creates its own hosts',
    )
  }
  const decision = decidePlacement({
    spec,
    // The candidate's `podId` is the ref it was connected under; `description.podId` is its own claim.
    hosts: candidates.map((c) => ({ ...c.description, podId: c.podId })),
    requesterId,
    registry: session.peerNode?.registry,
    localPodId: session.podId,
    policy: { ...policy, ...(minBoundary ? { minBoundary } : {}) },
  })
  if (!decision.plan.ok) throw decision.error
  const picked = candidates.find((c) => c.podId === decision.plan.host.id)
  return { podId: picked.podId, description: picked.description, via: 'planner', placement: decision.audit }
}

/**
 * Pick a host offering `lane`, preferring the orchestrator's compute
 * scoring and falling back to a direct `describe().lane` match.
 *
 * @param {object} opts
 * @param {import('./connect.mjs').MeshctlSession} opts.session
 * @param {string[]} opts.candidateRefs - `<host>` references to consider.
 * @param {string} opts.lane - A `POD_LANE` value the spawned pod needs.
 * @returns {Promise<{podId: string, description: object, via: 'orchestrator'|'lane-match'}>}
 */
export async function selectAutoHost({ session, candidateRefs, lane }) {
  const candidates = await describeCandidates(session, candidateRefs)
  if (candidates.length === 0) {
    throw new PodHostDriverError(
      POD_HOST_ERROR.ENOENT,
      'pods spawn auto: no known hosts answered describe() -- pass --host <pubKey> at least once, '
      + 'or use --loopback, which creates its own hosts',
    )
  }

  // -- Orchestrator compute scoring, when cheaply reachable ----------------
  // "Cheaply reachable" here means: built entirely from the describe()
  // calls above, no extra round trips, and the orchestrator itself is
  // disposable (constructed fresh, used once, discarded).
  try {
    const peers = candidates.map((c) => podHostRuntimePeer(c.description))
    const orchestrator = new MeshOrchestrator({
      peerNode: session.peerNode,
      runtimeRegistry: { listPeers: () => peers },
    })
    const selection = orchestrator.selectComputeTarget({
      constraints: { preferRuntimeClass: lane },
      includeSpawnHosts: true,
    })
    const picked = candidates.find((c) => c.description.podId === selection.podId)
    if (picked && picked.description.lane === lane) {
      return { podId: picked.podId, description: picked.description, via: 'orchestrator' }
    }
  } catch {
    // No candidate at all, or none the scorer rates above zero for this
    // request -- fall through to the manual match below.
  }

  // -- Fallback: direct describe().lane match -------------------------------
  const manual = candidates.find((c) => c.description.lane === lane)
  if (manual) return { podId: manual.podId, description: manual.description, via: 'lane-match' }

  throw new PodHostDriverError(
    POD_HOST_ERROR.ENOENT,
    `pods spawn auto: no known host offers lane '${lane}' (checked ${candidates.length})`,
    { lane, checked: candidates.map((c) => c.ref) },
  )
}
