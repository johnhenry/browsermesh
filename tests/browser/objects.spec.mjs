import { test, expect, until, connectRtc } from './fixtures.mjs'

// wsh's remote-object layer over a protocol channel (@johnhenry/browsermesh-objects)
// riding the real WebRTC data channel between two browsers: real SDP, ICE, DTLS
// and SCTP, signalled through the local /signaling server.
//
// Bob hosts one root, `app`, through his own PeerRegistry (default deny); alice
// opens it. The peer the host judges is the one the data channel is bound to
// ('pod-alice' here), never a field of a message. The page runs wsh's
// transport-neutral object core (the harness serves it from node_modules).

const OPEN = 'protocol:objects:open'
const UNAUTHORIZED = -32003

async function serveAndConnect(open, servers, limits = {}, layer = {}) {
  const { alice, bob } = await connectRtc(open, servers.a)
  await bob.evaluate(([l, y]) => window.bm.objServe(l, y), [limits, layer])
  await alice.evaluate((l) => window.bm.objClient(l), limits)
  return { alice, bob }
}
const grant = (bob, scopes) => bob.evaluate((s) => window.bm.objGrant('pod-alice', s), scopes)
const revoke = (bob, scopes) => bob.evaluate((s) => window.bm.objRevoke('pod-alice', s), scopes)
const run = (alice, op, ...args) => alice.evaluate(([o, a]) => window.bm.objDo(o, ...a), [op, args])

test('objects over real WebRTC: default deny, then each operation needs its own action, bytes cross in chunks', async ({ servers, open }) => {
  const { alice, bob } = await serveAndConnect(open, servers)

  // Default deny: nothing was granted, so the protocol cannot even be opened.
  expect((await alice.evaluate(() => window.bm.objOpen())).error.code).toBe(UNAUTHORIZED)

  await grant(bob, [OPEN, 'objects:app:get', 'objects:app:call'])
  expect(await alice.evaluate(() => window.bm.objOpen())).toEqual({ ok: true, peer: 'pod-bob', rootNames: ['app'] })

  expect(await run(alice, 'title')).toEqual({ value: 'inbox' })
  expect(await run(alice, 'inc', 4)).toEqual({ value: 7 })
  expect(await run(alice, 'snapshot')).toEqual({ value: { value: 7 } })

  // 200 KB result: more than one data-channel message, intact by digest.
  const big = await run(alice, 'bytes')
  expect(big.value.bytes).toBe(200_000)
  expect(big.value.digest).toBe(await alice.evaluate(() => window.bm.objExpectedDigest(200_000)))

  // Granted get and call, not set and not on: each is its own action.
  expect((await run(alice, 'set', 99)).error.code).toBe(UNAUTHORIZED)
  expect((await run(alice, 'subscribe')).error.code).toBe(UNAUTHORIZED)
  expect((await bob.evaluate(() => window.bm.objHostState())).listeners).toBe(0)
  // A path the allow-list does not name is refused whatever the grant.
  expect((await run(alice, 'secret')).error.reason).toBe('not-allowed')
})

test('objects over real WebRTC: events, a one-way callback and a handle; revoking the subscription ends the session at once', async ({ servers, open }) => {
  const { alice, bob } = await serveAndConnect(open, servers)
  await grant(bob, [OPEN, 'objects:app:get', 'objects:app:call', 'objects:app:on'])
  expect((await alice.evaluate(() => window.bm.objOpen())).ok).toBe(true)

  // Events: delivered in order, none dropped at this rate.
  expect(await run(alice, 'subscribe')).toEqual({ value: true })
  await bob.evaluate(() => window.bm.objEmit(3))
  await until(alice, () => window.bm.objClientState().events === 3)
  expect(await alice.evaluate(() => window.bm.objClientState().last)).toBe(3)
  expect(await alice.evaluate(() => window.bm.objClientState().dropped)).toBe(0)

  // A callback: the host's call returns at once with nothing, and the far side runs it.
  expect(await run(alice, 'callback')).toEqual({ value: true })
  expect(await bob.evaluate(() => window.bm.objFire('hi', 2))).toEqual(['undefined'])
  await until(alice, () => window.bm.objClientState().got.length === 1)
  expect(await alice.evaluate(() => window.bm.objClientState().got)).toEqual([['hi', 2]])

  // A handle, judged by the path that produced it.
  expect(await run(alice, 'handle')).toEqual({ value: { type: 'RemoteHandle', length: 3, added: 4 } })

  // Revocation: the host ends the session without waiting for anything from alice, and detaches its listener.
  await revoke(bob, ['objects:app:on'])
  await until(bob, () => window.bm.objHostState().sessions === 0)
  expect((await bob.evaluate(() => window.bm.objHostState())).listeners).toBe(0)
  await until(alice, () => window.bm.objClientState().closed === 1)
  expect((await run(alice, 'title')).error).toBeTruthy()
})

test('objects over real WebRTC: a handle never widens a path (get may read through it, not call), and revoking get refuses the next request', async ({ servers, open }) => {
  const { alice, bob } = await serveAndConnect(open, servers)
  await grant(bob, [OPEN, 'objects:app:get'])
  expect((await alice.evaluate(() => window.bm.objOpen())).ok).toBe(true)
  expect(await run(alice, 'title')).toEqual({ value: 'inbox' })
  expect((await run(alice, 'handleCall')).error.code).toBe(UNAUTHORIZED)

  await revoke(bob, ['objects:app:get'])
  expect((await run(alice, 'title')).error.code).toBe(UNAUTHORIZED)
  expect((await bob.evaluate(() => window.bm.objHostState())).sessions).toBe(1)
})

test('objects over real WebRTC: a reader that stops reading makes the host drop events, and every drop is counted', async ({ servers, open }) => {
  // A small link so the window is easy to exceed: 64 KiB unconsumed per peer, 16 KiB messages.
  const limits = { window: 64 * 1024, maxMessageBytes: 16 * 1024, chunkBytes: 4096 }
  const layer = { maxQueuedEvents: 5, maxEventsPerSecond: 100_000, maxEventBytes: 12_000 }
  const { alice, bob } = await serveAndConnect(open, servers, limits, layer)
  await grant(bob, [OPEN, 'objects:app:on'])
  expect((await alice.evaluate(() => window.bm.objOpen())).ok).toBe(true)
  expect(await run(alice, 'subscribe')).toEqual({ value: true })

  await alice.evaluate(() => window.bm.objHold())
  await bob.evaluate(() => window.bm.objEmit(80, 9000)) // about 720 KB offered against a 64 KiB window
  // The layer waits for the channel: one write is outstanding at most, the rest wait in its bounded queue.
  expect((await bob.evaluate(() => window.bm.objHostState())).stats.pendingSends).toBeLessThanOrEqual(1)
  await alice.evaluate(() => window.bm.objRelease())

  // Keep offering one small event until one gets through: it says how many were lost before it.
  for (;;) {
    await bob.evaluate(() => window.bm.objEmit(1))
    const state = await alice.evaluate(() => window.bm.objClientState())
    if (state.last > 80) {
      expect(state.dropped).toBeGreaterThan(0)
      expect(state.received).toBeLessThan(state.last)
      expect(state.received + state.dropped).toBe(state.last)
      break
    }
    await until(alice, () => window.bm.objClientState().events > 0)
  }
})
