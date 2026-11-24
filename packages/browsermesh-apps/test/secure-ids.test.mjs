// Run with: node --import ./test/_setup-globals.mjs --test test/secure-ids.test.mjs
//
// Identifiers that match a response to a request are unguessable (the platform CSPRNG, no
// fallback), and a response is accepted only from the peer the request went to.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { randomHex, randomRequestId, randomUUID } from '../src/internal/secure-id.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { createOrchestratorService } from '../src/mesh-orchestrator.mjs'
import { createSwarmService } from '../src/mesh-swarm.mjs'
import { createMeshRoutingService } from '../src/peer-routing.mjs'
import {
  IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL,
} from '@johnhenry/browsermesh-core'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }

/** Run `fn` with the platform CSPRNG removed, and put it back. */
async function withoutCrypto(fn) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true })
  try { return await fn() } finally { Object.defineProperty(globalThis, 'crypto', original) }
}

describe('secure identifiers', () => {
  it('randomHex / randomRequestId / randomUUID come from crypto.getRandomValues and do not repeat', () => {
    const ids = new Set(Array.from({ length: 500 }, () => randomRequestId()))
    assert.equal(ids.size, 500)
    for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/)
    assert.match(randomHex(8), /^[0-9a-f]{16}$/)
    assert.match(randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('fails clearly where there is no CSPRNG, instead of falling back to Math.random', async () => {
    await withoutCrypto(() => {
      for (const make of [() => randomHex(), () => randomRequestId(), () => randomUUID()]) {
        assert.throws(make, /secure random|getRandomValues/)
      }
    })
  })

  it('uses getRandomValues for the uuid even when randomUUID is missing from the platform', async () => {
    const original = globalThis.crypto
    const partial = { getRandomValues: (b) => original.getRandomValues(b) }
    Object.defineProperty(globalThis, 'crypto', { value: partial, configurable: true, writable: true })
    try { assert.match(randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4/) } finally { Object.defineProperty(globalThis, 'crypto', { value: original, configurable: true, writable: true }) }
  })

  it('no module builds a request or connection id from the clock and a counter, or from Math.random', () => {
    const offenders = []
    const elsewhere = new Set()
    for (const file of readdirSync(SRC).filter((f) => f.endsWith('.mjs') && !elsewhere.has(f))) {
      const lines = readFileSync(path.join(SRC, file), 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (/^\s*(\*|\/\/)/.test(line)) return
        if (/const next\w*Id\s*=/.test(line) && /Date\.now|now\(\)/.test(line)) offenders.push(`${file}:${i + 1} ${line.trim()}`)
        if (/Math\.random/.test(line) && file !== 'visualizations.mjs') offenders.push(`${file}:${i + 1} ${line.trim()}`)
        if (/crypto\.randomUUID\s*=/.test(line)) offenders.push(`${file}:${i + 1} ${line.trim()}`)
      })
    }
    assert.deepEqual(offenders, [])
  })
})

// ---------------------------------------------------------------------------
// A response counts only from the peer the request went to
// ---------------------------------------------------------------------------

async function peerOf(label) {
  const wallet = new IdentityWallet({ identityManager: new MeshIdentityManager({}) })
  const { podId } = await wallet.createIdentity(label)
  const registry = new PeerRegistry({ localPodId: podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: podId }) })
  return { podId, wallet, registry }
}

/** alice has a service; bob and carol are bare nodes that only record what reaches them and can write to alice. */
async function world(descriptor) {
  const [alice, bob, carol] = await Promise.all([peerOf('alice'), peerOf('bob'), peerOf('carol')])
  const listeners = new Map([alice, bob, carol].map((p) => [p.podId, new Set()]))
  const nodes = {}
  for (const peer of [alice, bob, carol]) {
    nodes[peer.podId] = {
      podId: peer.podId,
      wallet: peer.wallet,
      registry: peer.registry,
      inbox: [],
      onIncomingData(cb) { listeners.get(peer.podId).add(cb); return () => listeners.get(peer.podId).delete(cb) },
      async sendTo(to, data) { queueMicrotask(() => { for (const cb of listeners.get(to) ?? []) cb(peer.podId, structuredClone(data)) }) },
      /** Write to `to` as this node. */
      send(to, data) { return this.sendTo(to, data) },
      listPeers: () => [bob, carol].map((p) => ({ fingerprint: p.podId, status: 'connected' })),
    }
    nodes[peer.podId].onIncomingData((from, data) => nodes[peer.podId].inbox.push({ from, data }))
  }
  const handle = attachService(nodes[alice.podId], undefined, descriptor)
  return { alice, bob, carol, nodeA: nodes[alice.podId], nodeB: nodes[bob.podId], nodeC: nodes[carol.podId], handle }
}

/** Resolves with the first message of `kind` that reaches `node`. */
const requestAt = (node, kind) => new Promise((resolve) => node.onIncomingData((from, data) => { if (data?.kind === kind) resolve(data) }))

/** `promise` has not settled after everything queued has run. */
async function stillPending(promise) {
  let state = 'pending'
  promise.then(() => { state = 'resolved' }, () => { state = 'rejected' })
  await settle()
  return state === 'pending'
}

describe('a response is accepted only from the peer the request went to, and ids are random', () => {
  it('mesh-orchestrator', async () => {
    const w = await world(createOrchestratorService({ dispatchTimeoutMs: 60_000 }))
    const asked = requestAt(w.nodeB, 'orchestrator-request')
    const result = w.handle.api.execOnPod(w.bob.podId, 'ls')
    const request = await asked
    assert.match(request.requestId, /^[0-9a-f]{32}$/)
    await w.nodeC.send(w.alice.podId, { type: 'mesh-orchestrator', kind: 'orchestrator-response', requestId: request.requestId, result: 'forged by carol' })
    assert.equal(await stillPending(result), true, 'carol cannot answer a request sent to bob')
    await w.nodeB.send(w.alice.podId, { type: 'mesh-orchestrator', kind: 'orchestrator-response', requestId: request.requestId, result: 'from bob' })
    assert.equal(await result, 'from bob')
  })

  it('mesh-swarm: join requests and task submissions', async () => {
    const w = await world(createSwarmService({ swimOptions: { pingIntervalMs: 60_000 }, heartbeatMs: 60_000 }))
    try {
      const joinAsked = requestAt(w.nodeB, 'join-request')
      const join = w.handle.api.requestJoin(w.bob.podId, 60_000)
      const j = await joinAsked
      assert.match(j.requestId, /^[0-9a-f]{32}$/)
      await w.nodeC.send(w.alice.podId, { type: 'swarm-membership', kind: 'join-response', requestId: j.requestId, ok: true })
      assert.equal(await stillPending(join), true)
      await w.nodeB.send(w.alice.podId, { type: 'swarm-membership', kind: 'join-response', requestId: j.requestId, ok: true })
      assert.equal((await join).ok, true)

      const submitAsked = requestAt(w.nodeB, 'submit-request')
      const submit = w.handle.api.requestSubmitTask(w.bob.podId, { description: 'x', timeoutMs: 60_000 })
      const s = await submitAsked
      assert.match(s.requestId, /^[0-9a-f]{32}$/)
      await w.nodeC.send(w.alice.podId, { type: 'swarm-task', kind: 'submit-response', requestId: s.requestId, task: { taskId: 'forged' } })
      assert.equal(await stillPending(submit), true)
      await w.nodeB.send(w.alice.podId, { type: 'swarm-task', kind: 'submit-response', requestId: s.requestId, task: { taskId: 'real' } })
      assert.equal((await submit).taskId, 'real')
    } finally { await w.handle.teardown() }
  })

  it('mesh-websocket: a connection id is random, and only the peer at the other end can speak on it', async () => {
    const w = await world(createMeshRoutingService({}))
    const { BrowserMeshWebSocket } = await import('../src/mesh-websocket.mjs')
    const opened = requestAt(w.nodeB, 'ws-open')
    const client = new BrowserMeshWebSocket(`mesh://${w.bob.podId}/chat`, { peerNode: w.nodeA })
    const open = await opened
    assert.match(open.connectionId, /^[0-9a-f]{32}$/)
    const received = []
    client.onmessage = (event) => received.push(event.data)
    const envelope = (kind, extra) => ({ type: 'mesh-websocket', kind, connectionId: open.connectionId, ...extra })
    // carol knows the id (say she saw it) and tries to open, speak on, and close the connection.
    await w.nodeC.send(w.alice.podId, envelope('ws-open-ack'))
    await settle()
    assert.equal(client.readyState, BrowserMeshWebSocket.CONNECTING)
    await w.nodeB.send(w.alice.podId, envelope('ws-open-ack'))
    await settle()
    assert.equal(client.readyState, BrowserMeshWebSocket.OPEN)
    await w.nodeC.send(w.alice.podId, envelope('ws-message', { encoding: 'text', data: 'forged' }))
    await w.nodeC.send(w.alice.podId, envelope('ws-close', { code: 1000, reason: 'forged' }))
    await w.nodeB.send(w.alice.podId, envelope('ws-message', { encoding: 'text', data: 'real' }))
    await settle()
    assert.deepEqual(received, ['real'])
    assert.equal(client.readyState, BrowserMeshWebSocket.OPEN)
    client.close()
  })

  it('pod-host client: only the host a request went to can answer it', async () => {
    const { createPodHostClient } = await import('../src/pod-host-service.mjs')
    const { POD_HOST_RESPONSE } = await import('@johnhenry/browsermesh-pod')
    let deliver
    const sent = []
    const node = { onIncomingData(cb) { deliver = cb; return () => {} }, async sendTo(to, env) { sent.push(env) } }
    const client = createPodHostClient({ peerNode: node, timeoutMs: 60_000 })
    const result = client.list('host-b')
    await settle()
    const { requestId } = sent[0]
    assert.match(requestId, /^[0-9a-f]{8}-|^[0-9a-f]{32}$/)
    deliver('host-c', { type: POD_HOST_RESPONSE, requestId, ok: true, result: 'forged' })
    assert.equal(await stillPending(result), true)
    deliver('host-b', { type: POD_HOST_RESPONSE, requestId, ok: true, result: 'real' })
    assert.equal(await result, 'real')
    client.close?.()
  })

  it('peer-routing proxy requests', async () => {
    const w = await world(createMeshRoutingService({ fetchFn: null, proxyTimeoutMs: 60_000 }))
    const asked = requestAt(w.nodeB, 'proxy-request')
    const result = w.handle.api.requestProxy(w.bob.podId, { name: 'docs' })
    const request = await asked
    assert.match(request.requestId, /^[0-9a-f]{32}$/)
    await w.nodeC.send(w.alice.podId, { type: 'mesh-server-share', kind: 'proxy-response', requestId: request.requestId, status: 200, body: 'forged' })
    assert.equal(await stillPending(result), true)
    await w.nodeB.send(w.alice.podId, { type: 'mesh-server-share', kind: 'proxy-response', requestId: request.requestId, status: 200, body: 'real' })
    assert.equal((await result).body, 'real')
  })
})
