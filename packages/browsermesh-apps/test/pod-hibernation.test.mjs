/**
 * Tests for hibernating pods across the apps layer: the pod-host service (what a requester sees and may do), the
 * placement pool (what a sleeping pod costs) and the supervisor (a sleep is not an exit).
 *
 * The driver is `createHibernatingDriver()` from `@johnhenry/browsermesh-pod` over `InMemoryPodHostDriver`, with a
 * fake clock; the mesh is the same duck-typed two-peer mesh `pod-supervisor.test.mjs` uses.
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL,
} from '@johnhenry/browsermesh-core'
import {
  InMemoryPodHostDriver, POD_LANE, POD_HOST_ERROR, PodHostDriverError, createHibernatingDriver,
} from '@johnhenry/browsermesh-pod'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createPodHostService, createPodHostClient, DEFAULT_POD_HOST_RESOURCE } from '../src/pod-host-service.mjs'
import { MeshOrchestrator } from '../src/orchestrator.mjs'
import { createPodSupervisor } from '../src/pod-supervisor.mjs'
import { createHostPool } from '../src/pod-placement.mjs'

const RESOURCE = DEFAULT_POD_HOST_RESOURCE
const ALL_SCOPES = ['spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list'].map((verb) => `${RESOURCE}:${verb}`)

function fakeClock() {
  let t = 1_000_000
  return { now: () => t, advance(ms) { t += ms } }
}

function hibernating(clock, options = {}, probe = {}) {
  const inner = new InMemoryPodHostDriver({ lane: POD_LANE.ISOLATE })
  // The in-memory driver reports no podId; give pods one so identity is checked.
  const withId = (s) => ({ ...s, podId: `id-${s.name}` })
  const lane = {
    lane: inner.lane,
    capabilities: () => inner.capabilities(),
    onEvent: (fn) => inner.onEvent(fn),
    spawn: async (spec) => {
      if (probe.failSpawn) throw new PodHostDriverError(POD_HOST_ERROR.EBUSY, 'boot failed')
      return withId(await inner.spawn(spec))
    },
    status: async (name) => withId(await inner.status(name)),
    send: (name, msg) => inner.send(name, msg),
    exec: (...a) => inner.exec(...a),
    snapshot: (...a) => inner.snapshot(...a),
    restore: (...a) => inner.restore(...a),
    drain: (...a) => inner.drain(...a),
    list: async () => (await inner.list()).map(withId),
  }
  return createHibernatingDriver(lane, { idleMs: 1000, wakeTimeoutMs: 500, now: clock.now, ...options })
}

const spec = (name = 'alpha') => ({ name, lane: POD_LANE.ISOLATE, run: { kind: 'skill', ref: 'greeter' } })
const flush = (ms = 20) => new Promise((resolve) => { setTimeout(resolve, ms) })

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
  const dataListeners = new Map()
  const nodes = new Map()
  for (const peer of peers) {
    dataListeners.set(peer.podId, new Set())
    nodes.set(peer.podId, {
      podId: peer.podId,
      wallet: peer.wallet,
      registry: peer.registry,
      onIncomingData(cb) {
        dataListeners.get(peer.podId).add(cb)
        return () => dataListeners.get(peer.podId).delete(cb)
      },
      async sendTo(pubKey, data) {
        const target = dataListeners.get(pubKey)
        if (!target) throw new Error(`no such peer: ${pubKey}`)
        queueMicrotask(() => { for (const cb of [...target]) cb(peer.podId, data) })
      },
      on() {},
      off() {},
    })
  }
  return nodes
}

describe('the pod-host service over a hibernating driver', () => {
  let alice
  let bob
  let nodes
  let clock
  let driver
  let client

  beforeEach(async () => {
    alice = await createPeer('alice-host')
    bob = await createPeer('bob-client')
    nodes = wireMesh([alice, bob])
    clock = fakeClock()
    driver = hibernating(clock)
    attachService(nodes.get(alice.podId), undefined, createPodHostService({ driver, lane: POD_LANE.ISOLATE, hostLabel: 'alice-host' }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 2000 })
  })

  it('describe() states the hibernation policy, so a caller knows a pod there may sleep', async () => {
    const description = await client.describe(alice.podId)
    assert.deepEqual(description.hibernation, { idleMs: 1000, wakeTimeoutMs: 500, discoveryWindowMs: 100 })
  })

  it('a host without hibernation describes it as null', async () => {
    const plain = await createPeer('plain-host')
    const meshNodes = wireMesh([plain, bob])
    attachService(meshNodes.get(plain.podId), undefined, createPodHostService({ driver: new InMemoryPodHostDriver({ lane: POD_LANE.ISOLATE }), lane: POD_LANE.ISOLATE }))
    plain.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const other = createPodHostClient({ peerNode: meshNodes.get(bob.podId), timeoutMs: 2000 })
    assert.equal((await other.describe(plain.podId)).hibernation, null)
  })

  it('a requester sees its pod asleep (cold, sleeping, podId), and a send wakes it', async () => {
    await client.spawn(alice.podId, spec())
    clock.advance(1000)
    await driver.sweep()
    const status = await client.status(alice.podId, 'alpha')
    assert.equal(status.state, 'cold')
    assert.equal(status.sleeping, true)
    assert.equal(status.podId, 'id-alpha')
    const reply = await client.send(alice.podId, 'alpha', { payload: { hi: 1 } })
    assert.equal(reply.delivered, true)
    assert.equal(reply.woke, true)
  })

  it('a requester that was not allowed to send cannot wake a pod: the refusal comes before the driver', async () => {
    await client.spawn(alice.podId, spec())
    clock.advance(1000)
    await driver.sweep()
    const carol = await createPeer('carol-stranger')
    const meshNodes = wireMesh([alice, carol])
    attachService(meshNodes.get(alice.podId), undefined, createPodHostService({ driver, lane: POD_LANE.ISOLATE, hostLabel: 'alice-host' }))
    alice.registry.grantCapabilities(carol.podId, [`${RESOURCE}:send`, `${RESOURCE}:status`])
    const stranger = createPodHostClient({ peerNode: meshNodes.get(carol.podId), timeoutMs: 2000 })
    await assert.rejects(stranger.send(alice.podId, 'alpha', { payload: 1 }), (err) => err.code === POD_HOST_ERROR.EACCES)
    assert.equal(driver.stats().wakes, 0)
    assert.equal((await client.status(alice.podId, 'alpha')).sleeping, true)
  })
})

describe('the supervisor and a sleeping pod', () => {
  it('a sleep is not an exit: the supervised pod is not restarted, and a wake is not a restart', async () => {
    const alice = await createPeer('alice-host')
    const bob = await createPeer('bob-supervisor')
    const nodes = wireMesh([alice, bob])
    const clock = fakeClock()
    const driver = hibernating(clock)
    attachService(nodes.get(alice.podId), undefined, createPodHostService({ driver, lane: POD_LANE.ISOLATE, hostLabel: 'alice-host' }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const supervisor = createPodSupervisor({ orchestrator: new MeshOrchestrator({ peerNode: nodes.get(bob.podId) }) })
    await supervisor.supervise(alice.podId, { ...spec(), restart: { policy: 'always', backoffMs: 1 } })

    clock.advance(1000)
    await driver.sweep()
    await flush(50)
    let entry = supervisor.list()[0]
    assert.equal(entry.state, 'running')
    assert.equal(entry.restarts, 0)
    assert.equal(driver.stats().sleeps, 1)

    const client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 2000 })
    await client.send(alice.podId, 'alpha', { payload: 1 })
    await flush(50)
    entry = supervisor.list()[0]
    assert.equal(entry.state, 'running')
    assert.equal(entry.restarts, 0)
    supervisor.stop()
  })
})

describe('the placement pool and a sleeping pod', () => {
  function pool(options = {}) {
    const clock = fakeClock()
    const driver = hibernating(clock)
    const host = createHostPool({
      hosts: [{ id: 'h1', driver, boundary: 'language', capacity: { pods: 5, vcpus: 1, memMib: 128 } }],
      policy: options.policy ?? {},
      overcommitSleeping: options.overcommitSleeping,
    })
    return { clock, driver, host }
  }

  it('by default a sleeping pod keeps its reservation: nothing else fits in its place', async () => {
    const { clock, driver, host } = pool()
    await host.spawn(spec('a'))
    clock.advance(1000)
    await driver.sweep()
    assert.deepEqual(host.usage().get('h1'), { pods: 1, vcpus: 1, memMib: 128 })
    await assert.rejects(host.spawn(spec('b')), (err) => err.code === POD_HOST_ERROR.EBUSY)
  })

  it('with overcommitSleeping a sleeping pod frees its cpu and memory but still counts as a pod and toward the requester quota', async () => {
    const { clock, driver, host } = pool({ overcommitSleeping: true, policy: { perRequesterMaxPods: 2 } })
    const requester = { id: 'req-1' }
    await host.spawn(spec('a'), { requester })
    clock.advance(1000)
    await driver.sweep()
    assert.deepEqual(host.usage().get('h1'), { pods: 1, vcpus: 0, memMib: 0 })
    await host.spawn(spec('b'), { requester })
    await assert.rejects(host.spawn(spec('c'), { requester }), (err) => err.code === POD_HOST_ERROR.EACCES && /quota/.test(err.message))
  })

  it('with overcommitSleeping a wake that would not fit is refused EBUSY, the pod stays asleep, and the ledger is unchanged', async () => {
    const { clock, driver, host } = pool({ overcommitSleeping: true })
    await host.spawn(spec('a'))
    clock.advance(1000)
    await driver.sweep()
    await host.spawn(spec('b'))
    const before = host.usage().get('h1')
    await assert.rejects(driver.send('a', { payload: 1 }), (err) => err.code === POD_HOST_ERROR.EBUSY && err.details.reason === 'wake-refused')
    assert.deepEqual(host.usage().get('h1'), before)
    assert.equal((await driver.status('a')).sleeping, true)
    // Room appears: the same send now wakes it and the reservation returns.
    await host.drain('b')
    assert.equal((await driver.send('a', { payload: 1 })).woke, true)
    assert.deepEqual(host.usage().get('h1'), { pods: 1, vcpus: 1, memMib: 128 })
  })

  it('a wake that fails after admission gives the reservation back', async () => {
    const clock = fakeClock()
    const probe = { failSpawn: false }
    const driver = hibernating(clock, {}, probe)
    const host = createHostPool({ hosts: [{ id: 'h1', driver, boundary: 'language', capacity: { vcpus: 1, memMib: 128 } }], overcommitSleeping: true })
    await host.spawn(spec('a'))
    clock.advance(1000)
    await driver.sweep()
    assert.deepEqual(host.usage().get('h1'), { pods: 1, vcpus: 0, memMib: 0 })
    probe.failSpawn = true
    await assert.rejects(driver.send('a', { payload: 1 }), (err) => err.details.reason === 'wake-failed')
    assert.deepEqual(host.usage().get('h1'), { pods: 1, vcpus: 0, memMib: 0 }, 'a failed boot holds no cpu or memory')
    probe.failSpawn = false
    assert.equal((await driver.send('a', { payload: 1 })).woke, true)
    assert.deepEqual(host.usage().get('h1'), { pods: 1, vcpus: 1, memMib: 128 })
  })
})
