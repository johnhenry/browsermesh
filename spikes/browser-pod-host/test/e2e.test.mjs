/**
 * e2e.test.mjs -- the CDP driver against a REAL headless Chrome (issue
 * #185 item 7, deliverable B). Launches Chrome itself as a child process
 * from inside this file (no background bash, no Monitor — `after()` kills
 * it synchronously with the rest of the suite), serves `static/pod.html`
 * plus the real `@johnhenry/browsermesh-pod` / `@johnhenry/browsermesh-primitives`
 * source trees over a tiny `node:http` server, and drives two browser-lane
 * pods through `spawn` → `status` → `exec` → `drain`.
 *
 * Skips with a clear, printed reason if no Chrome/Chromium can be found —
 * checked via `findChromeExecutable()` (macOS app bundle, `CHROME_PATH`,
 * `PATH`) BEFORE anything else runs, so a machine without a browser still
 * gets a clean, fast, reported skip rather than a confusing timeout.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { findChromeExecutable, launchChrome, connect } from '../src/cdp.mjs'
import { createCdpDriver } from '../src/driver.mjs'
import { POD_LIFECYCLE } from '../../../packages/browsermesh-pod/src/index.mjs'
import { startStaticServer } from './static-server.mjs'

const chromeExecutable = findChromeExecutable()
const SKIP_REASON = chromeExecutable
  ? false
  : 'no Chrome/Chromium executable found (checked CHROME_PATH, /Applications/Google Chrome.app, and PATH) — install one or set CHROME_PATH to run this suite'

if (!chromeExecutable) {
  console.log(`[e2e] SKIPPING: ${SKIP_REASON}`)
} else {
  console.log(`[e2e] using Chrome executable: ${chromeExecutable}`)
}

describe('CDP driver against real headless Chrome', { skip: SKIP_REASON }, () => {
  /** @type {Awaited<ReturnType<typeof startStaticServer>>} */
  let server
  /** @type {Awaited<ReturnType<typeof launchChrome>>} */
  let chrome
  /** @type {ReturnType<typeof connect>} */
  let cdp
  /** @type {import('../../../packages/browsermesh-pod/src/index.mjs').PodHostDriver} */
  let driver
  /** @type {Record<string, number>} */
  const timings = {}

  before(async () => {
    server = await startStaticServer()
    console.log(`[e2e] static server: ${server.baseUrl}`)

    const launchStart = Date.now()
    chrome = await launchChrome({ executable: chromeExecutable, timeoutMs: 20000 })
    timings.launchMs = Date.now() - launchStart
    console.log(`[e2e] chrome pid ${chrome.process.pid}, ready in ${timings.launchMs}ms, ${chrome.wsUrl}`)

    cdp = connect(chrome.wsUrl)
    await cdp.ready()

    driver = createCdpDriver({ cdp, podUrl: `${server.baseUrl}/pod.html`, contextPerPod: true, spawnTimeoutMs: 15000 })
  })

  after(async () => {
    if (cdp) cdp.close()
    if (chrome) await chrome.close()
    if (server) await server.close()
  })

  it('spawns a pod, reports registered, and the lane/kind are right', async () => {
    const start = Date.now()
    const status = await driver.spawn({
      name: 'alpha', lane: 'browser', run: { kind: 'module', ref: 'pod-page' },
    })
    timings.spawnAlphaMs = Date.now() - start
    console.log(`[e2e] spawn(alpha) -> registered in ${timings.spawnAlphaMs}ms`)

    assert.equal(status.name, 'alpha')
    assert.equal(status.lane, 'browser')
    assert.equal(status.state, POD_LIFECYCLE.REGISTERED)
    assert.ok(status.podId, 'a real Pod should have generated a podId')
    assert.ok(status.targetId, 'should have a real CDP targetId')

    const reread = await driver.status('alpha')
    assert.equal(reread.state, POD_LIFECYCLE.REGISTERED)
    assert.equal(reread.podId, status.podId)
  })

  it('spawns a second pod in its own browser context (tenant isolation)', async () => {
    const start = Date.now()
    const status = await driver.spawn({
      name: 'beta', lane: 'browser', run: { kind: 'module', ref: 'pod-page' },
    })
    timings.spawnBetaMs = Date.now() - start
    console.log(`[e2e] spawn(beta) -> registered in ${timings.spawnBetaMs}ms`)

    assert.equal(status.state, POD_LIFECYCLE.REGISTERED)
    const alpha = await driver.status('alpha')
    // Two different real pods (different generated podIds) in two different contexts.
    assert.notEqual(status.podId, alpha.podId)
  })

  it('exec() really evaluates script in the page via Runtime.evaluate', async () => {
    const start = Date.now()
    const result = await driver.exec('alpha', ['1 + 1'])
    timings.execRttMs = Date.now() - start
    console.log(`[e2e] exec(alpha, '1 + 1') -> ${JSON.stringify(result)} in ${timings.execRttMs}ms`)

    assert.deepEqual(result, { stdout: '2', stderr: '', code: 0 })
  })

  it('exec() can read the page\'s own DOM (document.title), proving it runs in the real page', async () => {
    const result = await driver.exec('alpha', ['document.title'])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /^pod: /)
  })

  it('send() reaches the pod\'s own broadcast() without throwing', async () => {
    const result = await driver.send('alpha', { payload: { ping: true } })
    assert.equal(result.delivered, true)
  })

  it('list() reports both live pods', async () => {
    const list = await driver.list()
    assert.deepEqual(list.map((p) => p.name).sort(), ['alpha', 'beta'])
    assert.ok(list.every((p) => p.state === POD_LIFECYCLE.REGISTERED))
  })

  it('drain() closes the CDP target for real (gone from Target.getTargets())', async () => {
    const before_ = await cdp.send('Target.getTargets')
    const alphaStatus = await driver.status('alpha')
    assert.ok(before_.targetInfos.some((t) => t.targetId === alphaStatus.targetId))

    const drained = await driver.drain('alpha')
    assert.equal(drained.state, POD_LIFECYCLE.GONE)

    const after_ = await cdp.send('Target.getTargets')
    assert.ok(!after_.targetInfos.some((t) => t.targetId === alphaStatus.targetId), 'target should be gone after drain')

    await driver.drain('beta')
  })

  it('prints the measured timings', () => {
    console.log(`[e2e] timings: ${JSON.stringify(timings)}`)
    assert.ok(timings.spawnAlphaMs > 0)
    assert.ok(timings.execRttMs >= 0)
  })
})
