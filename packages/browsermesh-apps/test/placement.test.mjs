// Run with: node --import ./test/_setup-globals.mjs --test test/placement.test.mjs
//
// Covers WP4 of issue #185 ("Hosted pods"): the `ComputeRequest.constraints
// .isolation` / `moduleType: 'shell'` placement lanes, `RUNTIME_CLASS` /
// `ISOLATION` constants, `ResourceDescriptor.hostedBy`, the `execOnPod()`
// isolate guard, and `MeshOrchestrator.recordPlacement()`.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  RUNTIME_CLASS,
  ISOLATION,
  ComputeRequest,
  ResourceDescriptor,
  ResourceScorer,
} from '../src/resources.mjs'

import {
  MeshOrchestrator,
  PLACEMENT_AUDIT,
} from '../src/orchestrator.mjs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePeerNode(overrides = {}) {
  return {
    podId: 'local-pod',
    id: 'local-pod',
    label: 'Local Pod',
    capabilities: ['wasm'],
    resources: { cpu: 8, memory: 16384, storage: 102400 },
    ...overrides,
  }
}

function makeOrchestrator(overrides = {}) {
  return new MeshOrchestrator({
    peerNode: makePeerNode(),
    ...overrides,
  })
}

function makeRuntimeRegistry(peers = []) {
  const byId = new Map()
  for (const peer of peers) {
    const podId = peer.identity?.podId || peer.identity?.fingerprint || peer.identity?.canonicalId
    byId.set(podId, peer)
  }
  return {
    listPeers() {
      return peers
    },
    resolvePeer(selector) {
      return byId.get(selector) || null
    },
  }
}

function makeRequest(overrides = {}) {
  return new ComputeRequest({
    moduleType: 'wasm',
    moduleCid: 'cid',
    entry: 'main',
    requesterId: 'me',
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// RUNTIME_CLASS / ISOLATION constants
// ---------------------------------------------------------------------------

describe('RUNTIME_CLASS', () => {
  it('exposes the four canonical runtime classes', () => {
    assert.deepEqual(RUNTIME_CLASS, {
      BROWSER: 'browser',
      NODE: 'node',
      ISOLATE: 'isolate',
      MICROVM: 'microvm',
    })
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(RUNTIME_CLASS))
    assert.throws(() => { RUNTIME_CLASS.BROWSER = 'nope' })
    assert.equal(RUNTIME_CLASS.BROWSER, 'browser')
  })
})

describe('ISOLATION', () => {
  it('exposes any/isolate/microvm', () => {
    assert.deepEqual(ISOLATION, { ANY: 'any', ISOLATE: 'isolate', MICROVM: 'microvm' })
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(ISOLATION))
  })
})

// ---------------------------------------------------------------------------
// ComputeRequest — moduleType 'shell' and constraints.isolation
// ---------------------------------------------------------------------------

describe('ComputeRequest placement fields', () => {
  it('accepts moduleType "shell"', () => {
    const r = makeRequest({ moduleType: 'shell' })
    assert.equal(r.moduleType, 'shell')
  })

  it('still accepts "wasm" and "js"', () => {
    assert.equal(makeRequest({ moduleType: 'wasm' }).moduleType, 'wasm')
    assert.equal(makeRequest({ moduleType: 'js' }).moduleType, 'js')
  })

  it('throws on an unrecognized moduleType', () => {
    assert.throws(() => makeRequest({ moduleType: 'binary' }), /moduleType/)
  })

  it('defaults constraints.isolation to "any"', () => {
    const r = makeRequest()
    assert.equal(r.constraints.isolation, 'any')
  })

  it('accepts constraints.isolation "isolate" and "microvm"', () => {
    assert.equal(makeRequest({ constraints: { isolation: 'isolate' } }).constraints.isolation, 'isolate')
    assert.equal(makeRequest({ constraints: { isolation: 'microvm' } }).constraints.isolation, 'microvm')
  })

  it('throws on an unrecognized constraints.isolation', () => {
    assert.throws(
      () => makeRequest({ constraints: { isolation: 'container' } }),
      /isolation/,
    )
  })

  it('round-trips moduleType "shell" and constraints.isolation via JSON', () => {
    const r = makeRequest({ moduleType: 'shell', constraints: { isolation: 'microvm' } })
    const r2 = ComputeRequest.fromJSON(r.toJSON())
    assert.equal(r2.moduleType, 'shell')
    assert.equal(r2.constraints.isolation, 'microvm')
    assert.deepEqual(r2.toJSON(), r.toJSON())
  })
})

// ---------------------------------------------------------------------------
// ResourceDescriptor — hostedBy
// ---------------------------------------------------------------------------

describe('ResourceDescriptor hostedBy', () => {
  it('defaults to null', () => {
    const d = new ResourceDescriptor({ podId: 'p' })
    assert.equal(d.hostedBy, null)
  })

  it('is exposed when provided', () => {
    const d = new ResourceDescriptor({ podId: 'child-pod', hostedBy: 'host-pod' })
    assert.equal(d.hostedBy, 'host-pod')
  })

  it('toJSON omits hostedBy when absent', () => {
    const d = new ResourceDescriptor({ podId: 'p' })
    assert.ok(!('hostedBy' in d.toJSON()))
  })

  it('toJSON includes hostedBy when present', () => {
    const d = new ResourceDescriptor({ podId: 'p', hostedBy: 'host-pod' })
    assert.equal(d.toJSON().hostedBy, 'host-pod')
  })

  it('round-trips hostedBy via JSON', () => {
    const d = new ResourceDescriptor({ podId: 'p', hostedBy: 'host-pod' })
    const d2 = ResourceDescriptor.fromJSON(d.toJSON())
    assert.equal(d2.hostedBy, 'host-pod')
  })

  it('does not break round-trip for descriptors without hostedBy', () => {
    const d = new ResourceDescriptor({ podId: 'p', resources: { cpu: 2 } })
    const d2 = ResourceDescriptor.fromJSON(d.toJSON())
    assert.deepEqual(d2.toJSON(), d.toJSON())
  })
})

// ---------------------------------------------------------------------------
// ResourceDescriptor hostedBy merge (via MeshOrchestrator's compute
// candidate collection, the only place mergeResourceDescriptors runs)
// ---------------------------------------------------------------------------

describe('hostedBy in compute candidate merge', () => {
  it('surfaces hostedBy from a runtime-registry peer onto the merged descriptor', async () => {
    const orch = makeOrchestrator({
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'child-pod', fingerprint: 'child-pod', aliases: [] },
          username: 'child-pod',
          capabilities: ['exec'],
          reachability: [{ kind: 'reverse-relay', health: 'online' }],
          metadata: {
            resources: { cpu: 2, memory: 2048, storage: 4096 },
            hostedBy: 'host-pod',
          },
        },
      ]),
    })

    const candidates = await orch.listComputeCandidates()
    const child = candidates.find((c) => c.podId === 'child-pod')
    assert.ok(child)
    // listComputeCandidates() currently projects podId/resources/
    // capabilities/availability/source -- confirm hostedBy survives the
    // underlying descriptor by re-deriving it via selectComputeTarget.
    const selection = orch.selectComputeTarget({ selector: 'child-pod' })
    assert.equal(selection.descriptor.hostedBy, 'host-pod')
  })
})

// ---------------------------------------------------------------------------
// ResourceScorer — isolation lane branches
// ---------------------------------------------------------------------------

describe('ResourceScorer isolation lane', () => {
  // -- (a) hard isolation requirement --------------------------------------

  it('isolation "isolate" scores zero without runtime:isolate', () => {
    const req = makeRequest({ moduleType: 'js', constraints: { isolation: 'isolate' } })
    const desc = new ResourceDescriptor({ podId: 'p', capabilities: ['runtime:node'] })
    assert.equal(ResourceScorer.score(req, desc), 0)
  })

  it('isolation "isolate" scores positively with runtime:isolate', () => {
    const req = makeRequest({ moduleType: 'js', constraints: { isolation: 'isolate' } })
    const desc = new ResourceDescriptor({ podId: 'p', capabilities: ['runtime:isolate'] })
    assert.ok(ResourceScorer.score(req, desc) > 0)
  })

  it('isolation "microvm" scores zero without runtime:microvm', () => {
    const req = makeRequest({ moduleType: 'js', constraints: { isolation: 'microvm' } })
    const desc = new ResourceDescriptor({ podId: 'p', capabilities: ['runtime:isolate'] })
    assert.equal(ResourceScorer.score(req, desc), 0)
  })

  it('isolation "microvm" scores positively with runtime:microvm', () => {
    const req = makeRequest({ moduleType: 'js', constraints: { isolation: 'microvm' } })
    const desc = new ResourceDescriptor({ podId: 'p', capabilities: ['runtime:microvm'] })
    assert.ok(ResourceScorer.score(req, desc) > 0)
  })

  // -- (b) moduleType 'shell' requires microvm regardless of isolation ----

  it('moduleType "shell" scores zero without runtime:microvm', () => {
    const req = makeRequest({ moduleType: 'shell' })
    const desc = new ResourceDescriptor({ podId: 'p', capabilities: ['runtime:isolate', 'runtime:node'] })
    assert.equal(ResourceScorer.score(req, desc), 0)
  })

  it('moduleType "shell" scores positively with runtime:microvm', () => {
    const req = makeRequest({ moduleType: 'shell' })
    const desc = new ResourceDescriptor({ podId: 'p', capabilities: ['runtime:microvm'] })
    assert.ok(ResourceScorer.score(req, desc) > 0)
  })

  it('moduleType "shell" with isolation "isolate" still requires microvm (always zero)', () => {
    const req = makeRequest({ moduleType: 'shell', constraints: { isolation: 'isolate' } })
    const desc = new ResourceDescriptor({ podId: 'p', capabilities: ['runtime:microvm'] })
    // Shell needs microvm (satisfied) AND isolation:'isolate' needs runtime:isolate (not satisfied)
    assert.equal(ResourceScorer.score(req, desc), 0)
  })

  // -- (c) isolation 'any' preferences --------------------------------------

  it('isolation "any" + js/wasm prefers runtime:isolate by +25', () => {
    const req = makeRequest({ moduleType: 'js' })
    assert.equal(req.constraints.isolation, 'any')
    const withIsolate = new ResourceDescriptor({ podId: 'a', capabilities: ['runtime:isolate'] })
    const withoutIsolate = new ResourceDescriptor({ podId: 'b', capabilities: [] })
    assert.equal(ResourceScorer.score(req, withIsolate) - ResourceScorer.score(req, withoutIsolate), 25)
  })

  it('isolation "any" + wasm prefers runtime:isolate by +25 too', () => {
    const req = makeRequest({ moduleType: 'wasm' })
    const withIsolate = new ResourceDescriptor({ podId: 'a', capabilities: ['runtime:isolate'] })
    const withoutIsolate = new ResourceDescriptor({ podId: 'b', capabilities: [] })
    assert.equal(ResourceScorer.score(req, withIsolate) - ResourceScorer.score(req, withoutIsolate), 25)
  })

  it('isolation "any" + shell scores positively once the hard microvm gate is met (includes the +25 lane bonus)', () => {
    // Shell's hard gate (runtime:microvm required) and its 'any'-lane +25
    // bonus share the same condition, so a shell descriptor that clears the
    // gate always gets the bonus too -- there is no "gate met, no bonus"
    // case to isolate here. Compare against the same descriptor scored for
    // a js request (no shell hard-gate, no shell-lane bonus) to show the
    // shell path's score is still internally consistent (base + bonus).
    const reqShell = makeRequest({ moduleType: 'shell' })
    const reqJs = makeRequest({ moduleType: 'js' })
    const desc = new ResourceDescriptor({ podId: 'a', capabilities: ['runtime:microvm'] })
    assert.ok(ResourceScorer.score(reqShell, desc) > 0)
    // js gets its own (different) +25 isolate-lane bonus only if it also
    // advertises runtime:isolate -- this descriptor does not, so the two
    // base scores (minus each one's own bonus) land on the same baseline.
    assert.equal(ResourceScorer.score(reqShell, desc) - 25, ResourceScorer.score(reqJs, desc))
  })

  it('isolation "any" + shell does not get the +25 js/wasm isolate bonus', () => {
    const reqShell = makeRequest({ moduleType: 'shell' })
    const descBoth = new ResourceDescriptor({ podId: 'p', capabilities: ['runtime:microvm', 'runtime:isolate'] })
    const descMicrovmOnly = new ResourceDescriptor({ podId: 'q', capabilities: ['runtime:microvm'] })
    // Having runtime:isolate too should not add another +25 on top of the
    // shell-lane's own +25 (only one lane bonus applies per request).
    assert.equal(ResourceScorer.score(reqShell, descBoth), ResourceScorer.score(reqShell, descMicrovmOnly))
  })

  it('isolation "any" + js without runtime:isolate gets no lane bonus but still scores', () => {
    const req = makeRequest({ moduleType: 'js' })
    const desc = new ResourceDescriptor({ podId: 'p', capabilities: [] })
    assert.ok(ResourceScorer.score(req, desc) > 0)
  })

  // -- interaction with preferRuntimeClass ----------------------------------

  it('isolation hard requirement is independent of preferRuntimeClass bonus/penalty', () => {
    const req = makeRequest({
      moduleType: 'js',
      constraints: { isolation: 'isolate', preferRuntimeClass: 'node' },
    })
    // Has runtime:isolate (isolation satisfied) but not runtime:node
    // (preferRuntimeClass mismatch -> -15), so it still scores > 0 overall
    // but is never hard-zeroed by the mismatched preference alone.
    const desc = new ResourceDescriptor({ podId: 'p', capabilities: ['runtime:isolate'] })
    const score = ResourceScorer.score(req, desc)
    assert.ok(score > 0)
  })

  it('preferRuntimeClass cannot rescue a request that fails the hard isolation gate', () => {
    const req = makeRequest({
      moduleType: 'js',
      constraints: { isolation: 'microvm', preferRuntimeClass: 'node' },
    })
    // preferRuntimeClass is satisfied (runtime:node present) but the hard
    // isolation:'microvm' gate is not (no runtime:microvm) -- the request
    // must still score zero.
    const desc = new ResourceDescriptor({ podId: 'p', capabilities: ['runtime:node'] })
    assert.equal(ResourceScorer.score(req, desc), 0)
  })

  it('preferRuntimeClass and isolation can both be satisfied by the same descriptor', () => {
    const req = makeRequest({
      moduleType: 'js',
      constraints: { isolation: 'isolate', preferRuntimeClass: 'isolate' },
    })
    const desc = new ResourceDescriptor({ podId: 'p', capabilities: ['runtime:isolate'] })
    const other = makeRequest({ moduleType: 'js' })
    const baseline = new ResourceDescriptor({ podId: 'q', capabilities: [] })
    // +60 preferRuntimeClass match, no additional +25 'any' bonus since
    // isolation is a hard requirement here, not 'any'.
    assert.ok(ResourceScorer.score(req, desc) > ResourceScorer.score(other, baseline))
  })

  // -- existing scoring intact ----------------------------------------------

  it('existing preferRuntimeClass +60/-15 behavior is unchanged', () => {
    const req = makeRequest({ constraints: { preferRuntimeClass: 'gpu-node' } })
    const match = new ResourceDescriptor({ podId: 'a', capabilities: ['runtime:gpu-node'] })
    const mismatch = new ResourceDescriptor({ podId: 'b', capabilities: [] })
    assert.equal(ResourceScorer.score(req, match) - ResourceScorer.score(req, mismatch), 75)
  })

  it('existing memory headroom / cpu / bandwidth scoring is unchanged', () => {
    const req = makeRequest({ constraints: { maxMemoryMb: 1024 } })
    const big = new ResourceDescriptor({ podId: 'a', resources: { memory: 8192, cpu: 4, bandwidth: 100 } })
    const small = new ResourceDescriptor({ podId: 'b', resources: { memory: 1024 } })
    assert.ok(ResourceScorer.score(req, big) > ResourceScorer.score(req, small))
  })

  it('offline descriptors still score zero regardless of isolation', () => {
    const req = makeRequest({ constraints: { isolation: 'isolate' } })
    const desc = new ResourceDescriptor({ podId: 'p', availability: 'offline', capabilities: ['runtime:isolate'] })
    assert.equal(ResourceScorer.score(req, desc), 0)
  })
})

// ---------------------------------------------------------------------------
// ResourceScorer.lane()
// ---------------------------------------------------------------------------

describe('ResourceScorer.lane', () => {
  it('shell always requires microvm', () => {
    assert.deepEqual(ResourceScorer.lane(makeRequest({ moduleType: 'shell' })), {
      required: 'microvm',
      preferred: null,
    })
    assert.deepEqual(
      ResourceScorer.lane(makeRequest({ moduleType: 'shell', constraints: { isolation: 'isolate' } })),
      { required: 'microvm', preferred: null },
    )
  })

  it('explicit isolation "isolate"/"microvm" is required', () => {
    assert.deepEqual(ResourceScorer.lane(makeRequest({ moduleType: 'js', constraints: { isolation: 'isolate' } })), {
      required: 'isolate',
      preferred: null,
    })
    assert.deepEqual(ResourceScorer.lane(makeRequest({ moduleType: 'wasm', constraints: { isolation: 'microvm' } })), {
      required: 'microvm',
      preferred: null,
    })
  })

  it('isolation "any" + js/wasm prefers isolate', () => {
    assert.deepEqual(ResourceScorer.lane(makeRequest({ moduleType: 'js' })), {
      required: null,
      preferred: 'isolate',
    })
    assert.deepEqual(ResourceScorer.lane(makeRequest({ moduleType: 'wasm' })), {
      required: null,
      preferred: 'isolate',
    })
  })

  it('isolation "any" with no particular moduleType preference returns nulls', () => {
    // moduleType is required by JSDoc but the helper should not throw for
    // an unexpected value here -- it only special-cases js/wasm/shell.
    const req = makeRequest({ moduleType: 'wasm', constraints: {} })
    req.moduleType = undefined
    assert.deepEqual(ResourceScorer.lane(req), { required: null, preferred: null })
  })
})

// ---------------------------------------------------------------------------
// MeshOrchestrator.execOnPod — isolate guard
// ---------------------------------------------------------------------------

describe('execOnPod isolate guard', () => {
  it('denies exec against an isolate-only runtime-registry peer', async () => {
    const records = []
    const orch = makeOrchestrator({
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'iso-peer', fingerprint: 'iso-peer', aliases: [] },
          username: 'iso-peer',
          capabilities: ['exec'],
          reachability: [{ kind: 'reverse-relay' }],
          metadata: { runtimeClasses: ['isolate'] },
        },
      ]),
      remoteSessionBroker: {
        async openSession() {
          throw new Error('should not reach the broker')
        },
      },
      auditRecorder: {
        async record(operation, data) {
          records.push({ operation, data })
        },
      },
    })

    const result = await orch.execOnPod('iso-peer', 'echo hello')

    assert.equal(result.exitCode, 126)
    assert.match(result.output, /isolate.*cannot execute shell commands/)
    assert.equal(records.length, 1)
    assert.equal(records[0].operation, 'remote_exec_denied')
    assert.equal(records[0].data.podId, 'iso-peer')
    assert.equal(records[0].data.reason, 'isolate runtime cannot execute shell commands')
    assert.equal(records[0].data.layer, 'runtime')
  })

  it('does not deny exec for a peer advertising both isolate and microvm classes', async () => {
    const orch = makeOrchestrator({
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'both-peer', fingerprint: 'both-peer', aliases: [] },
          username: 'both-peer',
          capabilities: ['exec'],
          reachability: [{ kind: 'reverse-relay' }],
          metadata: { runtimeClasses: ['isolate', 'microvm'] },
        },
      ]),
      remoteSessionBroker: {
        async openSession(selector, opts) {
          return { output: `ran: ${opts.command}`, exitCode: 0 }
        },
      },
    })

    const result = await orch.execOnPod('both-peer', 'echo hello')
    assert.equal(result.exitCode, 0)
    assert.equal(result.output, 'ran: echo hello')
  })

  it('does not deny exec for a peer with an explicit shellBackend even if isolate-classed', async () => {
    const orch = makeOrchestrator({
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'shelled-peer', fingerprint: 'shelled-peer', aliases: [] },
          username: 'shelled-peer',
          shellBackend: 'vm-console',
          capabilities: ['exec'],
          reachability: [{ kind: 'reverse-relay' }],
          metadata: { runtimeClasses: ['isolate'] },
        },
      ]),
      remoteSessionBroker: {
        async openSession(selector, opts) {
          return { output: `ran: ${opts.command}`, exitCode: 0 }
        },
      },
    })

    const result = await orch.execOnPod('shelled-peer', 'echo hello')
    assert.equal(result.exitCode, 0)
  })

  it('leaves non-isolate runtime-registry peers unaffected (regression)', async () => {
    const orch = makeOrchestrator({
      runtimeRegistry: makeRuntimeRegistry([
        {
          identity: { canonicalId: 'relay-peer', fingerprint: 'relay-peer', aliases: [] },
          username: 'relay-peer',
          capabilities: ['exec'],
          reachability: [{ kind: 'reverse-relay' }],
          metadata: { status: 'online' },
        },
      ]),
      remoteSessionBroker: {
        async openSession(selector, opts) {
          return { output: 'relay exec', exitCode: 0 }
        },
      },
    })

    const result = await orch.execOnPod('relay-peer', 'printf hello')
    assert.equal(result.output, 'relay exec')
    assert.equal(result.exitCode, 0)
  })

  it('leaves exec against #knownPeers (no runtime registry) unaffected (regression)', async () => {
    const orch = makeOrchestrator()
    orch.addPeer('remote-1', {
      exec: async (cmd) => ({ output: `ran: ${cmd}`, exitCode: 0 }),
    })
    const result = await orch.execOnPod('remote-1', 'echo hello')
    assert.equal(result.output, 'ran: echo hello')
    assert.equal(result.exitCode, 0)
  })
})

// ---------------------------------------------------------------------------
// PLACEMENT_AUDIT / MeshOrchestrator.recordPlacement
// ---------------------------------------------------------------------------

describe('PLACEMENT_AUDIT', () => {
  it('exposes the five placement record names', () => {
    assert.deepEqual(PLACEMENT_AUDIT, {
      REQUESTED: 'placement_requested',
      DENIED: 'placement_denied',
      STARTED: 'placement_started',
      READY: 'placement_ready',
      EVICTED: 'placement_evicted',
    })
  })

  it('is frozen', () => {
    assert.ok(Object.isFrozen(PLACEMENT_AUDIT))
  })
})

describe('MeshOrchestrator.recordPlacement', () => {
  it('writes through to the audit recorder', async () => {
    const records = []
    const orch = makeOrchestrator({
      auditRecorder: {
        async record(operation, data) {
          records.push({ operation, data })
        },
      },
    })

    await orch.recordPlacement(PLACEMENT_AUDIT.REQUESTED, { podId: 'host-pod', lane: 'microvm' })
    await orch.recordPlacement(PLACEMENT_AUDIT.READY, { podId: 'host-pod', hostedPodId: 'child-pod' })

    assert.equal(records.length, 2)
    assert.equal(records[0].operation, 'placement_requested')
    assert.deepEqual(records[0].data, { podId: 'host-pod', lane: 'microvm' })
    assert.equal(records[1].operation, 'placement_ready')
    assert.deepEqual(records[1].data, { podId: 'host-pod', hostedPodId: 'child-pod' })
  })

  it('is a safe no-op without an audit recorder wired', async () => {
    const orch = makeOrchestrator()
    await assert.doesNotReject(() => orch.recordPlacement(PLACEMENT_AUDIT.DENIED, { podId: 'x' }))
  })

  it('defaults details to an empty object', async () => {
    const records = []
    const orch = makeOrchestrator({
      auditRecorder: {
        async record(operation, data) {
          records.push({ operation, data })
        },
      },
    })
    await orch.recordPlacement(PLACEMENT_AUDIT.EVICTED)
    assert.deepEqual(records[0].data, {})
  })
})
