// Run with: node --import ./test/_setup-globals.mjs --test test/spawn-host-placement.test.mjs
//
// Issue #221, "isolate hosts are invisible to the compute scorer": a pod
// host that can spawn pods but has no shell (the isolate and browser lanes)
// must be visible to placement scoring, WITHOUT becoming a target for
// anything that needs a shell. The rule under test: spawn-only hosts appear
// in `listComputeCandidates(..., {includeSpawnHosts: true})` and
// `selectComputeTarget({includeSpawnHosts: true})`, and in nothing else.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { MeshOrchestrator, pickAutoHost } from '../src/orchestrator.mjs'
import { podHostRuntimePeer } from '../src/pod-host-service.mjs'

function describeHost({ podId, lane, verbs, shellBackend = null }) {
  return {
    podId,
    lane,
    verbs,
    runtimeClasses: [lane],
    shellBackend,
    deploymentSupport: { canDeploy: verbs.includes('spawn') },
    capabilities: ['pod-host', ...(verbs.includes('exec') ? ['exec'] : [])],
    resource: 'pod-host',
    hostLabel: null,
  }
}

const ISOLATE_HOST = describeHost({
  podId: 'isolate-host',
  lane: 'isolate',
  verbs: ['spawn', 'status', 'send', 'drain', 'list'],
})
const MICROVM_HOST = describeHost({
  podId: 'vm-host',
  lane: 'microvm',
  verbs: ['spawn', 'status', 'exec', 'snapshot', 'restore', 'drain', 'list'],
  shellBackend: 'vm-console',
})

function makeOrchestrator(hosts) {
  const peers = hosts.map((h) => podHostRuntimePeer(h, { resources: { cpu: 4, memory: 4096 } }))
  return new MeshOrchestrator({
    // The local pod has no exec, so it is not a compute candidate itself.
    peerNode: { podId: 'local-pod', id: 'local-pod', label: 'Local', capabilities: [], resources: {} },
    runtimeRegistry: {
      listPeers: () => peers,
      resolvePeer: (id) => peers.find((p) => p.identity.podId === id) || null,
    },
  })
}

describe('spawn-only pod hosts and placement scoring', () => {
  it('an isolate host is NOT a compute candidate by default (it has no shell)', async () => {
    const orch = makeOrchestrator([ISOLATE_HOST, MICROVM_HOST])
    const ids = (await orch.listComputeCandidates({})).map((c) => c.podId)
    assert.deepEqual(ids, ['vm-host'])
  })

  it('an isolate host is a candidate when spawn hosts are requested', async () => {
    const orch = makeOrchestrator([ISOLATE_HOST, MICROVM_HOST])
    const candidates = await orch.listComputeCandidates({ isolation: 'isolate' }, { includeSpawnHosts: true })
    const isolate = candidates.find((c) => c.podId === 'isolate-host')
    assert.ok(isolate, 'isolate host is visible')
    assert.ok(isolate.capabilities.includes('runtime:isolate'))
    assert.ok(!isolate.capabilities.includes('compute'), 'it must not claim a shell')
    assert.ok(isolate.capabilities.includes('spawn'))
  })

  it('selectComputeTarget picks the isolate host for an isolate request when spawn hosts are included', () => {
    const orch = makeOrchestrator([ISOLATE_HOST, MICROVM_HOST])
    const selection = orch.selectComputeTarget({
      constraints: { isolation: 'isolate' },
      includeSpawnHosts: true,
    })
    assert.equal(selection.podId, 'isolate-host')
  })

  it('a shell command is never routed to a spawn-only host, even when spawn hosts are included', () => {
    const orch = makeOrchestrator([ISOLATE_HOST])
    assert.throws(
      () => orch.selectComputeTarget({ includeSpawnHosts: true, request: undefined, constraints: { isolation: 'microvm' } }),
      /No compute-capable runtime/,
    )
  })

  it('without includeSpawnHosts the isolate host is never selected (existing exec paths unchanged)', () => {
    const orch = makeOrchestrator([ISOLATE_HOST, MICROVM_HOST])
    const selection = orch.selectComputeTarget({ constraints: {} })
    assert.equal(selection.podId, 'vm-host')
  })

  it('a host that cannot spawn is not a spawn host', async () => {
    const noSpawn = describeHost({ podId: 'ro-host', lane: 'isolate', verbs: ['status', 'list'] })
    const orch = makeOrchestrator([noSpawn])
    const candidates = await orch.listComputeCandidates({}, { includeSpawnHosts: true })
    assert.deepEqual(candidates, [])
  })

  it('pickAutoHost finds the isolate host through candidate scoring, not the listing fallback', async () => {
    const orch = makeOrchestrator([ISOLATE_HOST, MICROVM_HOST])
    const picked = await pickAutoHost(orch, 'isolate')
    assert.equal(picked.podId, 'isolate-host')
    assert.match(picked.reason, /best compute candidate/)
  })

  it('pickAutoHost still returns the microvm host for the microvm lane', async () => {
    const orch = makeOrchestrator([ISOLATE_HOST, MICROVM_HOST])
    const picked = await pickAutoHost(orch, 'microvm')
    assert.equal(picked.podId, 'vm-host')
  })

  it('a spawn host whose route is offline is listed as offline', async () => {
    const peer = podHostRuntimePeer(ISOLATE_HOST)
    peer.reachability = [{ health: 'offline' }]
    const orch = new MeshOrchestrator({
      peerNode: { podId: 'local-pod', capabilities: [], resources: {} },
      runtimeRegistry: { listPeers: () => [peer], resolvePeer: () => peer },
    })
    const candidates = await orch.listComputeCandidates({}, { includeSpawnHosts: true })
    assert.equal(candidates.find((c) => c.podId === 'isolate-host').availability, 'offline')
  })
})
