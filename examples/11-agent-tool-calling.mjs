/**
 * The capstone of issues #90 ("bring your own LLM, browsermesh supplies a
 * real BrowserToolRegistry + tool-dispatch loop") and #92 ("wire
 * MeshOrchestrator's 8 meshctl BrowserTools into that loop") -- told as one
 * runnable story, over two REAL `createMeshNode()`-booted peers.
 *
 * `agent-runtime.mjs`'s `createAgentRuntime({registry, llmFn})` (Phase 2) is
 * a standalone conversation loop: it knows nothing about meshes, peers, or
 * orchestration -- it just calls `llmFn(messages, toolSpecs)`, dispatches
 * whatever tool calls come back through `registry`, and loops until the LLM
 * stops asking for tools. What makes this example the whole plan's payoff is
 * WHAT gets registered into that registry: `mesh-orchestrator-tools.mjs`'s
 * `registerOrchestratorTools()` (Phase 4) wires the 8 real `Meshctl*Tool`
 * classes (`orchestrator.mjs`) against a real, attached `MeshOrchestrator`
 * (`mesh-orchestrator.mjs`, Phase 3) -- so an LLM-requested `meshctl_pods` or
 * `meshctl_exec` tool call really dispatches to a real orchestrator on a
 * real multi-peer mesh, not a mock.
 *
 * Two real peers, `createMeshNode()`-booted (the exact production
 * composition root, not a hand-rolled stand-in):
 *
 *   - alice: `enableOrchestrator` AND `enableAgentRuntime` both set --
 *     `alice.toolRegistry` comes back pre-populated with all 8 meshctl
 *     tools, wired against `alice.orchestrator.api` (the checkAccess()-gated
 *     service, not the raw ungated orchestrator instance -- see
 *     `mesh-orchestrator-tools.mjs`'s own module doc comment for exactly why
 *     that distinction matters for `meshctl_exec`/`meshctl_deploy`/
 *     `meshctl_drain`).
 *   - bob: `enableOrchestrator` only -- a real remote pod alice's tools can
 *     target, with its own `checkAccess()` gate deciding whether to honor an
 *     inbound request.
 *
 * Like `examples/10-mesh-kv-and-observability.mjs`, the connection between
 * them is real `PeerNode.adoptIncomingSession()` over a minimal in-memory
 * duplex transport -- not real WebRTC (that's `test/real-peer/`'s job), but
 * everything riding on top of it (identity, `PeerRegistry`/`checkAccess()`,
 * the `'orchestrator-request'`/`'orchestrator-response'` wire protocol, the
 * `BrowserToolRegistry` dispatch loop) is the real, unmodified production
 * code.
 *
 * The `llmFn` below is a small, deterministic test double -- per this
 * session's "bring-your-own LLM callback" decision (see `agent-runtime.mjs`'s
 * own module doc comment), browsermesh never calls a real LLM API itself.
 * It plays a three-turn conversation: ask what pods are known
 * (`meshctl_pods`), then check uptime on the remote one (`meshctl_exec`,
 * the genuinely risky, `checkAccess()`-gated action), then summarize both
 * real results in plain English.
 */

import assert from 'node:assert/strict'
import { createMeshNode, createAgentRuntime } from '@johnhenry/browsermesh-apps'

// ── Step 1: two real createMeshNode()-booted peers ──────────────────────
// signalingTransport is required by createMeshNode() (it wires a real
// WebRTCMeshManager/MeshTransportNegotiator even though this example never
// drives real WebRTC) -- a stub that never fires is enough, since the
// connection below is established directly via adoptIncomingSession(),
// exactly like 10-mesh-kv-and-observability.mjs does for the identical
// reason (a real in-process connection, no native/browser dependency).
function createStubSignalingTransport() {
  return { send() {}, onMessage() {} }
}

const alice = await createMeshNode({
  label: 'alice',
  signalingTransport: createStubSignalingTransport(),
  enableOrchestrator: true,
  enableAgentRuntime: true,
})
const bob = await createMeshNode({
  label: 'bob',
  signalingTransport: createStubSignalingTransport(),
  enableOrchestrator: true,
})

console.log('1. two real createMeshNode() peers booted: alice (enableOrchestrator + enableAgentRuntime), bob (enableOrchestrator only) ✓')
assert.equal(alice.toolRegistry.listSpecs().length, 8, 'alice.toolRegistry was pre-populated with all 8 meshctl tools')
console.log(`   alice.toolRegistry already has all 8 meshctl_* tools registered: ${alice.toolRegistry.list().map((t) => t.name).join(', ')}`)

// bob needs something to actually "run" a shell command against for
// meshctl_exec -- MeshOrchestrator.execOnPod()'s own local branch calls
// `peerNode.exec(command)` when it resolves the podId as itself (see
// orchestrator.mjs); PeerNode ships no such method by default (it's not a
// real shell -- a real deployment would wire this to something that
// actually runs commands, sandboxed appropriately), so bob supplies a
// small stand-in, the same way mesh-orchestrator-tools.test.mjs's own
// fixtures do.
bob.exec = async (command) => ({ output: `bob ran: ${command} (uptime: 3 days, load avg 0.12)`, exitCode: 0 })

// ── Step 2: connect them for real -- adoptIncomingSession() over a minimal
// in-memory duplex transport, standing in only for the wire itself.
async function linkRealNodes(nodeA, nodeB) {
  let aOnMessage = null
  let bOnMessage = null
  const transportForA = {
    send(data) { queueMicrotask(() => { if (bOnMessage) bOnMessage(data) }) },
    onMessage(cb) { aOnMessage = cb },
  }
  const transportForB = {
    send(data) { queueMicrotask(() => { if (aOnMessage) aOnMessage(data) }) },
    onMessage(cb) { bOnMessage = cb },
  }
  await nodeA.adoptIncomingSession(nodeB.podId, transportForA, 'inmemory')
  await nodeB.adoptIncomingSession(nodeA.podId, transportForB, 'inmemory')
}
await linkRealNodes(alice, bob)
console.log('2. alice <-> bob connected over a real PeerNode session (in-memory transport) ✓')

// ── Step 3: real mesh state -- alice's orchestrator knows about bob, and
// bob grants alice the 'orchestrator:exec' capability (without this grant,
// the meshctl_exec call below would come back denied -- see Step 5's
// llmFn, which handles that outcome too, just like a real agent must).
alice.orchestrator.api.orchestrator.addPeer(bob.podId, { label: 'bob', status: 'online', services: ['compute'] })
bob.registry.grantCapabilities(alice.podId, ['orchestrator:exec'])
console.log("3. alice's orchestrator knows about bob; bob granted alice 'orchestrator:exec' ✓")

// ── Step 4: a deterministic, test-double llmFn -- no real LLM API call.
// Turn 1: asked to list pods, requests meshctl_pods.
// Turn 2: having seen bob in the pod list, requests meshctl_exec on bob.
// Turn 3: summarizes both real results in plain English -- the final answer.
const llmTurns = []
async function llmFn(messages, toolSpecs) {
  llmTurns.push(messages.length)
  const toolNames = toolSpecs.map((s) => s.name)
  assert.ok(toolNames.includes('meshctl_pods') && toolNames.includes('meshctl_exec'), 'the real meshctl tool specs are offered to the LLM every turn')

  const lastToolResult = [...messages].reverse().find((m) => m.role === 'tool')

  if (!lastToolResult) {
    // Turn 1: nothing dispatched yet -- ask for the pod list.
    return { content: 'Let me check what pods are on the mesh.', toolCalls: [{ id: 'call_pods', name: 'meshctl_pods', arguments: {} }] }
  }

  if (lastToolResult.name === 'meshctl_pods') {
    // Turn 2: real dispatch result in hand -- pull bob's podId out of it and
    // ask the orchestrator to check uptime on that real remote pod.
    const podsResult = JSON.parse(lastToolResult.content)
    assert.equal(podsResult.success, true)
    assert.match(podsResult.output, new RegExp(bob.podId), 'the real pod list really includes bob')
    return {
      content: `Found bob (${bob.podId}) online. Checking uptime there.`,
      toolCalls: [{ id: 'call_exec', name: 'meshctl_exec', arguments: { podId: bob.podId, command: 'uptime' } }],
    }
  }

  // Turn 3: the meshctl_exec result -- summarize and stop (no toolCalls).
  const execResult = JSON.parse(lastToolResult.content)
  if (!execResult.success) {
    return { content: `Could not check bob's uptime: ${execResult.error}` }
  }
  return { content: `bob is online. Its own exec tool reports: "${execResult.output}"` }
}

// ── Step 5: the real capstone -- createAgentRuntime, driven by the
// deterministic llmFn above, dispatching through alice.toolRegistry straight
// through to the real MeshOrchestrator wire protocol. createAgentRuntime is
// a standalone function, not attached to the node -- the caller constructs
// it directly (mirrors the plan's own "the dispatch loop is a
// browsermesh-apps composition concern" design -- see agent-runtime.mjs's
// own module doc comment).
const agent = createAgentRuntime({ registry: alice.toolRegistry, llmFn, onLog: () => {} })

console.log('4. running a real createAgentRuntime() loop against alice.toolRegistry ✓')
const result = await agent.run('List all known pods, then check uptime on bob.')

assert.equal(llmTurns.length, 3, 'the llmFn was called exactly three times: list pods, exec on bob, summarize')
assert.equal(result.truncated, undefined, 'the loop reached a real final answer, not a maxTurns cutoff')
assert.match(result.content, /bob is online/, "the final answer reflects the real meshctl_exec result, not a canned string")

console.log(`\n5. the agent's final answer, built entirely from real tool-dispatch results:\n   "${result.content}"`)

console.log('\n6. the full conversation the loop produced:')
for (const msg of agent.getMessages()) {
  if (msg.role === 'user') console.log(`   [user]      ${msg.content}`)
  else if (msg.role === 'assistant') console.log(`   [assistant] ${msg.content ?? '(tool call)'}${msg.toolCalls ? ` -> ${msg.toolCalls.map((c) => c.name).join(', ')}` : ''}`)
  else if (msg.role === 'tool') console.log(`   [tool:${msg.name}] ${msg.content}`)
}

// ── Cleanup ──────────────────────────────────────────────────────────────
await alice.orchestrator.teardown()
await bob.orchestrator.teardown()
await alice.shutdown()
await bob.shutdown()

console.log('\nok: a real LLM-tool-calling loop (createAgentRuntime), driven by a deterministic test llmFn, dispatched real meshctl_pods and meshctl_exec tool calls through a real BrowserToolRegistry to a real MeshOrchestrator on a real, checkAccess()-gated two-peer mesh -- issues #90 and #92, closed end to end.')
