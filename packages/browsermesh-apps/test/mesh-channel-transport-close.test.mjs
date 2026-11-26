/**
 * A channel link follows its transport: when the node reports that the transport to a peer closed and the peer has no
 * other active session, the link to that peer is closed at once (and so is every protocol channel on it), instead of
 * staying "open" until some request or timeout finds out.
 *
 * Two in-memory nodes with the one node event the service listens for (`peer:transport-close`) and `hasActiveSession`.
 * Nothing here waits on the wall clock: waits are on promises and on draining the task queue.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshChannelService } from '../src/mesh-channel.mjs'

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }

async function pair() {
  const nodes = new Map()
  const make = async () => {
    const identity = await PodIdentity.generate()
    const listeners = new Set()
    const events = new Map()
    const active = new Set()
    const node = {
      podId: identity.podId,
      listeners,
      active,
      onIncomingData(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      hasActiveSession: (peer) => active.has(peer),
      on(event, cb) { if (!events.has(event)) events.set(event, new Set()); events.get(event).add(cb) },
      off(event, cb) { events.get(event)?.delete(cb) },
      listenerCount: (event) => events.get(event)?.size ?? 0,
      fire(event, data) { for (const cb of [...(events.get(event) ?? [])]) cb(data) },
      async sendTo(id, message) {
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
  alice.active.add(bob.podId)
  bob.active.add(alice.podId)
  const links = []
  const a = attachService(alice, undefined, createMeshChannelService())
  const b = attachService(bob, undefined, createMeshChannelService({ onLink: (l) => links.push(l) }))
  const link = await a.api.open(bob.podId)
  await flush()
  return { alice, bob, a, b, link, linkOnBob: links[0] }
}

test('the link closes when the transport to its peer closed and no session is left', async () => {
  const { alice, bob, a, link, b } = await pair()
  const reasons = []
  link.onClose((e) => reasons.push(e?.reason))
  alice.active.delete(bob.podId)
  alice.fire('peer:transport-close', { pubKey: bob.podId, sessionId: 's', transport: 'webrtc' })
  assert.equal(link.closed, true)
  assert.deepEqual(reasons, ['transport-closed'])
  assert.equal(a.api.link(bob.podId), undefined)
  a.teardown(); b.teardown()
})

test('the link stays open while the peer has another active session', async () => {
  const { alice, bob, a, link, b } = await pair()
  alice.fire('peer:transport-close', { pubKey: bob.podId, sessionId: 's', transport: 'webrtc' })
  assert.equal(link.closed, false)
  a.teardown(); b.teardown()
})

test('a close for a peer with no link, or for another peer, changes nothing', async () => {
  const { alice, bob, a, link, b } = await pair()
  alice.active.delete(bob.podId)
  alice.fire('peer:transport-close', { pubKey: 'someone-else', sessionId: 's', transport: 'webrtc' })
  assert.equal(link.closed, false)
  a.teardown(); b.teardown()
})

test('a link opened again after the close is a normal new link', async () => {
  const { alice, bob, a, link, b } = await pair()
  alice.active.delete(bob.podId)
  alice.fire('peer:transport-close', { pubKey: bob.podId, sessionId: 's', transport: 'webrtc' })
  assert.equal(link.closed, true)
  alice.active.add(bob.podId)
  const again = await a.api.open(bob.podId)
  assert.notEqual(again, link)
  assert.equal(again.closed, false)
  assert.deepEqual(await again.request('nope', {}).catch((e) => e.code), -32601)
  a.teardown(); b.teardown()
})

test('a peer that started over on the connection it had ends the link that ran over the old one, even though a session is still active', async () => {
  const { alice, bob, a, link, b } = await pair()
  const reasons = []
  link.onClose((e) => reasons.push(e?.reason))
  alice.fire('peer:transport-restart', { pubKey: 'someone-else', sessionId: 's', transport: 'webrtc', connectionId: 'default' })
  alice.fire('peer:transport-restart', { pubKey: bob.podId, sessionId: 's', transport: 'webrtc', connectionId: 'another' })
  assert.equal(link.closed, false, 'another peer, or another connection of this peer, changes nothing')
  alice.fire('peer:transport-restart', { pubKey: bob.podId, sessionId: 's', transport: 'webrtc', connectionId: 'default' })
  assert.equal(link.closed, true)
  assert.deepEqual(reasons, ['transport-restart'])
  assert.equal(a.api.link(bob.podId), undefined)
  // the next link is a normal new one, opened over the connection the peer made
  const again = await a.api.open(bob.podId)
  assert.notEqual(again, link)
  assert.equal(again.closed, false)
  a.teardown(); b.teardown()
})

test('teardown stops listening to the node', async () => {
  const { alice, a, b } = await pair()
  assert.equal(alice.listenerCount('peer:transport-close'), 1)
  assert.equal(alice.listenerCount('peer:transport-restart'), 1)
  a.teardown()
  assert.equal(alice.listenerCount('peer:transport-close'), 0)
  assert.equal(alice.listenerCount('peer:transport-restart'), 0)
  b.teardown()
})

test('a node that has no events (a test double) still works', async () => {
  const [{ PodIdentity: P }] = [{ PodIdentity }]
  const identity = await P.generate()
  const node = { podId: identity.podId, onIncomingData: () => () => {}, sendTo: async () => {} }
  const s = attachService(node, undefined, createMeshChannelService())
  s.teardown()
})
