/**
 * Two peers converge on the same state after exchanging CRDT sync payloads
 * — no coordinator, no conflict resolution logic in the app, no ordering
 * requirement on when each side applies the other's update.
 *
 * browsermesh-sync's `MeshSyncEngine` wraps CRDTs (the ones defined in
 * browsermesh-primitives: GCounter, LWWMap, PNCounter, ...) with a small
 * create/update/merge/prepareSyncPayload API. Each engine here represents
 * a separate peer's local state; `prepareSyncPayload` is what you'd send
 * over the wire (via browsermesh-transport or a real WebSocket), and
 * `merge` is what the receiving peer applies. This never talks to a real
 * network — the payloads are just handed directly from one engine to the
 * other — but the CRDT merge logic exercised is exactly what production
 * sync does.
 */

import assert from 'node:assert/strict'
import { MeshSyncEngine } from '@johnhenry/browsermesh-sync'

const peerA = new MeshSyncEngine({ nodeId: 'peer-A' })
const peerB = new MeshSyncEngine({ nodeId: 'peer-B' })

// ── A shared counter, updated independently on both sides ───────────

peerA.create('likes', 'g-counter')
peerB.create('likes', 'g-counter')

peerA.update('likes', (c) => c.increment('peer-A', 5))
peerB.update('likes', (c) => c.increment('peer-B', 3))

console.log('before sync — peerA sees:', peerA.getState('likes'), '| peerB sees:', peerB.getState('likes'))
assert.equal(peerA.getState('likes'), 5)
assert.equal(peerB.getState('likes'), 3)

// Exchange payloads in ARBITRARY order — CRDT merges are commutative, so
// it doesn't matter which side applies first.
peerB.merge('likes', peerA.prepareSyncPayload('likes'))
peerA.merge('likes', peerB.prepareSyncPayload('likes'))

console.log('after sync  — peerA sees:', peerA.getState('likes'), '| peerB sees:', peerB.getState('likes'))
assert.equal(peerA.getState('likes'), 8)
assert.equal(peerB.getState('likes'), 8)
console.log('both peers converged on the same total: ✓')

// ── A shared map, edited concurrently on different keys ─────────────

peerA.create('settings', 'lww-map')
peerB.create('settings', 'lww-map')

peerA.update('settings', (m) => m.set('theme', 'dark', 100, 'peer-A'))
peerB.update('settings', (m) => m.set('locale', 'en-US', 200, 'peer-B'))

peerB.merge('settings', peerA.prepareSyncPayload('settings'))
peerA.merge('settings', peerB.prepareSyncPayload('settings'))

const expected = { theme: 'dark', locale: 'en-US' }
assert.deepEqual(peerA.getState('settings'), expected)
assert.deepEqual(peerB.getState('settings'), expected)
console.log('non-conflicting concurrent edits both survived the merge: ✓', peerA.getState('settings'))

peerA.destroy()
peerB.destroy()

console.log('ok: two independent engines converged without any central coordinator')
