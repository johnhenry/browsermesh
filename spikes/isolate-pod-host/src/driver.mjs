/**
 * driver.mjs — `PodHostDriver` for the isolate lane (issue #185's
 * hosted-pods control surface, item 2).
 *
 * Unlike the microVM driver, this one runs OUTSIDE the thing it drives: the
 * pods live in Durable Objects inside `workerd`/Cloudflare Workers, and the
 * only way in is HTTP. So `createIsolatePodDriver()` is a Node-side `fetch`
 * client for the routes `worker.mjs` exposes, translating HTTP status codes
 * and `{code, message}` bodies back into `PodHostDriverError`s.
 *
 * That split is the point of the protocol living in
 * `@johnhenry/browsermesh-pod`: the Worker imports the same
 * `validatePodSpec()` and the same `POD_HOST_ERROR` codes this file does,
 * without either side importing `browsermesh-apps`.
 *
 * Three verbs are refused, and the refusal is part of the contract rather
 * than a gap to fill in later:
 *   - `exec`   → `ELANE`.   A V8 isolate has no shell. Use a microvm pod.
 *   - `snapshot`/`restore` → `ENOTSUP`. Durable Objects hibernate and
 *     rehydrate automatically; there is no caller-driven freeze/thaw to
 *     expose. `ENOTSUP` rather than `ELANE` because a future isolate host
 *     could plausibly expose DO storage export/import under these verbs.
 */

import {
  POD_HOST_ERROR,
  POD_HOST_VERB,
  POD_LANE,
  PodHostDriverError,
  validatePodSpec,
} from '@johnhenry/browsermesh-pod'

/** Verbs the Worker actually serves. */
const VERBS = Object.freeze([
  POD_HOST_VERB.SPAWN, POD_HOST_VERB.STATUS, POD_HOST_VERB.SEND,
  POD_HOST_VERB.DRAIN, POD_HOST_VERB.LIST,
])

/** HTTP status -> `POD_HOST_ERROR` fallback, for a response with no `code` in its body. */
const STATUS_CODES = Object.freeze({
  400: POD_HOST_ERROR.EINVAL,
  403: POD_HOST_ERROR.EACCES,
  404: POD_HOST_ERROR.ENOENT,
  405: POD_HOST_ERROR.ELANE,
  409: POD_HOST_ERROR.EEXIST,
  501: POD_HOST_ERROR.ENOTSUP,
})

/**
 * Build a `PodHostDriver` that drives a running isolate pod host over HTTP.
 *
 * @param {object} opts
 * @param {string} opts.baseUrl - Where the Worker is listening, e.g.
 *   `http://localhost:8787` (a trailing slash is tolerated).
 * @param {typeof globalThis.fetch} [opts.fetch] - Injectable, like every
 *   other adapter in this family. Defaults to the global `fetch`.
 * @returns {import('@johnhenry/browsermesh-pod').PodHostDriver}
 */
export function createIsolatePodDriver({ baseUrl, fetch: fetchImpl } = {}) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new Error('createIsolatePodDriver: baseUrl is required')
  }
  const doFetch = fetchImpl || globalThis.fetch
  if (typeof doFetch !== 'function') {
    throw new Error('createIsolatePodDriver: no fetch available — pass one')
  }
  const root = baseUrl.replace(/\/+$/, '')

  /**
   * @param {string} path
   * @param {object} [init]
   * @returns {Promise<*>} The parsed JSON body of a 2xx response.
   */
  async function call(path, init = {}) {
    let response
    try {
      response = await doFetch(`${root}${path}`, init)
    } catch (err) {
      // The host is unreachable, which is not any of the pod-level errors.
      throw new PodHostDriverError(
        POD_HOST_ERROR.ETIMEDOUT,
        `isolate pod host at ${root} is unreachable: ${err?.message || String(err)}`,
        { path },
      )
    }

    const text = await response.text()
    let body = null
    if (text.length > 0) {
      try {
        body = JSON.parse(text)
      } catch {
        body = { message: text }
      }
    }

    if (!response.ok) {
      const code = (body && typeof body.code === 'string' && body.code)
        || STATUS_CODES[response.status]
        || POD_HOST_ERROR.EINVAL
      const message = (body && (body.message || body.error)) || `HTTP ${response.status}`
      throw new PodHostDriverError(code, message, { path, status: response.status })
    }
    return body
  }

  /**
   * The Worker answers `/status` for a name it has never heard of with a
   * `state: 'cold'`, `podId: null` record rather than a 404 (a Durable
   * Object always exists, it has just never been addressed). The protocol
   * says that is `ENOENT`, so the translation happens here.
   * @param {object} status
   * @param {string} name
   * @returns {object}
   */
  function requireKnown(status, name) {
    if (!status || (status.name === null && status.podId === null && !status.booted)) {
      throw new PodHostDriverError(POD_HOST_ERROR.ENOENT, `no pod named '${name}'`, { name })
    }
    return status
  }

  return {
    lane: POD_LANE.ISOLATE,

    capabilities() {
      return { verbs: [...VERBS] }
    },

    async spawn(spec) {
      const validated = validatePodSpec(spec)
      if (!validated.ok) {
        throw new PodHostDriverError(POD_HOST_ERROR.EINVAL, validated.errors.join('; '), {
          errors: validated.errors,
        })
      }
      const value = validated.value
      if (value.lane !== POD_LANE.ISOLATE) {
        throw new PodHostDriverError(
          POD_HOST_ERROR.ELANE,
          `this host runs the '${POD_LANE.ISOLATE}' lane, not '${value.lane}'`,
          { lane: value.lane },
        )
      }
      return call(`/pods/${encodeURIComponent(value.name)}/boot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      })
    },

    async status(name) {
      return requireKnown(await call(`/pods/${encodeURIComponent(name)}/status`), name)
    },

    async send(name, msg) {
      return call(`/pods/${encodeURIComponent(name)}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: msg?.to, payload: msg?.payload }),
      })
    },

    // These three reach the Worker on purpose rather than short-circuiting
    // locally: the HTTP contract is what a non-JS client would see, and a
    // test that only exercised a local throw would never notice the routes
    // drifting.
    async exec(name, argv) {
      return call(`/pods/${encodeURIComponent(name)}/exec`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: argv }),
      })
    },

    async snapshot(name) {
      return call(`/pods/${encodeURIComponent(name)}/snapshot`, { method: 'POST' })
    },

    async restore(name) {
      return call(`/pods/${encodeURIComponent(name)}/restore`, { method: 'POST' })
    },

    async drain(name) {
      return call(`/pods/${encodeURIComponent(name)}`, { method: 'DELETE' })
    },

    async list() {
      return call('/pods')
    },
  }
}
