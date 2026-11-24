import { test, expect, until } from './fixtures.mjs'

// The signalling server sends `registered` and then, in a later frame, `peers`
// (browsermesh-servers/signaling/index.mjs), so a pod's boot-time hello can go
// out before it knows anyone. Discovery therefore greets each peer the
// transport learns of (`peers`, `peer-joined`), whatever the order.
test('two pods in separate browsers DISCOVER each other through the WebSocket relay', async ({ servers, open }) => {
  const a = await open(servers.a, { isolated: true })
  const b = await open(servers.b, { isolated: true })
  const aId = await a.evaluate(() => window.bm.podBoot({ relay: true }))
  const bId = await b.evaluate(() => window.bm.podBoot({ relay: true }))
  await until(a, (id) => window.bm.pod.peers.has(id), bId)
  await until(b, (id) => window.bm.pod.peers.has(id), aId)
})

test('two pods in separate browsers exchange messages through the WebSocket relay', async ({ servers, open }) => {
  // Two origins on purpose: the relay is the only thing they share.
  const a = await open(servers.a, { isolated: true })
  const b = await open(servers.b, { isolated: true })

  const aId = await a.evaluate(() => window.bm.podBoot({ relay: true }))
  const bId = await b.evaluate(() => window.bm.podBoot({ relay: true }))

  // Each transport learns the other from the signalling server (peers / peer-joined).
  await until(a, (id) => window.bm.pod.transport.knownPeers.has(id), bId)
  await until(b, (id) => window.bm.pod.transport.knownPeers.has(id), aId)

  await a.evaluate(([to, payload]) => window.bm.podSend(to, payload), [bId, { via: 'relay', n: 1 }])
  await until(b, () => window.bm.inbox.length === 1)
  expect(await b.evaluate(() => window.bm.inbox)).toEqual([{ from: aId, to: bId, payload: { via: 'relay', n: 1 } }])

  await b.evaluate(([to, payload]) => window.bm.podSend(to, payload), [aId, { via: 'relay', n: 2 }])
  await until(a, () => window.bm.inbox.length === 1)
  expect(await a.evaluate(() => window.bm.inbox)).toEqual([{ from: bId, to: aId, payload: { via: 'relay', n: 2 } }])
})

test('the transport package WebSocketTransport moves text and binary over a real socket', async ({ servers, open }) => {
  const page = await open(servers.a)
  await page.evaluate(() => window.bm.wsConnect())

  await page.evaluate(() => window.bm.wsSend('hello over a real socket'))
  await until(page, () => window.bm.wsInbox.length === 1)

  // 1 MiB of binary, byte-exact.
  await page.evaluate(() => {
    const bytes = new Uint8Array(1024 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff
    window.bm.wsSend(bytes)
  })
  await until(page, () => window.bm.wsInbox.length === 2)
  const result = await page.evaluate(async () => {
    const [text, bin] = window.bm.wsInbox
    const data = bin instanceof Blob ? new Uint8Array(await bin.arrayBuffer()) : new Uint8Array(bin)
    let exact = data.length === 1024 * 1024
    for (let i = 0; exact && i < data.length; i++) if (data[i] !== ((i * 31 + 7) & 0xff)) exact = false
    return { text, exact, length: data.length }
  })
  expect(result).toEqual({ text: 'hello over a real socket', exact: true, length: 1024 * 1024 })

  await page.evaluate(() => window.bm.wsClose())
})
