import { test, expect, until } from './fixtures.mjs'

/**
 * The window message channel, in a real browser, across two origins.
 *
 *   top page  (origin A)   a pod told to listen to ONE frame, on origin B
 *     frame 0 (origin B)   the expected window
 *     frame 1 (origin B)   same origin, a different window
 *     frame 2 (origin A)   the top page's own origin, a different window
 *
 * The harness page is served with `frame-src` / `frame-ancestors` only when
 * the test asks for them (`?frame-src=`, `?frame-ancestors=`); every other page
 * of the suite keeps `frame-ancestors 'none'`.
 */
test('a pod accepts window messages only from the window and origin it was told about', async ({ servers, open }) => {
  const A = servers.a.origin
  const B = servers.b.origin
  const page = await open(servers.a, { query: { 'frame-src': `${A},${B}` } })
  const urls = [
    `${B}/?frame-ancestors=${encodeURIComponent(A)}`,
    `${B}/?frame-ancestors=${encodeURIComponent(A)}&n=1`,
    `${A}/?frame-ancestors=${encodeURIComponent(A)}&n=2`,
  ]
  for (const url of urls) await page.evaluate((u) => window.bm.addFrame(u), url)
  const frames = urls.map((u) => page.frames().find((f) => f.url() === u))
  for (const f of frames) {
    expect(f, 'the frame loaded under the strict policy').toBeTruthy()
    await f.waitForFunction(() => window.bmReady === true)
  }

  // The top page listens to frame 0 on origin B only (both must match).
  const topId = await page.evaluate((origin) => window.bm.windowPodBoot({ trustFrame: 0, origins: [origin] }), B)
  // Frame 0 listens to its embedding parent, on origin A only.
  const child0 = await frames[0].evaluate((origin) => window.bm.windowPodBoot({ parent: true, origins: [origin] }), A)
  // The other two have the default: nothing accepted from another window.
  const child1 = await frames[1].evaluate(() => window.bm.windowPodBoot())
  const child2 = await frames[2].evaluate(() => window.bm.windowPodBoot())

  // Each child pod posts its hello to its parent as it boots: the two frames the top page was not told about
  // are refused already (frame 0's is accepted). That is the baseline the counts below build on.
  const base = 2
  await until(page, (n) => window.bm.pod.dropped['window-source'] === n, base)

  // -- child to top ---------------------------------------------------------
  await frames[0].evaluate((to) => window.bm.windowPost('parent', { to, payload: 'unsigned from frame 0' }), topId)
  await frames[0].evaluate((to) => window.bm.windowPost('parent', { to, payload: 'signed from frame 0', signed: true }), topId)
  await until(page, () => window.bm.windowInbox.length === 2)
  expect(await page.evaluate(() => window.bm.windowInbox.map((m) => [m.payload, m.authenticated]))).toEqual([
    ['unsigned from frame 0', false],
    ['signed from frame 0', true],
  ])

  // The same origin, another window: refused. (A signature does not matter.)
  await frames[1].evaluate((to) => window.bm.windowPost('parent', { to, payload: 'from frame 1', signed: true }), topId)
  await until(page, (n) => window.bm.pod.dropped['window-source'] === n + 1, base)
  // The top page's own origin, another window: refused.
  await frames[2].evaluate((to) => window.bm.windowPost('parent', { to, payload: 'from frame 2', signed: true }), topId)
  await until(page, (n) => window.bm.pod.dropped['window-source'] === n + 2, base)
  expect(await page.evaluate(() => window.bm.windowInbox.length)).toBe(2)

  // -- top to child ---------------------------------------------------------
  await page.evaluate((to) => window.bm.windowPost('frame:0', { to, payload: 'from the top', signed: true }), child0)
  await until(frames[0], () => window.bm.windowInbox.length === 1)
  expect(await frames[0].evaluate(() => window.bm.windowInbox[0].payload)).toBe('from the top')

  // A sibling frame cannot post to frame 0 either (frame 0 listens to its parent only).
  await frames[1].evaluate((to) => window.bm.windowPost('sibling:0', { to, payload: 'from a sibling', signed: true }), child0)
  await until(frames[0], () => window.bm.pod.dropped['window-source'] === 1)
  expect(await frames[0].evaluate(() => window.bm.windowInbox.length)).toBe(1)

  // A pod with the default accepts nothing, not even from its parent.
  await page.evaluate((to) => window.bm.windowPost('frame:1', { to, payload: 'to a default pod', signed: true }), child1)
  await page.evaluate((to) => window.bm.windowPost('frame:2', { to, payload: 'to a default pod', signed: true }), child2)
  await until(frames[1], () => window.bm.pod.dropped['window-source'] === 1)
  await until(frames[2], () => window.bm.pod.dropped['window-source'] === 1)
  expect(await frames[1].evaluate(() => window.bm.windowInbox.length)).toBe(0)
  expect(await frames[2].evaluate(() => window.bm.windowInbox.length)).toBe(0)
  expect(await page.evaluate(() => window.bm.pod.dropped['window-source'])).toBe(base + 2)
})
