import { randomUUID } from 'node:crypto'
import { test, expect, until } from './fixtures.mjs'

test('two pods discover each other and exchange messages over BroadcastChannel', async ({ servers, open }) => {
  const channel = `bm-${randomUUID()}`
  const a = await open(servers.a)   // same origin, same browser: what BroadcastChannel is for
  const b = await open(servers.a)

  const aId = await a.evaluate((c) => window.bm.podBoot({ channel: c }), channel)
  const bId = await b.evaluate((c) => window.bm.podBoot({ channel: c }), channel)

  // Discovery is the package's HELLO / HELLO_ACK handshake over the channel.
  await until(a, (id) => window.bm.pod.peers.has(id), bId)
  await until(b, (id) => window.bm.pod.peers.has(id), aId)

  await a.evaluate(([to, payload]) => window.bm.podSend(to, payload), [bId, { kind: 'greeting', text: 'hello from a' }])
  await until(b, () => window.bm.inbox.length === 1)
  expect(await b.evaluate(() => window.bm.inbox)).toEqual([
    { from: aId, to: bId, payload: { kind: 'greeting', text: 'hello from a' } },
  ])

  await b.evaluate(([to, payload]) => window.bm.podSend(to, payload), [aId, { kind: 'reply', n: 2 }])
  await until(a, () => window.bm.inbox.length === 1)
  expect(await a.evaluate(() => window.bm.inbox)).toEqual([
    { from: bId, to: aId, payload: { kind: 'reply', n: 2 } },
  ])
})

test('pods on a different origin are not visible over BroadcastChannel', async ({ servers, open }) => {
  const channel = `bm-${randomUUID()}`
  // Same channel name, same browser, two origins (two ports); plus a second pod
  // on the first origin as the positive control that the channel works at all.
  const a1 = await open(servers.a)
  const a2 = await open(servers.a)
  const other = await open(servers.b)

  const a1Id = await a1.evaluate((c) => window.bm.podBoot({ channel: c }), channel)
  const otherId = await other.evaluate((c) => window.bm.podBoot({ channel: c }), channel)
  const a2Id = await a2.evaluate((c) => window.bm.podBoot({ channel: c }), channel)

  await until(a1, (id) => window.bm.pod.peers.has(id), a2Id)
  await until(a2, (id) => window.bm.pod.peers.has(id), a1Id)

  // Traffic provably crossed the channel on origin A (control)...
  await a1.evaluate(([to, payload]) => window.bm.podSend(to, payload), [a2Id, { probe: 1 }])
  await until(a2, () => window.bm.inbox.length === 1)
  // ...and a broadcast from A reaches no pod on origin B, nor does B's hello reach A.
  expect(await other.evaluate(() => [...window.bm.pod.peers.keys()])).toEqual([])
  expect(await other.evaluate(() => window.bm.inbox)).toEqual([])
  expect(await a1.evaluate(() => [...window.bm.pod.peers.keys()])).not.toContain(otherId)
  expect(await a2.evaluate(() => [...window.bm.pod.peers.keys()])).not.toContain(otherId)
})

test('the raw BroadcastChannel is per-origin in this browser (the premise of the test above)', async ({ servers, open }) => {
  const name = `bm-raw-${randomUUID()}`
  const a1 = await open(servers.a)
  const a2 = await open(servers.a)
  const b = await open(servers.b)
  for (const page of [a1, a2, b]) await page.evaluate((n) => window.bm.rawOpen(n), name)

  await a1.evaluate(() => window.bm.rawPost('from-a1'))
  await until(a2, () => window.bm.rawInbox.length === 1)
  expect(await a2.evaluate(() => window.bm.rawInbox)).toEqual(['from-a1'])
  expect(await b.evaluate(() => window.bm.rawInbox)).toEqual([])
})
