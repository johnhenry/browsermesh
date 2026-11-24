/**
 * node-runtimes.mjs -- the two `PodRuntime`s (see `pod-runtime.mjs`) that
 * Node can provide without a native dependency, and what each does and does
 * NOT protect. Import from `@johnhenry/browsermesh-pod/node-runtimes`; the
 * package root stays free of `node:` imports so it still loads in a Worker.
 *
 * ## `createWorkerThreadsRuntime()`  -- boundary `none`
 *
 * The pod is a `worker_threads` Worker in the host's own process. What it
 * gives: a heap limit (`resourceLimits`), an environment holding only what
 * the podspec named (the `env` option, not a copy of the host's), captured
 * stdout, and termination. What it does NOT give, and no flag changes:
 * the module can read and write any file the host process can, open any
 * network connection, spawn processes, and share the host's address space
 * with the host's secrets. `worker_threads` and `node:vm` are NOT security
 * boundaries. Use it to pack trusted modules into one process. It is
 * advertised as the `node` lane, never `isolate`, and the placement planner
 * only gives it work from requesters the operator trusts.
 *
 * ## `createPermissionProcessRuntime()`  -- boundary `process`
 *
 * The pod is a child Node process started with the permission model on:
 * `--permission` with read access to only the entry file, the hosted module
 * and the paths the catalog entry names; no write access, no network, no
 * child processes, no worker threads, no native addons, no WASI, no
 * inspector; an environment holding only what the podspec named; a heap
 * limit (`--max-old-space-size`). Node's own documentation says the
 * permission model is a safety net against mistakes, not a sandbox against
 * hostile code: the pod shares the host's user and kernel, and anything the
 * model does not cover (for example already-open file descriptors, the
 * process's own `/proc`, kernel and V8 vulnerabilities) is open to it. It
 * is `process`, not `language` or `hardware`, so untrusted requesters are
 * not placed on it.
 *
 * Neither is the isolate lane. See `pod-runtime.mjs` for how an
 * `isolated-vm` or `workerd` runtime plugs into the same interface.
 */

import { Worker } from 'node:worker_threads'
import { fork } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isAbsolute } from 'node:path'
import { POD_LANE } from './host-protocol.mjs'
import { RUNTIME_BOUNDARY } from './pod-runtime.mjs'

const ENTRY_PATH = fileURLToPath(new URL('./node-runtime-entry.mjs', import.meta.url))

/** How long `start()` waits for the module to load. */
const DEFAULT_START_TIMEOUT_MS = 10_000

/** How much of a child's stderr is kept to classify its exit. */
const STDERR_TAIL_BYTES = 4096

/**
 * @param {string} modulePath
 * @returns {string}
 */
function requireAbsolute(modulePath) {
  if (typeof modulePath !== 'string' || !isAbsolute(modulePath)) {
    throw new Error('a hosted module path must be absolute')
  }
  return modulePath
}

/**
 * Split a stream into lines for `onLog`.
 * @param {import('node:stream').Readable|null} stream
 * @param {(line: string) => void} onLine
 */
function forEachLine(stream, onLine) {
  if (!stream) return
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    let at = buffer.indexOf('\n')
    while (at !== -1) {
      onLine(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      at = buffer.indexOf('\n')
    }
  })
  stream.on('end', () => { if (buffer) onLine(buffer) })
}

/**
 * The request/reply plumbing both runtimes share: a handle over a channel
 * that speaks `node-runtime-entry.mjs`'s protocol.
 *
 * @param {object} channel
 * @param {(message: object) => void} channel.send
 * @returns {{handle: object, onMessage: (m: object) => void, failAll: (err: Error) => void}}
 */
function makeRequester(channel) {
  let nextId = 1
  /** @type {Map<number, {resolve: Function, reject: Function, timer: *}>} */
  const pending = new Map()
  return {
    handle: {
      request(payload, { timeoutMs = 5000 } = {}) {
        return new Promise((resolve, reject) => {
          const id = nextId
          nextId += 1
          const timer = setTimeout(() => {
            pending.delete(id)
            const err = new Error(`no reply within ${timeoutMs} ms`)
            err.code = 'ETIMEDOUT'
            reject(err)
          }, timeoutMs)
          pending.set(id, { resolve, reject, timer })
          channel.send({ type: 'request', id, payload })
        })
      },
    },
    onMessage(message) {
      if (message?.type !== 'reply') return
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.ok) entry.resolve(message.reply)
      else entry.reject(new Error(message.message))
    },
    failAll(err) {
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer)
        entry.reject(err)
        pending.delete(id)
      }
    },
  }
}

/**
 * @param {object} [opts]
 * @param {number} [opts.startTimeoutMs]
 * @returns {import('./pod-runtime.mjs').PodRuntime}
 */
export function createWorkerThreadsRuntime({ startTimeoutMs = DEFAULT_START_TIMEOUT_MS } = {}) {
  return {
    kind: 'worker_threads',
    lane: POD_LANE.NODE,
    boundary: RUNTIME_BOUNDARY.NONE,

    start(opts) {
      requireAbsolute(opts.modulePath)
      return new Promise((resolve, reject) => {
        const worker = new Worker(ENTRY_PATH, {
          workerData: {
            name: opts.name,
            moduleUrl: pathToFileURL(opts.modulePath).href,
            env: opts.env,
            input: opts.input,
          },
          // An environment of exactly what the podspec named, not a copy of the host's.
          env: { ...opts.env },
          execArgv: [],
          argv: [],
          stdout: true,
          stderr: true,
          resourceLimits: { maxOldGenerationSizeMb: opts.limits?.memMib },
        })
        const requester = makeRequester({ send: (message) => worker.postMessage(message) })
        forEachLine(worker.stdout, opts.onLog)
        forEachLine(worker.stderr, opts.onLog)

        let settled = false
        let terminating = false
        /** @type {string|null} */
        let failure = null
        const timer = setTimeout(() => finish(new Error('timed out while starting')), startTimeoutMs)

        /** @param {Error|null} err */
        function finish(err) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (err) {
            worker.terminate().catch(() => {})
            reject(err)
          } else {
            resolve({
              request: requester.handle.request,
              async terminate() {
                terminating = true
                requester.failAll(new Error('pod terminated'))
                await worker.terminate()
              },
            })
          }
        }

        worker.on('message', (message) => {
          if (message?.type === 'ready') finish(null)
          else if (message?.type === 'start-error') finish(new Error(message.message))
          else if (message?.type === 'log') opts.onLog(message.line)
          else requester.onMessage(message)
        })
        worker.on('error', (err) => {
          failure = err?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'oom' : 'crashed'
          if (!settled) finish(err)
        })
        worker.on('exit', (code) => {
          requester.failAll(new Error('pod exited'))
          if (!settled) { finish(new Error(`worker exited with code ${code} while starting`)); return }
          if (terminating) return
          opts.onExit({ code, reason: failure ?? (code === 0 ? 'exited' : 'crashed') })
        })
      })
    },
  }
}

/**
 * @param {object} [opts]
 * @param {number} [opts.startTimeoutMs]
 * @param {string} [opts.nodePath=process.execPath]
 * @returns {import('./pod-runtime.mjs').PodRuntime}
 */
export function createPermissionProcessRuntime({ startTimeoutMs = DEFAULT_START_TIMEOUT_MS, nodePath = process.execPath } = {}) {
  return {
    kind: 'node-permission-process',
    lane: POD_LANE.NODE,
    boundary: RUNTIME_BOUNDARY.PROCESS,

    start(opts) {
      requireAbsolute(opts.modulePath)
      return new Promise((resolve, reject) => {
        // The permission model matches real paths; /tmp and /var are symlinks on macOS.
        const readable = [ENTRY_PATH, opts.modulePath, ...(opts.readPaths ?? [])].map((p) => realpathSync(p))
        const memMib = opts.limits?.memMib
        const child = fork(ENTRY_PATH, [JSON.stringify({
          name: opts.name,
          moduleUrl: pathToFileURL(realpathSync(opts.modulePath)).href,
          env: opts.env,
          input: opts.input,
        })], {
          execPath: nodePath,
          execArgv: [
            '--permission',
            ...readable.map((p) => `--allow-fs-read=${p}`),
            ...(memMib ? [`--max-old-space-size=${memMib}`] : []),
          ],
          // Exactly what the podspec named: nothing of the host's environment.
          env: { ...opts.env },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
          serialization: 'json',
        })
        const requester = makeRequester({ send: (message) => child.send(message) })
        forEachLine(child.stdout, opts.onLog)
        let stderrTail = ''
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk) => {
          stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
        })

        let settled = false
        let terminating = false
        const timer = setTimeout(() => finish(new Error('timed out while starting')), startTimeoutMs)

        /** @param {Error|null} err */
        function finish(err) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          if (err) {
            child.kill('SIGKILL')
            reject(err)
          } else {
            resolve({
              request: requester.handle.request,
              terminate() {
                terminating = true
                requester.failAll(new Error('pod terminated'))
                return new Promise((done) => {
                  if (child.exitCode !== null || child.signalCode !== null) { done(); return }
                  child.once('exit', () => done())
                  child.kill('SIGKILL')
                })
              },
            })
          }
        }

        child.on('message', (message) => {
          if (message?.type === 'ready') finish(null)
          else if (message?.type === 'start-error') finish(new Error(message.message))
          else if (message?.type === 'log') opts.onLog(message.line)
          else requester.onMessage(message)
        })
        child.on('error', (err) => { if (!settled) finish(err) })
        child.on('exit', (code, signal) => {
          requester.failAll(new Error('pod exited'))
          if (!settled) { finish(new Error(`process exited with ${signal ?? code} while starting: ${stderrTail.trim().split('\n').at(-1) ?? ''}`)); return }
          if (terminating) return
          const oom = /heap out of memory|ERR_WORKER_OUT_OF_MEMORY|allocation failed/i.test(stderrTail)
          opts.onExit({
            code: code ?? 1,
            reason: oom ? 'oom' : (code === 0 && !signal ? 'exited' : 'crashed'),
          })
        })
      })
    },
  }
}
