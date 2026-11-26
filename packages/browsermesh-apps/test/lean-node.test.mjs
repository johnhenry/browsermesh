/**
 * createLeanMeshNode (lean-node.mjs): the smallest connected node, for a page that reaches one pod. Same composition as
 * `createMeshNode` for the part every node needs, without the modules of every optional service.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/lean-node.test.mjs
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

let lastConfig = null
class MockRTCDataChannel { readyState = 'open'; close() {} }
class MockRTCPeerConnection {
  onicecandidate = null
  ondatachannel = null
  onconnectionstatechange = null
  connectionState = 'new'
  signalingState = 'stable'
  constructor(config) { this.config = config; lastConfig = config }
  createDataChannel() { return new MockRTCDataChannel() }
  async createOffer() { return { type: 'offer', sdp: 'mock-offer-sdp' } }
  async setLocalDescription() {}
  close() {}
}
globalThis.RTCPeerConnection = MockRTCPeerConnection

const lean = await import('../src/lean-node.mjs')
const { createLeanMeshNode } = lean
const stub = () => ({ send() {}, onMessage() {} })

describe('createLeanMeshNode', () => {
  it('builds a booted node with the identity it was given, a default-deny registry and the parts a service needs', async () => {
    const identityManager = new lean.MeshIdentityManager({})
    const node = await createLeanMeshNode({ label: 'page', identityManager, signalingTransport: stub(), iceServers: [] })
    try {
      assert.equal(typeof node.podId, 'string')
      assert.ok(identityManager.getIdentity(node.podId), 'the node runs under the identity of the manager it was given')
      assert.ok(node.registry && typeof node.registry.checkAccess === 'function')
      const verdict = node.registry.checkAccess('some-other-pod', 'protocol:egress', 'open')
      assert.ok(verdict === false || verdict?.allowed === false, 'nothing is granted by default')
      assert.ok(node.meshManager && node.signaling && node.transportNegotiator)
      assert.equal(node.services.size, 0)
      assert.equal(typeof node.connectToPeer, 'function')
      assert.equal(typeof node.sendTo, 'function')
      assert.equal(typeof node.onIncomingData, 'function')
      const svc = lean.attachService(node, undefined, lean.createMeshProtocolService())
      assert.equal(typeof svc.api.openProtocol, 'function')
      svc.teardown()
    } finally { await node.shutdown() }
  })

  it('requires a signalling transport, and says what it is', async () => {
    await assert.rejects(createLeanMeshNode({}), /signalingTransport is required/)
  })

  it('passes ICE servers through the same validation createMeshNode uses', async () => {
    const turn = { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'c' }
    const node = await createLeanMeshNode({ signalingTransport: stub(), iceServers: [turn, { username: 'no urls' }], skipBoot: true })
    lastConfig = null
    const conn = await node.meshManager.connectToPeer('remote-pod-id')
    await conn.createOffer()
    assert.deepEqual(lastConfig.iceServers, [turn])
  })

  it('connectToPeer fails with the reason when the offer cannot leave, and waits for no answer to it', async () => {
    const down = { send() { throw new Error('WebSocket is not open') }, onMessage() {} }
    const node = await createLeanMeshNode({ signalingTransport: down, iceServers: [] })
    try {
      await assert.rejects(node.connectToPeer('some-pod', { webrtc: 'some-pod' }, { answerTimeoutMs: 20 }), /WebSocket is not open/)
      await new Promise((resolve) => setTimeout(resolve, 60)) // past the answer timeout: an unhandled rejection from it would fail this file
    } finally { await node.shutdown() }
  })

  it('a peer that never answers is a failure of connectToPeer, not a session with no transport', async () => {
    const node = await createLeanMeshNode({ signalingTransport: stub(), iceServers: [] })
    try {
      await assert.rejects(node.connectToPeer('some-pod', { webrtc: 'some-pod' }, { answerTimeoutMs: 20 }), /timed out waiting for an answer/)
      assert.equal(node.hasActiveSession('some-pod'), false)
    } finally { await node.shutdown() }
  })

  it('skipBoot leaves the node unbooted: it has a pod id, and a connect is refused until it is booted', async () => {
    const node = await createLeanMeshNode({ signalingTransport: stub(), skipBoot: true })
    assert.ok(node.podId)
    await assert.rejects(node.connectToPeer('some-pod', { webrtc: 'some-pod' }), /boot|running/i)
  })
})

describe('what makes it lean', () => {
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src')
  const imports = (file) => [...readFileSync(path.join(SRC, file), 'utf8').matchAll(/^import[^'"\n]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])

  it('its static imports are the few modules a node needs: nothing of the services, and no mesh-bootstrap', () => {
    const seen = new Set()
    const walk = (file) => {
      if (seen.has(file)) return
      seen.add(file)
      for (const spec of imports(file)) if (spec.startsWith('./')) walk(spec.slice(2))
    }
    walk('lean-node.mjs')
    for (const heavy of ['index.mjs', 'mesh-bootstrap.mjs', 'orchestrator.mjs', 'marketplace.mjs', 'peer-routing.mjs', 'wsh-negotiator.mjs', 'mesh-swarm.mjs']) assert.ok(!seen.has(heavy), `${heavy} is reached`)
    assert.ok(seen.size <= 12, `${seen.size} modules: ${[...seen].join(', ')}`)
    const external = new Set([...seen].flatMap((f) => imports(f)).filter((s) => !s.startsWith('.')))
    assert.deepEqual([...external].sort(), ['@johnhenry/browsermesh-core', '@johnhenry/browsermesh-discovery', '@johnhenry/browsermesh-primitives', '@johnhenry/browsermesh-transport'].filter((s) => external.has(s)))
  })

  it('is its own subpath export, and the package root is unchanged', () => {
    const pkg = JSON.parse(readFileSync(path.join(SRC, '..', 'package.json'), 'utf8'))
    assert.equal(pkg.exports['./lean-node'], './src/lean-node.mjs')
    assert.equal(pkg.exports['.'].default, './src/index.mjs')
  })
})
