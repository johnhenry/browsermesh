/**
 * Tests for driver.mjs -- `createExtensionDriver()` against a fake
 * `chrome` object (`tabs`/`scripting`/`storage`/`runtime`), covering every
 * verb. The real extension cannot be loaded in CI (see README.md); this is
 * the full behavioral coverage for the driver logic itself.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createExtensionDriver } from '../src/driver.mjs'
import { POD_HOST_ERROR, POD_LANE, POD_LIFECYCLE } from '../../../packages/browsermesh-pod/src/index.mjs'

/**
 * A fake `chrome` object good enough to drive `driver.mjs` end to end:
 * `tabs.create` assigns an id and parses `name=` from the URL; `sendMessage`
 * answers `browser-host:status` pings (ready after `readyDelay` polls, with
 * a podId that CHANGES every `tabs.reload()` -- modeling that a discarded
 * tab really does reboot, which is exactly the thing `snapshot`/`restore`'s
 * semantics need to be tested honestly) and relays `browser-host:message`
 * payloads into `sentMessages`.
 *
 * @param {object} [opts]
 * @param {number} [opts.readyDelay=0] - How many status polls answer `{ready: false}` before `{ready: true}`.
 */
function makeFakeChrome({ readyDelay = 0 } = {}) {
  let nextTabId = 1
  /** @type {Map<number, object>} */
  const tabs = new Map()
  /** @type {Map<number, number>} */
  const pollCounts = new Map()
  /** @type {{tabId: number, payload: *}[]} */
  const sentMessages = []
  /** @type {Map<string, *>} */
  const storage = new Map()
  /** @type {{target: object, args: *[]}[]} */
  const scriptingCalls = []

  function nameFromUrl(url) {
    const match = /name=([^&]+)/.exec(url)
    return match ? decodeURIComponent(match[1]) : null
  }

  const chrome = {
    tabs: {
      async create({ url, active }) {
        const id = nextTabId++
        tabs.set(id, { id, url, active, discarded: false, name: nameFromUrl(url), rebootCount: 0 })
        pollCounts.set(id, 0)
        return { id, url, active }
      },
      async sendMessage(tabId, message) {
        const tab = tabs.get(tabId)
        if (!tab) throw new Error('Could not establish connection. Receiving end does not exist.')
        if (message.type === 'browser-host:status') {
          const n = (pollCounts.get(tabId) || 0) + 1
          pollCounts.set(tabId, n)
          if (n <= readyDelay) return { ready: false }
          return { ready: true, podId: `pod-${tabId}-${tab.rebootCount}`, name: tab.name }
        }
        if (message.type === 'browser-host:message') {
          sentMessages.push({ tabId, payload: message.payload })
          return { delivered: true }
        }
        return {}
      },
      async discard(tabId) {
        const tab = tabs.get(tabId)
        if (tab) tab.discarded = true
      },
      async reload(tabId) {
        const tab = tabs.get(tabId)
        if (!tab) return
        tab.discarded = false
        tab.rebootCount += 1
        pollCounts.set(tabId, 0)
      },
      async remove(tabId) {
        tabs.delete(tabId)
        pollCounts.delete(tabId)
      },
    },
    scripting: {
      calls: scriptingCalls,
      async executeScript({ target, func, args }) {
        scriptingCalls.push({ target, args })
        const result = func(...(args || []))
        return [{ result }]
      },
    },
    storage: {
      session: {
        async get(key) { return { [key]: storage.get(key) } },
        async set(obj) { for (const [k, v] of Object.entries(obj)) storage.set(k, v) },
      },
    },
    runtime: {
      onMessage: { addListener() {} },
    },
  }

  return { chrome, tabs, sentMessages, storage, scriptingCalls }
}

function browserSpec(overrides = {}) {
  return { name: 'tab-1', lane: POD_LANE.BROWSER, run: { kind: 'module', ref: 'pod-page' }, ...overrides }
}

describe('createExtensionDriver: construction', () => {
  it('requires chrome.tabs, chrome.scripting, and podUrl', () => {
    assert.throws(() => createExtensionDriver({ podUrl: 'https://x' }), /chrome\.tabs is required/)
    assert.throws(() => createExtensionDriver({ chrome: { tabs: { create() {} } } }), /chrome\.scripting is required/)
    const { chrome } = makeFakeChrome()
    assert.throws(() => createExtensionDriver({ chrome }), /podUrl is required/)
  })
})

describe('createExtensionDriver: lifecycle', () => {
  it('spawns a tab, polls status, and reaches registered with a podId', async () => {
    const { chrome, tabs } = makeFakeChrome({ readyDelay: 2 })
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    assert.equal(driver.lane, POD_LANE.BROWSER)
    assert.deepEqual(driver.capabilities().verbs, ['spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list'])

    const status = await driver.spawn(browserSpec())
    assert.equal(status.name, 'tab-1')
    assert.equal(status.state, POD_LIFECYCLE.REGISTERED)
    assert.equal(status.podId, 'pod-1-0')
    const tab = tabs.get(status.tabId)
    assert.equal(tab.active, false)
    assert.match(tab.url, /^https:\/\/pods\.example\/pod\.html#name=tab-1$/)
  })

  it("injects a MAIN-world bootstrap when run.input.mode is 'inject'", async () => {
    const { chrome, scriptingCalls } = makeFakeChrome({ readyDelay: 0 })
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    await driver.spawn(browserSpec({ run: { kind: 'module', ref: 'pod-page', input: { mode: 'inject' } } }))
    assert.equal(scriptingCalls.length, 1)
  })

  it('status() re-pings and updates podId', async () => {
    const { chrome } = makeFakeChrome({ readyDelay: 0 })
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    await driver.spawn(browserSpec())
    const status = await driver.status('tab-1')
    assert.equal(status.state, POD_LIFECYCLE.REGISTERED)
    assert.equal(status.podId, 'pod-1-0')
  })

  it('status() on an unknown name is ENOENT', async () => {
    const { chrome } = makeFakeChrome()
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    await assert.rejects(driver.status('ghost'), (err) => err.code === POD_HOST_ERROR.ENOENT)
  })

  it('send() relays the payload via chrome.tabs.sendMessage', async () => {
    const { chrome, sentMessages } = makeFakeChrome({ readyDelay: 0 })
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    await driver.spawn(browserSpec())
    const result = await driver.send('tab-1', { payload: { hi: true } })
    assert.equal(result.delivered, true)
    assert.deepEqual(sentMessages, [{ tabId: 1, payload: { hi: true } }])
  })

  it('send() on an unknown/gone pod is ENOENT', async () => {
    const { chrome } = makeFakeChrome()
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    await assert.rejects(driver.send('ghost', { payload: 1 }), (err) => err.code === POD_HOST_ERROR.ENOENT)
  })

  it('exec() evaluates the expression in the isolated world and returns stdout/code 0', async () => {
    const { chrome, scriptingCalls } = makeFakeChrome({ readyDelay: 0 })
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    await driver.spawn(browserSpec())
    const result = await driver.exec('tab-1', ['1 + 1'])
    assert.deepEqual(result, { stdout: '2', stderr: '', code: 0 })
    const execCall = scriptingCalls.find((c) => c.args?.[0] === '1 + 1')
    assert.ok(execCall)
  })

  it('exec() surfaces a thrown exception as stderr/code 1', async () => {
    const { chrome } = makeFakeChrome({ readyDelay: 0 })
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    await driver.spawn(browserSpec())
    const result = await driver.exec('tab-1', ['nope.nope.nope'])
    assert.equal(result.code, 1)
    assert.ok(result.stderr.length > 0)
  })

  it('snapshot()/restore(): a real chrome.tabs.discard/reload pair, with an HONESTLY different podId after restore', async () => {
    const { chrome, tabs } = makeFakeChrome({ readyDelay: 0 })
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    const spawned = await driver.spawn(browserSpec())
    const originalPodId = spawned.podId

    const snapshotted = await driver.snapshot('tab-1')
    assert.equal(snapshotted.state, POD_LIFECYCLE.SNAPSHOTTED)
    assert.equal(tabs.get(snapshotted.tabId).discarded, true)

    const restored = await driver.restore('tab-1')
    assert.equal(restored.state, POD_LIFECYCLE.REGISTERED)
    assert.equal(tabs.get(restored.tabId).discarded, false)
    // The honest part: this is NOT the same pod that was snapshotted.
    assert.notEqual(restored.podId, originalPodId)
  })

  it('restore() before snapshot() is EBUSY', async () => {
    const { chrome } = makeFakeChrome({ readyDelay: 0 })
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    await driver.spawn(browserSpec())
    await assert.rejects(driver.restore('tab-1'), (err) => err.code === POD_HOST_ERROR.EBUSY)
  })

  it('drain() removes the tab and transitions to gone; idempotent', async () => {
    const { chrome, tabs } = makeFakeChrome({ readyDelay: 0 })
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    const spawned = await driver.spawn(browserSpec())
    const drained = await driver.drain('tab-1')
    assert.equal(drained.state, POD_LIFECYCLE.GONE)
    assert.ok(!tabs.has(spawned.tabId))

    const status = await driver.status('tab-1')
    assert.equal(status.state, POD_LIFECYCLE.GONE)

    const again = await driver.drain('tab-1')
    assert.equal(again.state, POD_LIFECYCLE.GONE)
  })

  it('EEXIST / ELANE / EINVAL on bad spawns', async () => {
    const { chrome } = makeFakeChrome({ readyDelay: 0 })
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    await driver.spawn(browserSpec())
    await assert.rejects(driver.spawn(browserSpec()), (err) => err.code === POD_HOST_ERROR.EEXIST)
    await assert.rejects(driver.spawn(browserSpec({ name: 'other', lane: POD_LANE.NODE })), (err) => err.code === POD_HOST_ERROR.ELANE)
    await assert.rejects(driver.spawn({ name: 'bad name' }), (err) => err.code === POD_HOST_ERROR.EINVAL)
  })

  it('spawn() times out with ETIMEDOUT when the content script never answers ready', async () => {
    const { chrome } = makeFakeChrome({ readyDelay: Number.MAX_SAFE_INTEGER })
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html', spawnTimeoutMs: 50 })
    await assert.rejects(driver.spawn(browserSpec()), (err) => err.code === POD_HOST_ERROR.ETIMEDOUT)
  })

  it('list() reports every spawned pod, tombstones included', async () => {
    const { chrome } = makeFakeChrome({ readyDelay: 0 })
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    await driver.spawn(browserSpec({ name: 'a' }))
    await driver.spawn(browserSpec({ name: 'b' }))
    await driver.drain('a')
    const list = await driver.list()
    assert.deepEqual(list.map((p) => p.name).sort(), ['a', 'b'])
    assert.equal(list.find((p) => p.name === 'a').state, POD_LIFECYCLE.GONE)
    assert.equal(list.find((p) => p.name === 'b').state, POD_LIFECYCLE.REGISTERED)
  })

  it('onEvent() emits lifecycle and exit events', async () => {
    const { chrome } = makeFakeChrome({ readyDelay: 0 })
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    /** @type {object[]} */
    const seen = []
    driver.onEvent((e) => seen.push(e))
    await driver.spawn(browserSpec())
    await driver.drain('tab-1')
    assert.ok(seen.some((e) => e.kind === 'lifecycle' && e.data.to === POD_LIFECYCLE.REGISTERED))
    assert.ok(seen.some((e) => e.kind === 'exit'))
  })

  it('persists the roster to chrome.storage.session and hydrate() repopulates it on a fresh driver', async () => {
    const { chrome, storage } = makeFakeChrome({ readyDelay: 0 })
    const driver = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    await driver.spawn(browserSpec())
    assert.ok(storage.size > 0, 'spawn() should have persisted the roster')

    // A fresh driver instance, modeling a service-worker restart, re-reads
    // the SAME fake chrome.storage.session (the fake Maps are module-level
    // per makeFakeChrome() call, shared by both driver instances here).
    const driver2 = createExtensionDriver({ chrome, podUrl: 'https://pods.example/pod.html' })
    await driver2.hydrate()
    const list = await driver2.list()
    assert.deepEqual(list.map((p) => p.name), ['tab-1'])
    assert.equal(list[0].state, POD_LIFECYCLE.REGISTERED)
  })
})
