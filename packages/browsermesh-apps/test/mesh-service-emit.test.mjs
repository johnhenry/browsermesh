/**
 * Unit-level tests for `mesh-service.mjs`'s `ctx.emit()`/`attachService()`
 * handle `on()`/`onEvent()` observability convention (Phase 1 of the
 * mesh-KV-and-observability plan -- see `mesh-service.mjs`'s own module doc
 * comment's "Observability events" section for the full design).
 *
 * These tests cover the generic mechanism only (a bare descriptor calling
 * `ctx.emit()` directly, no real service). See grant-log.test.mjs /
 * manifest-sync.test.mjs / chunk-replication.test.mjs for tests proving the
 * documented per-service event vocabulary actually fires at the right
 * moments on real services.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-service-emit.test.mjs
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { attachService, createEventBus } from '../src/mesh-service.mjs'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

/** A minimal duck-typed peerNode -- ctx.emit() doesn't touch onIncomingData/sendTo/registry at all, so this can be bare-bones. */
function createBareNode(podId = 'local-pod') {
  return {
    podId,
    registry: {},
    onIncomingData() { return () => {} },
    async sendTo() {},
  }
}

describe('mesh-service: ctx.emit() / attachService() handle.on()/.onEvent()', () => {
  it('ctx.emit() reaches a subscriber registered via handle.on(event, cb)', async () => {
    let capturedCtx
    const descriptor = {
      name: 'emitter',
      attach(peerNode, ctx) {
        capturedCtx = ctx
        return () => {}
      },
    }
    const handle = attachService(createBareNode(), undefined, descriptor)

    const received = []
    const unsubscribe = handle.on('widget:built', (data) => received.push(data))

    capturedCtx.emit('widget:built', { id: 1 })
    assert.deepEqual(received, [{ id: 1 }])

    // A different event name never reaches this subscriber.
    capturedCtx.emit('widget:destroyed', { id: 1 })
    assert.equal(received.length, 1)

    unsubscribe()
    capturedCtx.emit('widget:built', { id: 2 })
    assert.equal(received.length, 1, 'unsubscribe() stops further delivery to this callback')

    await handle.teardown()
  })

  it('multiple subscribers on the same event all receive it', async () => {
    let capturedCtx
    const descriptor = {
      name: 'emitter',
      attach(peerNode, ctx) {
        capturedCtx = ctx
        return () => {}
      },
    }
    const handle = attachService(createBareNode(), undefined, descriptor)

    const a = []
    const b = []
    const c = []
    handle.on('ping', (data) => a.push(data))
    handle.on('ping', (data) => b.push(data))
    handle.onEvent((event, data) => c.push({ event, data }))

    capturedCtx.emit('ping', { n: 1 })

    assert.deepEqual(a, [{ n: 1 }])
    assert.deepEqual(b, [{ n: 1 }])
    assert.deepEqual(c, [{ event: 'ping', data: { n: 1 } }])

    await handle.teardown()
  })

  it('a throwing subscriber does not crash the service and does not prevent OTHER subscribers from receiving the event', async () => {
    let capturedCtx
    const descriptor = {
      name: 'emitter',
      attach(peerNode, ctx) {
        capturedCtx = ctx
        return () => {}
      },
    }
    const handle = attachService(createBareNode(), undefined, descriptor)

    const good = []
    handle.on('event-x', () => { throw new Error('boom (first, throwing subscriber)') })
    handle.on('event-x', (data) => good.push(data))
    handle.onEvent(() => { throw new Error('boom (wildcard, throwing subscriber)') })

    // Must not throw synchronously out of emit() itself.
    assert.doesNotThrow(() => capturedCtx.emit('event-x', { ok: true }))
    assert.deepEqual(good, [{ ok: true }], 'the non-throwing subscriber still received the event')

    // The service/ctx itself is still usable afterward.
    const more = []
    handle.on('event-x', (data) => more.push(data))
    capturedCtx.emit('event-x', { ok: 2 })
    assert.deepEqual(more, [{ ok: 2 }])

    await handle.teardown()
  })

  it('teardown() stops further event delivery', async () => {
    let capturedCtx
    const descriptor = {
      name: 'emitter',
      attach(peerNode, ctx) {
        capturedCtx = ctx
        return () => {}
      },
    }
    const handle = attachService(createBareNode(), undefined, descriptor)

    const received = []
    handle.on('event-y', (data) => received.push(data))
    handle.onEvent((event, data) => received.push({ event, data }))

    capturedCtx.emit('event-y', { before: true })
    assert.equal(received.length, 2)

    await handle.teardown()

    // Even if the (already torn-down) service's own code still calls
    // ctx.emit() after teardown, it must be a silent no-op -- no delivery,
    // no throw.
    assert.doesNotThrow(() => capturedCtx.emit('event-y', { after: true }))
    assert.equal(received.length, 2, 'no further delivery to previously-registered subscribers after teardown()')
  })

  it('ctx.emit() ignores non-string/empty event names rather than throwing', async () => {
    let capturedCtx
    const descriptor = {
      name: 'emitter',
      attach(peerNode, ctx) {
        capturedCtx = ctx
        return () => {}
      },
    }
    const handle = attachService(createBareNode(), undefined, descriptor)

    assert.doesNotThrow(() => capturedCtx.emit('', { x: 1 }))
    assert.doesNotThrow(() => capturedCtx.emit(undefined, { x: 1 }))
    assert.doesNotThrow(() => capturedCtx.emit(123, { x: 1 }))

    await handle.teardown()
  })
})

describe('mesh-service: createEventBus() (standalone, reused by non-MeshService classes)', () => {
  it('emit()/on()/onEvent()/closeAll() work the same way standalone as via attachService()', () => {
    const bus = createEventBus()
    const specific = []
    const wildcard = []
    bus.on('a', (data) => specific.push(data))
    bus.onEvent((event, data) => wildcard.push({ event, data }))

    bus.emit('a', { v: 1 })
    bus.emit('b', { v: 2 })

    assert.deepEqual(specific, [{ v: 1 }])
    assert.deepEqual(wildcard, [{ event: 'a', data: { v: 1 } }, { event: 'b', data: { v: 2 } }])

    bus.closeAll()
    bus.emit('a', { v: 3 })
    assert.equal(specific.length, 1, 'closeAll() stops further delivery')
  })
})
