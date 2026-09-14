// Run with: node --import ./test/_setup-globals.mjs --test test/mesh-orchestrator-tools.test.mjs
//
// Phase 4 of the agent-runtime plan (issues #90/#92): registerOrchestratorTools()/
// createOrchestratorToolRegistry() (mesh-orchestrator-tools.mjs) wire the 8 real
// Meshctl*Tool classes (orchestrator.mjs) into a real BrowserToolRegistry
// (compat.mjs, Phase 1) against a real, attached MeshOrchestrator
// (mesh-orchestrator.mjs, Phase 3). This file proves:
//   1. all 8 tools register with the expected names/schemas;
//   2. invoking one through the registry really calls through to a real
//      MeshOrchestrator on a real multi-peer mesh;
//   3. meshctl_exec/meshctl_deploy/meshctl_drain, reached THROUGH the
//      registered tools, really go through the orchestrator service's gated
//      wire dispatch (an unauthorized remote call is really denied; an
//      authorized one really runs on the real remote peer) -- the whole
//      point of preferring the service `api` shape over the raw instance;
//   4. the createMeshNode({ enableAgentRuntime, enableOrchestrator }) opt-in
//      wiring in mesh-bootstrap.mjs;
//   5. the full capstone: a real createAgentRuntime({registry, llmFn}) (Phase
//      2) with a deterministic test llmFn actually dispatching a
//      meshctl_pods tool call through the registry to a real orchestrator on
//      a real multi-peer mesh and getting a real result back into the
//      conversation.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createOrchestratorService } from '../src/mesh-orchestrator.mjs';
import { MeshOrchestrator } from '../src/orchestrator.mjs';
import { attachService } from '../src/mesh-service.mjs';
import { PeerRegistry } from '../src/peer-registry.mjs';
import { createMeshNode } from '../src/mesh-bootstrap.mjs';
import { BrowserToolRegistry } from '../src/compat.mjs';
import { createAgentRuntime } from '../src/agent-runtime.mjs';
import {
  registerOrchestratorTools,
  createOrchestratorToolRegistry,
} from '../src/mesh-orchestrator-tools.mjs';
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core';

// ── Fixtures ─────────────────────────────────────────────────────────
// Mirrors mesh-orchestrator.test.mjs's own: real Ed25519 IdentityWallet/
// MeshIdentityManager identities + real PeerRegistry (wired to real
// MeshACL/MeshPeerManager/TrustGraph from @johnhenry/browsermesh-core),
// connected via a duck-typed in-memory sendTo()/onIncomingData()/listPeers()
// bus.

async function createTestPeer(label) {
  const identityManager = new MeshIdentityManager({});
  const wallet = new IdentityWallet({ identityManager });
  const { podId } = await wallet.createIdentity(label);
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId }),
  });
  return { podId, wallet, registry };
}

function wireFullMesh(peers) {
  const listenersByPodId = new Map(peers.map((p) => [p.podId, new Set()]));
  const nodesByPodId = {};
  for (const peer of peers) {
    nodesByPodId[peer.podId] = {
      podId: peer.podId,
      wallet: peer.wallet,
      registry: peer.registry,
      onIncomingData(cb) {
        const set = listenersByPodId.get(peer.podId);
        set.add(cb);
        return () => set.delete(cb);
      },
      async sendTo(pubKey, data) {
        const set = listenersByPodId.get(pubKey);
        if (!set) return;
        queueMicrotask(() => {
          for (const cb of set) cb(peer.podId, data);
        });
      },
      listPeers(filter) {
        return peers
          .filter((p) => p.podId !== peer.podId)
          .filter((p) => !filter?.status || filter.status === 'connected')
          .map((p) => ({ fingerprint: p.podId, status: 'connected' }));
      },
    };
  }
  return nodesByPodId;
}

async function waitFor(fn, timeoutMs = 1000, what = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`);
}

function createStubSignalingTransport() {
  return { send() {}, onMessage() {} };
}

// -----------------------------------------------------------------------
// All 8 tools register with the expected names/schemas.
// -----------------------------------------------------------------------

describe('registerOrchestratorTools: all 8 Meshctl*Tools register correctly', () => {
  it('registers all 8 tools with the expected names, appearing in registry.listSpecs()', async () => {
    const alice = await createTestPeer('alice');
    const mesh = wireFullMesh([alice]);
    const { api } = attachService(mesh[alice.podId], undefined, createOrchestratorService());

    const registry = new BrowserToolRegistry();
    const tools = registerOrchestratorTools(registry, api);

    assert.equal(tools.length, 8);
    const specs = registry.listSpecs();
    const names = specs.map((s) => s.name).sort();
    assert.deepEqual(names, [
      'meshctl_compute',
      'meshctl_deploy',
      'meshctl_drain',
      'meshctl_exec',
      'meshctl_expose',
      'meshctl_pods',
      'meshctl_status',
      'meshctl_top',
    ]);

    // Every spec is a real ToolSpec: name/description/parameters/required_permission.
    for (const spec of specs) {
      assert.equal(typeof spec.name, 'string');
      assert.equal(typeof spec.description, 'string');
      assert.equal(typeof spec.parameters, 'object');
      assert.equal(typeof spec.required_permission, 'string');
    }
    const byName = Object.fromEntries(specs.map((s) => [s.name, s]));
    assert.equal(byName.meshctl_pods.required_permission, 'read');
    assert.equal(byName.meshctl_exec.required_permission, 'network');
    assert.equal(byName.meshctl_deploy.required_permission, 'write');
    assert.deepEqual(byName.meshctl_exec.parameters.required, ['podId', 'command']);
  });

  it('createOrchestratorToolRegistry() is equivalent, building a fresh registry itself', async () => {
    const alice = await createTestPeer('alice');
    const mesh = wireFullMesh([alice]);
    const { api } = attachService(mesh[alice.podId], undefined, createOrchestratorService());

    const registry = createOrchestratorToolRegistry(api);
    assert.ok(registry instanceof BrowserToolRegistry);
    assert.equal(registry.listSpecs().length, 8);
  });

  it('throws a clear error when registry is missing register()', () => {
    assert.throws(
      () => registerOrchestratorTools({}, {}),
      /registry is required/,
    );
  });

  it('throws a clear error when orchestrator matches neither accepted shape', () => {
    const registry = new BrowserToolRegistry();
    assert.throws(
      () => registerOrchestratorTools(registry, { not: 'an orchestrator' }),
      /orchestrator must be either/,
    );
  });

  it('also accepts a raw MeshOrchestrator instance directly (no wrapping service)', async () => {
    const alice = await createTestPeer('alice');
    const mesh = wireFullMesh([alice]);
    const raw = new MeshOrchestrator({ peerNode: mesh[alice.podId], peerRegistry: alice.registry });

    const registry = new BrowserToolRegistry();
    const tools = registerOrchestratorTools(registry, raw);
    assert.equal(tools.length, 8);

    // Local-only queries still work fine straight off the raw instance.
    const result = await registry.get('meshctl_pods').execute({});
    assert.equal(result.success, true);
  });
});

// -----------------------------------------------------------------------
// Invoking a registered tool really calls through to a real MeshOrchestrator
// on a real multi-peer mesh (meshctl_pods/meshctl_status/meshctl_top --
// local-only aggregation, no gate either way).
// -----------------------------------------------------------------------

describe('registered tools: real dispatch to a real multi-peer mesh', () => {
  it('meshctl_pods.execute() reflects peers registered via addPeer() on a real orchestrator', async () => {
    const alice = await createTestPeer('alice');
    const bob = await createTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    const { api: aliceApi } = attachService(mesh[alice.podId], undefined, createOrchestratorService());
    attachService(mesh[bob.podId], undefined, createOrchestratorService());

    aliceApi.orchestrator.addPeer(bob.podId, { label: 'bob', status: 'online', services: ['web'], connections: 1 });

    const registry = new BrowserToolRegistry();
    registerOrchestratorTools(registry, aliceApi);

    const result = await registry.get('meshctl_pods').execute({});
    assert.equal(result.success, true);
    assert.match(result.output, new RegExp(alice.podId));
    assert.match(result.output, new RegExp(bob.podId));
    assert.match(result.output, /\(local\)/);
  });

  it('meshctl_status.execute() and meshctl_top.execute() reflect real orchestrator state', async () => {
    const alice = await createTestPeer('alice');
    const mesh = wireFullMesh([alice]);
    const { api } = attachService(mesh[alice.podId], undefined, createOrchestratorService());
    api.orchestrator.addPeer('remote-pod', { label: 'remote', resources: { cpu: 2, memory: 512, storage: 1024 } });

    const registry = new BrowserToolRegistry();
    registerOrchestratorTools(registry, api);

    const statusResult = await registry.get('meshctl_status').execute({ podId: 'remote-pod' });
    assert.equal(statusResult.success, true);
    assert.match(statusResult.output, /remote-pod/);

    const topResult = await registry.get('meshctl_top').execute({});
    assert.equal(topResult.success, true);
    assert.match(topResult.output, /remote-pod/);
    assert.match(topResult.output, /cpu: 2/);
  });
});

// -----------------------------------------------------------------------
// meshctl_exec/meshctl_deploy/meshctl_drain -- reached THROUGH the
// registered tools, these really use the orchestrator SERVICE's gated wire
// dispatch (not the raw, ungated instance) -- the core design decision this
// file (mesh-orchestrator-tools.mjs) documents and this test proves.
// -----------------------------------------------------------------------

describe('registered tools: meshctl_exec/meshctl_deploy/meshctl_drain really go through the gated wire protocol', () => {
  it('meshctl_exec denies an unauthorized remote target and never runs peerNode.exec() there', async () => {
    const alice = await createTestPeer('alice');
    const bob = await createTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);

    // Deliberately NOT granting bob.registry.grantCapabilities(alice.podId, ...).
    const execCalls = [];
    mesh[bob.podId].exec = async (command) => { execCalls.push(command); return { output: 'should never run', exitCode: 0 }; };
    attachService(mesh[bob.podId], undefined, createOrchestratorService());

    const { api: aliceApi } = attachService(mesh[alice.podId], undefined, createOrchestratorService({ dispatchTimeoutMs: 500 }));
    const registry = new BrowserToolRegistry();
    registerOrchestratorTools(registry, aliceApi);

    const result = await registry.get('meshctl_exec').execute({ podId: bob.podId, command: 'echo hello' });
    assert.equal(result.success, false);
    assert.match(result.error, /access denied/);
    assert.equal(execCalls.length, 0, 'peerNode.exec() must never run for an unauthorized requester');
  });

  it('meshctl_exec succeeds against an authorized remote target, really running peerNode.exec() there', async () => {
    const alice = await createTestPeer('alice');
    const bob = await createTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);

    bob.registry.grantCapabilities(alice.podId, ['orchestrator:exec']);
    const execCalls = [];
    mesh[bob.podId].exec = async (command) => { execCalls.push(command); return { output: `ran: ${command}`, exitCode: 0 }; };
    attachService(mesh[bob.podId], undefined, createOrchestratorService());

    const { api: aliceApi } = attachService(mesh[alice.podId], undefined, createOrchestratorService());
    const registry = new BrowserToolRegistry();
    registerOrchestratorTools(registry, aliceApi);

    const result = await registry.get('meshctl_exec').execute({ podId: bob.podId, command: 'echo hello' });
    assert.equal(result.success, true);
    assert.equal(result.output, 'ran: echo hello');
    assert.deepEqual(execCalls, ['echo hello']);
  });

  it('meshctl_drain dispatches to a real remote peer and drains it there', async () => {
    const alice = await createTestPeer('alice');
    const bob = await createTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    bob.registry.grantCapabilities(alice.podId, ['orchestrator:drain']);

    const { api: bobApi } = attachService(mesh[bob.podId], undefined, createOrchestratorService());
    const { api: aliceApi } = attachService(mesh[alice.podId], undefined, createOrchestratorService());
    const registry = new BrowserToolRegistry();
    registerOrchestratorTools(registry, aliceApi);

    const result = await registry.get('meshctl_drain').execute({ podId: bob.podId });
    assert.equal(result.success, true);
    assert.match(result.output, /Migrated 0 tasks/);

    const bobPods = await bobApi.listPods();
    assert.equal(bobPods.find((p) => p.podId === bob.podId).status, 'draining');
  });

  it('meshctl_deploy dispatches to a real remote peer, which serves it via its own registered peer callback', async () => {
    const alice = await createTestPeer('alice');
    const carol = await createTestPeer('carol');
    const mesh = wireFullMesh([alice, carol]);
    carol.registry.grantCapabilities(alice.podId, ['orchestrator:deploy']);

    const deployed = [];
    const { api: carolApi } = attachService(mesh[carol.podId], undefined, createOrchestratorService());
    carolApi.orchestrator.addPeer(carol.podId, {
      deploySkill: async (content) => { deployed.push(content); return { success: true }; },
    });

    const { api: aliceApi } = attachService(mesh[alice.podId], undefined, createOrchestratorService());
    const registry = new BrowserToolRegistry();
    registerOrchestratorTools(registry, aliceApi);

    const result = await registry.get('meshctl_deploy').execute({ podId: carol.podId, skillContent: '# My Skill\nname: test' });
    assert.equal(result.success, true);
    assert.deepEqual(deployed, ['# My Skill\nname: test']);
  });

  it('a raw-orchestrator-wired meshctl_exec has no gate at all: a remote target with a registered addPeer() exec callback runs unauthorized', async () => {
    // This is the documented behavioral DIFFERENCE the module doc comment
    // warns about: when registerOrchestratorTools() is given a raw
    // MeshOrchestrator instance directly (not the service api), exec/deploy/
    // drain never go through checkAccess() at all -- proving why the service
    // api shape (exercised above) is the recommended one.
    const alice = await createTestPeer('alice');
    const raw = new MeshOrchestrator({ peerNode: { podId: alice.podId }, peerRegistry: alice.registry });
    const execCalls = [];
    raw.addPeer('some-other-pod', { exec: async (command) => { execCalls.push(command); return { output: 'ran ungated', exitCode: 0 }; } });

    const registry = new BrowserToolRegistry();
    registerOrchestratorTools(registry, raw);

    const result = await registry.get('meshctl_exec').execute({ podId: 'some-other-pod', command: 'echo hi' });
    assert.equal(result.success, true);
    assert.deepEqual(execCalls, ['echo hi'], 'ran with zero authorization check -- no wire protocol was ever involved');
  });
});

// -----------------------------------------------------------------------
// meshctl_compute/meshctl_expose -- always straight to the raw instance,
// local-only, no gate at all (no wire protocol exists for either at the
// service layer, regardless of which orchestrator shape is supplied).
// -----------------------------------------------------------------------

describe('registered tools: meshctl_compute/meshctl_expose (no gated equivalent exists)', () => {
  it('meshctl_compute runs locally when this node itself is compute-capable', async () => {
    const alice = await createTestPeer('alice');
    const mesh = wireFullMesh([alice]);
    mesh[alice.podId].exec = async (command) => ({ output: `computed: ${command}`, exitCode: 0 });
    const { api } = attachService(mesh[alice.podId], undefined, createOrchestratorService());

    const registry = new BrowserToolRegistry();
    registerOrchestratorTools(registry, api);

    const result = await registry.get('meshctl_compute').execute({ podId: alice.podId, command: 'crunch' });
    assert.equal(result.success, true);
    assert.match(result.output, /computed: crunch/);
  });

  it('meshctl_expose records a real exposed service locally', async () => {
    const alice = await createTestPeer('alice');
    const mesh = wireFullMesh([alice]);
    const { api } = attachService(mesh[alice.podId], undefined, createOrchestratorService());

    const registry = new BrowserToolRegistry();
    registerOrchestratorTools(registry, api);

    const result = await registry.get('meshctl_expose').execute({ podId: alice.podId, port: 8080, name: 'my-service' });
    assert.equal(result.success, true);
    assert.match(result.output, /my-service/);
    assert.match(result.output, new RegExp(`${alice.podId}:8080`));
  });
});

// -----------------------------------------------------------------------
// createMeshNode({ enableAgentRuntime, enableOrchestrator }) opt-in wiring
// -----------------------------------------------------------------------

describe('createMeshNode({ enableAgentRuntime })', () => {
  it('leaves node.toolRegistry unset when enableAgentRuntime is omitted', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      skipBoot: true,
    });
    assert.equal(node.toolRegistry, undefined);
  });

  it('attaches an EMPTY node.toolRegistry when enableAgentRuntime is set without enableOrchestrator', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableAgentRuntime: true,
      skipBoot: true,
    });
    assert.ok(node.toolRegistry instanceof BrowserToolRegistry);
    assert.equal(node.toolRegistry.listSpecs().length, 0);

    // Ready for the caller to register its own, non-orchestrator tools.
    const { BrowserTool } = await import('../src/compat.mjs');
    class PingTool extends BrowserTool {
      get name() { return 'ping'; }
      get description() { return 'pong'; }
      async execute() { return { success: true, output: 'pong' }; }
    }
    node.toolRegistry.register(new PingTool());
    assert.equal(node.toolRegistry.listSpecs().length, 1);
  });

  it('pre-populates node.toolRegistry with all 8 Meshctl*Tools when BOTH enableAgentRuntime AND enableOrchestrator are set', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableAgentRuntime: true,
      enableOrchestrator: true,
      skipBoot: true,
    });
    assert.ok(node.toolRegistry instanceof BrowserToolRegistry);
    assert.equal(node.toolRegistry.listSpecs().length, 8);
    assert.ok(node.toolRegistry.get('meshctl_pods'));
    assert.ok(node.toolRegistry.get('meshctl_exec'));

    const result = await node.toolRegistry.get('meshctl_pods').execute({});
    assert.equal(result.success, true);
    assert.match(result.output, new RegExp(node.services.get('orchestrator').api.orchestrator.localPodId));
  });

  it('leaves node.toolRegistry unset when enableOrchestrator is set without enableAgentRuntime', async () => {
    const node = await createMeshNode({
      label: 'alice',
      signalingTransport: createStubSignalingTransport(),
      enableOrchestrator: true,
      skipBoot: true,
    });
    assert.equal(node.toolRegistry, undefined);
    assert.ok(node.orchestrator, 'node.orchestrator is still attached on its own');
  });
});

// -----------------------------------------------------------------------
// CAPSTONE -- the full plan (issues #90 AND #92), end to end: a real
// createAgentRuntime({registry, llmFn}) (Phase 2) with a deterministic test
// llmFn requesting a meshctl_pods tool call, the loop dispatching it through
// a real registry to a real MeshOrchestrator on a real multi-peer mesh, and
// the result flowing back into the conversation for the LLM's final answer.
// -----------------------------------------------------------------------

describe('CAPSTONE: createAgentRuntime + registerOrchestratorTools + a real multi-peer mesh', () => {
  it('an LLM-requested meshctl_pods tool call really dispatches through the registry to the real orchestrator and the result flows back into the conversation', async () => {
    const alice = await createTestPeer('alice');
    const bob = await createTestPeer('bob');
    const carol = await createTestPeer('carol');
    const mesh = wireFullMesh([alice, bob, carol]);

    const { api: aliceApi } = attachService(mesh[alice.podId], undefined, createOrchestratorService());
    attachService(mesh[bob.podId], undefined, createOrchestratorService());
    attachService(mesh[carol.podId], undefined, createOrchestratorService());

    // Real mesh state: alice's orchestrator knows about bob and carol.
    aliceApi.orchestrator.addPeer(bob.podId, { label: 'bob', status: 'online', services: ['web'] });
    aliceApi.orchestrator.addPeer(carol.podId, { label: 'carol', status: 'offline' });

    const registry = new BrowserToolRegistry();
    registerOrchestratorTools(registry, aliceApi);

    // A deterministic, test-double llmFn (per the plan's own "bring-your-own
    // LLM callback" design, agent-runtime.mjs's own doc comment) -- turn 1
    // requests the meshctl_pods tool; turn 2 answers using the REAL tool
    // result it was handed back.
    const llmCalls = [];
    const llmFn = async (messages, toolSpecs) => {
      llmCalls.push({ messages: [...messages], toolSpecs });
      if (llmCalls.length === 1) {
        assert.ok(toolSpecs.some((s) => s.name === 'meshctl_pods'), 'meshctl_pods is offered to the LLM as a real tool spec');
        return { toolCalls: [{ id: 'call_1', name: 'meshctl_pods', arguments: {} }] };
      }
      // Second turn: the tool-result message from the real dispatch is
      // already in `messages` -- read it back out and surface it.
      const toolResultMsg = messages.find((m) => m.role === 'tool' && m.name === 'meshctl_pods');
      assert.ok(toolResultMsg, 'a real tool-result message was appended for the dispatched call');
      const parsed = JSON.parse(toolResultMsg.content);
      assert.equal(parsed.success, true);
      assert.match(parsed.output, new RegExp(bob.podId));
      assert.match(parsed.output, new RegExp(carol.podId));
      return { content: `Found 3 pods, including ${bob.podId} and ${carol.podId}.` };
    };

    const runtime = createAgentRuntime({ registry, llmFn });
    const result = await runtime.run('List all known pods.');

    assert.equal(llmCalls.length, 2);
    assert.equal(result.content, `Found 3 pods, including ${bob.podId} and ${carol.podId}.`);
    assert.equal(result.toolCalls, undefined);
    assert.equal(result.truncated, undefined);

    // The running conversation really contains the full round trip.
    const messages = runtime.getMessages();
    assert.equal(messages[0].role, 'user');
    assert.equal(messages[1].role, 'assistant');
    assert.deepEqual(messages[1].toolCalls, [{ id: 'call_1', name: 'meshctl_pods', arguments: {} }]);
    assert.equal(messages[2].role, 'tool');
    assert.equal(messages[2].tool_call_id, 'call_1');
    assert.equal(messages[2].name, 'meshctl_pods');
    const toolResult = JSON.parse(messages[2].content);
    assert.equal(toolResult.success, true);
    assert.match(toolResult.output, /POD \| STATUS \| CONNECTIONS \| SERVICES/);
  });

  it('unblocking issue #92\'s risky actions too: an authorized meshctl_exec LLM tool call really runs on a real remote peer', async () => {
    const alice = await createTestPeer('alice');
    const bob = await createTestPeer('bob');
    const mesh = wireFullMesh([alice, bob]);
    bob.registry.grantCapabilities(alice.podId, ['orchestrator:exec']);
    mesh[bob.podId].exec = async (command) => ({ output: `remote ran: ${command}`, exitCode: 0 });

    attachService(mesh[bob.podId], undefined, createOrchestratorService());
    const { api: aliceApi } = attachService(mesh[alice.podId], undefined, createOrchestratorService());

    const registry = new BrowserToolRegistry();
    registerOrchestratorTools(registry, aliceApi);

    const llmCalls = [];
    const llmFn = async (messages) => {
      llmCalls.push(1);
      if (llmCalls.length === 1) {
        return { toolCalls: [{ id: 'call_1', name: 'meshctl_exec', arguments: { podId: bob.podId, command: 'uptime' } }] };
      }
      const toolResultMsg = messages.find((m) => m.role === 'tool');
      const parsed = JSON.parse(toolResultMsg.content);
      return { content: parsed.success ? `uptime says: ${parsed.output}` : `failed: ${parsed.error}` };
    };

    const runtime = createAgentRuntime({ registry, llmFn });
    const result = await runtime.run('Check uptime on bob.');
    assert.equal(result.content, 'uptime says: remote ran: uptime');
  });
});
