import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Pod } from '../src/pod.mjs'
import { PodIdentity } from 'browsermesh-primitives'

// Stub BroadcastChannel for Node
class StubBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null }
  postMessage() {}
  close() {}
}

function makeGlobal(overrides = {}) {
  const listeners = []
  const g = {
    window: undefined,
    document: undefined,
    BroadcastChannel: StubBroadcastChannel,
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: (type, fn) => {
      const idx = listeners.findIndex(l => l.fn === fn)
      if (idx !== -1) listeners.splice(idx, 1)
    },
    ...overrides,
  }
  g._listeners = listeners
  return g
}

describe('Pod', () => {
  let pod

  afterEach(async () => {
    if (pod && pod.state !== 'shutdown' && pod.state !== 'idle') {
      await pod.shutdown({ silent: true })
    }
  })

  it('starts in idle state', () => {
    pod = new Pod()
    assert.equal(pod.state, 'idle')
    assert.equal(pod.podId, null)
    assert.equal(pod.kind, null)
    assert.equal(pod.role, 'autonomous')
  })

  it('boots successfully with default options', async () => {
    pod = new Pod()
    const g = makeGlobal()
    await pod.boot({ globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })

    assert.equal(pod.state, 'ready')
    assert.ok(pod.podId)
    assert.equal(pod.kind, 'server') // no window/document → server
    assert.equal(pod.role, 'autonomous') // no peers → autonomous
    assert.ok(pod.capabilities)
  })

  it('boots with a pre-existing identity', async () => {
    const identity = await PodIdentity.generate()
    pod = new Pod()
    const g = makeGlobal()
    await pod.boot({ identity, globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })

    assert.equal(pod.podId, identity.podId)
    assert.equal(pod.state, 'ready')
  })

  it('refuses to boot twice', async () => {
    pod = new Pod()
    const g = makeGlobal()
    await pod.boot({ globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })

    await assert.rejects(
      () => pod.boot({ globalThis: g }),
      { message: /already in state/ }
    )
  })

  it('emits phase events during boot', async () => {
    pod = new Pod()
    const phases = []
    pod.on('phase', (data) => phases.push(data.phase))

    const g = makeGlobal()
    await pod.boot({ globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })

    assert.deepEqual(phases, [0, 1, 2, 3, 4, 5])
  })

  it('emits ready event', async () => {
    pod = new Pod()
    let readyData = null
    pod.on('ready', (data) => { readyData = data })

    const g = makeGlobal()
    await pod.boot({ globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })

    assert.ok(readyData)
    assert.equal(readyData.podId, pod.podId)
    assert.equal(readyData.kind, 'server')
  })

  it('installs runtime on globalThis', async () => {
    pod = new Pod()
    const g = makeGlobal()
    await pod.boot({ globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })

    const runtime = g[Symbol.for('pod.runtime')]
    assert.ok(runtime)
    assert.equal(runtime.podId, pod.podId)
    assert.equal(runtime.pod, pod)
  })

  it('cleans up runtime on shutdown', async () => {
    pod = new Pod()
    const g = makeGlobal()
    await pod.boot({ globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })
    await pod.shutdown()

    assert.equal(pod.state, 'shutdown')
    assert.equal(g[Symbol.for('pod.runtime')], undefined)
  })

  it('emits shutdown event', async () => {
    pod = new Pod()
    const g = makeGlobal()
    await pod.boot({ globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })

    let shutdownData = null
    pod.on('shutdown', (data) => { shutdownData = data })
    await pod.shutdown()

    assert.ok(shutdownData)
    assert.equal(shutdownData.podId, pod.podId)
  })

  it('shutdown is idempotent', async () => {
    pod = new Pod()
    const g = makeGlobal()
    await pod.boot({ globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })
    await pod.shutdown()
    await pod.shutdown() // no-op
    assert.equal(pod.state, 'shutdown')
  })

  it('toJSON returns serializable snapshot', async () => {
    pod = new Pod()
    const g = makeGlobal()
    await pod.boot({ globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })

    const json = pod.toJSON()
    assert.equal(json.podId, pod.podId)
    assert.equal(json.kind, 'server')
    assert.equal(json.role, 'autonomous')
    assert.equal(json.state, 'ready')
    assert.equal(json.peerCount, 0)
    assert.deepEqual(json.peers, [])
  })

  it('on/off adds and removes listeners', async () => {
    pod = new Pod()
    const calls = []
    const fn = (d) => calls.push(d)
    pod.on('ready', fn)
    pod.off('ready', fn)

    const g = makeGlobal()
    await pod.boot({ globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })
    assert.equal(calls.length, 0)
  })

  it('send throws when not ready', () => {
    pod = new Pod()
    assert.throws(() => pod.send('target', 'hello'), { message: /not ready/ })
  })

  it('detects kind=window for browser-like global', async () => {
    pod = new Pod()
    const g = makeGlobal()
    g.window = { parent: null, opener: null }
    g.window.parent = g.window
    g.document = {}
    await pod.boot({ globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })
    assert.equal(pod.kind, 'window')
  })

  it('calls _onReady hook on subclass', async () => {
    let readyCalled = false
    class TestPod extends Pod {
      _onReady() { readyCalled = true }
    }
    pod = new TestPod()
    const g = makeGlobal()
    await pod.boot({ globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })
    assert.equal(readyCalled, true)
  })

  it('calls _onInstallListeners hook on subclass', async () => {
    let installG = null
    class TestPod extends Pod {
      _onInstallListeners(g) { installG = g }
    }
    pod = new TestPod()
    const g = makeGlobal()
    await pod.boot({ globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })
    assert.equal(installG, g)
  })
})
