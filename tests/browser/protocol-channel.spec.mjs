import { test, expect, until, connectRtc } from './fixtures.mjs'

// The message channel and the protocol seam (apps: createMeshProtocolService)
// riding the real WebRTC data channel between two browsers: real SDP, ICE, DTLS
// and SCTP, signalled through the local /signaling server. #272.
//
// Bob serves the protocol `counter`, authorised by his own PeerRegistry (default
// deny); alice opens it. The peer a handler sees is the key the session is bound
// to ('pod-alice' here, what the data channel was registered under), never a field
// of a message.

const PROTOCOL_OPEN = ['protocol:counter:open']

async function serveAndConnect(open, servers, limits) {
  const { alice, bob } = await connectRtc(open, servers.a)
  await bob.evaluate((l) => window.bm.protoServe(l), limits ?? {})
  await alice.evaluate((l) => window.bm.protoClient(l), limits ?? {})
  return { alice, bob }
}

test('protocol channel over real WebRTC: default deny, then per-protocol authorisation, requests, progress, bytes, notifications, cancel', async ({ servers, open }) => {
  const { alice, bob } = await serveAndConnect(open, servers)

  // Default deny: nothing was granted, so the protocol cannot be opened (and an unknown name looks the same).
  const denied = await alice.evaluate(() => window.bm.protoOpen('counter'))
  expect(denied.error.code).toBe(-32003)
  const unknown = await alice.evaluate(() => window.bm.protoOpen('does-not-exist'))
  expect(unknown.error.code).toBe(-32003)

  // Grant exactly the open scope for this protocol.
  await bob.evaluate((scopes) => window.bm.protoGrant('pod-alice', scopes), PROTOCOL_OPEN)
  const opened = await alice.evaluate(() => window.bm.protoOpen('counter'))
  expect(opened).toEqual({ name: 'counter', version: 1, peer: 'pod-bob' })

  // Requests with results, in order.
  expect(await alice.evaluate(() => window.bm.protoRequest('get'))).toEqual({ value: 0 })
  expect(await alice.evaluate(() => window.bm.protoRequest('inc', { n: 5 }))).toEqual({ value: 5 })
  expect(await alice.evaluate(() => window.bm.protoRequest('get'))).toEqual({ value: 5 })
  // An unknown method is an error response, not a hang.
  expect((await alice.evaluate(() => window.bm.protoRequest('nope'))).error.code).toBe(-32601)

  // The server's handler was told who asked by the session, not by anything in the message.
  expect(await alice.evaluate(() => window.bm.protoRequest('whoami'))).toEqual({ value: { peer: 'pod-alice', channelPeer: 'pod-alice' } })
  expect((await bob.evaluate(() => window.bm.protoHostState())).who).toEqual(['pod-alice'])

  // Native binary results larger than one data-channel message: chunked by the channel, intact by digest.
  const big = await alice.evaluate(() => window.bm.protoRequest('bytes', { size: 900_000 }))
  expect(big.value.bytes).toBe(900_000)
  expect(big.value.digest).toBe(await alice.evaluate(() => window.bm.protoExpectedDigest(900_000)))

  // Progress, with bytes inside it.
  expect(await alice.evaluate(() => window.bm.protoSteps(3))).toBe('done')
  expect(await alice.evaluate(() => window.bm.protoClientState().progress)).toEqual([
    { step: 1, bytes: [1, 1, 1] }, { step: 2, bytes: [2, 2, 2] }, { step: 3, bytes: [3, 3, 3] },
  ])

  // Notifications from the server, after a subscription.
  expect(await alice.evaluate(() => window.bm.protoRequest('subscribe'))).toEqual({ value: true })
  await alice.evaluate(() => window.bm.protoRequest('inc', { n: 1 }))
  await until(alice, () => window.bm.protoClientState().changes.length === 1)
  expect(await alice.evaluate(() => window.bm.protoClientState().changes)).toEqual([6])

  // Cancel: the callee's handler sees its AbortSignal fire; the caller sees a cancelled error.
  await alice.evaluate(() => window.bm.protoSlowStart())
  await alice.evaluate(() => window.bm.protoSlowAbort())
  await until(bob, () => window.bm.protoHostState().aborted === 1)
  await until(alice, () => window.bm.protoClientState().slowResult !== null)
  expect((await alice.evaluate(() => window.bm.protoClientState().slowResult)).reason).toBe('cancelled')
})

test('protocol channel over real WebRTC: revoking the protocol scope closes the channel at once; a second grant reopens it', async ({ servers, open }) => {
  const { alice, bob } = await serveAndConnect(open, servers)
  await bob.evaluate((scopes) => window.bm.protoGrant('pod-alice', scopes), PROTOCOL_OPEN)
  expect((await alice.evaluate(() => window.bm.protoOpen('counter'))).name).toBe('counter')
  expect(await alice.evaluate(() => window.bm.protoRequest('get'))).toEqual({ value: 0 })

  // Revocation: the host closes the channel without waiting for alice's next request.
  await bob.evaluate((scopes) => window.bm.protoRevoke('pod-alice', scopes), PROTOCOL_OPEN)
  await until(bob, () => window.bm.protoHostState().closed === 1)
  await until(alice, () => window.bm.protoClientState().closed === 1)
  expect((await alice.evaluate(() => window.bm.protoRequest('get'))).error).toBeTruthy()
  expect((await alice.evaluate(() => window.bm.protoOpen('counter'))).error.code).toBe(-32003)

  // Granting again lets her open a fresh channel on the same link.
  await bob.evaluate((scopes) => window.bm.protoGrant('pod-alice', scopes), PROTOCOL_OPEN)
  expect((await alice.evaluate(() => window.bm.protoOpen('counter'))).name).toBe('counter')
  expect(await alice.evaluate(() => window.bm.protoRequest('get'))).toEqual({ value: 0 })
})

test('protocol channel over real WebRTC: a reader that stops reading holds the sender at one window, and catching up delivers everything', async ({ servers, open }) => {
  // A small link so the window is easy to exceed: 64 KiB of unconsumed bytes per peer, 16 KiB messages.
  const limits = { window: 64 * 1024, maxMessageBytes: 16 * 1024, chunkBytes: 4096 }
  const { alice, bob } = await serveAndConnect(open, servers, limits)
  await bob.evaluate((scopes) => window.bm.protoGrant('pod-alice', scopes), PROTOCOL_OPEN)
  expect((await alice.evaluate(() => window.bm.protoOpen('counter'))).name).toBe('counter')

  // Bob's reader holds on to what it has until released.
  await bob.evaluate(() => window.bm.protoGateClose())
  await alice.evaluate(() => window.bm.protoFlood(60, 8 * 1024)) // 480 KiB offered against a 64 KiB window
  await until(bob, () => window.bm.protoHostState().received >= 1)
  // Alice cannot get ahead: bytes are still queued on her side, and bob holds no more than his window.
  await until(alice, () => window.bm.protoClientState().queuedBytes > 0)
  const held = await bob.evaluate(() => window.bm.protoHostState())
  expect(held.received).toBeLessThan(60)
  expect(held.heldBytes).toBeLessThanOrEqual(64 * 1024)
  expect(await alice.evaluate(() => window.bm.protoClientState().sendsDone)).toBeLessThan(60)

  // Bob catches up: every message is delivered and alice's sends all complete.
  await bob.evaluate(() => window.bm.protoGateOpen())
  await until(bob, () => window.bm.protoHostState().received === 60)
  await until(alice, () => window.bm.protoClientState().sendsDone === 60)
  expect(await alice.evaluate(() => window.bm.protoClientState().queuedBytes)).toBe(0)
})
