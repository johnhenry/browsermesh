import { test, expect, until, connectRtc } from './fixtures.mjs'

// Two browsers, each in its own context, one real RTCPeerConnection between
// them: real SDP, ICE (host candidates over loopback, no STUN/TURN), DTLS and
// SCTP, signalled through the local /signaling server.

test('WebRTC data channel: open, messages both ways, large message, close, reconnect', async ({ servers, open }) => {
  const { alice, bob } = await connectRtc(open, servers.a)

  expect(await alice.evaluate(() => window.bm.rtc.conn.state)).toBe('connected')
  expect(await bob.evaluate(() => window.bm.rtc.conn.state)).toBe('connected')

  // Both directions.
  await alice.evaluate(() => window.bm.rtcSend({ hello: 'bob' }))
  await bob.evaluate(() => window.bm.rtcSend('plain string from bob'))
  await until(bob, () => window.bm.rtc.inbox.length === 1)
  await until(alice, () => window.bm.rtc.inbox.length === 1)
  expect(await bob.evaluate(() => window.bm.rtc.inbox)).toEqual([{ hello: 'bob' }])
  expect(await alice.evaluate(() => window.bm.rtc.inbox)).toEqual(['plain string from bob'])

  // A large message (200 KB, under the 256 KiB SCTP message limit), compared by digest.
  const big = await alice.evaluate(() => {
    const text = Array.from({ length: 200_000 }, (_, i) => String.fromCharCode(97 + (i * 7) % 26)).join('')
    window.bm.bigText = text
    window.bm.rtcSend(text)
    return window.bm.digest(text)
  })
  await until(bob, () => window.bm.rtc.inbox.length === 2)
  expect(await bob.evaluate(() => window.bm.digest(window.bm.rtc.inbox[1]))).toBe(big)
  expect(await bob.evaluate(() => window.bm.rtc.inbox[1].length)).toBe(200_000)

  // Ordered delivery of a burst on the (ordered) control channel.
  await alice.evaluate(() => { for (let i = 0; i < 50; i++) window.bm.rtcSend({ seq: i }) })
  await until(bob, () => window.bm.rtc.inbox.length === 52)
  const seqs = await bob.evaluate(() => window.bm.rtc.inbox.slice(2).map((m) => m.seq))
  expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i))

  // Close from one side: the other side sees the channel close.
  await alice.evaluate(() => window.bm.rtcClose())
  await until(alice, () => window.bm.rtc.conn.state === 'closed')
  await until(bob, () => window.bm.rtc.conn.state === 'closed')
  expect(await bob.evaluate(() => window.bm.rtcOpen())).toBe(false)

  // Reconnect: a fresh offer over the same signalling, a new connection on both ends.
  await alice.evaluate(() => window.bm.rtcOffer())
  await until(alice, () => window.bm.rtcOpen())
  await until(bob, () => window.bm.rtcOpen())
  await bob.evaluate(() => window.bm.rtcSend({ again: true }))
  await until(alice, () => window.bm.rtc.inbox.length === 2)
  expect(await alice.evaluate(() => window.bm.rtc.inbox[1])).toEqual({ again: true })
})

test('WebRTC data channel survives an ICE-restart renegotiation', async ({ servers, open }) => {
  const { alice, bob } = await connectRtc(open, servers.a)
  expect(await alice.evaluate(() => window.bm.rtc.answered)).toBe(1)

  await alice.evaluate(() => window.bm.rtcRenegotiate())
  // The renegotiation is answered on the same connection...
  await until(alice, () => window.bm.rtc.answered === 2)
  // ...and the channel is still the original, usable one.
  await alice.evaluate(() => window.bm.rtcSend({ after: 'renegotiation' }))
  await until(bob, () => window.bm.rtc.inbox.length === 1)
  expect(await bob.evaluate(() => window.bm.rtc.inbox[0])).toEqual({ after: 'renegotiation' })
  expect(await alice.evaluate(() => window.bm.rtcOpen())).toBe(true)
  expect(await bob.evaluate(() => window.bm.rtcOpen())).toBe(true)
})
