import dgram from 'node:dgram'
import http from 'node:http'
import net from 'node:net'
import { test, expect, exposeHostCandidates } from './fixtures.mjs'

// A PAGE is the consumer and the egress provider runs in Node (@johnhenry/browsermesh-egress): the page asks the provider for a
// TCP connection, a UDP flow and a fetch over protocol `egress` on a real WebRTC data channel (the Node side is node-datachannel,
// the page side the browser's own RTCPeerConnection, signalled through the local /signaling). The destinations are local servers:
// an HTTP server, a TCP echo and a UDP echo, all on 127.0.0.1.
//
// Loopback is refused by the provider's address guard by default (and in wide mode, always). These tests give the PROVIDER an
// explicit `allowPrivate: ['127.0.0.1']` (its documented operator option, never a peer's grant) so a local server can stand in
// for the network, and show in the same run that the guard still refuses every other private, loopback and metadata address
// even with a grant for it. Nothing here weakens a default.

const PAGE = 'pod-page'
const PROVIDER = 'pod-egress'
const OPEN = 'protocol:egress:open'

/** Local destinations. `log` records what each saw, so a test can say what did and did not reach it. */
async function startDestinations() {
  const log = { http: [], tcp: [], udp: [], bigClosed: false }
  const sockets = new Set()
  const web = http.createServer((req, res) => {
    log.http.push({ method: req.method, url: req.url, headers: req.headers })
    if (req.url === '/hello') { res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'sid=1', 'x-secret': 'no' }); res.end('hello from the destination'); return }
    if (req.url === '/redirect') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return }
    if (req.url === '/echo') { const parts = []; req.on('data', (d) => parts.push(d)); req.on('end', () => { res.writeHead(200); res.end(`${req.method}:${Buffer.concat(parts)}`) }); return }
    if (req.url === '/big') {
      res.writeHead(200)
      let n = 0
      res.on('close', () => { log.bigClosed = true })
      const pump = () => { while (n < 256) { n += 1; if (!res.write(Buffer.alloc(64 * 1024, 7))) { res.once('drain', pump); return } } res.end() }
      pump()
      return
    }
    res.writeHead(404); res.end('not found')
  })
  web.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}) })
  const tcp = net.createServer((s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {}); s.on('data', (d) => { log.tcp.push(String(d)); s.write(`echo:${d}`) }); s.on('end', () => s.end()) })
  const udp = dgram.createSocket('udp4')
  udp.on('message', (m, r) => { log.udp.push(String(m)); udp.send(`echo:${m}`, r.port, r.address) })
  await Promise.all([
    new Promise((r) => web.listen(0, '127.0.0.1', r)),
    new Promise((r) => tcp.listen(0, '127.0.0.1', r)),
    new Promise((r) => udp.bind(0, '127.0.0.1', r)),
  ])
  return {
    log,
    http: web.address().port,
    tcp: tcp.address().port,
    udp: udp.address().port,
    async close() {
      for (const s of sockets) s.destroy()
      await Promise.all([new Promise((r) => web.close(r)), new Promise((r) => tcp.close(r)), new Promise((r) => udp.close(r))])
    },
  }
}

/** The Node end: a real WebRTC peer for the page, an egress provider on it (the real address guard, loopback allowed by the operator). */
async function startProvider(port) {
  const ndc = await import('node-datachannel/polyfill')
  Object.assign(globalThis, { RTCPeerConnection: ndc.RTCPeerConnection, RTCIceCandidate: ndc.RTCIceCandidate, RTCSessionDescription: ndc.RTCSessionDescription })
  const { WebRTCPeerConnection } = await import('@johnhenry/browsermesh-transport')
  const apps = await import('@johnhenry/browsermesh-apps')
  const { createMeshEgress } = await import('@johnhenry/browsermesh-egress')
  const { nodeDialer } = await import('@johnhenry/browsermesh-egress/node')

  const listeners = new Set()
  const conn = new WebRTCPeerConnection({ localPodId: PROVIDER, remotePodId: PAGE, iceServers: [] })
  const ws = new WebSocket(`ws://127.0.0.1:${port}/signaling`)
  const signal = (envelope) => ws.send(JSON.stringify({ type: 'signal', target: PAGE, envelope }))
  conn.onIceCandidate((candidate) => signal({ kind: 'ice', candidate }))
  conn.onMessage((data) => { for (const l of listeners) l(data) })
  let chain = Promise.resolve()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.type !== 'signal') return
    chain = chain.then(async () => {
      const { kind, description, candidate } = msg.envelope
      if (kind === 'answer') await conn.handleAnswer(description)
      else if (kind === 'ice') await conn.addIceCandidate(candidate)
    })
  })
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'register', podId: PROVIDER })))
    ws.addEventListener('error', () => reject(new Error('signalling socket failed')))
    ws.addEventListener('message', (event) => { if (JSON.parse(event.data).type === 'registered') resolve() })
  })
  return {
    async connect() {
      signal({ kind: 'offer', description: await conn.createOffer() })
      for (let i = 0; i < 2000 && !conn.isOpen; i++) await new Promise((r) => setTimeout(r, 15))
      if (!conn.isOpen) throw new Error('the data channel did not open')
      const node = {
        podId: PROVIDER,
        onIncomingData(cb) { const l = (data) => cb(PAGE, data); listeners.add(l); return () => listeners.delete(l) },
        async sendTo(_to, data) { conn.send(data) },
      }
      node.registry = new apps.PeerRegistry({ localPodId: PROVIDER })
      const service = apps.attachService(node, undefined, apps.createMeshProtocolService())
      const audit = []
      const egress = createMeshEgress({
        service, registry: node.registry, unattended: true, onAudit: (r) => audit.push(r),
        ...nodeDialer({ allowPrivate: ['127.0.0.1'], denyOwnAddresses: false }),
        fetchMethods: ['GET', 'HEAD', 'POST'],
      })
      egress.start()
      return {
        egress, audit,
        /** Grants the page the protocol and these scopes (the provider operator's act). */
        grant: (scopes) => node.registry.grantCapabilities(PAGE, [OPEN, ...scopes]),
        revoke: (scopes) => node.registry.revokeCapabilities(PAGE, scopes),
        /** Shut down in the order that sends nothing into a closed channel: the page lets go first, then the provider. */
        async close(page) {
          if (page && !page.isClosed()) await page.evaluate(() => window.bm.egressStop())
          await egress.stop()
          service.teardown()
          conn.close()
          ws.close()
          try { (await import('node-datachannel')).cleanup() } catch { /* nothing to clean up */ }
        },
      }
    },
  }
}

async function setup(open, servers) {
  const page = await open(servers.a, { isolated: true })
  await exposeHostCandidates(page)
  await page.evaluate((i) => window.bm.rtcRegister({ local: i.local, remote: i.remote }), { local: PAGE, remote: PROVIDER })
  const destinations = await startDestinations()
  const peer = await startProvider(servers.a.port)
  const provider = await peer.connect()
  return { page, provider, destinations }
}

async function teardown({ page, provider, destinations }) {
  await provider.close(page)
  await destinations.close()
}

const grants = (d) => [
  `egress:tcp:127.0.0.1:${d.tcp}:connect`,
  `egress:http:127.0.0.1:${d.http}:fetch`,
  `egress:udp:127.0.0.1:${d.udp}:send`,
]

test('a page without a grant is refused by name; granted, it gets TCP, a fetch and UDP from a Node provider', async ({ servers, open }) => {
  const rig = await setup(open, servers)
  const { page, provider, destinations: d } = rig
  try {
    // The protocol itself is default deny.
    expect(await page.evaluate(() => window.bm.egressConnect())).toEqual({ ok: false, code: 'provider-not-authorized' })

    provider.grant([])
    expect(await page.evaluate(() => window.bm.egressConnect())).toEqual({ ok: true })
    // The channel is open and nothing is granted for any destination: refused, and nothing reached any destination.
    expect(await page.evaluate((p) => window.bm.egressTcp('127.0.0.1', p, 'hi'), d.tcp)).toMatchObject({ ok: false, code: 'no-grant' })
    expect(await page.evaluate((p) => window.bm.egressFetch(`http://127.0.0.1:${p}/hello`), d.http)).toMatchObject({ ok: false, code: 'no-grant' })
    expect(await page.evaluate((p) => window.bm.egressUdp('127.0.0.1', p, 'hi'), d.udp)).toMatchObject({ ok: false, code: 'no-grant' })
    expect(d.log).toMatchObject({ http: [], tcp: [], udp: [] })

    provider.grant(grants(d))
    // TCP: the bytes the page wrote are the bytes the destination saw, and the answer comes back, half-close and all.
    expect(await page.evaluate((p) => window.bm.egressTcp('127.0.0.1', p, 'hello tcp'), d.tcp)).toEqual({ ok: true, text: 'echo:hello tcp' })
    expect(d.log.tcp).toEqual(['hello tcp'])
    // Fetch: a Response through the provider. The provider made the request; a cookie the destination set did not reach the page.
    const res = await page.evaluate((p) => window.bm.egressFetch(`http://127.0.0.1:${p}/hello`), d.http)
    expect(res).toMatchObject({ ok: true, status: 200, text: 'hello from the destination', redirected: false })
    expect(res.headers.map(([k]) => k)).not.toContain('set-cookie')
    expect(res.headers.map(([k]) => k)).not.toContain('x-secret')
    expect(d.log.http[0].headers['user-agent']).toBe('browsermesh-egress')
    expect(d.log.http[0].headers.cookie).toBeUndefined()
    // UDP: one datagram out, one back.
    expect(await page.evaluate((p) => window.bm.egressUdp('127.0.0.1', p, 'ping'), d.udp)).toEqual({ ok: true, text: 'echo:ping' })
    expect(d.log.udp).toEqual(['ping'])
    // What the provider's operator sees: every open is in the audit, with the checked address, and no payload.
    expect(provider.audit.filter((r) => r.event === 'egress-open').map((r) => [r.form, r.address, r.addressClass])).toEqual([['tcp', '127.0.0.1', 'loopback'], ['fetch', '127.0.0.1', 'loopback'], ['udp', '127.0.0.1', 'loopback']])
    expect(JSON.stringify(provider.audit)).not.toContain('hello tcp')
    expect(JSON.stringify(provider.audit)).not.toContain('/hello')
  } finally {
    await teardown(rig)
  }
})

test('the guard still refuses what the operator did not list, grant or no grant; a redirect off the grant is refused', async ({ servers, open }) => {
  const rig = await setup(open, servers)
  const { page, provider, destinations: d } = rig
  try {
    // Grants for destinations the guard refuses: another loopback address (the operator listed only 127.0.0.1), the cloud
    // metadata address and a private one. The grant does not make them reachable.
    provider.grant([...grants(d), `egress:tcp:127.0.0.2:${d.tcp}:connect`, 'egress:tcp:169.254.169.254:80:connect', 'egress:http:169.254.169.254:80:fetch', 'egress:udp:10.0.0.5:4000:send'])
    expect(await page.evaluate(() => window.bm.egressConnect())).toEqual({ ok: true })
    expect(await page.evaluate((p) => window.bm.egressTcp('127.0.0.2', p, 'x'), d.tcp)).toMatchObject({ ok: false, code: 'destination-refused', addressClass: 'loopback' })
    expect(await page.evaluate(() => window.bm.egressTcp('169.254.169.254', 80, 'x'))).toMatchObject({ ok: false, code: 'destination-refused', addressClass: 'metadata' })
    expect(await page.evaluate(() => window.bm.egressUdp('10.0.0.5', 4000, 'x'))).toMatchObject({ ok: false, code: 'destination-refused', addressClass: 'private' })
    // A destination the destination itself redirects to: not granted is redirect-refused; granted, the address guard still says no.
    expect(await page.evaluate((p) => window.bm.egressFetch(`http://127.0.0.1:${p}/redirect`), d.http)).toMatchObject({ ok: false, code: 'destination-refused', addressClass: 'metadata' })
    provider.revoke(['egress:http:169.254.169.254:80:fetch'])
    expect(await page.evaluate((p) => window.bm.egressFetch(`http://127.0.0.1:${p}/redirect`), d.http)).toMatchObject({ ok: false, code: 'redirect-refused' })
    // Only the one request that was made at all reached the destination; nothing reached the others.
    expect(d.log.http.map((r) => r.url)).toEqual(['/redirect', '/redirect'])
    expect(d.log.tcp).toEqual([])
    // The blocked ports stay blocked for a grant that names them.
    provider.grant(['egress:tcp:127.0.0.1:25:connect'])
    expect(await page.evaluate(() => window.bm.egressTcp('127.0.0.1', 25, 'x'))).toMatchObject({ ok: false, code: 'port-blocked' })
    // And a wildcard grant is refused unless the operator acknowledged wide mode, which this provider did not.
    provider.grant(['egress:tcp:*:*:connect'])
    expect(await page.evaluate(() => window.bm.egressTcp('93.184.216.34', 443, 'x'))).toMatchObject({ ok: false, code: 'wide-not-acknowledged' })
  } finally {
    await teardown(rig)
  }
})

test('a revocation takes effect on the next request, and a page that cancels a big body stops the destination', async ({ servers, open }) => {
  const rig = await setup(open, servers)
  const { page, provider, destinations: d } = rig
  try {
    provider.grant(grants(d))
    expect(await page.evaluate(() => window.bm.egressConnect())).toEqual({ ok: true })
    expect(await page.evaluate((p) => window.bm.egressFetch(`http://127.0.0.1:${p}/echo`, { method: 'POST', body: 'posted' }), d.http)).toMatchObject({ ok: true, status: 200, text: 'POST:posted' })
    // 16 MiB is on offer; the page reads 200 KB and cancels: the provider lets go of the destination long before it is drained.
    const partial = await page.evaluate((p) => window.bm.egressFetchPartial(`http://127.0.0.1:${p}/big`, 200_000), d.http)
    expect(partial.ok).toBe(true)
    expect(partial.got).toBeGreaterThanOrEqual(200_000)
    await expect.poll(() => d.log.bigClosed, { message: 'the destination to see its connection closed' }).toBe(true)
    await expect.poll(() => provider.egress.stats().open, { message: 'the provider to have nothing open' }).toBe(0)
    provider.revoke([`egress:http:127.0.0.1:${d.http}:fetch`])
    expect(await page.evaluate((p) => window.bm.egressFetch(`http://127.0.0.1:${p}/hello`), d.http)).toMatchObject({ ok: false, code: 'no-grant' })
    // The TCP grant was not revoked: it still works.
    expect(await page.evaluate((p) => window.bm.egressTcp('127.0.0.1', p, 'again'), d.tcp)).toEqual({ ok: true, text: 'echo:again' })
  } finally {
    await teardown(rig)
  }
})
