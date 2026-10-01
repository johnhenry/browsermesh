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
 * `podHostRuntimePeer()` (`browsermesh-apps/src/pod-host-service.mjs`)
 * already documents a real limitation this inherits unchanged: an
 * isolate-lane host has no `exec`, so `runtimePeerToComputeDescriptor()`
 * never derives a `compute` capability for it and the orchestrator's
 * scorer always sees zero isolate candidates. That's WHY this falls back
 * to manually matching `describe().lane === lane` whenever the orchestrator
 * comes back empty or picks a host whose lane doesn't actually match —
 * "orchestrator scoring when cheaply reachable, else lane matching" from
 * the design doc, made concrete.
 */

import { MeshOrchestrator, podHostRuntimePeer } from '@johnhenry/browsermesh-apps'
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
    const selection = orchestrator.selectComputeTarget({ constraints: { preferRuntimeClass: lane } })
    const picked = candidates.find((c) => c.description.podId === selection.podId)
    if (picked && picked.description.lane === lane) {
      return { podId: picked.podId, description: picked.description, via: 'orchestrator' }
    }
  } catch {
    // No compute-capable candidate at all (e.g. every candidate is an
    // isolate host, which never advertises `compute` -- see this module's
    // header) -- fall through to the manual match below.
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
