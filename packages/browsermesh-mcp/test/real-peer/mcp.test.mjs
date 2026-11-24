// MCP across the mesh between two real PeerNodes over a real WebRTC data channel (node-datachannel, host
// candidates only: hermetic). Bob serves two tools; alice lists and calls them. A call that needs a grant she does
// not hold is refused, a consequential tool asks BOB's prompt (alice cannot answer it), and revoking her grant
// refuses her next call.
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
  describe('MCP over the mesh against real WebRTC peers', () => {
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

const code = async (promise) => { try { await promise; return null } catch (e) { return e.code } }

describeIfReal('MCP over the mesh: alice calls bob\'s tools over real WebRTC', () => {
  const nodes = {}
  const svc = {}
  const asked = []
  const ran = []
  let mcp

  before(async () => {
    Object.assign(globalThis, {
      RTCPeerConnection: ndc.RTCPeerConnection,
      RTCIceCandidate: ndc.RTCIceCandidate,
      RTCSessionDescription: ndc.RTCSessionDescription,
    })
    const { createMeshNode, attachService, createMeshProtocolService } = await import('@johnhenry/browsermesh-apps')
    const { ManualStrategy } = await import('@johnhenry/browsermesh-discovery')
    mcp = await import('../../src/index.mjs')

    const shared = bus()
    for (const label of ['alice', 'bob']) {
      nodes[label] = await createMeshNode({
        label,
        discoveryStrategies: [new ManualStrategy()],
        signalingTransport: busTransport(shared),
        iceServers: [],
      })
    }
    const { alice, bob } = nodes
    await alice.connectToPeer(bob.podId, { webrtc: bob.podId }, { answerTimeoutMs: 10_000, openTimeoutMs: 10_000 })
    await waitFor(() => bob.hasActiveSession(alice.podId), 10_000, "bob's session with alice")
    for (const label of ['alice', 'bob']) svc[label] = attachService(nodes[label], undefined, createMeshProtocolService()).api

    mcp.serveMcpOnMesh(svc.bob, {
      allow: ['lookup', 'transfer'],
      tools: [
        { name: 'lookup', description: 'reads', annotations: { readOnlyHint: true }, execute: async ({ q }) => { ran.push(['lookup', q]); return `found ${q}` } },
        { name: 'transfer', description: 'moves money', annotations: {}, execute: async ({ q }) => { ran.push(['transfer', q]); return `moved ${q}` } },
      ],
      prompt: async (call, who) => { asked.push({ name: call.name, who: who.podId }); return true },
    })
  })

  after(async () => {
    for (const n of Object.values(nodes)) { try { await n.shutdown?.() } catch { /* already down */ } }
    try { ndcMain.cleanup() } catch { /* nothing to clean up */ }
  })

  it('refuses a peer with no grant, then lists and calls with the grants, asking bob before the consequential one', async () => {
    const { alice, bob } = nodes
    assert.equal(await code(mcp.connectMcpOnMesh(svc.alice, bob.podId)), -32003, 'default deny, over the real channel')

    bob.registry.grantCapabilities(alice.podId, [...mcp.mcpScopes.open(), ...mcp.mcpScopes.tool('lookup'), 'mcp:transfer:list'])
    const client = await mcp.connectMcpOnMesh(svc.alice, bob.podId)
    await client.initialize()
    assert.deepEqual((await client.listTools()).map((t) => t.name).sort(), ['lookup', 'transfer'])

    const result = await client.callTool('lookup', { q: 'x' })
    assert.equal(result.content[0].text, 'found x')
    assert.equal(result.untrusted, true)
    assert.equal(asked.length, 0, 'a read-only tool asks nobody')

    assert.equal(await code(client.callTool('transfer', { q: '5' })), -32602, 'listed, but no call grant')
    assert.deepEqual(ran, [['lookup', 'x']])

    bob.registry.grantCapabilities(alice.podId, ['mcp:transfer:call'])
    assert.equal((await client.callTool('transfer', { q: '5' })).content[0].text, 'moved 5')
    assert.deepEqual(asked, [{ name: 'transfer', who: alice.podId }], 'bob was asked, and saw alice\'s verified pod id')

    bob.registry.revokeCapabilities(alice.podId, ['mcp:transfer:call'])
    assert.equal(await code(client.callTool('transfer', { q: '6' })), -32602, 'revoked: the very next call is refused')
    assert.equal(ran.length, 2)
    client.close()
  })
})
