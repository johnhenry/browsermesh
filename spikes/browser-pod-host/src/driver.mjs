/**
 * driver.mjs — `PodHostDriver` for the browser lane's **CDP** (remote
 * debugging protocol) driver (issue #185 item 7, deliverable B).
 *
 * Where the in-page driver (`@johnhenry/browsermesh-pod`'s
 * `browser-host-driver.mjs`) IS a page spawning siblings it has no
 * privilege over, this driver is an OPERATOR PROCESS outside the browser
 * entirely, talking to it over `cdp.mjs`'s WebSocket client. That external
 * vantage point is what unlocks `exec` for real: `Runtime.evaluate()` runs
 * with the full authority a remote debugging port already grants, so there
 * is no additional trust boundary being crossed the way there would be for
 * a parent tab reaching into a child it spawned.
 *
 *   - `spawn`  → `Target.createBrowserContext` (when `contextPerPod`, the
 *     default — one tenant's pods never share cookies/storage/origin state
 *     with another's) + `Target.createTarget` + `Target.attachToTarget`
 *     (flat session mode) + `Runtime.enable`, then POLL
 *     `Runtime.evaluate('window.__browsermeshHosted...')` until the pod
 *     page's own bootstrap (`static/pod.html`) sets that global. Polling
 *     rather than `Runtime.addBinding` + an exposed function on purpose:
 *     one `Runtime.evaluate` round trip per poll is simpler to reason
 *     about and test against a fake `cdp`, at the cost of up to one poll
 *     interval of extra latency — acceptable for a spike.
 *   - `exec`   → `Runtime.evaluate(argv[0])` — see the module doc comment
 *     for WHY this is supported here (DECISION, issue #185 item 7): this
 *     is SCRIPT EVALUATION, not a shell. `argv[0]` is a JS expression
 *     string; the result's `JSON.stringify` becomes `stdout`, an
 *     exception's text becomes `stderr` with `code: 1`. Gated by
 *     `checkAccess()` exactly like any other lane's `exec`, through
 *     `createPodHostService()` — nothing in this driver bypasses that.
 *   - `snapshot`/`restore` → `ENOTSUP`. Not implemented this wave (no
 *     durable serialization of a page's heap over CDP exists here); see
 *     the extension driver's `chrome.tabs.discard`/reload pair for a
 *     weaker but real pause/resume this lane could grow toward.
 *   - `drain`  → `Target.closeTarget` + (if `contextPerPod`)
 *     `Target.disposeBrowserContext`.
 */

import {
  POD_HOST_VERB,
  POD_HOST_ERROR,
  POD_HOST_EVENT_KIND,
  POD_LANE,
  POD_LIFECYCLE,
  PodHostDriverError,
  canTransition,
  createHostEvent,
  createUnsupportedDriverMethod,
  validatePodSpec,
} from '../../../packages/browsermesh-pod/src/index.mjs'

/** Verbs this driver serves. */
const VERBS = Object.freeze([
  POD_HOST_VERB.SPAWN, POD_HOST_VERB.STATUS, POD_HOST_VERB.SEND, POD_HOST_VERB.EXEC,
  POD_HOST_VERB.DRAIN, POD_HOST_VERB.LIST,
])

const DEFAULT_SPAWN_TIMEOUT_MS = 10_000
const READY_POLL_INTERVAL_MS = 50

/** The expression polled against the page to detect `static/pod.html`'s readiness global. */
const READY_PROBE = "(window.__browsermeshHosted && window.__browsermeshHosted.ready) "
  + "? {ready: true, podId: window.__browsermeshHosted.podId, name: window.__browsermeshHosted.name} "
  + ': { ready: false }'

/**
 * @param {string} podUrl
 * @param {string} name
 * @returns {string}
 */
function buildChildUrl(podUrl, name) {
  const sep = podUrl.includes('#') ? '&' : '#'
  return `${podUrl}${sep}name=${encodeURIComponent(name)}`
}

/**
 * Build a `PodHostDriver` that drives browser-lane pods over a live CDP
 * connection.
 *
 * @param {object} opts
 * @param {import('./cdp.mjs').connect extends (...args: any) => infer R ? R : never} opts.cdp -
 *   A `connect()` result (browser-level, not pre-attached to any target).
 * @param {string} opts.podUrl - URL every spawned pod page boots (expected
 *   to be `static/pod.html`, or an equivalent page calling `bootHostedPod()`
 *   and publishing `window.__browsermeshHosted`).
 * @param {boolean} [opts.contextPerPod=true] - Isolate each pod in its own
 *   `Target.createBrowserContext` (separate cookies/storage/origin state).
 * @param {number} [opts.spawnTimeoutMs=10000]
 * @returns {import('../../../packages/browsermesh-pod/src/index.mjs').PodHostDriver}
 */
export function createCdpDriver({ cdp, podUrl, contextPerPod = true, spawnTimeoutMs = DEFAULT_SPAWN_TIMEOUT_MS } = {}) {
  if (!cdp || typeof cdp.send !== 'function') {
    throw new Error('createCdpDriver: cdp (a connect() result) is required')
  }
  if (!podUrl || typeof podUrl !== 'string') {
    throw new Error('createCdpDriver: podUrl is required')
  }

  /** @type {Map<string, object>} */
  const pods = new Map()
  /** @type {Set<(event: object) => void>} */
  const listeners = new Set()

  function emit(event) {
    for (const fn of [...listeners]) {
      try { fn(event) } catch { /* a throwing subscriber never breaks the driver */ }
    }
  }

  function transition(record, to, reason) {
    if (!canTransition(record.state, to)) {
      throw new PodHostDriverError(
        POD_HOST_ERROR.EBUSY,
        `pod '${record.name}' cannot go ${record.state} -> ${to}`,
        { name: record.name, from: record.state, to },
      )
    }
    const from = record.state
    record.state = to
    record.updatedAt = Date.now()
    emit(createHostEvent(POD_HOST_EVENT_KIND.LIFECYCLE, {
      name: record.name, lane: POD_LANE.BROWSER, from, to, reason,
    }))
  }

  function require_(name) {
    const record = pods.get(name)
    if (!record) throw new PodHostDriverError(POD_HOST_ERROR.ENOENT, `no pod named '${name}'`, { name })
    return record
  }

  function requireLive(name) {
    const record = require_(name)
    if (record.state === POD_LIFECYCLE.GONE) {
      throw new PodHostDriverError(POD_HOST_ERROR.ENOENT, `pod '${name}' is gone`, { name })
    }
    return record
  }

  function snapshotOf(record) {
    return {
      name: record.name,
      lane: POD_LANE.BROWSER,
      state: record.state,
      spec: record.spec,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      podId: record.podId,
      targetId: record.targetId,
    }
  }

  /**
   * @param {object} record
   * @param {string} expression
   * @param {{awaitPromise?: boolean, returnByValue?: boolean}} [opts]
   */
  function evaluate(record, expression, { awaitPromise = true, returnByValue = true } = {}) {
    return cdp.send('Runtime.evaluate', { expression, returnByValue, awaitPromise }, record.sessionId)
  }

  async function waitForReady(record, ms) {
    const deadline = Date.now() + ms
    for (;;) {
      const result = await evaluate(record, READY_PROBE)
      const value = result?.result?.value
      if (value?.ready && value.name === record.name) return value
      if (Date.now() >= deadline) {
        throw new PodHostDriverError(
          POD_HOST_ERROR.ETIMEDOUT,
          `pod '${record.name}' did not set window.__browsermeshHosted.ready within ${ms}ms`,
          { name: record.name },
        )
      }
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS))
    }
  }

  return {
    lane: POD_LANE.BROWSER,

    capabilities() {
      return { verbs: [...VERBS] }
    },

    onEvent(fn) {
      if (typeof fn !== 'function') return () => {}
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },

    async spawn(spec) {
      const validated = validatePodSpec(spec)
      if (!validated.ok) {
        throw new PodHostDriverError(POD_HOST_ERROR.EINVAL, validated.errors.join('; '), { errors: validated.errors })
      }
      const value = validated.value
      if (value.lane !== POD_LANE.BROWSER) {
        throw new PodHostDriverError(
          POD_HOST_ERROR.ELANE,
          `this host runs the '${POD_LANE.BROWSER}' lane, not '${value.lane}'`,
          { lane: value.lane },
        )
      }
      const existing = pods.get(value.name)
      if (existing && existing.state !== POD_LIFECYCLE.GONE) {
        throw new PodHostDriverError(POD_HOST_ERROR.EEXIST, `pod '${value.name}' already exists`, { name: value.name })
      }

      const now = Date.now()
      const record = {
        name: value.name,
        spec: value,
        state: POD_LIFECYCLE.COLD,
        createdAt: now,
        updatedAt: now,
        podId: null,
        browserContextId: null,
        targetId: null,
        sessionId: null,
      }
      pods.set(value.name, record)
      transition(record, POD_LIFECYCLE.BOOTING, 'spawn')

      try {
        if (contextPerPod) {
          const { browserContextId } = await cdp.send('Target.createBrowserContext')
          record.browserContextId = browserContextId
        }
        const url = buildChildUrl(podUrl, value.name)
        const { targetId } = await cdp.send('Target.createTarget', {
          url,
          ...(record.browserContextId ? { browserContextId: record.browserContextId } : {}),
        })
        record.targetId = targetId
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
        record.sessionId = sessionId
        await cdp.send('Runtime.enable', {}, sessionId)

        const ready = await waitForReady(record, spawnTimeoutMs)
        record.podId = ready.podId ?? null
        transition(record, POD_LIFECYCLE.REGISTERED, 'child-ready')
      } catch (err) {
        record.state = POD_LIFECYCLE.GONE
        if (err instanceof PodHostDriverError) throw err
        throw new PodHostDriverError(POD_HOST_ERROR.EINVAL, `failed to spawn '${value.name}': ${err.message}`, { name: value.name })
      }

      return snapshotOf(record)
    },

    async status(name) {
      return snapshotOf(require_(name))
    },

    async send(name, msg) {
      const record = requireLive(name)
      const expression = `window.__browsermeshHosted && window.__browsermeshHosted.send(${JSON.stringify(msg?.payload ?? null)})`
      await evaluate(record, expression, { awaitPromise: false, returnByValue: false })
      return { delivered: true, to: msg?.to ?? null }
    },

    // See the module doc comment: DECISION, issue #185 item 7 — supported,
    // because a CDP operator already has full remote control of the
    // browser. `argv[0]` is a JS expression, not a shell command.
    async exec(name, argv) {
      const record = requireLive(name)
      const expression = Array.isArray(argv) ? String(argv[0] ?? '') : String(argv)
      let result
      try {
        result = await evaluate(record, expression)
      } catch (err) {
        return { stdout: '', stderr: err.message || String(err), code: 1 }
      }
      if (result?.exceptionDetails) {
        const text = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation threw'
        return { stdout: '', stderr: text, code: 1 }
      }
      const value = result?.result?.value
      return { stdout: typeof value === 'string' ? value : JSON.stringify(value ?? null), stderr: '', code: 0 }
    },

    // Not implemented this wave — see the module doc comment.
    snapshot: createUnsupportedDriverMethod(POD_HOST_VERB.SNAPSHOT, POD_LANE.BROWSER, { code: POD_HOST_ERROR.ENOTSUP }),
    restore: createUnsupportedDriverMethod(POD_HOST_VERB.RESTORE, POD_LANE.BROWSER, { code: POD_HOST_ERROR.ENOTSUP }),

    async drain(name, opts = {}) {
      const record = require_(name)
      if (record.state !== POD_LIFECYCLE.GONE) {
        if (record.state !== POD_LIFECYCLE.DRAINING) transition(record, POD_LIFECYCLE.DRAINING, 'drain')
        if (record.targetId) {
          try { await cdp.send('Target.closeTarget', { targetId: record.targetId }) } catch { /* best effort */ }
        }
        if (record.browserContextId) {
          try { await cdp.send('Target.disposeBrowserContext', { browserContextId: record.browserContextId }) } catch { /* best effort */ }
        }
        transition(record, POD_LIFECYCLE.GONE, 'drain')
      }
      emit(createHostEvent(POD_HOST_EVENT_KIND.EXIT, {
        name, lane: POD_LANE.BROWSER, code: 0, cascade: opts.cascade === true,
      }))
      return snapshotOf(record)
    },

    async list() {
      return [...pods.values()].map((record) => snapshotOf(record))
    },
  }
}
