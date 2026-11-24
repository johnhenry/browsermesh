import { test as base, expect } from '@playwright/test'
import { startServer, Hub } from './server.mjs'

export { expect }

/**
 * Fixtures:
 *   servers   two origins (two ports) sharing one relay/signalling hub
 *   open      open(origin, {isolated}) -> a page on the harness, with the strict
 *             policy watched: any CSP violation, uncaught page error or
 *             console error fails the test at the end.
 *
 * `isolated: true` gives the page its own browser context (own storage, own
 * BroadcastChannel namespace): a different "browser" as far as the page can
 * tell. The default shares one context, which BroadcastChannel needs.
 */
export const test = base.extend({
  servers: [async ({}, use) => {
    const hub = new Hub()
    const a = await startServer({ hub })
    const b = await startServer({ hub })
    await use({ a, b })
    await a.close()
    await b.close()
  }, { scope: 'worker' }],

  open: async ({ browser, context }, use) => {
    const problems = []
    const extra = []
    const pages = []
    const open = async (origin, { isolated = false, probe = false, query = {} } = {}) => {
      let ctx = context
      if (isolated) {
        // WebKit hides host candidates behind mDNS names (`<uuid>.local`) unless
        // media capture is active, and two pages of one browser cannot resolve
        // each other's names here (no multicast): see `exposeHostCandidates`.
        ctx = await browser.newContext(isWebKit(browser) ? { permissions: ['microphone'] } : {})
        extra.push(ctx)
      }
      const page = await ctx.newPage()
      if (!probe) { // a probe page blocks things on purpose, so it is not watched
        pages.push(page)
        page.on('pageerror', (err) => problems.push(`pageerror: ${err.message}`))
        page.on('console', (msg) => {
          if (msg.type() === 'error') problems.push(`console.error: ${msg.text()}`)
        })
      }
      const search = new URLSearchParams(query).toString()
      await page.goto(`${origin.origin}/${probe ? '?probe' : search ? `?${search}` : ''}`)
      await page.waitForFunction(() => window.bmReady === true)
      return page
    }
    await use(open)
    for (const page of pages) {
      if (page.isClosed()) continue
      const found = await page.evaluate(() => window.bm?.violations ?? []).catch(() => [])
      problems.push(...found.map((v) => `csp: ${v}`))
    }
    for (const ctx of extra) await ctx.close()
    expect(problems, 'the pages ran clean under the strict policy').toEqual([])
  },
})

const isWebKit = (browser) => browser.browserType().name() === 'webkit'

/**
 * WebKit replaces a host ICE candidate's address with a random `<uuid>.local`
 * name and resolves such names by multicast DNS, which two pages of one
 * browser cannot do here: ICE never starts (no state change at all), so a data
 * channel between two WebKit contexts never opens. Chromium and Firefox have a
 * switch for this (playwright.config.mjs); Playwright's WebKit has none, but
 * WebKit stops hiding addresses while media capture is active. The context is
 * granted the microphone and the page opens (and keeps) a capture stream
 * (Playwright's WebKit provides a mock device), which makes the candidates
 * plain loopback/LAN addresses. Nothing is captured or sent; the stream only
 * has to be live while the connection is negotiated. A no-op elsewhere.
 */
export async function exposeHostCandidates(page) {
  if (page.context().browser().browserType().name() !== 'webkit') return
  await page.evaluate(async () => {
    window.bmCapture = await navigator.mediaDevices.getUserMedia({ audio: true })
  })
}

/** Wait for a synchronous in-page predicate (never an async one: a Promise is truthy). */
export const until = (page, fn, arg) => page.waitForFunction(fn, arg)

/**
 * Two pages, each in its own browser context, connected by a real WebRTC data
 * channel through the local signalling server. Resolves when both ends report
 * the channel open.
 */
export async function connectRtc(open, origin, ids = { a: 'pod-alice', b: 'pod-bob' }) {
  const alice = await open(origin, { isolated: true })
  const bob = await open(origin, { isolated: true })
  await exposeHostCandidates(alice)
  await exposeHostCandidates(bob)
  await alice.evaluate((i) => window.bm.rtcRegister({ local: i.a, remote: i.b }), ids)
  await bob.evaluate((i) => window.bm.rtcRegister({ local: i.b, remote: i.a }), ids)
  await alice.evaluate(() => window.bm.rtcOffer())
  await until(alice, () => window.bm.rtcOpen())
  await until(bob, () => window.bm.rtcOpen())
  return { alice, bob }
}
