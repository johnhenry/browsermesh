/**
 * Tests for browser-host-driver.mjs / browser-host-child.mjs -- the
 * in-page `PodHostDriver` for the browser lane (issue #185 item 7,
 * deliverable A).
 *
 * There is no real browser here (that is `spikes/browser-pod-host`'s
 * job) -- this suite builds a fake `document`/`open`/`Worker` harness that
 * actually BOOTS a `Pod` (via `bootHostedPod()`) in a fake child global
 * every time the driver "navigates" an iframe, opens a window, or
 * constructs a worker, all sharing one fake `BroadcastChannel` bus with
 * the driver. That is enough to exercise the real state machine, the real
 * `browser-host:ready` handshake, and real `postMessage` delivery for all
 * three spawn kinds, synchronously (no real timers beyond a few
 * milliseconds).
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { createInPageDriver, DEFAULT_DISCOVERY_CHANNEL } from '../src/browser-host-driver.mjs'
import { bootHostedPod, readPodName } from '../src/browser-host-child.mjs'
import { POD_HOST_ERROR, POD_LANE, POD_LIFECYCLE } from '../src/host-protocol.mjs'
import { POD_MESSAGE } from '../src/messages.mjs'

// ---------------------------------------------------------------------------
// Fake BroadcastChannel bus (same pattern as transport.test.mjs's
// StubBroadcastChannel, generalized to a shared factory so every fake
// global in a test gets an instance wired to the same bus).
// ---------------------------------------------------------------------------

function makeBus() {
  /** @type {Map<string, Set<object>>} */
  const channels = new Map()
  class StubBroadcastChannel {
    constructor(name) {
      this.name = name
      this.onmessage = null
      this._closed = false
      if (!channels.has(name)) channels.set(name, new Set())
      channels.get(name).add(this)
    }
    postMessage(data) {
      if (this._closed) return
      const peers = channels.get(this.name)
      if (!peers) return
      for (const ch of peers) {
        if (ch !== this && !ch._closed && ch.onmessage) {
          const copy = JSON.parse(JSON.stringify(data))
          Promise.resolve().then(() => { if (ch.onmessage) ch.onmessage({ data: copy }) })
        }
      }
    }
    close() {
      this._closed = true
      channels.get(this.name)?.delete(this)
    }
  }
  return StubBroadcastChannel
}

// ---------------------------------------------------------------------------
// Fake child global -- boots a real Pod via bootHostedPod() the moment the
// test harness "navigates" to it, simulating what a real iframe/window/
// worker would do by running the pod page's own script.
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {Function} opts.BC - fake BroadcastChannel constructor
 * @param {string} opts.name - the window/worker `name`
 * @param {string} opts.href - full URL this "page" was loaded with
 * @param {'iframe'|'spawned'|'worker'} opts.frameKind
 * @returns {object} a fake globalThis for the child
 */
function makeChildGlobal({ BC, name, href, frameKind }) {
  /** @type {{type: string, fn: Function}[]} */
  const listeners = []
  const g = {
    name,
    location: { href, hash: href.includes('#') ? href.slice(href.indexOf('#')) : '' },
    BroadcastChannel: BC,
    addEventListener(type, fn) { listeners.push({ type, fn }) },
    removeEventListener(type, fn) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn)
      if (i !== -1) listeners.splice(i, 1)
    },
    postMessage(data) {
      // Deliver to self, matching what a real window's "receive end" does
      // when something else calls `childWindow.postMessage(...)`.
      for (const { type, fn } of [...listeners]) if (type === 'message') fn({ data })
    },
  }
  if (frameKind === 'worker') {
    class FakeWorkerGlobalScope {}
    Object.setPrototypeOf(g, FakeWorkerGlobalScope.prototype)
    g.WorkerGlobalScope = FakeWorkerGlobalScope
  } else {
    g.document = { title: '', body: { appendChild() {} }, querySelector: () => null }
    g.window = g
    g.parent = frameKind === 'iframe' ? { postMessage() {} } : g // top-level for 'spawned'
    if (frameKind === 'spawned') g.opener = { postMessage() {} }
  }
  return g
}

/** Fast timeouts so bootHostedPod's discovery/handshake waits don't slow the suite. */
const FAST_BOOT = { handshakeTimeout: 5, discoveryTimeout: 5 }

// ---------------------------------------------------------------------------
// Fake document/open/Worker -- the browser primitives the driver itself
// calls. Each one "navigates" by booting a child Pod against a fresh fake
// global sharing the same BroadcastChannel bus, and records enough state
// for the tests to assert on (removed? closed? terminated?).
// ---------------------------------------------------------------------------

function makeHostHarness(BC) {
  /** @type {object[]} */
  const createdIframes = []
  /** @type {object[]} */
  const openedWindows = []
  /** @type {object[]} */
  const createdWorkers = []
  /** @type {Promise<*>[]} */
  const pendingBoots = []

  function fakeIframe() {
    const el = {
      name: '',
      _src: '',
      removed: false,
      contentWindow: null,
      get src() { return this._src },
      set src(url) {
        this._src = url
        const childGlobal = makeChildGlobal({ BC, name: el.name, href: url, frameKind: 'iframe' })
        el.contentWindow = childGlobal
        pendingBoots.push(bootHostedPod({ globalThis: childGlobal, ...FAST_BOOT }))
      },
      remove() { el.removed = true },
    }
    createdIframes.push(el)
    return el
  }

  const document = {
    body: { appendChild() {} },
    createElement(tag) {
      assert.equal(tag, 'iframe')
      return fakeIframe()
    },
  }

  function open(url, name) {
    const childGlobal = makeChildGlobal({ BC, name, href: url, frameKind: 'spawned' })
    const closed = { value: false }
    const win = {
      name,
      get closed() { return closed.value },
      close() { closed.value = true },
      postMessage(data) { childGlobal.postMessage(data) },
    }
    openedWindows.push({ win, childGlobal, closed })
    pendingBoots.push(bootHostedPod({ globalThis: childGlobal, ...FAST_BOOT }))
    return win
  }

  class FakeWorker {
    constructor(url, opts = {}) {
      this.url = url
      this.name = opts.name || ''
      this.terminated = false
      // `childGlobal.postMessage` is the generic "dispatch to MY OWN
      // addEventListener('message', ...) listeners" from makeChildGlobal --
      // exactly what a real `worker.postMessage(data)` call from the main
      // thread does (triggers 'message' on the worker's global scope). This
      // driver never needs the opposite direction (self.postMessage() out
      // to the main thread): nothing in `pod.mjs` calls it.
      const childGlobal = makeChildGlobal({ BC, name: this.name, href: url, frameKind: 'worker' })
      this._childGlobal = childGlobal
      createdWorkers.push(this)
      pendingBoots.push(bootHostedPod({ globalThis: childGlobal, ...FAST_BOOT }))
    }
    postMessage(data) { this._childGlobal.postMessage(data) }
    terminate() { this.terminated = true }
  }

  return {
    globalThis: { document, open, Worker: FakeWorker, BroadcastChannel: BC },
    createdIframes,
    openedWindows,
    createdWorkers,
    /** Wait for every child boot kicked off so far to settle. */
    async flush() {
      await Promise.all(pendingBoots.splice(0))
      // One more microtask turn for the ready broadcast to reach the driver.
      await new Promise((resolve) => setTimeout(resolve, 10))
    },
  }
}

function minimalBrowserSpec(overrides = {}) {
  return { name: 'alpha', lane: POD_LANE.BROWSER, run: { kind: 'module', ref: 'pod-page' }, ...overrides }
}

// ---------------------------------------------------------------------------
// browser-host-child.mjs
// ---------------------------------------------------------------------------

describe('readPodName', () => {
  it('prefers g.name over the URL hash', () => {
    assert.equal(readPodName({ name: 'from-name', location: { href: 'https://x/#name=from-hash' } }), 'from-name')
  })

  it('falls back to parsing #name= from the URL', () => {
    assert.equal(readPodName({ name: '', location: { href: 'https://x/page#name=hashed%20value' } }), 'hashed value')
  })

  it('returns null when neither is present', () => {
    assert.equal(readPodName({ name: '', location: { href: 'https://x/page' } }), null)
    assert.equal(readPodName({}), null)
  })
})

// ---------------------------------------------------------------------------
// createInPageDriver -- full lifecycle, one spawn kind at a time
// ---------------------------------------------------------------------------

for (const spawnKind of ['iframe', 'window', 'worker']) {
  describe(`createInPageDriver: spawnKind '${spawnKind}'`, () => {
    /** @type {any} */ let BC
    /** @type {any} */ let harness
    /** @type {any} */ let driver

    function setup() {
      BC = makeBus()
      harness = makeHostHarness(BC)
      driver = createInPageDriver({
        globalThis: harness.globalThis,
        podUrl: 'https://pods.example/child.html',
        spawnKind,
        timeoutMs: 1000,
        BCConstructor: BC,
      })
      return { BC, harness, driver }
    }

    afterEach(() => {
      if (driver) driver.close()
    })

    it('reports lane and the served verb set (exec/snapshot/restore absent)', () => {
      ;({ driver } = setup())
      assert.equal(driver.lane, POD_LANE.BROWSER)
      assert.deepEqual(driver.capabilities().verbs, ['spawn', 'status', 'send', 'drain', 'list'])
    })

    it('spawns, reaches registered with a podId, and the right kind', async () => {
      ;({ harness, driver } = setup())
      const spawnPromise = driver.spawn(minimalBrowserSpec())
      await harness.flush()
      const status = await spawnPromise
      assert.equal(status.name, 'alpha')
      assert.equal(status.lane, POD_LANE.BROWSER)
      assert.equal(status.state, POD_LIFECYCLE.REGISTERED)
      assert.equal(status.kind, spawnKind)
      assert.ok(status.podId, 'podId should be set from the child\'s hello')
    })

    it('status() reflects the same record after spawn', async () => {
      ;({ harness, driver } = setup())
      const spawnPromise = driver.spawn(minimalBrowserSpec())
      await harness.flush()
      await spawnPromise
      const status = await driver.status('alpha')
      assert.equal(status.state, POD_LIFECYCLE.REGISTERED)
    })

    it('status() on an unknown name is ENOENT', async () => {
      ;({ driver } = setup())
      await assert.rejects(driver.status('ghost'), (err) => err.code === POD_HOST_ERROR.ENOENT)
    })

    it('send() delivers a postMessage the child Pod receives', async () => {
      ;({ harness, driver } = setup())
      const spawnPromise = driver.spawn(minimalBrowserSpec())
      await harness.flush()
      const status = await spawnPromise

      /** @type {object|null} */
      let received = null
      // Hook the booted child Pod's message event directly through its
      // transport-independent `on('message', ...)` API.
      const childGlobal = spawnKind === 'iframe'
        ? harness.createdIframes[0].contentWindow
        : spawnKind === 'window'
          ? harness.openedWindows[0].childGlobal
          : harness.createdWorkers[0]._childGlobal
      const runtime = childGlobal[Symbol.for('pod.runtime')]
      assert.ok(runtime, 'child global should have a booted pod runtime installed')
      runtime.pod.on('message', (msg) => { received = msg })

      const result = await driver.send('alpha', { payload: { hello: 'world' } })
      assert.equal(result.delivered, true)
      await new Promise((resolve) => setTimeout(resolve, 5))
      assert.ok(received, 'child pod should have received the message')
      assert.equal(received.type, POD_MESSAGE)
      assert.deepEqual(received.payload, { hello: 'world' })
      assert.equal(status.podId, runtime.pod.podId)
    })

    it('send() on an unknown name is ENOENT', async () => {
      ;({ driver } = setup())
      await assert.rejects(driver.send('ghost', { payload: 1 }), (err) => err.code === POD_HOST_ERROR.ENOENT)
    })

    it('exec()/snapshot()/restore() are all ENOTSUP, never ELANE', async () => {
      ;({ harness, driver } = setup())
      const spawnPromise = driver.spawn(minimalBrowserSpec())
      await harness.flush()
      await spawnPromise

      for (const verb of ['exec', 'snapshot', 'restore']) {
        await assert.rejects(driver[verb]('alpha'), (err) => {
          assert.equal(err.code, POD_HOST_ERROR.ENOTSUP, `${verb} should be ENOTSUP, not ELANE`)
          return true
        })
      }
    })

    it('drain() tears down the child and transitions to gone', async () => {
      ;({ harness, driver } = setup())
      const spawnPromise = driver.spawn(minimalBrowserSpec())
      await harness.flush()
      await spawnPromise

      const drained = await driver.drain('alpha')
      assert.equal(drained.state, POD_LIFECYCLE.GONE)

      if (spawnKind === 'iframe') assert.equal(harness.createdIframes[0].removed, true)
      if (spawnKind === 'window') assert.equal(harness.openedWindows[0].closed.value, true)
      if (spawnKind === 'worker') assert.equal(harness.createdWorkers[0].terminated, true)

      // status() still answers post-drain, as a tombstone.
      const status = await driver.status('alpha')
      assert.equal(status.state, POD_LIFECYCLE.GONE)

      // Draining again is idempotent, not an error.
      const again = await driver.drain('alpha')
      assert.equal(again.state, POD_LIFECYCLE.GONE)
    })

    it('spawning the same name again after drain succeeds (tombstone reuse)', async () => {
      ;({ harness, driver } = setup())
      await harness.flush()
      let spawnPromise = driver.spawn(minimalBrowserSpec())
      await harness.flush()
      await spawnPromise
      await driver.drain('alpha')

      spawnPromise = driver.spawn(minimalBrowserSpec())
      await harness.flush()
      const status = await spawnPromise
      assert.equal(status.state, POD_LIFECYCLE.REGISTERED)
    })

    it('rejects spawning a duplicate live name with EEXIST', async () => {
      ;({ harness, driver } = setup())
      const spawnPromise = driver.spawn(minimalBrowserSpec())
      await harness.flush()
      await spawnPromise
      await assert.rejects(driver.spawn(minimalBrowserSpec()), (err) => err.code === POD_HOST_ERROR.EEXIST)
    })

    it('rejects a podspec naming a different lane with ELANE', async () => {
      ;({ driver } = setup())
      await assert.rejects(
        driver.spawn(minimalBrowserSpec({ lane: POD_LANE.NODE })),
        (err) => err.code === POD_HOST_ERROR.ELANE,
      )
    })

    it('rejects an invalid podspec with EINVAL', async () => {
      ;({ driver } = setup())
      await assert.rejects(driver.spawn({ name: 'bad name' }), (err) => err.code === POD_HOST_ERROR.EINVAL)
    })

    it('list() reports every spawned pod, tombstones included', async () => {
      ;({ harness, driver } = setup())
      let spawnPromise = driver.spawn(minimalBrowserSpec({ name: 'a' }))
      await harness.flush()
      await spawnPromise
      spawnPromise = driver.spawn(minimalBrowserSpec({ name: 'b' }))
      await harness.flush()
      await spawnPromise
      await driver.drain('a')

      const list = await driver.list()
      assert.deepEqual(list.map((p) => p.name).sort(), ['a', 'b'])
      assert.equal(list.find((p) => p.name === 'a').state, POD_LIFECYCLE.GONE)
      assert.equal(list.find((p) => p.name === 'b').state, POD_LIFECYCLE.REGISTERED)
    })

    it('spawn() times out with ETIMEDOUT if the child never announces ready', async () => {
      BC = makeBus()
      harness = makeHostHarness(BC)
      // A driver listening on a DIFFERENT channel than the child boots on:
      // the ready broadcast never reaches it.
      driver = createInPageDriver({
        globalThis: harness.globalThis,
        podUrl: 'https://pods.example/child.html',
        spawnKind,
        channel: 'driver-channel',
        timeoutMs: 20,
        BCConstructor: BC,
      })
      await assert.rejects(driver.spawn(minimalBrowserSpec()), (err) => err.code === POD_HOST_ERROR.ETIMEDOUT)
    })
  })
}

// ---------------------------------------------------------------------------
// Construction errors and default channel
// ---------------------------------------------------------------------------

describe('createInPageDriver: construction', () => {
  it('requires podUrl', () => {
    assert.throws(() => createInPageDriver({ BCConstructor: makeBus() }), /podUrl is required/)
  })

  it('rejects an unknown spawnKind', () => {
    assert.throws(
      () => createInPageDriver({ podUrl: 'https://x', spawnKind: 'popup', BCConstructor: makeBus() }),
      /spawnKind must be one of/,
    )
  })

  it('requires a BroadcastChannel constructor when none is on globalThis', () => {
    assert.throws(
      () => createInPageDriver({ podUrl: 'https://x', globalThis: {} }),
      /no BroadcastChannel available/,
    )
  })

  it('defaults channel to DEFAULT_DISCOVERY_CHANNEL, matching Pod\'s own default', () => {
    assert.equal(DEFAULT_DISCOVERY_CHANNEL, 'pod-discovery')
  })
})

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

describe('createInPageDriver: onEvent', () => {
  it('emits lifecycle transitions and an exit event on drain', async () => {
    const BC = makeBus()
    const harness = makeHostHarness(BC)
    const driver = createInPageDriver({
      globalThis: harness.globalThis,
      podUrl: 'https://pods.example/child.html',
      BCConstructor: BC,
      timeoutMs: 1000,
    })
    /** @type {object[]} */
    const seen = []
    driver.onEvent((event) => seen.push(event))

    const spawnPromise = driver.spawn(minimalBrowserSpec())
    await harness.flush()
    await spawnPromise
    await driver.drain('alpha')
    driver.close()

    const kinds = seen.map((e) => e.data.from ? `${e.data.from}->${e.data.to}` : e.kind)
    assert.ok(seen.some((e) => e.kind === 'lifecycle' && e.data.to === POD_LIFECYCLE.BOOTING))
    assert.ok(seen.some((e) => e.kind === 'lifecycle' && e.data.to === POD_LIFECYCLE.REGISTERED))
    assert.ok(seen.some((e) => e.kind === 'lifecycle' && e.data.to === POD_LIFECYCLE.GONE))
    assert.ok(seen.some((e) => e.kind === 'exit'))
    assert.ok(kinds.length > 0)
  })
})
