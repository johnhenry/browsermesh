import { test, expect } from './fixtures.mjs'

// An application that uses the transport and not wsh: the page's import map has NO `@johnhenry/wsh*` entry at all
// (`?import-map=no-wsh`), and the main entry of @johnhenry/browsermesh-transport still imports, builds a
// TransportFactory and a negotiator, and never asks for a wsh module. The wsh features sit behind `/wsh`.

test('the transport main entry imports in a page whose import map has no wsh at all', async ({ servers, open }) => {
  const page = await open(servers.a, { query: { 'import-map': 'no-wsh' } })
  const requested = []
  page.on('request', (r) => requested.push(new URL(r.url()).pathname))

  const keys = await page.evaluate(() => Object.keys(JSON.parse(document.querySelector('script[type=importmap]').textContent).imports))
  expect(keys.filter((k) => k.startsWith('@johnhenry/wsh')), 'the page has no wsh in its import map').toEqual([])
  expect(keys).toContain('@johnhenry/browsermesh-transport')

  const result = await page.evaluate(async () => {
    const t = await import('@johnhenry/browsermesh-transport')
    const factory = new t.TransportFactory()
    return {
      factory: typeof factory.create === 'function',
      hasNegotiator: typeof t.MeshTransportNegotiator === 'function',
      hasBridge: typeof t.MeshWshBridge === 'function',
      wshNamesOnMain: ['WshPeerLinks', 'WshServices', 'WshRelay', 'WshPodTransport', 'WshLink', 'createWshTransportFactory'].filter((n) => n in t),
    }
  })
  expect(result.factory).toBe(true)
  expect(result.hasNegotiator).toBe(true)
  expect(result.hasBridge).toBe(true)
  expect(result.wshNamesOnMain, 'the browser-safe main entry carries no wsh feature').toEqual([])

  const wshFetched = requested.filter((p) => /wsh-(links|services|relay|pod-transport|in-process)\.mjs$|\/vendor\/wsh\//.test(p))
  expect(wshFetched, 'no wsh module was requested').toEqual([])
})

test('the /wsh subpath loads with no wsh in the import map (wsh itself is fetched only when a link is used)', async ({ servers, open }) => {
  const page = await open(servers.a, { query: { 'import-map': 'no-wsh' } })
  const names = await page.evaluate(async () => {
    const w = await import('@johnhenry/browsermesh-transport/wsh')
    return ['WshPeerLinks', 'WshServices', 'WshRelay', 'WshPodTransport'].filter((n) => typeof w[n] === 'function')
  })
  expect(names).toEqual(['WshPeerLinks', 'WshServices', 'WshRelay', 'WshPodTransport'])
})
