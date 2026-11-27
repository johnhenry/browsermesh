/**
 * Realm admission: who may link to a host, and with what, decided by a signed realm and the host's own policy.
 *
 * PREVIEW: `@johnhenry/browsermesh-realm` is PRIVATE and unpublished (design: docs/design/realms.md, link-admission.md).
 * This example runs the real exchange from the branch it is built on, not an API you can install yet.
 *
 * Packages: `-realm` (preview: descriptor, credential, verifier, prover), `-apps` (the real `PeerRegistry` with
 * `setRealmPolicy`, the link-admission seam, `createMeshNode`), `-primitives` (`PodIdentity`), `-core`
 * (`MeshIdentityManager.deriveRealmIdentity`), `-discovery`, `-transport` (the in-process wsh pipe relay: no network).
 *
 *   1. The operator creates an invite realm: a root key, one issuer key and a signed descriptor with a `member` role.
 *   2. The host admits `member` but its allow list omits one `egress:` scope the descriptor's role also lists.
 *   3. A stranger with no credential links: held restricted, then closed at the deadline.
 *   4. The same pod id, after the operator issues it a credential, links again and is promoted; the egress scope is dropped.
 *   5. A credential for another pod id, presented by a thief, is refused.
 *   6. An `open` realm gives an unauthenticated (but proven) peer only the `guest` role.
 *   7. The operator bumps the epoch; the host adopts the new descriptor from a peer; the member's link closes at the next
 *      re-check and its old credential is refused.
 *
 * Not shown: credential renewal, `meshctl`. `createMeshNode({ realm })` (stage 4) now exists; this example uses the lower-level pieces on purpose, to show each step. The host here wires
 * the verifier to the seam by hand, as realm-exchange-wsh.test.mjs does. The subject of a credential is the POD ID the
 * link proved; the member's pod id comes from a per-realm identity derived from a seed.
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { createMeshNode } from '@johnhenry/browsermesh-apps'
import { MeshIdentityManager } from '@johnhenry/browsermesh-core'
import { ManualStrategy } from '@johnhenry/browsermesh-discovery'
import { createInProcessPipeRelay } from '@johnhenry/browsermesh-transport/wsh-in-process'
import { PodIdentity } from '@johnhenry/browsermesh-primitives'
import {
  createDescriptor, signDescriptor, issueCredential, publicKeyOf, createDescriptorStore, createRealmVerifier, createRealmProver,
  MIN_SEAM_FRAME_BYTES,
} from '@johnhenry/browsermesh-realm'

const RELAY = 'wss://relay.invalid' // never dialled: the in-process relay answers
const EGRESS = 'egress:tcp:example.com:443:connect'
const nowS = () => Math.floor(Date.now() / 1000)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, what, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(5) }
  throw new Error(`timed out waiting for ${what}`)
}
const tally = { granted: 0, refused: 0, dropped: 0 }
const say = (verdict, text) => {
  if (verdict === 'ALLOWED') tally.granted++
  else if (verdict === 'REFUSED') tally.refused++
  console.log(`${verdict.padEnd(8)} ${text}`)
}
const step = (n, text) => console.log(`\n[${n}] ✓ ${text}`)

const relay = await createInProcessPipeRelay()
const nodes = []
let nodeSeq = 0
// No node redials: a link the host closes on purpose (a refusal, the deadline, an epoch bump) is not retried. With the default
// redial a refused dialler keeps opening new wsh connections every few ms, so one can be mid-open when teardown closes the
// transport under it, and wsh's pending gateway open then rejects with nobody awaiting it (#457).
async function makeNode(label, extra = {}) {
  const node = await createMeshNode({
    label, signalingTransport: { send() {}, onMessage() {} }, discoveryStrategies: [new ManualStrategy()],
    wsh: { relays: [RELAY], WebSocket: relay.WebSocket, reconnect: { baseMs: 5, maxMs: 25, maxAttempts: 0 }, connectTimeoutMs: 10000 },
    syncDbName: `example-26-${label}-${++nodeSeq}-${Date.now()}`, ...extra,
  })
  nodes.push(node)
  return node
}
async function stop(node) { await node.wsh.links.close(); await node.shutdown(); await node.signaling.close() }

// ── 1. The operator's invite realm ──────────────────────────────────────────
const ROLES = {
  guest: ['mesh:link:connect', 'protocol:mcp:open'],
  member: ['mesh:link:connect', 'protocol:mcp:open', 'mcp:search:call', EGRESS],
}
const rootId = await PodIdentity.generate()
const issuerId = await PodIdentity.generate()
const rootKey = await publicKeyOf(rootId)
const issuers = [{ key: await publicKeyOf(issuerId), notAfter: nowS() + 30 * 86400 }]
const RENDEZVOUS = { signaling: [], relays: [RELAY], ice: [], bootstrap: [] }
const describe = (fields, mode = 'invite', roles = ROLES) => createDescriptor({
  name: 'example realm', serial: 1, epoch: 0, mode, root: { key: rootKey, chain: [] }, issuers, roles, rendezvous: RENDEZVOUS, ttl: 86400, ...fields,
})
const genesis = await describe({})
const realm = { id: genesis.id, v1: await signDescriptor(genesis, rootId) }
const credentialFor = async (subject, epoch = 0, serial = 1) => (await issueCredential({
  realm: realm.id, subject, role: 'member', serial, notBefore: nowS() - 10, notAfter: nowS() + 3600, epoch,
}, issuerId)).text
step(1, `operator made invite realm ${realm.id.slice(0, 12)}… (hash of the genesis root key); role member = ${ROLES.member.length} scopes, incl. ${EGRESS}`)

// ── 2. The host: real registry policy + real admission seam + real verifier ─
const events = []
async function makeHost(descriptorText, policyRoles, { deadlineMs } = {}) {
  let handle
  const store = createDescriptorStore({ pinnedId: realm.id, held: descriptorText })
  await store.ready
  const node = await makeNode('host', {
    admission: { decide: () => 'restrict', handler: (link) => handle(link), onEvent: (e) => events.push(e), maxFrameBytes: MIN_SEAM_FRAME_BYTES, deadlineMs },
  })
  node.registry.setRealmPolicy({ [realm.id]: { roles: policyRoles } })
  handle = createRealmVerifier({ pinnedId: realm.id, store, registry: node.registry, onEvent: (e) => events.push(e) }).handler
  return { node, store }
}
const host = await makeHost(realm.v1.text, { member: ROLES.member.filter((s) => s !== EGRESS), guest: ROLES.guest }, { deadlineMs: 1000 })
step(2, `host admits roles member and guest; its allow list omits ${EGRESS}`)

// A dialler: a node (with the given identity manager/identity, if any) links to the host and runs the prover.
async function dial(label, { credential = null, identity, store, hostRef = host } = {}) {
  const node = await makeNode(label, identity ?? {})
  const pending = []
  let onFrame = null
  node.onIncomingData((from, data) => { if (from === hostRef.node.podId) (onFrame ? onFrame(data) : pending.push(data)) })
  const channel = {
    send: (f) => node.sendTo(hostRef.node.podId, f),
    onFrame: (cb) => { onFrame = cb; while (pending.length) cb(pending.shift()) },
    onClose: () => {},
    close: () => node.wsh.links.disconnect(hostRef.node.podId),
  }
  await node.connectToPeer(hostRef.node.podId, { wsh: hostRef.node.podId })
  const result = await createRealmProver({
    pinnedId: realm.id, store: store ?? createDescriptorStore({ pinnedId: realm.id, held: realm.v1.text }),
    credential: typeof credential === 'function' ? await credential(node.podId) : credential, channel, timeoutMs: 5000,
  })
  return { node, result }
}
const can = (h, peer, scope) => { const i = scope.lastIndexOf(':'); return h.node.registry.checkAccess(peer, scope.slice(0, i), scope.slice(i + 1)).allowed }

// The member's identity: derived per realm from a seed (stable across the two links below).
const wallet = new MeshIdentityManager()
wallet.setSeed(new Uint8Array(32).fill(7))
const memberSummary = await wallet.deriveRealmIdentity(realm.id)
const again = new MeshIdentityManager()
again.setSeed(new Uint8Array(32).fill(7))
assert.equal((await again.deriveRealmIdentity(realm.id)).podId, memberSummary.podId)
const asMember = { identityManager: wallet, identity: { podId: memberSummary.podId } }
console.log(`         member pod id ${memberSummary.podId.slice(0, 12)}…: the same seed and realm id derive it again on a second derivation ✓`)

// ── 3. A stranger with no credential ────────────────────────────────────────
{
  const first = await makeNode('stranger-probe', asMember)
  await first.connectToPeer(host.node.podId, { wsh: host.node.podId }) // links, says nothing
  await until(() => events.some((e) => e.type === 'closed' && e.reason === 'deadline'), 'the deadline close')
  assert.equal(host.node.admission.stats().deadlines, 1)
  assert.equal(can(host, memberSummary.podId, 'protocol:mcp:open'), false)
  say('REFUSED', 'stranger without a credential: held restricted, closed at the 1 s deadline, holds nothing')
  await stop(first)
}
step(3, 'no credential, no access')

// ── 4. The same pod id after the operator issues it a credential ────────────
let member
{
  const r = await dial('member', { credential: (podId) => credentialFor(podId), identity: asMember })
  assert.equal(r.result.ok, true, JSON.stringify(r.result))
  member = r.node
  await until(() => host.node.hasActiveSession(member.podId), 'promotion')
  const granted = events.find((e) => e.type === 'granted')
  for (const s of ['mesh:link:connect', 'protocol:mcp:open', 'mcp:search:call']) assert.equal(can(host, member.podId, s), true, s)
  assert.equal(can(host, member.podId, 'egress:tcp:example.com:443:connect'), false)
  assert.deepEqual(granted.dropped.map((d) => d.scope), [EGRESS])
  tally.dropped += granted.dropped.length
  say('ALLOWED', `stranger with a credential for its pod id: promoted as ${r.result.role}; checkAccess allows ${granted.granted.join(', ')}`)
  console.log(`         dropped by host policy: ${granted.dropped.map((d) => d.scope).join(', ')}  (checkAccess for it: denied)`)
}
step(4, 'a credential for the proven pod id gets the role, cut to the host policy')

// ── 5. A thief presents the member's credential ─────────────────────────────
const memberCredential = await credentialFor(member.podId)
{
  const r = await dial('thief', { credential: memberCredential })
  assert.deepEqual(r.result, { ok: false, reason: 'subject-mismatch' })
  assert.equal(host.node.hasActiveSession(r.node.podId), false)
  say('REFUSED', 'credential for a different pod id (subject-mismatch): the subject must be the key the link proved')
}
step(5, 'a stolen credential is useless on another key')

// ── 6. Open mode: a proven but unauthenticated peer is a guest ──────────────
{
  const openGenesis = await describe({ mode: 'open' })
  const openRealm = await signDescriptor(openGenesis, rootId)
  const saved = { ...realm }
  realm.id = openGenesis.id
  const openHost = await makeHost(openRealm.text, { guest: ROLES.guest })
  const r = await dial('visitor', { credential: null, store: createDescriptorStore({ pinnedId: openGenesis.id, held: openRealm.text }), hostRef: openHost })
  assert.equal(r.result.ok, true, JSON.stringify(r.result))
  assert.equal(r.result.role, 'guest')
  await until(() => openHost.node.hasActiveSession(r.node.podId), 'guest session')
  assert.equal(can(openHost, r.node.podId, 'protocol:mcp:open'), true)
  assert.equal(can(openHost, r.node.podId, 'mcp:search:call'), false)
  say('ALLOWED', 'open-mode guest: no credential, only the guest role (mcp:search:call denied)')
  Object.assign(realm, saved)
}
step(6, 'open realms admit proven peers as guests, nothing more')

// ── 7. Revocation: epoch bump, adopted from a peer ──────────────────────────
{
  const bumped = await signDescriptor(await describe({ serial: 2, epoch: 1 }), rootId)
  const closed = []
  member.on('peer:transport-close', (e) => closed.push(e.pubKey))
  // A second member (credential at the new epoch) carries the new descriptor in when it links.
  const carrier = await dial('carrier', {
    credential: (podId) => credentialFor(podId, 1, 2), store: createDescriptorStore({ pinnedId: realm.id, held: bumped.text }),
  })
  assert.equal(carrier.result.ok, true, JSON.stringify(carrier.result))
  assert.equal(host.store.current().epoch, 1)
  say('ALLOWED', 'a peer holding the epoch-1 descriptor and a credential for it: the host adopted the newer descriptor from it')
  await until(() => closed.includes(host.node.podId), 'the member link to close at the re-check')
  assert.equal(can(host, member.podId, 'mcp:search:call'), false)
  say('REFUSED', 'member link closed at the next re-check after the host adopted epoch 1 from a peer')
  const retry = await dial('member-retry', { credential: memberCredential, identity: asMember })
  assert.equal(retry.result.reason, 'epoch-too-old')
  say('REFUSED', 'old credential after the epoch bump (epoch-too-old)')
}
step(7, 'revocation closes live links and refuses old credentials')

const grantsLeft = host.node.registry.listRealmGrants({ realmId: realm.id }).length
console.log(`\naudit: granted=${tally.granted} refused=${tally.refused} dropped-scopes=${tally.dropped} (live realm grants on the host: ${grantsLeft})`)
// Teardown: nothing initiates work any more (no redial, every dial was awaited). Stop the dialler nodes before the host
// (newest first), awaiting each one's links, shutdown and signaling, then the relay.
for (const n of [...nodes].reverse()) { try { await stop(n) } catch { /* already stopped */ } }
await relay.close()
console.log('ok: invite and open realms, a stranger, a thief and a revocation, each decided at the link')
