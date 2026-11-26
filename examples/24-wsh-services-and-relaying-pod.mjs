/**
 * wsh services on a pod, and a relaying pod. Bob's pod serves two things to a
 * STOCK wsh client (the plain `WshClient` from `@johnhenry/wsh`, nothing of
 * browsermesh on the client side): remote objects (`@johnhenry/wsh/objects`) and an
 * MCP tool. Nothing else is on offer (no exec, pty or files).
 *
 *   1. Through a pipe relay. Bob's `WshServices` waits at its own rendezvous id on
 *      a wsh pipe relay (wsh's real one, in this process, so no network). The
 *      client pins bob by his pod id, logs in with a key, the session is sealed,
 *      and the relay copies ciphertext. Bob's PeerRegistry is the only authority:
 *      a key is admitted by `wsh-services:open`, may open the MCP channel with
 *      `protocol:mcp:open` and call a tool with `mcp:echo:call`, and read an
 *      object root with `protocol:objects:open` + `objects:app:get`. A key with
 *      no grant is refused at login.
 *   2. Through a relaying POD. Alice cannot reach the pipe relay, but a third pod,
 *      carol, can carry bytes. `WshRelay` moves the sealed session between alice
 *      and bob over mesh channels and cannot read it. Carol decides per target:
 *      alice needs `protocol:wsh-relay:open` and `wsh-relay:<bob's pod id>:open`.
 *      Without the second grant she is refused, by name, and nothing is dialled.
 *      Bob lists carol in `acceptVia`, and still decides on alice's KEY.
 *
 * Needs the optional peer `@johnhenry/wsh` >= 0.50. The mesh link is a simulated
 * in-process bus, as in example 19. See docs/design/wsh-services-on-a-pod.md and
 * docs/design/wsh-over-mesh.md.
 */
import assert from 'node:assert/strict'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { attachService, createMeshProtocolService, PeerRegistry } from '@johnhenry/browsermesh-apps'
import { WshServices, WshRelay, connectWshServicesViaRelay, servicesRendezvousId, podIdToFingerprint } from '@johnhenry/browsermesh-transport/wsh'
import { createInProcessPipeRelay } from '@johnhenry/browsermesh-transport/wsh-in-process'
import { WshClient, WebSocketTransport } from '@johnhenry/wsh'
import { openObjects } from '@johnhenry/wsh/objects'

const RELAY = 'wss://relay.example' // never dialled: the in-process relay answers
const cleanups = []

// ── a simulated bus of three pods, each with its own PeerRegistry ───────────
async function createPods(count) {
  const nodes = new Map()
  for (let i = 0; i < count; i++) {
    const identity = await PodIdentity.generate()
    const listeners = new Set()
    const node = {
      identity,
      listeners,
      podId: identity.podId,
      onIncomingData(cb) { listeners.add(cb); return () => listeners.delete(cb) },
      async sendTo(to, data) {
        const target = nodes.get(to)
        if (!target) throw new Error('unreachable peer')
        const text = JSON.stringify(data) // a real transport carries JSON text
        queueMicrotask(() => { for (const cb of target.listeners) cb(identity.podId, text) })
      },
    }
    node.registry = new PeerRegistry({ localPodId: node.podId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: node.podId }) })
    node.service = attachService(node, undefined, createMeshProtocolService()).api
    nodes.set(node.podId, node)
  }
  return [...nodes.values()]
}
const [alice, bob, carol] = await createPods(3)
const rejected = async (promise) => { try { await promise; return null } catch (e) { return e } }

try {
  // ── bob serves wsh services: an MCP tool and an object root ───────────────
  const pipe = await createInProcessPipeRelay()
  cleanups.push(() => pipe.close())
  const services = new WshServices({
    identity: bob.identity,
    registry: bob.registry,
    relays: [RELAY],
    WebSocket: pipe.WebSocket,
    unattended: true, // no page, so no indicator to show; a page passes `indicator` instead
    acceptVia: [carol.podId], // the one relaying pod bob lets carry a session for someone else's key
    mcp: { allow: ['echo'], tools: [{ name: 'echo', description: 'echoes', annotations: { readOnlyHint: true }, execute: async (i) => `echo ${i.text ?? ''}` }] },
    objects: { roots: { app: { title: 'inbox', secret: 'no' } }, allow: { get: ['app.title'] } },
    reconnect: { baseMs: 5, maxMs: 25 },
  })
  await services.start()
  cleanups.push(() => services.stop())
  cleanups.push(services.serveOnMesh(bob.service))
  console.log('1. bob serves wsh services (objects + one MCP tool), off by default and started on purpose')

  // ── 1. a stock WshClient through the pipe relay ───────────────────────────
  const rendezvous = await servicesRendezvousId(bob.podId)
  const login = async (who) => {
    const client = new WshClient({ transportFactories: { ws: () => new WebSocketTransport({ WebSocket: pipe.WebSocket }), wt: () => { throw new Error('no') } } })
    cleanups.push(() => client.disconnect().catch(() => {}))
    await client.connect(`${RELAY}/r/${rendezvous}`, { username: 'operator', keyPair: who.identity.keyPair, transport: 'ws', expectHostKey: podIdToFingerprint(bob.podId), sealSession: true, requireChannelBinding: true, timeout: 4000 })
    return client
  }
  assert.ok(await rejected(login(alice)))
  console.log('   REFUSED: a stock client whose key holds no grant is turned away at login (wsh-services:open)')

  bob.registry.grantCapabilities(alice.podId, ['wsh-services:open', 'protocol:mcp:open', 'mcp:echo:list', 'mcp:echo:call', 'protocol:objects:open', 'objects:app:get'])
  const direct = await login(alice)
  const mcp = await direct.openRpc('mcp')
  const echoed = (await mcp.request('tools/call', { name: 'echo', arguments: { text: 'hi' } })).content[0].text
  const { app } = await openObjects(direct)
  assert.equal(await app.title, 'inbox')
  console.log(`   ALLOWED: through the pipe relay the stock client called the MCP tool (${echoed}) and read app.title (${await app.title})`)
  assert.ok(await rejected((async () => app.secret)()))
  console.log('   REFUSED: app.secret, which bob\'s allow-list does not name')
  assert.ok(pipe.recorded.length > 0)
  const seen = (needle) => pipe.recorded.some(({ bytes }) => Buffer.from(bytes).includes(Buffer.from(needle)))
  assert.equal(seen('inbox'), false)
  console.log(`   the relay copied ${pipe.recorded.reduce((n, r) => n + r.bytes.length, 0)} bytes and none of them contain "inbox" or "echo hi" (the session is sealed)`)
  assert.equal(seen('echo hi'), false)
  await direct.disconnect()

  // ── 2. the same through a relaying pod ────────────────────────────────────
  const relayAudit = []
  const relaying = new WshRelay({ registry: carol.registry, service: carol.service, podId: carol.podId, unattended: true, onAudit: (e) => relayAudit.push(e) })
  relaying.start()
  cleanups.push(() => relaying.stop())
  bob.registry.grantCapabilities(carol.podId, ['protocol:wsh:open']) // bob lets carol open his services channel on the mesh
  const creds = { username: 'alice', keyPair: alice.identity.keyPair, timeout: 4000 }

  const noControl = await rejected(connectWshServicesViaRelay(alice.service, carol.podId, bob.podId, creds))
  assert.ok(noControl)
  console.log('2. REFUSED: alice asks carol to relay with no grant at all (the wsh-relay protocol does not even open)')
  carol.registry.grantCapabilities(alice.podId, ['protocol:wsh-relay:open'])
  const noTarget = await rejected(connectWshServicesViaRelay(alice.service, carol.podId, bob.podId, creds))
  assert.equal(noTarget?.reason, 'no-grant')
  console.log(`   REFUSED: the control channel is open but there is no wsh-relay:<bob>:open grant (reason: ${noTarget.reason}); nothing was dialled`)

  carol.registry.grantCapabilities(alice.podId, [`wsh-relay:${bob.podId}:open`])
  const via = await connectWshServicesViaRelay(alice.service, carol.podId, bob.podId, creds)
  cleanups.push(() => via.close())
  assert.equal(via.client.sessionSealed, true)
  const mcp2 = await via.client.openRpc('mcp')
  const echoed2 = (await mcp2.request('tools/call', { name: 'echo', arguments: { text: 'via carol' } })).content[0].text
  const { app: app2 } = await openObjects(via.client)
  assert.equal(await app2.title, 'inbox')
  console.log(`   ALLOWED: with wsh-relay:<bob>:open the same stock client, through carol, called the tool (${echoed2}) and read app.title`)
  assert.ok(relayAudit.some((e) => e.event === 'relay-open' && e.requester === alice.podId && e.target === bob.podId))
  console.log('   carol audited relay-open for alice -> bob; the session is sealed end to end, so she saw ciphertext only')

  carol.registry.revokeCapabilities(alice.podId, [`wsh-relay:${bob.podId}:open`])
  while (relaying.sessions.length > 0) await new Promise((resolve) => setImmediate(resolve))
  console.log('   REFUSED: carol revoked the target grant; the relayed session ended at once')
  console.log('ok: a stock wsh client used a pod\'s objects and MCP tool through a pipe relay and through a relaying pod, each only as granted')
} finally {
  while (cleanups.length) { try { await cleanups.pop()() } catch { /* best effort */ } }
}
process.exit(0)
