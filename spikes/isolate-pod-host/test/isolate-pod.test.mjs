/**
 * isolate-pod.test.mjs — end-to-end spike verification (issue #185 WP2).
 *
 * Spawns, as real child processes:
 *   1. the browsermesh-servers relay    (node ../../browsermesh-servers/relay/index.mjs)
 *   2. the browsermesh-servers signaling (node ../../browsermesh-servers/signaling/index.mjs)
 *   3. `wrangler dev` serving this spike's worker.mjs / PodObject
 *
 * and one in-process Node pod (this test file itself, using
 * `@johnhenry/browsermesh-pod`'s `Pod` + our temporary `ws-transport.mjs`),
 * then:
 *   - boots a DO-hosted pod named "alpha" via `POST /pods/alpha/boot`
 *   - asserts the Node pod and the DO pod discover each other (mutual
 *     `peers`) within 10s
 *   - measures a message round trip through the relay
 *
 * All processes are spawned and torn down synchronously from this file, per
 * the WP2 task rules — no background bash, no Monitor. `after()` kills every
 * child.
 *
 * If `wrangler dev` cannot start in this environment (no network access to
 * download the workerd binary, sandboxed /dev/kvm-less CI, etc.) the whole
 * suite is SKIPPED (not failed) with a clear reason, after a real attempt
 * to start it with a generous timeout.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { Pod, TransportDiscovery } from '../../../packages/browsermesh-pod/src/index.mjs'
import { PodIdentity } from '../../../packages/browsermesh-primitives/src/index.mjs'
import { WebSocketTransport } from '../src/ws-transport.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SPIKE_ROOT = path.resolve(__dirname, '..')
const REPO_ROOT = path.resolve(SPIKE_ROOT, '..', '..')
const SERVERS_ROOT = path.join(REPO_ROOT, 'browsermesh-servers')

const WRANGLER_START_TIMEOUT_MS = 60_000
const HEALTH_POLL_INTERVAL_MS = 250
const DISCOVERY_WINDOW_MS = 10_000

/** @type {{proc: import('node:child_process').ChildProcess, name: string}[]} */
const children = []
let relayPort, signalingPort, workerPort
let wranglerAvailable = false
let skipReason = ''
let tearingDown = false
const timings = {}

// ── Helpers ──────────────────────────────────────────────────────────

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

function spawnChild(name, cmd, args, opts) {
  const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts })
  const tag = `[${name}]`
  let out = ''
  proc.stdout.on('data', (d) => { out += d.toString() })
  proc.stderr.on('data', (d) => { out += d.toString() })
  proc.on('exit', (code, signal) => {
    if (!tearingDown && code !== 0 && code !== null) {
      console.log(`${tag} exited unexpectedly with code ${code} signal ${signal}\n--- output ---\n${out.slice(-4000)}`)
    }
  })
  children.push({ proc, name })
  return proc
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url)
      if (resp.ok) return true
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS))
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs}ms: ${lastErr && lastErr.message}`)
}

async function killAll() {
  tearingDown = true
  await Promise.all(children.map(({ proc }) => new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
    proc.once('exit', resolve)
    proc.kill('SIGTERM')
    setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    }, 3000)
  })))
}

// ── Setup ────────────────────────────────────────────────────────────

before(async () => {
  [relayPort, signalingPort, workerPort] = await Promise.all([
    getFreePort(), getFreePort(), getFreePort(),
  ])

  spawnChild('relay', process.execPath, [path.join(SERVERS_ROOT, 'relay', 'index.mjs')], {
    cwd: SERVERS_ROOT,
    env: { ...process.env, PORT: String(relayPort) },
  })
  spawnChild('signaling', process.execPath, [path.join(SERVERS_ROOT, 'signaling', 'index.mjs')], {
    cwd: SERVERS_ROOT,
    env: { ...process.env, PORT: String(signalingPort) },
  })

  await waitForHealth(`http://localhost:${relayPort}/health`, 10_000)
  await waitForHealth(`http://localhost:${signalingPort}/health`, 10_000)

  const wranglerBin = path.join(SPIKE_ROOT, 'node_modules', '.bin', 'wrangler')
  spawnChild('wrangler', wranglerBin, [
    'dev',
    '--port', String(workerPort),
    '--local',
    '--var', `RELAY_URL:ws://localhost:${relayPort}`,
    '--var', `SIGNALING_URL:ws://localhost:${signalingPort}`,
  ], { cwd: SPIKE_ROOT, env: { ...process.env, CI: 'true' } })

  try {
    const t0 = Date.now()
    await waitForHealth(`http://localhost:${workerPort}/health`, WRANGLER_START_TIMEOUT_MS)
    timings.wranglerStartMs = Date.now() - t0
    wranglerAvailable = true
  } catch (err) {
    wranglerAvailable = false
    skipReason = `wrangler dev did not come up within ${WRANGLER_START_TIMEOUT_MS}ms: ${err.message}`
  }
})

after(async () => {
  await killAll()
})

// ── Tests ────────────────────────────────────────────────────────────

test('wrangler dry-run bundles the worker', { skip: false }, async (t) => {
  // This is a cheap, always-run sanity check independent of wrangler dev
  // actually coming up — bundling is the thing most likely to break when
  // the pod/primitives packages change, and it fails fast (no server
  // needed).
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const wranglerBin = path.join(SPIKE_ROOT, 'node_modules', '.bin', 'wrangler')
  const { stdout } = await run(wranglerBin, ['deploy', '--dry-run', '--outdir', 'dist'], { cwd: SPIKE_ROOT })
  assert.match(stdout, /Total Upload/)
  t.diagnostic(stdout.trim())
})

test('DO pod boots and a Node pod discovers it through the relay within 10s', async (t) => {
  if (!wranglerAvailable) {
    t.skip(skipReason)
    return
  }

  // 1. Boot the DO-hosted pod "alpha".
  const bootT0 = Date.now()
  const bootResp = await fetch(`http://localhost:${workerPort}/pods/alpha/boot`, { method: 'POST' })
  const bootBody = await bootResp.json()
  const bootWallMs = Date.now() - bootT0
  assert.equal(bootResp.status, 200, `boot failed: ${JSON.stringify(bootBody)}`)
  assert.ok(bootBody.podId, 'boot response must include podId')
  assert.equal(bootBody.booted, true)
  timings.doBootMs = bootBody.bootMs
  timings.doRegisteredMs = bootBody.registeredMs
  timings.doBootWallMs = bootWallMs
  t.diagnostic(
    `DO pod alpha: registeredMs=${bootBody.registeredMs} (relay+signaling handshake), ` +
    `bootMs=${bootBody.bootMs} (includes Pod's fixed discovery window), wall=${bootWallMs}ms, podId=${bootBody.podId}`
  )

  // 2. Boot a Node pod in-process on the same relay/signaling pair, using
  //    our temporary ws-transport.mjs (the WP1 adapter is not available in
  //    this clone — see ws-transport.mjs header comment).
  const nodeIdentity = await PodIdentity.generate()
  const nodeTransport = new WebSocketTransport({
    url: `ws://localhost:${relayPort}`,
    podId: nodeIdentity.podId,
    signalingUrl: `ws://localhost:${signalingPort}`,
    peersFromSignaling: true,
    onLog: (msg) => t.diagnostic(msg),
  })
  const nodeDiscovery = new TransportDiscovery({
    transport: nodeTransport,
    localPodId: nodeIdentity.podId,
    localKind: 'server',
    timeout: 1500,
  })
  const nodePod = new Pod()
  const nodeBootT0 = Date.now()
  await nodePod.boot({ identity: nodeIdentity, transport: nodeTransport, discovery: nodeDiscovery })
  timings.nodeBootToRegisteredMs = Date.now() - nodeBootT0
  t.diagnostic(`Node pod booted in ${timings.nodeBootToRegisteredMs}ms, podId=${nodeIdentity.podId}`)

  t.after(async () => {
    await nodePod.shutdown({ silent: true })
  })

  // 3. Poll both sides for mutual discovery within the 10s budget.
  const deadline = Date.now() + DISCOVERY_WINDOW_MS
  let nodeSeesAlpha = nodePod.peers.has(bootBody.podId)
  let alphaSeesNode = false
  while (Date.now() < deadline && !(nodeSeesAlpha && alphaSeesNode)) {
    nodeSeesAlpha = nodePod.peers.has(bootBody.podId)
    if (!alphaSeesNode) {
      const statusResp = await fetch(`http://localhost:${workerPort}/pods/alpha/status`)
      const status = await statusResp.json()
      alphaSeesNode = status.peers.includes(nodeIdentity.podId)
    }
    if (nodeSeesAlpha && alphaSeesNode) break
    await new Promise((r) => setTimeout(r, 200))
  }

  assert.ok(nodeSeesAlpha, `Node pod never saw alpha (podId=${bootBody.podId}) in its peers within ${DISCOVERY_WINDOW_MS}ms`)
  assert.ok(alphaSeesNode, `DO pod alpha never saw the Node pod (podId=${nodeIdentity.podId}) in its peers within ${DISCOVERY_WINDOW_MS}ms`)

  // 4. Message round trip: Node pod pings alpha, alpha's EchoPod replies.
  const rtt = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no pong within 5s')), 5000)
    nodePod.on('message', (msg) => {
      if (msg.payload && msg.payload.pong === true) {
        clearTimeout(timer)
        resolve(Date.now() - msg.payload.t0)
      }
    })
    nodePod.send(bootBody.podId, { ping: true, t0: Date.now() })
  })
  timings.messageRttMs = rtt
  t.diagnostic(`message RTT through relay: ${rtt}ms`)
  assert.ok(rtt >= 0 && rtt < 5000, `RTT out of expected range: ${rtt}ms`)
})

test('report measured timings', (t) => {
  if (!wranglerAvailable) {
    t.skip(skipReason)
    return
  }
  // Not an assertion — this is here so `node --test` output includes the
  // numbers README.md's measurements table is built from.
  t.diagnostic(`MEASURED TIMINGS: ${JSON.stringify(timings, null, 2)}`)
  assert.ok(true)
})
