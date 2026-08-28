import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Pod } from '../src/pod.mjs'
import { POD_HELLO, POD_HELLO_ACK, POD_GOODBYE } from '../src/messages.mjs'

// Simulated BroadcastChannel that connects all instances on the same name
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
        // Simulate async delivery
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

function makeGlobal(overrides = {}) {
  const g = {
    BroadcastChannel: SimBroadcastChannel,
    addEventListener: () => {},
    removeEventListener: () => {},
    ...overrides,
  }
  return g
}

describe('Pod peer discovery', () => {
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

  it('two pods discover each other via BroadcastChannel', async () => {
    const pod1 = new Pod()
    const pod2 = new Pod()
    pods.push(pod1, pod2)

    const g1 = makeGlobal()
    const g2 = makeGlobal()

    // Boot pod1 first, then pod2 — pod2's hello should reach pod1
    await pod1.boot({ globalThis: g1, discoveryTimeout: 100, handshakeTimeout: 50 })
    await pod2.boot({ globalThis: g2, discoveryTimeout: 100, handshakeTimeout: 50 })

    // Allow async message delivery
    await new Promise(r => setTimeout(r, 150))

    // Both should see each other as peers
    const peers1 = pod1.peers
    const peers2 = pod2.peers

    assert.equal(peers1.has(pod2.podId), true, 'pod1 should know about pod2')
    assert.equal(peers2.has(pod1.podId), true, 'pod2 should know about pod1')
  })

  it('emits peer:found events', async () => {
    const pod1 = new Pod()
    const pod2 = new Pod()
    pods.push(pod1, pod2)

    const found = []
    pod1.on('peer:found', (data) => found.push(data.podId))

    const g1 = makeGlobal()
    const g2 = makeGlobal()

    await pod1.boot({ globalThis: g1, discoveryTimeout: 100, handshakeTimeout: 50 })
    await pod2.boot({ globalThis: g2, discoveryTimeout: 100, handshakeTimeout: 50 })

    await new Promise(r => setTimeout(r, 150))

    assert.ok(found.includes(pod2.podId), 'pod1 should emit peer:found for pod2')
  })

  it('handles peer goodbye', async () => {
    const pod1 = new Pod()
    const pod2 = new Pod()
    pods.push(pod1, pod2)

    const g1 = makeGlobal()
    const g2 = makeGlobal()

    await pod1.boot({ globalThis: g1, discoveryTimeout: 100, handshakeTimeout: 50 })
    await pod2.boot({ globalThis: g2, discoveryTimeout: 100, handshakeTimeout: 50 })
    await new Promise(r => setTimeout(r, 150))

    const lost = []
    pod1.on('peer:lost', (data) => lost.push(data.podId))

    await pod2.shutdown()
    await new Promise(r => setTimeout(r, 50))

    assert.ok(lost.includes(pod2.podId), 'pod1 should see pod2 leave')
  })

  it('role is "peer" when other pods exist', async () => {
    const pod1 = new Pod()
    const pod2 = new Pod()
    pods.push(pod1, pod2)

    const g1 = makeGlobal()
    const g2 = makeGlobal()

    await pod1.boot({ globalThis: g1, discoveryTimeout: 100, handshakeTimeout: 50 })

    // pod2 boots and finds pod1 during discovery → role=peer
    await pod2.boot({ globalThis: g2, discoveryTimeout: 100, handshakeTimeout: 50 })

    assert.equal(pod2.role, 'peer')
  })

  it('role is "autonomous" when no peers found', async () => {
    const pod1 = new Pod()
    pods.push(pod1)

    const g = makeGlobal()
    await pod1.boot({ globalThis: g, discoveryTimeout: 50, handshakeTimeout: 50 })

    assert.equal(pod1.role, 'autonomous')
  })

  it('three pods all discover each other', async () => {
    const pod1 = new Pod()
    const pod2 = new Pod()
    const pod3 = new Pod()
    pods.push(pod1, pod2, pod3)

    const g1 = makeGlobal()
    const g2 = makeGlobal()
    const g3 = makeGlobal()

    await pod1.boot({ globalThis: g1, discoveryTimeout: 100, handshakeTimeout: 50 })
    await pod2.boot({ globalThis: g2, discoveryTimeout: 100, handshakeTimeout: 50 })
    await pod3.boot({ globalThis: g3, discoveryTimeout: 100, handshakeTimeout: 50 })

    await new Promise(r => setTimeout(r, 200))

    // Each pod should know the other two
    assert.equal(pod1.peers.size, 2)
    assert.equal(pod2.peers.size, 2)
    assert.equal(pod3.peers.size, 2)
  })
})
