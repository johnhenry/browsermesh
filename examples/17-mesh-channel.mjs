/**
 * `createMeshChannelService()` -- a message-oriented duplex channel between
 * two mesh peers, for protocols that need more than `mesh-rpc`'s HTTP-shaped
 * request/response.
 *
 * What this shows, over one connection between alice and bob:
 *   - requests in both directions (bob asks alice something too),
 *   - progress from a long request, and native Uint8Array results (no base64
 *     in the API),
 *   - cancel: alice aborts a request; bob's handler sees its AbortSignal fire,
 *   - notifications,
 *   - a message over the negotiated maximum refused before it is sent,
 *   - credit-based flow control: a reader that stops reading stalls the
 *     sender at one window of bytes instead of letting it buffer without end,
 *   - the caller's verified identity (`ctx.peer`) handed to every handler,
 *   - an old peer that has no channel service being refused cleanly.
 *
 * As in the other examples the connection is a simulated in-process bus
 * (it crosses a JSON boundary like a real transport); everything layered on
 * it is the production code of `@johnhenry/browsermesh-apps`.
 */
import assert from 'node:assert/strict'
import { attachService, createMeshChannelService, ChannelErrorCode } from '@johnhenry/browsermesh-apps'

function createNodes(ids) {
  const nodes = new Map()
  for (const podId of ids) {
    const listeners = new Set()
    nodes.set(podId, {
      podId,
      listeners,
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo(to, data) {
        const target = nodes.get(to)
        if (!target) throw new Error(`unreachable peer ${to}`)
        const text = JSON.stringify(data) // a real transport carries JSON text
        queueMicrotask(() => { for (const cb of target.listeners) cb(podId, text) })
      },
    })
  }
  return [...nodes.values()]
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)) }

const [aliceNode, bobNode, oldNode] = createNodes(['pod-alice', 'pod-bob', 'pod-old'])

// Small window so the flow-control demonstration is visible.
const limits = { window: 64 * 1024, maxMessageBytes: 16 * 1024, chunkBytes: 4096, handshakeTimeoutMs: 50 }

// Bob registers his handlers in onLink, which runs the moment the link exists
// -- before any request can arrive on it.
const readerGate = {}
readerGate.promise = new Promise(resolve => { readerGate.open = resolve })
let received = 0
const bob = attachService(bobNode, undefined, createMeshChannelService({
  ...limits,
  onLink(link) {
    link.onRequest('files.read', async ({ size }, { peer, progress, signal }) => {
      console.log(`bob: files.read for ${peer}`)
      for (let i = 1; i <= 3; i++) await progress({ part: i, bytes: new Uint8Array(4).fill(i) })
      return { data: new Uint8Array(size).fill(7), by: peer }
    })
    link.onRequest('slow', (_params, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { console.log('bob: slow handler saw the cancel'); reject(signal.reason) })
    }))
    link.onNotification('hello', (params, { peer }) => console.log(`bob: notification from ${peer}:`, params))
    link.onMessage(async () => { received++; await readerGate.promise }) // a reader that is not reading yet
  },
}))
const alice = attachService(aliceNode, undefined, createMeshChannelService({
  ...limits,
  onLink(link) { link.onRequest('whoami', (_p, { peer }) => ({ youAre: peer })) },
}))

const link = await alice.api.open('pod-bob')
console.log('alice: link open, negotiated max message =', link.maxMessageBytes, 'bytes')

// 1. a request with progress and native bytes
const chunks = []
const file = await link.request('files.read', { size: 10 }, { onProgress: p => chunks.push(p.part) })
assert.ok(file.data instanceof Uint8Array)
assert.deepEqual(chunks, [1, 2, 3])
assert.equal(file.by, 'pod-alice') // bob names the VERIFIED caller, not anything alice put in the message
console.log('alice: got', file.data.length, 'bytes after progress', chunks)

// 2. the other direction: bob asks alice
const bobSide = await new Promise(resolve => bob.api.link('pod-alice') ? resolve(bob.api.link('pod-alice')) : bob.api.onLink(resolve))
assert.deepEqual(await bobSide.request('whoami'), { youAre: 'pod-bob' })

// 3. cancel
const ac = new AbortController()
const slow = link.request('slow', {}, { signal: ac.signal })
await settle()
ac.abort()
await assert.rejects(slow, { code: ChannelErrorCode.CANCELLED })

// 4. notification
await link.notify('hello', { from: 'alice' })

// 5. over the negotiated maximum: refused before anything is sent
await assert.rejects(link.send(new Uint8Array(32 * 1024)), { code: ChannelErrorCode.TOO_LARGE })
console.log('alice: a 32 KiB message was refused locally (max is', link.maxMessageBytes + ')')

// 6. flow control: bob's reader is stuck, alice queues 100 x 8 KiB.
const sends = Array.from({ length: 100 }, (_, i) => link.send({ i, pad: new Uint8Array(8 * 1024) }))
await settle()
const { queuedBytes, creditBytes } = link.stats()
console.log(`alice: bob is not reading -> only ${received} message(s) delivered, ${queuedBytes} bytes still queued on alice, credit left ${creditBytes}`)
assert.ok(bobSide.stats().heldBytes <= limits.window)
assert.equal(received, 1)
readerGate.open()
await Promise.all(sends)
await settle()
assert.equal(received, 100)
console.log('alice: bob caught up; all', received, 'messages delivered')

// 7. an old peer: no channel service on pod-old
const refused = await alice.api.open('pod-old').then(() => null, e => e)
assert.equal(refused.code, ChannelErrorCode.UNSUPPORTED)
console.log('alice: pod-old does not support the channel ->', refused.reason)

link.close()
alice.teardown(); bob.teardown()
console.log('done')
void oldNode
