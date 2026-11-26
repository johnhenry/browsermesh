/**
 * The link admission seam: the restricted state, its cap, its deadline, one-shot promote/close, the frame cap, and the
 * WebRTC-shaped gate. Transport-neutral: a fake channel and a MockMeshTransport stand in for the links.
 *
 * Run: node --import ./test/_setup-globals.mjs --test test/link-admission.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { createLinkAdmission, createWshAdmissionAuthorize } from '../src/link-admission.mjs'
import { MockMeshTransport } from '@johnhenry/browsermesh-transport'

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, timeoutMs = 2000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await tick(2)
  }
  throw new Error(`Timed out waiting for: ${what}`)
}

/** A channel double the way a transport supplies one. */
function fakeChannel() {
  const ch = {
    sent: [], closedWith: [], adopted: 0, frameCb: null, closeCb: null,
    send(f) { ch.sent.push(f) },
    onFrame(cb) { ch.frameCb = cb },
    onClose(cb) { ch.closeCb = cb },
    close(reason) { ch.closedWith.push(reason) },
    adopt() { ch.adopted++ },
    inbound(f) { ch.frameCb?.(f) },
    peerLeaves(reason = 'peer-closed') { ch.closeCb?.(reason) },
  }
  return ch
}

function seam(extra = {}) {
  const handled = []
  const events = []
  const admission = createLinkAdmission({
    decide: () => 'restrict',
    handler: (link) => { handled.push(link) },
    onEvent: (e) => events.push(e),
    ...extra,
  })
  return { admission, handled, events }
}
const info = (channel, peerKey = 'peer-a', extra = {}) => ({ peerKey, transport: 'wsh', proven: true, channel, ...extra })

describe('createLinkAdmission: decide', () => {
  it('returns allow / deny / restrict and passes { peerKey, transport, proven }', async () => {
    const calls = []
    const { admission } = seam({ decide: (i) => { calls.push(i); return i.peerKey === 'x' ? 'allow' : i.peerKey === 'y' ? 'deny' : 'restrict' } })
    assert.equal(await admission.decide({ peerKey: 'x', transport: 'wsh', proven: true }), 'allow')
    assert.equal(await admission.decide({ peerKey: 'y', transport: 'webrtc', proven: false }), 'deny')
    assert.equal(await admission.decide({ peerKey: 'z', transport: 'wsh', proven: true }), 'restrict')
    assert.deepEqual(calls[1], { peerKey: 'y', transport: 'webrtc', proven: false })
  })

  it('an async decide works, and a throw, a rejection or a junk verdict is a deny', async () => {
    for (const decide of [async () => 'allow', () => { throw new Error('boom') }, async () => { throw new Error('boom') }, () => 'maybe', () => true, () => undefined]) {
      const { admission } = seam({ decide })
      const v = await admission.decide({ peerKey: 'p', transport: 'wsh', proven: true })
      assert.equal(v, decide.toString().includes("'allow'") ? 'allow' : 'deny')
    }
  })

  it('counts allows and denies, and fires onEvent for a denial', async () => {
    const { admission, events } = seam({ decide: () => { throw new Error('boom') } })
    await admission.decide({ peerKey: 'p', transport: 'wsh', proven: true })
    assert.equal(admission.stats().denied, 1)
    assert.equal(events.at(-1).type, 'denied')
    assert.equal(events.at(-1).peerKey, 'p')
  })

  it('refuses to be built without decide and handler', () => {
    assert.throws(() => createLinkAdmission({ handler() {} }), TypeError)
    assert.throws(() => createLinkAdmission({ decide() {} }), TypeError)
    assert.throws(() => createLinkAdmission({ decide() {}, handler() {}, maxRestricted: 0 }), TypeError)
  })
})

describe('createLinkAdmission: a restricted link', () => {
  it('hands the handler only its own frames, and the handler can send', async () => {
    const { admission, handled } = seam()
    const ch = fakeChannel()
    const r = await admission.admit(info(ch))
    assert.equal(r.state, 'restricted')
    assert.equal(handled.length, 1)
    const link = handled[0]
    assert.equal(link.peerKey, 'peer-a')
    assert.equal(link.transport, 'wsh')
    assert.equal(link.proven, true)
    const got = []
    link.onFrame((f) => got.push(f))
    ch.inbound({ type: 'x:hello' })
    assert.deepEqual(got, [{ type: 'x:hello' }])
    link.send({ type: 'x:result', ok: true })
    assert.deepEqual(ch.sent, [{ type: 'x:result', ok: true }])
    assert.equal(admission.stats().restricted, 1)
    assert.equal(ch.adopted, 0, 'nothing is adopted before promote')
  })

  it('promote() adopts once, frees the slot, and stops delivering to the handler', async () => {
    const { admission, handled, events } = seam()
    const ch = fakeChannel()
    await admission.admit(info(ch))
    const got = []
    handled[0].onFrame((f) => got.push(f))
    assert.equal(handled[0].promote(), true)
    assert.equal(ch.adopted, 1)
    assert.equal(handled[0].promote(), false, 'one shot')
    assert.equal(handled[0].close('late'), false, 'close after promote does nothing')
    assert.deepEqual(ch.closedWith, [])
    ch.inbound({ type: 'late' })
    assert.deepEqual(got, [], 'a promoted link\'s frames are the node\'s, not the handler\'s')
    assert.throws(() => handled[0].send({ x: 1 }), /not restricted/)
    assert.equal(admission.stats().restricted, 0)
    assert.equal(admission.stats().promoted, 1)
    assert.equal(events.at(-1).type, 'promoted')
  })

  it('close() closes the channel once with the reason and fires onEvent; promote after it does nothing', async () => {
    const { admission, handled, events } = seam()
    const ch = fakeChannel()
    await admission.admit(info(ch))
    assert.equal(handled[0].close('no-credential'), true)
    assert.equal(handled[0].close('again'), false)
    assert.equal(handled[0].promote(), false)
    assert.deepEqual(ch.closedWith, ['no-credential'])
    assert.equal(ch.adopted, 0)
    assert.equal(admission.stats().restricted, 0)
    assert.deepEqual(events.at(-1), { type: 'closed', peerKey: 'peer-a', transport: 'wsh', reason: 'no-credential' })
  })

  it('a peer that goes away frees the slot and tells the handler', async () => {
    const { admission, handled } = seam()
    const ch = fakeChannel()
    await admission.admit(info(ch))
    let closedWith = null
    handled[0].onClose?.((r) => { closedWith = r })
    ch.peerLeaves()
    assert.equal(admission.stats().restricted, 0)
    assert.equal(handled[0].promote(), false)
    assert.equal(closedWith, 'peer-closed')
    assert.deepEqual(ch.closedWith, [], 'nothing to close: it is already gone')
  })

  it('a handler that throws, sync or async, closes the link', async () => {
    for (const handler of [() => { throw new Error('boom') }, async () => { throw new Error('boom') }]) {
      const { admission, events } = seam({ handler })
      const ch = fakeChannel()
      await admission.admit(info(ch))
      await waitFor(() => ch.closedWith.length === 1, 1000, 'close after handler failure')
      assert.deepEqual(ch.closedWith, ['handler-error'])
      assert.equal(admission.stats().restricted, 0)
      assert.equal(events.at(-1).reason, 'handler-error')
    }
  })
})

describe('createLinkAdmission: the cap', () => {
  it('refuses a link over maxRestricted with restricted-full, without calling the handler, and counts it', async () => {
    const { admission, handled, events } = seam({ maxRestricted: 2 })
    const [a, b, c] = [fakeChannel(), fakeChannel(), fakeChannel()]
    assert.equal((await admission.admit(info(a, 'a'))).state, 'restricted')
    assert.equal((await admission.admit(info(b, 'b'))).state, 'restricted')
    const r = await admission.admit(info(c, 'c'))
    assert.deepEqual(r, { state: 'refused', reason: 'restricted-full' })
    assert.deepEqual(c.closedWith, ['restricted-full'])
    assert.equal(handled.length, 2)
    assert.equal(admission.stats().refusedFull, 1)
    assert.equal(events.at(-1).type, 'refused')
    assert.equal(events.at(-1).reason, 'restricted-full')
  })

  it('a promoted or closed link gives its slot back', async () => {
    const { admission, handled } = seam({ maxRestricted: 1 })
    await admission.admit(info(fakeChannel(), 'a'))
    assert.equal((await admission.admit(info(fakeChannel(), 'b'))).state, 'refused')
    handled[0].promote()
    assert.equal((await admission.admit(info(fakeChannel(), 'c'))).state, 'restricted')
    handled[1].close('x')
    assert.equal((await admission.admit(info(fakeChannel(), 'd'))).state, 'restricted')
  })
})

describe('createLinkAdmission: the deadline', () => {
  it('closes a link that is still restricted at deadlineMs with reason deadline, and fires onEvent', async () => {
    const { admission, handled, events } = seam({ deadlineMs: 30 })
    const ch = fakeChannel()
    await admission.admit(info(ch))
    await waitFor(() => ch.closedWith.length === 1, 1000, 'deadline')
    assert.deepEqual(ch.closedWith, ['deadline'])
    assert.deepEqual(events.at(-1), { type: 'closed', peerKey: 'peer-a', transport: 'wsh', reason: 'deadline' })
    assert.equal(admission.stats().deadlines, 1)
    assert.equal(admission.stats().restricted, 0)
    assert.equal(handled[0].promote(), false, 'too late')
  })

  it('does not close a link that was promoted in time', async () => {
    const { admission, handled } = seam({ deadlineMs: 40 })
    const ch = fakeChannel()
    await admission.admit(info(ch))
    handled[0].promote()
    await tick(80)
    assert.deepEqual(ch.closedWith, [])
    assert.equal(admission.stats().deadlines, 0)
  })
})

describe('createLinkAdmission: the frame cap', () => {
  it('drops inbound frames over maxFrameBytes (string, bytes, object), counts them, and still delivers small ones', async () => {
    const { admission, handled, events } = seam({ maxFrameBytes: 64 })
    const ch = fakeChannel()
    await admission.admit(info(ch))
    const got = []
    handled[0].onFrame((f) => got.push(f))
    ch.inbound('x'.repeat(65))
    ch.inbound(new Uint8Array(65))
    ch.inbound({ pad: 'x'.repeat(100) })
    ch.inbound('ok')
    assert.deepEqual(got, ['ok'])
    assert.equal(admission.stats().framesDropped, 3)
    assert.equal(admission.stats().framesIn, 1)
    assert.equal(events.filter((e) => e.type === 'frame-dropped').length, 3)
  })

  it('hands a text frame that is a JSON object over as the object, and anything else as it came', async () => {
    const { admission, handled } = seam()
    const ch = fakeChannel()
    await admission.admit(info(ch))
    const got = []
    handled[0].onFrame((f) => got.push(f))
    ch.inbound('{"type":"x:hello","n":1}')
    ch.inbound('[1,2]')
    ch.inbound('not json')
    ch.inbound({ already: 'object' })
    assert.deepEqual(got, [{ type: 'x:hello', n: 1 }, '[1,2]', 'not json', { already: 'object' }])
  })

  it('refuses an outbound frame over the cap and counts it', async () => {
    const { admission, handled } = seam({ maxFrameBytes: 64 })
    const ch = fakeChannel()
    await admission.admit(info(ch))
    assert.throws(() => handled[0].send({ pad: 'x'.repeat(100) }), RangeError)
    assert.deepEqual(ch.sent, [])
    handled[0].send({ ok: 1 })
    assert.equal(admission.stats().framesOut, 1)
  })
})

describe('createLinkAdmission: gate (a MeshTransport-shaped inbound link, the WebRTC path)', () => {
  async function inbound() {
    const t = new MockMeshTransport('webrtc')
    await t.connect('x')
    const peer = new MockMeshTransport('webrtc')
    await peer.connect('y')
    t.pair(peer)
    return { t, peer }
  }

  it('allow adopts at once; deny closes; neither calls the handler', async () => {
    for (const [verdict, adopted, closed] of [['allow', 1, 'connected'], ['deny', 0, 'closed']]) {
      const { admission, handled } = seam({ decide: () => verdict })
      const { t } = await inbound()
      let n = 0
      const r = await admission.gate({ peerKey: 'p', transport: 'webrtc', proven: true, adapter: t, adopt: () => { n++ } })
      assert.equal(r.state, verdict === 'allow' ? 'allowed' : 'denied')
      assert.equal(n, adopted)
      assert.equal(t.state, closed)
      assert.equal(handled.length, 0)
    }
  })

  it('restrict: the adapter carries only handler frames, the node adopts only on promote, and later frames are the node\'s', async () => {
    const seen = []
    const { admission, handled } = seam({ decide: () => 'restrict' })
    const { t, peer } = await inbound()
    const toNode = []
    let adopted = 0
    const r = await admission.gate({ peerKey: 'p', transport: 'webrtc', proven: true, adapter: t, adopt: () => { adopted++; t.onMessage((d) => toNode.push(d)) } })
    assert.equal(r.state, 'restricted')
    assert.equal(adopted, 0, 'not adopted while restricted')
    handled[0].onFrame((f) => seen.push(f))
    peer.send({ type: 'x:hello' })
    assert.deepEqual(seen, [{ type: 'x:hello' }])
    assert.deepEqual(toNode, [])
    handled[0].send({ type: 'x:ask' })
    assert.deepEqual(peer.sentMessages, [], 'peer sent nothing')
    assert.deepEqual(t.sentMessages, [{ type: 'x:ask' }], 'the only thing the node side sent is the handler\'s frame')
    handled[0].promote()
    assert.equal(adopted, 1)
    peer.send({ type: 'normal' })
    assert.deepEqual(toNode, [{ type: 'normal' }])
    assert.deepEqual(seen, [{ type: 'x:hello' }], 'the handler no longer sees frames')
  })

  it('reports proven:false to decide when the link did not prove its peer', async () => {
    const calls = []
    const { admission } = seam({ decide: (i) => { calls.push(i); return i.proven ? 'allow' : 'restrict' } })
    for (const proven of [true, false]) {
      const { t } = await inbound()
      await admission.gate({ peerKey: 'p', transport: 'webrtc', proven, adapter: t, adopt() {} })
    }
    assert.deepEqual(calls.map((c) => c.proven), [true, false])
  })

  it('restrict over the cap closes the adapter', async () => {
    const { admission } = seam({ maxRestricted: 1 })
    const one = await inbound()
    const two = await inbound()
    await admission.gate({ peerKey: 'a', transport: 'webrtc', proven: true, adapter: one.t, adopt() {} })
    const r = await admission.gate({ peerKey: 'b', transport: 'webrtc', proven: true, adapter: two.t, adopt() {} })
    assert.deepEqual(r, { state: 'refused', reason: 'restricted-full' })
    assert.equal(two.t.state, 'closed')
  })

  it('the deadline closes the adapter', async () => {
    const { admission } = seam({ deadlineMs: 30 })
    const { t } = await inbound()
    await admission.gate({ peerKey: 'a', transport: 'webrtc', proven: true, adapter: t, adopt() {} })
    await waitFor(() => t.state === 'closed', 1000, 'adapter closed at the deadline')
  })

  it('the adapter closing frees the slot', async () => {
    const { admission } = seam({ maxRestricted: 1 })
    const { t } = await inbound()
    await admission.gate({ peerKey: 'a', transport: 'webrtc', proven: true, adapter: t, adopt() {} })
    t.close()
    assert.equal(admission.stats().restricted, 0)
  })
})

describe('createWshAdmissionAuthorize', () => {
  it('keeps the inner verdict for a peer it allows, and asks decide only for the rest', async () => {
    const asked = []
    const { admission } = seam({ decide: (i) => { asked.push(i); return 'restrict' } })
    const authorize = createWshAdmissionAuthorize(admission, ({ podId }) => (podId === 'friend' ? { expires: 5 } : false))
    assert.deepEqual(await authorize({ podId: 'friend' }), { expires: 5 })
    assert.equal(asked.length, 0)
    assert.deepEqual(await authorize({ podId: 'stranger' }), { restricted: true })
    assert.deepEqual(asked, [{ peerKey: 'stranger', transport: 'wsh', proven: true }])
  })

  it('maps allow to true and deny to false, and a throw to false', async () => {
    for (const [verdict, out] of [['allow', true], ['deny', false]]) {
      const { admission } = seam({ decide: () => verdict })
      assert.equal(await createWshAdmissionAuthorize(admission, () => false)({ podId: 's' }), out)
    }
    const { admission } = seam({ decide: () => { throw new Error('x') } })
    assert.equal(await createWshAdmissionAuthorize(admission, () => false)({ podId: 's' }), false)
  })

  it('an inner authorizer that throws is a deny, as in wsh-links', async () => {
    const { admission } = seam({ decide: () => 'allow' })
    assert.equal(await createWshAdmissionAuthorize(admission, () => { throw new Error('x') })({ podId: 's' }), false)
  })
})
