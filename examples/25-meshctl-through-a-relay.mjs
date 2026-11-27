/**
 * `meshctl` through a relay: the real `meshctl` command, run as a child process, drives a
 * hosted-pods host it can only reach through a pipe relay, over a sealed, key-authenticated
 * wsh link (`--wsh-relay`). No signalling server and no WebRTC.
 *
 *   - a REAL wsh pipe relay listens on a loopback port (`listen({ port: 0 })`), the one
 *     socket in this example;
 *   - a host pod serves the pod-host service over `InMemoryPodHostDriver` and waits for
 *     links at its rendezvous id on that relay (`WshPeerLinks`);
 *   - `meshctl` is spawned with a temp `--identity` file: `hosts`, `pods spawn`, `status`,
 *     `send` and `drain` each print one JSON document, and the host's registry decides:
 *     the identity is allowed to link (`mesh:link:connect`) and holds the eight verbs;
 *   - a second identity the host has NOT allowed is refused by name: `meshctl` exits 3 and
 *     prints `WSH_REFUSED`, before any pod-host verb is asked; `meshctl hosts` still prints that host's entry with the
 *     error but also exits 3, because every listed host failed.
 *
 * The child is always killed and the listeners are always closed, even on failure.
 * Needs the optional peers `@johnhenry/wsh` and `@johnhenry/browsermesh-transport`.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IdentityWallet, MeshIdentityManager, MeshPeerManager, TrustGraph, MeshACL } from '@johnhenry/browsermesh-core'
import {
  PeerNode, PeerRegistry, attachService, createPodHostService, createWshAuthorizer, attachWshLinks, DEFAULT_POD_HOST_RESOURCE,
} from '@johnhenry/browsermesh-apps'
import { InMemoryPodHostDriver, POD_LANE, POD_HOST_VERBS } from '@johnhenry/browsermesh-pod'
import { MeshTransportNegotiator } from '@johnhenry/browsermesh-transport'
import { WshPeerLinks } from '@johnhenry/browsermesh-transport/wsh'
import { createPipeRelay } from '@johnhenry/wsh/pipe-relay'

const meshctl = fileURLToPath(new URL('../packages/browsermesh-meshctl/bin/meshctl.mjs', import.meta.url))
const cleanups = []
const children = new Set()

/** Run `meshctl` with these arguments; resolves `{ code, stdout, stderr }`. The child is killed if it outlives 15 s. */
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [meshctl, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.add(child)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000)
    child.on('error', reject)
    child.on('close', (code) => { clearTimeout(timer); children.delete(child); resolve({ code, stdout, stderr }) })
  })
}
/** The one JSON document `meshctl` printed: success on stdout, failure on stderr. */
const document = ({ stdout, stderr }) => JSON.parse((stdout || stderr).split('\n').find((line) => line.startsWith('{')))

try {
  const dir = await mkdtemp(join(tmpdir(), 'meshctl-example-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))

  // ── a real pipe relay on loopback ─────────────────────────────────────────
  const relay = createPipeRelay()
  const listener = await relay.listen({ host: '127.0.0.1', port: 0 })
  cleanups.push(() => listener.close())
  cleanups.push(() => relay.close())
  const RELAY = `ws://127.0.0.1:${listener.port}`
  console.log(`1. a real wsh pipe relay is listening on ${RELAY}`)

  // ── two meshctl identities: one the host will allow, one it will not ─────
  const identityOf = async (name) => {
    const path = join(dir, `${name}.json`)
    return { path, podId: document(await run(['identity', '--identity', path, '--quiet'])).result.podId }
  }
  const [operator, stranger] = await Promise.all([identityOf('operator'), identityOf('stranger')])

  // ── the host: a pod that serves the pod-host service and waits at its rendezvous id ──
  const identityManager = new MeshIdentityManager({})
  const wallet = new IdentityWallet({ identityManager })
  const { podId: hostPodId } = await wallet.createIdentity('example-host')
  const registry = new PeerRegistry({ localPodId: hostPodId, peerManager: new MeshPeerManager({}), trustGraph: new TrustGraph(), acl: new MeshACL({ owner: hostPodId }) })
  const negotiator = new MeshTransportNegotiator()
  const node = new PeerNode({ wallet, registry, transportNegotiator: negotiator })
  await node.boot({ skipDiscovery: true })
  const links = new WshPeerLinks({
    identity: identityManager.getIdentity(hostPodId),
    relays: [RELAY],
    authorize: createWshAuthorizer(registry), // who may link: the registry's `mesh:link:connect`, default nobody
    connectTimeoutMs: 3000,
  })
  attachWshLinks({ node, links, negotiator })
  await links.listen()
  cleanups.push(() => links.close())
  cleanups.push(() => node.shutdown())
  const driver = new InMemoryPodHostDriver({ lane: POD_LANE.NODE })
  const handle = attachService(node, undefined, createPodHostService({ driver, hostLabel: 'example-host' }))
  cleanups.push(() => handle.teardown())
  registry.grantCapabilities(operator.podId, ['mesh:link:connect', ...POD_HOST_VERBS.map((verb) => `${DEFAULT_POD_HOST_RESOURCE}:${verb}`)])
  console.log(`2. a host pod serves the pod-host service (lane node) and allowed one meshctl identity (${operator.podId.slice(0, 8)}...) to link and use all verbs`)

  // ── meshctl, the real binary, through the relay ───────────────────────────
  const flags = (identity) => ['--wsh-relay', RELAY, '--host', hostPodId, '--identity', identity.path, '--timeout', '20000', '--quiet']
  const ctl = async (...args) => {
    const result = await run([...args, ...flags(operator)])
    assert.equal(result.code, 0, `meshctl ${args.join(' ')} exited ${result.code}: ${result.stderr}`)
    return document(result).result
  }
  // One command at a time: the host waits at ONE rendezvous id, so concurrent dialers race for it.
  const hosts = await ctl('hosts')
  assert.equal(hosts.length, 1)
  console.log(`3. ALLOWED: meshctl hosts -> ${hosts.length} host, lane ${hosts[0].lane}`)
  const spawned = await ctl('pods', 'spawn', hostPodId, '--name', 'hello', '--lane', 'node', '--kind', 'command', '--ref', '/bin/echo')
  console.log(`   ALLOWED: meshctl pods spawn -> ${spawned.pod.name} (${spawned.pod.lane}), state ${spawned.pod.state}`)
  console.log(`   ALLOWED: meshctl pods status -> ${(await ctl('pods', 'status', hostPodId, 'hello')).state}`)
  const sent = await ctl('pods', 'send', hostPodId, 'hello', '--payload', '{"ping":1}')
  assert.equal(sent.delivered, true)
  console.log(`   ALLOWED: meshctl pods send -> delivered, inbox ${sent.inbox}`)
  console.log(`   ALLOWED: meshctl pods drain -> ${(await ctl('pods', 'drain', hostPodId, 'hello')).state}`)

  // ── an identity the host has not allowed ──────────────────────────────────
  const describeRefused = await run(['host', 'describe', hostPodId, ...flags(stranger)])
  const hostsRefused = await run(['hosts', ...flags(stranger)])
  assert.equal(describeRefused.code, 3)
  assert.equal(document(describeRefused).error.code, 'WSH_REFUSED')
  console.log(`4. REFUSED: an identity the host has not allowed: meshctl host describe exits ${describeRefused.code} with ${document(describeRefused).error.code}, before any verb is asked`)
  const listed = document(hostsRefused).result[0]
  assert.equal(listed.error.code, 'WSH_REFUSED')
  assert.equal(hostsRefused.code, 3)
  console.log(`   REFUSED: meshctl hosts (which lists every host and reports each failure in its entry) shows ${listed.error.code} for it, and exits ${hostsRefused.code} because every listed host failed`)
  assert.equal(links.isConnected(stranger.podId), false)
  console.log('   the host holds no link for it')
  console.log('ok: meshctl drove a host through a real relay over a sealed wsh link, and an identity the host had not allowed was refused')
} finally {
  for (const child of children) child.kill('SIGKILL')
  while (cleanups.length) { try { await cleanups.pop()() } catch { /* best effort */ } }
}
process.exit(0)
