// What the pod at the other end of a REAL wsh peer link is verified to be: two mesh nodes linked through wsh's real pipe
// relay (in process, no network), the link key-authenticated in both directions and sealed. The provider's hooks see
// `verified: 'wsh'`, and `requireLinkKey` binds a request's signer to the link's key.
//
// Needs the optional peer `@johnhenry/wsh` (installed in this monorepo). `REQUIRE_REAL_PEER=1` makes a missing one fail
// instead of skipping, as for the WebRTC suites.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

let env = null
let transportWsh = null
try {
  transportWsh = await import('@johnhenry/browsermesh-transport/wsh-in-process')
  await import('@johnhenry/wsh')
} catch { /* the optional peer is absent: the suite below skips */ }

if (!transportWsh && process.env.REQUIRE_REAL_PEER) {
  throw new Error('REQUIRE_REAL_PEER is set but `@johnhenry/wsh` did not load, so the wsh link suite would have skipped and reported success. Install the dependency, or unset REQUIRE_REAL_PEER to allow the skip.')
}
if (!transportWsh) describe('link identity over a real wsh link', () => { it('skipped: optional peer `@johnhenry/wsh` is not installed', () => {}) })
const describeIfWsh = transportWsh ? describe : describe.skip

const RELAY = 'wss://relay.invalid'
const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (s) => new Uint8Array(s.match(/../g).map((x) => parseInt(x, 16)))
const signWith = (identity) => async (bytes) => `${hex(await identity.rawPublicKey())}.${hex(await identity.sign(bytes))}`
async function signerOf(sig, bytes) {
  if (typeof sig !== 'string') return false
  const [rawHex, sigHex] = sig.split('.')
  try {
    const raw = unhex(rawHex)
    const key = await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify'])
    return (await crypto.subtle.verify('Ed25519', key, unhex(sigHex), bytes)) ? raw : false
  } catch { return false }
}
const requestSigner = (request, { sig, bytes }) => signerOf(sig, bytes)

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

describeIfWsh('the identity of a wsh peer link, as the provider sees it', () => {
  let apps, pkg, core, discoveryPkg, primitives
  const nodes = {}
  const managers = {}
  const services = {}
  const state = {}
  let served, mesh

  before(async () => {
    apps = await import('@johnhenry/browsermesh-apps')
    pkg = await import('../src/index.mjs')
    core = await import('@johnhenry/browsermesh-core')
    discoveryPkg = await import('@johnhenry/browsermesh-discovery')
    primitives = await import('@johnhenry/browsermesh-primitives')
    env = await transportWsh.createInProcessPipeRelay()
    for (const label of ['ingress', 'provider']) {
      managers[label] = new core.MeshIdentityManager({})
      nodes[label] = await apps.createMeshNode({
        label,
        identityManager: managers[label],
        signalingTransport: { send() {}, onMessage() {} },
        discoveryStrategies: [new discoveryPkg.ManualStrategy()],
        wsh: { relays: [RELAY], WebSocket: env.WebSocket, reconnect: { baseMs: 5, maxMs: 25 }, connectTimeoutMs: 3000 },
      })
    }
    nodes.provider.registry.grantCapabilities(nodes.ingress.podId, ['mesh:link:connect', apps.protocolScope('http')])
    const session = await nodes.ingress.connectToPeer(nodes.provider.podId, { wsh: nodes.provider.podId })
    assert.equal(session.transport, 'wsh')
    await waitFor(() => nodes.provider.hasActiveSession(nodes.ingress.podId), 5000, "the provider's inbound session")
    for (const label of ['ingress', 'provider']) services[label] = apps.attachService(nodes[label], undefined, apps.createMeshProtocolService())
    served = pkg.serveHttpOnMesh(services.provider, (request, context) => state.handler(request, context), {
      allowFrom: (podId, context, peer) => state.allowFrom(podId, context, peer),
      verifyRequest: (request, context, peer) => state.verifyRequest(request, context, peer),
      node: nodes.provider,
    })
    mesh = pkg.createMeshIngress({
      service: services.ingress,
      linkIdentity: pkg.nodeLinkIdentity(nodes.ingress),
      resolve: () => ({ peer: nodes.provider.podId }),
      signRequest: (bytes, info, link) => state.signRequest(bytes, info, link),
    })
  })

  after(async () => {
    try { served?.stop() } catch { /* gone */ }
    try { await mesh?.close() } catch { /* gone */ }
    for (const s of Object.values(services)) { try { s.teardown() } catch { /* gone */ } }
    for (const n of Object.values(nodes)) { try { await n.wsh?.links.close(); await n.shutdown(); await n.signaling.close() } catch { /* gone */ } }
    try { await env?.close() } catch { /* gone */ }
  })

  const use = (hooks = {}) => {
    Object.assign(state, {
      handler: () => new Response('hello'),
      allowFrom: (podId) => podId === nodes.ingress.podId,
      verifyRequest: () => true,
      signRequest: async () => 'signature',
    }, hooks)
    return {
      get: () => mesh.handle(new Request('http://pod.test/'), { clientAddress: '203.0.113.9' }),
      refusals: (reason) => served.stats().refusals[reason] ?? 0,
    }
  }

  it('the node says "wsh" for a pod it has a connected wsh link to, from both ends', () => {
    assert.deepEqual(pkg.nodeLinkIdentity(nodes.provider)(nodes.ingress.podId), { verified: 'wsh' })
    assert.deepEqual(pkg.nodeLinkIdentity(nodes.ingress)(nodes.provider.podId), { verified: 'wsh' })
    assert.equal(pkg.nodeLinkIdentity(nodes.provider)('some-other-pod'), undefined)
  })

  it('a provider\'s hooks see verified "wsh" and the key id of the ingress pod', async () => {
    const seen = { allow: [], verify: [] }
    const t = use({
      allowFrom: (podId, context, peer) => { seen.allow.push(peer); return podId === nodes.ingress.podId },
      verifyRequest: (request, context, peer) => { seen.verify.push(peer); return true },
    })
    assert.equal(await (await t.get()).text(), 'hello')
    for (const peer of [seen.allow.at(-1), seen.verify.at(-1)]) {
      assert.equal(peer.verified, 'wsh')
      assert.equal(peer.podId, nodes.ingress.podId)
      assert.equal(peer.keyId, nodes.ingress.podId)
    }
  })

  it('requireLinkKey serves a request signed by the ingress pod\'s key and refuses one signed by another key', async () => {
    const good = use({ verifyRequest: pkg.requireLinkKey(requestSigner), signRequest: signWith(managers.ingress.getIdentity(nodes.ingress.podId)) })
    assert.equal(await (await good.get()).text(), 'hello')
    let ran = 0
    const bad = use({ handler: () => { ran += 1; return new Response('x') }, verifyRequest: pkg.requireLinkKey(requestSigner), signRequest: signWith(await primitives.PodIdentity.generate()) })
    const before = bad.refusals('link-key-mismatch')
    const res = await bad.get()
    assert.equal(res.status, 502)
    assert.equal(res.headers.get('x-browsermesh-ingress-reason'), 'provider-refused-request')
    assert.equal(bad.refusals('link-key-mismatch'), before + 1)
    assert.equal(ran, 0)
  })

  it('once the wsh link is gone the node proves nothing for that pod', async () => {
    nodes.provider.wsh.links.disconnect(nodes.ingress.podId)
    await waitFor(() => !nodes.provider.wsh.links.isConnected(nodes.ingress.podId), 5000, 'the link to close')
    assert.equal(pkg.nodeLinkIdentity(nodes.provider)(nodes.ingress.podId), undefined)
  })
})
