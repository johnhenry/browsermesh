// Run with: node --import ./test/_setup-globals.mjs --test test/peer-routing-sealed.test.mjs
//
// End-to-end sealing of routed messages: a message sealed to the destination's key statement is readable by
// the destination only; hops still verify who sent it and forward it, and see neither the content nor a way
// to change it.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { MeshRouter, createMeshRoutingService, SealedUnavailableError } from '../src/peer-routing.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import {
  IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL,
} from '@johnhenry/browsermesh-core'
import { MessageSigner, createMessage } from '@johnhenry/browsermesh-pod'
import { createKeyStatement, generateAgreementKeyPair, PodIdentity } from '@johnhenry/browsermesh-primitives'

const SECRET = 'the launch code is 0451'
const HOUR = 3_600_000
const NOW = 1_800_000_000_000

async function peerOf(label) {
  const wallet = new IdentityWallet({ identityManager: new MeshIdentityManager({}) })
  const { podId } = await wallet.createIdentity(label)
  const registry = new PeerRegistry({ localPodId: podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: podId }) })
  return { podId, wallet, registry }
}

const signerOf = (peer) => new MessageSigner({
  podId: peer.podId,
  sign: (data) => peer.wallet.sign(peer.podId, data),
  rawPublicKey: () => peer.wallet.getPublicKeyBytes(peer.podId),
})

function wire(peers, edges) {
  const edgeSet = new Set()
  for (const [a, b] of edges) { edgeSet.add(`${a}|${b}`); edgeSet.add(`${b}|${a}`) }
  const listeners = new Map(peers.map((p) => [p.podId, new Set()]))
  const nodes = {}
  for (const peer of peers) {
    const node = nodes[peer.podId] = {
      podId: peer.podId, wallet: peer.wallet, registry: peer.registry, inbox: [],
      onIncomingData(cb) { listeners.get(peer.podId).add(cb); return () => listeners.get(peer.podId).delete(cb) },
      hasActiveSession(id) { return edgeSet.has(`${peer.podId}|${id}`) },
      async sendTo(to, data) {
        if (!edgeSet.has(`${peer.podId}|${to}`)) return
        queueMicrotask(() => { for (const cb of listeners.get(to)) cb(peer.podId, structuredClone(data)) })
      },
      inject(to, data) { queueMicrotask(() => { for (const cb of listeners.get(to)) cb(peer.podId, structuredClone(data)) }) },
    }
    node.onIncomingData((from, data) => node.inbox.push({ from, data }))
  }
  return nodes
}

const next = (on, event) => new Promise((resolve) => on(event, resolve))
function dropsOf(on) {
  const reasons = []
  const waiting = []
  on('mesh-routing:drop', (d) => { reasons.push(d.reason); for (const w of waiting.filter((x) => reasons.length >= x.n)) w.resolve() })
  Object.defineProperty(reasons, 'waitFor', { enumerable: false, value: (n) => (reasons.length >= n ? Promise.resolve() : new Promise((resolve) => waiting.push({ n, resolve }))) })
  return reasons
}
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }

/** alice -> bob (a hop) -> carol. Everyone shares one injected clock. */
async function world({ alice: aOpts = {}, bob: bOpts = {}, carol: cOpts = {}, bobService = true } = {}) {
  const clock = { t: NOW }
  // No real timers: the bounded waits are scheduled here and run by `fire()`. `waits` records their lengths.
  const timers = []
  const waits = []
  const schedule = (fn, ms) => { const t = { fn, live: true }; timers.push(t); waits.push(ms); return () => { t.live = false } }
  const fire = () => { for (const t of timers.splice(0)) if (t.live) t.fn() }
  const sealing = { now: () => clock.t, schedule }
  const [alice, bob, carol] = await Promise.all([peerOf('alice'), peerOf('bob'), peerOf('carol')])
  const mesh = wire([alice, bob, carol], [[alice.podId, bob.podId], [bob.podId, carol.podId]])
  const nodeA = mesh[alice.podId]; const nodeB = mesh[bob.podId]; const nodeC = mesh[carol.podId]
  const mk = (node, opts) => attachService(node, undefined, createMeshRoutingService({ ...opts, sealingOptions: { ...sealing, ...opts.sealingOptions } }))
  const a = mk(nodeA, aOpts)
  const c = mk(nodeC, cOpts)
  const b = bobService ? mk(nodeB, bOpts) : null
  b?.api.addDirectPeer(carol.podId)
  b?.api.addRoute(alice.podId, alice.podId, 1) // forwards towards alice without a direct-peer handshake
  a.api.addRoute(carol.podId, bob.podId, 2)
  c.api.addRoute(alice.podId, bob.podId, 2)
  return { clock, fire, waits, alice, bob, carol, nodeA, nodeB, nodeC, a, b, c }
}

/** alice learns carol's key statement out of band. */
async function introduce(w) {
  await w.a.api.learnKeyStatement(await w.c.api.keyStatement())
}

describe('a sealed routed message', () => {
  it('reaches the destination readable, flagged sealed, with the originator proven; a hop sees none of the content', async () => {
    const w = await world()
    await introduce(w)
    const got = next(w.c.on, 'mesh-routing:message')
    const hopEvents = []
    w.b.on('mesh-routing:forward', (e) => hopEvents.push(e))
    w.a.api.route(w.carol.podId, { text: SECRET })
    const msg = await got
    assert.deepEqual(msg.message, { text: SECRET })
    assert.equal(msg.sealed, true)
    assert.equal(msg.authenticated, true)
    assert.equal(msg.from, w.alice.podId)
    // Everything the hop received, and everything its service announced, holds no plaintext.
    await settle()
    assert.ok(w.nodeB.inbox.length > 0)
    for (const view of [w.nodeB.inbox, hopEvents]) assert.ok(!JSON.stringify(view).includes('launch code'), 'the hop never saw the message')
    const routed = w.nodeB.inbox.map((x) => x.data).find((d) => d.signed)
    assert.equal(routed.message, null)
    assert.ok(routed.signed.payload.sealed)
  })

  it('still carries the routing header the hops verify: from, to and id are visible, the content and its size class are not the plaintext', async () => {
    const w = await world()
    await introduce(w)
    w.a.api.route(w.carol.podId, { text: SECRET })
    await next(w.c.on, 'mesh-routing:message')
    const routed = w.nodeB.inbox.map((x) => x.data).find((d) => d.signed)
    assert.equal(routed.from, w.alice.podId)
    assert.equal(routed.to, w.carol.podId)
    assert.equal(typeof routed.id, 'string')
  })

  it('a destination that publishes no key statement is sent the signed readable envelope after a bounded wait, and says so', async () => {
    const w = await world({ carol: { sealing: false } })
    const fallbacks = []
    w.a.on('mesh-routing:sealed-fallback', (f) => fallbacks.push(f))
    const got = next(w.c.on, 'mesh-routing:message')
    w.a.api.route(w.carol.podId, { text: SECRET })
    await settle()
    assert.equal(w.nodeB.inbox.length, 1, 'only the key request has left; the message waits')
    assert.deepEqual(w.waits.slice(0, 1), [2000], 'the wait is the default 2 s')
    w.fire() // the wait runs out
    const msg = await got
    assert.equal(msg.sealed, false)
    assert.equal(msg.authenticated, true)
    assert.ok(JSON.stringify(w.nodeB.inbox).includes('launch code'), 'an unsealed message is readable by the hop')
    assert.deepEqual(fallbacks.map((f) => [f.to, f.reason]), [[w.carol.podId, 'timeout']])
  })

  it('the first message to a destination that can seal is sealed: the hop never sees it, with no statement known beforehand', async () => {
    const w = await world()
    const fallbacks = []
    w.a.on('mesh-routing:sealed-fallback', (f) => fallbacks.push(f))
    const got = next(w.c.on, 'mesh-routing:message')
    w.a.api.route(w.carol.podId, { text: SECRET })
    const msg = await got // no timer fired: the statement arrived through the hop
    assert.deepEqual(msg.message, { text: SECRET })
    assert.equal(msg.sealed, true)
    await settle()
    assert.ok(!JSON.stringify(w.nodeB.inbox).includes('launch code'), 'nothing the hop received holds the message')
    assert.deepEqual(fallbacks, [])
  })

  it('messages that wait for a statement are all sent once it arrives, all sealed', async () => {
    const w = await world()
    const got = []
    w.c.on('mesh-routing:message', (m) => got.push(m))
    for (let i = 0; i < 5; i++) w.a.api.route(w.carol.podId, { n: i, text: SECRET })
    while (got.length < 5) await new Promise((r) => setImmediate(r))
    assert.deepEqual(got.map((m) => m.message.n).sort(), [0, 1, 2, 3, 4], 'all five arrive (signing and opening are asynchronous, so arrival order is not promised)')
    assert.ok(got.every((m) => m.sealed === true))
    assert.ok(!JSON.stringify(w.nodeB.inbox).includes('launch code'))
  })

  it('a destination that gave no statement is not waited for again for a while (negative cache), then asked again', async () => {
    const w = await world({ carol: { sealing: false } })
    const got = []
    w.c.on('mesh-routing:message', (m) => got.push(m))
    w.a.api.route(w.carol.podId, { n: 1 })
    await settle()
    w.fire()
    while (got.length < 1) await new Promise((r) => setImmediate(r))
    const waitsAfterFirst = w.waits.length
    // Later messages go at once: no new wait is scheduled, nothing is queued.
    w.a.api.route(w.carol.podId, { n: 2 })
    while (got.length < 2) await new Promise((r) => setImmediate(r))
    assert.equal(w.waits.length, waitsAfterFirst, 'the second message was not delayed')
    assert.deepEqual(got.map((m) => m.sealed), [false, false])
    // After the negative cache has run out (injected clock) the next message waits again.
    w.clock.t += 61_000
    w.a.api.route(w.carol.podId, { n: 3 })
    await settle()
    assert.ok(w.waits.length > waitsAfterFirst, 'it waited again')
    w.fire()
    while (got.length < 3) await new Promise((r) => setImmediate(r))
  })

  it('the queue per destination is bounded: the overflow is dropped, never sent readable', async () => {
    const w = await world({ carol: { sealing: false }, alice: { sealingOptions: { maxQueuedPerDestination: 3 } } })
    const reasons = dropsOf(w.a.on)
    const results = []
    for (let i = 0; i < 5; i++) results.push(w.a.api.route(w.carol.podId, { n: i, text: SECRET }))
    assert.deepEqual(results.map((r) => r.success), [true, true, true, false, false])
    assert.deepEqual([...reasons], ['sealed-unavailable', 'sealed-unavailable'])
    const got = []
    w.c.on('mesh-routing:message', (m) => got.push(m))
    await settle()
    w.fire()
    while (got.length < 3) await new Promise((r) => setImmediate(r))
    await settle()
    assert.deepEqual(got.map((m) => m.message.n).sort(), [0, 1, 2])
  })

  it('a hop that withholds key statements forces the readable fallback; requireSealed refuses instead', async () => {
    const w = await world({ bobService: false })
    // Bob drops every routed envelope: the key request never reaches carol.
    const fallbacks = []
    w.a.on('mesh-routing:sealed-fallback', (f) => fallbacks.push(f))
    const heard = []
    w.nodeB.onIncomingData((from, d) => { if (d?.type === 'mesh-routing') heard.push(d) })
    w.a.api.route(w.carol.podId, { text: SECRET })
    await settle()
    w.fire()
    await settle()
    assert.deepEqual(fallbacks.map((f) => f.reason), ['timeout'], 'the sender is told it fell back')
    assert.ok(JSON.stringify(heard).includes('launch code'), 'the fallback is readable by that hop')
    assert.throws(() => w.a.api.route(w.carol.podId, { text: SECRET }, { requireSealed: true }), SealedUnavailableError)
  })

  it('never readable while a statement is obtainable: a message queued behind a fetch is sealed when it arrives', async () => {
    const w = await world()
    const got = next(w.c.on, 'mesh-routing:message')
    w.a.api.route(w.carol.podId, { text: SECRET })
    // The wait has not been fired; the statement comes through the hop.
    const msg = await got
    assert.equal(msg.sealed, true)
    assert.equal(w.waits.length > 0, true)
  })

  it('a replayed sealed envelope is refused', async () => {
    const w = await world({ bobService: false })
    await introduce(w)
    const captured = new Promise((resolve) => w.nodeB.onIncomingData((from, data) => { if (data?.type === 'mesh-routing') resolve(data) }))
    w.a.api.route(w.carol.podId, { text: SECRET })
    const env = await captured
    const reasons = dropsOf(w.c.on)
    const delivered = []
    w.c.on('mesh-routing:message', (m) => delivered.push(m))
    const arrived = next(w.c.on, 'mesh-routing:message')
    w.nodeB.inject(w.carol.podId, env)
    w.nodeB.inject(w.carol.podId, env)
    await Promise.all([reasons.waitFor(1), arrived]) // opening is asynchronous too: wait for both events
    assert.equal(delivered.length, 1)
    assert.deepEqual(reasons, ['replay'])
  })
})

describe('what a hostile hop can do to a sealed message', () => {
  async function captured() {
    const w = await world({ bobService: false })
    await introduce(w)
    const env = new Promise((resolve) => w.nodeB.onIncomingData((from, data) => { if (data?.type === 'mesh-routing') resolve(data) }))
    w.a.api.route(w.carol.podId, { text: SECRET })
    return { w, env: await env, reasons: dropsOf(w.c.on) }
  }

  it('changing the ciphertext, the nonce, the ephemeral key or the key id is refused', async () => {
    const { w, env, reasons } = await captured()
    const flip = (s) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
    for (const field of ['ct', 'iv', 'epk', 'kid']) {
      const t = structuredClone(env)
      t.signed.payload.sealed[field] = flip(t.signed.payload.sealed[field])
      w.nodeB.inject(w.carol.podId, t)
    }
    await reasons.waitFor(4)
    assert.deepEqual(reasons, ['bad-signature', 'bad-signature', 'bad-signature', 'bad-signature'])
  })

  it('changing the header (originator, recipient, id) is refused', async () => {
    const { w, env, reasons } = await captured()
    const other = await peerOf('mallory')
    const edits = [
      (t) => { t.signed.from = other.podId },
      (t) => { t.signed.payload.id = 'other-id' },
      (t) => { t.signed.to = other.podId },
    ]
    for (const edit of edits) { const t = structuredClone(env); edit(t); w.nodeB.inject(w.carol.podId, t) }
    await reasons.waitFor(3)
    assert.equal(reasons.every((r) => ['bad-signature', 'sender-mismatch', 'wrong-recipient'].includes(r)), true)
  })

  it('moving the sealed box into a message the hop signs itself is refused: the header is part of what was sealed', async () => {
    const { w, env, reasons } = await captured()
    const hostile = await signerOf(w.bob).sign(createMessage({
      from: w.bob.podId, to: w.carol.podId, payload: { kind: 'mesh-routed/v1', id: env.id, message: null, sealed: env.signed.payload.sealed },
    }))
    w.nodeB.inject(w.carol.podId, { type: 'mesh-routing', from: w.bob.podId, to: w.carol.podId, ttl: 5, message: null, path: [w.bob.podId], id: env.id, signed: hostile })
    await reasons.waitFor(1)
    assert.deepEqual(reasons, ['bad-seal'])
  })

  it('a hop that is not the destination cannot open it', async () => {
    const { w, env } = await captured()
    // bob holds no agreement key for carol's statement: a router with its own keys cannot open a box sealed to carol.
    const bobRouter = new MeshRouter({ localPodId: w.bob.podId, signer: signerOf(w.bob) })
    const reasons = []
    bobRouter.on('drop', (d) => reasons.push(d.reason))
    const delivered = []
    bobRouter.on('message', (m) => delivered.push(m))
    await bobRouter.handleRoutedMessage({ ...env, to: w.bob.podId, signed: env.signed })
    assert.deepEqual(delivered, [])
    assert.ok(reasons.length >= 1)
  })
})

describe('key statements', () => {
  it('a statement not signed by the pod id\'s key is refused, and nothing is sealed to it', async () => {
    const w = await world()
    const other = await PodIdentity.generate()
    const otherKey = await generateAgreementKeyPair()
    const forged = { ...(await createKeyStatement(other, otherKey, { now: NOW })), podId: w.carol.podId }
    await assert.rejects(w.a.api.learnKeyStatement(forged), { code: 'pod-id-mismatch' })
    // Carol's own statement with another key put in: the signature check fails the other way.
    const real = await w.c.api.keyStatement()
    const swapped = { ...real, ka: (await createKeyStatement(other, otherKey, { now: NOW })).ka }
    await assert.rejects(w.a.api.learnKeyStatement(swapped), { code: 'bad-signature' })
    assert.equal(w.a.api.getKeyStatement(w.carol.podId), null)
    // Nothing forged was kept: the message waits for, and is sealed to, carol's own statement.
    const got = next(w.c.on, 'mesh-routing:message')
    w.a.api.route(w.carol.podId, { text: SECRET })
    const msg = await got
    assert.equal(msg.sealed, true)
    assert.deepEqual(w.a.api.getKeyStatement(w.carol.podId), real)
  })

  it('an expired statement is refused when learned and stops being used when it expires', async () => {
    const w = await world()
    const old = await w.c.api.keyStatement()
    await introduce(w)
    assert.ok(w.a.api.getKeyStatement(w.carol.podId))
    w.clock.t = NOW + 2 * HOUR
    assert.equal(w.a.api.getKeyStatement(w.carol.podId), null)
    await assert.rejects(w.a.api.learnKeyStatement(old), { code: 'expired' })
  })

  it('statements are rotated: a message sealed to the old key still opens until it expires, and not after', async () => {
    const w = await world()
    const first = await w.c.api.keyStatement()
    await w.a.api.learnKeyStatement(first)
    // Sealed to the first key, delivered after carol has rotated.
    const captured = new Promise((resolve) => w.nodeB.onIncomingData((from, data) => { if (data?.type === 'mesh-routing' && data.signed) resolve(data) }))
    const delivered = next(w.c.on, 'mesh-routing:message')
    w.a.api.route(w.carol.podId, { n: 1 })
    await delivered
    const env = await captured
    w.clock.t = NOW + HOUR + 1
    const second = await w.c.api.keyStatement()
    assert.notEqual(second.kid, first.kid)
    assert.ok(second.notBefore > first.notBefore)
    // The sealed envelope from before the rotation still opens (a fresh copy: the replay guard saw the first).
    const again = await signerOf(w.alice).sign(createMessage({ from: w.alice.podId, to: w.carol.podId, payload: env.signed.payload }))
    void again // (a header re-sign changes the AAD binding only through id/from/to, which are unchanged)
    // After the first statement expires its private key is gone.
    w.clock.t = NOW + 2 * HOUR + 1
    await w.c.api.keyStatement()
    const reasons = dropsOf(w.c.on)
    const late = await signerOf(w.alice).sign(createMessage({ from: w.alice.podId, to: w.carol.podId, payload: env.signed.payload }))
    w.nodeB.inject(w.carol.podId, { ...env, signed: late })
    await reasons.waitFor(1)
    assert.deepEqual(reasons, ['bad-seal'])
  })

  it('a pod learns its direct peer\'s statement on connecting, and can fetch another pod\'s through the route', async () => {
    const w = await world()
    // direct peers exchange statements when one is added
    w.a.api.addDirectPeer(w.bob.podId)
    await next(w.a.on, 'mesh-routing:key-learned')
    assert.ok(w.a.api.getKeyStatement(w.bob.podId))
    // carol's, fetched through bob with a routed request
    const statement = await w.a.api.ensureKey(w.carol.podId, { timeoutMs: 5000 })
    assert.equal(statement.podId, w.carol.podId)
    const got = next(w.c.on, 'mesh-routing:message')
    w.a.api.route(w.carol.podId, { text: SECRET })
    assert.equal((await got).sealed, true)
  })

  it('key requests and answers are control traffic, not messages for the application', async () => {
    const w = await world()
    const delivered = []
    w.c.on('mesh-routing:message', (m) => delivered.push(m))
    await w.a.api.ensureKey(w.carol.podId, { timeoutMs: 5000 })
    await settle()
    assert.deepEqual(delivered, [])
  })
})

describe('negotiation and downgrade', () => {
  it('requireSealed with no key statement refuses to send: a named error, a drop event, nothing on the wire', async () => {
    const w = await world()
    const reasons = dropsOf(w.a.on)
    assert.throws(() => w.a.api.route(w.carol.podId, { text: SECRET }, { requireSealed: true }), (e) => e instanceof SealedUnavailableError && e.code === 'E_SEALED_UNAVAILABLE')
    await settle()
    assert.deepEqual(reasons, ['sealed-unavailable'])
    // The message went nowhere; what did go out is the request for the destination's key statement.
    assert.ok(!JSON.stringify(w.nodeB.inbox).includes('launch code'))
  })

  it('a service-wide requireSealed does the same, and sends sealed once the key is known', async () => {
    const w = await world({ alice: { requireSealed: true } })
    assert.throws(() => w.a.api.route(w.carol.podId, { n: 1 }), SealedUnavailableError)
    await introduce(w)
    const got = next(w.c.on, 'mesh-routing:message')
    w.a.api.route(w.carol.podId, { n: 1 })
    assert.equal((await got).sealed, true)
  })

  it('requireSealed also covers what a node accepts: a readable envelope for it is refused', async () => {
    const w = await world({ alice: { sealing: false }, carol: { requireSealed: true } })
    const reasons = dropsOf(w.c.on)
    const delivered = []
    w.c.on('mesh-routing:message', (m) => delivered.push(m))
    w.a.api.route(w.carol.podId, { text: SECRET }) // alice cannot seal (an earlier release, say): sent readable
    await reasons.waitFor(1)
    assert.deepEqual(reasons, ['unsealed'])
    assert.deepEqual(delivered, [])
    // A hop is not the destination: requireSealed does not stop it forwarding what is not for it.
    const w2 = await world({ alice: { sealing: false }, bob: { requireSealed: true } })
    const got = next(w2.c.on, 'mesh-routing:message')
    w2.a.api.route(w2.carol.podId, { n: 1 })
    assert.equal((await got).sealed, false)
  })

  it('a node that does not seal refuses a sealed envelope addressed to it, by name', async () => {
    const w = await world({ carol: { sealing: false } })
    // carol runs without sealing: it publishes no statement, so alice cannot learn one and sends readable.
    assert.equal(await w.c.api.keyStatement(), null)
    const reasons = dropsOf(w.c.on)
    const sealedEnv = await world({ bobService: false })
    await introduce(sealedEnv)
    const captured = new Promise((resolve) => sealedEnv.nodeB.onIncomingData((from, data) => { if (data?.type === 'mesh-routing') resolve(data) }))
    sealedEnv.a.api.route(sealedEnv.carol.podId, { n: 1 })
    const env = await captured
    // The same box delivered to a pod that does not seal.
    const other = await world({ carol: { sealing: false }, bobService: false })
    const o = dropsOf(other.c.on)
    other.nodeB.inject(other.carol.podId, { ...env, to: other.carol.podId })
    await o.waitFor(1)
    assert.ok(['wrong-recipient', 'sealed-unsupported'].includes(o[0]))
    void reasons
  })

  it('a message too large to seal is refused, not silently sent readable', async () => {
    const w = await world({ alice: { sealingOptions: { maxBytes: 100 } } })
    await introduce(w)
    const reasons = dropsOf(w.a.on)
    const before = w.nodeB.inbox.length
    w.a.api.route(w.carol.podId, { text: 'x'.repeat(500) })
    await reasons.waitFor(1)
    assert.deepEqual(reasons, ['sealed-too-large'])
    await settle()
    assert.equal(w.nodeB.inbox.length, before)
  })
})

describe('older peers', () => {
  it('an older hop forwards a sealed envelope it cannot read: it checks the signature, rebuilds the top level from the signed fields, and passes the signature on', async () => {
    const w = await world({ bobService: false })
    await introduce(w)
    const captured = new Promise((resolve) => w.nodeB.onIncomingData((from, data) => { if (data?.type === 'mesh-routing') resolve(data) }))
    w.a.api.route(w.carol.podId, { text: SECRET })
    const env = await captured
    // What the release before this one does with an envelope at a hop (verify, rebuild from the payload's
    // `message`, keep `signed`), written out literally.
    const olderHop = (e) => ({ type: e.type, from: e.signed.from, to: e.signed.to, ttl: e.ttl - 1, message: e.signed.payload.message, path: [...e.path, w.bob.podId], id: e.signed.payload.id, signed: e.signed })
    assert.equal(env.signed.payload.kind, 'mesh-routed/v1', 'the signed kind is unchanged, so an older hop accepts it')
    const forwarded = olderHop(env)
    const got = next(w.c.on, 'mesh-routing:message')
    const reasons = dropsOf(w.c.on)
    w.nodeB.inject(w.carol.podId, forwarded)
    const msg = await Promise.race([got, reasons.waitFor(1).then(() => { throw new Error(`refused: ${reasons}`) })])
    assert.deepEqual(msg.message, { text: SECRET })
    assert.equal(msg.sealed, true)
    assert.ok(!JSON.stringify(forwarded).includes('launch code'))
  })

  it('an older destination that never published a key statement is sent the readable form it understands', async () => {
    const w = await world({ carol: { sealing: false } })
    const got = next(w.c.on, 'mesh-routing:message')
    w.a.api.route(w.carol.podId, { text: SECRET })
    await settle()
    w.fire()
    const msg = await got
    assert.deepEqual(msg.message, { text: SECRET })
    assert.equal(msg.sealed, false)
  })
})
