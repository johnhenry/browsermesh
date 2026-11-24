/**
 * Discovery messages (`pod:hello`, `pod:hello-ack`, `pod:goodbye`) are
 * attributable: a peer list entry exists only for a key that proved itself,
 * and a goodbye is honoured only from the peer it names (or from the link it
 * arrived on going down).
 *
 * `Hub` stands in for an untrusted relay: it routes messages between pods and
 * can drop, rewrite or inject them.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { Pod } from '../src/pod.mjs'
import {
  createHello, createHelloAck, createGoodbye,
  POD_HELLO, POD_HELLO_ACK, POD_GOODBYE,
} from '../src/messages.mjs'
import { MessageSigner } from '../src/signed-message.mjs'

const NO_WINDOW = { addEventListener() {}, removeEventListener() {} }
const total = (pod) => Object.values(pod.dropped).reduce((sum, v) => sum + v, 0)

/** Resolve once `pod` has refused `n` messages. */
const refused = (pod, n) => new Promise((resolve) => {
  const check = () => { if (total(pod) >= n) resolve() }
  pod.on('message:dropped', check)
  check()
})
const found = (pod, id) => pod.peers.has(id)
  ? Promise.resolve()
  : new Promise((resolve) => pod.on('peer:found', (p) => { if (p.podId === id) resolve() }))
const lost = (pod, id) => new Promise((resolve) => pod.on('peer:lost', (p) => { if (p.podId === id) resolve() }))

class Hub {
  transports = new Map()
  seen = []
  /** (msg, toPodId) => msg[] to deliver instead */
  rewrite = (msg) => [msg]
  trust = 'untrusted'
  createTransport(podId) {
    const hub = this
    let handler = null
    const t = {
      podId,
      get trust() { return hub.trust },
      ready: false,
      onMessage(h) { handler = h },
      async open() { t.ready = true },
      async close() { t.ready = false },
      deliver(msg, meta) { handler?.(structuredClone(msg), meta) },
      send(msg) {
        const targets = msg.to && msg.to !== '*'
          ? [msg.to]
          : [...hub.transports.keys()].filter((id) => id !== podId)
        for (const id of targets) {
          const dest = hub.transports.get(id)
          if (!dest) continue
          hub.seen.push(structuredClone(msg))
          for (const out of hub.rewrite(structuredClone(msg), id)) dest.deliver(out)
        }
      },
    }
    this.transports.set(podId, t)
    return t
  }
  inject(toPodId, msg, meta) { this.transports.get(toPodId).deliver(msg, meta) }
}

// The timeout only bounds a failing run: each wait is for an event that never comes without the rule.
describe('discovery authenticity', { timeout: 20000 }, () => {
  const pods = []
  afterEach(async () => {
    for (const p of pods) if (p.state === 'ready') await p.shutdown({ silent: true })
    pods.length = 0
  })

  async function boot(hub, { podOpts = {}, identity } = {}) {
    const id = identity ?? await PodIdentity.generate()
    const pod = new Pod()
    pods.push(pod)
    await pod.boot({
      identity: id,
      transport: hub.createTransport(id.podId),
      globalThis: NO_WINDOW,
      discoveryTimeout: 1,
      handshakeTimeout: 1,
      ...podOpts,
    })
    return pod
  }

  it('signed hellos let two pods find each other, and the entry says the key proved itself', async () => {
    const hub = new Hub()
    const a = await boot(hub)
    const b = await boot(hub)
    await Promise.all([found(a, b.podId), found(b, a.podId)])
    assert.equal(a.peers.get(b.podId).authenticated, true)
    assert.equal(b.peers.get(a.podId).authenticated, true)
    for (const type of [POD_HELLO, POD_HELLO_ACK]) {
      const m = hub.seen.find((x) => x.type === type)
      assert.ok(m, `a ${type} was sent`)
      assert.ok(m.pk && m.sid && m.seq && m.sig, `${type} carries pk, sid, seq and sig`)
    }
  })

  it('an unsigned hello from an unknown key over an untrusted transport adds no peer and gets no ack', async () => {
    const hub = new Hub()
    const b = await boot(hub)
    const ghost = await PodIdentity.generate()
    hub.inject(b.podId, createHello({ podId: ghost.podId, kind: 'tab' }))
    await refused(b, 1)
    assert.equal(b.dropped.unsigned, 1)
    assert.equal(b.peers.size, 0)
    assert.equal(hub.seen.filter((m) => m.type === POD_HELLO_ACK).length, 0)
  })

  it('a hello signed by one key that names another pod is refused', async () => {
    const hub = new Hub()
    const a = await boot(hub)
    const b = await boot(hub)
    await Promise.all([found(a, b.podId), found(b, a.podId)])
    const mallory = await PodIdentity.generate()
    const forged = await new MessageSigner(mallory).sign(createHello({ podId: 'someone-else', kind: 'tab' }))
    hub.inject(b.podId, forged)
    await refused(b, 1)
    assert.equal(b.dropped['sender-mismatch'], 1)
    assert.ok(!b.peers.has('someone-else'))
  })

  it('a relay that alters a signed hello is refused', async () => {
    const hub = new Hub()
    const b = await boot(hub)
    const ghost = await PodIdentity.generate()
    const hello = await new MessageSigner(ghost).sign(createHello({ podId: ghost.podId, kind: 'tab' }))
    hub.inject(b.podId, { ...hello, kind: 'worker' })
    await refused(b, 1)
    assert.equal(b.dropped['bad-signature'], 1)
    assert.equal(b.peers.size, 0)
  })

  it('a copy of a hello that was already accepted is refused', async () => {
    const hub = new Hub()
    const b = await boot(hub)
    const peer = await PodIdentity.generate()
    const hello = await new MessageSigner(peer).sign(createHello({ podId: peer.podId, kind: 'tab' }))
    hub.inject(b.podId, hello)
    hub.inject(b.podId, hello)
    await Promise.all([found(b, peer.podId), refused(b, 1)])
    assert.equal(b.dropped.replay, 1)
  })

  it('a hello-ack signed by a stranger, or addressed to another pod, adds no peer', async () => {
    const hub = new Hub()
    const b = await boot(hub)
    const mallory = await PodIdentity.generate()
    const victim = await PodIdentity.generate()
    const sign = (m) => new MessageSigner(mallory).sign(m)
    hub.inject(b.podId, await sign(createHelloAck({ podId: victim.podId, kind: 'tab', targetPodId: b.podId })))
    hub.inject(b.podId, createHelloAck({ podId: victim.podId, kind: 'tab', targetPodId: b.podId }))
    // Valid, but for somebody else: not for this pod, so not an error and not a peer.
    hub.inject(b.podId, await sign(createHelloAck({ podId: mallory.podId, kind: 'tab', targetPodId: 'not-b' })))
    await refused(b, 2)
    assert.equal(b.dropped['sender-mismatch'], 1)
    assert.equal(b.dropped.unsigned, 1)
    assert.equal(b.peers.size, 0)
  })

  it('a hello addressed to another pod is ignored', async () => {
    const hub = new Hub()
    const b = await boot(hub)
    const peer = await PodIdentity.generate()
    const hello = await new MessageSigner(peer).sign({ ...createHello({ podId: peer.podId, kind: 'tab' }), to: 'not-b' })
    hub.inject(b.podId, hello)
    // A later message that is decided shows the hello was handled first.
    hub.inject(b.podId, createGoodbye({ podId: 'x' }))
    await refused(b, 1)
    assert.equal(b.peers.size, 0)
    assert.equal(hub.seen.filter((m) => m.type === POD_HELLO_ACK).length, 0)
  })

  describe('goodbye', () => {
    async function twoPods(hub) {
      const a = await boot(hub)
      const b = await boot(hub)
      await Promise.all([found(a, b.podId), found(b, a.podId)])
      return { a, b }
    }

    it('an unsigned goodbye, or one signed by another key, does not remove the peer', async () => {
      const hub = new Hub()
      const { a, b } = await twoPods(hub)
      const mallory = await PodIdentity.generate()
      hub.inject(b.podId, createGoodbye({ podId: a.podId }))
      hub.inject(b.podId, await new MessageSigner(mallory).sign(createGoodbye({ podId: a.podId })))
      await refused(b, 2)
      assert.equal(b.dropped.unsigned, 1)
      assert.equal(b.dropped['sender-mismatch'], 1)
      assert.ok(b.peers.has(a.podId))
    })

    it('a pod that accepts unsigned messages still keeps a peer that proved itself when an unsigned goodbye names it', async () => {
      const hub = new Hub()
      const a = await boot(hub)
      const b = await boot(hub, { podOpts: { allowUnsigned: true } })
      await Promise.all([found(a, b.podId), found(b, a.podId)])
      hub.inject(b.podId, createGoodbye({ podId: a.podId }))
      // Anything decided after it shows the goodbye has been handled.
      hub.inject(b.podId, createGoodbye({ podId: 'x', to: 'not-b' }))
      hub.inject(b.podId, { type: POD_HELLO })
      await refused(b, 1)
      assert.ok(b.peers.has(a.podId))
    })

    it("the peer's own goodbye removes it, once", async () => {
      const hub = new Hub()
      const { a, b } = await twoPods(hub)
      const goodbyes = []
      hub.rewrite = (msg) => { if (msg.type === POD_GOODBYE) goodbyes.push(msg); return [msg] }
      const gone = lost(b, a.podId)
      await a.shutdown()
      await gone
      assert.ok(!b.peers.has(a.podId))
      assert.equal(goodbyes.length, 1)
      assert.ok(goodbyes[0].sig)
      // The same bytes again are a replay.
      hub.inject(b.podId, goodbyes[0])
      await refused(b, 1)
      assert.equal(b.dropped.replay, 1)
    })

    it('a goodbye left over from an earlier session of the same key does not remove the new session', async () => {
      const hub = new Hub()
      const { a, b } = await twoPods(hub)
      const kept = []
      hub.rewrite = (msg) => (msg.type === POD_GOODBYE ? (kept.push(msg), []) : [msg])
      await a.shutdown()
      hub.rewrite = (msg) => [msg]
      assert.equal(kept.length, 1)
      // The same key comes back as a new session.
      const again = await boot(hub, { identity: a.identity })
      // `again` hears b's ack only after b has recorded the new session.
      await found(again, b.podId)
      const stale = b.peers.get(a.podId)
      hub.inject(b.podId, kept[0])
      // Anything decided after it shows the goodbye has been handled.
      hub.inject(b.podId, createGoodbye({ podId: 'x' }))
      await refused(b, 1)
      assert.ok(b.peers.has(a.podId))
      assert.equal(b.peers.get(a.podId).sid, stale.sid)
    })
  })

  describe('older peers that send unsigned hellos', () => {
    const old = () => PodIdentity.generate()

    it('are accepted by default only on a same-origin transport, and marked as not authenticated', async () => {
      const hub = new Hub()
      hub.trust = 'same-origin'
      const b = await boot(hub)
      const peer = await old()
      hub.inject(b.podId, createHello({ podId: peer.podId, kind: 'tab' }))
      await found(b, peer.podId)
      assert.equal(b.peers.get(peer.podId).authenticated, false)
    })

    it('are refused over an untrusted transport unless allowUnsigned is set', async () => {
      const hub = new Hub()
      const strict = await boot(hub)
      const lax = await boot(hub, { podOpts: { allowUnsigned: true } })
      const peer = await old()
      hub.inject(strict.podId, createHello({ podId: peer.podId, kind: 'tab' }))
      hub.inject(lax.podId, createHello({ podId: peer.podId, kind: 'tab' }))
      await Promise.all([refused(strict, 1), found(lax, peer.podId)])
      assert.equal(strict.peers.has(peer.podId), false)
      assert.equal(lax.peers.get(peer.podId).authenticated, false)
    })

    it('are refused on a same-origin transport when allowUnsigned is false', async () => {
      const hub = new Hub()
      hub.trust = 'same-origin'
      const b = await boot(hub, { podOpts: { allowUnsigned: false } })
      const peer = await old()
      hub.inject(b.podId, createHello({ podId: peer.podId, kind: 'tab' }))
      await refused(b, 1)
      assert.equal(b.peers.size, 0)
    })

    it('an unsigned goodbye from one is honoured only where its hello would be', async () => {
      const hub = new Hub()
      hub.trust = 'same-origin'
      const b = await boot(hub)
      const peer = await old()
      hub.inject(b.podId, createHello({ podId: peer.podId, kind: 'tab' }))
      await found(b, peer.podId)
      const gone = lost(b, peer.podId)
      hub.inject(b.podId, createGoodbye({ podId: peer.podId }))
      await gone
    })
  })

  describe('a link that authenticates its peer', () => {
    it('takes the hello and goodbye from the link identity, with no signature, and refuses a different name', async () => {
      let deliver = null
      const link = { trust: 'untrusted', ready: true, onMessage(h) { deliver = h }, async open() {}, async close() {}, send() {} }
      const pod = new Pod()
      pods.push(pod)
      await pod.boot({ transport: link, globalThis: NO_WINDOW, discoveryTimeout: 1, handshakeTimeout: 1 })
      deliver(createHello({ podId: 'peer-1', kind: 'tab' }), { peerId: 'peer-1' })
      deliver(createHello({ podId: 'peer-2', kind: 'tab' }), { peerId: 'peer-1' })
      await Promise.all([found(pod, 'peer-1'), refused(pod, 1)])
      assert.equal(pod.dropped['sender-mismatch'], 1)
      assert.equal(pod.peers.get('peer-1').authenticated, true)
      assert.ok(!pod.peers.has('peer-2'))
      const gone = lost(pod, 'peer-1')
      // What a transport hands over when the link goes down.
      deliver(createGoodbye({ podId: 'peer-1' }), { peerId: 'peer-1' })
      await gone
    })
  })
})
