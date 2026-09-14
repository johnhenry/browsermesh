/**
 * serverless-sites.mjs -- Phase 5 of the BrowserMesh Serverless plan
 * (`/Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md`):
 * `SiteRegistry`, tracking which connected peers can serve a given site and
 * picking one per request via `serverless-peer-select.mjs`'s `selectPeer()`.
 *
 * ---------------------------------------------------------------------------
 * ADMIN-DESIGNATED, NEVER AUTO-DISCOVERED -- a deliberate design choice, not
 * a missing feature. Mirrors `CloudStorage`'s own `replicaPeers`/
 * `designateReplica()` precedent (that file's own module doc comment,
 * point 6): a site's operator explicitly calls `registerSitePeer(siteId,
 * podId)` for each peer they've deployed the site to, the same way a
 * `CloudStorage` bucket's replica set is explicit, not auto-scaled.
 * Discovery-based auto-population (advertising `serves:<siteId>` as a
 * `DiscoveryRecord.capabilities` tag, per the plan doc's own "Design
 * decisions" section) is a real, low-effort future enhancement,
 * deliberately deferred -- not required for this phase, and not silently
 * assumed to already exist.
 *
 * `selectPeer(siteId)` only ever returns a peer that BOTH (a) was
 * explicitly registered for `siteId` and (b) is CURRENTLY connected per
 * `peerNode.listPeers({status: 'connected'})` -- a registered-but-
 * currently-disconnected peer is never selected, without needing an
 * explicit `unregisterSitePeer()` call for a transient disconnect.
 *
 * @module serverless-sites
 */

import { selectPeer as selectPeerFromCandidates } from './serverless-peer-select.mjs'

export class SiteRegistry {
  /** @type {Map<string, Set<string>>} siteId -> Set<podId> */
  #sites = new Map()
  /** @type {Map<string, {rrIndex?: number}>} siteId -> selectPeer()'s round-robin cursor state */
  #selectState = new Map()
  #peerNode
  #policy
  #getLoad

  /**
   * @param {object} opts
   * @param {import('./peer-node.mjs').PeerNode} opts.peerNode - duck-typed: needs `listPeers({status}) -> PeerState[]` (`{fingerprint, status, ...}`, `@johnhenry/browsermesh-core`'s shape).
   * @param {import('./serverless-peer-select.mjs').PeerSelectPolicy} [opts.policy='round-robin']
   * @param {(podId: string) => number} [opts.getLoad] - only consulted under `'load-balanced'`. `PeerState` carries no built-in load metric, so this defaults to a constant `0` for every peer (degrading `'load-balanced'` to an arbitrary-but-stable first-among-equals pick) unless the caller supplies a real signal.
   */
  constructor({ peerNode, policy = 'round-robin', getLoad } = {}) {
    if (!peerNode || typeof peerNode.listPeers !== 'function') {
      throw new Error('SiteRegistry: opts.peerNode (with listPeers()) is required')
    }
    this.#peerNode = peerNode
    this.#policy = policy
    this.#getLoad = typeof getLoad === 'function' ? getLoad : () => 0
  }

  /**
   * @param {string} siteId
   * @param {string} podId
   */
  registerSitePeer(siteId, podId) {
    let set = this.#sites.get(siteId)
    if (!set) {
      set = new Set()
      this.#sites.set(siteId, set)
    }
    set.add(podId)
  }

  /**
   * @param {string} siteId
   * @param {string} podId
   */
  unregisterSitePeer(siteId, podId) {
    const set = this.#sites.get(siteId)
    if (!set) return
    set.delete(podId)
    if (set.size === 0) this.#sites.delete(siteId)
  }

  /**
   * @param {string} siteId
   * @returns {string[]} podIds registered for `siteId`, regardless of current connection status.
   */
  listSitePeers(siteId) {
    return [...(this.#sites.get(siteId) || [])]
  }

  /**
   * Pick a currently-connected peer registered for `siteId`, per the
   * configured policy. Returns `null` if `siteId` has no registered peers,
   * or none of them are currently connected -- callers (e.g.
   * `serverless-fetch.mjs`'s `resolveSite`) should fall back to treating
   * the original token as a literal podId in that case, per the plan's own
   * "Design decisions" section.
   *
   * @param {string} siteId
   * @returns {string|null}
   */
  selectPeer(siteId) {
    const podIds = this.#sites.get(siteId)
    if (!podIds || podIds.size === 0) return null

    const connected = this.#peerNode.listPeers({ status: 'connected' }) || []
    const candidates = connected
      .filter((p) => podIds.has(p.fingerprint))
      .map((p) => ({ podId: p.fingerprint, load: this.#getLoad(p.fingerprint) }))

    if (candidates.length === 0) return null

    let state = this.#selectState.get(siteId)
    if (!state) {
      state = {}
      this.#selectState.set(siteId, state)
    }
    return selectPeerFromCandidates(candidates, this.#policy, state)
  }
}
