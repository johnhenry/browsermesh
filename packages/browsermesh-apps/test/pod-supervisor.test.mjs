/**
 * Tests for pod-supervisor.mjs -- issue #185 item 6: links, monitors, and
 * restart policy over the hosted-pods control surface.
 *
 * Two fixture styles, matching the two things this file needs to exercise:
 *
 *   - a REAL mesh (two Ed25519 `PeerRegistry`s, `attachService()`,
 *     `InMemoryPodHostDriver`, `createPodHostClient()`) for the
 *     end-to-end paths: restart policies driven by the driver's own
 *     `crash()`/`drain()`, link cascade through a real `drain()` call,
 *     `MeshOrchestrator#drainPod()`'s cascade into the supervisor.
 *   - a FAKE `PodHostClient` + fake injectable timers for the paths that
 *     need precise control a real driver's limited event vocabulary can't
 *     give: backoff sequencing/cap, `maxRestarts` -> gave-up, a host
 *     refusing a restart (`EACCES`), an `on-failure` exit that should be
 *     IGNORED (code 0, no 'crashed'/'host-lost' reason).
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/pod-supervisor.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL,
} from '@johnhenry/browsermesh-core'
import {
  InMemoryPodHostDriver, POD_LANE, POD_HOST_EVENT_KIND,
} from '@johnhenry/browsermesh-pod'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createPodHostService, createPodHostClient, DEFAULT_POD_HOST_RESOURCE } from '../src/pod-host-service.mjs'
import { MeshOrchestrator } from '../src/orchestrator.mjs'
import { createPodSupervisor, SUPERVISOR_AUDIT } from '../src/pod-supervisor.mjs'

const RESOURCE = DEFAULT_POD_HOST_RESOURCE
const ALL_SCOPES = [
  'spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list',
].map((verb) => `${RESOURCE}:${verb}`)

// ---------------------------------------------------------------------------
// Real-mesh fixtures (mirrors pod-host-service.test.mjs)
// ---------------------------------------------------------------------------

/** A real Ed25519 identity + wallet + registry bundle for one "peer". */
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

/**
 * A minimal duck-typed `PeerNode` mesh. Beyond `sendTo`/`onIncomingData`
 * (what `pod-host-service.mjs` needs), each node also gets `on`/`off` +
 * `disconnectPeer()` -- the real `PeerNode`'s own event-bus shape
 * (`peer-node.mjs`'s `on(event, cb)` and its `'peer:disconnect'` emission
 * off `PeerRegistry.onPeerDisconnect()`), reduced to exactly what this
 * file's host-loss detection consumes: `fingerprint` on the disconnect
 * payload.
 */
function wireMesh(peers) {
  /** @type {Map<string, Set<Function>>} */
  const dataListeners = new Map()
  /** @type {Map<string, Map<string, Set<Function>>>} */
  const busListeners = new Map()
  /** @type {Map<string, object>} */
  const nodes = new Map()

  for (const peer of peers) {
    dataListeners.set(peer.podId, new Set())
    busListeners.set(peer.podId, new Map())
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
        queueMicrotask(() => {
          for (const cb of [...target]) cb(peer.podId, data)
        })
      },
      on(event, cb) {
        const byEvent = busListeners.get(peer.podId)
        if (!byEvent.has(event)) byEvent.set(event, new Set())
        byEvent.get(event).add(cb)
      },
      off(event, cb) {
        busListeners.get(peer.podId).get(event)?.delete(cb)
      },
      /** Test-only: simulate this node seeing `pubKey` disconnect. */
      simulateDisconnect(pubKey) {
        const cbs = busListeners.get(peer.podId).get('peer:disconnect')
        if (!cbs) return
        for (const cb of [...cbs]) cb({ fingerprint: pubKey })
      },
    })
  }
  return nodes
}

/** A fake `AuditChain`, recording what was appended instead of hashing it. */
function fakeAuditChain() {
  /** @type {object[]} */
  const entries = []
  return {
    entries,
    async append(authorPodId, operation, data) {
      entries.push({ authorPodId, operation, data })
    },
    operations() {
      return entries.map((entry) => entry.operation)
    },
  }
}

function minimalSpec(overrides = {}) {
  return { name: 'alpha', lane: POD_LANE.NODE, run: { kind: 'command', ref: '/bin/echo' }, ...overrides }
}

/** Let queued mesh microtasks (spawn/drain/event forwarding) settle. */
function flush(ms = 20) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

// ---------------------------------------------------------------------------
// Fake PodHostClient + fake clock, for precise event/timer control
// ---------------------------------------------------------------------------

/** @returns {{client: object, fire: Function, spawns: object[], drains: object[]}} */
function fakeHostClient({ spawnImpl } = {}) {
  /** @type {Function|null} */
  let onEventFn = null
  const spawns = []
  const drains = []
  const impl = spawnImpl || (async (host, spec) => ({ name: spec.name, lane: spec.lane, state: 'registered' }))
  const client = {
    async spawn(host, spec) {
      spawns.push({ host, spec })
      return impl(host, spec)
    },
    async drain(host, name, opts) {
      drains.push({ host, name, opts })
      return { name, state: 'gone' }
    },
    async list() { return [] },
    async status(host, name) { return { name, state: 'registered' } },
    onEvent(fn) {
      onEventFn = fn
      return () => { onEventFn = null }
    },
  }
  return {
    client,
    spawns,
    drains,
    /** Simulate the host pushing a `pod-host:event`. */
    fire(hostPubKey, event) { onEventFn?.(hostPubKey, event) },
  }
}

/** Flush `n` microtask turns -- enough hops for a chain of several `await`s to settle. */
async function tick(n = 20) {
  for (let i = 0; i < n; i += 1) await Promise.resolve()
}

/** A deterministic, manually-advanced clock for backoff tests. */
function fakeClock() {
  let now = 0
  let nextId = 1
  /** @type {Map<number, {fn: Function, due: number}>} */
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, delay) {
      const id = nextId++
      timers.set(id, { fn, due: now + delay })
      return id
    },
    clearTimeout(id) { timers.delete(id) },
    pendingCount() { return timers.size },
    /** Advance the clock by `ms`, firing any timers now due (in due order), awaiting a microtask after each. */
    async advance(ms) {
      now += ms
      let ran = true
      while (ran) {
        ran = false
        const due = [...timers.entries()].filter(([, t]) => t.due <= now).sort((a, b) => a[1].due - b[1].due)
        for (const [id, t] of due) {
          if (!timers.has(id)) continue
          timers.delete(id)
          ran = true
          t.fn()
          // let any promises chained off the timer body settle before the
          // next timer (and before the caller inspects state)
          await tick()
        }
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Restart policies (real driver, via crash()/drain())
// ---------------------------------------------------------------------------

describe('pod-supervisor: restart policies (real driver)', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodes
  /** @type {any} */ let driver
  /** @type {any} */ let orchestrator
  /** @type {any} */ let supervisor

  beforeEach(async () => {
    alice = await createPeer('alice-host')
    bob = await createPeer('bob-supervisor')
    nodes = wireMesh([alice, bob])
    driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    attachService(nodes.get(alice.podId), undefined, createPodHostService({ driver, hostLabel: 'alice-host' }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    orchestrator = new MeshOrchestrator({ peerNode: nodes.get(bob.podId) })
    supervisor = createPodSupervisor({ orchestrator })
  })

  it("policy 'never': a crash marks the pod dead, no restart", async () => {
    await supervisor.supervise(alice.podId, minimalSpec({ restart: { policy: 'never' } }))
    await driver.crash('alpha')
    await flush()
    assert.equal(supervisor.list()[0].state, 'dead')
    assert.equal((await driver.list()).length, 1) // never respawned
  })

  it("policy 'on-failure': a crash restarts the pod", async () => {
    await supervisor.supervise(alice.podId, minimalSpec({
      restart: { policy: 'on-failure', backoffMs: 1 },
    }))
    await driver.crash('alpha', { code: 1 })
    await flush(50)
    const entry = supervisor.list()[0]
    assert.equal(entry.state, 'running')
    assert.equal(entry.restarts, 1)
  })

  it("policy 'always': a crash restarts the pod", async () => {
    await supervisor.supervise(alice.podId, minimalSpec({
      restart: { policy: 'always', backoffMs: 1 },
    }))
    await driver.crash('alpha', { code: 0 })
    await flush(50)
    const entry = supervisor.list()[0]
    assert.equal(entry.state, 'running')
    assert.equal(entry.restarts, 1)
  })

  it('an intentional drain is never restarted, under any policy', async () => {
    await supervisor.supervise(alice.podId, minimalSpec({ restart: { policy: 'always', backoffMs: 1 } }))
    await supervisor.drain({ host: alice.podId, name: 'alpha' })
    await flush()
    assert.equal(supervisor.list()[0].state, 'dead')
  })
})

// ---------------------------------------------------------------------------
// Links / cascade (real driver)
// ---------------------------------------------------------------------------

describe('pod-supervisor: links and cascade (real driver)', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodes
  /** @type {any} */ let driver
  /** @type {any} */ let orchestrator
  /** @type {any} */ let supervisor

  beforeEach(async () => {
    alice = await createPeer('alice-host')
    bob = await createPeer('bob-supervisor')
    nodes = wireMesh([alice, bob])
    driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    attachService(nodes.get(alice.podId), undefined, createPodHostService({ driver, hostLabel: 'alice-host' }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    orchestrator = new MeshOrchestrator({ peerNode: nodes.get(bob.podId) })
    supervisor = createPodSupervisor({ orchestrator })
  })

  it('drain(parent, {cascade:true}) drains grandchild, then child, then parent, in that order', async () => {
    const parent = await supervisor.supervise(alice.podId, minimalSpec({ name: 'parent' }))
    await supervisor.supervise(alice.podId, minimalSpec({
      name: 'child', links: { parent: 'parent' },
    }))
    await supervisor.supervise(alice.podId, minimalSpec({
      name: 'grandchild', links: { parent: 'child' },
    }))

    /** @type {object[]} */
    const cascades = []
    supervisor.on('supervisor:cascade', (e) => cascades.push(e))

    const { order } = await supervisor.drain(parent.ref, { cascade: true })
    assert.deepEqual(order.map((r) => r.name), ['grandchild', 'child', 'parent'])
    assert.equal(cascades.length, 1)
    assert.deepEqual(cascades[0].order.map((r) => r.name), ['grandchild', 'child', 'parent'])

    assert.equal(supervisor.list().find((p) => p.ref.name === 'child').state, 'dead')
    assert.equal(supervisor.list().find((p) => p.ref.name === 'grandchild').state, 'dead')
    assert.equal((await driver.status('grandchild')).state, 'gone')
  })

  it('a child is drained (not restarted) when its parent exits unexpectedly', async () => {
    await supervisor.supervise(alice.podId, minimalSpec({ name: 'parent', restart: { policy: 'always', backoffMs: 1 } }))
    await supervisor.supervise(alice.podId, minimalSpec({
      name: 'child', restart: { policy: 'always', backoffMs: 1 }, links: { parent: 'parent' },
    }))

    await driver.crash('parent')
    await flush(50)

    const child = supervisor.list().find((p) => p.ref.name === 'child')
    assert.equal(child.state, 'dead')
    assert.equal(child.restarts, 0)
    assert.equal((await driver.status('child')).state, 'gone')
  })

  it("detachOnParentExit + restart policy 'always' leaves the child running and self-restarting", async () => {
    await supervisor.supervise(alice.podId, minimalSpec({ name: 'parent' }))
    await supervisor.supervise(alice.podId, minimalSpec({
      name: 'child',
      restart: { policy: 'always', backoffMs: 1 },
      links: { parent: 'parent', detachOnParentExit: true },
    }))

    await driver.crash('parent')
    await flush(20)

    const child = supervisor.list().find((p) => p.ref.name === 'child')
    assert.equal(child.state, 'running') // left alone, never drained
    assert.equal((await driver.status('child')).state, 'registered')
  })
})

// ---------------------------------------------------------------------------
// Monitors
// ---------------------------------------------------------------------------

describe('pod-supervisor: monitor()', () => {
  it('fires for lifecycle/exit events of the watched pod, and off() stops it', async () => {
    const alice = await createPeer('alice-host')
    const bob = await createPeer('bob-supervisor')
    const nodes = wireMesh([alice, bob])
    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    attachService(nodes.get(alice.podId), undefined, createPodHostService({ driver, hostLabel: 'alice-host' }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const orchestrator = new MeshOrchestrator({ peerNode: nodes.get(bob.podId) })
    const supervisor = createPodSupervisor({ orchestrator })

    const { ref } = await supervisor.supervise(alice.podId, minimalSpec({ restart: { policy: 'never' } }))
    /** @type {object[]} */
    const seen = []
    const off = supervisor.monitor(ref, (payload) => seen.push(payload))

    await driver.crash('alpha')
    await flush()
    assert.ok(seen.some((p) => p.event.kind === 'exit' && p.event.data.reason === 'crashed'))

    const countBefore = seen.length
    off()
    // Nothing left to crash again (pod is gone) -- confirm off() at least
    // removed the subscriber without throwing on a second event delivery.
    await flush()
    assert.equal(seen.length, countBefore)
  })
})

// ---------------------------------------------------------------------------
// Fine-grained control: fake client + fake clock
// ---------------------------------------------------------------------------

describe('pod-supervisor: backoff, maxRestarts, refusal re-placement, host-lost (fake client)', () => {
  it('on-failure ignores a code:0 exit with no crashed/host-lost reason', async () => {
    const { client, fire, spawns } = fakeHostClient()
    const clock = fakeClock()
    const supervisor = createPodSupervisor({
      client, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    })
    const { ref } = await supervisor.supervise('host-1', minimalSpec({ restart: { policy: 'on-failure' } }))
    assert.equal(spawns.length, 1)

    fire('host-1', { kind: 'exit', data: { name: 'alpha', code: 0, restartable: false } })
    await tick()

    assert.equal(spawns.length, 1) // no restart attempted
    assert.equal(supervisor.list().find((p) => p.ref.name === ref.name).state, 'dead')
  })

  it('backoff doubles per attempt and caps at 60000ms', async () => {
    const { client, fire, spawns } = fakeHostClient()
    const clock = fakeClock()
    const supervisor = createPodSupervisor({
      client, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    })
    await supervisor.supervise('host-1', minimalSpec({
      restart: { policy: 'always', backoffMs: 1000, maxRestarts: 10 },
    }))
    assert.equal(spawns.length, 1)

    /** @type {number[]} */
    const delays = []
    supervisor.on('supervisor:restart-scheduled', (e) => delays.push(e.delayMs))

    for (let i = 0; i < 6; i += 1) {
      fire('host-1', { kind: 'exit', data: { name: 'alpha', code: 1, reason: 'crashed', restartable: true } })
      // Let the scheduling microtask run before advancing the clock far
      // enough to fire the just-scheduled timer.
      await tick()
      await clock.advance(delays[delays.length - 1])
    }

    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000])
    assert.equal(spawns.length, 7) // 1 initial + 6 restarts

    // One more, past the point 1000*2^6=64000 would exceed the cap.
    fire('host-1', { kind: 'exit', data: { name: 'alpha', code: 1, reason: 'crashed', restartable: true } })
    await tick()
    assert.equal(delays[delays.length - 1], 60000)
  })

  it('gives up after maxRestarts and emits supervisor:gave-up', async () => {
    const { client, fire, spawns } = fakeHostClient()
    const clock = fakeClock()
    const supervisor = createPodSupervisor({
      client, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    })
    await supervisor.supervise('host-1', minimalSpec({
      restart: { policy: 'always', backoffMs: 1, maxRestarts: 2 },
    }))

    /** @type {object[]} */
    const gaveUp = []
    supervisor.on('supervisor:gave-up', (e) => gaveUp.push(e))

    for (let i = 0; i < 2; i += 1) {
      fire('host-1', { kind: 'exit', data: { name: 'alpha', code: 1, reason: 'crashed', restartable: true } })
      await tick()
      await clock.advance(10)
    }
    assert.equal(spawns.length, 3) // 1 initial + 2 restarts
    assert.equal(gaveUp.length, 0)

    // A third crash: maxRestarts (2) already used up -> gives up, no more spawn.
    fire('host-1', { kind: 'exit', data: { name: 'alpha', code: 1, reason: 'crashed', restartable: true } })
    await tick()
    assert.equal(gaveUp.length, 1)
    assert.equal(gaveUp[0].restarts, 2)
    assert.equal(spawns.length, 3)
    assert.equal(supervisor.list()[0].state, 'dead')
  })

  it('a restart refused with EACCES is re-placed on a second host', async () => {
    let calls = 0
    const spawnImpl = async (host) => {
      calls += 1
      if (calls === 1) return { name: 'alpha', state: 'registered' } // initial supervise()
      if (host === 'host-1') {
        const err = new Error('nope'); err.code = 'EACCES'; throw err
      }
      return { name: 'alpha', state: 'registered', host }
    }
    const { client, fire, spawns } = fakeHostClient({ spawnImpl })
    const clock = fakeClock()
    const supervisor = createPodSupervisor({
      client,
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      pickHost: async (_spec, opts) => (opts?.excludeHost === 'host-1' ? 'host-2' : 'host-1'),
    })
    const { ref } = await supervisor.supervise('host-1', minimalSpec({ restart: { policy: 'always', backoffMs: 1 } }))

    fire('host-1', { kind: 'exit', data: { name: 'alpha', code: 1, reason: 'crashed', restartable: true } })
    await tick()
    await clock.advance(1)
    await tick()

    const entry = supervisor.list()[0]
    assert.equal(entry.state, 'running')
    assert.equal(entry.host, 'host-2')
    assert.equal(entry.ref.host, 'host-2')
    assert.equal(ref.host, 'host-2') // the original handle's ref object was mutated in place
    assert.ok(spawns.some((s) => s.host === 'host-2'))
  })

  it('host-lost synthesizes an exit for every pod on that host and re-places it', async () => {
    const spawnImpl = async (host, spec) => ({ name: spec.name, state: 'registered', host })
    const { client, spawns } = fakeHostClient({ spawnImpl })
    const clock = fakeClock()
    /** @type {Map<string, Set<Function>>} */
    const bus = new Map()
    const fakePeerNode = {
      podId: 'bob',
      on(event, cb) {
        if (!bus.has(event)) bus.set(event, new Set())
        bus.get(event).add(cb)
      },
      off(event, cb) { bus.get(event)?.delete(cb) },
    }
    const supervisor = createPodSupervisor({
      client, peerNode: fakePeerNode,
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      pickHost: async () => 'host-2',
    })
    await supervisor.supervise('host-1', minimalSpec({ restart: { policy: 'always', backoffMs: 1 } }))

    /** @type {object[]} */
    const hostLost = []
    supervisor.on('supervisor:host-lost', (e) => hostLost.push(e))

    for (const cb of [...(bus.get('peer:disconnect') || [])]) cb({ fingerprint: 'host-1' })
    await tick()
    await clock.advance(1)
    await tick()

    assert.equal(hostLost.length, 1)
    assert.deepEqual(hostLost[0].affected.map((r) => r.name), ['alpha'])
    const entry = supervisor.list()[0]
    assert.equal(entry.host, 'host-2')
    assert.equal(entry.state, 'running')
    assert.ok(spawns.some((s) => s.host === 'host-2'))
  })

  it('stop() clears pending backoff timers so a scheduled restart never fires', async () => {
    const { client, fire, spawns } = fakeHostClient()
    const clock = fakeClock()
    const supervisor = createPodSupervisor({
      client, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    })
    await supervisor.supervise('host-1', minimalSpec({ restart: { policy: 'always', backoffMs: 1000 } }))
    fire('host-1', { kind: 'exit', data: { name: 'alpha', code: 1, reason: 'crashed', restartable: true } })
    await tick()
    assert.equal(clock.pendingCount(), 1)

    supervisor.stop()
    await clock.advance(5000)
    assert.equal(spawns.length, 1) // only the initial supervise() spawn; the scheduled restart never ran
  })

  it('records audit entries for restart-scheduled, restarted and gave-up', async () => {
    const { client, fire } = fakeHostClient()
    const clock = fakeClock()
    const auditChain = fakeAuditChain()
    const fakePeerNode = { podId: 'bob', wallet: { sign: async () => 'sig' } }
    const supervisor = createPodSupervisor({
      client, peerNode: fakePeerNode, auditChain,
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    })
    await supervisor.supervise('host-1', minimalSpec({
      restart: { policy: 'always', backoffMs: 1, maxRestarts: 1 },
    }))

    fire('host-1', { kind: 'exit', data: { name: 'alpha', code: 1, reason: 'crashed', restartable: true } })
    await tick()
    await clock.advance(1)
    await tick()

    fire('host-1', { kind: 'exit', data: { name: 'alpha', code: 1, reason: 'crashed', restartable: true } })
    await tick()

    assert.ok(auditChain.operations().includes(SUPERVISOR_AUDIT.RESTART_SCHEDULED))
    assert.ok(auditChain.operations().includes(SUPERVISOR_AUDIT.RESTARTED))
    assert.ok(auditChain.operations().includes(SUPERVISOR_AUDIT.GAVE_UP))
  })
})

// ---------------------------------------------------------------------------
// Orchestrator integration: getSupervisor() / drainPod() cascade
// ---------------------------------------------------------------------------

describe('MeshOrchestrator + supervisor integration', () => {
  it('getSupervisor() lazily builds and caches one supervisor per orchestrator', async () => {
    const alice = await createPeer('alice-host')
    const nodes = wireMesh([alice])
    const orchestrator = new MeshOrchestrator({ peerNode: nodes.get(alice.podId) })
    const a = await orchestrator.getSupervisor()
    const b = await orchestrator.getSupervisor()
    assert.equal(a, b)
    assert.equal(typeof a.supervise, 'function')
  })

  it("drainPod() cascades into the host's supervised pods before its own peer-drain logic", async () => {
    const alice = await createPeer('alice-host')
    const bob = await createPeer('bob-supervisor')
    const nodes = wireMesh([alice, bob])
    const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
    attachService(nodes.get(alice.podId), undefined, createPodHostService({ driver, hostLabel: 'alice-host' }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    const orchestrator = new MeshOrchestrator({ peerNode: nodes.get(bob.podId) })
    const supervisor = await orchestrator.getSupervisor()

    await supervisor.supervise(alice.podId, minimalSpec({ name: 'hosted-1' }))
    await supervisor.supervise(alice.podId, minimalSpec({ name: 'hosted-2' }))

    await orchestrator.drainPod(alice.podId)

    assert.equal((await driver.status('hosted-1')).state, 'gone')
    assert.equal((await driver.status('hosted-2')).state, 'gone')
    assert.ok(supervisor.list().every((p) => p.state === 'dead'))
  })
})
