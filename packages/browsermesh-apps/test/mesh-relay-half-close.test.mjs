/**
 * Half-close through the mesh relay (MeshRelayHost + createMeshRelayBackend).
 *
 * The relay carries a netway stream between two mesh peers. A client that has finished sending (`socket.end()`) must still
 * get the answer the service sends later, and a service that finishes first must still receive what the client sends after
 * it (wsh issue 271 is the same shape on wsh's own gateway). Half-close is negotiated: `connect` and `ok` carry
 * `halfClose: true`, and only a connection where both sides said so uses the `end` frame; against a peer that did not, an end
 * of stream is a full close, as it always was. A half-closed connection with nothing moving in either direction for
 * `halfCloseIdleMs` is closed.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-relay-half-close.test.mjs
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { MeshRelayHost } from '../src/mesh-relay-host.mjs'
import { createMeshRelayBackend } from '../src/mesh-relay-backend.mjs'
import { RELAY_FLOW_DEFAULTS } from '../src/internal/relay-flow.mjs'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { VirtualNetwork } from '@johnhenry/browsermesh-netway'

const ALICE = 'alice-pod'
const BOB = 'bob-pod'
const enc = new TextEncoder()
const dec = new TextDecoder()
// Every wait is cancelled when its test ends: a service handler that waits a minute (to stand for one that never answers) must not
// keep the test process alive for that minute after the tests have passed.
const sleeping = new Set()
const sleep = (ms) => new Promise((r) => { const t = setTimeout(() => { sleeping.delete(t); r() }, ms); sleeping.add(t) })

/** Two duck-typed nodes joined by an async bus. `tapAtoB(data)` / `tapBtoA(data)` may record, change (return a new envelope) or drop (return null) what crosses. */
function nodePair({ tapAtoB = (d) => d, tapBtoA = (d) => d } = {}) {
  const listenersA = new Set()
  const listenersB = new Set()
  const a = {
    podId: ALICE,
    onIncomingData(cb) { listenersA.add(cb); return () => listenersA.delete(cb) },
    async sendTo(_to, data) { const out = tapAtoB(data); if (out) queueMicrotask(() => { for (const cb of listenersB) cb(ALICE, out) }) },
  }
  const b = {
    podId: BOB,
    onIncomingData(cb) { listenersB.add(cb); return () => listenersB.delete(cb) },
    async sendTo(_to, data) { const out = tapBtoA(data); if (out) queueMicrotask(() => { for (const cb of listenersA) cb(BOB, out) }) },
  }
  return { a, b }
}

function registry() {
  const r = new PeerRegistry({ localPodId: ALICE, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: ALICE }) })
  r.grantCapabilities(BOB, ['mesh-relay:svc:connect'])
  return r
}

const cleanups = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
  for (const t of sleeping) clearTimeout(t)
  sleeping.clear()
})

/**
 * Alice exposes `svc`, served by `serve(socket)` on a real netway VirtualNetwork; Bob has a backend to it.
 * `hostOptions` / `backendOptions` are the flow options; `taps` change what crosses.
 */
async function rig({ serve, hostOptions = {}, backendOptions = {}, taps = {} }) {
  const network = new VirtualNetwork()
  const listener = await network.listen('mem://localhost:9100')
  const served = []
  ;(async () => {
    for (;;) {
      const socket = await listener.accept()
      if (!socket) break
      served.push(socket)
      Promise.resolve(serve(socket)).catch(() => {})
    }
  })()
  const seen = { toHost: [], toBackend: [] }
  const { a, b } = nodePair({
    tapAtoB: (d) => { seen.toBackend.push(d); return (taps.toBackend ?? ((x) => x))(d) },
    tapBtoA: (d) => { seen.toHost.push(d); return (taps.toHost ?? ((x) => x))(d) },
  })
  const host = new MeshRelayHost({ node: a, network, registry: registry(), recheckIntervalMs: 0, ...hostOptions })
  host.exposeService('svc', 'mem://localhost:9100')
  const backend = createMeshRelayBackend({ node: b, relayPeerPubKey: ALICE, ...backendOptions })
  cleanups.push(async () => { await backend.close(); await host.detach(); await network.close() })
  return { host, backend, seen, served, nodes: { a, b } }
}

/** Read until the socket ends. */
async function readAll(socket) {
  const parts = []
  for (;;) {
    const chunk = await socket.read()
    if (chunk === null) break
    parts.push(chunk)
  }
  return Buffer.concat(parts)
}

const ops = (frames) => frames.map((f) => f.op)

/** A service that reads until the client's end of stream, then calls `answer(socket, received)`. */
const answersAfterEnd = (answer) => async (socket) => {
  const parts = []
  for (;;) {
    const chunk = await socket.read()
    if (chunk === null) break
    parts.push(chunk)
  }
  await answer(socket, Buffer.concat(parts))
}

describe('mesh relay: a client that has finished sending still gets the answer', () => {
  it('an answer that arrives two seconds after the client\'s end of stream is delivered', { timeout: 20_000 }, async () => {
    const { backend, seen } = await rig({
      serve: answersAfterEnd(async (socket, got) => { await sleep(2000); await socket.write(enc.encode(`done:${got.length}`)); await socket.end() }),
    })
    const socket = await backend.connect('svc')
    await socket.write(enc.encode('request'))
    await socket.end()
    assert.equal(dec.decode(await readAll(socket)), 'done:7')
    assert.ok(ops(seen.toHost).includes('end'), 'the client said it was done with an end frame, not a close')
    assert.ok(!ops(seen.toHost).includes('close') || ops(seen.toHost).indexOf('close') > ops(seen.toHost).indexOf('end'))
  })

  it('a large answer after the half-close arrives whole', { timeout: 30_000 }, async () => {
    const size = 2 * 1024 * 1024
    const payload = Buffer.alloc(size)
    for (let i = 0; i < size; i++) payload[i] = (i * 31 + 7) & 0xff
    const { backend } = await rig({
      serve: answersAfterEnd(async (socket) => { await socket.write(new Uint8Array(payload)); await socket.end() }),
    })
    const socket = await backend.connect('svc')
    await socket.end()
    await sleep(100) // the answer is on its way before anyone reads
    const got = await readAll(socket)
    assert.equal(got.length, size)
    assert.ok(got.equals(payload))
  })

  it('both sides finishing ends the connection on both peers with no close frame and nothing held', { timeout: 20_000 }, async () => {
    const { host, backend, seen } = await rig({ serve: answersAfterEnd(async (socket) => { await socket.write(enc.encode('bye')); await socket.end() }) })
    const socket = await backend.connect('svc')
    await socket.end()
    assert.equal(dec.decode(await readAll(socket)), 'bye')
    for (let i = 0; i < 100 && (host.stats().connections || backend.stats().connections); i++) await sleep(5)
    assert.equal(host.stats().connections, 0)
    assert.equal(backend.stats().connections, 0)
    assert.ok(!ops(seen.toHost).includes('close') && !ops(seen.toBackend).includes('close'), `no close frame was needed: ${ops(seen.toHost)} / ${ops(seen.toBackend)}`)
  })
})

describe('mesh relay: a service that has finished sending still gets what the client sends', () => {
  it('the client reads the end of stream, then writes, and the service receives it', { timeout: 20_000 }, async () => {
    let resolveGot
    const got = new Promise((r) => { resolveGot = r })
    const { backend } = await rig({
      serve: async (socket) => {
        await socket.write(enc.encode('greeting'))
        await socket.end() // finished sending, still reading
        resolveGot(dec.decode(await readAll(socket)))
      },
    })
    const socket = await backend.connect('svc')
    assert.equal(dec.decode(await readAll(socket)), 'greeting')
    await socket.write(enc.encode('late reply'))
    await socket.end()
    assert.equal(await got, 'late reply')
  })
})

describe('mesh relay: closing is still closing', () => {
  it('a client that closes its socket (discards it) closes the connection on the host at once, with a close frame', { timeout: 20_000 }, async () => {
    const { host, backend, seen, served } = await rig({ serve: async (socket) => { await readAll(socket) } })
    const socket = await backend.connect('svc')
    await socket.close()
    for (let i = 0; i < 100 && host.stats().connections; i++) await sleep(5)
    assert.equal(host.stats().connections, 0)
    assert.equal(backend.stats().connections, 0)
    assert.ok(ops(seen.toHost).includes('close'))
    assert.ok(!ops(seen.toHost).includes('end'), 'a discard is not a half-close')
    assert.equal(served.length, 1)
  })

  it('a close from the peer ends both directions, half-closed or not', { timeout: 20_000 }, async () => {
    const { host, backend } = await rig({ serve: async (socket) => { await readAll(socket) } })
    const socket = await backend.connect('svc')
    await socket.end()
    host.hideService('svc') // the host closes it: a close frame, not an end
    assert.equal(dec.decode(await readAll(socket)), '')
    await assert.rejects(socket.write(enc.encode('x')))
  })
})

describe('mesh relay: the idle bound on a half-closed connection', () => {
  it('a client that half-closes and never reads is closed by the bound, and the slot is freed', { timeout: 20_000 }, async () => {
    const { host, backend, seen } = await rig({
      serve: async (socket) => { for (;;) { if (await socket.read() === null) break } await sleep(60_000) }, // reads to the end, never answers, never ends
      hostOptions: { halfCloseIdleMs: 150, maxConnectionsPerPeer: 1 },
      backendOptions: { halfCloseIdleMs: 150 },
    })
    const socket = await backend.connect('svc')
    const t0 = Date.now()
    await socket.end()
    assert.equal(await socket.read(), null)
    assert.ok(Date.now() - t0 >= 100, 'not sooner than the bound')
    for (let i = 0; i < 100 && host.stats().connections; i++) await sleep(5)
    assert.equal(host.stats().connections, 0)
    assert.ok(seen.toHost.some((f) => f.op === 'close' && f.reason === 'idle timeout') || seen.toBackend.some((f) => f.op === 'close' && f.reason === 'idle timeout'))
    const again = await backend.connect('svc') // a cap of one connection: the slot is free
    await again.close()
  })

  it('traffic postpones it, and a connection that is not half-closed is not touched', { timeout: 20_000 }, async () => {
    const { backend } = await rig({
      serve: async (socket) => {
        for (;;) { if (await socket.read() === null) break }
        for (let i = 0; i < 4; i++) { await sleep(100); await socket.write(enc.encode('.')) }
        await socket.end()
      },
      hostOptions: { halfCloseIdleMs: 250 },
      backendOptions: { halfCloseIdleMs: 250 },
    })
    const socket = await backend.connect('svc')
    await sleep(400) // not half-closed: nothing is ended however long it is quiet
    await socket.end()
    assert.equal(dec.decode(await readAll(socket)), '....')
  })

  it('0 turns it off, and the option is validated', async () => {
    assert.equal(RELAY_FLOW_DEFAULTS.halfCloseIdleMs, 300_000)
    for (const bad of [-1, 1.5, '5', NaN, 2 ** 31]) {
      assert.throws(() => new MeshRelayHost({ node: nodePair().a, network: new VirtualNetwork(), registry: registry(), halfCloseIdleMs: bad }), /halfCloseIdleMs/, String(bad))
      assert.throws(() => createMeshRelayBackend({ node: nodePair().b, relayPeerPubKey: ALICE, halfCloseIdleMs: bad }), /halfCloseIdleMs/, String(bad))
    }
    const { host, backend } = await rig({ serve: async (socket) => { await readAll(socket); await sleep(60_000) }, hostOptions: { halfCloseIdleMs: 0 }, backendOptions: { halfCloseIdleMs: 0 } })
    const socket = await backend.connect('svc')
    await socket.end()
    await sleep(300)
    assert.equal(host.stats().connections, 1, 'never ended by the bound')
    await socket.close()
  })
})

describe('mesh relay: against a peer that predates half-close', () => {
  const strip = (field) => (d) => { if (d && typeof d === 'object' && field in d) { const { [field]: _gone, ...rest } = d; return rest } return d }

  it('an older host (its ok has no halfClose): the client\'s end of stream is a full close, as before, and no end frame is sent', { timeout: 20_000 }, async () => {
    const { backend, seen } = await rig({
      serve: async (socket) => { for (;;) { const c = await socket.read(); if (c === null) break; await socket.write(c) } },
      taps: { toBackend: strip('halfClose') },
    })
    const socket = await backend.connect('svc')
    await socket.write(enc.encode('ping'))
    assert.equal(dec.decode(await socket.read()), 'ping')
    await socket.end()
    assert.equal(await socket.read(), null)
    assert.ok(!ops(seen.toHost).includes('end'), 'an older peer is never sent a frame it does not know')
    assert.ok(ops(seen.toHost).includes('close'))
  })

  it('an older client (its connect has no halfClose): the service\'s end of stream is a full close, and no end frame is sent', { timeout: 20_000 }, async () => {
    const { backend, seen } = await rig({
      serve: async (socket) => { await socket.write(enc.encode('hello')); await socket.end() },
      taps: { toHost: strip('halfClose') },
    })
    const socket = await backend.connect('svc')
    assert.equal(dec.decode(await readAll(socket)), 'hello')
    await assert.rejects(socket.write(enc.encode('too late')))
    assert.ok(!ops(seen.toBackend).includes('end'))
    assert.ok(!seen.toBackend.some((f) => f.op === 'ok' && f.halfClose))
  })

  it('an end frame on a connection that did not negotiate half-close is ignored', { timeout: 20_000 }, async () => {
    const { host, backend, seen, nodes } = await rig({ serve: async (socket) => { await readAll(socket) }, taps: { toHost: strip('halfClose') } })
    const socket = await backend.connect('svc')
    const connId = seen.toHost.find((f) => f.op === 'connect').connId
    // the peer sends an end frame the host never agreed to
    await nodes.b.sendTo(ALICE, { type: 'mesh-relay', op: 'end', connId })
    await sleep(20)
    assert.equal(host.stats().connections, 1)
    await socket.close()
  })
})
