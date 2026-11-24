/**
 * pod-runtime.mjs -- the adapter interface between a `PodHostDriver` and
 * whatever actually runs a hosted pod's code in this process family, plus
 * the driver that sits on top of it (issue #185, lane A and its honest
 * stand-ins).
 *
 * A **`PodRuntime`** is the narrow thing that differs between ways of
 * running a module in isolation:
 *
 *   - `worker_threads`            same process, no boundary (`node-runtimes.mjs`)
 *   - Node permission-model child  separate process with fs/net/exec denied
 *                                  (`node-runtimes.mjs`); NOT a sandbox
 *   - `isolated-vm`                a V8 isolate in the host's process
 *                                  (`isolate-runtime.mjs`; the addon is an
 *                                  optional dependency)
 *   - `workerd`                    a V8 isolate in its own process (the
 *                                  `spikes/isolate-pod-host` Worker host
 *                                  speaks this protocol over HTTP instead)
 *
 * `createRuntimeLaneDriver()` turns any of them into a `PodHostDriver`, so
 * the pod-host service, the placement pool and the supervisor see one lane
 * driver whatever sits behind it. The driver owns everything that must not
 * depend on the runtime: podspec validation, which modules may run (a
 * host-side catalog, never a path from the requester), which environment
 * variables a pod may be given, admission limits, the lifecycle state
 * machine and the events.
 *
 * ## The contract a runtime implements
 *
 * ```
 * runtime = {
 *   kind:     string,                    // 'worker_threads' | 'isolated-vm' | ...
 *   lane:     'isolate' | 'node' | ...,  // the POD_LANE this runtime may be advertised as
 *   boundary: 'none'|'process'|'language'|'hardware',
 *   start(opts) -> Promise<handle>
 * }
 * opts   = { name, modulePath, env, input, limits: {memMib?}, readPaths?,
 *            onExit({code, reason}), onLog(line) }
 * handle = { request(payload, {timeoutMs}) -> Promise<reply>, terminate() -> Promise<void> }
 * ```
 *
 * `start()` resolves once the module has loaded and its optional `start()`
 * has run, and rejects if it cannot. `onExit` fires exactly once if the pod
 * stops on its own (`reason`: `'oom'`, `'crashed'`, `'exited'`); it does not
 * fire for a `terminate()` the driver asked for.
 *
 * The hosted module (from the catalog) exports:
 * `async start(ctx)` (optional) and `async handle(payload, ctx)`, where
 * `ctx = { name, env, input, log(line) }`. Its return value is the reply to
 * `send`.
 *
 * ## A runtime that claims the isolate lane must be one
 *
 * A driver whose runtime advertises `lane: 'isolate'` is refused unless its
 * `boundary` is `language` or `hardware`. `runtime:isolate` is what the
 * scorer matches, so a `worker_threads` runtime (boundary `none`) must be
 * advertised as the `node` lane, where untrusted requesters are not placed.
 * `node:vm` contexts and `worker_threads` are NOT security boundaries.
 *
 * ## Specifying the isolate implementation against this interface
 *
 * `createIsolatedVmRuntime()` (`isolate-runtime.mjs`) implements `start()` by
 * creating one `ivm.Isolate({ memoryLimit: limits.memMib })` and one context,
 * compiling the module source (read by the host from `modulePath`; the
 * module may import nothing) under a host-written wrapper, and bridging
 * `request` and `onLog` as JSON strings and one string callback;
 * `terminate()` is `isolate.dispose()`; an out-of-memory or time-limit
 * disposal is reported as `onExit({reason: 'oom'|'timeout'})`. It declares
 * `boundary: 'language'` and so may declare `lane: 'isolate'`; it runs in
 * the host's own process, which the upstream README advises against for
 * anything critical (see the security review). A `workerd` runtime is the
 * same shape with a Worker per pod. Neither needs any change to the driver,
 * the pool or the service.
 *
 * Zero dependencies and no `node:` imports: this module loads in a Worker, a
 * browser or a microVM guest. The Node implementations are in
 * `node-runtimes.mjs`.
 */

import {
  POD_HOST_ERROR,
  POD_HOST_EVENT_KIND,
  POD_HOST_VERB,
  POD_LANE,
  POD_LANES,
  POD_LIFECYCLE,
  PodHostDriverError,
  canTransition,
  createHostEvent,
  createUnsupportedDriverMethod,
  validatePodSpec,
} from './host-protocol.mjs'

/** How strongly a runtime separates a pod from its host, weakest first. */
export const RUNTIME_BOUNDARY = Object.freeze({
  NONE: 'none',
  PROCESS: 'process',
  LANGUAGE: 'language',
  HARDWARE: 'hardware',
})

const BOUNDARIES = Object.freeze(Object.values(RUNTIME_BOUNDARY))
const ISOLATE_BOUNDARIES = Object.freeze([RUNTIME_BOUNDARY.LANGUAGE, RUNTIME_BOUNDARY.HARDWARE])

/**
 * Environment variable names a requester may not set: they change how the
 * runtime loads code or applies its own restrictions (`NODE_OPTIONS` can
 * carry permission flags, `LD_PRELOAD`/`DYLD_*` load libraries).
 */
export const FORBIDDEN_ENV_NAME = /^(NODE_|LD_|DYLD_|UV_|OPENSSL_)/i

/** What `limits.memMib` becomes when a podspec states none. */
const DEFAULT_MEM_MIB = 128

/** Default wait for a `send` reply. */
const DEFAULT_SEND_TIMEOUT_MS = 5000

const VERBS = Object.freeze([
  POD_HOST_VERB.SPAWN, POD_HOST_VERB.STATUS, POD_HOST_VERB.SEND,
  POD_HOST_VERB.DRAIN, POD_HOST_VERB.LIST,
])

/**
 * @param {object} opts
 * @param {object} opts.runtime - A `PodRuntime` (see the module doc comment).
 * @param {Record<string, string|{path: string, readPaths?: string[]}>} opts.modules
 *   Catalog of module names a podspec's `run.ref` may name, to absolute file
 *   paths on THIS host. A requester never supplies a path.
 * @param {number} [opts.maxPods] - Admission limit: more is refused `EBUSY`.
 * @param {number} [opts.maxMemMib] - Largest `limits.memMib` a pod may ask for.
 * @param {number} [opts.defaultMemMib=128]
 * @param {number} [opts.sendTimeoutMs=5000]
 * @returns {import('./host-protocol.mjs').PodHostDriver}
 */
export function createRuntimeLaneDriver({
  runtime, modules = {}, maxPods, maxMemMib, defaultMemMib = DEFAULT_MEM_MIB, sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
} = {}) {
  if (!runtime || typeof runtime.start !== 'function') {
    throw new Error('createRuntimeLaneDriver: a runtime with start() is required')
  }
  if (!POD_LANES.includes(runtime.lane)) {
    throw new Error(`createRuntimeLaneDriver: runtime.lane must be one of ${POD_LANES.join('|')}`)
  }
  if (!BOUNDARIES.includes(runtime.boundary)) {
    throw new Error(`createRuntimeLaneDriver: runtime.boundary must be one of ${BOUNDARIES.join('|')}`)
  }
  if (runtime.lane === POD_LANE.ISOLATE && !ISOLATE_BOUNDARIES.includes(runtime.boundary)) {
    throw new Error(
      `createRuntimeLaneDriver: a runtime with boundary '${runtime.boundary}' cannot be advertised as the isolate lane `
      + '(worker_threads and node:vm are not isolation boundaries; advertise it as the node lane)',
    )
  }

  const lane = runtime.lane
  /** @type {Map<string, {name: string, spec: object, state: string, createdAt: number, updatedAt: number, handle: object|null, sends: number}>} */
  const pods = new Map()
  /** @type {Set<(event: object) => void>} */
  const listeners = new Set()

  /** @param {object} event */
  function emit(event) {
    for (const fn of [...listeners]) {
      try {
        fn(event)
      } catch {
        // A throwing subscriber never breaks the driver.
      }
    }
  }

  /** @param {object} record @param {string} to @param {string} reason */
  function transition(record, to, reason) {
    if (!canTransition(record.state, to)) {
      throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, `pod '${record.name}' cannot go ${record.state} -> ${to}`, { name: record.name })
    }
    const from = record.state
    record.state = to
    record.updatedAt = Date.now()
    emit(createHostEvent(POD_HOST_EVENT_KIND.LIFECYCLE, { name: record.name, lane, from, to, reason }))
  }

  /** @param {object} record */
  function statusOf(record) {
    return {
      name: record.name,
      lane,
      state: record.state,
      spec: record.spec,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      sends: record.sends,
      podId: null,
    }
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

  /** @param {object} value A validated podspec. @returns {{modulePath: string, readPaths: string[]}} */
  function resolveModule(value) {
    if (value.run.kind !== 'module' && value.run.kind !== 'skill') {
      throw new PodHostDriverError(
        POD_HOST_ERROR.EINVAL,
        `run.kind '${value.run.kind}' is not runnable by this host (module or skill only)`,
        { kind: value.run.kind },
      )
    }
    const entry = Object.hasOwn(modules, value.run.ref) ? modules[value.run.ref] : undefined
    if (!entry) {
      throw new PodHostDriverError(POD_HOST_ERROR.ENOENT, `no module registered under '${value.run.ref}'`, { ref: value.run.ref })
    }
    return typeof entry === 'string'
      ? { modulePath: entry, readPaths: [] }
      : { modulePath: entry.path, readPaths: [...(entry.readPaths ?? [])] }
  }

  return {
    lane,
    runtime,

    capabilities() {
      return { verbs: [...VERBS], boundary: runtime.boundary, runtime: runtime.kind }
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
      if (value.lane !== lane) {
        throw new PodHostDriverError(POD_HOST_ERROR.ELANE, `this host runs the '${lane}' lane, not '${value.lane}'`, { lane: value.lane })
      }
      const existing = pods.get(value.name)
      if (existing && existing.state !== POD_LIFECYCLE.GONE) {
        throw new PodHostDriverError(POD_HOST_ERROR.EEXIST, `pod '${value.name}' already exists`, { name: value.name })
      }
      const live = [...pods.values()].filter((p) => p.state !== POD_LIFECYCLE.GONE).length
      if (maxPods !== undefined && live >= maxPods) {
        throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, `host is at its limit of ${maxPods} pods`, { maxPods })
      }
      for (const key of Object.keys(value.env ?? {})) {
        if (FORBIDDEN_ENV_NAME.test(key)) {
          throw new PodHostDriverError(POD_HOST_ERROR.EINVAL, `env '${key}' may not be set`, { env: key })
        }
      }
      const memMib = value.limits?.memMib ?? defaultMemMib
      if (maxMemMib !== undefined && memMib > maxMemMib) {
        throw new PodHostDriverError(POD_HOST_ERROR.EINVAL, `limits.memMib ${memMib} exceeds this host's maximum of ${maxMemMib}`, { memMib, maxMemMib })
      }
      const { modulePath, readPaths } = resolveModule(value)

      const now = Date.now()
      const record = { name: value.name, spec: value, state: POD_LIFECYCLE.COLD, createdAt: now, updatedAt: now, handle: null, sends: 0 }
      pods.set(value.name, record)
      transition(record, POD_LIFECYCLE.BOOTING, 'spawn')

      let started = false
      /** @type {{code: number|null, reason: string}|null} */
      let earlyExit = null
      try {
        record.handle = await runtime.start({
          name: value.name,
          modulePath,
          readPaths,
          env: { ...(value.env ?? {}) },
          input: value.run.input ?? null,
          limits: { memMib },
          onLog: (line) => emit(createHostEvent(POD_HOST_EVENT_KIND.LOG, { name: value.name, lane, stream: 'stdout', chunk: String(line) })),
          onExit: (info) => {
            if (!started) { earlyExit = info; return }
            onUnexpectedExit(record, info)
          },
        })
      } catch (err) {
        record.handle = null
        transition(record, POD_LIFECYCLE.GONE, 'start-failed')
        throw new PodHostDriverError(POD_HOST_ERROR.EINVAL, `pod failed to start: ${err?.message || String(err)}`, { name: value.name })
      }
      started = true
      if (earlyExit) {
        // The runtime reported an exit while start() was still settling.
        record.handle = null
        transition(record, POD_LIFECYCLE.GONE, 'start-failed')
        throw new PodHostDriverError(POD_HOST_ERROR.EINVAL, `pod exited while starting (${earlyExit.reason})`, { name: value.name })
      }
      transition(record, POD_LIFECYCLE.REGISTERED, 'spawn')
      return statusOf(record)
    },

    async status(name) {
      return statusOf(require_(name))
    },

    async send(name, msg) {
      const record = requireLive(name)
      if (record.state !== POD_LIFECYCLE.REGISTERED && record.state !== POD_LIFECYCLE.SERVING) {
        throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, `pod '${name}' is ${record.state}`, { name })
      }
      record.sends += 1
      const timeoutMs = record.spec.limits?.timeoutMs ?? sendTimeoutMs
      try {
        const reply = await record.handle.request({ to: msg?.to ?? null, payload: msg?.payload ?? null }, { timeoutMs })
        return { delivered: true, reply }
      } catch (err) {
        if (err instanceof PodHostDriverError) throw err
        const timedOut = err?.code === 'ETIMEDOUT'
        throw new PodHostDriverError(
          timedOut ? POD_HOST_ERROR.ETIMEDOUT : POD_HOST_ERROR.EINVAL,
          timedOut ? `pod '${name}' did not reply within ${timeoutMs} ms` : `pod '${name}' failed the request: ${err?.message || String(err)}`,
          { name },
        )
      }
    },

    exec: createUnsupportedDriverMethod(POD_HOST_VERB.EXEC, lane),
    snapshot: createUnsupportedDriverMethod(POD_HOST_VERB.SNAPSHOT, lane),
    restore: createUnsupportedDriverMethod(POD_HOST_VERB.RESTORE, lane),

    async drain(name, opts = {}) {
      const record = require_(name)
      if (record.state !== POD_LIFECYCLE.GONE) {
        transition(record, POD_LIFECYCLE.DRAINING, 'drain')
        const handle = record.handle
        record.handle = null
        try {
          await handle?.terminate()
        } finally {
          transition(record, POD_LIFECYCLE.GONE, 'drain')
        }
      }
      emit(createHostEvent(POD_HOST_EVENT_KIND.EXIT, {
        name, lane, code: 0, cascade: opts.cascade === true, reason: 'drained', restartable: false,
      }))
      return statusOf(record)
    },

    async list() {
      return [...pods.values()].map(statusOf)
    },
  }

  /**
   * A pod stopped without being asked to.
   * @param {object} record
   * @param {{code: number|null, reason: string}} info
   */
  function onUnexpectedExit(record, info) {
    if (record.state === POD_LIFECYCLE.GONE || record.state === POD_LIFECYCLE.DRAINING) return
    record.handle = null
    transition(record, POD_LIFECYCLE.GONE, info.reason)
    emit(createHostEvent(POD_HOST_EVENT_KIND.EXIT, {
      name: record.name, lane, code: info.code ?? 1, reason: info.reason === 'exited' ? 'exited' : 'crashed', cause: info.reason, restartable: true,
    }))
  }
}
