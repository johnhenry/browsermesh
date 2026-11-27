/**
 * wsh-relay.test.mjs -- `--wsh-relay <url>`: meshctl reaches a host through a
 * pipe relay over a sealed, key-authenticated wsh link (the transport package's
 * `WshPeerLinks`), with no WebRTC and no signalling server needed.
 *
 * The relay here is the transport package's in-process pipe relay (the real wsh
 * pipe relay and the real wsh handshake, no network), the host is a real
 * `PeerNode` serving the pod-host service over a real `WshPeerLinks`, and the
 * client side is the real `createRealMeshSession()` and `main()`. The relay
 * records every byte it carries, which is how the tests look at what it can see.
 */

import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL,
} from '@johnhenry/browsermesh-core'
import {
  PeerNode, PeerRegistry, attachService, createPodHostService, createWshAuthorizer, attachWshLinks,
  DEFAULT_POD_HOST_RESOURCE,
} from '@johnhenry/browsermesh-apps'
import { InMemoryPodHostDriver, POD_LANE, POD_HOST_VERBS } from '@johnhenry/browsermesh-pod'
import { MeshTransportNegotiator } from '@johnhenry/browsermesh-transport'
import { WshPeerLinks } from '@johnhenry/browsermesh-transport/wsh'
import { createInProcessPipeRelay } from '@johnhenry/browsermesh-transport/wsh-in-process'
import { createRealMeshSession } from '../src/real-mesh.mjs'
import { buildTestIdentity, runCli } from './helpers.mjs'
import { SignalingDouble, createDoubleNetwork } from '../../../tests/support/signaling-double.mjs'

const RELAY = 'wss://relay.invalid/'
const SECRET_POD_NAME = 'name-the-relay-must-not-read'

/** A pod that serves the pod-host service, listens on the relay, and lets `clientPodId` link and call it. */
async function startHost(env, { clientPodId, allowLink = true, grant = true, label = 'wsh-host' } = {}) {
  const identityManager = new MeshIdentityManager({})
  const wallet = new IdentityWallet({ identityManager })
  const { podId } = await wallet.createIdentity(label)
  const registry = new PeerRegistry({
    localPodId: podId,
    peerManager: new MeshPeerManager({}),
    trustGraph: new TrustGraph(),
    acl: new MeshACL({ owner: podId }),
  })
  const negotiator = new MeshTransportNegotiator()
  const node = new PeerNode({ wallet, registry, transportNegotiator: negotiator })
  await node.boot({ skipDiscovery: true })
  const links = new WshPeerLinks({
    identity: identityManager.getIdentity(podId),
    relays: [RELAY],
    WebSocket: env.WebSocket,
    authorize: createWshAuthorizer(registry),
    reconnect: { baseMs: 5, maxMs: 25 },
    connectTimeoutMs: 3000,
  })
  attachWshLinks({ node, links, negotiator })
  await links.listen()
  const driver = new InMemoryPodHostDriver({ lane: POD_LANE.ISOLATE })
  const handle = attachService(node, undefined, createPodHostService({ driver, hostLabel: label }))
  if (allowLink) registry.grantCapabilities(clientPodId, ['mesh:link:connect'])
  if (grant) {
    registry.grantCapabilities(clientPodId, POD_HOST_VERBS.map((verb) => `${DEFAULT_POD_HOST_RESOURCE}:${verb}`))
  }
  return {
    podId, links, driver, node,
    async close() {
      await handle.teardown()
      await links.close()
      await node.shutdown()
    },
  }
}

describe('--wsh-relay: a sealed link through a relay', () => {
  /** @type {Array<() => Promise<void>>} */
  const cleanups = []
  after(async () => { for (const fn of cleanups.reverse()) await fn() })

  async function setup(hostOptions = {}) {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const { cliIdentity, identityPath, cleanup } = await buildTestIdentity()
    cleanups.push(cleanup)
    const host = await startHost(env, { clientPodId: cliIdentity.podId, ...hostOptions })
    cleanups.push(() => host.close())
    return { env, host, cliIdentity, identityPath }
  }

  it('reaches a host with no signalling server and no WebRTC: describe, spawn and status answer over the link', async () => {
    const { env, host, cliIdentity } = await setup()
    const session = await createRealMeshSession({
      cliIdentity, wshRelays: [RELAY], WebSocketCtor: env.WebSocket, timeoutMs: 3000,
    })
    cleanups.push(session.close)

    await session.ensureConnected(host.podId)
    const description = await session.client.describe(host.podId)
    assert.equal(description.lane, POD_LANE.ISOLATE)

    await session.client.spawn(host.podId, { name: 'p1', lane: POD_LANE.ISOLATE, run: { kind: 'module', ref: 'x' } })
    assert.ok((await session.client.status(host.podId, 'p1')).state)
    assert.equal(host.links.linkInfo(cliIdentity.podId).sealed, true)
  })

  it('the relay carries ciphertext only: a pod name sent over the link is not in any byte it copied', async () => {
    const { env, host, cliIdentity } = await setup()
    const session = await createRealMeshSession({
      cliIdentity, wshRelays: [RELAY], WebSocketCtor: env.WebSocket, timeoutMs: 3000,
    })
    cleanups.push(session.close)
    await session.ensureConnected(host.podId)
    await session.client.spawn(host.podId, { name: SECRET_POD_NAME, lane: POD_LANE.ISOLATE, run: { kind: 'module', ref: 'x' } })

    assert.equal((await session.client.list(host.podId)).some((p) => p.name === SECRET_POD_NAME), true, 'the host got the name')
    assert.ok(env.recorded.length > 0, 'the relay carried the link')
    const needle = Buffer.from(SECRET_POD_NAME)
    for (const { bytes } of env.recorded) {
      assert.equal(Buffer.from(bytes).includes(needle), false, 'the relay saw the pod name in the clear')
    }
  })

  it('a host that has not allowed this identity to link refuses it by name, and the CLI exits 3 (EACCES)', async () => {
    const { env, host, cliIdentity, identityPath } = await setup({ allowLink: false })
    const session = await createRealMeshSession({
      cliIdentity, wshRelays: [RELAY], WebSocketCtor: env.WebSocket, timeoutMs: 3000,
    })
    cleanups.push(session.close)
    await assert.rejects(session.ensureConnected(host.podId), (e) => e.code === 'WSH_REFUSED')
    assert.equal(host.links.isConnected(cliIdentity.podId), false)

    const { code, stderr } = await runCli(
      ['host', 'describe', host.podId, '--wsh-relay', RELAY, '--identity', identityPath, '--timeout', '3000', '--quiet'],
      { WebSocketCtor: env.WebSocket },
    )
    assert.equal(code, 3)
    assert.equal(JSON.parse(stderr).error.code, 'WSH_REFUSED')
  })

  it('a link that cannot be made is an error, never a session with no transport behind it', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const { cliIdentity, cleanup } = await buildTestIdentity()
    cleanups.push(cleanup)
    const session = await createRealMeshSession({
      cliIdentity, wshRelays: [RELAY], WebSocketCtor: env.WebSocket, timeoutMs: 500,
      wsh: { connectTimeoutMs: 300 },
    })
    cleanups.push(session.close)
    // A well-formed pod id that nothing is listening for on the relay.
    const absent = (await buildTestIdentity())
    cleanups.push(absent.cleanup)
    await assert.rejects(session.ensureConnected(absent.cliIdentity.podId), (e) => e.code === 'WSH_UNREACHABLE')
    assert.equal(session.peerNode.hasActiveSession(absent.cliIdentity.podId), false)
  })

  it('--timeout bounds the dial too: a host nobody is listening for fails with WSH_UNREACHABLE within it, not after the link layer\'s 15 s default (#431)', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const { cliIdentity, cleanup } = await buildTestIdentity()
    cleanups.push(cleanup)
    // No `wsh: { connectTimeoutMs }` override: only the session's own timeout.
    const session = await createRealMeshSession({ cliIdentity, wshRelays: [RELAY], WebSocketCtor: env.WebSocket, timeoutMs: 700 })
    cleanups.push(session.close)
    const absent = await buildTestIdentity()
    cleanups.push(absent.cleanup)
    const t0 = Date.now()
    await assert.rejects(session.ensureConnected(absent.cliIdentity.podId), (e) => e.code === 'WSH_UNREACHABLE')
    assert.ok(Date.now() - t0 < 700 + 800, `gave up after ${Date.now() - t0} ms, --timeout was 700`)
  })

  it('when every transport fails the connect fails with the reason, not a session with no transport (also without --wsh-relay)', async () => {
    const net = createDoubleNetwork()
    net.add('ws://signal.test', new SignalingDouble({ mode: 'open' }))
    const { cliIdentity, cleanup } = await buildTestIdentity()
    cleanups.push(cleanup)
    const session = await createRealMeshSession({
      cliIdentity, signalingUrl: 'ws://signal.test', WebSocketCtor: net.WebSocket, timeoutMs: 1000, signalingChallengeWaitMs: 5,
    })
    cleanups.push(session.close)
    session.peerNode.transportNegotiator.registerAdapter('webrtc', async () => { throw new Error('ice failed') })
    await assert.rejects(session.ensureConnected('some-host'), (e) => e.code === 'ECONNECT' && /ice failed/.test(e.message))
    assert.equal(session.peerNode.hasActiveSession('some-host'), false)
  })

  it('the whole CLI path: `hosts --wsh-relay` with a --host lists it, with no --signaling at all', async () => {
    const { env, host, identityPath } = await setup()
    const { code, stdout } = await runCli(
      ['hosts', '--wsh-relay', RELAY, '--host', host.podId, '--identity', identityPath, '--timeout', '3000', '--quiet'],
      { WebSocketCtor: env.WebSocket },
    )
    assert.equal(code, 0)
    const result = JSON.parse(stdout).result
    assert.equal(JSON.stringify(result).includes(host.podId), true)
  })

  it('with --signaling as well, the sealed link is tried first and is the one used', async () => {
    const { env, host, cliIdentity } = await setup()
    const net = createDoubleNetwork()
    net.add('ws://signal.test', new SignalingDouble({ mode: 'open' }))
    // One WebSocket constructor for both servers: the relay's for the relay URL, the double's for signalling.
    const WebSocketCtor = function WebSocketCtor(url, ...rest) {
      return String(url).startsWith('ws://signal.test') ? new net.WebSocket(url, ...rest) : new env.WebSocket(url, ...rest)
    }
    const session = await createRealMeshSession({
      cliIdentity, signalingUrl: 'ws://signal.test', wshRelays: [RELAY], WebSocketCtor, timeoutMs: 3000,
      signalingChallengeWaitMs: 5,
    })
    cleanups.push(session.close)
    await session.ensureConnected(host.podId)
    assert.equal(host.links.isConnected(cliIdentity.podId), true)
    await session.client.describe(host.podId)
  })

  it('is refused together with --loopback, and a relay that is not a ws(s) URL is a usage error', async () => {
    const { identityPath, cleanup } = await buildTestIdentity()
    cleanups.push(cleanup)
    let r = await runCli(['hosts', '--loopback', '--wsh-relay', RELAY, '--identity', identityPath, '--quiet'])
    assert.equal(r.code, 2)
    r = await runCli(['hosts', '--wsh-relay', 'not a url', '--host', 'x', '--identity', identityPath, '--quiet'])
    assert.equal(r.code, 2)
    assert.equal(JSON.parse(r.stderr).error.code, 'EUSAGE')
    r = await runCli(['hosts', '--wsh-relay', 'ftp://relay.invalid/', '--host', 'x', '--identity', identityPath, '--quiet'])
    assert.equal(r.code, 2)
  })
})
