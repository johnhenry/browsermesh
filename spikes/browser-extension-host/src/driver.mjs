/**
 * driver.mjs — `PodHostDriver` for the browser lane's **extension**
 * driver (issue #185 item 7, deliverable C). An installed MV3 extension's
 * background service worker (`background.mjs`) runs this, driving pod
 * pages through `chrome.tabs`/`chrome.scripting`/`chrome.storage` rather
 * than a page's own DOM primitives (the in-page driver) or an external
 * debugging port (the CDP driver) — see `docs/hosted-pods.md` §8b.
 *
 * ── spawn modes ───────────────────────────────────────────────────────
 *
 * The task framing for this driver describes two spawn styles — "the pod
 * page boots itself" vs. "inject the bootstrap" — as `spec.run.kind:
 * 'page'|'inject'`. That collides with the shared protocol:
 * `validatePodSpec()`'s `run.kind` is a closed enum
 * (`skill`/`module`/`rootfs`/`command`), so a `'page'`/`'inject'` value
 * would fail validation before this driver ever saw it. `run.input` is the
 * one podspec field explicitly passed through unvalidated (see
 * `host-protocol.mjs`), so the mode lives there instead:
 * `run.input.mode === 'inject'` triggers `chrome.scripting.executeScript`
 * injecting `InjectedPod`'s bootstrap into the MAIN world; anything else
 * (the default) assumes the page boots itself, the same way
 * `spikes/browser-pod-host/static/pod.html` does.
 *
 * ── exec ──────────────────────────────────────────────────────────────
 *
 * Supported, like the CDP driver and unlike the in-page driver: the
 * extension has `scripting` permission and `host_permissions` scoped to
 * the pod page's origin, which is a real, narrower-than-CDP privilege
 * boundary (an extension can only touch pages its manifest named) —
 * enough authority to justify implementing it, the same reasoning the CDP
 * driver's module doc comment gives for its own `exec`. Runs via
 * `chrome.scripting.executeScript({world: 'ISOLATED', func, args})`, so it
 * never collides with the page's own main-world globals. Gated by
 * `checkAccess()` like any other lane's `exec` once this driver is wired
 * into `createPodHostService()` — nothing here bypasses that.
 *
 * ── snapshot/restore ──────────────────────────────────────────────────
 *
 * `snapshot` maps to `chrome.tabs.discard(tabId)` — a REAL browser
 * primitive that frees the tab's memory — and `restore` maps to
 * re-activating/reloading it. Stated as plainly as possible because the
 * promise here is WEAKER than a microVM snapshot or even "freeze and
 * resume exactly where you left off": `chrome.tabs.discard()` does not
 * preserve the page's JS heap. A discarded tab, once reactivated,
 * NAVIGATES FRESH — `restore()` reboots the pod page from scratch, which
 * means the restored pod has a DIFFERENT generated `podId` than the one
 * that was snapshotted. This driver still exposes it as `snapshot`/
 * `restore` (DECISION, issue #185 item 7) because "free this tab's memory,
 * resume means re-register" is a real and useful browser-lane capability,
 * but a caller that needs state preservation across the pair must not
 * assume `podId` is stable — see the README for the full honesty note.
 * `POD_LANE_VERBS[POD_LANE.BROWSER]` does NOT include `snapshot`/
 * `restore` (see `host-protocol.mjs`), so this driver's pair is NOT wired
 * into `createPodHostService()` in this spike; it is reachable only by
 * calling the driver directly. (`pod-host-service.mjs`'s `verbRefusal()`
 * actually checks "does the driver itself implement + declare the verb"
 * BEFORE consulting the lane table, so attaching this driver as-is WOULD
 * let snapshot/restore through the gate despite the lane excluding them —
 * a real soft spot worth closing, e.g. by having the service also check
 * `laneSupports()` even when the driver claims support, before this driver
 * graduates past spike status.)
 *
 * ── persistence across service-worker restarts ───────────────────────
 *
 * MV3 background service workers are killed and restarted by the browser
 * whenever idle; an in-memory `Map` alone would lose every pod's roster
 * on each restart. Every mutation writes the roster to
 * `chrome.storage.session` (cleared when the browser closes, unlike
 * `chrome.storage.local` — a pod roster describing live tabs should not
 * outlive the browser session that owns those tabs). `hydrate()` reloads
 * it; call it once after constructing the driver in a freshly (re)started
 * service worker, before serving any request.
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
} from '../../../packages/browsermesh-pod/src/index.mjs'

/** Verbs this driver serves — see the module doc comment for the
 * snapshot/restore caveat. */
const VERBS = Object.freeze([
  POD_HOST_VERB.SPAWN, POD_HOST_VERB.STATUS, POD_HOST_VERB.SEND, POD_HOST_VERB.EXEC,
  POD_HOST_VERB.SNAPSHOT, POD_HOST_VERB.RESTORE, POD_HOST_VERB.DRAIN, POD_HOST_VERB.LIST,
])

const DEFAULT_SPAWN_TIMEOUT_MS = 10_000
const READY_POLL_INTERVAL_MS = 100
const STORAGE_KEY = 'browsermesh:pod-host:roster'

/** The `chrome.runtime` message types this driver's side of the protocol speaks. */
export const EXT_MESSAGE = Object.freeze({
  STATUS: 'browser-host:status', // driver -> content/page, expects {ready, podId, name}
  MESSAGE: 'browser-host:message', // driver -> content/page, payload delivery
});

/**
 * The function injected into the MAIN world via `chrome.scripting.executeScript`
 * for `run.input.mode === 'inject'` spawns. Deliberately self-contained
 * (no closures over driver state — it runs in a different JS realm
 * entirely) and deliberately NOT importing `InjectedPod` (a `chrome.scripting`
 * injected `func` is serialized and cannot carry module imports with it);
 * it just marks a global a real integration would have `InjectedPod`'s own
 * bootstrap set instead. See README for the gap this spike leaves.
 * `globalThis` rather than `window` on purpose: this makes the function
 * callable as-is from a plain Node fake in tests (no `window` global
 * there), and `globalThis === window` in a real page's MAIN world anyway.
 * @param {string} name
 */
function injectedReadyStub(name) {
  globalThis.__browsermeshHosted = globalThis.__browsermeshHosted || { ready: true, name, podId: `injected:${name}`, send() {} }
}

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
 * Build a `PodHostDriver` driving browser-lane pods through an installed
 * extension's `chrome.*` APIs.
 *
 * @param {object} opts
 * @param {object} opts.chrome - The extension's `chrome` global (or a fake
 *   with the same shape, for testing).
 * @param {string} opts.podUrl - URL every spawned pod page boots.
 * @param {number} [opts.spawnTimeoutMs=10000]
 * @returns {import('../../../packages/browsermesh-pod/src/index.mjs').PodHostDriver & { hydrate(): Promise<void> }}
 */
export function createExtensionDriver({ chrome, podUrl, spawnTimeoutMs = DEFAULT_SPAWN_TIMEOUT_MS } = {}) {
  if (!chrome?.tabs?.create) throw new Error('createExtensionDriver: chrome.tabs is required')
  if (!chrome?.scripting?.executeScript) throw new Error('createExtensionDriver: chrome.scripting is required')
  if (!podUrl || typeof podUrl !== 'string') throw new Error('createExtensionDriver: podUrl is required')

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

  /** Fire-and-forget persistence -- see the module doc comment. */
  function persist() {
    if (!chrome.storage?.session?.set) return
    const roster = {}
    for (const [name, record] of pods) {
      roster[name] = {
        name: record.name, spec: record.spec, state: record.state,
        createdAt: record.createdAt, updatedAt: record.updatedAt,
        podId: record.podId, tabId: record.tabId,
      }
    }
    Promise.resolve(chrome.storage.session.set({ [STORAGE_KEY]: roster })).catch(() => {
      // Best effort -- a persistence failure should never break a verb.
    })
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
      tabId: record.tabId,
    }
  }

  /** @param {object} record @returns {Promise<{ready: boolean, podId?: string, name?: string}>} */
  async function ping(record) {
    try {
      const response = await chrome.tabs.sendMessage(record.tabId, { type: EXT_MESSAGE.STATUS })
      return response || { ready: false }
    } catch {
      // "Could not establish connection" -- the content script/page is not
      // listening yet (still loading), not an error worth surfacing.
      return { ready: false }
    }
  }

  async function waitForReady(record, ms) {
    const deadline = Date.now() + ms
    for (;;) {
      const response = await ping(record)
      if (response.ready && (!response.name || response.name === record.name)) return response
      if (Date.now() >= deadline) {
        throw new PodHostDriverError(
          POD_HOST_ERROR.ETIMEDOUT,
          `pod '${record.name}' did not respond ready to '${EXT_MESSAGE.STATUS}' within ${ms}ms`,
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

    /**
     * Repopulate the roster from `chrome.storage.session` after a service
     * worker (re)start. Not part of the `PodHostDriver` typedef -- call it
     * once, before serving requests, from `background.mjs`.
     */
    async hydrate() {
      if (!chrome.storage?.session?.get) return
      const stored = await chrome.storage.session.get(STORAGE_KEY)
      const roster = stored?.[STORAGE_KEY]
      if (!roster) return
      for (const [name, record] of Object.entries(roster)) {
        if (!pods.has(name)) pods.set(name, { ...record })
      }
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
        name: value.name, spec: value, state: POD_LIFECYCLE.COLD,
        createdAt: now, updatedAt: now, podId: null, tabId: null,
      }
      pods.set(value.name, record)
      transition(record, POD_LIFECYCLE.BOOTING, 'spawn')
      persist()

      try {
        const url = buildChildUrl(podUrl, value.name)
        const tab = await chrome.tabs.create({ url, active: false })
        record.tabId = tab.id

        if (value.run?.input?.mode === 'inject') {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: injectedReadyStub,
            args: [value.name],
          })
        }

        const ready = await waitForReady(record, spawnTimeoutMs)
        record.podId = ready.podId ?? null
        transition(record, POD_LIFECYCLE.REGISTERED, 'child-ready')
      } catch (err) {
        record.state = POD_LIFECYCLE.GONE
        if (err instanceof PodHostDriverError) {
          persist()
          throw err
        }
        persist()
        throw new PodHostDriverError(POD_HOST_ERROR.EINVAL, `failed to spawn '${value.name}': ${err.message}`, { name: value.name })
      }

      persist()
      return snapshotOf(record)
    },

    async status(name) {
      const record = require_(name)
      if (record.state !== POD_LIFECYCLE.GONE && record.tabId != null) {
        const response = await ping(record)
        if (response.ready && response.podId) record.podId = response.podId
      }
      return snapshotOf(record)
    },

    async send(name, msg) {
      const record = requireLive(name)
      await chrome.tabs.sendMessage(record.tabId, { type: EXT_MESSAGE.MESSAGE, payload: msg?.payload ?? null })
      return { delivered: true, to: msg?.to ?? null }
    },

    // See the module doc comment: supported, gated like any exec once
    // wired into createPodHostService(). Runs in the page's ISOLATED
    // world -- the same JS realm content scripts get, never the page's own.
    async exec(name, argv) {
      const record = requireLive(name)
      const expression = Array.isArray(argv) ? String(argv[0] ?? '') : String(argv)
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId: record.tabId },
        world: 'ISOLATED',
        // eslint-disable-next-line no-new-func -- the whole point of exec()
        func: new Function('expression', 'try { return { value: eval(expression) } } catch (err) { return { error: String(err && err.message || err) } }'),
        args: [expression],
      })
      const result = injection?.result
      if (result?.error) return { stdout: '', stderr: result.error, code: 1 }
      const value = result?.value
      return { stdout: typeof value === 'string' ? value : JSON.stringify(value ?? null), stderr: '', code: 0 }
    },

    // See the module doc comment's "snapshot/restore" section for the
    // honest, weaker-than-usual semantics.
    async snapshot(name) {
      const record = requireLive(name)
      if (record.state === POD_LIFECYCLE.REGISTERED) transition(record, POD_LIFECYCLE.PAUSED, 'snapshot')
      await chrome.tabs.discard(record.tabId)
      transition(record, POD_LIFECYCLE.SNAPSHOTTED, 'snapshot')
      persist()
      return snapshotOf(record)
    },

    async restore(name) {
      const record = require_(name)
      if (record.state !== POD_LIFECYCLE.SNAPSHOTTED) {
        throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, `pod '${name}' is not snapshotted (state: ${record.state})`, { name })
      }
      transition(record, POD_LIFECYCLE.RESTORING, 'restore')
      // Un-discarding a tab makes Chrome reload it from scratch -- the pod
      // page's bootstrap runs again and generates a NEW podId.
      await chrome.tabs.reload(record.tabId)
      const ready = await waitForReady(record, spawnTimeoutMs)
      record.podId = ready.podId ?? null
      transition(record, POD_LIFECYCLE.REGISTERED, 'restore')
      persist()
      return snapshotOf(record)
    },

    async drain(name, opts = {}) {
      const record = require_(name)
      if (record.state !== POD_LIFECYCLE.GONE) {
        if (record.state !== POD_LIFECYCLE.DRAINING) transition(record, POD_LIFECYCLE.DRAINING, 'drain')
        if (record.tabId != null) {
          try { await chrome.tabs.remove(record.tabId) } catch { /* tab may already be gone */ }
        }
        transition(record, POD_LIFECYCLE.GONE, 'drain')
      }
      persist()
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
