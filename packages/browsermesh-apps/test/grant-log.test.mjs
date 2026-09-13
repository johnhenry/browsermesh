/**
 * Unit-level tests for grant-log.mjs (Phase D of the CloudStorage plan --
 * see /packages/browsermesh-apps/src/grant-log.mjs's module doc comment for
 * the full design rationale).
 *
 * Matches this family's established pattern for this kind of test
 * (test/mesh-relay.test.mjs is the cited precedent): real `PeerRegistry`s
 * wired to real `MeshACL` (`@johnhenry/browsermesh-core`), real Ed25519
 * `IdentityWallet`/`MeshIdentityManager` identities (not mocked -- Phase D's
 * whole point is genuine signature verification), connected via a minimal
 * duck-typed in-memory bus (not real WebRTC), exactly like mesh-relay's own
 * `createNodePair()` but extended with `wallet`/`registry` fields since
 * `attachService()` (`mesh-service.mjs`) reads both off the first `attach()`
 * argument / its own `ctx`.
 *
 * Run:
 *   node --import ./test/_setup-globals.mjs --test test/grant-log.test.mjs
 */

import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { PeerRegistry } from '../src/peer-registry.mjs'
import { attachService } from '../src/mesh-service.mjs'
import { GrantLog, createGrantLogService } from '../src/grant-log.mjs'
import {
  IdentityWallet,
  MeshIdentityManager,
  MeshPeerManager,
  TrustGraph,
  MeshACL,
} from '@johnhenry/browsermesh-core'

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** A real Ed25519 identity + wallet + registry bundle for one "peer". */
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

/**
 * A minimal duck-typed `PeerNode` pair, matching mesh-relay.test.mjs's
 * `createNodePair()` exactly but additionally exposing `.wallet`/`.registry`
 * (which `GrantLog`'s `MeshService.attach()` reads directly off the node,
 * and which `attachService()`'s `ctx` derives `ctx.registry` from).
 */
function wireNodes(peerA, peerB) {
  const listenersA = new Set()
  const listenersB = new Set()

  const nodeA = {
    podId: peerA.podId,
    wallet: peerA.wallet,
    registry: peerA.registry,
    onIncomingData(cb) {
      listenersA.add(cb)
      return () => listenersA.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersB) cb(peerA.podId, data)
      })
    },
  }
  const nodeB = {
    podId: peerB.podId,
    wallet: peerB.wallet,
    registry: peerB.registry,
    onIncomingData(cb) {
      listenersB.add(cb)
      return () => listenersB.delete(cb)
    },
    async sendTo(pubKey, data) {
      queueMicrotask(() => {
        for (const cb of listenersA) cb(peerB.podId, data)
      })
    },
  }
  return { nodeA, nodeB }
}

/** Poll until `fn()` is truthy, or throw after `timeoutMs`. */
async function waitFor(fn, timeoutMs = 1000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${what}`)
}

const RESOURCE = 's3:test-bucket'

// ---------------------------------------------------------------------------
// GrantLog (direct, no MeshService/attachService involved)
// ---------------------------------------------------------------------------

describe('GrantLog (direct)', () => {
  /** @type {any} */ let alice
  /** @type {any} */ let bob

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
  })

  it('admin bootstrap: the creating peer becomes its own admin and can grant scopes', async () => {
    const log = new GrantLog({ resource: RESOURCE, localPodId: alice.podId, wallet: alice.wallet, registry: alice.registry })
    await log.bootstrapAdmin()

    const eff = log.effective()
    assert.deepEqual(eff.admins, [alice.podId])

    await log.grant(bob.podId, ['read', 'write'])
    const after = log.effective()
    assert.deepEqual(new Set(after.grants[bob.podId]), new Set([`${RESOURCE}:read`, `${RESOURCE}:write`]))

    // Replayed into the REAL PeerRegistry, enforceable via checkAccess().
    assert.equal(alice.registry.checkAccess(bob.podId, RESOURCE, 'read').allowed, true)
    assert.equal(alice.registry.checkAccess(bob.podId, RESOURCE, 'write').allowed, true)
    assert.equal(alice.registry.checkAccess(bob.podId, RESOURCE, 'delete').allowed, false)
  })

  it('a non-admin cannot locally construct a grant (rejected before it is even signed)', async () => {
    const log = new GrantLog({ resource: RESOURCE, localPodId: bob.podId, wallet: bob.wallet, registry: bob.registry })
    // Bob never bootstrapped himself as admin.
    await assert.rejects(() => log.grant(alice.podId, 'read'), /not a current admin/)
  })
})

// ---------------------------------------------------------------------------
// Two real peers, propagation via mergeRemote()
// ---------------------------------------------------------------------------

describe('GrantLog: two-peer propagation via mergeRemote()', () => {
  // Alice: creator/admin. Bob: a second peer independently enforcing access
  // to the same resource (e.g. a designated replica), whose own PeerRegistry
  // must learn grants ONLY via the propagated/merged log, never directly
  // from Alice. Carol: the peer being granted/revoked access -- deliberately
  // distinct from both Alice and Bob, since PeerRegistry/MeshACL's
  // checkAccess() has an "owner always allowed" bypass for `pubKey ===
  // <the registry's own localPodId>`, which would make `bob.registry.
  // checkAccess(bob.podId, ...)` vacuously true regardless of any grant and
  // defeat the point of these tests.
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let carol

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    carol = await createPeer('carol')
  })

  it('grant propagates and becomes enforceable via checkAccess() on the second peer after merge', async () => {
    const aliceLog = new GrantLog({ resource: RESOURCE, localPodId: alice.podId, wallet: alice.wallet, registry: alice.registry })
    const bobLog = new GrantLog({ resource: RESOURCE, localPodId: bob.podId, wallet: bob.wallet, registry: bob.registry })

    await aliceLog.bootstrapAdmin()
    await aliceLog.grant(carol.podId, ['read'])

    // Bob's own registry knows nothing yet.
    assert.equal(bob.registry.checkAccess(carol.podId, RESOURCE, 'read').allowed, false)

    // Propagate Alice's log state to Bob.
    await bobLog.mergeRemote(aliceLog.toJSON())

    assert.equal(bob.registry.checkAccess(carol.podId, RESOURCE, 'read').allowed, true)
    assert.deepEqual(bobLog.effective().admins, [alice.podId])
  })

  it('revoke propagates and a subsequent checkAccess() on the second peer denies', async () => {
    const aliceLog = new GrantLog({ resource: RESOURCE, localPodId: alice.podId, wallet: alice.wallet, registry: alice.registry })
    const bobLog = new GrantLog({ resource: RESOURCE, localPodId: bob.podId, wallet: bob.wallet, registry: bob.registry })

    await aliceLog.bootstrapAdmin()
    await aliceLog.grant(carol.podId, ['read'])
    await bobLog.mergeRemote(aliceLog.toJSON())
    assert.equal(bob.registry.checkAccess(carol.podId, RESOURCE, 'read').allowed, true)

    await aliceLog.revoke(carol.podId, ['read'])
    await bobLog.mergeRemote(aliceLog.toJSON())

    assert.equal(bob.registry.checkAccess(carol.podId, RESOURCE, 'read').allowed, false)
  })

  it('a forged record (bad signature) is rejected and never reaches PeerRegistry', async () => {
    const aliceLog = new GrantLog({ resource: RESOURCE, localPodId: alice.podId, wallet: alice.wallet, registry: alice.registry })
    const bobLog = new GrantLog({ resource: RESOURCE, localPodId: bob.podId, wallet: bob.wallet, registry: bob.registry })

    await aliceLog.bootstrapAdmin()
    await aliceLog.grant(carol.podId, ['read'])

    const serialized = aliceLog.toJSON()
    // Tamper with the record's scope after signing -- payload no longer
    // matches what was signed.
    const tampered = {
      elements: serialized.elements.map(({ element, tags }) => {
        const record = JSON.parse(element)
        if (record.pubKey === carol.podId && record.scope === `${RESOURCE}:read`) {
          record.scope = `${RESOURCE}:admin`
        }
        return { element: JSON.stringify(record), tags }
      }),
      tombstones: serialized.tombstones,
    }

    await bobLog.mergeRemote(tampered)

    // The tampered record must not have taken effect anywhere.
    assert.equal(bob.registry.checkAccess(carol.podId, RESOURCE, 'admin').allowed, false)
    assert.deepEqual(bobLog.effective().grants[carol.podId] ?? [], [])
  })

  it('a scope "granted" by a non-admin pubkey is rejected (valid signature, no authority)', async () => {
    // Bob signs a self-authorized grant for himself WITHOUT ever being made
    // admin by Alice. His signature is perfectly valid (he really did sign
    // it) -- but he has no authority, so it must never become effective.
    const bobLog = new GrantLog({ resource: RESOURCE, localPodId: bob.podId, wallet: bob.wallet, registry: bob.registry })

    // Bob can't call grant()/revoke() (guarded locally), so construct the
    // forged-authority record the way an attacker who patched their own
    // client would: bootstrap-shaped but NOT the actual admin scope, so it
    // isn't treated as the resource's bootstrap record either.
    const forged = await bobLog.grant(bob.podId, ['admin']).catch((err) => err)
    assert.ok(forged instanceof Error, 'GrantLog.grant() itself refuses a non-admin caller')

    // Even bypassing the local guard entirely (simulating a malicious peer
    // that doesn't run this code and hand-crafts wire bytes), a directly
    // merged self-authorized non-bootstrap claim must still be rejected by
    // the *authorization* pass on the receiving side.
    const aliceLog = new GrantLog({ resource: RESOURCE, localPodId: alice.podId, wallet: alice.wallet, registry: alice.registry })
    await aliceLog.bootstrapAdmin() // Alice is the real, sole admin.

    // Give Bob's forged attempt a demonstrably LATER `at` than Alice's real
    // bootstrap, so this test unambiguously exercises "a late attacker is
    // rejected" rather than the separate, already-documented "two
    // simultaneous bootstraps race on `at`" edge case.
    await new Promise((r) => setTimeout(r, 5))

    // Bob signs a legitimate (correctly signed) but self-authorized "grant
    // myself admin" record using his own real key/identity.
    const bobActingAsOwnAdmin = new GrantLog({ resource: RESOURCE, localPodId: bob.podId, wallet: bob.wallet, registry: bob.registry })
    // Force it in by reaching past the public API's guard via a second,
    // fresh GrantLog that has never seen Alice's bootstrap -- from ITS
    // perspective adminSet is empty, so bootstrapAdmin() is exactly the
    // record shape a real attacker would submit.
    await bobActingAsOwnAdmin.bootstrapAdmin(bob.podId)

    await aliceLog.mergeRemote(bobActingAsOwnAdmin.toJSON())

    // Alice's log already had a real, earlier-or-equal bootstrap; Bob's
    // self-signed admin claim must not grant him admin on Alice's replay.
    assert.equal(aliceLog.effective().admins.includes(bob.podId), false)
    assert.equal(alice.registry.checkAccess(bob.podId, RESOURCE, 'admin').allowed, false)
  })

  it('concurrent grant+revoke of the same scope: later `at` wins; on an exact tie, revoke wins', async () => {
    const aliceLog = new GrantLog({ resource: RESOURCE, localPodId: alice.podId, wallet: alice.wallet, registry: alice.registry })
    await aliceLog.bootstrapAdmin()

    // Later grant re-authorizes after an earlier revoke.
    await aliceLog.grant(bob.podId, ['read'])
    await new Promise((r) => setTimeout(r, 2))
    await aliceLog.revoke(bob.podId, ['read'])
    await new Promise((r) => setTimeout(r, 2))
    await aliceLog.grant(bob.podId, ['read'])
    assert.equal(alice.registry.checkAccess(bob.podId, RESOURCE, 'read').allowed, true, 'a later grant re-authorizes after a revoke')

    // Exact-timestamp tie: revoke wins over grant, deterministically,
    // regardless of which was constructed/merged first.
    const bobLog = new GrantLog({ resource: RESOURCE, localPodId: bob.podId, wallet: bob.wallet, registry: bob.registry })
    await bobLog.mergeRemote(aliceLog.toJSON())

    const now = Date.now()
    const grantRecord = await aliceLog.grant(bob.podId, ['write']).then(() => aliceLog.toJSON())
    // Manually fabricate a same-`at` revoke record signed by the real
    // admin (Alice) to exercise the tie-break deterministically, since two
    // real calls a few ms apart would not reliably collide on `at`.
    const writeRecord = JSON.parse(grantRecord.elements.at(-1).element)
    const tieAt = writeRecord.at
    // Sign a revoke with the SAME `at` by round-tripping through the
    // grant()/revoke() API isn't possible without controlling Date.now(),
    // so instead assert the documented, implemented tie-break rule directly
    // against the algorithm: construct both records with an identical `at`
    // by hand, sign them with Alice's real key via a second GrantLog call
    // pattern -- simplest correct way is to drive it through the public
    // API twice in the same millisecond when possible, and otherwise assert
    // the general (non-tied) LWW property already covered above. Here we
    // directly validate determinism: merging the same tie-shaped input
    // twice, in either element order, produces the same outcome.
    const revokeUnsigned = { pubKey: bob.podId, scope: `${RESOURCE}:write`, action: 'revoke', at: tieAt, signedBy: alice.podId }
    const payload = new TextEncoder().encode(JSON.stringify(sortKeys(revokeUnsigned)))
    const sig = await alice.wallet.sign(alice.podId, payload)
    const pubKeyBytes = await alice.wallet.getPublicKeyBytes(alice.podId)
    const revokeRecord = {
      ...revokeUnsigned,
      signedByPubKeyBytes: Buffer.from(pubKeyBytes).toString('base64url'),
      signature: Buffer.from(sig).toString('base64url'),
    }

    const orderA = {
      elements: [
        { element: JSON.stringify(writeRecord), tags: ['t1'] },
        { element: JSON.stringify(revokeRecord), tags: ['t2'] },
      ],
      tombstones: [],
    }
    const orderB = {
      elements: [
        { element: JSON.stringify(revokeRecord), tags: ['t2'] },
        { element: JSON.stringify(writeRecord), tags: ['t1'] },
      ],
      tombstones: [],
    }

    const observerA = await createPeer('observer-a')
    const observerB = await createPeer('observer-b')
    // `wallet` here only needs to satisfy verify() (stateless w.r.t. which
    // identities it manages), so reusing alice.wallet is fine -- these
    // observers never locally sign anything, only merge remote records.
    const logA = new GrantLog({ resource: RESOURCE, localPodId: observerA.podId, wallet: alice.wallet, registry: observerA.registry })
    const logB = new GrantLog({ resource: RESOURCE, localPodId: observerB.podId, wallet: alice.wallet, registry: observerB.registry })
    // Both observers first need Alice's admin bootstrap to authorize anything.
    await logA.mergeRemote(aliceLog.toJSON())
    await logB.mergeRemote(aliceLog.toJSON())
    await logA.mergeRemote(orderA)
    await logB.mergeRemote(orderB)

    const scopesA = new Set(logA.effective().grants[bob.podId] ?? [])
    const scopesB = new Set(logB.effective().grants[bob.podId] ?? [])
    assert.equal(scopesA.has(`${RESOURCE}:write`), false, 'revoke wins the exact-timestamp tie regardless of merge order (observer A)')
    assert.equal(scopesB.has(`${RESOURCE}:write`), false, 'revoke wins the exact-timestamp tie regardless of merge order (observer B)')
  })
})

/** Mirrors grant-log.mjs's own canonicalJSON key-sorting for the hand-built tie-break fixture above. */
function sortKeys(obj) {
  const sorted = {}
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k]
  return sorted
}

// ---------------------------------------------------------------------------
// Wired as a MeshService (attachService(), Phase C)
// ---------------------------------------------------------------------------

describe('GrantLog as a MeshService (attachService())', () => {
  // Same rationale as the mergeRemote() suite above for using a third
  // identity (Carol) as the grantee rather than checking a peer's own
  // registry for its own pubKey (which is always allowed via MeshACL's
  // owner bypass, independent of any grant).
  /** @type {any} */ let alice
  /** @type {any} */ let bob
  /** @type {any} */ let carol
  /** @type {any} */ let nodeA
  /** @type {any} */ let nodeB

  beforeEach(async () => {
    alice = await createPeer('alice')
    bob = await createPeer('bob')
    carol = await createPeer('carol')
    ;({ nodeA, nodeB } = wireNodes(alice, bob))
  })

  it('grant propagates end-to-end over the MeshService envelope bus and becomes enforceable on the second peer', async () => {
    let aliceApi
    let bobApi

    attachService(nodeA, undefined, createGrantLogService({ resource: RESOURCE, onReady: (api) => { aliceApi = api } }))
    attachService(nodeB, undefined, createGrantLogService({ resource: RESOURCE, onReady: (api) => { bobApi = api } }))

    await aliceApi.bootstrapAdmin()
    await aliceApi.grant(carol.podId, ['read', 'list'])
    await aliceApi.syncWith(bob.podId)

    await waitFor(() => bob.registry.checkAccess(carol.podId, RESOURCE, 'read').allowed, 1000, 'bob gains read access via synced GrantLog')
    assert.equal(bob.registry.checkAccess(carol.podId, RESOURCE, 'list').allowed, true)
    assert.deepEqual(new Set(bobApi.effective().admins), new Set([alice.podId]))

    // Revoke and re-sync.
    await aliceApi.revoke(carol.podId, ['read'])
    await aliceApi.syncWith(bob.podId)
    await waitFor(() => !bob.registry.checkAccess(carol.podId, RESOURCE, 'read').allowed, 1000, 'bob loses read access after revoke syncs')
    assert.equal(bob.registry.checkAccess(carol.podId, RESOURCE, 'list').allowed, true, 'list is unaffected by revoking read')
  })

  it('a forged envelope payload never reaches the receiving peer\'s PeerRegistry', async () => {
    let aliceApi
    attachService(nodeA, undefined, createGrantLogService({ resource: RESOURCE, onReady: (api) => { aliceApi = api } }))
    attachService(nodeB, undefined, createGrantLogService({ resource: RESOURCE }))

    await aliceApi.bootstrapAdmin()

    // Directly inject a forged envelope on the bus as if a malicious relay
    // had tampered with it in transit: claims Carol is granted admin,
    // signed by "alice" but with garbage signature bytes.
    await nodeA.sendTo(bob.podId, {
      type: 'grant-log',
      resource: RESOURCE,
      orSet: {
        elements: [{
          element: JSON.stringify({
            pubKey: carol.podId,
            scope: `${RESOURCE}:admin`,
            action: 'grant',
            at: Date.now(),
            signedBy: alice.podId,
            signedByPubKeyBytes: Buffer.from(await alice.wallet.getPublicKeyBytes(alice.podId)).toString('base64url'),
            signature: Buffer.from(new Uint8Array(64)).toString('base64url'), // garbage
          }),
          tags: ['forged:0'],
        }],
        tombstones: [],
      },
    })

    await new Promise((r) => setTimeout(r, 20))
    assert.equal(bob.registry.checkAccess(carol.podId, RESOURCE, 'admin').allowed, false)
  })
})
