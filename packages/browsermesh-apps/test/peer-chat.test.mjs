/**
 * Tests for peer-chat.mjs -- P2P chat, migrated off `PeerSession` onto the
 * `MeshService` convention (Phase 9 of the browsermesh-app-layer-migration
 * plan, issue #84). See that file's own module doc comment for the full
 * design writeup (why `sendMessage()`/`sendTyping()` now take an explicit
 * target pubKey, and why signature verification keys off each message's
 * real sender instead of one fixed constructor-time key).
 *
 * Three layers, matching this family's established test structure
 * (peer-routing.test.mjs is the direct precedent -- class unit tests, then
 * MeshService integration tests over a real duck-typed multi-peer bus with
 * real `PeerRegistry`/`IdentityWallet`, then `createMeshNode()` wiring):
 *   - `PeerChat` class, in isolation, with a bare mock `send()` function
 *     (no more mocked `PeerSession`).
 *   - `createChatService()`, wired between two real `IdentityWallet`/
 *     `PeerRegistry` peers over an in-memory duck-typed bus (mirrors
 *     mesh-rpc.test.mjs's `wireNodes()`), including a real two-peer
 *     conversation, `ctx.emit()` observability, and a real Ed25519
 *     sign/verify round trip.
 *   - `createMeshNode({ enableChat, chatOptions })` wiring.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/peer-chat.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// Provide crypto.randomUUID if not available
if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

import { PeerChat, createChatService } from '../src/peer-chat.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { createMeshNode } from '../src/mesh-bootstrap.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

// ===========================================================================
// PeerChat -- unit tests, bare mock `send()` (no PeerSession involved)
// ===========================================================================

/** A minimal duck-typed transport: records every send() call, no routing logic. */
function createMockSend() {
  const sent = []
  const send = (toPubKey, payload) => { sent.push({ toPubKey, payload }) }
  send.sent = sent
  return send
}

describe('PeerChat', () => {
  let send, chat

  beforeEach(() => {
    send = createMockSend()
    chat = new PeerChat({ localPubKey: 'local', send })
  })

  // -- Constructor ------------------------------------------------------------

  describe('constructor', () => {
    it('throws when localPubKey is missing', () => {
      assert.throws(() => new PeerChat({ send }), /localPubKey is required/)
    })

    it('throws when send is missing or not a function', () => {
      assert.throws(() => new PeerChat({ localPubKey: 'local' }), /send is required/)
      assert.throws(() => new PeerChat({ localPubKey: 'local', send: 'nope' }), /send is required/)
    })
  })

  // -- sendMessage ------------------------------------------------------------

  describe('sendMessage', () => {
    it('throws when toPubKey is missing', async () => {
      await assert.rejects(() => chat.sendMessage(undefined, 'hi'), /toPubKey is required/)
    })

    it('creates message with correct fields', async () => {
      const msg = await chat.sendMessage('remote', 'hello world')
      assert.equal(msg.from, 'local')
      assert.equal(msg.to, 'remote')
      assert.equal(msg.text, 'hello world')
      assert.ok(msg.id)
      assert.equal(typeof msg.timestamp, 'number')
    })

    it('adds sent message to history', async () => {
      await chat.sendMessage('remote', 'one')
      await chat.sendMessage('remote', 'two')
      const history = chat.getHistory()
      assert.equal(history.length, 2)
      assert.equal(history[0].text, 'one')
      assert.equal(history[1].text, 'two')
    })

    it('sends via the injected send() function', async () => {
      await chat.sendMessage('remote', 'hi')
      assert.equal(send.sent.length, 1)
      assert.equal(send.sent[0].toPubKey, 'remote')
      assert.equal(send.sent[0].payload.text, 'hi')
    })
  })

  // -- Incoming messages ------------------------------------------------------

  describe('receiveEnvelope', () => {
    it('received message is added to history', async () => {
      await chat.receiveEnvelope('remote', { id: 'm1', from: 'remote', to: 'local', text: 'hey there', timestamp: Date.now() })
      const history = chat.getHistory()
      assert.equal(history.length, 1)
      assert.equal(history[0].text, 'hey there')
      assert.equal(history[0].from, 'remote')
    })

    it('falls back to fromPubKey when payload.from is missing', async () => {
      await chat.receiveEnvelope('remote', { text: 'no from field', timestamp: Date.now() })
      assert.equal(chat.getHistory()[0].from, 'remote')
    })

    it('drops a message with missing/invalid text', async () => {
      await chat.receiveEnvelope('remote', { from: 'remote', timestamp: Date.now() })
      assert.equal(chat.getHistory().length, 0)
    })
  })

  // -- getHistory / clearHistory ----------------------------------------------

  describe('getHistory / clearHistory', () => {
    it('getHistory returns a copy', async () => {
      await chat.sendMessage('remote', 'msg')
      const h1 = chat.getHistory()
      h1.push({ fake: true })
      assert.equal(chat.getHistory().length, 1)
    })

    it('clearHistory empties history', async () => {
      await chat.sendMessage('remote', 'msg')
      chat.clearHistory()
      assert.equal(chat.getHistory().length, 0)
    })
  })

  // -- Events -----------------------------------------------------------------

  describe('events', () => {
    it('message:sent fires on sendMessage', async () => {
      const events = []
      chat.on('message:sent', (msg) => events.push(msg))
      await chat.sendMessage('remote', 'hello')
      assert.equal(events.length, 1)
      assert.equal(events[0].text, 'hello')
    })

    it('message:received fires on incoming message', async () => {
      const events = []
      chat.on('message:received', (msg) => events.push(msg))
      await chat.receiveEnvelope('remote', { id: 'm1', from: 'remote', to: 'local', text: 'yo', timestamp: Date.now() })
      assert.equal(events.length, 1)
      assert.equal(events[0].text, 'yo')
    })

    it('typing fires on incoming typing indicator, does not touch history', async () => {
      const events = []
      chat.on('typing', (data) => events.push(data))
      await chat.receiveEnvelope('remote', { kind: 'typing', from: 'remote' })
      assert.equal(events.length, 1)
      assert.equal(events[0].from, 'remote')
      assert.equal(chat.getHistory().length, 0)
    })

    it('off removes listener', async () => {
      const events = []
      const cb = (msg) => events.push(msg)
      chat.on('message:sent', cb)
      chat.off('message:sent', cb)
      await chat.sendMessage('remote', 'hello')
      assert.equal(events.length, 0)
    })
  })

  // -- Auto-responder ---------------------------------------------------------

  describe('auto-responder', () => {
    it('sends reply on incoming message', async () => {
      const autoSend = createMockSend()
      const autoChat = new PeerChat({
        localPubKey: 'local',
        send: autoSend,
        autoResponder: async (msg) => `Reply to: ${msg.text}`,
      })

      await autoChat.receiveEnvelope('remote', { id: 'm1', from: 'remote', to: 'local', text: 'question?', timestamp: Date.now() })

      const reply = autoSend.sent.find((s) => s.payload?.text?.includes('Reply to:'))
      assert.ok(reply, 'Expected an auto-reply to be sent')
      assert.equal(reply.toPubKey, 'remote')
      assert.equal(reply.payload.isAutoResponse, true)
    })

    it('does not send reply when autoResponder returns null', async () => {
      const autoSend = createMockSend()
      const autoChat = new PeerChat({
        localPubKey: 'local',
        send: autoSend,
        autoResponder: async () => null,
      })

      await autoChat.receiveEnvelope('remote', { id: 'm1', from: 'remote', to: 'local', text: 'ignored', timestamp: Date.now() })

      assert.equal(autoSend.sent.length, 0)
    })

    it('never auto-responds to an incoming auto-response (loop guard)', async () => {
      const autoSend = createMockSend()
      const autoChat = new PeerChat({
        localPubKey: 'local',
        send: autoSend,
        autoResponder: async () => 'should not be sent',
      })

      await autoChat.receiveEnvelope('remote', { id: 'm1', from: 'remote', text: 'auto reply', timestamp: Date.now(), isAutoResponse: true })

      assert.equal(autoSend.sent.length, 0)
    })
  })

  // -- sendTyping -------------------------------------------------------------

  describe('sendTyping', () => {
    it('throws when toPubKey is missing', async () => {
      await assert.rejects(() => chat.sendTyping(undefined), /toPubKey is required/)
    })

    it('sends a typing indicator keyed by kind (not type, to avoid colliding with the envelope type)', async () => {
      await chat.sendTyping('remote')
      assert.equal(send.sent.length, 1)
      assert.equal(send.sent[0].toPubKey, 'remote')
      assert.equal(send.sent[0].payload.kind, 'typing')
      assert.equal(send.sent[0].payload.from, 'local')
    })
  })

  // -- Signing / verification ---------------------------------------------------

  describe('signing', () => {
    it('signs an outgoing message when signFn is supplied', async () => {
      const signingChat = new PeerChat({
        localPubKey: 'local',
        send,
        signFn: async () => new Uint8Array([1, 2, 3]),
      })
      const msg = await signingChat.sendMessage('remote', 'signed')
      assert.ok(msg.signature)
    })

    it('logs and sends unsigned when signFn throws', async () => {
      const logs = []
      const signingChat = new PeerChat({
        localPubKey: 'local',
        send,
        signFn: async () => { throw new Error('boom') },
        onLog: (level, msg) => logs.push(msg),
      })
      const msg = await signingChat.sendMessage('remote', 'oops')
      assert.equal(msg.signature, undefined)
      assert.ok(logs.some((l) => l.includes('Failed to sign message')))
    })
  })

  describe('verification', () => {
    it('calls verifyFn with the ACTUAL sender (fromPubKey), not a fixed key', async () => {
      const seen = []
      const verifyingChat = new PeerChat({
        localPubKey: 'local',
        send,
        verifyFn: async (fromPubKey) => { seen.push(fromPubKey); return true },
      })
      await verifyingChat.receiveEnvelope('alice', { from: 'alice', text: 'hi', timestamp: Date.now(), signature: Buffer.from([1, 2, 3]).toString('base64') })
      await verifyingChat.receiveEnvelope('bob', { from: 'bob', text: 'hi', timestamp: Date.now(), signature: Buffer.from([1, 2, 3]).toString('base64') })
      assert.deepEqual(seen, ['alice', 'bob'])
    })

    it('marks verified: false when verifyFn is set but no signature is present', async () => {
      const verifyingChat = new PeerChat({
        localPubKey: 'local',
        send,
        verifyFn: async () => true,
      })
      await verifyingChat.receiveEnvelope('remote', { from: 'remote', text: 'unsigned', timestamp: Date.now() })
      assert.equal(verifyingChat.getHistory()[0].verified, false)
    })

    it('marks verified: false and logs when verifyFn throws', async () => {
      const logs = []
      const verifyingChat = new PeerChat({
        localPubKey: 'local',
        send,
        verifyFn: async () => { throw new Error('bad sig') },
        onLog: (level, msg) => logs.push(msg),
      })
      await verifyingChat.receiveEnvelope('remote', { from: 'remote', text: 'x', timestamp: Date.now(), signature: Buffer.from([1]).toString('base64') })
      assert.equal(verifyingChat.getHistory()[0].verified, false)
      assert.ok(logs.some((l) => l.includes('Signature verification failed')))
    })
  })

  // -- close --------------------------------------------------------------------

  describe('close', () => {
    it('clears listeners -- no further events delivered', async () => {
      const events = []
      chat.on('message:received', (msg) => events.push(msg))
      chat.close()
      await chat.receiveEnvelope('remote', { id: 'm2', from: 'remote', to: 'local', text: 'after close', timestamp: Date.now() })
      assert.equal(events.length, 0)
    })
  })

  // -- History cap ----------------------------------------------------------------

  describe('history cap', () => {
    it('enforces maxHistory limit', async () => {
      const limitedChat = new PeerChat({ localPubKey: 'local', send: createMockSend(), maxHistory: 5 })
      for (let i = 0; i < 10; i++) {
        await limitedChat.sendMessage('remote', `msg-${i}`)
      }
      const history = limitedChat.getHistory()
      assert.equal(history.length, 5)
      assert.equal(history[0].text, 'msg-5')
      assert.equal(history[4].text, 'msg-9')
    })
  })

  // -- toJSON -----------------------------------------------------------------

  describe('toJSON', () => {
    it('serializes without any PeerSession-era fields (sessionId/remotePodId)', async () => {
      await chat.sendMessage('remote', 'hi')
      const json = chat.toJSON()
      assert.equal(json.localPubKey, 'local')
      assert.equal(json.messageCount, 1)
      assert.equal('sessionId' in json, false)
      assert.equal('remotePodId' in json, false)
    })
  })
})

// ===========================================================================
// createChatService -- real PeerRegistry/IdentityWallet peers over an
// in-memory duck-typed bus, mirroring mesh-rpc.test.mjs's wireNodes()
// ===========================================================================

/** A real Ed25519 identity + wallet + registry bundle for one "peer". */
async function createPeer(label) {
  const identityManager = new MeshIdentityManager({})
  const wallet = new IdentityWallet({ identityManager })
  const { podId } = await wallet.createIdentity(label)
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId }),
  })
  return { podId, wallet, registry }
}

/** Minimal duck-typed PeerNode pair sharing one in-memory bus (mesh-rpc.test.mjs's own pattern). */
function wireNodes(peerA, peerB) {
  const listenersA = new Set()
  const listenersB = new Set()

  const nodeA = {
    podId: peerA.podId,
    wallet: peerA.wallet,
    registry: peerA.registry,
    onIncomingData(cb) {
      listenersA.add(cb)
      return () => listenersA.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersB) cb(peerA.podId, data)
      })
    },
  }
  const nodeB = {
    podId: peerB.podId,
    wallet: peerB.wallet,
    registry: peerB.registry,
    onIncomingData(cb) {
      listenersB.add(cb)
      return () => listenersB.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersA) cb(peerB.podId, data)
      })
    },
  }
  return { nodeA, nodeB }
}

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs = 1000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

describe('createChatService', () => {
  it('a real two-peer conversation: both sides send/receive, both see correct history', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    const { api: aliceChat } = attachService(nodeA, undefined, createChatService({}))
    const { api: bobChat } = attachService(nodeB, undefined, createChatService({}))

    await aliceChat.sendMessage(bob.podId, 'hi bob')
    await waitFor(() => bobChat.getHistory().length === 1, 1000, "bob to receive alice's message")

    await bobChat.sendMessage(alice.podId, 'hi alice')
    await waitFor(() => aliceChat.getHistory().length === 2, 1000, "alice to receive bob's reply")

    // Alice's history: her own sent message + bob's reply.
    const aliceHistory = aliceChat.getHistory()
    assert.equal(aliceHistory.length, 2)
    assert.equal(aliceHistory[0].from, alice.podId)
    assert.equal(aliceHistory[0].to, bob.podId)
    assert.equal(aliceHistory[0].text, 'hi bob')
    assert.equal(aliceHistory[1].from, bob.podId)
    assert.equal(aliceHistory[1].text, 'hi alice')

    // Bob's history: alice's message he received + his own sent reply.
    const bobHistory = bobChat.getHistory()
    assert.equal(bobHistory.length, 2)
    assert.equal(bobHistory[0].from, alice.podId)
    assert.equal(bobHistory[0].text, 'hi bob')
    assert.equal(bobHistory[1].from, bob.podId)
    assert.equal(bobHistory[1].to, alice.podId)
    assert.equal(bobHistory[1].text, 'hi alice')
  })

  it('typing indicators are delivered and do not appear in history', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    const { api: aliceChat } = attachService(nodeA, undefined, createChatService({}))
    const { on: bobOn, api: bobChat } = attachService(nodeB, undefined, createChatService({}))

    const typingEvents = []
    bobOn('chat:typing', (data) => typingEvents.push(data))

    await aliceChat.sendTyping(bob.podId)
    await waitFor(() => typingEvents.length === 1, 1000, 'bob to receive a typing indicator')

    assert.equal(typingEvents[0].from, alice.podId)
    assert.equal(bobChat.getHistory().length, 0)
  })

  it('ctx.emit() bridges chat:message-sent / chat:message-received', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    const { api: aliceChat, on: aliceOn } = attachService(nodeA, undefined, createChatService({}))
    const { on: bobOn } = attachService(nodeB, undefined, createChatService({}))

    const sentEvents = []
    const receivedEvents = []
    aliceOn('chat:message-sent', (msg) => sentEvents.push(msg))
    bobOn('chat:message-received', (msg) => receivedEvents.push(msg))

    await aliceChat.sendMessage(bob.podId, 'ping')
    await waitFor(() => receivedEvents.length === 1, 1000, 'bob to emit chat:message-received')

    assert.equal(sentEvents.length, 1)
    assert.equal(sentEvents[0].text, 'ping')
    assert.equal(receivedEvents[0].text, 'ping')
    assert.equal(receivedEvents[0].from, alice.podId)
  })

  it('real Ed25519 sign/verify round trip: bob verifies alice really sent it', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    // Out-of-band directory (podId -> raw pubkey bytes), the same gap
    // mesh-timestamp.mjs's own doc comment declines to solve inside the
    // thin wrapper itself -- a real caller resolves it however it likes.
    const aliceBytes = await alice.wallet.getPublicKeyBytes(alice.podId)
    const pubKeyDirectory = new Map([[alice.podId, aliceBytes]])

    const { api: aliceChat } = attachService(nodeA, undefined, createChatService({
      signFn: (data) => alice.wallet.sign(alice.podId, data),
    }))
    const { api: bobChat } = attachService(nodeB, undefined, createChatService({
      verifyFn: (fromPubKey, data, sig) => {
        const pubKeyBytes = pubKeyDirectory.get(fromPubKey)
        if (!pubKeyBytes) return false
        return bob.wallet.verify(pubKeyBytes, data, sig)
      },
    }))

    await aliceChat.sendMessage(bob.podId, 'trust me')
    await waitFor(() => bobChat.getHistory().length === 1, 1000, 'bob to receive the signed message')

    assert.equal(bobChat.getHistory()[0].verified, true)
  })

  it('an unsigned/forged message fails verification (verified: false), not thrown', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const mallory = await createPeer('mallory')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    const aliceBytes = await alice.wallet.getPublicKeyBytes(alice.podId)
    const pubKeyDirectory = new Map([[alice.podId, aliceBytes]])

    // Alice signs with MALLORY's key (simulating a mismatched/forged signature).
    const { api: aliceChat } = attachService(nodeA, undefined, createChatService({
      signFn: (data) => mallory.wallet.sign(mallory.podId, data),
    }))
    const { api: bobChat } = attachService(nodeB, undefined, createChatService({
      verifyFn: (fromPubKey, data, sig) => {
        const pubKeyBytes = pubKeyDirectory.get(fromPubKey)
        if (!pubKeyBytes) return false
        return bob.wallet.verify(pubKeyBytes, data, sig)
      },
    }))

    await aliceChat.sendMessage(bob.podId, 'not really from alice key')
    await waitFor(() => bobChat.getHistory().length === 1, 1000, 'bob to receive the forged message')

    assert.equal(bobChat.getHistory()[0].verified, false)
  })

  it('auto-responder wired through the service replies once, never loops', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    const { api: aliceChat } = attachService(nodeA, undefined, createChatService({}))
    attachService(nodeB, undefined, createChatService({
      autoResponder: async (msg) => `echo: ${msg.text}`,
    }))

    await aliceChat.sendMessage(bob.podId, 'ping')
    await waitFor(() => aliceChat.getHistory().length === 2, 1000, "alice to receive bob's auto-reply")

    const aliceHistory = aliceChat.getHistory()
    assert.equal(aliceHistory[1].text, 'echo: ping')
    assert.equal(aliceHistory[1].from, bob.podId)

    // No further messages arrive -- the auto-response's own isAutoResponse
    // flag stopped a reply-to-a-reply loop.
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(aliceChat.getHistory().length, 2)
  })

  it('teardown() unsubscribes -- no further messages are delivered', async () => {
    const alice = await createPeer('alice')
    const bob = await createPeer('bob')
    const { nodeA, nodeB } = wireNodes(alice, bob)

    const { api: aliceChat } = attachService(nodeA, undefined, createChatService({}))
    const { api: bobChat, teardown } = attachService(nodeB, undefined, createChatService({}))

    await teardown()

    await aliceChat.sendMessage(bob.podId, 'anyone there?')
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(bobChat.getHistory().length, 0)
  })
})

// ===========================================================================
// createMeshNode({ enableChat, chatOptions })
// ===========================================================================

/** Stub signaling transport -- never actually used since no real WebRTC offer/answer is exchanged. */
function createStubSignalingTransport() {
  return { send() {}, onMessage() {} }
}

describe('createMeshNode({ enableChat: true })', () => {
  it('leaves node.chat unset and node.services empty of "chat" when enableChat is omitted', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
    })

    assert.equal(node.chat, undefined)
    assert.equal(node.services.has('chat'), false)
  })

  it('attaches node.chat (== node.services.get("chat")) when enableChat is set', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableChat: true,
      skipBoot: true,
    })

    assert.ok(node.chat, 'node.chat is attached')
    assert.equal(node.chat, node.services.get('chat'))
    assert.equal(typeof node.chat.api.sendMessage, 'function')
    assert.equal(typeof node.chat.api.sendTyping, 'function')
    assert.equal(typeof node.chat.api.getHistory, 'function')
    assert.equal(typeof node.chat.api.clearHistory, 'function')
    assert.deepEqual(node.chat.api.getHistory(), [])
  })

  it('chatOptions are forwarded to createChatService() (maxHistory observably enforced)', async () => {
    // Exercise createChatService()'s attach() directly against a minimal
    // duck-typed ctx (mesh-service.mjs's own MeshServiceContext shape) --
    // no real transport/session needed to observe that chatOptions reached
    // the constructed service.
    const sent = []
    const descriptor = createChatService({ maxHistory: 2 })
    const { api } = descriptor.attach({ podId: 'local' }, {
      onIncomingData: () => () => {},
      sendTo: async (pubKey, type, payload) => { sent.push({ pubKey, type, payload }) },
      emit() {},
    })

    await api.sendMessage('remote', 'one')
    await api.sendMessage('remote', 'two')
    await api.sendMessage('remote', 'three')

    assert.equal(sent.length, 3)
    assert.equal(api.getHistory().length, 2)
    assert.equal(api.getHistory()[0].text, 'two')
    assert.equal(api.getHistory()[1].text, 'three')
  })
})
