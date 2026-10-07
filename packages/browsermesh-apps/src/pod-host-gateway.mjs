/**
 * pod-host-gateway.mjs -- issue #185 control-surface item 3's other half:
 * a Node HTTP gateway so the pod-host verbs can be driven from OUTSIDE the
 * mesh, over plain HTTP, using the exact same route table
 * (`POD_HOST_ROUTES`/`matchPodHostRoute()`, `pod-host-routes.mjs`) the
 * `mesh://` router projects.
 *
 * `createPodHostGatewayHandler()` is a Web-standard `(req: Request) =>
 * Promise<Response>` handler -- no Node-specific types in its own
 * signature, so it runs in a Worker, Deno, or (via `serveNodeGateway()`
 * below) plain Node's `node:http`. It does NOT reuse
 * `createPodHostRouter()` from `pod-host-routes.mjs`: that router dispatches
 * straight to a local `PodHostDriver` for the HOST mounted on the mesh;
 * this gateway is itself a MESH PEER (it holds a `peerNode`/`client`) and
 * dispatches by calling `createPodHostClient()`'s per-verb methods against
 * a remote host over the real, gated `pod-host:request` envelope protocol
 * (`pod-host-service.mjs`) -- the exact client API
 * `docs/hosted-pods.md` §8a calls the thing every later surface projects.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY CAVEAT -- read this before deploying a gateway.
 *
 * `checkAccess()` on the remote host is evaluated against the GATEWAY's OWN
 * mesh identity (`client`'s/`peerNode`'s pubKey), not against whoever made
 * the HTTP request. The gateway acts on the mesh AS ITSELF. This mirrors
 * exactly how a real API gateway in front of a backend service that trusts
 * mTLS client certs works: the backend sees the gateway's cert, not the
 * original caller's. Whatever scopes the gateway's identity was granted on
 * each host it talks to are the scopes every HTTP caller through this
 * gateway effectively gets (modulo whatever the `auth()` callback and
 * `resolveHost()` additionally restrict at the HTTP layer).
 *
 * Because of this, `auth(req) -> {ok, pubKey?} | Promise<...>` is a REQUIRED
 * constructor argument -- there is no default-open gateway. It is entirely
 * the OPERATOR's responsibility to decide who gets to use the gateway's
 * mesh identity, and how (a bearer token, mTLS terminated upstream, a
 * signed JWT, ...); this file has no opinion on the scheme, only that one
 * must be supplied. See `test/pod-host-gateway.test.mjs` for a bearer-token
 * example.
 *
 * ---------------------------------------------------------------------------
 * PATHS: `/hosts/:hostPodId/pods...` (and `/hosts/:hostPodId/host` for
 * describe), mapped onto `POD_HOST_ROUTES` via `matchPodHostRoute()` after
 * stripping the `/hosts/:hostPodId` prefix -- plus `GET /hosts`, which lists
 * the hosts this gateway knows about via `resolveHost` (see
 * `createPodHostGatewayHandler()`'s own doc comment for the two shapes
 * `resolveHost` may take).
 *
 * `serveNodeGateway({handler, port, host})` wraps a handler in a real
 * `node:http` server, lazily `await import('node:http')`-ing so this file
 * stays reachable from `src/index.mjs`'s `export *` graph without breaking
 * `test/browser-safe-entry.test.mjs` (see that test's own doc comment) --
 * the Node-only code only runs once `serveNodeGateway()` is actually
 * called, never merely by importing this module.
 *
 * No `node:` imports at module top level.
 */

import { POD_HOST_VERB, POD_HOST_ERROR, PodHostDriverError } from '@johnhenry/browsermesh-pod'
import { createPodHostClient } from './pod-host-service.mjs'
import {
  matchPodHostRoute,
  statusForError,
  successStatusForVerb,
  readHttpRequestBody,
  POD_HOST_DESCRIBE_VERB,
} from './pod-host-routes.mjs'

/** @param {number} status @param {object} body @returns {Response} */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * Normalize the `resolveHost` constructor option into `{resolve, list}`.
 * Accepts either a lookup function `(token) => pubKey|null|Promise<...>`
 * (in which case `GET /hosts` lists nothing unless `listHosts` is also
 * given), or a plain object / `Map` of `token -> pubKey`, in which case its
 * keys double as the `GET /hosts` listing -- "the hosts the gateway knows"
 * in the common static-config case.
 * @param {Function|object|Map<string,string>|undefined} resolveHost
 * @param {Function|undefined} listHosts
 * @returns {{resolve: (token: string) => Promise<string|null>, list: () => Promise<string[]>}}
 */
function normalizeHostResolver(resolveHost, listHosts) {
  const list = typeof listHosts === 'function'
    ? async () => listHosts()
    : null

  if (typeof resolveHost === 'function') {
    return { resolve: async (token) => resolveHost(token), list: list || (async () => []) }
  }
  if (resolveHost instanceof Map) {
    return {
      resolve: async (token) => (resolveHost.has(token) ? resolveHost.get(token) : null),
      list: list || (async () => [...resolveHost.keys()]),
    }
  }
  if (resolveHost && typeof resolveHost === 'object') {
    return {
      resolve: async (token) => (Object.prototype.hasOwnProperty.call(resolveHost, token) ? resolveHost[token] : null),
      list: list || (async () => Object.keys(resolveHost)),
    }
  }
  return { resolve: async () => null, list: list || (async () => []) }
}

/**
 * Call the right `PodHostClient` method for a matched HTTP route. Mirrors
 * `pod-host-routes.mjs`'s internal `buildRawPayload()`/`dispatchToDriver()`
 * pair, but targets `createPodHostClient()`'s per-verb, host-bound-first-arg
 * methods instead of a local driver -- the remote host performs its own
 * `validateVerbRequest()`/`checkAccess()`, so this function only has to
 * shape arguments, not validate them.
 *
 * @param {import('./pod-host-service.mjs').PodHostClient} client
 * @param {string} hostPubKey
 * @param {string} verb
 * @param {{name?: string}} params
 * @param {*} bodyJson
 * @param {URLSearchParams} searchParams
 * @returns {Promise<*>}
 */
async function dispatchToClient(client, hostPubKey, verb, params, bodyJson, searchParams) {
  const body = bodyJson && typeof bodyJson === 'object' ? bodyJson : {}
  switch (verb) {
    case POD_HOST_DESCRIBE_VERB:
      return client.describe(hostPubKey)
    case POD_HOST_VERB.LIST:
      return client.list(hostPubKey)
    case POD_HOST_VERB.SPAWN:
      return client.spawn(hostPubKey, body)
    case POD_HOST_VERB.STATUS:
      return client.status(hostPubKey, params.name)
    case POD_HOST_VERB.SEND:
      return client.send(hostPubKey, params.name, body.payload, body.to === undefined ? {} : { to: body.to })
    case POD_HOST_VERB.EXEC:
      return client.exec(hostPubKey, params.name, body.command, body.timeoutMs === undefined ? {} : { timeoutMs: body.timeoutMs })
    case POD_HOST_VERB.SNAPSHOT:
      return client.snapshot(hostPubKey, params.name)
    case POD_HOST_VERB.RESTORE:
      return client.restore(hostPubKey, params.name)
    case POD_HOST_VERB.DRAIN: {
      const cascadeParam = searchParams.get('cascade')
      return client.drain(hostPubKey, params.name, cascadeParam === null ? {} : { cascade: cascadeParam === 'true' })
    }
    default:
      throw new PodHostDriverError(POD_HOST_ERROR.EINVAL, `unknown verb '${verb}'`)
  }
}

/**
 * Build the gateway handler.
 *
 * @param {object} opts
 * @param {import('./pod-host-service.mjs').PodHostClient} [opts.client] -
 *   A client built with `createPodHostClient()`. Preferred over `peerNode`
 *   when the caller already has one (e.g. to share it across several
 *   gateways/services).
 * @param {object} [opts.peerNode] - Used to build a client internally
 *   (`createPodHostClient({peerNode})`) when `client` is not given. One of
 *   `client`/`peerNode` is required.
 * @param {Function|object|Map<string,string>} [opts.resolveHost] - Resolves
 *   the `:hostPodId` URL token to the actual mesh pubKey `client` methods
 *   expect. Defaults to "no hosts known" (every host path 404s) -- see
 *   `normalizeHostResolver()`'s doc comment for the function-vs-map shapes.
 * @param {Function} [opts.listHosts] - `() => Promise<array>` for `GET
 *   /hosts`; overrides the listing `resolveHost` would otherwise provide.
 * @param {(req: Request) => ({ok: boolean, pubKey?: string}|Promise<{ok: boolean, pubKey?: string}>)} opts.auth -
 *   REQUIRED. See module doc comment's "IDENTITY CAVEAT" -- this gateway
 *   acts on the mesh with its OWN identity; `auth()` is the operator's own
 *   gate on who may use it, not a mesh-level identity substitution.
 * @param {Function} [opts.onLog] - `(event, data) => void` debug logging.
 * @returns {(req: Request) => Promise<Response>}
 */
export function createPodHostGatewayHandler({
  client,
  peerNode,
  resolveHost,
  listHosts,
  auth,
  onLog,
} = {}) {
  const resolvedClient = client || (peerNode ? createPodHostClient({ peerNode }) : null)
  if (!resolvedClient || typeof resolvedClient.spawn !== 'function') {
    throw new Error('createPodHostGatewayHandler: client (or peerNode) is required')
  }
  if (typeof auth !== 'function') {
    throw new Error(
      'createPodHostGatewayHandler: auth(req) is required -- there is no default-open gateway '
      + '(see module doc comment\'s "IDENTITY CAVEAT")',
    )
  }
  const hostResolver = normalizeHostResolver(resolveHost, listHosts)
  const log = onLog || (() => {})

  /**
   * @param {Request} req
   * @returns {Promise<Response>}
   */
  async function handler(req) {
    const url = new URL(req.url)
    const method = (req.method || 'GET').toUpperCase()

    if (method === 'GET' && url.pathname === '/hosts') {
      const hosts = await hostResolver.list()
      return jsonResponse(200, { ok: true, result: hosts })
    }

    const hostMatch = url.pathname.match(/^\/hosts\/([^/]+)((?:\/.*)?)$/)
    if (!hostMatch) {
      return jsonResponse(404, { ok: false, error: { code: POD_HOST_ERROR.ENOENT, message: 'not found' } })
    }

    let hostToken
    try {
      hostToken = decodeURIComponent(hostMatch[1])
    } catch {
      return jsonResponse(400, { ok: false, error: { code: POD_HOST_ERROR.EINVAL, message: 'malformed host token' } })
    }
    const subPath = hostMatch[2] || ''
    const match = matchPodHostRoute(method, subPath)
    if (!match) {
      return jsonResponse(404, { ok: false, error: { code: POD_HOST_ERROR.ENOENT, message: `no such route '${method} ${subPath}'` } })
    }

    // Auth gates USE of the gateway; it does not change whose mesh identity
    // the downstream checkAccess() call sees (see "IDENTITY CAVEAT" above).
    const authResult = await auth(req)
    if (!authResult || authResult.ok !== true) {
      return jsonResponse(401, { ok: false, error: { code: POD_HOST_ERROR.EACCES, message: 'unauthorized' } })
    }

    const hostPubKey = await hostResolver.resolve(hostToken)
    if (!hostPubKey) {
      return jsonResponse(404, { ok: false, error: { code: POD_HOST_ERROR.ENOENT, message: `unknown host '${hostToken}'` } })
    }

    const bodyJson = await readHttpRequestBody(req)

    try {
      const result = await dispatchToClient(resolvedClient, hostPubKey, match.verb, match.params, bodyJson, url.searchParams)
      if (match.verb === POD_HOST_DESCRIBE_VERB) return jsonResponse(200, { ok: true, result })
      const status = successStatusForVerb(match.verb)
      if (status === 204) return new Response(null, { status })
      return jsonResponse(status, { ok: true, result })
    } catch (err) {
      const driverError = PodHostDriverError.from(err)
      log('pod-host-gateway:verb-failed', {
        host: hostToken, verb: match.verb, code: driverError.code, error: driverError.message,
      })
      const headers = { 'content-type': 'application/json' }
      if (driverError.code === POD_HOST_ERROR.ELANE) {
        // The remote error's `details` (which would carry `lane`) does not
        // survive the wire -- pod-host-service.mjs's createHostResponse()
        // only round-trips {code, message} (see its own toJSON()). Best
        // effort: ask the host what it actually serves. Never let this
        // extra round trip turn a real error response into a different
        // failure -- any problem with it is swallowed and Allow is omitted.
        try {
          const description = await resolvedClient.describe(hostPubKey)
          if (description && Array.isArray(description.verbs)) headers.allow = description.verbs.join(', ')
        } catch {
          // best-effort only
        }
      }
      return new Response(JSON.stringify({ ok: false, error: driverError.toJSON() }), { status: statusForError(driverError.code), headers })
    }
  }

  return handler
}

// ---------------------------------------------------------------------------
// serveNodeGateway -- node:http adapter, lazily imported (see module doc
// comment on why this keeps test/browser-safe-entry.test.mjs passing).
// ---------------------------------------------------------------------------

/** Headers that are transport-level and should not be forwarded into the synthetic `Request`. */
const HOP_BY_HOP_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade'])

/**
 * Convert one incoming `node:http` request/response pair into a Web-standard
 * `Request`, run `handler`, and write the resulting `Response` back out.
 * @param {(req: Request) => Promise<Response>} handler
 * @param {import('node:http').IncomingMessage} nodeReq
 * @param {import('node:http').ServerResponse} nodeRes
 */
async function handleNodeRequest(handler, nodeReq, nodeRes) {
  const host = nodeReq.headers.host || 'localhost'
  const url = `http://${host}${nodeReq.url}`

  const headers = new Headers()
  for (const [key, value] of Object.entries(nodeReq.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v)
    } else {
      headers.set(key, value)
    }
  }

  const method = (nodeReq.method || 'GET').toUpperCase()
  let body
  if (method !== 'GET' && method !== 'HEAD') {
    const chunks = []
    for await (const chunk of nodeReq) chunks.push(chunk)
    if (chunks.length > 0) body = Buffer.concat(chunks)
  }

  const request = new Request(url, { method, headers, body })
  const response = await handler(request)

  /** @type {Record<string, string>} */
  const resHeaders = {}
  response.headers.forEach((value, key) => { resHeaders[key] = value })
  nodeRes.writeHead(response.status, resHeaders)

  if (response.body) {
    const buf = Buffer.from(await response.arrayBuffer())
    nodeRes.end(buf)
  } else {
    nodeRes.end()
  }
}

/**
 * Serve a Web-standard `(req: Request) => Promise<Response>` handler (e.g.
 * `createPodHostGatewayHandler()`'s return value) over real `node:http`.
 *
 * @param {object} opts
 * @param {(req: Request) => Promise<Response>} opts.handler
 * @param {number} [opts.port=0] - `0` picks an ephemeral free port.
 * @param {string} [opts.host='127.0.0.1']
 * @returns {Promise<{server: import('node:http').Server, port: number, url: string, close: () => Promise<void>}>}
 */
export async function serveNodeGateway({ handler, port = 0, host = '127.0.0.1' } = {}) {
  if (typeof handler !== 'function') {
    throw new Error('serveNodeGateway: handler is required')
  }
  // Lazy -- see module doc comment. Only reached when this function is
  // actually called, never merely by importing this module (or the package
  // root, which re-exports it), so a browser bundle never resolves
  // `node:http` just for being loaded.
  const { createServer } = await import('node:http')

  const server = createServer((nodeReq, nodeRes) => {
    handleNodeRequest(handler, nodeReq, nodeRes).catch((err) => {
      if (!nodeRes.headersSent) nodeRes.writeHead(500, { 'content-type': 'application/json' })
      nodeRes.end(JSON.stringify({ ok: false, error: { code: POD_HOST_ERROR.EINVAL, message: err?.message || String(err) } }))
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(undefined))
  })

  const address = server.address()
  const actualPort = address && typeof address === 'object' ? address.port : port

  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    close() {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve(undefined)))
      })
    },
  }
}
