import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectPodKind } from '../src/detect-kind.mjs'

describe('detectPodKind', () => {
  it('returns "window" for a standard top-level window', () => {
    const g = {
      window: {},
      document: {},
    }
    g.window.parent = g.window // top-level: parent === self
    g.window.opener = null
    assert.equal(detectPodKind(g), 'window')
  })

  it('returns "iframe" when window !== window.parent', () => {
    const parent = {}
    const g = {
      window: { parent, opener: null },
      document: {},
    }
    assert.equal(detectPodKind(g), 'iframe')
  })

  it('returns "iframe" when parent access throws (cross-origin)', () => {
    const g = {
      window: {
        get parent() { throw new DOMException('cross-origin') },
        opener: null,
      },
      document: {},
    }
    assert.equal(detectPodKind(g), 'iframe')
  })

  it('returns "spawned" when window.opener is set', () => {
    const g = {
      window: { opener: {}, },
      document: {},
    }
    g.window.parent = g.window
    assert.equal(detectPodKind(g), 'spawned')
  })

  it('returns "server" when no window or document', () => {
    assert.equal(detectPodKind({}), 'server')
    assert.equal(detectPodKind({ window: undefined, document: undefined }), 'server')
  })

  it('returns "service-worker" for ServiceWorkerGlobalScope', () => {
    class ServiceWorkerGlobalScope {}
    const g = Object.create(ServiceWorkerGlobalScope.prototype)
    g.ServiceWorkerGlobalScope = ServiceWorkerGlobalScope
    assert.equal(detectPodKind(g), 'service-worker')
  })

  it('returns "shared-worker" for SharedWorkerGlobalScope', () => {
    class SharedWorkerGlobalScope {}
    const g = Object.create(SharedWorkerGlobalScope.prototype)
    g.SharedWorkerGlobalScope = SharedWorkerGlobalScope
    assert.equal(detectPodKind(g), 'shared-worker')
  })

  it('returns "worker" for generic WorkerGlobalScope', () => {
    class WorkerGlobalScope {}
    const g = Object.create(WorkerGlobalScope.prototype)
    g.WorkerGlobalScope = WorkerGlobalScope
    assert.equal(detectPodKind(g), 'worker')
  })

  it('returns "worklet" for AudioWorkletGlobalScope', () => {
    class AudioWorkletGlobalScope {}
    const g = Object.create(AudioWorkletGlobalScope.prototype)
    g.AudioWorkletGlobalScope = AudioWorkletGlobalScope
    assert.equal(detectPodKind(g), 'worklet')
  })

  it('prioritizes service-worker over generic worker', () => {
    // SW extends Worker — both should be present, SW should win
    class WorkerGlobalScope {}
    class ServiceWorkerGlobalScope extends WorkerGlobalScope {}
    const g = Object.create(ServiceWorkerGlobalScope.prototype)
    g.WorkerGlobalScope = WorkerGlobalScope
    g.ServiceWorkerGlobalScope = ServiceWorkerGlobalScope
    assert.equal(detectPodKind(g), 'service-worker')
  })
})
