// wsh services over a mesh protocol channel between two real PeerNodes over a real WebRTC data channel (node-datachannel,
// host candidates only: hermetic): the real wsh client (`connectWshOverDuplex`) logs in to bob's `WshServices` through a
// protocol channel of the mesh, pins bob's pod id, and uses his MCP tool and an object under his registry grants. A relay is
// not involved. Docs: docs/design/wsh-over-mesh.md.
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
  describe('wsh services over a mesh channel against real WebRTC peers', () => {
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

describeIfReal('wsh services over a mesh channel: alice dials bob\'s services over real WebRTC', () => {
  const nodes = {}
  const managers = {}
  const svc = {}
  const ran = []
  const audit = []
  const seen = []
  let services
  let stop

  before(async () => {
    Object.assign(globalThis, {
      RTCPeerConnection: ndc.RTCPeerConnection,
      RTCIceCandidate: ndc.RTCIceCandidate,
      RTCSessionDescription: ndc.RTCSessionDescription,
    })
    const { createMeshNode, attachService, createMeshProtocolService } = await import('@johnhenry/browsermesh-apps')
    const { MeshIdentityManager } = await import('@johnhenry/browsermesh-core')
    const { ManualStrategy } = await import('@johnhenry/browsermesh-discovery')
    const { WshServices } = await import('@johnhenry/browsermesh-transport')

    const shared = bus()
    for (const label of ['alice', 'bob']) {
      managers[label] = new MeshIdentityManager({})
      nodes[label] = await createMeshNode({
        label,
        identityManager: managers[label],
        discoveryStrategies: [new ManualStrategy()],
        signalingTransport: busTransport(shared),
        iceServers: [],
      })
    }
    const { alice, bob } = nodes
    await alice.connectToPeer(bob.podId, { webrtc: bob.podId }, { answerTimeoutMs: 10_000, openTimeoutMs: 10_000 })
    await waitFor(() => bob.hasActiveSession(alice.podId), 10_000, "bob's session with alice")
    for (const label of ['alice', 'bob']) svc[label] = attachService(nodes[label], undefined, createMeshProtocolService()).api

    // Bob's services: his pod key is the host key (his node's identity signs; the key never leaves it).
    const bobKey = managers.bob.getIdentity(bob.podId)
    services = new WshServices({
      identity: { podId: bob.podId, signer: { publicKey: await bobKey.rawPublicKey(), sign: (data) => bobKey.sign(data) } },
      registry: bob.registry,
      unattended: true,
      mcp: { allow: ['lookup'], tools: [{ name: 'lookup', description: 'reads', annotations: { readOnlyHint: true }, execute: async ({ q }) => { ran.push(q); return `found ${q}` } }] },
      objects: { roots: { app: { title: 'inbox' } }, allow: { get: ['app.title'] } },
      onAudit: (e) => audit.push(e),
    })
    await services.start()
    stop = services.serveOnMesh(svc.bob)
  })

  after(async () => {
    try { stop?.() } catch { /* already stopped */ }
    try { await services?.stop() } catch { /* already stopped */ }
    for (const n of Object.values(nodes)) { try { await n.shutdown?.() } catch { /* already down */ } }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('refuses a peer with no grant, then serves the real wsh client under the grants, with nothing readable on the channel after login', async () => {
    const { alice, bob } = nodes
    const { connectWshServicesOverMesh } = await import('@johnhenry/browsermesh-transport')
    const { openObjects } = await import('@johnhenry/wsh/objects')
    const aliceKey = managers.alice.getIdentity(alice.podId)
    const credentials = async () => ({ username: 'alice', signer: { publicKey: await aliceKey.rawPublicKey(), sign: (data) => aliceKey.sign(data) }, timeout: 10_000 })
    // a hop on the channel that reads everything
    const tapped = {
      openProtocol: async (peer, name, opts = {}) => {
        const wrap = (ch) => new Proxy(ch, {
          get(target, key) {
            if (key === 'send') return (bytes, o) => { seen.push(Buffer.from(bytes)); return target.send(bytes, o) }
            if (key === 'onMessage') return (cb) => target.onMessage((m, ctx) => { seen.push(Buffer.from(m)); return cb(m, ctx) })
            const value = target[key]
            return typeof value === 'function' ? value.bind(target) : value
          },
        })
        return wrap(await svc.alice.openProtocol(peer, name, { ...opts, setup: opts.setup && ((ch) => opts.setup(wrap(ch))) }))
      },
    }
    await assert.rejects(connectWshServicesOverMesh(svc.alice, bob.podId, await credentials()), (e) => e.code === -32003, 'default deny, over the real channel')

    bob.registry.grantCapabilities(alice.podId, ['protocol:wsh:open', 'wsh-services:open', 'protocol:mcp:open', 'mcp:lookup:list', 'mcp:lookup:call', 'protocol:objects:open', 'objects:app:get'])
    const conn = await connectWshServicesOverMesh(tapped, bob.podId, await credentials())
    try {
      assert.equal(conn.client.sessionSealed, true)
      const mcp = await conn.client.openRpc('mcp')
      assert.deepEqual((await mcp.request('tools/list', {})).tools.map((t) => t.name), ['lookup'])
      assert.equal((await mcp.request('tools/call', { name: 'lookup', arguments: { q: SECRET } })).content[0].text, `found ${SECRET}`)
      const { app } = await openObjects(conn.client)
      assert.equal(await app.title, 'inbox')
      assert.deepEqual(ran, [SECRET])
      assert.ok(audit.some((e) => e.event === 'session-open' && e.podId === alice.podId))
      const all = Buffer.concat(seen)
      assert.ok(seen.length > 4)
      assert.equal(all.includes(Buffer.from(SECRET)), false, 'the tool input and result are not readable on the channel')
      assert.equal(all.includes(Buffer.from('inbox')), false, 'an object value is not readable on the channel')
    } finally {
      await conn.close()
    }
    await waitFor(() => services.sessions.length === 0, 10_000, 'the session to end')

    bob.registry.revokeCapabilities(alice.podId, ['protocol:wsh:open'])
    await assert.rejects(connectWshServicesOverMesh(svc.alice, bob.podId, await credentials()), (e) => e.code === -32003, 'revoked: the next open is refused')
  })
})
