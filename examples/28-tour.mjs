/**
 * The tour: the newer browsermesh packages working together in one small app. Guide: examples/TOUR.md.
 *
 *   curl ──HTTP──► ingress ──protocol http──►┌──────────────────────────────┐
 *                                            │ Pod A, "the app"             │
 *   Pod C (stranger) ──wsh link, RESTRICTED─►│  http handler                │
 *     presents a realm credential, promoted, │  objects root `app`          │
 *     cut to the host's realm policy         │  MCP tools (search, buy)     │
 *     ──protocol mcp / objects─────────────► │  PeerRegistry: operator      │
 *                                            │   grants + realm grants      │
 *   Pod B ◄──protocol egress── A reaches     └──────────────────────────────┘
 *     an upstream through B (grants, budget)
 *   meshctl ══sealed wsh via a real pipe relay══► pod host H ──spawn──► a hosted pod
 *
 * Packages: ingress, egress, mcp, objects, meshctl, apps (createMeshNode with `wsh` and `realm`, the PeerRegistry,
 * the protocol seam), realm (published, 0.1.x preview; run from this repository's workspace copy), transport (wsh links), pod.
 * Each leg prints at least one ALLOWED and one REFUSED line, and the script ends with what was recorded.
 *
 * Real: the HTTP request (node:http client to a loopback listener), the ingress, the egress (a loopback server stands
 * in for the upstream), sealed wsh links over wsh's in-process pipe relay, the realm exchange, and `meshctl` run as a
 * child process through a real loopback pipe relay. Not here: tickets, `--signaling`, VMM-backed hosts, discovery.
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import { IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import { ManualStrategy } from '@johnhenry/browsermesh-discovery'
import {
  createMeshNode, createMeshProtocolService, attachService, PeerNode, PeerRegistry, createPodHostService, createWshAuthorizer,
  attachWshLinks, DEFAULT_POD_HOST_RESOURCE,
} from '@johnhenry/browsermesh-apps'
import { InMemoryPodHostDriver, POD_LANE, POD_HOST_VERBS } from '@johnhenry/browsermesh-pod'
import { MeshTransportNegotiator } from '@johnhenry/browsermesh-transport'
import { WshPeerLinks } from '@johnhenry/browsermesh-transport/wsh'
import { createInProcessPipeRelay } from '@johnhenry/browsermesh-transport/wsh-in-process'
import { createPipeRelay } from '@johnhenry/wsh/pipe-relay'
import { createMeshIngress, serveHttpOnMesh } from '@johnhenry/browsermesh-ingress'
import { listenNode } from '@johnhenry/browsermesh-ingress/node'
import { connectEgress, createMeshEgress, EGRESS_SCOPES } from '@johnhenry/browsermesh-egress'
import { nodeDialer } from '@johnhenry/browsermesh-egress/node'
import { serveMcpOnMesh, connectMcpOnMesh, mcpScopes } from '@johnhenry/browsermesh-mcp'
import { exposeObjectsOnMesh, openObjectsOnMesh } from '@johnhenry/browsermesh-objects'
import {
  createDescriptor, signDescriptor, issueCredential, publicKeyOf,
} from '@johnhenry/browsermesh-realm'

const meshctl = fileURLToPath(new URL('../packages/browsermesh-meshctl/bin/meshctl.mjs', import.meta.url))
const RELAY = 'wss://relay.invalid' // never dialled: the in-process relay answers
const nowS = () => Math.floor(Date.now() / 1000)
const cleanups = []
const children = new Set()
const tally = { allowed: 0, refused: 0 }
const say = (verdict, leg, text) => { tally[verdict.toLowerCase()]++; console.log(`${verdict.padEnd(8)} [${leg}] ${text}`) }
const step = (n, text) => console.log(`${n}. ${text}`)
const code = async (promise) => { try { await promise; return null } catch (e) { return e.code ?? e.reason ?? e.message } }
const until = async (fn, what, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 5))) if (await fn()) return
  throw new Error(`timed out waiting for ${what}`)
}

try {
  // ── the pods: real createMeshNode nodes, linked by sealed wsh sessions on an in-process pipe relay ─────────
  const relay = await createInProcessPipeRelay()
  cleanups.push(() => relay.close())
  let seq = 0
  const makeNode = async (label, extra = {}) => {
    const node = await createMeshNode({
      label, signalingTransport: { send() {}, onMessage() {} }, discoveryStrategies: [new ManualStrategy()],
      wsh: { relays: [RELAY], WebSocket: relay.WebSocket, reconnect: { baseMs: 5, maxMs: 25 }, connectTimeoutMs: 3000 },
      syncDbName: `tour-${label}-${++seq}-${Date.now()}`, ...extra,
    })
    cleanups.push(async () => { await node.wsh.links.close(); await node.shutdown(); await node.signaling.close() })
    return node
  }
  const protocolsOf = (node) => node.services.get('mesh-protocols') ?? attachService(node, undefined, createMeshProtocolService())

  // ── 0. the realm the app admits strangers with (realm package, root + one issuer, invite mode) ────
  const ROLE_SCOPES = [
    'mesh:link:connect', 'protocol:mcp:open', 'mcp:search:list', 'mcp:search:call', 'mcp:buy:list', 'mcp:buy:call',
    'protocol:objects:open', 'objects:app:get', 'objects:app:set',
  ]
  const hostOmits = ['mcp:buy:list', 'mcp:buy:call', 'objects:app:set'] // what the descriptor's role lists and Pod A will not honour
  const root = await PodIdentity.generate()
  const issuer = await PodIdentity.generate()
  const genesis = await createDescriptor({
    name: 'tour realm', serial: 1, epoch: 0, mode: 'invite', root: { key: await publicKeyOf(root), chain: [] },
    issuers: [{ key: await publicKeyOf(issuer), notAfter: nowS() + 86400 }], roles: { member: ROLE_SCOPES },
    rendezvous: { signaling: [], relays: [RELAY], ice: [], bootstrap: [] }, ttl: 3600,
  })
  const signed = await signDescriptor(genesis, root)
  const credentialFor = async (subject) => (await issueCredential({
    realm: genesis.id, subject, role: 'member', serial: 1, notBefore: nowS() - 10, notAfter: nowS() + 3600, epoch: 0,
  }, issuer)).text
  const realmEvents = []
  const A = await makeNode('app', { realm: {
    pinnedId: genesis.id, descriptor: signed.text, onEvent: (e) => realmEvents.push(e),
    policy: { [genesis.id]: { roles: { member: ROLE_SCOPES.filter((s) => !hostOmits.includes(s)) } } },
  } })
  const aProtocols = protocolsOf(A)
  const I = await makeNode('ingress')
  const B = await makeNode('egress-provider')
  const iProtocols = protocolsOf(I)
  const bProtocols = protocolsOf(B)
  step(1, `Pod A (the app) admits realm ${genesis.id.slice(0, 10)}... and honours role member minus ${hostOmits.length} scopes; ingress and egress run on their own pods`)

  // The operator links the ingress pod and the egress pod to A and grants them only what each needs.
  A.registry.grantCapabilities(I.podId, ['mesh:link:connect'])
  A.registry.grantCapabilities(B.podId, ['mesh:link:connect'])
  await I.connectToPeer(A.podId, { wsh: A.podId })
  await B.connectToPeer(A.podId, { wsh: A.podId })

  // ── 2. the app: an http handler, an objects root and MCP tools; its egress goes through B ─────────────────
  const upstream = http.createServer((req, res) => { res.end(`upstream price list for ${req.headers.host}`) })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise((resolve) => upstream.close(resolve)))
  const upstreamPort = upstream.address().port

  const egressAudit = []
  const egress = createMeshEgress({
    service: bProtocols, registry: B.registry,
    ...nodeDialer({ lookup: async (name) => { if (name === 'upstream.test') return ['127.0.0.1']; throw Object.assign(new Error('no such name'), { code: 'ENOTFOUND' }) }, allowPrivate: ['127.0.0.1/32'] }),
    unattended: true, limits: { maxConnectionsPerConsumer: 1 }, onAudit: (r) => egressAudit.push(r),
  })
  egress.start()
  cleanups.push(() => egress.stop())
  B.registry.grantCapabilities(A.podId, ['protocol:egress:open', EGRESS_SCOPES.dns('upstream.test'), EGRESS_SCOPES.tcp('upstream.test', upstreamPort)])
  const egressLink = await connectEgress(aProtocols, B.podId)
  cleanups.push(() => egressLink.close())

  const fetchUpstream = async (port) => {
    const socket = await egressLink.connect('upstream.test', port)
    await socket.write(new TextEncoder().encode('GET /price HTTP/1.0\r\nHost: upstream.test\r\n\r\n'))
    await socket.end()
    const parts = []
    for (let chunk = await socket.read(); chunk !== null; chunk = await socket.read()) parts.push(chunk)
    return Buffer.concat(parts).toString().split('\r\n\r\n').pop()
  }
  const appHandler = async (request) => {
    const url = new URL(request.url)
    if (url.pathname === '/upstream') {
      const wanted = Number(url.searchParams.get('port') ?? upstreamPort)
      try { return new Response(await fetchUpstream(wanted)) } catch (e) { return new Response(`egress refused: ${e.code}`, { status: 403 }) }
    }
    if (url.pathname === '/two') { // a second live connection while the first is open: over the consumer's budget
      const first = await egressLink.connect('upstream.test', upstreamPort)
      const second = await code(egressLink.connect('upstream.test', upstreamPort))
      await first.close?.()
      return new Response(`second connection: ${second}`, { status: 429 })
    }
    return new Response('hello from the app')
  }
  const site = serveHttpOnMesh(aProtocols, appHandler, { allowFrom: [I.podId] })
  cleanups.push(() => site.stop())

  const searched = []
  const served = serveMcpOnMesh(aProtocols.api, {
    tools: [
      { name: 'search', description: 'search', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true }, execute: async (i) => { searched.push(i.q); return `found ${i.q}` } },
      { name: 'buy', description: 'spends money', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false }, execute: async () => 'bought' },
    ],
    allow: ['search', 'buy'], approve: 'consequential', prompt: async () => true,
  })
  cleanups.push(() => served.close())
  const app = { title: 'inbox', secret: 'not for the wire', counter: { value: 1 } }
  const objects = exposeObjectsOnMesh(aProtocols, {
    roots: { app }, allow: { get: ['app.title', 'app.counter.**'], set: ['app.counter.value'] },
    watch: A.registry.onAccessChange.bind(A.registry),
  })
  cleanups.push(() => objects.stop())
  step(2, 'Pod A serves an http handler, MCP tools search and buy, and an objects root `app`; Pod B lends A its network')

  // ── 3. ingress: a real HTTP client, a real loopback listener, the ingress pod, Pod A ──────────────────────
  const ingressAudit = []
  const ingress = createMeshIngress({
    service: iProtocols, resolve: () => ({ peer: A.podId }), methods: ['GET', 'POST'], onAudit: (r) => ingressAudit.push(r),
  })
  const listener = await listenNode(ingress, { port: 0 })
  cleanups.push(() => listener.close())
  cleanups.push(() => ingress.close())
  const base = `http://127.0.0.1:${listener.port}`
  const get = (path, init) => new Promise((resolve, reject) => { // a real node:http client
    const req = http.request(base + path, { method: 'GET', ...init }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
  let r = await get('/')
  assert.equal(r.status, 502)
  assert.equal(r.headers['x-browsermesh-ingress-reason'], 'provider-not-authorized')
  say('REFUSED', 'ingress', 'GET / before Pod A grants the ingress pod protocol:http:open: 502 provider-not-authorized')
  A.registry.grantCapabilities(I.podId, ['protocol:http:open']) // the ingress pod is linked already; this is the protocol grant
  r = await get('/')
  assert.deepEqual([r.status, r.body], [200, 'hello from the app'])
  say('ALLOWED', 'ingress', `GET / -> ${r.status} "${r.body}" (HTTP client -> ingress pod -> Pod A over protocol http)`)
  r = await get('/', { method: 'DELETE' })
  assert.equal(r.status, 405)
  say('REFUSED', 'ingress', 'DELETE /: 405, the operator served GET and POST only')

  // ── 4. egress: Pod A fetches an upstream through Pod B, per destination, with a budget ───────────────────
  r = await get('/upstream')
  assert.deepEqual([r.status, r.body], [200, 'upstream price list for upstream.test'])
  say('ALLOWED', 'egress', `GET /upstream -> Pod A dialled upstream.test:${upstreamPort} through Pod B (egress:tcp grant): "${r.body}"`)
  r = await get(`/upstream?port=${upstreamPort + 1}`)
  assert.equal(r.status, 403)
  say('REFUSED', 'egress', `another port of the same host: ${r.body} (nothing dialled)`)
  r = await get('/two')
  assert.equal(r.status, 429)
  assert.match(r.body, /budget-exceeded/)
  say('REFUSED', 'egress', `a second live connection: ${r.body} (maxConnectionsPerConsumer: 1)`)

  // ── 5. the stranger: a realm credential over a restricted wsh link, then MCP and objects as the realm allows ─
  const nobody = await makeNode('nobody', { realm: { pinnedId: genesis.id, descriptor: signed.text, policy: {} } })
  assert.deepEqual(await nobody.realm.present(A.podId, { credential: null }), { ok: false, reason: 'no-credential' })
  assert.equal(A.hasActiveSession(nobody.podId), false)
  say('REFUSED', 'realm', 'a stranger with no credential: held restricted, refused no-credential, never a session')

  const C = await makeNode('stranger', { realm: { pinnedId: genesis.id, descriptor: signed.text, policy: {} } })
  C.realm.setCredential(await credentialFor(C.podId))
  const presented = await C.realm.present(A.podId)
  assert.equal(presented.ok, true, JSON.stringify(presented))
  await until(() => A.hasActiveSession(C.podId), 'promotion of the stranger')
  const granted = realmEvents.find((e) => e.type === 'granted')
  assert.deepEqual(granted.dropped.map((d) => d.scope).sort(), [...hostOmits].sort())
  say('ALLOWED', 'realm', `the stranger's credential names its own key: promoted as ${presented.role}, holding ${granted.granted.length} scopes`)
  say('REFUSED', 'realm', `Pod A's policy dropped ${granted.dropped.map((d) => d.scope).join(', ')}, which the role lists`)
  const thief = await makeNode('thief', { realm: { pinnedId: genesis.id, descriptor: signed.text, policy: {} } })
  const stolen = await thief.realm.present(A.podId, { credential: await credentialFor(C.podId) })
  assert.deepEqual(stolen, { ok: false, reason: 'subject-mismatch' })
  say('REFUSED', 'realm', "the stranger's credential presented from another key: subject-mismatch")

  const cProtocols = protocolsOf(C)
  const mcp = await connectMcpOnMesh(cProtocols.api, A.podId)
  await mcp.initialize()
  assert.deepEqual((await mcp.listTools()).map((t) => t.name), ['search'])
  const found = await mcp.callTool('search', { q: 'cats' })
  assert.equal(found.content[0].text, 'found cats')
  say('ALLOWED', 'mcp', `the realm role lets the stranger see and call search -> "${found.content[0].text}" (labelled untrusted: ${found.untrusted})`)
  assert.equal(await code(mcp.callTool('buy', {})), -32602)
  say('REFUSED', 'mcp', 'buy: dropped by the host policy, so it answers like a tool that does not exist')

  const { roots, channel } = await openObjectsOnMesh(cProtocols, A.podId)
  assert.equal(await roots.app.title, 'inbox')
  say('ALLOWED', 'objects', 'the stranger read app.title (objects:app:get from the realm role)')
  await assert.rejects(async () => roots.app.secret, /not allowed|refused/i)
  say('REFUSED', 'objects', 'app.secret: the allow-list names no such path')
  const { set } = await import('@johnhenry/wsh/objects')
  await assert.rejects(set(roots.app.counter, 'value', 9), /refused|authori/i)
  assert.equal(app.counter.value, 1)
  say('REFUSED', 'objects', 'set app.counter.value: objects:app:set was dropped by the host policy')
  channel.close()

  // ── 6. meshctl: the real binary, a child process, sealed wsh through a real loopback pipe relay ───────────
  const dir = await mkdtemp(join(tmpdir(), 'tour-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const pipe = createPipeRelay()
  const pipeListener = await pipe.listen({ host: '127.0.0.1', port: 0 })
  cleanups.push(() => pipeListener.close())
  cleanups.push(() => pipe.close())
  const PIPE = `ws://127.0.0.1:${pipeListener.port}`
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [meshctl, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    child.on('error', reject)
    child.on('close', (exitCode) => { clearTimeout(timer); children.delete(child); resolve({ code: exitCode, stdout, stderr }) })
  })
  const json = ({ stdout, stderr }) => JSON.parse((stdout || stderr).split('\n').find((line) => line.startsWith('{')))
  const identityOf = async (name) => { const path = join(dir, `${name}.json`); return { path, podId: json(await run(['identity', '--identity', path, '--quiet'])).result.podId } }
  const [operator, outsider] = await Promise.all([identityOf('operator'), identityOf('outsider')])

  const identityManager = new MeshIdentityManager({})
  const wallet = new IdentityWallet({ identityManager })
  const { podId: hostPodId } = await wallet.createIdentity('tour-host')
  const hostRegistry = new PeerRegistry({ localPodId: hostPodId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: hostPodId }) })
  const negotiator = new MeshTransportNegotiator()
  const hostNode = new PeerNode({ wallet, registry: hostRegistry, transportNegotiator: negotiator })
  await hostNode.boot({ skipDiscovery: true })
  const links = new WshPeerLinks({ identity: identityManager.getIdentity(hostPodId), relays: [PIPE], authorize: createWshAuthorizer(hostRegistry), connectTimeoutMs: 3000 })
  attachWshLinks({ node: hostNode, links, negotiator })
  await links.listen()
  cleanups.push(() => links.close())
  cleanups.push(() => hostNode.shutdown())
  const hostSvc = attachService(hostNode, undefined, createPodHostService({ driver: new InMemoryPodHostDriver({ lane: POD_LANE.NODE }), hostLabel: 'tour-host' }))
  cleanups.push(() => hostSvc.teardown())
  hostRegistry.grantCapabilities(operator.podId, ['mesh:link:connect', ...POD_HOST_VERBS.map((verb) => `${DEFAULT_POD_HOST_RESOURCE}:${verb}`)])
  const flags = (who) => ['--wsh-relay', PIPE, '--host', hostPodId, '--identity', who.path, '--timeout', '20000', '--quiet']
  const spawned = await run(['pods', 'spawn', hostPodId, '--name', 'worker', '--lane', 'node', '--kind', 'command', '--ref', '/bin/echo', ...flags(operator)])
  assert.equal(spawned.code, 0, spawned.stderr)
  say('ALLOWED', 'meshctl', `meshctl pods spawn through the relay: pod ${json(spawned).result.pod.name} is ${json(spawned).result.pod.state} on the host (sealed link, key allowed by the host registry)`)
  const refused = await run(['host', 'describe', hostPodId, ...flags(outsider)])
  assert.equal(refused.code, 3)
  assert.equal(json(refused).error.code, 'WSH_REFUSED')
  say('REFUSED', 'meshctl', `meshctl host describe with an identity the host never allowed: ${json(refused).error.code}, exit ${refused.code}, before any verb`)

  // ── the audit: what ingress, egress and the registries recorded ──────────────────────────────────────────
  const count = (list, f) => list.filter(f).length
  await until(() => egress.stats().closed >= 2, 'the egress connections to close')
  const ok = (a) => a.status >= 200 && a.status < 300
  console.log(`audit: ingress ${ingressAudit.length} requests: ${count(ingressAudit, ok)} answered 2xx, ${count(ingressAudit, (a) => !ok(a))} not (statuses ${ingressAudit.map((a) => a.status).join(' ')}); no query string recorded`)
  const closes = egressAudit.filter((a) => a.event === 'egress-close')
  const st = egress.stats()
  console.log(`audit: egress ${st.opened} connection(s) opened, ${st.refused} refused, ${closes.length} closed carrying ${st.bytesUp} bytes up and ${st.bytesDown} down; contents never recorded`)
  const grants = A.registry.listRealmGrants({ realmId: genesis.id })
  console.log(`audit: registry on Pod A holds ${grants.length} realm grant (${grants[0].role}) and dropped ${granted.dropped.length} scopes by policy; realm events: ${[...new Set(realmEvents.map((e) => e.type))].join(', ')}`)
  console.log(`audit: this tour printed ${tally.allowed} ALLOWED and ${tally.refused} REFUSED lines`)
  console.log('ok: one app, six legs, each decided by the pod that owns the resource')
} finally {
  for (const child of children) child.kill('SIGKILL')
  while (cleanups.length) { try { await cleanups.pop()() } catch { /* best effort */ } }
}
process.exit(0)
