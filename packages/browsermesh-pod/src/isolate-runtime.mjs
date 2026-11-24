/**
 * isolate-runtime.mjs -- `createIsolatedVmRuntime()`, the `PodRuntime` (see
 * `pod-runtime.mjs`) that runs each hosted pod in its own V8 isolate through
 * the `isolated-vm` native addon (issue #185, lane A). Import it from
 * `@johnhenry/browsermesh-pod/node-runtimes`.
 *
 * ## What it is
 *
 * One `Isolate` per pod, with its own heap, its own global object and its own
 * garbage collector, running in the HOST's process on a thread of the host's
 * thread pool. It declares `boundary: 'language'` and may be advertised as
 * the `isolate` lane.
 *
 * - **No ambient authority.** The isolate is a bare V8 context: no `require`,
 *   no `process`, no `Buffer`, no `fetch`, no filesystem, no network, no
 *   timers (`setTimeout` and friends do not exist). `WebAssembly` is removed
 *   because its memory is not counted against the isolate's memory limit.
 *   Dynamic `import()` is not supplied, and a hosted module that statically
 *   imports anything is refused at start.
 * - **Code from the catalog only.** The host reads the module from the
 *   catalog path the driver resolved (never from the requester) and compiles
 *   it as the only dependency of a small host-written wrapper module.
 * - **Limits enforced by the isolate.** A heap limit (`limits.memMib`, floor
 *   8 MiB, which V8 treats as a guideline rather than an exact cap) and a
 *   wall-time limit per call (`timeoutMs` of the request, or `startTimeoutMs`
 *   for loading). A breach disposes the isolate and is reported through
 *   `onExit` with the reason `'oom'` or `'timeout'`.
 * - **Everything crossing the boundary is a string.** Requests go in as a JSON
 *   string, replies come out as a JSON string no larger than `maxReplyBytes`,
 *   log lines go out as strings, `env` and `input` go in as JSON data. No
 *   `Reference`, `ExternalCopy` or object ever reaches the pod, and no object
 *   from the pod is ever handed to a host function.
 *
 * ## Capabilities handed into an isolate (each one is a capability)
 *
 * Exactly two values are given to pod code, both as function arguments of the
 * wrapper's `init()` and never as globals:
 *
 *   1. a plain JSON string (name, env, input, limits);
 *   2. one `ivm.Callback` (sync, copies arguments and result) that appends one
 *      log line: it receives a string, returns `undefined`, and defers the
 *      host's `onLog` to a microtask so a host handler never runs inside the
 *      callback's stack.
 *
 * The host holds `Reference`s to the wrapper's `init` and `dispatch` functions
 * and calls them with strings; they are never passed to the isolate.
 *
 * ## What it does NOT protect
 *
 * It is a V8 isolate in the host's process. A V8 or `isolated-vm` memory
 * safety bug is a bug in the host process: it can read and write whatever the
 * host can. The memory limit is not exact, the call timeout covers execution
 * and not the host's thread-pool queueing, and a pod can use up to one thread
 * of the host's pool while it runs. Run untrusted pods in a host process (or
 * a host on a machine) that holds nothing else worth stealing, and keep Node
 * current. See docs/design/hosted-pods-security-review.md.
 */

import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { POD_LANE } from './host-protocol.mjs'
import { RUNTIME_BOUNDARY } from './pod-runtime.mjs'

/** Error `code` of the error `createIsolatedVmRuntime()` throws when the addon is missing. */
export const ISOLATED_VM_UNAVAILABLE = 'ERR_ISOLATED_VM_UNAVAILABLE'

const DEFAULT_START_TIMEOUT_MS = 10_000
const DEFAULT_MEM_MIB = 128
/** isolated-vm refuses anything below this. */
const MIN_MEM_MIB = 8
const DEFAULT_MAX_REPLY_BYTES = 1024 * 1024
const DEFAULT_MAX_LOG_BYTES = 1024 * 1024
const MAX_LOG_LINE = 4096
const DEFAULT_MAX_IN_FLIGHT = 32
const WALL_GRACE_MS = 250

/** The fixed specifier the wrapper uses to import the hosted module. */
const POD_SPECIFIER = 'browsermesh:pod'

/**
 * The host-written wrapper compiled around the hosted module. Written by the
 * host, never by a requester. It is the only code that holds the log
 * callback; a hosted module reaches it through `ctx.log` and nothing else.
 */
const WRAPPER_SOURCE = `
import * as pod from '${POD_SPECIFIER}'

let ctx = null
let maxReplyChars = 0

function describe(err) {
  try {
    const value = err !== null && typeof err === 'object' && 'message' in err ? err.message : err
    return String(value).slice(0, 1024)
  } catch {
    return 'the pod threw a value that cannot be described'
  }
}

export async function init(configJson, hostLog) {
  try {
    const config = JSON.parse(configJson)
    maxReplyChars = config.maxReplyChars
    const log = (line) => {
      let text
      try { text = String(line) } catch { text = '[unprintable]' }
      hostLog(text.slice(0, config.maxLogLine))
    }
    ctx = Object.freeze({
      name: config.name,
      env: Object.freeze(config.env),
      input: config.input,
      log,
    })
    if (typeof pod.handle !== 'function') throw new Error('the module must export handle(payload, ctx)')
    if (typeof pod.start === 'function') await pod.start(ctx)
  } catch (err) {
    throw new Error(describe(err))
  }
  return 'ready'
}

export async function dispatch(requestJson) {
  try {
    const reply = await pod.handle(JSON.parse(requestJson), ctx)
    const text = JSON.stringify({ ok: true, reply: reply === undefined ? null : reply })
    if (typeof text !== 'string' || text.length > maxReplyChars) {
      return JSON.stringify({ ok: false, message: 'the reply is not JSON or is larger than this host allows' })
    }
    return text
  } catch (err) {
    return JSON.stringify({ ok: false, message: describe(err) })
  }
}
`

/** Runs in the context before any module: removes what the isolate gives for free but must not. */
const BOOTSTRAP_SOURCE = `
delete globalThis.WebAssembly
`

/**
 * Load the addon without throwing.
 * @param {{load?: () => object}} [opts] `load` replaces the loader (tests).
 * @returns {{available: true, ivm: object}|{available: false, reason: string}}
 */
function tryLoad({ load } = {}) {
  try {
    const ivm = load ? load() : createRequire(import.meta.url)('isolated-vm')
    if (!ivm || typeof ivm.Isolate !== 'function') {
      return { available: false, reason: "'isolated-vm' loaded but does not export Isolate" }
    }
    return { available: true, ivm }
  } catch (err) {
    return { available: false, reason: `'isolated-vm' could not be loaded: ${err?.message || String(err)}` }
  }
}

/**
 * Whether the optional `isolated-vm` addon can be loaded here, and why not.
 * Installs without a compiler (or on a platform with no prebuilt binary)
 * simply do not have it.
 *
 * @param {{load?: () => object}} [opts]
 * @returns {{available: boolean, reason?: string}}
 */
export function isolatedVmAvailability(opts) {
  const result = tryLoad(opts)
  return result.available ? { available: true } : { available: false, reason: result.reason }
}

/**
 * @param {object} [opts]
 * @param {number} [opts.startTimeoutMs=10000] Wall limit for loading the module and running its `start()`.
 * @param {number} [opts.defaultMemMib=128] Heap limit when the driver passes none.
 * @param {number} [opts.maxReplyBytes=1048576] Largest reply (as JSON text) a pod may return.
 * @param {number} [opts.maxRequestBytes=1048576] Largest request (as JSON text) sent into a pod.
 * @param {number} [opts.maxLogBytes=1048576] Total log text kept per pod; the rest is dropped.
 * @param {number} [opts.maxInFlight=32] Requests a pod may have outstanding.
 * @param {(message: string) => void} [opts.onCatastrophicError] Called when V8 reports it lost control
 *   of an isolate (isolated-vm advises ending the process; this runtime reports the pod as crashed and
 *   leaves that decision to the operator).
 * @param {() => object} [opts.load] Replaces the loader of `isolated-vm` (tests).
 * @returns {import('./pod-runtime.mjs').PodRuntime}
 * @throws {Error} with `code` `ERR_ISOLATED_VM_UNAVAILABLE` when the addon cannot be loaded.
 */
export function createIsolatedVmRuntime({
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  defaultMemMib = DEFAULT_MEM_MIB,
  maxReplyBytes = DEFAULT_MAX_REPLY_BYTES,
  maxRequestBytes = DEFAULT_MAX_REPLY_BYTES,
  maxLogBytes = DEFAULT_MAX_LOG_BYTES,
  maxInFlight = DEFAULT_MAX_IN_FLIGHT,
  onCatastrophicError,
  load,
} = {}) {
  const loaded = tryLoad({ load })
  if (!loaded.available) {
    const err = new Error(`the isolate runtime is unavailable: ${loaded.reason}`)
    err.code = ISOLATED_VM_UNAVAILABLE
    throw err
  }
  const ivm = loaded.ivm

  return {
    kind: 'isolated-vm',
    lane: POD_LANE.ISOLATE,
    boundary: RUNTIME_BOUNDARY.LANGUAGE,

    async start(opts) {
      if (typeof opts.modulePath !== 'string' || !isAbsolute(opts.modulePath)) {
        throw new Error('a hosted module path must be absolute')
      }
      const source = await readFile(opts.modulePath, 'utf8')
      const memMib = Math.max(MIN_MEM_MIB, opts.limits?.memMib ?? defaultMemMib)

      /** @type {{code: number|null, reason: string}|null} */
      let exitInfo = null
      let terminating = false
      let disposed = false
      /** @type {Set<(err: Error) => void>} */
      const pending = new Set()
      let logged = 0

      const isolate = new ivm.Isolate({
        memoryLimit: memMib,
        onCatastrophicError: (message) => {
          settleExit('crashed', 1)
          try { onCatastrophicError?.(String(message)) } catch { /* the operator's hook never breaks the runtime */ }
        },
        // A rejection nobody handled inside the pod is the pod's business, not an error thrown into the next call.
        onUnhandledRejection: () => {},
      })

      /** Dispose once; everything waiting on the isolate is failed. */
      function disposeIsolate(why) {
        if (disposed) return
        disposed = true
        for (const fail of [...pending]) fail(new Error(why))
        pending.clear()
        try { isolate.dispose() } catch { /* already gone */ }
      }

      /** The pod stopped on its own: report once, never for a terminate() we were asked for. */
      function settleExit(reason, code) {
        if (exitInfo || terminating) return
        exitInfo = { code, reason }
        disposeIsolate(`pod stopped: ${reason}`)
        if (startedOk) opts.onExit(exitInfo)
      }
      let startedOk = false

      /** @param {Error} err @returns {'oom'|'timeout'|null} */
      function classify(err) {
        const message = String(err?.message ?? '')
        if (/memory limit/i.test(message)) return 'oom'
        if (/timed out/i.test(message)) return 'timeout'
        return null
      }

      /**
       * Run one call into the isolate with a wall limit; a breach disposes the isolate.
       * @param {object} fnRef
       * @param {string} argument
       * @param {number} timeoutMs
       */
      function callIn(fnRef, argument, timeoutMs) {
        return new Promise((resolve, reject) => {
          let finished = false
          const fail = (err) => { if (!finished) { finished = true; clearTimeout(timer); pending.delete(fail); reject(err) } }
          pending.add(fail)
          // The isolate's own timeout covers running code. This backstop covers a call
          // that is not running (it awaits a promise nothing can resolve).
          const timer = setTimeout(() => {
            const err = new Error(`no reply within ${timeoutMs} ms`)
            err.code = 'ETIMEDOUT'
            fail(err)
            settleExit('timeout', 1)
          }, timeoutMs + WALL_GRACE_MS)
          fnRef.apply(undefined, [argument], { timeout: timeoutMs, result: { copy: true, promise: true } }).then(
            (value) => {
              if (finished) return
              finished = true
              clearTimeout(timer)
              pending.delete(fail)
              resolve(value)
            },
            (err) => {
              if (finished) return
              const reason = classify(err)
              const wrapped = new Error(reason === 'timeout' ? `no reply within ${timeoutMs} ms` : String(err?.message ?? err))
              if (reason === 'timeout') wrapped.code = 'ETIMEDOUT'
              fail(wrapped)
              if (reason) settleExit(reason, 1)
            },
          )
        })
      }

      try {
        const context = await isolate.createContext()
        await context.eval(BOOTSTRAP_SOURCE, { timeout: startTimeoutMs })

        const podModule = await isolate.compileModule(source, { filename: `file:///pod/${encodeURIComponent(opts.name)}.mjs` })
        if (podModule.dependencySpecifiers.length > 0) {
          throw new Error(`the module may not import anything in the isolate lane (it imports ${podModule.dependencySpecifiers.map((s) => `'${s}'`).join(', ')})`)
        }
        const wrapper = await isolate.compileModule(WRAPPER_SOURCE, { filename: 'file:///host/wrapper.mjs' })
        await wrapper.instantiate(context, (specifier) => {
          if (specifier === POD_SPECIFIER) return podModule
          throw new Error(`cannot import '${specifier}'`)
        })
        await wrapper.evaluate({ promise: true, timeout: startTimeoutMs })

        const initRef = await wrapper.namespace.get('init', { reference: true })
        const dispatchRef = await wrapper.namespace.get('dispatch', { reference: true })

        const logCallback = new ivm.Callback((line) => {
          const text = String(line)
          const size = Buffer.byteLength(text)
          if (logged >= maxLogBytes) return
          const truncating = logged + size > maxLogBytes
          logged += size
          // Deferred so a host handler never runs inside the isolate's callback.
          queueMicrotask(() => {
            try { opts.onLog(truncating ? '[log truncated: this pod passed its log limit]' : text) } catch { /* a throwing sink never reaches the pod */ }
          })
        })

        const config = JSON.stringify({
          name: opts.name,
          env: opts.env ?? {},
          input: opts.input ?? null,
          maxReplyChars: maxReplyBytes,
          maxLogLine: MAX_LOG_LINE,
        })
        await new Promise((resolve, reject) => {
          const fail = (err) => { clearTimeout(timer); pending.delete(fail); reject(err) }
          pending.add(fail)
          const timer = setTimeout(() => fail(new Error('timed out while starting')), startTimeoutMs + WALL_GRACE_MS)
          initRef.apply(undefined, [config, logCallback], { timeout: startTimeoutMs, result: { copy: true, promise: true } }).then(
            () => { clearTimeout(timer); pending.delete(fail); resolve() },
            (err) => { clearTimeout(timer); pending.delete(fail); reject(err) },
          )
        })

        startedOk = true
        // A breach while loading rejected start() above; one that raced the line above is reported now.
        if (exitInfo) {
          const reason = exitInfo.reason
          throw new Error(`the pod stopped while starting (${reason})`)
        }

        return {
          async request(payload, { timeoutMs = 5000 } = {}) {
            if (disposed) throw new Error(exitInfo ? `pod stopped: ${exitInfo.reason}` : 'pod terminated')
            if (pending.size >= maxInFlight) throw new Error(`the pod already has ${maxInFlight} requests outstanding`)
            const text = JSON.stringify(payload ?? null)
            if (text.length > maxRequestBytes) throw new Error(`the request is larger than ${maxRequestBytes} bytes`)
            const raw = await callIn(dispatchRef, text, timeoutMs)
            if (typeof raw !== 'string') throw new Error('the pod returned something that is not a reply')
            let parsed
            try { parsed = JSON.parse(raw) } catch { throw new Error('the pod returned a reply that is not JSON') }
            if (parsed?.ok !== true) throw new Error(typeof parsed?.message === 'string' ? parsed.message : 'the pod failed the request')
            return parsed.reply ?? null
          },
          async terminate() {
            terminating = true
            disposeIsolate('pod terminated')
          },
        }
      } catch (err) {
        terminating = true
        const reason = classify(err)
        disposeIsolate('pod failed to start')
        const message = reason === 'oom' ? 'the pod ran out of memory while starting'
          : reason === 'timeout' ? 'the pod timed out while starting'
            : String(err?.message ?? err)
        throw new Error(message)
      }
    },
  }
}
