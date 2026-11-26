/**
 * `createMeshNode({ admission })` over wsh: a stranger is held on a restricted link, talks to the handler and nothing else,
 * is promoted or closed. Real wsh handshake, key login and sealed session through the in-process pipe relay (no network).
 *
 * Run: node --import ./test/_setup-globals.mjs --test test/link-admission-wsh.test.mjs
 */
import 'fake-indexeddb/auto'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { createMeshNode } from '../src/mesh-bootstrap.mjs'
import { MeshIdentityManager } from '@johnhenry/browsermesh-core'
import { ManualStrategy } from '@johnhenry/browsermesh-discovery'
import { createInProcessPipeRelay } from '@johnhenry/browsermesh-transport/wsh-in-process'

const RELAY = 'wss://relay.invalid'

async function waitFor(fn, timeoutMs = 4000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}
const quiet = (ms = 80) => new Promise((r) => setTimeout(r, ms))

const cleanups = []
afterEach(async () => {
  while (cleanups.length) { try { await cleanups.pop()() } catch { /* best effort */ } }
})

let runId = 0
async function makeNode(env, label, extra = {}) {
  const node = await createMeshNode({
    label,
    signalingTransport: { send() {}, onMessage() {} },
    discoveryStrategies: [new ManualStrategy()],
    wsh: { relays: [RELAY], WebSocket: env.WebSocket, reconnect: { baseMs: 5, maxMs: 25 }, connectTimeoutMs: 3000 },
    ...extra,
    syncDbName: `link-admission-${label}-${++runId}-${Date.now()}`,
  })
  cleanups.push(async () => { await node.wsh.links.close(); await node.shutdown(); await node.signaling.close() })
  return node
}

/** Bob admits strangers to a restricted link whose handler is `frames`-recording and answers the first frame. */
function bobAdmission(extra = {}) {
  const seen = { links: [], frames: [], events: [] }
  const admission = {
    decide: () => 'restrict',
    handler: (link) => {
      seen.links.push(link)
      link.onFrame((f) => { seen.frames.push({ from: link.peerKey, f }); link.send({ type: 'x:ack' }) })
    },
    onEvent: (e) => seen.events.push(e),
    ...extra,
  }
  return { admission, seen }
}

describe('createMeshNode({ admission }) over wsh', () => {
  it('a stranger is held restricted: the handler gets its frames, the node\'s data handlers never do, and the node has no session for it', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const { admission, seen } = bobAdmission()
    const bob = await makeNode(env, 'bob', { admission })
    const alice = await makeNode(env, 'alice')
    const atBob = []
    bob.onIncomingData((from, data) => atBob.push({ from, data }))
    const atAlice = []
    alice.onIncomingData((from, data) => atAlice.push({ from, data }))

    await alice.connectToPeer(bob.podId, { wsh: bob.podId })
    await alice.sendTo(bob.podId, { type: 'x:hello' })
    await waitFor(() => seen.frames.length === 1, 4000, 'the handler gets the frame')
    assert.equal(seen.frames[0].from, alice.podId)
    assert.deepEqual(seen.frames[0].f, { type: 'x:hello' }, 'a JSON text frame arrives as an object')
    await waitFor(() => atAlice.length === 1, 4000, 'the handler\'s answer reaches the stranger')
    assert.deepEqual(JSON.parse(atAlice[0].data), { type: 'x:ack' })
    await quiet()
    assert.deepEqual(atBob, [], 'no frame of a restricted link reaches onIncomingData')
    assert.equal(bob.hasActiveSession(alice.podId), false)
    assert.equal(bob.wsh.links.isConnected(alice.podId), false)
    assert.equal(bob.admission.stats().restricted, 1)
  })

  it('promote() adopts it like any inbound wsh link: a session, data both ways', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const { admission, seen } = bobAdmission()
    const bob = await makeNode(env, 'bob', { admission })
    const alice = await makeNode(env, 'alice')
    const atBob = []
    bob.onIncomingData((from, data) => atBob.push({ from, data }))
    await alice.connectToPeer(bob.podId, { wsh: bob.podId })
    await alice.sendTo(bob.podId, { type: 'x:hello' })
    await waitFor(() => seen.frames.length === 1)

    assert.equal(seen.links[0].promote(), true)
    await waitFor(() => bob.hasActiveSession(alice.podId), 4000, 'the promoted link is a session')
    assert.equal(bob.sessionsFor(alice.podId)[0].transport, 'wsh')
    await alice.sendTo(bob.podId, 'after promote')
    await waitFor(() => atBob.length === 1)
    assert.equal(atBob[0].from, alice.podId)
    assert.equal(atBob[0].data, 'after promote')
    assert.equal(seen.frames.length, 1, 'the handler saw nothing after promote')
    await bob.sendTo(alice.podId, 'back')
    assert.equal(bob.admission.stats().restricted, 0)
    assert.equal(bob.admission.stats().promoted, 1)
  })

  it('the deadline closes a link that is never promoted, and the stranger sees it go', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const { admission, seen } = bobAdmission({ deadlineMs: 120 })
    const bob = await makeNode(env, 'bob', { admission })
    const alice = await makeNode(env, 'alice')
    const closed = []
    alice.on('peer:transport-close', (e) => closed.push(e.pubKey))
    await alice.connectToPeer(bob.podId, { wsh: bob.podId })
    await waitFor(() => seen.links.length === 1)
    await waitFor(() => seen.events.some((e) => e.type === 'closed' && e.reason === 'deadline'), 4000, 'deadline event')
    await waitFor(() => closed.includes(bob.podId), 4000, 'the stranger\'s link closed')
    assert.equal(bob.admission.stats().deadlines, 1)
    assert.equal(bob.admission.stats().restricted, 0)
  })

  it('a link over maxRestricted is refused with restricted-full', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const { admission, seen } = bobAdmission({ maxRestricted: 1 })
    const bob = await makeNode(env, 'bob', { admission })
    const alice = await makeNode(env, 'alice')
    const carol = await makeNode(env, 'carol')
    await alice.connectToPeer(bob.podId, { wsh: bob.podId })
    await waitFor(() => seen.links.length === 1)
    await carol.wsh.links.connect(bob.podId, { keep: false }).catch(() => {})
    await waitFor(() => seen.events.some((e) => e.type === 'refused' && e.reason === 'restricted-full'), 4000, 'refusal event')
    assert.equal(seen.links.length, 1, 'the handler never saw the second stranger')
    assert.equal(bob.admission.stats().refusedFull, 1)
    assert.equal(bob.wsh.links.isConnected(carol.podId), false)
  })

  it('decide: a peer the registry already allows is a normal link, and deny refuses', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const { admission, seen } = bobAdmission({ decide: () => 'deny' })
    const bob = await makeNode(env, 'bob', { admission })
    const alice = await makeNode(env, 'alice')
    const carol = await makeNode(env, 'carol')
    bob.registry.grantCapabilities(alice.podId, ['mesh:link:connect'])
    await alice.connectToPeer(bob.podId, { wsh: bob.podId })
    await waitFor(() => bob.hasActiveSession(alice.podId), 4000, 'registry-allowed peer is a normal session')
    assert.equal(seen.links.length, 0)
    await assert.rejects(carol.wsh.links.connect(bob.podId, { keep: false }), (e) => e.code === 'WSH_REFUSED')
    assert.equal(seen.links.length, 0)
    assert.equal(bob.admission.stats().denied, 1)
  })

  it('without the admission option nothing changes: a stranger is refused and there is no seam', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const bob = await makeNode(env, 'bob')
    const alice = await makeNode(env, 'alice')
    assert.equal(bob.admission, undefined)
    await assert.rejects(alice.wsh.links.connect(bob.podId, { keep: false }), (e) => e.code === 'WSH_REFUSED')
    assert.equal(bob.wsh.links.isConnected(alice.podId), false)
  })

  it('works together with the identity option: the adopted key is the one a stranger reaches, restricted', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const manager = new MeshIdentityManager()
    const { podId } = await manager.create('kept')
    const { admission, seen } = bobAdmission()
    const bob = await makeNode(env, 'bob', { admission, identityManager: manager, identity: { podId } })
    const alice = await makeNode(env, 'alice')
    assert.equal(bob.podId, podId)
    assert.equal(manager.list().length, 1)
    await alice.connectToPeer(bob.podId, { wsh: bob.podId })
    await alice.sendTo(bob.podId, { type: 'x:hello' })
    await waitFor(() => seen.frames.length === 1, 4000, 'the handler gets the frame')
    assert.equal(seen.frames[0].from, alice.podId)
    assert.equal(bob.hasActiveSession(alice.podId), false)
    seen.links[0].promote()
    await waitFor(() => bob.hasActiveSession(alice.podId))
  })
})

describe('createMeshNode({ admission, wsh }) against a transport without the restricted capability', () => {
  it('warns through onLog when the loaded WshPeerLinks does not advertise supportsRestrictedAdmission', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const logs = []
    class OldLinks {
      constructor() {}
      on() { return () => {} }
      async listen() {}
      async close() {}
    }
    const { admission } = bobAdmission()
    try {
      await makeNode(env, 'old', { admission, onLog: (tag, data) => logs.push({ tag, data }), wsh: { relays: [RELAY], WebSocket: env.WebSocket, WshPeerLinks: OldLinks, listen: false } })
    } catch { /* the stub is not a full transport: the warning is logged before it is used */ }
    assert.ok(logs.some((l) => l.tag === 'mesh-bootstrap:admission-restricted-unsupported'), `no warning in ${JSON.stringify(logs)}`)
  })

  it('does not warn with the real WshPeerLinks', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const logs = []
    const { admission } = bobAdmission()
    await makeNode(env, 'new', { admission, onLog: (tag) => logs.push(tag) })
    assert.ok(!logs.includes('mesh-bootstrap:admission-restricted-unsupported'))
  })
})
