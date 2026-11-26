/**
 * A frame from a link that has ended must not touch the link that replaced it.
 *
 * A peer that starts over opens a new link (a new session id in its hello). What the old link had in flight (its close
 * above all) can still arrive after the new link is up, over a path that does not keep the order. Every frame carries
 * the id of the link it belongs to; a frame for another link than the one this end holds is dropped. A frame with no
 * id (an older peer's) is taken as before.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { network } from './helpers/rpc-network.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshChannelService, createChannelCore } from '../src/mesh-channel.mjs'

const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)) }

/** Two cores wired by hand: every frame one sends is kept in `out` and handed to the other when the test says so. */
function cores() {
  const out = { a: [], b: [] }
  const everything = { a: [], b: [] }
  const a = createChannelCore({ peer: 'b', sendFrame: (f) => { out.a.push(f); everything.a.push(f) } })
  const b = createChannelCore({ peer: 'a', sendFrame: (f) => { out.b.push(f); everything.b.push(f) } })
  const deliver = async () => {
    for (let i = 0; i < 6; i++) {
      await flush()
      for (const f of out.a.splice(0)) b.receive(f)
      for (const f of out.b.splice(0)) a.receive(f)
    }
    await flush()
  }
  return { a, b, out, everything, deliver }
}

test('the close of an old link that arrives after the new link is up leaves the new link alone', async () => {
  const [alice, bob] = await network()
  const b = attachService(bob, undefined, createMeshChannelService())
  const a = attachService(alice, undefined, createMeshChannelService())
  const held = []
  const send = alice.sendTo.bind(alice)
  let holding = true
  alice.sendTo = (id, message) => (holding && message.k === 'close' ? (held.push([id, message]), Promise.resolve()) : send(id, message))
  try {
    await a.api.open(bob.podId)
    await flush()
    const old = b.api.link(alice.podId)
    a.teardown() // the old link's close is in flight (held back)
    await flush()
    assert.equal(held.length, 1)
    const a2 = attachService(alice, undefined, createMeshChannelService())
    const fresh = await a2.api.open(bob.podId)
    await flush()
    assert.equal(old.closed, true, 'the new hello replaced the old link')
    const current = b.api.link(alice.podId)
    current.onRequest('ping', () => 'pong')
    holding = false
    for (const [id, message] of held) await send(id, message) // the late close
    await flush()
    assert.equal(current.closed, false)
    assert.equal(await fresh.request('ping'), 'pong')
    a2.teardown()
  } finally { a.teardown(); b.teardown() }
})

test('every frame a link sends carries the id of its link', async () => {
  const { a, b, everything, deliver } = cores()
  a.open().catch(() => {})
  await deliver()
  b.link.onNotification('n', () => {})
  await a.link.notify('n', 1)
  await deliver()
  const seen = everything.a
  assert.ok(seen.length >= 2)
  assert.equal(typeof seen[0].sid, 'string')
  assert.ok(seen.every((f) => f.sid === seen[0].sid), JSON.stringify(seen))
  assert.ok(seen.some((f) => f.k === 'd'))
})

test('a frame of another link is dropped; a frame of this link, or with no id at all (an older peer), is taken', async () => {
  const { a, b, deliver } = cores()
  const got = []
  b.link.onNotification('n', (p) => got.push(p))
  a.open().catch(() => {})
  await deliver()
  // A second link of the same peer: its frames carry another id.
  const other = cores()
  other.a.open().catch(() => {})
  await other.deliver()
  const captured = []
  const spy = createChannelCore({ peer: 'b', sendFrame: (f) => { captured.push(f) } })
  spy.receive({ k: 'hello', sid: 'a-link-b-never-saw', v: 1, min: 1, maxMessageBytes: 1024, window: 65536, maxInflight: 10, chunkBytes: 1024 })
  captured.length = 0
  await spy.link.notify('n', 'stale')
  const stale = captured.filter((f) => f.k === 'd')
  assert.ok(stale.length > 0 && stale.every((f) => typeof f.sid === 'string'))
  for (const f of stale) b.receive(f)
  await flush()
  assert.deepEqual(got, [], 'frames of another link are dropped')
  // This link's own notification goes through.
  await a.link.notify('n', 'mine')
  await deliver()
  assert.deepEqual(got, ['mine'])
  // The same frames without an id (an older peer sends none) are taken.
  const old = cores()
  const gotOld = []
  old.b.link.onNotification('n', (p) => gotOld.push(p))
  old.a.open().catch(() => {})
  await old.deliver()
  await old.a.link.notify('n', 'bare')
  for (const f of old.out.a.splice(0)) { const { sid, ...bare } = f; old.b.receive(bare) }
  await flush()
  assert.deepEqual(gotOld, ['bare'])
})
