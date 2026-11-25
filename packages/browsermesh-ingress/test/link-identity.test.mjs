// What a provider (and an ingress) is told about the identity of the link a request came over: `peer.verified`, and the
// helper that binds a request's signer to the link's key. In-process doubles; a real WebRTC link is in
// test/real-peer/link-identity.test.mjs and a real wsh link in test/wsh-link-identity.test.mjs. Each rule is broken once
// by a test here.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { attachService, createMeshProtocolService } from '@johnhenry/browsermesh-apps'
import { createMeshIngress, serveHttpOnMesh, requireLinkKey, nodeLinkIdentity, LINK_KEY_REFUSALS, PEER_VERIFIED } from '../src/index.mjs'
import { describePeer, podIdOfRawKey } from '../src/peer-identity.mjs'
import { REASON_HEADER } from '../src/errors.mjs'
import { createNodes, threePods, grantHttp, OPEN } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })

const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('')
const unhex = (s) => new Uint8Array(s.match(/../g).map((x) => parseInt(x, 16)))
const keyPair = () => globalThis.crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])
const rawOf = async (pair) => new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))

/** A signature that names its own signing key: `<raw key hex>.<signature hex>`. */
const signWith = (pair) => async (bytes) => `${hex(await rawOf(pair))}.${hex(await crypto.subtle.sign('Ed25519', pair.privateKey, bytes))}`
/** The signature check a provider already does, returning the key that made it (what `requireLinkKey` wants). */
async function verifySigner(sig, bytes) {
  if (typeof sig !== 'string') return false
  const [rawHex, sigHex] = sig.split('.')
  try {
    const raw = unhex(rawHex)
    const key = await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify'])
    return (await crypto.subtle.verify('Ed25519', key, unhex(sigHex), bytes)) ? raw : false
  } catch { return false }
}
const requestSigner = (request, { sig, bytes }) => verifySigner(sig, bytes)
const responseSigner = ({ sig, bytes }) => verifySigner(sig, bytes)

const resolveOpts = (opts, pods) => (typeof opts === 'function' ? opts(pods) : opts)

/** An ingress pod, a provider and a stranger on the in-process bus; `provider` / `ingress` options may be functions of the pods. */
async function rig({ handler, provider = {}, ingress = {} } = {}) {
  const pods = await threePods()
  cleanups.push(() => pods.teardown())
  const logs = []
  const served = serveHttpOnMesh(pods.p, handler ?? (() => new Response('hello')), { allowFrom: [pods.ingress.podId], onLog: (event, data) => logs.push({ event, data }), ...resolveOpts(provider, pods) })
  cleanups.push(() => served.stop())
  grantHttp(pods)
  const mesh = createMeshIngress({ service: pods.i, resolve: () => ({ peer: pods.provider.podId }), ...resolveOpts(ingress, pods) })
  cleanups.push(() => mesh.close())
  return { ...pods, served, mesh, logs, get: (path = '/', init) => mesh.handle(new Request(`http://app.example.test${path}`, init), { clientAddress: '203.0.113.9' }) }
}

const BOUND = () => ({ verified: 'bound' })

describe('the peer object a provider hook gets', () => {
  it('with nothing said about the link, verifyRequest and allowFrom get verified "none" and no key fields', async () => {
    const seen = { verify: [], allow: [] }
    const t = await rig({
      provider: {
        allowFrom: (podId, context, peer) => { seen.allow.push({ podId, context, peer }); return true },
        verifyRequest: (request, context, peer) => { seen.verify.push({ context, peer }); return true },
      },
      ingress: { signRequest: async () => 'x' },
    })
    assert.equal(await (await t.get('/')).text(), 'hello')
    for (const peer of [seen.allow[0].peer, seen.verify[0].peer]) {
      assert.equal(peer.podId, t.ingress.podId)
      assert.equal(peer.verified, 'none')
      assert.ok(!('keyId' in peer), 'no key id on a link that proved nothing')
      assert.ok(!('publicKey' in peer), 'no public key on a link that proved nothing')
    }
  })

  it('the old call forms keep working and are handed exactly what they were before', async () => {
    const seen = {}
    const t = await rig({
      provider: (pods) => ({
        allowFrom: function (podId, context) { seen.context = context; return podId === pods.ingress.podId },
        verifyRequest: function (request) { return request instanceof Request },
      }),
      ingress: { signRequest: async () => 'x' },
    })
    assert.equal(await (await t.get('/')).text(), 'hello')
    // the new information is an extra trailing argument: the existing context objects are not touched
    assert.deepEqual(Object.keys(seen.context).sort(), ['peer', 'protocol', 'version'])
    assert.equal(seen.context.peer, t.ingress.podId)
  })

  it('verifyRequest\'s context keeps its five members, peer still the pod id string', async () => {
    const contexts = []
    const t = await rig({ provider: { verifyRequest: (request, context) => { contexts.push(context); return true } }, ingress: { signRequest: async () => 's' } })
    assert.equal(await (await t.get('/')).text(), 'hello')
    assert.deepEqual(Object.keys(contexts[0]).sort(), ['bytes', 'nonce', 'peer', 'rid', 'sig'])
    assert.equal(contexts[0].peer, t.ingress.podId)
  })

  it('with a link-identity source that says "bound", the peer carries the pod id as its key id, and no public key it was not given', async () => {
    const seen = []
    const t = await rig({ provider: { linkIdentity: BOUND, verifyRequest: (request, context, peer) => { seen.push(peer); return true } }, ingress: { signRequest: async () => 's' } })
    await t.get('/')
    assert.equal(seen[0].verified, 'bound')
    assert.equal(seen[0].podId, t.ingress.podId)
    assert.equal(seen[0].keyId, t.ingress.podId)
    assert.ok(!('publicKey' in seen[0]))
  })

  it('a public key the source supplies is kept only when it hashes to the pod id', async () => {
    const t = await rig()
    const raw = await t.ingress.identity.rawPublicKey()
    const good = await describePeer(t.ingress.podId, { verified: 'bound', publicKey: raw })
    assert.equal(good.verified, 'bound')
    assert.deepEqual([...good.publicKey], [...raw])
    const bad = await describePeer(t.ingress.podId, { verified: 'bound', publicKey: await rawOf(await keyPair()) })
    assert.equal(bad.verified, 'none', 'a key that is not the pod id\'s key proves nothing')
    assert.ok(!('publicKey' in bad) && !('keyId' in bad))
    assert.equal((await describePeer(t.ingress.podId, { verified: 'bound', publicKey: new Uint8Array(5) })).verified, 'none')
  })

  it('a source can only narrow: an unknown word, nothing, a throw or a rejection is "none"', async () => {
    for (const [name, linkIdentity] of Object.entries({
      'an unknown word': () => ({ verified: 'yes' }),
      'the word "none" with a key': () => ({ verified: 'none', publicKey: new Uint8Array(32) }),
      'nothing': () => undefined,
      'a non-object': () => 'bound',
      'a throw': () => { throw new Error('x') },
      'a rejection': async () => { throw new Error('x') },
    })) {
      const seen = []
      const t = await rig({ provider: { linkIdentity, verifyRequest: (r, c, peer) => { seen.push(peer); return true } }, ingress: { signRequest: async () => 's' } })
      assert.equal(await (await t.get('/')).text(), 'hello', name)
      assert.equal(seen[0].verified, 'none', name)
      assert.ok(!('keyId' in seen[0]), name)
    }
  })

  it('allowFrom as a function decides on peer.verified: a link that proved nothing is refused', async () => {
    for (const [name, source, status] of [['proven', BOUND, 200], ['not proven', () => undefined, 502]]) {
      let ran = 0
      const t = await rig({ handler: () => { ran += 1; return new Response('ok') }, provider: { linkIdentity: source, allowFrom: (podId, context, peer) => peer.verified !== 'none' } })
      assert.equal((await t.get('/')).status, status, name)
      assert.equal(ran, status === 200 ? 1 : 0, name)
    }
  })

  it('rejects a link-identity source that is not a function, and a node that is not one', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    assert.throws(() => serveHttpOnMesh(pods.p, () => new Response('x'), { allowFrom: [pods.ingress.podId], linkIdentity: 'bound' }), /linkIdentity/)
    assert.throws(() => serveHttpOnMesh(pods.p, () => new Response('x'), { allowFrom: [pods.ingress.podId], node: {} }), /node/)
    assert.throws(() => createMeshIngress({ service: pods.i, resolve: () => null, linkIdentity: 5 }), /linkIdentity/)
  })

  it('exports the words it uses', () => {
    assert.deepEqual([...PEER_VERIFIED].sort(), ['bound', 'key', 'none', 'wsh'])
  })
})

describe('what a mesh node says about a link (nodeLinkIdentity)', () => {
  const node = ({ sessions = [], connections = {}, wsh } = {}) => ({
    sessionsFor: () => sessions,
    meshManager: { getConnection: (podId, connectionId) => connections[connectionId] ?? null },
    ...(wsh ? { wsh } : {}),
  })
  const rtc = (connectionId) => ({ state: 'active', transport: 'webrtc', connectionId })
  const open = (bound) => ({ isOpen: true, bound })

  it('a bound, open WebRTC connection is "bound"', () => {
    assert.deepEqual(nodeLinkIdentity(node({ sessions: [rtc('a')], connections: { a: open(true) } }))('p'), { verified: 'bound' })
  })

  it('a WebRTC connection that did not prove the pod\'s key (not bound) is not proven', () => {
    assert.equal(nodeLinkIdentity(node({ sessions: [rtc('a')], connections: { a: open(false) } }))('p'), undefined)
  })

  it('one unproven live session among proven ones is not proven (a frame may have arrived on it)', () => {
    const n = node({ sessions: [rtc('a'), rtc('b')], connections: { a: open(true), b: open(false) } })
    assert.equal(nodeLinkIdentity(n)('p'), undefined)
  })

  it('a session whose connection is gone or closed cannot carry a frame and is not counted', () => {
    const n = node({ sessions: [rtc('a'), rtc('gone'), rtc('closed')], connections: { a: open(true), closed: { isOpen: false, bound: false } } })
    assert.deepEqual(nodeLinkIdentity(n)('p'), { verified: 'bound' })
    assert.equal(nodeLinkIdentity(node({ sessions: [rtc('gone')] }))('p'), undefined, 'nothing live: nothing proven')
  })

  it('a wsh session is "wsh" while the wsh link to the pod is connected, and not otherwise', () => {
    const session = { state: 'active', transport: 'wsh', connectionId: 'default' }
    assert.deepEqual(nodeLinkIdentity(node({ sessions: [session], wsh: { links: { isConnected: () => true } } }))('p'), { verified: 'wsh' })
    assert.equal(nodeLinkIdentity(node({ sessions: [session], wsh: { links: { isConnected: () => false } } }))('p'), undefined)
    assert.equal(nodeLinkIdentity(node({ sessions: [session] }))('p'), undefined, 'a node with no wsh handle proves nothing for a wsh session')
  })

  it('a WebRTC and a wsh link at once are both key-proven: "key"', () => {
    const n = node({ sessions: [rtc('a'), { state: 'active', transport: 'wsh' }], connections: { a: open(true) }, wsh: { links: { isConnected: () => true } } })
    assert.deepEqual(nodeLinkIdentity(n)('p'), { verified: 'key' })
  })

  it('any other transport (a relay that vouches, a websocket, no transport) is not proven, and nor is no session', () => {
    for (const transport of ['websocket', 'relay', 'wsh-ws', 'webtransport', null, undefined]) {
      assert.equal(nodeLinkIdentity(node({ sessions: [{ state: 'active', transport }] }))('p'), undefined, String(transport))
    }
    assert.equal(nodeLinkIdentity(node({ sessions: [{ state: 'closed', transport: 'webrtc', connectionId: 'a' }], connections: { a: open(true) } }))('p'), undefined)
    assert.equal(nodeLinkIdentity(node())('p'), undefined)
  })

  it('refuses a node it cannot read, at once', () => {
    assert.throws(() => nodeLinkIdentity({}), /sessionsFor/)
    assert.throws(() => nodeLinkIdentity(null), /sessionsFor/)
  })

  it('serveHttpOnMesh asks the node it was given, again for each request', async () => {
    const live = { sessions: [rtc('a')], connections: { a: open(true) } }
    const seen = []
    const fake = { sessionsFor: () => live.sessions, meshManager: { getConnection: (p, c) => live.connections[c] ?? null } }
    const t = await rig({ provider: { node: fake, verifyRequest: (r, c, peer) => { seen.push(peer.verified); return true } }, ingress: { signRequest: async () => 's' } })
    await t.get('/')
    live.connections.a = open(false)
    await t.get('/')
    assert.deepEqual(seen, ['bound', 'none'])
  })
})

describe('requireLinkKey: the request\'s signer must be the link\'s key', () => {
  it('a request signed by the key of the link\'s pod is served', async () => {
    let ran = 0
    const t = await rig({
      handler: () => { ran += 1; return new Response('served') },
      provider: { linkIdentity: BOUND, verifyRequest: requireLinkKey(requestSigner) },
      ingress: (pods) => ({ signRequest: signWith(pods.ingress.identity.keyPair) }), // the key its pod id is the hash of
    })
    assert.equal(await (await t.get('/')).text(), 'served')
    assert.equal(ran, 1)
  })

  it('a request with a valid signature by some OTHER key is refused: the handler never runs, the reason is named', async () => {
    let ran = 0
    const other = await keyPair()
    const t = await rig({ handler: () => { ran += 1; return new Response('x') }, provider: { linkIdentity: BOUND, verifyRequest: requireLinkKey(requestSigner) }, ingress: { signRequest: signWith(other) } })
    const res = await t.get('/')
    assert.equal(res.status, 502)
    assert.equal(res.headers.get(REASON_HEADER), 'provider-refused-request')
    assert.equal(ran, 0)
    assert.equal(t.served.stats().refusals[LINK_KEY_REFUSALS.mismatch], 1)
    assert.ok(t.logs.some((l) => l.event === 'http:request-refused' && l.data.reason === 'link-key-mismatch' && l.data.peer === t.ingress.podId))
  })

  it('without the helper the same request is served: the signature alone shows the request is intact, not whose link it came over', async () => {
    const other = await keyPair()
    const t = await rig({ provider: { linkIdentity: BOUND, verifyRequest: async (request, context) => (await requestSigner(request, context)) !== false }, ingress: { signRequest: signWith(other) } })
    assert.equal(await (await t.get('/')).text(), 'hello')
  })

  it('a link that proved nothing is refused whatever the signature says', async () => {
    let ran = 0
    const t = await rig({
      handler: () => { ran += 1; return new Response('x') },
      provider: { verifyRequest: requireLinkKey(requestSigner) },
      ingress: (pods) => ({ signRequest: signWith(pods.ingress.identity.keyPair) }),
    })
    const res = await t.get('/')
    assert.equal(res.status, 502)
    assert.equal(ran, 0)
    assert.equal(t.served.stats().refusals[LINK_KEY_REFUSALS.linkUnverified], 1)
  })

  it('every way the signer cannot be established is a named refusal', async () => {
    const cases = {
      'signer-unverified (the check says no)': [async () => false, 'signer-unverified'],
      'signer-unverified (the check throws)': [async () => { throw new Error('x') }, 'signer-unverified'],
      'signer-key-invalid (true is not a key)': [async () => true, 'signer-key-invalid'],
      'signer-key-invalid (a key of the wrong length)': [async () => new Uint8Array(5), 'signer-key-invalid'],
      'link-key-mismatch (the key id of another pod)': [async () => 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'link-key-mismatch'],
    }
    for (const [name, [verify, reason]] of Object.entries(cases)) {
      let ran = 0
      const t = await rig({ handler: () => { ran += 1; return new Response('x') }, provider: { linkIdentity: BOUND, verifyRequest: requireLinkKey(verify) }, ingress: { signRequest: async () => 's' } })
      assert.equal((await t.get('/')).status, 502, name)
      assert.equal(ran, 0, name)
      assert.equal(t.served.stats().refusals[reason], 1, name)
    }
  })

  it('a verifier may return the key id (the pod id form) instead of the raw key', async () => {
    const t = await rig({ provider: { linkIdentity: BOUND, verifyRequest: (r, c, peer) => requireLinkKey(async () => peer.keyId)(r, c, peer) }, ingress: { signRequest: async () => 's' } })
    assert.equal(await (await t.get('/')).text(), 'hello')
  })

  it('the hash of a raw key is the pod id form', async () => {
    const identity = (await rig()).ingress.identity
    assert.equal(await podIdOfRawKey(await identity.rawPublicKey()), identity.podId)
  })

  it('is off unless used: a provider whose verifyRequest does not use it behaves as before', async () => {
    const keys = await keyPair()
    const t = await rig({ provider: { verifyRequest: async (request, context) => (await requestSigner(request, context)) !== false }, ingress: { signRequest: signWith(keys) } })
    assert.equal(await (await t.get('/')).text(), 'hello')
    assert.deepEqual(t.served.stats().refusals, {})
  })

  it('a hook that merely returns false is counted as request-unverified', async () => {
    const t = await rig({ provider: { verifyRequest: async () => false }, ingress: { signRequest: async () => 's' } })
    assert.equal((await t.get('/')).status, 502)
    assert.equal(t.served.stats().refusals['request-unverified'], 1)
  })

  it('refuses a verifier that is not a function', () => {
    assert.throws(() => requireLinkKey('yes'), /verifySigner/)
  })
})

describe('the same on the ingress side', () => {
  it('signRequest and verifyResponse get the provider link\'s peer as an extra trailing argument; their other arguments are unchanged', async () => {
    const seen = {}
    const t = await rig({
      provider: { sign: async () => 'signature' },
      ingress: {
        linkIdentity: BOUND,
        signRequest: async (bytes, info, link) => { seen.sign = { info, link }; return 's' },
        verifyResponse: async (info, link) => { seen.verify = { info, link }; return true },
      },
    })
    assert.equal(await (await t.get('/')).text(), 'hello')
    assert.deepEqual(Object.keys(seen.sign.info), ['peer'])
    assert.equal(seen.sign.link.verified, 'bound')
    assert.equal(seen.sign.link.podId, t.provider.podId)
    assert.deepEqual(Object.keys(seen.verify.info).sort(), ['bytes', 'peer', 'request', 'sig'])
    assert.equal(seen.verify.link.verified, 'bound')
    assert.equal(seen.verify.link.keyId, t.provider.podId)
  })

  it('with no source, the ingress\'s view of the provider link is "none"', async () => {
    const seen = []
    const t = await rig({ provider: { sign: async () => 'signature' }, ingress: { signRequest: async (b, i, link) => { seen.push(link); return 's' }, verifyResponse: async (info, link) => { seen.push(link); return true } } })
    await t.get('/')
    assert.deepEqual(seen.map((l) => l.verified), ['none', 'none'])
    assert.ok(seen.every((l) => !('keyId' in l)))
  })

  it('requireLinkKey binds a response\'s signer to the provider link', async () => {
    const good = await rig({
      provider: (pods) => ({ sign: signWith(pods.provider.identity.keyPair) }),
      ingress: { linkIdentity: BOUND, verifyResponse: requireLinkKey(responseSigner) },
    })
    assert.equal(await (await good.get('/')).text(), 'hello')
    const bad = await rig({ provider: { sign: signWith(await keyPair()) }, ingress: { linkIdentity: BOUND, verifyResponse: requireLinkKey(responseSigner) } })
    const res = await bad.get('/')
    assert.equal(res.status, 502)
    assert.equal(res.headers.get(REASON_HEADER), 'response-signature-invalid')
  })

  it('an ingress given a node derives the source from it', async () => {
    const [ingress, provider] = await createNodes(2)
    const p = attachService(provider, undefined, createMeshProtocolService())
    cleanups.push(() => p.teardown())
    const served = serveHttpOnMesh(p, () => new Response('ok'), { allowFrom: [ingress.podId], sign: async () => 'sig' })
    cleanups.push(() => served.stop())
    provider.registry.grantCapabilities(ingress.podId, [OPEN])
    ingress.sessionsFor = () => [{ state: 'active', transport: 'wsh' }]
    ingress.wsh = { links: { isConnected: () => true } }
    const seen = []
    const mesh = createMeshIngress({ node: ingress, resolve: () => ({ peer: provider.podId }), verifyResponse: async (info, link) => { seen.push(link.verified); return true } })
    cleanups.push(() => mesh.close())
    assert.equal(await (await mesh.handle(new Request('http://a.test/'))).text(), 'ok')
    assert.deepEqual(seen, ['wsh'])
  })

  it('an ingress given a node with no sessionsFor still works, and sees "none"', async () => {
    const [ingress, provider] = await createNodes(2)
    const p = attachService(provider, undefined, createMeshProtocolService())
    cleanups.push(() => p.teardown())
    const served = serveHttpOnMesh(p, () => new Response('ok'), { allowFrom: [ingress.podId], sign: async () => 'sig' })
    cleanups.push(() => served.stop())
    provider.registry.grantCapabilities(ingress.podId, [OPEN])
    const seen = []
    const mesh = createMeshIngress({ node: ingress, resolve: () => ({ peer: provider.podId }), verifyResponse: async (info, link) => { seen.push(link.verified); return true } })
    cleanups.push(() => mesh.close())
    assert.equal(await (await mesh.handle(new Request('http://a.test/'))).text(), 'ok')
    assert.deepEqual(seen, ['none'])
  })
})

describe('the README says what the code does', () => {
  const readme = readFile(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')
  it('its link table names every value of `verified`, and the text names every refusal reason', async () => {
    const text = await readme
    const table = /<!-- link-identity-table:begin -->\n([\s\S]*?)\n<!-- link-identity-table:end -->/.exec(text)?.[1]
    assert.ok(table, 'the README has the link-identity table')
    const named = new Set(table.split('\n').slice(2).map((row) => /^\|[^|]*\| `(\w+)` \|/.exec(row)?.[1]))
    assert.deepEqual([...named].sort(), [...PEER_VERIFIED].sort())
    for (const reason of Object.values(LINK_KEY_REFUSALS)) assert.ok(text.includes(`\`${reason}\``), `${reason} is in the README`)
  })
})
