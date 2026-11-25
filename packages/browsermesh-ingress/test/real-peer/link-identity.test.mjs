// What the pod at the other end of a REAL WebRTC data channel is verified to be. Two pairs of real mesh nodes (real
// identities, a real data channel between each pair, loopback host candidates only):
//   - the default pair proves its pod keys over the connection's DTLS fingerprints (the transport's identity binding), so
//     a provider's hooks see `verified: 'bound'` and `requireLinkKey` can bind a request's signer to the link;
//   - a pair with the binding switched off connects fine and proves nothing, so the same hooks see `verified: 'none'`.
//
// Same optional `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as every other real-peer suite here.
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

let ndc = null
let ndcMain = null
try {
  ndc = await import('node-datachannel/polyfill')
  ndcMain = await import('node-datachannel')
} catch { /* optional dependency absent: the suite below skips */ }

if (!ndc && process.env.REQUIRE_REAL_PEER) {
  throw new Error('REQUIRE_REAL_PEER is set but `node-datachannel` did not load, so the real-peer suite would have skipped and reported success. Install the dependency, or unset REQUIRE_REAL_PEER to allow the skip.')
}
if (!ndc) describe('link identity over real WebRTC peers', () => { it('skipped: optional dependency `node-datachannel` is not installed', () => {}) })
const describeIfReal = ndc ? describe : describe.skip

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 15))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}
const WEBRTC_TIMEOUT_MS = 30_000

const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (s) => new Uint8Array(s.match(/../g).map((x) => parseInt(x, 16)))

/** A signature that names its own signing key: `<raw key hex>.<signature hex>`. */
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
const responseSigner = ({ sig, bytes }) => signerOf(sig, bytes)

describeIfReal('the identity of a real WebRTC link, as the provider and the ingress see it', () => {
  let apps, pkg, core, discoveryPkg, peerIdentity, primitives
  const pairs = {}
  const cleanups = []

  async function makePair(name, nodeOptions) {
    const bus = new Set()
    const transport = () => { let handler = null; const rx = (m) => handler?.(m); bus.add(rx); return { send(m) { for (const fn of bus) if (fn !== rx) fn(m) }, onMessage(cb) { handler = cb } } }
    const discovery = { ingress: new discoveryPkg.ManualStrategy(), provider: new discoveryPkg.ManualStrategy() }
    const nodes = {}
    const managers = {}
    for (const label of ['ingress', 'provider']) {
      managers[label] = new core.MeshIdentityManager({})
      nodes[label] = await apps.createMeshNode({ label, identityManager: managers[label], discoveryStrategies: [discovery[label]], signalingTransport: transport(), iceServers: [], ...nodeOptions })
    }
    discovery.ingress.addPeer(new discoveryPkg.DiscoveryRecord({ podId: nodes.provider.podId, transport: 'webrtc', label: 'provider' }))
    discovery.provider.addPeer(new discoveryPkg.DiscoveryRecord({ podId: nodes.ingress.podId, transport: 'webrtc', label: 'ingress' }))
    await nodes.ingress.discover()
    await nodes.provider.discover()
    await nodes.ingress.connectToPeer(nodes.provider.podId, { webrtc: nodes.provider.podId }, { answerTimeoutMs: WEBRTC_TIMEOUT_MS, openTimeoutMs: WEBRTC_TIMEOUT_MS })
    await waitFor(() => nodes.provider.meshManager.getConnection(nodes.ingress.podId)?.isOpen && nodes.provider.hasActiveSession(nodes.ingress.podId), WEBRTC_TIMEOUT_MS, "the provider's side of the data channel to open")
    const services = {}
    for (const label of ['ingress', 'provider']) services[label] = apps.attachService(nodes[label], undefined, apps.createMeshProtocolService())
    nodes.provider.registry.grantCapabilities(nodes.ingress.podId, [apps.protocolScope('http')])
    const identities = { ingress: managers.ingress.getIdentity(nodes.ingress.podId), provider: managers.provider.getIdentity(nodes.provider.podId) }
    const pair = { nodes, services, identities }
    pairs[name] = pair

    // One provider and one ingress per pair; each test sets the hooks they delegate to.
    const state = {}
    const served = pkg.serveHttpOnMesh(services.provider, (request, context) => state.handler(request, context), {
      allowFrom: (podId, context, peer) => state.allowFrom(podId, context, peer),
      verifyRequest: (request, context, peer) => state.verifyRequest(request, context, peer),
      sign: (bytes, info) => state.sign(bytes, info),
      node: nodes.provider,
    })
    const mesh = pkg.createMeshIngress({
      service: services.ingress,
      linkIdentity: pkg.nodeLinkIdentity(nodes.ingress),
      resolve: () => ({ peer: nodes.provider.podId }),
      signRequest: (bytes, info, link) => state.signRequest(bytes, info, link),
      verifyResponse: (info, link) => state.verifyResponse(info, link),
    })
    cleanups.push(async () => {
      served.stop()
      await mesh.close()
      for (const s of Object.values(services)) { try { s.teardown() } catch { /* gone */ } }
      for (const n of Object.values(nodes)) { try { await n.shutdown() } catch { /* gone */ } }
    })
    /** Set the hooks for one test (everything else is the permissive default) and get the way to send a request. */
    pair.use = (hooks = {}) => {
      Object.assign(state, {
        handler: () => new Response('hello'),
        allowFrom: (podId) => podId === nodes.ingress.podId,
        verifyRequest: () => true,
        sign: async () => 'signature',
        signRequest: async () => 'signature',
        verifyResponse: async () => true,
      }, hooks)
      return {
        get: (path = '/') => mesh.handle(new Request(`http://pod.test${path}`), { clientAddress: '203.0.113.9' }),
        refusals: (reason) => served.stats().refusals[reason] ?? 0,
      }
    }
    return pair
  }

  before(async () => {
    Object.assign(globalThis, { RTCPeerConnection: ndc.RTCPeerConnection, RTCIceCandidate: ndc.RTCIceCandidate, RTCSessionDescription: ndc.RTCSessionDescription })
    apps = await import('@johnhenry/browsermesh-apps')
    pkg = await import('../../src/index.mjs')
    peerIdentity = await import('../../src/peer-identity.mjs')
    core = await import('@johnhenry/browsermesh-core')
    discoveryPkg = await import('@johnhenry/browsermesh-discovery')
    primitives = await import('@johnhenry/browsermesh-primitives')
    await makePair('bound', {})
    await waitFor(() => pairs.bound.nodes.provider.meshManager.getConnection(pairs.bound.nodes.ingress.podId)?.bound === true, WEBRTC_TIMEOUT_MS, 'the connection to prove its identity')
    await makePair('unbound', { webrtcIdentityBinding: false })
  })

  after(async () => {
    for (const c of cleanups.splice(0).reverse()) { try { await c() } catch { /* gone */ } }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('the default connection proved the pod key: the transport says bound, and the pod id is the hash of the key', async () => {
    const { nodes, identities } = pairs.bound
    assert.equal(nodes.provider.meshManager.getConnection(nodes.ingress.podId).bound, true)
    assert.equal(nodes.ingress.meshManager.getConnection(nodes.provider.podId).bound, true)
    assert.deepEqual(pkg.nodeLinkIdentity(nodes.provider)(nodes.ingress.podId), { verified: 'bound' })
    assert.equal(await peerIdentity.podIdOfRawKey(await identities.ingress.rawPublicKey()), nodes.ingress.podId)
  })

  it('on a bound link a provider\'s hooks see verified "bound" and the key id of the ingress pod', async () => {
    const seen = { allow: [], verify: [] }
    const { nodes } = pairs.bound
    const t = pairs.bound.use({
      allowFrom: (podId, context, peer) => { seen.allow.push(peer); return podId === nodes.ingress.podId },
      verifyRequest: (request, context, peer) => { seen.verify.push(peer); return true },
    })
    assert.equal(await (await t.get('/')).text(), 'hello')
    for (const peer of [seen.allow.at(-1), seen.verify.at(-1)]) {
      assert.equal(peer.verified, 'bound')
      assert.equal(peer.podId, nodes.ingress.podId)
      assert.equal(peer.keyId, nodes.ingress.podId)
    }
  })

  it('on a bound link requireLinkKey serves a request signed by the ingress pod\'s key', async () => {
    const t = pairs.bound.use({ verifyRequest: pkg.requireLinkKey(requestSigner), signRequest: signWith(pairs.bound.identities.ingress) })
    const before = t.refusals('link-key-mismatch')
    assert.equal(await (await t.get('/')).text(), 'hello')
    assert.equal(t.refusals('link-key-mismatch'), before)
  })

  it('on a bound link a request with a valid signature by ANOTHER key is refused, naming the reason; the provider\'s own key does not pass either', async () => {
    let ran = 0
    for (const identity of [await primitives.PodIdentity.generate(), pairs.bound.identities.provider]) {
      const t = pairs.bound.use({ handler: () => { ran += 1; return new Response('x') }, verifyRequest: pkg.requireLinkKey(requestSigner), signRequest: signWith(identity) })
      const before = t.refusals('link-key-mismatch')
      const res = await t.get('/')
      assert.equal(res.status, 502)
      assert.equal(res.headers.get('x-browsermesh-ingress-reason'), 'provider-refused-request')
      assert.equal(t.refusals('link-key-mismatch'), before + 1)
    }
    assert.equal(ran, 0)
  })

  it('on a bound link the ingress sees the provider link as bound, and requireLinkKey binds the response signer to it', async () => {
    const { identities, nodes } = pairs.bound
    const seen = []
    const good = pairs.bound.use({ sign: signWith(identities.provider), verifyResponse: pkg.requireLinkKey(responseSigner), signRequest: async (b, i, link) => { seen.push(link); return 's' } })
    assert.equal(await (await good.get('/')).text(), 'hello')
    assert.equal(seen[0].verified, 'bound')
    assert.equal(seen[0].keyId, nodes.provider.podId)
    const wrong = pairs.bound.use({ sign: signWith(identities.ingress), verifyResponse: pkg.requireLinkKey(responseSigner) }) // a valid signature, by a key that is not the provider's
    const res = await wrong.get('/')
    assert.equal(res.status, 502)
    assert.equal(res.headers.get('x-browsermesh-ingress-reason'), 'response-signature-invalid')
  })

  it('with the binding switched off the link connects and proves nothing: verified "none", no key fields', async () => {
    const { nodes } = pairs.unbound
    assert.equal(nodes.provider.meshManager.getConnection(nodes.ingress.podId).bound, false)
    assert.equal(pkg.nodeLinkIdentity(nodes.provider)(nodes.ingress.podId), undefined)
    const seen = []
    const t = pairs.unbound.use({ verifyRequest: (request, context, peer) => { seen.push(peer); return true } })
    assert.equal(await (await t.get('/')).text(), 'hello')
    assert.equal(seen[0].verified, 'none')
    assert.equal(seen[0].podId, nodes.ingress.podId)
    assert.ok(!('keyId' in seen[0]) && !('publicKey' in seen[0]))
  })

  it('on a link that proved nothing requireLinkKey refuses, even for a request signed by the pod\'s own key', async () => {
    let ran = 0
    const t = pairs.unbound.use({ handler: () => { ran += 1; return new Response('x') }, verifyRequest: pkg.requireLinkKey(requestSigner), signRequest: signWith(pairs.unbound.identities.ingress) })
    const before = t.refusals('link-unverified')
    const res = await t.get('/')
    assert.equal(res.status, 502)
    assert.equal(ran, 0)
    assert.equal(t.refusals('link-unverified'), before + 1)
  })
})
