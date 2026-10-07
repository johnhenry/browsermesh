/**
 * cdp.mjs — a minimal Chrome DevTools Protocol client, built on Node's
 * GLOBAL `WebSocket` (stable since Node 22; this spike targets Node 26) and
 * `node:child_process`. No `puppeteer`/`playwright`/`chrome-remote-interface`
 * — issue #185 item 7's browser lane rule is zero new runtime deps, and CDP
 * itself is just newline-free JSON-RPC over one WebSocket.
 *
 * Two exports:
 *   - `launchChrome(opts)` — spawn a real Chrome/Chromium with a remote
 *     debugging port and a throwaway profile, resolving once it prints its
 *     `ws://` debugger URL.
 *   - `connect(wsUrl)` — a `{send, on, close, ready}` client: `send(method,
 *     params, sessionId?)` is a `Promise` resolving to `result`, correlated
 *     by `id`; `on(method, fn)` subscribes to CDP events (including ones
 *     carrying a `sessionId`, CDP's "flat" multi-target session mode —
 *     https://chromedevtools.github.io/devtools-protocol/#flat — which this
 *     client always uses via `Target.attachToTarget({flatten: true})` so
 *     one WebSocket can drive many targets without per-target connections).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Common macOS app-bundle install locations, checked before PATH. */
const MAC_APP_PATHS = Object.freeze([
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
])

/** PATH executable names tried, in order, on any platform. */
const PATH_NAMES = Object.freeze(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'])

/**
 * Search every `PATH` directory for the first of `names` that exists.
 * @param {string[]} names
 * @returns {string|null}
 */
function searchPath(names) {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Find a Chrome/Chromium executable: `CHROME_PATH` env var first, then the
 * macOS app bundle locations, then `PATH`.
 *
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env=process.env]
 * @param {readonly string[]} [opts.macAppPaths=MAC_APP_PATHS] - Override,
 *   for testing a "nothing found" scenario deterministically on a machine
 *   that actually has Chrome installed.
 * @param {readonly string[]} [opts.pathNames=PATH_NAMES] - Same, for the
 *   `PATH` search names.
 * @returns {string|null} An executable path, or `null` if nothing was found.
 */
export function findChromeExecutable({
  env = process.env,
  macAppPaths = MAC_APP_PATHS,
  pathNames = PATH_NAMES,
} = {}) {
  if (env.CHROME_PATH && existsSync(env.CHROME_PATH)) return env.CHROME_PATH
  for (const candidate of macAppPaths) {
    if (existsSync(candidate)) return candidate
  }
  return searchPath(pathNames)
}

/**
 * Launch Chrome/Chromium with remote debugging enabled and a throwaway
 * profile, resolving once it prints "DevTools listening on ws://…" on
 * stderr (Chrome's own readiness signal for the debugging port — there is
 * no other reliable one without polling an HTTP endpoint).
 *
 * @param {object} [opts]
 * @param {string} [opts.executable] - Override `findChromeExecutable()`.
 * @param {boolean} [opts.headless=true] - `--headless=new` when true.
 * @param {string} [opts.userDataDir] - Reuse a profile dir instead of a
 *   fresh `mkdtemp()`'d one (which is also not cleaned up by `close()` when
 *   explicitly provided — only a dir this function created is removed).
 * @param {number} [opts.port=0] - `--remote-debugging-port`; `0` lets the
 *   OS assign a free port, read back from the same stderr line.
 * @param {string[]} [opts.args] - Extra Chrome flags, appended last.
 * @param {number} [opts.timeoutMs=15000] - How long to wait for the
 *   "DevTools listening" line before rejecting.
 * @param {typeof spawn} [opts.spawnImpl] - Injectable for testing.
 * @returns {Promise<{process: import('node:child_process').ChildProcess, wsUrl: string, port: number, userDataDir: string, close: () => Promise<void>}>}
 */
export async function launchChrome({
  executable,
  headless = true,
  userDataDir,
  port = 0,
  args: extraArgs = [],
  timeoutMs = 15000,
  spawnImpl = spawn,
} = {}) {
  const exe = executable || findChromeExecutable()
  if (!exe) {
    throw new Error(
      'launchChrome: no Chrome/Chromium executable found '
      + '(checked CHROME_PATH, /Applications/Google Chrome.app, and PATH)',
    )
  }
  const ownedProfile = !userDataDir
  const profileDir = userDataDir || mkdtempSync(join(tmpdir(), 'browsermesh-cdp-'))

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-popup-blocking',
    '--disable-sync',
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
  ]

  const child = spawnImpl(exe, args, { stdio: ['ignore', 'ignore', 'pipe'] })

  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.stderr.off('data', onData)
      reject(new Error(`launchChrome: timed out after ${timeoutMs}ms waiting for Chrome's "DevTools listening on ws://…" line`))
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    function onData(chunk) {
      buffer += chunk.toString('utf8')
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffer)
      if (match && !settled) {
        settled = true
        clearTimeout(timer)
        child.stderr.off('data', onData)
        resolve(match[1])
      }
    }
    child.stderr.on('data', onData)
    child.once('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`launchChrome: Chrome exited before it was ready (code ${code}, signal ${signal})`))
    })
  })

  return {
    process: child,
    wsUrl,
    port: Number(new URL(wsUrl).port) || port,
    userDataDir: profileDir,
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => {
          child.once('exit', () => resolve())
          child.kill('SIGTERM')
          const killTimer = setTimeout(() => {
            if (child.exitCode === null) child.kill('SIGKILL')
          }, 3000)
          if (typeof killTimer.unref === 'function') killTimer.unref()
        })
      }
      if (ownedProfile) {
        try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* best effort cleanup */ }
      }
    },
  }
}

/**
 * Connect a minimal CDP client to a running browser/target's `wsUrl`.
 *
 * @param {string} wsUrl
 * @param {object} [opts]
 * @param {typeof globalThis.WebSocket} [opts.WebSocketImpl] - Injectable,
 *   like every other adapter in this family (tests pass a fake).
 * @returns {{
 *   send: (method: string, params?: object, sessionId?: string) => Promise<*>,
 *   on: (method: string, fn: (params: object, sessionId?: string) => void) => (() => void),
 *   ready: () => Promise<void>,
 *   close: () => void,
 *   socket: *,
 * }}
 */
export function connect(wsUrl, { WebSocketImpl } = {}) {
  const WS = WebSocketImpl || globalThis.WebSocket
  if (typeof WS !== 'function') {
    throw new Error('connect: no global WebSocket available — pass opts.WebSocketImpl for a fake, or run on Node >=22')
  }
  const socket = new WS(wsUrl)

  let nextId = 1
  /** @type {Map<number, {resolve: Function, reject: Function}>} */
  const pending = new Map()
  /** @type {Map<string, Set<Function>>} */
  const eventHandlers = new Map()
  /** @type {{resolve: Function, reject: Function}[]} */
  const openWaiters = []
  let opened = false
  let closed = false

  socket.addEventListener('open', () => {
    opened = true
    for (const { resolve } of openWaiters.splice(0)) resolve()
  })
  socket.addEventListener('close', () => {
    closed = true
    for (const [, entry] of pending) entry.reject(new Error('cdp: connection closed'))
    pending.clear()
    // A send() still awaiting ready() must not hang forever if the socket
    // closes before ever opening (e.g. the server refused the connection,
    // or — as a test can legitimately do — close() races open()).
    for (const { reject } of openWaiters.splice(0)) reject(new Error('cdp: connection closed before it opened'))
  })
  socket.addEventListener('message', (event) => {
    let msg
    try {
      const raw = typeof event.data === 'string' ? event.data : event.data.toString('utf8')
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const entry = pending.get(msg.id)
      if (!entry) return
      pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(`${msg.error.message || 'CDP error'} (code ${msg.error.code ?? '?'})`))
      else entry.resolve(msg.result)
      return
    }
    if (msg.method) {
      const handlers = eventHandlers.get(msg.method)
      if (!handlers) return
      for (const fn of [...handlers]) {
        try { fn(msg.params || {}, msg.sessionId) } catch { /* a throwing subscriber never breaks others */ }
      }
    }
  })

  function ready() {
    if (opened) return Promise.resolve()
    if (closed) return Promise.reject(new Error('cdp: connection already closed'))
    return new Promise((resolve, reject) => openWaiters.push({ resolve, reject }))
  }

  /**
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId] - CDP "flat" session mode: addressing a
   *   specific attached target over the one shared WebSocket.
   * @returns {Promise<*>}
   */
  async function send(method, params = {}, sessionId) {
    await ready()
    return new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      const payload = sessionId ? { id, method, params, sessionId } : { id, method, params }
      socket.send(JSON.stringify(payload))
    })
  }

  /**
   * @param {string} method
   * @param {(params: object, sessionId?: string) => void} fn
   * @returns {() => void} Unsubscribe.
   */
  function on(method, fn) {
    if (!eventHandlers.has(method)) eventHandlers.set(method, new Set())
    eventHandlers.get(method).add(fn)
    return () => { eventHandlers.get(method)?.delete(fn) }
  }

  function close() {
    try { socket.close() } catch { /* already closed */ }
  }

  return { send, on, ready, close, socket }
}
