/**
 * Start the real browsermesh-servers signalling server as a child process on a
 * loopback port, for tests that must run against the server itself and not a
 * double of it.
 *
 * The server lives in a sibling repository. Where its folder is absent (CI) the
 * helper reports `available: false` with the reason and the caller skips; a
 * missing folder never fails a run. Set BROWSERMESH_SERVERS_DIR to point at a
 * checkout elsewhere, and REQUIRE_REAL_SIGNALING=1 to make absence an error.
 *
 * Only loopback is touched: the child listens on 127.0.0.1 and is given a
 * minimal environment (no inherited secrets).
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')

function candidates() {
  const out = []
  if (process.env.BROWSERMESH_SERVERS_DIR) out.push(path.resolve(process.env.BROWSERMESH_SERVERS_DIR))
  // A sibling checkout of the main clone, or of a worktree one level deeper.
  out.push(path.resolve(repoRoot, '..', 'browsermesh-servers'))
  out.push(path.resolve(repoRoot, '..', '..', 'browsermesh-servers'))
  return out
}

/** @returns {{ available: true, dir: string } | { available: false, reason: string }} */
export function locateSignalingServer() {
  for (const dir of candidates()) {
    const entry = path.join(dir, 'signaling', 'index.mjs')
    if (!existsSync(entry)) continue
    // The server needs `ws`, installed in the servers repo (root or its own folder).
    const hasWs = existsSync(path.join(dir, 'node_modules', 'ws')) || existsSync(path.join(dir, 'signaling', 'node_modules', 'ws'))
    if (!hasWs) return { available: false, reason: `${dir} has no installed dependencies (run npm ci there)` }
    return { available: true, dir }
  }
  return { available: false, reason: 'the browsermesh-servers checkout is not next to this repository (set BROWSERMESH_SERVERS_DIR)' }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })
}

/**
 * @param {object} o
 * @param {'open'|'authenticated'} o.mode
 * @param {Record<string,string>} [o.env] - extra server environment
 * @returns {Promise<{ port: number, wsUrl: string, httpUrl: string, stop: () => Promise<void> }>}
 */
export async function startRealSignalingServer({ mode, env = {} }) {
  const found = locateSignalingServer()
  if (!found.available) throw new Error(`real signalling server unavailable: ${found.reason}`)
  const port = await freePort()
  const wsUrl = `ws://127.0.0.1:${port}`
  const childEnv = {
    PATH: process.env.PATH ?? '',
    PORT: String(port),
    AUTH_MODE: mode,
    ...(mode === 'authenticated' ? { PUBLIC_ORIGIN: wsUrl } : {}),
    ...env,
  }
  const child = spawn(process.execPath, [path.join(found.dir, 'signaling', 'index.mjs')], {
    cwd: path.join(found.dir, 'signaling'),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })

  await new Promise((resolve, reject) => {
    const onData = () => { if (/listening on port/.test(log)) { cleanup(); resolve() } }
    const onExit = (code) => { cleanup(); reject(new Error(`signalling server exited ${code} before listening:\n${log}`)) }
    const cleanup = () => { child.stdout.off('data', onData); child.off('exit', onExit) }
    child.stdout.on('data', onData)
    child.once('exit', onExit)
    onData()
  })

  return {
    port,
    wsUrl,
    httpUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) return resolve()
      child.once('exit', () => resolve())
      child.kill('SIGTERM')
    }),
  }
}
