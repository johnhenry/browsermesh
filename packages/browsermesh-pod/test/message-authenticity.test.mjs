/**
 * A receiver never takes the sender's identity from a field the sender or a
 * relay wrote: the link's own authenticated identity, or the key that signed.
 *
 * `Hub` stands in for an untrusted relay: it routes messages between pods and
 * can rewrite them, inject them, or deliver them twice.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { Pod } from '../src/pod.mjs'
import { EventEmitterTransport } from '../src/transport.mjs'
import {
  createMessage, createRpcRequest, createRpcResponse,
} from '../src/messages.mjs'
import {
  MessageSigner, ReplayGuard, ReplayWindow, verifyMessage, signedBytes, canonicalize,
  REPLAY_WINDOW, SIGNATURE_DOMAIN,
} from '../src/signed-message.mjs'

/**
 * Resolve once `pod` has decided `n` incoming messages (delivered or dropped).
 * Verification is asynchronous crypto, so the test waits for the pod's own
 * outcome events rather than for a number of event-loop turns.
 */
const decided = (pod, n) => new Promise((resolve) => {
  const count = () => pod.got.length + Object.values(pod.dropped).reduce((sum, v) => sum + v, 0)
  const check = () => { if (count() >= n) resolve() }
  pod.on('message', check)
  pod.on('message:dropped', check)
  check()
})

/** An untrusted relay between pods. */
class Hub {
  transports = new Map()
  /** (msg, toPodId) => msg[] to deliver instead */
  rewrite = (msg) => [msg]
  createTransport(podId) {
    const hub = this
    let handler = null
    const t = {
      podId,
      trust: hubTrust,
      ready: false,
      onMessage(h) { handler = h },
      async open() { t.ready = true },
      async close() { t.ready = false },
      deliver(msg) { handler?.(structuredClone(msg)) },
      send(msg) {
        const targets = msg.to && msg.to !== '*'
          ? [msg.to]
          : [...hub.transports.keys()].filter((id) => id !== podId)
        for (const id of targets) {
          const dest = hub.transports.get(id)
          if (!dest) continue
          for (const out of hub.rewrite(structuredClone(msg), id)) dest.deliver(out)
        }
      },
    }
    this.transports.set(podId, t)
    return t
  }
  inject(toPodId, msg) { this.transports.get(toPodId).deliver(msg) }
}
let hubTrust = 'untrusted'

class Recorder extends Pod {
  got = []
  _onMessage(msg) { this.got.push(msg) }
}

describe('message authenticity', () => {
  const pods = []
  afterEach(async () => {
    for (const p of pods) if (p.state === 'ready') await p.shutdown({ silent: true })
    pods.length = 0
    hubTrust = 'untrusted'
  })

  async function boot(hub, { podOpts = {}, Cls = Recorder, identity } = {}) {
    const id = identity ?? await PodIdentity.generate()
    const t = hub.createTransport(id.podId)
    const pod = new Cls()
    pods.push(pod)
    await pod.boot({
      identity: id,
      transport: t,
      globalThis: { addEventListener() {}, removeEventListener() {} },
      discoveryTimeout: 1,
      handshakeTimeout: 1,
      ...podOpts,
    })
    return pod
  }

  it('delivers a signed message with the sender taken from the key that signed', async () => {
    const hub = new Hub()
    const a = await boot(hub)
    const b = await boot(hub)
    await a.send(b.podId, { text: 'hi' })
    await decided(b, 1)
    assert.equal(b.got.length, 1)
    assert.equal(b.got[0].from, a.podId)
    assert.equal(b.got[0].authenticated, true)
    assert.deepEqual(b.got[0].payload, { text: 'hi' })
  })

  it('a relay that rewrites the sender is not believed', async () => {
    const hub = new Hub()
    const a = await boot(hub)
    const b = await boot(hub)
    const c = await boot(hub)
    hub.rewrite = (msg) => [{ ...msg, from: c.podId, source: c.podId, relaySource: c.podId }]
    await a.send(b.podId, 'from a, relabelled as c')
    await decided(b, 1)
    assert.equal(b.got.length, 0)
    assert.equal(b.dropped['sender-mismatch'], 1)
  })

  it('a relay that injects a message "from" another pod is not believed', async () => {
    const hub = new Hub()
    const a = await boot(hub)
    const b = await boot(hub)
    const mallory = await PodIdentity.generate()

    // Unsigned.
    hub.inject(b.podId, createMessage({ from: a.podId, to: b.podId, payload: 'forged, unsigned' }))
    // Signed by the relay's own key, claiming to be `a`.
    const forged = await new MessageSigner(mallory).sign(createMessage({ from: a.podId, to: b.podId, payload: 'forged, signed' }))
    hub.inject(b.podId, forged)
    // Signed correctly by the relay's key but with a's pod id swapped in afterwards.
    const own = await new MessageSigner(mallory).sign(createMessage({ from: mallory.podId, to: b.podId, payload: 'x' }))
    hub.inject(b.podId, { ...own, from: a.podId })
    await decided(b, 3)
    assert.equal(b.got.length, 0)
    assert.equal(b.dropped.unsigned, 1)
    assert.equal(b.dropped['sender-mismatch'], 2)
  })

  it('a replayed message is delivered once', async () => {
    const hub = new Hub()
    const a = await boot(hub)
    const b = await boot(hub)
    hub.rewrite = (msg) => [msg, msg, msg]
    await a.send(b.podId, 'once')
    await decided(b, 3)
    assert.equal(b.got.length, 1)
    assert.equal(b.dropped.replay, 2)
  })

  it('a tampered payload is dropped', async () => {
    const hub = new Hub()
    const a = await boot(hub)
    const b = await boot(hub)
    hub.rewrite = (msg) => [{ ...msg, payload: 'something else' }]
    await a.send(b.podId, 'original')
    await decided(b, 1)
    assert.equal(b.got.length, 0)
    assert.equal(b.dropped['bad-signature'], 1)
  })

  it('a message for another recipient is not delivered, and cannot be re-addressed', async () => {
    const hub = new Hub()
    const a = await boot(hub)
    const b = await boot(hub)
    const c = await boot(hub)
    // The relay hands b a message that a addressed to c.
    const forC = await new MessageSigner(a.identity).sign(createMessage({ from: a.podId, to: c.podId, payload: 'for c' }))
    hub.inject(b.podId, forC)
    // And re-addresses it.
    hub.inject(b.podId, { ...forC, to: b.podId })
    await decided(b, 1)
    assert.equal(b.got.length, 0)
    assert.equal(b.dropped['bad-signature'], 1)
  })

  it('a message is bound to its recipient and type: a signed message cannot be replayed as another type', async () => {
    const hub = new Hub()
    const a = await boot(hub)
    const b = await boot(hub)
    const m = await new MessageSigner(a.identity).sign(createMessage({ from: a.podId, to: b.podId, payload: { method: 'x' } }))
    hub.inject(b.podId, { ...m, type: 'pod:rpc-request', method: 'x', params: null, requestId: 'r1' })
    await decided(b, 1)
    assert.equal(b.got.length, 0)
    assert.equal(b.dropped['bad-signature'], 1)
  })

  it('an old unsigned peer: refused by default over an untrusted transport, accepted with allowUnsigned, never for rpc requests', async () => {
    const hub = new Hub()
    const strict = await boot(hub)
    const lax = await boot(hub, { podOpts: { allowUnsigned: true } })
    const old = await PodIdentity.generate()

    for (const target of [strict, lax]) {
      hub.inject(target.podId, createMessage({ from: old.podId, to: target.podId, payload: 'hello' }))
      hub.inject(target.podId, createRpcResponse({ from: old.podId, to: target.podId, requestId: 'r', result: 1 }))
      hub.inject(target.podId, createRpcRequest({ from: old.podId, to: target.podId, method: 'doThing', requestId: 'r' }))
    }
    await Promise.all([decided(strict, 3), decided(lax, 3)])
    assert.equal(strict.got.length, 0)
    assert.equal(strict.dropped.unsigned, 2)
    assert.equal(strict.dropped['unsigned-rpc'], 1)
    assert.deepEqual(lax.got.map((m) => m.type), ['pod:message', 'pod:rpc-response'])
    assert.ok(lax.got.every((m) => m.authenticated === false))
    assert.equal(lax.dropped['unsigned-rpc'], 1)
  })

  it('a same-origin transport accepts unsigned messages by default (and still never unsigned rpc requests)', async () => {
    hubTrust = 'same-origin'
    const hub = new Hub()
    const b = await boot(hub)
    const old = await PodIdentity.generate()
    hub.inject(b.podId, createMessage({ from: old.podId, to: b.podId, payload: 'hello' }))
    hub.inject(b.podId, createRpcRequest({ from: old.podId, to: b.podId, method: 'm', requestId: 'r' }))
    await decided(b, 2)
    assert.equal(b.got.length, 1)
    assert.equal(b.got[0].authenticated, false)
    assert.equal(b.dropped['unsigned-rpc'], 1)
    // ...and allowUnsigned: false turns that off.
    const strict = await boot(hub, { podOpts: { allowUnsigned: false } })
    hub.inject(strict.podId, createMessage({ from: old.podId, to: strict.podId, payload: 'hello' }))
    await decided(strict, 1)
    assert.equal(strict.got.length, 0)
    assert.equal(strict.dropped.unsigned, 1)
  })

  it('same-origin pods still talk to each other, signed, over the real in-process transport', async () => {
    const bus = EventEmitterTransport.createBus()
    const mk = async () => {
      const p = new Recorder()
      pods.push(p)
      await p.boot({ transport: new EventEmitterTransport(bus), globalThis: { addEventListener() {}, removeEventListener() {} }, discoveryTimeout: 1, handshakeTimeout: 1 })
      return p
    }
    const a = await mk()
    const b = await mk()
    await a.send(b.podId, 'x')
    await a.broadcast('y')
    await decided(b, 2)
    assert.deepEqual(b.got.map((m) => m.payload), ['x', 'y'])
    assert.ok(b.got.every((m) => m.authenticated && m.from === a.podId))
  })

  it('a link that authenticates the peer fixes the sender: a mismatching claim is dropped and counted', async () => {
    const hub = new Hub()
    const b = await boot(hub)
    // A transport that reports the authenticated identity of the link with each message.
    const t = hub.transports.get(b.podId)
    const pod = Object.getPrototypeOf(t)
    void pod
    const link = { onMessage: null }
    const linkTransport = { trust: 'untrusted', ready: true, onMessage(h) { link.onMessage = h }, async open() {}, async close() {}, send() {} }
    const c = new Recorder()
    pods.push(c)
    await c.boot({ transport: linkTransport, globalThis: { addEventListener() {}, removeEventListener() {} }, discoveryTimeout: 1, handshakeTimeout: 1 })
    link.onMessage(createMessage({ from: 'peer-1', to: c.podId, payload: 'ok' }), { peerId: 'peer-1' })
    link.onMessage(createMessage({ from: 'peer-2', to: c.podId, payload: 'lie' }), { peerId: 'peer-1' })
    await decided(c, 2)
    assert.deepEqual(c.got.map((m) => [m.from, m.payload, m.authenticated]), [['peer-1', 'ok', true]])
    assert.equal(c.dropped['sender-mismatch'], 1)
  })

  it('fields a relay adds to a signed message are not delivered', async () => {
    const hub = new Hub()
    const a = await boot(hub)
    const b = await boot(hub)
    hub.rewrite = (msg) => [{ ...msg, admin: true, source: 'x' }]
    await a.send(b.podId, 'p')
    await decided(b, 1)
    assert.equal(b.got.length, 1)
    assert.equal(b.got[0].admin, undefined)
    assert.equal(b.got[0].source, undefined)
  })

  it('signing can be turned off, and a stub identity sends unsigned', async () => {
    const hub = new Hub()
    const off = await boot(hub, { podOpts: { sign: false } })
    const lax = await boot(hub, { podOpts: { allowUnsigned: true } })
    await off.send(lax.podId, 'plain')
    await decided(lax, 1)
    assert.equal(lax.got.length, 1)
    assert.equal(lax.got[0].authenticated, false)
  })

  it('send() assigns increasing sequence numbers in one session', async () => {
    const hub = new Hub()
    const a = await boot(hub)
    const seen = []
    const spy = hub.createTransport('spy')
    void spy
    hub.rewrite = (msg) => { seen.push(msg); return [msg] }
    const b = await boot(hub)
    await Promise.all([a.send(b.podId, 1), a.send(b.podId, 2), a.send(b.podId, 3)])
    await decided(b, 3)
    const mine = seen.filter((m) => m.type === 'pod:message' && m.from === a.podId)
    // Numbers are assigned in call order; signing may finish out of order, which the window tolerates.
    assert.deepEqual(mine.map((m) => m.seq).sort(), [1, 2, 3])
    assert.equal(new Set(mine.map((m) => m.sid)).size, 1)
    assert.equal(b.got.length, 3)
  })
})

describe('signed-message primitives', () => {
  const jwk = { kty: 'OKP', crv: 'Ed25519', d: 'nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' }
  const VECTOR = {
    type: 'pod:message',
    from: 'If4x36FUomFia_hUBG_SJxt77UtqvkWqWId-9H-XIbk',
    to: 'pod-b',
    payload: { b: 2, a: [1, 'x'] },
    ts: 1700000000000,
    pk: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
    sid: 'fixed-session',
    seq: 1,
    sig: 'ufvBUJIc8XEQDnjRos16rY-A5RqCKuWBtxwFdMjBjoiLceErZtu_NN8iFgXR4wt01pm1EVn0SXmLijNn-IEgAw',
  }

  it('fixed vector: canonical bytes and signature', async () => {
    const text = new TextDecoder().decode(signedBytes(VECTOR))
    assert.equal(
      text,
      'browsermesh/pod-message/v1\n{"from":"If4x36FUomFia_hUBG_SJxt77UtqvkWqWId-9H-XIbk","payload":{"a":[1,"x"],"b":2},"pk":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo","seq":1,"sid":"fixed-session","to":"pod-b","ts":1700000000000,"type":"pod:message"}',
    )
    assert.equal(SIGNATURE_DOMAIN, 'browsermesh/pod-message/v1\n')
    const id = await PodIdentity.fromJwk(jwk, { extractable: true })
    assert.equal(id.podId, VECTOR.from)
    const signed = await new MessageSigner(id, { sessionId: 'fixed-session' }).sign({
      type: 'pod:message', from: id.podId, to: 'pod-b', payload: { b: 2, a: [1, 'x'] }, ts: 1700000000000,
    })
    assert.deepEqual(signed, VECTOR)
    const verdict = await verifyMessage(VECTOR)
    assert.equal(verdict.ok, true)
    assert.equal(verdict.from, VECTOR.from)
  })

  it('each field of the vector is covered by the signature', async () => {
    const changes = {
      to: 'pod-c', payload: { b: 2, a: [1, 'y'] }, ts: 1700000000001, sid: 'other', seq: 2,
      from: 'If4x36FUomFia_hUBG_SJxt77UtqvkWqWId-9H-XIbl',
    }
    for (const [field, value] of Object.entries(changes)) {
      const verdict = await verifyMessage({ ...VECTOR, [field]: value })
      assert.equal(verdict.ok, false, `changing ${field} must fail`)
    }
    const wrongType = await verifyMessage({ ...VECTOR, type: 'pod:rpc-response' })
    assert.equal(wrongType.ok, false)
  })

  it('refuses malformed shapes', async () => {
    for (const bad of [null, 5, {}, { type: 'pod:message' }, { ...VECTOR, sig: 'AAAA' }, { ...VECTOR, pk: 'AAAA' }, { ...VECTOR, seq: 1.5 }, { ...VECTOR, seq: '1' }, { ...VECTOR, sid: 4 }]) {
      assert.equal((await verifyMessage(bad)).ok, false)
    }
  })

  it('canonicalize sorts keys, omits undefined members, and rejects what is not JSON', () => {
    assert.equal(canonicalize({ b: 1, a: { d: [1, 2], c: undefined } }), '{"a":{"d":[1,2]},"b":1}')
    for (const bad of [NaN, Infinity, () => {}, new Date(), [undefined], 10n]) assert.throws(() => canonicalize(bad), TypeError)
  })

  it('ReplayWindow accepts each number once, tolerates reordering inside the window, refuses what is too old', () => {
    const w = new ReplayWindow()
    assert.equal(w.accept(5), true)
    assert.equal(w.accept(3), true, 'reordered but inside the window')
    assert.equal(w.accept(3), false, 'repeat')
    assert.equal(w.accept(5), false)
    assert.equal(w.accept(0), false)
    assert.equal(w.accept(1.5), false)
    assert.equal(w.accept(5 + REPLAY_WINDOW), true)
    assert.equal(w.accept(5), false, 'fell out of the window')
    assert.equal(w.accept(6), true, 'still inside: 69 - 64 = 5 < 6')
  })

  it('ReplayGuard keeps state per sender and session, and stays bounded', () => {
    const g = new ReplayGuard({ maxSenders: 3, maxSessionsPerSender: 2 })
    assert.equal(g.accept('a', 's1', 1), true)
    assert.equal(g.accept('a', 's1', 1), false)
    assert.equal(g.accept('a', 's2', 1), true, 'new session, new counter')
    assert.equal(g.accept('b', 's1', 1), true, 'another sender')
    for (const id of ['c', 'd', 'e', 'f']) g.accept(id, 's', 1)
    assert.equal(g.size, 3)
    g.accept('x', 's1', 1)
    g.accept('x', 's2', 1)
    g.accept('x', 's3', 1)
    assert.equal(g.accept('x', 's1', 1), true, 'the oldest of three sessions was forgotten (documented limit)')
  })
})
