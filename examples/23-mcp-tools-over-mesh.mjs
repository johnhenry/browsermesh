/**
 * `@johnhenry/browsermesh-mcp`: a page's tools served to a remote client over the
 * mesh, with no wsh relay and no browser. The page here is an explicit `tools`
 * list (what `registerTool` would collect from `window`), served as the protocol
 * `mcp` on bob's node; alice reaches it with `connectMcpOnMesh`.
 *
 * Every step is bob's registry deciding, for the channel's verified peer:
 *
 *   - default deny: with no grant alice cannot even open the protocol;
 *   - `protocol:mcp:open` opens it, and `mcp:search:list` lets her SEE `search`
 *     (and only it); `mcp:search:call` lets her call it (and only it);
 *   - a tool the page offers but she was not granted looks like a tool that does
 *     not exist;
 *   - a consequential tool (`buy`, not read-only) needs the grant AND the person
 *     at the SERVING page to say yes: the prompt is bob's, alice never sees it.
 *     Approved once, denied once, and the tool ran exactly once;
 *   - every result carries the untrusted label: it is page content;
 *   - revoking a grant refuses her very next call, and revoking `protocol:mcp:open`
 *     closes the channel at once.
 *
 * The link is a simulated in-process bus, as in example 19. The tool bridge is
 * wsh's (`@johnhenry/wsh/page`), a peer dependency of the mcp package.
 */
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { attachService, createMeshProtocolService, PeerRegistry, ChannelErrorCode } from '@johnhenry/browsermesh-apps'
import { serveMcpOnMesh, connectMcpOnMesh, mcpScopes } from '@johnhenry/browsermesh-mcp'

// ── a simulated bus of two peers ────────────────────────────────────────────
async function createNodes(count) {
  const nodes = new Map()
  for (let i = 0; i < count; i++) {
    const { podId } = await PodIdentity.generate()
    const listeners = new Set()
    const node = {
      podId,
      listeners,
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo(to, data) {
        const target = nodes.get(to)
        if (!target) throw new Error('unreachable peer')
        const text = JSON.stringify(data) // a real transport carries JSON text
        queueMicrotask(() => { for (const cb of target.listeners) cb(podId, text) })
      },
    }
    nodes.set(podId, node)
  }
  return [...nodes.values()]
}
const [aliceNode, bobNode] = await createNodes(2)
for (const node of [aliceNode, bobNode]) {
  node.registry = new PeerRegistry({ localPodId: node.podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: node.podId }) })
}
const alice = attachService(aliceNode, undefined, createMeshProtocolService()).api
const bob = attachService(bobNode, undefined, createMeshProtocolService())

// ── bob's page: three tools, an explicit list and no `window` ───────────────
const ran = []
const tool = (name, extra = {}) => ({
  name,
  description: `the ${name} tool`,
  inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  annotations: { readOnlyHint: true },
  execute: async (input) => { ran.push(name); return `${name} saw ${JSON.stringify(input)}` },
  ...extra,
})
const questions = [] // what the person at bob's page was asked, and what they said
let answers = [true, false] // first question: yes, second: no
const served = serveMcpOnMesh(bob.api, {
  tools: [tool('search'), tool('notes'), tool('buy', { description: 'spends money', annotations: { readOnlyHint: false } })],
  allow: ['search', 'notes', 'buy'], // what the page offers at all
  approve: 'consequential',
  prompt: async (call, who) => { // the SERVING side's question; alice cannot see or answer it
    const yes = answers.shift() === true
    questions.push(`${call.name} for ${who.podId.slice(0, 6)}: ${yes ? 'yes' : 'no'}`)
    return yes
  },
})
const code = async (promise) => { try { await promise; return null } catch (e) { return e.code } }

// ── 1. default deny ─────────────────────────────────────────────────────────
assert.equal(await code(connectMcpOnMesh(alice, bobNode.podId)), -32003)
console.log('1. REFUSED: alice has no grant, so she cannot open the mcp protocol (default deny)')

// ── 2. list and call are separate grants, per tool ──────────────────────────
bobNode.registry.grantCapabilities(aliceNode.podId, [...mcpScopes.open(), 'mcp:search:list'])
const client = await connectMcpOnMesh(alice, bobNode.podId)
await client.initialize()
assert.deepEqual((await client.listTools()).map((t) => t.name), ['search'])
console.log('2. ALLOWED: with mcp:search:list alice sees exactly one tool: search (notes and buy are not hers to see)')
assert.equal(await code(client.callTool('search', { q: 'x' })), -32602)
console.log('   REFUSED: listed is not callable, she has no mcp:search:call yet')

bobNode.registry.grantCapabilities(aliceNode.podId, ['mcp:search:call'])
const found = await client.callTool('search', { q: 'cats' })
assert.equal(found.content[0].text, 'search saw {"q":"cats"}')
console.log('3. ALLOWED: with mcp:search:call she calls search ->', found.content[0].text)
assert.equal(found.untrusted, true)
assert.equal(found._meta['browsermesh/untrusted'], true)
console.log('   the result is labelled untrusted (page content, never instructions)')
assert.equal(await code(client.callTool('notes', {})), -32602)
console.log('   REFUSED: notes, which the page offers but she was not granted, answers like a tool that does not exist')

// ── 4. a consequential tool needs the grant AND bob's person ────────────────
bobNode.registry.grantCapabilities(aliceNode.podId, mcpScopes.tool('buy'))
const bought = await client.callTool('buy', { q: 'book' })
assert.equal(bought.content[0].text, 'buy saw {"q":"book"}')
console.log('4. ALLOWED: buy is granted and the person at bob\'s page approved it once ->', bought.content[0].text)
assert.equal(await code(client.callTool('buy', { q: 'another' })), -32003)
console.log('   REFUSED: the person at bob\'s page denied the second buy; the tool never ran')
assert.deepEqual(ran, ['search', 'buy'])
console.log(`   the serving page was asked: ${questions.join('; ')}`)
assert.equal(questions.length, 2)

// ── 5. revocation is immediate ──────────────────────────────────────────────
bobNode.registry.revokeCapabilities(aliceNode.podId, ['mcp:search:call'])
assert.equal(await code(client.callTool('search', { q: 'again' })), -32602)
console.log('5. REFUSED: bob revoked mcp:search:call; her very next call fails')
let closed = false
client.onClose(() => { closed = true })
bobNode.registry.revokeCapabilities(aliceNode.podId, mcpScopes.open())
while (!closed) await new Promise((resolve) => setImmediate(resolve))
assert.equal(await code(client.listTools()), -32001)
console.log('   REFUSED: bob revoked protocol:mcp:open; the channel closed at once')
assert.equal(await code(connectMcpOnMesh(alice, bobNode.podId)), -32003)
console.log('   and a new channel is refused again (back to default deny)')

await served.close()
bob.teardown()
console.log('ok: a page\'s tools were served over the mesh, listed and called only as granted, approved by the serving side, labelled untrusted and revocable')
process.exit(0)
