// Item 5 of #379: opening the link fails in several ways, and a page has to tell the person which. Each is a code on EgressError.
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MeshChannelError, ChannelErrorCode } from '@johnhenry/browsermesh-apps/mesh-channel'
import { connectEgress, createMeshEgress, EgressError, LINK_CODES } from '../src/index.mjs'
import { threePods, grant, echoOrigin, simNetwork, PUBLIC } from './helpers/mesh.mjs'

const cleanups = []
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c() })
const code = (c) => (e) => e instanceof EgressError && e.code === c
const POD = 'P'.repeat(43)

/** A service whose open fails with exactly `error`. */
const failing = (error) => ({ api: { openProtocol: async () => { throw error } } })
const channelError = (c, reason) => new MeshChannelError(c, reason, reason)

describe('what an open that fails is called', () => {
  const table = [
    ['the provider has not granted this pod the protocol', channelError(ChannelErrorCode.UNAUTHORIZED, 'not-authorized'), 'provider-not-authorized'],
    ['the provider does not serve the protocol', channelError(ChannelErrorCode.METHOD_NOT_FOUND, 'unknown-protocol'), 'provider-no-egress'],
    ['the pod runs no channel service', channelError(ChannelErrorCode.UNSUPPORTED, 'unsupported'), 'provider-no-egress'],
    ['no common version of the protocol', channelError(ChannelErrorCode.UNSUPPORTED, 'unsupported-version'), 'provider-version'],
    ['the channel service refused the link', channelError(ChannelErrorCode.BUSY, 'refused'), 'provider-refused'],
    ['the channel service holds as many links as it takes', channelError(ChannelErrorCode.BUSY, 'too-many-peers'), 'provider-refused'],
    ['the provider did not answer in time', channelError(ChannelErrorCode.CANCELLED, 'timeout'), 'provider-timeout'],
    ['the caller cancelled', channelError(ChannelErrorCode.CANCELLED, 'cancelled'), 'aborted'],
    ['the mesh has no session to the pod', new Error('PeerNode.sendTo: no active session for pubKey abc'), 'provider-not-found'],
    ['the session has no transport (it was never negotiated)', new Error('PeerNode.sendTo: session for abc has no transport.send'), 'provider-not-found'],
    ['something this package has no name for', new Error('weird'), 'provider-unreachable'],
  ]
  for (const [what, error, expected] of table) {
    it(`${what}: ${expected}`, async () => {
      await assert.rejects(connectEgress(failing(error), POD), code(expected))
    })
  }

  it('an EgressError from below is passed on as it is', async () => {
    const e = new EgressError('signalling-unreachable')
    await assert.rejects(connectEgress(failing(e), POD), (got) => got === e)
  })

  it('every code is a documented link code', () => {
    for (const c of ['provider-not-found', 'provider-refused', 'signalling-unreachable', 'provider-no-egress', 'provider-version', 'provider-timeout', 'provider-not-authorized', 'provider-unreachable', 'provider-gone']) assert.ok(Object.hasOwn(LINK_CODES, c), c)
  })
})

describe('the same failures over a real channel', () => {
  it('a provider that serves only another version: provider-version', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const stop = pods.p.api.serveProtocol('egress', () => {}, { versions: [2] })
    cleanups.push(() => stop())
    grant(pods, [])
    await assert.rejects(connectEgress(pods.c, pods.provider.podId), code('provider-version'))
  })

  it('a channel service that takes no peer: provider-refused', async () => {
    const pods = await threePods({ channelOptions: { acceptPeer: () => false } })
    cleanups.push(() => pods.teardown())
    grant(pods, [])
    await assert.rejects(connectEgress(pods.c, pods.provider.podId), code('provider-refused'))
  })

  it('a pod id nobody answers to: provider-not-found', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    await assert.rejects(connectEgress(pods.c, POD), code('provider-not-found'))
  })

  it('a provider that does not grant the protocol, and one that is not serving it, keep their codes', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    const origin = await echoOrigin()
    cleanups.push(() => origin.close())
    const net = simNetwork({ names: { 'pkg.test': [PUBLIC] }, origins: { [`${PUBLIC}:443`]: origin.port } })
    const egress = createMeshEgress({ service: pods.p, registry: pods.provider.registry, dial: net.dial, resolve: net.resolve, unattended: true })
    egress.start()
    cleanups.push(() => egress.stop())
    await assert.rejects(connectEgress(pods.c, pods.provider.podId), code('provider-not-authorized'))
    const fresh = await threePods()
    cleanups.push(() => fresh.teardown())
    grant(fresh, [])
    await assert.rejects(connectEgress(fresh.c, fresh.provider.podId), code('provider-no-egress'))
  })

  it('a provider that stops answering after the channel is up: provider-timeout', async () => {
    let dark = false
    const pods = await threePods({ deliver: (fn) => { if (!dark) queueMicrotask(fn) } })
    cleanups.push(() => pods.teardown())
    grant(pods, [])
    // the channel service's hello is done, then the provider goes silent before the open is answered
    await pods.c.api.channel.open(pods.provider.podId)
    dark = true
    await assert.rejects(connectEgress(pods.c, pods.provider.podId, { limits: { openTimeoutMs: 50 } }), code('provider-timeout'))
  })

  it('a signal aborted while opening: aborted', async () => {
    const pods = await threePods()
    cleanups.push(() => pods.teardown())
    grant(pods, [])
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(connectEgress(pods.c, pods.provider.podId, { signal: ac.signal }), code('aborted'))
  })
})
