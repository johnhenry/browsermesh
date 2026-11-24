// A relaying pod over three real PeerNodes and real WebRTC data channels (node-datachannel, host candidates only: hermetic):
// alice is linked to the relay and the relay to bob, never alice to bob. Alice reaches bob's wsh services THROUGH the relay,
// with the real wsh client, pinning bob's pod id; the relay carries bytes it cannot read; revoking her per-target grant ends it.
// Docs: docs/design/wsh-over-mesh.md ("The relaying pod").
//
// Same optional `node-datachannel` guard and `REQUIRE_REAL_PEER` hard-fail as every other real-peer suite.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.crypto) globalThis.crypto = {}
if (!crypto.randomUUID) crypto.randomUUID = () => `uuid-${Math.random().toString(36).slice(2)}`

/** @type {any} */ let ndc = null
/** @type {any} */ let ndcMain = null
try {
  ndc = await import('node-datachannel/polyfill')
  ndcMain = await import('node-datachannel')
} catch {
  // Optional dependency absent -- the suite below skips.
}

if (!ndc && process.env.REQUIRE_REAL_PEER) {
  throw new Error(
    'REQUIRE_REAL_PEER is set but `node-datachannel` did not load, so the ' +
    'real-peer suite would have skipped and reported success. Install the ' +
    'devDependency, or unset REQUIRE_REAL_PEER to allow the skip.'
  )
}

if (!ndc) {
  describe('a relaying pod against real WebRTC peers', () => {
    it('skipped: optional devDependency `node-datachannel` is not installed', () => {})
  })
}

const describeIfReal = ndc ? describe : describe.skip

async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

const bus = () => new Set()
function busTransport(shared) {
  let handler = null
  const receiver = (msg) => { if (handler) handler(msg) }
  shared.add(receiver)
  return {
    send(msg) { for (const fn of shared) if (fn !== receiver) fn(msg) },
    onMessage(cb) { handler = cb },
  }
}

const SECRET = 'SECRET-TEXT-0123456789'

describeIfReal('a relaying pod: alice reaches bob\'s services through a third pod over real WebRTC', () => {
  const nodes = {}
  const managers = {}
  const svc = {}
  const ran = []
  const seen = []
  const relayAudit = []
  let services
  let relay
  let stopServing

  before(async () => {
    Object.assign(globalThis, {
      RTCPeerConnection: ndc.RTCPeerConnection,
      RTCIceCandidate: ndc.RTCIceCandidate,
      RTCSessionDescription: ndc.RTCSessionDescription,
    })
    const { createMeshNode, attachService, createMeshProtocolService } = await import('@johnhenry/browsermesh-apps')
    const { MeshIdentityManager } = await import('@johnhenry/browsermesh-core')
    const { ManualStrategy } = await import('@johnhenry/browsermesh-discovery')
    const { WshServices, WshRelay } = await import('@johnhenry/browsermesh-transport')

    const shared = bus()
    for (const label of ['alice', 'relay', 'bob']) {
      managers[label] = new MeshIdentityManager({})
      nodes[label] = await createMeshNode({
        label,
        identityManager: managers[label],
        discoveryStrategies: [new ManualStrategy()],
        signalingTransport: busTransport(shared),
        iceServers: [],
      })
    }
    const { alice, relay: relayNode, bob } = nodes
    // alice - relay - bob: alice and bob are never linked to each other.
    await alice.connectToPeer(relayNode.podId, { webrtc: relayNode.podId }, { answerTimeoutMs: 10_000, openTimeoutMs: 10_000 })
    await waitFor(() => relayNode.hasActiveSession(alice.podId), 10_000, "the relay's session with alice")
    await relayNode.connectToPeer(bob.podId, { webrtc: bob.podId }, { answerTimeoutMs: 10_000, openTimeoutMs: 10_000 })
    await waitFor(() => bob.hasActiveSession(relayNode.podId), 10_000, "bob's session with the relay")
    for (const label of ['alice', 'relay', 'bob']) svc[label] = attachService(nodes[label], undefined, createMeshProtocolService()).api

    const bobKey = managers.bob.getIdentity(bob.podId)
    services = new WshServices({
      identity: { podId: bob.podId, signer: { publicKey: await bobKey.rawPublicKey(), sign: (data) => bobKey.sign(data) } },
      registry: bob.registry,
      unattended: true,
      acceptVia: [relayNode.podId],
      mcp: { allow: ['lookup'], tools: [{ name: 'lookup', description: 'reads', annotations: { readOnlyHint: true }, execute: async ({ q }) => { ran.push(q); return `found ${q}` } }] },
      objects: { roots: { app: { title: 'inbox' } }, allow: { get: ['app.title'] } },
    })
    await services.start()
    stopServing = services.serveOnMesh(svc.bob)
    bob.registry.grantCapabilities(relayNode.podId, ['protocol:wsh:open'])
    bob.registry.grantCapabilities(alice.podId, ['wsh-services:open', 'protocol:mcp:open', 'mcp:lookup:list', 'mcp:lookup:call', 'protocol:objects:open', 'objects:app:get'])

    relay = new WshRelay({ registry: relayNode.registry, service: svc.relay, podId: relayNode.podId, unattended: true, onAudit: (e) => relayAudit.push(e) })
    relay.start()
  })

  after(async () => {
    try { await relay?.stop() } catch { /* already stopped */ }
    try { stopServing?.() } catch { /* already stopped */ }
    try { await services?.stop() } catch { /* already stopped */ }
    for (const n of Object.values(nodes)) { try { await n.shutdown?.() } catch { /* already down */ } }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('is refused without the per-target grant, then serves the real wsh client end to end, unreadable to the relay, until the grant is revoked', async () => {
    const { alice, relay: relayNode, bob } = nodes
    const { connectWshServicesViaRelay } = await import('@johnhenry/browsermesh-transport')
    const { openObjects } = await import('@johnhenry/wsh/objects')
    const aliceKey = managers.alice.getIdentity(alice.podId)
    const credentials = async () => ({ username: 'alice', signer: { publicKey: await aliceKey.rawPublicKey(), sign: (data) => aliceKey.sign(data) }, timeout: 10_000 })
    const tapped = {
      openProtocol: async (peer, name, opts = {}) => {
        const wrap = (ch) => new Proxy(ch, {
          get(target, key) {
            if (key === 'send') return (m, o) => { if (m instanceof Uint8Array) seen.push(Buffer.from(m)); return target.send(m, o) }
            if (key === 'onMessage') return (cb) => target.onMessage((m, ctx) => { if (m instanceof Uint8Array) seen.push(Buffer.from(m)); return cb(m, ctx) })
            const value = target[key]
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        return wrap(await svc.alice.openProtocol(peer, name, { ...opts, setup: opts.setup && ((ch) => opts.setup(wrap(ch))) }))
      },
    }
    await assert.rejects(connectWshServicesViaRelay(svc.alice, relayNode.podId, bob.podId, await credentials()), (e) => e.code === -32003, 'default deny, over the real channel')
    relayNode.registry.grantCapabilities(alice.podId, ['protocol:wsh-relay:open'])
    await assert.rejects(connectWshServicesViaRelay(svc.alice, relayNode.podId, bob.podId, await credentials()), (e) => e.reason === 'no-grant', 'the control grant is not the target grant')
    relayNode.registry.grantCapabilities(alice.podId, [`wsh-relay:${bob.podId}:open`])

    const conn = await connectWshServicesViaRelay(tapped, relayNode.podId, bob.podId, await credentials())
    const mcp = await conn.client.openRpc('mcp')
    assert.equal((await mcp.request('tools/call', { name: 'lookup', arguments: { q: SECRET } })).content[0].text, `found ${SECRET}`)
    const { app } = await openObjects(conn.client)
    assert.equal(await app.title, 'inbox')
    assert.deepEqual(ran, [SECRET])
    assert.ok(relayAudit.some((e) => e.event === 'relay-open' && e.requester === alice.podId && e.target === bob.podId))
    const all = Buffer.concat(seen)
    assert.ok(seen.length > 4)
    assert.equal(all.includes(Buffer.from(SECRET)), false, 'the relay cannot read the tool input or result')
    assert.equal(all.includes(Buffer.from('inbox')), false, 'or an object value')

    relayNode.registry.revokeCapabilities(alice.podId, [`wsh-relay:${bob.podId}:open`])
    await waitFor(() => relayAudit.some((e) => e.event === 'relay-close' && e.reason === 'revoked'), 10_000, 'the relayed session to end')
    await assert.rejects(mcp.request('tools/call', { name: 'lookup', arguments: { q: 'late' } }))
    assert.deepEqual(ran, [SECRET])
    await conn.close()
  })
})
