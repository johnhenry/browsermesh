/**
 * wsh services over a MESH protocol channel (docs/design/wsh-over-mesh.md): the real wsh client (`connectWshOverDuplex`, through
 * `connectWshServicesOverMesh`) logs in to a pod's `WshServices` over a protocol channel of the real mesh protocol service, on an
 * in-memory bus of pods with real PeerRegistries. Same grants, same sealed-only rule, the pod id pinned. A hostile hop on the
 * channel reads, alters and drops what it carries.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/wsh-services-mesh.test.mjs
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { WshServices, connectWshServicesOverMesh } from '@johnhenry/browsermesh-transport'
import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { createMeshProtocolService } from '../src/protocol-channel.mjs'

const { openObjects, get } = await import('@johnhenry/wsh/objects')
const { connectWshOverDuplex } = await import('@johnhenry/wsh/duplex')

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

/** Pods that can reach each other over a JSON bus (as a real transport carries text), each with its own PeerRegistry. */
async function pods(count) {
  const nodes = new Map()
  const out = []
  for (let i = 0; i < count; i++) {
    const identity = await PodIdentity.generate()
    const listeners = new Set()
    const node = {
      identity,
      podId: identity.podId,
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo(to, data) {
        const target = nodes.get(to)
        if (!target) throw new Error('unreachable peer')
        const text = JSON.stringify(data)
        queueMicrotask(() => { for (const cb of target.listeners) cb(identity.podId, text) })
      },
    }
    node.listeners = listeners
    node.registry = new PeerRegistry({ localPodId: identity.podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: identity.podId }) })
    node.service = attachService(node, undefined, createMeshProtocolService()).api
    nodes.set(identity.podId, node)
    out.push(node)
  }
  return out
}

const SECRET = 'SECRET-TEXT-0123456789'
const GRANTS = ['wsh-services:open', 'protocol:mcp:open', 'mcp:echo:list', 'mcp:echo:call', 'protocol:objects:open', 'objects:app:get']

/** Bob serves the services on the mesh; alice is the dialler; eve is nobody. */
async function world({ grants = ['protocol:wsh:open', ...GRANTS] } = {}) {
  const [alice, bob, eve] = await pods(3)
  const ran = []
  const audit = []
  const services = new WshServices({
    identity: bob.identity,
    registry: bob.registry,
    unattended: true,
    mcp: { allow: ['echo'], tools: [{ name: 'echo', description: 'echoes', annotations: { readOnlyHint: true }, execute: async (i) => { ran.push(i); return `echo ${i.text ?? ''}` } }] },
    objects: { roots: { app: { title: 'inbox', secret: 'no' } }, allow: { get: ['app.title'] } },
    onAudit: (e) => audit.push(e),
  })
  await services.start()
  const stop = services.serveOnMesh(bob.service)
  cleanups.push(async () => { stop(); await services.stop() })
  if (grants.length) bob.registry.grantCapabilities(alice.podId, grants)
  const creds = (pod = alice) => ({ username: 'alice', keyPair: pod.identity.keyPair, timeout: 4000 })
  return { alice, bob, eve, services, ran, audit, creds }
}

/** A service whose channels pass through `tap(direction, bytes)`: it returns bytes to pass on (maybe changed) or null to drop; it sees everything. */
function hostile(api, tap) {
  const wrap = (ch) => new Proxy(ch, {
    get(target, key) {
      if (key === 'send') return (bytes, opts) => { const out = tap('to-host', bytes); return out === null ? Promise.resolve() : target.send(out, opts) }
      if (key === 'onMessage') return (cb) => target.onMessage((m, ctx) => { const out = tap('to-client', m); return out === null ? undefined : cb(out, ctx) })
      const value = target[key]
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    openProtocol: async (peer, name, opts = {}) => wrap(await api.openProtocol(peer, name, { ...opts, setup: opts.setup && ((ch) => opts.setup(wrap(ch))) })),
  }
}

const contains = (haystack, needle) => Buffer.from(haystack).includes(Buffer.from(needle))

describe('wsh services over a mesh channel', () => {
  it('the real wsh client logs in to a pod over a protocol channel, pins the pod id, and uses its MCP tools and objects under the registry grants', async () => {
    const w = await world()
    const conn = await connectWshServicesOverMesh(w.alice.service, w.bob.podId, w.creds())
    cleanups.push(() => conn.close())
    assert.equal(conn.client.sessionSealed, true)
    await waitFor(() => w.services.sessions.length === 1, 'the session')
    assert.equal(w.services.sessions[0].podId, w.alice.podId)
    assert.ok(w.audit.some((e) => e.event === 'session-open' && e.podId === w.alice.podId))
    const mcp = await conn.client.openRpc('mcp')
    assert.deepEqual((await mcp.request('tools/list', {})).tools.map((t) => t.name), ['echo'])
    assert.equal((await mcp.request('tools/call', { name: 'echo', arguments: { text: 'hi' } })).content[0].text, 'echo hi')
    const { app } = await openObjects(conn.client)
    assert.equal(await app.title, 'inbox')
    await assert.rejects(async () => get(app, 'secret'))
    // nothing else exists on the host
    await assert.rejects(conn.client.openSession({ type: 'exec', command: 'true' }))
    await assert.rejects(conn.client.openRpc('wsh-fs'))
  })

  it('who may open it: protocol:wsh:open through the registry, default deny; revoking it closes the channel', async () => {
    const w = await world({ grants: GRANTS })
    await assert.rejects(connectWshServicesOverMesh(w.alice.service, w.bob.podId, w.creds()), (e) => e.code === -32003)
    await assert.rejects(connectWshServicesOverMesh(w.eve.service, w.bob.podId, w.creds(w.eve)), (e) => e.code === -32003)
    w.bob.registry.grantCapabilities(w.alice.podId, ['protocol:wsh:open'])
    const conn = await connectWshServicesOverMesh(w.alice.service, w.bob.podId, w.creds())
    cleanups.push(() => conn.close())
    await waitFor(() => w.services.sessions.length === 1, 'the session')
    w.bob.registry.revokeCapabilities(w.alice.podId, ['protocol:wsh:open'])
    const mcp = await conn.client.openRpc('mcp').catch(() => null)
    if (mcp) await assert.rejects(mcp.request('tools/list', {}))
    await waitFor(() => w.services.sessions.length === 0, 'the session to end')
  })

  it('the services question is asked as well: a mesh grant without wsh-services:open admits no key, and the key must be the peer\'s own', async () => {
    const w = await world({ grants: ['protocol:wsh:open'] })
    await assert.rejects(connectWshServicesOverMesh(w.alice.service, w.bob.podId, w.creds()))
    assert.ok(w.audit.some((e) => e.event === 'refused' && e.reason === 'no-grant'))
    // Eve's key holds every grant, but alice opens the channel with it: a login for someone else's key.
    w.bob.registry.grantCapabilities(w.eve.podId, GRANTS)
    w.bob.registry.grantCapabilities(w.alice.podId, GRANTS)
    await assert.rejects(connectWshServicesOverMesh(w.alice.service, w.bob.podId, w.creds(w.eve)))
    assert.ok(w.audit.some((e) => e.event === 'refused' && e.reason === 'not-the-channel-peer' && e.podId === w.eve.podId))
    assert.equal(w.services.sessions.length, 0)
  })

  it('the pod id is pinned: the client names it as the host key and cannot be told another, or to trust whoever answers', async () => {
    const w = await world()
    await assert.rejects(connectWshServicesOverMesh(w.alice.service, w.bob.podId, { ...w.creds(), expectHostKey: 'a'.repeat(64) }), TypeError)
    await assert.rejects(connectWshServicesOverMesh(w.alice.service, w.bob.podId, { ...w.creds(), trustOnFirstUse: true }), TypeError)
    await assert.rejects(connectWshServicesOverMesh(w.alice.service, w.bob.podId, { ...w.creds(), allowUnsealed: true }), TypeError)
    // And a pod that answers with another key is refused: a host that is not bob (a service whose key is eve's) behind bob's id.
    const imposter = new WshServices({ identity: w.eve.identity, registry: w.eve.registry, unattended: true, mcp: { allow: [], tools: [] } })
    await imposter.start()
    cleanups.push(() => imposter.stop())
    // alice dials the imposter's service but pins bob's pod id
    const stop = imposter.serveOnMesh(w.eve.service)
    cleanups.push(() => stop())
    w.eve.registry.grantCapabilities(w.alice.podId, ['protocol:wsh:open', 'wsh-services:open'])
    const through = { openProtocol: (peer, name, opts) => w.alice.service.openProtocol(w.eve.podId, name, opts) }
    await assert.rejects(connectWshServicesOverMesh(through, w.bob.podId, w.creds()))
    assert.equal(imposter.sessions.length, 0)
  })

  it('a plain (unsealed) client is served nothing, whatever it was granted', async () => {
    const w = await world()
    const held = []
    let conn = null
    const channel = await w.alice.service.openProtocol(w.bob.podId, 'wsh', { setup: (ch) => { ch.onMessage((m) => { if (conn) conn.receive(m); else held.push(m) }) } })
    const { podIdToFingerprint } = await import('@johnhenry/browsermesh-primitives')
    conn = connectWshOverDuplex({ send: (b) => channel.send(b), close: () => channel.close(), maxMessageBytes: channel.maxMessageBytes }, { ...w.creds(), expectHostKey: podIdToFingerprint(w.bob.podId), allowUnsealed: true, sealSession: false, timeout: 500 })
    for (const m of held.splice(0)) conn.receive(m)
    cleanups.push(() => conn.close())
    await conn.connected.catch(() => {})
    assert.notEqual(conn.client.sessionSealed, true, 'this client really is a plain one')
    // It asks for the channel; the host refuses the plain message (audited), and ending the link ends the attempt.
    const attempt = conn.client.openRpc('mcp').then(() => 'opened', () => 'refused')
    await waitFor(() => w.audit.some((e) => e.event === 'refused' && e.reason === 'not-sealed'), 'the refusal of a plain message')
    await conn.close()
    assert.equal(await attempt, 'refused')
    assert.deepEqual(w.ran, [])
    assert.deepEqual(w.audit.filter((e) => e.event === 'session-open' || e.event === 'session-close'), [], 'a login that was never sealed is not a session')
    assert.equal(w.services.sessions.length, 0)
  })

  it('a hostile hop that reads everything learns the handshake and nothing after login', async () => {
    const w = await world()
    const seen = []
    const conn = await connectWshServicesOverMesh(hostile(w.alice.service, (direction, bytes) => { seen.push(Buffer.from(bytes)); return bytes }), w.bob.podId, w.creds())
    cleanups.push(() => conn.close())
    const mcp = await conn.client.openRpc('mcp')
    assert.equal((await mcp.request('tools/call', { name: 'echo', arguments: { text: SECRET } })).content[0].text, `echo ${SECRET}`)
    const { app } = await openObjects(conn.client)
    assert.equal(await app.title, 'inbox')
    const all = Buffer.concat(seen)
    assert.ok(seen.length > 4)
    assert.equal(contains(all, SECRET), false, 'the tool input is not readable on the channel')
    assert.equal(contains(all, `echo ${SECRET}`), false, 'the result is not readable on the channel')
    assert.equal(contains(all, 'inbox'), false, 'an object value is not readable on the channel')
    assert.equal(contains(all, 'tools/call'), false, 'the method is not readable on the channel')
    assert.equal(contains(all, 'alice'), true, 'the plain handshake is: the user name is visible to a hop (written in the design)')
  })

  it('a hostile hop that alters a byte after login ends the session and nothing altered is delivered', async () => {
    const w = await world()
    let tamper = false
    const conn = await connectWshServicesOverMesh(hostile(w.alice.service, (direction, bytes) => {
      if (!tamper || direction !== 'to-host') return bytes
      const changed = new Uint8Array(bytes)
      changed[changed.length - 1] ^= 0x01
      return changed
    }), w.bob.podId, w.creds())
    cleanups.push(() => conn.close())
    const mcp = await conn.client.openRpc('mcp')
    assert.equal((await mcp.request('tools/call', { name: 'echo', arguments: { text: 'before' } })).content[0].text, 'echo before')
    tamper = true
    const altered = mcp.request('tools/call', { name: 'echo', arguments: { text: 'after' } })
    altered.catch(() => {})
    // The host either ends the session or lets the request stall (wsh does not say which); what it never does is run what was changed.
    await conn.close()
    await assert.rejects(altered)
    assert.deepEqual(w.ran, [{ text: 'before' }], 'the altered request never ran')
    await waitFor(() => w.services.sessions.length === 0, 'the session to end')
  })

  it('a hostile hop that alters what the host sends is not believed either', async () => {
    const w = await world()
    let tamper = false
    const conn = await connectWshServicesOverMesh(hostile(w.alice.service, (direction, bytes) => {
      if (!tamper || direction !== 'to-client') return bytes
      const changed = new Uint8Array(bytes)
      changed[changed.length - 1] ^= 0x01
      return changed
    }), w.bob.podId, w.creds())
    cleanups.push(() => conn.close())
    const mcp = await conn.client.openRpc('mcp')
    tamper = true
    const altered = mcp.request('tools/call', { name: 'echo', arguments: { text: 'x' } })
    altered.catch(() => {})
    await conn.close()
    // Whatever the host ran, the answer that came back altered was not delivered as a result.
    await assert.rejects(altered)
  })

  it('a hostile hop that drops what the client sends stalls the call and runs nothing; closing the channel ends it', async () => {
    const w = await world()
    let drop = false
    const conn = await connectWshServicesOverMesh(hostile(w.alice.service, (direction, bytes) => (drop && direction === 'to-host' ? null : bytes)), w.bob.podId, w.creds())
    cleanups.push(() => conn.close())
    const mcp = await conn.client.openRpc('mcp')
    drop = true
    const pending = mcp.request('tools/call', { name: 'echo', arguments: { text: 'lost' } })
    pending.catch(() => {})
    await conn.close()
    await assert.rejects(pending)
    assert.deepEqual(w.ran, [])
    await waitFor(() => w.services.sessions.length === 0, 'the session to end')
  })

  it('stopping the services ends the sessions on the mesh channel too', async () => {
    const w = await world()
    const conn = await connectWshServicesOverMesh(w.alice.service, w.bob.podId, w.creds())
    cleanups.push(() => conn.close())
    await waitFor(() => w.services.sessions.length === 1, 'the session')
    await w.services.stop()
    await waitFor(() => conn.client.state === 'closed' || conn.client.state === 'disconnected', 'the client to see the end')
    assert.equal(w.services.sessions.length, 0)
  })
})
