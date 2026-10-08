/**
 * Tests for the PeerNode wire plumbing fixed together in browsermesh
 * #208 (envelope encoding on a real wire), #198 (bulk-lane `sendTo`) and
 * #193 (`PeerNode.broadcast()` + the `wireTransport()` helper).
 *
 * The fakes here deliberately behave like a real data channel rather than
 * like the in-process node doubles most MeshService tests use: whatever is
 * sent comes out the other side as a STRING (or binary), never as the
 * original object. A service that only works when objects pass through
 * untouched fails against these, the way it failed over real WebRTC.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/wire-plumbing.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

import { PeerNode } from '../src/peer-node.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createPeerNodeTransport } from '../src/peer-node-transport.mjs'
import { createTorrentService } from '../src/mesh-torrent.mjs'
import { PaymentRouter, PAYMENT_OPEN } from '../src/payments.mjs'
import { ConsensusManager, CONSENSUS_VOTE } from '../src/consensus.mjs'
import { MeshSyncBinding } from '../src/mesh-sync.mjs'
import { MeshRelayHost } from '../src/mesh-relay-host.mjs'
import { createMeshRelayBackend } from '../src/mesh-relay-backend.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { MeshSyncEngine } from '@johnhenry/browsermesh-sync'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { VirtualNetwork } from '@johnhenry/browsermesh-netway'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWallet(podId) {
  return {
    async createIdentity(label) { return { podId, label } },
    listIdentities() { return [{ podId }] },
    getDefault() { return { podId } },
    setDefault() {},
    async sign() { return new Uint8Array([1]) },
    toJSON() { return {} },
  }
}

function makeRegistry() {
  const peers = new Map()
  const cbs = []
  return {
    addPeer(pubKey) { peers.set(pubKey, { fingerprint: pubKey, status: 'disconnected' }); return peers.get(pubKey) },
    removePeer(pubKey) { return peers.delete(pubKey) },
    getPeer(pubKey) { return peers.get(pubKey) || null },
    listPeers() { return [...peers.values()] },
    connect(pubKey) {
      const p = peers.get(pubKey) || this.addPeer(pubKey)
      p.status = 'connected'
      cbs.forEach((cb) => cb(p))
      return p
    },
    disconnect(pubKey) { const p = peers.get(pubKey); if (p) p.status = 'disconnected' },
    disconnectAll() {},
    onPeerConnect() {},
    onPeerDisconnect() {},
    getStats() { return {} },
    get size() { return peers.size },
    toJSON() { return [] },
  }
}

async function makeNode(podId) {
  const node = new PeerNode({ wallet: makeWallet(podId), registry: makeRegistry() })
  await node.boot()
  return node
}

/** Text a real wire would deliver for `data`: strings/binary as-is, anything else JSON (a correct transport). */
function wireText(data) {
  if (typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data
  return JSON.stringify(data)
}

/**
 * Connect two PeerNodes through a pair of string-only transports. Records
 * every `send(data, opts)` call per direction so tests can assert on the
 * options the transport actually received.
 */
async function link(nodeA, nodeB) {
  const sentByA = []
  const sentByB = []
  const cbsA = []
  const cbsB = []
  const makeTransport = (sent, deliverTo) => ({
    send(data, opts) {
      sent.push({ data, opts, argc: arguments.length })
      const text = wireText(data)
      queueMicrotask(() => { for (const cb of deliverTo) cb(text) })
    },
    onMessage(cb) { (deliverTo === cbsB ? cbsA : cbsB).push(cb) },
  })
  const tA = makeTransport(sentByA, cbsB)
  const tB = makeTransport(sentByB, cbsA)
  await nodeA.adoptIncomingSession(await nodeB.podId, tA, 'fake')
  await nodeB.adoptIncomingSession(await nodeA.podId, tB, 'fake')
  return { sentByA, sentByB }
}

const tick = () => new Promise((r) => setTimeout(r, 10))

// ---------------------------------------------------------------------------
// #208 -- inbound: ctx.onIncomingData() over a string-only wire
// ---------------------------------------------------------------------------

describe('#208: a MeshService over a transport that delivers strings', () => {
  let alice, bob
  beforeEach(async () => {
    alice = await makeNode('alice')
    bob = await makeNode('bob')
  })

  it('ctx.onIncomingData() receives the parsed envelope, not the JSON text', async () => {
    await link(alice, bob)
    const seen = []
    attachService(bob, undefined, {
      name: 'echo',
      attach(_node, ctx) {
        return ctx.onIncomingData('zz', (from, msg) => { seen.push({ from, msg }) })
      },
    })
    let aliceCtx
    attachService(alice, undefined, { name: 'sender', attach(_n, ctx) { aliceCtx = ctx; return () => {} } })

    await aliceCtx.sendTo('bob', 'zz', { a: 1 })
    await tick()

    assert.deepEqual(seen, [{ from: 'alice', msg: { type: 'zz', a: 1 } }])
  })

  it('PeerNode.sendTo(pk, object) arrives intact (and raw subscribers still see the wire form)', async () => {
    await link(alice, bob)
    const raw = []
    bob.onIncomingData((from, data) => raw.push(data))
    await alice.sendTo('bob', { type: 'zz', a: 1 })
    await tick()
    assert.equal(raw.length, 1)
    // The raw bus is untouched by this fix: whatever the transport handed up.
    assert.equal(typeof raw[0], 'string')
    assert.deepEqual(JSON.parse(raw[0]), { type: 'zz', a: 1 })
  })

  it('ignores a string that is not a JSON envelope, and survives corrupt JSON', async () => {
    await link(alice, bob)
    const seen = []
    attachService(bob, undefined, {
      name: 'echo',
      attach(_node, ctx) { return ctx.onIncomingData('zz', (_f, msg) => seen.push(msg)) },
    })
    await alice.sendTo('bob', 'plain text')
    await alice.sendTo('bob', '{"type":"zz", oops')
    await alice.sendTo('bob', '42')
    await alice.sendTo('bob', JSON.stringify({ type: 'other' }))
    await alice.sendTo('bob', JSON.stringify({ type: 'zz', ok: true }))
    await tick()
    assert.deepEqual(seen, [{ type: 'zz', ok: true }])
  })

  it('still accepts already-parsed objects (in-process nodes, transports that parse)', async () => {
    const seen = []
    const listeners = new Set()
    const fakeNode = {
      registry: {},
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo() {},
    }
    attachService(fakeNode, undefined, {
      name: 'echo',
      attach(_n, ctx) { return ctx.onIncomingData('zz', (_f, msg) => seen.push(msg)) },
    })
    for (const cb of listeners) cb('peer', { type: 'zz', n: 1 })
    assert.deepEqual(seen, [{ type: 'zz', n: 1 }])
  })

  it('MeshSyncBinding-style direct subscribers also get parsed envelopes', async () => {
    // mesh-sync reads `data.type` straight off the raw bus.
    await link(alice, bob)
    const merged = []
    const engine = {
      get: () => ({}),
      create() {},
      merge: (docId, payload) => merged.push({ docId, payload }),
      onChange() { return () => {} },
    }
    const binding = new MeshSyncBinding({ node: bob, engine })
    await alice.sendTo('bob', { type: 'mesh-sync', docId: 'd1', docType: 'x', payload: { v: 1 } })
    await tick()
    assert.deepEqual(merged, [{ docId: 'd1', payload: { v: 1 } }])
    binding.detach()
  })
})

// ---------------------------------------------------------------------------
// #198 -- channel option
// ---------------------------------------------------------------------------

describe("#198: sendTo(..., { channel }) reaches the transport", () => {
  let alice, bob, wire
  beforeEach(async () => {
    alice = await makeNode('alice')
    bob = await makeNode('bob')
    wire = await link(alice, bob)
  })

  it("PeerNode.sendTo passes { channel: 'bulk' } to transport.send", async () => {
    await alice.sendTo('bob', { type: 'x' }, { channel: 'bulk' })
    assert.deepEqual(wire.sentByA[0].opts, { channel: 'bulk' })
  })

  it('defaults to the control lane: the transport is called exactly as before, with no options', async () => {
    await alice.sendTo('bob', { type: 'x' })
    assert.equal(wire.sentByA[0].argc, 1)
    await alice.sendTo('bob', { type: 'x' }, { connectionId: 'default' })
    assert.equal(wire.sentByA[1].argc, 1)
    await alice.sendTo('bob', { type: 'x' }, { channel: 'control' })
    assert.deepEqual(wire.sentByA[2].opts, { channel: 'control' })
  })

  it('rejects an unknown channel name instead of silently using control', async () => {
    await assert.rejects(() => alice.sendTo('bob', { type: 'x' }, { channel: 'fast' }), TypeError)
    assert.equal(wire.sentByA.length, 0)
  })

  it('#115: a named channel the transport has opened is passed through; one it has not is a TypeError', async () => {
    const solo = await makeNode('solo')
    const sent = []
    await solo.adoptIncomingSession('far', { send(data, opts) { sent.push(opts) }, channels: ['control', 'bulk', 'telemetry'] }, 'plain')
    await solo.sendTo('far', { type: 'x' }, { channel: 'telemetry' })
    assert.deepEqual(sent, [{ channel: 'telemetry' }])
    await assert.rejects(() => solo.sendTo('far', { type: 'x' }, { channel: 'other' }), TypeError)
    await assert.rejects(() => solo.sendTo('far', { type: 'x' }, { channel: 'bad name!' }), TypeError)
    assert.equal(sent.length, 1)
  })

  it('a transport with no bulk lane (one-argument send) simply ignores the option', async () => {
    const solo = await makeNode('solo')
    const got = []
    await solo.adoptIncomingSession('far', { send(data) { got.push(data) } }, 'plain')
    await solo.sendTo('far', { type: 'x' }, { channel: 'bulk' })
    assert.deepEqual(got, [{ type: 'x' }])
  })

  it('ctx.sendTo(pubKey, type, payload, { channel }) forwards it; omitted means two-argument peerNode.sendTo', async () => {
    let ctx
    attachService(alice, undefined, { name: 's', attach(_n, c) { ctx = c; return () => {} } })
    await ctx.sendTo('bob', 'chunk', { n: 1 }, { channel: 'bulk' })
    await ctx.sendTo('bob', 'ping', { n: 2 })
    assert.deepEqual(wire.sentByA[0].data, { type: 'chunk', n: 1 })
    assert.deepEqual(wire.sentByA[0].opts, { channel: 'bulk' })
    assert.equal(wire.sentByA[1].argc, 1)
  })

  it('a pre-#198 duck-typed node never sees a third argument unless a channel was asked for', async () => {
    const calls = []
    const node = { registry: {}, onIncomingData() { return () => {} }, async sendTo(...args) { calls.push(args) } }
    let ctx
    attachService(node, undefined, { name: 's', attach(_n, c) { ctx = c; return () => {} } })
    await ctx.sendTo('p', 't', { a: 1 })
    assert.equal(calls[0].length, 2)
  })
})

describe('#198: chunk-carrying services use the bulk lane', () => {
  it("createTorrentService answers chunk-request with a 'bulk' chunk-response, and keeps requests on control", async () => {
    const alice = await makeNode('alice')
    const bob = await makeNode('bob')
    const wire = await link(alice, bob)
    const { api: aliceApi } = attachService(alice, undefined, createTorrentService({ chunkSize: 4 }))
    const { api: bobApi } = attachService(bob, undefined, createTorrentService({ chunkSize: 4 }))

    const original = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])
    const info = await aliceApi.seed(original, { name: 'x.bin' })
    aliceApi.share(info.magnetURI, ['bob'])
    const { data } = await bobApi.download(info.magnetURI, { peers: ['alice'] })
    assert.deepEqual(data, original)

    const chunkResponses = wire.sentByA.filter((s) => s.data?.kind === 'chunk-response')
    assert.ok(chunkResponses.length >= 3)
    assert.ok(chunkResponses.every((s) => s.opts?.channel === 'bulk'), 'chunk-response must ride the bulk lane')
    const chunkRequests = wire.sentByB.filter((s) => s.data?.kind === 'chunk-request')
    assert.ok(chunkRequests.length >= 3)
    assert.ok(chunkRequests.every((s) => s.argc === 1), 'requests stay on the control lane')
  })
})

// ---------------------------------------------------------------------------
// #193 -- broadcast()
// ---------------------------------------------------------------------------

describe('#193: PeerNode.broadcast()', () => {
  /** A hub with `names.length` peers, each reachable through a recording transport. */
  async function hub(names, { failing = [] } = {}) {
    const node = await makeNode('hub')
    const sent = {}
    for (const name of names) {
      sent[name] = []
      await node.adoptIncomingSession(name, {
        send(data, opts) {
          if (failing.includes(name)) throw new Error(`${name} is down`)
          sent[name].push({ data, opts })
        },
        onMessage() {},
      }, 'fake')
    }
    return { node, sent }
  }

  it('sends to every connected peer and reports who got it', async () => {
    const { node, sent } = await hub(['a', 'b', 'c'])
    const res = await node.broadcast({ type: 'hello' })
    assert.deepEqual(res, { sent: ['a', 'b', 'c'], failed: [] })
    for (const n of ['a', 'b', 'c']) assert.deepEqual(sent[n], [{ data: { type: 'hello' }, opts: undefined }])
  })

  it('collects per-peer errors instead of throwing, and still reaches the others', async () => {
    const { node, sent } = await hub(['a', 'b', 'c'], { failing: ['b'] })
    const res = await node.broadcast({ type: 'hello' })
    assert.deepEqual(res.sent, ['a', 'c'])
    assert.deepEqual(res.failed, [{ pubKey: 'b', error: 'b is down' }])
    assert.equal(sent.a.length, 1)
    assert.equal(sent.c.length, 1)
  })

  it('exclude accepts an array, a Set or a predicate', async () => {
    const { node } = await hub(['a', 'b', 'c'])
    assert.deepEqual((await node.broadcast('m', { exclude: ['a'] })).sent, ['b', 'c'])
    assert.deepEqual((await node.broadcast('m', { exclude: new Set(['b', 'c']) })).sent, ['a'])
    assert.deepEqual((await node.broadcast('m', { exclude: (pk) => pk !== 'c' })).sent, ['c'])
  })

  it("passes { channel } through to every transport", async () => {
    const { node, sent } = await hub(['a', 'b'])
    await node.broadcast({ type: 'chunk' }, { channel: 'bulk' })
    assert.deepEqual(sent.a[0].opts, { channel: 'bulk' })
    assert.deepEqual(sent.b[0].opts, { channel: 'bulk' })
    await assert.rejects(() => node.broadcast({}, { channel: 'not a name!' }), TypeError)
  })

  it('sends once per peer even when a peer has several sessions', async () => {
    const { node, sent } = await hub(['a'])
    await node.adoptIncomingSession('a', { send(data) { sent.a.push({ data, second: true }) }, onMessage() {} }, 'fake', { connectionId: 'second' })
    const res = await node.broadcast('m')
    assert.deepEqual(res.sent, ['a'])
    assert.equal(sent.a.length, 1)
  })

  it('does not send to peers whose session was closed', async () => {
    const { node } = await hub(['a', 'b'])
    node.disconnectPeer('a')
    assert.deepEqual((await node.broadcast('m')).sent, ['b'])
  })

  it('with nobody connected it resolves with empty lists', async () => {
    const node = await makeNode('lonely')
    assert.deepEqual(await node.broadcast('m'), { sent: [], failed: [] })
  })

  it('honours the concurrency bound', async () => {
    const node = await makeNode('hub')
    let inFlight = 0
    let peak = 0
    for (const name of ['a', 'b', 'c', 'd', 'e']) {
      await node.adoptIncomingSession(name, {
        async send() {
          inFlight += 1
          peak = Math.max(peak, inFlight)
          await new Promise((r) => setTimeout(r, 5))
          inFlight -= 1
        },
        onMessage() {},
      }, 'fake')
    }
    await node.broadcast('m', { concurrency: 2 })
    assert.equal(peak, 2)
    peak = 0
    await node.broadcast('m', { concurrency: 1 })
    assert.equal(peak, 1)
  })

  it("emits 'broadcast' with the result, and requires a running node", async () => {
    const { node } = await hub(['a', 'b'], { failing: ['b'] })
    const events = []
    node.on('broadcast', (e) => events.push(e))
    const res = await node.broadcast('m')
    assert.deepEqual(events, [res])
    await node.shutdown()
    await assert.rejects(() => node.broadcast('m'), /must be running/)
  })
})

// ---------------------------------------------------------------------------
// #193 -- wireTransport() helper, end to end over two PeerNodes
// ---------------------------------------------------------------------------

describe('#193: createPeerNodeTransport() wires the four wireTransport() consumers', () => {
  it('a PAYMENT_OPEN broadcast by one PaymentRouter opens a channel on a second PeerNode', async () => {
    const alice = await makeNode('alice')
    const bob = await makeNode('bob')
    await link(alice, bob)

    const routerA = new PaymentRouter('alice')
    const routerB = new PaymentRouter('bob')
    const tA = createPeerNodeTransport(alice)
    const tB = createPeerNodeTransport(bob)
    routerA.wireTransport(tA.broadcastFn, tA.subscribeFn)
    routerB.wireTransport(tB.broadcastFn, tB.subscribeFn)

    assert.equal(routerB.getChannel('alice'), null)
    routerA.openChannel('bob', 100)
    routerA.broadcastOpen('bob', 100)
    await tick()

    assert.ok(routerB.getChannel('alice'),
      "bob's router must hold a channel to alice after receiving PAYMENT_OPEN")
  })

  it('a CONSENSUS_VOTE broadcast is delivered to the subscriber with the transport-authenticated sender', async () => {
    const alice = await makeNode('alice')
    const bob = await makeNode('bob')
    await link(alice, bob)
    const tA = createPeerNodeTransport(alice)
    const tB = createPeerNodeTransport(bob)
    const got = []
    tB.subscribeFn(CONSENSUS_VOTE, (payload, from) => got.push({ payload, from }))

    await tA.broadcastFn(CONSENSUS_VOTE, { proposalId: 'p1', choice: 'yes' })
    await tick()
    assert.deepEqual(got, [{ payload: { proposalId: 'p1', choice: 'yes' }, from: 'alice' }])
  })

  it("ignores an envelope's own `from` claim: the sender is the session's peer", async () => {
    const alice = await makeNode('alice')
    const bob = await makeNode('bob')
    await link(alice, bob)
    const tB = createPeerNodeTransport(bob)
    const got = []
    tB.subscribeFn(7, (payload, from) => got.push(from))
    await alice.sendTo('bob', { type: 7, payload: {}, from: 'mallory' })
    await tick()
    assert.deepEqual(got, ['alice'])
  })

  it('unsubscribe and dispose stop delivery; broadcastFn never rejects', async () => {
    const alice = await makeNode('alice')
    const bob = await makeNode('bob')
    await link(alice, bob)
    const tA = createPeerNodeTransport(alice)
    const tB = createPeerNodeTransport(bob)
    const got = []
    const off = tB.subscribeFn(1, (p) => got.push(p))
    await tA.broadcastFn(1, 'one')
    await tick()
    off()
    await tA.broadcastFn(1, 'two')
    await tick()
    assert.deepEqual(got, ['one'])

    tB.subscribeFn(1, (p) => got.push(p))
    tB.dispose()
    await tA.broadcastFn(1, 'three')
    await tick()
    assert.deepEqual(got, ['one'])

    await alice.shutdown()
    assert.deepEqual(await tA.broadcastFn(1, 'x'), { sent: [], failed: [] })
  })

  it('requires a node that can broadcast', () => {
    assert.throws(() => createPeerNodeTransport({}), /broadcast/)
  })

  it('works as the broadcastFn of ConsensusManager too', async () => {
    const alice = await makeNode('alice')
    const bob = await makeNode('bob')
    await link(alice, bob)
    const cm = new ConsensusManager()
    const t = createPeerNodeTransport(alice)
    cm.wireTransport(t.broadcastFn, t.subscribeFn)
    assert.equal(typeof cm.broadcastVote, 'function')
    const seen = []
    const tB = createPeerNodeTransport(bob)
    tB.subscribeFn(CONSENSUS_VOTE, (p) => seen.push(p))
    cm.broadcastVote('p1', 'alice', 'yes', 1)
    await tick()
    assert.equal(seen[0].proposalId, 'p1')
  })
})

// ---------------------------------------------------------------------------
// #221 -- audit of every raw PeerNode.onIncomingData() subscriber
// ---------------------------------------------------------------------------
//
// `ctx.onIncomingData()` (MeshService) decodes JSON text off a real wire, but
// `PeerNode.onIncomingData()` is the raw bus: it hands subscribers whatever the
// transport delivered, which for a real RTCDataChannel/WebSocket is a STRING.
// A raw subscriber that reads `data.type` off that string sees `undefined` and
// silently drops everything (the bug class fixed for the pod-host client in
// #188). The audit found the remaining raw subscribers -- mesh-sync, the relay
// host and backend, the pod-host service, the mesh-websocket binding, the
// PeerNode transport -- all already route through `decodeWireData`; these tests
// keep it that way and prove it over a string-only wire.

describe('#221: raw PeerNode.onIncomingData() subscribers decode JSON text', () => {
  it('every source file that subscribes to the raw bus imports and uses decodeWireData', () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.mjs') ? [join(dir, e.name)] : [])
    const rawSubscribers = []
    for (const file of walk(srcDir)) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
        .replace(/(^|[^:])\/\/.*$/gm, '$1')    // line comments
      // A call on anything but a MeshService ctx (which decodes for you).
      const raw = [...code.matchAll(/([\w$.#]+)\.onIncomingData\(/g)].filter((m) => !/(^|\.)ctx$/.test(m[1]))
      if (raw.length === 0) continue
      rawSubscribers.push(file)
      assert.match(code, /import \{[^}]*\bdecodeWireData\b[^}]*\} from '[^']*wire-envelope\.mjs'/, `${file} subscribes to the raw bus but does not import decodeWireData`)
      assert.match(code, /\bdecodeWireData\(/, `${file} imports decodeWireData but never calls it`)
    }
    // The audited set. A new raw subscriber must be added here deliberately.
    const names = rawSubscribers.map((f) => f.split('/').pop()).sort()
    assert.deepEqual(names, [
      'mesh-relay-backend.mjs', 'mesh-relay-host.mjs', 'mesh-service.mjs', 'mesh-sync.mjs',
      'mesh-websocket.mjs', 'peer-node-transport.mjs', 'pod-host-service.mjs',
    ])
  })

  it('MeshSyncBinding merges a document sent as JSON text between two real PeerNodes', async () => {
    const alice = await makeNode('alice')
    const bob = await makeNode('bob')
    const wire = await link(alice, bob)
    const engineA = new MeshSyncEngine({ nodeId: 'alice' })
    const engineB = new MeshSyncEngine({ nodeId: 'bob' })
    const bindingA = new MeshSyncBinding({ node: alice, engine: engineA })
    const bindingB = new MeshSyncBinding({ node: bob, engine: engineB })

    engineA.create('notes', 'lww-map')
    engineA.update('notes', (m) => m.set('title', 'hello', 1, 'alice'))
    await bindingA.syncDocWithPeer('bob', 'notes')
    await tick()

    assert.equal(typeof wire.sentByA[0].data, 'object', 'PeerNode.sendTo handed the transport an envelope object')
    assert.deepEqual(engineB.getState('notes'), { title: 'hello' }, 'bob parsed the text and merged it')
    bindingA.detach()
    bindingB.detach()
  })

  it('MeshRelayHost and MeshRelayBackend frame connect -> data -> close over a string-only wire', async () => {
    const alice = await makeNode('alice')
    const bob = await makeNode('bob')
    await link(alice, bob)

    const network = new VirtualNetwork()
    const listener = await network.listen('mem://localhost:9100')
    ;(async () => {
      for (;;) {
        const sock = await listener.accept()
        if (!sock) return
        ;(async () => {
          try { for (;;) { const c = await sock.read(); if (c === null) return; await sock.write(c) } } catch { /* closed */ }
        })()
      }
    })()

    const registry = new PeerRegistry({
      localPodId: 'alice', peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: 'alice' }),
    })
    const host = new MeshRelayHost({ node: alice, network, registry })
    host.exposeService('echo', 'mem://localhost:9100')
    registry.grantCapabilities('bob', ['mesh-relay:echo:connect'])
    const backend = createMeshRelayBackend({ node: bob, relayPeerPubKey: 'alice', connectTimeoutMs: 2000 })

    try {
      // The host must parse the connect request text, and the backend the ok reply text.
      const socket = await backend.connect('echo')
      await socket.write(new TextEncoder().encode('over text'))
      const echoed = await socket.read()
      assert.equal(new TextDecoder().decode(echoed), 'over text')
      await socket.close()
    } finally {
      await backend.close()
      await host.detach()
      await network.close()
    }
  })

  it('an ungranted peer is refused with a real refusal, not a timeout (the backend parsed the refusal text)', async () => {
    const alice = await makeNode('alice')
    const bob = await makeNode('bob')
    await link(alice, bob)
    const network = new VirtualNetwork()
    const registry = new PeerRegistry({
      localPodId: 'alice', peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: 'alice' }),
    })
    const host = new MeshRelayHost({ node: alice, network, registry })
    host.exposeService('echo', 'mem://localhost:9101')
    const backend = createMeshRelayBackend({ node: bob, relayPeerPubKey: 'alice', connectTimeoutMs: 2000 })
    try {
      await assert.rejects(() => backend.connect('echo'), (err) => err.name === 'ConnectionRefusedError')
    } finally {
      await backend.close()
      await host.detach()
      await network.close()
    }
  })
})
