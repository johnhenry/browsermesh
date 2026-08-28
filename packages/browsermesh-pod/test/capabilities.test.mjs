import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectCapabilities } from '../src/capabilities.mjs'

describe('detectCapabilities', () => {
  it('returns all categories', () => {
    const caps = detectCapabilities({})
    assert.ok(caps.messaging)
    assert.ok(caps.network)
    assert.ok(caps.storage)
    assert.ok(caps.compute)
  })

  it('detects messaging capabilities', () => {
    const g = {
      postMessage: () => {},
      MessageChannel: function MC() {},
      BroadcastChannel: function BC() {},
      SharedWorker: function SW() {},
      navigator: { serviceWorker: {} },
    }
    const caps = detectCapabilities(g)
    assert.equal(caps.messaging.postMessage, true)
    assert.equal(caps.messaging.messageChannel, true)
    assert.equal(caps.messaging.broadcastChannel, true)
    assert.equal(caps.messaging.sharedWorker, true)
    assert.equal(caps.messaging.serviceWorker, true)
  })

  it('detects missing messaging capabilities', () => {
    const caps = detectCapabilities({})
    assert.equal(caps.messaging.postMessage, false)
    assert.equal(caps.messaging.messageChannel, false)
    assert.equal(caps.messaging.broadcastChannel, false)
    assert.equal(caps.messaging.sharedWorker, false)
    assert.equal(caps.messaging.serviceWorker, false)
  })

  it('detects network capabilities', () => {
    const g = {
      fetch: () => {},
      WebSocket: function WS() {},
      WebTransport: function WT() {},
      RTCPeerConnection: function RTC() {},
    }
    const caps = detectCapabilities(g)
    assert.equal(caps.network.fetch, true)
    assert.equal(caps.network.webSocket, true)
    assert.equal(caps.network.webTransport, true)
    assert.equal(caps.network.webRTC, true)
  })

  it('detects storage capabilities', () => {
    const g = {
      indexedDB: {},
      caches: {},
      navigator: { storage: { getDirectory: async () => ({}) } },
    }
    const caps = detectCapabilities(g)
    assert.equal(caps.storage.indexedDB, true)
    assert.equal(caps.storage.cacheAPI, true)
    assert.equal(caps.storage.opfs, true)
  })

  it('detects compute capabilities', () => {
    const g = {
      WebAssembly: {},
      SharedArrayBuffer: function SAB() {},
      OffscreenCanvas: function OC() {},
    }
    const caps = detectCapabilities(g)
    assert.equal(caps.compute.wasm, true)
    assert.equal(caps.compute.sharedArrayBuffer, true)
    assert.equal(caps.compute.offscreenCanvas, true)
  })

  it('handles minimal global (server/worker)', () => {
    const caps = detectCapabilities({ navigator: {} })
    assert.equal(caps.messaging.serviceWorker, false)
    assert.equal(caps.storage.opfs, false)
  })
})
