import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from 'browsermesh-primitives'
import {
  installPodRuntime,
  createRuntime,
  createClient,
  createServer,
} from '../src/runtime.mjs'

// Stub BroadcastChannel for Node
class StubBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null }
  postMessage() {}
  close() {}
}

function makeGlobal(overrides = {}) {
  return {
    window: undefined,
    document: undefined,
    BroadcastChannel: StubBroadcastChannel,
    addEventListener: () => {},
    removeEventListener: () => {},
    ...overrides,
  }
}

describe('installPodRuntime', () => {
  let pod

  afterEach(async () => {
    if (pod && pod.state !== 'shutdown' && pod.state !== 'idle') {
      await pod.shutdown({ silent: true })
    }
  })

  it('creates and boots a pod', async () => {
    const g = makeGlobal()
    pod = await installPodRuntime({ context: g, discoveryTimeout: 50, handshakeTimeout: 50 })
    assert.equal(pod.state, 'ready')
    assert.ok(pod.podId)
  })

  it('accepts a pre-existing identity', async () => {
    const identity = await PodIdentity.generate()
    const g = makeGlobal()
    pod = await installPodRuntime({ context: g, identity, discoveryTimeout: 50, handshakeTimeout: 50 })
    assert.equal(pod.podId, identity.podId)
  })
})

describe('createRuntime', () => {
  it('is an alias for installPodRuntime', () => {
    assert.equal(createRuntime, installPodRuntime)
  })
})

describe('createClient', () => {
  let pod

  afterEach(async () => {
    if (pod && pod.state !== 'shutdown' && pod.state !== 'idle') {
      await pod.shutdown({ silent: true })
    }
  })

  it('creates a lightweight client pod', async () => {
    const g = makeGlobal()
    pod = await createClient({ context: g, discoveryTimeout: 50 })
    assert.equal(pod.state, 'ready')
    assert.ok(pod.podId)
  })
})

describe('createServer', () => {
  let pod

  afterEach(async () => {
    if (pod && pod.state !== 'shutdown' && pod.state !== 'idle') {
      await pod.shutdown({ silent: true })
    }
  })

  it('creates a server-oriented pod', async () => {
    const g = makeGlobal()
    pod = await createServer({ context: g, discoveryTimeout: 50, handshakeTimeout: 50 })
    assert.equal(pod.state, 'ready')
    assert.ok(pod.podId)
  })
})
