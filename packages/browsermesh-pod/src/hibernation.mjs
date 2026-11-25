/**
 * hibernation.mjs -- "cold boot as sleep" for hosted pods (`docs/design/hosted-pods-open-decisions.md`,
 * decision 1, option B; `docs/hosted-pods.md`, "Hibernation").
 *
 * A pod that has been idle for a while is drained to a small durable record; the next message, or any verb that needs
 * the pod, boots it again. Nothing is on the wire: the same eight verbs, the same podspec, a lifecycle state the
 * protocol already has (`cold`), and one optional field on a status (`sleeping`). It is a `PodHostDriver` decorator, so
 * every lane driver and the pod-host service use it unchanged.
 *
 * WHAT SLEEP IS. `sleep(name)` writes `{name, spec, podId, sleptAt, wakes}` to a `HibernationStore` FIRST, then drains
 * the pod through the inner driver, with the inner driver's own drain events held back (a sleeping pod has not exited,
 * so no `exit` event is sent and a supervisor sees nothing to restart). The pod then reports `state: 'cold'`,
 * `sleeping: true`, with its `podId` and spec.
 *
 * WHAT SURVIVES. The record: the podspec and the pod's `podId`. The pod's identity must come back with the same
 * `podId` (a Durable Object keeps its keypair in its own storage; the wake checks this and fails with
 * `identity-changed` rather than bring a different pod up under the name). What does NOT survive is anything in
 * memory: peer tables, open connections, in-flight work, anything the pod did not write to its own durable storage.
 * A lane that can snapshot (a microVM) should use the `snapshot`/`restore` verbs, which keep memory; this module
 * deliberately does not.
 *
 * WAKE. `send`, `exec` and `deliver` on a sleeping pod boot it through `inner.spawn(spec, {wake: {discoveryWindowMs,
 * podId}})` (a second argument older drivers ignore) and then perform the verb. The boot is a single flight per pod:
 * concurrent callers share it and reach the pod in the order they asked. `status`, `list` and `drain` never wake a
 * pod; they answer from the record. `snapshot`/`restore` are not waking verbs: they are refused `EBUSY` (`asleep`).
 *
 * BOUNDS. A caller waits at most `wakeTimeoutMs` (then `ETIMEDOUT`, reason `wake-timeout`; the boot goes on in the
 * background, so the next call usually finds the pod awake). At most `maxQueuedPerPod` callers wait on one wake (then
 * `EBUSY`, `wake-queue-full`) and at most `maxConcurrentWakes` pods boot at once (`EBUSY`, `wake-capacity`). A boot
 * that fails leaves the pod asleep with the failure on its record (`EBUSY`, `wake-failed`), and the next call tries
 * again; nothing retries by itself. Only a verb that already passed the service's access checks reaches the driver,
 * so only someone allowed to use a pod can wake it.
 *
 * Time is injected (`now`, `setTimer`, `clearTimer`), so nothing here needs a real sleep to test.
 */

import {
  POD_HOST_ERROR,
  POD_HOST_EVENT_KIND,
  POD_HOST_VERB,
  POD_LIFECYCLE,
  PodHostDriverError,
  createHostEvent,
} from './host-protocol.mjs'

/** The defaults. `discoveryWindowMs` is shorter than the 1.5 s a first boot waits; it has not been measured on a deployed host. */
export const HIBERNATION_DEFAULTS = Object.freeze({
  idleMs: 300_000,
  wakeTimeoutMs: 5_000,
  discoveryWindowMs: 100,
  maxQueuedPerPod: 32,
  maxConcurrentWakes: 4,
})

/** `details.reason` of a wake that did not complete. */
export const WAKE_FAILURE = Object.freeze({
  TIMEOUT: 'wake-timeout',
  FAILED: 'wake-failed',
  QUEUE_FULL: 'wake-queue-full',
  CAPACITY: 'wake-capacity',
  REFUSED: 'wake-refused',
  IDENTITY: 'identity-changed',
})

/** `data.reason` of the lifecycle events a hibernating driver sends. */
export const HIBERNATION_REASON = Object.freeze({
  SLEPT: 'slept',
  WAKING: 'waking',
  WOKE: 'woke',
  WAKE_FAILED: 'wake-failed',
})

/**
 * `HibernationStore`: where a sleeping pod's record lives. Four async methods; a Durable Object's `ctx.storage` or a
 * file or a database fits behind them. The record must outlive the process that wrote it, or a restart loses every
 * sleeper (the in-memory store below does not).
 *
 * @typedef {object} HibernationStore
 * @property {(name: string) => Promise<object|null>} get
 * @property {(name: string, record: object) => Promise<void>} put
 * @property {(name: string) => Promise<void>} delete
 * @property {() => Promise<object[]>} list
 */

/** In-process `HibernationStore`: the reference, for tests and hosts that do not restart. */
export class MemoryHibernationStore {
  /** @type {Map<string, object>} */
  #records = new Map()

  async get(name) { return this.#records.has(name) ? structuredClone(this.#records.get(name)) : null }

  async put(name, record) { this.#records.set(name, structuredClone(record)) }

  async delete(name) { this.#records.delete(name) }

  async list() { return [...this.#records.values()].map((record) => structuredClone(record)) }
}

/**
 * @param {string} what
 * @param {*} value
 * @param {number} min
 */
function checkInteger(what, value, min) {
  if (!Number.isInteger(value) || value < min) throw new Error(`createHibernatingDriver: ${what} must be an integer >= ${min}`)
}

/**
 * @param {string} code
 * @param {string} reason
 * @param {string} message
 * @param {object} [extra]
 */
function failure(code, reason, message, extra = {}) {
  return new PodHostDriverError(code, message, { reason, ...extra })
}

/**
 * Wrap a lane driver so its idle pods can sleep and be woken by use.
 *
 * @param {import('./host-protocol.mjs').PodHostDriver} inner
 * @param {object} [opts]
 * @param {HibernationStore} [opts.store] - Default: in memory.
 * @param {number} [opts.idleMs] - No send/exec/deliver for this long makes a pod eligible to sleep.
 * @param {number} [opts.wakeTimeoutMs] - The longest a caller waits for a wake.
 * @param {number} [opts.discoveryWindowMs] - Passed to the inner driver on a wake: how long the booting pod waits to
 *   hear its peers (a first boot waits longer).
 * @param {number} [opts.maxQueuedPerPod]
 * @param {number} [opts.maxConcurrentWakes]
 * @param {(spec: object) => boolean} [opts.eligible] - Return false to keep a pod awake. Default: every pod.
 * @param {(info: {name: string, spec: object}) => Promise<void>|void} [opts.admitWake] - Called before a wake boots
 *   anything; throw to refuse it (capacity). A refusal leaves the pod asleep.
 * @param {(info: {name: string, spec: object}) => void} [opts.onSleep]
 * @param {(info: {name: string, spec: object}) => void} [opts.onWakeFailed]
 * @param {number} [opts.sweepIntervalMs] - With `start()`, how often `sweep()` runs. 0 (default): call `sweep()` yourself.
 * @param {() => number} [opts.now]
 * @param {(fn: () => void, ms: number) => *} [opts.setTimer]
 * @param {(timer: *) => void} [opts.clearTimer]
 */
export function createHibernatingDriver(inner, opts = {}) {
  if (!inner || typeof inner.spawn !== 'function' || typeof inner.status !== 'function' || typeof inner.drain !== 'function' || typeof inner.list !== 'function' || typeof inner.capabilities !== 'function') {
    throw new Error('createHibernatingDriver: a PodHostDriver (lane, capabilities, spawn, status, drain, list) is required')
  }
  const idleMs = opts.idleMs ?? HIBERNATION_DEFAULTS.idleMs
  const wakeTimeoutMs = opts.wakeTimeoutMs ?? HIBERNATION_DEFAULTS.wakeTimeoutMs
  const discoveryWindowMs = opts.discoveryWindowMs ?? HIBERNATION_DEFAULTS.discoveryWindowMs
  const maxQueuedPerPod = opts.maxQueuedPerPod ?? HIBERNATION_DEFAULTS.maxQueuedPerPod
  const maxConcurrentWakes = opts.maxConcurrentWakes ?? HIBERNATION_DEFAULTS.maxConcurrentWakes
  const sweepIntervalMs = opts.sweepIntervalMs ?? 0
  checkInteger('idleMs', idleMs, 1)
  checkInteger('wakeTimeoutMs', wakeTimeoutMs, 1)
  checkInteger('discoveryWindowMs', discoveryWindowMs, 0)
  checkInteger('maxQueuedPerPod', maxQueuedPerPod, 1)
  checkInteger('maxConcurrentWakes', maxConcurrentWakes, 1)
  checkInteger('sweepIntervalMs', sweepIntervalMs, 0)

  const store = opts.store ?? new MemoryHibernationStore()
  const eligible = opts.eligible ?? (() => true)
  const now = opts.now ?? Date.now
  const setTimer = opts.setTimer ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms)
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
    return timer
  })
  const clearTimer = opts.clearTimer ?? clearTimeout
  const hooks = {
    admitWake: opts.admitWake ?? null,
    onSleep: opts.onSleep ?? null,
    onWakeFailed: opts.onWakeFailed ?? null,
  }

  /** @type {Map<string, {lastActiveAt: number, busy: number, spec: object, podId: string|null, wakes: number}>} */
  const awake = new Map()
  /** @type {Map<string, {queued: number, startedAt: number, promise: Promise<{wakeMs: number}>}>} */
  const waking = new Map()
  /** Pods whose inner drain events are ours to swallow (a sleep, or the drain of a stranger after a wake). */
  const quiet = new Set()
  /** @type {Set<(event: object) => void>} */
  const listeners = new Set()
  const stats = { sleeps: 0, wakes: 0, wakeFailures: 0, lastWakeMs: null }
  let concurrentWakes = 0
  let sweepTimer = null
  let started = false
  let disposed = false

  function emit(event) {
    for (const fn of [...listeners]) {
      try { fn(event) } catch { /* a throwing subscriber never breaks the driver */ }
    }
  }

  const unsubscribeInner = typeof inner.onEvent === 'function'
    ? inner.onEvent((event) => { if (!quiet.has(event?.data?.name)) emit(event) })
    : null

  function lifecycle(name, from, to, reason, extra = {}) {
    emit(createHostEvent(POD_HOST_EVENT_KIND.LIFECYCLE, { name, lane: inner.lane, from, to, reason, ...extra }))
  }

  function serves(verb) {
    return (inner.capabilities().verbs ?? []).includes(verb)
  }

  function sleepingStatus(record) {
    return {
      name: record.name,
      lane: inner.lane,
      state: POD_LIFECYCLE.COLD,
      spec: record.spec,
      createdAt: record.createdAt ?? record.sleptAt,
      updatedAt: record.sleptAt,
      podId: record.podId ?? null,
      sleeping: true,
      sleptAt: record.sleptAt,
      wakes: record.wakes ?? 0,
      ...(record.lastWakeError ? { lastWakeError: record.lastWakeError } : {}),
    }
  }

  function wakingStatus(record) {
    return {
      name: record.name,
      lane: inner.lane,
      state: POD_LIFECYCLE.BOOTING,
      spec: record.spec,
      createdAt: record.createdAt ?? record.sleptAt,
      updatedAt: now(),
      podId: record.podId ?? null,
      waking: true,
    }
  }

  function adopt(status) {
    if (!status || awake.has(status.name) || quiet.has(status.name) || waking.has(status.name)) return
    if (status.state !== POD_LIFECYCLE.REGISTERED && status.state !== POD_LIFECYCLE.SERVING) return
    awake.set(status.name, { lastActiveAt: now(), busy: 0, spec: status.spec ?? {}, podId: status.podId ?? null, wakes: 0 })
  }

  /** Run `fn` as activity on the pod: it is busy until it settles and counts as used when it does. */
  async function active(name, fn) {
    const entry = awake.get(name)
    if (!entry) return fn()
    entry.busy += 1
    entry.lastActiveAt = now()
    try {
      return await fn()
    } finally {
      entry.busy -= 1
      entry.lastActiveAt = now()
    }
  }

  async function doWake(name, record) {
    if (concurrentWakes >= maxConcurrentWakes) {
      throw failure(POD_HOST_ERROR.EBUSY, WAKE_FAILURE.CAPACITY, `cannot wake '${name}': ${maxConcurrentWakes} pods are already waking`, { name, maxConcurrentWakes })
    }
    concurrentWakes += 1
    const startedAt = now()
    let admitted = false
    try {
      lifecycle(name, POD_LIFECYCLE.COLD, POD_LIFECYCLE.BOOTING, HIBERNATION_REASON.WAKING)
      if (hooks.admitWake) {
        try {
          await hooks.admitWake({ name, spec: record.spec })
        } catch (err) {
          const error = PodHostDriverError.from(err)
          throw failure(error.code, error.details?.reason ?? WAKE_FAILURE.REFUSED, error.message, { ...(error.details ?? {}), name })
        }
      }
      admitted = true
      const status = await inner.spawn(record.spec, { wake: { discoveryWindowMs, podId: record.podId ?? null } })
      if (record.podId && status?.podId && status.podId !== record.podId) {
        quiet.add(name)
        try { await inner.drain(name) } catch { /* the stranger is already unreachable */ } finally { quiet.delete(name) }
        throw failure(POD_HOST_ERROR.EINVAL, WAKE_FAILURE.IDENTITY, `pod '${name}' came back with a different podId; it was not woken`, { name })
      }
      awake.set(name, {
        lastActiveAt: now(), busy: 0, spec: record.spec, podId: status?.podId ?? record.podId ?? null, wakes: (record.wakes ?? 0) + 1,
      })
      await store.delete(name)
      const wakeMs = now() - startedAt
      stats.wakes += 1
      stats.lastWakeMs = wakeMs
      lifecycle(name, POD_LIFECYCLE.BOOTING, POD_LIFECYCLE.REGISTERED, HIBERNATION_REASON.WOKE, { wakeMs })
      return { wakeMs }
    } catch (err) {
      const error = PodHostDriverError.from(err)
      const wrapped = error.details?.reason
        ? error
        : failure(error.code === POD_HOST_ERROR.EINVAL ? POD_HOST_ERROR.EINVAL : POD_HOST_ERROR.EBUSY, WAKE_FAILURE.FAILED, `wake of '${name}' failed: ${error.message}`, { name, cause: error.code })
      stats.wakeFailures += 1
      if (admitted && hooks.onWakeFailed) {
        try { hooks.onWakeFailed({ name, spec: record.spec }) } catch { /* a hook never turns a failure into another */ }
      }
      lifecycle(name, POD_LIFECYCLE.BOOTING, POD_LIFECYCLE.COLD, HIBERNATION_REASON.WAKE_FAILED, { code: wrapped.code, failure: wrapped.details?.reason })
      if (wrapped.details?.reason !== WAKE_FAILURE.CAPACITY) {
        try { await store.put(name, { ...record, lastWakeError: { code: wrapped.code, reason: wrapped.details?.reason, message: wrapped.message, at: now() } }) } catch { /* best effort */ }
      }
      throw wrapped
    } finally {
      concurrentWakes -= 1
    }
  }

  /** Wait for `promise`, but not past `ms`. The promise is not cancelled. */
  function within(promise, ms, onTimeout) {
    return new Promise((resolve, reject) => {
      if (ms <= 0) { reject(onTimeout()); return }
      const timer = setTimer(() => reject(onTimeout()), ms)
      promise.then(
        (value) => { clearTimer(timer); resolve(value) },
        (err) => { clearTimer(timer); reject(err) },
      )
    })
  }

  /**
   * Make sure `name` is running if it is asleep. Resolves `{woke, wakeMs}`; for a pod that is not ours it resolves
   * `{woke: false}` and lets the inner driver answer.
   */
  async function ensureAwake(name) {
    if (awake.has(name)) return { woke: false }
    let wake = waking.get(name)
    if (!wake) {
      const record = await store.get(name)
      if (!record) return { woke: false }
      if (awake.has(name)) return { woke: false }
      wake = waking.get(name)
      if (!wake) {
        const started = { queued: 0, startedAt: now(), promise: null }
        started.promise = doWake(name, record).finally(() => { waking.delete(name) })
        started.promise.catch(() => {})
        waking.set(name, started)
        wake = started
      }
    }
    if (wake.queued >= maxQueuedPerPod) {
      throw failure(POD_HOST_ERROR.EBUSY, WAKE_FAILURE.QUEUE_FULL, `'${name}' is waking and ${maxQueuedPerPod} callers are already waiting`, { name, maxQueuedPerPod })
    }
    wake.queued += 1
    try {
      const { wakeMs } = await within(wake.promise, wakeTimeoutMs - (now() - wake.startedAt), () => failure(
        POD_HOST_ERROR.ETIMEDOUT, WAKE_FAILURE.TIMEOUT, `'${name}' did not wake within ${wakeTimeoutMs} ms`, { name, wakeTimeoutMs },
      ))
      return { woke: true, wakeMs }
    } finally {
      wake.queued -= 1
    }
  }

  async function sleep(name) {
    if (waking.has(name)) throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, `pod '${name}' is waking`, { name })
    const entry = awake.get(name)
    if (!entry) {
      const record = await store.get(name)
      if (record) return sleepingStatus(record)
      throw new PodHostDriverError(POD_HOST_ERROR.ENOENT, `no pod named '${name}'`, { name })
    }
    if (entry.busy > 0) throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, `pod '${name}' is busy`, { name })
    const status = await inner.status(name)
    if (status.state !== POD_LIFECYCLE.REGISTERED) {
      throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, `pod '${name}' is ${status.state}, not registered`, { name, state: status.state })
    }
    const record = {
      name,
      spec: status.spec ?? entry.spec,
      podId: status.podId ?? entry.podId ?? null,
      createdAt: status.createdAt ?? now(),
      sleptAt: now(),
      wakes: entry.wakes,
    }
    // Durable first: a crash between the two steps leaves a record for a pod that is still up, never a pod that is
    // gone with nothing to wake it from.
    await store.put(name, record)
    quiet.add(name)
    try {
      await inner.drain(name)
    } catch (err) {
      await store.delete(name)
      throw err
    } finally {
      quiet.delete(name)
    }
    awake.delete(name)
    stats.sleeps += 1
    lifecycle(name, POD_LIFECYCLE.REGISTERED, POD_LIFECYCLE.COLD, HIBERNATION_REASON.SLEPT, { idleMs })
    if (hooks.onSleep) {
      try { hooks.onSleep({ name, spec: record.spec }) } catch { /* a hook never undoes a sleep */ }
    }
    return sleepingStatus(record)
  }

  function arm() {
    sweepTimer = setTimer(async () => {
      sweepTimer = null
      try { await driver.sweep() } catch { /* the next sweep tries again */ }
      if (started && !disposed) arm()
    }, sweepIntervalMs)
  }

  const driver = {
    get lane() { return inner.lane },

    capabilities() {
      return { ...inner.capabilities(), hibernation: { idleMs, wakeTimeoutMs, discoveryWindowMs } }
    },

    /** @param {(event: object) => void} fn @returns {() => void} */
    onEvent(fn) {
      if (typeof fn !== 'function') return () => {}
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    },

    async spawn(spec, options) {
      const name = spec?.name
      if (typeof name === 'string' && (waking.has(name) || await store.get(name))) {
        throw new PodHostDriverError(POD_HOST_ERROR.EEXIST, `pod '${name}' already exists (asleep)`, { name })
      }
      const status = await inner.spawn(spec, options)
      awake.set(status.name, { lastActiveAt: now(), busy: 0, spec: status.spec ?? spec, podId: status.podId ?? null, wakes: 0 })
      return status
    },

    async status(name) {
      const record = await store.get(name)
      if (record) return waking.has(name) ? wakingStatus(record) : sleepingStatus(record)
      const status = await inner.status(name)
      adopt(status)
      return status
    },

    async list() {
      const listed = await inner.list()
      const sleepers = new Map((await store.list()).map((record) => [record.name, record]))
      const out = []
      for (const status of listed) {
        const record = sleepers.get(status.name)
        if (record) {
          sleepers.delete(status.name)
          out.push(waking.has(status.name) ? wakingStatus(record) : sleepingStatus(record))
        } else {
          adopt(status)
          out.push(status)
        }
      }
      for (const record of sleepers.values()) out.push(waking.has(record.name) ? wakingStatus(record) : sleepingStatus(record))
      return out
    },

    async send(name, msg) {
      const wake = await ensureAwake(name)
      const reply = await active(name, () => inner.send(name, msg))
      return wake.woke ? { ...reply, woke: true, wakeMs: wake.wakeMs } : reply
    },

    async exec(name, argv, execOptions) {
      if (!serves(POD_HOST_VERB.EXEC)) return inner.exec(name, argv, execOptions)
      const wake = await ensureAwake(name)
      const result = await active(name, () => inner.exec(name, argv, execOptions))
      return wake.woke ? { ...result, woke: true, wakeMs: wake.wakeMs } : result
    },

    async snapshot(name) {
      if (serves(POD_HOST_VERB.SNAPSHOT) && await store.get(name)) {
        throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, `pod '${name}' is asleep; snapshot needs it running`, { name, reason: 'asleep' })
      }
      return inner.snapshot(name)
    },

    async restore(name) {
      if (serves(POD_HOST_VERB.RESTORE) && await store.get(name)) {
        throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, `pod '${name}' is asleep, not snapshotted`, { name, reason: 'asleep' })
      }
      return inner.restore(name)
    },

    async drain(name, drainOptions) {
      const wake = waking.get(name)
      if (wake) { try { await wake.promise } catch { /* a failed wake leaves the record, which is dropped below */ } }
      const record = await store.get(name)
      awake.delete(name)
      if (!record) return inner.drain(name, drainOptions)
      await store.delete(name)
      try {
        return await inner.drain(name, drainOptions)
      } catch (err) {
        // The inner driver has no memory of a pod that slept (a restarted host): the drain is still a drain.
        if (PodHostDriverError.from(err).code !== POD_HOST_ERROR.ENOENT) throw err
        emit(createHostEvent(POD_HOST_EVENT_KIND.EXIT, {
          name, lane: inner.lane, code: 0, cascade: drainOptions?.cascade === true, reason: 'drained', restartable: false,
        }))
        const now0 = now()
        return { name, lane: inner.lane, state: POD_LIFECYCLE.GONE, spec: record.spec, createdAt: record.createdAt ?? now0, updatedAt: now0, podId: record.podId ?? null }
      }
    },

    /**
     * The pod name that holds `podId`, awake or asleep, or null.
     * @param {string} podId
     * @returns {Promise<string|null>}
     */
    async resolve(podId) {
      for (const [name, entry] of awake) if (entry.podId && entry.podId === podId) return name
      for (const record of await store.list()) if (record.podId && record.podId === podId) return record.name
      return null
    },

    /**
     * A message from the mesh for the pod that holds `to` (a podId or a pod name): the front door of a host calls this
     * for traffic addressed to a pod that may be asleep. Wakes it if needed, then hands the message over as `send` does.
     * @param {string} to
     * @param {{to?: string, payload: *}} msg
     */
    async deliver(to, msg) {
      const name = (await driver.resolve(to)) ?? ((awake.has(to) || await store.get(to)) ? to : null)
      if (name === null) throw new PodHostDriverError(POD_HOST_ERROR.ENOENT, `no pod holds '${to}'`, { to })
      return driver.send(name, msg)
    },

    /**
     * Sleep every eligible pod that has been idle for `idleMs`. Pods running before this driver was wrapped are picked
     * up from `list()` and count as used at that moment.
     * @returns {Promise<{slept: string[], failed: Array<{name: string, code: string, message: string}>}>}
     */
    async sweep() {
      try { for (const status of await inner.list()) adopt(status) } catch { /* only the tracked pods are swept */ }
      const slept = []
      const failed = []
      for (const [name, entry] of [...awake]) {
        if (entry.busy > 0 || waking.has(name)) continue
        if (now() - entry.lastActiveAt < idleMs) continue
        if (!eligible(entry.spec)) continue
        try {
          await sleep(name)
          slept.push(name)
        } catch (err) {
          const error = PodHostDriverError.from(err)
          failed.push({ name, code: error.code, message: error.message })
        }
      }
      return { slept, failed }
    },

    /** Sleep one pod now (it must be registered and not busy). @param {string} name */
    sleep,

    /** Start the automatic sweep (`sweepIntervalMs` > 0). */
    start() {
      if (started || disposed || sweepIntervalMs === 0) return
      started = true
      arm()
    },

    /** Stop the sweep and detach from the inner driver. */
    dispose() {
      disposed = true
      started = false
      if (sweepTimer !== null) clearTimer(sweepTimer)
      sweepTimer = null
      if (unsubscribeInner) unsubscribeInner()
      listeners.clear()
    },

    /** @returns {{sleeps: number, wakes: number, wakeFailures: number, lastWakeMs: number|null}} */
    stats() { return { ...stats } },

    /**
     * Placement hooks a pool installs (see `createHostPool()` in `@johnhenry/browsermesh-apps`): `admitWake` may
     * refuse a wake for lack of room; `onSleep` and `onWakeFailed` tell the ledger. Hooks given as options run first.
     * @param {{admitWake?: Function, onSleep?: Function, onWakeFailed?: Function}} placement
     */
    attachPlacement(placement = {}) {
      for (const key of ['admitWake', 'onSleep', 'onWakeFailed']) {
        if (typeof placement[key] !== 'function') continue
        const own = opts[key] ?? null
        const attached = placement[key]
        hooks[key] = own
          ? async (info) => { await own(info); return attached(info) }
          : attached
      }
    },
  }

  return driver
}
