/**
 * browser-lane.test.mjs -- the browser lane's in-page `PodHostDriver`
 * (`@johnhenry/browsermesh-pod`'s `createInPageDriver()`) attached to
 * `createPodHostService()` on a real `PeerNode`-shaped mesh (issue #185
 * item 7, deliverable A).
 *
 * `pod-host-service.test.mjs` already covers the service generically
 * against `InMemoryPodHostDriver`; this file's job is narrower and
 * specific to the browser lane: that the IN-PAGE driver -- a real driver
 * with a real (fake-DOM-backed) state machine, not the reference
 * in-memory one -- plugs into the same gated/audited service exactly like
 * any other lane's driver, including its lane-specific refusals (`exec`
 * ELANE at the service's static lane gate is NOT what happens here --
 * browser-lane `exec` is lane-CAPABLE since issue #185 item 7, so an
 * in-page driver that does not implement it answers `ENOTSUP`, and
 * `snapshot`/`restore` stay `ELANE` because the lane itself excludes them).
 *
 * Setup follows the same real-Ed25519-identity pattern as
 * `pod-host-service.test.mjs` (`createPeer`/`wireMesh`), duplicated rather
 * than imported -- these test files do not share internals by design.
 */

import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'
import {
  bootHostedPod,
  createInPageDriver,
  POD_HOST_ERROR,
  POD_LANE,
  POD_LIFECYCLE,
} from '@johnhenry/browsermesh-pod'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import {
  createPodHostService,
  createPodHostClient,
  DEFAULT_POD_HOST_RESOURCE,
} from '../src/pod-host-service.mjs'

const RESOURCE = DEFAULT_POD_HOST_RESOURCE
const ALL_SCOPES = [
  'spawn', 'status', 'send', 'exec', 'snapshot', 'restore', 'drain', 'list',
].map((verb) => `${RESOURCE}:${verb}`)

/** A real Ed25519 identity + wallet + registry bundle for one "peer" (same shape pod-host-service.test.mjs uses). */
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

/** A minimal duck-typed `PeerNode` mesh (same shape pod-host-service.test.mjs uses). */
function wireMesh(peers) {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()
  /** @type {Map<string, object>} */
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

// ---------------------------------------------------------------------------
// Fake browser harness (same approach as @johnhenry/browsermesh-pod's
// browser-host-driver.test.mjs): a fake BroadcastChannel bus plus a fake
// `document`/`Worker` that really boot a Pod (via `bootHostedPod()`) for
// every spawned child, so the driver attached here runs its real state
// machine end to end, not a stub.
// ---------------------------------------------------------------------------

function makeBus() {
  /** @type {Map<string, Set<object>>} */
  const channels = new Map()
  class StubBroadcastChannel {
    constructor(name) {
      this.name = name
      this.onmessage = null
      this._closed = false
      if (!channels.has(name)) channels.set(name, new Set())
      channels.get(name).add(this)
    }
    postMessage(data) {
      if (this._closed) return
      const peers = channels.get(this.name)
      if (!peers) return
      for (const ch of peers) {
        if (ch !== this && !ch._closed && ch.onmessage) {
          const copy = JSON.parse(JSON.stringify(data))
          Promise.resolve().then(() => { if (ch.onmessage) ch.onmessage({ data: copy }) })
        }
      }
    }
    close() {
      this._closed = true
      channels.get(this.name)?.delete(this)
    }
  }
  return StubBroadcastChannel
}

const FAST_BOOT = { handshakeTimeout: 5, discoveryTimeout: 5 }

function makeBrowserHarness() {
  const BC = makeBus()
  /** @type {Promise<*>[]} */
  const pendingBoots = []

  function makeChildGlobal(name, href) {
    /** @type {{type: string, fn: Function}[]} */
    const listeners = []
    const g = {
      name,
      location: { href, hash: href.slice(href.indexOf('#')) },
      document: { title: '', body: { appendChild() {} }, querySelector: () => null },
      BroadcastChannel: BC,
      addEventListener(type, fn) { listeners.push({ type, fn }) },
      removeEventListener(type, fn) {
        const i = listeners.findIndex((l) => l.type === type && l.fn === fn)
        if (i !== -1) listeners.splice(i, 1)
      },
      postMessage(data) {
        for (const { type, fn } of [...listeners]) if (type === 'message') fn({ data })
      },
    }
    g.window = g
    g.parent = { postMessage() {} } // always "framed" -> kind 'iframe'
    return g
  }

  function fakeIframe() {
    const el = {
      name: '',
      _src: '',
      removed: false,
      contentWindow: null,
      get src() { return this._src },
      set src(url) {
        this._src = url
        const childGlobal = makeChildGlobal(el.name, url)
        el.contentWindow = childGlobal
        pendingBoots.push(bootHostedPod({ globalThis: childGlobal, ...FAST_BOOT }))
      },
      remove() { el.removed = true },
    }
    return el
  }

  const document = {
    body: { appendChild() {} },
    createElement(tag) {
      assert.equal(tag, 'iframe')
      return fakeIframe()
    },
  }

  return {
    BC,
    globalThis: { document, BroadcastChannel: BC },
    async flush() {
      await Promise.all(pendingBoots.splice(0))
      await new Promise((resolve) => setTimeout(resolve, 10))
    },
  }
}

function browserSpec(overrides = {}) {
  return { name: 'tab-pod', lane: POD_LANE.BROWSER, run: { kind: 'module', ref: 'pod-page' }, ...overrides }
}

// ---------------------------------------------------------------------------

describe('browser lane: in-page driver over createPodHostService', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let nodes
  /** @type {any} */ let handle
  /** @type {any} */ let client
  /** @type {any} */ let harness
  /** @type {any} */ let driver

  function setup() {
    harness = makeBrowserHarness()
    driver = createInPageDriver({
      globalThis: harness.globalThis,
      podUrl: 'https://pods.example/child.html',
      BCConstructor: harness.BC,
      timeoutMs: 1000,
    })
    handle = attachService(nodes.get(alice.podId), undefined, createPodHostService({ driver, hostLabel: 'alice-browser-host' }))
    alice.registry.grantCapabilities(bob.podId, ALL_SCOPES)
    client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })
  }

  afterEach(() => {
    if (driver) driver.close()
  })

  it('spawns a browser-lane pod on the host from a remote requester', async () => {
    alice = await createPeer('alice-browser-host')
    bob = await createPeer('bob-requester')
    nodes = wireMesh([alice, bob])
    setup()

    const spawnPromise = client.spawn(alice.podId, browserSpec())
    await harness.flush()
    const spawned = await spawnPromise
    assert.equal(spawned.name, 'tab-pod')
    assert.equal(spawned.lane, POD_LANE.BROWSER)
    assert.equal(spawned.state, POD_LIFECYCLE.REGISTERED)
    assert.ok(spawned.podId)

    const status = await client.status(alice.podId, 'tab-pod')
    assert.equal(status.state, POD_LIFECYCLE.REGISTERED)

    const sent = await client.send(alice.podId, 'tab-pod', { hi: true })
    assert.equal(sent.delivered, true)

    const list = await client.list(alice.podId)
    assert.deepEqual(list.map((p) => p.name), ['tab-pod'])

    const drained = await client.drain(alice.podId, 'tab-pod')
    assert.equal(drained.state, POD_LIFECYCLE.GONE)
  })

  it('describe() advertises the browser lane, exec capability, and no shell backend', async () => {
    alice = await createPeer('alice-browser-host')
    bob = await createPeer('bob-requester')
    nodes = wireMesh([alice, bob])
    setup()

    const description = await client.describe(alice.podId)
    assert.equal(description.lane, POD_LANE.BROWSER)
    assert.deepEqual(description.runtimeClasses, [POD_LANE.BROWSER])
    assert.equal(description.shellBackend, null)
    assert.deepEqual(description.deploymentSupport, { canDeploy: true })
    // The in-page driver does not implement exec, so it is absent here even
    // though the lane itself is exec-capable (see host-protocol.mjs).
    assert.ok(!description.verbs.includes('exec'))
    assert.ok(!description.capabilities.includes('exec'))
  })

  it("exec through the service is ENOTSUP (driver gap), not ELANE (the lane allows it)", async () => {
    alice = await createPeer('alice-browser-host')
    bob = await createPeer('bob-requester')
    nodes = wireMesh([alice, bob])
    setup()

    const spawnPromise = client.spawn(alice.podId, browserSpec())
    await harness.flush()
    await spawnPromise

    await assert.rejects(client.exec(alice.podId, 'tab-pod', ['1+1']), (err) => {
      assert.equal(err.code, POD_HOST_ERROR.ENOTSUP)
      return true
    })
  })

  it('snapshot/restore through the service are ELANE (the browser lane excludes them)', async () => {
    alice = await createPeer('alice-browser-host')
    bob = await createPeer('bob-requester')
    nodes = wireMesh([alice, bob])
    setup()

    const spawnPromise = client.spawn(alice.podId, browserSpec())
    await harness.flush()
    await spawnPromise

    await assert.rejects(client.snapshot(alice.podId, 'tab-pod'), (err) => err.code === POD_HOST_ERROR.ELANE)
    await assert.rejects(client.restore(alice.podId, 'tab-pod'), (err) => err.code === POD_HOST_ERROR.ELANE)
  })

  it('a stranger with no grant is denied EACCES', async () => {
    alice = await createPeer('alice-browser-host')
    bob = await createPeer('bob-requester')
    nodes = wireMesh([alice, bob])
    harness = makeBrowserHarness()
    driver = createInPageDriver({
      globalThis: harness.globalThis,
      podUrl: 'https://pods.example/child.html',
      BCConstructor: harness.BC,
      timeoutMs: 1000,
    })
    attachService(nodes.get(alice.podId), undefined, createPodHostService({ driver }))
    // No grantCapabilities() call this time.
    client = createPodHostClient({ peerNode: nodes.get(bob.podId), timeoutMs: 1000 })

    await assert.rejects(client.spawn(alice.podId, browserSpec()), (err) => err.code === POD_HOST_ERROR.EACCES)
  })

  it('forwards driver lifecycle/exit events to the requester that spawned the pod', async () => {
    alice = await createPeer('alice-browser-host')
    bob = await createPeer('bob-requester')
    nodes = wireMesh([alice, bob])
    setup()

    /** @type {object[]} */
    const received = []
    client.onEvent((hostPubKey, event) => received.push({ hostPubKey, event }))

    const spawnPromise = client.spawn(alice.podId, browserSpec())
    await harness.flush()
    await spawnPromise
    await client.drain(alice.podId, 'tab-pod')
    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.ok(received.length > 0)
    assert.ok(received.every((entry) => entry.hostPubKey === alice.podId))
    const kinds = new Set(received.map((entry) => entry.event.kind))
    assert.ok(kinds.has('lifecycle'))
    assert.ok(kinds.has('exit'))
  })
})
