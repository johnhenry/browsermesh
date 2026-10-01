/**
 * transport-conformance.mjs — Shared conformance suite for any Pod
 * TransportAdapter (send/onMessage/open/close/ready — see transport.mjs's
 * module doc comment for the full contract).
 *
 * Any adapter that implements TransportAdapter — the three built in here
 * (BroadcastChannelTransport, EventEmitterTransport, NullTransport) and any
 * future one — is expected to pass runTransportConformance(). To register a
 * new adapter (e.g. a WebSocketTransport landing on a sibling branch), add
 * ONE call to runTransportConformance() in transport-conformance.test.mjs.
 * No changes to this file are needed — see the comment at the top of that
 * file for exactly what the registration looks like.
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

/**
 * @typedef {object} ConformancePair
 * @property {object} a - First transport, opened and used as the sender in most tests
 * @property {object} b - Second transport, sharing the same bus/channel/socket as `a`
 * @property {object} [c] - Optional third transport sharing the same bus/channel,
 *   used only for the "handler exception doesn't break other receivers" test.
 *   Adapters that are strictly point-to-point (no fan-out to more than one
 *   peer) may omit this; that one test is skipped in that case.
 * @property {() => (void|Promise<void>)} [cleanup] - Extra teardown beyond
 *   closing `a`/`b`/`c` (e.g. clearing a fake channel registry)
 */

/**
 * Run the shared TransportAdapter conformance suite against one adapter.
 *
 * @param {string} name - Label for the describe() block
 * @param {() => object} makeTransport - Factory producing ONE fresh, unopened
 *   transport instance (used for the open/close/ready/no-op-send tests,
 *   which don't need a peer)
 * @param {object} opts
 * @param {() => ConformancePair} opts.makePair - Factory producing two (or
 *   three) transport instances that can talk to each other — e.g. sharing an
 *   EventEmitterTransport bus, or constructed with the same fake
 *   BroadcastChannel name
 * @param {boolean} [opts.delivers=true] - Set to `false` for adapters that
 *   are intentionally no-op (NullTransport): the peer-delivery assertions
 *   are replaced with "this adapter never delivers anything, and that's the
 *   documented contract" assertions instead of being skipped silently.
 *   NullTransport's `ready` getter is also hardcoded `true` and never
 *   toggles with open()/close() — a deliberate "nothing to become ready
 *   for" no-op semantics, not a bug — so `delivers: false` also swaps in a
 *   looser ready-state check matching that reality instead of asserting a
 *   false-then-true transition that NullTransport was never designed to do.
 * @param {number} [opts.deliveryWaitMs=30] - How long to wait for async
 *   delivery. Every built-in adapter here delivers via a microtask or
 *   macrotask, never synchronously inside send() — see
 *   BroadcastChannelTransport's fake-channel test helper and
 *   EventEmitterTransport's bus for why.
 */
export function runTransportConformance(name, makeTransport, opts = {}) {
  const { makePair, delivers = true, deliveryWaitMs = 30 } = opts

  if (typeof makeTransport !== 'function') {
    throw new TypeError('runTransportConformance() requires makeTransport to be a function')
  }
  if (typeof makePair !== 'function') {
    throw new TypeError(`runTransportConformance(${JSON.stringify(name)}, ...) requires opts.makePair`)
  }

  describe(`TransportAdapter conformance: ${name}`, () => {
    const cleanups = []

    afterEach(async () => {
      while (cleanups.length) {
        const fn = cleanups.pop()
        try { await fn() } catch { /* best-effort cleanup, a failing close() shouldn't fail the next test */ }
      }
    })

    function track(transport) {
      cleanups.push(() => transport.close())
      return transport
    }

    function openPair() {
      const pair = makePair()
      if (pair.cleanup) cleanups.push(pair.cleanup)
      track(pair.a)
      track(pair.b)
      if (pair.c) track(pair.c)
      return pair
    }

    function wait(ms = deliveryWaitMs) {
      return new Promise((resolve) => setTimeout(resolve, ms))
    }

    // ── ready / open / close — the stateful part of the contract ────────

    if (delivers) {
      it('ready is false before open() and true after', async () => {
        const t = track(makeTransport())
        assert.equal(t.ready, false)
        await t.open()
        assert.equal(t.ready, true)
      })

      it('close() sets ready back to false', async () => {
        const t = track(makeTransport())
        await t.open()
        assert.equal(t.ready, true)
        await t.close()
        assert.equal(t.ready, false)
      })
    } else {
      // No-op adapters (NullTransport): ready has nothing to become ready
      // FOR, so it is documented as always-truthy rather than toggling.
      it('ready is truthy both before and after open()/close() (no-op adapter)', async () => {
        const t = track(makeTransport())
        assert.ok(t.ready)
        await t.open()
        assert.ok(t.ready)
        await t.close()
        assert.ok(t.ready)
      })
    }

    it('open() is idempotent', async () => {
      const t = track(makeTransport())
      await t.open()
      await t.open()
      if (delivers) assert.equal(t.ready, true)
    })

    it('close() is idempotent', async () => {
      const t = track(makeTransport())
      await t.open()
      await t.close()
      await t.close()
      if (delivers) assert.equal(t.ready, false)
    })

    it('send() before open() is a no-op, not a throw', () => {
      const t = track(makeTransport())
      assert.doesNotThrow(() => t.send({ nope: true }))
    })

    // ── delivery — only meaningful for adapters that actually deliver ───

    if (delivers) {
      it("onMessage handler receives a peer's send(), never the sender's own", async () => {
        const { a, b } = openPair()
        const receivedByA = []
        const receivedByB = []
        a.onMessage((msg) => receivedByA.push(msg))
        b.onMessage((msg) => receivedByB.push(msg))

        await a.open()
        await b.open()

        a.send({ from: 'a' })
        await wait()

        assert.deepEqual(receivedByA, [], 'a must not receive its own send()')
        assert.equal(receivedByB.length, 1)
        assert.deepEqual(receivedByB[0], { from: 'a' })
      })

      it('a message object round-trips structurally equal', async () => {
        const { a, b } = openPair()
        const received = []
        b.onMessage((msg) => received.push(msg))

        await a.open()
        await b.open()

        const payload = {
          type: 'pod:message',
          from: 'pod-x',
          to: 'pod-y',
          payload: { nested: [1, 2, { three: 3 }], ok: true },
          ts: 1234567890,
        }
        a.send(payload)
        await wait()

        assert.equal(received.length, 1)
        assert.deepEqual(received[0], payload)
      })

      it('close() stops delivery', async () => {
        const { a, b } = openPair()
        const received = []
        b.onMessage((msg) => received.push(msg))

        await a.open()
        await b.open()
        await b.close()

        a.send({ afterClose: true })
        await wait()

        assert.deepEqual(received, [])
      })

      it("a handler exception does not break delivery to other receivers", async () => {
        const { a, b, c } = openPair()
        if (!c) return // adapter is strictly point-to-point; nothing to fan out to

        const receivedByC = []
        b.onMessage(() => { throw new Error('boom: this handler is deliberately broken') })
        c.onMessage((msg) => receivedByC.push(msg))

        await a.open()
        await b.open()
        await c.open()

        assert.doesNotThrow(() => a.send({ x: 1 }))
        await wait()

        assert.equal(receivedByC.length, 1)
        assert.deepEqual(receivedByC[0], { x: 1 })
      })
    } else {
      it('never delivers anything (declares delivers: false)', async () => {
        const { a, b } = openPair()
        const received = []
        b.onMessage((msg) => received.push(msg))

        await a.open()
        await b.open()
        a.send({ anything: true })
        await wait()

        assert.deepEqual(received, [])
      })
    }
  })
}
