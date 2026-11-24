/**
 * Relayed connections: they end when the permission that allowed them ends,
 * and they hold a bounded amount of memory.
 *
 * The two PeerNodes are a duck-typed bus over queueMicrotask, and the services
 * are in-memory listeners, so nothing here uses timers or I/O: after
 * `settle()` (one macrotask turn) every pending microtask chain has finished,
 * and anything still pending is genuinely blocked. Buffered bytes are read
 * from the code's own counters (`host.stats()`, `backend.stats()`).
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/mesh-relay-lifecycle.test.mjs
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { MeshRelayHost } from '../src/mesh-relay-host.mjs'
import { createMeshRelayBackend } from '../src/mesh-relay-backend.mjs'
import { RELAY_FLOW_DEFAULTS } from '../src/internal/relay-flow.mjs'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { VirtualNetwork, DEFAULT_WINDOW_BYTES } from '@johnhenry/browsermesh-netway'

const settle = () => new Promise((resolve) => setImmediate(resolve))
const ALICE = 'alice-pod'
const BOB = 'bob-pod'
const CAROL = 'carol-pod'
const SCOPE = 'mesh-relay:svc:connect'

function track(promise) {
  const s = { settled: false, error: null }
  promise.then(() => { s.settled = true }, (e) => { s.settled = true; s.error = e })
  return s
}

/** Bus between `host` (ALICE) and any number of named peers; every message is observable. */
function createBus() {
  const listeners = new Map()
  const log = []
  const node = (podId) => {
    const set = new Set()
    listeners.set(podId, set)
    return {
      podId,
      onIncomingData(cb) { set.add(cb); return () => set.delete(cb) },
      async sendTo(pubKey, data) {
        log.push({ from: podId, to: pubKey, data })
        queueMicrotask(() => { for (const cb of listeners.get(pubKey) ?? []) cb(podId, data) })
      },
    }
  }
  return { node, log }
}

function createRegistry(owner) {
  return new PeerRegistry({
    localPodId: owner,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner }),
  })
}

/** An in-memory service. mode 'sink' reads and counts; 'stall' accepts and never reads. */
async function startService(network, address, mode = 'sink') {
  const listener = await network.listen(address)
  const svc = { sockets: [], received: 0, eof: [], listener }
  ;(async () => {
    for (;;) {
      const sock = await listener.accept()
      if (!sock) break
      svc.sockets.push(sock)
      let resolveEof
      svc.eof.push(new Promise((r) => { resolveEof = r }))
      if (mode === 'sink') {
        ;(async () => {
          for (;;) {
            const chunk = await sock.read()
            if (chunk === null) break
            svc.received += chunk.length
          }
          resolveEof()
        })()
      }
    }
  })()
  return svc
}

const enc = (s) => new TextEncoder().encode(s)

describe('relayed connections end with the permission that allowed them', () => {
  let bus, aliceNode, bobNode, network, registry, svc, host, backend

  beforeEach(async () => {
    bus = createBus()
    aliceNode = bus.node(ALICE)
    bobNode = bus.node(BOB)
    network = new VirtualNetwork()
    svc = await startService(network, 'mem://localhost:9100')
    registry = createRegistry(ALICE)
    host = new MeshRelayHost({ node: aliceNode, network, registry })
    host.exposeService('svc', 'mem://localhost:9100')
    registry.grantCapabilities(BOB, [SCOPE])
    backend = createMeshRelayBackend({ node: bobNode, relayPeerPubKey: ALICE })
  })

  afterEach(async () => {
    await backend.close()
    await host.detach()
    await network.close()
  })

  async function open() {
    const socket = await backend.connect('svc')
    await socket.write(enc('hello'))
    await settle()
    assert.equal(svc.received, 5, 'the connection works before the change')
    return socket
  }

  it('revoking the grant mid-transfer ends the connection in both directions, with a reason', async () => {
    const socket = await open()
    // Data in flight in both directions at the moment of revocation.
    const clientWrite = socket.write(enc('more from the client'))
    const serverWrite = svc.sockets[0].write(enc('more from the service')).catch(() => {})
    registry.revokeCapabilities(BOB, [SCOPE])
    const receivedAtRevoke = svc.received
    await Promise.all([clientWrite.catch(() => {}), serverWrite])
    await settle()

    assert.equal(svc.received, receivedAtRevoke, 'no further byte reached the service')
    assert.equal(await socket.read(), null, 'the client sees end of stream, not the in-flight service data')
    assert.match(socket.closeReason, /access/)
    await svc.eof[0]
    assert.equal(host.stats().connections, 0)
    await assert.rejects(() => socket.write(enc('x')), { name: 'SocketClosedError' })
    await assert.rejects(() => svc.sockets[0].write(enc('x')), { name: 'SocketClosedError' })
    assert.equal(svc.received, receivedAtRevoke)
  })

  it('a revoked connection is also closed on the host side when later frames still arrive', async () => {
    const socket = await open()
    registry.revokeCapabilities(BOB, [SCOPE])
    await bobNode.sendTo(ALICE, { type: 'mesh-relay', op: 'data', connId: bus.log.find((m) => m.data.op === 'connect').data.connId, data: 'eHg=' })
    await settle()
    assert.equal(svc.received, 5)
    assert.equal(socket.closed || (await socket.read()) === null, true)
  })

  it("revoking one peer's grant leaves another peer's connection open", async () => {
    registry.grantCapabilities(CAROL, [SCOPE])
    const carolBackend = createMeshRelayBackend({ node: bus.node(CAROL), relayPeerPubKey: ALICE })
    try {
      const carolSocket = await carolBackend.connect('svc')
      const bobSocket = await open()
      registry.revokeCapabilities(BOB, [SCOPE])
      await settle()
      assert.equal(await bobSocket.read(), null)
      assert.equal(carolSocket.closed, false)
      await carolSocket.write(enc('still here'))
      await settle()
      assert.equal(svc.received, 5 + 10)
    } finally {
      await carolBackend.close()
    }
  })

  it('removing the peer ends its connections', async () => {
    const socket = await open()
    registry.removePeer(BOB)
    await settle()
    assert.equal(await socket.read(), null)
    assert.equal(host.stats().connections, 0)
  })

  it('changing the peer to a template without the scope ends its connections', async () => {
    const socket = await open()
    registry.updatePermissions(BOB, 'guest')
    await settle()
    assert.equal(await socket.read(), null)
  })

  it('hideService() ends the connections to that service and keeps the others', async () => {
    const other = await startService(network, 'mem://localhost:9101')
    host.exposeService('other', 'mem://localhost:9101')
    registry.grantCapabilities(BOB, ['mesh-relay:other:connect'])
    const a = await open()
    const b = await backend.connect('other')
    host.hideService('svc')
    await settle()
    assert.equal(await a.read(), null)
    assert.match(a.closeReason, /service/)
    assert.equal(b.closed, false)
    await b.write(enc('ok'))
    await settle()
    assert.equal(other.received, 2)
  })

  it('detach() ends the connections and stops serving', async () => {
    const socket = await open()
    await host.detach()
    await settle()
    assert.equal(await socket.read(), null)
    assert.equal(host.stats().connections, 0)
    const sentBefore = bus.log.length
    await bobNode.sendTo(ALICE, { type: 'mesh-relay', op: 'connect', connId: 'late', service: 'svc' })
    await settle()
    assert.equal(bus.log.slice(sentBefore).filter((m) => m.from === ALICE).length, 0, 'nothing is answered after detach')
  })

  it('a connect that completes after detach is not acknowledged and its socket is closed', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    const slowNetwork = {
      async connect(address) { await gate; return network.connect(address) },
    }
    const slowHost = new MeshRelayHost({ node: bus.node('slow-host'), network: slowNetwork, registry })
    slowHost.exposeService('svc', 'mem://localhost:9100')
    registry.grantCapabilities(BOB, [SCOPE])
    const asker = bus.node('asker')
    registry.grantCapabilities('asker', [SCOPE])
    await asker.sendTo('slow-host', { type: 'mesh-relay', op: 'connect', connId: 'c1', service: 'svc' })
    await settle()
    const detaching = slowHost.detach()
    release()
    await detaching
    await settle()
    assert.equal(bus.log.some((m) => m.from === 'slow-host' && m.data.op === 'ok'), false)
    assert.equal(slowHost.stats().connections, 0)
    await svc.eof[0]
  })

  it('a connect whose grant is revoked while it is being opened is refused and its socket closed', async () => {
    let release
    const gate = new Promise((r) => { release = r })
    const slowNetwork = { async connect(address) { await gate; return network.connect(address) } }
    const h = new MeshRelayHost({ node: bus.node('h2'), network: slowNetwork, registry })
    h.exposeService('svc', 'mem://localhost:9100')
    registry.grantCapabilities('p2', [SCOPE])
    const p2 = bus.node('p2')
    await p2.sendTo('h2', { type: 'mesh-relay', op: 'connect', connId: 'c9', service: 'svc' })
    await settle()
    registry.revokeCapabilities('p2', [SCOPE])
    release()
    await settle()
    const answers = bus.log.filter((m) => m.from === 'h2' && m.to === 'p2')
    assert.equal(answers.some((m) => m.data.op === 'ok'), false)
    assert.equal(answers.some((m) => m.data.op === 'refused'), true)
    await svc.eof[0]
    await h.detach()
  })

  it('recheck() closes connections whose access went away by a path the registry did not announce', async () => {
    // A registry whose answer changes without announcing it.
    let allowed = true
    const fake = { checkAccess: () => ({ allowed }) }
    const h = new MeshRelayHost({ node: bus.node('h3'), network, registry: fake })
    h.exposeService('svc', 'mem://localhost:9100')
    const b3 = createMeshRelayBackend({ node: bus.node('b3'), relayPeerPubKey: 'h3' })
    const s3 = await b3.connect('svc')
    allowed = false
    await settle()
    assert.equal(s3.closed, false, 'no event, no timer tick: still open')
    await h.recheck()
    await settle()
    assert.equal(await s3.read(), null)
    await b3.close()
    await h.detach()
  })

  it('re-checks on an interval, not per packet', async () => {
    mock.timers.enable({ apis: ['setInterval'] })
    try {
      let allowed = true
      let checks = 0
      const fake = { checkAccess: () => { checks++; return { allowed } } }
      const h = new MeshRelayHost({ node: bus.node('h4'), network, registry: fake, recheckIntervalMs: 1000 })
      h.exposeService('svc', 'mem://localhost:9100')
      const b4 = createMeshRelayBackend({ node: bus.node('b4'), relayPeerPubKey: 'h4' })
      const s4 = await b4.connect('svc')
      const afterConnect = checks
      for (let i = 0; i < 20; i++) await s4.write(enc('x'))
      await settle()
      assert.equal(checks, afterConnect, 'data frames do not trigger checks')
      allowed = false
      mock.timers.tick(1000)
      await settle()
      assert.equal(await s4.read(), null)
      await b4.close()
      await h.detach()
    } finally {
      mock.timers.reset()
    }
  })

  it('stops the interval on detach', async () => {
    mock.timers.enable({ apis: ['setInterval'] })
    try {
      let checks = 0
      const fake = { checkAccess: () => { checks++; return { allowed: true } } }
      const h = new MeshRelayHost({ node: bus.node('h5'), network, registry: fake, recheckIntervalMs: 1000 })
      await h.detach()
      const before = checks
      mock.timers.tick(5000)
      assert.equal(checks, before)
    } finally {
      mock.timers.reset()
    }
  })

  it('refuses more connections than maxConnectionsPerPeer, counting ones still opening', async () => {
    const h = new MeshRelayHost({ node: bus.node('h6'), network, registry, maxConnectionsPerPeer: 2 })
    h.exposeService('svc', 'mem://localhost:9100')
    registry.grantCapabilities('p6', [SCOPE])
    const p6 = bus.node('p6')
    for (const id of ['a', 'b', 'c']) await p6.sendTo('h6', { type: 'mesh-relay', op: 'connect', connId: id, service: 'svc' })
    await settle()
    const answers = bus.log.filter((m) => m.from === 'h6' && m.to === 'p6').map((m) => `${m.data.connId}:${m.data.op}`)
    assert.deepEqual(answers.sort(), ['a:ok', 'b:ok', 'c:refused'])
    await h.detach()
  })
})

describe('relayed connections hold a bounded amount of memory', () => {
  let bus, network, registry, host, backend, svc

  const FRAME = 16 * 1024
  const chunk = (i) => { const c = new Uint8Array(FRAME); new DataView(c.buffer).setUint32(0, i); return c }

  async function setup(mode, hostOpts = {}, backendOpts = {}) {
    bus = createBus()
    network = new VirtualNetwork()
    svc = await startService(network, 'mem://localhost:9200', mode)
    registry = createRegistry(ALICE)
    registry.grantCapabilities(BOB, [SCOPE])
    host = new MeshRelayHost({ node: bus.node(ALICE), network, registry, ...hostOpts })
    host.exposeService('svc', 'mem://localhost:9200')
    backend = createMeshRelayBackend({ node: bus.node(BOB), relayPeerPubKey: ALICE, ...backendOpts })
  }

  afterEach(async () => {
    await backend?.close()
    await host?.detach()
    await network?.close()
    backend = host = network = undefined
  })

  it('states its defaults', () => {
    assert.deepEqual({ ...RELAY_FLOW_DEFAULTS }, {
      highWaterBytes: 262144,
      lowWaterBytes: 65536,
      maxBufferedBytesPerConnection: 1048576,
      maxBufferedBytesPerPeer: 4194304,
      maxConnectionsPerPeer: 16,
      maxFrameBytes: 65536,
      recheckIntervalMs: 30000,
    })
    assert.throws(() => new MeshRelayHost({ node: bus?.node?.('x') ?? { onIncomingData() { return () => {} }, sendTo() {} }, network: {}, registry: {}, lowWaterBytes: 10, highWaterBytes: 10 }), /lowWaterBytes/)
  })

  it('a fast sender into a service that never reads stays under the bound, then drains in order', async () => {
    await setup('stall')
    const socket = await backend.connect('svc')
    const TOTAL = 400 // 6.4 MiB attempted
    let written = 0
    const writer = (async () => {
      for (let i = 0; i < TOTAL; i++) { await socket.write(chunk(i)); written++ }
    })()
    await settle()
    const stalled = written
    assert.ok(stalled < TOTAL, `the sender is held back (wrote ${stalled} of ${TOTAL})`)
    const bound = RELAY_FLOW_DEFAULTS.highWaterBytes + DEFAULT_WINDOW_BYTES + FRAME
    const s1 = host.stats()
    assert.ok(s1.bufferedBytes <= bound, `host buffered ${s1.bufferedBytes} <= ${bound}`)
    assert.ok(backend.stats().bufferedBytes <= bound + RELAY_FLOW_DEFAULTS.highWaterBytes)
    await settle()
    assert.equal(written, stalled, 'it stays held back for as long as the service does not read')
    assert.ok(host.stats().bufferedBytes <= bound)

    // The service starts reading: everything arrives, in order, nothing dropped.
    const sock = svc.sockets[0]
    for (let i = 0; i < TOTAL; i++) {
      const got = await readExactly(sock, FRAME)
      assert.equal(new DataView(got.buffer, got.byteOffset).getUint32(0), i, `chunk ${i} in order`)
    }
    await writer
    assert.equal(written, TOTAL)
  })

  it('a fast service into a client that never reads is paused by credit', async () => {
    await setup('stall')
    const socket = await backend.connect('svc') // never read from `socket`
    const sock = svc.sockets[0]
    const TOTAL = 400
    let written = 0
    const writer = (async () => {
      for (let i = 0; i < TOTAL; i++) { await sock.write(chunk(i)); written++ }
    })()
    await settle()
    const stalled = written
    assert.ok(stalled < TOTAL, `the service is held back (wrote ${stalled} of ${TOTAL})`)
    const bound = RELAY_FLOW_DEFAULTS.highWaterBytes + DEFAULT_WINDOW_BYTES + FRAME
    assert.ok(backend.stats().bufferedBytes <= bound, `client buffered ${backend.stats().bufferedBytes} <= ${bound}`)
    assert.ok(host.stats().inFlightBytes <= RELAY_FLOW_DEFAULTS.highWaterBytes)

    for (let i = 0; i < TOTAL; i++) {
      const got = await readExactly(socket, FRAME)
      assert.equal(new DataView(got.buffer, got.byteOffset).getUint32(0), i)
    }
    await writer
    assert.equal(written, TOTAL)
  })

  it('closes with a reason when a peer that ignores credit exceeds the per-connection cap', async () => {
    await setup('stall', { maxBufferedBytesPerConnection: 512 * 1024 })
    const raw = bus.node('raw')
    registry.grantCapabilities('raw', [SCOPE])
    await raw.sendTo(ALICE, { type: 'mesh-relay', op: 'connect', connId: 'r1', service: 'svc' }) // no window: an older peer
    await settle()
    const payload = Buffer.alloc(FRAME).toString('base64')
    for (let i = 0; i < 200; i++) await raw.sendTo(ALICE, { type: 'mesh-relay', op: 'data', connId: 'r1', data: payload })
    await settle()
    const closes = bus.log.filter((m) => m.from === ALICE && m.to === 'raw' && m.data.op === 'close')
    assert.equal(closes.length, 1)
    assert.match(closes[0].data.reason, /buffer limit/)
    assert.equal(host.stats().connections, 0)
    assert.equal(bus.log.some((m) => m.from === ALICE && m.to === 'raw' && m.data.op === 'credit'), false, 'an older peer is sent no credit frames')
  })

  it('closes a connection that would take the peer over the per-peer cap', async () => {
    await setup('stall', { maxBufferedBytesPerConnection: 512 * 1024, maxBufferedBytesPerPeer: 600 * 1024 })
    const raw = bus.node('raw')
    registry.grantCapabilities('raw', [SCOPE])
    for (const id of ['r1', 'r2']) await raw.sendTo(ALICE, { type: 'mesh-relay', op: 'connect', connId: id, service: 'svc' })
    await settle()
    const payload = Buffer.alloc(FRAME).toString('base64')
    for (let i = 0; i < 100; i++) {
      await raw.sendTo(ALICE, { type: 'mesh-relay', op: 'data', connId: 'r1', data: payload })
      await raw.sendTo(ALICE, { type: 'mesh-relay', op: 'data', connId: 'r2', data: payload })
    }
    await settle()
    const peer = host.stats().peers.raw
    assert.ok(!peer || peer.bufferedBytes <= 600 * 1024 + 2 * RELAY_FLOW_DEFAULTS.maxFrameBytes)
    const reasons = bus.log.filter((m) => m.to === 'raw' && m.data.op === 'close').map((m) => m.data.reason)
    assert.ok(reasons.length >= 1)
    assert.ok(reasons.every((r) => /buffer limit/.test(r)))
  })

  it('closes a credit-aware peer that sends more than its window, or an oversized frame', async () => {
    await setup('stall')
    const raw = bus.node('raw')
    registry.grantCapabilities('raw', [SCOPE])
    await raw.sendTo(ALICE, { type: 'mesh-relay', op: 'connect', connId: 'w1', service: 'svc', window: 65536 })
    await raw.sendTo(ALICE, { type: 'mesh-relay', op: 'connect', connId: 'w2', service: 'svc', window: 65536 })
    await settle()
    const small = Buffer.alloc(FRAME).toString('base64')
    // More than the service socket's own buffer plus the window, without waiting for any credit.
    for (let i = 0; i < 120; i++) await raw.sendTo(ALICE, { type: 'mesh-relay', op: 'data', connId: 'w1', data: small })
    await raw.sendTo(ALICE, { type: 'mesh-relay', op: 'data', connId: 'w2', data: Buffer.alloc(RELAY_FLOW_DEFAULTS.maxFrameBytes + 1024).toString('base64') })
    await settle()
    const closes = bus.log.filter((m) => m.to === 'raw' && m.data.op === 'close')
    const byId = Object.fromEntries(closes.map((m) => [m.data.connId, m.data.reason]))
    assert.match(byId.w1, /flow control/)
    assert.match(byId.w2, /flow control/)
  })

  it('refuses credit that was never owed', async () => {
    await setup('sink')
    const raw = bus.node('raw')
    registry.grantCapabilities('raw', [SCOPE])
    await raw.sendTo(ALICE, { type: 'mesh-relay', op: 'connect', connId: 'k1', service: 'svc', window: 65536 })
    await settle()
    await raw.sendTo(ALICE, { type: 'mesh-relay', op: 'credit', connId: 'k1', bytes: 1000000 })
    await settle()
    const close = bus.log.find((m) => m.to === 'raw' && m.data.op === 'close')
    assert.match(close.data.reason, /flow control/)
  })

  it('advertises its window additively, so an older client is not sent anything it cannot handle', async () => {
    await setup('sink')
    await backend.connect('svc')
    const connect = bus.log.find((m) => m.data.op === 'connect').data
    const ok = bus.log.find((m) => m.data.op === 'ok').data
    assert.equal(connect.window, RELAY_FLOW_DEFAULTS.highWaterBytes)
    assert.equal(ok.window, RELAY_FLOW_DEFAULTS.highWaterBytes)
  })
})

/** Read until `n` bytes are collected (chunks can be split or joined on the way). */
async function readExactly(socket, n) {
  const out = new Uint8Array(n)
  let have = 0
  readExactly.carry ??= new WeakMap()
  let rest = readExactly.carry.get(socket)
  while (have < n) {
    let c = rest ?? await socket.read()
    rest = null
    assert.notEqual(c, null, 'stream ended early')
    const take = Math.min(c.length, n - have)
    out.set(c.subarray(0, take), have)
    have += take
    if (take < c.length) rest = c.subarray(take)
  }
  readExactly.carry.set(socket, rest)
  return out
}
