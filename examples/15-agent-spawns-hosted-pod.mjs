/**
 * Issue #185 §8a item 4: the hosted-pods control surface, driven by an
 * LLM-shaped tool-calling loop -- the same pattern
 * `11-agent-tool-calling.mjs` establishes (a deterministic test `llmFn`, a
 * real `createAgentRuntime()`, real `Meshctl*Tool`s dispatched through a
 * real `BrowserToolRegistry`), now exercising the FIVE new tools
 * `mesh-orchestrator-tools.mjs` registers alongside the original eight:
 * `meshctl_hosts`, `meshctl_spawn` (with `host: 'auto'`),
 * `meshctl_hosted_pods`, `meshctl_snapshot` and `meshctl_restore` -- plus
 * the pre-existing `meshctl_drain` to close the loop on the host pod
 * itself.
 *
 * Cast:
 *   - `host`:     a `createMeshNode({enableOrchestrator})` peer hosting pods
 *     (`createPodHostService()` over an `InMemoryPodHostDriver`, lane
 *     `'node'` -- see `13-pod-host-service.mjs` for why the in-memory
 *     driver keeps this dependency-free and runnable on a laptop under
 *     `npm run examples`). `enableOrchestrator` (but not
 *     `enableAgentRuntime` -- it has no tools of its own to offer an LLM)
 *     is what lets it honor the closing `meshctl_drain` call for real, the
 *     same way `11-agent-tool-calling.mjs`'s `bob` does for `meshctl_exec`.
 *   - `operator`: a `createMeshNode({enableOrchestrator, enableAgentRuntime})`
 *     peer, pre-populated with all 15 `meshctl_*` tools against its own,
 *     real `MeshOrchestrator` -- wired with a `runtimeRegistry` carrying
 *     `host`'s `describe()`-derived runtime-registry peer, so
 *     `meshctl_hosts`/`meshctl_spawn`'s auto host selection can see it.
 *
 * The LLM's six-step plan: discover hosts, spawn a job letting the
 * orchestrator pick the host ("orchestrator proposes, host accepts"), list
 * what the host is tracking, snapshot the job, restore it, then drain the
 * HOST POD ITSELF (`meshctl_drain` -- a mesh-peer-level action, distinct
 * from `pod-host-service.mjs`'s own per-pod `drain` verb) -- demonstrating
 * that the five new tools compose with the pre-existing eight, not just
 * alongside them.
 */

import assert from 'node:assert/strict'
import { InMemoryPodHostDriver, POD_LANE } from '@johnhenry/browsermesh-pod'
import {
  attachService,
  createPodHostService,
  DEFAULT_POD_HOST_RESOURCE,
  createMeshNode,
  createAgentRuntime,
} from '@johnhenry/browsermesh-apps'

const RESOURCE = DEFAULT_POD_HOST_RESOURCE
const ALL_VERBS = ['spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list']

function createStubSignalingTransport() {
  return { send() {}, onMessage() {} }
}

// ── Step 1: the pod host -- enableOrchestrator only, no tools of its own. ──
const host = await createMeshNode({
  label: 'render-host',
  signalingTransport: createStubSignalingTransport(),
  enableOrchestrator: true,
})

const hostHandle = attachService(host, undefined, createPodHostService({
  driver: new InMemoryPodHostDriver({ lane: POD_LANE.NODE }),
  hostLabel: 'render-host',
}))

console.log(`1. render-host booted and is serving the pod-host protocol (lane='${hostHandle.api.lane}') ✓`)

// ── Step 2: the operator -- a real createMeshNode() peer, pre-populated
// with all 15 meshctl_* tools, wired with a runtimeRegistry that already
// knows about render-host (the same `podHostRuntimePeer()` projection a
// real deployment would feed a RemoteRuntimeRegistry on announce).
function makeRuntimeRegistry(peers) {
  return {
    listPeers() { return peers },
    resolvePeer(selector) { return peers.find((p) => p.identity?.podId === selector) || null },
  }
}

const runtimeRegistry = makeRuntimeRegistry([hostHandle.api.runtimePeer()])

const operator = await createMeshNode({
  label: 'operator',
  signalingTransport: createStubSignalingTransport(),
  enableOrchestrator: true,
  enableAgentRuntime: true,
  orchestratorOptions: { runtimeRegistry },
})

console.log(`2. operator booted via createMeshNode(): toolRegistry has ${operator.toolRegistry.listSpecs().length} meshctl_* tools ✓`)
assert.equal(operator.toolRegistry.listSpecs().length, 15)

// ── Step 3: link them for real, and grant the operator every pod-host verb
// PLUS the orchestrator-level 'drain' scope the closing meshctl_drain call
// needs (a different gate from the pod-host verbs above: mesh-orchestrator.
// mjs's own RISKY_ACTIONS, checked as 'orchestrator:drain').
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
await linkRealNodes(host, operator)
host.registry.grantCapabilities(operator.podId, [
  ...ALL_VERBS.map((verb) => `${RESOURCE}:${verb}`),
  'orchestrator:drain',
])

// The host is also a known PEER of the operator's orchestrator (distinct
// from the runtimeRegistry wiring above) -- needed for the closing
// meshctl_drain step, which drains a mesh PEER, not a hosted pod by name.
operator.orchestrator.api.orchestrator.addPeer(host.podId, { label: 'render-host', status: 'online', services: ['pod-host'] })

console.log(`3. host <-> operator linked; operator granted all ${ALL_VERBS.length} pod-host verbs on render-host ✓`)

// ── Step 4: a deterministic, test-double llmFn -- no real LLM API call
// (browsermesh's "bring your own LLM callback" design, same as
// 11-agent-tool-calling.mjs). Six tool calls, one per step of the plan.
const spawnedName = 'batch-render'
let hostPodId = null
const llmTurns = []

async function llmFn(messages, toolSpecs) {
  llmTurns.push(messages.length)
  const toolNames = toolSpecs.map((s) => s.name)
  for (const expected of ['meshctl_hosts', 'meshctl_spawn', 'meshctl_hosted_pods', 'meshctl_snapshot', 'meshctl_restore', 'meshctl_drain']) {
    assert.ok(toolNames.includes(expected), `${expected} is offered to the LLM as a real tool spec`)
  }

  const lastTool = [...messages].reverse().find((m) => m.role === 'tool')

  if (!lastTool) {
    return {
      content: 'First, let me see what pod hosts are available.',
      toolCalls: [{ id: 'call_hosts', name: 'meshctl_hosts', arguments: {} }],
    }
  }

  if (lastTool.name === 'meshctl_hosts') {
    const result = JSON.parse(lastTool.content)
    assert.equal(result.success, true)
    const match = result.output.match(/^(\S+) \| node \|/m)
    assert.ok(match, 'a node-lane pod host is listed')
    hostPodId = match[1]
    return {
      content: `Found pod host ${hostPodId}. Spawning a batch render job -- letting the orchestrator pick the host.`,
      toolCalls: [{
        id: 'call_spawn',
        name: 'meshctl_spawn',
        arguments: { host: 'auto', name: spawnedName, lane: 'node', run: { kind: 'command', ref: '/usr/bin/ffmpeg' } },
      }],
    }
  }

  if (lastTool.name === 'meshctl_spawn') {
    const result = JSON.parse(lastTool.content)
    assert.equal(result.success, true)
    assert.match(result.output, new RegExp(`orchestrator proposes host ${hostPodId}`))
    return {
      content: `Spawned '${spawnedName}' on ${hostPodId}. Checking what the host is tracking now.`,
      toolCalls: [{ id: 'call_hosted', name: 'meshctl_hosted_pods', arguments: { host: hostPodId } }],
    }
  }

  if (lastTool.name === 'meshctl_hosted_pods') {
    const result = JSON.parse(lastTool.content)
    assert.equal(result.success, true)
    assert.match(result.output, new RegExp(spawnedName))
    return {
      content: `Confirmed '${spawnedName}' is registered on the host. Snapshotting it for later.`,
      toolCalls: [{ id: 'call_snapshot', name: 'meshctl_snapshot', arguments: { host: hostPodId, name: spawnedName } }],
    }
  }

  if (lastTool.name === 'meshctl_snapshot') {
    const result = JSON.parse(lastTool.content)
    assert.equal(result.success, true)
    assert.match(result.output, /state=snapshotted/)
    return {
      content: 'Snapshotted. Restoring it to keep the job going.',
      toolCalls: [{ id: 'call_restore', name: 'meshctl_restore', arguments: { host: hostPodId, name: spawnedName } }],
    }
  }

  if (lastTool.name === 'meshctl_restore') {
    const result = JSON.parse(lastTool.content)
    assert.equal(result.success, true)
    assert.match(result.output, /state=registered/)
    return {
      content: `Restored. The job is done for now -- draining ${hostPodId} itself.`,
      toolCalls: [{ id: 'call_drain', name: 'meshctl_drain', arguments: { podId: hostPodId } }],
    }
  }

  // Final turn: the meshctl_drain result -- summarize and stop.
  const result = JSON.parse(lastTool.content)
  assert.equal(result.success, true)
  return { content: `Done: discovered ${hostPodId}, spawned '${spawnedName}', listed it, snapshotted it, restored it, and drained the host pod.` }
}

console.log('4. running a real createAgentRuntime() loop against operator.toolRegistry ✓')

const agent = createAgentRuntime({ registry: operator.toolRegistry, llmFn, onLog: () => {} })
const result = await agent.run('Find a pod host, run a batch render job on it, snapshot/restore it, then drain the host.')

assert.equal(llmTurns.length, 7, 'the llmFn was called exactly seven times: hosts, spawn, hosted_pods, snapshot, restore, drain, summarize')
assert.equal(result.truncated, undefined, 'the loop reached a real final answer, not a maxTurns cutoff')
assert.match(result.content, /Done: discovered/)

console.log(`\n5. the agent's final answer:\n   "${result.content}"`)

console.log('\n6. every tool result the loop actually produced, printed in order:')
for (const msg of agent.getMessages()) {
  if (msg.role === 'tool') {
    const parsed = JSON.parse(msg.content)
    console.log(`   [tool:${msg.name}] success=${parsed.success}`)
    for (const line of (parsed.output || '').split('\n')) {
      if (line) console.log(`     ${line}`)
    }
    if (parsed.error) console.log(`     error: ${parsed.error}`)
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────────
await hostHandle.teardown()
await host.orchestrator.teardown()
await host.shutdown()
await operator.orchestrator.teardown()
await operator.shutdown()

console.log('\nok: a real LLM-tool-calling loop drove the hosted-pods control surface end to end --')
console.log('meshctl_hosts -> meshctl_spawn (auto) -> meshctl_hosted_pods -> meshctl_snapshot ->')
console.log('meshctl_restore -> meshctl_drain -- issue #185 §8a item 4, closed.')
