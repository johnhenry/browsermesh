/**
 * serverless-router.mjs -- Phase 2 of the BrowserMesh Serverless plan
 * (`/Users/johnhenry/.claude/plans/at-some-point-within-joyful-dove.md`):
 * the per-site request handler that chains static -> functions -> proxy,
 * mirroring `actually-serverless`'s own handler precedence, and attaches
 * it over the mesh via a dedicated-envelope `mesh-rpc.mjs` service.
 *
 * `functionsHandler`/`proxyHandler` are optional and not yet implemented by
 * anything in this repo (Phases 3/4) -- a `siteConfig` that only sets
 * `staticHandler` already works end to end today (a static-only site), the
 * chain just skips whatever fields are absent.
 *
 * ---------------------------------------------------------------------------
 * WHY A DEDICATED `'mesh-serverless'` ENVELOPE TYPE, NOT THE DEFAULT
 * `'mesh-rpc'` (see the plan doc's "Design decisions" section):
 *
 * `createMeshRpcService()` takes exactly one `onRequest` per attached
 * instance. A pod that also runs a general-purpose `mesh-rpc` service for
 * something else (e.g. `agent-runtime.mjs` tool calls) would collide if
 * both shared the default envelope type and default `onRequest` slot.
 * `createSiteMeshRpcService()` below always passes its own `envelopeType`
 * (default `'mesh-serverless'`, overridable), matching this family's
 * one-`MeshService`-per-concern convention (`mesh-compute` uses
 * `'mesh-compute'`, etc.) rather than fighting over a shared default.
 *
 * @module serverless-router
 */

import { createMeshRpcService } from './mesh-rpc.mjs'
import { encodeWireResponse } from './serverless-wire.mjs'

/** Default envelope type for a site's mesh-rpc attach -- see module doc comment. */
const DEFAULT_SITE_ENVELOPE_TYPE = 'mesh-serverless'

/**
 * @typedef {object} SiteHandlerRequest
 * @property {string} [fromPubKey]
 * @property {string} method
 * @property {string} path
 * @property {object} [headers]
 * @property {*} [body]
 */

/**
 * @typedef {object} SiteHandlerResponse
 * @property {number} status
 * @property {object} headers
 * @property {Uint8Array|ArrayBuffer|string|*} body
 */

/**
 * @typedef {object} SiteConfig
 * @property {(req: {path: string, method?: string, fromPubKey?: string}) => Promise<SiteHandlerResponse|null>} [staticHandler]
 *   Typically `createStaticHandler(...)` from `serverless-static.mjs`.
 * @property {(req: SiteHandlerRequest) => Promise<SiteHandlerResponse|null>} [functionsHandler]
 *   Not yet implemented anywhere in this repo -- Phase 3.
 * @property {(req: SiteHandlerRequest) => Promise<SiteHandlerResponse|null>} [proxyHandler]
 *   Not yet implemented anywhere in this repo -- Phase 4.
 */

/**
 * Build the `onRequest` handler for one site: static -> functions -> proxy,
 * first non-null response wins. A binary (`Uint8Array`/`ArrayBuffer`) body
 * from any handler is base64-encoded via `encodeWireResponse()` before
 * being returned, so it survives the `mesh-rpc.mjs` wire hop intact --
 * `serverless-fetch.mjs`'s client side reverses this.
 *
 * @param {SiteConfig} siteConfig
 * @returns {(req: SiteHandlerRequest) => Promise<SiteHandlerResponse>}
 */
export function createSiteRequestHandler(siteConfig = {}) {
  const { staticHandler, functionsHandler, proxyHandler } = siteConfig

  return async function onRequest(req) {
    const { fromPubKey, method = 'GET', path = '/', headers = {}, body } = req || {}

    if (staticHandler) {
      const res = await staticHandler({ path, method, fromPubKey })
      if (res) return encodeWireResponse(res)
    }
    if (functionsHandler) {
      const res = await functionsHandler({ fromPubKey, method, path, headers, body })
      if (res) return encodeWireResponse(res)
    }
    if (proxyHandler) {
      const res = await proxyHandler({ fromPubKey, method, path, headers, body })
      if (res) return encodeWireResponse(res)
    }

    return { status: 404, headers: { 'content-type': 'application/json' }, body: { error: 'not found' } }
  }
}

/**
 * Attach a site's request handler to `peerNode` over a dedicated
 * `mesh-rpc.mjs` envelope type. Thin convenience wrapper -- equivalent to
 * calling `attachService(peerNode, network, createMeshRpcService({onRequest:
 * createSiteRequestHandler(siteConfig), envelopeType}))` directly.
 *
 * @param {SiteConfig} siteConfig
 * @param {object} [opts]
 * @param {string} [opts.envelopeType='mesh-serverless']
 * @param {number} [opts.requestTimeoutMs]
 * @returns {import('./mesh-service.mjs').MeshService}
 */
export function createSiteMeshRpcService(siteConfig, { envelopeType = DEFAULT_SITE_ENVELOPE_TYPE, requestTimeoutMs, name = 'mesh-serverless' } = {}) {
  const rpcService = createMeshRpcService({
    onRequest: createSiteRequestHandler(siteConfig),
    envelopeType,
    requestTimeoutMs,
  })
  return { ...rpcService, name }
}

export { DEFAULT_SITE_ENVELOPE_TYPE }
