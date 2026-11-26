/**
 * The realm exchange end to end: the REAL `PeerRegistry` (with `setRealmPolicy`), the REAL link-admission seam and a real wsh
 * link through the in-process pipe relay. A stranger presents a credential on a restricted link, is promoted, and holds
 * exactly the scopes its role carries and the host's policy admits.
 *
 * `@johnhenry/browsermesh-realm` is a devDependency only: it never imports apps (it takes the registry duck-typed).
 *
 * Run: node --import ./test/_setup-globals.mjs --test test/realm-exchange-wsh.test.mjs
 */
import 'fake-indexeddb/auto'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { createMeshNode } from '../src/mesh-bootstrap.mjs'
import { ManualStrategy } from '@johnhenry/browsermesh-discovery'
import { createInProcessPipeRelay } from '@johnhenry/browsermesh-transport/wsh-in-process'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import {
  createDescriptor, signDescriptor, issueCredential, publicKeyOf, createDescriptorStore, createRealmVerifier, createRealmProver,
  MIN_SEAM_FRAME_BYTES,
} from '@johnhenry/browsermesh-realm'

const RELAY = 'wss://relay.invalid'
const HOUR = 3600
const nowS = () => Math.floor(Date.now() / 1000)

async function waitFor(fn, timeoutMs = 4000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}
const quiet = (ms = 80) => new Promise((r) => setTimeout(r, ms))

const cleanups = []
afterEach(async () => {
  while (cleanups.length) { try { await cleanups.pop()() } catch { /* best effort */ } }
})

let runId = 0
async function makeNode(env, label, extra = {}) {
  const node = await createMeshNode({
    label,
    signalingTransport: { send() {}, onMessage() {} },
    discoveryStrategies: [new ManualStrategy()],
    wsh: { relays: [RELAY], WebSocket: env.WebSocket, reconnect: { baseMs: 5, maxMs: 25 }, connectTimeoutMs: 3000 },
    ...extra,
    syncDbName: `realm-exchange-${label}-${++runId}-${Date.now()}`,
  })
  cleanups.push(async () => { await node.wsh.links.close(); await node.shutdown(); await node.signaling.close() })
  return node
}

/** Roles. `mesh:link:connect` is what the default access watcher re-checks: a role that omits it loses its link at the next re-check. */
const ROLES = {
  guest: ['mesh:link:connect', 'protocol:mcp:open'],
  member: ['mesh:link:connect', 'mcp:search:call', 'objects:window:get', 'protocol:mcp:open'],
  relay: ['mesh:link:connect', 'protocol:mcp:open', 'egress:tcp:connect'],
}
const RENDEZVOUS = { signaling: [], relays: [RELAY], ice: [], bootstrap: [] }

async function makeRealm(over = {}) {
  const root = await PodIdentity.generate()
  const issuer = await PodIdentity.generate()
  const rootKey = await publicKeyOf(root)
  const d = await createDescriptor({
    name: 'it realm', serial: 1, epoch: 0, mode: 'invite', root: { key: rootKey, chain: [] },
    issuers: [{ key: await publicKeyOf(issuer), notAfter: nowS() + 30 * 86400 }], roles: ROLES, rendezvous: RENDEZVOUS, ttl: 86400, ...over,
  })
  const signed = await signDescriptor(d, root)
  /** A later descriptor of the same realm, signed by the root. */
  const sign = async (fields) => signDescriptor(await createDescriptor({
    name: 'it realm', serial: 1, epoch: 0, mode: 'invite', root: { key: rootKey, chain: [] },
    issuers: d.issuers, roles: ROLES, rendezvous: RENDEZVOUS, ttl: 86400, ...fields,
  }), root)
  const credential = async (subject, o = {}) => (await issueCredential({
    realm: d.id, subject, role: 'member', serial: 1, notBefore: nowS() - 10, notAfter: nowS() + HOUR, epoch: d.epoch, ...o,
  }, issuer)).text
  return { id: d.id, descriptor: signed.descriptor, text: signed.text, sign, credential }
}

/** The prover's channel over a dialled mesh node: frames from the host in (buffered until `onFrame`), frames out via `sendTo`. */
function nodeChannel(node, hostId) {
  const pending = []
  let onFrame = null
  let onClose = null
  node.onIncomingData((from, data) => {
    if (from !== hostId) return
    if (onFrame) onFrame(data)
    else pending.push(data)
  })
  node.on('peer:transport-close', (e) => { if (e.pubKey === hostId) onClose?.('peer-closed') })
  return {
    send: (frame) => node.sendTo(hostId, frame),
    onFrame: (cb) => { onFrame = cb; while (pending.length) cb(pending.shift()) },
    onClose: (cb) => { onClose = cb },
    close: () => node.wsh.links.disconnect(hostId),
  }
}

/** A host: a node with link admission whose handler is the realm verifier over the node's own registry. */
async function makeHost(env, realm, { policy, admission = {}, verifier = {} } = {}) {
  const events = []
  let handle = null
  const store = createDescriptorStore({ pinnedId: realm.id, held: realm.text })
  await store.ready
  const bob = await makeNode(env, 'bob', {
    admission: { decide: () => 'restrict', handler: (link) => handle(link), onEvent: (e) => events.push(e), ...admission },
  })
  bob.registry.setRealmPolicy(policy ?? { [realm.id]: { roles: { guest: ROLES.guest, member: ROLES.member } } })
  const v = createRealmVerifier({ pinnedId: realm.id, store, registry: bob.registry, onEvent: (e) => events.push(e), ...verifier })
  handle = v.handler
  return { bob, store, events, verifier: v }
}

async function dial(env, realm, host, { credentialFor, store, timeoutMs = 3000 } = {}) {
  const alice = await makeNode(env, 'alice')
  const channel = nodeChannel(alice, host.bob.podId)
  await alice.connectToPeer(host.bob.podId, { wsh: host.bob.podId })
  const pstore = store ?? createDescriptorStore({ pinnedId: realm.id, held: realm.text })
  const credential = credentialFor === null ? null : await realm.credential(alice.podId, credentialFor)
  const result = await createRealmProver({ pinnedId: realm.id, store: pstore, credential, channel, timeoutMs })
  return { alice, result }
}

const allowed = (host, key, scope) => {
  const i = scope.lastIndexOf(':')
  return host.bob.registry.checkAccess(key, scope.slice(0, i), scope.slice(i + 1)).allowed
}

describe('realm exchange over a real wsh link, the real admission seam and the real PeerRegistry', () => {
  it('a stranger with a valid credential links restricted, presents it, is promoted, and holds exactly the role\'s scopes', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const host = await makeHost(env, realm)
    const { alice, result } = await dial(env, realm, host)

    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.role, 'member')
    await waitFor(() => host.bob.hasActiveSession(alice.podId), 4000, 'promoted link is a session')
    assert.equal(host.bob.admission.stats().promoted, 1)
    assert.equal(host.bob.admission.stats().restricted, 0)

    for (const scope of ROLES.member) assert.equal(allowed(host, alice.podId, scope), true, scope)
    for (const scope of ['mcp:search:delete', 'objects:window:set', 'files:home:read', 'egress:tcp:connect', 'terminal:shell:execute', 'protocol:mcp:close']) {
      assert.equal(allowed(host, alice.podId, scope), false, scope)
    }
    const grants = host.bob.registry.listRealmGrants({ realmId: realm.id })
    assert.equal(grants.length, 1)
    assert.equal(grants[0].peerKey, alice.podId)
    assert.equal(host.events.some((e) => e.type === 'granted' && e.role === 'member'), true)
    // The promoted link stays up through an access change for it: the grant was written BEFORE promote.
    host.bob.registry.grantCapabilities(alice.podId, ['notes:doc:read'])
    await quiet(150)
    assert.equal(host.bob.wsh.links.isConnected(alice.podId), true)
    assert.equal(host.bob.hasActiveSession(alice.podId), true)
  })

  it('a stranger with no credential is closed at the seam\'s deadline and holds nothing', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const host = await makeHost(env, realm, { admission: { deadlineMs: 150 } })
    const alice = await makeNode(env, 'alice')
    const closed = []
    alice.on('peer:transport-close', (e) => closed.push(e.pubKey))
    await alice.connectToPeer(host.bob.podId, { wsh: host.bob.podId })
    await waitFor(() => host.events.some((e) => e.type === 'closed' && e.reason === 'deadline'), 4000, 'deadline event')
    await waitFor(() => closed.includes(host.bob.podId), 4000, 'the stranger\'s link closed')
    assert.equal(host.bob.admission.stats().deadlines, 1)
    assert.equal(host.bob.registry.listRealmGrants().length, 0)
    assert.equal(host.bob.hasActiveSession(alice.podId), false)
    assert.equal(allowed(host, alice.podId, 'protocol:mcp:open'), false)
  })

  it('a stranger that asks for the open-mode guest role in an INVITE realm is refused (no-credential) and closed', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const host = await makeHost(env, realm)
    const { alice, result } = await dial(env, realm, host, { credentialFor: null })
    assert.deepEqual(result, { ok: false, reason: 'no-credential' })
    await waitFor(() => host.events.some((e) => e.type === 'closed' && e.reason === 'no-credential'), 4000, 'closed with the reason')
    assert.equal(host.bob.hasActiveSession(alice.podId), false)
    assert.equal(host.bob.registry.listRealmGrants().length, 0)
  })

  it('open mode: no credential gets exactly the guest scopes', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm({ mode: 'open' })
    const host = await makeHost(env, realm)
    const { alice, result } = await dial(env, realm, host, { credentialFor: null })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.role, 'guest')
    await waitFor(() => host.bob.hasActiveSession(alice.podId))
    for (const scope of ROLES.guest) assert.equal(allowed(host, alice.podId, scope), true, scope)
    assert.equal(allowed(host, alice.podId, 'mcp:search:call'), false)
  })

  it('a credential for another key is refused and the link closed (subject is the key the link proved)', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const host = await makeHost(env, realm)
    const stolen = await makeNode(env, 'owner')
    const alice = await makeNode(env, 'alice')
    const channel = nodeChannel(alice, host.bob.podId)
    await alice.connectToPeer(host.bob.podId, { wsh: host.bob.podId })
    const result = await createRealmProver({
      pinnedId: realm.id, store: createDescriptorStore({ pinnedId: realm.id, held: realm.text }),
      credential: await realm.credential(stolen.podId), channel, timeoutMs: 3000,
    })
    assert.deepEqual(result, { ok: false, reason: 'subject-mismatch' })
    assert.equal(host.bob.registry.listRealmGrants().length, 0)
    assert.equal(host.bob.hasActiveSession(alice.podId), false)
  })

  it('a host policy that omits an egress: role scope drops it, and the dropped scope is reported', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const host = await makeHost(env, realm, {
      policy: { [realm.id]: { roles: { relay: ['mesh:link:connect', 'protocol:mcp:open'] } } },
    })
    const { alice, result } = await dial(env, realm, host, { credentialFor: { role: 'relay' } })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.role, 'relay')
    await waitFor(() => host.bob.hasActiveSession(alice.podId))
    const granted = host.events.find((e) => e.type === 'granted')
    assert.deepEqual(granted.dropped.map((d) => d.scope), ['egress:tcp:connect'])
    assert.deepEqual(granted.granted.sort(), ['mesh:link:connect', 'protocol:mcp:open'])
    assert.equal(allowed(host, alice.podId, 'egress:tcp:connect'), false)
    assert.equal(allowed(host, alice.podId, 'protocol:mcp:open'), true)
  })

  it('a host policy that does not list the role grants nothing: no-grant, never promoted', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const host = await makeHost(env, realm, { policy: { [realm.id]: { roles: { guest: ROLES.guest } } } })
    const { alice, result } = await dial(env, realm, host)
    assert.deepEqual(result, { ok: false, reason: 'no-grant' })
    assert.equal(host.bob.hasActiveSession(alice.podId), false)
    assert.equal(host.bob.admission.stats().promoted, 0)
  })

  it('an epoch bump closes the promoted link at the next re-check, and the old credential no longer works', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const host = await makeHost(env, realm)
    const { alice, result } = await dial(env, realm, host)
    assert.equal(result.ok, true)
    await waitFor(() => host.bob.hasActiveSession(alice.podId))
    const closed = []
    alice.on('peer:transport-close', (e) => closed.push(e.pubKey))

    const bumped = await realm.sign({ serial: 2, epoch: 1 })
    const adopted = await host.store.offer(bumped.text, { linkId: 'operator' })
    assert.equal(adopted.ok, true, JSON.stringify(adopted))
    await waitFor(() => !host.bob.wsh.links.isConnected(alice.podId), 4000, 'the link is closed by the access re-check')
    await waitFor(() => closed.includes(host.bob.podId), 4000, 'the peer sees it close')
    assert.equal(host.bob.registry.listRealmGrants().length, 0)
    assert.equal(allowed(host, alice.podId, 'mcp:search:call'), false)

    // The epoch-0 credential is refused on a new link now.
    const again = await makeNode(env, 'alice2')
    const channel = nodeChannel(again, host.bob.podId)
    await again.connectToPeer(host.bob.podId, { wsh: host.bob.podId })
    const r2 = await createRealmProver({
      pinnedId: realm.id, store: createDescriptorStore({ pinnedId: realm.id, held: realm.text }),
      credential: await realm.credential(again.podId), channel, timeoutMs: 3000,
    })
    assert.equal(r2.ok, false)
    assert.equal(r2.reason, 'epoch-too-old')
  })

  it('a stranger holding a NEWER descriptor and a credential only that descriptor understands: adopted, verified, promoted', async () => {
    const env = await createInProcessPipeRelay()
    cleanups.push(() => env.close())
    const realm = await makeRealm()
    const newer = await realm.sign({ serial: 2, roles: { ...ROLES, editor: ['mesh:link:connect', 'notes:doc:edit'] } })
    const host = await makeHost(env, realm, { policy: { [realm.id]: { roles: { member: ROLES.member, editor: ['mesh:link:connect', 'notes:doc:edit'] } } } })
    const pstore = createDescriptorStore({ pinnedId: realm.id, held: newer.text })
    const { alice, result } = await dial(env, realm, host, { credentialFor: { role: 'editor' }, store: pstore })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(host.store.current().serial, 2)
    await waitFor(() => host.bob.hasActiveSession(alice.podId))
    assert.equal(allowed(host, alice.podId, 'notes:doc:edit'), true)
  })

  it('a descriptor frame bigger than the seam\'s default frame cap needs maxFrameBytes >= MIN_SEAM_FRAME_BYTES', async () => {
    const roles = { ...ROLES }
    for (let i = 0; i < 20; i++) roles[`r${i}`] = Array.from({ length: 64 }, (_, j) => `x${i}:y${j}:z`)
    const realm = await makeRealm()
    const big = await realm.sign({ serial: 2, roles })
    assert.ok(big.text.length > 14000 && big.text.length < 16384, `descriptor is ${big.text.length} bytes`)
    const escaped = JSON.stringify({ t: 'realm:descriptor', text: big.text }).length
    assert.ok(escaped > 16 * 1024, `its frame is ${escaped} bytes, over the default seam cap`)

    // default seam: the descriptor frame is dropped (counted), the prover goes on to its credential, and the host closes the out-of-order link
    const env1 = await createInProcessPipeRelay()
    cleanups.push(() => env1.close())
    const h1 = await makeHost(env1, realm)
    const r1 = await dial(env1, realm, h1, { store: createDescriptorStore({ pinnedId: realm.id, held: big.text }), timeoutMs: 2500 })
    assert.equal(r1.result.ok, false)
    assert.equal(h1.bob.admission.stats().framesDropped >= 1, true)
    assert.equal(h1.store.current().serial, 1, "the dropped descriptor was never adopted")

    // sized for realms: it passes
    const env2 = await createInProcessPipeRelay()
    cleanups.push(() => env2.close())
    const h2 = await makeHost(env2, realm, { admission: { maxFrameBytes: MIN_SEAM_FRAME_BYTES } })
    const r2 = await dial(env2, realm, h2, { store: createDescriptorStore({ pinnedId: realm.id, held: big.text }) })
    assert.equal(r2.result.ok, true, JSON.stringify(r2.result))
    assert.equal(h2.store.current().serial, 2)
  })
})
