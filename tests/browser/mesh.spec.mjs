import { test, expect, until, connectRtc } from './fixtures.mjs'

// Higher layers riding the real WebRTC data channel between two browsers.

test('mesh-rpc: request/response between two browsers (browserMeshFetch over the data channel)', async ({ servers, open }) => {
  const { alice, bob } = await connectRtc(open, servers.a)
  await bob.evaluate(() => window.bm.rpcServe())
  await alice.evaluate(() => window.bm.rpcClient())

  const who = await alice.evaluate(() => window.bm.rpcFetch('/whoami'))
  expect(who).toEqual({ status: 200, contentType: 'application/json', body: { podId: 'pod-bob' } })

  const echo = await alice.evaluate(() => window.bm.rpcFetch('/echo', { method: 'POST', body: { hello: 'mesh', n: [1, 2, 3] } }))
  expect(echo.status).toBe(200)
  expect(echo.body).toEqual({ youSaid: { hello: 'mesh', n: [1, 2, 3] } })

  // A route the handler does not know resolves as a real 404 Response, not a rejection.
  const missing = await alice.evaluate(() => window.bm.rpcFetch('/nope'))
  expect(missing.status).toBe(404)

  // bob's handler saw exactly the requests alice made, in order.
  expect(await bob.evaluate(() => window.bm.rpcRequests)).toEqual([
    { method: 'GET', path: '/whoami' },
    { method: 'POST', path: '/echo' },
    { method: 'GET', path: '/nope' },
  ])
})

test('CRDT sync converges across two browsers over the data channel', async ({ servers, open }) => {
  const { alice, bob } = await connectRtc(open, servers.a)
  await alice.evaluate(() => window.bm.crdtStart('pod-alice'))
  await bob.evaluate(() => window.bm.crdtStart('pod-bob'))

  // Independent concurrent edits on both sides, before any sync.
  for (const page of [alice, bob]) {
    await page.evaluate(() => { window.bm.crdtEdit('counter'); window.bm.crdtEdit('map') })
  }
  expect(await alice.evaluate(() => window.bm.crdtState())).toEqual({ likes: 5, settings: { theme: 'dark' } })
  expect(await bob.evaluate(() => window.bm.crdtState())).toEqual({ likes: 3, settings: { locale: 'en-US' } })

  // Each side pushes its state; merges are commutative, so order does not matter.
  await alice.evaluate(() => window.bm.crdtPush())
  await bob.evaluate(() => window.bm.crdtPush())

  const converged = { likes: 8, settings: { theme: 'dark', locale: 'en-US' } }
  const isConverged = (want) => {
    const s = window.bm.crdtState()
    return s.likes === want.likes && s.settings.theme === want.settings.theme && s.settings.locale === want.settings.locale
  }
  await until(alice, isConverged, converged)
  await until(bob, isConverged, converged)
  expect(await alice.evaluate(() => window.bm.crdtState())).toEqual(converged)
  expect(await bob.evaluate(() => window.bm.crdtState())).toEqual(converged)
})
