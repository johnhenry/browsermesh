/**
 * wsh services on a pod, permitted by the pod's REAL PeerRegistry: a stock wsh client (the real `WshClient`)
 * uses the pod's objects and MCP tools through an in-process pipe relay. The transport package tests the
 * services against a stand-in registry; this proves the same grants through `grantCapabilities`,
 * `revokeCapabilities` and expiry. Design: docs/design/wsh-services-on-a-pod.md.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/wsh-services.test.mjs
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { WshServices, servicesRendezvousId, podIdToFingerprint, podIdFromRawKey } from '@johnhenry/browsermesh-transport/wsh'
import { createInProcessPipeRelay } from '@johnhenry/browsermesh-transport/wsh-in-process'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { fakeClock } from './helpers/fake-clock.mjs'

const RELAY = 'wss://relay.invalid'
const { WshClient, WebSocketTransport, generateKeyPair } = await import('@johnhenry/wsh')
const { openObjects, get } = await import('@johnhenry/wsh/objects')

const cleanups = []
afterEach(async () => { while (cleanups.length) { try { await cleanups.pop()() } catch { /* best effort */ } } })

async function waitFor(fn, what, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out waiting for: ${what}`)
}

async function world() {
  const clock = fakeClock()
  const env = await createInProcessPipeRelay()
  cleanups.push(() => env.close())
  const identity = await PodIdentity.generate()
  const registry = new PeerRegistry({ localPodId: identity.podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: identity.podId }), clock })
  const ran = []
  const app = { title: 'inbox', secret: 'no' }
  const audit = []
  const services = new WshServices({
    identity,
    relays: [RELAY],
    WebSocket: env.WebSocket,
    registry,
    unattended: true,
    mcp: { allow: ['echo'], tools: [{ name: 'echo', description: 'echoes', annotations: { readOnlyHint: true }, execute: async (i) => { ran.push(i); return `echo ${i.text ?? ''}` } }] },
    objects: { roots: { app }, allow: { get: ['app.title'] } },
    onAudit: (e) => audit.push(e),
    reconnect: { baseMs: 5, maxMs: 25 },
  })
  cleanups.push(() => services.stop())
  await services.start()
  const rid = await servicesRendezvousId(identity.podId)
  const stock = async () => {
    const keyPair = await generateKeyPair()
    const podId = await podIdFromRawKey(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)))
    const client = new WshClient({ transportFactories: { ws: () => new WebSocketTransport({ WebSocket: env.WebSocket }), wt: () => { throw new Error('no') } } })
    cleanups.push(() => client.disconnect().catch(() => {}))
    const login = () => client.connect(`${RELAY}/r/${rid}`, { username: 'operator', keyPair, transport: 'ws', expectHostKey: podIdToFingerprint(identity.podId), sealSession: true, requireChannelBinding: true, timeout: 4000 })
    return { client, podId, login, keyPair }
  }
  return { clock, identity, registry, services, ran, audit, stock }
}

describe('wsh services against the real PeerRegistry', () => {
  it('a key is admitted only by a registry grant, and the grants scope what it can reach', async () => {
    const w = await world()
    const s = await w.stock()
    await assert.rejects(s.login(), undefined, 'no grant: refused')
    w.registry.grantCapabilities(s.podId, ['wsh-services:open', 'protocol:mcp:open', 'mcp:echo:list', 'mcp:echo:call', 'protocol:objects:open', 'objects:app:get'])
    const again = await w.stock()
    w.registry.grantCapabilities(again.podId, ['wsh-services:open', 'protocol:mcp:open', 'mcp:echo:list', 'mcp:echo:call', 'protocol:objects:open', 'objects:app:get'])
    await again.login()
    const mcp = await again.client.openRpc('mcp')
    assert.deepEqual((await mcp.request('tools/list', {})).tools.map((t) => t.name), ['echo'])
    assert.equal((await mcp.request('tools/call', { name: 'echo', arguments: { text: 'hi' } })).content[0].text, 'echo hi')
    const { app } = await openObjects(again.client)
    assert.equal(await app.title, 'inbox')
    await assert.rejects(async () => get(app, 'secret'))
  })

  it('revokeCapabilities ends the session at once', async () => {
    const w = await world()
    const s = await w.stock()
    w.registry.grantCapabilities(s.podId, ['wsh-services:open', 'protocol:mcp:open', 'mcp:echo:call'])
    await s.login()
    const mcp = await s.client.openRpc('mcp')
    await mcp.request('tools/call', { name: 'echo', arguments: {} })
    w.registry.revokeCapabilities(s.podId, ['wsh-services:open'])
    await waitFor(() => w.services.sessions.length === 0, 'the session to end')
    await assert.rejects(mcp.request('tools/call', { name: 'echo', arguments: {} }))
    assert.equal(w.ran.length, 1)
    assert.ok(w.audit.some((e) => e.event === 'session-close' && e.reason === 'revoked'))
  })

  it('a grant that expires ends the session when it expires', async () => {
    const w = await world()
    const s = await w.stock()
    w.registry.grantCapabilities(s.podId, ['wsh-services:open'], { expiresAt: w.clock.now() + 1000 })
    await s.login()
    await waitFor(() => w.services.sessions.length === 1, 'the session')
    w.clock.advance(1000)
    await waitFor(() => w.services.sessions.length === 0, 'the session to end at expiry')
    const late = await w.stock()
    await assert.rejects(late.login())
  })

  it('a mesh grant is not a services grant', async () => {
    const w = await world()
    const s = await w.stock()
    w.registry.grantCapabilities(s.podId, ['mesh:link:connect', 'protocol:mcp:open', 'mcp:*:call'])
    await assert.rejects(s.login())
  })
})
