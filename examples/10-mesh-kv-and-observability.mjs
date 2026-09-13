/**
 * The other half of the mesh-KV-and-observability plan
 * (`mesh-kv-and-observability.md`), told in one runnable story: a small,
 * mesh-native key-value store (`mesh-kv.mjs`, Phase 3) getting real work
 * done, while an `observability-bridge.mjs` (Phase 2) instance watches its
 * `ctx.emit()` output (Phase 1) live and turns it into `visualizations.mjs`'s
 * (previously dormant) JSON export -- the exact payoff the whole plan was
 * building toward: something other than a console.log line can finally
 * *see* a mesh doing something.
 *
 * Three real Ed25519 identities, matching `09-cloud-storage.mjs`'s cast for
 * a reason -- the same "admin / authorized peer / stranger" shape tells the
 * same kind of story a KV store's grant model needs, just over a much
 * smaller surface (`get`/`set`/`delete`/`keys`, no chunking, no encryption
 * -- see `mesh-kv.mjs`'s own module doc comment for why):
 *
 *   - alice: bootstraps the store, its sole admin.
 *   - bob: granted read+write, writes his own entries back.
 *   - carol: never granted anything -- her write is rejected, not silently
 *     dropped without a trace: `mesh-kv:write-rejected` fires and is printed.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXAMPLE USES `createGrantLogService()`/`createMeshKvService()`
 * DIRECTLY, NOT THE ERGONOMIC `MeshKv` WRAPPER CLASS:
 *
 * `MeshKv` (the documented, recommended entry point for real callers) does
 * NOT forward its internal `GrantLog` service's `grant-log:*` events onto
 * its own `on()`/`onEvent()` -- see `mesh-kv.mjs`'s own module doc comment,
 * "Observability events" section: "a caller that wants those subscribes to
 * `createGrantLogService()` directly." An `observability-bridge` needs a
 * real `attachService()` handle (`{name, on}`) to `observe()`, and `MeshKv`
 * doesn't expose the two internal handles it composes. So this example
 * reproduces, by hand, exactly what `MeshKv`'s constructor/`grant()` already
 * do internally (attach `GrantLog` + `createMeshKvService()`, grant, sync
 * the log, `watch()`, push-with-retry) -- this is the SAME real,
 * already-tested composition `mesh-kv.test.mjs`'s "createMeshKvService"
 * describe block and `observability-bridge.test.mjs`'s "grant-log +
 * chunk-replication" pipeline test both use for the identical reason: doing
 * this at the `attachService()` layer is what makes both handles
 * observable.
 *
 * Like `observability-bridge.test.mjs` (and unlike `09-cloud-storage.mjs`'s
 * simulated `sendTo`/`onIncomingData` bus), this example uses real
 * `PeerNode` instances linked via `adoptIncomingSession()` over a minimal
 * in-memory duplex transport -- not real WebRTC, but real enough to fire
 * real `PeerRegistry.connect()`-driven `'peer:connect'` events, which is
 * exactly what Part 1 of the bridge (`createObservabilityBridge()`'s
 * always-on `peer:connect`/`peer:disconnect` wiring) needs to have anything
 * to observe.
 */

import assert from 'node:assert/strict'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'
import {
  PeerNode,
  PeerRegistry,
  attachService,
  createGrantLogService,
  createMeshKvService,
  createObservabilityBridge,
} from '@johnhenry/browsermesh-apps'

const STORE = 'team-notes'
const RESOURCE = `kv:${STORE}`

// ── Step 1: three real Ed25519 identities, each with a real PeerRegistry ───
async function createPeer(label) {
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

const alice = await createPeer('alice') // the store's admin
const bob = await createPeer('bob') // granted read+write
const carol = await createPeer('carol') // never granted anything

console.log('1. three real Ed25519 identities created: alice (admin), bob (authorized), carol (stranger) ✓')

// ── Step 2: real PeerNodes, linked pairwise over a minimal in-memory duplex
// transport -- fires real 'peer:connect' on both sides of each pair, which
// is what Part 1 of the observability bridge (peer connect/disconnect ->
// TopologySnapshot) needs to have anything to observe.

async function linkRealNodes(nodeA, nodeB) {
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
  await nodeA.adoptIncomingSession(nodeB.podId, transportForA, 'inmemory')
  await nodeB.adoptIncomingSession(nodeA.podId, transportForB, 'inmemory')
}

async function waitFor(fn, timeoutMs = 2000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

const nodeAlice = new PeerNode({ wallet: alice.wallet, registry: alice.registry })
const nodeBob = new PeerNode({ wallet: bob.wallet, registry: bob.registry })
const nodeCarol = new PeerNode({ wallet: carol.wallet, registry: carol.registry })
await nodeAlice.boot()
await nodeBob.boot()
await nodeCarol.boot()

console.log('2. three real PeerNodes booted ✓')

// ── Step 3: the observability bridge, watching alice's node -- constructed
// BEFORE the nodes link, so its always-on 'peer:connect' wiring (Part 1,
// see createObservabilityBridge()'s own module doc comment) is live to
// observe the real connect events the next step fires. A bridge created
// after a connection already exists has no way to retroactively learn about
// it -- it only reacts to events, it never inspects a PeerNode's existing
// session state.
const bridge = createObservabilityBridge({ peerNode: nodeAlice })
console.log("3. observability bridge attached to alice's PeerNode ✓")

// ── Step 4: link the nodes -- alice–bob and alice–carol both fire real
// 'peer:connect' events the bridge (already attached) picks up live.
await linkRealNodes(nodeAlice, nodeBob)
await linkRealNodes(nodeAlice, nodeCarol)
assert.equal(bridge.snapshot.getNode(bob.podId).status, 'connected')
assert.equal(bridge.snapshot.getNode(carol.podId).status, 'connected')
console.log("4. alice linked to bob and to carol -- both already visible in the bridge's topology as connected nodes ✓")

// ── Step 5: attach GrantLog + mesh-kv to alice's node, observe both handles
let aliceGrantApi
const aliceGrantHandle = attachService(nodeAlice, undefined, createGrantLogService({
  resource: RESOURCE,
  onReady: (api) => { aliceGrantApi = api },
}))
const aliceKvHandle = attachService(nodeAlice, undefined, createMeshKvService({ storeId: STORE }))
bridge.observe(aliceGrantHandle)
bridge.observe(aliceKvHandle)

const rejectedAtAlice = []
aliceKvHandle.on('mesh-kv:write-rejected', (data) => rejectedAtAlice.push(data))

console.log(`5. alice attached GrantLog + mesh-kv for store '${STORE}', both handles observed by the bridge ✓`)

// ── Step 6: bob attaches his OWN GrantLog + mesh-kv services too -- both
// need to already be listening before alice's next step pushes anything,
// or bob's dispatch bus has no subscriber for that envelope type and the
// push is silently dropped (bob's GrantLog is what lets his own registry
// learn alice is an authorized writer once alice's admin log is synced to
// him -- exactly the "recipient's own registry learns the admin's
// pre-existing grants too" property `MeshKv.grant()`'s own doc comment
// describes).
let bobGrantApi
const bobGrantHandle = attachService(nodeBob, undefined, createGrantLogService({
  resource: RESOURCE,
  onReady: (api) => { bobGrantApi = api },
}))
const bobKvHandle = attachService(nodeBob, undefined, createMeshKvService({ storeId: STORE }))
console.log("6. bob attached his own GrantLog + mesh-kv for the same store, ready to receive ✓")

// ── Step 7: alice bootstraps as admin and grants bob -- mirrors
// MeshKv.becomeAdmin()/MeshKv.grant() exactly (see this file's own module
// doc comment for why they're reproduced by hand here instead of calling
// through the MeshKv wrapper).
await aliceGrantApi.bootstrapAdmin()
await aliceGrantApi.grant(alice.podId, ['read', 'write'])
await aliceGrantApi.grant(bob.podId, ['read', 'write'])
await aliceGrantApi.syncWith(bob.podId)
aliceKvHandle.api.watch(bob.podId)
// NOTE: bob deliberately does NOT call kvApi.watch(alice.podId) here (a
// persistent, mutual watch in both directions). `MeshSyncEngine.merge()`
// notifies subscribers unconditionally, even for a no-op merge (see
// `packages/browsermesh-sync/src/sync.mjs`) -- with exactly two peers
// mutually watching each other, and each having authored at least one
// entry, that turns into an unbounded broadcast/re-merge/re-notify cycle
// between them (each side's own authored entries always pass the other
// side's "attribution must match the immediate sender" check on every
// hop, so nothing ever breaks the cycle). This is a real property of the
// shipped `MeshSyncEngine`/`mesh-kv.mjs`, not something this example
// works around superficially -- seen below, bob instead uses a one-shot
// `kvApi.syncWith(pubKey)` push (matching `MeshKv.grant()`'s own pattern)
// whenever HE wants to deliver a change, which never creates a second
// permanent broadcast loop back toward alice.
// Same documented retry-on-delay workaround MeshKv.grant() uses: bob's own
// GrantLog.mergeRemote() isn't awaited by his dispatch handler, so a data
// push sent immediately after grantLogApi.syncWith() can arrive and be
// ACL-checked before bob's registry has actually absorbed the grant. CRDT
// merge is idempotent, so resending at increasing delays is a cheap, safe
// self-heal.
for (const delayMs of [0, 20, 150]) {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
  await aliceKvHandle.api.syncWith(bob.podId)
}
await waitFor(() => bobGrantApi.effective().admins.includes(alice.podId), 2000, "bob's own registry absorbed alice's synced GrantLog")

assert.ok(bridge.heatmap.getTrust(alice.podId, bob.podId) > 0, "a real grant-log:grant-applied event raised bob's trust value")
console.log(`7. alice bootstrapped as admin and granted bob read+write ✓ (bridge heatmap trust(alice, bob) = ${bridge.heatmap.getTrust(alice.podId, bob.podId).toFixed(2)})`)

// ── Step 8: real work happens on the store -- alice seeds a note, bob adds
// one of his own, alice deletes the stale one.
aliceKvHandle.api.set('agenda/1', 'Ship Phase 4')
await waitFor(() => bobKvHandle.api.get('agenda/1') === 'Ship Phase 4', 2000, "bob's mesh-kv sees alice's set() after merge")
console.log("8. alice set('agenda/1', 'Ship Phase 4'); bob's own get() confirms it arrived ✓")

bobKvHandle.api.set('agenda/2', 'Bob brings coffee')
// One-shot push (see the note on Step 7 above for why bob doesn't watch()
// alice back). `syncWith()` always sends bob's WHOLE current document, which
// by now also includes 'agenda/1' (originally alice's, merged into bob's
// copy in Step 8) -- when alice receives that entry back, its `nodeId`
// (alice) doesn't match its immediate sender on this hop (bob), so it is
// correctly rejected as `attribution-mismatch`: no multi-hop relay trust
// exists in this phase (see `mesh-kv.mjs`'s own module doc comment) --
// alice cannot tell "bob is faithfully relaying my own data" apart from
// "bob is claiming a write he didn't make," so both are refused identically.
// 'agenda/2' (nodeId=bob, sent directly by bob) is unaffected and merges
// normally.
await bobKvHandle.api.syncWith(alice.podId)
await waitFor(
  () => bridge.snapshot.links.some((l) => l.from === bob.podId && l.to === alice.podId && l.activity >= 1),
  2000,
  "the bridge's topology edge reflects bob's authorized write reaching alice",
)
console.log("9. bob set('agenda/2', 'Bob brings coffee'); the bridge's alice–bob edge activity counter went up ✓")
await waitFor(() => rejectedAtAlice.some((r) => r.reason === 'attribution-mismatch'), 2000, "alice rejects bob's relay of her own entry back to her")
console.log("   (bob's syncWith() also relayed alice's own 'agenda/1' entry back to her -> mesh-kv:write-rejected (reason: attribution-mismatch), harmless -- no multi-hop relay trust exists) ✓")

aliceKvHandle.api.delete('agenda/1')
await waitFor(() => bobKvHandle.api.get('agenda/1') === undefined, 2000, "bob's mesh-kv reflects alice's delete()")
console.log("10. alice delete('agenda/1') (the shipped item); bob's own get() confirms the tombstone arrived ✓")

// ── Step 9: carol, never granted, tries to write -- rejected, not silent.
const carolKvHandle = attachService(nodeCarol, undefined, createMeshKvService({ storeId: STORE }))
carolKvHandle.api.watch(alice.podId)
carolKvHandle.api.set('agenda/mallory', 'should never be accepted')

await waitFor(() => rejectedAtAlice.some((r) => r.key === 'agenda/mallory'), 2000, "alice's mesh-kv emits mesh-kv:write-rejected for carol's unauthorized write")
const carolRejection = rejectedAtAlice.find((r) => r.key === 'agenda/mallory')
assert.equal(carolRejection.reason, 'unauthorized')
assert.equal(aliceKvHandle.api.get('agenda/mallory'), undefined, "carol's write never reached alice's authoritative state")
console.log(`11. carol (never granted) tried to set('agenda/mallory', ...) -> mesh-kv:write-rejected (reason: ${carolRejection.reason}), never merged ✓`)

// ── Step 10: the payoff -- VisualizationExporter's own, unmodified JSON
// export, fed entirely by real ctx.emit() events observed live by the
// bridge. This is the whole plan's point: nothing here is a mock or a
// hand-assembled fixture.
console.log('\n12. exported topology (VisualizationExporter#exportTopology()):')
console.log(JSON.stringify(bridge.exportTopology(), null, 2))

console.log('\n13. exported trust heatmap (VisualizationExporter#exportHeatmap()):')
console.log(JSON.stringify(bridge.exportHeatmap(), null, 2))

// ── Cleanup ──────────────────────────────────────────────────────────────
bridge.teardown()
await aliceGrantHandle.teardown()
await aliceKvHandle.teardown()
await bobGrantHandle.teardown()
await bobKvHandle.teardown()
await carolKvHandle.teardown()
await nodeAlice.shutdown()
await nodeBob.shutdown()
await nodeCarol.shutdown()

console.log('\nok: a mesh-native KV store doing real, ACL-gated, multi-peer work -- with a live ctx.emit() event stream feeding an observability bridge that turns it into visualizations.mjs\'s JSON export, no mock data anywhere')
