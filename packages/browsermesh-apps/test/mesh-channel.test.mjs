/**
 * mesh-channel: a message-oriented duplex channel beside mesh-rpc.
 *
 * Two in-memory peers whose transport crosses a JSON boundary (as real
 * transports do). Nothing here depends on wall-clock timing: every wait is on
 * a promise, and "has it settled" questions are answered by draining the task
 * queue, not by sleeping.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { network } from './helpers/rpc-network.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshRpcService } from '../src/mesh-rpc.mjs'
import {
  createMeshChannelService, createChannelCore, MeshChannelError, ChannelErrorCode,
  CHANNEL_ENVELOPE_TYPE, CHANNEL_DEFAULT_MAX_MESSAGE_BYTES,
} from '../src/mesh-channel.mjs'
import { encodeValue, decodeValue, toBase64 } from '../src/internal/channel-codec.mjs'

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }

/** Record every envelope a node sends (before the JSON boundary). */
function spy(node) {
  const sent = []
  const original = node.sendTo.bind(node)
  node.sendTo = (id, message) => { sent.push({ to: id, message }); return original(id, message) }
  return sent
}

/** Decoded payload bytes of every data chunk in a spy log. */
const chunkBytesOn = sent => sent.filter(s => s.message.k === 'd').reduce((n, s) => n + atob(s.message.f).length, 0)

async function pair(optionsA = {}, optionsB = {}) {
  const [alice, bob, eve] = await network()
  const linksOnB = []
  const linkB = deferred()
  const a = attachService(alice, undefined, createMeshChannelService(optionsA))
  const b = attachService(bob, undefined, createMeshChannelService({ ...optionsB, onLink: link => { linksOnB.push(link); optionsB.onLink?.(link); linkB.resolve(link) } }))
  const teardown = () => { a.teardown(); b.teardown() }
  return { alice, bob, eve, a, b, linksOnB, linkB: linkB.promise, teardown }
}

// ------------------------------------------------------------------ codec

test('codec round-trips nested values, native bytes, integers and floats', () => {
  const value = { s: 'héllo ✓', n: [0, -1, 1, 2 ** 40, -(2 ** 40), 1.5, -0.25], b: new Uint8Array([0, 255, 128]), nested: { t: true, f: false, nil: null, empty: new Uint8Array(0), list: [new Uint8Array([1]), 'x'] } }
  const out = decodeValue(encodeValue(value))
  assert.deepEqual(out, value)
  assert.ok(out.b instanceof Uint8Array && out.nested.empty instanceof Uint8Array)
  assert.ok(Object.is(decodeValue(encodeValue(-0)), -0))
  // A view onto part of a larger buffer encodes only its own bytes.
  assert.deepEqual(decodeValue(encodeValue(new Uint8Array([9, 8, 7, 6]).subarray(1, 3))), new Uint8Array([8, 7]))
})

test('codec refuses what it cannot represent and what a malformed frame claims', () => {
  for (const bad of [NaN, Infinity, () => {}, Symbol('x'), 1n, new Date(), new Map()]) assert.throws(() => encodeValue(bad), TypeError)
  const cyclic = {}; cyclic.self = cyclic
  assert.throws(() => encodeValue(cyclic), /cyclic/)
  let deep = []; for (let i = 0; i < 40; i++) deep = [deep]
  assert.throws(() => encodeValue(deep), /deeply/)
  // A length claiming more bytes than the frame holds is refused before anything is allocated.
  assert.throws(() => decodeValue(Uint8Array.of(6, 0xff, 0xff, 0xff, 0x7f)), RangeError)
  assert.throws(() => decodeValue(Uint8Array.of(7, 0xff, 0xff, 0xff, 0x7f)), RangeError)
  assert.throws(() => decodeValue(Uint8Array.of(0, 0)), /trailing/)
  assert.throws(() => decodeValue(Uint8Array.of(99)), /unknown tag/)
  assert.throws(() => decodeValue(new Uint8Array(0)), /truncated/)
  const proto = decodeValue(encodeValue(JSON.parse('{"__proto__":{"polluted":true}}')))
  assert.equal({}.polluted, undefined)
  assert.equal(Object.getPrototypeOf(proto), Object.prototype)
})

// ------------------------------------------------------- requests both ways

test('requests flow in both directions; ids are unique per direction and never cross-routed', async () => {
  const { alice, bob, a, b, linkB, teardown } = await pair()
  try {
    const seenOnB = [], seenOnA = []
    const linkA = await a.api.open(bob.podId)
    const lb = await linkB
    lb.onRequest('who', async (params, ctx) => { seenOnB.push(ctx.id); return { you: ctx.peer, n: params.n } })
    linkA.onRequest('who', async (params, ctx) => { seenOnA.push(ctx.id); return { you: ctx.peer, n: params.n * 10 } })
    const results = await Promise.all([
      linkA.request('who', { n: 1 }), lb.request('who', { n: 1 }),
      linkA.request('who', { n: 2 }), lb.request('who', { n: 2 }),
    ])
    assert.deepEqual(results, [{ you: alice.podId, n: 1 }, { you: bob.podId, n: 10 }, { you: alice.podId, n: 2 }, { you: bob.podId, n: 20 }])
    assert.deepEqual(seenOnB, [1, 2])
    assert.deepEqual(seenOnA, [1, 2]) // same numbers, a separate namespace per direction
  } finally { teardown() }
})

test('an unknown method is a clean -32601 and a throwing handler is -32603; neither breaks the link', async () => {
  const { bob, a, linkB, teardown } = await pair()
  try {
    const linkA = await a.api.open(bob.podId)
    ;(await linkB).onRequest('boom', () => { throw new Error('nope') })
    await assert.rejects(linkA.request('missing'), { code: ChannelErrorCode.METHOD_NOT_FOUND })
    await assert.rejects(linkA.request('boom'), { code: ChannelErrorCode.INTERNAL, message: 'nope' })
    ;(await linkB).onRequest('ok', () => 'fine')
    assert.equal(await linkA.request('ok'), 'fine')
  } finally { teardown() }
})

test('a handler can throw a MeshChannelError with its own code and data', async () => {
  const { bob, a, linkB, teardown } = await pair()
  try {
    const linkA = await a.api.open(bob.podId)
    ;(await linkB).onRequest('deny', () => { throw new MeshChannelError(ChannelErrorCode.UNAUTHORIZED, 'denied', 'not for you', { scope: 'x' }) })
    await assert.rejects(linkA.request('deny'), e => e.code === -32003 && e.reason === 'denied' && e.data.scope === 'x')
  } finally { teardown() }
})

// ---------------------------------------------------- notifications, progress

test('notifications and raw messages travel both ways; raw messages arrive in order', async () => {
  const { bob, a, linkB, teardown } = await pair()
  try {
    const linkA = await a.api.open(bob.podId)
    const lb = await linkB
    const gotOnB = [], gotOnA = [], rawOnB = []
    lb.onNotification('ping', (p, ctx) => gotOnB.push([p, ctx.peer]))
    linkA.onNotification('pong', p => gotOnA.push(p))
    lb.onMessage(v => { rawOnB.push(v) })
    await linkA.notify('ping', { i: 1 })
    await lb.notify('pong', new Uint8Array([1, 2, 3]))
    for (let i = 0; i < 5; i++) await linkA.send({ i, bytes: new Uint8Array([i]) })
    await flush()
    assert.equal(gotOnB.length, 1)
    assert.deepEqual(gotOnB[0][0], { i: 1 })
    assert.deepEqual(gotOnA, [new Uint8Array([1, 2, 3])])
    assert.deepEqual(rawOnB.map(v => v.i), [0, 1, 2, 3, 4])
    assert.ok(rawOnB[0].bytes instanceof Uint8Array)
  } finally { teardown() }
})

test('progress values reach the caller of that request only, before the final result', async () => {
  const { bob, a, linkB, teardown } = await pair()
  try {
    const linkA = await a.api.open(bob.podId)
    ;(await linkB).onRequest('count', async (p, { progress }) => { for (let i = 1; i <= p.to; i++) await progress({ i, chunk: new Uint8Array([i]) }); return 'done' })
    const one = [], two = []
    const [r1, r2] = await Promise.all([
      linkA.request('count', { to: 3 }, { onProgress: v => one.push(v) }),
      linkA.request('count', { to: 2 }, { onProgress: v => two.push(v) }),
    ])
    assert.deepEqual([r1, r2], ['done', 'done'])
    assert.deepEqual(one.map(v => v.i), [1, 2, 3])
    assert.deepEqual(two.map(v => v.i), [1, 2])
    assert.ok(one[0].chunk instanceof Uint8Array)
  } finally { teardown() }
})

// ------------------------------------------------------------------- binary

test('Uint8Array values survive end to end, including empty, views and multi-chunk sizes', async () => {
  const { bob, a, linkB, teardown } = await pair({ chunkBytes: 1024 }, { chunkBytes: 1024 })
  try {
    const linkA = await a.api.open(bob.podId)
    ;(await linkB).onRequest('echo', p => p)
    const big = new Uint8Array(300_000).map((_, i) => (i * 31) & 255)
    for (const bytes of [new Uint8Array(0), new Uint8Array([0, 255, 254]), new Uint8Array([1, 2, 3, 4]).subarray(1, 3), big]) {
      const out = await linkA.request('echo', { bytes, list: [bytes] })
      assert.ok(out.bytes instanceof Uint8Array && out.list[0] instanceof Uint8Array)
      assert.deepEqual(out.bytes, bytes)
    }
  } finally { teardown() }
})

test('the wire carries only chunk frames of bounded size, never the whole message in one frame', async () => {
  const { alice, bob, a, linkB, teardown } = await pair({ chunkBytes: 2048 }, { chunkBytes: 2048 })
  try {
    const sent = spy(alice)
    const linkA = await a.api.open(bob.podId)
    ;(await linkB).onRequest('len', p => p.length)
    assert.equal(await linkA.request('len', new Uint8Array(100_000)), 100_000)
    const chunks = sent.filter(s => s.message.k === 'd')
    assert.ok(chunks.length > 40)
    for (const c of chunks) assert.ok(c.message.f.length <= 4 * Math.ceil(2048 / 3))
  } finally { teardown() }
})

// ------------------------------------------------------------------- cancel

test('the caller cancels: the callee handler signal aborts and the late result is dropped', async () => {
  const { bob, a, linkB, teardown } = await pair()
  try {
    const linkA = await a.api.open(bob.podId)
    const started = deferred(), finish = deferred()
    let signal
    ;(await linkB).onRequest('slow', async (_p, ctx) => { signal = ctx.signal; started.resolve(); await finish.promise; return 'late' })
    const ac = new AbortController()
    const call = linkA.request('slow', {}, { signal: ac.signal })
    const rejected = assert.rejects(call, { code: ChannelErrorCode.CANCELLED, reason: 'cancelled' })
    await started.promise
    ac.abort()
    await rejected
    await flush()
    assert.equal(signal.aborted, true)
    finish.resolve()
    await flush()
    assert.equal(linkA.stats().pendingRequests, 0)
    ;(await linkB).onRequest('next', () => 'still works')
    assert.equal(await linkA.request('next'), 'still works')
  } finally { finish_all(); teardown() }
  function finish_all() {}
})

test('the callee side can cancel too: a request issued from the accepting side aborts its handler on the caller', async () => {
  const { bob, a, linkB, teardown } = await pair()
  try {
    const linkA = await a.api.open(bob.podId)
    const lb = await linkB
    const started = deferred(), finish = deferred()
    let signal
    linkA.onRequest('slow', async (_p, ctx) => { signal = ctx.signal; started.resolve(); await finish.promise; return 'late' })
    const ac = new AbortController()
    const call = lb.request('slow', {}, { signal: ac.signal })
    const rejected = assert.rejects(call, { reason: 'cancelled' })
    await started.promise
    ac.abort()
    await rejected
    await flush()
    assert.equal(signal.aborted, true)
    finish.resolve()
    await flush()
    assert.equal(lb.stats().pendingRequests, 0)
  } finally { teardown() }
})

test('an already-aborted request is never sent, and a timeout cancels the callee', async () => {
  const { alice, bob, a, linkB, teardown } = await pair()
  try {
    const sent = spy(alice)
    const linkA = await a.api.open(bob.podId)
    const before = sent.length
    const ac = new AbortController(); ac.abort()
    await assert.rejects(linkA.request('x', {}, { signal: ac.signal }), { reason: 'cancelled' })
    assert.equal(sent.length, before)
    const started = deferred(); let signal
    ;(await linkB).onRequest('hang', (_p, ctx) => { signal = ctx.signal; started.resolve(); return new Promise(() => {}) })
    await assert.rejects(linkA.request('hang', {}, { timeoutMs: 20 }), { reason: 'timeout' })
    await flush()
    assert.equal(signal.aborted, true)
  } finally { teardown() }
})

test('a peer without a link cannot cancel, answer or message another peer\'s requests', async () => {
  const { alice, bob, eve, a, b, linkB, teardown } = await pair()
  try {
    const linkA = await a.api.open(bob.podId)
    const started = deferred(), finish = deferred()
    let signal
    ;(await linkB).onRequest('slow', async (_p, ctx) => { signal = ctx.signal; started.resolve(); await finish.promise; return 'genuine' })
    const call = linkA.request('slow')
    await started.promise
    // Eve has no link with either: a cancel to bob and a response to alice that reuse request id 1 belong to no link of hers.
    await eve.sendTo(bob.podId, { type: CHANNEL_ENVELOPE_TYPE, k: 'x', id: 1 })
    const answer = encodeValue({ t: 'r', id: 1, v: 'from eve' })
    await eve.sendTo(alice.podId, { type: CHANNEL_ENVELOPE_TYPE, k: 'd', m: 1, i: 0, n: answer.length, f: toBase64(answer) })
    await flush()
    assert.equal(signal.aborted, false)
    finish.resolve()
    assert.equal(await call, 'genuine')
    assert.deepEqual(b.api.peers, [alice.podId])
  } finally { teardown() }
})

// --------------------------------------------------------- verified identity

test('every handler is handed the session\'s peer key; message contents cannot change it', async () => {
  const { alice, bob, eve, a, b, linkB, teardown } = await pair()
  const e = attachService(eve, undefined, createMeshChannelService())
  try {
    const seen = []
    b.api.onLink(link => {
      link.onRequest('id', (p, ctx) => { seen.push(['req', ctx.peer, link.peer]); return ctx.peer })
      link.onNotification('note', (p, ctx) => seen.push(['note', ctx.peer]))
      link.onMessage((v, ctx) => { seen.push(['msg', ctx.peer]) })
    })
    const la = await a.api.open(bob.podId)
    const le = await e.api.open(bob.podId)
    await linkB
    const claim = { peer: alice.podId, from: alice.podId, fromPubKey: alice.podId }
    assert.equal(await le.request('id', claim), eve.podId)
    assert.equal(await la.request('id', claim), alice.podId)
    await le.notify('note', claim); await le.send(claim)
    await flush()
    for (const row of seen.filter(r => r[1] !== alice.podId)) assert.equal(row[1], eve.podId)
    assert.deepEqual(seen.filter(r => r[0] === 'req'), [['req', eve.podId, eve.podId], ['req', alice.podId, alice.podId]])
    assert.deepEqual(seen.filter(r => r[0] !== 'req').map(r => r[1]), [eve.podId, eve.podId])
  } finally { e.teardown(); teardown() }
})

// ------------------------------------------------------- size negotiation

test('the maximum message size is the smaller of the two sides and is refused locally before anything is sent', async () => {
  const { alice, bob, a, linkB, teardown } = await pair({ maxMessageBytes: 64 * 1024 }, { maxMessageBytes: 8 * 1024, window: 64 * 1024 })
  try {
    const sent = spy(alice)
    const linkA = await a.api.open(bob.podId)
    assert.equal(linkA.maxMessageBytes, 8 * 1024)
    assert.equal((await linkB).maxMessageBytes, 8 * 1024)
    const before = sent.length
    await assert.rejects(linkA.send(new Uint8Array(9000)), { code: ChannelErrorCode.TOO_LARGE })
    await assert.rejects(linkA.request('m', new Uint8Array(9000)), { code: ChannelErrorCode.TOO_LARGE })
    await assert.rejects(linkA.notify('m', new Uint8Array(9000)), { code: ChannelErrorCode.TOO_LARGE })
    assert.equal(sent.length, before) // not one frame left for it
    assert.equal(linkA.stats().pendingRequests, 0)
  } finally { teardown() }
})

test('a message announced over the limit is refused from its first chunk: nothing is assembled, held or delivered', async () => {
  const { alice, bob, a, b, linkB, teardown } = await pair({}, { maxMessageBytes: 4096 })
  try {
    const got = []
    const aborted = deferred()
    alice.onIncomingData((_from, text) => { const f = JSON.parse(text); if (f.k === 'a') aborted.resolve(f) })
    const lb = await (async () => { await a.api.open(bob.podId); return linkB })()
    ;(await lb).onMessage(v => { got.push(v) })
    // A peer that ignores the negotiated limit: announce 1 MiB, send only the first 1 KiB chunk.
    const chunk = toBase64(new Uint8Array(1024))
    await alice.sendTo(bob.podId, { type: CHANNEL_ENVELOPE_TYPE, k: 'd', m: 77, i: 0, n: 1024 * 1024, f: chunk })
    const frame = await aborted.promise
    assert.equal(frame.m, 77)
    assert.equal(frame.c, ChannelErrorCode.TOO_LARGE)
    // The rest of the refused message is dropped unbuffered, and its credit handed back.
    await alice.sendTo(bob.podId, { type: CHANNEL_ENVELOPE_TYPE, k: 'd', m: 77, i: 1, f: chunk })
    await flush()
    assert.equal((await lb).stats().heldBytes, 0)
    assert.deepEqual(got, [])
    // The link survives: a normal message after it is delivered.
    const linkA = a.api.link(bob.podId)
    await linkA.send('after')
    await flush()
    assert.deepEqual(got, ['after'])
    assert.ok(b.api.link(alice.podId))
  } finally { teardown() }
})

test('a sender that overruns the credit it was granted has its link closed', async () => {
  const { alice, bob, a, b, linkB, teardown } = await pair({}, { window: 8192, maxMessageBytes: 4096, chunkBytes: 4096 })
  try {
    await a.api.open(bob.podId)
    const lb = await linkB
    const closed = deferred(); lb.onClose(e => closed.resolve(e))
    lb.onMessage(() => new Promise(() => {})) // a reader that never gives credit back
    // Three whole 4 KiB messages against an 8 KiB window, sent without waiting for credit.
    const message = encodeValue({ t: 'm', b: new Uint8Array(4084) })
    assert.equal(message.length, 4096)
    for (const m of [1, 2, 3]) await alice.sendTo(bob.podId, { type: CHANNEL_ENVELOPE_TYPE, k: 'd', m, i: 0, n: message.length, f: toBase64(message) })
    const e = await closed.promise
    assert.equal(e.reason, 'protocol-violation')
    assert.equal(b.api.link(alice.podId), undefined)
  } finally { teardown() }
})

// ------------------------------------------------------------ flow control

test('a slow reader bounds the sender: at most one window of bytes is ever in flight, and everything arrives in order once it reads', async () => {
  const WINDOW = 64 * 1024
  const options = { window: WINDOW, maxMessageBytes: 16 * 1024, chunkBytes: 4096 }
  const { alice, bob, a, linkB, teardown } = await pair(options, options)
  try {
    const sent = spy(alice)
    const linkA = await a.api.open(bob.podId)
    const lb = await linkB
    const gate = deferred()
    const delivered = []
    lb.onMessage(async v => { delivered.push(v.i); await gate.promise })
    const total = 200, size = 8 * 1024
    const sends = []
    for (let i = 0; i < total; i++) sends.push(linkA.send({ i, pad: new Uint8Array(size) }))
    await flush()
    // The reader is stuck inside its first callback. Count what actually went on the wire.
    const wireBytes = chunkBytesOn(sent)
    assert.ok(wireBytes <= WINDOW, `sender put ${wireBytes} bytes on the wire against a ${WINDOW} byte window`)
    assert.ok(lb.stats().heldBytes <= WINDOW)
    assert.equal(delivered.length, 1)
    // Everything else is queued on the sender, not in the receiver, and its sends are still pending.
    assert.ok(linkA.stats().queuedBytes >= (total - 9) * size)
    gate.resolve()
    await Promise.all(sends)
    await flush()
    assert.deepEqual(delivered, Array.from({ length: total }, (_, i) => i))
    assert.equal(lb.stats().heldBytes, 0)
    assert.equal(linkA.stats().creditBytes, WINDOW)
  } finally { teardown() }
})

test('credit is counted in bytes: many tiny messages and few large ones are held to the same limit', async () => {
  const WINDOW = 32 * 1024
  const options = { window: WINDOW, maxMessageBytes: 8 * 1024, chunkBytes: 1024 }
  const { alice, bob, a, linkB, teardown } = await pair(options, options)
  try {
    const sent = spy(alice)
    const linkA = await a.api.open(bob.podId)
    const lb = await linkB
    const gate = deferred()
    lb.onMessage(async () => { await gate.promise })
    const sends = []
    for (let i = 0; i < 3000; i++) sends.push(linkA.send(new Uint8Array(16))) // 3000 small messages
    await flush()
    assert.ok(chunkBytesOn(sent) <= WINDOW)
    gate.resolve()
    await Promise.all(sends)
  } finally { teardown() }
})

test('a slow request handler does not hold credit: responses and cancels still flow', async () => {
  const options = { window: 32 * 1024, maxMessageBytes: 8 * 1024, chunkBytes: 1024 }
  const { bob, a, linkB, teardown } = await pair(options, options)
  try {
    const linkA = await a.api.open(bob.podId)
    const lb = await linkB
    const never = new Promise(() => {})
    lb.onRequest('hang', () => never)
    lb.onRequest('fast', () => 'fast')
    const hangs = Array.from({ length: 10 }, () => linkA.request('hang', new Uint8Array(4000), { timeoutMs: 60000 }).catch(() => {}))
    assert.equal(await linkA.request('fast'), 'fast')
    assert.equal(lb.stats().heldBytes, 0)
    linkA.close()
    await Promise.all(hangs)
  } finally { teardown() }
})

// ----------------------------------------------------------------- bounds

test('in-flight requests are bounded per peer', async () => {
  const { alice, bob, a, linkB, teardown } = await pair({ maxInflight: 100 }, { maxInflight: 2 })
  try {
    const linkA = await a.api.open(bob.podId)
    const lb = await linkB
    const release = deferred()
    lb.onRequest('hold', () => release.promise)
    const first = [linkA.request('hold'), linkA.request('hold')]
    await flush()
    const sent = spy(alice)
    await assert.rejects(linkA.request('hold'), { code: ChannelErrorCode.BUSY })
    assert.equal(sent.length, 0) // refused at the caller, nothing sent
    release.resolve()
    await Promise.all(first)
    assert.equal(await linkA.request('hold'), undefined) // room again
  } finally { teardown() }
})

test('the accepting side refuses a request beyond its own in-flight limit', async () => {
  // Drive one core by hand so the caller does not apply the limit it negotiated.
  const sent = []
  const b = createChannelCore({ peer: 'caller', maxInflight: 1, sendFrame: f => { sent.push(f) } })
  const release = deferred()
  b.link.onRequest('hold', () => release.promise)
  const hello = { k: 'hello', sid: 'x', v: 1, min: 1, maxMessageBytes: 1024, window: 65536, maxInflight: 10, chunkBytes: 1024 }
  b.receive(hello)
  const requestFrame = (id) => { const bytes = encodeValue({ t: 'q', id, m: 'hold', p: null }); return { k: 'd', m: id, i: 0, n: bytes.length, f: toBase64(bytes) } }
  b.receive(requestFrame(1)); b.receive(requestFrame(2))
  await flush()
  const responses = sent.filter(f => f.k === 'd').map(f => decodeValue(Uint8Array.from(atob(f.f), c => c.charCodeAt(0))))
  assert.equal(responses.length, 1)
  assert.equal(responses[0].id, 2)
  assert.equal(responses[0].e.c, ChannelErrorCode.BUSY)
  release.resolve()
})

// -------------------------------------------------------------------- close

test('close rejects every pending request on both sides, aborts handlers, fires onClose, and refuses new work', async () => {
  const { bob, a, linkB, teardown } = await pair()
  try {
    const linkA = await a.api.open(bob.podId)
    const lb = await linkB
    const started = deferred(); let signal
    lb.onRequest('hang', (_p, ctx) => { signal = ctx.signal; started.resolve(); return new Promise(() => {}) })
    linkA.onRequest('hang', () => new Promise(() => {}))
    const closedA = deferred(), closedB = deferred()
    linkA.onClose(e => closedA.resolve(e)); lb.onClose(e => closedB.resolve(e))
    const fromA = linkA.request('hang'), fromB = lb.request('hang')
    const r1 = assert.rejects(fromA, { code: ChannelErrorCode.CANCELLED, reason: 'channel-closed' })
    const r2 = assert.rejects(fromB, { code: ChannelErrorCode.CANCELLED, reason: 'channel-closed' })
    await started.promise
    lb.close()
    await Promise.all([r1, r2])
    assert.equal(signal.aborted, true)
    assert.equal((await closedA.promise).reason, 'channel-closed')
    await closedB.promise
    await assert.rejects(linkA.request('hang'), { reason: 'channel-closed' })
    await assert.rejects(linkA.send(1), { reason: 'channel-closed' })
    assert.equal(a.api.link(bob.podId), undefined)
  } finally { teardown() }
})

test('queued sends are rejected on close and onClose fires immediately for a closed link', async () => {
  const options = { window: 4096, maxMessageBytes: 4096, chunkBytes: 1024 }
  const { bob, a, linkB, teardown } = await pair(options, options)
  try {
    const linkA = await a.api.open(bob.podId)
    ;(await linkB).onMessage(() => new Promise(() => {}))
    const sends = Array.from({ length: 10 }, () => linkA.send(new Uint8Array(2000)).then(() => 'sent', e => e.reason))
    await flush()
    linkA.close()
    const outcomes = await Promise.all(sends)
    assert.ok(outcomes.includes('channel-closed'))
    const late = deferred(); linkA.onClose(e => late.resolve(e))
    assert.equal((await late.promise).reason, 'channel-closed')
  } finally { teardown() }
})

test('service teardown closes every link and rejects what is pending', async () => {
  const { bob, a, linkB, teardown } = await pair()
  try {
    const linkA = await a.api.open(bob.podId)
    ;(await linkB).onRequest('hang', () => new Promise(() => {}))
    const call = linkA.request('hang')
    const rejected = assert.rejects(call, { reason: 'channel-closed' })
    await flush()
    await a.teardown()
    await rejected
    await assert.rejects(a.api.open(bob.podId), /torn down/)
  } finally { teardown() }
})

// -------------------------------------------------------------- negotiation

test('an old peer that does not know the channel is sent exactly one hello and refused cleanly', async () => {
  const [alice, bob] = await network()
  const received = []
  bob.onIncomingData((_from, text) => received.push(JSON.parse(text)))
  const a = attachService(alice, undefined, createMeshChannelService({ handshakeTimeoutMs: 25 }))
  try {
    await assert.rejects(a.api.open(bob.podId), e => e instanceof MeshChannelError && e.code === ChannelErrorCode.UNSUPPORTED && e.reason === 'unsupported')
    assert.equal(received.length, 1)
    assert.equal(received[0].type, CHANNEL_ENVELOPE_TYPE)
    assert.equal(received[0].k, 'hello')
    assert.deepEqual(a.api.peers, [])
  } finally { a.teardown() }
})

test('an old peer running mesh-rpc only keeps working beside the channel', async () => {
  const [alice, bob] = await network()
  const a = attachService(alice, undefined, createMeshChannelService({ handshakeTimeoutMs: 25 }))
  const rpcA = attachService(alice, undefined, createMeshRpcService())
  const rpcB = attachService(bob, undefined, createMeshRpcService({ onRequest: async () => ({ body: 'rpc ok' }) }))
  try {
    await assert.rejects(a.api.open(bob.podId), { reason: 'unsupported' })
    assert.equal((await rpcA.api.request(bob.podId, { path: '/x' })).body, 'rpc ok')
  } finally { a.teardown(); rpcA.teardown(); rpcB.teardown() }
})

test('peerSupports(false) refuses without sending anything', async () => {
  const [alice, bob] = await network()
  const sent = spy(alice)
  const a = attachService(alice, undefined, createMeshChannelService({ peerSupports: () => false }))
  try {
    await assert.rejects(a.api.open(bob.podId), { reason: 'unsupported' })
    assert.equal(sent.length, 0)
  } finally { a.teardown() }
})

test('a peer whose version range does not overlap gets an error ack, and a newer peer negotiates down', async () => {
  const { alice, bob, b, teardown } = await pair()
  try {
    const acks = []
    alice.onIncomingData((_from, text) => { const f = JSON.parse(text); if (f.k === 'hello-ack') acks.push(f) })
    const limits = { maxMessageBytes: 1024, window: 4096, maxInflight: 4, chunkBytes: 512 }
    await alice.sendTo(bob.podId, { type: CHANNEL_ENVELOPE_TYPE, k: 'hello', sid: 'old', v: 0, min: 0, ...limits })
    await flush()
    assert.equal(acks[0].error.r, 'unsupported-version')
    assert.equal(b.api.link(alice.podId), undefined)
    await alice.sendTo(bob.podId, { type: CHANNEL_ENVELOPE_TYPE, k: 'hello', sid: 'new', v: 7, min: 1, ...limits })
    await flush()
    assert.equal(acks[1].v, 1)
    assert.equal(b.api.link(alice.podId).version, 1)
    assert.equal(b.api.link(alice.podId).maxMessageBytes, 1024)
  } finally { teardown() }
})

test('a malformed handshake is refused', async () => {
  const { alice, bob, b, teardown } = await pair()
  try {
    const acks = []
    alice.onIncomingData((_from, text) => { const f = JSON.parse(text); if (f.k === 'hello-ack') acks.push(f) })
    await alice.sendTo(bob.podId, { type: CHANNEL_ENVELOPE_TYPE, k: 'hello', sid: 'x', v: 1, maxMessageBytes: 9999, window: 10, maxInflight: 1, chunkBytes: 1 })
    await flush()
    assert.ok(acks[0].error)
    assert.equal(b.api.link(alice.podId), undefined)
  } finally { teardown() }
})

test('a peer that restarts (new session id) replaces its old link, which is closed', async () => {
  const { alice, bob, a, b, linkB, teardown } = await pair()
  try {
    await a.api.open(bob.podId)
    const old = await linkB
    const closed = deferred(); old.onClose(e => closed.resolve(e))
    const a2 = attachService(alice, undefined, createMeshChannelService())
    a.teardown()
    const fresh = await a2.api.open(bob.podId)
    assert.equal((await closed.promise).reason, 'channel-closed')
    assert.notEqual(b.api.link(alice.podId), old)
    old.onRequest; b.api.link(alice.podId).onRequest('ping', () => 'pong')
    assert.equal(await fresh.request('ping'), 'pong')
    a2.teardown()
  } finally { teardown() }
})

test('both sides may open at once and end up with one working link each', async () => {
  const [alice, bob] = await network()
  const a = attachService(alice, undefined, createMeshChannelService())
  const b = attachService(bob, undefined, createMeshChannelService())
  try {
    const [la, lb] = await Promise.all([a.api.open(bob.podId), b.api.open(alice.podId)])
    la.onRequest('x', () => 'from a'); lb.onRequest('x', () => 'from b')
    assert.deepEqual(await Promise.all([la.request('x'), lb.request('x')]), ['from b', 'from a'])
    assert.deepEqual(a.api.peers, [bob.podId])
  } finally { a.teardown(); b.teardown() }
})

test('the number of links is bounded and a refused hello is answered, not ignored', async () => {
  const [alice, bob, eve] = await network()
  const b = attachService(bob, undefined, createMeshChannelService({ maxPeers: 1 }))
  const a = attachService(alice, undefined, createMeshChannelService())
  const e = attachService(eve, undefined, createMeshChannelService({ handshakeTimeoutMs: 1000 }))
  try {
    await a.api.open(bob.podId)
    await assert.rejects(e.api.open(bob.podId), { code: ChannelErrorCode.BUSY })
  } finally { a.teardown(); b.teardown(); e.teardown() }
})

test('acceptPeer can refuse an inbound hello', async () => {
  const [alice, bob] = await network()
  const b = attachService(bob, undefined, createMeshChannelService({ acceptPeer: () => false }))
  const a = attachService(alice, undefined, createMeshChannelService())
  try {
    await assert.rejects(a.api.open(bob.podId), { code: ChannelErrorCode.BUSY })
    assert.deepEqual(b.api.peers, [])
  } finally { a.teardown(); b.teardown() }
})

test('limits are validated up front', () => {
  assert.throws(() => createMeshChannelService({ maxMessageBytes: 0 }), TypeError)
  assert.throws(() => createMeshChannelService({ maxMessageBytes: 2 * CHANNEL_DEFAULT_MAX_MESSAGE_BYTES * 8 }), /cannot exceed window/)
  assert.throws(() => createMeshChannelService({ maxPeers: -1 }), TypeError)
})
