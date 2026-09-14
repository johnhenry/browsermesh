/**
 * serverless-fetch.mjs -- Phase 2 of the BrowserMesh Serverless plan
 * (`/Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md`):
 * the Service-Worker-facing half of site routing, finally giving
 * `@johnhenry/browsermesh-discovery`'s `sw-routing.mjs` its first real
 * caller (its own module doc comment has said "no wired caller of its own
 * yet" since it was written).
 *
 * ---------------------------------------------------------------------------
 * SITE-NAME REINTERPRETATION OF `parseMeshRequest()`'s `podId` TOKEN (see
 * the plan doc's "Design decisions" section, restated here because it's a
 * real, deliberate semantic overload of shared code, not something a future
 * reader should have to reverse-engineer from two disagreeing call sites):
 *
 * `parseMeshRequest(urlStr)` (`mesh://X/path`, `https://X.mesh.local/path`)
 * extracts a token it calls `podId`. `mesh-fetch.mjs`'s `browserMeshFetch()`
 * uses that token AS a literal podId, addressing one specific peer
 * directly. This file instead treats the SAME token as a logical site name
 * first -- resolved via `opts.resolveSite(siteName) -> podId|null` -- and
 * only falls back to treating it as a literal podId if `resolveSite`
 * returns nothing. This is backward compatible (an unregistered token still
 * behaves exactly like `mesh-fetch.mjs`'s direct-podId addressing), but it
 * IS a real reinterpretation: two call sites in this repo now disagree
 * about what that token conceptually means, unified only by "falls back to
 * a literal podId either way."
 *
 * `opts.resolveSite` is optional. Omitting it makes this file behave
 * identically to a single-peer-per-site deployment addressed by literal
 * podId, which is a completely valid, already-useful configuration on its
 * own. For multi-peer sites, pass `siteRegistry.selectPeer.bind(siteRegistry)`
 * (`serverless-sites.mjs`'s `SiteRegistry`, Phase 5) directly -- its
 * `selectPeer(siteId) -> podId|null` signature already matches this
 * option's shape exactly, no adapter needed.
 *
 * @module serverless-fetch
 */

import { MeshFetchRouter } from '@johnhenry/browsermesh-discovery'
import { decodeWireResponse } from './serverless-wire.mjs'

/**
 * @param {{request: (podId: string, req: {method?: string, path?: string, headers?: object, body?: *}) => Promise<{status: number, headers: object, body: *}>}} meshRpcApi
 *   The `.api` returned by attaching a `mesh-rpc.mjs`-based service bound to
 *   the SAME envelope type a site's `createSiteMeshRpcService()`
 *   (`serverless-router.mjs`) was attached with on the responding side --
 *   typically a second, dedicated `createMeshRpcService({envelopeType:
 *   'mesh-serverless'})` attach on the requesting peer, distinct from any
 *   general-purpose `mesh-rpc` service that peer might also run.
 * @param {object} [opts]
 * @param {(siteOrPodId: string) => (string|null|undefined)} [opts.resolveSite]
 *   Optional. Resolves the `parseMeshRequest()`-extracted token to a target
 *   podId. Omit for direct single-peer-per-site addressing (the token is
 *   used as a literal podId). `serverless-sites.mjs`'s `SiteRegistry#selectPeer()`
 *   (Phase 5) matches this shape exactly and can be passed here directly.
 * @returns {import('@johnhenry/browsermesh-discovery').MeshFetchRouter}
 */
export function createServerlessFetchRouter(meshRpcApi, { resolveSite } = {}) {
  if (!meshRpcApi || typeof meshRpcApi.request !== 'function') {
    throw new Error('createServerlessFetchRouter: meshRpcApi (a mesh-rpc.mjs service api with .request()) is required')
  }

  return new MeshFetchRouter({
    onRpc: async ({ podId: siteOrPodId, method, path, headers, body }) => {
      const resolved = typeof resolveSite === 'function' ? resolveSite(siteOrPodId) : null
      const targetPodId = resolved || siteOrPodId
      const res = await meshRpcApi.request(targetPodId, { method, path, headers, body })
      return decodeWireResponse(res)
    },
  })
}
