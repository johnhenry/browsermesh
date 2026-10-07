/**
 * pod-host-routes.mjs -- issue #185 control-surface item 3: an HTTP-shaped
 * view of `pod-host-service.mjs` over `mesh://` URLs.
 *
 * `docs/hosted-pods.md` §8a calls every later control surface "a projection
 * of the same eight verbs" defined in `@johnhenry/browsermesh-pod`'s
 * `host-protocol.mjs`. This file is that projection for HTTP: a route table
 * (`POD_HOST_ROUTES` / `matchPodHostRoute()`) mapping `METHOD /pods...` onto
 * a verb, a host-side router (`createPodHostRouter()`) that answers those
 * routes against a `PodHostDriver`, and a requester-side client
 * (`podHostFetch()`) built on `browserMeshFetch()`.
 *
 * ---------------------------------------------------------------------------
 * THE HOST-SIDE MOUNT POINT (read `mesh-fetch.mjs`'s module doc comment
 * before this one if you haven't -- it explains why).
 *
 * `browserMeshFetch(url, init)` is a *caller*-side wrapper: it resolves a
 * `mesh://<podId>/path` URL and round-trips it through a live `mesh-rpc`
 * service's `api.request(podId, {method, path, headers, body})`
 * (`mesh-rpc.mjs`, Phase 1 of the BrowserMeshFetch plan). The HOST side that
 * actually *answers* an inbound request is `createMeshRpcService({
 * onRequest })`'s `onRequest` callback -- `(req: {fromPubKey, method, path,
 * headers, body}) => Promise<{status?, headers?, body?}>` -- exactly the
 * slot `examples/08-mesh-fetch-websocket.mjs` and
 * `serverless-router.mjs`'s `createSiteRequestHandler()` already plug into.
 * That slot was ALREADY fully composable (any function works); no change to
 * `mesh-fetch.mjs` or `mesh-rpc.mjs` was needed to mount this router there.
 *
 * `MeshFetchRouter` (`@johnhenry/browsermesh-discovery`'s `sw-routing.mjs`)
 * is a *different*, Service-Worker-shaped thing: `Request -> Promise<Response
 * |null>`, used client-side to intercept `fetch` events. `createPodHostRouter
 * ().route()` below is deliberately shaped to MATCH that same `Request ->
 * Promise<Response|null>` signature (so it reads the same way to anyone who
 * already knows `MeshFetchRouter`, and so it can serve the Node HTTP gateway
 * in `pod-host-gateway.mjs` without any reshaping) -- but it is NOT
 * `MeshFetchRouter` itself and is not mounted there. It is mounted on the
 * mesh side via `createPodHostMeshRpcHandler()` below, which adapts between
 * `route()`'s `Request`/`Response` shape and `onRequest`'s plain-object
 * `{method,path,headers,body}`/`{status,headers,body}` shape:
 *
 *   import { attachService, createMeshRpcService } from '@johnhenry/browsermesh-apps'
 *   import { createPodHostRouter, createPodHostMeshRpcHandler } from '@johnhenry/browsermesh-apps'
 *
 *   const router = createPodHostRouter({ driver, registry: peerNode.registry })
 *   attachService(peerNode, undefined, createMeshRpcService({
 *     onRequest: createPodHostMeshRpcHandler(router),
 *   }))
 *
 * ---------------------------------------------------------------------------
 * ACCESS CONTROL -- NO BYPASS. `mesh-rpc.mjs` itself checks nothing (see its
 * own "AUTHORIZATION IS EXPLICITLY OUT OF SCOPE" doc comment); authorization
 * is this router's job, same as `pod-host-service.mjs`'s `handleRequest()`.
 * `createPodHostService()`'s `attach()` returns an `api` whose `dispatch(
 * pubKey, verb, payload)` is the ONE gated path (gate + validate + lane check
 * + audit + events); when `api` is supplied this router calls it and nothing
 * else. `api.driver` stays the raw, UNGATED driver and is never used to
 * answer a request. Only a router built from a bare `driver` (no `api`) falls
 * back to a standalone copy of the same steps, calling
 * `registry.checkAccess(pubKey, resource, verb)` on the explicitly-supplied
 * `registry` (`peerNode.registry` -- see `mesh-service.mjs`'s `ctx.registry`).
 *
 * The requester's pubKey travels from `createPodHostMeshRpcHandler()`'s
 * `fromPubKey` into the synthetic `Request` as the `MESH_FROM_HEADER`
 * header, set LAST (after copying the caller's own headers) so a malicious
 * peer cannot spoof it by sending a same-named header of their own -- see
 * that function's own comment.
 *
 * ---------------------------------------------------------------------------
 * STATUS MAPPING: ok -> 200 (201 spawn, 204 drain -- no body, per HTTP's
 * "204 must not carry a body" rule); EINVAL -> 400; EACCES -> 403; ENOENT ->
 * 404; EEXIST -> 409; ELANE -> 405 with an `Allow` header listing the verbs
 * the driver's LANE supports (not HTTP methods -- this is a deliberate,
 * documented deviation from classic `Allow` semantics, matching the verb
 * vocabulary this whole surface is built from); ENOTSUP -> 501; ETIMEDOUT ->
 * 504; EBUSY -> 409; anything else -> 500. `statusForError()` /
 * `successStatusForVerb()` are exported so `pod-host-gateway.mjs` applies
 * the identical mapping.
 *
 * No browser-only imports, no `node:` imports -- this file must load
 * unchanged in a browser, Node, or a Worker.
 */

import {
  POD_HOST_VERB,
  POD_HOST_ERROR,
  POD_LANE_VERBS,
  laneSupports,
  validateVerbRequest,
  PodHostDriverError,
} from '@johnhenry/browsermesh-pod'
import { DEFAULT_POD_HOST_RESOURCE } from './pod-host-service.mjs'

/** Route-table sentinel for `GET /host` -- NOT one of the eight `POD_HOST_VERB`s (see module doc comment and `pod-host-service.mjs`'s own `POD_HOST_DESCRIBE` doc comment: describe is ungated, host metadata, not a verb). */
export const POD_HOST_DESCRIBE_VERB = 'describe'

/** Header `createPodHostMeshRpcHandler()` uses to carry the requester's pubKey from the mesh-rpc envelope into the synthetic `Request` the router reads. Internal wiring detail, exported only so tests can construct an equivalent `Request` directly. */
export const MESH_FROM_HEADER = 'x-mesh-from-pubkey'

/** Same grammar as `host-protocol.mjs`'s own (private) `NAME_PATTERN` -- duplicated on purpose, the same way `POD_LANE` is duplicated there, so this file has no dependency beyond the verb/error/validator exports. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * The whole HTTP projection of the eight-verb control surface, plus
 * `describe`. `path` segments starting with `:` are params; `:name` is
 * additionally validated against `NAME_PATTERN` by `matchPodHostRoute()`
 * (an invalid name means NO match, i.e. `null`, not a route match that then
 * fails validation downstream).
 */
export const POD_HOST_ROUTES = Object.freeze([
  Object.freeze({ method: 'GET', path: '/pods', verb: POD_HOST_VERB.LIST }),
  Object.freeze({ method: 'POST', path: '/pods', verb: POD_HOST_VERB.SPAWN }),
  Object.freeze({ method: 'GET', path: '/pods/:name', verb: POD_HOST_VERB.STATUS }),
  Object.freeze({ method: 'POST', path: '/pods/:name/send', verb: POD_HOST_VERB.SEND }),
  Object.freeze({ method: 'POST', path: '/pods/:name/exec', verb: POD_HOST_VERB.EXEC }),
  Object.freeze({ method: 'POST', path: '/pods/:name/snapshot', verb: POD_HOST_VERB.SNAPSHOT }),
  Object.freeze({ method: 'POST', path: '/pods/:name/restore', verb: POD_HOST_VERB.RESTORE }),
  Object.freeze({ method: 'DELETE', path: '/pods/:name', verb: POD_HOST_VERB.DRAIN }),
  Object.freeze({ method: 'GET', path: '/host', verb: POD_HOST_DESCRIBE_VERB }),
])

/** @param {string} pathname @returns {string[]} */
function splitPath(pathname) {
  const trimmed = String(pathname || '').replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? [] : trimmed.split('/')
}

/**
 * Match an HTTP method + pathname against `POD_HOST_ROUTES`.
 *
 * @param {string} method
 * @param {string} pathname - No query string (use `new URL(url).pathname`).
 * @returns {{verb: string, params: {name?: string}}|null} `null` for no
 *   match, including a `:name` segment that fails `NAME_PATTERN`.
 */
export function matchPodHostRoute(method, pathname) {
  if (typeof method !== 'string' || typeof pathname !== 'string') return null
  const upperMethod = method.toUpperCase()
  const segments = splitPath(pathname)

  for (const route of POD_HOST_ROUTES) {
    if (route.method !== upperMethod) continue
    const routeSegments = splitPath(route.path)
    if (routeSegments.length !== segments.length) continue

    /** @type {Record<string, string>} */
    const params = {}
    let matched = true
    for (let i = 0; i < routeSegments.length; i += 1) {
      const rs = routeSegments[i]
      const seg = segments[i]
      if (rs.startsWith(':')) {
        const key = rs.slice(1)
        let value
        try {
          value = decodeURIComponent(seg)
        } catch {
          matched = false
          break
        }
        if (key === 'name' && !NAME_PATTERN.test(value)) {
          matched = false
          break
        }
        params[key] = value
      } else if (rs !== seg) {
        matched = false
        break
      }
    }
    if (matched) return { verb: route.verb, params }
  }
  return null
}

/** @type {Readonly<Record<string, number>>} */
const ERROR_STATUS = Object.freeze({
  [POD_HOST_ERROR.EINVAL]: 400,
  [POD_HOST_ERROR.EACCES]: 403,
  [POD_HOST_ERROR.ENOENT]: 404,
  [POD_HOST_ERROR.EEXIST]: 409,
  [POD_HOST_ERROR.ELANE]: 405,
  [POD_HOST_ERROR.ENOTSUP]: 501,
  [POD_HOST_ERROR.ETIMEDOUT]: 504,
  [POD_HOST_ERROR.EBUSY]: 409,
})

/**
 * Map a `POD_HOST_ERROR` code to an HTTP status. An unknown code -- which
 * should not happen, since every `PodHostDriverError` carries one of the
 * eight -- maps to 500 rather than throwing, so a surprising error never
 * breaks response-building itself.
 * @param {string} code
 * @returns {number}
 */
export function statusForError(code) {
  return ERROR_STATUS[code] ?? 500
}

/**
 * The success status for a verb: 201 for `spawn` (a new pod was created),
 * 204 for `drain` (no body -- see module doc comment), 200 for everything
 * else including `describe`.
 * @param {string} verb
 * @returns {number}
 */
export function successStatusForVerb(verb) {
  if (verb === POD_HOST_VERB.SPAWN) return 201
  if (verb === POD_HOST_VERB.DRAIN) return 204
  return 200
}

/** @param {number} status @param {object} body @returns {Response} */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * Read and JSON-parse a `Request`'s body, mirroring `MeshFetchRouter.route()`
 * /`mesh-fetch.mjs`'s own body handling: GET/HEAD never have a body; a
 * non-JSON body is kept as the raw string rather than erroring (the verb
 * payload validator downstream will reject it with a clear `EINVAL` if a
 * verb actually required an object).
 * @param {Request} request
 * @returns {Promise<*>}
 */
export async function readHttpRequestBody(request) {
  const method = (request.method || 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return undefined
  let text = ''
  try {
    text = await request.text()
  } catch {
    return undefined
  }
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Build the raw (pre-`validateVerbRequest()`) payload for a verb from its
 * HTTP parts: the `:name` path param, the parsed JSON body, and (for
 * `drain`) the `?cascade=` query param.
 * @param {string} verb
 * @param {{name?: string}} params
 * @param {*} bodyJson
 * @param {URLSearchParams} searchParams
 * @returns {object}
 */
function buildRawPayload(verb, params, bodyJson, searchParams) {
  const body = bodyJson && typeof bodyJson === 'object' ? bodyJson : {}
  switch (verb) {
    case POD_HOST_VERB.SPAWN:
      return body
    case POD_HOST_VERB.STATUS:
    case POD_HOST_VERB.SNAPSHOT:
    case POD_HOST_VERB.RESTORE:
      return { name: params.name }
    case POD_HOST_VERB.SEND: {
      const payload = { name: params.name, payload: body.payload }
      if (body.to !== undefined) payload.to = body.to
      return payload
    }
    case POD_HOST_VERB.EXEC: {
      const payload = { name: params.name, command: body.command }
      if (body.timeoutMs !== undefined) payload.timeoutMs = body.timeoutMs
      return payload
    }
    case POD_HOST_VERB.DRAIN: {
      const payload = { name: params.name }
      const cascadeParam = searchParams.get('cascade')
      if (cascadeParam !== null) payload.cascade = cascadeParam === 'true'
      return payload
    }
    case POD_HOST_VERB.LIST:
    default:
      return {}
  }
}

/**
 * Dispatch a validated verb request to a `PodHostDriver`. Mirrors
 * `pod-host-service.mjs`'s own (unexported) `dispatch()` switch exactly --
 * duplicated rather than imported because that function is a closure inside
 * `createPodHostService()`'s `attach()`, not a module-level export.
 * @param {import('@johnhenry/browsermesh-pod').PodHostDriver} driver
 * @param {string} verb
 * @param {object} value - `validateVerbRequest()`'s normalized `value`.
 * @returns {Promise<*>}
 */
function dispatchToDriver(driver, verb, value) {
  switch (verb) {
    case POD_HOST_VERB.SPAWN:
      return driver.spawn(value)
    case POD_HOST_VERB.STATUS:
      return driver.status(value.name)
    case POD_HOST_VERB.SEND:
      return driver.send(value.name, { to: value.to, payload: value.payload })
    case POD_HOST_VERB.EXEC:
      return driver.exec(value.name, value.command, { timeoutMs: value.timeoutMs })
    case POD_HOST_VERB.SNAPSHOT:
      return driver.snapshot(value.name)
    case POD_HOST_VERB.RESTORE:
      return driver.restore(value.name)
    case POD_HOST_VERB.DRAIN:
      return driver.drain(value.name, { cascade: value.cascade })
    case POD_HOST_VERB.LIST:
    default:
      return driver.list()
  }
}

/**
 * Refuse a verb before the driver is ever called -- `ELANE` when the lane
 * structurally cannot, `ENOTSUP` when this driver simply does not serve it.
 * Mirrors `pod-host-service.mjs`'s own `verbRefusal()` closure.
 * @param {import('@johnhenry/browsermesh-pod').PodHostDriver} driver
 * @param {string} verb
 * @returns {PodHostDriverError|null}
 */
function verbRefusal(driver, verb) {
  const caps = typeof driver.capabilities === 'function' ? driver.capabilities() : { verbs: [] }
  const verbs = Array.isArray(caps.verbs) ? caps.verbs : []
  // Lane first, driver second -- same order as pod-host-service.mjs.
  if (!laneSupports(driver.lane, verb)) {
    return new PodHostDriverError(POD_HOST_ERROR.ELANE, `lane '${driver.lane}' cannot '${verb}'`, { verb, lane: driver.lane })
  }
  if (verbs.includes(verb) && typeof driver[verb] === 'function') return null
  return new PodHostDriverError(POD_HOST_ERROR.ENOTSUP, `host does not implement '${verb}'`, { verb, lane: driver.lane })
}

/** @param {import('@johnhenry/browsermesh-pod').PodHostDriver} driver @returns {string} */
function allowHeaderForLane(driver) {
  return (POD_LANE_VERBS[driver.lane] || []).join(', ')
}

/**
 * Build the host-side router: `route(request) -> Promise<Response|null>`,
 * shaped like `MeshFetchRouter.route()` (see module doc comment for why
 * that shape and not `MeshFetchRouter` itself).
 *
 * @param {object} opts
 * @param {import('@johnhenry/browsermesh-pod').PodHostDriver} [opts.driver]
 *   The lane adapter. Required unless `opts.api` carries one.
 * @param {{driver?: object, resource?: string, describe?: Function}} [opts.api]
 *   The `.api` an `attachService(peerNode, undefined, createPodHostService(...))`
 *   handle returns. Supplies `driver`/`resource`/`describe()` as fallbacks
 *   when not given directly -- NEVER used to bypass `checkAccess()` (see
 *   module doc comment: `api` has no gated-dispatch method to route through).
 * @param {import('./peer-registry.mjs').PeerRegistry} opts.registry -
 *   REQUIRED. `peerNode.registry` -- what `checkAccess()` is called against.
 *   Neither `driver` nor `api` carries a registry reference, so this must be
 *   supplied explicitly; there is no default.
 * @param {string} [opts.resource='pod-host'] - ACL resource, same grammar as
 *   `createPodHostService({resource})`.
 * @param {Function} [opts.onLog] - `(event, data) => void` debug logging.
 * @returns {{route: (request: Request) => Promise<Response|null>, describe: () => object}}
 */
export function createPodHostRouter({ driver, api, registry, resource, onLog } = {}) {
  const resolvedDriver = driver || api?.driver
  if (!resolvedDriver || typeof resolvedDriver !== 'object' || typeof resolvedDriver.lane !== 'string') {
    throw new Error('createPodHostRouter: driver (or api with a .driver) is required')
  }
  if (!registry || typeof registry.checkAccess !== 'function') {
    throw new Error(
      'createPodHostRouter: registry (a PeerRegistry, e.g. peerNode.registry) is required -- '
      + 'see this module\'s doc comment on why it cannot be defaulted or derived from api',
    )
  }
  const resolvedResource = resource || api?.resource || DEFAULT_POD_HOST_RESOURCE
  const log = onLog || (() => {})

  function describe() {
    if (api && typeof api.describe === 'function') return api.describe()
    const caps = typeof resolvedDriver.capabilities === 'function' ? resolvedDriver.capabilities() : { verbs: [] }
    const verbs = Array.isArray(caps.verbs) ? caps.verbs : []
    return {
      podId: null,
      lane: resolvedDriver.lane,
      verbs: [...verbs],
      runtimeClasses: [resolvedDriver.lane],
      shellBackend: null,
      deploymentSupport: { canDeploy: verbs.includes(POD_HOST_VERB.SPAWN) },
      capabilities: ['pod-host', ...(verbs.includes(POD_HOST_VERB.EXEC) ? ['exec'] : [])],
      resource: resolvedResource,
      hostLabel: null,
    }
  }

  /**
   * @param {Request} request
   * @returns {Promise<Response|null>}
   */
  async function route(request) {
    const url = new URL(request.url)
    const method = (request.method || 'GET').toUpperCase()
    const match = matchPodHostRoute(method, url.pathname)
    if (!match) return null

    if (match.verb === POD_HOST_DESCRIBE_VERB) {
      // Ungated, mirrors pod-host-service.mjs's POD_HOST_DESCRIBE handling
      // (see its own module doc comment) -- a peer must be able to discover
      // a host before it can be granted anything on it.
      return jsonResponse(200, { ok: true, result: describe() })
    }

    const verb = match.verb
    const pubKey = request.headers.get(MESH_FROM_HEADER)
    if (!pubKey) {
      return jsonResponse(400, {
        ok: false,
        error: { code: POD_HOST_ERROR.EINVAL, message: `missing requester identity ('${MESH_FROM_HEADER}' header)` },
      })
    }

    // Preferred path: the attached service's own gated dispatch (ONE copy
    // of gate + validate + lane check + audit + events). Only when the
    // router was built from a bare driver does it fall through to the
    // standalone re-implementation below.
    if (api && typeof api.dispatch === 'function') {
      const bodyJson = await readHttpRequestBody(request)
      const rawPayload = buildRawPayload(verb, match.params, bodyJson, url.searchParams)
      try {
        const result = await api.dispatch(pubKey, verb, rawPayload)
        const status = successStatusForVerb(verb)
        if (status === 204) return new Response(null, { status })
        return jsonResponse(status, { ok: true, result })
      } catch (err) {
        const driverError = PodHostDriverError.from(err)
        log('pod-host-router:verb-failed', { from: pubKey, verb, code: driverError.code, error: driverError.message })
        const headers = { 'content-type': 'application/json' }
        if (driverError.code === POD_HOST_ERROR.ELANE) headers.allow = allowHeaderForLane(resolvedDriver)
        return new Response(JSON.stringify({ ok: false, error: driverError.toJSON() }), { status: statusForError(driverError.code), headers })
      }
    }

    // 1. Gate -- the same checkAccess() pod-host-service.mjs itself calls.
    const check = registry.checkAccess(pubKey, resolvedResource, verb)
    if (!check.allowed) {
      log('pod-host-router:denied', { from: pubKey, verb, reason: check.reason })
      return jsonResponse(403, {
        ok: false,
        error: { code: POD_HOST_ERROR.EACCES, message: `not authorized for '${resolvedResource}:${verb}'` },
      })
    }

    // 2. Validate (and normalize) before anything reaches the driver.
    const bodyJson = await readHttpRequestBody(request)
    const rawPayload = buildRawPayload(verb, match.params, bodyJson, url.searchParams)
    const validated = validateVerbRequest(verb, rawPayload)
    if (!validated.ok) {
      return jsonResponse(400, { ok: false, error: { code: POD_HOST_ERROR.EINVAL, message: validated.errors.join('; ') } })
    }

    // 3. Lane / driver capability.
    const refusal = verbRefusal(resolvedDriver, verb)
    if (refusal) {
      const headers = { 'content-type': 'application/json' }
      if (refusal.code === POD_HOST_ERROR.ELANE) headers.allow = allowHeaderForLane(resolvedDriver)
      return new Response(JSON.stringify({ ok: false, error: refusal.toJSON() }), { status: statusForError(refusal.code), headers })
    }

    // 4. Dispatch.
    try {
      const result = await dispatchToDriver(resolvedDriver, verb, validated.value)
      const status = successStatusForVerb(verb)
      if (status === 204) return new Response(null, { status })
      return jsonResponse(status, { ok: true, result })
    } catch (err) {
      const driverError = PodHostDriverError.from(err)
      log('pod-host-router:verb-failed', { from: pubKey, verb, code: driverError.code, error: driverError.message })
      const headers = { 'content-type': 'application/json' }
      if (driverError.code === POD_HOST_ERROR.ELANE) headers.allow = allowHeaderForLane(resolvedDriver)
      return new Response(JSON.stringify({ ok: false, error: driverError.toJSON() }), { status: statusForError(driverError.code), headers })
    }
  }

  return { route, describe }
}

/**
 * Adapt a `createPodHostRouter()` router's `route(request)` into the
 * `onRequest` shape `createMeshRpcService()` expects -- the composition hook
 * that actually mounts this router under `mesh://` (see module doc
 * comment). Builds a synthetic `Request` from the mesh-rpc envelope's
 * `{method, path, headers, body}`, and converts the resulting `Response`
 * back into `{status, headers, body}`.
 *
 * @param {{route: (request: Request) => Promise<Response|null>}} router
 * @returns {(req: {fromPubKey: string, method?: string, path?: string, headers?: object, body?: *}) => Promise<{status: number, headers: object, body: *}>}
 */
export function createPodHostMeshRpcHandler(router) {
  if (!router || typeof router.route !== 'function') {
    throw new Error('createPodHostMeshRpcHandler: router (from createPodHostRouter()) is required')
  }

  return async function onRequest({ fromPubKey, method = 'GET', path = '/', headers, body } = {}) {
    const reqHeaders = new Headers()
    if (headers && typeof headers === 'object') {
      for (const [key, value] of Object.entries(headers)) {
        if (value === undefined || value === null) continue
        reqHeaders.set(key, String(value))
      }
    }
    // Set LAST and unconditionally -- never let a client-supplied header of
    // the same name spoof the identity checkAccess() will see (see module
    // doc comment).
    reqHeaders.set(MESH_FROM_HEADER, fromPubKey || '')

    const upperMethod = String(method || 'GET').toUpperCase()
    const url = `http://pod-host.internal${path.startsWith('/') ? path : `/${path}`}`
    /** @type {RequestInit} */
    const init = { method: upperMethod, headers: reqHeaders }
    if (upperMethod !== 'GET' && upperMethod !== 'HEAD' && body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body)
      if (!reqHeaders.has('content-type')) reqHeaders.set('content-type', 'application/json')
    }

    const response = await router.route(new Request(url, init))
    if (!response) {
      return { status: 404, headers: { 'content-type': 'application/json' }, body: { error: 'not found' } }
    }

    /** @type {Record<string, string>} */
    const resHeaders = {}
    response.headers.forEach((value, key) => { resHeaders[key] = value })

    const text = await response.text()
    let resBody
    if (!text) {
      resBody = undefined
    } else {
      try {
        resBody = JSON.parse(text)
      } catch {
        resBody = text
      }
    }
    return { status: response.status, headers: resHeaders, body: resBody }
  }
}

// ---------------------------------------------------------------------------
// podHostFetch -- "control from within": a tiny client built on
// browserMeshFetch, for callers who already have one bound and would rather
// call fetch-shaped methods than build pod-host:* envelopes by hand.
// ---------------------------------------------------------------------------

/**
 * @typedef {object} PodHostFetchClient
 * @property {() => Promise<object[]>} list
 * @property {(spec: object) => Promise<object>} spawn
 * @property {(name: string) => Promise<object>} status
 * @property {(name: string, payload: *, opts?: {to?: string}) => Promise<object>} send
 * @property {(name: string, command: string[]|string, opts?: {timeoutMs?: number}) => Promise<{stdout: string, stderr: string, code: number}>} exec
 * @property {(name: string) => Promise<object>} snapshot
 * @property {(name: string) => Promise<object>} restore
 * @property {(name: string, opts?: {cascade?: boolean}) => Promise<void>} drain
 * @property {() => Promise<object>} describe
 */

/**
 * Build a `PodHostFetchClient` bound to one host, over `mesh://<hostPodId>/pods...`.
 *
 * @param {string} hostPodId
 * @param {object} opts
 * @param {(url: string, init?: object) => Promise<Response>} opts.fetch -
 *   REQUIRED. Typically `createBrowserMeshFetch(meshRpcApi)`'s return value
 *   (`mesh-fetch.mjs`) -- there is no sensible default: unlike real
 *   `fetch()`, a `mesh://` URL needs a live mesh-rpc binding to resolve.
 * @returns {PodHostFetchClient}
 */
export function podHostFetch(hostPodId, { fetch } = {}) {
  if (!hostPodId || typeof hostPodId !== 'string') {
    throw new Error('podHostFetch: hostPodId is required')
  }
  if (typeof fetch !== 'function') {
    throw new Error('podHostFetch: fetch (e.g. createBrowserMeshFetch(meshRpcApi)) is required')
  }

  const base = `mesh://${hostPodId}`

  /**
   * @param {string} method
   * @param {string} path
   * @param {*} [body]
   * @returns {Promise<*>}
   */
  async function call(method, path, body) {
    const res = await fetch(`${base}${path}`, body === undefined ? { method } : { method, body })
    let json = null
    try {
      json = await res.json()
    } catch {
      // No body (e.g. a 204 from drain) or a non-JSON body -- leave json null.
    }
    if (!res.ok) {
      const error = (json && json.error) || { code: POD_HOST_ERROR.EINVAL, message: `request failed with status ${res.status}` }
      throw new PodHostDriverError(error.code, error.message)
    }
    return json ? json.result : undefined
  }

  return {
    list: () => call('GET', '/pods'),
    spawn: (spec) => call('POST', '/pods', spec),
    status: (name) => call('GET', `/pods/${encodeURIComponent(name)}`),
    send: (name, payload, { to } = {}) => call(
      'POST', `/pods/${encodeURIComponent(name)}/send`, to === undefined ? { payload } : { payload, to },
    ),
    exec: (name, command, { timeoutMs } = {}) => call(
      'POST', `/pods/${encodeURIComponent(name)}/exec`, timeoutMs === undefined ? { command } : { command, timeoutMs },
    ),
    snapshot: (name) => call('POST', `/pods/${encodeURIComponent(name)}/snapshot`),
    restore: (name) => call('POST', `/pods/${encodeURIComponent(name)}/restore`),
    drain: (name, { cascade } = {}) => call(
      'DELETE', `/pods/${encodeURIComponent(name)}${cascade ? '?cascade=true' : ''}`,
    ),
    describe: () => call('GET', '/host'),
  }
}
