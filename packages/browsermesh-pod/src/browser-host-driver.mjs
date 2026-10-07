/**
 * browser-host-driver.mjs — the **in-page** `PodHostDriver` for the browser
 * lane (issue #185 item 7, deliverable A).
 *
 * Of the browser lane's three drivers (in-page, here; CDP,
 * `spikes/browser-pod-host`; extension, `spikes/browser-extension-host`),
 * this is the one that needs NOTHING beyond what a page already has: no
 * remote debugging port, no extension privileges, zero dependencies. A tab
 * (or a worker) drives sibling pages/workers it itself spawned, using
 * `iframe`/`window.open`/`Worker` and `BroadcastChannel` — the same
 * primitives `Pod` already uses for peer discovery.
 *
 * That is also exactly its limit. A parent tab has no privilege boundary
 * against a child it spawned the same way any other tab could: same-origin
 * JS can already reach into same-origin children via `contentWindow`/
 * `postMessage`, and a CROSS-origin child cannot be evaluated into safely
 * from here at all (there is no sandbox, no attestation, nothing stopping
 * the child from lying about what it evaluated). So `exec` — which the
 * browser lane defines as "evaluate an expression in the page's JS
 * context" (see `host-protocol.mjs`'s `POD_LANE_VERBS` doc comment) — is a
 * verb this driver deliberately never implements: `ENOTSUP`, not because
 * nobody got around to it, but because an in-page driver's architecture has
 * no safe way to do it, same-origin or not. `snapshot`/`restore` are
 * `ENOTSUP` for the same "not this wave" reason the module doc comment
 * below spells out — a durable soft-snapshot to IndexedDB is a plausible
 * follow-up, just not implemented here.
 *
 * ── How a spawned pod is found ──────────────────────────────────────────
 *
 * `spawn()` creates the child (iframe / window / worker) pointed at
 * `podUrl` with the pod's name encoded two ways — `iframe.name` /
 * `window.open()`'s name argument / `new Worker(url, {name})`, AND a
 * `#name=…` URL-hash fallback — and then waits on the SAME
 * `BroadcastChannel` (`channel`, shared with the child via
 * `browser-host-child.mjs`'s `bootHostedPod()`) for a
 * `browser-host:ready` announcement naming it. See that module's doc
 * comment for why a broadcast rather than a new wire message type.
 *
 * ── Sending ──────────────────────────────────────────────────────────────
 *
 * `send()` goes over `postMessage` directly to the child's own global
 * (`contentWindow` / window ref / worker ref) rather than through
 * `BroadcastChannel` — `BroadcastChannel` fans out to every same-origin
 * context on the channel, including the driver's own listener and any
 * sibling pods; `postMessage` to a specific target is the one-to-one
 * delivery `send(name, {to, payload})` promises.
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
  validatePodSpec,
} from './host-protocol.mjs'
import { POD_MESSAGE, createMessage } from './messages.mjs'
import { DEFAULT_DISCOVERY_CHANNEL, BROWSER_HOST_READY } from './browser-host-child.mjs'

export { DEFAULT_DISCOVERY_CHANNEL }

/** Verbs this driver actually serves — a strict subset of what the browser
 * lane structurally allows (`POD_LANE_VERBS[POD_LANE.BROWSER]`); `exec` is
 * lane-capable but not implemented here, see the module doc comment. */
const VERBS = Object.freeze([
  POD_HOST_VERB.SPAWN, POD_HOST_VERB.STATUS, POD_HOST_VERB.SEND,
  POD_HOST_VERB.DRAIN, POD_HOST_VERB.LIST,
])

const SPAWN_KINDS = Object.freeze(['iframe', 'window', 'worker'])

/** Default budget for `spawn()`'s wait on the child's `browser-host:ready`. */
const DEFAULT_SPAWN_TIMEOUT_MS = 5000

/**
 * Build the child page URL, encoding `name` as both the primary channel
 * (`g.name` / `window.open` name / `Worker`'s `name` option, set by the
 * caller) AND a `#name=…` hash fallback `browser-host-child.mjs`'s
 * `readPodName()` also understands.
 * @param {string} podUrl
 * @param {string} name
 * @returns {string}
 */
function buildChildUrl(podUrl, name) {
  const sep = podUrl.includes('#') ? '&' : '#'
  return `${podUrl}${sep}name=${encodeURIComponent(name)}`
}

/**
 * Build a `PodHostDriver` that spawns and controls browser-lane pods from
 * inside a page, using only platform primitives (`iframe`, `window.open`,
 * `Worker`, `BroadcastChannel`, `postMessage`).
 *
 * @param {object} opts
 * @param {object} [opts.globalThis=globalThis] - The hosting page/worker's
 *   global. Override for testing with a fake `document`/`open`/`Worker`.
 * @param {string} opts.podUrl - The URL of the page every spawned pod
 *   boots (expected to call `bootHostedPod()` from `browser-host-child.mjs`).
 * @param {string} [opts.channel=DEFAULT_DISCOVERY_CHANNEL] - BroadcastChannel
 *   name shared with spawned children.
 * @param {'iframe'|'window'|'worker'} [opts.spawnKind='iframe'] - How to
 *   create a child: an `<iframe>`, a `window.open()` popup, or a dedicated
 *   `Worker`.
 * @param {number} [opts.timeoutMs=5000] - How long `spawn()` waits for the
 *   child's readiness announcement before rejecting `ETIMEDOUT`.
 * @param {number} [opts.childHandshakeTimeoutMs] - Forwarded as the booted
 *   child's `handshakeTimeout` (only meaningful if the test harness also
 *   calls `bootHostedPod()` with it; a real page reads its own default).
 * @param {number} [opts.childDiscoveryTimeoutMs] - Same, for `discoveryTimeout`.
 * @param {Function} [opts.BCConstructor] - `BroadcastChannel` constructor
 *   override, for testing with a fake bus. Defaults to `globalThis.BroadcastChannel`.
 * @param {string} [opts.driverId='browser-host-driver'] - The `from` this
 *   driver stamps on messages it sends via `send()`.
 * @returns {import('./host-protocol.mjs').PodHostDriver}
 */
export function createInPageDriver({
  globalThis: g = globalThis,
  podUrl,
  channel = DEFAULT_DISCOVERY_CHANNEL,
  spawnKind = 'iframe',
  timeoutMs = DEFAULT_SPAWN_TIMEOUT_MS,
  childHandshakeTimeoutMs,
  childDiscoveryTimeoutMs,
  BCConstructor,
  driverId = 'browser-host-driver',
} = {}) {
  if (!podUrl || typeof podUrl !== 'string') {
    throw new Error('createInPageDriver: podUrl is required')
  }
  if (!SPAWN_KINDS.includes(spawnKind)) {
    throw new Error(`createInPageDriver: spawnKind must be one of ${SPAWN_KINDS.join('|')}`)
  }
  const BC = BCConstructor || g.BroadcastChannel
  if (typeof BC !== 'function') {
    throw new Error('createInPageDriver: no BroadcastChannel available — pass opts.BCConstructor for a fake')
  }

  /** @type {Map<string, object>} name -> pod record */
  const pods = new Map()
  /** @type {Set<(event: object) => void>} */
  const listeners = new Set()

  /** @param {object} event */
  function emit(event) {
    for (const fn of [...listeners]) {
      try { fn(event) } catch { /* a throwing subscriber never breaks the driver */ }
    }
  }

  /**
   * @param {object} record
   * @param {string} to
   * @param {string} reason
   */
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

  // A single listening channel, opened up front (not lazily on first
  // spawn) so there is no race between "child announces ready" and "driver
  // starts listening" -- the channel is live before any child can exist.
  const listenChannel = new BC(channel)
  listenChannel.onmessage = (event) => handleIncoming(event?.data)

  /** @param {*} data */
  function handleIncoming(data) {
    if (!data || data.type !== POD_MESSAGE) return
    const payload = data.payload
    if (!payload || payload.kind !== BROWSER_HOST_READY) return
    const record = pods.get(payload.name)
    if (!record || record.state === POD_LIFECYCLE.GONE) return
    record.podId = data.from ?? payload.podId ?? null
    if (record.state === POD_LIFECYCLE.BOOTING) transition(record, POD_LIFECYCLE.REGISTERED, 'child-ready')
    if (record.readyWaiters) {
      for (const resolve of record.readyWaiters) resolve()
      record.readyWaiters.clear()
    }
  }

  /**
   * @param {object} record
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function waitForReady(record, ms) {
    if (record.state === POD_LIFECYCLE.REGISTERED) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.readyWaiters.delete(onReady)
        reject(new PodHostDriverError(
          POD_HOST_ERROR.ETIMEDOUT,
          `pod '${record.name}' did not announce '${BROWSER_HOST_READY}' within ${ms}ms`,
          { name: record.name },
        ))
      }, ms)
      function onReady() {
        clearTimeout(timer)
        resolve()
      }
      record.readyWaiters.add(onReady)
    })
  }

  /**
   * @param {string} verb
   */
  function requireVerb(verb) {
    if (VERBS.includes(verb)) return
    throw new PodHostDriverError(
      POD_HOST_ERROR.ENOTSUP,
      `in-page driver (lane 'browser') does not implement '${verb}'`,
      { verb, lane: POD_LANE.BROWSER },
    )
  }

  /** @param {string} name @returns {object} */
  function require_(name) {
    const record = pods.get(name)
    if (!record) throw new PodHostDriverError(POD_HOST_ERROR.ENOENT, `no pod named '${name}'`, { name })
    return record
  }

  /** @param {string} name @returns {object} */
  function requireLive(name) {
    const record = require_(name)
    if (record.state === POD_LIFECYCLE.GONE) {
      throw new PodHostDriverError(POD_HOST_ERROR.ENOENT, `pod '${name}' is gone`, { name })
    }
    return record
  }

  /** @param {object} record @returns {import('./host-protocol.mjs').PodHostStatus} */
  function snapshotOf(record) {
    return {
      name: record.name,
      lane: POD_LANE.BROWSER,
      state: record.state,
      spec: record.spec,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      podId: record.podId,
      kind: record.kind,
    }
  }

  /**
   * Create the child browsing context for `spawnKind`, wired to `url`.
   * @param {string} name
   * @param {string} url
   * @returns {{kind: string, ref: *}}
   */
  function createChild(name, url) {
    if (spawnKind === 'iframe') {
      if (!g.document || typeof g.document.createElement !== 'function') {
        throw new Error('createInPageDriver: globalThis.document.createElement is required for spawnKind "iframe"')
      }
      const iframe = g.document.createElement('iframe')
      iframe.name = name
      // Insert before setting `src`: some engines defer the initial
      // navigation of a detached iframe, so appending first is the more
      // portable order even though the fake harness in tests would accept
      // either.
      const parent = g.document.body || g.document
      parent.appendChild(iframe)
      iframe.src = url
      return { kind: 'iframe', ref: iframe }
    }
    if (spawnKind === 'window') {
      if (typeof g.open !== 'function') {
        throw new Error('createInPageDriver: globalThis.open is required for spawnKind "window"')
      }
      const win = g.open(url, name)
      if (!win) {
        throw new PodHostDriverError(POD_HOST_ERROR.EINVAL, `window.open('${url}', '${name}') returned no window (popup blocked?)`, { name })
      }
      return { kind: 'window', ref: win }
    }
    // worker
    if (typeof g.Worker !== 'function') {
      throw new Error('createInPageDriver: globalThis.Worker is required for spawnKind "worker"')
    }
    const worker = new g.Worker(url, { name, type: 'module' })
    return { kind: 'worker', ref: worker }
  }

  /** @param {object} handle */
  function destroyChild(handle) {
    if (!handle) return
    if (handle.kind === 'iframe') {
      const el = handle.ref
      if (typeof el.remove === 'function') el.remove()
      else if (el.parentNode && typeof el.parentNode.removeChild === 'function') el.parentNode.removeChild(el)
    } else if (handle.kind === 'window') {
      if (typeof handle.ref.close === 'function') handle.ref.close()
    } else if (handle.kind === 'worker') {
      if (typeof handle.ref.terminate === 'function') handle.ref.terminate()
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
      requireVerb(POD_HOST_VERB.SPAWN)
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
        kind: spawnKind,
        handle: null,
        readyWaiters: new Set(),
      }
      pods.set(value.name, record)
      transition(record, POD_LIFECYCLE.BOOTING, 'spawn')

      const url = buildChildUrl(podUrl, value.name)
      try {
        record.handle = createChild(value.name, url)
      } catch (err) {
        record.state = POD_LIFECYCLE.GONE
        if (err instanceof PodHostDriverError) throw err
        throw new PodHostDriverError(POD_HOST_ERROR.EINVAL, `failed to spawn '${value.name}': ${err.message}`, { name: value.name })
      }

      await waitForReady(record, timeoutMs)
      return snapshotOf(record)
    },

    async status(name) {
      requireVerb(POD_HOST_VERB.STATUS)
      return snapshotOf(require_(name))
    },

    async send(name, msg) {
      requireVerb(POD_HOST_VERB.SEND)
      const record = requireLive(name)
      if (!record.handle) {
        throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, `pod '${name}' has no live browsing context`, { name })
      }
      const envelope = createMessage({ from: driverId, to: record.podId ?? '*', payload: msg?.payload ?? null })
      const target = record.handle.kind === 'iframe' ? record.handle.ref.contentWindow : record.handle.ref
      if (!target || typeof target.postMessage !== 'function') {
        throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, `pod '${name}' has no reachable postMessage target`, { name })
      }
      if (record.handle.kind === 'worker') target.postMessage(envelope)
      else target.postMessage(envelope, '*')
      return { delivered: true, to: msg?.to ?? null }
    },

    // `exec` is lane-capable on 'browser' (it means "evaluate script in the
    // page" -- see host-protocol.mjs's POD_LANE_VERBS doc comment) but this
    // driver never implements it: a parent tab has no safe way to evaluate
    // code in a cross-origin child it spawned. Use the CDP or extension
    // driver, which run with an operator's out-of-band control instead of
    // borrowing the hosted page's own (nonexistent) trust boundary.
    async exec() {
      requireVerb(POD_HOST_VERB.EXEC) // always throws -- EXEC is not in VERBS
    },

    // A durable soft-snapshot (serialize reachable pod state to IndexedDB,
    // restore by re-spawning and replaying it) is a plausible follow-up,
    // not implemented in this wave.
    async snapshot() {
      requireVerb(POD_HOST_VERB.SNAPSHOT)
    },

    async restore() {
      requireVerb(POD_HOST_VERB.RESTORE)
    },

    async drain(name, opts = {}) {
      requireVerb(POD_HOST_VERB.DRAIN)
      const record = require_(name)
      if (record.state !== POD_LIFECYCLE.GONE) {
        if (record.state !== POD_LIFECYCLE.DRAINING) transition(record, POD_LIFECYCLE.DRAINING, 'drain')
        destroyChild(record.handle)
        record.handle = null
        transition(record, POD_LIFECYCLE.GONE, 'drain')
      }
      emit(createHostEvent(POD_HOST_EVENT_KIND.EXIT, {
        name, lane: POD_LANE.BROWSER, code: 0, cascade: opts.cascade === true,
      }))
      return snapshotOf(record)
    },

    async list() {
      requireVerb(POD_HOST_VERB.LIST)
      return [...pods.values()].map((record) => snapshotOf(record))
    },

    // Not part of the `PodHostDriver` typedef -- a test/teardown convenience
    // so nothing keeps a (real) BroadcastChannel, and therefore the event
    // loop, alive after a suite is done with this driver.
    close() {
      try { listenChannel.close() } catch { /* already closed */ }
      listeners.clear()
    },
  }
}
