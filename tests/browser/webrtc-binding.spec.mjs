import { test, expect, until, exposeHostCandidates } from './fixtures.mjs'

// Identity binding on a real RTCPeerConnection, in two browser contexts, signalled through the local
// /signaling server. Each side proves possession of its pod key over the DTLS fingerprints of the
// session descriptions it applied (identity-binding.mjs).

/** Two isolated pages, each with a pod identity, registered with the signalling server. */
async function pair(open, origin, { identity, requireSignedDescription = false }) {
  const alice = await open(origin, { isolated: true })
  const bob = await open(origin, { isolated: true })
  await exposeHostCandidates(alice)
  await exposeHostCandidates(bob)
  const ids = identity
    ? { a: await alice.evaluate(() => window.bm.rtcIdentityCreate()), b: await bob.evaluate(() => window.bm.rtcIdentityCreate()) }
    : { a: 'pod-alice', b: 'pod-bob' }
  await alice.evaluate((i) => window.bm.rtcRegister({ local: i.a, remote: i.b, identity: i.identity, requireSignedDescription: i.requireSignedDescription }), { ...ids, identity, requireSignedDescription })
  await bob.evaluate((i) => window.bm.rtcRegister({ local: i.b, remote: i.a, identity: i.identity, requireSignedDescription: i.requireSignedDescription }), { ...ids, identity, requireSignedDescription })
  return { alice, bob, ids }
}

const status = (page) => page.evaluate(() => window.bm.rtcStatus())

test('identity binding succeeds on a real RTCPeerConnection', async ({ servers, open }) => {
  const { alice, bob } = await pair(open, servers.a, { identity: true })
  await alice.evaluate(() => window.bm.rtcOffer())
  await until(alice, () => window.bm.rtcOpen())
  await until(bob, () => window.bm.rtcOpen())

  // Both sides verified the other's proof over fingerprints read from real browser SDP.
  for (const page of [alice, bob]) {
    expect(await status(page)).toMatchObject({ state: 'connected', bound: true, failure: null, descriptionVerified: true, refusals: [] })
  }
  // The certificate the connection really uses was compared with the one the peer's description named
  // where the browser exposes it (Chromium does, through getStats; a browser that does not says so).
  // It is never a mismatch on an honest connection.
  const certificates = [await status(alice), await status(bob)].map((s) => s.certificate)
  for (const c of certificates) expect(['matched', 'unavailable']).toContain(c)
  if (test.info().project.name === 'chromium') expect(certificates).toEqual(['matched', 'matched'])
  // And traffic flows once bound, in both directions.
  await alice.evaluate(() => window.bm.rtcSend({ hello: 'bob' }))
  await bob.evaluate(() => window.bm.rtcSend({ hello: 'alice' }))
  await until(bob, () => window.bm.rtc.inbox.length === 1)
  await until(alice, () => window.bm.rtc.inbox.length === 1)
  expect(await bob.evaluate(() => window.bm.rtc.inbox)).toEqual([{ hello: 'bob' }])
})

test('a bound connection stays bound and usable through an ICE-restart renegotiation', async ({ servers, open }) => {
  const { alice, bob } = await pair(open, servers.a, { identity: true })
  await alice.evaluate(() => window.bm.rtcOffer())
  await until(alice, () => window.bm.rtcOpen())
  await until(bob, () => window.bm.rtcOpen())
  expect(await alice.evaluate(() => window.bm.rtc.answered)).toBe(1)

  await alice.evaluate(() => window.bm.rtcRenegotiate())
  await until(alice, () => window.bm.rtc.answered === 2)
  // The restart offer and its answer were signed and verified before they were applied, too.
  for (const page of [alice, bob]) expect(await status(page)).toMatchObject({ state: 'connected', bound: true, failure: null, descriptionVerified: true, refusals: [] })
  await bob.evaluate(() => window.bm.rtcSend({ after: 'restart' }))
  await until(alice, () => window.bm.rtc.inbox.length === 1)
  expect(await alice.evaluate(() => window.bm.rtc.inbox)).toEqual([{ after: 'restart' }])
})

test('a peer that sends no proof is closed after the binding timeout, with the reason', async ({ servers, open }) => {
  // bob runs without identity (what a transport older than 0.6.0 does); alice requires a proof, with a short timeout.
  const alice = await open(servers.a, { isolated: true })
  const bob = await open(servers.a, { isolated: true })
  await exposeHostCandidates(alice)
  await exposeHostCandidates(bob)
  const aliceId = await alice.evaluate(() => window.bm.rtcIdentityCreate())
  await alice.evaluate((i) => window.bm.rtcRegister({ local: i.a, remote: 'pod-bob', identity: true, bindingTimeoutMs: 700 }), { a: aliceId })
  await bob.evaluate((i) => window.bm.rtcRegister({ local: 'pod-bob', remote: i.a, identity: false }), { a: aliceId })
  await alice.evaluate(() => window.bm.rtcOffer())
  await until(alice, () => window.bm.rtc.conn.state === 'closed')
  expect(await status(alice)).toMatchObject({ state: 'closed', bound: false, failure: 'timeout' })
  // Nothing the unproven peer sent reached the application.
  expect(await alice.evaluate(() => window.bm.rtc.inbox)).toEqual([])
})

/**
 * A signalling server that swaps the session descriptions: the test double reroutes every
 * offer/answer/ICE frame to an attacker page, which answers alice as bob and offers to bob as alice
 * with two RTCPeerConnections of its own, relaying whatever crosses the data channel (the proofs
 * included). Without binding the connection comes up through the attacker and nobody notices.
 */
async function withAttacker({ servers, open }, identity, body, extra = {}) {
  const attacker = await open(servers.a, { isolated: true })
  await exposeHostCandidates(attacker)
  await attacker.evaluate(() => window.bm.mitmStart('__mitm__'))
  servers.a.hub.intercept = '__mitm__'
  try {
    return await body(attacker, await pair(open, servers.a, { identity, ...extra }))
  } finally {
    servers.a.hub.intercept = null
  }
}

test('control: without identity binding, descriptions swapped by the signalling server go unnoticed', async ({ servers, open }) => {
  await withAttacker({ servers, open }, false, async (attacker, { alice, bob }) => {
    await alice.evaluate(() => window.bm.rtcOffer())
    await until(alice, () => window.bm.rtcOpen())
    await until(bob, () => window.bm.rtcOpen())
    await alice.evaluate(() => window.bm.rtcSend({ secret: 'for bob only' }))
    await until(bob, () => window.bm.rtc.inbox.length === 1)
    // The attacker sat in the middle and saw it.
    expect(await attacker.evaluate(() => window.bm.mitm.seen)).toContainEqual({ secret: 'for bob only' })
  })
})

test('with identity binding, descriptions swapped by the signalling server are detected and the connection is closed', async ({ servers, open }) => {
  await withAttacker({ servers, open }, true, async (attacker, { alice, bob }) => {
    await alice.evaluate(() => window.bm.rtcOffer())
    await until(alice, () => window.bm.rtc.conn.state === 'closed')
    await until(bob, () => window.bm.rtc.conn.state === 'closed')
    const [a, b] = [await status(alice), await status(bob)]
    // Neither side ever considered the peer verified or delivered anything from it, and at least one
    // side recorded why (the proof did not verify against the descriptions it had applied).
    expect(a.bound).toBe(false)
    expect(b.bound).toBe(false)
    expect([a.failure, b.failure].filter(Boolean).length).toBeGreaterThan(0)
    for (const failure of [a.failure, b.failure].filter(Boolean)) expect(failure).toBe('bad-signature')
    expect(await alice.evaluate(() => window.bm.rtc.inbox)).toEqual([])
    expect(await bob.evaluate(() => window.bm.rtc.inbox)).toEqual([])
  })
})

test('with signed descriptions required, descriptions swapped by the signalling server are refused before they are applied', async ({ servers, open }) => {
  await withAttacker({ servers, open }, true, async (attacker, { alice, bob }) => {
    // Both sides require a signature; the attacker's descriptions have none.
    await alice.evaluate(() => window.bm.rtcOffer())
    await until(alice, () => window.bm.rtc.refusals.length > 0)
    const a = await status(alice)
    expect(a.refusals[0]).toMatch(/answer .*unsigned/)
    expect(a).toMatchObject({ bound: false, descriptionFailure: 'unsigned' })
    expect(await alice.evaluate(() => window.bm.rtc.inbox)).toEqual([])
    expect(await bob.evaluate(() => window.bm.rtc.inbox)).toEqual([])
  }, { requireSignedDescription: true })
})
