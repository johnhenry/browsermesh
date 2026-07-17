import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Pod } from '../src/pod.mjs'
import { InjectedPod } from '../src/injected-pod.mjs'

// Simulated BroadcastChannel — mirrors test/messaging.test.mjs's fixture
const channels = new Map()

class SimBroadcastChannel {
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
        Promise.resolve().then(() => ch.onmessage({ data }))
      }
    }
  }
  close() {
    this._closed = true
    const set = channels.get(this.name)
    if (set) set.delete(this)
  }
}

function makeGlobal() {
  return {
    BroadcastChannel: SimBroadcastChannel,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
}

describe('InjectedPod', () => {
  const pods = []

  afterEach(async () => {
    for (const p of pods) {
      if (p.state !== 'shutdown' && p.state !== 'idle') {
        await p.shutdown({ silent: true })
      }
    }
    pods.length = 0
    channels.clear()
  })

  it('emit() dispatches to on() listeners (regression: _emitPublic used to be a no-op stub)', () => {
    const pod = new InjectedPod()
    pods.push(pod)

    const received = []
    pod.on('pod:message', (data) => received.push(data))

    pod.emit('pod:message', { hello: 'world' })

    assert.equal(received.length, 1)
    assert.deepEqual(received[0], { hello: 'world' })
  })

  it('_onMessage fires a pod:message event for incoming messages', async () => {
    const sender = new Pod()
    const injected = new InjectedPod()
    pods.push(sender, injected)

    const g1 = makeGlobal()
    const g2 = makeGlobal()

    await sender.boot({ globalThis: g1, discoveryTimeout: 100, handshakeTimeout: 50 })
    await injected.boot({ globalThis: g2, discoveryTimeout: 100, handshakeTimeout: 50 })
    await new Promise((r) => setTimeout(r, 150))

    const events = []
    injected.on('pod:message', (msg) => events.push(msg))

    sender.send(injected.podId, { text: 'hello injected pod' })
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(events.length, 1)
    assert.deepEqual(events[0].payload, { text: 'hello injected pod' })
  })

  it('_onMessage relays to extensionBridge.postMessage when a bridge is provided', async () => {
    const sender = new Pod()
    const relayed = []
    const bridge = { postMessage: (msg) => relayed.push(msg) }
    const injected = new InjectedPod({ extensionBridge: bridge })
    pods.push(sender, injected)

    const g1 = makeGlobal()
    const g2 = makeGlobal()

    await sender.boot({ globalThis: g1, discoveryTimeout: 100, handshakeTimeout: 50 })
    await injected.boot({ globalThis: g2, discoveryTimeout: 100, handshakeTimeout: 50 })
    await new Promise((r) => setTimeout(r, 150))

    sender.send(injected.podId, { text: 'via bridge' })
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(relayed.length, 1)
    assert.deepEqual(relayed[0].payload, { text: 'via bridge' })
  })

  it('_onMessage does not throw when no extensionBridge is provided', async () => {
    const sender = new Pod()
    const injected = new InjectedPod()
    pods.push(sender, injected)

    const g1 = makeGlobal()
    const g2 = makeGlobal()

    await sender.boot({ globalThis: g1, discoveryTimeout: 100, handshakeTimeout: 50 })
    await injected.boot({ globalThis: g2, discoveryTimeout: 100, handshakeTimeout: 50 })
    await new Promise((r) => setTimeout(r, 150))

    sender.send(injected.podId, { text: 'no bridge' })
    await new Promise((r) => setTimeout(r, 50))
    // No assertion needed beyond "did not throw" — afterEach shutdown proves the pod is still alive
  })
})
