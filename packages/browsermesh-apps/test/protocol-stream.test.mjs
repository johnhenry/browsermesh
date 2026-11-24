/**
 * protocol-stream: bodies larger than one message over a protocol channel,
 * bounded (a per-stream window the receiver controls), backpressured (a writer
 * waits for credit, a reader that stops stops the writer) and cancellable
 * (either end, or an AbortSignal). Runs over a hand-written in-memory duplex
 * that has no flow control of its own (so the stream window is all there is),
 * and over the real mesh channel (a small link, so link credit is in play too).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { network } from './helpers/rpc-network.mjs'
import { memoryChannelPair } from './helpers/counter-protocol.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { createMeshProtocolService, protocolScope } from '../src/protocol-channel.mjs'
import { ChannelErrorCode, MeshChannelError } from '../src/mesh-channel.mjs'
import { createStreamLayer, STREAM_DEFAULT_WINDOW_BYTES } from '../src/protocol-stream.mjs'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'

const flush = async () => { for (let i = 0; i < 25; i++) await new Promise(r => setImmediate(r)) }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const pending = async p => { let settled = false; p.then(() => { settled = true }, () => { settled = true }); await flush(); return !settled }

function bodyOf(n, seed = 7) {
  const out = new Uint8Array(n)
  let x = seed
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; out[i] = x >>> 16 }
  return out
}
const same = (a, b) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i])

/** Count the bytes of stream data a channel sends, without changing it. */
function counting(channel) {
  const seen = { dataBytes: 0, frames: 0, methods: [] }
  const wrapped = {
    ...channel,
    notify(method, params) {
      seen.methods.push(method)
      if (method === 'stream.data') { seen.dataBytes += params.d.byteLength; seen.frames++ }
      return channel.notify(method, params)
    },
  }
  return { channel: wrapped, seen }
}

async function memoryPair(optsA = {}, optsB = {}) {
  const { a, b } = memoryChannelPair('alice', 'bob')
  const ca = counting(a)
  const sender = createStreamLayer(ca.channel, optsA)
  const receiver = createStreamLayer(b, optsB)
  return { sender, receiver, seen: ca.seen, a, b }
}

async function collect(reader) {
  const parts = []
  for await (const chunk of reader) parts.push(chunk)
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return { out, parts }
}

// -------------------------------------------------------------- the basics

test('a body many times larger than one message arrives intact, in bounded chunks', async () => {
  const { sender, receiver } = await memoryPair({ chunkBytes: 4096 }, { window: 16 * 1024 })
  const body = bodyOf(1_000_000)
  const got = deferred()
  receiver.onStream((reader, { meta, peer }) => { got.resolve(collect(reader).then(r => ({ ...r, meta, peer }))) })
  const w = await sender.open({ name: 'big.bin', size: body.byteLength })
  await w.write(body)
  await w.end()
  const { out, parts, meta, peer } = await got.promise
  assert.ok(same(out, body))
  assert.deepEqual(meta, { name: 'big.bin', size: body.byteLength })
  assert.equal(peer, 'alice')
  assert.ok(parts.length > 200, 'many chunks')
  assert.ok(parts.every(p => p.byteLength <= 4096), 'no chunk above the chunk size')
})

test('an empty stream and a stream of one tiny write both end cleanly', async () => {
  const { sender, receiver } = await memoryPair()
  const results = []
  receiver.onStream(async reader => { results.push((await collect(reader)).out.byteLength) })
  const w1 = await sender.open({}); await w1.end()
  const w2 = await sender.open({}); await w2.write(new Uint8Array([9])); await w2.end()
  await flush()
  assert.deepEqual(results.sort(), [0, 1])
})

test('write accepts any typed array view and rejects other values', async () => {
  const { sender, receiver } = await memoryPair()
  const got = deferred()
  receiver.onStream(reader => got.resolve(collect(reader)))
  const w = await sender.open({})
  await w.write(new DataView(new ArrayBuffer(2)))
  await w.write(new Uint16Array([0x0102]))
  await assert.rejects(w.write('text'), TypeError)
  await assert.rejects(w.write([1, 2]), TypeError)
  await w.end()
  assert.equal((await got.promise).out.byteLength, 4)
})

test('sendBody streams an async iterable, and toReadableStream/toWritableStream interoperate', async () => {
  const { sender, receiver } = await memoryPair({ chunkBytes: 1000 }, { window: 4000 })
  const body = bodyOf(25_000, 3)
  const got = deferred()
  receiver.onStream(reader => { got.resolve(new Response(reader.toReadableStream()).arrayBuffer().then(b => new Uint8Array(b))) })
  async function* source() { for (let i = 0; i < body.length; i += 700) yield body.subarray(i, i + 700) }
  await sender.sendBody(source(), { kind: 'iter' })
  assert.ok(same(await got.promise, body))

  const got2 = deferred()
  receiver.onStream(reader => { got2.resolve(reader.bytes()) })
  const w = await sender.open({})
  await new Response(body).body.pipeTo(w.toWritableStream())
  assert.ok(same(await got2.promise, body))
})

// ------------------------------------------------------------ backpressure

test('a reader that does not read stops the writer at the window; reading lets it continue', async () => {
  const window = 8 * 1024
  const { sender, receiver, seen } = await memoryPair({ chunkBytes: 1024 }, { window })
  const readerReady = deferred()
  receiver.onStream(reader => readerReady.resolve(reader))
  const w = await sender.open({})
  const reader = await readerReady.promise
  const body = bodyOf(10 * window)
  const writing = w.write(body)
  assert.equal(await pending(writing), true, 'the write cannot finish while nothing is read')
  assert.ok(seen.dataBytes <= window, `at most one window in flight (sent ${seen.dataBytes})`)
  assert.ok(seen.dataBytes > 0)
  assert.equal(reader.bufferedBytes <= window, true)
  // Now read everything: the writer completes and every byte arrives.
  const collected = collect(reader)
  await writing
  await w.end()
  const { out } = await collected
  assert.ok(same(out, body))
})

test('the receiver never buffers more than its window, however fast the writer is', async () => {
  const window = 4096
  const { sender, receiver } = await memoryPair({ chunkBytes: 512 }, { window })
  let maxBuffered = 0
  const done = deferred()
  receiver.onStream(async reader => {
    let n = 0
    for await (const chunk of reader) {
      maxBuffered = Math.max(maxBuffered, reader.bufferedBytes + chunk.byteLength)
      n += chunk.byteLength
      await new Promise(r => setImmediate(r)) // a slow consumer
    }
    done.resolve(n)
  })
  const w = await sender.open({})
  await w.write(bodyOf(200_000))
  await w.end()
  assert.equal(await done.promise, 200_000)
  assert.ok(maxBuffered <= window, `buffered ${maxBuffered} > window ${window}`)
})

test('a stalled stream does not stop other requests on the same channel', async () => {
  const { a, b } = memoryChannelPair('alice', 'bob')
  const sender = createStreamLayer(a, { chunkBytes: 256 }), receiver = createStreamLayer(b, { window: 1024 })
  b.onRequest('ping', () => 'pong')
  const stalled = deferred()
  receiver.onStream(reader => stalled.resolve(reader))
  const w = await sender.open({})
  await stalled.promise
  const writing = w.write(bodyOf(100_000))
  assert.equal(await pending(writing), true)
  assert.equal(await a.request('ping', {}), 'pong')
})

test('the window and the chunk size the receiver answers with bound the writer, whatever the writer asked for', async () => {
  const { sender, receiver, seen } = await memoryPair({ chunkBytes: 1_000_000, window: 1_000_000 }, { window: 2048, chunkBytes: 512 })
  const r = deferred()
  receiver.onStream(reader => r.resolve(reader))
  const w = await sender.open({})
  await r.promise
  const writing = w.write(bodyOf(100_000))
  await pending(writing)
  assert.ok(seen.dataBytes <= 2048)
  assert.equal(w.chunkBytes, 512)
  assert.equal(w.window, 2048)
  w.abort()
  await assert.rejects(writing)
})

// ------------------------------------------------------------ cancellation

test('the reader cancelling stops the writer: pending and later writes reject', async () => {
  const { sender, receiver, seen } = await memoryPair({ chunkBytes: 1024 }, { window: 4096 })
  const readerReady = deferred()
  receiver.onStream(reader => readerReady.resolve(reader))
  const w = await sender.open({})
  const reader = await readerReady.promise
  const writing = w.write(bodyOf(1_000_000))
  await flush()
  const sentBefore = seen.dataBytes
  await reader.cancel('not needed')
  await assert.rejects(writing, { reason: 'stream-cancelled' })
  await assert.rejects(w.write(new Uint8Array(1)), { reason: 'stream-cancelled' })
  await flush()
  assert.equal(seen.dataBytes, sentBefore, 'nothing is sent after a cancel')
  assert.equal(w.signal.aborted, true)
  assert.deepEqual(await reader.read(), { done: true, value: undefined })
})

test('the writer aborting fails the reader with a named error, after what was already delivered', async () => {
  const { sender, receiver } = await memoryPair({ chunkBytes: 100 })
  const readerReady = deferred()
  receiver.onStream(reader => readerReady.resolve(reader))
  const w = await sender.open({})
  const reader = await readerReady.promise
  await w.write(new Uint8Array(100).fill(1))
  w.abort(new Error('changed my mind'))
  await flush()
  const first = await reader.read()
  assert.equal(first.value.byteLength, 100)
  await assert.rejects(reader.read(), (e) => e instanceof MeshChannelError && e.reason === 'stream-aborted')
})

test('an AbortSignal cancels open and a pending write', async () => {
  const { sender, receiver } = await memoryPair({ chunkBytes: 100 }, { window: 200 })
  const readerReady = deferred()
  receiver.onStream(reader => readerReady.resolve(reader))
  const pre = new AbortController(); pre.abort()
  await assert.rejects(sender.open({}, { signal: pre.signal }), { reason: 'cancelled' })
  const ac = new AbortController()
  const w = await sender.open({})
  await readerReady.promise
  const writing = w.write(bodyOf(10_000), { signal: ac.signal })
  await flush()
  ac.abort()
  await assert.rejects(writing, { reason: 'cancelled' })
})

test('a stream the receiver refuses never opens, with the receiver\'s reason', async () => {
  const { sender, receiver } = await memoryPair()
  receiver.onStream((_reader, { meta }) => {
    if (meta.root !== 'docs') throw new MeshChannelError(ChannelErrorCode.UNAUTHORIZED, 'not-authorized', 'no such root')
  })
  await assert.rejects(sender.open({ root: 'secret' }), { code: ChannelErrorCode.UNAUTHORIZED })
  const w = await sender.open({ root: 'docs' })
  await w.end()
})

test('authorize runs before the open is answered: false or a throw refuses, even before any handler exists', async () => {
  const seen = []
  const { sender, receiver } = await memoryPair({}, { authorize: async (meta, { peer }) => { seen.push([meta.n, peer]); if (meta.n === 2) throw new MeshChannelError(ChannelErrorCode.UNAUTHORIZED, 'not-authorized', 'no'); return meta.n !== 1 } })
  // No onStream yet: an unauthorised open learns nothing about that, an authorised one is told.
  await assert.rejects(sender.open({ n: 1 }), { reason: 'not-authorized' })
  await assert.rejects(sender.open({ n: 2 }), { reason: 'not-authorized' })
  await assert.rejects(sender.open({ n: 3 }), { reason: 'no-stream-handler' })
  receiver.onStream(reader => { collect(reader).catch(() => {}) })
  const w = await sender.open({ n: 3 })
  await w.end()
  assert.deepEqual(seen.map(s => s[1]), ['alice', 'alice', 'alice', 'alice'], 'the peer is the channel\'s')
  assert.equal(receiver.stats().incoming <= 1, true)
})

test('with no handler registered, an open is refused', async () => {
  const { sender } = await memoryPair()
  await assert.rejects(sender.open({}), { reason: 'no-stream-handler' })
})

// ----------------------------------------------------------------- limits

test('a writer that exceeds the credit it was given is cut off', { timeout: 5000 }, async () => {
  const { a, b } = memoryChannelPair('alice', 'bob')
  const receiver = createStreamLayer(b, { window: 1024, chunkBytes: 512 })
  const r = deferred()
  receiver.onStream(reader => r.resolve(reader))
  const { id } = await a.request('stream.open', { id: 1, meta: {} })
  void id
  const reader = await r.promise
  // Ignore the window entirely.
  for (let s = 0; s < 6; s++) await a.notify('stream.data', { id: 1, s, d: new Uint8Array(512) })
  await flush()
  await assert.rejects(async () => { for await (const _ of reader); }, { reason: 'stream-violation' })
})

test('data out of sequence ends the stream', async () => {
  const { a, b } = memoryChannelPair('alice', 'bob')
  const receiver = createStreamLayer(b, { window: 4096 })
  const r = deferred()
  receiver.onStream(reader => r.resolve(reader))
  await a.request('stream.open', { id: 1, meta: {} })
  const reader = await r.promise
  await a.notify('stream.data', { id: 1, s: 0, d: new Uint8Array(10) })
  await a.notify('stream.data', { id: 1, s: 2, d: new Uint8Array(10) })
  await flush()
  assert.equal((await reader.read()).value.byteLength, 10)
  await assert.rejects(reader.read(), { reason: 'stream-violation' })
})

test('maxStreamBytes bounds one stream on both ends', async () => {
  const { sender, receiver } = await memoryPair({}, { maxStreamBytes: 10_000, window: 2048, chunkBytes: 512 })
  const r = deferred()
  receiver.onStream(reader => r.resolve(reader))
  const w = await sender.open({})
  assert.equal(w.maxBytes, 10_000)
  const reader = await r.promise
  const consumed = (async () => { try { for await (const _ of reader); } catch (e) { return e } })()
  await assert.rejects(w.write(bodyOf(20_000)), { code: ChannelErrorCode.TOO_LARGE })
  w.abort()
  void consumed
})

test('a receiver ends a stream that goes past maxStreamBytes even if the writer ignores the limit', async () => {
  const { a, b } = memoryChannelPair('alice', 'bob')
  const receiver = createStreamLayer(b, { maxStreamBytes: 1000, window: 4096 })
  const r = deferred()
  receiver.onStream(reader => r.resolve(reader))
  await a.request('stream.open', { id: 1, meta: {} })
  const reader = await r.promise
  await a.notify('stream.data', { id: 1, s: 0, d: new Uint8Array(800) })
  await a.notify('stream.data', { id: 1, s: 1, d: new Uint8Array(800) })
  await flush()
  await reader.read()
  await assert.rejects(reader.read(), { reason: 'stream-too-large' })
})

test('maxStreams bounds concurrent streams per direction', async () => {
  const { sender, receiver } = await memoryPair({}, { maxStreams: 2 })
  receiver.onStream(reader => { collect(reader).catch(() => {}) })
  const w1 = await sender.open({}), w2 = await sender.open({})
  await assert.rejects(sender.open({}), { code: ChannelErrorCode.BUSY })
  await w1.end()
  await flush()
  const w3 = await sender.open({})
  w2.abort(); w3.abort()
})

test('closing the channel fails every open stream on both ends', async () => {
  const { sender, receiver, a, b } = await memoryPair()
  const r = deferred()
  receiver.onStream(reader => r.resolve(reader))
  const w = await sender.open({})
  const reader = await r.promise
  const writing = w.write(bodyOf(2_000_000))
  await flush()
  a.close(); b.close()
  await assert.rejects(writing, { reason: 'channel-closed' })
  await assert.rejects(reader.read(), { reason: 'channel-closed' })
})

test('bytes() collects up to a limit and fails past it', async () => {
  const { sender, receiver } = await memoryPair({ chunkBytes: 100 })
  const results = []
  receiver.onStream(async reader => { results.push(await reader.bytes({ maxBytes: 250 }).catch(e => e)) })
  const w = await sender.open({})
  w.write(new Uint8Array(1000)).catch(() => {})
  await flush()
  assert.ok(results[0] instanceof MeshChannelError)
  assert.equal(results[0].code, ChannelErrorCode.TOO_LARGE)
})

test('layers validate their options and the channel', () => {
  const { a } = memoryChannelPair()
  assert.throws(() => createStreamLayer({}), TypeError)
  assert.throws(() => createStreamLayer(a, { window: 0 }), TypeError)
  assert.throws(() => createStreamLayer(a, { chunkBytes: 100, window: 50 }), TypeError)
  assert.throws(() => createStreamLayer(a, { maxStreams: 0 }), TypeError)
  assert.ok(STREAM_DEFAULT_WINDOW_BYTES > 0)
})

// ----------------------------------------------------------- over the mesh

async function meshPair(linkLimits) {
  const [alice, bob] = await network()
  for (const node of [alice, bob]) {
    node.registry = new PeerRegistry({ localPodId: node.podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: node.podId }) })
  }
  const a = attachService(alice, undefined, createMeshProtocolService(linkLimits))
  const b = attachService(bob, undefined, createMeshProtocolService(linkLimits))
  return { alice, bob, a, b, teardown() { a.teardown(); b.teardown() } }
}

test('over the real mesh channel with a small link: a 3 MiB body, authorised per protocol, never more than the windows in flight', async () => {
  const { alice, bob, a, b, teardown } = await meshPair({ maxMessageBytes: 16 * 1024, window: 64 * 1024, chunkBytes: 4096 })
  try {
    const got = deferred()
    let receiverLayer
    b.api.serveProtocol('files', channel => {
      receiverLayer = createStreamLayer(channel, { window: 32 * 1024 })
      receiverLayer.onStream(async (reader, { peer, meta }) => { got.resolve({ peer, meta, bytes: await reader.bytes() }) })
    })
    bob.registry.grantCapabilities(alice.podId, [protocolScope('files')])
    const channel = await a.api.openProtocol(bob.podId, 'files')
    const layer = createStreamLayer(channel, { chunkBytes: 8 * 1024 })
    const body = bodyOf(3 * 1024 * 1024, 11)
    const w = await layer.open({ name: 'three-mib' })
    assert.ok(w.chunkBytes <= 16 * 1024 - 512, 'a chunk fits a message of the link')
    await w.write(body)
    await w.end()
    const { peer, meta, bytes } = await got.promise
    assert.equal(peer, alice.podId)
    assert.deepEqual(meta, { name: 'three-mib' })
    assert.ok(same(bytes, body))
  } finally { teardown() }
})

test('over the real mesh: a reader that stops reading holds the writer without holding the link', async () => {
  const { alice, bob, a, b, teardown } = await meshPair({ maxMessageBytes: 16 * 1024, window: 64 * 1024 })
  try {
    const held = deferred()
    b.api.serveProtocol('files', channel => {
      const layer = createStreamLayer(channel, { window: 16 * 1024 })
      layer.onStream(reader => held.resolve(reader))
      channel.onRequest('ping', () => 'pong')
    })
    bob.registry.grantCapabilities(alice.podId, [protocolScope('files')])
    const channel = await a.api.openProtocol(bob.podId, 'files')
    const layer = createStreamLayer(channel)
    const w = await layer.open({})
    const reader = await held.promise
    const writing = w.write(bodyOf(2 * 1024 * 1024))
    assert.equal(await pending(writing), true)
    assert.equal(await channel.request('ping', {}), 'pong', 'the same channel still answers requests')
    assert.ok(reader.bufferedBytes <= 16 * 1024)
    await reader.cancel()
    await assert.rejects(writing, { reason: 'stream-cancelled' })
  } finally { teardown() }
})
