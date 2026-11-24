/**
 * The window message channel accepts a message only from an expected source
 * window and origin. By default nothing is accepted from another window; what
 * is accepted but unsigned is delivered as unauthenticated.
 *
 * Fake MessageEvents: `{ data, origin, source }`.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { Pod } from '../src/pod.mjs'
import { NullTransport } from '../src/transport.mjs'
import {
  createMessage, createHello, createHelloAck,
} from '../src/messages.mjs'
import { MessageSigner } from '../src/signed-message.mjs'

const total = (pod) => Object.values(pod.dropped).reduce((sum, v) => sum + v, 0)
const refused = (pod, n) => new Promise((resolve) => {
  const check = () => { if (total(pod) >= n) resolve() }
  pod.on('message:dropped', check)
  check()
})
const next = (pod, event) => new Promise((resolve) => pod.on(event, resolve))

/** A window-like global that records its `message` listeners and can fire events at them. */
function fakeWindow({ parent = null, opener = null } = {}) {
  const listeners = new Set()
  const posted = []
  const g = {
    document: {},
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn) },
    removeEventListener(type, fn) { if (type === 'message') listeners.delete(fn) },
    postMessage() {},
    emit(event) { for (const fn of [...listeners]) fn(event) },
    posted,
  }
  g.window = g
  g.parent = parent ?? g
  g.opener = opener
  return g
}
const win = (origin) => ({ origin, postMessage() {} }) // a window other than ours

describe('window message channel', { timeout: 20000 }, () => {
  const pods = []
  afterEach(async () => {
    for (const p of pods) if (p.state === 'ready') await p.shutdown({ silent: true })
    pods.length = 0
  })

  class Recorder extends Pod {
    got = []
    _onMessage(msg) { this.got.push(msg) }
  }

  async function boot(g, opts = {}) {
    const pod = new Recorder()
    pods.push(pod)
    await pod.boot({ globalThis: g, transport: new NullTransport(), discoveryTimeout: 1, handshakeTimeout: 1, ...opts })
    return pod
  }
  const toPod = (pod, payload = 'x') => createMessage({ from: 'someone', to: pod.podId, payload })

  it('by default accepts nothing from another window, signed or not', async () => {
    const g = fakeWindow()
    const pod = await boot(g)
    const evil = win('https://evil.example')
    const other = await PodIdentity.generate()
    g.emit({ data: toPod(pod, 'unsigned'), origin: 'https://evil.example', source: evil })
    g.emit({
      data: await new MessageSigner(other).sign(createMessage({ from: other.podId, to: pod.podId, payload: 'signed' })),
      origin: 'https://evil.example',
      source: evil,
    })
    g.emit({ data: createHello({ podId: other.podId, kind: 'tab' }), origin: 'https://evil.example', source: evil })
    await refused(pod, 3)
    assert.equal(pod.dropped['window-source'], 3)
    assert.equal(pod.got.length, 0)
    assert.equal(pod.peers.size, 0)
  })

  it('accepts from an origin on the allow-list, and not from another origin', async () => {
    const g = fakeWindow()
    const pod = await boot(g, { allowUnsigned: true, window: { origins: ['https://app.example'] } })
    const delivered = next(pod, 'message')
    g.emit({ data: toPod(pod, 'no'), origin: 'https://evil.example', source: win('https://evil.example') })
    g.emit({ data: toPod(pod, 'no, null'), origin: 'null', source: win('null') })
    g.emit({ data: toPod(pod, 'no, prefix'), origin: 'https://app.example.evil.example', source: win('x') })
    g.emit({ data: toPod(pod, 'yes'), origin: 'https://app.example', source: win('https://app.example') })
    const msg = await delivered
    assert.equal(msg.payload, 'yes')
    assert.equal(pod.dropped['window-source'], 3)
    assert.deepEqual(pod.got.map((m) => m.payload), ['yes'])
    assert.equal(msg.authenticated, false, 'unsigned from a window is untrusted')
  })

  it('"null" is an origin like any other and only matches when listed', async () => {
    const g = fakeWindow()
    const pod = await boot(g, { allowUnsigned: true, window: { origins: ['null'] } })
    const delivered = next(pod, 'message')
    g.emit({ data: toPod(pod), origin: 'null', source: win('null') })
    await delivered
  })

  it('accepts from a listed source window only, whatever its origin says', async () => {
    const g = fakeWindow()
    const expected = win('https://child.example')
    const impostor = win('https://child.example') // same origin, another window
    const pod = await boot(g, { allowUnsigned: true, window: { sources: [expected] } })
    const delivered = next(pod, 'message')
    g.emit({ data: toPod(pod, 'impostor'), origin: 'https://child.example', source: impostor })
    g.emit({ data: toPod(pod, 'no source'), origin: 'https://child.example', source: null })
    g.emit({ data: toPod(pod, 'expected'), origin: 'https://child.example', source: expected })
    assert.equal((await delivered).payload, 'expected')
    assert.equal(pod.dropped['window-source'], 2)
  })

  it('when both are configured both must match', async () => {
    const g = fakeWindow()
    const expected = win('https://child.example')
    const pod = await boot(g, { allowUnsigned: true, window: { sources: [expected], origins: ['https://child.example'] } })
    const delivered = next(pod, 'message')
    g.emit({ data: toPod(pod, 'right window, wrong origin'), origin: 'https://other.example', source: expected })
    g.emit({ data: toPod(pod, 'both'), origin: 'https://child.example', source: expected })
    assert.equal((await delivered).payload, 'both')
    assert.equal(pod.dropped['window-source'], 1)
  })

  it('a signature does not make a message from the wrong window acceptable, and a signed one from the right window is authenticated', async () => {
    const g = fakeWindow()
    const expected = win('https://child.example')
    const pod = await boot(g, { window: { sources: [expected] } })
    const sender = await PodIdentity.generate()
    const signed = await new MessageSigner(sender).sign(createMessage({ from: sender.podId, to: pod.podId, payload: 'signed' }))
    g.emit({ data: signed, origin: 'https://child.example', source: win('https://child.example') })
    await refused(pod, 1)
    assert.equal(pod.got.length, 0)
    const delivered = next(pod, 'message')
    g.emit({ data: await new MessageSigner(sender).sign(createMessage({ from: sender.podId, to: pod.podId, payload: 'signed' })), origin: 'https://child.example', source: expected })
    const msg = await delivered
    assert.equal(msg.authenticated, true)
    assert.equal(msg.from, sender.podId)
  })

  it('with allowUnsigned: false an accepted window still has to sign', async () => {
    const g = fakeWindow()
    const expected = win('https://child.example')
    const pod = await boot(g, { allowUnsigned: false, window: { sources: [expected] } })
    g.emit({ data: toPod(pod), origin: 'https://child.example', source: expected })
    await refused(pod, 1)
    assert.equal(pod.dropped.unsigned, 1)
    assert.equal(pod.got.length, 0)
  })

  it('a hello from an accepted window is a peer, from another window it is not', async () => {
    const g = fakeWindow()
    const expected = win('https://child.example')
    const pod = await boot(g, { window: { sources: [expected] } })
    const child = await PodIdentity.generate()
    const stranger = await PodIdentity.generate()
    const hello = (id) => createHello({ podId: id.podId, kind: 'iframe' })
    g.emit({ data: hello(stranger), origin: 'https://child.example', source: win('https://child.example') })
    await refused(pod, 1)
    const found = next(pod, 'peer:found')
    g.emit({ data: hello(child), origin: 'https://child.example', source: expected })
    assert.equal((await found).podId, child.podId)
    assert.equal(pod.peers.has(stranger.podId), false)
  })

  describe('the handshake with the embedding parent', () => {
    it('posts its hello to the one configured origin, not to "*"', async () => {
      const parent = { postMessages: [], postMessage(m, target) { this.postMessages.push({ m, target }) } }
      const g = fakeWindow({ parent })
      await boot(g, { window: { parent: true, origins: ['https://host.example'] }, handshakeTimeout: 1 })
      assert.equal(parent.postMessages.length, 1)
      assert.equal(parent.postMessages[0].target, 'https://host.example')
      assert.equal(parent.postMessages[0].m.type, 'pod:hello')
    })

    it('an ack from the parent is accepted when the parent is the configured source; from another window it is not', async () => {
      let sawHello
      const helloPosted = new Promise((resolve) => { sawHello = resolve })
      const parent = { postMessage(m) { sawHello(m) } }
      const g = fakeWindow({ parent })
      const parentId = await PodIdentity.generate()
      const pod = new Recorder()
      pods.push(pod)
      const booting = pod.boot({
        globalThis: g, transport: new NullTransport(), discoveryTimeout: 1, handshakeTimeout: 2000,
        window: { parent: true },
      })
      const { podId } = await helloPosted
      const ack = createHelloAck({ podId: parentId.podId, kind: 'window', targetPodId: podId })
      const stranger = await PodIdentity.generate()
      const forged = createHelloAck({ podId: stranger.podId, kind: 'window', targetPodId: podId })
      g.emit({ data: forged, origin: 'https://evil.example', source: win('https://evil.example') })
      g.emit({ data: ack, origin: 'https://host.example', source: parent })
      await booting
      assert.equal(pod.role, 'child')
      assert.ok(pod.peers.has(parentId.podId))
      assert.equal(pod.peers.get(parentId.podId).role, 'parent')
      assert.ok(!pod.peers.has(stranger.podId))
      assert.equal(pod.dropped['window-source'], 1)
    })

    it('by default a pod does not take a parent from an ack alone', async () => {
      let sawHello
      const helloPosted = new Promise((resolve) => { sawHello = resolve })
      const parent = { postMessage(m) { sawHello(m) } }
      const g = fakeWindow({ parent })
      const pod = new Recorder()
      pods.push(pod)
      const booting = pod.boot({ globalThis: g, transport: new NullTransport(), discoveryTimeout: 1, handshakeTimeout: 300 })
      const { podId } = await helloPosted
      const parentId = await PodIdentity.generate()
      g.emit({
        data: createHelloAck({ podId: parentId.podId, kind: 'window', targetPodId: podId }),
        origin: 'https://host.example',
        source: parent,
      })
      await booting
      assert.notEqual(pod.role, 'child')
      assert.equal(pod.peers.size, 0)
    })
  })
})
