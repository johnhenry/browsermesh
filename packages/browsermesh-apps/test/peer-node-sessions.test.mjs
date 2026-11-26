/**
 * PeerNode sessions follow their transport.
 *
 * - One transport object is one session: adopting it again (a peer that started over on the same connection) must not
 *   add a second session, or every inbound message is delivered once per session.
 * - A session whose transport reports itself closed is not active any more: `hasActiveSession` and `sendTo` stop
 *   counting it, so a dialler is not told "linked" about a link that is gone.
 *
 * Run: node --import ./test/_setup-globals.mjs --test test/peer-node-sessions.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { PeerNode } from '../src/peer-node.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'

async function bootedNode(label, extra = {}) {
  const identityManager = new MeshIdentityManager({})
  const wallet = new IdentityWallet({ identityManager })
  const { podId } = await wallet.createIdentity(label)
  const registry = new PeerRegistry({ localPodId: podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: podId }) })
  const node = new PeerNode({ wallet, registry, ...extra })
  await node.boot()
  return node
}

/** A transport the test drives by hand. Like the real ones, it is `closed` by the time it says so (unless it says it only dropped). */
function fakeTransport({ finishes = true } = {}) {
  const t = {
    sent: [],
    messageCbs: [],
    closeCbs: [],
    state: 'connected',
    send(data) { t.sent.push(data) },
    onMessage(cb) { t.messageCbs.push(cb) },
    onClose(cb) { t.closeCbs.push(cb) },
    receive(data) { for (const cb of t.messageCbs) cb(data) },
    close() { t.state = finishes ? 'closed' : 'disconnected'; for (const cb of t.closeCbs) cb() },
  }
  return t
}

describe('a peer that started over on the connection it had', () => {
  it('adopting with `restarted` says so once, as `peer:transport-restart`; adopting a first connection says nothing', async () => {
    const node = await bootedNode('a')
    const seen = []
    node.on('peer:transport-restart', (e) => seen.push(e))
    const transport = fakeTransport()
    const first = await node.adoptIncomingSession('peer-x', transport, 'webrtc', { restarted: false })
    assert.deepEqual(seen, [])
    const again = await node.adoptIncomingSession('peer-x', transport, 'webrtc', { restarted: true })
    assert.equal(again.sessionId, first.sessionId, 'the session is the same one (one transport, one session)')
    assert.deepEqual(seen, [{ pubKey: 'peer-x', sessionId: first.sessionId, transport: 'webrtc', connectionId: 'default' }])
    await node.adoptIncomingSession('peer-x', transport, 'webrtc') // the option is optional: nothing more is said
    assert.equal(seen.length, 1)
  })
})

describe('one transport, one session', () => {
  it('adopting the same transport again returns the same session and delivers each message once', async () => {
    const node = await bootedNode('a')
    const transport = fakeTransport()
    const first = await node.adoptIncomingSession('peer-x', transport, 'webrtc')
    const second = await node.adoptIncomingSession('peer-x', transport, 'webrtc')
    assert.equal(second.sessionId, first.sessionId)
    assert.equal(node.sessionsFor('peer-x').length, 1)
    const got = []
    node.onIncomingData((from, data) => got.push([from, data]))
    transport.receive('hello')
    assert.deepEqual(got, [['peer-x', 'hello']])
  })

  it('two different transports are two sessions, as before (one per path)', async () => {
    const node = await bootedNode('a')
    await node.adoptIncomingSession('peer-x', fakeTransport(), 'webrtc')
    await node.adoptIncomingSession('peer-x', fakeTransport(), 'wsh')
    assert.equal(node.sessionsFor('peer-x').length, 2)
  })

  it('connectToPeer with a transport that already has a session returns that session', async () => {
    const transport = fakeTransport()
    const dialler = await bootedNode('a', { transportNegotiator: { negotiate: async () => transport } })
    await dialler.adoptIncomingSession('peer-x', transport, 'webrtc')
    const again = await dialler.connectToPeer('peer-x', { webrtc: 'peer-x' })
    assert.equal(dialler.sessionsFor('peer-x').length, 1)
    assert.equal(again.sessionId, dialler.sessionsFor('peer-x')[0].sessionId)
  })
})

describe('a session whose transport closed is not active', () => {
  it('hasActiveSession turns false, sendTo refuses, and the event still fires', async () => {
    const node = await bootedNode('a')
    const transport = fakeTransport()
    await node.adoptIncomingSession('peer-x', transport, 'webrtc')
    const events = []
    node.on('peer:transport-close', (e) => events.push(e))
    assert.equal(node.hasActiveSession('peer-x'), true)
    transport.close()
    assert.equal(node.hasActiveSession('peer-x'), false)
    await assert.rejects(node.sendTo('peer-x', 'x'), /no active session/)
    assert.equal(events.length, 1)
    assert.equal(events[0].pubKey, 'peer-x')
    assert.deepEqual(node.sessionsFor('peer-x'), [])
  })

  it('a transport that only dropped and redials itself (a wsh link) keeps its session, as before', async () => {
    const node = await bootedNode('a')
    const link = fakeTransport({ finishes: false })
    await node.adoptIncomingSession('peer-x', link, 'wsh')
    const events = []
    node.on('peer:transport-close', (e) => events.push(e))
    link.close()
    assert.equal(events.length, 1, 'the event still fires')
    assert.equal(node.hasActiveSession('peer-x'), true)
    link.state = 'connected'
    await node.sendTo('peer-x', 'after the redial')
    assert.deepEqual(link.sent, ['after the redial'])
  })

  it('a transport that does not say what state it is in keeps its session, as before', async () => {
    const node = await bootedNode('a')
    const bare = { send() {}, onMessage() {}, onClose(cb) { bare.fire = cb } }
    await node.adoptIncomingSession('peer-x', bare, 'inmemory')
    bare.fire()
    assert.equal(node.hasActiveSession('peer-x'), true)
  })

  it('another live session of the same peer keeps the peer reachable', async () => {
    const node = await bootedNode('a')
    const dead = fakeTransport()
    const live = fakeTransport()
    await node.adoptIncomingSession('peer-x', dead, 'webrtc')
    await node.adoptIncomingSession('peer-x', live, 'wsh')
    dead.close()
    assert.equal(node.hasActiveSession('peer-x'), true)
    await node.sendTo('peer-x', 'x')
    assert.deepEqual(live.sent, ['x'])
  })

  it('a new session for the same peer after the close is a normal active session', async () => {
    const node = await bootedNode('a')
    const old = fakeTransport()
    await node.adoptIncomingSession('peer-x', old, 'webrtc')
    old.close()
    const fresh = fakeTransport()
    await node.adoptIncomingSession('peer-x', fresh, 'webrtc')
    assert.equal(node.hasActiveSession('peer-x'), true)
    await node.sendTo('peer-x', 'y')
    assert.deepEqual(fresh.sent, ['y'])
    assert.deepEqual(old.sent, [])
  })
})
