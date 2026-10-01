/**
 * loopback.mjs — the `--loopback` connection mode: an in-process mesh with
 * no network, no signaling server, and no real transport at all.
 *
 * This is `examples/13-pod-host-service.mjs`'s pattern (real Ed25519
 * identities, real `PeerNode`s, linked by a minimal in-memory duplex
 * "transport" standing in for WebRTC/relay) generalized from one host to
 * `N` hosts, and wrapped so `meshctl` itself is one of the peers rather
 * than a test harness driving two others. It exists for exactly what the
 * design doc says: tests, examples, and local development, where spinning
 * up a signaling server and real WebRTC is pure friction to see the eight
 * verbs work end to end.
 *
 * Every loopback host runs `InMemoryPodHostDriver` (`@johnhenry/
 * browsermesh-pod`) and grants `meshctl`'s identity every verb its lane
 * supports, so `--loopback` never itself produces an `EACCES` -- the whole
 * point is exercising the verb set, not re-deriving the access-control
 * suite `pod-host-service.test.mjs` already owns.
 */

import {
  IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL,
} from '@johnhenry/browsermesh-core'
import {
  PeerNode, PeerRegistry, attachService, createPodHostService, createPodHostClient,
  DEFAULT_POD_HOST_RESOURCE,
} from '@johnhenry/browsermesh-apps'
import { InMemoryPodHostDriver, POD_LANE, POD_HOST_VERBS } from '@johnhenry/browsermesh-pod'
import { withSupervisor } from './session-supervisor.mjs'

/** Default hosts a bare `--loopback` run spins up: one per shell-capable lane plus one without. */
export const DEFAULT_LOOPBACK_HOSTS = Object.freeze([
  Object.freeze({ label: 'isolate-host', lane: POD_LANE.ISOLATE }),
  Object.freeze({ label: 'node-host', lane: POD_LANE.NODE }),
])

/**
 * @param {string} label
 * @returns {Promise<{podId: string, wallet: InstanceType<typeof IdentityWallet>, registry: InstanceType<typeof PeerRegistry>}>}
 */
async function createEphemeralPeer(label) {
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
 * Link two booted `PeerNode`s with a minimal in-memory duplex bus -- same
 * helper as `examples/13-pod-host-service.mjs`'s `linkRealNodes()`.
 *
 * @param {InstanceType<typeof PeerNode>} nodeA
 * @param {InstanceType<typeof PeerNode>} nodeB
 */
async function linkNodes(nodeA, nodeB) {
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
  await nodeA.adoptIncomingSession(nodeB.podId, transportForA, 'loopback')
  await nodeB.adoptIncomingSession(nodeA.podId, transportForB, 'loopback')
}

/**
 * @typedef {object} LoopbackHost
 * @property {string} label
 * @property {string} lane
 * @property {string} podId
 * @property {InstanceType<typeof PeerNode>} node
 * @property {{api: object, teardown: Function}} handle
 */

/**
 * Boot `meshctl`'s own `PeerNode` plus `hosts.length` in-process hosts, all
 * linked to it (not to each other -- `meshctl` is the only peer that needs
 * to reach every host).
 *
 * @param {object} opts
 * @param {{podId: string, wallet: InstanceType<typeof IdentityWallet>}} opts.cliIdentity
 *   `meshctl`'s own identity -- see `identity.mjs`'s `loadOrCreateIdentity()`.
 * @param {{label: string, lane: string, grant?: boolean, attach?: boolean}[]} [opts.hosts]
 *   `grant` (default `true`) and `attach` (default `true`) exist for tests
 *   exercising the paths a fully-granted, fully-attached demo host never
 *   hits: `grant: false` links a host that never grants `meshctl`'s
 *   identity anything, so a verb against it comes back `EACCES` --
 *   exactly `test/exit-codes.test.mjs`'s path for that code. `attach:
 *   false` links a host with NO pod-host service listening at all, so a
 *   request to it gets no response ever -- the `ETIMEDOUT` path, which a
 *   real but unresponsive/overloaded host would also produce. Neither
 *   knob is reachable from a CLI flag; production `--loopback` always
 *   gets `DEFAULT_LOOPBACK_HOSTS`' defaults.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<MeshctlSession>} see `connect.mjs`'s `MeshctlSession` typedef
 */
export async function createLoopbackSession({ cliIdentity, hosts = DEFAULT_LOOPBACK_HOSTS, timeoutMs } = {}) {
  const cliRegistry = new PeerRegistry({
    localPodId: cliIdentity.podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: cliIdentity.podId }),
  })
  const cliPeerNode = new PeerNode({ wallet: cliIdentity.wallet, registry: cliRegistry })
  await cliPeerNode.boot()

  /** @type {LoopbackHost[]} */
  const hostRecords = []
  for (const spec of hosts) {
    const peer = await createEphemeralPeer(spec.label)
    const node = new PeerNode({ wallet: peer.wallet, registry: peer.registry })
    await node.boot()
    await linkNodes(cliPeerNode, node)

    let handle = null
    let driver = null
    if (spec.attach !== false) {
      driver = new InMemoryPodHostDriver({ lane: spec.lane })
      handle = attachService(node, undefined, createPodHostService({
        driver,
        hostLabel: spec.label,
      }))
    }
    if (spec.grant !== false) {
      peer.registry.grantCapabilities(
        cliIdentity.podId,
        POD_HOST_VERBS.map((verb) => `${DEFAULT_POD_HOST_RESOURCE}:${verb}`),
      )
    }
    hostRecords.push({ label: spec.label, lane: spec.lane, podId: peer.podId, node, handle, driver })
  }

  const client = createPodHostClient({ peerNode: cliPeerNode, timeoutMs })

  /** @param {string} ref @returns {LoopbackHost|null} */
  function resolveHost(ref) {
    return hostRecords.find((h) => h.podId === ref || h.label === ref) || null
  }

  return withSupervisor({
    mode: 'loopback',
    podId: cliIdentity.podId,
    peerNode: cliPeerNode,
    client,
    knownHosts: () => hostRecords.map((h) => h.podId),
    resolveHost,
    // Dev-only escape hatch for `meshctl pods crash` (issue #185 item 6's
    // demo path): the RAW `InMemoryPodHostDriver` behind a loopback host,
    // bypassing the gate entirely -- there is no wire verb for "crash a
    // pod", so this reaches straight past `pod-host-service.mjs` the same
    // way a real failure would (the driver itself has no gate to bypass).
    // `commands.mjs`'s `cmdPodsCrash()` refuses to call this at all in
    // `mode: 'real'` (there is no such method on that session shape).
    loopbackDriverFor(ref) {
      const host = resolveHost(ref)
      return host ? host.driver : null
    },
    // Loopback hosts are linked at connect time (see `linkNodes()` above),
    // so there is never a separate negotiation step -- unlike the real-mesh
    // session, where `ensureConnected()` actually does something.
    async ensureConnected() {},
    async close() {
      client.close()
      for (const host of hostRecords) {
        if (host.handle) await host.handle.teardown()
        await host.node.shutdown()
      }
      await cliPeerNode.shutdown()
    },
  })
}
