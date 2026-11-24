import http from 'node:http'
import { test, expect, until, exposeHostCandidates } from './fixtures.mjs'

// A PAGE is the provider and the ingress runs in Node (@johnhenry/browsermesh-ingress): a real HTTP client talks to
// the Node listener, the ingress forwards over protocol `http` on a real WebRTC data channel (the Node side is
// node-datachannel, the page side the browser's own RTCPeerConnection, signalled through the local /signaling), and the
// page's `(Request) => Response` handler answers. The page has the strict Content-Security-Policy of every other spec.
//
// The provider grants only the pod id it was told to (default deny): the first request is refused, then granted, then
// revoked while the page is serving.

const PAGE = 'pod-page'
const INGRESS = 'pod-ingress'
const OPEN = 'protocol:http:open'

/** The Node end: a real WebRTC peer for the page, an ingress on it, and a listener on loopback. */
async function startIngress(port) {
  const ndc = await import('node-datachannel/polyfill')
  Object.assign(globalThis, { RTCPeerConnection: ndc.RTCPeerConnection, RTCIceCandidate: ndc.RTCIceCandidate, RTCSessionDescription: ndc.RTCSessionDescription })
  const { WebRTCPeerConnection } = await import('@johnhenry/browsermesh-transport')
  const apps = await import('@johnhenry/browsermesh-apps')
  const { createMeshIngress } = await import('@johnhenry/browsermesh-ingress')
  const { listenNode } = await import('@johnhenry/browsermesh-ingress/node')

  const listeners = new Set()
  const conn = new WebRTCPeerConnection({ localPodId: INGRESS, remotePodId: PAGE, iceServers: [] })
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
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'register', podId: INGRESS })))
    ws.addEventListener('error', () => reject(new Error('signalling socket failed')))
    ws.addEventListener('message', (event) => { if (JSON.parse(event.data).type === 'registered') resolve() })
  })
  return {
    ws, conn,
    async connect() {
      signal({ kind: 'offer', description: await conn.createOffer() })
      for (let i = 0; i < 2000 && !conn.isOpen; i++) await new Promise((r) => setTimeout(r, 15))
      if (!conn.isOpen) throw new Error('the data channel did not open')
      const node = {
        podId: INGRESS,
        onIncomingData(cb) { const l = (data) => cb(PAGE, data); listeners.add(l); return () => listeners.delete(l) },
        async sendTo(_to, data) { conn.send(data) },
      }
      node.registry = new apps.PeerRegistry({ localPodId: INGRESS })
      const service = apps.attachService(node, undefined, apps.createMeshProtocolService())
      const mesh = createMeshIngress({
        service,
        resolve: (request) => (new URL(request.url).host === 'page.test' ? { peer: PAGE } : null),
        methods: ['GET', 'HEAD', 'POST'],
        limits: { timeoutMs: 20_000 },
      })
      const listener = await listenNode(mesh, { port: 0 })
      return {
        mesh, listener,
        /**
         * Shut down in the order that sends nothing into a closed channel: stop listening, close the `http` channel (the
         * page sees it close), then the page lets go of its end, and only then this end.
         */
        async close(page) {
          await listener.close()
          await mesh.close()
          service.teardown()
          if (page && !page.isClosed()) {
            await until(page, () => window.bm.ingressState().served.open === 0)
            await page.evaluate(() => window.bm.ingressStop())
          }
          conn.close()
          ws.close()
          try { (await import('node-datachannel')).cleanup() } catch { /* nothing to clean up */ }
        },
      }
    },
  }
}

/** An HTTP request with a Host the caller chooses. */
function request({ port, host = 'page.test', path = '/', method = 'GET', body, signal }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host }, signal }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function setup(open, servers) {
  const page = await open(servers.a, { isolated: true })
  await exposeHostCandidates(page)
  await page.evaluate((i) => window.bm.rtcRegister({ local: i.local, remote: i.remote }), { local: PAGE, remote: INGRESS })
  await page.evaluate(() => window.bm.ingressServe())
  const peer = await startIngress(servers.a.port)
  const ingress = await peer.connect()
  return { page, ingress, peer, port: ingress.listener.port }
}

test('a page answers real HTTP: default deny, then a grant, then a revocation', async ({ servers, open }) => {
  const { page, ingress, port } = await setup(open, servers)
  try {
    // Nothing granted: the page refuses the protocol and the HTTP client is told, by name.
    const refused = await request({ port })
    expect(refused.status).toBe(502)
    expect(refused.headers['x-browsermesh-ingress-reason']).toBe('provider-not-authorized')
    expect((await page.evaluate(() => window.bm.ingressState())).seen).toEqual([])

    await page.evaluate((s) => window.bm.ingressGrant(s), [OPEN])
    const home = await request({ port, path: '/?q=1' })
    expect(home.status).toBe(200)
    expect(home.body.toString()).toBe('<h1>served by a page</h1>')
    expect(home.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'; sandbox")
    expect(home.headers['x-content-type-options']).toBe('nosniff')
    expect(home.headers['cache-control']).toBe('no-store')

    // What the page saw: the verified ingress pod, a Request built from parsed parts, only allow-listed headers.
    const state = await page.evaluate(() => window.bm.ingressState())
    expect(state.seen).toEqual([{ method: 'GET', path: '/?q=1', peer: INGRESS, host: 'page.test', headers: [] }])

    // Unmapped host: the page is not asked. Method not allowed: neither.
    expect((await request({ port, host: 'other.test' })).status).toBe(404)
    expect((await request({ port, method: 'DELETE' })).status).toBe(405)
    expect((await page.evaluate(() => window.bm.ingressState())).seen.length).toBe(1)

    await page.evaluate((s) => window.bm.ingressRevoke(s), [OPEN])
    await until(page, () => window.bm.ingressState().served.open === 0)
    expect((await request({ port })).status).toBe(502)
  } finally {
    await ingress.close(page)
  }
})

test('a POST body reaches the page and a 600 KB answer comes back intact, in chunks', async ({ servers, open }) => {
  const { page, ingress, port } = await setup(open, servers)
  try {
    await page.evaluate((s) => window.bm.ingressGrant(s), [OPEN])
    const echoed = await request({ port, path: '/echo', method: 'POST', body: 'hello page' })
    expect(echoed.body.toString()).toBe('POST:hello page')
    const big = await request({ port, path: '/big' })
    expect(big.body.byteLength).toBe(600_000)
    const wrong = big.body.findIndex((b, i) => b !== (i * 31) % 251)
    expect(wrong).toBe(-1)
  } finally {
    await ingress.close(page)
  }
})

test('what a page cannot make the HTTP client believe: cookies, its own policy, redirects off the origin', async ({ servers, open }) => {
  const { page, ingress, port } = await setup(open, servers)
  try {
    await page.evaluate((s) => window.bm.ingressGrant(s), [OPEN])
    const hostile = await request({ port, path: '/hostile' })
    expect(hostile.status).toBe(200)
    expect(hostile.headers['set-cookie']).toBeUndefined()
    expect(hostile.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'; sandbox")
    expect(hostile.headers['cache-control']).toBe('no-store')
    const redirect = await request({ port, path: '/redirect' })
    expect(redirect.status).toBe(502)
    expect(redirect.headers['x-browsermesh-ingress-reason']).toBe('provider-redirect-refused')
    expect(redirect.headers.location).toBeUndefined()
  } finally {
    await ingress.close(page)
  }
})

test('an HTTP client that hangs up aborts the page\'s handler', async ({ servers, open }) => {
  const { page, ingress, port } = await setup(open, servers)
  try {
    await page.evaluate((s) => window.bm.ingressGrant(s), [OPEN])
    const ac = new AbortController()
    const pending = request({ port, path: '/hang', signal: ac.signal }).catch((e) => e)
    await until(page, () => window.bm.ingressState().seen.some((r) => r.path === '/hang'))
    ac.abort()
    await pending
    await until(page, () => window.bm.ingressState().aborted === 1)
  } finally {
    await ingress.close(page)
  }
})
