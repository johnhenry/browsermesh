/**
 * `link.request(..., { onSent })`: called once, when the transport has taken the first frame of the request, so a caller whose
 * request fails can tell a request that never left this node from one that may have reached the peer. A transport that refuses the
 * frame ends the link (as it always did) and `onSent` is not called.
 *
 * Two in-memory nodes; nothing waits on the wall clock.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshChannelService } from '../src/mesh-channel.mjs'

async function pair(channelOptions) {
  const nodes = new Map()
  const failing = { skip: 0, count: 0 }
  const make = async () => {
    const identity = await PodIdentity.generate()
    const listeners = new Set()
    const node = {
      podId: identity.podId,
      listeners,
      onIncomingData(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      async sendTo(id, message) {
        if (message?.k === 'd' && node.fails && failing.count > 0) {
          if (failing.skip > 0) failing.skip -= 1
          else { failing.count -= 1; throw new Error('Peer identity not verified yet') }
        }
        const other = nodes.get(id)
        if (!other) throw new Error('unreachable peer')
        const text = JSON.stringify(message)
        queueMicrotask(() => { for (const fn of other.listeners) fn(node.podId, text) })
      },
    }
    nodes.set(node.podId, node)
    return node
  }
  const [alice, bob] = await Promise.all([make(), make()])
  alice.fails = true
  const a = attachService(alice, undefined, createMeshChannelService(channelOptions))
  const b = attachService(bob, undefined, createMeshChannelService({ ...channelOptions, onLink: (l) => l.onRequest('echo', (p) => p) }))
  const link = await a.api.open(bob.podId)
  return { alice, bob, a, b, link, failing }
}

test('onSent is called once the transport has taken the request, before the answer', async () => {
  const { a, b, link } = await pair()
  const seen = []
  const answer = await link.request('echo', { n: 1 }, { onSent: () => seen.push('sent') })
  assert.deepEqual(answer, { n: 1 })
  assert.deepEqual(seen, ['sent'])
  a.teardown(); b.teardown()
})

test('onSent is not called for a request the transport refused: the link ends, as it did, and the request is rejected', async () => {
  const { a, b, link, failing } = await pair()
  failing.count = 1
  let sent = false
  await assert.rejects(link.request('echo', { n: 1 }, { onSent: () => { sent = true } }))
  assert.equal(sent, false)
  assert.equal(link.closed, true)
  a.teardown(); b.teardown()
})

test('onSent is called for a request of which the first frame went out and a later one failed', async () => {
  const { a, b, link, failing } = await pair({ chunkBytes: 256, window: 4096, maxMessageBytes: 4096 })
  failing.skip = 1
  failing.count = 1
  let sent = 0
  await assert.rejects(link.request('echo', { text: 'x'.repeat(600) }, { onSent: () => { sent += 1 } }))
  assert.equal(sent, 1)
  a.teardown(); b.teardown()
})

test('a hook that throws does not break the link', async () => {
  const { a, b, link } = await pair()
  const answer = await link.request('echo', { n: 2 }, { onSent: () => { throw new Error('hook') } })
  assert.deepEqual(answer, { n: 2 })
  assert.equal(link.closed, false)
  a.teardown(); b.teardown()
})
