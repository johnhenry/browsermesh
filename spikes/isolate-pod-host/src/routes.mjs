/**
 * routes.mjs — the isolate pod host's HTTP route table (issue #185 WP2,
 * extended by the hosted-pods control surface work).
 *
 * The route set is a 1:1 HTTP projection of the eight verbs in
 * `@johnhenry/browsermesh-pod`'s `host-protocol.mjs`, so
 * `createIsolatePodDriver()` (`src/driver.mjs`) can be a thin `fetch`
 * wrapper rather than a second protocol:
 *
 *   GET    /pods                  → list
 *   POST   /pods/:name/boot       → spawn   (body: a podspec)
 *   GET    /pods/:name/status     → status
 *   POST   /pods/:name/send       → send    (body: {to, payload})
 *   POST   /pods/:name/exec       → 405 {code:'ELANE'}    (no shell in an isolate)
 *   POST   /pods/:name/snapshot   → 501 {code:'ENOTSUP'}  (DO hibernation is not a verb)
 *   POST   /pods/:name/restore    → 501 {code:'ENOTSUP'}
 *   DELETE /pods/:name            → drain
 *   GET    /health                → { status: 'ok' } — for the test harness only
 *
 * `GET /pods` needs something a Durable Object namespace does not provide:
 * enumeration. The Worker therefore keeps a roster in ONE extra DO
 * instance, `idFromName('__roster__')`, whose `/roster*` routes
 * `pod-object.mjs` also serves. A roster DO never boots a pod; it is just
 * the list.
 *
 * This lives in its own file, rather than inside `worker.mjs`, for one
 * reason: `worker.mjs` must re-export `PodObject`, which imports
 * `cloudflare:workers`, and that specifier does not resolve in Node.
 * Splitting the routes off lets `test/routes.test.mjs` drive every route
 * against a fake DO namespace under plain `node --test`, with no
 * `wrangler dev` process in the way.
 */

import { POD_HOST_ERROR, validatePodSpec } from '@johnhenry/browsermesh-pod'

const POD_ROUTE = /^\/pods\/([^/]+)(?:\/(boot|status|send|exec|snapshot|restore))?$/

/** The DO instance that holds the roster of spawned pod names. */
const ROSTER_NAME = '__roster__'

/** Which HTTP method each sub-route accepts. */
const METHOD_FOR = Object.freeze({ boot: 'POST', status: 'GET', send: 'POST' })

/**
 * @param {string} code - A `POD_HOST_ERROR` value.
 * @param {string} message
 * @param {number} status
 * @returns {Response}
 */
function errorResponse(code, message, status) {
  return Response.json({ code, message }, { status })
}

/**
 * @param {object} env
 * @param {string} name
 * @returns {object} A DO stub.
 */
function stubFor(env, name) {
  return env.POD.get(env.POD.idFromName(name))
}

/**
 * @param {object} env
 * @param {'add'|'remove'} action
 * @param {string} name
 * @returns {Promise<void>}
 */
async function updateRoster(env, action, name) {
  await stubFor(env, ROSTER_NAME).fetch(new Request(`http://pod/roster/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  }))
}

/**
 * @param {object} env
 * @returns {Promise<string[]>}
 */
async function readRoster(env) {
  const response = await stubFor(env, ROSTER_NAME).fetch(new Request('http://pod/roster', { method: 'GET' }))
  const body = await response.json()
  return body.names || []
}

/**
 * @param {Request} request
 * @param {{POD: object}} env
 * @returns {Promise<Response>}
 */
export async function handlePodHostRequest(request, env) {
  const url = new URL(request.url)

  if (request.method === 'GET' && url.pathname === '/health') {
    return Response.json({ status: 'ok' })
  }

  // -- list ------------------------------------------------------------
  if (url.pathname === '/pods') {
    if (request.method !== 'GET') {
      return errorResponse(POD_HOST_ERROR.EINVAL, 'method not allowed', 405)
    }
    const names = await readRoster(env)
    const pods = []
    for (const name of names) {
      const response = await stubFor(env, name).fetch(new Request('http://pod/status', { method: 'GET' }))
      pods.push(await response.json())
    }
    return Response.json(pods)
  }

  const match = url.pathname.match(POD_ROUTE)
  if (!match) {
    return errorResponse(POD_HOST_ERROR.ENOENT, 'not found', 404)
  }
  const [, rawName, action] = match
  const name = decodeURIComponent(rawName)

  // -- verbs this lane cannot serve --------------------------------------
  if (action === 'exec') {
    return errorResponse(
      POD_HOST_ERROR.ELANE,
      "lane 'isolate' cannot 'exec': a V8 isolate has no shell — use a microvm pod",
      405,
    )
  }
  if (action === 'snapshot' || action === 'restore') {
    return errorResponse(
      POD_HOST_ERROR.ENOTSUP,
      `'${action}' is not implemented for the isolate lane: Durable Object hibernation is automatic, not a verb`,
      501,
    )
  }

  // -- drain --------------------------------------------------------------
  if (!action) {
    if (request.method !== 'DELETE') {
      return errorResponse(POD_HOST_ERROR.EINVAL, 'method not allowed', 405)
    }
    const response = await stubFor(env, name).fetch(new Request('http://pod/drain', { method: 'POST' }))
    if (response.ok) await updateRoster(env, 'remove', name)
    return response
  }

  if (request.method !== METHOD_FOR[action]) {
    return errorResponse(POD_HOST_ERROR.EINVAL, 'method not allowed', 405)
  }

  // -- spawn ---------------------------------------------------------------
  if (action === 'boot') {
    const raw = await request.text()
    let spec = null
    if (raw.trim().length > 0) {
      let parsed
      try {
        parsed = JSON.parse(raw)
      } catch {
        return errorResponse(POD_HOST_ERROR.EINVAL, 'body must be JSON', 400)
      }
      // The URL is authoritative for the name: a podspec naming a
      // different pod than the route it was posted to is a mistake, not a
      // rename.
      const validated = validatePodSpec({ ...parsed, name })
      if (!validated.ok) {
        return errorResponse(POD_HOST_ERROR.EINVAL, validated.errors.join('; '), 400)
      }
      if (validated.value.lane !== 'isolate') {
        return errorResponse(
          POD_HOST_ERROR.ELANE,
          `this host runs the 'isolate' lane, not '${validated.value.lane}'`,
          409,
        )
      }
      spec = validated.value
    }

    const response = await stubFor(env, name).fetch(new Request('http://pod/boot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, spec }),
    }))
    if (response.ok) await updateRoster(env, 'add', name)
    return response
  }

  // -- status / send ---------------------------------------------------------
  if (action === 'status') {
    return stubFor(env, name).fetch(new Request('http://pod/status', { method: 'GET' }))
  }
  const body = await request.text()
  return stubFor(env, name).fetch(new Request('http://pod/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }))
}
