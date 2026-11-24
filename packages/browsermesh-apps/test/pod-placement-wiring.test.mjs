/**
 * The placement planner wired into the orchestrator (`placePod()`,
 * `meshctl_spawn` with `constraints`) and the pure decision it shares with
 * the meshctl CLI (`decidePlacement()`).
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/pod-placement-wiring.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'
import { InMemoryPodHostDriver, POD_LANE, POD_HOST_ERROR } from '@johnhenry/browsermesh-pod'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createPodHostService, createPodHostClient, DEFAULT_POD_HOST_RESOURCE } from '../src/pod-host-service.mjs'
import { MeshOrchestrator, PLACEMENT_AUDIT, MeshctlSpawnTool } from '../src/orchestrator.mjs'
import {
  DEFAULT_TRUST_THRESHOLD,
  decidePlacement,
  resolveRequesterTrust,
} from '../src/pod-placement-wiring.mjs'

const RESOURCE = DEFAULT_POD_HOST_RESOURCE
const ALL_SCOPES = ['spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list'].map((v) => `${RESOURCE}:${v}`)

async function createPeer(label) {
  const identityManager = new MeshIdentityManager({})
  const wallet = new IdentityWallet({ identityManager })
  const { podId } = await wallet.createIdentity(label)
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId }),
  })
  return { podId, wallet, registry }
}

function wireMesh(peers) {
  const listeners = new Map()
  const nodes = new Map()
  for (const peer of peers) {
    listeners.set(peer.podId, new Set())
    nodes.set(peer.podId, {
      podId: peer.podId,
      wallet: peer.wallet,
      registry: peer.registry,
      onIncomingData(cb) {
        listeners.get(peer.podId).add(cb)
        return () => listeners.get(peer.podId).delete(cb)
      },
      async sendTo(pubKey, data) {
        const target = listeners.get(pubKey)
        if (!target) throw new Error(`no such peer: ${pubKey}`)
        queueMicrotask(() => { for (const cb of [...target]) cb(peer.podId, data) })
      },
    })
  }
  return nodes
}

/** A driver that states a boundary, as a runtime lane driver does. */
function withBoundary(driver, boundary) {
  return {
    get lane() { return driver.lane },
    capabilities: () => ({ ...driver.capabilities(), boundary }),
    onEvent: (fn) => driver.onEvent(fn),
    spawn: (spec) => driver.spawn(spec),
    status: (name) => driver.status(name),
    send: (name, msg) => driver.send(name, msg),
    exec: (name, argv, opts) => driver.exec(name, argv, opts),
    snapshot: (name) => driver.snapshot(name),
    restore: (name) => driver.restore(name),
    drain: (name, opts) => driver.drain(name, opts),
    list: () => driver.list(),
  }
}

function auditRecorder() {
  const records = []
  return { records, async record(operation, data) { records.push({ operation, data }) } }
}

function runtimeRegistry(peers) {
  return { listPeers: () => peers, resolvePeer: (id) => peers.find((p) => p.identity?.podId === id) ?? null }
}

const SPEC = (name, extra = {}) => ({ name, lane: POD_LANE.ISOLATE, run: { kind: 'skill', ref: 'greeter' }, ...extra })

describe('resolveRequesterTrust', () => {
  const registry = { getTrust: (id) => ({ alice: 0.95, bob: 0.4, weird: Number.NaN, big: 7 })[id] }

  it('is untrusted without a requester, without a registry, and without a usable value', () => {
    for (const requesterId of [undefined, null, '', 42]) {
      assert.equal(resolveRequesterTrust({ requesterId, registry }).trust, 'untrusted')
    }
    assert.equal(resolveRequesterTrust({ requesterId: 'alice' }).trust, 'untrusted')
    assert.equal(resolveRequesterTrust({ requesterId: 'alice', registry: {} }).trust, 'untrusted')
    for (const requesterId of ['weird', 'big', 'unknown']) {
      const result = resolveRequesterTrust({ requesterId, registry })
      assert.equal(result.trust, 'untrusted')
      assert.equal(result.level, null)
    }
    const throwing = { getTrust() { throw new Error('boom') } }
    assert.equal(resolveRequesterTrust({ requesterId: 'alice', registry: throwing }).trust, 'untrusted')
  })

  it('is trusted at or above the threshold, untrusted below it', () => {
    assert.equal(DEFAULT_TRUST_THRESHOLD, 0.8)
    assert.equal(resolveRequesterTrust({ requesterId: 'alice', registry }).trust, 'trusted')
    assert.equal(resolveRequesterTrust({ requesterId: 'bob', registry }).trust, 'untrusted')
    assert.equal(resolveRequesterTrust({ requesterId: 'bob', registry, threshold: 0.4 }).trust, 'trusted')
  })

  it('treats the local pod as trusted without asking the graph', () => {
    assert.equal(resolveRequesterTrust({ requesterId: 'me', registry, localPodId: 'me' }).trust, 'trusted')
  })
})

describe('decidePlacement', () => {
  const hosts = [
    { podId: 'weak', lane: 'isolate', boundary: 'process', verbs: ['spawn'] },
    { podId: 'strong', lane: 'isolate', boundary: 'language', verbs: ['spawn'] },
    { podId: 'silent', lane: 'isolate', boundary: null, verbs: ['spawn'] },
  ]
  const registry = { getTrust: (id) => (id === 'alice' ? 0.95 : 0.1) }

  it('an untrusted requester only gets a host behind a language or hardware boundary', () => {
    const d = decidePlacement({ spec: SPEC('a'), hosts, requesterId: 'mallory', registry })
    assert.equal(d.plan.ok, true)
    assert.equal(d.plan.host.id, 'strong')
    assert.equal(d.requester.trust, 'untrusted')
    assert.deepEqual(d.plan.rejected.map((r) => [r.id, r.code]).sort(), [['silent', 'boundary'], ['weak', 'boundary']])
  })

  it('no requester at all is untrusted, and a host that states no boundary counts as none', () => {
    const d = decidePlacement({ spec: SPEC('a'), hosts: [hosts[2]], registry })
    assert.equal(d.plan.ok, false)
    assert.equal(d.plan.code, 'no-eligible-host')
    assert.equal(d.error.code, POD_HOST_ERROR.EACCES)
    assert.equal(d.requester.trust, 'untrusted')
  })

  it('a requester the graph trusts may use a weaker boundary', () => {
    const d = decidePlacement({ spec: SPEC('a'), hosts: [hosts[0]], requesterId: 'alice', registry })
    assert.equal(d.plan.ok, true)
    assert.equal(d.plan.host.id, 'weak')
  })

  it('a minimum boundary raises the floor for a trusted requester too', () => {
    const d = decidePlacement({ spec: SPEC('a'), hosts: [hosts[0]], requesterId: 'alice', registry, policy: { minBoundary: 'language' } })
    assert.equal(d.plan.ok, false)
  })

  it('refuses before looking at any host when the requester is at its pod quota', () => {
    const requesterUsage = new Map([['alice', { pods: 2 }]])
    const d = decidePlacement({ spec: SPEC('a'), hosts, requesterId: 'alice', registry, requesterUsage, policy: { perRequesterMaxPods: 2 } })
    assert.equal(d.plan.ok, false)
    assert.equal(d.plan.code, 'quota')
    assert.equal(d.error.code, POD_HOST_ERROR.EACCES)
  })

  it('a podspec that carries a budget is refused when nothing can check it, or when the check says no', async () => {
    const spec = SPEC('a', { budget: { credits: 5 } })
    const noGate = decidePlacement({ spec, hosts, requesterId: 'alice', registry })
    assert.equal(noGate.plan.ok, false)
    assert.equal(noGate.plan.code, 'budget')
    const denied = decidePlacement({ spec, hosts, requesterId: 'alice', registry, budgetCheck: () => ({ allowed: false, reason: 'balance 2' }) })
    assert.equal(denied.plan.code, 'budget')
    assert.match(denied.error.message, /balance 2/)
    const allowed = decidePlacement({ spec, hosts, requesterId: 'alice', registry, budgetCheck: ({ budget }) => budget.credits <= 5 })
    assert.equal(allowed.plan.ok, true)
  })

  it('a podspec with no budget never consults the budget check', () => {
    let called = false
    decidePlacement({ spec: SPEC('a'), hosts, requesterId: 'alice', registry, budgetCheck: () => { called = true; return false } })
    assert.equal(called, false)
  })

  it('the audit data names the requester, its trust and the decision, and nothing of the podspec env or input', () => {
    const d = decidePlacement({ spec: SPEC('a', { env: { SECRET: 'x' } }), hosts, requesterId: 'mallory', registry })
    const text = JSON.stringify(d.audit)
    assert.ok(!text.includes('SECRET'))
    assert.equal(d.audit.requesterId, 'mallory')
    assert.equal(d.audit.trust, 'untrusted')
    assert.equal(d.audit.chosen, 'strong')
    assert.ok(d.audit.rejected.every((r) => typeof r.code === 'string'))
  })
})

describe('MeshOrchestrator#placePod and meshctl_spawn constraints', () => {
  let weakHost; let strongHost; let operator; let alice; let orchestrator; let records; let nodes

  beforeEach(async () => {
    weakHost = await createPeer('weak-host')
    strongHost = await createPeer('strong-host')
    operator = await createPeer('operator')
    nodes = wireMesh([weakHost, strongHost, operator])
    const weak = attachService(nodes.get(weakHost.podId), undefined, createPodHostService({
      driver: withBoundary(new InMemoryPodHostDriver({ lane: POD_LANE.ISOLATE }), 'process'), hostLabel: 'weak',
    }))
    const strong = attachService(nodes.get(strongHost.podId), undefined, createPodHostService({
      driver: withBoundary(new InMemoryPodHostDriver({ lane: POD_LANE.ISOLATE }), 'language'), hostLabel: 'strong',
    }))
    weakHost.registry.grantCapabilities(operator.podId, ALL_SCOPES)
    strongHost.registry.grantCapabilities(operator.podId, ALL_SCOPES)
    alice = 'alice-key'
    operator.registry.setTrust(alice, 0.95)
    records = auditRecorder()
    const client = createPodHostClient({ peerNode: nodes.get(operator.podId), timeoutMs: 1000 })
    orchestrator = new MeshOrchestrator({
      peerNode: nodes.get(operator.podId),
      podHostClient: client,
      runtimeRegistry: runtimeRegistry([weak.api.runtimePeer(), strong.api.runtimePeer()]),
      auditRecorder: records,
    })
  })

  it('hosts report the boundary their driver states, and a host that states none reports null', async () => {
    const hosts = await orchestrator.listPodHosts()
    const byId = Object.fromEntries(hosts.map((h) => [h.podId, h.boundary]))
    assert.deepEqual(byId, { [weakHost.podId]: 'process', [strongHost.podId]: 'language' })
  })

  it('places an untrusted requester behind the strong boundary and audits the decision', async () => {
    const placed = await orchestrator.placePod(SPEC('p1'), { requesterId: 'mallory' })
    assert.equal(placed.hostPodId, strongHost.podId)
    assert.equal(placed.status.state, 'registered')
    const decision = records.records.find((r) => r.operation === PLACEMENT_AUDIT.REQUESTED && r.data.phase === 'decision')
    assert.equal(decision.data.requesterId, 'mallory')
    assert.equal(decision.data.trust, 'untrusted')
    assert.equal(decision.data.chosen, strongHost.podId)
    assert.ok(decision.data.rejected.some((r) => r.id === weakHost.podId && r.code === 'boundary'))
  })

  it('a requester the trust graph rates highly may land on the weaker boundary (ranking decides among both)', async () => {
    const placed = await orchestrator.placePod(SPEC('p2'), { requesterId: alice, policy: { preferHost: weakHost.podId } })
    assert.equal(placed.hostPodId, weakHost.podId)
  })

  it('no requester means untrusted; refusal is EACCES, audited as denied, and nothing was spawned', async () => {
    const only = new MeshOrchestrator({
      peerNode: nodes.get(operator.podId),
      podHostClient: createPodHostClient({ peerNode: nodes.get(operator.podId), timeoutMs: 1000 }),
      runtimeRegistry: runtimeRegistry([]),
      auditRecorder: records,
    })
    await assert.rejects(() => only.placePod(SPEC('p3'), {}), (err) => err.code === POD_HOST_ERROR.ENOENT)
    await assert.rejects(
      () => orchestrator.placePod(SPEC('p3'), { requesterId: 'mallory', policy: { minBoundary: 'hardware' } }),
      (err) => err.code === POD_HOST_ERROR.EACCES,
    )
    const denied = records.records.filter((r) => r.operation === PLACEMENT_AUDIT.DENIED)
    assert.deepEqual(denied.map((r) => [r.data.requesterId, r.data.code]), [[null, 'no-hosts'], ['mallory', 'no-eligible-host']])
    assert.deepEqual((await orchestrator.listHostedPods(strongHost.podId)).map((p) => p.name), [])
  })

  it('the per-requester pod quota counts what placePod placed, and releasePlacement gives it back', async () => {
    const policy = { perRequesterMaxPods: 1 }
    await orchestrator.placePod(SPEC('q1'), { requesterId: alice, policy })
    await assert.rejects(() => orchestrator.placePod(SPEC('q2'), { requesterId: alice, policy }), (err) => err.code === POD_HOST_ERROR.EACCES && /quota/.test(err.message))
    orchestrator.releasePlacement(strongHost.podId, 'q1')
    orchestrator.releasePlacement(weakHost.podId, 'q1')
    const again = await orchestrator.placePod(SPEC('q2'), { requesterId: alice, policy })
    assert.ok(again.hostPodId)
  })

  it('a spec with a budget is checked before anything is placed', async () => {
    await assert.rejects(
      () => orchestrator.placePod(SPEC('b1', { budget: { credits: 3 } }), { requesterId: alice }),
      (err) => err.code === POD_HOST_ERROR.EACCES && /budget/.test(err.message),
    )
    assert.deepEqual((await orchestrator.listHostedPods(strongHost.podId)).map((p) => p.name), [])
  })

  it('meshctl_spawn with no constraints still picks as before (no planner, no trust read)', async () => {
    const tool = new MeshctlSpawnTool(orchestrator)
    const result = await tool.execute({ host: 'auto', name: 'old', run: { kind: 'skill', ref: 'greeter' } })
    assert.equal(result.success, true)
    assert.match(result.output, /orchestrator proposes host/)
    assert.equal(records.records.some((r) => r.data?.phase === 'decision'), false)
  })

  it('meshctl_spawn with constraints goes through the planner', async () => {
    const tool = new MeshctlSpawnTool(orchestrator)
    const result = await tool.execute({ name: 'new', run: { kind: 'skill', ref: 'greeter' }, constraints: { requester: 'mallory' } })
    assert.equal(result.success, true)
    assert.match(result.output, new RegExp(`spawned 'new' on ${strongHost.podId}`))
    const refused = await tool.execute({ name: 'new2', run: { kind: 'skill', ref: 'greeter' }, constraints: { requester: 'mallory', minBoundary: 'hardware' } })
    assert.equal(refused.success, false)
    assert.match(refused.error, /placement refused: no host may take this pod/)
  })

  it('meshctl_spawn names the host and the constraints still apply to it', async () => {
    const tool = new MeshctlSpawnTool(orchestrator)
    const refused = await tool.execute({ host: weakHost.podId, name: 'named', run: { kind: 'skill', ref: 'greeter' }, constraints: { requester: 'mallory' } })
    assert.equal(refused.success, false)
    assert.deepEqual((await orchestrator.listHostedPods(weakHost.podId)).map((p) => p.name), [])
  })
})
