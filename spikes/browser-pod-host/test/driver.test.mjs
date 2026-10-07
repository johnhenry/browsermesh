/**
 * Tests for driver.mjs -- `createCdpDriver()` against a fake `cdp` client
 * (same shape `cdp.mjs`'s `connect()` returns: `{send(method, params,
 * sessionId)}`), covering the full lifecycle, `exec` (supported, unlike the
 * in-page driver), `snapshot`/`restore` (`ENOTSUP`), and `drain`.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createCdpDriver } from '../src/driver.mjs'
import { POD_HOST_ERROR, POD_LANE, POD_LIFECYCLE } from '../../../packages/browsermesh-pod/src/index.mjs'

/**
 * A fake CDP client. `handlers[method]` is `(params, sessionId) => result`
 * (sync return, or a Promise); unhandled methods return `{}`.
 */
function makeFakeCdp(handlers = {}) {
  /** @type {{method: string, params: object, sessionId: string|undefined}[]} */
  const calls = []
  return {
    calls,
    async send(method, params = {}, sessionId) {
      calls.push({ method, params, sessionId })
      const handler = handlers[method]
      if (!handler) return {}
      return handler(params, sessionId)
    },
  }
}

/** A handler for Runtime.evaluate that reports "not ready" `notReadyCount`
 * times, then "ready" with `name`/`podId` for every poll after that. */
function readyAfter(notReadyCount, { name, podId }) {
  let calls = 0
  return (params) => {
    calls += 1
    if (params.expression.includes('__browsermeshHosted') && calls > notReadyCount) {
      return { result: { value: { ready: true, podId, name } } }
    }
    return { result: { value: { ready: false } } }
  }
}

function browserSpec(overrides = {}) {
  return { name: 'tab-1', lane: POD_LANE.BROWSER, run: { kind: 'module', ref: 'pod-page' }, ...overrides }
}

describe('createCdpDriver: construction', () => {
  it('requires cdp and podUrl', () => {
    assert.throws(() => createCdpDriver({ podUrl: 'https://x' }), /cdp \(a connect\(\) result\) is required/)
    assert.throws(() => createCdpDriver({ cdp: makeFakeCdp() }), /podUrl is required/)
  })
})

describe('createCdpDriver: lifecycle', () => {
  it('spawns via createBrowserContext + createTarget + attachToTarget, polls to registered', async () => {
    const cdp = makeFakeCdp({
      'Target.createBrowserContext': () => ({ browserContextId: 'ctx-1' }),
      'Target.createTarget': (params) => {
        assert.equal(params.browserContextId, 'ctx-1')
        assert.match(params.url, /^https:\/\/pods\.example\/pod\.html#name=tab-1$/)
        return { targetId: 'target-1' }
      },
      'Target.attachToTarget': (params) => {
        assert.equal(params.targetId, 'target-1')
        assert.equal(params.flatten, true)
        return { sessionId: 'session-1' }
      },
      'Runtime.evaluate': readyAfter(2, { name: 'tab-1', podId: 'pod-xyz' }),
    })
    const driver = createCdpDriver({ cdp, podUrl: 'https://pods.example/pod.html', spawnTimeoutMs: 2000 })
    assert.equal(driver.lane, POD_LANE.BROWSER)
    assert.deepEqual(driver.capabilities().verbs, ['spawn', 'status', 'send', 'exec', 'drain', 'list'])

    const status = await driver.spawn(browserSpec())
    assert.equal(status.name, 'tab-1')
    assert.equal(status.state, POD_LIFECYCLE.REGISTERED)
    assert.equal(status.podId, 'pod-xyz')

    const runtimeCalls = cdp.calls.filter((c) => c.method === 'Runtime.evaluate')
    assert.ok(runtimeCalls.length >= 3, 'should have polled more than once')
    // Every Runtime.evaluate call for this pod is addressed to its session.
    assert.ok(runtimeCalls.every((c) => c.sessionId === 'session-1'))
  })

  it('skips createBrowserContext when contextPerPod is false', async () => {
    const cdp = makeFakeCdp({
      'Target.createTarget': (params) => {
        assert.ok(!('browserContextId' in params))
        return { targetId: 't1' }
      },
      'Target.attachToTarget': () => ({ sessionId: 's1' }),
      'Runtime.evaluate': readyAfter(0, { name: 'tab-1', podId: 'pod-1' }),
    })
    const driver = createCdpDriver({ cdp, podUrl: 'https://x/pod.html', contextPerPod: false, spawnTimeoutMs: 1000 })
    await driver.spawn(browserSpec())
    assert.ok(!cdp.calls.some((c) => c.method === 'Target.createBrowserContext'))
  })

  it('status() reflects the record; unknown name is ENOENT', async () => {
    const cdp = makeFakeCdp({
      'Target.createTarget': () => ({ targetId: 't1' }),
      'Target.attachToTarget': () => ({ sessionId: 's1' }),
      'Runtime.evaluate': readyAfter(0, { name: 'tab-1', podId: 'pod-1' }),
    })
    const driver = createCdpDriver({ cdp, podUrl: 'https://x/pod.html', contextPerPod: false, spawnTimeoutMs: 1000 })
    await driver.spawn(browserSpec())
    assert.equal((await driver.status('tab-1')).state, POD_LIFECYCLE.REGISTERED)
    await assert.rejects(driver.status('ghost'), (err) => err.code === POD_HOST_ERROR.ENOENT)
  })

  it('send() evaluates window.__browsermeshHosted.send(payload) on the session', async () => {
    /** @type {object[]} */
    const evaluated = []
    const cdp = makeFakeCdp({
      'Target.createTarget': () => ({ targetId: 't1' }),
      'Target.attachToTarget': () => ({ sessionId: 's1' }),
      'Runtime.evaluate': (params, sessionId) => {
        evaluated.push({ params, sessionId })
        if (params.expression.includes('__browsermeshHosted.ready')) return { result: { value: { ready: true, podId: 'p1', name: 'tab-1' } } }
        return {}
      },
    })
    const driver = createCdpDriver({ cdp, podUrl: 'https://x/pod.html', contextPerPod: false, spawnTimeoutMs: 1000 })
    await driver.spawn(browserSpec())
    const result = await driver.send('tab-1', { payload: { hi: true } })
    assert.equal(result.delivered, true)
    const sendCall = evaluated.find((e) => e.params.expression.includes('.send('))
    assert.ok(sendCall)
    assert.match(sendCall.params.expression, /\{"hi":true\}/)
    assert.equal(sendCall.sessionId, 's1')
  })

  it('exec() evaluates the expression and returns stdout/code 0', async () => {
    const cdp = makeFakeCdp({
      'Target.createTarget': () => ({ targetId: 't1' }),
      'Target.attachToTarget': () => ({ sessionId: 's1' }),
      'Runtime.evaluate': (params) => {
        if (params.expression.includes('__browsermeshHosted.ready')) return { result: { value: { ready: true, podId: 'p1', name: 'tab-1' } } }
        if (params.expression === '1+1') return { result: { value: 2 } }
        return { result: { value: null } }
      },
    })
    const driver = createCdpDriver({ cdp, podUrl: 'https://x/pod.html', contextPerPod: false, spawnTimeoutMs: 1000 })
    await driver.spawn(browserSpec())
    const result = await driver.exec('tab-1', ['1+1'])
    assert.deepEqual(result, { stdout: '2', stderr: '', code: 0 })
  })

  it('exec() surfaces a thrown exception as stderr/code 1', async () => {
    const cdp = makeFakeCdp({
      'Target.createTarget': () => ({ targetId: 't1' }),
      'Target.attachToTarget': () => ({ sessionId: 's1' }),
      'Runtime.evaluate': (params) => {
        if (params.expression.includes('__browsermeshHosted.ready')) return { result: { value: { ready: true, podId: 'p1', name: 'tab-1' } } }
        return { exceptionDetails: { text: 'Uncaught ReferenceError: nope is not defined' } }
      },
    })
    const driver = createCdpDriver({ cdp, podUrl: 'https://x/pod.html', contextPerPod: false, spawnTimeoutMs: 1000 })
    await driver.spawn(browserSpec())
    const result = await driver.exec('tab-1', ['nope'])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /ReferenceError/)
  })

  it('snapshot() and restore() are ENOTSUP, not ELANE (the lane allows exec but these stay unimplemented)', async () => {
    const cdp = makeFakeCdp({
      'Target.createTarget': () => ({ targetId: 't1' }),
      'Target.attachToTarget': () => ({ sessionId: 's1' }),
      'Runtime.evaluate': readyAfter(0, { name: 'tab-1', podId: 'p1' }),
    })
    const driver = createCdpDriver({ cdp, podUrl: 'https://x/pod.html', contextPerPod: false, spawnTimeoutMs: 1000 })
    await driver.spawn(browserSpec())
    await assert.rejects(driver.snapshot('tab-1'), (err) => err.code === POD_HOST_ERROR.ENOTSUP)
    await assert.rejects(driver.restore('tab-1'), (err) => err.code === POD_HOST_ERROR.ENOTSUP)
  })

  it('drain() closes the target and disposes the browser context, -> gone', async () => {
    const closedTargets = []
    const disposedContexts = []
    const cdp = makeFakeCdp({
      'Target.createBrowserContext': () => ({ browserContextId: 'ctx-1' }),
      'Target.createTarget': () => ({ targetId: 't1' }),
      'Target.attachToTarget': () => ({ sessionId: 's1' }),
      'Runtime.evaluate': readyAfter(0, { name: 'tab-1', podId: 'p1' }),
      'Target.closeTarget': (params) => { closedTargets.push(params.targetId); return {} },
      'Target.disposeBrowserContext': (params) => { disposedContexts.push(params.browserContextId); return {} },
    })
    const driver = createCdpDriver({ cdp, podUrl: 'https://x/pod.html', spawnTimeoutMs: 1000 })
    await driver.spawn(browserSpec())
    const drained = await driver.drain('tab-1')
    assert.equal(drained.state, POD_LIFECYCLE.GONE)
    assert.deepEqual(closedTargets, ['t1'])
    assert.deepEqual(disposedContexts, ['ctx-1'])

    const status = await driver.status('tab-1')
    assert.equal(status.state, POD_LIFECYCLE.GONE)

    // Idempotent re-drain.
    const again = await driver.drain('tab-1')
    assert.equal(again.state, POD_LIFECYCLE.GONE)
  })

  it('EEXIST on duplicate spawn, ELANE on wrong lane, EINVAL on bad spec', async () => {
    const cdp = makeFakeCdp({
      'Target.createTarget': () => ({ targetId: 't1' }),
      'Target.attachToTarget': () => ({ sessionId: 's1' }),
      'Runtime.evaluate': readyAfter(0, { name: 'tab-1', podId: 'p1' }),
    })
    const driver = createCdpDriver({ cdp, podUrl: 'https://x/pod.html', contextPerPod: false, spawnTimeoutMs: 1000 })
    await driver.spawn(browserSpec())
    await assert.rejects(driver.spawn(browserSpec()), (err) => err.code === POD_HOST_ERROR.EEXIST)
    await assert.rejects(driver.spawn(browserSpec({ name: 'other', lane: POD_LANE.NODE })), (err) => err.code === POD_HOST_ERROR.ELANE)
    await assert.rejects(driver.spawn({ name: 'bad name' }), (err) => err.code === POD_HOST_ERROR.EINVAL)
  })

  it('spawn() times out with ETIMEDOUT if the page never reports ready', async () => {
    const cdp = makeFakeCdp({
      'Target.createTarget': () => ({ targetId: 't1' }),
      'Target.attachToTarget': () => ({ sessionId: 's1' }),
      'Runtime.evaluate': () => ({ result: { value: { ready: false } } }),
    })
    const driver = createCdpDriver({ cdp, podUrl: 'https://x/pod.html', contextPerPod: false, spawnTimeoutMs: 60 })
    await assert.rejects(driver.spawn(browserSpec()), (err) => err.code === POD_HOST_ERROR.ETIMEDOUT)
    // The tombstone exists and reports gone, same as a successful drain would.
    assert.equal((await driver.status('tab-1')).state, POD_LIFECYCLE.GONE)
  })

  it('list() reports every spawned pod, tombstones included', async () => {
    let lastSpawnName
    const cdp = makeFakeCdp({
      'Target.createTarget': () => ({ targetId: 't1' }),
      'Target.attachToTarget': () => ({ sessionId: 's1' }),
      'Runtime.evaluate': () => ({ result: { value: { ready: true, podId: 'p1', name: lastSpawnName } } }),
    })
    const driver = createCdpDriver({ cdp, podUrl: 'https://x/pod.html', contextPerPod: false, spawnTimeoutMs: 1000 })
    lastSpawnName = 'a'
    await driver.spawn(browserSpec({ name: 'a' }))
    lastSpawnName = 'b'
    await driver.spawn(browserSpec({ name: 'b' }))
    await driver.drain('a')

    const list = await driver.list()
    assert.deepEqual(list.map((p) => p.name).sort(), ['a', 'b'])
    assert.equal(list.find((p) => p.name === 'a').state, POD_LIFECYCLE.GONE)
    assert.equal(list.find((p) => p.name === 'b').state, POD_LIFECYCLE.REGISTERED)
  })

  it('onEvent() emits lifecycle and exit events', async () => {
    const cdp = makeFakeCdp({
      'Target.createTarget': () => ({ targetId: 't1' }),
      'Target.attachToTarget': () => ({ sessionId: 's1' }),
      'Runtime.evaluate': readyAfter(0, { name: 'tab-1', podId: 'p1' }),
    })
    const driver = createCdpDriver({ cdp, podUrl: 'https://x/pod.html', contextPerPod: false, spawnTimeoutMs: 1000 })
    /** @type {object[]} */
    const seen = []
    driver.onEvent((e) => seen.push(e))
    await driver.spawn(browserSpec())
    await driver.drain('tab-1')
    assert.ok(seen.some((e) => e.kind === 'lifecycle' && e.data.to === POD_LIFECYCLE.REGISTERED))
    assert.ok(seen.some((e) => e.kind === 'exit'))
  })
})
