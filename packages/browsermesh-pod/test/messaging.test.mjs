import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { Pod } from '../src/pod.mjs'
import { POD_MESSAGE } from '../src/messages.mjs'
import {
  createHello, createHelloAck, createGoodbye, createMessage,
  createRpcRequest, createRpcResponse,
} from '../src/messages.mjs'

// Simulated BroadcastChannel
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

describe('Pod messaging', () => {
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

  it('send delivers a targeted message', async () => {
    const pod1 = new Pod()
    const pod2 = new Pod()
    pods.push(pod1, pod2)

    const received = []
    class RecvPod extends Pod {
      _onMessage(msg) { received.push(msg) }
    }
    const pod3 = new RecvPod()
    pods.push(pod3)

    const g1 = makeGlobal()
    const g2 = makeGlobal()
    const g3 = makeGlobal()

    await pod1.boot({ globalThis: g1, discoveryTimeout: 100, handshakeTimeout: 50 })
    await pod2.boot({ globalThis: g2, discoveryTimeout: 100, handshakeTimeout: 50 })
    await pod3.boot({ globalThis: g3, discoveryTimeout: 100, handshakeTimeout: 50 })
    await new Promise(r => setTimeout(r, 150))

    // Send from pod1 → pod3
    pod1.send(pod3.podId, { text: 'hello pod3' })
    await new Promise(r => setTimeout(r, 50))

    assert.equal(received.length, 1)
    assert.equal(received[0].type, POD_MESSAGE)
    assert.equal(received[0].from, pod1.podId)
    assert.equal(received[0].to, pod3.podId)
    assert.deepEqual(received[0].payload, { text: 'hello pod3' })
  })

  it('broadcast delivers to all peers', async () => {
    class RecvPod extends Pod {
      messages = []
      _onMessage(msg) { this.messages.push(msg) }
    }
    const pod1 = new Pod()
    const pod2 = new RecvPod()
    const pod3 = new RecvPod()
    pods.push(pod1, pod2, pod3)

    const g1 = makeGlobal()
    const g2 = makeGlobal()
    const g3 = makeGlobal()

    await pod1.boot({ globalThis: g1, discoveryTimeout: 100, handshakeTimeout: 50 })
    await pod2.boot({ globalThis: g2, discoveryTimeout: 100, handshakeTimeout: 50 })
    await pod3.boot({ globalThis: g3, discoveryTimeout: 100, handshakeTimeout: 50 })
    await new Promise(r => setTimeout(r, 150))

    pod1.broadcast({ text: 'hello all' })
    await new Promise(r => setTimeout(r, 50))

    assert.equal(pod2.messages.length, 1)
    assert.equal(pod3.messages.length, 1)
    assert.equal(pod2.messages[0].to, '*')
  })

  it('emits message event for incoming messages', async () => {
    const pod1 = new Pod()
    const pod2 = new Pod()
    pods.push(pod1, pod2)

    const g1 = makeGlobal()
    const g2 = makeGlobal()

    await pod1.boot({ globalThis: g1, discoveryTimeout: 100, handshakeTimeout: 50 })
    await pod2.boot({ globalThis: g2, discoveryTimeout: 100, handshakeTimeout: 50 })
    await new Promise(r => setTimeout(r, 150))

    const events = []
    pod2.on('message', (msg) => events.push(msg))

    pod1.send(pod2.podId, 'test-payload')
    await new Promise(r => setTimeout(r, 50))

    assert.equal(events.length, 1)
    assert.equal(events[0].payload, 'test-payload')
  })
})

describe('message factories', () => {
  it('createHello returns correct structure', () => {
    const msg = createHello({ podId: 'abc', kind: 'window', capabilities: { x: 1 } })
    assert.equal(msg.type, 'pod:hello')
    assert.equal(msg.podId, 'abc')
    assert.equal(msg.kind, 'window')
    assert.deepEqual(msg.capabilities, { x: 1 })
    assert.ok(msg.ts > 0)
  })

  it('createHelloAck returns correct structure', () => {
    const msg = createHelloAck({ podId: 'abc', kind: 'window', targetPodId: 'def' })
    assert.equal(msg.type, 'pod:hello-ack')
    assert.equal(msg.podId, 'abc')
    assert.equal(msg.targetPodId, 'def')
  })

  it('createGoodbye returns correct structure', () => {
    const msg = createGoodbye({ podId: 'abc' })
    assert.equal(msg.type, 'pod:goodbye')
    assert.equal(msg.podId, 'abc')
  })

  it('createMessage returns correct structure', () => {
    const msg = createMessage({ from: 'a', to: 'b', payload: 42 })
    assert.equal(msg.type, 'pod:message')
    assert.equal(msg.from, 'a')
    assert.equal(msg.to, 'b')
    assert.equal(msg.payload, 42)
  })

  it('createRpcRequest returns correct structure', () => {
    const msg = createRpcRequest({ from: 'a', to: 'b', method: 'echo', params: [1], requestId: 'r1' })
    assert.equal(msg.type, 'pod:rpc-request')
    assert.equal(msg.method, 'echo')
    assert.equal(msg.requestId, 'r1')
  })

  it('createRpcResponse returns correct structure', () => {
    const msg = createRpcResponse({ from: 'b', to: 'a', requestId: 'r1', result: 42 })
    assert.equal(msg.type, 'pod:rpc-response')
    assert.equal(msg.result, 42)
    assert.equal(msg.error, null)
  })

  it('createRpcResponse with error', () => {
    const msg = createRpcResponse({ from: 'b', to: 'a', requestId: 'r1', error: 'fail' })
    assert.equal(msg.error, 'fail')
    assert.equal(msg.result, null)
  })
})
